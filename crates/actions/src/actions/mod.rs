//! 动作实现，按**注册表的 `group` 分模块**（一个分组一个文件）。
//!
//! 每个模块只暴露一个 `run`：`None` = 「这个 id 不归我管」，由 [`crate::registry::run`]
//! 顺着启用的分组往下问。这样加一组动作只动两处（新模块 + 注册表里那一串 cfg）。
//!
//! ⚠️ 这里的模块名与 `Cargo.toml` 的 feature 名**一一对应**（见 `registry::group_enabled`）。

#[cfg(feature = "encode")]
pub mod encode;
#[cfg(feature = "format")]
pub mod format;
#[cfg(feature = "inspect")]
pub mod inspect;
