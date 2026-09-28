//! 下行落盘用的纯函数：文件名清洗 + 重名避让。
//!
//! ⚠️ 抽成独立模块是为了**能独立测**：这两个函数处理的是**来自网络**的字符串，
//! 而它们错了的后果是**写到磁盘上别的地方**（路径穿越）或者**覆盖用户的文件**。
//! 拿真实文件系统测这两件事很别扭（要造目录、要造权限、还要清理），
//! 而它们本身是纯函数 —— 那就不该让它们依赖文件系统。

use std::path::{Path, PathBuf};

/// 清洗一个**来自网络**的文件名。
///
/// 规则（照行为基准 `clip-sync` 的 `sanitize_file_name`，再加一条）：
///
/// 1. 剔掉控制字符（它们会污染日志，也可能在终端里渲染出意料之外的东西）；
/// 2. **只取最后一段路径** —— 这就是防路径穿越的那一步：
///    `../../etc/passwd` 只能留下 `passwd`；
/// 3. 去掉首尾空白。
///
/// ⚠️ 第 2 步里我**先把 `\` 也当成分隔符**：行为基准只用 `Path::file_name()`，
/// 而在 Unix 上 `\` 不是分隔符，于是 `..\..\x` 会被整段当成文件名留下。
/// 那个字符串在 Unix 上确实不构成穿越（它是文件名的一部分），但它会**变成一个文件名**，
/// 而对方（Windows 客户端）本意是路径 —— 与其留着这种「两端理解不一致」的东西，
/// 不如统一按两种分隔符都切开。
#[must_use]
pub fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| {
            let cp = *c as u32;
            // 与 `rust/crates/server` 的 `sanitize_device_name` 同一个口径：
            // 只剔 C0 与 DEL（不用 `char::is_control()`，那会连 C1 一起剔，
            // 和 Go 那边的输出就不一样了）。
            cp >= 0x20 && cp != 0x7f
        })
        .collect();

    // 两种分隔符都切开，再取最后一段。
    cleaned
        .split(['/', '\\'])
        .next_back()
        .unwrap_or("")
        .trim()
        .to_owned()
}

/// 给一个名字在 `dir` 里找一个**不冲突**的路径：重名就追加 ` (1)`、` (2)`……
///
/// `exists` 由调用方给（通常是 `|p| p.exists()`）——
/// 这样测试不用碰真文件系统，就能把「避让」这条规则钉住。
///
/// ⚠️ 为什么必须避让：**覆盖用户已有的同名文件**是不可接受的。
/// 用户下载两次 `报告.pdf`，第二次把第一次覆盖掉 —— 而两次的内容可能不一样
/// （对端改了再发的）。宁可多一个 `报告 (1).pdf`。
#[must_use]
pub fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let candidate = dir.join(name);
    if !exists(&candidate) {
        return candidate;
    }

    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|s| s.to_str());

    let mut counter = 1u32;
    loop {
        let numbered = match ext {
            Some(ext) => format!("{stem} ({counter}).{ext}"),
            None => format!("{stem} ({counter})"),
        };
        let candidate = dir.join(numbered);
        if !exists(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

/// 收到一条文件条目时，本地该用哪个名字。
///
/// 顺序：条目里的 `name` → 下载地址的最后一段 → `downloaded_file`。
/// 每一步都过 [`sanitize_file_name`]，所以最后一定是个单段、非空的名字。
#[must_use]
pub fn local_file_name(entry_name: &str, url: &str) -> String {
    let from_entry = sanitize_file_name(entry_name);
    if !from_entry.is_empty() {
        return from_entry;
    }
    let from_url = sanitize_file_name(url.rsplit('/').next().unwrap_or(""));
    if !from_url.is_empty() {
        return from_url;
    }
    "downloaded_file".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// ⚠️★ **路径穿越**：来自网络的名字里带路径分量，只能留下最后一段。
    #[test]
    fn strips_every_path_component() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("/etc/shadow"), "shadow");
        assert_eq!(sanitize_file_name("a/b/c.txt"), "c.txt");
        // Windows 风格的分隔符也切开（见函数文档里那条理由）。
        assert_eq!(
            sanitize_file_name(r"..\..\windows\system32\evil.dll"),
            "evil.dll"
        );
        assert_eq!(sanitize_file_name(r"C:\Users\x\Desktop\a.png"), "a.png");
    }

    /// 控制字符剔掉，首尾空白去掉；全空白 = 空名字（调用方据此走回退链）。
    #[test]
    fn strips_control_chars_and_trimspace() {
        assert_eq!(sanitize_file_name("a\u{0}b\u{7f}c.txt"), "abc.txt");
        assert_eq!(sanitize_file_name("  报告 .pdf "), "报告 .pdf");
        assert_eq!(sanitize_file_name("   "), "");
        assert_eq!(sanitize_file_name(""), "");
        assert_eq!(sanitize_file_name("/"), "");
    }

    /// 正常名字原样留下（包括空格与中文 —— 别顺手把它们改成下划线）。
    #[test]
    fn keeps_ordinary_names_intact() {
        assert_eq!(sanitize_file_name("我的 报告 v2.pdf"), "我的 报告 v2.pdf");
        assert_eq!(sanitize_file_name("photo-1.PNG"), "photo-1.PNG");
    }

    /// ⚠️★ **重名要避让，不许覆盖用户的文件。**
    #[test]
    fn never_overwrites_an_existing_file() {
        let dir = Path::new("/dl");
        // 什么都没有 → 用原名。
        assert_eq!(
            unique_path(dir, "a.txt", |_| false),
            PathBuf::from("/dl/a.txt")
        );

        // 原名被占了 → 加 (1)。
        let taken: HashSet<PathBuf> = [PathBuf::from("/dl/a.txt")].into_iter().collect();
        assert_eq!(
            unique_path(dir, "a.txt", |p| taken.contains(p)),
            PathBuf::from("/dl/a (1).txt")
        );

        // (1) 也被占了 → (2)。
        let taken: HashSet<PathBuf> = [
            PathBuf::from("/dl/a.txt"),
            PathBuf::from("/dl/a (1).txt"),
            PathBuf::from("/dl/a (2).txt"),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            unique_path(dir, "a.txt", |p| taken.contains(p)),
            PathBuf::from("/dl/a (3).txt")
        );
    }

    /// 没有扩展名时，序号直接缀在后面（`note` → `note (1)`）。
    #[test]
    fn numbers_names_without_an_extension() {
        let taken: HashSet<PathBuf> = [PathBuf::from("/dl/note")].into_iter().collect();
        assert_eq!(
            unique_path(Path::new("/dl"), "note", |p| taken.contains(p)),
            PathBuf::from("/dl/note (1)")
        );
    }

    /// ⚠️ 点开头的名字（`.gitignore`）**扩展名是空的** —— 别把它变成 `.gitignore (1).`。
    #[test]
    fn dotfiles_do_not_get_a_trailing_dot() {
        let taken: HashSet<PathBuf> = [PathBuf::from("/dl/.env")].into_iter().collect();
        let got = unique_path(Path::new("/dl"), ".env", |p| taken.contains(p));
        assert_eq!(got, PathBuf::from("/dl/.env (1)"));
        assert!(!got.to_string_lossy().ends_with('.'));
    }

    /// 名字的回退链：条目名 → 地址末段 → `downloaded_file`。
    #[test]
    fn falls_back_from_entry_name_to_url_to_a_default() {
        assert_eq!(
            local_file_name("报告.pdf", "http://h/file/u/报告.pdf"),
            "报告.pdf"
        );
        // 条目名是空的 / 只有路径分量 → 用地址末段。
        assert_eq!(local_file_name("", "http://h/file/u/x.png"), "x.png");
        assert_eq!(local_file_name("   ", "http://h/file/u/x.png"), "x.png");
        // 两个都没有 → 兜底名字（**不是空串**，空文件名写不出去）。
        assert_eq!(local_file_name("", "http://h/file/u/"), "downloaded_file");
        assert_eq!(local_file_name("", ""), "downloaded_file");
    }
}
