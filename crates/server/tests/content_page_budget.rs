//! `GET /content` 一页的**字节预算**（走真 Router）。
//!
//! ⚠️ 为什么单测（`handlers::tests` 里那几条纯函数）不够：那些只验「该丢几条」的算术。
//! 这里要验的是**它真的接上去了、而且丢对了一头** —— 把 `drain(..n)` 写成
//! `drain(len - n..)`（丢掉**最新**的那一头）、或者干脆不接，纯函数照样全绿，
//! 而线上表现是「`/content` 返回的是这一段里**最旧**的几条」：用户翻历史时看到
//! 的是「往新的那头断了一截」，而**没有任何报错**。
//!
//! ⚠️ 测试函数必须是 `#[tokio::test]`：`AppState::new` 会**启动调度器**，
//! 那需要 tokio 运行时（在运行时外面调它，报的是一句「there is no reactor running」，
//! 和本片毫无关系）。

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use clip9_core::Config;
use clip9_protocol::{ReceiveBase, ReceiveHolder, TextReceive};
use clip9_server::{AppState, router};
use clip9_store::Store;
use tower::ServiceExt;

/// 每条正文多大。3 条 = 900 KiB（装得下 1 MiB 的预算），4 条 = 1.2 MiB（装不下）。
const ENTRY_BYTES: usize = 300 * 1024;

/// `text.limit` 配得比一条大 —— 这一片保护的正是**上限被调大之后**那种部署。
const TEXT_LIMIT: i64 = 4 * 1024 * 1024;

/// 一条正文：全部是同一个字符，这样一眼能看出返回的是哪一条。
fn big(ch: char) -> String {
    std::iter::repeat_n(ch, ENTRY_BYTES).collect()
}

fn text_entry(content: String) -> ReceiveHolder {
    ReceiveHolder::Text(TextReceive {
        base: ReceiveBase {
            kind: "text".to_owned(),
            room: "default".to_owned(),
            timestamp: 1_700_000_000,
            ..ReceiveBase::default()
        },
        content,
        ..TextReceive::default()
    })
}

/// 一个「上限调大了」的服务端 + 已经灌好的几条大正文。
///
/// ⚠️ 直接调 `store.insert` 而不是 `POST /text`：这一片测的是**读**那一边，
/// 走 HTTP 写会把 `TEXT_BODY_HARD_CAP` 也拖进来（那是另一片 S1 的事），
/// 一条测试里混两件事，红了分不清是谁。
fn app_with(bodies: Vec<String>) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    for body in bodies {
        store.insert(text_entry(body)).expect("写入");
    }
    let mut config = Config::default();
    config.server.storage_dir = dir.path().join("uploads").display().to_string();
    config.text.limit = TEXT_LIMIT;
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

/// 取一页，返回（状态码，响应体字节数，解析出来的 `messages`）。
async fn page(router: &Router) -> (StatusCode, usize, Vec<serde_json::Value>) {
    let resp = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/content?room=default")
                .body(Body::empty())
                .expect("构造请求"),
        )
        .await
        .expect("请求应返回");
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("读响应体");
    let json: serde_json::Value = serde_json::from_slice(&bytes).expect("响应应是 JSON");
    let messages = json["messages"]
        .as_array()
        .expect("messages 应是数组")
        .clone();
    (status, bytes.len(), messages)
}

/// ⚠️★ 本片的全部意义：一页装不下时**丢最旧的那一端**，而不是最新的。
#[tokio::test]
async fn a_page_that_does_not_fit_drops_the_oldest_end() {
    let (router, _dir) = app_with(vec![big('A'), big('B'), big('C'), big('D')]);
    let (status, body_bytes, messages) = page(&router).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        messages.len(),
        3,
        "1.2 MiB 的正文装进 1 MiB 的预算 → 只留 3 条（现在返回 {} 条）",
        messages.len()
    );
    assert!(
        messages[0]["content"]
            .as_str()
            .unwrap_or("")
            .starts_with('B'),
        "被丢掉的是**最旧的**那条（A）—— 返回的第一条应该是 B，拿到的是 {:?}",
        messages[0]["content"].as_str().unwrap_or("").chars().next()
    );
    assert!(
        messages[2]["content"]
            .as_str()
            .unwrap_or("")
            .starts_with('D'),
        "**最新**的那条永远在里面（否则就是「往新的那头断了一截」）"
    );
    // ⚠️ 响应体**真的**小了 —— 这条是「防一次响应几十 MB」的字面验收。
    assert!(
        body_bytes < 1024 * 1024 + 64 * 1024,
        "响应体 {body_bytes} 字节 —— 预算没接上，或者接上了但没生效"
    );
}

/// ⚠️★ 单独一条就超预算时**照样返回它**，不能返回空数组。
///
/// 契约里「**空数组 = 到头了**」（`content_list` 的文档与 Go/Worker 的同一句），
/// 所以按字节预算把一条超长消息滤掉，会在客户端表现为
/// 「这个房间没有更早的历史了」—— 那条消息**再也拉不到**，而且**没有任何报错**。
/// 宁可超预算一次（那只是慢），也不能让它变成「不存在」（那是丢数据）。
#[tokio::test]
async fn a_single_entry_over_the_budget_is_still_returned() {
    let (router, _dir) = app_with(vec![big('A').repeat(8)]);
    let (status, _bytes, messages) = page(&router).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        messages.len(),
        1,
        "超预算的单条必须**照样返回** —— 返回空 = 客户端以为到头了，那条就永远拉不到了"
    );
    assert!(
        messages[0]["content"]
            .as_str()
            .unwrap_or("")
            .starts_with('A')
    );
}

/// 装得下就**一条都不动** —— 正常路径下这一片必须完全隐形。
#[tokio::test]
async fn a_page_that_fits_is_left_alone() {
    let (router, _dir) = app_with(vec![big('A'), big('B'), big('C')]);
    let (status, _bytes, messages) = page(&router).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(messages.len(), 3, "900 KiB 装得下，不该丢任何一条");
    assert!(
        messages[0]["content"]
            .as_str()
            .unwrap_or("")
            .starts_with('A')
    );
}
