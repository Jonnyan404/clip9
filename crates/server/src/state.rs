//! 服务端共享状态。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use clip9_core::Config;
use clip9_store::Store;
use parking_lot::Mutex;

/// 服务端共享状态。
///
/// ⚠️ 这里刻意只有三样东西。字段一多，「谁该在锁里访问谁」就没人说得清了 ——
/// 而 Go 那边的 `ClipboardServer` 有 20 多个字段，其中好几个的并发语义只能靠读注释才知道。
/// 新加字段之前先问：它能不能待在它自己的模块里？
pub struct AppState {
    pub config: Config,
    /// 消息存储。redb 自己保证并发（`begin_write` 串行化写事务），**不要在外面再包一层锁**。
    pub store: Store,
    /// 当前连着的设备：房间 → 设备 ID 集合。
    ///
    /// `/rooms` 的 `deviceCount` / `isActive` 靠它。⚠️ 它是**内存态**，重启即空 ——
    /// 这是对的：「当前连接」本来就只在此刻有意义。
    pub devices: Mutex<HashMap<String, HashSet<String>>>,
}

impl AppState {
    #[must_use]
    pub fn new(config: Config, store: Store) -> Arc<Self> {
        Arc::new(Self {
            config,
            store,
            devices: Mutex::new(HashMap::new()),
        })
    }

    /// 某个房间当前连了几台设备。
    #[must_use]
    pub fn device_count(&self, room: &str) -> usize {
        self.devices.lock().get(room).map_or(0, HashSet::len)
    }

    /// 广播一条事件给这个房间的 WS 订阅者。
    ///
    /// ⚠️ **每个写操作都必须调它**：Go 那边广播散在 5 个地方（新增 / 改正文 / 挪列 /
    /// 撤销 / 清空），漏一个的表现是「自己刷新能看到、别的设备看不到」，而且**不报错**。
    ///
    /// TODO(P0): WS 还没实现，所以现在只序列化一下（顺带把「载荷能不能序列化」这件事
    /// 提前暴露出来）并记日志。WS 落地时**只改这一个函数** —— 这正是把它收成一处的理由。
    pub fn broadcast(&self, event: &str, payload: &impl serde::Serialize, room: &str) {
        match serde_json::to_value(payload) {
            Ok(value) => {
                tracing::debug!(
                    event,
                    room,
                    bytes = value.to_string().len(),
                    "广播（WS 未实现，暂无订阅者）"
                );
            }
            Err(e) => tracing::warn!(error = %e, event, room, "广播载荷序列化失败"),
        }
    }
}

/// 当前 Unix 秒。
///
/// ⚠️ 全项目**只从这一个地方取当前时间** —— Go 那边栽过一次：
/// 注入了固定的 `Now` 之后，一半地方用了、一半地方还在 `time.Now()`，
/// 于是「试算」和「实发」会不一致，测试还会每天过午夜红一次。
/// 测试要控制时间时，从这里注入，别去各个调用点改。
#[must_use]
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}
