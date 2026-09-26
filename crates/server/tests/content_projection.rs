//! `/content` 那一族的**投影**对不对 —— 对着 Go 导出的三份 fixture 逐字比。
//!
//! ⚠️ 为什么不在 `crates/protocol` 里测：投影由 `crates/server` 的 `content_entry()` 生成，
//! 而 `protocol` **不能依赖 `server`**（依赖方向是单向的：`protocol ← core ← store ← server`）。
//! 所以那边只钉了形状（文件在不在、有没有 `type` / `id`），**「投影本身对不对」在这里**。
//!
//! fixture 是 Go 侧 `protocol_fixture_test.go` 导出的（`docs/specs/ws-live-only.md` 的 W0），
//! 同步方向永远是 Go → 本仓库。**别手工编辑 `cases/`** —— 它是导出产物。

use std::path::PathBuf;

use clip9_protocol::ReceiveHolder;
use clip9_server::handlers::content_entry;

/// 读 `cases/protocol/<name>.json`。
///
/// `CARGO_MANIFEST_DIR` 是 `<仓库>/crates/server`，往上两层到仓库根。
fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../cases/protocol")
        .join(format!("{name}.json"));
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{} 不是合法 JSON: {e}", path.display()))
}

/// 单条投影：文本与文件两条分支。
#[test]
fn content_entry_matches_the_go_fixtures() {
    let text: ReceiveHolder = serde_json::from_value(fixture("text_receive")).unwrap();
    assert_eq!(
        content_entry(&text),
        fixture("content_entry_text"),
        "文本条目的投影与 Go 不一致"
    );

    // ⚠️ 文件条目里 `url` 是**拼上文件名**的那个形式（与 `/content/latest` 一致）——
    // 而 `file_receive` 的 `url` 是**裸的** `…/file/<uuid>`，所以这条同时钉住了
    // 「拼了」和「拼的是转义过的文件名」两件事。
    let file: ReceiveHolder = serde_json::from_value(fixture("file_receive")).unwrap();
    assert_eq!(
        content_entry(&file),
        fixture("content_entry_file"),
        "文件条目的投影与 Go 不一致"
    );
}

/// 列表响应：`{"messages": [...]}`，**正序**（旧的在前）。
///
/// ⚠️ 这条同时钉住「列表里的条目与单条取出来的是同一个形状」—— 它们共用 `content_entry()`，
/// 而客户端是拿列表里的条目直接渲染的，不会为两个端点写两套解析。
#[test]
fn content_list_matches_the_go_fixture() {
    let text: ReceiveHolder = serde_json::from_value(fixture("text_receive")).unwrap();
    let file: ReceiveHolder = serde_json::from_value(fixture("file_receive")).unwrap();

    let built = serde_json::json!({
        "messages": [content_entry(&text), content_entry(&file)],
    });

    assert_eq!(built, fixture("content_list"), "列表响应的形状与 Go 不一致");
}
