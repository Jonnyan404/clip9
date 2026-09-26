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

mod commands;
mod model;
mod runtime;
mod store;

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

const DEFAULT_SERVER: &str = "http://127.0.0.1:9501";

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

    let store = Arc::new(Store::new(config, config_path, args.data_dir));
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
    runtime.start();

    let app = tauri::Builder::default()
        .manage(Arc::clone(&store))
        .manage(Arc::clone(&runtime))
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::clear_notice,
            commands::select,
            commands::set_upload,
            commands::set_download,
            commands::set_monitoring,
            commands::send_text,
            commands::refresh,
            commands::open_web,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 启动失败");

    // ⚠️ 关窗时把两个句柄都停掉：监控线程自己跑会让**进程退不出去**
    // （`clip-sync` 踩过这个坑，规格 §0.5 那一行「两个都做」就是这个意思）。
    // `Drop` 也会停，这里显式停是为了让退出发生在 `run` 返回**之前**。
    // ⚠️ 闭包要 `'static`，所以这里**把 `Arc` clone 进闭包**（而不是借用外面的
    // `runtime`）—— 借用的话编译器会拒绝，而这个 `stop` 又必须在退出前真的发生。
    let on_exit = Arc::clone(&runtime);
    app.run(move |_handle, _event| {
        if let tauri::RunEvent::ExitRequested { .. } = _event {
            on_exit.stop();
        }
    });
    runtime.stop();
}
