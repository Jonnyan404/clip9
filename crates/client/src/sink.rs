//! 「往系统剪贴板写一次」的抽象 —— 下行（W2）用它。
//!
//! ⚠️ 与 [`crate::ClipboardSource`] 是**一对**：一个读、一个写。
//! 分成两个 trait 而不是一个「读写」trait，是因为**它们的消费方完全不同**：
//! 上行（监控线程）只需要读，下行（接收线程）只需要写。
//! 合成一个会让两边都得凭空实现另一半，于是测试里到处都是
//! `unimplemented!()` —— 那种「为了满足签名而写」的实现是负资产。
//!
//! ⚠️ 与读那一侧同样的理由：抽它的唯一目的是**能独立测**。
//! 下行要测的是「哪些该写、写什么」，而不是「`clipboard-rs` 在你的桌面上能不能用」。

use std::path::PathBuf;

use clipboard_rs::{Clipboard, ClipboardContext};

use crate::watcher::SystemClipboard;

/// 往剪贴板写。
pub trait ClipboardSink: Send + Sync {
    /// 写文本。
    fn set_text(&self, text: &str) -> Result<(), String>;

    /// 写一批文件（**绝对路径**）。
    ///
    /// ⚠️★ **图片也走这条路**（`docs/specs/desktop-client.md` §4.1 末：
    /// 「上传时按文件发、**下载时按文件收**」）。所以下行的实现是：
    /// 先把字节落盘，再把这个文件的路径交给这里 —— 而不是去调
    /// `set_image`。理由有两条：
    ///
    /// 1. **一致**：上行图片就是当文件发的（服务端存的是文件条目），
    ///    下行当文件收，一个来回之后两端的形状没变；
    /// 2. **可查**：落盘之后用户能在下载目录里看到它。
    ///    直接写进剪贴板图片的话，这条内容在本机**没有任何落点**，
    ///    用户想再找回来只能重新同步一次。
    fn set_files(&self, paths: &[PathBuf]) -> Result<(), String>;
}

impl ClipboardSink for SystemClipboard {
    fn set_text(&self, text: &str) -> Result<(), String> {
        // ⚠️ 与读那一侧同一个理由：上下文**每次重建**
        // （`clipboard-rs` 的 `ClipboardContext` 在部分平台不适合长期持有）。
        let ctx = ClipboardContext::new().map_err(|e| format!("无法创建剪贴板上下文：{e}"))?;
        ctx.set_text(text.to_owned())
            .map_err(|e| format!("写剪贴板文本失败：{e}"))
    }

    fn set_files(&self, paths: &[PathBuf]) -> Result<(), String> {
        if paths.is_empty() {
            return Err("没有文件可写".to_owned());
        }
        let ctx = ClipboardContext::new().map_err(|e| format!("无法创建剪贴板上下文：{e}"))?;
        // ⚠️ `clipboard-rs` 要 `Vec<String>`；这里把**绝对路径**原样给它
        // （不加工、不加 `file://` —— 加了之后部分平台会当成普通文件名）。
        let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
        ctx.set_files(list)
            .map_err(|e| format!("写剪贴板文件失败：{e}"))
    }
}

/// 测试用的假实现：**只记不写**。
///
/// ⚠️ 下行与上行的测试都要用它 —— 所以它在 `cfg(test)` 下是 `pub(crate)`，
/// 而不是塞在某个 `mod tests` 里面。
#[cfg(test)]
#[derive(Default)]
pub(crate) struct RecordingSink {
    pub(crate) written: std::sync::Mutex<Vec<String>>,
}

#[cfg(test)]
impl RecordingSink {
    /// 已经写下去的东西，按发生顺序（`text:…` / `files:…`）。
    pub(crate) fn taken(&self) -> Vec<String> {
        self.written
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
impl ClipboardSink for RecordingSink {
    fn set_text(&self, text: &str) -> Result<(), String> {
        self.written
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(format!("text:{text}"));
        Ok(())
    }

    fn set_files(&self, paths: &[PathBuf]) -> Result<(), String> {
        // ⚠️ 假实现也要**照抄真实现的那条拒绝规则** —— 一个不比真的更宽松、
        // 也不比真的更严格的替身，才叫替身；否则测试验的是替身的脾气。
        if paths.is_empty() {
            return Err("没有文件可写".to_owned());
        }
        let joined = paths
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(",");
        self.written
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(format!("files:{joined}"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 编译期检查：真剪贴板**同时**满足读与写两个 trait。
    /// 这条测试的价值全在编译期 —— 运行时不碰真剪贴板，CI 里也能跑。
    #[test]
    fn the_system_clipboard_implements_both_sides() {
        fn assert_source<T: crate::ClipboardSource + ?Sized>() {}
        fn assert_sink<T: ClipboardSink + ?Sized>() {}
        assert_source::<SystemClipboard>();
        assert_sink::<SystemClipboard>();
    }

    /// 假实现能被当 trait object 用（下行就是这样持有它的），而且按顺序记账。
    #[test]
    fn a_recording_sink_can_be_used_as_a_trait_object() {
        let sink = RecordingSink::default();
        let dyn_sink: &dyn ClipboardSink = &sink;
        dyn_sink.set_text("hello").unwrap();
        dyn_sink
            .set_files(&[PathBuf::from("/tmp/a.txt"), PathBuf::from("/tmp/b.txt")])
            .unwrap();
        assert_eq!(
            sink.taken(),
            vec![
                "text:hello".to_owned(),
                "files:/tmp/a.txt,/tmp/b.txt".to_owned()
            ]
        );
    }

    /// 空文件列表要**报错**，不能装着写成功（那会让下行误以为已经同步）。
    ///
    /// ⚠️ 这条是直接对**真实现**断言的 —— 而它是安全的：`SystemClipboard::set_files`
    /// 把「空列表」的检查放在**建剪贴板上下文之前**，所以这次调用根本不会碰系统，
    /// 也就不会污染跑测试那个人的剪贴板。
    #[test]
    fn writing_an_empty_file_list_is_an_error() {
        assert!(
            SystemClipboard.set_files(&[]).is_err(),
            "真实现必须拒绝空文件列表（而且要在碰系统之前就拒）"
        );

        // 假实现的口径要一致（不然它会是个「脾气不一样」的替身）。
        let sink = RecordingSink::default();
        assert!(sink.set_files(&[]).is_err());
        assert!(sink.taken().is_empty(), "失败的那次不该留下记账");
    }
}
