//! 下行（W2）+ **历史与实时的边界**。
//!
//! # 边界为什么要服务端说，而不是客户端猜
//!
//! `dev-docs/specs/desktop-client.md` §4.2 把这件事讲透了，这里是摘要 + 落地：
//!
//! 历史与实时**共用同一个事件名**（`receive`），所以客户端天生分不出来。行为基准
//! （`clip-sync`）只好用**时间窗**兜：连上之后静默 `PRIMING_QUIET_SECS` 秒，
//! 这段时间里的东西只认领不写剪贴板。**但时间窗是猜，两头都会错**：
//!
//! - 历史多 / 网络慢 → 窗口**提前结束** → **历史灌进剪贴板**，覆盖用户正复制着的东西 ✗✗；
//! - 窗口开长 → 连上之后别人马上复制的东西**被吞**（真消息收不到）✗。
//!
//! 所以这里**不猜**：握手 `config` 里的 `latestId`（= 连接时刻该房间的最大消息 id，
//! 见 `dev-docs/specs/ws-live-only.md`）就是那条边界。
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
//! ⚠️ 握手**不再推历史**（`dev-docs/specs/ws-live-only.md` W5）。历史由这边自己去
//! `GET /content` 取 —— 取回来的一律**只认领**（[`Boundary::is_history`]）。
//!
//! ⚠️ 有一个**飞行窗口**要小心：取历史的请求在飞的时候，房间里可能已经推来几条实时消息。
//! 那些消息的 id **大于** `latestId` —— 所以它们**不能**被这次取历史顺手记成「已处理」，
//! 否则 WS 那条会被判成重复、**丢一条真消息**。判据就是 [`Boundary::is_history`]。

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clip9_protocol::ReceiveHolder;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderValue, Request};
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::config::{Channel, ClientConfig};
use crate::debounce::Debouncer;
use crate::download;
use crate::endpoint;
use crate::event::{ClipboardContent, UploadKind};
use crate::msg::Msg;
use crate::sink::ClipboardSink;
use crate::uploader::{ServerLimits, build_client, parse_api_error};

/// 握手 `config` 里这边要的三样东西。
///
/// ⚠️ 只解析需要的字段（`config` 里还有 `auth` / `automation` 等 —— 那些是界面的事）。
///
/// ⚠️★ `limits` 在这里是**刻意的**：`dev-docs/api.md` §3 曾把握手载荷错标成 `/server` 的响应，
/// 而限额**只在这条 `config` 事件里**（`text.limit` / `file.limit`；`version` 同理）。
/// 详见 [`crate::uploader`] 的模块文档。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Handshake {
    /// 连接时刻该房间的**最大消息 id**（空房间是 `0`）。
    ///
    /// `None` = 握手载荷里**没有这个字段** = 老服务端 → fail-safe，见 [`Verdict::NoWatermark`]。
    pub latest_id: Option<i32>,
    /// 服务端的历史长度上限（`server.history`）—— 取历史时用它当 `limit`。
    pub history: Option<usize>,
    /// 服务端的内容限额（上行要用；拿不到就是「不知道」）。
    pub limits: ServerLimits,
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
        limits: ServerLimits::from_ws_config(data),
    }
}

/// 房间里**别人**的一台设备。
///
/// ⚠️★ 只用来画界面那行「N 台在线」（稿 1 里几个圆圈那个）。
/// ⚠️ 服务端**不把本机算进来**（`state.rs` 的 `devices_in_room_except` 就把自己排掉了），
/// 所以这里的列表**永远不含本机** —— 要显示「几台」时得自己加 1，
/// 而「加 1」这件事只有壳知道（它知道自己连没连上）。
///
/// ⚠️ `kind` 的三个取值是服务端 `user_agent.rs` 认出来的
///（`desktop` / `smartphone` / `tablet`，**小写**）—— 界面按它选图标，
/// 不要按 `name` 猜（名字是用户自己起的自由文本）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PeerDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
}

impl PeerDevice {
    /// 从一条 `connect` / `disconnect` 的 `data` 里取设备信息。
    ///
    /// ⚠️ 认不出 `id` 就当**没有**（`None`）：设备进出这件事只能按 id 去重，
    /// 没有 id 就没法回答「这台是不是已经在了」—— 用一个空 id 兜底会让
    /// 所有认不出的设备挤成同一台。
    #[must_use]
    pub fn from_payload(data: &Value) -> Option<Self> {
        let id = data.get("id").and_then(Value::as_str)?;
        if id.is_empty() {
            return None;
        }
        Some(Self {
            id: id.to_owned(),
            // ⚠️ 服务端把 `type` 这个名字给了「设备类型」（`protocol::DeviceMeta` 的
            // `#[serde(rename = "type")]`），所以这里是 `type` 而不是 `kind`。
            kind: data
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            name: data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
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
    /// ⚠️ 别用 `#[allow]` 把它压下去（`dev-docs/CONTRIBUTING.md` §4：不许为了让自己的切片过而放宽门禁）。
    Entry(Box<ReceiveHolder>),
    /// 一台设备进/出了这个房间。
    ///
    /// ⚠️★ 这里**必须**带上是谁：老版本把它当成一个「变了」的信号就丢了，
    /// 于是界面只能画「有人进出了」而画不出**几台在线** ——
    /// 而稿 1 的那行设备（`3 台在线`）要的正是后者。
    /// `device: None` = 认不出 payload（不是本机），照旧只当信号用。
    DevicesChanged {
        device: Option<PeerDevice>,
        joined: bool,
    },
    Revoked {
        id: i32,
    },
    Cleared,
    /// `pong` —— 我们发的应用层 ping 的回声。
    ///
    /// ⚠️★ `echoed` 是**我们放进 `data` 的那个数**（服务端原样回显）。
    /// 带上它是为了让「哪一次 ping 回来了」可判 —— 不判的话，一次迟到的 pong
    /// 会被当成刚发那次 ping 的应答，算出一个偏小的假延迟。
    /// ⚠️ 认不出（不是数字）就是 `None`：**不当成我们的那次**。
    Pong {
        echoed: Option<u64>,
    },
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
        "connect" | "disconnect" => WsEvent::DevicesChanged {
            device: PeerDevice::from_payload(&data),
            joined: kind == "connect",
        },
        "revoke" => WsEvent::Revoked {
            id: data.get("id").and_then(Value::as_i64).unwrap_or(0) as i32,
        },
        "clearAll" => WsEvent::Cleared,
        "pong" => WsEvent::Pong {
            echoed: data.as_u64(),
        },
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

/// 下行往界面推的**一件事**。
///
/// ⚠️ **「开关」管的是剪贴板，不是这张列表**：`enable_text_download` 关掉之后，
/// 收到的文本仍然会作为 [`ReceiverEvent::Entry`] 推上来（界面照常显示），
/// 只是**不写剪贴板**。把两件事混起来的表现是「关掉下载就什么都看不见了」——
/// 而用户想关的只是「别动我的剪贴板」。
#[derive(Debug, Clone)]
pub enum ReceiverEvent {
    /// 这个房间的历史（**旧的在前**）。全都是**只认领**的，一条都没写进剪贴板。
    History(Vec<ReceiveHolder>),
    /// 新来的一条（已认领或已应用）。
    Entry(Box<ReceiveHolder>),
    /// ⚠️★ 这一条**刚刚写进本机剪贴板**了（实时、且这个房间与这类内容的 ↓ 都开着）。
    ///
    /// ⚠️ 与 [`ReceiverEvent::Entry`] **分成两条**而不是给它加个字段：那条事件的语义是
    /// 「列表里多了一条」，而它**不受 ↓ 的影响**（关掉 ↓ 也照推，见这个枚举的模块注释）。
    /// 两件事挤进一个结构里，界面迟早会把「没写剪贴板」画成「没收到」。
    ///
    /// ⚠️★ 为什么由**这里**报、而不是让上层自己判「该不该写剪贴板」：判据在本文件里
    /// （房间的 ↓ + 这类内容的 ↓ + [`Verdict`]），上层再写一遍就是**第二份定义**，
    /// 而两份一定会漂（漂的方向是「通知说写了、其实没写」这种没人会发现的谎）。
    ///
    /// ⚠️ 它**不改变任何列表状态** —— 桌面壳拿它发系统通知，列表由 `Entry` 那条管。
    WroteToClipboard(Box<ReceiveHolder>),
    /// 一条被删了。
    Revoked { id: i32 },
    /// 房间被清空了。
    Cleared,
    /// 设备列表变了。⚠️ **只含别人**（服务端不把本机算进来）。
    ///
    /// ⚠️★ 给的是**整份列表**，不是「谁进 / 谁出」：界面要画的是「现在有几台」，
    /// 让它自己维护一个集合 = 在界面上再存一份会漂的状态（而漂了不报错，只是数字不对）。
    DevicesChanged(Vec<PeerDevice>),
    /// 这条连接的**往返延迟**变了（§4.3）。
    Latency(Latency),
    /// 状态变化（连接中 / 连上了 / 老服务端 / 断了）。
    Status(ReceiverStatus),
}

/// 推上来的一件事 **+ 它属于哪个房间**。
///
/// ⚠️★ 为什么要带房间：**每个房间各自有一条连接**（§4.7），所以
/// 「这条历史 / 这条延迟 / 这条状态是谁的」**不再是隐含的** ——
/// 原来那个「只有一个下行房间」的前提**已经不存在了**，
/// 而少了房间名，N 条连接的状态会互相覆盖（界面上的表现是数字乱跳）。
///
/// ⚠️★★ 而且**光有房间名还不够**（2026-09-27 修的）：**不同服务端上可以有同名房间**。
/// 实测踩到：房间清单里同时有 `default@127.0.0.1:9502` 和 `default@example.com`，
/// 而壳那边是「**按房间名**找下标」→ 两条连接的更新**全都落进第一个同名房间**：
/// 公网那条的 401 被挂到了**本地那个房间**的状态栏上（用户看到的正是
/// 「本地这个房间明明连着、却显示 401」），取回的历史也会串到别人家的房间里。
/// 所以身份是 **(服务端, 房间)** 两样 —— 与 `store` 里 `room_key` 用的是同一条规则。
#[derive(Debug, Clone)]
pub struct ReceiverUpdate {
    /// 这条更新属于**哪个服务端上的**房间（身份的一半，别省）。
    pub server: String,
    pub room: String,
    pub event: ReceiverEvent,
}

/// 一个**只属于某个房间**的发送口 —— 每条连接任务一个。
///
/// ⚠️★ 包一层是为了「**不可能忘**」：每个任务只服务一个房间，
/// 让房间身份在构造时绑定一次，比在几十处 `send` 上各写一遍可靠得多
///（漏写一处就是「状态挂到了别的房间上」，而且不报错）。
///
/// ⚠️ 绑的是 **(服务端, 房间)** 两样 —— 只绑房间名就是上面那个串台 bug 的形状。
struct RoomSink {
    server: String,
    room: String,
    updates: tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
}

impl RoomSink {
    fn send(&self, event: ReceiverEvent) {
        // ⚠️ 收端没了（壳正在退出）不是错误 —— 与原来那些 `let _ =` 同一个口径。
        let _ = self.updates.send(ReceiverUpdate {
            server: self.server.clone(),
            room: self.room.clone(),
            event,
        });
    }
}

/// 下行连接的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverStatus {
    /// 正在连（含重连）。
    Connecting { server: String, room: String },
    /// 连上了，知道边界了。`limits` 是服务端限额（**上行要用**，见 [`crate::uploader`]）。
    Connected {
        latest_id: i32,
        limits: ServerLimits,
    },
    /// ⚠️★ **老服务端**：握手不带 `latestId`，边界说不清 → **一行剪贴板都不写**。
    /// 界面要把这条显示出来（「服务端版本太旧，已暂停同步」），而不是静默不动。
    NoWatermark,
    /// ⚠️★ **连上了、边界也知道，但历史没取到**（凭据不对 / 网络 / 旧服务端没这个接口）。
    ///
    /// ⚠️ 这个变体存在的理由是「原来那条是**假话**」：历史取不到时原来发的是 `Disconnected`，
    /// 而**连接明明是好的** —— 实时照常在收。界面于是画成「已断开」，用户看到「已断开」
    /// 却还在收消息；`load_history` 的文档注释本来就写着「失败不算致命…不该让整个下行断掉」，
    /// 那条注释与当时的实现是**相反**的（2026-09-27 修）。
    HistoryUnavailable { latest_id: i32, reason: Msg },
    /// 断了（附原因），`retrying` = 会不会自动重连。
    Disconnected { reason: Msg },
}

/// 房间的**往返延迟**（设计稿 `desktop-client.md` §4.3）。
///
/// ⚠️★ 三个取值都是必要的，**不能压成一个 `Option<u32>`**：
/// 「还不知道」与「超时」是两件事，而「超时」**绝不能**画成一个很大的数字 ——
/// 那看起来只是「慢」，而真相是这条连接其实已经坏了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Latency {
    /// 还没测到（刚连上 / 刚重连，第一次 ping 还没回来）。
    Unknown,
    /// 最近几次的**中位数**（毫秒）。⚠️ 是中位数，不是单次 —— 见 [`LatencyTracker`]。
    Rtt(u32),
    /// 有 ping 没回来。
    Timeout,
}

/// 没收到任何 WS 帧多久算「这条连接死了」。
///
/// ⚠️ 服务端每 5 秒发一次 ping（`rust/crates/server/src/ws.rs` 的 `PING_INTERVAL`），
/// 所以 30 秒**一声不吭**就说明连接其实是断的 —— 中间有反代 / NAT 时这是常态
/// （TCP 半开连接不会报错，只会一直静默）。靠它**主动**重连，而不是等下一个写操作失败。
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// 重连退避：1s → 2s → 4s …… 封顶 30s。
/// **握手**的超时。
///
/// ⚠️★ 没有它的话，一个「TCP 连上了、但 WebSocket 升级永远不回来」的对端会让这个房间
/// **永久停在「连接中」** —— 而那是这个功能最难查的一种失败：
/// 界面上既没有错、也没有原因，看起来只是「慢」。
///
/// ⚠️ 为什么真的会发生：Cloudflare 那边 `/push` 是转发给 Durable Object 的，
/// DO 不响应时那个请求就**挂在那儿**（不返回、也不报错）。自建服务端上也可能
/// 被中间的设备吞掉。2026-10-07 实测到过这个状态。
///
/// ⚠️ 它只包住**握手**，不包住连上之后的长连接 —— 那个由 [`IDLE_TIMEOUT`] 管
///（30 秒没有任何帧就判死）。两个超时管的是两件事，别合并。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

const RECONNECT_BASE: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// 应用层 ping 的间隔（§4.3）。
///
/// ⚠️ 它是**为了显示延迟**，不是为了保活 —— 保活服务端每 5 秒自己在做
///（`ws.rs` 的 `PING_INTERVAL`，那是**协议级**的 `Ping` 帧，和这个不是一回事）。
/// 跟着那个节奏就够，别每秒打一条（那是在给自己的服务端加无谓的负载）。
const PING_INTERVAL: Duration = Duration::from_secs(5);

/// 一次 ping 多久没回来就算**超时**（§4.3 第 4 条）。
///
/// ⚠️ 必须**明显小于** [`IDLE_TIMEOUT`]：超时是「延迟测不到」的结论，
/// 而 IDLE_TIMEOUT 是「连接死了、要重连」的结论。两个一样大的话，
/// 界面还没说出「超时」，连接就已经被拆了 —— 用户看不到任何解释。
const PING_TIMEOUT: Duration = Duration::from_secs(10);

/// 延迟取最近几次的中位数（§4.3 第 3 条）。
const RTT_SAMPLES: usize = 5;

/// 延迟的采样器。
///
/// ⚠️★ 三条规则（§4.3 第 3、4 条，都是「不这么做就会骗人」的那种）：
///
/// 1. **取中位数，不是单次**：单次 RTT 会跳（GC / 调度 / Wi-Fi），
///    直接画的话数字会自己抖得像坏了 —— 而用户会去查网络，其实网络没事。
/// 2. **超时就说超时**，不画一个很大的数字：`9999ms` 看起来只是「慢」，
///    而真相是这条连接其实已经坏了。
/// 3. **样本有界**：只留最近几次 —— 内存有界，而且「刚重连之后」不该被
///    很久以前的样本拖着（那时网络环境可能已经换了）。
///
/// ⚠️ 时间用**单调毫秒**（调用方从一个 `Instant` 起算），不用墙上时间：
/// 墙上时间会被 NTP 校正 / 用户改系统时间跳一下，那一跳会算出一个**负的**或者
/// 离谱的 RTT —— 而它看起来像「网络坏了」。这里用 `saturating_sub` 兜住负值。
#[derive(Debug, Default)]
struct LatencyTracker {
    samples: VecDeque<u32>,
    /// 发出去了、还没回来的那一次的标记（`None` = 没有在等的）。
    pending: Option<u64>,
    /// 有一次 ping 超时了。
    timed_out: bool,
}

impl LatencyTracker {
    /// 刚发了一次 ping。`stamp` 既是放进 `data` 的那个数，也是回来时认它的凭据。
    fn on_sent(&mut self, stamp: u64) {
        self.pending = Some(stamp);
        // ⚠️ 重新发就说明连接还在动 —— 把上一次的超时结论清掉。
        self.timed_out = false;
    }

    /// 收到一个 pong。返回**值有没有变**（变了才需要推给上层）。
    ///
    /// ⚠️★ `echoed` 对不上时**只返回 false，不动 `pending`** ——
    /// 顺手把 `pending` 清掉的话，真正的那个 pong 回来时会被当成「我们没在等」丢掉，
    /// 于是这一轮**既没有数字、也不会判超时**：延迟就那么没了，而且不报错。
    /// ⚠️ 这个 bug 是 `a_pong_that_is_not_ours_is_ignored` 那条测试抓出来的。
    fn on_pong(&mut self, now_ms: u64, echoed: Option<u64>) -> bool {
        let before = self.value();
        let Some(stamp) = self.pending else {
            return false;
        };
        if echoed != Some(stamp) {
            // ⚠️ 不是我们在等的那一次（可能是上一次的迟到回声，或者服务端发了别的
            // 东西）—— 拿它算会得到一个偏小的假延迟。
            return false;
        }
        self.pending = None;
        self.samples.push_back(rtt_ms(stamp, now_ms));
        while self.samples.len() > RTT_SAMPLES {
            self.samples.pop_front();
        }
        self.timed_out = false;
        self.value() != before
    }

    /// 每次 ping 的节拍上问一句：**上一次是不是等太久了**。
    /// 返回**值有没有变**。
    fn on_tick(&mut self, now_ms: u64) -> bool {
        let before = self.value();
        if let Some(stamp) = self.pending
            && now_ms.saturating_sub(stamp) > PING_TIMEOUT.as_millis() as u64
        {
            // ⚠️ 把 `pending` 清掉：不清的话下一拍会再判一次「超时」，
            // 而那时其实已经重新发过 ping 了。
            self.pending = None;
            self.timed_out = true;
        }
        self.value() != before
    }

    /// 有没有一次 ping 还在等。
    fn waiting(&self) -> bool {
        self.pending.is_some()
    }

    fn value(&self) -> Latency {
        if self.timed_out {
            return Latency::Timeout;
        }
        match median(&self.samples) {
            Some(ms) => Latency::Rtt(ms),
            None => Latency::Unknown,
        }
    }
}

/// 从某个起点算起的**单调**毫秒数。
///
/// ⚠️★ 用 `Instant` 而不是墙上时间：RTT 是「两个时刻之间的差」，
/// 而墙上时间会被 NTP 校正 / 用户改系统时间**跳一下** —— 那一跳会算出一个
/// 负的或者离谱的延迟，看起来像「网络坏了」，而网络其实没事。
fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// 一次往返的毫秒数。⚠️ `saturating_sub`：单调钟下不该出现负数，
/// 但真出现了也不该 panic（那会让整条下行任务挂掉）。
fn rtt_ms(stamp: u64, now_ms: u64) -> u32 {
    u32::try_from(now_ms.saturating_sub(stamp)).unwrap_or(u32::MAX)
}

/// 中位数。空集合是 `None`。偶数个取中间两个的平均。
fn median(samples: &VecDeque<u32>) -> Option<u32> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted: Vec<u32> = samples.iter().copied().collect();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    Some(if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        // ⚠️ 用 `u32` 的加法再除：样本都是毫秒级的，不会溢出。
        (sorted[mid - 1] + sorted[mid]) / 2
    })
}

/// 握手**不带** `latestId` 时（老服务端）取历史用的条数兜底。
///
/// ⚠️ 这个数只在「读不到服务端 `server.history`」时用 —— 正常路径是照抄握手里那个值。
/// 50 与三端统一的默认值一致（`dev-docs/specs/ws-live-only.md` §2.1）。
const FALLBACK_HISTORY: usize = 50;

/// 建 WS 握手请求（**可测**：它不碰网络）。
///
/// ⚠️★ **凭据走请求头**，不进 URL：进了 URL 就会进服务端访问日志、进反代日志。
pub fn ws_request(server: &str, room: &str, token: Option<&str>) -> Result<Request<()>, Msg> {
    let url = endpoint::ws_url(server, room)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|err| Msg::key("wsHandshakeBuildFailed").param("reason", err))?;

    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|err| Msg::key("credentialHeaderInvalid").param("reason", err))?;
        request.headers_mut().insert(AUTHORIZATION, value);
    }
    Ok(request)
}

/// 从 `GET /content` 取历史（**只读，不碰剪贴板**）。
///
/// ⚠️ 解析那半截在 [`parse_history_body`] 里（那是「投影 ↔ 解析」的接缝，要单独测）。
pub async fn fetch_history(
    client: &reqwest::Client,
    channel: &Channel,
    limit: usize,
) -> Result<Vec<ReceiveHolder>, Msg> {
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
        .map_err(|err| Msg::key("historyFailed").param("reason", err))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(Msg::verbatim(parse_api_error(status, &body)));
    }
    parse_history_body(&body)
}

/// 把 `/content` 的响应体解析成条目。
///
/// ⚠️★★ **单独一个函数，是因为它是「服务端投影 ↔ 客户端解析」那道接缝**（2026-09-27 补）。
/// 这两半原来**各测各的**：服务端对着 Go 导出的 fixture 逐字比投影
///（`rust/crates/server/tests/content_projection.rs`），客户端只拿手写的小样本测自己 ——
/// 而**中间那道缝从来没人测过**。于是它一直错着，而且错得完全无声：
///
/// ⚠️★ 两个类型对不上（`/content` 是**给前端直接渲染用的投影**，不是 WS 载荷本身）：
/// 1. **`id` 是字符串** —— Go 那边 `strconv.Itoa(msg.Data.ID())`，
///    `cases/protocol/content_list.json` 里就写着 `"id":"7"`；而 WS `receive` 载荷里是数字。
///    同一个字段、两套类型。`ReceiveHolder` 认的是数字（`base.id: i32`）→ **每一条都失败**；
/// 2. **`type` 是展示类型** —— 文件条目在这里是 `image` / `video` / `document` /
///    `archive` / `audio`（Go 的 `DetermineResponseType` 按文件名推），
///    而 `ReceiveHolder` 只认 `text` / `file` → **图片、视频、文档那几类整类读不进来**。
///
/// 合起来的症状：服务端那个房间明明有二十几条，桌面端的时间线**一条都没有**
///（用户 2026-09-27 报的「重启客户端也没有历史」就是这个），而且**没有一个字报错** ——
/// 因为下面那句「一条坏条目不该让整份历史都看不见」把失败全 `ok()` 掉了。
/// ⚠️ 所以这次顺手把**丢掉的条数**打进日志：没有这一句，同样的事还能再藏几个月。
fn parse_history_body(body: &str) -> Result<Vec<ReceiveHolder>, Msg> {
    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(default)]
        messages: Vec<Value>,
    }
    let envelope: Envelope = serde_json::from_str(body)
        .map_err(|err| Msg::key("historyNotJson").param("reason", err))?;

    let total = envelope.messages.len();
    let mut reasons: Vec<String> = Vec::new();
    let entries: Vec<ReceiveHolder> = envelope
        .messages
        .into_iter()
        .filter_map(|raw| {
            match serde_json::from_value::<ReceiveHolder>(normalize_history_entry(raw)) {
                Ok(entry) => Some(entry),
                Err(err) => {
                    reasons.push(err.to_string());
                    None
                }
            }
        })
        .collect();

    if !reasons.is_empty() {
        // ⚠️ 只报**第一条**理由：一整页同形时刷屏毫无意义，而第一条就够定位了。
        tracing::warn!(
            dropped = reasons.len(),
            total,
            reason = %reasons.first().unwrap_or(&String::new()),
            "有些历史条目读不进来，已跳过"
        );
    }
    Ok(entries)
}

/// 把 `/content` 那一条里**类型对不上**的字段归一化成 `ReceiveHolder` 认的形状。
///
/// ⚠️ 两处，理由见 [`parse_history_body`]：`id`（字符串 → 数字）与 `type`（展示类型 → `file`）。
///
/// ⚠️★ `type` 的判据是「**带 `name` 的就不是文本**」，不是把六个展示类型列全：
/// 那个集合在 Go 那边**会长的**（`DetermineResponseType` 的注释就写着
/// "Add more MIME type to category mappings as needed"）—— 列全了，下次加一类就静默漏掉。
/// ⚠️ 归一化成 `file` **不会丢信息**：客户端本来就从文件名自己推展示方式
///（`EntryView::from_holder` 只管 `text` / `file`，图片预览靠 `preview_url`）。
///
/// ⚠️ 解析不出来（`id` 不是数字等）就**原样返回**，让它在下游被当成「读不进来的那一条」报出来 ——
/// 不在这里补一个 0：那会变成一条 **id 错**的记录挂在时间线上，比丢掉更难查。
fn normalize_history_entry(mut raw: Value) -> Value {
    let Some(fields) = raw.as_object_mut() else {
        return raw;
    };
    if let Some(id) = fields.get("id").and_then(Value::as_str)
        && let Ok(number) = id.parse::<i32>()
    {
        fields.insert("id".to_owned(), Value::from(number));
    }
    if !matches!(fields.get("type").and_then(Value::as_str), Some("text"))
        && fields.contains_key("name")
    {
        fields.insert("type".to_owned(), Value::from("file"));
    }
    raw
}

/// 下行的把手。**drop 它就停**（与 [`crate::WatchHandle`] 同一个形状，
/// 理由也一样：别让任务自己跑，那会让进程退不出去）。
pub struct ReceiverHandle {
    /// ⚠️ 每个房间一个任务（见 [`spawn_receiver`]）。
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl ReceiverHandle {
    /// 明确地停掉（与 `drop` 等价，但意图更清楚）。
    pub fn stop(self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Drop for ReceiverHandle {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// 给**每个房间**起一条下行连接。
///
/// ⚠️★ **连接与 ↑/↓ 无关**（Jonny 2026-09-26：「下载本就不应该控制房间的任何功能，
/// 也就是监听剪贴板关闭了，也不影响本地客户端的功能」）。原来只在「有一个房间开着
/// 下行」时才连 —— 那个模型的后果是：把 ↓ 关掉之后**客户端一个连接都没有**，
/// 于是设备行、延迟、实时消息、历史**全部消失**，看起来像「连不上」。
///
/// 现在的模型（§4.7）：
/// - **每个房间各自一条连接** —— 连接是「我在这个房间里」这件事，不是「我要收它」；
/// - `enable_upload` 只决定「本机剪贴板的变化要不要发过去」；
/// - `enable_download` 只决定「它实时来的内容要不要写进本机剪贴板」；
/// - 两个都关时：**照常连着**，看得到设备、延迟、历史，但没有任何东西在流。
///
/// ⚠️ 代价是**连接数 = 房间数**。对 1~3 个房间是毫厘，而它换来的是
/// 「关掉一个开关不会让整个客户端看起来坏了」。
///
/// ⚠️ `cfg` 是**一份快照**：改配置要重新调它（`Runtime::restart_receiver`），
/// 这会让所有房间重连一次 —— 见 `desktop/src/runtime.rs` 里那句注释。
#[must_use]
pub fn spawn_receiver(
    cfg: ClientConfig,
    sink: Box<dyn ClipboardSink>,
    debouncer: Arc<Mutex<Debouncer>>,
    updates: tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
) -> ReceiverHandle {
    // ⚠️ 一个 sink 要分给 N 个任务 → 得是 `Arc`（`Box<dyn T>` → `Arc<dyn T>` 是免费的）。
    // `ClipboardSink: Send + Sync`，所以共享它是安全的。
    let sink: Arc<dyn ClipboardSink> = sink.into();
    let mut tasks = Vec::with_capacity(cfg.channels.len());
    for channel in cfg.channels.clone() {
        let cfg = cfg.clone();
        let sink = Arc::clone(&sink);
        let debouncer = Arc::clone(&debouncer);
        let updates = updates.clone();
        tasks.push(tokio::spawn(async move {
            run_room(cfg, channel, sink, debouncer, updates).await;
        }));
    }
    ReceiverHandle { tasks }
}

/// 一个房间的连接：连 → 收 → 断了重连，直到任务被 abort。
async fn run_room(
    cfg: ClientConfig,
    channel: Channel,
    sink: Arc<dyn ClipboardSink>,
    debouncer: Arc<Mutex<Debouncer>>,
    updates: tokio::sync::mpsc::UnboundedSender<ReceiverUpdate>,
) {
    let updates = RoomSink {
        server: channel.server.clone(),
        room: channel.room.clone(),
        updates,
    };

    // ⚠️ 把 `build_client()` 那**一整句话**原样递上去（它自己就是一条 `Msg`）——
    //    在这里另写一句「建 HTTP 客户端失败」就是第二份定义，两份一定会漂。
    let client = match build_client() {
        Ok(client) => client,
        Err(reason) => {
            updates.send(ReceiverEvent::Status(ReceiverStatus::Disconnected {
                reason,
            }));
            return;
        }
    };

    // ⚠️ 边界（水印）**每个房间各一份** —— 它是「这个房间里哪些是历史」的判据，
    // 跨房间共用的话一个房间的历史会被当成另一个房间的实时消息。
    let mut boundary = Boundary::new();
    let mut backoff = RECONNECT_BASE;

    loop {
        updates.send(ReceiverEvent::Status(ReceiverStatus::Connecting {
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
                updates.send(ReceiverEvent::Status(ReceiverStatus::Disconnected {
                    reason,
                }));
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// 把握手失败翻译成**一句能照做的话**。
///
/// ⚠️★ 为什么不能只写 `format!("连接失败：{e}")`：服务端在**升级之前**拒绝时，
/// `tungstenite` 给的 `Display` 只有「HTTP error: 401 Unauthorized」——
/// 用户看到的是一句「401」，**看不出下一步该做什么**（2026-09-27 实测：
/// 一台公网部署设了全局密码，`/push` 401 而 `/content` 200，界面只显示「401」）。
///
/// ⚠️ 这个项目和「服务端给了带原因的那句话，就**照抄它**」是有明确规矩的
/// （`uploader::parse_api_error`，S1 那轮还专门钉过一条测试）：握手这条不是例外 ——
/// 服务端的 401 body 就是我们的契约 JSON，`message` 里写着「需要认证令牌」。
///
/// ⚠️ 401 / 403 上**再补一句去哪儿填凭据**：界面里确实有「凭据」那一列
/// （`设置 → 房间`），但没人会从「401」联想到「去那一列填东西」。
///
/// ⚠️ 文案里**不要写 Markdown 的 `**`**：界面那边是 `textContent`（见 `ui/app.js`
/// 的 `h()`），星号会**原样显示**给用户。要强调就用「」把它包起来。
fn handshake_error(err: WsError) -> Msg {
    let WsError::Http(response) = &err else {
        return Msg::key("connectFailed").param("reason", err);
    };
    let status = response.status().as_u16();
    let body = response
        .body()
        .as_deref()
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let detail = parse_api_error(status, &body);
    if status == 401 || status == 403 {
        return Msg::key("connectNeedsCredentials").param("detail", detail);
    }
    Msg::key("connectRejected").param("detail", detail)
}

/// 一条连接的生命周期：握手 → 取历史 → 收实时。
async fn connect_once(
    client: &reqwest::Client,
    cfg: &ClientConfig,
    channel: &Channel,
    sink: &dyn ClipboardSink,
    debouncer: &Arc<Mutex<Debouncer>>,
    boundary: &mut Boundary,
    updates: &RoomSink,
) -> Result<(), Msg> {
    let request = ws_request(
        &channel.server,
        &channel.room,
        channel.auth_token.as_deref(),
    )?;

    // ⚠️★ **握手必须有超时**（见 [`HANDSHAKE_TIMEOUT`]）：没有它的话，
    // 一个「连上了但不升级」的对端会让这个房间永久停在「连接中」，
    // 而界面上既没有错、也没有原因。
    // ⚠️ 这里**不要** `mut`：下一句 `split()` 会把它整个吃掉（`split` 取 `self`）。
    let (socket, _response) = tokio::time::timeout(HANDSHAKE_TIMEOUT, connect_async(request))
        .await
        .map_err(|_| Msg::key("connectTimedOut").param("seconds", HANDSHAKE_TIMEOUT.as_secs()))?
        .map_err(handshake_error)?;

    // 历史取回来之前**一条都不写剪贴板** —— 所以这里先什么都不做，
    // 等 `config`（它带着边界）到了再说。
    let mut history_requested = false;

    // 房间里的**别人**（本机不在里面，见 [`PeerDevice`] 的文档）。
    // ⚠️★ 用 `BTreeMap` 按 id 去重，不是 `Vec`：服务端在「同一台设备的**最后一个**
    // 连接断开」时才广播 `disconnect`（`state.rs`），所以一台设备开两个标签页
    // 会来两条 `connect` —— 用列表的话它会在界面里算成两台。
    // ⚠️ `BTreeMap` 顺带给了**稳定顺序**（按 id）：界面那行圆圈不会每次重画都换位置。
    let mut peers: BTreeMap<String, PeerDevice> = BTreeMap::new();

    // ── 从这儿开始要**既能读又能写**（要发应用层 ping，§4.3）─────────────
    // ⚠️★ 必须 `split()`：`select!` 的两个分支都要可变借用这个 socket，
    // 不拆开的话借用检查直接不过（而「用一个任务专门发 ping」会更糟：
    // 那条任务要独立持有 sink，两半之间的时序就说不清了）。
    // 服务端那边是同一个写法（`ws.rs`）。
    // ⚠️★ 名字**不能叫 `sink`** —— 那个名字是本函数的参数（`&dyn ClipboardSink`，
    // 往剪贴板写的那一个）。遮蔽它的话 `apply_entry` 会拿到 WS 的写半边，
    // 于是**下行再也写不进剪贴板**，而且编译报的是一句看不懂的类型错。
    let (mut ws_out, mut ws_in) = socket.split();

    // 单调钟的起点。⚠️ 用它算 RTT，**不用墙上时间**（见 [`LatencyTracker`]）。
    let started = Instant::now();
    let mut latency = LatencyTracker::default();

    // ⚠️ `interval` 的第一次 `tick()` **立刻**就绪 —— 对 ping 来说这没问题
    //（刚连上先测一次，界面能更快看到数字）。
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut idle = tokio::time::interval(IDLE_TIMEOUT);
    idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // 最后一次**听到任何帧**的时刻（协议级的 Ping 也算）。
    // ⚠️ 原来是 `timeout(IDLE_TIMEOUT, stream.next())` 直接把超时套在读上 ——
    // 加了 ping 分支之后那样不行了：ping 每 5 秒完成一次 `select!`，
    // 会把那个超时**反复重置**，于是「30 秒没声音就判死」永远不会触发。
    let mut last_frame = Instant::now();

    loop {
        let message = tokio::select! {
            frame = ws_in.next() => {
                last_frame = Instant::now();
                match frame {
                    None => return Ok(()), // 对端正常关闭
                    Some(Err(err)) => {
                        return Err(Msg::key("wsReadFailed").param("reason", err));
                    }
                    Some(Ok(message)) => message,
                }
            }

            _ = ping.tick() => {
                let now_ms = elapsed_ms(started);
                // ⚠️ 上一次还没回来就**不再发**：连着发会让「哪一次超时了」说不清，
                // 而且会把样本搅浑（一次延迟会被算成好几条）。
                if !latency.waiting() {
                    let payload = json!({ "event": "ping", "data": now_ms });
                    if ws_out.send(Message::Text(payload.to_string().into())).await.is_err() {
                        return Err(Msg::key("wsPingFailed"));
                    }
                    latency.on_sent(now_ms);
                }
                // ⚠️ 顺序要紧：先发/后判超时，这一拍才既发了新的、又结清了旧的。
                latency.on_tick(now_ms);
                updates.send(ReceiverEvent::Latency(latency.value()));
                continue;
            }

            _ = idle.tick() => {
                if last_frame.elapsed() >= IDLE_TIMEOUT {
                    return Err(
                        Msg::key("wsIdleTimeout").param("seconds", IDLE_TIMEOUT.as_secs()),
                    );
                }
                continue;
            }
        };

        let text = match message {
            Message::Text(text) => text,
            // ⚠️ 二进制帧这边不处理（服务端只发文本）。也**不当成错误** ——
            // 将来服务端加了别的用途时，不该因此把连接断掉。
            Message::Close(_) => return Ok(()),
            // ⚠️ 协议级的 `Ping` / `Pong` 走这条 —— 上面那个 `last_frame`
            // 已经把它们算成「听到了」，这里不用再做别的。
            _ => continue,
        };

        match parse_event(&text) {
            WsEvent::Config(handshake) => {
                boundary.on_handshake(&handshake);
                match handshake.latest_id {
                    Some(latest_id) => {
                        updates.send(ReceiverEvent::Status(ReceiverStatus::Connected {
                            latest_id,
                            limits: handshake.limits,
                        }));
                    }
                    None => {
                        // ⚠️★ **fail-safe**：边界说不清就**一行都不写**，并让界面说清楚
                        // 为什么（「服务端版本太旧」）。不许退化成「先静默几秒试试」。
                        updates.send(ReceiverEvent::Status(ReceiverStatus::NoWatermark));
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
                        updates.send(ReceiverEvent::Entry(entry));
                    }
                    Verdict::Adopt => {
                        // 历史：只认领。**不写剪贴板**。
                        updates.send(ReceiverEvent::Entry(entry));
                    }
                    Verdict::Apply => {
                        let kind = if entry.is_file() {
                            UploadKind::File
                        } else {
                            UploadKind::Text
                        };
                        // ⚠️★ 两个条件都要满足才写剪贴板：
                        // ① **这个房间**的 ↓ 开着（`channel.enable_download`）——
                        //    它是「哪个房间的内容会进我的剪贴板」，全局只能有一个；
                        // ② **这一类内容**的 ↓ 开着（`cfg.is_download_enabled`）。
                        // ⚠️ 原来只判 ② —— 因为那时「连接」本身就等于「下载开着」，
                        // ① 是隐含的。**连接与下载解耦之后它不再隐含**（§4.7），
                        // 漏了 ① 的话：给房间 A 开了 ↓，房间 B 的实时消息也会写进剪贴板。
                        if channel.enable_download && cfg.is_download_enabled(kind) {
                            // ⚠️★ 只有**真的写进去了**才报这一条：空正文的文本条目
                            // 走 `Ok(false)`（没东西可写），下载失败走 `Err`（那两种
                            // 情况 `apply_entry` 自己已经记了日志）。报一条没写成的
                            // 「已写进剪贴板」比不报更坏。
                            if let Ok(true) =
                                apply_entry(client, channel, cfg, &entry, sink, debouncer).await
                            {
                                updates.send(ReceiverEvent::WroteToClipboard(entry.clone()));
                            }
                        }
                        // ⚠️ 开关关掉也**照推列表** —— 开关管的是剪贴板，不是列表。
                        updates.send(ReceiverEvent::Entry(entry));
                    }
                }
            }

            WsEvent::DevicesChanged { device, joined } => {
                if let Some(device) = device {
                    if joined {
                        peers.insert(device.id.clone(), device);
                    } else {
                        peers.remove(&device.id);
                    }
                }
                // ⚠️ 认不出 payload 时**照旧推一份**（`device` 是 `None`）：
                // 「变了」这个信号本身仍然成立，界面至少能知道该重画了。
                updates.send(ReceiverEvent::DevicesChanged(
                    peers.values().cloned().collect(),
                ));
            }
            WsEvent::Revoked { id } => {
                updates.send(ReceiverEvent::Revoked { id });
            }
            WsEvent::Cleared => {
                updates.send(ReceiverEvent::Cleared);
            }
            WsEvent::Pong { echoed } => {
                // ⚠️ 只在**值真的变了**时推 —— 每 5 秒推一次「还是 12ms」是白唤醒界面。
                if latency.on_pong(elapsed_ms(started), echoed) {
                    updates.send(ReceiverEvent::Latency(latency.value()));
                }
            }
            WsEvent::Other(_) | WsEvent::Malformed => {}
        }
    }
}

/// 取历史并**只认领**。
///
/// ⚠️★ 失败**不算致命**：历史取不到（权限、旧服务端没有这个接口）不该让整个下行断掉 ——
/// 实时那部分照样能用。所以这里只推一条状态，不返回错误。
/// ⚠️★ 而且那条状态**必须**是 [`ReceiverStatus::HistoryUnavailable`]（2026-09-27 才加的）：
/// 原来推的是 `Disconnected` —— 那与上面这句话**相反**，界面会画成「已断开」，
/// 而用户其实还在收消息。报错不许把「还能用」的部分一起说死。
async fn load_history(
    client: &reqwest::Client,
    _cfg: &ClientConfig,
    channel: &Channel,
    handshake: &Handshake,
    boundary: &mut Boundary,
    updates: &RoomSink,
) {
    let limit = handshake.history.unwrap_or(FALLBACK_HISTORY);
    let entries = match fetch_history(client, channel, limit).await {
        Ok(entries) => entries,
        Err(reason) => {
            // ⚠️ `?reason` 而不是 `%reason`：`Msg` **故意没有 `Display`**
            //（见 `msg` 的模块文档第 3 条），日志里用 `Debug`。
            tracing::warn!(reason = ?reason, "取历史失败；实时仍然可用");
            // ⚠️ `latest_id` 是 `None`（老服务端）时**什么都不发**：那种情况下调用方
            // 刚发过 `NoWatermark`，而那条**更重要**（它说明「一行剪贴板都不写」）——
            // 拿一条「历史取不到」去把它盖掉，等于把更要紧的警告藏起来。
            if let Some(latest_id) = handshake.latest_id {
                updates.send(ReceiverEvent::Status(ReceiverStatus::HistoryUnavailable {
                    latest_id,
                    reason,
                }));
            }
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
    updates.send(ReceiverEvent::History(entries));
}

/// 把一条实时消息**写进本机剪贴板**。
///
/// ⚠️★ **写之前先预置指纹**（[`Debouncer::prime`]）—— 不预置的话，监控线程会把自己
/// 刚写进去的东西当成「用户复制的新内容」，再发回服务端；对端收到又写它自己的剪贴板 ——
/// 两个客户端之间**来回弹**。这就是为什么 watcher 与 receiver 必须**共享**一个 `Debouncer`。
///
/// ⚠️★ 返回值是 **`Ok(true)` = 真的写进去了**。`Ok(false)` 只有一种情况：空正文的
/// 文本条目（"没有东西可写" —— 不能把剪贴板清空）。上层靠它决定要不要报
/// [`ReceiverEvent::WroteToClipboard`]，所以**别把 `Ok(false)` 也当成写成功**。
async fn apply_entry(
    client: &reqwest::Client,
    channel: &Channel,
    cfg: &ClientConfig,
    entry: &ReceiveHolder,
    sink: &dyn ClipboardSink,
    debouncer: &Arc<Mutex<Debouncer>>,
) -> Result<bool, Msg> {
    // ⚠️ 写剪贴板本身的失败（`sink` 那句）走的是 `ClipboardSink` 自己的 [`Msg`]
    // —— 那两句话是**我们说的**（「写剪贴板文本失败」），所以不裹 `verbatim`。
    // 它下面只进日志，不进界面。
    let wrote = |r: Result<(), Msg>| r.map(|()| true);

    let result = match entry {
        ReceiveHolder::Text(text) => {
            if text.content.is_empty() {
                // 空正文的文本条目（`content` 是 omitempty，所以空正文会**省略这个 key**）
                // 没有东西可写 —— 直接跳过，而不是把剪贴板清空。
                return Ok(false);
            }
            prime(debouncer, &ClipboardContent::Text(text.content.clone()));
            wrote(sink.set_text(&text.content))
        }
        ReceiveHolder::File(file) => match download_file(client, channel, cfg, file).await {
            Ok(path) => {
                prime(debouncer, &ClipboardContent::Files(vec![path.clone()]));
                wrote(sink.set_files(&[path]))
            }
            Err(reason) => Err(reason),
        },
    };

    if let Err(reason) = &result {
        // ⚠️ 只记日志：写剪贴板失败（比如别的程序占着）不该把连接断掉。
        // ⚠️ `?reason`（Display）故意用不了 —— `Msg` 没有 `Display`，见 `msg.rs` 的类型级注释。
        tracing::warn!(reason = ?reason, "把收到的内容写进剪贴板失败");
    }
    result
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
) -> Result<PathBuf, Msg> {
    if file.cache.is_empty() {
        return Err(Msg::key("fileEntryNoCache"));
    }
    let url = endpoint::download_url(&channel.server, &file.cache, &file.name)?;

    let mut request = client.get(url);
    if let Some(token) = channel.auth_token.as_deref().map(str::trim)
        && !token.is_empty()
    {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = request
        .send()
        .await
        .map_err(|err| Msg::key("downloadFailed").param("reason", err))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(Msg::verbatim(parse_api_error(status, &body)));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| Msg::key("downloadReadFailed").param("reason", err))?;

    let dir = cfg.download_dir()?;
    tokio::fs::create_dir_all(&dir).await.map_err(|err| {
        Msg::key("downloadDirCreateFailed")
            .param("path", dir.display())
            .param("reason", err)
    })?;

    let name = download::local_file_name(&file.name, &file.url);
    let path = download::unique_path(&dir, &name, |candidate| candidate.exists());
    tokio::fs::write(&path, &bytes).await.map_err(|err| {
        Msg::key("downloadWriteFailed")
            .param("path", path.display())
            .param("reason", err)
    })?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg::ParamValue;
    use serde_json::json;

    /// 取那条消息上**唯一**的字符串参数。
    ///
    /// ⚠️ 写成「唯一」而不是「按名字取」是刻意的：这几条消息的参数都只有一个，
    /// 而参数名换了（`reason` / `detail`）正是**判据不在名字上**的意思 ——
    /// 我们只关心「底层那句原话有没有被原样带出来」。
    fn detail_of(msg: &Msg) -> String {
        assert_eq!(msg.params.len(), 1, "这几条消息只该带一个参数：{msg:?}");
        msg.params
            .values()
            .next()
            .and_then(ParamValue::as_str)
            .unwrap_or_else(|| panic!("那个参数不是字符串：{msg:?}"))
            .to_owned()
    }

    fn config_with(latest: Option<i32>) -> Handshake {
        Handshake {
            latest_id: latest,
            history: Some(50),
            limits: ServerLimits::default(),
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

    /// ⚠️★ **限额也从握手来**（`/server` 里没有它们 —— 见 `uploader` 的模块文档）。
    /// 这条钉住「这条接缝真的接上了」：上行要靠 `ReceiverStatus::Connected` 拿到它。
    #[test]
    fn handshake_carries_the_server_limits() {
        let h = parse_handshake(&json!({
            "latestId": 7,
            "server": {"history": 50},
            "text": {"limit": 4096},
            "file": {"limit": 268435456}
        }));
        assert_eq!(
            h.limits,
            ServerLimits {
                text_limit: 4096,
                file_limit: 268435456
            }
        );

        // 老服务端/字段缺失 → 「不知道」，而不是「限额 0」。
        let h = parse_handshake(&json!({"latestId": 7}));
        assert_eq!(h.limits, ServerLimits::default());
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
        // ⚠️ 设备事件要**带上是哪一台**（老版本只当信号，于是界面画不出「几台在线」）。
        match parse_event(
            r#"{"event":"connect","data":{"id":"d1","type":"smartphone","name":"iPhone"}}"#,
        ) {
            WsEvent::DevicesChanged { device, joined } => {
                assert!(joined, "connect 是「进来」");
                let device = device.expect("认得出 id 就该带出来");
                assert_eq!(device.id, "d1");
                assert_eq!(device.kind, "smartphone");
                assert_eq!(device.name, "iPhone");
            }
            other => panic!("应当是设备事件，得到 {other:?}"),
        }
        assert!(matches!(
            parse_event(r#"{"event":"disconnect","data":{"id":"d1"}}"#),
            WsEvent::DevicesChanged { joined: false, .. }
        ));
        // ⚠️ 没有 id 就**当没有**：设备进出只能按 id 去重，兜一个空 id 会让
        // 所有认不出的设备挤成同一台。信号本身仍然成立。
        assert!(matches!(
            parse_event(r#"{"event":"connect","data":{}}"#),
            WsEvent::DevicesChanged {
                device: None,
                joined: true
            }
        ));
        assert!(matches!(
            parse_event(r#"{"event":"pong","data":123}"#),
            WsEvent::Pong { echoed: Some(123) }
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
        let req = ws_request("https://host/clip9", "default", None).unwrap();
        assert_eq!(req.uri().path(), "/clip9/push");
        assert_eq!(req.uri().scheme_str(), Some("wss"));
    }

    // ── 握手被拒的文案 ────────────────────────────────────────

    /// 一次「连都没连上」的失败（不是 HTTP 拒绝）。
    fn network_reset() -> WsError {
        WsError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "对端把连接掐了",
        ))
    }

    /// ⚠️★★ **握手被拒要说人话**（2026-09-27 修，用户实测踩到）。
    ///
    /// 原来这里给的是 `format!("连接失败：{e}")`，而 `tungstenite` 在服务端
    /// **升级之前**拒绝时的 `Display` 只有「HTTP error: 401 Unauthorized」——
    /// 用户看到的就是一句「401」，**看不出下一步该做什么**。
    /// 实测场景：一台公网部署设了全局密码（`/push` 401 而 `/content` 200），
    /// 界面只显示「401」，完全指不到「凭据」那一列。
    ///
    /// ⚠️★ 这条用例钉三件事，缺一件这个修复就等于没做：
    /// ① 服务端 body 里那句理由要**照抄出来**（契约 JSON 的 `message`）；
    /// ② 401 / 403 上要**说清去哪儿填凭据**；
    /// ③ 别的状态码上**不许**提凭据 —— 那会把人引到错的地方去。
    ///
    /// ⚠️ 2026-09-28 之后「说清去哪儿」由**键本身**表达（两个键两条路），
    /// 而「①照抄」由 `detail` 这个参数表达。判据不是没变严，是**换了地方住**：
    /// 那句人话（「去凭据那一列填」）在 `ui/i18n.js` 里，由 `tools/desktop-ui-smoke.mjs` 看。
    #[test]
    fn a_refused_handshake_says_what_to_do() {
        fn refused(status: u16, body: &str) -> Msg {
            let response = tokio_tungstenite::tungstenite::http::Response::builder()
                .status(status)
                .body(Some(body.as_bytes().to_vec()))
                .expect("造一个握手响应");
            handshake_error(WsError::Http(Box::new(response)))
        }

        let m = refused(401, r#"{"error":"unauthorized","message":"需要认证令牌"}"#);
        assert_eq!(m.key, "connectNeedsCredentials", "401 要说清去哪儿填凭据");
        let detail = detail_of(&m);
        assert!(
            detail.contains("需要认证令牌"),
            "服务端给的理由被丢了：{detail}"
        );
        assert!(detail.contains("401"), "状态码还是要有：{detail}");

        // 403（密码对但没这个房间的权限）走同一条补救路径。
        let m = refused(403, "");
        assert_eq!(m.key, "connectNeedsCredentials", "403 同样要指到凭据那一列");
        assert!(detail_of(&m).contains("403"), "{}", detail_of(&m));

        // ⚠️ 别的状态码上提「凭据」是**误导**：500 是服务端坏了，填什么凭据都没用。
        let m = refused(500, "<html>boom</html>");
        assert_eq!(m.key, "connectRejected", "500 不是凭据问题，别把人引歪");
        let detail = detail_of(&m);
        assert!(detail.contains("500"), "{detail}");
        assert!(
            !detail.contains("凭据"),
            "这条路里只有服务端自己说的话 + 状态码，我们一个字的补救都没加：{detail}"
        );
    }

    /// ⚠️ 不是 HTTP 拒绝的（网络断）走原来那句，别硬塞状态码进去。
    #[test]
    fn a_handshake_failure_that_is_not_http_keeps_the_raw_reason() {
        let m = handshake_error(network_reset());
        assert_eq!(
            m.key, "connectFailed",
            "没连上就是没连上 —— 不是被服务端拒的"
        );
        // ⚠️ ★ 「原样保留底层那句」要能验：`WsError::Io` 的 `Display` 是我们没动过的
        // 那串字（`ConnectionReset`），一个字都不许被我们洗掉。
        let reason = detail_of(&m);
        assert!(
            reason.contains("对端把连接掐了"),
            "底层的原话要原样带出来：{reason}"
        );
        assert!(!reason.contains("凭据"), "这跟凭据没关系：{reason}");
        assert!(!reason.contains("**"), "界面是 textContent，星号会露出来");
    }

    // ── 「到底写没写进剪贴板」──────────────────────────────────

    /// 造一条文本条目。
    fn text_entry(id: i32, content: &str) -> ReceiveHolder {
        ReceiveHolder::Text(clip9_protocol::TextReceive {
            base: clip9_protocol::ReceiveBase {
                id,
                kind: "text".to_owned(),
                room: "default".to_owned(),
                ..clip9_protocol::ReceiveBase::default()
            },
            content: content.to_owned(),
            ..clip9_protocol::TextReceive::default()
        })
    }

    /// ⚠️★ `apply_entry` 的返回值就是「**该不该报『已写进剪贴板』**」的判据，
    /// 两半都要钉：
    /// · 正常正文 → `Ok(true)`，而且**真的写了一次**；
    /// · **空正文 → `Ok(false)`**，而且**一次都不许写**（写下去等于把用户的剪贴板清空）。
    ///
    /// ⚠️ 把 `Ok(false)` 当成成功，症状是「弹一句『已写进剪贴板』，
    /// 而剪贴板里还是旧内容」—— 界面越肯定，用户越不会去怀疑它。
    #[tokio::test]
    async fn only_a_real_write_counts_as_written() {
        let client = reqwest::Client::new();
        let cfg = ClientConfig::default();
        let channel = unreachable_channel();
        let debouncer = crate::shared_debouncer();
        let sink = crate::sink::RecordingSink::default();

        let wrote = apply_entry(
            &client,
            &channel,
            &cfg,
            &text_entry(1, "正文"),
            &sink,
            &debouncer,
        )
        .await;
        assert_eq!(wrote, Ok(true), "正常正文要算写成功");
        assert_eq!(sink.taken(), vec!["text:正文".to_owned()], "要真的写下去");

        let wrote = apply_entry(
            &client,
            &channel,
            &cfg,
            &text_entry(2, ""),
            &sink,
            &debouncer,
        )
        .await;
        assert_eq!(wrote, Ok(false), "空正文没东西可写");
        assert_eq!(
            sink.taken().len(),
            1,
            "空正文那次不许再写一次 —— 也绝不许把用户的剪贴板清空"
        );
    }

    // ── 历史取不回来 ──────────────────────────────────────────

    /// 造一个「房间」，服务端地址**故意写坏**：`fetch_history` 会在**拼 URL** 那一步
    /// 就失败（见 `endpoint::api_url` 的用例），于是这条用例**不用连网**。
    fn unreachable_channel() -> Channel {
        Channel::new("够不着的", "不是地址")
    }

    /// 一个空更新的收端（`load_history` 要往里推状态）。
    fn sink() -> (
        RoomSink,
        tokio::sync::mpsc::UnboundedReceiver<ReceiverUpdate>,
    ) {
        let channel = unreachable_channel();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            RoomSink {
                server: channel.server.clone(),
                room: channel.room.clone(),
                updates: tx,
            },
            rx,
        )
    }

    /// ⚠️★★ **历史取不到 ≠ 已断开**（2026-09-27 修）。
    ///
    /// 原来 `load_history` 失败时推的是 `Disconnected` —— 界面于是画成「已断开」，
    /// 而此刻**实时照常在收**（`/push` 那条连接好着呢，只是 `/content` 拿不到）。
    /// 用户看到「已断开」却还在收消息，只会以为界面坏了。
    /// 所以那条状态是 `HistoryUnavailable`（在壳那边是 `warn`，**仍然算「活着」**）。
    ///
    /// ⚠️ 这条用例的两半都是必需的：只测「推了一条状态」会漏掉第二半，
    /// 而那半是**更要紧**的警告别被盖掉（见下面）。
    #[tokio::test]
    async fn history_that_cannot_be_fetched_is_not_a_disconnect() {
        let client = reqwest::Client::new();
        let channel = unreachable_channel();
        let cfg = ClientConfig::default();
        let (sink, mut rx) = sink();

        let handshake = Handshake {
            latest_id: Some(7),
            history: Some(50),
            limits: ServerLimits::default(),
        };
        load_history(
            &client,
            &cfg,
            &channel,
            &handshake,
            &mut Boundary::new(),
            &sink,
        )
        .await;

        let update = rx.try_recv().expect("取不到历史要说一声，不能一声不响");
        assert_eq!(update.server, channel.server, "服务端要带上（身份的一半）");
        assert_eq!(update.room, channel.room);
        match update.event {
            ReceiverEvent::Status(ReceiverStatus::HistoryUnavailable { latest_id, reason }) => {
                assert_eq!(latest_id, 7, "边界要带上 —— 界面拿它显示进度");
                // ⚠️ 「理由不能为空」这条在 `Msg` 上**自动成立**（最差也是键本身），
                // 所以判据必须**更强**才有牙：要说得出**卡在哪一步**。
                // 这里的地址是「不是地址」（见 `unreachable_channel`），
                // 卡的就是「地址解析」那一步 —— 报成泛泛的「连接失败」等于没说。
                assert_eq!(
                    reason.key, "serverAddressUnparsable",
                    "地址都拼不出来，就得报这一步：{reason:?}"
                );
                assert_eq!(
                    reason.params.get("url").and_then(ParamValue::as_str),
                    Some("不是地址"),
                    "要说清是哪个地址：{reason:?}"
                );
            }
            other => panic!("历史取不到被报成了 {other:?} —— 界面会画成「已断开」"),
        }

        // ⚠️★ 老服务端（没有边界）上**什么都不发**：调用方刚发过 `NoWatermark`，
        // 而那条更要紧（它说明「一行剪贴板都不写」）—— 拿这条去盖掉它，
        // 等于把最该看见的警告藏起来。
        let old = Handshake {
            latest_id: None,
            history: Some(50),
            limits: ServerLimits::default(),
        };
        load_history(&client, &cfg, &channel, &old, &mut Boundary::new(), &sink).await;
        assert!(
            rx.try_recv().is_err(),
            "老服务端上又推了一条，把 `NoWatermark` 盖掉了"
        );
    }

    // ── 历史那一页：服务端投影 ↔ 客户端解析 ────────────────────

    /// Go 导出的那份 fixture（`cases/protocol/content_list.json`）。
    ///
    /// ⚠️ 两边**用同一份 fixture** 是有意的：服务端拿它比投影，这里拿它比解析。
    /// 「各测各的」正是这道缝错着却没人发现的原因（见 `parse_history_body` 的注释）。
    fn content_list_fixture() -> String {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../cases/protocol/content_list.json");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()))
    }

    /// ⚠️★★ **一整页 `/content` 要真的能读进来**（2026-09-27 修的，用户实测踩到）。
    ///
    /// 这条用例是「服务端投影 ↔ 客户端解析」那道缝上的**第一颗钉子**。原来两半各自都有测试，
    /// 而缝里有两处类型对不上：
    /// · `id` 是**字符串**（Go 的 `strconv.Itoa`）而 `ReceiveHolder` 要数字；
    /// · 文件条目的 `type` 是**展示类型**（`image`…）而 `ReceiveHolder` 只认 `text` / `file`。
    /// 于是**整页一条都进不来**，而失败被 `filter_map(…ok())` 全咽掉了 ——
    /// 用户看到的是空时间线、日志里一个字都没有（他报的「重启客户端也没有历史」）。
    ///
    /// ⚠️★ 断言里必须**同时**有文本条与文件条：只测文本的话，第二处（`type`）照样漏。
    /// 这正是「夹具的形状决定漏洞的形状」那条教训。
    #[test]
    fn a_go_content_page_parses_into_entries() {
        let entries = parse_history_body(&content_list_fixture()).expect("fixture 是合法 JSON");

        assert_eq!(entries.len(), 2, "一条文本 + 一条图片，两条都要进来");
        assert_eq!(entries[0].id(), 7, "字符串 id 要归一化成数字");
        assert_eq!(entries[0].kind(), "text");
        assert_eq!(
            entries[0].base().sender_client_id,
            "client-abc",
            "顺带钉住「谁发的」那些字段没在归一化时丢掉"
        );

        assert_eq!(entries[1].id(), 8);
        assert_eq!(entries[1].kind(), "file", "`image` 要归一化成 `file`");
        let ReceiveHolder::File(file) = &entries[1] else {
            panic!("第二条该是文件：{:?}", entries[1]);
        };
        assert_eq!(file.name, "screenshot.png");
        assert_eq!(file.size, 20480);
    }

    /// ⚠️ 一条坏条目**不许**让整页都看不见（「历史整段空掉」比「少一条」坏得多）——
    /// 但也不能一声不吭：现在会把**丢掉的条数**打进 WARN 日志（见 `parse_history_body`）。
    #[test]
    fn one_unreadable_entry_does_not_hide_the_page() {
        let raw = r#"{"messages":[
            {"id":"7","type":"text","content":"好的"},
            {"type":"不认识的东西"},
            {"id":"9","type":"text","content":"也在"}
        ]}"#;
        let ids: Vec<i32> = parse_history_body(raw)
            .expect("整体还是能解析的")
            .iter()
            .map(ReceiveHolder::id)
            .collect();
        assert_eq!(ids, vec![7, 9], "坏的那条跳过，其余照样进来");
    }

    /// ⚠️ `id` 归一化**不许**瞎补：解析不出来就让它当「读不进来」的那条，
    /// 而不是补个 `0` —— 那会变成一条 id 错的记录挂在时间线上（比丢掉更难查）。
    #[test]
    fn an_id_that_is_not_a_number_is_left_alone_not_zeroed() {
        let raw = r#"{"messages":[{"id":"不是数字","type":"text","content":"x"}]}"#;
        assert!(
            parse_history_body(raw).unwrap().is_empty(),
            "说不清 id 的条目宁可不要，也不要一条 id=0 的假记录"
        );
    }

    /// 空页（服务端说没有更多了）是**正常**结果，不是错误。
    #[test]
    fn an_empty_content_page_is_not_an_error() {
        assert!(parse_history_body(r#"{"messages":[]}"#).unwrap().is_empty());
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

    // ── 延迟采样（§4.3）────────────────────────────────────────

    /// ⚠️★ **取中位数，不是单次**：单次 RTT 会跳，直接画的话数字会自己抖得像坏了。
    #[test]
    fn the_latency_is_a_median_not_a_single_sample() {
        let mut tracker = LatencyTracker::default();
        assert_eq!(tracker.value(), Latency::Unknown, "还没测到就是不知道");

        for (stamp, rtt) in [(100u64, 20u64), (200, 30), (300, 400)] {
            tracker.on_sent(stamp);
            tracker.on_pong(stamp + rtt, Some(stamp));
        }
        // 20 / 30 / 400 的中位数是 30 —— **不是** 400（那一次是抖动）。
        assert_eq!(tracker.value(), Latency::Rtt(30));
    }

    /// ⚠️★ 一次**迟到的** pong 不能算成刚发那次 ping 的应答 ——
    /// 那会算出一个偏小的假延迟（看起来网络变好了，其实没有）。
    #[test]
    fn a_pong_that_is_not_ours_is_ignored() {
        let mut tracker = LatencyTracker::default();
        tracker.on_sent(1000);
        // 回声对不上 → 什么都不做，而且**那一次还在等**。
        assert!(!tracker.on_pong(1010, Some(999)));
        assert_eq!(tracker.value(), Latency::Unknown);
        assert!(tracker.waiting(), "对不上不该把「在等」这件事清掉");

        // 认不出的 payload（不是数字）同理。
        assert!(!tracker.on_pong(1010, None));
        assert!(tracker.waiting());

        // 对上了才算。
        assert!(tracker.on_pong(1012, Some(1000)));
        assert_eq!(tracker.value(), Latency::Rtt(12));
        assert!(!tracker.waiting());
    }

    /// ⚠️★ **超时要说「超时」，不画一个很大的数字**（§4.3 第 4 条）：
    /// `9999ms` 看起来只是「慢」，而真相是这条连接其实已经坏了。
    #[test]
    fn a_ping_that_never_returns_is_a_timeout_not_a_big_number() {
        let mut tracker = LatencyTracker::default();
        tracker.on_sent(1000);
        let line = PING_TIMEOUT.as_millis() as u64;
        // 还没到超时线：仍然是「不知道」。
        assert!(!tracker.on_tick(1000 + line - 1));
        assert_eq!(tracker.value(), Latency::Unknown);

        // 过了线 → 超时。
        assert!(tracker.on_tick(1000 + line + 1));
        assert_eq!(tracker.value(), Latency::Timeout);

        // ⚠️ 再问一次**不该又变一次**（`pending` 已经清了）—— 否则界面每 5 秒被白唤醒一次。
        assert!(!tracker.on_tick(9999));
        assert_eq!(tracker.value(), Latency::Timeout);
    }

    /// ⚠️ 重新发 ping 就说明连接还在动 → 上一次的超时结论要清掉，
    /// 不然界面会一直写着「超时」，而它其实已经好了。
    #[test]
    fn a_new_ping_clears_a_previous_timeout() {
        let mut tracker = LatencyTracker::default();
        tracker.on_sent(0);
        tracker.on_tick(PING_TIMEOUT.as_millis() as u64 + 1);
        assert_eq!(tracker.value(), Latency::Timeout);

        tracker.on_sent(20_000);
        assert_eq!(tracker.value(), Latency::Unknown, "刚重发，还没测到");
        tracker.on_pong(20_015, Some(20_000));
        assert_eq!(tracker.value(), Latency::Rtt(15));
    }

    /// ⚠️ 样本**有界**：留太久以前的会把「刚重连之后」的数字拖住
    ///（那时网络环境可能已经换了）。
    #[test]
    fn only_the_recent_samples_count() {
        let mut tracker = LatencyTracker::default();
        // 先来一批很慢的，再来一批很快的；中位数该跟着**最近的**走。
        for i in 0..RTT_SAMPLES as u64 {
            let stamp = i * 100;
            tracker.on_sent(stamp);
            tracker.on_pong(stamp + 500, Some(stamp));
        }
        for i in 0..RTT_SAMPLES as u64 {
            let stamp = 10_000 + i * 100;
            tracker.on_sent(stamp);
            tracker.on_pong(stamp + 10, Some(stamp));
        }
        assert_eq!(tracker.value(), Latency::Rtt(10), "慢的那批早该被挤出去了");
    }

    /// 偶数个样本取中间两个的平均（不然「中位数」在偶数时没有定义）。
    #[test]
    fn an_even_sample_count_averages_the_two_middle_ones() {
        let mut samples = VecDeque::from(vec![10, 20, 30, 40]);
        assert_eq!(median(&samples), Some(25));
        samples.push_back(50);
        assert_eq!(median(&samples), Some(30));
        assert_eq!(median(&VecDeque::new()), None);
    }

    /// ⚠️ `pong` 的回声要**带出来** —— 不带的话上面那些判据全都无从谈起。
    #[test]
    fn a_pong_carries_the_number_we_sent() {
        assert!(matches!(
            parse_event(r#"{"event":"pong","data":1757000000000}"#),
            WsEvent::Pong {
                echoed: Some(1_757_000_000_000)
            }
        ));
        // 认不出就当没有（**不当成我们的那次**）。
        assert!(matches!(
            parse_event(r#"{"event":"pong","data":"nope"}"#),
            WsEvent::Pong { echoed: None }
        ));
    }
}
