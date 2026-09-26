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
// 还有几处是**已知的刻意差异**（`version`、UA 的近似实现），单独在末尾报告。
//
// ⚠️ `automation`（`/server` 的能力声明）**以前**也在末尾那一节 —— 那时 Rust 还没实现
// 定时自动化。P2 落地后它已经进入正常比对（连同 34 个动作的完整声明），见下面那一节。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispose, makeTempDir } from './lib/tmpdir.mjs';

const RUST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(RUST_DIR, '..');

/** Go 仓库里的 `cloud-clip/` 目录。
 *
 * ⚠️★ **本仓库没有 Go**（它现在在另一个仓库里），所以路径按顺序找，不写死：
 * 1. 显式 `GO_DIR` 环境变量（CI 或别处签出时用）；
 * 2. `<父目录>/cloud-clip` —— 本仓库在 Go 仓库里面（clone 进它的根目录，或老的 `rust/` 摆法）；
 * 3. `<父目录>/cloud-clipboard-go/cloud-clip` —— 两个仓库平级。
 *
 * 判定用 `lib/handler.go` 在不在，而不是只看目录存不存在：目录存在但内容不对时
 * 会走到「找不到」那条路上，报错比 `go build` 失败清楚。
 *
 * ⚠️ 所以这个脚本是**过渡期工具**（它需要 Go 在旁边签出），而本仓库自己的验证面是
 * `cargo test` + 三个实机脚本（`spa-acceptance` / `share-page-acceptance` / `page-smoke`，
 * 它们只接受一个 URL，不需要 Go）。
 */
function findGoDir() {
  const candidates = [
    process.env.GO_DIR,
    join(REPO_ROOT, 'cloud-clip'),
    join(dirname(RUST_DIR), 'cloud-clipboard-go', 'cloud-clip'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'lib', 'handler.go'))) return resolve(candidate);
  }
  console.error('\n找不到 Go 仓库的 `cloud-clip/` 目录（判定依据：里面有 `lib/handler.go`）。试过：');
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error('用环境变量指定：');
  console.error('  GO_DIR=/path/to/cloud-clipboard-go/cloud-clip node tools/compare-with-go.mjs');
  process.exit(2);
}

const GO_DIR = findGoDir();
const GO_BIN = process.env.GO_BIN || 'go';
const CARGO_BIN = process.env.CARGO_BIN || 'cargo';

const GO_PORT = 19521;
const RS_PORT = 19522;

const work = makeTempDir('clip9-cmp-');
const goBin = join(work, 'go-clip');
const goData = join(work, 'go');
const rsData = join(work, 'rs');
mkdirSync(goData);
mkdirSync(rsData);

// 两边跑**同一份配置**，否则比出来的是配置差异而不是实现差异。
//
// `roomAuth` 这几个房间是给下面几组用例用的：
// · `locked`        —— WS 鉴权（要密码）；也当定时任务的「room 档」用
// · `never-expire`  —— `fileExpire: 0` = **永不过期**
// · `negative`      —— `fileExpire: -5` = 配置写错了，**回退全局** `file.expire`
// · `short`         —— `fileExpire: 1` = 1 秒后过期
// · `open-auto`     —— 公开房间 + 显式 `automation: "single"`：**唯一**会下发 task token 的那一档
// · `no-auto`       —— 显式 `automation: "none"`：配置层能否决掉运行时权限
//
// ⚠️ 最后两个房间**只**出现在 `roomAuth` 里，而 `/rooms` 的来源是消息 / 连接 / 统计
// （Go 的 `getRoomList`），**不看配置** —— 所以它们不会污染上面那几条 `/rooms` 的比对。
const config = JSON.stringify({
  server: {
    port: GO_PORT,
    roomList: true,
    roomAuth: {
      locked: 'pw',
      'never-expire': { open: true, fileExpire: 0 },
      negative: { open: true, fileExpire: -5 },
      short: { open: true, fileExpire: 1 },
      'open-auto': { open: true, automation: 'single' },
      'no-auto': { open: true, automation: 'none' },
    },
  },
  // 定时自动化的总开关。⚠️ **必须显式写出来**：两边的默认值一度不一致
  // （Go 的 `defaultConfig()` 是 true，Rust 的 `AutomationConfig::default()` 曾写成 false），
  // 靠默认值「碰巧对上」的比对等于没比。默认值本身由 `config_defaults_match_go` 那条
  // 单测钉着（在 `crates/core/src/config.rs` 里）。
  automation: { enabled: true },
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
  // ⚠️ **挪走，不删**：递归删除会撞沙箱的批量删除守卫（弹权限确认框）。
  // 见 `lib/tmpdir.mjs` 的长注释。
  dispose(work);
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
      // 时间戳类字段：两个进程不在同一毫秒，逐字比没有意义。
      //
      // ⚠️ **`0` 要原样保留** —— 它在这些字段上是「永不过期 / 未设置」，
      // 和「某个时刻」是**两种不同的语义**。整段抹成 `<ts>` 会把
      // 「fileExpire: 0 的房间」和「会过期的房间」比成一样，那正好是最该测的一格。
      if (
        [
          'timestamp',
          'lastActive',
          'expire',
          'expireTime',
          'scheduledAt',
          // ⚠️ 分享/会话令牌里**所有**的时刻：两个进程签发的那一秒就未必相同，
          // 而 `expiresAt` 是「签发时刻 + TTL」，比出来没意义。
          'expiresAt',
          'previewExpiresAt',
          'createdAt',
          // ⚠️ 定时任务的时刻字段（P2）。分成两类，**别一刀切**：
          // · 这一类是「就是此刻」—— 两个进程不在同一毫秒，抹掉。
          'now', // `GET /tasks` 列表里给前端画倒计时用的「现在」
          'updatedAt', // 每次 upsert 都写成 now
          'lastRunAt', // 试跑 / 发送那一下的时刻
          'sentAt', // `?send=1` 的发送时刻
          // · 这一类**不抹**：`nextRunAt` / `next` / `referenceAt` 都是**推导出来的**时刻，
          //   在固定基准（`?at=`）或稳定表达式下两边必须逐秒相等 —— 那正是要比的东西。
        ].includes(k)
      ) {
        out[k] = v === 0 ? 0 : typeof v === 'number' ? '<ts>' : v;
      }
      // ⚠️ `automation` 曾经整块抹成 `'<automation>'` —— 那时 Rust 还没实现定时自动化，
      // 抹掉是为了让「已知差异」不混进失败里。**P2 落地之后它必须比**：
      // 那一块是前端决定要不要显示自动化入口的唯一依据，而且带着 34 个动作的
      // 完整声明（params / options / visibleWhen / vars），是这一族里最该比的东西。
      //
      // ⚠️ 数组顺序不可比：Go 那边是 `for room := range map`，本来就随机。
      else if (k === 'rooms' && Array.isArray(v)) {
        out[k] = [...v]
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map((r) => normalize(r, port));
      }
      // ⚠️★ 任务列表的**顺序本身是契约的一部分**（页面按收到的顺序渲染，还拿第一条做
      // 默认选中），所以这里**不排序** —— 两边都必须是「插入顺序」。
      // Go 是一个切片，天然如此；Rust 靠 `Store::put_task` 分配的**单调序号**（`seq`）。
      // ⚠️ 别改回「按 name 排序再比」：那等于放弃检查顺序，而顺序正是这里最容易错的东西
      // （Rust 一开始是按 redb 的 key = uuid 遍历，等于**随机顺序**；
      //  后来试的「按 (createdAt, id)」也不够，同一秒内仍靠 uuid 兜底）。
      else if (k === 'tasks' && Array.isArray(v)) {
        out[k] = v.map((t) => normalize(t, port));
      }
      // ⚠️ 任务视图里两个**列表字段的空值形态**刻意不同：Go 是 nil 切片 → `null`，
      // 这边是空 `Vec` → `[]`。这里把 `null` 归一成 `[]` 再比，否则每一条带任务的用例
      // 都会红，而它们想测的根本不是这件事。**这条偏离本身**在下面「刻意偏离」一节
      // 单独断言（连同「入参收得下 null」那一半）。
      // ⚠️ 非空时照常比 —— 归一的是空值形态，不是整个字段。
      else if ((k === 'byWeekday' || k === 'chain') && v === null) out[k] = [];
      // ⚠️ UA 解析是**已知的刻意偏离**：Go 用 uap-core 的正则库、Rust 用关键词匹配，
      // 而且 Rust 那边还把 `"Other "` 的尾随空格 trim 掉了（`docs/HANDOVER.md` §6 有记）。
      // ⚠️ 不抹平的话，`/content` 那一族（条目里带整个 `senderDevice`）会把那条**已经记在案**的
      // 偏离重复报成失败 —— 而失败清单一旦有常驻的假红，整个工具就没人看了。
      else if (k === 'os' || k === 'browser' || k === 'device') out[k] = '<ua>';
      else out[k] = normalize(v, port);
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

/** 把指定字段抹成 `<masked>`。
 *
 * ⚠️ 只用于**本来就不可比**的值（分享令牌里的随机 `jti` → 整个 token 串），
 * 别的字段一律不抹 —— 抹多了就变成「什么都能过」。 */
function applyMask(value, mask) {
  if (mask.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => applyMask(v, mask));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = mask.includes(k) ? '<masked>' : applyMask(v, mask);
    }
    return out;
  }
  return value;
}

/** 递归找出两个已规范化的值**到底哪几个路径不同**。
 *
 * 为什么要它：`/tasks` 的响应里带着 34 个动作的完整声明（几 KB），
 * 而真正不同的往往只有一两个字段 —— 把整坨 JSON 打出来，一屏红字里没人找得到重点。
 * ⚠️ 数组同型差异（`tasks[0].byWeekday` / `tasks[1].byWeekday`）会把下标折成 `[]` 去重，
 * 否则一条失败能刷出几十行。 */
function diffPaths(a, b, path = '', out = []) {
  if (a === undefined && b === undefined) return out;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (!aObj || !bObj) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${path}: Go=${JSON.stringify(a)} Rust=${JSON.stringify(b)}`);
    }
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: 类型不同（Go=${Array.isArray(a) ? 'array' : 'object'}，Rust=${Array.isArray(b) ? 'array' : 'object'}）`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${path}.length: Go=${a.length} Rust=${b.length}`);
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** 同上，但把数组下标折成 `[]` 去重 —— 打印用。 */
function formatDiff(paths, limit = 8) {
  const uniq = [...new Set(paths.map((s) => s.replace(/\[\d+\]/g, '[]')))];
  const shown = uniq.slice(0, limit);
  if (uniq.length > limit) shown.push(`…还有 ${uniq.length - limit} 种差异`);
  return shown;
}

/** 比对两个已经取回来的响应。`mask` 见 [`applyMask`]。 */
function judge(label, g, r, mask = []) {
  const problems = [];
  if (g.status !== r.status) problems.push(`状态码 Go=${g.status} Rust=${r.status}`);
  if (g.parsed !== undefined || r.parsed !== undefined) {
    const gn = applyMask(normalize(g.parsed, GO_PORT), mask);
    const rn = applyMask(normalize(r.parsed, RS_PORT), mask);
    if (canonical(gn) !== canonical(rn)) {
      // ⚠️ 打**差异字段**，不打整坨 JSON —— `/tasks` 的响应里带着 34 个动作声明，
      // 整坨打出来是一屏红字，真正不同的那一两个字段反而找不到。
      problems.push(`JSON 不同：\n    ${formatDiff(diffPaths(gn, rn)).join('\n    ')}`);
    }
  } else if (g.text !== r.text) {
    problems.push(
      `文本不同\n    Go  : ${JSON.stringify(g.text)}\n    Rust: ${JSON.stringify(r.text)}`
    );
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

async function compare(label, method, path, opts = {}, mask = []) {
  const [g, r] = await Promise.all([
    hit(GO_PORT, method, path, opts),
    hit(RS_PORT, method, path, opts),
  ]);
  judge(label, g, r, mask);
}

/** 两边的请求**构造方式不同**时用它（比如各自先换一张令牌，再拿它去续期）。 */
async function compareVia(label, fn, mask = []) {
  const [g, r] = await Promise.all([fn(GO_PORT), fn(RS_PORT)]);
  judge(label, g, r, mask);
}

await waitReady(GO_PORT, goChild);
await waitReady(RS_PORT, rsChild);

// ── 契约数据（`cases/`）在两个仓库之间有没有漂 ──────────────────────────
//
// ⚠️★ 拆库之后 `cases/` 是**两份**，而且**角色不同**：
// · Go 仓库那份 —— Go 自己测试的**校验基准**（非更新模式下它会读回来逐字比，
//   不一致就 `t.Fatalf`「这是一次契约变更」）；
// · 本仓库那份 —— Rust 测试的**冻结输入**（Rust 是对着哪份契约写的）。
//
// 拆库前它们是**同一份文件**，所以「不可能漂」；现在会漂。⚠️ **漂了不一定是坏事**：
// 它意味着 Go 侧的契约变了、Rust 该跟。所以这条检查的作用是**把信号放大**，
// 而不是把差异当成 bug —— 口径与 Go 那边 fixture 测试自己的措辞一致
// （「**这是一次契约变更**，不是测试坏了」）。
//
// ⚠️ 只比 `*.json`：那才是契约数据。`README.md` 是说明文字，两边本来就该各说各的。
console.log('\n=== 契约数据 cases/ 两个仓库一致吗 ===');
{
  const goCases = join(GO_DIR, '..', 'cases');
  const ourCases = join(RUST_DIR, 'cases');
  const collect = (dir, base = '') => {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...collect(join(dir, e.name), rel));
      else if (e.name.endsWith('.json')) out.push(rel);
    }
    return out;
  };
  const goFiles = collect(goCases).sort();
  const ourFiles = collect(ourCases).sort();
  const onlyGo = goFiles.filter((f) => !ourFiles.includes(f));
  const onlyOurs = ourFiles.filter((f) => !goFiles.includes(f));
  const changed = goFiles
    .filter((f) => ourFiles.includes(f))
    .filter((f) => !readFileSync(join(goCases, f)).equals(readFileSync(join(ourCases, f))));

  if (onlyGo.length === 0 && onlyOurs.length === 0 && changed.length === 0) {
    pass++;
    console.log(`  ok   ${goFiles.length} 个契约 JSON 两边逐字节相同`);
  } else {
    fail++;
    const detail = [
      onlyGo.length ? `只有 Go 那边有：${onlyGo.join(', ')}` : '',
      onlyOurs.length ? `只有本仓库有：${onlyOurs.join(', ')}` : '',
      changed.length ? `内容不同（${changed.length} 个）：${changed.join(', ')}` : '',
    ].filter(Boolean);
    failures.push(
      `契约数据 cases/ 两个仓库不一致 —— **这是一次契约变更的信号，不是工具坏了**\n` +
        `  ${detail.join('\n  ')}\n` +
        `  先想清楚是哪边对：如果 Go 的改动是有意的，就把本仓库那份同步过来\n` +
        `  （本仓库不重新生成 fixture，只接收 Go 侧导出的结果）。`
    );
    console.log('  FAIL 契约数据 cases/ 两个仓库不一致（契约变更的信号）');
    for (const d of detail) console.log(`       ${d}`);
  }
}

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
// ⚠️ 显式写 `?room=default`：**不传 room** 的语义我们**故意和 Go 不同**
// （Go = 跨所有房间取全局最新；我们 = default 房间），那条在下面「刻意偏离」一节单独断言。
await compare('GET /content/latest 原文', 'GET', '/content/latest?room=default');
await compare(
  'GET /content/latest?format=json',
  'GET',
  '/content/latest?room=default&format=json'
);
// `?all=1` 是**我们新加的**显式跨房间开关，Go 不认这个参数 ——
// 但 Go 在「不传 room」时本来就是跨房间，所以这条比对的含义是：
// **「我们显式要跨房间，结果和 Go 的隐式跨房间一致」**。能过就说明跨房间实现是对的。
await compare(
  'GET /content/latest?all=1（显式跨房间）',
  'GET',
  '/content/latest?all=1&format=json'
);
// ⚠️ 「只带 `Accept: application/json`」那条**故意和 Go 不同**（Go 给 PostEvent 信封、
// 我们给扁平对象），所以它不在这儿比 —— 在下面的「刻意偏离」一节单独断言。
await compare('GET /content/2 原文', 'GET', '/content/2');
await compare('GET /content/2?format=json', 'GET', '/content/2?format=json');
// ⚠️ `.json` 后缀**已经删了**（2026-09-26），所以这条现在比的是「两边都拒绝它」——
// 名字必须说清楚，否则看着像「后缀还能用」。
await compare('GET /content/2.json（后缀已删，两边都应当拒）', 'GET', '/content/2.json');
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

// ⚠️ `/myip` 那一节已删（2026-09-26）：端点本身删了（它唯一的消费者是聊天模式，已退役），
// 所以「三个来源的优先级」那几条断言也一起没了。

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


// `?name=`（设备名）与 `?client=`（客户端 ID）—— ⚠️ 这两个**改了但一直没验过**。
//
// 它们会进 `senderDevice.name` / `senderClientID`，前端靠它们显示「谁发的」
// 和「这条是不是我自己发的」（气泡归属）。走 WS 广播才能看到 ——
// `/content/<id>?format=json` 那个扁平对象里**不含** senderDevice。
{
  const results = {};
  const body = '带设备名和客户端 ID';
  // 中文设备名要 URL 编码；顺便测一下解码路径。
  const q = '?room=ws-sender&name=%E5%AE%A2%E5%8E%85%E7%9A%84%20Mac&client=abc123';
  for (const [name, port] of [
    ['Go', GO_PORT],
    ['Rust', RS_PORT],
  ]) {
    const collector = wsCollect(port, '/push?room=ws-sender', { ms: 900 });
    await sleep(250);
    await hit(port, 'POST', `/text${q}`, { body });
    const [r] = await Promise.all([collector]);
    results[name] = r;
  }
  compareEvents('senderDevice.name / senderClientID 都带上了', results.Go, results.Rust);
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

// ── 文件过期（fileExpire 的三档） ─────────────────────────────────────

console.log('\n=== 文件过期：fileExpire 的三档 ===');

// ⚠️ 这三档原来**只有 core 的单测**，没有端到端用例 —— 而它是「配错了会丢文件」的地方：
//   `0`   = **永不过期**（不是「立刻过期」！把 0 当成立刻过期会把文件全清光）
//   `>0`  = 秒数
//   `<0`  = 配置写错了，**回退全局** `file.expire`
{
  const rooms = [
    ['never-expire', (e) => e === 0, 'fileExpire:0 → expire 必须是 0'],
    ['negative', (e) => e > 0, 'fileExpire:-5 → 回退全局（>0）'],
  ];

  for (const [room, ok, label] of rooms) {
    const [g, r] = await Promise.all([
      hitForm(GO_PORT, `/upload?room=${room}`, 'x.txt', 'x'),
      hitForm(RS_PORT, `/upload?room=${room}`, 'x.txt', 'x'),
    ]);
    const [gc, rc] = await Promise.all([
      hit(GO_PORT, 'GET', `/content/latest?room=${room}&format=json`),
      hit(RS_PORT, 'GET', `/content/latest?room=${room}&format=json`),
    ]);
    const ge = gc.parsed?.expire;
    const re = rc.parsed?.expire;
    if (g.status === 200 && r.status === 200 && ok(ge) && ok(re) && ge === re) {
      pass++;
      console.log(`  ok   ${label}（expire=${ge}）`);
    } else {
      fail++;
      failures.push(`${label}\n  Go  expire=${ge}  upload=${g.status}\n  Rust expire=${re}  upload=${r.status}`);
      console.log(`  FAIL ${label}`);
      console.log(`       Go  expire=${ge}  Rust expire=${re}`);
    }
  }

  // `fileExpire: 1` → 1 秒后过期。等一下再下，两边都该 404 `file_expired`。
  const [, ] = await Promise.all([
    hitForm(GO_PORT, '/upload?room=short', 'gone.txt', 'gone'),
    hitForm(RS_PORT, '/upload?room=short', 'gone.txt', 'gone'),
  ]);
  const [gu, ru] = await Promise.all([
    hit(GO_PORT, 'GET', '/content/latest?room=short&format=json'),
    hit(RS_PORT, 'GET', '/content/latest?room=short&format=json'),
  ]);
  await sleep(2200);
  const [gd, rd] = await Promise.all([
    hit(GO_PORT, 'GET', `/file/${gu.parsed?.uuid}/gone.txt`),
    hit(RS_PORT, 'GET', `/file/${ru.parsed?.uuid}/gone.txt`),
  ]);
  if (gd.status === 404 && rd.status === 404 && gd.parsed?.code === rd.parsed?.code) {
    pass++;
    console.log(`  ok   过期后下载 → 404 ${gd.parsed?.code}（两边一致）`);
  } else {
    fail++;
    failures.push(
      `过期后下载\n  Go=${gd.status} ${JSON.stringify(gd.parsed)}\n  Rust=${rd.status} ${JSON.stringify(rd.parsed)}`
    );
    console.log('  FAIL 过期后下载');
    console.log(`       Go=${gd.status} ${JSON.stringify(gd.parsed)}`);
    console.log(`       Rust=${rd.status} ${JSON.stringify(rd.parsed)}`);
  }
}

// ── 历史分页（`GET /content`）与 WS 的 `history=0` / `latestId` ─────────
//
// `docs/specs/ws-live-only.md` 的 W0（Go）+ W1（Rust）。两边都实现了才比得了 ——
// 这也是为什么这一段是在 W1 之后才加的。
console.log('\n=== 历史分页 GET /content ===');
{
  const room = 'ws-paging';
  for (let i = 1; i <= 3; i++) {
    // 两边各发一条（同一个脚本对两边发同样的请求，所以 id 序列一致）
    await Promise.all([
      hit(GO_PORT, 'POST', `/text?room=${room}`, { body: `p-${i}` }),
      hit(RS_PORT, 'POST', `/text?room=${room}`, { body: `p-${i}` }),
    ]);
  }

  await compare('GET /content?limit=2（最新 2 条、正序）', 'GET', `/content?room=${room}&limit=2`);
  await compare(
    'GET /content?limit=999999（被 server.history 夹住）',
    'GET',
    `/content?room=${room}&limit=999999`
  );
  await compare('GET /content 空房间 → messages 是 []', 'GET', '/content?room=ws-nobody');
  await compare(
    'GET /content?before=999999（游标失效不报错，退化成最近 limit 条）',
    'GET',
    `/content?room=${room}&before=999999&limit=2`
  );

  // 翻页：拿**各自的** `messages[0].id` 当 before，两边结果必须一致且不重复。
  const [g1, r1] = await Promise.all([
    hit(GO_PORT, 'GET', `/content?room=${room}&limit=2`),
    hit(RS_PORT, 'GET', `/content?room=${room}&limit=2`),
  ]);
  const gPage = await hit(
    GO_PORT,
    'GET',
    `/content?room=${room}&before=${g1.parsed?.messages?.[0]?.id}`
  );
  const rPage = await hit(
    RS_PORT,
    'GET',
    `/content?room=${room}&before=${r1.parsed?.messages?.[0]?.id}`
  );
  const gv = canonical(normalize(gPage.parsed, GO_PORT));
  const rv = canonical(normalize(rPage.parsed, RS_PORT));
  if (gPage.status === rPage.status && gv === rv && gPage.parsed?.messages?.length === 1) {
    pass++;
    console.log(
      `  ok   用 messages[0].id 翻页（拿到更早那 ${gPage.parsed.messages.length} 条、不重复）`
    );
  } else {
    fail++;
    failures.push(`翻页\n  Go  : ${gPage.status} ${gv}\n  Rust: ${rPage.status} ${rv}`);
    console.log('  FAIL 翻页');
    console.log(`       Go  : ${gPage.status} ${gv}`);
    console.log(`       Rust: ${rPage.status} ${rv}`);
  }

  console.log('\n=== WS：history=0 与 config.latestId ===');
  {
    const [g, r] = await Promise.all([
      wsCollect(GO_PORT, `/push?room=${room}`, { ms: 900 }),
      wsCollect(RS_PORT, `/push?room=${room}`, { ms: 900 }),
    ]);
    compareEvents('不带 history → **默认仍然推历史**（老客户端行为不变）', g, r);

    const [g0, r0] = await Promise.all([
      wsCollect(GO_PORT, `/push?room=${room}&history=0`, { ms: 900 }),
      wsCollect(RS_PORT, `/push?room=${room}&history=0`, { ms: 900 }),
    ]);
    compareEvents('history=0 → 不推历史', g0, r0);

    // ⚠️ 两边一致还不够 —— 两边都推了历史也会「一致」。这条钉住**真的没有 receive**。
    const gRecv = g0.messages.filter((m) => m.event === 'receive').length;
    const rRecv = r0.messages.filter((m) => m.event === 'receive').length;
    if (gRecv === 0 && rRecv === 0) {
      pass++;
      console.log('  ok   history=0 时一条 receive 都没有');
    } else {
      fail++;
      failures.push(`history=0 没生效\n  Go=${gRecv} 条 receive，Rust=${rRecv} 条`);
      console.log(`  FAIL history=0 没生效（Go=${gRecv}，Rust=${rRecv}）`);
    }

    // `config.latestId`：两边都要有，且等于**该房间的最大 id**，而且**不在** `/server` 里。
    //
    // ⚠️ 期望值**从响应里推导**，不写死 —— 房间的最大 id 取决于前面所有用例发过多少条，
    // 写死一个数字会在别的用例变动时莫名其妙地红（第一次就是这么错的）。
    const gLatest = g0.messages.find((m) => m.event === 'config')?.data?.latestId;
    const rLatest = r0.messages.find((m) => m.event === 'config')?.data?.latestId;
    const all = await hit(RS_PORT, 'GET', `/content?room=${room}&limit=999999`);
    const expectedLatest = Number(all.parsed?.messages?.at(-1)?.id);
    const notInServer = await Promise.all([
      hit(GO_PORT, 'GET', '/server'),
      hit(RS_PORT, 'GET', '/server'),
    ]);
    if (
      expectedLatest > 0 &&
      gLatest === expectedLatest &&
      rLatest === expectedLatest &&
      !('latestId' in notInServer[0].parsed) &&
      !('latestId' in notInServer[1].parsed)
    ) {
      pass++;
      console.log(
        `  ok   config.latestId = ${gLatest}（= 该房间最大 id），且**不在** /server 里`
      );
    } else {
      fail++;
      failures.push(
        `config.latestId\n  期望=${expectedLatest}  Go=${gLatest}  Rust=${rLatest}`
      );
      console.log(`  FAIL config.latestId（期望 ${expectedLatest}，Go=${gLatest}，Rust=${rLatest}）`);
    }
  }
}

// ── 方法不对 ──────────────────────────────────────────────────────────

console.log('\n=== 方法不对：405 也必须恒 JSON ===');

// ⚠️ axum 内置的 405 是**空 body**，而契约里写着「错误响应恒 `{code,error,message}`」。
// 这组用例就是钉这条 —— 少了它，`GET /text` 会静默变成一个空响应，
// 而 Apple 快捷指令读不到 `error` 字段、只会走进兜底分支。
for (const [label, method, path] of [
  ['GET /text', 'GET', '/text'],
  ['PUT /rooms', 'PUT', '/rooms'],
  ['GET /upload/chunk', 'GET', '/upload/chunk'],
  ['PUT /content/1/column', 'PUT', '/content/1/column'],
]) {
  await compare(`405 ${label}`, method, path, {});
}

// ── P1：会话令牌与分享 ────────────────────────────────────────────────
//
// 这一节验的不只是「形状对不对」，还有一条更强的性质：**两个实现互认对方的令牌**。
// 那条是切换期能不能无缝的关键 —— 配置相同 → 派生出的签名密钥相同 → Go 签的链接
// 在 Rust 上仍然能开，反之亦然。（静态那一半由 cases/share/tokens.json 钉着，
// 这里是活的两个真实进程。）
const jsonPost = (body) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});
// 令牌里的 jti 是随机的 → 整个 token 串、以及内嵌它的三个地址都不可比。
const TOKEN_MASK = ['token', 'jti', 'previewToken', 'url', 'pageUrl', 'rawUrl'];

console.log('\n=== 会话令牌 ===');
await compare('POST /auth/token 空密码', 'POST', '/auth/token?room=locked', jsonPost({ password: '' }));
await compare('POST /auth/token 密码不对', 'POST', '/auth/token?room=locked', jsonPost({ password: 'nope' }));
await compare('POST /auth/token 空 body', 'POST', '/auth/token?room=locked', {});
// ⚠️ 开放房间也不能拿**任意**密码换令牌（`canAccessRoom` 对开放房间恒 true，
// 拿它签发就是个后门）。这条两边都该是 `wrong_password`。
await compare('POST /auth/token 开放房间不认任意密码', 'POST', '/auth/token', jsonPost({ password: 'whatever' }));
await compare('POST /auth/token 房间密码', 'POST', '/auth/token?room=locked', jsonPost({ password: 'pw' }), ['token']);
await compare('POST /auth/token 未知字段', 'POST', '/auth/token?room=locked', jsonPost({ password: 'pw', pwd: 'x' }));
await compare('POST /auth/token/refresh 无凭据', 'POST', '/auth/token/refresh?room=locked', {});
// 令牌各是各的，所以两边各自先换一张再续期 —— 比的是**响应形状**。
await compareVia(
  'POST /auth/token/refresh 保留 scope',
  async (port) => {
    const issued = await hit(port, 'POST', '/auth/token?room=locked', jsonPost({ password: 'pw' }));
    return hit(port, 'POST', '/auth/token/refresh?room=locked', {
      headers: { authorization: `Bearer ${issued.parsed.token}` },
    });
  },
  ['token']
);
await compareVia(
  'POST /auth/token/refresh 房间不匹配',
  async (port) => {
    const issued = await hit(port, 'POST', '/auth/token?room=locked', jsonPost({ password: 'pw' }));
    return hit(port, 'POST', '/auth/token/refresh?room=default', {
      headers: { authorization: `Bearer ${issued.parsed.token}` },
    });
  }
);
// ⚠️★ 这条是 2026-09-25 补的**回归守卫**：Rust 的 `POST /text` 一路没有房间闸门，
// 于是**谁都能往带密码的房间里发消息**。之前的验收脚本用的恰好是正确凭据，
// 双跑比对也没这条 —— 两个验证都恰好绕开了它（「假绿」的教科书案例）。
await compare('POST /text?room=locked 不带凭据（曾漏掉闸门）', 'POST', '/text?room=locked', {
  body: '没凭据就不该发得出去',
});
await compare('POST /text?room=locked 凭据不对', 'POST', '/text?room=locked&auth=错', {
  body: '密码错了也不该发得出去',
});

console.log('\n=== 分享 ===');
// 各自在被保护的房间里发一条被分享的内容（id 两边应当相同，但下面用实际值）。
const sharedId = {};
for (const [name, port] of [
  ['Go', GO_PORT],
  ['Rust', RS_PORT],
]) {
  const sent = await hit(port, 'POST', '/text?room=locked&auth=pw', { body: '被分享的正文' });
  sharedId[name] = sent.parsed?.id;
}
/** 按端口取「那条被分享的内容」在本实例里的 id（两个实例各自从 1 开始，但别假设）。 */
const idFor = (port) => (port === GO_PORT ? sharedId.Go : sharedId.Rust);
await compare('POST /share 缺 type', 'POST', '/share?room=locked&auth=pw', jsonPost({ id: '1' }));
await compare('POST /share 凭据不对', 'POST', '/share?room=locked&auth=错', jsonPost({ type: 'content', id: '1' }));
await compare('POST /share 不支持的 type', 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'nope' }));
await compare('POST /share 缺 id', 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content' }));
await compare('POST /share 非法 id', 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: 'abc' }));
await compare('POST /share 条目不存在', 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: '9999' }));
await compare('POST /share 未知字段', 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: '1', max_uses: 1 }));
await compare('POST /share 正常签发', 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: '1' }), TOKEN_MASK);
await compare(
  'POST /share TTL 与次数被夹',
  'POST',
  '/share?room=locked&auth=pw',
  jsonPost({ type: 'content', id: '1', ttl: 5, maxUses: 99999 }),
  TOKEN_MASK
);
await compare('GET /share 令牌无效', 'GET', '/share?t=不是令牌');
await compare('GET /share 无令牌', 'GET', '/share');
// ⚠️ 上面两条都是**错误分支**。而 `GET /share?t=` 是分享页**唯一**消费的接口，
// 它的成功形状以前一条都没比过 —— 补上。两边各自签一张自己的令牌再来问，比的是形状。
await compareVia('GET /share 成功形状（不限次、无密码）', async (port) => {
  const issued = await hit(
    port,
    'POST',
    '/share?room=locked&auth=pw',
    jsonPost({ type: 'content', id: idFor(port) })
  );
  return hit(port, 'GET', `/share?t=${issued.parsed?.token}`);
});
await compareVia('GET /share 带密码：没带头 → share_password_required', async (port) => {
  const issued = await hit(
    port,
    'POST',
    '/share?room=locked&auth=pw',
    jsonPost({ type: 'content', id: idFor(port), password: 'sec' })
  );
  return hit(port, 'GET', `/share?t=${issued.parsed?.token}`);
});
await compareVia(
  'GET /share 带密码：密码对 → 200（预览令牌两边各自不同，遮掉）',
  async (port) => {
    const issued = await hit(
      port,
      'POST',
      '/share?room=locked&auth=pw',
      jsonPost({ type: 'content', id: idFor(port), password: 'sec' })
    );
    return hit(port, 'GET', `/share?t=${issued.parsed?.token}`, {
      headers: { 'x-share-password': 'sec' },
    });
  },
  ['previewToken', 'previewExpiresAt']
);
await compare('GET /share/list 无凭据（受保护房间）', 'GET', '/share/list?room=locked');
await compare('POST /share/visit 无令牌', 'POST', '/share/visit', jsonPost({}));
await compare('POST /share/visit 令牌无效', 'POST', '/share/visit', jsonPost({ token: '不是令牌' }));

// ★★★ 互验：一方签的令牌，另一方必须认。
//
// 这是整节里最有价值的一条：配置相同 → 派生密钥相同 → 令牌与实现无关。
// 切换期就靠它 —— 用户手里的旧链接在切换后还能开。
for (const [fromName, fromPort, toName, toPort] of [
  ['Go', GO_PORT, 'Rust', RS_PORT],
  ['Rust', RS_PORT, 'Go', GO_PORT],
]) {
  const issued = await hit(fromPort, 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: sharedId[fromName] }));
  const token = issued.parsed?.token;
  const label = `★ ${fromName} 签的分享令牌在 ${toName} 上能用`;
  if (!token) {
    fail++;
    failures.push(`${label}\n  ${fromName} 那边签发失败：${issued.status} ${issued.text}`);
    console.log(`  FAIL ${label}（${fromName} 签发失败）`);
    continue;
  }
  const info = await hit(toPort, 'GET', `/share?t=${token}`, {});
  const body = await hit(toPort, 'GET', `/content/${sharedId[toName]}?room=locked&t=${token}`, {});
  const problems = [];
  if (info.status !== 200) problems.push(`GET /share → ${info.status} ${info.text}`);
  else if (info.parsed?.kind !== 'text' || info.parsed?.room !== 'locked')
    problems.push(`元信息不对: ${JSON.stringify(info.parsed)}`);
  if (body.status !== 200) problems.push(`GET /content → ${body.status} ${body.text}`);
  else if (!body.text.includes('被分享的正文')) problems.push(`正文不对: ${JSON.stringify(body.text)}`);
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

// 分享令牌**不能**当房间凭据用（否则一张只读令牌就能发消息）。
for (const [name, port] of [
  ['Go', GO_PORT],
  ['Rust', RS_PORT],
]) {
  const issued = await hit(port, 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: sharedId[name] }));
  const res = await hit(port, 'POST', `/text?room=locked&t=${issued.parsed.token}`, { body: '我只有只读令牌' });
  if (res.status === 401) {
    pass++;
    console.log(`  ok   ${name}：分享令牌不能发消息（401）`);
  } else {
    fail++;
    failures.push(`${name}：分享令牌居然能发消息 → ${res.status} ${res.text}`);
    console.log(`  FAIL ${name}：分享令牌居然能发消息`);
  }
}

// 限次分享的消耗：两边各用自己的令牌，取两次 + 第三次必须 401。
// ⚠️ 计数是**每个实例各自**的（所以不能拿对面的令牌来测这条）。
await compareVia(
  '限次分享：第 1、2 次能读，第 3 次 401（且 /share 不消耗次数）',
  async (port) => {
    const issued = await hit(port, 'POST', '/share?room=locked&auth=pw', jsonPost({ type: 'content', id: '1', maxUses: 2 }));
    const token = issued.parsed.token;
    const id = issued.parsed.id;
    const read = () => hit(port, 'GET', `/content/${id}?room=locked&t=${token}`);
    const first = await read();
    await hit(port, 'GET', `/share?t=${token}`); // 打开页面不该消耗次数
    const second = await read();
    await hit(port, 'GET', `/share?t=${token}`);
    const third = await read();
    // 只比「第 3 次的状态 + 次数」—— 前两次两边都是 200，比出来没有信息量。
    const info = await hit(port, 'GET', `/share?t=${token}`);
    return {
      status: third.status,
      text: `${JSON.stringify(third.parsed?.code)} used=${info.parsed?.used}`,
    };
  }
);


// ── 定时自动化：/tasks 一族（P2）───────────────────────────────────────
//
// ⚠️ 这一节是 P2 落地之后**补上的**。在此之前 `automation.rs`（958 行）+
// `scheduler.rs`（407 行）**一条都没跟 Go 比过** —— 而这一族里「读代码看不出来」
// 的东西特别多：三层卡口（config → API → UI）、房间来自鉴权上下文而不是请求体、
// single 档为什么要配 task token、`taskView` 里哪些字段该出现、
// `desc` 只在 cron 档出现、试跑的基准是「下次触发时刻」而不是「现在」……
//
// ⚠️ 请求体里**没有 `room`** —— 那是设计（Go 的 `automationTaskRequest` 注释里有论证）：
// 房间来自 `?room=` + 凭据，不接受客户端在任务里声明投递目标。所以下面每条路径都带着它。
//
// ⚠️ **覆盖缺口（有意的）**：`admin` 档没在这儿测。它要求配置里有一个**全局密码**
// （`isGlobalAdmin` 认明文全局密码或它换来的会话令牌），而这份共享配置刻意没有 ——
// 加了全局密码会让 `work` / `ws-bc` 那些房间一起变成受保护房间，
// 前面一百多条用例的**语义**就跟着变了（虽然两边一起变、断言照样绿，但那是假绿）。
// admin 档由 `crates/server/tests/automation_api.rs` 的端到端用例覆盖。
console.log('\n=== 定时自动化：/tasks ===');

/** 各台自己建的任务 id / task token。⚠️ 不能共用：id 是 uuid、token 是随机串。 */
const taskIds = {};
const taskTokens = {};

/** 任务相关响应里**必然不同**的字段：`id` 是服务端生成的 uuid，
 * `taskId` 是它在 run / send / delete 响应里的同一个值。 */
const TASK_MASK = ['id', 'taskId'];

const postTask = (port, body, query) => hit(port, 'POST', `/tasks${query}`, jsonPost(body));

/** 两边各自建一条，再逐字段比对。
 *
 * ⚠️ 不能像别的用例那样「同一个请求发两遍」—— `id` 是服务端生成的 uuid，
 * 两边必然不同，后续的 `/tasks/{id}` 得各用各的。所以这里把 id 取出来存着，
 * 比对时把 `id` 遮掉（`taskToken` 同理：随机串）。 */
async function compareCreate(label, body, query, mask = TASK_MASK) {
  const [g, r] = await Promise.all([
    postTask(GO_PORT, body, query),
    postTask(RS_PORT, body, query),
  ]);
  taskIds[GO_PORT] = g.parsed?.task?.id;
  taskIds[RS_PORT] = r.parsed?.task?.id;
  taskTokens[GO_PORT] = g.parsed?.taskToken;
  taskTokens[RS_PORT] = r.parsed?.taskToken;
  judge(label, g, r, mask);
}

/** 各台拿自己的 id 打同一个路径。 */
const viaId = (port, method, tail, query) =>
  hit(port, method, `/tasks/${taskIds[port]}${tail}${query}`);

// ── 三层卡口的第一层：房间策略 ────────────────────────────────────────
// 不传 room = `default` 房间；它没有密码 → 策略回落成 `none` → 房间里没有自动化能力。
await compare('GET /tasks 默认房间（无密码 → 策略 none）', 'GET', '/tasks');
await compare('GET /tasks?room=locked 不带凭据', 'GET', '/tasks?room=locked');
await compare('GET /tasks?room=no-auto 显式 none', 'GET', '/tasks?room=no-auto');
await compare('GET /tasks?room=locked&auth=错', 'GET', '/tasks?room=locked&auth=错');
// 有密码的房间 → 策略默认 `room`；公开房间显式配 `single` 才开。
await compare('GET /tasks?room=locked&auth=pw', 'GET', '/tasks?room=locked&auth=pw');
await compare('GET /tasks?room=open-auto（single 档）', 'GET', '/tasks?room=open-auto');

// ── 创建 ──────────────────────────────────────────────────────────────
const daily = { name: '值班提醒', freq: 'daily', time: '09:30', template: '今天是 {{date}}' };
await compareCreate('POST /tasks 创建（daily 09:30）', daily, '?room=locked&auth=pw');
// ⚠️ `?at=` 固定基准，让 `referenceAt` / `referenceAt2` 这些可推导的时刻真的可比。
// 用 `Z` 结尾的 RFC3339：`+08:00` 里的 `+` 在 query 里会被解成空格，得再编码一层。
const AT = '2026-09-25T01:30:00Z';
const ATQ = `&at=${encodeURIComponent(AT)}`;

// single 档：公开房间没人可分辨，所以**创建时下发一把 task token**（明文只回一次）。
await compareCreate(
  'POST /tasks?room=open-auto 创建（single 档，应下发 taskToken）',
  { name: '公开房间的任务', freq: 'daily', time: '08:00', template: '早' },
  '?room=open-auto',
  ['id', 'taskId', 'taskToken']
);
if (!taskTokens[GO_PORT] || !taskTokens[RS_PORT]) {
  fail++;
  failures.push('single 档创建没有下发 taskToken（Go/Rust 至少一边没有）');
  console.log('  FAIL single 档创建没有下发 taskToken');
}

// cron 档：`taskView` 里会**多一个 `desc`**（结构化翻译），别的档没有。
await compareCreate(
  'POST /tasks 创建（cron 档，视图里应带 desc）',
  { name: '工作日提醒', freq: 'cron', cron: '0 9 * * 1-5', template: '上班' },
  '?room=locked&auth=pw'
);
// 把 daily 那条换回列表的主位（上面又建了一条 cron，列表里会有两条）。
await compare('GET /tasks?room=locked&auth=pw 列表（两条）', 'GET', '/tasks?room=locked&auth=pw', {}, [
  'id',
]);

// ── 校验失败 ──────────────────────────────────────────────────────────
await compare('POST /tasks 空 name', 'POST', '/tasks?room=locked&auth=pw', jsonPost({ freq: 'daily', time: '09:30' }));
await compare('POST /tasks 非法 freq', 'POST', '/tasks?room=locked&auth=pw', jsonPost({ name: 'x', freq: 'hourly', time: '09:30' }));
await compare('POST /tasks 非法时刻', 'POST', '/tasks?room=locked&auth=pw', jsonPost({ name: 'x', freq: 'daily', time: '25:99' }));
await compare('POST /tasks cron 档缺表达式', 'POST', '/tasks?room=locked&auth=pw', jsonPost({ name: 'x', freq: 'cron' }));
await compare('POST /tasks 请求体不是 JSON', 'POST', '/tasks?room=locked&auth=pw', { body: '不是 json' });
// ⚠️ 房间**不可由请求体声明**：body 里塞一个 `room`，它必须被忽略，
// 落下来仍是鉴权上下文那个房间（否则一条已授权的任务就能把消息发到别的房间）。
await compareCreate(
  'POST /tasks body 里塞 room 必须被忽略',
  { ...daily, room: 'work' },
  '?room=locked&auth=pw'
);

// ── item 端点 ─────────────────────────────────────────────────────────
await compareVia(
  'POST /tasks/{id}/run 试跑（固定基准）',
  (port) => viaId(port, 'POST', '/run', `?room=locked&auth=pw${ATQ}`),
  TASK_MASK
);
// ⚠️ `?at=` 是 `docs/api.md` §8.7 写明的参数，**两种写法都要认**（RFC3339 与日期 token）。
// 认不出时必须 400 —— 悄悄回落到「下次触发时刻」会让用户以为预览的正是他要的那个基准。
await compareVia(
  'POST /tasks/{id}/run 试跑（?at= 用日期 token 写法）',
  (port) =>
    viaId(port, 'POST', '/run', `?room=locked&auth=pw&at=${encodeURIComponent('2026-09-25 09:30')}`),
  TASK_MASK
);
await compareVia(
  'POST /tasks/{id}/run 试跑（?at= 认不出 → 400 invalid_reference）',
  (port) =>
    viaId(port, 'POST', '/run', `?room=locked&auth=pw&at=${encodeURIComponent('不是时刻')}`),
  TASK_MASK
);
await compareVia(
  'POST /tasks/{id}/toggle 翻转（不带参数 = 切一下）',
  (port) => viaId(port, 'POST', '/toggle', '?room=locked&auth=pw'),
  TASK_MASK
);
await compareVia(
  'POST /tasks/{id}/toggle?enabled=1 显式设值',
  (port) => viaId(port, 'POST', '/toggle', '?room=locked&auth=pw&enabled=1'),
  TASK_MASK
);
await compareVia(
  'POST /tasks/{id}/run?send=1 立即发送',
  (port) => viaId(port, 'POST', '/run', '?room=locked&auth=pw&send=1'),
  TASK_MASK
);
await compareVia(
  'GET /tasks/{id} → 405（只认 DELETE / run / toggle）',
  (port) => viaId(port, 'GET', '', '?room=locked&auth=pw')
);
await compare('DELETE /tasks/9999 不存在', 'DELETE', '/tasks/9999?room=locked&auth=pw');
await compare('POST /tasks/9999/run 不存在', 'POST', '/tasks/9999/run?room=locked&auth=pw');
// ⚠️ 认不出的动作：Go 那边 `splitTaskPath` 把最后一段当动作，**先按 id 找任务**，
// 找不到就是 404 `task_not_found` —— 不是 405。这条顺手钉住「`/tasks/*` 下的错误恒 JSON」：
// 没有 `/tasks/{id}/{action}` 这条路由时，它会落到静态资源兜底（一份 HTML、状态码 200）。
await compare('POST /tasks/abc/whatever 任务不存在 → 404', 'POST', '/tasks/abc/whatever?room=locked&auth=pw');
await compare('PUT /tasks 方法不对 → 405', 'PUT', '/tasks?room=locked&auth=pw');

// ── 试算一条**还没保存**的任务（不落盘、无副作用）────────────────────
await compare('POST /tasks/preview 试算', 'POST', `/tasks/preview?room=locked&auth=pw${ATQ}`, jsonPost(daily));
await compare('POST /tasks/preview 非法任务', 'POST', '/tasks/preview?room=locked&auth=pw', jsonPost({ name: 'x' }));
// ⚠️ preview 也只认 POST，`?at=` 同样认不出就 400。
await compare('GET /tasks/preview → 405', 'GET', '/tasks/preview?room=locked&auth=pw');
await compare(
  'POST /tasks/preview（?at= 认不出 → 400 invalid_reference）',
  'POST',
  `/tasks/preview?room=locked&auth=pw&at=${encodeURIComponent('不是时刻')}`,
  jsonPost(daily)
);

// ── cron 表达式校验器 ─────────────────────────────────────────────────
// ⚠️ 返回的是 **200 + valid:false**，不是 400：这个接口的用途就是校验，
// 「表达式不合法」是它的正常输出之一（前端每次输入都会调它）。
const cronQ = (expr, tz) =>
  `/tasks/cron?expr=${encodeURIComponent(expr)}` + (tz ? `&tz=${encodeURIComponent(tz)}` : '');
// ⚠️ 用**不贴着当下**的表达式：`* * * * *` 那种会让 `next` 在两次请求之间跨秒，
// 变成一条随机红的用例（两边都对，只是算的时刻不同）。
await compare('GET /tasks/cron 合法（工作日 9 点）', 'GET', `${cronQ('0 9 * * 1-5')}&room=locked&auth=pw`);
await compare('GET /tasks/cron 需要归一化（多余空格）', 'GET', `${cronQ('0  9  *  *  *')}&room=locked&auth=pw`);
await compare('GET /tasks/cron 语法不合法', 'GET', `${cronQ('0 9 * *')}&room=locked&auth=pw`);
await compare('GET /tasks/cron 语法合法但永远等不到', 'GET', `${cronQ('0 0 30 2 *')}&room=locked&auth=pw`);
await compare('GET /tasks/cron 不认识的时区', 'GET', `${cronQ('0 9 * * *', 'Not/AZone')}&room=locked&auth=pw`);
await compare('GET /tasks/cron 显式时区', 'GET', `${cronQ('0 9 * * *', 'Asia/Shanghai')}&room=locked&auth=pw`);
await compare('POST /tasks/cron 也认（Go 侧显式允许）', 'POST', `${cronQ('30 4 1 * *')}&room=locked&auth=pw`);

// ── 有任务的房间清单 ──────────────────────────────────────────────────
// ⚠️ 非管理员只拿到**自己那个房间** —— 把「别的房间有没有装自动化」告诉他，
// 等于泄露房间名的存在性。所以这里只该出现 `locked` 一条。
await compare('GET /tasks/rooms 非管理员只见自己那个房间', 'GET', '/tasks/rooms?room=locked&auth=pw');
// ⚠️★ 刻意偏离：房间没开自动化时的 **文案**。
// Go 在 `/tasks` 上用长句、在 `/tasks/{id}` 子树（`/tasks/rooms` 走的就是那条）上用短句 ——
// 同一个语义两句话，是它两个 handler 分头写的副产品。这里统一用**长句**：它告诉了用户
// 怎么修（「需要该房间的凭据，或由管理员在 roomAuth 里设置 automation」），短句只说「不行」。
// 管理页会把 `message` 直接显示给用户，所以这条偏离是**看得见**的。
// 遮掉 `message` 之后仍然比状态码与 `code` —— 契约的那一半照旧钉着。
await compare('GET /tasks/rooms 无权限的房间（message 刻意不同）', 'GET', '/tasks/rooms?room=no-auto', {}, [
  'message',
]);

// ── 删除 ──────────────────────────────────────────────────────────────
await compareVia(
  'DELETE /tasks/{id} 真的删',
  (port) => viaId(port, 'DELETE', '', '?room=locked&auth=pw'),
  TASK_MASK
);
await compareVia(
  'DELETE 之后再看同一条',
  (port) => viaId(port, 'DELETE', '', '?room=locked&auth=pw'),
  TASK_MASK
);
await compare('GET /tasks?room=locked&auth=pw 删完只剩一条', 'GET', '/tasks?room=locked&auth=pw', {}, TASK_MASK);

// ── once 档：`runAt` 归一化 ────────────────────────────────────────────
// ⚠️ 这条同时钉住**零偏移的写法**：喂进去一个带 `Z` 的时刻，`runAt` 落下来必须是
// `...Z` 而不是 `...+00:00`。Go 的 `time.RFC3339` 对零偏移输出 `Z`，而 chrono 的
// `to_rfc3339()` 输出 `+00:00` —— 2026-09-25 就是这条用例把它抓出来的
// （带 `+08:00` 的时刻两边一样，所以只有基准恰好是 UTC 时才现形）。
await compareCreate(
  'POST /tasks 创建（once 档，runAt 归一化成 RFC3339）',
  { name: '一次性提醒', freq: 'once', runAt: '2026-12-31T16:00:00Z', template: '跨年' },
  '?room=locked&auth=pw'
);

// ── 三个 camelCase 字段名（写错会被**静默忽略**）────────────────────────
// ⚠️★ `byWeekday` / `runAt` / `keepHistory` 都是**多词**的 camelCase。请求体里把名字
// 写成 snake_case（`by_weekday`）不会报错 —— serde 只是「没看到这个字段」，
// 于是症状分别变成「设了周几却报『每周需要至少选一天』」「设了 runAt 却报
// 『仅一次需要 runAt』」「`keepHistory: true` 被吞掉、消息不进历史」。
// 2026-09-25 就是这一组把 Rust 请求体漏 `rename` 的问题抓出来的（读代码看不出来）。
await compareCreate(
  'POST /tasks 创建（weekly + byWeekday）',
  {
    name: '每周例会',
    freq: 'weekly',
    time: '10:00',
    byWeekday: [1, 3, 5],
    template: '例会',
  },
  '?room=locked&auth=pw'
);
await compareCreate(
  'POST /tasks 创建（keepHistory: true 必须被认下）',
  {
    name: '留档提醒',
    freq: 'daily',
    time: '11:00',
    template: '留档',
    keepHistory: true,
  },
  '?room=locked&auth=pw'
);

// ── 定时自动化的管理页（`/automation`）──────────────────────────────────
//
// ⚠️★ 这一页分**两层**验，因为「逐字节比正文」在这里**做不到**，而原因是可查的：
//
// · **文件层**（谁负责：`crates/server/tests/automation_page.rs` 的
//   `page_matches_go_byte_for_byte`）：Rust 的 `automation_page.html` 与 Go 的
//   `cloud-clip/lib/automation_page.html` **逐字节相同**。这一层把页面里的一切
//   （文案表 / 四份 i18n / 动作标签 / 内联脚本 / CSS 注释）都钉住了 ——
//   等价于把 Go 那七条静态检查（`TestAutomationPageMessagesCoverActionKeys` 那一族）
//   整体搬过来，而且更严格。
//
// · **服务层**（就是这一节）：比状态码、响应头、以及**我们真正生成的那一段**
//   （`window.__CC__ = { … }` 的注入行，含 JS 字符串转义）。正文其余部分来自那个文件，
//   文件层已经钉住了。
//
// ⚠️ 为什么不逐字节比正文：Go 的 `html/template` 会把 **CSS / HTML 注释整个吃掉**
// （源文件 1927 行 → 服务出来 1894 行，少 14KB）。那是它模板引擎的副作用，不是谁设计的行为。
// 要在这边对上，就得复刻它的上下文解析（**只在 CSS/HTML 上下文里剔注释，JS 里的 `/* */` 不动**）
// —— 那正是 `CONTRIBUTING.md` §6 点名的「靠人肉同步的第二份定义」，而且是最坏的一种：
// 一个手写的 HTML/CSS/JS 上下文解析器。
// **所以这边刻意保留注释**（`view-source` 里能看到「为什么这条 CSS 要这么写」），
// 代价是正文与 Go 不逐字节相同。
console.log('\n=== 定时自动化：管理页 /automation ===');

/** 取出页面里那行注入。两边都必须有，且**逐字节相同**。 */
function injectionOf(html) {
  const m = html.match(/window\.__CC__ = \{[^}]*\};/);
  return m ? m[0] : null;
}

async function comparePage(label, path) {
  const [g, r] = await Promise.all([hit(GO_PORT, 'GET', path), hit(RS_PORT, 'GET', path)]);
  const problems = [];
  if (g.status !== r.status) problems.push(`状态码 Go=${g.status} Rust=${r.status}`);
  const gi = injectionOf(g.text);
  const ri = injectionOf(r.text);
  if (gi === null || ri === null) {
    problems.push(`有一边取不到 __CC__ 注入行（Go=${gi}，Rust=${ri}）`);
  } else if (gi !== ri) {
    problems.push(`__CC__ 注入行不同\n    Go  : ${gi}\n    Rust: ${ri}`);
  }
  // ⚠️ 正文长度**只作为信息**打出来，不算失败 —— 见上面那段论证。
  if (problems.length === 0) {
    pass++;
    console.log(`  ok   ${label}  [${ri}]  （正文 ${r.text.length} 字符 / Go ${g.text.length}）`);
  } else {
    fail++;
    failures.push(`${label}\n  ${problems.join('\n  ')}`);
    console.log(`  FAIL ${label}`);
    for (const p of problems) console.log(`       ${p}`);
  }
}

await comparePage('GET /automation 不传 room', '/automation');
await comparePage('GET /automation?room=work', '/automation?room=work');
await comparePage('GET /automation?room= 空值→default', '/automation?room=');
await comparePage('GET /automation 中文房间名', `/automation?room=${encodeURIComponent('值班室')}`);
// ⚠️ 这一格是「不转义就是 XSS」的最小复现：`/`、`<`、`>`、`"`、`'`、`&`、`+`、`\`、`` ` ``
// 全在 Go 的转义表里，而 `=`、`%`、空格**不在**。多转一个少转一个都会红。
await comparePage(
  'GET /automation 需要转义的房间名',
  `/automation?room=${encodeURIComponent('a<b>"c\'d&e=f\\g+h`i/j')}`
);
await comparePage(
  'GET /automation 控制字符与 DEL',
  `/automation?room=${encodeURIComponent('a\u0001b\u007fc\td')}`
);
await comparePage(
  'GET /automation U+2028 / emoji',
  `/automation?room=${encodeURIComponent('a\u2028b🎉c')}`
);

// 响应头也是契约的一部分：少了 `no-store` 会让管理页被缓存（页面里内联着凭据逻辑），
// 少了 `X-Robots-Tag` 会让它被搜索引擎收录。
{
  const [g, r] = await Promise.all([
    hit(GO_PORT, 'GET', '/automation'),
    hit(RS_PORT, 'GET', '/automation'),
  ]);
  const pick = (h) =>
    ['content-type', 'cache-control', 'x-robots-tag'].map((k) => `${k}=${h[k]}`).join(' | ');
  const gs = pick(g.headers);
  const rs = pick(r.headers);
  if (gs === rs) {
    pass++;
    console.log(`  ok   /automation 响应头  [${rs}]`);
  } else {
    fail++;
    failures.push(`/automation 响应头不同\n  Go  : ${gs}\n  Rust: ${rs}`);
    console.log(`  FAIL /automation 响应头不同\n       Go  : ${gs}\n       Rust: ${rs}`);
  }
}

// ── 刻意偏离 Go 的地方 ────────────────────────────────────────────────
//
// ⚠️ 这一节**故意**和 Go 不一样。Jonny 2026-09-25 拍板：
// 「revoke 不用考虑老客户端，按最佳实践来」。
// 所以它不能拿 Go 当基准，只能**直接断言我们自己的行为**。
console.log('\n=== 刻意偏离 Go（按最佳实践，直接断言我们的行为） ===');

// ⚠️★ 刻意偏离：`byWeekday` / `chain` 的**空值形态**。
//
// Go 那边这两个字段是 nil 切片，序列化出来是 `null`；这边是空 `Vec`，给 `[]`。
// 取 `[]` 的理由：一个「列表」字段的空值就该是空列表 —— `null` 把「没有这一项」与
// 「一项都没有」混成一种写法，客户端每次用之前都得先判空。而现有客户端（管理页）
// 本来就带着 `(task.byWeekday || [])` / `(task && task.chain)` 这类守卫，两种都吃得下 ——
// 属于「只影响响应形状、客户端两边都吃得下」那一档，按 CONTRIBUTING §0 的规则 Rust 可以领先。
//
// ⚠️ 反过来，**入参侧收下 `null`**（`core::task` 的 `null_as_default`）：一个照 Go 写的
// 客户端把读到的任务原样回传时不会 400。这里顺手把那一半也测了。
{
  const body = { name: '形状探针', freq: 'daily', time: '07:00', template: 'x' };
  const created = await hit(
    RS_PORT,
    'POST',
    '/tasks?room=locked&auth=pw',
    jsonPost({ ...body, byWeekday: null, chain: null })
  );
  const t = created.parsed?.task;
  if (created.status === 200 && Array.isArray(t?.byWeekday) && Array.isArray(t?.chain)) {
    pass++;
    console.log('  ok   任务视图里 byWeekday / chain 是 []（Go 给 null）；且入参的 null 也收得下');
  } else {
    fail++;
    failures.push(
      `任务视图的空列表形状不对：期望 byWeekday=[] chain=[] 且能读入 null → ` +
        `${created.status} ${JSON.stringify(t?.byWeekday)}/${JSON.stringify(t?.chain)}`
    );
    console.log(`  FAIL 任务视图的空列表形状不对 → ${created.status}`);
  }
  // 顺手演示 Go 的行为（**不是在测 Go**，是给读者看两边差在哪）。
  const goCreated = await hit(GO_PORT, 'POST', '/tasks?room=locked&auth=pw', jsonPost(body));
  console.log(
    `  ·  Go 同一时刻给的是 byWeekday=${JSON.stringify(goCreated.parsed?.task?.byWeekday)}` +
      ` chain=${JSON.stringify(goCreated.parsed?.task?.chain)}`
  );
}

/** 只打一台服务器，直接断言。 */
async function expectOn(label, port, method, path, check, opts = {}) {
  const r = await hit(port, method, path, opts);
  if (check(r)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(`${label}\n  Rust: ${r.status} ${JSON.stringify(r.parsed)}`);
    console.log(`  FAIL ${label}`);
    console.log(`       Rust: ${r.status} ${JSON.stringify(r.parsed)}`);
  }
}

// ⚠️★ 分享令牌**只放行读**。Go 那边 `handleContentColumn` 也走 `canAccessContent`，
// 所以一张只读的分享令牌在 Go 上**能挪列**（而 `docs/api.md` 写的是「分享令牌不行」
// —— 文档和实现本来就对不上）。写操作只认房间凭据是按最佳实践收的，
// 所以这两条不能拿 Go 当基准，直接断言我们自己的行为。
//
// ⚠️ 必须用**真的**分享令牌。以前这里传的是 `t=不是令牌`，那等价于「没带凭据」——
// 于是「有效的分享令牌也不能挪列」这件事压根没被测到，而这条断言的**名字说的正是它**。
// 这是 HANDOVER §4 专门在防的那类假绿，只是这次发生在验证手段自己身上。
{
  const issued = await hit(
    RS_PORT,
    'POST',
    '/share?room=locked&auth=pw',
    jsonPost({ type: 'content', id: sharedId.Rust })
  );
  const columnToken = issued.parsed?.token;
  if (!columnToken) {
    fail++;
    failures.push(
      `分享令牌不能挪列（写操作只认房间凭据）\n  签发分享就失败了，这条测不了：${issued.status} ${issued.text}`
    );
    console.log('  FAIL 分享令牌不能挪列（签发分享失败，这条测不了）');
  } else {
    await expectOn(
      '分享令牌不能挪列（写操作只认房间凭据）',
      RS_PORT,
      'POST',
      // ⚠️ 必须拿**受保护房间**里的那条：default 房间是开放的，本来就不需要凭据，
      // 那时「没被拒绝」说明不了任何事。
      `/content/${sharedId.Rust}/column?room=locked&t=${columnToken}`,
      (r) => r.status === 401,
      { body: JSON.stringify({ column: 'doing' }), headers: { 'content-type': 'application/json' } }
    );
  }
}

// ── 刻意偏离：限次分享「刚签发」时就有 `used: 0` ────────────────────────
//
// Go 的用量在**进程内的 map** 里，而且条目要到第一次真正读取时才建（`validateShareToken`）——
// 所以「刚签发、还没人读过」时它的 `GET /share` **没有** `used` 字段。
// Rust 的用量跟分享记录一起落在 redb 里，签发那一刻就有事实可报 → 给 `used: 0`。
//
// 这属于「只影响响应形状、现有客户端两边都吃得下」那一档（读到 0 和读不到都是「还没用过」），
// 按 CONTRIBUTING §6 的规则 Rust 可以领先契约，⚠️ 但 **Worker 侧要跟着对齐**
// （记在 HANDOVER §6.1 的待办里）。这条偏离是补比对脚本时才发现的 —— 在此之前它是**无意识**的。
{
  const rsIssued = await hit(
    RS_PORT,
    'POST',
    '/share?room=locked&auth=pw',
    jsonPost({ type: 'content', id: idFor(RS_PORT), maxUses: 3 })
  );
  const rsInfo = await hit(RS_PORT, 'GET', `/share?t=${rsIssued.parsed?.token}`);
  if (rsInfo.parsed?.used === 0) {
    pass++;
    console.log('  ok   限次分享刚签发：Rust 给 used=0（用量落盘，签发即有事实）');
  } else {
    fail++;
    failures.push(
      `限次分享刚签发时 Rust 应该给 used=0 → ${JSON.stringify(rsInfo.parsed)}`
    );
    console.log(`  FAIL 限次分享刚签发时 Rust 应该给 used=0 → ${JSON.stringify(rsInfo.parsed)}`);
  }

  // 顺手演示 Go 的行为（**不是在测 Go**，是给读者看两边差在哪）。
  const goIssued = await hit(
    GO_PORT,
    'POST',
    '/share?room=locked&auth=pw',
    jsonPost({ type: 'content', id: idFor(GO_PORT), maxUses: 3 })
  );
  const goInfo = await hit(GO_PORT, 'GET', `/share?t=${goIssued.parsed?.token}`);
  console.log(
    `  ·  Go 同一时刻的响应里${'used' in (goInfo.parsed ?? {}) ? `有 used=${goInfo.parsed.used}` : '**没有** used 字段'}` +
      '（用量在进程内 map 里，第一次读取才建条目）'
  );
}

// ⚠️ 刻意偏离：`/automation` **只认 GET**。
// Go 的 `handleAutomationPage` 压根没看 `r.Method` —— POST 也会照渲染一份 200 的页面出来。
// 按 `/revoke/*` 那次的口径（Jonny 2026-09-25：「不用考虑老客户端，按最佳实践来」），
// 这里收紧成 GET-only，其余回 405 且恒 JSON。
await expectOn(
  'POST /automation → 405（Go 会照渲染一份页面）',
  RS_PORT,
  'POST',
  '/automation',
  (r) => r.status === 405 && r.parsed?.code === 'method_not_allowed'
);
{
  const goPost = await hit(GO_PORT, 'POST', '/automation');
  console.log(
    `  ·  Go 的 POST /automation → ${goPost.status}（${goPost.text.length} 字节，照渲染了一份页面）`
  );
}

await expectOn(
  'POST /text?room=locked 不带凭据 → 401（曾漏掉闸门）',
  RS_PORT,
  'POST',
  '/text?room=locked',
  (r) => r.status === 401 && r.parsed?.code === 'unauthorized',
  { body: '没凭据就不该发得出去' }
);

// 破坏性操作必须是**显式的 POST**，GET 一律 405。
await expectOn('GET /revoke/<id> → 405', RS_PORT, 'GET', '/revoke/1', (r) => {
  return r.status === 405 && r.parsed?.code === 'method_not_allowed';
});
await expectOn('GET /revoke/all → 405', RS_PORT, 'GET', '/revoke/all?room=ws-bc', (r) => {
  return r.status === 405;
});

// `/content/latest` 的 JSON 形状**统一了**：不管用 `?format=json` 还是只带 `Accept`，
// 都给同一个扁平对象。Go 那边是两种形状（显式给扁平对象、Accept 给 PostEvent 信封）。
// 顺带修掉一个洞：Go 在「文件条目 + 只带 Accept」时会掉进非 JSON 分支 → 404。
await expectOn(
  'GET /content/latest 只带 Accept → 也是扁平对象（不再是 PostEvent 信封）',
  RS_PORT,
  'GET',
  // ⚠️ 必须**指定房间**：不指定就是「跨房间取全局最新」，而上面刚传的那个
  // `fileExpire: 1` 的文件已经过期了 → 会拿到 404，测的东西就变了。
  '/content/latest?room=never-expire',
  (r) => r.status === 200 && typeof r.parsed?.type === 'string' && !('event' in r.parsed),
  { headers: { accept: 'application/json' } }
);

// `senderDevice.os` / `.browser` 认不出来时是 `"Other"`（**没有**尾随空格），
// Go 那边是 `"Other "`，而前端直接把这个串显示出来。
//
// ⚠️ 这条**只在下面报一句**，不写成断言：`expectOn` 走的是 `hit`（fetch），
// 拿不到「服务端收到的那个 UA」的确定性结果 —— 写个恒真的断言比不写更糟
// （假绿会让人以为测过了）。真实形状在 `user_agent.rs` 的单测里钉着。
// 「不传 room」= **default 房间**（Go 是跨所有房间取全局最新）。
//
// ⚠️ 响应体里**没有 room 字段**，所以光看一条响应分不出它来自哪个房间。
// 用一个标记来分辨：在 `work` 房间发一条**最新的**，然后
// · 不传 room → 必须**不是**它（那是 default 房间的）
// · `?all=1`  → 必须是它
{
  const marker = `跨房间标记 ${Date.now()}`;
  await hit(RS_PORT, 'POST', '/text?room=work', { body: marker });
  const plain = await hit(RS_PORT, 'GET', '/content/latest?format=json');
  const all = await hit(RS_PORT, 'GET', '/content/latest?all=1&format=json');

  if (plain.parsed?.content !== marker && all.parsed?.content === marker) {
    pass++;
    console.log('  ok   不传 room → default 房间；?all=1 → 跨房间（拿到 work 的那条）');
  } else {
    fail++;
    failures.push(
      `不传 room / ?all=1 的语义不对\n` +
        `  不传 room 拿到: ${JSON.stringify(plain.parsed?.content)}\n` +
        `  ?all=1 拿到:   ${JSON.stringify(all.parsed?.content)}\n` +
        `  标记应该是:    ${JSON.stringify(marker)}`
    );
    console.log('  FAIL 不传 room / ?all=1 的语义不对');
    console.log(`       不传 room: ${JSON.stringify(plain.parsed?.content)}`);
    console.log(`       ?all=1:   ${JSON.stringify(all.parsed?.content)}`);
  }
}

console.log(
  '  KNOWN senderDevice 的 os/browser：认不出来时是 "Other"（**无尾随空格**）' +
    '，Go 是 "Other "。前端直接显示这个串 —— 这条偏离是刻意的'
);

// 顺手演示一下 Go 的行为 —— **不是在测 Go**，是给读者看「为什么必须改」：
// Go 那边任何方法都会真的执行撤销，浏览器直接访问 `/revoke/1` 就删掉了 1 号条目。
// （放在最后跑，免得影响前面那些用例。）
{
  const before = await hit(GO_PORT, 'GET', '/content/1?format=json');
  const goGet = await hit(GO_PORT, 'GET', '/revoke/1');
  const after = await hit(GO_PORT, 'GET', '/content/1?format=json');
  console.log(
    `  ·  Go 的 GET /revoke/1 → ${goGet.status}：删之前 ${before.status}，删之后 ${after.status}` +
      `（${before.status === 200 && after.status === 404 ? '真的删了' : '没删'}）`
  );
}

console.log(
  '  KNOWN 多标签页：同一设备开两个标签页时，**关掉其中一个不会让设备显示离线**' +
    '（按连接登记，只有最后一条连接断开才广播 disconnect）。' +
    'Go 那边按 deviceID 删，关一个标签页就会误报离线 —— 这条偏离是刻意的'
);

// ── 已知的、刻意的差异 ────────────────────────────────────────────────
console.log('\n=== 已知差异（刻意，不算失败） ===');
// ⚠️ `automation` **不在**这一节了。它以前在这儿，写着「Rust enabled=false —— P0 未实现」，
// 而那句话在 P2 落地后就成了**假绿**：两边的差异其实来自**默认值不同**
// （Go 的 `defaultConfig()` 是 `true`，Rust 的 `AutomationConfig::default()` 曾写成 `false`），
// 不是「没实现」。配置里现在显式写了 `automation.enabled`，整块能力声明进入正常比对 ——
// 它要是不同，上面就会是一条 FAIL，而不是这儿的一行 KNOWN。
const rSrv = (await hit(RS_PORT, 'GET', '/server')).parsed;
console.log(
  `  ·  /server 的 automation 已进入正常比对：` +
    `enabled=${rSrv.automation.enabled}、带 ${rSrv.automation.actions?.length ?? 0} 个动作声明、` +
    `${rSrv.automation.vars?.length ?? 0} 个模板变量`
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
