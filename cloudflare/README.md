# Cloudflare 部署文档

本文档说明如何将 clip9 部署到 Cloudflare Workers（一体化部署：SPA 静态前端 + API/WebSocket 后端 + D1 数据库 + R2 存储桶）。

---

## 🏗️ 架构与部署原理

部署包含以下组件：
- **Cloudflare Workers**：托管后端 API 与 WebSocket 通信（Durable Objects）。
- **Workers Static Assets**：托管 Vue3 构建的静态前端，**静态资源与页面访问免费且不计 Worker 请求配额**。
- **Cloudflare D1**：存储剪贴板历史文本与文件元数据（SQLite）。
- **Cloudflare R2**：存储上传的文件与图片。

---

## 🚀 部署方式

### 方式一：GitHub Actions 自动部署（推荐）

仓库已提供自动化工作流 [.github/workflows/deploy-cloudflare.yml](../.github/workflows/deploy-cloudflare.yml)，无需本地安装工具。

#### 1. 配置 GitHub Secrets
在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中配置：

| Secret 名称 | 必填 | 说明 |
| :--- | :---: | :--- |
| `CF_API_TOKEN` | ✅ | Cloudflare API Token（在 Cloudflare 后台创建自定义 Token 时，需在 **Account** 范围添加以下 4 项权限）：<br>• **Workers Scripts** → **Edit**（包含 Worker 部署与 Durable Objects）<br>• **D1** → **Edit**（用于数据库迁移与管理）<br>• **Workers R2 Storage** → **Edit**（用于文件存储桶管理）<br>• **Account Settings** → **Read**（用于账号信息验证） |
| `CF_ACCOUNT_ID` | ✅ | Cloudflare 账号 ID（Dashboard 首页右下角或 URL 中查看） |
| `AUTH_PASSWORD` | ✅ | 全局访问密码 |
| `ROOM_AUTH_JSON` | ✅ | 房间级密码与过期配置（**填原始 JSON，不要加 `\` 转义**，见下文示例） |
| `ROOM_LIST` | ➖ | 是否启用房间列表展示（可选：`true` / `false`，默认 `false`） |
| `HISTORY_LIMIT` | ➖ | 房间历史消息条数（默认 `50`） |
| `TEXT_LIMIT` | ➖ | 文本最大字符数（默认 `40960`） |
| `FILE_LIMIT` | ➖ | 单文件大小上限（字节，默认 `204857600` 即 200MB） |
| `FILE_TOTAL_LIMIT` | ➖ | **所有未过期文件加起来**的上限（字节，默认空 = 不限制）。公开实例必设，见下文「防止账单爆炸」 |
| `FILE_EXPIRE` | ➖ | 全局文件过期时间（秒，默认 `3600` 即 1 小时） |
| `FILE_CLEANUP` | ➖ | 过期文件后台回收的**开关**（秒。`<= 0` = 关掉，默认 `300` = 开）。⚠️ 它**不管周期**，周期在模板的 `[triggers]` cron 里（默认每 5 分钟） |
| `ALLOW_ORIGINS` | ➖ | **前后端分离部署**时前端所在的来源（逗号分隔，例 `https://clip.example.com`）。不设 = `*`（谁都能跨源读，历史行为）。见下文「前后端分离部署」 |

#### 2. 触发部署
进入 GitHub 仓库 **Actions** 页面，找到 **Deploy Cloudflare Worker**，点击 **Run workflow** 即可一键完成构建与部署。

---

### 方式二：本地脚本一键部署

#### 1. 前置准备
- 安装 [Node.js](https://nodejs.org/)（>= 22.12）与 npm
- 全局安装 Wrangler 并登录：
  ```bash
  npm install -g wrangler
  wrangler login
  ```

#### 2. 自定义配置（可选）
如需修改默认密码或限制，部署前编辑 [cloudflare/workers/wrangler.toml.template](workers/wrangler.toml.template)。

#### 3. 执行部署
```bash
cd cloudflare
bash deploy.sh
```
脚本会自动创建/复用 D1 与 R2 资源、构建前端、执行数据库迁移并部署 Worker。

---

### 方式三：公开演示站（独立 Worker + **另一个 Cloudflare 账号**）

给「想让人点开就试」的场景用：同一份代码的**第二次部署**，与主站完全隔离。

- 工作流：[.github/workflows/deploy-cloudflare-demo.yml](../.github/workflows/deploy-cloudflare-demo.yml)（同样是 **Actions → Run workflow** 手动触发）
- 只改**配置**，代码一行不同：Worker 叫 `clip9-demo`，D1 / R2 是 `clip9-db-demo` / `clip9-files-demo`，
  **单文件上限 3 MB**、文件 1 小时过期、历史 50 条、默认房间开放。
- 「3 MB」不是前端写死的：Worker 通过 WebSocket 的 `config` 事件下发 `file.limit`，
  界面上会直接显示「文件 3 MB」，超了在选文件那一步就被拦住。

#### 要配的 Secret（两个，都填**演示账号**的）

| Secret 名称 | 必填 | 说明 |
| :--- | :---: | :--- |
| `CF_API_TOKEN_DEMO` | ✅ | 演示账号的 API Token，权限与主站那个相同：**Workers Scripts** → Edit、**D1** → Edit、**Workers R2 Storage** → Edit（再加 **Account Settings** → Read 更省事） |
| `CF_ACCOUNT_ID_DEMO` | ✅ | 演示账号的 Account ID（Dashboard 首页右下角 / URL 里那串 32 位十六进制） |

⚠️★ 这两个名字与主站那两个（`CF_API_TOKEN` / `CF_ACCOUNT_ID`）**故意不同**，而且工作流里
**没有兜底**：漏设就红。用兜底的话，某天演示站的 secret 忘了配，它会拿着**生产账号**的令牌
把演示站塞进生产账号 —— 两个站从此共用一个账号，而且看起来一切正常。

⚠️ 新账号第一次部署前，先去控制台**开通 R2**（Account → R2 → Enable）。没开通时
`wrangler r2 bucket create` 会报一句和「桶名不对」看不出来的错。

#### 防止账单爆炸（公开实例必看）

公开站谁都能传，而 R2 免费额度是 **10 GB-month**。单文件上限（`FILE_LIMIT`）只管一个文件，
**管不住总量** —— 反复传能把它填满，而填满之后**不是报错，是开始计费**。所以演示站配了这一组：

| 旋钮 | 演示站的值 | 起什么作用 |
| :--- | :--- | :--- |
| `FILE_LIMIT` | 3 MB | 单个文件不能超 |
| `FILE_TOTAL_LIMIT` | 2 GiB | **所有未过期文件加起来**不能超；超了返回 507「文件空间已满」 |
| `FILE_EXPIRE` | 3600 | 文件 1 小时后过期，空间**自愈** |
| `FILE_CLEANUP` + `[triggers]` cron | 300 / 每 5 分钟 | 后台真的把过期文件从 R2 删掉 |

三条上传路径（整份 `POST /upload`、分片 `upload/chunk*`、`upload/multipart*`）**都在写字节之前**
判总量；另外分片会话有并发上限（20 个），防止「开了会话写一半就不管」的那部分字节没人管。
判据：`cloudflare/workers/test/upload-quota.test.mjs`（在 `test/run.sh` 里，部署前会跑）。

⚠️ 还建议在控制台加两道**外部**保险（代码管不着）：

- **R2 → Settings → Object lifecycle rules**：加一条 *Abort incomplete multipart uploads*（比如 1 天）。
  它是「会话开了一半就断掉」那些残留的唯一清道夫。
- **Account → Billing → Notifications**：设一个 R2 用量提醒（比如 5 GB）。

⚠️ 总量上限**不是**「防刷」的全部：文本消息不占 R2，但占 D1 的写入配额（免费 10 万行/天）。
真要防刷，还得在 Cloudflare 上加 Rate limiting 规则（按 IP 限制 `POST /text`、`POST /upload` 的频率）。

---

## ⚙️ 环境变量与配置说明

### 📌 `ROOM_AUTH_JSON` 填法避坑（重点）

`ROOM_AUTH_JSON` 用于配置特定房间的独立密码和文件过期时间。不同配置途径的格式要求不同：

#### 🟢 途径 A：GitHub Secrets / .env / Cloudflare 网页后台（填原始 JSON）
> ⚠️ **千万不要带 `\` 反斜杠**，直接输入标准 JSON 字符串即可：

```json
{"finance":{"password":"finance-pass","fileExpire":0},"archive":{"fileExpire":604800},"private":"","tmp":"quick-pass"}
```

#### 🔵 途径 B：直接编辑 `wrangler.toml.template` 文件（需要 `\` 转义）
> ⚠️ 因 TOML 语法双引号字符串限制，文件内必须对内层双引号加 `\` 转义：

```toml
ROOM_AUTH_JSON = "{\"finance\":{\"password\":\"finance-pass\",\"fileExpire\":0},\"archive\":{\"fileExpire\":604800},\"private\":\"\",\"tmp\":\"quick-pass\"}"
```

---

### 📝 房间配置规则与 `fileExpire`

每个房间的值支持两种写法：
1. **简写密码**：`"roomName": "pass"`（仅设置额外密码，文件沿用全局过期时间）
2. **对象配置**：`"roomName": {"password": "pass", "fileExpire": 0}`

| `fileExpire` 取值 | 含义 |
| :--- | :--- |
| **未设置** | 沿用全局 `FILE_EXPIRE` 时间 |
| **`0`** | **文件永久保留，永不过期**（前端显示“永久有效”） |
| **`> 0`** | 覆盖全局时间，自定义该房间过期秒数（例如 `604800` 为 7 天） |

> **注意**：
> - `fileExpire` 仅在文件上传瞬间生效，后续修改配置不会回溯已上传的文件。
> - 房间消息总数超过 `HISTORY_LIMIT` 产生轮转清理时，最旧的文件仍会被清理。
> - 到期的文件由后台任务**每 5 分钟**回收一次（Cloudflare cron 触发器 → `scheduled`），
>   语义与自建服务端一致：删 R2 字节 + 删 D1 条目 + 向该房间广播 `revoke`。
>   所以在「到期」与「下一次回收」之间，那条消息会短暂地以「已过期」形态留在历史里；
>   被回收之后再请求同一个 id 会变成 `message_not_found`（不再是 `file_expired`）。
>   ⚠️ 关掉它（`FILE_CLEANUP=0`）的代价是 R2 只涨不消 —— 没人再访问的过期文件不会自己消失
>   （R2 没有对象级 TTL）。周期想改就改模板里的 cron 表达式，改了要重新部署。

### 🌐 前后端分离部署（界面放别处，Worker 只当 API）

Worker 默认自己就把前端发了（`[assets]` 那一段），所以绝大多数人不需要这一节。
但如果你要把界面放在 CDN / 静态托管上、只让 Worker 当接口，做两件事：

1. **Worker 侧**：把前端的来源写进 `ALLOW_ORIGINS`（GitHub Secrets 或 `wrangler.toml` 的 `[vars]`）：

   ```toml
   ALLOW_ORIGINS = "https://clip.example.com"
   ```

   不填就是 `Access-Control-Allow-Origin: *`（历史行为）。填了就变成**逐条白名单**：
   不在名单里的来源连一个 CORS 头都拿不到，浏览器那边表现为
   「blocked by CORS policy」——**页面本身是好的**，只是数据不出现。
   ⚠️ 拼错一条只忽略那一条；**整份都拼错 = 当没配（仍是 `*`）**，所以填完随手
   `curl -I -H 'Origin: https://你的前端' https://<worker>/server` 看一眼响应头。

2. **前端侧**：用 [Releases](https://github.com/Jonnyan404/clip9/releases) 里的
   `clip9-web-<版本>.tar.gz`，改根目录 `config.js` 里那一行：

   ```js
   window.__CLIP9_API_BASE__ = 'https://<worker>.workers.dev/';
   ```

   填完在浏览器里打开这个静态站点即可（静态托管要开 SPA 回退，否则 `/s/<token>` 深链 404）。

> ⚠️ 与自建服务端的差别：Worker **没有** `<base>` 注入之外的 OG 落地页能力 ——
> 分享链接会指向前端的域名，社交平台的预览卡片拿不到（那是服务端渲染的）。
> ⚠️ 别把 `ALLOW_ORIGINS` 当成鉴权：它只决定「哪个网页能读响应」，读得到什么仍由
> 房间名 + 密码决定。

---

## 📉 免费额度占用（过期文件回收）

后台回收每 **5 分钟**跑一轮。绝大多数轮次是**空扫**（没有已到期文件）——查询走
`expireTime` 索引区间，**读 0 行**、不碰 R2 也不广播，成本约等于一次空查询。

| 项目 | 一轮（空扫 → 满批 40 条） | 一天（每轮都满批的上界） | 免费额度 |
| :--- | :--- | :--- | :--- |
| Worker 请求 | 1 | 288 | 100,000/天 |
| cron CPU | ≈ 0.005 ms → ≈ 1.2 ms | — | **10 ms/次调用** |
| D1 行读 / 行写 | 0 → 40 | ≤ 11,520 | 5,000,000 / 100,000（每天） |
| R2 操作 | 0 → 1 次批量删 | ≤ 288 | **删除属免费操作** |

- 上表「一天」按**每轮都满批**（每天 11,520 个文件过期）算，是**上界**；
  免费档唯一的紧约束是每次调用的 10 ms CPU。
- 回收这一侧不花额度；反而是**不回收**会让没人再访问的过期文件一直占着 R2 空间。
- 周期只能改模板里的 cron 表达式（免费档每个账号最多 5 个触发器），改了要重新部署。

---

## 🗄️ 数据库迁移与运维

- 数据库表结构位于 [cloudflare/d1/schema.sql](d1/schema.sql)。
- 部署脚本/CI 会自动执行远程迁移。如需单独手动执行迁移：
  ```bash
  cd cloudflare/workers
  wrangler d1 execute clip9-db --file=../d1/schema.sql --remote
  ```

---

## ❓ 常见问题排查

| 问题现象 | 排查与解决办法 |
| :--- | :--- |
| **部署提示 `wrangler whoami` 未登录** | 本地运行 `wrangler login`；CI 部署请检查 `CF_API_TOKEN` 和 `CF_ACCOUNT_ID` 是否正确填写。 |
| **修改了 `wrangler.toml` 后自动丢失** | `wrangler.toml` 是由脚本自动生成的临时文件。请修改模板文件 [wrangler.toml.template](workers/wrangler.toml.template)。 |
| **每次部署都把 `*.workers.dev` 域名重新打开** | 那个开关的主人是你**在控制台的位置**（Worker → Settings → Domains & Routes），但 `wrangler` **没有**「别管这个键」这一说：配置里不写 = 用**默认值 `true`**，于是每次部署都会照配置重设一遍。→ 部署流程已改成**部署前读一次当前状态、照原样写回**（[sync-workers-dev.mjs](sync-workers-dev.mjs)）：之后你关它就一直是关的，**部署不再对这个键表态**；首次部署（那时还没有这个 Worker）仍然是开的，否则新部署拿不到任何地址。⚠️ 本地 `deploy.sh` 那条路要设了 `CLOUDFLARE_API_TOKEN` 才会这么做，否则以模板里 `workers_dev = …` 那一行为准。 |
| **页面打开正常，但发消息或上传报错** | 1. 检查 D1 schema 是否已执行迁移；<br>2. 检查 `ROOM_AUTH_JSON` 是否为合法 JSON（避免多余反斜杠或格式错误）；<br>3. 检查 Cloudflare 控制台 Worker 是否成功绑定 D1(`DB`)、R2(`R2_BUCKET`)、Durable Object(`WEBSOCKET_ROOM`)。 |
| **macOS 提示本地 workerd 无法运行** | macOS 13.5 以下系统 workerd 无法本地运行，可直接运行 `SKIP_LOCAL_D1=1 bash deploy.sh` 跳过本地迁移，不影响远程部署。 |
