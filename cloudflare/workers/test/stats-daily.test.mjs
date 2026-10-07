// `GET /stats/daily`（房间活跃度 / 热力图的数据源）。
//
// ⚠️★ 为什么必须单独测：这是**服务端那条接口的 CF 版**，两边各写一份
//（Rust 的 `clip9-core::stats` 与 `handlers/stats.js`）。分位、连续天数、时区回落
// 任何一条漂了，同一个房间在两边的图就不一样 —— 而**不会报错**。
//
// ⚠️ 走**真 router**（`worker.fetch`）而不是直接调处理器：这样能一并钉住
// 「这条路由真的注册了」—— 漏注册的后果是请求落到 SPA 兜底、拿回一份 HTML，
// 而前端只会说一句「读取活跃度失败」。
import { TextHandler } from './.build/text.mjs';
import worker from './.build/index.mjs';
import { bucket, levelsOf, normalizeDays, streakOf, summarize } from './.build/stats.mjs';
import { makeEnv, makeChecker, postJson } from './harness.mjs';

const { check, summary } = makeChecker();

async function fetchJson(env, path, { auth = 'Bearer 123' } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  const res = await worker.fetch(new Request(`http://worker.local${path}`, { headers }), env, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ── ① 路由真的注册了（不是落到 SPA 兜底）──────────────────────────────
{
  const { env } = makeEnv();
  const r = await fetchJson(env, '/stats/daily?days=3');
  check('GET /stats/daily 返回 JSON（不是 SPA 的 HTML）', typeof r.json, 'object');
  check('形状完整', Object.keys(r.json || {}).sort(), ['activity', 'requestedTz', 'room', 'truncated', 'tz']);
}

// ── ② 真发几条 → 今天那格就是几条 ────────────────────────────────────
{
  const { env } = makeEnv();
  for (const t of ['一', '二', '三']) {
    await postJson(TextHandler.create, env, '/text?room=default', t);
  }
  const r = await fetchJson(env, '/stats/daily?days=7&tz=Asia/Shanghai');
  const a = r.json.activity;
  check('days 长度 = 请求的天数', a.days.length, 7);
  check('★ 今天那格 = 发的条数', a.days[a.days.length - 1].count, 3);
  check('total = 3', a.total, 3);
  check('★ 回填了实际用的时区', r.json.tz, 'Asia/Shanghai');
  check('★ 日期是升序（旧的在前面）', a.days.every((d, i) => i === 0 || a.days[i - 1].date < d.date), true);
  check('busiest 是今天', a.busiest, { date: a.days[a.days.length - 1].date, count: 3 });
}

// ── ③ 认不出来的时区回落 UTC，但要说出来 ────────────────────────────
{
  const { env } = makeEnv();
  const r = await fetchJson(env, '/stats/daily?days=3&tz=Not/AZone');
  check('★ 非法时区回落 UTC', r.json.tz, 'UTC');
  check('★ 同时回填了「请求的那个」（前端据此说明）', r.json.requestedTz, 'Not/AZone');
}

// ── ④ days 的夹取：0 / 负数 / 非数 = 「没给」，不是「空图」───────────
{
  check('缺省 = 371（53 周）', normalizeDays(null), 371);
  check('0 = 没给', normalizeDays('0'), 371);
  check('负数 = 没给', normalizeDays('-5'), 371);
  check('非数 = 没给', normalizeDays('abc'), 371);
  check('正常值照用', normalizeDays('90'), 90);
  check('超上限夹住', normalizeDays('99999'), 371);

  const { env } = makeEnv();
  const r = await fetchJson(env, '/stats/daily?days=0');
  check('★ 接口上 days=0 也给 371 天（不是空图）', r.json.activity.days.length, 371);
}

// ── ⑤ 过期文件不算活跃（与自建服务端对齐）────────────────────────────
{
  const { env, db } = makeEnv();
  await postJson(TextHandler.create, env, '/text?room=default', '文本');
  const now = Math.floor(Date.now() / 1000);
  // 一条**已过期**的文件、一条**还没过期**的文件
  db.prepare(
    `INSERT INTO messages (type, room, timestamp, uuid, expireTime, url) VALUES ('file','default',?,?,?,'u')`
  ).run(now, 'a', now - 10);
  db.prepare(
    `INSERT INTO messages (type, room, timestamp, uuid, expireTime, url) VALUES ('file','default',?,?,?,'u')`
  ).run(now, 'b', now + 3600);

  const r = await fetchJson(env, '/stats/daily?days=3');
  check('★ 已过期的文件不算、没过期的算（文本 1 + 未过期文件 1 = 2）', r.json.activity.total, 2);
}

// ── ⑥ 房间隔离：别的房间的活跃不能算进来 ────────────────────────────
{
  const { env } = makeEnv();
  await postJson(TextHandler.create, env, '/text?room=default', 'a');
  await postJson(TextHandler.create, env, '/text?room=other', 'b');
  const r = await fetchJson(env, '/stats/daily?days=3&room=default');
  check('★ 只算这个房间的', r.json.activity.total, 1);
}

// ── ⑦ 纯函数：分位的退化与连续天数的「今天还没发」───────────────────
{
  // 只有一天有 → 四道阈值全取它（不编出假的四分位）
  check('★ 非零天不足 4 天时退化', levelsOf([0, 0, 0, 0, 2, 0]), [2, 2, 2, 2]);
  check('一条都没有 → 全 0', levelsOf([0, 0, 0]), [0, 0, 0, 0]);
  // ⚠️ 分位只用**非零天**：被那一堆 0 拉低的话，每个房间的图都会变成最浅色
  check('★ 分位忽略 0 那些天', levelsOf([0, 0, 0, 0, 0, 4, 4, 4, 4, 4]), [4, 4, 4, 4]);
  check('★ 阈值单调不减', (() => {
    const l = levelsOf([1, 2, 3, 4, 5, 6, 7, 8]);
    return l.every((v, i) => i === 0 || v >= l[i - 1]);
  })(), true);

  // ⚠️ 今天还没发不该把连续天数清零
  check('★ 今天没发时连续天数不清零', streakOf([0, 1, 1, 1, 0]).current, 3);
  check('昨天也没发就断了', streakOf([1, 1, 0, 0]).current, 0);
  check('最长那段与当前那段是两回事', [streakOf([1, 1, 1, 0, 1]).longest, streakOf([1, 1, 1, 0, 1]).current], [3, 1]);
}

// ── ⑧ 时区分桶：同一时刻在东八区可能已经是第二天 ────────────────────
{
  // 2026-10-06 16:30:00Z —— 东八区已经是 10-07 00:30
  const ts = Math.floor(Date.UTC(2026, 9, 6, 16, 30, 0) / 1000);
  const utc = bucket([ts], '2026-10-07', 3, 'UTC');
  const sh = bucket([ts], '2026-10-07', 3, 'Asia/Shanghai');
  check('★ UTC 下算 10-06', utc, [0, 1, 0]);
  check('★ 东八区下算 10-07', sh, [0, 0, 1]);
  // ⚠️ 窗口是「最后一天往前数 days-1 天」：days=2 覆盖 10-06…10-07，
  // 所以上面那个 ts（10-06 16:30Z）**在窗口内**。要验「窗口外丢掉」得再往前拿一天。
  const older = Math.floor(Date.UTC(2026, 9, 4, 12, 0, 0) / 1000);
  check('窗口外的丢掉', bucket([older, ts], '2026-10-07', 2, 'UTC'), [1, 0]);
}

// ── ⑨ summarize 的日期与并列取最近 ──────────────────────────────────
{
  const s = summarize([0, 5, 5, 1], '2026-10-07');
  check('日期对得上（最后一天 = lastDay）', s.days.map((d) => d.date), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  check('并列取最近那天', s.busiest.date, '2026-10-06');
  check('空窗口不崩', [summarize([], '2026-10-07').total, summarize([], '2026-10-07').busiest], [0, null]);
}

summary('stats-daily');
