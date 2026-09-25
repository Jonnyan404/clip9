//! `/push` —— WebSocket。
//!
//! 对应 Go `handler.go:170` 的 `handle_push`。
//!
//! # 握手顺序（**顺序就是契约**，别重排）
//!
//! 1. 房间归一化 → 2. 鉴权（失败要在**升级之前**返回 401 JSON，不是先升级再关）→
//! 3. 回选 `Sec-WebSocket-Protocol` → 4. 升级
//!
//! # 连上之后的四条推送，顺序也不能换
//!
//! 1. **房间里已有的设备**（每台一条 `connect`）—— 先给新来的看「这儿还有谁」
//! 2. **广播自己**给房间里的其他人（`connect`，但跳过自己）
//! 3. **历史消息**（`receive`，旧的在前）—— 客户端是一条条 append 的
//! 4. **`config`** —— ⚠️★ 前端的 `app.config` **只认这一条**，不是 `/server` 的 HTTP 响应。
//!    往 `app.config` 上加字段（能力开关、`prefix`）**必须改这里**，只改 `/server`
//!    会得到一个永远 `undefined` 的字段。Go 侧踩过两次（`automation.enabled`、
//!    `prefix`），症状都是「功能整个消失」而不是「偶尔不显示」。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use clip9_core::resolve_room_auth;
use clip9_protocol::normalize_room_name;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::error::{codes, write_error};
use crate::handlers::client_ip;
use crate::state::AppState;
use crate::user_agent::parse_device_meta;

/// 设备名用的查询参数与长度上限（Go `utils.go:404`）。
const DEVICE_NAME_PARAM: &str = "name";
const DEVICE_NAME_MAX_LEN: usize = 32;

/// 服务端主动发 ping 的间隔。
///
/// ⚠️ 不能省：中间有反代（nginx / Cloudflare）时，空闲连接会被**静默掐掉**，
/// 而两端都不知道 —— 表现是「过一会儿就收不到推送了，刷新一下又好了」。
const PING_INTERVAL: Duration = Duration::from_secs(5);

type WsSender = SplitSink<WebSocket, Message>;

/// `GET /push`。
pub async fn push(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let auth_needed = resolve_room_auth(&state.config, &room).required;

    if auth_needed {
        let token = extract_ws_token(&headers, &query);
        if token.is_empty() {
            return write_error(
                StatusCode::UNAUTHORIZED,
                codes::UNAUTHORIZED_MISSING_TOKEN,
                "Missing auth token",
                "Unauthorized: Missing token",
            );
        }
        if !state.can_access_room(&room, &token) {
            return write_error(
                StatusCode::UNAUTHORIZED,
                codes::UNAUTHORIZED_INVALID_TOKEN,
                "Invalid auth token",
                "Unauthorized: Invalid token",
            );
        }
    }

    // ⚠️★ **必须回选一个子协议**：浏览器发了 `Sec-WebSocket-Protocol` 时，
    // 服务端不回选会让**握手直接失败**（浏览器按规范判定为不匹配）。
    // 客户端用它传凭据，正是为了不让 token 进 URL、进而进访问日志。
    let requested_protocol = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let ip = client_ip(&headers, Some(peer));
    let remote = peer.to_string();
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let device_name = sanitize_device_name(
        query
            .get(DEVICE_NAME_PARAM)
            .map(String::as_str)
            .unwrap_or(""),
    );

    let upgrade = match requested_protocol {
        Some(p) => ws.protocols([p]),
        None => ws,
    };

    upgrade.on_upgrade(move |socket| {
        handle_socket(
            state,
            socket,
            room,
            ClientInfo {
                ip,
                remote,
                user_agent,
                device_name,
            },
            auth_needed,
        )
    })
}

/// 提取 WS 握手用的凭据。
///
/// 顺序：`Authorization` / `?auth=`（兼容老客户端）→ `Sec-WebSocket-Protocol` 子协议。
/// ⚠️ 后者是**首选**（凭据不进 URL、不进访问日志），但它排在最后是因为
/// 老的浏览器客户端还在用前两者。
#[must_use]
fn extract_ws_token(headers: &HeaderMap, query: &HashMap<String, String>) -> String {
    let basic = crate::handlers::extract_auth_token(headers, query.get("auth").map(String::as_str));
    if !basic.is_empty() {
        return basic;
    }
    headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .unwrap_or("")
        .to_owned()
}

/// 清洗客户端声明的设备名：剔控制字符、去空白、按**字符**截断。
///
/// ⚠️ 按 rune 截断而不是按字节 —— 按字节会把多字节字符切成半个，前端显示成乱码。
/// 控制字符必须剔：它会污染服务端日志，也可能在前端渲染出意料之外的效果。
pub(crate) fn sanitize_device_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        // 和 Go 一致：只剔 C0 与 DEL（不用 `char::is_control()` —— 那会连 C1 一起剔，
        // 和 Go 的输出就不一样了）。
        .filter(|c| {
            let cp = *c as u32;
            cp >= 0x20 && cp != 0x7f
        })
        .collect();
    let mut chars: Vec<char> = cleaned.trim().chars().collect();
    if chars.len() > DEVICE_NAME_MAX_LEN {
        chars.truncate(DEVICE_NAME_MAX_LEN);
    }
    chars.into_iter().collect::<String>().trim().to_owned()
}

/// 「谁连上来了」。
///
/// ⚠️ 绑成一个类型，而不是散着传四个字符串：`ip` / `remote` / `user_agent` / `device_name`
/// **全是 `String`**，按位置传太容易搞反，而且**搞反了不报错** —— 只是设备名显示错、
/// 或者设备 ID 按错的输入算出来。名字比位置可靠。
struct ClientInfo {
    /// 客户端 IP（`X-Forwarded-For` → `X-Real-IP` → 对端地址）。
    ip: String,
    /// 对端 `addr:port`。设备 ID 的哈希输入之一。
    remote: String,
    user_agent: String,
    /// 客户端用 `?name=` 声明的设备名（已清洗）。
    device_name: String,
}

async fn handle_socket(
    state: Arc<AppState>,
    socket: WebSocket,
    room: String,
    client: ClientInfo,
    auth_needed: bool,
) {
    let conn_id = state.next_conn_id();
    let device_id = state.device_id_for(&client.remote, &client.user_agent);
    let meta = parse_device_meta(&client.user_agent, &client.device_name, &device_id);
    state.register_device(&room, conn_id, &meta);
    tracing::info!(ip = %client.ip, %room, device_id, "WS 连上");

    // ⚠️ 先订阅、再发历史。反过来的话，「订阅之前」发生的那几条会漏 ——
    // 而漏一条 `revoke` 会让客户端一直显示已经删掉的条目。
    // 宁可多收（重复一条，前端按 id 去重）也不能漏。
    let mut rx = state.subscribe();
    let (mut sink, mut stream) = socket.split();

    // ① 房间里已有的设备，每台一条 connect
    for dev in state.devices_in_room_except(&room, &device_id) {
        if send_json(&mut sink, "connect", &dev).await.is_err() {
            return cleanup(&state, &room, conn_id);
        }
    }

    // ② 告诉房间里**其他人**「我来了」（跳过自己 —— 自己的信息前端已经知道了）
    state.broadcast_except("connect", &meta, &room, Some(conn_id));

    // ③ 历史消息，**旧的在前**（客户端是一条条 append 的）
    //
    // ⚠️ 这里就是 ARCHITECTURE §6.2 说的那处契约变更：Go 把**整个房间**推一遍，
    // 1 万条就是 2MB+，手机端直接崩。现在按 `server.history` 截断。
    // 旧客户端的行为退化成「只能看到最近 N 条」，但不报错。
    let limit = if state.config.server.history > 0 {
        state.config.server.history as usize
    } else {
        usize::MAX
    };
    for entry in state.store.recent_asc(&room, limit).unwrap_or_default() {
        if send_json(&mut sink, "receive", &entry).await.is_err() {
            return cleanup(&state, &room, conn_id);
        }
    }

    // ④ config —— ⚠️★ 前端的 app.config 只认这一条，见文件头注释
    let config_payload = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "server": {
            "history": state.config.server.history,
            "prefix": state.config.server.prefix,
            "roomList": state.config.server.room_list,
        },
        "text": { "limit": state.config.text.limit },
        "file": {
            "expire": state.config.file.expire,
            "chunk": state.config.file.chunk,
            "limit": state.config.file.limit,
        },
        "auth": auth_needed,
        // 定时自动化的能力声明。前端 `PageToolbar` 的入口图标只认这里的 `enabled`
        // （`app.config` 来自握手这条 `config` 事件，不是 `/server` 的 HTTP 响应）。
        // Worker 部署没有这一族接口，所以它必须是个**明确的下发字段**，不能靠「有没有」推断。
        "automation": { "enabled": state.config.automation.enabled },
    });
    if send_json(&mut sink, "config", &config_payload)
        .await
        .is_err()
    {
        return cleanup(&state, &room, conn_id);
    }

    let mut ticker = tokio::time::interval(PING_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                None => break,
                Some(Err(e)) => {
                    tracing::debug!(error = %e, "WS 读取出错");
                    break;
                }
                Some(Ok(Message::Close(_))) => break,
                Some(Ok(Message::Text(text))) => {
                    // 应用层 ping：客户端发 `{"event":"ping","data":<ms>}`，
                    // 服务端**原样回显** data，客户端用 `Date.now() - data` 算 RTT。
                    if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text)
                        && msg.get("event").and_then(|v| v.as_str()) == Some("ping")
                        && let Some(t) = msg.get("data")
                        && send_json(&mut sink, "pong", t).await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(_)) => {}
            },

            event = rx.recv() => match event {
                Ok(event) => {
                    if event.room != room || event.except == Some(conn_id) {
                        continue;
                    }
                    let payload = json!({ "event": event.event, "data": event.data });
                    if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
                        break;
                    }
                }
                // ⚠️ 落后了说明中间丢过事件。**必须断开让它重连** ——
                // 装作没事继续的话，客户端会缺一条 revoke / update，而它自己不知道。
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!(room, skipped = n, "WS 客户端跟不上广播，断开让它重连");
                    break;
                }
                Err(RecvError::Closed) => break,
            },

            _ = ticker.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    cleanup(&state, &room, conn_id);
}

/// 断开时的清理：注销这条连接，并在**这台设备的最后一条连接**断开时广播 `disconnect`。
///
/// ⚠️ 两个判断都不能省：
/// · 不判「这条连接本来在不在」→ 重复清理会发出多余的 `disconnect`；
/// · 不判「这台设备还有没有别的连接」→ **关掉一个标签页 = 整台设备显示离线**
///   （Go 那边就是这样，这里按最佳实践修掉了）。
fn cleanup(state: &AppState, room: &str, conn_id: u64) {
    if let Some((meta, still_connected)) = state.unregister_device(room, conn_id) {
        if !still_connected {
            state.broadcast("disconnect", &json!({ "id": meta.id }), room);
        }
        tracing::info!(room, device_id = %meta.id, still_connected, "WS 断开");
    }
}

async fn send_json(
    sink: &mut WsSender,
    event: &str,
    data: &impl serde::Serialize,
) -> Result<(), axum::Error> {
    let payload = json!({ "event": event, "data": data });
    sink.send(Message::Text(payload.to_string().into())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn token_prefers_authorization_then_falls_back_to_subprotocol() {
        let q = HashMap::new();
        assert_eq!(
            extract_ws_token(&headers(&[("authorization", "Bearer t")]), &q),
            "t"
        );
        // ⚠️ 子协议是最**安全**的那条（凭据不进 URL），但排在最后是为了兼容老客户端。
        assert_eq!(
            extract_ws_token(&headers(&[("sec-websocket-protocol", "tok, other")]), &q),
            "tok",
            "多个子协议时只取第一个"
        );
        assert_eq!(extract_ws_token(&HeaderMap::new(), &q), "");
    }

    #[test]
    fn device_name_strips_control_chars_and_truncates_by_chars() {
        // 控制字符会污染日志，也会在前端渲染出意外效果。
        assert_eq!(sanitize_device_name("a\u{0}b\u{1}c"), "abc");
        assert_eq!(sanitize_device_name("  客厅的 Mac  "), "客厅的 Mac");

        // ⚠️ 按**字符**截断：按字节会把「岚」切成半个，前端显示成乱码。
        let long = "岚".repeat(40);
        let got = sanitize_device_name(&long);
        assert_eq!(got.chars().count(), DEVICE_NAME_MAX_LEN);
        assert!(got.is_char_boundary(got.len()));
    }

    #[test]
    fn device_name_at_the_limit_is_untouched() {
        let exact = "x".repeat(DEVICE_NAME_MAX_LEN);
        assert_eq!(sanitize_device_name(&exact), exact);
    }
}
