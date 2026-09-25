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
pub mod files;
pub mod handlers;
pub mod state;
pub mod text_body;
pub mod user_agent;
pub mod ws;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
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
    let static_dir = state.static_dir.clone();

    // ⚠️ 每个限定了方法的端点都挂 `.fallback(...)`：axum 内置的 405 是**空 body**，
    // 而契约里写着「错误响应恒 `{code,error,message}`」。Go 那边这几个 handler 都显式返回
    // JSON 405 —— 不挂就是一处**静默的形状差异**。
    // ⚠️ 文案按方法分三种，别合并（Go 就是这么分的，见 handlers.rs）。
    let only_get = handlers::only_get;
    let only_post = handlers::only_post;
    let mna = handlers::method_not_allowed;

    let app = Router::new()
        .route("/server", get(handlers::server))
        // ⚠️ `/healthz` 是**这个实现自己加的**便利端点，契约里没有它（Go 那边也没有）。
        // 加它是因为验收脚本需要一个「活着吗」的探活口，而 `/server` 会做鉴权计算、
        // 不适合当探活。**别把它写进 `docs/api.md`** —— 它不是契约的一部分。
        .route("/healthz", get(|| async { "ok" }))
        .route("/text", post(handlers::text).fallback(only_post))
        // ⚠️ WS 用 `get` 注册是刻意的：握手是一个 GET + `Upgrade` 头。
        .route("/push", get(ws::push))
        .route("/content/latest", get(handlers::latest_content))
        .route("/content/latest.json", get(handlers::latest_content))
        // ⚠️ Go 的 `handleContent` **没有方法检查** —— `POST /content/1` 会照 GET 的逻辑跑。
        // 这里收紧成只认 GET（同样的理由：读接口不该被非读方法触发）。
        .route("/content/{id}", get(handlers::content).fallback(only_get))
        .route(
            "/content/{id}/column",
            post(handlers::content_column).fallback(only_post),
        )
        .route("/rooms", get(handlers::rooms).fallback(only_get))
        // ── 文件 ──
        // ⚠️ `/upload/chunk`（初始化，body 是文件名）和 `/upload/chunk/{uuid}`（追加分片）
        // 是**两条不同的路由** —— Go 那边靠「路径后缀 + Content-Type 全等」在一个 handler 里
        // 分叉，这里交给路由表分，更清楚。
        .route("/upload", post(files::upload).fallback(only_post))
        .route("/upload/chunk", post(files::upload).fallback(only_post))
        .route(
            "/upload/chunk/{uuid}",
            post(files::chunk).fallback(only_post),
        )
        .route(
            "/upload/finish/{uuid}",
            post(files::finish).fallback(only_post),
        )
        // ⚠️ 带不带文件名都要能下 —— Go 只用 uuid，文件名那段是给人看的。
        // `/file/` 的 405 用的是通用文案（Go 的 `default` 分支）。
        .route(
            "/file/{uuid}",
            get(files::file).delete(files::file).fallback(mna),
        )
        .route(
            "/file/{uuid}/{name}",
            get(files::file).delete(files::file).fallback(mna),
        )
        // ⚠️ `/revoke/all` 必须能和 `/revoke/{id}` 并存：axum 里静态段优先，
        // 所以 `all` 不会被当成一个 id。Go 那边是靠注册顺序决定的。
        // ⚠️ `/revoke/*` **只认 POST**。
        //
        // Go 那边**没有方法检查** —— 任何方法（含 GET）都会真的执行撤销，于是浏览器
        // 直接访问 `/revoke/5` 就会删掉 5 号条目。Jonny 2026-09-25 拍板：**不用考虑老客户端**，
        // 按最佳实践来（破坏性操作必须是显式的 POST）。
        .route("/revoke/all", post(handlers::clear_all).fallback(only_post))
        .route("/revoke/{id}", post(handlers::revoke).fallback(only_post))
        // Go 的 CORS 是逐个端点手写的（`corsMiddleware` / `authMiddleware`），
        // 效果等价于「任意来源 + 常见方法/头」。这里用一层统一的代替 ——
        // 差别只是几个 Go 没挂 CORS 的端点上多几个头，没有客户端依赖「少了那些头」。
        .layer(CorsLayer::permissive())
        .with_state(state);

    // ── 前端静态资源 ────────────────────────────────────────────────────
    //
    // ⚠️ 挂在 `fallback_service` 上，也就是排在**所有 `.route()` 之后**：
    // API 路由优先，剩下的（`/`、`/assets/…`、前端路由）才落到这里。
    // 这和 Go 那边「先注册 API、最后 `mux.Handle(prefix+"/", spaStaticHandler)`」是同一个结构。
    //
    // ⚠️ **SPA 兜底必须落到 `index.html`**：前端是 history 路由，`/s/<token>` 这类深链
    // 直接访问（或刷新）时服务端得吐出同一份 HTML，否则刷新就 404。
    // 这也是为什么 SPA 和 API 必须**同源** —— 否则前端那些相对路径的请求全要配代理。
    let app = match static_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            app.fallback_service(
                tower_http::services::ServeDir::new(&dir)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
        }
        // 没配静态目录 = 这次部署只跑 API（Android 客户端连别人的服务端就是这种）。
        None => app,
    };

    if prefix.is_empty() {
        app
    } else {
        // 带前缀时，无前缀的路径**也**保留 —— 反代常把前缀剥掉再转发。
        Router::new().nest(&prefix, app.clone()).merge(app)
    }
}
