//! 剪贴板事件的形状 —— **这个 crate 对外唯一的产出**。

use std::path::PathBuf;

/// 文本内容的子类型。
///
/// ⚠️ 它**只影响界面上的标签与图标**，不改变上传方式 —— 服务端收到的都还是
/// `POST /text` 的正文（见 `docs/api.md` §11）。别让它渗进接口。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextSubtype {
    Url,
    Email,
    Color,
}

/// 从系统剪贴板**读到**的原始内容 —— 还没去重、还没分类。
///
/// ⚠️★ **优先级：文件 > 图片 > 文本。**
///
/// 为什么必须有优先级：复制一个**文件**时，剪贴板里**同时**能看到文件与文本
/// （文件的路径 / 名字）。三样都读的话，**一次复制**会被当成三次事件发出去 ——
/// 对端收到三条、还得自己判断哪条是真的。
///
/// 这条优先级是 `clip-sync`（行为基准）的做法，`SystemClipboard::read` 与
/// 任何 `ClipboardSource` 实现都要遵守。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardContent {
    /// 一批文件（**绝对路径**，`file://` 前缀已剥掉）。
    Files(Vec<PathBuf>),
    /// 图片 —— 统一转成 **PNG 字节**再往下走（剪贴板里的原始格式各平台不同，
    /// 而且可能是 DIB / TIFF 之类，服务端不认）。
    Image(Vec<u8>),
    /// 文本（原样，不做 trim —— 用户复制的空白就是内容的一部分）。
    Text(String),
}

/// 一次剪贴板变化（**已去重、已分类**）。
///
/// ⚠️ 这是 `clip9-client` 对外的**唯一**产出形状 —— 上游（Tauri 壳 / Android）
/// 只认它。改它等于改接缝，两边都要跟着改（`docs/specs/desktop-client.md` §0.4
/// 「接口先定死再并行」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardEvent {
    /// 文本。`subtype` 只是「看起来像什么」。
    Text {
        content: String,
        subtype: Option<TextSubtype>,
    },
    /// 图片（PNG 字节）。
    ///
    /// ⚠️ **故意不带文件名**：那要时间戳（`clipboard_20260926-134500.png`），
    /// 是**上传**（W2）的事。放进来会让这个 crate 依赖时钟，也就不好测了。
    Image { png: Vec<u8> },
    /// 一批文件（绝对路径）。
    Files { paths: Vec<PathBuf> },
}
