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

use clip9_client::{ClientConfig, ReceiverStatus, ReceiverUpdate, ServerLimits};
use clip9_protocol::ReceiveHolder;
use serde::Serialize;

use crate::model::{EntryView, StatusView};

/// 每个房间在界面上**留多少条**。
///
/// ⚠️ 这**不是**「历史长度」—— 历史长度是服务端的 `server.history` 旋钮，而这里管的是
/// 「本机窗口里摆多少张卡片」。留着的目的是**有界**：一个有几千条历史的房间，
/// 每次重绘都要序列化几千条，那是白花的力气（而界面上根本看不到那么远）。
/// ⚠️ 界面**必须**把这件事说出来（「只显示最近 200 条」），否则用户会以为前面的没了。
pub(crate) const MAX_ENTRIES_PER_ROOM: usize = 200;

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
    /// 取过历史没有（界面上据此显示「还没加载」而不是一个空列表）。
    pub history_loaded: bool,
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
    pub status: StatusView,
    /// 服务端限额（`0` = 还没连上、**不知道**）。
    pub limits: ServerLimitsView,
    /// 配置里的毛病（`ClientConfig::problems`）—— **摆出来，而不是自己在内部悄悄修正**。
    pub problems: Vec<String>,
    /// 剪贴板监听是不是开着（标题栏那个开关）。
    pub monitoring: bool,
    pub notice: Option<Notice>,
    /// 配置与数据目录（用户要知道自己的配置在哪）。
    pub config_path: String,
    pub data_dir: String,
    /// 每个房间最多留多少条（界面要照实说）。
    pub max_entries: usize,
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

/// 一个房间在本机的状态。
#[derive(Debug, Default)]
struct Room {
    entries: Vec<EntryView>,
    history_loaded: bool,
}

/// 全部内存状态。
struct Inner {
    config: ClientConfig,
    rooms: Vec<Room>,
    selected: usize,
    status: StatusView,
    limits: ServerLimits,
    monitoring: bool,
    notice: Option<Notice>,
    /// 下行连的是哪个房间。
    ///
    /// ⚠️ 为什么需要它：[`ReceiverUpdate`] 里的 `History`（空历史时）/ `Revoked` /
    /// `Cleared` **都不带房间名** —— 它们说的是「这个连接」发生的事，
    /// 而下行的那个连接**只对应下载通道那一个房间**。所以房间得自己记住。
    downlink_room: Option<String>,
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
        // ⚠️⚠️ 这里**必须**读配置，而不是写死 true：写死的话，配置里把监听关掉的
        // 用户会看到界面上写着「监听中」—— 而实际上本机剪贴板**根本没被读**。
        // 那种「界面说一套、实际做另一套」正是这个项目最忌讳的一类假象。
        let monitoring = config.enable_monitoring;
        Self {
            inner: Mutex::new(Inner {
                config,
                rooms,
                selected: 0,
                status: StatusView::waiting(),
                limits: ServerLimits::default(),
                monitoring,
                notice: None,
                downlink_room: None,
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
                history_loaded: room.history_loaded,
            })
            .collect();
        let entries = inner
            .rooms
            .get(inner.selected)
            .map(|room| room.entries.clone())
            .unwrap_or_default();
        Snapshot {
            rooms,
            selected: inner.selected,
            entries,
            status: inner.status.clone(),
            limits: inner.limits.into(),
            problems: inner.config.problems(),
            monitoring: inner.monitoring,
            notice: inner.notice.clone(),
            config_path: self.config_path.display().to_string(),
            data_dir: self.data_dir.display().to_string(),
            max_entries: MAX_ENTRIES_PER_ROOM,
        }
    }

    /// 界面上的一次性提示。
    pub fn notice(&self, kind: &'static str, text: impl Into<String>) {
        self.lock().notice = Some(Notice {
            kind,
            text: text.into(),
        });
    }

    /// 提示已经被看过了（页面取过之后清掉，免得一直挂着）。
    pub fn clear_notice(&self) {
        self.lock().notice = None;
    }

    /// 切房间。越界**报错**而不是静默夹住 —— 页面传错下标时要说清是哪里错了。
    pub fn select(&self, index: usize) -> Result<(), String> {
        let mut inner = self.lock();
        let count = inner.rooms.len();
        if index >= count {
            return Err(format!("没有第 {index} 个房间（共 {count} 个）"));
        }
        inner.selected = index;
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
        match update {
            // ⚠️ `update`（原地改正文）与 `receive` **走的是同一个分支** ——
            // 靠 id 就地**替换**掉原来那条，而不是再添一张卡片。
            // 替换而不是追加，是为了「同一条消息被改过之后，界面上还是一张卡片」。
            ReceiverUpdate::Entry(entry) => {
                let room = entry.room().to_owned();
                if let Some(index) = inner.room_index(&room) {
                    let server = inner.config.channels[index].server.clone();
                    let client_id = inner.config.client_id.clone();
                    let view = EntryView::from_holder(&entry, &client_id, &server);
                    inner.rooms[index].upsert(view);
                }
            }
            // ⚠️ 空历史也要标成「取过了」—— 否则界面分不出
            // 「这个房间确实是空的」与「还没取过」。这两种都画成空列表，用户会以为坏了。
            ReceiverUpdate::History(entries) => {
                let room = entries
                    .first()
                    .map(|entry| entry.room().to_owned())
                    .or_else(|| inner.downlink_room.clone());
                if let Some(index) = room.and_then(|room| inner.room_index(&room)) {
                    let server = inner.config.channels[index].server.clone();
                    let client_id = inner.config.client_id.clone();
                    for entry in &entries {
                        let view = EntryView::from_holder(entry, &client_id, &server);
                        inner.rooms[index].upsert(view);
                    }
                    inner.rooms[index].history_loaded = true;
                }
            }
            ReceiverUpdate::Revoked { id } => {
                // ⚠️ 先把下标算出来再改 —— 边借用 `inner` 边改它会踩到借用检查。
                let index = inner
                    .downlink_room
                    .as_deref()
                    .and_then(|room| inner.room_index(room));
                if let Some(index) = index {
                    inner.rooms[index].entries.retain(|entry| entry.id != id);
                }
            }
            ReceiverUpdate::Cleared => {
                let index = inner
                    .downlink_room
                    .as_deref()
                    .and_then(|room| inner.room_index(room));
                if let Some(index) = index {
                    inner.rooms[index].entries.clear();
                }
            }
            // ⚠️ 设备列表：客户端**只给「变了」这个信号，没有给列表**
            // （`ReceiverUpdate::DevicesChanged` 就是这么定义的）。所以这里**什么也不做**
            // —— 而不是编一个「1 台在线」出来。界面上因此**不显示**在线设备数，
            // 写在这里免得下一个人以为是漏了。
            ReceiverUpdate::DevicesChanged => {}
            ReceiverUpdate::Status(status) => inner.apply_status(status),
        }
    }

    /// 界面上手动「刷新」时取回的历史（走 `GET /content`，**不碰剪贴板**）。
    ///
    /// ⚠️ 为什么要单独一条：下行的历史只覆盖**下载通道那一个房间**
    /// （`spawn_receiver` 只连那一个），而界面可以选中任何一个房间 ——
    /// 别的房间得自己按需取一次。
    ///
    /// ⚠️★ 房间名**由调用方给**，不从 `entries.first()` 猜：空响应（新房间 / 服务端说没有）
    /// 时那个办法会回落到「下行房间」，于是把**另一个房间**标成「已加载」——
    /// 症状是切到那个房间看到空列表且写着「这个房间还没有内容」，而它其实有内容。
    pub fn push_history(&self, room: &str, entries: Vec<ReceiveHolder>) {
        let mut inner = self.lock();
        if let Some(index) = inner.room_index(room) {
            let server = inner.config.channels[index].server.clone();
            let client_id = inner.config.client_id.clone();
            for entry in &entries {
                let view = EntryView::from_holder(entry, &client_id, &server);
                inner.rooms[index].upsert(view);
            }
            inner.rooms[index].history_loaded = true;
        }
    }
}

impl Store {
    /// 换上行开关（**可以多个房间同时开**，§4.1 第 1 条）。
    pub fn set_upload(&self, index: usize, on: bool) -> Result<(), String> {
        let mut inner = self.lock();
        let channel = inner
            .config
            .channels
            .get_mut(index)
            .ok_or_else(|| format!("没有第 {index} 个房间"))?;
        channel.enable_upload = on;
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
        Ok(())
    }

    /// 换「剪贴板监听」总开关（**只管上行监听**；下行与它无关 ——
    /// §0.5 第 3 条那条规则的另一半：关掉下载开关关的是剪贴板，不是列表）。
    pub fn set_monitoring(&self, on: bool) {
        let mut inner = self.lock();
        inner.monitoring = on;
        inner.config.enable_monitoring = on;
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
    /// 按房间名找下标（`None` = 配置里没有这个房间）。
    fn room_index(&self, room: &str) -> Option<usize> {
        self.config
            .channels
            .iter()
            .position(|channel| channel.room == room)
    }

    /// 状态变化。
    ///
    /// ⚠️★ `NoWatermark`（老服务端握手不带 `latestId`）**必须显示成一条警告**，
    /// 而不是「已连接」—— 因为此刻客户端**一行剪贴板都不写**（fail-safe，§4.2 ①）。
    /// 显示成「已连接」的话，用户会以为同步在工作（然后发现内容就是不过来）。
    fn apply_status(&mut self, status: ReceiverStatus) {
        self.status = match status {
            ReceiverStatus::Connecting { room, .. } => {
                self.downlink_room = Some(room.clone());
                StatusView {
                    kind: "wait",
                    text: format!("连接 {room} …"),
                    latest_id: None,
                    room: Some(room),
                }
            }
            ReceiverStatus::Connected { latest_id, limits } => {
                // ⚠️ 限额也在这里存一份：它**只在握手里下发**（`uploader` 的模块文档），
                // 上行要用；而 `ServerLimits::default()`（两个 0）是「不知道」的意思。
                self.limits = limits;
                StatusView {
                    kind: "on",
                    text: "已连接".to_owned(),
                    latest_id: Some(latest_id),
                    room: self.downlink_room.clone(),
                }
            }
            ReceiverStatus::NoWatermark => StatusView {
                kind: "warn",
                text: "服务端版本太旧：边界说不清，已暂停写剪贴板".to_owned(),
                latest_id: None,
                room: self.downlink_room.clone(),
            },
            ReceiverStatus::Disconnected { reason } => StatusView {
                kind: "off",
                text: format!("已断开：{reason}"),
                latest_id: None,
                room: self.downlink_room.clone(),
            },
        };
    }
}

impl Room {
    /// 插一条：**同 id 就地替换**，新的按 id 插到正确位置，超过上限就从最旧的丢。
    ///
    /// ⚠️ 为什么不能无脑 `push`：房间之间 id 各自单调（`CONTRIBUTING.md` §6），
    /// 而界面可以**来回切房间**、按需取回的历史里的 id **可能比已经在列表里的小** ——
    /// 无脑 push 会让时间线乱序，而乱序的时间线用户是看不出错的（只会觉得"不对劲"）。
    fn upsert(&mut self, view: EntryView) {
        match self
            .entries
            .binary_search_by_key(&view.id, |entry| entry.id)
        {
            Ok(position) => self.entries[position] = view,
            Err(position) => self.entries.insert(position, view),
        }
        if self.entries.len() > MAX_ENTRIES_PER_ROOM {
            self.entries
                .drain(..self.entries.len() - MAX_ENTRIES_PER_ROOM);
        }
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
    use clip9_protocol::{ReceiveBase, TextReceive};

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

    /// 一个两房间的配置（`default` / `work`），下载通道在第二个上。
    fn store_with(dir: &Path) -> Store {
        let config = ClientConfig {
            client_id: "client-a".to_owned(),
            channels: vec![
                Channel::new("默认", "http://127.0.0.1:9501"),
                Channel {
                    room: "work".to_owned(),
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
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Connecting {
            server: "http://127.0.0.1:9501".to_owned(),
            room: "work".to_owned(),
        }));
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Connected {
            latest_id: 137,
            limits: ServerLimits {
                text_limit: 4096,
                file_limit: 268_435_456,
            },
        }));

        let snapshot = store.snapshot();
        assert_eq!(snapshot.status.kind, "on");
        assert_eq!(snapshot.status.latest_id, Some(137));
        assert_eq!(snapshot.status.room.as_deref(), Some("work"));
        // ⚠️ 限额要跟着状态一起到位 —— 上行要用它，而它**只在握手里**下发。
        assert_eq!(snapshot.limits.text_limit, 4096);
    }

    /// ⚠️★ **老服务端（没有水印）不能显示成「已连接」** —— 那一刻客户端一行剪贴板都不写，
    /// 显示成「已连接」的话用户只会觉得「怎么同步不过来」。
    #[test]
    fn an_old_server_is_shown_as_a_warning_not_as_connected() {
        let (_dir, store) = temp_store();
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::NoWatermark));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.status.kind, "warn");
        assert!(
            snapshot.status.text.contains("太旧"),
            "要说清是「服务端版本太旧」：{}",
            snapshot.status.text
        );
    }

    /// 断线要带原因（界面上不能只写「没连上」—— 用户需要知道是密码错了还是地址错了）。
    #[test]
    fn a_disconnect_keeps_the_reason() {
        let (_dir, store) = temp_store();
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Disconnected {
            reason: "未授权".to_owned(),
        }));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.status.kind, "off");
        assert!(
            snapshot.status.text.contains("未授权"),
            "{}",
            snapshot.status.text
        );
    }

    /// 实时条目进列表；**同 id 原地替换**（`update` 事件与 `receive` 走同一条路）。
    #[test]
    fn an_update_replaces_the_card_instead_of_adding_one() {
        let (_dir, store) = temp_store();
        store.apply_update(ReceiverUpdate::Entry(Box::new(text(9, "work", "原文"))));
        store.select(1).unwrap();
        assert_eq!(store.snapshot().entries.len(), 1);

        store.apply_update(ReceiverUpdate::Entry(Box::new(text(9, "work", "改过的"))));
        let snapshot = store.snapshot();
        assert_eq!(snapshot.entries.len(), 1, "同一条只能有一张卡片");
        assert_eq!(snapshot.entries[0].text, "改过的");
    }

    /// ⚠️★ 界面上那个「监听中/已暂停」**必须**跟着配置走 ——
    /// 写死成「开着」的话，配置里关了监听的用户会看到界面说「监听中」，
    /// 而实际上本机剪贴板**根本没被读**（§0.5 第 3 条那条规则的同类问题）。
    #[test]
    fn the_listening_pill_follows_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let off = Store::new(
            ClientConfig {
                enable_monitoring: false,
                ..ClientConfig::default()
            },
            dir.path().join("client.json"),
            dir.path().to_path_buf(),
        );
        assert!(!off.snapshot().monitoring, "配置说关，界面上就该是关的");

        let on = Store::new(
            ClientConfig::default(),
            dir.path().join("client.json"),
            dir.path().to_path_buf(),
        );
        assert!(
            on.snapshot().monitoring,
            "默认是开的（ClientConfig 的默认）"
        );
    }

    /// 历史来了要标成「取过了」；**并且乱序的 id 要插到正确位置**。
    #[test]
    fn history_is_ordered_and_marked_as_loaded() {
        let (_dir, store) = temp_store();
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Connecting {
            server: "http://127.0.0.1:9501".to_owned(),
            room: "work".to_owned(),
        }));
        // 服务端按 id 升序给，但**别依赖它** —— 客户端要自己保证顺序。
        store.apply_update(ReceiverUpdate::History(vec![
            text(12, "work", "c"),
            text(10, "work", "a"),
            text(11, "work", "b"),
        ]));
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
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Connecting {
            server: "http://127.0.0.1:9501".to_owned(),
            room: "work".to_owned(),
        }));
        store.apply_update(ReceiverUpdate::History(vec![]));
        assert!(store.snapshot().rooms[1].history_loaded);
    }

    /// 删除与清空要真的从列表里去掉（界面上留着一条已删的消息 = 用户会去点它）。
    #[test]
    fn revoked_and_cleared_remove_entries() {
        let (_dir, store) = temp_store();
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Connecting {
            server: "http://127.0.0.1:9501".to_owned(),
            room: "work".to_owned(),
        }));
        store.apply_update(ReceiverUpdate::History(vec![
            text(1, "work", "a"),
            text(2, "work", "b"),
        ]));
        store.apply_update(ReceiverUpdate::Revoked { id: 1 });
        assert_eq!(store.snapshot().rooms[1].count, 1);

        store.apply_update(ReceiverUpdate::Cleared);
        assert_eq!(store.snapshot().rooms[1].count, 0);
    }

    /// ⚠️★ 列表**有界**：超了就从最旧的丢，界面要照实说上限是多少。
    #[test]
    fn the_list_is_bounded_and_the_bound_is_visible() {
        let (_dir, store) = temp_store();
        for id in 1..=(MAX_ENTRIES_PER_ROOM as i32 + 50) {
            store.apply_update(ReceiverUpdate::Entry(Box::new(text(id, "work", "x"))));
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
        store.apply_update(ReceiverUpdate::Status(ReceiverStatus::Connecting {
            server: "http://127.0.0.1:9501".to_owned(),
            room: "work".to_owned(),
        }));
        store.push_history("default", vec![]);

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
}
