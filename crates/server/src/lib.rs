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
//! | [`auth_token`] | `/auth/token*`：用密码换会话令牌、续期 |
//! | [`share`] | 分享：签发 / 元信息 / 记录列表 / 打开上报 / 落地页 |
//! | [`share_card`] | 分享落地页的 OG 卡片内容（纯函数，好测） |
//! | [`spa_shell`] | SPA 外壳的读取与 `<base>` / OG 标签注入 |
//! | [`text_body`] | `/text` 的三种请求体形态 + UTF-16 嗅探 |
//! | [`user_agent`] | UA → 设备信息（⚠️ 近似实现，见模块注释） |
//! | [`state`] | 共享状态 + 广播出口 |

pub mod auth_gate;
pub mod auth_token;
pub mod automation;
pub mod automation_page;
pub mod error;
pub mod files;
pub mod handlers;
pub mod migrate;
pub mod room_cleanup;
pub mod scheduler;
pub mod share;
pub mod share_card;
pub mod spa_shell;
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
/// POST   /auth/token             用密码换会话令牌
/// POST   /auth/token/refresh     续期（不需要密码）
/// POST   /text                   发文本（?id= 是覆盖已有条目）
/// GET    /content/latest         最新一条（不传 room = 不限房间）
/// GET    /content/<id>           按 id 取一条（`.json` 后缀也认）
/// POST   /content/<id>/column    看板挪列
/// GET    /rooms                  房间列表
/// POST   /revoke/<id>            删一条
/// POST   /revoke/all             清空一个房间
/// POST   /share                  签发分享令牌
/// GET    /share?t=               分享页元信息（不消耗次数）
/// GET    /share/list             房间最近的分享记录
/// POST   /share/visit            分享页被真人打开时上报
/// GET    /s/<token>              分享页（注入 OG 卡片的那份外壳）
/// ```
///
/// # 还没做的
///
/// - `/tasks*` + `/automation`（P2 定时自动化）、`/myip`（P3）
///
/// ⚠️ `/s/<token>` 必须排在 `fallback_service` **之前**：它是前端路由的深链，
/// 而静态资源的兜底也会对未知路径回 `index.html` —— 谁先接住，谁说了算。
pub fn router(state: Arc<AppState>) -> Router {
    let prefix = state.config.server.prefix.clone();
    let static_dir = state.static_dir.clone();

    // ⚠️ 每个限定了方法的端点都挂 `.fallback(...)`：axum 内置的 405 是**空 body**，
    // 而契约里写着「错误响应恒 `{code,error,message}`」。Go 那边这几个 handler 都显式返回
    // JSON 405 —— 不挂就是一处**静默的形状差异**。
    // ⚠️ 文案按方法分三种，别合并（Go 就是这么分的，见 handlers.rs）。
    let only_get = handlers::only_get;
    let only_post = handlers::only_post;
    let only_get_post = handlers::only_get_post;
    let mna = handlers::method_not_allowed;

    let app = Router::new()
        .route("/server", get(handlers::server))
        // ⚠️ `/myip` 是**前端在用**的：聊天模式显示「你现在的 IP」。别当成边角端点删掉。
        // 只认 GET（同 `/content/{id}`：读接口不该被非读方法触发）。
        .route("/myip", get(handlers::my_ip).fallback(only_get))
        // ⚠️ `/healthz` 是**这个实现自己加的**便利端点，契约里没有它（Go 那边也没有）。
        // 加它是因为验收脚本需要一个「活着吗」的探活口，而 `/server` 会做鉴权计算、
        // 不适合当探活。**别把它写进 `docs/api.md`** —— 它不是契约的一部分。
        .route("/healthz", get(|| async { "ok" }))
        // ── 会话令牌（P1）──
        .route("/auth/token", post(auth_token::issue).fallback(only_post))
        .route(
            "/auth/token/refresh",
            post(auth_token::refresh).fallback(only_post),
        )
        // ── 分享（P1）──
        // ⚠️ `/share` **一条路径两种方法**：GET 是「分享页先看一眼」，POST 才是签发。
        // 挂成两条独立路径的话，分享页就只能去问 `/share/info` 之类的第二条路径 ——
        // 而契约里那条路是 `?t=`。
        .route(
            "/share",
            get(share::info)
                .head(share::info)
                .post(share::create)
                .fallback(only_post),
        )
        .route("/share/list", get(share::list).fallback(only_get))
        .route("/share/visit", post(share::visit).fallback(only_post))
        // ⚠️ 分享页本体。**必须排在静态资源兜底之前**，否则它会拿到一份没注入卡片的
        // 空白外壳（而那正是「抓取程序只看到域名」的那个 bug）。
        .route("/s/{token}", get(share::landing).fallback(only_get))
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
        // ── 定时自动化（P2）──
        .route(
            "/tasks",
            get(automation::task_list)
                .post(automation::tasks)
                .fallback(only_get_post),
        )
        // ⚠️ 静态段（preview / cron / rooms）必须排在 `/tasks/{id}` 之前 ——
        // Go 那边是靠 `splitTaskPath` 之后几个 `if id == "..."` 提前返回，
        // 这里交给路由表，静态段天然优先。
        .route(
            "/tasks/preview",
            post(automation::task_preview_item).fallback(only_post),
        )
        // ⚠️ Go 的 `handleCronCheck` **显式允许 GET 与 POST**（表达式一律从 query 取，
        // 两种方法等价）。只认 GET 会让一个照 Go 写的客户端拿到 405。
        .route(
            "/tasks/cron",
            get(automation::cron_check)
                .post(automation::cron_check)
                .fallback(only_get_post),
        )
        .route(
            "/tasks/rooms",
            get(automation::task_rooms).fallback(only_get),
        )
        // ⚠️★ 这三个端点的 405 **不是**一句「仅允许 POST」：Go 那边先按 id 找任务、
        // 找不到就 404，再看 (action, method) 分派。顺序反了会让 `GET /tasks/9999`
        // 从 404 变成 405，而客户端是靠码区分的。文案用 Go 那句（它列出了支持的动作）。
        .route(
            "/tasks/{id}",
            axum::routing::delete(automation::task_item).fallback(automation::task_item_fallback),
        )
        .route(
            "/tasks/{id}/run",
            post(automation::task_run_item).fallback(automation::task_unknown_action),
        )
        .route(
            "/tasks/{id}/toggle",
            post(automation::task_toggle_item).fallback(automation::task_unknown_action),
        )
        // ⚠️ 认不出的动作也要有条路由：没有它，`/tasks/<id>/whatever` 会落到**静态资源兜底**
        // （拿到一份 HTML、状态码 200），而「错误响应恒 JSON」是契约的一部分。
        // 静态段优先，所以 `/tasks/{id}/run` 不会被这条吞掉。
        .route(
            "/tasks/{id}/{action}",
            axum::routing::any(automation::task_unknown_action),
        )
        // ── 定时自动化：管理页（服务端渲染的独立页面）──
        // ⚠️ 排在静态资源兜底**之前**（和 `/s/{token}` 同理）：它有自己的 HTML，
        // 落到 SPA 外壳就变成一份没有表单的空白页。
        // ⚠️ 它**不做任何鉴权** —— 能不能建/改任务全由 `/tasks` 决定（页面里也是这么写的）。
        .route("/automation", get(automation_page::page).fallback(only_get))
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
