//! `encode` 组：base64 / URL / hex / HTML 实体 / Unicode 转义。
//!
//! ⚠️ 这一组里几乎每条都至少有一处「看起来一样、其实不一样」的边界，所以每条都配了
//! 一句说明，而且都被 `cases/actions/cases.json` 里的用例钉住。改之前先读注释。

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

use crate::error::ActionError;
use crate::registry::{ActionContext, Params};

/// 与 Go `base64.StdEncoding` 对齐的解码器。
///
/// ⚠️ 两处必须显式写出来，不能吃默认值：
/// 1. `with_decode_allow_trailing_bits(true)` —— Go **不检查**最后那几个补位比特，
///    所以 `YR==` 在 Go 那边解出来是 `a`；而 Rust 的默认配置会报错。
/// 2. `RequireCanonical` —— 反过来，Go 要求填充**合法**（`abc` 这种长度不是 4 的倍数要报错，
///    与前端 `atob('abc')` 抛错一致）。「不做无填充回退」是刻意的：回退一次确实能多收几个输入，
///    代价是「预览区报错、定时任务却有结果」这种两侧不一致。
const GO_BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

// ⚠️ `pub(crate)` 而不是 `pub(super)`：调用它的是**兄弟模块** `registry`，
// 不是父模块。分组模块自己不对外暴露。
pub(crate) fn run(
    id: &str,
    input: &str,
    _params: &Params,
    _ctx: &ActionContext,
) -> Option<Result<String, ActionError>> {
    Some(match id {
        "encode.base64" => Ok(GO_BASE64.encode(input)),
        "encode.base64.decode" => base64_decode(input),
        "encode.url" => Ok(encode_uri_component(input)),
        "encode.url.decode" => url_decode(input),
        "encode.hex" => Ok(hex_encode(input)),
        "encode.hex.decode" => hex_decode(input),
        "encode.html" => Ok(encode_html(input)),
        "encode.html.decode" => Ok(decode_html(input)),
        "encode.unicode" => Ok(to_unicode_escapes(input)),
        "encode.unicode.decode" => Ok(from_unicode_escapes(input)),
        _ => return None,
    })
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

fn base64_decode(input: &str) -> Result<String, ActionError> {
    let bytes = GO_BASE64
        .decode(input.trim())
        .map_err(|e| invalid(format!("不是合法的 Base64: {e}")))?;
    // ⚠️ Base64 解出来可以是**任意字节**（`%` 那种不算，但 `/w==` 是 0xFF）。
    // Go 那边这种字符串内部就是非法 UTF-8；契约层面（JSON）它同样会变成 U+FFFD，
    // 所以这里用 lossy 才和 fixture 里记的一致。
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 等价于 `encodeURIComponent`。
///
/// ⚠️ 不能用 `url::form_urlencoded` 那套：它把空格编成 `+`，而且不转义 `!~*'()`。
/// 同一段文本在预览区（前端动作库）和定时任务里编出不同结果，属于那种
/// 「看起来都对、对一下才发现不一样」的错 —— 而用户是拿它去拼 URL 的。
const URI_COMPONENT_UNRESERVED: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii() && URI_COMPONENT_UNRESERVED.contains(&(ch as u8)) {
            out.push(ch);
            continue;
        }
        let mut buffer = [0u8; 4];
        for byte in ch.encode_utf8(&mut buffer).as_bytes() {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 等价于 `decodeURIComponent`：**不把 `+` 当空格**。
///
/// ⚠️ 与 Go 的一处取舍：Go 返回的是**原始字节**（`%FF` 会留下一个非法字节），
/// Rust 的 `String` 装不下非法 UTF-8，所以这里按 UTF-8 lossy 转换 ——
/// 而 Go 那条字符串进 JSON 时同样会变成 U+FFFD，**契约层面两边一致**。
fn url_decode(input: &str) -> Result<String, ActionError> {
    let bytes = input.as_bytes();
    if !bytes.contains(&b'%') {
        return Ok(input.to_owned());
    }
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        // ⚠️ 边界是 `i + 2 >= len`（不是 `>`）：`%41` 这种刚好到串尾的要能解出来。
        if i + 2 >= bytes.len() {
            return Err(invalid("截断的百分号转义"));
        }
        let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
        let byte = u8::from_str_radix(hex, 16)
            .map_err(|_| invalid(format!("非法的百分号转义 {:?}", &input[i..i + 3])))?;
        out.push(byte);
        i += 3;
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// 每个字节两两十六进制、**空格分隔**、小写（Go 是 `hex.EncodeToString` 逐字节拼）。
fn hex_encode(input: &str) -> String {
    input
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 先丢掉所有非十六进制字符，再要求长度是偶数。
///
/// ⚠️ 顺序不能反过来：`0x61` 这种写法里 `x` 先被丢掉，剩下的 `061` 是**奇数**长度，
/// 于是它报错 —— 这个结果看着别扭，但它就是 Go 的行为，用例里钉着。
fn hex_decode(input: &str) -> Result<String, ActionError> {
    let cleaned: String = input.chars().filter(char::is_ascii_hexdigit).collect();
    if !cleaned.len().is_multiple_of(2) {
        return Err(invalid("hex 长度必须是偶数"));
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    for pair in cleaned.as_bytes().chunks(2) {
        let byte = u8::from_str_radix(std::str::from_utf8(pair).unwrap_or(""), 16)
            .map_err(|e| invalid(format!("不是合法的 hex: {e}")))?;
        out.push(byte);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// ⚠️ 只转 `& < > "` 四个，**不转单引号**。
///
/// Go 那边特意没用 `html.EscapeString`（它连 `'` 也转成 `&#39;`），因为前端只转四个 ——
/// 转多了就是「同一个动作在两个界面输出不同」。
///
/// 单遍替换（不是链式 `replace` 之后再 `replace`）：否则刚生成的 `&amp;` 会被再转一次。
fn encode_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 常用 HTML 实体（**只到分号形式**）。
///
/// ⚠️ 已知差异，且是刻意的：Go 的 `html.UnescapeString` 有一张 2000+ 项的表，
/// 前端是借 `<textarea>.innerHTML` 让浏览器解码。这里只收常见的那一档 ——
/// 与其抄一张 2000 项的表（**抄错一项就永远不知道**），不如把边界写在这儿：
/// 表里没有的实体**原样保留**（和 Go 的「认不出来就留着」行为一致，只是认得出来的更少）。
/// 少见实体（`&because;` 之类）在定时任务里不会被解 —— 而这类文本本来也不该走这个动作。
///
/// 另外 Go 对**省略分号**的写法也认一部分（HTML5 的历史包袱），这里**不认**：
/// 只认 `&name;` 与 `&#123;` / `&#x1F;`。
const NAMED_ENTITIES: &[(&str, char)] = &[
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
    ("nbsp", '\u{a0}'),
    ("copy", '\u{a9}'),
    ("reg", '\u{ae}'),
    ("trade", '\u{2122}'),
    ("hellip", '\u{2026}'),
    ("mdash", '\u{2014}'),
    ("ndash", '\u{2013}'),
    ("middot", '\u{b7}'),
    ("bull", '\u{2022}'),
    ("deg", '\u{b0}'),
    ("plusmn", '\u{b1}'),
    ("times", '\u{d7}'),
    ("divide", '\u{f7}'),
    ("laquo", '\u{ab}'),
    ("raquo", '\u{bb}'),
    ("ldquo", '\u{201c}'),
    ("rdquo", '\u{201d}'),
    ("lsquo", '\u{2018}'),
    ("rsquo", '\u{2019}'),
    ("sect", '\u{a7}'),
    ("para", '\u{b6}'),
    ("yen", '\u{a5}'),
    ("euro", '\u{20ac}'),
    ("pound", '\u{a3}'),
    ("cent", '\u{a2}'),
    ("larr", '\u{2190}'),
    ("uarr", '\u{2191}'),
    ("rarr", '\u{2192}'),
    ("darr", '\u{2193}'),
    ("harr", '\u{2194}'),
];

fn decode_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '&' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        match entity_at(&chars, i) {
            Some((decoded, consumed)) => {
                out.push(decoded);
                i += consumed;
            }
            None => {
                // 认不出来就原样留着 —— 别把用户文本里的 `&` 吃掉。
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

/// 从 `chars[start]`（一定是 `&`）起尝试解一个实体，返回 `(字符, 消耗了几个 char)`。
fn entity_at(chars: &[char], start: usize) -> Option<(char, usize)> {
    // 形如 `&#123;` / `&#x1F;` 的数值实体。
    if chars.get(start + 1) == Some(&'#') {
        let hex = matches!(chars.get(start + 2), Some('x') | Some('X'));
        let digits_start = if hex { start + 3 } else { start + 2 };
        let mut end = digits_start;
        while end < chars.len()
            && (chars[end].is_ascii_hexdigit() || (!hex && chars[end].is_ascii_digit()))
        {
            end += 1;
        }
        if end == digits_start || chars.get(end) != Some(&';') {
            return None;
        }
        let text: String = chars[digits_start..end].iter().collect();
        let code = u32::from_str_radix(&text, if hex { 16 } else { 10 }).ok()?;
        // ⚠️ 非法码点用 U+FFFD 而不是原样保留 —— 这是 Go `html.UnescapeString` 的行为，
        // 也是 HTML5 的规定（浏览器那边同样如此，所以前端也是这个结果）。
        let decoded = char::from_u32(code).unwrap_or('\u{fffd}');
        return Some((decoded, end - start + 1));
    }

    // 命名实体：只认 `&name;`。
    let mut end = start + 1;
    while end < chars.len() && chars[end].is_ascii_alphanumeric() {
        end += 1;
    }
    if end == start + 1 || chars.get(end) != Some(&';') {
        return None;
    }
    let name: String = chars[start + 1..end].iter().collect();
    // 大小写敏感：`&AMP;` 在 Go 那边也不认。
    let (_, decoded) = NAMED_ENTITIES.iter().find(|(key, _)| *key == name)?;
    Some((*decoded, end - start + 1))
}

/// 把非 ASCII / 不可打印字符转成 `\uXXXX`。
///
/// ⚠️★ 必须按 **UTF-16 单元**遍历，不能按 `char`：emoji 是一个码点、两个单元，
/// 按码点处理会被当成单字符，输出成 `\u1fab6` 这种「看着对、JS 解不出来」的东西。
/// 前端在这里踩过同一个坑（`岚🪶` → `岚\ud83e`，低半截被丢掉），两边现在走同一套单元遍历。
fn to_unicode_escapes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for unit in input.encode_utf16() {
        if !(0x20..=0x7e).contains(&unit) {
            out.push_str(&format!("\\u{unit:04x}"));
        } else {
            // 这个区间一定是 ASCII，转不成 char 是不可能的。
            out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}'));
        }
    }
    out
}

/// [`to_unicode_escapes`] 的逆运算。
///
/// 先把整串收集成 **UTF-16 单元序列**再一次性解码 —— 相邻的两个 `\uXXXX` 如果正好是一个
/// 代理对，这样才拼得回原来的字符（逐个解码会把它们各当成一个坏字符）。
fn from_unicode_escapes(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut units: Vec<u16> = Vec::with_capacity(chars.len());
    let mut pending = String::new();
    let flush = |pending: &mut String, units: &mut Vec<u16>| {
        units.extend(pending.encode_utf16());
        pending.clear();
    };

    let mut i = 0;
    while i < chars.len() {
        // `\uXXXX`：反斜杠 + u + 恰好 4 个十六进制位。
        let is_escape = chars[i] == '\\'
            && chars.get(i + 1) == Some(&'u')
            && (i + 5) < chars.len()
            && chars[i + 2..i + 6].iter().all(char::is_ascii_hexdigit);
        if is_escape {
            flush(&mut pending, &mut units);
            let text: String = chars[i + 2..i + 6].iter().collect();
            if let Ok(value) = u16::from_str_radix(&text, 16) {
                units.push(value);
                i += 6;
                continue;
            }
        }
        pending.push(chars[i]);
        i += 1;
    }
    flush(&mut pending, &mut units);
    String::from_utf16_lossy(&units)
}
