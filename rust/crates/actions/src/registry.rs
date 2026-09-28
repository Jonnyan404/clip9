//! 动作注册表：**元数据与执行入口**。
//!
//! # ⚠️ 先读这段：这张表的范围是「定时任务能用的动作」
//!
//! ## 2026-09-25 的决定（推翻了这一版早先的写法）
//!
//! 早先这里写的是「**目标集合是全部动作**，不是 Go 的子集」—— 那是照
//! `ARCHITECTURE.md` §5.3.1 推的（「Rust 侧拼音/简繁/markdown 都是 crate，所以『可下沉』
//! 这个分类会消失」）。**这条只对了一半，已经作废**，理由写在 §5.3.1 的修订里，
//! 一句话是：**Rust crate 不是「同一件事换个实现」，而是另一份实现** ——
//! 前端那几个动作的行为**就是 marked / highlight.js / pinyin-pro / opencc-js**，
//! 换实现必然算出不同的结果，而「一份动作库」的价值必须建立在「同一个输入 → 同一个输出」上。
//!
//! 所以现在的口径是：**这张表 = 定时任务的动作集**（后端只服务定时任务），
//! 预览区继续用前端自己那一份。用户 2026-09-25 的原话：「后端的动作本来就是给定时任务用的，
//! 不能对齐也不影响，在自动化界面明确提示就行了」。
//!
//! ## 两类**刻意不收**的动作
//!
//! 1. **生成类** `generate.*`（uuid / time / datetime）：不是「跑不了」，是**链的语义** ——
//!    它是「生成」，放进链里会把前面算出来的正文整个丢掉。要用它的效果就用**模板变量**
//!    （`{{uuid}}` / `{{time}}` / `{{datetime}}`），变量是**内联**的、不覆盖任何东西。
//!    「以后有需求了再改」是用户的原话：真要做，得先想清楚「定时任务允不允许把正文整个换掉」。
//! 2. **预览区专用的 9 个**：`format.markdown` / `format.code` / `zh.pinyin{,table,word}` /
//!    `zh.simplified` / `zh.traditional` / `inspect.stats` / `inspect.detect`。
//!    行为即第三方 JS 库（同上）；另有两条同向的：它们是 async + 动态 import 大模块，
//!    而这里的 `run()` 是同步纯函数；`inspect.stats/detect` 的输出还要翻译。
//!
//! ⚠️ 这两类**都不进 [`not_yet_implemented`]**：那份清单的意思是「注册表里有、实现还没接上」，
//! 与「刻意不收」正相反。把刻意不收的塞进去，会让「进度」这个词失去意义。
//!
//! ⚠️ **代价是界面上必须说清楚**（否则用户只看到列表短了一截）：页面那条常驻说明
//! `actionScopeHint` 就是干这个的。**改这张表时顺手看一眼它是否需要跟着改。**
//!
//! # 元数据是契约
//!
//! `id` / `group` / `key` / 参数声明这几样是**跨端契约**：
//! 管理页拿 `key` 去 locale 里取译文、按 `params` 渲染表单、按 `groupKey` 分组。
//! 所以它们不能「顺手改一下」—— 由 `cases/actions/registry.json` 钉住
//! （Go 生成，`tests/go_cases.rs` 逐字段比对）。
//!
//! ⚠️ `id` 与前端 `data/actions.js` **逐字一致**。任务里存的就是 id，
//! 两侧同名才能保证「同一个任务，谁执行结果都一样」。
//!
//! # 「还没实现」是显式清单，不是静默缺席
//!
//! [`not_yet_implemented`] 列着这张表里有、这边还没接上实现的那些。
//! 测试拿它跟 fixture 对账：**少一个就红**。这样做的理由与「不在表里的 id 一律报错」同源 ——
//! 一个动作在界面上列得出来、执行时却没有，比它根本不出现糟得多（前者用户以为它跑了）。

use std::collections::BTreeMap;

use chrono::{DateTime, FixedOffset};

use crate::error::ActionError;

/// 动作参数。与 Go 的 `map[string]string` 同义（值都在链元素上，不在动作定义上）。
pub type Params = BTreeMap<String, String>;

/// 动作的上下文。
///
/// ⚠️ 时间**由调用方注入**，不在这里取 `now()`：定时任务的「此刻」是调度器决定的
/// （还要能被测试固定住），而且 `core` / `wasm` 两侧都得能编。
#[derive(Debug, Clone)]
pub struct ActionContext {
    pub now: DateTime<FixedOffset>,
    /// 任务名 —— `date.add` 之类不需要，但模板引擎与将来的动作要用。留着比后加省事。
    pub task: String,
    pub room: String,
}

/// 参数控件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    /// 单行输入（默认）。
    Text,
    /// 下拉。`options` 里的**第一项就是默认值** —— 不另设 default 字段，
    /// 同一个意思写两处迟早会不一致。
    Select,
}

/// 下拉里的一项。`value` 进链元素，`label_key` 是它的文案 key。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParamOption {
    pub value: &'static str,
    pub label_key: &'static str,
}

/// 「当 `key` 这个参数等于 `equals` 时才显示这个参数」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParamCondition {
    pub key: &'static str,
    pub equals: &'static str,
}

/// 一个参数的声明。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParamSpec {
    pub key: &'static str,
    pub label_key: &'static str,
    pub kind: ParamKind,
    pub options: &'static [ParamOption],
    pub visible_when: Option<ParamCondition>,
}

impl ParamSpec {
    /// 无参数控件的声明（绝大多数参数都是单行输入）。
    const fn text(key: &'static str, label_key: &'static str) -> Self {
        Self {
            key,
            label_key,
            kind: ParamKind::Text,
            options: &[],
            visible_when: None,
        }
    }
}

/// 一个动作的元数据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionMeta {
    pub id: &'static str,
    pub group: &'static str,
    /// 分组名的 i18n key。
    pub group_key: &'static str,
    /// 动作名的 i18n key。**只给 key，不给译文。**
    pub key: &'static str,
    pub params: &'static [ParamSpec],
}

/// 链上的一步。
///
/// ⚠️ 参数挂在**步骤**上而不是动作定义上：同一条链上同一个动作可以出现两次、两次用不同参数
/// （「替换 A→B」再接「替换 C→D」是合法意图）。Go 那边同一条约定。
#[derive(Debug, Clone, Default)]
pub struct ChainStep {
    pub id: String,
    pub params: Params,
}

// ── 参数声明的复用片段 ────────────────────────────────────────────────

/// `text.replace` 的模式选项。**第一项是默认值** = 字面替换（也就是这个动作原本的行为）。
const REPLACE_MODES: &[ParamOption] = &[
    ParamOption {
        value: "text",
        label_key: "actionReplaceModeText",
    },
    ParamOption {
        value: "digits",
        label_key: "actionReplaceModeDigits",
    },
    ParamOption {
        value: "latin",
        label_key: "actionReplaceModeLatin",
    },
    ParamOption {
        value: "spaces",
        label_key: "actionReplaceModeSpaces",
    },
    ParamOption {
        value: "email",
        label_key: "actionReplaceModeEmail",
    },
    ParamOption {
        value: "url",
        label_key: "actionReplaceModeUrl",
    },
    ParamOption {
        value: "phone",
        label_key: "actionReplaceModePhone",
    },
    ParamOption {
        value: "ip",
        label_key: "actionReplaceModeIp",
    },
];

const REPLACE_PARAMS: &[ParamSpec] = &[
    ParamSpec {
        key: "mode",
        label_key: "actionReplaceMode",
        kind: ParamKind::Select,
        options: REPLACE_MODES,
        visible_when: None,
    },
    // ⚠️「查找」只在「文本」模式下有意义 —— 其余模式自己决定匹配什么。留着不隐藏的话，
    // 用户填了发现不生效，只会以为功能坏了。
    ParamSpec {
        key: "find",
        label_key: "actionReplaceFind",
        kind: ParamKind::Text,
        options: &[],
        visible_when: Some(ParamCondition {
            key: "mode",
            equals: "text",
        }),
    },
    ParamSpec::text("with", "actionReplaceWith"),
];

// ── 注册表 ────────────────────────────────────────────────────────────

const FORMAT: &[ActionMeta] = &[
    ActionMeta {
        id: "format.json.pretty",
        group: "format",
        group_key: "actionGroupFormat",
        key: "actionJsonPretty",
        params: &[],
    },
    ActionMeta {
        id: "format.json.min",
        group: "format",
        group_key: "actionGroupFormat",
        key: "actionJsonMin",
        params: &[],
    },
];

const TEXT: &[ActionMeta] = &[
    ActionMeta {
        id: "text.trimLines",
        group: "text",
        group_key: "actionGroupText",
        key: "actionTrimLines",
        params: &[],
    },
    ActionMeta {
        id: "text.dropBlank",
        group: "text",
        group_key: "actionGroupText",
        key: "actionDropBlankLines",
        params: &[],
    },
    ActionMeta {
        id: "text.dedupe",
        group: "text",
        group_key: "actionGroupText",
        key: "actionDedupeLines",
        params: &[],
    },
    ActionMeta {
        id: "text.sort",
        group: "text",
        group_key: "actionGroupText",
        key: "actionSortLines",
        params: &[],
    },
    ActionMeta {
        id: "text.upper",
        group: "text",
        group_key: "actionGroupText",
        key: "actionUpperCase",
        params: &[],
    },
    ActionMeta {
        id: "text.lower",
        group: "text",
        group_key: "actionGroupText",
        key: "actionLowerCase",
        params: &[],
    },
    ActionMeta {
        id: "text.replace",
        group: "text",
        group_key: "actionGroupText",
        key: "actionReplace",
        params: REPLACE_PARAMS,
    },
    ActionMeta {
        id: "text.reverse",
        group: "text",
        group_key: "actionGroupText",
        key: "actionReverse",
        params: &[],
    },
    ActionMeta {
        id: "text.extractUrl",
        group: "text",
        group_key: "actionGroupText",
        key: "actionExtractUrl",
        params: &[],
    },
    ActionMeta {
        id: "text.extractEmail",
        group: "text",
        group_key: "actionGroupText",
        key: "actionExtractEmail",
        params: &[],
    },
    ActionMeta {
        id: "text.extractPhone",
        group: "text",
        group_key: "actionGroupText",
        key: "actionExtractPhone",
        params: &[],
    },
    ActionMeta {
        id: "text.extractIp",
        group: "text",
        group_key: "actionGroupText",
        key: "actionExtractIp",
        params: &[],
    },
    ActionMeta {
        id: "text.extractNumber",
        group: "text",
        group_key: "actionGroupText",
        key: "actionExtractNumber",
        params: &[],
    },
];

const DATE: &[ActionMeta] = &[
    ActionMeta {
        id: "date.add",
        group: "date",
        group_key: "actionGroupDate",
        key: "actionDateAdd",
        params: &[],
    },
    ActionMeta {
        id: "date.diff",
        group: "date",
        group_key: "actionGroupDate",
        key: "actionDateDiff",
        params: &[],
    },
];

const ENCODE: &[ActionMeta] = &[
    ActionMeta {
        id: "encode.base64",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionBase64Encode",
        params: &[],
    },
    ActionMeta {
        id: "encode.base64.decode",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionBase64Decode",
        params: &[],
    },
    ActionMeta {
        id: "encode.url",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionUrlEncode",
        params: &[],
    },
    ActionMeta {
        id: "encode.url.decode",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionUrlDecode",
        params: &[],
    },
    ActionMeta {
        id: "encode.hex",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionHexEncode",
        params: &[],
    },
    ActionMeta {
        id: "encode.hex.decode",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionHexDecode",
        params: &[],
    },
    ActionMeta {
        id: "encode.html",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionHtmlEncode",
        params: &[],
    },
    ActionMeta {
        id: "encode.html.decode",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionHtmlDecode",
        params: &[],
    },
    ActionMeta {
        id: "encode.unicode",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionUnicodeEncode",
        params: &[],
    },
    ActionMeta {
        id: "encode.unicode.decode",
        group: "encode",
        group_key: "actionGroupEncode",
        key: "actionUnicodeDecode",
        params: &[],
    },
];

const ZH: &[ActionMeta] = &[
    ActionMeta {
        id: "zh.fullwidth",
        group: "zh",
        group_key: "actionGroupZh",
        key: "actionFullWidth",
        params: &[],
    },
    ActionMeta {
        id: "zh.halfwidth",
        group: "zh",
        group_key: "actionGroupZh",
        key: "actionHalfWidth",
        params: &[],
    },
    ActionMeta {
        id: "zh.punctuation",
        group: "zh",
        group_key: "actionGroupZh",
        key: "actionCnPunctuation",
        params: &[],
    },
    ActionMeta {
        id: "zh.number",
        group: "zh",
        group_key: "actionGroupZh",
        key: "actionNumberToChinese",
        params: &[],
    },
];

const INSPECT: &[ActionMeta] = &[
    ActionMeta {
        id: "inspect.timestamp",
        group: "inspect",
        group_key: "actionGroupInspect",
        key: "actionTimestampToDate",
        params: &[],
    },
    ActionMeta {
        id: "inspect.dateToTimestamp",
        group: "inspect",
        group_key: "actionGroupInspect",
        key: "actionDateToTimestamp",
        params: &[],
    },
    ActionMeta {
        id: "inspect.sha256",
        group: "inspect",
        group_key: "actionGroupInspect",
        key: "actionSha256",
        params: &[],
    },
];

/// 当前这一版**编译进来**的元数据（顺序按分组，与 Go 的注册表同序）。
#[must_use]
pub fn all_meta() -> Vec<&'static ActionMeta> {
    let mut out = Vec::with_capacity(34);
    for (enabled, group) in [
        (cfg!(feature = "format"), FORMAT),
        (cfg!(feature = "text"), TEXT),
        (cfg!(feature = "date"), DATE),
        (cfg!(feature = "encode"), ENCODE),
        (cfg!(feature = "zh"), ZH),
        (cfg!(feature = "inspect"), INSPECT),
    ] {
        if enabled {
            out.extend(group.iter());
        }
    }
    out
}

/// 这一版里某个动作 id 有没有编进来。
#[must_use]
pub fn meta(id: &str) -> Option<&'static ActionMeta> {
    let id = id.trim();
    all_meta().into_iter().find(|spec| spec.id == id)
}

/// 分组名 → feature 名（两者**一一对应**，见 `Cargo.toml`）。
///
/// 单独一个函数是为了把「名字必须对上」这件事收在一处：测试会拿它去校验
/// fixture 里每个 `group` 都能被这个函数解释，写错一个分组名就会红。
///
/// ⚠️ 别听 clippy 的 `matches!` 建议（所以这里显式 allow）：它只看**当前这一组 feature
/// 全开**时的常量折叠结果（`cfg!` 全成 `true`，于是 match 看起来等价于 `matches!`），
/// 而按它的写法一改，`--no-default-features` 下就会把没编进来的分组报成「开着」——
/// 那正是这个函数要防的事。**lint 的建议只在某一种 feature 组合下成立，就不能照抄。**
#[allow(clippy::match_like_matches_macro)]
#[must_use]
pub fn group_enabled(group: &str) -> bool {
    match group {
        "format" => cfg!(feature = "format"),
        "text" => cfg!(feature = "text"),
        "date" => cfg!(feature = "date"),
        "encode" => cfg!(feature = "encode"),
        "zh" => cfg!(feature = "zh"),
        "inspect" => cfg!(feature = "inspect"),
        _ => false,
    }
}

/// 这张表里**有、但这边还没接上实现**的动作。
///
/// ⚠️ 它必须**显式**，不能「缺了就是缺了」：`tests/go_cases.rs` 会拿它跟
/// `cases/actions/registry.json` 对账（已实现的 ∪ 这份清单 == 当前 feature 下的全集）。
/// 漏掉一个动作**一定会红** —— 而不是等用户在界面上点到一个「点了没反应」的动作。
///
/// # 它现在是**空的**（2026-09-25）
///
/// 定时任务那 34 项**全部实现完**了。**空不是「这套机制没用了」**：
/// 它保证的不变量是「注册表 ⊃ 实现」这件事永远说得清，将来这张表长大（比如真要把
/// 预览区某个动作收进来）时它立刻重新有用。
///
/// ⚠️ 别把**刻意不收**的动作写进来（`generate.*` 与预览区那 9 个，见模块文档）——
/// 那份清单是「注册表里有、实现没接」，不是「我们决定不做」。写进来会让「进度」失去意义。
pub const NOT_YET_IMPLEMENTED: &[&str] = &[];

/// 还没实现的动作（见 [`NOT_YET_IMPLEMENTED`] 的说明）。
#[must_use]
pub fn not_yet_implemented() -> &'static [&'static str] {
    NOT_YET_IMPLEMENTED
}

/// 这个 id **能不能真的跑**。
///
/// ⚠️ 与 [`meta`] 的区别是要紧的：`meta()` 对**注册表里每一项**都返回 `Some`
/// （元数据本来就全写了 —— 它要喂给界面渲染动作列表），而「能跑」还得**有实现**。
/// 混用这两个概念会让测试出现「比了一堆根本没实现的用例」这种假红/假绿，
/// 所以这里单独给一个判据，别在调用方各自拼 `meta() && !NOT_YET.contains(..)`。
///
/// ⚠️ 清单为空时它与 `meta().is_some()` 等价 —— 但**调用方仍然应该用它**：
/// 这样等注册表重新长大时，判断逻辑不用回头改一遍（改一处漏一处才是这类东西的常态）。
#[must_use]
pub fn is_implemented(id: &str) -> bool {
    let id = id.trim();
    meta(id).is_some() && !NOT_YET_IMPLEMENTED.contains(&id)
}

// ── 执行 ──────────────────────────────────────────────────────────────

/// 跑一个动作。
///
/// 某个 feature 关掉时对应动作**不存在**（会回 `UnknownAction`）—— 这不是「静默跳过」，
/// 而是明确地告诉调用方「这一版没有它」。定时任务是无人值守的，静默跳过会让用户
/// 以为动作跑了。
pub fn run(
    id: &str,
    input: &str,
    params: &Params,
    ctx: &ActionContext,
) -> Result<String, ActionError> {
    let id = id.trim();

    // ⚠️ `feature` 一个都没开时（`--no-default-features`），下面那一串分派会被**整体**
    // cfg 掉，这几个参数就没人用了。这里显式「用」一下，好过把它们改名成 `_input`
    // （那在默认 feature 下反而丢掉「这个参数是有用的」这层信息）。
    //
    // 为什么值得为「一个动作都没有的构建」花这几行：`--no-default-features` 是**唯一**
    // 能便宜地验证「feature 裁剪这条路真能走」的姿势（`Cargo.toml` 里那句
    // 「按部署裁剪体积」要是编不过就只是句话）。所以它进常态门禁，见 HANDOVER §2。
    //
    // ⚠️ 这个 cfg 列表要与上面那一串**同步**：加了新分组却忘了加进来，
    // 零 feature 那一版会重新报未使用变量 —— 会红，不会静默。
    #[cfg(not(any(
        feature = "format",
        feature = "text",
        feature = "date",
        feature = "encode",
        feature = "zh",
        feature = "inspect"
    )))]
    let _ = (input, params, ctx);

    #[cfg(feature = "format")]
    if let Some(out) = crate::actions::format::run(id, input, params, ctx) {
        return out;
    }
    #[cfg(feature = "text")]
    if let Some(out) = crate::actions::text::run(id, input, params, ctx) {
        return out;
    }
    #[cfg(feature = "date")]
    if let Some(out) = crate::actions::date::run(id, input, params, ctx) {
        return out;
    }
    #[cfg(feature = "encode")]
    if let Some(out) = crate::actions::encode::run(id, input, params, ctx) {
        return out;
    }
    #[cfg(feature = "zh")]
    if let Some(out) = crate::actions::zh::run(id, input, params, ctx) {
        return out;
    }
    #[cfg(feature = "inspect")]
    if let Some(out) = crate::actions::inspect::run(id, input, params, ctx) {
        return out;
    }

    Err(ActionError::UnknownAction {
        id: id.to_owned(),
        available: all_meta().iter().map(|spec| spec.id.to_owned()).collect(),
    })
}

/// 按顺序跑一条链，**某一步失败就停在那里**。
///
/// 「失败即停」与前端 `runChain` 一致：后一步的输入依赖前一步的输出，
/// 硬着头皮跑下去得到的东西没有意义，反而会发出一条**看起来正常**的错误消息。
pub fn run_chain(
    input: &str,
    chain: &[ChainStep],
    ctx: &ActionContext,
) -> Result<String, ActionError> {
    let mut current = input.to_owned();
    for step in chain {
        if step.id.trim().is_empty() {
            continue;
        }
        current = run(&step.id, &current, &step.params, ctx)?;
    }
    Ok(current)
}
