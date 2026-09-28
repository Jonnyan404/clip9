//! CORS 的**端到端**测试（走真 Router）。
//!
//! ⚠️ 为什么单测（`cors::tests`）不够：那些只验「判定函数」。而这里要验的是
//! **那一层真的接上去了** —— 把 `.layer(cors::cors())` 删掉、或者写成别的层，
//! 判定函数照样全绿，而线上表现是「桌面端一条接口都调不通」或者「`*` 又回来了」。
//!
//! ⚠️★ 这几条同时是**安全回归测试**：`Access-Control-Allow-Origin: *` 曾让
//! 「用户访问的任意网站」都能读走本机开放房间的内容（`cors` 模块文档里有完整理由）。
//!
//! ⚠️ 测试函数必须是 `#[tokio::test]`：`AppState::new` 会**启动调度器**，
//! 那需要 tokio 运行时 —— 在运行时外面调它，报的是一句
//! 「there is no reactor running」，和 CORS 毫无关系。

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode, header};
use clip9_core::Config;
use clip9_server::{AppState, router};
use clip9_store::Store;
use tower::ServiceExt;

fn app() -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

/// 发一个请求，返回（状态码，响应头）。
async fn probe(router: &Router, origin: &str, preflight: bool) -> (StatusCode, HeaderMap) {
    let mut req = Request::builder()
        .uri("/server")
        .header(header::ORIGIN, origin);
    req = if preflight {
        req.method("OPTIONS")
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "authorization")
    } else {
        req.method("GET")
    };
    let resp = router
        .clone()
        .oneshot(req.body(Body::empty()).expect("构造请求"))
        .await
        .expect("请求应返回");
    (resp.status(), resp.headers().clone())
}

fn allow_origin(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        .and_then(|v| v.to_str().ok())
}

/// ⚠️★ 桌面客户端的来源**必须**拿到放行头 —— 实测它就是 `tauri://localhost`。
#[tokio::test]
async fn the_desktop_origin_gets_the_allow_header() {
    let (router, _dir) = app();
    let (status, headers) = probe(&router, "tauri://localhost", false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        allow_origin(&headers),
        Some("tauri://localhost"),
        "桌面端跨源要能读到响应"
    );
}

/// ⚠️★ **本机开发**（vite dev）也要能过 —— 否则改窄 CORS 就把开发流程弄断了。
#[tokio::test]
async fn a_dev_server_origin_gets_the_allow_header() {
    let (router, _dir) = app();
    let (_, headers) = probe(&router, "http://localhost:5173", false).await;
    assert_eq!(allow_origin(&headers), Some("http://localhost:5173"));
}

/// ⚠️★ **安全回归**：任意网站拿不到放行头。
///
/// 这条要是红了 —— 也就是这里又出现了 `*` 或那个来源 —— 意味着
/// 「用户随手点开的一个网页能把本机剪贴板历史整段读走」又回来了。
#[tokio::test]
async fn an_arbitrary_website_gets_nothing() {
    let (router, _dir) = app();
    for origin in [
        "https://evil.example",
        "http://evil.example:9501",
        "null",
        // 「看着像回环」的两种写法也要挡住。
        "http://localhost.evil.example",
        "http://192.168.1.10:9501",
    ] {
        let (_, headers) = probe(&router, origin, false).await;
        assert_eq!(
            allow_origin(&headers),
            None,
            "{origin} 拿到了放行头 —— 任意网站能读本机服务端了"
        );
    }
}

/// 预检（`OPTIONS`）要与实际请求**一致**：放行的才放行，且要答上方法/头 + `Vary`。
///
/// ⚠️ 桌面的上行带 `Authorization` —— 那个自定义头**一定会**触发预检，
/// 所以预检这条路不通的话，「能读到 /server」是个假象（真上行一条都发不出去）。
#[tokio::test]
async fn preflight_matches_the_actual_request() {
    let (router, _dir) = app();

    let (status, headers) = probe(&router, "tauri://localhost", true).await;
    assert!(status.is_success(), "预检应当成功，得到 {status}");
    assert_eq!(allow_origin(&headers), Some("tauri://localhost"));

    // 被拒的来源，预检也不给放行头。
    let (_, headers) = probe(&router, "https://evil.example", true).await;
    assert_eq!(allow_origin(&headers), None, "被拒的来源不该拿到预检放行头");

    // 预检的响应要带上允许的方法与头（否则浏览器判定预检失败）。
    let (_, headers) = probe(&router, "tauri://localhost", true).await;
    let methods = headers
        .get(header::ACCESS_CONTROL_ALLOW_METHODS)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(methods.contains("POST"), "允许的方法里要有 POST：{methods}");
    let allow_headers = headers
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        allow_headers.to_ascii_lowercase().contains("authorization"),
        "允许的头里要有 authorization：{allow_headers}"
    );
    // ⚠️ 响应随 `Origin` 变，就必须告诉缓存 —— 否则中间层会把
    // 「给被拒来源的那份（没有放行头）」缓存下来，或者反过来。
    let vary = headers
        .get(header::VARY)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        vary.to_ascii_lowercase().contains("origin"),
        "必须带 `Vary: Origin`：{vary:?}"
    );
}
