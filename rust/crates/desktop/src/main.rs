//! clip9 桌面客户端 —— Tauri 壳。
//!
//! # 职责边界（`dev-docs/specs/desktop-client.md` §2）
//!
//! 这里**只有**「把事件转成 `clip9-client` 的调用」+ 窗口，**没有业务逻辑**。
//! 剪贴板同步的全部逻辑在 `clip9-client` —— 那个 crate **不许出现 `tauri`**，
//! 否则「能独立测」（去重 / 防抖 / 分类 / 边界 / 重试）这条就废了，只剩手动点界面。
//!
//! | 文件 | 放什么 | 依赖 `tauri` 吗 |
//! |---|---|---|
//! | [`store`] | 状态机 + 配置落盘 | ❌（所以能测） |
//! | [`runtime`] | 线程 / 任务 / 句柄的接线 | ❌（所以能测） |
//! | [`shell_text`] | 壳自己要说的那几句话（查表 + 填参数） | ❌（所以能测） |
//! | [`window_state`] | 「上次关窗时多大」：怎么存、什么时候该写、物理→逻辑怎么换算 | ❌（所以能测） |
//! | [`commands`] | 转发 | ✅ |
//! | [`tray`] | 托盘菜单 | ✅ |
//! | [`notify`] | 系统通知那一下（判据在 `runtime`） | ✅ |
//! | 这里 | 参数、启动、退出 | ✅ |
//!
//! ⚠️★ 两个 ❌ 是这个项目的支点：**判据都在不依赖 `tauri` 的那一侧**
//!（`store` 的状态机、`runtime` 的接线与通知判据），所以它们能被 `cargo test` 钉住。
//! ✅ 那几个只做「把 `tauri` 的东西变成参数」或「把已经定好的东西递出去」。
//!
//! # ⚠️ 为什么没有「加载 SPA 的 dist + 注入 `<base>`」
//!
//! 那个形态**已经被否决**（2026-09-26，Jonny：「tauri 负责客户端，spa 复制浏览器的，
//! 互不影响」）。主窗口是 `ui/` 里**手写的**本地页面，实测记录见规格 §0.1.3。
//! 别再往那个方向试。

mod autostart;
mod commands;
mod hotkeys;
mod model;
mod notify;
mod runtime;
mod server_config;
mod server_process;
// ⚠️ `shell_text` 里**没有** `tauri`：它是「壳自己要说的那几句话」的字典 +
// 填参数规则，纯查表，所以它能被 `cargo test` 钉住（见那个模块的文档）。
mod shell_text;
mod store;
mod tray;
mod update;
mod window_state;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

// ⚠️ `get_webview_window` 是 `Manager` 上的方法 —— 不 `use` 的话报的是
// 「没有这个方法」（`E0599`），而提示里那句「也许你想 `use tauri::Manager`」
// 排在最后一行，很容易被当成「方法名写错了」。
use tauri::Manager;

use store::{CONFIG_FILE, NoticeLevel, Store, default_data_dir, load_config};

/// 起动参数（**手写解析**，与 `clip9-server` 同一套规矩：`-port` / `--port` 都收）。
///
/// | 参数 | 作用 |
/// |---|---|
/// | `-data <目录>` | 配置与数据的根目录（缺省按平台规矩，见 `store::default_data_dir`） |
/// | `-server <地址>` | **第一次运行**时那个默认房间的服务端地址（缺省本机 9501） |
/// | `-h` / `-v` | 帮助 / 版本 |
struct Args {
    data_dir: PathBuf,
    server: String,
}

/// 第一次运行时那个默认房间的服务端地址。
///
/// ⚠️★ **9502，不是 9501** —— 9501 是**用户自己那个实例**的默认端口。
/// 桌面端自带的服务端起在 9502（[`server_process::DEFAULT_PORT`]），
/// 所以默认房间指向它，装完就能用。
/// ⚠️ 两者必须一致：`default_server_matches_the_bundled_port` 那条测试钉着这个关系，
/// 改一个忘另一个会**直接红**（而不是让用户看到一个连不上的地址）。
const DEFAULT_SERVER: &str = "http://127.0.0.1:9502";

fn parse_args() -> Result<Option<Args>, String> {
    let mut data_dir: Option<PathBuf> = None;
    let mut server = DEFAULT_SERVER.to_owned();
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        // ⚠️ 两种横线都收：`-port`（Go 版）与 `--port`（通用）都能用，
        // 与服务端那份命令行一个脾气。
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (arg.as_str(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| argv.next())
                // i18n-ok: **命令行（终端）文案** —— 与 `clip9-server` 那份一个脾气，窗口里不出现
                .ok_or_else(|| format!("{name} 后面要跟一个值"))
        };
        match name.trim_start_matches('-') {
            "h" | "help" => {
                println!(
                    "clip9 桌面客户端\n\n用法：clip9-desktop [选项]\n\n  \
                     -data <目录>     配置与数据的根目录（缺省按平台规矩）\n  \
                     -server <地址>  第一次运行时默认房间的服务端地址（缺省 {DEFAULT_SERVER}）\n  \
                     -h              显示这段帮助\n"
                );
                return Ok(None);
            }
            "v" | "version" => {
                println!("clip9-desktop {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "data" => data_dir = Some(PathBuf::from(value()?)),
            "server" => server = value()?,
            // i18n-ok: 同上，命令行（终端）文案
            other => return Err(format!("不认识的参数：{other}（用 -h 看全部）")),
        }
    }
    Ok(Some(Args {
        data_dir: data_dir.unwrap_or_else(default_data_dir),
        server,
    }))
}

/** 当前那块屏幕的**逻辑**尺寸（拿不到就 `None`）。

⚠️★ 为什么要它：用户在外接大屏上把窗口拖得很大、然后拔掉屏幕用笔记本时，
存下来的尺寸比现在的屏幕还大 —— 贴回去就是一个**伸到屏幕外面**的窗口
（标题栏在屏幕外，拖都拖不回来）。`window_state::fit_within` 就是收这件事的。

⚠️★ `Monitor::size()` 给的是**物理**像素，而存下来那份是**逻辑**像素
（见 `window_state` 的模块文档）—— 换算与坏值守卫都在
[`window_state::from_physical`] 里（**只有那一处**：记窗口大小时走的是同一个函数）。
不除的话在 Retina 上「屏幕」会被算成两倍大，那个收边就等于没做。
*/
fn current_screen(window: &tauri::WebviewWindow) -> Option<window_state::WindowSize> {
    let monitor = window.current_monitor().ok().flatten()?;
    let physical = monitor.size();
    window_state::from_physical(physical.width, physical.height, monitor.scale_factor())
}

/** 把上次记下来的窗口大小贴回去。

⚠️★ 读不出来（第一次运行 / 文件坏了）就**什么都不做** —— 窗口保持
`tauri.conf.json` 里那双 760×520，与装完第一次打开完全一样。
⚠️ 贴的是**逻辑**尺寸，与 `tauri.conf.json` 一个口径（那里也是逻辑像素）。

⚠️★ 它必须在 `setup` 里**尽早**调用：晚于第一次绘制的话，用户会先看到窗口按
760×520 画出来、再跳成他上次那个大小 —— 那个「跳」比记不住更让人不安。

⚠️★ **`set_size` 是异步生效的**：贴完立刻去读 `inner_size()` 拿到的是**旧值**
（2026-09-29 实测：要求 1396×875，贴完读回来还是默认的 760×520 —— 那是
`1520×1040` 物理 ÷ 2.0）。所以**别写「贴完再读一下、顺手记下来」**那种代码：
它记的是上一个尺寸，而且看起来完全正常。真正生效的回声是后面那个
`WindowEvent::Resized`。

⚠️ 同一趟实测（2880×1800 Retina，缩放比 2.0）把它对上了全链：读回 `1396×875` →
`current_screen` 给 `1440×900`（**物理除过缩放比**）→ `fit_within` 装得下 → 一个像素
没动 → 窗口事件回来的物理值是 `2792×1750`，÷2.0 正好是 `1396×875`。
⚠️ 顺带：这个窗口的 `inner_size()` 与 `outer_size()` 报的是**同一个数**
—— macOS 那一圈边框不计进 `outer`，所以不存在「存内尺寸、贴外尺寸」的错位。
*/
fn restore_window_size(app: &tauri::AppHandle, path: &Path) {
    let Some(saved) = window_state::load(path) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let wanted = match current_screen(&window) {
        Some(screen) => saved.fit_within(screen),
        None => saved,
    };
    if let Err(reason) = window.set_size(tauri::LogicalSize::new(
        f64::from(wanted.width),
        f64::from(wanted.height),
    )) {
        // log-only-ok: 窗口尺寸记不住只影响「下次开在哪」，用户处理不了，也**不影响使用**
        eprintln!("贴窗口大小失败（用默认尺寸继续）：{reason}");
    }
}

/** 把窗口事件里的物理尺寸换算成要记下来的那一份（逻辑像素）。

⚠️ 换算与「拿不到缩放比就 `None`」那两条都在 [`window_state::from_physical`] 里 ——
这里只是把 tauri 的两个值拆出来喂进去。
*/
fn logical_size(
    window: &tauri::WebviewWindow,
    physical: tauri::PhysicalSize<u32>,
) -> Option<window_state::WindowSize> {
    let scale = window.scale_factor().ok()?;
    window_state::from_physical(physical.width, physical.height, scale)
}

fn main() {
    let args = match parse_args() {
        Ok(Some(args)) => args,
        // ⚠️ 参数写错要**打出来**再退：桌面上双击启动是没有终端的，
        // 而「双击了没反应」是这类应用最难查的一类故障。
        // （有终端时看得到；没有时 macOS 会把 stdout 丢进日志。）
        Ok(None) => return,
        Err(reason) => {
            // log-only-ok: 命令行（终端）上的报错，紧接着就 exit(2) —— 窗口里没有它的位置
            eprintln!("启动参数有问题：{reason}");
            std::process::exit(2);
        }
    };

    // ⚠️ 顺序要紧：**先建目录再读配置** —— `load_config` 第一次运行就要往那里写。
    if let Err(reason) = std::fs::create_dir_all(&args.data_dir) {
        // log-only-ok: 同上，终端上直接看得到（随后 exit(1)）
        eprintln!("建数据目录失败（{}）：{reason}", args.data_dir.display());
        std::process::exit(1);
    }
    let config_path = args.data_dir.join(CONFIG_FILE);
    // ⚠️★ 窗口大小**与配置并列、不塞进 `config.json`**（理由见 `window_state` 的模块文档）——
    // 所以路径也在这里算一次，`.setup` 与退出那两处用的是**同一个** `PathBuf`。
    let window_size_path = window_state::path_in(&args.data_dir);
    let config = match load_config(&config_path, &args.data_dir, &args.server) {
        Ok(config) => config,
        Err(reason) => {
            // ⚠️ 配置坏了就**别起来**：宁可不启动，也不要带着一份默认配置
            // 去连用户的服务器（那会覆盖掉他的地址、房间与方向开关）。
            // ⚠️ `{reason:?}` 而不是 `{reason}`：那是一条 `Msg`（键 + 参数），
            // 它**故意没有 `Display`**（见 `clip9_client::Msg` 的模块文档第 3 条）——
            // 终端里看到键与参数就够定位了，而句子该由页面渲染。
            // log-only-ok: 配置坏了就**不启动**（明知取舍，2026-09-30 拍板留在范围外）；终端上看得到
            eprintln!("{reason:?}");
            std::process::exit(1);
        }
    };

    // ⚠️ 在 `config` 被 `Store` 拿走之前读出来：「运行方式」决定下面要不要起自带服务端。
    let local_server = config.enable_local_server;
    let store = Arc::new(Store::new(
        config,
        config_path,
        // ⚠️ clone：本地服务端的数据目录还要用这个值（在 `args` 里），
        // 而 `Store` 拿的是所有权。
        args.data_dir.clone(),
    ));
    // ⚠️ tokio 的句柄从 **Tauri 的运行时**里取（它本来就是 tokio）——
    // 不自己建第二个运行时：两个运行时 = 两个线程池，而 `clip9-client` 的
    // 网络栈会被两个调度器轮流驱动，「难查的偶发」就从这里来。
    //
    // ⚠️ `inner()` 拿的是**引用**，所以要 clone 一份 —— 而这一步是 `runtime` 那个
    // 文件**不需要 tauri** 的原因：它只认 tokio 的句柄，认的是「谁能 spawn」。
    let async_handle = tauri::async_runtime::handle();
    let tokio_handle = async_handle.inner().clone();
    // ⚠️★ 通知器**先造、后接窗口**：`AppHandle` 只有 `setup` 里才有，而运行时必须在
    // `tauri::Builder` 之前造出来（上面那段注释）。所以这里交一个**空壳**进去，
    // 到了 `setup` 再 `attach`（理由与「丢掉了会怎样」见 `notify` 的模块文档）。
    //
    // ⚠️★ 它还要一份 [`shell_text::ShellText`]：系统通知是**操作系统画的**，
    // 页面渲染不了那两句话（`capabilities/default.json` 里故意没有 `notification:*`），
    // 所以壳得自己查字典。那个字典由页面推过来（`set_shell_messages`），
    // 而这里造的是一份**还没有字典**的 —— 页面一起来就填上了（取舍见那个模块的文档）。
    // ⚠️ **一份、共享**：通知器、托盘、文件对话框标题用的是同一个 `Arc`。
    // 各造一份的话，「换了语言」只会更新其中一处。
    let shell = std::sync::Arc::new(shell_text::ShellText::new());
    let notifier = std::sync::Arc::new(notify::SystemNotifier::new(std::sync::Arc::clone(&shell)));
    let runtime =
        match runtime::Runtime::with_notifier(Arc::clone(&store), tokio_handle, notifier.clone()) {
            Ok(runtime) => runtime,
            Err(reason) => {
                // log-only-ok: 同上，进程随后 exit(1)
                eprintln!("起不来：{reason:?}");
                std::process::exit(1);
            }
        };
    // ── 本地服务端（随包分发 ✓，§9.1 第 2 条）────────────────────────────
    // ⚠️★ 「找不到二进制」和「起不来」都**不阻止客户端启动**：客户端还能连配置里
    // 那个地址（可能是用户自己的服务端）—— 那才是权威。但两件事都要**说出来**，
    // 因为用户看到的是「装完了，但手机连不上」。
    //
    // ⚠️ 起不来的原因里最值得说的是「端口被占」：9502 撞上别的东西时，
    // `start()` 会把日志路径和端口一起报出来（见 `server_process::start`）。
    let server = match server_process::default_binary() {
        Ok(binary) => {
            let process = Arc::new(server_process::ServerProcess::new(
                binary,
                server_process::data_dir_under(&args.data_dir),
                server_process::DEFAULT_PORT,
            ));
            // ⚠️★ 「运行方式」是**用户选的**（界面稿那一页的两选一）：选了
            // 「连别人的服务端（本机不起）」就别起它。⚠️ 句柄照样留着 ——
            // 那一档随时可以切回来（`commands::set_local_server`）。
            if local_server && let Err(reason) = process.start() {
                // ⚠️★ 这一拍**只进日志**（`{reason:?}` —— `Msg` 没有 `Display`）。
                //
                // ⚠️★ 这一拍**没有「用户点了什么」**：界面上服务端那一页读的是 `server_status`，
                // 而启动失败在这条路上只有一个出口 —— **记在句柄里**，由那张卡显示
                //（`ServerProcess::last_start_error` → `ServerStatusView::start_error`）。
                // ⚠️ 2026-09-30 之前这里是**已知缺口**：只进日志，而 `server_status` 探的是
                // 「端口答不答话」—— 端口被别人占着时它照样说「运行中」。现在它多报两个事实
                //（`owned` / `start_error`），那两件事在卡上都说得出来（见规格的变更记录）。
                // log-only-ok: 这条日志的听众是终端与日志文件；**用户看的那一份在设置页那张卡上**
                eprintln!("{reason:?}");
            }
            Some(process)
        }
        Err(reason) => {
            // log-only-ok: 设置页那张卡会说「这个客户端没有自带服务端」（`bundled: false`）
            eprintln!("找不到本地服务端：{reason:?}");
            None
        }
    };

    // ⚠️★ **顺序要紧**：先把内嵌服务端起起来，**再**让客户端去连。
    // 反过来的话（先前跑过一次），下行第一次连接会打到一个**还没 bind 的端口** ——
    // 用户看到的是「默认房间连不上」，而服务端其实一秒后就起来了。
    runtime.start();

    let app = tauri::Builder::default()
        // ⚠️★ **单实例必须是第一个注册的插件**（官方文档明写：它要在别的插件有机会插手之前
        // 处理掉「已经有一个实例在跑」）。
        //
        // ⚠️ 没有它的后果**不是**「多开一个窗口」那么轻：`Debouncer` 是**进程内**的
        //（`watcher.rs` 那条「谁记得上一次只能有一处」说的是同一个进程里的 watcher 与 receiver），
        // 所以两个实例会**互相把对方写进剪贴板的内容当成一次新复制**、再传回房间 —— 来回弹。
        // 而「开机自启 + 用户手点图标」就是造出两个实例的常见路径。
        // 完整推导：`dev-docs/specs/desktop-client.md` §1.1 缺口 A。
        //
        // ⚠️ 第二个实例被挡掉时，**把已经在跑的那个窗口叫到前面来** —— 复用 `tray::show_main_window`
        // （那条路本来就是「把主窗口叫出来并聚焦」，多写一份就是第二份定义）。
        // 不做这一步的话，用户点图标「什么都没发生」，会以为程序没起来（然后再点一次）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main_window(app);
        }))
        // ⚠️ 开机自启走官方插件（跨平台那三套自己写会各漂各的）。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // ⚠️ 选文件的系统对话框。⚠️ **页面上不直接用它的 JS API** ——
        // 那要一个打包器（`@tauri-apps/plugin-dialog`），而这份界面是手写的、
        // 没有构建步骤。所以走壳里那条 `pick_files` 命令，由 Rust 侧调它。
        .plugin(tauri_plugin_dialog::init())
        // ⚠️ 系统通知（「本机剪贴板没发出去」「房间的内容写进剪贴板了」）。
        // ⚠️★ 插件会给页面注入一段它自带的 JS，但**页面调不动它** ——
        // `capabilities/default.json` 里**故意没有** `notification:*`（见 `notify` 的模块文档）。
        // 只有 Rust 侧的 `notify::SystemNotifier` 能发。
        .plugin(tauri_plugin_notification::init())
        // ⚠️★ 全局快捷键（`hotkeys` 那个模块：显示 / 隐藏主窗口，默认 ⌘⇧V）。
        // ⚠️ 与 `notification` 同一条：插件会给页面注入一段它自带的 JS，
        // 但**页面调不动它** —— `capabilities/default.json` 里故意没有 `global-shortcut:*`
        //（判据 9 盯着这件事）。只有 `hotkeys` 那几条路能注册全局键。
        //
        // ⚠️★ 处理器在这里装上、`apply` 在 `setup` 里调：`with_handler` 只决定
        // 「按下去之后谁被叫醒」，注册与否由 `hotkeys::apply` 按配置决定
        //（关掉时 `unregister_all`，于是这个处理器不会被唤醒）。
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // ⚠️ 只认 `Pressed`（理由在 `hotkeys::on_event` 的文档里）。
                    hotkeys::on_event(app, event.state());
                })
                .build(),
        )
        // ⚠️★ 自动更新（`update` 那个模块）。**插件注册、但页面拿不到它的 JS API** ——
        // `capabilities/default.json` 里故意没有 `updater:*`（判据 9 盯着），
        // 与 `notification` / `global-shortcut` 同一条规矩：页面只跟 IPC 命令说话。
        //
        // ⚠️ 公钥与地址在 `tauri.conf.json` 的 `plugins.updater` 里，**不在这儿** ——
        // 那是打包配置的一部分（`bundle.createUpdaterArtifacts` 与它配套），
        // 分开写会变成两份定义。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&store))
        .manage(Arc::clone(&runtime))
        // ⚠️★ 壳要说的那几句话的字典（页面推过来的那份）。
        // `pick_files` 的对话框标题、托盘的菜单项、系统通知都要它，
        // 而 `set_shell_messages` 是**页面往里填**的那条命令 —— 所以它必须在 state 里。
        // ⚠️ 注册的**晚于** `setup` 也没关系：Tauri 的 `state` 在 `build()` 之前就装好了，
        // 而 `setup` 跑在 `build` 内部（`tray::install` 要读它）。
        .manage(Arc::clone(&shell))
        // ⚠️ 服务端进程：`Option` 是因为二进制可能找不到（那时客户端照常能连别的服务端）。
        // 命令（重启 / 看状态）要它，所以放进 Tauri 的 state。
        .manage(server.clone())
        // ⚠️★ 配置文件的路径**和本地服务端起服务端时用的是同一个函数**
        //（`server_process::config_path`）—— 否则「界面上改了、服务端读的是另一个文件」。
        .manage(server_config::ServerConfigFile::new(
            server_process::config_path(&server_process::data_dir_under(&args.data_dir)),
        ))
        // ⚠️ 日志路径也走 `server_process` 那个函数 —— 起服务端和看日志**必须同一个路径**。
        .manage(server_process::log_path(&server_process::data_dir_under(
            &args.data_dir,
        )))
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            // 自动更新（2026-10-07）。⚠️ 少注册一个的表现是「点了没反应、不报错」——
            // 与上面那几条同一条规矩。
            commands::update_status,
            commands::update_check,
            commands::update_install,
            commands::update_skip,
            commands::clear_notice,
            commands::select,
            commands::set_upload,
            commands::set_download,
            commands::send_text,
            commands::copy_to_clipboard,
            // ⚠️ 这两个是「快照只带截断预览」那条拍板的配套：正文要按需取。
            // 少注册一个的表现是「点展开/复制**没反应**」，而且不报错。
            commands::entry_text,
            commands::copy_entry,
            // 卡片上的图片 / 视频预览点开（2026-10-04）。⚠️ 只收条目 id：
            // 少注册它的表现与上面那两个一样 —— 点了没反应、不报错。
            commands::save_entry_file,
            // ⚠️ 卡片上那颗 🗑 与 ↗（2026-10-03）：删除走服务端 `/revoke`，
            // 分享让服务端签发链接。少注册一个的表现同样是「点了没反应、不报错」。
            commands::delete_entry,
            commands::share_entry,
            commands::preview_url,
            commands::pick_files,
            commands::send_files,
            // 发送框里 ⌘/Ctrl+V 粘进来的图 / 文件（2026-10-04）：webview 只给字节不给路径，
            // 这条命令把它落成临时文件再交给上面那条。少注册它的表现同样是「粘了没反应」。
            commands::save_pasted_file,
            commands::refresh,
            commands::open_web,
            // ⚠️★ 网页视图跟着**当前房间的服务端**走（用户部署在别处的那几台也一样），
            // 所以这里**没有**「本机地址」那条命令了 —— 地址由房间自己带
            //（`RoomView.server`，界面早就拿到了、只是以前没读）。
            // ⚠️ 与 `open_web` 共用 `local_server_url` 的那条老规矩还在：`open_web`
            // 仍然拼本机地址（配了证书 / 路径前缀时两处不会漂）。
            // 少注册下面这个的表现是「切到网页永远停在『正在检查』」——
            // 没有超时、没有失败提示，页面自己看不出问题。
            commands::probe_site,
            // 「这个站点没有可嵌入的网页版」那一块上的按钮（打开项目主页）。
            // ⚠️ 刻意**窄**：只开一个写死的地址，不从页面收 URL —— 收了就等于
            // 给页面一个「用系统浏览器打开任意地址」的能力。
            commands::open_project_page,
            // ⚠️ 网页视图跟着**当前房间的服务端**走之后，要先问一句「那台有没有可嵌的
            // 网页版」—— 跨源 `fetch` 会被 CORS 挡掉，所以这一步只能在壳里做。
            // 少注册一个的表现是「切到网页永远停在『正在检查』」，而页面自己看不出问题。
            commands::probe_site,
            // 「这个站点没有可嵌入的网页版」那一块上的按钮（打开项目主页）。
            commands::open_project_page,
            commands::apply_settings,
            commands::autostart_enabled,
            commands::hotkey_registered,
            commands::settings_view,
            commands::server_config,
            commands::server_config_save,
            commands::server_status,
            commands::server_log,
            commands::set_local_server,
            commands::server_stop,
            commands::server_restart,
            // ⚠️★ 页面把**壳要说的那几句话**推过来（启动一次 + 每次换语种一次）。
            // 少注册这一个的表现是：菜单 / 通知 / 文件对话框永远停在键上
            // （页面会 `catch` 到一个「命令不存在」，但它自己那边看不出问题）。
            commands::set_shell_messages,
        ])
        // ⚠️ 托盘在 `setup` 里建：那时 `app` 已经能建菜单了，而**晚于** `build` 就来不及
        // （窗口可能已经显示出来，用户会先看到「没有入口」）。见 `tray` 的模块文档。
        .setup({
            let store = Arc::clone(&store);
            let runtime = Arc::clone(&runtime);
            let shell = Arc::clone(&shell);
            let window_size_path = window_size_path.clone();
            let update_dir = args.data_dir.clone();
            move |app| {
                // ⚠️★ 把上次关窗时那个大小贴回去（读不出来就保持 `tauri.conf.json` 里那双）。
                // ⚠️ 放在**通知器接线之前**：它要尽早，晚于第一次绘制的话用户会看到
                // 窗口先按 760×520 画一次、再跳一下（理由见 `restore_window_size`）。
                restore_window_size(app.handle(), &window_size_path);
                // ── 自动更新的启动自检（2026-10-07）──────────────────────────
                //
                // ⚠️★ 它**必须在这一拍之前**：`note_start` 是「上一次启动没能善终」的
                // 唯一证据来源，放晚了就可能被下面那些初始化里的一次 panic 抢在前面 ——
                // 而那正是它要数的那类失败。
                {
                    let state = std::sync::Arc::new(update::UpdateState::load(
                        &update_dir,
                        Arc::clone(&store),
                    ));
                    if let clip9_core::update::StartupVerdict::RollBack { version, .. } =
                        state.note_start()
                    {
                        // ⚠️ 判回滚要**说出来**：那时用户已经连开三次都没用成，
                        // 而唯一的出路是去下载上一版 —— 不说的话他只会觉得「应用坏了」。
                        store.notice(
                            NoticeLevel::Error,
                            clip9_client::Msg::key("updateRolledBack").param("version", version),
                        );
                    }
                    // ⚠️★ 观察期到了就确认这一版能跑（见 `update::GRACE`）。
                    // 用**线程**而不是 tokio：桌面端只开了 `tokio` 的 `sync` 特性，
                    // 而这里要的就是「睡 30 秒再写一个文件」—— 不值得为它拉进整个 runtime。
                    let grace_state = Arc::clone(&state);
                    std::thread::spawn(move || {
                        std::thread::sleep(update::GRACE);
                        grace_state.confirm();
                    });
                    app.manage(state);
                }
                // ⚠️★ **第一件做的事**：把窗口句柄接给通知器（见上面 `notifier` 那段）。
                // 接晚了不会错，但那段窗口里的通知会**被丢掉**并打一行日志 ——
                // 而它可能正是「默认房间连不上」那张最该被看到的通知。
                notifier.attach(app.handle().clone());
                tray::install(app.handle(), &store, &runtime, &shell)
                    .map_err(|err| Box::new(err) as Box<dyn std::error::Error>)?;
                // ⚠️ 把配置里的自启意图**落到系统上**（幂等）。系统里那份可能被用户在
                // 系统设置里删掉，而界面上还勾着 —— 不补的话就是「界面说一套、实际做另一套」。
                autostart::apply(app.handle(), store.config().enable_autostart);
                // ⚠️★ 同一条规矩，只是它是**全局快捷键**：配置里写着「开」就把那个组合键占上。
                // ⚠️★ 失败**不能只进日志**：用户看到的是「按了没反应」，而他会去查别的程序
                //（或者重启客户端）。所以除了日志，还推进那块提示区 ——
                // 启动这一刻主窗口就在眼前，这条提示看得到（见 `hotkeys` 的模块文档）。
                if let Err(problem) = hotkeys::apply(app.handle(), store.config().enable_hotkey) {
                    eprintln!("{problem:?}");
                    store.notice(NoticeLevel::Error, problem);
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 启动失败");

    // ⚠️ 关窗时把两个句柄都停掉：监控线程自己跑会让**进程退不出去**
    // （`clip-sync` 踩过这个坑，规格 §0.5 那一行「两个都做」就是这个意思）。
    // `Drop` 也会停，这里显式停是为了让退出发生在 `run` 返回**之前**。
    // ⚠️ 闭包要 `'static`，所以这里**把 `Arc` clone 进闭包**（而不是借用外面的
    // `runtime`）—— 借用的话编译器会拒绝，而这个 `stop` 又必须在退出前真的发生。
    let on_exit = Arc::clone(&runtime);
    let server_on_exit = server.clone();
    // ── 窗口大小的记忆（2026-09-29，Jonny：「记住客户端窗口调整的大小」）──────────
    // ⚠️ 三个状态都在闭包外面：闭包要 `'static`，而且它们要**跨事件**累起来。
    let mut gate = window_state::SaveGate::new();
    let mut latest: Option<window_state::WindowSize> = None;
    let started = Instant::now();
    app.run(move |_handle, _event| {
        match _event {
            // ⚠️★ 拖窗时这条**每帧**都来 —— 所以下面既有节流（`SaveGate`），
            // 也有「这一拍根本不该记」的那两种情况（最大化 / 全屏）。
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Resized(physical),
                ..
            } if label == "main" => {
                let Some(window) = _handle.get_webview_window(&label) else {
                    return;
                };
                // ⚠️★ **最大化 / 全屏时的尺寸不是用户选的大小，是屏幕的大小** ——
                // 记了它，下次启动会开出一个「屏幕那么大、但**不是最大化状态**」的窗口：
                // 用户得拖一下才发现它没最大化，而那个尺寸已经写进配置了。
                // ⚠️ 这里**不写成一个纯函数**（`!max && !fullscreen`）：那种一行断言
                // 是「打不红的假保护」—— 它测的是自己，而不是这两次系统调用。
                let (maximized, fullscreen) = (
                    window.is_maximized().unwrap_or(false),
                    window.is_fullscreen().unwrap_or(false),
                );
                if maximized || fullscreen {
                    return;
                }
                let Some(size) = logical_size(&window, physical) else {
                    return;
                };
                // ⚠️ `latest` 每次都更新（内存里不花钱），写盘才走节流 ——
                // 于是「最后一次微调」永远在 `latest` 里，退出那一拍一定写得下去。
                latest = Some(size);
                if gate.should_write(started.elapsed().as_millis() as u64, size)
                    && let Err(reason) = window_state::save(&window_size_path, size)
                {
                    // log-only-ok: 只在退出/节流那一拍失败，用户处理不了（不影响使用）
                    eprintln!("记窗口大小失败（不影响使用）：{reason}");
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                on_exit.stop();
                // ⚠️★ 本地服务端是**子进程**，它**不会**跟着父进程一起死 ——
                // 不显式停的话，用户关掉客户端之后它还占着端口、还在同步，
                // 而且下次启动会看到「端口被占」。
                // ⚠️ `stop()` 只停**我们自己起的那个**（见它的文档）：用户手动跑的服务端不动。
                if let Some(server) = &server_on_exit {
                    let _ = server.stop();
                }
                // ⚠️★ 退出时**再写一遍**：上面那个节流很可能刚好把最后几次微调挡掉了
                //（手停下来到关窗之间通常不到 700ms）。
                // 少了这一句，症状是「拖完立刻关掉 → 大小没记住」，而它**时好时坏**
                //（取决于关窗前停了多久）—— 那是最难被当成 bug 的一种。
                if let Some(size) = latest
                    && let Err(reason) = window_state::save(&window_size_path, size)
                {
                    // log-only-ok: 只在退出/节流那一拍失败，用户处理不了（不影响使用）
                    eprintln!("记窗口大小失败（不影响使用）：{reason}");
                }
            }
            _ => {}
        }
    });
    runtime.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ 默认房间指向的端口**必须**是本地服务端起的那个端口。
    ///
    /// 改一个忘另一个的后果：装完默认房间指向一个**没有服务端**的端口 ——
    /// 用户看到的是「装好了，但一条也同步不了」，而且没有任何报错。
    /// 这条测试把两个常量钉在一起，改歪了直接红。
    #[test]
    fn default_server_matches_the_bundled_port() {
        let expected = format!("http://127.0.0.1:{}", server_process::DEFAULT_PORT);
        assert_eq!(DEFAULT_SERVER, expected);
        // ⚠️ 顺带钉住「别用 9501」：那是**用户自己那个实例**的默认端口，
        // 撞上去要么让用户的服务端起不来，要么让客户端连错地方。
        assert_ne!(
            server_process::DEFAULT_PORT,
            9501,
            "本地服务端不许用 9501（那是用户自己的实例）"
        );
    }
}
