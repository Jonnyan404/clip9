//! `zh` 组：全角/半角、中文标点、数字大写。
//!
//! ⚠️ 这一组**只需要码点运算与查表**，不需要词典 —— 那是 `zh.pinyin*`（pinyin-pro）与
//! `zh.simplified` / `zh.traditional`（opencc）的事，它们还没接进来，接的时候要单开一个
//! feature（见 `Cargo.toml` 里 `zh` 那段）。所以这里的四个动作是**零体积代价**的，
//! 不会因为「关掉 zh 省体积」被误伤。

use std::sync::LazyLock;

use regex::Regex;

use crate::error::ActionError;
use crate::registry::{ActionContext, Params};

/// 数字字面量。`\d` 位置一律写 `[0-9]`（Go 与 JS 的 `\d` 都是 ASCII，见 `text.rs` 的说明）。
const CN_NUMBER_SOURCE: &str = r"^-?[0-9]+(?:\.[0-9]+)?$";

const CN_DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const CN_SMALL_UNITS: [&str; 4] = ["", "十", "百", "千"];
const CN_BIG_UNITS: [&str; 4] = ["", "万", "亿", "万亿"];

/// 中文标点 → 半角，逐字符查表。
///
/// （`——` 这类双字符标点会被拆成两个 `-`，可接受 —— 为它做长串匹配不值得。）
const CN_PUNCT: [(char, char); 26] = [
    ('，', ','),
    ('。', '.'),
    ('、', ','),
    ('；', ';'),
    ('：', ':'),
    ('？', '?'),
    ('！', '!'),
    ('（', '('),
    ('）', ')'),
    ('【', '['),
    ('】', ']'),
    ('《', '<'),
    ('》', '>'),
    ('「', '"'),
    ('」', '"'),
    ('『', '\''),
    ('』', '\''),
    ('“', '"'),
    ('”', '"'),
    ('‘', '\''),
    ('’', '\''),
    ('～', '~'),
    ('…', '.'),
    ('—', '-'),
    ('－', '-'),
    ('　', ' '),
];

static CN_NUMBER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(CN_NUMBER_SOURCE).expect("内置正则必须能编译"));

pub(crate) fn run(
    id: &str,
    input: &str,
    _params: &Params,
    _ctx: &ActionContext,
) -> Option<Result<String, ActionError>> {
    Some(match id {
        "zh.fullwidth" => Ok(to_full_width(input)),
        "zh.halfwidth" => Ok(to_half_width(input)),
        "zh.punctuation" => Ok(cn_punctuation_to_en(input)),
        "zh.number" => number_to_chinese(input),
        _ => return None,
    })
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

/// 半角 → 全角。
///
/// ASCII 可见字符（0x21-0x7E）与全角（U+FF01-U+FF5E）相差 0xFEE0。
///
/// ⚠️ 空格必须**单独**处理：0x20 + 0xFEE0 = U+FF00 是个**未分配字符**，不是全角空格
/// （全角空格是 U+3000）。踩过这个坑的话，表现是「转换后空格变成方块/问号」。
/// 制表符、换行这些不在 0x21-0x7E 里，一律原样。
fn to_full_width(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            '!'..='~' => char::from_u32(ch as u32 + 0xfee0).unwrap_or(ch),
            ' ' => '\u{3000}',
            _ => ch,
        })
        .collect()
}

/// [`to_full_width`] 的逆运算。
fn to_half_width(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            '\u{ff01}'..='\u{ff5e}' => char::from_u32(ch as u32 - 0xfee0).unwrap_or(ch),
            '\u{3000}' => ' ',
            _ => ch,
        })
        .collect()
}

fn cn_punctuation_to_en(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            CN_PUNCT
                .iter()
                .find(|(from, _)| *from == ch)
                .map_or(ch, |(_, to)| *to)
        })
        .collect()
}

/// 一个「节」（最多 4 位）转成人话。
///
/// ⚠️ 节内的「零」要**合并**：`1001` → 一千零一（不是一千零零一）。
/// 注意这里只管「中间那些零」，节**开头**的零不在这儿补 —— 由调用方按「上一节有没有内容」决定，
/// 否则 `0001` 会自己补出一个零，`10000` 就变成「一万零」了。
fn section_to_text(section: &str) -> String {
    let mut out = String::new();
    let mut zero_pending = false;
    let bytes = section.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        let digit = usize::from(byte - b'0');
        let unit = CN_SMALL_UNITS[bytes.len() - 1 - index];
        if digit == 0 {
            zero_pending = true;
            continue;
        }
        if zero_pending && !out.is_empty() {
            out.push_str(CN_DIGITS[0]);
        }
        zero_pending = false;
        out.push_str(CN_DIGITS[digit]);
        out.push_str(unit);
    }
    out
}

/// 数字 → 中文大写。
///
/// ⚠️ 必须**分节**处理（4 位一节 + 万/亿），不能逐位查表：中文的单位是**组合**的
/// （十万 = 十 + 万），逐位法根本表达不出来。
fn number_to_chinese(raw: &str) -> Result<String, ActionError> {
    let s = raw.trim();
    if !CN_NUMBER_RE.is_match(s) {
        return Err(invalid("不是合法数字"));
    }

    let negative = s.starts_with('-');
    let body = s.strip_prefix('-').unwrap_or(s);
    let (int_part, dec_part) = body.split_once('.').unwrap_or((body, ""));

    let mut int_text = CN_DIGITS[0].to_owned();
    let trimmed = int_part.trim_start_matches('0');
    if !trimmed.is_empty() {
        int_text = integer_to_chinese(trimmed);
    }

    if !dec_part.is_empty() {
        int_text.push('点');
        for byte in dec_part.bytes() {
            int_text.push_str(CN_DIGITS[usize::from(byte - b'0')]);
        }
    }
    if negative {
        int_text = format!("负{int_text}");
    }
    Ok(int_text)
}

fn integer_to_chinese(trimmed: &str) -> String {
    // 从右往左每 4 位切一节，`chunks[0]` 是**最高**节。
    let mut chunks: Vec<&str> = Vec::new();
    let mut end = trimmed.len();
    while end > 0 {
        let start = end.saturating_sub(4);
        chunks.push(&trimmed[start..end]);
        end = start;
    }
    chunks.reverse();

    let mut out = String::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let big_unit = CN_BIG_UNITS[chunks.len() - 1 - index];
        let section_text = section_to_text(chunk);
        if section_text.is_empty() {
            // 整节是 0：只有前面已经有内容才补零（`10000` 不该变成「一万零」）。
            if !out.is_empty() && !out.ends_with(CN_DIGITS[0]) {
                out.push_str(CN_DIGITS[0]);
            }
            continue;
        }
        // 这节有内容、但首位是 0（数值不满千）且前面已有输出 → 中间要补零
        // （`10000001` → 一千万**零**一）。
        if !out.is_empty() && chunk.starts_with('0') && !out.ends_with(CN_DIGITS[0]) {
            out.push_str(CN_DIGITS[0]);
        }
        out.push_str(&section_text);
        out.push_str(big_unit);
    }

    // 末尾的零要去掉（`10000` 那一步补出来的），但**只有末尾的**。
    let text = out.trim_end_matches(CN_DIGITS[0]);
    // 中文习惯说「十」「十二」，不说「一十」「一十二」；但「一百一十」要保留
    // —— 只换**开头**那个，所以不能用 replace 全替。
    match text.strip_prefix("一十") {
        Some(rest) => format!("十{rest}"),
        None => text.to_owned(),
    }
}
