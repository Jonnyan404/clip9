#!/usr/bin/env bash
#
# 一条命令把 Android 的 APK 从源码打出来：
#
#   三个 ABI 的 libclip9_android.so  →  搬进 jniLibs/  →  ./gradlew assembleDebug|Release
#
# 用法（⚠️ 在**普通终端**里跑，不要在本项目的沙箱里跑 —— 见文件末尾）：
#
#   bash tools/build-android.sh                      # 三个 ABI + assembleDebug
#   bash tools/build-android.sh --release            # 换成 assembleRelease
#   bash tools/build-android.sh --abi arm64-v8a      # 只编一个 ABI（最快的冒烟）
#   bash tools/build-android.sh --no-gradle          # 只编 .so 并同步，不叫 Gradle
#   bash tools/build-android.sh --print              # 只把要跑的命令打出来，什么都不做
#   bash tools/build-android.sh --release --require-all
#                                                    # ⚠️ **CI 用这个**：范围内的 ABI
#                                                    # 有一个没编出来就非零退出，不静默跳过
#   bash tools/build-android.sh --release -- -Psigning.store.file=/abs/clip9.jks \
#       -Psigning.store.password=… -Psigning.key.alias=… -Psigning.key.password=…
#                                                    # `--` 之后原样交给 ./gradlew
#
# 为什么要有它（而不是照 README §二 抄命令）：
#
#   · 三个 ABI 各要三个环境变量，而且名字**不是照着 target 抄的**：
#     armv7 的 clang 叫 `armv7a-linux-androideabi24-clang`（比 target 多一个 `a`），
#     而变量名叫 `CC_armv7_linux_androideabi`（没有那个 `a`）。抄错一次的代价是
#     **几分钟的编译之后**才看到一句 `can't find crate for std`。
#   · 顺序是有意义的：**.so 必须在 Gradle 之前搬进 `jniLibs/`**。搬晚了，这一版 APK
#     就没有原生库 —— 而它编得过、装得上、图标点得开，只在 `loadLibrary` 那一步炸。
#   · 少了哪个 ABI 要说出来。`build.gradle.kts` 的 `abiFilters` 列了三个，
#     **它不会替你检查 `jniLibs/` 里是不是真有那三个目录**。
#
# ⚠️★ **怎么判断「某个 ABI 的 `.so` 根本没编」**：`rustup target add` 没做过时，
#   下面那个循环是**跳过**它、然后照常走到 Gradle（因为 Gradle 只看 `jniLibs/`，
#   而 `abiFilters` 也不会替它检查）。在**本机**那是方便（只为冒烟编一个 ABI），
#   在 **CI** 上就是「绿着出一个缺原生库的包」——所以那边必须加 `--require-all`。
#
# ⚠️ 本机没有 `gradle` CLI，只有 wrapper —— 一律 `./gradlew`。
# ⚠️ 本机有**两个** rust：只有 `$HOME/.cargo/bin` 那个（rustup）装了 android target。
#
# 兼容性：按 **bash 3.2**（macOS 自带那版）写 —— 没有关联数组、没有 `${var^^}`。
# 别为了「好看」换成这两样：换了之后在别人的 Mac 上会以一句 `declare: -A: invalid option` 挂掉。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# ── 参数 ──────────────────────────────────────────────────────────────────────
# abi|target|clang          （⚠️ 这张表与 sync-android-jni-libs.mjs 的 TARGETS 必须一致）
TARGETS='arm64-v8a|aarch64-linux-android|aarch64-linux-android24-clang
armeabi-v7a|armv7-linux-androideabi|armv7a-linux-androideabi24-clang
x86_64|x86_64-linux-android|x86_64-linux-android24-clang'

GRADLE_TASK='assembleDebug'
ONLY_ABI=''
RUN_GRADLE=1
PRINT_ONLY=0
# ⚠️ 默认 0 = 本机口径（缺 target 就跳过那个 ABI，方便只为冒烟编一个）。
#    CI 一律传 `--require-all`。见文件抬头那段。
REQUIRE_ALL=0
GRADLE_ARGS=()

# ⚠️ 用**两个锚点**取用法，别写行号 —— 加一行表头就会让 `--help` 少印一段，
# 而那是个不会响的错（`tools/shell-smoke.mjs` 里那条判据就是为这类事设的）。
usage() {
    sed -n '/^# 用法（/,/^# 为什么要有它/p' "${BASH_SOURCE[0]}" \
        | grep -v '^# 为什么要有它' \
        | sed -e 's/^# \{0,1\}//' -e 's/^#$//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --abi)
            [ $# -ge 2 ] || { echo "✗ --abi 后面要跟一个 ABI" >&2; exit 2; }
            ONLY_ABI="$2"
            shift 2
            ;;
        --release)
            GRADLE_TASK='assembleRelease'
            shift
            ;;
        --debug)
            GRADLE_TASK='assembleDebug'
            shift
            ;;
        --no-gradle)
            RUN_GRADLE=0
            shift
            ;;
        --require-all)
            REQUIRE_ALL=1
            shift
            ;;
        --print)
            PRINT_ONLY=1
            shift
            ;;
        --)
            shift
            while [ $# -gt 0 ]; do GRADLE_ARGS+=("$1"); shift; done
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "✗ 不认识的参数：$1（--help 看用法）" >&2
            exit 2
            ;;
    esac
done

# ⚠️ `--abi` 拼错时要**当场退出**：不能过滤出 0 个目标然后说「都编好了」。
if [ -n "$ONLY_ABI" ] && ! printf '%s\n' "$TARGETS" | cut -d'|' -f1 | grep -qx "$ONLY_ABI"; then
    echo "✗ 不认识的 ABI：$ONLY_ABI" >&2
    echo "  可用的：$(printf '%s\n' "$TARGETS" | cut -d'|' -f1 | tr '\n' ' ')" >&2
    exit 2
fi

say() { printf '\n== %s ==\n' "$1"; }

# ── 工具链：rustup 那个 cargo ─────────────────────────────────────────────────
# ⚠️ 必须**前插** `$HOME/.cargo/bin`：Homebrew 那个 rust 也在 PATH 里
#（通常还在前面），它没有 android target，会给出 `can't find crate for std`。
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
    echo "✗ 找不到 cargo。装 rustup，或者把 \$HOME/.cargo/bin 放进 PATH。" >&2
    exit 1
fi
CARGO_BIN="$(command -v cargo)"
case "$CARGO_BIN" in
    "$HOME/.cargo/bin/"*) ;;
    *) echo "⚠️  现在用的是 $CARGO_BIN —— 不是 rustup 那一个（$HOME/.cargo/bin/cargo）。" >&2
       echo "   它多半没有 android target，构建会在 'can't find crate for std' 停下。" >&2 ;;
esac

# ── NDK ──────────────────────────────────────────────────────────────────────
# 优先级：显式环境变量 → SDK 下的 `ndk/` 里版本号最大的那个。
#
# ⚠️★ 候选根里**必须有 Linux 的**：这一段原来是照 macOS 写的（只有
#    `~/Library/Android/sdk`），拿到 ubuntu runner 上会报「没找到 NDK」——
#    而 GitHub 的 runner 上其实装着好几个（Android SDK 在 `/usr/local/lib/android/sdk`，
#    由 `ANDROID_SDK_ROOT` / `ANDROID_HOME` 指出来）。
if [ -n "${ANDROID_NDK_HOME:-}" ]; then
    NDK="$ANDROID_NDK_HOME"
elif [ -n "${ANDROID_NDK_ROOT:-}" ]; then
    NDK="$ANDROID_NDK_ROOT"
else
    # ⚠️ 换行分隔的候选根（bash 3.2 没有关联数组；这里也用不上）。
    #    `${VAR:-}` 是必须的 —— 直接写 `$ANDROID_SDK_ROOT` 在 `set -u` 下会当场挂掉。
    NDK_SDK_ROOTS="${ANDROID_SDK_ROOT:-}
${ANDROID_HOME:-}
$HOME/Library/Android/sdk
$HOME/Android/Sdk"
    NDK=""
    while IFS= read -r sdk_root; do
        # 空行是上面那几个没设的变量留下的，跳过。
        [ -n "$sdk_root" ] || continue
        # NDK 的目录名就是版本号；用 `sort` 取最后一个（两段式的版本号按字典序也是对的）。
        cand="$(ls -d "$sdk_root"/ndk/* 2>/dev/null | sort | tail -1 || true)"
        if [ -n "$cand" ] && [ -d "$cand" ]; then
            NDK="$cand"
            break
        fi
    done <<EOF
$NDK_SDK_ROOTS
EOF
fi
if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then
    echo "✗ 没找到 NDK。找过（按这个顺序）：" >&2
    echo "    \$ANDROID_NDK_HOME、\$ANDROID_NDK_ROOT、" >&2
    echo "    \${ANDROID_SDK_ROOT:-}/ndk/*、\${ANDROID_HOME:-}/ndk/*、" >&2
    echo "    \$HOME/Library/Android/sdk/ndk/*、\$HOME/Android/Sdk/ndk/*" >&2
    echo "  装一个（macOS）：\$HOME/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager 'ndk;27.3.13750724'" >&2
    echo "  或者把 ANDROID_NDK_HOME 指到已有的那一个。" >&2
    exit 1
fi
# prebuilt 的宿主目录名随 NDK 而变（darwin-x86_64 / linux-x86_64），不写死。
NDK_BIN="$(ls -d "$NDK"/toolchains/llvm/prebuilt/*/bin 2>/dev/null | head -1 || true)"
if [ -z "$NDK_BIN" ] || [ ! -x "$NDK_BIN/llvm-ar" ]; then
    echo "✗ $NDK 里没有 toolchains/llvm/prebuilt/*/bin（或者里面没有 llvm-ar）。" >&2
    exit 1
fi
echo "NDK      $NDK"
echo "cargo    $CARGO_BIN"

# ── 交叉编 .so ───────────────────────────────────────────────────────────────
# ⚠️ 一律 `--release`：Rust 的 profile 与 Gradle 的 debug/release **没有关系**，
# 而 debug 出来的 .so 大十倍、还慢（它对每个 ABI 都要编一遍整个服务端）。
#
# ⚠️★ 改本文件里的消息时：变量**后面紧跟全角字符**（全角括号、全角冒号、全角逗号）的，
# 必须写成带花括号的形式 —— bash 会把那个全角字符当成变量名的一部分，`set -u` 下报一句
# 看不懂的 `unbound variable`（报出来的名字里还带着那个全角字节）。
# `tools/shell-smoke.mjs` 会把这件事兜住；这里写一遍是为了让改的人先看到。
SKIPPED=""
BUILT=""

while IFS='|' read -r abi target clang; do
    [ -n "$abi" ] || continue
    if [ -n "$ONLY_ABI" ] && [ "$ONLY_ABI" != "$abi" ]; then
        continue
    fi

    clang_path="$NDK_BIN/$clang"
    if [ ! -x "$clang_path" ]; then
        echo "✗ ${abi}：$NDK_BIN 里没有 $clang" >&2
        echo "  这个 ABI 的 clang 名字对不上 NDK 里的实际文件名，别照着 target 瞎猜。" >&2
        exit 1
    fi

    # 变量名由 target 推出（`-` → `_`），别手抄：
    #   CC_aarch64_linux_android / AR_aarch64_linux_android /
    #   CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
    und="$(printf '%s' "$target" | tr '-' '_')"
    up="$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')"
    cc_var="CC_$und"
    ar_var="AR_$und"
    linker_var="CARGO_TARGET_${up}_LINKER"

    # rustup 装没装这个 target。⚠️ 在 rust/ 里问：rust-toolchain.toml 会覆盖工具链，
    # 而「装在哪条工具链上」正是不一致时最难看懂的那种失败。
    installed=1
    if ! (cd "$ROOT/rust" && rustup target list --installed 2>/dev/null | grep -qx "$target"); then
        installed=0
    fi

    say "${abi}（${target}）"
    if [ "$PRINT_ONLY" = 1 ]; then
        printf 'export %s=%s\n' "$cc_var" "$clang_path"
        printf 'export %s=%s\n' "$ar_var" "$NDK_BIN/llvm-ar"
        printf 'export %s=%s\n' "$linker_var" "$clang_path"
        printf 'cargo build -p clip9-android --release --target %s\n' "$target"
        if [ "$installed" = 0 ]; then
            echo "⚠️  这个 target 没装：rustup target add $target"
        fi
        continue
    fi

    if [ "$installed" = 0 ]; then
        echo "· 跳过 ${abi}：target $target 没装。"
        echo "  装它（要联网，约 30 MB）：rustup target add $target"
        if [ "$REQUIRE_ALL" = 1 ]; then
            echo "✗ --require-all：这个 ABI 在范围内，不能跳过。" >&2
            echo "  它要是被跳过，Gradle 照样会编出一个**缺这个 ABI 原生库**的包 ——" >&2
            echo "  \`abiFilters\` 只过滤、不检查 \`jniLibs/\` 里有没有东西。先装 target 再来。" >&2
            exit 1
        fi
        SKIPPED="$SKIPPED $abi"
        continue
    fi

    # ⚠️ 这三个变量与 cargo 在**同一条命令里**（`export` 在当前 shell 就够 ——
    # README §二 里那句「同一条命令」是给交互式敲命令的人看的）。
    export "$cc_var"="$clang_path"
    export "$ar_var"="$NDK_BIN/llvm-ar"
    export "$linker_var"="$clang_path"

    if ! (cd "$ROOT/rust" && cargo build -p clip9-android --release --target "$target"); then
        echo "✗ ${abi}（${target}）编不过 —— 上面就是 cargo 的原话。" >&2
        exit 1
    fi
    BUILT="$BUILT $abi"
done <<EOF
$TARGETS
EOF

if [ "$PRINT_ONLY" = 1 ]; then
    say "同步（--print 模式，没执行）"
    echo 'node tools/sync-android-jni-libs.mjs'
    if [ "$RUN_GRADLE" = 1 ]; then
        say "Gradle（--print 模式，没执行）"
        printf 'cd android && ./gradlew %s\n' "$GRADLE_TASK"
    fi
    exit 0
fi

# ── 搬进 jniLibs/ ────────────────────────────────────────────────────────────
say "同步到 jniLibs/"
if ! command -v node >/dev/null 2>&1; then
    echo "✗ 找不到 node（同步脚本是 .mjs）。" >&2
    exit 1
fi
(cd "$ROOT" && node tools/sync-android-jni-libs.mjs)

# ── 缺哪个 ABI：说清楚，别让它变成设备上的一句 UnsatisfiedLinkError ───────────
MISSING=""
while IFS='|' read -r abi target clang; do
    [ -n "$abi" ] || continue
    # ⚠️ 与上面的编译循环同样要按 `--abi` 过滤：不然用 `--abi arm64-v8a --require-all`
    #    时会把另外两个**根本没要**的 ABI 报成「没有 .so」，然后拒绝退出。
    if [ -n "$ONLY_ABI" ] && [ "$ONLY_ABI" != "$abi" ]; then
        continue
    fi
    [ -f "$ROOT/android/app/src/main/jniLibs/$abi/libclip9_android.so" ] || MISSING="$MISSING $abi"
done <<EOF
$TARGETS
EOF

if [ -n "$MISSING" ]; then
    say "⚠️  这些 ABI 没有 .so"
    echo "  $MISSING"
    echo "  而 app/build.gradle.kts 的 abiFilters 里列着它们 —— 所以在那几个 ABI 上"
    echo "  装出来的 APK 会在 System.loadLibrary 那一步炸（编得过、装得上、点得开）。"
    echo "  补法：rustup target add x86_64-linux-android    # 只有模拟器那个要另外装 target"
    echo "        只想要一个 ABI 的冒烟包，就把 abiFilters 里另外两个删掉。"
    if [ "$REQUIRE_ALL" = 1 ]; then
        echo "✗ --require-all：上面的 ABI 是**范围内**的，一个都不能缺。" >&2
        echo "  （\`sync-android-jni-libs.mjs\` 找不到对应 target 产物时的表现是「跳过」，" >&2
        echo "   不是失败 —— 所以这里要自己判一次。）" >&2
        exit 1
    fi
fi

# ── Gradle ───────────────────────────────────────────────────────────────────
if [ "$RUN_GRADLE" = 1 ]; then
    say "./gradlew $GRADLE_TASK"
    # ⚠️ SDK 位置由 android/local.properties 提供（那个文件不进仓库）；
    # 这里再兜一句 ANDROID_HOME，免得换机器时撞「SDK location not found」。
    export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
    ( cd "$ROOT/android" && ./gradlew "$GRADLE_TASK" "${GRADLE_ARGS[@]+"${GRADLE_ARGS[@]}"}" )
    if [ -d "$ROOT/android/app/build/outputs/apk" ]; then
        say "产物"
        find "$ROOT/android/app/build/outputs/apk" -name '*.apk' -exec ls -lh {} \;
    fi
fi

say "完成（编出：${BUILT:-无}${SKIPPED:+；跳过：$SKIPPED}）"

# ⚠️★ 别在本项目的沙箱里跑这个脚本：Gradle 会**批量建目录**（一次几百个），
# 而沙箱按目录记账 —— 规则表撑大之后**每条命令都会被 SIGTERM**（连 `echo` 都不行，
# 看起来像「shell 坏了」）。要跑就在普通终端里跑。
