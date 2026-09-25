//! 房间鉴权的**统一闸门**。
//!
//! ⚠️ 为什么单独一个文件：这个项目被「鉴权在两处各写一份」咬过 —— P0 就漏过一次：
//! `POST /text` 一路没有闸门，于是**任何人都能往带密码的房间里发消息**
//! （Go 那边是 `authMiddleware` 兜着的，`/text` 也在它的名单里）。
//! 漏掉的那一处不报错、不打日志，验收脚本用的又恰好是正确凭据 —— 于是它「通过了」。
//!
//! 规则只有一条：**每个要写、或要读房间内容的入口，都必须先过这里**。
//! 判定逻辑本身在 `clip9_core`（`AppState::can_access_room`），这里只管 HTTP 的那层。

use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;

use crate::error::{codes, write_error};
use crate::handlers::extract_auth_token;
use crate::state::AppState;

/// 只认房间凭据（密码 / 会话令牌）的闸门。`None` = 放行；`Some(响应)` = 直接返回它。
///
/// ⚠️ 两个错误码**不一样**：没带凭据是 `unauthorized`，带了但不对是
/// `unauthorized_invalid_token`。客户端据此决定「提示输密码」还是「提示密码错」。
pub fn require_room_access(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    room: &str,
) -> Option<Response> {
    let token = extract_auth_token(headers, query.get("auth").map(String::as_str));
    if state.can_access_room(room, &token) {
        return None;
    }
    if token.is_empty() && share_token(query).is_empty() {
        return Some(write_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Authentication required",
            "需要认证令牌",
        ));
    }
    Some(write_error(
        StatusCode::UNAUTHORIZED,
        codes::UNAUTHORIZED_INVALID_TOKEN,
        "Invalid auth token",
        "无效的认证令牌",
    ))
}

/// 读一个文件的闸门。`shared_uuid` = 允许分享令牌指向的 uuid。
///
/// - `None`：只认房间凭据（写路径，以及 `/text`）。
/// - `Some(uuid)`：房间凭据**或**针对这个文件的分享令牌都放行（`GET /file/`）。
pub fn require_file_read_access(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    room: &str,
    shared_uuid: Option<&str>,
) -> Option<Response> {
    let token = extract_auth_token(headers, query.get("auth").map(String::as_str));
    if state.can_access_room(room, &token) {
        return None;
    }
    // ⚠️ 分享令牌只放行**读**：一张只读令牌能改数据，分享就变成了「给别人一个房间账号」。
    if let Some(uuid) = shared_uuid
        && crate::share::can_read_file(state, headers, query, room, uuid)
    {
        return None;
    }
    if token.is_empty() && share_token(query).is_empty() {
        return Some(write_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Authentication required",
            "需要认证令牌",
        ));
    }
    Some(write_error(
        StatusCode::UNAUTHORIZED,
        codes::UNAUTHORIZED_INVALID_TOKEN,
        "Invalid auth token",
        "无效的认证令牌",
    ))
}

/// `?t=` 里有没有分享令牌。
///
/// ⚠️ 判「有没有带凭据」时**要把 `t=` 算进去**：带了无效分享令牌却回
/// `unauthorized`（而不是 `unauthorized_invalid_token`），分享页会以为「你还没输密码」。
fn share_token(query: &HashMap<String, String>) -> &str {
    query
        .get(clip9_core::SHARE_TOKEN_QUERY_KEY)
        .map(String::as_str)
        .unwrap_or("")
        .trim()
}
