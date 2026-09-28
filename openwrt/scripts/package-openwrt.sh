#!/bin/bash
# 打包 clip9 服务端为 OpenWrt IPK
#
# ⚠️ 架构名用的是 **OpenWrt 那一套**（`arm_cortex-a7` 这种），不是 Rust 的三元组 ——
#    它是**包的 Architecture 字段**，`opkg install` 会拿它跟设备的架构对。
#    二进制本身是 build.sh 摊平出来的 `build/clip9-server-<版本>-<架构名>`。
#
# ⚠️★ 这个包**不含 LuCI 界面**：界面是另一个包（`scripts/package-luci-app.sh`），
#    它的 control 里 `Depends: … clip9 …`，两个包要一起装才有网页可点。

set -e

VERSION=$1
ARCH=$2
# ⚠️★ 第三个参数是**包的 `Architecture` 字段**，它跟「二进制叫什么名字」是两件事：
#    `opkg` 拿它跟设备上 `opkg print-architecture` 列出来的那些名字比，**对不上就不装**。
#    `$ARCH`（`arm_cortex-a7` 这种）是我们给二进制起的**通用**名字，只有 `x86_64` 恰好
#    与设备的架构名一致；arm 与 aarch64 的设备名字通常带后缀（如
#    `arm_cortex-a7_neon-vfpv4`、`aarch64_cortex-a53`），所以**要装到真机上就该传这个参数**。
#    不传 = 沿用 `$ARCH`（与 Go 版行为一致，便于先本地把包打出来看结构）。
#    在设备上查：`opkg print-architecture`
PACKAGE_ARCH=${3:-}

if [ -z "$VERSION" ] || [ -z "$ARCH" ]; then
    echo "用法: $0 <版本号> <二进制架构> [包架构]"
    echo "二进制架构: x86_64, arm_cortex-a5, arm_cortex-a7, arm_cortex-a8, arm_cortex-a9,"
    echo "            arm_cortex-a15_neon-vfpv4, aarch64"
    echo "包架构（可选）: 设备上 \`opkg print-architecture\` 里优先级最高的那个，"
    echo "                如 arm_cortex-a7_neon-vfpv4 / aarch64_cortex-a53"
    echo "示例: $0 0.1.0 aarch64 aarch64_cortex-a53"
    exit 1
fi

[ -n "$PACKAGE_ARCH" ] || PACKAGE_ARCH="$ARCH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
BINARY="$BASE_DIR/build/clip9-server-$VERSION-$ARCH"
PKG_DIR="$BASE_DIR/build/pkg-$ARCH"
CONTROL_DIR="$BASE_DIR/ipk/control"
ROOTFS_DIR="$BASE_DIR/ipk/rootfs"
IPK_NAME="clip9-server-openwrt-$ARCH-v$VERSION.ipk"

echo "脚本目录: $SCRIPT_DIR"
echo "根目录: $BASE_DIR"
echo "二进制文件: $BINARY"
echo "包架构: $PACKAGE_ARCH"

if [ ! -f "$BINARY" ]; then
    echo "错误: 找不到二进制文件 $BINARY"
    echo "请先运行 build.sh 生成它（./scripts/build.sh $VERSION）"
    exit 1
fi

echo "=== 打包 clip9 服务端 $VERSION 为 OpenWrt IPK ($ARCH) ==="

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/etc/init.d"
mkdir -p "$PKG_DIR/etc/config"
mkdir -p "$PKG_DIR/CONTROL"

echo "复制文件..."
cp "$BINARY" "$PKG_DIR/usr/bin/clip9-server"
chmod 755 "$PKG_DIR/usr/bin/clip9-server"

echo "复制脚本和配置文件..."
if [ -f "$ROOTFS_DIR/etc/init.d/clip9" ]; then
    cp "$ROOTFS_DIR/etc/init.d/clip9" "$PKG_DIR/etc/init.d/"
    chmod 755 "$PKG_DIR/etc/init.d/clip9"
    echo "✓ 已复制初始化脚本"
else
    echo "! 找不到初始化脚本（$ROOTFS_DIR/etc/init.d/clip9）"
    exit 1
fi

if [ -f "$ROOTFS_DIR/etc/config/clip9" ]; then
    cp "$ROOTFS_DIR/etc/config/clip9" "$PKG_DIR/etc/config/"
    echo "✓ 已复制配置文件"
else
    echo "! 找不到配置文件（$ROOTFS_DIR/etc/config/clip9）"
    exit 1
fi

echo "准备控制文件..."
if [ -f "$CONTROL_DIR/control" ]; then
    sed "s/{{VERSION}}/$VERSION/g; s/{{ARCH}}/$PACKAGE_ARCH/g" \
        "$CONTROL_DIR/control" > "$PKG_DIR/CONTROL/control"
    echo "✓ 已处理控制文件"
else
    echo "! 找不到控制文件模板（$CONTROL_DIR/control）"
    exit 1
fi

for script in postinst prerm; do
    if [ -f "$CONTROL_DIR/$script" ]; then
        cp "$CONTROL_DIR/$script" "$PKG_DIR/CONTROL/$script"
        chmod 755 "$PKG_DIR/CONTROL/$script"
        echo "✓ 已复制 $script 脚本"
    else
        echo "! 找不到 $script 脚本（$CONTROL_DIR/$script）"
        exit 1
    fi
done

echo "创建IPK包..."
# ⚠️★ 外层是 **tar.gz 而不是 ar** —— 这是沿用 Go 版的做法。opkg 自 libarchive 起
# 两种外壳都认（libarchive 自动嗅探格式），而 `debian-binary` + `control.tar.gz` +
# `data.tar.gz` 这三个成员的名字是 ipk/deb 的约定，不能改。
cd "$PKG_DIR"
tar -czf "$BASE_DIR/build/data.tar.gz" ./usr ./etc
cd "$PKG_DIR/CONTROL"
tar -czf "$BASE_DIR/build/control.tar.gz" ./*
cd "$BASE_DIR/build"
echo "2.0" > debian-binary
tar -czf "$IPK_NAME" ./debian-binary ./control.tar.gz ./data.tar.gz

rm -f debian-binary control.tar.gz data.tar.gz

echo "=== IPK 打包完成: $BASE_DIR/build/$IPK_NAME ==="
