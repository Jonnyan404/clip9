include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-clip9
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_MAINTAINER:=Jonnyan404
PKG_LICENSE:=MIT

LUCI_TITLE:=LuCI support for Clip9
LUCI_DEPENDS:=+luci-base +clip9 +rpcd +luci-compat
LUCI_PKGARCH:=all

# ⚠️★ 下面这个 `Package/$(PKG_NAME)/install` **当前是被覆盖的** —— `luci.mk` 里
# 自己定义了一份同名的，而它 `include` 在这之后（GNU Make 同名变量后定义者胜）。
# 留在这儿是从 Go 版原样继承的（那份也没生效），**别照着它改路径**：
# 真正把 `luasrc/` 装到 `/usr/lib/lua/luci/`、把 `root/` 铺到 `/` 的是 `luci.mk` 的默认规则。
# ⚠️ 发布用的包**不走这个 Makefile** —— `scripts/package-luci-app*.sh` 是直接拼 ipk/apk 的；
# 这个文件只给「把本目录放进 OpenWrt buildroot / feeds 自己编」的人用。
define Package/$(PKG_NAME)/install
    $(INSTALL_DIR) $(1)/usr/lib/lua/luci/controller
    $(INSTALL_DATA) ./luasrc/controller/clip9.lua $(1)/usr/lib/lua/luci/controller/
    
    $(INSTALL_DIR) $(1)/usr/lib/lua/luci/model/cbi
    $(INSTALL_DATA) ./luasrc/model/cbi/clip9.lua $(1)/usr/lib/lua/luci/model/cbi/
    
    $(INSTALL_DIR) $(1)/usr/lib/lua/luci/view/clip9
    $(INSTALL_DATA) ./luasrc/view/clip9/*.htm $(1)/usr/lib/lua/luci/view/clip9/
    
    $(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
    $(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-clip9.json $(1)/usr/share/rpcd/acl.d/
endef

# 这两行标准的LUCI构建命令
include $(TOPDIR)/feeds/luci/luci.mk
# call BuildPackage - OpenWrt buildroot signature