# clip9 API（中文说明）

> ⚠️★ **字段级的权威是 [`openapi/clip9.openapi.yaml`](./openapi/clip9.openapi.yaml)，不是这份文档。**
> 那份是从 `crates/server/src/lib.rs` 的路由表和各个处理器读出来的，还有一条会逐个校验示例的检查。
> 这里只写**散文那半**：为什么这样设计、哪里容易踩。冲突时以规格和代码为准。
>
> 在线版：<https://jonnyan404.github.io/clip9/api.html>

---

## 1. 形状

**按房间隔离**的剪贴板：内容投进房间，房间里其他人**实时**收到。

- **HTTP**：发内容、取历史、管文件 / 分享 / 定时任务。
- **WebSocket**（`/push`）：**只推实时，不推历史**。历史一律走 `GET /content` 分页。

⚠️★ 所以「刚连上时界面是空的」**不是 bug** —— 要历史就去请求历史。

### 路径一览

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/server` | 服务能力与当前鉴权状态 |
| GET | `/healthz` | 存活探针（**实现附赠**，不属契约） |
| POST | `/auth/token` · `/auth/token/refresh` | 换 / 续会话令牌（1 小时） |
| POST | `/text` | 发文本（带 `id` 是**原地改**） |
| GET | `/content` · `/content/latest` · `/content/{id}` | 历史分页 / 最新 / 按 id |
| POST | `/content/{id}/column` | 改看板那一列 |
| GET | `/rooms` | 房间列表 |
| GET | `/stats/daily` | 每天活跃度（热力图数据源） |
| POST | `/upload` · `/upload/chunk*` · `/upload/finish/{uuid}` | 整份 / 分片上传 |
| GET/DELETE | `/file/{uuid}` · `/file/{uuid}/{name}` | 下载 / 删 |
| POST | `/revoke/{id}` · `/revoke/all` | 撤回 / 清空 |
| POST/GET | `/share` · `/share/list` · `/share/visit` · `/s/{token}` | 分享链接与落地页 |
| GET | `/push` | **WebSocket** |
| GET/POST | `/tasks*` | 定时自动化 |

---

## 2. 鉴权

**四种凭据**：全局密码（一切）、房间密码（只对该房间）、会话令牌（1 小时，与换它的凭据同级）、
分享令牌（**只读一条**，可限次数 / 带密码）。

**三种带法**：

```http
Authorization: Bearer <凭据>      # 首选
?auth=<凭据>                      # 带不了头时（<img src> 这类）
Sec-WebSocket-Protocol: <凭据>    # WebSocket 专用
```

⚠️★ **WebSocket 上别用 `?auth=`** —— 查询串会进服务端日志和浏览器历史。浏览器上只能用
`Sec-WebSocket-Protocol`，它是唯一不进 URL 的。

⚠️ 一个凭据可带**多个**房间密码：主凭据走上面之一，其余走 `X-Room-Auth-Tokens`（JSON 数组或逗号分隔）。

---

## 3. 错误

```json
{ "code": "room_forbidden", "error": "Room forbidden", "message": "无权访问该房间" }
```

`code` 给程序，`message` 给人（**中文**，界面直接显示）。

⚠️★ **不按 `Accept` 分叉** —— 不管客户端要 HTML 还是 JSON，错误都是这一个形状。
分叉过的话，`<img src>` 会拿到一整页 HTML，那是最难查的一类问题。

常见：`unauthorized` · `room_forbidden` · `room_auth_required` · `file_expired` ·
`invalid_content_id` · `text_too_large` · `file_too_large` · `share_expired` · `share_exhausted`。

---

## 4. 限额

| 限额 | 出处 |
|---|---|
| 文本长度 / 文件大小 | WS 的 **`config` 帧**（`textLimit` / `fileLimit`）—— **不在 `/server` 里** |
| 历史条数 | `GET /server` 的 `historyLimit` |
| 文件过期 | `config` 帧的 `fileExpire`（秒） |

⚠️★ 前两项**只在 WS 的 `config` 帧给**：限额是握手时按房间策略算出来的，而 `/server` 是无状态的。
**拿到 `config` 之前不要猜。**

⚠️ 另有一套**每请求的绝对上限**（防「一次请求把内存吃满」），与上面无关，不受房间策略影响。

---

## 5. `/push` 的帧

OpenAPI 没有原生 WebSocket，帧的契约写在 `/push` 的 `x-websocket-events` 扩展里。

| 帧 | 什么时候 |
|---|---|
| `config` | **连上后第一帧**，带 `latestId`（水位）与上面几个限额 |
| `add` / `revoke` | 来了新内容 / 某条被撤回 |
| `connect` / `disconnect` | 设备上下线 |
| `ping` / `pong` | 应用层心跳（测延迟，也用来判死） |

⚠️★ **`config` 必须排在实时之前**：`latestId` 是「哪些算历史」的边界 ——
`id <= latestId` 只当历史认领（**不写剪贴板**），`id > latestId` 才是实时。
少了它，边界那几条会被处理两次，或者把整段历史灌进剪贴板。

---

## 6. 与 Go / Worker 的差异

| 地方 | Go / 旧文档 | 这一版（Rust） |
|---|---|---|
| `/content` 格式参数 | `?format=` 优先级 1–5 | `?json=1` 兼容保留，`.json` 后缀**已去掉**（→ `400 invalid_content_id`） |
| `/content/latest` 不带 `room` | 「全房间最新」 | 取 **`default` 房间**；跨房间要显式 `?all=1` |
| `/upload` 响应 | `uuid`/`name`/`size`/`expire` | 只有 `{url, id, type}` |
| `/revoke/*` | `DELETE` | **只接受 `POST`**（浏览器误点 `/revoke/5` 不该删东西） |
| `/push` 凭据 | 文档写 `?token=` | `?auth=` / `Authorization` / `Sec-WebSocket-Protocol` |
| `/file/{uuid}` | — | 也接受 `DELETE`；分享令牌**只对 `GET` 有效** |
| `senderDevice` | 与设备事件同键 | 自由字符串表（`type`/`os`/`browser`/`name`） |
| `/tasks/preview` 参考时刻 | — | 回 `referenceAt2`，试跑已存任务时叫 `scheduledAt` |
| `/content/{id}/column` 鉴权错 | — | `room_auth_required`，不是 `room_forbidden` |

⚠️ `/stats/daily` **只有 Rust 与 Worker 有**，Go 版从来没有。

---

## 7. 自己校验

```bash
python3 -m pip install pyyaml openapi-spec-validator jsonschema
python3 docs/openapi/check-openapi.py
```

⚠️★ 真正值钱的是**示例那一半**：校验器只能证明文档格式合法，它照样接受「示例描述的响应服务端
永远不会发」。而示例是会被抄的 —— **示例错了比没有示例更坏**。
