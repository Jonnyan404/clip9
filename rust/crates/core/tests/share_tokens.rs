//! 契约测试：逐字节复现 fixture 里那份令牌。
//!
//! fixture 在 `cases/share/tokens.json`，每组用例都带着**签名密钥**与**token**。它原先由
//! Go 侧导出（拆库时带过来，见 `cases/README.md`）；clip9 独立成项目、并把密钥派生的
//! 域分隔标签换成自己的之后，**这份夹具归这边所有**，`UPDATE_FIXTURES=1` 可以就地重算
//! （见下面 `update_fixture`）。断言两件事：
//!
//! 1. 同一份配置 → 派生出的密钥**逐字节相同**；
//! 2. 同一份 claims → 签出来的 token 字符串**逐字节相同**，并且能被自己解析回来。
//!
//! 为什么值得这么较真：这两样合起来才是「分享令牌在重启 / 换实现之后仍然有效」。
//! 而它们读代码看不出来 —— claims 的 omitempty 效果、密钥派生时房间的**排序**、
//! HMAC 签的是编码前还是编码后的那段，任何一处不一样都会得到一个「看起来也像 token」
//! 的串，只是谁都验不过（而且要等到用户点开旧链接才会发现）。
//!
//! ⚠️ 改这个测试之前先读 fixture 文件头：它红了意味着**所有已发出的分享链接会失效**。

use std::path::PathBuf;

use clip9_core::config::RoomAuthConfig;
use clip9_core::{Config, ShareClaims, ShareKey};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    #[serde(rename = "globalAuth")]
    global_auth: serde_json::Value,
    #[serde(rename = "roomAuth")]
    room_auth: RoomAuthConfig,
    claims: ShareClaims,
    #[serde(rename = "keyHex")]
    key_hex: String,
    token: String,
}

fn fixture_path() -> PathBuf {
    // rust/crates/core → rust → 仓库根
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../cases/share/tokens.json")
}

/// 是不是在「重算并写回」模式。与 Go 那边同一个环境变量名，用法也一样。
fn update_mode() -> bool {
    std::env::var("UPDATE_FIXTURES").is_ok_and(|v| v == "1")
}

/// 按用例自己的输入算出 `(keyHex, token)`。
///
/// ⚠️ 配置走的是**线上那条**加载路径（`roomAuth` 的四种写法由 `RoomAuthEntry` 自己解析）。
/// ⚠️ 沙在这里传什么都不影响结果：配置里有密码时走的是「无盐」那条分支。传一个非空值反而是
/// 刻意的 —— 万一哪天分支写反了（有密码也加盐），测试会红。
fn derive_case(case: &Case) -> (ShareKey, String, String) {
    let mut config = Config::default();
    config.server.auth =
        serde_json::from_value(case.global_auth.clone()).expect("globalAuth 解析失败");
    config.server.room_auth = case.room_auth.normalized();

    let key = ShareKey::derive(&config, b"this-salt-must-be-ignored");
    let key_hex = key.key_fingerprint_hex();
    let token = key.sign(&case.claims);
    (key, key_hex, token)
}

#[test]
fn go_signed_share_tokens_round_trip_byte_for_byte() {
    let path = fixture_path();
    let raw = std::fs::read_to_string(&path)
        .expect("读不到 cases/share/tokens.json（首次生成用 UPDATE_FIXTURES=1）");
    let fixture: Fixture = serde_json::from_str(&raw).expect("fixture 解析失败");
    assert!(!fixture.cases.is_empty(), "fixture 里一条用例都没有");

    // 重算模式：只在**文本上替换那两个派生值**，输入部分一个字都不动。
    // ⚠️ 刻意不「读成结构体再整体写回去」—— 那样 serde 的字段顺序与转义会顺带改掉 inputs
    // （配置与 claims），于是这就不再是「同一个夹具换一把钥匙」，而是换了一份夹具。
    let mut rewritten = raw.clone();
    let mut moved: Vec<&str> = Vec::new();

    for case in &fixture.cases {
        let (key, key_hex, token) = derive_case(case);

        if update_mode() {
            if key_hex != case.key_hex || token != case.token {
                moved.push(&case.name);
            }
            rewritten = rewritten.replace(&case.key_hex, &key_hex);
            rewritten = rewritten.replace(&case.token, &token);

            // 反向只对**新** token 做：夹具里那个旧 token 是用旧标签签的，换了钥匙之后
            // 必然验不过 —— 拿它做断言只会把「该写回」误报成「解析失败」。
            let parsed = key
                .parse(&token, case.claims.exp - 1)
                .unwrap_or_else(|| panic!("用例 {} 重算出来的 token 解析失败", case.name));
            assert_eq!(
                parsed, case.claims,
                "用例 {} 重算的 token 解析不回原 claims",
                case.name
            );
        } else {
            assert_eq!(
                key_hex, case.key_hex,
                "用例 {} 的**密钥派生**与 fixture 不一致：所有已发出的分享链接会失效",
                case.name
            );
            assert_eq!(
                token, case.token,
                "用例 {} 的**token 字节**与 fixture 不一致（claims 的字段名 / omitempty / 签名范围漂了）",
                case.name
            );

            // 反向：fixture 里的 token 必须能被我们验过并解析回同一份 claims。
            let parsed = key
                .parse(&case.token, case.claims.exp - 1)
                .unwrap_or_else(|| panic!("用例 {} 的 token 解析失败", case.name));
            assert_eq!(
                parsed, case.claims,
                "用例 {} 解析回来的 claims 不一致",
                case.name
            );

            // 过期一秒钟都不行（exp 是闭区间：exp 那一刻还算有效）。
            assert!(
                key.parse(&case.token, case.claims.exp + 1).is_none(),
                "用例 {} 的 token 过期之后仍然被接受",
                case.name
            );
        }
    }

    if update_mode() {
        if rewritten == raw {
            println!(
                "fixture 无需改动：{} 条用例的值都对得上",
                fixture.cases.len()
            );
        } else {
            std::fs::write(&path, &rewritten).expect("写回 fixture 失败");
            println!(
                "已重算 fixture：{} 条用例里有 {} 条的值变了 —— {}",
                fixture.cases.len(),
                moved.len(),
                moved.join(", ")
            );
        }
    }
}

/// 换一把配置就该换一把钥匙 —— 否则「改密码之后旧链接失效」这个性质就不成立。
#[test]
fn a_different_password_derives_a_different_key() {
    let mut open = Config::default();
    let mut locked = Config::default();
    locked.server.auth = clip9_core::AuthValue::Str("global-pw".into());

    let open_key = ShareKey::derive(&open, b"salt-a");
    let locked_key = ShareKey::derive(&locked, b"salt-a");
    assert_ne!(
        open_key.key_fingerprint_hex(),
        locked_key.key_fingerprint_hex()
    );

    // 同一份配置 + 同一份盐 → 稳定（重启后链接不失效靠的就是这个）。
    open.server.auth = clip9_core::AuthValue::Str("global-pw".into());
    assert_eq!(
        ShareKey::derive(&open, b"salt-a").key_fingerprint_hex(),
        locked_key.key_fingerprint_hex()
    );

    // 无认证材料时，盐不同 → 钥匙不同（那本来就没有别的秘密，至少别变成固定空密钥）。
    let no_auth = Config::default();
    assert_ne!(
        ShareKey::derive(&no_auth, b"salt-a").key_fingerprint_hex(),
        ShareKey::derive(&no_auth, b"salt-b").key_fingerprint_hex()
    );
}
