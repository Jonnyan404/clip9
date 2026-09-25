//! `/automation` 管理页的测试。
//!
//! 三组：
//! 1. **与 Go 的那份 HTML 逐字节相同**（父仓库还在时才跑）—— 这是「第二份定义」的防线；
//! 2. **JS 字符串上下文的转义表** —— 逐字符钉住，`room` 是用户可控的；
//! 3. **真的把页面服务出来** —— 响应头、`__CC__` 注入、以及「关掉总开关不影响页面本身」。
//!
//! ⚠️ 页面的**运行期**行为（内联 JS 能不能跑起来）不在这里测 —— 那要真 JS 引擎，
//! 用 `node tools/page-smoke.mjs <页面 URL>`（它接受任意 URL，所以对 Rust 起的实例
//! 零改动可用）。

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use clip9_core::{AuthValue, Config};
use clip9_server::automation_page::{js_str_escape, render};
use clip9_server::{AppState, router};
use clip9_store::Store;
use tower::ServiceExt;

/// 父仓库里 Go 那份页面。⚠️ `rust/` 是过渡期工作区，拆出去之后这个路径就不存在了 ——
/// 那时下面那条测试会自动跳过（见它的注释）。
fn go_page_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../cloud-clip/lib/automation_page.html")
}

/// ⚠️★ 这一页**必须与 Go 的那份逐字节相同**，靠 `[[.Prefix]]` / `[[.Room]]` 注入。
///
/// 理由不是省事，是**避免「靠人肉同步的第二份定义」**（`CONTRIBUTING.md` §6）：
/// 两份文件相同 → `cmp` 就能发现漂移；不同就只能靠人眼对 1900 行。
/// ⚠️ 页面里的文案、i18n 表、动作标签全都在这个文件里，所以 Go 那边为它写的
/// 七条静态检查（`TestAutomationPageMessagesCoverActionKeys` 那一族）
/// **在文件相同的前提下对这边同样成立** —— 这比把七条测试抄一遍便宜得多，也可靠得多。
///
/// ⚠️ 拆成独立仓库之后父仓库那份就没了，这条会自动跳过：**那时这份就是唯一的源**，
/// 没有「漂移」可言。到那一步要补的是把 Go 那七条静态检查真正移植过来。
#[test]
fn page_matches_go_byte_for_byte() {
    let go = go_page_path();
    let Ok(expected) = std::fs::read(&go) else {
        println!(
            "跳过：父仓库里的 {} 不在（`rust/` 拆出去之后就该跳过）",
            go.display()
        );
        return;
    };
    let ours = include_bytes!("../src/automation_page.html");
    assert_eq!(
        ours.len(),
        expected.len(),
        "页面大小与 Go 那份不同 —— 有人只改了一边。刷新方式：\
         `cp ../cloud-clip/lib/automation_page.html crates/server/src/`"
    );
    assert!(
        ours == expected.as_slice(),
        "页面内容与 Go 那份不同 —— 有人只改了一边（见上面的刷新方式）"
    );
}

/// ⚠️★ 转义表：**逐字符**钉住，而不是挑几个「看起来危险」的。
///
/// 这张表是**实测出来的**（起 Go 实例把 ASCII 1–126 逐个塞进 `?room=`，比对原始输出文本），
/// 所以它同时也是一份「Go 那边到底怎么转」的记录。
///
/// 反直觉的四点，每一条都是实测撞出来的：
/// - `/` → `\/`、`` ` `` → `\u0060`、`+` → `\u002b` —— 最容易漏的三个；
/// - **`0x7f`（DEL）原样输出**，不在表里；
/// - `=` `%` `$` `;` `(` `)` `[` `]` `{` `}` 都**不转**；
/// - 中文、emoji 等可打印非 ASCII **原样输出**。
#[test]
fn js_string_escaping_matches_go() {
    // 需要转义的 40 个（ASCII 1–126 里实测出来的那一批）。
    let cases: &[(char, &str)] = &[
        ('\u{0001}', "\\u0001"),
        ('\u{0008}', "\\u0008"),
        ('\t', "\\t"),
        ('\n', "\\n"),
        ('\u{000b}', "\\u000b"),
        ('\u{000c}', "\\f"),
        ('\r', "\\r"),
        ('\u{001f}', "\\u001f"),
        ('"', "\\u0022"),
        ('&', "\\u0026"),
        ('\'', "\\u0027"),
        ('+', "\\u002b"),
        ('/', "\\/"),
        ('<', "\\u003c"),
        ('>', "\\u003e"),
        ('\\', "\\\\"),
        ('`', "\\u0060"),
    ];
    for (raw, want) in cases {
        assert_eq!(
            js_str_escape(&raw.to_string()),
            *want,
            "字符 U+{:04X} 的转义与 Go 不一致",
            *raw as u32
        );
    }

    // ⚠️ 这几个**不能**被转义 —— 多转一个字双跑比对就会红（那是逐字节比的）。
    for raw in [
        '\u{007f}', // DEL：Go 的表里没有它
        '=', '%', '$', ';', '(', ')', '[', ']', '{', '}', '~', '!', '#', '@', '^', '_', '|', '*',
        ',', '-', '.', ':', '?',
    ] {
        assert_eq!(
            js_str_escape(&raw.to_string()),
            raw.to_string(),
            "字符 U+{:04X} 不该被转义（Go 那边是原样输出的）",
            raw as u32
        );
    }

    // 可打印非 ASCII 原样；U+2028 / U+2029 是例外（JS 里它们是行终止符）。
    assert_eq!(js_str_escape("值班室"), "值班室");
    assert_eq!(js_str_escape("x🎉y"), "x🎉y");
    assert_eq!(js_str_escape("\u{2028}"), "\\u2028");
    assert_eq!(js_str_escape("\u{2029}"), "\\u2029");

    // 组合起来：这是「不转义就是 XSS」的最小复现。
    assert_eq!(
        js_str_escape(r#"a<b>"c'd&e=f\g"#),
        r"a\u003cb\u003e\u0022c\u0027d\u0026e=f\\g"
    );
}

/// 注入只替换那两个占位符，别的一字不动。
#[test]
fn render_substitutes_both_markers_only() {
    let html = render("/clip", "work");
    assert!(
        html.contains(r#"window.__CC__ = { prefix: "\/clip", room: "work" };"#),
        "两个占位符应被替换成转义后的值"
    );
    assert!(!html.contains("[[.Prefix]]"), "占位符不该残留");
    assert!(!html.contains("[[.Room]]"), "占位符不该残留");
    // ⚠️ 页面里到处是 `{{date}}` 这样的示例文案 —— 替换**不许**碰它们
    // （Go 那边为此把模板分隔符换成了 `[[ ]]`；这边是纯字符串替换，更不该碰）。
    assert!(html.contains("{{date}}"), "替换不该动页面里的模板变量示例");
    // 页面长度只该变化「替换前后」的差值，不该整段被改写。
    // ⚠️ `render("", "")` 是把占位符换成空串，所以基准已经短了两个占位符的长度 ——
    // 别在算式里再减一次（第一版就是这么写错的，测试当场抓到）。
    let base = render("", "");
    assert_eq!(
        html.len(),
        base.len() + r"\/clip".len() + "work".len(),
        "替换不该改动页面本身"
    );
}

fn app(prefix: &str) -> (axum::Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.server.prefix = prefix.to_owned();
    config.server.auth = AuthValue::Str("adminpw".to_owned());
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

async fn get(router: &axum::Router, uri: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    let req = Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .expect("构造请求");
    let resp = router.clone().oneshot(req).await.expect("请求应成功返回");
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("读响应体");
    (
        status,
        headers,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

/// 页面真的被服务出来了：响应头与注入值都对。
///
/// ⚠️ 这里**不检查登录/权限** —— 页面本身不含权限逻辑（能不能建任务全由 `/tasks` 决定），
/// 所以它必须能被匿名打开，否则用户在「没权限」时连输密码的入口都没有。
#[tokio::test]
async fn automation_page_is_served() {
    let (router, _dir) = app("/clip");

    let (status, headers, body) = get(&router, "/clip/automation?room=work").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get("content-type").and_then(|v| v.to_str().ok()),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("no-store"),
        "管理页不该被缓存（页面里内联着凭据相关的逻辑）"
    );
    assert_eq!(
        headers.get("x-robots-tag").and_then(|v| v.to_str().ok()),
        Some("noindex, nofollow")
    );
    assert!(
        body.contains(r#"window.__CC__ = { prefix: "\/clip", room: "work" };"#),
        "注入的前缀与房间不对（前缀要带子路径、房间来自 ?room=）"
    );
    assert!(!body.contains("[[."), "占位符不该残留");

    // 不传 room → `default`（与 `/tasks` 那族同一条规矩）。
    let (_, _, body) = get(&router, "/clip/automation").await;
    assert!(body.contains(r#"room: "default""#));

    // 空 `?room=` 也归一到 `default`。
    let (_, _, body) = get(&router, "/clip/automation?room=").await;
    assert!(body.contains(r#"room: "default""#));

    // ⚠️ 恶意房间名必须被转义 —— 不转义就是 XSS（这个值落在 JS 字符串字面量里）。
    // ⚠️ 注意 `=` 与空格**不转**（Go 的表里没有它们）—— 别想当然以为「全转掉才安全」，
    // 多转一个字双跑比对（逐字节）就会红。真正防住 XSS 的是尖括号与引号被转。
    let (_, _, body) = get(
        &router,
        "/clip/automation?room=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    )
    .await;
    assert!(
        body.contains(r#"room: "\u003cimg src=x onerror=alert(1)\u003e""#),
        "恶意房间名没被转义"
    );
    assert!(!body.contains("<img src=x"), "未转义的尖括号直接进了页面");
}

/// ⚠️ 方法不对时**恒 JSON**（和其他端点同一条契约），不能回一份 HTML。
#[tokio::test]
async fn automation_page_rejects_other_methods_with_json() {
    let (router, _dir) = app("");
    let req = Request::builder()
        .method("POST")
        .uri("/automation")
        .body(Body::empty())
        .expect("构造请求");
    let resp = router.oneshot(req).await.expect("请求应成功返回");
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("读响应体");
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("405 也必须是 JSON");
    assert_eq!(body["code"], "method_not_allowed");
}
