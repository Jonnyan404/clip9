//! 数据迁移：把 **Go 版的数据目录**搬进 redb。
//!
//! 用法（子命令，见 `bin/clip9-server.rs`）：
//!
//! ```bash
//! clip9-server migrate -from <Go 数据目录> [-data <本实现数据目录>] [-dry-run]
//! ```
//!
//! # 为什么是命令行子命令，不是 web 导入
//!
//! ① 迁移必须在服务**打开数据库之前**跑 —— redb 是独占锁，服务在跑就迁不了；
//! ② Docker / OpenWrt 是无头环境，没有网页可用；
//! ③ 要幂等、可脚本化、能反复跑。
//! 反过来说，「web 导入」要求服务先起来（正好占着库），再把库换掉 —— 那是绕远路。
//!
//! # ⚠️★ 两条硬规矩（`dev-docs/ARCHITECTURE.md` §7 定的）
//!
//! 1. **幂等** —— 可重复跑。做法是「**已经存在的 id 直接跳过**」，
//!    而不是「再插一遍」：`Store::insert` 遇到已存在的 id 会覆盖，同时把
//!    **房间计数 +1** —— 重跑几次计数就飞了，而 `/rooms` 上看得出来。
//! 2. **保留原始文件不删** —— 它是**回退的唯一依据**。这个模块**只读** Go 那边的目录，
//!    一个字节都不动。
//!
//! # 迁什么
//!
//! - `history.json` → `messages` / `by_id` / `rooms` 三张表（走 `Store::insert`，
//!   所以计数、字节数、`next_id` 都会跟着更新）；
//! - `history.json` 里的 `file` 数组（上传登记表）→ `files` 表；
//! - `uploads/` 里的文件 → 本实现的存储目录（**原样拷**：两边磁盘上的名字都是 uuid 本身，
//!   见 `server/src/files.rs` 的 `stored_path_for`）。
//!
//! ⚠️ **不迁** `share-log.json`（分享是短期的，过期即失效）与 `tasks.json`
//! （定时任务是用户重写得出来的配置，不是数据）—— Jonny 2026-09-25 定的范围收窄。

use std::path::Path;

use clip9_protocol::History;
use clip9_store::Store;

/// 一次迁移的结果。**打出来给用户看**，所以字段名要能读懂。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// 新导入的消息条数。
    pub messages_imported: usize,
    /// 因为 id 已存在而跳过的条数（重复跑时会等于总数）。
    pub messages_skipped: usize,
    /// 登记表里导入 / 更新的文件条数。
    pub files_registered: usize,
    /// 拷过去的文件个数。
    pub uploads_copied: usize,
    /// 目标已存在、跳过的文件个数。
    pub uploads_skipped: usize,
    /// ⚠️ `history.json` 里登记了、但 `uploads/` 里**找不到**的文件（uuid）。
    /// **不报错**（老数据里本来就可能缺），但要**列出来** —— 迁完才发现文件没了最糟。
    pub uploads_missing: Vec<String>,
}

/// 跑一次迁移。`dry_run = true` 时**只读、只报告**，一个字节都不写。
///
/// ⚠️ `dry_run` 下**不打开 store**（redb 的 `open` 会顺手建库文件 —— 那是写操作）。
/// 代价是那种情况下报不出「已存在所以跳过」的条数；这是有意的取舍：dry-run 的承诺是
/// 「绝对不动任何东西」。
pub fn run(
    from: &Path,
    db_path: &Path,
    storage_dir: &Path,
    dry_run: bool,
) -> anyhow::Result<Report> {
    let history_path = from.join("history.json");
    let raw = std::fs::read_to_string(&history_path).map_err(|e| {
        anyhow::anyhow!(
            "读不到 {}：{e}\n（`-from` 应该指向 **Go 版的数据目录**，里面要有 history.json 与 uploads/）",
            history_path.display()
        )
    })?;
    let history: History = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("{} 解析失败：{e}", history_path.display()))?;

    let mut report = Report::default();

    // ── 上传登记表 + 文件本体 ────────────────────────────────────────────
    //
    // ⚠️ 先做文件：消息里的 `FileReceive.cache` 指向的是**文件 uuid**，
    // 所以文件没到位之前，消息先落库也不会「错」，但用户点开就 404 —— 先文件后消息，
    // 中断时留下的状态更容易解释（文件多余无害，消息指向缺失有害）。
    let from_uploads = from.join("uploads");
    let mut pending_files = Vec::new();
    for file in &history.file {
        if file.uuid.is_empty() {
            continue;
        }
        let src = from_uploads.join(&file.uuid);
        if src.is_file() {
            let dst = storage_dir.join(&file.uuid);
            if dst.exists() {
                report.uploads_skipped += 1;
            } else if !dry_run {
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&src, &dst).map_err(|e| {
                    anyhow::anyhow!("拷 {} → {} 失败：{e}", src.display(), dst.display())
                })?;
                report.uploads_copied += 1;
            } else {
                report.uploads_copied += 1;
            }
        } else {
            report.uploads_missing.push(file.uuid.clone());
        }
        pending_files.push(file.clone());
    }

    if dry_run {
        // ⚠️ dry-run 不打开 store，所以「已存在」那两栏只能留给真跑时报。
        report.messages_imported = history.receive.len();
        report.files_registered = pending_files.len();
        return Ok(report);
    }

    let store = Store::open(db_path)?;

    // ⚠️ 幂等的关键：**已存在的 id 直接跳过**（见模块注释 —— 重插会让房间计数 +1）。
    for mut entry in history.receive {
        let id = entry.id();
        if id > 0 && store.get(id)?.is_some() {
            report.messages_skipped += 1;
            continue;
        }
        // `id <= 0` 的老数据（理论上不该有）交给 store 自己分配。
        let inserted = store.insert(entry.clone())?;
        entry.set_id(inserted.id());
        report.messages_imported += 1;
    }

    for file in pending_files {
        store.put_file(&file)?;
        report.files_registered += 1;
    }

    Ok(report)
}

/// 把结果打成给人看的几行。抽出来是为了 `-dry-run` 与真跑共用同一套措辞。
#[must_use]
pub fn describe(report: &Report, dry_run: bool) -> String {
    let head = if dry_run {
        "【试运行】不会写任何东西。将要做的："
    } else {
        "迁移完成："
    };
    let mut out = String::from(head);
    out.push('\n');
    if dry_run {
        out.push_str(&format!(
            "  消息        {} 条（其中已存在的会在真跑时跳过）\n",
            report.messages_imported
        ));
        out.push_str(&format!("  文件登记    {} 条\n", report.files_registered));
        out.push_str(&format!(
            "  上传文件    {} 个要拷、{} 个目标已存在（跳过）\n",
            report.uploads_copied, report.uploads_skipped
        ));
    } else {
        out.push_str(&format!(
            "  消息        导入 {} 条、跳过 {} 条（已存在）\n",
            report.messages_imported, report.messages_skipped
        ));
        out.push_str(&format!("  文件登记    {} 条\n", report.files_registered));
        out.push_str(&format!(
            "  上传文件    拷了 {} 个、跳过 {} 个\n",
            report.uploads_copied, report.uploads_skipped
        ));
    }
    if !report.uploads_missing.is_empty() {
        out.push_str(&format!(
            "  ⚠️ 登记了但磁盘上没有的文件 {} 个：{}\n",
            report.uploads_missing.len(),
            report.uploads_missing.join(", ")
        ));
        out.push_str("     （老数据里本来就可能缺，不报错；但这些文件的下载会是 404）\n");
    }
    out.push_str("  ⚠️ 原始数据**一个字节都没动** —— 它是回退的唯一依据，要删请你自己确认后删。\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use clip9_store::Store;
    use std::path::PathBuf;

    /// 造一份「Go 数据目录」：`history.json`（两条消息 + 一条文件登记）+ `uploads/<uuid>`。
    ///
    /// ⚠️ 字段名按 **Go 实际吐出来的**写（`id` / `type` / `room` / `content` / `uploadTime`…），
    /// 不是照文档抄 —— 迁移工具读的就是那份文件的真实形状。
    fn make_go_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("uploads")).expect("建 uploads");

        let uuid = "aaaa-bbbb";
        std::fs::write(root.join("uploads").join(uuid), b"hello").expect("写上传文件");

        let history = serde_json::json!({
            "receive": [
                {
                    "id": 1, "type": "text", "room": "default", "timestamp": 1000,
                    "senderIP": "127.0.0.1", "content": "第一条"
                },
                {
                    "id": 2, "type": "text", "room": "work", "timestamp": 1001,
                    "senderIP": "127.0.0.1", "content": "第二条"
                },
                {
                    "id": 3, "type": "file", "room": "default", "timestamp": 1002,
                    "senderIP": "127.0.0.1", "name": "a.txt", "size": 5,
                    "cache": uuid, "expire": 0, "url": ""
                }
            ],
            "file": [
                { "name": "a.txt", "uuid": uuid, "size": 5,
                  "uploadTime": 1002, "expireTime": 0, "room": "default" }
            ]
        });
        std::fs::write(
            root.join("history.json"),
            serde_json::to_string_pretty(&history).unwrap(),
        )
        .expect("写 history.json");
        (dir, root)
    }

    /// ⚠️ 这条测试盯的是**两条硬规矩**：幂等、以及**原始数据不动**。
    ///
    /// 幂等那条尤其要盯住「跳过」而不是「重插」：`Store::insert` 遇到已存在的 id 会覆盖，
    /// 同时把房间计数 **+1** —— 重跑几次计数就飞了，而 `/rooms` 上看得出来。
    #[test]
    fn migrate_is_idempotent_and_never_touches_the_source() {
        let (from_dir, from) = make_go_dir();
        let to_dir = tempfile::tempdir().expect("建目标目录");
        let to = to_dir.path();
        let db = to.join("t.redb");
        let uploads = to.join("uploads");
        std::fs::create_dir_all(&uploads).expect("建目标 uploads");

        // ── 第一遍：全部导入 ──
        let first = run(&from, &db, &uploads, false).expect("第一次迁移");
        assert_eq!(first.messages_imported, 3, "三条消息都要进来");
        assert_eq!(first.messages_skipped, 0);
        assert_eq!(first.files_registered, 1);
        assert_eq!(first.uploads_copied, 1);
        assert!(first.uploads_missing.is_empty());

        // 磁盘上真有那个文件（不是只写了登记表）。
        assert!(uploads.join("aaaa-bbbb").is_file(), "上传文件要真的拷过来");

        // ── 第二遍：全跳过 ──
        let second = run(&from, &db, &uploads, false).expect("第二次迁移");
        assert_eq!(second.messages_imported, 0, "幂等：第二遍不该再导入");
        assert_eq!(second.messages_skipped, 3);
        assert_eq!(second.uploads_copied, 0);
        assert_eq!(second.uploads_skipped, 1);

        // ── 计数没被重跑放大（这是「跳过」而不是「重插」的直接证据）──
        let store = Store::open(&db).expect("打开库");
        let rooms = store.rooms().expect("读房间");
        let default = rooms
            .iter()
            .find(|r| r.name == "default")
            .expect("default 房间");
        assert_eq!(default.message_count, 2, "重跑不能让房间计数翻倍");
        assert_eq!(rooms.len(), 2, "两个房间");

        // ── 原始数据一个字节都没动 ──
        assert!(from.join("history.json").is_file());
        assert!(from.join("uploads").join("aaaa-bbbb").is_file());
        let after: History = serde_json::from_str(
            &std::fs::read_to_string(from.join("history.json")).expect("回读 history.json"),
        )
        .expect("还是合法 JSON");
        assert_eq!(after.receive.len(), 3, "源文件不该被改写");
        drop(from_dir);
    }

    /// `dry_run` 的承诺是「绝对不动任何东西」—— 连库都不打开（那会建文件）。
    #[test]
    fn dry_run_writes_nothing() {
        let (_from_dir, from) = make_go_dir();
        let to_dir = tempfile::tempdir().expect("建目标目录");
        let to = to_dir.path();
        let db = to.join("never.redb");
        let uploads = to.join("never-uploads");

        let report = run(&from, &db, &uploads, true).expect("试运行");
        assert_eq!(report.messages_imported, 3, "报告里要如实说会导入几条");
        assert!(!db.exists(), "dry-run 不该建库文件");
        assert!(!uploads.exists(), "dry-run 不该建上传目录");

        // ⚠️ 顺带钉住「登记了但磁盘上没有」那条：不报错，但要列出来。
        let (_dir2, from2) = make_go_dir();
        std::fs::remove_file(from2.join("uploads").join("aaaa-bbbb")).expect("删掉上传文件");
        let report2 = run(&from2, &db, &uploads, true).expect("试运行 2");
        assert_eq!(report2.uploads_missing, vec!["aaaa-bbbb".to_owned()]);
    }
}
