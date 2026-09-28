//! 把前端产物编进 `clip9-server`（`static/` 那一份）。
//!
//! 为什么必须在**构建期**：以前「有没有前端」由运行时决定（给没给 `-static`），
//! 于是桌面端那份自带服务端**静默地**没有前端 —— 浏览器打开是一片空白 404
//! （2026-09-28 查出的洞）。编进二进制之后它在构建期就定了，而且**缺了会响亮地失败**。
//! 运行时的 `-static` 仍可覆盖，判定只在 `crate::static_files`。
//!
//! `static/index.html` 不在就 **panic** —— 故意的。静默编出一个没有前端的服务端，
//! 和上面那个 404 是同一个病。
//!
//! 产物是 `OUT_DIR/embedded_static.rs`：一张 `(相对路径, include_bytes!(绝对路径))` 表。
//! `include_bytes!` **只吃字面量路径**，这就是这个 build script 存在的唯一理由。

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dir = manifest.join("static");

    // ⚠️★ 最要紧的几行：**缺了就失败**，别降级成「没有前端的服务端」。
    if !dir.join("index.html").is_file() {
        panic!(
            "{} 里没有 index.html —— 前端产物没同步进来，编不出带界面的服务端。\n\
             修法：在仓库根跑 node tools/sync-web-assets.mjs（它从 web-vue3/dist 拷过来）。\n\
             ⚠️ 别改成「警告 + 继续编译」：那样编出来的二进制能跑、能连、能同步，\n\
             只是浏览器打开一片空白，而没有任何东西会告诉你少了什么。",
            dir.display()
        );
    }

    // ⚠️ 少了这一行，改了 `static/` 而 build script 不重跑 = 静默编出**上一次**那张表（旧界面）。
    println!("cargo:rerun-if-changed=static");

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    walk(&dir, &dir, &mut files);
    // 按**相对路径**排：表的顺序稳定，生成的文件就不会因为目录枚举顺序而抖动。
    files.sort();

    let mut out = String::new();
    out.push_str("// 由 build.rs 生成（见那个文件的文档）—— 在 OUT_DIR 里，别手改。\n");
    out.push_str(
        "/// 内嵌的前端产物：`(相对路径, 字节)`。路径是相对 `static/` 的，且用 `/` 分隔。\n",
    );
    out.push_str("pub static EMBEDDED: &[(&str, &[u8])] = &[\n");
    for (rel, path) in &files {
        // ⚠️ 用 `{:?}` 而不是 `\"{…}\"`：Windows 的绝对路径带反斜杠，
        // 手写引号会生成一段**语法就错**的 Rust（或者更坏：安静地指向别的地方）。
        writeln!(
            out,
            "    ({rel:?}, include_bytes!({:?})),",
            path.to_string_lossy()
        )
        .expect("写生成文件");
    }
    out.push_str("];\n");

    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("embedded_static.rs");
    std::fs::write(&dest, out).expect("写生成文件");
}

/// 递归收集 `dir` 下的所有普通文件。
///
/// ⚠️ 跳过 `.DS_Store`：那是 macOS 的资源分支文件，编进二进制只会让
/// 「表里有 && 目录里没有」的对比变得吵。
fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == ".DS_Store" {
            continue;
        }
        if path.is_dir() {
            walk(&path, root, out);
        } else if path.is_file() {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                // ⚠️ 统一成 `/`：`include_dir` 那类工具与 Web 都用斜杠，
                // 而 Windows 的 `PathBuf` 给的是反斜杠 —— 不归一的话
                // 同一个产物在两个平台上会长成两张不同的表。
                .replace('\\', "/");
            out.push((rel, path));
        }
    }
}
