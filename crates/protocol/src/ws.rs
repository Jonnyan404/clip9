//! WebSocket 信封。

use serde::{Deserialize, Serialize};

use crate::receive::ReceiveHolder;

/// WS 消息信封。
///
/// `data` 的形状随 `event` 变，所以做成泛型 —— Go 那边是 `interface{}`，
/// 这里用类型参数把「哪个事件配哪种载荷」写进类型里，调用点就不用再 `unwrap` 一次。
/// 需要动态形状的地方（比如测试、转发）用 `WsMessage<serde_json::Value>`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WsMessage<T> {
    pub event: String,
    pub data: T,
}

impl WsMessage<serde_json::Value> {
    /// 从事件名和一个可序列化的载荷造一条。载荷序列化失败在这里就炸，
    /// 而不是等到写进 socket 才发现 —— 那时候连接已经半死不活了。
    pub fn json<T: Serialize>(event: impl Into<String>, data: &T) -> serde_json::Result<Self> {
        Ok(Self {
            event: event.into(),
            data: serde_json::to_value(data)?,
        })
    }
}

/// 历史列表里的一个元素。
///
/// ⚠️ 它和 `WsMessage` 是**两个不同的东西**，别合并：
/// `PostEvent` 是「存起来的历史条目」（`event` 恒为 `"receive"`），
/// `WsMessage` 是「实时推给客户端的信封」。
/// 历史回放会把 `PostEvent` 逐条包成 `WsMessage` 发出去，形状才对得上。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PostEvent {
    #[serde(default)]
    pub event: String,
    pub data: ReceiveHolder,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::DeviceMeta;

    #[test]
    fn envelope_wraps_arbitrary_payload() {
        let msg = WsMessage::json("connect", &DeviceMeta::default()).unwrap();
        assert_eq!(msg.event, "connect");
        assert!(msg.data.get("device").is_some());
    }
}
