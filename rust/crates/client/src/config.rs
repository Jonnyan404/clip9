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
//! 5. ⚠️★ **没有「全局暂停」**（2026-09-26 删掉了 `enable_monitoring`）。
//!    要不要读本机剪贴板、发不发出去，**只看每个房间的 ↑**（§4.7 之后连接本来就与它无关）。
//!    删的理由（Jonny）：「**侧栏的图标功能足够了**」——
//!    多一个「只停一半」的开关，只会让人分不清「是没开 ↑ 还是被暂停了」。
//!    ⚠️ 代价（明说）：**监听线程常开** —— 一个房间都没开 ↑ 时，它照样按
//!    `poll_interval_ms` 读剪贴板，只是每次都被 [`ClientConfig::upload_channels`]
//!    筛成空、什么也不发。这是**有意的**：为省这点空转去让「开 ↑」顺带起线程，
//!    会把「开关」和「线程生命周期」重新绑在一起，而那正是 §4.7 刚解开的那团结。
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
use crate::msg::Msg;

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

/// 两个服务端地址是不是**同一个端点**。
///
/// ⚠️★ 为什么不能直接比字符串：`http://localhost:9502` 与 `http://127.0.0.1:9502`
/// 是**同一个服务端**，`http://127.0.0.1:9502/` 与不带斜杠的那个也是。
/// 桌面端要用它回答「哪些已配的房间指向本机那个服务端」—— 直接比字符串会漏掉这两种写法，
/// 而用户看到的是一句「还没有房间指向它」（明明有）。
///
/// ⚠️ 比的四样：**协议 + 主机（别名归一）+ 端口（按协议取默认值）+ 路径前缀**。
/// 路径也要比：`http://h:9502/clip` 与 `http://h:9502` 是**两个不同的入口**。
///
/// ⚠️★ **解析不了的一律判不相等**（宁可漏报也不误报）：说「这个房间指向本机服务端」
/// 而它其实指向别处，比不说更坏。
#[must_use]
pub fn same_endpoint(left: &str, right: &str) -> bool {
    let (Ok(a), Ok(b)) = (Url::parse(left.trim()), Url::parse(right.trim())) else {
        return false;
    };
    a.scheme() == b.scheme()
        && host_key(&a) == host_key(&b)
        && a.port_or_known_default() == b.port_or_known_default()
        && path_key(&a) == path_key(&b)
}

/// 主机名的**别名归一**：`localhost` / `127.0.0.1` / `::1` 是同一台机器。
///
/// ⚠️ 只归一这几个**确定等价**的写法。别的（局域网 IP、域名）一律原样比 ——
/// 猜「这个 IP 大概也是本机」会误报，而误报比漏报坏。
fn host_key(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return "loopback".to_owned();
    }
    host
}

/// 路径前缀归一（末尾的 `/` 不算差异）。
fn path_key(url: &Url) -> &str {
    let path = url.path();
    path.strip_suffix('/').unwrap_or(path)
}

/// 一个「通道」= **一台服务端上的一个房间**，带自己的凭据与两个方向的开关。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Channel {
    /// 给人看的名字（托盘菜单、设置界面）。
    pub name: String,

    /// 服务端地址，**含可能的子路径前缀**（`https://host/clip9`）。
    /// 别在这里写接口路径 —— 接口由 [`crate::endpoint`] 拼。
    pub server: String,

    /// 房间名。默认 `default`（**显式下发**，见 [`default_room`]）。
    #[serde(default = "default_room")]
    pub room: String,

    /// 侧栏里那个房间图标（**用户自己挑的** emoji）。
    ///
    /// ⚠️★ **空 = 自动**，而「自动挑了哪一个」是**算出来的**（[`resolve_emojis`]）——
    /// 所以这里存的东西与界面画的图标**不是同一件事**，别把 `emoji` 当「现在显示的图标」读。
    /// 想要「实际显示的那一个」就调 [`resolve_emojis`]。
    ///
    /// ⚠️ 为什么不在这里存一个算好的：那样「用户没选过」这个事实就丢了 ——
    /// 而它在**加删房间**的时候要用（删掉一个房间之后，新加的那个应该能捡回空出来的图标）。
    ///
    /// ⚠️ 界面上那一格是**自由文本**（可以直接粘贴一个 emoji），所以存进来的值**可能是**
    /// 一段不像图标的文本 —— 判断规则只有一条（[`clean_emoji`]），
    /// 不合法的那种由 [`ClientConfig::problems`] **点名报出来**，不静默改掉。
    #[serde(default)]
    pub emoji: String,

    /// 房间凭据（房间密码，或 `/auth/token` 换来的会话令牌）。
    ///
    /// ⚠️ **它只走请求头**（`Authorization: Bearer`），永远不进 URL ——
    /// 进了 URL 就会进访问日志、进浏览器历史、进别人能看到的分享文本。
    /// 拼 URL 的地方在 [`crate::endpoint`]，那里有断言钉住这一点。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,

    /// 上行：本机剪贴板的内容要不要发到这个房间。⚠️★ **默认关**（Jonny 2026-09-26：
    /// 「上传和下载都默认关闭」）。
    ///
    /// ⚠️ 装完**一个方向都不流**，但客户端**照常连着**每个房间（§4.7）——
    /// 所以第一眼看到的是「都连上了、能看到设备和延迟，但没有东西在流」。
    /// 这正是要的：装完不该动你的剪贴板，也不该装作在工作。
    #[serde(default = "default_false")]
    pub enable_upload: bool,

    /// 下行：这个房间的内容要不要写进本机剪贴板。⚠️★ **默认关。**
    #[serde(default = "default_false")]
    pub enable_download: bool,
}

impl Channel {
    /// 建一个**两个方向都关**的通道。
    ///
    /// 用它、别用结构体字面量：默认值就是规则本身，散在各处的字面量迟早会漂。
    #[must_use]
    pub fn new(name: impl Into<String>, server: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            server: server.into(),
            room: default_room(),
            // ⚠️ 空 = **自动**（见字段注释），不是「没有图标」。
            emoji: String::new(),
            auth_token: None,
            enable_upload: false,
            enable_download: false,
        }
    }
}

/// 「自动挑一个图标」用的池子（Jonny 2026-09-28：「**否则随机一个不重样的 emoji**」）。
///
/// ⚠️★ 挑的是「池子里**第一个还没被占用**的」，不是随机 —— 两个理由：
/// ① 随机的话，**同一条配置每次启动都会换一个图标**（用户会以为配置坏了）；
/// ② 「不重样」这件事只有确定性实现才**测得了**（随机的测试只能写「大概在池子里」，
///    那是没牙的断言 —— 见 `missing_emojis_are_distinct` 里那条「两次算出来必须一样」）。
///
/// ⚠️ 只放**单个码位、默认就是 emoji 字形**的那些（`☕` / `⚙` 这种默认是文字字形的
/// 要靠 `U+FE0F` 才变成图标，而多一个码位就吃掉 [`EMOJI_MAX_CHARS`] 的一半）。
pub const EMOJI_POOL: [&str; 24] = [
    "💬", "🏠", "📋", "🔒", "🚀", "🎯", "🍀", "🐱", "🐶", "🦊", "🐼", "🐧", "🦉", "🌈", "🔥", "🍎",
    "🎵", "📦", "🧩", "🌙", "💡", "🌟", "🐢", "🎈",
];

/// 一格图标最多几个字符（`⚙️` 那种「基字符 + 变体选择符」算两个）。
pub const EMOJI_MAX_CHARS: usize = 2;

/// 用户填的那一格**收不收**：只收 1–2 个非 ASCII 字符，别的当成「没填」。
///
/// ⚠️★ 为什么要有这条规则：侧栏那个图标格在窄栏里只有十几像素宽 ——
/// 填一个词（`work` / `room1`）不会报错，只会**把整行撑坏**。
/// ⚠️ 为什么不是「截断成前两个字符」：`wo` 这种图标比自动挑的更让人迷惑。
#[must_use]
pub fn clean_emoji(raw: &str) -> Option<&str> {
    let text = raw.trim();
    // ⚠️ 只判两件事：**够短** + **一个 ASCII 都没有**。
    //    · `is_ascii` 挡掉 `work` / `a1` 这类词；
    //    · 空白**不用单独判**：`trim` 已经去掉了两头的，而夹在**中间**的空白
    //      至少要三个字符（`🐱 🐶`）→ 早被「不超过 2 个字符」拦下了。
    //      ⚠️ 写一条拦不住任何东西的条件，就是留一条**变异验证打不红**的假保护。
    let ok = !text.is_empty()
        && text.chars().count() <= EMOJI_MAX_CHARS
        && text.chars().all(|ch| !ch.is_ascii());
    ok.then_some(text)
}

/// 整份房间清单**实际显示**的图标（每个房间一个，顺序与 `channels` 一致）。
///
/// # ⚠️★ 这是算这件事的**唯一**一处
///
/// 界面上要画图标的地方只有**侧栏那一个**（`RoomView::emoji` 就是从这里来的）——
/// 设置页那一格画的是**用户填的原文**（留空就留空，占位符写「自动」）。
/// ⚠️ 也就是说设置页**故意不显示**这里算出来的结果：显示了就成了第二处「现在用的是哪个」，
/// 而用户会把它当成自己选的、一保存就真的变成他选的了。
///
/// 规则三条：
/// 1. **用户填过的（合法的）原样保留**，哪怕与别人重复 —— 那是他的选择，静默改一个更坏；
/// 2. 自动挑的**避开所有用户填过的**（不论位置：后面那个房间先挑的那个也得让开），
///    再避开前面已经挑掉的；
/// 3. 池子用完就**允许重复**（取模），但**绝不返回空** ——
///    「两个房间图标一样」只是不好看，「有个房间没图标」是画不出来。
#[must_use]
pub fn resolve_emojis(channels: &[Channel]) -> Vec<String> {
    let mut used: Vec<&str> = channels
        .iter()
        .filter_map(|channel| clean_emoji(&channel.emoji))
        .collect();

    channels
        .iter()
        .map(|channel| match clean_emoji(&channel.emoji) {
            Some(chosen) => chosen.to_owned(),
            None => {
                let pick = EMOJI_POOL
                    .iter()
                    .copied()
                    .find(|candidate| !used.contains(candidate))
                    .unwrap_or(EMOJI_POOL[used.len() % EMOJI_POOL.len()]);
                used.push(pick);
                pick.to_owned()
            }
        })
        .collect()
}

/// 客户端配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientConfig {
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

    // ── 通知（只有桌面端会用）────────────────────────────────────────
    /// 本机剪贴板**没发出去**时要不要发系统通知（失败了 / 被开关跳过）。
    ///
    /// ⚠️★ **成功不通知**（2026-09-27 定）。剪贴板那条上行是**自动**的 ——
    /// 用户没按任何按钮，每复制一次弹一句「已发到 1 个房间」是纯噪音。
    /// 值得打扰他的只有一件事：「你复制的这个东西**没到房间**」。
    ///
    /// ⚠️ 默认 **true**：这是「没发出去」唯一会说话的地方。界面那一格是**房间**的，
    /// 而剪贴板这条路上行会同时发给**所有**开着 ↑ 的房间（可能是几个、也可能一个都没有）
    /// —— 它不属于任何一个房间，不该挂在某个房间的标题下面（用户 2026-09-27 报的
    /// 「提示串房间了」）。剪贴板的事走**系统通知**。
    ///
    /// ⚠️ 它只在**真有房间开着 ↑** 时才可能响：↑ 全关时监听线程根本不跑
    ///（[`ClientConfig::watches_clipboard`]）。
    #[serde(default = "default_true")]
    pub notify_upload: bool,

    /// 房间的内容**写进本机剪贴板**时要不要发系统通知。
    ///
    /// ⚠️ 它只在某个房间的 ↓ 开着、**并且**这一类内容的 ↓ 也开着时才可能响
    ///（`receiver` 里那两道判据）—— 所以默认开也不会打扰一个没开下行的人；
    /// 而开了下行的人想知道「东西什么时候到我手上」，那正是这条通知。
    #[serde(default = "default_true")]
    pub notify_download: bool,

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

    /// **要不要占住那条全局快捷键**（显示 / 隐藏主窗口，默认 `⌘⇧V`）。
    ///
    /// ⚠️ **只有桌面端会用**（Android / OpenWrt 那边忽略它）—— 与 `enable_autostart` 同一个理由。
    ///
    /// ⚠️★ 默认 **true**，这一点与 `enable_autostart`（默认关）**相反**，理由是两者的
    /// 「默认不生效」代价不一样：
    ///   · 自启默认开 = **往用户的机器里塞东西**（未经同意），所以必须先问；
    ///   · 快捷键默认关 = 一个**纯客户端内部**的功能不生效，而它恰恰是
    ///     「窗口被关掉（= 藏起来）之后唯一的回头路」之一 —— 用户按了没反应时
    ///     根本不会想到「它默认是关的」。
    /// 它**不占**任何系统资源，也不需要权限（只是一个本进程的键盘钩子）。
    ///
    /// ⚠️ 落地方式**随平台不同**（macOS 的 `RegisterEventHotKey` / Windows 的
    /// `RegisterHotKey` / Linux 的 X11 grab），由桌面壳负责 —— 这个 crate **不碰**
    /// （它连 `tauri` 都不许出现，见 `desktop-client.md` §2）。
    #[serde(default = "default_true")]
    pub enable_hotkey: bool,

    /// **要不要连本机那个自带的服务端**（= 起它、并把它当成一个可连的服务端）。
    ///
    /// ⚠️ **只有桌面端会用**（Android / OpenWrt 那边忽略它）—— 与 `enable_autostart` 同一个理由。
    ///
    /// 界面上是「运行方式」那两选一（`docs/specs/desktop-client-settings-mockup.html`）：
    /// - `true`（默认）= **随客户端启动**：客户端起它、退出时停它；
    /// - `false` = **连别人的服务端（本机不起）**：只做客户端，适合已有服务器 /
    ///   Docker / OpenWrt 的场景。⚠️ 这时默认房间指向的本机地址是**死的** ——
    ///   用户要自己把房间改成他那台服务器（界面稿的 `.d` 里写着这件事）。
    ///
    /// ⚠️ 默认 `true`：装完就该能用（§9.1 第 2 条「随包分发服务端」）。
    /// 设成 `false` 是**用户明确不要**本机那一份，所以那不算「装完不能用」。
    #[serde(default = "default_true")]
    pub enable_local_server: bool,

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
            enable_text: true,
            enable_file: true,
            enable_text_download: true,
            enable_file_download: true,
            download_dir: default_download_dir(),
            max_file_size_mb: 0,
            poll_interval_ms: default_poll_interval_ms(),
            client_id: new_client_id(),
            device_name: String::new(),
            // ⚠️ 两个都默认**开**：它们各自只在「用户真的开了那个方向」之后才可能响
            //（↑ 全关时监听线程根本不跑；↓ 全关时没有东西会写剪贴板）。
            // 见 `notify_upload` / `notify_download` 的字段注释。
            notify_upload: true,
            notify_download: true,
            // ⚠️ 默认关（理由见字段注释）—— 显式写出来，别靠 `Default` 的隐式值。
            enable_autostart: false,
            // ⚠️ 反过来：默认**开**（装完就该能用，见字段注释）。
            enable_hotkey: true,
            // ⚠️ 反过来：默认**开**（装完就该能用，见字段注释）。
            enable_local_server: true,
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
    ///
    /// ⚠️★ 错误是 [`Msg`]（键 + 参数），**不是成句的中文**（2026-09-28 改）——
    /// 那句话说清「为什么不能按 cwd 走」，而它会被界面原样显示。
    pub fn download_dir(&self) -> Result<PathBuf, Msg> {
        match (&self.base_dir, self.download_dir.is_absolute()) {
            (_, true) => Ok(self.download_dir.clone()),
            (Some(base), false) => Ok(Self::resolve(base, &self.download_dir)),
            (None, false) => {
                Err(Msg::key("downloadDirNeedsDataDir").param("path", self.download_dir.display()))
            }
        }
    }

    /// 上行目标：**复数**。
    ///
    /// ⚠️ 只筛「开关」，不筛内容类型 —— 内容类型那一维由
    /// [`ClientConfig::is_upload_enabled`] 单独判（两维要分得开，见模块文档）。
    #[must_use]
    pub fn upload_channels(&self) -> Vec<&Channel> {
        self.channels.iter().filter(|c| c.enable_upload).collect()
    }

    /// 监听线程**该不该在跑**。
    ///
    /// ⚠️★ 唯一的判据是「**有没有任何一个房间开着 ↑**」（2026-09-27 Jonny 定的）：
    /// 「上传全关就关闭监听，开一个就打开监听。下载应该不需要调用监听剪贴板」。
    /// 原来那个独立的「剪贴板监听开关」（`enable_monitoring`）**早就删了**，
    /// 所以这件事只能由 ↑ 反推。
    ///
    /// ⚠️★ 它**必须**从 [`ClientConfig::upload_channels`] 推出来，不许自己再写一遍
    /// `any(enable_upload)`：那个函数是上行真正用的目标判据（空 = 一条都不发）。
    /// 两处各写一遍的话，「线程在跑而一个目标都没有」（白耗电）与
    /// 「有目标而线程没跑」（**静默不同步**，一条日志都没有）都会出现。
    #[must_use]
    pub fn watches_clipboard(&self) -> bool {
        !self.upload_channels().is_empty()
    }

    /// 下行目标：**单数**。
    ///
    /// ⚠️★ 它**只回答「哪个房间的内容会写进本机剪贴板」**，不再回答「连不连」——
    /// 连接与 ↑/↓ **无关**（每个房间各自一条连接，见 [`crate::receiver::spawn_receiver`]）。
    /// Jonny 2026-09-26：「下载本就不应该控制房间的任何功能」。
    ///
    /// ⚠️★ 这里**只读每个房间的 ↓** —— 没有任何全局开关能顺手把它关掉。
    /// 踩过的坑：它原来开头判 `enable_monitoring`（那个总开关 2026-09-26 已经删了），
    /// 「暂停剪贴板监听」是**上行**的事，却顺手把下行也停了 ——
    /// 于是用户点一下暂停，设备行、延迟、实时消息**全都消失**。
    /// 照实说「上下行都停」只是把谎说圆了，行为本身还是错的。
    ///
    /// 手改过的配置里真的开了两个时，这里返回**第一个**（总得有个确定行为），
    /// 但那是错配置 —— [`ClientConfig::problems`] 会把这件事报出来，
    /// 界面上的开关是单选（[`ClientConfig::set_download_channel`]），正常走不到这里。
    #[must_use]
    pub fn download_channel(&self) -> Option<&Channel> {
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
        match kind {
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
    ///
    /// ⚠️★ 每一项是 [`Msg`]（键 + 参数），**不是成文的中文**（2026-09-28 改）。
    /// 原来这里 `format!` 出一句中文 —— 于是界面切到英文时，这几十句**一个字都不变**，
    /// 而且不报错。现在这一层只说「是哪一类毛病、涉及谁」，
    /// 「怎么说」在 `rust/crates/desktop/ui/i18n.js` 的两个字典里（见 `msg` 的模块文档）。
    ///
    /// ⚠️ 房间名清单**整份**递过去（`{rooms}` 是个数组），**不在这里 `join`** ——
    /// 分隔符（中文的「、」还是英文的「, 」）由语言决定，不是这一层能定的。
    #[must_use]
    pub fn problems(&self) -> Vec<Msg> {
        let mut out = Vec::new();

        let downloads: Vec<&Channel> = self.channels.iter().filter(|c| c.enable_download).collect();
        if downloads.len() > 1 {
            out.push(
                Msg::key("configMultipleDownloads")
                    .param("count", downloads.len())
                    .param_list("rooms", downloads.iter().map(|c| c.name.clone())),
            );
        }

        for ch in &self.channels {
            // ⚠️★ 填了但**画不出来**的图标要点名 —— 不报的话，用户看到的只是
            //「我填的那个没了」（`resolve_emojis` 会当成没填、另挑一个），
            // 而**没有一句解释**。这正是「静默修正」那一类。
            if !ch.emoji.trim().is_empty() && clean_emoji(&ch.emoji).is_none() {
                out.push(
                    Msg::key("configRoomEmojiIgnored")
                        .param("room", &ch.name)
                        .param("emoji", ch.emoji.trim()),
                );
            }
            let server = ch.server.trim();
            if server.is_empty() {
                out.push(Msg::key("configRoomNoServer").param("room", &ch.name));
                continue;
            }
            match Url::parse(server) {
                Ok(url) if url.scheme() == "http" || url.scheme() == "https" => {}
                Ok(url) => out.push(
                    Msg::key("configRoomBadScheme")
                        .param("room", &ch.name)
                        .param("scheme", url.scheme()),
                ),
                Err(err) => out.push(
                    Msg::key("configRoomBadServer")
                        .param("room", &ch.name)
                        .param("reason", err),
                ),
            }
        }

        if self.channels.is_empty() {
            out.push(Msg::key("configNoRooms"));
        }

        out
    }

    /// 哪些已配的房间**指向这个端点**。
    ///
    /// ⚠️★ 桌面端用它回答一个具体的问题：「本机那个自带的服务端，我能连哪个地址」
    /// （Jonny 2026-09-26：「我现在都不知道我能连哪个本地服务器」）。
    /// 判据是 [`same_endpoint`]（不是字符串相等），理由在那个函数的文档里。
    #[must_use]
    pub fn channels_pointing_at(&self, endpoint: &str) -> Vec<&Channel> {
        self.channels
            .iter()
            .filter(|channel| same_endpoint(&channel.server, endpoint))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg::ParamValue;

    /// 一个开着**上行**的房间（`download` 单独给）。
    ///
    /// ⚠️ 这里**故意**不照抄「两个方向默认都关」（Jonny 2026-09-26 定的那个默认值）：
    /// 下面那些用例测的是「上行是复数 / 下行是单数」这类**筛选逻辑**，
    /// 两个都关着就什么都筛不出来。⚠️ 默认值本身由
    /// `both_directions_default_to_off` 单独钉住。
    fn ch(name: &str, download: bool) -> Channel {
        Channel {
            enable_upload: true,
            enable_download: download,
            ..Channel::new(name, "http://127.0.0.1:9501")
        }
    }

    /// ⚠️★ **两个方向默认都关**（Jonny 2026-09-26：「上传和下载都默认关闭」）：
    /// 装完既不许动你的剪贴板，也不许把本机剪贴板往房间里发。
    ///
    /// ⚠️ 而客户端**照常连着**每个房间（§4.7）—— 所以第一眼看到的是
    ///「都连上了、看得到设备和延迟，但没有东西在流」，而不是「连不上」。
    #[test]
    fn both_directions_default_to_off() {
        let c = Channel::new("家里", "http://127.0.0.1:9501");
        assert!(!c.enable_upload, "上传默认必须是关的");
        assert!(!c.enable_download, "下载默认必须是关的");

        // 反序列化（读配置文件）那条路也要是同一个默认值 —— 两条路漂了的话，
        // 「手写的配置」与「程序生成的配置」行为会不一样，而那是最难查的一种。
        let from_json: Channel =
            serde_json::from_str(r#"{"name":"家里","server":"http://127.0.0.1:9501"}"#).unwrap();
        assert!(!from_json.enable_upload);
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
    ///
    /// ⚠️★ 断言的是**键 + 参数**，不是「中文里有没有某个词」（2026-09-28 改）。
    /// 按中文子串断言的话，这句文案一改（或者翻译）测试就假红/假绿 ——
    /// 而它真正要钉住的是「这类毛病被报出来了、涉及哪几个房间」。
    #[test]
    fn two_download_channels_are_reported_not_silently_picked() {
        let cfg = ClientConfig {
            channels: vec![ch("a", true), ch("b", true)],
            ..ClientConfig::default()
        };
        let problems = cfg.problems();
        let first = problems.first().expect("开了两个下行必须被报出来");
        assert_eq!(first.key, "configMultipleDownloads", "实际：{problems:?}");
        assert_eq!(
            first.params.get("count").and_then(ParamValue::as_str),
            Some("2"),
            "要说清有几个"
        );
        // ⚠️★ 房间名是**一整份列表**过去，不是在这里拼好的字符串 ——
        // 拼接的分隔符由语言决定（中文「、」/ 英文「, 」），见 `msg` 的模块文档第 2 条。
        assert_eq!(
            first.params.get("rooms"),
            Some(&ParamValue::Many(vec![
                ParamValue::One("a".to_owned()),
                ParamValue::One("b".to_owned()),
            ])),
            "要**点名**是哪两个房间，而且不许在这里拼"
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
        let keys: Vec<&str> = problems.iter().map(|m| m.key.as_str()).collect();
        assert!(keys.contains(&"configRoomNoServer"), "实际：{problems:?}");
        assert!(keys.contains(&"configRoomBadScheme"), "实际：{problems:?}");
        assert!(keys.contains(&"configRoomBadServer"), "实际：{problems:?}");

        // ⚠️ 三条各带自己的房间名 —— 不然用户不知道去改哪一个。
        let rooms: Vec<Option<&str>> = problems
            .iter()
            .map(|m| m.params.get("room").and_then(ParamValue::as_str))
            .collect();
        assert_eq!(rooms, vec![Some("缺地址"), Some("协议错"), Some("乱填")]);
    }

    /// ⚠️★ **一个房间都没开 ↑ = 上行是空的**，而且**下行不受影响**。
    ///
    /// 这是删掉 `enable_monitoring` 之后留下的那条不变式（模块文档第 5 条）：
    /// 上行只看每个房间的 ↑，下行只看每个房间的 ↓，两个方向各自独立（§4.7）。
    /// ⚠️ 顺带钉住「**空 ≠ 错**」：没有上行目标时 `upload_channels()` 给空列表，
    /// 调用方（`uploader`）据此记 `skipped` 而不是 `error` —— 默认配置就是这个状态。
    #[test]
    fn no_upload_channel_does_not_touch_the_download() {
        let cfg = ClientConfig {
            channels: vec![Channel {
                enable_upload: false,
                ..ch("a", true)
            }],
            ..ClientConfig::default()
        };
        assert!(
            cfg.upload_channels().is_empty(),
            "没开 ↑ 就一个上行目标都没有"
        );
        assert!(
            cfg.download_channel().is_some(),
            "上行空了**不能**影响下行 —— 那是另一件事（§4.7）"
        );
        // ⚠️ 按内容类型的那两个开关**仍然说「可以发」**：它们回答的是「这一类内容发不发」，
        // 与「有没有房间要收」是两回事。混在一起的话，界面就没法区分
        //「是你自己关掉了文本」和「你一个房间都没开」。
        assert!(cfg.is_upload_enabled(UploadKind::Text));
        assert!(cfg.is_upload_enabled(UploadKind::File));
    }

    /// ⚠️★ 配置文件里**多出来的键**（比如已经删掉的 `enableMonitoring`）不能让配置读不出来。
    ///
    /// 这是 `serde` 的默认行为（没有 `deny_unknown_fields`），钉一下免得将来有人加上它 ——
    /// 那时候**磁盘上已有的 `client.json` 会当场读不出来**，而症状是「客户端起不来」，
    /// 与「加了个字段」联想不到一起。
    #[test]
    fn unknown_keys_in_the_config_file_are_ignored() {
        let parsed: ClientConfig =
            serde_json::from_str(r#"{"enableMonitoring": false, "enableText": true}"#)
                .expect("老配置必须还能读出来");
        assert!(parsed.enable_text);
        assert!(parsed.channels.is_empty());
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
        // ⚠️ 「错误信息要说清为什么不行」现在**分两半**：这一半钉「报的是哪一条 +
        // 带上了哪个目录」（要能指出是哪个路径说的），另一半是字典里那句解释
        // （`downloadDirNeedsDataDir`，中文要说清「相对路径没有基准，不会按 cwd 猜」）
        // —— 那一半在 `ui/i18n.js` 里，`tools/desktop-ui-smoke.mjs` 会去看。
        assert_eq!(err.key, "downloadDirNeedsDataDir");
        assert_eq!(
            err.params.get("path").and_then(ParamValue::as_str),
            Some("downloads"),
            "要说清是哪个目录：{err:?}"
        );

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

    /// 上行目标**只看每个房间的 ↑**（没有全局开关了，见模块文档第 5 条）。
    #[test]
    fn upload_channels_respects_the_room_switch() {
        let mut cfg = ClientConfig {
            channels: vec![ch("a", false), ch("b", false)],
            ..ClientConfig::default()
        };
        cfg.channels[1].enable_upload = false;
        assert_eq!(cfg.upload_channels().len(), 1);
        assert_eq!(cfg.upload_channels()[0].name, "a");
    }

    /// ⚠️★ **监听线程只在「有房间开着 ↑」时才该跑**（2026-09-27 Jonny 定的）：
    /// 「上传全关就关闭监听，开一个就打开监听。**下载应该不需要调用监听剪贴板**」。
    ///
    /// ⚠️★ 用例形状是刻意这样排的：**每一步只动一个字段**。四条断言里有两条
    /// 是「不该跑」，如果一次改两个字段，「只看 ↑」「只看 ↓」这两种错写法
    /// 都会在同一步里被满足 —— 那样这条测试就白写了（这个项目为此吃过一次亏）。
    #[test]
    fn the_watcher_runs_exactly_when_some_room_uploads() {
        // ① 一个房间都没配 → 没东西可发，不该跑。
        assert!(!ClientConfig::default().watches_clipboard());

        // ② 有房间，但两个方向都关着 → 不该跑。
        let mut cfg = ClientConfig {
            channels: vec![ch("a", false)],
            ..ClientConfig::default()
        };
        cfg.channels[0].enable_upload = false;
        assert!(
            !cfg.watches_clipboard(),
            "↑ 全关就该停掉监听线程（用户报的就是这条）"
        );

        // ③ **只开 ↓** → 仍然不该跑。下载是「把收到的写进剪贴板」，
        //    那是 `receiver` 干的活，跟「读本机剪贴板」这个轮询线程无关。
        cfg.channels[0].enable_download = true;
        assert!(
            !cfg.watches_clipboard(),
            "↓ 不是起监听的理由（Jonny 原话：下载应该不需要调用监听剪贴板）"
        );

        // ④ 开一个 ↑ → 该跑。
        cfg.channels[0].enable_upload = true;
        assert!(cfg.watches_clipboard());

        // ⑤ 再加一个关着 ↑ 的房间 → 不影响（判据是「**有任何一个**开着」）。
        cfg.channels.push(ch("b", false));
        cfg.channels[1].enable_upload = false;
        assert!(cfg.watches_clipboard(), "有一个开着就该继续跑");
    }

    /// ⚠️ 两个通知开关默认都**开**，而且**老配置里没有这两个键时也必须读出「开」**
    ///（两条路漂了的话，「手写的配置」与「程序生成的配置」行为不一样，最难查）。
    ///
    /// ⚠️ 默认开的理由与 `enable_autostart`（默认关）**不冲突**：那个是往系统里
    /// 塞东西、必须问过；这两个各自只在「用户已经开了那个方向」之后才可能响
    /// —— 也就是说，**是用户自己先要求了同步，通知才有内容可说**。
    #[test]
    fn notifications_are_on_by_default_and_for_old_configs() {
        let default = ClientConfig::default();
        assert!(default.notify_upload, "默认开（理由见字段注释）");
        assert!(default.notify_download, "默认开（理由见字段注释）");

        let parsed: ClientConfig = serde_json::from_str("{}").expect("空对象也要能读出来");
        assert!(parsed.notify_upload, "老配置读出来必须是开的");
        assert!(parsed.notify_download, "老配置读出来必须是开的");

        // ⚠️ 关掉之后要能**存下来**（不然用户关了、下次启动又开着 —— 那一类
        // 「设了不生效」正是这个项目最忌讳的）。
        let off = ClientConfig {
            notify_upload: false,
            ..ClientConfig::default()
        };
        let json = serde_json::to_string(&off).unwrap();
        let back: ClientConfig = serde_json::from_str(&json).unwrap();
        assert!(!back.notify_upload);
    }

    /// ⚠️★ 开机自启**默认必须是关**的：装完就往系统里塞一个自启项，是**未经同意**
    /// 改用户的机器。这条钉的是**产品决定**，不是实现细节。
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

    /// ⚠️★ **全局快捷键默认是开**的 —— 与 `enable_autostart`（默认关）**故意相反**，
    /// 两边都别记反：那一个是「往用户机器里塞东西」，必须先问；这一个只是
    /// 「本进程占一个组合键」，而它默认关的样子是「按了没反应」——
    /// 用户不会想到「它默认是关的」。
    ///
    /// ⚠️ 顺带钉住「老配置读出来也不能变成关着」（文件里没有这个键时
    /// `#[serde(default = "default_true")]` 必须落到 `true`），
    /// 以及「关掉之后要能存下来」（设了不生效是同一类病）。
    #[test]
    fn the_hotkey_is_on_by_default_and_for_old_configs() {
        assert!(
            ClientConfig::default().enable_hotkey,
            "默认要开（理由见字段注释）"
        );
        let parsed: ClientConfig = serde_json::from_str("{}").expect("空对象也要能读出来");
        assert!(parsed.enable_hotkey, "老配置里没有这个键，读出来必须是开的");

        let off = ClientConfig {
            enable_hotkey: false,
            ..ClientConfig::default()
        };
        let json = serde_json::to_string(&off).unwrap();
        let back: ClientConfig = serde_json::from_str(&json).unwrap();
        assert!(!back.enable_hotkey, "关掉之后必须存得下来");
    }

    /// ⚠️★ **「随客户端启动」默认开着** —— 与 `enable_autostart` 正好相反，两边都别记反。
    ///
    /// 理由：桌面端**随包分发服务端**（§9.1 第 2 条），装完就该能用。
    /// ⚠️ 顺带钉住「老配置读出来也不能变成关着」：文件里没有这个键时，
    /// `#[serde(default)]` 必须落到 `true` —— 否则升级上来的人会发现
    /// 「客户端不再起本机服务端了」，而默认房间指向的地址就成了死的。
    #[test]
    fn the_local_server_is_on_by_default_and_for_old_configs() {
        assert!(
            ClientConfig::default().enable_local_server,
            "默认要开（理由见字段注释）"
        );
        let parsed: ClientConfig = serde_json::from_str("{}").expect("空对象也要能读出来");
        assert!(
            parsed.enable_local_server,
            "老配置里没有这个键，读出来必须是开的"
        );
    }

    /// ⚠️★ 「同一个端点」的判据：**别名要归一、路径前缀要算数、解析不了就不相等**。
    ///
    /// 桌面端用它回答一个具体的问题：「本机那个自带的服务端，我能连哪个地址」。
    /// 判错的两种后果都很难看：**漏报** → 界面说「还没有房间指向它」（明明有）；
    /// **误报** → 界面说「这几个房间指向本机服务端」，而它们其实连的是别人的。
    #[test]
    fn endpoint_equality_normalises_aliases_but_not_prefixes() {
        // 别名：这三种写法是同一台机器。
        assert!(same_endpoint(
            "http://127.0.0.1:9502",
            "http://localhost:9502"
        ));
        assert!(same_endpoint("http://localhost:9502", "http://[::1]:9502"));
        // 末尾斜杠不算差异。
        assert!(same_endpoint(
            "http://127.0.0.1:9502/",
            "http://127.0.0.1:9502"
        ));
        // 协议名大小写不敏感（配置里手写 `Https://` 也认）。
        assert!(same_endpoint(
            "Https://example.com",
            "https://example.com/"
        ));

        // ⚠️ 路径前缀**是**差异：反代到子路径是两个不同的入口。
        assert!(!same_endpoint("http://h:9502/clip", "http://h:9502"));
        assert!(same_endpoint("http://h:9502/clip/", "http://h:9502/clip"));

        // 端口、协议、主机都不是同一回事。
        assert!(!same_endpoint(
            "http://127.0.0.1:9501",
            "http://127.0.0.1:9502"
        ));
        assert!(!same_endpoint(
            "http://127.0.0.1:9502",
            "https://127.0.0.1:9502"
        ));
        assert!(!same_endpoint(
            "http://10.0.0.8:9502",
            "http://127.0.0.1:9502"
        ));

        // ⚠️★ 解析不了的一律**不相等** —— 宁可漏报，也不误报。
        assert!(!same_endpoint("", "http://127.0.0.1:9502"));
        assert!(!same_endpoint("不是地址", "不是地址"));
    }

    /// 桌面端要的那一问：**哪些已配的房间指向本机那个服务端**。
    #[test]
    fn channels_pointing_at_finds_the_local_ones() {
        let cfg = ClientConfig {
            channels: vec![
                Channel::new("默认", "http://127.0.0.1:9502"),
                // ⚠️ 同一个服务端的另一种写法 —— 也要算上（否则界面会漏报）。
                Channel::new("另一种写法", "http://localhost:9502/"),
                Channel::new("别人的", "https://example.com"),
            ],
            ..ClientConfig::default()
        };
        let names: Vec<&str> = cfg
            .channels_pointing_at("http://127.0.0.1:9502")
            .iter()
            .map(|channel| channel.name.as_str())
            .collect();
        assert_eq!(names, vec!["默认", "另一种写法"]);
        assert!(
            cfg.channels_pointing_at("http://127.0.0.1:9600").is_empty(),
            "端口不对就不是同一台"
        );
    }

    // ── 房间图标（`emoji`）──────────────────────────────────────────
    //
    // ⚠️★ 这几条钉的是 Jonny 2026-09-28 那句：「添加房间允许用户自定义 emoji，
    // **否则随机一个不重样的 emoji**」。
    // ⚠️ 注意「不重样」是**要求**、「随机」只是他随手写的实现建议 —— 这里选了确定性实现，
    // 因为随机的东西**测不了**（见 `missing_emojis_are_distinct` 里那条稳定性断言）。

    /// ⚠️★ 没填图标的房间，自动挑的必须**互不相同**、**都在池子里**、而且**两次算出来一样**。
    #[test]
    fn missing_emojis_are_distinct() {
        let rooms: Vec<Channel> = ["a", "b", "c", "d"]
            .iter()
            .map(|name| Channel::new(*name, "http://127.0.0.1:9502"))
            .collect();
        let icons = resolve_emojis(&rooms);

        assert_eq!(icons.len(), rooms.len(), "每个房间都要有一个图标");
        for icon in &icons {
            assert!(
                EMOJI_POOL.contains(&icon.as_str()),
                "自动挑的必须来自池子：{icon}"
            );
        }
        let mut unique = icons.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            icons.len(),
            "四个房间的图标要互不相同：{icons:?}"
        );

        // ⚠️★ 「随机」会在这条上红 —— 而它正是「不重样」之外用户真正在意的那半边：
        //    同一条配置每次启动换个图标，看起来就像配置坏了。
        assert_eq!(resolve_emojis(&rooms), icons, "同一个输入必须给同一个答案");
    }

    /// 用户填过的**原样保留**，而且自动挑的**要让开它**（哪怕填的那个在后面）。
    #[test]
    fn chosen_emoji_is_kept_and_avoided() {
        let mut first = Channel::new("a", "http://127.0.0.1:9502");
        first.emoji = "🦊".to_owned();
        let second = Channel::new("b", "http://127.0.0.1:9502");

        let icons = resolve_emojis(&[first, second]);
        assert_eq!(icons[0], "🦊", "用户填的不许被换掉");
        assert_ne!(icons[1], "🦊", "自动挑的不能抢走用户已经填过的那个");

        // ⚠️ 反方向也要对：用户在**后面**那个房间填的，前面那个自动的同样要让开。
        let mut late = Channel::new("b", "http://127.0.0.1:9502");
        late.emoji = "💬".to_owned();
        let icons = resolve_emojis(&[Channel::new("a", "http://127.0.0.1:9502"), late]);
        assert_ne!(
            icons[0], "💬",
            "自动挑的时候要**先**把整份清单里用户填过的都记下来，不能只往前看"
        );
        assert_eq!(icons[1], "💬");
    }

    /// 用户填了**重复**的 → 两份都留着：那是他的选择，静默改掉一个才是坏事。
    #[test]
    fn duplicate_chosen_emojis_are_left_alone() {
        let mut a = Channel::new("a", "http://127.0.0.1:9502");
        a.emoji = "🔥".to_owned();
        let mut b = Channel::new("b", "http://127.0.0.1:9502");
        b.emoji = "🔥".to_owned();

        assert_eq!(resolve_emojis(&[a, b]), vec!["🔥", "🔥"]);
    }

    /// 不像图标的值一律当成**没填**（而不是「截断成前两个字符」）。
    #[test]
    fn values_that_do_not_look_like_an_icon_count_as_unset() {
        assert_eq!(clean_emoji(""), None, "空 = 自动");
        assert_eq!(clean_emoji("   "), None, "全是空白也 = 自动");
        assert_eq!(
            clean_emoji("work"),
            None,
            "ASCII 的词不是图标（会把侧栏撑坏）"
        );
        assert_eq!(clean_emoji("a1"), None, "两个 ASCII 字符也不行");
        assert_eq!(clean_emoji("🐱🐶🐼"), None, "三个字符放不进那一格");
        assert_eq!(clean_emoji("🐱 🐶"), None, "夹着空白的更放不进（三个字符）");

        assert_eq!(clean_emoji("🦊"), Some("🦊"));
        assert_eq!(
            clean_emoji(" 🦊 "),
            Some("🦊"),
            "手打会带上前后空白，要容忍"
        );
        assert_eq!(
            clean_emoji("⚙\u{fe0f}"),
            Some("⚙\u{fe0f}"),
            "「基字符 + 变体选择符」是两个字符 —— 上限不能比它小"
        );
    }

    /// 房间数超过池子大小时**允许重复**，但**一个都不能少**。
    ///
    /// ⚠️ 少了的那一个在界面上就是「这一行没有图标」—— 而它**不报错**。
    #[test]
    fn more_rooms_than_the_pool_still_gets_an_icon() {
        let rooms: Vec<Channel> = (0..EMOJI_POOL.len() + 5)
            .map(|index| Channel::new(format!("r{index}"), "http://127.0.0.1:9502"))
            .collect();
        let icons = resolve_emojis(&rooms);
        assert_eq!(icons.len(), rooms.len());
        assert!(
            icons.iter().all(|icon| !icon.is_empty()),
            "池子用完也得给一个（重复好过没有）：{icons:?}"
        );
    }

    /// ⚠️★ 填了却画不出来的图标要**点名报出来** —— 不能静默换成自动的。
    #[test]
    fn a_value_that_is_not_an_icon_is_reported() {
        let cfg = ClientConfig {
            channels: vec![Channel {
                emoji: "work".to_owned(),
                ..ch("家里", false)
            }],
            ..ClientConfig::default()
        };
        let problems = cfg.problems();
        assert!(
            problems.iter().any(|m| m.key == "configRoomEmojiIgnored"),
            "填了个画不出来的图标必须被报出来，实际：{problems:?}"
        );
        // ⚠️ 反过来：**合法的**图标（包括留空）都不该产生任何提示 ——
        //    否则每配一个房间就多一句废话。
        let clean = ClientConfig {
            channels: vec![
                Channel {
                    emoji: "🦊".to_owned(),
                    ..ch("有图标", false)
                },
                ch("自动", false),
            ],
            ..ClientConfig::default()
        };
        assert!(
            !clean
                .problems()
                .iter()
                .any(|m| m.key == "configRoomEmojiIgnored"),
            "合法的图标与留空都不该报：{:?}",
            clean.problems()
        );
    }
}
