//! 容量策略。
//!
//! ⚠️ **不许再写死 100**（那是 Go 的全局 `server.history`）。三个维度都要能配，
//! 因为它们的瓶颈**不是同一个东西**：
//!
//! | 维度 | 卡住的是什么 |
//! |---|---|
//! | `per_room` | 单个房间的历史回放量（一次推给客户端的东西） |
//! | `total` | 内存/索引规模、启动扫描时间 |
//! | `max_bytes` | **磁盘**。OpenWrt 上真正会先撞到的是这个 |
//!
//! ⚠️ **OpenWrt 的默认值必须按 flash 定，而不是按内存** ——
//! 路由器上常见 16–128MB flash，且 NAND 擦写次数有限（~3000 次）。
//! 所以那边默认只留几百到几千条，数据目录也该指向 `/tmp` 或外挂 U 盘。

/// 容量上限。`None` = 该维度不限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// 每个房间最多保留多少条。
    pub per_room: Option<usize>,
    /// 全库最多多少条。
    pub total: Option<usize>,
    /// 全库「条目字节」总量上限。
    ///
    /// ⚠️ 只算**条目本身**（JSON 值 + 少量索引开销），**不等于文件大小** ——
    /// redb 还有页头、B-tree 节点、以及删除留下的空洞（要 `compact()` 才还回去）。
    /// 所以这个值是**保守的近似**，别拿它当 `du` 用。
    pub max_bytes: Option<u64>,
}

impl Limits {
    /// 桌面 / Docker 的默认值：够一个办公用户存好几年。
    ///
    /// 依据见 ARCHITECTURE §2.2.3：办公用户一年约 3.65 万条、5 年 18 万条，
    /// 单条 JSON 约 200–500 字节。
    #[must_use]
    pub const fn desktop() -> Self {
        Self {
            per_room: Some(10_000),
            total: Some(500_000),
            max_bytes: Some(2 * 1024 * 1024 * 1024), // 2GB
        }
    }

    /// OpenWrt 的默认值：按 flash 定。
    ///
    /// 5000 条 × ~500B ≈ 2.5MB，再加 redb 的页开销，16MB 上限留了余量。
    #[must_use]
    pub const fn openwrt() -> Self {
        Self {
            per_room: Some(500),
            total: Some(5_000),
            max_bytes: Some(16 * 1024 * 1024), // 16MB
        }
    }

    /// 完全不限。**只给测试和「我知道自己在干什么」的场景用** ——
    /// 不限就意味着磁盘写满是迟早的事。
    #[must_use]
    pub const fn unlimited() -> Self {
        Self {
            per_room: None,
            total: None,
            max_bytes: None,
        }
    }

    #[must_use]
    pub const fn with_per_room(mut self, n: usize) -> Self {
        self.per_room = Some(n);
        self
    }

    #[must_use]
    pub const fn with_total(mut self, n: usize) -> Self {
        self.total = Some(n);
        self
    }

    #[must_use]
    pub const fn with_max_bytes(mut self, n: u64) -> Self {
        self.max_bytes = Some(n);
        self
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self::desktop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OpenWrt 的默认值必须**明显更保守** —— 这条测试是防「顺手把两边设成一样」。
    #[test]
    fn openwrt_defaults_are_much_tighter_than_desktop() {
        let d = Limits::desktop();
        let o = Limits::openwrt();

        assert!(o.per_room < d.per_room, "OpenWrt 的每房间上限应该更小");
        assert!(o.total < d.total, "OpenWrt 的全库上限应该更小");
        assert!(o.max_bytes < d.max_bytes, "OpenWrt 的字节上限应该更小");
        // 16MB 的 flash 上，默认值不能比 flash 还大。
        assert!(o.max_bytes.unwrap() <= 64 * 1024 * 1024);
    }
}
