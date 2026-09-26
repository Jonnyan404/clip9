//! 「从系统剪贴板读一次」的抽象 —— 把 `clipboard-rs` 挡在 trait 后面。
//!
//! ⚠️ 抽它的唯一目的是**能独立测**：真剪贴板在单测里跑不了（CI 里没有，也不该
//! 依赖剪贴板里恰好有什么内容），而 `Debouncer` 与分类恰好是最该被钉住的部分。
//! 有了这层抽象，测试可以喂任意假输入。
//!
//! ⚠️ 它同时也是一道**边界**：`crates/client` 里能碰系统的地方只剩这个 trait 的
//! 实现（目前只有 `watcher::SystemClipboard`）—— 别的模块都是纯逻辑。

use crate::event::ClipboardContent;

/// 一次剪贴板快照。
pub trait ClipboardSource: Send {
    /// 读一次。没内容 → `None`。
    ///
    /// ⚠️★ 实现**必须**按「**文件 > 图片 > 文本**」的优先级**只挑一个**返回，
    /// **不能**三样都返回 —— 复制一个文件时剪贴板里同时有文件与文本，
    /// 都当成事件发出去会把**一次复制**变成三条消息。理由见
    /// [`ClipboardContent`] 的注释。
    fn read(&self) -> Option<ClipboardContent>;
}
