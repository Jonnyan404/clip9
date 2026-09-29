#!/usr/bin/env node
// 从 `CHANGELOG.md` 里抽出**某一版**那一段，当作 GitHub Release 的正文。
//
// 为什么要有它：正文原先是「建 Release 时手贴」的一步纯人工动作，2026-09-29 就漏过一次
// （`v0.1.0` 的正文是空的 —— 而 GitHub 在正文为空时会拿 **tag 指向那条提交的提交信息**
// 整段顶上去，提交信息又是英文的（`tools/check-commit-msg.mjs` 强制），于是页面上是一段
// 英文 commit message）。Jonny 问「以后发版 release 会是中文介绍吗」→ 会的**前提**是
// 正文有地方自动来，而「发布前必须写这一版的说明」这件事本来就有硬约束
// （见 `CHANGELOG.md` 抬头：tag 指向的提交要能在本文件里查到自己）——
// 所以**说明的唯一来源就是 CHANGELOG**，Release 正文从它抽，少一个人工环节。
//
// 用法：
//   node tools/release-notes.mjs --tag v0.1.0                    # 打到 stdout
//   node tools/release-notes.mjs --tag v0.1.0 --changelog /tmp/fake.md   # 换一份夹具（判据用）
//
// ⚠️★ 抽不到、或者抽到的还是**占位**（「变动留空」/「待发布」那种）→ **报错退出**，
//    一个字都不往 stdout 写。这正是把「回填」这个漏点变成硬错误的那一下：宁可在发布那一步
//    红，也不要让 Release 页面上挂着一句「（变动留空）」。
//
// ⚠️ 输出**不含那条 `## <版本>` 标题行** —— Release 页面上本来就显示版本名，再渲染一个
//    一级标题只是重复；日期也在页面上（发布时间）。正文里 `###` 那种子标题照留。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? '') : fallback;
};

const tag = argOf('--tag').trim();
const changelog = argOf('--changelog', join(ROOT, 'CHANGELOG.md'));

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (!tag) die('没给 --tag —— 要抽哪一版？（形如 `--tag v0.1.0`）');

let text;
try {
  text = readFileSync(changelog, 'utf8');
} catch {
  die(`读不到 ${changelog}`);
}

const lines = text.split('\n');

/**
 * 这一版标题那一行的正则。
 *
 * ⚠️★ tag 里的 `.` 是正则元字符 → 必须转义，否则 `v0.1.0` 会连 `v0x1y0` 都匹配上。
 * ⚠️★ 尾巴那个否定断言是必须的：没有它，`v0.1.0` 会把 **`v0.1.0-beta1`** 那一版也认成
 * 自己（预发布那三条正好排在它上面），于是抽出来的是 beta 的说明。
 */
const heading = new RegExp(`^##\\s+${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);

const start = lines.findIndex((line) => heading.test(line));
if (start < 0) {
  const have = lines.filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
  die(
    `CHANGELOG 里没有 ${tag} 这一版` +
      (have.length ? `（现有的是：${have.join(' / ')}）` : '（里面一条 `## ` 标题都没有？）'),
  );
}

// 到**下一条 `## `** 为止。⚠️ `###` 不算 —— 那是正文里的子标题（「### 新增」那种）。
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join('\n').trim();
// ⚠️ 占位检测要**连标题行一起看**：那条空记录把「（待发布）」写在标题里，
//    正文里又写着「变动留空」—— 只看正文会漏掉前者。
const whole = [lines[start], ...lines.slice(start + 1, end)].join('\n');

if (!body) die(`${tag} 那一段是空的（只有标题、没有正文）`);

const placeholder = /变动留空|待发布|（待写）|待补/;
if (placeholder.test(whole)) {
  const hit = placeholder.exec(whole)[0];
  die(
    `${tag} 那一段还是**占位**（出现了「${hit}」）—— 说明这一版的正文还没写。\n` +
      `  发版前先把 CHANGELOG.md 顶上那一条补全，再打 tag（见 .github/RELEASE_TEMPLATE.md）。`,
  );
}

console.error(`从 ${changelog} 抽出 ${tag} 那一段（${body.split('\n').length} 行）`);
console.log(body);
