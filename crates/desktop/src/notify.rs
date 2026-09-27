//! 系统通知 —— **壳里唯一碰「通知」这件事的地方**。
//!
//! # 为什么要单独一个文件
//!
//! 与 [`crate::autostart`] 同一个判据（「这东西稳不稳」，不是「是不是插件」）：
//! 发一条通知要**三套**实现（macOS 的 `NSUserNotification` / Linux 的 `notify-send` /
//! Windows 的 toast），而这三套的细节都会变 —— 所以走官方插件
//!（`tauri-plugin-notification`）。
//!
//! ⚠️★ 但「发不发、发什么」**一条都不在这里**：那在 [`crate::runtime`] 里
//!（`upload_notification` / `download_notification` 两个纯函数）。理由与
//! `watch_config` 那一对一样：**这条判据错了不会有任何报错** ——
//! 要么「每复制一次弹一下」（用户第一件事就是去关掉这软件的通知，
//! 于是真正要紧的那条也没人看了），要么「该弹的不弹」（他根本不知道东西没发出去）。
//! 所以判据留在能测的那一侧，这里只负责把**已经定好的标题 + 正文**递出去。
//!
//! # ⚠️★ 页面**拿不到**这个能力
//!
//! 插件会给页面注入一段它自带的 JS（`init-iife.js`），但**能不能调**由 ACL 决定，
//! 而 `crates/desktop/capabilities/default.json` 里**故意没有 `notification:*`**。
//! 所以页面一行都调不到它，只有这里的 [`SystemNotifier`]（Rust 侧直接调
//! `NotificationExt`）能发。
//!
//! ⚠️ 这是**刻意**的，不是忘了配：这个项目里页面与壳的分工是「页面只跟 IPC 命令
//! 说话」（`docs/specs/desktop-client.md` §2 的硬边界）。加一个插件就给页面开一个
//! 新出口的话，那条边界就名存实亡了。
//!
//! # ⚠️ 为什么句柄是**后填**的（`OnceLock`）
//!
//! `Runtime` 必须在 `tauri::Builder` **之前**造出来（那时才拿得到 tokio 的句柄，
//! 见 `main.rs` 里那段顺序注释），而 `AppHandle` 只有 `setup` 里才有。
//! 所以这里留一个格子：`main.rs` 先造一个空的 [`SystemNotifier`] 交给运行时，
//! 到了 `setup` 再 [`SystemNotifier::attach`] 真实的句柄。
//!
//! ⚠️ 接上之前发通知是**丢掉并打一行日志**，不是 panic：真走到那条路上说明窗口
//! 都还没建起来，而那时也不存在「用户不在窗口里、看不到提示」这回事。
//!
//! # ⚠️ 开发期在 macOS 上，通知会以「终端」的名义弹出来
//!
//! [`notify_rust`] 在 `tauri::is_dev()` 时把归属应用设成 `com.apple.Terminal`
//!（插件源码 `desktop.rs` 里写死的），所以 `cargo tauri dev` / `cargo run` 下
//! 通知长的是终端的样子。打包之后才归 `com.clip9.desktop`。**这不是我们的 bug** ——
//! 验收时别照着「图标不是 clip9」去查。
//!
//! [`notify_rust`]: https://docs.rs/notify-rust

use std::sync::OnceLock;

/// 发一条系统通知。
///
/// ⚠️★ 抽成 trait 是为了让 [`crate::runtime::Runtime`] **不依赖 `tauri`** ——
/// 那个文件是**要测的接线**（见它的模块文档），测试里换成记录用的假实现。
///
/// ⚠️ 实现必须是 `Send + Sync`：运行时会在下行那条搬运任务里调它。
pub trait Notifier: Send + Sync {
    /// 发一条。**没有返回值**是刻意的 —— 通知弹不出来不该影响同步：
    /// 它是**旁路**（发失败最坏的结果是用户少看一眼提示，而不是「东西没发出去」）。
    /// 想让它可失败，上游就得处理一个「失败了也不能怎么办」的错误 —— 那是纯噪音。
    fn send(&self, title: &str, body: &str);
}

/// 真的把通知发给系统的那一份。
///
/// ⚠️ `show()` 在自己的实现里把真正的投递**丢进了异步运行时**（插件源码
/// `desktop.rs` 末尾那个 `tauri::async_runtime::spawn`），所以这里**不会阻塞** ——
/// 从下行的搬运任务里直接调它是安全的。
pub struct SystemNotifier {
    /// 真实的窗口句柄。⚠️ 只有 `setup` 里才拿得到，所以是**后填**的（见模块文档）。
    app: OnceLock<tauri::AppHandle>,
}

impl SystemNotifier {
    /// 造一份**还没接上窗口**的。`main.rs` 在 `tauri::Builder` 之前就这么造。
    #[must_use]
    pub fn new() -> Self {
        Self {
            app: OnceLock::new(),
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

impl Default for SystemNotifier {
    fn default() -> Self {
        Self::new()
    }
}

impl Notifier for SystemNotifier {
    fn send(&self, title: &str, body: &str) {
        use tauri_plugin_notification::NotificationExt;

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
