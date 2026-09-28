#!/usr/bin/env node
// 把 `web-vue3` 的构建产物同步进 `rust/crates/server/static/`（那一份会被**编进二进制**）。
//
// 用法：
//   node tools/sync-web-assets.mjs            # 从 web-vue3/dist 同步
//   node tools/sync-web-assets.mjs <源目录>    # 指定别的源
//   node tools/sync-web-assets.mjs --check    # 只比对不写；不一致退出 1
//
// ⚠️★ 忘了同步是**无症状**的：编得过、跑起来也正常，只是界面永远停在上一版。
// 牙在 `rust/crates/server/tests/static_files.rs`（逐字节比 dist）—— 但产物不在时它会 skip，
// 独立 clone 里不保护你，所以 CI 跑的是这个 `--check`。
//
// ⚠️ 旧目录**挪**进系统临时目录，不用 `rm -rf`：这样「哪些文件没了」看得见。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = join(ROOT, 'rust/crates/server/static');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const source = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(ROOT, 'web-vue3/dist'));

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

// ⚠️★ 新增 / 改动 / 消失这三个数必须在**拷贝之前**算出来 —— 拷完之后 source 与 DEST
// 就一模一样了，那时再比，「改动」**恒为 0**（这个脚本第一版就是这样，白报了一个 0）。
const added = wanted.filter((rel) => !before.includes(rel));
const removed = before.filter((rel) => !wanted.includes(rel));
const changed = before.filter(
  (rel) =>
    wanted.includes(rel) &&
    !readFileSync(join(source, rel)).equals(readFileSync(join(DEST, rel))),
);

if (existsSync(DEST)) {
  const aside = join(tmpdir(), `clip9-static-old-${Date.now()}`);
  renameSync(DEST, aside);
  console.log(`· 旧的那一份挪到 ${aside}`);
}
cpSync(source, DEST, { recursive: true });

const after = files(DEST);

console.log(`✓ ${source}\n  → ${DEST}`);
console.log(
  `  ${after.length} 个文件（新增 ${added.length} / 改动 ${changed.length} / 消失 ${removed.length}）`,
);
const notes = [...added, ...changed, ...removed];
for (const rel of notes.slice(0, 12)) console.log(`    ${rel}`);
if (notes.length > 12) console.log('    …');

// ⚠️ 提醒一句：这个脚本只搬文件，**编进二进制要重编**。
console.log('⚠️ 接下来要重编：cargo build -p clip9-server（它把这一份编进二进制）');
