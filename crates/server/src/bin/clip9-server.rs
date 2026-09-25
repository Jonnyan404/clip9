//! clip9 独立服务端二进制。
//!
//! 这一份就是「拎出去给 Docker / OpenWrt / Android 用」的那个东西 ——
//! 它不依赖 Tauri、不依赖前端资源，只有 `clip9-server` 一个可执行文件。
//!
//! ⚠️ **端口被占用时要明确报错**，不能静默换端口：Android 上服务端和客户端在同一个
//! 应用进程里，静默换端口会让客户端连到别人身上，而用户看到的只是「莫名其妙连不上」。
//!
//! ⚠️ **路径由外壳决定**，业务代码只认传进来的路径（`docs/ARCHITECTURE.md` §4.2）。
//! 四种分发形态的目录约定完全不同（Docker 挂载点 / OpenWrt `/etc/config` + `/var/lib` /
//! Android 私有目录 / 桌面标准目录），把路径逻辑写进 `core` 会让它们互相打架。

use std::net::SocketAddr;
use std::path::PathBuf;

use clip9_core::Config;
use clip9_server::{AppState, router};
use clip9_store::{Limits, Store};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clip9_server=info,tower_http=warn".into()),
        )
        .init();

    // 配置：`--config <path>` 读 JSON（形状与 Go 的 `config.json` 一致，见 `core::config`）。
    // ⚠️ 配置**必须嵌套在 `server` 键下** —— 平铺会被静默忽略并回落默认值，
    // 那是踩过的坑（配了端口却还是 9501）。
    let mut config = match arg_value("--config", "CLIP9_CONFIG") {
        Some(path) => {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("读不到配置文件 {path}：{e}"))?;
            serde_json::from_str::<Config>(&raw)
                .map_err(|e| anyhow::anyhow!("配置文件 {path} 解析失败：{e}"))?
        }
        None => Config::default(),
    };
    config.server.port = arg_value("--port", "CLIP9_PORT")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(config.server.port);

    let data_dir = arg_value("--data", "CLIP9_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./data"));
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| anyhow::anyhow!("无法创建数据目录 {}：{e}", data_dir.display()))?;

    let db_path = data_dir.join("clip9.redb");
    let store = Store::open_with(&db_path, Limits::default())?;
    tracing::info!(db = %db_path.display(), "存储已打开");

    // ⚠️ 文件存储目录默认跟着 `--data` 走。配置里那个 `./uploads` 是相对 **cwd** 的，
    // 而服务端可能从任何地方启动（systemd / Docker / OpenWrt procd）—— 相对路径会让
    // 上传的文件散落到各处，重启后就找不到了。**配置里显式写了就尊重配置**。
    if config.server.storage_dir == Config::default().server.storage_dir {
        config.server.storage_dir = data_dir.join("uploads").to_string_lossy().into_owned();
    }
    std::fs::create_dir_all(&config.server.storage_dir)
        .map_err(|e| anyhow::anyhow!("无法创建文件存储目录 {}：{e}", config.server.storage_dir))?;
    tracing::info!(dir = %config.server.storage_dir, "文件存储目录");

    // 静态资源目录：`--static <dir>` > `CLIP9_STATIC` > 不挂（只跑 API）。
    //
    // ⚠️ 路径由**外壳**决定（`docs/ARCHITECTURE.md` §4.2）：Docker 挂载点 / OpenWrt 的
    // `/var/lib` / Android 私有目录各不相同，把路径逻辑写进业务代码会让它们互相打架。
    //
    // TODO(P3)：正式分发包里应该把前端**嵌进二进制**（`include_dir!`）——
    // Go 那边是 `-tags embed`。现在用 `--static` 指向构建产物就够了。
    let static_dir = arg_value("--static", "CLIP9_STATIC").map(PathBuf::from);
    if let Some(dir) = &static_dir {
        // ⚠️ 早点失败：指错了目录的话，表现是「页面 404」而**日志里什么都没有**，
        // 那种问题查起来最费时间。
        if !dir.join("index.html").is_file() {
            anyhow::bail!(
                "静态目录 {} 里没有 index.html —— 那不像一份前端产物",
                dir.display()
            );
        }
        tracing::info!(dir = %dir.display(), "静态资源目录");
    }

    let state = AppState::new(config.clone(), store, static_dir);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.server.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| anyhow::anyhow!("无法监听 {addr}（端口被占用？）：{e}"))?;

    tracing::info!("clip9-server 监听 {addr}");
    // ⚠️ `into_make_service_with_connect_info` 是必须的：`client_ip` 要拿对端地址兜底
    // （没有 `X-Forwarded-For` / `X-Real-IP` 时）。漏了它，直连场景下 `senderIP` 会是空的。
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// 取参数：`<flag> <value>` > `<flag>=<value>` > 环境变量。
fn arg_value(flag: &str, env: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
        if let Some(v) = arg.strip_prefix(&format!("{flag}=")) {
            return Some(v.to_owned());
        }
    }
    std::env::var(env).ok().filter(|v| !v.is_empty())
}
