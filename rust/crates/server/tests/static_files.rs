//! 前端静态资源的**端到端**测试：真的 Router、真的产物字节。
//!
//! 用例全按**桌面端那份的形状**来装（`static_dir = None`、一个 `-static` 都不传）——
//! 那才是默认部署，也是唯一值得钉的那种（2026-09-28 那个空白 404 就出在这个形状上）。
//!
//! ⚠️ 另一半是**语义**：未知路径只有「想要一份网页」才回外壳，其它一律 404（Go 的 `wantsHTML`）。
//! 少了那道闸，`GET /api/typo` + `Accept: application/json` 会拿到**一份 200 的 HTML** ——
//! 本项目记过的「下载下来是个 html」老坑，而且不报错。

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use clip9_core::Config;
use clip9_server::{AppState, router};
use clip9_store::Store;
use tower::ServiceExt;

/// 请求体的读取上限。⚠️ 产物里有 1 MiB 级的 bundle，别用默认那一档（会把好响应读成失败）。
const BODY_LIMIT: usize = 16 << 20;

fn peer() -> SocketAddr {
    "127.0.0.1:5555".parse().expect("测试用对端地址")
}

/// **桌面端自带那份的形状**：没有 `-static`、没有外部静态目录。
///
/// ⚠️ 前缀可给：`nest(&prefix, …)` 之后兜底还能不能拿到 `State` 是这层最容易坏的地方
/// （挂了就会落到 axum 默认的 404，而不是外壳）。
fn bundled_app(prefix: &str) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.server.prefix = prefix.to_owned();
    // ⚠️ `static_dir` 是 `None` —— 这一条就是「桌面端没传 -static」。
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

/// 带外部静态目录（`-static` 那条路）。
fn app_with_dir(index_html: &str) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    let static_dir = dir.path().join("static");
    std::fs::create_dir_all(&static_dir).expect("建静态目录");
    std::fs::write(static_dir.join("index.html"), index_html).expect("写 index.html");
    let state = AppState::new(config, store, Some(static_dir));
    (router(state), dir)
}

/// 发一条 GET，`accept` 为 `None` 时**完全不发 Accept 头**（curl 的默认行为）。
async fn get(app: &Router, uri: &str, accept: Option<&str>) -> (StatusCode, String, String) {
    let mut builder = Request::builder().uri(uri).method("GET");
    if let Some(value) = accept {
        builder = builder.header(header::ACCEPT, value);
    }
    let mut request = builder.body(Body::empty()).expect("造请求");
    request.extensions_mut().insert(ConnectInfo(peer()));
    let response = app.clone().oneshot(request).await.expect("路由返回了错误");
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = axum::body::to_bytes(response.into_body(), BODY_LIMIT)
        .await
        .expect("读响应体");
    (
        status,
        content_type,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

/// 仓库里那份产物的路径。
fn static_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("static")
}

/// 外壳里引用的那个入口 bundle（`./assets/index-<hash>.js` → `assets/index-<hash>.js`）。
///
/// ⚠️ 不写死名字：前端一改，hash 就变，而写死的名字会把「产物换了」误报成「服务端坏了」。
fn entry_bundle() -> String {
    let html = std::fs::read_to_string(static_dir().join("index.html")).expect("读外壳");
    html.split("src=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .map(|src| src.trim_start_matches("./").to_owned())
        .expect("外壳里应该有入口 script")
}

/// ⚠️★ 这一条就是那个 404 的回归测试：**一个 `-static` 都不给，根路径也得有界面**。
#[tokio::test]
async fn the_bundled_server_serves_the_front_end_without_any_flag() {
    let (app, _dir) = bundled_app("");
    let (status, content_type, body) = get(&app, "/", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK, "根路径不该是 404：{body:.80}");
    assert_eq!(content_type, "text/html; charset=utf-8");
    assert!(body.contains("id=\"app\""), "得是那份真的外壳：{body:.80}");
    // ⚠️ `<base>` 的注入不能因为「来源变了」就丢 —— 深链下相对地址全靠它。
    assert!(body.contains("<base href=\"/\">"), "外壳该被注入 <base>");
}

/// 刷新一个前端路由（`/board` 这类深链）必须拿到同一份外壳，否则 F5 就 404。
///
/// ⚠️ 例子别挑 `/rooms` —— 那是**接口**（`GET /rooms`），没开房间列表时回 **403**。
/// 前端路由与接口共用同一个命名空间（`vite.config.js` 的 `navigateFallbackDenylist`
/// 就是那张「哪些前缀归接口」的清单），所以挑例子要挑接口没占的。
/// ⚠️ 这条测试第一版就是这么栽的（用 `/rooms`，拿到 403）。
#[tokio::test]
async fn a_front_end_deep_link_gets_the_shell() {
    let (app, _dir) = bundled_app("");
    let (status, content_type, body) = get(&app, "/board", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "text/html; charset=utf-8");
    assert!(body.contains("id=\"app\""), "{body:.80}");
}

/// 真产物照发，MIME 按扩展名给。
#[tokio::test]
async fn real_products_are_served_with_their_mime() {
    let (app, _dir) = bundled_app("");
    // 名字稳定的那一个。
    let (status, content_type, body) = get(&app, "/favicon.svg", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "image/svg+xml; charset=utf-8");
    assert!(body.contains("<svg"), "{body:.80}");

    // 带 hash 的入口 bundle：**字节要真的对**（不是外壳被兜底顶上来）。
    let entry = entry_bundle();
    let (status, content_type, body) = get(&app, &format!("/{entry}"), None).await;
    assert_eq!(status, StatusCode::OK, "{entry} 发不出来");
    assert_eq!(content_type, "text/javascript; charset=utf-8");
    let on_disk = std::fs::read(static_dir().join(&entry)).expect("读产物");
    assert_eq!(
        body.len(),
        on_disk.len(),
        "发出来的字节数该与仓库里那份一致"
    );
    assert!(body.contains("/automation"), "得是真的入口 bundle");
}

/// ⚠️★ **这一条是这次改动的核心**：不存在的接口路径**不许**被回成一份 200 的 HTML。
///
/// 改动前这里是 `200 text/html`（`ServeDir::fallback(ServeFile)` 没有那道闸），
/// 而那意味着任何拼错的 / 还没实现的接口都会给客户端一份网页 —— 不报错、极难查。
#[tokio::test]
async fn an_unknown_api_path_is_not_answered_with_a_page() {
    let (app, _dir) = bundled_app("");
    for accept in ["application/json", "image/png", "application/javascript"] {
        let (status, _content_type, body) = get(&app, "/api/typo", Some(accept)).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "Accept: {accept} 打不存在的路径该是 404，不是一份 HTML：{body:.80}"
        );
    }
    // ⚠️ 「想要网页」的那几种照旧回外壳（含**完全不发 Accept** —— 那是 curl 的默认行为，
    // 也是抓取程序那一档）。这不是漏网，是 Go 的 `wantsHTML` 明确要的。
    for accept in [
        "text/html,application/xhtml+xml,*/*;q=0.8",
        "*/*",
        "text/*",
        "",
    ] {
        let (status, content_type, _body) = get(&app, "/nope", Some(accept)).await;
        assert_eq!(status, StatusCode::OK, "Accept: {accept:?} 该回外壳");
        assert_eq!(content_type, "text/html; charset=utf-8");
    }
    // ⚠️ 非 GET/HEAD 一律 404（不是 405，也不是外壳）。
    // ⚠️★ 两条都要发：**不存在的路径**与**真实存在的产物** —— 只发前者的话这道闸**打不红**
    // （后面 `wants_html` 也会拦下它），而少了它 `POST /favicon.svg` 会真的把文件发回去。
    for uri in ["/nope", "/favicon.svg"] {
        let mut request = Request::builder()
            .uri(uri)
            .method("POST")
            .body(Body::empty())
            .expect("造请求");
        request.extensions_mut().insert(ConnectInfo(peer()));
        let response = app.clone().oneshot(request).await.expect("路由");
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "POST {uri} 不该拿到 200"
        );
    }
}

/// 接口永远优先于兜底 —— 挂了静态资源之后 `/server` 还得是 JSON。
///
/// ⚠️ ★ 这一条的牙是**防将来重构**，不是防当前的代码：它钉住的「接口优先」是
/// **axum `fallback` 的语义**（兜底只看没被任何 `.route()` 接住的请求）——
/// 所以**改不出**一个能让它变红的当前代码变异（试过：让兜底恒挂、让 `has_source` 恒真，
/// 它都照样绿）。真正的风险是有人把兜底改成一条 `route("/{*path}", …)`，
/// 那时 `/server` 会被外壳吞掉、而**别的测试一条都不会红**（每条接口自己的用例都还在）。
/// 这种情况**照写**：判据的目的是拦住未来的那个改动，而不是拦住现在的自己。
#[tokio::test]
async fn the_api_still_wins_over_the_fallback() {
    let (app, _dir) = bundled_app("");
    // ⚠️ 故意发一个「想要网页」的 Accept：兜底**也不能**在这种情况下抢答接口路径。
    let (status, content_type, body) = get(&app, "/server", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.starts_with("application/json"),
        "{content_type}"
    );
    assert!(body.contains("\"server\""), "{body:.120}");
}

/// 子路径部署（`server.prefix`）：`nest` 之后兜底还得在，而且 `<base>` 要跟着前缀。
///
/// ⚠️ 这条钉的是**接线**：`fallback` 挂在 `with_state` 之前、`nest` 之后还取得到状态。
/// 出了问题的症状是「带前缀部署时根路径 404」，而那与「服务端没起来」长得一样。
#[tokio::test]
async fn a_sub_path_deployment_still_serves_the_shell() {
    let (app, _dir) = bundled_app("/clip");
    let (status, _content_type, body) = get(&app, "/clip/", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK, "{body:.120}");
    assert!(body.contains("<base href=\"/clip/\">"), "前缀要进 <base>");
    // 反代常把前缀剥掉再转发 —— 无前缀的路径也留着（与改动前一致）。
    let (status, _content_type, _body) = get(&app, "/", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK);
}

/// `-static` 仍然盖得住内嵌那一份 —— 那是「改了 dist 不用重编」的整条路。
#[tokio::test]
async fn an_external_dir_overrides_the_embedded_copy() {
    let (app, _dir) = app_with_dir("<html><head></head><body>外部那一份</body></html>");
    let (status, content_type, body) = get(&app, "/", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "text/html; charset=utf-8");
    assert!(body.contains("外部那一份"), "该读到外部目录：{body:.80}");
    assert!(!body.contains("id=\"app\""), "不该混进内嵌那一份");
}

/// `/s/<token>` 的落地页现在也能拿到外壳了（内嵌那一份同样算「有前端」）。
///
/// ⚠️ 改动前只有**外部目录**能提供外壳 → 桌面端那份的分享页**注入不进去**，
/// 只能退回通用卡片：症状是「分享出去的链接没有摘要」，而它不报错。
#[tokio::test]
async fn the_share_landing_page_gets_the_shell_from_the_embedded_copy() {
    let (app, _dir) = bundled_app("");
    let (status, content_type, body) = get(&app, "/s/nonsense", Some("text/html")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "text/html; charset=utf-8");
    assert!(
        body.contains("id=\"app\""),
        "分享页该是注入过卡片的外壳，而不是通用卡片：{body:.160}"
    );
    assert!(body.contains("<base href=\"/\">"), "外壳要注入 <base>");
}

/// ⚠️★ 仓库里那份 `rust/crates/server/static/` **不许比 `web-vue3/dist` 旧**。
///
/// 为什么值得一条测试（照 Go 的 `TestEmbeddedSpaCarriesAutomationEntry` 写）：
/// 正式构建用的是**编进二进制的这一份**，而前端改完只落在 `web-vue3/dist` 里 ——
/// 要显式跑一次同步才会过去。这个「忘了同步」是**无症状**的：
/// 编译完全成功、跑起来也正常，只是界面永远停在上一版。用户看到的现象是
/// 「界面里根本没有这个功能」，而代码明明写好了。
///
/// ⚠️ 源目录不在就**跳过**（clip9 是独立仓库，单独 clone 出来没有它）——
/// 但要把话说给跑测试的人听，别静默地变成「这条永远绿」。
#[test]
fn the_shipped_copy_matches_the_front_end_build() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web-vue3/dist");
    if !source.join("index.html").is_file() {
        eprintln!(
            "跳过 `the_shipped_copy_matches_the_front_end_build`：{} 不在。\n\
             \x20 这是**独立 clone** 的正常情况（那一份属于云剪贴板主仓库）。\n\
             \x20 要真跑这条，得在有 web-vue3 的构建产物的目录里跑。",
            source.display()
        );
        return;
    }
    let shipped = static_dir();

    let mut source_files = relative_files(&source);
    let mut shipped_files = relative_files(&shipped);
    source_files.sort();
    shipped_files.sort();
    assert_eq!(
        shipped_files, source_files,
        "`rust/crates/server/static/` 与 `web-vue3/dist` 的文件清单不一致 —— \
         跑 `node tools/sync-web-assets.mjs` 同步（编进二进制的是前者）。"
    );

    // ⚠️ 清单一样还不够：**内容**也得一样（同名文件被换成旧版是这条要拦的主要情况）。
    for rel in &source_files {
        let want = std::fs::read(source.join(rel)).expect("读源");
        let got = std::fs::read(shipped.join(rel)).expect("读仓库里那份");
        assert!(
            want == got,
            "`static/{rel}` 与 `web-vue3/dist/{rel}` 内容不一致 —— 前端改过而这份没同步。\n\
             \x20 修法：node tools/sync-web-assets.mjs"
        );
    }
}

/// 目录下的所有普通文件（相对路径，`/` 分隔），跳过 `.DS_Store`。
fn relative_files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name() == ".DS_Store" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(dir) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out
}
