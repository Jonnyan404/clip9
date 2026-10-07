//! 「本地服务端」那一页里的资源占用：**壳自己**与**内嵌服务端**这两个进程的 CPU / 内存。
//! （原来它自己在「关于」页有一张卡；2026-10-07 并进了这一页，理由见文末「删掉了什么」。）
//!
//! # ⚠️★ 为什么测的是「这两个进程」而不是「整机」
//!
//! 用户能对这个应用做点什么（重启它、换运行方式），而对「整机 12% CPU」无能为力 ——
//! 那个数字回答不了「这个客户端占多少」。
//!
//! # ⚠️★ CPU% 必须两次采样
//!
//! CPU 占用的定义是 `Δ(进程 CPU 时间) / Δ(墙钟时间)` —— **一次采样给不出百分比**。
//! 所以 [`Sampler`] 要**跨调用活着**（它持有 `sysinfo::System`，里面存着上一次的计数），
//! 而第一拍只能是 `None`（界面上显示 `—`，不是 0%）。
//!
//! # ⚠️★ 只在那一页可见时才采
//!
//! 少了这条，用户关掉设置窗口之后这个客户端会**每 2 秒醒一次、永远醒着** ——
//! 电池上表现为「待机也在耗电」，而**界面上完全看不出原因**。
//! 可见性只有页面知道（壳看不见 DOM），所以由页面调 [`crate::commands::resources_watch`] 告诉壳。
//!
//! # ⚠️★ 删掉了什么（2026-10-07，别再加回来）
//!
//! 原来这一块还包括「数据目录占多少」与「它所在磁盘的剩余 / 总量」。一起删了，两个理由不同：
//!
//! - **量目录是一次遍历**（`uploads/` 可能几百 MB），所以它不能跟着 2 秒的刷新跑 ——
//!   于是为了不误导人，它欠下三样东西：缓存、时间戳（「3 分钟前」）、一个「重新计算」按钮。
//!   只在设置里显示一行的数字撑不起这么一套。
//! - **磁盘剩余是整机口径**，与这一页其它数字（两个进程）不是一回事 ——
//!   摆在同一个标题下，读的人会以为它也是「这个应用占了多少」。
//!
//! ⚠️ 顺带摘掉了 `sysinfo` 的 `disk` 特性（见根 `Cargo.toml`）：只留 `system`。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::model::{ProcSample, ResourceSample};
use sysinfo::{Pid, ProcessesToUpdate, System};

/// 采样间隔。⚠️ 太短数字会剧烈跳；2 秒是「稳」与「看得出变化」的折中。
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// 采样器。**必须跨调用活着**（见模块头「CPU% 必须两次采样」）。
pub struct Sampler {
    system: System,
    /// 上一次采样的时刻 —— 用它判「离得够不够远」（第一拍是 `None`）。
    last: Option<Instant>,
}

impl Sampler {
    #[must_use]
    pub fn new() -> Self {
        let mut system = System::new();
        // ⚠️ 先空刷一次：`cpu_usage()` 报的是**上一次刷新以来**的占用，
        // 不先建一个基准的话第一拍会给出一个假的 0。
        system.refresh_processes(ProcessesToUpdate::All, true);
        Self { system, last: None }
    }

    /// 采一拍。`server_pid` 为 `None` 表示内嵌服务端没在跑。
    pub fn sample(&mut self, server_pid: Option<u32>) -> ResourceSample {
        let client_pid = Pid::from_u32(std::process::id());
        let mut pids = vec![client_pid];
        if let Some(pid) = server_pid {
            pids.push(Pid::from_u32(pid));
        }
        self.system
            .refresh_processes(ProcessesToUpdate::Some(&pids), true);

        // ⚠️ 两次采样之间要有间隔，否则 `cpu_usage()` 是拿一个极短的窗口算的 ——
        // 数字会乱跳（`sysinfo` 自己也有一个最小间隔，见它的 `MINIMUM_CPU_UPDATE_INTERVAL`）。
        let ready = self
            .last
            .is_some_and(|t| t.elapsed() >= SAMPLE_INTERVAL / 2);
        self.last = Some(Instant::now());

        // ⚠️★ **量化**：这两个数进了快照，而快照的版本号决定页面要不要重画。
        // 不量化的话 CPU 每拍都在小数点后变（1.23 → 1.24），于是**每 2 秒整棵树重画一次**，
        // 而屏幕上看起来一模一样。CPU 留一位小数、内存取到 KB 就够。
        let read = |system: &System, pid: Pid| {
            system.process(pid).map(|process| ProcSample {
                cpu: ready.then(|| (process.cpu_usage() * 10.0).round() / 10.0),
                rss: process.memory() / 1024 * 1024,
            })
        };

        ResourceSample {
            client: read(&self.system, client_pid),
            server: server_pid.and_then(|pid| read(&self.system, Pid::from_u32(pid))),
        }
    }
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

/// 采样的开关与状态。`main.rs` 里 `manage` 一份。
pub struct Resources {
    sampler: Mutex<Sampler>,
    /// 页面是不是正看着「本地服务端」那一页。
    ///
    /// ⚠️★ 它决定那个后台线程跑不跑 —— 见模块头那段（少了它客户端会永远每 2 秒醒一次）。
    watching: AtomicBool,
}

impl Resources {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sampler: Mutex::new(Sampler::new()),
            watching: AtomicBool::new(false),
        })
    }

    /// 采一拍（命令用）。`server_pid` 由调用方从 `ServerProcess` 问。
    #[must_use]
    pub fn sample(&self, server_pid: Option<u32>) -> ResourceSample {
        self.sampler
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sample(server_pid)
    }

    /// 页面切进 / 切出那一页。
    pub fn set_watching(&self, on: bool) {
        self.watching.store(on, Ordering::Relaxed);
    }

    #[must_use]
    pub fn is_watching(&self) -> bool {
        self.watching.load(Ordering::Relaxed)
    }

    /// 起那个后台线程。**只起一次**（`main.rs` 的 `setup` 里调）。
    ///
    /// ⚠️ 它**一直活着**，但只有 [`Resources::is_watching`] 为真时才真的采 ——
    /// 「停掉线程」那套要处理重建与竞态，而这里每 2 秒判一个原子布尔便宜得多。
    /// ⚠️ 用 `std::thread` 而不是 tokio：桌面端只开了 `tokio` 的 `sync` 特性
    ///（见 `Cargo.toml`），为一个计时器拉进整个 runtime 不划算。
    pub fn spawn_watcher(
        self: &Arc<Self>,
        store: Arc<crate::store::Store>,
        server: Option<Arc<crate::server_process::ServerProcess>>,
    ) {
        let resources = Arc::clone(self);
        std::thread::spawn(move || {
            loop {
                if resources.is_watching() {
                    let pid = server.as_ref().and_then(|s| s.child_pid());
                    let sample = resources.sample(pid);
                    store.set_resources(sample);
                }
                std::thread::sleep(SAMPLE_INTERVAL);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★ 第一拍量不出 CPU（要两次采样的差），但**内存那一拍就有**。
    ///
    /// ⚠️ 这条钉的是「别拿 0 顶替 `None`」：0% 读起来像「它在跑但很闲」。
    #[test]
    fn the_first_sample_has_memory_but_no_cpu() {
        let mut sampler = Sampler::new();
        let sample = sampler.sample(None);
        let client = sample.client.expect("壳自己一定读得到");
        assert!(client.cpu.is_none(), "第一拍给不出 CPU%");
        assert!(client.rss > 0, "内存是瞬时值，第一拍就该有");
        assert!(
            sample.server.is_none(),
            "没传 PID → 那一行是 None（界面上显示 —）"
        );
    }

    /// 隔得够久之后再采，CPU% 就有了。
    #[test]
    fn a_second_sample_after_the_interval_reports_cpu() {
        let mut sampler = Sampler::new();
        let _ = sampler.sample(None);
        std::thread::sleep(SAMPLE_INTERVAL / 2 + Duration::from_millis(50));
        let sample = sampler.sample(None);
        assert!(
            sample.client.expect("读得到").cpu.is_some(),
            "隔了半个间隔之后应当量得出来"
        );
    }

    /// ★ 传一个查不到的 PID（内嵌服务端刚退出时就是这种）：那一行是 `None`，
    /// **不是 panic、也不是 0** —— 界面把 `None` 画成 `—`。
    #[test]
    fn an_unknown_server_pid_reads_as_none() {
        let mut sampler = Sampler::new();
        let sample = sampler.sample(Some(0));
        assert!(sample.server.is_none(), "查不到就该是 None");
        assert!(sample.client.is_some(), "壳自己那一行不受影响");
    }
}
