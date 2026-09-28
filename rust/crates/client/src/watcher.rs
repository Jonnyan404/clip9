//! 把真剪贴板接到 [`ClipboardSource`]，并按固定间隔轮询。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use clipboard_rs::common::RustImage;
use clipboard_rs::{Clipboard, ClipboardContext, ContentFormat};

use crate::debounce::Debouncer;
use crate::event::{ClipboardContent, ClipboardEvent};
use crate::source::ClipboardSource;

/// 监听参数。
#[derive(Debug, Clone, Copy)]
pub struct WatchConfig {
    /// 轮询间隔。
    ///
    /// ⚠️★ **默认 500ms，而且必须可配**（`docs/specs/desktop-client.md` §8 审计清单那条）：
    /// macOS / X11 上剪贴板**没有变更通知**，只能轮询 —— 所以这个间隔是
    /// 「**延迟 vs 空转**」的取舍，写死一个数就等于替用户做了这个取舍。
    pub poll_interval: Duration,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(500),
        }
    }
}

/// 系统剪贴板（`clipboard-rs`）。
///
/// ⚠️ 这是 `rust/crates/client` 里**唯一**碰系统的地方。
pub struct SystemClipboard;

/// 剥掉 `file://` 前缀 —— `clipboard-rs` 在部分平台会给带前缀的路径。
fn strip_file_scheme(raw: &str) -> PathBuf {
    PathBuf::from(raw.strip_prefix("file://").unwrap_or(raw))
}

fn read_files(ctx: &ClipboardContext) -> Option<Vec<PathBuf>> {
    if !ctx.has(ContentFormat::Files) {
        return None;
    }
    let files = ctx.get_files().ok()?;
    if files.is_empty() {
        return None;
    }
    Some(files.iter().map(|f| strip_file_scheme(f)).collect())
}

fn read_image(ctx: &ClipboardContext) -> Option<Vec<u8>> {
    if !ctx.has(ContentFormat::Image) {
        return None;
    }
    // ⚠️ 统一转 **PNG**：剪贴板里的原始格式各平台不同（DIB / TIFF / …），
    // 服务端与对端都不认，而 `docs/api.md` 的文件链路上 PNG 是通行的。
    let png = ctx.get_image().ok()?.to_png().ok()?;
    let bytes = png.get_bytes().to_vec();
    if bytes.is_empty() {
        return None;
    }
    Some(bytes)
}

fn read_text(ctx: &ClipboardContext) -> Option<String> {
    if !ctx.has(ContentFormat::Text) {
        return None;
    }
    let text = ctx.get_text().ok()?;
    if text.is_empty() {
        return None;
    }
    // ⚠️ 不 trim：用户复制的空白就是内容的一部分（而且 trim 会让
    // 「复制了带换行的日志」和「复制了同样内容但没换行」被判成同一个哈希）。
    Some(text)
}

impl ClipboardSource for SystemClipboard {
    fn read(&self) -> Option<ClipboardContent> {
        // ⚠️ 上下文**每次重建**：`clipboard-rs` 的 `ClipboardContext` 在部分平台
        // 不适合长期持有（`clip-sync` 的做法也是每次新建）。
        let ctx = ClipboardContext::new().ok()?;

        // ⚠️★ 优先级**文件 > 图片 > 文本** —— 见 `ClipboardContent` 的注释。
        // 这个顺序就是「一次复制只产生一个事件」的全部保证。
        if let Some(paths) = read_files(&ctx) {
            return Some(ClipboardContent::Files(paths));
        }
        if let Some(png) = read_image(&ctx) {
            return Some(ClipboardContent::Image(png));
        }
        if let Some(text) = read_text(&ctx) {
            return Some(ClipboardContent::Text(text));
        }
        None
    }
}

/// 监控线程的把手。**drop 它就停** —— 别让线程自己跑，那会让进程退不出去
/// （Tauri 关窗后进程还在，用户会以为它卡住了）。
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WatchHandle {
    /// 明确地停掉（与 `drop` 等价，但意图更清楚）。会 **join**，所以最多等一个轮询间隔。
    pub fn stop(mut self) {
        self.signal_and_join();
    }

    fn signal_and_join(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.signal_and_join();
    }
}

/// 起一个后台线程监控剪贴板：每读到一个**新**内容就调一次 `on_event`。
///
/// ⚠️★ 调用方**必须**先 [`prime_from_current`]（把当前剪贴板记为「已经见过」），
/// 否则第一拍就会把它当成一次变化推出去 —— 那是用户报过的现象，见那个函数的注释。
///
/// ⚠️ `on_event` 在**监控线程**上跑 —— 它必须**立刻返回**（把活儿丢给别的任务），
/// 否则会把轮询卡住、漏掉后面的变化。上行要用通道 / 异步任务，别在这里做 IO。
///
/// ⚠️★ `debouncer` 是**外面传进来的**（不是这个函数自己造的），因为下行也要用它：
/// 下行把收到的内容写进剪贴板之前必须 [`Debouncer::prime`] 一下（防回环，见那里的注释），
/// 而「谁记得上一次是什么」**只能有一处**。两处各自记的话，预置等于没预置 ——
/// 表现就是两个客户端之间来回弹。
///
/// ⚠️ 为什么用自己的轮询循环、而不是 `clipboard-rs` 的 `ClipboardWatcher`：
/// 三端一个形状、间隔可配、能干净地停 —— 而 `ClipboardWatcher` 在 macOS 上本来
/// 也是轮询（没有变更通知）。将来真要给 Windows 上事件驱动，只需换掉
/// [`ClipboardSource`] 的实现，这个循环不用动。
#[must_use]
pub fn spawn_watcher<F>(
    source: Box<dyn ClipboardSource>,
    config: WatchConfig,
    debouncer: Arc<Mutex<Debouncer>>,
    on_event: F,
) -> WatchHandle
where
    F: Fn(ClipboardEvent) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);

    let thread = thread::Builder::new()
        .name("clip9-clipboard-watch".to_owned())
        .spawn(move || {
            while !stop_flag.load(Ordering::Relaxed) {
                let content = source.read();
                // ⚠️ 锁的作用域**只有判重这一步** —— 不能把 `on_event` 也包进来：
                // 那样下行想预置指纹时会一直等（它要锁同一把），而锁的持有者正在等外部 IO。
                let event = content.and_then(|content| {
                    debouncer
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .accept(content)
                });
                if let Some(event) = event {
                    on_event(event);
                }
                thread::sleep(config.poll_interval);
            }
        })
        .expect("起剪贴板监控线程失败");

    WatchHandle {
        stop,
        thread: Some(thread),
    }
}

/// 造一个可以给 [`spawn_watcher`] 与 [`crate::spawn_receiver`] 共用的判重器。
#[must_use]
pub fn shared_debouncer() -> Arc<Mutex<Debouncer>> {
    Arc::new(Mutex::new(Debouncer::new()))
}

/// 把**当前**剪贴板内容记为「已经见过」——起监听**之前**调。
///
/// ⚠️★★ 为什么必须有这一步（2026-09-27 修的，用户报的「default 房间连上就提示」）：
/// [`Debouncer`] 起步时三个指纹都是 `0`，于是监控线程**读到的第一份内容**
/// 一定被判成「新的」→ 立刻走一次上行。两个后果，都不是小事：
///
/// 1. **一个房间都没开 ↑ 时**（`Channel::new` 的默认就是 `false`，装完就是这状态），
///    界面在**刚连上那一刻**弹一条「没有发出去…」—— 而用户**根本没复制任何东西**。
///    他原话是「default 房间连上提示相关开关关着」，还补了一句「那个开关功能早就
///    移除不存在了」（他指的是 §4.1 第 5 条删掉的那个全局同步开关）。
/// 2. **开着 ↑ 时更糟**：启动会把**上次关机前留在剪贴板里的东西**当成一次新变化
///    再发一遍到房间里。那对房间来说是一条凭空多出来的消息。
///
/// 两件的根子是同一句：「监控」的语义是「**变化**」，而进程刚起来时**没有变化可言** ——
/// 库里那份是上一轮的遗留，不是这一次的输入。
///
/// ⚠️ 与本函数对称的那条已经在 `receiver::apply_entry` 里：下行写剪贴板前也要
/// `prime`（防回环）。两条合起来才是「谁记得上一次是什么，只能有一处」的完整说法。
///
/// ⚠️ 读不到内容（剪贴板空 / 没有权限）时**什么都不做** —— 不是错误：
/// 那时第一份真内容本来就该发出去。
pub fn prime_from_current(source: &dyn ClipboardSource, debouncer: &Arc<Mutex<Debouncer>>) {
    let Some(content) = source.read() else {
        return;
    };
    debouncer
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .prime(&content);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::mpsc;

    use crate::debounce::Fingerprints;

    /// 按脚本吐内容的假剪贴板：读完了就一直 `None`。
    struct ScriptedSource {
        reads: Mutex<VecDeque<Option<ClipboardContent>>>,
    }

    impl ClipboardSource for ScriptedSource {
        fn read(&self) -> Option<ClipboardContent> {
            self.reads.lock().expect("锁没坏").pop_front().flatten()
        }
    }

    fn scripted(items: Vec<Option<ClipboardContent>>) -> Box<dyn ClipboardSource> {
        Box::new(ScriptedSource {
            reads: Mutex::new(items.into()),
        })
    }

    fn fast() -> WatchConfig {
        WatchConfig {
            poll_interval: Duration::from_millis(5),
        }
    }

    /// ⚠️★ **刚起步那一拍不许把库里那份当成一次变化**（2026-09-27 修的）。
    ///
    /// 没有这一步的话，`Debouncer` 三个槽都是 0 → 读到的第一份内容必然被当成新的。
    /// 这条用例把那个后果直接钉出来：**先 `prime_from_current`，再跑监控线程**，
    /// 于是脚本里第一份（= 启动时剪贴板里本来就有的那份）**一个事件都不该产生**，
    /// 后面那份才该发。
    ///
    /// ⚠️ 断言必须落在「第一份不发」上：只测「第二份会发」的话，把这一整步删掉
    /// 用例**照样是绿的**（第一份会多发一次事件，而测试只等了一条）——
    /// 那正是「跑过了 ≠ 钉住了」。
    #[test]
    fn the_clipboard_we_inherit_at_startup_is_not_an_event() {
        let pending = scripted(vec![
            Some(ClipboardContent::Text("上一轮留在剪贴板里的".to_owned())),
            Some(ClipboardContent::Text("上一轮留在剪贴板里的".to_owned())),
            Some(ClipboardContent::Text("这次真的复制了别的".to_owned())),
        ]);
        let debouncer = shared_debouncer();

        // ⚠️ 顺序是**先预置、再起线程**，与 `Runtime::start_watcher` 里一致。
        prime_from_current(pending.as_ref(), &debouncer);

        let (tx, rx) = mpsc::channel();
        let handle = spawn_watcher(pending, fast(), Arc::clone(&debouncer), move |event| {
            let _ = tx.send(event);
        });

        let first = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("该收到「这次真的复制了别的」");
        assert!(
            matches!(first, ClipboardEvent::Text { ref content, .. } if content == "这次真的复制了别的"),
            "启动时剪贴板里那一份被当成了一次新变化：{first:?}"
        );
        handle.stop();
    }

    /// 剪贴板是空的（或没权限读）时，这一步**什么都不做** ——
    /// 那时第一份真内容本来就该发出去，不能被「预置」误伤。
    #[test]
    fn priming_an_empty_clipboard_leaves_the_next_read_alone() {
        let debouncer = shared_debouncer();
        prime_from_current(scripted(vec![None]).as_ref(), &debouncer);
        assert_eq!(
            debouncer.lock().expect("锁没坏").fingerprints(),
            Fingerprints::default(),
            "没读到内容就不该动指纹"
        );
    }

    /// 端到端：**只有新内容会被推出去**，而且 `stop()` 之后线程真的停。
    ///
    /// 这条同时钉住两件事：`Debouncer` 在循环里真的接上了（不是每读一次就无脑发），
    /// 以及「线程能被停掉」—— 后者是**进程退不退得出去**的前提。
    #[test]
    fn emits_only_new_content_and_stops_on_request() {
        let (tx, rx) = mpsc::channel();
        let handle = spawn_watcher(
            scripted(vec![
                Some(ClipboardContent::Text("a".to_owned())),
                Some(ClipboardContent::Text("a".to_owned())), // 重复 —— 不该再发
                Some(ClipboardContent::Text("b".to_owned())),
            ]),
            fast(),
            shared_debouncer(),
            move |event| {
                let _ = tx.send(event);
            },
        );

        let first = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("应当收到第一条");
        let second = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("应当收到第二条");
        assert!(matches!(first, ClipboardEvent::Text { ref content, .. } if content == "a"));
        assert!(matches!(second, ClipboardEvent::Text { ref content, .. } if content == "b"));

        // 脚本读完了 —— 之后不该再有事件（尤其**不该**每轮把 `None` 当内容）。
        assert!(
            rx.recv_timeout(Duration::from_millis(80)).is_err(),
            "脚本结束后不该再推事件"
        );

        // 停掉：会 join，最多等一个间隔。
        handle.stop();
    }

    /// `drop` 也要能停 —— 上游（Tauri 壳）很可能只是让句柄离开作用域。
    #[test]
    fn dropping_the_handle_stops_the_thread() {
        let (tx, rx) = mpsc::channel();
        let handle = spawn_watcher(
            scripted(vec![Some(ClipboardContent::Text("x".to_owned()))]),
            fast(),
            shared_debouncer(),
            move |event| {
                let _ = tx.send(event);
            },
        );
        rx.recv_timeout(Duration::from_secs(2)).expect("先收到一条");
        drop(handle);
        // 线程已经 join（drop 里做的），所以这里立刻能确认没有新事件。
        assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
    }

    /// ⚠️★ **预置过的内容不会被这条监控线程再发一遍** —— 这就是防回环在
    /// 「真线程 + 共享判重器」这个组合下的样子。
    ///
    /// 下行的用法是：写剪贴板**之前**先 `prime`，然后监控线程读到的就是同一份内容。
    /// 这条测试把那个顺序演了一遍。
    #[test]
    fn a_primed_content_is_not_emitted() {
        let (tx, rx) = mpsc::channel();
        let debouncer = shared_debouncer();

        // 模拟下行：先预置，再让剪贴板里出现同样的内容（这里用脚本假扮）。
        debouncer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .prime(&ClipboardContent::Text("远端发来的".to_owned()));

        let handle = spawn_watcher(
            scripted(vec![
                Some(ClipboardContent::Text("远端发来的".to_owned())),
                Some(ClipboardContent::Text("用户自己复制的".to_owned())),
            ]),
            fast(),
            Arc::clone(&debouncer),
            move |event| {
                let _ = tx.send(event);
            },
        );

        let got = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("应当只收到用户自己复制的那条");
        assert!(
            matches!(got, ClipboardEvent::Text { ref content, .. } if content == "用户自己复制的"),
            "预置过的内容被当成新事件发出去了（防回环失效）"
        );
        assert!(
            rx.recv_timeout(Duration::from_millis(80)).is_err(),
            "不该还有第二条"
        );
        handle.stop();
    }
}
