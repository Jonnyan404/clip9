//! clip9 服务端（lib）。
//!
//! 这个 crate 同时是**两种东西**：
//!
//! - `lib`：组装好的 `axum::Router`，可以被任何外壳调用（Tauri 桌面端、Android JNI）；
//! - `bin`（`src/bin/clip9-server.rs`）：独立二进制，静态链接 musl，扔进 Docker / OpenWrt 就能跑。
//!
//! ⚠️ 之所以要拆成 lib + bin，是为了让服务端**不用起 Tauri 就能测** ——
//! 不然每次验证一个接口都要拉起一个桌面应用。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::routing::get;
use axum::{Json, Router};
use clip9_core::{Config, can_access_room, resolve_room_auth};
use serde_json::json;

/// 服务端共享状态。
///
/// ⚠️ 现在只有配置。存储（`clip9-store`）、会话、分享记录随后接进来 ——
/// 刻意先留成一个小结构体，而不是一上来就堆满字段：字段一多，
/// 「谁该在锁里访问谁」就没人说得清了。
pub struct AppState {
    pub config: Config,
}

impl AppState {
    #[must_use]
    pub fn new(config: Config) -> Self {
        Self { config }
    }
}

/// 组装路由。
///
/// ⚠️ **前缀（`server.prefix`）在装配时施加**，不在每个 handler 里手写。
/// 子路径部署是很常见的（反代到 `/cloud-clipboard`），漏一个端点就是一个静默的 404。
pub fn router(state: Arc<AppState>) -> Router {
    let prefix = state.config.server.prefix.clone();
    let app = Router::new()
        .route("/server", get(handle_server))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state);

    if prefix.is_empty() {
        app
    } else {
        // 带前缀时，无前缀的路径**也**保留 —— 反代常把前缀剥掉再转发。
        Router::new().nest(&prefix, app.clone()).merge(app)
    }
}

/// `GET /server` —— 服务端能力与配置声明。
///
/// 形状**逐字对齐 Go `handler.go:120`**。别自己发明字段：
/// 这个响应是 SPA 的启动契约，多一个少一个都会让前端静默走错分支。
///
/// ⚠️ 三条容易写错、且写错了不会报错的语义：
/// 1. `auth`（要不要密码）与 `roomProtected`（这个房间要不要密码）**不是一个东西**：
///    只有带了 `?room=` 才会去算 `roomProtected`，否则它恒为 `false`。
/// 2. `authorized` 的初值是 `true` —— 「没传 room 且没有全局密码」时它**就是 true**，
///    哪怕一个凭据都没带。别顺手改成 `false`，那会让所有开放部署的 SPA 认为未授权。
/// 3. 没带 `?room=` 时，`auth` 只看**全局**密码。
async fn handle_server(
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

    let ws_scheme = match headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.eq_ignore_ascii_case("https") => "wss",
        _ => "ws",
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    Json(json!({
        "server": format!("{ws_scheme}://{host}{}/push", config.server.prefix),
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

/// 取凭据：`Authorization` 头优先，回落到 `?auth=`。
///
/// ⚠️ 和 Go `auth.go:117` 一致的两处细节，别「顺手优化」：
/// 1. 用 `split(' ')` 而不是 `splitn(2)` —— `"Bearer a b"` 会被当成**三个**部分，
///    于是整个头原样当凭据。换成 splitn 会变成凭据 `"a b"`，和 Go 分叉。
/// 2. 头存在但**不是** `Bearer` 格式时，整个头原样当凭据（不是返回空）——
///    那是给「直接把密码塞进 Authorization」的客户端留的路。
fn extract_auth_token(headers: &HeaderMap, query_auth: Option<&str>) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(name: header::HeaderName, value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(name, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn bearer_prefix_is_stripped() {
        let h = headers_with(header::AUTHORIZATION, "Bearer secret");
        assert_eq!(extract_auth_token(&h, None), "secret");
        let h = headers_with(header::AUTHORIZATION, "bearer secret");
        assert_eq!(extract_auth_token(&h, None), "secret", "大小写不敏感");
    }

    /// ⚠️ 三个部分时**整个头**当凭据 —— 这是 Go 的行为，不是 bug。
    #[test]
    fn extra_spaces_keep_the_whole_header() {
        let h = headers_with(header::AUTHORIZATION, "Bearer a b");
        assert_eq!(extract_auth_token(&h, None), "Bearer a b");
    }

    /// 非 Bearer 的头原样当凭据。
    #[test]
    fn non_bearer_header_is_used_as_is() {
        let h = headers_with(header::AUTHORIZATION, "justapassword");
        assert_eq!(extract_auth_token(&h, None), "justapassword");
    }

    #[test]
    fn query_auth_is_the_fallback() {
        let h = HeaderMap::new();
        assert_eq!(extract_auth_token(&h, Some("q")), "q");
        assert_eq!(extract_auth_token(&h, None), "");
    }
}
