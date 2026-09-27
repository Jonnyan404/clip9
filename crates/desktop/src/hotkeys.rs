//! 全局快捷键 —— 现在只有一条：**显示 / 隐藏主窗口**（默认 `⌘⇧V`）。
//!
//! # ⚠️★ 动作是「切换」，不是「显示」
//!
//! 写成「叫出来」的话，窗口**已经在前台**时按一下**什么都不会发生**——
//! 用户会以为这个键没生效（于是去查别的程序、去重启客户端），而它其实好好的。
//! 所以按下之后先问一句「现在看得见吗」，再决定叫出来还是藏起来（[`toggle_from`]）。
//!
//! ⚠️ 「最小化」要算成**没显示**：macOS 上最小化的窗口 `is_visible()` 仍然是 `true`，
//! 不特判的话按一下会把它**藏起来**（用户想的是把它叫回来），而且藏起来之后
//! 再按一下才回来 —— 表现就是「这个快捷键时好时坏」。
//!
//! # ⚠️ 为什么是插件，以及**页面上拿不到它**
//!
//! 自己写要三套（macOS 的 `RegisterEventHotKey` / Windows 的 `RegisterHotKey` /
//! Linux 的 X11 grab + Wayland 那条死路），而「这个组合键是不是已经被别人占了」
//! 各平台的判定都不一样。⚠️ 与 `notification` / `autostart` / `dialog` 同一条规矩：
//! **页面上不给它权限**（`capabilities/default.json` 里没有 `global-shortcut:*`），
//! 只有这里能注册 —— 判据 9 盯着这一个（少一条权限就是「网页里的脚本也能占全局键」）。
//!
//! # ⚠️★ 注册失败**必须让人看见**
//!
//! `⌘⇧V` 被别的程序占着时 `register()` 会返回 `Err`，而这个键**照样好端端地亮着**
//! （我们的配置里写着「开」）—— 不报出来的话，用户看到的是「按了没反应」，
//! 而他不会想到是「被别的程序占了」。所以：
//!   · [`apply`] 把原因做成一个 [`Msg`]（带组合键与人话），**交回调用方**；
//!   · 调用方（`main.rs` 启动、`apply_settings`）除了进日志，还推进那块提示区
//!     （`Store::notice`）；
//!   · 设置那页另有一行**「系统里的真相」**（[`is_registered`]，与自启那个勾同一个套路）：
//!     提示区会被下一个动作顶掉，而那个勾一直在。
//!
//! ⚠️ 但**整次保存不许因为它失败**（`apply_settings`）：其它设置已经存下去了，
//! 为一个全局键没抢到就把「保存」整个判失败，用户会以为什么都没存上。

use std::str::FromStr;

use clip9_client::Msg;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 那条快捷键的**存储写法**（跨平台：macOS 上是 ⌘、别处是 Ctrl）。
///
/// ⚠️★ 这一版**只有这一条动作**，所以它写死在这里 —— 配置里**不放**它。
/// 「配置里有、界面改不了、实际也不生效」是这个项目反复踩过的那类坑
/// （`poll_interval_ms` 那三例），不如先不放。
/// 要改成用户可编辑时，第一件要做的是**校验**（`Shortcut::from_str` 会失败）
/// 与「改完重新注册」，而那两件事都要有界面能显示失败的地方。
///
/// ⚠️ 写法必须是 `global-hotkey` 认的那几种之一（`CmdOrCtrl` ✓ / `CommandOrControl` ✓ /
/// `Cmd` / `Super` / `Ctrl` / `Alt` / `Option` / `Shift`）—— 拼错的表现是**注册失败**，
/// 而有测试钉着这一条（`the_default_accelerator_parses`）。
pub const TOGGLE_WINDOW: &str = "CmdOrCtrl+Shift+V";

/// 按一下那条快捷键要做什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    /// 叫出来（顺带聚焦 / 取消最小化）。
    Show,
    /// 藏起来（**不是关掉**：关掉窗口只是藏起来，同步照常跑）。
    Hide,
}

/// ⚠️★ 「现在是可见的吗 + 是不是最小化了」→ 该做什么。
///
/// ⚠️ 它就是「**切换**而不是显示」这条规矩的**全部内容**，所以单独成一个函数：
/// 判断写在这里、动作在 [`toggle_main_window`]，两边分开之后
/// 「按下之后到底该叫什么」这件事有测试钉着（而不是散在一个 `if` 里）。
pub fn toggle_from(visible: bool, minimized: bool) -> Toggle {
    // ⚠️ 最小化的窗口 `is_visible()` 仍是 `true`（macOS 上实测如此）——
    // 所以「看得见 **且** 没最小化」才算「已经在前台」。
    if visible && !minimized {
        Toggle::Hide
    } else {
        Toggle::Show
    }
}

/// 给界面看的写法：macOS 用 `⌘⇧V`，别处用 `Ctrl+Shift+V`。
///
/// ⚠️★ 与 [`TOGGLE_WINDOW`] **同一个来源**（拆开 → 逐段翻译 → 拼回来）：
/// 界面那边再写一份 `⌘⇧V` 的话，改了这里而忘了那边，界面就会显示一个
/// **已经不生效**的组合键 —— 那是「界面说一套、实际做另一套」的经典形态。
#[must_use]
pub fn display_toggle_window() -> String {
    display(TOGGLE_WINDOW, cfg!(target_os = "macos"))
}

/// `CmdOrCtrl+Shift+V` → `⌘⇧V`（macOS）/ `Ctrl+Shift+V`（别处）。
///
/// ⚠️ 认不出的段**原样留着**（不 panic、也不丢）—— 与字典那条三级回落同一条脾气：
/// 写错了要看得见。
///
/// ⚠️★ 两边的**连接符不一样**：macOS 的写法是 `⌘⇧V`（**不**加 `+`，系统菜单里就是这样），
/// 别处是 `Ctrl+Shift+V`。所以这里不能一句 `collect()` 拼完了事 —— 第一版就是那么写的，
/// 而它在 macOS 上**碰巧是对的**（`⌘⇧V` 本来就没有分隔符），到 Windows 上会拼出一个
/// `CtrlShiftV`：一个**不存在的键**，看起来却只是「少了个加号」。
/// 这一条由 `the_display_form_matches_the_platform` 钉着（段数也要对得上）。
fn display(accelerator: &str, macos: bool) -> String {
    let parts: Vec<&str> =
        accelerator
            .split('+')
            .map(|raw| {
                let part = raw.trim();
                match part {
                    // `CmdOrCtrl`：macOS 上是 ⌘、别处是 Ctrl —— 这正是它存在的理由。
                    "CmdOrCtrl" | "CommandOrControl" | "CommandOrCtrl" | "CmdOrControl" => {
                        if macos { "⌘" } else { "Ctrl" }
                    }
                    "Cmd" | "Command" | "Super" => {
                        if macos {
                            "⌘"
                        } else {
                            "Win"
                        }
                    }
                    "Ctrl" | "Control" => {
                        if macos {
                            "⌃"
                        } else {
                            "Ctrl"
                        }
                    }
                    "Alt" | "Option" => {
                        if macos {
                            "⌥"
                        } else {
                            "Alt"
                        }
                    }
                    "Shift" => {
                        if macos {
                            "⇧"
                        } else {
                            "Shift"
                        }
                    }
                    other => other,
                }
            })
            .collect();
    // ⚠️★ 连接符按平台分：macOS 是 `⌘⇧V`，别处是 `Ctrl+Shift+V`（理由见上面那段文档）。
    if macos {
        parts.concat()
    } else {
        parts.join("+")
    }
}

/// 打开 / 关掉那条快捷键。**成没成要交回调用方**（原因是一个 [`Msg`]）。
///
/// ⚠️ 关掉走 `unregister_all()`：这一版只有这一条，而「全部撤掉」比「逐条撤」
/// 少一次「哪个键忘了撤」。将来有多条时这里要改成逐条 —— 那时
/// `unregister_all` 会把别人的键也撤掉，而那**不报错**。
///
/// ⚠️ 重复注册**不当失败**：`apply` 会在启动时调一次、用户点保存时再调一次，
/// 而「已经注册过了」不是错误（macOS 上重注册同一个键会返回「已被占用」——
/// 报出来会让用户跑去找别的程序，而那键是我们自己占的）。
pub fn apply(app: &AppHandle<Wry>, enabled: bool) -> Result<(), Msg> {
    let shortcuts = app.global_shortcut();
    if !enabled {
        return shortcuts.unregister_all().map_err(|error| {
            Msg::key("hotkeyUnregisterFailed").param("reason", error.to_string())
        });
    }
    let shortcut = Shortcut::from_str(TOGGLE_WINDOW).map_err(|error| {
        Msg::key("hotkeyUnparsable")
            .param("shortcut", TOGGLE_WINDOW)
            .param("reason", error.to_string())
    })?;
    if shortcuts.is_registered(shortcut) {
        return Ok(());
    }
    shortcuts.register(shortcut).map_err(|error| {
        Msg::key("hotkeyRegisterFailed")
            .param("shortcut", display_toggle_window())
            .param("reason", error.to_string())
    })
}

/// **系统里的真相**：那条快捷键现在到底占到了没有。
///
/// ⚠️★ 与自启那个勾同一条规矩（`autostart_enabled`）：界面画的是**真相**，
/// 不是配置里的意图 —— 配置里写着「开」而这个组合键被别人占着时，
/// 用户唯一能看出不对的地方就是这里。
#[must_use]
pub fn is_registered(app: &AppHandle<Wry>) -> bool {
    Shortcut::from_str(TOGGLE_WINDOW)
        .map(|shortcut| app.global_shortcut().is_registered(shortcut))
        .unwrap_or(false)
}

/// 快捷键被按下时干的事。
///
/// ⚠️★ 只认 `Pressed`：不判的话松开那一下会**再切一次**，
/// 表现是「按一下窗口闪一下就回来了」（松手时又切回去）。
pub fn on_event(app: &AppHandle<Wry>, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    toggle_main_window(app);
}

/// 显示 / 隐藏主窗口。
///
/// ⚠️ 叫出来那一步复用 [`crate::tray::show_main_window`]（它还管聚焦与取消最小化）
/// —— 与托盘菜单、单实例插件走的是**同一个**函数：三处各写一份的话，
/// 「哪个 label、要不要 unminimize」迟早会漂，而漂的表现是「点了没反应」。
fn toggle_main_window(app: &AppHandle<Wry>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("找不到主窗口（label=main），快捷键这次什么也没做");
        return;
    };
    // ⚠️ 两个 `unwrap_or(false)`：拿不到状态时按「没显示」算 —— 也就是**叫出来**。
    // 反过来（当成「已显示」）会让用户在状态读不到时按了没反应，而那是这个模块
    // 一开始就要消灭的那个症状。
    let action = toggle_from(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
    );
    match action {
        Toggle::Show => crate::tray::show_main_window(app),
        Toggle::Hide => {
            let _ = window.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ **那条快捷键本身必须真的能解析**。
    ///
    /// 拼错一个字母（`CmdOrCtrl+Shift+W`、`CmdOrCtrl-Ctrl+V`、多一个 `+`）的表现是
    /// **注册失败**，而失败在界面上的样子是「按了没反应」—— 用户会去查别的程序。
    /// 这个解析器是插件里那一份（`global-hotkey`），所以这条测试验的是**真判据**，
    /// 不是我们自己写的一套规则。
    #[test]
    fn the_default_accelerator_parses() {
        let parsed = Shortcut::from_str(TOGGLE_WINDOW);
        assert!(
            parsed.is_ok(),
            "`{TOGGLE_WINDOW}` 解析不了（{:?}）—— 这个写法必须与 `global-hotkey` 一致",
            parsed.err()
        );
    }

    /// 给界面看的那一份：macOS 用 ⌘⇧V，别处用 Ctrl+Shift+V。
    ///
    /// ⚠️★ 第二行那一条（非 macOS 那份是 `Ctrl+Shift+V`）是**实测抓出来的**：
    /// 第一版把各段 `collect()` 直接拼起来，macOS 上碰巧对（`⌘⇧V` 本来没有分隔符），
    /// Windows 上拼成了 `CtrlShiftV` —— 一个**不存在的键**，而界面上看起来
    /// 只是「少了个加号」，用户照着按当然没反应。
    #[test]
    fn the_display_form_matches_the_platform() {
        assert_eq!(display(TOGGLE_WINDOW, true), "⌘⇧V");
        assert_eq!(display(TOGGLE_WINDOW, false), "Ctrl+Shift+V");
        // ⚠️ 段数一致（数分隔符）：显示的键与真正注册的键不能一个三段、一个四段。
        assert_eq!(
            display(TOGGLE_WINDOW, false).matches('+').count(),
            TOGGLE_WINDOW.matches('+').count(),
            "非 macOS 那份的分隔符数目必须与注册用的写法一致"
        );
    }

    /// ⚠️ 认不出的段**原样留着**（不 panic、不吞）：写错了要看得见。
    #[test]
    fn an_unknown_part_is_shown_as_it_is() {
        assert_eq!(display("Whatever+Shift+Q", true), "Whatever⇧Q");
        assert_eq!(display("", true), "");
    }

    /// ⚠️★ 「切换」的全部内容：前台 → 藏起来；没在前台 → 叫出来。
    ///
    /// ⚠️★ 第二组是这次真正拿不准的那个边界：**最小化的窗口 `is_visible()` 是真的**，
    /// 所以「可见」与「最小化」要一起看 —— 只看可见的话，按一下会把一个最小化的
    /// 窗口**藏起来**（用户想的是把它叫回来），于是这个快捷键看起来时好时坏。
    #[test]
    fn the_shortcut_toggles_instead_of_always_showing() {
        assert_eq!(
            toggle_from(true, false),
            Toggle::Hide,
            "已经在最前面 → 藏起来"
        );
        assert_eq!(toggle_from(false, false), Toggle::Show, "藏着 → 叫出来");
        assert_eq!(toggle_from(true, true), Toggle::Show, "最小化 → 算没显示");
        assert_eq!(
            toggle_from(false, true),
            Toggle::Show,
            "最小化且不可见 → 叫出来"
        );
        // ⚠️ 两个动作必须**不一样**：写成同一个的后果是「按一下什么都看不出来」。
        assert_ne!(Toggle::Show, Toggle::Hide);
    }
}
