//! clip9 客户端：剪贴板监控 + 上行 + 下行。
//!
//! 桌面与 Android 共用 —— 服务端和客户端会跑在**同一个 Android 应用进程**里，
//! 所以两边都依赖 `protocol`，但**监听端口必须可配**，且端口被占用时要明确报错
//! （不能静默换端口，那会让用户以为服务在跑其实没跑）。
//!
//! 现状：**还没实现**。吸收现有 `clip-sync/src-tauri` 的 clipboard / uploader / receiver。
