//! 过期文件清理 + 孤儿对账。
//!
//! 照 Go 的 `cleanExpiredFilesLoop`（`cloud-clip/lib/main.go:576`）补齐。
//!
//! # ⚠️★ 为什么需要它
//!
//! Rust 侧原本**只有请求路径上的惰性清理**（`files.rs` 的「双重检查过期」）：
//! 有人来 GET/DELETE 一个已过期的 uuid 时，才顺手把字节和登记删掉。
//! 后果是**没人再访问的过期文件永远不会被回收** —— 实测：传 10 个文件、全部过期、
//! 一个都不碰，23 秒后 10 个仍在磁盘上。而 `uploads/` **没有任何总量上限**
//! （`Limits::max_bytes` 只算条目字节，明说了「不等于文件大小」），
//! 所以在 OpenWrt 那种 16–128MB flash 的机器上这是会**写满盘**的。
//!
//! Go 那边是每 5 分钟扫一遍，这里照做，并且多做两件 Go 没做干净的事。
//!
//! # 一轮扫什么
//!
//! | 阶段 | 做什么 | 频率 |
//! |---|---|---|
//! | A 过期 | `expired_files()` → 删磁盘字节 + 删登记 | 每轮 |
//! | B 孤儿条目 | 引用了**已不在登记表里**的文件的条目 → 删条目 + 广播 `revoke` | 每轮（仅当 A 有收获） |
//! | C 对账 | ①没人引用的登记（裁剪/撤销留下的）→ 收掉；②引用了不存在文件的条目 → 收掉 | 每 12 轮（约 1 小时） |
//!
//! # ⚠️★ 两个必须守住的边界
//!
//! 1. **「没人引用」≠ 立刻可删**。分片上传是**先登记、后插条目**的
//!    （`init_chunk_upload` 先 `put_file`，条目要等 `/upload/finish`）——
//!    中间那段时间里这个文件就是「没人引用」的。所以阶段 C 有一条
//!    [`ORPHAN_GRACE`] 宽限期：**上传时间太新的登记一律不动**。
//!    这同时也是「上传到一半就放弃」那些垃圾的回收时机。
//! 2. **解析不出来的行 = 整轮放弃**（`referenced_file_uuids` 会返回 `Err`）。
//!    跳过坏行会让它引用的文件被当成孤儿删掉 —— 宁可这轮不清理，也不能误删活文件。
//!
//! # 与 `trim_*` 的关系
//!
//! 裁剪（按条数丢最旧的）只动消息表，**不删磁盘字节**。阶段 C 的 ① 就是给它兜底的：
//! 条目被裁掉之后，对应的登记就没人引用了，下一轮对账收掉。

use std::sync::Arc;
use std::time::Duration;

use crate::files::remove_stored_file;
use crate::state::{AppState, now_secs};

/// 每轮检查的间隔。
///
/// ⚠️ 照 Go 的 5 分钟。**刻意不做成配置项**：配置项要一路通到桌面端的设置界面
/// （`config.rs` + 设置页 + i18n），而这一项用户几乎不会想调。
/// 真要调的时候把它加进 `server.*` 就行（照 `room_cleanup` 的样子）。
const SWEEP_INTERVAL: Duration = Duration::from_secs(300);

/// 每多少轮做一次全库对账（阶段 C）。
///
/// ⚠️ 阶段 C 要**扫全表**（消息表 + 登记表），所以低频跑 —— 这也是架构文档 §3.3
/// 对「全库整理」的要求（「必须在后台低频跑，不要在写入路径上调」）。
const RECONCILE_EVERY: u64 = 12;

/// 孤儿登记（没人引用的文件）的**宽限期**：上传时间比这还新的，一律不动。
///
/// ⚠️★ 分片上传是「先登记、后插条目」的，中间这段就是「没人引用」。
/// 没有宽限期的话，一个正在上传的大文件会在下一次对账时被**当场删掉**。
/// 顺带它也定义了「上传到一半放弃」的回收时机。
const ORPHAN_GRACE: i64 = 3600;

/// 启动清理任务。
///
/// ⚠️ **没有「`file.expire <= 0` 就不启动」这条前置条件**（Go 有）：
/// 房间可以用 `roomAuth[x].fileExpire` **按房间覆盖**全局值，
/// 全局设成 0（永不过期）时某些房间照样会过期 —— 照 Go 那样直接不启动，
/// 那些房间的过期文件就没人收了。空转一轮的代价只是扫一遍登记表。
pub fn start(state: Arc<AppState>) {
    tracing::info!(interval_secs = SWEEP_INTERVAL.as_secs(), "文件清理任务已启动");

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        // ⚠️ 第一个 tick 是**立刻**返回的（tokio 的 interval 语义），先吃掉它：
        // 刚启动时清不出什么东西，而且启动那一拍本来就忙。
        interval.tick().await;
        let mut round: u64 = 0;
        loop {
            interval.tick().await;
            round += 1;
            let reconcile = round.is_multiple_of(RECONCILE_EVERY);
            match sweep_once(&state, reconcile).await {
                // ⚠️ 出错**不能把任务打死**：它是个内务任务，
                // 偶发的一次失败不该让「过期文件从此不再被回收」。
                Err(e) => tracing::warn!(error = %e, "文件清理出错（下一轮再试）"),
                Ok(report) if report.is_empty() => {}
                Ok(report) => tracing::info!(
                    expired = report.expired,
                    entries = report.entries,
                    orphan_files = report.orphan_files,
                    trimmed = report.trimmed,
                    "文件清理完成"
                ),
            }
        }
    });
}

/// 一轮清理的产出（只用于日志与测试断言）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SweepReport {
    /// 阶段 A 收掉的过期文件数。
    pub expired: usize,
    /// 阶段 B/C 删掉的**时间线条目**数（已经广播过 `revoke`）。
    pub entries: usize,
    /// 阶段 C 收掉的孤儿登记数。
    pub orphan_files: usize,
    /// 阶段 C 全库裁剪丢掉的条数（`total` / `max_bytes` 超限时）。
    pub trimmed: usize,
}

impl SweepReport {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.expired == 0 && self.entries == 0 && self.orphan_files == 0 && self.trimmed == 0
    }
}

/// 跑一轮。抽出来是为了能被单测直接调 —— 不用等 ticker。
///
/// `reconcile` 为真时额外做阶段 C（全表对账）。
pub async fn sweep_once(state: &AppState, reconcile: bool) -> anyhow::Result<SweepReport> {
    let mut report = SweepReport::default();
    let now = now_secs();

    // ── 阶段 A：过期的 → 删字节 + 删登记 ──
    let expired = state.store.expired_files(now)?;
    for file in &expired {
        if let Err(e) = remove_stored_file(state, &file.uuid).await {
            // ⚠️ 后台这一路**只记日志**：删不掉下一轮还会再试，
            // 不值得让整轮清理中断（用户点的 DELETE 才需要 500）。
            tracing::warn!(error = %e, uuid = %file.uuid, "删除过期文件字节失败（下一轮再试）");
        }
        // ⚠️ 先删字节再删登记：反过来的话，中途失败会留下
        // 「登记没了、字节还在」的孤儿字节（那是最难查的一类，因为界面上什么都看不到）。
        // 这个顺序下最坏是「字节没了、登记还在」，下一轮还会再删一次 —— 幂等。
        if let Err(e) = state.store.remove_file(&file.uuid) {
            tracing::warn!(error = %e, uuid = %file.uuid, "删文件登记失败");
        }
        report.expired += 1;
    }

    // ── 阶段 B：刚过期那些文件，把它们的时间线条目一起收掉 ──
    // ⚠️ 只有 A 真有收获才扫消息表 —— 绝大多数轮次这里什么都不做。
    if !expired.is_empty() {
        let uuids: Vec<String> = expired.iter().map(|f| f.uuid.clone()).collect();
        report.entries += drop_entries_for(state, &uuids)?;
    }

    // ── 阶段 C：全库对账（低频）──
    if reconcile {
        let files = state.store.list_files()?;
        let referenced = state.store.referenced_file_uuids()?;

        // ① 没人引用的登记 → 收掉（裁剪 / 撤销 / 放弃的上传留下的）。
        //    ⚠️ 宽限期见 `ORPHAN_GRACE` 的注释。
        let live: std::collections::HashSet<&str> =
            files.iter().map(|f| f.uuid.as_str()).collect();
        let mut orphan_uuids: Vec<String> = Vec::new();
        for file in &files {
            if referenced.contains(&file.uuid) {
                continue;
            }
            if now - file.upload_time < ORPHAN_GRACE {
                continue;
            }
            orphan_uuids.push(file.uuid.clone());
        }
        for uuid in &orphan_uuids {
            if let Err(e) = remove_stored_file(state, uuid).await {
                tracing::warn!(error = %e, uuid = %uuid, "删除孤儿文件字节失败（下一轮再试）");
            }
            if let Err(e) = state.store.remove_file(uuid) {
                tracing::warn!(error = %e, uuid = %uuid, "删孤儿登记失败");
            }
            report.orphan_files += 1;
        }

        // ② 引用了**不存在**的文件的条目 → 收掉。
        //    这一条覆盖「惰性清理刚删完登记、后台还没跑到」以及历史上留下的悬空引用。
        let dangling: Vec<String> = referenced
            .into_iter()
            .filter(|uuid| !live.contains(uuid.as_str()))
            .collect();
        if !dangling.is_empty() {
            report.entries += drop_entries_for(state, &dangling)?;
        }

        // ③ 全库裁剪（`total` / `max_bytes`）。
        //    ⚠️★ 以前**没有任何地方调它** —— 那两个上限因此从来没生效过。
        //    架构文档 §3.3 就要求它「必须在后台低频跑」，这里正是那个低频后台。
        //    ⚠️ 顺序：**先对账再裁剪**。反过来的话，这一轮刚被裁掉的条目要等下一轮
        //    才有人去收它们的字节（多留一小时）。现在这样，被裁掉的那些字节
        //    在下一轮对账时收 —— 一小时的空窗，可接受（它本来就是个低频兜底）。
        match state.store.trim_global() {
            Ok(0) => {}
            Ok(n) => report.trimmed = n,
            // ⚠️ 裁剪失败不该拖垮整轮：前面两步已经做完了。
            Err(e) => tracing::warn!(error = %e, "全库裁剪出错（下一轮再试）"),
        }
    }

    Ok(report)
}

/// 删掉引用这些文件的条目，并**逐个广播 `revoke`**（不然各端界面上的卡片不会消失）。
///
/// ⚠️ 广播到条目**自己记录的**房间（`remove_entries_for_files` 返回的那一份），
/// 与 `handle_revoke` 同一个规矩 —— 别用「当前房间」或客户端传的。
pub(crate) fn drop_entries_for(state: &AppState, uuids: &[String]) -> anyhow::Result<usize> {
    let removed = state.store.remove_entries_for_files(uuids)?;
    for (id, room) in &removed {
        state.broadcast("revoke", &serde_json::json!({ "id": id }), room);
    }
    Ok(removed.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clip9_core::Config;
    use clip9_protocol::{File, ReceiveBase, FileReceive, ReceiveHolder};
    use clip9_store::Store;
    use std::path::PathBuf;

    /// 造一个 AppState + 一个临时目录。
    ///
    /// ⚠️ 用 `#[tokio::test]`：`AppState::new` 会 `tokio::spawn` 起调度器与两个清理任务，
    /// 同步测试里没有运行时，会直接 panic。
    /// ⚠️ 真实 ticker 的**第一个 tick 被吃掉了**（见 `start`），所以测试期间它不会插进来
    /// 干扰 —— 这里只手动调 `sweep_once`。
    fn setup() -> (Arc<AppState>, tempfile::TempDir) {
        setup_with(None)
    }

    /// 同上，但可以指定全库限额（用来验 `trim_global` 真的被调到了）。
    fn setup_with(limits: Option<clip9_store::Limits>) -> (Arc<AppState>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let store = match limits {
            Some(l) => Store::open_with(dir.path().join("t.redb"), l).expect("打开 store"),
            None => Store::open(dir.path().join("t.redb")).expect("打开 store"),
        };
        let mut config = Config::default();
        config.server.storage_dir = dir.path().join("uploads").display().to_string();
        std::fs::create_dir_all(&config.server.storage_dir).expect("建 uploads");
        let state = AppState::new(config, store, None);
        (state, dir)
    }

    fn blob_path(state: &AppState, uuid: &str) -> PathBuf {
        PathBuf::from(&state.config.server.storage_dir).join(uuid)
    }

    fn write_blob(state: &AppState, uuid: &str, bytes: &[u8]) {
        std::fs::write(blob_path(state, uuid), bytes).expect("写 blob");
    }

    fn register(state: &AppState, uuid: &str, room: &str, upload_time: i64, expire_time: i64) {
        state
            .store
            .put_file(&File {
                name: format!("{uuid}.bin"),
                uuid: uuid.to_owned(),
                size: 3,
                upload_time,
                expire_time,
                room: room.to_owned(),
            })
            .expect("登记文件");
    }

    fn file_entry(room: &str, ts: i64, uuid: &str) -> ReceiveHolder {
        ReceiveHolder::File(FileReceive {
            base: ReceiveBase {
                kind: "file".to_owned(),
                room: room.to_owned(),
                timestamp: ts,
                ..ReceiveBase::default()
            },
            name: format!("{uuid}.bin"),
            size: 3,
            cache: uuid.to_owned(),
            expire: 0,
            ..FileReceive::default()
        })
    }

    /// ★ 过期的文件：字节、登记、**以及引用它的时间线条目**都要被收掉。
    ///
    /// ⚠️ 这条钉的是「条目也要删」这个语义 —— 它是这一版**改过**的行为
    /// （Go 会删，Rust 之前只留惰性清理、条目永远不删）。
    #[tokio::test]
    async fn expired_file_takes_its_entry_with_it() {
        let (state, _dir) = setup();
        let now = now_secs();
        let uuid = "aaaa-expired";

        register(&state, uuid, "default", now - 100, now - 1); // 1 秒前过期
        write_blob(&state, uuid, b"abc");
        state
            .store
            .insert(file_entry("default", now - 100, uuid))
            .expect("写条目");

        let report = sweep_once(&state, false).await.expect("清理应成功");

        assert_eq!(report.expired, 1, "一个过期文件");
        assert_eq!(report.entries, 1, "它那条时间线条目也要没");
        assert!(!blob_path(&state, uuid).exists(), "磁盘字节该被删");
        assert!(state.store.get_file(uuid).expect("读登记").is_none(), "登记该被删");
        assert!(
            state.store.recent_desc("default", 10).expect("读消息").is_empty(),
            "条目该被删"
        );
    }

    /// ★ 没人引用、但**刚上传**的登记**不许动** —— 分片上传正是「先登记、后插条目」。
    ///
    /// ⚠️ 这条是那个宽限期（`ORPHAN_GRACE`）的判据。没有它的话，
    /// 一个正在上传的大文件会在下一次对账时被当场删掉。
    #[tokio::test]
    async fn fresh_unreferenced_file_survives_reconcile() {
        let (state, _dir) = setup();
        let uuid = "bbbb-fresh";

        register(&state, uuid, "default", now_secs(), 0);
        write_blob(&state, uuid, b"abc");

        let report = sweep_once(&state, true).await.expect("对账应成功");

        assert_eq!(report.orphan_files, 0, "宽限期内不许收");
        assert!(blob_path(&state, uuid).exists(), "字节还在");
        assert!(state.store.get_file(uuid).expect("读登记").is_some(), "登记还在");
    }

    /// ★ 没人引用、而且**已经过了宽限期**的登记 = 孤儿（裁剪 / 撤销 / 放弃的上传留下的）→ 收掉。
    #[tokio::test]
    async fn old_unreferenced_file_is_collected() {
        let (state, _dir) = setup();
        let uuid = "cccc-orphan";

        register(&state, uuid, "default", now_secs() - ORPHAN_GRACE - 10, 0);
        write_blob(&state, uuid, b"abc");

        let report = sweep_once(&state, true).await.expect("对账应成功");

        assert_eq!(report.orphan_files, 1, "过了宽限期的孤儿该收");
        assert!(!blob_path(&state, uuid).exists(), "字节该被删");
        assert!(state.store.get_file(uuid).expect("读登记").is_none(), "登记该被删");
    }

    /// ★ 条目引用了一个**已经不存在的文件**（悬空引用）→ 条目收掉。
    ///
    /// ⚠️ 这条覆盖「惰性清理刚删完登记、后台还没跑到」，以及历史上留下的悬空引用。
    #[tokio::test]
    async fn entry_pointing_at_a_missing_file_is_removed() {
        let (state, _dir) = setup();
        let now = now_secs();

        // 只写条目，**不登记文件**。
        state
            .store
            .insert(file_entry("default", now - 50, "dddd-missing"))
            .expect("写条目");

        let report = sweep_once(&state, true).await.expect("对账应成功");

        assert_eq!(report.entries, 1, "悬空引用的条目该被收");
        assert!(
            state.store.recent_desc("default", 10).expect("读消息").is_empty(),
            "条目该没了"
        );
    }

    /// 文本条目**不受影响** —— 对账只认文件条目。
    ///
    /// ⚠️ 写错这一条的表现是「用户的历史文本被莫名其妙清掉」，而清理任务不报错。
    #[tokio::test]
    async fn reconcile_never_touches_text_entries() {
        let (state, _dir) = setup();
        let now = now_secs();

        state
            .store
            .insert(ReceiveHolder::Text(clip9_protocol::TextReceive {
                base: ReceiveBase {
                    kind: "text".to_owned(),
                    room: "default".to_owned(),
                    timestamp: now - 50,
                    ..ReceiveBase::default()
                },
                content: "不该被清".to_owned(),
                ..clip9_protocol::TextReceive::default()
            }))
            .expect("写文本");

        let report = sweep_once(&state, true).await.expect("对账应成功");

        assert_eq!(report.entries, 0, "文本条目不该被碰");
        assert_eq!(state.store.recent_desc("default", 10).expect("读消息").len(), 1);
    }

    /// ★ 全库裁剪（`total` / `max_bytes`）**现在真的会跑**。
    ///
    /// ⚠️ 这条钉的是一个**静默失效**：`trim_global` 以前只在测试里被调用过，
    /// 生产代码一次都没调 —— 于是配置里那 2GB（桌面）/ 16MB（OpenWrt）的上限
    /// **从来没有生效**，而且不报任何错。现在它挂在阶段 C 上。
    #[tokio::test]
    async fn reconcile_enforces_the_global_entry_limit() {
        let (state, _dir) = setup_with(Some(clip9_store::Limits {
            per_room: Some(10_000), // 别让按房间的裁剪抢先动手
            total: Some(2),
            max_bytes: None,
        }));
        let now = now_secs();

        for i in 0..5 {
            state
                .store
                .insert(ReceiveHolder::Text(clip9_protocol::TextReceive {
                    base: ReceiveBase {
                        kind: "text".to_owned(),
                        room: "default".to_owned(),
                        timestamp: now - 100 + i,
                        ..ReceiveBase::default()
                    },
                    content: format!("第 {i} 条"),
                    ..clip9_protocol::TextReceive::default()
                }))
                .expect("写文本");
        }
        assert_eq!(
            state.store.stats().expect("读统计").total_entries,
            5,
            "插入阶段不该被裁剪（按房间的上限是 10000）"
        );

        let report = sweep_once(&state, true).await.expect("对账应成功");

        assert_eq!(report.trimmed, 3, "5 条裁到上限 2 条");
        assert_eq!(
            state.store.stats().expect("读统计").total_entries,
            2,
            "全库上限要真的生效"
        );
    }
}
