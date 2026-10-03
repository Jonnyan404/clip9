#!/usr/bin/env node
// 判据：入库的 `*.md` 里，**相对链接指向的文件真的存在**。
//
// ── 为什么要它 ────────────────────────────────────────────────────────────────
//
// 文档的「改一半」和代码的「改一半」不一样：代码改一半有一堆东西会红，文档改一半**什么都没发生**
// —— 直到有人照着它点，点到一个 404。2026-10-03 全仓扫了一遍：**3 个死链，全在
// `cloudflare/README.md`**（它住在 `cloudflare/` 里，链接却写成 `cloudflare/workers/…`，
// 于是解析成了 `cloudflare/cloudflare/workers/…`）。
// 同一天把两个组件 README 拆成「用户文档 + `DEVELOPING.md`」时，这类链接是**最容易漏改**的一处
// —— 文件改名之后，散在代码注释里的 `见 X §N` 没人会去搜（那种指针这条判据管不了，
// 只能靠改的人自己 grep，见文件末尾）。
//
// ── 它只管什么 ────────────────────────────────────────────────────────────────
//
//   · **只认 markdown 链接**（`[文字](路径)`）。裸写在反引号里的路径不认 ——
//     `dev-docs/…` 这类**刻意不入库**的路径大量出现在正文里，认进去就是一堆假红。
//   · 跳过 http(s) / `#锚点` / `mailto:`。
//   · 跳过代码块里的内容（那里会出现 `[…](…)` 形状的**示例**，不是真链接）。
//   · 相对路径按**该文件所在目录**解析（这正是 cloudflare 那三个错的成因）。
//
// ── 反向检查（不失败）─────────────────────────────────────────────────────────
//
//   · 一个 `*.md` 都没扫到 → **失败**（参考物不在时报绿是这个仓库最不想要的那种绿）。
//   · 一个链接都没有 → 只提示。可能真的是一份纯文字文档，不该因此判红。
//
// ── 夹具（变异验证用）─────────────────────────────────────────────────────────
//
//   node tools/docs-links-smoke.mjs --root <另一棵树>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let ROOT = resolve(HERE, '..');
const rootFlag = argv.indexOf('--root');
if (rootFlag >= 0) {
  if (!argv[rootFlag + 1]) {
    console.error('✗ --root 后面要跟一个路径');
    process.exit(2);
  }
  ROOT = resolve(argv[rootFlag + 1]);
}

const failures = [];
const notes = [];
let okCount = 0;
const fail = (label, detail) => failures.push({ label, detail });
const ok = (label) => {
  okCount += 1;
  console.log(`✓ ${label}`);
};

/** 入库的 `*.md`。⚠️ 用 `git ls-files` 而不是遍历目录：`node_modules` / `dist` / `target` 里
 *  那些第三方 md 不归我们管（它们自己的死链不该让我们红）。 */
function trackedMarkdown() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '*.md'], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    return null;
  }
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** 去掉围栏代码块 —— 里面的 `[…](…)` 是示例。 */
const stripFences = (text) => text.replace(/```[\s\S]*?```/g, '');

function checkFile(rel) {
  const path = join(ROOT, rel);
  const raw = readFileSync(path, 'utf8');
  const text = stripFences(raw);
  // ⚠️ 行号要按**剥掉围栏之前**的行数找，所以按行扫原文、只跳过处于围栏内的行。
  const inFence = [];
  let fenced = false;
  for (const line of raw.split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    inFence.push(fenced || line.trimStart().startsWith('```'));
  }

  let links = 0;
  raw.split('\n').forEach((line, i) => {
    if (inFence[i]) return;
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(line)) !== null) {
      const target = m[1];
      if (/^(https?:|#|mailto:)/.test(target)) continue;
      links += 1;
      const resolved = resolve(dirname(path), target.split('#')[0]);
      if (!existsSync(resolved)) {
        fail(
          `${rel}:${i + 1} 链接指向的文件不存在`,
          `[${target}] 解析到 ${resolved}\n    ${line.trim()}`,
        );
      }
    }
  });
  return links;
}

const files = trackedMarkdown();
if (files === null) {
  fail('参考物：能列出仓库里的 markdown', `在 ${ROOT} 里跑不了 git ls-files（不是 git 仓库？）`);
} else if (files.length === 0) {
  fail('参考物：仓库里有 markdown', '一个 *.md 都没扫到 —— 目录改名或 ls-files 失效时会走到这里，不能报绿');
} else {
  let total = 0;
  for (const rel of files) {
    try {
      total += checkFile(rel);
    } catch (err) {
      fail(`读不了 ${rel}`, String(err));
    }
  }
  ok(`${files.length} 份 markdown、${total} 个相对链接，逐个核对目标存在`);
  if (total === 0) notes.push('一个相对链接都没有 —— 这条判据现在没在检查任何东西，确认一下是不是路径写错了');
}

// ── 输出 ────────────────────────────────────────────────────────────────────

if (notes.length) {
  console.log('\n提示（不失败）：');
  for (const n of notes) console.log(`· ${n}`);
}
if (failures.length) {
  console.log('');
  for (const { label, detail } of failures) console.error(`✗ ${label}\n    ${detail}`);
  console.error(`\n✗ ${failures.length} 条判据没过。`);
  process.exit(1);
}
console.log(`\n✓ markdown 链接自检通过（${okCount} 条判据）。`);
console.log('');
console.log('⚠️ 这条判据**不管**「见 X.md §N」那种**章节指针** —— 文件改名它看得出来，');
console.log('   章节重排它看不出来。改了文档结构就自己 grep 一遍 `见 .*README.*§`。');
