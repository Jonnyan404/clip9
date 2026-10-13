//! 起**子进程**的唯一入口 —— 只为了一件事：Windows 上不弹控制台窗口。
//!
//! # 为什么需要它（2026-10-13 Jonny 报的「打开就弹个黑窗」）
//!
//! 壳自己是 GUI 程序（见 `main.rs` 顶上那行 `windows_subsystem`），所以它**没有控制台**；
//! 而它起的子进程**都是控制台程序**（`clip9-server.exe` 那个 bin 没有那条属性、`cmd.exe`
//! 本来就没有）。Windows 的规矩是：**控制台程序被一个没有控制台的进程拉起时，会自己分配
//! 一个新的控制台窗口** —— 于是「点一下打开浏览器」会闪一下黑窗，而 `clip9-server`
//! 那个是**常驻**的：黑窗会一直挂在任务栏上，看起来像「这软件带了个终端」。
//!
//! ⚠️★ 能拦掉它的只有 `CREATE_NO_WINDOW`，**不能**换成 `DETACHED_PROCESS`：
//! 后者让子进程连标准句柄都没有，而 `clip9-server` 正是靠 stdin 那条管子感知宿主死活
//!（`server_process` 的 `EXIT_WITH_PARENT`）。`CREATE_NO_WINDOW` 只藏窗口，句柄照旧。
//!
//! # 为什么是**一个**函数，而不是每处各写一行
//!
//! 「一个决定只留一处」：漏掉任意一处，症状都是同一个黑窗 —— 而漏掉是**无症状的**，
//! 编译过、测试过，**macOS / Linux 上完全看不出来**（那面旗子只对 Windows 有意义）。
//! 所以规矩定成「别处不许出现 `Command::new`」，由 `tools/desktop-ui-smoke.mjs` 的
//! **判据 44** 逐文件盯着。
//!
//! ⚠️ 于是 mac 上的 `open` / Linux 上的 `xdg-open` 也照样从这儿走：本平台没有那面旗子时，
//! [`hidden`] **就是** `Command::new`（见 [`without_console`] 的 `cfg`）。让漏斗只有一个口，
//! 比「某个平台可以少走一道」容易守住 —— 后者正是「加平台时漏一处」的温床。
//!
//! # 这个文件里没有 `tauri`
//!
//! 与 `store` / `runtime` / `server_process` 同一条：不要窗口、也不要事件。

use std::ffi::OsStr;
use std::process::Command;

/// Windows 的 `CREATE_NO_WINDOW`（`winbase.h`）。
///
/// ⚠️★ 值**必须**是这一个：`0x0800_0000` 是旗子位，写成别的数（比如顺手写成 `0x0800`）
/// 编译得过、什么也不做 —— 判据 44 把这一串字面量一起钉住了。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 起一个子进程（**不会**在 Windows 上弹控制台窗口）。
///
/// ⚠️ 返回的是**裸的** `Command`，参数照旧自己 `.arg(…)` 往上接 —— 这里只管「怎么起」，
/// 不管「起什么」。拼命令字符串那条老规矩也没变：参数**逐个传**
///（见 `commands::open_in_system_browser` 上的注释）。
#[must_use]
pub fn hidden(program: impl AsRef<OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = without_console(command);
    command
}

/// Windows：给它挂上 `CREATE_NO_WINDOW`。
///
/// ⚠️ 单独一个函数是为了让非 Windows 上**整段都不存在** —— 写在 [`hidden`] 里面的话，
/// 那个 `let mut command` 在 mac / Linux 上就成了没人动的 `mut`，而 `clippy -D warnings`
/// 正是在那两个平台上跑的（CI 的 rust 作业）。
#[cfg(windows)]
fn without_console(mut command: Command) -> Command {
    use std::os::windows::process::CommandExt;
    // ⚠️ `creation_flags` 是**整组覆盖**（不是或上去）：默认值是 0，所以这一句就是
    // 「只有这一个旗子」，别的都不带。
    command.creation_flags(CREATE_NO_WINDOW);
    command
}
