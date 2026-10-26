// 「实例一共能存多少文件字节」的闸（`FILE_TOTAL_LIMIT`）。
//
// 为什么要有这条测试：这条闸的全部意义是**钱**。它一旦写成「只对某个端点生效」，
// 症状不是报错，而是某个月的 R2 账单 —— 所以每条上传路径（整份 / 分片 / multipart）
// 都要各自被问一次，另外还要证明「不设上限时行为一个字没变」（既有部署不能被它影响）。
import { FileHandler } from './.build/file.mjs';
import { makeEnv, makeChecker, getJson } from './harness.mjs';

const { check, summary } = makeChecker();

const KB = 1024;
const MB = 1024 * KB;

function formOf(bytes, name = 'probe.bin') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), name);
  return form;
}

async function uploadFile(env, bytes, { room = 'default', auth = 'Bearer 123' } = {}) {
  const req = new Request(`http://worker.local/upload?room=${room}&client=t`, {
    method: 'POST',
    headers: auth ? { Authorization: auth } : {},
    body: formOf(bytes),
  });
  const res = await FileHandler.upload(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

console.log('── A. 不设 FILE_TOTAL_LIMIT：行为与改动前一致（既有部署不受影响）──');
{
  const { env } = makeEnv();
  delete env.FILE_TOTAL_LIMIT;
  const r = await uploadFile(env, 2 * MB);
  check('2 MB 照常上传', r.status, 200);
  const again = await uploadFile(env, 2 * MB);
  check('再来一个 2 MB 也照常', again.status, 200);
}

console.log('\n── B. 上限 300 KB：第一个过去、第二个被 507 拦住 ──');
{
  const { env, db } = makeEnv();
  env.FILE_TOTAL_LIMIT = String(300 * KB);
  const first = await uploadFile(env, 200 * KB);
  check('200 KB 通过', first.status, 200);
  const second = await uploadFile(env, 200 * KB);
  check('再 200 KB 超出上限 → 507', second.status, 507);
  check('错误码', second.json?.code, 'storage_quota_exceeded');
  check('话里带「文件空间已满」', String(second.json?.message || '').includes('文件空间已满'), true);
  // ⚠️ 被拒的那次**不许**留下消息行 —— 否则「拒绝」反而在吃额度。
  const rows = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE type = 'file'").get();
  check('库里只有 1 条文件消息', Number(rows.c), 1);
}

console.log('\n── C. 已过期的不占额度（配合 1 小时过期，空间能自愈）──');
{
  const { env, db } = makeEnv();
  env.FILE_TOTAL_LIMIT = String(300 * KB);
  const past = Math.floor(Date.now() / 1000) - 60;
  db.prepare(
    "INSERT INTO messages (type, name, size, room, timestamp, uuid, expireTime) VALUES ('file','old.bin',?, 'default', ?, 'old-uuid', ?)",
  ).run(290 * KB, past, past);
  const r = await uploadFile(env, 200 * KB);
  check('过期行不算 → 200 KB 通过', r.status, 200);
}

console.log('\n── D. 「永不过期」（expireTime = 0）的**要算**额度 ──');
{
  const { env, db } = makeEnv();
  env.FILE_TOTAL_LIMIT = String(300 * KB);
  db.prepare(
    "INSERT INTO messages (type, name, size, room, timestamp, uuid, expireTime) VALUES ('file','keep.bin',?, 'default', ?, 'keep-uuid', 0)",
  ).run(290 * KB, Math.floor(Date.now() / 1000));
  const r = await uploadFile(env, 200 * KB);
  check('永不过期的大文件占着额度 → 507', r.status, 507);
}

console.log('\n── E. 分片：会话数有上限，且按「已提交 + 本会话累计」判总量 ──');
{
  const { env, r2 } = makeEnv();
  env.FILE_TOTAL_LIMIT = String(100 * MB);
  // 造 20 个「还没收尾」的会话（就是 `uploads/<uuid>/meta` 这些键）
  for (let i = 0; i < 20; i += 1) r2.set(`uploads/session-${i}/meta`, { body: '{}', opts: {} });
  const blocked = await FileHandler.createChunk(
    new Request('http://worker.local/upload/chunk?room=default', {
      method: 'POST',
      headers: { Authorization: 'Bearer 123' },
      body: 'big.bin',
    }),
    env,
  );
  check('已经 20 个会话 → 429', blocked.status, 429);
  check('错误码', (await blocked.json())?.code, 'too_many_uploads');

  r2.delete('uploads/session-0/meta');
  const allowed = await FileHandler.createChunk(
    new Request('http://worker.local/upload/chunk?room=default', {
      method: 'POST',
      headers: { Authorization: 'Bearer 123' },
      body: 'big.bin',
    }),
    env,
  );
  check('腾出一个名额 → 允许', allowed.status, 200);
}

console.log('\n── F. 分片：累计超过上限时，在某一片上被拦住 ──');
{
  const { env } = makeEnv();
  env.FILE_LIMIT = String(100 * MB);
  env.FILE_TOTAL_LIMIT = String(10 * MB);

  const init = await FileHandler.createChunk(
    new Request('http://worker.local/upload/chunk?room=default', {
      method: 'POST',
      headers: { Authorization: 'Bearer 123' },
      body: 'big.bin',
    }),
    env,
  );
  const uuid = (await init.json())?.result?.uuid;
  check('初始化成功', typeof uuid, 'string');

  const part = async (bytes) => {
    const req = new Request(`http://worker.local/upload/chunk/${uuid}?room=default`, {
      method: 'POST',
      headers: { Authorization: 'Bearer 123', 'Content-Length': String(bytes) },
      body: new Uint8Array(bytes),
    });
    // ⚠️ `params` 是**路由**注进去的（线上由 index.js 的匹配塞进来），测试里没有路由，
    //    得自己挂上 —— 不挂的话处理器读到的是 undefined，报的是「Cannot read … uuid」。
    req.params = { uuid };
    const res = await FileHandler.uploadChunkPart(req, env);
    return res.status;
  };
  check('第一片 6 MB 通过', await part(6 * MB), 200);
  check('再一片 6 MB 超过 10 MB 上限 → 507', await part(6 * MB), 507);
}

summary('文件总量闸');
