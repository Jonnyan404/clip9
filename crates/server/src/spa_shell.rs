//! SPA 外壳的读取与注入。
//!
//! 对应 Go `spa_shell.go`。
//!
//! 为什么由服务端做这件事：
//!
//! 1. **OG 卡片**：分享链接要能被微信 / Telegram / Slack 展开，而抓取程序**不执行 JS**、
//!    浏览器也不会把 `#` 之后的部分发给服务器 —— 于是 token 必须在**路径**里，
//!    标签必须在服务端就写进 HTML（见 [`crate::share_card`]）。
//! 2. **`<base>`**：外壳会在 `/s/<token>` 这种**深路径**上被打开，而构建产物里的资源地址是
//!    **相对**的（`./assets/…`，vite 的 `base: ''`）。不注入 `<base>` 的话它们会按当前目录
//!    解析成 `/s/assets/…`，全部 404。
//!
//! 注入用字符串定位而不是 HTML 解析：外壳是我们自己构建出来的，形状固定
//! （`<head>` / `</head>` / 一处 `<title>`）。**外壳形状出乎意料时不注入**，
//! 由调用方回落到通用卡片 —— 宁可少一张预览卡，也不要吐出一份半截 HTML。

use std::path::Path;

const SHELL_HEAD_OPEN: &str = "<head>";
const SHELL_HEAD_END: &str = "</head>";

/// 读前端外壳（`<static_dir>/index.html`）。没有前端（只跑 API）时返回 `None`。
#[must_use]
pub fn read_shell(static_dir: Option<&Path>) -> Option<String> {
    let dir = static_dir?;
    let html = std::fs::read_to_string(dir.join("index.html")).ok()?;
    (!html.is_empty()).then_some(html)
}

/// 外壳的基准目录：`<prefix>/`（没有 prefix 就是 `/`）。
///
/// ⚠️ 前端也依赖这个值：它把 `document.baseURI` 同时当作 axios 的 baseURL 和路由 base
/// （见 `web-vue3/src/main.js`、`src/router/index.js`）。改这里的形状要一并改那边。
#[must_use]
pub fn base_href(prefix: &str) -> String {
    format!("{}/", prefix.trim_end_matches('/'))
}

/// 往外壳里写 `<base>`、标题和额外的 head 标签。
///
/// `base_href` / `title` 为空表示不动对应那一项；`head_extra` 为空表示不追加标签。
/// 外壳缺少 `<head>` / `</head>`（或顺序不对）时返回 `None` —— 调用方回落到通用卡片。
#[must_use]
pub fn inject_tags(shell: &str, base_href: &str, title: &str, head_extra: &str) -> Option<String> {
    let head_open = shell.find(SHELL_HEAD_OPEN)?;
    let head_end = shell.find(SHELL_HEAD_END)?;
    if head_end < head_open {
        return None;
    }
    let mut out = shell.to_owned();

    // ⚠️ `<base>` 必须排在任何相对地址之前，所以**紧跟 `<head>`**。
    if !base_href.is_empty() {
        let at = head_open + SHELL_HEAD_OPEN.len();
        out.insert_str(at, &format!("\n<base href=\"{}\">", escape(base_href)));
    }

    // 浏览器标签页的标题也换成分享标题（SPA 自己不设 document.title）。
    // 只认 `<head>` 里的那一处，避免动到别处的同名文本。
    if !title.is_empty() {
        let head_end_now = out.find(SHELL_HEAD_END)?;
        if let Some(start) = out[head_open..head_end_now].find("<title>") {
            let start = head_open + start;
            if let Some(rel) = out[start..].find("</title>") {
                let content_start = start + "<title>".len();
                let content_end = start + rel;
                out.replace_range(content_start..content_end, &escape(title));
            }
        }
    }

    if !head_extra.is_empty() {
        let at = out.find(SHELL_HEAD_END)?;
        out.insert_str(at, &format!("{head_extra}\n"));
    }

    Some(out)
}

/// HTML 属性值转义。
///
/// ⚠️ 标题来自**内容首行**、文件名，description 里也可能带用户内容 —— 直接拼进属性
/// 就是一处 XSS（`<` 能直接开新标签，闭合标签能把整张卡片改掉）。
/// 转义 `'` 是为了同样堵住单引号属性的那条路（`twitter:title='…'` 在别处会出现）。
#[must_use]
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str =
        "<!DOCTYPE html><html><head><title>原标题</title></head><body>app</body></html>";

    #[test]
    fn base_is_injected_right_after_head() {
        let out = inject_tags(SHELL, "/clip/", "", "").unwrap();
        // ⚠️ 位置就是语义：晚了，`.` 开头的资源地址会解析成 /s/assets/…。
        assert_eq!(
            out,
            "<!DOCTYPE html><html><head>\n<base href=\"/clip/\"><title>原标题</title></head><body>app</body></html>"
        );
    }

    #[test]
    fn base_href_follows_the_prefix() {
        assert_eq!(base_href(""), "/");
        assert_eq!(base_href("/clip"), "/clip/");
        assert_eq!(base_href("/clip/"), "/clip/");
    }

    #[test]
    fn title_is_replaced_but_other_tags_are_not() {
        let out = inject_tags(SHELL, "", "分享的内容", "").unwrap();
        assert!(out.contains("<title>分享的内容</title>"), "{out}");
        assert!(!out.contains("原标题"));
        // 第二个 `<title>`（body 里的）不能被动到。
        let twice = "<html><head><title>a</title></head><body><title>b</title></body></html>";
        let out = inject_tags(twice, "", "c", "").unwrap();
        assert!(out.contains("<title>c</title>"));
        assert!(out.contains("<title>b</title>"));
    }

    #[test]
    fn head_extra_lands_before_closing_head() {
        let out = inject_tags(SHELL, "", "", "<meta name=\"x\" content=\"y\">").unwrap();
        assert!(
            out.contains("<meta name=\"x\" content=\"y\">\n</head>"),
            "{out}"
        );
    }

    /// ⚠️ 宁可**不注入**也不要吐半截 HTML —— 外壳形状变了是前端构建的问题，
    /// 而「返回一份坏页面」只会表现成「分享页打不开，没有任何报错」。
    #[test]
    fn a_broken_shell_yields_nothing() {
        assert!(inject_tags("<html><body>没有 head</body></html>", "/", "t", "").is_none());
        assert!(inject_tags("</head><head>", "/", "t", "").is_none());
        assert!(inject_tags("", "/", "t", "").is_none());
    }

    #[test]
    fn values_are_escaped() {
        assert_eq!(escape(r#"a<b>"c'&d"#), "a&lt;b&gt;&#34;c&#39;&amp;d");
        // 标题里带 `</title>` 必须被转义掉，否则能整张卡片都改掉。
        let out = inject_tags(SHELL, "", "</title><script>x</script>", "").unwrap();
        assert!(!out.contains("<script>"), "{out}");
    }
}
