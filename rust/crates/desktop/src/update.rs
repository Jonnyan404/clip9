//! 桌面端的自动更新 —— **壳这一侧**：查、下、装、重启。
//!
//! # 判定不在这儿
//!
//! 「这一版装起来了吗」「该不该回滚」「用户跳过过没有」都在
//! [`clip9_core::update`]（纯逻辑、有单测）。这里只做平台动作：
//! 发请求、落盘、调安装、重启进程。边界见 `CONTRIBUTING §4`。
//!
//! # ⚠️★ 更新走的是 `tauri-plugin-updater`（官方），但页面**拿不到它的 JS API**
//!
//! 与 `notification` / `global-shortcut` 同一条规矩（`capabilities/default.json`
//! 里故意没有 `updater:*`，判据 9 盯着）：页面只跟 IPC 命令说话。
//! 所以下面的命令是**唯一**的入口，页面连「有个 updater 插件」都看不到。
//!
//! # ⚠️★ 重启必须走 `request_restart()`，不能用 `restart()`
//!
//! `AppHandle::restart()` 在**主线程**上会**跳过 `ExitRequested` / `Exit` 事件**
//!（Tauri 的文档自己写着）—— 而 `main.rs` 的 `ExitRequested` 那一支要干三件事：
//! 停剪贴板 watcher、**`server.stop()`**、存窗口大小。跳过它们的症状是
//! 「更新完窗口大小丢了」和「端口还被占着，新实例起不来」。
//!
//! `request_restart()` 走的是「请求退出 → 事件跑完 → 重启」那条路 ✓。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::model::UpdatePhase as Phase;
use clip9_client::Msg;
use clip9_core::update::{self, Decision, Policy, StartupMarker, StartupVerdict};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// 启动之后跑多久才算「这一版能跑」。
///
/// ⚠️ 观察期要**长过一个会立刻崩的窗口**（加载即崩、连不上服务端就退出那类都在几秒内），
/// 但也不能长到用户开一下就用完 —— 30 秒是这两头的折中。
/// ⚠️ 它同时也是「崩溃循环」的判据：活过这 30 秒才会被 [`UpdateState::confirm`] 认下来。
pub const GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// 更新模块里**需要落盘**的那两样。
///
/// ⚠️ 「页面看到的状态」**不在这里** —— 它在 `Store` 里（页面每 500ms 拉的快照
/// 就是从那来的）。这里只放标记与偏好，而且它们**必须落盘**：
/// 更新一替换进程就重启了，不落盘的话「上一版装崩了」这件事没人记得住。
struct Inner {
    policy: Policy,
    marker: StartupMarker,
}

/// 自动更新的壳侧状态。`main.rs` 里 `manage` 一份，命令与启动自检共用。
pub struct UpdateState {
    inner: Mutex<Inner>,
    /// 标记与偏好落盘的地方（**数据目录**，不是安装目录 —— 更新一替换就没了）。
    path: PathBuf,
    /// 页面看到的那份状态放在这儿 —— 推进它就会让快照的版本号前进，
    /// 于是页面自己会重画（**唯一**一条通往界面的路，不另开事件通道）。
    store: std::sync::Arc<crate::store::Store>,
}

impl UpdateState {
    /// 从盘上读回标记与偏好。读不出来就用默认值 —— **不因为一个记录文件坏了就不启动**。
    #[must_use]
    pub fn load(dir: &Path, store: std::sync::Arc<crate::store::Store>) -> Self {
        let path = dir.join(FILE);
        let saved: Saved = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            inner: Mutex::new(Inner {
                policy: saved.policy,
                marker: saved.marker,
            }),
            path,
            store,
        }
    }

    /// 当前状态（页面从快照里读的就是它）。
    #[must_use]
    pub fn phase(&self) -> Phase {
        self.store.update_phase()
    }

    /// 记一次启动，并判这一次该怎么办。**在启动最早期调**（早于任何可能崩的东西）。
    ///
    /// 返回 [`StartupVerdict::RollBack`] 时，调用方要把这件事**告诉用户** ——
    /// 那时他连开三次都没用成，界面得说清「哪一版装不起来、去哪下旧的」。
    pub fn note_start(&self) -> StartupVerdict {
        let mut inner = self.lock();
        update::note_start(&mut inner.marker);
        let verdict = update::judge_startup(&inner.marker);
        if let StartupVerdict::RollBack { version, .. } = &verdict {
            // ⚠️★ 判回滚之后**要把标记清掉**：不清的话每次启动都会再判一次回滚，
            // 用户会看到一个永远关不掉的提示。回滚只提示一次。
            drop(inner);
            // ⚠️★ 走 `Msg`（键 + 参数），不写死句子 —— 判据 16 会红，而且它是对的：
            // 写死的话切到英文时这句还是中文。
            self.set(Phase::Failed {
                msg: Msg::key("updateRolledBack").param("version", version),
            });
            self.save();
            return verdict;
        }
        drop(inner);
        self.save();
        verdict
    }

    /// 确认这一版能跑（跑满 [`GRACE`] 之后调）—— 从此不再数失败。
    pub fn confirm(&self) {
        let mut inner = self.lock();
        update::confirm(&mut inner.marker);
        drop(inner);
        self.save();
    }

    /// 用户跳过某一版。
    pub fn skip(&self, version: &str) {
        self.lock().policy.skipped = Some(version.to_owned());
        self.save();
        self.set(Phase::Skipped {
            version: version.to_owned(),
        });
    }

    /// 把状态推给页面（经 store —— 顺带让快照版本号前进，页面自己会重画）。
    fn set(&self, phase: Phase) {
        self.store.set_update(phase);
    }

    /// 查一次。**网络请求，别在主线程上调。**
    ///
    /// ⚠️ 版本新不新由**插件**判（它内部用 `semver`）；这里只补一条
    /// 「用户跳过过没有」（[`update::should_offer`]）。
    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> Phase {
        self.set(Phase::Checking);
        let result = app.updater_builder().build();
        let updater = match result {
            Ok(updater) => updater,
            Err(error) => return self.fail(check_failed(error.to_string())),
        };
        let found = match updater.check().await {
            Ok(found) => found,
            Err(error) => return self.fail(check_failed(error.to_string())),
        };
        let Some(found) = found else {
            // ⚠️★ 这里给的是 `UpToDate`（**查过**、确实最新），不是 `Unchecked` ——
            //    这一支是「请求发出去、对面说没有新版」；两态的差别正是
            //    「这一句话有没有人核对过」，见 `UpdatePhase` 的注释。
            self.set(Phase::UpToDate);
            return Phase::UpToDate;
        };
        let version = found.version.clone();
        let phase = if update::should_offer(&self.lock().policy, &version) == Decision::Skipped {
            Phase::Skipped { version }
        } else {
            Phase::Available {
                version,
                notes: found.body.clone(),
            }
        };
        self.set(phase.clone());
        phase
    }

    /// 下载 + 安装，然后重启。**用户确认之后才调得到这里。**
    ///
    /// ⚠️★ 顺序不能反：**先写标记、再重启**。标记就是「这一版还没被确认」的唯一证据；
    /// 重启之后再写就晚了（那时新进程已经在跑，而它读的是盘上那份）。
    pub async fn install<R: Runtime>(&self, app: &AppHandle<R>) -> Phase {
        let updater = match app.updater_builder().build() {
            Ok(updater) => updater,
            Err(error) => return self.fail(install_failed(error.to_string())),
        };
        let found = match updater.check().await {
            Ok(Some(found)) => found,
            // ⚠️ 走 `Msg`（理由同上）。它理论上到不了这儿（按钮只在「有新版」时露出来），
            // 但**真到这儿了也要说清**，而不是给一个空状态。
            Ok(None) => return self.fail(Msg::key("updateNothingToInstall")),
            Err(error) => return self.fail(check_failed(error.to_string())),
        };
        let version = found.version.clone();
        self.set(Phase::Downloading {
            version: version.clone(),
            received: 0,
            total: None,
        });
        // ⚠️★ 回调一秒能来几十次，**只在整数百分比变了才推**：
        // 每次都推的话快照版本号会飞涨，而屏幕上真正变的只有那一格数字。
        // 用 `Cell` 是因为回调是 `FnMut` 但被 `download_and_install` 按值拿走 ——
        // 一个 `Cell<u64>` 就够，不需要锁。
        let last_percent = std::cell::Cell::new(u64::MAX);
        let store = std::sync::Arc::clone(&self.store);
        let version_for_progress = version.clone();
        let result = found
            .download_and_install(
                move |received, total| {
                    // ⚠️ 回调是**同步**的、而且在下载任务里跑 —— 只做一次比较 + 一次赋值，
                    // 别在这儿做 IO 或发通知（那会把下载拖慢）。
                    let received = received as u64;
                    let percent = match total {
                        Some(total) if total > 0 => received.saturating_mul(100) / total,
                        // 对面没给 `Content-Length` 时没有百分比可比 —— 那就按字节数去重。
                        _ => received / 65536,
                    };
                    if last_percent.replace(percent) == percent {
                        return;
                    }
                    store.set_update(Phase::Downloading {
                        version: version_for_progress.clone(),
                        received,
                        total,
                    });
                },
                || {},
            )
            .await;
        if let Err(error) = result {
            return self.fail(install_failed(error.to_string()));
        }

        // 装完了：写下「待确认」，然后重启。
        update::note_installed(&mut self.lock().marker, version.clone());
        self.save();
        self.set(Phase::Ready {
            version: version.clone(),
        });

        // ⚠️★ Windows 上插件**已经**退出进程并让 NSIS 安装器负责重启
        //（`install` 的文档：「exits the app after launching the updater installer」），
        // 所以那边**不要**再调一次 —— 那是在跟一个正在退出的进程抢。
        #[cfg(not(target_os = "windows"))]
        app.request_restart();
        #[cfg(target_os = "windows")]
        let _ = app;

        Phase::Ready { version }
    }

    fn fail(&self, msg: Msg) -> Phase {
        let phase = Phase::Failed { msg };
        self.set(phase.clone());
        phase
    }

    /// 落盘。失败只进日志 —— 记不住「上次更新成没成」不该让更新本身失败。
    fn save(&self) {
        let inner = self.lock();
        let saved = Saved {
            policy: inner.policy.clone(),
            marker: inner.marker.clone(),
        };
        drop(inner);
        let Ok(text) = serde_json::to_string_pretty(&saved) else {
            return;
        };
        if let Some(parent) = self.path.parent()
            && let Err(reason) = std::fs::create_dir_all(parent)
        {
            // log-only-ok: 记不住「上次更新成没成」不该让更新本身失败（用户也处理不了）
            eprintln!("建更新记录目录失败（不影响使用）：{reason}");
            return;
        }
        if let Err(reason) = std::fs::write(&self.path, text) {
            // log-only-ok: 同上 —— 它只影响「崩溃循环」那层保护，不影响这一次更新
            eprintln!("写更新记录失败（不影响使用）：{reason}");
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // ⚠️ 中毒了就接着用（`into_inner`）：更新状态不值得因为别的线程 panic 而失效。
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 「查一次」失败的句子（键在 `ui/i18n.js` 里）。
fn check_failed(reason: String) -> Msg {
    Msg::key("updateCheckFailed").param("reason", reason)
}

/// 「下载 / 安装」失败的句子。
fn install_failed(reason: String) -> Msg {
    Msg::key("updateInstallFailed").param("reason", reason)
}

/// 落盘的那份文件。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    policy: Policy,
    #[serde(default)]
    marker: StartupMarker,
}

/// 记录文件的名字（数据目录下）。
const FILE: &str = "update.json";
