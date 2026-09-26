//! clip9 桌面客户端 —— Tauri 壳。
//!
//! # 职责边界（`docs/specs/desktop-client.md` §2）
//!
//! 这里**只有**「把事件转成 `clip9-client` 的调用」+ 窗口，**没有业务逻辑**。
//! 剪贴板同步的全部逻辑在 `clip9-client` —— 那个 crate **不许出现 `tauri`**，
//! 否则「能独立测」（去重 / 防抖 / 分类 / 边界 / 重试）这条就废了，只剩手动点界面。
//!
//! | 文件 | 放什么 | 依赖 `tauri` 吗 |
//! |---|---|---|
//! | [`store`] | 状态机 + 配置落盘 | ❌（所以能测） |
//! | [`runtime`] | 线程 / 任务 / 句柄的接线 | ❌（所以能测） |
//! | [`commands`] | 转发 | ✅（就它需要） |
//! | 这里 | 参数、启动、退出 | ✅ |
//!
//! # ⚠️ 为什么没有「加载 SPA 的 dist + 注入 `<base>`」
//!
//! 那个形态**已经被否决**（2026-09-26，Jonny：「tauri 负责客户端，spa 复制浏览器的，
//! 互不影响」）。主窗口是 `ui/` 里**手写的**本地页面，实测记录见规格 §0.1.3。
//! 别再往那个方向试。

mod autostart;
mod commands;
mod model;
mod runtime;
mod server_config;
mod server_process;
mod store;
mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use store::{CONFIG_FILE, Store, default_data_dir, load_config};

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
            other => return Err(format!("不认识的参数：{other}（用 -h 看全部）")),
        }
    }
    Ok(Some(Args {
        data_dir: data_dir.unwrap_or_else(default_data_dir),
        server,
    }))
}

fn main() {
    let args = match parse_args() {
        Ok(Some(args)) => args,
        // ⚠️ 参数写错要**打出来**再退：桌面上双击启动是没有终端的，
        // 而「双击了没反应」是这类应用最难查的一类故障。
        // （有终端时看得到；没有时 macOS 会把 stdout 丢进日志。）
        Ok(None) => return,
        Err(reason) => {
            eprintln!("启动参数有问题：{reason}");
            std::process::exit(2);
        }
    };

    // ⚠️ 顺序要紧：**先建目录再读配置** —— `load_config` 第一次运行就要往那里写。
    if let Err(reason) = std::fs::create_dir_all(&args.data_dir) {
        eprintln!("建数据目录失败（{}）：{reason}", args.data_dir.display());
        std::process::exit(1);
    }
    let config_path = args.data_dir.join(CONFIG_FILE);
    let config = match load_config(&config_path, &args.data_dir, &args.server) {
        Ok(config) => config,
        Err(reason) => {
            // ⚠️ 配置坏了就**别起来**：宁可不启动，也不要带着一份默认配置
            // 去连用户的服务器（那会覆盖掉他的地址、房间与方向开关）。
            eprintln!("{reason}");
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
    let runtime = match runtime::Runtime::new(Arc::clone(&store), tokio_handle) {
        Ok(runtime) => runtime,
        Err(reason) => {
            eprintln!("起不来：{reason}");
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
                eprintln!("{reason}");
            }
            Some(process)
        }
        Err(reason) => {
            eprintln!("{reason}");
            None
        }
    };

    // ⚠️★ **顺序要紧**：先把内嵌服务端起起来，**再**让客户端去连。
    // 反过来的话（先前跑过一次），下行第一次连接会打到一个**还没 bind 的端口** ——
    // 用户看到的是「默认房间连不上」，而服务端其实一秒后就起来了。
    runtime.start();

    let app = tauri::Builder::default()
        // ⚠️ 开机自启走官方插件（跨平台那三套自己写会各漂各的）。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // ⚠️ 选文件的系统对话框。⚠️ **页面上不直接用它的 JS API** ——
        // 那要一个打包器（`@tauri-apps/plugin-dialog`），而这份界面是手写的、
        // 没有构建步骤。所以走壳里那条 `pick_files` 命令，由 Rust 侧调它。
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&store))
        .manage(Arc::clone(&runtime))
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
            commands::clear_notice,
            commands::select,
            commands::set_upload,
            commands::set_download,
            commands::send_text,
            commands::copy_to_clipboard,
            commands::pick_files,
            commands::send_files,
            commands::refresh,
            commands::open_web,
            commands::apply_settings,
            commands::autostart_enabled,
            commands::settings_view,
            commands::server_config,
            commands::server_config_save,
            commands::server_status,
            commands::server_log,
            commands::set_local_server,
            commands::server_stop,
            commands::server_restart,
        ])
        // ⚠️ 托盘在 `setup` 里建：那时 `app` 已经能建菜单了，而**晚于** `build` 就来不及
        // （窗口可能已经显示出来，用户会先看到「没有入口」）。见 `tray` 的模块文档。
        .setup({
            let store = Arc::clone(&store);
            let runtime = Arc::clone(&runtime);
            move |app| {
                tray::install(app.handle(), &store, &runtime)
                    .map_err(|err| Box::new(err) as Box<dyn std::error::Error>)?;
                // ⚠️ 把配置里的自启意图**落到系统上**（幂等）。系统里那份可能被用户在
                // 系统设置里删掉，而界面上还勾着 —— 不补的话就是「界面说一套、实际做另一套」。
                autostart::apply(app.handle(), store.config().enable_autostart);
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
    app.run(move |_handle, _event| {
        if let tauri::RunEvent::ExitRequested { .. } = _event {
            on_exit.stop();
            // ⚠️★ 本地服务端是**子进程**，它**不会**跟着父进程一起死 ——
            // 不显式停的话，用户关掉客户端之后它还占着端口、还在同步，
            // 而且下次启动会看到「端口被占」。
            // ⚠️ `stop()` 只停**我们自己起的那个**（见它的文档）：用户手动跑的服务端不动。
            if let Some(server) = &server_on_exit {
                let _ = server.stop();
            }
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
