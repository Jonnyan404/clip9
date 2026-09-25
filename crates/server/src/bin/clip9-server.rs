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
//!
//! # 命令行参数：**与 Go 版逐一对齐**（2026-09-25 定）
//!
//! 一开始只做了 4 个（`--config` / `--port` / `--data` / `--static`），理由是「只保留外壳
//! 必须决定的东西」。**那个设计被否掉了** —— 见 `FLAGS` 的注释：这是**同一个产品的两个
//! 实现**，部署脚本、Docker 命令、systemd unit、用户的肌肉记忆都是照 Go 写的；
//! 「少做几个参数」不会让谁受益，只会让「换个实现」变成一件要读文档的事。
//!
//! ⚠️ 因此参数的**名字、语义、语法**都照 Go：
//! - 名字用 Go 那套（`-text_limit` 这种下划线也在），**不加 `--` 前缀的区分**；
//! - `-flag value` / `-flag=value` / `--flag value` / `--flag=value` **四种都收**
//!   （Go 的 `flag` 包本来就把 `-` 与 `--` 当同一个东西）；
//! - 覆盖语义同 Go：字符串参数**非空**才覆盖、数字参数**大于 0** 才覆盖；
//! - 认不出的参数**报错并打印帮助**（Go 的 `flag` 包也是），**绝不静默忽略** ——
//!   静默忽略意味着「配了却不生效」，那是这个项目最忌讳的一档。

use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;

use clip9_core::{AuthValue, Config};
use clip9_server::{AppState, router};
use clip9_store::{Limits, Store};

/// 参数表：`(名字, 是否取值, 说明)`。**与 Go 版逐一对应**（`cloud-clip/lib/flags.go`）。
///
/// ⚠️★ 加参数时**改这里就够了** —— 解析、校验、帮助都是从这张表生成的。
/// 但**取用点**还得在 `main` 里写（那张表只描述「有没有这个参数」）。
///
/// ⚠️ 最后那个 `data` 是**本实现独有的**：Go 不用数据库，所以没有「数据目录」这个概念；
/// 这边的 redb 库与 `uploads/` 都挂在它下面。
const FLAGS: &[(&str, bool, &str)] = &[
    ("config", true, "指定配置文件路径"),
    ("v", false, "显示版本信息并退出"),
    ("h", false, "显示帮助信息"),
    ("host", true, "指定监听主机地址，如果设置则覆盖配置文件"),
    ("port", true, "指定监听端口，如果设置则覆盖配置文件"),
    ("auth", true, "指定访问密码，如果设置则覆盖配置文件"),
    ("storage", true, "指定文件存储目录，如果设置则覆盖配置文件"),
    (
        "dbpath",
        true,
        "指定数据库文件路径（redb），如果设置则覆盖配置文件",
    ),
    ("prefix", true, "指定子路径前缀，如果设置则覆盖配置文件"),
    ("history", true, "指定历史记录数量，如果设置则覆盖配置文件"),
    ("text_limit", true, "指定文本字数，如果设置则覆盖配置文件"),
    (
        "file_expire",
        true,
        "指定文件过期时间，如果设置则覆盖配置文件",
    ),
    (
        "file_limit",
        true,
        "指定文件大小限制，如果设置则覆盖配置文件",
    ),
    ("cert", true, "指定证书文件，如果设置则覆盖配置文件"),
    ("key", true, "指定密钥文件，如果设置则覆盖配置文件"),
    ("static", true, "指定前端产物目录"),
    (
        "data",
        true,
        "指定数据目录（redb 库与 uploads/ 的根）—— ⚠️ Go 版没有这个",
    ),
];

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clip9_server=info,tower_http=warn".into()),
        )
        .init();

    // ⚠️★ 先解析 + 校验参数：认不出的参数**必须报错**（见模块注释）。
    // 取参是「按名字找」的，不主动检查的话 `-auth secret` 这类会被**静默忽略** ——
    // 服务照常起来，只是没有密码。Go 的 `flag` 包会打印帮助并退出，这里也一样。
    let args = Args::parse()?;
    if args.has("h") {
        print_usage();
        std::process::exit(0);
    }
    if args.has("v") {
        println!("clip9-server {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }

    // 配置：`-config` 默认 `config.json`（与 Go 的 flag 默认值一致）。
    //
    // ⚠️★ **文件不存在就写一份默认配置出来，然后照常启动** —— 与 Go 的 `load_config`
    // 一样（它读不到就 `os.WriteFile` 一份 `defaultConfig()`）。这一条同时给了两个东西：
    // 「零配置启动」和「一份可以照着改的配置模板」。Jonny 2026-09-25 要的就是这两样。
    //
    // ⚠️ 但**解析失败是致命错误**，这一条**刻意与 Go 不同**：Go 会打一行日志然后用默认值
    // 继续跑 —— 那意味着一个拼错的配置会让服务**不带密码**地起来，而用户以为自己配过了。
    // 「启动失败」比「静默降级」安全，这是这个项目一贯的取舍。
    let config_path = args
        .get("config")
        .unwrap_or_else(|| "config.json".to_owned());
    let mut config = match std::fs::read_to_string(&config_path) {
        Ok(raw) => serde_json::from_str::<Config>(&raw)
            .map_err(|e| anyhow::anyhow!("配置文件 {config_path} 解析失败：{e}"))?,
        Err(read_err) => {
            let default = Config::default();
            // ⚠️ 写不出来**不是**致命错误（只读挂载 / 容器里的只读层）—— 照样用默认值跑，
            // 但要**说出来**，否则用户以为配置已经保存了。
            match serde_json::to_string_pretty(&default) {
                Ok(text) => match std::fs::write(&config_path, format!("{text}\n")) {
                    Ok(()) => tracing::info!(
                        path = %config_path,
                        "配置文件不存在，已写入一份默认配置（照着改，改完重启生效）"
                    ),
                    Err(write_err) => tracing::warn!(
                        path = %config_path,
                        error = %write_err,
                        "写默认配置失败，用内存里的默认值继续跑"
                    ),
                },
                Err(e) => tracing::warn!(error = %e, "序列化默认配置失败"),
            }
            tracing::info!(path = %config_path, error = %read_err, "用默认配置启动");
            default
        }
    };

    apply_flags(&mut config, &args)?;

    // 数据目录：`-data` > `CLIP9_DATA` > `./data`。⚠️ **Go 版没有这个概念**（它不用数据库）。
    let data_dir = args
        .get("data")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./data"));
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| anyhow::anyhow!("无法创建数据目录 {}：{e}", data_dir.display()))?;

    // 库文件：`-dbpath` > 配置 `server.dbPath` > `<data 目录>/clip9.redb`。
    //
    // ⚠️★ 这个名字**刻意不叫 `historyFile`**（Jonny 2026-09-25 定）：Go 那边那个名字
    // 指的是「历史记录 **JSON** 文件的路径」，而这边历史在 redb 里 —— 沿用旧名会让
    // 「名字说的」和「实际做的」不一致，而那个不一致本身就是这个项目最忌讳的一类问题。
    // 所以**不留旧名当别名**：`-historyfile` 会被当成认不出的参数报错（带一句说明），
    // 老配置里的 `historyFile` 会被 serde 当未知字段忽略（正好：Go 那个 JSON 是
    // **迁移工具的输入**，不该被这边覆盖）。
    // ⚠️ 相对路径按 **cwd** 解析（与 Go 一致）。
    let db_path = args
        .get("dbpath")
        .or_else(|| Some(config.server.db_path.clone()).filter(|s| !s.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("clip9.redb"));
    if let Some(parent) = db_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow::anyhow!("无法创建库文件所在目录 {}：{e}", parent.display()))?;
    }
    let store = Store::open_with(&db_path, Limits::default())?;
    tracing::info!(db = %db_path.display(), "存储已打开");

    // ⚠️ 文件存储目录的**兜底**跟着 `--data` 走。配置里那个 `./uploads` 是相对 **cwd** 的，
    // 而服务端可能从任何地方启动（systemd / Docker / OpenWrt procd）—— 相对路径会让
    // 上传的文件散落到各处，重启后就找不到了。
    // ⚠️ 优先级：`-storage` > 配置文件 > `--data/uploads`。
    // 判「配置文件有没有写」的办法是**和默认值比**：`storage_dir` 的默认值就是 `./uploads`，
    // 相等即「没写」。⚠️ 副作用：显式把 `storageDir` 写成 `./uploads` 时会被当成没写 ——
    // 这是已知的近似，写成别的值（或绝对路径）就没这个问题。
    if config.server.storage_dir == Config::default().server.storage_dir {
        config.server.storage_dir = data_dir.join("uploads").to_string_lossy().into_owned();
    }
    std::fs::create_dir_all(&config.server.storage_dir)
        .map_err(|e| anyhow::anyhow!("无法创建文件存储目录 {}：{e}", config.server.storage_dir))?;
    tracing::info!(dir = %config.server.storage_dir, "文件存储目录");

    // 静态资源目录：`-static` > `CLIP9_STATIC` > 不挂（只跑 API）。
    //
    // ⚠️ 路径由**外壳**决定（`docs/ARCHITECTURE.md` §4.2）：Docker 挂载点 / OpenWrt 的
    // `/var/lib` / Android 私有目录各不相同，把路径逻辑写进业务代码会让它们互相打架。
    //
    // TODO(P3)：正式分发包里应该把前端**嵌进二进制**（`include_dir!`）——
    // Go 那边是 `-tags embed`。现在用 `-static` 指向构建产物就够了。
    let static_dir = args.get("static").map(PathBuf::from);
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

    let addrs = resolve_hosts(&config.server.host, config.server.port)?;
    let tls = tls_paths(&config)?;

    let state = AppState::new(config.clone(), store, static_dir);
    // ⚠️ `into_make_service_with_connect_info` 是必须的：`client_ip` 要拿对端地址兜底
    // （没有 `X-Forwarded-For` / `X-Real-IP` 时）。漏了它，直连场景下 `senderIP` 会是空的。
    // ⚠️ HTTPS 那条路也要带上它，否则**只有 TLS 部署**会丢 `senderIP` ——
    // 那是「只在某些部署下出现」的 bug，最难查。所以两条路共用同一个 make-service。
    let app = router(state).into_make_service_with_connect_info::<SocketAddr>();

    // ⚠️ 多个监听地址时**全都跑起来**，然后等**第一个结束**（正常情况永不结束；
    // 某个地址起不来或中途出错时就是它先结束，我们把它报出来并退出）。
    let mut handles = Vec::new();
    for addr in &addrs {
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
                let app = app.clone();
                handles.push(tokio::spawn(async move {
                    // ⚠️ `from_tcp_rustls` 返回 `Result`（它要先建 acceptor），别忘了 `?`。
                    axum_server::from_tcp_rustls(listener, tls_config)
                        .map_err(|e| anyhow::anyhow!("初始化 HTTPS 失败：{e}"))?
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
                        .await
                        .map_err(|e| anyhow::anyhow!("HTTP 服务出错：{e}"))
                }));
            }
        }
    }

    let (first, _idx, _rest) = futures_util::future::select_all(handles).await;
    first.map_err(|e| anyhow::anyhow!("服务任务异常结束：{e}"))??;
    Ok(())
}

/// 把命令行参数盖到配置上。**语义逐条对齐 Go 的 `applyCommandLineArgs`**：
/// 字符串参数非空才覆盖、数字参数大于 0 才覆盖。
fn apply_flags(config: &mut Config, args: &Args) -> anyhow::Result<()> {
    // ⚠️ `-host` 支持逗号分隔（Go 那边也是），这里直接**覆盖**成字符串，
    // 由 `resolve_hosts` 统一归一（数组写法、逗号写法都收）。
    if let Some(v) = args.get("host") {
        config.server.host = serde_json::Value::String(v);
    }
    if let Some(n) = positive(args, "port")? {
        config.server.port = u16::try_from(n)
            .map_err(|_| anyhow::anyhow!("-port 的值 {n} 超出端口范围（1..65535）"))?;
    }
    if let Some(v) = args.get("auth") {
        config.server.auth = AuthValue::Str(v);
    }
    if let Some(v) = args.get("storage") {
        config.server.storage_dir = v;
    }
    if let Some(v) = args.get("dbpath") {
        // 取用点在下面算 `db_path` 的地方（配置与命令行**同一个优先级链**）。
        config.server.db_path = v;
    }
    if let Some(v) = args.get("prefix") {
        config.server.prefix = v;
    }
    if let Some(n) = positive(args, "history")? {
        config.server.history = n;
    }
    if let Some(n) = positive(args, "text_limit")? {
        config.text.limit = n;
    }
    if let Some(n) = positive(args, "file_expire")? {
        config.file.expire = n;
    }
    if let Some(n) = positive(args, "file_limit")? {
        config.file.limit = n;
    }
    if let Some(v) = args.get("cert") {
        config.server.cert = v;
    }
    if let Some(v) = args.get("key") {
        config.server.key = v;
    }
    Ok(())
}

/// 数字参数的「**大于 0 才覆盖**」这条 Go 语义，收在一个地方 —— 别在调用点写五遍。
/// ⚠️ 这也解释了为什么 `-port 0` 等于「没传」：Go 那边是 `if *flg_port > 0`。
fn positive(args: &Args, name: &str) -> anyhow::Result<Option<i64>> {
    Ok(args.number(name)?.filter(|n| *n > 0))
}

/// 要不要起 HTTPS。返回 `Some((cert, key))` 表示要。
///
/// ⚠️ 两个必须**一起**给：Go 的 `ListenAndServeTLS(cert, key)` 只给一个也会报错，
/// 这里同样报错而不是「忽略那个只给了一个的」。
fn tls_paths(config: &Config) -> anyhow::Result<Option<(String, String)>> {
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
fn resolve_hosts(value: &serde_json::Value, port: u16) -> anyhow::Result<Vec<SocketAddr>> {
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

/// 解析出来的命令行参数。
#[derive(Debug, Default)]
struct Args {
    values: HashMap<String, String>,
    present: HashSet<String>,
}

impl Args {
    /// 按 Go 的 `flag` 包那套语法解析，并**拒绝认不出的参数**。
    ///
    /// 收的形式：`-flag value` / `-flag=value` / `--flag value` / `--flag=value`。
    /// ⚠️ `-flag` 与 `--flag` **等价**（Go 的 `flag` 包本来就不区分），
    /// 所以从 Go 抄过来的命令行能原样用。
    fn parse() -> anyhow::Result<Self> {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        let mut out = Self::default();
        let mut i = 0;
        while i < raw.len() {
            let arg = raw[i].clone();

            // `--` 之后全是位置参数 —— Go 也这么认，而本程序**不接受位置参数**，
            // 所以直接报错（静默忽略是最坏的选择）。
            if arg == "--" {
                anyhow::bail!("`--` 之后不接受位置参数");
            }
            // ⚠️ 判据：以 `-` 开头**且不是负数**。不能只判 `--` —— Go 版用的是单横线
            // （`-port`），只判 `--` 会让 `-port 9501` 溜过去，而那恰恰是「从 Go 迁过来」
            // 最典型的写法。`-1` 这种负数要当**值**看。
            if !arg.starts_with('-') || arg.parse::<i64>().is_ok() {
                anyhow::bail!("多余的参数 {arg:?} —— 本程序不接受位置参数（用 -h 看用法）");
            }

            let body = arg.trim_start_matches('-');
            let (name, inline) = match body.split_once('=') {
                Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
                None => (body.to_owned(), None),
            };

            // ⚠️ Go 的 `-historyfile` 在这边**语义变了**（那边是历史 JSON 文件，
            // 这边是 redb 库文件），所以**刻意不留别名** —— 但要给一句能看懂的说明，
            // 而不是让它淹没在「认不出的参数」里（从 Go 迁过来的人一定会撞上这个）。
            if name == "historyfile" {
                anyhow::bail!(
                    "-historyfile 是 Go 版的名字：那边它指的是历史记录 **JSON** 文件。\n\
                     本实现的历史存在 redb 里，对应的参数叫 **-dbpath**（配置里是 `server.dbPath`）。\n\
                     名字不一样是**故意的** —— 语义变了，沿用旧名会让人以为它还是那个 JSON 文件。"
                );
            }

            let Some(&(_, takes_value, _)) = FLAGS.iter().find(|(n, _, _)| *n == name) else {
                anyhow::bail!(
                    "认不出的参数 {arg}\n\
                     ⚠️ 参数名与 Go 版**一致**，但 Go 用单横线（`-port`）、这边两种都收。\n\
                     用 -h 看全部参数。"
                );
            };

            let value = if takes_value {
                match inline {
                    Some(v) => Some(v),
                    None => {
                        // 下一个不是参数名就当值（负数也算值）。
                        let next = raw.get(i + 1);
                        match next {
                            Some(n) if !n.starts_with('-') || n.parse::<i64>().is_ok() => {
                                i += 1;
                                Some(n.clone())
                            }
                            _ => None,
                        }
                    }
                }
            } else {
                // 布尔参数（`-v` / `-h`）不吃值；`-v=true` 也认。
                inline.filter(|v| v == "true")
            };

            if takes_value {
                let Some(v) = value else {
                    anyhow::bail!(
                        "参数 -{name} 需要一个值（写成 `-{name} <值>` 或 `-{name}=<值>`）"
                    );
                };
                out.values.insert(name.clone(), v);
            }
            out.present.insert(name);
            i += 1;
        }
        Ok(out)
    }

    fn has(&self, name: &str) -> bool {
        self.present.contains(name)
    }

    /// 取值：**命令行 > 环境变量**。
    ///
    /// ⚠️ 环境变量兜底是**本实现额外的**（Go 版没有）—— 对 Docker / systemd 友好。
    /// 名字 = `CLIP9_` + 参数名大写（`port` → `CLIP9_PORT`）。
    /// ⚠️ 空串视为「没设」：`CLIP9_PORT=` 这种写法不该把端口清成 0。
    fn get(&self, name: &str) -> Option<String> {
        if let Some(v) = self.values.get(name) {
            return Some(v.clone());
        }
        std::env::var(format!("CLIP9_{}", name.to_uppercase()))
            .ok()
            .filter(|v| !v.is_empty())
    }

    /// 取整数。⚠️ 非数字**报错**，不回落默认值 —— 回落会让「参数写错了」表现成
    /// 「服务按别的值跑」，而用户只会看到「配了不生效」。（Go 的 `flag` 包也报错。）
    fn number(&self, name: &str) -> anyhow::Result<Option<i64>> {
        match self.get(name) {
            None => Ok(None),
            Some(v) => v
                .parse::<i64>()
                .map(Some)
                .map_err(|e| anyhow::anyhow!("-{name} 的值 {v:?} 不是整数：{e}")),
        }
    }
}

/// 用法说明。⚠️ 由 `FLAGS` 生成，别手写第二份。
fn print_usage() {
    println!("clip9-server {}\n", env!("CARGO_PKG_VERSION"));
    println!("用法: clip9-server [选项]\n");
    println!("选项:");
    for (name, takes_value, desc) in FLAGS {
        let value = if *takes_value { " <值>" } else { "" };
        println!("  -{name}{value}");
        println!("        {desc}");
    }
    println!("\n⚠️ 参数名与 Go 版**一致**，语法也一致：`-flag 值` / `-flag=值` 都收。");
    println!("⚠️ 每个参数也可以走环境变量：`CLIP9_` + 名字大写（如 `CLIP9_PORT`），命令行优先。");
    println!("⚠️ 覆盖语义同 Go：字符串参数**非空**才覆盖、数字参数**大于 0** 才覆盖。");
}
