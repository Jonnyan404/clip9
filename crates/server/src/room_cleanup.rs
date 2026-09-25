//! 房间清理：定期把「空房间」的计数行收掉。
//!
//! 照 Go 的 `cleanupEmptyRooms`（`cloud-clip/lib/main.go:1046`）适配。
//!
//! # ⚠️ 为什么 Rust 侧需要它、以及「空房间」在这里指什么
//!
//! Go 那边有一份**内存里的** `roomStats`（每房间的 `LastActive` 等统计），
//! 房间清理做的就是「把这个 map 里没连接、没消息、且空闲超过 `roomCleanup` 秒的条目删掉」。
//!
//! Rust 侧没有那个 map —— 但**等价物是有的**：存储里那张 `rooms` 计数表
//! （`name -> (count, last_active)`）。`/rooms` 的房间来源是
//! 「计数行 ∪ 有连接的 ∪ 有消息的」，而计数行**在计数减到 0 之后仍然留着**，
//! 所以需要有人来收 —— 那就是这个模块。
//!
//! ⚠️ 不清它不会出错，只会让 `rooms` 表慢慢攒下**再也不会有人看的行**
//! （每个曾经用过的房间名一条）。所以这个功能的定位是**内务**，不是正确性。
//!
//! # 与 Go 对齐的几条判定（逐条抄，别自己发明）
//!
//! - 只在 `server.roomList` 开启时跑（Go 的 `startRoomCleanup` 只在 `cfg.Server.RoomList`
//!   为真时被调用）；
//! - `roomCleanup <= 0` 表示**不跑**（Go 会打印一行日志然后 return）；
//! - `default` 房间**永远不清**（Go：`if room == "default" { continue }`）；
//! - **还有消息**的房间不清（Go：`hasMessages`）；
//! - **还有连接**的房间不清（Go：`hasConnections`）；
//! - 只有 `now - last_active > roomCleanup` 才清（Go 的同一个比较）。

use std::sync::Arc;
use std::time::Duration;

use crate::state::{AppState, now_secs};

/// 启动清理任务。**不满足条件就直接返回**（不建 ticker）—— 与 Go 一致。
pub fn start(state: Arc<AppState>) {
    let interval_secs = state.config.server.room_cleanup;
    // ⚠️ 两条前置条件都照 Go：`<= 0` 不跑；`roomList` 没开也不跑
    // （房间列表都不给看，就没必要维护那张表）。
    if interval_secs <= 0 {
        tracing::info!("roomCleanup <= 0，不启动房间清理任务");
        return;
    }
    if !state.config.server.room_list {
        tracing::info!("roomList 未启用，不启动房间清理任务");
        return;
    }

    tracing::info!(interval_secs, "房间清理任务已启动");

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_secs as u64));
        // ⚠️ 第一个 tick 是**立刻**返回的（tokio 的 interval 语义），这里先吃掉它：
        // 刚启动时所有房间的 `last_active` 都还很新，跑了也是白跑；而且
        // 自动化调度器那边是**故意**立刻跑的（补发窗口要立刻生效），两边语义不同，别抄错。
        interval.tick().await;
        loop {
            interval.tick().await;
            match purge_once(&state) {
                Ok(0) => {}
                Ok(removed) => tracing::info!(removed, "房间清理完成，已清理空房间"),
                // ⚠️ 清理失败**不能把任务打死**：它只是个内务任务，
                // 而红b 偶发的写冲突不该让「房间列表」从此不再被维护。
                Err(e) => tracing::warn!(error = %e, "房间清理出错（下一轮再试）"),
            }
        }
    });
}

/// 跑一轮清理，返回删掉了几行。抽出来是为了能被单测直接调 —— 不用等 ticker。
///
/// ⚠️ 判定顺序照 Go：先跳过 `default`，再看「没连接 && 没消息 && 空闲够久」。
pub fn purge_once(state: &AppState) -> anyhow::Result<usize> {
    let now = now_secs();
    let idle_limit = state.config.server.room_cleanup;
    // ⚠️ `connected_rooms()` 返回 `Vec<String>`，这里转成集合 —— 房间多了之后
    // 逐个 `contains` 是 O(房间数²)（`/rooms` 那边就为这个吃过一次亏）。
    let connected: std::collections::HashSet<String> =
        state.connected_rooms().into_iter().collect();

    let mut removed = 0;
    for room in state.store.rooms()? {
        // ① `default` 永远不清。
        if room.name == "default" {
            continue;
        }
        // ② 还有消息的房间不清（计数行只是「曾经有过」，消息才是内容）。
        if room.message_count > 0 {
            continue;
        }
        // ③ 还有连接的房间不清。
        if connected.contains(&room.name) {
            continue;
        }
        // ④ 空闲够久才清。⚠️ 严格大于，与 Go 的 `timeSinceLastActive > RoomCleanup` 一致。
        if now - room.last_active <= idle_limit {
            continue;
        }
        state.store.remove_room(&room.name)?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clip9_core::Config;
    use clip9_protocol::{ReceiveBase, ReceiveHolder, TextReceive};
    use clip9_store::Store;

    /// 造一个 AppState + 一个临时目录。
    ///
    /// ⚠️ `room_cleanup` 传 **-1**：`purge_once` 把它当「空闲上限」，而 `-1` 让
    /// 「刚活跃过」的房间也满足 `now - last_active > limit` —— 这样测试不用等真实时间。
    /// ⚠️ 生产里 `start()` 拒绝 `<= 0`，所以这个值进不来；这里是在直接调 `purge_once`。
    fn setup() -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let store = Store::open(dir.path().join("t.redb")).expect("打开 store");
        let mut config = Config::default();
        config.server.room_cleanup = -1;
        config.server.room_list = true;
        config.server.storage_dir = dir.path().join("uploads").display().to_string();
        let state = AppState::new(config, store, None);
        (state, dir)
    }

    fn text(room: &str, ts: i64, content: &str) -> ReceiveHolder {
        ReceiveHolder::Text(TextReceive {
            base: ReceiveBase {
                kind: "text".to_owned(),
                room: room.to_owned(),
                timestamp: ts,
                ..ReceiveBase::default()
            },
            content: content.to_owned(),
            ..TextReceive::default()
        })
    }

    /// 钉住三条跳过判定（第四条「还有连接」要真挂一条 WS 才造得出来，
    /// 由实机验证覆盖）。
    ///
    /// ⚠️ 这条测试的价值在于**判定本身**：房间清理是内务任务，写错了不会报错，
    /// 只会悄悄把还该留着的房间行删掉 —— 表现为 `/rooms` 少一行，而消息还在库里。
    /// ⚠️ 用 `#[tokio::test]`：`AppState::new` 会 `tokio::spawn` 起调度器与清理任务，
    /// 同步测试里没有运行时，会直接 panic（第一版就是这么挂的）。
    #[tokio::test]
    async fn purge_keeps_default_and_non_empty_rooms() {
        let (state, _dir) = setup();

        // `default` 与 `r1`：各留一条消息 → 计数非 0 → 都不该被清。
        state
            .store
            .insert(text("default", 1, "a"))
            .expect("写 default");
        state.store.insert(text("r1", 2, "b")).expect("写 r1");
        // `r2`：写了再删 → 计数归 0，但**行还在**（这正是要清的那种）。
        let doomed = state.store.insert(text("r2", 3, "c")).expect("写 r2");
        assert!(state.store.remove(doomed.id()).expect("删 r2 的消息"));

        let removed = purge_once(&state).expect("清理应成功");
        assert_eq!(removed, 1, "只有 r2 该被清（default 与有消息的都不清）");

        let names: Vec<String> = state
            .store
            .rooms()
            .expect("读房间")
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert!(names.contains(&"default".to_owned()), "default 永远不清");
        assert!(names.contains(&"r1".to_owned()), "有消息的房间不清");
        assert!(!names.contains(&"r2".to_owned()), "空房间该被清掉");
    }
}
