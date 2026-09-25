//! 配置模型。
//!
//! 对应 Go `config.go` 的 `Config`。字段名与 JSON key 逐字对齐。
//!
//! ⚠️ 服务端的配置文件**必须嵌套在 `server` 键下** —— 平铺会被静默忽略并回落到默认端口。
//! 这是踩过的坑，所以这里用嵌套结构体表达，而不是一堆平铺字段。

use serde::{Deserialize, Serialize};

/// `auth` 支持 `false` / 字符串 / 数字 三种写法（Go 里是 `interface{}`）。
///
/// ⚠️ 别把它简化成 `Option<String>`：`false` 是**默认值**，而 `""` 是「配了空密码」。
/// 两者在配置里含义相同（都回落），但直接丢进 `Option<String>` 会把 `false` 变成解析错误 ——
/// 于是所有存量 `config.json` 都读不进来。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AuthValue {
    Bool(bool),
    Str(String),
    Num(serde_json::Number),
}

impl Default for AuthValue {
    fn default() -> Self {
        AuthValue::Bool(false)
    }
}

impl AuthValue {
    /// 归一成密码字符串。对应 Go `normalizeAuthValue`：
    /// 字符串原样；数字 **0 视为空**（和 `false` 一个意思）；其余空。
    #[must_use]
    pub fn normalize(&self) -> String {
        match self {
            AuthValue::Bool(_) => String::new(),
            AuthValue::Str(s) => s.clone(),
            AuthValue::Num(n) => {
                if n.as_i64() == Some(0) || n.as_f64() == Some(0.0) {
                    String::new()
                } else {
                    n.to_string()
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub text: TextConfig,
    pub file: FileConfig,
    pub automation: AutomationConfig,
}

/// 定时自动化的运行时配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationConfig {
    /// 总开关。关掉时 `/tasks` 回 404、能力声明固定 `{"enabled": false}`。
    ///
    /// ⚠️★ **默认 `true`**，与 Go 的 `defaultConfig()` 一致。这不是随手定的：
    /// 「默认可用」**不等于**「默认放开」—— 能不能给**某个房间**装任务由
    /// `roomAuth[x].automation` 决定，公开房间默认是 `none`
    /// （见 `auth::resolve_automation_policy`）。所以默认开着**不会让任何房间凭空多出
    /// 自动化能力**，只是让「已经配好的房间」在升级后仍然能用。
    ///
    /// ⚠️ 这条曾经写成 `false`（手写 `Default` 时没对 Go，也没有任何论证），
    /// 后果是**同一份 `config.json` 在 Go 上开着、在 Rust 上关着** —— 从 Go 切过来的
    /// 用户会静默丢掉这个功能。2026-09-25 由双跑比对发现，同日翻正。
    pub enabled: bool,
    #[serde(rename = "tickSeconds")]
    pub tick_seconds: i64,
    #[serde(rename = "graceSeconds")]
    pub grace_seconds: i64,
    #[serde(rename = "defaultTZ")]
    pub default_tz: String,
}

impl Default for AutomationConfig {
    fn default() -> Self {
        Self {
            // ⚠️ 见字段注释：与 Go 的 `defaultConfig()` 一致。
            enabled: true,
            tick_seconds: 30,
            grace_seconds: 600,
            default_tz: "Asia/Shanghai".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// 监听地址。Go 侧允许 `"0.0.0.0"` 或 `["0.0.0.0","::"]` 两种写法。
    pub host: serde_json::Value,
    pub port: u16,
    /// 子路径前缀（部署在反代子目录时用）。**每个端点都带它**。
    pub prefix: String,
    /// ⚠️ 旧的「每房间保留多少条」。新存储改用 `limits` 三个维度（见 ARCHITECTURE §3.3），
    /// 这个字段只为**读老配置**保留 —— 别在业务代码里用它做裁剪决策。
    pub history: i64,
    /// **库文件的路径**（redb）。默认 `./data/clip9.redb`。
    ///
    /// ⚠️★ 这里**刻意不叫 `historyFile`**（Jonny 2026-09-25 定）。Go 那边那个名字的含义是
    /// 「历史记录 **JSON** 文件的路径」，而这边历史存在 redb 里 —— 沿用旧名会让
    /// 「名字说的」和「实际做的」不一致，而**那个不一致本身**正是这个项目最忌讳的一类问题。
    /// 所以字段名、`serde` 名、命令行参数名**一起改**，不留旧名当别名：
    /// 旧名在这边的语义是**错的**，静默接受它比报错更坏。
    ///
    /// ⚠️ 默认值给的是一个**看得见的路径**（生成的配置文件里能读到它落在哪），
    /// 但服务端按「**等于默认值就当没写**」处理 —— 与 `storageDir` 同一套办法，
    /// 这样 `-data` 仍然能把库整体搬走（否则配置文件里一旦写死，`-data` 就失效了）。
    /// ⚠️ 副作用与 `storageDir` 相同：显式把它写成 `./data/clip9.redb` 会被当成没写。
    /// 想钉死就写别的值（或绝对路径）。
    ///
    /// ⚠️ 老配置里那个 `historyFile` 会被 serde 当成未知字段忽略掉 —— 这正是想要的：
    /// Go 版的 `history.json` 是**迁移工具的输入**，不该被这边覆盖。
    #[serde(rename = "dbPath")]
    pub db_path: String,
    #[serde(rename = "storageDir")]
    pub storage_dir: String,
    pub auth: AuthValue,
    #[serde(rename = "roomAuth")]
    pub room_auth: RoomAuthConfig,
    pub cert: String,
    pub key: String,
    #[serde(rename = "roomList")]
    pub room_list: bool,
    /// 房间清理间隔（秒）。**照 Go 的语义实现**（Jonny 2026-09-25 定）：
    /// 每隔这么久清一次「空房间」的行（计数为 0、没有连接、且空闲超过这个值）。
    ///
    /// ⚠️ Rust 侧的「空房间」不是 Go 那个内存 `roomStats`，而是存储里那张 `rooms`
    /// 计数表 —— 它在计数归零之后**仍然留着行**，所以需要有人来收。
    /// 实现见 `server/src/room_cleanup.rs`（判定逐条照 Go 的 `cleanupEmptyRooms`）。
    /// ⚠️ `<= 0` 表示**不清理**，且只在 `roomList` 开启时才跑 —— 两条都是 Go 的规矩。
    #[serde(rename = "roomCleanup")]
    pub room_cleanup: i64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: serde_json::json!(["0.0.0.0"]),
            port: 9501,
            prefix: String::new(),
            history: 100,
            db_path: "./data/clip9.redb".to_owned(),
            storage_dir: "./uploads".to_owned(),
            auth: AuthValue::default(),
            room_auth: RoomAuthConfig::default(),
            cert: String::new(),
            key: String::new(),
            room_list: false,
            room_cleanup: 3600,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TextConfig {
    /// 单条正文上限。默认 4096 —— ⚠️ 内容变换类功能因此一律放在前端做（走网络纯亏）。
    pub limit: i64,
}

impl Default for TextConfig {
    fn default() -> Self {
        Self { limit: 4096 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FileConfig {
    pub expire: i64,
    pub chunk: i64,
    pub limit: i64,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            expire: 3600,
            chunk: 1024 * 1024,
            limit: 256 * 1024 * 1024,
        }
    }
}

/// `roomAuth`：房间名 → 该房间的认证与留存配置。
///
/// ⚠️ 键在**加载时**就归一化（`normalize_room_name`），否则 `"default"` 和 `""`
/// 会变成两个不同的房间，而它们在契约里是同一个。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RoomAuthConfig(pub std::collections::BTreeMap<String, RoomAuthEntry>);

impl RoomAuthConfig {
    #[must_use]
    pub fn get(&self, room: &str) -> Option<&RoomAuthEntry> {
        self.0.get(room)
    }

    /// 归一化房间名之后重建一份。加载配置时调用一次即可。
    #[must_use]
    pub fn normalized(&self) -> Self {
        Self(
            self.0
                .iter()
                .map(|(room, entry)| (clip9_protocol::normalize_room_name(room), entry.clone()))
                .collect(),
        )
    }
}

/// 单个房间的认证与文件留存配置。
///
/// 配置值支持**四种** JSON 形式（对应 Go `RoomAuthEntry.UnmarshalJSON`）：
///
/// ```json
/// "password"                                   // 仅密码（旧格式）
/// 12345                                        // 数字密码
/// {"password": "x", "fileExpire": 0}            // 密码 + 文件过期覆盖
/// {"open": true, "fileExpire": 0}               // 开放房间：不要密码，即使全局 auth 设了也一样
/// ```
///
/// ⚠️ `open` 单独一个字段、而不是拿「空密码」当信号，有两个原因：
/// 1. 空字符串在这份配置里**已经有含义**（只接受全局 auth）—— 改掉它会静默改变所有现有配置的
///    含义，某个房间会悄悄敞开且不报错。安全设置不能这么反转。
/// 2. 空密码和「压根没配过这个房间」在 JSON 里长得一样，而这两者的意图正好相反。
///
/// ⚠️ **不能 `#[derive(Deserialize)]`** —— 配置值有四种形态，derive 出来的解析器只认
/// 其中一种（对象），于是 `"work": "password"` 这种**最常见的写法**会让整个配置解析失败、
/// **服务端起不来**。手写 `Deserialize` 走 [`RoomAuthEntry::from_json`]。
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct RoomAuthEntry {
    pub password: String,
    #[serde(rename = "fileExpire")]
    pub file_expire: Option<i64>,
    pub open: bool,
    /// 定时任务策略：`""`（未写 → 跟随房间鉴权档位）/ `"none"` / `"single"` / `"room"`。
    pub automation: String,
}

impl<'de> Deserialize<'de> for RoomAuthEntry {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // ⚠️ 先落到 `Value` 再转 —— 四种配置形态的判定逻辑只有一处（`from_json`），
        // 这里不重复实现一遍。derive 出来的解析器只认对象那一种，会让最常见的
        // `"work": "password"` 直接把整个配置解析弄失败、服务端起不来。
        let value = serde_json::Value::deserialize(d)?;
        RoomAuthEntry::from_json(&value).map_err(serde::de::Error::custom)
    }
}

impl RoomAuthEntry {
    /// 从配置值解析。`from_json` 覆盖 Go 那三种兼容形式。
    pub fn from_json(v: &serde_json::Value) -> Result<Self, String> {
        match v {
            serde_json::Value::String(s) => Ok(Self {
                password: s.trim().to_owned(),
                ..Self::default()
            }),
            serde_json::Value::Number(n) => Ok(Self {
                password: normalize_auth_json(n),
                ..Self::default()
            }),
            serde_json::Value::Object(_) => {
                #[derive(Deserialize)]
                #[serde(default)]
                struct Raw {
                    password: serde_json::Value,
                    #[serde(rename = "fileExpire")]
                    file_expire: Option<i64>,
                    open: bool,
                    automation: String,
                }
                impl Default for Raw {
                    fn default() -> Self {
                        Self {
                            password: serde_json::Value::Null,
                            file_expire: None,
                            open: false,
                            automation: String::new(),
                        }
                    }
                }
                let raw: Raw = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
                Ok(Self {
                    password: if raw.password.is_null() {
                        String::new()
                    } else {
                        normalize_auth_json_value(&raw.password)
                    },
                    file_expire: raw.file_expire,
                    open: raw.open,
                    automation: raw.automation.trim().to_owned(),
                })
            }
            other => Err(format!("unsupported roomAuth value: {other}")),
        }
    }
}

fn normalize_auth_json(n: &serde_json::Number) -> String {
    if n.as_i64() == Some(0) || n.as_f64() == Some(0.0) {
        String::new()
    } else {
        n.to_string()
    }
}

fn normalize_auth_json_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => normalize_auth_json(n),
        serde_json::Value::Bool(_) | serde_json::Value::Null => String::new(),
        // ⚠️ Go 那边 `normalizeAuthValue(对象)` 会掉进 default 分支返回 `""`。
        // Worker 曾在这里把对象 `String()` 成 `'[object Object]'`，那是个 bug —— 别学。
        other => {
            debug_assert!(false, "roomAuth.password 不该是 {other}");
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_value_normalizes_like_go() {
        assert_eq!(AuthValue::Bool(false).normalize(), "");
        assert_eq!(AuthValue::Bool(true).normalize(), "");
        assert_eq!(AuthValue::Str("secret".into()).normalize(), "secret");
        assert_eq!(AuthValue::Num(serde_json::Number::from(0)).normalize(), "");
        assert_eq!(
            AuthValue::Num(serde_json::Number::from(1234)).normalize(),
            "1234"
        );
    }

    #[test]
    fn room_auth_entry_accepts_four_forms() {
        let s = RoomAuthEntry::from_json(&serde_json::json!("pw")).unwrap();
        assert_eq!(s.password, "pw");
        assert!(!s.open);

        let n = RoomAuthEntry::from_json(&serde_json::json!(12345)).unwrap();
        assert_eq!(n.password, "12345");

        let zero = RoomAuthEntry::from_json(&serde_json::json!(0)).unwrap();
        assert_eq!(zero.password, "");

        let o = RoomAuthEntry::from_json(&serde_json::json!({"password": "x", "fileExpire": 0}))
            .unwrap();
        assert_eq!(o.password, "x");
        assert_eq!(o.file_expire, Some(0));

        let open = RoomAuthEntry::from_json(&serde_json::json!({"open": true})).unwrap();
        assert!(open.open);
        assert_eq!(open.password, "");
    }

    /// 平铺的配置（没有 `server` 键）不该被当成合法配置 —— 它会被静默忽略并回落默认值，
    /// 这里至少保证「解析出来的是默认端口」这个事实是显式的。
    #[test]
    fn flat_config_falls_back_to_defaults() {
        let c: Config = serde_json::from_str(r#"{"port": 8080}"#).unwrap();
        assert_eq!(
            c.server.port, 9501,
            "平铺的 port 被忽略 —— 这是刻意的，但要知道"
        );
    }

    /// ⚠️★ 这条防的是「derive 出来的 `Deserialize` 只认对象」那个 bug。
    ///
    /// 真实的 `config.json` 里 `"work": "password"` 是**最常见**的写法；
    /// 解析不了会让**服务端直接起不来**（不是降级，是启动失败）。
    /// 2026-09-25 由双跑比对抓到 —— 单测当时只测了 `from_json`，没测 serde 那条路。
    #[test]
    fn room_auth_accepts_all_four_forms_through_serde() {
        let cfg: Config = serde_json::from_str(
            r#"{"server":{"roomAuth":{
                "plain":"pw",
                "numeric":12345,
                "zero":0,
                "object":{"password":"x","fileExpire":0},
                "opened":{"open":true},
                "tuned":{"automation":"single"}
            }}}"#,
        )
        .expect("四种形态都要能解析 —— 解析不了服务端就起不来");

        assert_eq!(cfg.server.room_auth.get("plain").unwrap().password, "pw");
        assert_eq!(
            cfg.server.room_auth.get("numeric").unwrap().password,
            "12345"
        );
        assert_eq!(cfg.server.room_auth.get("zero").unwrap().password, "");
        let obj = cfg.server.room_auth.get("object").unwrap();
        assert_eq!(obj.password, "x");
        assert_eq!(obj.file_expire, Some(0));
        assert!(cfg.server.room_auth.get("opened").unwrap().open);
        assert_eq!(
            cfg.server.room_auth.get("tuned").unwrap().automation,
            "single"
        );
    }

    /// 认不出的形态要**报错**，不能静默当成空条目 —— 那会把一个受保护房间悄悄敞开。
    #[test]
    fn room_auth_rejects_an_unknown_shape() {
        let bad: Result<Config, _> =
            serde_json::from_str(r#"{"server":{"roomAuth":{"weird":["a","b"]}}}"#);
        assert!(bad.is_err(), "数组不是合法的 roomAuth 值");
    }

    /// ⚠️★ `automation.enabled` 的默认值必须与 Go 的 `defaultConfig()` 一致（`true`）。
    ///
    /// 这条防的是「**同一份 `config.json` 在两个实现上行为不同**」：写成 `false` 的话，
    /// 没配 `automation` 块的部署在 Rust 上会静默关掉定时自动化 —— `/tasks` 回 404、
    /// `/server` 报 `{"enabled": false}`、SPA 的工具条不显示入口。
    /// 2026-09-25 就是这条偏离（当时是 `false`，手写 `Default` 时没对 Go）由双跑比对抓出来的。
    ///
    /// ⚠️ 顺带钉住另一件事：**从 JSON 解析**（走 `#[serde(default)]`）与
    /// **直接构造**（走 `Default`）必须给同一套值 —— 两条路分叉是这类默认值最容易出的错。
    #[test]
    fn automation_defaults_match_go() {
        let cfg: Config =
            serde_json::from_str(r#"{"server":{"port":9501}}"#).expect("最小配置要能解析");
        assert!(
            cfg.automation.enabled,
            "automation.enabled 默认必须是 true —— 与 Go 的 defaultConfig() 一致"
        );
        assert_eq!(cfg.automation.tick_seconds, 30);
        assert_eq!(cfg.automation.grace_seconds, 600);
        assert_eq!(cfg.automation.default_tz, "Asia/Shanghai");

        let direct = Config::default();
        assert_eq!(direct.automation, cfg.automation, "两条默认值路径不能分叉");
    }
}
