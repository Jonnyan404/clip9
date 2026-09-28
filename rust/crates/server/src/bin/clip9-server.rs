//! clip9 独立服务端二进制。
//!
//! 这一份就是「拎出去给 Docker / OpenWrt / Android 用」的那个东西 ——
//! 它不依赖 Tauri、不依赖任何**外部**文件（前端产物**编在二进制里**，见 `build.rs`）。
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
use std::io::IsTerminal;
use std::path::PathBuf;

use clip9_core::{AuthValue, Config};
use clip9_server::paths::Paths;

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
    (
        "static",
        true,
        "指定前端产物目录（**盖住**编进二进制的那一份）",
    ),
    (
        "data",
        true,
        "指定数据目录（redb 库与 uploads/ 的根）—— ⚠️ Go 版没有这个",
    ),
];

/// `migrate` 子命令自己的参数表。⚠️ 与 `FLAGS` **分开**：`-from` / `-dry-run` 只对迁移有意义，
/// 放进主表会让 `clip9-server -from x` 看起来像个能用的启动参数。
const MIGRATE_FLAGS: &[(&str, bool, &str)] = &[
    (
        "from",
        true,
        "Go 版的数据目录（里面有 history.json 与 uploads/）",
    ),
    (
        "config",
        true,
        "配置文件路径（**只读**它的 dbPath / storageDir，不会生成文件），默认 config.json",
    ),
    ("data", true, "本实现的数据目录，默认 ./data"),
    ("dbpath", true, "库文件路径，默认 <data>/clip9.redb"),
    ("storage", true, "上传文件的存放目录，默认 <data>/uploads"),
    (
        "dry-run",
        false,
        "只读、只报告，一个字节都不写（连库都不打开）",
    ),
    ("h", false, "显示帮助信息"),
];

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ⚠️★ `with_ansi` **必须**跟着「输出到不到终端」走，不能不管它。
    // `tracing_subscriber::fmt()` 的默认值是**恒定开**（只跟 cargo feature 有关，
    // 它自己不探 tty），于是「输出被重定向到文件或管道」时颜色码照样写进去。
    // 实测（2026-09-28）：`clip9-server … > out.log` 里是
    // `^[[2m2026-09-28T…^[[0m ^[[32m INFO^[[0m …`。
    //
    // 每一个**非终端**的消费方都会被这件事弄花：
    //   - OpenWrt：procd 把 stdout 收进 logd，LuCI 的日志页整屏是 `^[[32m`；
    //   - Docker：`docker logs` 同理；
    //   - 桌面端：它把服务端的输出收进自己的日志里。
    // 而**交互式**跑的时候颜色是想要的。所以判据就是「stdout 是不是终端」。
    // ⚠️ 判错了不会报错、只会满地控制字符 —— 所以别把这个判据删了。
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clip9_server=info,tower_http=warn".into()),
        )
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    // ⚠️★ 子命令要在参数解析**之前**判：`migrate` 是位置参数，而解析器把位置参数当错误
    // （那是对的 —— 主程序不接受位置参数）。子命令只认第一个参数，其余交给它自己解析。
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().map(String::as_str) == Some("migrate") {
        return run_migrate(&raw[1..]);
    }

    // ⚠️★ 先解析 + 校验参数：认不出的参数**必须报错**（见模块注释）。
    // 取参是「按名字找」的，不主动检查的话 `-auth secret` 这类会被**静默忽略** ——
    // 服务照常起来，只是没有密码。Go 的 `flag` 包会打印帮助并退出，这里也一样。
    let args = Args::parse(&raw, FLAGS)?;
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
    // ⚠️★ 「读不到就写一份默认配置出来，然后照常启动」+「解析失败是致命错误」这两条
    // **不在这个文件里** —— 它们在 `clip9_server::config_file`（一处定义，
    // `crates/android` 走同一个）。那边的模块文档写了为什么解析失败要致命。
    let config_path = args
        .get("config")
        .unwrap_or_else(|| "config.json".to_owned());
    let mut config = clip9_server::config_file::load_or_create(std::path::Path::new(&config_path))?;

    apply_flags(&mut config, &args)?;

    // 数据目录 → 实际路径 → 打开库：**共用的一份**（见 `clip9_server::paths::open_store`）。
    // ⚠️ `migrate` 子命令用的是同一个 `resolve_paths`：两边各写一份的话，会出现「服务端按
    // 配置里的 dbPath 找库、而迁移写到了别处」—— 用户以为迁完了，其实服务读的是另一个文件，
    // 而且**两边都不报错**。
    // ⚠️★ 而「建目录 + 开库」也一起放进去了：`uploads/` 忘了建**不会在这里报错**，
    // 只会在第一次上传时 500（`crates/android` 抄这段时正是漏了它）。
    let (paths, store) = clip9_server::paths::open_store(&data_dir_from(&args), &mut config)?;
    tracing::info!(db = %paths.db.display(), "存储已打开");
    tracing::info!(dir = %paths.uploads.display(), "文件存储目录");

    // 前端产物：**默认是编进二进制的那一份**（`rust/crates/server/static/`，见 `rust/crates/server/build.rs`），
    // `-static` / `CLIP9_STATIC` 只是把它**盖掉**（调前端时用：换了产物不用重编）。
    //
    // ⚠️★ 原来是「`-static` > `CLIP9_STATIC` > **不挂**」—— 于是桌面端那份**自带**服务端
    // 静默地没有前端：浏览器打开设置页那个「🌐 打开网页版」的地点是一片空白 **404**
    //（2026-09-28 查出，见 `docs/specs/desktop-client.md` §3.5.1.1）。
    // 现在「有没有前端」是**构建期**定的：内嵌那一份缺了会让构建失败
    //（`build.rs` 里那个 panic），运行时**不再有**「没给参数所以没有界面」这种状态。
    //
    // ⚠️ 路径由**外壳**决定（`docs/ARCHITECTURE.md` §4.2）：Docker 挂载点 / OpenWrt 的
    // `/var/lib` / Android 私有目录各不相同，把路径逻辑写进业务代码会让它们互相打架。
    let static_dir = args.get("static").map(PathBuf::from);
    match &static_dir {
        Some(dir) => {
            // ⚠️ 早点失败：指错了目录的话，表现是「页面 404」而**日志里什么都没有**，
            // 那种问题查起来最费时间。
            if !dir.join("index.html").is_file() {
                anyhow::bail!(
                    "静态目录 {} 里没有 index.html —— 那不像一份前端产物",
                    dir.display()
                );
            }
            tracing::info!(
                dir = %dir.display(),
                "前端产物：用 -static 指的这一份（盖住了内嵌的）"
            );
        }
        // ⚠️ 这行日志是「这一份到底有没有界面」的唯一线索 —— 排障时先看它一眼。
        None => tracing::info!("前端产物：用编进二进制的那一份（rust/crates/server/static）"),
    }

    // ⚠️★ 「绑定端口 + 起服务」那一段**不在这个文件里** —— 它在 `clip9_server::serve`。
    // 抽出去的理由是**一处定义**：它里面那句 `into_make_service_with_connect_info` 漏了
    // 会让直连场景的 `senderIP` 为空（不报错），而 Android 那侧也要起同一个服务端。
    // 见 `crates/server/src/serve.rs` 的模块文档。
    clip9_server::serve::serve_until_first_error(config, store, static_dir).await
}

/// 取一个**字符串**参数：**非空才算给了**。
///
/// ⚠️★ 这条不是洁癖，是 `applyCommandLineArgs` 的原文语义（Go 那边每个字符串参数都是
/// `if *flg_x != ""`），而少了它有一个**静默**的坏结果：`-auth ""` 会把配置里的密码
/// **抹掉**。⚠️ 而 `-auth ""` 恰恰是最常见的写法 —— OpenWrt 的 procd 脚本只能无条件
/// 带上它（`option auth ''` 的默认值就是空串）。
///
/// 实测（2026-09-28）：配置里写着 `"auth": "secret-pass"`，
/// 只给 `-config` 时 `POST /text` 是 **401**；多给一个 `-auth ""` 之后变成 **200**，
/// 也就是**实例变成了开放的**，而日志里一个字都没说。
fn non_empty(args: &Args, name: &str) -> Option<String> {
    args.get(name).filter(|v| !v.is_empty())
}

/// 把命令行参数盖到配置上。**语义逐条对齐 Go 的 `applyCommandLineArgs`**：
/// 字符串参数非空才覆盖（[`non_empty`]）、数字参数大于 0 才覆盖（[`positive`]）。
fn apply_flags(config: &mut Config, args: &Args) -> anyhow::Result<()> {
    // ⚠️ `-host` 支持逗号分隔（Go 那边也是），这里直接**覆盖**成字符串，
    // 由 `resolve_hosts` 统一归一（数组写法、逗号写法都收）。
    if let Some(v) = non_empty(args, "host") {
        config.server.host = serde_json::Value::String(v);
    }
    if let Some(n) = positive(args, "port")? {
        config.server.port = u16::try_from(n)
            .map_err(|_| anyhow::anyhow!("-port 的值 {n} 超出端口范围（1..65535）"))?;
    }
    if let Some(v) = non_empty(args, "auth") {
        config.server.auth = AuthValue::Str(v);
    }
    if let Some(v) = non_empty(args, "storage") {
        config.server.storage_dir = v;
    }
    if let Some(v) = non_empty(args, "dbpath") {
        // 取用点在下面算 `db_path` 的地方（配置与命令行**同一个优先级链**）。
        config.server.db_path = v;
    }
    if let Some(v) = non_empty(args, "prefix") {
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

// ⚠️★ `tls_paths` 与 `resolve_hosts` 原来在这个文件里，2026-09-28 搬去了
// `clip9_server::serve`（`crates/server/src/serve.rs`）—— 因为 Android 的 cdylib 也要起
// 同一个服务端，而「地址怎么归一、TLS 要不要起」重写一遍就会漂。
// 搬的**理由**与那一段一起写在那儿了，这里只留指针。

// ⚠️★ `Paths`（数据目录 / 库文件 / 上传目录）原来定义在这个文件里，
// 2026-09-28 跟着解析规则一起搬去了 `clip9_server::paths` —— Android 也要算同一组路径。

/// 算「库在哪、上传文件存哪」，并把结果**写回 config**（服务端后面读的是 `config.server.*`）。
///
/// ⚠️★ **服务端与 `migrate` 子命令共用这一份**。别在两边各写一份 —— 写歪了的症状是
/// 「服务端按配置里的 `dbPath` 找库，而迁移写到了别处」：用户以为迁完了，
/// 其实服务读的是另一个文件，而且**两边都不报错**。那正是这个项目最忌讳的一类。
///
/// 优先级：`-dbpath` / `-storage` > 配置文件 > 默认名（`clip9.redb` / `uploads`）。
/// （`-dbpath` / `-storage` 已经由 `apply_flags` 盖到 config 上了，所以这里只看 config。）
///
/// ⚠️★ 解析规则见 `resolve_against`：**相对路径相对数据目录**、绝对路径原样。
/// 这一版之前用的是「**值等于默认值就当没写**」的隐式魔法，配出来的效果是
/// **配置文件里写的路径 ≠ 实际用的路径**（配置里是未解析的默认值、日志里是解析值）——
/// 那正是「名字说的和实际做的不一样」，Jonny 2026-09-25 把它换掉了。
/// 数据目录。⚠️ `-data` 是**本实现独有的**（Go 不用数据库，没有「数据目录」这个概念）。
fn data_dir_from(args: &Args) -> PathBuf {
    args.get("data")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./data"))
}

/// 解析出 `Paths`（**不建目录、不开库**）—— 只有 `migrate` 用。
///
/// ⚠️★ 主程序走的是 `clip9_server::paths::open_store`（它内部会调 `resolve_into`）
/// 而不是这个函数：主程序还要建目录、开库，那三件事**必须一起**（见 `open_store` 的注释）。
/// `migrate` 则相反 —— 它要自己决定建不建目录（`-dry-run` 的承诺是「什么都不写」）。
///
/// ⚠️★ 解析规则**不在这里** —— 它在 `clip9_server::paths`（一处定义，
/// Android 与这个二进制共用）。见那个模块的文档：相对**数据目录**而不是 cwd。
fn resolve_paths(args: &Args, config: &mut Config) -> Paths {
    clip9_server::paths::resolve_into(&data_dir_from(args), config)
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
    ///
    /// ⚠️ `flags` 由调用方给：主程序与 `migrate` 子命令各有一张表（见 `FLAGS` / `MIGRATE_FLAGS`）。
    fn parse(raw: &[String], flags: &[(&str, bool, &str)]) -> anyhow::Result<Self> {
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

            let Some(&(_, takes_value, _)) = flags.iter().find(|(n, _, _)| *n == name) else {
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
    println!("\n子命令:");
    println!("  migrate           把 Go 版的数据目录迁进本实现（`clip9-server migrate -h`）");
}

/// `migrate` 子命令。
///
/// ⚠️ 为什么是子命令而不是一个参数：迁移是**一次性的运维动作**，不是启动配置 ——
/// 混进主参数表会让 `clip9-server -from x` 看起来像是「用这个数据目录启动」。
/// 而它必须在服务**打开数据库之前**跑（redb 独占锁），所以它天然是「另一件事」。
fn run_migrate(raw: &[String]) -> anyhow::Result<()> {
    // ⚠️ **不要**在这里再 `tracing_subscriber::init()` —— `main` 已经初始化过了，
    // 第二次会 panic（`Unable to install global subscriber: a global default trace
    // dispatcher has already been set`）。第一版就是这么挂的。
    let args = Args::parse(raw, MIGRATE_FLAGS)?;
    if args.has("h") {
        println!("clip9-server migrate —— 把 Go 版的数据迁进本实现\n");
        println!("用法: clip9-server migrate -from <Go 数据目录> [选项]\n");
        println!("选项:");
        for (name, takes_value, desc) in MIGRATE_FLAGS {
            let value = if *takes_value { " <值>" } else { "" };
            println!("  -{name}{value}");
            println!("        {desc}");
        }
        println!("\n示例:");
        println!("  clip9-server migrate -from /old/data -dry-run   # 先看看会做什么");
        println!("  clip9-server migrate -from /old/data            # 真跑");
        println!("\n⚠️ 幂等：重复跑会跳过已导入的，不会重复累加。");
        println!("⚠️ **原始数据一个字节都不动** —— 它是回退的唯一依据。");
        println!("⚠️ 必须在服务**停着**的时候跑（redb 是独占锁）。");
        return Ok(());
    }

    let Some(from) = args.get("from") else {
        anyhow::bail!("migrate 需要 `-from <Go 数据目录>`（用 `clip9-server migrate -h` 看用法）");
    };
    let dry_run = args.has("dry-run");

    // ⚠️★ **也要读配置文件**（`-config`，默认 `config.json`）：不然「服务端按配置里的
    // `dbPath` 找库，而迁移写到了别处」—— 用户以为迁完了，其实服务读的是另一个文件，
    // 而且两边都不报错。路径用**与主程序同一个** `resolve_paths` 算。
    //
    // ⚠️ 这里**不生成**配置文件（主程序会）—— 迁移是运维动作，顺手往 cwd 里写一个文件
    // 属于意外副作用；而且 `-dry-run` 的承诺是「什么都不写」。
    let config_path = args
        .get("config")
        .unwrap_or_else(|| "config.json".to_owned());
    let mut config = match std::fs::read_to_string(&config_path) {
        Ok(raw) => serde_json::from_str::<Config>(&raw)
            .map_err(|e| anyhow::anyhow!("配置文件 {config_path} 解析失败：{e}"))?,
        Err(e) => {
            tracing::info!(path = %config_path, error = %e, "读不到配置文件，用默认路径");
            Config::default()
        }
    };
    apply_flags(&mut config, &args)?;
    let paths = resolve_paths(&args, &mut config);

    // ⚠️ dry-run 下**一个目录都不建** —— 它的承诺是「绝对不动任何东西」。
    if !dry_run {
        for dir in [paths.db.parent(), Some(paths.uploads.as_path())]
            .into_iter()
            .flatten()
        {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| anyhow::anyhow!("无法创建目录 {}：{e}", dir.display()))?;
            }
        }
    }

    tracing::info!(
        from = %from, db = %paths.db.display(), uploads = %paths.uploads.display(), dry_run,
        "开始迁移"
    );
    let report = clip9_server::migrate::run(
        std::path::Path::new(&from),
        &paths.db,
        &paths.uploads,
        dry_run,
    )?;
    print!("{}", clip9_server::migrate::describe(&report, dry_run));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份「每个字符串字段都被人配过」的配置 —— 每个值都与默认值不同，
    /// 这样「有没有被命令行盖掉」看得出来。
    fn configured() -> Config {
        let mut c = Config::default();
        c.server.host = serde_json::Value::String("10.0.0.1".into());
        c.server.auth = AuthValue::Str("secret-pass".into());
        c.server.storage_dir = "custom-uploads".into();
        c.server.db_path = "custom.redb".into();
        c.server.prefix = "custom-prefix".into();
        c
    }

    fn parse(raw: &[&str]) -> Args {
        let raw: Vec<String> = raw.iter().map(|s| (*s).to_owned()).collect();
        Args::parse(&raw, FLAGS).expect("这些参数的名字都在 FLAGS 里")
    }

    /// ⚠️★ **空串不算「给了」** —— 这条是 Go `applyCommandLineArgs` 的原文语义
    /// （`cloud-clip/lib/flags.go` 里每个字符串参数都写着 `if *flg_x != ""`）。
    ///
    /// 少了它有一个**静默**的坏结果：`-auth ""` 会把配置里的密码**抹掉**，
    /// 实例变成开放的，而日志里一个字都不说。而 `-auth ""` 恰恰是最常见的写法 ——
    /// OpenWrt 的 procd 脚本只能无条件带上它（`option auth ''` 的缺省就是空串）。
    ///
    /// ⚠️ 五个字符串参数**一起**给是有意的：只给 `-auth` 的话，「只修了 auth 那一段」
    /// 的半吊子实现照样能过。这里要钉住的是「**这一类**参数都非空才覆盖」。
    #[test]
    fn empty_string_flags_do_not_override_the_config() {
        let mut c = configured();
        let args = parse(&["-host", "", "-auth", ""]);
        apply_flags(&mut c, &args).unwrap();
        let args = parse(&["-storage", "", "-dbpath", "", "-prefix", ""]);
        apply_flags(&mut c, &args).unwrap();

        let before = configured();
        assert_eq!(
            c.server.host, before.server.host,
            "-host \"\" 不该改监听地址"
        );
        assert_eq!(c.server.auth, before.server.auth, "-auth \"\" 不该改密码");
        assert_eq!(
            c.server.storage_dir, before.server.storage_dir,
            "-storage \"\" 不该改文件目录"
        );
        assert_eq!(
            c.server.db_path, before.server.db_path,
            "-dbpath \"\" 不该改库文件路径"
        );
        assert_eq!(
            c.server.prefix, before.server.prefix,
            "-prefix \"\" 不该改前缀"
        );
    }

    /// `-auth=` 是**另一条**解析分支（`inline` 那一支，而不是「吃下一个参数」那一支）
    /// —— 空串走哪条路都得是「没给」。
    #[test]
    fn inline_empty_flag_is_also_not_given() {
        let args = parse(&["-auth=", "-host="]);
        let mut c = configured();
        apply_flags(&mut c, &args).unwrap();

        let before = configured();
        assert_eq!(c.server.auth, before.server.auth, "-auth= 不该改密码");
        assert_eq!(c.server.host, before.server.host, "-host= 不该改监听地址");
    }

    /// **对照组**：非空的时候一定要盖上去 —— 免得上面两条被「什么都不盖」蒙混过去
    /// （那种实现会让上两条恒绿，却把参数变成彻底的摆设）。
    #[test]
    fn non_empty_string_flags_do_override_the_config() {
        let mut c = configured();
        let args = parse(&["-host", "127.0.0.1", "-auth", "newpass"]);
        apply_flags(&mut c, &args).unwrap();
        let args = parse(&["-storage", "s2", "-dbpath", "d2", "-prefix", "p2"]);
        apply_flags(&mut c, &args).unwrap();

        assert_eq!(c.server.host, serde_json::Value::String("127.0.0.1".into()));
        assert_eq!(c.server.auth, AuthValue::Str("newpass".into()));
        assert_eq!(c.server.storage_dir, "s2");
        assert_eq!(c.server.db_path, "d2");
        assert_eq!(c.server.prefix, "p2");
    }
}
