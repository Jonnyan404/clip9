// CORS：`ALLOW_ORIGINS` 是否真的把「谁可以跨源读」收窄了（前后端分离部署用）。
//
// ⚠️★ 为什么值得一组用例：
//   · 缺省是 `*`（托管服务的既有行为，改成白名单会让已有部署的浏览器端全部报 CORS）；
//   · 一旦配了白名单，**每一个**响应都得跟着改 —— 而这件事**没有任何东西**会看着：
//     本机同源调试完全不触发 CORS，错到线上才表现成浏览器里一句
//     「blocked by CORS policy」，页面看起来完全正常（数据就是不出现）。
//
// 这里钉五件事：
//   A. 没配 → 与改动前一样是 `*`（含预检）；
//   B. 配了 → 白名单里那个来源拿到**回显**（原样写法）+ `Vary: Origin`；
//   C. 配了 → 不在名单里的来源**一个 CORS 头都拿不到**（含预检）；
//   D. **错误响应**（405 / 404）也要按同一规则改写 —— `errorResponse` 里也铺着 `*`；
//   E. 写歪的条目被丢掉，合法的照旧生效（一条手滑不该把整份白名单关掉）。
import worker from './.build/index.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();

const ALLOWED = 'https://clip.example.com';
const CLIP9 = 'https://clip9.example.org';

/** 带 Origin 发一个请求，只看响应头。 */
async function probe(env, path, { method = 'GET', origin, preflight = false } = {}) {
  const headers = { Authorization: 'Bearer 123' };
  if (origin) {
    headers.Origin = origin;
  }
  if (preflight) {
    headers['Access-Control-Request-Method'] = 'POST';
    headers['Access-Control-Request-Headers'] = 'authorization';
  }
  const res = await worker.fetch(
    new Request(`http://worker.local${path}`, { method, headers }),
    env,
    {},
  );
  // ⚠️ 必须把 body 读掉：不读的话 undici 会报「body 没被消费」（测试里看得见，线上是泄漏）。
  await res.arrayBuffer();
  return {
    status: res.status,
    allowOrigin: res.headers.get('Access-Control-Allow-Origin'),
    vary: res.headers.get('Vary') || '',
  };
}

function envWith(extra) {
  const { env } = makeEnv();
  return { ...env, ...extra };
}

{
  // ── A. 没配：历史行为 ────────────────────────────────────────────────────
  const env = envWith({});
  const plain = await probe(env, '/server', { origin: CLIP9 });
  check('缺省：API 响应是 `*`', plain.allowOrigin, '*');
  check('缺省：不额外加 Vary（响应不随 Origin 变）', plain.vary.includes('Origin'), false);
  const pre = await probe(env, '/server', { origin: CLIP9, preflight: true, method: 'OPTIONS' });
  check('缺省：预检也是 `*`', pre.allowOrigin, '*');

  // ── B. 配了：名单内的来源 ─────────────────────────────────────────────────
  const gate = envWith({ ALLOW_ORIGINS: ALLOWED });
  const ok = await probe(gate, '/server', { origin: ALLOWED });
  check('名单内：回显该来源', ok.allowOrigin, ALLOWED);
  check('名单内：带 Vary: Origin（否则边缘缓存会串）', ok.vary.includes('Origin'), true);
  const okPre = await probe(gate, '/server', { origin: ALLOWED, preflight: true, method: 'OPTIONS' });
  check('名单内：预检放行', okPre.allowOrigin, ALLOWED);
  check('名单内：预检成功', okPre.status, 200);

  // ⚠️ 回显**原样写法**（大小写 / 结尾斜杠都照浏览器发的那样）：
  //    CORS 的匹配是字符串比较，回归一化后的字符串会让某些浏览器判不通过。
  const upper = await probe(gate, '/server', { origin: 'HTTPS://CLIP.EXAMPLE.COM' });
  check('名单内：大小写不同也认（回显原样）', upper.allowOrigin, 'HTTPS://CLIP.EXAMPLE.COM');

  // ── C. 配了：名单外的来源 ─────────────────────────────────────────────────
  for (const origin of [CLIP9, 'https://evil.example', 'http://clip.example.com', 'null']) {
    const bad = await probe(gate, '/server', { origin });
    check(`名单外：${origin} 拿不到放行头`, bad.allowOrigin, null);
  }
  const badPre = await probe(gate, '/server', { origin: CLIP9, preflight: true, method: 'OPTIONS' });
  check('名单外：预检也不给放行头', badPre.allowOrigin, null);

  // ⚠️ 没有 `Origin` 头（同源导航 / curl）：也不需要 CORS 头。
  const noOrigin = await probe(gate, '/server', {});
  check('没有 Origin 的请求不带放行头', noOrigin.allowOrigin, null);

  // ── D. 错误响应也要过同一条规则 ───────────────────────────────────────────
  //    `/revoke/:id` 只收 POST —— GET 会走到 `errorResponse`（那份里也铺着 `*`）。
  const errOk = await probe(gate, '/revoke/1', { origin: ALLOWED });
  check('错误响应：状态是 405', errOk.status, 405);
  check('错误响应：名单内照样回显', errOk.allowOrigin, ALLOWED);
  const errBad = await probe(gate, '/revoke/1', { origin: CLIP9 });
  check('错误响应：名单外照样摘掉', errBad.allowOrigin, null);

  // ── E. 写歪的条目被丢掉，合法的照旧生效 ───────────────────────────────────
  const messy = envWith({ ALLOW_ORIGINS: ` ${ALLOWED}/ , not-an-origin, tauri://localhost ` });
  const afterMess = await probe(messy, '/server', { origin: ALLOWED });
  check('写歪一条不影响合法的那条（含结尾斜杠的写法）', afterMess.allowOrigin, ALLOWED);
  const desktop = await probe(messy, '/server', { origin: 'tauri://localhost' });
  check('`tauri://localhost` 不是 http(s) 来源，Worker 侧不放行', desktop.allowOrigin, null);

  // 一条都不合法 = 没配（保持 `*`）：不能因为手滑把所有人的访问关掉。
  const allBad = envWith({ ALLOW_ORIGINS: 'nope, also-nope' });
  const fallback = await probe(allBad, '/server', { origin: CLIP9 });
  check('全部写歪 = 当没配（仍是 `*`）', fallback.allowOrigin, '*');
}

summary('CORS 白名单（ALLOW_ORIGINS）');
