//! 桌面端的状态：配置、房间、时间线、连接状态。
//!
//! # 为什么这个文件里**没有 `tauri`**
//!
//! 状态机里每一处分支都是**要测的部分**：「连上了但握手没有水印」「给第二个房间开下载」
//! 「同一条消息来了两次」「房间被清空之后又来一条历史」…… 而绑进 `tauri` 之后，
//! 它们就只能靠手动点界面验 —— 那正是这个项目一直在避免的事（§2 的硬边界）。
//! `tauri::State` 只是「一个能被命令读到的 `Arc`」，所以状态放这里，命令就只剩转发。
//!
//! # 与 `clip9-client` 的分工
//!
//! **一个字节的业务逻辑都不在这里**。`clip9-client` 负责「去重 / 防抖 / 分类 / 边界 / 上下行」，
//! 这边只做三件事：把它的更新搬进内存、把界面要的那份状态**序列化**出去、
//! 以及**持久化配置**（原子写）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use clip9_client::{
    ClientConfig, Latency, PeerDevice, ReceiverEvent, ReceiverStatus, ReceiverUpdate, ServerLimits,
};
use clip9_protocol::ReceiveHolder;
use serde::{Deserialize, Serialize};

use crate::model::{EntryView, StatusView};

/// 「设置」里那些**不带房间**的项。`None` = **不改**。
///
/// ⚠️ 每个字段都是 `Option`：界面一次只改一项时，不该把别的项顺手覆盖成默认值
/// （那是「改 A 把 B 改回去了」，用户会以为设置没保存）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncScopePatch {
    pub enable_text: Option<bool>,
    pub enable_file: Option<bool>,
    pub enable_text_download: Option<bool>,
    pub enable_file_download: Option<bool>,
    pub poll_interval_ms: Option<u64>,
    pub download_dir: Option<PathBuf>,
}

/// 一个房间的**稳定标识**：`(服务端, 房间)` 拼成的字符串。
///
/// ⚠️ 用「服务端 + 房间」而不是显示名：显示名是给用户改的，
/// **改个名字就把历史清空**是说不通的。也**不含凭据** —— 改密码同样不该清历史。
///
/// ⚠️★ 服务端要**归一化**（去首尾空白、去尾部 `/`）：`http://h:9502` 与
/// `http://h:9502/` 明明是同一条地址，写法差一个斜杠就认不出是同一个房间。
/// ⚠️★ 而**这里是唯一的归一化点** —— [`Inner::room_index`] 也调这个函数。
/// 两处各归一化一遍一定会漂，而漂了**不报错**，只是「这个房间怎么不刷新了」。
fn channel_key(server: &str, room: &str) -> String {
    format!("{}|{}", server.trim().trim_end_matches('/'), room)
}

/// 一个房间的稳定标识（从 `Channel` 上取）。
fn room_key(channel: &clip9_client::Channel) -> String {
    channel_key(&channel.server, &channel.room)
}

/// 每个房间在界面上**留多少条**。
///
/// ⚠️ 这**不是**「历史长度」—— 历史长度是服务端的 `server.history` 旋钮，而这里管的是
/// 「本机窗口里摆多少张卡片」。留着的目的是**有界**：一个有几千条历史的房间，
/// 每次重绘都要序列化几千条，那是白花的力气（而界面上根本看不到那么远）。
/// ⚠️ 界面**必须**把这件事说出来（「只显示最近 200 条」），否则用户会以为前面的没了。
pub(crate) const MAX_ENTRIES_PER_ROOM: usize = 200;

/// 每个房间在本机**最多留多少字节正文**。
///
/// ⚠️★ 为什么「条数」那道界不够：**一条多大**由**服务端**的 `text.limit` 决定，
/// 而它可以被调大（`desktop-client.md` §8.2 整节就在算这件事）。200 条 × 10 万字符
/// = 20 MB（ASCII）/ 60 MB（中文），而这份列表**整个都在内存里**、每轮快照还要过一遍。
/// 于是「条数」与「字节」是两道**各自独立**的界，少一道另一边就漏 ——
/// 与 `handlers.rs` 里 `CONTENT_LIST_HARD_CAP` + `CONTENT_PAGE_BYTES` 是同一条道理。
///
/// 取 2 MiB 的依据：**缺省部署一个字都不变** —— 缺省一房间最多 200 条 × 4 KiB ≈ 800 KiB，
/// 2 MiB 是它的 2.5 倍，所以只有把 `text.limit` 调大之后它才开始起作用。
/// （这个关系由 `the_byte_bound_leaves_the_default_deployment_alone` 钉着。）
///
/// ⚠️ 代价是**用户可见的**：真有人连发长文时，列表会明显**短于 200 条**。
/// 所以①界面必须照实说（`Snapshot::max_bytes`，用户才不会以为消息丢了），
/// ②要更大的内容请走**文件**（`/upload` + 分片），不是把消息上限调大。
///
/// ⚠️ 它只数**条目正文**（`EntryView::text_bytes`），不数盘上文件的字节
/// —— 文件在服务端（`/file/...`），本地这份列表里只有文件名那点长度。
pub(crate) const MAX_BYTES_PER_ROOM: usize = 2 * 1024 * 1024;

/// 配置文件名（在数据目录下面）。
pub(crate) const CONFIG_FILE: &str = "client.json";

/// 一个房间在侧栏里的样子。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomView {
    /// 给用户看的名字。
    pub name: String,
    /// 服务端地址（界面上要显示 —— 「这台客户端连的是哪台服务器」必须看得见）。
    pub server: String,
    /// 服务端那边的房间名。
    pub room: String,
    /// 上行开关（**可以是多个**，见 `ClientConfig::upload_channels`）。
    pub upload: bool,
    /// 下行开关（**全局只能一个**，见 [`Store::set_download`]）。
    pub download: bool,
    /// 本机窗口里已有多少条。
    pub count: usize,
    /// 这个房间时间线里**正文合计多少字节**（全文，不是快照里那份预览）。
    ///
    /// ⚠️ 只算**条目正文**，不算盘上文件的字节 —— 文件的字节在服务端
    ///（`/file/...`），本地这份列表里只有文件名那点长度。
    ///
    /// 它存在的理由：`count` 那道界是「几条」，而「一条多大」是另一件事
    ///（`text.limit` 可配）—— 真正的内存占用是两者相乘。所以它是一个**量具**：
    /// 「把 `text.limit` 调大之后，本机到底多占了多少」现在看得见，
    /// 而不用先去做按字节驱逐（那是用户可见的数据丢失，得先有数才敢定阈值）。
    pub text_bytes: usize,
    /// 取过历史没有（界面上据此显示「还没加载」而不是一个空列表）。
    pub history_loaded: bool,
    /// 这个房间**自己那条连接**的状态（§4.7）。
    pub connection: ConnectionView,
}

/// 一个房间那条连接给界面看的样子。
///
/// ⚠️★ 它挂在 [`RoomView`] 上、**不是** `Snapshot` 的顶层字段 ——
/// 每个房间各自有一条连接（§4.7），顶层的「唯一那条连接」已经不存在了。
/// 原来 `Snapshot` 上那两个 `devices` / `latency` 就是靠「只有一个下行房间」
/// 这个前提才成立的，那个前提**已经没了**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    /// `off`（没连上 / 还没开始）/ `wait`（正在连）/ `on`（连上了）/ `warn`（老服务端）。
    pub kind: &'static str,
    pub text: String,
    /// 边界水印（`None` = 还不知道）。
    pub latest_id: Option<i32>,
    /// 这条连接的往返延迟（§4.3）。
    pub latency: LatencyView,
    /// 在线设备（**含本机**）。⚠️ 空 = **还不知道**，不是「一台都没有」。
    pub devices: Vec<DeviceView>,
}

impl Default for ConnectionView {
    fn default() -> Self {
        Self {
            kind: "off",
            text: "还没开始连".to_owned(),
            latest_id: None,
            latency: Latency::Unknown.into(),
            devices: Vec::new(),
        }
    }
}

/// 界面上「刚刚发生的一件事」（上传结果之类）。
///
/// ⚠️ 用 `kind` 而不是只给一句话：页面要能**分清**「成功 / 失败 / 只是被跳过」，
/// 三者的颜色不一样。只给一句话的结果就是界面只能全画成一种颜色。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub kind: &'static str,
    pub text: String,
}

/// 界面上要渲染的**完整**一份状态（IPC 一次给全，省得页面自己拼出半份状态）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub rooms: Vec<RoomView>,
    /// 当前选中哪个房间。
    pub selected: usize,
    /// 当前房间的时间线（**旧的在前**，末尾最新）。
    pub entries: Vec<EntryView>,
    /// 服务端限额（`0` = 还没连上、**不知道**）。
    ///
    /// ⚠️ 它是**一份**、不是每个房间一份：限额来自握手，而同一个服务端的每个房间
    /// 给的是同一套值。上行拿它当提示（超限由服务端自己拒，见 `uploader` 的模块文档）。
    pub limits: ServerLimitsView,
    /// 配置里的毛病（`ClientConfig::problems`）—— **摆出来，而不是自己在内部悄悄修正**。
    pub problems: Vec<String>,
    /// 开机自启 —— ⚠️ 这是**配置里的意图**，不是系统里的真相。
    /// 真相要问 `autostart::is_enabled`（那要 `AppHandle`，而 `Store` 里**不许有 `tauri`**）。
    /// 界面要画真相时走命令，别拿这个字段当「现在到底开没开」。
    pub autostart: bool,
    pub notice: Option<Notice>,
    /// 配置与数据目录（用户要知道自己的配置在哪）。
    pub config_path: String,
    pub data_dir: String,
    /// 每个房间最多留多少条 / 多少**字节正文**（界面要照实说）。
    ///
    /// ⚠️ 两个都要给：`max_entries` 说过的话会让人以为「最多 200 条」，
    /// 而字节那道界会让它**更短** —— 不说的话，用户看到列表停在 37 条
    /// 只会以为「消息丢了」（`MAX_BYTES_PER_ROOM` 的注释里点名了这条要求）。
    pub max_entries: usize,
    pub max_bytes: usize,
    /// 快照内容的**单调版本号** —— 界面**只用它**判断「要不要重画」。
    ///
    /// ⚠️★ 它把「哪些字段参与判定」从**页面**搬到了**这里**。原先的做法是页面拿
    /// 整份快照的 JSON 与上一份比，两个问题：
    /// ① 那趟 `JSON.stringify` 每 700ms **无条件**跑一遍，代价与内容长度成正比
    ///   （业内共识：不要拿 `JSON.stringify` 做变更判据）；
    /// ② 「字段清单」会有**两份** —— 页面一份、这个结构体一份，而两份一定会漂。
    ///   漏掉的那个字段变了界面就不刷新，**而且完全静默**
    ///   （§8.1 第 2 条就是 `notice` 被漏掉那次）。
    ///
    /// ⚠️★ **但风险是搬家，不是消失**：现在「漏一处」变成「某条写入忘了让版本号前进」，
    /// 表现**一模一样**（字段变了、界面不动、没有报错）。**换来的好处是它变得可测**
    /// —— 页面那一侧没有测试运行器，而这一侧有：`store` 的测试里**逐条列出了每一条
    /// 会改动快照的写入**，各有一条用例。所以**加新写入时必须同时加一条用例**，
    /// 否则就少了一层保护（这一条写在 `version` 旁边，就是为了让人先看到它）。
    ///
    /// ⚠️ 前进规则（[`Inner::touch`] 的注释里有完整版）：**低频**的用户动作直接前进，
    /// **高频**的（延迟 / 状态 / 设备表 / 可能重复的条目）**先比再写**。
    pub version: u64,
}

/// 延迟给界面看的那一份。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyView {
    /// `unknown`（还没测到）/ `rtt`（有数字）/ `timeout`（有 ping 没回来）。
    ///
    /// ⚠️★ 三个取值都要留着：`timeout` **绝不能**退化成一个很大的 `ms` ——
    /// 那看起来只是「慢」，而真相是这条连接其实已经坏了（§4.3 第 4 条）。
    pub kind: &'static str,
    /// ⚠️ 只有 `kind == "rtt"` 时有意义；别的取值下界面**不许**读它。
    pub ms: u32,
}

impl From<Latency> for LatencyView {
    fn from(latency: Latency) -> Self {
        match latency {
            Latency::Unknown => Self {
                kind: "unknown",
                ms: 0,
            },
            Latency::Rtt(ms) => Self { kind: "rtt", ms },
            Latency::Timeout => Self {
                kind: "timeout",
                ms: 0,
            },
        }
    }
}

/// 设备行里的一台设备。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    /// 设备名。⚠️ 可能是**空串**（客户端没声明过名字）—— 界面要自己兜底，别显示成空白。
    pub name: String,
    /// `desktop` / `smartphone` / `tablet`。⚠️ 界面**按它选图标**，不按名字猜。
    pub kind: String,
    /// 是不是本机。⚠️ 只有**真的连上**时才会出现本机那一个（见 `snapshot`）。
    pub me: bool,
}

/// 限额给界面看的那一份。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLimitsView {
    /// `0` = **不知道**（还没连上）。界面要显示成「—」，不是「0」。
    pub text_limit: usize,
    pub file_limit: u64,
}

impl From<ServerLimits> for ServerLimitsView {
    fn from(limits: ServerLimits) -> Self {
        Self {
            text_limit: limits.text_limit,
            file_limit: limits.file_limit,
        }
    }
}

/// 一个房间在本机的状态（**时间线 + 它自己那条连接**）。
#[derive(Debug, Default)]
struct Room {
    entries: Vec<EntryView>,
    history_loaded: bool,
    /// 这个房间**自己那条连接**的状态（§4.7）。
    ///
    /// ⚠️★ 每个房间一份，**不是**一份全局的 —— 每个房间各自有一条连接，
    /// 所以「谁连上了、谁有几台设备、谁的延迟是多少」都是**按房间**的。
    connection: Connection,
}

/// 一条连接的运行状态（每个房间一份）。
#[derive(Debug)]
struct Connection {
    /// 这条连接的状态。`None` = 连接任务还没报第一拍。
    status: Option<StatusView>,
    /// 这个房间里的**别人**（本机不在里面，见 `clip9_client::PeerDevice`）。
    peers: Vec<PeerDevice>,
    latency: Latency,
}

impl Default for Connection {
    fn default() -> Self {
        Self {
            status: None,
            peers: Vec::new(),
            latency: Latency::Unknown,
        }
    }
}

/// 一个房间那条连接给界面看的样子。
///
/// ⚠️★ 设备行与延迟**只在连接活着时**（`on` / `warn`）才有内容 ——
/// `off` / `wait` 时给空数组与 `unknown`，而不是「1 台在线（只有我）」。
/// 「数不到」和「只有我」是两件事，混起来就是骗人。
fn connection_view(inner: &Inner, room: &Room) -> ConnectionView {
    let Some(status) = &room.connection.status else {
        // 连接任务还没报第一拍 —— 照实说「还没开始连」。
        return ConnectionView::default();
    };
    let live = matches!(status.kind, "on" | "warn");
    let mut devices = Vec::new();
    if live {
        // ⚠️ 本机**算一台**：服务端那份列表里没有本机
        //（`devices_in_room_except` 把自己排掉了），而稿 1 那行「3 台在线」是**含本机**的。
        devices.push(DeviceView {
            name: inner.config.device_name.clone(),
            // ⚠️ 这个客户端就是桌面端 —— 不是猜的。
            kind: "desktop".to_owned(),
            me: true,
        });
        devices.extend(room.connection.peers.iter().map(|peer| DeviceView {
            name: peer.name.clone(),
            kind: peer.kind.clone(),
            me: false,
        }));
    }
    ConnectionView {
        kind: status.kind,
        text: status.text.clone(),
        latest_id: status.latest_id,
        latency: if live {
            room.connection.latency
        } else {
            Latency::Unknown
        }
        .into(),
        devices,
    }
}

/// 全部内存状态。
struct Inner {
    config: ClientConfig,
    rooms: Vec<Room>,
    selected: usize,
    limits: ServerLimits,
    notice: Option<Notice>,
    /// 快照内容的版本号 —— 见 [`Snapshot::version`] 与 [`Inner::touch`]。
    /// ⚠️ **只有 `touch` 改它**，别在别处直接写（那样就绕过了「前进规则」）。
    version: u64,
}

impl Inner {
    /// 记住「快照内容变了」（见 [`Snapshot::version`]）。
    ///
    /// ⚠️★ **前进规则**（两条，别混）：
    ///
    /// - **低频的**（用户点一下：切房间、改开关、改设置、换房间清单、传提示）→
    ///   **直接前进**。判断「值真变了没有」的代码比一次多余重绘更贵，而且方向是安全的：
    ///   多走一格只是**多一次重绘**（慢一点，看得见），漏走一格是**界面不动**（静默）。
    /// - **高频的**（每轮都可能来：`Latency` / `DevicesChanged` / `Status`，以及
    ///   `upsert`）→ **先比再写**。不判的话，版本号会跟着每轮 ping 一起涨，
    ///   于是「每 1.4 秒整屏重绘一次」—— 那正好是 S3 要消灭的代价。
    fn touch(&mut self) {
        // ⚠️ `wrapping_add` 而不是 `+= 1`：`u64` 溢出在 debug 构建里会 panic，
        // 而这个计数器**不该**能把客户端弄崩（真到那一刻也早就有别的问题了）。
        self.version = self.version.wrapping_add(1);
    }
}

/// 桌面端状态。
///
/// 锁中毒时用 `unwrap_or_else(|e| e.into_inner())` 取回值：**一次 panic 不该让
/// 整个客户端变成一块砖**。这是这个项目一贯的写法（`client` 里每一把锁都这样）。
pub struct Store {
    inner: Mutex<Inner>,
    config_path: PathBuf,
    data_dir: PathBuf,
}

impl Store {
    /// 造一个状态。`config` 必须已经带好 `base_dir`（相对路径要靠它解析，§5）。
    #[must_use]
    pub fn new(config: ClientConfig, config_path: PathBuf, data_dir: PathBuf) -> Self {
        let rooms = config.channels.iter().map(|_| Room::default()).collect();
        Self {
            inner: Mutex::new(Inner {
                config,
                rooms,
                selected: 0,
                limits: ServerLimits::default(),
                notice: None,
                // ⚠️ 从 0 起。页面那边「上一份」的初值是 `null`，所以**第一拍一定重绘**
                //（`'0' !== null`）—— 这正是想要的：界面必须至少画一次。
                version: 0,
            }),
            config_path,
            data_dir,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 界面要的那一份状态。
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let inner = self.lock();
        let rooms: Vec<RoomView> = inner
            .config
            .channels
            .iter()
            .zip(&inner.rooms)
            .map(|(channel, room)| RoomView {
                name: channel.name.clone(),
                server: channel.server.clone(),
                room: channel.room.clone(),
                upload: channel.enable_upload,
                download: channel.enable_download,
                count: room.entries.len(),
                // ⚠️★ **现算，不维护增量计数器**（有意）。
                //
                // 原计划是给 `Room` 加一个 `bytes` 字段，在 `upsert` / `Revoked` / `Cleared` /
                // 驱逐那几处加减 —— 而那个方案的事故点是**计数漂移**：漏一处减法就变成
                // 「房间明明没几条，却一直丢最旧的」，且**不报错**。
                //
                // ⚠️ 驱逐**已经加了**（`MAX_BYTES_PER_ROOM`），而它要的那个数在
                // `Room::trim` 里**也**是现算的 —— 所以「有了决策就该上计数器」这条**不成立**：
                // 列表 ≤200 条，而这两个地方本来就要遍历一遍，上计数器只会多一份会漂的状态。
                // 谁要改成计数器，先回答：省下的那点求和，值不值得换来「漂了也不报错」。
                text_bytes: room.entries.iter().map(|entry| entry.text_bytes).sum(),
                history_loaded: room.history_loaded,
                connection: connection_view(&inner, room),
            })
            .collect();
        let entries = inner
            .rooms
            .get(inner.selected)
            .map(|room| {
                // ⚠️★ 交出去的**只有截断预览**（2026-09-27 拍板：快照只带截断预览、正文按需取）。
                // `Store` 里那份仍然是**全文** —— 要全文的路径是 [`Store::entry_text`]
                //（IPC 命令 `entry_text` / `copy_entry`）。
                // 于是快照体积被钉在「200 条 × 4 KiB」上，与 `text.limit` 调到多大无关。
                room.entries.iter().map(EntryView::for_snapshot).collect()
            })
            .unwrap_or_default();
        Snapshot {
            rooms,
            selected: inner.selected,
            entries,
            limits: inner.limits.into(),
            problems: inner.config.problems(),
            autostart: inner.config.enable_autostart,
            notice: inner.notice.clone(),
            config_path: self.config_path.display().to_string(),
            data_dir: self.data_dir.display().to_string(),
            max_entries: MAX_ENTRIES_PER_ROOM,
            max_bytes: MAX_BYTES_PER_ROOM,
            version: inner.version,
        }
    }

    /// 界面上的一次性提示。
    ///
    /// ⚠️ 同样要 `touch` —— §8.1 第 2 条就是「`shapeOf` 漏了 `notice` → 三类提示永远画不出来」。
    /// 换判据**不改变**「哪些字段要参与判定」这件事（版本号不是免死金牌）。
    pub fn notice(&self, kind: &'static str, text: impl Into<String>) {
        let mut inner = self.lock();
        // ⚠️ 值一样就不动：`render` 里那一串上传结果提示可能重复出现
        //（「已上传」连点两次），而重画一次是白花的。
        let next = Some(Notice {
            kind,
            text: text.into(),
        });
        if inner.notice != next {
            inner.notice = next;
            inner.touch();
        }
    }

    /// 提示已经被看过了（页面取过之后清掉，免得一直挂着）。
    pub fn clear_notice(&self) {
        let mut inner = self.lock();
        if inner.notice.is_some() {
            inner.notice = None;
            inner.touch();
        }
    }

    /// 切房间。越界**报错**而不是静默夹住 —— 页面传错下标时要说清是哪里错了。
    pub fn select(&self, index: usize) -> Result<(), String> {
        let mut inner = self.lock();
        let count = inner.rooms.len();
        if index >= count {
            return Err(format!("没有第 {index} 个房间（共 {count} 个）"));
        }
        // ⚠️ 低频繁的用户动作 → **直接前进**（前进规则见 [`Inner::touch`]）。
        inner.selected = index;
        inner.touch();
        Ok(())
    }
}

impl Store {
    /// 把 `clip9-client` 的一条更新搬进内存。
    ///
    /// ⚠️ 这里**不做任何判断**（该不该写剪贴板、算不算历史、要不要去重）——
    /// 那些全在 `clip9-client` 里判完了（§2 的硬边界）。这边只把结果摆进列表。
    pub fn apply_update(&self, update: ReceiverUpdate) {
        let mut inner = self.lock();
        // ⚠️★ 房间名**由这条更新自己带**（§4.7）：每个房间各自有一条连接，
        // 「这条是谁的」不再是隐含的 —— 原来靠「只有一个下行房间」推出来的那个前提
        // **已经不存在了**。少了它，N 条连接的状态会互相覆盖。
        // ⚠️★ 房间身份是 **(服务端, 房间)** 两样 —— 见 `ReceiverUpdate::server` 的注释：
        // 只按房间名找的话，不同服务端上的同名房间会互相串（实测踩到过）。
        let Some(index) = inner.room_index(&update.server, &update.room) else {
            // 配置刚被改过、这个房间已经不在列表里了 —— 丢掉，不要 panic。
            return;
        };
        match update.event {
            // ⚠️ `update`（原地改正文）与 `receive` **走的是同一个分支** ——
            // 靠 id 就地**替换**掉原来那条，而不是再添一张卡片。
            // 替换而不是追加，是为了「同一条消息被改过之后，界面上还是一张卡片」。
            ReceiverEvent::Entry(entry) => {
                let server = inner.config.channels[index].server.clone();
                let client_id = inner.config.client_id.clone();
                let view = EntryView::from_holder(&entry, &client_id, &server);
                // ⚠️ `upsert` 自己答「列表真变了没有」（同一条**原样重传**会答 `false`，
                // 那不该触发一次整屏重绘）—— 它里面同时收两道界（条数 + 字节）。
                if inner.rooms[index].upsert(view) {
                    inner.touch();
                }
            }
            // ⚠️ 空历史也要标成「取过了」—— 否则界面分不出
            // 「这个房间确实是空的」与「还没取过」。这两种都画成空列表，用户会以为坏了。
            ReceiverEvent::History(entries) => {
                let server = inner.config.channels[index].server.clone();
                let client_id = inner.config.client_id.clone();
                let mut changed = false;
                for entry in &entries {
                    let view = EntryView::from_holder(entry, &client_id, &server);
                    changed |= inner.rooms[index].upsert(view);
                }
                if !inner.rooms[index].history_loaded {
                    inner.rooms[index].history_loaded = true;
                    changed = true;
                }
                if changed {
                    inner.touch();
                }
            }
            ReceiverEvent::Revoked { id } => {
                // ⚠️ 先比再写（不是「写了就 touch」）：**这个 id 可能根本不在列表里** ——
                // 房间里没这条、或者（有了字节界之后）**它已经被挤出去了**。
                // 那种情况下什么都没变，不该重绘。
                let before = inner.rooms[index].entries.len();
                inner.rooms[index].entries.retain(|entry| entry.id != id);
                if inner.rooms[index].entries.len() != before {
                    inner.touch();
                }
            }
            ReceiverEvent::Cleared => {
                if !inner.rooms[index].entries.is_empty() {
                    inner.rooms[index].entries.clear();
                    inner.touch();
                }
            }
            // ⚠️★ 整份替换，不是「增量更新」：客户端那边已经按 id 去好重了
            //（同一台设备开两个标签页只算一台，见 `PeerDevice`），
            // 这边再维护一份集合就是**第二份会漂的状态**。
            //
            // ⚠️ 下面这三条是**高频**事件（每轮 / 每次 ping 都可能来）→ 一律**先比再写**。
            // 「写了就 touch」会让版本号跟着每轮 ping 涨，退化成「每 1.4 秒整屏重绘一次」。
            ReceiverEvent::DevicesChanged(peers) => {
                if inner.rooms[index].connection.peers != peers {
                    inner.rooms[index].connection.peers = peers;
                    inner.touch();
                }
            }
            ReceiverEvent::Latency(latency) => {
                if inner.rooms[index].connection.latency != latency {
                    inner.rooms[index].connection.latency = latency;
                    inner.touch();
                }
            }
            ReceiverEvent::Status(status) => {
                let mut changed = false;
                // ⚠️ 限额也在这里存一份：它**只在握手里下发**（`uploader` 的模块文档），
                // 上行要用。⚠️ 一份就够 —— 同一个服务端的每个房间给的是同一套值。
                if let ReceiverStatus::Connected { limits, .. } = &status
                    && inner.limits != *limits
                {
                    inner.limits = *limits;
                    changed = true;
                }
                // `apply_status` 自己也会答「这条连接的样子变了没有」（它要清设备与延迟，
                // 而那两处也在快照里 → 不能只看传进来的 `status`）。
                changed |= inner.apply_status(index, status);
                if changed {
                    inner.touch();
                }
            }
        }
    }

    /// 界面上手动「刷新」时取回的历史（走 `GET /content`，**不碰剪贴板**）。
    ///
    /// ⚠️ 为什么要单独一条：下行的历史只覆盖**下载通道那一个房间**
    /// （`spawn_receiver` 只连那一个），而界面可以选中任何一个房间 ——
    /// 别的房间得自己按需取一次。
    ///
    /// ⚠️★ 房间**由调用方给**（`server` + `room`），不从 `entries.first()` 猜：
    /// 空响应（新房间 / 服务端说没有）时那个办法会回落到「下行房间」，
    /// 于是把**另一个房间**标成「已加载」——
    /// 症状是切到那个房间看到空列表且写着「这个房间还没有内容」，而它其实有内容。
    ///
    /// ⚠️★ 而且要给的是 **(服务端, 房间)** 两样：两个服务端上可以同时有 `default`，
    /// 只按房间名落的话，从 `example.com` 取回的历史会写进**本地**那个 `default` 房间
    ///（2026-09-27 修的同一条根因，见 `ReceiverUpdate::server`）。
    pub fn push_history(&self, server: &str, room: &str, entries: Vec<ReceiveHolder>) {
        let mut inner = self.lock();
        if let Some(index) = inner.room_index(server, room) {
            let server = inner.config.channels[index].server.clone();
            let client_id = inner.config.client_id.clone();
            for entry in &entries {
                let view = EntryView::from_holder(entry, &client_id, &server);
                // ⚠️ 返回的「变了没有」这里**故意丢掉**：这是一次**用户点的刷新**
                //（低频），直接前进更省事，方向也是安全的（多一次重绘只是慢一点）。
                inner.rooms[index].upsert(view);
            }
            inner.rooms[index].history_loaded = true;
            inner.touch();
        }
    }
}

impl Store {
    /// 换上行开关（**可以多个房间同时开**，§4.1 第 1 条）。
    pub fn set_upload(&self, index: usize, on: bool) -> Result<(), String> {
        let mut inner = self.lock();
        // ⚠️ 先把「有没有这个房间」判掉**再**改 —— 原来用的是 `get_mut(..).ok_or_else(..)`，
        // 但那样借出去的 `&mut channel` 会活到语句结束，后面就没法 `inner.touch()` 了。
        if inner.config.channels.get(index).is_none() {
            return Err(format!("没有第 {index} 个房间"));
        }
        // ⚠️ 低频繁的用户动作 → 直接前进（前进规则见 `Inner::touch`）。
        inner.config.channels[index].enable_upload = on;
        inner.touch();
        Ok(())
    }

    /// 换下行开关 —— ⚠️★ **全局只能一个**（§4.1 第 2、4 条）。
    ///
    /// 给另一个房间开下载时，**前一个自动关掉**。这不是"顺手清理"，
    /// 它就是这条规则本身：两个房间同时写本机剪贴板 = 后到的覆盖先到的，
    /// 用户看到的是随机内容。
    /// ⚠️ 行为基准 `clip-sync` 用的是「取第一个开着的那一个」，
    /// 那个写法在用户开了两个的时候**静默只认第一个** —— 第二个开关点了没反应，
    /// 而那正是这个项目最忌讳的一类（配了不生效）。
    /// 手改过的配置（真的开了两个）由 [`ClientConfig::problems`] **报出来**，不是悄悄挑一个。
    pub fn set_download(&self, index: Option<usize>) -> Result<(), String> {
        let mut inner = self.lock();
        let count = inner.config.channels.len();
        // ⚠️ 越界在这里**一次性**判掉，然后才进循环 —— 把判断写在循环里的话，
        // 「配错了一个下标」与「界面上那个房间本来就是关的」会得到同样的结果。
        if let Some(target) = index
            && target >= count
        {
            return Err(format!("没有第 {target} 个房间（共 {count} 个）"));
        }
        for (position, channel) in inner.config.channels.iter_mut().enumerate() {
            channel.enable_download = index == Some(position);
        }
        // ⚠️ 循环里那段借用到这儿已经结束，可以 `touch` 了。
        inner.touch();
        Ok(())
    }

    /// 换「运行方式」：要不要随客户端启动本机那个自带服务端。
    ///
    /// ⚠️ 这里**只改配置里的意图**；真的起 / 停由 `commands::set_local_server` 做
    ///（那要 `ServerProcess`，而 `Store` 不碰进程）。调用方**两个都要做** ——
    /// 只改配置的话，用户点完看到的是「模式换了、服务端照旧在跑」，那是「配了不生效」。
    pub fn set_local_server(&self, on: bool) {
        // ⚠️ **不 `touch`**：它**不在快照里**（「运行方式」那一段由 `settings_view` /
        // `server_status` 刷新，页面别处也不画它）—— 快照里没有它，前进一格就是白重绘。
        // ⚠️ 这条是**唯一**一处「改配置却不前进」的地方，所以写在这儿解释清楚；
        // 哪天把它加进快照，这里必须加 `touch`（`Snapshot::version` 的注释里说了这件事）。
        self.lock().config.enable_local_server = on;
    }

    /// 换「开机自启」（**只有桌面端会用**）。
    ///
    /// ⚠️ 这里只改**配置里的意图**；落到系统上由 `autostart::apply` 做
    /// （那要 `AppHandle`，而这里不许有 `tauri`）。调用方**两个都要做** ——
    /// 只改配置的话，用户勾了、界面上勾着、系统里没写，就是「配了不生效」。
    pub fn set_autostart(&self, on: bool) {
        let mut inner = self.lock();
        inner.config.enable_autostart = on;
        // ⚠️ 它在快照里（`Snapshot::autostart`）→ 必须前进，否则勾了界面不变。
        inner.touch();
    }

    /// 换整份房间清单（界面上加 / 删 / 改房间）。
    ///
    /// ⚠️★ **房间清单和本机状态是按下标对齐的**（`Inner.rooms[i]` 属于
    /// `config.channels[i]`）—— 所以换清单时**必须同时搬状态**。
    /// 不搬的症状是「A 房间的消息显示在 B 房间下面」：界面照常渲染、**不报错**，
    /// 而用户会以为「消息串台了」—— 那是这个项目最忌讳的一类。
    ///
    /// ⚠️ 按**房间名**（`server` + `room`）搬，不按下标：用户删掉第一个房间时，
    /// 后面的下标全变了，按下标搬等于把每个房间的消息都错位一格。
    ///
    /// ⚠️ 认不出来的当**新房间**（空状态、`history_loaded = false`）——
    /// 于是界面会显示「还没加载这个房间的历史」而不是一个骗人的空列表。
    pub fn set_rooms(&self, channels: Vec<clip9_client::Channel>) -> Result<(), String> {
        let mut inner = self.lock();
        // ⚠️ 先把「房间名」收出来，**再** `drain` —— 两个字段同属 `inner`，
        // 一边不可变借用 `config`、一边可变借用 `rooms` 会撞上借用检查。
        let keys: Vec<String> = inner.config.channels.iter().map(room_key).collect();
        let mut old: std::collections::HashMap<String, Room> =
            keys.into_iter().zip(inner.rooms.drain(..)).collect();

        inner.rooms = channels
            .iter()
            .map(|channel| old.remove(&room_key(channel)).unwrap_or_default())
            .collect();
        inner.config.channels = channels;

        // ⚠️ 选中的那个下标可能已经不存在了（删掉了最后一个房间）→ 夹回合法范围。
        // 不夹的话 `snapshot()` 里的 `rooms.get(selected)` 会拿到 `None`，
        // 界面显示成「没有房间」而配置里明明有 —— 又一处「界面说一套」。
        if inner.selected >= inner.rooms.len() {
            inner.selected = inner.rooms.len().saturating_sub(1);
        }
        // ⚠️ 无条件前进：换清单是用户动作（低频），而它改动的东西**横跨整个快照**
        //（房间名、上下行开关、`problems` 都可能变）—— 逐字段比对的代码比一次重绘贵。
        inner.touch();
        Ok(())
    }

    /// 换同步范围 / 轮询间隔 / 下载目录（「设置」里那些不带房间的项）。
    ///
    /// ⚠️ 只改**给进来的**那些字段（`None` = 不改）：界面一次只改一项时，
    /// 不该把别的项顺手覆盖成默认值。
    pub fn set_sync_scope(&self, patch: &SyncScopePatch) {
        let mut inner = self.lock();
        let config = &mut inner.config;
        if let Some(value) = patch.enable_text {
            config.enable_text = value;
        }
        if let Some(value) = patch.enable_file {
            config.enable_file = value;
        }
        if let Some(value) = patch.enable_text_download {
            config.enable_text_download = value;
        }
        if let Some(value) = patch.enable_file_download {
            config.enable_file_download = value;
        }
        if let Some(value) = patch.poll_interval_ms {
            // ⚠️ 下界 1ms：`0` 会让监听线程**空转**（`thread::sleep(0)` 立刻返回），
            // 症状是「风扇转起来」，和「同步不准」完全联想不到一起。
            config.poll_interval_ms = value.max(1);
        }
        if let Some(value) = &patch.download_dir {
            config.download_dir = value.clone();
        }
        // ⚠️ **无条件前进**，而且要留意这条判断的来历：严格说这几个字段**不在快照里**
        //（页面是从 `settings_view` 那条命令读它们的）。但这里仍然前进，因为：
        // ① 它是**用户动作**（低频），多走一格只是多一次重绘；
        // ② 反方向（漏一格）在这个文件里是**静默失效**——哪天有人把 `pollIntervalMs`
        //    加进快照却忘了加 `touch`，界面就会「配了不生效」。
        // 两条路里只有一条会咬人，所以选安全的那条（前进规则见 [`Inner::touch`]）。
        inner.touch();
    }

    /// 界面上要用的配置副本（喂给 `clip9-client` 的那几个函数）。
    #[must_use]
    pub fn config(&self) -> ClientConfig {
        self.lock().config.clone()
    }

    /// 选中的房间（发请求要用）。没有房间就是 `None`。
    #[must_use]
    pub fn selected_channel(&self) -> Option<clip9_client::Channel> {
        let inner = self.lock();
        inner.config.channels.get(inner.selected).cloned()
    }

    /// 一条条目的**全文**（界面「展开」与「复制内容」用）。
    ///
    /// ⚠️★ 存在的原因是快照里只有**截断预览**（[`EntryView::for_snapshot`]）：
    /// 页面手里那份不能当正文用，要正文就回来取。
    ///
    /// ⚠️ 只在**当前选中**那个房间里找：界面上的卡片就是从那一屏来的，
    /// 切了房间之后它已经不在列表里了 —— 那时返回 `None`，界面要说清
    /// 「这条已经不在列表里了」，**别静默给个空串**（那看起来像「复制成功了但是空的」）。
    /// ⚠️ 也**不能**跨房间按 id 找：id 是**每个房间各自**单调的，跨房间会找错条。
    #[must_use]
    pub fn entry_text(&self, id: i32) -> Option<String> {
        let inner = self.lock();
        inner
            .rooms
            .get(inner.selected)?
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.text.clone())
    }

    /// 握手里拿到的限额（上行要用）。
    ///
    /// ⚠️ `ServerLimits::default()`（两个 0）= **不知道**，不是「限额是 0」——
    /// 那个方向是 fail-open：服务端会自己拒掉超限的请求，并把**带具体数字**的那句话带回来。
    #[must_use]
    pub fn limits(&self) -> ServerLimits {
        self.lock().limits
    }

    /// 把配置**原子写**回磁盘。
    ///
    /// ⚠️⚠️ 必须**原子写**（临时文件 + rename）：这个项目为「半截 JSON」付过代价
    /// （并发写 30 轮里 13 轮写出损坏的文件，见 `desktop-client.md` §3.5.2）。
    /// 而配置文件一旦是半截的，用户下次启动就同步不了 —— 界面怎么画都救不回来。
    pub fn save(&self) -> Result<(), String> {
        let config = self.lock().config.clone();
        save_config(&self.config_path, &config)
    }
}

impl Inner {
    /// 按 **(服务端, 房间)** 找下标（`None` = 配置里没有这一对）。
    ///
    /// ⚠️★★ **两样都要匹配**（2026-09-27 修的）：**不同服务端上可以有同名房间** ——
    /// 房间清单里同时有 `default@127.0.0.1:9502` 与 `default@example.com` 时，
    /// 只按房间名找会让**两条连接的更新全落进第一个同名房间**：
    /// 公网那条的 401 挂到本地那个房间的状态栏上（用户看到的正是「本地这个房间
    /// 明明连着、却显示 401」），取回的历史也会串进别人家的房间。
    /// ⚠️ 这条规则与 [`room_key`] **必须一致**（两处都走 [`channel_key`]）——
    /// 两处不一致的话，同一个房间会因为多一个斜杠而找不着。
    fn room_index(&self, server: &str, room: &str) -> Option<usize> {
        let key = channel_key(server, room);
        self.config.channels.iter().position(|c| room_key(c) == key)
    }

    /// 状态变化（**某个房间**那条连接的）。
    ///
    /// ⚠️★ `NoWatermark`（老服务端握手不带 `latestId`）**必须显示成一条警告**，
    /// 而不是「已连接」—— 因为此刻客户端**一行剪贴板都不写**（fail-safe，§4.2 ①）。
    /// 显示成「已连接」的话，用户会以为同步在工作（然后发现内容就是不过来）。
    ///
    /// ⚠️ 房间**由调用方给下标**（`apply_update` 里已经从更新的 `room` 算出来了）——
    /// 状态里那个 `room` 只用来显示，不该再拿它找一次（找错了就是挂到别的房间上）。
    ///
    /// ⚠️ 返回值是「这条连接给界面看的样子**真的变了**没有」（调用方拿它决定要不要
    /// `touch`）。⚠️ **不能只看传进来的 `status`**：这个函数在掉线 / 重连时还会
    /// **清掉设备与延迟**，而那两处也在快照里 —— 只看 `status` 就会漏掉那两次变化。
    fn apply_status(&mut self, index: usize, status: ReceiverStatus) -> bool {
        let Some(room) = self.rooms.get_mut(index) else {
            return false;
        };
        // ⚠️ 三份都留个底（`Clone` 一份设备表是小开销，而这件事**低频**：
        // 只有连接状态变化才走到这儿，不是每轮 ping）。
        let before = (
            room.connection.status.clone(),
            room.connection.peers.clone(),
            room.connection.latency,
        );
        // ⚠️★ 掉线 / 重连时**必须清掉设备与延迟**：服务端是在连接**建立之后**
        // 才逐台发 `connect` 的（`ws.rs`），所以旧的那份在「正在连」这一刻已经作废。
        // 不清的话，症状是「刚连上时显示的是上一轮的那几台 / 那个数字」——
        // 而它会自己消失（新的 connect 到了就对了），所以最难被发现。
        if matches!(
            status,
            ReceiverStatus::Connecting { .. } | ReceiverStatus::Disconnected { .. }
        ) {
            room.connection.peers.clear();
            room.connection.latency = Latency::Unknown;
        }
        room.connection.status = Some(match status {
            ReceiverStatus::Connecting { room: name, .. } => StatusView {
                kind: "wait",
                text: format!("连接 {name} …"),
                latest_id: None,
                room: Some(name),
            },
            ReceiverStatus::Connected { latest_id, .. } => StatusView {
                kind: "on",
                text: "已连接".to_owned(),
                latest_id: Some(latest_id),
                room: None,
            },
            ReceiverStatus::NoWatermark => StatusView {
                kind: "warn",
                text: "服务端版本太旧：边界说不清，已暂停写剪贴板".to_owned(),
                latest_id: None,
                room: None,
            },
            ReceiverStatus::Disconnected { reason } => StatusView {
                kind: "off",
                text: format!("已断开：{reason}"),
                latest_id: None,
                room: None,
            },
        });
        // 「这条连接给界面看的样子变了没有」——三处任一变了都算（见函数头的注释）。
        before.0 != room.connection.status
            || before.1 != room.connection.peers
            || before.2 != room.connection.latency
    }
}

impl Room {
    /// 插一条：**同 id 就地替换**，新的按 id 插到正确位置，超过上限就从最旧的丢。
    ///
    /// ⚠️ 为什么不能无脑 `push`：房间之间 id 各自单调（`CONTRIBUTING.md` §6），
    /// 而界面可以**来回切房间**、按需取回的历史里的 id **可能比已经在列表里的小** ——
    /// 无脑 push 会让时间线乱序，而乱序的时间线用户是看不出错的（只会觉得"不对劲"）。
    ///
    /// ⚠️ 返回值是「**列表真的变了**没有」——调用方拿它决定要不要 `touch`
    /// （见 [`Snapshot::version`]）。⚠️ 同一条**原样重传**时它是 `false`：
    /// 内容一个字节没变，不该触发一次整屏重绘。
    fn upsert(&mut self, view: EntryView) -> bool {
        let changed = match self
            .entries
            .binary_search_by_key(&view.id, |entry| entry.id)
        {
            Ok(position) => {
                let same = self.entries[position] == view;
                self.entries[position] = view;
                !same
            }
            Err(position) => {
                self.entries.insert(position, view);
                true
            }
        };
        // ⚠️ `trim()` **不能**因为 `changed` 已经是 `true` 就跳过：它做的判断
        //（超没超界）与 `changed` 无关。所以先算、再用 `||` 合并 ——
        // 写成 `if changed { … }` 那种短路就会漏掉「插了一条新的、同时挤掉了最旧的」里的后半句。
        let trimmed = self.trim();
        changed || trimmed
    }

    /// 把这道房间的两道界都收回来：**条数** + **字节**，都从**最旧**的那端丢。
    ///
    /// 返回「真的丢了东西没有」。
    ///
    /// ⚠️★ 字节量是**现算**的（`entries.iter().map(..).sum()`），**不维护计数器** ——
    /// 见 [`RoomView::text_bytes`] 的注释：没有第二份状态就没有漂移。
    /// 200 条的求和对「插一条」这个操作来说可以忽略（`snapshot()` 本来就要遍历整列表）。
    ///
    /// ⚠️★ **至少留一条**：单独一条就超字节预算时**不能**把它也丢掉 ——
    /// 那会让「刚收到的那条消息」**在自己客户端上都不显示**，而且**没有任何报错**。
    /// （与 `handlers.rs` 的 `page_bytes_to_drop` 是同一条规矩，那边叫「空数组 = 到头了」，
    /// 这边更直接：列表空掉 = 消息看不见了。而且这里**更该**留 —— 那边丢的是历史分页，
    /// 这边丢的是**已经在本机**的那条。）
    fn trim(&mut self) -> bool {
        let before = self.entries.len();
        // 条数界（**旧行为，没变**）：超了就丢最旧的。
        if before > MAX_ENTRIES_PER_ROOM {
            self.entries.drain(..before - MAX_ENTRIES_PER_ROOM);
        }
        // 字节界（2026-09-27 加，见 `MAX_BYTES_PER_ROOM`）。
        // ⚠️ 从第 0 条（最旧）往后丢，而 `drop_count + 1 < len` 保证**至少剩一条**。
        let mut total: usize = self.entries.iter().map(|entry| entry.text_bytes).sum();
        let mut drop_count = 0;
        while total > MAX_BYTES_PER_ROOM && drop_count + 1 < self.entries.len() {
            total -= self.entries[drop_count].text_bytes;
            drop_count += 1;
        }
        if drop_count > 0 {
            self.entries.drain(..drop_count);
        }
        self.entries.len() != before
    }
}

/// 读配置；没有就造一份**默认的、并立刻写盘**。
///
/// ⚠️⚠️ 第一次运行**必须写盘**，不是「等用户改了再写」：因为 `ClientConfig::client_id`
/// 是**首次生成**的（uuid），而界面上「这条是不是我发的」判的就是它。
/// 不落盘的话每次启动都是新 id —— 于是**自己发的消息永远显示成别人的**，而且**没有任何报错**。
///
/// ⚠️ 配置文件**坏了要报错，绝不悄悄换成默认**：那等于把用户的服务端地址、房间凭据、
/// 方向开关**全清掉**，而用户只会发现「怎么连不上了」。
/// 所以这里原样把路径报出来，让用户去改或去挪走。
pub fn load_config(
    config_path: &Path,
    data_dir: &Path,
    default_server: &str,
) -> Result<ClientConfig, String> {
    let raw = match std::fs::read_to_string(config_path) {
        Ok(raw) => Some(raw),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return Err(format!("读配置失败（{}）：{err}", config_path.display()));
        }
    };

    let mut config = match raw {
        Some(raw) => serde_json::from_str::<ClientConfig>(&raw).map_err(|err| {
            format!(
                "配置是坏的（{}）：{err}\n    这个文件**没被动过** —— 改好或者挪走它，客户端才能起来。",
                config_path.display()
            )
        })?,
        None => {
            // ⚠️ 用结构体更新语法而不是「先 default 再逐字段赋值」—— 后者会触发
            // `clippy::field_reassign_with_default`，而门禁是 `-D warnings`。
            // ⚠️★ **默认房间不开「收进剪贴板」**（`Channel::new` 的 `enable_download`
            // 本来就是 `false`，这里不去动它）。Jonny 2026-09-26 拍板：
            // 「下载不要默认开，就默认关闭」—— 装完不该自动接管你的剪贴板。
            //
            // ⚠️⚠️ **代价要说清楚**（它不是一个没有后果的选择）：`download_channel()`
            // 返回 `None` → 客户端**一个下行连接都不会建**（`spawn_receiver` 自己判它）。
            // 所以装完的状态是：**发到房间照常，收不到任何东西**，设备行也数不到。
            // 这不是 bug，是这个默认值的直接后果。
            // 界面上的补救是 `snapshot()` 那条 `kind: "off"` 的状态文案 ——
            // 它必须说清「不是连不上，是没开」，否则用户会跑去查服务端（错的方向）。
            //
            // ⚠️ 历史：2026-09-26 早些时候这里曾被改成 `true`，理由正是「默认房间一直没连上」
            //（Jonny 报的那个现象）。改成 `false` 之后那个现象**会回来**，
            // 但这次它有一个说得清的界面（上面那条状态），而不是「连接中…」。
            // 两件事都记在 `desktop-client.md` §4.1 第 3 条，改之前先读那一条。
            let config = ClientConfig {
                channels: vec![clip9_client::Channel::new("默认", default_server)],
                ..ClientConfig::default()
            };
            save_config(config_path, &config)?;
            return Ok(config);
        }
    };

    // ⚠️ `base_dir` **不落盘**（它是运行环境，不是用户配置）—— 见 `ClientConfig` 自己的测试。
    // 所以每次读配置都要重新挂上：少了这一步，相对下载目录会说不出路径
    // （`ClientConfig::download_dir` 的那条报错就是「没有数据目录就说不出相对路径」）。
    config.base_dir = Some(data_dir.to_path_buf());
    Ok(config)
}

/// **原子写**：临时文件 + rename。
///
/// ⚠️ 为什么必须原子：配置文件写坏了 = 用户下次启动连不上，而界面画得再对也救不回来
/// （这个项目为「半截 JSON」付过代价，见上面 `Store::save` 的注释）。
pub fn save_config(path: &Path, config: &ClientConfig) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("建目录失败（{}）：{err}", parent.display()))?;
    }
    let json =
        serde_json::to_string_pretty(config).map_err(|err| format!("配置序列化失败：{err}"))?;

    // ⚠️ 临时名**带进程 id**：两个进程同时保存时（例如开了两个窗口）不会互相踩掉对方的临时文件。
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|err| format!("写临时文件失败（{}）：{err}", tmp.display()))?;
    // ⚠️ `rename` 在同一个文件系统内是原子的 —— 这正是「临时文件与目标同目录」的意义。
    std::fs::rename(&tmp, path).map_err(|err| {
        format!(
            "覆盖配置失败（{} → {}）：{err}",
            tmp.display(),
            path.display()
        )
    })
}

/// 数据/配置目录 —— macOS 用 `Application Support`，其余按 XDG 规范。
///
/// ⚠️ 服务端与客户端**同一套规矩**（`desktop-client.md` §5）：相对路径落在数据目录下，
/// 不是 cwd。所以「数据目录」这个概念一定要有。
#[must_use]
pub fn default_data_dir() -> PathBuf {
    data_dir_for(
        std::env::consts::OS,
        home_dir().as_deref(),
        xdg_config_home().as_deref(),
    )
}

/// 拼数据目录的**纯函数**部分（单独拆出来是为了能测 —— 改环境变量做测试是并行的噩梦）。
#[must_use]
fn data_dir_for(os: &str, home: Option<&Path>, xdg: Option<&Path>) -> PathBuf {
    if os == "macos" {
        // ⚠️ 放 `Application Support` 而不是 `~/Library/Preferences`：
        // 这台客户端要往数据目录里落**下载的文件**，那不是「偏好设置」。
        home.map(|home| home.join("Library/Application Support/clip9"))
            .unwrap_or_else(|| PathBuf::from("clip9"))
    } else {
        xdg.map(|xdg| xdg.join("clip9"))
            .or_else(|| home.map(|home| home.join(".config/clip9")))
            .unwrap_or_else(|| PathBuf::from("clip9"))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn xdg_config_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clip9_client::Channel;
    use clip9_protocol::{FileReceive, ReceiveBase, TextReceive};

    fn text(id: i32, room: &str, content: &str) -> ReceiveHolder {
        ReceiveHolder::Text(TextReceive {
            base: ReceiveBase {
                id,
                kind: "text".to_owned(),
                room: room.to_owned(),
                timestamp: 1_757_000_000 + i64::from(id),
                ..ReceiveBase::default()
            },
            content: content.to_owned(),
            ..TextReceive::default()
        })
    }

    /// ⚠️★ **拍板（2026-09-27）：快照只带截断预览，正文按需取。**
    ///
    /// 这条钉住**两件事**，两件都是静默坏掉的类型：
    /// ① 快照里那份**被截断**了（否则「长文压垮快照」那个问题根本没解决）；
    /// ② `Store` 里那份**还是全文**（截断只能发生在投影那一步 —— 谁要是去改 Store 里那份，
    ///    长文就会在本地被截掉，而且**不报错**，只是内容少了）。
    #[test]
    fn the_snapshot_carries_a_preview_while_the_store_keeps_the_body() {
        let (_dir, store) = temp_store();
        let body = "汉".repeat(2000); // 6000 字节 > 4096
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            7, "work", &body,
        )))));
        store.select(1).unwrap();

        let snapshot = store.snapshot();
        let preview = &snapshot.entries[0];
        assert!(preview.truncated, "6000 字节该被标成截断");
        assert!(
            preview.text.len() <= crate::model::PREVIEW_BYTES,
            "快照里那份必须被截断，实际 {} 字节",
            preview.text.len()
        );
        assert_eq!(preview.text_bytes, 6000, "报的字节数要是**全文**的");

        // ② 全文还在，而且要取得到。
        assert_eq!(
            store.entry_text(7).as_deref(),
            Some(body.as_str()),
            "截断跑到 Store 里去了 —— 长文在本地被截掉，而且不报错"
        );
    }

    /// ⚠️★ `entry_text` **只认当前选中那个房间**：id 是每个房间各自单调的，
    /// 跨房间按 id 找会找到**别人的**那一条（而界面会把内容显示成这条的）。
    /// 取不到时给 `None`，**别给空串** —— 界面要能分清「取不到」和「内容本来就是空的」。
    #[test]
    fn entry_text_never_looks_across_rooms() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            7,
            "work",
            "在 work 里",
        )))));

        // 默认选中的是 `default` 房间，那边没有 7 号。
        assert_eq!(store.entry_text(7), None, "跨房间找到了同 id 的另一条");

        store.select(1).unwrap();
        assert_eq!(store.entry_text(7).as_deref(), Some("在 work 里"));
        assert_eq!(store.entry_text(999), None, "不存在的 id 要说取不到");
    }

    /// 一个两房间的配置（`default` / `work`），**两个房间都开着 ↑**、`work` 开着 ↓。
    ///
    /// ⚠️ 这里**故意**不照抄「两个方向默认都关」（Jonny 2026-09-26 定的那个默认值）：
    /// 这些用例要测的是「开关之间互不影响」，两个都关着就什么都测不出来。
    /// ⚠️ 默认值本身由 `the_first_run_writes_the_config_so_the_client_id_survives` 钉住。
    fn store_with(dir: &Path) -> Store {
        let config = ClientConfig {
            client_id: "client-a".to_owned(),
            channels: vec![
                Channel {
                    enable_upload: true,
                    ..Channel::new("默认", "http://127.0.0.1:9501")
                },
                Channel {
                    room: "work".to_owned(),
                    enable_upload: true,
                    enable_download: true,
                    ..Channel::new("工作", "http://127.0.0.1:9501")
                },
            ],
            ..ClientConfig::default()
        };
        Store::new(config, dir.join("client.json"), dir.to_path_buf())
    }

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let store = store_with(dir.path());
        (dir, store)
    }

    /// 下行的连接建立 → 状态是「已连接」，而且**边界**被记住了。
    #[test]
    fn a_connected_status_carries_the_watermark() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connecting {
                server: "http://127.0.0.1:9501".to_owned(),
                room: "work".to_owned(),
            },
        )));
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connected {
                latest_id: 137,
                limits: ServerLimits {
                    text_limit: 4096,
                    file_limit: 268_435_456,
                },
            },
        )));

        let snapshot = store.snapshot();
        assert_eq!(snapshot.rooms[1].connection.kind, "on");
        assert_eq!(snapshot.rooms[1].connection.latest_id, Some(137));
        assert_eq!(snapshot.rooms[1].room, "work", "状态挂在报它的那个房间上");
        // ⚠️ 限额要跟着状态一起到位 —— 上行要用它，而它**只在握手里**下发。
        assert_eq!(snapshot.limits.text_limit, 4096);
    }

    /// 一台别人设备（用来喂 `DevicesChanged`）。
    fn peer(id: &str, name: &str, kind: &str) -> PeerDevice {
        PeerDevice {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: kind.to_owned(),
        }
    }

    /// 夹具里那两个房间指向的**同一台**服务端（`store_with` 里两个都用它）。
    ///
    /// ⚠️ 单独一个常量：`ReceiverUpdate` 现在要带服务端了（见它的注释），
    /// 每处各写一遍字符串迟早会写歪一个字符 —— 而那种错的表现是「更新被丢掉」，
    /// 不报错，只是界面不动。
    const FIXTURE_SERVER: &str = "http://127.0.0.1:9501";

    /// 造一条属于 **`work`** 房间的更新。
    ///
    /// ⚠️ 大多数用例都用它 —— `work` 是 `store_with` 里的第二个房间，
    /// 也是唯一开着 ↓ 的那个。**要测「挂错房间」的用例才需要自己造**（见
    /// `each_room_keeps_its_own_connection`）。
    fn from_work(event: ReceiverEvent) -> ReceiverUpdate {
        ReceiverUpdate {
            server: FIXTURE_SERVER.to_owned(),
            room: "work".to_owned(),
            event,
        }
    }

    /// 某个房间那条连接（省得每处都写一长串）。
    fn connection(store: &Store, index: usize) -> ConnectionView {
        let snapshot = store.snapshot();
        snapshot.rooms[index].connection.clone()
    }

    /// 让**某个房间**那条连接连上（其余房间不受影响）。
    ///
    /// ⚠️★★ 服务端**从 `store` 自己的配置里取**，不写死 [`FIXTURE_SERVER`]：
    /// 真实代码给的也是 `channel.server`（见 `runtime.rs` 的 `spawn_receiver`），
    /// 照抄它就不会出现「夹具写的服务端和配置里的对不上」。
    /// 那种错的表现是**更新被静默丢掉**（身份是 (服务端, 房间) 两样，找不到就 `return`），
    /// 界面不动、也没有任何报错 —— 只有断言「状态该变了」才会炸，
    /// 于是看起来像「连接没连上」而不是「夹具写歪了」（9502 那个用例就是这么露出来的）。
    fn connect_room(store: &Store, room: &str) {
        let server = store
            .config()
            .channels
            .iter()
            .find(|channel| channel.room == room)
            .map(|channel| channel.server.clone())
            .unwrap_or_else(|| panic!("夹具的配置里没有 `{room}` 这个房间"));
        for event in [
            ReceiverEvent::Status(ReceiverStatus::Connecting {
                server: server.clone(),
                room: room.to_owned(),
            }),
            ReceiverEvent::Status(ReceiverStatus::Connected {
                latest_id: 1,
                limits: ServerLimits::default(),
            }),
        ] {
            store.apply_update(ReceiverUpdate {
                server: server.clone(),
                room: room.to_owned(),
                event,
            });
        }
    }

    /// 让 `work` 房间那条连接连上（大多数用例只用得上这一个）。
    fn connect_work(store: &Store) {
        connect_room(store, "work");
    }

    /// ⚠️★★ **两个服务端上的同名房间不能互相串**（2026-09-27 修的，用户实测踩到）。
    ///
    /// 房间身份是 **(服务端, 房间)** 两样：只按房间名找下标的话，
    /// `default@A` 与 `default@B` 的更新会**同时落进第一个**同名房间 ——
    /// 表现就是用户报的那条：「**本地这个房间明明连着（日志里有 WS 连上），
    /// 状态栏却显示 401**」（那条 401 其实是另一个服务端上同名房间的），
    /// 取回的历史也会串进别人家的房间。
    /// ⚠️★ 这两件事都**不报错**，只是显示错 —— 所以只有这条用例能拦住它。
    #[test]
    fn two_rooms_with_the_same_name_on_different_servers_do_not_mix() {
        let (_dir, store) = temp_store();
        // 再挂一个「另一个服务端上的 default」—— 这正是触发那条 bug 的形状。
        let mut channels = store.config().channels;
        let mut other = channels[0].clone();
        other.name = "Cf".to_owned();
        other.server = "https://cf.example".to_owned();
        channels.push(other);
        store.set_rooms(channels).unwrap();

        // 远端那条报 401，本地那条报已连接。
        store.apply_update(ReceiverUpdate {
            server: "https://cf.example".to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::Status(ReceiverStatus::Disconnected {
                reason: "HTTP 401：需要认证令牌".to_owned(),
            }),
        });
        store.apply_update(ReceiverUpdate {
            server: FIXTURE_SERVER.to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::Status(ReceiverStatus::Connected {
                latest_id: 9,
                limits: ServerLimits::default(),
            }),
        });

        assert_eq!(
            connection(&store, 0).kind,
            "on",
            "本地那个 default 被**另一个服务端**同名房间的 401 覆盖了"
        );
        assert_eq!(
            connection(&store, 2).kind,
            "off",
            "远端那条状态自己该是 off（它才是报 401 的那条）"
        );

        // 历史同理：推给远端那个房间，**不能**出现在本地这个同名房间里。
        store.push_history(
            "https://cf.example",
            "default",
            vec![text(1, "default", "远端的")],
        );
        assert_eq!(
            store.snapshot().rooms[0].count,
            0,
            "远端房间的历史串进了本地那个同名房间"
        );
        assert_eq!(store.snapshot().rooms[2].count, 1, "它该落在远端那个房间上");
    }

    /// ⚠️★ **每个房间各存各的**（§4.7）：每个房间**各自**有一条连接，
    /// 所以「谁有几台设备 / 谁的边界在哪」必须按房间分开。混在一起的话，
    /// 两个房间的 `connect` 会互相覆盖 —— 表现是数字乱跳，而且不报错。
    #[test]
    fn each_room_keeps_its_own_connection() {
        let (_dir, store) = temp_store();
        // 两个房间**都**连上（这正是新的模型：连接与 ↑/↓ 无关）。
        connect_work(&store);
        store.apply_update(ReceiverUpdate {
            server: FIXTURE_SERVER.to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::Status(ReceiverStatus::Connecting {
                server: FIXTURE_SERVER.to_owned(),
                room: "default".to_owned(),
            }),
        });
        store.apply_update(ReceiverUpdate {
            server: FIXTURE_SERVER.to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::Status(ReceiverStatus::Connected {
                latest_id: 5,
                limits: ServerLimits::default(),
            }),
        });

        // 各自报各自的设备。
        store.apply_update(from_work(ReceiverEvent::DevicesChanged(vec![
            peer("d1", "iPhone", "smartphone"),
            peer("d2", "MacBook", "desktop"),
        ])));
        store.apply_update(ReceiverUpdate {
            server: FIXTURE_SERVER.to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::DevicesChanged(vec![peer("d3", "iPad", "tablet")]),
        });

        assert_eq!(connection(&store, 0).kind, "on");
        assert_eq!(connection(&store, 1).kind, "on");
        // ⚠️ 本机要算一台：服务端那份列表里**没有本机**，而稿 1 的「N 台在线」是含本机的。
        assert_eq!(connection(&store, 0).devices.len(), 2, "本机 + iPad");
        assert_eq!(
            connection(&store, 1).devices.len(),
            3,
            "本机 + iPhone + MacBook"
        );
        assert_eq!(connection(&store, 0).devices[1].name, "iPad");
        assert_eq!(connection(&store, 1).devices[1].name, "iPhone");
        // 边界（水印）也是各一份 —— 共用的话一个房间的历史会被当成另一个房间的实时消息。
        assert_eq!(connection(&store, 0).latest_id, Some(5));
        assert_eq!(connection(&store, 1).latest_id, Some(1));
    }

    /// ⚠️★ 没连上时**一个都不画**，而不是画「1 台在线（只有我）」——
    /// 「数不到」和「只有我」是两件事。
    #[test]
    fn devices_are_empty_until_connected() {
        let (_dir, store) = temp_store();
        store.select(1).expect("切到 work");
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connecting {
                server: "http://127.0.0.1:9501".to_owned(),
                room: "work".to_owned(),
            },
        )));
        assert!(
            store.snapshot().rooms[1].connection.devices.is_empty(),
            "还没连上就是「不知道」"
        );
    }

    /// ⚠️★ 掉线 / 重连时**必须清掉**上一轮的设备：服务端是连接建立**之后**才逐台发
    /// `connect` 的，所以旧那份在「正在连」这一刻已经作废。不清的话症状是
    /// 「刚连上时显示的是上一个房间的设备」，而它会自己消失 —— 最难被发现的一种。
    #[test]
    fn a_stale_device_list_is_cleared_on_reconnect() {
        let (_dir, store) = temp_store();
        connect_work(&store);
        store.apply_update(from_work(ReceiverEvent::DevicesChanged(vec![peer(
            "d1",
            "iPhone",
            "smartphone",
        )])));
        store.select(1).expect("切到 work");
        assert_eq!(store.snapshot().rooms[1].connection.devices.len(), 2);

        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Disconnected {
                reason: "断了".to_owned(),
            },
        )));
        assert!(
            store.snapshot().rooms[1].connection.devices.is_empty(),
            "断开之后不能还留着上一轮那几台"
        );
    }

    /// ⚠️★ 延迟是**每个房间一份**（§4.3 + §4.7），而且掉线之后**必须清掉** ——
    /// 上一个房间的 12ms 挂在新房间上是编的。
    ///
    /// ⚠️ 这条测试以前叫 `the_latency_only_shows_on_the_downlink_room`，
    /// 断言的是「只有下行那个房间有数字」—— 那个前提**已经没了**
    ///（连接与 ↓ 解耦，每个房间各自量自己的）。
    #[test]
    fn the_latency_is_kept_per_room() {
        let (_dir, store) = temp_store();
        connect_work(&store);
        store.apply_update(from_work(ReceiverEvent::Latency(Latency::Rtt(12))));

        // 另一个房间没报过延迟 → 它是「还不知道」，**不能**跟着变成 12ms。
        assert_eq!(connection(&store, 0).latency.kind, "unknown");

        let latency = connection(&store, 1).latency;
        assert_eq!(latency.kind, "rtt");
        assert_eq!(latency.ms, 12);

        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Disconnected {
                reason: "断了".to_owned(),
            },
        )));
        assert_eq!(
            connection(&store, 1).latency.kind,
            "unknown",
            "断开之后不能还挂着上一轮的数字"
        );
    }

    /// ⚠️★ **超时不能退化成一个很大的数字**（§4.3 第 4 条）——
    /// 界面靠 `kind` 区分「慢」和「坏了」，压成一个 `ms` 就分不出来了。
    #[test]
    fn a_timeout_keeps_its_own_kind() {
        let (_dir, store) = temp_store();
        connect_work(&store);
        store.apply_update(from_work(ReceiverEvent::Latency(Latency::Timeout)));
        let latency = connection(&store, 1).latency;
        assert_eq!(latency.kind, "timeout");
        assert_eq!(latency.ms, 0, "超时时那个 ms 不许被界面读到");
    }

    /// ⚠️★ **老服务端（没有水印）不能显示成「已连接」** —— 那一刻客户端一行剪贴板都不写，
    /// 显示成「已连接」的话用户只会觉得「怎么同步不过来」。
    #[test]
    fn an_old_server_is_shown_as_a_warning_not_as_connected() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::NoWatermark,
        )));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.rooms[1].connection.kind, "warn");
        assert!(
            snapshot.rooms[1].connection.text.contains("太旧"),
            "要说清是「服务端版本太旧」：{}",
            snapshot.rooms[1].connection.text
        );
    }

    /// 断线要带原因（界面上不能只写「没连上」—— 用户需要知道是密码错了还是地址错了）。
    #[test]
    fn a_disconnect_keeps_the_reason() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Disconnected {
                reason: "未授权".to_owned(),
            },
        )));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.rooms[1].connection.kind, "off");
        assert!(
            snapshot.rooms[1].connection.text.contains("未授权"),
            "{}",
            snapshot.rooms[1].connection.text
        );
    }

    /// 实时条目进列表；**同 id 原地替换**（`update` 事件与 `receive` 走同一条路）。
    #[test]
    fn an_update_replaces_the_card_instead_of_adding_one() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            9, "work", "原文",
        )))));
        store.select(1).unwrap();
        assert_eq!(store.snapshot().entries.len(), 1);

        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            9,
            "work",
            "改过的",
        )))));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.entries.len(), 1, "同一条只能有一张卡片");
        assert_eq!(snapshot.entries[0].text, "改过的");
    }

    /// 历史来了要标成「取过了」；**并且乱序的 id 要插到正确位置**。
    #[test]
    fn history_is_ordered_and_marked_as_loaded() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connecting {
                server: "http://127.0.0.1:9501".to_owned(),
                room: "work".to_owned(),
            },
        )));
        // 服务端按 id 升序给，但**别依赖它** —— 客户端要自己保证顺序。
        store.apply_update(from_work(ReceiverEvent::History(vec![
            text(12, "work", "c"),
            text(10, "work", "a"),
            text(11, "work", "b"),
        ])));
        store.select(1).unwrap();
        let snapshot = store.snapshot();
        let ids: Vec<i32> = snapshot.entries.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, vec![10, 11, 12], "时间线必须按 id 升序");
        assert!(
            snapshot.rooms[1].history_loaded,
            "取过历史这件事要能被界面知道"
        );
    }

    /// 空历史**也**要标成「取过了」—— 否则界面分不出「房间是空的」与「还没取过」。
    #[test]
    fn an_empty_history_still_counts_as_loaded() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connecting {
                server: "http://127.0.0.1:9501".to_owned(),
                room: "work".to_owned(),
            },
        )));
        store.apply_update(from_work(ReceiverEvent::History(vec![])));
        assert!(store.snapshot().rooms[1].history_loaded);
    }

    /// 删除与清空要真的从列表里去掉（界面上留着一条已删的消息 = 用户会去点它）。
    #[test]
    fn revoked_and_cleared_remove_entries() {
        let (_dir, store) = temp_store();
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connecting {
                server: "http://127.0.0.1:9501".to_owned(),
                room: "work".to_owned(),
            },
        )));
        store.apply_update(from_work(ReceiverEvent::History(vec![
            text(1, "work", "a"),
            text(2, "work", "b"),
        ])));
        store.apply_update(from_work(ReceiverEvent::Revoked { id: 1 }));
        assert_eq!(store.snapshot().rooms[1].count, 1);

        store.apply_update(from_work(ReceiverEvent::Cleared));
        assert_eq!(store.snapshot().rooms[1].count, 0);
    }

    /// ⚠️★ 列表**有界**：超了就从最旧的丢，界面要照实说上限是多少。
    #[test]
    fn the_list_is_bounded_and_the_bound_is_visible() {
        let (_dir, store) = temp_store();
        for id in 1..=(MAX_ENTRIES_PER_ROOM as i32 + 50) {
            store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
                id, "work", "x",
            )))));
        }
        let snapshot = store.snapshot();
        assert_eq!(snapshot.rooms[1].count, MAX_ENTRIES_PER_ROOM);
        assert_eq!(snapshot.max_entries, MAX_ENTRIES_PER_ROOM);
        // 丢的是**最旧**的那些，保留的必须是最近的。
        store.select(1).unwrap();
        assert_eq!(
            store.snapshot().entries[0].id,
            51,
            "最旧的 50 条被丢掉了，剩下的是最近的"
        );
    }

    /// ⚠️★ 房间的**正文字节量**必须是**全文**的字节数，不是快照里那份预览的长度。
    ///
    /// 它是「把 `text.limit` 调大之后本机到底多占了多少」的**量具**（`RoomView::text_bytes`）——
    /// 拿一个被钉在 4 KiB 的数去量长文等于没量，而且那个数**看起来还挺合理**（不报错），
    /// 所以只有钉住它，量出来的数才敢用。
    ///
    /// ⚠️ 它同样是**派生**的（`snapshot()` 现算），于是 `Revoked` / `Cleared` 之后必然跟着减 ——
    /// 这条顺便把「计数漂移」那一类钉住了：将来谁换成增量计数器而漏了某处减法，这里会红。
    #[test]
    fn the_room_bytes_count_full_bodies_and_follow_removals() {
        let (_dir, store) = temp_store();
        let long = "中".repeat(100_000); // 100_000 个汉字 = 300_000 字节
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            1, "work", &long,
        )))));
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            2, "work", "短",
        )))));

        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.rooms[1].text_bytes,
            300_000 + "短".len(),
            "要是**全文**字节数（快照里那条只有 4096 字节的预览）"
        );
        // ⚠️ 按**房间**算，不是全局一个数
        assert_eq!(snapshot.rooms[0].text_bytes, 0, "另一个房间不该被算进去");
        // 与快照里那份预览分得开：预览是短的，字节数是真的
        store.select(1).unwrap();
        let preview_len = store.snapshot().entries[0].text.len();
        assert!(preview_len <= crate::model::PREVIEW_BYTES, "快照那份是预览");
        // ⚠️ 是 `<=` 不是 `==`：截断切在**字符边界**上，而 4096 不是 3 的倍数 ——
        // 中文正文的预览实际是 4095 字节（多切一个字节就会切开一个汉字，那是 `panic`）。
        // 上面那个 `assert_eq!` 的数**是**300_000，两个数差着两个数量级，这才是重点。
        assert_ne!(preview_len, 300_000, "预览等于全文 = 等于没截断");

        // 删一条 → 跟着减（派生实现的必然结果，但**必须**钉住）
        store.apply_update(from_work(ReceiverEvent::Revoked { id: 1 }));
        assert_eq!(
            store.snapshot().rooms[1].text_bytes,
            "短".len(),
            "删掉那条长文之后字节数要跟着掉"
        );

        // 清空 → 归零
        store.apply_update(from_work(ReceiverEvent::Cleared));
        assert_eq!(store.snapshot().rooms[1].text_bytes, 0, "清空之后归零");
    }

    // ── 每房间的**字节界**（`MAX_BYTES_PER_ROOM`）────────────────────────

    /// ⚠️★ 超了字节界就从**最旧**那端丢 —— 而**条数界（200）在这里根本够不着**，
    /// 这正是加第二道界的意义（一条多大由服务端的 `text.limit` 决定）。
    ///
    /// 用「6 条 × 500 KB」：4 条 = 2.0 MB 装得下，5 条 = 2.5 MB 装不下 →
    /// 每插一条就裁一次，最后留下的是**最近的 4 条**。
    #[test]
    fn the_byte_bound_drops_the_oldest_entries() {
        let (_dir, store) = temp_store();
        let big = "x".repeat(500_000);
        for id in 1..=6 {
            store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
                id, "work", &big,
            )))));
        }
        store.select(1).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot.rooms[1].count, 4,
            "2.5 MB 装进 2 MiB 的界 → 只留 4 条（条数界 200 在这里够不着）"
        );
        assert_eq!(
            snapshot.entries[0].id, 3,
            "丢的是**最旧**的：1、2 被挤掉，留下的最旧一条是 3"
        );
        assert_eq!(snapshot.entries.last().unwrap().id, 6, "最新那条永远在里面");
        assert!(
            snapshot.rooms[1].text_bytes <= MAX_BYTES_PER_ROOM,
            "裁完之后总量必须真的在界内（现在 {} 字节）",
            snapshot.rooms[1].text_bytes
        );
        assert_eq!(snapshot.max_bytes, MAX_BYTES_PER_ROOM, "上限也要给界面");
    }

    /// ⚠️★ **单独一条**就超预算时**照样留着它** —— 列表空掉 = 「刚收到的那条消息
    /// 在自己客户端上都不显示」，而且**不报错**。
    ///
    /// 与 `handlers.rs` 的 `page_bytes_to_drop` 是同一条规矩（那边叫「空数组 = 到头了」），
    /// 但这边**更该**留：那边丢的是「还没拉到的历史」，这边丢的是**已经在本机**的那条。
    #[test]
    fn a_single_body_over_the_byte_bound_is_still_kept() {
        let (_dir, store) = temp_store();
        let huge = "x".repeat(MAX_BYTES_PER_ROOM + 1000);
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            1, "work", &huge,
        )))));
        store.select(1).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot.rooms[1].count, 1,
            "只有一条且它超预算 → 一条都不许丢"
        );
        // ⚠️ 它自己确实比界大 —— 这是**有意的**：这道界是「尽量收住」，不是「硬拒」。
        // 硬拒的代价是「消息看不见」，那比多占那几 MB 严重得多。
        assert!(snapshot.rooms[1].text_bytes > MAX_BYTES_PER_ROOM);
    }

    /// ⚠️ 反过来说：超预算的那条**如果后面来了别的**，它就会（也应该）被挤掉 ——
    /// 丢掉它正好让总量回到界内，而留下的是**最新**那条。
    #[test]
    fn an_oversized_body_is_evicted_once_something_newer_arrives() {
        let (_dir, store) = temp_store();
        let huge = "x".repeat(MAX_BYTES_PER_ROOM + 1000);
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            1, "work", &huge,
        )))));
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            2, "work", "新的",
        )))));
        store.select(1).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(snapshot.rooms[1].count, 1);
        assert_eq!(snapshot.entries[0].id, 2, "留下的是**最新**那条");
        assert!(snapshot.rooms[1].text_bytes <= MAX_BYTES_PER_ROOM);
    }

    /// ⚠️★ 字节界只数**条目正文**：文件条目**没有正文**（它的字节在服务端，
    /// 取要另发 `GET /file/...`）。
    ///
    /// 这条钉的是一个**灾难性**的写法：拿 `FileReceive::size`（盘上那个大小）当「占了多少」。
    /// 那样一个 100 MB 的文件就会把整个房间挤空 —— 而界面上只会看到「消息没了」。
    #[test]
    fn file_entries_do_not_count_toward_the_byte_bound() {
        let (_dir, store) = temp_store();
        for id in 1..=10 {
            let entry = ReceiveHolder::File(FileReceive {
                base: ReceiveBase {
                    id,
                    kind: "file".to_owned(),
                    room: "work".to_owned(),
                    timestamp: 1,
                    ..ReceiveBase::default()
                },
                name: "一个很大的文件.bin".to_owned(),
                size: 100 * 1024 * 1024,
                ..FileReceive::default()
            });
            store.apply_update(from_work(ReceiverEvent::Entry(Box::new(entry))));
        }
        store.select(1).unwrap();
        let snapshot = store.snapshot();

        assert_eq!(
            snapshot.rooms[1].count, 10,
            "10 个「100 MB」的文件不该被字节界挤掉（它们的字节不在本机这份列表里）"
        );
        assert_eq!(snapshot.rooms[1].text_bytes, 0, "文件条目的正文字节数是 0");
    }

    /// ⚠️★ 字节界必须**真的**装得下缺省部署的一房间 —— 否则「防长文」会变成
    /// 「默认部署开始丢消息」。与 `handlers.rs` 的
    /// `hard_cap_leaves_the_default_deployment_alone` 是同一条纪律：
    /// **缺省部署的行为一个字都不许变**。
    #[test]
    fn the_byte_bound_leaves_the_default_deployment_alone() {
        let per_entry = clip9_core::config::TextConfig::default().limit as usize;
        let worst = MAX_ENTRIES_PER_ROOM * per_entry;
        assert!(
            worst <= MAX_BYTES_PER_ROOM,
            "缺省配置下最坏的一房间是 {worst} 字节 > 字节界 {MAX_BYTES_PER_ROOM} \
             —— 默认部署会开始丢消息"
        );
    }

    // ── 版本号（`Snapshot::version`）：**每一条会改动快照的写入各一条用例** ──
    //
    // ⚠️★ 这一组必须跟着写入点一起长大。`Snapshot::version` 那一段注释里说了：
    // 「漏一处」= 「那个字段变了界面不刷新」，而且**完全静默**。
    // 而「加了新写入却忘了加用例」是**同一种漏法的第二层** —— 所以宁可这几条看着啰嗦。
    // ⚠️ 换掉原来的「页面比整份 JSON」之后，这份逐条清单就是**唯一的**保护 ——
    // 好处是它终于在一个**有测试运行器**的地方（页面那一侧没有）。

    /// 断言这次写入让版本号**前进**（`seed` 先铺状态；铺的时候前进的不算）。
    fn assert_bumps(name: &str, seed: impl Fn(&Store), action: impl Fn(&Store)) {
        let (_dir, store) = temp_store();
        seed(&store);
        let before = store.snapshot().version;
        action(&store);
        assert!(
            store.snapshot().version > before,
            "「{name}」没有让版本号前进 —— 那个字段变了，界面却不会刷新"
        );
    }

    /// 断言这次写入**不**让版本号前进：值一模一样时不该触发一次整屏重绘。
    ///
    /// ⚠️ 这一侧同样要钉：`Latency` 这类**每轮 ping 都可能来**的事件，不判就前进的话
    /// 会退化成「每 1.4 秒重绘一次」—— 那正是换版本号要消灭的代价。
    fn assert_quiet(name: &str, seed: impl Fn(&Store), action: impl Fn(&Store)) {
        let (_dir, store) = temp_store();
        seed(&store);
        let before = store.snapshot().version;
        action(&store);
        assert_eq!(
            store.snapshot().version,
            before,
            "「{name}」在**值没变**的情况下也让版本号前进了 —— 白重绘一次"
        );
    }

    /// ⚠️★ 提示**必须**算在版本号里：§8.1 第 2 条就是「`shapeOf` 漏了 `notice` →
    /// 三类提示永远画不出来」（上传失败、因为开关关着而跳过…）——
    /// 那几条**不改动别的任何字段**，所以漏掉就是彻底看不见。
    #[test]
    fn a_notice_bumps_the_version() {
        assert_bumps("notice", |_| {}, |store| store.notice("err", "上传失败"));
        assert_quiet(
            "notice（同一条再来一次）",
            |store| store.notice("err", "上传失败"),
            |store| store.notice("err", "上传失败"),
        );
    }

    #[test]
    fn clearing_a_notice_bumps_the_version() {
        assert_bumps(
            "clear_notice",
            |store| store.notice("err", "x"),
            |store| store.clear_notice(),
        );
        assert_quiet(
            "clear_notice（本来就没有）",
            |_| {},
            |store| {
                store.clear_notice();
            },
        );
    }

    #[test]
    fn selecting_a_room_bumps_the_version() {
        assert_bumps(
            "select",
            |_| {},
            |store| {
                store.select(1).expect("切到第二个房间");
            },
        );
    }

    #[test]
    fn an_incoming_entry_bumps_the_version() {
        assert_bumps(
            "receive",
            |_| {},
            |store| {
                store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
                    1, "work", "a",
                )))));
            },
        );
    }

    #[test]
    fn an_incoming_history_bumps_the_version() {
        assert_bumps(
            "history",
            |_| {},
            |store| {
                store.apply_update(from_work(ReceiverEvent::History(vec![text(
                    1, "work", "a",
                )])));
            },
        );
    }

    /// ⚠️ 撤销一条**本来就不在列表里**的（房间里没这条，或者**它已经被字节界挤掉了**）
    /// → 什么都没变，不该重绘。⚠️ 有了 `MAX_BYTES_PER_ROOM` 之后这不是罕见情况：
    /// 「长文被挤掉」与「它同时被撤销」是同一类用户会做的事。
    #[test]
    fn revoking_bumps_only_when_something_was_actually_removed() {
        assert_bumps(
            "revoke",
            |store| {
                store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
                    1, "work", "a",
                )))));
            },
            |store| store.apply_update(from_work(ReceiverEvent::Revoked { id: 1 })),
        );
        assert_quiet(
            "revoke（不存在的 id）",
            |_| {},
            |store| {
                store.apply_update(from_work(ReceiverEvent::Revoked { id: 99 }));
            },
        );
    }

    #[test]
    fn clearing_bumps_only_when_the_room_was_not_already_empty() {
        assert_bumps(
            "clear",
            |store| {
                store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
                    1, "work", "a",
                )))));
            },
            |store| store.apply_update(from_work(ReceiverEvent::Cleared)),
        );
        assert_quiet(
            "clear（本来就是空的）",
            |_| {},
            |store| {
                store.apply_update(from_work(ReceiverEvent::Cleared));
            },
        );
    }

    /// ⚠️★ 设备表 / 延迟是**每轮都可能来**的高频事件 → 「值没变」**必须不**前进。
    #[test]
    fn devices_and_latency_bump_only_when_the_value_changes() {
        assert_bumps(
            "devices",
            |_| {},
            |store| {
                store.apply_update(from_work(ReceiverEvent::DevicesChanged(vec![peer(
                    "p1",
                    "手机",
                    "smartphone",
                )])));
            },
        );
        assert_quiet(
            "devices（同一份再来一次）",
            |store| {
                store.apply_update(from_work(ReceiverEvent::DevicesChanged(vec![peer(
                    "p1",
                    "手机",
                    "smartphone",
                )])));
            },
            |store| {
                store.apply_update(from_work(ReceiverEvent::DevicesChanged(vec![peer(
                    "p1",
                    "手机",
                    "smartphone",
                )])));
            },
        );

        assert_bumps(
            "latency",
            |_| {},
            |store| {
                store.apply_update(from_work(ReceiverEvent::Latency(Latency::Rtt(7))));
            },
        );
        assert_quiet(
            "latency（同一个数再来一次）",
            |store| store.apply_update(from_work(ReceiverEvent::Latency(Latency::Rtt(7)))),
            |store| store.apply_update(from_work(ReceiverEvent::Latency(Latency::Rtt(7)))),
        );
    }

    /// ⚠️★ 连接状态里有个坑：**掉线 / 重连时 `apply_status` 会顺带清掉设备与延迟**，
    /// 而那两处也在快照里 —— 只看传进来的 `status` 就会漏掉那一次变化。
    /// （表现：断了之后设备行还挂着上一轮的几台，直到下一个事件才消失。）
    #[test]
    fn a_status_bumps_on_change_and_not_on_a_repeat() {
        let connected = || {
            ReceiverEvent::Status(ReceiverStatus::Connected {
                latest_id: 3,
                limits: ServerLimits::default(),
            })
        };
        let disconnected = || {
            ReceiverEvent::Status(ReceiverStatus::Disconnected {
                reason: "测试".to_owned(),
            })
        };
        assert_bumps(
            "status",
            |_| {},
            |store| {
                store.apply_update(from_work(connected()));
            },
        );
        assert_quiet(
            "status（同一个状态再来一次）",
            |store| store.apply_update(from_work(connected())),
            |store| store.apply_update(from_work(connected())),
        );

        // ⚠️★ 这一条的形状很讲究：铺成「已断开 + 有一台设备」，再喂**同一个**断线事件 ——
        // 那样 `status` 一个字都不变，**只有设备被清掉**。把「清设备」算进那次变化里
        // 才测得到本函数头说的那个坑。
        // ⚠️ 第一版写的是「先连上、再掉线」——那样 `status` 自己也变了，
        // 「只比 status」的错误写法**照样能过**（跑变异验证时才发现用例形状不对）。
        assert_bumps(
            "status（同一个断线事件，只在顺带清设备那次算数）",
            |store| {
                store.apply_update(from_work(disconnected()));
                store.apply_update(from_work(ReceiverEvent::DevicesChanged(vec![peer(
                    "p1",
                    "手机",
                    "smartphone",
                )])));
            },
            |store| store.apply_update(from_work(disconnected())),
        );
    }

    #[test]
    fn refreshing_history_bumps_the_version() {
        assert_bumps(
            "push_history",
            |_| {},
            |store| {
                store.push_history(FIXTURE_SERVER, "work", vec![text(1, "work", "a")]);
            },
        );
    }

    /// 本地设置（用户动作，低频）—— 一律**直接前进**（前进规则见 `Inner::touch`）。
    #[test]
    fn local_settings_bump_the_version() {
        assert_bumps(
            "set_upload",
            |_| {},
            |store| {
                store.set_upload(0, false).expect("关掉第一个房间的上行");
            },
        );
        assert_bumps(
            "set_download",
            |_| {},
            |store| {
                store.set_download(Some(0)).expect("换下行房间");
            },
        );
        assert_bumps("set_autostart", |_| {}, |store| store.set_autostart(true));
        assert_bumps(
            "set_sync_scope",
            |_| {},
            |store| {
                store.set_sync_scope(&SyncScopePatch {
                    enable_text: Some(false),
                    ..SyncScopePatch::default()
                });
            },
        );
        assert_bumps(
            "set_rooms",
            |_| {},
            |store| {
                let channels = store.config().channels;
                store.set_rooms(channels).expect("换同一份清单");
            },
        );
    }

    /// ⚠️★ **下载全局只能一个**：给第二个房间开下载，第一个**自动关掉**。
    /// 这是 §4.1 第 2、4 条，也是行为基准 `clip-sync` 用「取第一个」时踩的那个坑。
    #[test]
    fn turning_on_a_second_download_turns_the_first_one_off() {
        let (_dir, store) = temp_store();
        store.set_download(Some(0)).unwrap();
        assert!(store.snapshot().rooms[0].download);
        assert!(!store.snapshot().rooms[1].download);

        store.set_download(Some(1)).unwrap();
        assert!(!store.snapshot().rooms[0].download, "前一个要自动关掉");
        assert!(store.snapshot().rooms[1].download);

        // 全关也是一个合法状态（下载默认就是关的）。
        store.set_download(None).unwrap();
        assert!(!store.snapshot().rooms[0].download);
        assert!(!store.snapshot().rooms[1].download);
    }

    /// 越界要**报错**（页面传错下标时说清楚），不是静默夹住。
    #[test]
    fn out_of_range_is_an_error_not_a_silent_clamp() {
        let (_dir, store) = temp_store();
        assert!(store.select(9).is_err());
        assert!(store.set_download(Some(9)).is_err());
        assert!(store.set_upload(9, true).is_err());
    }

    /// 上行可以是**多个房间**：关掉其中一个不影响别的（§4.1 第 1 条）。
    #[test]
    fn upload_switches_are_independent_per_room() {
        let (_dir, store) = temp_store();
        store.set_upload(0, false).unwrap();
        assert!(!store.snapshot().rooms[0].upload);
        assert!(store.snapshot().rooms[1].upload, "别的房间不受影响");
        assert_eq!(store.config().upload_channels().len(), 1);
    }

    /// ⚠️★ 手改过的配置（真的开了两个下载）要**报出来**，而不是悄悄挑一个 ——
    /// 「配了不生效」是这个项目最忌讳的一类。
    #[test]
    fn a_hand_edited_double_download_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let config = ClientConfig {
            client_id: "client-a".to_owned(),
            channels: vec![
                Channel {
                    enable_download: true,
                    ..Channel::new("a", "http://127.0.0.1:9501")
                },
                Channel {
                    room: "b".to_owned(),
                    enable_download: true,
                    ..Channel::new("b", "http://127.0.0.1:9501")
                },
            ],
            ..ClientConfig::default()
        };
        let store = Store::new(
            config,
            dir.path().join("client.json"),
            dir.path().to_path_buf(),
        );
        assert!(
            !store.snapshot().problems.is_empty(),
            "两个房间都开着下载，这是配错了，必须在界面上说出来"
        );
    }

    /// ⚠️★ 第一次运行**必须把配置写下去**：`client_id` 是首次生成的，
    /// 不落盘的话每次启动都换一个 id —— 于是「这条是不是我发的」**永远**判不出来，
    /// 而且**没有任何报错**。
    #[test]
    fn the_first_run_writes_the_config_so_the_client_id_survives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("client.json");

        let first = load_config(&path, dir.path(), "http://127.0.0.1:9501").unwrap();
        assert!(path.exists(), "第一次运行就要落盘");
        assert_eq!(first.channels.len(), 1);
        assert_eq!(first.channels[0].room, "default");
        // ⚠️★ 首次运行的默认房间**两个方向都不开** ——
        // Jonny 2026-09-26 拍板：「上传和下载都默认关闭」。
        // 装完不该动你的剪贴板，也不该把本机剪贴板往房间里发。
        // ⚠️ 而客户端**照常连着**每个房间（§4.7）—— 所以第一眼看到的是
        //「都连上了、看得到设备和延迟，但没有东西在流」，而不是「连不上」。
        assert!(
            !first.channels[0].enable_download,
            "装完不该自动接管剪贴板（Jonny 2026-09-26 定）"
        );
        assert!(
            !first.channels[0].enable_upload,
            "装完也不该自动把本机剪贴板发出去（Jonny 2026-09-26 定）"
        );
        assert!(!first.client_id.is_empty());

        let second = load_config(&path, dir.path(), "http://127.0.0.1:9501").unwrap();
        assert_eq!(
            second.client_id, first.client_id,
            "第二次启动必须是同一个 id，否则界面认不出自己的消息"
        );
    }

    /// ⚠️★ 配置**坏了要报错，而且不许覆盖它** —— 悄悄换成默认值等于
    /// 把用户的服务端地址、房间凭据、方向开关**全清掉**。
    #[test]
    fn a_broken_config_is_reported_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("client.json");
        std::fs::write(&path, "{ 这不是 JSON").unwrap();

        let err = load_config(&path, dir.path(), "http://127.0.0.1:9501").unwrap_err();
        assert!(err.contains("client.json"), "要说清是哪个文件：{err}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ 这不是 JSON",
            "坏掉的那个文件不能被默认值覆盖掉"
        );
    }

    /// ⚠️★ **空响应也要落在正确的房间上**：以前是「从 `entries.first()` 猜房间，
    /// 猜不到就回落到下行房间」—— 于是刷新一个**空的新房间**会把**另一个房间**
    /// 标成「已加载」，而用户切过去看到空列表写着「这个房间还没有内容」，
    /// 可它其实有内容。房间名由调用方给之后，这条就不可能再错。
    #[test]
    fn an_empty_refresh_marks_the_room_that_was_asked_for() {
        let (_dir, store) = temp_store();
        // 下行连的是 work（第二个），而刷新的是「默认」（第一个）。
        store.apply_update(from_work(ReceiverEvent::Status(
            ReceiverStatus::Connecting {
                server: "http://127.0.0.1:9501".to_owned(),
                room: "work".to_owned(),
            },
        )));
        store.push_history(FIXTURE_SERVER, "default", vec![]);

        let snapshot = store.snapshot();
        assert!(
            snapshot.rooms[0].history_loaded,
            "被刷新的那个房间要标成已加载"
        );
        assert!(
            !snapshot.rooms[1].history_loaded,
            "下行那个房间**不该**被顺手标上（它没被刷新过）"
        );
    }

    /// 原子写：写完之后没有临时文件残留，读回来的内容是**完整**的。
    #[test]
    fn saving_is_atomic_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("client.json");
        // ⚠️ 结构体更新语法，别「先 default 再逐字段赋值」（`clippy::field_reassign_with_default`）。
        let config = ClientConfig {
            client_id: "client-a".to_owned(),
            channels: vec![Channel::new("默认", "http://127.0.0.1:9501")],
            ..ClientConfig::default()
        };

        save_config(&path, &config).unwrap();
        let back = load_config(&path, dir.path(), "http://127.0.0.1:9501").unwrap();
        assert_eq!(back.client_id, "client-a");
        assert_eq!(back.channels[0].server, "http://127.0.0.1:9501");

        // 目录建了（相对路径落在数据目录下），而临时文件**不在**了。
        assert!(path.parent().unwrap().exists());
        let leftovers: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该有临时文件残留：{leftovers:?}");
    }

    /// `base_dir` 要在读回来之后**重新挂上**（它不落盘），否则相对下载目录会说不出路径。
    #[test]
    fn the_base_dir_is_re_attached_after_loading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("client.json");
        std::fs::write(
            &path,
            r#"{"channels":[{"name":"默认","server":"http://127.0.0.1:9501"}]}"#,
        )
        .unwrap();

        let config = load_config(&path, dir.path(), "http://127.0.0.1:9501").unwrap();
        assert_eq!(config.base_dir.as_deref(), Some(dir.path()));
        // 配置文件里**不该**留下数据目录。
        assert!(!std::fs::read_to_string(&path).unwrap().contains("base_dir"));
    }

    /// 数据目录的形状（macOS / Linux 各一条），⚠️ 相对下载目录要落在它下面（§5）。
    #[test]
    fn the_data_dir_follows_the_platform_conventions() {
        let home = Path::new("/home/u");
        assert_eq!(
            data_dir_for("macos", Some(home), None),
            PathBuf::from("/home/u/Library/Application Support/clip9")
        );
        assert_eq!(
            data_dir_for("linux", Some(home), None),
            PathBuf::from("/home/u/.config/clip9")
        );
        // XDG 显式设了就用它。
        assert_eq!(
            data_dir_for("linux", Some(home), Some(Path::new("/xdg"))),
            PathBuf::from("/xdg/clip9")
        );
        // 什么都没有时给一个**相对**目录（而不是 panic）。
        assert_eq!(data_dir_for("linux", None, None), PathBuf::from("clip9"));
    }

    /// ⚠️★ 换房间清单要**按房间名搬状态**，不能按下标 ——
    /// 删掉第一个房间时后面的下标全变，按下标搬等于把每个房间的消息**错位一格**，
    /// 而界面上照常渲染、**不报错**（用户只会觉得「消息串台了」）。
    #[test]
    fn replacing_rooms_carries_the_state_by_name_not_by_index() {
        let (_dir, store) = temp_store();
        // 两个房间各放一条（`work` 是第二个）。
        // ⚠️★ 房间名由**更新自己带**（§4.7），不是从条目的 `room` 字段推 ——
        // 所以这里要显式给 `default`，不能图省事全用 `from_work`。
        store.apply_update(ReceiverUpdate {
            server: FIXTURE_SERVER.to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::Entry(Box::new(text(1, "default", "来自默认"))),
        });
        store.apply_update(from_work(ReceiverEvent::Entry(Box::new(text(
            2,
            "work",
            "来自工作",
        )))));

        // 删掉第一个（default）→ 现在 `work` 排到了下标 0。
        let mut channels = store.config().channels;
        channels.remove(0);
        store.set_rooms(channels).unwrap();

        let snapshot = store.snapshot();
        assert_eq!(snapshot.rooms.len(), 1);
        assert_eq!(snapshot.rooms[0].room, "work");
        // ⚠️ 关键：`work` 那条要**跟着它走**，而不是留在下标 0 上。
        store.select(0).unwrap();
        let entries = &store.snapshot().entries;
        assert_eq!(entries.len(), 1, "work 该带着自己的那一条");
        assert_eq!(entries[0].text, "来自工作", "不能串到别的房间去");
    }

    /// ⚠️ 删掉最后一个房间之后，`selected` 要夹回合法范围 ——
    /// 不夹的话 `snapshot()` 里 `rooms.get(selected)` 会拿到 `None`，
    /// 界面显示成「没有房间」而配置里明明有。
    #[test]
    fn removing_the_selected_room_clamps_the_selection() {
        let (_dir, store) = temp_store();
        store.select(1).unwrap();
        let mut channels = store.config().channels;
        channels.truncate(1);
        store.set_rooms(channels).unwrap();
        assert_eq!(store.snapshot().selected, 0, "夹回最后一个合法下标");
    }

    /// 加一个新房间：它要是**空状态**（`history_loaded = false`）——
    /// 于是界面显示「还没加载历史」，而不是一个骗人的空列表。
    #[test]
    fn a_new_room_starts_unloaded() {
        let (_dir, store) = temp_store();
        let mut channels = store.config().channels;
        channels.push(Channel::new("新的", "http://127.0.0.1:9502"));
        store.set_rooms(channels).unwrap();
        let snapshot = store.snapshot();
        assert_eq!(snapshot.rooms.len(), 3);
        assert_eq!(snapshot.rooms[2].count, 0);
        assert!(!snapshot.rooms[2].history_loaded, "新房间该是「还没加载」");
    }

    /// ⚠️ 同步范围的补丁是**逐字段**的：只改一项时别的项不动。
    /// 全量覆盖的话，「改 A 把 B 改回去」—— 用户会以为设置没保存。
    #[test]
    fn a_sync_scope_patch_only_touches_what_it_carries() {
        let (_dir, store) = temp_store();
        let before = store.config();
        store.set_sync_scope(&SyncScopePatch {
            enable_file: Some(false),
            ..SyncScopePatch::default()
        });
        let after = store.config();
        assert!(!after.enable_file, "改的那项要生效");
        assert_eq!(after.enable_text, before.enable_text, "别的项不许动");
        assert_eq!(after.poll_interval_ms, before.poll_interval_ms);
    }

    /// ⚠️★ **没开「收进剪贴板」也要照常连**（§4.7）。
    ///
    /// 这条测试**推翻的是它自己以前那个版本**：原来它断言的是
    /// 「一个下载房间都没开 → 状态是 `off`、文案说『没开收进剪贴板』」——
    /// 那个行为的前提是「连接由 ↓ 控制」，而 Jonny 2026-09-26 明确否掉了它：
    /// 「下载本就不应该控制房间的任何功能」。
    /// ⚠️ 老行为的具体后果是：装完（两个开关都默认关）**一个连接都不建**，
    /// 于是设备行、延迟、实时消息、历史全部消失，看起来像「客户端坏了」。
    #[test]
    fn rooms_connect_even_with_download_off() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(
            ClientConfig {
                channels: vec![Channel::new("默认", "http://127.0.0.1:9502")],
                ..ClientConfig::default()
            },
            dir.path().join("client.json"),
            dir.path().to_path_buf(),
        );

        // ⚠️ 默认两个方向都关（Jonny 2026-09-26）。
        assert!(!store.config().channels[0].enable_download);
        assert!(!store.config().channels[0].enable_upload);

        // 连接任务还没报第一拍 → 「还没开始连」，**不是**「连不上」。
        let before = connection(&store, 0);
        assert_eq!(before.kind, "off");
        assert!(before.devices.is_empty(), "还没连上就是「不知道」");

        // 连接任务报上来了 —— **即使 ↓ 是关的**，状态也该正常变成「已连接」。
        connect_room(&store, "default");
        let after = connection(&store, 0);
        assert_eq!(after.kind, "on", "↓ 关着也要连（连接与 ↓ 无关）");
        assert_eq!(after.devices.len(), 1, "至少能看到本机这一台");
    }

    /// ⚠️ 轮询间隔的 `0` 要夹到 1ms：`thread::sleep(0)` 会让监听线程**空转**，
    /// 症状是「风扇转起来、CPU 高」，和「同步不准」完全联想不到一起。
    #[test]
    fn a_zero_poll_interval_is_clamped() {
        let (_dir, store) = temp_store();
        store.set_sync_scope(&SyncScopePatch {
            poll_interval_ms: Some(0),
            ..SyncScopePatch::default()
        });
        assert_eq!(store.config().poll_interval_ms, 1);
    }
}
