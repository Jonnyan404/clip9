// CORS —— Worker 侧的「谁可以跨源读这个 API」。
//
// ⚠️★ 与自建服务端（Rust）的模型不同，理由也不同：
//
//   · Rust 那个跑在**用户自己的机器**上，房间默认不要密码 —— 所以必须是**收窄**的白名单，
//     否则用户随手点开的任意网页都能把本机剪贴板历史读走（见 `server/src/cors.rs`）。
//   · 这里是**托管服务**（Cloudflare 上、有一个公开域名），房间名 + 密码才是真的凭据。
//     历史行为是 `*`，改成白名单会让**已有部署**的浏览器端全部报 CORS ——
//     所以缺省**保持 `*`**，只是给「我有自己的前端」这种部署一个能收窄的旋钮。
//
// ⚠️★ 为什么这个文件同时有「静态头」与「按请求改写的头」：
//
//   静态那份（`corsHeaders`）散落在十几个 handler 里（`...corsHeaders`），
//   改成「每个 handler 拿 request 算一遍」要改十几处、且以后新增 handler 必然漏一处；
//   所以顺序是「handler 照旧铺 `*` → 入口处按 `ALLOW_ORIGINS` 改写」。
//   ⚠️ 改写**只有一处**：`export default { fetch }` 里的 `withCors`（含 catch 那条 500）。
//   新增 handler 时**不需要**做任何事 —— 它也会被改写，这正是选这个位置的理由。

/** 静态的那一份。⚠️ 它是「缺省放开」的基线，最终值由 `withCors` 按 `ALLOW_ORIGINS` 改写。 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-File-Name, X-File-Size, X-Room-Auth-Tokens, X-Share-Password',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition',
  'Access-Control-Max-Age': '86400'
};

export function handleCors() {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}

/**
 * 把 `ALLOW_ORIGINS`（逗号分隔）拆成一份归一化的白名单；没配就是 `null`（= 保持 `*`）。
 *
 * 归一化规则与自建服务端**同一套**（`clip9_core::config::normalize_origin`）：
 * scheme/host 小写、接受一个结尾斜杠、带路径 / 查询 / 用户信息的一律当没写。
 * 两边不一致的话，「同一份前端配两个后端」会得到一个诡异的结果：一个能连、一个报告 CORS。
 *
 * ⚠️ 写歪的条目是**丢掉**（不是让整份白名单失效）：一条手滑不该把其余合法的关掉。
 */
export function parseAllowedOrigins(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }
  const out = [];
  for (const piece of raw.split(',')) {
    const origin = normalizeOrigin(piece);
    if (origin && !out.includes(origin)) {
      out.push(origin);
    }
  }
  return out.length ? out : null;
}

/** 一条来源归一成 `scheme://host[:port]`；不是严格形状就回 `null`。 */
export function normalizeOrigin(raw) {
  const text = String(raw ?? '').trim();
  const match = /^(https?):\/\/([^/?#@\s]+)\/?$/i.exec(text);
  if (!match) {
    return null;
  }
  // ⚠️ 端口校验单独做：`[^/?#@\s]+` 会放过 `host:abc`。
  const hostPort = match[2];
  const colon = hostPort.lastIndexOf(':');
  if (colon >= 0) {
    const port = hostPort.slice(colon + 1);
    if (!/^\d+$/.test(port) || Number(port) > 65535) {
      return null;
    }
  }
  return `${match[1].toLowerCase()}://${hostPort.toLowerCase()}`;
}

/**
 * 这次请求该用哪个 `Access-Control-Allow-Origin`？
 *
 * - 返回 `'*'`：没配白名单（历史行为，谁都能读）；
 * - 返回那个 origin：配了白名单且它就在里面（**回显浏览器的原样写法**，不要回归一化后的字符串 ——
 *   某些浏览器对 `Origin` 的大小写敏感，而 CORS 的匹配是字符串比较）；
 * - 返回 `null`：配了白名单但它不在里面（或者压根没有 `Origin` 头）—— 调用方要把头**摘掉**。
 */
export function allowedOriginFor(request, env) {
  const allowlist = parseAllowedOrigins(env?.ALLOW_ORIGINS);
  if (!allowlist) {
    return '*';
  }
  const origin = request?.headers?.get?.('Origin');
  if (!origin) {
    return null;
  }
  const normalized = normalizeOrigin(origin);
  return normalized && allowlist.includes(normalized) ? origin : null;
}

/**
 * 按 `ALLOW_ORIGINS` 改写一份响应的 CORS 头。**入口处调用一次**（见文件抬头）。
 *
 * ⚠️★ 必须跳过 `101`（WebSocket 升级）：`new Response(body, { status: 101 })` 在运行时里
 * 是非法的（会被拒），而且 WS 握手本来也不走 CORS。跳过它，别让一个注释就能说清的事变成 500。
 */
export function withCors(response, request, env) {
  if (!response || response.status === 101) {
    return response;
  }
  const allowlist = parseAllowedOrigins(env?.ALLOW_ORIGINS);
  if (!allowlist) {
    // 没配 = 与改动前**逐字节**一样（连 Vary 都不加）。
    return response;
  }
  const allow = allowedOriginFor(request, env);
  const headers = new Headers(response.headers);
  if (allow === null) {
    // ⚠️ 摘掉而不是换成 `null`：`Access-Control-Allow-Origin: null` 是**另一种**语义
    // （`file://` / 沙箱 iframe 的来源），发它等于把另一个洞打开。
    headers.delete('Access-Control-Allow-Origin');
  } else {
    headers.set('Access-Control-Allow-Origin', allow);
  }
  // ⚠️ 响应随 `Origin` 变就必须说清楚，否则边缘缓存会把「给 A 的那份」发给 B。
  headers.append('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
