# clip9 for OpenWrt —— 开发笔记

⚠️ 这一份是**给要改这个目录 / 自己打包 / 接手的人**看的。**装包与怎么配不用读它** ——
见 [`README.md`](./README.md)。

## 1. 自己打包

```bash
cd <仓库根>

# 1) 编二进制（7 个架构，实际只跑 3 次 cross 构建）—— 需要本机有 Docker
./openwrt/scripts/build.sh 0.1.0

# 2) 服务端包
./openwrt/scripts/package-openwrt.sh     0.1.0 x86_64                  # IPK
./openwrt/scripts/package-openwrt.sh     0.1.0 aarch64 aarch64_cortex-a53
./openwrt/scripts/package-openwrt-apk.sh 0.1.0 aarch64 aarch64_cortex-a53

# 3) LuCI 界面包（与架构无关，一个包）
./openwrt/scripts/package-luci-app.sh     0.1.0
./openwrt/scripts/package-luci-app-apk.sh 0.1.0
```

产物都在 `openwrt/build/`（已 gitignore）。

⚠️ `build.sh` **需要 `cross`**（`cargo install cross --locked`，底层用 Docker）。
直接用 `cargo` 会在 `aws-lc-sys` 那里报 `failed to find tool "x86_64-linux-musl-gcc"` ——
那是个**看着像代码写错**的错。脚本**故意不回落**到宿主机 `cargo`：那样会编出宿主机的
二进制，而后面每一层（打包、装到路由器）都看不出它不是 musl。
CI 用的是 `cross`（`taiki-e/install-action` 装的）。

⚠️★ **每个 target 用单独的 target 目录**（`rust/target/cross-<三元组>`），别把它们合并回
一个 `target/`。原因见 `build.sh` 第 3 节那段注释：三个 target 串在一个 job 里跑，而 `cross`
给每个 target 用的镜像 **glibc 不一样高**，**宿主**构建脚本落在共用的 `target/release/`
里跨镜像复用 —— 第二个 target 起就报 `failed to run custom build command for libc …:
version GLIBC_2.28 not found`（exit 101）。这是 **cross-rs/cross#724** 的已知毛病
（同 issue 里写明 `cargo clean` 不管用），报出来的**却是某个依赖的名字**，很容易认错方向。
`release.yml` 的 linux job 没这个问题，因为它**一个 target 一个 job**、各自一份缓存。
`tools/workflows-smoke.mjs` 的第 9 条判据钉着「每个 target 单独目录 + 取产物处同源」。

### 1.1 让 CI 打（不动本机）

`.github/workflows/openwrt.yml` 就是上面那串命令的自动化版本，**两个入口**：

- `workflow_call` —— `release.yml` 发版时调它（**构建归那个文件，上传归 `release.yml` 的
  `publish-openwrt` job**）。
- `workflow_dispatch` —— 单独手动跑。⚠️ 填了 `tag` 就**覆盖上传**（`overwrite_files: true`）：
  补一个架构的包、或某个包要重打时不必再发一次版；留空则只构建、不上传。

⚠️ 三条只有站在 CI 上才看得出来的事：

- **`openwrt/build/` 在 git 里不存在**（整个 gitignore）→ `luci` 那个 job 里那两个打包脚本
  会往里面写，所以它前一步得先 `mkdir -p openwrt/build`。
- `build.sh` **必须带 `--skip-web`**：不带它会去跑 `npm run build`，而 runner 上
  `web-vue3/node_modules` 不存在 —— 那一步必挂。（前端产物已入库，本来就只需要编进二进制。）
  ⚠️ 但 `build.sh` 里那道 `sync-web-assets.mjs --check` 照样是**硬闸**，`--skip-web` 关不掉它。
- **三个数字是跨文件的**：`release.yml` 的 `publish-openwrt` 里写着
  `[ "$n_ipk" = 10 ]` / `[ "$n_apk" = 8 ]` / `[ "$n_luci" = 2 ]`，它们必须与上面那个文件里
  两个矩阵的条目数一致。改矩阵而没改那边 → **只在发布时**才红。
  `node tools/workflows-smoke.mjs`（已接进 CI）就是提前问这一句的。

### 1.2 ⚠️★「两个目录长的是一类东西，要求却相反」

- **`luci-app-clip9/root/etc/uci-defaults/luci-clip9` 在包里是 `644`，这是对的** ——
  别给它加执行位。它**看上去就像漏了 `chmod`**（2026-09-28 我差点把它当 bug 去「修」，
  当时还准备顺手把 Go 版那份一起改掉），但 OpenWrt 官方文档的原话恰好相反：
  「**Scripts should not be executable**」（<https://openwrt.org/docs/guide-developer/uci-defaults>）。
  `/etc/uci-defaults/` 下的脚本由 `/etc/init.d/boot` 以 source 方式执行，**不看执行位**。
- **`ipk/rootfs/etc/init.d/clip9` 必须 `755`** —— 那个由 procd **直接执行**，
  两个打包脚本里都显式 `chmod` 了它。

所以两个脚本里都留了注释，免得下一个人按错的那边来。

## 2. 产物名与架构（内部约定）

⚠️★ **产物名里那个架构必须是「设备的」，不是「二进制的」。** 2026-10-02 之前 ipk 那格只给
`arch`（二进制名），于是包里的 `Architecture` 写成 `aarch64` —— 而 **OpenWrt 没有叫
`aarch64` 的设备架构**（只有 `aarch64_generic` / `aarch64_cortex-a53` …），那个包
**在任何真机上都装不上**（实测报
`Packages for clip9 found, but incompatible with the architectures configured`）。
⚠️ 7 个里只有 `x86_64` 与 `arm_cortex-a15_neon-vfpv4` **恰好两边同名**，其余 5 个都中招；
apk 那一格**一直是对的**（它有 `pkg_arch`），现在 ipk 照它改成了 `arch` + `pkg_arch` 两个字段，
产物名也用 `pkg_arch`（否则那 4 个 aarch64 包**同名互相覆盖**）。

⚠️ 两个打包脚本都留了可选的第三个参数（CI 现在会传；本机自己打时不给就用二进制名 ——
那是「先打出来看结构」的口径，不是给人装的口径）：

- 包里的 `Architecture` / `arch` 字段是**设备**的名字，装的时候会拿它比对：
  - 查 IPK 的：`opkg print-architecture`
  - 查 APK 的：`cat /etc/apk/arch`（如 `aarch64_cortex-a53`、`arm_cortex-a7_neon-vfpv4`）
- 举例：`./scripts/package-openwrt.sh 0.1.0 aarch64 aarch64_cortex-a53`

⚠️ **同一行里那几个名字用的是同一份二进制** —— 32 位 ARM 那 5 个是同一套 EABI 硬浮点 ABI，
而**静态**链接的二进制不跨 userland 的软/硬浮点边界；aarch64 那 4 个更是同一个二进制编 4 次包。

⚠️★ **没有 mips / mipsel**（Jonny 2026-09-28：「未来这种架构应该也不多」）。
不是「懒得加」：`mips-unknown-linux-musl` 在 Rust 里是 **Tier 3**，`rustup` **装不上**，
得自己编 `std`。`rust/rust-toolchain.toml` 的注释里早写着这件事。

⚠️ 包里的文件属主是**打包者的 uid**（本机打包就是 `501`）—— tar 的 `--owner` / `--uid`
是 GNU tar 的选项，macOS 的 bsdtar 不认，所以这里没做归一。
实际影响很小：`opkg`/`apk` 以 root 解包，权限位（755 / 644）才是起作用的那项。

## 3. 与 Go 版（另一个仓库的 `openwrt/`）的差异

这些不是「顺手改的」，每一条都对应一个「照抄会坏」的点：

| # | 差异 | 为什么 |
|---|---|---|
| 1 | 二进制叫 `clip9-server`，包叫 `clip9`，UCI 是 `/etc/config/clip9` | 改名 |
| 2 | 传 `-data /etc/clip9/data` | 本实现独有：redb 库 + uploads 都挂在数据目录下 |
| 3 | **init 脚本不再手写 `config.json`** | Go 那份 heredoc 出的配置里是 `historyFile`，而这个键在本实现里**已被 serde 当未知字段丢掉**（历史改存 redb，键叫 `dbPath`）。现在交给服务端自己写 |
| 4 | 「清空历史」= **停服务 → 删库文件 → 再起** | Go 那边历史是 JSON 文件，写个 `[]` 就行；这边是 **redb 库**，往里写 `[]` 就是把它写成一个「不是 redb 的文件」—— **下一次启动服务起不来**，而 procd 的 respawn 会反复重启它，日志里只有一句 redb 的错 |
| 5 | 「检查更新」的版本号正则要求 `数字.数字` | 原来是 `[%d%.]+[%w%._%-]*`，而二进制现在叫 `clip9-server`（名字里有个 `9`）→ 会抓出 **`9-server`**。Go 的 `cloud-clipboard` 不含数字所以那边一直是好的 |
| 6 | 总览页的版本徽标不再多加一个 `v` | `get_installed_version()` 返回的已经带 `v` 了，Go 那边显示出来是 `vv0.1.0` |
| 7 | 「数据盘占用」的「历史」量的是**库文件本身** | 那边历史是目录，这边是一个文件 |
| 8 | 架构表：去 mips/mipsel、去 i386，armv7 一份二进制顶 5 个名字 | 见 §2 |
| 9 | 需要 `cross` 而不是 `go build` | musl 交叉编译要有能给 musl 编 C 的编译器 |

## 4. 验过什么 / 还没验什么

### 4.1 已经在容器里真装真跑过（2026-10-02）

在 `openwrt/rootfs` 容器里验过一轮（24.10 的 opkg 与 25.12 的 apk 各一个，
再加一个 `--privileged /sbin/init` 的用来验 procd 与 LuCI）。**验过的**：

| | 结果 |
|---|---|
| ipk（24.10）与 apk（25.12）装包 | ✓ 退出码 0、`postinst` 建自启链接、三个文件落位 |
| **二进制执行 / 监听 / 端到端收发** | ✓ 发一条读回来一致（redb + HTTP 全通） |
| **前端产物** | ✓ 日志「用编进二进制的那一份」 |
| `init.d start` → procd → `status` | ✓ `running` |
| **procd 的 respawn** | ✓ `kill -9` 之后被重新拉起（pid 变了） |
| **开机自启** | ✓ `docker restart` 之后服务自己起来 |
| **aarch64** | ✓ 装得上、跑得起来、收发通（**修了架构名之后**，见 §2） |
| **LuCI 包（ipk 与 apk 两种）** | ✓ 装上、界面文件与 `menu.d`/`acl.d` 落位、`ubus` 的 ACL 里有 `luci-app-clip9` |
| **LuCI 装完不覆盖 `/etc/config/clip9`** | ✓ 先改过的值还在（老坑没复发） |
| **LuCI 模板能渲染** | ✓ 用 `luci.template.parser` 编译并渲染出 HTML（补上了「语法只能靠读」那一格） |

⚠️★ 怎么起这种容器（以及**三个都会伪装成「连不上」的坑**）—— 这三个互相掩盖，
排查顺序错了会浪费很久：

1. **`/etc/init.d/network` 会把 Docker 的 `eth0` 抓进它自己的 `br-lan` 网桥** →
   容器变成 `192.168.1.1/24`、Docker 给的地址与默认路由一起没了 ⇒ 容器**不出网**，
   而宿主发进来的包因为目的 IP 不匹配被 reset。
   修法：`ip link set eth0 nomaster` + 配回地址与默认路由，并 `disable` 那个服务。
   ⚠️ 我一开始误判成 `/etc/resolv.conf`（`init` 确实会改它），但那个地址本来是对的 —— 病是**没路由**。
2. **`/etc/init.d/firewall`（fw4/nftables）默认 input REJECT** → **另一个** reset。
   修法：`stop` + `disable` + `nft flush ruleset`，并确认 `/etc/rc.d/S19firewall` 真的没了。
3. **`uhttpd.main.rfc1918_filter='1'`**（OpenWrt 默认）：容器看到的源 IP 是私有网段 → 被它挡。
   ⚠️ 但它**不是**主因（我一开始猜它，改了没效果）。

⚠️ 另外两条：`luci-compat` 的依赖链要一起装（容器网络不通时可以从宿主下 ipk 再传进去），
以及**LuCI 的登录不能用 curl 模拟**（缺 CSRF token → 403，不是密码错）——
验密码直接 `ubus call session login '{"username":"root","password":"…"}'`。

### 4.2 CI

- ✅ **`openwrt.yml` 已经绿过了**（2026-10-02，`v0.1.1` 那次）：`binaries` ✓、`ipk` **10 个** ✓、
  `apk` **8 个** ✓、`luci` ✓，`release.yml` 的 `publish-openwrt` 也 ✓。
  ⚠️ 这条**取代**了本文件早先那句「`openwrt.yml` 已经跑过，但还没绿过」—— 那是 2026-09-28 的
  状态（当时两次都红在第三个 target 的 `GLIBC_2.28`，即 §1 那条 cross#724）。
  所以「每个 target 单独目录」那个修法**已经过了一次真实运行的验证**。
- ✅ 本机验不了的那两件（要 runner 上的 Docker：`apk mkpkg` 是 Alpine 的工具）**已经由 CI 覆盖**。

### 4.3 还没验的

- ⚠️ **真机**。容器共享宿主内核，没有真正的 flash 布局与 OpenWrt 内核 ——
  所以「装到真路由器上、重启之后数据还在不在」这类事**只是按设计推的**。
- ⚠️ **其余架构**：本机 docker 只有 x86_64；aarch64 走 qemu 验过，
  那 5 个 32 位 arm 名字**没有试过**。
- ⚠️ **LuCI 页面的最终观感**：ACL 注册 + 模板渲染只能证明「注册了、出得了 HTML」，
  不等于在浏览器里好看、能点。
- ⚠️ **界面只有中文**：`usr/share/luci/i18n/clip9.po` 会被打进去，但 **LuCI 认的是编译出来的
  `.lmo`**，而这条手工打包链路不做那步编译。真要用翻译，得走 OpenWrt buildroot
  （`luci-app-clip9/Makefile` 那条路）。

## 5. LuCI 界面的源码在哪

改界面（页面、菜单、权限、文案）都在同一个目录里，**改一处往往要连另一处一起改**：

| 改什么 | 文件 |
| --- | --- |
| 路由 / 页面动作 / 「检查更新」 | `luci-app-clip9/luasrc/controller/clip9.lua` |
| CBI 模型（基本设置那页的字段） | `luci-app-clip9/luasrc/model/cbi/clip9.lua` |
| 四个页面的版式与脚本 | `luci-app-clip9/luasrc/view/clip9/*.htm` |
| 菜单挂在哪个位置 | `luci-app-clip9/root/usr/share/luci/menu.d/luci-app-clip9.json` |
| 允许哪些 ubus 调用 | `luci-app-clip9/root/usr/share/luci/rpcd/acl.d/luci-app-clip9.json` |
| 中文文案 | `luci-app-clip9/root/usr/share/luci/i18n/clip9.po`（⚠️ 见 §4.3 最后一条：不编译成 `.lmo`，实际只有中文） |

⚠️ 这一套**没有自动判据**盯着（改文案漏改 `.po`、改页面断了引用，都不会有东西报红）——
所以改完要按 §4.1 的办法在容器里真渲染一次（`luci.template.parser` 编译 + 渲染，
再拿渲染出来的 HTML 里的 `<script>` 跑一遍）。
