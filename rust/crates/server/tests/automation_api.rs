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
    let resp = router.clone().oneshot(req).await.expect("请求应成功返回");
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
    // ⚠️ 必须**显式**关掉：`Config::default()` 的 `automation.enabled` 是 `true`
    // （与 Go 的 `defaultConfig()` 一致，见 `rust/crates/core/src/config.rs` 的字段注释）。
    let mut config = Config::default();
    config.automation.enabled = false;
    let state = AppState::new(config, store, None);
    let router = router(state);

    let (status, _) = call(&router, "GET", "/tasks?room=default", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "未启用时 /tasks 应 404");

    // `/server` 的能力声明也要跟着关 —— 前端就是靠它决定显不显示入口的。
    let (_, srv) = call(&router, "GET", "/server", None, None).await;
    assert_eq!(srv["automation"], json!({ "enabled": false }));
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
    let task_id = body["task"]["id"]
        .as_str()
        .expect("返回 task.id")
        .to_owned();
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
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work",
        Some("adminpw"),
        Some(req),
    )
    .await;
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
    let (status, _) = call(&router, "GET", "/tasks?room=work", Some("roompw"), None).await;
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
    let token = body["taskToken"]
        .as_str()
        .expect("single 档应返回 taskToken");

    // taskToken 明文只出现这一次；响应里的 task 不应含 ownerHash。
    assert!(
        body["task"].get("ownerHash").is_none(),
        "ownerHash 永不外发"
    );

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

/// ⚠️ `?at=` 是 `docs/api.md` §8.7 写明的参数，**两种写法都要认**（RFC3339 与日期 token），
/// 而且认不出时**必须 400** —— 悄悄回落到「下次触发时刻」会让用户以为预览的正是他
/// 要的那个基准，那是最难发现的一类错（返回 200，答案是错的）。
///
/// 这条同时钉住**零偏移的写法**：`...Z` 进去，`scheduledAt` 出来也得是 `Z`。
/// Go 的 `time.RFC3339` 对零偏移输出 `Z`，而 chrono 的 `to_rfc3339()` 给 `+00:00` ——
/// 管理页把这个串原样显示出来，所以它是线上形状。
#[tokio::test]
async fn task_run_honours_the_at_reference() {
    let (router, _state, _dir) = app();
    let (status, created) = call(
        &router,
        "POST",
        "/tasks?room=work&auth=roompw",
        None,
        Some(daily_task("今天是 {{date}}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "建任务应成功：{created}");
    let id = created["task"]["id"]
        .as_str()
        .expect("返回 task.id")
        .to_owned();

    // ① RFC3339 写法。基准就是给的那一刻，正文按它求值。
    let (status, body) = call(
        &router,
        "POST",
        &format!("/tasks/{id}/run?room=work&auth=roompw&at=2026-09-25T01:30:00Z"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "试跑应成功：{body}");
    assert_eq!(
        body["referenceAt"].as_i64(),
        Some(1_790_299_800),
        "基准应是 ?at= 那一刻"
    );
    assert_eq!(
        body["scheduledAt"], "2026-09-25T01:30:00Z",
        "零偏移必须写成 Z（Go 的 time.RFC3339 就是这么写的）"
    );
    assert_eq!(body["output"], "今天是 2026-09-25", "正文按基准时刻求值");

    // ② 日期 token 写法：`2026-09-25 09:30` 按**任务时区**解释（默认 Asia/Shanghai）。
    let (status, body) = call(
        &router,
        "POST",
        &format!("/tasks/{id}/run?room=work&auth=roompw&at=2026-09-25%2009:30"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "试跑应成功：{body}");
    assert_eq!(body["scheduledAt"], "2026-09-25T09:30:00+08:00");

    // ③ 认不出 → 400 `invalid_reference`（**不是**悄悄用默认基准）。
    let (status, body) = call(
        &router,
        "POST",
        &format!("/tasks/{id}/run?room=work&auth=roompw&at=%E4%B8%8D%E6%98%AF%E6%97%B6%E5%88%BB"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_reference");

    // ④ 试算走同一条路（`/tasks/preview` 的 `referenceAt2` 是同一个格式）。
    let (status, body) = call(
        &router,
        "POST",
        "/tasks/preview?room=work&auth=roompw&at=2026-09-25T01:30:00Z",
        None,
        Some(daily_task("今天是 {{date}}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "试算应成功：{body}");
    assert_eq!(body["referenceAt2"], "2026-09-25T01:30:00Z");
    assert_eq!(body["output"], "今天是 2026-09-25");
}

/// ⚠️★ 响应里的顺序必须是**插入顺序** —— 这是服务端承诺的顺序，也是用户看得见的
/// （页面按收到的顺序渲染，还拿第一条做默认选中）。
///
/// 这条测的是**处理链**：存储层排好的顺序不能被 handler 打乱。
/// ⚠️ 它曾经断言「按 (createdAt, id) 升序」，而那是**错的** —— `createdAt` 是秒级的，
/// 同一秒内建的两条只能靠 uuid 兜底，顺序还是随机的（就是这条测试当场抓到的）。
/// 现在顺序来自 `Store::put_task` 分配的单调序号（`seq`），所以可以断言「先建的在前」。
#[tokio::test]
async fn task_list_response_follows_insertion_order() {
    let (router, _state, _dir) = app();
    for name in ["先建的", "后建的"] {
        let (status, body) = call(
            &router,
            "POST",
            "/tasks?room=work&auth=roompw",
            None,
            Some(json!({
                "name": name,
                "freq": "daily",
                "time": "09:30",
                "template": "x",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "建任务应成功：{body}");
    }

    let (status, list) = call(&router, "GET", "/tasks?room=work&auth=roompw", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = list["tasks"]
        .as_array()
        .expect("tasks 应是数组")
        .iter()
        .map(|t| t["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        names,
        vec!["先建的", "后建的"],
        "应按插入顺序 —— 这两条 `createdAt` 是同一秒，靠时间戳分不出先后"
    );

    // 改一条**不该**让它跳到末尾（`upsert` 保留序号）。
    let first_id = list["tasks"][0]["id"].as_str().expect("有 id").to_owned();
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work&auth=roompw",
        None,
        Some(json!({
            "id": first_id,
            "name": "先建的（改过）",
            "freq": "daily",
            "time": "09:30",
            "template": "x",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "更新应成功：{body}");
    let (_, list) = call(&router, "GET", "/tasks?room=work&auth=roompw", None, None).await;
    let names: Vec<&str> = list["tasks"]
        .as_array()
        .expect("tasks 应是数组")
        .iter()
        .map(|t| t["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        names,
        vec!["先建的（改过）", "后建的"],
        "更新不该把任务挪到末尾"
    );
}

/// ⚠️★ 请求体的字段名是 **camelCase**（`byWeekday` / `runAt` / `keepHistory`）。
///
/// 这条防的是「serde 按字段名匹配，漏了 `rename` 就**静默忽略**」——
/// 症状分别是「设了周几却报『每周需要至少选一天』」「设了 runAt 却报『仅一次需要 runAt』」
/// 「`keepHistory: true` 被吞掉、消息不进历史」。三种都**不报错**，只是结果不对。
/// 2026-09-25 由双跑比对抓到（喂一个 `runAt: "…Z"` 的 once 任务，Go 收下、这边 400）。
#[tokio::test]
async fn task_request_uses_camel_case_field_names() {
    let (router, _state, _dir) = app();

    // weekly + byWeekday：认不出来的话连建都建不起来。
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work&auth=roompw",
        None,
        Some(json!({
            "name": "每周例会",
            "freq": "weekly",
            "time": "10:00",
            "byWeekday": [1, 3, 5],
            "template": "例会",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "weekly 应带得上 byWeekday：{body}");
    assert_eq!(body["task"]["byWeekday"], json!([1, 3, 5]));

    // once + runAt：同样，认不出来就是 400。
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work&auth=roompw",
        None,
        Some(json!({
            "name": "一次性提醒",
            "freq": "once",
            "runAt": "2026-12-31T16:00:00Z",
            "template": "跨年",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "once 应带得上 runAt：{body}");
    assert_eq!(
        body["task"]["runAt"], "2026-12-31T16:00:00Z",
        "零偏移要写成 Z（Go 的 time.RFC3339 就是这么写的）"
    );

    // keepHistory：最阴的一个 —— 它被吞掉不会报错，只是消息**不进历史**，
    // 后果是「刷新后没了 / 别的设备看不到 / 那个房间不出现在 /rooms 里」。
    let (status, body) = call(
        &router,
        "POST",
        "/tasks?room=work&auth=roompw",
        None,
        Some(json!({
            "name": "留档提醒",
            "freq": "daily",
            "time": "11:00",
            "template": "留档",
            "keepHistory": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "应建成功：{body}");
    assert_eq!(body["task"]["keepHistory"], true, "keepHistory 必须被认下");
}
