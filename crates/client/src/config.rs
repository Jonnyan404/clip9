//! 客户端自己的配置。
//!
//! # ⚠️★ 方向是**两维**：上传 / 下载 × 内容（`docs/specs/desktop-client.md` §4.1）
//!
//! 第一版设计稿把它压成了「同步哪些内容」**一个**列表 —— 丢掉了「方向」这一整维。
//! 后果是那句问得很准的话：「如果我保存了多个房间，都同时往本地剪贴板灌数据，不就乱套了？」
//!
//! 所以这里的形状是：**每个房间**各有两个方向开关（[`Channel::enable_upload`] /
//! [`Channel::enable_download`]），**全局**再各有两个内容开关
//! （[`ClientConfig::enable_text`] / `enable_file` 管上行，
//! `enable_text_download` / `enable_file_download` 管下行）。四条规则：
//!
//! 1. **上传可以多房间同时开** —— [`ClientConfig::upload_channels`] 是**复数**：
//!    本机剪贴板的内容可以同时发到多个房间（「默认」+「家里」都想同步，这是合理的）。
//! 2. **下载全局只有一个房间** —— [`ClientConfig::download_channel`] 是**单数**。
//!    ⚠️ 这是必须的：两个房间同时写本机剪贴板 = **后到的覆盖先到的**，用户看到的是随机内容。
//! 3. **下载默认关闭**（[`Channel::enable_download`] 默认 `false`）。
//!    **装完就自动接管你的剪贴板是不该发生的事。**
//! 4. ⚠️★ **「只能一个」做成了单选**（[`ClientConfig::set_download_channel`]），
//!    而不是「取第一个」。行为基准 `clip-sync` 用的是 `find(...)` ——
//!    用户开了两个的时候它会**静默地只认第一个**，第二个开关点了没反应，
//!    而那正是这个项目最忌讳的一类（配了不生效）。所以这里：
//!    **UI 用单选**，而手改过的配置（真的开了两个）由 [`ClientConfig::problems`] **报出来**，
//!    不是悄悄挑一个。
//!
//! # 路径规则：与服务端同一套（§5）
//!
//! **相对路径 → 相对数据/配置目录**，不是 cwd（cwd 在不同启动方式下不可预测）；
//! **绝对路径 → 原样**。见 [`ClientConfig::resolve`]。
//! ⚠️ 别做成「两个客户端各有各的规矩」—— 那是「同一个产品的两处行为不一致」，最难解释。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::event::UploadKind;

fn default_true() -> bool {
    true
}

/// ⚠️★ 默认**关闭**。理由见模块文档第 3 条。
fn default_false() -> bool {
    false
}

/// ⚠️ 空房间名**不能**当成 `default` 用：`docs/api.md` §11.6 明确写了
/// 「省略 `room` 在部分端点上等于**任意房间**，要 default 就显式写 `default`」。
/// 所以这里的默认值是字符串 `"default"`，而不是空串。
fn default_room() -> String {
    "default".to_owned()
}

/// macOS / X11 上剪贴板**没有变更通知**，只能轮询 —— 所以这个间隔是
/// 「延迟 vs 空转」的取舍，**必须可配**（§8 审计清单那条），别写死一个数替用户做决定。
fn default_poll_interval_ms() -> u64 {
    500
}

/// 一个「通道」= **一台服务端上的一个房间**，带自己的凭据与两个方向的开关。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Channel {
    /// 给人看的名字（托盘菜单、设置界面）。
    pub name: String,

    /// 服务端地址，**含可能的子路径前缀**（`https://host/cloud-clipboard`）。
    /// 别在这里写接口路径 —— 接口由 [`crate::endpoint`] 拼。
    pub server: String,

    /// 房间名。默认 `default`（**显式下发**，见 [`default_room`]）。
    #[serde(default = "default_room")]
    pub room: String,

    /// 房间凭据（房间密码，或 `/auth/token` 换来的会话令牌）。
    ///
    /// ⚠️ **它只走请求头**（`Authorization: Bearer`），永远不进 URL ——
    /// 进了 URL 就会进访问日志、进浏览器历史、进别人能看到的分享文本。
    /// 拼 URL 的地方在 [`crate::endpoint`]，那里有断言钉住这一点。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,

    /// 上行：本机剪贴板的内容要不要发到这个房间。**默认开。**
    #[serde(default = "default_true")]
    pub enable_upload: bool,

    /// 下行：这个房间的内容要不要写进本机剪贴板。⚠️★ **默认关。**
    #[serde(default = "default_false")]
    pub enable_download: bool,
}

impl Channel {
    /// 建一个「默认开上行、关下行」的通道。
    ///
    /// 用它、别用结构体字面量：默认值就是规则本身（第 3 条），散在各处的字面量迟早会漂。
    #[must_use]
    pub fn new(name: impl Into<String>, server: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            server: server.into(),
            room: default_room(),
            auth_token: None,
            enable_upload: true,
            enable_download: false,
        }
    }
}

/// 客户端配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientConfig {
    /// 总开关。关掉 = 既不监听也不收（上行下行一起停）。
    #[serde(default = "default_true")]
    pub enable_monitoring: bool,

    // ── 上传范围 ───────────────────────────────────────────────────
    /// 文本（含 URL / 邮箱 / 颜色）要不要上行。
    #[serde(default = "default_true")]
    pub enable_text: bool,
    /// 文件与**图片**要不要上行。⚠️ 图片没有单独一档（§4.1 末），走这条。
    #[serde(default = "default_true")]
    pub enable_file: bool,

    // ── 下载范围 ───────────────────────────────────────────────────
    /// 收到文本时要不要写本机剪贴板（在某个房间开了下行之后才谈得上）。
    #[serde(default = "default_true")]
    pub enable_text_download: bool,
    /// 收到文件/图片时要不要落盘并写本机剪贴板。
    #[serde(default = "default_true")]
    pub enable_file_download: bool,

    /// 收到的文件落在哪。**按 §5 的规则解析**（相对 → 数据目录）。
    #[serde(default = "default_download_dir")]
    pub download_dir: PathBuf,

    /// 上行的文件大小上限（MB）。**0 = 不限，由服务端说了算。**
    ///
    /// ⚠️ 默认 0 是刻意的：`docs/api.md` §11 第 1、2 条要求「先问 `/server`，别硬编码限额」。
    /// 这里再放一个**比服务端更小**的数，就会变成「明明服务端能收，客户端自己拒了」——
    /// 而用户看到的是一句客户端编的话，不是服务端那句带具体数字的话。
    #[serde(default)]
    pub max_file_size_mb: u64,

    /// 监听轮询间隔（毫秒）。
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,

    /// 本机稳定 ID，上行时作为 `?client=` 下发。
    ///
    /// ⚠️ 它和 `?name=` **不是一个东西**（`docs/api.md` §11 第 5 条）：
    /// `name` 给人看（设备名），`client` 让程序判断「这条是不是我自己发的」。
    #[serde(default = "new_client_id")]
    pub client_id: String,

    /// 设备显示名（`?name=`）。空 = 让服务端从 User-Agent 推。
    #[serde(default)]
    pub device_name: String,

    /// 开机自动启动。**只有桌面端会用**（Android / OpenWrt 那边忽略它）。
    ///
    /// ⚠️ 为什么它在**这个**配置里、而不是壳自己的文件里：**只留一个配置文件**。
    /// 多一个文件就多一处要备份、要迁移、要跟用户解释的东西
    /// （§5：客户端与服务端**同一套路径规则**，用户已经知道配置在数据目录下了）。
    ///
    /// ⚠️ 默认 **false**：装完就往系统里塞一个自启项，那是**未经同意**改用户的机器。
    /// 想自启的人去勾一下，而不是「先勾上，不想要再去关」—— 后者会让用户在
    /// 「为什么这软件开机自己跑」上花时间。
    ///
    /// ⚠️ 它在系统里的**落地方式随平台不同**（macOS 是 LaunchAgent、Linux 是
    /// `~/.config/autostart/*.desktop`、Windows 是注册表），由桌面壳负责，
    /// 这个 crate **不碰**（它连 `tauri` 都不许出现，见 `desktop-client.md` §2）。
    #[serde(default)]
    pub enable_autostart: bool,

    /// **相对路径的解析基准**（应用的数据/配置目录）。
    ///
    /// ⚠️ 它**不落盘**（`#[serde(skip)]`）——
    /// 它是**运行环境**，不是用户配置：同一个配置文件在不同机器上就该落在各自的数据目录里。
    /// 调用方必须在加载之后设置它（[`ClientConfig::with_base_dir`]），
    /// 否则相对路径只能按 cwd 解析 —— 而 §5 明说了不行。
    #[serde(skip)]
    pub base_dir: Option<PathBuf>,

    /// 配置里的所有通道（房间）。
    #[serde(default)]
    pub channels: Vec<Channel>,
}

fn default_download_dir() -> PathBuf {
    PathBuf::from("downloads")
}

fn new_client_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            enable_monitoring: true,
            enable_text: true,
            enable_file: true,
            enable_text_download: true,
            enable_file_download: true,
            download_dir: default_download_dir(),
            max_file_size_mb: 0,
            poll_interval_ms: default_poll_interval_ms(),
            client_id: new_client_id(),
            device_name: String::new(),
            // ⚠️ 默认关（理由见字段注释）—— 显式写出来，别靠 `Default` 的隐式值。
            enable_autostart: false,
            base_dir: None,
            channels: Vec::new(),
        }
    }
}

impl ClientConfig {
    /// 设置相对路径的解析基准（加载完之后立刻做）。
    #[must_use]
    pub fn with_base_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.base_dir = Some(dir.into());
        self
    }

    /// §5 那条规则本身：**相对 → 相对数据目录；绝对 → 原样**。
    ///
    /// 抽成关联函数（而不是方法）是为了**能独立测** —— 它不该依赖一个完整的配置对象。
    #[must_use]
    pub fn resolve(base_dir: &Path, raw: &Path) -> PathBuf {
        if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            base_dir.join(raw)
        }
    }

    /// 解析下载目录。
    ///
    /// ⚠️ 返回 `Result` 而不是 `PathBuf`：`download_dir` 是相对的、而 `base_dir` 又没设时，
    /// **没有任何正确答案** —— 按 cwd 解析就是 §5 点名禁止的那件事。
    /// 与其悄悄按 cwd 走，不如在这里说不出来。
    pub fn download_dir(&self) -> Result<PathBuf, String> {
        match (&self.base_dir, self.download_dir.is_absolute()) {
            (_, true) => Ok(self.download_dir.clone()),
            (Some(base), false) => Ok(Self::resolve(base, &self.download_dir)),
            (None, false) => Err(format!(
                "下载目录是相对路径（{}），但没有设置数据目录 —— 相对路径必须相对数据目录解析，不能相对 cwd",
                self.download_dir.display()
            )),
        }
    }

    /// 上行目标：**复数**。
    ///
    /// ⚠️ 只筛「开关」，不筛内容类型 —— 内容类型那一维由
    /// [`ClientConfig::is_upload_enabled`] 单独判（两维要分得开，见模块文档）。
    #[must_use]
    pub fn upload_channels(&self) -> Vec<&Channel> {
        if !self.enable_monitoring {
            return Vec::new();
        }
        self.channels.iter().filter(|c| c.enable_upload).collect()
    }

    /// 下行目标：**单数**。
    ///
    /// 手改过的配置里真的开了两个时，这里返回**第一个**（总得有个确定行为），
    /// 但那是错配置 —— [`ClientConfig::problems`] 会把这件事报出来，
    /// 界面上的开关是单选（[`ClientConfig::set_download_channel`]），正常走不到这里。
    #[must_use]
    pub fn download_channel(&self) -> Option<&Channel> {
        if !self.enable_monitoring {
            return None;
        }
        self.channels.iter().find(|c| c.enable_download)
    }

    /// 开第 `index` 个房间的「同步到本地」，**并自动关掉别的**（UI 上那是单选）。
    /// `None` = 全都关掉。
    pub fn set_download_channel(&mut self, index: Option<usize>) {
        for (i, ch) in self.channels.iter_mut().enumerate() {
            ch.enable_download = Some(i) == index;
        }
    }

    /// 这一类内容要不要上行。
    #[must_use]
    pub fn is_upload_enabled(&self, kind: UploadKind) -> bool {
        self.enable_monitoring
            && match kind {
                UploadKind::Text => self.enable_text,
                UploadKind::File => self.enable_file,
            }
    }

    /// 这一类内容要不要写本机剪贴板。
    #[must_use]
    pub fn is_download_enabled(&self, kind: UploadKind) -> bool {
        match kind {
            UploadKind::Text => self.enable_text_download,
            UploadKind::File => self.enable_file_download,
        }
    }

    /// 配错了的地方。
    ///
    /// ⚠️ 这张清单存在的理由就是模块文档第 4 条：**「配了不生效」是这个项目最忌讳的一类**。
    /// 所以「开了两个下行」不是「悄悄挑一个」，而是要**能被告知**。
    #[must_use]
    pub fn problems(&self) -> Vec<String> {
        let mut out = Vec::new();

        let downloads: Vec<&Channel> = self.channels.iter().filter(|c| c.enable_download).collect();
        if downloads.len() > 1 {
            let names: Vec<&str> = downloads.iter().map(|c| c.name.as_str()).collect();
            out.push(format!(
                "有 {} 个房间开着「同步到本地」（{}）—— 只能有一个：两个房间会抢着写本机剪贴板，用户看到的是随机内容",
                downloads.len(),
                names.join("、")
            ));
        }

        for ch in &self.channels {
            let server = ch.server.trim();
            if server.is_empty() {
                out.push(format!("房间「{}」没填服务端地址", ch.name));
                continue;
            }
            match Url::parse(server) {
                Ok(url) if url.scheme() == "http" || url.scheme() == "https" => {}
                Ok(url) => out.push(format!(
                    "房间「{}」的服务端地址协议不对（{}）—— 只认 http / https",
                    ch.name,
                    url.scheme()
                )),
                Err(e) => out.push(format!("房间「{}」的服务端地址无法解析：{e}", ch.name)),
            }
        }

        if self.enable_monitoring && self.channels.is_empty() {
            out.push("监控开着，但一个房间都没配".to_owned());
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(name: &str, download: bool) -> Channel {
        Channel {
            enable_download: download,
            ..Channel::new(name, "http://127.0.0.1:9501")
        }
    }

    /// ⚠️★ **下载默认关**（§4.1 第 3 条）：装完不许自动接管用户的剪贴板。
    /// 这条同时钉住「上传默认开」—— 两个方向的默认值不一样，是刻意的。
    #[test]
    fn download_defaults_to_off_and_upload_to_on() {
        let c = Channel::new("家里", "http://127.0.0.1:9501");
        assert!(c.enable_upload, "上传默认应当开");
        assert!(!c.enable_download, "下载默认必须是关的");

        // 反序列化（读配置文件）那条路也要是同一个默认值。
        let from_json: Channel =
            serde_json::from_str(r#"{"name":"家里","server":"http://127.0.0.1:9501"}"#).unwrap();
        assert!(from_json.enable_upload);
        assert!(!from_json.enable_download);
    }

    /// 房间名的默认值是字符串 `default`，**不是空串**（§11.6：空 room 在部分端点 = 任意房间）。
    #[test]
    fn room_defaults_to_the_literal_default() {
        let from_json: Channel =
            serde_json::from_str(r#"{"name":"x","server":"http://h:9501"}"#).unwrap();
        assert_eq!(from_json.room, "default");
        assert!(!from_json.room.is_empty());
    }

    /// 上行是**复数**：两个房间都开着上传，一次复制两条都要发。
    #[test]
    fn upload_is_plural_download_is_singular() {
        let cfg = ClientConfig {
            channels: vec![ch("a", false), ch("b", false), ch("c", false)],
            ..ClientConfig::default()
        };
        assert_eq!(cfg.upload_channels().len(), 3, "三个房间都开着上传");
        assert!(cfg.download_channel().is_none(), "一个都没开下行");
    }

    /// ⚠️★ **`set_download_channel` 是单选**：开第二个会自动关掉第一个。
    ///
    /// 这条钉的就是那个坑（§4.1 第 4 条）：行为基准用 `find(...)` 取第一个，
    /// 于是「第二个开关点了没反应」= 配了不生效。
    #[test]
    fn set_download_channel_is_a_radio_not_a_find() {
        let mut cfg = ClientConfig {
            channels: vec![ch("a", false), ch("b", false), ch("c", false)],
            ..ClientConfig::default()
        };

        cfg.set_download_channel(Some(1));
        assert!(!cfg.channels[0].enable_download);
        assert!(cfg.channels[1].enable_download);
        assert!(!cfg.channels[2].enable_download);
        assert_eq!(cfg.download_channel().unwrap().name, "b");

        // 换一个 —— 前一个必须自动关掉，否则「开了两个」会在别处悄悄发生。
        cfg.set_download_channel(Some(2));
        assert!(!cfg.channels[1].enable_download, "换房间时上一个要关掉");
        assert_eq!(cfg.download_channel().unwrap().name, "c");

        // 全关。
        cfg.set_download_channel(None);
        assert!(cfg.download_channel().is_none());
        assert!(cfg.channels.iter().all(|c| !c.enable_download));
    }

    /// 手改出来的「两个下行」要被**报出来**，不是悄悄挑一个。
    #[test]
    fn two_download_channels_are_reported_not_silently_picked() {
        let cfg = ClientConfig {
            channels: vec![ch("a", true), ch("b", true)],
            ..ClientConfig::default()
        };
        let problems = cfg.problems();
        assert!(
            problems.iter().any(|p| p.contains("只能有一个")),
            "开了两个下行必须被报出来，实际：{problems:?}"
        );
        // 单数访问器仍然给一个确定答案（第一个）—— 但那是错配置，上面的提示才是正解。
        assert_eq!(cfg.download_channel().unwrap().name, "a");
    }

    /// 服务端地址填错（协议不对 / 解析不了 / 空）都要被报出来。
    #[test]
    fn bad_server_addresses_are_reported() {
        let cfg = ClientConfig {
            channels: vec![
                Channel {
                    server: String::new(),
                    ..ch("缺地址", false)
                },
                Channel {
                    server: "ftp://host".to_owned(),
                    ..ch("协议错", false)
                },
                Channel {
                    server: "不是地址".to_owned(),
                    ..ch("乱填", false)
                },
            ],
            ..ClientConfig::default()
        };
        let problems = cfg.problems();
        assert!(problems.iter().any(|p| p.contains("没填服务端地址")));
        assert!(problems.iter().any(|p| p.contains("协议不对")));
        assert!(problems.iter().any(|p| p.contains("无法解析")));
    }

    /// 总开关关掉 → 两个方向都停（不是只停一个）。
    #[test]
    fn monitoring_off_stops_both_directions() {
        let cfg = ClientConfig {
            enable_monitoring: false,
            channels: vec![ch("a", true)],
            ..ClientConfig::default()
        };
        assert!(cfg.upload_channels().is_empty());
        assert!(cfg.download_channel().is_none());
    }

    /// §5 那条路径规则：**相对 → 数据目录；绝对 → 原样**。
    #[test]
    fn relative_paths_resolve_against_the_data_dir() {
        let base = Path::new("/data/clip9");
        assert_eq!(
            ClientConfig::resolve(base, Path::new("downloads")),
            PathBuf::from("/data/clip9/downloads"),
            "相对路径要落在数据目录下，不是 cwd"
        );
        assert_eq!(
            ClientConfig::resolve(base, Path::new("/mnt/usb/dl")),
            PathBuf::from("/mnt/usb/dl"),
            "绝对路径原样"
        );
    }

    /// ⚠️ 相对下载目录 + 没设数据目录 = **说不出来**，而不是按 cwd 解析。
    #[test]
    fn relative_download_dir_without_base_dir_is_an_error() {
        let cfg = ClientConfig {
            download_dir: PathBuf::from("downloads"),
            base_dir: None,
            ..ClientConfig::default()
        };
        let err = cfg.download_dir().expect_err("必须报错");
        assert!(err.contains("cwd"), "错误信息要说清为什么不行：{err}");

        // 绝对路径不需要数据目录。
        let abs = ClientConfig {
            download_dir: PathBuf::from("/mnt/dl"),
            base_dir: None,
            ..ClientConfig::default()
        };
        assert_eq!(abs.download_dir().unwrap(), PathBuf::from("/mnt/dl"));

        // 给了数据目录就没问题。
        let ok = ClientConfig {
            download_dir: PathBuf::from("downloads"),
            base_dir: Some(PathBuf::from("/data/clip9")),
            ..ClientConfig::default()
        };
        assert_eq!(
            ok.download_dir().unwrap(),
            PathBuf::from("/data/clip9/downloads")
        );
    }

    /// `base_dir` **不落盘**：它是运行环境，不是用户配置。
    #[test]
    fn base_dir_is_not_serialized() {
        let cfg = ClientConfig {
            base_dir: Some(PathBuf::from("/data/clip9")),
            ..ClientConfig::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("base_dir"), "数据目录不该写进配置文件");
        assert!(!json.contains("/data/clip9"));

        // 读回来时它是 None —— 由调用方重新设置。
        let back: ClientConfig = serde_json::from_str(&json).unwrap();
        assert!(back.base_dir.is_none());
    }

    /// 内容类型的那一维和方向的那一维**分得开**：关掉「文本上传」不影响「文本下载」。
    #[test]
    fn the_two_dimensions_are_independent() {
        let cfg = ClientConfig {
            enable_text: false,
            enable_file: true,
            enable_text_download: true,
            enable_file_download: false,
            ..ClientConfig::default()
        };
        assert!(!cfg.is_upload_enabled(UploadKind::Text));
        assert!(cfg.is_upload_enabled(UploadKind::File));
        assert!(cfg.is_download_enabled(UploadKind::Text));
        assert!(!cfg.is_download_enabled(UploadKind::File));
    }

    /// 上传目录跟着房间的开关走，也受总开关管。
    #[test]
    fn upload_channels_respects_both_switches() {
        let mut cfg = ClientConfig {
            channels: vec![ch("a", false), ch("b", false)],
            ..ClientConfig::default()
        };
        cfg.channels[1].enable_upload = false;
        assert_eq!(cfg.upload_channels().len(), 1);
        assert_eq!(cfg.upload_channels()[0].name, "a");
    }

    /// ⚠️★ 开机自启**默认必须是关**的：装完就往系统里塞一个自启项，是**未经同意**
    /// 改用户的机器。这条钉的是**产品决定**，不是实现细节。
    ///
    /// ⚠️ 顺带钉住「**老配置读出来也不能变成开着**」：配置文件里没有这个键时，
    /// `#[serde(default)]` 必须落到 `false` —— 那正是「加字段不能让已有用户的行为变掉」
    /// 这条规矩在这一处的样子（老用户升级上来，机器上不该多出一个自启项）。
    #[test]
    fn autostart_is_off_by_default_and_for_old_configs() {
        assert!(
            !ClientConfig::default().enable_autostart,
            "默认要关（理由见字段注释）"
        );
        let parsed: ClientConfig = serde_json::from_str("{}").expect("空对象也要能读出来");
        assert!(
            !parsed.enable_autostart,
            "老配置里没有这个键，读出来必须是关的"
        );
    }
}
