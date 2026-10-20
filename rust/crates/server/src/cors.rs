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
//! ⚠️ 这条同时也是 `dev-docs/specs/desktop-client.md` §8 审计清单里那条
//! 「**只放该 origin**，别开 `*`」的落地。
//!
//! # 放行谁（三类内置 + 配置里写的）
//!
//! | 来源 | 为什么 |
//! |---|---|
//! | `tauri://localhost` | **桌面客户端**（`dev-docs/specs/desktop-client.md` §3 的 B 方案）。 ⚠️ 实测确认过：webview 发的就是**这一个**字符串（§0.1.3 那套记录型代理抓到的） |
//! | `http(s)://localhost[:port]` | 本机开发（`vite dev` 是 `http://localhost:5173` → `http://localhost:9501`） |
//! | `http(s)://127.0.0.1[:port]` | 同上，只是写法不同 |
//! | `server.allowOrigins` 里的每一条 | **前后端分离部署**：前端在 CDN / 静态托管上，只调这个 API。 |
//!
//! ⚠️★ **SPA 同源部署不需要 CORS** —— 它由这个服务端**自己**渲染。而「前端放别处」这件事
//! 2026-10-20 起有了**正式的口子**：`server.allowOrigins`（命令行 `-allow-origin`）。
//! 那是**逐条列出**的白名单，**不是**把 `*` 放回来 —— 理由见下面「为什么要收窄」。
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

/// 这个 `Origin` 头允许跨源读吗？（**内置**的那三类，不含配置里的白名单）
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

/// 这个 `Origin` 头允许吗？= 内置三类 **或** 部署时配的那几条白名单。
///
/// ⚠️★ 比较**只走归一化后的字符串**：`origin` 来自请求头（大小写、结尾斜杠都可能与人写的不一样），
/// 而 `extras` 已经是 [`clip9_core::config::normalize_origin`] 归一过的。
/// 直接 `==` 原文的话，「配了 `HTTPS://A.example`、浏览器发 `https://a.example`」会**永远不匹配** ——
/// 而那种错只在真机上才看得见（本地同源调试根本不触发 CORS）。
#[must_use]
pub fn is_allowed(raw: &str, extras: &[String]) -> bool {
    if is_allowed_origin(raw) {
        return true;
    }
    if extras.is_empty() {
        return false;
    }
    match clip9_core::config::normalize_origin(raw) {
        Ok(origin) => extras.iter().any(|allowed| allowed == &origin),
        Err(_) => false,
    }
}

/// 拼这一层 CORS。
///
/// `extras` 是 `server.allowOrigins`（调用方已经过 [`ServerConfig::normalized_origins`]
/// 归一，被拒的那几条在外面 warn 过）。传空切片 = 只有内置那三类 —— 也就是同源渲染的
/// 常规部署，与加这个参数之前**一模一样**。
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
pub fn cors(extras: &[String]) -> CorsLayer {
    // ⚠️ 先 clone 一份成 `Arc<[String]>` 再进闭包：`CorsLayer` 的 predicate 是 `Fn`，
    //    借用 `&[String]` 活不过这个函数（层要跟着 Router 活到进程结束）。
    let extras: std::sync::Arc<[String]> = extras.into();
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            move |origin: &HeaderValue, _request| {
                origin.to_str().is_ok_and(|raw| is_allowed(raw, &extras))
            },
        ))
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

    /// ⚠️★ 2026-10-20：分离部署的白名单**只多放行它列的**，别的照旧被拒。
    /// 这条钉的是「加了口子之后，`*` 的效果没有偷偷回来」。
    #[test]
    fn configured_origins_are_allowed_and_nothing_else_is() {
        let extras = vec!["https://clip.example.com".to_owned()];
        assert!(is_allowed("https://clip.example.com", &extras));
        // 归一化之后比较：大小写 / 结尾斜杠都能认（浏览器发的是小写无斜杠，人写的不一定）。
        assert!(is_allowed("https://CLIP.Example.com", &extras));
        assert!(is_allowed("https://clip.example.com/", &extras));
        // 没列的一律不行 —— 包括它的子域、别的端口、别的协议。
        for origin in [
            "https://evil.example",
            "https://sub.clip.example.com",
            "https://clip.example.com:8443",
            "http://clip.example.com",
            "null",
        ] {
            assert!(
                !is_allowed(origin, &extras),
                "{origin} 不在白名单里，不该放行"
            );
        }
        // 空白名单 = 与加这个参数之前完全一样。
        assert!(!is_allowed("https://clip.example.com", &[]));
        // ⚠️ 内置那三类**不因为配了白名单而消失**（桌面端不该被一次部署配置弄坏）。
        assert!(is_allowed(TAURI_ORIGIN, &extras));
        assert!(is_allowed("http://localhost:5173", &extras));
    }
}
