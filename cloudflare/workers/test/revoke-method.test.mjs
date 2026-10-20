// `POST /revoke/:id` 与 `POST /revoke/all`（以及仍然保留的 DELETE）。
//
// ⚠️★ 2026-10-20 加。网页版在那一天把删除统一改成了 **POST** —— 自建服务端（Rust）
// 只接受 POST（`post(handlers::revoke).fallback(only_post)`），而 Worker 这边原来只注册了
// **DELETE**。两个后端共用一个前端，于是「改完一边、另一边静默失效」：
// Cloudflare 部署上请求会落到 SPA 兜底、拿回一份 HTML，用户只看到「删除失败」。
//
// 所以这里同时钉三件事：
//   A. POST 真的能删（网页版现在发的是它）；
//   B. DELETE 仍然能删（老 SPA 可能还被 Service Worker 缓存着）；
//   C. GET 不许删（破坏性操作不该是「打开一个链接」就能做到）。
//
// ⚠️ 走**真 router**（`worker.fetch`）而不是直接调处理器 —— 直接调处理器测不出「路由没注册」，
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
  check('HTTP 200（路由注册了、没落到 SPA 兜底）', r.status, 200);
  check('那条已经从历史里消失', (await remainingIds(env)).includes(id), false);
}

console.log('\n── B. DELETE 仍然可用（老的、被 SW 缓存的 SPA）──');
{
  const { env } = makeEnv();
  const id = await seed(env, '要删的');
  const r = await fetchJson(env, `/revoke/${id}?room=default`, 'DELETE');
  check('HTTP 200', r.status, 200);
  check('那条已经从历史里消失', (await remainingIds(env)).includes(id), false);
}

console.log('\n── C. GET 不许删（浏览器打开一个链接就能删是洞）──');
{
  const { env } = makeEnv();
  const id = await seed(env, '不能靠 GET 删掉');
  await fetchJson(env, `/revoke/${id}?room=default`, 'GET');
  check('那条还在', (await remainingIds(env)).includes(id), true);
}

console.log('\n── D. POST /revoke/all ──');
{
  const { env } = makeEnv();
  await seed(env, 'a');
  await seed(env, 'b');
  const r = await fetchJson(env, '/revoke/all?room=default', 'POST');
  check('HTTP 200', r.status, 200);
  check('列表清空了', (await remainingIds(env)).length, 0);
}

summary('删除消息的 HTTP 方法（POST / DELETE 都认，GET 不行）');
