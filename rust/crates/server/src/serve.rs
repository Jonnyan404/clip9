//! 「怎么把一个服务端跑起来」—— **唯一**的实现。
//!
//! ⚠️★ 这一层原来是**内联在 `bin/clip9-server.rs` 的 `main` 里**的（2026-09-28 抽出来）。
//! 抽它的理由不是「复用」，而是**「一处定义」**：那段里有一句
//! `into_make_service_with_connect_info::<SocketAddr>()`，它上面的注释写着
//! 「漏了它，直连场景下 `senderIP` 会是空的」——
//! 而 **Android 恰恰是直连场景**（手机上的服务端就是被局域网里的电脑直连）。
//!
//! 外壳若各写一份启动代码，那句迟早会在其中一处消失，而症状是
//! 「**某些部署下** `senderIP` 为空」：不报错、只在那一处出现、还只在直连时出现。
//! 这正是这个项目一直在防的那类 bug（同一形状、两处实现、只漂一处）。
//!
//! 调用方：`bin/clip9-server.rs`（独立二进制）与 `crates/android`（JNI cdylib）——
//! 见 `docs/specs/android-client.md` §5。

use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

use clip9_core::Config;
use clip9_store::Store;
use tokio::sync::watch;

use crate::{AppState, router};

/// 停服务时等正在处理的请求收尾多久，超时直接掐掉。
///
/// ⚠️ 不能是 `None`（= 无限等）：一个卡住的长连接会让「停止」永远不返回，
/// 而调用方（Android 的前台服务）会表现为「点了停止但按钮一直转」。
/// 也不能是 `0`（= 立刻掐）：那等于没有优雅关闭。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// 起服务，**一直跑到第一个监听任务结束**为止。
///
/// ⚠️ 正常情况永不返回（服务进程就该一直跑）。返回 `Ok(())` 或 `Err` 都意味着
/// **某个监听地址起不来了或中途出错了** —— 调用方应当据此报出来并退出/让前台服务停掉，
/// 而不是当作「正常运行结束」。
///
/// ⚠️★ **端口被占用时这里会返回带地址的错**（`无法监听 <addr>（端口被占用？）`）。
/// 调用方**绝对不要**在这一步失败之后「换一个端口再试」：
/// 服务端一旦静默换端口，用户填进别的设备的地址就永远连不上，而**两边都不报错**
/// （这边起来了、对端说超时）。见 `docs/ARCHITECTURE.md` §4.1 第 1 条。
///
/// ⚠️ `config` 要**先把路径解析好**再传进来（`dbPath` / `storageDir` 都已是绝对路径）——
/// 那是外壳的事，见 `docs/ARCHITECTURE.md` §4.2「由各外壳决定路径」。
///
/// ⚠️ 这个入口**不接受停止信号**（独立二进制由信号杀）。要能停的用
/// [`serve_with_shutdown`] —— Android 那侧用的就是它。
pub async fn serve_until_first_error(
    config: Config,
    store: Store,
    static_dir: Option<PathBuf>,
) -> anyhow::Result<()> {
    // ⚠️ `_keep` 要**活到这个函数结束**：发送端一旦被 drop，
    // `watch::Receiver::wait_for` 会立刻返回 `Err`，而 `None` 那一支的语义是
    // 「永远不该停」—— 见 [`wait_for_shutdown`]。
    let (_keep, shutdown) = watch::channel(false);
    serve_with_shutdown(config, store, static_dir, shutdown).await
}

/// 与 [`serve_until_first_error`] 相同，但可以被**优雅地**停掉。
///
/// `shutdown` 里出现 `true` 时：停止接受新连接、等正在处理的请求收尾
/// （最多 [`SHUTDOWN_GRACE`]），然后返回。
///
/// ⚠️★ **必须是优雅的**，不能靠「把 task abort 掉」：服务端正在写的是 redb 事务，
/// 半路掐掉可能留下一个需要修复的库。所以走的是 axum / axum-server 自带的
/// graceful shutdown，而不是 `JoinHandle::abort`。
///
/// ⚠️ 用 `watch` 而不是 `oneshot` / `Notify` 是因为**要发给多个监听地址**：
/// - `oneshot::Receiver` 只有一个消费者；
/// - `Notify::notified()` 是一次性的，**在某个监听者还没开始 await 之前**
///   调用 `notify_waiters()` 会让它永远等不到（那个地址就一直跑）；
/// - `watch` 是**有状态**的：后订阅的人也能立刻看到「已经变成 true 了」。
pub async fn serve_with_shutdown(
    config: Config,
    store: Store,
    static_dir: Option<PathBuf>,
    shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let addrs = resolve_hosts(&config.server.host, config.server.port)?;
    let tls = tls_paths(&config)?;

    let state = AppState::new(config, store, static_dir);
    // ⚠️★ `into_make_service_with_connect_info` 是**必须的**：`client_ip` 要拿对端地址兜底
    // （没有 `X-Forwarded-For` / `X-Real-IP` 时）。漏了它，直连场景下 `senderIP` 会是空的。
    // ⚠️ HTTPS 那条路也要带上它，否则**只有 TLS 部署**会丢 `senderIP` ——
    // 那是「只在某些部署下出现」的 bug，最难查。所以两条路共用同一个 make-service。
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();

    // ⚠️ 多个监听地址时**全都跑起来**，然后等**第一个结束**（正常情况永不结束；
    // 某个地址起不来或中途出错时就是它先结束，我们把它报出来并退出）。
    let mut handles = Vec::new();
    for addr in &addrs {
        let mut addr_shutdown = shutdown.clone();
        match &tls {
            Some((cert, key)) => {
                let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
                    .await
                    .map_err(|e| {
                        anyhow::anyhow!("读证书/私钥失败（cert={cert}，key={key}）：{e}")
                    })?;
                // `axum_server::from_tcp_rustls` 要一个**已绑定**的 std listener。
                let listener = std::net::TcpListener::bind(addr)
                    .map_err(|e| anyhow::anyhow!("无法监听 {addr}（端口被占用？）：{e}"))?;
                // ⚠️★ 必须设成**非阻塞**：`TcpListener::bind` 出来的是阻塞 socket，
                // 而 tokio 拒绝把阻塞 fd 注册进运行时 —— 不设的话会在
                // `from_tcp_rustls` 里 **panic**（`Registering a blocking socket with the
                // tokio runtime is unsupported`），而不是返回一个能读的错误。
                listener
                    .set_nonblocking(true)
                    .map_err(|e| anyhow::anyhow!("把监听 socket 设成非阻塞失败：{e}"))?;
                tracing::info!("clip9-server 监听 https://{addr}");

                // axum-server 的优雅关闭走它自己的 `Handle`，与 axum 那条路的 API 不同。
                let handle = axum_server::Handle::new();
                let shutdown_handle = handle.clone();
                tokio::spawn(async move {
                    if wait_for_shutdown(&mut addr_shutdown).await {
                        tracing::info!(
                            "收到停止信号，等正在处理的请求收尾（最多 {SHUTDOWN_GRACE:?}）"
                        );
                        shutdown_handle.graceful_shutdown(Some(SHUTDOWN_GRACE));
                    }
                });

                let app = app.clone();
                handles.push(tokio::spawn(async move {
                    // ⚠️ `from_tcp_rustls` 返回 `Result`（它要先建 acceptor），别忘了 `?`。
                    axum_server::from_tcp_rustls(listener, tls_config)
                        .map_err(|e| anyhow::anyhow!("初始化 HTTPS 失败：{e}"))?
                        .handle(handle)
                        .serve(app)
                        .await
                        .map_err(|e| anyhow::anyhow!("HTTPS 服务出错：{e}"))
                }));
            }
            None => {
                let listener = tokio::net::TcpListener::bind(addr)
                    .await
                    .map_err(|e| anyhow::anyhow!("无法监听 {addr}（端口被占用？）：{e}"))?;
                tracing::info!("clip9-server 监听 http://{addr}");
                let app = app.clone();
                handles.push(tokio::spawn(async move {
                    axum::serve(listener, app)
                        .with_graceful_shutdown(async move {
                            wait_for_shutdown(&mut addr_shutdown).await;
                        })
                        .await
                        .map_err(|e| anyhow::anyhow!("HTTP 服务出错：{e}"))
                }));
            }
        }
    }

    let (first, _idx, _rest) = futures_util::future::select_all(handles).await;
    first.map_err(|e| anyhow::anyhow!("服务任务异常结束：{e}"))??;
    tracing::info!("服务已停止");
    Ok(())
}

/// 等「该停了」这件事发生。
///
/// ⚠️ 返回 `true` 才表示要停。`Receiver` 报 `Err` 意味着**发送端已经被 drop**，
/// 也就是「**没有人会再让它停了**」（独立二进制就是这种情况：它靠信号杀进程）。
/// 那时候**必须挂住**而不是返回 —— 这里一旦返回，`with_graceful_shutdown` 会
/// 立刻结束服务，于是「独立二进制」会在启动后一瞬间自己停掉。
///
/// ⚠️ 所以这个 `loop` 不是多余的：`wait_for` 在发送端 drop 之后会**反复**返回 `Err`。
async fn wait_for_shutdown(rx: &mut watch::Receiver<bool>) -> bool {
    loop {
        // ⚠️★ 这行**不能**写成 `match rx.wait_for(..).await { Ok(_) => …, Err(_) => … }`：
        // `wait_for` 返回的 `watch::Ref` 内部是 `RwLockReadGuard`，**不是 `Send`**。
        // 一旦让它在 `Err(_)` 分支里跨过 `pending().await`，整个 future 就不再是 `Send`，
        // 而调用方在 `tokio::spawn` 里 —— 报出来的错是
        // 「future cannot be sent between threads safely」，**指向 `tokio::spawn` 那一行**，
        // 不指这里（实测踩过）。用 `is_ok()` 把它当场消费掉就没有这个问题。
        let signalled = rx.wait_for(|v| *v).await.is_ok();
        if signalled {
            return true;
        }
        std::future::pending::<()>().await;
    }
}

/// 要不要起 HTTPS。返回 `Some((cert, key))` 表示要。
///
/// ⚠️ 两个必须**一起**给：Go 的 `ListenAndServeTLS(cert, key)` 只给一个也会报错，
/// 这里同样报错而不是「忽略那个只给了一个的」。
pub fn tls_paths(config: &Config) -> anyhow::Result<Option<(String, String)>> {
    match (config.server.cert.as_str(), config.server.key.as_str()) {
        ("", "") => Ok(None),
        ("", _) | (_, "") => anyhow::bail!("cert 与 key 必须**一起**给（只给一个没法起 TLS）"),
        (cert, key) => Ok(Some((cert.to_owned(), key.to_owned()))),
    }
}

/// 把配置里的 `host` 归一成一组监听地址。
///
/// Go 侧 `server.host` 允许 `"0.0.0.0"` **或** `["0.0.0.0","::"]` 两种写法，
/// `-host` 还允许**逗号分隔** —— 所以 `ServerConfig.host` 是 `serde_json::Value`，三种都收。
pub fn resolve_hosts(value: &serde_json::Value, port: u16) -> anyhow::Result<Vec<SocketAddr>> {
    let mut raw: Vec<String> = Vec::new();
    match value {
        serde_json::Value::String(s) => raw.extend(s.split(',').map(|x| x.trim().to_owned())),
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    raw.extend(s.split(',').map(|x| x.trim().to_owned()));
                }
            }
        }
        _ => {}
    }
    raw.retain(|x| !x.is_empty());
    if raw.is_empty() {
        raw.push("0.0.0.0".to_owned());
    }

    let mut out: Vec<SocketAddr> = Vec::new();
    for host in raw {
        // ⚠️ 用 `to_socket_addrs` 而不是自己解析 IP 字面量：Go 的
        // `net.Listen("tcp", "host:port")` **会解析域名**，所以 `-host localhost`
        // 在 Go 上是能用的 —— 这里也必须能用。
        let addrs = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| anyhow::anyhow!("host 里的 {host:?} 解析不出地址：{e}"))?;
        for addr in addrs {
            if !out.contains(&addr) {
                out.push(addr);
            }
        }
    }
    Ok(out)
}
