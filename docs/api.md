# clip9 API（中文说明）

> ⚠️★ **字段级的权威是 [`openapi/clip9.openapi.yaml`](./openapi/clip9.openapi.yaml)，不是这份文档。**
> 那份规格是从 `rust/crates/server/src/lib.rs` 的路由表和各个处理器里读出来的，
> 而且有一条**会逐个校验示例是否符合 schema** 的检查（见 [`openapi/README.md`](./openapi/README.md)）。
> 这里写的是**散文部分**：为什么这样设计、哪些地方容易踩、以及一份路径索引。
> 两者冲突时**以规格和代码为准**。

在线渲染版：<https://jonnyan404.github.io/clip9/api.html>

---

## 一、这个 API 的形状

一个**按房间隔离**的剪贴板：客户端把文本或文件投进某个房间，房间里其他成员**实时**收到。

- **HTTP**：发内容、取历史、管文件、管分享链接、管定时任务。
- **WebSocket**（`/push`）：只推**实时**，不推全量。历史一律走 HTTP 分页拉取。

⚠️★ 这条分工是整个协议里最重要的一条：**连上之后不会重放历史**。
所以「刚连上时界面是空的」不是 bug —— 要历史就去 `GET /content`。

### 路径索引

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/server` | 服务能力与当前鉴权状态 |
| GET | `/healthz` | 存活探针（**实现附赠**，不属于契约） |
| POST | `/auth/token` | 用密码换一个 1 小时的会话令牌 |
| POST | `/auth/token/refresh` | 续期会话令牌（不用再给密码） |
| POST | `/text` | 发一条文本（带 `id` 时是**原地改**） |
| GET | `/content` | 历史分页（游标是 `id`） |
| GET | `/content/latest` | 最新一条 |
| GET | `/content/{id}` | 按 id 取一条 |
| POST | `/content/{id}/column` | 改看板里那一列 |
| GET | `/rooms` | 房间列表 |
| GET | `/stats/daily` | 房间每天的活跃度（热力图的数据源） |
| POST | `/upload` | 小文件整份上传（multipart） |
| POST | `/upload/chunk` · `/upload/chunk/{uuid}` · `/upload/finish/{uuid}` | 分片上传 |
| POST | `/file/{uuid}` | 下载（`GET /file/{uuid}/{name}` 同） |
| DELETE | `/file/{uuid}` | 删文件 |
| POST | `/revoke/{id}` · `/revoke/all` | 撤回一条 / 清空 |
| POST | `/share` | 为一条内容签一个分享链接 |
| GET | `/share` · `/share/list` · `/share/visit` | 查分享信息 / 列表 / 记一次访问 |
| GET | `/s/{token}` | 分享落地页（带 OG 卡片） |
| GET | `/push` | **WebSocket** |
| GET/POST | `/tasks` · `/tasks/{id}` · `/tasks/{id}/run` · `/tasks/{id}/toggle` | 定时自动化 |
| GET | `/tasks/preview` · `/tasks/cron` · `/tasks/rooms` | 预览 / cron 说明 / 哪些房间允许 |

---

## 二、鉴权：三种带法 × 四种凭据

### 凭据有四种

| 凭据 | 从哪来 | 能干什么 |
|---|---|---|
| **全局密码** | 配置里的 `server.auth` | 一切 |
| **房间密码** | `server.roomAuth[房间]` | 只对这个房间 |
| **会话令牌** | `POST /auth/token` 换来的（1 小时） | 与换来它的那个凭据同级 |
| **分享令牌** | `POST /share` 签出来的 | **只读一条内容**，可限次数、可带密码 |

### 带法有三种

```http
Authorization: Bearer <凭据>          # 首选
GET /content?auth=<凭据>              # 不方便带头时（<img src> 这类）
Sec-WebSocket-Protocol: <凭据>        # WebSocket 专用
```

⚠️★ **WebSocket 上不要用 `?auth=`**：查询串会进服务端日志、也会进浏览器的历史记录。
`Sec-WebSocket-Protocol` 是唯一不进 URL 的带法（浏览器上也只能用它）。

⚠️ 一个凭据能带**多个**房间密码：主凭据走上面三种之一，其余的用
`X-Room-Auth-Tokens`（JSON 数组或逗号分隔）。这是「一个客户端同时看得到自己所有房间」的办法。

---

## 三、错误：一种形状

```json
{ "code": "room_forbidden", "error": "Room forbidden", "message": "无权访问该房间" }
```

- `code` 给程序判断，`message` 给人看（**中文**，界面直接显示）。
- ⚠️★ **不按 `Accept` 分叉** —— 不管客户端要 HTML 还是 JSON，错误一律是这一个形状。
  分叉过一次的话，`<img src>` 拿到的会是一整页 HTML，而那是最难查的一类问题。

常见 `code`：`unauthorized` / `room_forbidden` / `room_auth_required` / `file_expired` /
`invalid_content_id` / `text_too_large` / `file_too_large` / `share_expired` / `share_exhausted`。

---

## 四、限额从哪来

| 限额 | 出处 |
|---|---|
| 文本长度 | WS 的 `config` 帧里的 `textLimit`（**不在 `/server` 里**） |
| 文件大小 | WS 的 `config` 帧里的 `fileLimit` |
| 历史条数 | `GET /server` 里的 `historyLimit` |
| 文件过期 | `config` 帧里的 `fileExpire`（秒） |

⚠️★ 前两项**只从 WebSocket 的 `config` 帧给**，`/server` 里没有 —— 因为限额是**握手时**
服务端按房间策略算出来的，而 `/server` 是无状态的。客户端**在拿到 `config` 之前不该猜**。

⚠️ 另有一套**每请求的绝对上限**（与上面那套是两回事）：它们防的是「一次请求把内存吃满」，
不受房间策略影响，超了直接拒。

---

## 五、实时：`/push` 的帧

OpenAPI 没有原生 WebSocket 支持，所以帧的契约写在 `/push` 那条的 `x-websocket-events` 扩展里。
要点：

| 帧 | 什么时候来 |
|---|---|
| `config` | **连上后第一帧**，带着 `latestId`（水位）与上面那几个限额 |
| `add` | 房间里来了新内容 |
| `revoke` | 某条被撤回 |
| `connect` / `disconnect` | 设备上下线 |
| `ping` / `pong` | 应用层心跳（测延迟，也用来判死） |

⚠️★ **`config` 必须排在实时之前**：`latestId` 是「哪些算历史」的边界 ——
`id <= latestId` 只当历史认领（**不写剪贴板**），`id > latestId` 才是实时。
少了它，边界上的那几条会被处理两次，或者把整段历史灌进剪贴板。

---

## 六、与 Go / Worker 那两版的差异

本仓库只实现 Rust 这一份；Go 版已退役，Cloudflare Worker 是另一条部署路。三边**不是逐字段一致**的：

| 地方 | Go / 旧文档 | 这一版（Rust） |
|---|---|---|
| `/content` 的格式参数 | `?format=` 优先级 1–5 | `?json=1` 是兼容保留，`.json` 后缀**已去掉**（`/content/7.json` → `400 invalid_content_id`） |
| `GET /content/latest` 不带 `room` | 「取全房间最新的」 | 取 **`default` 房间**；要跨房间得显式 `?all=1` |
| `/upload` 的响应 | `uuid` / `name` / `size` / `expire` | 只有 `{url, id, type}` |
| `/revoke/{id}` · `/revoke/all` | `DELETE` | **只接受 `POST`**（浏览器误点 `/revoke/5` 不该删掉东西） |
| `/push` 的凭据 | 文档写 `?token=` | `?auth=` / `Authorization` / `Sec-WebSocket-Protocol` |
| `/file/{uuid}` | — | 也接受 `DELETE`；分享令牌**只对 `GET` 有效** |
| `senderDevice` | 与设备事件同键 | 自由形状的字符串表（`type` / `os` / `browser` / `name`） |
| `/tasks/preview` 的参考时刻 | — | 回 `referenceAt2`，而试跑一个已存任务时叫 `scheduledAt` |
| `GET /content/{id}/column` 的鉴权错 | — | `room_auth_required`，不是 `room_forbidden` |

⚠️ `/stats/daily`（热力图那条）**只有 Rust 与 Worker 两版有**，Go 版从来没有。

---

## 七、自己校验

```bash
python3 -m pip install pyyaml openapi-spec-validator jsonschema
python3 docs/openapi/check-openapi.py
```

⚠️★ 这个检查里**真正值钱的是示例那一半**：`openapi-spec-validator` 只能证明文档**格式**合法，
它照样接受「示例描述的响应服务端永远不会发」。而示例是会被抄的 ——
生成客户端会照抄、人也会照抄，所以**示例错了比没有示例更坏**。
