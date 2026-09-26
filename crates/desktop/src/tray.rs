//! 托盘菜单 —— 桌面端的**主入口**（`docs/specs/desktop-client.md` §7 第 5 条）。
//!
//! # 为什么托盘是主入口
//!
//! 窗口可以关掉，而同步要一直跑。所以「暂停 / 恢复」「切房间」「退出」这些动作
//! **不能只活在窗口里** —— 那等于「关掉窗口就没法暂停」。
//! 界面稿见 `docs/specs/desktop-client-mockup.html`。
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
use crate::store::Store;

/// 一个菜单项对应的动作。
///
/// ⚠️ 抽成枚举（而不是在事件回调里 `match id.as_str()` 直接干活）是为了**能测**：
/// 回调本身要有窗口才能跑，而「id 认不认得出来」是纯字符串判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 暂停 / 恢复剪贴板监听（**上下行都停** —— 见 `app.js` 里那段同名的说明）。
    Toggle,
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
        "toggle" => Some(Action::Toggle),
        "open" => Some(Action::Open),
        "quit" => Some(Action::Quit),
        other => other
            .strip_prefix(ROOM_PREFIX)
            .and_then(|index| index.parse::<usize>().ok())
            .map(Action::SelectRoom),
    }
}

/// 房间项 / 暂停项的 id（建菜单与解析两边**共用**，免得手写两份）。
#[must_use]
pub fn room_id(index: usize) -> String {
    format!("{ROOM_PREFIX}{index}")
}

/// 暂停项的文字。⚠️ 文字要**说清停的是什么**（不是「暂停同步」四个字）——
/// 这个开关在配置层是上下行的总开关，用户以为只停读剪贴板的话会去查别的地方。
#[must_use]
pub fn toggle_label(monitoring: bool) -> &'static str {
    if monitoring {
        "暂停剪贴板同步（上下行都停）"
    } else {
        "恢复剪贴板同步"
    }
}

/// 建托盘 + 接事件。在 `setup` 里调（那时 `app` 已经能建菜单了）。
///
/// ⚠️ 菜单是**建一次**的：房间列表在启动时读一次，之后用户在窗口里改了配置
/// （加房间之类）**不会**反映到托盘上 —— 窗口里的房间列表才是权威。
/// 这是有意的取舍：重建菜单要动 `tauri` 的菜单句柄，而收益只是「托盘里的房间名新一点」。
/// **但暂停项的勾选状态必须跟着走**（它是高频动作，状态错了用户会以为没生效），
/// 所以下面起了一个轮询任务专门同步它。
pub fn install(
    app: &AppHandle<Wry>,
    store: &Arc<Store>,
    runtime: &Arc<Runtime>,
) -> tauri::Result<()> {
    let snapshot = store.snapshot();

    let open = MenuItemBuilder::with_id("open", "打开主窗口").build(app)?;
    let toggle = CheckMenuItemBuilder::with_id("toggle", toggle_label(snapshot.monitoring))
        .checked(snapshot.monitoring)
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
        .items(&[&open, &toggle])
        .separator()
        .item(&rooms)
        .separator()
        .item(&quit)
        .build()?;

    let handle = app.clone();
    let store_for_menu = Arc::clone(store);
    let runtime_for_menu = Arc::clone(runtime);
    // ⚠️ 句柄要**两份**：一份进菜单事件闭包（点一下立刻改勾选），一份进下面的轮询任务
    // （窗口里改了也要跟上）。`CheckMenuItem` 不是 `Copy`，所以 clone —— 两处改的是
    // **同一个**菜单项（它内部是句柄）。
    let toggle_for_poll = toggle.clone();
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
                Action::Quit => app.exit(0),
                Action::Toggle => {
                    let on = !store_for_menu.snapshot().monitoring;
                    runtime_for_menu.set_monitoring(on);
                    runtime_for_menu.persist();
                    // ⚠️ 立刻把勾选改过来，别等轮询 —— 用户点完马上要看结果。
                    let _ = toggle.set_checked(on);
                    let _ = toggle.set_text(toggle_label(on));
                }
                Action::SelectRoom(index) => {
                    if let Err(reason) = store_for_menu.select(index) {
                        eprintln!("托盘：切房间失败：{reason}");
                        return;
                    }
                    runtime_for_menu.refresh_history();
                    show_main_window(app);
                }
            }
        })
        .build(app)?;

    // ⚠️ 暂停项的勾选**必须跟着配置走**：窗口里点一下暂停、托盘里还打着勾的话，
    // 用户会以为没生效（而它其实生效了）—— 「界面说一套、实际做另一套」的反方向，同样坏。
    // 这里用轮询（和 `ui/app.js` 取快照同一个频率与理由）：状态在 `Store` 里，
    // 而它没有观察者机制，加一个只为这一件事的推送通道不划算。
    let handle_for_poll = handle.clone();
    let store_for_poll = Arc::clone(store);
    tauri::async_runtime::spawn(async move {
        let mut last = store_for_poll.snapshot().monitoring;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            let now = store_for_poll.snapshot().monitoring;
            if now == last {
                continue;
            }
            last = now;
            // ⚠️ 拿不到托盘就当没这回事（窗口已经在关了）—— 不值得为它 panic。
            if let Some(tray) = handle_for_poll.tray_by_id("main") {
                let _ = tray.set_visible(true);
            }
            let _ = toggle_for_poll.set_checked(now);
            let _ = toggle_for_poll.set_text(toggle_label(now));
        }
    });

    Ok(())
}

/// 把主窗口叫出来并聚焦。
///
/// ⚠️ 关掉窗口之后，托盘是**唯一**的回头路 —— 所以这里失败要出声，
/// 否则用户看到的是「点了没反应，而应用好像还在跑」。
fn show_main_window(app: &AppHandle<Wry>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("托盘：找不到主窗口（label=main）");
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
    #[test]
    fn the_fixed_items_map_to_their_actions() {
        assert_eq!(action_for("toggle"), Some(Action::Toggle));
        assert_eq!(action_for("open"), Some(Action::Open));
        assert_eq!(action_for("quit"), Some(Action::Quit));
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
    #[test]
    fn unknown_ids_are_refused_instead_of_guessed() {
        for bad in [
            "", "Toggle", "TOGGLE", "open ", "room", "room:", "room:x", "room:-1", "room:1.5",
            "quit2",
        ] {
            assert_eq!(action_for(bad), None, "{bad:?} 不该被认出来");
        }
    }

    /// 暂停项的文案要说清「停的是什么」：这个开关是**上下行总开关**，
    /// 只写「暂停同步」的话用户会以为只停读剪贴板，然后去别处找原因。
    #[test]
    fn the_toggle_label_says_what_it_stops() {
        assert!(toggle_label(true).contains("暂停"));
        assert!(
            toggle_label(true).contains("上下行"),
            "要写明是总开关：{}",
            toggle_label(true)
        );
        assert!(toggle_label(false).contains("恢复"));
    }
}
