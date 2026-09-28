//! 契约测试：拿 **Go 跑出来的** `cases/cron/cron.json` 逐条比对。
//!
//! `ARCHITECTURE.md` §8 把 cron 列入 P2 的第一项，而验收标准统一是「Go 侧对应测试的行为」——
//! 那 682 行自写 cron 的语义里全是「读代码看不出来」的边界（日/周 OR、`?` == `*`、
//! 7 也是周日、跨月跳步的近似、闰年、迭代上限兜底），只能靠跑同一组输入去比。
//!
//! ⚠️ fixture 是**冻结的输入**：拆库时从 Go 实现那边带过来，这边**不再重新生成**
//! （理由见 `cases/README.md`）。真要重生成得在 **Go 仓库**里跑：
//!
//! ```bash
//! cd <Go 仓库>/cloud-clip && UPDATE_FIXTURES=1 go test ./lib -run TestCronFixtures
//! cargo test -p clip9-core --test go_cron   # 回到本仓库根跑这个
//! ```
//!
//! ⚠️ 第二个命令红了**不是「测试坏了」**：那是一次行为差异，先想清楚是哪边对。
//! 「下一次触发时刻算得不一样」在定时任务上是真事故（同一个任务在切换前后触发的时间不同）。

use std::path::PathBuf;

use chrono::DateTime;
use clip9_core::cron::CronSpec;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
struct Fixture {
    zone: String,
    parse: Vec<ParseCase>,
    describe: Vec<DescribeCase>,
    occurrences: Vec<OccurrenceCase>,
}

#[derive(Debug, Deserialize)]
struct ParseCase {
    expr: String,
    ok: bool,
    #[serde(default)]
    normalized: String,
    #[serde(default)]
    why: String,
}

#[derive(Debug, Deserialize)]
struct DescribeCase {
    expr: String,
    /// Go marshal 出来的原文 —— 连**键名与 omitempty** 一起比。
    desc: Value,
}

#[derive(Debug, Deserialize)]
struct OccurrenceCase {
    expr: String,
    from: String,
    /// `null` = 算不出（`0 0 30 2 *` 这种语法合法但永远等不到的表达式）。
    next: Option<String>,
    prev: Option<String>,
    next3: Vec<String>,
}

fn fixture() -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../cases/cron/cron.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到 {}（{e}）—— 先在 cloud-clip 里跑 UPDATE_FIXTURES=1 go test ./lib -run TestCronFixtures",
            path.display()
        )
    });
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{} 解析失败: {e}", path.display()))
}

fn at(value: &str) -> DateTime<chrono::FixedOffset> {
    DateTime::parse_from_rfc3339(value)
        .unwrap_or_else(|e| panic!("fixture 里的时刻 {value:?} 不是合法 RFC3339: {e}"))
}

// ── 1. 解析：哪些输入算错，必须与 Go 一致 ──────────────────────────────

/// ⚠️ 这条钉的是**接受与拒绝的边界**，不是错误文案。
///
/// 「宽一点」和「严一点」都是真实的差异：Rust 侧多认一种写法，用户就会看到
/// 「保存成功但永远不触发」；少认一种，用户会看到「Go 那边能存的表达式在这边报错」。
#[test]
fn parse_accepts_and_rejects_exactly_what_go_does() {
    let fixture = fixture();
    assert!(!fixture.parse.is_empty(), "fixture 里一条解析用例都没有");

    let mut checked_ok = 0;
    let mut checked_bad = 0;
    let mut failures = Vec::new();
    for case in &fixture.parse {
        match (CronSpec::parse(&case.expr), case.ok) {
            (Ok(spec), true) => {
                if spec.expression() != case.normalized {
                    failures.push(format!(
                        "{:?} 归一化后是 {:?}，Go 是 {:?}{}",
                        case.expr,
                        spec.expression(),
                        case.normalized,
                        note(&case.why)
                    ));
                }
                checked_ok += 1;
            }
            (Err(error), false) => {
                checked_bad += 1;
                // 顺手钉一条：错误信息要能讲给用户听（带上字段名）——
                // 文案本身不比对，但「只报一句『格式不对』」是不合格的。
                if !error_labels_something(&error.to_string()) {
                    failures.push(format!(
                        "{:?} 的错误信息里没有字段名，用户不知道改哪里：{error}",
                        case.expr
                    ));
                }
            }
            (Ok(spec), false) => failures.push(format!(
                "{:?} 应当被拒绝，这边却解析成功了（归一化后 {:?}）{}",
                case.expr,
                spec.expression(),
                note(&case.why)
            )),
            (Err(error), true) => failures.push(format!(
                "{:?} 应当能解析，这边却报错：{error}{}",
                case.expr,
                note(&case.why)
            )),
        }
    }

    assert!(
        failures.is_empty(),
        "与 Go 的解析边界不一致的有 {} 条：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
    // 两条路都必须真的走到 —— 全部「合法」或全部「非法」都说明 fixture 变成了另一种东西。
    assert!(
        checked_ok > 0 && checked_bad > 0,
        "合法 {checked_ok} 条 / 非法 {checked_bad} 条，一边空着？"
    );
}

fn note(why: &str) -> String {
    if why.is_empty() {
        String::new()
    } else {
        format!("\n    备注: {why}")
    }
}

/// 错误信息里有没有带上字段名（分钟 / 小时 / 日 / 月 / 星期）。
fn error_labels_something(message: &str) -> bool {
    [
        "分钟",
        "小时",
        "日字段",
        "月字段",
        "星期",
        "5 个字段",
        "不能为空",
    ]
    .iter()
    .any(|label| message.contains(label))
}

// ── 2. 「翻译」：形状与 JSON 一起比 ────────────────────────────────────

/// ⚠️ 比的是 **Go marshal 出来的 JSON**，不是「结构体看起来差不多」。
///
/// 那一页读的就是这串 JSON：`mode` 必须**始终**出现、`times` 没有就不许出现（`omitempty`）、
/// `dayN` 与 `n` 是两个不同的 N。用结构体对比会把这些约定整个漏掉。
#[test]
fn description_matches_go_json_exactly() {
    let fixture = fixture();
    assert!(!fixture.describe.is_empty(), "fixture 里一条描述用例都没有");

    let mut failures = Vec::new();
    for case in &fixture.describe {
        let spec = CronSpec::parse(&case.expr)
            .unwrap_or_else(|e| panic!("描述用例 {:?} 解析失败: {e}", case.expr));
        let ours = serde_json::to_value(spec.describe())
            .unwrap_or_else(|e| panic!("{:?} 的描述序列化失败: {e}", case.expr));
        if ours != case.desc {
            failures.push(format!(
                "{:?}\n    Go  : {}\n    Rust: {}",
                case.expr, case.desc, ours
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "描述与 Go 不一致的有 {} 条：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
}

/// ★ 「翻译」里**绝不能出现表达式语法**：`*` / `/` / `?` 一个都不许露。
///
/// 这是那段「翻译」唯一不能破的规矩 —— 把 `*/3` 说成「每月 */3 日」不是描述，
/// 是把代码念了一遍；读不出来就该退回 `unknown`，让界面说「请看具体时刻」。
/// Go 侧也有一条同名测试，这条是它的 Rust 版：**两边都不许漏**。
#[test]
fn description_never_leaks_expression_syntax() {
    let fixture = fixture();
    let mut leaks = Vec::new();
    for case in &fixture.describe {
        let spec = CronSpec::parse(&case.expr).expect("描述用例应当能解析");
        let desc = serde_json::to_value(spec.describe()).expect("描述应当能序列化");
        for field in ["minutes", "hours", "dom", "month"] {
            let text = desc.get(field).and_then(Value::as_str).unwrap_or("");
            if text.contains('*') || text.contains('/') || text.contains('?') {
                leaks.push(format!("{:?} 的 {field} 漏出了 {text:?}", case.expr));
            }
        }
        if let Some(times) = desc.get("times").and_then(Value::as_array) {
            for time in times.iter().filter_map(Value::as_str) {
                if time.contains('*') || time.contains('/') || time.contains('?') {
                    leaks.push(format!("{:?} 的 times 漏出了 {time:?}", case.expr));
                }
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "描述里漏出了表达式语法：\n  - {}",
        leaks.join("\n  - ")
    );
}

// ── 3. 求时刻：逐条比对 ───────────────────────────────────────────────

#[test]
fn next_prev_and_upcoming_times_match_go() {
    let fixture = fixture();
    assert!(
        !fixture.occurrences.is_empty(),
        "fixture 里一条求时刻用例都没有"
    );

    let mut checked_next = 0;
    let mut checked_none = 0;
    let mut failures = Vec::new();
    for case in &fixture.occurrences {
        let spec = CronSpec::parse(&case.expr)
            .unwrap_or_else(|e| panic!("求时刻用例 {:?} 解析失败: {e}", case.expr));
        let from = at(&case.from);

        let next = spec.next(from).map(|t| t.to_rfc3339());
        if next != case.next {
            failures.push(format!(
                "{:?} 从 {} 的 next\n    Go  : {:?}\n    Rust: {:?}",
                case.expr, case.from, case.next, next
            ));
        }
        if case.next.is_none() {
            checked_none += 1;
        } else {
            checked_next += 1;
        }

        let prev = spec.prev(from).map(|t| t.to_rfc3339());
        if prev != case.prev {
            failures.push(format!(
                "{:?} 从 {} 的 prev\n    Go  : {:?}\n    Rust: {:?}",
                case.expr, case.from, case.prev, prev
            ));
        }

        // `next3` 只在 fixture 里标了的那几条上有值（其余是空数组，不代表「应该为空」）。
        if !case.next3.is_empty() {
            let ours: Vec<String> = spec
                .next_times(from, 3)
                .into_iter()
                .map(|t| t.to_rfc3339())
                .collect();
            if ours != case.next3 {
                failures.push(format!(
                    "{:?} 从 {} 的连续 3 个时刻\n    Go  : {:?}\n    Rust: {:?}",
                    case.expr, case.from, case.next3, ours
                ));
            }
        }
    }

    assert!(
        failures.is_empty(),
        "与 Go 不一致的有 {} 条：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
    assert!(
        checked_next > 0 && checked_none > 0,
        "「算得出」{checked_next} 条 / 「算不出」{checked_none} 条 —— 一侧空着说明 fixture 少了一类"
    );
}

/// fixture 里的时刻串必须带**固定**偏移，否则同一份用例会在不同机器上给出不同结论。
///
/// （Go 自己的 `cron_test.go` 用 `time.Local` 是安全的 —— 它比的是墙上时间；
/// 而 fixture 要把时刻写成 RFC3339 交给这边，跟着机器时区漂就是**假绿**。）
#[test]
fn fixture_pins_the_zone_instead_of_using_the_machines() {
    let fixture = fixture();
    assert_eq!(
        fixture.zone, "+08:00",
        "fixture 应当固定东八区（任务默认时区）"
    );
    for case in &fixture.occurrences {
        assert!(
            case.from.ends_with("+08:00"),
            "{} 的基准时刻没带固定偏移：{}",
            case.expr,
            case.from
        );
    }
}
