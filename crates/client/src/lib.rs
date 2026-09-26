//! clip9 客户端：剪贴板监控 + 上行 + 下行。
//!
//! 桌面与 Android 共用 —— 服务端和客户端会跑在**同一个 Android 应用进程**里，
//! 所以两边都依赖 `protocol`，但**监听端口必须可配**，且端口被占用时要明确报错
//! （不能静默换端口，那会让用户以为服务在跑其实没跑）。
//!
//! # ⚠️★ 这个 crate 里**不许出现 `tauri`**
//!
//! 见 `docs/specs/desktop-client.md` §2。剪贴板同步的逻辑（去重、防抖、分类、重试）
//! **全是要测的部分**，绑进 Tauri 之后就只能靠手动点界面来验 —— 那正是这个项目
//! 一直在避免的事。Tauri 只该出现在 `crates/desktop` 里，而且只负责
//! 「把事件转成这里的调用」+ 托盘/窗口。
//!
//! # 分层（**为「能独立测」而分**）
//!
//! ```text
//! ClipboardSource   「从系统剪贴板读一次」的抽象（`clipboard-rs` 藏在它后面）
//!        ↓
//!   Debouncer       去重防抖（**三个哈希**）+ 分类      ★纯逻辑，重点测
//!        ↓
//! ClipboardEvent    对外唯一的产出形状
//! ```
//!
//! 为什么非得抽 `ClipboardSource`：**真剪贴板在单测里跑不了**（CI 里没有，也不该
//! 依赖剪贴板里恰好有什么）。抽掉「读」之后，`Debouncer` 与分类都成了纯函数，
//! 可以喂任意假输入 —— 而它们恰好是行为基准（`clip-sync`）里最该被钉住的部分。
//!
//! # 现状
//!
//! **W1（监听 + 去重防抖 + 分类）已落地**。上行（W2）、下行（W2）与 Tauri 壳（W3）
//! 见 `docs/specs/desktop-client.md` §0.1 的切片表。

pub mod classify;
pub mod debounce;
pub mod event;
pub mod source;
pub mod watcher;

pub use debounce::{Debouncer, Fingerprints};
pub use event::{ClipboardContent, ClipboardEvent, TextSubtype};
pub use source::ClipboardSource;
pub use watcher::{SystemClipboard, WatchConfig, WatchHandle, spawn_watcher};
