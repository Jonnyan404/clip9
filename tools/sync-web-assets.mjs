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
import { dirname, join, resolve } from 'node:path';
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
  { label: 'web', dir: FE, skip: ['node_modules', 'dist', '.vite', 'public/shortcuts', 'config.json'] },
  { label: 'shortcuts', dir: join(ROOT, 'shortcuts'), skip: [] },
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const source = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(FE, 'dist'));

/** 目录下的所有文件（相对路径，`/` 分隔）。
 *  ⚠️ 跳过 `.DS_Store`（macOS 的资源分支，编进二进制只会让比对变吵）与 `skip` 里的路径前缀。 */
function files(dir, skip = []) {
  const out = [];
  const stack = ['.'];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(join(dir, current), { withFileTypes: true })) {
      const rel = current === '.' ? entry.name : `${current}/${entry.name}`;
      if (entry.name === '.DS_Store') continue;
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
  for (const { label, dir, skip } of SOURCES) {
    if (!existsSync(dir)) continue;
    for (const rel of files(dir, skip)) {
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

function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  const body = readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (body.length === 0 || !body[0].startsWith('source ')) return null;
  return { source: body[0].slice('source '.length).trim(), files: body.slice(1) };
}

// ─────────────────────────── 只比对 ───────────────────────────

if (checkOnly) {
  if (!existsSync(DEST)) {
    missing(`${DEST} 不存在 —— 跑一次 node tools/sync-web-assets.mjs`);
  }
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
cpSync(source, DEST, { recursive: true });

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
