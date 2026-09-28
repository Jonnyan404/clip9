//! 条目类型：`ReceiveBase` / `TextReceive` / `FileReceive` / `ReceiveHolder` / `History`。
//!
//! 对应 Go `type.go` + `utils.go:233-367`。

use std::collections::HashMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::device::DeviceMeta;
use crate::go_omit::{is_false, zero_i32, zero_i64};

/// 条目基类。
///
/// ⚠️ Go 那边是**内嵌**（字段被提升到同一层），所以这边必须用 `#[serde(flatten)]`。
/// 别改成嵌套对象 —— 那会直接改掉线上形状，存量客户端全部读不到字段。
///
/// ⚠️ 每个字段都挂了 `#[serde(default)]`：Go 的 `encoding/json` **不会**因为字段缺失报错
/// （缺了就是零值），Rust 默认会。少了 default 就等于「比 Go 更挑」，老数据读不进来。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReceiveBase {
    /// ⚠️ **没有** omitempty → 永远出现，0 也出现。
    #[serde(default)]
    pub id: i32,

    #[serde(rename = "type", default)]
    pub kind: String,

    #[serde(default)]
    pub room: String,

    /// Unix 秒（**秒级**，不是毫秒）。⚠️ 秒级意味着同秒内会重复 ——
    /// 所以分页游标必须用 `id`，不能用它（见 ARCHITECTURE §6.2）。
    #[serde(default)]
    pub timestamp: i64,

    #[serde(rename = "senderIP", default)]
    pub sender_ip: String,

    /// 发送端持久客户端 ID（用于收发气泡归属）。
    #[serde(
        rename = "senderClientID",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub sender_client_id: String,

    /// 发送者设备信息（来自 User-Agent 解析）。
    ///
    /// ⚠️ Go 那边**没有 omitempty**：nil map 序列化成 `null`（既不是省略，也不是 `{}`）。
    /// 用 `Option` 才能把 nil(`null`) / 空(`{}`) / 有值 三种情况分开 ——
    /// 用 `HashMap` 会把前两种压成同一个 `{}`，那是一次静默的形状漂移。
    #[serde(rename = "senderDevice", default)]
    pub sender_device: Option<HashMap<String, String>>,

    /// 看板的列（`todo` / `doing` / `done`）。空 = 待办。
    ///
    /// 列只是条目上的一个字段，不是另一份数据 —— 所以不另建表。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub column: String,

    /// 标记这条不是人发的 —— 目前只有 `automation`。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,

    /// 定时任务的**预定触发时刻**（Unix 秒）。补发时它与 `timestamp` 相差较大，
    /// 这是判断「这条是错过后补发的」的唯一依据。
    #[serde(rename = "scheduledAt", default, skip_serializing_if = "zero_i64")]
    pub scheduled_at: i64,

    /// 错过触发窗口后补发的消息。
    #[serde(default, skip_serializing_if = "is_false")]
    pub late: bool,
}

/// `type == "text"` 的条目。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TextReceive {
    #[serde(flatten)]
    pub base: ReceiveBase,

    /// ⚠️ 有 omitempty → 空正文会**省略这个 key**。
    /// 所以「正文是空串」和「压根没有正文」在 JSON 上长得一样，别指望能区分。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content: String,

    /// 设备连接事件用。和 `device_id` 一起，只出现在这类特殊消息上。
    #[serde(
        rename = "deviceConnection",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub device_connection: Option<DeviceMeta>,

    /// 设备断开事件用。
    #[serde(rename = "deviceID", default, skip_serializing_if = "String::is_empty")]
    pub device_id: String,
}

/// `type == "file"` 的条目。
///
/// ⚠️ **这个条目没有正文。** 取字节要另发 `GET /file/<cache>/<name>`；
/// 读 `content` 只会得到空串（因为压根没这个字段）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct FileReceive {
    #[serde(flatten)]
    pub base: ReceiveBase,

    #[serde(default)]
    pub name: String,

    #[serde(default)]
    pub size: i64,

    /// 通常就是 UUID。
    #[serde(default)]
    pub cache: String,

    /// 过期时刻（Unix 秒）。0 = 永不过期。
    #[serde(default)]
    pub expire: i64,

    #[serde(default)]
    pub thumbnail: String,

    #[serde(rename = "url", default, skip_serializing_if = "String::is_empty")]
    pub url: String,
}

/// 「要么文本、要么文件」的联合体。
///
/// ⚠️ 判别方式**和 Go 一样看 `type` 字段**，不按形状猜
/// （Go `utils.go:233`）。按形状猜会在「文件条目恰好带了 content」这类输入上给出不同结果 ——
/// 而这种输入是存在的（前端会往文件条目上补字段）。
#[derive(Debug, Clone, PartialEq)]
pub enum ReceiveHolder {
    Text(TextReceive),
    File(FileReceive),
}

impl Serialize for ReceiveHolder {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // Go 的 MarshalJSON 直接委托给内层结构，不套壳 —— 这边照做。
        match self {
            ReceiveHolder::Text(t) => t.serialize(s),
            ReceiveHolder::File(f) => f.serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for ReceiveHolder {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // ⚠️ 这里绕了 `serde_json::Value`，所以 **ReceiveHolder 只能在自描述格式上反序列化**
        // （JSON 行、bincode 不行）。这是刻意的：它是**线上类型**。
        // 存储层要用二进制编码时，走 `clip9-store` 自己的枚举，别把这个塞进 bincode。
        let value = serde_json::Value::deserialize(d)?;
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("text") => serde_json::from_value(value)
                .map(ReceiveHolder::Text)
                .map_err(D::Error::custom),
            Some("file") => serde_json::from_value(value)
                .map(ReceiveHolder::File)
                .map_err(D::Error::custom),
            other => Err(D::Error::custom(format!(
                "unknown message type or invalid structure: {}",
                other.unwrap_or("null")
            ))),
        }
    }
}

impl ReceiveHolder {
    #[must_use]
    pub fn text(content: impl Into<String>) -> Self {
        ReceiveHolder::Text(TextReceive {
            base: ReceiveBase {
                kind: "text".to_owned(),
                ..ReceiveBase::default()
            },
            content: content.into(),
            ..TextReceive::default()
        })
    }

    /// 取基类。文本/文件两条支路都能拿到，所以调用点不用 match。
    ///
    /// ⚠️ 看板挪列、改正文、鉴权都要走这里 —— Go 那边就栽过一次
    /// 「只处理了文本那一支，于是文件卡片拖了没反应」。
    pub fn base(&self) -> &ReceiveBase {
        match self {
            ReceiveHolder::Text(t) => &t.base,
            ReceiveHolder::File(f) => &f.base,
        }
    }

    pub fn base_mut(&mut self) -> &mut ReceiveBase {
        match self {
            ReceiveHolder::Text(t) => &mut t.base,
            ReceiveHolder::File(f) => &mut f.base,
        }
    }

    #[must_use]
    pub fn id(&self) -> i32 {
        self.base().id
    }

    pub fn set_id(&mut self, id: i32) {
        self.base_mut().id = id;
    }

    #[must_use]
    pub fn kind(&self) -> &str {
        &self.base().kind
    }

    #[must_use]
    pub fn room(&self) -> &str {
        &self.base().room
    }

    #[must_use]
    pub fn timestamp(&self) -> i64 {
        self.base().timestamp
    }

    #[must_use]
    pub fn sender_ip(&self) -> &str {
        &self.base().sender_ip
    }

    #[must_use]
    pub fn sender_device(&self) -> Option<&HashMap<String, String>> {
        self.base().sender_device.as_ref()
    }

    #[must_use]
    pub fn column(&self) -> &str {
        &self.base().column
    }

    /// ⚠️ 两条支路都要写。只写文本那支会让文件卡片「拖了没反应」。
    pub fn set_column(&mut self, column: impl Into<String>) {
        self.base_mut().column = column.into();
    }

    #[must_use]
    pub fn is_file(&self) -> bool {
        matches!(self, ReceiveHolder::File(_))
    }
}

/// `history.json` 的整体形状。
///
/// ⚠️ 这个类型是**迁移期的读模型**：Go 侧那份文件就是长这样。
/// 新存储（redb）不按这个形状存 —— 它只是「把老数据读进来」的入口。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    /// ⚠️ Go 里 nil 切片会序列化成 `null`，所以读的时候要容忍 null（见 `de_null_or_default`）。
    /// 写出去一律是数组 —— 这是刻意的单向宽松。
    #[serde(default, deserialize_with = "crate::de_null_or_default")]
    pub file: Vec<File>,

    #[serde(default, deserialize_with = "crate::de_null_or_default")]
    pub receive: Vec<ReceiveHolder>,

    /// 消息队列的下一个 ID。0 时省略。
    #[serde(rename = "nextId", default, skip_serializing_if = "zero_i32")]
    pub next_id: i32,
}

/// `uploads/` 里一个文件的登记信息。
///
/// ⚠️ `uuid` 和 `FileReceive.cache` 是**同一个值**，迁移时必须按它俩对上。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct File {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub size: i64,
    #[serde(rename = "uploadTime", default)]
    pub upload_time: i64,
    #[serde(rename = "expireTime", default)]
    pub expire_time: i64,
    /// 空 = `default` 房间。⚠️ 按**文件自己记录的房间**鉴权，不信客户端传的 `?room=`。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub room: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_text(id: i32, room: &str, ts: i64) -> TextReceive {
        TextReceive {
            base: ReceiveBase {
                id,
                kind: "text".to_owned(),
                room: room.to_owned(),
                timestamp: ts,
                sender_ip: "192.168.1.2".to_owned(),
                ..ReceiveBase::default()
            },
            content: "hello".to_owned(),
            ..TextReceive::default()
        }
    }

    /// 扁平化：`ReceiveBase` 的字段必须和内层字段在**同一层**，不能出现 `base` 这个 key。
    #[test]
    fn base_fields_are_flattened() {
        let json = serde_json::to_string(&base_text(7, "work", 1000)).unwrap();
        assert_eq!(
            json,
            r#"{"id":7,"type":"text","room":"work","timestamp":1000,"senderIP":"192.168.1.2","senderDevice":null,"content":"hello"}"#
        );
        assert!(!json.contains("\"base\""));
    }

    /// `senderDevice` 是 `null` 而不是被省略、也不是 `{}` —— 三种情况必须分得开。
    #[test]
    fn sender_device_distinguishes_null_from_empty_object() {
        let mut t = base_text(1, "default", 0);
        t.base.sender_device = Some(HashMap::new());
        assert!(
            serde_json::to_string(&t)
                .unwrap()
                .contains(r#""senderDevice":{}"#)
        );

        t.base.sender_device = None;
        assert!(
            serde_json::to_string(&t)
                .unwrap()
                .contains(r#""senderDevice":null"#)
        );
    }

    /// `type` 字段决定反序列化成哪一支 —— 和 Go 一致。
    #[test]
    fn holder_dispatches_on_type_field() {
        let text = serde_json::json!({"type": "text", "id": 1, "content": "x"});
        assert!(matches!(
            serde_json::from_value::<ReceiveHolder>(text).unwrap(),
            ReceiveHolder::Text(_)
        ));

        let file = serde_json::json!({"type": "file", "id": 2, "name": "a.png", "cache": "u-1"});
        assert!(matches!(
            serde_json::from_value::<ReceiveHolder>(file).unwrap(),
            ReceiveHolder::File(_)
        ));

        // ⚠️ 认不出的 type 要**报错**，不能悄悄当成文本 —— 静默降级会让文件条目变成空文本条目。
        let bogus = serde_json::json!({"type": "weird", "id": 3});
        assert!(serde_json::from_value::<ReceiveHolder>(bogus).is_err());

        let missing = serde_json::json!({"id": 4});
        assert!(serde_json::from_value::<ReceiveHolder>(missing).is_err());
    }

    /// 读回来再写出去要一模一样（omitempty 那几条谓词最容易在这儿露馅）。
    #[test]
    fn round_trip_is_stable() {
        let original = base_text(7, "work", 1000);
        let json = serde_json::to_string(&original).unwrap();
        let back: TextReceive = serde_json::from_str(&json).unwrap();
        assert_eq!(original, back);
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }

    /// `History` 要能吃下 Go 写出来的 `null` 切片。
    #[test]
    fn history_tolerates_null_slices() {
        let h: History = serde_json::from_str(r#"{"file":null,"receive":null}"#).unwrap();
        assert!(h.file.is_empty());
        assert!(h.receive.is_empty());
        assert_eq!(h.next_id, 0);
        // 写出去是数组，不是 null —— 单向宽松。
        assert_eq!(
            serde_json::to_string(&h).unwrap(),
            r#"{"file":[],"receive":[]}"#
        );
    }

    /// `column` 两个分支都要能写 —— 文件卡片也得能挪列。
    #[test]
    fn set_column_touches_both_branches() {
        let mut text = ReceiveHolder::Text(base_text(1, "default", 0));
        text.set_column("doing");
        assert_eq!(text.column(), "doing");

        let mut file = ReceiveHolder::File(FileReceive {
            base: ReceiveBase {
                kind: "file".to_owned(),
                ..ReceiveBase::default()
            },
            name: "a.png".to_owned(),
            ..FileReceive::default()
        });
        file.set_column("done");
        assert_eq!(file.column(), "done");
    }
}
