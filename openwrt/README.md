# Clip9 for OpenWrt

把 `clip9-server` 装成一个 OpenWrt 服务（procd 托管），另有一个可选的 LuCI 界面包。

## 1. 装哪个文件

| OpenWrt 版本 | 包格式 | 怎么装 |
|---|---|---|
| 25.12 及以上 | `.apk` | `apk add --allow-untrusted /tmp/clip9-openwrt-apk-v<版本>-<架构>.apk` |
| 24.10 及以下 | `.ipk` | `opkg install /tmp/clip9-openwrt-v<版本>-<架构>.ipk` |

LuCI 界面是**单独的包**（`clip9-luci-openwrt-*`），要一起装才有网页可点。
两个包都是先传到设备再装：

```sh
scp clip9-openwrt-v0.1.0-aarch64.ipk root@192.168.1.1:/tmp/
scp clip9-luci-openwrt-v0.1.0-all.ipk root@192.168.1.1:/tmp/
```

⚠️ 产物文件名里**不带 `server`**，但装上去之后那个程序仍然叫 `clip9-server`
（`/usr/bin/clip9-server`，init 脚本 `/etc/init.d/clip9`）。
⚠️ Release 上**只有这些 ipk / apk**：裸二进制（`clip9-server-v<版本>-<架构>`）是构建的
中间产物，不发。

## 2. 架构：**7 个**

| 产物里的架构名 | 适用设备 | Rust target |
|---|---|---|
| `x86_64` | 64 位 x86（软路由） | `x86_64-unknown-linux-musl` |
| `arm_cortex-a5` … `arm_cortex-a15_neon-vfpv4`（共 **5** 个名字） | 各种 32 位 ARM 路由 | `armv7-unknown-linux-musleabihf` |
| `aarch64` | 64 位 ARM 路由 | `aarch64-unknown-linux-musl` |

⚠️ **那 5 个 arm 名字用的是同一份二进制** —— 它们是同一套 EABI 硬浮点 ABI，而**静态**
链接的二进制不跨 userland 的软/硬浮点边界，所以一份就能装上去。

⚠️★ **没有 mips / mipsel**（Jonny 2026-09-28：「未来这种架构应该也不多」）。
不是「懒得加」：`mips-unknown-linux-musl` 在 Rust 里是 **Tier 3**，`rustup` **装不上**，
得自己编 `std`。`rust/rust-toolchain.toml` 的注释里早写着这件事。

⚠️★ **「二进制架构」与「包架构」不是一回事**，两个脚本都留了可选的第三个参数：

- IPK 的 `Architecture` 字段 / APK 的 `arch` 字段是**设备**的名字，装的时候会拿它比对：
  - 查 IPK 的：`opkg print-architecture`
  - 查 APK 的：`cat /etc/apk/arch`（如 `aarch64_cortex-a53`、`arm_cortex-a7_neon-vfpv4`）
- 只有 `x86_64` 与 `arm_cortex-a15_neon-vfpv4` 恰好两边同名，可以自动推断；
  其余**必须显式给**，脚本不会去猜（猜错的后果不是报错，是装到架构不对的设备上）。

## 3. 配置

- **UCI**：`/etc/config/clip9` —— `enabled` / `host` / `port` / `auth` / `data` / `config`
- **数据目录**：`/etc/clip9/data` —— redb 库与 `uploads/` 都挂在它下面
- **config.json**：`/etc/clip9/config.json` —— 房间密码、过期时间等高级项

⚠️★ **数据目录为什么在 `/etc` 下面，而不是 `/var/lib`**：`docs/ARCHITECTURE.md` §4.2
提到过 OpenWrt 用 `/var/lib`，但 OpenWrt 的 `/var` 通常是**指向 `/tmp` 的软链**（tmpfs）——
把 redb 库放那儿，**每次重启历史就没了**。`/etc` 在 overlay 上、重启还在，所以数据
跟 UCI 配置一起放在 `/etc/clip9/` 下。

⚠️ `data` 是本实现**独有**的 UCI 项（Go 版没有「数据目录」这个概念，那边历史是一个
JSON 文件）。配置里写的 `dbPath` / `storageDir` 若是**相对路径**，就是相对它解析。

改完配置：

```sh
/etc/init.d/clip9 restart
```

`config.json` **不需要手写** —— 文件不存在时服务端会自己写一份默认的。
房间密码的例子：

```json
{
  "server": {
    "auth": true,
    "roomAuth": { "private": "", "finance": "finance-pass" }
  }
}
```

空字符串 = 该房间沿用全局 `auth`。

## 4. 自己打包

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
version `GLIBC_2.28' not found`（exit 101）。这是 **cross-rs/cross#724** 的已知毛病
（同 issue 里写明 `cargo clean` 不管用），报出来的**却是某个依赖的名字**，很容易认错方向。
`release.yml` 的 linux job 没这个问题，因为它**一个 target 一个 job**、各自一份缓存。
`tools/workflows-smoke.mjs` 的第 9 条判据钉着「每个 target 单独目录 + 取产物处同源」。

### 4.1 让 CI 打（不动本机）

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
  `[ "$n_ipk" = 7 ]` / `[ "$n_apk" = 8 ]` / `[ "$n_luci" = 2 ]`，它们必须与上面那个文件里
  两个矩阵的条目数一致。改矩阵而没改那边 → **只在发布时**才红。
  `node tools/workflows-smoke.mjs`（已接进 CI）就是提前问这一句的。

⚠️★ **`luci-app-clip9/root/etc/uci-defaults/luci-clip9` 在包里是 `644`，这是对的** ——
别给它加执行位。它**看上去就像漏了 `chmod`**（2026-09-28 我就差点把它当 bug 去「修」，
当时还准备顺手把 Go 版那份一起改掉），但 OpenWrt 官方文档的原话恰好相反：
「**Scripts should not be executable**」（<https://openwrt.org/docs/guide-developer/uci-defaults>）。
`/etc/uci-defaults/` 下的脚本由 `/etc/init.d/boot` 以 source 方式执行，**不看执行位**。

⚠️ 这与 `ipk/rootfs/etc/init.d/clip9` **正好相反** —— 那个由 procd **直接执行**，
所以必须 `755`，两个打包脚本里都显式 `chmod` 了它。**两个目录长的是一类东西，要求却相反**，
所以两个脚本里都留了注释，免得下一个人按错的那边来。

## 5. LuCI 界面

装完两个包后 `/etc/init.d/uhttpd restart`，在「服务」菜单下就是 Clip9：

- **总览** —— 运行状态、监听参数、数据盘占用、检查上游版本、直接启停
- **基本设置** —— 开关 / 监听地址 / 端口 / 访问密码 / **数据目录** / 配置文件路径
- **高级设置** —— 房间密码（`roomAuth`）、文本与文件上限、专家模式直接编辑 `config.json`
- **日志** —— 实时日志（5 秒自动刷新）

## 6. ★ 与 Go 版（`openwrt/`）的差异

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
| 8 | 架构表：去 mips/mipsel、去 i386，armv7 一份二进制顶 5 个名字 | 见第 2 节 |
| 9 | 需要 `cross` 而不是 `go build` | musl 交叉编译要有能给 musl 编 C 的编译器 |

## 7. 还没验过的事（写在明处）

- ⚠️★ **`openwrt.yml` 已经跑过，但还没绿过。** 2026-09-28 首次上 CI，两次都是
  `binaries` 红在第三个 target 上（`GLIBC_2.28 not found`，cross#724 —— 见 §4 那段警告）。
  **修法（每个 target 单独 target 目录）是在本机改的，还没经一次真实运行验证** ——
  `cross` 要 Docker，本机与沙箱都跑不了。⚠️ 下一次 CI 若这里还红，先看**是不是同一个 target、
  同一句 GLIBC**；如果不是，那就是另一码事，别硬套这个结论。
  已经**绿过**的是：`version` 与 `luci` 两个 job，以及 `release.yml` 那边的接线
  （artifact 名字 / 前缀 / 矩阵条目数 —— 那几条由 `node tools/workflows-smoke.mjs` 提前判）。
  ⚠️ 本机验不了它要 runner 上的 Docker（`apk mkpkg` 是 Alpine 的工具）。
- **没有在真机上装过**。本机也没有 `opkg` / `apk`，所以「装上去能不能用」这一步没做。
  已经验过的是：**包的结构与内容**（解开逐项核对过——文件位置、权限、
  `control` 字段、LuCI 包里**不含** `/etc/config/clip9`）。
- **`cross` 的三个 musl 目标本机没编过**（本机没有 `cross`）。这三个目标在
  `release.yml` 里**每次发版都编**（Linux 那三格，**一个 target 一个 job**），
  所以「编得出来」是绿过的；⚠️ 但那**不能**推出「`build.sh` 里串起来也能编」——
  2026-09-28 恰好证明了这一点。
- **LuCI 界面没在真的 LuCI 里跑过**（本机没有 `lua`/`luac`，语法只能靠读）。
- `usr/share/luci/i18n/clip9.po` 会被打进去，但 **LuCI 认的是编译出来的 `.lmo`**，
  而这条手工打包链路不做那步编译 —— 所以界面目前**只有中文**（与 Go 版一致）。
  真要用翻译，得走 OpenWrt buildroot（`luci-app-clip9/Makefile` 那条路）。
- 包里的文件属主是**打包者的 uid**（本机打包就是 `501`）—— tar 的
  `--owner` / `--uid` 是 GNU tar 的选项，macOS 的 bsdtar 不认，所以这里没做归一。
  实际影响很小：`opkg`/`apk` 以 root 解包，权限位（755 / 644）才是起作用的那项。
