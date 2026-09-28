//! 设备信息（WS 握手、设备连接/断开事件里出现）。
//!
//! 对应 Go `type.go` 的 `DeviceMeta`。

use serde::{Deserialize, Serialize};

/// 一台连接中的设备。
///
/// ⚠️ Go 那边 `ID` / `Type` / `Device` / `OS` / `Browser` **没有** omitempty
/// → 即使空串也**永远出现**；只有 `name` 有 omitempty。
/// 所以这边不能顺手给它们加 `skip_serializing_if`，那会让「设备名没声明」这类
/// 正常情况下的输出少几个 key，前端就得写防御性代码。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DeviceMeta {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    /// 客户端声明的设备名。空 = 未声明，前端按 `type` 显示通用名称。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub browser: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空 `name` 要**消失**，其余四个即使空也要在 —— 这是 Go 侧 omitempty 的确切分布。
    #[test]
    fn name_is_the_only_omittable_field() {
        let m = DeviceMeta {
            id: "dev-1".into(),
            kind: "Desktop".into(),
            name: String::new(),
            device: "Apple Mac".into(),
            os: "macOS 14".into(),
            browser: "Chrome 120".into(),
        };
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(
            json,
            r#"{"id":"dev-1","type":"Desktop","device":"Apple Mac","os":"macOS 14","browser":"Chrome 120"}"#
        );

        let empty = DeviceMeta::default();
        let json = serde_json::to_string(&empty).unwrap();
        assert_eq!(
            json,
            r#"{"id":"","type":"","device":"","os":"","browser":""}"#
        );
    }
}
