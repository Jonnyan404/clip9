//! 请求体上限的**端到端**测试（走真 Router）。
//!
//! ⚠️ 为什么 `handlers::tests` 里那些不够：它们**直接调 handler**，绕过了框架那一层。
//! 而这里要验的恰恰是「**框架没有抢在前面拒绝**」—— 只有走 Router 才碰得到
//! `DefaultBodyLimit`（axum 默认 **2 MiB**，而且它拒绝时返回的 body **不是契约形状**）。
//!
//! ⚠️★ 这几条钉的是一类**静默失效**：`text.limit` 是**用户可配**的，
//! 而框架默认的 2 MiB 与它无关。所以「把 `text.limit` 调到 8 MB」在超过 2 MiB 的那一刻
//! 就已经不生效了 —— 请求根本到不了 handler，客户端拿到的是一句**没有数字**的话
//!（`clip9-client/src/uploader.rs` 的模块文档明说「必须照抄服务端带数字那一句」）。
//! 完整推导见 `docs/specs/long-message-hardening.md` 的 S1。

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use clip9_core::Config;
use clip9_server::{AppState, router};
use clip9_store::Store;
use tower::ServiceExt;

/// 2 MiB + 1：**刚好越过框架默认的 2 MiB**。所有「抬上限」的用例都用它当水位，
/// 因为 2 MiB 这个数就是那个静默天花板本身。
const JUST_OVER_THE_FRAMEWORK_DEFAULT: usize = 2 * 1024 * 1024 + 1;

fn peer() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 41234))
}

/// 起一个真 Router。`text_limit` 就是服务端配置里的 `text.limit`。
fn app(text_limit: i64) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.text.limit = text_limit;
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, String) {
    let mut request = request;
    // ⚠️ 用到 `ConnectInfo` 的端点（`/text` / `/upload`）没有这个扩展会直接 500。
    request.extensions_mut().insert(ConnectInfo(peer()));
    let response = app.clone().oneshot(request).await.expect("路由返回了错误");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 << 10)
        .await
        .expect("读响应体");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn post_text(app: &Router, body: Vec<u8>) -> (StatusCode, String) {
    let request = Request::builder()
        .method("POST")
        .uri("/text?room=default")
        // ⚠️ `text/plain`（不带 charset 以外的花样）才会被当成「整个 body 就是正文」。
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .expect("构造请求");
    call(app, request).await
}

fn code_of(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("code")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| {
            format!(
                "<不是契约 JSON：{}>",
                body.chars().take(80).collect::<String>()
            )
        })
}

/// ⚠️ 这条**今天就是绿的**（正文远小于框架的 2 MiB，轮不到框架说话）。
/// 留着是因为它是「错误形状」的基准：后面两条要跟它**一模一样**。
#[tokio::test]
async fn a_body_over_the_configured_limit_gets_the_contract_error() {
    let (app, _dir) = app(4096);
    let (status, body) = post_text(&app, vec![b'x'; 5000]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(code_of(&body), "text_too_long");
    assert!(body.contains("4096"), "那句 message 必须带具体数字：{body}");
}

/// ⚠️★ **这条是 S1 的核心**：正文越过**框架默认的 2 MiB**、同时越过配置的 `text.limit`
/// → 必须先由**我们的** handler 回答（契约 JSON + 带数字的那句），
/// 而不是被框架先拒成一个**不是契约形状**的 413。
///
/// ⚠️ 显式设 `DefaultBodyLimit` **之前，这条是红的**。
#[tokio::test]
async fn a_body_over_two_mib_still_gets_the_contract_error() {
    let (app, _dir) = app(1024 * 1024);
    let (status, body) = post_text(&app, vec![b'x'; JUST_OVER_THE_FRAMEWORK_DEFAULT]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        code_of(&body),
        "text_too_long",
        "被框架先拦下时 body 不是契约形状 —— 客户端只能吐一句没有数字的话"
    );
    assert!(
        body.contains("1048576"),
        "那句 message 必须带具体数字：{body}"
    );
}

/// ⚠️★ 另一半：正文越过框架默认的 2 MiB、但**没**越过配置的 `text.limit`
/// → 必须**成功**。只验「错误形状」不够：把上限设小了、或者 `Bytes` 没接住，
/// 都会让「错误形状」那两条照样绿，而功能是坏的。
#[tokio::test]
async fn a_body_over_two_mib_below_the_configured_limit_is_accepted() {
    let (app, _dir) = app(4 * 1024 * 1024);
    let (status, body) = post_text(&app, vec![b'x'; JUST_OVER_THE_FRAMEWORK_DEFAULT]).await;
    assert!(
        status.is_success(),
        "配了 4 MiB 就该收得下 2 MiB，实际 {status}：{body}"
    );
}

/// ⚠️ 这条与 body 上限**无关**，放在这里是因为**这次改的正是这两条路由的装法**
///（`.layer()` 加在 `MethodRouter` 上）：`.layer()` 会不会把 `.fallback()` 挤掉，
/// 是这次改动**唯一说不准**的地方。而它错了的表现是「方法用错了却回了 200/404」——
/// 静默的，且契约里写着 405 必须带 `code`。
#[tokio::test]
async fn the_method_fallback_survives_the_body_limit_layer() {
    let (app, _dir) = app(4096);
    let request = Request::builder()
        .method("GET")
        .uri("/text?room=default")
        .body(Body::empty())
        .expect("构造请求");
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(code_of(&body), "method_not_allowed");
}

/// ⚠️ 单次上传同样不能卡在框架默认的 2 MiB 上 —— 否则桌面端发一个 3 MB 的文件
/// 就会拿到一个不是契约形状的 413（而 `file.limit` 缺省 256 MiB，客户端**根本不拦**）。
///
/// 这里不构造合法 multipart（那要拼边界），只用一个**够大但非法**的 body：
/// 只要它**走到了 handler**，回来的就是契约错误（`file_field_missing`），
/// 而不是框架那个 413。⚠️ 这正是「handler 有没有拿到 body」的判据。
#[tokio::test]
async fn a_single_shot_upload_over_two_mib_reaches_the_handler() {
    let (app, _dir) = app(4096);
    let request = Request::builder()
        .method("POST")
        .uri("/upload?room=default")
        .header(
            header::CONTENT_TYPE,
            "multipart/form-data; boundary=clip9-boundary",
        )
        .body(Body::from(vec![b'x'; JUST_OVER_THE_FRAMEWORK_DEFAULT]))
        .expect("构造请求");
    let (status, body) = call(&app, request).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "应当由 handler 回一句契约错误，而不是框架的 413：{body}"
    );
    assert_eq!(code_of(&body), "file_field_missing");
}
