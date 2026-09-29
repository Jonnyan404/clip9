#!/bin/bash
# 打包 clip9 的 LuCI 应用为 OpenWrt IPK
#
# ⚠️★ 这个包是 **`Architecture: all`**（纯 Lua + htm，与架构无关），
#    但**依赖**服务端那个包（`Depends: … clip9 …`）—— 两个包要一起装。
#
# ⚠️★ 有一件事必须做对：**这个包里不能带 `/etc/config/clip9`**。
#    那份 UCI 默认配置是**服务端包**的，如果界面包也塞一份，
#    后装的那个会把已改过的配置覆盖回去（`opkg` 对同一个文件的归属没有仲裁）。
#    所以下面有一句 `rm -f`，**别删它**。
#
# 用法: $0 <版本号>

set -e

VERSION=$1
if [ -z "$VERSION" ]; then
    echo "用法: $0 <版本号>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
LUCI_DIR="$BASE_DIR/luci-app-clip9"
PKG_DIR="$BASE_DIR/build/luci-app"
IPK_NAME="clip9-luci-openwrt-v${VERSION}-all.ipk"

echo "=== 打包 LuCI 应用 $VERSION 为 OpenWrt IPK ==="
echo "SCRIPT_DIR: $SCRIPT_DIR"
echo "BASE_DIR: $BASE_DIR"
echo "LUCI_DIR: $LUCI_DIR"

if [ ! -d "$LUCI_DIR" ]; then
    echo "错误: LuCI应用目录不存在: $LUCI_DIR" >&2
    exit 1
fi

if [ ! -d "$LUCI_DIR/luasrc" ]; then
    echo "错误: LuCI应用luasrc目录不存在: $LUCI_DIR/luasrc" >&2
    exit 1
fi

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/CONTROL"

echo "复制 LuCI 应用文件..."

mkdir -p "$PKG_DIR/usr/lib/lua/luci/model/cbi"
mkdir -p "$PKG_DIR/usr/lib/lua/luci/controller"
mkdir -p "$PKG_DIR/usr/lib/lua/luci/view/clip9"

cp -v "$LUCI_DIR/luasrc/model/cbi/"*.lua "$PKG_DIR/usr/lib/lua/luci/model/cbi/"
cp -v "$LUCI_DIR/luasrc/controller/"*.lua "$PKG_DIR/usr/lib/lua/luci/controller/"
cp -v "$LUCI_DIR/luasrc/view/clip9/"*.htm "$PKG_DIR/usr/lib/lua/luci/view/clip9/"

# 复制 root 目录结构（菜单、ACL、uci-defaults、i18n）
if [ -d "$LUCI_DIR/root" ]; then
    cp -r "$LUCI_DIR/root/"* "$PKG_DIR/"
    rm -f "$PKG_DIR/etc/config/clip9"
    # ⚠️★ `rm -f` **只删文件，留下一个空的 `./etc/config/` 目录** —— 而 tar 会把空目录
    #    也记进去（`tar -tvzf` 里有一行 `drwxr-xr-x ./etc/config/`）。
    #    它本身无害（设备上 `/etc/config` 本来就有），但会让
    #    「这个包完全不碰 /etc/config」这句话**变成假的**（不碰文件，却建了目录），
    #    而且后来的人很容易把自检里那条断言写成不带锚点的版本、把空目录数成「有文件」。
    #    所以顺手把它也清掉 —— `rmdir` **只在空的时候成功**，万一以后 root/etc/config/
    #    下真有别的东西，它不会误删，自检也会红出来。
    rmdir "$PKG_DIR/etc/config" 2>/dev/null || true
    # ⚠️★ 上面那句 `cp -r` **没有**（也**不该有**）给 `etc/uci-defaults/luci-clip9`
    #    加执行位 —— 它进来是 **644，这是对的**（2026-09-28 查证）。
    #
    #    它与 `ipk/rootfs/etc/init.d/clip9` 的情况**正好相反**，别按那边的样子来：
    #      · `init.d/` 下的脚本由 procd **直接执行** → 必须 755（那边的打包脚本显式
    #        `chmod 755` 了，见 `package-openwrt.sh`）；
    #      · `uci-defaults/` 下的脚本由 `/etc/init.d/boot` 以 `. <file>`（source）跑，
    #        **不看执行位**。OpenWrt 官方文档原话是「**Scripts should not be executable**」
    #        （https://openwrt.org/docs/guide-developer/uci-defaults）。
    #        给上执行位反而是与官方约定相反的做法。
    #
    #    ⚠️ 之所以写这一段：「一个没有执行位的 shell 脚本」**看上去就像漏了 chmod** ——
    #    2026-09-28 我就差点把它当成 bug 去「修」（当时还准备顺手改掉 Go 版那份）。
    #    所以这里**故意什么都不做**。
    echo "✓ 已复制root目录结构"
else
    echo "! 警告: 找不到root目录结构"
fi

if [ -d "$LUCI_DIR/htdocs" ]; then
    mkdir -p "$PKG_DIR/www"
    cp -r "$LUCI_DIR/htdocs/"* "$PKG_DIR/www/"
    echo "✓ 已复制htdocs目录结构"
fi

echo "准备控制文件..."
cat > "$PKG_DIR/CONTROL/control" << EOF
Package: luci-app-clip9
Version: $VERSION
Depends: luci-base, clip9, rpcd, luci-compat
Source: https://github.com/Jonnyan404/clip9
License: MIT
Section: luci
Architecture: all
Maintainer: Jonnyan404
Description: LuCI support for Clip9
EOF

# ⚠️ 这两个钩子里的 `[ -n "${IPKG_INSTROOT}" ] || { … }` 是**故意的**：
#    离线打包（用 `--root` 装进一个目录树）时 `IPKG_INSTROOT` 非空，
#    这时候去删宿主的 /tmp 缓存是没有意义的（而且会删错东西）。
cat > "$PKG_DIR/CONTROL/postinst" << 'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
    rm -f /tmp/luci-indexcache
    rm -rf /tmp/luci-modulecache/
    exit 0
}
EOF
chmod 755 "$PKG_DIR/CONTROL/postinst"

cat > "$PKG_DIR/CONTROL/prerm" << 'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
    rm -f /tmp/luci-indexcache
    rm -rf /tmp/luci-modulecache/
    exit 0
}
EOF
chmod 755 "$PKG_DIR/CONTROL/prerm"

echo "创建IPK包..."
# ⚠️ 外层是 tar.gz 不是 ar —— 与 package-openwrt.sh 同一个理由（见那边的注释）。
#    这里 `./etc` 可能不存在（上面把 /etc/config/clip9 删掉之后如果没别的文件），
#    所以按存在与否依次退回，别让 tar 报错。
cd "$PKG_DIR"
if [ -d ./www ] && [ -d ./etc ]; then
    tar -czf "$BASE_DIR/build/data.tar.gz" ./usr ./www ./etc
elif [ -d ./www ]; then
    tar -czf "$BASE_DIR/build/data.tar.gz" ./usr ./www
elif [ -d ./etc ]; then
    tar -czf "$BASE_DIR/build/data.tar.gz" ./usr ./etc
else
    tar -czf "$BASE_DIR/build/data.tar.gz" ./usr
fi
cd "$PKG_DIR/CONTROL"
tar -czf "$BASE_DIR/build/control.tar.gz" ./*
cd "$BASE_DIR/build"
echo "2.0" > debian-binary
tar -czf "$IPK_NAME" ./debian-binary ./control.tar.gz ./data.tar.gz

rm -f debian-binary control.tar.gz data.tar.gz

echo "=== LuCI 应用打包完成: $BASE_DIR/build/$IPK_NAME ==="
