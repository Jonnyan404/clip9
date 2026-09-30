//! clip9 客户端：剪贴板监控 + 上行 + 下行。
//!
//! 桌面与 Android 共用 —— 服务端和客户端会跑在**同一个 Android 应用进程**里，
//! 所以两边都依赖 `protocol`，但**监听端口必须可配**，且端口被占用时要明确报错
//! （不能静默换端口，那会让用户以为服务在跑其实没跑）。
//!
//! # ⚠️★ 这个 crate 里**不许出现 `tauri`**
//!
//! 见 `dev-docs/specs/desktop-client.md` §2。剪贴板同步的逻辑（去重、防抖、分类、重试）
//! **全是要测的部分**，绑进 Tauri 之后就只能靠手动点界面来验 —— 那正是这个项目
//! 一直在避免的事。Tauri 只该出现在 `rust/crates/desktop` 里，而且只负责
//! 「把事件转成这里的调用」+ 托盘/窗口。
//!
//! # 分层（**为「能独立测」而分**）
//!
//! ```text
//! ClipboardSource        「从系统剪贴板读一次」      ← clipboard-rs 藏在后面
//!        ↓
//!   Debouncer            去重防抖（**三个哈希**）+ 分类        ★纯逻辑，重点测
//!        ↓                                        ↑
//! ClipboardEvent         对外唯一的产出形状            │ prime（防回环）
//!        ↓                                        │
//!   uploader             上行：发到**所有**开着上行的房间      │
//!                                                 │
//!   receiver             下行：连 WS + 取历史 + 边界水印       │
//!        ↓                                        │
//! ClipboardSink          「往剪贴板写一次」───────────────────┘
//! ```
//!
//! 为什么非得抽 `ClipboardSource` / `ClipboardSink`：**真剪贴板在单测里跑不了**
//! （CI 里没有，也不该依赖剪贴板里恰好有什么）。抽掉「读」与「写」之后，
//! `Debouncer`、分类、**边界判定**都成了纯函数，可以喂任意假输入 ——
//! 而它们恰好是行为基准（`clip-sync`）里最该被钉住的部分。
//!
//! ⚠️★ **`watcher` 与 `receiver` 必须共享同一个 [`Debouncer`]**
//! （[`shared_debouncer`] 就是造它用的）。理由见 [`Debouncer::prime`]：
//! 下行写剪贴板之前要预置指纹来**防回环**，而「谁记得上一次是什么」只能有一处。
//!
//! # 两个方向的开关是**两维**的
//!
//! 上行 / 下行 × 内容类型，见 [`ClientConfig`] 的模块文档（`config.rs`）。
//! ⚠️ 一句话：**上传可以是多个房间，下载全局只能一个，而且默认是关的。**
//!
//! # 现状
//!
//! - **W1（监听 + 去重防抖 + 分类）** ✅
//! - **W2（上行 + 下行 + 边界水印）** ✅
//! - **W3（Tauri 壳：托盘 / 窗口 / 命令 / 自启）** —— 在 `rust/crates/desktop`，
//!   见 `dev-docs/specs/desktop-client.md` §0.1 的切片表。
//!
//! ⚠️ W2 的**验收要在真机上做**（两台机器互相复制文字/图片/文件，见 §7）——
//! 单测能钉住的是「边界怎么判、URL 怎么拼、开关怎么筛」，钉不住
//! 「你的桌面上 `clipboard-rs` 到底能不能用」。

pub mod classify;
pub mod config;
pub mod debounce;
pub mod download;
pub mod endpoint;
pub mod event;
pub mod msg;
pub mod receiver;
pub mod sink;
pub mod source;
pub mod uploader;
pub mod watcher;

pub use config::{
    Channel, ClientConfig, EMOJI_POOL, clean_emoji, normalize_server, resolve_emojis,
    room_identity, same_endpoint,
};
pub use debounce::{Debouncer, Fingerprints};
pub use event::{ClipboardContent, ClipboardEvent, TextSubtype, UploadKind};
pub use msg::{Msg, ParamValue};
pub use receiver::{
    Boundary, Handshake, Latency, PeerDevice, ReceiverEvent, ReceiverHandle, ReceiverStatus,
    ReceiverUpdate, Verdict, parse_event, parse_handshake, spawn_receiver,
};
pub use sink::ClipboardSink;
pub use source::ClipboardSource;
pub use uploader::{
    ServerLimits, SkipReason, UploadOutcome, UploadPayload, UploadReport, UploadedEntry,
    upload_event, upload_explicit,
};
pub use watcher::{
    SystemClipboard, WatchConfig, WatchHandle, prime_from_current, shared_debouncer, spawn_watcher,
};
