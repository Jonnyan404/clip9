//! `POST /convert/{uuid}` 的**端到端**测试。
//!
//! 跑的是**真的 Router**（`tower::ServiceExt::oneshot`，不起真端口）—— 覆盖路由、
//! 鉴权、过期判定、大小闸门、以及 `doc.rs` 那句中文错误怎么透出来。
//!
//! ⚠️ 为什么必须有这一层：`clip9-actions` 的 `doc.rs` 单测证明的是「字节 → Markdown」
//! 这件事本身对；**接进 HTTP 之后**另有一堆只在端到端才暴露的错 —— 路由没挂、
//! 鉴权走了比 `GET /file/` 更松的那条腿、大小闸门排在读盘**之后**（那就白设了）、
//! 过期文件照样转。这些一条都不会让 `doc.rs` 的单测变红。
//!
//! ⚠️ 断言写在**行为**上（谁能转、转出什么、拦在哪一步），不是「响应里有哪些字段」。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use clip9_core::{Config, RoomAuthEntry};
use clip9_protocol::File;
use clip9_server::state::now_secs;
use clip9_server::{AppState, router};
use clip9_store::Store;
use serde_json::Value;
use tower::ServiceExt;

/// 测试用对端地址。用函数而不是 `const`：`parse()` 不是 const。
fn peer() -> SocketAddr {
    "127.0.0.1:5555".parse().expect("测试用对端地址")
}

/// 一个装好的服务端：受保护房间 `work`（密码 `roompw`）+ 开放房间 `default`。
///
/// 连 `AppState` 一起返回：用例要**自己登记文件、自己往盘上写字节** ——
/// 走 `/upload` 会把「上传」那一整条链也拖进来，而这里要验的是**转换**。
fn app_with_state() -> (Router, Arc<AppState>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.server.room_list = true;
    config.server.room_auth.0.insert(
        "work".to_owned(),
        RoomAuthEntry {
            password: "roompw".to_owned(),
            ..RoomAuthEntry::default()
        },
    );

    let state = AppState::new(config, store, None);
    let router = router(state.clone());
    (router, state, dir)
}

/// 登记一条文件 + 把字节落到它该在的位置（磁盘上是**裸 uuid**，见 `files::stored_path`）。
///
/// `size` 单独给：有的用例要造出「登记说很大、盘上其实没有」的状态，
/// 用来证明大小闸门排在**读盘之前**。
fn put_file(state: &AppState, uuid: &str, name: &str, room: &str, bytes: &[u8], size: i64) {
    state
        .store
        .put_file(&File {
            name: name.to_owned(),
            uuid: uuid.to_owned(),
            size,
            upload_time: now_secs(),
            expire_time: 0,
            room: room.to_owned(),
        })
        .expect("登记文件");

    let path = std::path::Path::new(&state.config.server.storage_dir).join(uuid);
    std::fs::create_dir_all(path.parent().expect("存储目录")).expect("建存储目录");
    std::fs::write(path, bytes).expect("写文件字节");
}

/// 登记一条**已过期**的文件（`expire_time` 在过去）。
///
/// ⚠️ 只有带 feature 那一半用它（关掉 feature 时没有「过期文件」这条路径可验）——
/// 不加 cfg 会在 `--no-default-features` 的 clippy 里报 `dead_code`。
#[cfg(feature = "doc")]
fn put_expired_file(state: &AppState, uuid: &str, name: &str, room: &str) {
    state
        .store
        .put_file(&File {
            name: name.to_owned(),
            uuid: uuid.to_owned(),
            size: 16,
            upload_time: now_secs() - 7200,
            expire_time: now_secs() - 3600,
            room: room.to_owned(),
        })
        .expect("登记过期文件");
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, String) {
    let mut request = request;
    request.extensions_mut().insert(ConnectInfo(peer()));
    let response = app.clone().oneshot(request).await.expect("路由返回了错误");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 22)
        .await
        .expect("读响应体");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn post_convert(app: &Router, uuid: &str, query: &str) -> (StatusCode, String) {
    call(
        app,
        Request::builder()
            .method("POST")
            .uri(format!("/convert/{uuid}{query}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("响应不是 JSON: {text}（{e}）"))
}

// ── 这份测试的 CSV 样本 ────────────────────────────────────────────────
//
// ⚠️ 只用 CSV：它是唯一**不需要二进制 fixture** 的格式（就是逗号分隔的纯文本）。
// 往仓库里塞一份真的 docx 是另一件事 —— 而「docx 转得对不对」是 anydoc 自己的测试范围，
// 不是这边的。这里守的是**管线**。
const FRUIT_CSV: &[u8] = b"name,qty\napple,3\npear,5\n";

// ══ 带 `doc` feature 的那一半 ═══════════════════════════════════════════

/// 主链路：一条已上传的 CSV → Markdown 表格。
#[cfg(feature = "doc")]
#[tokio::test]
async fn an_uploaded_document_converts_to_markdown() {
    let (app, state, _dir) = app_with_state();
    put_file(&state, "f1", "fruit.csv", "default", FRUIT_CSV, 22);

    let (status, body) = post_convert(&app, "f1", "").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let value = json_of(&body);
    let markdown = value["markdown"].as_str().expect("要有 markdown");
    assert!(
        markdown.contains("apple"),
        "转出来的表里应当有数据：{markdown}"
    );
    assert!(markdown.contains('|'), "CSV 应当转成表格：{markdown}");
    assert_eq!(value["name"], "fruit.csv");
    // ⚠️ `chars` 是**字符数**不是字节数 —— 前端拿它决定「这份文档铺不铺得下」。
    assert_eq!(
        value["chars"].as_u64().unwrap(),
        markdown.chars().count() as u64
    );
}

/// ⚠️★ 鉴权必须与 `GET /file/` **完全一致**：转换读的就是这个文件的字节，
/// 凭据要求松一格，「转成 Markdown」就成了绕过分享限制读内容的侧门。
#[cfg(feature = "doc")]
#[tokio::test]
async fn a_protected_rooms_file_is_not_converted_without_credentials() {
    let (app, state, _dir) = app_with_state();
    put_file(&state, "f2", "secret.csv", "work", FRUIT_CSV, 22);

    let (status, body) = post_convert(&app, "f2", "").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(json_of(&body)["code"], "unauthorized");

    // 带上正确密码就放行 —— 否则上面那条断言只是在验「这个端点永远不通」。
    let (status, body) = post_convert(&app, "f2", "?auth=roompw").await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// ⚠️ 房间归属以**文件自己记录的**为准，不信客户端传的 `?room=`。
/// 传一个开放房间名不该把受保护房间的文件读出来。
#[cfg(feature = "doc")]
#[tokio::test]
async fn the_room_in_the_query_cannot_unlock_a_file_from_another_room() {
    let (app, state, _dir) = app_with_state();
    put_file(&state, "f3", "secret.csv", "work", FRUIT_CSV, 22);

    let (status, _body) = post_convert(&app, "f3", "?room=default").await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "文件登记在 work，?room=default 不该放行"
    );
}

/// 过期文件不转 —— 与 `GET /file/` 同一条判据（含同一个错误码）。
#[cfg(feature = "doc")]
#[tokio::test]
async fn an_expired_file_is_not_converted() {
    let (app, state, _dir) = app_with_state();
    put_expired_file(&state, "f4", "old.csv", "default");

    let (status, body) = post_convert(&app, "f4", "").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(json_of(&body)["code"], "file_expired");
}

/// 认不出的 uuid 是 404，不是 500。
#[cfg(feature = "doc")]
#[tokio::test]
async fn an_unknown_uuid_is_a_404() {
    let (app, _state, _dir) = app_with_state();
    let (status, body) = post_convert(&app, "nope", "").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(json_of(&body)["code"], "file_not_found");
}

/// ⚠️★ 大小闸门必须排在**读盘之前** —— 否则它一点用都没有（`tokio::fs::read`
/// 已经把整份读进内存了）。
///
/// 判据：**盘上根本没有这个文件**（只登记了 size），却要拿到 413 而不是 500。
/// 500 说明它去读了盘、读失败才报错 —— 那正是要防的那一步。
#[cfg(feature = "doc")]
#[tokio::test]
async fn an_oversized_file_is_refused_before_any_bytes_are_read() {
    let (app, state, _dir) = app_with_state();
    // 只登记，不落盘。
    state
        .store
        .put_file(&File {
            name: "huge.pdf".to_owned(),
            uuid: "f5".to_owned(),
            size: clip9_server::convert::CONVERT_INPUT_MAX + 1,
            upload_time: now_secs(),
            expire_time: 0,
            room: "default".to_owned(),
        })
        .expect("登记文件");

    let (status, body) = post_convert(&app, "f5", "").await;
    assert_eq!(
        status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "超限文件应当在读盘之前就被拒：{body}"
    );
    assert_eq!(json_of(&body)["code"], "file_too_large_to_convert");
    assert!(
        json_of(&body)["message"]
            .as_str()
            .unwrap_or_default()
            .contains("MiB"),
        "报错要说清上限是多少：{body}"
    );
}

/// 转不了的文件回 **400**（不是 500）—— 那是这份文档的问题，不是服务端坏了。
/// ⚠️ 而且 `message` 要是 `doc.rs` 那句**说清原因**的中文，不是一句「转换失败」。
#[cfg(feature = "doc")]
#[tokio::test]
async fn a_document_we_cannot_parse_gives_a_readable_reason() {
    let (app, state, _dir) = app_with_state();
    // 一个装成 PDF 的二进制头：内容嗅探认得出是 PDF，但结构是坏的。
    put_file(
        &state,
        "f6",
        "broken.pdf",
        "default",
        b"%PDF-1.7\nnot really a pdf",
        24,
    );

    let (status, body) = post_convert(&app, "f6", "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let value = json_of(&body);
    assert_eq!(value["code"], "convert_failed");
    let message = value["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("损坏") || message.contains("PDF"),
        "报错要说清是哪一类问题，而不是一句「转换失败」：{message}"
    );
}

/// ⚠️ 空文件也要回 400 + 说清原因（「文件是空的」），不能 500、也不能假装成功。
#[cfg(feature = "doc")]
#[tokio::test]
async fn an_empty_file_is_rejected_with_a_reason() {
    let (app, state, _dir) = app_with_state();
    put_file(&state, "f7", "empty.csv", "default", b"", 0);

    let (status, body) = post_convert(&app, "f7", "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        json_of(&body)["message"]
            .as_str()
            .unwrap_or_default()
            .contains("空"),
        "{body}"
    );
}

/// `GET /convert/{uuid}` 是 405（不是 404、也不是「照 POST 的逻辑跑」）。
///
/// ⚠️ 这条是**读接口不该被非 POST 触发**那条规矩的另一面：转换是**有成本**的操作
/// （CPU + 内存），挂成 GET 会让它被爬虫 / 预取器随手触发。
#[cfg(feature = "doc")]
#[tokio::test]
async fn a_get_on_the_convert_route_is_a_405() {
    let (app, _state, _dir) = app_with_state();
    let (status, body) = call(
        &app,
        Request::builder()
            .uri("/convert/f1")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
    assert_eq!(json_of(&body)["code"], "method_not_allowed");
}

/// ⚠️★ `images` 字段的**三态**必须能分辨：对象（读过、有/没有图）与 `null`（读不出来）。
///
/// 这里钉的是「没有图」那一态：CSV 能读出文档模型，所以 `images` 是**对象**、
/// `total` 是 `0`，**不是** `null`。把两者混起来，界面就会对一份满是插图的 PDF
/// 说「这份文档没有图片」—— 那是编造事实。
///
/// ⚠️ 「读不出来」那一态（PDF → `null`）**没有**在这里钉：那要一份真的 PDF fixture，
/// 而仓库里不放二进制样本（`doc.rs` 的注释写了理由）。那条路由真浏览器端到端验过
/// （见 `dev-docs/specs/whiteboard-anydoc-integration.md` 的实测表）。
#[cfg(feature = "doc")]
#[tokio::test]
async fn a_document_that_cannot_have_images_reports_an_empty_object_not_null() {
    let (app, state, _dir) = app_with_state();
    put_file(&state, "f8", "fruit.csv", "default", FRUIT_CSV, 22);

    let (status, body) = post_convert(&app, "f8", "").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let images = &json_of(&body)["images"];
    assert!(
        images.is_object(),
        "CSV 读得出文档模型，images 应当是对象而不是 null：{body}"
    );
    assert_eq!(images["total"], 0, "{body}");
    assert_eq!(images["truncated"], false, "{body}");
    assert_eq!(images["items"].as_array().map(Vec::len), Some(0), "{body}");
}

/// `/server` 要报出**这台部署到底带不带转换能力** —— 前端显隐入口的唯一判据。
#[cfg(feature = "doc")]
#[tokio::test]
async fn the_server_advertises_the_conversion_capability() {
    let (app, _state, _dir) = app_with_state();
    let (status, body) = call(
        &app,
        Request::builder()
            .uri("/server")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let convert = &json_of(&body)["convert"];
    assert_eq!(convert["enabled"], true, "{body}");
    let extensions = convert["extensions"].as_array().expect("要有 extensions");
    assert!(
        extensions.iter().any(|e| e == "docx") && extensions.iter().any(|e| e == "csv"),
        "扩展名列表要能喂给 <input accept>：{body}"
    );
}

// ══ 不带 `doc` feature 的那一半 ═════════════════════════════════════════

/// ⚠️★ 关掉 feature 时这条路径**压根不该存在** —— 404，而不是「500 说功能没编进来」。
///
/// 一个「永远失败」的端点是那种「看着有、其实没有」的假象：调用方分不清
/// 「这个部署没编这个功能」和「服务端出故障了」，于是会去查错方向。
#[cfg(not(feature = "doc"))]
#[tokio::test]
async fn the_route_does_not_exist_without_the_feature() {
    let (app, state, _dir) = app_with_state();
    put_file(&state, "f1", "fruit.csv", "default", FRUIT_CSV, 22);

    let (status, _body) = post_convert(&app, "f1", "").await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "没带 doc feature 时这条路径不该被注册"
    );
}

/// 关掉 feature 时 `/server` 仍然要回**完整的形状**（`enabled: false` + 空数组），
/// 而不是一个光秃秃的 `false` —— 前端只写一条读法，不为两种形状各写一遍。
#[cfg(not(feature = "doc"))]
#[tokio::test]
async fn the_server_reports_the_capability_as_off() {
    let (app, _state, _dir) = app_with_state();
    let (_status, body) = call(
        &app,
        Request::builder()
            .uri("/server")
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    let convert = &json_of(&body)["convert"];
    assert_eq!(convert["enabled"], false, "{body}");
    assert_eq!(
        convert["extensions"].as_array().map(Vec::len),
        Some(0),
        "关着时扩展名列表要是空数组，不是 null：{body}"
    );
}
