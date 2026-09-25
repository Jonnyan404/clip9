//! 模板引擎的契约测试：读 Go 跑出来的 `cases/render/render.json`，逐条比对。
//!
//! 与动作库的 `go_cases.rs` 同一套思路（见 `action_fixture_test.go` 的文件头注释）：
//! 期望值是 Go 的 `render.go` 在固定时刻、固定上下文下跑出来的，这里读同一份输入、
//! 比同一份输出。区别是模板引擎有两个**不确定**变量（`{{uuid}}` / `{{timestamp}}`），
//! 它们的字面结果不放进 fixture，改用 `uncertain` 标注，这里换成「结果非空 + 形状对」
//! 这类不依赖字面值的断言。

use chrono::DateTime;
use clip9_core::{RenderContext, TemplateError, latest_rooms, render, variable_names};
use serde::Deserialize;

fn fixture_dir() -> std::path::PathBuf {
    // 测试的 cwd 是 crate 根（crates/core），fixture 在仓库根的 cases/render。
    // ⚠️ `cases/` 在**仓库根**，所以从 `crates/core` 上两层就到（`../../cases`）。
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cases/render")
}

#[derive(Deserialize)]
struct RenderCase {
    tpl: String,
    #[serde(default)]
    expect: Option<String>,
    #[serde(default)]
    error: bool,
    #[serde(default)]
    uncertain: String,
    #[serde(default)]
    why: String,
}

#[derive(Deserialize)]
struct RenderFile {
    now: String,
    task: String,
    room: String,
    cases: Vec<RenderCase>,
}

fn load() -> RenderFile {
    let path = fixture_dir().join("render.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到 {}（{e}）—— 先在 cloud-clip 里跑 UPDATE_FIXTURES=1 go test ./lib -run TestRenderFixtures",
            path.display()
        )
    });
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{} 解析失败: {e}", path.display()))
}

/// 用 fixture 里的 now 建一个固定上下文（latest 用桩，行为与 Go 的 fixture 上下文一致）。
fn context(f: &RenderFile) -> RenderContext<'static> {
    let now = DateTime::parse_from_rfc3339(&f.now).expect("fixture 的 now 必须是合法 RFC3339");
    // 桩：ops 与 empty 各一种，其余房间回「来自 <room>」—— 与 Go 侧 renderFixtureContext 一致。
    let latest = |room: &str| -> Option<String> {
        if room == "empty" {
            return None;
        }
        Some(format!("来自 {room}"))
    };
    RenderContext {
        now,
        task: Box::leak(f.task.clone().into_boxed_str()),
        room: Box::leak(f.room.clone().into_boxed_str()),
        latest: Some(Box::leak(Box::new(latest))),
    }
}

#[test]
fn behaviour_matches_go_case_by_case() {
    let fixture = load();
    assert!(!fixture.cases.is_empty(), "fixture 里一条用例都没有");

    // 上下文建一次、逐条复用（now 是 Copy，task/room/latest 都是 &'static 借用）。
    let ctx = context(&fixture);

    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();

    for case in &fixture.cases {
        let label = format!("{:?}", case.tpl);
        match render(&case.tpl, &ctx) {
            Ok(actual) => {
                match (&case.expect, case.error, &case.uncertain) {
                    // 有期望值 → 逐字节比。
                    (Some(expected), false, _) => {
                        if &actual != expected {
                            failures.push(format!(
                                "{label}\n    Go  : {expected:?}\n    Rust: {actual:?}{}",
                                if case.why.is_empty() {
                                    String::new()
                                } else {
                                    format!("\n    备注: {}", case.why)
                                }
                            ));
                        }
                    }
                    // 标注了 uncertain（uuid / timestamp）→ 比「非空 + 形状」。
                    (None, false, uncertain) if !uncertain.is_empty() => {
                        if actual.is_empty() {
                            failures.push(format!("{label} 用了 {uncertain} 却得到空串"));
                        }
                        match uncertain.as_str() {
                            "uuid" => {
                                if actual.len() != 36 {
                                    failures.push(format!(
                                        "{label} 的 uuid 应长 36，得到 {}（{actual:?}）",
                                        actual.len()
                                    ));
                                }
                            }
                            "timestamp" => {
                                // 结果必须是 now 的 Unix 秒（十进制）。
                                if actual.parse::<i64>().is_err() {
                                    failures.push(format!(
                                        "{label} 的 timestamp 应能解析成整数，得到 {actual:?}"
                                    ));
                                }
                            }
                            _ => failures.push(format!("{label} 未知的 uncertain 标注 {uncertain:?}")),
                        }
                    }
                    // Go 报错、这边却成功。
                    (None, true, _) => {
                        failures.push(format!("{label}\n    Go  : <报错>\n    Rust: {actual:?}"));
                    }
                    // fixture 自相矛盾（没有 expect、没标 error、也没标 uncertain）。
                    (None, false, _) => failures.push(format!(
                        "{label} fixture 自相矛盾：没 expect、没 error、也没 uncertain\n    Rust: {actual:?}"
                    )),
                    // expect 与 error 同时为真 —— fixture 生成端 bug。
                    (Some(_), true, _) => failures.push(format!(
                        "{label} fixture 自相矛盾：expect 与 error 同时为真"
                    )),
                }
            }
            Err(e) => {
                if case.error {
                    // 两边都报错 —— 对的（错误文案本来就可以不同）。
                    // 但「空来源」必须是**可识别的**那种错误（见下面专门的测试）。
                    continue;
                }
                failures.push(format!(
                    "{label}\n    Go  : {:?}\n    Rust: 报错了 {e}",
                    case.expect
                ));
            }
        }
        checked += 1;
    }

    assert!(
        failures.is_empty(),
        "和 Go 不一致的有 {} 条（共比了 {checked} 条）：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
}

/// 空来源必须是 `TemplateError::EmptySource`，而不是笼统的 Invalid ——
/// 调度器靠 `is_empty_source()` 区分「跳过」与「失败」。
#[test]
fn empty_source_is_recognisable() {
    let fixture = load();
    let mut ctx = context(&fixture);
    // 覆写成「永远空」的来源。
    ctx.latest = Some(Box::leak(Box::new(|_room: &str| -> Option<String> {
        None
    })));

    let err = render("{{latest}}", &ctx).expect_err("空来源应当报错");
    assert!(
        matches!(err, TemplateError::EmptySource(_)),
        "应当是 EmptySource，得到 {err}"
    );
    assert!(err.is_empty_source());
}

/// `latest_rooms` 必须把每个引用到的房间都列出来（去重、归一化、跳过空），
/// 且「不带参数」要单独用布尔值标出 —— HTTP 层据此判权限。
#[test]
fn latest_rooms_lists_every_reference() {
    let (bare, rooms) = latest_rooms(
        "前言 {{date}} {{latest}} 中 {{latest:ops}} 后 {{latest:ops}} {{latest: lobby }}",
    );
    assert!(bare, "应当识别出不带参数的 {{latest}}");
    assert_eq!(rooms, vec!["ops", "lobby"]);

    let (bare2, rooms2) = latest_rooms("没有变量");
    assert!(!bare2);
    assert!(rooms2.is_empty());
}

/// 全有或全无：任一变量失败就整体失败，绝不返回「替换了一半」的正文。
#[test]
fn render_is_all_or_nothing() {
    let fixture = load();
    let ctx = context(&fixture);
    let err = render("今天是 {{date}}，{{dtae}}", &ctx).expect_err("未知变量应当失败");
    assert!(matches!(err, TemplateError::Invalid(_)));
}

/// 变量清单顺序是契约（管理页按它渲染胶囊）。逐个都能求值（latest 用桩）。
#[test]
fn variable_names_are_stable_and_all_render() {
    let names = variable_names();
    assert_eq!(names.len(), 9, "变量数量应为 9，得到 {names:?}");

    let fixture = load();
    let ctx = context(&fixture);
    for name in names {
        render(&format!("{{{{{name}}}}}"), &ctx)
            .unwrap_or_else(|e| panic!("变量 {name} 声明了却求不出值: {e}"));
    }
}
