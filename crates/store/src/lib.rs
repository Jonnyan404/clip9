//! clip9 存储层。
//!
//! **只有这个 crate 知道存储长什么样。** 换引擎（redb → fjall）时，改动应该被挡在
//! 这条边界里，`core` 与 `server` 一行都不用动。设计见 `docs/ARCHITECTURE.md` §3。
//!
//! # 表结构
//!
//! ```text
//! messages:  (room, ts_desc, id_desc) -> JSON 字节     # 「按房间取最近 N 条」= 一次正向范围扫描
//! by_id:     id                       -> (room, ts)   # /content/<id>、/revoke/<id>、看板挪列
//! rooms:     room                     -> (条数, 最后活跃 ts)  # /rooms 用它，免得每次全表扫
//! meta:      "schema_version" | "next_id" | "stored_bytes" -> u64
//! ```
//!
//! # ⚠️ 值为什么用 JSON，而不是 bincode / postcard
//!
//! 结论是**实测**出来的（2026-09-25），不是偏好。有**两条各自独立**的理由，任何一条都足以否掉
//! 「字段名省掉的紧凑二进制」这条路：
//!
//! 1. **`#[serde(flatten)]` 与非自描述格式不兼容。** `TextReceive` / `FileReceive` 都把
//!    `ReceiveBase` 挂成 flatten，而 serde 的 flatten **序列化**走 `serialize_map(None)`
//!    （长度未知）→ postcard 直接报 `SerializeSeqLengthUnknown`；反序列化那侧还要
//!    `deserialize_any` 缓冲未知字段，非自描述格式同样给不了。
//! 2. **`skip_serializing_if` 与非自描述格式不兼容。** `ReceiveBase` 上一堆 `omitempty`
//!    语义（`senderClientID` / `column` / `source` / `scheduledAt` / `late` …）。
//!    紧凑二进制按**顺序**写字段、**不写字段数**，跳过任何一个都会让读的那侧错位 ——
//!    而且错位是静默的，读出来是「字段串了位」而不是报错。
//!
//! ## 考虑过的替代方案，以及为什么否掉
//!
//! | 方案 | 否掉的理由 |
//! |---|---|
//! | 在 store 里再写一份**扁平且不 skip** 的镜像结构体 | 要抄 10 个基类字段 + 各自特有字段。这个项目已经被「抄漏一个字段、静默丢数据」咬过好几次 —— **主动引入一个靠人肉同步的副本，是在制造已知会出事的那类 bug** |
//! | MessagePack / CBOR（自描述二进制） | 能直接用 protocol 的类型，但**字段名占大头**，实测省不到 30%。为这点收益多一个不透明格式 + 一个依赖，不划算 |
//! | 直接把线上 JSON 当存储格式 | **这条就是现在的做法**，但要说清代价：以后改契约会连带改存储布局。所以存储格式自己显式版本化（`SCHEMA_VERSION`），改契约时如果形状变了，要一并想清楚数据迁移 |
//!
//! ## 现状的取舍
//!
//! 好处：迁移时能把 Go 的 `history.json` **原样搬过来**（同一份 JSON），少一次形状转换就少
//! 一类保真风险；库可以用任何 JSON 工具直接看。
//!
//! 代价：值大约 1.8 倍。但 `Limits::max_bytes` 本来就是可配的 —— OpenWrt 上把上限设小即可，
//! 而那条约束本来就在（16MB flash）。
//!
//! ⚠️ 本文件末尾有一条**反向**回归测试钉住上面第 1 条。哪天它开始失败，说明 serde 变了，
//! 那时才值得重新评估。

pub mod keys;
pub mod limits;

use std::collections::BTreeMap;
use std::path::Path;

use clip9_core::task::AutomationTask;
use clip9_protocol::{File, ReceiveHolder, normalize_room_name};
use redb::{
    Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, Table, TableDefinition,
};
use serde::{Deserialize, Serialize};

pub use keys::{id_desc, id_from_desc, ts_desc, ts_from_desc};
pub use limits::Limits;

/// 库格式版本。**改表结构就要改它** —— 迁移工具靠它判断要不要转换。
pub const SCHEMA_VERSION: u64 = 1;

const MESSAGES: TableDefinition<(&str, u64, u32), &[u8]> = TableDefinition::new("messages");
const BY_ID: TableDefinition<i32, (&str, i64)> = TableDefinition::new("by_id");
const ROOMS: TableDefinition<&str, (u64, i64)> = TableDefinition::new("rooms");
const META: TableDefinition<&str, u64> = TableDefinition::new("meta");
/// 上传文件的登记表：`uuid -> File`（JSON）。
///
/// ⚠️ Go 把它放在**内存 map** 里，再顺手写进 `history.json` 的 `file` 数组 ——
/// 于是重启之后「文件还在磁盘上、但登记没了」，`/file/<uuid>` 直接 404。
/// 这边让它进库：重启后仍然认得已经传过的文件。
///
/// ⚠️ **新增一张表不用改 `SCHEMA_VERSION`** —— 那个版本号管的是**已有表的结构**，
/// 加表是纯增量，老库打开时 `init_schema` 会把它建出来。
const FILES: TableDefinition<&str, &[u8]> = TableDefinition::new("files");
/// 分享记录表：`jti -> ShareRecord`（JSON）。
///
/// ⚠️ 它和 Go 的 `share-log.json` 是同一份数据，只是换了载体（理由写在 [`Store::put_share`]）。
/// 迁移工具要把那个 JSON 文件读进来写成这张表。
///
/// ⚠️ **新增一张表不用改 `SCHEMA_VERSION`** —— 见上面 `FILES` 的注释。
const SHARES: TableDefinition<&str, &[u8]> = TableDefinition::new("shares");
/// 定时任务表：`task id -> AutomationTask`（JSON）。
///
/// ⚠️ Go 把它放在 `tasks.json`（整份原子重写）。这边让它进库：和分享记录同理，
/// 少一类「半截 JSON」的失败模式，也少一条迁移工具的路径。
///
/// ⚠️ **新增一张表不用改 `SCHEMA_VERSION`** —— 见上面 `FILES` 的注释。
const TASKS: TableDefinition<&str, &[u8]> = TableDefinition::new("tasks");

const K_SCHEMA_VERSION: &str = "schema_version";
const K_NEXT_ID: &str = "next_id";
/// 定时任务的**单调序号**计数器。见 [`Store::put_task`] / [`Store::list_tasks`]。
///
/// ⚠️ 它和 `K_NEXT_ID` 是**两个独立的**计数器，不能合用：消息 id 是 i32、
/// 任务是 i64，而且两者的「跳到已有值之后」是各自表的事。
const K_NEXT_TASK_SEQ: &str = "next_task_seq";
const K_STORED_BYTES: &str = "stored_bytes";

/// 一次 `trim_global` 最多删多少条。
///
/// ⚠️ 有上限是刻意的：裁剪是**低频后台**动作，不该在某一次调用里长时间独占写事务
/// （那期间所有写入都在等）。调用方循环调用直到返回 0。
const TRIM_BATCH: usize = 1_000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("打开/创建数据库失败: {0}")]
    Database(#[from] redb::DatabaseError),
    #[error("开启事务失败: {0}")]
    Transaction(#[from] redb::TransactionError),
    #[error("表操作失败: {0}")]
    Table(#[from] redb::TableError),
    #[error("读写失败: {0}")]
    Storage(#[from] redb::StorageError),
    #[error("提交事务失败: {0}")]
    Commit(#[from] redb::CommitError),
    #[error("条目编解码失败: {0}")]
    Codec(#[from] serde_json::Error),
    #[error("索引与数据不一致：id={id} 在 by_id 里有，messages 里没有")]
    IndexDrift { id: i32 },
    #[error("消息 id 已用尽（超过 i32::MAX）—— 该迁移到更宽的 id 类型了")]
    IdExhausted,
    #[error("schema 版本不匹配：库里是 {found}，本程序要 {expected}")]
    SchemaMismatch { found: u64, expected: u64 },
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

/// 一个房间的汇总（`/rooms` 用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomSummary {
    pub name: String,
    pub message_count: u64,
    /// ⚠️ 这是**高水位**（只增不减）：删掉最新那条之后它不会回落。
    /// 语义上「最后活跃时间」本来就该如此，但别拿它当「最新一条的时间戳」用。
    pub last_active: i64,
}

/// 库的整体统计。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreStats {
    pub total_entries: u64,
    pub total_bytes: u64,
    pub next_id: u64,
}

/// 一条分享的事实记录。
///
/// 为什么需要它：分享令牌是**无状态签名**，服务端不留痕迹 —— 于是「我最近分享过什么」
/// 「这条链接被打开了几次」「限次链接还剩几次」三个问题都答不上来。这里只补最小的事实。
///
/// ⚠️ **不含 token 本身**：token 是 bearer 凭据，记录列表一旦带上它，就成了「谁都能把别人的
/// 分享链接再抄一遍」的入口（Go 那边专门有一条注释讲这件事）。
///
/// ⚠️ 字段名与 `/share/list` 的响应**不是**一一对应：响应里还有 `used` 的实时值和 `expired`
/// 这类派生字段，它们在 server 侧拼。这里存的是事实。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareRecord {
    /// 档案号（`/share/list` 的 `jti`）。
    pub jti: String,
    /// 分享指向什么：`content` | `file`。
    #[serde(rename = "type")]
    pub share_type: String,
    /// content id 或 file uuid。
    pub id: String,
    /// 创建时归属的房间（归一化过）。
    pub room: String,
    /// 最终指向的条目类型：`text` | `file`（内容分享才有区分）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// 文件名，或文本首行摘要 —— 记录列表里要能一眼认出「分享的是哪条」。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub size: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// 过期时刻（token 里的 `exp` 抄一份，裁剪时不用去解析 token）。
    pub exp: i64,
    #[serde(rename = "maxUses")]
    pub max_uses: i64,
    /// 这条分享要不要密码。**只存布尔值**，密码哈希在 token 里。
    pub password: bool,
    /// 分享页被真人打开的次数。
    #[serde(default)]
    pub visits: u64,
    /// 其中来自二维码的次数（链接带 `?q=1`）。
    #[serde(default)]
    pub scans: u64,
    /// 已用次数。
    ///
    /// ⚠️★ 这是**我们比 Go 多存的东西**：Go 把用量放在进程内的 map 里，
    /// 重启之后「最多 3 次」的链接又能用 3 次 —— 限量被静默重置了。
    /// 既然每条分享本来就有档案号，把用量挂在它上面是顺手的事。
    #[serde(default)]
    pub used: u64,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde 的 skip_serializing_if 要的是引用
fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// 扣一次使用额度的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareUse {
    /// 扣成功，`used` 是**扣完之后**的次数。
    Consumed { used: u64 },
    /// 次数用尽。
    Exhausted { used: u64, max_uses: u64 },
    /// 记录还在，但已经过期。
    Expired,
    /// 没有这条记录（被裁掉了，或者压根不是这条服务签的）。
    Unknown,
}

/// redb 封装。
///
/// `Database` 自身是 `Send + Sync`，`begin_write` 会串行化写事务 ——
/// 所以这里**不需要额外的锁**，也不该加（多一层锁只会掩盖 redb 自己的并发语义）。
pub struct Store {
    db: Database,
    limits: Limits,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `redb::Database` 没有 `Debug`，而它的内部状态对排查问题也没什么用 —— 只报出限额。
        // 手写而不是 derive，是为了把「为什么这里没有库的细节」写在代码里。
        f.debug_struct("Store")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl Store {
    /// 用默认限额打开（不存在就建）。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(path, Limits::default())
    }

    /// 打开并施加限额。
    pub fn open_with(path: impl AsRef<Path>, limits: Limits) -> Result<Self> {
        // `Database::create` 是**建或打开**：文件不存在/是空文件就初始化，是合法 redb 库就打开。
        let db = Database::create(path)?;
        let store = Self { db, limits };
        store.init_schema()?;
        Ok(store)
    }

    #[must_use]
    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// 建表 + 写初始 meta。幂等。
    ///
    /// ⚠️ redb 的 `open_table` 在**写**事务里是「建或打开」—— 所以必须有一次写事务才能真正
    /// 把表建出来。只读事务里打开一张不存在的表会报 `TableDoesNotExist`。
    fn init_schema(&self) -> Result<()> {
        let txn = self.db.begin_write()?;
        {
            let _ = txn.open_table(MESSAGES)?;
            let _ = txn.open_table(BY_ID)?;
            let _ = txn.open_table(ROOMS)?;
            let _ = txn.open_table(FILES)?;
            let _ = txn.open_table(SHARES)?;
            let _ = txn.open_table(TASKS)?;
            let mut meta = txn.open_table(META)?;

            // ⚠️ 先把 guard 里的值取出来再写 —— 否则 `meta.get()` 的不可变借用
            // 会一直活到语句结束，和 `meta.insert()` 的可变借用打架。
            let found = meta.get(K_SCHEMA_VERSION)?.map(|g| g.value());
            match found {
                None => {
                    meta.insert(K_SCHEMA_VERSION, SCHEMA_VERSION)?;
                    meta.insert(K_NEXT_ID, 1)?;
                    meta.insert(K_STORED_BYTES, 0)?;
                }
                Some(found) if found != SCHEMA_VERSION => {
                    return Err(StoreError::SchemaMismatch {
                        found,
                        expected: SCHEMA_VERSION,
                    });
                }
                Some(_) => {}
            }
        }
        txn.commit()?;
        Ok(())
    }

    // ── 写 ────────────────────────────────────────────────────────────

    /// 插入一条。`id <= 0` 时分配一个新 id（和 Go `appendLocked` 一致），
    /// 返回**带上 id 的**条目（调用方要拿它去广播）。
    ///
    /// 分配 id、写 messages、写 by_id、更新房间计数、更新字节计数 —— 全在**一个写事务**里，
    /// 所以不存在「id 分配了但消息没落盘」这种中间态。
    pub fn insert(&self, mut entry: ReceiveHolder) -> Result<ReceiveHolder> {
        let room = normalize_room_name(entry.room());
        entry.base_mut().room = room.clone();
        let ts = entry.timestamp();

        let txn = self.db.begin_write()?;
        {
            let mut meta = txn.open_table(META)?;
            let mut messages = txn.open_table(MESSAGES)?;
            let mut by_id = txn.open_table(BY_ID)?;
            let mut rooms = txn.open_table(ROOMS)?;

            let mut next_id = meta.get(K_NEXT_ID)?.map_or(1, |g| g.value());
            if entry.id() <= 0 {
                // ⚠️ 溢出必须**报错**，不能 `unwrap_or(i32::MAX)` —— 那样从某一刻起每条消息
                // 都会拿到同一个 id，键直接互相覆盖：**静默丢数据**，而且只在跑到 21 亿条时
                // 才出现，测试永远碰不到。宁可在这里硬失败。
                entry.set_id(i32::try_from(next_id).map_err(|_| StoreError::IdExhausted)?);
            }
            let id = entry.id();
            let payload = serde_json::to_vec(&entry)?;

            messages.insert(
                (room.as_str(), ts_desc(ts), id_desc(id)),
                payload.as_slice(),
            )?;
            by_id.insert(id, (room.as_str(), ts))?;

            let (count, last_active) = rooms
                .get(room.as_str())?
                .map_or((0u64, i64::MIN), |g| g.value());
            rooms.insert(room.as_str(), (count + 1, last_active.max(ts)))?;

            let bytes = meta.get(K_STORED_BYTES)?.map_or(0, |g| g.value());
            meta.insert(K_STORED_BYTES, bytes + payload.len() as u64)?;

            // ⚠️ 和 Go 的 `if m.nextid <= itemID { m.nextid = itemID + 1 }` 一致：
            // 迁移工具会带着**已有 id** 灌数据，计数器必须能跳过去，否则后面新插入的
            // 消息会撞上迁移进来的 id。
            next_id = next_id.max(id as u64 + 1);
            meta.insert(K_NEXT_ID, next_id)?;
        }
        txn.commit()?;

        // 写入之后做**局部**裁剪（按房间，范围被 key 限死，很快）。
        // 全库整理是另一件事，见 `trim_global`。
        self.trim_room(&room)?;

        Ok(entry)
    }

    /// 覆盖写一条（改正文 / 看板挪列）。
    ///
    /// ⚠️ 房间或时间戳变了 → key 跟着变，所以是「删旧 key + 写新 key」，不是就地覆盖。
    /// 看板挪列**不该动 timestamp**（挪位置不该让卡片跳到最前），那条路径上 key 其实不变 ——
    /// 但代码不该依赖这一点。
    ///
    /// 返回 `false` 表示这条 id 不存在。
    pub fn replace(&self, entry: &ReceiveHolder) -> Result<bool> {
        let id = entry.id();
        if id <= 0 {
            return Ok(false);
        }
        let room = normalize_room_name(entry.room());
        let ts = entry.timestamp();
        let payload = serde_json::to_vec(entry)?;

        let txn = self.db.begin_write()?;
        let existed = {
            let mut meta = txn.open_table(META)?;
            let mut messages = txn.open_table(MESSAGES)?;
            let mut by_id = txn.open_table(BY_ID)?;
            let mut rooms = txn.open_table(ROOMS)?;

            // guard 必须在写之前丢掉，所以在这里就把值拷出来。
            let old = by_id.get(id)?.map(|g| {
                let (r, t) = g.value();
                (r.to_owned(), t)
            });
            let Some((old_room, old_ts)) = old else {
                return Ok(false);
            };

            let old_len = messages
                .get((old_room.as_str(), ts_desc(old_ts), id_desc(id)))?
                .map_or(0u64, |g| g.value().len() as u64);
            messages.remove((old_room.as_str(), ts_desc(old_ts), id_desc(id)))?;

            messages.insert(
                (room.as_str(), ts_desc(ts), id_desc(id)),
                payload.as_slice(),
            )?;
            by_id.insert(id, (room.as_str(), ts))?;

            if old_room == room {
                bump_room(&mut rooms, &room, 0, ts)?;
            } else {
                bump_room(&mut rooms, &old_room, -1, i64::MIN)?;
                bump_room(&mut rooms, &room, 1, ts)?;
            }

            let bytes = meta.get(K_STORED_BYTES)?.map_or(0, |g| g.value());
            meta.insert(
                K_STORED_BYTES,
                bytes.saturating_sub(old_len) + payload.len() as u64,
            )?;
            true
        };
        txn.commit()?;
        Ok(existed)
    }

    /// 按 id 删一条（`/revoke/<id>`）。返回 `false` 表示本来就没有。
    pub fn remove(&self, id: i32) -> Result<bool> {
        let txn = self.db.begin_write()?;
        let removed = {
            let mut meta = txn.open_table(META)?;
            let mut messages = txn.open_table(MESSAGES)?;
            let mut by_id = txn.open_table(BY_ID)?;
            let mut rooms = txn.open_table(ROOMS)?;

            let old = by_id.get(id)?.map(|g| {
                let (r, t) = g.value();
                (r.to_owned(), t)
            });
            let Some((old_room, old_ts)) = old else {
                return Ok(false);
            };

            let len = messages
                .get((old_room.as_str(), ts_desc(old_ts), id_desc(id)))?
                .map_or(0u64, |g| g.value().len() as u64);
            messages.remove((old_room.as_str(), ts_desc(old_ts), id_desc(id)))?;
            by_id.remove(id)?;
            bump_room(&mut rooms, &old_room, -1, i64::MIN)?;

            let bytes = meta.get(K_STORED_BYTES)?.map_or(0, |g| g.value());
            meta.insert(K_STORED_BYTES, bytes.saturating_sub(len))?;
            true
        };
        txn.commit()?;
        Ok(removed)
    }

    /// 分配一个新 id（不插入任何东西）。
    ///
    /// 定时任务的临时消息要用它 —— 那些消息**不入历史**，但仍需要一个唯一 id
    /// （前端拿它做列表 key）。和 Go 的 `NextEphemeralID()` 一个意思：
    /// 走**同一个计数器**，只是不落 List。
    pub fn next_ephemeral_id(&self) -> Result<i32> {
        let txn = self.db.begin_write()?;
        let id = {
            let mut meta = txn.open_table(META)?;
            let next = meta.get(K_NEXT_ID)?.map_or(1, |g| g.value());
            // 和 `insert` 同一个理由：溢出要硬失败，不能退化成重复 id。
            let id = i32::try_from(next).map_err(|_| StoreError::IdExhausted)?;
            meta.insert(K_NEXT_ID, next + 1)?;
            id
        };
        txn.commit()?;
        Ok(id)
    }

    // ── 读 ────────────────────────────────────────────────────────────

    /// 按 id 取一条。
    pub fn get(&self, id: i32) -> Result<Option<ReceiveHolder>> {
        let txn = self.db.begin_read()?;
        let by_id = txn.open_table(BY_ID)?;
        let messages = txn.open_table(MESSAGES)?;

        let loc = by_id.get(id)?.map(|g| {
            let (r, t) = g.value();
            (r.to_owned(), t)
        });
        let Some((room, ts)) = loc else {
            return Ok(None);
        };

        let Some(bytes) = messages.get((room.as_str(), ts_desc(ts), id_desc(id)))? else {
            // ⚠️ by_id 有、messages 没有 = 索引和数据不一致。这是**库坏了**，
            // 不该静默当成「没找到」—— 静默会让 revoke 看起来成功其实没删。
            return Err(StoreError::IndexDrift { id });
        };
        Ok(Some(serde_json::from_slice(bytes.value())?))
    }

    /// 某房间最近 `limit` 条，**新的在前**。
    pub fn recent_desc(&self, room: &str, limit: usize) -> Result<Vec<ReceiveHolder>> {
        let room = normalize_room_name(room);
        let txn = self.db.begin_read()?;
        let messages = txn.open_table(MESSAGES)?;
        let (low, high) = keys::room_bounds(room.as_str());

        let mut out = Vec::new();
        for row in messages.range(low..=high)?.take(limit) {
            let (_, value) = row?;
            out.push(serde_json::from_slice(value.value())?);
        }
        Ok(out)
    }

    /// 某房间最近 `limit` 条，**旧的在前**。
    ///
    /// ⚠️ WS 历史回放要这个顺序：客户端是一条条 append 的，倒序推过去会把列表翻过来。
    pub fn recent_asc(&self, room: &str, limit: usize) -> Result<Vec<ReceiveHolder>> {
        let mut rows = self.recent_desc(room, limit)?;
        rows.reverse();
        Ok(rows)
    }

    /// 某房间最新的那一条（`/content/latest`）。
    ///
    /// ⚠️ 「最新」的判定是 `timestamp DESC, id DESC` —— 时间戳是**秒级**，
    /// 同一秒里插入的多条必须靠 id 分先后。这正是 key 里带 `id_desc` 的原因。
    pub fn latest(&self, room: &str) -> Result<Option<ReceiveHolder>> {
        Ok(self.recent_desc(room, 1)?.into_iter().next())
    }

    /// 分页：取比 `before_id` **更早**的 `limit` 条，新的在前。
    ///
    /// 对应 ARCHITECTURE §6.2 新增的 `GET /content?room=&before=<id>&limit=`。
    /// ⚠️ 游标用 **id 而不是时间戳**：时间戳是秒级、同秒会重复，用它做游标会漏条或重复。
    pub fn page_before(
        &self,
        room: &str,
        before_id: i32,
        limit: usize,
    ) -> Result<Vec<ReceiveHolder>> {
        use std::ops::Bound;

        let room = normalize_room_name(room);

        // ⚠️ 锚点和扫描必须在**同一个读事务**里。分成两个事务会有一个窗口：
        // 读完锚点、还没开始扫，那条就被 revoke 了 —— 于是这一页基于一个已经不存在的
        // 位置去翻，翻出来的东西是错的（而且不报错）。redb 的读事务是快照，一个就够。
        let txn = self.db.begin_read()?;
        let by_id = txn.open_table(BY_ID)?;
        let messages = txn.open_table(MESSAGES)?;

        let anchor_ts = by_id.get(before_id)?.map(|g| g.value().1);
        let Some(anchor_ts) = anchor_ts else {
            // 游标失效（那条被删了）→ 退化成「取最近 limit 条」。
            // ⚠️ 别报错：删一条旧消息不该让整页翻不动。
            return self.recent_desc(&room, limit);
        };

        let start = (room.as_str(), ts_desc(anchor_ts), id_desc(before_id));
        let mut out = Vec::new();
        // ⚠️ 游标本身必须**排除**：`range(start..)` 是闭区间，直接那么写会把锚点那条
        // 也算进「更早的一页」里 —— 表现是翻页时同一条出现两次。
        // 比锚点更早 = key 更大（ts_desc 是倒序的）→ 从锚点往右扫，但开区间起步。
        for row in messages
            .range((Bound::Excluded(start), Bound::Unbounded))?
            .take(limit)
        {
            let (key, value) = row?;
            let (row_room, _, _) = key.value();
            if row_room != room {
                break; // 出了这个房间就停
            }
            out.push(serde_json::from_slice(value.value())?);
        }
        Ok(out)
    }

    /// 房间列表。**不扫消息表** —— 走 `rooms` 计数表，O(房间数)。
    pub fn rooms(&self) -> Result<Vec<RoomSummary>> {
        let txn = self.db.begin_read()?;
        let rooms = txn.open_table(ROOMS)?;
        let mut out = Vec::new();
        for row in rooms.iter()? {
            let (name, stats) = row?;
            let (count, last_active) = stats.value();
            out.push(RoomSummary {
                name: name.value().to_owned(),
                message_count: count,
                last_active,
            });
        }
        // 最近活跃的排前面。
        out.sort_by_key(|r| std::cmp::Reverse(r.last_active));
        Ok(out)
    }

    /// 删掉一个房间的**计数行**（`rooms` 表里那一行）。
    ///
    /// ⚠️ **只删计数行，不删消息。** 调用方必须先确认「这个房间确实是空的」
    /// （计数为 0、没有连接）—— 见 `server/src/room_cleanup.rs`。
    /// 删一个还有消息的房间会让 `/rooms` 少一行，而消息还在库里，
    /// 两个视图就对不上了（`/rooms` 的房间来源本来就是「计数行 ∪ 有连接的 ∪ 有消息的」，
    /// 所以消息还在时它**仍然会出现** —— 删那一行等于什么都没省，只是把状态搞乱）。
    pub fn remove_room(&self, name: &str) -> Result<()> {
        let txn = self.db.begin_write()?;
        {
            let mut rooms = txn.open_table(ROOMS)?;
            rooms.remove(name)?;
        }
        txn.commit()?;
        Ok(())
    }

    /// 整体统计。
    pub fn stats(&self) -> Result<StoreStats> {
        let txn = self.db.begin_read()?;
        let meta = txn.open_table(META)?;
        let messages = txn.open_table(MESSAGES)?;
        Ok(StoreStats {
            total_entries: messages.len()?,
            total_bytes: meta.get(K_STORED_BYTES)?.map_or(0, |g| g.value()),
            next_id: meta.get(K_NEXT_ID)?.map_or(1, |g| g.value()),
        })
    }

    // ── 裁剪 ──────────────────────────────────────────────────────────

    /// 把某个房间裁到 `per_room`。返回删掉的条数。
    ///
    /// 这是**写入路径上的局部裁剪**：范围被 key 限死在一个房间内，代价与该房间的超额成正比，
    /// 不是全表扫。全库维度（`total` / `max_bytes`）走 `trim_global`，低频后台跑。
    pub fn trim_room(&self, room: &str) -> Result<usize> {
        let Some(per_room) = self.limits.per_room else {
            return Ok(0);
        };
        let room = normalize_room_name(room);

        let txn = self.db.begin_write()?;
        let removed = {
            let mut meta = txn.open_table(META)?;
            let mut messages = txn.open_table(MESSAGES)?;
            let mut by_id = txn.open_table(BY_ID)?;
            let mut rooms = txn.open_table(ROOMS)?;

            let (low, high) = keys::room_bounds(room.as_str());
            // 先收集要删的 key。key 顺序 = 新到旧，所以前 per_room 个留着。
            let mut doomed: Vec<(String, u64, u32)> = Vec::new();
            for (kept, row) in messages.range(low..=high)?.enumerate() {
                let (key, _) = row?;
                if kept >= per_room {
                    let (r, ts, id) = key.value();
                    doomed.push((r.to_owned(), ts, id));
                }
            }
            if doomed.is_empty() {
                return Ok(0);
            }

            let mut freed = 0u64;
            for (r, ts, id) in &doomed {
                if let Some(bytes) = messages.remove((r.as_str(), *ts, *id))? {
                    freed += bytes.value().len() as u64;
                }
                by_id.remove(id_from_desc(*id))?;
            }

            let bytes = meta.get(K_STORED_BYTES)?.map_or(0, |g| g.value());
            meta.insert(K_STORED_BYTES, bytes.saturating_sub(freed))?;
            let (count, last_active) = rooms
                .get(room.as_str())?
                .map_or((0u64, i64::MIN), |g| g.value());
            rooms.insert(
                room.as_str(),
                (count.saturating_sub(doomed.len() as u64), last_active),
            )?;
            doomed.len()
        };
        txn.commit()?;
        Ok(removed)
    }

    /// 全库整理：`total` 与 `max_bytes`。返回删掉的条数。
    ///
    /// ⚠️ **必须在后台低频跑**（比如每小时），不要在写入路径上调 —— 它要扫全表。
    ///
    /// 内部按批（[`TRIM_BATCH`]）循环到不再超限，**调用方一次调用就够**。
    /// （以前要求调用方自己写 `loop { if trim() == 0 { break } }` —— 那是个容易漏的接口，
    /// 漏了的表现是「限额没生效」而**没有任何报错**。）
    ///
    /// ⚠️ **丢最旧的是明确选择，不是默认行为**：超限时静默丢数据是自托管场景里最讨厌的
    /// 一类 bug。要「拒绝写入」而不是「丢旧的」，得在 `insert` 那侧拦，见 ARCHITECTURE §3.3。
    pub fn trim_global(&self) -> Result<usize> {
        // 上限是防呆：真出问题时别在这儿转一辈子。
        const MAX_ROUNDS: usize = 20;
        let mut total_removed = 0;
        for _ in 0..MAX_ROUNDS {
            let removed = self.trim_global_once()?;
            if removed == 0 {
                break;
            }
            total_removed += removed;
        }
        Ok(total_removed)
    }

    /// 单批裁剪：最多删 [`TRIM_BATCH`] 条，返回这一批删了几条（`0` = 已经不再超限）。
    fn trim_global_once(&self) -> Result<usize> {
        let stats = self.stats()?;
        let over_count = self
            .limits
            .total
            .map_or(0, |t| stats.total_entries.saturating_sub(t as u64) as usize);
        let over_bytes = self
            .limits
            .max_bytes
            .map_or(0, |m| stats.total_bytes.saturating_sub(m));

        if over_count == 0 && over_bytes == 0 {
            return Ok(0);
        }

        let txn = self.db.begin_write()?;
        let removed = {
            let mut meta = txn.open_table(META)?;
            let mut messages = txn.open_table(MESSAGES)?;
            let mut by_id = txn.open_table(BY_ID)?;
            let mut rooms = txn.open_table(ROOMS)?;

            // 全局最旧的 = key 最大的那批（ts_desc 倒序），所以从尾部取。
            let mut doomed: Vec<(String, u64, u32, u64)> = Vec::new();
            let mut acc_bytes = 0u64;
            let mut budget = TRIM_BATCH;
            for row in messages.iter()?.rev() {
                if budget == 0 {
                    break;
                }
                let (key, value) = row?;
                let len = value.value().len() as u64;
                let (r, ts, id) = key.value();
                doomed.push((r.to_owned(), ts, id, len));
                acc_bytes += len;
                budget -= 1;

                if over_count > 0 && doomed.len() >= over_count {
                    break;
                }
                if over_count == 0 && acc_bytes >= over_bytes {
                    break;
                }
            }
            if doomed.is_empty() {
                return Ok(0);
            }

            let mut freed = 0u64;
            for (r, ts, id, len) in &doomed {
                messages.remove((r.as_str(), *ts, *id))?;
                by_id.remove(id_from_desc(*id))?;
                freed += len;
                bump_room(&mut rooms, r, -1, i64::MIN)?;
            }

            let bytes = meta.get(K_STORED_BYTES)?.map_or(0, |g| g.value());
            meta.insert(K_STORED_BYTES, bytes.saturating_sub(freed))?;
            doomed.len()
        };
        txn.commit()?;

        if removed > 0 {
            tracing::info!(removed, "全库裁剪：丢掉了最旧的若干条");
        }
        Ok(removed)
    }

    // ── 文件登记 ──────────────────────────────────────────────────────

    /// 登记（或更新）一个上传文件。
    ///
    /// ⚠️ 分片上传时**每个分片都要调它**来更新 `size` —— 否则 `/upload/finish` 报出去的
    /// 大小是 0，而客户端会拿这个 0 去做进度/校验。
    pub fn put_file(&self, file: &File) -> Result<()> {
        let payload = serde_json::to_vec(file)?;
        let txn = self.db.begin_write()?;
        {
            let mut files = txn.open_table(FILES)?;
            files.insert(file.uuid.as_str(), payload.as_slice())?;
        }
        txn.commit()?;
        Ok(())
    }

    pub fn get_file(&self, uuid: &str) -> Result<Option<File>> {
        let txn = self.db.begin_read()?;
        let files = txn.open_table(FILES)?;
        match files.get(uuid)? {
            Some(v) => Ok(Some(serde_json::from_slice(v.value())?)),
            None => Ok(None),
        }
    }

    /// 注销一个文件。返回「它本来在不在」。
    pub fn remove_file(&self, uuid: &str) -> Result<bool> {
        let txn = self.db.begin_write()?;
        let existed = {
            let mut files = txn.open_table(FILES)?;
            files.remove(uuid)?.is_some()
        };
        txn.commit()?;
        Ok(existed)
    }

    /// 全部已登记的文件。
    pub fn list_files(&self) -> Result<Vec<File>> {
        let txn = self.db.begin_read()?;
        let files = txn.open_table(FILES)?;
        let mut out = Vec::new();
        for row in files.iter()? {
            let (_, v) = row?;
            out.push(serde_json::from_slice(v.value())?);
        }
        Ok(out)
    }

    /// 已过期的登记：`expire_time > 0 && expire_time < now`。
    ///
    /// ⚠️ `expire_time == 0` 是**永不过期**，不是「立刻过期」——
    /// 把它算进过期会让所有设了 `fileExpire: 0` 的房间文件被清光。
    pub fn expired_files(&self, now: i64) -> Result<Vec<File>> {
        Ok(self
            .list_files()?
            .into_iter()
            .filter(|f| f.expire_time > 0 && f.expire_time < now)
            .collect())
    }

    /// 按消息表**重算**房间统计。迁移工具和「怀疑计数漂了」时用。
    ///
    /// ⚠️ 之所以需要它：`rooms` 是**派生数据**，一旦哪次写入路径漏了更新，计数就和消息表
    /// 不一致了。与其让 `/rooms` 显示错的数字，不如留一条明确的重算路径。
    pub fn rebuild_room_stats(&self) -> Result<usize> {
        let txn = self.db.begin_write()?;
        let rooms_written = {
            let mut rooms = txn.open_table(ROOMS)?;
            let messages = txn.open_table(MESSAGES)?;

            let mut agg: BTreeMap<String, (u64, i64)> = BTreeMap::new();
            for row in messages.iter()? {
                let (key, _) = row?;
                let (room, ts, _) = key.value();
                let entry = agg.entry(room.to_owned()).or_insert((0, i64::MIN));
                entry.0 += 1;
                entry.1 = entry.1.max(ts_from_desc(ts));
            }

            let stale: Vec<String> = rooms
                .iter()?
                .filter_map(|r| r.ok().map(|(k, _)| k.value().to_owned()))
                .filter(|name| !agg.contains_key(name))
                .collect();
            for name in &stale {
                rooms.remove(name.as_str())?;
            }
            for (name, (count, last)) in &agg {
                rooms.insert(name.as_str(), (*count, *last))?;
            }
            agg.len()
        };
        txn.commit()?;
        Ok(rooms_written)
    }

    // ── 分享记录（share log） ─────────────────────────────────────────

    /// 记一条新分享，顺带把总条数裁到上限。
    ///
    /// ⚠️ 与 Go 的差别：Go 把它写在 `share-log.json` 里（和历史文件同目录），这里进 redb。
    /// 理由是**同一件事只能有一个存储承诺**：历史已经进库了，再让分享记录单独走一个
    /// 「运行中反复全量重写」的 JSON 文件，就多了一类半截 JSON 的失败模式，
    /// 而迁移工具还得为它多写一条路径。
    ///
    /// ⚠️ 裁剪**只丢最旧/已失效的**，并把丢掉的条数返回给调用方去记日志 ——
    /// 统计丢了不报错没关系（它不是审计系统），但不能是「悄悄丢」。
    pub fn put_share(&self, record: &ShareRecord, now: i64) -> Result<usize> {
        let payload = serde_json::to_vec(record)?;
        let txn = self.db.begin_write()?;
        let trimmed = {
            let mut shares = txn.open_table(SHARES)?;
            shares.insert(record.jti.as_str(), payload.as_slice())?;
            trim_shares_table(&mut shares, now)?
        };
        txn.commit()?;
        Ok(trimmed)
    }

    /// 取一条分享记录。
    pub fn get_share(&self, jti: &str) -> Result<Option<ShareRecord>> {
        let txn = self.db.begin_read()?;
        let shares = txn.open_table(SHARES)?;
        match shares.get(jti)? {
            Some(v) => Ok(Some(serde_json::from_slice(v.value())?)),
            None => Ok(None),
        }
    }

    /// 某个房间最近的分享记录（新→旧），以及该房间的记录**总数**。
    ///
    /// ⚠️ 全表扫描 + 排序是**有意的**：这张表最多 [`MAX_SHARE_RECORDS`] 条，
    /// 而维护第二张「按房间+时间」的索引表要多处理一处一致性（写、删、裁三处都得同步）。
    /// 等上限真的涨到需要索引的时候再改 —— 现在改是拿一致性风险换不需要的性能。
    ///
    /// ⚠️ `total` 是**裁剪前**的总数（响应里要报「这个房间一共分享过多少条」），
    /// 所以不能拿 `records.len()` 顶替。
    pub fn shares_for_room(&self, room: &str, limit: usize) -> Result<(Vec<ShareRecord>, u64)> {
        // ⚠️ 两边都要归一化：调用方可能传空串（= default 房间），而记录里存的是 `default`。
        // 只归一化一边的话，空串查询会永远返回空列表 —— 而「没有记录」和「查错了名字」
        // 在响应里长得一模一样。
        let room = normalize_room_name(room);
        let txn = self.db.begin_read()?;
        let shares = txn.open_table(SHARES)?;

        let mut matched = Vec::new();
        for row in shares.iter()? {
            let (_, value) = row?;
            let record: ShareRecord = serde_json::from_slice(value.value())?;
            if normalize_room_name(&record.room) == room {
                matched.push(record);
            }
        }

        // 新→旧。同一秒内的两条按 jti 兜底排序，让顺序**稳定**（否则每次刷新列表顺序都可能变）。
        matched.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.jti.cmp(&b.jti))
        });
        let total = matched.len() as u64;
        matched.truncate(limit);
        Ok((matched, total))
    }

    /// 记一次「有人打开了这条分享」，返回累计的 `(visits, scans)`。
    /// `None` = 没有这条记录（可能已被裁掉）。
    ///
    /// 去重不在这一层：它是**访客维度**的（同一个 IP 十分钟内只算一次），属于服务端的内存态。
    /// 见 `clip9_server` 的 `mark_share_visit`。
    pub fn record_share_open(&self, jti: &str, via_qr: bool) -> Result<Option<(u64, u64)>> {
        let txn = self.db.begin_write()?;
        let result = {
            let mut shares = txn.open_table(SHARES)?;
            let existing = shares.get(jti)?.map(|v| v.value().to_vec());
            match existing {
                None => None,
                Some(bytes) => {
                    let mut record: ShareRecord = serde_json::from_slice(&bytes)?;
                    record.visits += 1;
                    if via_qr {
                        record.scans += 1;
                    }
                    shares.insert(jti, serde_json::to_vec(&record)?.as_slice())?;
                    Some((record.visits, record.scans))
                }
            }
        };
        txn.commit()?;
        Ok(result)
    }

    /// 扣一次使用额度。**读-判断-写在一个写事务里**，否则两个并发请求会同时通过检查、
    /// 各扣一次却都放行（限量变成「最多 maxUses+并发数 次」）。
    pub fn consume_share_use(&self, jti: &str, now: i64) -> Result<ShareUse> {
        let txn = self.db.begin_write()?;
        let outcome = {
            let mut shares = txn.open_table(SHARES)?;
            let existing = shares.get(jti)?.map(|v| v.value().to_vec());
            match existing {
                None => ShareUse::Unknown,
                Some(bytes) => {
                    let mut record: ShareRecord = serde_json::from_slice(&bytes)?;
                    if record.exp > 0 && record.exp <= now {
                        ShareUse::Expired
                    } else if record.max_uses > 0 && record.used >= record.max_uses as u64 {
                        ShareUse::Exhausted {
                            used: record.used,
                            max_uses: record.max_uses as u64,
                        }
                    } else {
                        record.used += 1;
                        shares.insert(jti, serde_json::to_vec(&record)?.as_slice())?;
                        ShareUse::Consumed { used: record.used }
                    }
                }
            }
        };
        txn.commit()?;
        Ok(outcome)
    }

    /// 记录条数（`/share/list` 之外的诊断/测试用）。
    pub fn share_count(&self) -> Result<usize> {
        let txn = self.db.begin_read()?;
        let shares = txn.open_table(SHARES)?;
        Ok(shares.iter()?.count())
    }

    // ── 定时任务 ──────────────────────────────────────────────────────

    /// 写入（新建或整体替换）一条定时任务。key 是 `task.id`。
    ///
    /// ⚠️ `seq <= 0` = 「序号还没定」，这里给它分配一个**单调递增**的序号，
    /// 而序号就是列表顺序（见 [`Self::list_tasks`]）。已经有条目的，沿用它的旧序号 ——
    /// 所以更新**不会**改变位置，和 Go 的「upsert 就地替换、不挪位置」一致。
    ///
    /// 为什么不靠 `createdAt`：它是**秒级**的，同一秒内建的两条分不出先后，
    /// 而 uuid 又是随机的 —— 于是「谁排在前面」这件事**没有任何依据**。
    /// 单调序列是这里唯一能给出确定答案的东西。
    pub fn put_task(&self, task: &AutomationTask) -> Result<()> {
        let mut task = task.clone();
        let txn = self.db.begin_write()?;
        {
            let mut meta = txn.open_table(META)?;
            let mut tasks = txn.open_table(TASKS)?;

            let mut next_seq = meta.get(K_NEXT_TASK_SEQ)?.map_or(1, |g| g.value());
            if task.seq <= 0 {
                // ⚠️ 已有条目要**沿用它的序号** —— 否则「直接 put 一条 `seq = 0` 的更新」
                // 会被当成新建、重新分配一个序号，那条任务就跳到列表末尾去了。
                // 服务端那条路（`upsert_task`）本来就会把序号搬回来，这里是**兜底**：
                // 「更新不该改变位置」这件事不该依赖调用方记得带字段。
                let existing_seq = tasks
                    .get(task.id.as_str())?
                    .and_then(|v| serde_json::from_slice::<AutomationTask>(v.value()).ok())
                    .map_or(0, |t| t.seq);
                task.seq = if existing_seq > 0 {
                    existing_seq
                } else {
                    // ⚠️ 溢出必须**报错**，不能 `unwrap_or(i64::MAX)` —— 那样从某一刻起每条任务
                    // 都会拿到同一个序号，顺序退化成随机。同 `insert` 里对 id 的那条论证。
                    i64::try_from(next_seq).map_err(|_| StoreError::IdExhausted)?
                };
            }
            // 和 `insert` 一样：计数器必须能跳过**已有**的序号，否则更新过的任务
            // 会让后面新建的撞上它。
            next_seq = next_seq.max(task.seq as u64 + 1);
            meta.insert(K_NEXT_TASK_SEQ, next_seq)?;

            let payload = serde_json::to_vec(&task)?;
            tasks.insert(task.id.as_str(), payload.as_slice())?;
        }
        txn.commit()?;
        Ok(())
    }

    /// 取一条定时任务。
    pub fn get_task(&self, id: &str) -> Result<Option<AutomationTask>> {
        let txn = self.db.begin_read()?;
        let tasks = txn.open_table(TASKS)?;
        match tasks.get(id)? {
            Some(v) => Ok(Some(serde_json::from_slice(v.value())?)),
            None => Ok(None),
        }
    }

    /// 删一条定时任务。返回 `true` = 确实删掉了。
    pub fn remove_task(&self, id: &str) -> Result<bool> {
        let txn = self.db.begin_write()?;
        let removed = {
            let mut tasks = txn.open_table(TASKS)?;
            tasks.remove(id)?.is_some()
        };
        txn.commit()?;
        Ok(removed)
    }

    /// 列出**全部**定时任务（跨房间）。
    ///
    /// ⚠️ 不按房间过滤：任务量级很小（每房间最多 20 条），而「按房间过滤」是服务端鉴权的
    /// 职责（管理员能跨房间，普通成员只能看自己房间），不该下沉到存储层。
    /// 全量读出再由调用方过滤，和 Go 的 `snapshotAutomationTasks` 一个意思。
    ///
    /// ⚠️★ **顺序按 `seq`（单调递增的内部序号）升序 —— 不要依赖 redb 的 key 顺序。**
    ///
    /// 这张表的主键是任务的 uuid，所以「按 key 遍历」等于**按随机串排序**：
    /// 用户新建一条任务，它会出现在列表中间某个随机位置，而不是末尾；
    /// 每读一次顺序还可能变。Go 那边是一个切片，天然是插入顺序，于是这成了
    /// 2026-09-25 把 `/tasks` 加进双跑比对时**看得见**的一条偏离。
    ///
    /// ⚠️ 一开始试的是「按 `(createdAt, id)` 排」，**不够** —— `createdAt` 是秒级的，
    /// 同一秒内建的两条仍然只能靠 uuid 兜底，顺序还是随机的（自己的测试当场抓到）。
    /// 根因是「拿随机值当排序兜底键」，所以修法是**换掉兜底键**：用 `seq`。
    /// 这和消息那边（`meta.next_id` + `(room, ts_desc, id_desc)`）是同一套办法。
    ///
    /// 后两个字段只是防御性的兜底（`seq` 理论上不会重复，`0` 也只可能来自手改的库）。
    pub fn list_tasks(&self) -> Result<Vec<AutomationTask>> {
        let txn = self.db.begin_read()?;
        let tasks = txn.open_table(TASKS)?;
        let mut out: Vec<AutomationTask> = Vec::new();
        for row in tasks.iter()? {
            let (_, value) = row?;
            out.push(serde_json::from_slice(value.value())?);
        }
        out.sort_by(|a, b| (a.seq, a.created_at, &a.id).cmp(&(b.seq, b.created_at, &b.id)));
        Ok(out)
    }

    /// 定时任务条数（诊断/测试用）。
    pub fn task_count(&self) -> Result<usize> {
        let txn = self.db.begin_read()?;
        let tasks = txn.open_table(TASKS)?;
        Ok(tasks.iter()?.count())
    }
}

/// 裁剪参数：**保留多少条分享记录**。
///
/// 分享是高频动作，而这份记录只回答「最近分享过什么」，不是审计系统。
/// 裁的时候**先丢已失效的**（过期 / 次数用尽），再丢最旧的 ——
/// 这样一条还在有效期内的限次分享不会因为「别人分享了 500 条」而丢掉自己的用量计数。
const MAX_SHARE_RECORDS: usize = 500;

/// 裁剪一张分享表：超出上限时丢掉优先级最低的那些，返回丢掉的条数。
///
/// 优先级 = (还是不是「可用」的, 创建时间)：不可用的先丢，然后旧的先丢。
/// 「可用」= 没过期，且（不限次 或 还有剩余次数）——判据和 `consume_share_use` 里那两条一致。
///
/// ⚠️★ **先看条数再扫**。这个函数在**写入路径**上（每签发一条分享走一次），而下面那张
/// 「谁该被丢」的名单要把全表读出来、**逐条解析 JSON**。少了这个短路，常态（远未到上限，
/// 也就是绝大多数时候）每签一条链接都要付 500 次解析 —— 正是 `CONTRIBUTING.md` §6
/// 点名的「不要在写入路径上做全表扫」。
///
/// `len()` 读的是 B-tree 根节点里缓存的条数（`ReadOnlyTree::len` = `root.length`），是 O(1)，
/// 不是遍历。同一个写事务里没有别的写者，所以「先量后扫」这两步之间条数不会变。
fn trim_shares_table(shares: &mut Table<'_, &str, &[u8]>, now: i64) -> Result<usize> {
    if shares.len()? as usize <= MAX_SHARE_RECORDS {
        return Ok(0);
    }

    let mut all: Vec<(String, bool, i64)> = Vec::new();
    for row in shares.iter()? {
        let (key, value) = row?;
        let record: ShareRecord = serde_json::from_slice(value.value())?;
        let usable = (record.exp <= 0 || record.exp > now)
            && (record.max_uses <= 0 || (record.used as i64) < record.max_uses);
        all.push((key.value().to_owned(), usable, record.created_at));
    }

    all.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.0.cmp(&b.0))
    });
    let doomed = all.len() - MAX_SHARE_RECORDS;
    for (jti, _, _) in all.iter().take(doomed) {
        shares.remove(jti.as_str())?;
    }
    Ok(doomed)
}

/// 更新某个房间的计数与高水位。
///
/// `delta == 0` 表示只更新 `last_active`（覆盖写同房间时用）。
/// 计数减到 0 时**保留**这一项（房间还在，只是空了）—— 删掉会让 `/rooms` 少一个房间，
/// 而前端正是靠 `/rooms` 决定「有哪些房间可切」。
fn bump_room(
    rooms: &mut Table<'_, &str, (u64, i64)>,
    room: &str,
    delta: i64,
    ts: i64,
) -> Result<()> {
    let (count, last_active) = rooms.get(room)?.map_or((0u64, i64::MIN), |g| g.value());
    let count = if delta >= 0 {
        count.saturating_add(delta as u64)
    } else {
        count.saturating_sub(delta.unsigned_abs())
    };
    // ⚠️ 高水位只增不减：删掉最新一条之后不回落。语义上「最后活跃」就该如此。
    rooms.insert(room, (count, last_active.max(ts)))?;
    Ok(())
}

// ── 回归测试：钉住「为什么不能用二进制格式」 ──────────────────────────

#[cfg(test)]
mod codec_constraint {
    use clip9_protocol::{ReceiveBase, TextReceive};

    fn sample() -> TextReceive {
        TextReceive {
            base: ReceiveBase {
                id: 7,
                kind: "text".to_owned(),
                room: "work".to_owned(),
                timestamp: 1_758_700_000,
                sender_ip: "192.168.1.20".to_owned(),
                sender_device: Some(
                    [("os".to_owned(), "macOS 14".to_owned())]
                        .into_iter()
                        .collect(),
                ),
                column: "doing".to_owned(),
                ..ReceiveBase::default()
            },
            content: "hello\nworld".to_owned(),
            ..TextReceive::default()
        }
    }

    /// ⚠️ 这条**不是**在测功能，是在钉住一个约束：store 的值编码只能用**自描述**格式。
    ///
    /// `TextReceive` 用了 `#[serde(flatten)]`，serde 的 flatten 序列化走
    /// `serialize_map(None)`（长度未知）→ postcard 报 `SerializeSeqLengthUnknown`。
    /// 反序列化那侧还要 `deserialize_any` 缓冲未知字段，非自描述格式同样给不了。
    ///
    /// **哪天这条测试开始失败（postcard 能跑了），说明 serde 的行为变了** ——
    /// 那时可以重新评估要不要换二进制编码来省一半体积。
    #[test]
    fn flattened_types_cannot_use_non_self_describing_formats() {
        let err = postcard::to_allocvec(&sample()).expect_err(
            "如果这里没报错，说明 serde 的 flatten 行为变了，回来重读 store 的模块注释",
        );
        // ⚠️ 匹配**枚举变体**而不是错误文本：`Display` 是 "The length of a sequence must be known"，
        // `Debug` 才是 `SerializeSeqLengthUnknown`。盯文本会在 postcard 改措辞时误报。
        assert!(
            matches!(err, postcard::Error::SerializeSeqLengthUnknown),
            "报错原因变了，值得重新评估: {err:?}"
        );
    }

    /// 而 JSON 是自描述的，往返没问题 —— 这就是我们选它的原因。
    #[test]
    fn json_round_trips_the_same_type() {
        let original = sample();
        let bytes = serde_json::to_vec(&original).unwrap();
        let back: TextReceive = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(original, back);
    }
}
