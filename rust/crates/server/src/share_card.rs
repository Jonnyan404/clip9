//! 分享落地页（`/s/<token>`）的**卡片内容**与其中的纯文本辅助函数。
//!
//! 对应 Go `share_landing.go`。这里只算「卡片上写什么」和「怎么排版」，
//! HTTP 那一层在 [`crate::share`]，外壳注入在 [`crate::spa_shell`]。
//!
//! # ⚠️ 这条路径上的摘要**公开可抓、且会被第三方缓存**
//!
//! 贴进微信 / Telegram / Slack，摘要会出现在预览里（群里所有人都看得到），
//! 而且平台侧的缓存**删不掉** —— 之后过期、删内容、加密码都不影响对方已经抓到的副本。所以：
//!
//! 1. 带密码的分享**绝不输出内容摘要**（只说「需要密码」）；
//! 2. 失效 / 已删除的分享只输出通用卡片；
//! 3. 页面带 noindex，别让搜索引擎把分享页当正文收录；
//! 4. 这里**不计数**（抓取程序会反复访问，统计只认分享页的上报，见 `POST /share/visit`）。

/// 卡片上的站点名。
pub const SITE_NAME: &str = "Cloud Clipboard";
/// 标题最多几个字符（超了截断 + 省略号）。
const TITLE_LIMIT: usize = 80;
/// 描述最多几个字符。
const DESC_LIMIT: usize = 160;
/// ⚠️ `og:image` 的体积上限：超过就不给图，避免把大文件塞进对方的预览。
const IMAGE_MAX_BYTES: i64 = 5 * 1024 * 1024;

/// 一张卡片，字段一一对应 `og:*` / `twitter:*` 标签。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareCard {
    pub site_name: String,
    pub title: String,
    pub description: String,
    /// 留空则平台用站点图标 / 占位图。
    pub image: Option<String>,
    /// `og:url`：分享地址本身（就是当前这个地址）。
    pub canonical: String,
}

impl ShareCard {
    /// 「链接无效了」那张通用卡片。
    ///
    /// ⚠️ 失效的链接**不告诉访客更多**（不说是过期还是次数用尽）—— 它是公开地址，
    /// 差别对待等于给「哪些链接还活着」提供一个免费的探测接口。
    #[must_use]
    pub fn invalid(canonical: String) -> Self {
        Self {
            site_name: SITE_NAME.to_owned(),
            title: "分享链接无效或已过期".to_owned(),
            description: "这条分享可能已过期、次数用尽，或者链接不完整。".to_owned(),
            image: None,
            canonical,
        }
    }
}

/// 文本的第一行有内容的行：压平空白、去掉行首的引用/项目符号，再截断。
#[must_use]
pub fn first_summary_line(text: &str, limit: usize) -> String {
    for line in text.split('\n') {
        let clean = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let clean = clean.trim_start_matches(['#', '>', '*', '-', '·', '|']);
        let clean = clean.trim();
        if !clean.is_empty() {
            return truncate_runes(clean, limit);
        }
    }
    String::new()
}

/// 按**字符**截断（不是字节）。中文一条就是三个字节，按字节切会切出半个字。
#[must_use]
pub fn truncate_runes(value: &str, limit: usize) -> String {
    let value = value.trim();
    if limit == 0 {
        return value.to_owned();
    }
    let mut out = String::new();
    for (count, ch) in value.chars().enumerate() {
        if count == limit {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out.trim().to_owned()
}

/// 文件大小的人类可读形式（`1.2 MB`）。`0` 之类的大小回空串。
#[must_use]
pub fn format_size(bytes: i64) -> String {
    if bytes <= 0 {
        return String::new();
    }
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes}{}", UNITS[unit])
    } else {
        format!("{:.1}{}", value, UNITS[unit])
    }
}

/// 卡片上那句「剩余多久」。
///
/// ⚠️ 过期时间缺失（`exp <= 0`）就**闭嘴** —— 写「永不过期」是替部署者许一个它没许的愿。
#[must_use]
pub fn expiry_note(exp: i64, now: i64) -> String {
    if exp <= 0 {
        return String::new();
    }
    let remaining = exp - now;
    if remaining <= 0 {
        return "已过期".to_owned();
    }
    if remaining < 3600 {
        return format!("{} 分钟内有效", (remaining + 59) / 60);
    }
    format!("{} 小时内有效", (remaining + 3599) / 3600)
}

/// 把几段元信息用 ` · ` 拼起来，空的丢掉。一段都不剩时给一句兜底。
#[must_use]
pub fn join_meta(parts: &[&str]) -> String {
    let kept: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|p| !p.trim().is_empty())
        .collect();
    if kept.is_empty() {
        return format!("通过 {SITE_NAME} 分享，打开即可查看。");
    }
    kept.join(" · ")
}

/// 是不是能直接当预览图的图片类型。
#[must_use]
pub fn is_previewable_image_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    let Some(dot) = lower.rfind('.') else {
        return false;
    };
    matches!(
        &lower[dot + 1..],
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp"
    )
}

/// 标题 / 描述 / 图片体积的截断上限。
///
/// 做成函数而不是直接 `pub const` 是为了**只有这一处**能改：这几个数字决定了
/// 「一张预览卡最多泄露多少内容」，分散成魔数就会出现「改了 OG 忘了改 twitter」。
#[must_use]
pub const fn title_limit() -> usize {
    TITLE_LIMIT
}

#[must_use]
pub const fn desc_limit() -> usize {
    DESC_LIMIT
}

#[must_use]
pub const fn image_max_bytes() -> i64 {
    IMAGE_MAX_BYTES
}

/// 拼要写进外壳 `<head>` 的那几行：noindex + description + `og:*` + `twitter:*`。
///
/// 值一律转义（标题来自内容首行、文件名），`og:image` 只在有图时出现，
/// `twitter:card` 跟着它选 `summary_large_image`。
#[must_use]
pub fn head_tags(card: &ShareCard) -> String {
    use crate::spa_shell::escape;

    let title = escape(&card.title);
    let description = escape(&card.description);
    let mut out = String::new();
    out.push_str("<meta name=\"robots\" content=\"noindex, nofollow\">\n");
    out.push_str(&format!(
        "<meta name=\"description\" content=\"{description}\">\n"
    ));
    out.push_str("<meta property=\"og:type\" content=\"website\">\n");
    out.push_str(&format!(
        "<meta property=\"og:site_name\" content=\"{}\">\n",
        escape(&card.site_name)
    ));
    out.push_str(&format!(
        "<meta property=\"og:title\" content=\"{title}\">\n"
    ));
    out.push_str(&format!(
        "<meta property=\"og:description\" content=\"{description}\">\n"
    ));
    out.push_str(&format!(
        "<meta property=\"og:url\" content=\"{}\">\n",
        escape(&card.canonical)
    ));
    if let Some(image) = &card.image {
        let image = escape(image);
        out.push_str(&format!(
            "<meta property=\"og:image\" content=\"{image}\">\n"
        ));
        out.push_str(&format!(
            "<meta name=\"twitter:image\" content=\"{image}\">\n"
        ));
    }
    let twitter_card = if card.image.is_some() {
        "summary_large_image"
    } else {
        "summary"
    };
    out.push_str(&format!(
        "<meta name=\"twitter:card\" content=\"{twitter_card}\">\n"
    ));
    out.push_str(&format!(
        "<meta name=\"twitter:title\" content=\"{title}\">\n"
    ));
    out.push_str(&format!(
        "<meta name=\"twitter:description\" content=\"{description}\">"
    ));
    out
}

/// 「没有前端外壳」时的兜底页：只有一张卡。
///
/// 正常路径**不用它** —— 那一条是把 [`head_tags`] 注入进 SPA 外壳。
/// 但 API-only 的部署（Android 连别人的服务端那种）没有外壳可注入，
/// 而抓取程序要的本来就是这些标签。
#[must_use]
pub fn fallback_page(card: &ShareCard) -> String {
    use crate::spa_shell::escape;

    let title = escape(&card.title);
    let description = escape(&card.description);
    let site = escape(&card.site_name);
    let canonical = escape(&card.canonical);

    let mut lines = String::new();
    let mut twitter_card = "summary";
    if let Some(image) = &card.image {
        let image = escape(image);
        lines.push_str(&format!(
            "<meta property=\"og:image\" content=\"{image}\">\n<meta name=\"twitter:image\" content=\"{image}\">\n"
        ));
        twitter_card = "summary_large_image";
    }

    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="{description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{site}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{canonical}">
{lines}<meta name="twitter:card" content="{twitter_card}">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<style>
:root {{ color-scheme: light dark; }}
body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  background: #f6f7f9; color: #1f2430; }}
@media (prefers-color-scheme: dark) {{ body {{ background: #16181d; color: #e9ecf2; }} }}
main {{ max-width: 30rem; padding: 2rem 1.5rem; text-align: center; }}
h1 {{ font-size: 1.1rem; margin: 0 0 .5rem; }}
p {{ margin: 0; opacity: .75; word-break: break-word; }}
</style>
</head>
<body>
<main>
<h1>{title}</h1>
<p>{description}</p>
</main>
</body>
</html>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_line_skips_blanks_and_markup() {
        assert_eq!(first_summary_line("\n\n  \n## 标题\n正文", 80), "标题");
        assert_eq!(first_summary_line("-   一 二\t三\n四", 80), "一 二 三");
        assert_eq!(first_summary_line("   \n\n", 80), "");
        // 压平之后再截断，且要按**字符**切（中文不能切出半个字）。
        assert_eq!(first_summary_line("一二三四五六", 3), "一二三…");
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        assert_eq!(truncate_runes("一二三", 2), "一二…");
        assert_eq!(truncate_runes("abc", 10), "abc");
        assert_eq!(truncate_runes("  abc  ", 0), "abc");
    }

    #[test]
    fn size_is_human_readable() {
        assert_eq!(format_size(0), "");
        assert_eq!(format_size(512), "512B");
        assert_eq!(format_size(2048), "2.0KB");
        assert_eq!(format_size(5 * 1024 * 1024), "5.0MB");
    }

    #[test]
    fn expiry_note_rounds_up_and_shuts_up_without_exp() {
        assert_eq!(expiry_note(0, 0), "", "没有过期时间就别许愿");
        assert_eq!(expiry_note(100, 100), "已过期");
        assert_eq!(
            expiry_note(100 + 90, 100),
            "2 分钟内有效",
            "59 秒也要说 1 分钟"
        );
        assert_eq!(expiry_note(100 + 3600, 100), "1 小时内有效");
        assert_eq!(expiry_note(100 + 3601, 100), "2 小时内有效");
    }

    #[test]
    fn meta_drops_empty_parts() {
        assert_eq!(join_meta(&["文件", "", "  ", "1.0MB"]), "文件 · 1.0MB");
        assert_eq!(
            join_meta(&["", "  "]),
            "通过 Cloud Clipboard 分享，打开即可查看。"
        );
    }

    #[test]
    fn only_image_extensions_can_be_previewed() {
        assert!(is_previewable_image_name("a.PNG"));
        assert!(is_previewable_image_name("x.jpeg"));
        assert!(!is_previewable_image_name("x.pdf"));
        assert!(!is_previewable_image_name("png"));
    }

    /// ⚠️ `og:image` 只在**不限次**的分享上给 —— 抓取程序抓图要走 `/file` 的令牌校验，
    /// 而那里会**消耗一次额度**；额满之后真人点开就是「已被使用完」。
    /// 「预览把链接用掉」是绝对不能接受的，所以这条判据属于卡片这一层。
    #[test]
    fn card_tags_track_the_image() {
        let base = ShareCard {
            site_name: SITE_NAME.to_owned(),
            title: "t".to_owned(),
            description: "d".to_owned(),
            image: None,
            canonical: "http://x/s/t".to_owned(),
        };
        assert!(head_tags(&base).contains(r#"twitter:card" content="summary""#));
        assert!(!head_tags(&base).contains("og:image"));

        let with_image = ShareCard {
            image: Some("http://x/f/u/a.png".to_owned()),
            ..base
        };
        assert!(head_tags(&with_image).contains("og:image"));
        assert!(head_tags(&with_image).contains("summary_large_image"));
    }

    #[test]
    fn fallback_page_escapes_untrusted_text() {
        let card = ShareCard {
            site_name: SITE_NAME.to_owned(),
            title: "<script>alert(1)</script>".to_owned(),
            description: "\"><b>粗</b>".to_owned(),
            image: None,
            canonical: "http://x/s/t".to_owned(),
        };
        let page = fallback_page(&card);
        assert!(!page.contains("<script>"), "{page}");
        assert!(!page.contains("<b>"), "{page}");
        assert!(page.contains("&lt;script&gt;"));
    }

    #[test]
    fn head_tags_escape_the_description() {
        let card = ShareCard {
            site_name: SITE_NAME.to_owned(),
            title: "标题".to_owned(),
            description: "</head><script>".to_owned(),
            image: None,
            canonical: "http://x/s/t".to_owned(),
        };
        let tags = head_tags(&card);
        assert!(!tags.contains("<script>"), "{tags}");
    }
}
