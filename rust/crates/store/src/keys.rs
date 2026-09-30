//! key 编码。
//!
//! 设计目标：把「按房间取最近 N 条」变成**一次正向范围扫描**，
//! 而不是「全表扫 + 排序」。见 `dev-docs/ARCHITECTURE.md` §3.2。
//!
//! # 主键形状
//!
//! ```text
//! messages:  (room, ts_desc, id_desc)  ->  JSON 字节
//! ```
//!
//! `ts_desc` 是时间戳的**倒序**编码 —— 于是「最近 N 条」= 从房间范围的开头往后取 N 个，
//! B-tree 天然合适。`id_desc` 让同一秒内的顺序也和 Go 的
//! `ORDER BY timestamp DESC, id DESC` 一致（时间戳是**秒级**，同秒很常见）。

/// 时间戳 → 倒序可比较的 u64。
///
/// 两步：先把 `i64` **保序**映射到 `u64`（翻转符号位），再取反。
/// ⚠️ 直接 `u64::MAX - ts as u64` 是错的：负数会被当成极大的正数排到最前。
/// 这个项目里时间戳现实中都是正的，但「现实中不会」不该是编码的前提。
#[must_use]
pub const fn ts_desc(ts: i64) -> u64 {
    u64::MAX - ((ts as u64) ^ (1u64 << 63))
}

/// `ts_desc` 的逆。
#[must_use]
pub const fn ts_from_desc(desc: u64) -> i64 {
    ((u64::MAX - desc) ^ (1u64 << 63)) as i64
}

/// 条目 id → 倒序可比较的 u32。
///
/// ⚠️ id 是**正数**（从 1 开始递增）。取反而不是 `i32::MAX - id`，
/// 是为了让「未知/占位」的 0 排到最后而不是最前。
#[must_use]
pub const fn id_desc(id: i32) -> u32 {
    u32::MAX - id as u32
}

/// `id_desc` 的逆。
#[must_use]
pub const fn id_from_desc(desc: u32) -> i32 {
    (u32::MAX - desc) as i32
}

/// 某个房间的全部 key 范围（含两端）。
///
/// ⚠️ redb 的 `range` **不支持「前缀 + 通配」** —— `(room, ..)` 这种写法不合法，
/// 两端必须写满。所以用极值把中间两段兜住：`ts_desc` 和 `id_desc` 都落在 `[0, MAX]` 内。
#[must_use]
pub const fn room_bounds(room: &str) -> ((&str, u64, u32), (&str, u64, u32)) {
    ((room, 0, 0), (room, u64::MAX, u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 倒序编码的核心性质：**时间戳越大，编码值越小**。
    #[test]
    fn ts_desc_is_reversed_and_order_preserving() {
        let mut stamps = [0i64, 1, 2, 1_758_700_000, i64::MAX, -1, -1_000];
        stamps.sort_unstable();

        let mut encoded: Vec<u64> = stamps.iter().copied().map(ts_desc).collect();
        // 编码后应该是**严格递减**的。
        for pair in encoded.windows(2) {
            assert!(pair[0] > pair[1], "编码不是倒序: {pair:?}");
        }
        encoded.sort_unstable_by(|a, b| b.cmp(a));
        let decoded: Vec<i64> = encoded.iter().copied().map(ts_from_desc).collect();
        assert_eq!(decoded, stamps, "解码没还原回去");
    }

    #[test]
    fn ts_desc_round_trips_extremes() {
        for ts in [i64::MIN, -1, 0, 1, i64::MAX] {
            assert_eq!(ts_from_desc(ts_desc(ts)), ts, "ts={ts}");
        }
    }

    /// ⚠️ 这条是防「顺手用 `u64::MAX - ts as u64`」那个写法：负数会被排到最前。
    #[test]
    fn negative_timestamps_sort_oldest_not_newest() {
        assert!(
            ts_desc(-1) > ts_desc(0),
            "负数时间戳应该更「旧」（编码更大）"
        );
    }

    #[test]
    fn id_desc_is_reversed_and_round_trips() {
        assert!(id_desc(1) > id_desc(2), "id 越大编码越小");
        assert!(id_desc(0) > id_desc(1), "id=0 应该排到最后");
        for id in [0, 1, 7, i32::MAX] {
            assert_eq!(id_from_desc(id_desc(id)), id, "id={id}");
        }
    }

    /// 房间范围必须能兜住该房间的所有 key，且不越到隔壁房间。
    #[test]
    fn room_bounds_cover_the_whole_room_only() {
        let (low, high) = room_bounds("work");
        let key = |room: &'static str, ts: i64, id: i32| (room, ts_desc(ts), id_desc(id));

        assert!(key("work", i64::MIN, 1) >= low);
        assert!(key("work", i64::MAX, i32::MAX) <= high);
        // ⚠️ 字典序：「work」和「works」相邻，范围不能把「works」圈进来。
        assert!(key("works", 0, 1) > high);
        assert!(key("wor", 0, 1) < low);
    }
}
