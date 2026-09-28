//! 数据目录 → 实际路径 → 打开库。
//!
//! 两个层次：[`resolve_into`] / [`resolve_against`] 是**纯解析**（无 IO，好测），
//! [`open_store`] 是「照解析结果把目录建出来并打开库」——**「我要开始用这个数据目录了」
//! 的唯一入口**，`bin` 与 `crates/android` 都走它。
//!
//! ⚠️★ 这份语义是 **Jonny 2026-09-25 拍的板**，而且与 Go **不一样**，别改回去：
//! **相对路径相对「数据目录」，不是相对 cwd。**
//!
//! 理由：服务端可能从任何地方启动（systemd / Docker / OpenWrt procd / Android 前台服务），
//! **cwd 没人能预测** —— 同一份配置在不同启动方式下会落到不同地方，
//! 而症状是「**上传的文件重启后找不到了**」（文件写在一个 cwd 下的 `uploads/`，
//! 重启后 cwd 变了，于是一份都找不到）。数据目录是**显式给**的，相对它解析唯一且可预测。
//!
//! ⚠️★ 为什么这一段也要提到 lib（2026-09-28）：Android 那侧同样要把
//! 「`context.filesDir` + 配置里的相对路径」算成实际路径。重写一遍就会漂，
//! 而漂的后果是这个文件里最要紧的那条语义（相对谁解析）在其中一处失效。
//!
//! ⚠️ **还有一份 Lua 的同类实现**（`openwrt/luci-app-clip9/luasrc/controller/clip9.lua`
//! 的 `resolve_db_path()`）—— 那是「清空历史」要自己找到库文件才写的，
//! 两边的规则必须一致（那边也注释了「与服务端 `resolve_against` 同一套」）。

use std::path::{Path, PathBuf};

use clip9_core::Config;
use clip9_store::{Limits, Store};

/// 一个部署实际用的两个路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// redb 库文件。
    pub db: PathBuf,
    /// 上传文件目录。
    pub uploads: PathBuf,
}

/// 把一个数据目录**变成能用的东西**：建目录 → 解析路径 → 开库。
///
/// 这是「我要开始用这个数据目录了」的**唯一**入口（`bin` 与 `crates/android` 共用）。
///
/// ⚠️★ 这件事必须只有一处实现，因为里面有一半是**看不见的**：
/// 目录不建出来不会在别处报错，只会在**第一次真的写文件**时炸。已经踩过一次 ——
/// 照着 `bin` 抄这一段的 `crates/android` 抄漏了 `create_dir_all(uploads)`，
/// 结果是「库开得起来、消息发得出去、只有**上传文件** 500」，
/// 而失败点（`/upload` 里的写文件）离「抄漏了一行」隔着整个 handler。
///
/// ⚠️ 顺序是有意的：**先建目录再开库**（redb 自己会建父目录？不保证 —— 它只建文件），
/// 而 `uploads` 建在开库之后，因为「库打不开」是更早、更致命的一档，
/// 那时候没必要先去动文件系统。
pub fn open_store(data_dir: &Path, config: &mut Config) -> anyhow::Result<(Paths, Store)> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| anyhow::anyhow!("无法创建数据目录 {}：{e}", data_dir.display()))?;

    let paths = resolve_into(data_dir, config);

    if let Some(parent) = paths.db.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow::anyhow!("无法创建库文件所在目录 {}：{e}", parent.display()))?;
    }
    let store = Store::open_with(&paths.db, Limits::default())
        .map_err(|e| anyhow::anyhow!("打不开数据库 {}：{e}", paths.db.display()))?;

    std::fs::create_dir_all(&paths.uploads)
        .map_err(|e| anyhow::anyhow!("无法创建文件存储目录 {}：{e}", paths.uploads.display()))?;

    Ok((paths, store))
}

/// 把 data 目录与配置算出实际路径，并**写回 config**。
///
/// ⚠️ 写回去的是**解析后的实际路径**（不是配置里那个原样的相对路径）——
/// 后面再有谁读它，看到的与日志里打的一致。上一版写回的是未解析的值，
/// 于是「配置里显示 `uploads`、日志里显示 `/data/uploads`」对不上，那是个坑。
pub fn resolve_into(data_dir: &Path, config: &mut Config) -> Paths {
    let db = resolve_against(data_dir, &config.server.db_path, "clip9.redb");
    let uploads = resolve_against(data_dir, &config.server.storage_dir, "uploads");

    config.server.db_path = db.to_string_lossy().into_owned();
    config.server.storage_dir = uploads.to_string_lossy().into_owned();

    Paths { db, uploads }
}

/// 把配置里那个路径解析成实际路径。
///
/// - **绝对路径** → 原样（数据目录不再影响它；这是「我就是要放这儿」的表达）；
/// - **相对路径** → 相对**数据目录**；
/// - **空串** → 用 `default_name`（免得显式写了 `""` 时把库落到目录本身）。
pub fn resolve_against(data_dir: &Path, configured: &str, default_name: &str) -> PathBuf {
    let configured = configured.trim();
    let configured = if configured.is_empty() {
        default_name
    } else {
        configured
    };
    let path = PathBuf::from(configured);
    if path.is_absolute() {
        path
    } else {
        data_dir.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 绝对路径**原样** —— 数据目录不该把它拽回来。
    #[test]
    fn an_absolute_path_is_left_alone() {
        assert_eq!(
            resolve_against(Path::new("/data"), "/srv/clip9/other.redb", "clip9.redb"),
            PathBuf::from("/srv/clip9/other.redb")
        );
    }

    /// 相对路径**相对数据目录**（不是 cwd）—— 这条就是那个拍板。
    #[test]
    fn a_relative_path_hangs_off_the_data_directory() {
        assert_eq!(
            resolve_against(Path::new("/data"), "sub/x.redb", "clip9.redb"),
            PathBuf::from("/data/sub/x.redb")
        );
    }

    /// 空串（含只有空白）用默认名 —— 免得把库文件落到**目录本身**上。
    #[test]
    fn an_empty_path_falls_back_to_the_default_name() {
        assert_eq!(
            resolve_against(Path::new("/data"), "", "clip9.redb"),
            PathBuf::from("/data/clip9.redb")
        );
        assert_eq!(
            resolve_against(Path::new("/data"), "   ", "uploads"),
            PathBuf::from("/data/uploads")
        );
    }

    /// 写回配置的是**解析后**的路径（否则配置与日志对不上）。
    #[test]
    fn resolving_writes_the_actual_paths_back_into_the_config() {
        let mut config = Config::default();
        config.server.db_path = "custom.redb".to_owned();
        config.server.storage_dir = String::new();

        let paths = resolve_into(Path::new("/data"), &mut config);

        assert_eq!(paths.db, PathBuf::from("/data/custom.redb"));
        assert_eq!(paths.uploads, PathBuf::from("/data/uploads"));
        assert_eq!(config.server.db_path, "/data/custom.redb");
        assert_eq!(config.server.storage_dir, "/data/uploads");
    }

    /// `open_store` 要把**它以后会往里写**的目录都建出来 —— 尤其是 `uploads/`。
    ///
    /// ⚠️★ 这一条钉的是一个**完全不报错**的错法：不建 `uploads/` 时，库照样打得开、
    /// 消息照样发得出去，只有**上传文件**会在写盘那一刻 500（`files.rs` 的写文件路径
    /// 不会自己建目录）。`crates/android` 抄 `bin` 那段时正是漏了这一行。
    #[test]
    fn opening_a_store_creates_the_directories_it_will_write_into() {
        let root = tempfile::tempdir().expect("临时目录");
        // ⚠️ 故意让它**不存在** —— 要验的正是「它被建出来」。
        let data_dir = root.path().join("data");
        let mut config = Config::default();

        let (paths, _store) = open_store(&data_dir, &mut config).expect("开库");

        assert!(
            paths.db.is_file(),
            "库文件 {} 应当被建出来",
            paths.db.display()
        );
        assert!(
            paths.uploads.is_dir(),
            "上传目录 {} 应当被建出来",
            paths.uploads.display()
        );
        // 解析后的路径写回了 config —— 否则「配置里是相对路径、日志里是绝对路径」对不上。
        assert_eq!(config.server.db_path, paths.db.to_string_lossy());
        assert_eq!(config.server.storage_dir, paths.uploads.to_string_lossy());
    }

    /// 库文件被指到**数据目录之外**（绝对路径）时，它的父目录也要建出来。
    ///
    /// ⚠️ 那一层目录往往也不存在（`-dbpath /mnt/usb/clip9/x.redb`），
    /// 少了它 redb 会以「打不开库」失败 —— 而那个错看起来像权限问题。
    #[test]
    fn opening_a_store_creates_the_parent_of_an_absolute_db_path() {
        let root = tempfile::tempdir().expect("临时目录");
        let data_dir = root.path().join("data");
        let db = root.path().join("elsewhere/nested/clip9.redb");

        let mut config = Config::default();
        config.server.db_path = db.to_string_lossy().into_owned();

        let (paths, _store) = open_store(&data_dir, &mut config).expect("开库");

        assert_eq!(paths.db, db);
        assert!(paths.db.is_file(), "库文件 {} 应当被建出来", db.display());
        assert!(
            data_dir.is_dir(),
            "数据目录也该被建出来（uploads 挂在它下面）"
        );
    }
}
