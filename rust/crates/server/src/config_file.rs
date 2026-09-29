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

use std::path::{Path, PathBuf};

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

/// 把配置写回文件 —— **原子**写（先写同目录的 `.tmp`，再 `rename`）。
///
/// ⚠️★ 别为了省事改成 `fs::write`：写到一半被杀（Android 上太常见了：低内存回收、
/// 用户划掉 App、更新换代）会留下**半截 JSON**，而 [`load_or_create`] 对解析失败是
/// **致命错误**（模块文档第 3 条）—— 于是「改配置改到一半手机没电」会变成
/// 「服务端再也起不来，界面上只有一句『配置文件解析失败』」，
/// 而那时候配置页自己也读不出配置了。同一个目录里的 `rename` 是原子的：
/// 要么是旧内容、要么是新内容，没有中间态。
///
/// ⚠️★ 调用方**必须**先过 [`clip9_core::Config::validate_for_save`]：
/// 这个函数只管「写进去」，不管「写进去的能不能用」。
///
/// ⚠️ 序列化出来的是**完整**配置（不是补丁）—— 所以界面上改了哪一项，
/// 落盘的都是整份，不存在「只存了差异、其余项丢了」这种可能。
pub fn save(path: &Path, config: &Config) -> anyhow::Result<()> {
    let text =
        serde_json::to_string_pretty(config).map_err(|e| anyhow::anyhow!("序列化配置失败：{e}"))?;

    // `config.json` → `config.json.tmp`（同目录，`rename` 才可能是原子的）。
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    std::fs::write(&tmp, format!("{text}\n"))
        .map_err(|e| anyhow::anyhow!("写 {} 失败：{e}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| anyhow::anyhow!("把 {} 改名为 {} 失败：{e}", tmp.display(), path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **写出去的东西必须读得回来**，而且是**逐字段相等**。
    ///
    /// ⚠️★ 这条不是「save 能用吗」那种冒烟 —— 它钉的是
    /// 「**写出去一份自己都读不进来的配置**」这件事。真发生的话症状是
    /// 「在界面上点了保存 → 重启 → 服务端报『配置文件解析失败』→ 再也起不来」，
    /// 而那时候配置页自己也读不出配置，用户**没有任何办法退回去**。
    #[test]
    fn a_saved_config_reads_back_field_for_field() {
        let dir = tempfile::tempdir().expect("建临时目录");
        let path = dir.path().join("config.json");

        // 故意把每一块都改得不等于默认值 —— 只改一块的话，
        // 「某一块的字段没写进去」会被默认值掩盖过去。
        let mut cfg = Config::default();
        cfg.server.port = 18081;
        cfg.server.prefix = "/clip9/".to_owned();
        cfg.server.history = 120;
        cfg.server.room_auth = clip9_core::config::RoomAuthConfig(
            [(
                "work".to_owned(),
                clip9_core::config::RoomAuthEntry {
                    password: "pw".to_owned(),
                    file_expire: Some(0),
                    open: true,
                    automation: "single".to_owned(),
                },
            )]
            .into_iter()
            .collect(),
        );
        cfg.text.limit = 8192;
        cfg.file.chunk = 2 * 1024 * 1024;
        cfg.automation.tick_seconds = 15;

        save(&path, &cfg).expect("写配置");

        // ⚠️ 临时文件**不能残留**：它和 config.json 只差一个后缀，
        // 留在那儿会让下一个人以为「有两个配置文件」。
        assert!(
            !dir.path().join("config.json.tmp").exists(),
            "写完不该留下 .tmp"
        );

        let back = load_or_create(&path).expect("读回来");
        assert_eq!(back, cfg, "写出去再读回来必须逐字段相等");
    }

    /// 文件**还不存在**时也要写得进去（首次配置就是这么产生的），
    /// 而且覆盖已有文件时不能报错。
    #[test]
    fn save_creates_the_file_and_overwrites_it() {
        let dir = tempfile::tempdir().expect("建临时目录");
        let path = dir.path().join("config.json");
        assert!(!path.exists(), "这个用例要从不存在的文件开始");

        let mut cfg = Config::default();
        cfg.server.port = 18082;
        save(&path, &cfg).expect("首次写");
        assert!(path.exists(), "首次写应当把文件建出来");

        cfg.server.port = 18083;
        save(&path, &cfg).expect("覆盖写");
        assert_eq!(
            load_or_create(&path).expect("读回来").server.port,
            18083,
            "第二次写要覆盖掉第一次的"
        );
    }

    /// 手写一份坏 JSON → `LoadOrCreate` 必须**报错**（不是静默回落到默认值）。
    ///
    /// ⚠️★ 这条看起来在测别人，其实是 [`save`] 的注释在依赖的那个前提：
    /// 「解析失败是致命错误」一旦被改成「打一行日志继续跑」，
    /// 半截文件就不再是灾难 —— 但那意味着**一个拼错的配置会让服务端不带密码地起来**。
    /// 两种取舍只能选一种，这里把当前这一种钉住。
    #[test]
    fn a_broken_file_is_a_fatal_error_and_save_can_still_repair_it() {
        let dir = tempfile::tempdir().expect("建临时目录");
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{\"server\": {\"port\"").expect("写坏文件");

        assert!(
            load_or_create(&path).is_err(),
            "坏配置必须是致命错误 —— 静默回落会让服务端不带密码地起来"
        );

        // ⚠️ 而 save 是**修复**那条路：它不看旧内容，直接整份盖掉。
        // 所以「配置文件坏了」在界面上要有出路（保存一次即可），这条钉住那个出路存在。
        save(&path, &Config::default()).expect("坏文件也要能被盖掉");
        assert!(load_or_create(&path).is_ok(), "盖完之后应当读得回来");
    }
}
