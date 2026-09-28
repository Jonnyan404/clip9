#!/usr/bin/env node
// 把 Rust 交叉编出来的 `libclip9_android.so` 搬进 Android 工程的 `jniLibs/`。
//
// 用法：
//   node tools/sync-android-jni-libs.mjs            # 从 rust/target 同步（缺哪个 ABI 就报哪个）
//   node tools/sync-android-jni-libs.mjs --check    # 只比对不写；不一致退出 1
//   node tools/sync-android-jni-libs.mjs --only arm64-v8a   # 只搬一个 ABI
//
// ⚠️★ 忘了同步是**没有症状**的：APK 编得过、装得上、图标点得开，
// 只有 `System.loadLibrary("clip9_android")` 那一步抛 `UnsatisfiedLinkError` ——
// 它**不会告诉你**「是 jniLibs 里没有那个 ABI 的 .so」。
// （与「前端产物忘了同步」是同一类：那件事编得过、跑起来也正常，只是界面永远停在上一版。）
//
// # 先交叉编
//
// ⚠️★ 那三个环境变量必须与 cargo **在同一条命令里**（每次 Bash 调用都是新 shell，
// 环境变量不跨调用）。本机的 NDK 路径：
//
//   cd rust && \
//   NDK=$HOME/Library/Android/sdk/ndk/27.3.13750724/toolchains/llvm/prebuilt/darwin-x86_64/bin && \
//   export CC_aarch64_linux_android=$NDK/aarch64-linux-android24-clang && \
//   export AR_aarch64_linux_android=$NDK/llvm-ar && \
//   export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android24-clang && \
//   cargo build -p clip9-android --release --target aarch64-linux-android
//
// 把变量名里的 `aarch64_linux_android` 换成 `armv7_linux_androideabi`、目标换成
// `armv7-linux-androideabi` 就是 32 位的那个（clang 换成 `armv7a-linux-androideabi24-clang`）。
//
// ⚠️ 还要 `export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"` —— 两个 rust 里只有 rustup 那个
// 装了 android target，而 Homebrew 那个在 PATH 前面时会给出一句 `can't find crate for std`。
//
// ⚠️ 它**不在 CI 里**（CI 上没有 NDK，也就没有 .so 可比），所以它只在**你本机打 APK 之前**跑 ——
// 而那正是它要防的那一步。别把 `--check` 加进 CI：那只会得到一条永远红的判据。

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Rust 的 target 三元组 → Android 的 ABI 目录名。⚠️ 名字对不上 = `.so` 放错目录 = 不生效。 */
const TARGETS = [
  { target: 'aarch64-linux-android', abi: 'arm64-v8a', note: '真机（绝大多数手机）' },
  { target: 'armv7-linux-androideabi', abi: 'armeabi-v7a', note: '老 32 位设备' },
  { target: 'x86_64-linux-android', abi: 'x86_64', note: '模拟器（本机是 x86_64 的 Mac）' },
];

/** 产物名 = `rust/crates/android/Cargo.toml` 的 `[lib] name`。⚠️ 它是契约（见那个文件）。 */
const LIB_NAME = 'libclip9_android.so';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

// ⚠️★ `--only` 拼错时要**当场退出**，不能过滤出 0 个目标然后报「都同步好了」——
// 那样人会以为这一步过了，接着去打一个 jniLibs 里什么都没有的 APK。
if (only !== null && !TARGETS.some((t) => t.abi === only)) {
  console.error(`✗ 不认识的 ABI：${only}`);
  console.error(`  可用的：${TARGETS.map((t) => t.abi).join(', ')}`);
  process.exit(2);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

let missing = 0;
let copied = 0;
let same = 0;
let absent = 0;
let filtered = 0;

for (const { target, abi, note } of TARGETS) {
  if (only && only !== abi) {
    filtered += 1;
    continue;
  }

  const source = join(ROOT, 'rust/target', target, 'release', LIB_NAME);
  const destDir = join(ROOT, 'android/app/src/main/jniLibs', abi);
  const dest = join(destDir, LIB_NAME);

  if (!existsSync(source)) {
    // ⚠️ 缺一个不是错误，是**信息** —— 只做 arm64 的人也该能用这个脚本。
    absent += 1;
    console.log(`· ${abi.padEnd(12)} 没有产物（${note}）`);
    console.log(`  编它：cargo build -p clip9-android --release --target ${target}`);
    continue;
  }

  const sourceSize = statSync(source).size;
  if (existsSync(dest) && sha256(dest) === sha256(source)) {
    same += 1;
    console.log(`✓ ${abi.padEnd(12)} 已是最新（${(sourceSize / 1024).toFixed(0)} KB）`);
    continue;
  }

  const stale = existsSync(dest);
  if (checkOnly) {
    missing += 1;
    console.log(`✗ ${abi.padEnd(12)} ${stale ? '过期' : '缺失'}（jniLibs 里没有对应这份 .so）`);
    continue;
  }

  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, dest);
  copied += 1;
  console.log(`${stale ? '↻' : '+'} ${abi.padEnd(12)} 已同步（${(sourceSize / 1024).toFixed(0)} KB）`);
}

const parts = [`同步 ${copied}`, `已最新 ${same}`];
if (absent > 0) parts.push(`没有产物 ${absent}`);
if (filtered > 0) parts.push(`本次不涉及 ${filtered}`);
console.log(`\n共 ${TARGETS.length} 个目标：${parts.join('、')}${checkOnly ? '（--check 模式，什么都没写）' : ''}`);

if (checkOnly && missing > 0) {
  console.error(`\n✗ ${missing} 个 ABI 没有同步 —— 那些 ABI 上装出来的 APK 会在 loadLibrary 那一步炸。`);
  process.exit(1);
}
