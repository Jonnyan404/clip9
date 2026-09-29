#!/usr/bin/env node
// Android 那半边**跨文件 / 跨语言契约**的静态门禁。
//
// ⚠️ 为什么要有它：这些契约都不在任何一个语言里 —— 它们散在 Cargo.toml / Kotlin /
// Rust 符号名 / Gradle 配置 / proguard / jniLibs 目录 / config.rs / 两份 SPA 里，
// **没有任何编译器或测试看着它们**。对不上的症状全都不会指向出错的那一处：
//
//   契约 A：ABI 清单（三处）
//     ① tools/sync-android-jni-libs.mjs 的 TARGETS   —— abi → target，搬 `.so` 用
//     ② tools/build-android.sh          的 TARGETS   —— abi → target → clang，编 `.so` 用
//     ③ android/app/build.gradle.kts 的 splits.abi.include —— APK 拆哪几个 ABI
//     · ①② 的 abi→target 不一致 → 产物落在 A 目录、同步脚本去 B 目录找 → **搬不到**
//       （`sync-android-jni-libs.mjs` 找不到 `.so` 时的表现是「跳过」，不是失败）
//     · ③ 多一个 ABI → `splits` 列着、`jniLibs/<abi>/` 里没有 `.so` → 那一版 APK
//       编得出、装得上，**只在 `System.loadLibrary` 那一步炸**
//       （⚠️ 2026-09-29 之前这里写的是 `abiFilters`；那件事本身没变，只是「要哪几个 ABI」
//        现在由 `splits.abi.include` 说了 —— 二者并存会让 AGP 报 Conflicting configuration，
//        所以下面那第 4 条判据专门盯着「`abiFilters` 不许再出现」。）
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
//   契约 C：配置页的「控件 ↔ JSON 字段名」表 ↔ `clip9-core` 的 `Config`
//     见判据 13/14 抬头那段（**静默失败**，所以它比上面两条更需要门禁）。
//   契约 D：资源引用是否存在 —— 编不过，只是提前问一句。
//     两个方向：Kotlin 的 `R.id` / `R.string` / `R.color`，以及布局里的
//     `@id` / `@string` / `@color` / `@drawable` / `@mipmap` / `@style`。
//     ⚠️★ 扫之前**一律剥掉注释**（`stripXmlComments` / `scanKotlin`）—— 注释里的
//        引用不是引用（编译器也看不见它），注释里的 `<string name="…">` 也不是定义。
//        不剥的话，文档里写个例子就会被判成「引用了一个不存在的资源」，
//        而修法会退化成「把注释写残」—— 那是拿文档换绿灯。
//   契约 E：跨端桥名（`clip9Auth` / `roomAuth` / `__default__`）—— 对不上就「什么都没发生」。
//
// ⚠️★ 这几处都**没有测试运行器**（两个构建脚本、一个 Gradle 配置、一堆字符串），
// 所以只能静态比对 —— 与 `tools/share-bridge-smoke.mjs` / `shell-smoke.mjs` 同一类。
//
// 用法：
//   node tools/android-contract-smoke.mjs
//   node tools/android-contract-smoke.mjs --root <别的仓库根>   # 变异验证用
//
// ⚠️★ 判据条数**不在这里写**（脚本自己数，见最后一行）。这里原来写着「12 条」，
//    而实际只打印 11 个 ✓ —— 因为「读不到就失败」那条只在**失败时**才出声。
//    写死的数字就是这么变成假话的：改判据的人不会记得回头改它。
// 其中有 4 条是**反向**的（参考物读不到 → 失败，不是跳过）。

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
/** 通过的判据条数。⚠️ 由 `ok()` 自己数 —— 别在报告里写死一个数字。 */
let okCount = 0;
const fail = (label, detail) => failures.push({ label, detail });
const ok = (label) => {
  okCount += 1;
  console.log(`✓ ${label}`);
};

const read = (rel) => {
  const path = join(ROOT, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

/**
 * 把 XML 的注释内容**换成等长空格**（`<!-- … -->` → 一串空格）。
 *
 * ⚠️★ 为什么必须做这一步：注释里的 `@color/foo` **不是引用** —— aapt2 看不见它，
 *   编译器也看不见。拿全文去跑正则，等于把「文档里写的例子」当成真的引用。
 *   这条在 2026-09-29 一连咬了三次，而且每次的修法都是**去把注释写残**
 *   （把 `@color/console_*` 改写成「console_* 那一组颜色」）——
 *   那是拿「文档说不清楚」换「判据不误报」，方向反了。
 *   正解是让判据与编译器一样**无视注释**：改完之后注释反而能正常写出资源名。
 *
 * ⚠️ 等长（不是删掉）是刻意的：报错时的行号仍然是**原文的行号**，
 *   可以照着行号直接去文件里找。
 * ⚠️ XML 注释**不能嵌套**（`--` 在注释正文里本身就是非法的），所以非贪婪匹配就够。
 */
function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 扫一遍 Kotlin，把注释的**位置**找出来，同时给出「注释已挖空」的等长副本。
 *
 * ⚠️★ 与 `stripXmlComments` 同源：Kotlin 注释里的 `R.string.foo` 不是引用。
 * ⚠️ 状态机有意写简单：字符串模板里嵌套字符串（`"${"a"}"`）不处理。分不清时
 *   **宁可判成字符串**（漏报）也不要把字符串里的 `//` 当成注释开头（误报）——
 *   后者会把 `"https://…"` 后面的半行代码一起挖掉，而那是真的会用错地方。
 *
 * ⚠️★ 下面这段说明里**一个注释符号都不写**（用「斜杠 + 星号」/「星号 + 斜杠」代替）：
 *   这份文件就是 `android-contract-smoke.mjs`，判据 11 盯的正是「Kotlin 块注释里
 *   不能出现那两个组合字面量」；而**这一段自己就是第一版踩坑** —— 在 JSDoc 正文里
 *   写了「星号 + 斜杠」的引号形式，块注释当场在那一行闭合，后半段注释变成顶层代码，
 *   Node 报 `SyntaxError: Unexpected identifier`（行号指向注释里那几行）。
 *   和判据 11 抬头记的两个 Kotlin 例子是**同一个错**。
 *
 * @returns `{stripped, nested, strays, unclosed, unclosedDepth}`
 *   `stripped` 与原文等长；`nested` 是嵌套块注释里**内层开头**那个组合的偏移；
 *   `strays` 是注释**外面**出现的闭合组合（只可能来自「注释被提前关掉」）；
 *   `unclosed` 是到文件末尾都没闭合时最外层开头那个组合的偏移（没闭合则 null）。
 */
function scanKotlin(text) {
  // ⚠️ `split('')` 按 UTF-16 码元切，下标与 `text[i]` 完全一致（`[...text]` 按码点切，
  //    遇到 emoji 之类就错位了 —— 而偏移正是这里报错要用的东西）。
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  const nested = [];
  const strays = [];
  let i = 0;
  let depth = 0;
  let opened = -1;

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
        if (depth === 0) {
          blank(opened, i + 2);
          opened = -1;
        }
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      blank(i, end);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      depth = 1;
      opened = i;
      i += 2;
      continue;
    }
    // ⚠️ 这个分支必须在 `/*` 之后判：`/` 开头的两种都已经在前面 continue 掉了。
    if (c === '*' && text[i + 1] === '/') {
      strays.push(i);
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

  // 没闭合的块注释一路吃到文件末尾 —— 编译器就是这么看的，所以也挖空它。
  const unclosedDepth = depth;
  const unclosed = depth > 0 ? opened : null;
  if (unclosed !== null) blank(opened, text.length);

  return { stripped: out.join(''), nested, strays, unclosed, unclosedDepth };
}

/** 读一个 `.kt` 文件并返回「注释已挖空」的正文（读不到返回 `null`）。 */
function readKotlinCode(rel) {
  const text = read(rel);
  return text === null ? null : scanKotlin(text).stripped;
}

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

/**
 * `build.gradle.kts` 的**代码行**（注释全部剔掉）。
 *
 * ⚠️★ 2026-09-29 加的这个函数不是洁癖，是被咬过：这个文件的注释里专门写了
 *    「别加回 `ndk { abiFilters += … }`」和反例 `splits { abi { … } }`，
 *    拿**全文**去跑那两条判据的正则，会命中注释里的例子 —— 下面那个取 ABI 清单的正则
 *    第一版就是这么错的：它匹配到注释里那句 `splits { abi { … } }`，再往下一行
 *    「`splits.abi.include(...)`」里捞出了 `...` 三个点当 ABI 名。
 *    （同一类自伤在本仓库发生过多次：判据本身对了，扫到了注释。）
 */
function gradleCodeWithoutComments() {
  const text = read('android/app/build.gradle.kts');
  if (text === null) return null;
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** ③ `build.gradle.kts`：`splits { abi { include("…", "…") } }`。 */
function gradleAbiSplits() {
  const text = gradleCodeWithoutComments();
  if (text === null) return null;
  // ⚠️ 从 `splits` 一路框到 `abi` 再取 `include(...)`：`include` 这个名字在 Gradle 脚本里
  //    到处都是（`settings.gradle.kts` 也有），不加这两层前缀会去匹配不相干的那些。
  const block = /splits\s*\{[\s\S]*?\babi\s*\{[\s\S]*?\binclude\(([^)]*)\)/.exec(text);
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
  // ⚠️ 剥注释：这份文件里解释 JNI 命名规则时，正列举过 `object` / `external fun` 的真名字。
  const text = scanKotlin(readFileSync(path, 'utf8')).stripped;
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
const gradle = gradleAbiSplits();

const unread = [];
if (!sync) unread.push('tools/sync-android-jni-libs.mjs 的 TARGETS');
if (!build) unread.push('tools/build-android.sh 的 TARGETS');
if (!gradle) unread.push('android/app/build.gradle.kts 的 splits.abi.include');
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
  const label = '三处的 ABI 集合一致（① 同步脚本 ② 构建脚本 ③ splits.abi.include）';
  if (same(syncSet, buildSet) && same(syncSet, gradleSet)) {
    ok(`${label} —— ${[...syncSet].sort().join('/')}`);
  } else {
    fail(
      label,
      `① sync=${[...syncSet].sort().join(',') || '(空)'}\n` +
        `    ② build=${[...buildSet].sort().join(',') || '(空)'}\n` +
        `    ③ splits.abi.include=${[...gradleSet].sort().join(',') || '(空)'}`,
    );
  }
}

// ── 判据 3b：`abiFilters` 不许再出现（它与 `splits.abi` 并存会让 AGP 直接报错）──
//
// ⚠️★ 2026-09-29 加的。这条判的是一个**只在真跑 Gradle 时才会炸**的形状：
//    AGP 原话是 "Conflicting configuration : '…' in ndk abiFilters cannot be present
//    when splits abi filters are set : …"。本机跑不了 Gradle 的时候，这里是唯一能提前
//    问一句的地方 —— 否则它要等到 CI 打 APK 那一步才响（那条路一次好几分钟）。
{
  const label = 'build.gradle.kts 里没有 abiFilters（与 splits.abi 并存会被 AGP 拒）';
  const code = gradleCodeWithoutComments();
  if (code === null) {
    fail(label, '读不到 android/app/build.gradle.kts');
  } else if (/\babiFilters\b/.test(code)) {
    fail(
      label,
      '代码里还有 `abiFilters` —— 它与 `splits.abi` 并存时 AGP 会报\n' +
        '    "Conflicting configuration : … in ndk abiFilters cannot be present when splits\n' +
        '     abi filters are set : …"，两个都不会生效。要改 ABI 清单就改 `splits.abi.include`。',
    );
  } else {
    ok(label);
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
    // ⚠️★ 签名私钥。它按设计放在**仓库外**（本机 `~/keystore/clip9/`），但最容易发生的
    // 事故恰恰是往仓库里放一份：Go 版的 workflow 就是 `base64 --decode >
    // android/app/my-release-key.keystore`，照那个习惯手动解一份到 `android/app/` 里很自然。
    // 而它一旦进了 git 历史就**再也拿不掉**（改写历史要力推，且别人 clone 过的都还在），
    // 拿到它的人可以签出能**覆盖安装**的包 —— 这类事故没有补救。
    // ⚠️ 这两条**不带尾斜杠**：它们是文件名模式，`*.jks` 在 `check-ignore` 眼里是纯字符串匹配、
    //    不要求文件存在（与上面那些目录规则相反，见本判据抬头那段注释）。
    ['android/app/my-release-key.jks', '签名私钥（keytool -genkeypair 的产物）'],
    ['android/app/my-release-key.keystore', '签名私钥的另一种后缀（Go 版用的就是这个名）'],
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
// ⚠️★ Kotlin 的块注释**可以嵌套**，于是注释里那两个字面量**哪种顺序都不能出现**：
//
//   ① 注释正文里写「斜杠 + 星号」→ 又开一层：内层的闭合符先把内层关掉，**外层一直
//      不闭合**，文件剩下的内容全被吞进注释。编译器报 `Syntax error: Unclosed comment`
//      （行号指向文件末尾，因为错误发生在那里）+ 一串
//      `Unresolved reference: <那个文件里定义的类>` —— **看起来像「凭空少了几个类」**。
//   ② 注释正文里写「星号 + 斜杠」→ 注释**在那一行提前关掉**，它**后面那几行变成顶层代码**，
//      报一串 `Syntax error: Expecting a top level declaration`，**列号指向注释里的字**。
//      ⚠️★ 这一种更隐蔽：它连「注释没闭合」都不报，所以只查 ① 的写法会**全绿**。
//
// 两次都是真踩（2026-09-28）：① 白跑一趟 Gradle 构建（1 分 16 秒 + 人工读日志）；
// ② 是**修 ① 时写下的注释自己踩的** —— 那句解释里带着 ② 的字面量，又白跑一趟（7 秒）。
// 「解释这个坑的注释里，一个组合字面量都不能出现」这句话本身就是这条判据的由来。
//
// ⚠️ 这是「替编译器做它能做的那一小部分」。真编一次当然更彻底，但本机没有 Kotlin
// 编译器、CI 也没接 Android 构建 —— 而这一条是毫秒级的，且抓的正是最隐蔽的那类。
//
// ⚠️ 状态机在 `scanKotlin()` 里（与「剥注释」共用同一份）—— 两处各写一份必然分叉。
function kotlinComments() {
  const dir = join(ROOT, 'android/app/src/main/java/com/clip9/app');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.kt'));
  if (!files.length) return null;

  const problems = [];
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    const lineOf = (offset) => text.slice(0, offset).split('\n').length;
    const { nested, strays, unclosed, unclosedDepth } = scanKotlin(text);

    if (unclosed !== null) {
      problems.push(
        `${name}:${lineOf(unclosed)} 块注释没闭合（到文件末尾还差 ${unclosedDepth} 个闭合符）`,
      );
    }
    for (const at of nested) {
      problems.push(
        `${name}:${lineOf(at)} 块注释正文里又开了一层（「斜杠 + 星号」会一路吞掉后面的代码）`,
      );
    }
    for (const at of strays) {
      problems.push(
        `${name}:${lineOf(at)} 注释外面出现了闭合符 —— 多半是注释正文里写了「星号 + 斜杠」` +
          `把注释提前关掉，它后面那几行就变成顶层代码了`,
      );
    }
  }
  return { count: files.length, problems };
}

{
  const label = 'Kotlin 的块注释闭合正常（没被提前关掉、也没有嵌出第二层）';
  const res = kotlinComments();
  if (res === null) {
    fail(label, '读不到 android/app/src/main/java/com/clip9/app 下的 .kt 文件');
  } else if (!res.problems.length) {
    ok(`${label} —— ${res.count} 个文件`);
  } else {
    fail(label, res.problems.join('\n    '));
  }
}

// ── 判据 13–16：配置页 ↔ Rust 配置模型 / 资源引用 / 跨端桥名 ─────────────────
//
// ⚠️★ 这一组存在的理由与上面两条一样：它们都**跨语言或跨文件**，没有任何编译器看着。
//   配置页那四条尤其危险，因为它们的失败是**静默**的：
//
//   契约 C：配置页的「控件 ↔ JSON 字段名」表（`ConfigPage.kt`）
//     · 字段名写错（`server.roomCleanup` 写成 `server.roomcleanup`）→ 那个框**永远读不到值**、
//       保存时又**凭空多写一个键**进 `config.json`。Rust 那边把未知键忽略掉，
//       于是症状是「改了、存了、重启了、没反应」。
//     · 少写一项（`config.rs` 加了字段但表单没加）→ 「配不了」，而且没人会注意到。
//   契约 D：资源引用（`R.id.*` / `R.string.*` / `R.color.*` / `@string/*`）
//     ⚠️ 这一类的失败**不是静默的**（编不过），所以它更像「提前问一句」：
//     本机跑不了 Gradle，而这几条是毫秒级的，能省掉一次 CI 往返。
//     ⚠️★ 扫之前**一律剥注释**（见 `stripXmlComments` / `scanKotlin` 抬头）——
//        不剥的话，注释里写一个资源名就会被判成「引用了一个不存在的资源」，
//        而人会因此把注释写残来迁就判据。2026-09-29 一连咬了三次。
//     ⚠️ 但**反向**（定义了没人读）只记提示不失败 —— 那确实只是噪音，不是坏事。
//   契约 E：跨端桥名（Android ↔ 两份 `web-vue3`）
//     · `clip9Auth` / `roomAuth` / `__default__` 三处对不上 →
//       「免打开界面认证」**什么都不发生**（不报错、不提示，只是又被问了一次密码）。
//   契约 F：布局里不许有「wrap_content 容器里撑满父向的裸 `<View>`」
//     · 裸 View 没有内容高宽，`View` 默认的 `onMeasure`（`getDefaultSize`）对
//       `AT_MOST` **返回整个 specSize** —— 一根 1dp 宽的分隔线会被量成一整屏高，
//       把容器、面板一路撑爆，直到把旁边 `ScrollView`（`0dp + weight=1`）挤到 0 高：
//       页签与三页内容全部消失，**不报错也不崩**，看起来像「界面坏了」。
//       （2026-09-29 真机塌陷就是它，见 `docs/specs/android-client.md` §0.4 第 11 条。）

/**
 * 从 `config.rs` 里抽出「结构体名 → { JSON 键 → 字段类型 }」。
 *
 * ⚠️ JSON 键 = 有 `#[serde(rename = "…")]` 就用它，否则用字段名。
 * ⚠️ 按**大括号配对**切每个结构体的正文，不用无界正则 —— 无界的 `[\s\S]*?\}` 会掉头
 * 去吃别的结构体（这类自伤在本仓库发生过多次）。
 * ⚠️ 元组结构体（`pub struct RoomAuthConfig(pub BTreeMap<…>)`）没有大括号，
 * 这里天然扫不到 —— 它也不需要：`roomAuth` 那一块走的是动态行，不进字段表。
 */
function rustConfigKeys() {
  const text = read('rust/crates/core/src/config.rs');
  if (text === null) return null;
  const out = new Map();
  const header = /pub struct (\w+)\s*\{/g;
  let m;
  while ((m = header.exec(text)) !== null) {
    const body = braceBody(text, header.lastIndex - 1);
    if (body === null) return null;
    const fields = new Map();
    let pendingRename = null;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('//')) continue;
      const rename = /^#\[serde\(rename = "([^"]+)"\)\]$/.exec(line);
      if (rename) {
        pendingRename = rename[1];
        continue;
      }
      // ⚠️ 别的属性（`#[serde(default)]`、`#[derive(…)]`）**不重置** pendingRename：
      //    rename 一定紧挨着它那一行字段，中间隔一个 derive 的情形不存在。
      if (line.startsWith('#[')) continue;
      const field = /^pub (\w+):\s*(.+?),?$/.exec(line);
      if (field) {
        fields.set(pendingRename ?? field[1], field[2].trim());
        pendingRename = null;
      }
    }
    out.set(m[1], fields);
  }
  return out.size ? out : null;
}

/** 取 `text[open]` 那个 `{` 配对到的那一个 `}` 之间的正文（不含两端）。 */
function braceBody(text, open) {
  if (text[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * `ConfigPage.kt` 的字段表：`Field(R.id.控件, "块.字段", Kind.X)`。
 *
 * ⚠️ 这张表是**唯一**该出现字段名的地方（类文档里写着），所以扫它一个文件就够。
 */
function configPageFields() {
  // ⚠️ 剥注释：类文档里若举一个 `Field(R.id.…, "a.b", Kind.X)` 的例子，
  //    全文扫描会把它当成表里真有一行。
  const text = readKotlinCode('android/app/src/main/java/com/clip9/app/ConfigPage.kt');
  if (text === null) return null;
  const rows = [
    ...text.matchAll(/Field\(\s*R\.id\.(\w+)\s*,\s*"([^"]+)"\s*,\s*Kind\.(\w+)\s*\)/g),
  ].map((m) => ({ id: m[1], path: m[2], kind: m[3] }));
  return rows.length ? rows : null;
}

/** `ConfigPage.kt` 的开关表：`R.id.控件 to "块.字段"`。 */
function configPageSwitches() {
  const text = readKotlinCode('android/app/src/main/java/com/clip9/app/ConfigPage.kt');
  if (text === null) return null;
  // ⚠️ 框在 `switches` 那个 `listOf(` 里：`to` 这个写法在 Kotlin 里到处都是。
  const block = /val switches: List<Pair<Int, String>> = listOf\(([\s\S]*?)\n    \)/.exec(text);
  if (!block) return null;
  const rows = [...block[1].matchAll(/R\.id\.(\w+)\s+to\s+"([^"]+)"/g)].map((m) => ({
    id: m[1],
    path: m[2],
  }));
  return rows.length ? rows : null;
}

/**
 * 某个 `values/*.xml` 里定义的名字（`<string name="…">` / `<color name="…">`）。
 *
 * ⚠️★ `color` 还有**第二个住址**：`res/color/*.xml`。那边放的是 `ColorStateList`
 * （比如三个页签按钮那种「按 `state_checked` 换底色」的背景），而它的规则是
 * **一个文件就是一个 `@color/` 资源**、名字取自文件名 —— 靠 `<color name="…">` 扫不到，
 * 必须按目录补。
 * ⚠️ 2026-09-29 踩：`@color/console_seg_button` / `@color/console_seg_text` 指的正是
 * `res/color/` 下那两个文件，而这条判据只读 `values/`，于是把三个**合法**的引用
 * 报成了「没有定义」—— 覆盖面止于扫描范围，这一条旧的扫描范围是错的。
 */
function definedNames(tag) {
  const raw = read('android/app/src/main/res/values/' + (tag === 'string' ? 'strings' : 'colors') + '.xml');
  if (raw === null) return null;
  // ⚠️ 先剥注释：`<!-- <string name="x"> -->` 里的那个名字**不是定义**。
  const text = stripXmlComments(raw);
  const rows = [...text.matchAll(new RegExp(`<${tag} name="([A-Za-z_]\\w*)"`, 'g'))].map((m) => m[1]);
  if (tag === 'color') {
    const dir = join(ROOT, 'android/app/src/main/res/color');
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.xml')) rows.push(file.slice(0, -'.xml'.length));
      }
    }
  }
  return rows.length ? new Set(rows) : null;
}

/**
 * `res/drawable*` / `res/mipmap*` 下的文件名（去掉扩展名）—— `@drawable/x` / `@mipmap/x` 的定义。
 *
 * ⚠️★ 与 `definedNames` 是同一类：布局里把一个 drawable 的名字写错**同样编不过**，
 * 而本机跑不了 Gradle，这条判据是唯一能提前问一句的地方。
 * ⚠️ 要扫**所有**变体目录（`drawable-v24`、`mipmap-anydpi-v26`…），不能只看没有后缀那个 ——
 * 本仓库的启动图标就只在 `mipmap-anydpi-v26/` 里有一份 `.xml`。
 * ⚠️ 不过滤扩展名：`mipmap-hdpi/ic_launcher.png` 也是 `@mipmap/ic_launcher` 的定义。
 */
function fileResourceNames(kind) {
  const root = join(ROOT, 'android/app/src/main/res');
  if (!existsSync(root)) return null;
  const out = new Set();
  for (const entry of readdirSync(root)) {
    if (entry !== kind && !entry.startsWith(kind + '-')) continue;
    for (const file of readdirSync(join(root, entry))) {
      out.add(file.replace(/\.[^.]+$/, ''));
    }
  }
  return out.size ? out : null;
}

/** `values/*.xml` 里 `<style name="…">` 的名字（可以带 `.`，比如 `Widget.Clip9.SegButton`）。 */
function styleNames() {
  const dir = join(ROOT, 'android/app/src/main/res/values');
  if (!existsSync(dir)) return null;
  const out = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.xml')) continue;
    const text = stripXmlComments(readFileSync(join(dir, file), 'utf8'));
    for (const m of text.matchAll(/<style name="([A-Za-z_][\w.]*)"/g)) out.add(m[1]);
  }
  return out.size ? out : null;
}

/** 所有布局里 `@+id/…` 定义出来的 id，以及它们引用的各种资源。 */
function layoutIds() {
  const dir = join(ROOT, 'android/app/src/main/res/layout');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.xml'));
  if (!files.length) return null;
  const defined = new Set();
  const refs = [];
  for (const name of files) {
    // ⚠️★ 剥注释（`stripXmlComments` 抬头那段）：注释里的 `@string/x` 不是引用、
    //    注释掉的 `@+id/y` 也不是定义 —— 后者正是一份「被注释掉的控件」该有的样子。
    const text = stripXmlComments(readFileSync(join(dir, name), 'utf8'));
    for (const m of text.matchAll(/@\+id\/([A-Za-z_]\w*)/g)) defined.add(m[1]);
    for (const m of text.matchAll(/@id\/([A-Za-z_]\w*)/g)) refs.push({ name: m[1], where: name });
    for (const m of text.matchAll(/@string\/([A-Za-z_]\w*)/g)) refs.push({ name: m[1], where: name, kind: 'string' });
    for (const m of text.matchAll(/@color\/([A-Za-z_]\w*)/g)) refs.push({ name: m[1], where: name, kind: 'color' });
    // ⚠️ `@android:color/white` 那种**系统**资源不会命中上面几条（前缀是 `android:`）——
    //    这是想要的：我们只管自家 res/ 下的名字。
    for (const m of text.matchAll(/@(drawable|mipmap)\/([A-Za-z_]\w*)/g)) {
      refs.push({ name: m[2], where: name, kind: m[1] });
    }
    for (const m of text.matchAll(/@style\/([A-Za-z_][\w.]*)/g)) {
      refs.push({ name: m[1], where: name, kind: 'style' });
    }
  }
  return { defined, refs };
}

/**
 * `res/drawable/*.xml` 与 `res/color/*.xml` 里的资源引用。
 *
 * ⚠️★ 判「有没有人读」时**必须**把它们算进来：控制台那一组颜色绝大多数只出现在
 * drawable 里（`bg_console_panel` 的渐变端点就是两个颜色，`bg_console_dirty` 的
 * `solid` 是第三个），布局上一个都不提。
 * ⚠️ 漏了这一步的后果不是「少报」，而是「**瞎报**」：26 个正在用的颜色被列成
 * 「没人读的顏色」—— 而假的提示比没有提示更坏，它教人以后直接忽略这条提示。
 * （2026-09-29 踩，与上面 `definedNames` 那条是同一类：覆盖面止于扫描范围。）
 */
function drawableResRefs() {
  const out = { strings: new Set(), colors: new Set() };
  for (const sub of ['drawable', 'color']) {
    const dir = join(ROOT, 'android/app/src/main/res/' + sub);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.xml')) continue;
      const text = stripXmlComments(readFileSync(join(dir, file), 'utf8'));
      for (const m of text.matchAll(/@string\/([A-Za-z_]\w*)/g)) out.strings.add(m[1]);
      for (const m of text.matchAll(/@color\/([A-Za-z_]\w*)/g)) out.colors.add(m[1]);
    }
  }
  return out;
}

/** 所有 `.kt` 里的 `R.id.*` / `R.string.*` / `R.color.*`。 */
function kotlinResRefs() {
  const dir = join(ROOT, 'android/app/src/main/java/com/clip9/app');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.kt'));
  if (!files.length) return null;
  const ids = new Set();
  const strings = new Set();
  const colors = new Set();
  // ⚠️★ 前面那个 `(?<![\w.])` 是必须的：`android.R.id.content` 里的 `R.id.content`
  // 也匹配得上，而它是**框架的** id（不是我们的布局里的），于是判据会误报「没有 @+id」。
  // 2026-09-29 真踩到：`findViewById<View>(android.R.id.content)`。
  // ⚠️ 还要剥注释：`// 原来是 R.string.show_qr，现在叫 …` 这种说明句里的旧名字
  //    会被当成真引用，于是报「没有定义」—— 而它只是历史。见 `stripXmlComments` 抬头。
  for (const name of files) {
    const text = scanKotlin(readFileSync(join(dir, name), 'utf8')).stripped;
    for (const m of text.matchAll(/(?<![\w.])R\.id\.([A-Za-z_]\w*)/g)) ids.add(m[1]);
    for (const m of text.matchAll(/(?<![\w.])R\.string\.([A-Za-z_]\w*)/g)) strings.add(m[1]);
    for (const m of text.matchAll(/(?<![\w.])R\.color\.([A-Za-z_]\w*)/g)) colors.add(m[1]);
  }
  return { ids, strings, colors, files: files.length };
}

/** 一份 SPA 的 `store/websocket.js` 里那三个跨端名字。 */
function spaBridge(rel) {
  const text = read(rel);
  if (text === null) return null;
  const bridge = /const NATIVE_AUTH_BRIDGE = '([^']+)'/.exec(text);
  const roomKey = /const DEFAULT_ROOM_KEY = '([^']+)'/.exec(text);
  // ⚠️ 判据用的是**它读的时候那一句**：`typeof bridge.roomAuth !== 'function'` 里那个方法名
  //    才是页面真的会去调的。写成「读一个常量」的话，改常量不难，改调用处才容易漏。
  const call = /typeof\s+bridge\.(\w+)\s*(?:!==|===)\s*'function'/.exec(text);
  if (!bridge || !roomKey || !call) return null;
  return { where: rel, bridge: bridge[1], roomKey: roomKey[1], method: call[1] };
}

/** `WebAppActivity.kt` 里那两处（对象名 + 方法名）。 */
function kotlinBridgeNames() {
  // ⚠️ 剥注释：这份文件的注释里解释过那三个桥名，而「解释」用的正是它们的字面量。
  const text = readKotlinCode('android/app/src/main/java/com/clip9/app/WebAppActivity.kt');
  if (text === null) return null;
  const bridge = /const val AUTH_BRIDGE = "([^"]+)"/.exec(text);
  const method = /fun (\w+)\(\): String\? = authCache/.exec(text);
  const roomKey = /const val DEFAULT_ROOM_KEY = "([^"]+)"/.exec(text);
  if (!bridge || !method || !roomKey) return null;
  return { bridge: bridge[1], method: method[1], roomKey: roomKey[1] };
}

// ── 契约 C：配置页字段表 ↔ config.rs ───────────────────────────────────────

const rustKeys = rustConfigKeys();
const pageFields = configPageFields();
const pageSwitches = configPageSwitches();

{
  const label = '契约 C：ConfigPage 的字段表 / 开关表都能在 config.rs 里对上 JSON 键';
  const unreadC = [];
  if (!rustKeys) unreadC.push('rust/crates/core/src/config.rs 的结构体字段');
  if (!pageFields) unreadC.push('ConfigPage.kt 的 fields 表');
  if (!pageSwitches) unreadC.push('ConfigPage.kt 的 switches 表');
  if (unreadC.length) {
    fail(label, `${unreadC.join('、')}：没解析出来（改了写法？）`);
  } else {
    const blocks = rustKeys.get('Config');
    const problems = [];
    const all = [...pageFields, ...pageSwitches];
    for (const { id, path } of all) {
      const parts = path.split('.');
      if (parts.length !== 2) {
        problems.push(`${id}：路径 "${path}" 应当是「块.字段」两段`);
        continue;
      }
      const [block, key] = parts;
      const struct = blocks ? blocks.get(block) : null;
      if (!struct) {
        problems.push(`${id}："${block}" 不是 Config 里的一个块（有：${blocks ? [...blocks.keys()].join(', ') : '?'}）`);
        continue;
      }
      const fields = rustKeys.get(struct);
      if (!fields || !fields.has(key)) {
        problems.push(
          `${id}：${struct} 里没有 JSON 键 "${key}"（有：${fields ? [...fields.keys()].sort().join(', ') : '?'}）`,
        );
      }
    }
    if (!problems.length) {
      ok(`${label} —— ${all.length} 个路径`);
    } else {
      fail(
        label,
        problems.join('\n    ') +
          '\n    ⚠️ 字段名对不上的症状是**静默**的：那个框读不到值，保存时又凭空多写一个键，\n' +
          '       而 Rust 会把未知键忽略掉 —— 看起来就是「改了、存了、重启了、没反应」。',
      );
    }
  }
}

{
  // ⚠️★ 反向：`config.rs` 里**每一个**配置项都要能在表单上改到 —— 这正是
  // 「加入服务端所有配置的可视化配置」这条需求的判据。
  // ⚠️ `server.roomAuth` 是唯一的例外：它走的是**动态行**（`layout_room_row.xml`），
  // 那一份的字段由 `ConfigPage.readRooms()` 拼，不在这两张表里。
  const label = '契约 C（反向）：config.rs 里每一个配置项都有对应的控件';
  if (!rustKeys) {
    fail(label, '读不到 rust/crates/core/src/config.rs 的结构体字段');
  } else {
    const HANDLED_ELSEWHERE = new Set(['server.roomAuth']);
    const blocks = rustKeys.get('Config');
    const covered = new Set([...pageFields, ...pageSwitches].map((f) => f.path));
    const missing = [];
    if (!blocks) {
      fail(label, '读不到 Config 的四个块');
    } else {
      for (const [block, struct] of blocks) {
        const fields = rustKeys.get(struct);
        if (!fields) {
          missing.push(`${block} → ${struct}：读不到那个结构体的字段`);
          continue;
        }
        for (const key of fields.keys()) {
          const path = `${block}.${key}`;
          if (HANDLED_ELSEWHERE.has(path) || covered.has(path)) continue;
          missing.push(path);
        }
      }
      if (!missing.length) {
        ok(`${label} —— 覆盖 ${covered.size} 项 + roomAuth 的动态行`);
      } else {
        fail(
          label,
          `这些配置项在界面上没有控件（等于「配不了」）：\n    ${missing.join('\n    ')}\n` +
            '    ⚠️ 要么加控件，要么把它加进 HANDLED_ELSEWHERE 并写清为什么。',
        );
      }
    }
  }
}

// ── 契约 D：资源引用都要存在 ───────────────────────────────────────────────

{
  const label =
    '契约 D：布局里的 @id / @string / @color / @drawable / @mipmap / @style 与 Kotlin 的 R.* 都有定义';
  const layouts = layoutIds();
  const kotlin = kotlinResRefs();
  const strings = definedNames('string');
  const colors = definedNames('color');
  const shapes = {
    drawable: fileResourceNames('drawable'),
    mipmap: fileResourceNames('mipmap'),
  };
  const styles = styleNames();
  if (!layouts || !kotlin || !strings || !colors || !shapes.drawable || !shapes.mipmap || !styles) {
    fail(label, '读不到布局 / Kotlin / strings.xml / colors.xml / drawable / mipmap / style 里的某一份');
  } else {
    const problems = [];
    // 布局里引用别的布局定义的 id 也要在（同一份或跨文件都行）。
    for (const ref of layouts.refs) {
      if (ref.kind === 'string' && !strings.has(ref.name)) {
        problems.push(`layout/${ref.where}: @string/${ref.name} 没有定义`);
      } else if (ref.kind === 'color' && !colors.has(ref.name)) {
        problems.push(`layout/${ref.where}: @color/${ref.name} 没有定义`);
      } else if (ref.kind === 'drawable' || ref.kind === 'mipmap') {
        if (!shapes[ref.kind].has(ref.name)) {
          problems.push(`layout/${ref.where}: @${ref.kind}/${ref.name} 没有定义`);
        }
      } else if (ref.kind === 'style' && !styles.has(ref.name)) {
        problems.push(`layout/${ref.where}: @style/${ref.name} 没有定义`);
      } else if (!ref.kind && !layouts.defined.has(ref.name)) {
        problems.push(`layout/${ref.where}: @id/${ref.name} 没有任何 @+id 定义它`);
      }
    }
    for (const id of kotlin.ids) {
      if (!layouts.defined.has(id)) problems.push(`Kotlin: R.id.${id} 在布局里没有 @+id`);
    }
    for (const name of kotlin.strings) {
      if (!strings.has(name)) problems.push(`Kotlin: R.string.${name} 没有定义`);
    }
    for (const name of kotlin.colors) {
      if (!colors.has(name)) problems.push(`Kotlin: R.color.${name} 没有定义`);
    }
    if (!problems.length) {
      ok(
        `${label} —— ${kotlin.ids.size} 个 id · ${kotlin.strings.size} 条文案 · ` +
          `${kotlin.colors.size} 个颜色 · 布局里 ${layouts.refs.length} 处引用`,
      );
    } else {
      fail(
        label,
        problems.join('\n    ') +
          '\n    ⚠️ 这一类的失败**编不过**，所以它更像「提前问一句」：本机跑不了 Gradle，\n' +
          '       而这几条是毫秒级的。',
      );
    }

    // ⚠️ 反向只记提示：定义了没人读确实只是噪音，不是坏事（`isShrinkResources` 会剥掉它们）。
    //    但它值得说一声 —— 没人读的条目多了之后，这份表就没人敢动了。
    // ⚠️★ 三处读者都要算上：Kotlin、布局、以及 **drawable / color 目录**（后者见
    //    `drawableResRefs` 的注释 —— 少了它这条提示会变成假信号）。
    const shapeRefs = drawableResRefs();
    const unusedStrings = [...strings].filter(
      (n) =>
        !kotlin.strings.has(n) &&
        !layouts.refs.some((r) => r.kind === 'string' && r.name === n) &&
        !shapeRefs.strings.has(n),
    );
    const unusedColors = [...colors].filter(
      (n) =>
        !kotlin.colors.has(n) &&
        !layouts.refs.some((r) => r.kind === 'color' && r.name === n) &&
        !shapeRefs.colors.has(n),
    );
    if (unusedStrings.length || unusedColors.length) {
      notes.push(
        `没人读的文案 ${unusedStrings.length} 条、颜色 ${unusedColors.length} 个（不失败）：` +
          `${[...unusedStrings, ...unusedColors].join(', ') || '（无）'}`,
      );
    }
  }
}

// ── 契约 E：跨端桥名（Android ↔ 两份 SPA）─────────────────────────────────

{
  const label = '契约 E：clip9Auth / roomAuth / __default__ 在 Android 与两份 SPA 里逐字一致';
  const kotlin = kotlinBridgeNames();
  // ⚠️★ `clip9` 是**独立仓库** —— 克隆它的人不会带上父仓库那份同源副本。
  // 所以第二份**在则查、不在则只记一条提示**（让它失败的话，独立克隆的门禁会红）。
  // ⚠️ 但也**不能**整条都靠「在不在」决定：本仓库这一份是硬的，永远要查到。
  const COPIES = [
    { rel: 'web-vue3/src/store/websocket.js', required: true },
    { rel: '../web-vue3/src/store/websocket.js', required: false },
  ];
  if (kotlin === null) {
    fail(label, '读不到 WebAppActivity.kt 里的 AUTH_BRIDGE / roomAuth / DEFAULT_ROOM_KEY');
  } else {
    const problems = [];
    const seen = [];
    for (const copy of COPIES) {
      const parsed = spaBridge(copy.rel);
      if (parsed === null) {
        if (copy.required) problems.push(`读不到 ${copy.rel} 里的 NATIVE_AUTH_BRIDGE / roomAuth`);
        else notes.push(`没查 ${copy.rel}（这份同源副本不在 —— 独立克隆 clip9 时是正常的）`);
        continue;
      }
      seen.push(parsed);
      if (parsed.bridge !== kotlin.bridge) {
        problems.push(`${copy.rel}：对象名 "${parsed.bridge}" ≠ Android 的 "${kotlin.bridge}"`);
      }
      if (parsed.method !== kotlin.method) {
        problems.push(`${copy.rel}：方法名 "${parsed.method}" ≠ Android 的 "${kotlin.method}"`);
      }
      if (parsed.roomKey !== kotlin.roomKey) {
        problems.push(`${copy.rel}：默认房间键 "${parsed.roomKey}" ≠ Android 的 "${kotlin.roomKey}"`);
      }
    }
    // ⚠️★ 两份 SPA 是**同源副本** —— 只改一份的话，Go 版那边就静默少了一半行为。
    if (seen.length === 2 && (seen[0].bridge !== seen[1].bridge || seen[0].roomKey !== seen[1].roomKey)) {
      problems.push('两份 web-vue3 的 store/websocket.js 不一致（它们必须同源）');
    }
    if (!problems.length) {
      ok(`${label} —— ${kotlin.bridge}.${kotlin.method}() · ${kotlin.roomKey}（查了 ${seen.length} 份）`);
    } else {
      fail(
        label,
        problems.join('\n    ') +
          '\n    ⚠️ 对不上的症状是**什么都没发生** —— 不报错、不提示，只是又被问了一次密码。',
      );
    }
  }
}

// ── 契约 F：布局里不许有「wrap_content 容器里撑满父向的裸 View」────────────

/**
 * 逐个布局扫一遍标签树，找出「父容器某一向是 wrap_content、自己却在该向写
 * match_parent 的裸 `<View>`」。
 *
 * ⚠️★ 为什么专盯**裸 `<View>`**：它没有内容高宽，`View` 默认的 `onMeasure`
 * （`getDefaultSize`）对 `AT_MOST` **返回整个 specSize** —— 一根 1dp 宽的分隔线
 * 会被量成一整屏高，把容器、面板一路撑爆，直到把旁边的 `ScrollView`
 * （`0dp + weight=1`）挤到 0 高：页签与三页内容全部消失，**不报错也不崩**
 * （2026-09-29 真机塌陷就是它，`uiautomator` 量到面板 827dp / 应为 ~431dp）。
 *
 * ⚠️ 有内容的容器没事：`LinearLayout` / `TextView` 在 `AT_MOST` 下量出来的是
 * 自己内容的高宽 —— 所以只盯 `<View>`。
 * ⚠️ 父是固定值或 match_parent 也没事：那一向的规格是 `EXACTLY`，解析是准的。
 *
 * ⚠️ 解析是**手写的标签扫描**而不是真 XML 解析器：本仓库的布局格式规整
 * （一行一个属性、属性值里没有 `>`），正则够用；Node 没有内置 XML 解析器，
 * 为几行判据引依赖不值得。⚠️ 注释先剥掉（`stripXmlComments`）——
 * 注释里写的示例不是控件。
 */
function bareViewBlowups() {
  const dir = join(ROOT, 'android/app/src/main/res/layout');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.xml'));
  if (!files.length) return null;
  const hits = [];
  const TAG = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>/g;
  for (const name of files) {
    const text = stripXmlComments(readFileSync(join(dir, name), 'utf8'));
    const stack = [];
    let m;
    while ((m = TAG.exec(text)) !== null) {
      const [, closing, tag, attrs, selfClose] = m;
      if (closing) {
        stack.pop();
        continue;
      }
      const get = (prop) => {
        const hit = new RegExp(`android:${prop}="([^"]*)"`).exec(attrs);
        return hit ? hit[1] : '';
      };
      const parent = stack[stack.length - 1];
      if (parent && tag === 'View') {
        const w = get('layout_width');
        const h = get('layout_height');
        const pw = parent.get('layout_width');
        const ph = parent.get('layout_height');
        // ⚠️★ 判的是**同一向**：子项在宽上要撑满、而父的宽是 wrap_content（高同理）。
        //    宽高交叉着比（比如「子高 match_parent + 父宽 wrap_content」）在
        //    horizontal LinearLayout 里**不是坑** —— 变异验证抓出来过这一版写法。
        if (
          (w === 'match_parent' && pw === 'wrap_content') ||
          (h === 'match_parent' && ph === 'wrap_content')
        ) {
          const line = text.slice(0, m.index).split('\n').length;
          const axis = w === 'match_parent' ? '宽' : '高';
          hits.push(
            `${name}:${line}  <View> 的${axis}是 match_parent，而 <${parent.tag}> 的${axis}是 wrap_content`,
          );
        }
      }
      if (!selfClose) stack.push({ tag, get });
    }
  }
  return hits;
}

{
  const label =
    '契约 F：布局里没有「wrap_content 容器里撑满父向的裸 View」（那种 View 会被 AT_MOST 量成整屏高）';
  const hits = bareViewBlowups();
  if (hits === null) {
    fail(label, '读不到 android/app/src/main/res/layout/ 下的布局');
  } else if (hits.length) {
    fail(
      label,
      hits.join('\n    ') +
        '\n    ⚠️ 裸 View 没有内容高宽，`AT_MOST` 之下 onMeasure 返回整个可用空间 —— 一根分隔线\n' +
        '       就能撑爆容器、把旁边的 weight 子项挤到 0。分隔线用稿子的 gap 做法：\n' +
        '       相邻格 margin 露出容器底色，别用一根 match_parent 的 View。',
    );
  } else {
    ok(`${label} —— 布局里全部裸 View 都过了`);
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
  console.log(`\n✓ Android 契约自检通过（${okCount} 条判据）。`);
}

report();
