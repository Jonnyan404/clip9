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
const config = JSON.stringify({ server: { port: GO_PORT, roomList: true } });
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
function start(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: 'ignore', ...opts });
  children.push(child);
  return child;
}

// ⚠️ Go 的 history.json 是相对 cwd 写的，所以必须 cd 进它自己的目录。
start(goBin, ['-port', String(GO_PORT), '-config', join(goData, 'config.json')], { cwd: goData });
start(join(RUST_DIR, 'target/debug/clip9-server'), [
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

async function waitReady(port) {
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
  throw new Error(
    `端口 ${port} 上的实例没起来。先单独跑一次看它为什么起不来：\n` +
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

await waitReady(GO_PORT);
await waitReady(RS_PORT);

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

// ── 已知的、刻意的差异 ────────────────────────────────────────────────
console.log('\n=== 已知差异（刻意，不算失败） ===');
const gSrv = (await hit(GO_PORT, 'GET', '/server')).parsed;
const rSrv = (await hit(RS_PORT, 'GET', '/server')).parsed;
console.log(
  `  KNOWN automation：Go enabled=${gSrv.automation.enabled}（带 ${gSrv.automation.actions?.length ?? 0} 个动作声明），` +
    `Rust enabled=${rSrv.automation.enabled} —— P0 未实现定时自动化（P2），前端会正确地不显示入口`
);

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (failures.length) {
  console.log('\n失败详情：');
  failures.forEach((f) => console.log('- ' + f));
}
process.exit(fail === 0 ? 0 : 1);
