//! clip9 服务端（lib）。
//!
//! 这个 crate 同时是**两种东西**：
//!
//! - `lib`：组装好的 `axum::Router`，可以被任何外壳调用（Tauri 桌面端、Android JNI）；
//! - `bin`（`src/bin/clip9-server.rs`）：独立二进制，静态链接 musl，扔进 Docker / OpenWrt 就能跑。
//!
//! ⚠️ 之所以要拆成 lib + bin，是为了让服务端**不用起 Tauri 就能测** ——
//! 不然每次验证一个接口都要拉起一个桌面应用。
//!
//! # 模块分工
//!
//! | 模块 | 管什么 |
//! |---|---|
//! | [`error`] | 错误响应的**唯一**出口（恒 JSON，绝不按 Accept 分叉） |
//! | [`handlers`] | 各个 HTTP 处理器，形状逐字对齐 Go |
//! | [`text_body`] | `/text` 的三种请求体形态 + UTF-16 嗅探 |
//! | [`user_agent`] | UA → 设备信息（⚠️ 近似实现，见模块注释） |
//! | [`state`] | 共享状态 + 广播出口 |

pub mod error;
pub mod handlers;
pub mod state;
pub mod text_body;
pub mod user_agent;

use std::sync::Arc;

use axum::Router;
use axum::routing::{any, get, post};
use tower_http::cors::CorsLayer;

pub use state::AppState;

/// 组装路由。
///
/// ⚠️ **前缀（`server.prefix`）在装配时施加**，不在每个 handler 里手写。
/// 子路径部署很常见（反代到 `/cloud-clipboard`），漏一个端点就是一个静默的 404。
///
/// # 路由表（对应 Go `main.go:374` 起的那一串）
///
/// ```text
/// GET    /server                 服务端能力与配置声明
/// POST   /text                   发文本（?id= 是覆盖已有条目）
/// GET    /content/latest         最新一条（不传 room = 不限房间）
/// GET    /content/<id>           按 id 取一条（`.json` 后缀也认）
/// POST   /content/<id>/column    看板挪列
/// GET    /rooms                  房间列表
/// POST   /revoke/<id>            删一条
/// POST   /revoke/all             清空一个房间
/// ```
///
/// # 还没做的（P0 剩余）
///
/// - `/push`（WS）：握手推 config + 最近 N 条历史，以及 [`AppState::broadcast`] 的订阅端
/// - `/upload`、`/upload/chunk/`、`/upload/finish/`、`/file/`：文件三件套
/// - `/auth/token*`（P1）、`/share*` + `/s/`（P1）、`/tasks*` + `/automation`（P2）、`/myip`（P3）
pub fn router(state: Arc<AppState>) -> Router {
    let prefix = state.config.server.prefix.clone();

    let app = Router::new()
        .route("/server", get(handlers::server))
        // ⚠️ `/healthz` 是**这个实现自己加的**便利端点，契约里没有它（Go 那边也没有）。
        // 加它是因为验收脚本需要一个「活着吗」的探活口，而 `/server` 会做鉴权计算、
        // 不适合当探活。**别把它写进 `docs/api.md`** —— 它不是契约的一部分。
        .route("/healthz", get(|| async { "ok" }))
        .route("/text", post(handlers::text))
        .route("/content/latest", get(handlers::latest_content))
        .route("/content/latest.json", get(handlers::latest_content))
        .route("/content/{id}", get(handlers::content))
        .route("/content/{id}/column", post(handlers::content_column))
        .route("/rooms", get(handlers::rooms))
        // ⚠️ `/revoke/all` 必须能和 `/revoke/{id}` 并存：axum 里静态段优先，
        // 所以 `all` 不会被当成一个 id。Go 那边是靠注册顺序决定的。
        .route("/revoke/all", any(handlers::clear_all))
        .route("/revoke/{id}", any(handlers::revoke))
        // Go 的 CORS 是逐个端点手写的（`corsMiddleware` / `authMiddleware`），
        // 效果等价于「任意来源 + 常见方法/头」。这里用一层统一的代替 ——
        // 差别只是几个 Go 没挂 CORS 的端点上多几个头，没有客户端依赖「少了那些头」。
        .layer(CorsLayer::permissive())
        .with_state(state);

    if prefix.is_empty() {
        app
    } else {
        // 带前缀时，无前缀的路径**也**保留 —— 反代常把前缀剥掉再转发。
        Router::new().nest(&prefix, app.clone()).merge(app)
    }
}
