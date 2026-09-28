//! `/automation` —— 定时自动化的管理页（服务端渲染的独立页面）。
//!
//! 为什么是独立页面而不是 SPA 里的一个面板（照 Go `automation_page.go` 的三条论证）：
//! 1. 这个功能的使用频率极低（配一次用很久），却要在整个生命周期里最可靠 ——
//!    挂在 SPA 的构建产物里，一次前端打包出问题就连「改一下时间」都做不到；
//! 2. 前端资源整条链路挂掉时它仍然可用（页面里的样式和脚本**全内联**，不依赖 static）；
//! 3. 落地成本最低：不动 web-vue3 的构建，也就不动那条已经被五种模式绑住的链路。
//!
//! 页面本身**不含任何权限逻辑** —— 能不能建、能建几条、能改哪些，全部由 `/tasks` 决定。
//!
//! # ⚠️★ 这个 HTML 与 Go 的那份**逐字节相同**
//!
//! 靠 `[[.Prefix]]` / `[[.Room]]` 两个占位符注入，其余一字不差。理由不是省事，
//! 是**避免「靠人肉同步的第二份定义」**（`CONTRIBUTING.md` §6 点名的那条反模式）：
//! 两份文件相同 → `cmp` 就能发现漂移；不同就只能靠人眼对 1900 行。
//!
//! - 刷新内容的方式（**从 Go 仓库**，它现在在隔壁）：
//!   `cp <Go 仓库>/cloud-clip/lib/automation_page.html rust/crates/server/src/`
//! - ⚠️ **别只在这一份上改** —— Go 仓库那边还在跑同一个页面，改了一边等于制造分叉。
//! - `tests/automation_page.rs` 的 `page_matches_go_byte_for_byte` **逐字节比对两个文件**。
//!   它按顺序试几种摆法去找 Go 仓库；**找不到时会跳过** —— 那时这份就是唯一的源，
//!   而「内容有没有漂」这条防线也就没了（要补的是把 Go 那七条静态检查移植过来）。
//! - ⚠️ 模板分隔符仍是 Go 的 `[[ ]]`（不是 Rust 的语法，也不打算换成别的）：
//!   换成别的记号就等于文件不再相同，上面那条性质就没了。
//!   Go 那边换分隔符的原因是页面里到处是 `{{date}}` 这类示例文案（默认分隔符会在
//!   编译期 panic）—— 那个原因对这份文件同样成立。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

/// 页面本体。⚠️ 与 Go 仓库里那份 `cloud-clip/lib/automation_page.html` 逐字节相同 —— 见模块注释。
const PAGE: &str = include_str!("automation_page.html");

const PREFIX_MARKER: &str = "[[.Prefix]]";
const ROOM_MARKER: &str = "[[.Room]]";

/// Go `html/template` 在 **JS 字符串**上下文里的转义。
///
/// ⚠️★ 这张表是**实测出来的**，不是照文档猜的：起一个 Go 实例，把 ASCII 1–126 逐个
/// 塞进 `?room=`，比对**原始输出文本**（不是解析后的值 —— 解析会把 `\u003c` 还原成 `<`，
/// 那样比什么都发现不了）。40 个字符需要转义，其余原样。
///
/// 为什么要这么较真：这个值落在
/// `window.__CC__ = { prefix: "…", room: "…" }` 的**JS 字符串字面量**里，
/// 而 `room` 来自 `?room=`，是**用户可控**的 —— 不转义就是 XSS。
/// 而双跑比对是**逐字节**比这一页的，多转一个字就不一样了。
///
/// ⚠️ 几个反直觉的点（都是实测撞出来的）：
/// - `/` → `\/`，`` ` `` → `\u0060`，`+` → `\u002b` —— 这三个人容易漏；
/// - **`0x7f`（DEL）原样输出**，不在表里（所以不能写「所有 < 0x20 或 == 0x7f」）；
/// - `=` `%` `$` `;` `(` `)` 等**都不转**；
/// - 中文、emoji 等可打印非 ASCII **原样输出**，只有 U+2028 / U+2029 例外
///   （它们在 JS 里是行终止符，放进字符串字面量会直接断行）。
#[must_use]
pub fn js_str_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 8);
    for ch in raw.chars() {
        match ch {
            // 具名转义：Go 的表里这几个有短写法，其余控制字符走 \u00XX。
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '"' => out.push_str("\\u0022"),
            '&' => out.push_str("\\u0026"),
            '\'' => out.push_str("\\u0027"),
            '+' => out.push_str("\\u002b"),
            '/' => out.push_str("\\/"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '\\' => out.push_str("\\\\"),
            '`' => out.push_str("\\u0060"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            // ⚠️ 只兜 `0x00..=0x1f`，**不含 `0x7f`** —— DEL 在 Go 的表里是原样输出的。
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 把两个占位符换成转义后的值。
///
/// 抽出来是为了能被单测直接调 —— 而不用起一个服务端。
#[must_use]
pub fn render(prefix: &str, room: &str) -> String {
    PAGE.replace(PREFIX_MARKER, &js_str_escape(prefix))
        .replace(ROOM_MARKER, &js_str_escape(room))
}

/// `GET /automation`。
///
/// ⚠️ 房间的取法与 `/tasks` 那族**一致**（`?room=` 缺省、空值、`default` 三种写法都归一到
/// `default`）—— 页面进来时用它做初始房间，之后用户可以自己切。
pub async fn page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let room =
        clip9_protocol::normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let prefix = state.config.server.prefix.trim();

    let body = render(prefix, &room);
    let mut resp = (StatusCode::OK, body).into_response();
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    // ⚠️ 这三个头与 Go 逐字一致：
    // · `no-store` —— 页面里内联着凭据相关的逻辑，缓存一份等于缓存一个过期界面；
    // · `X-Robots-Tag` —— 它是个管理页，不该被搜索引擎收录。
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::HeaderName::from_static("x-robots-tag"),
        HeaderValue::from_static("noindex, nofollow"),
    );
    resp
}
