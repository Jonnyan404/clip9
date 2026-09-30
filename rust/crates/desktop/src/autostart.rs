//! 开机自启 —— **唯一碰它的地方**。
//!
//! # 为什么单独一个文件
//!
//! 「一个决定只留一处」：自启的**意图**在配置里（`ClientConfig::enable_autostart`），
//! **落地**在系统里（macOS 的 LaunchAgent / Linux 的 `~/.config/autostart/*.desktop` /
//! Windows 的注册表），而**两处都可能被改** —— 用户完全可以在系统设置里把它关掉。
//!
//! 所以「写」「读」两个动作都收在这里，别散到 `main` / `tray` 各写一遍 ——
//! 那正是「同一个决定写在两处、然后一处变旧」的成因（§3.5.2 记过这个教训）。
//!
//! # 为什么这个文件里**有** `tauri`
//!
//! 与 `store` / `runtime` / `tray` 同一类：它做的就是 Tauri 插件的事，没有可测的业务逻辑。
//! 能抽出来的判断（[`crate::tray::action_for`] 那种）都抽在别处了。
//!
//! ⚠️ 真正落地的那个动作（写 plist / 写 .desktop）**只能在真机上验** ——
//! 沙箱里 GUI 是「有进程、没画面」，而 `app.autolaunch()` 要一个真的 `AppHandle`。

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// 把配置里的意图落到系统上（**幂等**）。
///
/// ⚠️★ 失败**只出声、不中断启动**：自启写不进去的原因很多（权限、被策略挡、
/// 容器里没有 launchd、用户手改过那个 plist），而**它们都不该让整个客户端起不来**。
/// 但**必须说出来** —— 用户勾了没反应又不知道原因，比不给他这个开关更糟。
pub fn apply(app: &AppHandle<tauri::Wry>, wanted: bool) {
    let manager = app.autolaunch();
    let result = if wanted {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(err) = result {
        // log-only-ok: 设置页那行「系统里的真相」（`autostart::is_enabled`）会暴露不一致，
        //   用户在那儿看得见；这里只是日志
        eprintln!("设置开机自启失败（想要 {wanted}）：{err}");
    }
}

/// 系统里**现在**到底是不是自启的。`None` = **问不出来**，不是「没开」。
///
/// ⚠️★ 托盘那个勾要画**系统里的真相**，不是配置里的意图 —— 两者不一致时
/// （用户在系统设置里关掉了），画意图就是骗人。这与 `store.rs` 里
/// 「监听开关必须跟着配置走」是同一个规矩的**另一面**：
/// **界面画的那个东西，必须是实际生效的那个。**
#[must_use]
pub fn is_enabled(app: &AppHandle<tauri::Wry>) -> Option<bool> {
    app.autolaunch().is_enabled().ok()
}

/// 勾选框的初始状态。
///
/// ⚠️ 问不出来时**画成未勾**（而不是「不知道」）：托盘只有一个勾，没有第三种画法。
/// 而「未勾」是**安全**的那一侧 —— 用户看到没勾会去点一下（那次会真的去写），
/// 反过来画成勾着、实际没开，他会以为已经开了。
#[must_use]
pub fn initial_checked(app: &AppHandle<tauri::Wry>) -> bool {
    is_enabled(app).unwrap_or(false)
}
