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

use std::sync::Arc;

use tauri::State;

use crate::runtime::Runtime;
use crate::server_config::ServerConfigFile;
use crate::server_process::ServerProcess;
use crate::store::{Snapshot, Store};

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
}

/// 保存「设置」窗口。
#[tauri::command]
pub fn apply_settings(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    patch: SettingsPatch,
) -> Result<(), String> {
    if let Some(rooms) = patch.rooms {
        store.set_rooms(rooms)?;
        // ⚠️ 房间清单变了 → **下行必须重连**：`spawn_receiver` 拿的是启动时那份
        // 配置的副本（`set_download` 那条命令的注释里写着同一件事）。
        runtime.restart_receiver();
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
    pub rooms: Vec<clip9_client::Channel>,
    pub enable_text: bool,
    pub enable_file: bool,
    pub enable_text_download: bool,
    pub enable_file_download: bool,
    pub poll_interval_ms: u64,
    pub download_dir: String,
    /// ⚠️ **系统里的真相**（启动项在不在），不是配置里的意图。
    pub autostart: bool,
    pub data_dir: String,
    pub config_path: String,
    pub server_running: bool,
}

/// 读「设置」窗口要的那一份。
#[tauri::command]
pub fn settings_view(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    server: State<'_, Option<Arc<ServerProcess>>>,
) -> SettingsView {
    let config = store.config();
    let snapshot = store.snapshot();
    SettingsView {
        rooms: config.channels,
        enable_text: config.enable_text,
        enable_file: config.enable_file,
        enable_text_download: config.enable_text_download,
        enable_file_download: config.enable_file_download,
        poll_interval_ms: config.poll_interval_ms,
        download_dir: config.download_dir.display().to_string(),
        autostart: crate::autostart::initial_checked(&app),
        data_dir: snapshot.data_dir,
        config_path: snapshot.config_path,
        server_running: server.as_ref().is_some_and(|server| server.is_running()),
    }
}

// ── 本地服务端 + 它的配置（`docs/specs/desktop-client.md` §3.5.2）──────
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
}

/// 读服务端的**原始**配置（给那个表单；不认识的键也会原样带出来）。
#[tauri::command]
pub fn server_config(config: State<'_, ServerConfigFile>) -> Result<ServerConfigView, String> {
    Ok(ServerConfigView {
        path: config.path().display().to_string(),
        value: config.read()?,
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
) -> Result<serde_json::Value, String> {
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
#[tauri::command]
pub fn server_log(path: State<'_, std::path::PathBuf>) -> ServerLogView {
    const TAIL_BYTES: u64 = 256 * 1024;
    let view = |text: String| ServerLogView {
        path: path.display().to_string(),
        text,
    };
    let Ok(meta) = std::fs::metadata(path.inner()) else {
        return view(String::new());
    };
    let mut file = match std::fs::File::open(path.inner()) {
        Ok(file) => file,
        Err(err) => return view(format!("打不开日志（{}）：{err}", path.display())),
    };
    let truncated = meta.len() > TAIL_BYTES;
    if truncated {
        use std::io::Seek;
        if file
            .seek(std::io::SeekFrom::End(-(TAIL_BYTES as i64)))
            .is_err()
        {
            return view(format!("读日志失败（{}）", path.display()));
        }
    }
    let mut raw = Vec::new();
    if let Err(err) = std::io::Read::read_to_end(&mut file, &mut raw) {
        return view(format!("读日志失败（{}）：{err}", path.display()));
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
    view(text)
}

/// 本地服务端在不在跑 —— **问出来的**（真的打一条 `GET /server`），不是记的。
#[tauri::command]
pub fn server_running(server: State<'_, Option<Arc<ServerProcess>>>) -> bool {
    server.as_ref().is_some_and(|server| server.is_running())
}

/// 重启本地服务端（「保存并重启」那条路）。
///
/// ⚠️ 只在**自带服务端**时做得到：找不到二进制就**报错**，
/// 而不是画一个点了没反应的按钮（§3.5.2 ② 第 3 条）。
#[tauri::command]
pub fn server_restart(server: State<'_, Option<Arc<ServerProcess>>>) -> Result<(), String> {
    let Some(server) = server.as_ref() else {
        return Err("这个客户端没有自带服务端（找不到 clip9-server），没法替你重启。".to_owned());
    };
    server.stop()?;
    server.start()
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
) -> Result<(), String> {
    store.select(index)?;
    runtime.refresh_history();
    Ok(())
}

/// 上行开关（**可以多个房间同时开**，§4.1 第 1 条）。
#[tauri::command]
pub fn set_upload(
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    index: usize,
    on: bool,
) -> Result<(), String> {
    store.set_upload(index, on)?;
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
) -> Result<(), String> {
    store.set_download(index)?;
    runtime.persist();
    runtime.restart_receiver();
    runtime.refresh_history();
    Ok(())
}

/// 剪贴板监听的暂停/恢复（**只管上行**；下行不归它管）。
#[tauri::command]
pub fn set_monitoring(
    store: State<'_, Arc<Store>>,
    runtime: State<'_, Arc<Runtime>>,
    on: bool,
) -> Result<(), String> {
    store.set_monitoring(on);
    runtime.set_monitoring(on);
    runtime.persist();
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

/// 手动刷新历史（`GET /content`，不碰剪贴板）。
#[tauri::command]
pub fn refresh(runtime: State<'_, Arc<Runtime>>) {
    runtime.refresh_history();
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
#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle, images_only: bool) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_title(if images_only {
        "选图片"
    } else {
        "选文件"
    });
    if images_only {
        // ⚠️ 过滤只是**方便**，不是保证：用户能把过滤器切到「所有文件」。
        // 真正的判断在 `clip9-client` 那边（图片按文件那条路上行，见 `UploadKind`），
        // 所以这里不必（也不该）再判一次。
        builder = builder.add_filter(
            "图片",
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
pub fn open_web(store: State<'_, Arc<Store>>) -> Result<(), String> {
    let Some(channel) = store.selected_channel() else {
        return Err("配置里一个房间都没有".to_owned());
    };
    let url = web_ui_url(&channel.server)?;
    open_in_system_browser(&url)
}

/// 服务端的**网页版地址**。
///
/// ⚠️ 只放行 `http` / `https`：这个字符串最后要交给 `open`（macOS）/`start`（Windows），
/// 而那两条都会把它交给 shell 解释 —— `file://`、`javascript:` 之类**绝对不能**进来。
/// 校验在这里做一次，比在每个平台分支里各写一次靠得住。
fn web_ui_url(server: &str) -> Result<String, String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return Err("服务端地址是空的".to_owned());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!(
            "「{trimmed}」不是 http(s) 地址，不能拿它打开网页版"
        ));
    }
    Ok(trimmed.trim_end_matches('/').to_owned())
}

/// 交给系统自带的 opener。
///
/// ⚠️ 参数**逐个传**（不拼成一条命令字符串）：拼字符串 = 过一遍 shell，
/// 而这里的地址来自用户的配置文件。
fn open_in_system_browser(url: &str) -> Result<(), String> {
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
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("打不开系统浏览器（{url}）：{err}"))
}

#[cfg(test)]
mod tests {
    use super::web_ui_url;

    /// ⚠️ 只放行 `http(s)` —— 这个字符串最后要交给 shell 解释的 opener，
    /// `file://` / `javascript:` 进来就是另一类事了。
    #[test]
    fn only_http_urls_can_be_opened() {
        assert_eq!(
            web_ui_url("http://127.0.0.1:9501/").unwrap(),
            "http://127.0.0.1:9501"
        );
        assert_eq!(
            web_ui_url("  https://host/clip/  ").unwrap(),
            "https://host/clip"
        );
        for bad in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "127.0.0.1:9501",
        ] {
            assert!(web_ui_url(bad).is_err(), "{bad:?} 不该被放行");
        }
    }
}
