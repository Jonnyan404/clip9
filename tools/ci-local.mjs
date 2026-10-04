#!/usr/bin/env node
// 本机照 `.github/workflows/ci.yml` 跑一遍 —— 一条命令跑完 CI 会跑的那套。
//
// ── 为什么要它 ────────────────────────────────────────────────────────────────
//
// 2026-10-04 推完一组提交才发现**前一天的 CI 一直是红的**：`rust/crates/server/static`
// 与前端源码漂移了（改了源码没重跑 `sync-web-assets.mjs`）。本机那天跑了「10 条 smoke +
// cargo check + vite build」—— 全绿，而 CI 的 frontend 作业里还有两条本机那天**根本没跑**：
//   · `tools/sync-web-assets.mjs --check`（唯一能提前发现这处漂移的地方）
//   · `web-vue3/scripts/check-display-semantics.mjs`
// rust 作业里也有本机没跑的：`cargo fmt --all --check`（真就挂在它上面一行超宽代码）。
//
// ⚠️★ 根因不是「忘了跑某一条」，是**「本机该跑哪几条」这件事只活在 ci.yml 和人的记性里**。
// 所以这里把它变成一条命令；清单是手写的（ci.yml 的 YAML 不值得为它引入解析器），
// 但**漏了会被判红**（判据 A 从 ci.yml 反扫 → 每条命令都必须在本清单里）。
//
// ── 用法 ─────────────────────────────────────────────────────────────────────
//
//   node tools/ci-local.mjs              # 全跑（= ci.yml 三个作业）
//   node tools/ci-local.mjs --check      # 只跑判据（秒级，不执行任何一条）
//   node tools/ci-local.mjs --fast       # 跳过 `npm run build`（最慢那一步）
//   node tools/ci-local.mjs --no-rust    # 只跑前端那一半
//   node tools/ci-local.mjs --range A..B # 提交信息查这个范围（默认 origin/main..HEAD）
//
// ⚠️ `npm ci` 本机**故意不跑**（它会删掉重灌 `web-vue3/node_modules`：慢、且没必要 ——
// 依赖没换过）。判据 C 只检查它装过了没有，缺了会提示。
//
// ── 判据 ─────────────────────────────────────────────────────────────────────
//
//   A. ci.yml（去掉注释行）里出现的每条 `node tools/*.mjs` / `node scripts/*.mjs` /
//      `cargo …` / `npm …` 命令，本清单里都得有 → **漏一条就红**（这是它唯一有牙的地方）。
//   B. ci.yml 里得有 `tools/ci-local.mjs` 这一步（本入口自己接进门禁没有）。
//   C. 清单里每一步要跑的那个文件真的存在（改名 / 搬走会红，不是静默跳过）。
//   D. `web-vue3/node_modules` 得在（缺了只提示 —— 那是「没装依赖」，不是「代码坏了」）。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CI = '.github/workflows/ci.yml';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const CHECK_ONLY = has('--check');
const FAST = has('--fast');
const NO_RUST = has('--no-rust');
const rangeFlag = argv.indexOf('--range');
const RANGE = rangeFlag >= 0 ? argv[rangeFlag + 1] : null;

// ── 清单：ci.yml 里**会真的验东西**的那些步骤，按 ci.yml 的顺序 ────────────────
//
// ⚠️ 改 ci.yml 加了步骤 → 判据 A 会把这里打红，别绕过它，把步骤加进来。
// ⚠️ `skip` 的那些是「CI 上要跑、本机不跑」的，理由写清楚，别悄悄删。

const STEPS = [
  // frontend 作业
  { job: 'frontend', cwd: 'web', cmd: 'npm ci', skip: '本机不重装依赖（见抬头）' },
  { job: 'frontend', cwd: 'web', cmd: 'npm run build', slow: true },
  // ⚠️ 2026-10-04 起生产前端是 `web/`（React）；`web-vue3`（Vue）只留作比对、**不再构建**，
  // 但它的界面约定自检留着（只读源码文本、不需要 node_modules）。
  { job: 'frontend', cwd: 'web-vue3', cmd: 'node scripts/check-display-semantics.mjs' },
  { job: 'frontend', cmd: 'node tools/sync-web-assets.mjs --check' },
  { job: 'frontend', cmd: 'node tools/sync-action-catalog.mjs --check' },
  { job: 'frontend', cmd: 'node tools/action-catalog-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/no-undef-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/share-limits-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/desktop-ui-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/share-bridge-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/shell-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/android-contract-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/workflows-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/release-smoke.mjs' },
  { job: 'frontend', cmd: 'node tools/docs-links-smoke.mjs' },
  {
    job: 'frontend',
    cmd: 'node tools/ci-local.mjs --check',
    skip: '就是本文件自己（执行到这里会自我递归）',
  },

  // rust 作业（⚠️ `cargo` 只能在 `rust/` 里跑）
  { job: 'rust', cwd: 'rust', cmd: 'cargo fmt --all --check' },
  { job: 'rust', cwd: 'rust', cmd: 'cargo clippy --workspace --all-targets -- -D warnings' },
  { job: 'rust', cwd: 'rust', cmd: 'cargo test --workspace' },
  {
    job: 'rust',
    cwd: 'rust',
    cmd: 'cargo clippy -p clip9-actions --no-default-features --all-targets -- -D warnings',
  },
  { job: 'rust', cwd: 'rust', cmd: 'cargo test -p clip9-actions --no-default-features' },

  // commit-msg 作业：逐条查本次带来的提交（`run:` 里是一段循环，这里自己拼）
  { job: 'commit-msg', cmd: 'node tools/check-commit-msg.mjs', perCommit: true },
];

// ── 判据 A/B：从 ci.yml 反扫 ──────────────────────────────────────────────────

const failures = [];
const notes = [];
const fail = (label, detail) => failures.push({ label, detail });

const ciAbs = join(ROOT, CI);
if (!existsSync(ciAbs)) {
  console.error(`✗ 读不到 ${CI}（不在仓库根跑？）`);
  process.exit(2);
}
const ciText = readFileSync(ciAbs, 'utf8');

/** ⚠️ ci.yml 里有 77 行注释，其中一行**带着** `cargo test --workspace | tail -N` 当反例 ——
 *  不剥掉注释行就会被当成一条真命令，判据 A 立刻假红。 */
const ciCode = ciText
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** ci.yml 里「会验东西」的那些命令。故意**不认** `uses:` / `sudo apt-get` / `rustup`：
 *  那些是 CI 的基础设施，本机没有对等物，认进来只会逼着人写 `skip`。 */
function ciCommands(text) {
  const out = new Set();
  for (const m of text.matchAll(/node (?:tools|scripts)\/[A-Za-z0-9_.-]+\.mjs/g)) out.add(m[0]);
  for (const m of text.matchAll(/cargo (?:fmt|clippy|test)[^\n`]*/g)) out.add(m[0].trim());
  for (const m of text.matchAll(/npm (?:ci|run [A-Za-z0-9_:-]+)/g)) out.add(m[0]);
  return [...out];
}

const inCi = ciCommands(ciCode);
const listed = STEPS.map((s) => s.cmd);
const missing = inCi.filter((c) => !listed.some((cmd) => cmd.includes(c)));
if (inCi.length === 0) {
  fail('判据 A：ci.yml 里一条命令都没扫出来', '提取器被 ci.yml 的写法改坏了？');
} else if (missing.length > 0) {
  fail(
    `判据 A：ci.yml 里有 ${missing.length} 条命令不在这份清单里`,
    missing.map((c) => `    ${c}`).join('\n') +
      '\n    → ci.yml 加了步骤：把它加进 `tools/ci-local.mjs` 的 STEPS（别绕过这条判据）'
  );
} else {
  console.log(`✓ 判据 A：ci.yml 的 ${inCi.length} 条命令全在这份清单里`);
}

if (!ciCode.includes('tools/ci-local.mjs')) {
  fail('判据 B：ci.yml 里没有 `tools/ci-local.mjs` 这一步', '本入口没接进门禁 = 没人会跑它');
} else {
  console.log('✓ 判据 B：本入口接在 ci.yml 里');
}

// ── 判据 C：清单里要跑的文件得真的在 ──────────────────────────────────────────

for (const s of STEPS) {
  const m = s.cmd.match(/(?:node )?((?:tools|scripts)\/[A-Za-z0-9_.-]+\.mjs)/);
  if (!m) continue;
  const rel = s.cwd ? join(s.cwd, m[1]) : m[1];
  if (!existsSync(join(ROOT, rel))) {
    fail(`判据 C：清单里的 ${rel} 不在了`, '文件改名 / 搬走了 —— 改清单，别让它静默跳过');
  }
}
if (!failures.some((f) => f.label.startsWith('判据 C'))) console.log('✓ 判据 C：清单里的脚本都在');

// ── 判据 D：`web/node_modules` 在不在（只提示）──────────────────────────────

if (!existsSync(join(ROOT, 'web', 'node_modules'))) {
  notes.push('web/node_modules 不在 —— `npm run build` 会失败，先在 web 里 npm ci');
}

if (CHECK_ONLY) {
  for (const n of notes) console.log(`  ⚠️  ${n}`);
  if (failures.length) {
    console.error('\n✗ 本机入口的判据没过：');
    for (const f of failures) console.error(`  ✗ ${f.label}\n${f.detail}`);
    process.exit(1);
  }
  console.log('\n全部通过（只跑判据，没执行任何一条）');
  process.exit(0);
}

// ── 执行 ─────────────────────────────────────────────────────────────────────

/** ⚠️ 结果**不接管道**（`cmd | tail` 的退出码是 tail 的 —— 2026-10-04 又栽了一次，
 *  clippy 明明红着，屏幕上却是一个空的退出码）。输出直接继承，让慢的那几条有进度可看。 */
function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd: join(ROOT, cwd || '.'), shell: true, stdio: 'inherit' });
  return r.status ?? 1;
}

function commitsToCheck() {
  if (RANGE) return RANGE;
  const r = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: ROOT });
  if (r.status !== 0) return null;
  return 'origin/main..HEAD';
}

const results = [];
for (const s of STEPS) {
  if (s.skip) {
    console.log(`  － ${s.cmd}（跳过：${s.skip}）`);
    continue;
  }
  if (s.slow && FAST) {
    console.log(`  － ${s.cmd}（跳过：--fast）`);
    continue;
  }
  if (s.job === 'rust' && NO_RUST) continue;

  if (s.perCommit) {
    const range = commitsToCheck();
    if (!range) {
      fail('提交信息：算不出 `origin/main..HEAD`', '没有 origin/main —— 用 --range 指定');
      continue;
    }
    const r = spawnSync('git', ['rev-list', range], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      fail(`提交信息：\`git rev-list ${range}\` 跑不动`, String(r.stderr || ''));
      continue;
    }
    const shas = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).reverse();
    if (shas.length === 0) {
      console.log(`  － ${s.cmd}（${range} 里没有提交）`);
      continue;
    }
    for (const sha of shas) {
      const msg = spawnSync('git', ['log', '-1', '--format=%B', sha], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout;
      const file = join(tmpdir(), `clip9-msg-${sha}.txt`);
      writeFileSync(file, msg);
      const rc = run(`node tools/check-commit-msg.mjs ${file}`, '.');
      results.push({ cmd: `${s.cmd}  ${sha.slice(0, 8)}`, rc });
    }
    continue;
  }

  const rc = run(s.cmd, s.cwd);
  results.push({ cmd: s.cmd, rc });
}

// ── 报告 ─────────────────────────────────────────────────────────────────────

console.log('');
for (const r of results) console.log(`${r.rc === 0 ? '✓' : '✗'} ${r.cmd}`);
for (const n of notes) console.log(`  ⚠️  ${n}`);

const red = results.filter((r) => r.rc !== 0);
if (failures.length || red.length) {
  for (const f of failures) console.error(`  ✗ ${f.label}\n${f.detail}`);
  console.error(`\n✗ ${red.length + failures.length} 处没过（上面标 ✗ 的那几条）`);
  process.exit(1);
}
console.log(`\n全部通过（${results.length} 条，与 ci.yml 同一套）`);
