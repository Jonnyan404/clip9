//! 契约测试：拿 **Go 跑出来的** `cases/actions/*.json` 逐条比对。
//!
//! 为什么不能只靠 Rust 自己的单测：这个 crate 存在的理由是「一份实现两端跑」，
//! 而它的**行为基准仍然是 Go**（`ARCHITECTURE.md` §5.4）。自己测自己只能证明「我没改坏」，
//! 证明不了「和现有的那个实现一样」—— 而后者才是切换时不出现「同一个任务、两个结果」的前提。
//!
//! ⚠️ fixture 是**冻结的输入**：拆库时从 Go 实现那边带过来，这边**不再重新生成**
//! （理由见 `cases/README.md`）。真要重生成得在 **Go 仓库**里跑：
//!
//! ```bash
//! cd <Go 仓库>/cloud-clip && UPDATE_FIXTURES=1 go test ./lib -run TestActionFixtures
//! cargo test -p clip9-actions        # 回到本仓库根跑这个
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cases/actions")
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

/// 这个动作在**这一版**里能不能跑。
///
/// `feature` 裁剪掉的分组根本没编进来，那些测试没法跑 —— 那是**配置**，不是坏掉。
/// ⚠️ 但「静默 return」是个陷阱：id 打错了也会静默跳过。所以这里**顺带核对**
/// 它真的在 fixture 的注册表里（打错字必红），再回「这一版有没有」。
fn available(id: &str) -> bool {
    let registry: RegistryFile = load("registry.json");
    assert!(
        registry.actions.iter().any(|spec| spec.id == id),
        "{id} 不在 fixture 的注册表里 —— 测试里写错 id 了？"
    );
    if !is_implemented(id) {
        println!("跳过：{id} 不在这一版的 feature 里");
    }
    is_implemented(id)
}

/// 至少有一个分组开着。用来区分「这一版刻意不带动作」与「分组名全写错了」。
fn any_group_enabled() -> bool {
    ["format", "text", "date", "encode", "zh", "inspect"]
        .iter()
        .any(|group| group_enabled(group))
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
    // feature 全关时一条都比不到，那是配置；但只要**有任何一个分组开着**，
    // 就至少该比到一条 —— 一条都比不到说明 group_enabled() 把所有名字都看不认了。
    if any_group_enabled() {
        assert!(
            checked > 0,
            "一条元数据都没比到 —— group_enabled() 是不是把分组名写错了？"
        );
    }
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

    // ⚠️ 这里**不再**要求「清单非空」。清单在 2026-09-25 清空过一次（34 项全实现完），
    // 然后会随着「把前端那 11 个动作加进注册表」重新变长。
    // 拿「非空」当断言等于把「进度」写成了「必须没做完」，反过来就假红了。
    // 真正要守的是上面那条 XOR：**注册表里的每一个动作，状态必须是说得清的**。
}

// ── 3. 行为：逐条跑 Go 记录的期望值 ────────────────────────────────────

#[test]
fn behaviour_matches_go_case_by_case() {
    let fixture: CasesFile = load("cases.json");
    let registry: RegistryFile = load("registry.json");
    let ctx = context(&fixture);
    assert!(!fixture.cases.is_empty(), "fixture 里一条用例都没有");

    // id → group：用来判断「跳过」是因为**没实现**，还是因为这个分组**这一版没编进来**。
    let groups: BTreeMap<&str, &str> = registry
        .actions
        .iter()
        .map(|spec| (spec.id.as_str(), spec.group.as_str()))
        .collect();

    let mut checked = 0;
    // ⚠️ 两个都要：`skipped_ids` 用来「逐个说清为什么跳过」，`skipped_cases` 用来对账。
    // 用一个 Set 兼任两件事会错 —— 一个动作**有多条用例**（`text.replace` 有 17 条），
    // 拿 id 的个数当用例数去加，永远对不上总数。
    let mut skipped_cases = 0;
    let mut skipped_ids: BTreeSet<&str> = BTreeSet::new();
    let mut compared_ids: BTreeSet<&str> = BTreeSet::new();
    let mut failures: Vec<String> = Vec::new();

    for case in &fixture.cases {
        if !is_implemented(&case.id) {
            // 还没实现的动作：**记下来**（下面拿它跟清单对账），不静默跳过。
            skipped_cases += 1;
            skipped_ids.insert(case.id.as_str());
            continue;
        }
        let label = format!("{}({:?}, {:?})", case.id, case.input, case.params);
        compared_ids.insert(case.id.as_str());
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
    assert!(
        checked + skipped_cases == fixture.cases.len(),
        "比过的 {checked} + 跳过的 {skipped_cases} ≠ 用例总数 {} —— 有案例既没比也没记",
        fixture.cases.len()
    );
    // feature 全关时一条都比不了（那是配置）；有分组开着却一条没比，才说明哪里坏了。
    if any_group_enabled() {
        assert!(checked > 0, "一条用例都没比 —— fixture 是空的？");
    }

    // ★ 每一个**这一版能跑**的动作，都必须至少有一条用例被真的比过。
    //
    // 这条比「总数 ≥ 某个魔数」有用得多：魔数在有人加用例时只会被顺手改大，
    // 而这条能抓住「某个动作悄悄变成一条也没比」—— 那正是「静默少测一块」的样子。
    // （它**不是**同义反复：上面的计数是循环跑出来的，这里比的是 fixture 的覆盖内容。）
    if any_group_enabled() {
        for spec in &registry.actions {
            if !group_enabled(&spec.group) || !is_implemented(&spec.id) {
                continue;
            }
            assert!(
                compared_ids.contains(spec.id.as_str()),
                "{} 是这一版能跑的动作，却一条用例都没比到 —— fixture 里漏了它？",
                spec.id
            );
        }
    }

    // ★ 跳过的每一个动作都必须**说得清为什么**，而且只允许两种原因：
    //   ① 这个动作还没实现（在未实现清单里）—— 那是进度；
    //   ② 它所属的分组**这一版没编进来**（feature 关掉）—— 那是有意的裁剪。
    // 除这两种以外的跳过都是 bug：典型是「注册表加了新动作、忘了实现也没进清单」，
    // 那会**静默少比一批用例**，而少了哪一批没人看得出来。
    let pending: BTreeSet<&str> = not_yet_implemented().iter().copied().collect();
    let mut by_feature: BTreeSet<&str> = BTreeSet::new();
    for id in &skipped_ids {
        let group = groups
            .get(id)
            .unwrap_or_else(|| panic!("{id} 的用例被跳过了，但它不在注册表里"));
        if group_enabled(group) {
            assert!(
                pending.contains(id),
                "{id} 的用例被跳过了，但它既不在未实现清单里、分组（{group}）也开着 —— 注册表和实现脱节了"
            );
        } else {
            by_feature.insert(id);
        }
    }
    // 两种原因都记下来，出问题时一眼能看出是「没写完」还是「没编进来」。
    if !by_feature.is_empty() {
        println!(
            "跳过 {} 条用例：动作 {} 因为分组没编进来",
            skipped_cases,
            by_feature.len()
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
    if !available("encode.html.decode") {
        return;
    }
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
    if !available("encode.url.decode") {
        return;
    }
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
    if !available("format.json.pretty") {
        return;
    }
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
    if !available("encode.base64") {
        return;
    }
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

/// `text.upper` / `text.lower` 走**完整**大小写映射（跟前端 JS），与 Go 的**简单**映射不同。
///
/// 这条断言的是**差异本身**：哪天有人把这边改成 Go 那种「一个码点对一个码点」，
/// 或者上游把 Go 换掉了，这里会红，提醒回来重读决策 —— 而不是让差异从「写着」变成「没人知道」。
///
/// 选边站的理由：这个动作在界面上有**预览区**（JS），用户看到的是 `STRASSE`。
/// 「预览区 STRASSE、定时任务 STRAßE」正是这个项目最不能接受的那类错。
#[test]
fn case_mapping_follows_the_frontend_not_go() {
    if !available("text.upper") {
        return;
    }
    let ctx = context(&load::<CasesFile>("cases.json"));
    let params = BTreeMap::new();
    // Go 给的是 `STRAßE`（ß 没有简单大写映射，原样留着）。
    assert_eq!(
        run("text.upper", "straße", &params, &ctx).unwrap(),
        "STRASSE"
    );
    assert_eq!(run("text.upper", "ﬁ", &params, &ctx).unwrap(), "FI");
    // Go 给的是 `i`（丢掉了上面那个点）。
    assert_eq!(run("text.lower", "İ", &params, &ctx).unwrap(), "i\u{307}");
    // 两边一致的那一档不能坏 —— 否则「刻意的差异」就成了「什么都不干」的借口。
    assert_eq!(
        run("text.upper", "aBc123", &params, &ctx).unwrap(),
        "ABC123"
    );
}

/// 提取 URL 时，`\s` 按**前端**的 Unicode 语义（Go 的 `\s` 是 ASCII）。
///
/// Go 那边 `https://a.com　后面的字`（全角空格 / 不换行空格）会把**后半句一起吃进 URL**；
/// 前端与这边停在全角空格。差异来自**同一串 source、不同引擎**，不是谁少做了什么。
#[test]
fn url_extraction_stops_at_unicode_spaces_like_the_frontend() {
    if !available("text.extractUrl") {
        return;
    }
    let ctx = context(&load::<CasesFile>("cases.json"));
    let params = BTreeMap::new();
    for space in ['\u{3000}', '\u{a0}'] {
        let input = format!("https://a.com{space}后面的字");
        assert_eq!(
            run("text.extractUrl", &input, &params, &ctx).unwrap(),
            "https://a.com",
            "U+{:04X} 之后的内容不该被吞进 URL（Go 那边会吞）",
            space as u32
        );
    }
}

/// 日期解析这边**更严格**：时分秒越界直接报错。
///
/// Go 用 `time.Date(...)` 构造，它会把越界值**归一化**（`01:99` → `02:39`），
/// 而回读校验只比年月日 —— 于是这种输入在 Go 那边**是合法的**。
/// 这边按区间校验，报错。选严格是因为「悄悄给出一个看着合理、其实不对的时间」
/// 正是 Go 自己那段注释在防的事。
///
/// 同一条规则的另一个面：`\s` 按前端（Unicode），所以全角空格分隔的写法在这边能算、Go 报错。
#[test]
fn date_parsing_is_stricter_than_go_about_out_of_range_time() {
    if !available("date.add") {
        return;
    }
    let ctx = context(&load::<CasesFile>("cases.json"));
    let params = BTreeMap::new();
    for input in ["2026-09-24 01:99 +1d", "2026-09-24 25:00 +1d"] {
        assert!(
            run("date.add", input, &params, &ctx).is_err(),
            "{input} 应当报错（Go 会归一化后接受）"
        );
    }
    // 但正常的时间必须能算，别把整条路都堵死。
    assert_eq!(
        run("date.add", "2026-09-24 01:30 +1d", &params, &ctx).unwrap(),
        "2026-09-25 01:30"
    );
    // 全角空格分隔：Go 报错、前端与这边都能算（同一处 `\s` 差异的另一个面）。
    assert_eq!(
        run("date.add", "2026-09-24\u{3000}+1d", &params, &ctx).unwrap(),
        "2026-09-25"
    );
}
