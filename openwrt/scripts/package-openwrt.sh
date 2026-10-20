#!/bin/bash
# 打包 clip9 服务端为 OpenWrt IPK
#
# ⚠️ 架构名用的是 **OpenWrt 那一套**（`arm_cortex-a7` 这种），不是 Rust 的三元组 ——
#    它是**包的 Architecture 字段**，`opkg install` 会拿它跟设备的架构对。
#    二进制本身是 build.sh 摊平出来的 `build/clip9-server-v<版本>-<架构名>`。
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

# 变体（第 4 个参数，`ui` | `noui`，默认 `ui`）。
#
# ⚠️★ `noui` 是**不带内嵌界面**的那一份（给 flash 很小的设备）：机器上就只有 API，
# 界面得放在别处（服务端那边配 `allowOrigins`）。
#
# ⚠️★ 两个变体装进路由器以后**文件路径完全一样**（`/usr/bin/clip9-server`、
# `/etc/init.d/clip9`、`/etc/config/clip9`）—— 它们就是「同一个包的两个版本」。
# 所以 control 里必须让它们**互斥**：
#   · `Provides: clip9` —— LuCI 那个包 `Depends: clip9`，没有它的话装完 noui 还得再装一份
#     带界面的；而 `opkg` 认虚拟包，Provides 就能满足那个依赖。
#   · `Conflicts: clip9` —— 两个包的文件重名，同时装会覆盖成一锅粥（而且 uninstall 其中一个
#     会把共用的 `/usr/bin/clip9-server` 删掉）。互斥让「先卸再装」成为唯一路径，这是对的。
VARIANT=${4:-ui}

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
case "$VARIANT" in
    ui)   BIN_PREFIX="clip9-server" ;;
    noui) BIN_PREFIX="clip9-server-noui" ;;
    *) echo "错误: 未知变体 ${VARIANT}（只认 ui / noui）"; exit 1 ;;
esac
BINARY="$BASE_DIR/build/$BIN_PREFIX-v$VERSION-$ARCH"
PKG_DIR="$BASE_DIR/build/pkg-$PACKAGE_ARCH"
CONTROL_DIR="$BASE_DIR/ipk/control"
ROOTFS_DIR="$BASE_DIR/ipk/rootfs"
# ⚠️ 产物名里**不带 `server`**（2026-09-29 改的，Jonny：「clip9-server-openwrt 去掉 server」）。
# 包**里面**那个程序仍然叫 `clip9-server`（装到 `/usr/bin/clip9-server`）—— 改的只是
# 发到 Release 上的那个文件名。⚠️ 这个字符串同时被
# `.github/workflows/openwrt.yml`（`ls -l` 与 upload 的 path）和
# `.github/workflows/release.yml`（`publish-openwrt` 里那句 `find … -name`）认着。
# ⚠️★ 产物名用 `$PACKAGE_ARCH`（**设备**架构名）而不是 `$ARCH`：同一个 aarch64 二进制要出
#    四个包（`aarch64_generic` / `aarch64_cortex-a53` / `-a72` / `-a76`，见 `openwrt.yml`
#    的 ipk 矩阵），用二进制名的话这四个**会同名互相覆盖**。
#    ⚠️ `package-openwrt-apk.sh` 一直就是这么做的 —— 两套包的产物名从此同一口径，
#    也与「用户下哪个包就装哪个」这个事实一致。
# ⚠️ 名字沿用 `<东西>-openwrt-v<版本>-<设备架构>` 那条规矩（与 `clip9-luci-openwrt-…` 同形）。
if [ "$VARIANT" = "noui" ]; then
    IPK_NAME="clip9-noui-openwrt-v$VERSION-$PACKAGE_ARCH.ipk"
else
    IPK_NAME="clip9-openwrt-v$VERSION-$PACKAGE_ARCH.ipk"
fi

echo "脚本目录: $SCRIPT_DIR"
echo "根目录: $BASE_DIR"
echo "二进制文件: $BINARY"
echo "包架构: $PACKAGE_ARCH"

if [ ! -f "$BINARY" ]; then
    echo "错误: 找不到二进制文件 $BINARY"
    echo "请先运行 build.sh 生成它（./scripts/build.sh ${VERSION}）"
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

# ── noui 标记：LuCI 靠它把总览页的「打开」置灰 ──────────────────────────────
#
# ⚠️★ 两个变体装到路由器之后**文件路径完全一样**（同一个 `Package` 的两个版本），
#    包名在设备上读不到 —— `opkg list-installed` 与 `apk info` 两套命令还不一样，
#    而 LuCI 不该为了这一个判断去猜用户装的是哪个包管理器。所以让**安装包自己**
#    留下一个文件当判据。
#
# ⚠️ 只给 noui 建：ui 那一份多一个空目录没有意义，而「没有标记 = 有界面」
#    这条默认对**老版本**的包也成立（它们本来就有界面）。
if [ "$VARIANT" = "noui" ]; then
    mkdir -p "$PKG_DIR/usr/share/clip9"
    {
        echo "这个包是 clip9 的 noui 变体：二进制里没有内嵌前端，只提供 API。"
        echo "界面要放在别处，并在服务端配好 server.allowOrigins"
        echo "（LuCI：高级设置 → 跨源来源）。"
    } > "$PKG_DIR/usr/share/clip9/noui"
    echo "✓ 已写入 noui 标记（/usr/share/clip9/noui）"
fi

echo "准备控制文件..."
if [ -f "$CONTROL_DIR/control" ]; then
    sed "s/{{VERSION}}/$VERSION/g; s/{{ARCH}}/$PACKAGE_ARCH/g" \
        "$CONTROL_DIR/control" > "$PKG_DIR/CONTROL/control"
    if [ "$VARIANT" = "noui" ]; then
        # ⚠️ 只改**包名**与依赖关系，文件表与初始化脚本一个字都不动 —— 两个变体装上去
        #    长得完全一样，区别只有二进制里有没有内嵌前端。
        #
        # ⚠️★ `Provides` / `Conflicts` 要插在 **`Package:` 之后**，不是文件末尾：
        #    `Description` 是最后一段，而它在 Debian 风格的 control 里允许**缩进续行** ——
        #    把字段追加在它后面，读的人（和某些解析器）会把它当成描述的续行。
        #
        # ⚠️★ 用 `awk` 而不是 `sed`：BSD/ macOS 的 sed 在替换串里**不认 `\n`**
        #    （GNU 才认）。这个脚本在本机（macOS）也要能跑 —— `check-packages.sh` 就跑它。
        awk '{
            if ($0 == "Package: clip9") {
                print "Package: clip9-noui"
                print "Provides: clip9"
                print "Conflicts: clip9"
            } else if ($0 ~ /^Description: /) {
                print "Description: Clip9 server (API only, no embedded web UI) for transferring text and files between devices"
            } else {
                print
            }
        }' "$PKG_DIR/CONTROL/control" > "$PKG_DIR/CONTROL/control.new"
        mv "$PKG_DIR/CONTROL/control.new" "$PKG_DIR/CONTROL/control"
    fi
    echo "✓ 已处理控制文件（变体: ${VARIANT}）"
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
        echo "! 找不到 $script 脚本（$CONTROL_DIR/${script}）"
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
