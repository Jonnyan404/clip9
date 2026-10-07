//! 进程级 TLS provider —— ⚠️ 桌面端**必须**显式装一个，不装就 panic。
//!
//! # 为什么（2026-10-07 实测）
//!
//! `rustls` 0.23 在**两个 provider feature 同时开着**时**拒绝自动选择**，
//! 第一次做 TLS 时当场 panic：
//!
//! ```text
//! Could not automatically determine the process-level CryptoProvider from Rustls crate features.
//! Call CryptoProvider::install_default() before this point to select a provider manually,
//! or make sure exactly one of the 'aws-lc-rs' and 'ring' features is enabled.
//! ```
//!
//! 而这个依赖图里两个都开着，且**两处都调不掉**：
//!
//! | 来源 | 带进来的 provider |
//! |---|---|
//! | `reqwest` 的 `default-tls`（0.13 起默认 rustls） | **`aws-lc-rs`** |
//! | `tauri-plugin-updater`（自己写死 `rustls = { features = ["ring"] }`） | **`ring`** |
//!
//! ⇒ 按报错里那句做：**启动时装一个默认 provider**，把「让 rustls 猜」变成「我们明说」。
//!
//! # ⚠️★ 为什么这个 bug 值得单独一个模块 + 一条判据
//!
//! 它的**症状**是最难查的那一种：panic 发生在 `tokio` 的工作线程里 →
//! 那条连接任务**当场死掉**，而壳里没有谁负责重连它（`receiver::run_room` 的重连循环
//! 是**在那条任务内部**转的）→ 界面上那个房间**永久停在它最后一次上报的状态**，
//! 也就是「正在连 X…」，没有原因、也没有任何超时会触发。
//! 2026-10-07 Jonny 报的「桌面端 CF 一直显示正在连」就是这个（同一天 SPA 打开正常 ——
//! 浏览器有自己的 TLS 栈，完全不碰这条路）。
//!
//! ⚠️ 它**只**出现在 `wss://` / `https://` 上：本地服务端那条是
//! `http://127.0.0.1:9501` 明文，一行 TLS 都不走 —— 所以
//! 「本地那两个房间好好的、只有 Cloudflare 那个死掉」正是它的指纹。
//!
//! ⚠️ 而它在 **debug** 下只死一条任务（`unwind`），在 **release** 下会**整个进程 abort**
//! （根 `Cargo.toml` 的 `panic = "abort"`）—— 也就是说：放着不管，下一个发布版一启动就崩。
//!
//! ⚠️★ 它**骗过了一次本机复现**：我拿 `cargo test -p clip9-client` 用客户端自己的代码
//! 连线上是**通的** —— 因为那次构建里没有 `tauri-plugin-updater`，只有单一 provider。
//! 教训：**复现要用与被测二进制同一套 feature 解析**（`-p <壳>` ≠ `-p <库>`）。
//!
//! # 为什么装 `aws-lc-rs` 而不是 `ring`
//!
//! 两个实现都在这个构建里（都被上面的依赖拉进来了），选哪个都能用。选 `aws-lc-rs`
//! 是因为**它本来就是 reqwest 会选的那一个**，而 reqwest 是这里最忙的 TLS 使用者
//! （历史 / 上传 / 预览）—— 装它等于「不改变本来会发生的选择」。
//! 插件那边用的是 `reqwest/rustls-no-provider`：它**本来就在等宿主装一个默认 provider**。

use std::sync::Once;

static INSTALL: Once = Once::new();

/// 装进程级默认 TLS provider。**幂等**，重复调用无害。
///
/// ⚠️ 必须在**任何** TLS 之前调用 —— `main()` 的第一句。晚于第一次 `wss://` 就没用了：
/// 那次已经在 `rustls` 里 panic 过了。
pub fn install_crypto_provider() {
    INSTALL.call_once(|| {
        // 已经被别人装过（`install_default` 那时回 `Err`）就当成功：
        // 我们要的只是「别让 rustls 去猜」，谁装的不重要。
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ 这条判据**有牙**（变异验证过）：把 `install_crypto_provider()` 里那句
    /// `install_default` 删掉，这里就会 panic —— 因为这个包的 feature 解析里
    /// `aws-lc-rs` 与 `ring` **都**开着（见模块文档那张表）。
    ///
    /// ⚠️ 它必须放在**这个包**里：判据的牙来自「与被测二进制同一套 feature 解析」，
    /// 放到 `clip9-client` 里就变成永远绿了（那次本机复现就是这么被骗过去的）。
    #[test]
    fn the_default_provider_is_installed_so_rustls_does_not_guess() {
        install_crypto_provider();

        assert!(
            rustls::crypto::CryptoProvider::get_default().is_some(),
            "没有默认 provider —— 第一次 wss:// 连接会在工作线程里 panic"
        );

        // 下面这一句就是 `reqwest` / `tokio-tungstenite` / updater 内部走的那条路：
        // 没有默认 provider 而两个 provider feature 都开着时，`builder()` 自己会 panic。
        // ⚠️ 不用真连网：panic 发生在建 TLS 配置这一步，早于任何 socket。
        let _ = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
    }

    /// 幂等：`main()` 里装一次，测试各自也可能装一次 —— 第二次不能炸。
    #[test]
    fn installing_twice_is_harmless() {
        install_crypto_provider();
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
