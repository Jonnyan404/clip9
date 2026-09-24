//! 契约层验收：拿 **Go 导出的 JSON fixture** 校验 Rust 这边。
//!
//! # 为什么不能只写单元测试
//!
//! 单元测试是我写什么就测什么 —— 它验证的是「Rust 内部自洽」，
//! 验证不了「和 Go 一致」。而这份契约的权威是 `docs/api.md`，
//! 字段名与 `omitempty` 的**实际效果**只有 Go 的 `encoding/json` 说了算。
//!
//! 所以：Go 侧 `protocol_fixture_test.go` 生成 `cases/protocol/*.json`
//! （那就是 Go 真实吐出来的字节），这边读它、反序列化、再序列化、比对。
//!
//! # 为什么比的是 `Value` 而不是字节
//!
//! 两处**故意的**字节差异，都不是契约：
//!
//! 1. Go 默认开 HTML 转义（`<` → `\u003c`），serde_json 不转义。两种都是合法 JSON，
//!    任何解析器读出来一样。
//! 2. key 顺序。JSON 对象无序，没人按字节读它。
//!
//! 而 `Value` 的深比较**恰好**能抓住真正重要的东西：
//! key 在不在、`null` 和缺失和 `{}` 三者的区别、值的类型。这几样才是会咬人的。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use clip9_protocol::{
    DeviceMeta, History, PostEvent, ReceiveHolder, RoomInfo, RoomListResponse, WsMessage,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// fixture 在父仓库的 `cases/protocol/`。
///
/// ⚠️ 它**不在** `rust/` 里面 —— 那份数据属于契约，和 `docs/api.md` 一个层级，
/// 所以要跟着父仓库走（见 docs/ARCHITECTURE.md §5.4）。
/// 拆成独立仓库时把它一起带走，否则这个测试会红，而且是**好事**：
/// 说明契约数据没跟上。
fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cases/protocol")
}

/// 读一份 fixture，按 `T` 解析，再序列化回 JSON 与原文件深比较。
fn check<T>(name: &str, text: &str)
where
    T: DeserializeOwned + Serialize,
{
    let mut expected: Value = serde_json::from_str(text)
        .unwrap_or_else(|e| panic!("{name}: fixture 本身不是合法 JSON: {e}"));

    let parsed: T = serde_json::from_str(text)
        .unwrap_or_else(|e| panic!("{name}: Rust 读不了 Go 写出来的形状: {e}\n原文: {text}"));

    let mut actual =
        serde_json::to_value(&parsed).unwrap_or_else(|e| panic!("{name}: 回写失败: {e}"));

    fold_null_collections(&mut expected);
    fold_null_collections(&mut actual);

    assert_eq!(
        actual, expected,
        "\n{name}: 往返之后形状变了 —— 大概率是某个 omitempty 谓词写错了\n\
         左 = Rust 回写，右 = Go 原始输出\n"
    );
}

/// Go 写 `null`、Rust 写 `[]` —— **唯一一处刻意的形状不对称**。
///
/// 为什么 Go 会写 `null`：`saveHistoryData`（`main.go:277`）里是
/// `var filesForHistory []File` 再 append，`uploadFileMap` 为空时它保持 nil，
/// 而 nil 切片序列化成 `null` 而不是 `[]`。所以 `history.json` 在「没有文件」时
/// **真的**会有 `"file": null` —— 这不是我造出来的边角情况。
///
/// Rust 侧的取舍：用 `Vec<T>` + 读时容忍 null（`de_null_or_default`），写出去一律数组。
/// 这个不对称是安全的，因为 `History` 在这边**只是「把老数据读进来」的入口** ——
/// 新存储（redb）不按这个形状存，也不会写回这个文件；而 Go 两种写法都读得进来。
/// 反过来（Rust 也写 `null`）只是没必要的麻烦。
///
/// ⚠️ 归一**只对 `file` / `receive` 这两个 key**。`senderDevice` 的 `null` 不在其列 ——
/// 那里的 null / 缺失 / `{}` 三态是真会咬人的，必须严格比。
fn fold_null_collections(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if child.is_null() && (key == "file" || key == "receive") {
                    *child = Value::Array(Vec::new());
                } else {
                    fold_null_collections(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(fold_null_collections),
        _ => {}
    }
}

/// 收集所有 fixture 文件名（不含扩展名）。
fn fixture_stems() -> BTreeSet<String> {
    let dir = fixture_dir();
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|e| {
        panic!(
            "读不到 fixture 目录 {}: {e}\n\
             它在父仓库的 cases/protocol/ —— 别把它搬到 rust/ 里面去，\n\
             那是契约数据，Go 侧的测试也要读同一份。",
            dir.display()
        )
    });

    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            path.file_stem().and_then(|s| s.to_str()).map(str::to_owned)
        })
        .collect()
}

fn read_fixture(stem: &str) -> String {
    let path = fixture_dir().join(format!("{stem}.json"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()))
}

/// 每一份 fixture 都要能被对应的类型读进来、并且原样写回去。
///
/// ⚠️ 这个测试**不按固定清单遍历**，而是扫目录 —— 这样「加了 fixture 却忘了接上」
/// 会直接红，而不是被静默跳过。
#[test]
fn every_go_fixture_round_trips() {
    let mut unhandled = Vec::new();

    for stem in fixture_stems() {
        let text = read_fixture(&stem);
        match stem.as_str() {
            "device_meta" | "device_meta_no_name" => check::<DeviceMeta>(&stem, &text),
            "room_info" => check::<RoomInfo>(&stem, &text),
            "room_list" => check::<RoomListResponse>(&stem, &text),
            "history" | "history_empty" => check::<History>(&stem, &text),
            "post_event_text" | "post_event_file" => check::<PostEvent>(&stem, &text),
            "ws_connect" => check::<WsMessage<Value>>(&stem, &text),
            s if s.starts_with("text_receive") || s.starts_with("file_receive") => {
                check::<ReceiveHolder>(&stem, &text);
            }
            _ => unhandled.push(stem),
        }
    }

    assert!(
        unhandled.is_empty(),
        "这些 fixture 没有对应的断言，接上它们：{unhandled:?}"
    );
}

/// 单独把几条**最容易写错**的语义拎出来，让失败信息更直白。
mod semantics {
    use super::*;

    /// `omitempty` 的分布：最小文本条目应该只剩 `id` / `type` / `room` / `timestamp` /
    /// `senderIP` / `senderDevice` 六个 key。
    ///
    /// ⚠️ 少一个 key 就是「Rust 比 Go 更爱省略」，多一个就是「Rust 省略得不够」——
    /// 两种都会让某个客户端在某些条目上读到 `undefined`。
    #[test]
    fn minimal_text_entry_keeps_exactly_the_non_omittable_keys() {
        let text = read_fixture("text_receive_min");
        let parsed: ReceiveHolder = serde_json::from_str(&text).unwrap();
        let actual = serde_json::to_value(&parsed).unwrap();
        let obj = actual.as_object().expect("应该是个对象");

        let keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = [
            "id",
            "type",
            "room",
            "timestamp",
            "senderIP",
            "senderDevice",
        ]
        .into_iter()
        .collect();

        assert_eq!(keys, expected, "最小条目的 key 集合不对");
        // ⚠️ `senderDevice` 没有 omitempty，所以 nil 是 `null` ——
        // 既不是省略，也不是 `{}`。这三种情况混起来是最隐蔽的一类漂移。
        assert!(obj["senderDevice"].is_null(), "senderDevice 应该是 null");
    }

    /// `senderDevice: null` 的条目也要能读回来。
    #[test]
    fn nil_sender_device_is_null_not_empty_object() {
        let text = read_fixture("text_receive_nil_device");
        let parsed: ReceiveHolder = serde_json::from_str(&text).unwrap();
        assert!(
            parsed.sender_device().is_none(),
            "nil map 读出来应该是 None"
        );
        let actual = serde_json::to_value(&parsed).unwrap();
        assert!(actual["senderDevice"].is_null());
    }

    /// `History` 里 Go 写的 `null` 切片必须能读进来（读得宽松），
    /// 但写出去是数组 —— 这个不对称是刻意的。
    #[test]
    fn history_reads_go_nulls_and_writes_arrays() {
        let text = read_fixture("history_empty");
        let parsed: History = serde_json::from_str(&text).unwrap();
        assert!(parsed.file.is_empty());
        assert!(parsed.receive.is_empty());
        let actual = serde_json::to_value(&parsed).unwrap();
        assert_eq!(actual["file"], serde_json::json!([]));
        assert_eq!(actual["receive"], serde_json::json!([]));
    }

    /// `ReceiveHolder` 按 `type` 分派，认不出的必须报错 —— 不能静默降级成文本。
    #[test]
    fn holder_rejects_unknown_type() {
        assert!(serde_json::from_str::<ReceiveHolder>(r#"{"type":"nope","id":1}"#).is_err());
        assert!(serde_json::from_str::<ReceiveHolder>(r#"{"id":1}"#).is_err());
    }

    /// 看板的 `column` 在文本和文件两个分支上都要能往返。
    #[test]
    fn column_survives_on_both_branches() {
        for stem in ["text_receive_auto", "file_receive_column"] {
            let text = read_fixture(stem);
            let parsed: ReceiveHolder = serde_json::from_str(&text).unwrap();
            assert!(
                !parsed.column().is_empty(),
                "{stem}: column 丢了 —— 看板挪列会「拖了没反应」"
            );
        }
    }
}
