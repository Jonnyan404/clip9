//! 分享与会话令牌的**端到端**测试。
//!
//! 这里跑的是**真的 Router**（`tower::ServiceExt::oneshot`，不起真端口），覆盖路由、
//! 鉴权、存储和形状的整条链路。
//!
//! 为什么必须有这层：`clip9_core` 的测试证明「令牌算法和 Go 逐字节一致」，
//! 但**把令牌接进 HTTP 之后**仍有一堆只在端到端才暴露的错 —— 路由没挂、鉴权走错那条腿、
//! 次数没扣、落地页没注入卡片。这些都不会让 core 的单测变红，只会让用户点开链接时才发现。
//!
//! ⚠️ 断言写在「**行为**」上（「谁能读什么」「扣了几次」），不是「响应里有哪些字段」——
//! 字段清单会随契约演进，行为不会。

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use clip9_core::{AuthValue, Config, NewShare, RoomAuthEntry, TYPE_CONTENT};
use clip9_server::state::now_secs;
use clip9_server::{AppState, router};
use clip9_store::Store;
use serde_json::{Value, json};
use tower::ServiceExt;

/// 测试用对端地址。用函数而不是 `const`：`parse()` 不是 const。
fn peer() -> SocketAddr {
    "127.0.0.1:5555".parse().expect("测试用对端地址")
}

/// 一个装好的服务端：受保护房间 `work`（密码 `roompw`）+ 开放房间 `default`，
/// 外加一个带 `index.html` 的静态目录（落地页要读它）。
///
/// 连 `AppState` 一起返回：有的用例要**自己签一张令牌**（`state.share_key`）——
/// 「造一个正常路径产生不了的输入」只能这么做，塞假串测的是「签名不对」，那是另一件事。
fn app_with_state() -> (Router, Arc<AppState>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    // 打开房间列表：否则 `/rooms` 会先回 403 `room_list_disabled`，
    // 而这条测试要验的是「凭据不通」那条路。
    config.server.room_list = true;
    config.server.room_auth.0.insert(
        "work".to_owned(),
        RoomAuthEntry {
            password: "roompw".to_owned(),
            ..RoomAuthEntry::default()
        },
    );

    let static_dir = dir.path().join("static");
    std::fs::create_dir_all(&static_dir).expect("建静态目录");
    std::fs::write(
        static_dir.join("index.html"),
        "<!DOCTYPE html><html><head><title>外壳</title></head><body><div id=app></div></body></html>",
    )
    .expect("写 index.html");

    let state = AppState::new(config, store, Some(static_dir));
    let router = router(state.clone());
    (router, state, dir)
}

fn app() -> (Router, tempfile::TempDir) {
    let (router, _state, dir) = app_with_state();
    (router, dir)
}

/// 另一个配置：**没有**全局密码、房间也开放 —— 用来验「开放房间照样签发令牌」。
fn open_app() -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.auth = AuthValue::Bool(false);
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, String) {
    let mut request = request;
    // ⚠️ 用到 `ConnectInfo` 的端点（`/share/visit`）没有这个扩展会直接 500。
    request.extensions_mut().insert(ConnectInfo(peer()));
    let response = app.clone().oneshot(request).await.expect("路由返回了错误");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("读响应体");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn get(app: &Router, uri: &str) -> (StatusCode, String) {
    call(
        app,
        Request::builder().uri(uri).body(Body::empty()).unwrap(),
    )
    .await
}

async fn post_json(
    app: &Router,
    uri: &str,
    auth: Option<&str>,
    body: &Value,
) -> (StatusCode, String) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(auth) = auth {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {auth}"));
    }
    call(app, builder.body(Body::from(body.to_string())).unwrap()).await
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("响应不是 JSON: {text}（{e}）"))
}

fn code_of(text: &str) -> String {
    json_of(text)["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// 在 `work` 房间发一条文本，返回它的 id。
async fn send_text(app: &Router, body: &str) -> String {
    let request = Request::builder()
        .method("POST")
        .uri("/text?room=work")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::AUTHORIZATION, "Bearer roompw")
        .body(Body::from(body.to_owned()))
        .unwrap();
    let (status, text) = call(app, request).await;
    assert_eq!(status, StatusCode::OK, "发文本失败: {text}");
    json_of(&text)["id"]
        .as_str()
        .expect("响应里没有 id")
        .to_owned()
}

/// 签发一条分享，返回响应。
async fn share_content(app: &Router, id: &str, extra: Value) -> Value {
    let mut body = json!({"type": "content", "id": id, "ttl": 900, "maxUses": 0});
    for (key, value) in extra.as_object().expect("extra 必须是对象") {
        body[key] = value.clone();
    }
    let (status, text) = post_json(app, "/share?room=work", Some("roompw"), &body).await;
    assert_eq!(status, StatusCode::OK, "签发分享失败: {text}");
    json_of(&text)
}

// ── 会话令牌 ──────────────────────────────────────────────────────────

/// 会话令牌要能**真的**顶替密码进门，而不只是「签发成功」。
#[tokio::test]
async fn a_session_token_opens_its_room() {
    let (app, _dir) = app();
    let id = send_text(&app, "会话令牌测试").await;

    let (status, text) = post_json(
        &app,
        "/auth/token?room=work",
        None,
        &json!({"password": "roompw"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let issued = json_of(&text);
    let token = issued["token"].as_str().expect("没有 token").to_owned();
    assert_eq!(issued["scope"], "", "房间密码换来的令牌不是全局令牌");
    assert!(issued["expiresAt"].as_i64().is_some_and(|e| e > 0));

    let (status, _) = get(&app, &format!("/content/{id}?room=work")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "没凭据要被拒");

    let request = Request::builder()
        .uri(format!("/content/{id}?room=work"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "会话令牌该能读: {body}");
    assert!(body.contains("会话令牌测试"), "{body}");
}

/// ⚠️ 令牌换不到就是换不到：**开放房间**也不能拿任意密码换令牌
/// （`can_access_room` 对开放房间恒 true，用它签发就是个后门）。
#[tokio::test]
async fn an_open_room_does_not_hand_out_tokens_for_any_password() {
    let (app, _dir) = open_app();
    let (status, text) =
        post_json(&app, "/auth/token", None, &json!({"password": "随便什么"})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&text), "wrong_password");
}

#[tokio::test]
async fn token_issues_reject_empty_and_wrong_passwords() {
    let (app, _dir) = app();

    let (status, text) = post_json(
        &app,
        "/auth/token?room=work",
        None,
        &json!({"password": ""}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&text), "password_required");

    let (status, text) = post_json(
        &app,
        "/auth/token?room=work",
        None,
        &json!({"password": "错"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&text), "wrong_password");

    // 空 body 是 400（不是「空密码」401）：那是形状不对。
    let request = Request::builder()
        .method("POST")
        .uri("/auth/token?room=work")
        .body(Body::empty())
        .unwrap();
    let (status, text) = call(&app, request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
    assert_eq!(code_of(&text), "invalid_request_body");
}

/// 续期必须**保留 scope** —— 全局会话降级成房间专属是静默的，
/// 而受影响的正是管理页（它不存明文密码）。
#[tokio::test]
async fn refresh_preserves_the_global_scope() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    config.server.auth = AuthValue::Str("global-pw".into());
    let state = AppState::new(config, store, None);
    let app = router(state);

    let (status, text) =
        post_json(&app, "/auth/token", None, &json!({"password": "global-pw"})).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let token = json_of(&text)["token"]
        .as_str()
        .expect("没有 token")
        .to_owned();
    assert_eq!(json_of(&text)["scope"], "global");

    let refresh = |token: String| {
        let app = app.clone();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri("/auth/token/refresh")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            call(&app, request).await
        }
    };

    let (status, body) = refresh(token.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let refreshed = json_of(&body);
    assert_eq!(refreshed["scope"], "global", "续期不能降级作用域");
    // ⚠️ 令牌是**无状态签名**：同一秒内续期出来的串与旧串**逐字节相同**
    // （claims 一样、签名也一样）。这不是 bug，但也意味着「续期」并不保证拿到
    // 一张不同的令牌 —— 想撤销旧令牌只能靠过期或改密码。
    assert_eq!(refreshed["token"], token, "同一秒内续期是幂等的");

    // 旧令牌仍然有效到过期 —— 续期不是「作废旧令牌」。
    let (status, body) = refresh(token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// 拿**别的房间**的令牌去续期要拒（否则等于跨房间续命）。
#[tokio::test]
async fn refresh_rejects_a_token_from_another_room() {
    let (app, _dir) = app();
    let (status, text) = post_json(
        &app,
        "/auth/token?room=work",
        None,
        &json!({"password": "roompw"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let token = json_of(&text)["token"]
        .as_str()
        .expect("没有 token")
        .to_owned();

    let request = Request::builder()
        .method("POST")
        .uri("/auth/token/refresh?room=default")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(code_of(&body), "session_token_invalid");
}

// ── 分享：签发与读 ────────────────────────────────────────────────────

/// ★ 主线：发一条 → 分享它 → **不带任何凭据**按链接读到内容。
/// 这一条串起了签发、存储、签名校验、房间匹配和正文渲染。
#[tokio::test]
async fn a_share_link_lets_a_stranger_read_the_entry() {
    let (app, _dir) = app();
    let id = send_text(&app, "这是分享正文").await;
    let share = share_content(&app, &id, json!({})).await;

    let token = share["token"].as_str().expect("没有 token");
    assert_eq!(share["room"], "work");
    assert_eq!(share["url"], share["pageUrl"], "两个地址必须相同");
    assert!(share["rawUrl"].as_str().unwrap().contains("?t="));
    assert!(
        share["url"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/s/{token}"))
    );
    assert!(!share["jti"].as_str().unwrap_or_default().is_empty());

    let (status, body) = get(&app, &format!("/content/{id}?room=work&t={token}")).await;
    assert_eq!(status, StatusCode::OK, "凭链接该能读: {body}");
    assert!(body.contains("这是分享正文"), "{body}");
}

/// ⚠️ 分享令牌只放行**读**：写操作（发文本、撤销）必须拒绝它。
/// 少了这条，一张只读令牌就能改数据 —— 分享等于发了房间账号。
#[tokio::test]
async fn a_share_token_cannot_write() {
    let (app, _dir) = app();
    let id = send_text(&app, "只读").await;
    let share = share_content(&app, &id, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    let request = Request::builder()
        .method("POST")
        .uri(format!("/text?room=work&t={token}"))
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("我要改内容"))
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "分享令牌能写就出大事了: {body}"
    );

    // ⚠️ `/rooms` 不带凭据回 200 是**对的**（它只列出你打得开的房间，
    // `default` 是开放的）。要钉的是另一件事：受保护的 `work` **不能出现在列表里**。
    let (status, body) = get(&app, "/rooms").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        !body.contains("\"work\""),
        "受保护的房间不该出现在列表里: {body}"
    );

    let request = Request::builder()
        .method("POST")
        .uri(format!("/revoke/{id}?room=work&t={token}"))
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(&app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// 令牌指向**别的**条目要拒 —— 这是「越权」那条线。
#[tokio::test]
async fn a_share_token_only_opens_its_own_entry() {
    let (app, _dir) = app();
    let mine = send_text(&app, "我的").await;
    let theirs = send_text(&app, "别人的").await;
    let share = share_content(&app, &mine, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    let (status, body) = get(&app, &format!("/content/{theirs}?room=work&t={token}")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "不该读到别人的: {body}");
    assert!(!body.contains("别人的"), "{body}");
}

/// ★ 限次：额度用完就真的打不开。**并**钉住「`GET /share` 不消耗次数」——
/// 分享页每次挂载都要问一次元信息，要是不消耗，两倍配额就在这里漏光了。
#[tokio::test]
async fn limited_shares_run_out_and_metadata_is_free() {
    let (app, _dir) = app();
    let id = send_text(&app, "限量正文").await;
    let share = share_content(&app, &id, json!({"maxUses": 2})).await;
    let token = share["token"].as_str().expect("没有 token");
    assert_eq!(share["maxUses"], 2);
    let uri = format!("/content/{id}?room=work&t={token}");

    // 问三次元信息（前端每次挂载都会问），它一次都不该扣。
    for _ in 0..3 {
        let (status, body) = get(&app, &format!("/share?t={token}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(json_of(&body)["used"], 0, "问元信息不该消耗次数");
    }

    for expected_used in 1..=2 {
        let (status, body) = get(&app, &uri).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "第 {expected_used} 次该能读: {body}"
        );
        let (status, body) = get(&app, &format!("/share?t={token}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json_of(&body)["used"], expected_used);
    }

    let (status, body) = get(&app, &uri).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "额度用完就该打不开: {body}"
    );

    // 但元信息仍然能问（分享页要显示「已被使用完」而不是变成空白）。
    let (status, body) = get(&app, &format!("/share?t={token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_of(&body)["used"], 2);
}

/// 分享记录：按房间隔离、要房间凭据、**绝不带 token**。
#[tokio::test]
async fn the_share_list_is_scoped_authed_and_token_free() {
    let (app, _dir) = app();
    let id = send_text(&app, "正文").await;
    let share = share_content(&app, &id, json!({"maxUses": 5})).await;
    let token = share["token"].as_str().expect("没有 token");

    let (status, _) = get(&app, &format!("/content/{id}?room=work&t={token}")).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = get(&app, "/share/list?room=work").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "列表要房间凭据");
    assert_eq!(code_of(&body), "room_forbidden");

    let request = Request::builder()
        .uri("/share/list?room=work")
        .header(header::AUTHORIZATION, "Bearer roompw")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let list = json_of(&body);
    assert_eq!(list["room"], "work");
    assert_eq!(list["total"], 1);
    assert_eq!(list["limit"], 50, "默认 50");
    let records = list["records"].as_array().expect("records 不是数组");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["used"], 1, "刚读过一次");
    assert_eq!(records[0]["room"], "work");
    assert_eq!(records[0]["kind"], "text");
    assert_eq!(records[0]["password"], false);
    assert_eq!(records[0]["expired"], false);
    assert!(records[0].get("token").is_none(), "⚠️ 列表绝不能带 token");
}

/// ⚠️ 带密码的分享：没有 `X-Share-Password` 一律 401，而且要**换**一个预览令牌
/// （浏览器直连图片 / 视频 / 下载按钮加不了自定义头）。
#[tokio::test]
async fn password_shares_gate_on_the_header_and_issue_a_preview_token() {
    let (app, _dir) = app();
    let id = send_text(&app, "带密码的正文").await;
    let share = share_content(&app, &id, json!({"password": "hunter2"})).await;
    let token = share["token"].as_str().expect("没有 token");
    assert!(
        !token.contains("hunter2"),
        "密码绝不能出现在 token 里（它会进浏览器历史）"
    );

    // 错密码 / 缺密码：两种都 401，但**错误码要分开**（分享页据此决定提示什么）。
    let (status, body) = get(&app, &format!("/share?t={token}")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&body), "share_password_required");

    let request = Request::builder()
        .uri(format!("/share?t={token}"))
        .header("x-share-password", "错密码")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&body), "share_password_required");

    let request = Request::builder()
        .uri(format!("/share?t={token}"))
        .header("x-share-password", "hunter2")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let info = json_of(&body);
    assert_eq!(info["needsPassword"], true);
    assert_eq!(info["kind"], "text");
    let preview = info["previewToken"]
        .as_str()
        .expect("没有预览令牌")
        .to_owned();
    assert!(info["previewExpiresAt"].as_i64().is_some());

    // 取正文也要带密码。
    let (status, _) = get(&app, &format!("/content/{id}?room=work&t={token}")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let request = Request::builder()
        .uri(format!("/content/{id}?room=work&t={token}"))
        .header("x-share-password", "hunter2")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "带密码该能读: {body}");

    // 预览令牌能读，而且**不限次**（它没有 mu）—— 这正是它要短命的原因。
    let (status, body) = get(&app, &format!("/content/{id}?room=work&t={preview}")).await;
    assert_eq!(status, StatusCode::OK, "预览令牌该能读: {body}");
    let (status, body) = get(&app, &format!("/content/{id}?room=work&t={preview}")).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "预览令牌不该限次（否则预览一张图就烧掉一次）: {body}"
    );
}

/// 不带密码的分享**不换**预览令牌：多发一张「不限次」的令牌会让 maxUses 形同虚设。
#[tokio::test]
async fn open_shares_do_not_issue_a_preview_token() {
    let (app, _dir) = app();
    let id = send_text(&app, "正文").await;
    let share = share_content(&app, &id, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    let (status, body) = get(&app, &format!("/share?t={token}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let info = json_of(&body);
    assert_eq!(info["needsPassword"], false);
    assert!(info.get("previewToken").is_none(), "不该发预览令牌: {body}");
}

/// ⚠️ 开放房间**照样**签发带 TTL 的令牌。早先只在「需要鉴权」时才签，
/// 于是用户设的「15 分钟 / 最多 3 次」被静默丢弃，而响应里还照样回着这两个值。
#[tokio::test]
async fn an_open_room_still_gets_an_expiring_token() {
    let (app, _dir) = open_app();
    let request = Request::builder()
        .method("POST")
        .uri("/text")
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("开放房间"))
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = json_of(&body)["id"].as_str().expect("没有 id").to_owned();

    let (status, body) =
        post_json(&app, "/share", None, &json!({"type": "content", "id": id})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let share = json_of(&body);
    assert_eq!(share["ttl"], 900, "默认 15 分钟");
    assert!(share["token"].as_str().is_some_and(|t| !t.is_empty()));
    assert!(share["expiresAt"].as_i64().is_some_and(|e| e > 0));
}

/// TTL 与次数要被**夹**到合法区间，而且响应里回的是夹后的值
/// （回原始入参就是在骗调用方）。
#[tokio::test]
async fn ttl_and_max_uses_are_clamped_and_reported_clamped() {
    let (app, _dir) = app();
    let id = send_text(&app, "正文").await;

    let share = share_content(&app, &id, json!({"ttl": 5, "maxUses": 99999})).await;
    assert_eq!(share["ttl"], 60, "TTL 下限 60 秒");
    assert_eq!(share["maxUses"], 1000, "次数上限 1000");
}

// ── /share/visit ──────────────────────────────────────────────────────

/// 打开计数只认分享页的上报，而且**同一个访客十分钟内只算一次**
/// （否则拿着链接连点刷新就能把数字刷上去）。
#[tokio::test]
async fn visits_are_counted_once_per_visitor_per_window() {
    let (app, _dir) = app();
    let id = send_text(&app, "正文").await;
    let share = share_content(&app, &id, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    let (status, body) = post_json(&app, "/share/visit", None, &json!({"token": token})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let first = json_of(&body);
    assert_eq!(first["ok"], true);
    assert_eq!(first["tracked"], true);
    assert_eq!(first["visits"], 1);
    assert_eq!(first["scans"], 0);

    // 同一个 IP 立刻再来一次：不计数，但要把当前数字回回去。
    let (status, body) = post_json(&app, "/share/visit", None, &json!({"token": token})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let second = json_of(&body);
    assert_eq!(second["tracked"], false);
    assert_eq!(second["visits"], 1);

    // 换一个访客 IP：算新的，并且记一次扫码。
    let request = Request::builder()
        .method("POST")
        .uri("/share/visit")
        .header("x-forwarded-for", "203.0.113.9")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"token": token, "qr": true}).to_string()))
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let third = json_of(&body);
    assert_eq!(third["tracked"], true);
    assert_eq!(third["visits"], 2);
    assert_eq!(third["scans"], 1, "qr=true 要记一次扫码");
}

/// 落地页**自己**不计数（抓取程序会反复访问同一个地址）。
#[tokio::test]
async fn the_landing_page_does_not_count_visits() {
    let (app, _dir) = app();
    let id = send_text(&app, "正文").await;
    let share = share_content(&app, &id, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    for _ in 0..3 {
        let (status, body) = get(&app, &format!("/s/{token}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let request = Request::builder()
        .uri("/share/list?room=work")
        .header(header::AUTHORIZATION, "Bearer roompw")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let records = json_of(&body)["records"]
        .as_array()
        .expect("records 不是数组")
        .clone();
    assert_eq!(records[0]["visits"], 0, "落地页不许计数");
}

#[tokio::test]
async fn visit_rejects_bad_and_missing_tokens() {
    let (app, _dir) = app();

    let (status, body) = post_json(&app, "/share/visit", None, &json!({"token": "不是令牌"})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&body), "share_token_invalid");

    let (status, body) = post_json(&app, "/share/visit", None, &json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&body), "missing_token");
}

// ── 落地页 `/s/<token>` ───────────────────────────────────────────────

/// ★ 抓取程序要的东西必须**在 HTML 里**（它不执行 JS）：
/// og:title / og:description / noindex，外加 `<base href>`（否则深路径上的资源全 404）。
#[tokio::test]
async fn the_landing_page_carries_open_graph_tags_and_a_base() {
    let (app, _dir) = app();
    let id = send_text(&app, "第一行摘要\n第二行").await;
    let share = share_content(&app, &id, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    let (status, body) = get(&app, &format!("/s/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains("<base href=\"/\">"),
        "深路径上必须有 base: {body}"
    );
    assert!(body.contains("<meta property=\"og:title\""), "{body}");
    assert!(body.contains("第一行摘要"), "标题取内容首行: {body}");
    assert!(body.contains("noindex, nofollow"), "{body}");
    // 外壳还在 —— 真人跑起前端路由后看到的就是分享页本身。
    assert!(body.contains("<div id=app></div>"), "{body}");
}

/// ⚠️ 带密码的分享**绝不**把内容摘要写进 HTML：这份 HTML 会被第三方缓存，而且删不掉。
#[tokio::test]
async fn the_landing_page_never_leaks_protected_content() {
    let (app, _dir) = app();
    let id = send_text(&app, "机密正文").await;
    let share = share_content(&app, &id, json!({"password": "hunter2"})).await;
    let token = share["token"].as_str().expect("没有 token");

    let (status, body) = get(&app, &format!("/s/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains("机密正文"), "带密码的分享泄露了正文: {body}");
    assert!(body.contains("受密码保护的分享"), "{body}");
}

/// 无效令牌也回 200 + 一张通用卡片：分享链接是**公开地址**，
/// 差别对待等于给「哪些链接还活着」提供一个免费的探测接口。
#[tokio::test]
async fn the_landing_page_degrades_instead_of_erroring() {
    let (app, _dir) = app();
    let (status, body) = get(&app, "/s/根本不是令牌").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("分享链接无效或已过期"), "{body}");
    assert!(body.contains("og:title"), "抓取程序仍然要拿到标签: {body}");
}

/// 内容被删掉之后，分享页要说「已被删除」，而不是泄露一个空摘要。
#[tokio::test]
async fn the_landing_page_says_when_the_content_is_gone() {
    let (app, _dir) = app();
    let id = send_text(&app, "会被删掉").await;
    let share = share_content(&app, &id, json!({})).await;
    let token = share["token"].as_str().expect("没有 token");

    let request = Request::builder()
        .method("POST")
        .uri(format!("/revoke/{id}?room=work"))
        .header(header::AUTHORIZATION, "Bearer roompw")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = get(&app, &format!("/s/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("内容已被删除或过期"), "{body}");
    assert!(!body.contains("会被删掉"), "{body}");
}

/// ⚠️ 手工签一张 **`room` 与条目对不上**的令牌 —— 正常的签发路径产生不了它
/// （房间取自条目自己），所以这条测的是**纵深防御**：落地页与 `GET /share` 都必须拒，
/// 而不是把**别的房间**的内容摘要写进 OG 卡片。
///
/// 值得单独一条的理由：那份 HTML 会被微信 / Telegram / Slack 缓存，删不掉 ——
/// 泄露一次就是永久泄露。两条路径（`info` 与 `landing_card`）各有一份校验，少哪一份都在这条上红。
#[tokio::test]
async fn a_token_whose_room_does_not_match_the_entry_is_refused() {
    let (app, state, _dir) = app_with_state();
    // 这条内容在**受保护**的 `work` 房间。
    let id = send_text(&app, "别的房间的机密").await;

    // 用真的签名密钥签（签名是对的），只把 `room` 写成 `default`。
    let (claims, _) = state.share_key.share_claims(NewShare {
        share_type: TYPE_CONTENT,
        id: &id,
        room: "default",
        ttl_seconds: 900,
        max_uses: 0,
        password: "",
        jti: "jti-room-mismatch".to_owned(),
        now: now_secs(),
    });
    let token = state.share_key.sign(&claims);

    let (status, body) = get(&app, &format!("/s/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !body.contains("别的房间的机密"),
        "落地页把别的房间的内容摘要写进了卡片: {body}"
    );
    assert!(body.contains("分享链接无效或已过期"), "{body}");

    let (status, body) = get(&app, &format!("/share?t={token}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(code_of(&body), "content_not_found");
}

/// 没有前端外壳时回退到一张通用卡片（API-only 的部署也要能被预览）。
#[tokio::test]
async fn the_landing_page_falls_back_to_a_card_without_a_shell() {
    let (app, _dir) = open_app();
    let request = Request::builder()
        .method("POST")
        .uri("/text")
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("有外壳才注入"))
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = json_of(&body)["id"].as_str().expect("没有 id").to_owned();
    let (status, body) =
        post_json(&app, "/share", None, &json!({"type": "content", "id": id})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let token = json_of(&body)["token"]
        .as_str()
        .expect("没有 token")
        .to_owned();

    let (status, body) = get(&app, &format!("/s/{token}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with("<!DOCTYPE html>"), "{body}");
    assert!(body.contains("og:title"), "{body}");
    assert!(body.contains("有外壳才注入"), "兜底页也要有摘要: {body}");
    assert!(!body.contains("<base"), "兜底页没有外壳可注入 base");
}

// ── 错误形状与方法分发 ────────────────────────────────────────────────

/// 错误响应恒为 `{code,error,message}` —— 捷径用 `getDictionary` 读，少一个字段就解析不出来。
#[tokio::test]
async fn share_errors_keep_the_three_field_shape() {
    let (app, _dir) = app();

    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("roompw"),
        &json!({"type": "nope"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let value = json_of(&body);
    let keys: Vec<&str> = value
        .as_object()
        .expect("不是对象")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["code", "error", "message"], "{body}");
    assert_eq!(value["code"], "unsupported_type");

    // 缺 type / 缺 id / 坏 id 各有自己的码。
    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("roompw"),
        &json!({"id": "7"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&body), "missing_type");

    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("roompw"),
        &json!({"type": "content"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&body), "missing_id");

    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("roompw"),
        &json!({"type": "content", "id": "不是数字"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code_of(&body), "invalid_id");

    // 凭据不对要 401。⚠️ 注意**顺序**：条目不存在 → 先 404，再谈凭据
    // （Go 也是这个顺序，`.json` 那边靠双跑比对钉住）。所以这条要拿一条**存在**的 id。
    let existing = send_text(&app, "已存在").await;
    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("错密码"),
        &json!({"type": "content", "id": existing}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(code_of(&body), "room_forbidden");

    // 不存在的条目 = 404（先于凭据判断）。
    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("roompw"),
        &json!({"type": "content", "id": "9999"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(code_of(&body), "content_not_found");
}

/// 未知字段必须报错，而不是被静默忽略
/// （`maxUses` 拼成 `max_uses` 时，设置会被静默丢弃，而用户以为已经限次了）。
#[tokio::test]
async fn unknown_fields_in_the_share_request_are_rejected() {
    let (app, _dir) = app();
    let id = send_text(&app, "正文").await;
    let (status, body) = post_json(
        &app,
        "/share?room=work",
        Some("roompw"),
        &json!({"type": "content", "id": id, "max_uses": 3}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(code_of(&body), "invalid_request_body");
}

/// `/share` 的方法分发：GET = 元信息、POST = 签发、其它 = 405（**JSON** body）。
#[tokio::test]
async fn share_method_dispatch_and_405_shape() {
    let (app, _dir) = app();

    let request = Request::builder()
        .method("DELETE")
        .uri("/share")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(code_of(&body), "method_not_allowed");

    let request = Request::builder()
        .method("DELETE")
        .uri("/share/list?room=work")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(code_of(&body), "method_not_allowed");

    let request = Request::builder()
        .method("GET")
        .uri("/share/visit")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(&app, request).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(code_of(&body), "method_not_allowed");
}

/// `GET /share` 拿无效令牌 → `share_token_invalid`（分享页要据此显示「链接已过期」）。
#[tokio::test]
async fn share_info_rejects_an_invalid_token() {
    let (app, _dir) = app();
    let (status, body) = get(&app, "/share?t=不是令牌").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code_of(&body), "share_token_invalid");

    // 会话令牌**不是**分享令牌（同一个信封，但 typ 不同）——
    // 少了这条，一张房间会话令牌就能当分享链接发出去。
    let (status, text) = post_json(
        &app,
        "/auth/token?room=work",
        None,
        &json!({"password": "roompw"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let session = json_of(&text)["token"]
        .as_str()
        .expect("没有 token")
        .to_owned();
    let (status, body) = get(&app, &format!("/share?t={session}")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(code_of(&body), "unsupported_type");
}
