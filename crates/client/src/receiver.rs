//! 下行（W2）+ **历史与实时的边界**。
//!
//! # 边界为什么要服务端说，而不是客户端猜
//!
//! `docs/specs/desktop-client.md` §4.2 把这件事讲透了，这里是摘要 + 落地：
//!
//! 历史与实时**共用同一个事件名**（`receive`），所以客户端天生分不出来。行为基准
//! （`clip-sync`）只好用**时间窗**兜：连上之后静默 `PRIMING_QUIET_SECS` 秒，
//! 这段时间里的东西只认领不写剪贴板。**但时间窗是猜，两头都会错**：
//!
//! - 历史多 / 网络慢 → 窗口**提前结束** → **历史灌进剪贴板**，覆盖用户正复制着的东西 ✗✗；
//! - 窗口开长 → 连上之后别人马上复制的东西**被吞**（真消息收不到）✗。
//!
//! 所以这里**不猜**：握手 `config` 里的 `latestId`（= 连接时刻该房间的最大消息 id，
//! 见 `docs/specs/ws-live-only.md`）就是那条边界。
//!
//! # 规则（[`Boundary`]）
//!
//! | 情况 | 判定 | 做什么 |
//! |---|---|---|
//! | 还没收到 `config` | [`Verdict::NotReady`] | **一条都不写剪贴板** |
//! | 收到 `config`，但**没有** `latestId`（老服务端） | [`Verdict::NoWatermark`] | **拒绝写 + 提示**（fail-safe），不许退化成「先静默几秒试试」 |
//! | `id <= latestId` | [`Verdict::Adopt`] | **只认领**（进本地列表），不写剪贴板 |
//! | `id > latestId` | [`Verdict::Apply`] | 可以写剪贴板 |
//! | 已经处理过的 id | [`Verdict::Duplicate`] | 什么都不做 |
//!
//! ⚠️★ **为什么水印比时间窗安全**（§4.2 的原话，值得记住）：
//! 它是**精确**的（消息 id 单调，`CONTRIBUTING` §6 的三边约定），而且**失败方向对** ——
//! 拿不到水印时客户端**拒绝写并提示**，代价只是「暂时不自动同步」，那是可接受的失败；
//! 而时间窗失效是「**静默地把历史写进剪贴板**」，最坏会覆盖用户刚复制的东西。
//!
//! # 历史从哪来
//!
//! ⚠️ 握手**不再推历史**（`docs/specs/ws-live-only.md` W5）。历史由这边自己去
//! `GET /content` 取 —— 取回来的一律**只认领**（[`Boundary::is_history`]）。
//!
//! ⚠️ 有一个**飞行窗口**要小心：取历史的请求在飞的时候，房间里可能已经推来几条实时消息。
//! 那些消息的 id **大于** `latestId` —— 所以它们**不能**被这次取历史顺手记成「已处理」，
//! 否则 WS 那条会被判成重复、**丢一条真消息**。判据就是 [`Boundary::is_history`]。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clip9_protocol::ReceiveHolder;
use futures_util::StreamExt;
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderValue, Request};
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::config::{Channel, ClientConfig};
use crate::debounce::Debouncer;
use crate::download;
use crate::endpoint;
use crate::event::{ClipboardContent, UploadKind};
use crate::sink::ClipboardSink;
use crate::uploader::{build_client, parse_api_error};

/// 握手 `config` 里这边要的两样东西。
///
/// ⚠️ 只解析需要的字段（`config` 里还有 `version` / `text` / `file` / `automation` 等
/// —— 那些是界面的事，下行不该关心）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Handshake {
    /// 连接时刻该房间的**最大消息 id**（空房间是 `0`）。
    ///
    /// `None` = 握手载荷里**没有这个字段** = 老服务端 → fail-safe，见 [`Verdict::NoWatermark`]。
    pub latest_id: Option<i32>,
    /// 服务端的历史长度上限（`server.history`）—— 取历史时用它当 `limit`。
    pub history: Option<usize>,
}

/// 从握手 `config` 的载荷里读。
///
/// ⚠️ 判「有没有 `latestId`」用的是**字段存在性**（不是「值 > 0」）：
/// 空房间的合法值就是 `0`，而 `0` 恰恰说明它是新服务端。
#[must_use]
pub fn parse_handshake(data: &Value) -> Handshake {
    Handshake {
        latest_id: data
            .get("latestId")
            .and_then(Value::as_i64)
            .map(|v| v as i32),
        history: data
            .pointer("/server/history")
            .and_then(Value::as_u64)
            .map(|v| v as usize),
    }
}

/// 一条 WS 消息解析出来的东西。
#[derive(Debug, Clone)]
pub enum WsEvent {
    /// 握手 `config`（顺序契约上它一定在实时消息之前）。
    Config(Handshake),
    /// `receive` / `update` —— **两者都带一条完整条目**。
    ///
    /// ⚠️ 合成一个变体是刻意的：对**边界与水印**来说它们是同一件事
    /// （都是「一条 id 明确的条目」），分开只会让下面的 `match` 多一个分支、
    /// 而那个分支里的逻辑必须逐字相同。
    ///
    /// ⚠️ `update` 是**原地改正文**：id 不变。所以「改的是不是一条历史」这件事
    /// **由 id 自己回答**（`id <= latestId` 就是历史），不需要另写一套判断。
    ///
    /// ⚠️ 装箱是**必须**的（`clippy::large_enum_variant` 会红）：`ReceiveHolder`
    /// 比其它变体大一个数量级，而这个枚举是**每条消息都要过一遍**的东西 ——
    /// 让 `config` / `revoke` 那些小事件陪着扛一个大结构，是白白的拷贝。
    /// ⚠️ 别用 `#[allow]` 把它压下去（`docs/CONTRIBUTING.md` §4：不许为了让自己的切片过而放宽门禁）。
    Entry(Box<ReceiveHolder>),
    /// 设备进出 / 房间被清空 / 删除 —— 都只影响界面列表。
    DevicesChanged,
    Revoked {
        id: i32,
    },
    Cleared,
    /// `pong`（我们没发 ping，但服务端的 pong 也不该当成未识别）。
    Pong,
    /// 认得出形状、但这边不处理的（`connect` / `disconnect` / 将来新增的）。
    Other(String),
    /// 连 JSON 都不是。
    Malformed,
}

/// 解析一条 WS 文本帧。
#[must_use]
pub fn parse_event(raw: &str) -> WsEvent {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return WsEvent::Malformed;
    };
    let Some(kind) = value.get("event").and_then(Value::as_str) else {
        return WsEvent::Malformed;
    };
    let data = value.get("data").cloned().unwrap_or(Value::Null);

    match kind {
        "config" => WsEvent::Config(parse_handshake(&data)),
        "receive" | "update" => match serde_json::from_value::<ReceiveHolder>(data) {
            Ok(entry) => WsEvent::Entry(Box::new(entry)),
            // ⚠️ 认不出的 `type` → `ReceiveHolder` 会报错（**故意的**，见 protocol 那边的注释）。
            // 这里的处理是**当成未识别丢掉**，不是降级成空文本 —— 静默降级会让一条
            // 文件条目变成一条空文本条目，然后被写进剪贴板（把用户的东西擦掉）。
            Err(_) => WsEvent::Other(format!("unparsable {kind} payload")),
        },
        "connect" | "disconnect" => WsEvent::DevicesChanged,
        "revoke" => WsEvent::Revoked {
            id: data.get("id").and_then(Value::as_i64).unwrap_or(0) as i32,
        },
        "clearAll" => WsEvent::Cleared,
        "pong" => WsEvent::Pong,
        other => WsEvent::Other(other.to_owned()),
    }
}

/// 一条消息该被怎么处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 还没收到 `config` —— **一条都不该写剪贴板**。
    NotReady,
    /// 老服务端（握手不带 `latestId`）→ **拒绝写剪贴板并提示**（fail-safe）。
    NoWatermark,
    /// 历史：**只认领**（进本地列表），不写剪贴板。
    Adopt,
    /// 实时：可以写剪贴板。
    Apply,
    /// 已经处理过（重复投递 / 重连之后的回放）。
    Duplicate,
}

/// 历史与实时的分界线。
///
/// ⚠️★ 它**跨重连存活**（不是每条连接一个新的）：`seen_max` 留着，重连之后
/// 已经处理过的 id 就不会被当成新的再应用一遍。而 `latest_id` 每次握手都会更新
/// （重连那一刻的最大 id 变了）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Boundary {
    ready: bool,
    latest_id: Option<i32>,
    seen_max: Option<i32>,
}

impl Boundary {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 收到握手的 `config`。
    pub fn on_handshake(&mut self, handshake: &Handshake) {
        self.ready = true;
        self.latest_id = handshake.latest_id;
    }

    /// 收到 `config` 了吗。
    #[must_use]
    pub fn ready(&self) -> bool {
        self.ready
    }

    /// 连接时刻的房间最大 id。`None` = 老服务端。
    #[must_use]
    pub fn latest_id(&self) -> Option<i32> {
        self.latest_id
    }

    /// 这条 id 算不算**历史**（`id <= latestId`）。
    ///
    /// ⚠️★ 取历史的结果要用**它**（不是无脑全部）去决定「能不能记成已处理」——
    /// 理由见模块文档那个「飞行窗口」。
    #[must_use]
    pub fn is_history(&self, id: i32) -> bool {
        match self.latest_id {
            Some(latest) => id <= latest,
            None => false,
        }
    }

    /// 记下「这条处理过了」。
    pub fn mark_seen(&mut self, id: i32) {
        self.seen_max = Some(self.seen_max.map_or(id, |seen| seen.max(id)));
    }

    /// 已经处理到的最大 id（诊断 / 测试用）。
    #[must_use]
    pub fn seen_max(&self) -> Option<i32> {
        self.seen_max
    }

    /// 判一条消息该怎么处理，**并推进状态**。
    ///
    /// ⚠️ 只有 `Adopt` / `Apply` 会推进 `seen_max` —— `Duplicate` 不推（它本来就在里面），
    /// `NotReady` / `NoWatermark` 更不能推（那两条的意思是「这次不算数」，
    /// 推了会让同一条消息**之后再也没机会**被处理）。
    pub fn classify(&mut self, id: i32) -> Verdict {
        if !self.ready {
            return Verdict::NotReady;
        }
        let Some(latest) = self.latest_id else {
            return Verdict::NoWatermark;
        };
        if let Some(seen) = self.seen_max
            && id <= seen
        {
            return Verdict::Duplicate;
        }
        self.mark_seen(id);
        if id <= latest {
            Verdict::Adopt
        } else {
            Verdict::Apply
        }
    }
}

/// 下行往界面推的东西。
///
/// ⚠️ **「开关」管的是剪贴板，不是这张列表**：`enable_text_download` 关掉之后，
/// 收到的文本仍然会作为 [`ReceiverUpdate::Entry`] 推上来（界面照常显示），
/// 只是**不写剪贴板**。把两件事混起来的表现是「关掉下载就什么都看不见了」——
/// 而用户想关的只是「别动我的剪贴板」。
#[derive(Debug, Clone)]
pub enum ReceiverUpdate {
    /// 这个房间的历史（**旧的在前**）。全都是**只认领**的，一条都没写进剪贴板。
    History(Vec<ReceiveHolder>),
    /// 新来的一条（已认领或已应用）。
    Entry(Box<ReceiveHolder>),
    /// 一条被删了。
    Revoked { id: i32 },
    /// 房间被清空了。
    Cleared,
    /// 设备列表变了。
    DevicesChanged,
    /// 状态变化（连接中 / 连上了 / 老服务端 / 断了）。
    Status(ReceiverStatus),
}

/// 下行连接的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverStatus {
    /// 正在连（含重连）。
    Connecting { server: String, room: String },
    /// 连上了，知道边界。
    Connected { latest_id: i32 },
    /// ⚠️★ **老服务端**：握手不带 `latestId`，边界说不清 → **一行剪贴板都不写**。
    /// 界面要把这条显示出来（「服务端版本太旧，已暂停同步」），而不是静默不动。
    NoWatermark,
    /// 断了（附原因），`retrying` = 会不会自动重连。
    Disconnected { reason: String },
}

/// 没收到任何 WS 帧多久算「这条连接死了」。
///
/// ⚠️ 服务端每 5 秒发一次 ping（`crates/server/src/ws.rs` 的 `PING_INTERVAL`），
/// 所以 30 秒**一声不吭**就说明连接其实是断的 —— 中间有反代 / NAT 时这是常态
/// （TCP 半开连接不会报错，只会一直静默）。靠它**主动**重连，而不是等下一个写操作失败。
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// 重连退避：1s → 2s → 4s …… 封顶 30s。
const RECONNECT_BASE: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// 握手**不带** `latestId` 时（老服务端）取历史用的条数兜底。
///
/// ⚠️ 这个数只在「读不到服务端 `server.history`」时用 —— 正常路径是照抄握手里那个值。
/// 50 与三端统一的默认值一致（`docs/specs/ws-live-only.md` §2.1）。
const FALLBACK_HISTORY: usize = 50;

/// 建 WS 握手请求（**可测**：它不碰网络）。
///
/// ⚠️★ **凭据走请求头**，不进 URL：进了 URL 就会进服务端访问日志、进反代日志。
pub fn ws_request(server: &str, room: &str, token: Option<&str>) -> Result<Request<()>, String> {
    let url = endpoint::ws_url(server, room)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("构造 WebSocket 握手失败：{e}"))?;

    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| format!("凭据里有非法字符，放不进请求头：{e}"))?;
        request.headers_mut().insert(AUTHORIZATION, value);
    }
    Ok(request)
}

/// 从 `GET /content` 取历史（**只读，不碰剪贴板**）。
pub async fn fetch_history(
    client: &reqwest::Client,
    channel: &Channel,
    limit: usize,
) -> Result<Vec<ReceiveHolder>, String> {
    let url = endpoint::history_url(&channel.server, &channel.room, limit)?;
    let mut request = client.get(url);
    if let Some(token) = channel.auth_token.as_deref().map(str::trim)
        && !token.is_empty()
    {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("取历史失败：{e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(parse_api_error(status, &body));
    }

    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(default)]
        messages: Vec<Value>,
    }
    let envelope: Envelope =
        serde_json::from_str(&body).map_err(|e| format!("历史不是 JSON：{e}"))?;

    // ⚠️ 逐条解析：**一条坏条目不该让整份历史都看不见**（那会让界面直接空掉）。
    Ok(envelope
        .messages
        .into_iter()
        .filter_map(|m| serde_json::from_value::<ReceiveHolder>(m).ok())
        .collect())
}

/// 下行的把手。**drop 它就停**（与 [`crate::WatchHandle`] 同一个形状，
/// 理由也一样：别让任务自己跑，那会让进程退不出去）。
pub struct ReceiverHandle {
    task: tokio::task::JoinHandle<()>,
}

impl ReceiverHandle {
    /// 明确地停掉（与 `drop` 等价，但意图更清楚）。
    pub fn stop(self) {
        self.task.abort();
    }
}

impl Drop for ReceiverHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 起一个下行任务。
///
/// ⚠️ 它**只在「有一个房间开着下行」时**才真的连接（[`ClientConfig::download_channel`]）
/// —— 没开就等着，不连接、不轮询服务端。
#[must_use]
pub fn spawn_receiver(
    cfg: ClientConfig,
    sink: Box<dyn ClipboardSink>,
    debouncer: Arc<Mutex<Debouncer>>,
    updates: tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
) -> ReceiverHandle {
    let task = tokio::spawn(async move {
        run(cfg, sink, debouncer, updates).await;
    });
    ReceiverHandle { task }
}

/// 连接 → 收 → 断了重连，直到任务被 abort。
async fn run(
    cfg: ClientConfig,
    sink: Box<dyn ClipboardSink>,
    debouncer: Arc<Mutex<Debouncer>>,
    updates: tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
) {
    let Ok(client) = build_client() else {
        let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::Disconnected {
            reason: "建 HTTP 客户端失败".to_owned(),
        }));
        return;
    };

    let mut boundary = Boundary::new();
    let mut backoff = RECONNECT_BASE;

    loop {
        // 每次重连都重新看一遍配置 —— 用户可能刚把下行换到别的房间 / 关掉。
        let Some(channel) = cfg.download_channel().cloned() else {
            let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::Disconnected {
                reason: "没有开启「同步到本地」的房间".to_owned(),
            }));
            tokio::time::sleep(RECONNECT_MAX).await;
            continue;
        };

        let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::Connecting {
            server: channel.server.clone(),
            room: channel.room.clone(),
        }));

        match connect_once(
            &client,
            &cfg,
            &channel,
            sink.as_ref(),
            &debouncer,
            &mut boundary,
            &updates,
        )
        .await
        {
            Ok(()) => {
                // 正常断开（服务端重启 / 网络切换）—— 退避从最小开始。
                backoff = RECONNECT_BASE;
            }
            Err(reason) => {
                let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::Disconnected {
                    reason,
                }));
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// 一条连接的生命周期：握手 → 取历史 → 收实时。
async fn connect_once(
    client: &reqwest::Client,
    cfg: &ClientConfig,
    channel: &Channel,
    sink: &dyn ClipboardSink,
    debouncer: &Arc<Mutex<Debouncer>>,
    boundary: &mut Boundary,
    updates: &tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
) -> Result<(), String> {
    let request = ws_request(
        &channel.server,
        &channel.room,
        channel.auth_token.as_deref(),
    )?;

    let (mut stream, _response) = connect_async(request)
        .await
        .map_err(|e| format!("连接失败：{e}"))?;

    // 历史取回来之前**一条都不写剪贴板** —— 所以这里先什么都不做，
    // 等 `config`（它带着边界）到了再说。
    let mut history_requested = false;

    loop {
        let frame = tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await;

        let message = match frame {
            Err(_elapsed) => {
                return Err(format!(
                    "{} 秒没有任何帧，判定连接已断",
                    IDLE_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => return Ok(()), // 对端正常关闭
            Ok(Some(Err(e))) => return Err(format!("读 WebSocket 出错：{e}")),
            Ok(Some(Ok(message))) => message,
        };

        let text = match message {
            Message::Text(text) => text,
            // ⚠️ 二进制帧这边不处理（服务端只发文本）。也**不当成错误** ——
            // 将来服务端加了别的用途时，不该因此把连接断掉。
            Message::Close(_) => return Ok(()),
            _ => continue,
        };

        match parse_event(&text) {
            WsEvent::Config(handshake) => {
                boundary.on_handshake(&handshake);
                match handshake.latest_id {
                    Some(latest_id) => {
                        let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::Connected {
                            latest_id,
                        }));
                    }
                    None => {
                        // ⚠️★ **fail-safe**：边界说不清就**一行都不写**，并让界面说清楚
                        // 为什么（「服务端版本太旧」）。不许退化成「先静默几秒试试」。
                        let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::NoWatermark));
                    }
                }

                if !history_requested {
                    history_requested = true;
                    load_history(client, cfg, channel, &handshake, boundary, updates).await;
                }
            }

            WsEvent::Entry(entry) => {
                let id = entry.id();
                match boundary.classify(id) {
                    Verdict::Duplicate | Verdict::NotReady => {}
                    Verdict::NoWatermark => {
                        // 老服务端 —— 列表照收，剪贴板不碰。
                        let _ = updates.send(ReceiverUpdate::Entry(entry));
                    }
                    Verdict::Adopt => {
                        // 历史：只认领。**不写剪贴板**。
                        let _ = updates.send(ReceiverUpdate::Entry(entry));
                    }
                    Verdict::Apply => {
                        let kind = if entry.is_file() {
                            UploadKind::File
                        } else {
                            UploadKind::Text
                        };
                        if cfg.is_download_enabled(kind) {
                            apply_entry(client, channel, cfg, &entry, sink, debouncer).await;
                        }
                        // ⚠️ 开关关掉也**照推列表** —— 开关管的是剪贴板，不是列表。
                        let _ = updates.send(ReceiverUpdate::Entry(entry));
                    }
                }
            }

            WsEvent::DevicesChanged => {
                let _ = updates.send(ReceiverUpdate::DevicesChanged);
            }
            WsEvent::Revoked { id } => {
                let _ = updates.send(ReceiverUpdate::Revoked { id });
            }
            WsEvent::Cleared => {
                let _ = updates.send(ReceiverUpdate::Cleared);
            }
            WsEvent::Pong | WsEvent::Other(_) | WsEvent::Malformed => {}
        }
    }
}

/// 取历史并**只认领**。
///
/// ⚠️★ 失败**不算致命**：历史取不到（权限、旧服务端没有这个接口）不该让整个下行断掉 ——
/// 实时那部分照样能用。所以这里只推一条状态，不返回错误。
async fn load_history(
    client: &reqwest::Client,
    _cfg: &ClientConfig,
    channel: &Channel,
    handshake: &Handshake,
    boundary: &mut Boundary,
    updates: &tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
) {
    let limit = handshake.history.unwrap_or(FALLBACK_HISTORY);
    let entries = match fetch_history(client, channel, limit).await {
        Ok(entries) => entries,
        Err(reason) => {
            tracing::warn!(%reason, "取历史失败；实时仍然可用");
            let _ = updates.send(ReceiverUpdate::Status(ReceiverStatus::Disconnected {
                reason: format!("取历史失败：{reason}"),
            }));
            return;
        }
    };

    // ⚠️★ **只把 `id <= latestId` 的那些记成「已处理」** —— 见模块文档那个「飞行窗口」。
    // 取历史这段时间里新到的消息 id 更大，它们会走 WS 那条路（要在那儿应用），
    // 这里顺手记掉就会让 WS 那条被判成重复、**丢一条真消息**。
    for entry in &entries {
        if boundary.is_history(entry.id()) {
            boundary.mark_seen(entry.id());
        }
    }
    let _ = updates.send(ReceiverUpdate::History(entries));
}

/// 把一条实时消息**写进本机剪贴板**。
///
/// ⚠️★ **写之前先预置指纹**（[`Debouncer::prime`]）—— 不预置的话，监控线程会把自己
/// 刚写进去的东西当成「用户复制的新内容」，再发回服务端；对端收到又写它自己的剪贴板 ——
/// 两个客户端之间**来回弹**。这就是为什么 watcher 与 receiver 必须**共享**一个 `Debouncer`。
async fn apply_entry(
    client: &reqwest::Client,
    channel: &Channel,
    cfg: &ClientConfig,
    entry: &ReceiveHolder,
    sink: &dyn ClipboardSink,
    debouncer: &Arc<Mutex<Debouncer>>,
) {
    let result = match entry {
        ReceiveHolder::Text(text) => {
            if text.content.is_empty() {
                // 空正文的文本条目（`content` 是 omitempty，所以空正文会**省略这个 key**）
                // 没有东西可写 —— 直接跳过，而不是把剪贴板清空。
                return;
            }
            prime(debouncer, &ClipboardContent::Text(text.content.clone()));
            sink.set_text(&text.content)
        }
        ReceiveHolder::File(file) => match download_file(client, channel, cfg, file).await {
            Ok(path) => {
                prime(debouncer, &ClipboardContent::Files(vec![path.clone()]));
                sink.set_files(&[path])
            }
            Err(reason) => Err(reason),
        },
    };

    if let Err(reason) = result {
        // ⚠️ 只记日志：写剪贴板失败（比如别的程序占着）不该把连接断掉。
        tracing::warn!(%reason, "把收到的内容写进剪贴板失败");
    }
}

/// 预置指纹（防回环）。
fn prime(debouncer: &Arc<Mutex<Debouncer>>, content: &ClipboardContent) {
    debouncer
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .prime(content);
}

/// 下载一个文件条目到下载目录，返回落盘路径。
async fn download_file(
    client: &reqwest::Client,
    channel: &Channel,
    cfg: &ClientConfig,
    file: &clip9_protocol::FileReceive,
) -> Result<PathBuf, String> {
    if file.cache.is_empty() {
        return Err("这条文件条目没有 cache（服务端没给 uuid）".to_owned());
    }
    let url = endpoint::download_url(&channel.server, &file.cache, &file.name)?;

    let mut request = client.get(url);
    if let Some(token) = channel.auth_token.as_deref().map(str::trim)
        && !token.is_empty()
    {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = request.send().await.map_err(|e| format!("下载失败：{e}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(parse_api_error(status, &body));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取下载内容失败：{e}"))?;

    let dir = cfg.download_dir()?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("建不了下载目录 {}：{e}", dir.display()))?;

    let name = download::local_file_name(&file.name, &file.url);
    let path = download::unique_path(&dir, &name, |candidate| candidate.exists());
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("写不了 {}：{e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config_with(latest: Option<i32>) -> Handshake {
        Handshake {
            latest_id: latest,
            history: Some(50),
        }
    }

    // ── 握手解析 ──────────────────────────────────────────────

    /// 握手载荷里**有** `latestId` → 认得出是新服务端；`0` 也是合法值（空房间）。
    #[test]
    fn handshake_reads_latest_id_including_zero() {
        let h = parse_handshake(&json!({"latestId": 137, "server": {"history": 50}}));
        assert_eq!(h.latest_id, Some(137));
        assert_eq!(h.history, Some(50));

        // ⚠️ 空房间给的是 0 —— 判据是**字段存在**，不是「值 > 0」。
        let h = parse_handshake(&json!({"latestId": 0}));
        assert_eq!(h.latest_id, Some(0));
        assert!(Boundary::new().latest_id().is_none());
    }

    /// ⚠️★ 握手里**没有**这个字段 = 老服务端 → `None`（= 后面 fail-safe 的依据）。
    #[test]
    fn handshake_without_latest_id_is_an_old_server() {
        let h = parse_handshake(&json!({"version": "5.0.8", "server": {"history": 50}}));
        assert_eq!(h.latest_id, None);
        // 显式 null 也当成「没有」—— 保守方向是对的。
        let h = parse_handshake(&json!({"latestId": null}));
        assert_eq!(h.latest_id, None);
    }

    // ── 事件解析 ──────────────────────────────────────────────

    #[test]
    fn parses_the_wire_events() {
        assert!(matches!(
            parse_event(r#"{"event":"config","data":{"latestId":3}}"#),
            WsEvent::Config(Handshake {
                latest_id: Some(3),
                ..
            })
        ));

        let text =
            r#"{"event":"receive","data":{"id":9,"type":"text","room":"default","content":"hi"}}"#;
        match parse_event(text) {
            WsEvent::Entry(entry) => match *entry {
                ReceiveHolder::Text(t) => {
                    assert_eq!(t.base.id, 9);
                    assert_eq!(t.content, "hi");
                }
                other => panic!("应当是文本条目，得到 {other:?}"),
            },
            other => panic!("应当是条目事件，得到 {other:?}"),
        }

        // ⚠️ `update`（原地改正文）也解析成同一种东西 —— 边界只看 id。
        let update =
            r#"{"event":"update","data":{"id":9,"type":"text","room":"default","content":"改了"}}"#;
        assert!(matches!(parse_event(update), WsEvent::Entry(_)));

        assert!(matches!(
            parse_event(r#"{"event":"revoke","data":{"id":9}}"#),
            WsEvent::Revoked { id: 9 }
        ));
        assert!(matches!(
            parse_event(r#"{"event":"clearAll","data":{"room":"default"}}"#),
            WsEvent::Cleared
        ));
        assert!(matches!(
            parse_event(r#"{"event":"connect","data":{"id":"d1"}}"#),
            WsEvent::DevicesChanged
        ));
        assert!(matches!(
            parse_event(r#"{"event":"disconnect","data":{"id":"d1"}}"#),
            WsEvent::DevicesChanged
        ));
        assert!(matches!(
            parse_event(r#"{"event":"pong","data":123}"#),
            WsEvent::Pong
        ));
        assert!(matches!(parse_event("不是 JSON"), WsEvent::Malformed));
        assert!(matches!(
            parse_event(r#"{"event":"somethingNew"}"#),
            WsEvent::Other(_)
        ));
    }

    /// ⚠️★ 认不出的条目类型**不能降级成空文本** —— 那会把用户剪贴板擦成空。
    #[test]
    fn an_unknown_entry_type_is_dropped_not_degraded() {
        let bogus = r#"{"event":"receive","data":{"id":1,"type":"weird"}}"#;
        assert!(matches!(parse_event(bogus), WsEvent::Other(_)));

        // 缺 `type` 也是 —— 同样不能猜。
        let missing = r#"{"event":"receive","data":{"id":1,"content":"x"}}"#;
        assert!(matches!(parse_event(missing), WsEvent::Other(_)));
    }

    // ── 边界（这一块是本模块的核心）──────────────────────────

    /// ⚠️★ **还没收到 `config` → 一条都不写。**
    #[test]
    fn nothing_is_applied_before_the_config_arrives() {
        let mut boundary = Boundary::new();
        assert!(!boundary.ready());
        assert_eq!(boundary.classify(1), Verdict::NotReady);
        assert_eq!(boundary.classify(2), Verdict::NotReady);
        assert_eq!(boundary.seen_max(), None, "没处理过的不该被记成处理过");
    }

    /// ⚠️★ **老服务端（握手没有 `latestId`）→ 拒绝写剪贴板**（fail-safe），
    /// 而不是「先静默几秒试试」。
    #[test]
    fn an_old_server_without_a_watermark_refuses_to_write() {
        let mut boundary = Boundary::new();
        boundary.on_handshake(&config_with(None));
        assert!(boundary.ready(), "收到了 config，只是没有水印");
        assert_eq!(boundary.classify(1), Verdict::NoWatermark);
        assert_eq!(boundary.classify(999), Verdict::NoWatermark);
        assert_eq!(
            boundary.seen_max(),
            None,
            "拒绝处理的不该推进 seen_max（否则以后真连上新服务端也补不回来）"
        );
    }

    /// ⚠️★ **边界是精确的**：`id <= latestId` 才算历史。
    /// 连上之后立刻来的那一条（id > latestId）**必须**能被应用 ——
    /// 时间窗方案会在这里把它吞掉（§7 第 10 条验收）。
    #[test]
    fn the_boundary_is_exact_not_a_time_window() {
        let mut boundary = Boundary::new();
        boundary.on_handshake(&config_with(Some(137)));

        // 历史那一段：只认领。
        assert_eq!(boundary.classify(1), Verdict::Adopt);
        assert_eq!(boundary.classify(137), Verdict::Adopt);
        // 边界之后的第一条：应用。
        assert_eq!(boundary.classify(138), Verdict::Apply);
        assert_eq!(boundary.classify(139), Verdict::Apply);
    }

    /// 空房间（`latestId == 0`）：第一条实时消息是 id 1 → 应用。
    #[test]
    fn an_empty_room_applies_the_very_first_message() {
        let mut boundary = Boundary::new();
        boundary.on_handshake(&config_with(Some(0)));
        assert_eq!(boundary.classify(1), Verdict::Apply);
    }

    /// 重复投递 / 重连回放：同样的 id 只处理一次。
    #[test]
    fn the_same_id_is_never_processed_twice() {
        let mut boundary = Boundary::new();
        boundary.on_handshake(&config_with(Some(10)));
        assert_eq!(boundary.classify(11), Verdict::Apply);
        assert_eq!(boundary.classify(11), Verdict::Duplicate);
        assert_eq!(
            boundary.classify(5),
            Verdict::Duplicate,
            "历史回放也不该重复"
        );
    }

    /// ⚠️★ **跨重连**：新握手（更大的 latestId）不该让已经处理过的 id 重新应用一遍。
    #[test]
    fn a_reconnect_does_not_replay_what_was_already_handled() {
        let mut boundary = Boundary::new();
        boundary.on_handshake(&config_with(Some(10)));
        assert_eq!(boundary.classify(11), Verdict::Apply);

        // 断线重连，这时房间最大 id 已经是 20。
        boundary.on_handshake(&config_with(Some(20)));
        assert_eq!(boundary.classify(11), Verdict::Duplicate, "已经应用过了");
        // 断线期间错过的那几条（11 < id <= 20）会在取历史时被认领 —— 见下一条。
        assert_eq!(boundary.classify(15), Verdict::Adopt);
        assert_eq!(
            boundary.classify(21),
            Verdict::Apply,
            "重连之后的新消息照常"
        );
    }

    /// ⚠️★ **飞行窗口**：取历史期间新到的实时消息，**不能**被那次取历史顺手记掉。
    ///
    /// 这是最容易写错的一处：如果 `load_history` 无脑把取回来的每条都 `mark_seen`，
    /// 那么「请求在飞的时候到的 138」会被记成已处理 → 随后 WS 推来的 138 被判成
    /// `Duplicate` → **丢一条真消息**，而且完全静默。
    #[test]
    fn messages_that_arrive_while_history_flies_are_not_eaten() {
        let mut boundary = Boundary::new();
        boundary.on_handshake(&config_with(Some(137)));

        // 取历史的请求已经发出，但响应里带上了 137 与 138（138 是飞行期间新到的）。
        assert!(boundary.is_history(137));
        assert!(
            !boundary.is_history(138),
            "飞行期间新到的不算历史 —— 它得走 WS 那条路被应用"
        );

        // 认领历史那一段（模拟 `load_history` 的循环）。
        for id in [135, 136, 137] {
            if boundary.is_history(id) {
                boundary.mark_seen(id);
            }
        }
        // 138 没被记掉 —— WS 那条路还能应用它。
        assert_eq!(boundary.classify(138), Verdict::Apply);
        assert_eq!(boundary.classify(138), Verdict::Duplicate);
    }

    /// `is_history` 在「还没握手」与「老服务端」两种情况下都返回 false
    /// （= 「不算历史」），这样调用方不会在边界不清时误记。
    #[test]
    fn is_history_is_false_when_the_boundary_is_unknown() {
        let mut boundary = Boundary::new();
        assert!(!boundary.is_history(1), "还没握手时不算历史");

        boundary.on_handshake(&config_with(None));
        assert!(!boundary.is_history(1), "老服务端没有边界可言");
    }

    // ── 握手请求 ──────────────────────────────────────────────

    /// ⚠️★ 凭据走请求头，**不进 URL**（§8 审计清单那条）。
    #[test]
    fn the_ws_request_keeps_credentials_out_of_the_url() {
        let req = ws_request("http://127.0.0.1:9501", "work", Some("s3cr3t")).unwrap();
        assert_eq!(req.uri().path(), "/push");
        assert_eq!(req.uri().query(), Some("room=work"));
        assert!(
            !req.uri().to_string().contains("s3cr3t"),
            "令牌不许出现在 URL 里"
        );
        assert_eq!(
            req.headers()
                .get(AUTHORIZATION)
                .and_then(|v| v.to_str().ok()),
            Some("Bearer s3cr3t")
        );

        // 没有令牌时不带这个头（空字符串也一样）。
        let req = ws_request("http://127.0.0.1:9501", "work", None).unwrap();
        assert!(req.headers().get(AUTHORIZATION).is_none());
        let req = ws_request("http://127.0.0.1:9501", "work", Some("  ")).unwrap();
        assert!(req.headers().get(AUTHORIZATION).is_none());
    }

    /// `ws_request` 也要保住服务端的子路径前缀（§1.1）。
    #[test]
    fn the_ws_request_keeps_the_sub_path() {
        let req = ws_request("https://host/cloud-clipboard", "default", None).unwrap();
        assert_eq!(req.uri().path(), "/cloud-clipboard/push");
        assert_eq!(req.uri().scheme_str(), Some("wss"));
    }

    /// 下载地址是**本地拼**的（用我们配的服务端），不是条目里那个 url。
    #[test]
    fn downloads_are_built_against_our_own_server() {
        let url = endpoint::download_url("http://127.0.0.1:9501", "uuid-1", "报告.pdf").unwrap();
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9501/file/uuid-1/%E6%8A%A5%E5%91%8A.pdf"
        );

        // 名字为空 → 走回退链（`cache`），而不是拼出一个以 `/` 结尾的地址。
        assert_eq!(
            download::local_file_name("", "http://uploader-origin/file/u/x.png"),
            "x.png"
        );
    }
}
