//! 定时任务的契约测试：读 Go 跑出来的 `cases/task/task.json`，逐条比对。
//!
//! 与 cron / render 的契约测试同一套思路：期望值是 Go 的 `task.go` 在固定时区、
//! 固定 now 下跑出来的。这里读同一份输入、比同一份输出。

use chrono::DateTime;
use clip9_core::task::{AutomationTask, ChainStep, normalize_and_validate};
use serde::Deserialize;

fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cases/task")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Occurrence {
    expr: String,
    freq: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    cron: String,
    #[serde(default)]
    by_weekday: Option<Vec<u32>>,
    #[serde(default)]
    run_at: String,
    #[allow(dead_code)]
    now: String,
    #[serde(default)]
    next: Option<i64>,
    #[serde(default)]
    due: Option<i64>,
    #[serde(default)]
    due_key: String,
    #[serde(default)]
    next_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateInput {
    #[serde(default)]
    name: String,
    freq: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    cron: String,
    #[serde(default)]
    by_weekday: Option<Vec<u32>>,
    #[serde(default)]
    run_at: String,
    #[serde(default)]
    tz: String,
    template: String,
    #[serde(default)]
    chain: Option<Vec<ChainStep>>,
    #[serde(default)]
    sender: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Validate {
    name: String,
    input: ValidateInput,
    ok: bool,
    #[serde(default)]
    freq: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    cron: String,
    #[serde(default)]
    by_weekday: Option<Vec<u32>>,
    #[serde(default)]
    run_at: String,
    #[serde(default)]
    name_out: String,
    #[serde(default)]
    sender_out: String,
}

#[derive(Deserialize)]
struct TaskFile {
    #[allow(dead_code)]
    tz: String,
    now: String,
    occurrences: Vec<Occurrence>,
    validates: Vec<Validate>,
}

fn load() -> TaskFile {
    let path = fixture_dir().join("task.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到 {}（{e}）—— 先在 cloud-clip 里跑 UPDATE_FIXTURES=1 go test ./lib -run TestTaskFixtures",
            path.display()
        )
    });
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{} 解析失败: {e}", path.display()))
}

fn occurrence_task(o: &Occurrence) -> AutomationTask {
    AutomationTask {
        id: String::new(),
        name: String::new(),
        enabled: true,
        freq: o.freq.clone(),
        time: o.time.clone(),
        cron: o.cron.clone(),
        by_weekday: o.by_weekday.clone().unwrap_or_default(),
        run_at: o.run_at.clone(),
        tz: "Asia/Shanghai".to_owned(),
        room: "home".to_owned(),
        template: "x".to_owned(),
        chain: Vec::new(),
        keep_history: false,
        sender: String::new(),
        created_at: 0,
        updated_at: 0,
        last_run_key: String::new(),
        last_run_at: 0,
        last_status: String::new(),
        last_error: String::new(),
        last_output: String::new(),
        owner_hash: String::new(),
    }
}

#[test]
fn occurrences_match_go() {
    let fixture = load();
    let now: DateTime<chrono::FixedOffset> =
        DateTime::parse_from_rfc3339(&fixture.now).expect("fixture 的 now 必须是合法 RFC3339");

    let mut failures = Vec::new();
    for o in &fixture.occurrences {
        let task = occurrence_task(o);

        let next = task.next_run_after(now).map(|t| t.timestamp());
        let due = task.due_occurrence(now).map(|t| t.timestamp());
        let next_key = task
            .next_run_after(now)
            .map(|t| task.run_key(t))
            .unwrap_or_default();
        let due_key = task
            .due_occurrence(now)
            .map(|t| task.run_key(t))
            .unwrap_or_default();

        if next != o.next {
            failures.push(format!("{} 的 next：Go={:?} Rust={next:?}", o.expr, o.next));
        }
        if due != o.due {
            failures.push(format!("{} 的 due：Go={:?} Rust={due:?}", o.expr, o.due));
        }
        if next_key != o.next_key {
            failures.push(format!(
                "{} 的 nextKey：Go={:?} Rust={next_key:?}",
                o.expr, o.next_key
            ));
        }
        if due_key != o.due_key {
            failures.push(format!(
                "{} 的 dueKey：Go={:?} Rust={due_key:?}",
                o.expr, o.due_key
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "和 Go 不一致的有 {} 条：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
}

#[test]
fn validation_matches_go() {
    let fixture = load();
    let mut failures = Vec::new();

    for v in &fixture.validates {
        let input = &v.input;
        let mut task = AutomationTask {
            id: String::new(),
            name: input.name.clone(),
            enabled: true,
            freq: input.freq.clone(),
            time: input.time.clone(),
            cron: input.cron.clone(),
            by_weekday: input.by_weekday.clone().unwrap_or_default(),
            run_at: input.run_at.clone(),
            tz: if input.tz.is_empty() {
                "Asia/Shanghai".to_owned()
            } else {
                input.tz.clone()
            },
            room: "home".to_owned(),
            template: input.template.clone(),
            chain: input.chain.clone().unwrap_or_default(),
            keep_history: false,
            sender: input.sender.clone(),
            created_at: 0,
            updated_at: 0,
            last_run_key: String::new(),
            last_run_at: 0,
            last_status: String::new(),
            last_error: String::new(),
            last_output: String::new(),
            owner_hash: String::new(),
        };

        let result = normalize_and_validate(&mut task);
        match (result, v.ok) {
            (Ok(()), true) => {
                if task.freq != v.freq {
                    failures.push(format!(
                        "{} 的 freq：Go={:?} Rust={:?}",
                        v.name, v.freq, task.freq
                    ));
                }
                if task.time != v.time {
                    failures.push(format!(
                        "{} 的 time：Go={:?} Rust={:?}",
                        v.name, v.time, task.time
                    ));
                }
                if task.cron != v.cron {
                    failures.push(format!(
                        "{} 的 cron：Go={:?} Rust={:?}",
                        v.name, v.cron, task.cron
                    ));
                }
                if task.by_weekday != v.by_weekday.clone().unwrap_or_default() {
                    failures.push(format!(
                        "{} 的 byWeekday：Go={:?} Rust={:?}",
                        v.name, v.by_weekday, task.by_weekday
                    ));
                }
                if task.run_at != v.run_at {
                    failures.push(format!(
                        "{} 的 runAt：Go={:?} Rust={:?}",
                        v.name, v.run_at, task.run_at
                    ));
                }
                if task.name != v.name_out {
                    failures.push(format!(
                        "{} 的 nameOut：Go={:?} Rust={:?}",
                        v.name, v.name_out, task.name
                    ));
                }
                if task.sender != v.sender_out {
                    failures.push(format!(
                        "{} 的 senderOut：Go={:?} Rust={:?}",
                        v.name, v.sender_out, task.sender
                    ));
                }
            }
            (Ok(()), false) => {
                failures.push(format!("{} 期望报错却成功", v.name));
            }
            (Err(_), true) => {
                failures.push(format!("{} 期望成功却报错", v.name));
            }
            (Err(_), false) => {
                // 两边都报错 —— 对的（错误文案本来就可以不同）。
            }
        }
    }

    assert!(
        failures.is_empty(),
        "和 Go 不一致的有 {} 条：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
}
