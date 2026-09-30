//! 系统通知 —— 壳里**唯一**碰「通知」的地方。走官方插件 `tauri-plugin-notification`
//!（三套平台实现都会变，不值得自己写，与 [`crate::autostart`] 同一个判据）。
//!
//! ⚠️★ 「发不发、发什么」**一条都不在这里** —— 那在 [`crate::runtime`] 的两个纯函数
//!（`upload_notification` / `download_notification`）。理由：这条判据错了**没有任何报错**，
//! 要么「每复制一次弹一下」（用户第一件事就是关掉通知，于是要紧的那条也没人看），
//! 要么「该弹的不弹」（他根本不知道东西没发出去）。判据留在**能测的那一侧**，
//! 这里只把已经定好的标题 + 正文递出去。
//!
//! ⚠️★ **文本由壳自己渲染**：通知是**操作系统画的**，页面渲染不了 → `Notifier::send`
//! 收 [`Msg`]（键 + 参数），成文在 [`SystemNotifier::send`]，用页面推来的字典
//!（[`crate::shell_text`]）。⚠️ 「什么时候该弹」仍然只在 [`crate::runtime`] 里判 ——
//! 那一侧看不到 `tauri`。
//!
//! ⚠️★ `capabilities/default.json` **故意没有 `notification:*`** —— 页面一行都调不到，
//! 只有 Rust 侧（直接调 `NotificationExt`）能发。**刻意**的，不是忘了配：项目的硬边界是
//! 「页面只跟 IPC 命令说话」（`dev-docs/specs/desktop-client.md` §2）。
//!
//! ⚠️ 句柄**后填**（`OnceLock`）：`Runtime` 必须在 `tauri::Builder` **之前**造出来
//!（那时才拿得到 tokio 句柄），而 `AppHandle` 只有 `setup` 里才有。
//! 接上之前发通知是**丢掉 + 打一行日志**，不是 panic —— 走到那条路说明窗口都还没建起来。
//!
//! ⚠️ macOS 开发期通知以「终端」的名义弹（插件在 `is_dev()` 时写死 `com.apple.Terminal`），
//! 打包后才归 `com.clip9.desktop`。**不是我们的 bug**，验收时别照图标去查。

use std::sync::{Arc, OnceLock};

use clip9_client::Msg;

use crate::shell_text::ShellText;

/// 发一条系统通知。
///
/// ⚠️★ 抽成 trait 是为了让 [`crate::runtime::Runtime`] **不依赖 `tauri`** ——
/// 那个文件是**要测的接线**（见它的模块文档），测试里换成记录用的假实现。
///
/// ⚠️ 实现必须是 `Send + Sync`：运行时会在下行那条搬运任务里调它。
pub trait Notifier: Send + Sync {
    /// 发一条（收的是**键 + 参数**，见模块文档「文本谁来渲染」）。
    ///
    /// **没有返回值**是刻意的 —— 通知弹不出来不该影响同步：
    /// 它是**旁路**（发失败最坏的结果是用户少看一眼提示，而不是「东西没发出去」）。
    /// 想让它可失败，上游就得处理一个「失败了也不能怎么办」的错误 —— 那是纯噪音。
    fn send(&self, title: &Msg, body: &Msg);
}

/// 真的把通知发给系统的那一份。
///
/// ⚠️ `show()` 在自己的实现里把真正的投递**丢进了异步运行时**（插件源码
/// `desktop.rs` 末尾那个 `tauri::async_runtime::spawn`），所以这里**不会阻塞** ——
/// 从下行的搬运任务里直接调它是安全的。
pub struct SystemNotifier {
    /// 真实的窗口句柄。⚠️ 只有 `setup` 里才拿得到，所以是**后填**的（见模块文档）。
    app: OnceLock<tauri::AppHandle>,
    /// 壳自己要说的那几句话的字典（页面推过来的）。⚠️ **和窗口句柄一样是「后填」的** ——
    /// 造的时候它还空着，页面起来之后再推。所以它是 `Arc` 共享的（同一个
    /// [`ShellText`] 也被托盘和文件对话框用着），不是这里 `new` 一个。
    shell: Arc<ShellText>,
}

impl SystemNotifier {
    /// 造一份**还没接上窗口**的。`main.rs` 在 `tauri::Builder` 之前就这么造。
    #[must_use]
    pub fn new(shell: Arc<ShellText>) -> Self {
        Self {
            app: OnceLock::new(),
            shell,
        }
    }

    /// 把窗口句柄接上（`setup` 里调一次）。
    ///
    /// ⚠️ 重复接**不换**（`OnceLock::set` 失败就丢掉）：这是启动时的一次性动作，
    /// 真被调两次说明顺序写错了，那时「用第一个接上的」比「悄悄换成第二个」好查。
    pub fn attach(&self, app: tauri::AppHandle) {
        if self.app.set(app).is_err() {
            eprintln!("窗口句柄已经接过了，这次忽略（通知照旧走第一次那个）。");
        }
    }
}

impl Notifier for SystemNotifier {
    fn send(&self, title: &Msg, body: &Msg) {
        use tauri_plugin_notification::NotificationExt;

        // ⚠️★ **成文就在这里**：页面渲染不了系统通知（它连 `notification:*` 权限都没有），
        // 所以壳拿字典把两句 `Msg` 渲染出来（`shell_text` 的模块文档里有这条分工）。
        // ⚠️ 字典是页面推过来的；推过来之前这里拿到的是**键本身** ——
        // 那时窗口都还没画完，能看见一条带键的通知比看不见好查。
        let title = self.shell.say(title);
        let body = self.shell.say(body);
        let (title, body) = (title.as_str(), body.as_str());

        let Some(app) = self.app.get() else {
            // ⚠️ 窗口还没建起来（`setup` 还没跑）。丢掉 + 说一句 ——
            // 静默丢掉的话，这一条唯一的线索也没了。
            eprintln!("窗口还没接上，这条通知发不出去：{title} / {body}");
            return;
        };
        // ⚠️ 插件在 macOS 上的错误大多在它自己内部被 `let _ =` 丢掉了
        //（见它的 `desktop.rs`），所以这里能报出来的只有「插件这一层」的错。
        // 能报的都报出来：通知发不出去这件事，用户与我们都只有日志这一条线索。
        if let Err(err) = app.notification().builder().title(title).body(body).show() {
            eprintln!("发系统通知失败：{err}（title={title}）");
        }
    }
}
