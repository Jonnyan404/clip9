#!/usr/bin/env node
// 把 `web-vue3` 的构建产物同步进 `crates/server/static/`（那一份会被**编进二进制**）。
//
// 用法：
//   node tools/sync-web-assets.mjs                 # 从 ../web-vue3/dist 同步进来
//   node tools/sync-web-assets.mjs <源目录>         # 指定别的源
//   node tools/sync-web-assets.mjs --check         # 只比对，不写；不一致就退出码 1
//
// # 为什么需要它
//
// 正式构建用的是**编进二进制的这一份**（`crates/server/build.rs`），而前端改完只落在
// `web-vue3/dist` 里 —— 要显式跑一次这个脚本（再重编）才会过去。
//
// ⚠️★ 「忘了同步」是**无症状**的：构建完全成功（`static/index.html` 还在，只是旧的）、
// 跑起来也正常，只有界面永远停在上一版。用户看到的现象是「界面里根本没有这个功能」，
// 而代码明明写好了 —— Go 那边为同一件事专门留了一条测试（`TestEmbeddedSpaCarriesAutomationEntry`）。
//
// ⚠️ 这里**只负责搬文件**。牙在 `crates/server/tests/static_files.rs` 里：
//   * `the_shipped_copy_matches_the_front_end_build` —— 与 `web-vue3/dist` **逐字节**比；
//   * `the_embedded_copy_is_a_real_front_end` —— 那份产物得真的是一份前端（不是空壳）。
// 也就是说这个脚本是**方便**，不是**保证**：不跑它也能被 `cargo test` 拦住。
//
// ⚠️ 拷之前把旧目录**移到系统临时目录**（不是 `rm -rf`）：见仓库约定
//（`~/.workbuddy/MEMORY.md`：临时文件一律 mv 挪走）。顺带的好处是 ——
// 挪走而不是就地覆盖，能给出「哪些文件不见了」这份报告。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, 'crates/server/static');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const source = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(ROOT, '../web-vue3/dist'));

/** 目录下的所有文件（相对路径，`/` 分隔）。⚠️ 跳过 `.DS_Store`：那是 macOS 的资源分支，
 *  编进二进制只会让「表里有、目录里没有」这类比对变得吵。 */
function files(dir) {
  const out = [];
  const stack = ['.'];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(join(dir, current), { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const rel = current === '.' ? entry.name : `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(rel);
      else out.push(rel);
    }
  }
  return out.sort();
}

function missing(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, 'index.html'))) {
  missing(
    `${source} 里没有 index.html —— 那不像一份前端产物。\n` +
      '  先在 web-vue3 里构建：npm run build（或 DEPLOY_STATIC=1 npm run build）',
  );
}

const wanted = files(source);

if (checkOnly) {
  if (!existsSync(DEST)) missing(`${DEST} 不存在 —— 跑一次 node tools/sync-web-assets.mjs`);
  const have = files(DEST);
  const problems = [];
  for (const rel of wanted) {
    if (!have.includes(rel)) problems.push(`缺 ${rel}`);
    else if (!readFileSync(join(source, rel)).equals(readFileSync(join(DEST, rel)))) {
      problems.push(`内容不一致 ${rel}`);
    }
  }
  for (const rel of have) if (!wanted.includes(rel)) problems.push(`多出来了 ${rel}`);
  if (problems.length) {
    console.error(`✗ ${DEST} 与 ${source} 不一致（${problems.length} 处）：`);
    for (const line of problems.slice(0, 20)) console.error(`    ${line}`);
    if (problems.length > 20) console.error(`    …还有 ${problems.length - 20} 处`);
    missing('跑一次 node tools/sync-web-assets.mjs（然后重编 clip9-server）');
  }
  console.log(`✓ 一致：${wanted.length} 个文件（${source}）`);
  process.exit(0);
}

// ⚠️ 先把旧目录**挪走**（不是就地覆盖、也不是 `rm -rf`）：这样「哪些文件没了」看得见，
// 而且删的动作发生在系统临时目录里（不受仓库目录的守卫拦）。
mkdirSync(dirname(DEST), { recursive: true });
const before = existsSync(DEST) ? files(DEST) : [];
if (existsSync(DEST)) {
  const aside = join(tmpdir(), `clip9-static-old-${Date.now()}`);
  renameSync(DEST, aside);
  console.log(`· 旧的那一份挪到 ${aside}`);
}
cpSync(source, DEST, { recursive: true });

const after = files(DEST);
const changed = wanted.filter((rel) => {
  if (!before.includes(rel)) return false; // 新增的不算「改动」，下面分开报
  return !readFileSync(join(source, rel)).equals(readFileSync(join(DEST, rel)));
});
const added = wanted.filter((rel) => !before.includes(rel));
const removed = before.filter((rel) => !wanted.includes(rel));

console.log(`✓ ${source}\n  → ${DEST}`);
console.log(
  `  ${after.length} 个文件（新增 ${added.length} / 改动 ${changed.length} / 消失 ${removed.length}）`,
);
for (const rel of [...added, ...removed].slice(0, 12)) console.log(`    ${rel}`);
if (added.length + removed.length > 12) console.log('    …');

// ⚠️ 提醒一句：这个脚本只搬文件，**编进二进制要重编**。
console.log('⚠️ 接下来要重编：cargo build -p clip9-server（它把这一份编进二进制）');
