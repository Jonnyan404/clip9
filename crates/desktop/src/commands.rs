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
use crate::store::{Snapshot, Store};

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
/// ⚠️ 这里**必须**重启下行 —— `spawn_receiver` 拿的是**启动时**那份配置的副本，
/// 只改内存不重连的话，界面上开关变了、实际连的还是老房间。
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
