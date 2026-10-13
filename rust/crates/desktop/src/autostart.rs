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
///
/// ⚠️★ 还有一类「失败」是**假的**：想关、而系统里本来就没开（默认配置就是这个状态）。
/// 那一支由 [`needs_change`] 拦在动系统之前 —— 不拦的话 Windows 上每次启动都会
/// 报一句「系统找不到指定的文件」，见那边的文档。
pub fn apply(app: &AppHandle<tauri::Wry>, wanted: bool) {
    // ⚠️★ 问的是**系统里的真相**（`is_enabled` 真的去读注册表 / plist），不是配置里的意图
    // —— 与托盘那个勾用的是同一个来源（见 [`is_enabled`] 的文档）。
    if !needs_change(is_enabled(app), wanted) {
        return;
    }
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

/// 该不该真的去动系统里那一项？（**纯判断，能测** —— 见文件末尾那四条）
///
/// ⚠️★ 为什么要有这一句（2026-10-13 Jonny 报的「打开就弹个黑窗」里的那行字）：
/// **默认配置的自启是关的**（`ClientConfig::enable_autostart` 默认 `false` —— 装完就往
/// 系统里塞一条自启项是**未经同意**的，见那边的文档），于是每次启动都会走一次
/// `disable()`；而 `auto-launch` 在 Windows 上只有一句 `RegDeleteValueW`：删一条
/// **不存在**的值，Win32 回 `ERROR_FILE_NOT_FOUND(2)` —— 插件把它折叠成一句错误文本，
/// [`apply`] 再原样 `eprintln!`。用户看到的是
/// 「设置开机自启失败（想要 false）：系统找不到指定的文件」，而**他什么都没做错**。
///
/// ⚠️★ 三条边界，每一条都有单测盯着：
/// · `current == Some(false)` 且不想要 → **不动**（本来就没开，动它就是那个假失败）；
/// · `current == None`（**问不出来**）→ **照旧尝试**。把「读不出来」当成「已经关了」
///   就是**把一次真的失败吞掉**：用户勾了没反应，而日志里也什么都没有。
/// · 想要**开**时**永远照做** —— `enable()` 每次启动重写一遍注册表值 / plist，正是
///   「exe 路径变了能自愈」的来源（用户换了安装位置、从便携版换成安装版）。
///   别为了少写一次注册表把它省掉。
#[must_use]
pub fn needs_change(current: Option<bool>, wanted: bool) -> bool {
    if wanted {
        return true;
    }
    current != Some(false)
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

/// ⚠️★ 这四条钉的是 2026-10-13 那个黑窗里的那行字
///（「设置开机自启失败（想要 false）：系统找不到指定的文件。(os error 2)」）。
///
/// 它们**不需要窗口也不需要 `tauri`** —— 这正是 [`needs_change`] 被抽成一个纯函数
/// 的全部理由（`apply` 本身要一个真的 `AppHandle`，只能在真机上验）。
#[cfg(test)]
mod tests {
    use super::needs_change;

    /// 默认配置就是这个状态（自启 = 关，见 `ClientConfig::enable_autostart`）——
    /// 于是**每一次启动**都会走到这儿。动它 = Windows 上报一次
    /// `ERROR_FILE_NOT_FOUND(2)`，也就是「每次开机都看见一句红字」。
    #[test]
    fn an_already_off_autostart_is_left_alone() {
        assert!(
            !needs_change(Some(false), false),
            "系统里本来就没开，不该再去关一次（那一次在 Windows 上就是那个假失败）"
        );
    }

    /// 真的开着才去关（用户自己在设置页里取消那个勾）。
    #[test]
    fn a_running_autostart_is_turned_off() {
        assert!(needs_change(Some(true), false), "开着就得真的去关");
    }

    /// ⚠️★ 问不出来时**必须照旧尝试**：`None` 是「读不出系统里那一项」，不是「没开」。
    /// 把它当成「已经关了」等于把一次**真的**失败吞掉 —— 用户勾了没反应、
    /// 而日志里什么都没有，那比多报一次假失败更坏。
    #[test]
    fn an_unreadable_state_still_tries() {
        assert!(
            needs_change(None, false),
            "读不出来 ≠ 已经关了：这一支要照旧尝试"
        );
    }

    /// ⚠️★ 想**开**时永远照做，**哪怕系统里已经开着** —— 那句 `enable()` 每次都把
    /// 当前的 exe 路径重写一遍，那正是「换了安装位置之后自启还能用」的来源。
    #[test]
    fn enabling_is_always_attempted() {
        assert!(needs_change(Some(false), true), "没开就得开");
        assert!(
            needs_change(Some(true), true),
            "已经开着也要重写一遍：路径可能变了（换了安装位置 / 便携版换成安装版）"
        );
    }
}
