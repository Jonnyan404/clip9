//! 契约测试：拿 **Go 跑出来的** `cases/actions/*.json` 逐条比对。
//!
//! 为什么不能只靠 Rust 自己的单测：这个 crate 存在的理由是「一份实现两端跑」，
//! 而它的**行为基准仍然是 Go**（`ARCHITECTURE.md` §5.4）。自己测自己只能证明「我没改坏」，
//! 证明不了「和现有的那个实现一样」—— 而后者才是切换时不出现「同一个任务、两个结果」的前提。
//!
//! fixture 由 `cloud-clip/lib/action_fixture_test.go` 生成：
//!
//! ```bash
//! cd ../cloud-clip && UPDATE_FIXTURES=1 go test ./lib -run TestActionFixtures
//! cd ../rust && cargo test -p clip9-actions
//! ```
//!
//! ⚠️ 第二个命令红了**不是「测试坏了」**：那是一次行为差异，先想清楚是哪边对。
//! 左边（Rust）对 → 把差异写成刻意的（并且要在注释里说清为什么）；
//! 右边（Go）对 → 改这边的实现。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use clip9_actions::registry::{
    all_meta, group_enabled, is_implemented, meta, not_yet_implemented, run,
};
use clip9_actions::{ActionContext, ParamKind};
use serde::Deserialize;

// ── fixture 的形状（与 Go 那边的结构体一一对应）────────────────────────

#[derive(Debug, Deserialize)]
struct RegistryFile {
    actions: Vec<Spec>,
    #[serde(rename = "i18nKeys")]
    i18n_keys: Vec<String>,
    #[serde(rename = "countHint")]
    count_hint: usize,
}

#[derive(Debug, Deserialize)]
struct Spec {
    id: String,
    group: String,
    #[serde(rename = "groupKey")]
    group_key: String,
    key: String,
    params: Vec<SpecParam>,
}

#[derive(Debug, Deserialize)]
struct SpecParam {
    key: String,
    #[serde(rename = "labelKey")]
    label_key: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    options: Vec<SpecOption>,
    #[serde(rename = "visibleWhen", default)]
    visible_when: Option<SpecCondition>,
}

#[derive(Debug, Deserialize)]
struct SpecOption {
    value: String,
    #[serde(rename = "labelKey")]
    label_key: String,
}

#[derive(Debug, Deserialize)]
struct SpecCondition {
    key: String,
    equals: String,
}

#[derive(Debug, Deserialize)]
struct CasesFile {
    context: FixtureContext,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct FixtureContext {
    /// RFC3339，带 `+08:00` —— 时间类动作的输出跟着它走。
    now: String,
    task: String,
    room: String,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    input: String,
    #[serde(default)]
    params: BTreeMap<String, String>,
    /// ⚠️ `Option` 而不是 `String`：**空串是合法结果**（`encode.hex.decode` 拿到 `"  "` 就是），
    /// 用 `String` 的话「成功但结果为空」和「报错」分不开。
    expect: Option<String>,
    #[serde(default)]
    error: bool,
    #[serde(default)]
    why: String,
}

fn fixture_dir() -> PathBuf {
    // crates/actions → rust → 仓库根
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../cases/actions")
}

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = fixture_dir().join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到 {}（{e}）—— 先在 cloud-clip 里跑 UPDATE_FIXTURES=1 go test ./lib -run TestActionFixtures",
            path.display()
        )
    });
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{} 解析失败: {e}", path.display()))
}

/// fixture 里记的「此刻」，Rust 侧要用**同一个时钟**跑（否则时间类动作没有可比性）。
fn context(fixture: &CasesFile) -> ActionContext {
    ActionContext {
        now: chrono::DateTime::parse_from_rfc3339(&fixture.context.now)
            .expect("fixture 的 context.now 不是合法的 RFC3339"),
        task: fixture.context.task.clone(),
        room: fixture.context.room.clone(),
    }
}

// ── 1. 元数据：与 Go 逐字段一致 ────────────────────────────────────────

#[test]
fn metadata_matches_go_for_every_enabled_action() {
    let registry: RegistryFile = load("registry.json");
    assert_eq!(
        registry.actions.len(),
        registry.count_hint,
        "countHint 与列表长度不一致"
    );
    assert!(!registry.actions.is_empty(), "fixture 里一个动作都没有");

    let mut checked = 0;
    for spec in &registry.actions {
        // feature 关掉的分组本来就不该在——那是有意的裁剪，不是不一致。
        if !group_enabled(&spec.group) {
            continue;
        }
        let ours = meta(&spec.id).unwrap_or_else(|| {
            panic!(
                "动作 {} 在 fixture 里有、这边却没有：如果是还没实现，加进 not_yet_implemented()；\
                 如果分组名写错了，看 group_enabled()",
                spec.id
            )
        });

        assert_eq!(ours.group, spec.group, "{} 的 group 不一致", spec.id);
        assert_eq!(
            ours.group_key, spec.group_key,
            "{} 的 groupKey 不一致",
            spec.id
        );
        assert_eq!(ours.key, spec.key, "{} 的 i18n key 不一致", spec.id);
        assert_eq!(
            ours.params.len(),
            spec.params.len(),
            "{} 的参数个数不一致（多一个少一个都会让界面渲染出错）",
            spec.id
        );

        for (index, expected) in spec.params.iter().enumerate() {
            let actual = &ours.params[index];
            assert_eq!(
                actual.key, expected.key,
                "{} 第 {index} 个参数的 key 不一致",
                spec.id
            );
            assert_eq!(
                actual.label_key, expected.label_key,
                "{} 参数 {} 的 labelKey 不一致",
                spec.id, expected.key
            );
            let kind = if expected.kind.is_empty() {
                "text"
            } else {
                expected.kind.as_str()
            };
            let ours_kind = match actual.kind {
                ParamKind::Text => "text",
                ParamKind::Select => "select",
            };
            assert_eq!(
                ours_kind, kind,
                "{} 参数 {} 的控件类型不一致",
                spec.id, expected.key
            );
            assert_eq!(
                actual.options.len(),
                expected.options.len(),
                "{} 参数 {} 的下拉项个数不一致",
                spec.id,
                expected.key
            );
            for (option_index, expected_option) in expected.options.iter().enumerate() {
                let actual_option = &actual.options[option_index];
                assert_eq!(
                    actual_option.value, expected_option.value,
                    "{} 参数 {} 第 {option_index} 项的 value 不一致（**第一项就是默认值**）",
                    spec.id, expected.key
                );
                assert_eq!(
                    actual_option.label_key, expected_option.label_key,
                    "{} 参数 {} 第 {option_index} 项的 labelKey 不一致",
                    spec.id, expected.key
                );
            }
            match (&actual.visible_when, &expected.visible_when) {
                (None, None) => {}
                (Some(a), Some(e)) => {
                    assert_eq!(
                        a.key, e.key,
                        "{} 参数 {} 的 visibleWhen.key 不一致",
                        spec.id, expected.key
                    );
                    assert_eq!(
                        a.equals, e.equals,
                        "{} 参数 {} 的 visibleWhen.equals 不一致",
                        spec.id, expected.key
                    );
                }
                _ => panic!(
                    "{} 参数 {} 的 visibleWhen 一边有一边没有",
                    spec.id, expected.key
                ),
            }
        }
        checked += 1;
    }
    assert!(
        checked > 0,
        "一条元数据都没比到 —— group_enabled() 是不是把分组名写错了？"
    );
}

/// 用到的 i18n key 必须与 Go 下发的**完全一致**。
///
/// 少一个 key，界面上就会冒出一个裸 id（`actionReplaceFind`）；多一个 key，说明这边
/// 声明了一个前端根本没有文案的参数。两种都要拦住。
///
/// ⚠️ 只比**启用的分组**（`zh` 默认不带 feature，它的 key 本来就不该在）。所以期望值
/// 从 fixture 的 `actions` 里按分组筛出来算，而不是直接用那个扁平的 `i18nKeys` 列表 ——
/// 后者是「全部 34 个动作的 key」，拿它当期望值会把有意的裁剪报成不一致。
#[test]
fn i18n_keys_match_go_exactly() {
    let registry: RegistryFile = load("registry.json");

    // 先自查 fixture：扁平的 i18nKeys 应当等于全部动作的 key 之并。
    let from_actions: BTreeSet<String> = registry
        .actions
        .iter()
        .flat_map(|spec| {
            let mut keys = vec![spec.key.clone(), spec.group_key.clone()];
            for param in &spec.params {
                keys.push(param.label_key.clone());
                keys.extend(param.options.iter().map(|o| o.label_key.clone()));
            }
            keys
        })
        .filter(|key| !key.is_empty())
        .collect();
    let listed: BTreeSet<String> = registry.i18n_keys.iter().cloned().collect();
    assert_eq!(
        from_actions, listed,
        "fixture 自己的 i18nKeys 与 actions 对不上（生成端的问题）"
    );

    let expected: BTreeSet<String> = registry
        .actions
        .iter()
        .filter(|spec| group_enabled(&spec.group))
        .flat_map(|spec| {
            let mut keys = vec![spec.key.clone(), spec.group_key.clone()];
            for param in &spec.params {
                keys.push(param.label_key.clone());
                keys.extend(param.options.iter().map(|o| o.label_key.clone()));
            }
            keys
        })
        .filter(|key| !key.is_empty())
        .collect();

    let mut ours: BTreeSet<String> = BTreeSet::new();
    for spec in all_meta() {
        ours.insert(spec.key.to_owned());
        ours.insert(spec.group_key.to_owned());
        for param in spec.params {
            if !param.label_key.is_empty() {
                ours.insert(param.label_key.to_owned());
            }
            for option in param.options {
                ours.insert(option.label_key.to_owned());
            }
        }
    }

    let missing: Vec<&String> = expected.difference(&ours).collect();
    let extra: Vec<&String> = ours.difference(&expected).collect();
    assert!(
        missing.is_empty(),
        "Go 下发了这些 key，这边却没有：{missing:?}"
    );
    assert!(extra.is_empty(), "这边多了这些 key，Go 那边没有：{extra:?}");
}

// ── 2. 进度的棘轮：实现 ∪ 未实现 == 注册表 ──────────────────────────────

/// ⚠️ 这条是「不许静默漏掉一个动作」的那根筋。
///
/// 两个方向都要拦：**少了一个**（既没实现也不在未实现清单里 → 界面上点得到、执行时报错）
/// 和**多写了**（清单里有、其实已经实现了 → 清单在骗人，「进度」就不准了）。
#[test]
fn coverage_is_explicit_in_both_directions() {
    let registry: RegistryFile = load("registry.json");
    let pending: BTreeSet<&str> = not_yet_implemented().iter().copied().collect();

    for spec in &registry.actions {
        if !group_enabled(&spec.group) {
            continue;
        }
        let implemented = is_implemented(&spec.id);
        let listed = pending.contains(spec.id.as_str());
        assert!(
            implemented != listed,
            "动作 {} 的状态说不清：implemented={implemented}, 在未实现清单里={listed}",
            spec.id
        );
    }

    // 清单里不许出现 fixture 里没有的 id（打错字就会以「已实现」的身份溜过去）。
    let known: BTreeSet<&str> = registry.actions.iter().map(|s| s.id.as_str()).collect();
    for id in &pending {
        assert!(
            known.contains(*id),
            "未实现清单里的 {id} 不在注册表里 —— 是打错了吗？"
        );
    }

    // 未实现清单**只会变短**：这条只是提醒「别忘了删」，不冻结具体数字。
    assert!(
        !not_yet_implemented().is_empty(),
        "全部动作都实现了 —— 那就把 not_yet_implemented() 连同这条测试一起删掉"
    );
}

// ── 3. 行为：逐条跑 Go 记录的期望值 ────────────────────────────────────

#[test]
fn behaviour_matches_go_case_by_case() {
    let fixture: CasesFile = load("cases.json");
    let ctx = context(&fixture);
    assert!(!fixture.cases.is_empty(), "fixture 里一条用例都没有");

    let mut checked = 0;
    let mut skipped: BTreeSet<&str> = BTreeSet::new();
    let mut failures: Vec<String> = Vec::new();

    for case in &fixture.cases {
        if !is_implemented(&case.id) {
            // 还没实现的动作：**记下来**（下面拿它跟清单对账），不静默跳过。
            skipped.insert(case.id.as_str());
            continue;
        }
        let label = format!("{}({:?}, {:?})", case.id, case.input, case.params);
        match (run(&case.id, &case.input, &case.params, &ctx), &case.expect, case.error) {
            (Ok(actual), Some(expected), false) => {
                if &actual != expected {
                    failures.push(format!(
                        "{label}\n    Go  : {expected:?}\n    Rust: {actual:?}{}",
                        if case.why.is_empty() { String::new() } else { format!("\n    备注: {}", case.why) }
                    ));
                }
            }
            (Err(internal), Some(expected), false) => {
                failures.push(format!("{label}\n    Go  : {expected:?}\n    Rust: 报错了 {internal}"));
            }
            (Ok(actual), None, true) => {
                failures.push(format!(
                    "{label}\n    Go  : <报错>\n    Rust: {actual:?}{}",
                    if case.why.is_empty() { String::new() } else { format!("\n    备注: {}", case.why) }
                ));
            }
            (Ok(_), None, false) => failures.push(format!("{label} fixture 既没有 expect 也没标 error")),
            // 两边都报错 —— 这就是对的（错误文案本来就可以不同，见 fixture 的说明）。
            (Err(_), None, true) => {}
            // 剩下的组合只可能来自**fixture 自己不自洽**（expect 与 error 同时出现、或者
            // 一个成功的用例却没记结果）。这是生成端的 bug，不是实现不一致 ——
            // 分开报，免得误导下一个看日志的人去改实现。
            (actual, expect, flags) => failures.push(format!(
                "{label}\n    fixture 自相矛盾：expect={expect:?} error={flags}\n    Rust: {actual:?}\n    → 回去看 action_fixture_test.go 的生成逻辑"
            )),
        }
        checked += 1;
    }

    assert!(
        failures.is_empty(),
        "和 Go 不一致的有 {} 条（共比了 {checked} 条）：\n  - {}",
        failures.len(),
        failures.join("\n  - ")
    );
    // ⚠️ 只在**默认 feature 全开**时要求「比到了足够多条」。关掉 feature 是有意的裁剪，
    // 那时用例本来就该被跳过 —— 拿一个固定数字去卡会让 `--no-default-features` 假红。
    #[cfg(all(feature = "format", feature = "encode", feature = "inspect"))]
    assert!(
        checked >= 40,
        "只比到 {checked} 条 —— 默认 feature 下应该有 40+ 条（format+encode+sha256 的用例数）"
    );
    assert!(
        checked + skipped.len() > 0,
        "一条用例都没处理，fixture 是空的？"
    );

    // 跳过的那些必须正好是「未实现清单」里的动作，否则说明注册表与清单脱节了。
    let pending: BTreeSet<&str> = not_yet_implemented().iter().copied().collect();
    for id in &skipped {
        assert!(
            pending.contains(id),
            "{id} 的用例被跳过了，但它不在未实现清单里"
        );
    }
}

// ── 4. 把「刻意的差异」钉住 ────────────────────────────────────────────
//
// ⚠️ 这一组测试**断言的是「做不到 / 不一样」**。它们的存在意义与 store 里那条反向测试一样：
// 哪天有人把差异抹平了（或者上游改了），这里会红，提醒回来重读决策 ——
// 而不是让差异从「写着」变成「没人知道」。

/// `encode.html.decode` 只认常见命名实体 + 分号形式；罕见实体**原样保留**。
#[test]
fn html_decode_keeps_unknown_entities_verbatim() {
    let ctx = context(&load::<CasesFile>("cases.json"));
    let params = BTreeMap::new();
    for input in ["&because;", "&amp", "&#xZZ;"] {
        let out = run("encode.html.decode", input, &params, &ctx).expect("不该报错");
        assert_eq!(
            out, input,
            "{input} 应当原样保留（已知差异，见 encode.rs 的注释）"
        );
    }
    // 常见的那一档必须解得开 —— 否则「已知差异」就成了「什么都不干」的借口。
    assert_eq!(
        run("encode.html.decode", "&amp;&nbsp;", &params, &ctx).unwrap(),
        "&\u{a0}"
    );
    // 非法码点按 U+FFFD 处理（Go / 浏览器都是这个行为）。
    assert_eq!(
        run("encode.html.decode", "&#x110000;", &params, &ctx).unwrap(),
        "\u{fffd}"
    );
}

/// `encode.url.decode` 对非法 UTF-8 走 lossy：`%FF` 出来是 U+FFFD。
///
/// Go 那边字符串里留的是**原始字节**，但它进 JSON 时同样变成 U+FFFD —— **契约层面一致**，
/// 只是内存里的表示不同。这条差异不写下来，下次有人对着 Go 的字节调试会白费半天。
#[test]
fn url_decode_is_lossy_for_invalid_utf8() {
    let ctx = context(&load::<CasesFile>("cases.json"));
    let params = BTreeMap::new();
    assert_eq!(
        run("encode.url.decode", "a%FFb", &params, &ctx).unwrap(),
        "a\u{fffd}b"
    );
}

/// `format.json.*` 走 `serde_json` 校验，它对**超出 f64 的数字**比 Go 严。
#[test]
fn json_actions_reject_huge_numbers_that_go_accepts() {
    let ctx = context(&load::<CasesFile>("cases.json"));
    let params = BTreeMap::new();
    assert!(
        run("format.json.pretty", "{\"a\":1e400}", &params, &ctx).is_err(),
        "serde_json 会拒绝超出 f64 范围的字面量 —— 这是与 Go 的已知差异（见 format.rs 注释）"
    );
}

/// 链：**某一步失败就停在那里**，后面的动作不再跑。
#[test]
fn a_failing_step_stops_the_chain() {
    let ctx = context(&load::<CasesFile>("cases.json"));
    let chain = vec![
        clip9_actions::ChainStep {
            id: "encode.base64.decode".into(),
            params: BTreeMap::new(),
        },
        clip9_actions::ChainStep {
            id: "encode.base64".into(),
            params: BTreeMap::new(),
        },
    ];
    // 第一步就解不开 `!!!`，所以第二步不该被执行（否则会拿到一个「看着正常」的结果）。
    let err = clip9_actions::run_chain("!!!", &chain, &ctx).expect_err("第一步就该失败");
    assert!(
        matches!(err, clip9_actions::ActionError::InvalidInput(_)),
        "{err}"
    );
}
