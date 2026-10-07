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
| `FILE_EXPIRE` | ➖ | 全局文件过期时间（秒，默认 `3600` 即 1 小时） |
| `FILE_CLEANUP` | ➖ | 过期文件后台回收的**开关**（秒。`<= 0` = 关掉，默认 `300` = 开）。⚠️ 它**不管周期**，周期在模板的 `[triggers]` cron 里（默认每 5 分钟） |

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

---

## 📉 免费额度占用（过期文件回收）

后台回收每 **5 分钟**跑一轮（cron 触发器）。实测与免费配额对照：

| 项目 | 一轮（空扫 → 满批 40 条） | 一天（288 轮的上界） | 免费额度 | 占比 |
| :--- | :--- | :--- | :--- | :--- |
| Worker 请求 | 1 | 288 | 100,000/天 | 0.29% |
| cron CPU | ≈ 0.005 ms → ≈ 1.2 ms | — | **10 ms/次调用** | 满批约 12% |
| D1 行读 | 0 → 40 | ≤ 11,520 | 5,000,000/天 | ≤ 0.23% |
| D1 行写 | 0 → 40 | ≤ 11,520 | 100,000/天 | ≤ 11.5% |
| R2 操作 | 0 → 1 次批量删 | ≤ 288 | — | **删除是免费操作** |
| DO 请求（广播 revoke） | 0 → 40 | ≤ 11,520 | 100,000/天 | ≤ 11.5% |

- **「空扫」是绝大多数轮次的真实形态**：查询走 `idx_messages_expire` 的区间扫描
  （`EXPLAIN QUERY PLAN` 实测），没有已过期行时**读 0 行**、不碰 R2、不广播 ——
  一轮的成本约等于一次空查询。
- 上表的「一天」按**每轮都满批**（40 条 = 每天 11,520 个文件过期）算，是**上界**；
  真实用量随实际过期文件数成比例缩小。日常自用实例基本落在「空扫」那一列。
- R2 的 `DeleteObject` 属于**免费操作**（不计入 Class A/B）—— 回收这一侧不花额度；
  反过来，**不回收**才会让死文件慢慢吃掉 R2 的 10GB 免费存储。
- ⚠️ 免费档唯一的紧约束是 **cron 每次调用 10 ms CPU**：`broadcastMessage` 的逐条日志
  在满批时会变成 40 行，实测整轮从 ≈1.2 ms 涨到 ≈6.8 ms ——
  所以回收这一路传了 `quiet: true`，结论由一行汇总打印。
- ⚠️ 改周期只能改模板里的 cron 表达式（免费档每个账号最多 5 个触发器）。

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
