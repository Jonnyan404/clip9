#!/usr/bin/env node
// Android 那半边**两条跨文件契约**的静态门禁。
//
// ⚠️ 为什么要有它：这两条契约都不在任何一个语言里 —— 它们散在 Cargo.toml / Kotlin /
// Rust 符号名 / Gradle 配置 / proguard / jniLibs 目录 里，**没有任何编译器或测试看着它们**。
// 对不上的症状全都不会指向出错的那一处：
//
//   契约 A：ABI 清单（三处）
//     ① tools/sync-android-jni-libs.mjs 的 TARGETS   —— abi → target，搬 `.so` 用
//     ② tools/build-android.sh          的 TARGETS   —— abi → target → clang，编 `.so` 用
//     ③ android/app/build.gradle.kts    的 abiFilters—— APK 要哪几个 ABI
//     · ①② 的 abi→target 不一致 → 产物落在 A 目录、同步脚本去 B 目录找 → **搬不到**
//       （`sync-android-jni-libs.mjs` 找不到 `.so` 时的表现是「跳过」，不是失败）
//     · ③ 多一个 ABI → `abiFilters` 列着、`jniLibs/<abi>/` 里没有 `.so` → 那一版 APK
//       编得出、装得上，**只在 `System.loadLibrary` 那一步炸**
//     · ③ 少一个 ABI → 白编一个 `.so`，完全没有症状
//
//   契约 B：native 库名与 JNI 符号名（六处）
//     ① rust/crates/android/Cargo.toml 的 `[lib] name`   → 产物 `lib<name>.so`
//     ② tools/sync-android-jni-libs.mjs 的 LIB_NAME      → 去 target 目录下找的那个文件名
//     ③ ServerBridge.kt 的 LIBRARY                       → `System.loadLibrary(...)`
//     ④ rust/crates/android/src/lib.rs 的 `Java_…` 符号名
//     ⑤ ServerBridge.kt 的 `external fun` 方法名
//     ⑥ proguard-rules.pro 的 `-keep class …`
//     · ①②③ 任一处改名 → `System.loadLibrary` 抛 `UnsatisfiedLinkError`
//     · ④⑤ 对不上 → **能加载、能过编译，一调用就 `UnsatisfiedLinkError`**
//     · release 下 R8 会改短类名与方法名，⑥ 少了哪条就悄悄失效（debug 不复现）
//
// ⚠️★ 这几处都**没有测试运行器**（两个构建脚本、一个 Gradle 配置、一堆字符串），
// 所以只能静态比对 —— 与 `tools/share-bridge-smoke.mjs` / `shell-smoke.mjs` 同一类。
//
// 用法：
//   node tools/android-contract-smoke.mjs
//   node tools/android-contract-smoke.mjs --root <别的仓库根>   # 变异验证用
//
// 判据 12 条；其中 4 条是**反向**的（参考物读不到 → 失败，不是跳过）。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
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
const fail = (label, detail) => failures.push({ label, detail });
const ok = (label) => console.log(`✓ ${label}`);

const read = (rel) => {
  const path = join(ROOT, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

// ── 提取：契约 A（三处 ABI 清单）──────────────────────────────────────────────

/** ① `sync-android-jni-libs.mjs`：每行一条 `{ target: '…', abi: '…' }`。 */
function syncAbiTargets() {
  const text = read('tools/sync-android-jni-libs.mjs');
  if (text === null) return null;
  // ⚠️ 有界：只在 `const TARGETS = [` 到第一个 `\n];` 之间找 —— 无界的 `[\s\S]*?`
  // 会掉头去吃上面别的结构体（这份仓库为此吃过一次）。
  const block = /const TARGETS = \[([\s\S]*?)\n\];/.exec(text);
  if (!block) return null;
  const body = block[1];
  const rows = [...body.matchAll(/\{\s*target:\s*'([^']+)',\s*abi:\s*'([^']+)'/g)];
  // ⚠️★ 条目数必须等于 `{` 的个数 —— 否则就是**静默少解析了几条**（比如有人给某一条
  // 多加了个字段、调了字段顺序）。那时下游会把它误报成「三处集合不一致」，
  // 而**真正的原因（这里读不全）被掩盖**，看的人会去改一份本来就对的表。
  if (!rows.length || rows.length !== (body.match(/\{/g) || []).length) return null;
  return rows.map((m) => ({ abi: m[2], target: m[1] }));
}

/** ② `build-android.sh`：`TARGETS='abi|target|clang` 换行分隔。 */
function buildAbiTargets() {
  const text = read('tools/build-android.sh');
  if (text === null) return null;
  const block = /^TARGETS='([^']*)'/m.exec(text);
  if (!block) return null;
  const rows = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rows.length) return null;
  const parsed = [];
  for (const row of rows) {
    const parts = row.split('|');
    // 形状不对 = 读不到（宁可红，也别拿着半份表继续比）。
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p))) return null;
    parsed.push({ abi: parts[0], target: parts[1], clang: parts[2] });
  }
  return parsed;
}

/** ③ `build.gradle.kts`：`abiFilters += listOf("…", "…")`。 */
function gradleAbiFilters() {
  const text = read('android/app/build.gradle.kts');
  if (text === null) return null;
  const block = /abiFilters\s*\+=\s*listOf\(([^)]*)\)/.exec(text);
  if (!block) return null;
  const items = block[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 每一项都必须是**裸字符串字面量** —— 有一项不是（写成变量、拼字符串），就当作读不到。
  // 与上一条同理：宁可红在「读不到」，也别静默少一个 ABI 之后去报「集合不一致」。
  const rows = items.map((s) => {
    const m = /^"([^"]+)"$/.exec(s);
    return m ? m[1] : null;
  });
  if (!rows.length || rows.some((r) => r === null)) return null;
  return rows;
}

// ── 提取：契约 B（native 库名与 JNI 符号名）─────────────────────────────────

/** `Cargo.toml` 的 `[lib] name`。 */
function libName() {
  const text = read('rust/crates/android/Cargo.toml');
  if (text === null) return null;
  const m = /^\[lib\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(text);
  return m ? m[1] : null;
}

/** `sync-android-jni-libs.mjs` 的 `LIB_NAME`（含 `lib` 前缀与 `.so` 后缀）。 */
function syncLibName() {
  const text = read('tools/sync-android-jni-libs.mjs');
  if (text === null) return null;
  const m = /const LIB_NAME = '([^']+)'/.exec(text);
  return m ? m[1] : null;
}

/** Rust 侧导出给 JNI 的符号名（只看函数定义，不看注释里的 `[Java_…]` 引用）。 */
function rustSymbols() {
  const text = read('rust/crates/android/src/lib.rs');
  if (text === null) return null;
  const rows = [...text.matchAll(/pub extern "system" fn (Java_[A-Za-z0-9_]+)\(/g)].map(
    (m) => m[1],
  );
  return rows.length ? rows : null;
}

/** Kotlin 一侧：文件在哪儿、类叫什么、`external fun` 有哪些、`LIBRARY` 是什么。 */
function kotlinBridge(dir) {
  const path = join(dir, 'ServerBridge.kt');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const lib = /const val LIBRARY = "([^"]+)"/.exec(text);
  const methods = [...text.matchAll(/^\s*private external fun (\w+)\(/gm)].map((m) => m[1]);
  const objects = [...text.matchAll(/^\s*object (\w+)\b/gm)].map((m) => m[1]);
  if (!lib || !methods.length || !objects.length) return null;
  return { lib: lib[1], methods, objects: new Set(objects) };
}

/** `proguard-rules.pro` 里所有 `-keep class a.b.C` 的全名。 */
function proguardKeeps() {
  const text = read('android/app/proguard-rules.pro');
  if (text === null) return null;
  const rows = [...text.matchAll(/^-keep class ([\w.$]+)\s*\{/gm)].map((m) => m[1]);
  return rows.length ? rows : null;
}

// ── 判据 1–3：三处 ABI 清单必须一致 ─────────────────────────────────────────

const sync = syncAbiTargets();
const build = buildAbiTargets();
const gradle = gradleAbiFilters();

const unread = [];
if (!sync) unread.push('tools/sync-android-jni-libs.mjs 的 TARGETS');
if (!build) unread.push('tools/build-android.sh 的 TARGETS');
if (!gradle) unread.push('android/app/build.gradle.kts 的 abiFilters');
if (unread.length) {
  // ⚠️★ 读不到 = **失败**，不是跳过。参考物不在就 skip 的门禁，会在有人改了写法、
  // 挪了文件之后静默全绿 —— 那比没有更糟（它给了一个「查过了」的假信号）。
  for (const what of unread) {
    fail('三处 ABI 清单都要读得到', `${what}：没解析出来（改了写法？挪了文件？）`);
  }
  report();
}

const setOf = (rows) => new Set(rows.map((r) => r.abi));
const syncSet = setOf(sync);
const buildSet = setOf(build);
const gradleSet = new Set(gradle);

{
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const label = '三处的 ABI 集合一致（① 同步脚本 ② 构建脚本 ③ abiFilters）';
  if (same(syncSet, buildSet) && same(syncSet, gradleSet)) {
    ok(`${label} —— ${[...syncSet].sort().join('/')}`);
  } else {
    fail(
      label,
      `① sync=${[...syncSet].sort().join(',') || '(空)'}\n` +
        `    ② build=${[...buildSet].sort().join(',') || '(空)'}\n` +
        `    ③ abiFilters=${[...gradleSet].sort().join(',') || '(空)'}`,
    );
  }
}

{
  const label = '①② 的 abi → target 映射一致（不一致就会「编在 A、去 B 搬」）';
  const map = new Map(sync.map((r) => [r.abi, r.target]));
  const wrong = build.filter((r) => map.get(r.abi) !== r.target);
  if (!wrong.length && build.length === sync.length) {
    ok(label);
  } else {
    const detail = wrong
      .map((r) => `${r.abi}: ① 说 ${map.get(r.abi) ?? '(没有这个 abi)'}，② 说 ${r.target}`)
      .join('\n    ');
    fail(label, detail || `③ 条数不同：① ${sync.length} 条，② ${build.length} 条`);
  }
}

{
  const label = '③ 列的每个 ABI 在 jniLibs/<abi>/ 下都有占位（否则 clone 出来没有这个目录）';
  const missing = gradle.filter((abi) => {
    const dir = join(ROOT, 'android/app/src/main/jniLibs', abi);
    // ⚠️ 检「目录里有文件」而不是「目录存在」：git 不收空目录，所以 clone 之后目录
    // 会不会在，取决于里面有没有 `.gitkeep` 这类占位 —— 而那正是这里要保证的事。
    return !existsSync(dir) || readdirSync(dir).length === 0;
  });
  if (!missing.length) {
    ok(`${label} —— ${gradle.length} 个`);
  } else {
    fail(label, `缺：${missing.join(', ')}`);
  }
}

{
  // ⚠️★ `android/.gitignore` 里写着「只忽略 `.so`，不忽略目录本身」的理由，
  // 但**没有东西守着那句话**。改成目录式忽略（`jniLibs/<abi>/` 或 `jniLibs/`）时，
  // git 不再往里看，`.gitkeep` 静默消失 —— 本机看不出任何区别，
  // **只有别人 clone 之后才会发现三个目录一个都没了**。
  const label = 'android/.gitignore 没有把 jniLibs 的目录整个忽略掉';
  const ignore = read('android/.gitignore');
  const swallowing = (ignore ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.endsWith('/') && line.includes('jniLibs'));
  if (ignore === null) {
    fail(label, '读不到 android/.gitignore');
  } else if (!swallowing.length) {
    ok(label);
  } else {
    fail(
      label,
      `这些规则会把 jniLibs/<abi>/ 整个忽略掉（连里面的 .gitkeep 一起）：\n    ${swallowing.join('\n    ')}`,
    );
  }
}

// ── 判据 4–6：库名与 JNI 符号 ──────────────────────────────────────────────

const cargoLib = libName();
const syncLib = syncLibName();
const rust = rustSymbols();
const kotlinDir = join(ROOT, 'android/app/src/main/java/com/clip9/app');
const bridge = kotlinBridge(kotlinDir);
const keeps = proguardKeeps();

const unreadB = [];
if (!cargoLib) unreadB.push('rust/crates/android/Cargo.toml 的 [lib] name');
if (!syncLib) unreadB.push('tools/sync-android-jni-libs.mjs 的 LIB_NAME');
if (!rust) unreadB.push('rust/crates/android/src/lib.rs 的 Java_… 符号名');
if (!bridge) unreadB.push('android/…/com/clip9/app/ServerBridge.kt 的 LIBRARY / external fun');
if (!keeps) unreadB.push('android/app/proguard-rules.pro 的 -keep class');
if (unreadB.length) {
  for (const what of unreadB) fail('契约 B 的六处都要读得到', `${what}：没解析出来`);
  report();
}

{
  const label = '① 的 [lib] name 与 ② 的 LIB_NAME 指向同一个文件名';
  const expected = `lib${cargoLib}.so`;
  if (expected === syncLib) {
    ok(`${label} —— ${expected}`);
  } else {
    fail(label, `Cargo.toml 推出 ${expected}，同步脚本写的是 ${syncLib}`);
  }
}

{
  const label = '③ 的 LIBRARY 与 ① 的 [lib] name 一致（System.loadLibrary 用它）';
  if (bridge.lib === cargoLib) {
    ok(`${label} —— ${cargoLib}`);
  } else {
    fail(label, `ServerBridge.kt 说 "${bridge.lib}"，Cargo.toml 说 "${cargoLib}"`);
  }
}

// 符号名 → 包路径 / 类名 / 方法名（JNI 的编码规则：`.` 写 `_`）。
// ⚠️ 简化：不处理包名里含 `_` 时该转义成 `_1` 的情形 —— 本项目的包名没有下划线，
// 真加了的话这里会读不出来而**报失败**（不是静默放过）。
{
  const label = '④ 的符号名 ↔ ⑤ 的 Kotlin 类与方法逐一对上';
  const problems = [];
  const seenMethods = new Set();
  let klass = null;

  for (const symbol of rust) {
    const parts = symbol.split('_');
    // `Java_` + 包各段 + 类 + 方法。包至少一段，方法至少一段。
    if (parts.length < 4 || parts[0] !== 'Java') {
      problems.push(`${symbol}：解析不出「包 / 类 / 方法」`);
      continue;
    }
    const method = parts[parts.length - 1];
    const klass_ = parts[parts.length - 2];
    const pkg = parts.slice(1, parts.length - 2).join('/');
    if (klass === null) klass = klass_;
    else if (klass !== klass_) problems.push(`${symbol}：类名与别处不一致（${klass_} ≠ ${klass}）`);
    seenMethods.add(method);

    if (!bridge.objects.has(klass_)) {
      problems.push(`${symbol}：Kotlin 里没有 \`object ${klass_}\``);
    }
    if (!existsSync(join(ROOT, 'android/app/src/main/java', pkg, `${klass_}.kt`))) {
      problems.push(`${symbol}：没有 android/app/src/main/java/${pkg}/${klass_}.kt`);
    }
  }

  const missing = [...seenMethods].filter((m) => !bridge.methods.includes(m));
  const extra = bridge.methods.filter((m) => !seenMethods.has(m));
  if (missing.length) problems.push(`Kotlin 里没有这些 external fun：${missing.join(', ')}`);
  if (extra.length) problems.push(`Rust 里没有这些符号：${extra.join(', ')}（Kotlin 多写了）`);

  if (!problems.length) {
    ok(`${label} —— ${rust.length} 个符号 · ${bridge.methods.length} 个方法`);
  } else {
    fail(label, problems.join('\n    '));
  }
}

{
  const label = '⑥ proguard 里 -keep 的每个类都真的有对应的 Kotlin 文件';
  const missing = keeps.filter((fq) => {
    const parts = fq.split('.');
    const klass = parts.pop();
    const pkg = parts.join('/');
    // `-keepclasseswithmembernames class *` 被正则排除了（它没有全名），只有全名走到这里。
    return !existsSync(join(ROOT, 'android/app/src/main/java', pkg, `${klass}.kt`));
  });
  if (!missing.length) {
    ok(`${label} —— ${keeps.length} 条`);
  } else {
    fail(label, `找不到文件：${missing.map((f) => f.replace(/\./g, '/') + '.kt').join(', ')}`);
  }
}

// ── 判据 12：Gradle / Kotlin 的产物路径真的被忽略了 ────────────────────────
//
// ⚠️★ `android/.gitignore` 里原本写的是 `/build` —— 那只匹配 `android/build`，
// 而 **AGP 的主产物在 `android/app/build/`**。2026-09-28 第一次真编时它冒了出来
// （105 MB / 438 个文件），`git status` 把它当成一个未跟踪目录：
// 一次 `git add -A` 就会把几万个构建产物收进仓库，**而且进了历史就再也拿不掉**。
//
// ⚠️★ 这一类东西的共同特征是「**洞是隐形的**」，所以逐条点名比「看起来没事」重要：
// 产物路径要么还不存在（没编过），要么存在但是**空的**（`android/.kotlin/` 就是，
// 它只有一个空的 `sessions/`）—— 而 git 不收空目录，于是 `git status` 一直干净。
//
// ⚠️ 借 `git check-ignore` 判，不自己实现 gitignore 匹配：规则语法（锚定、`**`、
// 目录尾斜杠、`!` 取反）自己抄一遍必然抄漏，而漏掉的那部分正是「以为忽略了其实没有」。
{
  const label = 'android/.gitignore 真的忽略了构建产物（Gradle / Kotlin / 本机 SDK 路径）';
  const ignored = (path) => {
    try {
      execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', '--', path], { stdio: 'ignore' });
      return true;
    } catch (err) {
      // 1 = 规则读到了但这条没匹配上；128 = 这里根本不是 git 仓库。
      return err.status === 1 ? false : null;
    }
  };
  // ⚠️ 目录要带尾斜杠 = 「这是个**目录**」。不带的话，对一个当前不存在的目录
  // （比如还没编过时 `android/app/build`），git 没法判定它是目录，
  // 于是目录规则（`build/`）匹配不上，判据会**误报**。
  //
  // ⚠️★ 这份名单是**可扩展的**：新加一个「构建时会往里写东西」的路径就在这儿加一条，
  // 判据立刻开始盯它。加之前先确认 `android/.gitignore` 里真有对应的那一条。
  const ARTIFACTS = [
    ['android/app/build/', 'AGP 的主产物在这儿'],
    ['android/build/', '根工程的 reports'],
    ['android/.gradle/', 'Gradle 自己的缓存'],
    ['android/.kotlin/', 'Kotlin 2.x 的会话与增量缓存（现在是空的，所以洞看不见）'],
    ['android/local.properties', '指向本机 SDK 的绝对路径（每台机器都不一样）'],
  ];
  const results = ARTIFACTS.map(([path, why]) => [path, why, ignored(path)]);
  if (results.some(([, , r]) => r === null)) {
    fail(label, `${ROOT} 不是一个 git 仓库 —— 这条判据要靠 git 自己解释 .gitignore`);
  } else if (results.length === 0) {
    // ⚠️★ 名单空了 = 这条判据**什么都没在判**，却会打印一个 ✓。
    // 留一条下限，免得重构时把名单删干净、门禁变成绿灯摆设。
    fail(label, 'ARTIFACTS 名单是空的 —— 这条判据什么都没在判');
  } else {
    const bad = results.filter(([, , r]) => !r);
    if (!bad.length) ok(`${label} —— ${results.length} 条`);
    else
      fail(
        label,
        `没被忽略：\n    ${bad.map(([path, why]) => `${path}（${why}）`).join('\n    ')}`,
      );
  }
}

// ── 判据 11：Kotlin 的块注释 ────────────────────────────────────────────────
//
// ⚠️★ Kotlin 的块注释**可以嵌套** —— 所以 KDoc 正文里出现一次「斜杠 + 星号」
// 就会再开一层：内层的 `*/` 先把内层关掉，**外层一直不闭合**，于是文件剩下的内容
// 全被吞进注释里。编译器报的是 `Syntax error: Unclosed comment`（行号指向文件末尾，
// 因为错误发生在那里）+ 一串 `Unresolved reference: <那个文件里定义的类>` ——
// **看起来像「凭空少了几个类」，而不是「注释写坏了」**。
// 2026-09-28 为此白跑了一趟完整 Gradle 构建（1 分 16 秒 + 人工读日志）。
//
// ⚠️ 这是「替编译器做它能做的那一小部分」。真编一次当然更彻底，但本机没有 Kotlin
// 编译器、CI 也没接 Android 构建 —— 而这一条是毫秒级的，且抓的正是最隐蔽的那类。
//
// ⚠️ 状态机有意写简单：字符串模板里嵌套字符串（`"${"a"}"`）不处理。Kotlin 的
// 字符串与非字符串分不清时，**宁可判成字符串**（漏报）也不要把字符串里的
// 「斜杠 + 星号」当成注释（误报）—— 后者会让这条判据被删掉。
function kotlinComments() {
  const dir = join(ROOT, 'android/app/src/main/java/com/clip9/app');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.kt'));
  if (!files.length) return null;

  const problems = [];
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    const lineOf = (offset) => text.slice(0, offset).split('\n').length;

    let i = 0;
    let depth = 0;
    let opened = -1;
    const nested = [];
    while (i < text.length) {
      const c = text[i];
      if (depth > 0) {
        if (c === '/' && text[i + 1] === '*') {
          nested.push(i);
          i += 2;
          depth += 1;
          continue;
        }
        if (c === '*' && text[i + 1] === '/') {
          depth -= 1;
          if (depth === 0) opened = -1;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        depth = 1;
        opened = i;
        i += 2;
        continue;
      }
      if (c === '"') {
        if (text.startsWith('"""', i)) {
          const end = text.indexOf('"""', i + 3);
          i = end < 0 ? text.length : end + 3;
          continue;
        }
        i += 1;
        while (i < text.length && text[i] !== '"' && text[i] !== '\n') {
          if (text[i] === '\\') i += 1;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (c === "'") {
        i += 1;
        while (i < text.length && text[i] !== "'" && text[i] !== '\n') {
          if (text[i] === '\\') i += 1;
          i += 1;
        }
        i += 1;
        continue;
      }
      i += 1;
    }

    if (depth > 0) {
      problems.push(`${name}:${lineOf(opened)} 块注释没闭合（到文件末尾还差 ${depth} 个闭合符）`);
    }
    for (const at of nested) {
      problems.push(
        `${name}:${lineOf(at)} 块注释正文里又开了一层（「斜杠 + 星号」会一路吞掉后面的代码）`,
      );
    }
  }
  return { count: files.length, problems };
}

{
  const label = 'Kotlin 的块注释都闭合、且注释正文里没有再开一层';
  const res = kotlinComments();
  if (res === null) {
    fail(label, '读不到 android/app/src/main/java/com/clip9/app 下的 .kt 文件');
  } else if (!res.problems.length) {
    ok(`${label} —— ${res.count} 个文件`);
  } else {
    fail(label, res.problems.join('\n    '));
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function report() {
  if (notes.length) {
    console.log('\n提示（不失败）：');
    for (const note of notes) console.log(`· ${note}`);
  }
  if (failures.length) {
    console.log('');
    for (const { label, detail } of failures) {
      console.error(`✗ ${label}\n    ${detail}`);
    }
    console.error(`\n✗ ${failures.length} 条判据没过。`);
    process.exit(1);
  }
  console.log('\n✓ Android 契约自检通过（12 条判据）。');
}

report();
