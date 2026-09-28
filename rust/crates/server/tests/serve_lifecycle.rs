//! 「起一个服务端」这件事的**生命周期**：起得来、停得掉、端口被占用时说得出是哪个端口。
//!
//! ⚠️★ 这是 `crates/server` 里**唯一**真起监听（绑端口）的测试文件。别的集成测试都用
//! `tower::ServiceExt::oneshot` 直接喂 Router —— 那条路验不到「停止」「端口占用」，
//! 因为根本没有 listener。
//!
//! ⚠️ 为什么这几条非有不可：Android 那侧要**在应用进程里启停同一个服务端**
//! （`docs/specs/android-client.md` §5），而「停」这件事最怕的是**停不掉**：
//! 表现是「点了停止，按钮一直转」，而日志里什么都没有。

use std::time::Duration;

use clip9_core::Config;
use clip9_server::{paths, serve};
use clip9_store::{Limits, Store};
use tokio::sync::watch;

/// 拿一个「当前空闲」的端口号。
///
/// ⚠️ 先 bind 一次拿号、**随即 drop**，所以理论上存在「刚放开就被别人抢走」的窗口。
/// 这是测试里的常规取舍：用一个写死的端口会撞 CI 上别的东西，那时失败的是**别人**。
fn a_free_port() -> u16 {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("探一个空闲端口");
    probe.local_addr().expect("拿本地地址").port()
}

/// 造一份能跑的最小配置 + store（库落在临时目录里）。
fn fixture(dir: &std::path::Path, port: u16) -> (Config, Store) {
    let mut config = Config::default();
    // ⚠️ 绑 127.0.0.1 而不是默认的 0.0.0.0：测试不该对着所有网卡开服务。
    config.server.host = serde_json::Value::String("127.0.0.1".to_owned());
    config.server.port = port;
    let paths = paths::resolve_into(dir, &mut config);
    let store = Store::open_with(&paths.db, Limits::default()).expect("打开临时库");
    (config, store)
}

/// ★ 发停止信号之后，`serve_with_shutdown` **要真的返回**，而且端口要**放开**。
///
/// ⚠️ 这条钉的是「停得掉」。把 `with_graceful_shutdown` 去掉、或者把
/// `wait_for_shutdown` 改成恒 `false`，这里就会卡在 `timeout` 上 —— 见文件头的变异说明。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_the_server_returns_and_frees_the_port() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let port = a_free_port();
    let (config, store) = fixture(tmp.path(), port);

    let (tx, rx) = watch::channel(false);
    let task = tokio::spawn(serve::serve_with_shutdown(config, store, None, rx));

    // 等它把 listener 建起来。⚠️ 这里只能等 —— `serve_with_shutdown` 是「一直跑到停」，
    // 没有「已经起来了」的回执。给足时间，后面那条占用端口的用例会**证明**它真的在监听。
    tokio::time::sleep(Duration::from_millis(300)).await;

    tx.send(true).expect("发停止信号");

    let joined = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("发了停止信号，serve 却没有返回 —— 优雅关闭没接上")
        .expect("任务不该 panic");
    joined.expect("正常停止应当是 Ok");

    // ⚠️ 端口**放开**了才算真的停干净：进程里还挂着一个 listener 的话，
    // Android 上「停止后再启动」会直接撞自己的端口占用。
    std::net::TcpListener::bind(("127.0.0.1", port))
        .expect("停止之后这个端口应当能重新绑上（listener 没关干净）");
}

/// ★ 端口被占用时，**错误里要说得出是哪个端口**。
///
/// ⚠️ 这条对应 `docs/ARCHITECTURE.md` §4.1 第 1 条：**绝不能静默换端口**。
/// 静默换端口的后果是「用户填进别的设备的地址永远连不上」，
/// 而两边都不报错（这边起来了、对端说超时）。
///
/// ⚠️ 判断「报的是不是那一句」而不是「有没有报错」—— 报错指向别处等于没牙。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starting_on_an_occupied_port_names_the_port() {
    let tmp = tempfile::tempdir().expect("临时目录");
    let port = a_free_port();

    // 故意占着不放。
    let _hog = std::net::TcpListener::bind(("127.0.0.1", port)).expect("占住端口");

    let (config, store) = fixture(tmp.path(), port);
    let (_tx, rx) = watch::channel(false);

    let err = tokio::time::timeout(
        Duration::from_secs(10),
        serve::serve_with_shutdown(config, store, None, rx),
    )
    .await
    .expect("端口被占用时应当**立刻**返回，而不是挂着")
    .expect_err("端口被占用了，不该报成功");

    let text = err.to_string();
    assert!(
        text.contains(&port.to_string()),
        "错误里要能读出是哪个端口被占了，实际是：{text}"
    );
    assert!(
        text.contains("端口被占用"),
        "错误要指向「端口被占用」这件事，实际是：{text}"
    );
}
