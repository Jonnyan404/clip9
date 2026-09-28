//! 把前端产物编进 `clip9-server`（`static/` 那一份）。
//!
//! # 为什么这件事必须发生在**构建期**（而不是运行时 `-static`）
//!
//! 2026-09-28 查出来的洞：桌面端起自带服务端时**没传 `-static`** → `static_dir = None`
//! → 静态兜底整段不挂 → 浏览器打开 `http://127.0.0.1:9502/` 是**一个空白 404**，
//! 而设置页那个「🌐 打开网页版」正是指向它的。
//!
//! 根因不是「少传一个参数」，是**「有没有前端」这件事被留给了运行时**：
//! 参数没给就静默地没有前端，谁都不知道。所以这里改成编进二进制 ——
//! 「这个二进制有没有前端」在**构建期**就定了，而且**缺了会响亮地失败**（见下）。
//! ⚠️ 这正是 Go 那边的形状（`cloud-clip/lib/static` + `-tags embed`，正式构建都带它）。
//!
//! # 顺序：`-static` > 内嵌
//!
//! 运行时**仍然**可以用 `-static` 指一份外部目录把它盖掉（调试前端时要用），
//! 判定在 `crate::static_files` 里，**只有那一处**。
//!
//! # ⚠️ 缺了 `static/index.html` 就 panic —— 这是**故意**的
//!
//! 静默编出一个没有前端的服务端，与上面那个 404 是同一个病：
//! 「界面说了一件事、实际是另一件」，而且**不报错**。编不出来就该编不出来。
//!
//! # 生成的东西
//!
//! `OUT_DIR/embedded_static.rs`：一张 `(相对路径, include_bytes!(绝对路径))` 表。
//! ⚠️ `include_bytes!` 只吃**字面量**路径，所以没法在源码里手写一张「遍历目录」的表 ——
//! 这就是这个 build script 存在的唯一理由。表在 `OUT_DIR` 里、**不入库**，
//! 所以「表和目录不一致」这种漂移**在结构上不可能**。

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dir = manifest.join("static");

    // ⚠️★ 这是这个文件里最要紧的几行：**缺了就失败**，不要降级成「没有前端的服务端」。
    if !dir.join("index.html").is_file() {
        panic!(
            "{} 里没有 index.html —— 前端产物没同步进来，编不出带界面的服务端。\n\
             \n\
             修法：在 clip9 里跑\n\
             \x20   node tools/sync-web-assets.mjs          # 从 ../web-vue3/dist 拷进来\n\
             \n\
             ⚠️ 这个 panic 是**故意**的，别改成「警告 + 继续编译」：\n\
             \x20  那样编出来的二进制能跑、能连、能同步，只是浏览器打开是一片空白 ——\n\
             \x20  而没有任何东西会告诉你少了什么（2026-09-28 之前就是这个状态）。",
            dir.display()
        );
    }

    // ⚠️ 目录的增删改都要触发重编 —— 少这一行的话，改了 `static/` 里的文件
    // 而 build script 不重跑，编出来的还是**上一次**那张表（静默地编出一个旧界面）。
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
