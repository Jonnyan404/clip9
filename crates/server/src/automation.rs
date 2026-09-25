//! 定时自动化：`/tasks` 端点 + 鉴权作用域 + 外发视图。
//!
//! 对应 Go 的 `automation_http.go`（端点）与 `auth.go` 的 `resolveAutomationScope`（作用域）。
//! 调度器在 [`crate::scheduler`]，`{{latest}}` 的来源读取在 [`crate::scheduler::latest_room_text`]。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;

use clip9_core::task::{AutomationTask, ChainStep, normalize_and_validate};
use clip9_core::{AutomationPolicy, resolve_automation_policy, task as taskmod};

use crate::error::write_error;
use crate::handlers::{extract_auth_token, json_response};
use crate::state::{AppState, now_secs};

/// 请求体上限。
const BODY_MAX_BYTES: usize = 64 * 1024;

/// 一次自动化请求的作用域。
pub struct AutomationScope {
    pub admin: bool,
    pub room: String,
    pub tier: String,
    pub ok: bool,
}

impl AutomationScope {
    fn denied(room: String) -> Self {
        Self {
            admin: false,
            room,
            tier: AutomationPolicy::None.as_str().to_owned(),
            ok: false,
        }
    }
}

/// 这次请求指向哪个房间。`?room=` 缺省、空值、`default` 三种写法都归一到 `default`。
///
/// ⚠️★ 必须走 `normalize_room_name`，**不能**图省事写 `.unwrap_or_default()` ——
/// 后者在「压根没有 `?room=` 这个参数」时给出的是**空串**，而 Go 那边
/// `normalizeRoomName(r.URL.Query().Get("room"))` 给的是 `"default"`。
/// 症状：`/server` 的 `automation.room` 变成 `""`，错误文案里的房间名也消失
/// （「房间  未开放自动化」——两个空格）。
/// 这条偏离是 2026-09-25 把 `/tasks` 加进双跑比对时抓出来的，读代码看不出来。
fn request_room(query: &HashMap<String, String>) -> String {
    clip9_protocol::normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""))
}

/// 从凭据推导这次请求能对哪个房间做什么。
///
/// ⚠️ 房间**不是**从请求体里读的。非管理员的房间来自 `?room=`，而且必须通过
/// `can_access_room` —— room 是「鉴权的产物」，不是「一个参数」。
/// 判定顺序：先确认凭据对这个房间有效，再看房间的策略。
fn resolve_scope(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> AutomationScope {
    let token = extract_auth_token(headers, query.get("auth").map(String::as_str));

    // 管理员：明文全局密码，或它换来的会话令牌（scope=global）。少了后一半，管理页里的
    // 「管理员」就不成立（那边刻意不存明文密码）。
    if state.is_global_admin(&token) || state.is_global_session_token(&token) {
        return AutomationScope {
            admin: true,
            room: request_room(query),
            tier: "admin".to_owned(),
            ok: true,
        };
    }

    let room = request_room(query);
    if !state.can_access_room(&room, &token) {
        return AutomationScope::denied(room);
    }

    let policy = resolve_automation_policy(&state.config, &room);
    AutomationScope {
        admin: false,
        room,
        tier: policy.as_str().to_owned(),
        ok: policy != AutomationPolicy::None,
    }
}

/// 取「single 档房间」里那把任务钥匙。头优先（管理页用），退到查询串。
fn extract_task_token(headers: &HeaderMap, query: &HashMap<String, String>) -> String {
    if let Some(v) = headers.get("x-task-token").and_then(|v| v.to_str().ok()) {
        let t = v.trim();
        if !t.is_empty() {
            return t.to_owned();
        }
    }
    query
        .get("taskToken")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

/// 这条任务当前请求人管不管得着。
///
/// admin / room 档：房间内的任务按房间共享（持有房间密码 = 这个房间的成员）。
/// single 档：只能靠建任务时下发的那把 task token。
fn task_owned_by(task: &AutomationTask, scope: &AutomationScope, task_token: &str) -> bool {
    if scope.admin || scope.tier == AutomationPolicy::Room.as_str() {
        return true;
    }
    taskmod::task_token_matches(task_token, &task.owner_hash)
}

/// 房间任务条数上限。管理员不限（0 = 不限）。
fn room_limit(scope: &AutomationScope) -> usize {
    if scope.admin {
        return 0;
    }
    if scope.tier == AutomationPolicy::Single.as_str() {
        return 1;
    }
    taskmod::MAX_TASKS_PER_ROOM
}

/// 外发形态。`owner_hash` 永远不外发。
fn task_view(task: &AutomationTask, now: i64) -> serde_json::Value {
    let mut view = serde_json::json!({
        "id": task.id,
        "name": task.name,
        "enabled": task.enabled,
        "freq": task.freq,
        "time": task.time,
        "cron": task.cron,
        "byWeekday": task.by_weekday,
        "runAt": task.run_at,
        "tz": task.tz,
        "room": task.room,
        "template": task.template,
        "chain": task.chain,
        "keepHistory": task.keep_history,
        "sender": task.sender,
        "createdAt": task.created_at,
        "updatedAt": task.updated_at,
        "nextRunAt": next_run_at(task, now),
        "lastRunAt": task.last_run_at,
        "lastStatus": task.last_status,
        "lastError": task.last_error,
        "lastOutput": task.last_output,
    });
    // cron 任务带上结构化「翻译」：列表里那一行也不用甩一串 `*/30 9-18 * * 1-5`。
    if task.freq == taskmod::FREQ_CRON
        && let Ok(spec) = clip9_core::cron::CronSpec::parse(&task.cron)
    {
        view["desc"] = serde_json::to_value(spec.describe()).unwrap_or(serde_json::Value::Null);
    }
    view
}

fn next_run_at(task: &AutomationTask, now: i64) -> i64 {
    // core 的 `next_run_at` 要一个带偏移的时刻；这里用任务自己的时区偏移做基准。
    let offset = task
        .tz_offset()
        .unwrap_or_else(|_| taskmod::default_tz_offset());
    let now = chrono::DateTime::from_timestamp(now, 0)
        .map(|t| t.with_timezone(&offset))
        .unwrap_or_else(|| {
            chrono::DateTime::from_timestamp(0, 0)
                .unwrap()
                .with_timezone(&offset)
        });
    task.next_run_at(now)
}

/// 自动化能力声明（`/server` 用）。
pub fn capability(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> serde_json::Value {
    if !state.config.automation.enabled {
        return serde_json::json!({ "enabled": false });
    }
    let scope = resolve_scope(state, headers, query);
    serde_json::json!({
        "enabled": true,
        "room": scope.room,
        "tier": scope.tier,
        "allowed": scope.ok,
        "admin": scope.admin,
        "max": room_limit(&scope),
        "defaultTZ": default_tz(state),
        "vars": clip9_core::template::variable_names(),
        "actions": action_list_json(),
    })
}

fn default_tz(state: &AppState) -> String {
    let configured = state.config.automation.default_tz.trim();
    if configured.is_empty() {
        taskmod::DEFAULT_TZ_NAME.to_owned()
    } else if taskmod::resolve_tz_offset(configured).is_some() {
        configured.to_owned()
    } else {
        taskmod::DEFAULT_TZ_NAME.to_owned()
    }
}

/// `POST /tasks` 的请求体。⚠️ **没有 room** —— 房间来自鉴权上下文。
///
/// ⚠️★ **字段名必须逐字用 camelCase**（`byWeekday` / `runAt` / `keepHistory`），
/// 这不是风格问题：`serde` 默认按字段名匹配，少了 `rename` 就会**静默忽略**客户端
/// 传来的那个字段 —— 于是「设了周几却报『每周需要至少选一天』」「设了 runAt 却报
/// 『仅一次需要 runAt』」「`keepHistory: true` 被吞掉、消息不进历史」。
/// 三种都**不报错**，只是结果不对。
/// 2026-09-25 由双跑比对抓到（喂一个 `runAt: "…Z"` 的 once 任务，Go 收下、这边 400）。
///
/// 别把它改成 `#[serde(rename_all = "camelCase")]` 图省事 —— `id` / `name` / `freq` /
/// `time` / `cron` / `tz` / `template` / `chain` / `sender` 这些单词字段靠它是对的，
/// 但**逐字写出来**才能一眼和 Go 的 json tag 对照（契约纪律见 CONTRIBUTING §3）。
#[derive(serde::Deserialize)]
struct TaskRequest {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    freq: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    cron: String,
    #[serde(default, rename = "byWeekday")]
    by_weekday: Option<Vec<u32>>,
    #[serde(default, rename = "runAt")]
    run_at: String,
    #[serde(default)]
    tz: String,
    #[serde(default)]
    template: String,
    #[serde(default)]
    chain: Option<Vec<ChainStep>>,
    #[serde(default, rename = "keepHistory")]
    keep_history: Option<bool>,
    #[serde(default)]
    sender: String,
}

/// 解析请求体失败时的响应（拆成两个字段，避开 `Response` 作为 `Result::Err` 的体积告警）。
struct ParseFailure {
    status: StatusCode,
    message: &'static str,
}

fn parse_request(body: &axum::body::Bytes) -> Result<TaskRequest, ParseFailure> {
    if body.len() > BODY_MAX_BYTES {
        return Err(ParseFailure {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: "请求体过大",
        });
    }
    serde_json::from_slice(body).map_err(|_| ParseFailure {
        status: StatusCode::BAD_REQUEST,
        message: "请求体无法解析",
    })
}

fn parse_failure_response(failure: ParseFailure) -> Response {
    write_error(
        failure.status,
        "invalid_body",
        "Cannot parse request body",
        failure.message,
    )
}

/// `GET /tasks`（列表）/ `POST /tasks`（创建或更新）。
pub async fn tasks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if !state.config.automation.enabled {
        return automation_disabled();
    }
    let scope = resolve_scope(&state, &headers, &query);
    if !scope.ok {
        return automation_forbidden(&scope);
    }

    // 列表与创建/更新靠 body 是否为空区分？不 —— 用方法区分。但 axum 的 route 已按方法分。
    // 这里只处理 POST（创建/更新）；GET 列表是另一个 handler。
    upsert(&state, &headers, &query, &scope, body).await
}

/// `GET /tasks`（列表）。
pub async fn task_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !state.config.automation.enabled {
        return automation_disabled();
    }
    let scope = resolve_scope(&state, &headers, &query);
    if !scope.ok {
        return automation_forbidden(&scope);
    }

    let now = now_secs();
    let task_token = extract_task_token(&headers, &query);
    let tasks = match state.store.list_tasks() {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "读取任务失败");
            return write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_failed",
                "Failed to list tasks",
                "读取任务失败",
            );
        }
    };

    let mut views = Vec::new();
    let mut foreign = 0usize;
    for task in &tasks {
        // 列表始终按房间过滤，管理员也一样。
        if clip9_protocol::normalize_room_name(&task.room) != scope.room {
            continue;
        }
        if !task_owned_by(task, &scope, &task_token) {
            foreign += 1;
            continue;
        }
        views.push(task_view(task, now));
    }

    let mut resp = serde_json::json!({
        "room": scope.room,
        "tier": scope.tier,
        "admin": scope.admin,
        "tasks": views,
        "max": room_limit(&scope),
        "now": now,
        "actions": action_list_json(),
        "vars": clip9_core::template::variable_names(),
    });
    if foreign > 0 {
        resp["foreignCount"] = serde_json::json!(foreign);
    }
    json_response(&resp)
}

/// `POST /tasks`（创建或整体更新）。
async fn upsert(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    scope: &AutomationScope,
    body: axum::body::Bytes,
) -> Response {
    let req = match parse_request(&body) {
        Ok(r) => r,
        Err(failure) => return parse_failure_response(failure),
    };

    let mut task = AutomationTask {
        id: req.id.trim().to_owned(),
        // ⚠️ `seq` 由 `Store::put_task` 分配（这里是新建，所以给 0）；
        // 更新时 `upsert_task` 会把已有的序号搬回来。
        seq: 0,
        name: req.name.clone(),
        enabled: req.enabled.unwrap_or(true),
        freq: req.freq.clone(),
        time: req.time.clone(),
        cron: req.cron.clone(),
        by_weekday: req.by_weekday.clone().unwrap_or_default(),
        run_at: req.run_at.clone(),
        tz: req.tz.clone(),
        room: scope.room.clone(), // ⚠️ 房间来自鉴权上下文，不是请求体
        template: req.template.clone(),
        chain: req.chain.clone().unwrap_or_default(),
        keep_history: req.keep_history.unwrap_or(false),
        sender: req.sender.clone(),
        created_at: 0,
        updated_at: 0,
        last_run_key: String::new(),
        last_run_at: 0,
        last_status: String::new(),
        last_error: String::new(),
        last_output: String::new(),
        owner_hash: String::new(),
    };

    // 默认时区写进任务，而不是运行时兜底。
    if task.tz.trim().is_empty() {
        task.tz = default_tz(state);
    }

    let is_new = task.id.is_empty();
    let task_token = extract_task_token(headers, query);
    let mut issued_token = String::new();

    if is_new {
        task.id = uuid::Uuid::new_v4().to_string();
    } else {
        let existing = match state.store.get_task(&task.id) {
            Ok(Some(t)) => t,
            Ok(None) => {
                return write_error(
                    StatusCode::NOT_FOUND,
                    "task_not_found",
                    "Task not found",
                    "任务不存在",
                );
            }
            Err(e) => {
                tracing::error!(error = %e, "读取任务失败");
                return write_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "store_failed",
                    "Failed to read task",
                    "读取任务失败",
                );
            }
        };
        if !task_owned_by(&existing, scope, &task_token) {
            return write_error(
                StatusCode::FORBIDDEN,
                "task_forbidden",
                "Task belongs to someone else",
                "这条任务不是你创建的，无法修改",
            );
        }
        if !scope.admin && clip9_protocol::normalize_room_name(&existing.room) != scope.room {
            return write_error(
                StatusCode::FORBIDDEN,
                "task_forbidden",
                "Task belongs to another room",
                "这条任务属于别的房间",
            );
        }
    }

    if is_new {
        let limit = room_limit(scope);
        if limit > 0 {
            let count = state
                .store
                .list_tasks()
                .map(|ts| {
                    ts.iter()
                        .filter(|t| clip9_protocol::normalize_room_name(&t.room) == scope.room)
                        .count()
                })
                .unwrap_or(0);
            if count >= limit {
                let msg = if scope.tier == AutomationPolicy::Single.as_str() {
                    format!("房间 {} 是公开房间，只允许设置 1 条定时任务", scope.room)
                } else {
                    format!("房间 {} 的定时任务已达到上限 {}", scope.room, limit)
                };
                return write_error(
                    StatusCode::BAD_REQUEST,
                    "task_limit_reached",
                    "Task limit reached",
                    &msg,
                );
            }
        }
    }

    if let Err(e) = normalize_and_validate(&mut task) {
        return write_error(
            StatusCode::BAD_REQUEST,
            "invalid_task",
            "Invalid task",
            &e.to_string(),
        );
    }

    // 正文里引用了别的房间当输入源时，当前凭据得能读它（只在有请求上下文时判）。
    if let Err(e) = check_source_rooms(state, &task.template, scope) {
        return write_error(
            StatusCode::BAD_REQUEST,
            "source_room_forbidden",
            "Source room not readable",
            &e,
        );
    }

    if is_new && scope.tier == AutomationPolicy::Single.as_str() {
        issued_token = taskmod::new_task_token();
        task.owner_hash = taskmod::hash_task_token(&issued_token);
    }

    let now = now_secs();
    if let Err(e) = upsert_task(state, &mut task, now) {
        tracing::error!(error = %e, "保存任务失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "task_save_failed",
            "Failed to save task",
            "保存任务失败",
        );
    }

    let mut resp = serde_json::json!({ "task": task_view(&task, now) });
    if !issued_token.is_empty() {
        resp["taskToken"] = serde_json::json!(issued_token);
    }
    json_response(&resp)
}

/// 新增或整体替换（按 id）。替换时保留 Room / OwnerHash / CreatedAt，触发规则变了清幂等键。
fn upsert_task(state: &AppState, task: &mut AutomationTask, now: i64) -> Result<(), String> {
    if let Ok(Some(existing)) = state.store.get_task(&task.id) {
        task.room = existing.room;
        task.created_at = existing.created_at;
        task.owner_hash = existing.owner_hash;
        // ⚠️ 保留**排序序号** —— 否则每次保存都会把任务挪到列表末尾
        // （`seq == 0` 会被 `put_task` 当成「新建」重新分配）。Go 那边 upsert 是就地替换，
        // 位置同样不变；这条是「列表顺序」能对齐的前提。
        task.seq = existing.seq;
        task.updated_at = now;
        let trigger_changed = existing.freq != task.freq
            || existing.time != task.time
            || existing.run_at != task.run_at
            || existing.by_weekday != task.by_weekday
            || existing.cron != task.cron;
        if trigger_changed {
            task.last_run_key.clear();
        } else {
            task.last_run_key = existing.last_run_key;
            task.last_run_at = existing.last_run_at;
            task.last_status = existing.last_status;
            task.last_error = existing.last_error;
            task.last_output = existing.last_output;
        }
    } else {
        task.created_at = now;
        task.updated_at = now;
    }
    state.store.put_task(task).map_err(|e| e.to_string())
}

/// 模板里引用了别的房间当输入源时，当前凭据得能读它。
fn check_source_rooms(
    state: &AppState,
    template: &str,
    scope: &AutomationScope,
) -> Result<(), String> {
    let (_bare, rooms) = clip9_core::template::latest_rooms(template);
    if rooms.is_empty() {
        return Ok(());
    }
    for room in &rooms {
        if *room == clip9_protocol::normalize_room_name(&scope.room) {
            continue;
        }
        if scope.admin {
            continue;
        }
        let requirement = clip9_core::resolve_room_auth(&state.config, room);
        if !requirement.required {
            continue; // 公开房间：谁都能读
        }
        return Err(format!(
            "正文里的 {{latest:{room}}} 读不了：房间 {room} 需要密码，而定时任务是无人值守的、没有密码可带。只有不需要密码就能读的房间（或任务自己的房间）能作为来源；管理员（持全局密码）可以引用任意房间"
        ));
    }
    Ok(())
}

/// 三个 item 端点共用的鉴权：过了返回 `(task, scope)`，没过返回「直接回它」的响应。
///
/// ⚠️ `Err` 用 `Box<Response>` 而不是裸 `Response`：`Response` 在栈上很大（>128 字节），
/// 每个返回值都要搬它（`clippy::result_large_err`）。项目里 `share.rs` / `auth_token.rs`
/// 同一套写法。
fn resolve_task_item(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    id: &str,
) -> Result<(AutomationTask, AutomationScope), Box<Response>> {
    if !state.config.automation.enabled {
        return Err(Box::new(automation_disabled()));
    }
    let scope = resolve_scope(state, headers, query);
    if !scope.ok {
        return Err(Box::new(automation_forbidden(&scope)));
    }

    let task = state.store.get_task(id).map_err(|e| {
        tracing::error!(error = %e, "读取任务失败");
        Box::new(write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "store_failed",
            "Failed to read task",
            "读取任务失败",
        ))
    })?;
    let Some(task) = task else {
        return Err(Box::new(write_error(
            StatusCode::NOT_FOUND,
            "task_not_found",
            "Task not found",
            "任务不存在",
        )));
    };

    if !scope.admin && clip9_protocol::normalize_room_name(&task.room) != scope.room {
        return Err(Box::new(write_error(
            StatusCode::FORBIDDEN,
            "task_forbidden",
            "Task belongs to another room",
            "这条任务属于别的房间",
        )));
    }
    let task_token = extract_task_token(headers, query);
    if !task_owned_by(&task, &scope, &task_token) {
        return Err(Box::new(write_error(
            StatusCode::FORBIDDEN,
            "task_forbidden",
            "Task belongs to someone else",
            "这条任务不是你创建的",
        )));
    }
    Ok((task, scope))
}

/// `DELETE /tasks/{id}`。
pub async fn task_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Path(id): Path<String>,
) -> Response {
    match resolve_task_item(&state, &headers, &query, &id) {
        Err(resp) => *resp,
        Ok((_task, _scope)) => match state.store.remove_task(&id) {
            Ok(true) => json_response(&serde_json::json!({ "deleted": true, "id": id })),
            Ok(false) => write_error(
                StatusCode::NOT_FOUND,
                "task_not_found",
                "Task not found",
                "任务不存在",
            ),
            Err(e) => {
                tracing::error!(error = %e, "删除任务失败");
                write_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "store_failed",
                    "Failed to delete task",
                    "删除任务失败",
                )
            }
        },
    }
}

/// `POST /tasks/{id}/run`：试跑 / 立即发送。
pub async fn task_run_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Path(id): Path<String>,
) -> Response {
    match resolve_task_item(&state, &headers, &query, &id) {
        Err(resp) => *resp,
        Ok((task, _scope)) => crate::scheduler::task_run(&state, &task, &query).await,
    }
}

/// `POST /tasks/{id}/toggle`：只改开关，其他字段一律不动。
pub async fn task_toggle_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Path(id): Path<String>,
) -> Response {
    match resolve_task_item(&state, &headers, &query, &id) {
        Err(resp) => *resp,
        Ok((task, _scope)) => task_toggle(&state, &task, &query).await,
    }
}

/// `/tasks/{id}*` 上「方法或动作不认识」时的 405。
///
/// ⚠️★ 它**先解析任务**，不是直接回 405 —— Go 那边是「先按 id 找任务，再按
/// (action, method) 分派」，所以任务不存在时给的是 **404 `task_not_found`**。
/// 顺序反过来的话，`GET /tasks/9999` 会从 404 变成 405，而客户端是靠码区分的。
async fn task_unsupported(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    id: &str,
) -> Response {
    match resolve_task_item(state, headers, query, id) {
        Err(resp) => *resp,
        Ok(_) => crate::handlers::unsupported_task_action(),
    }
}

/// `/tasks/{id}` 上方法不对（例如 GET）时的兜底。
pub async fn task_item_fallback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Path(id): Path<String>,
) -> Response {
    task_unsupported(&state, &headers, &query, &id).await
}

/// `/tasks/{id}/<认不出的动作>`。
///
/// ⚠️ 这条路由必须存在：没有它，`/tasks/<id>/whatever` 会落到**静态资源兜底**
/// （拿到一份 HTML、状态码 200）或 axum 的空 body 404 —— 而「错误响应恒 JSON」
/// 是这个项目的契约（`tools/compare-with-go.mjs` 里有一整节钉着它）。
/// 静态段 `/tasks/preview|cron|rooms` 排在它前面，所以不会被这条吞掉。
pub async fn task_unknown_action(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Path((id, _action)): Path<(String, String)>,
) -> Response {
    task_unsupported(&state, &headers, &query, &id).await
}

/// `POST /tasks/{id}/toggle` 的核心：只改开关，其他字段一律不动。
async fn task_toggle(
    state: &AppState,
    task: &AutomationTask,
    query: &HashMap<String, String>,
) -> Response {
    // 默认翻转；带 ?enabled=1|0 则按值设置。
    let enabled = match query.get("enabled").map(String::as_str) {
        Some(raw) => is_truthy(raw),
        None => !task.enabled,
    };

    let mut updated = task.clone();
    updated.enabled = enabled;
    let now = now_secs();
    if let Err(e) = upsert_task(state, &mut updated, now) {
        tracing::error!(error = %e, "保存任务失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "task_save_failed",
            "Failed to save task",
            "保存任务失败",
        );
    }
    json_response(&serde_json::json!({ "task": task_view(&updated, now) }))
}

/// `GET /tasks/cron`：校验 cron 表达式并给出接下来的触发时刻。
pub async fn cron_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !state.config.automation.enabled {
        return automation_disabled();
    }
    let scope = resolve_scope(&state, &headers, &query);
    if !scope.ok {
        return automation_forbidden(&scope);
    }

    let expr = query.get("expr").map(String::as_str).unwrap_or("").trim();
    let tz_name: String = match query.get("tz").map(String::as_str) {
        Some(t) if !t.trim().is_empty() => t.trim().to_owned(),
        _ => default_tz(&state),
    };
    let offset = match taskmod::resolve_tz_offset(&tz_name) {
        Some(o) => o,
        None => {
            return write_error(
                StatusCode::BAD_REQUEST,
                "invalid_timezone",
                "Invalid time zone",
                &format!("无法识别的时区 {tz_name:?}（写法如 Asia/Shanghai）"),
            );
        }
    };

    let mut resp = serde_json::json!({
        "expr": expr,
        "tz": tz_name,
        "valid": false,
        "room": scope.room,
    });

    match clip9_core::cron::CronSpec::parse(expr) {
        Err(e) => {
            resp["error"] = serde_json::json!(e.to_string());
        }
        Ok(spec) => {
            let now = chrono::Utc::now().with_timezone(&offset);
            let next = spec.next_times(now, 5);
            if next.is_empty() {
                resp["error"] = serde_json::json!(
                    "这个表达式在未来算不出任何触发时刻（检查「日」和「月」是不是不可能的组合）"
                );
            } else {
                let unix: Vec<i64> = next.iter().map(|t| t.timestamp()).collect();
                let formatted: Vec<String> = next
                    .iter()
                    .map(|t| t.format("%Y-%m-%d %H:%M %a").to_string())
                    .collect();
                resp["expr"] = serde_json::json!(spec.expression());
                resp["valid"] = serde_json::json!(true);
                resp["next"] = serde_json::json!(unix);
                resp["nextFormatted"] = serde_json::json!(formatted);
                resp["desc"] =
                    serde_json::to_value(spec.describe()).unwrap_or(serde_json::Value::Null);
            }
        }
    }
    json_response(&resp)
}

/// `GET /tasks/rooms`：列出有定时任务的房间（跨房间，只有管理员能拿到全清单）。
pub async fn task_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !state.config.automation.enabled {
        return automation_disabled();
    }
    let scope = resolve_scope(&state, &headers, &query);
    if !scope.ok {
        return automation_forbidden(&scope);
    }

    let tasks = match state.store.list_tasks() {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "读取任务失败");
            return write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_failed",
                "Failed to list tasks",
                "读取任务失败",
            );
        }
    };

    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for task in &tasks {
        let room = clip9_protocol::normalize_room_name(&task.room);
        if room.is_empty() {
            continue;
        }
        if !scope.admin && room != scope.room {
            continue;
        }
        *counts.entry(room).or_default() += 1;
    }
    let rooms: Vec<serde_json::Value> = counts
        .iter()
        .map(|(room, count)| serde_json::json!({ "room": room, "count": count }))
        .collect();

    json_response(&serde_json::json!({
        "room": scope.room,
        "admin": scope.admin,
        "rooms": rooms,
    }))
}

fn is_truthy(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// `POST /tasks/preview`：试算一条**还没保存**的任务（不落盘、无副作用）。
pub async fn task_preview_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if !state.config.automation.enabled {
        return automation_disabled();
    }
    let scope = resolve_scope(&state, &headers, &query);
    if !scope.ok {
        return automation_forbidden(&scope);
    }

    let req = match parse_request(&body) {
        Ok(r) => r,
        Err(failure) => return parse_failure_response(failure),
    };

    let mut draft = AutomationTask {
        id: String::new(),
        // 试算的草稿**不落盘**，所以序号无意义。
        seq: 0,
        name: req.name.clone(),
        enabled: true,
        freq: req.freq.clone(),
        time: req.time.clone(),
        cron: req.cron.clone(),
        by_weekday: req.by_weekday.clone().unwrap_or_default(),
        run_at: req.run_at.clone(),
        tz: req.tz.clone(),
        room: scope.room.clone(),
        template: req.template.clone(),
        chain: req.chain.clone().unwrap_or_default(),
        keep_history: req.keep_history.unwrap_or(false),
        sender: req.sender.clone(),
        created_at: 0,
        updated_at: 0,
        last_run_key: String::new(),
        last_run_at: 0,
        last_status: String::new(),
        last_error: String::new(),
        last_output: String::new(),
        owner_hash: String::new(),
    };
    if draft.tz.trim().is_empty() {
        draft.tz = default_tz(&state);
    }

    if let Err(e) = normalize_and_validate(&mut draft) {
        return write_error(
            StatusCode::BAD_REQUEST,
            "invalid_task",
            "Invalid task",
            &e.to_string(),
        );
    }
    if let Err(e) = check_source_rooms(&state, &draft.template, &scope) {
        return write_error(
            StatusCode::BAD_REQUEST,
            "source_room_forbidden",
            "Source room not readable",
            &e,
        );
    }

    crate::scheduler::task_preview(&state, &draft, &query).await
}

fn automation_disabled() -> Response {
    write_error(
        StatusCode::NOT_FOUND,
        "automation_disabled",
        "Automation is disabled",
        "定时自动化未启用（automation.enabled = false）",
    )
}

fn automation_forbidden(scope: &AutomationScope) -> Response {
    write_error(
        StatusCode::FORBIDDEN,
        "automation_forbidden",
        "Automation is not allowed in this room",
        &format!(
            "房间 {} 未开放自动化（需要该房间的凭据，或由管理员在 roomAuth 里设置 automation）",
            scope.room
        ),
    )
}

/// 把动作库的元数据转成下发的 JSON，**精确复刻 Go `ServerRenderActionList` 的省略规则**：
/// `type` 空（单行输入）不写、`options` 空不写、`params` 空不写、`visibleWhen` nil 不写。
///
/// ⚠️ 这是「下发形状」的契约，所以收在 server 侧（而不是给 `ActionMeta` 加 `Serialize`）——
/// actions crate 的 `ActionMeta` 是纯元数据，不该为「某个端点的省略偏好」绑一份序列化。
fn action_list_json() -> serde_json::Value {
    let mut out = Vec::new();
    for spec in clip9_actions::all_meta() {
        let mut item = serde_json::json!({
            "id": spec.id,
            "group": spec.group,
            "groupKey": spec.group_key,
            "key": spec.key,
        });
        if !spec.params.is_empty() {
            let mut params = Vec::new();
            for p in spec.params {
                let mut param = serde_json::json!({
                    "key": p.key,
                    "labelKey": p.label_key,
                });
                // 空 type = 单行输入（默认），不写。
                if p.kind == clip9_actions::ParamKind::Select {
                    param["type"] = serde_json::json!("select");
                }
                if !p.options.is_empty() {
                    let options: Vec<serde_json::Value> = p
                        .options
                        .iter()
                        .map(|o| serde_json::json!({ "value": o.value, "labelKey": o.label_key }))
                        .collect();
                    param["options"] = serde_json::json!(options);
                }
                if let Some(cond) = p.visible_when {
                    param["visibleWhen"] = serde_json::json!({
                        "key": cond.key,
                        "equals": cond.equals,
                    });
                }
                params.push(param);
            }
            item["params"] = serde_json::json!(params);
        }
        out.push(item);
    }
    serde_json::json!(out)
}
