// `POST /revoke/:id` 与 `POST /revoke/all` —— **只认 POST**（与自建服务端同一条契约）。
//
// ⚠️★ 2026-10-20 加。网页版在那一天把删除统一改成了 **POST**（自建服务端只收 POST：
// 破坏性操作必须是显式 POST，否则浏览器打开 `/revoke/5` 就能删条目），而 Worker 这边
// 原来只注册了 **DELETE** —— 两个后端共用一个前端，于是「改完一边、另一边静默失效」：
// Cloudflare 部署上请求落到兜底，用户只看到「删除失败」。
//
// 这里钉三件事：
//   A. POST 真的能删（网页版现在发的就是它）；
//   B. 其它方法一律 **405 `method_not_allowed`** —— 与 Rust 的 `only_post` 同形
//      （不是让兜底回 404 `route_not_found`：客户端靠码区分「方法不对」与「路由不存在」）；
//   C. 被 405 挡掉之后那条**还在** —— 方法不对绝不能有副作用。
//
// ⚠️ 走**真 router**（`worker.fetch`）而不是直接调处理器：直接调处理器测不出「路由没注册」，
// 而那正是这次要防的东西（与 `content-list.test.mjs` 抬头同一条理由）。
import { TextHandler } from './.build/text.mjs';
import worker from './.build/index.mjs';
import { makeEnv, makeChecker, postJson } from './harness.mjs';

const { check, summary } = makeChecker();

async function fetchJson(env, path, method = 'GET') {
  // ⚠️ 与其它用例一致：`/revoke` 与 `/content` 都过 `ensureRoomAccess`，不带这个头会 401。
  const res = await worker.fetch(
    new Request(`http://worker.local${path}`, { method, headers: { Authorization: 'Bearer 123' } }),
    env,
    {},
  );
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** 发一条文本，回它的 id（字符串，与 `/content` 里的形状一致）。 */
async function seed(env, content) {
  const r = await postJson(TextHandler.create, env, '/text?room=default', content);
  return String(r.json.id);
}

async function remainingIds(env) {
  const r = await fetchJson(env, '/content?room=default');
  return r.json.messages.map((m) => m.id);
}

console.log('\n── A. POST /revoke/:id（网页版现在发的就是它）──');
{
  const { env } = makeEnv();
  const id = await seed(env, '要删的');
  const r = await fetchJson(env, `/revoke/${id}?room=default`, 'POST');
  check('HTTP 200（路由注册了、没落到兜底）', r.status, 200);
  check('那条已经从历史里消失', (await remainingIds(env)).includes(id), false);
}

console.log('\n── B. DELETE 被挡（只认 POST）──');
{
  const { env } = makeEnv();
  const id = await seed(env, '不能被 DELETE 删掉');
  const r = await fetchJson(env, `/revoke/${id}?room=default`, 'DELETE');
  check('HTTP 405', r.status, 405);
  check('code 是 method_not_allowed（不是 route_not_found）', r.json?.code, 'method_not_allowed');
  check('那条还在（405 不能有副作用）', (await remainingIds(env)).includes(id), true);
}

console.log('\n── C. GET 同样被挡（删消息不该是「打开一个链接」就能做到）──');
{
  const { env } = makeEnv();
  const id = await seed(env, '不能被 GET 删掉');
  const r = await fetchJson(env, `/revoke/${id}?room=default`, 'GET');
  check('HTTP 405', r.status, 405);
  check('code 是 method_not_allowed', r.json?.code, 'method_not_allowed');
  check('那条还在', (await remainingIds(env)).includes(id), true);
}

console.log('\n── D. POST /revoke/all 能清空 ──');
{
  const { env } = makeEnv();
  await seed(env, 'a');
  await seed(env, 'b');
  const r = await fetchJson(env, '/revoke/all?room=default', 'POST');
  check('HTTP 200', r.status, 200);
  check('列表清空了', (await remainingIds(env)).length, 0);
}

console.log('\n── E. DELETE /revoke/all 同样被挡 ──');
{
  const { env } = makeEnv();
  await seed(env, 'a');
  const r = await fetchJson(env, '/revoke/all?room=default', 'DELETE');
  check('HTTP 405', r.status, 405);
  check('code 是 method_not_allowed', r.json?.code, 'method_not_allowed');
  check('那条还在', (await remainingIds(env)).length, 1);
}

summary('删除消息只认 POST（其它方法 405，且没有副作用）');
