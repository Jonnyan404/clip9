//! 把 `clip9-client` 跑起来 —— **这里是唯一碰「线程 / 任务 / 句柄」的地方**。
//!
//! 四件事（对应 `dev-docs/specs/desktop-client.md` §0.5 的接缝表）：
//!
//! 1. **起监听（上行）**：[`spawn_watcher`]，回调里**不做 IO** —— 只把事件丢给异步任务再
//!    [`upload_event`]（回调跑在**监控线程**上，阻塞它等于漏掉后面的变化）。⚠️★ 界面上
//!    「点一下发送」走的是**同一个搬运工、不同的目标**（[`UploadSource`]）：剪贴板那条过同步
//!    开关，界面那条**一个都不看**（Jonny 2026-09-26）。
//! 2. **起下行**：[`spawn_receiver`]，读它的更新通道搬进 [`Store`]。
//! 3. ⚠️★ 两者**共享同一个 [`Debouncer`]**（[`shared_debouncer`]）—— 这**不是优化，是功能
//!    前提**：下行写剪贴板前要 `prime` 指纹防回环，而「谁记得上一次是什么」只能有一处。
//! 4. **配置变了要重启**（房间开关换了 → 下行重连；**↑ 全关 → 监听线程要停**）。
//!
//! **系统通知也从这里发**：两个方向各一条判据（[`notify_upload`] / [`notify_download`]），
//! 真正发的那一下交给注入进来的 [`Notifier`]。⚠️★ 2026-09-28 起那两条递出去的**不是成文的
//! 句子，是 [`Msg`]（键 + 参数）** —— 通知由**操作系统**画，成文只能由壳做
//!（`shell_text::ShellText`，字典是页面推来的）。⚠️ 判据本身一个字没改。
//!
//! ⚠️★ **本文件里没有 `tauri`**（与 `store` 同一个理由）：这些是**要测的接线**，而接线错的
//! 表现往往是「连上了但不写剪贴板」这种**静默**的坏。tokio 的 `Handle` 由上层传进来
//!（`main.rs` 从 Tauri 的运行时拿），所以这里既不依赖 Tauri、也不自己建运行时。
//! 通知那件事也靠这一条撑住：发通知要 `tauri`（[`crate::notify`]），但「发不发、发什么」
//! 留在本文件（两条纯函数），注入的是一个 `dyn Notifier` —— 否则这条最需要被测的判据
//!（发一条 vs 发一万条）就只能靠手点界面验。

use std::sync::{Arc, Mutex};

use clip9_client::receiver::fetch_history;
use clip9_client::uploader::{build_client, now};
use clip9_client::{
    ClipboardContent, ClipboardEvent, ClipboardSink, Debouncer, Msg, ReceiverEvent, ReceiverHandle,
    ReceiverUpdate, SystemClipboard, UploadReport, WatchConfig, WatchHandle, prime_from_current,
    shared_debouncer, spawn_receiver, spawn_watcher, upload_event, upload_explicit,
};
use clip9_protocol::ReceiveHolder;

use crate::notify::Notifier;
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
    /// 发系统通知的那一下。⚠️ 判据**不在这里**（见 [`notify_upload`] / [`notify_download`]），
    /// 这里只把它递出去 —— 所以类型是 `dyn Notifier`，本文件见不到 `tauri`。
    notifier: Arc<dyn Notifier>,
}

impl Runtime {
    /// 造一个运行时。`http` 建不出来就是**启动失败**（没有它连历史都取不到）。
    ///
    /// ⚠️★ **通知是注入进来的**（不是内部 new 一个）：真实那份要 `tauri` 的窗口句柄，
    /// 而本文件不许依赖 `tauri`（见模块文档）。`main.rs` 传 [`crate::notify::SystemNotifier`]，
    /// 测试传一个记录用的假实现 —— 于是「什么情况下不该弹」这件事**能被测**。
    pub fn with_notifier(
        store: Arc<Store>,
        tokio: tokio::runtime::Handle,
        notifier: Arc<dyn Notifier>,
    ) -> Result<Arc<Self>, Msg> {
        let http = build_client()?;
        Ok(Arc::new(Self {
            store,
            debouncer: shared_debouncer(),
            watcher: Mutex::new(None),
            receiver: Mutex::new(None),
            http,
            tokio,
            notifier,
        }))
    }

    /// 起监听 + 起下行（按当前配置）。已经是起着的就先停掉 —— 重复 `start` 是**配置变了**
    /// 之后该做的事，所以这里做成幂等的。
    pub fn start(self: &Arc<Self>) {
        self.stop();
        self.sync_watcher();
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

    /// 按配置决定剪贴板监听线程**该不该在跑** —— 唯一的判据是
    /// [`clip9_client::ClientConfig::watches_clipboard`]（有任何房间开着 ↑）。
    ///
    /// ⚠️★ 2026-09-27 用户定的：「上传全关就关闭监听，开一个就打开监听。
    /// 下载应该不需要调用监听剪贴板」。那个独立的「剪贴板监听开关」早就删了
    ///（`config.rs` 模块文档第 5 条），所以这件事只能由 ↑ 反推 ——
    /// 而**判据只有一处**（`watches_clipboard`，它又从 `upload_channels` 推出来），
    /// 这里只是把它接到线程的生命周期上。
    ///
    /// ⚠️★ 为什么必须**真的停掉**，而不是「让它空转、反正 `upload_channels()` 会筛成空」：
    /// ① 空转就是每 `poll_interval_ms` 读一次系统剪贴板 —— 一个用户什么都没开、
    ///    却一直在读剪贴板的后台进程，是这个项目从第一天起就不想要的那类东西；
    /// ② 更要紧的是**语义**：↑ 全关时监听线程什么都做不了，留着它只会让
    ///    「为什么它还在读我的剪贴板」变成一个没法回答的问题。
    ///
    /// ⚠️ **↓ 不是理由**：下载是「把收到的写进剪贴板」，那是 `receiver` 干的活
    ///（`apply_entry` 里那个 `sink`），跟这个轮询线程一点关系都没有。
    ///
    /// ⚠️ 只在该起 / 该停的时候才动句柄：每次调用都「先停再起」会让
    /// `upload_channels` 的每次变动都白丢一个轮询间隔（`stop()` 会 join 线程），
    /// 而那段窗口里的剪贴板变化是**真丢**。
    pub fn sync_watcher(self: &Arc<Self>) {
        let should_run = self.store.config().watches_clipboard();
        let running = self
            .watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        match watcher_action(should_run, running) {
            WatcherAction::Start => self.start_watcher(),
            WatcherAction::Stop => self.stop_watcher(),
            WatcherAction::Leave => {}
        }
    }

    /// 只重启剪贴板监听（配置里与它有关的东西变了：轮询间隔）。
    ///
    /// ⚠️ 轮询间隔变了要**重启线程**才生效 —— 那个间隔是 `spawn_watcher` 时读进
    /// `WatchConfig` 的（见 [`watch_config`]），改配置不会影响一个已经在跑的线程。
    /// 不重启的话症状是「设置里改了间隔，实际没变」—— 又一例「配了不生效」。
    ///
    /// ⚠️★ 收尾走 [`Runtime::sync_watcher`] 而**不是** `start_watcher`：
    /// ↑ 全关时用户改间隔，不该顺手把线程起回来（那正是「配了不生效」的反面：
    /// 配了个没人要的东西，然后它跑起来了）。
    pub fn restart_watcher(self: &Arc<Self>) {
        self.stop_watcher();
        self.sync_watcher();
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

    /// 起剪贴板监听（**调用方必须先确认它该跑** —— 见 [`Runtime::sync_watcher`]）。
    ///
    /// ⚠️★ 这里**不做那个判断**（原来这里判过 `enable_monitoring`，那个字段已经删了）：
    /// 判断在 `sync_watcher` 里一处，这里只管起。两处都判的话，
    /// 「该跑却起不来」和「不该跑却起了」会各有一半概率发生，而且都不报错。
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
        // ⚠️★ **起线程之前**先把**当前**剪贴板记成「已经见过」（2026-09-27 用户报的）。
        // 少了这一步，监控线程读到的第一份内容必然被判成新变化 → 立刻走一次上行：
        // 默认配置（一个房间都没开 ↑）下，界面在**刚连上那一刻**就弹「没有发出去…」，
        // 而用户什么都没复制；开着 ↑ 时更糟，会把上次关机前留在剪贴板里的东西再发一遍。
        // 顺序不能颠倒（先 spawn 再 prime 会漏掉第一拍）；详见 `prime_from_current`。
        prime_from_current(&SystemClipboard, &self.debouncer);
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
        //     panicked at rust/crates/client/src/receiver.rs:407: there is no reactor running
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

        let this = Arc::clone(self);
        self.tokio.spawn(async move {
            while let Some(update) = stream.recv().await {
                this.apply_update(update);
            }
        });
    }

    /// 从下行搬一条更新进 [`Store`] —— **并在剪贴板真被写到时发一条系统通知**。
    ///
    /// ⚠️★ 通知在这里发，**不在 `store` 里**：`store` 那个分支是**有意为空**的
    ///（它只摆列表，`WroteToClipboard` 的注释里写着为什么），而「要不要弹」
    /// 要读配置、要碰壳 —— 那都是运行时的活。
    ///
    /// ⚠️★ 「真的写进了剪贴板吗」这一问**不在这里判**：`clip9-client` 只在
    /// `apply_entry` 回 `Ok(true)`（真写成功）时才发这条事件
    ///（空正文那种 `Ok(false)` 不算）。这里再判一遍就是**第二份定义**，
    /// 而两份一定会漂 —— 漂的方向是「通知说写进去了、其实没写」。
    ///
    /// ⚠️ **先弹再摆列表**：这条更新可能因为房间刚被删掉而在 `store` 里被丢掉，
    /// 但剪贴板**是真的写了** —— 那种情况下通知照样该弹。
    fn apply_update(self: &Arc<Self>, update: ReceiverUpdate) {
        if let ReceiverEvent::WroteToClipboard(entry) = &update.event {
            notify_download(self.notifier.as_ref(), &self.store.config(), entry);
        }
        self.store.apply_update(update);
    }

    /// 全部停掉（退出 / 换配置时）。
    pub fn stop(&self) {
        self.stop_watcher();
        self.stop_receiver();
    }
}

/// 监听线程**该怎么动**（[`Runtime::sync_watcher`] 的判据）。
///
/// ⚠️★ 抽成纯函数是为了能测 —— 与 [`watch_config`] 同一个理由：这条接线错了
/// **不会有任何报错**，只会「剪贴板明明在变，房间一条都没收到」或者反过来
/// 「什么都没开却在读剪贴板」。而它的两个输入（配置、线程在不在）都要真起
/// 一个运行时才拿得到，所以把**判断**与**动作**分开。
///
/// ⚠️★ `(true, true)` 与 `(false, false)` 必须是 [`WatcherAction::Leave`]，
/// 不能写成「先停再起」：`stop_watcher()` 会 **join** 那个线程（最多等一个轮询间隔），
/// 于是每次 `sync_watcher()`（用户每点一下 ↑）都会白丢一个间隔 ——
/// 而**那段窗口里复制的东西是真的没发出去**，且不会有任何提示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatcherAction {
    /// 该跑而没跑 → 起。
    Start,
    /// 不该跑而在跑 → 停。
    Stop,
    /// 状态已经对了 → **什么都别做**（尤其是别重启）。
    Leave,
}

/// 「该不该跑」+「现在跑没跑」→ 该怎么办。
fn watcher_action(should_run: bool, running: bool) -> WatcherAction {
    match (should_run, running) {
        (true, false) => WatcherAction::Start,
        (false, true) => WatcherAction::Stop,
        // ⚠️ 这两条是**同一件事的两面**：状态已经对了，别动它。
        (true, true) | (false, false) => WatcherAction::Leave,
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

/// 一次上行**怎么了** —— 界面那一格的颜色 / 系统通知发不发，都看它。
///
/// ⚠️★ 用枚举而不是直接带着 `"ok"` / `"err"` / `"skip"` 三个字符串走：
/// 「成功不弹通知」这条判据要比较它，而**字符串比错了不会报错** ——
/// 打错一个字母的表现是「成功也弹」，用户很快就把这软件的通知关掉了
///（于是真正要紧的那条也没人看）。[`Outcome::kind`] 是那三个字面量**唯一**的出处。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// 真的送达了（至少一个房间）。
    Ok,
    /// 有失败。
    Err,
    /// 被开关跳过了（卡在哪一道由 `report.summary()` 自己说）。
    Skip,
}

impl Outcome {
    /// 给界面那一格用的分类（`store::Notice` 的 `kind`）。
    ///
    /// ⚠️ 语义与页面的 `.notice.ok / .err / .skip` 三套颜色一一对应 ——
    /// 改这里等于改界面，两边一起看（`ui/index.html` 的 `.notice` 样式）。
    fn kind(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Err => "err",
            Self::Skip => "skip",
        }
    }
}

/// 上行的**剪贴板那条**结果要不要弹系统通知 —— 要就发给 `notifier`。
///
/// ⚠️★ **只有「没发出去」才弹**（[`Outcome::Ok`] 不弹）。两个极端都是**静默**的坏：
/// · 成功也弹 → 本机剪贴板每变一次弹一条「已发送」→ 用户第一件事就是去系统设置里
///   把这软件的通知关掉 → 于是**真正要紧的那条**（没发出去）也一起没了；
/// · 该弹的不弹 → 东西没发出去而用户不知道。他只知道「我在手机上看不到」，
///   而这两件事之间没有任何线索把它们连起来。
///
/// ⚠️★ 判据抽出来、而且**收一个 `&dyn Notifier`**（不是返回一个 `Option` 让调用方去发）：
/// 这样测试能拿一个记录用的假实现，**连「有没有真的调 send」一起验**
/// ——「发什么」对了但「根本没发」是另一类错，而它同样不报错。
///
/// ⚠️ 标题是**主动语态的一句结果**（「剪贴板没发出去」），不是「提示」这种名词：
/// 系统通知的标题要在锁屏 / 通知中心一眼看懂，而那时正文可能被折叠。
///
/// ⚠️★ 两个都是 [`Msg`]（标题是 `notifyUploadFailed`，正文就是 `report.summary()`）。
/// 成文那一步在 [`crate::notify`] 里 —— 它手里有页面推过来的字典。
fn notify_upload(
    notifier: &dyn Notifier,
    config: &clip9_client::ClientConfig,
    outcome: Outcome,
    text: &Msg,
) {
    if !config.notify_upload || outcome == Outcome::Ok {
        return;
    }
    notifier.send(&Msg::key("notifyUploadFailed"), text);
}

/// 下行的结果（房间的内容**真的写进了**本机剪贴板）要不要弹系统通知。
///
/// ⚠️★ 「真的写进了」这一问**不在这里判**：`clip9-client` 只在 `apply_entry`
/// 回 `Ok(true)` 时才发 [`ReceiverEvent::WroteToClipboard`]（空正文那种
/// `Ok(false)` 不算 —— 它什么都没写）。这里再判一遍就是**第二份定义**。
///
/// ⚠️ 与上行相反，这一条**成功才弹**：写剪贴板这件事用户看不见（除非他正好在粘贴），
/// 而它又是一件「本机被改动过」的事 —— 不说的话，用户会以为剪贴板里的东西
/// 是自己之前复制的（然后粘到一个错误的地方）。它也可能是**误写**
///（别人的房间开着 ↓ 而自己没注意），弹一条才说得清。
fn notify_download(
    notifier: &dyn Notifier,
    config: &clip9_client::ClientConfig,
    entry: &ReceiveHolder,
) {
    if !config.notify_download {
        return;
    }
    notifier.send(&Msg::key("notifyWroteToClipboard"), &entry_preview(entry));
}

/// 剪贴板那条上行**记下「是哪几条」**（界面上「我发的」/「剪贴板同步」那个标签用）。
///
/// ⚠️★ **界面上发的那条不记**：敲进输入框的字、拖进来的文件是**明确的意图**，
/// 把它们标成「剪贴板同步」是假话 —— 用户会想「我又没复制，它怎么说是剪贴板来的」。
/// 而反过来漏记的症状也一样轻：标签退回到「我发的」（那**不是假话**，只是少说一句）。
///
/// ⚠️ 与 [`notify_upload`] / [`notify_download`] 同一族：**判据单独成一个函数**，
/// 于是它有自己的测试（两个方向各一次）。写在一个 `match` 里的话，这一处错了
/// **不会有任何报错**（只是标签说错话），靠手点界面是发现不了的。
fn record_clipboard_uploads(store: &Store, source: UploadSource, report: &UploadReport) {
    if matches!(source, UploadSource::Clipboard) {
        store.mark_clipboard_uploads(&report.uploaded);
    }
}

/// 一条条目在通知里怎么被说成**一行**。
///
/// ⚠️ 只取**第一行**正文：通知那一行放不下多行文本，而**从中间截断**会让人以为
/// 原文就是这样（用户报过「长消息看着被砍了」那类误会）。
///
/// ⚠️★ 按**字符**截、不按字节 —— 中文按字节切会切出半个字
///（`model.rs` 的 `preview_of` 踩过同一个坑）。
///
/// ⚠️★ 结果还是 [`Msg`]（2026-09-28），因为这一句里有两处**是语言的一部分**：
/// 「（空文本）」这个兜底，以及「名字（大小）」里那对**全角括号** ——
/// 英文那边是 `name (2.0 KB)`。所以这里给的是**模板 + 参数**，
/// 拼是 [`crate::shell_text`] 的事。⚠️ 正文本身走 [`Msg::verbatim`]：
/// 那是**用户的东西**，不是我们的话，翻不了也不该翻。
fn entry_preview(entry: &ReceiveHolder) -> Msg {
    /// 通知正文最多显示多少个**字符**（不是字节）。
    const PREVIEW_CHARS: usize = 60;

    match entry {
        ReceiveHolder::Text(text) => {
            let line = text.content.lines().next().unwrap_or("").trim();
            if line.is_empty() {
                // ⚠️ 空正文照实说。给一个空字符串的话，系统通知会弹出一条
                // 只有标题、下面空白的卡片 —— 看起来像我们坏了。
                return Msg::key("notifyEmptyText");
            }
            let mut out: String = line.chars().take(PREVIEW_CHARS).collect();
            if line.chars().count() > PREVIEW_CHARS {
                out.push('…');
            }
            Msg::verbatim(out)
        }
        // ⚠️ 文件条目**没有正文**（`FileReceive` 的注释），能说的只有名字与大小。
        ReceiveHolder::File(file) => match size_label(file.size) {
            // ⚠️ 大小服务端可以不给（`0`）—— 那时**不写**「0 B」，
            // 那是个具体的谎（文件当然不是 0 字节）。而且**连括号一起省掉**，
            // 不是留一对空括号。
            None => Msg::verbatim(&file.name),
            Some(size) => Msg::key("notifyFilePreview")
                .param("name", &file.name)
                .param("size", size),
        },
    }
}

/// 字节数 → 人能读的一句。`None` = **不知道**（负数 / 0，服务端可以不给大小）。
///
/// ⚠️ 它和页面上的 `sizeLabel`（`ui/app.js`）说的是同一件事，但**不能共用**：
/// 一个在 Rust 里、一个在页面里（那份界面没有构建步骤，互相 import 不了）。
/// 两边的分档与小数位要保持一致 —— 改一处顺手看一眼另一处。
fn size_label(bytes: i64) -> Option<String> {
    if bytes <= 0 {
        return None;
    }
    const KB: f64 = 1024.0;
    let bytes_f = bytes as f64;
    Some(if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes_f < KB * KB {
        format!("{:.1} KB", bytes_f / KB)
    } else {
        format!("{:.1} MB", bytes_f / (KB * KB))
    })
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
        // ⚠️★ 「界面上发的」那条要先定下**发给谁**，而有房间才发得出去。
        // 剪贴板那条**没有具体房间** —— 它的目标是「所有开着 ↑ 的房间」，
        // 可能同时好几个、也可能一个都没有（见下面报告结果那段）。
        let target = match source {
            UploadSource::Clipboard => None,
            UploadSource::FromUi => {
                // ⚠️★ **界面上的发送只发到「当前选中的那个房间」**，而且不判任何同步开关
                //（理由见 `clip9_client::upload_explicit` 的文档）。
                // 为什么是「选中的那个」：主区显示的就是它的时间线 —— 用户看到的那个房间
                // 就是他以为在发过去的那个。发给「所有开着 ↑ 的房间」是另一回事，
                // 而且 ↑ 默认全关，那条路装完就是**点了没反应**。
                let Some(channel) = self.store.selected_channel() else {
                    // ⚠️ 一个房间都没配：**说出来**。静默吞掉的话，用户按了发送
                    // 只看到「什么都没发生」—— 那是这个项目最忌讳的一类。
                    self.store.notice("err", Msg::key("noRoomToSend"));
                    return;
                };
                Some(channel)
            }
        };
        let report = match &target {
            None => upload_event(&config, &event, limits, now(), &self.http).await,
            Some(channel) => {
                upload_explicit(&config, channel, &event, limits, now(), &self.http).await
            }
        };
        // ⚠️★ **只有剪贴板那条**把「这几条是我同步过去的」记下来（界面上那条标签用：
        // 「我发的」还是「剪贴板同步」）。判据在那个小函数里，有测试（两个方向）。
        // ⚠️ 放在这里（结果一到就记）而不是等界面来问：界面只认变化，没有「问一次」的入口。
        record_clipboard_uploads(&self.store, source, &report);
        // ⚠️ 上传结果**要能被界面看到**，包括「因为开关关着而跳过」——
        // 「点了没反应」是这类客户端最难查的一类故障。
        // ⚠️ 跳过的**理由**由 `report.summary()` 自己说（`SkipReason`）——
        // 这里不许再拼一句「相关开关关着」那种要用户自己去认的话。
        let outcome = if !report.ok() {
            Outcome::Err
        } else if report.skipped() || report.delivered == 0 {
            Outcome::Skip
        } else {
            Outcome::Ok
        };
        let text = report.summary();
        match &target {
            // ⚠️★ 剪贴板那条走**系统通知**，界面那一格**故意不写**。
            // 理由：那一格长在「当前选中房间」的标题下面（`store` 的 `Room::notice`），
            // 而这条路的目标是「**所有**开着 ↑ 的房间」—— 可能好几个、也可能一个都没有。
            // 把「本机剪贴板没发出去」挂在某一个房间名下是**假话**（那个房间可能根本没开 ↑）。
            // ⚠️ 还有一层更实在的理由：它发生时用户**多半不在这个窗口里**
            //（他刚在别的程序里按了 ⌘C），而界面那一格只有他切回来才看得到 —— 那已经太晚。
            None => notify_upload(self.notifier.as_ref(), &config, outcome, &text),
            Some(channel) => {
                self.store
                    .notice_in(&channel.server, &channel.room, outcome.kind(), text)
            }
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

    /// 「复制内容」（时间线的右键菜单）—— **由壳去取全文**。
    ///
    /// ⚠️★ 为什么不复用「页面把正文传回来」那条路：快照里只有**截断预览**
    ///（[`crate::model::EntryView::for_snapshot`]），页面手里那份**不是**正文 ——
    /// 传回来就会把长文**复制成截断的**，而且不报错（用户粘出来才发现少了半截）。
    ///
    /// ⚠️ 顺带省掉一整趟 IPC：全文只在 Rust 侧走，一个字节都不进 webview。
    pub fn copy_entry(self: &Arc<Self>, id: i32) {
        match self.store.entry_text(id) {
            Some(text) => self.copy_to_clipboard(&text),
            // ⚠️ 找不到要**说出来**：静默什么都不做的话，用户以为复制好了。
            None => self.store.notice("skip", Msg::key("entryGoneCannotCopy")),
        }
    }

    /// 按需取回**选中房间**的历史（`GET /content`，不碰剪贴板）。
    ///
    /// ⚠️ 为什么要单独一条：下行的历史只覆盖**下载通道那一个房间**，
    /// 而界面可以选中任何一个房间。
    pub fn refresh_history(self: &Arc<Self>) {
        let Some(channel) = self.store.selected_channel() else {
            self.store.notice("err", Msg::key("noRoomsConfigured"));
            return;
        };
        let this = Arc::clone(self);
        self.tokio.spawn(async move {
            // ⚠️ 一次要多少条 = 界面上留多少条（`MAX_ENTRIES_PER_ROOM`）——
            // 多取的部分用户看不到，而每次序列化都要带着它。
            // ⚠️ 房间**在请求之前**取下来：空响应时 `store` 那边没有别的办法知道
            // 这一页是给哪个房间取的（见 `Store::push_history` 的注释）。
            // ⚠️★ 而且身份是 **(服务端, 房间)** 两样 —— 两个服务端上可以有同名房间，
            // 只给房间名会把取回的历史写进**另一个**同名房间（见 `ReceiverUpdate::server`）。
            let server = channel.server.clone();
            let room = channel.room.clone();
            match fetch_history(&this.http, &channel, crate::store::MAX_ENTRIES_PER_ROOM).await {
                Ok(entries) => this.store.push_history(&server, &room, entries),
                // ⚠️★ 必须**带上房间**：这一步是异步的，用户很可能在它回来之前
                // 已经切到别的房间了 —— 不带的话，这条失败会挂到**新选中**那个房间身上
                //（用户报的「提示串房间了」就是这个形状）。
                // ⚠️ 用的是**请求之前**取下的 `server` / `room`，不是「现在选中的那个」：
                // 认的是 (服务端, 房间) 那一对，所以它会落进**它自己那个房间**的格子里
                //（`store` 的 `Room::notice`），等用户切过去才显示 —— 而那正是
                // 「这个房间的历史取不到、所以列表是空的」最该被说出来的时刻。
                // ⚠️ `reason` 整句话递过去（`historyFailed` 那条 `Msg` 本来就带
                // 「取历史失败」+ 底层原因），**不在这里 `format!` 拼**。
                Err(reason) => this.store.notice_in(&server, &room, "err", reason),
            }
        });
    }

    /// 让界面上的开关**落到磁盘**。失败要**说出来**（界面上还亮着、配置没存上 =
    /// 下次启动又变回来，而用户会以为没生效）。
    pub fn persist(&self) {
        if let Err(reason) = self.store.save() {
            self.store.notice(
                "err",
                Msg::key("configNotSaved").param_msg("reason", reason),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clip9_client::{Channel, ClientConfig, UploadedEntry};
    use clip9_protocol::{ReceiveBase, TextReceive};

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

    /// ⚠️★ 四条组合都要钉：两个方向各一次「该动」，两次「**别动**」。
    ///
    /// 只测「该起 / 该停」的话，「每次都先停再起」这种写法照样绿 ——
    /// 而它每点一下 ↑ 都会白丢一个轮询间隔（`stop` 要 join 线程），
    /// 那段窗口里复制的东西**真的没发出去**，而且没有任何提示。
    #[test]
    fn the_watcher_only_moves_when_it_has_to() {
        assert_eq!(watcher_action(true, false), WatcherAction::Start);
        assert_eq!(watcher_action(false, true), WatcherAction::Stop);
        assert_eq!(
            watcher_action(true, true),
            WatcherAction::Leave,
            "已经起着的别再起 —— 停一下再起会白丢一个轮询间隔"
        );
        assert_eq!(
            watcher_action(false, false),
            WatcherAction::Leave,
            "本来就不该跑，别去动那个空句柄"
        );
    }

    /// 记录用的假通知器。
    ///
    /// ⚠️★ 它存在的理由是「**有没有真的发**」也要能测：判据说「该弹」、
    /// 但没人去调 `send`，那照样是**静默**的坏（用户以为会响，结果什么都没弹）。
    /// 所以两条判据都收一个 `&dyn Notifier`，而不是返回一个 `Option` 让调用方去发。
    #[derive(Default)]
    struct RecordingNotifier {
        sent: std::sync::Mutex<Vec<(Msg, Msg)>>,
    }

    impl RecordingNotifier {
        fn sent(&self) -> Vec<(Msg, Msg)> {
            self.sent.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    impl Notifier for RecordingNotifier {
        // ⚠️ 记的是 [`Msg`]（键 + 参数），**不是渲染好的文本** ——
        // 渲染要字典，而字典是页面推给 `crate::notify` 的；这一层只该证明
        // 「该弹的时候真的调了 send，而且递的是哪句话」。
        fn send(&self, title: &Msg, body: &Msg) {
            self.sent
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((title.clone(), body.clone()));
        }
    }

    /// 「原样带出来的那句正文」里的文本（通知正文走这条路：那是用户的东西）。
    fn preview_text(msg: &Msg) -> String {
        assert_eq!(msg.key, "verbatim", "这条该是原样带出来的：{msg:?}");
        msg.params
            .get("text")
            .and_then(clip9_client::ParamValue::as_str)
            .expect("`verbatim` 那句话里必须有 `text`")
            .to_owned()
    }

    fn text_entry(content: &str) -> ReceiveHolder {
        ReceiveHolder::Text(clip9_protocol::TextReceive {
            base: clip9_protocol::ReceiveBase::default(),
            content: content.to_owned(),
            ..clip9_protocol::TextReceive::default()
        })
    }

    fn file_entry(name: &str, size: i64) -> ReceiveHolder {
        ReceiveHolder::File(clip9_protocol::FileReceive {
            base: clip9_protocol::ReceiveBase::default(),
            name: name.to_owned(),
            size,
            ..clip9_protocol::FileReceive::default()
        })
    }

    /// ⚠️★ 剪贴板上行的通知：**只有没发出去才响**。
    ///
    /// 三条都要测：只测「失败会弹」的话，「**成功也弹**」照样绿 ——
    /// 而它的后果是本机剪贴板每变一次弹一条，用户第一件事就是去把通知关掉，
    /// 于是**真正要紧的那条**（没发出去）也一起没了。
    #[test]
    fn a_clipboard_upload_only_speaks_up_when_it_did_not_go_out() {
        let config = ClientConfig::default();
        assert!(config.notify_upload, "前提：默认是开的（这条测试的地基）");

        let body = Msg::key("uploadSomeFailed")
            .param("payloads", 3)
            .param("failed", 1);
        for (outcome, expected) in [(Outcome::Err, 1), (Outcome::Skip, 1), (Outcome::Ok, 0)] {
            let notifier = RecordingNotifier::default();
            notify_upload(&notifier, &config, outcome, &body);
            assert_eq!(
                notifier.sent().len(),
                expected,
                "{outcome:?} 该发 {expected} 条通知"
            );
        }

        // 标题与正文也要对得上：正文就是 `report.summary()`（**理由在里面**，
        // 那句「相关开关关着」被用户当假话就是这个原因）；
        // 标题是一句结果 —— 锁屏 / 通知中心里正文可能被折叠，标题得自己说得清。
        //
        // ⚠️★ 断言的是**两句 `Msg`**，不是两句成文的话（2026-09-28 改）：
        // 成文那一步在 `notify` 里，而它要的字典在页面手里 —— 这一层只该钉
        // 「递的是哪句话、参数对不对」。
        let notifier = RecordingNotifier::default();
        notify_upload(&notifier, &config, Outcome::Err, &body);
        assert_eq!(
            notifier.sent(),
            vec![(Msg::key("notifyUploadFailed"), body)]
        );
    }

    /// ⚠️★ **只有剪贴板那条**会记下「这几条是我同步过去的」（界面上那条标签用）。
    ///
    /// 界面上敲的字、拖进来的文件是**明确的意图** —— 把它们标成「剪贴板同步」是假话，
    /// 用户会想「我又没复制，它怎么说是剪贴板来的」。
    ///
    /// ⚠️★ 两个分支的差别只有一个 `match`，而**哪一个方向错了都不会报错**
    ///（只是标签说错话 / 少说一句话）—— 所以这里用一个真的 `Store` 把两个方向都走一遍，
    /// 而不是靠手点界面。判据在 [`record_clipboard_uploads`]。
    #[test]
    fn only_the_clipboard_path_records_what_it_sent() {
        const SERVER: &str = "http://127.0.0.1:9501";
        let dir = tempfile::tempdir().expect("建临时目录");
        let store = Store::new(
            ClientConfig {
                channels: vec![Channel::new("默认", SERVER)],
                ..ClientConfig::default()
            },
            dir.path().join("client.json"),
            dir.path().to_path_buf(),
        );
        // 房间里先有 7 号那一条（模拟「上行已经发出去了，它从 WS 回到了本机」）。
        store.apply_update(ReceiverUpdate {
            server: SERVER.to_owned(),
            room: "default".to_owned(),
            event: ReceiverEvent::Entry(Box::new(ReceiveHolder::Text(TextReceive {
                base: ReceiveBase {
                    id: 7,
                    kind: "text".to_owned(),
                    room: "default".to_owned(),
                    ..ReceiveBase::default()
                },
                content: "刚复制的东西".to_owned(),
                ..TextReceive::default()
            }))),
        });
        let report = UploadReport {
            uploaded: vec![UploadedEntry {
                server: SERVER.to_owned(),
                room: "default".to_owned(),
                id: 7,
            }],
            ..UploadReport::default()
        };
        let tagged = |store: &Store| store.snapshot().entries[0].from_clipboard;

        record_clipboard_uploads(&store, UploadSource::FromUi, &report);
        assert!(
            !tagged(&store),
            "界面上发的那条不许贴「剪贴板同步」——那是假话"
        );

        record_clipboard_uploads(&store, UploadSource::Clipboard, &report);
        assert!(tagged(&store), "剪贴板那条要贴上（漏了就是「少说一句话」）");
    }

    /// 关掉那个开关 → **一条都不许发**（包括失败那条）。「配了不生效」的反面。
    #[test]
    fn the_upload_notification_switch_silences_everything() {
        let config = ClientConfig {
            notify_upload: false,
            ..ClientConfig::default()
        };
        for outcome in [Outcome::Err, Outcome::Skip, Outcome::Ok] {
            let notifier = RecordingNotifier::default();
            notify_upload(&notifier, &config, outcome, &Msg::key("uploadNothingSent"));
            assert!(notifier.sent().is_empty(), "{outcome:?}：开关关着还发了");
        }
    }

    /// ⚠️★ 下行：**真的写进剪贴板了才说**，开关关着就不说。
    ///
    /// 「真的写进了」那一半由 `clip9-client` 保证（`WroteToClipboard` 只在
    /// `apply_entry` 回 `Ok(true)` 时发），这里只钉「开关」与「正文形状」。
    #[test]
    fn writing_to_the_clipboard_is_announced_only_when_asked() {
        let on = ClientConfig::default();
        assert!(on.notify_download, "前提：默认是开的（这条测试的地基）");

        let notifier = RecordingNotifier::default();
        notify_download(&notifier, &on, &text_entry("你好"));
        assert_eq!(
            notifier.sent(),
            vec![(Msg::key("notifyWroteToClipboard"), Msg::verbatim("你好"))]
        );

        let off = ClientConfig {
            notify_download: false,
            ..ClientConfig::default()
        };
        let notifier = RecordingNotifier::default();
        notify_download(&notifier, &off, &text_entry("你好"));
        assert!(notifier.sent().is_empty(), "开关关着还发了");
    }

    /// ⚠️★ 通知正文只取**第一行**，而且按**字符**截。
    ///
    /// 中文按字节切会切出半个字（`model.rs` 的 `preview_of` 踩过同一个坑），
    /// 而通知正文里出现一个乱码方块，用户只会以为是我们坏了。
    #[test]
    fn the_notification_body_is_one_line_of_whole_characters() {
        let config = ClientConfig::default();

        // 多行 → 只留第一行。⚠️ 从中间截断会让人以为原文就是这样。
        // ⚠️ 截断发生在**参数值**上，所以从 `verbatim` 那句话的 `text` 里看。
        assert_eq!(
            preview_text(&entry_preview(&text_entry("第一行\n第二行"))),
            "第一行"
        );

        // 超长的一行 → 60 个字符 + 一个省略号（而且没切出半个字）。
        let long = "汉".repeat(100);
        let body = preview_text(&entry_preview(&text_entry(&long)));
        assert_eq!(body.chars().count(), 61, "60 个字符 + 一个省略号");
        assert!(body.ends_with('…'));
        assert!(
            body.trim_end_matches('…').chars().all(|c| c == '汉'),
            "切出了半个字：{:?}",
            body.chars().last()
        );

        // 正好 60 个字符 → **不加**省略号（它没被截）。
        let body = preview_text(&entry_preview(&text_entry(&"汉".repeat(60))));
        assert_eq!(body.chars().count(), 60);
        assert!(!body.ends_with('…'));

        // ⚠️ 空正文要**说出来**：给一个空字符串的话，系统通知会弹出一张
        // 只有标题、下面空白的卡片 —— 看起来像我们坏了。
        // ⚠️ 而那句话现在是**字典里的一条**（`notifyEmptyText`）——
        // 它的括号是全角的，英文那边不是，所以它不能留在 Rust 里。
        let notifier = RecordingNotifier::default();
        notify_download(&notifier, &config, &text_entry("   \n第二行"));
        assert_eq!(notifier.sent()[0].1, Msg::key("notifyEmptyText"));
    }

    /// 文件条目**没有正文**，能说的只有名字与大小；服务端不给大小时**不写「0 B」**。
    #[test]
    fn a_file_notification_says_the_name_and_only_a_real_size() {
        // ⚠️ 名字与大小是**两个参数**，「（…）」那对括号在字典里
        //（英文那边是半角 + 前面一个空格）—— 这条测试只看参数对不对。
        let with_size = |name: &str, size: i64| {
            let msg = entry_preview(&file_entry(name, size));
            assert_eq!(msg.key, "notifyFilePreview", "{msg:?}");
            let param = |key: &str| {
                msg.params
                    .get(key)
                    .and_then(clip9_client::ParamValue::as_str)
                    .unwrap_or_else(|| panic!("少了 `{key}`：{msg:?}"))
                    .to_owned()
            };
            (param("name"), param("size"))
        };
        assert_eq!(
            with_size("报告.pdf", 2048),
            ("报告.pdf".into(), "2.0 KB".into())
        );
        assert_eq!(
            with_size("大图.png", 3 * 1024 * 1024),
            ("大图.png".into(), "3.0 MB".into())
        );
        assert_eq!(with_size("小.txt", 512), ("小.txt".into(), "512 B".into()));

        // ⚠️ `0` = **服务端没给**（`FileReceive::size` 的注释），不是「0 字节」——
        // 照着写「（0 B）」是一个具体的谎。⚠️ 这条路上**连括号一起省掉**：
        // 那是「名字」这一整句，而名字不是我们的话 → `verbatim`。
        assert_eq!(
            entry_preview(&file_entry("未知.bin", 0)),
            Msg::verbatim("未知.bin")
        );
        assert_eq!(
            entry_preview(&file_entry("负数.bin", -1)),
            Msg::verbatim("负数.bin")
        );
    }
}
