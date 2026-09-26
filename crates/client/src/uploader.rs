//! 上行（W2）—— 把本机剪贴板的新内容发到**所有**开启上行的房间。
//!
//! # 发的是什么、发到哪
//!
//! 只有两条接口（`docs/api.md` §5）：
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
//! `docs/api.md` §3 原来把**握手 `config` 的载荷**当成 `/server` 的响应贴了出来，
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
//! 2. **不硬编码限额、也不自己编一句拒绝的话** —— `docs/api.md` §11 第 1、2 条：
//!    限额先问 `/server`；文案要**照抄服务端那句**（它带了具体数字，而我们编的那句没有）。
//!    所以这里**不预先拦文本**：直接发，让服务端用 413 + `message` 回答，我们把那句原样带出来。
//!    ⚠️ **唯一一处例外是文件大小**：那是**在本地先拦**的，因为不拦就要把整个文件读进内存
//!    （几百 MB 的复制会直接 OOM）。而且那句提示里会带上服务端给的数字，不是凭空编的。
//! 3. **一场失败不影响下一场** —— 多个房间、一次复制的多个文件，各自发各自的。
//!    一个房间离线不该让别的房间也收不到。

use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, multipart};
use serde::Deserialize;
use time::{OffsetDateTime, UtcOffset};

use crate::config::{Channel, ClientConfig};
use crate::endpoint;
use crate::event::{ClipboardEvent, UploadKind};

/// 单个通道的上传超时。
///
/// ⚠️ 公网端点可能很慢，但**不能无限等** —— 无限等的表现是「上传卡住、后面的复制全堵在后面」。
const CHANNEL_TIMEOUT_SECS: u64 = 30;

/// 建连接的超时（与整体超时分开：连不上的时候要**快**失败，而不是耗满 30 秒）。
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// 服务端限额（`GET /server` 的 `text.limit` / `file.limit`）。
///
/// ⚠️ `0` = **不知道 / 不限**（服务端没给这个字段）。别把它当成「限额是 0」去拦东西。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServerLimits {
    /// `text.limit`（**字符**数，不是字节）。
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

/// 一次上行真正要发出去的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPayload {
    /// 文本（整段就是正文）。
    Text(String),
    /// 一个文件（图片也是它，文件名由这边生成）。
    File { name: String, bytes: Vec<u8> },
}

impl UploadPayload {
    #[must_use]
    pub fn kind(&self) -> UploadKind {
        match self {
            UploadPayload::Text(_) => UploadKind::Text,
            UploadPayload::File { .. } => UploadKind::File,
        }
    }

    /// 正文大小（字节；文本按 UTF-8 算）。
    #[must_use]
    pub fn size(&self) -> u64 {
        match self {
            UploadPayload::Text(text) => text.len() as u64,
            UploadPayload::File { bytes, .. } => bytes.len() as u64,
        }
    }

    /// 给日志 / 通知用的一句话。
    ///
    /// ⚠️★ 文本**必须截断**：剪贴板里可能是一整篇文档、也可能是密码。
    /// 日志和系统通知都不是放这些的地方。
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            UploadPayload::Text(text) => format!("文本「{}」", truncate_middle(text, 40)),
            UploadPayload::File { name, bytes } => {
                format!("文件「{name}」（{} 字节）", bytes.len())
            }
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
) -> Result<Vec<UploadPayload>, String> {
    match event {
        ClipboardEvent::Text { content, .. } => {
            if content.is_empty() {
                return Err("文本是空的".to_owned());
            }
            Ok(vec![UploadPayload::Text(content.clone())])
        }
        ClipboardEvent::Image { png } => {
            if png.is_empty() {
                return Err("图片是空的".to_owned());
            }
            Ok(vec![UploadPayload::File {
                name: image_file_name(now),
                bytes: png.clone(),
            }])
        }
        ClipboardEvent::Files { paths } => {
            if paths.is_empty() {
                return Err("文件列表是空的".to_owned());
            }
            let mut out = Vec::with_capacity(paths.len());
            for path in paths {
                let name = crate::download::sanitize_file_name(&path.to_string_lossy());
                if name.is_empty() {
                    return Err(format!("文件名不可用：{}", path.display()));
                }
                // ⚠️★ **先看大小再读文件**：不先看就要把整个文件读进内存，
                // 复制一个几百 MB 的文件会直接把客户端撑爆。
                if let Ok(meta) = tokio::fs::metadata(path).await {
                    size_guard(meta.len(), limits.file_limit, max_file_size_mb)?;
                }
                let bytes = tokio::fs::read(path)
                    .await
                    .map_err(|e| format!("读不了文件 {}：{e}", path.display()))?;
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
fn size_guard(size: u64, server_limit: u64, max_file_size_mb: u64) -> Result<(), String> {
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
    Err(format!(
        "文件有 {:.1} MB，超过上限 {:.1} MB",
        size as f64 / (1024.0 * 1024.0),
        cap as f64 / (1024.0 * 1024.0)
    ))
}

/// 一次载荷的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadOutcome {
    /// 发了，`succeeded` / `total` 个房间成功。
    Uploaded { total: usize, succeeded: usize },
    /// 因为开关跳过（没开监控 / 没开这个内容类型 / 没有开着上行的房间）。
    Skipped,
    /// 全失败。
    Failed(String),
}

/// 一次剪贴板事件的**总账**（可能包含多个载荷 × 多个房间）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UploadReport {
    /// 一共发了几个载荷（一次复制多个文件时 > 1）。
    pub payloads: usize,
    /// 成功送达的「载荷 × 房间」次数。
    pub delivered: usize,
    /// 整件事因为开关被跳过。
    pub skipped: bool,
    /// 失败原因，每条一个（**带房间名**，否则多房间时看不出是谁失败了）。
    pub failures: Vec<String>,
}

impl UploadReport {
    /// 有没有失败。
    #[must_use]
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }

    /// 把一次载荷的结果并进来。
    pub fn push(&mut self, outcome: UploadOutcome) {
        match outcome {
            UploadOutcome::Uploaded { succeeded, .. } => self.delivered += succeeded,
            UploadOutcome::Skipped => self.skipped = true,
            UploadOutcome::Failed(reason) => self.failures.push(reason),
        }
    }

    /// 给通知 / 日志用的一句话。
    #[must_use]
    pub fn summary(&self) -> String {
        if !self.failures.is_empty() {
            return format!(
                "{} 个载荷里有 {} 处失败：{}",
                self.payloads,
                self.failures.len(),
                self.failures.join("；")
            );
        }
        if self.skipped {
            return "没有发出去（相关开关关着）".to_owned();
        }
        // ⚠️ `delivered == 0` 而**不是**被开关跳过 —— 那是界面上「点一下发送」那条路
        //（[`upload_explicit`]）会走到的分支：它一个开关都不判，所以**不能说**
        // 「相关开关关着」，那是一句假话（用户会去关着的地方找原因）。
        if self.delivered == 0 {
            return "没有发出去".to_owned();
        }
        format!("已发到 {} 个房间", self.delivered)
    }
}

/// 建一个上行用的 HTTP 客户端。
///
/// ⚠️ 超时是**必配**的，理由见 [`CHANNEL_TIMEOUT_SECS`]。
pub fn build_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(CHANNEL_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("建 HTTP 客户端失败：{e}"))
}

/// 现在的时刻 —— **上层要主动发事件时该用的唯一时钟**。
///
/// ⚠️ 为什么由这个 crate 提供，而不是让上层自己取：`upload_event` 要一个时间戳
/// （图片文件名 `clipboard_<时间戳>.png` 靠它，而那个名字是**本机时区**的，
/// 与行为基准 `clip-sync` 逐字一致），而 `docs/api.md` 里的 `timestamp`
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
) -> UploadReport {
    if !cfg.is_upload_enabled(event.upload_kind()) {
        return UploadReport {
            skipped: true,
            ..UploadReport::default()
        };
    }
    let targets = cfg.upload_channels();
    if targets.is_empty() {
        return UploadReport {
            skipped: true,
            ..UploadReport::default()
        };
    }
    send_to(cfg, &targets, event, limits, now, client).await
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
) -> UploadReport {
    send_to(cfg, &[target], event, limits, now, client).await
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
        let outcome = upload_payload(client, targets, cfg, &payload).await;
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
) -> UploadOutcome {
    let mut succeeded = 0usize;
    let mut failures = Vec::new();

    for channel in targets {
        match post_to_channel(client, channel, cfg, payload).await {
            Ok(()) => succeeded += 1,
            Err(reason) => failures.push(format!("「{}」{reason}", channel.name)),
        }
    }

    if succeeded > 0 {
        UploadOutcome::Uploaded {
            total: targets.len(),
            succeeded,
        }
    } else {
        UploadOutcome::Failed(format!(
            "{} 个房间全部失败：{}",
            targets.len(),
            failures.join("；")
        ))
    }
}

/// 发一个载荷到**一个**房间。
pub(crate) async fn post_to_channel(
    client: &Client,
    channel: &Channel,
    cfg: &ClientConfig,
    payload: &UploadPayload,
) -> Result<(), String> {
    let device_name = cfg.device_name.as_str();

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
    };

    // ⚠️★ **凭据只走请求头**，不进 URL（`docs/api.md` §1.2 + §8 审计清单）。
    if let Some(token) = channel.auth_token.as_deref().map(str::trim)
        && !token.is_empty()
    {
        builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    let response = match payload {
        UploadPayload::Text(text) => builder
            // ⚠️ `text/plain` + 整个请求体就是文本 —— 这是 `docs/api.md` §5 的首选形状
            // （另外两种 JSON / multipart 是给 Apple 捷径用的，我们不需要）。
            .header(CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(text.clone())
            .send()
            .await
            .map_err(|e| format!("请求失败：{e}"))?,
        UploadPayload::File { name, bytes } => builder
            // ⚠️ 字段名恒为 `file`（`docs/api.md` §5）。
            .multipart(multipart::Form::new().part(
                "file",
                multipart::Part::bytes(bytes.clone()).file_name(name.clone()),
            ))
            .send()
            .await
            .map_err(|e| format!("请求失败：{e}"))?,
    };

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(parse_api_error(status, &body))
    }
}

/// 把服务端的错误响应变成一句话。
///
/// 优先级照 `docs/api.md` §11 第 3 条：**读 `message`（中文，给人看）**，退到 `error`，
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
    use std::path::PathBuf;
    use time::macros::datetime;

    fn fixed_now() -> OffsetDateTime {
        datetime!(2026-09-26 13:45:00 +8)
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

        // ⚠️★ **这条是防回归**：`/server` 的响应**没有**限额（`docs/api.md` §3 曾经
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
    #[test]
    fn text_is_truncated_for_logging() {
        let short = UploadPayload::Text("hi".to_owned());
        assert_eq!(short.describe(), "文本「hi」");

        let long = UploadPayload::Text("很".repeat(500));
        let described = long.describe();
        assert!(described.chars().count() < 100, "日志里的文本必须截断");
        assert!(described.contains('…'));

        // 按字符截断 —— 多字节字符不能被切成半个。
        assert!(!described.contains('\u{fffd}'));
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
        assert!(err.contains("10.0 MB"), "要说清上限是多少：{err}");

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
        });
        report.push(UploadOutcome::Uploaded {
            total: 3,
            succeeded: 3,
        });
        assert_eq!(report.delivered, 5);
        assert!(report.ok());
        assert_eq!(report.summary(), "已发到 5 个房间");

        report.push(UploadOutcome::Failed("「家里」HTTP 401：未授权".to_owned()));
        assert!(!report.ok());
        assert!(
            report.summary().contains("家里"),
            "失败信息要能看出是哪个房间"
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
        let report =
            upload_event(&cfg, &event, ServerLimits::default(), fixed_now(), &client).await;
        assert!(report.skipped);
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
        let report =
            upload_event(&cfg, &event, ServerLimits::default(), fixed_now(), &client).await;
        assert!(report.skipped);
        assert!(report.payloads == 0, "跳过的时候不该去材料化（更不该发）");
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
        let automatic =
            upload_event(&cfg, &event, ServerLimits::default(), fixed_now(), &client).await;
        assert!(automatic.skipped, "剪贴板那条路要过开关");
        assert_eq!(automatic.payloads, 0);

        // 同一条事件、同一份配置，走显式那条路就该**照发不误**。
        let explicit = upload_explicit(
            &cfg,
            &target,
            &event,
            ServerLimits::default(),
            fixed_now(),
            &client,
        )
        .await;
        assert!(
            !explicit.skipped,
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
