//! `/upload` 的多文件形态：HTTP Shortcuts 的 `file_picker_multi` 发 `file[]`。
//!
//! 这条路径和「一次一个 `file`」共用同一个 handler，但语义必须分清：
//!   - 单个 `file`            → 老形状 `{url, id, type}`（Apple 快捷指令 / 网页 / 桌面端）
//!   - 一个或多个 `file[]`    → 批量形状 `{count, ids, files}`，**每个文件一条消息**
//!   - 多个 `file` part       → 也按批量处理（不把后面的悄悄丢掉）

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use clip9_core::Config;
use clip9_server::{AppState, router};
use clip9_store::Store;
use serde_json::Value;
use tower::ServiceExt;

fn peer() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 41234))
}

fn app(file_limit: i64) -> (Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = Store::open(dir.path().join("clip9.redb")).expect("打开 store");
    let mut config = Config::default();
    let storage = dir.path().join("uploads");
    std::fs::create_dir_all(&storage).expect("建上传目录");
    config.server.storage_dir = storage.display().to_string();
    config.file.limit = file_limit;
    let state = AppState::new(config, store, None);
    (router(state), dir)
}

fn multipart(boundary: &str, parts: &[(&str, &str, &[u8])]) -> Vec<u8> {
    let mut body = Vec::new();
    for (field, filename, data) in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

async fn upload(app: &Router, body: Vec<u8>, boundary: &str) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri("/upload?room=default")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .expect("构造请求");
    request.extensions_mut().insert(ConnectInfo(peer()));
    let response = app.clone().oneshot(request).await.expect("路由返回了错误");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("读响应体");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn file_array_parts_become_one_message_each() {
    let (app, _dir) = app(256 * 1024 * 1024);
    let boundary = "clip9-multi-boundary";
    let body = multipart(
        boundary,
        &[
            ("file[]", "a.txt", b"hello"),
            ("file[]", "b.txt", b"world!"),
        ],
    );
    let (status, value) = upload(&app, body, boundary).await;

    assert_eq!(status, StatusCode::OK, "响应：{value}");
    assert_eq!(value["count"].as_u64(), Some(2));
    let ids = value["ids"].as_array().expect("ids 必须是数组");
    assert_eq!(ids.len(), 2);
    let files = value["files"].as_array().expect("files 必须是数组");
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["name"], "a.txt");
    assert_eq!(files[1]["name"], "b.txt");
    assert_eq!(files[0]["size"].as_i64(), Some(5));
    assert_eq!(files[1]["size"].as_i64(), Some(6));
    assert!(files.iter().all(|file| file["id"].is_string()));
}

#[tokio::test]
async fn a_single_file_part_keeps_the_legacy_shape() {
    let (app, _dir) = app(256 * 1024 * 1024);
    let boundary = "clip9-single-boundary";
    let body = multipart(boundary, &[("file", "one.txt", b"hello")]);
    let (status, value) = upload(&app, body, boundary).await;

    assert_eq!(status, StatusCode::OK, "响应：{value}");
    assert!(value["id"].is_string(), "单文件仍然回 id：{value}");
    assert!(value["url"].is_string());
    assert!(
        value.get("ids").is_none(),
        "单 file 不应变成批量形状：{value}"
    );
}

#[tokio::test]
async fn one_file_array_part_is_still_a_batch() {
    let (app, _dir) = app(256 * 1024 * 1024);
    let boundary = "clip9-one-array-boundary";
    let body = multipart(boundary, &[("file[]", "one.txt", b"hello")]);
    let (status, value) = upload(&app, body, boundary).await;

    assert_eq!(status, StatusCode::OK, "响应：{value}");
    assert_eq!(value["ids"].as_array().map(Vec::len), Some(1));
    assert_eq!(value["files"][0]["name"], "one.txt");
}

#[tokio::test]
async fn each_part_is_checked_against_the_per_file_limit() {
    let (app, _dir) = app(4);
    let boundary = "clip9-limit-boundary";
    let body = multipart(
        boundary,
        &[
            ("file[]", "ok.txt", b"abc"),
            ("file[]", "too-big.txt", b"hello"),
        ],
    );
    let (status, value) = upload(&app, body, boundary).await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "响应：{value}");
    assert_eq!(value["code"], "file_too_large");
    assert!(
        value["message"]
            .as_str()
            .unwrap_or("")
            .contains("too-big.txt"),
        "要指出是哪个文件超限：{value}"
    );
}
