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
#   4. **前端不在这里变成一份单独的资源**。Go 那边要把 `web/dist` 拷到
#      `cloud-clip/lib/static` 再 `-tags embed`；这边前端产物是**编进 `clip9-server`
#      二进制**的（`rust/crates/server/build.rs` + `rust/crates/server/static/`），
#      所以这里只负责「先把前端产物同步好」，剩下的交给 cargo。
#      ⚠️★ 忘了同步**完全没有症状**（编得过、测试也基本绿）—— 唯一钉着它的是
#      `tools/sync-web-assets.mjs --check`，所以下面把 `--check` 当成一道硬闸。
#      ⚠️★ 2026-10-13：产物**不再入库**（见 `.gitignore`）—— 不传 `--skip-web` 时这里
#      自己 `npm run build` + 同步；传了就必须有人**先把产物准备好**，否则下面那道
#      `--check` 会红（这正是它该有的行为）。
#
# 用法:
#   ./build.sh                          # 版本号取 rust/Cargo.toml 的 [workspace.package]
#   ./build.sh 0.1.0-beta2              # 指定版本号（发布用）
#   ./build.sh 0.1.0-beta2 --skip-web   # 跳过前端构建（产物已经由别处准备好时用，快很多）
#   ./build.sh 0.1.0-beta2 --with-noui  # 额外编一套**不带界面**的（给 flash 很小的设备）
#
# ⚠️★ `--with-noui` 是**可选**的，不是默认：那套要再把三个 target 各编一次（几十分钟），
#    本机平时只需要带界面的那份。CI 的 `openwrt.yml` 会传它。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENWRT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$OPENWRT_DIR")"
RUST_DIR="$REPO_DIR/rust"
WEB_DIR="$REPO_DIR/web"

VERSION=""
SKIP_WEB=0
WITH_NOUI=0
for arg in "$@"; do
    case "$arg" in
        --skip-web) SKIP_WEB=1 ;;
        --with-noui) WITH_NOUI=1 ;;
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
        echo "--- 构建前端（web）---"
        # ⚠️ `CODEBUDDY_SAFE_DELETE_ENABLED=0`：构建要清 `dist/`，不给这个变量会被
        # 删除守卫拦下来。
        ( cd "$WEB_DIR" && CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build )
        ( cd "$REPO_DIR" && node tools/sync-web-assets.mjs )
    else
        echo "! 跳过前端构建（没有 web 或没有 node/npm），改用已经同步好的那一份"
    fi
fi

# ⚠️★ 这道闸必须留着：前端产物**编在二进制里**，不同步的话编出来的是旧界面，
# 而编译、测试全都不会红 —— 见文件头第 4 条。
# ⚠️ 产物不再入库（2026-10-13），所以走到这里它**必须**已经存在：要么上面第 1 节刚构建过，
# 要么 `--skip-web` 的调用方已经准备好。不存在时它当场红，不会静默编出一个没界面的二进制。
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
    # ⚠️★ `CLIP9_VERSION` 是**必须**传的：不传的话二进制里那个版本号来自
    # `rust/Cargo.toml` 的 `[workspace.package] version`（两次发布之间不会变），
    # 于是**每一个 ipk 里的二进制都自称同一个数**。
    # ⚠️★ 后果不是「显示不好看」：LuCI 的「检查更新」跑的是 `<二进制> -v`，
    # 拿它跟 GitHub 的 `/releases/latest` 比 —— 当前版本恒定的话，
    # 用户升级到新正式版之后会被**永远提示有新版本，而且升级修不掉**。
    # 2026-10-02 在 OpenWrt 容器里真装上才发现（`/usr/bin/clip9-server -v` 报 0.1.0，
    # 而 `opkg list-installed` 报 0.1.1-beta3）。
    # ⚠️ `$VERSION` 本来就**不带 `v`**（与包名/包版本同形），别再动它。
    ( cd "$RUST_DIR" && CARGO_TARGET_DIR="$CROSS_TARGET_DIR_PREFIX$target" \
        RUSTFLAGS="-C strip=symbols" \
        CLIP9_VERSION="$VERSION" \
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
    # ⚠️★ 裸二进制的名字里 `v<版本>` 紧跟在 `clip9-server` 之后 —— 与发布出去的那几组
    #    产物同一条规则（见 `.github/workflows/release.yml` 的文件头）。
    #    ⚠️ 这个文件**不是资产**，它只是给 ipk / apk 两个打包脚本当输入；
    #    但 `package-openwrt*.sh` 按名字找它，所以三处必须一起改。
    # ⚠️★ 验一下版本号**真的注进去了**：`CLIP9_VERSION` 没生效时**不会报错**，
    #    二进制只会安静地回落到 `Cargo.toml` 里那个常量 —— 而那正是要修的病
    #    （LuCI 的「检查更新」跑 `<二进制> -v`，回落之后用户升级完仍被提示有新版本）。
    #    ⚠️ `-a` 不能省：macOS 的 BSD `strings` 默认只扫 object 段，对 ELF 会捞不到。
    if [ -n "$src" ] && ! strings -a "$src" | grep -qF "$VERSION"; then
        echo "错误: $src 里找不到版本号 $VERSION —— CLIP9_VERSION 没生效" >&2
        echo "  这个二进制会回落成 rust/Cargo.toml 里那个常量（见 clip9_server::VERSION 的注释）" >&2
        exit 1
    fi
    # ⚠️★ 同一个道理，而且更要命：前端产物**不再入库**（2026-10-13），前端没构建成功时
    #    `build.rs` 会内嵌那个「没有内嵌前端」的占位页 —— 二进制照样编得过、包装得出来、
    #    也装得上路由器，只是打开是一片「没有内嵌前端」。所以在这里按**二进制**验一次。
    #    ⚠️★ 正向那条**不能用 `data-build-id`**：`static_files.rs` 的 `extract_build_id` 里
    #    就有那个字面量，占位页那份二进制照样 grep 得到它 —— 判据会**永远绿**（实测过）。
    #    `id="app"` 才是干净的：真外壳里有 `<div id="app">`，占位页与全部 `.rs` 源码里都没有。
    if [ -n "$src" ]; then
        if strings -a "$src" | grep -qF 'clip9-no-embedded-frontend'; then
            echo "错误: $src 内嵌的是占位页 —— 前端产物没构建出来（见上面第 1 节）" >&2
            exit 1
        fi
        if ! strings -a "$src" | grep -qF 'id="app"'; then
            echo "错误: $src 里找不到 id=\"app\" —— 它内嵌的不是一份真前端产物" >&2
            exit 1
        fi
    fi
    dst="$OUTPUT_DIR/clip9-server-v$VERSION-$arch"
    if [ -z "$src" ]; then
        echo "错误: cross 跑完了，但在 $CROSS_TARGET_DIR_PREFIX$target 下找不到 release 产物" >&2
        echo "  这个 target 目录里实际的二进制（最多 20 条）：" >&2
        find "$CROSS_TARGET_DIR_PREFIX$target" -type f -name 'clip9*' 2>/dev/null | head -20 >&2 || true
        exit 1
    fi
    cp "$src" "$dst"
    echo "✓ $arch  ($(du -h "$dst" | cut -f1))  ← ${src#"$CROSS_TARGET_DIR_PREFIX"}"
done

# ── 5. 无界面变体（`--with-noui`）────────────────────────────────────────────
#
# ⚠️★ 为什么要有它：内嵌前端产物 21 MB（99 个文件），对 flash 只有 16/32 MB 的设备来说
#    那一份是装不下的。noui 的二进制不带这些静态资源，**包小一个数量级** ——
#    代价是**路由器上就没有界面了**：前端要放在别的机器上（服务端那边配 `allowOrigins`）。
#
# ⚠️★ 做法是「把 `static/` 挪走再编」：`build.rs` 在 `static/` 不存在时会内嵌那个
#    「这个二进制没带界面」的占位页（不是 panic、也不是什么都不嵌）。**不是**编完再删资源 ——
#    资源那时已经在二进制里了。
#
# ⚠️★ 挪走之后**必须放回去**：用 `trap` 兜住中途失败，否则一次失败的构建会把它留在 /tmp，
#    下一次构建就变成「没有前端产物」，而那条路会安静地编出占位页二进制。
#
# ⚠️★ 每个 target 用**独立的 target 目录**（`cross-noui-` 前缀），绝不能复用上面那三个：
#    `embedded_static.rs` 由 build.rs 写进 `OUT_DIR`，而 cargo **只按 mtime** 判断要不要
#    重跑 build script。复用极可能拿到**带界面**的那份旧产物 —— 那时 `id="app"` 的断言会红成
#    「代码写错了」的样子。独立目录 = 从零编一次，慢，但结果是确定的。
if [ "$WITH_NOUI" = 1 ]; then
    echo
    echo "--- 无界面变体（noui）：把 static/ 挪走再编 ---"
    static_dir="$RUST_DIR/crates/server/static"
    stash_dir="$(mktemp -d)"

    restore_static() {
        if [ -d "$stash_dir/static" ]; then
            mv "$stash_dir/static" "$static_dir"
            # ⚠️ `mv` 回来的目录 mtime 是**旧的** —— 不 touch 的话，之后在同一个 target 目录里
            # 再编一次时 cargo 认为 build script 不用重跑，拿到的还是占位页那份产物。
            touch "$static_dir"
        fi
        rmdir "$stash_dir" 2>/dev/null || true
    }
    trap restore_static EXIT

    if [ -d "$static_dir" ]; then
        mv "$static_dir" "$stash_dir/static"
    else
        echo "  ! 没有 static/（大概传了 --skip-web）—— 这一份编出来本来就是不带界面的"
    fi

    for target in "${TARGETS[@]}"; do
        echo "--- cross build $target (noui) ---"
        ( cd "$RUST_DIR" && CARGO_TARGET_DIR="${CROSS_TARGET_DIR_PREFIX}noui-$target" \
            RUSTFLAGS="-C strip=symbols" \
            CLIP9_VERSION="$VERSION" \
            cross build --release -p clip9-server --target "$target" )
    done

    # ── 摊平 + **反向**验收 ────────────────────────────────────────────────
    # ⚠️★ 与上面那一段正好相反：这一份**要**有占位标记、**不许**有 `id="app"`。
    #    反过来写（照抄上面）等于「把界面编回了 noui 的包里」，而包名还叫 noui。
    for entry in "${ARCH_MAP[@]}"; do
        arch="${entry%%:*}"
        target="${entry#*:}"
        src="$(find "$CROSS_TARGET_DIR_PREFIX""noui-$target" -type f -name clip9-server -path '*/release/*' -print -quit 2>/dev/null || true)"
        if [ -z "$src" ]; then
            echo "错误: 在 ${CROSS_TARGET_DIR_PREFIX}noui-$target 下找不到 release 产物" >&2
            exit 1
        fi
        if ! strings -a "$src" | grep -qF "$VERSION"; then
            echo "错误: $src 里找不到版本号 $VERSION —— CLIP9_VERSION 没生效" >&2
            exit 1
        fi
        if ! strings -a "$src" | grep -qF 'clip9-no-embedded-frontend'; then
            echo "错误: $src 里没有占位页标记 —— 它把一份前端编进去了（noui 的意义就是不带界面）" >&2
            exit 1
        fi
        if strings -a "$src" | grep -qF 'id="app"'; then
            echo "错误: $src 里带着真前端（找到了 id=\"app\"）—— 这一份不该有 static/" >&2
            exit 1
        fi
        dst="$OUTPUT_DIR/clip9-server-noui-v$VERSION-$arch"
        cp "$src" "$dst"
        echo "✓ $arch (noui)  ($(du -h "$dst" | cut -f1))"
    done

    restore_static
    trap - EXIT
fi

echo
echo "=== 完成：$OUTPUT_DIR ==="
ls -1 "$OUTPUT_DIR"/clip9-server-v"$VERSION"-*
if [ "$WITH_NOUI" = 1 ]; then
    ls -1 "$OUTPUT_DIR"/clip9-server-noui-v"$VERSION"-*
fi
