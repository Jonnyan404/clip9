#!/usr/bin/env node
// 提交信息门禁。约定见 `dev-docs/CONTRIBUTING.md` §8。
//
// 三种用法：
//   node tools/check-commit-msg.mjs .git/COMMIT_EDITMSG   # 当 commit-msg 钩子用
//   node tools/check-commit-msg.mjs --last                # 查最新那一条
//   git log -1 --format=%B | node tools/check-commit-msg.mjs
//
// ⚠️ 为什么要有它：约定早就写在 CONTRIBUTING §8 里了，而**违反它不会让任何东西变红** ——
// P0 有 11 条提交的正文是中文（其中一条连主题也是），还有两条正文里留着 heredoc 的 `EOF2`
// 和一行重复标题，直到 2026-09-25 审计才被发现。
// 规则只是「不许做」的时候没人守得住；变成一条命令能跑出红字，才守得住。
//
// ⚠️ 它**只管提交信息**，不碰代码风格 —— 注释和文档仍然是中文（CONTRIBUTING §5），
// 「注释中文、提交英文」是有意的分工。

import { readFileSync } from 'node:fs';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60]/;
const SUBJECT = /^(feat|fix|refactor|perf|test|docs|style|chore|build|ci|revert)(\([^)]+\))?!?: \S/;
// `^(fix|feat|...): ` 又一出现，几乎总是「heredoc 没收干净」（实测两例都是这么来的）。
const SECOND_SUBJECT = /^(feat|fix|refactor|perf|test|docs|style|chore|build|ci|revert)(\([^)]+\))?!?: /;

function readMessage() {
  const args = process.argv.slice(2);
  if (args[0] === '--last') {
    return readFileSync('.git/COMMIT_EDITMSG', 'utf8'); // 与钩子同源，够用；真要看历史用 git log
  }
  if (args[0] && args[0] !== '-') {
    return readFileSync(args[0], 'utf8');
  }
  return readFileSync(0, 'utf8');
}

const raw = readMessage();
const problems = [];
const suggestions = [];

// 注释行（`#`）和 `git commit --verbose` 带进来的 diff 都不算数。
const lines = raw
  .split('\n')
  .filter((line) => !line.startsWith('#'))
  .map((line) => line.replace(/\s+$/, ''));
const body = lines.join('\n').trim();
const nonEmpty = body.split('\n').filter((line) => line.trim() !== '');
const subject = nonEmpty[0] ?? '';
// ⚠️ 合并提交的默认信息（`Merge branch 'x' into y`）不走 conventional 那一套 ——
// 它由 git 自己生成，人写不了。装成钩子以后这条豁免是必须的，否则每次合并都被拦。
const isMerge = /^Merge /.test(subject);

if (subject === '') {
  problems.push('提交信息是空的。');
} else {
  if (!isMerge && !SUBJECT.test(subject)) {
    problems.push(
      `主题不是英文 conventional commit 形式：${JSON.stringify(subject)}\n` +
        '    期望 `type(scope): 英文描述`，type 取 feat/fix/refactor/perf/test/docs/style/chore/build。'
    );
  }
  if (CJK.test(subject)) {
    problems.push(`主题里有中文：${JSON.stringify(subject)}`);
  }
  if (CJK.test(nonEmpty.slice(1).join('\n'))) {
    const hit = nonEmpty.slice(1).find((line) => CJK.test(line));
    problems.push(
      `正文里有中文（约定是**主题和正文都英文**）：${JSON.stringify(hit)}\n` +
        '    中文的「为什么」写进代码注释（CONTRIBUTING §5），提交信息只留英文摘要。'
    );
  }
  const stray = nonEmpty.findIndex((line) => /^EOF\d*$/.test(line.trim()));
  if (stray >= 0) {
    problems.push(
      `正文里有一行 \`${nonEmpty[stray].trim()}\` —— heredoc 收尾没收干净（实测过两次）。`
    );
  }
  if (nonEmpty.length > 1 && nonEmpty.slice(1).some((line) => SECOND_SUBJECT.test(line))) {
    suggestions.push(
      '正文里又出现了一行「type: 描述」—— 确认不是复制粘贴留下的第二份主题。'
    );
  }
}

if (suggestions.length) {
  for (const s of suggestions) console.log(`  ⚠️  ${s}`);
}

if (problems.length) {
  console.error('提交信息不合格（CONTRIBUTING §8）：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\n原信息：\n${body.split('\n').map((l) => `  | ${l}`).join('\n')}`);
  process.exit(1);
}

console.log('提交信息 OK（英文 conventional commit）。');
