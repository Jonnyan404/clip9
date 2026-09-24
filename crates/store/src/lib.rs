//! clip9 存储层。
//!
//! **只有这个 crate 知道存储长什么样。** 换引擎（redb → fjall）时，
//! 改动应该被挡在这条边界里，`core` 与 `server` 一行都不用动。
//!
//! 现状：**还没实现**。设计已定，见 clip-sync/ARCHITECTURE.md §3：
//!
//! - 表 `messages`：`key = (room_id, ts_desc_be, msg_id)` → 值 = 序列化后的条目。
//!   ts 倒序编码，让「按房间取最近 N 条」变成一次**正向范围扫描**。
//! - 表 `by_id`：`msg_id -> (room_id, ts)`，给 `/content/<id>`、`/revoke/<id>`、看板挪列单条取用。
//! - 表 `meta`：`schema_version` / `next_id`。
//!
//! ⚠️ 容量策略**不许再写死 100**：`perRoom` / `total` / `maxBytes` 三个维度都要能配，
//! 且裁剪要拆成「写入时按房间局部裁剪（快）」+「低频全库整理（慢，后台）」。
//! ⚠️ OpenWrt 的 flash 很小（常见 16–128MB），那边默认配置必须保守，
//! 且**超限行为要明确**（丢最旧的 vs 拒绝写入），不能静默丢数据。
