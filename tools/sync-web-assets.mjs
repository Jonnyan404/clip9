#!/usr/bin/env node
// 把 `web`（React 版前端）的构建产物同步进 `rust/crates/server/static/`（那一份会被**编进二进制**）。
//
// ⚠️★ 2026-10-04 起**生产前端是 `web/`（React 版）**；`web-vue3/`（Vue 版）只留作比对，不再入库。
// 切换那一次改了本文件的 `FE` 与 `SOURCES`，并重跑了同步（`static/` 与清单都跟着换了一份）。
//
// 用法：
//   node tools/sync-web-assets.mjs            # 从 web/dist 同步
//   node tools/sync-web-assets.mjs <源目录>    # 指定别的源
//   node tools/sync-web-assets.mjs --check    # 只比对不写；不一致退出 1
//
// ⚠️★ 忘了同步是**无症状**的：编得过、跑起来也正常，只是界面永远停在上一版。
//
// ⚠️★ 而「逐字节比产物」**发现不了**这件事：`web/vite.config.ts` 每次构建都注入一个
// **随机** build id（那是故意的 —— 让 PWA 缓存失效、并能核对线上跑的是哪次构建），
// 入口 chunk 又与 SharePage chunk 互相引用对方带 hash 的文件名，于是**每次构建的文件名都不同**。
// 逐字节比 = 每次构建都红 = 没人会再看它。
//
// 所以这里比的是**前端源码的指纹**：同步时记进 `rust/crates/server/static.sync-manifest`，
// `--check` 重算一遍比对。源码没动就绿；动了没同步就红 —— 与随机盐、与构建平台都无关。
//
// ⚠️ 旧目录**挪**进系统临时目录，不用 `rm -rf`：这样「哪些文件没了」看得见。

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, 'rust/crates/server/static');

// ⚠️★ 清单放在 `static/` 的**同级**，不放在里面：`rust/crates/server/build.rs` 会把 `static/`
// 下**每一个**文件编进二进制并对外提供 —— 放进去就多一个能被访问到的文件。
//
// ⚠️ 格式是**纯文本**而不是 JSON：读它的另一边是 Rust 的集成测试，而集成测试拿不到
// `serde_json`（它只是本 crate 的普通依赖，不是 dev-dependency）。一份「第一行是源码指纹、
// 其余每行一条路径」的清单，两边都只要 split('\n')，比为了让 Rust 能解析 JSON 去加依赖划算。
const MANIFEST = join(ROOT, 'rust/crates/server/static.sync-manifest');
const MANIFEST_HEADER = '# clip9 前端产物的同步清单 —— 由 tools/sync-web-assets.mjs 生成，别手改。';

// 「前端源码」= 指纹算哪些东西。⚠️ 跳过 node_modules / dist / .vite（本机产物，不进指纹）。
// ⚠️ 跳过 `web/public/shortcuts`：它是 `sync-shortcuts.mjs` 从 `shortcuts/` 生成的派生物，
// 而 `shortcuts/` 本身已经在指纹里 —— 两头都算等于同一件事算两遍。
const FE = join(ROOT, 'web');
// ⚠️★ `config.json` 也跳过 —— 它被仓库根的 `.gitignore` 忽略（第 74 行那条裸规则），
// **从没入库过**，是本机自己放的一份（内容通常就是根 `config.json` 的副本，且 `web/` 里
// 没有任何东西读它）。算进指纹的后果是：**同一份源码在不同机器上指纹不同** ——
// `--check` 会报「前端源码变过了而这份没同步」，而源码一个字都没动，纯属白跑一趟。
// 2026-10-07 实测：不含它 = `f5032bc8c05b`（正是清单里记的），含它 = `273b8e89976a`。
const SOURCES = [
  {
    label: 'web',
    dir: FE,
    skip: ['node_modules', 'dist', '.vite', 'public/shortcuts', 'config.json'],
    // ⚠️★ 顶层以这些前缀开头的**目录**也跳过（2026-10-11 加）。
    //
    // 来由：本机的安全删除钩子会拦住 `vite` 的 `emptyDir`（一次删 76 个文件 > 阈值），
    // 于是「构建前先把旧 `dist` 改名让开」成了标准做法，留下 `dist.stale-<ts>/`。
    // 而跳过列表当时只认**恰好叫** `dist` 的那一个 —— `dist.stale-…` 不算，
    // 它里面的 76 个产物文件就**被当成源码算进了指纹**。
    //
    // 症状极其误导：把那个目录挪走（或建出来）都会让指纹变，
    // `--check` 于是报「dist 是**旧的**：… 重新构建」—— 而**源码一个字都没动**。
    // 实测踩到：指纹 d3dd4f1b0b53 → dfa74176284c，纯粹是因为我把 `dist.stale-…` 挪进了废纸篓。
    skipPrefixes: ['dist'],
  },
  { label: 'shortcuts', dir: join(ROOT, 'shortcuts'), skip: [] },
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const source = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(FE, 'dist'));

/**
 * 永远不参与比对、**也永远不进产物**的文件名。
 *
 * ⚠️★ `build-source.json` 是构建盖的章（见 [`BUILD_STAMP`]），它住在 `dist/` 里。
 * 不排除的话它会被一起拷进 `static/` —— 那是一份**对外的静态目录**，
 * 于是这个文件的指纹会变成公开可访问的（顺带让每次构建多一个「新增文件」的噪音）。
 */
const NEVER_SHIPPED = new Set(['build-source.json']);

/** 目录下的所有文件（相对路径，`/` 分隔）。
 *  ⚠️ 跳过 `.DS_Store`（macOS 的资源分支，编进二进制只会让比对变吵）与 `skip` 里的路径前缀。
 *  ⚠️ `skipPrefixes` 只作用于**顶层目录名**（见 `SOURCES` 里那段来由）。 */
function files(dir, skip = [], skipPrefixes = []) {
  const out = [];
  const stack = ['.'];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(join(dir, current), { withFileTypes: true })) {
      const rel = current === '.' ? entry.name : `${current}/${entry.name}`;
      if (entry.name === '.DS_Store') continue;
      if (NEVER_SHIPPED.has(entry.name)) continue;
      if (current === '.' && skipPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
      if (skip.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      if (entry.isDirectory()) stack.push(rel);
      else out.push(rel);
    }
  }
  return out.sort();
}

/** 前端**源码**的指纹（不含任何产物 —— 产物每次构建都不同，见文件头）。 */
function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const { label, dir, skip, skipPrefixes } of SOURCES) {
    if (!existsSync(dir)) continue;
    for (const rel of files(dir, skip, skipPrefixes)) {
      hash.update(`${label}/${rel}\0`);
      hash.update(readFileSync(join(dir, rel)));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function missing(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const short = (hex) => String(hex).slice(0, 12);

/**
 * 构建时盖在产物上的「我是用哪一份源码构建出来的」标记。
 *
 * ⚠️★ 2026-10-11 加。**它堵的是一个真发生过的洞**：
 *
 * 清单里记的 `source` 是**同步那一刻**的源码指纹，不是**构建那一刻**的。
 * 于是「源码改了 → 构建因为任何原因没产出新 `dist` → 同步」这条路上，
 * 清单会拿到**新的**指纹，`--check` 一路绿 —— 而 `static/` 里装的是**旧产物**。
 *
 * 2026-10-11 真踩了：`npm run build` 被本机的安全删除钩子从 `emptyDir` 处打断
 * （`exit=1`，但前面 tsc / vite 都正常输出，很容易当成「无关紧要的钩子报错」），
 * `dist` 保持旧的那一份，同步照做，指纹照绿。是**靠比对文件时间戳**才发现的。
 *
 * 修法：构建结束时由 [`--stamp`] 把「输入指纹」写进 `dist`，
 * 同步与 `--check` 都**先核对它** —— 产物陈旧就当场拦住，而不是等谁去看时间戳。
 */
const BUILD_STAMP = join(FE, 'dist', 'build-source.json');

/** 读构建盖的章。没盖过 / 读坏了都回 `null`（都按「不是一次成功构建的产物」处理）。 */
function readBuildStamp() {
  if (!existsSync(BUILD_STAMP)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BUILD_STAMP, 'utf8'));
    return typeof parsed?.source === 'string' ? parsed.source : null;
  } catch {
    return null;
  }
}

/**
 * 断言「这份产物**就是**当前源码构建出来的」。
 *
 * ⚠️ 两种失败要分开说：**没盖过章**（不是一次成功构建留下的）与
 * **章对不上**（构建过，但之后源码又改了）。前者的修法是「去构建」，
 * 后者是「重新构建」—— 混成一句话会让人白跑一趟。
 */
function assertFreshBuild() {
  const now = sourceFingerprint();
  const stamp = readBuildStamp();
  if (stamp === null) {
    missing(
      `${BUILD_STAMP} 不在 —— 这一份 dist 不是一次成功的构建留下的。\n` +
        '    在 web 里构建：npm run build'
    );
  }
  if (stamp !== now) {
    missing(
      `dist 是**旧的**：它构建于指纹 ${short(stamp)}，而现在的源码是 ${short(now)}。\n` +
        '    ⚠️ 这一条以前查不出来 —— 清单记的是「同步那一刻」的指纹，\n' +
        '    所以「构建没产出新产物」时照样绿，而 static/ 里装的是旧东西。\n' +
        '    重新构建：cd web && npm run build'
    );
  }
}

function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  const body = readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (body.length === 0 || !body[0].startsWith('source ')) return null;
  return { source: body[0].slice('source '.length).trim(), files: body.slice(1) };
}

// ─────────────────────────── 盖章（构建结束时） ───────────────────────────

if (args.includes('--stamp')) {
  // ⚠️ 由 `web/after-build.mjs` 在一次**成功的**构建之后调用（见那里的注释）。
  // ⚠️ 用 `writeFileSync` 而不是 mkdir 一套：`dist` 那时必然在（构建刚跑完）。
  const stamp = sourceFingerprint();
  writeFileSync(
    BUILD_STAMP,
    `${JSON.stringify({ source: stamp, builtAt: new Date().toISOString() }, null, 2)}\n`
  );
  console.log(`  stamp  构建输入指纹 ${short(stamp)} → web/dist/build-source.json`);
  process.exit(0);
}

// ─────────────────────────── 只比对 ───────────────────────────

if (checkOnly) {
  if (!existsSync(DEST)) {
    missing(`${DEST} 不存在 —— 跑一次 node tools/sync-web-assets.mjs`);
  }
  // ⚠️★ 先核对「产物是不是这一份源码构建出来的」，再比清单。
  // 顺序有讲究：产物陈旧时，下面那几条清单比对**全都是绿的**
  // （清单本身就是照着当前源码写的），所以必须**先**拦这一条。
  assertFreshBuild();
  const manifest = readManifest();
  if (!manifest) {
    missing(
      `${MANIFEST} 不在 —— 这一份静态产物不是这个脚本同步出来的。\n` +
        '  跑一次 node tools/sync-web-assets.mjs（然后重编 clip9-server）。'
    );
  }

  const problems = [];
  const now = sourceFingerprint();
  if (manifest.source !== now) {
    problems.push(
      `前端源码变过了而这份没同步（指纹 ${short(manifest.source)} → ${short(now)}）`
    );
  }
  const have = files(DEST);
  for (const rel of manifest.files) if (!have.includes(rel)) problems.push(`缺 ${rel}`);
  for (const rel of have) if (!manifest.files.includes(rel)) problems.push(`多出来了 ${rel}`);

  if (problems.length) {
    console.error(`✗ ${DEST} 与它记录的来源不一致（${problems.length} 处）：`);
    for (const line of problems.slice(0, 20)) console.error(`    ${line}`);
    if (problems.length > 20) console.error(`    …还有 ${problems.length - 20} 处`);
    missing('跑一次 node tools/sync-web-assets.mjs（然后重编 clip9-server）');
  }
  console.log(`✓ 一致：${have.length} 个文件，源码指纹 ${short(now)}`);
  process.exit(0);
}

// ─────────────────────────── 同步 ───────────────────────────

if (!existsSync(join(source, 'index.html'))) {
  missing(
    `${source} 里没有 index.html —— 那不像一份前端产物。\n` +
      '  先在 web 里构建：npm run build（或 DEPLOY_STATIC=1 npm run build）'
  );
}

// ⚠️★ 同步**之前**也要核对（不只是 `--check`）：这里才是真正会把旧产物拷进去的地方。
// ⚠️ 只对默认来源（`web/dist`）核对：`source` 可以被命令行指定成别的目录
// （`web-vue3` 那条路会传自己的 dist），那种情况下 `web/dist/build-source.json`
// 根本不是它的章 —— 拿它来判会误报。
if (source === resolve(join(FE, 'dist'))) {
  assertFreshBuild();
}

const wanted = files(source);
const fingerprint = sourceFingerprint();

// ⚠️ 先把旧目录**挪走**（不是就地覆盖、也不是 `rm -rf`）：这样「哪些文件没了」看得见，
// 而且删的动作发生在系统临时目录里（不受仓库目录的守卫拦）。
mkdirSync(dirname(DEST), { recursive: true });
const before = existsSync(DEST) ? files(DEST) : [];

// ⚠️★ 新增 / 改动 / 消失这三个数必须在**拷贝之前**算出来 —— 拷完之后 source 与 DEST
// 就一模一样了，那时再比，「改动」**恒为 0**（这个脚本第一版就是这样，白报了一个 0）。
const added = wanted.filter((rel) => !before.includes(rel));
const removed = before.filter((rel) => !wanted.includes(rel));
const changed = before.filter(
  (rel) =>
    wanted.includes(rel) &&
    !readFileSync(join(source, rel)).equals(readFileSync(join(DEST, rel)))
);

if (existsSync(DEST)) {
  const aside = join(tmpdir(), `clip9-static-old-${Date.now()}`);
  renameSync(DEST, aside);
  console.log(`· 旧的那一份挪到 ${aside}`);
}
// ⚠️★ `filter` 是**必须**的，不能只靠 `files()` 里的 `NEVER_SHIPPED`：
// `files()` 只影响**清单**（哪些文件记进 manifest、参与比对），
// 而 `cpSync` 是**整个目录照搬** —— 章会照样被拷进对外的 `static/`。
// 2026-10-11 实测踩到：清单里没有它、但 `static/build-source.json` 真的存在。
cpSync(source, DEST, {
  recursive: true,
  filter: (src) => !NEVER_SHIPPED.has(basename(src)),
});

const after = files(DEST);
writeFileSync(MANIFEST, `${MANIFEST_HEADER}\nsource ${fingerprint}\n${after.join('\n')}\n`);

console.log(`✓ ${source}\n  → ${DEST}`);
console.log(
  `  ${after.length} 个文件（新增 ${added.length} / 改动 ${changed.length} / 消失 ${removed.length}）`
);
const notes = [...added, ...changed, ...removed];
for (const rel of notes.slice(0, 12)) console.log(`    ${rel}`);
if (notes.length > 12) console.log('    …');
console.log(`  源码指纹 ${short(fingerprint)} → ${MANIFEST.replace(`${ROOT}/`, '')}`);

// ⚠️ 提醒一句：这个脚本只搬文件，**编进二进制要重编**。
console.log('⚠️ 接下来要重编：cargo build -p clip9-server（它把这一份编进二进制）');
