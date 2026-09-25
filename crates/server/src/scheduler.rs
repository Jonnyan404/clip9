//! 定时任务的调度器：谁在什么时候该跑、跑完记什么、怎么投递。
//!
//! 对应 Go 的 `scheduler.go`（调度）与 `automation_source.go`（`{{latest}}` 来源）。

use std::collections::HashMap;

use axum::http::StatusCode;
use axum::response::Response;

use clip9_core::task::{AutomationTask, FREQ_ONCE};
use clip9_core::template::RenderContext;
use clip9_protocol::{ReceiveBase, ReceiveHolder, TextReceive};

use crate::error::write_error;
use crate::handlers::json_response;
use crate::state::{AppState, now_secs};

/// 取某个房间里最新一条**人发的**文本消息。
///
/// 跳过三类：文件消息、`source == "automation"` 的消息（防回环）、空正文。
fn latest_room_text(state: &AppState, room: &str) -> Option<String> {
    let normalized = clip9_protocol::normalize_room_name(room);
    let recent = state.store.recent_desc(&normalized, 64).ok()?;
    for entry in recent {
        let ReceiveHolder::Text(t) = entry else {
            continue;
        };
        if t.base.source == "automation" {
            continue;
        }
        if t.content.trim().is_empty() {
            continue;
        }
        return Some(t.content);
    }
    None
}

/// 算正文 → 跑动作链 → 投递。`dry_run` 时只算不发。
///
/// `scheduled` 是**预定**触发时刻，不是实际发送时刻。
fn execute(
    state: &AppState,
    task: &AutomationTask,
    scheduled: chrono::DateTime<chrono::FixedOffset>,
    dry_run: bool,
) -> Result<String, String> {
    let offset = task.tz_offset().map_err(|e| e.to_string())?;
    let scheduled = scheduled.with_timezone(&offset);

    let latest = |room: &str| latest_room_text(state, room);
    let ctx = RenderContext {
        now: scheduled,
        task: &task.name,
        room: &task.room,
        latest: Some(&latest),
    };

    let mut rendered =
        clip9_core::template::render(&task.template, &ctx).map_err(|e| e.to_string())?;

    if !task.chain.is_empty() {
        let steps: Vec<clip9_actions::ChainStep> = task
            .chain
            .iter()
            .map(|s| clip9_actions::ChainStep {
                id: s.id().to_owned(),
                params: match s {
                    clip9_core::task::ChainStep::WithParams { params, .. } => {
                        params.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
                    }
                    clip9_core::task::ChainStep::Id(_) => std::collections::BTreeMap::new(),
                },
            })
            .collect();
        let action_ctx = clip9_actions::ActionContext {
            now: scheduled,
            task: task.name.clone(),
            room: task.room.clone(),
        };
        rendered =
            clip9_actions::run_chain(&rendered, &steps, &action_ctx).map_err(|e| e.to_string())?;
    }

    // 正文上限在**展开之后**再校验一次。
    let limit = state.config.text.limit;
    if limit > 0 && rendered.len() as i64 > limit {
        return Err(format!(
            "渲染后的正文超出限制 ({} > {})",
            rendered.len(),
            limit
        ));
    }

    if dry_run {
        return Ok(rendered);
    }

    deliver(state, task, &rendered, scheduled);
    Ok(rendered)
}

/// 投递一条定时消息。
fn deliver(
    state: &AppState,
    task: &AutomationTask,
    rendered: &str,
    scheduled: chrono::DateTime<chrono::FixedOffset>,
) {
    let scheduled_at = scheduled.timestamp();
    let late = now_secs() - scheduled_at > state.config.automation.grace_seconds;

    let mut entry = ReceiveHolder::Text(TextReceive {
        base: ReceiveBase {
            kind: "text".to_owned(),
            room: task.room.clone(),
            timestamp: now_secs(),
            sender_ip: String::new(),
            sender_device: Some(HashMap::from([
                ("name".to_owned(), task.sender.clone()),
                ("type".to_owned(), "Automation".to_owned()),
            ])),
            sender_client_id: String::new(),
            column: String::new(),
            source: "automation".to_owned(),
            scheduled_at,
            late,
            ..ReceiveBase::default()
        },
        content: rendered.to_owned(),
        ..TextReceive::default()
    });

    if task.keep_history {
        if let Ok(inserted) = state.store.insert(entry.clone()) {
            entry = inserted;
        }
    } else {
        // 临时消息：走同一个计数器，但不落 List、不计房间统计。
        if let Ok(id) = state.store.next_ephemeral_id() {
            entry.set_id(id);
        }
    }

    state.broadcast("receive", &entry, &task.room);
}

/// 扫一遍任务：该跑的跑、错过的记跳过。
pub fn run_due(state: &AppState, now: chrono::DateTime<chrono::FixedOffset>) {
    let tasks = match state.store.list_tasks() {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "读取任务失败");
            return;
        }
    };
    let grace = state.config.automation.grace_seconds;

    for task in tasks {
        if !task.enabled {
            continue;
        }
        let Some(occurrence) = task.due_occurrence(now) else {
            continue;
        };
        let key = task.run_key(occurrence);
        if key == task.last_run_key {
            continue; // 这一趟已经跑过了
        }
        let late = now.timestamp() - occurrence.timestamp() > grace;

        if late {
            tracing::info!(
                name = %task.name,
                id = %task.id,
                "错过触发窗口，跳过不补发"
            );
            record_run(
                state,
                &task.id,
                &key,
                "skipped",
                "错过触发窗口，未补发",
                "",
                task.freq == FREQ_ONCE,
            );
            continue;
        }

        let output = execute(state, &task, occurrence, false);
        match &output {
            Ok(rendered) => {
                tracing::info!(name = %task.name, id = %task.id, room = %task.room, "已投递");
                record_run(
                    state,
                    &task.id,
                    &key,
                    "ok",
                    "",
                    rendered,
                    task.freq == FREQ_ONCE,
                );
            }
            Err(e) if is_empty_source(e) => {
                // 来源房间此刻没有素材 —— 常态，不是任务坏了。记 skipped 不是 error。
                record_run(
                    state,
                    &task.id,
                    &key,
                    "skipped",
                    e,
                    "",
                    task.freq == FREQ_ONCE,
                );
            }
            Err(e) => {
                tracing::warn!(name = %task.name, id = %task.id, error = %e, "执行失败");
                record_run(
                    state,
                    &task.id,
                    &key,
                    "error",
                    e,
                    "",
                    task.freq == FREQ_ONCE,
                );
            }
        }
    }
}

fn is_empty_source(e: &str) -> bool {
    // TemplateError::EmptySource 的 Display 是「来源房间没有可用消息（房间 X）」。
    e.starts_with("来源房间没有可用消息")
}

/// 落一次执行结果。
fn record_run(
    state: &AppState,
    id: &str,
    run_key: &str,
    status: &str,
    err_text: &str,
    output: &str,
    disable: bool,
) {
    let Ok(Some(mut task)) = state.store.get_task(id) else {
        return;
    };
    task.last_run_key = run_key.to_owned();
    task.last_run_at = now_secs();
    task.last_status = status.to_owned();
    task.last_error = err_text.to_owned();
    if !output.is_empty() {
        task.last_output = output.to_owned();
    }
    if disable {
        task.enabled = false;
    }
    task.updated_at = now_secs();
    if let Err(e) = state.store.put_task(&task) {
        tracing::error!(error = %e, "记录执行结果失败");
    }
}

/// `POST /tasks/{id}/run`：试跑（默认只算不发）或立即发送（`?send=1`）。
pub async fn task_run(
    state: &AppState,
    task: &AutomationTask,
    query: &HashMap<String, String>,
) -> Response {
    let send = query.get("send").map(|v| is_truthy(v)).unwrap_or(false);

    if send {
        let offset = task
            .tz_offset()
            .unwrap_or_else(|_| clip9_core::task::default_tz_offset());
        let now = chrono::DateTime::from_timestamp(now_secs(), 0)
            .map(|t| t.with_timezone(&offset))
            .unwrap_or_else(|| {
                chrono::DateTime::from_timestamp(0, 0)
                    .unwrap()
                    .with_timezone(&offset)
            });
        match execute(state, task, now, false) {
            Ok(output) => json_response(&serde_json::json!({
                "sent": true,
                "output": output,
                "taskId": task.id,
                "room": task.room,
                "keepHistory": task.keep_history,
                "sentAt": now_secs(),
            })),
            Err(e) => write_error(
                StatusCode::BAD_REQUEST,
                "render_failed",
                "Render failed",
                &e,
            ),
        }
    } else {
        // 试跑基准默认取**下次触发时刻**，而不是「现在」。
        let offset = task
            .tz_offset()
            .unwrap_or_else(|_| clip9_core::task::default_tz_offset());
        let now = chrono::DateTime::from_timestamp(now_secs(), 0)
            .unwrap()
            .with_timezone(&offset);
        let reference = task.next_run_after(now).unwrap_or(now);

        match execute(state, task, reference, true) {
            Ok(output) => json_response(&serde_json::json!({
                "preview": true,
                "output": output,
                "taskId": task.id,
                "room": task.room,
                "keepHistory": task.keep_history,
                "referenceAt": reference.timestamp(),
                "nextRunAt": task.next_run_at(now),
                "scheduledAt": reference.to_rfc3339(),
            })),
            Err(e) => write_error(
                StatusCode::BAD_REQUEST,
                "render_failed",
                "Render failed",
                &e,
            ),
        }
    }
}

/// `POST /tasks/preview`：试算一条还没保存的任务。
pub async fn task_preview(
    state: &AppState,
    task: &AutomationTask,
    _query: &HashMap<String, String>,
) -> Response {
    let offset = task
        .tz_offset()
        .unwrap_or_else(|_| clip9_core::task::default_tz_offset());
    let now = chrono::DateTime::from_timestamp(now_secs(), 0)
        .unwrap()
        .with_timezone(&offset);
    let reference = task.next_run_after(now).unwrap_or(now);

    match execute(state, task, reference, true) {
        Ok(output) => json_response(&serde_json::json!({
            "preview": true,
            "output": output,
            "room": task.room,
            "keepHistory": false,
            "referenceAt": reference.timestamp(),
            "nextRunAt": task.next_run_at(now),
            "referenceAt2": reference.to_rfc3339(),
        })),
        Err(e) => write_error(
            StatusCode::BAD_REQUEST,
            "render_failed",
            "Render failed",
            &e,
        ),
    }
}

fn is_truthy(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// 启动调度器的后台 ticker。重复调用是安全的（内部有 `Once` 守卫）。
///
/// ⚠️ 用 `tokio::task::spawn` + `tokio::time::interval`，不是独立线程 ——
/// 投递会写 store 和广播（都是 `Send + Sync`），在 tokio 里做更顺。
pub fn spawn(state: std::sync::Arc<AppState>) {
    if !state.config.automation.enabled {
        tracing::info!("定时自动化未启用（automation.enabled = false）");
        return;
    }

    let tick_seconds = state.config.automation.tick_seconds.max(1);
    let grace = state.config.automation.grace_seconds;
    let default_tz = state.config.automation.default_tz.clone();
    tracing::info!(tick_seconds, grace, default_tz, "定时自动化已启用");

    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(tick_seconds as u64));
        // 第一个 tick 立刻触发，别等一个周期。
        interval.tick().await;
        loop {
            interval.tick().await;
            let now = now_secs();
            let offset = clip9_core::task::resolve_tz_offset(&default_tz)
                .unwrap_or_else(clip9_core::task::default_tz_offset);
            let now = chrono::DateTime::from_timestamp(now, 0)
                .map(|t| t.with_timezone(&offset))
                .unwrap_or_else(|| {
                    chrono::DateTime::from_timestamp(0, 0)
                        .unwrap()
                        .with_timezone(&offset)
                });
            run_due(&state, now);
        }
    });
}
