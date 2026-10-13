//! 把前端产物编进 `clip9-server`（`static/` 那一份）。
//!
//! 为什么必须在**构建期**：以前「有没有前端」由运行时决定（给没给 `-static`），
//! 于是桌面端那份自带服务端**静默地**没有前端 —— 浏览器打开是一片空白 404
//! （2026-09-28 查出的洞）。编进二进制之后它在构建期就定了。
//! 运行时的 `-static` 仍可覆盖，判定只在 `crate::static_files`。
//!
//! ⚠️★ **2026-10-13：`static/` 不再入库**（`.gitignore` 里有那两条），前端由**构建时现生成**：
//! 线上 CI 先 `npm run build` + 同步再把产物传给编译作业，本机**不再需要**跑 `npm run build`。
//!
//! 于是「缺产物」从一个异常变成了**本机的常态**，这里跟着改了两件事：
//!
//!   · **不再 panic**。旧做法的代价是「一棵刚 clone 的树跑不了 `cargo build -p clip9-server`、
//!     也跑不了 `cargo test --workspace`」—— 而本地开发根本不需要内嵌界面
//!     （`npm run dev` 由 vite 供页面）。
//!   · **也不降级成「什么都不内嵌」**。那样根路径会回到上面那个**空白 404**。
//!     缺产物时内嵌的是 [`PLACEHOLDER_HTML`] 那个**会自己解释**的占位页 ——
//!     打开就能看见「这个二进制没带界面、怎么修」。
//!
//! ⚠️★ 代价必须由**发货路径**补回来，不能靠自觉：`release.yml` / `openwrt.yml` 在打包前
//! 会 `strings` 一次二进制，**发现 [`PLACEHOLDER_MARKER`] 就当场失败**。
//! 也就是说「编出一个没界面的二进制」在本机是**允许**的，在发布链上是**不可能**的。
//!
//! 产物是 `OUT_DIR/embedded_static.rs`：一张 `(相对路径, include_bytes!(绝对路径))` 表。
//! `include_bytes!` **只吃字面量路径**，这就是这个 build script 存在的唯一理由。

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// 占位页里的标记 —— 发货路径靠它反向拦截（见文件头最后一段）。
///
/// ⚠️ 改这个字符串要同步改 `release.yml` / `openwrt/scripts/build.sh` 里那道 `strings` 自检，
/// 否则那道闸会**永远绿**（它 grep 的是一个再也不出现的名字）。
const PLACEHOLDER_MARKER: &str = "clip9-no-embedded-frontend";

/// 缺前端产物时内嵌的页面。
///
/// ⚠️ 刻意**不含** `data-build-id`：那个属性是「桌面端认亲」用的，占位页不是一版前端，
/// 不该被当成某一版认下来（认不出 → 桌面端起自己的服务端，那才是对的行为）。
fn placeholder_html() -> String {
    format!(
        "<!doctype html>\n\
         <html lang=\"zh\">\n\
         <head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n\
         <title>clip9 · 没有内嵌前端</title></head>\n\
         <body style=\"font:14px/1.7 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem\">\n\
         <h1 style=\"font-size:1.25rem\">这个二进制里没有内嵌前端</h1>\n\
         <p>它是在一棵**没有前端产物**的树上编出来的。本地开发时这是正常的 —— 界面由\n\
         <code>npm run dev</code>（vite）提供，服务端只当接口用。</p>\n\
         <p>要一份**带界面**的二进制，先构建前端再编服务端：</p>\n\
         <pre style=\"background:#f4f7fb;padding:.75rem 1rem;border-radius:8px\">cd web &amp;&amp; npm run build\n\
         node tools/sync-web-assets.mjs\n\
         cd rust &amp;&amp; cargo build -p clip9-server</pre>\n\
         <p>或者启动时用 <code>-static &lt;目录&gt;</code> 指向一份现成的产物。</p>\n\
         <p style=\"color:#888;font-size:12px\">{PLACEHOLDER_MARKER}</p>\n\
         </body></html>\n"
    )
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dir = manifest.join("static");

    // ⚠️ 少了这一行，改了 `static/` 而 build script 不重跑 = 静默编出**上一次**那张表（旧界面）。
    println!("cargo:rerun-if-changed=static");
    // ⚠️★ `CLIP9_VERSION` 变了要**重编**：它是 `option_env!` 读的，而 cargo 默认
    // **不会**因为环境变量变化而重编（只认「源码/依赖有没有变」）。
    // 不加这一行的话：本地先用 `CLIP9_VERSION=9.9.9-test` 编过一次，再不带变量编一次，
    // 拿到的**还是 9.9.9**（我自己就撞上了）；CI 上 `rust-cache` 命中时同理 ——
    // **换了 tag 也可能沿用上一次注入的版本**。
    // ⚠️ `release.yml` 与 `openwrt/scripts/build.sh` 里那道 `strings | grep` 自检能发现它，
    // 但那是事后；这一行才是「别让它发生」。
    println!("cargo:rerun-if-env-changed=CLIP9_VERSION");

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    walk(&dir, &dir, &mut files);

    // ⚠️★ 没有前端产物 → 内嵌占位页（见文件头）。**不是** panic，也**不是**跳过不内嵌。
    if !dir.join("index.html").is_file() {
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
        let placeholder = out_dir.join("no-embedded-frontend/index.html");
        std::fs::create_dir_all(placeholder.parent().expect("占位页的父目录")).expect("建目录");
        std::fs::write(&placeholder, placeholder_html()).expect("写占位页");
        files = vec![("index.html".to_owned(), placeholder)];
        println!(
            "cargo:warning=没有前端产物（{}），内嵌的是占位页 —— 本地开发这样没问题（界面由 `npm run dev` 提供）；\
             要一份带界面的二进制：cd web && npm run build && node tools/sync-web-assets.mjs",
            dir.display()
        );
    }

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
