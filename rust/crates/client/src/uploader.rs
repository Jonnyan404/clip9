//! 上行（W2）—— 把本机剪贴板的新内容发到**所有**开启上行的房间。
//!
//! # 发的是什么、发到哪
//!
//! 只有两条接口（`dev-docs/api.md` §5）：
//!
//! | 内容 | 接口 | 正文 |
//! |---|---|---|
//! | 文本 | `POST /text` | `Content-Type: text/plain`，**整个请求体就是文本** |
//! | 文件 / **图片** | `POST /upload` | `multipart/form-data`，字段名恒为 `file` |
//!
//! ⚠️ 图片走**文件**那条路（§4.1 末），不另开一条。
//!
//! # ⚠️★ 限额从哪来：**WS 握手的 `config` 事件**，不是 `/server`
//!
//! `dev-docs/api.md` §3 原来把**握手 `config` 的载荷**当成 `/server` 的响应贴了出来，
//! 于是 §11 那句「Call `/server` first for the limits」**在三个实现上都拿不到东西**。
//! 2026-09-26 实测 + 读源码确认：Go 与 Rust 的 `/server` 都不含 `text` / `file`
//! （也没有 `version`），它们返回的是
//! `{server: "<ws://…/push>", auth, authorized, roomProtected, config:{server:{history,roomList}}, automation}`。
//! `text.limit` / `file.limit` / `version` **只在握手 `config` 里**。
//!
//! 所以 [`ServerLimits`] 从握手来：[`crate::receiver::parse_handshake`] 读它，
//! 随 `ReceiverStatus::Connected` 交给上层，上层再传回 [`upload_event`] 的 `limits`。
//!
//! ⚠️ **拿不到时（还没连过 WS）用 `ServerLimits::default()` = 两个 0 = 不知道** ——
//! 于是只剩用户自己配的 `max_file_size_mb` 生效。这是 fail-open，但方向是对的：
//! 服务端会自己拒掉超限请求，并把**带具体数字**的那句话交回来（§11 第 2 条）。
//! 反过来做（拿不到就拒绝上传）会让「服务端设置页没打开过」变成「什么都传不上去」。
//!
//! # 三条不做的事（都踩过）
//!
//! 1. **不自己拼 URL** —— 一律走 [`crate::endpoint`]，那里有「`http://` 不会被吃成 `http:/`」
//!    和「凭据不进 URL」的断言。
//! 2. **不硬编码限额、也不自己编一句拒绝的话** —— `dev-docs/api.md` §11 第 1、2 条：
//!    限额先问 `/server`；文案要**照抄服务端那句**（它带了具体数字，而我们编的那句没有）。
//!    所以这里**不预先拦文本**：直接发，让服务端用 413 + `message` 回答，我们把那句原样带出来。
//!    ⚠️ **唯一一处例外是文件大小**：那是**在本地先拦**的，因为不拦就要把整个文件读进内存
//!    （几百 MB 的复制会直接 OOM）。而且那句提示里会带上服务端给的数字，不是凭空编的。
//! 3. **一场失败不影响下一场** —— 多个房间、一次复制的多个文件，各自发各自的。
//!    一个房间离线不该让别的房间也收不到。

use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
// ⚠️ 只为了分片上传里那一次 `file.read(..)`（`AsyncReadExt`）—— 一片一片现读，
// 别把整个文件读进来。
use reqwest::{Client, multipart};
use serde::Deserialize;
use time::{OffsetDateTime, UtcOffset};
use tokio::io::AsyncReadExt;

use crate::config::{Channel, ClientConfig};
use crate::endpoint;
use crate::event::{ClipboardEvent, UploadKind};
use crate::msg::Msg;

/// 单个通道的上传超时。
///
/// ⚠️ 公网端点可能很慢，但**不能无限等** —— 无限等的表现是「上传卡住、后面的复制全堵在后面」。
const CHANNEL_TIMEOUT_SECS: u64 = 30;

/// 建连接的超时（与整体超时分开：连不上的时候要**快**失败，而不是耗满 30 秒）。
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// 服务端限额（来自 **WS 握手 `config` 事件**的 `text` / `file` 段 ——
/// ⚠️ **不是** `/server`，见模块文档里那段「限额从哪来」）。
///
/// ⚠️ `0` = **不知道 / 不限**（服务端没给这个字段）。别把它当成「限额是 0」去拦东西。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServerLimits {
    /// `text.limit`（**字节**数，不是字符数）。
    ///
    /// ⚠️★ 这里**曾经写成「字符数，不是字节」**（2026-09-27 修正）。而服务端
    ///（`handlers.rs` 的 `text.len()`）与 Go 基准判的都是**字节** ——
    /// **照那句错注释去写客户端预检查，中文下会静默地与 Go 分歧**
    ///（一个汉字 3 字节：同一个限额，中文能发的字数只有 ASCII 的 1/3）。
    pub text_limit: usize,
    /// `file.limit`（字节）。
    pub file_limit: u64,
}

impl ServerLimits {
    /// 从**WS 握手 `config` 事件**的载荷里读（⚠️ **不是** `/server` 的响应，见模块文档）。
    #[must_use]
    pub fn from_ws_config(data: &serde_json::Value) -> Self {
        Self {
            text_limit: data
                .pointer("/text/limit")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as usize,
            file_limit: data
                .pointer("/file/limit")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        }
    }
}

/// 一片有多大（字节）。
///
/// ⚠️★ 服务端**没有**要求某一片必须是多大：`files.rs` 的 `chunk` 就是往文件后面追加，
/// 而握手下发的 `file.chunk` 只是它「建议」的那个数。所以这里**不读**那个建议值 ——
/// 读了就要给 `ServerLimits` 加一个字段、还要处理「还没握手过 = 0」这一档，
/// 换来的只是「和服务端建议的一样大」，而这件事**没有任何行为上的差别**。
/// ⚠️ 但它有**上界**：`/upload/chunk/:uuid` 也挂着 `DefaultBodyLimit`（16 MiB），
/// 超了就是一次 413。这里取 1 MiB（服务端配置的默认值），离那个上界很远。
pub const UPLOAD_CHUNK_SIZE: usize = 1024 * 1024;

/// 上传进度的回调：`(已发字节, 总字节)`。
///
/// ⚠️★ 为什么是**闭包**而不是「返回一堆中间状态」：上行是**一个 await**，
/// 中间没有可以停下来交出控制权的地方。要让它能被界面看见，只能由**里面**往外喊。
/// ⚠️ `Send + Sync` 是因为它会跨 tokio 任务、也可能跨线程。
pub type ProgressFn = std::sync::Arc<dyn Fn(u64, u64) + Send + Sync>;

/// 一次上行真正要发出去的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPayload {
    /// 文本（整段就是正文）。
    Text(String),
    /// 一个**小**文件（图片也是它，文件名由这边生成）—— 字节已经读进来了。
    ///
    /// ⚠️ 只在小于 [`UPLOAD_CHUNK_SIZE`] 时用它：那时「读进来」的代价可以忽略。
    File { name: String, bytes: Vec<u8> },
    /// 一个**大**文件 —— ⚠️★ **只有路径**，字节按片现读现发。
    ///
    /// 为什么必须有这一种：整份读进来（上面那个变体）在两个地方同时出问题 ——
    ///   · 内存里会同时有**两份**（`post_to_channel` 里 `Part::bytes` 还 clone 一次），
    ///     一个 200MB 的文件就是 400MB 常驻；
    ///   · 服务端**单次请求**挂着 16 MiB 的硬上限，那份字节**根本发不出去**
    ///     （推完才被 413 挡回来，而 `parse_api_error` 兜底只吐一个「HTTP 413」，
    ///     一个数字都没有）。
    /// 走分片之后两个问题一起消失：内存里只有一片，而且每一片都在限额内。
    LargeFile {
        name: String,
        path: std::path::PathBuf,
        size: u64,
    },
}

impl UploadPayload {
    #[must_use]
    pub fn kind(&self) -> UploadKind {
        match self {
            UploadPayload::Text(_) => UploadKind::Text,
            UploadPayload::File { .. } | UploadPayload::LargeFile { .. } => UploadKind::File,
        }
    }

    /// 正文大小（字节；文本按 UTF-8 算）。
    #[must_use]
    pub fn size(&self) -> u64 {
        match self {
            UploadPayload::Text(text) => text.len() as u64,
            UploadPayload::File { bytes, .. } => bytes.len() as u64,
            UploadPayload::LargeFile { size, .. } => *size,
        }
    }

    /// 给日志 / 通知用的一句话。
    ///
    /// ⚠️★ 它是 [`Msg`]（键 + 参数），**不是成文的中文**（2026-09-28 改）——
    /// 见 [`crate::msg`] 的模块文档。这条会进系统通知，而通知是壳渲染的。
    ///
    /// ⚠️★ 文本**必须截断**：剪贴板里可能是一整篇文档、也可能是密码。
    /// 日志和系统通知都不是放这些的地方。
    #[must_use]
    pub fn describe(&self) -> Msg {
        match self {
            UploadPayload::Text(text) => {
                Msg::key("payloadText").param("text", truncate_middle(text, 40))
            }
            UploadPayload::File { name, bytes } => Msg::key("payloadFile")
                .param("name", name)
                .param("bytes", bytes.len()),
            UploadPayload::LargeFile { name, size, .. } => Msg::key("payloadFile")
                .param("name", name)
                .param("bytes", *size),
        }
    }
}

/// 中间截断：`很长很长的内容…` → 头尾各留一点。
///
/// ⚠️ 按**字符**截断，不按字节（按字节会把多字节字符切成半个，日志里就是乱码）。
#[must_use]
fn truncate_middle(text: &str, keep: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= keep * 2 {
        return text.to_owned();
    }
    let head: String = chars[..keep].iter().collect();
    let tail: String = chars[chars.len() - keep..].iter().collect();
    format!("{head}…{tail}")
}

/// 图片上传时用的文件名：`clipboard_20260926-134500.png`。
///
/// ⚠️ 形如 `clipboard_YYYYMMDD-HHMMSS.png`，与行为基准 `clip-sync` 逐字一致
/// （`clipboard_{}.png` + `%Y%m%d-%H%M%S`）。
///
/// ⚠️★ **时间从参数进来，不在函数里取** —— 取时间会让这个函数不可测
/// （测试要么容忍任意值，要么去改系统时钟）。这也是 [`ClipboardEvent::Image`]
/// 故意不带文件名的原因：那会把时钟依赖渗进 W1 的去重逻辑里。
///
/// [`ClipboardEvent::Image`]: crate::ClipboardEvent::Image
#[must_use]
pub fn image_file_name(now: OffsetDateTime) -> String {
    format!(
        "clipboard_{:04}{:02}{:02}-{:02}{:02}{:02}.png",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// 把一个剪贴板事件变成**要发的载荷**。
///
/// ⚠️ 一次复制**多个文件**会变成**多个载荷**（行为基准 `clip-sync` 也是逐个文件发，
/// 一次一个 `POST /upload`）—— 所以返回 `Vec`。别把它写成「只发第一个」，
/// 那会**静默丢掉**用户复制的一半内容。
///
/// ⚠️ 文本 / 图片为空 → `Err`（空内容没有发出去的意义，而且服务端存一条空条目是脏数据）。
pub async fn materialize(
    event: &ClipboardEvent,
    now: OffsetDateTime,
    limits: ServerLimits,
    max_file_size_mb: u64,
) -> Result<Vec<UploadPayload>, Msg> {
    match event {
        ClipboardEvent::Text { content, .. } => {
            if content.is_empty() {
                return Err(Msg::key("uploadTextEmpty"));
            }
            Ok(vec![UploadPayload::Text(content.clone())])
        }
        ClipboardEvent::Image { png } => {
            if png.is_empty() {
                return Err(Msg::key("uploadImageEmpty"));
            }
            Ok(vec![UploadPayload::File {
                name: image_file_name(now),
                bytes: png.clone(),
            }])
        }
        ClipboardEvent::Files { paths } => {
            if paths.is_empty() {
                return Err(Msg::key("uploadFileListEmpty"));
            }
            let mut out = Vec::with_capacity(paths.len());
            for path in paths {
                let name = crate::download::sanitize_file_name(&path.to_string_lossy());
                if name.is_empty() {
                    return Err(Msg::key("uploadBadFileName").param("path", path.display()));
                }
                // ⚠️★ **先看大小再决定读不读**：不先看就要把整个文件读进内存，
                // 复制一个几百 MB 的文件会直接把客户端撑爆。
                let size = tokio::fs::metadata(path)
                    .await
                    .map_err(|err| {
                        Msg::key("uploadFileUnreadable")
                            .param("path", path.display())
                            .param("reason", err)
                    })?
                    .len();
                size_guard(size, limits.file_limit, max_file_size_mb)?;

                // ⚠️★ 够大就**只记路径、不读字节**（`LargeFile`）：整份读进来的那份
                // 既占两份内存、又发不出去（服务端单次请求 16 MiB 的硬上限）。
                if size >= UPLOAD_CHUNK_SIZE as u64 {
                    out.push(UploadPayload::LargeFile {
                        name,
                        path: path.clone(),
                        size,
                    });
                    continue;
                }

                let bytes = tokio::fs::read(path).await.map_err(|err| {
                    Msg::key("uploadFileUnreadable")
                        .param("path", path.display())
                        .param("reason", err)
                })?;
                size_guard(bytes.len() as u64, limits.file_limit, max_file_size_mb)?;
                out.push(UploadPayload::File { name, bytes });
            }
            Ok(out)
        }
    }
}

/// 文件大小上限：服务端给的（首) + 用户自己配的（`max_file_size_mb`，0 = 不限）。
///
/// ⚠️ 返回的错误信息里**带上具体数字** —— 那是 §11 第 2 条要的
/// 「让它带数字，用户才知道要减到多少」。
/// ⚠️ 数字在**这里**格式化（`12.3 MB`），而且单位（B / KB / MB）两种语言一样 ——
/// 把字节数交给页面去格式化会变成**第二份**分档规则（`ui/app.js` 的 `sizeLabel` 已经有一份）。
fn size_guard(size: u64, server_limit: u64, max_file_size_mb: u64) -> Result<(), Msg> {
    let mb = max_file_size_mb.saturating_mul(1024 * 1024);
    let cap = match (server_limit, mb) {
        (0, 0) => 0,        // 两个都不知道 / 都不限
        (s, 0) => s,        // 只有服务端给了
        (0, m) => m,        // 只有用户配了
        (s, m) => s.min(m), // 两个都有，取严的那个
    };
    if cap == 0 || size <= cap {
        return Ok(());
    }
    Err(Msg::key("uploadFileTooLarge")
        .param("size", megabytes(size))
        .param("limit", megabytes(cap)))
}

/// 字节 → `12.3 MB`（带一位小数）。
///
/// ⚠️ 单位是**语言无关**的（B / KB / MB 中英文一样），所以这一份格式化放在 Rust 里没问题；
/// 有语言差异的是**句子**，那部分在字典里。
fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// 一次成功的上行落在哪儿、服务端给它编了多少号。
///
/// # ⚠️★ 为什么要「连房间一起记」，而不是光一个 id
///
/// id 是**每个房间各自**单调的（`CONTRIBUTING.md` §6）：两个房间可以同时有一条 id 7。
/// 只按 id 记的话，会给**另一个房间**里那条 7 也贴上「本机剪贴板同步」的标签 ——
/// 而那是**假话**（那条内容可能是别人发的），而且它看起来完全正常。
/// 所以身份是 **(服务端, 房间, id)** 三样，和 `Store::notice_in` / `room_index` 同一套判据。
///
/// ⚠️ 它服务的**只有界面上的一个标签**（「我发的」还是「剪贴板同步」，见 `EntryView`）：
/// 服务端不认这个区分，翻历史也翻不出来 —— 记不下来的那次（老服务端没回 id、
/// 分片上传那条路）就照旧显示「我发的」。那**不是假话**，只是信息少一点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedEntry {
    /// 哪个服务端（原样，不归一化 —— 归一化是 `Store` 的事）。
    pub server: String,
    pub room: String,
    /// 服务端给这条内容的编号。
    pub id: i32,
}

/// 一次载荷的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadOutcome {
    /// 发了，`succeeded` / `total` 个房间成功。
    ///
    /// ⚠️★ `entries` 里**只有服务端回了 id 的那几条** —— 它不是「成功了几条」的
    /// 第二份计数（那个数是 `succeeded`），而是「哪几条能认出来」的清单。
    /// 两个数**本来就可以不一样**，别拿其中一个去校验另一个。
    Uploaded {
        total: usize,
        succeeded: usize,
        entries: Vec<UploadedEntry>,
    },
    /// 因为开关跳过 —— ⚠️ **带上「卡在哪一道」**（见 [`SkipReason`]）。
    Skipped(SkipReason),
    /// 全失败。
    ///
    /// ⚠️★ 里面是 [`Msg`]（键 + 参数）—— 它可能是**我们自己**说的话
    ///（空文本、文件太大、请求失败），也可能是**服务端**给的原话
    ///（`parse_api_error` 抄回来的 `message`，那是**数据**、不翻译）。
    /// 两种都能放进 `Msg`：后者只当一个参数。
    Failed(Msg),
}

/// 「被跳过」时**到底卡在哪一道开关上**。
///
/// ⚠️★ 2026-09-27 加的，起因是用户报的一句话：「default 房间连上提示相关开关关着，
/// 那个开关功能早就移除不存在了」。原来这里只有一个光秃秃的 `Skipped`，
/// 提示语就只能写成「没有发出去（相关开关关着）」—— 而这句话**指认不出是哪一个**：
/// 客户端里同时有「每个房间的 ↑」「全局的文本 / 文件」两档，用户看到「相关开关」
/// 只会去想起那个**早就删掉的全局同步开关**（§4.1 第 5 条），于是这句话读起来像假的。
///
/// ⚠️ 修法不是把文案写得更好听，而是**让判据自己说话**：[`upload_event`] 里
/// 本来就是两个分支，各自报自己的理由，界面不必再猜（也不必再抄一份判断 ——
/// 「两处各写一遍」正是这个项目最忌讳的那类）。为什么没跳过，看一眼这个枚举就知道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// 这一类内容（文本 / 文件）没开上行 —— 开关在**全局设置**页里。
    ContentKind,
    /// 一个房间都没开 ↑ —— 开关在**侧栏的房间行**上。
    NoUploadRoom,
}

impl SkipReason {
    /// 给提示 / 日志用的一句话。
    ///
    /// ⚠️★ **必须点出开关在哪儿**（「设置」/「侧栏」），而且**只用界面上真有那两处**：
    /// 原来那句「相关开关关着」之所以被用户当成假话，就是因为它指的东西他不认得。
    /// ⚠️ 所以这两句里的「设置」「文本 / 文件」**必须与页面上那两个标签逐字一致**
    ///（`ui/i18n.js` 的 `'全局设置': 'Settings'` / `'文本': 'Text'`）——
    /// 那边改了名字这边不改，用户又会对着一句指错地方的话找开关。
    #[must_use]
    pub fn summary(self) -> Msg {
        match self {
            Self::ContentKind => Msg::key("uploadSkippedContentKind"),
            Self::NoUploadRoom => Msg::key("uploadSkippedNoRoom"),
        }
    }
}

/// 一次剪贴板事件的**总账**（可能包含多个载荷 × 多个房间）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UploadReport {
    /// 一共发了几个载荷（一次复制多个文件时 > 1）。
    pub payloads: usize,
    /// 成功送达的「载荷 × 房间」次数。
    pub delivered: usize,
    /// 整件事因为开关被跳过（**卡在哪一道**见 [`SkipReason`]）。
    ///
    /// ⚠️★ 用 `Option<SkipReason>` 而**不是**「一个 `bool` + 一个理由字段」：
    /// 两个字段就一定会漂（跳过却没说理由、或说了理由却没跳过），
    /// 而这里要的正是「跳过 ⇒ 一定指得出是哪一道」。
    pub skip: Option<SkipReason>,
    /// 失败原因，每条一个（**带房间名**，否则多房间时看不出是谁失败了）。
    pub failures: Vec<Msg>,
    /// 这一趟里**认得出 id 的**那些成功上行（见 [`UploadedEntry`]）。
    ///
    /// ⚠️★ 上层拿它去标「这条是本机剪贴板同步过去的」（`Store::mark_clipboard_uploads`）。
    /// ⚠️ 界面那条路（[`upload_explicit`]）也会填它，但**上层故意不用** ——
    /// 从输入框敲的字、拖进来的文件是**明确的意图**，标成「剪贴板同步」是假话。
    pub uploaded: Vec<UploadedEntry>,
}

impl UploadReport {
    /// 有没有失败。
    #[must_use]
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }

    /// 有没有被开关跳过。
    #[must_use]
    pub fn skipped(&self) -> bool {
        self.skip.is_some()
    }

    /// 把一次载荷的结果并进来。
    pub fn push(&mut self, outcome: UploadOutcome) {
        match outcome {
            UploadOutcome::Uploaded {
                succeeded, entries, ..
            } => {
                self.delivered += succeeded;
                self.uploaded.extend(entries);
            }
            UploadOutcome::Skipped(reason) => self.skip = Some(reason),
            UploadOutcome::Failed(reason) => self.failures.push(reason),
        }
    }

    /// 给通知 / 日志用的一句话。
    ///
    /// ⚠️★ 它是 [`Msg`]（键 + 参数）—— 见 [`crate::msg`] 的模块文档。
    /// ⚠️★ 失败原因**整份递过去**（`{reasons}` 是个列表），**不在这里拼接**：
    /// 原来这里是 `failures.join("；")` —— 那个全角分号在英文句子中间很突兀。
    #[must_use]
    pub fn summary(&self) -> Msg {
        if !self.failures.is_empty() {
            return Msg::key("uploadSomeFailed")
                .param("payloads", self.payloads)
                .param("failed", self.failures.len())
                .param_msg_list("reasons", self.failures.iter().cloned());
        }
        if let Some(reason) = self.skip {
            // ⚠️ 理由由 [`SkipReason`] 给，这里**不另写一份**：文案与判据分家，
            // 下一次改判据就会留下一句过期的话（用户这次报的正是这个）。
            return reason.summary();
        }
        // ⚠️ `delivered == 0` 而**不是**被开关跳过 —— 那是界面上「点一下发送」那条路
        //（[`upload_explicit`]）会走到的分支：它一个开关都不判，所以**不能说**
        // 「相关开关关着」，那是一句假话（用户会去关着的地方找原因）。
        if self.delivered == 0 {
            return Msg::key("uploadNothingSent");
        }
        Msg::key("uploadSentToRooms").param("count", self.delivered)
    }
}

/// 建一个上行用的 HTTP 客户端。
///
/// ⚠️ 超时是**必配**的，理由见 [`CHANNEL_TIMEOUT_SECS`]。
pub fn build_client() -> Result<Client, Msg> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(CHANNEL_TIMEOUT_SECS))
        .build()
        .map_err(|e| Msg::key("httpClientFailed").param("reason", e))
}

/// 现在的时刻 —— **上层要主动发事件时该用的唯一时钟**。
///
/// ⚠️ 为什么由这个 crate 提供，而不是让上层自己取：`upload_event` 要一个时间戳
/// （图片文件名 `clipboard_<时间戳>.png` 靠它，而那个名字是**本机时区**的，
/// 与行为基准 `clip-sync` 逐字一致），而 `dev-docs/api.md` 里的 `timestamp`
/// 是**服务端**落的秒级绝对时间 —— 两者不是一回事。上层各自造一个时钟，
/// 就会出现「文件名是 UTC 的」这种没人能一眼看出来的偏差。
///
/// ⚠️★ 取不到本机时区时**退到 UTC**，而不是报错：这时只有**生成的文件名**上的时间
/// 会差一个时区偏移（条目上的 `timestamp` 不受影响，它是服务端落的绝对秒）。
/// 为一个「给人看的名字」让整个上行停摆，不划算 —— 这一条是有意的取舍，
/// 不是「忘了处理错误」。
#[must_use]
pub fn now() -> OffsetDateTime {
    UtcOffset::current_local_offset()
        .map(|offset| OffsetDateTime::now_utc().to_offset(offset))
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
}

/// 把**本机剪贴板的一次变化**发出去 —— 走配置：哪些房间开了 ↑、这类内容发不发。
///
/// ⚠️ **每个房间独立**：一个房间失败不影响别的（见模块文档第 3 条）。
///
/// ⚠️★ **它只服务剪贴板那条路。** 界面上「点一下发送」走
/// [`upload_explicit`] —— 那一跳**一个开关都不看**，理由见那个函数的文档。
pub async fn upload_event(
    cfg: &ClientConfig,
    event: &ClipboardEvent,
    limits: ServerLimits,
    now: OffsetDateTime,
    client: &Client,
    progress: Option<&ProgressFn>,
) -> UploadReport {
    // ⚠️★ 两个分支各自报自己的理由（[`SkipReason`]）—— 界面拿到的是**判据本身**，
    // 不是一句要靠猜的「相关开关关着」。顺序就是优先级：先说内容类型、再说房间。
    if !cfg.is_upload_enabled(event.upload_kind()) {
        return UploadReport {
            skip: Some(SkipReason::ContentKind),
            ..UploadReport::default()
        };
    }
    let targets = cfg.upload_channels();
    if targets.is_empty() {
        return UploadReport {
            skip: Some(SkipReason::NoUploadRoom),
            ..UploadReport::default()
        };
    }
    // ⚠️ 剪贴板那条路**不报进度**（`progress: None`）：它是**没有界面**的 ——
    // 用户没点任何东西，界面上也没有「正在发」的位置。给了也没人看。
    send_to(cfg, &targets, event, limits, now, client, progress).await
}

/// 从界面**显式**发一次（输入框的「发送」/ 📎 / 🖼 / 拖进来的文件）。
///
/// ⚠️★ 与 [`upload_event`] 的区别只有一处，但那一处是**功能上的**：
/// **目标由调用方给（界面上选中的那个房间），而且一个同步开关都不判**
/// （既不判房间的 ↑，也不判「文本 / 文件」那两个内容开关）。
///
/// 理由（Jonny 2026-09-26）：「**上传和下载是本地剪贴板的功能，是独立的，
/// 不要影响本地客户端的功能**，它们只负责获取本地剪贴板上传到远程房间
/// 和获取远程房间消息写入本地剪贴板」。
///
/// ⚠️★ 反过来说：↑ **默认是关的**（§4.1 第 3 条）。判开关的话，装完第一次
/// 在输入框里打字点「发送」会**什么都不发生** —— 而那正是这个项目最忌讳的一类
/// （点了没反应）。用户自己敲的字 + 自己按的按钮，是**明确的意图**，不该被
/// 「自动同步」的开关拦下来。
///
/// ⚠️ 仍然要过的两道关（它们不是同步开关）：`max_file_size_mb`（本机自设的上限）
/// 与服务端的限额 —— 服务端会自己拒掉超限的那次，并把带具体数字的话带回来。
pub async fn upload_explicit(
    cfg: &ClientConfig,
    target: &Channel,
    event: &ClipboardEvent,
    limits: ServerLimits,
    now: OffsetDateTime,
    client: &Client,
    progress: Option<&ProgressFn>,
) -> UploadReport {
    send_to(cfg, &[target], event, limits, now, client, progress).await
}

/// 真的发：材料化 + 逐个房间发。
///
/// ⚠️★ **开关的判断不在这里** —— 它属于「谁决定目标」那一层（上面两个入口）。
/// 放进来的话，两个入口就又变成同一件事了，而它们本来就该不一样。
async fn send_to(
    cfg: &ClientConfig,
    targets: &[&Channel],
    event: &ClipboardEvent,
    limits: ServerLimits,
    now: OffsetDateTime,
    client: &Client,
    progress: Option<&ProgressFn>,
) -> UploadReport {
    let mut report = UploadReport::default();

    let payloads = match materialize(event, now, limits, cfg.max_file_size_mb).await {
        Ok(payloads) => payloads,
        Err(reason) => {
            report.failures.push(reason);
            return report;
        }
    };

    for payload in payloads {
        report.payloads += 1;
        let outcome = upload_payload(client, targets, cfg, &payload, progress).await;
        report.push(outcome);
    }
    report
}

/// 一个载荷发到所有目标房间。
async fn upload_payload(
    client: &Client,
    targets: &[&Channel],
    cfg: &ClientConfig,
    payload: &UploadPayload,
    progress: Option<&ProgressFn>,
) -> UploadOutcome {
    let mut succeeded = 0usize;
    let mut failures = Vec::new();
    // ⚠️ 只收**服务端回了 id** 的那些（见 `UploadedEntry` 的文档：认不出就不标）。
    let mut entries = Vec::new();

    for channel in targets {
        // ⚠️ 多个房间时进度**只跟着第一个**喊：界面上只有一条进度条，
        // 而「两个房间各自 40%」是没有意义的数（用户要的是「传完没有」）。
        match post_to_channel(client, channel, cfg, payload, progress).await {
            Ok(id) => {
                succeeded += 1;
                if let Some(id) = id {
                    entries.push(UploadedEntry {
                        server: channel.server.clone(),
                        room: channel.room.clone(),
                        id,
                    });
                }
            }
            Err(reason) => failures.push(
                Msg::key("roomScopedFailure")
                    .param("room", &channel.name)
                    .param_msg("text", reason),
            ),
        }
    }

    if succeeded > 0 {
        UploadOutcome::Uploaded {
            total: targets.len(),
            succeeded,
            entries,
        }
    } else {
        UploadOutcome::Failed(
            Msg::key("uploadAllRoomsFailed")
                .param("count", targets.len())
                .param_msg_list("reasons", failures),
        )
    }
}

/// 发一个载荷到**一个**房间。
///
/// 返回服务端给那条内容的 id（能认出来才有，见 [`parse_upload_id`]）。
pub(crate) async fn post_to_channel(
    client: &Client,
    channel: &Channel,
    cfg: &ClientConfig,
    payload: &UploadPayload,
    progress: Option<&ProgressFn>,
) -> Result<Option<i32>, Msg> {
    let device_name = cfg.device_name.as_str();

    // ⚠️ 大文件**不走这里**：它要的是「初始化 → 逐片追加 → 收尾」那三趟，
    // 一趟 multipart 发不完（服务端单次请求 16 MiB 的硬上限会把它挡回来）。
    if let UploadPayload::LargeFile { name, path, size } = payload {
        return upload_chunked(client, channel, cfg, name, path, *size, progress).await;
    }

    let mut builder = match payload {
        UploadPayload::Text(_) => client.post(endpoint::text_url(
            &channel.server,
            &channel.room,
            device_name,
            &cfg.client_id,
        )?),
        UploadPayload::File { .. } => client.post(endpoint::upload_url(
            &channel.server,
            &channel.room,
            device_name,
        )?),
        UploadPayload::LargeFile { .. } => unreachable!("上面已经 return 了"),
    };

    // ⚠️★ **凭据只走请求头**，不进 URL（`dev-docs/api.md` §1.2 + §8 审计清单）。
    if let Some(token) = channel.auth_token.as_deref().map(str::trim)
        && !token.is_empty()
    {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    // ⚠️ 小文件（与文本）只有「0 → 完」两个点：它们一趟就发完，中间没有可报的时刻。
    // 这是**有意接受**的粗糙 —— 为 10KB 的东西造一条假的进度曲线没有意义。
    if let Some(on) = progress {
        on(0, payload.size());
    }

    let response = match payload {
        UploadPayload::Text(text) => builder
            // ⚠️ `text/plain` + 整个请求体就是文本 —— 这是 `dev-docs/api.md` §5 的首选形状
            // （另外两种 JSON / multipart 是给 Apple 捷径用的，我们不需要）。
            .header(CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(text.clone())
            .send()
            .await
            .map_err(|e| Msg::key("requestFailed").param("reason", e))?,
        UploadPayload::File { name, bytes } => builder
            // ⚠️ 字段名恒为 `file`（`dev-docs/api.md` §5）。
            .multipart(multipart::Form::new().part(
                "file",
                multipart::Part::bytes(bytes.clone()).file_name(name.clone()),
            ))
            .send()
            .await
            .map_err(|e| Msg::key("requestFailed").param("reason", e))?,
        UploadPayload::LargeFile { .. } => unreachable!("大文件在上面已经 return 了"),
    };

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        if let Some(on) = progress {
            on(payload.size(), payload.size());
        }
        // ⚠️★ 成不成**不看**这个 id：认不出来照样算成功（它只影响界面上的一个标签）。
        Ok(parse_upload_id(&body))
    } else {
        Err(Msg::verbatim(parse_api_error(status, &body)))
    }
}

/// 给请求挂上凭据（分片那三趟与整份那趟**共用**一条规矩）。
///
/// ⚠️ 没有凭据就是**没有** —— 不发一个空的 `Bearer`（那会被服务端当成
/// 「给了一个错密码」，而真相是「这个房间不需要密码」）。
fn with_auth(request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token {
        Some(token) => request.header(AUTHORIZATION, format!("Bearer {token}")),
        None => request,
    }
}

/// 分片上传一个大文件：`/upload/chunk` 登记 → 逐片 `/upload/chunk/:uuid` 追加 →
/// `/upload/finish/:uuid` 收尾。
///
/// ⚠️★ 形状照**服务端**那份（`files.rs` 的三个 handler），并照网页版
/// `StickyComposer.vue` 的 `sendFiles` 那一段 —— 那一边已经跑通了，别另发明一种。
///
/// ⚠️★ 每片都是**现读现发**：内存里同时只有 `UPLOAD_CHUNK_SIZE` 那么多字节。
/// 对照整份那条路（`tokio::fs::read` + `Part::bytes` 再 clone 一次）在 200MB 的
/// 文件上是 400MB 常驻 —— 而且那一趟**发不出去**（服务端单次请求 16 MiB 的硬上限）。
///
/// ⚠️ 每一片完成就喊一次进度（`已发 / 总共`）。这个信号是**真的**：它数的是
/// 真正被服务端收下的字节（一片 2xx 之后才前进），不是「写进了 socket」。
async fn upload_chunked(
    client: &Client,
    channel: &Channel,
    cfg: &ClientConfig,
    name: &str,
    path: &std::path::Path,
    size: u64,
    progress: Option<&ProgressFn>,
) -> Result<Option<i32>, Msg> {
    let token = channel
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty());

    /// 一趟请求发完，非 2xx 就把服务端那句**带数字**的话带回来。
    macro_rules! fail_on {
        ($response:expr) => {{
            let status = $response.status().as_u16();
            let body = $response.text().await.unwrap_or_default();
            if !(200..300).contains(&status) {
                return Err(Msg::verbatim(parse_api_error(status, &body)));
            }
            body
        }};
    }

    // ① 登记：body 是文件名，`Content-Type` 必须是 **全等**的 `text/plain`
    //（服务端靠它在同一个 handler 里分叉，`text/plain; charset=utf-8` 不算）。
    let response = with_auth(
        client
            .post(endpoint::chunk_init_url(
                &channel.server,
                &channel.room,
                &cfg.device_name,
            )?)
            .header(CONTENT_TYPE, "text/plain")
            .body(name.to_owned()),
        token,
    )
    .send()
    .await
    .map_err(|err| Msg::key("requestFailed").param("reason", err))?;
    let body = fail_on!(response);
    let uuid = serde_json::from_str::<serde_json::Value>(body.trim())
        .ok()
        .and_then(|value| {
            value
                .pointer("/result/uuid")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| Msg::key("uploadChunkNoUuid"))?;

    // ② 逐片追加。
    let mut file = tokio::fs::File::open(path).await.map_err(|err| {
        Msg::key("uploadFileUnreadable")
            .param("path", path.display())
            .param("reason", err)
    })?;
    let mut buffer = vec![0u8; UPLOAD_CHUNK_SIZE];
    let mut sent = 0u64;
    while sent < size {
        let want = (size - sent).min(UPLOAD_CHUNK_SIZE as u64) as usize;
        // ⚠️ `read_exact` 不够：文件在「看大小」与「读」之间被改小了的话它会一直等。
        // 这里按「读到了多少就发多少」处理，读不动就停 —— 少发的那截由服务端登记的
        // size 兜住（`files.rs` 每片都更新它），不会记出一个比实际大的文件。
        let mut got = 0usize;
        while got < want {
            let read = file.read(&mut buffer[got..want]).await.map_err(|err| {
                Msg::key("uploadFileUnreadable")
                    .param("path", path.display())
                    .param("reason", err)
            })?;
            if read == 0 {
                break;
            }
            got += read;
        }
        if got == 0 {
            break;
        }

        let response = with_auth(
            client
                .post(endpoint::chunk_push_url(&channel.server, &uuid)?)
                .header(CONTENT_TYPE, "application/octet-stream")
                .body(buffer[..got].to_vec()),
            token,
        )
        .send()
        .await
        .map_err(|err| Msg::key("requestFailed").param("reason", err))?;
        fail_on!(response);

        sent += got as u64;
        if let Some(on) = progress {
            on(sent, size);
        }
    }

    // ③ 收尾：登记消息 + 广播。⚠️ 少了这一趟，字节已经在服务端了，
    // 但**房间里没有这条消息** —— 症状是「传完了，别人什么都收不到」。
    let response = with_auth(
        client.post(endpoint::chunk_finish_url(
            &channel.server,
            &channel.room,
            &cfg.device_name,
            &uuid,
        )?),
        token,
    )
    .send()
    .await
    .map_err(|err| Msg::key("requestFailed").param("reason", err))?;
    let body = fail_on!(response);
    Ok(parse_upload_id(&body))
}

/// 从上行成功的响应体里抠出「服务端给这条内容编的号」。
///
/// 形状是 `dev-docs/api.md` §5 那一份：`{"url": "…", "id": "7", "type": "text"}`。
///
/// ⚠️★ **字符串和数字都要认**：Go 服务端与 Worker 回的 `id` 都是**字符串**
/// （`strconv.Itoa` / `toString()`），但这件事**不是契约**里最稳的一条 ——
/// 下一个服务端写成数字是很容易发生的事。认不出就 `None`，**不报错**：
/// 这个 id 只用来决定卡片上写「我发的」还是「剪贴板同步」，
/// 为一个标签让整个上行变成失败是「小事变大」。
///
/// ⚠️ 走**分片**上传那条路（`/upload/finish/:uuid`）时响应里没有 id（是个 `{}`）——
/// 那几张大文件就不带标签，照旧显示「我发的」。
///
/// ⚠️ 之所以把它抽成一个**纯函数**：它上面没有任何 IO，于是可以拿真响应体直接测
/// （两个服务端的两种形状都在测试里）。
#[must_use]
pub fn parse_upload_id(body: &str) -> Option<i32> {
    /// `{"id": "7"}` 与 `{"id": 7}` 都收。
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Ack {
        Number(i64),
        Text(String),
    }

    #[derive(Deserialize)]
    struct AckBody {
        #[serde(default)]
        id: Option<Ack>,
    }

    // ⚠️ 解析失败（不是 JSON、没有 `id`、`id` 是别的东西）一律 `None` —— 与上面同一条：
    // 认不出不是错误。
    match serde_json::from_str::<AckBody>(body.trim()).ok()?.id? {
        Ack::Number(value) => i32::try_from(value).ok(),
        Ack::Text(text) => text.trim().parse::<i32>().ok(),
    }
}

/// 把服务端的错误响应变成一句话。
///
/// 优先级照 `dev-docs/api.md` §11 第 3 条：**读 `message`（中文，给人看）**，退到 `error`，
/// 再退到原始正文。⚠️ **别按 `Accept` 分**（同一条的规定）。
///
/// ⚠️ 服务端那句 `message` 里带具体数字（「最大 4096 字符」），所以**照抄它**，
/// 别自己编一句更像人话但没有数字的。
#[must_use]
pub fn parse_api_error(status: u16, body: &str) -> String {
    #[derive(Deserialize)]
    struct ApiErrorBody {
        #[serde(default)]
        error: String,
        #[serde(default)]
        message: String,
    }

    let trimmed = body.trim();
    if let Ok(parsed) = serde_json::from_str::<ApiErrorBody>(trimmed) {
        if !parsed.message.is_empty() {
            return format!("HTTP {status}：{}", parsed.message);
        }
        if !parsed.error.is_empty() {
            return format!("HTTP {status}：{}", parsed.error);
        }
    }
    if trimmed.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}：{}", truncate_middle(trimmed, 120))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::TextSubtype;
    use crate::msg::ParamValue;
    use std::path::PathBuf;
    use time::macros::datetime;

    fn fixed_now() -> OffsetDateTime {
        datetime!(2026-09-26 13:45:00 +8)
    }

    /// 取一个字符串参数 —— 断言只认「键 + 参数」，不再拿中文句子当判据
    /// （见 `crate::msg` 的模块文档）。
    fn param(msg: &Msg, name: &str) -> String {
        msg.params
            .get(name)
            .and_then(ParamValue::as_str)
            .unwrap_or_else(|| panic!("`{name}` 这个参数不见了：{msg:?}"))
            .to_owned()
    }

    /// ⚠️ 上层（「手动发一条」那条路）要的是一个**真实时钟** —— 而这个 crate 原来
    /// 只有一个**写死**的测试时钟，于是上层要么自己再造一个（时区可能不一样），
    /// 要么干脆发不出去。上面那个改名（`now` → `fixed_now`）就是为了让这条
    /// 断言能说到真正的 `now()`。
    ///
    /// ⚠️ 只钉「真的是现在」，**不钉时区**：时区在不同机器上本来就不一样，
    /// 而 `now()` 的契约是「本机时区，取不到时退到 UTC」（见它的文档）。
    #[test]
    fn now_is_the_real_current_time() {
        let delta = (now() - OffsetDateTime::now_utc()).abs();
        assert!(
            delta < time::Duration::seconds(5),
            "now() 应当就是现在，与 UTC 的差应当只有时区偏移，实际 {delta}"
        );
    }

    /// 上行响应里那个 `id`：**两种形状都要认，认不出不许报错**。
    ///
    /// ⚠️★ 它服务的是界面上的一个标签（「我发的」/「剪贴板同步」），所以判据不是
    /// 「抠得出来」，而是「**抠不出来时不要闹**」：老服务端不回 id、分片上传那条路
    /// 回的是 `{"result":{"uuid":…}}`、被人塞了个 `{"id":"abc"}` —— 这三种都只是
    /// `None`，而上行**照样是成功的**。
    ///
    /// ⚠️ 两种形状分别是 Go 服务端（`strconv.Itoa` → 字符串）与「万一写成数字」那一份。
    /// 那一份**现在还不存在**，但把它写进测试是便宜的 —— 认不出的症状是
    /// 「所有条目都显示我发的」，看起来完全正常。
    #[test]
    fn the_upload_id_is_read_from_both_shapes() {
        // ① Go 服务端（`dev-docs/api.md` §5 那一份，`id` 是**字符串**）。
        assert_eq!(
            parse_upload_id(r#"{"url":"http://h:9502/content/7","id":"7","type":"text"}"#),
            Some(7)
        );
        // ② 数字形状（下一个服务端可能就是这样的）。
        assert_eq!(parse_upload_id(r#"{"id":42}"#), Some(42));
        // ③ 认不出的：一律 `None`，**不是错误**。
        assert_eq!(parse_upload_id(""), None, "空响应体");
        assert_eq!(parse_upload_id("not json"), None, "不是 JSON");
        assert_eq!(parse_upload_id("{}"), None, "没有 id 这个键");
        assert_eq!(
            parse_upload_id(r#"{"result":{"uuid":"abc"}}"#),
            None,
            "分片上传那条路回的就是这个形状"
        );
        assert_eq!(parse_upload_id(r#"{"id":"abc"}"#), None, "id 不是数字");
        assert_eq!(parse_upload_id(r#"{"id":null}"#), None);
        // ⚠️ 超出 `i32`：`Option` 里不许装一个截断过的值（那会给**另一条**内容贴标签）。
        assert_eq!(parse_upload_id(r#"{"id":"99999999999"}"#), None);
    }

    /// ⚠️ 图片文件名与行为基准 `clip-sync` 逐字一致（它是 `clipboard_<时间戳>.png`）。
    #[test]
    fn image_file_name_matches_the_baseline_shape() {
        assert_eq!(
            image_file_name(fixed_now()),
            "clipboard_20260926-134500.png"
        );
        // 补零也要对（个位数月/日/时/分/秒）。
        assert_eq!(
            image_file_name(datetime!(2026-01-02 03:04:05 +8)),
            "clipboard_20260102-030405.png"
        );
    }

    /// 限额从**握手 `config`** 读；`0` 表示「服务端没说」，**不是**「限额是 0」。
    ///
    /// ⚠️ 载荷用的是**真的**握手形状（`text.limit` / `file.limit` 在顶层下面）——
    /// 这条同时钉住「读的是握手，不是 `/server`」。
    #[test]
    fn limits_come_from_the_ws_handshake_config() {
        let ws_config = serde_json::json!({
            "version": "0.1.0",
            "server": { "history": 50, "prefix": "", "roomList": false },
            "text": { "limit": 4096 },
            "file": { "limit": 268435456, "expire": 3600, "chunk": 1048576 },
            "auth": false,
            "latestId": 7,
            "automation": { "enabled": true }
        });
        assert_eq!(
            ServerLimits::from_ws_config(&ws_config),
            ServerLimits {
                text_limit: 4096,
                file_limit: 268435456
            }
        );

        // 字段缺失 → 0（不知道），而不是「限额 0」把一切都拦掉。
        assert_eq!(
            ServerLimits::from_ws_config(&serde_json::json!({})),
            ServerLimits::default()
        );

        // ⚠️★ **这条是防回归**：`/server` 的响应**没有**限额（`dev-docs/api.md` §3 曾经
        // 把握手载荷错标成 `/server` 的响应，客户端照着写就会永远拿到 0）。
        // 真拿这份载荷去读，得到的必须是「不知道」，而不是某个看起来对的数。
        let real_server_response = serde_json::json!({
            "server": "ws://127.0.0.1:9501/push",
            "auth": false,
            "authorized": true,
            "roomProtected": false,
            "config": { "server": { "history": 50, "roomList": false } },
            "automation": { "enabled": false }
        });
        assert_eq!(
            ServerLimits::from_ws_config(&real_server_response),
            ServerLimits::default(),
            "`/server` 里没有限额 —— 别在那边找"
        );
    }

    /// ⚠️★ 文本日志必须**截断**（剪贴板里可能是一整篇文档，也可能是密码）。
    ///
    /// ⚠️ 判据是**句子被拆开之后**的形状（键 + 参数，2026-09-28 改）：截断发生在
    /// **参数值**上，不在句子上。所以「有没有截断」要去 `text` 这个参数里看 ——
    /// 这才是它进日志、进通知时真正被看见的那一段。
    #[test]
    fn text_is_truncated_for_logging() {
        let short = UploadPayload::Text("hi".to_owned());
        let described = short.describe();
        assert_eq!(described.key, "payloadText");
        assert_eq!(param(&described, "text"), "hi");
        assert_eq!(
            serde_json::to_string(&described).unwrap(),
            r#"{"key":"payloadText","params":{"text":"hi"}}"#,
            "一个文本载荷的形状"
        );

        let long = UploadPayload::Text("很".repeat(500));
        let described = long.describe();
        let text = param(&described, "text");
        assert!(text.chars().count() < 100, "日志里的文本必须截断");
        assert!(text.contains('…'));

        // 按字符截断 —— 多字节字符不能被切成半个。
        assert!(!text.contains('\u{fffd}'));
    }

    /// 图片 → 文件载荷，文件名带时间戳。
    #[tokio::test]
    async fn image_becomes_a_file_payload() {
        let event = ClipboardEvent::Image { png: vec![1, 2, 3] };
        let payloads = materialize(&event, fixed_now(), ServerLimits::default(), 0)
            .await
            .expect("应当能发");
        assert_eq!(
            payloads,
            vec![UploadPayload::File {
                name: "clipboard_20260926-134500.png".to_owned(),
                bytes: vec![1, 2, 3],
            }]
        );
        assert_eq!(payloads[0].kind(), UploadKind::File, "图片走文件那条接口");
    }

    /// 一次性复制的**多个文件**要变成多个载荷 —— 只发第一个 = 静默丢一半内容。
    #[tokio::test]
    async fn several_files_become_several_payloads() {
        let dir = std::env::temp_dir().join("clip9-client-uploader-test");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let a = dir.join("甲.txt");
        let b = dir.join("乙.txt");
        tokio::fs::write(&a, b"aaa").await.unwrap();
        tokio::fs::write(&b, b"bb").await.unwrap();

        let event = ClipboardEvent::Files {
            paths: vec![a.clone(), b.clone()],
        };
        let payloads = materialize(&event, fixed_now(), ServerLimits::default(), 0)
            .await
            .unwrap();
        assert_eq!(payloads.len(), 2, "两个文件要发两次");
        assert_eq!(
            payloads[0],
            UploadPayload::File {
                name: "甲.txt".to_owned(),
                bytes: b"aaa".to_vec()
            }
        );
        assert_eq!(
            payloads[1],
            UploadPayload::File {
                name: "乙.txt".to_owned(),
                bytes: b"bb".to_vec()
            }
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// ⚠️★ **文件大小有两个上限，取严的那个**；而且报错要带数字。
    #[test]
    fn file_size_guard_takes_the_stricter_limit_and_quotes_numbers() {
        const MB: u64 = 1024 * 1024;

        // 服务端 10 MB、用户不限 → 按 10 MB 拦。
        assert!(size_guard(5 * MB, 10 * MB, 0).is_ok());
        let err = size_guard(20 * MB, 10 * MB, 0).expect_err("超了要报错");
        assert_eq!(err.key, "uploadFileTooLarge");
        assert_eq!(param(&err, "limit"), "10.0 MB", "要说清上限是多少：{err:?}");

        // 服务端 100 MB、用户配了 10 MB → 按 10 MB 拦（取严）。
        assert!(size_guard(5 * MB, 100 * MB, 10).is_ok());
        assert!(size_guard(20 * MB, 100 * MB, 10).is_err());

        // 两个都不知道 / 都不限 → 不拦（由服务端去拒）。
        assert!(size_guard(u64::MAX / 2, 0, 0).is_ok());

        // 只有用户配了 → 按用户的拦。
        assert!(size_guard(20 * MB, 0, 10).is_err());
    }

    /// 空内容不该发（服务端存一条空条目是脏数据），而且是**在本地就拦掉**。
    #[tokio::test]
    async fn empty_content_is_rejected_locally() {
        let empty_text = ClipboardEvent::Text {
            content: String::new(),
            subtype: Some(TextSubtype::Url),
        };
        assert!(
            materialize(&empty_text, fixed_now(), ServerLimits::default(), 0)
                .await
                .is_err()
        );

        let empty_image = ClipboardEvent::Image { png: Vec::new() };
        assert!(
            materialize(&empty_image, fixed_now(), ServerLimits::default(), 0)
                .await
                .is_err()
        );

        let no_files = ClipboardEvent::Files { paths: Vec::new() };
        assert!(
            materialize(&no_files, fixed_now(), ServerLimits::default(), 0)
                .await
                .is_err()
        );
    }

    /// 服务端错误：**优先照抄 `message`**（带数字那句），退到 `error`，再退到原文。
    #[test]
    fn server_error_message_is_quoted_verbatim() {
        let body = r#"{"code":"text_too_long","error":"Text too long","message":"文本内容超出限制 (最大 4096 字符)"}"#;
        let got = parse_api_error(413, body);
        assert_eq!(got, "HTTP 413：文本内容超出限制 (最大 4096 字符)");
        assert!(got.contains("4096"), "数字必须带出来");

        // 只有 error 的时候用它。
        assert_eq!(
            parse_api_error(
                401,
                r#"{"code":"unauthorized","error":"Missing credential"}"#
            ),
            "HTTP 401：Missing credential"
        );

        // 连 JSON 都不是（反代塞回来的 HTML）→ 截断之后带出来，别原样糊一屏。
        let html = format!("<html>{}</html>", "x".repeat(1000));
        let got = parse_api_error(502, &html);
        assert!(got.starts_with("HTTP 502："));
        assert!(got.chars().count() < 300);

        // 空的 → 只留状态码。
        assert_eq!(parse_api_error(500, "   "), "HTTP 500");
    }

    /// 总账：多载荷合并、跳过与失败分得开。
    #[test]
    fn report_aggregates_outcomes() {
        let mut report = UploadReport {
            payloads: 2,
            ..UploadReport::default()
        };
        report.push(UploadOutcome::Uploaded {
            total: 3,
            succeeded: 2,
            entries: vec![UploadedEntry {
                server: "http://a:9502".to_owned(),
                room: "default".to_owned(),
                id: 7,
            }],
        });
        report.push(UploadOutcome::Uploaded {
            total: 3,
            succeeded: 3,
            // ⚠️★ 这一条**成功但认不出 id**（老服务端不回 id）—— 它照样算送达，
            // 只是不进那张「认得出」的清单。两个数**本来就允许不一样**。
            entries: Vec::new(),
        });
        assert_eq!(report.delivered, 5);
        assert_eq!(
            report.uploaded,
            vec![UploadedEntry {
                server: "http://a:9502".to_owned(),
                room: "default".to_owned(),
                id: 7,
            }],
            "只有认得出 id 的那几条进清单"
        );
        assert!(report.ok());
        let sent = report.summary();
        assert_eq!(sent.key, "uploadSentToRooms");
        assert_eq!(param(&sent, "count"), "5");
        assert!(sent.params.contains_key("count"));

        // ⚠️★ 「失败时要能看出是哪个房间」这条现在钉在**结构**上（2026-09-28 改）：
        // `reasons` 是个**列表**，里面每一项是 `roomScopedFailure`，房间名在那个
        // 内层消息的 `room` 参数上。这样**页面**才能把每一项各自排好 ——
        // 换成我们在这儿 `join("；")` 的话，那个全角分号在英文句子里很突兀，
        // 而且「怎么排」是语言决定的事（见 `crate::msg` 的模块文档）。
        let failed = Msg::key("roomScopedFailure")
            .param("room", "家里")
            .param_msg("text", Msg::verbatim("HTTP 401：未授权"));
        report.push(UploadOutcome::Failed(failed.clone()));
        assert!(!report.ok(), "有失败就不是 ok");

        let summary = report.summary();
        assert_eq!(summary.key, "uploadSomeFailed");
        assert_eq!(param(&summary, "failed"), "1");
        assert_eq!(
            summary.params.get("reasons"),
            Some(&ParamValue::Many(vec![ParamValue::Msg(Box::new(failed))])),
            "失败原因要**整份**递过去，别在这儿拼句子"
        );
    }

    /// 开关关掉 / 没有目标房间 → `Skipped`，而且**不去碰网络**。
    #[tokio::test]
    async fn switches_short_circuit_before_any_request() {
        let cfg = ClientConfig {
            enable_text: false,
            ..ClientConfig::default()
        };
        let client = build_client().unwrap();
        let event = ClipboardEvent::Text {
            content: "x".to_owned(),
            subtype: None,
        };
        let report = upload_event(
            &cfg,
            &event,
            ServerLimits::default(),
            fixed_now(),
            &client,
            None,
        )
        .await;
        // ⚠️★ 断言的是**哪一道**，不是一个布尔：布尔分不出「内容类型没开」与
        // 「没有开着 ↑ 的房间」，而界面上的话就是要照着这个说（见 [`SkipReason`]）。
        assert_eq!(report.skip, Some(SkipReason::ContentKind));
        assert_eq!(report.payloads, 0);
        assert!(report.ok(), "跳过不是失败");
    }

    /// **没有开着上行的房间**也算跳过，不是失败。
    #[tokio::test]
    async fn no_upload_channel_is_a_skip() {
        let cfg = ClientConfig {
            channels: vec![Channel {
                enable_upload: false,
                ..Channel::new("家里", "http://127.0.0.1:1")
            }],
            ..ClientConfig::default()
        };
        let client = build_client().unwrap();
        let event = ClipboardEvent::Text {
            content: "x".to_owned(),
            subtype: None,
        };
        let report = upload_event(
            &cfg,
            &event,
            ServerLimits::default(),
            fixed_now(),
            &client,
            None,
        )
        .await;
        // 内容类型是开着的（`ClientConfig::default()` 里 `enable_text` 是 `true`）——
        // 所以卡住它的**只能**是「一个开着 ↑ 的房间都没有」。这条钉的正是这个区分。
        assert_eq!(report.skip, Some(SkipReason::NoUploadRoom));
        assert!(report.payloads == 0, "跳过的时候不该去材料化（更不该发）");
    }

    /// ⚠️★ **被跳过时那句提示要说得出开关在哪儿**（2026-09-27 用户报的那条）。
    ///
    /// 起因：用户看到「没有发出去（相关开关关着）」之后说「那个开关功能早就移除
    /// 不存在了」—— 因为「相关开关」四个字指的是一个**早就删掉的全局同步开关**。
    /// 所以这里逐条钉住「两种跳过各自点出界面上真有的那一处」。
    #[test]
    fn a_skip_says_which_switch_and_where_it_is() {
        let kind = UploadReport {
            skip: Some(SkipReason::ContentKind),
            ..UploadReport::default()
        }
        .summary();
        let room = UploadReport {
            skip: Some(SkipReason::NoUploadRoom),
            ..UploadReport::default()
        }
        .summary();

        // ⚠️★ 2026-09-28 之后「说清在哪儿」的**判据换了个地方住**，但没取消 ——
        // 它现在分成两半，各自住在能验证它的那一侧：
        //   ① **键必须是两个**：两个开关 = 两个键。一个泛泛的键（原来是同一句
        //      「相关开关」）**说不出**在哪儿，这是这个设计要挡的东西；
        //   ② **字典里各自点出界面上真有的那一处**（中文那句要出现「全局设置」/
        //      「↑」）。那半句在 `ui/i18n.js` 里，**这个 crate 看不见它** ——
        //      所以由 `tools/desktop-ui-smoke.mjs` 盯着（那半边没有测试运行器）。
        // ⚠️ 判据换地方 = 风险搬家，不是消失：两条都要有，缺一条就是「说了但没说清」。
        assert_eq!(kind.key, "uploadSkippedContentKind");
        assert_eq!(room.key, "uploadSkippedNoRoom");
        assert_ne!(kind.key, room.key, "两个开关必须是两个键");
        assert!(
            kind.params.is_empty() && room.params.is_empty(),
            "这两句不带参数 —— 带上了就说明又有东西被拼进句子里了"
        );
    }

    /// ⚠️★ 界面上「点一下发送」**不看任何同步开关** —— 这条钉的就是那个区分。
    ///
    /// 场景照实来：↑ 默认是关的（§4.1 第 3 条），所以判开关的话，装完第一次
    /// 在输入框里打字点「发送」会**什么都不发生**。Jonny 2026-09-26：
    /// 「上传和下载是本地剪贴板的功能，是独立的，不要影响本地客户端的功能」。
    ///
    /// ⚠️ 地址故意指向一个**没人监听**的端口：要证的是「它**没有**在开关那一层短路」
    /// （`payloads == 1` 且 `skipped == false`），不是「它发成功了」——
    /// 后者要真服务端，那是端到端的事。
    #[tokio::test]
    async fn an_explicit_send_ignores_every_sync_switch() {
        let target = Channel {
            enable_upload: false,
            ..Channel::new("家里", "http://127.0.0.1:1")
        };
        let cfg = ClientConfig {
            // 三个开关全部关掉：房间的 ↑、内容类型的文本、文件。
            enable_text: false,
            enable_file: false,
            channels: vec![target.clone()],
            ..ClientConfig::default()
        };
        let client = build_client().unwrap();
        let event = ClipboardEvent::Text {
            content: "我按的是发送，不是自动同步".to_owned(),
            subtype: None,
        };

        // ⚠️ 先钉住「剪贴板那条路确实会被开关拦住」—— 少了这一条，
        // 下面的断言可能只是碰巧成立（比如两个入口其实走了同一段代码）。
        let automatic = upload_event(
            &cfg,
            &event,
            ServerLimits::default(),
            fixed_now(),
            &client,
            None,
        )
        .await;
        assert!(automatic.skipped(), "剪贴板那条路要过开关");
        assert_eq!(automatic.payloads, 0);

        // 同一条事件、同一份配置，走显式那条路就该**照发不误**。
        let explicit = upload_explicit(
            &cfg,
            &target,
            &event,
            ServerLimits::default(),
            fixed_now(),
            &client,
            None,
        )
        .await;
        assert!(
            !explicit.skipped(),
            "显式发送不许被同步开关拦下来（那正是「点了没反应」）"
        );
        assert_eq!(explicit.payloads, 1, "该去材料化、该发出去");
        assert!(
            !explicit.ok(),
            "地址是空的，所以它该失败 —— 但失败的是**网络**，不是开关"
        );
    }

    /// ⚠️★ **凭据只走请求头，不进 URL** —— 这条在 `endpoint` 那边也有断言，
    /// 这里再钉一次「上传这条路真的把 token 放头里了」。
    #[test]
    fn the_token_goes_into_the_header_not_the_url() {
        let channel = Channel {
            auth_token: Some("s3cr3t".to_owned()),
            ..Channel::new("家里", "http://127.0.0.1:9501")
        };
        let url = endpoint::text_url(&channel.server, &channel.room, "Mac", "c1").unwrap();
        assert!(!url.as_str().contains("s3cr3t"));
        // 而它确实会被放进头里 —— 那是 `post_to_channel` 里那一行，
        // 单测没法不起服务端就断言请求头，所以这里只钉「URL 是干净的」这一半。
        assert_eq!(channel.auth_token.as_deref(), Some("s3cr3t"));
    }

    /// 文件名进 URL / 进 multipart 之前要过清洗（`..` 之类）。
    #[tokio::test]
    async fn uploaded_file_names_are_sanitised() {
        let dir = std::env::temp_dir().join("clip9-client-uploader-name-test");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("正常.txt");
        tokio::fs::write(&path, b"x").await.unwrap();

        let event = ClipboardEvent::Files {
            paths: vec![PathBuf::from(&path)],
        };
        let payloads = materialize(&event, fixed_now(), ServerLimits::default(), 0)
            .await
            .unwrap();
        let UploadPayload::File { name, .. } = &payloads[0] else {
            panic!("应当是文件载荷");
        };
        assert_eq!(name, "正常.txt", "文件名只留最后一段");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
