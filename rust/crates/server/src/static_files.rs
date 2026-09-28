//! 前端静态资源：**唯一一处**「怎么发」。
//!
//! | 来源 | 什么时候用 |
//! |---|---|
//! | 外部目录 | 运行时给了 `-static <目录>`（调前端时覆盖用，改了 dist 不用重编） |
//! | 内嵌 | 其余情况（**默认**，`build.rs` 编进二进制的那一份） |
//!
//! 优先级 `外部目录 > 内嵌`，判定**只在这里**（[`Source::of`]）。
//!
//! 语义逐条对齐 Go 的 `spaStaticHandler`（`cloud-clip/lib/spa_shell.go`）：真文件优先（带猜出来的
//! MIME）；没有同名文件时**只有「这次请求想要一份网页」才回外壳**（并注入 `<base>`），其余一律 404。
//!
//! ⚠️★ 后一条那道闸（Go 叫 `wantsHTML`）是这个模块最要紧的几行。少了它，`GET /api/typo` +
//! `Accept: application/json` 会拿到**一份 200 的 HTML** —— 正是本项目记过的「下载下来是个 html」
//! 老坑，而且**不报错**（clip9 在 2026-09-28 之前就是那样：`ServeDir::fallback(ServeFile)` 没有闸）。
//!
//! ⚠️ 不用 `ServeDir`：它读不了内嵌那份（内存里的字节），为它另写一套「怎么发」正是上面那个老坑的
//! 成因之一。代价：没有 `Range` / 304 / 目录索引 —— 对**本机 / 局域网**的前端产物都不需要。
//! ⚠️ `/file/{uuid}` **不走这里**（它要 Range，仍用 `ServeFile`）。

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use crate::spa_shell;
use crate::state::AppState;

// ⚠️ build.rs 生成的那张 `(相对路径, include_bytes!(绝对路径))` 表。
// 它保证「表与目录不一致」在**结构上**不可能 —— 表是遍历目录生成的。
include!(concat!(env!("OUT_DIR"), "/embedded_static.rs"));

/// 这次请求的前端产物从哪来。
enum Source {
    /// `-static <目录>` —— 调试前端时的覆盖。
    Dir(PathBuf),
    /// `build.rs` 编进来的那一份（**默认**）。
    ///
    /// ⚠️ 它恒在：`build.rs` 找不到 `static/index.html` 时会**直接让构建失败**。
    /// 那个 panic 是故意的 —— 静默编出一个没有前端的二进制，与那个 404 是同一个病。
    Embedded,
}

impl Source {
    /// 有没有前端可发。`None` = **两种来源都没有** → 调用方**不挂静态兜底**（只跑 API）。
    fn of(dir: Option<&Path>) -> Option<Self> {
        match dir {
            Some(dir) => Some(Self::Dir(dir.to_path_buf())),
            None => (!EMBEDDED.is_empty()).then_some(Self::Embedded),
        }
    }

    /// 取一份产物的字节。`rel` 是**相对** `static/` 的路径。
    ///
    /// ⚠️ 内嵌那一份返回 `Borrowed`：`include_bytes!` 给的是 `&'static [u8]`，
    /// 一次请求不该把 1.2 MiB 的 bundle 复制一遍。
    fn read(&self, rel: &str) -> Option<Cow<'static, [u8]>> {
        match self {
            Self::Embedded => embedded(rel).map(Cow::Borrowed),
            Self::Dir(dir) => {
                let path = safe_join(dir, rel)?;
                std::fs::read(path).ok().map(Cow::Owned)
            }
        }
    }
}

/// 有没有前端可发（用来决定挂不挂静态兜底）。
#[must_use]
pub fn has_source(dir: Option<&Path>) -> bool {
    Source::of(dir).is_some()
}

/// 读**没有注入过标签**的外壳（`index.html`），给要自己注入标题 / OG 卡片的调用方用
///（`/s/<token>`：见 [`crate::share::landing`]）。
///
/// ⚠️ 与 [`serve`] 读的是**同一份字节**（同一个 `Source`）——
/// 所以「分享页有外壳可注入」与「浏览器打得开网页版」不会一个有一个没有。
#[must_use]
pub fn read_shell(dir: Option<&Path>) -> Option<String> {
    let bytes = Source::of(dir)?.read(INDEX)?;
    let html = String::from_utf8_lossy(&bytes).into_owned();
    (!html.is_empty()).then_some(html)
}

/// 外壳的文件名。⚠️ 只有一处（`build.rs` 也拿它当「前端产物在不在」的判据）。
const INDEX: &str = "index.html";

/// 静态资源的兜底处理器 —— 挂在 `Router::fallback` 上。
///
/// ⚠️ 挂在 fallback 上意味着**只有没被任何 `.route()` 接住的请求**才到这儿 ——
/// 这正是要的：`/server`、`/text`、`/content` 那些接口永远优先，
/// 而 `/board`、`/s/<token>` 这类**前端路由的深链**落到这里拿外壳。
/// ⚠️ 举例子别用 `/rooms`：那是**接口**（`GET /rooms`），它的响应与这里无关。
pub async fn serve(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(source) = Source::of(state.static_dir.as_deref()) else {
        return not_found();
    };
    // ⚠️ Go 的 `http.FileServer` 只认 GET/HEAD；它的 `wantsHTML` 对别的方法返回 false
    // → 别的路径上就是一个 404。这里也照 404（而不是 405）：
    // 「这条路径上没有这种东西」比「这个方法不行」更接近事实。
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    let head_only = method == Method::HEAD;
    let rel = relative_path(uri.path());

    // ① 真文件优先。`/`（空相对路径）视作「就是外壳」——
    // 与 Go 的 `staticPathExists` 把 `/` 判成「存在」是同一个意思。
    let hit = if rel.is_empty() {
        source.read(INDEX)
    } else {
        source.read(&rel)
    };
    if let Some(bytes) = hit {
        return if rel.is_empty() || rel == INDEX {
            shell_response(&bytes, &state.config.server.prefix, head_only)
        } else {
            bytes_response(&content_type(&rel), bytes, head_only)
        };
    }

    // ② 没有同名文件：**只有想要一份网页的请求才回外壳**，其它一律 404。
    if !wants_html(&method, &headers) {
        return not_found();
    }
    match source.read(INDEX) {
        Some(bytes) => shell_response(&bytes, &state.config.server.prefix, head_only),
        None => not_found(),
    }
}

/// 把外壳字节发出去，**注入 `<base>`**。
///
/// ⚠️ 为什么要注入：外壳会被 `/board`、`/s/<token>` 这种**深路径**取到，
/// 而产物里的资源地址是相对的（`./assets/…`）—— 不注入 `<base>` 就会按当前目录解析成
/// `/board/assets/…`，全部 404。见 [`spa_shell::inject_tags`]。
///
/// ⚠️ 注入失败（外壳形状出乎意料）时**回原样**，不回 404：外壳本身是好的，
/// 只是没有 `<head>` 可插 —— 给用户一份能跑的页面，比给一份 404 好。
/// （`/s/<token>` 那条路是**相反**的取舍：那里宁可退回通用卡片，也不要吐半截 HTML ——
/// 因为它要往里塞抓取程序用的标签，而这里不塞任何东西。）
fn shell_response(bytes: &[u8], prefix: &str, head_only: bool) -> Response {
    let html = String::from_utf8_lossy(bytes).into_owned();
    let base = spa_shell::base_href(prefix);
    let page = spa_shell::inject_tags(&html, &base, "", "").unwrap_or(html);
    // ⚠️ MIME 走 `content_type(INDEX)`，别在这儿再写一遍 `"text/html; charset=utf-8"` ——
    // 写两遍的话「改一处漏一处」时**两种外壳的响应头会不一样**，而那正是这个项目
    // 一直在防的那类漂移（变异验证时实测到：改 `content_type` 打不到这条路）。
    bytes_response(
        &content_type(INDEX),
        Cow::Owned(page.into_bytes()),
        head_only,
    )
}

/// 一次产物响应：MIME + 长度（⚠️ HEAD 也要给长度，那是它的用处）。
fn bytes_response(content_type: &str, bytes: Cow<'static, [u8]>, head_only: bool) -> Response {
    let len = bytes.len();
    let body = if head_only {
        Body::empty()
    } else {
        match bytes {
            // ⚠️ 内嵌那一份走这条：零拷贝。
            Cow::Borrowed(slice) => Body::from(Bytes::from_static(slice)),
            Cow::Owned(vec) => Body::from(vec),
        }
    };
    let mut out = Response::new(body);
    let value = HeaderValue::from_str(content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    out.headers_mut().insert(header::CONTENT_TYPE, value);
    out.headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    out
}

/// 未知路径的 404。
///
/// ⚠️ 用 axum 默认那个（**空 body**）而不是契约那份 JSON：这里不是接口。
/// 前端那边对 404 的处理是「就当没有这个文件」，而一份 JSON 会让浏览器
/// 把 `text/html` 的期望和它打架（历史上正是这么变成「下载下来是个 html」的）。
fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

/// 请求路径 → 产物表里的**相对路径**。
///
/// ⚠️ 百分号解码：`Uri::path()` 给的是**原始**（未解码）的路径，而文件名是解码后的。
/// 构建产物里全是 `[A-Za-z0-9._-]`，所以正常路径上碰不到这一课 ——
/// 但**外部目录**那一份是用户自己放的（名字里带空格、中文很常见），
/// 不解码就是「明明有那个文件却 404」。
fn relative_path(raw: &str) -> String {
    percent_decode(raw.trim_start_matches('/'))
}

/// `<dir>/<rel>`，**拒绝任何 `..` 段**。
///
/// ⚠️ 内嵌那一份不需要这道闸（只做精确匹配，穿不出去），但**外部目录**那一份需要 ——
/// `-static` 指着一个目录时，`GET /../../etc/passwd` 不该读到 `/etc/passwd`。
/// `.` 与空段直接跳过（等价于规范化），`..` 直接判失败（不尝试「规范化掉再放行」：
/// 那要处理 `/a/../../b` 这种，而这条路上没有任何合法的 `..`）。
fn safe_join(dir: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = dir.to_path_buf();
    for segment in rel.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            other => path.push(other),
        }
    }
    Some(path)
}

/// 内嵌表里找一份。⚠️ 精确匹配 —— 不做前缀 / 模糊，`../` 那类自然穿不出去。
fn embedded(rel: &str) -> Option<&'static [u8]> {
    EMBEDDED
        .iter()
        .find(|(key, _)| *key == rel)
        .map(|(_, bytes)| *bytes)
}

/// 按扩展名猜 MIME。
///
/// ⚠️ `text/*` 要带上 `; charset=utf-8`（Go 的 `mime.TypeByExtension` 就是这么给的）：
/// 不带的话外壳里的中文会按 latin-1 解 —— 而那份 HTML 的 `<meta charset>` 要等
/// 浏览器解析到才发现，中间那一段就是乱码。
fn content_type(rel: &str) -> String {
    let guessed = mime_guess::from_path(rel)
        .first_raw()
        .unwrap_or("application/octet-stream");
    if guessed.starts_with("text/") || guessed == "image/svg+xml" {
        format!("{guessed}; charset=utf-8")
    } else {
        guessed.to_owned()
    }
}

/// 这次请求是不是「要一份网页」。**逐字对齐 Go 的 `wantsHTML`**。
///
/// 三条都算「要网页」：`Accept: text/html`、`text/*`、`*/*`（**抓取程序普遍发 `*/*`**），
/// 以及**完全不发 Accept**（curl 的默认行为）。
///
/// ⚠️★ 这是**接口路径不被回成 html** 的那道闸：XHR / fetch 发的是
/// `application/json`、`image/*` 之类，命中不了 → 404。
fn wants_html(method: &Method, headers: &HeaderMap) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    if accept.is_empty() {
        return true;
    }
    accept.contains("text/html") || accept.contains("text/*") || accept.contains("*/*")
}

/// `%XX` 解码。认不出的 `%` 原样保留（**不报错**）—— 这是路径不是校验目标。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(byte) = hex_byte(bytes[i + 1], bytes[i + 2])
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 两个十六进制字符 → 一个字节。⚠️ 只在**两个都是**十六进制字符时才成功。
fn hex_byte(hi: u8, lo: u8) -> Option<u8> {
    fn digit(byte: u8) -> Option<u8> {
        (byte as char).to_digit(16).map(|value| value as u8)
    }
    Some(digit(hi)? * 16 + digit(lo)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内嵌的那一份必须是**一份真的前端产物**，不是一个空壳。
    ///
    /// ⚠️ 这条挡的是「同步进来的是一个半成品」（`build.rs` 只保证 `index.html` 存在）。
    #[test]
    fn the_embedded_copy_is_a_real_front_end() {
        let index = embedded(INDEX).expect("内嵌里必须有 index.html");
        let html = String::from_utf8_lossy(index);
        assert!(html.contains("<body>"), "外壳得有 body：{}", &html[..80]);
        assert!(html.contains("id=\"app\""), "外壳里得有 SPA 的挂载点");
        // 入口 bundle 必须**也在表里** —— 少了它就是「有 HTML 没有 JS」的白屏。
        let entry = html
            .split("src=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .map(|src| src.trim_start_matches("./").to_owned())
            .expect("外壳里应该有入口 script");
        assert!(
            embedded(&entry).is_some(),
            "外壳引用的入口 {entry} 不在内嵌表里（同步漏了？）"
        );
    }

    /// ⚠️★ 「`%20` 解成空格」与「认不出的 `%` 原样留着」两条都要 —— 后者是**不报错**那一侧。
    #[test]
    fn percent_escapes_are_decoded_and_bad_ones_are_left_alone() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%E4%B8%AD%E6%96%87.js"), "中文.js");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        // ⚠️ 短的 `%X` 结尾不能越界（`i + 2 < len` 那一条）。
        assert_eq!(percent_decode("%2"), "%2");
        assert_eq!(percent_decode(""), "");
    }

    /// ⚠️★ 路径穿越：**外部目录**那一份靠这条挡住。
    #[test]
    fn a_parent_segment_is_refused_not_normalised() {
        let dir = Path::new("/srv/static");
        assert_eq!(
            safe_join(dir, "assets/a.js"),
            Some(PathBuf::from("/srv/static/assets/a.js"))
        );
        // `.` 与空段是规范化掉的（不构成穿越）。
        assert_eq!(
            safe_join(dir, "./a//b"),
            Some(PathBuf::from("/srv/static/a/b"))
        );
        // `..` 一律判失败。
        assert_eq!(safe_join(dir, "../secret"), None);
        assert_eq!(safe_join(dir, "a/../../secret"), None);
        assert_eq!(safe_join(dir, ".."), None);
    }

    #[test]
    fn the_request_path_is_decoded_before_the_lookup() {
        assert_eq!(relative_path("/assets/a.js"), "assets/a.js");
        // 多一个前导斜杠（有些客户端会拼出来）不该影响查找。
        assert_eq!(relative_path("//assets/a.js"), "assets/a.js");
        assert_eq!(relative_path("/"), "");
        assert_eq!(relative_path("/a%20b.css"), "a b.css");
    }

    /// ⚠️★ 这道闸是整个模块的重点：**接口路径不许被回成 html**。
    #[test]
    fn only_requests_that_want_a_page_get_the_shell() {
        let get = Method::GET;
        let with = |accept: &str| {
            let mut headers = HeaderMap::new();
            if !accept.is_empty() {
                headers.insert(header::ACCEPT, HeaderValue::from_str(accept).unwrap());
            }
            wants_html(&get, &headers)
        };
        // 要网页的三种（含「不发 Accept」，那是 curl 的默认行为）。
        assert!(with("text/html,application/xhtml+xml,*/*;q=0.8"));
        assert!(with("*/*"), "抓取程序普遍发这个");
        assert!(with("text/*"));
        assert!(with(""));
        // ⚠️ 这三种必须**不要**：它们一命中，不存在的接口就会拿到一份 200 的 HTML。
        assert!(!with("application/json"));
        assert!(!with("image/png"));
        assert!(!with("application/javascript"));
        // ⚠️ 非 GET/HEAD 一律不算（Go 的 `wantsHTML` 第一条判断）。
        assert!(!wants_html(&Method::POST, &HeaderMap::new()));
    }

    #[test]
    fn the_content_type_follows_the_extension() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("assets/a.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("assets/a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("favicon.ico"), "image/x-icon");
        assert_eq!(content_type("pwa-192x192.png"), "image/png");
        // 认不出的扩展名给二进制，**不要**给 text/plain（那会让浏览器把它当文本显示）。
        assert_eq!(content_type("weird.zzz"), "application/octet-stream");
    }

    /// 有外部目录就用外部目录（哪怕内嵌也在）—— 这是「调试时覆盖」的全部意义。
    #[test]
    fn an_external_dir_wins_over_the_embedded_copy() {
        let dir = tempfile::tempdir().expect("建临时目录");
        std::fs::write(dir.path().join("probe.txt"), b"external").expect("写");
        let source = Source::of(Some(dir.path())).expect("有来源");
        assert_eq!(
            source.read("probe.txt").as_deref(),
            Some(&b"external"[..]),
            "该读到外部目录里那一份"
        );
        // 内嵌里没有这个文件 —— 这就是「两个来源真的来自不同地方」的证据。
        let embedded_only = Source::of(None).expect("内嵌恒在");
        assert!(embedded_only.read("probe.txt").is_none());
        assert!(embedded_only.read(INDEX).is_some());
    }
}
