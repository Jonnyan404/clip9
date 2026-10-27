// Android HTTP Shortcuts 的「发送文件」从 Single File 换成 Multiple Files 之后，
// 一条请求会带多个 `file[]` part。服务端必须把它们拆成**多条消息**（和网页端
// 「每个文件一个请求」语义一致），而不是只取第一个。
//
// 同时钉住两件事：
//   · 单个 `file` 的旧响应 `{id, type, url}` 一个字不变（Apple / 网页 / 桌面端）
//   · 总容量 `FILE_TOTAL_LIMIT` 在**任何字节落盘之前**按整批判，拒绝时不能留半批
import { FileHandler } from './.build/file.mjs';
import { makeEnv, makeChecker } from './harness.mjs';

const { check, summary } = makeChecker();
const KB = 1024;

function formOf(entries) {
  const form = new FormData();
  for (const [field, name, bytes] of entries) {
    form.append(field, new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), name);
  }
  return form;
}

async function upload(env, entries, { room = 'default' } = {}) {
  const res = await FileHandler.upload(
    new Request(`http://worker.local/upload?room=${room}&client=t`, {
      method: 'POST',
      headers: { Authorization: 'Bearer 123' },
      body: formOf(entries),
    }),
    env,
  );
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function fileRows(db) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE type = 'file'").get().c);
}

function storedKeys(r2) {
  return [...r2.keys()].filter((key) => key.startsWith('files/'));
}

console.log('── A. 两个 file[] part → 两条消息、两个独立 ID ──');
{
  const { env, db, r2 } = makeEnv();
  const r = await upload(env, [
    ['file[]', '第一张.png', [0x89, 0x50, 0x4e, 0x47]],
    ['file[]', '第二张.png', [0x89, 0x50, 0x4e, 0x47, 0x00]],
  ]);
  check('HTTP 200', r.status, 200);
  check('count', r.json?.count, 2);
  check('ids 两个', Array.isArray(r.json?.ids) && r.json.ids.length, 2);
  check('第一个文件名保真', r.json?.files?.[0]?.name, '第一张.png');
  check('第二个文件名保真', r.json?.files?.[1]?.name, '第二张.png');
  check('第一个大小', r.json?.files?.[0]?.size, 4);
  check('第二个大小', r.json?.files?.[1]?.size, 5);
  check('库里两条文件消息', fileRows(db), 2);
  check('R2 里两个文件对象', storedKeys(r2).length, 2);
}

console.log('\n── B. 单个 file → 仍然是旧的 {id,type,url}，不变成批量 ──');
{
  const { env } = makeEnv();
  const r = await upload(env, [['file', '一个.bin', [1, 2, 3]]]);
  check('HTTP 200', r.status, 200);
  check('有 id', typeof r.json?.id, 'string');
  check('没有 ids', r.json?.ids, undefined);
  check('没有 files', r.json?.files, undefined);
}

console.log('\n── C. 一个 file[] 也按批量形状返回（客户端统一处理）──');
{
  const { env } = makeEnv();
  const r = await upload(env, [['file[]', 'only.bin', [1]]]);
  check('HTTP 200', r.status, 200);
  check('ids 一个', Array.isArray(r.json?.ids) && r.json.ids.length, 1);
  check('files 一个', r.json?.files?.length, 1);
}

console.log('\n── D. 整批超过 FILE_TOTAL_LIMIT → 507，且一个字节都不落盘 ──');
{
  const { env, db, r2 } = makeEnv();
  env.FILE_TOTAL_LIMIT = String(5);
  const r = await upload(env, [
    ['file[]', 'a.bin', [1, 2, 3]],
    ['file[]', 'b.bin', [4, 5, 6]],
  ]);
  check('HTTP 507', r.status, 507);
  check('错误码', r.json?.code, 'storage_quota_exceeded');
  check('没有消息行', fileRows(db), 0);
  check('没有 R2 对象', storedKeys(r2).length, 0);
}

console.log('\n── E. 单个文件超 FILE_LIMIT → 413，整批都不落盘 ──');
{
  const { env, db, r2 } = makeEnv();
  env.FILE_LIMIT = String(4);
  const r = await upload(env, [
    ['file[]', 'ok.bin', [1, 2, 3]],
    ['file[]', 'too-big.bin', [1, 2, 3, 4, 5]],
  ]);
  check('HTTP 413', r.status, 413);
  check('错误码', r.json?.code, 'file_too_large');
  check('话里指出超限文件', String(r.json?.message || '').includes('too-big.bin'), true);
  check('没有消息行', fileRows(db), 0);
  check('没有 R2 对象', storedKeys(r2).length, 0);
}

console.log('\n── F. 空表单仍然 400 ──');
{
  const { env } = makeEnv();
  const r = await upload(env, []);
  check('HTTP 400', r.status, 400);
  check('错误码', r.json?.code, 'no_file');
}

summary('多文件上传（file[]）');
