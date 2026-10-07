//! 「关于」页里的资源占用：**壳自己**与**内嵌服务端**这两个进程的 CPU / 内存，
//! 以及数据目录占了多少磁盘、那块盘还剩多少。
//!
//! # ⚠️★ 为什么测的是「这两个进程」而不是「整机」
//!
//! 用户能对这个应用做点什么（重启它、清数据），而对「整机 12% CPU」无能为力 ——
//! 那个数字回答不了「这个客户端占多少」。
//! ⚠️ 唯一例外是**磁盘剩余**：那个是**整机**的口径（「装不下了」是要人去清理的）。
//! 界面上要把这个区分写出来（见 `ui/index.html` 那张卡的标签）。
//!
//! # ⚠️★ CPU% 必须两次采样
//!
//! CPU 占用的定义是 `Δ(进程 CPU 时间) / Δ(墙钟时间)` —— **一次采样给不出百分比**。
//! 所以 [`Sampler`] 要**跨调用活着**（它持有 `sysinfo::System`，里面存着上一次的计数），
//! 而第一拍只能是 `None`（界面上显示 `—`，不是 0%）。
//!
//! # ⚠️★ 只在「关于」这一页可见时才采
//!
//! 少了这条，用户关掉设置窗口之后这个客户端会**每 2 秒醒一次、永远醒着** ——
//! 电池上表现为「待机也在耗电」，而**界面上完全看不出原因**。
//! 可见性只有页面知道（壳看不见 DOM），所以由页面调 [`crate::commands::resources_watch`] 告诉壳。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::model::{ProcSample, ResourceSample};
use sysinfo::{Disks, Pid, ProcessesToUpdate, System};

/// 采样间隔。⚠️ 太短数字会剧烈跳；2 秒是「稳」与「看得出变化」的折中。
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// 采样器。**必须跨调用活着**（见模块头「CPU% 必须两次采样」）。
pub struct Sampler {
    system: System,
    /// 上一次采样的时刻 —— 用它判「离得够不够远」（第一拍是 `None`）。
    last: Option<Instant>,
    /// 数据目录（量它的大小、找它所在的那个挂载点）。
    dir: PathBuf,
    /// 目录大小的缓存 `(字节, 算出来的时刻)`。
    dir_cache: Mutex<(Option<u64>, Option<i64>)>,
}

impl Sampler {
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        let mut system = System::new();
        // ⚠️ 先空刷一次：`cpu_usage()` 报的是**上一次刷新以来**的占用，
        // 不先建一个基准的话第一拍会给出一个假的 0。
        system.refresh_processes(ProcessesToUpdate::All, true);
        Self {
            system,
            last: None,
            dir,
            dir_cache: Mutex::new((None, None)),
        }
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

        let (dir_bytes, dir_at) = *self.dir_cache.lock().unwrap_or_else(|e| e.into_inner());
        let (disk_free, disk_total) = self.disk_of_dir();
        ResourceSample {
            client: read(&self.system, client_pid),
            server: server_pid.and_then(|pid| read(&self.system, Pid::from_u32(pid))),
            dir_bytes,
            dir_at,
            disk_free,
            disk_total,
        }
    }

    /// 遍历数据目录，量它多大，并把结果缓存下来。
    ///
    /// ⚠️★ **它是一个遍历，所以只能按需调**（打开这一页、或用户点「重新计算」）——
    /// 跟着 2 秒的刷新跑会让磁盘一直在转，而 `uploads/` 里可能是几百 MB 的视频。
    pub fn measure_dir(&self) -> u64 {
        let bytes = dir_size(&self.dir);
        *self.dir_cache.lock().unwrap_or_else(|e| e.into_inner()) = (Some(bytes), Some(now_secs()));
        bytes
    }

    /// 数据目录**所在那个挂载点**的剩余 / 总量。
    ///
    /// ⚠️★ 要挑**最具体的**那个挂载点（路径最长的那条）：macOS 上通常同时挂着
    /// `/`、`/System/Volumes/Data` 甚至外置盘，随便挑一个数字就是错的。
    fn disk_of_dir(&self) -> (Option<u64>, Option<u64>) {
        let disks = Disks::new_with_refreshed_list();
        let dir = std::fs::canonicalize(&self.dir).unwrap_or_else(|_| self.dir.clone());
        let best = disks
            .list()
            .iter()
            .filter(|disk| dir.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().as_os_str().len());
        match best {
            Some(disk) => (Some(disk.available_space()), Some(disk.total_space())),
            None => (None, None),
        }
    }
}

/// 现在（Unix 秒）。⚠️ 只要一个「什么时候量的」的戳，不引 `chrono`。
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// 一个目录占多少字节（**不跟符号链接**，免得绕圈）。
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        // ⚠️ `file_type()` 是 `lstat` 语义（**不跟链接**）—— 跟着走的话，
        // 一个指向上级目录的链接会让这里转不出来。
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()));
        } else if kind.is_file() {
            total = total.saturating_add(entry.metadata().map_or(0, |m| m.len()));
        }
    }
    total
}

/// 采样的开关与状态。`main.rs` 里 `manage` 一份。
pub struct Resources {
    sampler: Mutex<Sampler>,
    /// 页面是不是正看着「关于」那一页。
    ///
    /// ⚠️★ 它决定那个后台线程跑不跑 —— 见模块头那段（少了它客户端会永远每 2 秒醒一次）。
    watching: AtomicBool,
}

impl Resources {
    #[must_use]
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            sampler: Mutex::new(Sampler::new(dir)),
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

    /// 重新量一次数据目录（命令用）。
    pub fn remeasure(&self) -> u64 {
        self.sampler
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .measure_dir()
    }

    /// 页面切进 / 切出「关于」页。
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
            // ⚠️ 先量一次目录（打开那一页就该有数，而不是等用户点「重新计算」）。
            // 它不跟着循环跑 —— 见 `measure_dir` 的注释。
            resources.remeasure();
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

    /// ★ 目录大小：递归、不跟符号链接。
    #[test]
    fn dir_size_sums_files_recursively() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("a"), vec![0u8; 10]).expect("写 a");
        std::fs::create_dir(dir.path().join("sub")).expect("建子目录");
        std::fs::write(dir.path().join("sub/b"), vec![0u8; 32]).expect("写 b");
        assert_eq!(dir_size(dir.path()), 42, "10 + 32");
    }

    /// 目录不在（或读不动）时返回 0，**不 panic** —— 它跑在「打开设置」那条路上。
    #[test]
    fn dir_size_of_a_missing_path_is_zero() {
        assert_eq!(dir_size(Path::new("/definitely/not/here")), 0);
    }

    /// ★ 第一拍量不出 CPU（要两次采样的差），但**内存那一拍就有**。
    ///
    /// ⚠️ 这条钉的是「别拿 0 顶替 `None`」：0% 读起来像「它在跑但很闲」。
    #[test]
    fn the_first_sample_has_memory_but_no_cpu() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mut sampler = Sampler::new(dir.path().to_path_buf());
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
        let dir = tempfile::tempdir().expect("临时目录");
        let mut sampler = Sampler::new(dir.path().to_path_buf());
        let _ = sampler.sample(None);
        std::thread::sleep(SAMPLE_INTERVAL / 2 + Duration::from_millis(50));
        let sample = sampler.sample(None);
        assert!(
            sample.client.expect("读得到").cpu.is_some(),
            "隔了半个间隔之后应当量得出来"
        );
    }

    /// `measure_dir` 会把结果缓存进后续的采样里（并且带上时间戳）。
    #[test]
    fn measuring_the_dir_shows_up_in_later_samples() {
        let dir = tempfile::tempdir().expect("临时目录");
        std::fs::write(dir.path().join("db"), vec![0u8; 128]).expect("写 db");
        let mut sampler = Sampler::new(dir.path().to_path_buf());
        assert!(sampler.sample(None).dir_bytes.is_none(), "还没量过");

        assert_eq!(sampler.measure_dir(), 128);
        let sample = sampler.sample(None);
        assert_eq!(sample.dir_bytes, Some(128));
        assert!(sample.dir_at.is_some(), "要带上「什么时候量的」");
    }

    /// 磁盘那两个数读得到（真机上一定有），且剩余不超过总量。
    #[test]
    fn the_disk_of_the_data_dir_is_readable() {
        let dir = tempfile::tempdir().expect("临时目录");
        let sampler = Sampler::new(dir.path().to_path_buf());
        let (free, total) = sampler.disk_of_dir();
        let (free, total) = (free.expect("读得到剩余"), total.expect("读得到总量"));
        assert!(total > 0);
        assert!(free <= total, "剩余不该超过总量");
    }
}
