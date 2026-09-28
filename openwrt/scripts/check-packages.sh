#!/bin/bash
# 打包链路自检：打一遍三个包，解开逐项核对**结构 / 权限 / control 字段**。
#
# ⚠️★ 它验的是**链路与包结构**，不是「能不能在路由器上跑」：
#    本机没有 musl 交叉工具链，所以它拿**宿主二进制当替身**塞进包里。
#    真机要的是 musl 二进制 —— 那件事由 CI 的 `release.yml` 每次发版编（用 `cross`）。
#
# ⚠️ 之所以要有这个脚本：这次移植里**每一条踩到的坑都是「包能打出来、装上去才发现」**——
#    比如界面包多带一份 `/etc/config/clip9`（会把服务端包那份覆盖回去）、
#    `control` 里的 `Architecture` 用了二进制名而不是设备架构名。
#    这些在「打包成功」的输出里**全都看不出来**。
#
# 用法: ./scripts/check-packages.sh [版本号]   （默认 0.1.0）

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENWRT_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$OPENWRT_DIR")"
cd "$ROOT_DIR" || exit 1

VER=${1:-0.1.0}
BUILD=openwrt/build
WORK="$BUILD/.verify"          # 解包暂存；`build/` 整个是 gitignore 的

PASS=0; FAIL=0
chk() { # chk <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then printf '  \033[32m✅\033[0m %s\n' "$1"; PASS=$((PASS+1))
  else printf '  \033[31m❌\033[0m %s  实际=[%s] 期望=[%s]\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
# 从 tar 列表里取某成员的权限位
perms() { tar -tvzf "$1" | awk -v m="$2" '$NF==m {print $1}' | head -1; }

HOST_BIN="rust/target/debug/clip9-server"
if [ ! -f "$HOST_BIN" ]; then
    echo "先编一个宿主二进制当替身：cd rust && cargo build -p clip9-server" >&2
    exit 1
fi

echo "=== ① 造替身二进制并打包 ==="
mkdir -p "$BUILD"
# ⚠️ aarch64 那一次只为验「第三个参数（包架构）真的进了 control」，所以也用宿主二进制 ——
#    这一步不验二进制内容，只验字段。
cp -f "$HOST_BIN" "$BUILD/clip9-server-$VER-x86_64"
cp -f "$HOST_BIN" "$BUILD/clip9-server-$VER-aarch64"
echo "  替身: $BUILD/clip9-server-$VER-x86_64 ($(du -h "$BUILD/clip9-server-$VER-x86_64" | cut -f1))"

./openwrt/scripts/package-openwrt.sh  "$VER" x86_64                     >"$WORK.p1.log" 2>&1 || { echo "  ❌ package-openwrt.sh 失败"; tail -20 "$WORK.p1.log"; exit 1; }
echo "  ✅ package-openwrt.sh  x86_64"
./openwrt/scripts/package-openwrt.sh  "$VER" aarch64 aarch64_cortex-a53 >"$WORK.p2.log" 2>&1 || { echo "  ❌ package-openwrt.sh（带包架构）失败"; tail -20 "$WORK.p2.log"; exit 1; }
echo "  ✅ package-openwrt.sh  aarch64 + 包架构 aarch64_cortex-a53"
./openwrt/scripts/package-luci-app.sh "$VER"                            >"$WORK.p3.log" 2>&1 || { echo "  ❌ package-luci-app.sh 失败"; tail -20 "$WORK.p3.log"; exit 1; }
echo "  ✅ package-luci-app.sh"

SRV="$BUILD/clip9-server-openwrt-x86_64-v$VER.ipk"
SRV2="$BUILD/clip9-server-openwrt-aarch64-v$VER.ipk"
LUC="$BUILD/clip9-luci-openwrt-all-v$VER.ipk"

echo
echo "=== ② 服务端 ipk: ${SRV} ==="
[ -f "$SRV" ] || { echo "  ❌ 没打出来"; exit 1; }
D="$WORK/srv"; rm -rf "$D"; mkdir -p "$D"
tar -xzf "$SRV" -C "$D"
chk "外层含 debian-binary"      "$([ -f "$D/debian-binary" ] && echo yes || echo no)" yes
chk "debian-binary 内容 2.0"    "$(cat "$D/debian-binary")" "2.0"
chk "外层含 control.tar.gz"     "$([ -f "$D/control.tar.gz" ] && echo yes || echo no)" yes
chk "外层含 data.tar.gz"        "$([ -f "$D/data.tar.gz" ] && echo yes || echo no)" yes

chk "usr/bin/clip9-server 权限" "$(perms "$D/data.tar.gz" "./usr/bin/clip9-server")" "-rwxr-xr-x"
chk "etc/init.d/clip9 权限"     "$(perms "$D/data.tar.gz" "./etc/init.d/clip9")"     "-rwxr-xr-x"
chk "etc/config/clip9 权限"     "$(perms "$D/data.tar.gz" "./etc/config/clip9")"     "-rw-r--r--"
chk "包里不含 LuCI 的 lua 目录"  "$(tar -tzf "$D/data.tar.gz" | grep -c 'usr/lib/lua')" "0"

tar -xzf "$D/control.tar.gz" -C "$D"
chk "control 的 Package 名"     "$(grep -m1 '^Package:' "$D/control" | awk '{print $2}')" "clip9"
chk "control 的 Architecture"   "$(grep -m1 '^Architecture:' "$D/control" | awk '{print $2}')" "x86_64"
chk "postinst 权限"             "$(perms "$D/control.tar.gz" "./postinst")" "-rwxr-xr-x"
chk "prerm 权限"                "$(perms "$D/control.tar.gz" "./prerm")"    "-rwxr-xr-x"

echo
echo "=== ③ 包架构参数真的生效: ${SRV2} ==="
D2="$WORK/srv2"; rm -rf "$D2"; mkdir -p "$D2"
tar -xzf "$SRV2" -C "$D2"; tar -xzf "$D2/control.tar.gz" -C "$D2"
chk "Architecture 用了第三个参数" "$(grep -m1 '^Architecture:' "$D2/control" | awk '{print $2}')" "aarch64_cortex-a53"

echo
echo "=== ④ LuCI ipk: ${LUC} ==="
[ -f "$LUC" ] || { echo "  ❌ 没打出来"; exit 1; }
L="$WORK/luci"; rm -rf "$L"; mkdir -p "$L"
tar -xzf "$LUC" -C "$L"; tar -xzf "$L/data.tar.gz" -C "$L"; tar -xzf "$L/control.tar.gz" -C "$L"

chk "controller/clip9.lua"   "$([ -f "$L/usr/lib/lua/luci/controller/clip9.lua" ] && echo yes || echo no)" yes
chk "model/cbi/clip9.lua"    "$([ -f "$L/usr/lib/lua/luci/model/cbi/clip9.lua" ] && echo yes || echo no)" yes
for v in overview basic advanced log; do
  chk "view/clip9/$v.htm"    "$([ -f "$L/usr/lib/lua/luci/view/clip9/$v.htm" ] && echo yes || echo no)" yes
done
chk "menu.d/luci-app-clip9.json" "$([ -f "$L/usr/share/luci/menu.d/luci-app-clip9.json" ] && echo yes || echo no)" yes
chk "acl.d/luci-app-clip9.json"  "$([ -f "$L/usr/share/rpcd/acl.d/luci-app-clip9.json" ] && echo yes || echo no)" yes
chk "i18n/clip9.po"              "$([ -f "$L/usr/share/luci/i18n/clip9.po" ] && echo yes || echo no)" yes

# ⚠️★ 这条是「不许存在」的断言：界面包若带了 /etc/config/clip9，后装的会把服务端包那份
#    覆盖回去（opkg 对同一个文件的归属没有仲裁）。
# ⚠️★ 注意它**故意不带 `$` 锚点**、数的是 `^\./etc/config` 这个**前缀** ——
#    因为 `rm -f` 只删文件、会留下一个空的 `./etc/config/` 目录，而 **tar 会把空目录
#    也记进列表**。带锚点就只看得到「有没有文件」，空目录会从断言底下溜过去，
#    而「这个包完全不碰 /etc/config」这句话也就不成立了（2026-09-28 就是这么发现的）。
chk "★ 界面包完全不碰 /etc/config" "$(tar -tzf "$L/data.tar.gz" | grep -c '^\./etc/config')" "0"
# ⚠️★ uci-defaults 必须是 644（OpenWrt 官方要求不可执行）—— 见 README 第 4 节
chk "★ uci-defaults 保持 644"        "$(perms "$L/data.tar.gz" "./etc/uci-defaults/luci-clip9")" "-rw-r--r--"

chk "界面包 Architecture=all" "$(grep -m1 '^Architecture:' "$L/control" | awk '{print $2}')" "all"
chk "界面包 Depends 含 clip9" "$(grep -m1 '^Depends:' "$L/control" | grep -c '\bclip9\b')" "1"

echo
echo "=== ⑤ gitignore 真的挡住了产物 ==="
chk "build/ 被忽略" "$(git check-ignore "$BUILD/clip9-server-openwrt-x86_64-v$VER.ipk" >/dev/null 2>&1 && echo ignored || echo tracked)" "ignored"

echo
printf '=== 合计：\033[32m%d 通过\033[0m / \033[31m%d 失败\033[0m ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
