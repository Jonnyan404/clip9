//! clip9 契约层。
//!
//! # 这个 crate 存在的理由
//!
//! 这套接口原来有**三份实现**（Go / Cloudflare Worker / 即将的 Rust），
//! 唯一的保证是文档加契约测试。变成纯类型之后，形状由类型系统保证。
//!
//! # 铁律
//!
//! **字段名与 Go 的 json tag 逐字一致**（`senderIP` / `senderClientID` / `boardColumn`…）。
//! 不是「差不多」，是逐字 —— 存量客户端、Apple/Android 捷径、Worker、已发布的 PWA
//! 都按那份契约说话，改一个字母就是一次线上事故。
//!
//! 验证方式不是「读代码觉得对」，而是 `cases/protocol/*.json`：
//! **从 Go 侧导出的 JSON fixture → 这边反序列化再序列化 → 断言字节一致**。
//! 见 `tests/go_fixtures.rs`。
//!
//! # 零 IO
//!
//! 这个 crate **不许**依赖任何运行时、网络、文件系统。它只是类型。
//! 一旦它开始做 IO，`wasm32` 那边就编不过了，而那正是前端要用它的原因。

pub mod device;
pub mod receive;
pub mod room;
pub mod ws;

use serde::Deserialize;

pub use device::DeviceMeta;
pub use receive::{File, FileReceive, History, ReceiveBase, ReceiveHolder, TextReceive};
pub use room::{normalize_room_name, RoomInfo, RoomListResponse};
pub use ws::{PostEvent, WsMessage};

/// Go `encoding/json` 的 `omitempty` 语义。
///
/// ⚠️ 这些谓词必须和 Go **逐条**对上。`omitempty` 不是「空就省」这么笼统：
/// 它对 int 看「是不是 0」、对 bool 看「是不是 false」、对 string 看「是不是空串」、
/// 对切片/映射看「长度是不是 0」。写错一条，同一份数据两边序列化出的字节就不同。
pub(crate) mod go_omit {
    /// `omitempty` 对 int：值为 0 就省略。
    pub fn zero_i32(v: &i32) -> bool {
        *v == 0
    }

    /// `omitempty` 对 int64：值为 0 就省略。
    pub fn zero_i64(v: &i64) -> bool {
        *v == 0
    }

    /// `omitempty` 对 bool：false 就省略。
    pub fn is_false(v: &bool) -> bool {
        !*v
    }
}

/// 把 JSON 的 `null` 也当成「缺省值」读。
///
/// ⚠️ 为什么需要它：Go 里 `[]T` 字段**没有** omitempty 时，nil 切片序列化成 `null`
/// 而不是 `[]`。严格按 `Vec<T>` 反序列化会在 `null` 上报错 —— 于是老数据读不进来。
///
/// 这是**读得宽松**，不是「写得一样」：写出去一律是数组。
/// Go 侧两种都能读，所以这个不对称是安全的；反过来（写出 `null`）才会让别的客户端难受。
pub(crate) fn de_null_or_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}
