//! 要显示给用户的一句话 —— **「键 + 参数」，不是成文的译文**。
//!
//! # 为什么要单独一个类型（2026-09-28）
//!
//! 界面上有一批句子**不是页面写的**，而是壳（Rust）写好了递过去的：
//! 连接状态（「已连接」「已断开：…」）、一次性提示（「取历史失败：…」）、
//! 配置里的毛病（「房间「x」没填服务端地址」）、IPC 命令报的错。
//! 多语言之前它们的形状是 `String` —— 里面装着**一句写死的中文**。
//!
//! ⚠️★ 于是「界面支持英文」这件事在那一半上**根本没发生**：切了语言，
//! 页面自己那 175 句变了，壳递过来的这几十句**一个字都没变**。
//! 而且**不会有任何报错** —— 这是本项目最忌讳的一类（改了不生效，静默）。
//!
//! # 形态：只递「键 + 参数」
//!
//! 与**服务端下发 i18n key**（`web-vue3/src/locales/*.json`）是同一个套路，
//! 理由也一样：**壳不该知道用户选了哪个语言**。壳知道的是「发生了什么」，
//! 把它说成人话是**页面那一侧**的事（页面手里才有语言设置）。
//!
//! ```text
//! 壳：  Msg::key("historyFailed").param("reason", &reason)
//!              ↓  IPC（JSON：{"key":"historyFailed","params":{"reason":"…"}}）
//! 页面： I18N.say(msg) → 「取历史失败：…」/ 「Could not fetch history: …」
//! ```
//!
//! # ⚠️★ 三条要记住的
//!
//! 1. **`key` 的取值只在 `crates/desktop/ui/i18n.js` 的两个字典里**。这里**没有**兜底字典，
//!    也不许有 —— 两张字典一定会漂。
//!    ⚠️ 键写错的表现是「界面上出现一个像变量的英文单词」（`t()` 的最后一级兜底就是键本身），
//!    而且**不报错**。所以 `tools/desktop-ui-smoke.mjs` 里有一条静态检查盯着
//!    「Rust 侧不许再出现中文界面文案」（`eprintln!` 那种日志除外）。
//! 2. **参数值不许是「拼好的句子片段」**。参数是**数据**（房间名、地址、错误原因），
//!    不是句子。⚠️ 尤其**别在 Rust 里用中文标点拼接**（`names.join("、")`）——
//!    用哪种分隔符由语言决定，所以列表要**整份**递过去（[`Msg::param_list`]），
//!    由页面按自己的语言拼（`I18N` 里那条「数组参数」规则）。
//! 3. **别把它译回来**。这个类型上没有 `Display`，也**故意没有** `Deref<Target = str>`
//!    —— 一旦能当字符串用，就会有人拿它去拼句子（那正是这一层要消灭的东西）。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 一个占位符的值：**一个**字符串、**一整份**列表，或者**另一句话**。
///
/// ⚠️★ 列表要「整份」递过去，不是先在这里拼好 —— 分隔符由语言决定
/// （中文用「、」、英文用「, 」），那是页面的事。
///
/// ⚠️★ [`ParamValue::Msg`] 是「**一句话里嵌另一句话**」：页面按同样的规则递归翻
/// （`I18N` 里 `t()` 的参数替换那条）。用途是「房间名：那句话」这种**组合**，
/// 例如提示回来时那个房间已经被删掉了 —— 那时只能把房间名**说在句子里**
/// （没有那个房间的格子可挂），而组合这件事**不许在 Rust 里用字符串拼**
/// （`format!("{room}：{text}")` 那个「：」是中文全角冒号，英文句子中间会很突兀）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    /// `{"reason": "HTTP 401"}`
    One(String),
    /// `{"rooms": ["默认", "工作"]}` / `{"reasons": [{"key":…}, {"key":…}]}`
    /// —— 元素可以是字符串，也可以是**另一句话**；页面按自己的语言拼。
    Many(Vec<ParamValue>),
    /// `{"text": {"key": "historyFailed", "params": {…}}}` —— 页面递归翻。
    Msg(Box<Msg>),
}

impl ParamValue {
    /// 单个值。⚠️ 列表与嵌套句子都给 `None`（调用方必须**显式**决定怎么办，
    /// 而不是悄悄拿第一个 / 第一个字段充数）。
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::One(text) => Some(text),
            Self::Many(_) | Self::Msg(_) => None,
        }
    }
}

/// 一句要显示给用户的话。
///
/// ⚠️ 字段是 `pub` 的（与 `EntryView` / `StatusView` 那几个「页面只认的结构」一样）：
/// 测试要直接按键断言，而多加一层访问器只是噪声。**构造**仍请走
/// [`Msg::key`] / [`Msg::param`]（它们保证 `params` 的形状对）。
///
/// ⚠️ `params` 用 `BTreeMap` 而不是 `HashMap`：跨 IPC 的是 JSON，
/// 而 `HashMap` 的顺序**每次都可能不同** —— 那会让「同一句话序列化出两种字节」，
/// 测试里也没法逐字比。排序与语言无关，所以不需要保序的 `Vec`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Msg {
    /// 译文键。见模块文档第 1 条。
    pub key: String,
    /// 占位符（`{name}`）的值。空的时候**不序列化出去** ——
    /// 页面那边 `params` 缺省就是空对象，少一层无用载荷。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, ParamValue>,
}

impl Msg {
    /// 一句没有占位符的话。
    #[must_use]
    pub fn key(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            params: BTreeMap::new(),
        }
    }

    /// 加一个占位符。名字**不带花括号**（`param("room", …)` → `{room}`）。
    ///
    /// ⚠️ 收 `impl ToString` 而不是 `impl Into<String>` 是为了让 `count` 这种数字
    /// 直接进来（`usize` 没有 `Into<String>`）—— 否则每个调用点都要写一遍
    /// `.to_string()`，而漏掉一次就编不过（好），但代码里全是噪声（不好）。
    #[must_use]
    pub fn param(mut self, name: impl Into<String>, value: impl ToString) -> Self {
        self.params
            .insert(name.into(), ParamValue::One(value.to_string()));
        self
    }

    /// 加一个**列表**占位符。见模块文档第 2 条。
    #[must_use]
    pub fn param_list<I, S>(mut self, name: impl Into<String>, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.params.insert(
            name.into(),
            ParamValue::Many(
                values
                    .into_iter()
                    .map(|value| ParamValue::One(value.into()))
                    .collect(),
            ),
        );
        self
    }

    /// 加一个**由句子组成的列表**占位符（「N 个房间全部失败：A；B」那种）。
    ///
    /// ⚠️ 用另一句话而不是拼好的字符串 —— 每个元素各自可能带自己的参数。
    #[must_use]
    pub fn param_msg_list<I>(mut self, name: impl Into<String>, values: I) -> Self
    where
        I: IntoIterator<Item = Msg>,
    {
        self.params.insert(
            name.into(),
            ParamValue::Many(
                values
                    .into_iter()
                    .map(|msg| ParamValue::Msg(Box::new(msg)))
                    .collect(),
            ),
        );
        self
    }

    /// 一句**不该翻译的外来文本**。
    ///
    /// ⚠️★ 这是本类型上**唯一的洞**，而且刻意开得很窄：只有在「引用别的系统说的话」
    /// 时才用 —— 服务端的 `message`、操作系统 / `clipboard-rs` 抛出来的原话、
    /// 以及**别人的内容**（同步过来那段正文的预览）。那些字**不是我们写的**，
    /// 翻不了也不该翻。
    ///
    /// ⚠️ 我们自己要说的话**一律走** [`Msg::key`]：用这里就是把中文写死在 Rust 里，
    /// 而那样英文界面上会冒出一句中文。⚠️ 键写错 / 该翻没翻这两件事**都有静态检查**：
    /// `tools/desktop-ui-smoke.mjs` 的判据 16（Rust 侧不许有中文界面文案）
    /// 与判据 17（Rust 发出去的每个键都得在字典里）。
    #[must_use]
    pub fn verbatim(text: impl Into<String>) -> Self {
        Self::key("verbatim").param("text", text.into())
    }

    /// 加一个**嵌套句子**占位符。见 [`ParamValue::Msg`]。
    #[must_use]
    pub fn param_msg(mut self, name: impl Into<String>, msg: Msg) -> Self {
        self.params
            .insert(name.into(), ParamValue::Msg(Box::new(msg)));
        self
    }
}

// ⚠️★ 这里**故意没有** `From<&str> for Msg`（2026-09-28 决定的，改的时候别加回来）。
//
// 加一个的话调用点会短一点（`store.notice("err", "noRoomsConfigured")`），代价是
// **键从此可以是一根裸字符串** —— 而 `tools/desktop-ui-smoke.mjs` 判据 17
// 靠 `Msg::key("…")` 这个**明确的样子**把 Rust 发出去的键一个个抠出来。
// 有了 `From`，`notice("err", "noRoomToSend")` 这种写法就**抠不出来**：
// 打了错字（`noRoomToSent`）也全绿，直到界面上印出 `noRoomToSent` 才发现 ——
// 而那是这个项目最忌讳的一类（不报错、静默）。
// 少打几个字换一条会瞎的静态检查，不划算。

#[cfg(test)]
mod tests {
    use super::*;

    /// 没有参数时 `params` **不进 JSON**（`skip_serializing_if`）——
    /// 页面那边拿到的是 `{"key":"…"}`，`params` 缺省即空。
    #[test]
    fn a_bare_key_serializes_without_params() {
        let json = serde_json::to_string(&Msg::key("notConnectedToServer")).unwrap();
        assert_eq!(json, r#"{"key":"notConnectedToServer"}"#);
    }

    /// 有参数时是 `{"key":…,"params":{…}}`，而且**键序确定**（`BTreeMap`）。
    ///
    /// ⚠️★ 拿 `HashMap` 的话这份 JSON 每次都可能是另一个顺序 ——
    /// 而「同一句话序列化出两种字节」正是 `protocol` 那个 crate 立规矩要避免的事
    /// （那边是跟 Go 逐字对齐，这边是让自己可测）。所以这条测试比它看起来重要。
    #[test]
    fn params_are_sorted_so_the_json_is_stable() {
        let msg = Msg::key("connectedButHistoryFailed")
            .param("room", "work")
            .param("reason", "HTTP 401");
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            r#"{"key":"connectedButHistoryFailed","params":{"reason":"HTTP 401","room":"work"}}"#
        );
    }

    /// ⚠️★ **列表参数整份过去，不在这里拼**（模块文档第 2 条）。
    ///
    /// 这条是「英文界面里冒出中文标点」那一类的前身：原来这里 `join("、")`，
    /// 于是英文句子中间夹一个中文顿号 —— 而中文界面看着完全正常。
    #[test]
    fn a_list_param_stays_a_json_array() {
        let msg = Msg::key("configMultipleDownloads")
            .param("count", 2)
            .param_list("rooms", ["默认", "工作"]);
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            r#"{"key":"configMultipleDownloads","params":{"count":"2","rooms":["默认","工作"]}}"#
        );
    }

    /// ⚠️★ **参数是数据，不是拼好的句子片段** —— 值里本来就有标点也原样保留
    ///（那可能是用户自己起的房间名）。
    #[test]
    fn param_values_are_passed_through_untouched() {
        let msg = Msg::key("x").param("room", "a、b");
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            r#"{"key":"x","params":{"room":"a、b"}}"#
        );
    }

    /// ⚠️★ **一句话里嵌另一句话**：不许在 Rust 里用 `format!` 拼两句话。
    ///
    /// 这里是「房间已经不在了，只能把房间名说进句子里」那条路。
    /// 拼成 `format!("{room}：{text}")` 的话，那个全角冒号在英文句子里很突兀 ——
    /// 而中文界面看着完全正常。
    #[test]
    fn a_nested_message_stays_structured() {
        let inner = Msg::key("historyFailed").param("reason", "HTTP 401");
        let outer = Msg::key("noticeForMissingRoom")
            .param("room", "work")
            .param_msg("text", inner);
        assert_eq!(
            serde_json::to_string(&outer).unwrap(),
            r#"{"key":"noticeForMissingRoom","params":{"room":"work","text":{"key":"historyFailed","params":{"reason":"HTTP 401"}}}}"#
        );
    }

    /// ⚠️★ 反过来读一遍（**同一个 JSON 进得来**）—— 这条撑着一件真事：
    /// 两条渲染器（页面那份 `I18N.say` 与壳那份 `ShellText::say`）由**同一份夹具**
    /// 钉着（`crates/desktop/tests/`），而夹具是 JSON 文件。
    /// 读不进来 = 那份夹具只能用 Rust 侧手搓的 `Msg`，页面那一半就没法验了。
    #[test]
    fn the_json_comes_back_as_the_same_message() {
        let json = r#"{"key":"noticeForMissingRoom","params":{"count":"2","rooms":["a","b"],"text":{"key":"historyFailed","params":{"reason":"HTTP 401"}}}}"#;
        let msg: Msg = serde_json::from_str(json).expect("这份 JSON 该能读回来");
        assert_eq!(msg.key, "noticeForMissingRoom");
        assert_eq!(
            msg.params.get("rooms"),
            Some(&ParamValue::Many(vec![
                ParamValue::One("a".to_owned()),
                ParamValue::One("b".to_owned())
            ]))
        );
        assert!(matches!(
            msg.params.get("text"),
            Some(ParamValue::Msg(inner)) if inner.key == "historyFailed"
        ));
        assert_eq!(serde_json::to_string(&msg).unwrap(), json);
    }
}
