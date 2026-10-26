// 测试脚手架：mock 一个 Worker env（D1 用 node:sqlite，R2 用 Map，Durable Object 用链式桩）。
// 被 sniff/upload/receive 三个测试共用。
import { DatabaseSync } from 'node:sqlite';

// 资源层桩：分享落地页和兜底路由都要读它（`readShellHtml`）来注入 `<base>` / OG 卡片。
// 夹具形状刻意和 vite 构建产物一致 —— `<head>`、一处 `<title>`、`<div id="app">`、
// **相对**资源引用（`./assets/…`）。最后这点是关键：不注入 `<base>` 时深路径下会解析错。
export const SHELL_FIXTURE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>clip9</title>
<script type="module" crossorigin src="./assets/index-DyTrt7K.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-Bkjgy8nt.css">
</head>
<body>
<div id="app"></div>
</body>
</html>
`;

function makeAssetsStub() {
  return {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/index.html' || path === '/') {
        return new Response(SHELL_FIXTURE, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

export function makeEnv() {
  const db = new DatabaseSync(':memory:');
  // 刻意停留在「加 deviceName 列之前」的表结构 —— 线上已有部署就是这个样子，
  // 让 saveToD1 里的自愈加列逻辑每次测试都真的被走到。
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, content TEXT, name TEXT, size INTEGER,
    room TEXT, timestamp INTEGER, senderIP TEXT, senderClientID TEXT, userAgent TEXT,
    uuid TEXT, expireTime INTEGER, url TEXT)`);

  const DB = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { const r = stmt.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
  };

  const r2 = new Map();
  // multipart 会话：`uploadId → { key, opts, parts }`。只有分片上传那几条路径用得到，
  // 但它们在 `upload-quota.js` 的闸门里是必须走得到的一段。
  const multipart = new Map();
  let multipartSeq = 0;
  const R2_BUCKET = {
    async put(key, body, opts) { r2.set(key, { body, opts }); },
    // 真 R2 的 `delete()` **两种都收**：单个 key，或 key 数组（一次最多 1000 个）。
    // 过期文件清理走的是**数组**那条（一轮一次调用，省子请求）——
    // 桩不支持数组的话，那条路径在测试里就完全走不到，而线上跑的就是它。
    async delete(key) {
      if (Array.isArray(key)) {
        for (const k of key) r2.delete(k);
        return;
      }
      r2.delete(key);
    },
    // 真 R2 的 get() 带 customMetadata / httpMetadata / size，这三样都被下载链路读：
    //   - customMetadata.room 决定 /file/ 按哪个房间鉴权（写侧 put 时就写进去了）
    //   - customMetadata.expireTime 决定过期拦截
    //   - size 进 Content-Length
    // 早先这里只回 { body }，于是「按文件所属房间鉴权」这条路径在测试里根本走不到。
    async get(key) {
      const rec = r2.get(key);
      if (!rec) return null;
      const body = rec.body;
      const size = typeof body?.size === 'number'
        ? body.size
        : (body?.byteLength ?? body?.length ?? 0);
      const asText = async () => {
        if (typeof body === 'string') return body;
        if (body && typeof body.text === 'function') return await body.text();
        return '';
      };
      return {
        body,
        size,
        httpMetadata: rec.opts?.httpMetadata,
        customMetadata: rec.opts?.customMetadata,
        // 真 R2 的 `get()` 回来的是 R2ObjectBody，除内容外还有这几个读法。
        // 分片上传那一路读会话元数据用的就是 `text()` —— 少了它，`uploadChunkPart`
        // 在测试里直接 TypeError（线上却是好的），那种「只有测试坏」的差异最费时间。
        text: asText,
        async json() { return JSON.parse(await asText()); },
        async arrayBuffer() {
          if (body instanceof Uint8Array) return body.buffer;
          if (body && typeof body.arrayBuffer === 'function') return await body.arrayBuffer();
          return new ArrayBuffer(0);
        },
      };
    },
    async head(key) {
      const rec = r2.get(key);
      if (!rec) return null;
      return { size: rec.body?.size ?? 0, customMetadata: rec.opts?.customMetadata };
    },
    // `list()` 只回**元数据**（键名 / 大小），不回内容。`upload-quota.js` 用它数
    // 「还没收尾的上传会话」（`uploads/` 前缀）—— 那条闸在测试里必须真的走得到，
    // 否则「会话数上限」这项只存在于代码里。
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...r2.keys()].filter((k) => k.startsWith(prefix)).sort();
      const slice = keys.slice(0, limit);
      return {
        objects: slice.map((k) => ({ key: k, size: r2.get(k)?.body?.size ?? 0 })),
        truncated: keys.length > limit,
      };
    },
    // ── R2 原生 multipart 的桩 ─────────────────────────────────────────────
    // 只用来说明「分片上传这条路在测试里真的能跑到」，语义按真 R2 的用法写：
    // `createMultipartUpload` 建会话 → `uploadPart` 追加 → `complete` 合并成最终对象。
    async createMultipartUpload(key, opts) {
      const uploadId = `mp-${multipartSeq += 1}`;
      multipart.set(uploadId, { key, opts, parts: new Map() });
      return {
        uploadId,
        key,
        async uploadPart(partNumber, body) {
          const rec = multipart.get(uploadId);
          rec.parts.set(partNumber, body);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts) {
          const rec = multipart.get(uploadId);
          const bodies = parts.map((p) => rec.parts.get(p.partNumber));
          const size = bodies.reduce((sum, b) => sum + (b?.size ?? b?.byteLength ?? 0), 0);
          r2.set(key, { body: { size }, opts: rec.opts });
          multipart.delete(uploadId);
          return { size };
        },
        async abort() { multipart.delete(uploadId); },
      };
    },
    resumeMultipartUpload(key, uploadId) {
      const rec = multipart.get(uploadId);
      if (!rec) throw new Error(`没有这个 multipart 会话：${uploadId}`);
      rec.key = key;
      return {
        uploadId,
        key,
        async uploadPart(partNumber, body) {
          rec.parts.set(partNumber, body);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts) {
          const size = parts
            .map((p) => rec.parts.get(p.partNumber))
            .reduce((sum, b) => sum + (b?.size ?? b?.byteLength ?? 0), 0);
          r2.set(key, { body: { size }, opts: rec.opts });
          multipart.delete(uploadId);
          return { size };
        },
        async abort() { multipart.delete(uploadId); },
      };
    },
  };

  // Durable Object 桩：链式调用不断，且必须让 then 为 undefined ——
  // 否则 await 一个 Proxy 会无限递归（Proxy 对 then 也返回自身，成为永不 resolve 的 thenable）。
  const makeStub = () => new Proxy(function () {}, {
    get: (t, prop) => (prop === 'then' ? undefined : makeStub()),
    apply: () => Promise.resolve(makeStub()),
  });

  const env = {
    DB, R2_BUCKET, ASSETS: makeAssetsStub(), WEBSOCKET_ROOM: makeStub(),
    AUTH_PASSWORD: '123', ROOM_AUTH_JSON: '{}', HISTORY_LIMIT: '50',
    TEXT_LIMIT: '40960', FILE_LIMIT: '204857600', FILE_EXPIRE: '3600',
  };
  return { env, db, r2 };
}

export function makeChecker() {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    check(name, got, want) {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g === w) { pass++; console.log(`  ✓ ${name}`); }
      else {
        fail++;
        failures.push(`${name}\n      实际: ${g}\n      期望: ${w}`);
        console.log(`  ✗ ${name}  实际=${g} 期望=${w}`);
      }
    },
    summary(label) {
      console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
      if (failures.length) {
        console.log('\n失败明细：');
        for (const f of failures) console.log('  ✗ ' + f);
        process.exit(1);
      }
      console.log(`${label} ✅`);
    },
  };
}

// 发一个 POST 请求并解析响应
export async function postJson(handler, env, path, body, { auth = 'Bearer 123' } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  const req = new Request(`http://worker.local${path}`, { method: 'POST', headers, body });
  const res = await handler(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// 发一个 GET 请求并解析响应
export async function getJson(handler, env, path, { auth = 'Bearer 123', accept } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  if (accept) headers.Accept = accept;
  const req = new Request(`http://worker.local${path}`, { method: 'GET', headers });
  const res = await handler(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
