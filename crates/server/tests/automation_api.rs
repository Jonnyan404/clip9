//! 定时自动化的**端到端**测试。
//!
//! 跑真 Router（`tower::ServiceExt::oneshot`），覆盖 `/tasks` 一族的鉴权、Room 不可变、
//! single 档 task token、以及「自动化未启用时一律 404」这些只在 HTTP 层才暴露的行为。
//!
//! ⚠️ 断言写在**行为**上（「谁能在哪个房间建/删任务」「房间字段能不能被请求体改」），
//! 不是字段清单。

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use clip9_core::{AuthValue, Config, RoomAuthEntry};
use clip9_server::{AppState, router};
use clip9_store::Store;
use serde_json::{Value, json};
use tower::ServiceExt;

/// 一个**启用了自动化**的服务端：全局密码 `adminpw` + 受保护房间 `work`（密码 `roompw`，
/// 未显式配 automation → 跟随鉴权档位 = room 档）。
fn app() -> (Router, Arc<AppState>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.server.room_list = true;
    config.server.auth = AuthValue::Str("adminpw".to_owned());
    config.server.room_auth.0.insert(
        "work".to_owned(),
        RoomAuthEntry {
            password: "roompw".to_owned(),
            ..RoomAuthEntry::default()
        },
    );
    config.automation.enabled = true;

    let state = AppState::new(config, store, None);
    let router = router(state.clone());
    (router, state, dir)
}

async fn call(
    router: &Router,
    method: &str,
    uri: &str,
    auth: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(token) = auth {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let body_bytes = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
    let req = req
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body_bytes))
        .expect("构造请求");
    let resp = router
        .clone()
        .oneshot(req)
        .await
        .expect("请求应成功返回");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("读响应体");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

fn daily_task(template: &str) -> Value {
    json!({
        "name": "值班提醒",
        "freq": "daily",
        "time": "09:30",
        "template": template,
    })
}

#[tokio::test]
async fn automation_disabled_returns_404() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let config = Config::default(); // automation.enabled = false
    let state = AppState::new(config, store, None);
    let router = router(state);

    let (status, _) = call(&router, "GET", "/tasks?room=default", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "未启用时 /tasks 应 404");
}

#[tokio::test]
async fn admin_can_create_and_list_tasks() {
    let (router, _state, _dir) = app();

    // 管理员用全局密码，指向 work 房间（管理员能指向任意房间）。
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work",
        Some("adminpw"),
        Some(daily_task("今天是 {{date}}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "创建应成功：{body}");
    let task_id = body["task"]["id"].as_str().expect("返回 task.id").to_owned();
    assert_eq!(body["task"]["room"], "work", "房间来自鉴权上下文");

    // 列表按 room 过滤。
    let (status, body) = call(&router, "GET", "/tasks?room=work", Some("adminpw"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tasks"].as_array().map(|a| a.len()), Some(1));
    assert_eq!(body["tasks"][0]["id"], task_id);

    // 另一个房间看不到。
    let (status, body) = call(&router, "GET", "/tasks?room=other", Some("adminpw"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tasks"].as_array().map(|a| a.len()), Some(0));
}

#[tokio::test]
async fn room_cannot_be_declared_in_the_body() {
    let (router, _state, _dir) = app();

    // 请求体里塞一个 room 字段 —— 应该被忽略，任务仍落在鉴权上下文给的房间。
    let mut req = daily_task("x");
    req["room"] = json!("hijacked");
    let (status, body) = call(&router, "POST", "/tasks?room=work", Some("adminpw"), Some(req)).await;
    assert_eq!(status, StatusCode::OK, "创建应成功：{body}");
    assert_eq!(body["task"]["room"], "work", "请求体里的 room 必须被忽略");
}

#[tokio::test]
async fn non_admin_needs_room_credential() {
    let (router, _state, _dir) = app();

    // 不带凭据访问受保护房间的 /tasks → 403（策略是 room 档，但凭据不通）。
    let (status, _) = call(&router, "GET", "/tasks?room=work", None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // 带房间密码就能用（room 档成员）。
    let (status, _) = call(
        &router,
        "GET",
        "/tasks?room=work",
        Some("roompw"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn task_can_be_deleted() {
    let (router, _state, _dir) = app();

    let (_, body) = call(
        &router,
        "POST",
        "/tasks?room=work",
        Some("adminpw"),
        Some(daily_task("x")),
    )
    .await;
    let id = body["task"]["id"].as_str().unwrap().to_owned();

    let (status, body) = call(
        &router,
        "DELETE",
        &format!("/tasks/{id}?room=work"),
        Some("adminpw"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "删除应成功：{body}");
    assert_eq!(body["deleted"], true);

    // 再删一次 → 404。
    let (status, _) = call(
        &router,
        "DELETE",
        &format!("/tasks/{id}?room=work"),
        Some("adminpw"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invalid_task_is_rejected_on_save() {
    let (router, _state, _dir) = app();

    // 空模板 → 400 invalid_task。
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work",
        Some("adminpw"),
        Some(json!({ "freq": "daily", "time": "09:30", "template": "" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_task");
}

#[tokio::test]
async fn single_tier_issues_a_task_token() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");

    // 开放房间（无密码）显式配 automation: single → 建任务要签发 task token。
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.server.room_list = true;
    config.server.room_auth.0.insert(
        "lobby".to_owned(),
        RoomAuthEntry {
            automation: "single".to_owned(),
            ..RoomAuthEntry::default()
        },
    );
    config.automation.enabled = true;

    let state = AppState::new(config, store, None);
    let router = router(state);

    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=lobby",
        None,
        Some(daily_task("x")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "创建应成功：{body}");
    let token = body["taskToken"].as_str().expect("single 档应返回 taskToken");

    // taskToken 明文只出现这一次；响应里的 task 不应含 ownerHash。
    assert!(body["task"].get("ownerHash").is_none(), "ownerHash 永不外发");

    // 不带 task token 时，single 档里这条任务**连内容都不给看**（foreignCount）。
    let (status, list) = call(&router, "GET", "/tasks?room=lobby", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["tasks"].as_array().map(|a| a.len()), Some(0));
    assert_eq!(list["foreignCount"], 1);

    // 带 task token 就看得见。
    let (status, list) = call(
        &router,
        "GET",
        &format!("/tasks?room=lobby&taskToken={token}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["tasks"].as_array().map(|a| a.len()), Some(1));
}
