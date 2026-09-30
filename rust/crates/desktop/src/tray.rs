//! 托盘菜单 —— 桌面端的**主入口**（`dev-docs/specs/desktop-client.md` §7 第 5 条）。
//!
//! # 为什么托盘是主入口
//!
//! 窗口可以关掉，而同步要一直跑。所以「切房间」「退出」这些动作
//! **不能只活在窗口里** —— 那等于「关掉窗口就没法退出」。
//! 界面稿见 `dev-docs/specs/desktop-client-mockup.html`。
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
//!
//! # ⚠️★ 菜单的四句话**是壳渲染的**（2026-09-28，多语言那一轮）
//!
//! 菜单是 **Tauri 建的**，页面碰不到它 —— 所以「菜单项叫什么」这件事页面渲染不了，
//! 只能由壳自己查字典（[`crate::shell_text`]）。菜单项自己**只递一个键**
//! （`trayOpen` / `trayAutostart` / `trayRooms` / `trayQuit`），句子住在那两个字典里。
//! ⚠️ 语言设置**只在页面那边**，所以页面启动时、以及每次换语种时会把字典推过来，
//! 推完顺带调 [`retranslate`] 把菜单重建一遍 —— 不重建的话菜单永远停在启动那一刻
//! （那时页面还没跑起来 = 只有键）。
//!
//! ⚠️ 菜单项里的**房间名不翻**：那是用户起的名字（或服务端那边的房间名），是**数据** ——
//! 与「日志内容不翻」「同步过来的正文不翻」是同一条规矩。

use std::sync::Arc;

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use clip9_client::Msg;

use crate::runtime::Runtime;
use crate::server_process::ServerProcess;
use crate::shell_text::ShellText;
use crate::store::{NoticeLevel, Store};

/// 托盘的 id。⚠️ 建菜单与 [`retranslate`] **必须同一个** —— 所以这里只写一份。
const TRAY_ID: &str = "main";

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

/// 建菜单。**建一次**用在 [`install`]，换语种时再建一次用在 [`retranslate`] ——
/// 两处**必须是同一个函数**：各写一份的话，换语言之后菜单会悄悄少一项，
/// 而「少的那一项」永远是后来加的那个。
///
/// ⚠️ 返回自启那一项（点完之后要就地改它的勾），它**不能**从外面另建一个句柄 ——
/// 菜单里那个才是画在屏幕上的那个。
///
/// ⚠️★ 四项的文案走 [`ShellText`]（查表 + 键）。**菜单是 Tauri 建的，页面碰不到它**，
/// 所以这四句是壳自己渲染的少数几处之一（见 [`crate::shell_text`] 的模块文档）。
/// ⚠️ 页面把字典推过来**之前**（启动后那几十毫秒）渲染出来的是**键本身** ——
/// 那时托盘菜单根本没被点开过，而 [`retranslate`] 一到就正了（取舍见模块文档）。
fn build_menu(
    app: &AppHandle<Wry>,
    store: &Arc<Store>,
    shell: &Arc<ShellText>,
) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>)> {
    let snapshot = store.snapshot();

    let open = MenuItemBuilder::with_id("open", shell.say(&Msg::key("trayOpen"))).build(app)?;
    // ⚠️★ 自启那个勾画的是**系统里的真相**（`autostart::initial_checked`），
    // 不是配置里的意图 —— 用户在系统设置里关掉之后，画意图就是骗人。
    let autostart =
        CheckMenuItemBuilder::with_id("autostart", shell.say(&Msg::key("trayAutostart")))
            .checked(crate::autostart::initial_checked(app))
            .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", shell.say(&Msg::key("trayQuit"))).build(app)?;

    // 房间子菜单：下标就是配置里的下标（`Action::SelectRoom` 拿它去 `store.select`）。
    //
    // ⚠️ 房间**名字本身不翻**（那是用户起的名字 / 服务端那边那个房间名，是数据）——
    // 翻的只有外面那层「切换房间」。这条与「日志内容不翻」是同一条规矩。
    let mut rooms = SubmenuBuilder::with_id(app, "rooms", shell.say(&Msg::key("trayRooms")));
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

    Ok((menu, autostart))
}

/// **换语言**：把菜单按新字典重建一遍再挂回去。
///
/// ⚠️★ 菜单是**建出来的一棵固定的树** —— 不重建的话它永远停在启动那一刻的语言上
/// （而启动那一刻页面还没跑起来 = 只有键）。`commands::set_shell_messages` 在
/// **启动时**和**每次换语种**各调一次这里。
///
/// ⚠️ 它**不是** [`install`] 的一部分：`install` 只在 `setup` 里跑一次，
/// 而语言随时会变。两件事混在一起的话，换语言就得重造整个托盘图标
/// （在 macOS 上表现为任务栏图标闪一下）。
///
/// ⚠️ 失败**不 panic 也不上报**，只打一行日志：这一步失败的最坏结果是
/// 「菜单还是旧语言」，而为一个语言问题崩掉主进程显然更坏。
pub fn retranslate(app: &AppHandle<Wry>, shell: &Arc<ShellText>) {
    let Some(store) = app.try_state::<Arc<Store>>() else {
        // ⚠️ `setup` 之前（或状态没注册）—— 那时还没有菜单，正常。
        return;
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        eprintln!("托盘：找不到托盘图标（id={TRAY_ID}），换语言之后菜单还是旧的那份");
        store.notice(NoticeLevel::Error, Msg::key("trayMenuStale"));
        return;
    };
    match build_menu(app, &store, shell) {
        Ok((menu, _)) => {
            // ⚠️ 那个 `_` 是自启项的新句柄：`checked` 已经按**系统里的真相**画好了，
            // 而点它时的句柄由 `install` 的那个闭包持着（菜单重建不影响事件回调）。
            if let Err(err) = tray.set_menu(Some(menu)) {
                eprintln!("托盘：换语言时挂回菜单失败：{err}");
                store.notice(NoticeLevel::Error, Msg::key("trayMenuStale"));
            }
        }
        Err(err) => {
            eprintln!("托盘：换语言时重建菜单失败：{err}");
            store.notice(NoticeLevel::Error, Msg::key("trayMenuStale"));
        }
    }
}

/// 建托盘 + 接事件。在 `setup` 里调（那时 `app` 已经能建菜单了）。
///
/// ⚠️ 菜单是**建一次**的：房间列表在启动时读一次，之后用户在窗口里改了配置
/// （加房间之类）**不会**反映到托盘上 —— 窗口里的房间列表才是权威。
/// 这是有意的取舍：重建菜单要动 `tauri` 的菜单句柄，而收益只是「托盘里的房间名新一点」。
/// ⚠️★ 唯一的例外是**换语言**（[`retranslate`]）：那时会重建一次。
/// 那条路上房间名也是照当时那份快照填的 —— 于是「换了语言，托盘里的房间列表也顺手新了一点」，
/// 这是可接受的副产品（**不是**新加了一条同步机制）。
/// ⚠️ 原来这里还有一个轮询任务，专门同步「暂停项」的勾选状态。**它跟着那个开关一起删了**
/// （见模块文档）—— 现在菜单里唯一有勾选状态的是自启，而它每次点完就地更新。
pub fn install(
    app: &AppHandle<Wry>,
    store: &Arc<Store>,
    runtime: &Arc<Runtime>,
    shell: &Arc<ShellText>,
) -> tauri::Result<()> {
    let (menu, autostart) = build_menu(app, store, shell)?;

    let store_for_menu = Arc::clone(store);
    let runtime_for_menu = Arc::clone(runtime);
    TrayIconBuilder::with_id(TRAY_ID)
        // ⚠️ 用应用自己的图标（`tauri.conf.json` 的 `bundle.icon`）。
        // 托盘图标缺了的话在 macOS 上是个**看不见的空位** —— 用户找不到入口。
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            // `bundle.icon` 缺了是**打包配置**错，用户看不到这句，看到的是「托盘空了」。
            // i18n-ok: **开发者面**的报错（`tauri::Error::AssetNotFound` 收 `String`，塞不进 `Msg`）
            tauri::Error::AssetNotFound("托盘图标：tauri.conf.json 里没有 bundle.icon".to_owned())
        })?)
        .menu(&menu)
        // ⚠️ macOS 上左键点托盘默认就是弹菜单；显式写出来是为了让 Windows / Linux
        // 也走同一条路（那边默认是「左键干别的、右键弹菜单」，两边不一致最难查）。
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let Some(action) = action_for(event.id().as_ref()) else {
                // ⚠️ 认不出来**什么也不做**，但要留下痕迹 —— 静默吞掉是这类问题的温床。
                // ⚠️★ 2026-09-30：除了日志还推一条提示 —— 症状是「点了没反应」，
                // 而界面上一个字都没有，那正是这个项目最忌讳的一类。
                eprintln!("托盘：认不出的菜单项 id={}", event.id().as_ref());
                store_for_menu.notice(NoticeLevel::Error, Msg::key("trayUnknownItem"));
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
                        // ⚠️ `{reason:?}`：那是一条 `Msg`，它故意没有 `Display`（句子该由页面渲染）。
                        eprintln!("托盘：切房间失败：{reason:?}");
                        // ⚠️★ 2026-09-30：**同一句话**也推给提示区 —— 否则用户点了托盘，
                        // 窗口没被叫出来、也没有任何解释（那正是「点了没反应」）。
                        store_for_menu.notice(NoticeLevel::Error, reason);
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
        // log-only-ok: 这条路在**退出**那一拍，进程随即就没了 —— 提示窗口里没人看得到；
        //   后果由下次启动那张卡说清（`owned` / `start_error`，2026-09-30）
        eprintln!("托盘：退出时停本地服务端失败：{reason:?}");
    }
}

/// 「主窗口找不到了」—— 托盘 / 快捷键 / 单实例**三处共用**这一句。
///
/// ⚠️★ 2026-09-30 加：这三处的症状都是「点了没反应」（窗口都不在了，用户只看到
/// 按键 / 点击没动静），而原来它们只打日志 —— 界面上一个字都没有。现在除了日志，
/// 还往提示区推一条（`Store` 从 `AppHandle` 拿；状态还没注册时只剩日志）。
pub(crate) fn warn_no_main_window(app: &AppHandle<Wry>) {
    eprintln!("找不到主窗口（label=main）");
    if let Some(store) = app.try_state::<Arc<Store>>() {
        store.notice(NoticeLevel::Error, Msg::key("noMainWindow"));
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
        warn_no_main_window(app);
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
