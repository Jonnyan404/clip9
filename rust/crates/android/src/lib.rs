//! clip9 Android 外壳的 JNI 桥。
//!
//! 把 [`clip9_server`] 的 lib 暴露给 Kotlin：Kotlin 侧的 `ServerService`（前台服务）
//! 加载这个 `.so`，由它持有 tokio 运行时与 `axum` 服务。
//!
//! # 为什么是一个独立 crate，而不是给 `crates/server` 加 `crate-type`
//!
//! 依赖方向是 `protocol ← core ← store ← server ← {desktop, bin, android}`
//! （`docs/ARCHITECTURE.md` §4）—— Android 在**末端**，与桌面端平级。
//! 把 `Java_…` 那些符号挂到 `server` 上，等于让服务端 crate 认识 JNI，
//! 而桌面端/独立二进制都不需要它。
//!
//! # 为什么它也能在桌面上编（`jni` 不 gate 掉）
//!
//! `cdylib` 在宿主（macOS）上也会被 `cargo build --workspace` 编一次，
//! 产物是一个没人用的 `.dylib`。这看着像浪费，但换来的是：
//! **这个 crate 的代码在宿主的 `cargo clippy` / `cargo test` 里也是被检查的**。
//! 反过来（用 `#[cfg(target_os = "android")]` 把整个 crate 掏空）会让它
//! **只在交叉编译时才第一次被编译** —— 而那正是最难调、反馈最慢的那条路。
//!
//! # 与 Kotlin 的契约
//!
//! ⚠️★ 符号名、`loadLibrary` 的名字、ABI 目录三者**必须一致**，不一致的症状是
//! `UnsatisfiedLinkError` —— 而它**不会告诉你**是哪一处不对：
//!
//! | 这件事 | 值 |
//! |---|---|
//! | `.so` 文件名 | `libclip9_android.so`（= 本 crate 的 `[lib] name`） |
//! | Kotlin 侧 | `System.loadLibrary("clip9_android")` |
//! | 放进 | `app/src/main/jniLibs/<abi>/` |
//! | Kotlin 类 | `com.clip9.app.ServerBridge`（下面每个符号里都写死了） |
//!
//! ⚠️ **路径也在这里写死了**（`com.clip9.app.ServerBridge`）—— 改包名/类名要一起改这里，
//! 否则 Kotlin 那边是 `UnsatisfiedLinkError`。设计见 `docs/specs/android-client.md` §5。
//!
//! # 线程
//!
//! ⚠️★ Kotlin 侧**不要在 UI 线程调** `nativeStart` / `nativeStop`：两者都是阻塞的
//! （前者要等「起来了还是失败了」，后者要等 redb 事务收尾）。用协程 / 后台线程。
//!
//! # 现在到哪一步了
//!
//! 启停 API 已实现，但**还没有 Kotlin 那半边**，也**没在真机上跑过**
//! （见 `docs/specs/android-client.md` §0.2 的切片表）。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use clip9_server::{config_file, paths, serve};
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jint, jstring};
use tokio::runtime::Runtime;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// 起完之后等「它会不会立刻挂掉」多久。
///
/// ⚠️ 它不是「等它起来」的时间 —— 起来是**绑端口**，本地 syscall，毫秒级。
/// 它只是给「绑失败了、任务当场结束」这件事一个观察窗口。
/// 所以它短一点没坏处：`select!` 里**先发生哪个就返回哪个**，
/// 端口被占用时是**立刻**返回的，不用等满这个值。
const STARTUP_PROBE: Duration = Duration::from_millis(800);

/// 停止时等 serve 收尾的上界。
///
/// ⚠️ 要比 `serve::SHUTDOWN_GRACE` **大**：那个是「等正在处理的请求收尾」，
/// 这个是「连收尾都算上」。取一样大就会在临界点上误报超时。
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// 服务端状态。数值是**与 Kotlin 的契约**（见 `docs/specs/android-client.md` §5.2）。
///
/// ⚠️ `STARTING` 取 3 而不是插在中间 —— 0/1/2 是先前就写进设计稿的值，
/// 新值一律往后加，免得「文档里的数字」和「代码里的数字」对不上。
const STATUS_IDLE: jint = 0;
const STATUS_RUNNING: jint = 1;
const STATUS_STOPPING: jint = 2;
const STATUS_STARTING: jint = 3;

/// 正在跑的服务端。
struct Running {
    /// ⚠️ 必须**持有**它：`axum` / tokio 的任务要靠 runtime 活着，
    /// runtime 一 drop，任务全没。这也是为什么它和 `join` 放在一起。
    runtime: Runtime,
    /// 发 `true` = 停。
    stop: watch::Sender<bool>,
    join: JoinHandle<anyhow::Result<()>>,
}

/// 当前状态。
///
/// ⚠️★ 四个态**缺一不可**，尤其是 `Starting` / `Stopping` 这两个「过渡态」：
/// 拿「`Running` 那一格是不是 `None`」去表示它们，就是把**三件不同的事**
/// （没在跑 / 正在起 / 正在停）挤进一个格子里。那样两种谎话都会出现：
/// 停止期间界面显示「没在跑」→ 用户再点「启动」→ 得到一句「端口被占用」；
/// 启动期间界面显示「没在跑」→ 用户再点一下，于是两个线程同时建库、同时绑端口。
enum State {
    /// 没在跑。
    Idle,
    /// 有人在起（还没出结果）。`Running` 还不存在，所以**没法**在这里停它。
    Starting,
    /// 在跑。谁把 `Running` 取走，谁负责把它停完。
    Running(Running),
    /// 有人在停（`Running` 已经被那个线程取走了）。
    Stopping,
}

/// 全局状态。
///
/// ⚠️ 用 `std::sync::Mutex` 而不是 `parking_lot`：这里没有性能诉求，
/// 而 `Mutex::new` 是 `const fn`（`parking_lot` 不是），能直接当 `static` 的初值。
struct Bridge {
    state: State,
    /// 最近一次失败的原话。`nativeLastError` 读它。
    ///
    /// ⚠️ 存**原文**而不是布尔：Kotlin 那边要把这句话显示给用户，
    /// 而「启动失败」四个字对排查毫无用处（端口占用、配置解析失败、库打不开是三种不同的事）。
    last_error: Option<String>,
}

static BRIDGE: Mutex<Bridge> = Mutex::new(Bridge {
    state: State::Idle,
    last_error: None,
});

/// 拿锁，**中毒也照用**。
///
/// ⚠️ `unwrap()` 在锁中毒时会 panic —— 而中毒意味着「上一次调用 panic 了」。
/// 对一个 `extern "system"` 的函数来说，panic **跨 FFI 边界是未定义行为**，
/// 比带着一个可能不完整的状态继续跑危险得多。所以这里取回内部值继续。
fn bridge() -> MutexGuard<'static, Bridge> {
    BRIDGE.lock().unwrap_or_else(|e| e.into_inner())
}

/// 把 Java 字符串转成 Rust 的（`null` 会被 JNI 层判成空串，所以不用 `Option`）。
fn java_string(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value).map(|s| s.into()).unwrap_or_default()
}

/// 把一个可能为 `None` 的字符串交给 Java（`None` → `null`）。
fn java_string_or_null(env: &mut JNIEnv, value: Option<&str>) -> jstring {
    match value {
        Some(text) => env
            .new_string(text)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        None => std::ptr::null_mut(),
    }
}

/// 返回这个 `.so` 的版本号（= `clip9-android` 这个 crate 的版本）。
///
/// ⚠️ 它存在的意义是**证明整条链通了**：Kotlin 能加载 `.so`、能查到符号、能拿到字符串。
/// 拿不到就说明 `System.loadLibrary` 的名字、ABI 目录、或符号名有一处对不上 ——
/// 而那种症状（`UnsatisfiedLinkError`）**不会告诉你**是哪一处。
///
/// ⚠️★ `#[allow(non_snake_case)]` **不是可选项**：JNI 的符号名是规范规定的
/// `Java_<包名下划线化>_<类名>_<方法名>`，而包名/类名按 Java 惯例是 camel 风格 ——
/// 于是这个名字**必然**不满足 Rust 的 snake_case。少了这行，`-D warnings` 直接红。
/// ⚠️ 而 `#[unsafe(no_mangle)]` 是 edition 2024 的要求（`no_mangle` 是 unsafe attribute）。
#[allow(non_snake_case)]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_clip9_app_ServerBridge_nativeVersion(
    env: JNIEnv,
    _class: JClass,
) -> jstring {
    env.new_string(env!("CARGO_PKG_VERSION"))
        .expect("建 Java 字符串不该失败")
        .into_raw()
}

/// 起服务端。**阻塞**（最多 [`STARTUP_PROBE`]），别在 UI 线程调。
///
/// 返回 `null` = 成功；非 null = **一句话原文**，应当原样显示给用户
/// （失败时是错误原文，也可能是「正在启动 / 正在停止，请稍候」）。
///
/// ⚠️★ **幂等**：已经在跑的时候再调一次**直接返回 `null`**，不会有第二个服务端。
/// Android 的前台服务可能被系统重启，同一个进程里调两次是常态 ——
/// 不做幂等的话第二次会在 `bind` 上失败，而症状是「有时候起得来有时候起不来」。
///
/// ⚠️ 但「正在**起**」和「正在**停**」不算幂等命中：那两种时候服务并不是「已经在跑」，
/// 回 `null` 就是在撒谎。分别回一句「请稍候」和一个明确的错误，让调用方去看
/// [`Java_com_clip9_app_ServerBridge_nativeStatus`]。
///
/// ⚠️★ **绝不静默换端口**（`docs/ARCHITECTURE.md` §4.1 第 1 条）：
/// 端口被占用就如实报错。换一个端口的后果是「用户填进别的设备的地址永远连不上」，
/// 而两边都不报错（这边起来了、对端说超时）。
#[allow(non_snake_case)]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_clip9_app_ServerBridge_nativeStart(
    mut env: JNIEnv,
    _class: JClass,
    config_path: JString,
    data_dir: JString,
    host: JString,
    port: jint,
) -> jstring {
    let config_path = java_string(&mut env, &config_path);
    let data_dir = java_string(&mut env, &data_dir);
    let host = java_string(&mut env, &host);

    let error = start(&config_path, &data_dir, &host, port);
    java_string_or_null(&mut env, error.as_deref())
}

/// 停服务端。**阻塞**（等 redb 事务收尾），别在 UI 线程调。
///
/// 返回 `null` = 成功；非 null = 错误原文。
///
/// ⚠️ 没在跑的时候调它**也算成功**（幂等）—— 用户连点两次「停止」是常事。
#[allow(non_snake_case)]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_clip9_app_ServerBridge_nativeStop(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let error = stop();
    java_string_or_null(&mut env, error.as_deref())
}

/// 现在是什么状态（0=没起 / 1=在跑 / 2=正在停 / 3=正在起）。
///
/// ⚠️ 「正在停」这个值不是装饰：停止可能要等好几秒（见 [`STOP_TIMEOUT`]），
/// 界面要能显示「正在停止…」而不是把按钮变成可点的「启动」。
/// 「正在起」同理 —— 起的过程里 `Running` 还不存在，界面这时候也必须**禁用**按钮。
///
/// ⚠️ 它**只取锁不做事**，所以可以随时调（包括 UI 线程）。
/// 这是刻意的：`nativeStart` / `nativeStop` 会阻塞好几秒，这个不会。
#[allow(non_snake_case)]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_clip9_app_ServerBridge_nativeStatus(
    _env: JNIEnv,
    _class: JClass,
) -> jint {
    status()
}

/// [`Java_com_clip9_app_ServerBridge_nativeStatus`] 的实现。
fn status() -> jint {
    let guard = bridge();
    match guard.state {
        State::Idle => STATUS_IDLE,
        State::Running(_) => STATUS_RUNNING,
        State::Stopping => STATUS_STOPPING,
        State::Starting => STATUS_STARTING,
    }
}

/// 最近一次失败的原话（没有就返回 `null`）。
#[allow(non_snake_case)]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_clip9_app_ServerBridge_nativeLastError(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let text = bridge().last_error.clone();
    java_string_or_null(&mut env, text.as_deref())
}

/// `start` 走到岔路口时该选哪一条。
///
/// ⚠️★ 抽出来是为了**能被穷举**：这些分支只在两个线程同时调 `start`/`stop` 时才走到，
/// 而那种竞态**没法用真起服务端的用例稳定复现**。做成纯函数之后，
/// 「四个入状态 → 哪条出路 + 落成什么状态」可以一条一条钉（见 `mod tests`）。
#[derive(Debug, PartialEq, Eq)]
enum StartAction {
    /// 去起。**此时状态已经占成 `Starting`**（别人再进来会看到 `BusyStarting`）。
    Launch,
    /// 已经在跑 → 直接算成功（幂等）。
    AlreadyRunning,
    /// 正在停 → **不能说成功**：服务正在往下走，说了「起来了」才是撒谎。
    BusyStopping,
    /// 另一个线程正在起 → 既不能说成功（它还没成）也不能说失败（它未必败）。
    BusyStarting,
}

/// **纯函数**：按当前状态决定 `start` 该干什么，并把状态推进到该在的样子。
///
/// ⚠️ `Idle` 那一支要**占成 `Starting`**，否则两个线程会同时建库、同时绑端口
/// （后一个会拿到「端口被占用」，而先起来的那个反而被用户当成失败了）。
fn begin_start(state: &mut State) -> StartAction {
    match state {
        State::Idle => {
            *state = State::Starting;
            StartAction::Launch
        }
        State::Running(_) => StartAction::AlreadyRunning,
        State::Stopping => StartAction::BusyStopping,
        State::Starting => StartAction::BusyStarting,
    }
}

/// `stop` 走到岔路口时该选哪一条。
enum StopAction {
    /// 去停，`Running` 交出来给调用方（状态已经标成 `Stopping`）。
    Stop(Running),
    /// 没得停 / 已经有线程在停 —— 两种**都算成功**（用户连点两次「停止」是常事）。
    Nothing,
    /// 正在起 → 停不了，如实说。
    BusyStarting,
}

/// **纯函数**：按当前状态决定 `stop` 该干什么，并把状态推进到该在的样子。
///
/// ⚠️★ 这里有个踩过的坑，就写在 `Idle` 那一支：**占位是 `Stopping`，
/// 而 `Idle` 必须显式写回 `Idle`**。第一版忘了写回，于是
/// 「在**没跑**的时候点一次停止」会把状态**永久钉在 `Stopping`** ——
/// 之后每一次 `start` 都得到「服务端正在停止，请等它停完再启动」，
/// 而它**根本没有东西在停**（`mod tests` 的决策表第一次跑就红了三条）。
fn begin_stop(state: &mut State) -> StopAction {
    match std::mem::replace(state, State::Stopping) {
        // 占位正好就是它该在的样子。
        State::Running(running) => StopAction::Stop(running),
        // ⚠️★ 已经在停了（另一个线程攥着 `Running` 在收尾）→ 也算成功，
        // 状态**留在 `Stopping`**：那个线程还没收完，界面必须继续显示「正在停」，
        // 否则用户会去点「启动」、然后得到一句「端口被占用」。
        State::Stopping => StopAction::Nothing,
        // ⚠️★ 写回 `Idle` —— 见上面的坑。
        State::Idle => {
            *state = State::Idle;
            StopAction::Nothing
        }
        // ⚠️★ 正在起的时候来停：这里既没有 `Running` 可停，也不能放任那个正在
        // `build_and_launch` 的线程（它等下会把状态覆盖成 `Running`，
        // 那就成了一个**没人能停**的服务端）。如实说清楚，让调用方等它起完。
        State::Starting => {
            *state = State::Starting;
            StopAction::BusyStarting
        }
    }
}

/// [`Java_com_clip9_app_ServerBridge_nativeStart`] 的实现（与 JNI 那一层分开，好读）。
fn start(config_path: &str, data_dir: &str, host: &str, port: i32) -> Option<String> {
    // ① 先**占住位置**（`Idle` → `Starting`），再在锁外做那些慢事。
    //
    // ⚠️★ 建库 / 绑端口要动文件系统、最多几百毫秒，那段时间**不能**一直攥着锁：
    // 界面会调 `nativeStatus`，被堵住的后果是 UI 卡一下（而这个锁本来只需要保护
    // 「谁在跑」这一个事实）。所以用一个显式的 `Starting` 态去表达「有人在起」。
    {
        let mut guard = bridge();
        match begin_start(&mut guard.state) {
            StartAction::Launch => {}
            // 幂等：已经在跑 → 直接算成功，不重建。
            StartAction::AlreadyRunning => return None,
            // ⚠️ 正在停的时候**不能说成功** —— 那是在撒谎（服务正在往下走）。
            // 撒谎的代价：界面立刻把按钮变回「启动」，用户再点一下才真的失败。
            StartAction::BusyStopping => {
                let message = "服务端正在停止，请等它停完再启动".to_owned();
                guard.last_error = Some(message.clone());
                return Some(message);
            }
            // 另一个线程正在起。⚠️ 回一句**怎么等**的话，状态查询会给出
            // `STARTING` / `RUNNING`。
            // ⚠️ 不写 `last_error` —— 这不是失败，写进去会让 `nativeLastError` 变成噪音。
            StartAction::BusyStarting => return Some("服务端正在启动，请稍候".to_owned()),
        }
    }

    match build_and_launch(config_path, data_dir, host, port) {
        Ok(running) => {
            let mut guard = bridge();
            guard.state = State::Running(running);
            guard.last_error = None;
            None
        }
        Err(message) => {
            let mut guard = bridge();
            // ⚠️★ 失败必须**放回 `Idle`**。漏了这一步的后果是所有后续 `nativeStart`
            // 都走 `State::Starting` 那一支、永远回一句「请稍候」——
            // 症状是「第一次起失败之后就再也起不来了」，而且**没有任何错误信息**。
            guard.state = State::Idle;
            guard.last_error = Some(message.clone());
            Some(message)
        }
    }
}

/// 把配置读出来、库打开、服务起上，并确认它**没有立刻挂掉**。
fn build_and_launch(
    config_path: &str,
    data_dir: &str,
    host: &str,
    port: i32,
) -> Result<Running, String> {
    let port = u16::try_from(port).map_err(|_| format!("端口 {port} 不在 0..=65535 之内"))?;

    let mut config =
        config_file::load_or_create(Path::new(config_path)).map_err(|e| e.to_string())?;
    // ⚠️ 界面传进来的监听设置**盖过**配置文件 —— 用户刚在界面上改的就是它。
    config.server.host = serde_json::Value::String(host.to_owned());
    config.server.port = port;

    // ⚠️ 路径由外壳算（`docs/ARCHITECTURE.md` §4.2）：Android 上就是应用私有目录。
    // ⚠️★ 「建目录 → 解析路径 → 开库」走**服务端那一份**（`paths::open_store`），
    // 不在这里重写：这件事里有一半是看不见的（目录不建出来只会在第一次写文件时炸），
    // 而这个 crate 的第一版手抄了一遍，抄漏了 `uploads/`。
    let (resolved, store) =
        paths::open_store(&PathBuf::from(data_dir), &mut config).map_err(|e| e.to_string())?;
    tracing::info!(db = %resolved.db.display(), "存储已打开");

    let runtime = Runtime::new().map_err(|e| format!("建 tokio 运行时失败：{e}"))?;
    let (stop, shutdown) = watch::channel(false);

    // ⚠️ `static_dir = None` → 用**编进服务端的那一份**前端产物。
    // Android 就是这个形态：界面是服务端给的，App 里不放 dist
    // （`docs/specs/android-client.md` §1.1）。
    let mut join = runtime.spawn(serve::serve_with_shutdown(config, store, None, shutdown));

    // ⚠️★ 用 `select!` 而不是「睡一觉再问」：**先发生哪个就返回哪个**。
    // 端口被占用时 serve 会**立刻**返回，这里就立刻拿得到错误，不用等满 `STARTUP_PROBE`。
    let finished_early = runtime.block_on(async {
        tokio::select! {
            _ = tokio::time::sleep(STARTUP_PROBE) => None,
            result = &mut join => Some(result),
        }
    });

    if let Some(result) = finished_early {
        let message = match result {
            Ok(Ok(())) => "服务端启动后立刻退出了（没有报错）".to_owned(),
            Ok(Err(e)) => e.to_string(),
            Err(e) if e.is_panic() => format!("服务端任务 panic 了：{e}"),
            Err(e) => format!("服务端任务被取消：{e}"),
        };
        return Err(message);
    }

    Ok(Running {
        runtime,
        stop,
        join,
    })
}

/// [`Java_com_clip9_app_ServerBridge_nativeStop`] 的实现。
fn stop() -> Option<String> {
    // ① 把 `Running` **取走**，同时把自己标成 `Stopping`（决策见 [`begin_stop`]）。
    //
    // ⚠️★ 必须**先释放锁**再去等（下面那段要等好几秒），否则这期间
    // `nativeStatus` 全被堵住 —— 而它正是界面用来显示「正在停止…」的那一个。
    let running = {
        let mut guard = bridge();
        match begin_stop(&mut guard.state) {
            StopAction::Stop(running) => running,
            // 没在跑 / 已经在停 → 都算成功（用户连点两次「停止」是常事）。
            StopAction::Nothing => return None,
            // ⚠️★ 正在起的时候来停 —— 服务**还没建出来**，这里没有 `Running` 可停；
            // 也不能放任那个正在 `build_and_launch` 的线程（它等下会把状态覆盖成
            // `Running`，那就成了一个**没人能停**的服务端）。如实说，让调用方等它起完。
            StopAction::BusyStarting => {
                let message = "服务端正在启动，还没到能停的状态".to_owned();
                guard.last_error = Some(message.clone());
                return Some(message);
            }
        }
    };

    // ⚠️ 发信号之后**要真的等它回来**，不能「发了就算停」：
    // 服务端在收尾 redb 事务，这时候把 runtime drop 掉等于半路掐断。
    let _ = running.stop.send(true);

    let outcome = running
        .runtime
        .block_on(async { tokio::time::timeout(STOP_TIMEOUT, running.join).await });

    // ⚠️★ 无论成败都**回到 `Idle`**。卡在 `Stopping` 的后果是「界面永远显示正在停止，
    // 而服务其实早就没了」，用户只能去杀进程 —— 而这时候进程里没有任何东西能救它。
    let mut guard = bridge();
    guard.state = State::Idle;

    match outcome {
        Ok(Ok(Ok(()))) => {
            guard.last_error = None;
            None
        }
        Ok(Ok(Err(e))) => {
            let message = format!("停止时服务端报错：{e}");
            guard.last_error = Some(message.clone());
            Some(message)
        }
        Ok(Err(e)) => {
            let message = format!("服务端任务异常结束：{e}");
            guard.last_error = Some(message.clone());
            Some(message)
        }
        Err(_) => {
            let message = format!("停止超时（超过 {STOP_TIMEOUT:?}）—— 可能还有连接没断开");
            guard.last_error = Some(message.clone());
            Some(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ 这一组用例共用 [`BRIDGE`] 这**一个**全局静态（真机上也是它 —— 一个进程只有
    /// 一个服务端），所以必须**串行**：并行时两个用例会互相把对方刚起的那个停掉，
    /// 而症状是「单跑绿、一起跑红」。
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 占一个空闲端口、拿到号、**立刻放掉**（等一下再由被测代码去 bind 它）。
    fn free_port() -> u16 {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("占一个空闲端口");
        let port = probe.local_addr().expect("读本地地址").port();
        drop(probe);
        port
    }

    /// 一组干净的路径：**配置文件**（初始不存在，正好验「写一份默认的出来」）
    /// 与**数据目录**（初始也不存在）。
    ///
    /// ⚠️ 返回的 `TempDir` 由调用方持有：它一被 drop，目录就没了，
    /// 而服务端此刻还开着里面的 redb 库。用例里让它当**第一个**变量 ——
    /// Rust 按声明顺序逆序 drop，于是它会活到最后（也就是 `stop()` 之后）。
    fn scratch() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let config = dir.path().join("config.json").display().to_string();
        let data = dir.path().join("data").display().to_string();
        (dir, config, data)
    }

    /// 造一个「正在跑」但**没有真的起服务端**的 `Running`，给决策表用。
    ///
    /// ⚠️ `_keep` 是那个 `watch` 的接收端，本函数结束时就被丢掉了 ——
    /// 所以对它的 `send` 会失败。`stop()` 里写的是 `let _ = ...send(true)`，
    /// 本来就容忍这件事（真机上发送端也可能先一步消失）。
    fn dummy_running() -> Running {
        let runtime = Runtime::new().expect("建 tokio 运行时");
        let (stop, _keep) = watch::channel(false);
        let join: JoinHandle<anyhow::Result<()>> = runtime.spawn(async { Ok(()) });
        Running {
            runtime,
            stop,
            join,
        }
    }

    /// `begin_start` 的**决策表**：四个入状态，四条出路 + 落成的状态。
    ///
    /// ⚠️ 这几支只在**两个线程同时**调 `start`/`stop` 时才走到 ——
    /// 那种竞态用真起服务端的用例复现不了，所以只能这样穷举。
    #[test]
    fn begin_start_decides_from_every_state() {
        // 没在跑 → 去起，而且**要占住位置**（否则两个线程会同时建库 + 同时绑端口）。
        let mut state = State::Idle;
        assert_eq!(begin_start(&mut state), StartAction::Launch);
        assert!(
            matches!(state, State::Starting),
            "决定要起之后必须把状态占成 Starting，否则第二个线程也走 Launch"
        );

        // 已经在跑 → 幂等成功，而且**不能动**它（动了就等于把服务端丢了）。
        let mut state = State::Running(dummy_running());
        assert_eq!(begin_start(&mut state), StartAction::AlreadyRunning);
        assert!(
            matches!(state, State::Running(_)),
            "幂等命中时不能把状态改掉"
        );

        // 正在停 → 不能说成功（服务正在往下走）。
        let mut state = State::Stopping;
        assert_eq!(begin_start(&mut state), StartAction::BusyStopping);
        assert!(matches!(state, State::Stopping), "被拒绝时状态不能被改掉");

        // 正在起 → 也不能说成功（它还没成）。
        let mut state = State::Starting;
        assert_eq!(begin_start(&mut state), StartAction::BusyStarting);
        assert!(matches!(state, State::Starting), "被拒绝时状态不能被改掉");
    }

    /// `begin_stop` 的**决策表** —— ⚠️ 第二条就是那个踩过的坑。
    #[test]
    fn begin_stop_decides_from_every_state() {
        // 在跑 → 真的把 `Running` 交出来，状态标成 `Stopping`。
        let mut state = State::Running(dummy_running());
        let action = begin_stop(&mut state);
        assert!(
            matches!(action, StopAction::Stop(_)),
            "在跑的时候必须把 Running 交出来（否则没有任何东西能停它）"
        );
        assert!(
            matches!(state, State::Stopping),
            "交出去之后状态要标成 Stopping，界面才知道「正在停」"
        );
        drop(action);

        // ⚠️★ 没在跑 → 算成功，但状态**必须还是 `Idle`**。
        // 第一版这里忘了写回（占位把 `Idle` 换成了 `Stopping`），
        // 于是「在没跑的时候点一次停止」把状态永久钉在 `Stopping`，
        // 之后**再也起不来**，而且没有任何错误信息 —— 这一条就是钉它的。
        let mut state = State::Idle;
        assert!(matches!(begin_stop(&mut state), StopAction::Nothing));
        assert!(
            matches!(state, State::Idle),
            "没得停的时候不能把状态改成别的（改了就永远起不来了）"
        );

        // 已经在停 → 也算成功，但状态要**留在 `Stopping`**：
        // 另一个线程还在收尾，界面这时候必须继续显示「正在停」，
        // 否则用户会去点「启动」，然后得到一句「端口被占用」。
        let mut state = State::Stopping;
        assert!(matches!(begin_stop(&mut state), StopAction::Nothing));
        assert!(
            matches!(state, State::Stopping),
            "已经有线程在停的时候，状态不能退回 Idle"
        );

        // 正在起 → 停不了，也不能把状态改掉。
        let mut state = State::Starting;
        assert!(matches!(begin_stop(&mut state), StopAction::BusyStarting));
        assert!(
            matches!(state, State::Starting),
            "拒绝停止时状态不能被改掉（那个线程还在起）"
        );
    }

    /// 起 → 查状态 → 幂等再起 → 停 → 查状态 → **用同一个端口再起一次**。
    ///
    /// ⚠️ 最后那一步是重点：它同时证明「端口真的被放掉了」和「运行时真的收干净了」
    /// （`stop()` 是等 `serve` 返回之后才结束的，不是发个信号就走）。
    #[test]
    fn the_bridge_starts_stops_and_restarts_on_the_same_port() {
        let _serial = serial();
        let (_dir, config, data) = scratch();
        let port = i32::from(free_port());

        assert_eq!(
            start(&config, &data, "127.0.0.1", port),
            None,
            "第一次起应当成功"
        );
        assert_eq!(status(), STATUS_RUNNING, "起完应当是「在跑」");

        // ⚠️ 幂等：再起一次**不算失败**，也不会冒出第二个服务端
        // （Android 的前台服务被系统重启时就会走到这一步）。
        assert_eq!(
            start(&config, &data, "127.0.0.1", port),
            None,
            "重复启动应当算成功（幂等）"
        );

        assert_eq!(stop(), None, "停止应当成功");
        assert_eq!(status(), STATUS_IDLE, "停完状态要回到「没起」");

        // ⚠️ 同一个端口还能再起 —— 这一步红了就说明「停止」是假的。
        assert_eq!(
            start(&config, &data, "127.0.0.1", port),
            None,
            "同一个端口应当能再起（证明上一轮真的收干净了）"
        );
        assert_eq!(stop(), None, "收尾");
    }

    /// 端口被占用：报出来的话里要能读出**是哪个端口**，而且**失败之后还能重来**。
    #[test]
    fn an_occupied_port_is_reported_and_the_bridge_can_retry() {
        let _serial = serial();
        let (_dir, config, data) = scratch();

        // 先自己占住一个端口。
        let squatter = std::net::TcpListener::bind("127.0.0.1:0").expect("占住端口");
        let port = squatter.local_addr().expect("读本地地址").port();

        let message =
            start(&config, &data, "127.0.0.1", i32::from(port)).expect("端口被占用时应当失败");
        assert!(
            message.contains(&port.to_string()),
            "错误里要能读出是哪个端口被占了，实际是：{message}"
        );

        // ⚠️★ 起失败之后**必须回到「没起」**。少了那一步（比如把状态留在 `Starting`）的
        // 后果是：之后每一次 `start` 都走「正在启动，请稍候」那一支，
        // **永远起不来，而且任何日志里都没有线索**。
        assert_eq!(status(), STATUS_IDLE, "起失败之后状态必须回到「没起」");

        drop(squatter); // 放掉端口
        assert_eq!(
            start(&config, &data, "127.0.0.1", i32::from(port)),
            None,
            "端口放掉之后应当还能起来（失败是可以重来的）"
        );
        assert_eq!(status(), STATUS_RUNNING);
        assert_eq!(stop(), None, "收尾");
    }

    /// 没在跑的时候 `stop()` **也算成功**（用户连点两次「停止」是常事）。
    #[test]
    fn stopping_when_nothing_is_running_succeeds() {
        let _serial = serial();
        assert_eq!(status(), STATUS_IDLE, "进这个用例时应当没有服务端在跑");
        assert_eq!(stop(), None, "没得停也算成功");
        assert_eq!(status(), STATUS_IDLE);
    }
}
