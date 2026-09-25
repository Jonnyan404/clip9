//! `text` 组：行处理、大小写、反转、提取、按模式替换。
//!
//! # 正则的 source 是**契约**，而 `\d` / `\b` / `\s` 在三处实现里语义不同
//!
//! 这几个模式在三个地方各有一份实现：Go（`render_actions.go`，RE2）、前端
//! （`data/actions.js`，JS）和这里（`regex` crate）。而**同一个 source 字符串**
//! 在这三种引擎里未必是同一个语义 —— 不说清楚就会「同一个动作在预览区捞出来三个、
//! 定时任务里捞出来一个」，正是这个模块一直防的那类错。
//!
//! | 转义 | Go（RE2） | JS | `regex` 默认 | 这边写成 | 结论 |
//! |---|---|---|---|---|---|
//! | `\d` | ASCII | **ASCII** | Unicode | `[0-9]` | 三方一致 |
//! | `\b` | ASCII | **ASCII** | Unicode | `(?-u:\b)` | 三方一致 |
//! | `\s` | **ASCII** | Unicode | Unicode | `\s` | 跟**前端**（Go 是少数派） |
//!
//! 展开说三句：
//!
//! 1. `\d` 与 `\b`：Rust 的默认是 **Unicode**（`\d` 认全角数字、`\b` 把汉字当词字符），
//!    而 Go 与 JS 都是 ASCII。不改的话「见https://a.com」（中文紧贴 URL，非常常见）
//!    在 Go/前端能捞出来、在这边**捞不出来** —— 因为 Unicode 语义下汉字与 `h` 之间没有词边界。
//!    所以这两处**显式写成 ASCII**，代价是 source 与 Go 不再逐字相同：
//!    `[0-9]` 是 `\d` 的 ASCII 展开，`(?-u:\b)` 是「ASCII 词边界」。
//!    ⚠️ 不能用全局 `(?-u)` 代替：那样 `[^\s<>"'，。…]` 这类含多字节字符的**否定**字符类
//!    会变成「可以匹配非法 UTF-8」，`regex` 直接拒绝编译。
//! 2. `\s`：这里**故意跟前端**。Go 的 `\s` 只有 ASCII 空白，于是
//!    `https://a.com　后面的字`（全角空格）在 Go 那边会把「后面的字」**一起吞进 URL**，
//!    而前端与这边都停在全角空格。两种都是「按 source 一字不改」的结果，
//!    差别只在引擎 —— 那就跟**用户看得见的那个**（预览区）走。
//!    ⚠️ 这也说明 Go 那条「与前端 source 逐字比对」的契约测试有个盲点：
//!    **比了字符串，没比语义**。`\s` 就是它现在盖不住的那一处。
//! 3. 大小写映射（`text.upper` / `text.lower`）同样跟前端走完整映射，见
//!    [`to_upper`] 的注释。

use regex::Regex;
use std::sync::LazyLock;

use crate::error::ActionError;
use crate::registry::{ActionContext, Params};

// ── 提取用的正则 ──────────────────────────────────────────────────────
//
// ⚠️ 除了上表说的 `\d` / `\b` / `\s` 三处，其余必须与 Go / 前端的 source **逐字相同**。
// 中文标点（`，。；：、（）【】《》「」“”`）在排除集里是**必须的**：
// 少了它们，`见 https://a.com，然后` 会把逗号后面的中文一起吃进去。

/// 与 Go `urlRe` 同一模式。`(?i)` 对应前端 `gi` 里的 `i`。
const URL_SOURCE: &str = r#"(?i)(?-u:\b)https?://[^\s<>"'，。；：、（）【】《》「」“”]+|(?-u:\b)www\.[^\s<>"'，。；：、（）【】《》「」“”]+"#;

/// 与 Go `emailRe` 同一模式。
///
/// ⚠️ 字符类里的 `-` 放在**末尾**就不用转义（`[A-Za-z0-9-]`）—— 这条正则被
/// `text.replace` 的 email 模式复用，而前端那份契约测试是**逐字**比对的，多一个反斜杠就红。
const EMAIL_SOURCE: &str = r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}";

/// 与 Go `ipv4Re` 同一模式：四段各限 0-255，两侧 ASCII 词边界。
const IPV4_SOURCE: &str = r"(?-u:\b)(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?-u:\b)";

/// 与 Go `numberRe` 同一模式：`-?` 只吃负号（不吃 `+`），千分位逗号在数字中间也算。
const NUMBER_SOURCE: &str = r"-?[0-9][0-9,]*(?:\.[0-9]+)?";

/// 与 Go `cnPhoneRe` 同一模式：1 开头、第二位 3-9、共 11 位。**本身不含边界**。
const CN_PHONE_SOURCE: &str = r"1[3-9][0-9]{9}";

fn compiled(source: &'static str) -> Regex {
    // 模式都是常量，编译失败只可能是改错了 —— 那就该在测试里炸，而不是上线后静默不匹配。
    Regex::new(source).expect("内置正则必须能编译")
}

/// `text.extractPhone` 专用的边界检查。
///
/// ⚠️ Go 那边用不了前瞻（RE2 没有），所以它先按裸号码找、再手工看左右字符；
/// `regex` crate 同样没有前瞻，这里照抄同一个办法 —— **两侧必须是同一个办法**，
/// 否则「边界」的定义会悄悄分叉。
// ⚠️ 是 `static` 不是 `const`：`LazyLock` 里有 `OnceLock`（内部可变），
// 写成 `const` 会让每次使用都**造一个新实例**（正则要重编一遍），clippy 也会报
// `named constant with interior mutability`。
static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| compiled(CN_PHONE_SOURCE));
static URL_RE: LazyLock<Regex> = LazyLock::new(|| compiled(URL_SOURCE));
static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| compiled(EMAIL_SOURCE));
static IPV4_RE: LazyLock<Regex> = LazyLock::new(|| compiled(IPV4_SOURCE));
static NUMBER_RE: LazyLock<Regex> = LazyLock::new(|| compiled(NUMBER_SOURCE));

// ── 替换模式表 ────────────────────────────────────────────────────────

/// 「查找」的常见模式。`None` = 不匹配，用用户填的**字面**查找词。
///
/// ⚠️ 顺序就是下拉里的顺序，**第一项是默认值**（与注册表的 `REPLACE_MODES` 同一份顺序）。
/// ⚠️ `spaces` 只压**水平**空白：用 `\s{2,}` 会把换行也算进去，跨行的缩进被一起吃掉。
/// ⚠️ `phone` / `url` 这几条**复用提取区那几个模式**（同一个模式不该有两份写法），
/// 所以它们**没有** `extractPhone` 那种左右边界检查 —— `138001380001` 会被吞掉前 11 位。
/// 这个「不一致」是 Go 与前端共有的，fixture 里有用例钉着，别顺手「修正」。
const REPLACE_MODES: [(&str, Option<&str>, bool); 8] = [
    ("text", None, false),
    ("digits", Some(r"[0-9]+"), false),
    ("latin", Some(r"[A-Za-z]+"), false),
    ("spaces", Some(r"[ \t]{2,}"), false),
    ("email", Some(EMAIL_SOURCE), false),
    ("url", Some(URL_SOURCE), true),
    ("phone", Some(CN_PHONE_SOURCE), false),
    ("ip", Some(IPV4_SOURCE), false),
];

pub(crate) fn run(
    id: &str,
    input: &str,
    params: &Params,
    _ctx: &ActionContext,
) -> Option<Result<String, ActionError>> {
    Some(match id {
        "text.trimLines" => Ok(lines(input)
            .map(|line| line.trim().to_owned())
            .collect::<Vec<_>>()
            .join("\n")),
        "text.dropBlank" => Ok(lines(input)
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")),
        "text.dedupe" => Ok(dedupe(input)),
        "text.sort" => Ok(sorted(input)),
        "text.upper" => Ok(to_upper(input)),
        "text.lower" => Ok(to_lower(input)),
        "text.replace" => replace(input, params),
        "text.reverse" => Ok(input.chars().rev().collect()),
        "text.extractUrl" => Ok(extract_joined(input, &URL_RE)),
        "text.extractEmail" => Ok(extract_joined(input, &EMAIL_RE)),
        "text.extractPhone" => Ok(extract_phones(input)),
        "text.extractIp" => Ok(extract_joined(input, &IPV4_RE)),
        "text.extractNumber" => Ok(extract_joined(input, &NUMBER_RE)),
        _ => return None,
    })
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

/// Go 那边一律是 `strings.Split(s, "\n")`：**空串不是「零行」，是一行空行**。
///
/// 这个细节在 `dropBlank` / `dedupe` / `trimLines` 上都会露出来（`"   \n\t\n"` 的结果是
/// 两行都空 → `dropBlank` 之后是空串，而不是「没有行」），所以拆行这件事收在一处。
fn lines(input: &str) -> impl Iterator<Item = &str> {
    input.split('\n')
}

/// 去重，**但空行从不参与**。
///
/// ⚠️ 空行不去重是刻意的：连着几个空行是有意的排版，去掉会改变结构（与前端同一条规则）。
/// 实现上就是「空行直接放行、不记入 seen」—— 看着像漏判，其实是规则本身。
fn dedupe(input: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    lines(input)
        .filter(|line| {
            if line.trim().is_empty() {
                return true;
            }
            if seen.contains(line) {
                return false;
            }
            seen.push(line);
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// ⚠️ 与前端有一处**已知差异**：前端用 `localeCompare(b, 'zh')`（中文拼音序），
/// 这边与 Go 都用**字节序**。小数、纯英文、日期的排序两边一致，中文多音字场景会有出入。
/// 与其做一个半吊子的拼音库，不如把差异写在这里（fixture 只钉「ASCII 输入下的次序」）。
fn sorted(input: &str) -> String {
    let mut lines: Vec<&str> = lines(input).collect();
    lines.sort_unstable();
    lines.join("\n")
}

/// 大写。
///
/// ⚠️ 与 Go 有一处**已知差异**，而且是刻意选边站的：Go 的 `strings.ToUpper` 走
/// **简单映射**（一个码点对一个码点），`straße` → `STRAßE`；这边与前端 JS 一样走
/// **完整映射**，`straße` → `STRASSE`。
///
/// 为什么跟前端而不跟 Go：这个动作在界面上有**预览区**，用户看到的就是 JS 的结果。
/// 「预览区显示 STRASSE、定时任务发出 STRAßE」正是这个项目最不能接受的那类错。
/// `text.lower` 同理（`İ` → 这边是 `i̇`，Go 是 `i`）。
#[must_use]
pub fn to_upper(input: &str) -> String {
    input.to_uppercase()
}

/// 小写。与 [`to_upper`] 同一处差异、同一套理由。
#[must_use]
pub fn to_lower(input: &str) -> String {
    input.to_lowercase()
}

/// 按模式替换；「文本」模式下就是**字面**替换。
///
/// ⚠️ 替换文本一律当**字面**用，不做组引用：用户填的是「替换成什么文字」，
/// 把它当模板会让 `$` 变成危险字符。Go 用 `ReplaceAllLiteralString`、前端用
/// `replace(re, () => with)` —— 而 `regex` crate 的 `replace_all` **默认会展开 `$1` / `$&`**，
/// 所以这里必须包一层 [`regex::NoExpand`]。少了它，同一个动作在预览区和定时任务里
/// 就是两个结果，而且只有填了 `$` 的用户才看得见。
fn replace(input: &str, params: &Params) -> Result<String, ActionError> {
    let mode = params.get("mode").map_or("", |m| m.trim());
    let mode = if mode.is_empty() { "text" } else { mode };
    let with = params.get("with").map_or("", String::as_str);

    let Some((_, source, case_fold)) = REPLACE_MODES.iter().find(|(key, _, _)| *key == mode) else {
        return Err(invalid(format!("未知的查找模式 {mode:?}")));
    };

    let Some(source) = source else {
        // 「文本」模式：字面替换。
        let find = params.get("find").map_or("", String::as_str);
        if find.is_empty() {
            // ⚠️ 不能当成「在每个字符之间插入」（用户只会看到一串乱码，不知道发生了什么）。
            return Err(invalid("「查找」不能为空"));
        }
        return Ok(input.replace(find, with));
    };

    let source_text = if *case_fold {
        format!("(?i){source}")
    } else {
        (*source).to_owned()
    };
    let re = Regex::new(&source_text).map_err(|e| invalid(format!("查找模式编译失败: {e}")))?;
    Ok(re.replace_all(input, regex::NoExpand(with)).into_owned())
}

/// 捞一遍、**去重并保持出现顺序**，每行一个。
///
/// ⚠️ 保序很重要：用户要的是「按原文出现顺序的清单」，按长度或字典序排都对不上原文。
fn extract_joined(input: &str, re: &Regex) -> String {
    let mut out: Vec<&str> = Vec::new();
    for found in re.find_iter(input) {
        let text = found.as_str();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out.join("\n")
}

/// 中国大陆手机号：1 开头、第二位 3-9、共 11 位，**并要求左右不是数字**。
///
/// ⚠️ 边界不能省：不判的话 `138001380001`（12 位连写）会被截出前 11 位。
/// 但左右判断只看**数字**（字母算边界）—— `a13800138000b` 是能捞出来的。
fn extract_phones(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<&str> = Vec::new();
    for found in PHONE_RE.find_iter(input) {
        let (start, end) = (found.start(), found.end());
        // 前后只可能是 ASCII 数字才需要排除；多字节字符的首字节 >= 0x80，不会被误判。
        if start > 0 && bytes[start - 1].is_ascii_digit() {
            continue;
        }
        if end < bytes.len() && bytes[end].is_ascii_digit() {
            continue;
        }
        let text = found.as_str();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out.join("\n")
}
