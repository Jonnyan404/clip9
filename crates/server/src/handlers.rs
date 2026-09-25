//! HTTP 处理器。
//!
//! 对应 Go `handler.go` 里的各个 `handle_*`。**形状逐字对齐** ——
//! 每条响应的字段名、错误码、状态码都不是「大致这样」，而是照着 Go 抄的，
//! 并且用「起两个真实实例并排比对」验过（见 `docs/HANDOVER.md` §4）。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use clip9_core::{Config, can_access_room, resolve_room_auth};
use clip9_protocol::{
    FileReceive, ReceiveHolder, RoomInfo, RoomListResponse, TextReceive, normalize_room_name,
};
use serde_json::json;

use crate::error::{codes, shortcuts, write_error};
use crate::state::{AppState, now_secs};
use crate::text_body::read_text_body;
use crate::user_agent::parse_user_agent;

/// 看板固定三列。**不做用户自建** —— 这是最小实现，见 `content_column`。
const BOARD_COLUMNS: [&str; 3] = ["todo", "doing", "done"];

// ── 请求元信息 ────────────────────────────────────────────────────────

/// 取凭据：`Authorization` 头优先，回落到 `?auth=`。
///
/// ⚠️ 和 Go `auth.go:117` 一致的两处细节，别「顺手优化」：
/// 1. 用 `split(' ')` 而不是 `splitn(2)` —— `"Bearer a b"` 会被当成**三个**部分，
///    于是整个头原样当凭据。换成 splitn 会变成凭据 `"a b"`，和 Go 分叉。
/// 2. 头存在但**不是** `Bearer` 格式时，整个头原样当凭据（不是返回空）——
///    那是给「直接把密码塞进 Authorization」的客户端留的路。
#[must_use]
pub fn extract_auth_token(headers: &HeaderMap, query_auth: Option<&str>) -> String {
    if let Some(raw) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        && !raw.is_empty()
    {
        let parts: Vec<&str> = raw.split(' ').collect();
        if parts.len() == 2 && parts[0].eq_ignore_ascii_case("bearer") {
            return parts[1].to_owned();
        }
        return raw.to_owned();
    }

    query_auth.unwrap_or_default().to_owned()
}

/// 取**多个**凭据：主凭据 + `X-Room-Auth-Tokens`（JSON 数组或逗号分隔）。
///
/// `/rooms` 用它来判断「哪些房间对**这个**客户端可见」。去重、去空白、保序。
#[must_use]
pub fn extract_auth_tokens(headers: &HeaderMap, query_auth: Option<&str>) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut push = |token: &str| {
        let t = token.trim();
        if !t.is_empty() && !tokens.iter().any(|e| e == t) {
            tokens.push(t.to_owned());
        }
    };

    push(&extract_auth_token(headers, query_auth));

    let extra = headers
        .get("x-room-auth-tokens")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if extra.is_empty() {
        return tokens;
    }

    match serde_json::from_str::<Vec<String>>(extra) {
        Ok(parsed) => parsed.iter().for_each(|t| push(t)),
        Err(_) => extra.split(',').for_each(&mut push),
    }
    tokens
}

/// 客户端 IP：`X-Forwarded-For` → `X-Real-IP` → 连接对端地址。取第一个逗号前那段。
#[must_use]
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    let raw = headers
        .get("x-forwarded-for")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| peer.map(|p| p.ip().to_string()).unwrap_or_default());

    raw.split(',').next().unwrap_or("").trim().to_owned()
}

#[must_use]
fn scheme(headers: &HeaderMap) -> &'static str {
    match headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.eq_ignore_ascii_case("https") => "https",
        _ => "http",
    }
}

#[must_use]
fn host(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned()
}

/// 内容 URL：`<scheme>://<host><prefix>/content/<id>`，非 default 房间再挂 `?room=`。
#[must_use]
pub fn content_url(headers: &HeaderMap, config: &Config, id: i32, room: &str) -> String {
    let mut url = format!(
        "{}://{}{}/content/{id}",
        scheme(headers),
        host(headers),
        config.server.prefix
    );
    if room != "default" {
        url.push_str(&format!("?room={room}"));
    }
    url
}

/// 组装「谁发的」三件套：IP、设备信息、客户端 ID。
///
/// ⚠️ 三处细节都和 Go `broadcast.go:110` 对齐，缺一个都会让前端显示不对：
///
/// - **设备名来自 `?name=`**（清洗过）。它会进 `senderDevice.name`，而前端的 deviceLabel
///   取值顺序是 `name → os → type` —— 缺了它，气泡上就只有「Chrome 120」这种通用名。
/// - **客户端 ID 来自 `?client=`**，用于**气泡收发归属**（判断哪条是我自己发的）。
/// - ⚠️ **没有 UA 的来源（定时任务）不能去解析 UA**：那会得到 `"os": " "` / `"browser": " "`
///   这种带空格的脏值，而前端取值顺序是 name → os → type，于是消息会被显示成一个空格。
///   Go 那边特判成 `{name, type: "Automation"}`。
#[must_use]
pub fn sender_base(
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    query: &HashMap<String, String>,
) -> (String, HashMap<String, String>, String) {
    let ip = client_ip(headers, peer);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let device_name =
        crate::ws::sanitize_device_name(query.get("name").map(String::as_str).unwrap_or(""));

    let device = if ua.trim().is_empty() {
        HashMap::from([
            ("name".to_owned(), device_name),
            ("type".to_owned(), "Automation".to_owned()),
        ])
    } else {
        parse_user_agent(ua, &device_name)
    };

    let client_id = query
        .get("client")
        .map(|s| s.trim().to_owned())
        .unwrap_or_default();

    (ip, device, client_id)
}

/// 带尾随换行的 JSON 响应 —— 和 Go 的 `json.NewEncoder(w).Encode(...)` 对齐，
/// 这样两边的响应可以**逐字节比对**。
#[must_use]
pub fn json_response(value: &serde_json::Value) -> Response {
    let mut body = serde_json::to_string(value).unwrap_or_default();
    body.push('\n');
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// 纯文本响应（文本内容那条路）。
#[must_use]
pub fn text_response(body: String) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

// ── 内容格式 ──────────────────────────────────────────────────────────

/// 读**显式**的格式信号：`?format=` > `.json` 后缀 > `?json=1`。
///
/// ⚠️ 兼容信号（`.json` 后缀、`?json=1`）**即将下线**：新客户端一律用 `?format=json`，
/// 捷径侧已经改完。但**现在还不能删** —— 用户手机上装好的老捷径走的就是后缀那条路。
///
/// 返回 `Err(())` 表示给了个不认识的 format（比如 `?format=html`）：**必须报错、不能回落**，
/// 否则客户端以为拿到 HTML、实际拿到原文。
fn resolve_content_format(
    query: &HashMap<String, String>,
    has_json_suffix: bool,
) -> Result<String, ()> {
    if let Some(explicit) = query.get("format") {
        match explicit.trim().to_ascii_lowercase().as_str() {
            "" => {}
            "json" => return Ok("json".to_owned()),
            "raw" | "text" | "plain" => return Ok("raw".to_owned()),
            _ => return Err(()),
        }
    }
    if has_json_suffix {
        return Ok("json".to_owned());
    }
    if matches!(query.get("json").map(String::as_str), Some("true" | "1")) {
        return Ok("json".to_owned());
    }
    Ok(String::new())
}

/// **文本**响应给不给 JSON：显式格式优先，没显式时才看 `Accept` 头。
///
/// ⚠️ **文件分支不走这里**。下载链路上的 `Accept` 头太不可靠（浏览器、下载器、脚本五花八门），
/// 所以文件分支历来只认显式信号 —— 别为了「统一」合并掉：合并的后果是
/// 「浏览器直接点开文件链接」会突然收到一坨 JSON。
#[must_use]
fn wants_json(explicit_format: &str, headers: &HeaderMap) -> bool {
    match explicit_format {
        "json" => true,
        "raw" => false,
        _ => headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|a| a.contains("application/json")),
    }
}

/// 按文件名猜响应类型（前端据此选图标/播放器）。
///
/// 对应 Go `utils.go:199` 的 `DetermineResponseType`。
#[must_use]
pub fn determine_response_type(filename: &str) -> &'static str {
    let mime = mime_guess::from_path(filename).first_raw().unwrap_or("");
    if mime.is_empty() {
        return "file";
    }
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("application/pdf") {
        "document"
    } else if mime.starts_with("application/zip")
        || mime.contains("x-rar-compressed")
        || mime.starts_with("application/x-tar")
        || mime.contains("x-7z-compressed")
        || mime.starts_with("application/gzip")
    {
        "archive"
    } else if mime.contains("word")
        || mime.contains("excel")
        || mime.contains("powerpoint")
        || mime.contains("opendocument.text")
        || mime.contains("opendocument.spreadsheet")
        || mime.contains("opendocument.presentation")
    {
        "document"
    } else {
        "file"
    }
}

/// 校验看板列名。空串归一成 `todo`（新条目默认落在待办）。
fn normalize_board_column(raw: &str) -> Option<&'static str> {
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Some("todo");
    }
    BOARD_COLUMNS.iter().copied().find(|c| *c == value)
}

/// 过期检查：**必须在返回之前**。
///
/// ⚠️ 漏了它的后果很具体：客户端会拿着一条已过期的记录去下载，拿到 404 的错误文本，
/// 然后**存成一个顶着原文件名的假文件**。
fn file_expired(f: &FileReceive) -> bool {
    f.expire > 0 && f.expire < now_secs()
}

// ── /server ───────────────────────────────────────────────────────────

/// `GET /server` —— 服务端能力与配置声明。形状逐字对齐 Go `handler.go:120`。
///
/// ⚠️ 三条容易写错、且写错了不会报错的语义：
/// 1. `auth`（要不要密码）与 `roomProtected`（这个房间要不要密码）**不是一个东西**：
///    只有带了 `?room=` 才会去算 `roomProtected`，否则它恒为 `false`。
/// 2. `authorized` 的初值是 `true` —— 「没传 room 且没有全局密码」时它**就是 true**，
///    哪怕一个凭据都没带。别顺手改成 `false`，那会让所有开放部署的 SPA 认为未授权。
/// 3. 没带 `?room=` 时，`auth` 只看**全局**密码。
pub async fn server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let config = &state.config;
    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));

    let mut auth_needed = false;
    let mut authorized = true;
    let mut room_protected = false;
    let global_password = config.server.auth.normalize();

    // ⚠️ 判「有没有传 room」用 **key 在不在**，不是「值是不是空」：
    // `?room=` 是「default 房间」，完全不传才是「不限房间」。
    if query.contains_key("room") {
        let room = query.get("room").cloned().unwrap_or_default();
        let requirement = resolve_room_auth(config, &room);
        auth_needed = requirement.required;
        authorized = can_access_room(config, &room, &token);
        room_protected = requirement.required;
    } else if !global_password.is_empty() {
        auth_needed = true;
        authorized = can_access_room(config, "default", &token);
    }

    let ws_scheme = if scheme(&headers) == "https" {
        "wss"
    } else {
        "ws"
    };

    Json(json!({
        "server": format!("{ws_scheme}://{}{}/push", host(&headers), config.server.prefix),
        "auth": auth_needed,
        "authorized": authorized,
        "roomProtected": room_protected,
        "config": {
            "server": {
                "history": config.server.history,
                "roomList": config.server.room_list,
            }
        },
        // 定时自动化的能力声明。前端据此决定要不要渲染自动化面板 ——
        // 唯一来源是这里，前端不要自己判断「这个房间有没有密码」（会和服务端策略漂开）。
        //
        // P0 还没实现自动化，所以只回 `{"enabled": false}`（和 Go 那边关掉时一模一样）。
        // ⚠️ 真正要下发时，这份能力**还必须同时进 WS 握手载荷** ——
        // 前端的 `app.config` 来自握手那条 `config` 事件，不是这个 HTTP 响应。
        // 只加在这里会得到一个永远 `undefined` 的字段（Go 侧踩过这个坑）。
        "automation": { "enabled": false },
    }))
}

// ── 方法不对时的统一响应 ──────────────────────────────────────────────
//
// ⚠️ 每个**限定了方法**的端点都要把它挂成 `MethodRouter::fallback`。
// 原因是 axum 内置的 405 是**空 body**，而契约里写着「错误响应恒 `{code,error,message}`」——
// Apple 快捷指令读不到 `error` 字段就只会走进兜底分支。
//
// ⚠️ 文案**按方法分三种**（Go 就是这么分的，别合并成一个）：
// 「仅允许 GET 请求」/「仅允许 POST 请求」/「方法不允许」（`/file/` 那条的 default 分支）。

/// 405：这个端点只允许 GET。
pub async fn only_get() -> Response {
    write_error(
        StatusCode::METHOD_NOT_ALLOWED,
        codes::METHOD_NOT_ALLOWED,
        "Only GET is allowed",
        "仅允许 GET 请求",
    )
}

/// 405：这个端点只允许 POST。
pub async fn only_post() -> Response {
    write_error(
        StatusCode::METHOD_NOT_ALLOWED,
        codes::METHOD_NOT_ALLOWED,
        "Only POST is allowed",
        "仅允许 POST 请求",
    )
}

/// 405：没说限定哪些方法（`/file/` 那条走的是 Go 的 `default` 分支）。
pub async fn method_not_allowed() -> Response {
    write_error(
        StatusCode::METHOD_NOT_ALLOWED,
        codes::METHOD_NOT_ALLOWED,
        "Method not allowed",
        "方法不允许",
    )
}

// ── POST /text ────────────────────────────────────────────────────────

pub async fn text(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let config = &state.config;
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let text = match read_text_body(content_type, body).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "解析 /text 请求体失败");
            return write_error(
                StatusCode::BAD_REQUEST,
                codes::INVALID_BODY,
                "Cannot parse request body",
                "请求体无法解析",
            );
        }
    };

    // ⚠️ 上限比的是**字节数**，不是字符数 —— Go 用 `len(text)`。
    // 所以一条 2000 字的中文（6000 字节）会被 4096 的上限拒掉。这是既有行为。
    if config.text.limit > 0 && text.len() as i64 > config.text.limit {
        return write_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            codes::TEXT_TOO_LONG,
            "Text too long",
            &format!("文本内容超出限制 (最大 {} 字符)", config.text.limit),
        );
    }

    // ⚠️ 用共享的 `sender_base`：设备名（`?name=`）和客户端 ID（`?client=`）都要带上 ——
    // 少了前者，气泡上只有「Chrome 120」这种通用名；少了后者，分不出哪条是自己发的。
    let (ip, device, client_id) = sender_base(&headers, Some(peer), &query);

    // 带 ?id= 是「覆盖已有条目」（前端改正文走这条）。
    if let Some(raw_id) = query.get("id").filter(|v| !v.is_empty()) {
        let Ok(id) = raw_id.parse::<i32>() else {
            return write_error(
                StatusCode::BAD_REQUEST,
                codes::INVALID_ID,
                "Invalid id parameter",
                "无效的 ID 参数",
            );
        };
        return match update_text(&state, id, &text, &room, &ip, &device) {
            Some(true) => json_response(&json!({
                "url": content_url(&headers, config, id, &room),
                "id": raw_id,
                "type": "text",
            })),
            // 内容没变 → Go 也返回成功（避免无意义的写盘），所以这里是 `Some(true)` 走上面。
            Some(false) | None => write_error(
                StatusCode::NOT_FOUND,
                codes::MESSAGE_NOT_UPDATABLE,
                "Message not found or not updatable",
                "消息未找到或无法更新",
            ),
        };
    }

    let mut entry = ReceiveHolder::Text(TextReceive {
        base: clip9_protocol::ReceiveBase {
            kind: "text".to_owned(),
            room: room.clone(),
            timestamp: now_secs(),
            sender_ip: ip,
            sender_device: Some(device),
            sender_client_id: client_id,
            ..clip9_protocol::ReceiveBase::default()
        },
        content: text,
        ..TextReceive::default()
    });

    let inserted = match state.store.insert(entry.clone()) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!(error = %e, "写入消息失败");
            return write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_failed",
                "Failed to store message",
                "保存消息失败",
            );
        }
    };
    entry = inserted;
    let id = entry.id();

    state.broadcast("receive", &entry, &room);

    json_response(&json!({
        "url": content_url(&headers, config, id, &room),
        "id": id.to_string(),
        "type": "text",
    }))
}

/// 覆盖一条文本条目。`None` = 没找到 / 不可更新；`Some(_)` = 成功（内容没变也算成功）。
///
/// ⚠️ 房间必须**同时**匹配：`?id=` 指的是「这个房间里的这条」，
/// 不然拿着 id 就能改别的房间的条目。
fn update_text(
    state: &AppState,
    id: i32,
    new_content: &str,
    room: &str,
    ip: &str,
    device: &HashMap<String, String>,
) -> Option<bool> {
    let found = state.store.get(id).ok().flatten()?;
    if found.kind() != "text" || normalize_room_name(found.room()) != room {
        return None;
    }

    let mut updated = found.clone();
    let ReceiveHolder::Text(t) = &mut updated else {
        return None;
    };
    // 内容没变 → 直接成功返回，**不写盘**（Go 也这么做，避免频繁触发写入）。
    if t.content == new_content {
        return Some(true);
    }
    t.content = new_content.to_owned();
    // ⚠️ 改正文**要**刷时间戳（这条消息是新内容了），和看板挪列相反。
    t.base.timestamp = now_secs();
    t.base.sender_ip = ip.to_owned();
    t.base.sender_device = Some(device.clone());

    match state.store.replace(&updated) {
        Ok(true) => {
            state.broadcast("update", &updated, room);
            Some(true)
        }
        Ok(false) => None,
        Err(e) => {
            tracing::error!(error = %e, "更新消息失败");
            None
        }
    }
}

// ── /content/* ────────────────────────────────────────────────────────

pub async fn content(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let has_json_suffix = raw_id.ends_with(".json");
    let id_str = raw_id.trim_end_matches(".json");
    // ⚠️ 后缀无论格式如何都要剥掉：`/content/999.json` 的 id 就是 999，
    // 哪怕调用方用 `?format=raw` 显式要原文。
    let Ok(id) = id_str.parse::<i32>() else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::INVALID_CONTENT_ID,
            "Invalid content id",
            "无效的内容 ID",
        );
    };
    let Ok(explicit_format) = resolve_content_format(&query, has_json_suffix) else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::UNSUPPORTED_FORMAT,
            "Unsupported format",
            "不支持的格式（只支持 raw / json）",
        );
    };
    // 文件分支只看显式信号；文本分支还会看 Accept。
    let is_json_request = explicit_format == "json";

    let has_requested_room = query.contains_key("room");
    let requested_room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));

    let Some(entry) = state.store.get(id).ok().flatten() else {
        return shortcuts::content_not_found();
    };
    let message_room = normalize_room_name(entry.room());
    if has_requested_room && message_room != requested_room {
        return shortcuts::content_not_found();
    }
    // ⚠️ 鉴权按**条目自己记录的房间**，不信客户端传的 `?room=`。
    if !can_access_room(&state.config, &message_room, &token) {
        return shortcuts::room_forbidden();
    }

    match &entry {
        ReceiveHolder::File(f) => {
            if file_expired(f) {
                return write_error(
                    StatusCode::NOT_FOUND,
                    codes::FILE_EXPIRED,
                    "File expired",
                    "文件已过期",
                );
            }
            if is_json_request {
                return json_response(&json!({
                    "type": determine_response_type(&f.name),
                    "name": f.name,
                    "size": f.size,
                    "uuid": f.cache,
                    "url": f.url,
                    "id": id.to_string(),
                    "timestamp": f.base.timestamp,
                    "expire": f.expire,
                    // 空串 = 待办（看板列，见 content_column）
                    "column": f.base.column,
                }));
            }
            // P0 还没实现文件本体（`/upload` 那三件套）。这里按「磁盘上没有」报，
            // 和 Go 在文件被清理掉时的行为一致。
            write_error(
                StatusCode::NOT_FOUND,
                codes::FILE_EXPIRED,
                "File expired or cleaned up",
                "文件已过期或已被清理",
            )
        }
        ReceiveHolder::Text(t) => {
            if wants_json(&explicit_format, &headers) {
                return json_response(&json!({
                    "type": "text",
                    "content": t.content,
                    "id": id.to_string(),
                    "timestamp": t.base.timestamp,
                    "column": t.base.column,
                }));
            }
            // 默认返回纯文本，且**保证以换行结尾**（`curl` 出来的东西不会和提示符粘一行）。
            let mut body = t.content.clone();
            if !body.ends_with('\n') {
                body.push('\n');
            }
            text_response(body)
        }
    }
}

/// `GET /content/latest`（含 `latest.json`）。
pub async fn latest_content(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(explicit_format) = resolve_content_format(&query, false) else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::UNSUPPORTED_FORMAT,
            "Unsupported format",
            "不支持的格式（只支持 raw / json）",
        );
    };
    let is_json_request = explicit_format == "json";
    let has_requested_room = query.contains_key("room");
    let requested_room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));

    // ⚠️ 房间参数**不传**时是「不限房间」—— 要从所有房间里挑最新的那条，
    // 而不是只看 default。这就是它不能直接用 `store.latest(room)` 的原因。
    let candidates: Vec<ReceiveHolder> = if has_requested_room {
        state
            .store
            .recent_desc(&requested_room, 1)
            .unwrap_or_default()
    } else {
        // 跨房间取最新：每个房间各取一条再比。房间数不多，这样比全表扫便宜得多。
        let mut all = Vec::new();
        for room in state.store.rooms().unwrap_or_default() {
            if let Ok(Some(e)) = state.store.latest(&room.name) {
                all.push(e);
            }
        }
        all.sort_by(|a, b| b.timestamp().cmp(&a.timestamp()).then(b.id().cmp(&a.id())));
        all.into_iter().take(1).collect()
    };

    let Some(entry) = candidates.into_iter().next() else {
        return write_error(
            StatusCode::NOT_FOUND,
            codes::NO_CONTENT,
            "No content available",
            "没有可用的内容",
        );
    };

    let message_room = normalize_room_name(entry.room());
    if has_requested_room && message_room != requested_room {
        return shortcuts::content_not_found();
    }
    // ⚠️ latest **不支持分享 token**（没有稳定的资源 id），只认房间密码。
    if !can_access_room(&state.config, &message_room, &token) {
        return shortcuts::room_forbidden();
    }

    let id = entry.id();
    match &entry {
        ReceiveHolder::File(f) => {
            if file_expired(f) {
                return write_error(
                    StatusCode::NOT_FOUND,
                    codes::FILE_EXPIRED,
                    "File expired",
                    "文件已过期",
                );
            }
            if is_json_request {
                return json_response(&json!({
                    "type": determine_response_type(&f.name),
                    "name": f.name,
                    "size": f.size,
                    "uuid": f.cache,
                    // ⚠️ 这里**手工拼**而不是用 filepath.Join 那类工具：
                    // 它们会把 `http://host` 的双斜杠收成 `http:/host`，客户端拿到的 url 直接是坏的。
                    "url": format!("{}/{}", f.url, url_escape(&f.name)),
                    "id": id.to_string(),
                    "timestamp": f.base.timestamp,
                    "expire": f.expire,
                    "column": f.base.column,
                }));
            }
            write_error(
                StatusCode::NOT_FOUND,
                codes::FILE_EXPIRED,
                "File missing on disk",
                "文件在磁盘上未找到",
            )
        }
        ReceiveHolder::Text(t) => {
            // ⚠️★ 三条分支的顺序**就是契约**，别重排：
            //   1. 显式 `?format=json` → **扁平对象** `{type, content, id, timestamp, column}`
            //   2. 只带 `Accept: application/json` → **PostEvent 信封** `{event, data}`
            //   3. 其余 → 纯文本
            // 1 和 2 是**两种不同的 JSON 形状**。这是 Go 的既有行为（显式那条走
            // `isJSONRequest`，Accept 那条走 `wantsJSON` 然后 `Encode(msg)`），照抄 ——
            // 「统一」它们会让只发 Accept 头的客户端突然收到不同形状。
            if is_json_request {
                return json_response(&json!({
                    "type": "text",
                    "content": t.content,
                    "id": id.to_string(),
                    "timestamp": t.base.timestamp,
                    "column": t.base.column,
                }));
            }
            if wants_json(&explicit_format, &headers) {
                // ⚠️ `event` 用的是**条目自己的类型**（`text` / `file`），不是 `receive`。
                // Go 那边存的是 `PostEvent{Event: "text", ...}`，所以信封里就是 `"event":"text"`。
                return json_response(&json!({
                    "event": entry.kind(),
                    "data": entry,
                }));
            }
            let mut body = t.content.clone();
            if !body.ends_with('\n') {
                body.push('\n');
            }
            text_response(body)
        }
    }
}

/// 把文件名转义成 URL 路径安全的形式（Go 用 `url.PathEscape`）。
fn url_escape(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for b in name.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `POST /content/<id>/column` —— 看板把卡片挪到另一列。
///
/// ⚠️ **故意不动 `timestamp`**。`update_text` 改正文时会把时间戳刷成现在，
/// 但「把卡片挪到另一列」不该让它在时间流里跳到最前面 —— 挪个位置就重排整个列表太突然。
pub async fn content_column(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let Ok(id) = raw_id.trim_end_matches(".json").parse::<i32>() else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::INVALID_CONTENT_ID,
            "Invalid content id",
            "无效的内容 ID",
        );
    };

    #[derive(serde::Deserialize)]
    struct Body {
        #[serde(default)]
        column: String,
    }
    let Ok(parsed) = serde_json::from_slice::<Body>(&body) else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::INVALID_BODY,
            "Invalid JSON body",
            "请求体不是合法的 JSON",
        );
    };
    let Some(column) = normalize_board_column(&parsed.column) else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::INVALID_COLUMN,
            "Unknown board column",
            "未知的看板列（只支持 todo / doing / done）",
        );
    };

    let has_requested_room = query.contains_key("room");
    let requested_room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));

    let Some(mut entry) = state.store.get(id).ok().flatten() else {
        return shortcuts::content_not_found();
    };
    let message_room = normalize_room_name(entry.room());
    if has_requested_room && message_room != requested_room {
        return shortcuts::content_not_found();
    }
    // ⚠️ 这里的错误码是 `room_auth_required`，**和 `content` 的 `room_forbidden` 不一样**。
    // 别「统一」它们 —— 前端可能按 code 分支。
    if !can_access_room(&state.config, &message_room, &token) {
        return write_error(
            StatusCode::UNAUTHORIZED,
            codes::ROOM_AUTH_REQUIRED,
            "Room authentication required",
            "无权访问该房间",
        );
    }

    let kind = entry.kind().to_owned();
    entry.set_column(column);
    if let Err(e) = state.store.replace(&entry) {
        tracing::error!(error = %e, "挪列失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_failed",
            "Failed to store message",
            "保存消息失败",
        );
    }
    state.broadcast("update", &entry, &message_room);

    json_response(&json!({
        "id": id.to_string(),
        "type": kind,
        "column": column,
    }))
}

// ── /rooms ────────────────────────────────────────────────────────────

/// `GET /rooms` —— 房间列表。
///
/// ⚠️ **返回的数组顺序不是契约的一部分。** Go 那边是 `for room := range map`，
/// 顺序**本来就是随机的** —— 所以任何客户端都不能依赖它。这边按「最近活跃」排，
/// 是**确定的**（比随机好），但不该有人据此写断言。
pub async fn rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !state.config.server.room_list {
        return write_error(
            StatusCode::FORBIDDEN,
            codes::ROOM_LIST_DISABLED,
            "Room list disabled",
            "房间列表功能未启用",
        );
    }

    let tokens = extract_auth_tokens(&headers, query.get("auth").map(String::as_str));

    // 房间来源：有消息的 ∪ 有连接的。Go 那边还有一份 roomStats，这边由存储的
    // `rooms` 计数表覆盖（它在计数减到 0 时也保留那一行）。
    //
    // ⚠️ 计数表只读**一次**：原来写在循环里，每个房间都重查一遍全表 ——
    // 房间一多就是 O(房间数²)，而 `/rooms` 是前端切房间时的高频调用。
    let summaries = state.store.rooms().unwrap_or_default();
    let connected = state.connected_rooms();

    let mut names: Vec<String> = summaries.iter().map(|r| r.name.clone()).collect();
    for room in connected {
        if !names.contains(&room) {
            names.push(room);
        }
    }

    let mut list = Vec::new();
    for room in names {
        // ⚠️ 打不开的房间**整个不列出来**（不是标个锁）。Go 就是这么做的。
        let accessible = can_access_room(&state.config, &room, "")
            || tokens
                .iter()
                .any(|t| can_access_room(&state.config, &room, t));
        if !accessible {
            continue;
        }

        let device_count = state.device_count(&room);
        let summary = summaries.iter().find(|r| r.name == room);
        let message_count = summary.map_or(0, |r| r.message_count as i64);
        let mut last_active = summary.map_or(0, |r| r.last_active);
        if device_count > 0 {
            last_active = now_secs();
        }

        list.push(RoomInfo {
            // ⚠️ 显示时 `default` 要变成**空串** —— 前端把空串当默认房间。
            name: if room == "default" {
                String::new()
            } else {
                room.clone()
            },
            message_count,
            device_count: device_count as i64,
            last_active,
            is_active: device_count > 0,
            // ⚠️ 用「**实际**需不需要密码」而不是「roomAuth 里有没有这一项」：
            // 显式配了 `{open:true}` 的房间是开放的，报成受保护会让房间列表挂一把不存在的锁。
            is_protected: resolve_room_auth(&state.config, &room).required,
        });
    }

    json_response(&serde_json::to_value(RoomListResponse { rooms: list }).unwrap_or_default())
}

// ── /revoke/* ─────────────────────────────────────────────────────────

/// `POST /revoke/<id>`（Go 侧 `/revoke/` 前缀）。
///
/// ⚠️★ **Go 那边没有方法检查** —— 任何方法（含 GET）都会真的执行撤销。
/// 这是既有行为，暂时照抄：改成只认 POST 会让某个用 GET 的老客户端失效。
/// 但它是个**该修的洞**（浏览器直接访问 `/revoke/5` 就会删掉 5 号条目），
/// 记在 `docs/HANDOVER.md` §6 的未决问题里。
pub async fn revoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(id) = raw_id.parse::<i32>() else {
        return write_error(
            StatusCode::BAD_REQUEST,
            codes::INVALID_REVOKE_ID,
            "Invalid revoke id",
            "无效的撤销 ID",
        );
    };

    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));
    let has_requested_room = query.contains_key("room");
    let requested_room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));

    let Some(entry) = state.store.get(id).ok().flatten() else {
        return write_error(
            StatusCode::NOT_FOUND,
            codes::MESSAGE_NOT_FOUND,
            "Message not found",
            "消息未找到",
        );
    };
    let message_room = normalize_room_name(entry.room());
    if has_requested_room && message_room != requested_room {
        return write_error(
            StatusCode::NOT_FOUND,
            codes::MESSAGE_NOT_FOUND,
            "Message not found",
            "消息未找到",
        );
    }
    if !can_access_room(&state.config, &message_room, &token) {
        return shortcuts::room_forbidden();
    }

    match state.store.remove(id) {
        Ok(true) => {}
        Ok(false) => {
            return write_error(
                StatusCode::NOT_FOUND,
                codes::MESSAGE_NOT_FOUND,
                "Message not found",
                "消息未找到",
            );
        }
        Err(e) => {
            tracing::error!(error = %e, "撤销失败");
            return write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_failed",
                "Failed to revoke message",
                "撤销消息失败",
            );
        }
    }

    // ⚠️ 广播到条目**自己记录的**房间（不是规范化之后的那份，也不是客户端传的）。
    state.broadcast("revoke", &json!({ "id": id }), entry.room());

    // Go 的 handle_revoke 成功时不写响应体（隐式 200）。
    StatusCode::OK.into_response()
}

/// `POST /revoke/all` —— 清空**指定房间**。
///
/// ⚠️ 只清指定房间，**不支持**用空串清空所有（那是刻意去掉的能力）。
pub async fn clear_all(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));
    if !can_access_room(&state.config, &room, &token) {
        return shortcuts::room_forbidden();
    }

    let mut removed = 0usize;
    for entry in state
        .store
        .recent_desc(&room, usize::MAX)
        .unwrap_or_default()
    {
        if state.store.remove(entry.id()).unwrap_or(false) {
            removed += 1;
        }
    }
    tracing::info!(room = %room, removed, "清空房间");

    // ⚠️ 用 `&room` 而不是 `room`：`json!` 会把 `String` **move** 走，
    // 后面那行还要用它当广播的房间。
    state.broadcast("clearAll", &json!({ "room": &room }), &room);

    // ⚠️ 这条路径的响应体是**纯文本**，不是 JSON —— Go 用的是 `fmt.Fprintln`。
    // 别「顺手统一」成 JSON：老客户端可能就在读这句中文。
    text_response("所有消息已清除\n".to_owned())
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
    fn bearer_prefix_is_stripped() {
        assert_eq!(
            extract_auth_token(&headers(&[("authorization", "Bearer secret")]), None),
            "secret"
        );
        assert_eq!(
            extract_auth_token(&headers(&[("authorization", "bearer secret")]), None),
            "secret",
            "大小写不敏感"
        );
    }

    /// ⚠️ 三个部分时**整个头**当凭据 —— 这是 Go 的行为，不是 bug。
    #[test]
    fn extra_spaces_keep_the_whole_header() {
        assert_eq!(
            extract_auth_token(&headers(&[("authorization", "Bearer a b")]), None),
            "Bearer a b"
        );
    }

    #[test]
    fn non_bearer_header_is_used_as_is() {
        assert_eq!(
            extract_auth_token(&headers(&[("authorization", "justapassword")]), None),
            "justapassword"
        );
    }

    #[test]
    fn query_auth_is_the_fallback() {
        assert_eq!(extract_auth_token(&HeaderMap::new(), Some("q")), "q");
        assert_eq!(extract_auth_token(&HeaderMap::new(), None), "");
    }

    #[test]
    fn extra_room_tokens_accept_json_and_csv() {
        let h = headers(&[("x-room-auth-tokens", r#"["a","b"]"#)]);
        assert_eq!(extract_auth_tokens(&h, None), ["a", "b"]);

        let h = headers(&[("x-room-auth-tokens", "a, b ,a")]);
        assert_eq!(extract_auth_tokens(&h, None), ["a", "b"], "要去重去空白");

        // 主凭据排在最前面。
        let h = headers(&[("x-room-auth-tokens", "b"), ("authorization", "a")]);
        assert_eq!(extract_auth_tokens(&h, None), ["a", "b"]);
    }

    #[test]
    fn forwarded_for_takes_the_first_hop() {
        let h = headers(&[("x-forwarded-for", "1.2.3.4, 5.6.7.8")]);
        assert_eq!(client_ip(&h, None), "1.2.3.4");

        let h = headers(&[("x-real-ip", "9.9.9.9")]);
        assert_eq!(client_ip(&h, None), "9.9.9.9");

        assert_eq!(
            client_ip(&HeaderMap::new(), Some("127.0.0.1:5555".parse().unwrap())),
            "127.0.0.1"
        );
    }

    #[test]
    fn format_resolution_priority_and_rejection() {
        let q = |s: &[(&str, &str)]| -> HashMap<String, String> {
            s.iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };

        assert_eq!(resolve_content_format(&q(&[]), false), Ok(String::new()));
        assert_eq!(resolve_content_format(&q(&[]), true), Ok("json".to_owned()));
        assert_eq!(
            resolve_content_format(&q(&[("json", "1")]), false),
            Ok("json".to_owned())
        );
        // ?format= 优先于后缀。
        assert_eq!(
            resolve_content_format(&q(&[("format", "raw")]), true),
            Ok("raw".to_owned())
        );
        // 不认识的 format 必须报错，不能回落。
        assert_eq!(
            resolve_content_format(&q(&[("format", "html")]), false),
            Err(())
        );
        // 空串的 format 当没给。
        assert_eq!(
            resolve_content_format(&q(&[("format", "  ")]), false),
            Ok(String::new())
        );
    }

    #[test]
    fn wants_json_prefers_explicit_then_accept() {
        let json_accept = headers(&[("accept", "application/json, text/plain")]);
        assert!(wants_json("json", &json_accept));
        assert!(!wants_json("raw", &json_accept), "显式 raw 要压过 Accept");
        assert!(wants_json("", &json_accept));
        assert!(!wants_json("", &HeaderMap::new()));
    }

    #[test]
    fn board_column_normalization() {
        assert_eq!(normalize_board_column(""), Some("todo"));
        assert_eq!(normalize_board_column("  "), Some("todo"));
        assert_eq!(
            normalize_board_column("Doing"),
            Some("doing"),
            "大小写不敏感"
        );
        assert_eq!(normalize_board_column(" done "), Some("done"));
        assert_eq!(normalize_board_column("later"), None);
    }

    #[test]
    fn response_type_covers_the_categories_the_frontend_branches_on() {
        assert_eq!(determine_response_type("a.png"), "image");
        assert_eq!(determine_response_type("a.mp4"), "video");
        assert_eq!(determine_response_type("a.mp3"), "audio");
        assert_eq!(determine_response_type("a.pdf"), "document");
        assert_eq!(determine_response_type("a.zip"), "archive");
        assert_eq!(determine_response_type("a.txt"), "file");
        assert_eq!(determine_response_type("noext"), "file");
    }

    #[test]
    fn url_escape_keeps_safe_chars_and_escapes_the_rest() {
        assert_eq!(url_escape("a-b_c.d~e.png"), "a-b_c.d~e.png");
        assert_eq!(url_escape("截 图.png"), "%E6%88%AA%20%E5%9B%BE.png");
        assert_eq!(url_escape("a&b.png"), "a%26b.png");
    }
}
