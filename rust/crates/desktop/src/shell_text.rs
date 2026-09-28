//! 壳（Rust）自己要说的那几句话 —— **字典在这里，句子在页面那边**。
//!
//! 规矩是「壳只递键 + 参数，把它说成人话是页面的事」（[`clip9_client::Msg`]）。
//! ⚠️★ 只有**两处**句子页面渲染不了，因为说它们的东西不属于页面：
//!
//! | 哪一处 | 为什么页面渲染不了 |
//! |---|---|
//! | **系统通知**（`notify.rs`） | 通知是**操作系统**画的。页面**故意**没有 `notification:*` 权限（`capabilities/default.json`），投递只能由 Rust 侧发起 |
//! | **托盘菜单**（`tray.rs`） | 菜单是 Tauri 建的，页面碰不到它 |
//!
//! 语言**只在页面那边**（`localStorage['locale']` + `<html data-locale>`），壳不知道用户选了
//! 哪个语种 → **页面启动时、以及每次换语种时把两份字典整个推过来**（`set_shell_messages`）。
//! 壳这边只做**查表 + 填参数**，一个字都不自己写。
//!
//! ⚠️★ 于是「渲染」有**两份实现**（页面 `ui/i18n.js` 的 `I18N.say` / 这里 [`ShellText::say`]）——
//! 同一句话两处渲染，两份一定会漂（本项目的头号忌讳）。钉住它们的是**两边都读**的同一份夹具
//! `rust/crates/desktop/tests/fixtures/say-cases.json`（Rust 侧是本文件测试里的
//! `the_fixture_renders_the_same_on_this_side`，页面侧是 `tools/desktop-ui-smoke.mjs` 判据 18）。
//! ⚠️ 判据是「**同一份输入拿到同一份输出**」，不是「两边代码看起来一样」。夹具里也带着那份字典
//! （`dicts`）—— 各写一份字典的话，这条判据会退化成「在各自那份字典上一致」，什么都证明不了。
//!
//! ⚠️★ 那条测试**不能**住 `tests/`：这个 crate 是**纯 bin**（没有 lib target），
//! `tests/*.rs` 里 `use clip9_desktop::…` 编不过。要为它拆一个 lib target 不值得 ——
//! 所以「渲染规则」的回归测试住在 `src/` 里，这是**故意的**。
//!
//! ⚠️ 为什么「推」而不是壳自己去读 `i18n.js`：那是 JS 对象字面量、不是 JSON，壳读不了；
//! 拆成 JSON 又要给页面加一趟**同步**读取（`boot.js` 得在第一次绘制前贴 `data-locale`，
//! 而 `fetch` 是异步的）。代价**明说**：页面起来前那几十毫秒壳手里没字典，
//! 渲染出来是**键本身**（三级回落的最后一级）—— 总比丢掉好查。

use std::collections::BTreeMap;
use std::sync::RwLock;

use clip9_client::{Msg, ParamValue};

/// 两份字典 + 当前语种。
///
/// ⚠️★ 它是**注入到那些能渲染的地方**的（`SystemNotifier`、`tray`），
/// 不是全局变量 —— 全局变量的坏处是「谁都能读」，于是「句子从哪来」就又说不清了。
#[derive(Default)]
pub struct ShellText {
    inner: RwLock<Dicts>,
}

/// ⚠️ `Default`：页面推过来之前的那一刻就是这个样子（两个字典都空）。
#[derive(Default)]
struct Dicts {
    /// 当前语种（页面推过来的那个）。⚠️ 认不出来就当源语言 —— 与页面的
    /// `locale()` 同一条规矩（不认识的值不能让它把界面搞成第三种语言）。
    locale: String,
    /// 页面推过来的全部语种：`{"zh": {…}, "en": {…}}`。
    ///
    /// ⚠️★ **整个推过来**、而不是只推当前那一种：页面换语种时只会再推一次，
    /// 而壳这边**源语言那一份要一直在**（三级回落的第二级要用它）。
    /// 只推当前那份的话，第三方语言一进来就再也回不到源语言了。
    all: BTreeMap<String, BTreeMap<String, String>>,
}

/// 源语言 —— 与 `ui/i18n.js` 的 `SOURCE` **必须**一致。
///
/// ⚠️ 它在这里是**回落链的第二级**（见 [`Dicts::lookup`]）。抄成另一个值的症状是
/// 「英文界面上删掉一条译文，那句话变成键」而不是变成中文 —— 很难往这上面想。
const SOURCE: &str = "zh";

/// 列表参数的分隔符的**键**。
///
/// ⚠️★ 分隔符本身**不是常量**：中文用「、」、英文用「, 」。它跟句子一样是**译文**，
/// 所以住在字典里（`ui/i18n.js` 的 `list.sep`）—— 写在这里就等于替英文定了一个中文顿号，
/// 而那正是这个模块要消灭的那类东西。
const LIST_SEP_KEY: &str = "list.sep";

impl ShellText {
    /// 造一个**还没有字典**的（页面推过来之前）。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 页面把字典推过来了（启动时一次，之后每次换语种一次）。
    pub fn set(&self, locale: &str, all: BTreeMap<String, BTreeMap<String, String>>) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        inner.locale = locale.to_owned();
        inner.all = all;
    }

    /// 一句话 → 成文的文本。
    ///
    /// ⚠️★ **壳里每一个键都长成 `Msg::key("…")`**（没有「只传一根裸键」的入口）——
    /// 判据 16/17 就是靠这个形态把壳发出去的键一个个抠出来的，而裸键抠不出来：
    /// 打了错字也全绿，直到界面上印出那个键才发现。少打几个字换一条会瞎的静态检查，
    /// 不划算（同一条理由让 [`Msg`] 上**没有** `From<&str>`）。
    #[must_use]
    pub fn say(&self, msg: &Msg) -> String {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        inner.say(msg)
    }
}

impl Dicts {
    /// 当前语种；认不出来（空 / 没推过 / 不认识）→ 源语言。
    fn locale_of(&self) -> String {
        if self.all.contains_key(&self.locale) {
            self.locale.clone()
        } else {
            SOURCE.to_owned()
        }
    }

    /// 「字典里有这一条吗」→ 查，三级回落**与页面的 `t()` 逐条对齐**：
    /// 当前语种 → 源语言 → **键本身**。
    ///
    /// ⚠️★ 最后一级是**故意难看**的（屏幕上印着 `historyFailed` 这样的键，一眼就知道该补哪条）——
    /// 比空白、比「英文里混着中文」都好找。⚠️ 判据 17 就是不让这一级有机会出现。
    // ⚠️ 显式写生命周期：返回的既可能是字典里的那条（借 `self`），
    // 也可能是**键本身**（借 `key`）—— 不写的话编译器只肯按 `self` 那个来推断，
    // 于是第三级回落编不过（而那一级正是「难看但看得见」那条兜底）。
    fn lookup<'a>(&'a self, key: &'a str) -> &'a str {
        self.all
            .get(&self.locale_of())
            .and_then(|table| table.get(key))
            .or_else(|| self.all.get(SOURCE).and_then(|table| table.get(key)))
            .map(String::as_str)
            .unwrap_or(key)
    }

    /// 一个参数值 → 文本。
    fn render_param(&self, value: &ParamValue) -> String {
        match value {
            ParamValue::One(text) => text.clone(),
            // ⚠️★ 列表**在这里才拼**，用的是**译文里的**分隔符（见 `LIST_SEP_KEY`）。
            ParamValue::Many(items) => {
                let sep = self.lookup(LIST_SEP_KEY).to_owned();
                items
                    .iter()
                    .map(|item| self.render_param(item))
                    .collect::<Vec<_>>()
                    .join(&sep)
            }
            ParamValue::Msg(inner) => self.say(inner),
        }
    }

    fn say(&self, msg: &Msg) -> String {
        let template = self.lookup(&msg.key);
        let params: BTreeMap<&str, String> = msg
            .params
            .iter()
            .map(|(name, value)| (name.as_str(), self.render_param(value)))
            .collect();
        fill(template, &params)
    }
}

/// 把模板里的 `{name}` 换成值。
///
/// ⚠️★ **与页面的 `fill()` 是同一条规则的两个实现**（`ui/i18n.js`）：
/// 只替换**认识的**名字，不认识的原样留着（同样是「要看得见」）；没闭合的花括号原样留着。
/// ⚠️ 名字的字符集也照抄页面的 `\w+`（字母 / 数字 / 下划线）——
/// 这里放宽的话，`{房间}` 这种模板在两边会渲染成不同的东西。
fn fill(template: &str, params: &BTreeMap<&str, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(end) = rest[start..].find('}').map(|at| start + at) else {
            break; // 没闭合：整段原样留着
        };
        let name = &rest[start + 1..end];
        out.push_str(&rest[..start]);
        match params.get(name) {
            Some(value) if is_word(name) => out.push_str(value),
            _ => out.push_str(&rest[start..=end]),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// `\w+` 那一套（ASCII 字母 / 数字 / 下划线），与页面正则里的 `\w` 对齐。
fn is_word(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **两边共用的那份夹具**（页面侧是 `tools/desktop-ui-smoke.mjs` 判据 18）。
    ///
    /// ⚠️★ `include_str!` 而不是运行时读文件：夹具是**编译期**进来的 ——
    /// 运行时按路径找文件的话，找不到就变成「读了 0 条用例、全绿」，
    /// 而那正是本项目最忌讳的「静默变绿」。
    const FIXTURE: &str = include_str!("../tests/fixtures/say-cases.json");

    /// 夹具的形状。⚠️ 只声明**测试要用**的字段（`note` 那些是给人读的，
    /// serde 默认忽略不认识的键，所以不必在这里抄一遍）。
    #[derive(serde::Deserialize)]
    struct Fixture {
        /// 源语言。⚠️ 夹具里那条「当前语种缺这条 → 回落成源语言」的期望值**取决于它**，
        /// 所以测试要断言它是 `zh`（与 `super::SOURCE` 一致），不能在夹具里偷偷换。
        source: String,
        dicts: BTreeMap<String, BTreeMap<String, String>>,
        cases: Vec<FixtureCase>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureCase {
        name: String,
        msg: Msg,
        expect: BTreeMap<String, String>,
    }

    /// 夹具里那份字典 —— **不在这里另写一份**（理由见模块文档）。
    fn dicts() -> BTreeMap<String, BTreeMap<String, String>> {
        fixture().dicts
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("夹具必须是合法 JSON —— 改形状要连这里一起改")
    }

    fn shell(locale: &str) -> ShellText {
        let shell = ShellText::new();
        shell.set(locale, dicts());
        shell
    }

    /// ⚠️★ **同一份夹具、两份渲染器、逐字一致** —— 这是壳这一半，
    /// 页面那一半是 `tools/desktop-ui-smoke.mjs` 判据 18（它跑真的 `I18N.say`）。
    ///
    /// ⚠️★ 两半**都要在**：只跑一边的话，漂掉的可能正好是另一边，而症状是
    /// 「同一条通知在系统通知里是一个样、在界面里是另一个样」—— 没人会同时看两处。
    /// ⚠️ 这条测试的力气全在**夹具**上：它自己一行断言都没写死（逐条比 `expect`）。
    /// 所以「加一种参数形状」的正确做法是往 `cases` 里加一条，**不是**在这里加断言。
    #[test]
    fn the_fixture_renders_the_same_on_this_side() {
        let fixture = fixture();
        assert_eq!(
            fixture.source, SOURCE,
            "夹具的源语言与 `ShellText` 的 `SOURCE` 必须是同一个 —— 回落那条用例靠它"
        );
        assert!(
            fixture.dicts.len() >= 2,
            "至少两种语言，否则回落那几条没意义"
        );
        for locale in fixture.dicts.keys() {
            let shell = ShellText::new();
            shell.set(locale, fixture.dicts.clone());
            for case in &fixture.cases {
                // ⚠️ 期望值直接从 `expect` 里取（它是**夹具的作者**写的，不是这里算出来的）——
                // 在这里算出来就等于自己证明自己。
                let Some(expected) = case.expect.get(locale) else {
                    panic!("用例「{}」缺 `{locale}` 那一列期望值", case.name);
                };
                // ⚠️ 只报**是哪个用例**：报「查到的模板」要在这里重写一遍查表规则，
                // 而那正是被测的东西 —— 它会跟着实现对，于是永远指不出真问题。
                assert_eq!(
                    shell.say(&case.msg),
                    expected.as_str(),
                    "语种 {locale} / 用例「{}」",
                    case.name
                );
            }
        }
    }

    /// ⚠️★ 页面推过来之前壳手里是**空的** —— 那时渲染出来的是**键本身**，
    /// 而不是 panic、也不是空白（三级回落的最后一级）。
    #[test]
    fn before_the_dictionary_arrives_a_key_renders_as_itself() {
        let empty = ShellText::new();
        assert_eq!(empty.say(&Msg::key("historyFailed")), "historyFailed");
        assert_eq!(empty.say(&Msg::key("quit")), "quit");
        // ⚠️ 连**托盘菜单那几项**也一样（它们走的也是 `say`，`lookup` 的第三级）。
        assert_eq!(empty.say(&Msg::key("trayQuit")), "trayQuit");
    }

    /// 参数照名字填，句子的形状由字典决定。
    #[test]
    fn a_param_is_filled_in_by_name() {
        let shell = shell("en");
        assert_eq!(
            shell.say(&Msg::key("historyFailed").param("reason", "HTTP 401")),
            "Could not fetch history: HTTP 401"
        );
    }

    // ⚠️★ 别给「当前是哪个语种」加访问器。语言设置**只在页面那边**，
    // 壳这边是**被动**接受推送的（`set_shell_messages`）—— 多一个 `locale()` 就等于
    // 多一条「谁都能问、也谁都能据此改行为」的路，而两条路一定会漂。
    // 壳需要语言的地方只有一处：**渲染**（[`ShellText::say`] 自己按当前语种查）。

    /// ⚠️★ **列表整份进来、按译文里的分隔符拼** —— 不是壳里写一个「、」。
    /// 英文那份给的是 `", "`，所以同一句话在两种语言里分开的方式不一样。
    #[test]
    fn a_list_is_joined_with_the_separator_from_the_dictionary() {
        let msg = Msg::key("configMultipleDownloads")
            .param("count", 2)
            .param_list("rooms", ["默认", "工作"]);
        assert_eq!(
            shell("zh").say(&msg),
            "2 个房间同时开着下载：默认、工作",
            "中文用顿号"
        );
        assert_eq!(
            shell("en").say(&msg),
            "2 rooms download at once: 默认, 工作",
            "英文用逗号加空格 —— 分隔符是译文，不是常量"
        );
    }

    /// ⚠️ 嵌套的一句话**递归**渲染，拼接方式（那个冒号）也由**译文**决定，
    /// 不是壳里 `format!("{room}：{text}")` 拼出来的。
    #[test]
    fn a_nested_message_is_rendered_recursively() {
        let msg = Msg::key("noticeForMissingRoom")
            .param("room", "work")
            .param_msg("text", Msg::key("uploadSentToRooms").param("count", 3));
        assert_eq!(shell("zh").say(&msg), "work：已发到 3 个房间");
        assert_eq!(shell("en").say(&msg), "work: Sent to 3 rooms");
    }

    /// `verbatim` 那条路：**外来文本原样出来**，一个字符都不动
    /// （哪怕里面正好写着 `{reason}`）。
    #[test]
    fn verbatim_text_passes_through_untouched() {
        let shell = shell("en");
        assert_eq!(
            shell.say(&Msg::verbatim("HTTP 413：{reason} 最大 4096 字符")),
            "HTTP 413：{reason} 最大 4096 字符"
        );
    }

    /// ⚠️★ 三级回落逐级验：当前语种 → 源语言 → 键本身。
    /// ⚠️ 第二级是「英文那边漏了一条」时的救生圈：英文界面上印**中文**，
    /// 而不是印一个键 —— 判据 14 会去补那一条，但补上之前不该难看。
    #[test]
    fn the_fallback_chain_is_locale_then_source_then_the_key() {
        let shell = ShellText::new();
        let mut all = dicts();
        // 英文那份故意少一条。
        all.get_mut("en").unwrap().remove("uploadSentToRooms");
        shell.set("en", all);

        assert_eq!(
            shell.say(&Msg::key("uploadSentToRooms").param("count", 3)),
            "已发到 3 个房间",
            "英文缺了那条 → 回落到中文"
        );
        assert_eq!(shell.say(&Msg::key("nope")), "nope", "两边都没有 → 键本身");
    }

    /// 不认识的语种 → 按源语言渲染（**不是**按它自己去查一份查不到的字典）。
    #[test]
    fn an_unknown_locale_falls_back_to_the_source() {
        let shell = ShellText::new();
        let mut all = dicts();
        all.insert("ja".to_owned(), BTreeMap::new());
        shell.set("ja", all);
        assert_eq!(
            shell.say(&Msg::key("historyFailed").param("reason", "x")),
            "取历史失败：x",
            "`ja` 那份是空的 → 回落到源语言"
        );
    }

    /// ⚠️★ 参数替换的两条边界，**与页面 `fill()` 逐条对齐**：
    /// ① 模板里有、但这次没给的值 → 原样留着（要看得见）；
    /// ② 没闭合的花括号 → 整段原样留着（不 panic、不吞掉后面）。
    #[test]
    fn the_fill_rule_matches_the_page() {
        let params = BTreeMap::from([("a", "A".to_owned())]);
        assert_eq!(fill("{a}/{b}", &params), "A/{b}");
        assert_eq!(fill("没闭合 {a", &params), "没闭合 {a");
        // ⚠️ 名字必须整个是 `\w+`（页面那边是 `\{(\w+)\}`）：`{a b}` 谁都替换不了。
        assert_eq!(fill("[{a b}]", &params), "[{a b}]");
        assert_eq!(fill("", &params), "");
    }
}
