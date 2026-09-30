//! 服务端配置的可视化编辑 —— 读、改、**原子写回**、重启生效。
//!
//! # 三条硬要求（`dev-docs/specs/desktop-client.md` §3.5.2 ②）
//!
//! 1. ✅ **只能本机可访问** —— **由构造保证**：这个编辑器是 Tauri 命令（走 IPC），
//!    **不是**服务端的一条 HTTP 路由。所以它**没有网络面** —— 也就不需要为它加鉴权、
//!    不用担心哪天被反代出去。⚠️ 这是有意的：一个**能改密码**的界面，
//!    最安全的做法就是**不给它网络入口**。
//! 2. ✅ **原子写**（临时文件 + rename）—— 这个项目为「半截 JSON」付过代价
//!    （并发写 30 轮里 13 轮写出损坏的文件）。
//! 3. ⚠️ **保存后需重启才生效** —— 配置文件是**启动时读一次**的。
//!    所以命令必须**说清**这一点，而「保存并重启」只在**自带服务端**时做得到。
//!
//! # ⚠️★ 两条最容易做错的
//!
//! - **不许「读成结构体再写回去」**：读进来是 [`serde_json::Value`]，改动**只打补丁**
//!   到那份 Value 上，再整体写回。⚠️ 读成类型化的 `Config` 再序列化出去的话，
//!   **用户配置里我们不认识的键会被静默丢掉**（将来版本加的东西、他自己留的字段）——
//!   那是**静默的数据丢失**，而用户只会在某次升级后发现问题。
//! - **写之前必须校验**：服务端在配置解析失败时**拒绝启动**（`load_config` 那条），
//!   所以这里写出去的**必须**能被 `clip9_core::Config` 解析。校验用的是**服务端自己那个类型**
//!   （`clip9-core`），不是这里另写一套规则 —— 两套规则一定会漂。

use std::path::{Path, PathBuf};

use clip9_client::Msg;
use clip9_core::Config;
use serde_json::Value;

/// 服务端配置文件（通常是 `<服务端数据目录>/config.json`）。
pub struct ServerConfigFile {
    path: PathBuf,
}

impl ServerConfigFile {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读原始配置。**文件不存在**（还没起过服务端）→ 返回一份默认配置。
    ///
    /// ⚠️ 不存在**不是错误**：第一次运行就是这样，而用户要的是一个能编辑的表单，
    /// 不是一句「文件不存在」。⚠️ 但**坏掉的 JSON 是错误**：那时候原样报错、
    /// **绝不**悄悄换成默认值 —— 那等于把用户配过的东西全清掉。
    ///
    /// ⚠️ 报错是 [`Msg`]（键 + 参数）：这几句会走到界面上（就是这个编辑页），
    /// 所以不能是写死的中文（理由见 [`crate::commands`] 的模块文档）。
    /// ⚠️ 而 `serde_json` 那句**原文**是**参数**进去的（`reason`）—— 它是**外来文本**，
    /// 我们不翻、也翻不了（`Msg::verbatim` 那一条说的就是这件事）。
    pub fn read(&self) -> Result<Value, Msg> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return serde_json::to_value(Config::default())
                    .map_err(|reason| Msg::key("configSerializeFailed").param("reason", reason));
            }
            Err(reason) => {
                return Err(Msg::key("serverConfigUnreadable")
                    .param("path", self.path.display())
                    .param("reason", reason));
            }
        };
        serde_json::from_str::<Value>(&raw).map_err(|reason| {
            Msg::key("serverConfigBroken")
                .param("path", self.path.display())
                .param("reason", reason)
        })
    }

    /// 把补丁打上去 → **校验** → 原子写回。返回写回后的完整配置。
    ///
    /// ⚠️ 补丁是**深合并**（对象逐层合、其余整体替换）：界面上只改一个字段时，
    /// 不该把它所在的整个对象换掉 —— 那会顺手删掉同层的其它字段。
    ///
    /// ⚠️★ 校验不过就**不写**（返回错误，磁盘上的文件一个字节都不动）。
    /// 服务端解析不了配置就**拒绝启动**，所以「写进去一个它读不了的配置」
    /// 等于把用户的服务端弄停 —— 那比「保存失败」严重得多。
    pub fn patch(&self, patch: &Value) -> Result<Value, Msg> {
        let mut merged = self.read()?;
        merge_into(&mut merged, patch);

        // ⚠️ 用**服务端自己那个类型**校验（`clip9-core`），不是这里另写一套规则。
        let parsed = serde_json::from_value::<Config>(merged.clone())
            .map_err(|reason| Msg::key("serverConfigInvalid").param("reason", reason))?;

        // ⚠️★ 「解析得了」≠「配得对」。`text.limit` 是 `i64`，所以 16 MiB 也能解析 ——
        // 而配得比 `TEXT_LIMIT_MAX` 大，那一截正文**在 HTTP 层就被框架拒了**，
        // 报错还不是契约形状。用户拿到的是「我明明把上限调到了 16 MiB」，
        // 真相是「8 MiB 以上一律以另一种方式失败」——**配了不生效**，
        // 而这个项目为这一类问题付过好几次代价（见 `TEXT_LIMIT_MAX` 的注释）。
        //
        // ⚠️ 判的是**合并后**的整份配置，不是这次补丁：只改房间凭据的那次保存
        // 同样要能发现「文件里早就躺着一个不可达的上限」——否则它会一直躺在那儿，
        // 而界面每次都画出一个假的、更大的数字。
        //
        // ⚠️★ 三个数**都要递过去**（填的那个值 / 能生效的最大值 / 最大值是多少 MiB）——
        // 「最大值」那句是**算出来的**（`TEXT_LIMIT_MAX / 1 MiB`），在 Rust 里算、
        // 在字典里组装：两句句子的形状（`{} 字节` / `{} MiB`）是由语言定的，
        // 而这个数本身与语言无关（数字不翻）。
        if !parsed.text.is_effective() {
            return Err(Msg::key("textLimitUnreachable")
                .param("limit", parsed.text.limit)
                .param("max", clip9_core::config::TEXT_LIMIT_MAX)
                .param("mib", clip9_core::config::TEXT_LIMIT_MAX / (1024 * 1024)));
        }

        let text = serde_json::to_string_pretty(&merged)
            .map_err(|reason| Msg::key("configSerializeFailed").param("reason", reason))?;
        write_atomically(&self.path, format!("{text}\n").as_bytes())?;
        Ok(merged)
    }
}

/// 深合并：对象逐层合，其余（标量 / 数组）**整体替换**。
///
/// ⚠️★ `null` 表示**删掉这个键**（JSON Merge Patch / RFC 7396）。
/// 没有这条的话「删掉一个房间的凭据」做不到 —— 深合并只会把新键并进去、旧键永远留着，
/// 而**界面看起来已经删掉了**（用户点了删、保存成功、下次打开它又回来了）。
/// 那是「配了不生效」的反向版本：**看起来生效了，其实没有**。
///
/// ⚠️ 数组是**整体替换**而不是拼接：这个配置里的数组只有 `host` 那种「地址列表」，
/// 用户改它就是想换一份，不是想追加。
fn merge_into(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    target.remove(key);
                } else {
                    merge_into(target.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

/// **原子写**：临时文件 + rename。
///
/// ⚠️ 与 `store.rs` 里那个（写客户端配置的）同一个形状、同一个理由：
/// 写坏了 = 用户下次起不来服务端，而界面画得再对也救不回来。
/// ⚠️ 临时名带进程 id：两个进程同时保存时不会互相踩掉对方的临时文件。
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), Msg> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|reason| {
            Msg::key("configDirCreateFailed")
                .param("path", parent.display())
                .param("reason", reason)
        })?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|reason| {
        Msg::key("configTempWriteFailed")
            .param("path", tmp.display())
            .param("reason", reason)
    })?;
    // ⚠️ `rename` 在同一个文件系统内是原子的 —— 这正是「临时文件与目标同目录」的意义。
    std::fs::rename(&tmp, path).map_err(|reason| {
        Msg::key("configRenameFailed")
            .param("from", tmp.display())
            .param("to", path.display())
            .param("reason", reason)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_in(dir: &Path) -> ServerConfigFile {
        ServerConfigFile::new(dir.join("config.json"))
    }

    /// 取一个字符串参数 —— ⚠️ 这条测试模块里的断言**只钉键与参数**，不钉句子：
    /// 那些句子现在住在 `ui/i18n.js` 的两个字典里（判据 14/17 盯着它们），
    /// 改文案不该让服务端这边的测试红（与 `store` / `client` 同一条规矩）。
    fn param(msg: &Msg, name: &str) -> String {
        msg.params
            .get(name)
            .and_then(clip9_client::ParamValue::as_str)
            .unwrap_or_else(|| panic!("参数 {name} 该是个字符串：{msg:?}"))
            .to_owned()
    }

    /// 文件不存在 → 给一份**默认**配置（不是报错）：第一次运行就是这样，
    /// 而用户要的是一个能编辑的表单。
    #[test]
    fn a_missing_file_reads_as_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let value = file_in(dir.path()).read().expect("读默认");
        assert_eq!(value["server"]["port"], 9501, "服务端的默认端口");
        assert!(
            !dir.path().join("config.json").exists(),
            "**读**不该顺手把文件写出来（那是保存才做的事）"
        );
    }

    /// ⚠️★ 坏掉的 JSON **必须报错**，而且**不许**把它换成默认值 ——
    /// 那等于把用户配过的东西全清掉，而他只会看到「怎么连不上了」。
    #[test]
    fn a_broken_file_is_reported_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{ 这不是 JSON").unwrap();

        let err = file_in(dir.path()).read().unwrap_err();
        assert_eq!(err.key, "serverConfigBroken", "坏 JSON 要报这一条：{err:?}");
        assert!(
            param(&err, "path").ends_with("config.json"),
            "要说清是哪个文件：{err:?}"
        );
        // ⚠️ `serde_json` 那句原文是**外来文本**，它作为参数原样带出来（不翻）。
        assert!(
            !param(&err, "reason").is_empty(),
            "要带上解析器说的话：{err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ 这不是 JSON",
            "坏文件不能被覆盖"
        );
    }

    /// 补丁是**深合并**：只改 `server.port` 时，同层的别的字段要留着。
    #[test]
    fn patching_one_field_keeps_its_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"server":{"port":9501,"prefix":"/clip","roomList":true}}"#,
        )
        .unwrap();

        let patch = serde_json::json!({"server": {"port": 9600}});
        let merged = file_in(dir.path()).patch(&patch).expect("打补丁");
        assert_eq!(merged["server"]["port"], 9600);
        assert_eq!(merged["server"]["prefix"], "/clip", "同层的字段要留着");
        assert_eq!(merged["server"]["roomList"], true, "同层的字段要留着");

        // 磁盘上也是这个结果。
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["server"]["port"], 9600);
    }

    /// ⚠️★ **不认识的键必须留着** —— 这是「读成结构体再写回去」那个坑的反面。
    /// 丢掉它们的表现是「升级一次之后，用户配的东西少了几项」，而**没有任何报错**。
    #[test]
    fn unknown_keys_survive_a_patch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"server":{"port":9501},"某个将来才有的段":{"x":1},"server_note":"我留的"}"#,
        )
        .unwrap();

        let merged = file_in(dir.path())
            .patch(&serde_json::json!({"server": {"port": 9600}}))
            .expect("打补丁");
        assert_eq!(merged["某个将来才有的段"]["x"], 1, "不认识的段要留着");
        assert_eq!(merged["server_note"], "我留的", "不认识的键要留着");
    }

    /// ⚠️★ 校验不过就**不写**：服务端解析不了配置就拒绝启动，
    /// 所以「写进去一个它读不了的配置」等于把用户的服务端弄停。
    #[test]
    fn an_invalid_patch_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = r#"{"server":{"port":9501}}"#;
        std::fs::write(&path, original).unwrap();

        // 端口是 u16 —— 一个字符串它读不了。
        let err = file_in(dir.path())
            .patch(&serde_json::json!({"server": {"port": "不是数字"}}))
            .expect_err("该拒绝");
        assert_eq!(
            err.key, "serverConfigInvalid",
            "要说清为什么没保存：{err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "被拒绝时磁盘上不该有任何变化"
        );
    }

    /// ⚠️★ **解析得了 ≠ 配得对**：`text.limit` 是 `i64`，所以 16 MiB 能解析、能写盘、
    /// 服务端也会照它启动 —— 只是**8 MiB 以上那部分永远到不了我们的检查**
    /// （HTTP 层的绝对上限先拒，而且报错不是契约形状）。
    /// 放它过去等于让用户以为「上限调大了」，其实只是换了一种失败方式。
    #[test]
    fn a_text_limit_the_server_cannot_reach_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = r#"{"server":{"port":9501}}"#;
        std::fs::write(&path, original).unwrap();

        let too_big = clip9_core::config::TEXT_LIMIT_MAX + 1;
        let err = file_in(dir.path())
            .patch(&serde_json::json!({"text": {"limit": too_big}}))
            .expect_err("该拒绝");
        assert_eq!(err.key, "textLimitUnreachable", "{err:?}");
        assert_eq!(
            param(&err, "limit"),
            too_big.to_string(),
            "要说清是哪个值不行：{err:?}"
        );
        assert_eq!(
            param(&err, "max"),
            clip9_core::config::TEXT_LIMIT_MAX.to_string(),
            "要给一个能用的最大值（否则用户只能猜）：{err:?}"
        );
        assert_eq!(
            param(&err, "mib"),
            (clip9_core::config::TEXT_LIMIT_MAX / (1024 * 1024)).to_string(),
            "还要说清它合多少 MiB（句子形状由字典定，数字由这里算）：{err:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            original,
            "被拒绝时磁盘上不该有任何变化"
        );
    }

    /// 边界与两个合法值：上限本身、`0`（= 不限）、缺省。
    #[test]
    fn a_text_limit_at_or_below_the_ceiling_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        for limit in [
            clip9_core::config::TEXT_LIMIT_MAX,
            4096,
            0, // ⚠️ `0` = **不限**，是合法值（别当成「没设」）
        ] {
            let merged = file_in(dir.path())
                .patch(&serde_json::json!({"text": {"limit": limit}}))
                .unwrap_or_else(|err| panic!("{limit} 该被接受：{err:?}"));
            assert_eq!(merged["text"]["limit"], limit);
        }
    }

    /// ⚠️★ 判的是**合并后的整份配置**，不是这次补丁 —— 文件里早就躺着一个不可达的上限时，
    /// 改别的字段的那次保存也要拦住它。否则它会一直躺着，而界面每次都画出一个假的、更大的数字
    /// （用户只会觉得「我配的明明生效了」）。
    #[test]
    fn a_stale_unreachable_limit_is_caught_even_when_patching_something_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            format!(
                r#"{{"server":{{"port":9501}},"text":{{"limit":{}}}}}"#,
                clip9_core::config::TEXT_LIMIT_MAX + 1
            ),
        )
        .unwrap();

        let err = file_in(dir.path())
            .patch(&serde_json::json!({"server": {"port": 9600}}))
            .expect_err("改端口也得先把这个不可达的值报出来");
        assert_eq!(err.key, "textLimitUnreachable", "{err:?}");
    }

    /// ⚠️★ **`null` 是「删掉这个键」**（RFC 7396）。界面上「删掉一个房间的凭据」
    /// 走的就是这条 —— 没有它，删完保存成功、下次打开它又回来了
    ///（深合并只往并里加，不会移除），而用户会以为界面骗他。
    #[test]
    fn a_null_in_the_patch_removes_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"server":{"roomAuth":{"work":{"password":"a"},"home":{"password":"b"}}}}"#,
        )
        .unwrap();

        let merged = file_in(dir.path())
            .patch(&serde_json::json!({"server": {"roomAuth": {"work": null}}}))
            .expect("删一个房间的凭据");
        assert!(
            merged["server"]["roomAuth"].get("work").is_none(),
            "work 那条该被删掉：{}",
            merged["server"]["roomAuth"]
        );
        assert_eq!(
            merged["server"]["roomAuth"]["home"]["password"], "b",
            "别的房间不许受影响"
        );
    }

    /// 原子写：写完没有临时文件残留。
    #[test]
    fn saving_is_atomic_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        write_atomically(&path, b"{}").expect("原子写");

        let leftovers: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该有临时文件残留：{leftovers:?}");
    }
}
