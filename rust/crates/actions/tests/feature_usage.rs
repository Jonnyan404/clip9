//! 门禁：`Cargo.toml` 里**声明的每个 feature 都必须有人用**。
//!
//! 为什么要有它：feature 的**声明**没有任何编译器检查 —— 声明了却没人引用的 feature
//! 编得过、测试全绿、`--all-features` 也编得过，**零症状**。
//!
//! ⚠️★ 2026-10-13 清掉的两个（`markdown` / `highlight`）就是这么躺了很久：它们是设计初稿
//! 里「把 markdown 渲染、代码高亮下沉到 Rust」留下的占位（`dev-docs/ARCHITECTURE.md` §5.3.1
//! 那张 `[features]` 表），而那个计划**被明确否掉了** —— `format.markdown` / `format.code`
//! 等 9 个动作留在前端，因为它们在前端**就是那几个 JS 库**，换 Rust crate 是**另一份实现**、
//! 输出必然不同（而「同一份动作库」的地基正是「同一个输入 → 同一个输出」）。
//! 占位没人删，`doc` 的注释还写着「判据同 `highlight`」—— 读代码的人会以为后端真有一条高亮能力。
//!
//! 判据：`[features]` 里每个键（`default` 除外）都必须满足**两者之一**：
//!   ① 在 `src/**.rs` 里被引用（`feature = "名字"` —— `#[cfg]` 与 `cfg!` 两种写法都命中）；
//!   ② 出现在**另一个 feature 的值里**（有的 feature 只是把别的 feature 打包，自己不直接 cfg）。
//! 两条都不满足 = 死 feature，报红。
//!
//! ⚠️ 红线：**别拿「留给以后」当借口留着它**。要留就写进 issue / 注释，别留一行沉默的声明 ——
//! 下一个读 `Cargo.toml` 的人会把它当成现状（这次就是这么被误导的）。
//!
//! 运行（在仓库根，或 `cd rust`）：
//!
//! ```bash
//! cargo test -p clip9-actions
//! ```

use std::fs;
use std::path::{Path, PathBuf};

/// `src/` 下至少这么多 `.rs` —— 少于它说明**没扫到源码**（不是「干净」），判据要红。
const MIN_SOURCE_FILES: usize = 5;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `[features]` 里的每条 `名字 = 值`（`default`、注释、空行都跳过）。
///
/// ⚠️ 只认单行写法（本仓库的 feature 都是单行）。多行数组最多漏掉**值**，不会漏掉**名字**，
/// 而判据主要靠「名字有没有被源码引用」，所以够用。
fn declared_features(manifest: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut in_features = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_features = line == "[features]";
            continue;
        }
        if !in_features || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((name, value)) = line.split_once('=') {
            let name = name.trim();
            if !name.is_empty() && name != "default" {
                out.push((name.to_string(), value.trim().to_string()));
            }
        }
    }
    out
}

/// 把 `dir` 下所有 `.rs` 的源码拼进 `out`，并把文件数累加进 `files`。
fn read_sources(dir: &Path, out: &mut String, files: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            read_sources(&path, out, files);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            *files += 1;
            out.push_str(&fs::read_to_string(&path).unwrap_or_default());
            out.push('\n');
        }
    }
}

#[test]
fn every_declared_feature_is_used() {
    let manifest_path = crate_dir().join("Cargo.toml");
    let manifest = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("读不到 {}：{e}", manifest_path.display()));

    let declared = declared_features(&manifest);
    assert!(
        !declared.is_empty(),
        "`[features]` 里一个 feature 都没解析出来 —— 这个判据的解析器坏了（别报绿）"
    );

    let mut sources = String::new();
    let mut files = 0usize;
    read_sources(&crate_dir().join("src"), &mut sources, &mut files);
    // ⚠️ 没有这个下限的话，「源码一个都没读到」会让下面的循环**什么都判不出来**、还是全绿。
    assert!(
        files >= MIN_SOURCE_FILES,
        "只扫到 {files} 个 .rs（至少应有 {MIN_SOURCE_FILES}）—— 没扫到源码时这个判据会「全绿」，所以这里必须红"
    );

    let mut values = String::new();
    for (_, value) in &declared {
        values.push_str(value);
        values.push('\n');
    }

    let mut dead = Vec::new();
    for (name, _) in &declared {
        let used_by_source = sources.contains(&format!("feature = \"{name}\""));
        let used_by_feature =
            values.contains(&format!("\"{name}\"")) || values.contains(&format!("dep:{name}"));
        if !used_by_source && !used_by_feature {
            dead.push(name.as_str());
        }
    }

    assert!(
        dead.is_empty(),
        "这些 feature 声明了却**没人用**：{dead:?}\n\
         → 要么接上实现（源码里出现 `feature = \"名字\"`），要么删掉这行声明。\n\
         ⚠️ 别拿「留给以后」当借口 —— 下一个读 Cargo.toml 的人会把它当成现状。"
    );
}
