// 过期文件的后台回收（cron → `scheduled` → `sweepExpiredFiles`）。
//
// ⚠️★ 为什么必须有这条测试：这是 Worker 侧原本**没有**的那一半。
//
// 以前只有请求路径上的惰性清理（有人来 GET 一个已过期的 uuid 才顺手删），
// 于是「再也没人访问的过期文件」永远留在 R2 里（R2 没有对象级 TTL，D1 那行也只有
// 容量裁剪才会动）。而这条链上有**四处静默失效**，一个都不会报错：
//
//   · `wrangler.toml.template` 里那份 `[triggers] crons` 被删掉 → **永远不触发**，
//     部署照样成功、页面照样能用，只是文件永远不消失；
//   · `src/index.js` 忘了导出 `scheduled` → 这个方向会当场报错（还算好），
//     但**反向**（导出留着、配置删了）是完全安静的，所以两半都得有判据；
//   · 判定条件写成 `expireTime < ?`漏了 `expireTime > 0` → **永不过期的文件被清光**；
//   · R2 删失败时照删条目 → 留下界面上完全看不见的**孤儿字节**。
//
// 结论：不许只看「函数被调到了」，要断言**字节没了、条目没了、别人一条没动**。
//
// ⚠️ 直接调 `worker.scheduled`（而不是只调 `sweepExpiredFiles`）：这样一并钉住
// 「cron 那半边真的接到了清理上」—— 只测模块本身的话，接线断了也看不出来。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from './.build/index.mjs';
import { FILE_CLEANUP_BATCH, isFileCleanupEnabled, sweepExpiredFiles } from './.build/file-cleanup.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();
const here = dirname(fileURLToPath(import.meta.url));
const workersDir = join(here, '..');

const nowSecs = () => Math.floor(Date.now() / 1000);

function seedFile(db, { uuid, room = 'default', expireTime, timestamp = nowSecs() - 600 }) {
  const info = db.prepare(
    `INSERT INTO messages (type, name, size, room, timestamp, uuid, expireTime, url)
     VALUES ('file', ?, 3, ?, ?, ?, ?, ?)`
  ).run(`${uuid}.bin`, room, timestamp, uuid, expireTime, `http://x/${uuid}`);
  return Number(info.lastInsertRowid);
}

function seedText(db, { room = 'default', expireTime = null, timestamp = nowSecs() - 600 }) {
  const info = db.prepare(
    `INSERT INTO messages (type, content, room, timestamp, expireTime)
     VALUES ('text', '正文', ?, ?, ?)`
  ).run(room, timestamp, expireTime);
  return Number(info.lastInsertRowid);
}

function seedBlob(r2, uuid, body = 'abc') {
  r2.set(`files/${uuid}`, { body, opts: { customMetadata: { room: 'default' } } });
}

const hasRow = (db, id) => db.prepare('SELECT id FROM messages WHERE id = ?').get(id) !== undefined;
const blobThere = (r2, uuid) => r2.has(`files/${uuid}`);

/** 把广播录下来（真 DO 在测试里是链式桩，录不到东西）。 */
function recordBroadcasts(env) {
  const sent = [];
  env.WEBSOCKET_ROOM = {
    idFromName: (name) => name,
    get: (id) => ({
      async fetch(request) {
        sent.push({ room: id, message: JSON.parse(await request.text()) });
        return new Response('OK');
      },
    }),
  };
  return sent;
}

// ── ① 接线：两半都必须在（配置 + 导出）──────────────────────────────────
check('worker.scheduled 是函数（cron 的那半边接上了）', typeof worker.scheduled, 'function');

{
  const templatePath = join(workersDir, 'wrangler.toml.template');
  const template = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '';
  check('模板里有 [triggers]', /^\s*\[triggers\]\s*$/m.test(template), true);
  const cron = template.match(/^\s*crons\s*=\s*\[([^\]]*)\]/m);
  check('模板里声明了 crons', Boolean(cron), true);
  check('★ 周期是 5 分钟（与自建服务端的 fileCleanup 默认 300s 对齐）', cron?.[1].trim(), '"*/5 * * * *"');
  check(
    '模板里有 FILE_CLEANUP 开关',
    /^\s*FILE_CLEANUP\s*=\s*".*"\s*$/m.test(template),
    true,
  );
  // ⚠️ 反向：只有配置、没有导出的话 wrangler 会报错；只有导出、没有配置的话
  //    是**完全安静**的「永远不触发」—— 所以这一条判据不能省。
  const index = readFileSync(join(workersDir, 'src', 'index.js'), 'utf8');
  check('src/index.js 里定义了 scheduled', /async\s+scheduled\s*\(/.test(index), true);
}

// ── ② 一轮真扫：过期的字节+条目一起没，revoke 广播到条目自己的房间 ──────
{
  const { env, db, r2 } = makeEnv();
  const sent = recordBroadcasts(env);

  const expiredId = seedFile(db, { uuid: 'aaaa', room: 'alpha', expireTime: nowSecs() - 1 });
  seedBlob(r2, 'aaaa');

  await worker.scheduled({ cron: '*/5 * * * *' }, env, {});

  check('★ 过期文件的字节从 R2 删掉了', blobThere(r2, 'aaaa'), false);
  check('★ 过期文件的条目从 D1 删掉了', hasRow(db, expiredId), false);
  check('★ 广播了一条 revoke', sent.length, 1);
  check('  revoke 的形状', sent[0]?.message, { event: 'revoke', data: { id: expiredId } });
  // ⚠️ 广播必须到**条目自己记录的**房间。用「当前房间」的话，跨房间的那批
  //    会把卡片留在界面上不消失（这里 alpha 就是用来抓这个的）。
  check('★ revoke 广播到条目自己那个房间（不是 default）', sent[0]?.room, 'alpha');
}

// ── ③ 只动该动的：未到期 / 永不过期 / 文本 一条都不许碰 ─────────────────
{
  const { env, db, r2 } = makeEnv();
  const now = nowSecs();

  const expired = seedFile(db, { uuid: 'gone', expireTime: now - 1 });
  const live = seedFile(db, { uuid: 'live', expireTime: now + 3600 });
  // ⚠️★ 0 = 永不过期（房间级 `fileExpire: 0` 走的就是这条路）。
  //    漏了 `expireTime > 0` 这条条件的话，这一条会变成「被清光」而**不报错**。
  const never = seedFile(db, { uuid: 'never', expireTime: 0 });
  // 文本行不该被碰。**两条**，因为两条 SQL 条件各有一条判据要钉：
  //   · 第一条 uuid 为 NULL —— 挡住它的是 `uuid IS NOT NULL`；
  //   · 第二条**故意带上 uuid** —— 这时候只有 `type = 'file'` 能挡住它。
  // ⚠️ 只放第一条的话，把 `type = 'file'` 整个删掉测试**照样全绿**（实测过），
  //    也就是条件冗余却不自知。第二条是这两条 SQL 条件各自的「牙」。
  const text = seedText(db, { expireTime: now - 1 });
  const textWithUuid = seedText(db, { expireTime: now - 1 });
  db.prepare('UPDATE messages SET uuid = ? WHERE id = ?').run('t-with-uuid', textWithUuid);
  // 第三条：`type='file'` 但**没有 uuid** 的行 —— 只有 `uuid IS NOT NULL` 挡得住它。
  // ⚠️ 这条钉的是**刻意的窄化**：清理器只回收「认得出、能下载」的文件，
  //    不去顺手删畸形行（那种行点了也没用）。要改这个决定，先改这条判据。
  const malformed = seedFile(db, { uuid: null, expireTime: now - 1 });

  seedBlob(r2, 'gone');
  seedBlob(r2, 'live');
  seedBlob(r2, 'never');

  const report = await sweepExpiredFiles(env, { now });

  check('只查到 1 条过期的', report.expired, 1);
  check('★ 过期的那条没了', hasRow(db, expired), false);
  check('★ 未到期的还在（字节 + 条目）', [hasRow(db, live), blobThere(r2, 'live')], [true, true]);
  check('★ 永不过期的还在（字节 + 条目）', [hasRow(db, never), blobThere(r2, 'never')], [true, true]);
  check('★ 文本行不受影响（uuid 为 NULL 那条）', hasRow(db, text), true);
  check('★ 文本行不受影响（带 uuid 那条 —— 只有 type 条件挡得住）', hasRow(db, textWithUuid), true);
  check('★ 认不出来的文件行不动（type=file 但没有 uuid）', hasRow(db, malformed), true);
  check('  总共只少了 1 行', db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 5);
}

// ── ④ 边界：正好等于「现在」不算过期（与读取路径同一条判据）────────────
{
  const { env, db, r2 } = makeEnv();
  const now = 1_800_000_000;
  const id = seedFile(db, { uuid: 'edge', expireTime: now, timestamp: now - 100 });
  seedBlob(r2, 'edge');

  const report = await sweepExpiredFiles(env, { now });
  // 读取路径是 `currentTime > expireTime`（handler/file.js）—— 这一秒还没过期。
  check('expireTime === now 不算过期', [report.expired, hasRow(db, id)], [0, true]);
}

// ── ⑤ 开关：<= 0 不跑；值写坏了照跑（方向不对称，往安全那边倒）──────────
{
  check('缺省 = 跑', isFileCleanupEnabled({}), true);
  check('300 = 跑', isFileCleanupEnabled({ FILE_CLEANUP: '300' }), true);
  check('0 = 不跑', isFileCleanupEnabled({ FILE_CLEANUP: '0' }), false);
  check('-1 = 不跑', isFileCleanupEnabled({ FILE_CLEANUP: '-1' }), false);
  check('★ 写坏了（NaN）也照跑 —— 静默停掉清理的方向更危险', isFileCleanupEnabled({ FILE_CLEANUP: 'abc' }), true);

  const { env, db, r2 } = makeEnv();
  env.FILE_CLEANUP = '0';
  const id = seedFile(db, { uuid: 'off', expireTime: nowSecs() - 1 });
  seedBlob(r2, 'off');

  const report = await sweepExpiredFiles(env);
  check('★ 开关关掉时一条都不动', [report.expired, hasRow(db, id), blobThere(r2, 'off')], [0, true, true]);
}

// ── ⑥ ★ R2 删失败时**不删条目**（否则留下看不见的孤儿字节）────────────
{
  const { env, db } = makeEnv();
  env.R2_BUCKET = { delete: async () => { throw new Error('R2 挂了'); } };
  const id = seedFile(db, { uuid: 'boom', expireTime: nowSecs() - 1 });

  const report = await sweepExpiredFiles(env);
  check('R2 失败 → 记一笔失败', [report.expired, report.failed], [1, 1]);
  // ⚠️★ 这条是顺序判据：先删字节再删条目。反过来的话这里会是 false，
  //    而线上表现是「条目没了、字节还在」—— 界面上完全看不到，只能看账单。
  check('★ 条目被保留（下一轮还会再试）', hasRow(db, id), true);

  // 幂等：R2 恢复之后，同一个条目下一轮能正常收掉。
  const { env: env2, db: db2, r2: r22 } = makeEnv();
  const id2 = seedFile(db2, { uuid: 'retry', expireTime: nowSecs() - 1 });
  seedBlob(r22, 'retry');
  await sweepExpiredFiles(env2);
  check('★ 下一轮能收掉（幂等、可重试）', [hasRow(db2, id2), blobThere(r22, 'retry')], [false, false]);
}

// ── ⑦ 一轮有预算上限：超出的留到下一轮（不是漏掉，也不是一次全扫）──────
{
  const { env, db, r2 } = makeEnv();
  for (let i = 0; i < 5; i += 1) {
    seedFile(db, { uuid: `u${i}`, expireTime: nowSecs() - 10 + i, timestamp: nowSecs() - 600 + i });
    seedBlob(r2, `u${i}`);
  }

  const first = await sweepExpiredFiles(env, { limit: 3 });
  check('第一轮只处理 3 条（预算）', [first.expired, first.entries], [3, 3]);
  check('  剩下 2 行还在', db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 2);

  const second = await sweepExpiredFiles(env, { limit: 3 });
  check('★ 第二轮把剩下的收干净（不会漏）', [second.expired, second.entries], [2, 2]);
  check('  一条不剩', db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
  check('缺省上限是 40（子请求 43≤50 与 cron CPU 10ms 双预算倒推）', FILE_CLEANUP_BATCH, 40);
}

// ── ⑨ ★ 日志条数**不随条数增长**（Cloudflare 的 console.log 计 CPU）────────
{
  const countLogs = async (rowCount) => {
    const { env, db, r2 } = makeEnv();
    recordBroadcasts(env);
    for (let i = 0; i < rowCount; i += 1) {
      seedFile(db, { uuid: `log${i}`, expireTime: nowSecs() - 1 });
      seedBlob(r2, `log${i}`);
    }
    const realLog = console.log;
    let lines = 0;
    console.log = () => { lines += 1; };
    try {
      await sweepExpiredFiles(env);
    } finally {
      console.log = realLog;
    }
    return lines;
  };

  const one = await countLogs(1);
  const five = await countLogs(5);
  // ⚠️★ 这条不是风格问题，是 **CPU 预算**问题：`broadcastMessage` 每调一次打一行
  //    `Broadcast message to room: …`，满批 40 条就是 40 行。实测同样 40 条：
  //    **带日志 ≈ 6.8ms/轮、不带 ≈ 1.2ms/轮**，而免费档 cron 的 CPU 上限只有 **10ms**
  //    —— 那 5.5ms 的差就是这 40 行的账。去掉 `quiet: true` 会让这条红。
  check('★ 一轮回收不打逐条日志（1 条与 5 条都不打）', [one, five], [0, 0]);
}

// ── ⑩ 出错不能把任务打死（下一轮还会跑）────────────────────────────────
{
  const { env } = makeEnv();
  env.DB = { prepare() { throw new Error('D1 挂了'); } };
  const report = await sweepExpiredFiles(env);
  check('查询失败时安静返回，不抛', report, { expired: 0, entries: 0, failed: 0 });
  // 并且经 scheduled 这条路也不该把 cron 调用打红。
  await worker.scheduled({}, env, {});
}

summary('过期文件的后台回收 ✅');
