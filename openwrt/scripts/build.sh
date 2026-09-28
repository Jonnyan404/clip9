#!/bin/bash
# 构建 clip9 服务端的 OpenWrt 二进制（静态链接 musl）—— **7 个架构**。
#
# ⚠️★ 与 Go 版 `openwrt/scripts/build.sh` 的四条必要差异（都是「照抄会错」的那种）：
#
#   1. **不用 `go build`，用 `cross`**。musl 交叉编译要一个能给 musl 编 C 的编译器
#      （`aws-lc-sys` 里有 C 代码），而宿主机上**没有**那个工具链 —— 直接用 `cargo`
#      会报 `failed to find tool "x86_64-linux-musl-gcc"`，那是一个**看着像代码写错**的错。
#      CI（`.github/workflows/release.yml` 的 linux job）用的就是 `cross`。
#      ⚠️★ 所以这里**宁可报错，也不静默回落到宿主机 `cargo`**：回落会编出一个
#      宿主机的二进制，而后面每一步（打包、装到路由器）都看不出它不是 musl
#      （文件名一样、包也能打出来）。CI 那边专门为这件事留了一条
#      「到底有没有真的进容器」的判据，是同一类问题。
#
#   2. **3 次构建出 7 个二进制**。Go 是「一个架构一次 go build」共 10 次；这边 armv7
#      那一份**被 5 个 OpenWrt 架构名共用** —— `arm_cortex-a5/a7/a8/a9/a15_neon-vfpv4`
#      是同一套 EABI 硬浮点 ABI，而**静态**二进制不跨 userland 的软/硬浮点边界
#      （所以一份就能装上去）。少了这一步会白编 4 次，每次好几分钟。
#
#   3. **去掉了 mips / mipsel**（Jonny 2026-09-28：「未来这种架构应该也不多」）。
#      ⚠️ 顺手把原因记在这儿：`mips-unknown-linux-musl` 在 Rust 里是 **Tier 3**，
#      rustup **装不上**（`rust/rust-toolchain.toml` 的注释里写的就是这件事）——
#      想支持得自己编 std，不是「在列表里加一行」的事。
#
#   4. **前端不在这里变成一份单独的资源**。Go 那边要把 `web-vue3/dist` 拷到
#      `cloud-clip/lib/static` 再 `-tags embed`；这边前端产物是**编进 `clip9-server`
#      二进制**的（`rust/crates/server/build.rs` + `rust/crates/server/static/`），
#      所以这里只负责「先把前端产物同步好」，剩下的交给 cargo。
#      ⚠️★ 忘了同步**完全没有症状**（编得过、测试也基本绿）—— 唯一钉着它的是
#      `tools/sync-web-assets.mjs --check`，所以下面把 `--check` 当成一道硬闸。
#
# 用法:
#   ./build.sh                          # 版本号取 rust/Cargo.toml 的 [workspace.package]
#   ./build.sh 0.1.0-beta2              # 指定版本号（发布用）
#   ./build.sh 0.1.0-beta2 --skip-web   # 跳过前端构建（产物已经同步过时用，快很多）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENWRT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$OPENWRT_DIR")"
RUST_DIR="$REPO_DIR/rust"
WEB_DIR="$REPO_DIR/web-vue3"

VERSION=""
SKIP_WEB=0
for arg in "$@"; do
    case "$arg" in
        --skip-web) SKIP_WEB=1 ;;
        *) VERSION="$arg" ;;
    esac
done

if [ -z "$VERSION" ]; then
    # ⚠️ 取的是 `[workspace.package]` 里那一个 `version` —— 各成员的 `Cargo.toml` 写的是
    # `version.workspace = true`，所以只有这一处是真值（别去各 crate 里再找一遍）。
    VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$RUST_DIR/Cargo.toml" | head -1)"
fi
if [ -z "$VERSION" ]; then
    echo "错误: 拿不到版本号（既没给参数，也没能在 $RUST_DIR/Cargo.toml 里找到 version）" >&2
    exit 1
fi

OUTPUT_DIR="$OPENWRT_DIR/build"
mkdir -p "$OUTPUT_DIR"

echo "=== 构建 clip9 服务端（OpenWrt）版本: $VERSION ==="

# ── 0. 工具检查 ────────────────────────────────────────────────────────────
# ⚠️ 先查再说，别等编到一半才发现 —— `cross` 缺了的话，第一次失败会发生在
#    「aws-lc-sys 要 C 编译器」那里，报的错跟「cross 没装」看起来没关系。
if ! command -v cross >/dev/null 2>&1; then
    cat >&2 <<'EOF'
错误: 找不到 `cross`。

musl 交叉编译需要一个能给 musl 编 C 的编译器（aws-lc-sys 里有 C 代码），
宿主机上没有 —— 必须走容器：

    cargo install cross --locked          # 需要本机有可用的 Docker

⚠️ 这里**故意不回落**到宿主机的 `cargo`：那会编出宿主机的二进制，
   而后面每一层（打包、装到路由器）都看不出它不是 musl。
EOF
    exit 1
fi

# ── 1. 前端产物 ────────────────────────────────────────────────────────────
if [ "$SKIP_WEB" -eq 0 ]; then
    if [ -d "$WEB_DIR" ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
        echo "--- 构建前端（web-vue3）---"
        # ⚠️ `CODEBUDDY_SAFE_DELETE_ENABLED=0`：构建要清 `dist/`，不给这个变量会被
        # 删除守卫拦下来。
        ( cd "$WEB_DIR" && CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build )
        ( cd "$REPO_DIR" && node tools/sync-web-assets.mjs )
    else
        echo "! 跳过前端构建（没有 web-vue3 或没有 node/npm），改用已经同步好的那一份"
    fi
fi

# ⚠️★ 这道闸必须留着：前端产物**编在二进制里**，不同步的话编出来的是旧界面，
# 而编译、测试全都不会红 —— 见文件头第 4 条。
echo "--- 校验前端产物与源码指纹一致 ---"
( cd "$REPO_DIR" && node tools/sync-web-assets.mjs --check )

# ── 2. 架构表 ──────────────────────────────────────────────────────────────
# `OpenWrt 架构名:cargo target`。⚠️ 5 个 arm 名字指向同一个 target —— 见文件头第 2 条。
ARCH_MAP=(
    "x86_64:x86_64-unknown-linux-musl"
    "arm_cortex-a5:armv7-unknown-linux-musleabihf"
    "arm_cortex-a7:armv7-unknown-linux-musleabihf"
    "arm_cortex-a8:armv7-unknown-linux-musleabihf"
    "arm_cortex-a9:armv7-unknown-linux-musleabihf"
    "arm_cortex-a15_neon-vfpv4:armv7-unknown-linux-musleabihf"
    "aarch64:aarch64-unknown-linux-musl"
)

# 去重后的 target 列表（顺序稳定，便于看日志）
TARGETS=()
for entry in "${ARCH_MAP[@]}"; do
    t="${entry#*:}"
    found=0
    for x in ${TARGETS[@]+"${TARGETS[@]}"}; do [ "$x" = "$t" ] && found=1; done
    [ "$found" -eq 0 ] && TARGETS+=("$t")
done

# ── 3. 交叉构建 ────────────────────────────────────────────────────────────
# ⚠️ `-C strip=symbols`：OpenWrt 设备 flash 很小，符号表动辄几 MB。
#    用 rustc 自己的 strip 而不是外部 `strip` —— 交叉目标上通常没有对应的 strip 工具。
#
# ⚠️★ **每个 target 单独一个 target 目录**（下面是唯一那处定义，第 4 步拼产物路径也用它）。
#    这不是洁癖，是**必须**：三个 target 串在**同一个 job** 里跑，而 `cross` 给每个 target
#    用的镜像是**不同**的，glibc 也不一样高。**宿主**构建脚本（build script / proc macro）
#    落在**共用**的 `target/release/` 里 —— 在 glibc 高的镜像里编出来的那个二进制，
#    会被 glibc 低的镜像**直接拿去执行**（cargo 认为它还是新鲜的），于是：
#
#      error: failed to run custom build command for `libc v0.2.189`
#        /target/release/build/libc-…/build-script-build:
#        version `GLIBC_2.28' not found (required by …)      ← 还有 2.29 / 2.30
#        ##[error]Process completed with exit code 101.
#
#    ⚠️★ 2026-09-28 真在 CI 上红过，而且**极容易认错**：报的是 `libc` 的 build script，
#    看着像依赖/代码问题 —— 其实是交叉工具链的已知毛病 **cross-rs/cross#724**。
#    那个 issue 里的复现步骤与本文件**一模一样**（先 x86_64-unknown-linux-musl、
#    再 aarch64-unknown-linux-musl，第二个就炸），维护者的解释就是上面这段；
#    同 issue 里明确写了 **`cargo clean` 不管用**，要「分开 target 目录」。
#    ⚠️ `release.yml` 的 linux job 没有这个问题，因为它**一个 target 一个 job**、
#    各自一份缓存 —— 那个形状本来就是对的，这里只是把同一件事在单 job 里补上。
#    ⚠️ 顺序也会骗人：这次 x86_64 与 armv7 都过了、只挂在第三个上。换个顺序会换一个
#    target 倒，**别**据此以为是那个架构特有的问题。
CROSS_TARGET_DIR_PREFIX="$RUST_DIR/target/cross-"

for target in "${TARGETS[@]}"; do
    echo "--- cross build $target ---"
    ( cd "$RUST_DIR" && CARGO_TARGET_DIR="$CROSS_TARGET_DIR_PREFIX$target" \
        RUSTFLAGS="-C strip=symbols" \
        cross build --release -p clip9-server --target "$target" )
done

# ── 4. 摊平成 7 个 OpenWrt 架构名 ───────────────────────────────────────────
for entry in "${ARCH_MAP[@]}"; do
    arch="${entry%%:*}"
    target="${entry#*:}"
    # ⚠️★ 产物**别按写死的路径去取**：cargo 在 `--target` 模式下会在 target 目录里
    #    **再套一层 `<triple>/`**，所以 `CARGO_TARGET_DIR` 底下真实位置是
    #    `<triple>/release/clip9-server` —— cross 自己的 FAQ 示例里那两层也看得见
    #    （`ls target/build/<triple>/<triple>/debug/`）。
    #
    #    ⚠️★ 2026-09-28 在 CI 上真红过，症状**极具欺骗性**：cross 明明编完了、
    #    `Finished release profile [optimized] target(s) in 1m 57s` 也打出来了，
    #    紧接着却报「找不到产物」—— 因为脚本拼的是 `.../$target/release/clip9-server`
    #    （少一层）。当时第一反应是「cross 没把产物挂载回来」，**那是错的**：
    #    cross 会无条件把宿主的 target 目录挂到容器 `/target`（`src/docker/local.rs`，
    #    源里就一句 `-v {host_target}:/target`），产物一直都在宿主上。
    #
    #    改成在**该 target 自己的目录里找**，不再猜中间那几层；找不到时把目录里
    #    有什么一并打出来（比一句「找不到」有用得多）。
    src="$(find "$CROSS_TARGET_DIR_PREFIX$target" -type f -name clip9-server -path '*/release/*' -print -quit 2>/dev/null || true)"
    dst="$OUTPUT_DIR/clip9-server-$VERSION-$arch"
    if [ -z "$src" ]; then
        echo "错误: cross 跑完了，但在 $CROSS_TARGET_DIR_PREFIX$target 下找不到 release 产物" >&2
        echo "  这个 target 目录里实际的二进制（最多 20 条）：" >&2
        find "$CROSS_TARGET_DIR_PREFIX$target" -type f -name 'clip9*' 2>/dev/null | head -20 >&2 || true
        exit 1
    fi
    cp "$src" "$dst"
    echo "✓ $arch  ($(du -h "$dst" | cut -f1))  ← ${src#"$CROSS_TARGET_DIR_PREFIX"}"
done

echo
echo "=== 完成：$OUTPUT_DIR ==="
ls -1 "$OUTPUT_DIR"/clip9-server-"$VERSION"-*
