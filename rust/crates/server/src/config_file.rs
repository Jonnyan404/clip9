//! 从文件读配置：**读不到就写一份默认的出来**。
//!
//! ⚠️★ 这里有三条语义，**别在别处重写**（`bin` 与 `crates/android` 都走这一个函数）：
//!
//! 1. 文件不在 → 写一份默认配置出来，然后**照常启动**。
//!    这一条同时给了两个东西：「零配置启动」和「一份可以照着改的模板」，
//!    与 Go 的 `load_config` 一致（Go 那边读不到就 `os.WriteFile` 一份 `defaultConfig()`）。
//!    Jonny 2026-09-25 要的就是这两样。
//! 2. 写不出来**不是**致命错误（只读挂载 / 容器里的只读层）—— 照样用默认值跑，
//!    但**要说出来**，否则用户以为配置已经保存了。
//! 3. **解析失败是致命错误**。这一条**刻意与 Go 不同**：Go 会打一行日志然后用默认值
//!    继续跑 —— 那意味着一个拼错的配置会让服务**不带密码**地起来，而用户以为自己配过了。
//!    「启动失败」比「静默降级」安全，这是这个项目一贯的取舍。
//!
//! ⚠️ `migrate` 子命令**故意不用这个函数**：它读不到配置时只取默认值、**不写文件** ——
//! 迁移是运维动作，顺手往 cwd 里写一个文件属于意外副作用，而且 `-dry-run` 的承诺是
//! 「什么都不写」。那是唯一一处有理由不同的地方。

use std::path::Path;

use clip9_core::Config;

/// 读配置；文件不在就写一份默认的出来，然后用默认值继续。
///
/// 返回的错误**只有一种**：文件在、但内容解析不了（见模块文档第 3 条）。
pub fn load_or_create(path: &Path) -> anyhow::Result<Config> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(read_err) => {
            let default = Config::default();
            match serde_json::to_string_pretty(&default) {
                Ok(text) => match std::fs::write(path, format!("{text}\n")) {
                    Ok(()) => tracing::info!(
                        path = %path.display(),
                        "配置文件不存在，已写入一份默认配置（照着改，改完重启生效）"
                    ),
                    Err(write_err) => tracing::warn!(
                        path = %path.display(),
                        error = %write_err,
                        "写默认配置失败，用内存里的默认值继续跑"
                    ),
                },
                Err(e) => tracing::warn!(error = %e, "序列化默认配置失败"),
            }
            tracing::info!(path = %path.display(), error = %read_err, "用默认配置启动");
            return Ok(default);
        }
    };

    serde_json::from_str::<Config>(&raw)
        .map_err(|e| anyhow::anyhow!("配置文件 {} 解析失败：{e}", path.display()))
}
