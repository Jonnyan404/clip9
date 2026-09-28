//! User-Agent → 设备信息。
//!
//! 对应 Go `utils.go:376` 的 `detectDeviceType` 与 `utils.go:436` 的 `parse_user_agent`。
//!
//! # ⚠️ 这是一个**近似**实现，不是逐字移植
//!
//! Go 侧用 `uap-go`（uap-core 的正则库）取 OS / 浏览器的 family + major，再叠加一个
//! 手写的 `detectDeviceType`。Rust 这边**没有引 uap-core 的正则库**，理由是体积：
//! 那套正则集是 MB 级的数据，而这个项目的目标设备里有 16MB flash 的路由器
//! （见 `docs/ARCHITECTURE.md` 的约束 2）。这里用关键词匹配代替。
//!
//! **受影响的只有「气泡上显示什么设备名」这一件事**，不影响鉴权、存储或任何接口形状。
//! `type`（desktop / smartphone / tablet）是**逐字移植**的 —— 前端的图标按它选，
//! 那条逻辑一个字符都不能差。
//!
//! ⚠️ 要换成 uap-core 的等价物，见 `docs/HANDOVER.md` §6 的未决问题。

use std::collections::HashMap;

use clip9_protocol::DeviceMeta;

/// 把 UA 归类成 `desktop` / `smartphone` / `tablet`。
///
/// ⚠️ `os_family` 只在关键词全部落空时兜底，别把它提到前面去 ——
/// **快捷指令的 UA 是 `BackgroundShortcutRunner`**，不含 mobile / iphone / android
/// 等任何移动端关键词。只看关键词会把 iOS 设备判成 `desktop`，前端于是显示成
/// 「笔记本图标 + 桌面设备」，副标题却写着 "iOS 17" —— 自相矛盾，看着像 bug。
#[must_use]
pub fn detect_device_type(ua: &str, os_family: &str) -> &'static str {
    let ua = ua.to_ascii_lowercase();

    let is_tablet = ua.contains("ipad")
        || ua.contains("tablet")
        || ua.contains("playbook")
        || ua.contains("silk")
        || ua.contains("kindle");
    let is_mobile =
        !is_tablet && (ua.contains("mobile") || ua.contains("iphone") || ua.contains("android"));

    if is_tablet {
        return "tablet";
    }
    if is_mobile {
        return "smartphone";
    }

    // 关键词全落空 → 看 OS 家族兜底（快捷指令走的就是这条）。
    match os_family {
        "iOS" => "smartphone",
        "Android" => "smartphone",
        _ => "desktop",
    }
}

/// 解析 UA，产出 `{type, os, browser}`；`device_name` 非空时补一个 `name`。
///
/// ⚠️ `os` / `browser` 是 `"<家族> <主版本>"` 的形式。
///
/// ⚠️ **末尾要 trim** —— 认不出家族时是 `"Other"` + 空版本，不 trim 就得到 `"Other "`。
/// 前端是**直接把这个串显示出来**的（副标题），尾随空格会让它看起来莫名多一格。
/// Go 那边就是带空格的（`fmt.Sprintf("%s %s", ...)` 不做 trim）—— 这里是**故意不同**，
/// 见 `docs/CONTRIBUTING.md` §0。
#[must_use]
pub fn parse_user_agent(ua: &str, device_name: &str) -> HashMap<String, String> {
    let (os_family, os_major) = parse_os(ua);
    let (browser_family, browser_major) = parse_browser(ua);

    let mut info = HashMap::new();
    info.insert(
        "type".to_owned(),
        detect_device_type(ua, os_family).to_owned(),
    );
    info.insert("os".to_owned(), family_and_major(os_family, &os_major));
    info.insert(
        "browser".to_owned(),
        family_and_major(browser_family, &browser_major),
    );
    if !device_name.is_empty() {
        info.insert("name".to_owned(), device_name.to_owned());
    }
    info
}

/// `"<家族> <主版本>"`，去首尾空白。
fn family_and_major(family: &str, major: &str) -> String {
    format!("{family} {major}").trim().to_owned()
}

/// 构造 WS 用的 `DeviceMeta`。
///
/// `device` 字段在 Go 那边是 `"<品牌> <型号> <OS 家族>"` 去空白（uap-go 给品牌和型号）。
/// ⚠️ 这边是**近似**：没有 uap 的型号库，只能靠关键词认出最常见的几类。
/// 认不出来的就只给 OS 家族 —— 前端那个副标题会显得单薄，但不会出错。
#[must_use]
pub fn parse_device_meta(ua: &str, device_name: &str, device_id: &str) -> DeviceMeta {
    let (os_family, os_major) = parse_os(ua);
    let (browser_family, browser_major) = parse_browser(ua);

    DeviceMeta {
        id: device_id.to_owned(),
        kind: detect_device_type(ua, os_family).to_owned(),
        name: device_name.to_owned(),
        device: device_family(ua, os_family),
        os: family_and_major(os_family, &os_major),
        browser: family_and_major(browser_family, &browser_major),
    }
}

/// 「品牌 + 型号」，认不出来时退化成 OS 家族。
fn device_family(ua: &str, os_family: &str) -> String {
    let lower = ua.to_ascii_lowercase();
    if lower.contains("iphone") {
        return "Apple iPhone".to_owned();
    }
    if lower.contains("ipad") {
        return "Apple iPad".to_owned();
    }
    if lower.contains("macintosh") || lower.contains("mac os x") {
        return "Apple Mac".to_owned();
    }
    if let Some(model) = android_model(ua) {
        return model;
    }
    os_family.to_owned()
}

/// 从 `(Linux; Android 13; Pixel 7)` 里抠出型号。
fn android_model(ua: &str) -> Option<String> {
    let start = ua.find("Android ")?;
    let rest = &ua[start..];
    // 形如 `Android 13; Pixel 7)` 或 `Android 13; zh-cn; SM-G991B Build/...`
    let mut parts = rest.split(';');
    parts.next()?; // 丢掉 "Android 13"
    for part in parts {
        let candidate = part.trim().trim_end_matches(')').trim();
        // `Build/...` 之前那段才是型号；`wv` / `zh-cn` 这类语言标记要跳过。
        let candidate = candidate
            .split(" Build/")
            .next()
            .unwrap_or(candidate)
            .trim();
        if !candidate.is_empty()
            && !candidate.eq_ignore_ascii_case("wv")
            && candidate.len() > 1
            && !candidate.contains('-')
        // `zh-cn` 这类语言标记
        {
            return Some(format!("Android {candidate}"));
        }
    }
    None
}

fn parse_os(ua: &str) -> (&'static str, String) {
    if ua.contains("iPhone OS") || ua.contains("CPU OS") {
        return ("iOS", version_after(ua, "OS "));
    }
    if ua.contains("iPad") {
        return ("iOS", version_after(ua, "OS "));
    }
    if let Some(v) = version_after_opt(ua, "Android ") {
        return ("Android", v);
    }
    if ua.contains("Mac OS X") {
        // uap-core 对 macOS 给的主版本是 "10"（`Mac OS X 10_15_7` → family "Mac OS X", major "10"）。
        return ("Mac OS X", "10".to_owned());
    }
    if ua.contains("Windows NT 10.0") {
        return ("Windows", "10".to_owned());
    }
    if let Some(v) = version_after_opt(ua, "Windows NT ") {
        return ("Windows", v);
    }
    if ua.contains("CrOS") {
        return ("Chrome OS", String::new());
    }
    if ua.contains("Linux") {
        return ("Linux", String::new());
    }
    ("Other", String::new())
}

fn parse_browser(ua: &str) -> (&'static str, String) {
    // ⚠️ 顺序有讲究：Edge 的 UA 里**同时**有 "Edg/" 和 "Chrome/"，Chrome 的 UA 里有 "Safari/"。
    // 按「越具体的越先判」排，否则 Edge 会被认成 Chrome、Chrome 会被认成 Safari。
    if let Some(v) = version_after_opt(ua, "Edg/") {
        return ("Edge", v);
    }
    if let Some(v) = version_after_opt(ua, "OPR/") {
        return ("Opera", v);
    }
    if let Some(v) = version_after_opt(ua, "Chrome/") {
        return ("Chrome", v);
    }
    if let Some(v) = version_after_opt(ua, "Firefox/") {
        return ("Firefox", v);
    }
    if ua.contains("Safari/") {
        if let Some(v) = version_after_opt(ua, "Version/") {
            return ("Safari", v);
        }
        return ("Safari", String::new());
    }
    if let Some(v) = version_after_opt(ua, "curl/") {
        return ("curl", v);
    }
    ("Other", String::new())
}

/// 取 `marker` 之后的**主版本号**（连续数字，遇到第一个非数字就停）。找不到返回空串。
///
/// ⚠️ **只要主版本，不是完整版本** —— Go 那边是 `fmt.Sprintf("%s %s", Family, Major)`，
/// 所以 `Chrome/120.0.0.0` 得到的是 `"Chrome 120"`。这是**形状**上的差异
/// （前端直接把这个串显示出来），不是「顺手美化一下」。
fn version_after(ua: &str, marker: &str) -> String {
    version_after_opt(ua, marker).unwrap_or_default()
}

fn version_after_opt(ua: &str, marker: &str) -> Option<String> {
    let start = ua.find(marker)? + marker.len();
    Some(
        ua[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_chrome_on_mac() {
        let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        let info = parse_user_agent(ua, "");
        assert_eq!(info["type"], "desktop");
        assert_eq!(info["os"], "Mac OS X 10");
        assert_eq!(info["browser"], "Chrome 120");
        assert!(!info.contains_key("name"), "没声明设备名就不该有 name");
    }

    #[test]
    fn iphone_safari_is_a_smartphone() {
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 \
                  (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        let info = parse_user_agent(ua, "我的 iPhone");
        assert_eq!(info["type"], "smartphone");
        // ⚠️ 只要主版本：`OS 17_0` → `iOS 17`，`Version/17.0` → `Safari 17`。
        assert_eq!(info["os"], "iOS 17");
        assert_eq!(info["browser"], "Safari 17");
        assert_eq!(info["name"], "我的 iPhone");
    }

    #[test]
    fn ipad_is_a_tablet() {
        let ua = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
        assert_eq!(parse_user_agent(ua, "")["type"], "tablet");
    }

    #[test]
    fn android_chrome() {
        let ua = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
        let info = parse_user_agent(ua, "");
        assert_eq!(info["type"], "smartphone");
        assert_eq!(info["os"], "Android 13");
        assert_eq!(info["browser"], "Chrome 120");
    }

    /// ⚠️★ 这条防的是「只看关键词」那个错：快捷指令的 UA 里一个移动端关键词都没有，
    /// 必须靠 `os_family` 兜底成 smartphone，否则前端会画出「笔记本图标 + iOS 17」。
    #[test]
    fn shortcut_runner_falls_back_to_the_os_family() {
        let ua = "BackgroundShortcutRunner/1234";
        assert_eq!(detect_device_type(ua, "iOS"), "smartphone");
        assert_eq!(detect_device_type(ua, "Other"), "desktop");
    }

    /// ⚠️ Edge 的 UA 里同时有 Edg/ 和 Chrome/ —— 判定顺序错了就会认成 Chrome。
    #[test]
    fn edge_is_not_mistaken_for_chrome() {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
        assert_eq!(parse_user_agent(ua, "")["browser"], "Edge 120");
    }

    #[test]
    fn curl_has_no_os_but_still_gets_a_type() {
        let info = parse_user_agent("curl/8.4.0", "");
        assert_eq!(info["browser"], "curl 8", "主版本，不是 8.4");
        assert_eq!(info["type"], "desktop");
    }

    /// 认不出来时家族是 `Other`、版本是空串 → `"Other"`（**没有**尾随空格）。
    ///
    /// ⚠️ 这里**故意和 Go 不同**：Go 是 `Sprintf("%s %s", ...)` 不 trim，给出 `"Other "`，
    /// 而前端是**直接把这个串显示出来**的。见 `docs/CONTRIBUTING.md` §0。
    #[test]
    fn unknown_ua_is_trimmed() {
        let info = parse_user_agent("完全认不出来的东西", "");
        assert_eq!(info["os"], "Other");
        assert_eq!(info["browser"], "Other");
        assert_eq!(info["type"], "desktop");
    }
}
