#!/bin/bash
# 打包 clip9 服务端为 OpenWrt APK（OpenWrt 25.12 起用 apk 取代 opkg）
#
# ⚠️★ **APK 的架构名与二进制架构名不是一回事** —— Go 版的 README 里专门写过这一条。
#    二进制那边是「我们给产物起的通用名」（`aarch64`、`arm_cortex-a7`），
#    而 APK 的 `arch` 必须是设备上 `cat /etc/apk/arch` 的输出
#    （如 `aarch64_cortex-a53`、`arm_cortex-a7_neon-vfpv4`），
#    `apk add` 会拿它跟设备比，对不上就不装。
#    能唯一对应上的几个自动映射；对应不上的**要求显式传第三个参数**，不猜。
#
# 用法:
#   $0 <版本号> <二进制架构> [OpenWrt APK 架构]
#   $0 0.1.0 aarch64 aarch64_cortex-a53

set -euo pipefail

CONTAINER_BASE_DIR=/workspace/openwrt
USE_DOCKER_APK=0

VERSION=${1:-}
ARCH=${2:-}
PACKAGE_ARCH=${3:-${OPENWRT_PKG_ARCH:-}}

if [ -z "$VERSION" ] || [ -z "$ARCH" ]; then
    echo "用法: $0 <版本号> <二进制架构> [OpenWrt APK架构]"
    echo "二进制架构: x86_64, arm_cortex-a5, arm_cortex-a7, arm_cortex-a8, arm_cortex-a9,"
    echo "            arm_cortex-a15_neon-vfpv4, aarch64"
    echo "示例: $0 0.1.0 aarch64 aarch64_cortex-a53"
    echo "      （设备上的 APK 架构用 \`cat /etc/apk/arch\` 查）"
    exit 1
fi

# apk-tools 版本号不允许 '-' 也不允许后缀带 '.'（如 _beta.1），统一转为 _<后缀><数字>
PKG_VERSION="$(printf '%s' "$VERSION" | sed -E 's/-([a-zA-Z]+)\.([0-9]+)/_\1\2/g; s/-([a-zA-Z]+)/_\1/g; s/-/_/g')"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
BINARY="$BASE_DIR/build/clip9-server-$VERSION-$ARCH"
PKG_DIR="$BASE_DIR/build/apk-$ARCH"
ROOTFS_DIR="$BASE_DIR/ipk/rootfs"
CONTROL_DIR="$BASE_DIR/ipk/control"

# 只有「名字与设备架构完全一致」的才自动映射。其余一律要求显式传参 ——
# ⚠️ 猜错的后果不是报错，而是**装到一个架构不对的设备上**（ARM 之间能跑起来但可能踩到
#    指令集差异，那类问题在设备上表现为「莫名其妙 crash」）。
resolve_package_arch() {
    if [ -n "$PACKAGE_ARCH" ]; then
        return
    fi

    case "$ARCH" in
        x86_64|arm_cortex-a15_neon-vfpv4)
            PACKAGE_ARCH="$ARCH"
            ;;
        *)
            echo "错误: 无法从二进制架构 $ARCH 自动推断 OpenWrt APK 架构。" >&2
            echo "      两者**不是一回事** —— 请显式传入第三个参数。" >&2
            echo "      在设备上执行 \`cat /etc/apk/arch\` 得到的就是它，" >&2
            echo "      例如: $0 $VERSION $ARCH aarch64_cortex-a53" >&2
            exit 1
            ;;
    esac
}

resolve_package_arch

# ⚠️ 产物名里**不带 `server`**（2026-09-29 改的，与 `package-openwrt.sh` 的 `IPK_NAME` 同一个理由）。
# 包**里面**那个程序仍然叫 `clip9-server`。⚠️ 这个字符串同时被
# `.github/workflows/openwrt.yml`（`ls -l` 与 upload 的 path）和
# `.github/workflows/release.yml`（`publish-openwrt` 里那句 `find … -name`）认着。
APK_NAME="clip9-openwrt-apk-${PACKAGE_ARCH}-v${VERSION}.apk"

to_container_path() {
    local host_path=$1
    printf '%s\n' "${host_path/$BASE_DIR/$CONTAINER_BASE_DIR}"
}

resolve_apk_runner() {
    if command -v apk >/dev/null 2>&1; then
        return
    fi

    if command -v docker >/dev/null 2>&1; then
        USE_DOCKER_APK=1
        echo "未找到本地 apk，改用 Docker 中的 Alpine apk-tools"
        return
    fi

    echo "错误: 未找到 apk 命令，也未找到 docker。请安装 apk-tools 或 Docker。" >&2
    exit 1
}

run_apk_mkpkg() {
    if [ "$USE_DOCKER_APK" -eq 0 ]; then
        apk mkpkg "$@"
        return
    fi

    docker run --rm \
        -v "$BASE_DIR:$CONTAINER_BASE_DIR" \
        -w "$CONTAINER_BASE_DIR" \
        alpine:edge \
        sh -lc 'exec apk mkpkg "$@"' \
        sh "$@"
}

resolve_apk_runner

echo "脚本目录: $SCRIPT_DIR"
echo "根目录: $BASE_DIR"
echo "二进制文件: $BINARY"
echo "APK包架构: $PACKAGE_ARCH"

if [ ! -f "$BINARY" ]; then
    echo "错误: 找不到二进制文件 $BINARY"
    echo "请先运行 build.sh 生成它（./scripts/build.sh ${VERSION}）"
    exit 1
fi

echo "=== 打包 clip9 服务端 $VERSION 为 OpenWrt APK ($ARCH) ==="

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/etc/init.d"
mkdir -p "$PKG_DIR/etc/config"

echo "复制文件..."
cp "$BINARY" "$PKG_DIR/usr/bin/clip9-server"
chmod 755 "$PKG_DIR/usr/bin/clip9-server"

if [ -f "$ROOTFS_DIR/etc/init.d/clip9" ]; then
    cp "$ROOTFS_DIR/etc/init.d/clip9" "$PKG_DIR/etc/init.d/"
    chmod 755 "$PKG_DIR/etc/init.d/clip9"
    echo "✓ 已复制初始化脚本"
else
    echo "错误: 找不到初始化脚本（$ROOTFS_DIR/etc/init.d/clip9）" >&2
    exit 1
fi

if [ -f "$ROOTFS_DIR/etc/config/clip9" ]; then
    cp "$ROOTFS_DIR/etc/config/clip9" "$PKG_DIR/etc/config/"
    echo "✓ 已复制配置文件"
else
    echo "错误: 找不到配置文件（$ROOTFS_DIR/etc/config/clip9）" >&2
    exit 1
fi

if [ ! -f "$CONTROL_DIR/postinst" ] || [ ! -f "$CONTROL_DIR/prerm" ]; then
    echo "错误: 找不到安装脚本模板" >&2
    exit 1
fi

BUILD_TIME=$(date +%s)
APK_FILES_DIR=$PKG_DIR
APK_OUTPUT_PATH="$BASE_DIR/build/$APK_NAME"
APK_POSTINST="$CONTROL_DIR/postinst"
APK_PRERM="$CONTROL_DIR/prerm"

if [ "$USE_DOCKER_APK" -eq 1 ]; then
    APK_FILES_DIR=$(to_container_path "$PKG_DIR")
    APK_OUTPUT_PATH=$(to_container_path "$BASE_DIR/build/$APK_NAME")
    APK_POSTINST=$(to_container_path "$CONTROL_DIR/postinst")
    APK_PRERM=$(to_container_path "$CONTROL_DIR/prerm")
fi

run_apk_mkpkg \
    --files "$APK_FILES_DIR" \
    --output "$APK_OUTPUT_PATH" \
    --info "name:clip9" \
    --info "version:$PKG_VERSION-r1" \
    --info "description:Clip9 server for transferring text and files between devices" \
    --info "arch:$PACKAGE_ARCH" \
    --info "license:MIT" \
    --info "url:https://github.com/Jonnyan404/clip9" \
    --info "origin:clip9" \
    --info "maintainer:Jonnyan404" \
    --info "build-time:$BUILD_TIME" \
    --info "depends:libc" \
    --script "post-install:$APK_POSTINST" \
    --script "pre-deinstall:$APK_PRERM"

echo "=== APK 打包完成: $BASE_DIR/build/$APK_NAME ==="
