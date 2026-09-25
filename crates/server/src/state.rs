//! 服务端共享状态。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use clip9_core::Config;
use clip9_protocol::DeviceMeta;
use clip9_store::Store;
use parking_lot::Mutex;
use tokio::sync::broadcast;

/// 一条广播事件。
///
/// 收成一处的理由：Go 那边的广播散在 5 个地方（新增 / 改正文 / 挪列 / 撤销 / 清空），
/// 漏一个的表现是「自己刷新能看到、别的设备看不到」，而且**不报错**。
#[derive(Debug, Clone)]
pub struct Broadcast {
    /// 只发给这个房间的连接。
    pub room: String,
    pub event: String,
    pub data: serde_json::Value,
    /// 不发给这个连接号（`connect` 事件用：新设备不该收到自己的 connect）。
    pub except: Option<u64>,
}

/// 广播通道容量。
///
/// ⚠️ 满了会让**最旧的**事件被丢掉（`tokio::sync::broadcast` 的语义），而接收端会拿到
/// `RecvError::Lagged` —— 那时**必须断开那个连接让它重连**，不能装作没事继续：
/// 漏掉一条 `revoke` 的客户端会一直显示一条已经被删掉的条目。
const BROADCAST_CAPACITY: usize = 256;

/// 服务端共享状态。
///
/// ⚠️ 这里刻意只有几样东西。字段一多，「谁该在锁里访问谁」就没人说得清了 ——
/// 而 Go 那边的 `ClipboardServer` 有 20 多个字段，其中好几个的并发语义只能靠读注释才知道。
pub struct AppState {
    pub config: Config,
    /// 消息存储。redb 自己保证并发（`begin_write` 串行化写事务），**不要在外面再包一层锁**。
    pub store: Store,
    /// 房间 → (连接号 → 设备元信息)。
    ///
    /// ⚠️★ 键是**连接号**，不是设备 ID —— 这是有意的（比 Go 更对）：
    /// 按设备 ID 存的话，「关掉一个标签页」会被误判成「设备离线」。
    /// Go 那边就是这样：`cleanupWebSocketConnection` 直接按 deviceID 删，
    /// 于是另一个还开着的标签页收不到后续推送，别的设备也以为它下线了。
    /// 按连接存之后，**只有这台设备的最后一条连接断开才广播 `disconnect`**。
    ///
    /// ⚠️ 它是**内存态**，重启即空 —— 这是对的：「当前连接」本来就只在此刻有意义。
    devices: Mutex<HashMap<String, BTreeMap<u64, DeviceMeta>>>,
    /// 广播出口。每个 WS 连接订阅它，按房间过滤。
    broadcast_tx: broadcast::Sender<Broadcast>,
    /// 连接序号。只用来实现「广播给除我之外的人」。
    conn_seq: AtomicU64,
    /// 设备 ID 的哈希种子。**每进程随机**，和 Go 的 `deviceHashSeed` 同义 ——
    /// 目的是让设备 ID 不可预测（它会被前端当成身份用于气泡归属）。
    device_hash: std::collections::hash_map::RandomState,
    /// 前端静态资源的目录。`None` = 这次部署没有前端（只跑 API）。
    ///
    /// ⚠️ 它是**外壳**传进来的，不是配置项 —— 四种分发形态的目录约定完全不同
    /// （Docker 挂载点 / OpenWrt `/var/lib` / Android 私有目录 / 桌面标准目录），
    /// 见 `docs/ARCHITECTURE.md` §4.2。
    pub static_dir: Option<PathBuf>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("config", &self.config)
            .field("rooms_with_devices", &self.devices.lock().len())
            .finish_non_exhaustive()
    }
}

impl AppState {
    #[must_use]
    pub fn new(config: Config, store: Store, static_dir: Option<PathBuf>) -> Arc<Self> {
        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Self {
            config,
            store,
            devices: Mutex::new(HashMap::new()),
            broadcast_tx,
            conn_seq: AtomicU64::new(1),
            device_hash: std::collections::hash_map::RandomState::new(),
            static_dir,
        })
    }

    // ── 连接 ──────────────────────────────────────────────────────────

    /// 分配一个连接号。
    pub fn next_conn_id(&self) -> u64 {
        self.conn_seq.fetch_add(1, Ordering::Relaxed)
    }

    /// 由「对端地址 + User-Agent」推出设备 ID。
    ///
    /// ⚠️ 用带**随机种子**的哈希（`RandomState` 是 SipHash + 进程随机 key），
    /// 和 Go 的 `murmur3(data, 随机 seed)` 同义：让设备 ID 不可预测。
    /// 用 `DefaultHasher::new()` 是错的 —— 它**没有随机种子**，任何人都能算出别人的 ID。
    #[must_use]
    pub fn device_id_for(&self, remote_addr: &str, user_agent: &str) -> String {
        let mut h = self.device_hash.build_hasher();
        h.write(remote_addr.as_bytes());
        h.write(b" ");
        h.write(user_agent.as_bytes());
        format!("{}", h.finish())
    }

    /// 登记一条连接。
    ///
    /// ⚠️ 同一个设备开多个标签页 = **多条连接**，都会登记 —— 这是有意的，
    /// 这样「关掉一个标签页」不会让设备看起来离线（见 `devices` 字段的注释）。
    pub fn register_device(&self, room: &str, conn_id: u64, meta: &DeviceMeta) {
        self.devices
            .lock()
            .entry(room.to_owned())
            .or_default()
            .insert(conn_id, meta.clone());
    }

    /// 注销一条连接。返回 `(这台设备的信息, 它还有没有别的连接)`。
    ///
    /// ⚠️ **只有 `still_connected == false` 时才该广播 `disconnect`** ——
    /// 否则关掉一个标签页就会让别的设备以为整台机器下线了。
    #[must_use]
    pub fn unregister_device(&self, room: &str, conn_id: u64) -> Option<(DeviceMeta, bool)> {
        let mut devices = self.devices.lock();
        let in_room = devices.get_mut(room)?;
        let meta = in_room.remove(&conn_id)?;
        let still_connected = in_room.values().any(|d| d.id == meta.id);
        if in_room.is_empty() {
            devices.remove(room);
        }
        Some((meta, still_connected))
    }

    /// 某个房间里**除我这台设备之外**的设备，按设备 ID 去重。
    ///
    /// ⚠️ 去重是按**设备 ID**：同一个设备开两个标签页时，第二个标签页不该在
    /// 设备列表里看到自己（连接号不同、设备 ID 相同）。
    #[must_use]
    pub fn devices_in_room_except(&self, room: &str, exclude_device_id: &str) -> Vec<DeviceMeta> {
        let devices = self.devices.lock();
        let Some(in_room) = devices.get(room) else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        in_room
            .values()
            .filter(|d| d.id != exclude_device_id && seen.insert(d.id.clone()))
            .cloned()
            .collect()
    }

    /// 某个房间当前有几台**设备**。
    ///
    /// ⚠️ 数的是**设备**不是连接：同一个设备开两个标签页只算一台
    /// （`/rooms` 的 `deviceCount` 是给用户看的「有几台设备」）。
    #[must_use]
    pub fn device_count(&self, room: &str) -> usize {
        let devices = self.devices.lock();
        let Some(in_room) = devices.get(room) else {
            return 0;
        };
        in_room
            .values()
            .map(|d| d.id.as_str())
            .collect::<HashSet<_>>()
            .len()
    }

    /// 当前**有设备连着**的房间名。
    ///
    /// `/rooms` 要把「有消息的房间」和「有连接的房间」并起来 —— 一个刚建出来、
    /// 还没发过任何东西的房间，只能从这儿看到。
    #[must_use]
    pub fn connected_rooms(&self) -> Vec<String> {
        self.devices.lock().keys().cloned().collect()
    }

    // ── 广播 ──────────────────────────────────────────────────────────

    /// 订阅广播。每个 WS 连接订一个。
    pub fn subscribe(&self) -> broadcast::Receiver<Broadcast> {
        self.broadcast_tx.subscribe()
    }

    /// 广播一条事件给这个房间的**所有**订阅者。
    ///
    /// ⚠️ **每个写操作都必须调它**（新增 / 改正文 / 挪列 / 撤销 / 清空）——
    /// 漏一个的表现是「自己刷新能看到、别的设备看不到」，而且不报错。
    pub fn broadcast(&self, event: &str, payload: &impl serde::Serialize, room: &str) {
        self.broadcast_except(event, payload, room, None);
    }

    /// 广播给这个房间的订阅者，但**跳过**某个连接。
    pub fn broadcast_except(
        &self,
        event: &str,
        payload: &impl serde::Serialize,
        room: &str,
        except: Option<u64>,
    ) {
        let data = match serde_json::to_value(payload) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, event, room, "广播载荷序列化失败，已丢弃");
                return;
            }
        };
        // 没有订阅者时 `send` 会返回 Err —— 那是**正常情况**（没人连着），不是错误。
        let _ = self.broadcast_tx.send(Broadcast {
            room: room.to_owned(),
            event: event.to_owned(),
            data,
            except,
        });
    }
}

/// 当前 Unix 秒。
///
/// ⚠️ 全项目**只从这一个地方取当前时间**。理由不是洁癖，是踩过：
/// Go 那边注入了固定的 `Now` 之后，一半地方用了、一半地方还在 `time.Now()`，
/// 于是「试算」和「实发」会不一致，测试还会**每天过午夜红一次**。
///
/// ⚠️ 现在它是**自由函数**，所以「注入」目前只等于「只有一处调用点、改起来只有一处」——
/// **不是**真的可注入。真需要让测试控制时间时（比如测定时任务的补发窗口），
/// 把它挪到 `AppState` 上做成 `clock: Box<dyn Fn() -> i64>`；
/// **别去各个调用点加参数**，那正是上面那个坑的成因。
#[must_use]
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}
