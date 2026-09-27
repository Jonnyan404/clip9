//! 托盘菜单 —— 桌面端的**主入口**（`docs/specs/desktop-client.md` §7 第 5 条）。
//!
//! # 为什么托盘是主入口
//!
//! 窗口可以关掉，而同步要一直跑。所以「切房间」「退出」这些动作
//! **不能只活在窗口里** —— 那等于「关掉窗口就没法退出」。
//! 界面稿见 `docs/specs/desktop-client-mockup.html`。
//!
//! ⚠️ 托盘里原来还有一项「暂停 / 恢复剪贴板同步」。**2026-09-26 删掉了** ——
//! 它背后的那个总开关（`ClientConfig::enable_monitoring`）整条没了：
//! 要不要发出去只看每个房间的 ↑，而那个开关在**侧栏**（Jonny：「侧栏的图标功能足够了」）。
//! ⚠️ 所以这里**没有**留下一个「点了没反应」的菜单项 —— 那是这个项目最忌讳的一类。
//!
//! # 为什么这个文件里**有** `tauri`
//!
//! 与 `store` / `runtime` 那两个文件相反：托盘**就是** Tauri 的东西，没有可测的业务逻辑。
//! 所以规矩反过来 —— **能抽出来的判断一律抽出去**（[`action_for`] 就是），
//! 留在这里的只有「建菜单、接事件」。
//!
//! ⚠️ 这条边界的意义在于：[`action_for`] 是**唯一**把「菜单项的 id」翻译成动作的地方。
//! id 打错的表现是**点了没反应**（不报错、不 panic），而那正是这个项目最忌讳的一类。
//! 所以那个函数有测试，而这里的接线没有（接线只能在真机上点）。

use std::sync::Arc;

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::runtime::Runtime;
use crate::server_process::ServerProcess;
use crate::store::Store;

/// 一个菜单项对应的动作。
///
/// ⚠️ 抽成枚举（而不是在事件回调里 `match id.as_str()` 直接干活）是为了**能测**：
/// 回调本身要有窗口才能跑，而「id 认不认得出来」是纯字符串判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 开机自启的开 / 关（落地见 [`crate::autostart`]）。
    ToggleAutostart,
    /// 把主窗口叫出来（关掉窗口之后唯一的回头路）。
    Open,
    /// 退出。
    Quit,
    /// 切到第 N 个房间（下标按配置里的顺序）。
    SelectRoom(usize),
}

/// 房间菜单项的 id 前缀。⚠️ 与 [`action_for`] 必须一致 —— 改一处要改两处，
/// 所以两边都只写这一个常量。
const ROOM_PREFIX: &str = "room:";

/// 菜单项的 id → 动作。认不出来返回 `None`。
///
/// ⚠️★ **返回 `None` 而不是 panic、也不是猜一个动作**：多出来的菜单项
/// （将来加的、或者某个平台注入的）不该让整个托盘崩掉；
/// 但**也不该被当成某个动作**（那会变成「点了一个莫名其妙的项，结果退出了」）。
#[must_use]
pub fn action_for(id: &str) -> Option<Action> {
    match id {
        "autostart" => Some(Action::ToggleAutostart),
        "open" => Some(Action::Open),
        "quit" => Some(Action::Quit),
        other => other
            .strip_prefix(ROOM_PREFIX)
            .and_then(|index| index.parse::<usize>().ok())
            .map(Action::SelectRoom),
    }
}

/// 房间项的 id（建菜单与解析两边**共用**，免得手写两份）。
#[must_use]
pub fn room_id(index: usize) -> String {
    format!("{ROOM_PREFIX}{index}")
}

/// 建托盘 + 接事件。在 `setup` 里调（那时 `app` 已经能建菜单了）。
///
/// ⚠️ 菜单是**建一次**的：房间列表在启动时读一次，之后用户在窗口里改了配置
/// （加房间之类）**不会**反映到托盘上 —— 窗口里的房间列表才是权威。
/// 这是有意的取舍：重建菜单要动 `tauri` 的菜单句柄，而收益只是「托盘里的房间名新一点」。
/// ⚠️ 原来这里还有一个轮询任务，专门同步「暂停项」的勾选状态。**它跟着那个开关一起删了**
/// （见模块文档）—— 现在菜单里唯一有勾选状态的是自启，而它每次点完就地更新。
pub fn install(
    app: &AppHandle<Wry>,
    store: &Arc<Store>,
    runtime: &Arc<Runtime>,
) -> tauri::Result<()> {
    let snapshot = store.snapshot();

    let open = MenuItemBuilder::with_id("open", "打开主窗口").build(app)?;
    // ⚠️★ 自启那个勾画的是**系统里的真相**（`autostart::initial_checked`），
    // 不是配置里的意图 —— 用户在系统设置里关掉之后，画意图就是骗人。
    let autostart = CheckMenuItemBuilder::with_id("autostart", "开机自动启动")
        .checked(crate::autostart::initial_checked(app))
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    // 房间子菜单：下标就是配置里的下标（`Action::SelectRoom` 拿它去 `store.select`）。
    let mut rooms = SubmenuBuilder::with_id(app, "rooms", "切换房间");
    for (index, room) in snapshot.rooms.iter().enumerate() {
        let label = if room.name.is_empty() {
            room.room.clone()
        } else {
            room.name.clone()
        };
        let item = MenuItemBuilder::with_id(room_id(index), label).build(app)?;
        rooms = rooms.item(&item);
    }
    let rooms = rooms.build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&open, &autostart])
        .separator()
        .item(&rooms)
        .separator()
        .item(&quit)
        .build()?;

    let store_for_menu = Arc::clone(store);
    let runtime_for_menu = Arc::clone(runtime);
    TrayIconBuilder::with_id("main")
        // ⚠️ 用应用自己的图标（`tauri.conf.json` 的 `bundle.icon`）。
        // 托盘图标缺了的话在 macOS 上是个**看不见的空位** —— 用户找不到入口。
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("托盘图标：tauri.conf.json 里没有 bundle.icon".to_owned())
        })?)
        .menu(&menu)
        // ⚠️ macOS 上左键点托盘默认就是弹菜单；显式写出来是为了让 Windows / Linux
        // 也走同一条路（那边默认是「左键干别的、右键弹菜单」，两边不一致最难查）。
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let Some(action) = action_for(event.id().as_ref()) else {
                // ⚠️ 认不出来**什么也不做**，但要留下痕迹 —— 静默吞掉是这类问题的温床。
                eprintln!("托盘：认不出的菜单项 id={}", event.id().as_ref());
                return;
            };
            match action {
                Action::Open => show_main_window(app),
                Action::Quit => {
                    stop_bundled_server(app);
                    app.exit(0);
                }
                Action::SelectRoom(index) => {
                    if let Err(reason) = store_for_menu.select(index) {
                        eprintln!("托盘：切房间失败：{reason}");
                        return;
                    }
                    runtime_for_menu.refresh_history();
                    show_main_window(app);
                }
                Action::ToggleAutostart => {
                    // ⚠️★ **两件事都要做**：改配置里的意图（下次启动的依据）+ 落到系统上。
                    // 只做前者 = 「配了不生效」；只做后者 = 下次启动又变回去。
                    let wanted = !store_for_menu.snapshot().autostart;
                    store_for_menu.set_autostart(wanted);
                    crate::autostart::apply(app, wanted);
                    runtime_for_menu.persist();
                    // ⚠️★ 勾跟着**系统里的真相**走，不跟着我们想要的值走 ——
                    // 写失败时（权限 / 被策略挡）要显示「没开」，否则用户以为成了。
                    // 这是 `autostart::is_enabled` 存在的全部理由。
                    let _ = autostart.set_checked(crate::autostart::initial_checked(app));
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// 退出前把**自带的服务端**停掉。
///
/// ⚠️★ 它是个**子进程**，不会跟着我们死。原来只靠 `main.rs` 的
/// `RunEvent::ExitRequested` 那一条路径 —— 而托盘这个「退出」走的是 `app.exit(0)`，
/// 那是「立刻退出」，**不一定**会派发那个事件。漏掉的话会留下一个**孤儿进程**：
/// 它占着端口，而它「不是这个客户端起的」（句柄里的 `child` 是 `None`），
/// 于是**下次启动也停不掉** —— 用户看到的是「**改任何端口都报端口被占用**」
///（Jonny 2026-09-26 撞上的就是它，见 `server_process::port` 的文档）。
///
/// ⚠️ `stop()` 只停**我们自己起的那个**：用户手动跑的服务端不动。
fn stop_bundled_server(app: &AppHandle<Wry>) {
    let Some(server) = app.try_state::<Option<Arc<ServerProcess>>>() else {
        return;
    };
    let Some(server) = server.as_ref() else {
        return;
    };
    if let Err(reason) = server.stop() {
        // ⚠️ 失败要**出声**：留下的会是一个占着端口的孤儿，而用户只会在
        // 下次「起不来」时才发现 —— 那时已经离这里很远了。
        eprintln!("托盘：退出时停本地服务端失败：{reason}");
    }
}

/// 把主窗口叫出来并聚焦。
///
/// ⚠️ 关掉窗口之后，托盘是**唯一**的回头路 —— 所以这里失败要出声，
/// 否则用户看到的是「点了没反应，而应用好像还在跑」。
///
/// ⚠️★ `pub(crate)` 是因为**第二个调用方**：单实例插件挡掉第二个实例时也要把主窗口叫出来
///（`main.rs` 的 `.plugin(tauri_plugin_single_instance::init(...))`）。
/// 那一步**不能**各写一份 —— 「找哪个 label、show 还是 unminimize」只能有一处定义，
/// 漏掉 `unminimize` 的表现就是「窗口最小化时点了图标仍然什么都没发生」。
pub(crate) fn show_main_window(app: &AppHandle<Wry>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("找不到主窗口（label=main）");
        return;
    };
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.unminimize();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ 三个固定项**逐字**钉住。拼错了的表现是「点了没反应」——
    /// 不报错、不 panic、日志里也没有（`on_menu_event` 根本不会被触发，因为 id 对不上）。
    ///
    /// ⚠️ 三个动作还必须**互不相同**：落到同一个动作上的后果是
    ///「点一下开机自启，结果退出了」—— 而用户根本不会往那上面想。
    #[test]
    fn the_fixed_items_map_to_their_actions() {
        assert_eq!(action_for("open"), Some(Action::Open));
        assert_eq!(action_for("quit"), Some(Action::Quit));
        assert_eq!(action_for("autostart"), Some(Action::ToggleAutostart));
        assert_ne!(Action::Open, Action::Quit);
        assert_ne!(Action::Open, Action::ToggleAutostart);
        assert_ne!(Action::Quit, Action::ToggleAutostart);
    }

    /// 房间项：id 与下标**双向**都要对得上（建菜单用的是 [`room_id`]，解析用的是
    /// [`action_for`]，两边写歪一个就整条路断掉）。
    #[test]
    fn room_ids_round_trip_through_the_parser() {
        for index in [0, 1, 7, 42] {
            assert_eq!(action_for(&room_id(index)), Some(Action::SelectRoom(index)));
        }
    }

    /// ⚠️ 认不出来的 id 必须是 `None`，**不能**猜一个动作。
    /// 猜的后果是「点了个莫名其妙的菜单项，结果退出了」—— 比没反应更坏。
    ///
    /// ⚠️★ 清单里的 `"toggle"` 是**特意留的**：那是 2026-09-26 删掉的那一项
    /// （暂停 / 恢复剪贴板同步）。留着它是在钉「**删掉的动作不许被重新认出来**」——
    /// 万一哪天有人把一个旧菜单项接回来，这里会红，而不是静默地什么都不做。
    #[test]
    fn unknown_ids_are_refused_instead_of_guessed() {
        for bad in [
            "", "Toggle", "TOGGLE", "toggle", "open ", "room", "room:", "room:x", "room:-1",
            "room:1.5", "quit2",
        ] {
            assert_eq!(action_for(bad), None, "{bad:?} 不该被认出来");
        }
    }
}
