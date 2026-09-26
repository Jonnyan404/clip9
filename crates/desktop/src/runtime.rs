//! 把 `clip9-client` 跑起来 —— **这里是唯一碰「线程 / 任务 / 句柄」的地方**。
//!
//! # 四件事（对应 `docs/specs/desktop-client.md` §0.5 的接缝表）
//!
//! 1. **起监听（上行）**：[`spawn_watcher`]，回调里**不做 IO** —— 只把事件丢给异步任务
//!    再 [`upload_event`]（回调跑在**监控线程**上，阻塞它就等于漏掉后面的变化）；
//!    ⚠️★ 界面上「点一下发送」走的是**同一个搬运工、不同的目标**（[`UploadSource`]）：
//!    剪贴板那条过同步开关，界面那条**一个都不看**（Jonny 2026-09-26：
//!    「上传和下载是本地剪贴板的功能，是独立的，不要影响本地客户端的功能」）；
//! 2. **起下行**：[`spawn_receiver`]，读它的更新通道搬进 [`Store`]；
//! 3. ⚠️★ 两者**共享同一个 [`Debouncer`]**（[`shared_debouncer`]）—— 这**不是优化，是功能前提**：
//!    下行写剪贴板前要 `prime` 指纹来防回环，而「谁记得上一次是什么」只能有一处；
//! 4. **配置变了要重启**（房间开关换了 → 下行得重连；监听开关换了 → 线程得起停）。
//!
//! # 为什么这个文件里没有 `tauri`
//!
//! 与 `store` 同一个理由：这些是**要测的接线**，而接线错的表现往往是
//! 「连上了但不写剪贴板」这种**静默**的坏。tokio 的 `Handle` 由上层传进来
//! （`main.rs` 从 Tauri 的运行时拿），所以这里既不依赖 Tauri、也不自己建运行时。

use std::sync::{Arc, Mutex};

use clip9_client::receiver::fetch_history;
use clip9_client::uploader::{build_client, now};
use clip9_client::{
    ClipboardContent, ClipboardEvent, ClipboardSink, Debouncer, ReceiverHandle, SystemClipboard,
    WatchConfig, WatchHandle, shared_debouncer, spawn_receiver, spawn_watcher, upload_event,
    upload_explicit,
};

use crate::store::Store;

/// 客户端运行时。
pub struct Runtime {
    store: Arc<Store>,
    /// ⚠️ **watcher 与 receiver 共享**（见模块文档第 3 条）。
    debouncer: Arc<Mutex<Debouncer>>,
    watcher: Mutex<Option<WatchHandle>>,
    receiver: Mutex<Option<ReceiverHandle>>,
    /// 一个 HTTP 客户端**全程共用**（`clip9-client` 里的超时策略是它的常量，
    /// 每次上传另建一个 = 又一份要漂的超时配置）。
    http: reqwest::Client,
    /// tokio 的句柄（监控线程要靠它把事件丢进异步任务）。
    tokio: tokio::runtime::Handle,
}

impl Runtime {
    /// 造一个运行时。`http` 建不出来就是**启动失败**（没有它连历史都取不到）。
    pub fn new(store: Arc<Store>, tokio: tokio::runtime::Handle) -> Result<Arc<Self>, String> {
        let http = build_client()?;
        Ok(Arc::new(Self {
            store,
            debouncer: shared_debouncer(),
            watcher: Mutex::new(None),
            receiver: Mutex::new(None),
            http,
            tokio,
        }))
    }

    /// 起监听 + 起下行（按当前配置）。已经是起着的就先停掉 —— 重复 `start` 是**配置变了**
    /// 之后该做的事，所以这里做成幂等的。
    pub fn start(self: &Arc<Self>) {
        self.stop();
        self.start_watcher();
        self.start_receiver();
    }

    /// 配置变了（房间清单、任一方向开关）→ **下行要重连**才生效。
    ///
    /// ⚠️★ 它是「**全部**重连」，不是「只重连改了的那个」：连接任务拿的是一份
    /// **配置快照**（`spawn_receiver` 的参数），改配置只能重新起任务。
    /// ⚠️ 代价是「点一下 ↓，所有房间的连接都断一下」—— 而好处是**实现只有一份**
    ///（按房间增量重连要一套「哪个任务对应哪个房间」的账，而那笔账会漂）。
    /// 一次切换是用户手动点的、很罕见，重连本机/局域网也就几毫秒。
    /// ⚠️ 如果哪天真觉得闪，正确的方向是**把那份快照换成共享的配置**，
    /// 而不是在这里加一层「哪个变了」的判断。
    pub fn restart_receiver(self: &Arc<Self>) {
        self.stop_receiver();
        self.start_receiver();
    }

    /// 只重启剪贴板监听。
    ///
    /// ⚠️ 轮询间隔变了要**重启线程**才生效 —— 那个间隔是 `spawn_watcher` 时读进
    /// `WatchConfig` 的（见 [`watch_config`]），改配置不会影响一个已经在跑的线程。
    /// 不重启的话症状是「设置里改了间隔，实际没变」—— 又一例「配了不生效」。
    pub fn restart_watcher(self: &Arc<Self>) {
        self.stop_watcher();
        self.start_watcher();
    }

    fn stop_watcher(&self) {
        if let Some(handle) = self
            .watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            // ⚠️ `stop()` 会 **join** 监控线程（最多等一个轮询间隔），
            // 而 `Drop` 也做同一件事 —— 显式调一次是「我要现在停」，意图更清楚。
            handle.stop();
        }
    }

    /// 起剪贴板监听。
    ///
    /// ⚠️★ **它没有开关了**（2026-09-26）：原来这里开头判 `enable_monitoring`，
    /// 那个字段已经删掉 —— 要不要发出去只看每个房间的 ↑（`config.rs` 模块文档第 5 条）。
    /// 所以一个房间都没开 ↑ 时，这个线程**照样在跑**，只是每次都被
    /// `upload_channels()` 筛成空。代价是那点空转，换来的是「开关」与
    /// 「线程生命周期」不再绑在一起（§4.7 刚解开的那团结，别再打回去）。
    fn start_watcher(self: &Arc<Self>) {
        if self
            .watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return;
        }
        let config = self.store.config();
        let this = Arc::clone(self);
        let handle = spawn_watcher(
            Box::new(SystemClipboard),
            watch_config(&config),
            Arc::clone(&self.debouncer),
            move |event| this.schedule_upload(event, UploadSource::Clipboard),
        );
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    fn stop_receiver(&self) {
        if let Some(handle) = self
            .receiver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            handle.stop();
        }
    }

    fn start_receiver(self: &Arc<Self>) {
        if self
            .receiver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return;
        }
        let (updates, mut stream) = tokio::sync::mpsc::unbounded_channel();
        let sink: Box<dyn ClipboardSink> = Box::new(SystemClipboard);
        // ⚠️⚠️ `spawn_receiver` 内部是 `tokio::spawn`，所以它**必须在 tokio 上下文里被调用**。
        // 「手里有 Handle」与「身处上下文」是**两件事** —— 少了下面这个 `enter()`，
        // 在 `app.run()` 之前（也就是主线程上）调它会当场 panic：
        //
        //     panicked at crates/client/src/receiver.rs:407: there is no reactor running
        //
        // 那是 2026-09-26 第一次真跑这个壳时抓到的。⚠️ `cargo test` 抓不到它：
        // 测试本来就在运行时内，而这条路径只在**启动时**走一次。
        let guard = self.tokio.enter();
        // ⚠️ 没开下行的房间**照样连**（§4.7：连接与 ↑/↓ 无关）——
        // `spawn_receiver` 现在给**每个房间**起一条连接。
        // ⚠️ 一个房间都没有时它什么也不起，而 `updates` 会立刻被丢掉 →
        // 下面那个搬运任务随即结束。这是**对的**：「没有房间」本来就该是「一个连接都没有」。
        let handle = spawn_receiver(
            self.store.config(),
            sink,
            Arc::clone(&self.debouncer),
            updates,
        );
        drop(guard);
        *self.receiver.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);

        let store = Arc::clone(&self.store);
        self.tokio.spawn(async move {
            while let Some(update) = stream.recv().await {
                store.apply_update(update);
            }
        });
    }

    /// 全部停掉（退出 / 换配置时）。
    pub fn stop(&self) {
        self.stop_watcher();
        self.stop_receiver();
    }
}

/// 把客户端配置里的轮询间隔变成 [`WatchConfig`]。
///
/// ⚠️★ 抽成**纯函数**是为了能测 —— 这条接线原来写的是 `WatchConfig::default()`，
/// 于是 `ClientConfig::poll_interval_ms` 这个字段**全项目没有一处读它**：
/// 用户在配置里改了间隔，实际跑的永远是 500ms。这就是「配了不生效」，
/// 而它**不会有任何报错**（`watcher.rs` 的字段注释写着「**必须可配**」，
/// `desktop-client.md` §8 的审计清单也列了这条）。
///
/// ⚠️ 下界夹到 1ms：`0` 会让轮询线程**空转**（`thread::sleep(0)` 立刻返回），
/// 症状是「风扇转起来、CPU 高」，和「同步不准」完全联想不到一起。
fn watch_config(config: &clip9_client::ClientConfig) -> WatchConfig {
    WatchConfig {
        poll_interval: std::time::Duration::from_millis(config.poll_interval_ms.max(1)),
    }
}

/// 一次上行**是谁发起的**。
///
/// ⚠️★ 这个区分是**功能上的**，不是记账 —— 两条路走的是同一套材料化 / 凭据 / 多文件
/// 逻辑（都在 `clip9-client` 里），但**「该不该发」这一问的答案不一样**：
///
/// - [`UploadSource::Clipboard`]：本机剪贴板变了 → 要过 ↑ 和「文本 / 文件」那几个开关；
/// - [`UploadSource::FromUi`]：用户自己敲了字、自己按了按钮 → **一个同步开关都不看**。
///
/// Jonny 2026-09-26：「上传和下载是本地剪贴板的功能，是独立的，
/// **不要影响本地客户端的功能**，它们只负责获取本地剪贴板上传到远程房间
/// 和获取远程房间消息写入本地剪贴板」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadSource {
    /// 剪贴板监听报上来的变化。
    Clipboard,
    /// 界面上点的（输入框「发送」/ 📎 / 🖼 / 拖进来）。
    FromUi,
}

impl Runtime {
    /// 监听回调：**只把事件丢进异步任务**，然后立刻返回。
    ///
    /// ⚠️ 这个回调跑在**监控线程**上：在这里做 IO 会把轮询卡住、漏掉后面的变化
    /// （`spawn_watcher` 的文档里点名了这条）。
    fn schedule_upload(self: &Arc<Self>, event: ClipboardEvent, source: UploadSource) {
        let this = Arc::clone(self);
        self.tokio.spawn(async move {
            this.upload(event, source).await;
        });
    }

    /// 真的发一次上行。
    async fn upload(&self, event: ClipboardEvent, source: UploadSource) {
        // ⚠️ 限额是**握手时**那份（`/server` 里没有），拿不到就是「不知道」——
        // 这时只有用户自己配的 `max_file_size_mb` 生效，而服务端会自己拒掉超限的那次
        // 并带回一句带数字的话（`uploader` 的模块文档第 2 条）。
        let limits = self.store.limits();
        let config = self.store.config();
        let report = match source {
            UploadSource::Clipboard => {
                upload_event(&config, &event, limits, now(), &self.http).await
            }
            UploadSource::FromUi => {
                // ⚠️★ **界面上的发送只发到「当前选中的那个房间」**，而且不判任何同步开关
                //（理由见 `clip9_client::upload_explicit` 的文档）。
                // 为什么是「选中的那个」：主区显示的就是它的时间线 —— 用户看到的那个房间
                // 就是他以为在发过去的那个。发给「所有开着 ↑ 的房间」是另一回事，
                // 而且 ↑ 默认全关，那条路装完就是**点了没反应**。
                let Some(target) = self.store.selected_channel() else {
                    // ⚠️ 一个房间都没配：**说出来**。静默吞掉的话，用户按了发送
                    // 只看到「什么都没发生」—— 那是这个项目最忌讳的一类。
                    self.store.notice("err", "没有房间可以发 —— 先在侧栏加一个");
                    return;
                };
                upload_explicit(&config, &target, &event, limits, now(), &self.http).await
            }
        };
        // ⚠️ 上传结果**要能被界面看到**，包括「因为开关关着而跳过」——
        // 「点了没反应」是这类客户端最难查的一类故障。
        if !report.ok() {
            self.store.notice("err", report.summary());
        } else if report.skipped || report.delivered == 0 {
            self.store.notice("skip", report.summary());
        } else {
            self.store.notice("ok", report.summary());
        }
    }

    /// 界面上「发一条」。
    ///
    /// ⚠️ 为什么不让界面自己 `fetch` 服务端：那样会有**第二条上行路径**，
    /// 于是「限额从哪来」「凭据怎么带」「多文件怎么办」这些规则要各写一遍 ——
    /// 而它们都已经写在 `clip9-client` 里了。
    pub fn send_text(self: &Arc<Self>, text: &str) {
        if text.is_empty() {
            return;
        }
        self.schedule_upload(
            ClipboardEvent::Text {
                content: text.to_owned(),
                // ⚠️ `subtype` **只影响界面上的标签**（像不像网址/颜色），不改变上传方式
                // （`event.rs` 的注释），所以这里不猜 —— 让服务端那边按正文判断。
                subtype: None,
            },
            UploadSource::FromUi,
        );
    }

    /// 界面上「发文件」：📎 / 🖼 / 拖进来的都走这条。
    ///
    /// ⚠️★ 与剪贴板那条上行**共用材料化 / 限额 / 凭据 / 多文件**的全部实现
    ///（都在 `clip9-client` 里，这里一行都不重写）—— **不同的只有「谁决定目标」**，
    /// 见 [`UploadSource`]。
    ///
    /// ⚠️ 空列表直接返回：`upload_event` 收到空列表会回一句「0 个文件」的提示，
    /// 而用户只是按了「取消」（`pick_files` 那时给的就是空数组）——
    /// 那种提示是噪音。
    pub fn send_files(self: &Arc<Self>, paths: &[String]) {
        let paths: Vec<std::path::PathBuf> = paths
            .iter()
            .filter(|path| !path.trim().is_empty())
            .map(std::path::PathBuf::from)
            .collect();
        if paths.is_empty() {
            return;
        }
        self.schedule_upload(ClipboardEvent::Files { paths }, UploadSource::FromUi);
    }

    /// 「复制内容」（时间线的右键菜单，§4.4）。
    ///
    /// ⚠️★ **必须先 `prime` 再写**：不 prime 的话，监控线程下一次轮询会把这行
    /// 当成一次**新的复制**，于是它又被发回房间 —— 用户只是想在本地复制一下，
    /// 结果在房间里刷出一条重复消息。这正是下行写剪贴板时做的事
    ///（`receiver::apply_entry` 里那条 prime），同一个道理。
    ///
    /// ⚠️ 写失败要**说出来**：剪贴板在部分平台上会被别的程序占着
    ///（`clipboard-rs` 会返回错误），静默失败的话用户以为复制好了、粘出来是旧的。
    pub fn copy_to_clipboard(self: &Arc<Self>, text: &str) {
        if text.is_empty() {
            return;
        }
        self.debouncer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .prime(&ClipboardContent::Text(text.to_owned()));
        if let Err(reason) = SystemClipboard.set_text(text) {
            self.store.notice("err", reason);
        }
    }

    /// 按需取回**选中房间**的历史（`GET /content`，不碰剪贴板）。
    ///
    /// ⚠️ 为什么要单独一条：下行的历史只覆盖**下载通道那一个房间**，
    /// 而界面可以选中任何一个房间。
    pub fn refresh_history(self: &Arc<Self>) {
        let Some(channel) = self.store.selected_channel() else {
            self.store.notice("err", "配置里一个房间都没有");
            return;
        };
        let this = Arc::clone(self);
        self.tokio.spawn(async move {
            // ⚠️ 一次要多少条 = 界面上留多少条（`MAX_ENTRIES_PER_ROOM`）——
            // 多取的部分用户看不到，而每次序列化都要带着它。
            // ⚠️ 房间名**在请求之前**取下来：空响应时 `store` 那边没有别的办法知道
            // 这一页是给哪个房间取的（见 `Store::push_history` 的注释）。
            let room = channel.room.clone();
            match fetch_history(&this.http, &channel, crate::store::MAX_ENTRIES_PER_ROOM).await {
                Ok(entries) => this.store.push_history(&room, entries),
                Err(reason) => this.store.notice("err", format!("取历史失败：{reason}")),
            }
        });
    }

    /// 让界面上的开关**落到磁盘**。失败要**说出来**（界面上还亮着、配置没存上 =
    /// 下次启动又变回来，而用户会以为没生效）。
    pub fn persist(&self) {
        if let Err(reason) = self.store.save() {
            self.store.notice("err", format!("配置没存上：{reason}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clip9_client::ClientConfig;

    /// ⚠️★ 配了要生效。第一版这里写死的是 `WatchConfig::default()`，
    /// 于是 `poll_interval_ms` 这个配置项**全项目没有一处读它**。
    #[test]
    fn the_poll_interval_comes_from_the_config() {
        let config = ClientConfig {
            poll_interval_ms: 1234,
            ..ClientConfig::default()
        };
        assert_eq!(
            watch_config(&config).poll_interval,
            std::time::Duration::from_millis(1234)
        );
    }

    /// `0` 不能原样传下去 —— 那会让轮询线程空转（CPU 打满，而症状看着像别的问题）。
    #[test]
    fn a_zero_interval_is_clamped_instead_of_spinning() {
        let config = ClientConfig {
            poll_interval_ms: 0,
            ..ClientConfig::default()
        };
        assert_eq!(
            watch_config(&config).poll_interval,
            std::time::Duration::from_millis(1)
        );
    }
}
