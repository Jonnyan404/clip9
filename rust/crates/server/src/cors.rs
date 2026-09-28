//! CORS：**允许哪些来源跨源读这个服务端**。
//!
//! # 为什么要收窄（别再改回 `*`）
//!
//! 2026-09-26 之前这里（以及 Go 的 `corsMiddleware`）发的是 `Access-Control-Allow-Origin: *`。
//! 那不是「宽松」，是**一个真的洞**：
//!
//! 这个服务端跑在**用户自己的机器上**（默认 `127.0.0.1:9501`），而房间默认**不需要密码**。
//! `*` 意味着**用户访问的任意网站**都能这么干：
//!
//! ```js
//! fetch('http://127.0.0.1:9501/content?room=default&format=json')  // ← 读得到
//! ```
//!
//! 于是「用户随手点开的一个网页」就能把本机剪贴板历史整段读走 —— 而用户什么都不会察觉。
//! （`*` 只在「带凭据模式」下才被浏览器拒绝，而那个模式管的是 cookie / TLS 客户端证书；
//! 一个开放的房间**压根不需要凭据**，所以 `*` 拦不住它。）
//!
//! ⚠️ 这条同时也是 `docs/specs/desktop-client.md` §8 审计清单里那条
//! 「**只放该 origin**，别开 `*`」的落地。
//!
//! # 放行谁（就这三类）
//!
//! | 来源 | 为什么 |
//! |---|---|
//! | `tauri://localhost` | **桌面客户端**（`docs/specs/desktop-client.md` §3 的 B 方案）。 ⚠️ 实测确认过：webview 发的就是**这一个**字符串（§0.1.3 那套记录型代理抓到的） |
//! | `http(s)://localhost[:port]` | 本机开发（`vite dev` 是 `http://localhost:5173` → `http://localhost:9501`） |
//! | `http(s)://127.0.0.1[:port]` | 同上，只是写法不同 |
//!
//! ⚠️★ **SPA 不需要 CORS** —— 它由这个服务端**自己**渲染（同源）。所以这张表里
//! 没有「用户的域名」这一类：真要支持「把前端放别处、只调这个 API」，那得加一个
//! **配置项**，而不是把 `*` 放回来。
//!
//! ⚠️ `file://` 页面（用户拿个本地 HTML 当临时客户端）发的是 `Origin: null` ——
//! **不放行**。`null` 也是沙箱化 iframe / `data:` URL 的来源，放行它等于把上面那个洞换了个写法。
//!
//! ⚠️ `[::1]`（IPv6 回环）**没放行**：浏览器只在页面本身就跑在 `[::1]` 上时才会发这个来源，
//! 而那种用法（`http://[::1]:5173`）极少。真要支持得单独加一条 —— 别顺手写个「包含 `127` 就算过」的模糊判断。

use axum::http::{HeaderName, HeaderValue, Method, header};
use tower_http::cors::{AllowOrigin, CorsLayer};

/// 桌面客户端的来源。⚠️ **实测值**，不是猜的（见模块文档那张表）。
pub const TAURI_ORIGIN: &str = "tauri://localhost";

/// 这个 `Origin` 头允许跨源读吗？
///
/// ⚠️ 只接受 `scheme://host[:port]` 三段的**严格**形状：带路径 / 查询 / userinfo 的一律拒绝。
/// 宽容在这儿没有任何好处 —— 浏览器本来就只发严格形状，而「看起来更安全的宽容」
/// 只会让下一个人以为有人处理过这些情况。
#[must_use]
pub fn is_allowed_origin(raw: &str) -> bool {
    let origin = raw.trim();
    if origin.is_empty() {
        return false;
    }
    // 桌面客户端：非 http(s) 协议，单独判。
    if origin.eq_ignore_ascii_case(TAURI_ORIGIN) {
        return true;
    }

    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    if rest.contains(['/', '?', '#', '@']) {
        return false;
    }

    // 拆 host / port（`Origin` 的端口可选）。
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    if let Some(port) = port
        && (port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()))
    {
        // `[::1]:5173` 会走到这儿（host 里残留 `[::`）—— 被拒是**对的**，见模块文档。
        return false;
    }

    matches!(host, "localhost" | "127.0.0.1")
}

/// 拼这一层 CORS。
///
/// ⚠️ 方法与头的白名单**照抄 Go 的 `corsMiddleware`** —— 两边在这件事上必须一样，
/// 否则「Go 能用、Rust 401」这种只在跨源时出现的差异会非常难查。
/// （`Access-Control-Allow-Headers` 里的 `X-Room-Auth-Tokens` 是 Go 那边就有的，
/// 前端多房间凭据用它。）
///
/// ⚠️ 这里**不加** `#[must_use]`：`CorsLayer` 本身已经带了这个属性，再加一个
/// clippy 会报 `double_must_use`（`-D warnings` 下直接是红的）。
/// 2026-09-26 补跑 clippy 时抓到的 —— 一个没有信息量的属性换来门禁变红，
/// 而门禁红久了就会被当成噪声放过。
pub fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _request| {
            origin.to_str().is_ok_and(is_allowed_origin)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static("x-room-auth-tokens"),
        ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ **桌面客户端的那个来源必须过** —— 它是 W0 实测出来的那一个字符串。
    /// 把这条放进测试是因为「改窄 CORS」这件事最容易的失误就是**把它一起挡掉**，
    /// 而症状是「桌面端一条接口都调不通」，且只在真机上才看得见。
    #[test]
    fn the_desktop_shell_origin_is_allowed() {
        assert!(is_allowed_origin(TAURI_ORIGIN));
        // 大小写不敏感（`Origin` 的 scheme 按规范小写，但别依赖对手的规范程度）。
        assert!(is_allowed_origin("Tauri://LocalHost"));
        assert!(is_allowed_origin("  tauri://localhost  "));
    }

    /// 本机开发用的回环来源（vite dev 端口是任意的）。
    #[test]
    fn loopback_origins_are_allowed() {
        for origin in [
            "http://localhost",
            "http://localhost:5173",
            "http://localhost:9501",
            "https://localhost:8443",
            "http://127.0.0.1",
            "http://127.0.0.1:5173",
            "https://127.0.0.1:9501",
        ] {
            assert!(is_allowed_origin(origin), "{origin} 应当放行");
        }
    }

    /// ⚠️★ **这是这次收窄要挡的东西**：任意网站不能再读本机服务端。
    #[test]
    fn arbitrary_websites_are_rejected() {
        for origin in [
            "https://evil.example",
            "http://evil.example:9501",
            "https://example.com",
            // 看着像回环、其实不是：子域名 / 别的私网地址都不放行。
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
            "http://192.168.1.10:9501",
            "http://10.0.0.1",
            // ⚠️ `null`（`file://` 页面、沙箱 iframe、`data:` URL）**不放行** ——
            // 见模块文档那条理由。
            "null",
        ] {
            assert!(!is_allowed_origin(origin), "{origin} 必须被拒");
        }
    }

    /// 严格形状：带路径 / 查询 / userinfo 的一律拒（浏览器本来也只发严格形状）。
    #[test]
    fn malformed_origins_are_rejected() {
        for origin in [
            "",
            "   ",
            "localhost:5173",             // 缺协议
            "http://",                    // 缺 host
            "http://localhost:5173/",     // 带路径
            "http://localhost:5173/api",  // 带路径
            "http://localhost:5173?x=1",  // 带查询
            "http://user@localhost:5173", // 带 userinfo
            "http://localhost:",          // 空端口
            "http://localhost:port",      // 端口不是数字
            "ftp://localhost:5173",       // 非 http(s)
            "tauri://localhost/x",        // 桌面来源也不许带路径
        ] {
            assert!(!is_allowed_origin(origin), "{origin:?} 必须被拒");
        }
    }

    /// IPv6 回环**没放行**（有意的，见模块文档）。
    #[test]
    fn ipv6_loopback_is_deliberately_not_allowed() {
        assert!(!is_allowed_origin("http://[::1]:5173"));
        assert!(!is_allowed_origin("http://[::1]"));
    }
}
