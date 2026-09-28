//! 文本子类型识别 —— 纯函数，一眼可测。

use std::sync::LazyLock;

use regex::Regex;

use crate::event::TextSubtype;

// ⚠️★ 三个模式**逐字照抄 `clip-sync`**（`src-tauri/src/clipboard.rs` 的
// `get_text_subtype`）。它是 `rust/crates/client` 的行为基准 —— 改了正则就是换了行为，
// 而这条行为是**用户可以看见的**（气泡上那个 URL / 邮箱 / 颜色的标签）。
//
// ⚠️ 与 `clip-sync` 的唯一差别是**这里缓存了编译好的正则**：那边每次调用都
// `Regex::new`（每次都重新编译一遍模式）。这是个纯性能改进，**行为一个字没变**。
static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"https?://[^\s/$.?#].[^\s]*").expect("URL 正则是字面量"));

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").expect("邮箱正则是字面量")
});

static COLOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$").expect("颜色正则是字面量"));

/// 认出「这看起来是个 URL / 邮箱 / 颜色」；认不出就 `None`。
///
/// ⚠️ 优先级是 URL → 邮箱 → 颜色，而且**前两个是「串里包含」、颜色是「整串相等」**
/// （模式上有 `^…$`）—— 这是 `clip-sync` 的行为，别顺手统一成同一种语义：
/// 一个网址里可能带 `@`，而 `#fff` 只有在**整串**就是颜色时才该被认成颜色。
#[must_use]
pub fn classify_text(value: &str) -> Option<TextSubtype> {
    if URL_RE.is_match(value) {
        return Some(TextSubtype::Url);
    }
    if EMAIL_RE.is_match(value) {
        return Some(TextSubtype::Email);
    }
    if COLOR_RE.is_match(value) {
        return Some(TextSubtype::Color);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_three_subtypes() {
        assert_eq!(
            classify_text("https://example.com/a?b=1"),
            Some(TextSubtype::Url)
        );
        assert_eq!(
            classify_text("http://127.0.0.1:9501"),
            Some(TextSubtype::Url)
        );
        assert_eq!(
            classify_text("someone@example.com"),
            Some(TextSubtype::Email)
        );
        assert_eq!(classify_text("#4f8cff"), Some(TextSubtype::Color));
        assert_eq!(classify_text("#fff"), Some(TextSubtype::Color));
    }

    /// ⚠️ 前两个是「串里包含」，颜色是「整串相等」—— 这条**故意**把三种语义的差别钉住。
    #[test]
    fn url_and_email_are_containment_color_is_whole_string() {
        // 句子里的网址照样认得出（`clip-sync` 的 `is_match` 语义）
        assert_eq!(
            classify_text("看这个 https://example.com/x 挺好"),
            Some(TextSubtype::Url)
        );
        // 但颜色必须**整串**就是它 —— `#fff` 夹在句子里不算
        assert_eq!(classify_text("颜色是 #fff 那个"), None);
    }

    /// 网址里带 `@` 时**先命中 URL** —— 这正是优先级存在的理由。
    #[test]
    fn url_wins_over_email() {
        assert_eq!(
            classify_text("https://user@example.com/path"),
            Some(TextSubtype::Url)
        );
    }

    #[test]
    fn plain_text_has_no_subtype() {
        assert_eq!(classify_text("部署脚本我放在 /opt/deploy 了"), None);
        assert_eq!(classify_text(""), None);
        // `#` 后面不是合法色值时不算颜色
        assert_eq!(classify_text("#zzz"), None);
    }
}
