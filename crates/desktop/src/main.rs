//! clip9 桌面客户端 —— ⚠️ **这是 W0 的最小实验，不是成品。**
//!
//! 它只验一件事（`docs/specs/desktop-client.md` §3 的 **B 方案**）：
//!
//! > webview 加载**本地 dist**（页面地址仍是 `tauri://localhost`）+ 注入
//! > `<base href="http://127.0.0.1:<port>/">` 之后，**页面能不能真的连上服务端**
//! > —— 只看两件事：`GET /server` 通不通、WebSocket 连不连得上。
//!
//! ⚠️ 它**故意不做**：托盘、命令、开机自启、手写紧凑界面 —— 那些是 W3。
//! **验完就该改写它**，别在实验上叠功能（那会让「实验通过了吗」这件事说不清）。
//!
//! # 怎么跑（两条命令，各开一个终端）
//!
//! ```bash
//! # ① 服务端（它就是 webview 要连的那个）
//! cargo run -p clip9-server -- --port 19551 --data /tmp/clip9-desktop
//! # ② 桌面壳
//! cargo run -p clip9-desktop
//! ```
//!
//! ⚠️ 第一次编译要几分钟（Tauri 2.11 的依赖树是几百个 crate），**别当成卡住了**。
//! ⚠️ 不需要 `tauri` CLI —— 它只服务 `tauri dev` / `tauri build`，而实验只要 `cargo run`。

/// webview 要连的服务端地址。
///
/// ⚠️ 实验阶段写死一个端口。**W3 必须改成运行时才知道的** —— 随包分发时内嵌服务端
/// 由桌面端自己拉起，端口是那时才定的（见 `docs/specs/desktop-client.md` §9.1 第 2 条）。
const SERVER: &str = "http://127.0.0.1:19551";

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // ⚠️ **W0 诊断输出**：实验没有眼睛，只能靠 stdout。
            // 这三条打印在实验收尾时要一起删掉（或者换成正经的 tracing）。
            println!("[w0] setup 进入：开始建窗口");

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                // ⚠️ **加载本地 dist**（`WebviewUrl::App`）—— 这正是 B 与 A 的分界：
                // A 是直接加载服务端地址（`WebviewUrl::External`），那样天然同源、
                // 但会**失去 Tauri IPC**；B 保住 IPC，代价是跨源（要靠 CORS + CSP）。
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("clip9（W0 实验）")
            .inner_size(1080.0, 720.0)
            // ⚠️★ **这一句就是整个 B 方案的赌注。**
            //
            // SPA 的 `base.js` 从 `document.baseURI` 推 `APP_BASE`，而 router / axios 的
            // `baseURL` / WebSocket 地址**三者全用它**。页面的真实地址是 `tauri://localhost`，
            // 所以必须在**页面任何脚本跑之前**把 `<base>` 指到服务端 ——
            // 否则那些相对路径的请求会全打到 `tauri://localhost` ✗。
            //
            // ⚠️ 用 `initialization_script`（它在页面脚本之前执行）而**不是**去改 dist 里的
            // `index.html`：那份产物是**共享的**（Go / Rust / Worker 都消费同一份），
            // 改它等于同时改三方 —— 那正是 `CONTRIBUTING.md` §6 点名的反模式。
            .initialization_script(format!("document.write('<base href=\"{SERVER}/\">');"))
            // ⚠️ **W0 诊断**：页面到底有没有导航过来。
            .on_page_load(|_window, payload| {
                println!("[w0] page_load: {:?} {}", payload.event(), payload.url());
            })
            .build()?;

            println!(
                "[w0] 窗口已建: visible={:?} pos={:?} size={:?}",
                window.is_visible(),
                window.outer_position(),
                window.outer_size()
            );

            // ⚠️ **W0 诊断**：建完 8 秒后再看一次，判断窗口是「没建」还是「建了没显示」。
            let probe = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                println!(
                    "[w0] 8 秒后: visible={:?} pos={:?} size={:?} url={:?} title={:?}",
                    probe.is_visible(),
                    probe.outer_position(),
                    probe.outer_size(),
                    probe.url().map(|u| u.to_string()),
                    probe.title()
                );
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
