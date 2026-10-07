//! 本地服务端进程 —— 起、停、查状态。
//!
//! # 为什么它存在
//!
//! ✅ **已拍板：桌面端随包分发服务端**（`dev-docs/specs/desktop-client.md` §9.1 第 2 条）。
//! 所以「本地服务端」不是可选项，它是这个应用的一部分 —— 用户装完就该能用，
//! 而不是先去别处下一个服务端、再配一个地址。
//!
//! # 两个默认值（§3.5.2 说「这条决定了端口与数据目录的默认值」，这里定下来）
//!
//! - **端口 [`DEFAULT_PORT`]（9502），不是 9501**。9501 是**用户自己那个实例**的默认端口
//!   （`clip9-server` 与 Go 版都是）。桌面端自带的那个撞上去，两种后果都极难查：
//!   要么用户自己的服务端起不来，要么**桌面端连到了用户的服务端**（数据落错地方）。
//! - **数据目录 = 客户端数据目录下的 `server/`**：app 自己的东西全在一个目录里，
//!   备份/迁移只说一句话。⚠️ 服务端与客户端**同一套路径规则**（§5）。
//!
//! # ⚠️★ 状态是**问出来的**，不是记的
//!
//! [`ServerProcess::is_running`] 每次都去 `/server` 打一下，而不是维护一个
//! 「我起过没有」的布尔。那个布尔在三种情况下是错的，而三种都真实存在：
//! 进程被系统杀了、用户在别处手动起了一个、**上一次崩了留下一个孤儿**。
//! 它错的方向是「界面说在跑、实际没有」—— 正是这个项目最忌讳的一类。
//!
//! ⚠️ 也**不能只看 `TcpStream::connect` 成不成**：那只说明**有人**在听，
//! 而那个「有人」完全可能是别的程序。所以这里真的发一条 `GET /server` 看它答不答。
//!
//! # 这个文件里**没有** `tauri`
//!
//! 与 `store` / `runtime` 同一个理由：这些是**要测的接线**（起、等、停、探测），
//! 而绑进 Tauri 就只能靠手动点。所以它可以对着**真的 `clip9-server` 二进制**跑测试。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use clip9_client::Msg;

// ⚠️★ 报错一律是 [`Msg`]（键 + 参数），**不是成文的中文** —— 与 `store` / `commands` 同一条规矩
// （理由见 [`crate::commands`] 的模块文档）。这几条错误会走到界面上
// （「起不来」「端口上是别人」都在 `catch` 里渲染），所以句子不能留在这一侧。
// ⚠️ 唯一例外是 `default_binary` 那几条：它们现在只进 `eprintln!`（终端 / 系统日志），
// 但**照样是键** —— 免得哪天有人把它们接到界面上时忘了翻（那正是这一类问题最典型的走法）。

/// 本地服务端的默认端口。
///
/// ⚠️ **刻意不用 9501**：那是用户自己那个实例的默认端口，撞上去的后果见模块文档。
/// 9502 紧挨着它，好记，而且不撞。
pub const DEFAULT_PORT: u16 = 9502;

/// 「宿主没了就退出」那个环境变量的名字。
///
/// ⚠️★ **服务端里也有一份**（`crates/server/src/bin/clip9-server.rs` 的 `EXIT_WITH_PARENT`）。
/// 这里刻意重复：桌面端不该为了一个字符串去**链接**整个服务端（那会把 axum 拖进壳里，
/// 而壳压根不跑 HTTP）。
///
/// ⚠️★ 两份定义靠一条**端到端**的测试钉住（`a_bundled_server_dies_with_its_host`）——
/// 它真的起那个二进制、真的关掉管子。名字写错、或者这个变量哪天被改名，它当场红。
const EXIT_WITH_PARENT: &str = "CLIP9_EXIT_WITH_PARENT";

/// 起来最多等多久（超时就报错，不无限等）。
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// 探测一次的读超时。
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// 本地服务端进程的句柄。
pub struct ServerProcess {
    /// ⚠️ `None` = **我们没起过**（不代表它没在跑 —— 见 [`ServerProcess::is_running`]）。
    child: Mutex<Option<Child>>,
    /// **我们**起它的那个时刻 —— 界面上「运行时长」的唯一来源。
    ///
    /// ⚠️ 不是我们起的（端口上那个是别人跑的）时是 `None`：那时**不知道**它跑了多久。
    /// 界面上显示 `—`，而不是从「第一次看到它在跑」算起（那是编的）。
    started_at: Mutex<Option<Instant>>,
    /// 服务端二进制自己的版本（`-v`）。⚠️ **懒探一次并缓存** ——
    /// `server_status` 每次打开设置都会问，为一行版本号反复起进程不划算。
    version: Mutex<Option<String>>,
    /// **最近一次 `start` 为什么没成**（成功 / 主动停掉之后清空）。
    ///
    /// ⚠️★ 2026-09-30 加：在那之前，启动那一拍的失败**只有日志一条路**
    ///（`main.rs` 里那句 `eprintln!`），而界面读的是 `server_status` —— 端口被别人占着时
    /// 它照样说「运行中」（那条缺口记在 `main.rs` 与规格的待办里）。现在这份记录跟着
    /// 句柄留到下一次尝试，设置页那张卡读得到 —— 「起不来」于是有了常驻的去处。
    last_error: Mutex<Option<Msg>>,
    binary: PathBuf,
    data_dir: PathBuf,
    /// 配置里读不到端口时用的兜底值（正常路径上就是 [`DEFAULT_PORT`]）。
    fallback_port: u16,
}

impl ServerProcess {
    #[must_use]
    pub fn new(binary: PathBuf, data_dir: PathBuf, fallback_port: u16) -> Self {
        Self {
            child: Mutex::new(None),
            started_at: Mutex::new(None),
            version: Mutex::new(None),
            last_error: Mutex::new(None),
            binary,
            data_dir,
            fallback_port,
        }
    }

    /// **这个二进制自己的**版本（问它 `-v`，不是猜）。
    ///
    /// ⚠️★ 为什么不去读 `env!("CARGO_PKG_VERSION")`：旁边那个二进制完全可能是**别的版本**
    /// （用户手动换过 / 打包时错配 / 升级升了一半）—— 而「版本」这一行存在的意义
    /// 正是让用户发现这件事。自己报自己的版本等于把这一行变成一句废话。
    ///
    /// ⚠️ 探不出来（二进制坏了 / 不认 `-v`）就返回 `None`，界面显示 `—`。
    #[must_use]
    pub fn version(&self) -> Option<String> {
        if let Some(cached) = self
            .version
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Some(cached);
        }
        let output = Command::new(&self.binary).arg("-v").output().ok()?;
        // ⚠️ 只认**成功退出**的：失败时 stdout 可能是别的程序写的垃圾。
        if !output.status.success() {
            return None;
        }
        // 输出是 `clip9-server 0.1.0` —— 取最后一段（前面那段是程序名，用户不需要）。
        let text = String::from_utf8_lossy(&output.stdout);
        let version = text.split_whitespace().next_back()?.to_owned();
        *self.version.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.clone());
        Some(version)
    }

    /// **我们起的那个**跑了多久。不是我们起的就是 `None`（见 `started_at`）。
    #[must_use]
    pub fn uptime(&self) -> Option<Duration> {
        self.started_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|started| started.elapsed())
    }

    /// 服务端现在答不答话（**唯一的真相来源**）。
    #[must_use]
    pub fn is_running(&self) -> bool {
        probe(self.port())
    }

    /// **最近一次 [`ServerProcess::start`] 为什么没成**（成功 / 真的停掉之后清空）。
    ///
    /// ⚠️★ 界面上唯一的去处是设置页那张「本机服务端」卡（`server_status` 的 `startError`）——
    /// 「启动那一拍」失败时没有「用户点了什么」，那句话只进日志就等于没人看得见。
    #[must_use]
    pub fn last_start_error(&self) -> Option<Msg> {
        self.last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// **服务端会在哪个端口上** —— 从**它自己的配置**里读，读不到才用兜底那个。
    ///
    /// ⚠️★ 为什么不能只用构造时那个常量：用户在「服务端配置」里能改端口，
    /// 而那个改动**必须**生效。原来这里写死 `DEFAULT_PORT` 并把它当 `-port` 传下去，
    /// 而服务端那边**命令行覆盖配置**（`apply_flags`）→ **用户改哪个端口都白改**，
    /// 报出来的永远是「无法监听 0.0.0.0:9502（端口被占用？）」。
    /// Jonny 2026-09-26 的原话：「**怎么我改任何一个端口，都提示端口被占用？？？**」
    ///
    /// ⚠️ 每次现读文件（而不是缓存）：改完端口点「保存并重启」那一下就得换过去。
    /// 这条路径只在「打开设置」「起停」时走，读一个小 JSON 不算成本。
    #[must_use]
    pub fn port(&self) -> u16 {
        config_port(&config_path(&self.data_dir)).unwrap_or(self.fallback_port)
    }

    /// 配置文件不在就**先写一份**（端口用我们要起的那个）。
    ///
    /// ⚠️★ 为什么这件事得我们做：服务端自己也会写一份（`-config` 指向的文件不存在时），
    /// 但它写的是**它自己的默认值** —— 端口 **9501**，而那是**用户自己那个实例**的端口。
    /// 于是「文件说 9501、服务端实际跑在 9502」，而界面上「服务端配置」那个端口框
    /// 显示的是**文件里的值** → 两处打架，而用户只会觉得「这个数字不对」。
    ///
    /// ⚠️ 只写**默认值 + 端口**，别的一个字不加：这份文件之后归用户（和「配置可视化」）改。
    fn seed_config(&self, port: u16) -> Result<(), Msg> {
        let path = config_path(&self.data_dir);
        if path.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|reason| {
            Msg::key("configDirCreateFailed")
                .param("path", self.data_dir.display())
                .param("reason", reason)
        })?;
        let mut config = clip9_core::Config::default();
        config.server.port = port;
        let text = serde_json::to_string_pretty(&config)
            .map_err(|reason| Msg::key("configSerializeFailed").param("reason", reason))?;
        std::fs::write(&path, format!("{text}\n")).map_err(|reason| {
            Msg::key("configWriteFailed")
                .param("path", path.display())
                .param("reason", reason)
        })
    }

    /// 起一个，然后**等它真的答话**才返回。
    ///
    /// ⚠️ 只 `spawn` 不等待是不够的：进程起来了但还没 bind 端口，紧接着的请求会失败，
    /// 而用户看到的是「点了启动、然后界面说没在跑」—— 他会以为按钮坏了。
    ///
    /// # ⚠️★ 端口上已经有人答话时：**两件事长得一模一样，必须分开**（2026-09-30）
    ///
    /// | 端口上那个是谁 | 该怎么办 |
    /// |---|---|
    /// | **我们自己起的那个还活着**（本进程手里的 child） | 幂等，直接返回成功 |
    /// | **别的**（上一次没收干净的孤儿 / 用户自己跑的） | **绝不复用**，报错说清 |
    ///
    /// 原来这两种都走「已经在跑就返回成功」，于是一个**两天前**留下的孤儿服务端被新版本
    /// 的桌面端复用了 —— 界面里跑的是**两天前那一份前端**，用户看到的是「这个功能怎么没了」，
    /// 而代码一行没丢（`dev-docs` 里那次故障，`LESSONS.md §8.7`）。
    ///
    /// ⚠️★ 判据是「**我起过没有**」，不是「版本号对不对」：这个仓库的版本号只在 tag 里，
    /// 两个二进制都答 `0.1.0`，比不出来。也不是「端口上那个报的构建标识和我的对不对」——
    /// 那要求桌面端手里有**另一份事实的副本**（`build.rs` 烤一个进来，或者去解析 `-v`
    /// 的输出），而两份定义一定会漂：只重编一半时，桌面端会拿着旧副本判「端口上那个不是我的」，
    /// 于是**本机服务端永远起不来**。这里用的事实是「这个进程是不是我自己生的」——
    /// 它由内核保证，没有第二份、也不可能漂。
    ///
    /// ⚠️ 问 `try_wait()`（真的问内核）而**不是**记一个「我起过」的布尔：
    /// 服务端被系统杀掉之后，那个布尔会一直说「起过」，而这一路上「记的」正是错的那一侧。
    ///
    /// 起自带的服务端（幂等：自己起的那个还活着就只等它答话）。
    ///
    /// ⚠️★ 不管成没成，结果都**记一分**（[`ServerProcess::last_start_error`]）——
    /// 「启动那一拍」没有任何界面在看着（没有「用户点了什么」这个上下文），
    /// 失败只进日志就等于没人看得见。
    pub fn start(&self) -> Result<(), Msg> {
        let outcome = self.start_inner();
        *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) =
            outcome.as_ref().err().cloned();
        outcome
    }

    /// [`ServerProcess::start`] 的本体 —— 拆开只为在那一次结果上盖一个记录。
    fn start_inner(&self) -> Result<(), Msg> {
        // ⚠️★ 端口**每次现读配置**：用户在「服务端配置」里改完、点「保存并重启」，
        // 那一下必须真的换到新端口上（原来写死常量 → 改哪个都白改）。
        let port = self.port();
        // ① 我们自己起的那个还活着 → 幂等（等它答话就行，别再起第二个）。
        if self.owns_live_child() {
            return self.wait_until_running(port);
        }
        // ② 端口上有人，但不是我们起的 → **不复用**（见上面那张表）。
        if probe(port) {
            return Err(port_taken_by_stranger(port));
        }
        // ⚠️ 起之前先把配置准备好（见 `seed_config`）：不写的话服务端自己会写一份
        // 端口是 9501 的，而它实际跑在我们这个端口上 —— 两处打架。
        self.seed_config(port)?;
        let log_path = log_path(&self.data_dir);
        let log = std::fs::File::create(&log_path).map_err(|reason| {
            Msg::key("serverLogCreateFailed")
                .param("path", log_path.display())
                .param("reason", reason)
        })?;
        let log2 = log
            .try_clone()
            .map_err(|reason| Msg::key("serverLogCloneFailed").param("reason", reason))?;

        let child = Command::new(&self.binary)
            // ⚠️ 显式给 `-port`：与刚写下的那份配置**同一个值**（`port` 是上面读出来的）。
            // 给的是**配置里那个**，不是某个常量 —— 命令行覆盖配置（`apply_flags`），
            // 所以这里写错就等于用户改的端口不生效。
            .arg("-port")
            .arg(port.to_string())
            .arg("-data")
            .arg(&self.data_dir)
            // ⚠️★ **必须显式给 `-config`**：不给的话服务端会在**当前工作目录**写一份
            // `config.json`（它的默认值就是相对 cwd 的 `config.json`）——
            // 而桌面端进程的 cwd 可能是 `/` 或用户主目录，往那儿写文件是**不该发生**的事。
            // 给到数据目录下，那也正是 W5c 那个「配置可视化」要编辑的文件。
            .arg("-config")
            .arg(config_path(&self.data_dir))
            // ⚠️★ **给它一条管子**（`piped`）+ 告诉它「管子断了就退出」——
            // 这两句是**一对**，少一句都白搭（详见 `CLIP9_EXIT_WITH_PARENT` 的文档）。
            // 有它之后，宿主**无论怎么死**（优雅退出 / 崩溃 / 被强杀 / 升级时被替换）
            // 这个子进程都会跟着退 —— 孤儿从源头没有了。
            .stdin(Stdio::piped())
            .env(EXIT_WITH_PARENT, "1")
            .stdout(Stdio::from(log2))
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|reason| {
                Msg::key("serverSpawnFailed")
                    .param("path", self.binary.display())
                    .param("reason", reason)
            })?;
        *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

        self.wait_until_running(port)
    }

    /// 等端口**真的答话**（超时就报错，错误里带上日志最后一行）。
    ///
    /// ⚠️ 拆出来是因为有**两条**路要等：刚 `spawn` 完那条，以及「自己起的那个已经活着」
    /// 那条（幂等调用）。两条等待的语义、超时、失败话术必须一样 —— 写两份就会漂。
    fn wait_until_running(&self, port: u16) -> Result<(), Msg> {
        let log_path = log_path(&self.data_dir);
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if probe(port) {
                // ⚠️ 起来了才记时刻（「运行时长」那一行靠它）。记在 spawn 那一刻的话，
                // 一个起不来的进程也会让界面显示「跑了 5 分钟」。
                *self.started_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        // ⚠️ 端口报**这一个**（刚起时用的那个），别现读一次配置 ——
        // 中间被人改过的话，报出来的会是一个根本没试过的端口。
        Err(start_failure(&log_path, port))
    }

    /// **本进程起的那个服务端还活着吗**（真的问内核，不是记的）。
    ///
    /// ⚠️★ 只有这一句能回答「端口上那个是不是我的」：
    /// `try_wait()` 给 `Ok(None)` = 子进程还在跑；`Ok(Some(_))` = 它已经退出了
    ///（那时端口上那个**一定**是别人）。
    ///
    /// ⚠️★ 2026-09-30 起是 `pub`：`server_status` 要用它回答「端口上那个到底是不是
    /// 这个客户端起的」——在那之前只有内部控制流在问它。
    pub fn owns_live_child(&self) -> bool {
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            // ⚠️ 没起过（或者已经被 `stop` 收走了）→ 端口上那个不可能是我们的。
            None => false,
        }
    }

    /// 我们起的那个服务端的 PID（没起过 / 已经收走了 → `None`）。
    ///
    /// ⚠️★ 给「关于」页的资源占用用（`resources` 模块按 PID 采它的 CPU 与内存）。
    /// ⚠️ **不是**把 `child` 那把锁暴露出去 —— 调用方只需要一个号码，
    /// 拿到 `Child` 就能 `kill` 它，那是另一件事。
    ///
    /// ⚠️ PID 会**回收**：这个号码只在「我们确实还持有那个 `Child`」时有意义
    ///（`owns_live_child` 为真）。采样的调用方要先问它，别拿一个陈旧的 PID 去查 ——
    /// 那可能查到一个完全无关的进程，然后把它的内存算到这个应用头上。
    #[must_use]
    pub fn child_pid(&self) -> Option<u32> {
        if !self.owns_live_child() {
            return None;
        }
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_mut().map(|child| child.id())
    }

    /// 停掉**我们起的那个**。
    ///
    /// ⚠️ 只管自己起的：**不碰**用户自己在别处跑的服务端（那个可能正连着他的手机）。
    /// ⚠️ 用 `kill()`（SIGKILL）而不是优雅退出：redb 的写是事务性的、崩溃安全，
    /// 而「优雅退出」要跨平台发信号（`libc` / Windows 控制台事件），
    /// 为一个「用户点停止」的动作引入那套不划算。见 `ARCHITECTURE.md` 的崩溃安全那条。
    pub fn stop(&self) -> Result<(), Msg> {
        let taken = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        // ⚠️ 时刻要跟着一起清：不清的话「停了之后」界面还会显示「运行时长 2 小时」。
        *self.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let Some(mut child) = taken else {
            // 没起过 —— 但要**说清**是「我们没起过」，而不是「已经停好了」。
            return if self.is_running() {
                Err(Msg::key("foreignServerNotStopped").param("port", self.port()))
            } else {
                Ok(())
            };
        };
        child
            .kill()
            .map_err(|reason| Msg::key("serverStopFailed").param("reason", reason))?;
        // ⚠️ 收尸：不 `wait` 的话会留下僵尸进程（在 Linux 上看得见）。
        let _ = child.wait();
        // ⚠️ 失败记录也一起清：真的把服务端停下来了，那「上次为什么没起来」就已经翻篇了。
        *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }
}

/// 端口上**是不是我们的服务端**。
///
/// ⚠️★ 只连上 TCP 不算：那只说明**有人**在听。所以真的发一条 `GET /server`，
/// 看它答不答 200 —— 只有答得像我们的服务端才算数。
///
/// ⚠️ 为什么手写这一小段 HTTP 而不是引一个客户端：这是**本机回环上的一次健康检查**，
/// 不需要 TLS、不需要重定向、不需要连接池。而 `reqwest` 那边是异步的，
/// 这个模块（和它的调用方 `store`）是同步的 —— 为一次探测把整条链改成异步不划算。
#[must_use]
pub fn probe(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let request =
        format!("GET /server HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    let Ok(read) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..read]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// 服务端二进制在哪：**和这个可执行文件同一个目录**。
///
/// ⚠️ 打包后它就在旁边（W4 要把 `clip9-server` 放进 bundle）；开发时
/// `target/debug/` 里两个都在 —— **同一条规则两边都成立**，所以这里不用写平台分支
/// 或者「debug 走这条、release 走那条」。
pub fn default_binary() -> Result<PathBuf, Msg> {
    let exe = std::env::current_exe()
        .map_err(|reason| Msg::key("binaryPathUnavailable").param("reason", reason))?;
    let dir = exe
        .parent()
        .ok_or_else(|| Msg::key("binaryNoParent").param("path", exe.display()))?;
    let name = if cfg!(windows) {
        "clip9-server.exe"
    } else {
        "clip9-server"
    };
    let path = dir.join(name);
    if !path.is_file() {
        return Err(Msg::key("binaryNotFound").param("path", path.display()));
    }
    Ok(path)
}

/// 服务端配置文件在哪：`<服务端数据目录>/config.json`。
///
/// ⚠️★ **起服务端和「配置可视化」必须用同一个路径** —— 所以它是**一个函数**，
/// 不是两处各写一遍 `join("config.json")`。写歪了的症状是
/// 「界面上改了、保存了，服务端读的却是另一个文件」：**保存成功、毫无效果**，
/// 而那正是这个项目最忌讳的一类。
#[must_use]
pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

/// 服务端配置里写的端口（`None` = 文件不在 / 读不出来 / 值不合法）。
///
/// ⚠️ 用 `clip9_core::Config` 解析（**服务端自己那个类型**），不手搓 JSON ——
/// 手搓一份就是「第二份定义」，而它一定会漂（这个项目为这个付过几次代价）。
/// ⚠️ 顺带白拿一件事：`Config` 上挂着一堆 `#[serde(default)]`，所以
/// 「用户手写了一份只写了端口的最小配置」也读得出来 —— 那正是 [`ServerProcess::seed_config`]
/// 写下去的形状。
fn config_port(path: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: clip9_core::Config = serde_json::from_str(&raw).ok()?;
    // ⚠️ 端口 0 不合法（那是「让系统随便挑一个」的意思，而这里要一个确定的数）。
    (parsed.server.port > 0).then_some(parsed.server.port)
}

/// 服务端日志在哪：`<服务端数据目录>/server.log`（`start()` 把子进程的 stdout/stderr 都倒进去）。
///
/// ⚠️ 与 [`config_path`] 同一个理由：**起服务端和「查看日志」必须用同一个路径**。
/// 两处各写一遍 `join("server.log")`，写歪了就是「日志页永远说没有日志」。
#[must_use]
pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.log")
}

/// 端口上那个服务端**不是本进程起的** —— 报错说清，并尽量告诉用户那是哪一版。
///
/// ⚠️ 两条键（问得到它的构建标识 / 问不到）而不是一句模板塞个空值：它们不一样 ——
/// 「它答得出自己发的是哪一版」与「它旧到连这个都不报」是两件事，而后者恰恰是
/// 「那是个很旧的服务端」的样子。用同一句模板加个空参数，用户看到的是
/// 「它在发 版前端」这种半截话。（`serverStartTimeout` 那两条键是同一个理由。）
fn port_taken_by_stranger(port: u16) -> Msg {
    match served_build(port) {
        Some(build) => Msg::key("serverPortTaken")
            .param("port", port)
            .param("build", build),
        None => Msg::key("serverPortTakenUnknown").param("port", port),
    }
}

/// **端口上那个服务端说自己在发哪一版前端**（`GET /server` 的 `staticBuild`）。
///
/// ⚠️★ 它**不参与**「要不要复用」那个判据（那个判据是「我起过没有」，见 [`ServerProcess::start`]）。
/// 它唯一的用途是让那句报错**说得具体**：用户看到「它在发 `9089fa78` 这一版前端」，
/// 就知道「哦，是个旧版本」，而不是对着一句「端口被占用」干着急
/// ——2026-09-30 那次光把「界面是旧的」定位到「端口上那个服务端是旧的」花了大半天。
///
/// ⚠️ `None` = 问不到（没在跑 / 不是我们的服务端 / 它太旧、没有这个字段）。
fn served_build(port: u16) -> Option<String> {
    let body: serde_json::Value = serde_json::from_str(&get(port, "/server")?).ok()?;
    body.get("staticBuild")?.as_str().map(str::to_owned)
}

/// 起不来时给用户的那句话 —— **带上日志里最后一行**。
///
/// ⚠️★ 原来这里写的是「（端口 {port} 可能被别的程序占了）」—— 那是**猜**，
/// 而且猜错的方向很坏：库里那个 redb 被**另一个进程**占着时，服务端报的是
/// `Database already open. Cannot acquire lock.`，与端口**一点关系都没有**。
/// 用户拿着「端口被占用」这条假线索去换端口 —— 换到天亮也没用。
/// Jonny 2026-09-26 就是这么撞上的：「**怎么我改任何一个端口，都提示端口被占用？？？**」
///
/// ⚠️ 日志是 `File::create` 打开的（每次起服务端都会**截断重写**），所以最后一行
/// 就是**这一次**失败的原因 —— 不会串到上一次去。
///
/// ⚠️★ **两条键**（有日志 / 一行都没写）而不是一句模板塞个空值：那两件事不一样
/// （「写了日志但没起来」与「连一行都没写出来就死了」），而后者恰恰是「二进制根本起不来」
/// 的样子 —— 用同一句模板加个空参数，用户看到的是「日志最后一行：」后面什么都没有。
fn start_failure(log_path: &Path, port: u16) -> Msg {
    let reason = std::fs::read_to_string(log_path).ok().and_then(|text| {
        text.lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned)
    });
    match reason {
        // ⚠️ 日志里那一行是**服务端写的原文**（不是我们的话）—— 但它作为一个**参数**
        // 进来，参数天生就是原样插入的，所以不需要 `Msg::verbatim` 再多包一层。
        Some(reason) => Msg::key("serverStartTimeout")
            .param("seconds", START_TIMEOUT.as_secs())
            .param("port", port)
            .param("reason", reason)
            .param("log", log_path.display()),
        None => Msg::key("serverStartTimeoutNoLog")
            .param("seconds", START_TIMEOUT.as_secs())
            .param("port", port)
            .param("log", log_path.display()),
    }
}

/// 本机那份服务端的房间 / 条目统计（`GET /rooms`）。
///
/// ⚠️★ **问不到就是 `None`，不编一个数**：服务端的「房间列表」**默认是关的**
///（`server.roomList: false`）→ 那时它回 403；受保护的房间 / 服务端回 401；
/// 它没在跑当然也问不到。界面显示 `—` —— 这一行是给用户看「这个服务端上有什么」的，
/// 编一个数字比空着坏得多。
#[must_use]
pub fn room_summary(port: u16) -> Option<(usize, u64)> {
    let body: serde_json::Value = serde_json::from_str(&get(port, "/rooms")?).ok()?;
    let rooms = body.get("rooms")?.as_array()?;
    let entries = rooms
        .iter()
        .filter_map(|room| room.get("messageCount").and_then(serde_json::Value::as_u64))
        .sum();
    Some((rooms.len(), entries))
}

/// 本机回环上发一条 GET，把 body 读回来（`None` = 没答 200 / 读不动）。
///
/// ⚠️ 与 [`probe`] 同一套理由（手写、同步、只认回环）：这是**本机的一次读**，
/// 不需要 TLS / 重定向 / 连接池，而 `reqwest` 那边是异步的、这个模块是同步的。
/// ⚠️ 靠 `Connection: close` + 读到底拿 body（这份服务端的 JSON 响应**都带
/// `content-length`**，实测过），所以这里不处理分块编码。哪天它换成流式响应，
/// 这里会拿到一个带块头的 body、解析失败 → 给 `None`（**不是静默给一个错的数**）。
fn get(port: u16, path: &str) -> Option<String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return None;
    }
    Some(body.to_owned())
}

/// 拼一个**客户端能拿去填进房间的**地址：`http://127.0.0.1:9502`（带子路径前缀）。
///
/// ⚠️★ 两个坑，都是「看着对、其实连不上」那一类：
///
/// ① **`host` 是绑定地址，不是连接地址。** 配成 `0.0.0.0` / `::` / 空 = 「监听所有网卡」，
///    照抄给用户会得到一个连不上的地址 —— 客户端要连的是**回环**。
///    所以这三个值一律换成 `127.0.0.1`。
/// ② **端口不是配置里那个** —— 见 [`ServerProcess::port`] 的文档。
///
/// ⚠️ `tls` 为真时给 `https://`：服务端配了证书就是 TLS，而地址写错协议
/// 症状是「打开网页版一片空白」，与「服务端没起来」长得一样。
#[must_use]
pub fn client_url(host: &str, port: u16, prefix: &str, tls: bool) -> String {
    let scheme = if tls { "https" } else { "http" };
    let prefix = prefix.trim().trim_end_matches('/');
    let path = if prefix.is_empty() {
        String::new()
    } else {
        format!("/{}", prefix.trim_start_matches('/'))
    };
    format!("{scheme}://{}:{port}{path}", client_host(host))
}

/// 配置里的 `host` → **客户端能用的主机名**（[`client_url`] 与界面上的「监听」那一行都用它）。
///
/// ⚠️ 配置里 host 允许写逗号分隔的一串（`resolve_hosts` 收），取第一个就够。
/// ⚠️ IPv6 的字面量要带方括号才是合法的 URL 主机（`[::1]`）。
#[must_use]
pub fn client_host(host: &str) -> &str {
    match host.split(',').next().unwrap_or_default().trim() {
        // 空 / 监听所有网卡 —— 那三个都是**绑定**地址，客户端要连的是回环。
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        "::1" => "[::1]",
        other => other,
    }
}

/// 服务端数据目录：客户端数据目录下的 `server/`。
///
/// ⚠️ 放进客户端的数据目录里（而不是服务端自己的默认位置）：
/// **app 的东西全在一个目录里**，备份/迁移/卸载只说一句话。
#[must_use]
pub fn data_dir_under(client_data_dir: &Path) -> PathBuf {
    client_data_dir.join("server")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个**空闲**端口。
    ///
    /// ⚠️ 绑 0 让系统分配、拿到号之后立刻放掉 —— 中间有一瞬间的竞态，
    /// 但对测试足够了（比硬编码一个号强：硬编码会和开发机上别的东西撞）。
    fn free_port() -> u16 {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("绑 0");
        let port = listener.local_addr().expect("取端口").port();
        drop(listener);
        port
    }

    /// 本仓库里的 `clip9-server`（测试时它和测试二进制在同一个 `target/debug/deps` 的**上一级**）。
    fn test_binary() -> PathBuf {
        let mut path = std::env::current_exe().expect("取测试二进制路径");
        path.pop(); // 去掉文件名
        if path.ends_with("deps") {
            path.pop();
        }
        path.join("clip9-server")
    }

    /// ⚠️★ 探测**不能只连 TCP** —— 这一条就是钉这个的：
    /// 随便开一个只会 accept、不会答 HTTP 的监听端口，`probe` 必须返回 `false`。
    /// 只 connect 的写法在这里会返回 `true`，而后果是「界面上说服务端在跑」，
    /// 实际那个端口上是个别的程序。
    #[test]
    fn a_port_that_answers_nothing_is_not_our_server() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("绑 0");
        let port = listener.local_addr().expect("取端口").port();
        // ⚠️ 故意**不 accept**：连得上（内核 backlog），但永远不会答话。
        assert!(
            !probe(port),
            "一个只会占着端口的监听器不该被当成我们的服务端"
        );
        drop(listener);

        // 没人听的端口当然也不是。
        assert!(!probe(free_port()));
    }

    /// ⚠️★ 端口**以配置为准**（不是那个常量）—— 用户能在「服务端配置」里改它。
    ///
    /// 原来 `start()` 传的是 `DEFAULT_PORT`，而服务端那边**命令行覆盖配置**
    ///（`apply_flags`）→ 用户改哪个端口都白改，日志里报的永远是
    ///「无法监听 0.0.0.0:9502（端口被占用？）」。Jonny 2026-09-26 的原话：
    ///「**怎么我改任何一个端口，都提示端口被占用？？？**」
    #[test]
    fn the_port_comes_from_the_config_not_from_a_constant() {
        let dir = tempfile::tempdir().expect("建临时目录");
        let data = dir.path().join("server");
        std::fs::create_dir_all(&data).expect("建目录");
        // ⚠️ 二进制故意指一个不存在的路径：这条测试**只碰文件**，不起进程。
        let server = ServerProcess::new(PathBuf::from("/nonexistent"), data.clone(), DEFAULT_PORT);

        assert_eq!(server.port(), DEFAULT_PORT, "配置不在就用兜底端口");

        // 配置里写了端口 → 以它为准（这正是用户在界面上改的那个值）。
        std::fs::write(config_path(&data), r#"{"server":{"port":9600}}"#).expect("写配置");
        assert_eq!(server.port(), 9600, "配置说了算");

        // ⚠️ 端口 0 不合法（那是「让系统随便挑一个」的意思）→ 退回兜底值，
        // 而不是拿 0 去 bind（那会绑到一个随机端口，界面上的地址就成了假的）。
        std::fs::write(config_path(&data), r#"{"server":{"port":0}}"#).expect("写配置");
        assert_eq!(server.port(), DEFAULT_PORT, "0 不是合法端口，要用兜底那个");

        // 文件坏了也一样：退回兜底值，而不是让整个起停流程崩掉。
        std::fs::write(config_path(&data), "这不是 JSON").expect("写配置");
        assert_eq!(server.port(), DEFAULT_PORT);
    }

    /// ⚠️ 起之前**先写一份配置**（端口与我们要起的一致）。
    ///
    /// 不写的话服务端自己会写一份 —— 而那份的端口是**它自己的默认值 9501**
    ///（那是用户自己那个实例的端口）→「文件说 9501、服务端实际跑在别处」，
    /// 而「服务端配置」那个端口框显示的是**文件里的值**：两处打架，用户只会觉得数字不对。
    #[test]
    fn starting_seeds_the_config_with_the_port_we_use() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let data = dir.path().join("server");
        let port = free_port();
        let server = ServerProcess::new(binary, data.clone(), port);

        assert!(
            !config_path(&data).exists(),
            "起之前不该有配置文件（这条测试要验的正是「起的时候补上」）"
        );
        server.start().expect("起服务端");

        let text = std::fs::read_to_string(config_path(&data)).expect("配置该被写出来");
        assert!(
            text.contains(&port.to_string()),
            "配置里该写着我们起的那个端口 {port}：{text}"
        );
        // ⚠️ 而且它得是**能读回来**的那一份（`config_port` 用它决定下一次起在哪个端口）。
        assert_eq!(config_port(&config_path(&data)), Some(port));

        server.stop().expect("停");
    }

    /// ⚠️★ 拼给用户看的连接地址：**绑定地址要换成回环、端口用进程那个、前缀要带上**。
    ///
    /// 这条错了的症状是「界面给了个地址，填进房间连不上」—— 而用户会以为是服务端的问题，
    /// 跑去查一个没错的地方。`0.0.0.0` 是**绑定**地址（监听所有网卡），
    /// 拿它当**连接**地址用是这类界面最常见的一个坑。
    #[test]
    fn the_client_url_swaps_the_bind_address_for_the_loopback() {
        // 监听所有网卡 ≠ 客户端能拿它当地址用。
        assert_eq!(
            client_url("0.0.0.0", 9502, "", false),
            "http://127.0.0.1:9502"
        );
        assert_eq!(client_url("::", 9502, "", false), "http://127.0.0.1:9502");
        assert_eq!(client_url("", 9502, "", false), "http://127.0.0.1:9502");
        // 明确写回环 / 局域网地址时原样用（局域网那种是给手机连的）。
        assert_eq!(
            client_url("127.0.0.1", 9502, "", false),
            "http://127.0.0.1:9502"
        );
        assert_eq!(
            client_url("192.168.1.9", 9502, "", false),
            "http://192.168.1.9:9502"
        );
        // 逗号分隔取第一个；IPv6 字面量要带方括号（不然拼出来不是合法 URL）。
        assert_eq!(
            client_url("0.0.0.0,::1", 9502, "", false),
            "http://127.0.0.1:9502"
        );
        assert_eq!(client_url("::1", 9502, "", false), "http://[::1]:9502");
        // 子路径前缀（反代到 /clip）与 TLS。
        assert_eq!(
            client_url("0.0.0.0", 9502, "/clip/", false),
            "http://127.0.0.1:9502/clip"
        );
        assert_eq!(
            client_url("0.0.0.0", 9502, "clip", true),
            "https://127.0.0.1:9502/clip"
        );
    }

    /// 起 → 探测到 → 停 → 探测不到。对着**真的 `clip9-server`** 跑。
    ///
    /// ⚠️ 用临时目录 + 动态端口：**绝不能碰 9501 / 9502**（9501 是 Jonny 的正式实例）。
    #[test]
    fn it_starts_stops_and_reports_the_truth() {
        let binary = test_binary();
        if !binary.is_file() {
            // ⚠️ 没编出来就跳过（而不是失败）：这个测试验的是**进程管理**，
            // 不是「服务端能不能编译」—— 后者由别的门禁管。
            eprintln!(
                "跳过：{} 不在（先 cargo build -p clip9-server）",
                binary.display()
            );
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let data = dir.path().join("server");
        let port = free_port();
        let server = ServerProcess::new(binary, data.clone(), port);

        assert!(!server.is_running(), "还没起，不该说在跑");
        server.start().expect("起服务端");

        assert!(server.is_running(), "起来了就该探测到");
        // ⚠️ 起来了才有「运行时长」—— 记在 spawn 那一刻的话，一个起不来的进程
        // 也会让界面显示「跑了 5 分钟」。
        assert!(server.uptime().is_some(), "起来了就该有运行时长");
        // ⚠️ `-config` 要落在**数据目录**里，不是 cwd —— 这一条钉的就是那个坑。
        // ⚠️ 现在这份是**我们**先写下的（`seed_config`），服务端看到文件在就不再写 ——
        // 所以它同时也是「配置里的端口与实际起的端口一致」那条的落点。
        assert!(
            data.join("config.json").is_file(),
            "配置该在数据目录下（{}）",
            data.display()
        );

        // ⚠️★ 「房间 / 条目」那一行：服务端的**房间列表默认是关的**（`roomList: false`）→
        // `GET /rooms` 回 403 → 这里必须是 `None`，界面显示 `—`。
        // 这一条钉的是「**问不到就说问不到，不编一个数**」—— 编了的话，
        // 用户会拿它去判断「这个服务端上有什么」，而那是个假数字。
        assert!(
            room_summary(server.port()).is_none(),
            "房间列表没开时问不到，该给 None 而不是编一个数"
        );

        // ⚠️ 「版本」要问**那个二进制自己**（不是 `env!("CARGO_PKG_VERSION")`）——
        // 旁边那个二进制完全可能是别的版本，而这一行存在的意义就是让人发现这件事。
        let version = server.version().expect("问得到版本");
        assert!(
            !version.is_empty() && version.contains('.'),
            "版本：{version}"
        );

        server.stop().expect("停服务端");
        assert!(!server.is_running(), "停了就不该再探测到");
        // ⚠️ 「运行时长」也要跟着清 —— 不清的话停了之后界面还显示「跑了 2 小时」。
        assert!(server.uptime().is_none(), "停了就没有运行时长");
    }

    /// ⚠️★ **端口上那个不是自己起的 → 绝不复用**（2026-09-30 那次故障的回归测试）。
    ///
    /// 那次是：上一次没收干净的孤儿服务端（两天前那一版）占着 9502，新版本的桌面端
    /// 探测到有人答话就复用它 —— 于是界面里跑的是两天前那一份前端，
    /// 用户看到的是「这个功能怎么没了」，而代码一行没丢。
    #[test]
    fn start_refuses_a_server_it_did_not_start() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let port = free_port();

        // A：上一次留下的那个（这里用同一个二进制模拟 —— 关键在**不是 B 起的**）。
        let a = ServerProcess::new(binary.clone(), dir.path().join("a"), port);
        a.start().expect("A 起");

        // B：新一次启动的桌面端。它手里没有 child → 端口上那个不是它的。
        let b = ServerProcess::new(binary, dir.path().join("b"), port);
        let err = b.start().expect_err("端口上那个不是自己起的，不许复用");
        // ⚠️ 只钉**键**（与 `stop_refuses_to_kill_a_server_we_did_not_start` 同一条规矩）：
        // 那句话住在 `ui/i18n.js` 里，改文案不该让这条测试红。
        // ⚠️★ 键是 `serverPortTaken`（而**不是** `serverPortTakenUnknown`）这件事本身
        // 也在钉 `served_build`：A 是个真的服务端，它答得出自己在发哪一版。
        assert_eq!(err.key, "serverPortTaken", "要说清为什么不起：{err:?}");
        let build = err
            .params
            .get("build")
            .and_then(clip9_client::ParamValue::as_str);
        assert!(
            build.is_some_and(|value| !value.is_empty()),
            "该把「它在发哪一版前端」一起报出来（用户一眼就知道那是个旧版本）：{err:?}"
        );
        // ⚠️ 只是**拒绝复用**，不是去停它 —— A 必须还活着（`stop` 那条的边界同此）。
        assert!(a.is_running(), "不许动别人的服务端");
        a.stop().expect("A 自己停");
    }

    /// ⚠️★ **我们自己起的那个已经死了**（句柄还在手里）→ 端口上那个照样不是我们的。
    ///
    /// 这一条钉的是「**问内核**，不是记一个『我起过』的布尔」：判据是
    /// `try_wait()`（真的问这个进程还在不在），而**不是**「`self.child` 里有没有东西」。
    /// 两种写法在本文件**别处**的测试里看不出区别（那几处的句柄要么是活的、要么是 `None`），
    /// 只有这一条分得开 —— 而它正是 2026-09-30 那次故障的形状：上一次那个服务端**已经不在了**
    /// （崩了 / 被换掉了），同一个端口上换了**另一个**东西在答话。
    /// ⚠️ 若写成「句柄非空就算我的」，这里会**静默复用**端口上那个陌生服务端 —— 也就是
    ///「界面怎么是旧的」的原路。
    #[test]
    fn a_dead_child_does_not_make_us_claim_the_port() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let port = free_port();

        // A 起了自己的那一个，然后把它**弄死、但把句柄留在手里**。
        // ⚠️ 刻意不走 `stop()`（那会清掉句柄）—— 要的就是「句柄还在、进程没了」这个形状，
        // 它对应的是「它自己崩了」或「被人从外面杀了」，而不是「我们停的」。
        let a = ServerProcess::new(binary.clone(), dir.path().join("a"), port);
        a.start().expect("A 起");
        {
            let mut guard = a.child.lock().unwrap_or_else(|e| e.into_inner());
            let child = guard.as_mut().expect("刚起的那个该在手里");
            child.kill().expect("杀掉它");
            // ⚠️ 收尸（不然它是个僵尸，端口仍然占着）。
            let _ = child.wait();
        }
        assert!(
            wait_until_port_is_quiet(&a, Duration::from_secs(10)),
            "A 那个死了，端口该空出来"
        );

        // 别人占了同一个端口。
        let b = ServerProcess::new(binary, dir.path().join("b"), port);
        b.start().expect("B 起");

        // ★ A 手里的句柄**还在**（只是已经退出）—— 不许因此就说「端口上那个是我的」。
        let err = a
            .start()
            .expect_err("自己那个已经死了：端口上那个不是我们的");
        assert_eq!(err.key, "serverPortTaken", "该拒绝复用：{err:?}");
        b.stop().expect("B 自己停");
    }

    /// ⚠️★ 宿主没了 → 自带的那个服务端**跟着退**（孤儿从源头消失）。
    ///
    /// 这一条钉的是**一处跨 crate 的约定**：`EXIT_WITH_PARENT` 这个名字在桌面端与
    /// `clip9-server` 里各写了一遍（壳不该为了一个字符串去链接整个服务端，那会把 axum
    /// 拖进来）。名字写错、或者哪天被改名，症状是「孤儿又回来了」—— 而那是**无症状的**，
    /// 要等到下一次「界面怎么是旧的」才会暴露。所以这里**真的起那个二进制、真的关掉那条管子**。
    ///
    /// ⚠️★ 下面有**对照组**：同一个二进制、**不给**那个变量时，关掉管子它**不会**退。
    /// 少了它，这一条可能因为别的原因变绿（比如二进制根本没起来 → 一直「不在跑」）。
    #[test]
    fn a_bundled_server_dies_with_its_host() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");

        // ① 桌面端起的那个（`start()` 会带管子 + 那个变量）。
        let port = free_port();
        let server = ServerProcess::new(binary.clone(), dir.path().join("ours"), port);
        server.start().expect("起服务端");
        assert!(server.is_running(), "先确认它真的在跑");

        // ★ 模拟「宿主没了」：**只**关掉那条管子的写端。真实的宿主死亡（含 `SIGKILL`）
        //   在内核看来就是这个效果。⚠️ 这里刻意**不调 `stop()`** —— 要验的正是
        //  「不用谁去 kill 它，它自己走」。
        {
            let mut guard = server.child.lock().unwrap_or_else(|e| e.into_inner());
            let child = guard.as_mut().expect("刚起的那个该在手里");
            drop(child.stdin.take());
        }
        assert!(
            wait_until_port_is_quiet(&server, Duration::from_secs(10)),
            "宿主没了之后它该自己退出 —— 不然孤儿就会一直占着 9502"
        );

        // ② 对照组：同一个二进制，**不给**那个变量。
        let port = free_port();
        let data = dir.path().join("no-variable");
        std::fs::create_dir_all(&data).expect("建目录");
        let mut raw = Command::new(&binary)
            .arg("-port")
            .arg(port.to_string())
            .arg("-data")
            .arg(&data)
            // ⚠️ 必须给 `-config`：不给的话服务端会在**当前工作目录**写一份 config.json。
            .arg("-config")
            .arg(config_path(&data))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("起对照那个");
        assert!(
            port_answers_within(port, Duration::from_secs(15)),
            "对照组那个该起来"
        );
        drop(raw.stdin.take());
        std::thread::sleep(Duration::from_secs(3));
        assert!(
            probe(port),
            "没给那个变量时，管子断了它**不该**退 —— 否则这一条测的根本不是那个变量"
        );
        let _ = raw.kill();
        let _ = raw.wait();
    }

    /// 等它**不再答话**（最多等 `limit`）。
    fn wait_until_port_is_quiet(server: &ServerProcess, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if !server.is_running() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// 等端口**开始答话**（对照那一组用的裸进程，没有 `ServerProcess` 可问）。
    fn port_answers_within(port: u16, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if probe(port) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// ⚠️ 重复 `start` 不该起第二个进程（第二个会 bind 失败、静默退出，
    /// 而界面上「看起来起了」）。已经在跑时直接返回成功。
    #[test]
    fn starting_twice_is_idempotent() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let port = free_port();
        let server = ServerProcess::new(binary, dir.path().join("server"), port);

        server.start().expect("第一次");
        server.start().expect("第二次也该成功（幂等）");
        assert!(server.is_running());
        server.stop().expect("停");
        assert!(!server.is_running());
    }

    /// ⚠️★ **没起过的服务端不许乱停**：如果端口上那个不是我们起的
    /// （用户自己跑了一个），`stop` 要**拒绝**并说清 —— 那个可能正连着他的手机。
    #[test]
    fn stop_refuses_to_kill_a_server_we_did_not_start() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let port = free_port();

        // A 起了一个。
        let a = ServerProcess::new(binary.clone(), dir.path().join("a"), port);
        a.start().expect("A 起");

        // B 是另一个句柄（没起过任何东西），它不该去停 A。
        let b = ServerProcess::new(binary, dir.path().join("b"), port);
        let err = b.stop().expect_err("没起过就不该停");
        // ⚠️★ 只钉**键**（与 `store` / `client` 的测试同一条规矩）：
        // 那句话现在住在 `ui/i18n.js` 的 `foreignServerNotStopped` 那一条里，
        // 服务端这边只负责说「是这件事、端口是这个」。改文案不该让这条测试红。
        assert_eq!(
            err.key, "foreignServerNotStopped",
            "要说清为什么不停：{err:?}"
        );
        assert_eq!(
            err.params
                .get("port")
                .and_then(clip9_client::ParamValue::as_str),
            Some(port.to_string().as_str()),
            "要说清是哪个端口：{err:?}"
        );
        assert!(a.is_running(), "A 必须还活着");

        a.stop().expect("A 自己停");
    }

    /// ⚠️★ **起不来的时候要把原因留下来**（2026-09-30 加）。
    ///
    /// 「启动那一拍」（随客户端启动 / 开机自启）没有任何界面在看着 —— 失败只进日志
    /// 就等于没人看得见。这条记录是设置页那张卡的唯一来源
    ///（`last_start_error` → `ServerStatusView::start_error`）。
    #[test]
    fn a_failed_start_remembers_why() {
        let dir = tempfile::tempdir().expect("建临时目录");
        let process = ServerProcess::new(
            PathBuf::from("/definitely/not/a/clip9-server"),
            dir.path().to_path_buf(),
            free_port(),
        );
        let reason = process.start().expect_err("这个二进制不存在，起不来");
        // ⚠️ 只钉**键**（与别处同一条规矩）：句子住在 `ui/i18n.js` 里。
        assert_eq!(
            reason.key, "serverSpawnFailed",
            "起不来要说得出是哪一类：{reason:?}"
        );
        let recorded = process
            .last_start_error()
            .expect("起不来却什么都没记 —— 设置页那张卡就没得说了");
        assert_eq!(recorded.key, reason.key, "记下来的该是同一个原因");
    }

    /// 同一条记录的另一半：**成功之后要清掉**。
    ///
    /// ⚠️ 直接往字段里种一条（测试就在同一个模块，字段是私有的）—— 这条要钉的是
    /// 「`start` 成功之后它变回 `None`」，而不是「怎么失败」（上一条已经钉了）。
    /// 不清的症状：卡上一直挂着一条早就过去的失败，而灯已经是「运行中」。
    #[test]
    fn a_good_start_clears_the_remembered_reason() {
        let binary = test_binary();
        if !binary.is_file() {
            eprintln!("跳过：{} 不在", binary.display());
            return;
        }
        let dir = tempfile::tempdir().expect("建临时目录");
        let process = ServerProcess::new(binary, dir.path().join("data"), free_port());
        *process.last_error.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Msg::key("serverPortTaken"));

        process.start().expect("起自带的服务端");
        assert!(
            process.last_start_error().is_none(),
            "起来了就该把上一次的失败清掉 —— 否则卡上会挂着一条早就过去的错误"
        );
        process.stop().expect("停掉它");
        assert!(process.last_start_error().is_none(), "停掉之后更不该留着它");
    }
}
