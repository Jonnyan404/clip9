//! 会话令牌：`POST /auth/token` 与 `POST /auth/token/refresh`。
//!
//! 对应 Go `handler.go` 里的 `handleAuthToken` / `handleAuthTokenRefresh`。
//! 令牌本身怎么签、怎么验在 `clip9_core::share`；这里只管 HTTP 形状。
//!
//! # 为什么要它
//!
//! 明文密码每请求都要发一遍：进 URL（`?auth=`）就进日志与历史，进请求头也意味着
//! 前端得**一直**拿着密码。会话令牌让前端**只存令牌**、一小时后再悄悄换一张。
//!
//! # 两种作用域
//!
//! - 房间密码换来的令牌：只开那个房间（`scope: ""`）；
//! - 全局密码换来的令牌：所有房间都开（`scope: "global"`），而且**算管理员** ——
//!   管理页刻意不存明文密码，只认这一条（见 `clip9_core::is_global_admin` 的注释）。

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use clip9_core::{ROOM_SESSION_TTL_SECONDS, SCOPE_GLOBAL};
use clip9_protocol::normalize_room_name;
use serde::Deserialize;
use serde_json::json;

use crate::error::write_error;
use crate::handlers::{extract_auth_token, json_response};
use crate::state::AppState;

/// `POST /auth/token` 的请求体。
#[derive(Debug, Default, Deserialize)]
struct TokenRequest {
    #[serde(default)]
    password: String,
}

/// 解析请求体。⚠️ **空 body 是 400**（不像 `/share` 那样容一个空对象）：
/// 「空密码换令牌」没有意义，早先的 Go 实现也是 400。
fn parse_token_request(body: &Bytes) -> Result<TokenRequest, Box<Response>> {
    serde_json::from_slice(body).map_err(|_| {
        Box::new(write_error(
            StatusCode::BAD_REQUEST,
            "invalid_request_body",
            "Invalid request body",
            "无效的请求体",
        ))
    })
}

/// `POST /auth/token` —— 用密码换一张会话令牌。
pub async fn issue(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let request = match parse_token_request(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };

    let password = request.password.trim();
    if password.is_empty() {
        return write_error(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "Password required",
            "密码不能为空",
        );
    }
    // ⚠️ 只比明文密码（不调 `can_access_room`）：那把函数对**开放**房间直接返回 true，
    // 于是「没设密码的房间」会让任意密码都换到令牌。签发端点必须自己比。
    if !password_matches(&state, &room, password) {
        return write_error(
            StatusCode::UNAUTHORIZED,
            "wrong_password",
            "Wrong password",
            "密码不正确",
        );
    }

    // 用全局密码登录 → 签发对所有房间有效的全局会话令牌。
    let global = state.config.server.auth.normalize();
    let scope = (!global.is_empty() && password == global).then_some(SCOPE_GLOBAL);
    let now = crate::state::now_secs();
    let (token, expires_at) =
        state
            .share_key
            .session_token(&room, ROOM_SESSION_TTL_SECONDS, scope, now);

    json_response(&json!({
        "token": token,
        "expiresAt": expires_at,
        "scope": scope.unwrap_or_default(),
    }))
}

/// `POST /auth/token/refresh` —— 拿旧令牌换一张新的（不需要密码）。
///
/// ⚠️ 续签**保留原来的 scope**：全局会话绝不能降级成房间专属 ——
/// 那个降级是静默的，而受影响的正是管理页（它不存明文密码）。
pub async fn refresh(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let now = crate::state::now_secs();
    let token = extract_auth_token(&headers, query.get("auth").map(String::as_str));
    let Some(claims) = state.share_key.parse_session(&token, now) else {
        return session_token_invalid();
    };
    if !state.share_key.session_matches_room(&room, &token, now) {
        return session_token_invalid();
    }

    let scope = claims.scope.clone();
    let (new_token, expires_at) =
        state
            .share_key
            .session_token(&room, ROOM_SESSION_TTL_SECONDS, scope.as_deref(), now);

    json_response(&json!({
        "token": new_token,
        "expiresAt": expires_at,
        "scope": scope.unwrap_or_default(),
    }))
}

/// 这个**明文密码**是不是这个房间的钥匙。
///
/// ⚠️ 为什么不用 `can_access_room`：它对**开放**的房间直接返回 true，于是
/// 「没设密码的房间」会让任意密码都换到令牌。签发端点必须自己比。
fn password_matches(state: &AppState, room: &str, password: &str) -> bool {
    if password.is_empty() {
        return false;
    }
    let global = state.config.server.auth.normalize();
    if !global.is_empty() && password == global {
        return true;
    }
    state
        .config
        .server
        .room_auth
        .get(&clip9_protocol::normalize_room_name(room))
        .is_some_and(|entry| !entry.password.is_empty() && entry.password == password)
}

fn session_token_invalid() -> Response {
    write_error(
        StatusCode::UNAUTHORIZED,
        "session_token_invalid",
        "Session token invalid or expired",
        "会话令牌无效或已过期",
    )
}
