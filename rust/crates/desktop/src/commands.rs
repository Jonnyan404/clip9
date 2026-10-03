//! Tauri 命令 —— **全是转发，一行业务逻辑都没有**。
//!
//! # 为什么要这么薄
//!
//! 逻辑都在 [`crate::store`] 与 [`crate::runtime`] 里，而那两个文件**不依赖 `tauri`**
//! （理由见它们的模块文档）。所以这里只做一件事：把 `tauri::State` 变成
//! `Arc<Store>` / `Arc<Runtime>`，把命令的参数变成 `usize` / `String`。
//!
//! ⚠️ 这样分的收益是**能测**：页面点一下就走的那条路（开关 → 落盘 → 界面更新），
//! 在 `store` 的测试里是**普通函数调用**，不用起窗口、不用手点。
//!
//! # ⚠️★ 报错一律是 [`Msg`]（键 + 参数），不是成文的中文
//!
//! 2026-09-28 改。命令的 `Err` 类型从 `String` 换成了 [`Msg`]：
//! Tauri 对命令的错误类型只要求 `Serialize`（`impl<T: Serialize> From<T> for InvokeError`），
//! 所以页面 `catch` 到的是**那个对象**（`{key, params}`），拿 `I18N.say` 一渲染就是
//! 当前语种的那句话。理由与整个 3b 那一轮一样：**壳不知道用户选了哪个语种**。
//! ⚠️ 这不是「顺手换个类型」：原来那些句子是硬编码的中文，切到英文界面时
//! 它们**一个字都不变**，而且不报错 —— 这个项目最忌讳的那一类。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use clip9_client::Msg;
// ⚠️ `Manager` 是为了 `app.state::<…>()`（`pick_files` 从 `app` 上取字典，见那条注释）。
use tauri::{Manager, State};

use crate::runtime::{Ask, Runtime};
use crate::server_config::ServerConfigFile;
use crate::server_process::ServerProcess;
use crate::shell_text::ShellText;
use crate::store::{NoticeLevel, Snapshot, Store};

// ── 「设置」窗口（客户端自己的配置）──────────────────────────────────

/// 一次保存要改的全部东西。
///
/// ⚠️★ 为什么是**一条**命令而不是七八条：界面一次保存改的是一**组**东西
/// （房间清单 + 同步范围 + 桌面行为），分几条发的话中间任何一条失败都会留下
/// **半套设置** —— 而用户看到的是「保存了，但有一半没生效」，那是这类功能里最难查的。
///
/// ⚠️ 每个字段都是可选的：`None` = 不改（界面只提交它改过的那几组）。
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    /// 房间清单（给了就**整份替换** —— 界面拿的是完整列表）。
    pub rooms: Option<Vec<clip9_client::Channel>>,
    /// 同步范围 / 轮询间隔 / 下载目录。
    pub sync: Option<crate::store::SyncScopePatch>,
    /// 开机自启（**意图**；落到系统上由 `autostart::apply` 做）。
    pub autostart: Option<bool>,
    /// 「本机剪贴板**没发出去**时发系统通知」。
    ///
    /// ⚠️ 为什么**不在** `sync` 那一组里：它们是**通知**的事，与「同步范围」无关 ——
    /// 塞进 `SyncScopePatch` 的话，那个结构体的名字就开始说谎了（下一棒会问
    /// 「通知开关为什么在同步范围里」）。它们与 `autostart` 同一类：
    /// 一个**不带房间、也不属于某个分组**的直接项 —— 所以这里也放成平级的 `Option<bool>`。
    pub notify_upload: Option<bool>,
    /// 「房间的内容**写进本机剪贴板**时发系统通知」。
    pub notify_download: Option<bool>,
    /// 「占住那条全局快捷键」（显示 / 隐藏主窗口，`hotkeys::TOGGLE_WINDOW`）。
    ///
    /// ⚠️ 与上面两个同一个位置（平级、不带分组）：它是**桌面行为**，与「同步范围」无关。
    /// ⚠️★ 它落地时要**真的去注册 / 撤销**（`hotkeys::apply`）——只改配置的话，
    /// 用户勾了、界面勾着、键却没占上，就是「配了不生效」。
    pub hotkey_enabled: Option<bool>,
}

/// 保存「设置」窗口。
#[tauri::command]
pub fn apply_settings(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    patch: SettingsPatch,
) -> Result<(), Msg> {
    if let Some(rooms) = patch.rooms {
        store.set_rooms(rooms);
        // ⚠️ 房间清单变了 → **下行必须重连**：`spawn_receiver` 拿的是启动时那份
        // 配置的副本（`set_download` 那条命令的注释里写着同一件事）。
        runtime.restart_receiver();
        // ⚠️★ 而**监听线程**也要跟着重判一次：这一批房间可能把 ↑ 全关了
        //（用户删掉唯一开着 ↑ 的那个房间），也可能从零开了一个。
        // 少了这一步，症状是「删掉最后一个开着 ↑ 的房间，线程还在读剪贴板」——
        // 而**界面上什么都看不出来**（↑ 一个都不亮，但剪贴板照旧被轮询）。
        runtime.sync_watcher();
    }
    if let Some(scope) = patch.sync {
        // ⚠️ 只有**真的变了**才重启监听线程：没变也重启的话，用户每点一次保存
        // 监听都会断一下（那段时间的剪贴板变化会漏）。
        // ⚠️ 和 `set_sync_scope` 用**同一个**下界（`max(1)`），否则「填 0」会被
        // 这里判成「变了」、而那边夹成 1 —— 每次都白重启一次。
        let interval_changed = scope
            .poll_interval_ms
            .is_some_and(|value| store.config().poll_interval_ms != value.max(1));
        store.set_sync_scope(&scope);
        // ⚠️ 轮询间隔是 `spawn_watcher` 时读进 `WatchConfig` 的 ——
        // 改配置不影响已经在跑的线程，得重启监听才生效。
        if interval_changed {
            runtime.restart_watcher();
        }
    }
    if let Some(on) = patch.autostart {
        store.set_autostart(on);
        // ⚠️ 两件事都要做：改配置里的意图 + 落到系统上（见 `autostart` 的模块文档）。
        crate::autostart::apply(&app, on);
    }
    // ⚠️ 通知这两个开关**没有「重启谁」这一步**：读它们的地方是 `runtime` 里那两条
    // 纯判据（要发通知时现读 `self.store.config()`），所以**存下去就生效**。
    // 需要「重启某个线程才生效」的只有 `poll_interval_ms`（见上面那段）——
    // 两者别混：给这里加一句 `restart_*` 是白重启，而**漏了该重启的那处**才是配了不生效。
    if patch.notify_upload.is_some() || patch.notify_download.is_some() {
        store.set_notify(patch.notify_upload, patch.notify_download);
    }
    if let Some(on) = patch.hotkey_enabled {
        store.set_hotkey(on);
        // ⚠️★ 与自启同一条：改配置 + 落到系统上（注册 / 撤销那个全局键）。
        // ⚠️★ 而它**失败不许把这整次保存判死** —— 别的设置已经存下去了，
        // 为一个组合键没抢到就说「没保存」，用户会以为什么都没成。
        // 所以这里只**说出来**（日志 + 提示区），返回值照旧是 `Ok`。
        // ⚠️ 提示区那一条会被下一个动作顶掉 —— 所以设置那页另有一行
        // 「系统里的真相」（`hotkey_registered`），那个一直在。
        if let Err(problem) = crate::hotkeys::apply(&app, on) {
            eprintln!("{problem:?}");
            store.notice(NoticeLevel::Error, problem);
        }
    }
    runtime.persist();
    Ok(())
}

/// 开机自启**现在到底开没开**（问系统，不是问配置）。
///
/// ⚠️★ 界面那个勾画的是**系统里的真相**：用户在系统设置里关掉之后，
/// 画配置里的意图就是骗人（他会以为「开着呢，怎么没自启」）。
#[tauri::command]
pub fn autostart_enabled(app: tauri::AppHandle) -> bool {
    crate::autostart::initial_checked(&app)
}

/// 那条全局快捷键**现在到底占到了没有**（问系统，不是问配置）。
///
/// ⚠️★ 与 [`autostart_enabled`] 同一个套路，而且这里**更需要**它：
/// 自启那个勾本身就是真相，而快捷键那一格画的是**配置里的意图** ——
/// 组合键被别的程序占着时，界面上的勾照旧是勾，唯一的区别就在这一行
///（`hotkeys::is_registered`）。少了它，用户看到的是「按了没反应」。
#[tauri::command]
pub fn hotkey_registered(app: tauri::AppHandle) -> bool {
    crate::hotkeys::is_registered(&app)
}

/// 「设置」窗口要读的那一份。
///
/// ⚠️★ 为什么**不是**把 `authToken` 塞进 `Snapshot`：快照是**每 700ms 轮询一次**的，
/// 把房间凭据放进去等于**每 700ms 传一次密码**（本机 IPC，不泄露，但白传）。
/// 设置窗口是「打开时读一次」的东西，所以单独一条命令。
///
/// ⚠️ 字段名**统一 camelCase**（`rooms` 里那几个除外 —— 那是 `Channel` 自己的
/// 字段名，直接用它的类型而不是再包一层镜像：少一份会漂的定义）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// ⚠️★ 这里给的是**用户填的**那份（`Channel::emoji`，可能为空 = 自动），
    /// **不是**「实际显示的那一个」—— 界面那一格留空就是留空。
    ///
    /// ⚠️ 为什么不顺手把算出来的图标填进去（那样界面就不用处理「空」了）：
    /// 填了之后，用户**只是打开过一次设置页**、什么都没改就点保存，那些图标就从
    /// 「自动」变成「他选的」了 —— 而「他没选过」这个事实**再也回不来**
    /// （删掉一个房间之后，空出来的图标就回不到新房间身上了）。
    /// ⚠️ 界面那一格因此在留空时显示一个灰色的「自动」，它对应的就是这条规则
    /// （`clip9_client::resolve_emojis`）—— 那里是**唯一**算这件事的地方。
    pub rooms: Vec<clip9_client::Channel>,
    /// 「自动挑一个图标」那个池子 —— 界面把它画成**点选**的一项一项
    /// （2026-09-29，Jonny：「添加房间里图标可以点选，不要输入，用户又不懂输入啥」）。
    ///
    /// ⚠️★ **从壳递过去，不让界面自己抄一份**：池子只有一处定义
    /// （[`clip9_client::EMOJI_POOL`]，`resolve_emojis` 挑的就是它）。
    /// 界面抄一份的后果不是报错，而是**两边慢慢不一样**：
    /// 壳那边加了新图标、界面这一格选不到 —— 于是「自动挑得出来的，用户自己选不了」。
    /// ⚠️ 给的是 `&'static str` 的切片（池子本来就是编译期常量），序列化出去是字符串数组。
    pub emoji_pool: Vec<&'static str>,
    pub enable_text: bool,
    pub enable_file: bool,
    pub enable_text_download: bool,
    pub enable_file_download: bool,
    pub poll_interval_ms: u64,
    pub download_dir: String,
    /// 本机剪贴板**没发出去**时发系统通知（`notify_upload`）。
    pub notify_upload: bool,
    /// 房间的内容**写进本机剪贴板**时发系统通知（`notify_download`）。
    pub notify_download: bool,
    /// ⚠️ **系统里的真相**（启动项在不在），不是配置里的意图。
    pub autostart: bool,
    /// ⚠️ **配置里的意图**（要不要占那条全局快捷键）—— 与 `autostart` 不一样，
    /// 它没有「系统里的真相」这一说：真相是另一条命令（`hotkey_registered`）。
    /// 两件事分开是因为它们**会不一致**（组合键被别人占着），而那时用户要能看出来。
    pub hotkey_enabled: bool,
    /// 那条快捷键**给界面看的写法**（macOS `⌘⇧V` / 别处 `Ctrl+Shift+V`）。
    ///
    /// ⚠️★ 由壳算好递过来，界面**不许**自己拼一个 `⌘⇧V`：那是把「真正注册的是哪个键」
    /// 抄第二遍，而两份一定会漂 —— 漂了的表现是界面显示一个**不生效**的键。
    /// 算法只有一处（`hotkeys::display_toggle_window`）。
    pub hotkey_toggle_window: String,
    /// 桌面客户端**壳自己的**版本（`0.1.1-beta1`），关于页那一行就用它。
    ///
    /// ⚠️★ 为什么是 `package_info()` 而不是 `env!("CARGO_PKG_VERSION")` ——
    /// 这两个在**发布时**会不一致，而且差得刚好是这个字段的意义：
    /// 发版时把 tag 里的版本注进构建，走的是 `tauri build --config …`
    ///（`release.yml` 的 desktop job；它的值由 `tools/release-version.mjs` 算），
    /// 它覆盖的是 **Tauri 的配置版本**，**一个字都不动 `Cargo.toml`**。
    /// 于是用 cargo 那个常量的话，界面上会印着仓库里那份兜底的 `0.1.0`，
    /// 而用户手里那个包装的其实是 `0.1.1-beta1` —— 正是这个项目最忌讳的
    /// 「两处各说各话，且看起来一样正常」。
    ///
    /// ⚠️ 与「本地服务端」那一页的「版本」（[`ServerStatusView::version`]，问的是
    /// 那个二进制自己 `-v`）是**两件事**，别合并：一个是客户端壳的版本、一个是内嵌服务端的。
    /// 界面稿那张卡上的「版本」指的是**后者**，这一行是 2026-09-30 补的。
    pub client_version: String,
    pub data_dir: String,
    pub config_path: String,
}

/// 读「设置」窗口要的那一份。
#[tauri::command]
pub fn settings_view(app: tauri::AppHandle, store: State<'_, Arc<Store>>) -> SettingsView {
    let config = store.config();
    let snapshot = store.snapshot();
    SettingsView {
        rooms: config.channels,
        // ⚠️★ 直接给池子本身（`EMOJI_POOL` 是 `[&str; 24]`）—— 不在这里过滤、也不排序：
        // 界面那一格是「照着壳说的一字排开」，顺序也是壳那一份的顺序。
        emoji_pool: clip9_client::EMOJI_POOL.to_vec(),
        enable_text: config.enable_text,
        enable_file: config.enable_file,
        enable_text_download: config.enable_text_download,
        enable_file_download: config.enable_file_download,
        poll_interval_ms: config.poll_interval_ms,
        download_dir: config.download_dir.display().to_string(),
        notify_upload: config.notify_upload,
        notify_download: config.notify_download,
        autostart: crate::autostart::initial_checked(&app),
        hotkey_enabled: config.enable_hotkey,
        // ⚠️ 给界面看的写法由壳算（`hotkeys::display_toggle_window`）——
        // 算法只有一处，否则界面会显示一个已经不生效的键。
        hotkey_toggle_window: crate::hotkeys::display_toggle_window(),
        // ⚠️★ 客户端的版本**问 Tauri 要**（配置版本）—— 不是 `env!("CARGO_PKG_VERSION")`：
        // 发布时那份是 CI 用 `tauri build --config …` 注进来的，只改配置、不改 `Cargo.toml`
        //（字段上那段注释写了为什么）。问 Tauri 要，显示的才是**这个包真正的**版本。
        client_version: app.package_info().version.to_string(),
        data_dir: snapshot.data_dir,
        config_path: snapshot.config_path,
    }
}

// ── 本地服务端 + 它的配置（`dev-docs/specs/desktop-client.md` §3.5.2）──────
//
// ⚠️★ 这几条命令**就是**「配置可视化」的全部网络面 —— 也就是**没有网络面**：
// 它们走 Tauri 的 IPC，不是服务端的一条 HTTP 路由。所以那个「能改密码」的界面
// **本机之外碰不到**，不需要鉴权、也不用担心被反代出去（§3.5.2 ① 那条硬要求
// 是**由构造保证**的，不是靠配置保证的）。

/// 「配置可视化」界面要的那一份：**文件在哪** + 里面的值。
///
/// ⚠️ 路径也要给：界面稿里就写着这一行，而且用户要能自己去开那个文件 ——
/// 「这个界面改的是哪个文件」是他判断「改了没生效」的第一条线索。
#[derive(serde::Serialize)]
pub struct ServerConfigView {
    pub path: String,
    pub value: serde_json::Value,
    /// `text.limit` 能生效的最大值（字节）。
    ///
    /// ⚠️★ 界面**必须**能说出这个数：那个输入框画的是「用户配的值」，
    /// 而值超过它时服务端根本收不到（HTTP 层先拒）—— 不说的话，
    /// 用户看到的是一个**假的**上限（这正是「配了不生效」在界面上的样子）。
    ///
    /// ⚠️ 从 `clip9-core` 拿，不在页面里写死：那样就是「第二份定义」，
    /// 而两份一定会漂（`Cargo.toml` 里那条注释写的就是同一个道理）。
    pub text_limit_max: i64,
}

/// 读服务端的**原始**配置（给那个表单；不认识的键也会原样带出来）。
#[tauri::command]
pub fn server_config(config: State<'_, ServerConfigFile>) -> Result<ServerConfigView, Msg> {
    Ok(ServerConfigView {
        path: config.path().display().to_string(),
        value: config.read()?,
        text_limit_max: clip9_core::config::TEXT_LIMIT_MAX,
    })
}

/// 把表单的改动保存回服务端配置。
///
/// ⚠️★ **保存 ≠ 生效**：服务端的配置是**启动时读一次**的，所以界面上必须说清
/// 「保存后要重启」—— 否则用户会以为改了没生效是坏了。想一步到位的走
/// [`server_restart`]。
#[tauri::command]
pub fn server_config_save(
    config: State<'_, ServerConfigFile>,
    patch: serde_json::Value,
) -> Result<serde_json::Value, Msg> {
    config.patch(&patch)
}

/// 「查看日志」那一页要的：**文件在哪** + 最后一段。
#[derive(serde::Serialize)]
pub struct ServerLogView {
    pub path: String,
    pub text: String,
}

/// 服务端日志的最后一段。
///
/// ⚠️ 只读**尾部**（最多 256KB）：日志会一直长，整份读进来是白花内存，
/// 而用户看的就是最后几行。⚠️ 从中间截断时把**第一行丢掉**（多半是半行）。
///
/// ⚠️ 文件不存在**不是错误**：服务端还没起过就是这样，界面上说「还没有日志」即可 ——
/// 报一句「文件不存在」会让用户以为坏了。
/// ⚠️★ 日志**内容**是数据（不是文案），而这个 `text` 字段就是它 —— 一个字都不翻。
/// 翻的是**读不出来时那一句**，它走命令的 `Err`（[`Msg`]）。
#[tauri::command]
pub fn server_log(path: State<'_, std::path::PathBuf>) -> Result<ServerLogView, Msg> {
    const TAIL_BYTES: u64 = 256 * 1024;
    let view = |text: String| ServerLogView {
        path: path.display().to_string(),
        text,
    };
    let Ok(meta) = std::fs::metadata(path.inner()) else {
        // ⚠️ 日志文件还没生成是**正常状态**（服务端没起过），不是错误：
        // 报一句「文件不存在」会让用户以为坏了。
        return Ok(view(String::new()));
    };
    let mut file = std::fs::File::open(path.inner()).map_err(|reason| {
        Msg::key("logUnreadable")
            .param("path", path.display())
            .param("reason", reason)
    })?;
    let truncated = meta.len() > TAIL_BYTES;
    if truncated {
        use std::io::Seek;
        if file
            .seek(std::io::SeekFrom::End(-(TAIL_BYTES as i64)))
            .is_err()
        {
            return Err(Msg::key("logSeekFailed").param("path", path.display()));
        }
    }
    let mut raw = Vec::new();
    if let Err(reason) = std::io::Read::read_to_end(&mut file, &mut raw) {
        return Err(Msg::key("logReadFailed")
            .param("path", path.display())
            .param("reason", reason));
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    // ⚠️ 截断过的话第一行多半是半行 —— 丢掉，免得用户以为日志写坏了。
    let text = if truncated {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_owned())
            .unwrap_or(text)
    } else {
        text
    };
    Ok(view(text))
}

// ⚠️★ 「这个客户端没有自带服务端」那个键**不再是一个 `const`**（2026-09-28 改的）。
//
// 原来这里写着 `const NO_BUNDLED_SERVER: &str = "noBundledServer";`，四处用它。
// 那个写法看着更 D.R.Y.，但它让这个键**绕过了判据 17 的扫描**：那条检查抠的是
// `Msg::key("…")` 这个**明确的样子**，而一个 `Msg::key(常量)` 抠不出来 ——
// 于是「常量本身打错了一个字母」（`noBundledSever`）会一路绿到界面上才发现。
// 现在三处各写一遍字面量：句子仍然只有一份（`ui/i18n.js` 里按这个键查一次），
// 而**打错字会被判据 17 抓住**。少打几个字换一条会瞎的静态检查，不划算。

/// 「本地服务端」那一块要的**全部**信息 —— ⚠️★ **逐行对着界面稿 2 的 `.win.srv`**
///（`dev-docs/specs/desktop-client-settings-mockup.html` 的「本地服务端」那张卡）。
///
/// 五个值各有各的来源，**没有一个是编的**：
///
/// | 稿子里的行 | 从哪来 |
/// |---|---|
/// | 版本 | **问那个二进制自己**（`clip9-server -v`，见 [`ServerProcess::version`]） |
/// | 监听 | 配置里的 host（`client_host` 把 `0.0.0.0` 换成回环）+ **进程句柄的端口** |
/// | 数据目录 | 客户端数据目录下的 `server/` |
/// | 房间 / 条目 | **问服务端**（`GET /rooms`）—— 它没开「房间列表」时是 `None` |
/// | 运行时长 | **我们起它的那个时刻**（不是我们起的就是 `None`） |
///
/// ⚠️★ 为什么是**一条**命令、而不是让页面自己拼几处：分几条发的话，
/// 页面会在中间某一刻画出**半对**的一行（比如「监听」有了、「房间」还是上一秒的）。
/// 一张卡片的五行本来就该是同一瞬间的快照。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusView {
    /// 有没有自带服务端（找不到那个二进制就是 `false`）。
    pub bundled: bool,
    /// 它现在答不答话（**问出来的**，真的打一条 `GET /server`，不是记的）。
    pub running: bool,
    /// 端口上那个**是不是这个客户端起的**（`ServerProcess::owns_live_child`）。
    ///
    /// ⚠️★ 2026-09-30 加：`running` 只说明「有人在答话」—— 端口上坐着上次没收干净的孤儿、
    /// 或者用户自己跑的服务端时它也是 `true`，而界面上那句「运行中」就成了**假话**。
    /// 少了这一条，`running && !owned` 与「我们自己起的那个在跑」在界面上长得一模一样。
    pub owned: bool,
    /// **最近一次启动为什么没成**（`ServerProcess::last_start_error`）。
    ///
    /// ⚠️ `None` = 最近一次是成功的（或者还没试过）。它给「启动那一拍」的失败
    ///（随客户端启动 / 开机自启）一个**常驻的去处** —— 那一条路上没有「用户点了什么」。
    pub start_error: Option<Msg>,
    /// `0.1.0`。⚠️ 探不出来就是 `None`（界面显示 `—`）。
    pub version: Option<String>,
    /// `127.0.0.1:9502`。⚠️ 稿子里就是 `host:port` 这个形状（**不带协议**）。
    pub listen: Option<String>,
    pub data_dir: String,
    /// 服务端上的房间数。⚠️ `None` = **问不到**（房间列表没开 / 要密码 / 没在跑）。
    pub rooms: Option<usize>,
    /// 那些房间里的条目总数。⚠️ 与 `rooms` 同生同死（一起 `None`）。
    pub entries: Option<u64>,
    /// 它跑了多少秒。`None` = **不是这个客户端起的**（那时不知道，不猜）。
    pub uptime_seconds: Option<u64>,
    /// 「运行方式」：`true` = 随客户端启动，`false` = 连别人的服务端（本机不起）。
    pub local_server: bool,
}

/// 本地服务端的形状：`(host, prefix, tls)` —— **拼地址与拼「监听」那一行共用**。
///
/// ⚠️ host / prefix / 证书**要**从配置读：客户端起服务端时只传了 `-port` / `-data` /
/// `-config`，这几个没传，所以它们真的生效。
/// 配置读不出来时（文件还没生成 / 坏了）用**默认值**兜底：服务端自己读不出来时用的
/// 也是同一份默认值，所以那时「监听所有网卡 + 没前缀」正是它真实的形态。
///
/// ⚠️ 收**路径**而不是 `ServerConfigFile`：这几条命令现在跑在阻塞线程池上
///（见 [`run_server_blocking`]），闭包要 `'static`，而 Tauri 的 `State` 借用不了那么久。
fn local_server_shape(config_path: &Path) -> (String, String, bool) {
    let parsed = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<clip9_core::Config>(&raw).ok())
        .unwrap_or_default();
    let server = &parsed.server;
    // ⚠️ `host` 服务端两种写法都收（字符串 / 数组），拼地址只取第一个。
    let host = match &server.host {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .first()
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    };
    // ⚠️ 两个都非空才是 TLS（只给证书不给私钥，服务端起不来 TLS，那时写 https 反而错）。
    let tls = !server.cert.trim().is_empty() && !server.key.trim().is_empty();
    (host, server.prefix.clone(), tls)
}

/// 本地服务端的**连接地址**（`http://127.0.0.1:9502`，给「打开网页版」用）。
fn local_server_url(server: &ServerProcess, config_path: &Path) -> String {
    let (host, prefix, tls) = local_server_shape(config_path);
    crate::server_process::client_url(&host, server.port(), &prefix, tls)
}

// ── 「这个站点能不能嵌网页」的探测（需求：网页视图跟着当前房间的服务端走）──────
//
// ⚠️★ 背景：以前「网页」那一格拿的是**本机**那一个地址（一个只算本机的命令，
//    2026-09-30 删掉了 —— 见 `main.rs` 里那段注释），所以房间连的是别处时，
//    网页视图照样显示本机的内容。
//    而房间列表里每个房间**各自带一个服务端地址**（`Channel::server`，快照的 `RoomView.server`
//    已经把它给了界面）—— 用户部署在别处的那几台（Docker / OpenWrt / Cloudflare）**自己
//    都带网页版**，只是桌面端从来没指过去。
//
// ⚠️★ 探测**必须**在壳这一侧做：桌面端要把**别人的**服务端嵌进 iframe，而「先问一句它是不是
//    clip9」这件事在页面里做不到 —— 跨源 `fetch` 会被 CORS 挡掉（对方不会给我们
//    `Access-Control-Allow-Origin`）。所以只有壳自己的 HTTP 客户端能问这一句。

/// 探测一个站点有没有**可嵌的网页版**。
///
/// ⚠️ 认的是网页版 `index.html` 里的身份标记（`<meta name="clip9-web" content="N">`，
/// 见 `web-vue3/index.html` 与 `web-vue3/src/host-bridge.js` 的 `HOST_PROTOCOL`）——
/// **那就是「这台有没有可嵌的网页版」的定义**。老版本的服务端没有这一行 → 回
/// `supported: false` → 界面显示「请把服务器更新到 clip9」。
///
/// ⚠️ 走 [`clip9_client::uploader::build_client`]（rustls + **系统信任库**）：
/// 用户自己部署的服务端很可能是自签证书 / 内网 CA，自带的那套根证书认不了它。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteProbeView {
    /// 拿到身份标记了没有。
    pub supported: bool,
    /// 标记里的**协议版本**（`None` = 有标记但那个值不是数）。
    pub protocol: Option<u32>,
    /// 不支持时的**原因键**（支持时是 `None`）。
    ///
    /// ⚠️ 是键不是成文的中文 —— 壳不知道用户选了哪个语种（判据 16 盯着这件事）。
    pub reason: Option<Msg>,
}

/// 探测的超时。
///
/// ⚠️★ 用它而不是那个客户端自己的 30 秒（`uploader::CHANNEL_TIMEOUT_SECS`）：
/// 探测是「切一下就出结论」的事，等 30 秒用户早就不看那一眼了 ——
/// 3 秒还答不上来的站点，对用户来说和「连不上」是同一件事。
const PROBE_SITE_TIMEOUT: Duration = Duration::from_secs(3);

/// 探测那个站点是不是 clip9 的网页版（界面据此决定嵌不嵌）。
#[tauri::command]
pub async fn probe_site(base: String) -> SiteProbeView {
    // ⚠️★ 三个原因**各写一个闭包、每个都把键写全**（`Msg::key("…")`），不图省事写成
    //    一个 `failed(key: &str)` —— 判据 17 抠的就是那个字面量形态，**参数化的调用点
    //    它抠不到**，于是「键打错一个字母」会一路绿到界面上（用户看到的是 `spaProbeUnreachble`
    //    这种键名本身）。`commands.rs` 抬头那段注释写的就是这条规矩。
    let bad_address = || SiteProbeView {
        supported: false,
        protocol: None,
        reason: Some(Msg::key("spaProbeBadAddress")),
    };
    let unreachable = || SiteProbeView {
        supported: false,
        protocol: None,
        reason: Some(Msg::key("spaProbeUnreachable")),
    };
    let not_clip9 = || SiteProbeView {
        supported: false,
        protocol: None,
        reason: Some(Msg::key("spaProbeNotClip9")),
    };

    let Some(url) = site_root(&base) else {
        return bad_address();
    };
    let Ok(client) = clip9_client::uploader::build_client() else {
        // 连 HTTP 客户端都建不起来（TLS 后端初始化失败这类）—— 对界面来说与连不上同类。
        return unreachable();
    };
    let Ok(response) = client.get(&url).timeout(PROBE_SITE_TIMEOUT).send().await else {
        return unreachable();
    };
    // ⚠️ 非 2xx 一律算「答了，但不是 clip9」：那台机器活着，只是这个地址上没有我们的网页版
    //（反代配错、路径写错、别的应用占了那个端口 —— 都落在这一类）。
    if !response.status().is_success() {
        return not_clip9();
    }
    let Ok(html) = response.text().await else {
        return unreachable();
    };

    match clip9_web_mark(&html) {
        Some(protocol) => SiteProbeView {
            supported: true,
            protocol,
            reason: None,
        },
        None => not_clip9(),
    }
}

/// 把配置里那份地址变成「网页版的根」：补一个尾斜杠。
///
/// ⚠️★ 校验直接复用 [`openable_url`]（它已经定好了「什么样的地址能交给外部」：只放行
/// `http(s)`、去空白、去尾斜杠）—— 再写一份 `starts_with("http://")` 就是**第二份定义**，
/// 两份迟早会漂（那边哪天加一个白名单项，这里就漏了）。
/// ⚠️ 配置里那一格是**自由文本**，而结果会被塞进 `iframe.src`，所以这道闸必须有。
fn site_root(base: &str) -> Option<String> {
    let base = openable_url(base).ok()?;
    Some(format!("{base}/"))
}

/// 从网页版的 HTML 里读身份标记。
///
/// 返回三层意思：
/// * `None` —— 整篇里**没有**那个 meta（= 不是 clip9 的网页版，或版本太老）；
/// * `Some(None)` —— 有那个 meta，但 `content` 不是数（协议号读不出，**仍算支持**）；
/// * `Some(Some(n))` —— 有，且协议号是 `n`。
///
/// ⚠️ 手写而不是上正则：形状固定（一个 `<meta>` 标签），而 `desktop` 这一侧没有 `regex`
/// 依赖 —— 为一句话加一个依赖不划算。
/// ⚠️★ 判据是「**标签内部**有 `name="clip9-web"`」，不是「整篇里有 `clip9-web` 这几个字」：
/// 后者会被页面上随便一句提到它的文字满足（而那种「看起来通过、其实没通过」的判据，
/// 这个项目已经为它付过几次代价）。
fn clip9_web_mark(html: &str) -> Option<Option<u32>> {
    // ⚠️ 属性名不区分大小写，所以比较用小写副本；⚠️ 但**取 content 的值要从原文取**
    //（免得把用户可见的东西改掉大小写 —— 这里读的是数字，但那不是因为数字就无所谓）。
    let lower = html.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(offset) = lower[from..].find("<meta") {
        let start = from + offset;
        let Some(close) = lower[start..].find('>') else {
            break;
        };
        let end = start + close;
        let tag_lower = &lower[start..end];
        if tag_lower.contains("name=\"clip9-web\"") || tag_lower.contains("name='clip9-web'") {
            return Some(content_number(&html[start..end]));
        }
        from = end + 1;
    }
    None
}

/// 从一个 `<meta>` 标签的原文里取出 `content="…"` 并解析成数字。
fn content_number(tag: &str) -> Option<u32> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find("content=")? + "content=".len();
    let rest = &tag[at..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = rest[1..].split(quote).next()?;
    value.trim().parse().ok()
}

/// 把一次**阻塞**的起 / 停丢进线程池，等它回来。
///
/// ⚠️★ 为什么必须这样：起服务端最多要等 `START_TIMEOUT`（**15 秒**）。
/// 同步命令会把界面**整个卡住** —— Jonny 2026-09-26 报的
/// 「**点保存并重启就卡死**」就是这个：窗口十几秒不响应。
/// 丢进 `spawn_blocking` 之后，等待发生在别的线程上，界面照常能动。
///
/// ⚠️★ `label` 收的是**一句 `Msg`** 而不是一个 `&str` 键（2026-09-28 改的）：
/// 收裸字符串的话，调用点会写 `run_server_blocking("serverStop", …)` ——
/// 那个键**拐了一道弯**，判据 17（抠 `Msg::key("…")` 那个形态）就抠不到它，
/// 打错字会一路绿到界面上印出 `serverStoped` 才发现。
/// 收 `Msg` 之后调用点变成 `Msg::key("serverStop")`，形状统一、扫得到。
async fn run_server_blocking(
    label: Msg,
    work: impl FnOnce() -> Result<(), Msg> + Send + 'static,
) -> Result<(), Msg> {
    // ⚠️★ 里面那趟活儿自己的失败**原样上去**（不裹一层）—— 它已经是成句的 `Msg`
    //（「这个端口上有一个服务端在跑，但不是这个客户端起的」那种）。
    // 这一层只管**线程池**本身的失败（任务 panic 了）。
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|reason| {
            Msg::key("serverTaskFailed")
                .param_msg("label", label)
                .param("reason", reason)
        })?
}

/// `server_status` 里**阻塞的那一半**：读文件、起一次进程问版本、连本机问 `/rooms`。
///
/// ⚠️ 抽出来是为了能整段丢进 [`run_server_blocking`] 那种线程池 ——
/// 这几件事全是同步的，而 `server_status` 是 `async`。
fn server_status_now(
    local_server: bool,
    data_dir: String,
    process: Option<Arc<ServerProcess>>,
    config_path: &Path,
) -> ServerStatusView {
    // ⚠️ 没有自带服务端（找不到二进制）：地址 / 版本 / 时长**一律 `None`** ——
    // 我们连它会在哪个端口上都不知道，编一个比空着坏。
    let Some(process) = process else {
        return ServerStatusView {
            bundled: false,
            running: false,
            owned: false,
            start_error: None,
            version: None,
            listen: None,
            data_dir,
            rooms: None,
            entries: None,
            uptime_seconds: None,
            local_server,
        };
    };
    let running = process.is_running();
    let (host, _, _) = local_server_shape(config_path);
    // ⚠️ 没在跑就别去问 `/rooms`（那会白等一个连接超时），直接 `None`。
    let summary = if running {
        crate::server_process::room_summary(process.port())
    } else {
        None
    };
    ServerStatusView {
        bundled: true,
        running,
        owned: process.owns_live_child(),
        start_error: process.last_start_error(),
        version: process.version(),
        listen: Some(format!(
            "{}:{}",
            crate::server_process::client_host(&host),
            process.port()
        )),
        data_dir,
        rooms: summary.map(|(rooms, _)| rooms),
        entries: summary.map(|(_, entries)| entries),
        uptime_seconds: process.uptime().map(|uptime| uptime.as_secs()),
        local_server,
    }
}

/// 本地服务端的状态（状态灯 / 五行数据 / 起停按钮都读它）。
///
/// ⚠️ `async` 的理由见 [`run_server_blocking`]：这一条要读文件、起一次进程问版本、
/// 还要连本机问 `/rooms`（最多 800ms 超时）—— 全是阻塞的。
#[tauri::command]
pub async fn server_status(
    store: State<'_, Arc<Store>>,
    server: State<'_, Option<Arc<ServerProcess>>>,
    config: State<'_, ServerConfigFile>,
) -> Result<ServerStatusView, Msg> {
    let local_server = store.config().enable_local_server;
    let data_dir =
        crate::server_process::data_dir_under(std::path::Path::new(&store.snapshot().data_dir))
            .display()
            .to_string();
    let process = server.as_ref().cloned();
    let config_path = config.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        server_status_now(local_server, data_dir, process, &config_path)
    })
    .await
    .map_err(|reason| Msg::key("serverStatusTaskFailed").param("reason", reason))
}

/// 换「运行方式」（界面稿里那两选一）：`true` = 随客户端启动，`false` = 本机不起。
///
/// ⚠️★ **它不只是改一个配置**：选了「本机不起」就要**真的把它停掉**，
/// 选了「随客户端启动」就要**真的把它起起来**。只改配置的话，用户点完看到的是
/// 「模式换了、服务端照旧在跑」—— 那就是「配了不生效」。
///
/// ⚠️ 顺序有讲究：**先停（可能失败）再改配置** —— 反过来的话，停失败会留下
/// 「配置说不起了、实际还在跑」这个更难解释的状态。
#[tauri::command]
pub async fn set_local_server(
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    server: State<'_, Option<Arc<ServerProcess>>>,
    on: bool,
) -> Result<(), Msg> {
    let process = server.as_ref().cloned();
    if !on && let Some(process) = process.clone() {
        run_server_blocking(Msg::key("serverStop"), move || process.stop()).await?;
    }
    store.set_local_server(on);
    runtime.persist();
    // ⚠️ 切回「随客户端启动」时**顺手把它起起来**：不起的话，用户点完看到的是
    // 「模式选好了、服务端还是没在跑」，还得再去点一次别的地方 —— 而界面稿里
    // 这一页**没有「启动」按钮**（只有重启 / 停止）。所以这一下就是那个「启动」。
    if on && let Some(process) = process {
        run_server_blocking(Msg::key("serverStart"), move || process.start()).await?;
    }
    Ok(())
}

/// 停本地服务端。
///
/// ⚠️ 只停**这个客户端起的那个**：用户在别处自己跑的那个不动 ——
/// [`ServerProcess::stop`] 会**拒绝并说清为什么**（那个可能正连着他的手机）。
/// 那条拒绝原样给界面看，不在这里改写。
#[tauri::command]
pub async fn server_stop(server: State<'_, Option<Arc<ServerProcess>>>) -> Result<(), Msg> {
    let Some(server) = server.as_ref().cloned() else {
        return Err(Msg::key("noBundledServer"));
    };
    run_server_blocking(Msg::key("serverStop"), move || server.stop()).await
}

/// 重启本地服务端（「保存并重启」那条路）。
///
/// ⚠️ 只在**自带服务端**时做得到：找不到二进制就**报错**，
/// 而不是画一个点了没反应的按钮（§3.5.2 ② 第 3 条）。
#[tauri::command]
pub async fn server_restart(server: State<'_, Option<Arc<ServerProcess>>>) -> Result<(), Msg> {
    let Some(server) = server.as_ref().cloned() else {
        return Err(Msg::key("noBundledServer"));
    };
    run_server_blocking(Msg::key("serverRestart"), move || {
        server.stop()?;
        server.start()
    })
    .await
}

/// 界面上要渲染的那一份状态。
///
/// ⚠️ 一次给**全**的：页面要能自己判断「有没有房间」「当前选的是哪个」，
/// 分几次取就得处理「取到一半的状态」—— 而半份状态画出来的界面是骗人的。
#[tauri::command]
pub fn snapshot(store: State<'_, Arc<Store>>) -> Snapshot {
    store.snapshot()
}

/// 提示已经被看过了（清掉，免得一直挂在界面上）。
#[tauri::command]
pub fn clear_notice(store: State<'_, Arc<Store>>) {
    store.clear_notice();
}

/// 切房间，并**顺带取一次历史**。
///
/// ⚠️ 为什么切房间就要取：下行的历史只覆盖**下载通道那一个房间**（`spawn_receiver`
/// 只连它），而界面可以选中任何一个 —— 不取的话，切过去的房间是一个**空列表**，
/// 而用户分不出「这个房间确实是空的」与「还没加载」。
#[tauri::command]
pub fn select(
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    index: usize,
) -> Result<(), Msg> {
    store.select(index)?;
    // ⚠️ `ByUser`：切房间是用户动作 —— 上一次取历史失败过也再试一次
    //（这也正是界面上那条「点一下这个房间再试一次」的路）。
    runtime.refresh_history(Ask::ByUser);
    Ok(())
}

/// 上行开关（**可以多个房间同时开**，§4.1 第 1 条）。
///
/// ⚠️★ 它**同时决定监听线程的生死**（2026-09-27 用户定的）：↑ 全关 = 没人要本机
/// 剪贴板 → 那个轮询线程**停掉**；开一个就起回来。所以这里必须跟着调
/// [`Runtime::sync_watcher`] —— 少了这一步，界面上关了 ↑ 而线程照旧在每
/// `poll_interval_ms` 读一次剪贴板，**而且没有任何提示**。
///
/// ⚠️ 为什么这件事挂在 ↑ 上而不是一个独立的开关：那个开关（`enable_monitoring`）
/// 2026-09-26 已经被删了 —— 于是「要不要读本机剪贴板」只能由「有没有人收」反推。
#[tauri::command]
pub fn set_upload(
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    index: usize,
    on: bool,
) -> Result<(), Msg> {
    store.set_upload(index, on)?;
    runtime.sync_watcher();
    runtime.persist();
    Ok(())
}

/// 下行开关（**全局只能一个**）：给了别的房间就自动关掉前一个（§4.1 第 4 条）。
///
/// ⚠️★ 它**只管「要不要把这个房间的内容写进本机剪贴板」**，与「连不连」无关 ——
/// 每个房间**一直**有一条连接（§4.7）。Jonny 2026-09-26：
/// 「下载本就不应该控制房间的任何功能」。
///
/// ⚠️ 仍然要重启下行：连接任务拿的是**一份配置快照**，里面记着每个房间的 ↓，
/// 不重起任务的话，界面上开关变了、实际写的还是老配置。
/// 而「界面上变了、实际没变」正是这个项目最忌讳的一类。
#[tauri::command]
pub fn set_download(
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    index: Option<usize>,
) -> Result<(), Msg> {
    store.set_download(index)?;
    runtime.persist();
    runtime.restart_receiver();
    // ⚠️ `ByUser`：改下载方式是一大步（连接会重启）—— 之前失败过的那个标记不该挡着它。
    runtime.refresh_history(Ask::ByUser);
    Ok(())
}

/// 界面上「发一条」—— 走**和剪贴板完全一样**的那条上行（`clip9-client` 的那一条）。
///
/// ⚠️ 页面**不能**自己 `fetch` 服务端：那会有**第二条上行路径**，
/// 「限额从哪来」「凭据怎么带」这些规则就要各写一遍 —— 而它们已经写在 `clip9-client` 里了。
#[tauri::command]
pub fn send_text(runtime: State<'_, Arc<Runtime>>, text: String) {
    runtime.send_text(&text);
}

/// 刷新历史（`GET /content`，不碰剪贴板）。
///
/// ⚠️★ 调用者只有界面那条**自动重试**（`ensureHistory`，每 5 秒一次，见 `ui/app.js`）——
/// 所以走 `Ask::Auto`：上一次就失败过的话**不再打服务端、也不再提示**
///（Jonny 2026-09-30 报的「连不上还每 5 秒取一次」）。用户想要再试，点一下那个房间
/// 就够了（走的是 `select` 那条 `ByUser`）。
#[tauri::command]
pub fn refresh(runtime: State<'_, Arc<Runtime>>) {
    runtime.refresh_history(Ask::Auto);
}

/// 「复制内容」（时间线的右键菜单，§4.4）。
///
/// ⚠️★ 为什么这条在壳里而不是页面里：**webview 碰不到系统剪贴板**
///（`ui/app.js` 开头那段注释就是为这件事写的）。页面能用的
/// `navigator.clipboard` 在 `tauri://localhost` 这种非安全上下文里也不保证可用，
/// 而壳这边本来就有 `clip9-client` 的 `SystemClipboard`。
///
/// ⚠️ 写下去之前会先 `prime` 去重指纹（见 `Runtime::copy_to_clipboard`）——
/// 不 prime 的话监控线程会把它当成一次新复制、又发回房间。
#[tauri::command]
pub fn copy_to_clipboard(runtime: State<'_, Arc<Runtime>>, text: String) {
    runtime.copy_to_clipboard(&text);
}

/// 一条条目的**全文**（界面「展开」用）。
///
/// ⚠️★ 存在的理由：快照里只有**截断预览**（2026-09-27 拍板「快照只带截断预览、正文按需取」），
/// 所以「展开一条长文」必须回来取一次。⚠️ 只认**当前选中**那个房间（id 跨房间不唯一）。
///
/// ⚠️ 报错文案要提**最可能的那两个原因**：换了房间、或者它被本机那道**字节界**挤出去了
/// （`store::MAX_BYTES_PER_ROOM`，2026-09-27 加的）—— 后者是**长文自己最容易被挤掉**，
/// 而「长文被挤掉之后点展开」正是这条命令最容易遇到的场景。只说「不在列表里」，
/// 用户会以为是我们坏了。
#[tauri::command]
pub fn entry_text(store: State<'_, Arc<Store>>, id: i32) -> Result<String, Msg> {
    store.entry_text(id).ok_or_else(|| Msg::key("entryGone"))
}

/// 「复制内容」（时间线右键菜单）—— ⚠️ 走壳，**不让页面把自己那份传回来**。
///
/// ⚠️ 页面手里那份是**预览**：传回来会把长文复制成截断的，而且不报错。
/// 详见 `Runtime::copy_entry`（顺带省掉一整趟 IPC）。
#[tauri::command]
pub fn copy_entry(runtime: State<'_, Arc<Runtime>>, id: i32) {
    runtime.copy_entry(id);
}

/// 「删除这一条」（卡片上那颗 🗑）—— 走服务端 `POST /revoke/<id>`。
///
/// ⚠️★ 它是**真删**、不是本地抹掉：房间里那些内容是所有人共享的，本地抹掉只会在下一次
/// 取历史时原样回来（假删除）。所以界面**必须先问一句**再调它 —— 那是界面的事，
/// 见 `ui/app.js` 里那颗按钮旁边那段注释。
///
/// ⚠️ 失败的三种情形各有自己的话（不是一句「失败」）：这条已经不在了 / 房间密码不对 /
/// 服务端回了别的码。分类在 [`Runtime::delete_entry`] 与 `http_status` 里。
#[tauri::command]
pub async fn delete_entry(runtime: State<'_, Arc<Runtime>>, id: i32) -> Result<(), Msg> {
    runtime.delete_entry(id).await
}

/// 「分享这一条」（卡片上那颗 ↗）—— 让服务端签发一条分享链接，**并把它复制进剪贴板**。
///
/// 返回值就是那串地址：界面拿它做提示（「已复制 + 地址」，以及「没设密码，别贴公开地方」那句）。
///
/// ⚠️★ 复制**在壳里做**（[`Runtime::share_entry`] 里那次 `copy_to_clipboard`），不是因为方便：
/// 页面碰不到系统剪贴板，而且走壳会**先 prime 去重指纹** —— 否则监控线程会把这一行当成
/// 一次新的复制、又发回房间（用户只是想分享一条，结果房间里多出一条他自己发的链接）。
#[tauri::command]
pub async fn share_entry(runtime: State<'_, Arc<Runtime>>, id: i32) -> Result<String, Msg> {
    runtime.share_entry(id).await
}

/// 弹一个**系统文件选择框**，把选中的路径还给页面。
///
/// ⚠️★ 为什么这条命令在 Rust 侧而不在页面上：Tauri 2 的插件 JS API 是一个 npm 包
///（`@tauri-apps/plugin-dialog`），而这份界面是**手写的、没有构建步骤**
///（`tauri.conf.json` 的 `frontendDist` 直接指向 `ui/`）。
/// 引一个打包器只为弹一个对话框不划算，而且会破坏「页面只跟 IPC 命令说话」这条纪律。
///
/// ⚠️★ `blocking_pick_files` **不能在主线程上调**（Tauri 会 panic）。这里用的是
/// **回调式**的 `pick_files`（它自己不阻塞），再用一条 oneshot 把它等回来 ——
/// 所以它必须是一个 `async` 命令（`async fn` 跑在 tokio 的线程池上，不在主线程）。
///
/// ⚠️ 取消（用户按了「取消」/ 直接关掉）**不是错误**：返回一个空数组，
/// 页面什么都不做。报一句「取消失败」是这类界面里最烦人的一种假错误。
/// ⚠️★ 对话框的标题与过滤器名是**操作系统画的**（和系统通知、托盘菜单同一类）——
/// 页面渲染不了它们，所以这里要一份 [`ShellText`] 自己查表。
#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle, images_only: bool) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;

    // ⚠️★ 字典从 `app` 上取，**不走命令参数**：Tauri 要求「async 命令里带引用型入参」
    // 必须返回 `Result`（`AsyncCommandMustReturnResult`），而这一条**没有任何真正的失败路径**
    //（取消不是错误 —— 见函数头）。为了满足那个宏而编一个 `Err` 分支，
    // 比多写一行 `app.state()` 坏得多。
    let shell = app.state::<Arc<ShellText>>();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let title = if images_only {
        shell.say(&Msg::key("pickImagesTitle"))
    } else {
        shell.say(&Msg::key("pickFilesTitle"))
    };
    let mut builder = app.dialog().file().set_title(title);
    if images_only {
        // ⚠️ 过滤只是**方便**，不是保证：用户能把过滤器切到「所有文件」。
        // 真正的判断在 `clip9-client` 那边（图片按文件那条路上行，见 `UploadKind`），
        // 所以这里不必（也不该）再判一次。
        builder = builder.add_filter(
            shell.say(&Msg::key("imageFilterName")),
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"],
        );
    }
    builder.pick_files(move |paths| {
        // ⚠️ 接收端可能已经走了（窗口关了）—— `send` 失败就丢掉，不要 panic。
        let _ = tx.send(paths.unwrap_or_default());
    });

    rx.await
        .unwrap_or_default()
        .into_iter()
        // ⚠️ 只要**本地路径**：`FilePath` 也可能是 URL（移动端 / 云盘），
        // 而上行只认本地文件（`ClipboardContent::Files` 的注释写着「绝对路径」）。
        .filter_map(|path| path.into_path().ok())
        .map(|path| path.display().to_string())
        .collect()
}

/// 把一批**本地文件**发到房间（输入区的 📎 / 🖼、拖进来、粘贴进来的都走这条）。
///
/// ⚠️★ 走**和剪贴板完全一样**的那条上行（`Runtime::send_files` → `upload_event`）：
/// 「限额从哪来」「凭据怎么带」「多文件怎么办」这些规则都已经写在 `clip9-client` 里，
/// 这里再写一遍就是**第二套规则**。
///
/// ⚠️ 路径**不在这里校验**：不存在的文件由 `upload_event` 报出来（它会带着文件名说
/// 「跳过」，见 `UploadReport::summary`）—— 在这里先判一次会让两处的说法不一致。
#[tauri::command]
pub fn send_files(runtime: State<'_, Arc<Runtime>>, paths: Vec<String>) {
    runtime.send_files(&paths);
}
/// 「用**系统浏览器**打开网页版」（§3.5.1 那条硬要求：分享链接、密码管理器、书签、
/// 五种模式都在浏览器里；塞进 webview 会让桌面端变成「带壳的浏览器」）。
///
/// ⚠️ 为什么自己 `Command` 而不用 `tauri-plugin-opener`：为一个「打开网页」引入整个
/// 插件不划算（它的 API 还会随版本变，而那是**最容易漂**的地方）。系统自带的
/// `open` / `start` / `xdg-open` 二十年来没变过。
#[tauri::command]
pub async fn open_web(
    server: State<'_, Option<Arc<ServerProcess>>>,
    config: State<'_, ServerConfigFile>,
) -> Result<(), Msg> {
    let Some(server) = server.as_ref().cloned() else {
        return Err(Msg::key("noBundledServer"));
    };
    let config_path = config.path().to_path_buf();
    // ⚠️ 也丢进线程池：探测（最多 800ms）+ 起 `open` 进程都是阻塞的，
    // 而这是一次点击 —— 点了之后窗口不该僵住。
    tauri::async_runtime::spawn_blocking(move || {
        // ⚠️★ 打开的是**本机自带那个服务端**，不是「当前选中房间的服务端」。
        // 这个按钮长在「本地服务端」那一页上（`ui/index.html` 里只有这一处），
        // 所以它问的就是「这一份服务端的网页版」。原来用的是选中房间的地址 ——
        // 房间里填着别人的服务端时，点它会打开**别人**的网页版，与按钮所在的位置对不上。
        if !server.is_running() {
            // ⚠️ 说清**怎么办**：这一页上没有「启动」按钮（界面稿里只有重启 / 停止），
            // 所以回去的路是下面那两选一。
            return Err(Msg::key("localServerNotRunning"));
        }
        let url = openable_url(&local_server_url(&server, &config_path))?;
        open_in_system_browser(&url)
    })
    .await
    .map_err(|reason| Msg::key("openWebTaskFailed").param("reason", reason))?
}

/// 打开 clip9 的项目主页 —— 「你这个站点的网页版太老了，去更新」那个按钮。
///
/// ⚠️★ 刻意**不从页面收 URL**：收了就等于给页面一个「用系统浏览器打开任意地址」的能力，
/// 而这里要的只有一个固定地址。哪天要能开别处，就再加一条**同样窄**的命令，
/// 别把它改成一个通用的 `open_url`。
///
/// ⚠️ 地址是写死的，但**仍然过一遍** [`openable_url`]：那条规矩是「交给系统 opener 之前的
/// 最后一道闸」—— 因为「这次是常量」而破例，破掉的就是下次漏掉的那次。
#[tauri::command]
pub async fn open_project_page() -> Result<(), Msg> {
    const PROJECT: &str = "https://github.com/Jonnyan404/clip9";
    let url = openable_url(PROJECT)?;
    // ⚠️ 与 `open_web` 同一条理由丢进线程池：起那个 opener 进程是阻塞的，而这是一次点击。
    tauri::async_runtime::spawn_blocking(move || open_in_system_browser(&url))
        .await
        .map_err(|reason| Msg::key("openWebTaskFailed").param("reason", reason))?
}

/// 交给系统 opener 之前的**最后一道**校验：只放行 `http(s)`。
///
/// ⚠️ 地址现在是**我们自己拼的**（[`local_server_url`]，协议由证书决定），
/// 所以这一步在正常路径上是恒真的。留着它，是因为**下一个改这里的人**不一定知道
/// 那个不变量：这个字符串最后交给 `open`（macOS）/ `start`（Windows），
/// 而它们会把它当 URL 解释 —— `file://` / `javascript:` 进来就是另一类事了。
/// 一行校验，比一条「记得只拼 http」的口头约定靠得住。
/// ⚠️★ 现在它**也**给用户手填的那一格当闸（[`site_root`]），所以它比上面那段描述更严了：
/// 那一路进来的东西是自由文本，不是我们自己拼的。
fn openable_url(url: &str) -> Result<String, Msg> {
    // ⚠️★ 归一化走 `clip9_client::normalize_server`（**唯一**一份：去首尾空白、去尾部 `/`、
    //    scheme 折小写），这里**不再自己判大小写**。
    //    2026-09-30 现场踩到：这里原来写的是 `trimmed.starts_with("https://")` ——
    //    大小写敏感，于是用户配的 `Https://ccg.ubuy.fun`（那台**连得上也带网页版**）
    //    被判成「不是 http(s)」。而连接那边一直好着，因为 `reqwest` 走的 `url` crate
    //    会把 scheme 归一成小写 —— 同一个地址，两处两个判据，用户看到的是后者的报错。
    let normalized = clip9_client::normalize_server(url);
    if normalized.is_empty() {
        return Err(Msg::key("serverUrlEmpty"));
    }
    // ⚠️ 归一化之后 scheme 一定是小写，所以这里直接比就够 —— 别再写第二份大小写判断。
    if !(normalized.starts_with("http://") || normalized.starts_with("https://")) {
        return Err(Msg::key("serverUrlNotHttp").param("url", url.trim()));
    }
    Ok(normalized)
}

/// 交给系统自带的 opener。
///
/// ⚠️ 参数**逐个传**（不拼成一条命令字符串）：拼字符串 = 过一遍 shell，
/// 而这里的地址来自用户的配置文件。
fn open_in_system_browser(url: &str) -> Result<(), Msg> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        // ⚠️ `start` 把第一个引号当成窗口标题，所以要给一个空标题占位。
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn().map(|_| ()).map_err(|reason| {
        Msg::key("openBrowserFailed")
            .param("url", url)
            .param("reason", reason)
    })
}

/// 页面把字典推过来 —— **壳自己要说的那几句话**（系统通知、托盘菜单、文件对话框标题）。
///
/// ⚠️★ 为什么是「推」而不是壳自己去读 `ui/i18n.js`：那是 JS，壳读不了
///（理由与取舍见 [`crate::shell_text`] 的模块文档）。页面在**启动时**推一次、
/// **每次换语种**再推一次 —— 所以这里顺带把托盘菜单重建一遍。
///
/// ⚠️ 字典**整份**过来（两种语种都在里面）：壳那边三级回落的第二级要用源语言那一份。
#[tauri::command]
pub fn set_shell_messages(
    app: tauri::AppHandle,
    shell: State<'_, Arc<ShellText>>,
    locale: String,
    dicts: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
) {
    shell.set(&locale, dicts);
    // ⚠️ 托盘那几项的语言**跟着这里变**：菜单是建出来的一棵固定树，
    // 不重建的话它永远停在启动时那一份（页面起来之前 = 源语言）。
    crate::tray::retranslate(&app, &shell);
}

#[cfg(test)]
mod tests {
    use super::{clip9_web_mark, openable_url, site_root};

    /// ⚠️ 只放行 `http(s)` —— 这个字符串最后要交给 shell 解释的 opener，
    /// `file://` / `javascript:` 进来就是另一类事了。
    #[test]
    fn only_http_urls_can_be_opened() {
        assert_eq!(
            openable_url("http://127.0.0.1:9502/").unwrap(),
            "http://127.0.0.1:9502"
        );
        assert_eq!(
            openable_url("  https://host/clip/  ").unwrap(),
            "https://host/clip"
        );
        // ⚠️★ scheme 大小写不敏感（RFC 3986），而且返回的是**归一化过的**那一份。
        //    2026-09-30 现场踩到：用户房间里写的是 `Https://ccg.ubuy.fun` ——
        //    那台**连得上、也带网页版**，却因为一句大小写敏感的 `starts_with` 被判成
        //    「不是 http(s)」，界面于是说「这个房间的服务端地址不是 http(s)，没法嵌网页」。
        assert_eq!(
            openable_url("Https://ccg.ubuy.fun").unwrap(),
            "https://ccg.ubuy.fun"
        );
        assert_eq!(openable_url("HTTP://host").unwrap(), "http://host");
        // ⚠️ 只动 scheme 那一段：**主机名与路径的大小写是有意义的**（`/A` 与 `/a` 两个地址）
        assert_eq!(
            openable_url("HTTPS://Host.Example/Clip9").unwrap(),
            "https://Host.Example/Clip9"
        );
        for bad in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "127.0.0.1:9502",
            // ⚠️ 光有 scheme、没有主机名还不算地址。⚠️ 这两条是**顺序**的回归钉子：
            //    「先削尾斜杠、再判 scheme」的话 `http://` 会变成 `http:` 而被放行。
            "http://",
            "https:///",
        ] {
            assert!(openable_url(bad).is_err(), "{bad:?} 不该被放行");
        }
    }

    /// ⚠️★ 判据是「**那个 meta 标签内部**有 `name="clip9-web"`」——
    /// 整篇里出现 `clip9-web` 这几个字**不算**（最后那几条反例就是为这件事写的：
    /// 网页上随便一句提到标记名的正文，不该让探测通过）。
    #[test]
    fn the_web_ui_mark_must_be_a_meta_tag() {
        // 正例：真标记，顺带把协议号读出来
        assert_eq!(
            clip9_web_mark(
                r#"<head><meta name="clip9-web" content="1"><title>clip9</title></head>"#
            ),
            Some(Some(1))
        );
        // 属性顺序反了 / 单引号 / 大小写不一 —— HTML 都不区分，这里也不该区分
        assert_eq!(
            clip9_web_mark("<meta content='2' NAME='Clip9-Web'>"),
            Some(Some(2))
        );
        // 标记在、但协议号读不出 → **仍算支持**，只是没有版本号
        assert_eq!(
            clip9_web_mark(r#"<meta name="clip9-web" content="abc">"#),
            Some(None)
        );
        // ⚠️ 反例：这三个里都有 `clip9-web` 那几个字，但都不是我们的标记
        assert_eq!(
            clip9_web_mark("<p>see the clip9-web marker for details</p>"),
            None
        );
        assert_eq!(
            clip9_web_mark(r#"<meta name="other" content="clip9-web">"#),
            None
        );
        // 没有标记（= 老版本的服务端 / 别的应用）
        assert_eq!(clip9_web_mark("<html><body>hello</body></html>"), None);
        assert_eq!(clip9_web_mark(""), None);
    }

    /// 只放行 `http(s)`（复用 `openable_url` 的规矩），并补一个尾斜杠。
    ///
    /// ⚠️ 尾斜杠不是装饰：`https://host/clip9` 少了它，反代那一层会把根路径与子路径分开
    ///（有的反代对 `/clip9` 与 `/clip9/` 行为不同），而我们要的是**网页版的根**。
    #[test]
    fn the_site_root_needs_a_scheme_and_gets_a_slash() {
        assert_eq!(
            site_root("http://127.0.0.1:9502").unwrap(),
            "http://127.0.0.1:9502/"
        );
        // 已经带了的别加成两个
        assert_eq!(
            site_root("https://host/clip9/").unwrap(),
            "https://host/clip9/"
        );
        // ⚠️★ 用户手填那一格的**真实形状**（大小写随手打的）。这条是 2026-09-30 那个 bug 的
        //    回归钉子：「房间连得上」与「地址合法」是两个判据，而这里只该管后者。
        assert_eq!(
            site_root("Https://ccg.ubuy.fun").unwrap(),
            "https://ccg.ubuy.fun/"
        );
        for bad in [
            "",
            "   ",
            "file:///tmp/x",
            "javascript:alert(1)",
            "host/clip9",
        ] {
            assert!(site_root(bad).is_none(), "{bad:?} 不该被嵌");
        }
    }
}
