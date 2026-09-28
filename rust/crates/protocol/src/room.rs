//! 房间相关的对外形状。

use serde::{Deserialize, Serialize};

/// 房间名归一化。
///
/// 规则（对应 Go `main.go:1109`）：去首尾空白；**空串和 `default` 都归到 `default`**；
/// 其余原样返回。
///
/// ⚠️ 这不是「工具函数」，是**契约的一部分**：
/// `?room=` 空值 = `default` 房间，而**完全不传 room** 才是「不限房间」。
/// 所以它住在 protocol 而不是 core —— 谁都需要同一份语义，多一份实现就会漂。
#[must_use]
pub fn normalize_room_name(room: &str) -> String {
    let room = room.trim();
    if room.is_empty() || room == "default" {
        "default".to_owned()
    } else {
        room.to_owned()
    }
}

/// `/rooms` 列表里的一项。
///
/// ⚠️ `isProtected` 的含义是「**实际要不要密码**」，不是「`roomAuth` 里有没有这一项」。
/// `{"open": true}` 有配置项但不要密码；没配过 + 有全局密码要密码却没有配置项。
/// 算它的唯一出口是 `clip9_core::resolve_room_auth(...).required`。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RoomInfo {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "messageCount", default)]
    pub message_count: i64,
    #[serde(rename = "deviceCount", default)]
    pub device_count: i64,
    #[serde(rename = "lastActive", default)]
    pub last_active: i64,
    #[serde(rename = "isActive", default)]
    pub is_active: bool,
    #[serde(rename = "isProtected", default)]
    pub is_protected: bool,
}

/// `GET /rooms` 的响应体。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RoomListResponse {
    #[serde(default)]
    pub rooms: Vec<RoomInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_trims_and_folds_default() {
        assert_eq!(normalize_room_name(""), "default");
        assert_eq!(normalize_room_name("default"), "default");
        assert_eq!(normalize_room_name("  default  "), "default");
        assert_eq!(normalize_room_name("  "), "default");
        assert_eq!(normalize_room_name(" work "), "work");
        // ⚠️ 大小写**不**归一 —— 别顺手加 to_lowercase，那会把两个房间合并成一个。
        assert_eq!(normalize_room_name("Work"), "Work");
    }

    #[test]
    fn room_info_always_carries_all_keys() {
        let json = serde_json::to_string(&RoomInfo::default()).unwrap();
        assert_eq!(
            json,
            r#"{"name":"","messageCount":0,"deviceCount":0,"lastActive":0,"isActive":false,"isProtected":false}"#
        );
    }
}
