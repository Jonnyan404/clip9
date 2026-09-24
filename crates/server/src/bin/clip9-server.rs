//! clip9 独立服务端二进制。
//!
//! 这一份就是「拎出去给 Docker / OpenWrt / Android 用」的那个东西 ——
//! 它不依赖 Tauri、不依赖前端资源，只有 `clip9-server` 一个可执行文件。
//!
//! ⚠️ 端口被占用时要**明确报错**，不能静默换端口：
//! Android 上服务端和客户端在同一个应用进程里，静默换端口会让客户端连到别人身上，
//! 而用户看到的只是「莫名其妙连不上」。

use std::net::SocketAddr;
use std::sync::Arc;

use clip9_core::Config;
use clip9_server::{AppState, router};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clip9_server=info,tower_http=warn".into()),
        )
        .init();

    // TODO(P0): 从 --config <path> 加载配置文件。现在先跑默认配置，
    // 只允许用 `--port` / `CLIP9_PORT` 覆盖端口 —— 那是**为了能起临时实例做验收**
    // （默认 9501 上跑着别的服务，占端口时我们明确报错而不是悄悄换一个）。
    let mut config = Config::default();
    config.server.port = resolve_port(config.server.port);
    let state = Arc::new(AppState::new(config.clone()));

    let port = config.server.port;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| anyhow::anyhow!("无法监听 {addr}（端口被占用？）：{e}"))?;

    tracing::info!("clip9-server 监听 {addr}");
    axum::serve(listener, router(state)).await?;
    Ok(())
}

/// 端口优先级：`--port <n>` > `CLIP9_PORT` > 配置文件默认值。
///
/// ⚠️ 端口被占用时**明确报错**，不静默换端口：Android 上服务端和客户端在同一个
/// 应用进程里，静默换端口会让客户端连到别人身上，而用户看到的只是「莫名其妙连不上」。
fn resolve_port(fallback: u16) -> u16 {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" | "-p" => {
                if let Some(v) = args.next().and_then(|v| v.parse::<u16>().ok()) {
                    return v;
                }
            }
            other => {
                if let Some(v) = other
                    .strip_prefix("--port=")
                    .and_then(|v| v.parse::<u16>().ok())
                {
                    return v;
                }
            }
        }
    }

    std::env::var("CLIP9_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(fallback)
}
