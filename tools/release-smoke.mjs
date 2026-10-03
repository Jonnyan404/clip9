#!/usr/bin/env node
// `tools/release.sh` 的判据：**那个脚本的价值全在「该拒绝时拒绝」**，所以这里专测它拒绝得对不对。
//
// ── 为什么要它 ────────────────────────────────────────────────────────────────
//
// `v0.1.1` 与 `v0.1.1-beta3` 两次发布的坏法是同一种：**资产全传上去了、Release 页面是空的** ——
// 因为说明没写进 `CHANGELOG.md`，而「先提交、再打 tag」这条约束**没有东西强制**。
// `tools/release.sh` 就是那个强制物，而它唯一的动作是「在第 3 步核对说明」。
//
// ⚠️★ 所以这条判据盯的不是「脚本能跑」，是**那个核对还在、且真的会拦住**：
// 哪天有人顺手把第 3 步简化掉，一切照旧工作 —— 直到下一次发版又出现空白页面。
// 与 `tools/shell-smoke.mjs` / `workflows-smoke.mjs` 同一类：**没有测试运行器的那一侧
// 靠静态自检兜住**，而这里连「跑一遍」都是本脚本自己做的（脚本本身就是被测物）。
//
// ── 夹具 ─────────────────────────────────────────────────────────────────────
//
// 全部在 `mkdtemp` 造的最小 git 仓库里（**仓库文件一行不动**），另配一个假 `gh`
// （只把参数抄下来，不做任何远端动作）。所以这条判据**不联网、不发版、不留痕迹**。
//
// ── 怎么验它自己有牙 ──────────────────────────────────────────────────────────
//
// 变异验证（改的是被测物，不是判据）：把 `release.sh` 里那句
//   `if ! "$NODE" "$ROOT/tools/release-notes.mjs" --tag "$TAG" >"$NOTES" 2>"$ERR"; then`
// 换成 `if false; then`（= 把核对删掉），则**判据 1 必须不再通过**（那一版会一路跑到建 Release）。
// 2026-10-03 实测如此（见 `.workbuddy/memory/2026-10-03.md`）。

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// ⚠️ `CLIP9_RELEASE_SCRIPT` 是给**变异验证**用的：指向一份被人为改坏的 `release.sh`，
//    用来确认下面这些判据**真的盯住了那些行**（绿而无牙的判据在这个仓库里不算判据）。
//    不设时就是真正的那份。
const SCRIPT = process.env.CLIP9_RELEASE_SCRIPT
  ? resolve(process.env.CLIP9_RELEASE_SCRIPT)
  : join(ROOT, 'tools/release.sh');

const failures = [];
const notes = [];
let okCount = 0;
const fail = (label, detail) => failures.push({ label, detail });
const ok = (label) => {
  okCount += 1;
  console.log(`✓ ${label}`);
};
const note = (msg) => notes.push(msg);

// ── git（夹具里用，够小）─────────────────────────────────────────────────────

/**
 * 夹具里的 git。⚠️ 刻意把全局/系统配置关掉：夹具要**封闭**，
 * 不能让宿主机上的 `commit.gpgsign`、`core.hooksPath`、`init.defaultBranch` 影响结论。
 */
function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（${res.status}）：\n${res.stderr}`);
  }
  return res.stdout;
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const MARKER = '<!-- ↓↓↓ 新的一条加在这一行的下面 ↓↓↓ -->\n';

/** 夹具的 CHANGELOG。`v9.9.0` 那一段在，是为了让「上一个 tag」与范围非空。 */
const changelogWith = (section) =>
  `# 更新日志\n\n${MARKER}\n${section}## v9.9.0 · 2026-10-01\n\n### 这一版有什么\n\n夹具里的上一版。\n`;

const sectionFor = (tag) => `## ${tag} · 2026-10-02\n\n### 这一版有什么\n\n夹具里的这一版。\n\n`;

/**
 * 期望的 Release 正文。
 * ⚠️★ `release-notes.mjs` **会去掉 `## <tag>` 那一行**（Release 页面上本来就显示版本名，
 *    再渲染一个标题是重复），所以期望值也要去掉 —— 这条一开始漏了，报出来的是
 *    「正文多了一行」，看着像脚本多贴了什么。
 */
const expectedNotes = (tag) => sectionFor(tag).replace(/^## [^\n]*\n+/, '').trim();

const BASE = mkdtempSync(join(tmpdir(), 'clip9-release-smoke-'));

/** 假 `gh`：只把收到的参数记进 `$GH_LOG`，把 `--notes-file` 抄一份到 `$GH_NOTES`。 */
const GH_STUB = join(BASE, 'gh-stub.sh');
writeFileSync(
  GH_STUB,
  [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$*" >> "${GH_LOG:?}"',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "--notes-file" ]; then cp "$2" "${GH_NOTES:?}"; fi',
    '  shift',
    'done',
    'exit 0',
    '',
  ].join('\n'),
);
chmodSync(GH_STUB, 0o755);

let fixtureSeq = 0;

/**
 * 造一棵最小仓库。
 * `section` 传 null = 不写这一版；传字符串 = 用它当那一段（用来造「占位」）。
 * ⚠️ 内容写完**不提交** —— 那样才是真实情形（刚写完说明、还没 commit）。
 */
function fixture({ tag, section, extraDirty = false, existingTag = null }) {
  fixtureSeq += 1;
  const dir = join(BASE, `fix${fixtureSeq}`);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'user.email', 'smoke@local']);
  git(dir, ['config', 'user.name', 'smoke']);

  copyFileSync(join(ROOT, 'tools/release-notes.mjs'), join(dir, 'tools/release-notes.mjs'));
  // 先提交一份**没有这一版**的 CHANGELOG（里面只有 v9.9.0 那一段），并给它打上上一个 tag。
  writeFileSync(join(dir, 'CHANGELOG.md'), changelogWith(''));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  git(dir, ['tag', 'v9.9.0']);

  // 第二个提交：让「上一个 tag..HEAD」这段范围非空（拒绝时脚本要把这些列出来当原料）。
  writeFileSync(join(dir, 'marker.txt'), 'second\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'feat(desktop): a fixture change']);

  // ⚠️★ 这一版的说明**最后**才写上，而且**不提交** —— 那才是真实情形（刚写完说明、还没
  //    commit），也正是「脚本替你 commit」那条路能被测到的前提（写在这之前就会跟着
  //    init 一起进提交，工作区反而是干净的）。
  if (section !== null) writeFileSync(join(dir, 'CHANGELOG.md'), changelogWith(section));

  if (existingTag) git(dir, ['tag', existingTag]);
  if (extraDirty) writeFileSync(join(dir, 'junk.txt'), 'junk\n');
  return dir;
}

/**
 * 跑被测脚本。`--skip-gates` 是必须的：夹具里没有真前端产物。
 *
 * ⚠️★ **`gh` 一律是那个假桩，不落回真的 `gh`。** 一开始我在「应该拒绝」的那几条里用了
 * 真 `gh`，于是它们**因为「本机 PATH 里没有 gh」而退出非 0**、看起来全过 ——
 * 而 CI 上 `gh` 是有的，同一条判据在那里会变成假绿的反面（该拒绝的没拒绝也照样非 0）。
 * 现在 6 条用例的退出码只由「脚本拒没拒绝」决定，与环境无关。
 */
function runRelease(dir, tag, extraArgs = [], { script = SCRIPT } = {}) {
  const ghLog = join(dir, '.gh.log');
  const ghNotes = join(dir, '.gh.notes');
  rmSync(ghLog, { force: true });
  rmSync(ghNotes, { force: true });
  const res = spawnSync('bash', [script, tag, '--yes', '--skip-gates', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      CLIP9_RELEASE_ROOT: dir,
      NODE: process.execPath,
      GH: GH_STUB,
      GH_LOG: ghLog,
      GH_NOTES: ghNotes,
    },
  });
  const readIf = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return { status: res.status, out: `${res.stdout}${res.stderr}`, ghLog: readIf(ghLog), ghNotes: readIf(ghNotes) };
}

function check(label, got, want) {
  if (got === want) ok(label);
  else fail(label, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function checkIncludes(label, haystack, needle) {
  if (haystack.includes(needle)) ok(label);
  else fail(label, `输出里找不到 ${JSON.stringify(needle)}\n    实际输出：\n${haystack}`);
}

// ── 参考物在不在（读不到就红，不跳过）────────────────────────────────────────

if (!readFileSync(SCRIPT, 'utf8').includes('release-notes.mjs')) {
  fail('参考物：tools/release.sh 里还认得出那个核对', '脚本里找不到 release-notes.mjs —— 被测物已经不是这条判据认识的样子了');
  report();
}

// ── 判据 1：没写说明 → 必须拒绝，并把「原料」列出来 ──────────────────────────

{
  const dir = fixture({ tag: 'v9.9.9', section: null });
  const r = runRelease(dir, 'v9.9.9');
  check('判据 1：没写这一版的说明 → 拒绝（非 0）', r.status !== 0, true);
  checkIncludes('判据 1：说清了是「CHANGELOG 里没有这一段」', r.out, '没有 `## v9.9.9` 那一段');
  checkIncludes('判据 1：把上一个 tag 说出来了', r.out, 'v9.9.0');
  checkIncludes('判据 1：把范围内的提交列出来当原料', r.out, 'feat(desktop): a fixture change');
  check('判据 1：没打 tag', git(dir, ['tag', '--list', 'v9.9.9']).trim(), '');
  check('判据 1：也没留下半成品提交', git(dir, ['log', '-1', '--format=%s']).trim(), 'feat(desktop): a fixture change');
}

// ── 判据 2：那一段是占位 → 也必须拒绝 ───────────────────────────────────────

{
  const dir = fixture({ tag: 'v9.9.9', section: sectionFor('v9.9.9').replace('夹具里的这一版。', '（待发布）') });
  const r = runRelease(dir, 'v9.9.9');
  check('判据 2：那一段还是占位 → 拒绝', r.status !== 0, true);
  checkIncludes('判据 2：把抽正文脚本自己的说法透出来', r.out, '占位');
  // ⚠️ 核对排在「提交说明」**之前**，所以这一路退出去时**什么都没留下** ——
  //    不留一条占位内容的 `docs(changelog)` 提交，也不打 tag。
  check('判据 2：没打 tag', git(dir, ['tag', '--list', 'v9.9.9']).trim(), '');
  check('判据 2：没留下半成品提交（HEAD 还是那句夹具提交）', git(dir, ['log', '-1', '--format=%s']).trim(), 'feat(desktop): a fixture change');
}

// ── 判据 3：写全了 → 一路成功，且 gh 收到的参数是对的 ───────────────────────

{
  const dir = fixture({ tag: 'v9.9.9', section: sectionFor('v9.9.9') });
  const r = runRelease(dir, 'v9.9.9');
  check('判据 3：说明写全 → 通过（0）', r.status, 0);
  check('判据 3：替你把说明 commit 了（信息用模板规定的形状）', git(dir, ['log', '-1', '--format=%s']).trim(), 'docs(changelog): v9.9.9');
  check('判据 3：tag 打出来了', git(dir, ['tag', '--list', 'v9.9.9']).trim(), 'v9.9.9');
  checkIncludes('判据 3：gh 收到的是 release create', r.ghLog, 'release create v9.9.9');
  checkIncludes('判据 3：带了 --verify-tag（tag 得先真推出去）', r.ghLog, '--verify-tag');
  checkIncludes('判据 3：正文是当场带上去的（--notes-file）', r.ghLog, '--notes-file');
  check('判据 3：正式版不带 --prerelease', r.ghLog.includes('--prerelease'), false);
  check(
    '判据 3：⭐ 绝不把自动生成的说明接上来（--generate-notes）',
    r.ghLog.includes('--generate-notes'),
    false,
  );
  // ⚠️ 两边都 `trim()`：抽正文那个脚本用 `console.log` 输出，末尾会多一个换行 ——
  //    判据关心的是**正文内容**，不是它用哪种方式写出来。
  check(
    '判据 3：粘到 Release 上的正文与 CHANGELOG 里那一段一致（标题行不算）',
    r.ghNotes.trim(),
    expectedNotes('v9.9.9'),
  );
}

// ── 判据 4：预发布由 tag 后缀决定（不是靠人记得去勾那个框）──────────────────

{
  const dir = fixture({ tag: 'v9.9.9-beta1', section: sectionFor('v9.9.9-beta1') });
  const r = runRelease(dir, 'v9.9.9-beta1');
  check('判据 4：预发布也走通', r.status, 0);
  checkIncludes('判据 4：带了 --prerelease', r.ghLog, '--prerelease');
}

// ── 判据 5：tag 已经存在 → 拒绝（不许覆盖已经发出去的号）─────────────────────

{
  const dir = fixture({ tag: 'v9.9.9', section: sectionFor('v9.9.9'), existingTag: 'v9.9.9' });
  const r = runRelease(dir, 'v9.9.9');
  check('判据 5：本地已有同名 tag → 拒绝', r.status !== 0, true);
  checkIncludes('判据 5：说清是重名', r.out, '已经有 v9.9.9 这个 tag');
}

// ── 判据 6：工作区还有别的改动 → 拒绝（不许把没提交的东西一起发出去）─────────

{
  const dir = fixture({ tag: 'v9.9.9', section: sectionFor('v9.9.9'), extraDirty: true });
  const r = runRelease(dir, 'v9.9.9');
  check('判据 6：另有脏文件 → 拒绝', r.status !== 0, true);
  // ⚠️★ 这两条要**一起**看：只断言「输出里有 junk.txt」是不够的 —— 脚本后面还有一张
  //    兜底的网（自检之后再看一次工作区），它拒绝时也会把 `git status` 整个打出来，
  //    于是那条断言在「第 1 步的检查被删掉」时**照样是绿的**（实测如此）。
  //    钉住那句**专属的**话，才钉得住第 1 步那一行。
  checkIncludes('判据 6：说清是「还有别的改动」这一步拒的', r.out, '工作区还有别的改动');
  checkIncludes('判据 6：把脏文件列出来', r.out, 'junk.txt');
  check('判据 6：没打 tag', git(dir, ['tag', '--list', 'v9.9.9']).trim(), '');
}

// ── 判据 7：tag 形状不对 → 拒绝 ─────────────────────────────────────────────

{
  const dir = fixture({ tag: 'v9.9.9', section: sectionFor('v9.9.9') });
  const r = runRelease(dir, '0.9.9');
  check('判据 7：tag 没带 v → 拒绝', r.status !== 0, true);
  checkIncludes('判据 7：说清期望的形状', r.out, 'v0.1.2');
}

// ── 提示（不失败）───────────────────────────────────────────────────────────

if (process.env.CLIP9_KEEP_FIXTURES !== '1') {
  rmSync(BASE, { recursive: true, force: true });
} else {
  note(`夹具留在 ${BASE}（CLIP9_KEEP_FIXTURES=1）`);
}

report();

function report() {
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
  console.log(`\n✓ release.sh 自检通过（${okCount} 条判据）。`);
}
