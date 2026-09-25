#!/usr/bin/env node
// Go 与 Rust 两个真实实例的**并排比对**。
//
// 用法（在 `rust/` 下）：
//
//     node tools/compare-with-go.mjs
//
// 它自己会：构建 Go 服务端 → 起两个实例 → 逐请求比对 → 关掉两个实例。
// 需要 `go` 与 `cargo` 在 PATH 上（可用 `GO_BIN` / `CARGO_BIN` 覆盖）。
//
// # 为什么要有这个脚本
//
// 这是 P0 的**验收手段**，不是「跑通了」那种验证。契约的权威是 Go 的实现，
// 而「读代码觉得一致」和「真的一致」是两件事 —— 2026-09-25 第一次跑就抓到
// `/server` 的形状是编的（以为扁平、实际嵌套），以及 `/content/latest?format=json`
// 与只带 `Accept` 头时**返回两种不同的 JSON 形状**。
//
// ⚠️ 它比的是**语义**，不是字节。三处刻意的不比：
//   · JSON 对象 key 顺序（JSON 对象本来无序）
//   · 时间戳类字段（两个进程不在同一毫秒）
//   · `/rooms` 的数组顺序（Go 那边是 `for room := range map`，**本来就是随机的**）
// 还有一处是**已知的刻意差异**（`automation`，P0 未实现），单独在末尾报告。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(RUST_DIR, '..');
const GO_DIR = join(REPO_ROOT, 'cloud-clip');
const GO_BIN = process.env.GO_BIN || 'go';
const CARGO_BIN = process.env.CARGO_BIN || 'cargo';

const GO_PORT = 19521;
const RS_PORT = 19522;

const work = mkdtempSync(join(tmpdir(), 'clip9-cmp-'));
const goBin = join(work, 'go-clip');
const goData = join(work, 'go');
const rsData = join(work, 'rs');
mkdirSync(goData);
mkdirSync(rsData);

// 两边跑**同一份配置**，否则比出来的是配置差异而不是实现差异。
// `roomAuth.locked` 是给 WS 鉴权那组用例用的（一个要密码的房间）。
const config = JSON.stringify({
  server: { port: GO_PORT, roomList: true, roomAuth: { locked: 'pw' } },
});
writeFileSync(join(goData, 'config.json'), config);
writeFileSync(join(rsData, 'config.json'), config);

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error?.code === 'ENOENT') {
    // ⚠️ 这条提示是踩出来的：本机 go 在 /usr/local/bin、cargo 在 ~/.cargo/bin，
    // 而**新 shell / 沙箱的 PATH 往往不含它们**，报错只有一句「命令失败」，很难查。
    console.error(`\n找不到命令 \`${cmd}\` —— 它在 PATH 上吗？`);
    console.error('本机位置：go → /usr/local/bin/go，cargo → ~/.cargo/bin/cargo。');
    console.error('可以用 GO_BIN / CARGO_BIN 指定绝对路径：');
    console.error('  GO_BIN=/usr/local/bin/go CARGO_BIN=$HOME/.cargo/bin/cargo \\');
    console.error('    node tools/compare-with-go.mjs');
    process.exit(2);
  }
  if (r.status !== 0) {
    console.error(`\n命令失败（退出码 ${r.status}）：${cmd} ${args.join(' ')}`);
    process.exit(2);
  }
}

console.log('构建 Go 服务端…');
run(GO_BIN, ['build', '-o', goBin, '.'], { cwd: GO_DIR });
console.log('构建 Rust 服务端…');
run(CARGO_BIN, ['build', '-p', 'clip9-server'], { cwd: RUST_DIR });

const children = [];

/** 起一个子进程，并把它的输出攒起来 —— 起不来时要能看见**为什么**。
 *
 * ⚠️ 一开始这里是 `stdio: 'ignore'`，结果「实例没起来」只能靠猜。
 * 第一次真出问题（`roomAuth` 解析失败导致服务端退出）时，错误信息里什么都没有。 */
function start(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.__log = '';
  const collect = (d) => {
    child.__log += d;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  children.push(child);
  return child;
}

// ⚠️ Go 的 history.json 是相对 cwd 写的，所以必须 cd 进它自己的目录。
const goChild = start(
  goBin,
  ['-port', String(GO_PORT), '-config', join(goData, 'config.json')],
  { cwd: goData }
);
const rsChild = start(join(RUST_DIR, 'target/debug/clip9-server'), [
  '--config',
  join(rsData, 'config.json'),
  '--port',
  String(RS_PORT),
  '--data',
  rsData,
]);

const cleanup = () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
};
process.on('exit', cleanup);
// ⚠️ `process.on('exit')` **不**在 Ctrl-C / SIGTERM 时触发 —— 少了下面这几个处理器，
// 每中断一次就留两个孤儿进程占着端口，下次跑报「端口被占用」还找不到是谁。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

async function waitReady(port, child) {
  // ⚠️ 探活用 `/server` 而**不是** `/healthz` —— 后者是 Rust 侧自己加的便利端点，
  // **Go 那边没有**。用它会一直等不到就绪，报出来是「实例没起来」，很难查。
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/server`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // ⚠️ **把子进程的输出打出来** —— 否则「没起来」只能靠猜。
  // 这条提示是踩出来的：配置里 `roomAuth` 写成字符串（最常见的写法）时，
  // Rust 那边的配置解析失败、进程直接退出，而错误信息里当时什么都没有。
  const log = (child?.__log || '').trim().split('\n').slice(-15).join('\n');
  throw new Error(
    `端口 ${port} 上的实例没起来。它的输出（末 15 行）：\n${log || '(没有任何输出)'}\n` +
      `也可以单独跑一次看：\n` +
      `  （Go）  cd cloud-clip && go build -o /tmp/go-clip . && /tmp/go-clip -port ${GO_PORT}\n` +
      `  （Rust）cargo run -p clip9-server -- --port ${RS_PORT}`
  );
}

// ── 比对 ──────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

/** 规范化 JSON：**key 排序**，让比较不受对象 key 顺序影响。 */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

function normalize(value, port) {
  if (typeof value === 'string') return value.replaceAll(`:${port}`, ':PORT');
  if (Array.isArray(value)) return value.map((v) => normalize(v, port));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'timestamp' || k === 'lastActive') out[k] = typeof v === 'number' ? '<ts>' : v;
      // 刻意差异，末尾单独报告。
      else if (k === 'automation') out[k] = '<automation>';
      // ⚠️ 数组顺序不可比：Go 那边是 `for room := range map`，本来就随机。
      else if (k === 'rooms' && Array.isArray(v)) {
        out[k] = [...v]
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map((r) => normalize(r, port));
      } else out[k] = normalize(v, port);
    }
    return out;
  }
  return value;
}

async function hit(port, method, path, { body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  // 头也带回来 —— 下载链路的 `Content-Type` / `Content-Disposition` 是契约的一部分
  // （判错会让浏览器把图片当附件下载，或者把文件名丢掉）。
  const flat = {};
  for (const [k, v] of res.headers) flat[k.toLowerCase()] = v;
  return { status: res.status, text, parsed, headers: flat };
}

/** 单份 multipart 上传（`POST /upload`）。用 Node 自带的 FormData。 */
async function hitForm(port, path, filename, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: fd });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, text, parsed };
}

async function compare(label, method, path, opts = {}) {
  const [g, r] = await Promise.all([
    hit(GO_PORT, method, path, opts),
    hit(RS_PORT, method, path, opts),
  ]);

  const problems = [];
  if (g.status !== r.status) problems.push(`状态码 Go=${g.status} Rust=${r.status}`);
  if (g.parsed !== undefined || r.parsed !== undefined) {
    const gn = canonical(normalize(g.parsed, GO_PORT));
    const rn = canonical(normalize(r.parsed, RS_PORT));
    if (gn !== rn) problems.push(`JSON 不同\n    Go  : ${gn}\n    Rust: ${rn}`);
  } else if (g.text !== r.text) {
    problems.push(`文本不同\n    Go  : ${JSON.stringify(g.text)}\n    Rust: ${JSON.stringify(r.text)}`);
  }

  if (problems.length === 0) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(`${label}\n  ${problems.join('\n  ')}`);
    console.log(`  FAIL ${label}`);
    for (const p of problems) console.log(`       ${p}`);
  }
}

await waitReady(GO_PORT, goChild);
await waitReady(RS_PORT, rsChild);

console.log('\n=== 发文本：三种 Content-Type ===');
await compare('POST /text 纯文本（不声明 Content-Type）', 'POST', '/text', { body: 'hello world' });
await compare('POST /text JSON', 'POST', '/text', {
  body: JSON.stringify({ content: '{"a":1}' }),
  headers: { 'content-type': 'application/json' },
});
// ⚠️ urlencoded 必须整段当正文 —— 当表单解析会**静默存成空串**。
await compare('POST /text urlencoded（陷阱）', 'POST', '/text', {
  body: '# 标题\n- 一条',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});
await compare('POST /text multipart', 'POST', '/text', {
  body: '--B\r\nContent-Disposition: form-data; name="content"\r\n\r\n表单正文\r\n--B--\r\n',
  headers: { 'content-type': 'multipart/form-data; boundary=B' },
});
await compare('POST /text?room=work', 'POST', '/text?room=work', { body: 'work room text' });
await compare('POST /text 超长（413）', 'POST', '/text', { body: 'x'.repeat(5000) });

console.log('\n=== 取内容 ===');
await compare('GET /content/latest 原文', 'GET', '/content/latest');
await compare('GET /content/latest?format=json', 'GET', '/content/latest?format=json');
await compare('GET /content/latest（Accept: json）', 'GET', '/content/latest', {
  headers: { accept: 'application/json' },
});
await compare('GET /content/2 原文', 'GET', '/content/2');
await compare('GET /content/2?format=json', 'GET', '/content/2?format=json');
await compare('GET /content/2.json（后缀）', 'GET', '/content/2.json');
await compare('GET /content/999 不存在', 'GET', '/content/999');
await compare('GET /content/latest?format=html 不支持的格式', 'GET', '/content/latest?format=html');
await compare('GET /content/abc 非法 id', 'GET', '/content/abc');
await compare('GET /content/2?room=work 房间不匹配', 'GET', '/content/2?room=work');

console.log('\n=== 看板挪列 ===');
await compare('POST /content/2/column doing', 'POST', '/content/2/column', {
  body: JSON.stringify({ column: 'doing' }),
  headers: { 'content-type': 'application/json' },
});
await compare('POST /content/2/column 未知列', 'POST', '/content/2/column', {
  body: JSON.stringify({ column: 'later' }),
  headers: { 'content-type': 'application/json' },
});
await compare('POST /content/2/column 空列名→todo', 'POST', '/content/2/column', {
  body: JSON.stringify({ column: '' }),
  headers: { 'content-type': 'application/json' },
});
await compare('POST /content/999/column 不存在', 'POST', '/content/999/column', {
  body: JSON.stringify({ column: 'todo' }),
  headers: { 'content-type': 'application/json' },
});

console.log('\n=== 房间列表 ===');
await compare('GET /rooms', 'GET', '/rooms');

console.log('\n=== 改正文（?id=） ===');
await compare('POST /text?id=2 覆盖', 'POST', '/text?id=2', { body: '改了正文' });
await compare('POST /text?id=999 不存在', 'POST', '/text?id=999', { body: 'x' });

console.log('\n=== 撤销 ===');
await compare('POST /revoke/999 不存在', 'POST', '/revoke/999');
await compare('POST /revoke/abc 非法 id', 'POST', '/revoke/abc');
await compare('POST /revoke/2 真的删', 'POST', '/revoke/2');
await compare('GET /content/2 删完再看', 'GET', '/content/2?format=json');

console.log('\n=== /server ===');
await compare('GET /server', 'GET', '/server');
await compare('GET /server?room=work', 'GET', '/server?room=work');

console.log('\n=== 清空房间 ===');
await compare('POST /revoke/all?room=work', 'POST', '/revoke/all?room=work');
await compare('GET /rooms 清空后', 'GET', '/rooms');

// ── WebSocket ─────────────────────────────────────────────────────────

/** 原始握手：能拿到「升级**之前**被拒绝」时的状态码和响应体。
 *
 * ⚠️ Node 的 `WebSocket` 拿不到握手失败的响应体，而「没带凭据」和「凭据不对」是
 * **两条不同的错误码**（客户端据此决定「提示输密码」还是「提示密码错」），
 * 必须能读到 body 才比得了。 */
function wsHandshake(port, path, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...extraHeaders,
      },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('upgrade', () => {
      req.destroy();
      resolve({ status: 101, body: '' });
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

/** 连上一个 WS，收一小会儿消息，然后关掉。 */
function wsCollect(port, path, { ms = 400, send = [] } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages = [];
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      for (const m of send) ws.send(typeof m === 'string' ? m : JSON.stringify(m));
    });
    ws.addEventListener('message', (ev) => {
      try {
        messages.push(JSON.parse(ev.data));
      } catch {
        messages.push({ raw: String(ev.data) });
      }
    });
    ws.addEventListener('error', () => {});
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
      resolve({ opened, messages });
    }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WS 载荷的规范化。比 HTTP 那边多抹三样**已知差异**：
 *  · `version`：两个实现本来就不是同一个版本号
 *  · `device` / `os` / `browser`：UA 解析是近似实现（见 docs/HANDOVER.md §6）
 *  · 字符串形态的 `id`：设备 ID 是**带随机种子的哈希**，两边必然不同
 *    （消息 id 是数字，**不**抹 —— 那个必须一致） */
function normalizeWs(value, port) {
  if (typeof value === 'string') return value.replaceAll(`:${port}`, ':PORT');
  if (Array.isArray(value)) return value.map((v) => normalizeWs(v, port));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'timestamp' || k === 'lastActive') out[k] = typeof v === 'number' ? '<ts>' : v;
      else if (k === 'automation') out[k] = '<automation>';
      else if (k === 'version') out[k] = '<version>';
      else if (k === 'device' || k === 'os' || k === 'browser') out[k] = '<ua>';
      else if (k === 'id' && typeof v === 'string') out[k] = '<device-id>';
      else out[k] = normalizeWs(v, port);
    }
    return out;
  }
  return value;
}

function compareEvents(label, g, r) {
  const problems = [];
  if (g.opened !== r.opened) problems.push(`连上与否不同 Go=${g.opened} Rust=${r.opened}`);
  // 事件的**种类与顺序**是契约的一部分（客户端按顺序处理）。
  const ge = g.messages.map((m) => m.event ?? '<无 event>');
  const re = r.messages.map((m) => m.event ?? '<无 event>');
  if (ge.join(',') !== re.join(',')) {
    problems.push(`事件序列不同\n    Go  : ${ge.join(' ')}\n    Rust: ${re.join(' ')}`);
  }
  const gn = canonical(g.messages.map((m) => normalizeWs(m, GO_PORT)));
  const rn = canonical(r.messages.map((m) => normalizeWs(m, RS_PORT)));
  if (gn !== rn) problems.push(`载荷不同\n    Go  : ${gn}\n    Rust: ${rn}`);

  if (problems.length === 0) {
    pass++;
    console.log(`  ok   ${label}  [${ge.join(' ')}]`);
  } else {
    fail++;
    failures.push(`${label}\n  ${problems.join('\n  ')}`);
    console.log(`  FAIL ${label}`);
    for (const p of problems) console.log(`       ${p}`);
  }
}

console.log('\n=== WebSocket：握手与推送顺序 ===');

// 空房间连上：应当只有一条 `config`（没历史、没别的设备）。
{
  const [g, r] = await Promise.all([
    wsCollect(GO_PORT, '/push?room=ws-empty'),
    wsCollect(RS_PORT, '/push?room=ws-empty'),
  ]);
  compareEvents('空房间：只有 config', g, r);
}

// ping → pong 原样回显（前端用它算 RTT）。
{
  const [g, r] = await Promise.all([
    wsCollect(GO_PORT, '/push?room=ws-ping', { send: [{ event: 'ping', data: 1234567890 }] }),
    wsCollect(RS_PORT, '/push?room=ws-ping', { send: [{ event: 'ping', data: 1234567890 }] }),
  ]);
  compareEvents('ping → pong 回显', g, r);
}

// 鉴权：升级**之前**就该被拒，且两种失败的错误码不同。
for (const [label, headers] of [
  ['锁着的房间：不带凭据', {}],
  ['锁着的房间：凭据错', { Authorization: 'Bearer nope' }],
  ['锁着的房间：凭据对', { Authorization: 'Bearer pw' }],
]) {
  const [g, r] = await Promise.all([
    wsHandshake(GO_PORT, '/push?room=locked', headers),
    wsHandshake(RS_PORT, '/push?room=locked', headers),
  ]);
  const problems = [];
  if (g.status !== r.status) problems.push(`状态码 Go=${g.status} Rust=${r.status}`);
  const gb = g.body.trim();
  const rb = r.body.trim();
  if (gb !== rb) problems.push(`响应体不同\n    Go  : ${gb}\n    Rust: ${rb}`);
  if (problems.length === 0) {
    pass++;
    console.log(`  ok   WS ${label}（${g.status}${gb ? ' ' + JSON.parse(gb).code : ''}）`);
  } else {
    fail++;
    failures.push(`WS ${label}\n  ${problems.join('\n  ')}`);
    console.log(`  FAIL WS ${label}`);
    for (const p of problems) console.log(`       ${p}`);
  }
}

// 广播 + connect/disconnect：两个客户端 + 一条 HTTP 发的消息。
//
// ⚠️ 两边用**同一个房间名和同一段正文** —— 它们是两个独立进程，不会互相干扰。
// 一开始我给它们加了不同的后缀来「区分」，结果比出来的是**我自己造的差异**
// （房间名不同、正文里的 Go/Rust 不同），不是实现的差异。
const wsRoom = 'ws-bc';
const wsBody = '来自 HTTP 的广播';
const wsResults = {};

for (const [name, port] of [
  ['Go', GO_PORT],
  ['Rust', RS_PORT],
]) {
  const a = wsCollect(port, `/push?room=${wsRoom}`, { ms: 1200 });
  await sleep(250);
  const b = wsCollect(port, `/push?room=${wsRoom}`, { ms: 950 });
  await sleep(250);
  await hit(port, 'POST', `/text?room=${wsRoom}`, { body: wsBody });
  await sleep(150);
  const [ra, rb] = await Promise.all([a, b]);
  wsResults[name] = { ra, rb };

  // A 应该看到：config → connect(B) → receive
  // B 应该看到：connect(A) → config → receive
  const seq = (x) => x.messages.map((m) => m.event).join(' ');
  console.log(`  ·  ${name} A=[${seq(ra)}]  B=[${seq(rb)}]`);
}

/** ⚠️ 把 `disconnect` 滤掉再比。
 *
 * 两个客户端的收集窗口长度接近，**谁先关是竞态** —— 先关的那个会让另一个收到
 * `disconnect`，而这一组用例想比的是 config / connect / receive。
 * `disconnect` 有它自己的确定性用例（下面那条）。 */
const stripDisconnect = (x) => ({
  opened: x.opened,
  messages: x.messages.filter((m) => m.event !== 'disconnect'),
});

compareEvents(
  '两客户端：config / connect / receive',
  stripDisconnect(wsResults.Go.ra),
  stripDisconnect(wsResults.Rust.ra)
);
compareEvents(
  '后连的那个：connect / config / receive',
  stripDisconnect(wsResults.Go.rb),
  stripDisconnect(wsResults.Rust.rb)
);

// disconnect：B 先关，A 应该收到 `disconnect`（带设备 ID）。
// ⚠️ 窗口长度要**拉开**（A 1200ms、B 400ms）才确定 —— 否则又是竞态。
{
  const results = {};
  for (const [name, port] of [
    ['Go', GO_PORT],
    ['Rust', RS_PORT],
  ]) {
    const a = wsCollect(port, '/push?room=ws-disc', { ms: 1200 });
    await sleep(250);
    const b = wsCollect(port, '/push?room=ws-disc', { ms: 400 });
    const [ra] = await Promise.all([a, b]);
    results[name] = ra;
  }
  compareEvents('B 先关 → A 收到 disconnect', results.Go, results.Rust);
}


// ── 文件 ──────────────────────────────────────────────────────────────

console.log('\n=== 文件：分片上传 / 下载 / 删除 ===');

/** uuid 是随机的，两边必然不同 —— 比之前抹平成 `<uuid>`。 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const scrubUuid = (v) => JSON.parse(JSON.stringify(v ?? null).replaceAll(UUID_RE, '<uuid>'));

/** 在一台服务器上跑完整条文件流程，把每一步的响应都收回来。 */
async function fileFlow(port) {
  const init = await hit(port, 'POST', '/upload/chunk?room=ws-file', {
    body: 'note.txt',
    headers: { 'content-type': 'text/plain' },
  });
  const uuid = init.parsed?.result?.uuid;
  const part1 = await hit(port, 'POST', `/upload/chunk/${uuid}`, { body: 'hello ' });
  const part2 = await hit(port, 'POST', `/upload/chunk/${uuid}`, { body: 'world' });
  const finish = await hit(port, 'POST', `/upload/finish/${uuid}?room=ws-file`);
  const download = await hit(port, 'GET', `/file/${uuid}/note.txt`);
  const attach = await hit(port, 'GET', `/file/${uuid}/note.txt?download=true`);
  // ⚠️ Range 要在**删除之前**测。原来放在删除之后，两边都回 404、于是「通过」——
  // 那是一条**假的绿**：什么都没验证。
  const range = await hit(port, 'GET', `/file/${uuid}/note.txt`, {
    headers: { range: 'bytes=0-4' },
  });
  const remove = await hit(port, 'DELETE', `/file/${uuid}/note.txt`);
  const after = await hit(port, 'GET', `/file/${uuid}/note.txt`);
  const single = await hitForm(port, '/upload?room=ws-file', 'single.txt', 'single-shot');
  return { uuid, init, part1, part2, finish, download, attach, range, remove, after, single };
}

{
  const [g, r] = await Promise.all([fileFlow(GO_PORT), fileFlow(RS_PORT)]);

  const steps = [
    // ⚠️ 每一步都要 `normalize(…, port)`：响应里的 `url` 带着**端口**，不抹平就永远是红的。
    ['POST /upload/chunk 初始化', 'init', (x, p) => scrubUuid(normalize(x.parsed, p))],
    ['POST /upload/chunk/<uuid> 第一片', 'part1', (x) => x.parsed],
    ['POST /upload/chunk/<uuid> 第二片', 'part2', (x) => x.parsed],
    ['POST /upload/finish/<uuid>', 'finish', (x, p) => scrubUuid(normalize(x.parsed, p))],
    ['GET /file/<uuid>/<name> 正文', 'download', (x) => x.text],
    ['GET /file/<uuid>/<name>?download=true', 'attach', (x) => x.text],
    ['GET /file/<uuid>/<name> Range（视频拖动进度靠它）', 'range', (x) => `${x.status} ${x.text}`],
    ['DELETE /file/<uuid>/<name>', 'remove', (x) => x.parsed],
    ['GET 删完再取（404）', 'after', (x, p) => scrubUuid(normalize(x.parsed, p))],
    ['POST /upload 单份 multipart', 'single', (x, p) => scrubUuid(normalize(x.parsed, p))],
  ];

  for (const [label, key, pick] of steps) {
    const problems = [];
    if (g[key].status !== r[key].status) {
      problems.push(`状态码 Go=${g[key].status} Rust=${r[key].status}`);
    }
    const gv = canonical(pick(g[key], GO_PORT));
    const rv = canonical(pick(r[key], RS_PORT));
    if (gv !== rv) problems.push(`载荷不同\n    Go  : ${gv}\n    Rust: ${rv}`);

    if (problems.length === 0) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      failures.push(`${label}\n  ${problems.join('\n  ')}`);
      console.log(`  FAIL ${label}`);
      for (const p of problems) console.log(`       ${p}`);
    }
  }

  // ⚠️ 两边一致**还不够** —— 都回 404 也算「一致」。这条钉住 Range 真的生效：
  // 必须 206、且只取到前 5 个字节。少了它，`ServeFile` 被换成不支持 Range 的实现也发现不了。
  if (g.range.status === 206 && r.range.status === 206 && g.range.text === 'hello') {
    pass++;
    console.log(`  ok   Range 真的生效（206，只取到 ${JSON.stringify(g.range.text)}）`);
  } else {
    fail++;
    failures.push(
      `Range 没生效\n  Go=${g.range.status} ${JSON.stringify(g.range.text)}\n  Rust=${r.range.status} ${JSON.stringify(r.range.text)}`
    );
    console.log('  FAIL Range 没生效');
  }

  // 下载响应头单独比 —— 判错会让浏览器把图片当附件下载、或者丢掉文件名。
  const headersToCheck = ['content-type', 'content-disposition', 'content-length'];
  const gh = headersToCheck.map((h) => `${h}=${g.download.headers[h] ?? '-'}`).join(' | ');
  const rh = headersToCheck.map((h) => `${h}=${r.download.headers[h] ?? '-'}`).join(' | ');
  if (gh === rh) {
    pass++;
    console.log(`  ok   下载响应头  [${gh}]`);
  } else {
    fail++;
    failures.push(`下载响应头\n  Go  : ${gh}\n  Rust: ${rh}`);
    console.log('  FAIL 下载响应头');
    console.log(`       Go  : ${gh}`);
    console.log(`       Rust: ${rh}`);
  }

  // 分片拼出来的内容必须是原样 —— 这条是「分片追加」这个机制的核心。
  if (g.download.text === 'hello world' && r.download.text === 'hello world') {
    pass++;
    console.log('  ok   两片拼起来正好是 hello world');
  } else {
    fail++;
    failures.push(
      `分片拼接结果不对\n  Go=${JSON.stringify(g.download.text)} Rust=${JSON.stringify(r.download.text)}`
    );
    console.log('  FAIL 分片拼接结果不对');
  }

  // ⚠️ Range 已经在上面那组步骤里测过了（删除**之前**）。
  // 原来这里还有一段「删完再取 Range」，两边都回 404 —— 那是**假的绿**，删掉了。
}

// 文件条目在 `/content/<id>` 上的 JSON 形状。
{
  const [g, r] = await Promise.all([
    hit(GO_PORT, 'GET', '/content/latest?room=ws-file&format=json'),
    hit(RS_PORT, 'GET', '/content/latest?room=ws-file&format=json'),
  ]);
  const gv = canonical(scrubUuid(normalize(g.parsed, GO_PORT)));
  const rv = canonical(scrubUuid(normalize(r.parsed, RS_PORT)));
  if (g.status === r.status && gv === rv) {
    pass++;
    console.log(`  ok   文件条目的 /content/<id> JSON（type=${g.parsed?.type}）`);
  } else {
    fail++;
    failures.push(`文件条目的 /content JSON\n  Go  : ${gv}\n  Rust: ${rv}`);
    console.log('  FAIL 文件条目的 /content JSON');
    console.log(`       Go  : ${gv}`);
    console.log(`       Rust: ${rv}`);
  }
}

// ── 已知的、刻意的差异 ────────────────────────────────────────────────
console.log('\n=== 已知差异（刻意，不算失败） ===');
const gSrv = (await hit(GO_PORT, 'GET', '/server')).parsed;
const rSrv = (await hit(RS_PORT, 'GET', '/server')).parsed;
console.log(
  `  KNOWN automation：Go enabled=${gSrv.automation.enabled}（带 ${gSrv.automation.actions?.length ?? 0} 个动作声明），` +
    `Rust enabled=${rSrv.automation.enabled} —— P0 未实现定时自动化（P2），前端会正确地不显示入口`
);
console.log('  KNOWN version：两个实现本来就不是同一个版本号（WS 的 config 里也带着它）');
console.log(
  '  KNOWN UA：device / os / browser 是近似实现（Go 用 uap-go 的正则库）。' +
    '**type（desktop/smartphone/tablet）是逐字移植的**，前端图标靠它'
);

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (failures.length) {
  console.log('\n失败详情：');
  failures.forEach((f) => console.log('- ' + f));
}
process.exit(fail === 0 ? 0 : 1);
