//! 分享：签发、元信息、记录列表、打开上报、落地页，以及「分享令牌能不能读这条内容」。
//!
//! 对应 Go 的 `share_token.go` / `share_log.go` / `share_landing.go`。
//! 令牌的**算法**在 `clip9_core::share`（那里有和 Go 逐字节对齐的 fixture 测试），
//! 这一层只管 HTTP 形状、存储和地址拼装。
//!
//! ```text
//! POST /share         签发（**一律签发**，开放房间也发）
//! GET  /share?t=      分享页在取正文前问一次（**不消耗次数**）
//! GET  /share/list    某个房间最近的分享记录（**不含 token**）
//! POST /share/visit   分享页上报「有人打开了」
//! GET  /s/<token>     分享页本体：注入 OG 卡片的那份 SPA 外壳
//! ```
//!
//! # 三条最容易踩的
//!
//! 1. **分享令牌只放行读**（`GET /content/<id>`、`GET /file/<uuid>`）。
//!    写操作（`/text`、`/upload`、`/revoke`、挪列）**只认房间凭据** ——
//!    一张只读令牌能改数据，分享就变成了「给别人一个房间账号」。
//! 2. **`GET /share` 不消耗次数**（打开页面本身不该烧掉一次），取正文才消耗。
//! 3. **落地页既不计数也不消耗**：抓取程序会反复访问同一个地址（微信、Telegram、
//!    Slack 都会去抓，而且平台会按自己的节奏重抓），在那里计数等于把「机器抓取」
//!    算成「有人打开」。计数只认分享页 JS 的上报。

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, HeaderName, StatusCode, header};
use axum::response::{IntoResponse, Response};
use clip9_core::{
    NewShare, SHARE_PASSWORD_HEADER, SHARE_TOKEN_QUERY_KEY, ShareCheck, ShareClaims, TYPE_CONTENT,
    TYPE_FILE, normalize_share_max_uses, normalize_share_ttl,
};
use clip9_protocol::{File, ReceiveHolder, normalize_room_name};
use clip9_store::{ShareRecord, ShareUse};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{codes, shortcuts, write_error};
use crate::handlers::{client_ip, extract_auth_token, json_response, url_escape};
use crate::share_card::{self, ShareCard};
use crate::spa_shell;
use crate::state::{AppState, now_secs};

/// `/share/list` 的默认条数。
const DEFAULT_SHARE_LIST_LIMIT: usize = 50;
/// `/share/list` 的上限。
const MAX_SHARE_LIST_LIMIT: usize = 200;

/// `POST /share` 的请求体。
///
/// ⚠️ `deny_unknown_fields`：Go 那边是 `DisallowUnknownFields`。多写一个字段（拼错
/// `maxUses` 成 `max_uses`）时，**静默忽略**会让 TTL/次数设置悄悄失效，而用户看到的是
/// 「设置没生效」。
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareRequest {
    /// ⚠️ **必须能缺省**：Go 的 `shareRequest.Type` 没有 `required` 标记，
    /// 缺 `type` 时 json 解码成功、后面自己回 `missing_type`。写成必填字段的话
    /// 错误码会变成 `invalid_request_body` —— 前端据此显示的提示就变了。
    #[serde(rename = "type", default)]
    share_type: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    uuid: String,
    #[serde(rename = "maxUses", default)]
    max_uses: i64,
    #[serde(default)]
    ttl: i64,
    #[serde(default)]
    password: String,
}

/// `POST /share/visit` 的请求体。
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct VisitRequest {
    #[serde(default)]
    token: String,
    #[serde(default)]
    qr: bool,
}

/// 新档案号：16 个随机字节的十六进制。
///
/// ⚠️ 用 `uuid` v4（122 位随机）而不是序号：序号能被猜到，而 `jti` 会出现在
/// `/share/list` 里 —— 猜到别人的 jti 算不上大问题（记录里没有 token），
/// 但**限次分享的计数是按 jti 记的**，能猜到就意味着能撞掉别人的配额。
fn new_jti() -> String {
    uuid::Uuid::new_v4().as_simple().to_string()
}

/// 请求头里的分享密码。
fn share_password(headers: &HeaderMap) -> &str {
    headers
        .get(SHARE_PASSWORD_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
}

/// `?t=` 里的分享令牌。
fn share_token(query: &HashMap<String, String>) -> &str {
    query
        .get(SHARE_TOKEN_QUERY_KEY)
        .map(String::as_str)
        .unwrap_or("")
        .trim()
}

/// 拼绝对地址：`<scheme>://<host><prefix>/<path>?<query>`。
///
/// ⚠️ scheme 走 `X-Forwarded-Proto`：反代后面直接拼 `http://` 会让分享链接在
/// https 的部署上降级，而**打开链接时浏览器会拦截**（mixed content）。
fn absolute_url(headers: &HeaderMap, prefix: &str, path: &str, query: &[(&str, &str)]) -> String {
    let scheme = match headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.eq_ignore_ascii_case("https") => "https",
        _ => "http",
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let prefix = prefix.trim_end_matches('/');
    let mut url = format!("{scheme}://{host}{prefix}/{path}");
    let query: Vec<String> = query
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={}", percent_encode_component(v)))
        .collect();
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query.join("&"));
    }
    url
}

/// 分享地址（也就是分享页本体）：`<prefix>/s/<token>`。
///
/// ⚠️ 只有一个地址：抓取程序和真人是同一个链接，没有第二跳也没有第二个身份。
/// 早先它是 `/#/s?t=…`（hash 路由）+ 另一个落地页，于是平台统计、书签、二维码各认各的。
fn landing_url(headers: &HeaderMap, prefix: &str, token: &str) -> String {
    absolute_url(headers, prefix, &format!("s/{}", url_escape(token)), &[])
}

/// query 值转义（房间名可能带中文/空格）。
fn percent_encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 读一个文件的登记信息；`None` = 不存在。
fn find_file(state: &AppState, uuid: &str) -> Option<File> {
    match state.store.get_file(uuid) {
        Ok(found) => found,
        Err(e) => {
            tracing::warn!(error = %e, uuid, "读文件登记失败");
            None
        }
    }
}

/// 文件是否已过期（`expire_time == 0` = 永不过期）。
fn file_expired(file: &File, now: i64) -> bool {
    file.expire_time > 0 && file.expire_time < now
}

/// 文件名 / 大小，以上传登记为准补全（消息条目里的文件字段可能是空的）。
fn share_file_meta(
    state: &AppState,
    uuid: &str,
    fallback_name: &str,
    fallback_size: i64,
) -> (String, i64) {
    let (mut name, mut size) = (fallback_name.to_owned(), fallback_size);
    if uuid.trim().is_empty() {
        return (name, size);
    }
    if let Some(file) = find_file(state, uuid) {
        if !file.name.trim().is_empty() {
            name = file.name;
        }
        if file.size > 0 {
            size = file.size;
        }
    }
    (name, size)
}

/// 往响应里补文件元信息（`uuid` / `name` / `size`），顺带做存在性与过期检查。
///
/// 返回 `Err(响应)` 表示已经写过错误响应了，调用方直接返回它。
///
/// ⚠️ `Box<Response>`：`Response` 本身有 128 字节以上，直接放进 `Result` 的错误位会触发
/// `clippy::result_large_err`（每个返回值都要在栈上搬它）。这里只包一层，不是为了省内存。
fn fill_share_file_info(
    state: &AppState,
    response: &mut Value,
    uuid: &str,
) -> Result<(), Box<Response>> {
    let Some(file) = find_file(state, uuid) else {
        return Err(Box::new(write_error(
            StatusCode::NOT_FOUND,
            "file_not_found",
            "File not found or expired",
            "文件未找到或已过期",
        )));
    };
    if file_expired(&file, now_secs()) {
        return Err(Box::new(write_error(
            StatusCode::NOT_FOUND,
            codes::FILE_EXPIRED,
            "File expired",
            "文件已过期",
        )));
    }
    let name = if file.name.is_empty() {
        "file"
    } else {
        file.name.as_str()
    };
    if let Some(object) = response.as_object_mut() {
        object.insert("uuid".to_owned(), json!(uuid));
        object.insert("name".to_owned(), json!(name));
        object.insert("size".to_owned(), json!(file.size));
    }
    Ok(())
}

/// 写分享记录，顺带把被裁掉的数量记进日志。
///
/// ⚠️ 写记录失败**不让签发失败**：分享本身已经能用了，统计是附加功能，
/// 而「统计丢了」不该让用户拿不到链接（Go 那边同样只记日志）。
fn record_share(state: &AppState, record: &ShareRecord, now: i64) {
    match state.store.put_share(record, now) {
        Ok(0) => {}
        Ok(trimmed) => tracing::info!(jti = %record.jti, trimmed, "分享记录超上限，裁掉了最旧的"),
        Err(e) => tracing::warn!(error = %e, jti = %record.jti, "写分享记录失败（分享已签发）"),
    }
}

/// 解析 `POST /share` 的请求体。
///
/// ⚠️ **空 body 当成空请求**（Go 那边 `err.Error() != "EOF"` 就是在容这个）：
/// 捷径和脚本经常发一个空 body 就想签发默认参数。
fn parse_share_request(body: &Bytes) -> Result<ShareRequest, Box<Response>> {
    if body.is_empty() {
        return Ok(ShareRequest::default());
    }
    serde_json::from_slice(body).map_err(|_| {
        Box::new(write_error(
            StatusCode::BAD_REQUEST,
            "invalid_request_body",
            "Invalid request body",
            "无效的请求体",
        ))
    })
}

/// 内容型分享的记录：文本取首行摘要，文件取文件名/大小。
fn share_record_for_content(
    state: &AppState,
    claims: &ShareClaims,
    entry: &ReceiveHolder,
    now: i64,
) -> ShareRecord {
    let (name, size) = match entry {
        ReceiveHolder::Text(text) => (share_card::first_summary_line(&text.content, 60), 0),
        ReceiveHolder::File(file) => share_file_meta(state, &file.cache, &file.name, file.size),
    };
    ShareRecord {
        jti: claims.jti_str().to_owned(),
        share_type: claims.share_type.clone(),
        id: claims.id.clone(),
        room: claims.room.clone(),
        kind: entry.kind().to_owned(),
        name,
        size,
        created_at: now,
        exp: claims.exp,
        max_uses: claims.max_uses(),
        password: claims.needs_password(),
        visits: 0,
        scans: 0,
        used: 0,
    }
}

/// 拼「内容型分享」的响应体。
///
/// 收成结构体是因为它有**九个**参数，其中四个是字符串（`id` / `room` / `token` / 类型）——
/// 位置传错不会报错，只会在链接里指向别人房间的内容。
struct ContentShareResponse<'a> {
    headers: &'a HeaderMap,
    prefix: &'a str,
    claims: &'a ShareClaims,
    token: &'a str,
    id: &'a str,
    room: &'a str,
    ttl: i64,
    expires_at: i64,
    max_uses: i64,
}

fn content_share_response(r: &ContentShareResponse<'_>) -> Response {
    let mut raw_query = vec![(SHARE_TOKEN_QUERY_KEY, r.token)];
    if r.room != "default" {
        raw_query.push(("room", r.room));
    }
    json_response(&json!({
        "type": TYPE_CONTENT,
        "id": r.id,
        "room": r.room,
        "ttl": r.ttl,
        "expiresAt": r.expires_at,
        "maxUses": r.max_uses,
        "token": r.token,
        "jti": r.claims.jti_str(),
        // ⚠️ `url` / `pageUrl` **同值**：早先是两个地址（分享页 + 落地页），
        // 于是平台点击统计、书签、二维码各认各的。现在只有一个地址。
        "url": landing_url(r.headers, r.prefix, r.token),
        "pageUrl": landing_url(r.headers, r.prefix, r.token),
        "rawUrl": absolute_url(
            r.headers,
            r.prefix,
            &format!("content/{}", r.id),
            &raw_query,
        ),
        "visits": 0,
        "scans": 0,
    }))
}

/// `POST /share` —— 签发一条分享令牌。
///
/// ⚠️★ **一律签发**（开放房间也发）：TTL、次数限制、密码全都靠 token 承载，
/// 房间开不开放与它无关。早先的实现只在「房间需要鉴权」时才签，于是开放房间返回的是
/// 裸接口地址 —— 链接永不过期、不限次数，弹窗里设的值被**静默丢弃**，
/// 而响应里却照样回 `ttl` / `maxUses`，会骗到调用方。
pub async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let request = match parse_share_request(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };

    let share_type = request.share_type.trim().to_lowercase();
    if share_type.is_empty() {
        return write_error(
            StatusCode::BAD_REQUEST,
            "missing_type",
            "Missing type",
            "缺少 type",
        );
    }

    let now = now_secs();
    let requested_room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let has_requested_room = query.contains_key("room");
    let auth = extract_auth_token(&headers, query.get("auth").map(String::as_str));
    let ttl = normalize_share_ttl(request.ttl);
    let max_uses = normalize_share_max_uses(request.max_uses);

    match share_type.as_str() {
        TYPE_CONTENT => {
            let id = request.id.trim().to_owned();
            if id.is_empty() {
                return write_error(
                    StatusCode::BAD_REQUEST,
                    "missing_id",
                    "Missing id",
                    "缺少 id",
                );
            }
            // ⚠️ `id` 是**字符串**（token 里存的就是它），但查找要整数。
            // 解析失败和不存在的区别对外没有意义 —— 两条都回 400「无效的 id」，
            // 别在 400 里泄露「这条 id 存在但你看不到它」。
            let Ok(content_id) = id.parse::<i32>() else {
                return invalid_id();
            };
            if content_id < 0 {
                return invalid_id();
            }
            let Some(entry) = state.store.get(content_id).ok().flatten() else {
                return shortcuts::content_not_found();
            };
            // 房间以**条目自己记录的**为准；带了 `?room=` 却对不上，当作不存在
            // （不泄露「它存在，只是不在这个房间」）。
            let room = normalize_room_name(entry.room());
            if has_requested_room && room != requested_room {
                return shortcuts::content_not_found();
            }
            if !state.can_access_room(&room, &auth) {
                return shortcuts::room_forbidden();
            }

            let (claims, expires_at) = state.share_key.share_claims(NewShare {
                share_type: TYPE_CONTENT,
                id: &id,
                room: &room,
                ttl_seconds: ttl,
                max_uses,
                password: &request.password,
                jti: new_jti(),
                now,
            });
            let token = state.share_key.sign(&claims);
            record_share(
                &state,
                &share_record_for_content(&state, &claims, &entry, now),
                now,
            );
            content_share_response(&ContentShareResponse {
                headers: &headers,
                prefix: &state.config.server.prefix,
                claims: &claims,
                token: &token,
                id: &id,
                room: &room,
                ttl,
                expires_at,
                max_uses,
            })
        }

        TYPE_FILE => {
            // ⚠️ 文件分享用 `uuid`，但 `id` 也认（两个后端都这么容，捷径还在用）。
            let uuid = {
                let from_uuid = request.uuid.trim();
                if from_uuid.is_empty() {
                    request.id.trim()
                } else {
                    from_uuid
                }
            }
            .to_owned();
            if uuid.is_empty() {
                return write_error(
                    StatusCode::BAD_REQUEST,
                    "missing_uuid",
                    "Missing uuid",
                    "缺少 uuid",
                );
            }
            let Some(file) = find_file(&state, &uuid) else {
                return file_not_found();
            };
            if file_expired(&file, now) {
                return write_error(
                    StatusCode::NOT_FOUND,
                    codes::FILE_EXPIRED,
                    "File expired",
                    "文件已过期",
                );
            }
            let room = normalize_room_name(&file.room);
            if has_requested_room && room != requested_room {
                return file_not_found();
            }
            if !state.can_access_room(&room, &auth) {
                return shortcuts::room_forbidden();
            }

            let (claims, expires_at) = state.share_key.share_claims(NewShare {
                share_type: TYPE_FILE,
                id: &uuid,
                room: &room,
                ttl_seconds: ttl,
                max_uses,
                password: &request.password,
                jti: new_jti(),
                now,
            });
            let token = state.share_key.sign(&claims);
            let (name, size) = share_file_meta(&state, &uuid, &file.name, file.size);
            record_share(
                &state,
                &ShareRecord {
                    jti: claims.jti_str().to_owned(),
                    share_type: claims.share_type.clone(),
                    id: claims.id.clone(),
                    room: claims.room.clone(),
                    kind: TYPE_FILE.to_owned(),
                    name,
                    size,
                    created_at: now,
                    exp: claims.exp,
                    max_uses: claims.max_uses(),
                    password: claims.needs_password(),
                    visits: 0,
                    scans: 0,
                    used: 0,
                },
                now,
            );

            // 文件名**不进分享页地址**（它可能很长、会进浏览器历史）——
            // 分享页先问一次 `GET /share` 拿到名字，再拼 `/file/<uuid>/<name>`。
            let filename = if file.name.is_empty() {
                "file"
            } else {
                file.name.as_str()
            };
            let raw_query = [(SHARE_TOKEN_QUERY_KEY, token.as_str())];
            json_response(&json!({
                "type": TYPE_FILE,
                "uuid": uuid,
                "room": room,
                "ttl": ttl,
                "expiresAt": expires_at,
                "maxUses": max_uses,
                "token": token,
                "jti": claims.jti_str(),
                "url": landing_url(&headers, &state.config.server.prefix, &token),
                "pageUrl": landing_url(&headers, &state.config.server.prefix, &token),
                "rawUrl": absolute_url(
                    &headers,
                    &state.config.server.prefix,
                    &format!("file/{uuid}/{}", url_escape(filename)),
                    &raw_query,
                ),
                "visits": 0,
                "scans": 0,
            }))
        }

        _ => write_error(
            StatusCode::BAD_REQUEST,
            "unsupported_type",
            "Unsupported type",
            "不支持的 type",
        ),
    }
}

fn invalid_id() -> Response {
    write_error(
        StatusCode::BAD_REQUEST,
        "invalid_id",
        "Invalid id",
        "无效的 id",
    )
}

fn file_not_found() -> Response {
    write_error(
        StatusCode::NOT_FOUND,
        "file_not_found",
        "File not found or expired",
        "文件未找到或已过期",
    )
}

/// `GET /share?t=<token>` —— 分享页在取正文之前先问一次。
///
/// 为什么不直接让分享页去调 `/content` 或 `/file`：
/// - 文件场景必须先知道**文件名**才能拼出 `/file/<uuid>/<name>`，而 token 里没有这个名字；
/// - 分享页要在取正文之前就把「类型 / 大小 / 剩余有效期 / 剩余次数」渲染出来；
/// - 「token 无效」「需要密码」这两种情况要能分开报，而取正文的接口分不出来。
///
/// ⚠️ **不消耗使用次数**：打开页面本身不该烧掉一次，真正取正文时才消耗。
pub async fn info(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let now = now_secs();
    let Some(claims) = state.share_key.parse(share_token(&query), now) else {
        return share_token_invalid();
    };
    // ⚠️ 密码要走 `X-Share-Password` 头，**绝不进 URL**（query 会进浏览器历史和访问日志）。
    if !state.share_key.password_matches(
        claims.password_hash.as_deref().unwrap_or(""),
        share_password(&headers),
    ) {
        return share_password_required();
    }

    let mut response = json!({
        "type": claims.share_type,
        "room": claims.room,
        "expiresAt": claims.exp,
        "maxUses": claims.max_uses(),
        "needsPassword": claims.needs_password(),
    });
    // `used` 只在真的有限次且有记录时出现（Go 的 `shareUsageSnapshot` 同义）。
    if claims.max_uses() > 0
        && !claims.jti_str().is_empty()
        && let Ok(Some(record)) = state.store.get_share(claims.jti_str())
    {
        response["used"] = json!(record.used);
    }

    match claims.share_type.as_str() {
        TYPE_CONTENT => {
            let Ok(content_id) = claims.id.trim().parse::<i32>() else {
                return shortcuts::content_not_found();
            };
            let Some(entry) = state.store.get(content_id).ok().flatten() else {
                return shortcuts::content_not_found();
            };
            // ⚠️ 房间以 token 里那份为准：拿 A 房间的令牌去读 B 房间的同 id 条目要拒。
            if normalize_room_name(entry.room()) != claims.room {
                return shortcuts::content_not_found();
            }
            let room = normalize_room_name(entry.room());
            response["id"] = json!(claims.id);
            response["room"] = json!(room);
            response["kind"] = json!(entry.kind());
            if let ReceiveHolder::File(file) = &entry
                && let Err(response) = fill_share_file_info(&state, &mut response, &file.cache)
            {
                return *response;
            }
        }
        TYPE_FILE => {
            response["kind"] = json!(TYPE_FILE);
            if let Err(response) = fill_share_file_info(&state, &mut response, &claims.id) {
                return *response;
            }
        }
        // `room_session` 也能过签名校验（同一个信封）—— 但它**不是**一条分享。
        _ => {
            return write_error(
                StatusCode::BAD_REQUEST,
                "unsupported_type",
                "Unsupported type",
                "不支持的分享类型",
            );
        }
    }

    // ⚠️ 带密码的分享**才**换发预览令牌：浏览器直连 `<img>` / `<video>` / `<a download>`
    // 加不了自定义请求头，而原令牌要求 `X-Share-Password`。
    // 不带密码的分享刻意**不发** —— 它的原令牌本来就能进 URL，多发一个「不限次」的令牌
    // 会让 maxUses 形同虚设（拿到链接的人换一个来绕过配额）。
    if claims.needs_password() {
        let (preview_token, preview_exp) = state.share_key.preview_token(&claims, now);
        response["previewToken"] = json!(preview_token);
        response["previewExpiresAt"] = json!(preview_exp);
    }

    json_response(&response)
}

/// `/share/list` 的 limit 归一化：默认 50，上限 200。
///
/// ⚠️ 参数和响应里报出去的值**必须是同一个**（Go 那边有同一条注释）——
/// 否则调用方看到的是「我没拿到的那个数」。
fn normalize_share_list_limit(raw: Option<&String>) -> usize {
    match raw.map(|v| v.trim().parse::<usize>()) {
        Some(Ok(limit)) if limit > 0 => limit.min(MAX_SHARE_LIST_LIMIT),
        _ => DEFAULT_SHARE_LIST_LIMIT,
    }
}

/// `GET /share/list` —— 某个房间最近的分享记录。
///
/// ⚠️ 鉴权与「在该房间签发分享」完全一致（`can_access_room`），规则只有一条，
/// 不会出现「能建分享但看不到自己建的分享」。
///
/// ⚠️ **列表里没有 token**：token 是 bearer 凭据，列表一旦带上它，就成了
/// 「谁都能把别人的分享链接再抄一遍」的入口。
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let auth = extract_auth_token(&headers, query.get("auth").map(String::as_str));
    if !state.can_access_room(&room, &auth) {
        return shortcuts::room_forbidden();
    }

    let limit = normalize_share_list_limit(query.get("limit"));
    let now = now_secs();
    let (records, total) = state
        .store
        .shares_for_room(&room, limit)
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, room, "读分享记录失败");
            (Vec::new(), 0)
        });

    let entries: Vec<Value> = records
        .iter()
        .map(|record| {
            json!({
                "jti": record.jti,
                "type": record.share_type,
                "kind": record.kind,
                "id": record.id,
                "room": record.room,
                "name": record.name,
                "size": record.size,
                "createdAt": record.created_at,
                "expiresAt": record.exp,
                "maxUses": record.max_uses,
                "used": record.used,
                "visits": record.visits,
                "scans": record.scans,
                "password": record.password,
                "expired": record.exp > 0 && record.exp <= now,
            })
        })
        .collect();

    json_response(&json!({
        "room": room,
        "total": total,
        "limit": limit,
        "records": entries,
    }))
}

/// `POST /share/visit` —— 分享页被**真人**打开时上报一次。
///
/// ⚠️ 为什么由前端上报、而不是在 `/s/<token>` 落地页里直接计数：落地页是给社交平台的
/// **抓取程序**看的（贴一次链接，微信 / Telegram / Slack 都会去抓，平台还会按自己的节奏重抓）。
/// 在那里计数会把「机器抓取」算成「有人打开」。只有执行了 JS 的分享页能证明是真人打开了。
///
/// 鉴权：只需要 token 本身 —— 你拿着链接才能上报，接口也只回**这一条**分享的计数。
pub async fn visit(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let request: VisitRequest = if body.is_empty() {
        VisitRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(request) => request,
            Err(_) => {
                return write_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request_body",
                    "Invalid request body",
                    "无效的请求体",
                );
            }
        }
    };

    // token 也允许走 query（保留 body 为主）：二维码扫进来的访客可以直接带。
    let token = if request.token.trim().is_empty() {
        share_token(&query).to_owned()
    } else {
        request.token.trim().to_owned()
    };
    if token.is_empty() {
        return write_error(
            StatusCode::BAD_REQUEST,
            "missing_token",
            "Missing token",
            "缺少 token",
        );
    }

    let now = now_secs();
    let Some(claims) = state.share_key.parse(&token, now) else {
        return share_token_invalid();
    };
    // 已过期的链接不计数：访客看到的是错误页，不该算作「打开了一次分享」。
    if claims.exp <= now {
        return share_token_invalid();
    }

    // 二维码链接带 `?q=1` —— 扫码和点链接打开的是同一个页面，这是唯一能把两者分开的信号。
    let via_qr = request.qr || query.get("q").map(String::as_str) == Some("1");
    let tracked = state.mark_share_visit(claims.jti_str(), &client_ip(&headers, Some(peer)), now);

    let counts = if tracked {
        state
            .store
            .record_share_open(claims.jti_str(), via_qr)
            .ok()
            .flatten()
    } else {
        // 不计数时也要回**当前**的数（前端会显示出来），只读不写。
        state
            .store
            .get_share(claims.jti_str())
            .ok()
            .flatten()
            .map(|record| (record.visits, record.scans))
    };
    let (visits, scans) = counts.unwrap_or((0, 0));

    json_response(&json!({
        "ok": true,
        "tracked": tracked,
        "visits": visits,
        "scans": scans,
    }))
}

fn share_token_invalid() -> Response {
    write_error(
        StatusCode::UNAUTHORIZED,
        "share_token_invalid",
        "Share link is invalid or expired",
        "分享链接无效或已过期",
    )
}

fn share_password_required() -> Response {
    write_error(
        StatusCode::UNAUTHORIZED,
        "share_password_required",
        "Share password required",
        "需要分享密码",
    )
}

// ── 落地页（`/s/<token>`） ────────────────────────────────────────────

/// 落地页算卡片时要用的「请求侧」信息：scheme / host / prefix / token。
///
/// 收成一处是因为它要同时喂给「算 canonical」「算 og:image」和「填卡片」三个地方，
/// 而漏传其中一个的后果是**链接里的主机名错了**（用户看到的是打不开的链接，
/// 而且不会有任何报错 —— 它语法完全合法）。
struct Landing<'a> {
    headers: &'a HeaderMap,
    prefix: &'a str,
    token: &'a str,
}

impl Landing<'_> {
    fn canonical(&self) -> String {
        landing_url(self.headers, self.prefix, self.token)
    }
}

/// `GET /s/<token>` —— 分享链接的**唯一地址**：一份注入了 OG 卡片的外壳。
///
/// 抓取程序不执行 JS，所以摘要必须由服务端写进 HTML；真人跑起前端路由后
/// 看到的就是分享页本身。也就是说**抓取程序和真人是同一个地址**，没有第二跳。
///
/// ⚠️ 这个端点**既不计数也不消耗次数**（理由见模块注释）。
pub async fn landing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Response {
    let now = now_secs();
    let prefix = state.config.server.prefix.clone();
    let landing = Landing {
        headers: &headers,
        prefix: &prefix,
        token: token.trim(),
    };
    let card = landing_card(&state, &landing, now);

    // 正常路径：把卡片注入 SPA 外壳。没有外壳（只跑 API）就只给一张卡 ——
    // 抓取程序要的本来就是标签，而真人那边本来也没有前端可以看。
    let base = spa_shell::base_href(&prefix);
    let body = match spa_shell::read_shell(state.static_dir.as_deref()) {
        Some(shell) => {
            spa_shell::inject_tags(&shell, &base, &card.title, &share_card::head_tags(&card))
                .unwrap_or_else(|| share_card::fallback_page(&card))
        }
        None => share_card::fallback_page(&card),
    };

    // ⚠️ 四条头都在防「这条地址的副本被人留着」：
    // - noindex：抓取程序不看它，所以 OG 照样有效；
    // - private + must-revalidate：别让中间缓存 / CDN 长期留着带摘要的这份 HTML；
    // - no-referrer：地址里带 token，不让它作为 Referer 流到第三方；
    // - nosniff：顺带挡住 MIME 嗅探。
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (HeaderName::from_static("x-robots-tag"), "noindex, nofollow"),
            (header::CACHE_CONTROL, "private, max-age=0, must-revalidate"),
            (HeaderName::from_static("referrer-policy"), "no-referrer"),
            (HeaderName::from_static("x-content-type-options"), "nosniff"),
        ],
        body,
    )
        .into_response()
}

/// 算落地页那张卡。取不到内容时保持调用方设好的通用文案。
fn landing_card(state: &AppState, landing: &Landing<'_>, now: i64) -> ShareCard {
    let mut card = ShareCard::invalid(landing.canonical());
    let Some(claims) = state.share_key.parse(landing.token, now) else {
        return card;
    };

    // ⚠️ 有密码就到此为止：预览里放内容摘要等于把保护绕过去。
    if claims.needs_password() {
        card.title = "受密码保护的分享".to_owned();
        card.description = "打开后需要输入分享密码才能查看内容。".to_owned();
        return card;
    }

    match claims.share_type.as_str() {
        TYPE_CONTENT => {
            let Ok(content_id) = claims.id.trim().parse::<i32>() else {
                return card;
            };
            let Some(entry) = state.store.get(content_id).ok().flatten() else {
                return deleted_card(card, "这条分享指向的内容已不在服务器上。");
            };
            // ⚠️ 房间必须与 token 里那份一致 —— 和 `info` 里那条是同一道校验，两条路径都要有。
            // 少了它，一张「room 与条目对不上」的令牌会把**别的房间**的内容摘要写进 OG 卡片，
            // 而这份 HTML 会被第三方缓存且删不掉（见模块注释）。正常的签发路径产生不了这种
            // token（房间取自条目自己），所以这是纵深防御，不是堵一个已存在的洞。
            if normalize_room_name(entry.room()) != claims.room {
                return card;
            }
            match &entry {
                ReceiveHolder::File(file) => {
                    let (name, size) = share_file_meta(state, &file.cache, &file.name, file.size);
                    let name = if name.is_empty() { "file" } else { &name };
                    card.title = share_card::truncate_runes(name, share_card::title_limit());
                    card.description = share_card::join_meta(&[
                        "文件",
                        &share_card::format_size(size),
                        &share_card::expiry_note(claims.exp, now),
                    ]);
                    maybe_set_share_image(landing, &mut card, &file.cache, name, size, &claims);
                }
                ReceiveHolder::Text(text) => {
                    let summary =
                        share_card::first_summary_line(&text.content, share_card::title_limit());
                    if summary.is_empty() {
                        card.title = "有人分享了一段文本".to_owned();
                        card.description = share_card::join_meta(&[]);
                        return card;
                    }
                    card.title = summary;
                    card.description = share_card::join_meta(&[
                        "分享的文本",
                        &share_card::expiry_note(claims.exp, now),
                    ]);
                }
            }
        }
        TYPE_FILE => {
            let Some(file) = find_file(state, &claims.id) else {
                return deleted_card(card, "这条分享指向的文件已不在服务器上。");
            };
            let (name, size) = share_file_meta(state, &claims.id, &file.name, file.size);
            let name = if name.is_empty() { "file" } else { &name };
            card.title = share_card::truncate_runes(name, share_card::title_limit());
            card.description = share_card::join_meta(&[
                "文件",
                &share_card::format_size(size),
                &share_card::expiry_note(claims.exp, now),
            ]);
            maybe_set_share_image(landing, &mut card, &claims.id, name, size, &claims);
        }
        _ => {}
    }
    card
}

fn deleted_card(mut card: ShareCard, description: &str) -> ShareCard {
    card.title = "内容已被删除或过期".to_owned();
    card.description = description.to_owned();
    card
}

/// 给图片分享补 `og:image`，让预览直接显示缩略图。
///
/// ⚠️ 只在**不限次**的分享上启用：抓取程序抓图要走 `/file` 的令牌校验，而那里**消耗一次
/// 额度**（见 [`validate_share_read`]）。额满之后真人点开就是「已被使用完」——
/// **预览把链接用掉是绝对不能接受的**。
fn maybe_set_share_image(
    landing: &Landing<'_>,
    card: &mut ShareCard,
    uuid: &str,
    name: &str,
    size: i64,
    claims: &ShareClaims,
) {
    if claims.max_uses() > 0 {
        return;
    }
    if size > share_card::image_max_bytes() {
        return;
    }
    if !share_card::is_previewable_image_name(name) || uuid.trim().is_empty() {
        return;
    }
    let name = if name.is_empty() { "image" } else { name };
    card.image = Some(absolute_url(
        landing.headers,
        landing.prefix,
        &format!("file/{uuid}/{}", url_escape(name)),
        &[(SHARE_TOKEN_QUERY_KEY, landing.token)],
    ));
}

// ── 读路径上的分享令牌 ────────────────────────────────────────────────

/// 这个请求能不能读这条内容：房间凭据 **或** 针对**这条内容**的分享令牌。
///
/// ⚠️ 房间按**条目自己记录的**来（调用方传），不信 `?room=` ——
/// 否则 `?room=default` 能把受保护房间的条目读出来。
#[must_use]
pub fn can_read_content(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    room: &str,
    id: i32,
) -> bool {
    let auth = extract_auth_token(headers, query.get("auth").map(String::as_str));
    if state.can_access_room(room, &auth) {
        return true;
    }
    validate_share_read(state, headers, query, TYPE_CONTENT, &id.to_string(), room)
}

/// 这个请求能不能读某个文件的字节（走分享令牌的那一条路）。
///
/// ⚠️★ **两种令牌都要认**，漏一种就是「文本正常、文件 401」：
/// - `typ=file` —— 显式「分享这个文件」签出来的，`id` 就是 uuid；
/// - `typ=content` —— **UI 上的分享按钮一律走这条**（前端固定发 `{type:'content', id:<内容 id>}`），
///   而它指向的内容可能正是一个文件 —— 这时 `id` 是**内容 id**，不是 uuid。
///
/// 不认 content 的后果：从卡片 / 时间流分享出去的图片、视频、音频，在**配了密码**的实例上
/// 一律 401 —— 分享页的预览、下载按钮、以及 OG 卡片的 `og:image` 全挂；
/// 而文本分享正常（它走 `/content`，那边本来就认 `typ=content`）。
/// 开放实例里房间凭据直接放行，所以这个不对称一直看不出来（实测复现过）。
#[must_use]
pub fn can_read_file(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    room: &str,
    uuid: &str,
) -> bool {
    let auth = extract_auth_token(headers, query.get("auth").map(String::as_str));
    if state.can_access_room(room, &auth) {
        return true;
    }
    if validate_share_read(state, headers, query, TYPE_FILE, uuid, room) {
        return true;
    }

    // `typ=content` 的那条路：先确认这个内容真的指向**这个**文件 ——
    // 否则就是拿 A 的分享去读 B 的字节。
    let now = now_secs();
    let Some(claims) = state.share_key.parse(share_token(query), now) else {
        return false;
    };
    if claims.share_type != TYPE_CONTENT {
        return false;
    }
    let Ok(content_id) = claims.id.trim().parse::<i32>() else {
        return false;
    };
    let Some(ReceiveHolder::File(file)) = state.store.get(content_id).ok().flatten() else {
        return false;
    };
    if file.cache != uuid {
        return false;
    }
    // 密码 / 有效期 / 次数这些规则只在 core 里写了一份，
    // 这里用 content 的类型再走一遍，**别在这儿重写第二份**。
    validate_share_read(state, headers, query, TYPE_CONTENT, &claims.id, room)
}

/// 校验一串分享令牌能不能用来读这条内容/这个文件；限次的顺手把额度扣掉。
///
/// ⚠️ 方法固定按 `GET` 算：这两个入口都是**只读**的，写路径（`/text`、`/upload`、`/revoke`、
/// 挪列）**不认分享令牌** —— 一张只读令牌能改数据，分享就变成了「给别人一个房间账号」。
fn validate_share_read(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    expected_type: &str,
    expected_id: &str,
    expected_room: &str,
) -> bool {
    let now = now_secs();
    let check = ShareCheck {
        token: share_token(query),
        expected_type,
        expected_id,
        expected_room,
        password: share_password(headers),
        method: "GET",
        // Range：拖进度条 / 断点续传**不该**烧掉一次额度。
        range_header: headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        now,
    };
    let Some(verdict) = state.share_key.validate_share(&check) else {
        return false;
    };
    if !verdict.consume_use {
        return true;
    }

    match state.store.consume_share_use(verdict.claims.jti_str(), now) {
        Ok(ShareUse::Consumed { .. }) => true,
        Ok(ShareUse::Exhausted { .. }) | Ok(ShareUse::Expired) => false,
        Ok(ShareUse::Unknown) => {
            // ⚠️ 记录不在了（被裁掉）。放行并**留下痕迹**：宁可让一次限额变成无限，
            // 也不要让一条还有效的链接在用户手里突然打不开 —— 而裁剪策略已经优先保住
            // 「仍然可用」的记录，能走到这里说明同一个窗口里有 500+ 条分享。
            tracing::warn!(
                jti = verdict.claims.jti_str(),
                "限次分享的记录已被裁掉，按 0 次放行（本次不计数）"
            );
            true
        }
        Err(e) => {
            // ⚠️ 读不了存储就**保守拒绝**：这里是配额边界，宁可少给一次。
            tracing::warn!(error = %e, "扣分享次数失败，拒绝这次读取");
            false
        }
    }
}
