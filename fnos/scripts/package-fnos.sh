#!/bin/bash
# 打飞牛 fnOS 的应用包（`.fpk`）—— **x86 与 arm 各一个**。
#
# `.fpk` 就是 tar.gz（没有任何专有格式），里面是：
#
#   manifest              元数据（version / platform / checksum 由本脚本改写）
#   ICON.PNG  ICON_256.PNG  64 / 256 的图标
#   clip9.sc              端口声明
#   cmd/service-setup     起停脚本（`TRIM_APPDEST` / `TRIM_PKGVAR` 由平台注入）
#   config/privilege      run-as: package（非 root）
#   config/resource       端口声明文件 + 把数据目录暴露成「文件管理」里的共享文件夹
#   ui/config  ui/images/ 桌面入口
#   app.tgz               应用本体：`bin/clip9-cli` + `ui/`
#
# ⚠️★ 这里**不编译**任何东西：用的是 Release 里那两个已经编好的 musl 静态二进制
#    （`clip9-cli-v<ver>-linux-x86_64.tar.gz` / `-linux-aarch64.tar.gz`）。
#    与 Dockerfile 同一个道理 —— 镜像与安装包里都该是**发出去的那一份**，不是本机另编一份。
#    所以本脚本可以在任何有 tar 的机器上跑，不需要 Rust 工具链。
#
# 用法:
#   ./package-fnos.sh                        # 版本取 rust/Cargo.toml 的 workspace 版本
#   ./package-fnos.sh --version v0.2.0       # 指定版本（发布用）
#   ./package-fnos.sh --in <目录>            # 从已有的 tar.gz 里取二进制（CI 传 artifact 目录）
#   ./package-fnos.sh --out <目录>           # 产物放哪（默认 fnos/build）
#   ./package-fnos.sh --verify <x.fpk>       # 只验一个已经打好的包
#
# ⚠️ 每个包打完之后**当场自检**（结构 / manifest 的 checksum / 二进制架构），
#    因为这三样坏掉都不会让安装报错 —— 会装上去、点不开、或者点开是别的架构的二进制。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FNOS_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$FNOS_DIR")"

VERSION=""
IN_DIR=""
OUT_DIR="$FNOS_DIR/build"
VERIFY_ONLY=""

# 平台名（manifest 里的 `platform`）→ Release 产物名里那个短标签。
# ⚠️ 两个都要改才对：`platform` 是**包**的字段，标签是**文件名**的一部分。
PLATFORMS="x86:linux-x86_64 arm:linux-aarch64"

say() { printf '%s\n' "$*" >&2; }
die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
    --version)
        VERSION="${2:-}"
        shift 2
        ;;
    --in)
        IN_DIR="${2:-}"
        shift 2
        ;;
    --out)
        OUT_DIR="${2:-}"
        shift 2
        ;;
    --verify)
        VERIFY_ONLY="${2:-}"
        shift 2
        ;;
    -h | --help)
        sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *) die "不认识的参数：$1" ;;
    esac
done

# ── 自检：一个打好（或刚打好）的包 ────────────────────────────────────────────
#
# ⚠️ 四条判据都对着「坏掉也不报错」的那种坏法：
#   ① 少了 `ui/` → 装得上、跑得起来、桌面**没有图标**；
#   ② `checksum` 与 `app.tgz` 对不上 → 有的版本会直接装不上，有的版本装上了才在解包时炸；
#   ③ `app.tgz` 里没有 `bin/clip9-cli` → 服务起不来，日志只有一句「找不到命令」；
#   ④ 架构标错 → 装在 x86 上的是 arm 的二进制，`Exec format error`。
verify_fpk() {
    local fpk="$1" want_platform="${2:-}" tmp rc=0
    [ -f "$fpk" ] || die "没有这个文件：$fpk"
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT

    tar -xzf "$fpk" -C "$tmp" || die "解不开 ${fpk}（它应该是一个 tar.gz）"

    local need
    for need in manifest ICON.PNG ICON_256.PNG clip9.sc cmd/service-setup \
        config/privilege config/resource ui/config ui/images/64.png app.tgz; do
        if [ ! -e "$tmp/$need" ]; then
            say "✗ $(basename "$fpk")：缺 $need"
            rc=1
        fi
    done

    # manifest 的三格 + checksum
    local ver plat sum
    ver="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$tmp/manifest" | tr -d '[:space:]')"
    plat="$(sed -n 's/^platform[[:space:]]*=[[:space:]]*//p' "$tmp/manifest" | tr -d '[:space:]')"
    sum="$(sed -n 's/^checksum[[:space:]]*=[[:space:]]*//p' "$tmp/manifest" | tr -d '[:space:]')"

    case "$ver" in
    0.0.0 | "") say "✗ $(basename "$fpk")：manifest 的 version 还是占位符（${ver:-空}）" && rc=1 ;;
    esac
    case "$plat" in
    x86 | arm) ;;
    *) say "✗ $(basename "$fpk")：platform 只能是 x86 或 arm，实际 '${plat}'" && rc=1 ;;
    esac
    if [ -n "$want_platform" ] && [ "$plat" != "$want_platform" ]; then
        say "✗ $(basename "$fpk")：platform 是 ${plat}，应该是 ${want_platform}"
        rc=1
    fi

    local real_sum
    real_sum="$(md5sum "$tmp/app.tgz" 2>/dev/null | cut -d' ' -f1 || md5 -q "$tmp/app.tgz")"
    if [ "$sum" != "$real_sum" ]; then
        say "✗ $(basename "$fpk")：manifest 的 checksum=${sum:-空}，而 app.tgz 是 ${real_sum}"
        rc=1
    fi

    # app.tgz 里必须有可执行的 bin/clip9-cli
    local app_tmp="$tmp/app"
    mkdir -p "$app_tmp"
    tar -xzf "$tmp/app.tgz" -C "$app_tmp" || die "$(basename "$fpk")：app.tgz 解不开"
    if [ ! -f "$app_tmp/bin/clip9-cli" ]; then
        say "✗ $(basename "$fpk")：app.tgz 里没有 bin/clip9-cli"
        rc=1
    elif [ ! -x "$app_tmp/bin/clip9-cli" ]; then
        say "✗ $(basename "$fpk")：bin/clip9-cli 没有可执行位"
        rc=1
    else
        # ⚠️ 架构对不上是**最坏**的一种：包照样装得上，起服务时才 `Exec format error`。
        local machine
        machine="$(file -b "$app_tmp/bin/clip9-cli" | tr 'A-Z' 'a-z')"
        case "$plat" in
        x86) case "$machine" in *x86-64* | *x86_64*) ;; *) say "✗ $(basename "$fpk")：platform=x86 但二进制是 '$machine'" && rc=1 ;; esac ;;
        arm) case "$machine" in *aarch64* | *arm64*) ;; *) say "✗ $(basename "$fpk")：platform=arm 但二进制是 '$machine'" && rc=1 ;; esac ;;
        esac
    fi

    [ "$rc" = 0 ] && say "✓ $(basename "$fpk")：结构 / checksum / 架构都对（$(du -h "$fpk" | cut -f1)）"
    return "$rc"
}

if [ -n "$VERIFY_ONLY" ]; then
    verify_fpk "$VERIFY_ONLY"
    exit $?
fi

# ── 版本 ─────────────────────────────────────────────────────────────────────
if [ -z "$VERSION" ]; then
    VERSION="$(sed -n '/^\[workspace.package\]/,/^\[/p' "$REPO_DIR/rust/Cargo.toml" |
        sed -n 's/^version[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' | head -1)"
    [ -n "$VERSION" ] || die "没能从 rust/Cargo.toml 的 [workspace.package] 里读出版本号，用 --version 指定"
fi
# manifest 里的 version **不带 v**（与包管理器里那个值同形），文件名**带 v**（全仓一条规则）。
VERSION_NO_V="${VERSION#v}"
TAG="v${VERSION_NO_V}"
[ -n "$VERSION_NO_V" ] || die "版本号是空的"

say "版本：${TAG}（manifest 里写 ${VERSION_NO_V}）"

mkdir -p "$OUT_DIR"
[ -n "$IN_DIR" ] && [ ! -d "$IN_DIR" ] && die "--in 指向的目录不存在：$IN_DIR"

WORK="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$WORK'" EXIT

for entry in $PLATFORMS; do
    platform="${entry%%:*}"
    label="${entry##*:}"
    fpk_name="clip9-fnos-${TAG}-${platform}.fpk"
    tarball_name="clip9-cli-${TAG}-${label}.tar.gz"

    # ① 找到那个 Release 归档：优先 --in 给的目录，没有就当场下载（与 Dockerfile 同一个地址）。
    tarball=""
    if [ -n "$IN_DIR" ] && [ -f "$IN_DIR/$tarball_name" ]; then
        tarball="$IN_DIR/$tarball_name"
    else
        say "本地没有 ${tarball_name}，从 Release 下载…"
        curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 \
            -o "$WORK/$tarball_name" \
            "https://github.com/Jonnyan404/clip9/releases/download/${TAG}/${tarball_name}" ||
            die "下载失败：${tarball_name}（发布过这个版本吗？或者用 --in 指定目录）"
        tarball="$WORK/$tarball_name"
    fi

    stage="$WORK/stage-$platform"
    app="$WORK/app-$platform"
    rm -rf "$stage" "$app"
    mkdir -p "$stage" "$app/bin" "$app/ui"

    # ② 取出二进制。归档里那个顶层目录与归档同名，里面那个文件叫 `clip9-cli`。
    tar -xzf "$tarball" -C "$WORK" "$(basename "$tarball_name" .tar.gz)/clip9-cli"
    cp "$WORK/$(basename "$tarball_name" .tar.gz)/clip9-cli" "$app/bin/clip9-cli"
    chmod 755 "$app/bin/clip9-cli"

    # ③ 桌面入口也放进 app.tgz —— 平台从安装目录读它（顶层那份是安装时用的）。
    cp -a "$FNOS_DIR/ui/." "$app/ui/"
    tar -C "$app" -czf "$stage/app.tgz" .

    # ④ manifest：把占位符换成真的。
    # ⚠️ 只改暂存目录里那份，仓库里那份**保持占位符** —— 它是模板，改了就没法再打别的版本。
    checksum="$(md5sum "$stage/app.tgz" 2>/dev/null | cut -d' ' -f1 || md5 -q "$stage/app.tgz")"
    sed -e "s/^version[[:space:]]*=.*/version         = ${VERSION_NO_V}/" \
        -e "s/^platform[[:space:]]*=.*/platform        = ${platform}/" \
        -e "s/^checksum[[:space:]]*=.*/checksum        = ${checksum}/" \
        "$FNOS_DIR/manifest" >"$stage/manifest"

    # ⑤ 其余文件原样带进去。
    cp -a "$FNOS_DIR/cmd" "$FNOS_DIR/config" "$FNOS_DIR/ui" "$stage/"
    cp "$FNOS_DIR/ICON.PNG" "$FNOS_DIR/ICON_256.PNG" "$FNOS_DIR/clip9.sc" "$stage/"
    chmod 755 "$stage/cmd/service-setup"

    # ⑥ 打包（`.fpk` 就是 tar.gz）→ 当场自检。
    out="$OUT_DIR/$fpk_name"
    rm -f "$out"
    tar -C "$stage" -czf "$out" .
    verify_fpk "$out" "$platform"
done

say ""
say "产物："
ls -l "$OUT_DIR"/*.fpk
