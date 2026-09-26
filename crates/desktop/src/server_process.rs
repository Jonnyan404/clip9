//! 本地服务端进程 —— 起、停、查状态。
//!
//! # 为什么它存在
//!
//! ✅ **已拍板：桌面端随包分发服务端**（`docs/specs/desktop-client.md` §9.1 第 2 条）。
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

/// 本地服务端的默认端口。
///
/// ⚠️ **刻意不用 9501**：那是用户自己那个实例的默认端口，撞上去的后果见模块文档。
/// 9502 紧挨着它，好记，而且不撞。
pub const DEFAULT_PORT: u16 = 9502;

/// 起来最多等多久（超时就报错，不无限等）。
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// 探测一次的读超时。
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// 本地服务端进程的句柄。
pub struct ServerProcess {
    /// ⚠️ `None` = **我们没起过**（不代表它没在跑 —— 见 [`ServerProcess::is_running`]）。
    child: Mutex<Option<Child>>,
    binary: PathBuf,
    data_dir: PathBuf,
    port: u16,
}

impl ServerProcess {
    #[must_use]
    pub fn new(binary: PathBuf, data_dir: PathBuf, port: u16) -> Self {
        Self {
            child: Mutex::new(None),
            binary,
            data_dir,
            port,
        }
    }

    /// 服务端现在答不答话（**唯一的真相来源**）。
    #[must_use]
    pub fn is_running(&self) -> bool {
        probe(self.port)
    }

    /// 起一个，然后**等它真的答话**才返回。
    ///
    /// ⚠️ 只 `spawn` 不等待是不够的：进程起来了但还没 bind 端口，紧接着的请求会失败，
    /// 而用户看到的是「点了启动、然后界面说没在跑」—— 他会以为按钮坏了。
    ///
    /// ⚠️ 已经在跑（不管是谁起的）就**直接返回成功**，不重复起：
    /// 重复起的后果是第二个进程 bind 失败、静默退出，而界面上「看起来起了」。
    pub fn start(&self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|err| format!("建服务端数据目录失败（{}）：{err}", self.data_dir.display()))?;
        let log_path = log_path(&self.data_dir);
        let log = std::fs::File::create(&log_path)
            .map_err(|err| format!("建日志文件失败（{}）：{err}", log_path.display()))?;
        let log2 = log
            .try_clone()
            .map_err(|err| format!("复制日志句柄失败：{err}"))?;

        let child = Command::new(&self.binary)
            .arg("-port")
            .arg(self.port.to_string())
            .arg("-data")
            .arg(&self.data_dir)
            // ⚠️★ **必须显式给 `-config`**：不给的话服务端会在**当前工作目录**写一份
            // `config.json`（它的默认值就是相对 cwd 的 `config.json`）——
            // 而桌面端进程的 cwd 可能是 `/` 或用户主目录，往那儿写文件是**不该发生**的事。
            // 给到数据目录下，那也正是 W5c 那个「配置可视化」要编辑的文件。
            .arg("-config")
            .arg(config_path(&self.data_dir))
            .stdout(Stdio::from(log2))
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|err| format!("起不了本地服务端（{}）：{err}", self.binary.display()))?;
        *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if self.is_running() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        // ⚠️ 超时要把「怎么查」告诉用户：日志就在旁边，而「起了但没起来」是最难查的一种。
        Err(format!(
            "本地服务端 {} 秒内没有答话。日志：{}（端口 {} 可能被别的程序占了）",
            START_TIMEOUT.as_secs(),
            log_path.display(),
            self.port
        ))
    }

    /// 停掉**我们起的那个**。
    ///
    /// ⚠️ 只管自己起的：**不碰**用户自己在别处跑的服务端（那个可能正连着他的手机）。
    /// ⚠️ 用 `kill()`（SIGKILL）而不是优雅退出：redb 的写是事务性的、崩溃安全，
    /// 而「优雅退出」要跨平台发信号（`libc` / Windows 控制台事件），
    /// 为一个「用户点停止」的动作引入那套不划算。见 `ARCHITECTURE.md` 的崩溃安全那条。
    pub fn stop(&self) -> Result<(), String> {
        let taken = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(mut child) = taken else {
            // 没起过 —— 但要**说清**是「我们没起过」，而不是「已经停好了」。
            return if self.is_running() {
                Err(
                    "这个端口上有一个服务端在跑，但**不是这个客户端起的**，所以不替你停它。"
                        .to_owned(),
                )
            } else {
                Ok(())
            };
        };
        child
            .kill()
            .map_err(|err| format!("停本地服务端失败：{err}"))?;
        // ⚠️ 收尸：不 `wait` 的话会留下僵尸进程（在 Linux 上看得见）。
        let _ = child.wait();
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
pub fn default_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| format!("取不到自己的路径：{err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| format!("{} 没有父目录", exe.display()))?;
    let name = if cfg!(windows) {
        "clip9-server.exe"
    } else {
        "clip9-server"
    };
    let path = dir.join(name);
    if !path.is_file() {
        return Err(format!(
            "找不到本地服务端：{}（它应该和客户端放在一起）",
            path.display()
        ));
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

/// 服务端日志在哪：`<服务端数据目录>/server.log`（`start()` 把子进程的 stdout/stderr 都倒进去）。
///
/// ⚠️ 与 [`config_path`] 同一个理由：**起服务端和「查看日志」必须用同一个路径**。
/// 两处各写一遍 `join("server.log")`，写歪了就是「日志页永远说没有日志」。
#[must_use]
pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.log")
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
        // ⚠️ `-config` 要落在**数据目录**里，不是 cwd —— 这一条钉的就是那个坑。
        assert!(
            data.join("config.json").is_file(),
            "服务端该把配置写在数据目录下（{}）",
            data.display()
        );

        server.stop().expect("停服务端");
        assert!(!server.is_running(), "停了就不该再探测到");
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
        assert!(
            err.contains("不是这个客户端起的"),
            "要说清为什么不停：{err}"
        );
        assert!(a.is_running(), "A 必须还活着");

        a.stop().expect("A 自己停");
    }
}
