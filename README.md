<h1 align="center"> clip9 </h1>

<p align="center">
  <a href="https://github.com/Jonnyan404/clip9/releases/latest">
    <img src="https://img.shields.io/github/v/release/Jonnyan404/clip9?color=brightgreen&include_prereleases" alt="release">
  </a>
  <a href="https://github.com/Jonnyan404/clip9/releases">
    <img src="https://img.shields.io/github/downloads/Jonnyan404/clip9/total?color=brightgreen&include_prereleases" alt="downloads">
  </a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license"></a>
  <img src="https://img.shields.io/badge/Rust-2024_edition-dea584.svg?logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/Android-Kotlin-3ddc84.svg?logo=android&logoColor=white" alt="Android">
</p>

<p align="center">
  <strong>自托管的跨设备剪贴板 / 文件中转 —— 文本、图片、文件在手机、电脑、路由器之间实时互传。</strong><br>
  用 Rust 重写自 <a href="https://github.com/Jonnyan404/cloud-clipboard-go">cloud-clipboard-go</a>，数据完全握在自己手里。
</p>

---

## 📖 目录

- [这是什么](#-这是什么)
- [优势特性](#-优势特性)
- [快速开始（安装步骤）](#-快速开始安装步骤)
  - [方式一：Docker（推荐）](#方式一docker推荐)
  - [方式二：独立二进制](#方式二独立二进制)
  - [方式三：OpenWrt 路由器](#方式三openwrt-路由器)
  - [方式四：Android 手机](#方式四android-手机)
  - [方式五：Cloudflare Workers](#方式五cloudflare-workers)
  - [方式六：从源码构建](#方式六从源码构建)
- [配置说明](#-配置说明)
- [使用示例](#-使用示例)
- [客户端与辅助工具](#-客户端与辅助工具)
- [项目结构](#-项目结构)
- [贡献指南](#-贡献指南)
- [更新日志与发版](#-更新日志与发版)
- [许可证与致谢](#-许可证与致谢)

---

## 🎯 这是什么

**clip9** 是一个**自托管**的云剪贴板：把一台服务器（VPS、NAS、树莓派、路由器，甚至手机）变成你自己
的中转站，让同一个局域网内、或经你自己反向代理暴露出去的设备之间实时互传**文本、图片和文件**。
所有数据都留在你的机器上，不经过任何第三方。

它由三块组成：

| 组成 | 是什么 |
|---|---|
| **服务端** | 一个静态二进制（源码里叫 `clip9-server`，Release 产物叫 `clip9-cli`），前端产物编在里面，一个文件丢过去就能跑。HTTP + WebSocket。 |
| **网页界面（SPA）** | 服务端下发的 Vue3 单页应用 —— 浏览器打开即用，提供时间流 / 速览 / 便签 / 看板等多种模式，可安装为 PWA。 |
| **客户端外壳** | 桌面端（Tauri）、Android（Kotlin 外壳 + 内嵌 WebView）、Apple / Android 快捷指令。 |

> ℹ️ **与 `cloud-clipboard-go` 的关系**：这是同一个产品的 **Rust 重写版**，也是它的**超集**。
> Go 版随之退役，「换过来」在 Docker 那一路只需要改 `image` 那一行 —— 环境变量名、命令行参数名
> 都与 Go 版**逐一对齐**。唯一的差异见下文 [配置说明](#-配置说明)。

---

## 🎯 优势特性

| 特性 | 说明 |
|---|---|
| 🔒 **隐私安全** | 部署在本地或自有服务器，数据不离开你的机器 |
| 📦 **部署灵活** | 一个静态二进制同时供应 Docker、裸机、OpenWrt 与 Android；另有 Cloudflare Serverless 一路 |
| 🌍 **跨平台** | 服务端覆盖 Linux / macOS / Windows / ARM 路由；客户端有桌面、Android 与快捷指令 |
| ⚡ **实时同步** | WebSocket 双向广播，历史走 HTTP 分页拉取（只推实时、不推全量） |
| 🔐 **认证保护** | 全局密码、**按房间独立密码**、可续期的会话令牌、带密码的分享链接 |
| 🎨 **多种界面模式** | 时间流 / 速览 / 便签 / 看板等，地址里的 `?mode=` 让同一个浏览器标签页锁定一种模式 |
| 🧩 **动作库** | 一条内容可以用不同动作「换个方式看」：Markdown 渲染、JSON 美化、编解码、汉字注音、日期计算、哈希…… 也能把几个动作串成流水线 |
| ⏰ **定时自动化** | 按「每天 / 每周 / 仅一次 / 5 字段 cron」把渲染好的文本自动投进房间；正文支持模板变量（`{{date:+1d}}`、`{{latest}}`…） |
| 💾 **存储可靠** | 历史落在嵌入式 KV 库 [redb](https://github.com/cberner/redb)（纯 Rust、ACID、单文件），不再整份重写 JSON |
| 🔗 **分享链接** | 为单条内容生成短期分享链接，可限次数、可带密码；分享页自动注入 OG 卡片 |
| 🪶 **轻量** | 内存与体积都很小，16 MB flash 的路由器也能跑（可用编译特性裁掉字典类动作） |

---

## 🚀 快速开始（安装步骤）

> 服务端默认监听 **9501** 端口。装好之后浏览器打开 `http://<服务器地址>:9501` 就是界面。

### 方式一：Docker（推荐）

镜像：`ghcr.io/jonnyan404/clip9`（也有 Docker Hub 的 `jonnyan404/clip9`）。

> ⚠️ `latest` 标签**只在正式发布时才有**；预发布（prerelease）只推 `vX.Y.Z`。要用 beta 就把
> `image` 换成对应的 `ghcr.io/jonnyan404/clip9:vX.Y.Z`。

**极简启动：**

```bash
docker run -d \
  --name clip9 \
  --init \
  -p 9501:9501 \
  -v /path/to/data:/app/server-node/data \
  ghcr.io/jonnyan404/clip9:latest
```

> ⚠️ **`--init`（或 compose 里的 `init: true`）是必须的**：服务端没有装 SIGTERM 处理器，
> 而 PID 1 对没有处理函数的信号是内核直接忽略的 —— 不加它，`docker stop` 要等整整 10 秒
> 超时后才被 SIGKILL；加了 `tini` 转发信号，实测 **0.22 秒**。

**Docker Compose：**

仓库根目录自带一份 [`docker-compose.yml`](./docker-compose.yml)（写法与 Go 版一致）：

```yaml
services:
  clip9:
    container_name: clip9
    restart: always
    init: true
    ports:
      - "9501:9501"
    environment:
      LISTEN_PORT: ${LISTEN_PORT:-}            # 监听端口，默认 9501
      AUTH_PASSWORD: ${AUTH_PASSWORD:-}        # 全局访问密码，留空即无需密码
      ROOM_AUTH_JSON: '${ROOM_AUTH_JSON:-{}}'  # 房间密码 JSON，如 {"finance":"finance-pass","ops":""}
      MESSAGE_NUM: ${MESSAGE_NUM:-}            # 历史保留条数，默认 50
      TEXT_LIMIT: ${TEXT_LIMIT:-}              # 文本长度上限（字节），默认 4096
      FILE_EXPIRE: ${FILE_EXPIRE:-}            # 文件过期秒数，默认 3600
      FILE_LIMIT: ${FILE_LIMIT:-}              # 文件大小上限（字节），默认 104857600
      MKCERT_DOMAIN_OR_IP: ${MKCERT_DOMAIN_OR_IP:-} # 填入域名/IP 即用 mkcert 自动签发自签证书
    volumes:
      - /path/your/dir/data:/app/server-node/data # 请改成你自己的目录
    image: ghcr.io/jonnyan404/clip9:latest
```

```bash
docker compose up -d
```

完整的可用环境变量见 [配置说明](#-配置说明)。

### 方式二：独立二进制

前往 [Releases](https://github.com/Jonnyan404/clip9/releases) 下载对应平台的压缩包。
**产物名里带版本号**，格式是 `clip9-cli-v<版本>-<平台>-<架构>.tar.gz`（Windows 是 `.zip`）：

| 平台 | 架构 | 产物名示例 |
|---|---|---|
| Linux | x86_64 / aarch64 / armv7 | `clip9-cli-v0.1.1-beta1-linux-x86_64.tar.gz` |
| macOS | aarch64 / x86_64 | `clip9-cli-v0.1.1-beta1-macos-aarch64.tar.gz` |
| Windows | x86_64 | `clip9-cli-v0.1.1-beta1-windows-x86_64.zip` |

Linux 那三份是**静态链接 musl** 的，Alpine / 各种精简系统直接扔进去就能跑。

```bash
tar -xzf clip9-cli-v0.1.1-beta1-linux-x86_64.tar.gz
cd clip9-cli-v0.1.1-beta1-linux-x86_64

# 最简：用默认配置（config.json 不存在会自动生成一份），数据放 ./data
./clip9-cli -data ./data

# 指定端口与密码，历史保留 200 条
./clip9-cli -port 9501 -auth mypassword -history 200 -data /var/lib/clip9
```

**常用命令行参数**（⚠️ 名字与 Go 版**完全一致**，`-flag 值` 与 `-flag=值` 两种写法都收；
也可以走环境变量 `CLIP9_<参数名大写>`，如 `CLIP9_PORT`）：

| 参数 | 说明 |
|---|---|
| `-config <路径>` | 配置文件路径（默认 `config.json`） |
| `-host <地址>` | 监听地址（默认 `0.0.0.0`，支持逗号分隔多个） |
| `-port <端口>` | 监听端口（默认 `9501`） |
| `-auth <密码>` | 全局访问密码 |
| `-data <目录>` | **数据目录**（redb 库与 `uploads/` 的根，默认 `./data`） |
| `-dbpath <路径>` | 库文件路径，相对路径**相对数据目录**解析 |
| `-storage <目录>` | 上传文件目录，相对路径**相对数据目录**解析 |
| `-prefix <前缀>` | 子路径前缀（配合 Nginx 反代，如 `/clip9`） |
| `-history <条数>` | 历史保留条数 |
| `-text_limit <字节>` | 文本长度上限 |
| `-file_expire <秒>` | 文件过期时间 |
| `-file_limit <字节>` | 文件大小上限 |
| `-cert` / `-key <路径>` | 直接指定 TLS 证书与私钥 |
| `-static <目录>` | 用外部前端产物**盖住**编进二进制的那一份（调前端时用） |
| `-v` / `-h` | 显示版本 / 帮助 |

> ⚠️ 字符串参数**非空才覆盖**、数字参数**大于 0 才覆盖**（与 Go 版同语义）；认不出的参数会**报错**，
> 绝不静默忽略 —— 免得出现「配了却不生效」。

**从 Go 版迁移历史数据**：`clip9-server` 带一个 `migrate` 子命令（幂等，且**原始数据一个字节都不动**）：

```bash
./clip9-cli migrate -from /old/go/data -dry-run   # 先看会做什么
./clip9-cli migrate -from /old/go/data            # 真跑（须在服务停着时执行）
```

### 方式三：OpenWrt 路由器

两种包格式，按系统版本选：

| OpenWrt 版本 | 包格式 | 安装 |
|---|---|---|
| 25.12 及以上 | `.apk` | `apk add --allow-untrusted /tmp/clip9-openwrt-apk-v<版本>-<架构>.apk` |
| 24.10 及以下 | `.ipk` | `opkg install /tmp/clip9-openwrt-v<版本>-<架构>.ipk` |

把包先传到设备再装（LuCI 界面是**单独的包**，要一起装才有网页可点）：

```sh
scp clip9-openwrt-v0.1.0-aarch64.ipk      root@192.168.1.1:/tmp/
scp clip9-luci-openwrt-v0.1.0-all.ipk     root@192.168.1.1:/tmp/
```

- 配置：UCI `/etc/config/clip9`；数据（库 + 上传）在 `/etc/clip9/data`；高级项在 `/etc/clip9/config.json`。
- 改完配置：`/etc/init.d/clip9 restart`。
- 装完两个包后 `/etc/init.d/uhttpd restart`，在 LuCI「服务」菜单里就是 Clip9。
- 支持 **7 个架构**（x86_64、aarch64、5 个 armv7 变体）；**没有 mips/mipsel**（Rust 里它们是 Tier 3）。

⚠️ 数据目录在 `/etc/clip9/data` 而不是 `/var/lib` —— OpenWrt 的 `/var` 通常是指向 `/tmp` 的软链
（tmpfs），放那儿每次重启历史就没了。详见 [`openwrt/README.md`](./openwrt/README.md)。

### 方式四：Android 手机

前往 [Releases](https://github.com/Jonnyan404/clip9/releases) 下载 `clip9-android-v<版本>.apk`
（一个包内含三个 ABI）并安装。

App 里跑的是**服务端**（Rust 编成 `.so`，由前台服务托管），界面用内嵌 WebView 加载 —— 可以切
「本机」或「远端」：

1. 打开 App，在「配置」页设置监听端口、密码等，点**启动服务**；
2. 同局域网内其他设备访问 `http://手机局域网IP:9501` 即可；
3. 也可以把手机当**客户端**：在「连接」页添加远端服务器（可存多台，各带自己的密码），
   点进去直接用内嵌界面打开那台服务器，登录密码会自动换取会话令牌。

> ⚠️ 为保证后台不被系统杀掉，请把 App 加进**电池优化白名单**；服务端运行时会有一条常驻通知
> （这是 Android 的要求，它表示「别的设备能连过来」）。构建细节见 [`android/README.md`](./android/README.md)。

### 方式五：Cloudflare Workers

不想自托管的话，可以把整套跑在 Cloudflare 上（Workers + D1 + R2，SPA 静态资源与页面访问免费
且不计 Worker 请求配额）。支持 GitHub Actions 自动部署与本地脚本部署，详见
[`cloudflare/README.md`](./cloudflare/README.md)。

> ⚠️ Cloudflare 那一路**没有调度器**，所以「定时自动化」只在 Rust 服务端可用。

### 方式六：从源码构建

**前置依赖：**

- **Rust**（stable）—— 工具链与目标平台由 [`rust/rust-toolchain.toml`](./rust/rust-toolchain.toml) 决定，
  用 [rustup](https://rustup.rs/) 会自动装齐。
- **Node.js ≥ 22**（只有改前端时才需要）。

```bash
# 1. 前端产物（⚠️ 仓库里已带一份入库的产物，不改前端可跳过）
cd web-vue3
npm ci
npm run build

# 2. 把 dist 同步进 rust/crates/server/static/（它会被编进二进制）
node tools/sync-web-assets.mjs

# 3. 编服务端（⚠️ cargo 只能在 rust/ 里跑，仓库根没有 Cargo.toml）
cd ../rust
cargo build --release -p clip9-server

# 4. 跑起来
./target/release/clip9-server -data ./data
```

---

## ⚙️ 配置说明

服务端读一个 JSON 配置文件（默认 `config.json`，不存在时会**自动生成一份默认的**）。
Docker 与 OpenWrt 下由入口脚本 / UCI 生成。

```json
{
  "server": {
    "host": ["0.0.0.0"],
    "port": 9501,
    "prefix": "",
    "history": 50,
    "dbPath": "clip9.redb",
    "storageDir": "uploads",
    "auth": false,
    "roomAuth": {},
    "cert": "",
    "key": "",
    "roomList": false,
    "roomCleanup": 3600
  },
  "text": { "limit": 4096 },
  "file": { "expire": 3600, "chunk": 1048576, "limit": 268435456 },
  "automation": { "enabled": true, "tickSeconds": 30, "graceSeconds": 600, "defaultTZ": "Asia/Shanghai" }
}
```

| 字段 | 说明 |
|---|---|
| `server.host` | 监听地址，可以是字符串或数组（`-host` 支持逗号分隔） |
| `server.port` | 监听端口，默认 `9501`。**被占用时明确报错，绝不静默换端口** |
| `server.prefix` | 子路径前缀，配合 Nginx 反代使用 |
| `server.history` | 每房间历史保留条数 |
| `server.dbPath` | redb 库文件路径；**相对路径相对数据目录解析**（不是相对 cwd） |
| `server.storageDir` | 上传文件存放目录，同上 |
| `server.auth` | 全局密码。可以是 `false` / 字符串密码 / 数字 |
| `server.roomAuth` | 房间密码表。值是**字符串**（该房间密码）或**对象**（高级项，如 `{"finance":"pass","keep":{"password":"kp","automation":true}}`）。空字符串表示该房间沿用全局 `auth` |
| `server.cert` / `key` | TLS 证书与私钥路径，都留空则不起 TLS |
| `server.roomList` | 是否在前端展示公开房间列表 |
| `text.limit` | 文本长度上限（**字节**，一个汉字 3 字节） |
| `file.expire` | 文件过期秒数，`0` 为不过期 |
| `file.limit` | 文件大小上限（字节） |
| `automation.enabled` | 定时自动化总开关（默认 `true`） |
| `automation.defaultTZ` | 定时任务默认时区 |

> ⚠️★ **配置必须嵌在 `server` 键下**（`{"server":{"port":…}}`）。平铺会被静默忽略并回落默认值。
>
> ⚠️★ **JSON 里不许有注释**：这边是严格解析，**解析失败直接退出**（这是刻意与 Go 版不同 ——
> Go 会打一行日志然后用默认值继续跑，那意味着一个拼错的配置会让服务**不带密码**地起来）。
>
> ⚠️ 已经存在 `config.json` 时**一个字都不动**：想让它重新生成，删掉那个文件即可。

**Docker 环境变量**（§[方式一](#方式一docker推荐) 里已列举常用项）与之对应关系：

| 环境变量 | 对应配置 |
|---|---|
| `LISTEN_IP` / `LISTEN_IP6` / `LISTEN_PORT` | `server.host` / `server.port` |
| `PREFIX` | `server.prefix` |
| `MESSAGE_NUM` | `server.history` |
| `AUTH_PASSWORD` | `server.auth` |
| `ROOM_AUTH_JSON` | `server.roomAuth` |
| `ROOM_LIST` | `server.roomList` |
| `TEXT_LIMIT` | `text.limit` |
| `FILE_EXPIRE` / `FILE_LIMIT` | `file.expire` / `file.limit` |
| `MANUAL_KEY_PATH` / `MANUAL_CERT_PATH` | `server.key` / `server.cert`（优先级高于 mkcert） |
| `MKCERT_DOMAIN_OR_IP` | 填了就用 mkcert 自动签发自签证书（域名/IP 变了会自动重签） |
| `AUTOMATION_ENABLED` / `DEFAULT_TZ` | `automation.enabled` / `automation.defaultTZ`（clip9 专有） |

---

### 迁移 Go 版数据

```bash
./clip9-cli migrate -from /old/go/data -dry-run
./clip9-cli migrate -from /old/go/data
```

> 完整的 HTTP + WebSocket 契约见 [`docs/openapi/`](./docs/openapi/README.md)
> （OpenAPI 3.1，31 条路径 / 51 个 schema，每个响应都带具名示例）。

---

## 📱 客户端与辅助工具

| 形式 | 平台 | 说明 |
|---|---|---|
| **网页界面（SPA）** | 全平台浏览器 | 服务端内置下发，可安装为 PWA |
| **桌面端** | Windows / macOS / Linux | Tauri 壳 + 原生剪贴板监听，双向静默同步（界面是手写的紧凑版） |
| **Android App** | Android | 手机一键开服 + 内嵌 WebView 界面 + 远端服务器管理 |
| **Apple 快捷指令** | iOS / macOS | 原生快捷指令，发送文本/文件、按 id 拉取 — [`shortcuts/apple/`](./shortcuts/apple) |
| **Android 快捷指令** | Android | 配合 [HTTP Shortcuts](https://http-shortcuts.rmy.ch/) 实现系统分享 — [`shortcuts/android/`](./shortcuts/android) |

---

## 🗂️ 项目结构

```
clip9/
├── rust/            # ★ 全部 Rust 都在这格（顶层没有 Cargo.toml）
│   └── crates/
│       ├── protocol/   # 契约层：请求/响应/WS 事件的 serde 类型，零 IO（要能编到 wasm32）
│       ├── core/       # 领域逻辑：房间鉴权、会话令牌、分享 token、模板引擎、cron
│       ├── actions/    # 动作库：纯函数、无 IO，同一份代码编成原生 + WASM
│       ├── store/      # redb 封装：只有这里知道存储长什么样
│       ├── server/     # axum HTTP + WS；lib（可内嵌）+ bin（独立跑）；static/ 是编进二进制的前端产物
│       ├── client/     # 剪贴板监控 + 上下行（被桌面端复用）
│       ├── desktop/    # Tauri 壳（含手写界面 ui/）
│       └── android/    # Android 外壳的 JNI 桥（cdylib）
├── web-vue3/        # 前端 SPA 源码（构建产物编进服务端二进制）
├── cloudflare/      # Worker + D1 + R2
├── shortcuts/       # 快捷指令的唯一源
├── cases/           # 语言无关的契约用例 JSON（契约测试的输入）
├── tools/           # 静态自检 / 实机验收脚本（Node）
├── android/         # Android 外壳（Kotlin）
├── openwrt/         # OpenWrt 打包（ipk / apk + LuCI）
├── docs/openapi/    # HTTP / WS 契约的 OpenAPI 描述
├── Dockerfile · docker-compose.yml · entrypoint.sh
└── CHANGELOG.md     # ★ 发布说明的唯一维护处
```

依赖方向是**单向**的：`protocol ← core ← store ← server ← { bin, client }`，
`actions` 被 `core` / `server` 共用（同一份代码编成原生 + WASM），
`desktop` / `android` 是**最末端**的外壳。

---

## 🤝 贡献指南

欢迎提 Issue 与 PR。改动之前，先看一眼 [`CHANGELOG.md`](./CHANGELOG.md) 了解当前进度。

> ℹ️ 仓库里有一份内部的工程约定与设计稿（`dev-docs/`），它**刻意不入库** —— 里面混着工作过程
> 记录。所以代码注释里会看到 `见 dev-docs/ARCHITECTURE.md §8` 这类指针，对只拿到仓库的人来说
> 那些指向的是不存在的东西，这是**有意的取舍**。你要的「怎么做」都在下面的门禁与代码注释里。

### 环境准备

- **Rust** stable（工具链由 [`rust/rust-toolchain.toml`](./rust/rust-toolchain.toml) 决定）。
- **Node.js ≥ 22**（改前端、跑 `tools/` 下的脚本时需要）。
- Linux 上编桌面端需要 Tauri 的系统库（`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libsoup-3.0-dev` 等）。

### 门禁：提交前必跑，零警告是硬要求

```bash
cd rust

cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings   # ⚠️ -D warnings 不是「尽量」
cargo test  --workspace

# 动作库是「一份 Rust 编两次」，不带默认特性那次也要干净（OpenWrt 那档就靠它）
cargo clippy -p clip9-actions --no-default-features --all-targets -- -D warnings
cargo test   -p clip9-actions --no-default-features
```

⚠️★ **`cargo` 只能在 `rust/` 里跑** —— 仓库根没有 `Cargo.toml`。

---

## 📄 许可证与致谢

本项目基于 [MIT License](./LICENSE) 开源。

前端与后端最初 fork 自以下开源项目并加以修改：

- [TransparentLC/cloud-clipboard](https://github.com/TransparentLC/cloud-clipboard)
- [yurenchen000/cloud-clipboard](https://github.com/yurenchen000/cloud-clipboard)

以及它的 Go 前身：[Jonnyan404/cloud-clipboard-go](https://github.com/Jonnyan404/cloud-clipboard-go)。
