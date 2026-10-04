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

/// ⚠️★ `GET /server` 要报出**它实际在发的那份前端是哪一版** —— 桌面端拿它认亲。
///
/// 少了这个字段的后果不是报错，而是宿主**认不出**端口上那个服务端：
/// 2026-09-30 的故障就是宿主复用了一个两天前留下的孤儿服务端，于是里头的界面是两天前那一份
/// （用户看到的是「这个功能怎么没了」，而代码一行没丢）。
///
/// ⚠️ 期望值**从磁盘上的外壳现读**，不写死：前端一改 build id 就变，
/// 写死的值会把「产物换了」误报成「服务端坏了」（`entry_bundle()` 就是同一个理由）。
#[tokio::test]
async fn the_server_reports_which_front_end_build_it_serves() {
    let (app, _dir) = bundled_app("");
    let (status, _content_type, body) = get(&app, "/server", Some("application/json")).await;
    assert_eq!(status, StatusCode::OK);
    let on_disk = std::fs::read_to_string(static_dir().join("index.html")).expect("读外壳");
    let want = on_disk
        .split("data-build-id=\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("仓库里那份外壳该带 data-build-id")
        .to_owned();
    let json: serde_json::Value = serde_json::from_str(&body).expect("该是 JSON");
    assert_eq!(
        json["staticBuild"].as_str(),
        Some(want.as_str()),
        "报的必须就是它在发的那一版：{body:.200}"
    );

    // ⚠️★ 另外两个方向也要 —— 只验上面那一条的话，一个「永远回内嵌那份」的实现照样绿。
    // 外部目录（`-static`）那一份报的必须是**它的**版本。
    let (app, _dir) = app_with_dir("<html data-build-id=\"dir00001\"></html>");
    let (_status, _content_type, body) = get(&app, "/server", Some("application/json")).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("该是 JSON");
    assert_eq!(
        json["staticBuild"].as_str(),
        Some("dir00001"),
        "`-static` 那一份说了算：{body:.200}"
    );
    // 认不出（外壳里没这个属性）→ **`null`，不编**。调用方把 `null` 当「认不出」。
    let (app, _dir) = app_with_dir("<html><body>手搓的目录</body></html>");
    let (_status, _content_type, body) = get(&app, "/server", Some("application/json")).await;
    let json: serde_json::Value = serde_json::from_str(&body).expect("该是 JSON");
    assert_eq!(
        json["staticBuild"],
        serde_json::Value::Null,
        "认不出就得是 null，不能编一个：{body:.200}"
    );
}

/// ⚠️★ 缓存头：**名字跨版本不变的那些必须每次校验**，只有带内容 hash 的 `assets/**` 可以长存。
///
/// 这条钉的是「换了二进制、界面还是上一版」那一类：`index.html` 与 `sw.js` 的名字
/// 跨版本不变，被缓存住之后**没有任何东西会把它换掉**，而症状是「功能没了」——
/// 与「代码没写」长得一模一样（2026-09-30 就按这个方向查了半天）。
///
/// ⚠️ 期望值是**字面量**，不从被测代码里取（不给它自我印证的机会）。
#[tokio::test]
async fn the_shell_and_the_service_worker_are_never_cached_blindly() {
    const FOREVER: &str = "public, max-age=31536000, immutable";
    const REVALIDATE: &str = "no-cache";
    let (app, _dir) = bundled_app("");

    // 外壳的三条路（根、带名字、深链）——**三条都得是每次校验**。
    for uri in ["/", "/index.html", "/board"] {
        assert_eq!(
            cache_control(&app, uri).await.as_deref(),
            Some(REVALIDATE),
            "{uri} 是外壳，名字跨版本不变，不许被盲目缓存"
        );
    }
    // ⚠️ `sw.js` 是这里最要命的一个：它自己就是「要不要换新前端」的开关。
    assert_eq!(
        cache_control(&app, "/sw.js").await.as_deref(),
        Some(REVALIDATE),
        "sw.js 被缓存住 = SW 永远不更新"
    );
    // 名字跨版本不变的那批（图标 / manifest / 预压缩的那几份）。
    for uri in ["/favicon.svg", "/manifest.webmanifest", "/index.html.br"] {
        assert_eq!(
            cache_control(&app, uri).await.as_deref(),
            Some(REVALIDATE),
            "{uri} 名字跨版本不变"
        );
    }
    // 带内容 hash 的那一档才可以长存。
    let entry = entry_bundle();
    assert_eq!(
        cache_control(&app, &format!("/{entry}")).await.as_deref(),
        Some(FOREVER),
        "{entry} 名字里带内容 hash，该可以长存"
    );

    // ⚠️ 外部目录（`-static`）那一份**同一条规则** —— 调试时更不该被缓存糊住。
    let (app, _dir) = app_with_dir("<html><head></head><body>外部那一份</body></html>");
    assert_eq!(
        cache_control(&app, "/").await.as_deref(),
        Some(REVALIDATE),
        "外部目录那一份的外壳也要每次校验"
    );
}

/// 发一条 GET，只要 `Cache-Control`（没有就给 `None`）。
async fn cache_control(app: &Router, uri: &str) -> Option<String> {
    let mut request = Request::builder()
        .uri(uri)
        .method("GET")
        .body(Body::empty())
        .expect("造请求");
    request.extensions_mut().insert(ConnectInfo(peer()));
    let response = app.clone().oneshot(request).await.expect("路由返回了错误");
    response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// ⚠️★ `rust/crates/server/static/` 必须与**它自己的同步清单**一致。
///
/// 为什么值得一条测试（照 Go 的 `TestEmbeddedSpaCarriesAutomationEntry` 写）：
/// 正式构建用的是**编进二进制的这一份**，而前端改完只落在 `web/dist` 里 ——
/// 要显式跑一次同步才会过去。这个「忘了同步」是**无症状**的：
/// 编译完全成功、跑起来也正常，只是界面永远停在上一版。用户看到的现象是
/// 「界面里根本没有这个功能」，而代码明明写好了。
///
/// ⚠️★ 但**逐字节比 `web/dist` 是做不到的**（这条测试原来就是那样，等于永远红）：
/// `web/vite.config.ts` 每次构建都注入一个**随机** build id（那是故意的 —— 让 PWA 缓存
/// 失效、并能核对线上跑的是哪次构建），而且入口 chunk 与 ShareView chunk 互相引用对方带 hash
/// 的文件名 —— **每次构建的文件名都不一样**。所以「前端改了却没同步」由
/// `tools/sync-web-assets.mjs --check` 用**源码指纹**来判（那才是 CI 上跑的一道）。
///
/// 这一条守的是另一半，而且**不需要 node、也不需要构建产物**：
/// `static/` 里的文件清单必须与「同步那一刻」记下来的一模一样 ——
/// 手工往目录里塞或删文件、同步脚本只跑了一半，都在这里红。
///
/// ⚠️ 清单是 `rust/crates/server/static.sync-manifest`（纯文本，格式见那个脚本的注释），
/// **不在 `static/` 里面** —— 放进去会被 `build.rs` 编进二进制并对外提供。
#[test]
fn the_shipped_copy_matches_its_sync_manifest() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("static.sync-manifest");
    let raw = std::fs::read_to_string(&manifest).unwrap_or_else(|err| {
        panic!(
            "读不到 {}：{err}\n\
             \x20 这一份静态产物不是 tools/sync-web-assets.mjs 同步出来的。\n\
             \x20 修法：node tools/sync-web-assets.mjs（然后重编 clip9-server）",
            manifest.display()
        )
    });

    // 第一条非注释行是 `source <指纹>`，其余每行一条相对路径。
    let body: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    let source = body
        .first()
        .and_then(|line| line.strip_prefix("source "))
        .unwrap_or_else(|| panic!("{} 的第一行不是 `source <指纹>`", manifest.display()));
    assert!(
        source.len() == 64 && source.chars().all(|c| c.is_ascii_hexdigit()),
        "源码指纹不像 sha256：{source:?}"
    );

    let mut recorded: Vec<String> = body[1..].iter().map(|line| (*line).to_owned()).collect();
    let dir = static_dir();
    let mut shipped = relative_files(&dir);
    recorded.sort();
    shipped.sort();

    assert_eq!(
        shipped,
        recorded,
        "`rust/crates/server/static/` 与 {} 记的清单不一致 —— \
         目录被手工动过，或者同步只跑了一半。\n\
         \x20 修法：node tools/sync-web-assets.mjs（然后重编 clip9-server）",
        manifest.display()
    );
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
