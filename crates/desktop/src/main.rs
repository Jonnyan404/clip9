//! clip9 桌面客户端 —— Tauri 壳。
//!
//! # 职责边界（`docs/specs/desktop-client.md` §2）
//!
//! 这里**只有**「把事件转成 `clip9-client` 的调用」+ 窗口 / 托盘，**没有业务逻辑**。
//! 剪贴板同步的全部逻辑在 `clip9-client` —— 那个 crate **不许出现 `tauri`**，
//! 否则「能独立测」（去重 / 防抖 / 分类 / 重试）这条就废了，只剩手动点界面。
//!
//! # 现状：骨架
//!
//! 窗口（配在 `tauri.conf.json` 里）+ 本地手写界面（`ui/`）已经立起来，
//! 业务逻辑按 `docs/specs/desktop-client.md` §0.1 的切片表逐步接上。
//!
//! ⚠️★ **这里曾经有一版「加载 SPA 的 dist + 注入 `<base>`」的 W0 实验，已经被否决**
//! （2026-09-26，Jonny：「**tauri 负责客户端，spa 复制浏览器的，互不影响**」）。
//! 别再往那个方向试 —— 实测记录（含 `base.js` 那个跨源坑）在规格 §0.1.3。
//!
//! ⚠️ 实验期的 `[w0]` 诊断打印、`document.write('<base>')`、`new Image().src` 探针
//! **全部删掉了**：结论已经落进规格，代码留着只会误导下一个人。
//! （那种「靠 stdout 猜 webview 里发生了什么」的做法本来也不可靠 —— 见 §0.1.3 里
//! 「`document.title` 不能当取证手段」那条。）

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
