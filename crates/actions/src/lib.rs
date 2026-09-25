//! clip9 单一动作库。
//!
//! ⚠️ 这个 crate 是「**一份实现、编译两次**」的那个「一份」：
//! 原生编给服务端（定时任务用），`wasm32-unknown-unknown` 编给前端（预览用）。
//!
//! 所以它必须**纯函数、无 IO、无浏览器依赖**。
//! 一旦有人往这里加 `std::fs` 或 `web_sys`，两边就编不到一起了 ——
//! 那正是这个 crate 存在的意义被破坏的时刻。
//!
//! # 为什么不照抄 Go 的那份
//!
//! Go 侧有一份「服务端可下沉子集」（`render_actions.go`，34 个动作），前端
//! `data/actions.js` 另有一份 45 个动作的实现 —— 两套实现靠一条**只验 id、验不了行为**的
//! 契约测试勉强对齐。`ARCHITECTURE.md` §5.3 记着的代价（「加一个动作要改两处」「同一个动作
//! 可能给出两个结果」）就是这么来的。
//!
//! Rust 侧没有这个约束：一份代码 → 原生 + WASM。所以这里**不再分「可下沉」与「只在客户端」**，
//! 分界线只剩体积（大件用 feature 关，见 `Cargo.toml`）。
//!
//! ⚠️ 但**行为基准仍然是 Go**（`ARCHITECTURE.md` §5.4）：`cases/actions/*.json` 里的期望值
//! 是 Go **跑出来的**，不是人写的。`tests/go_cases.rs` 拿它逐条比对 —— 那才是双跑验证，
//! 而不是「读代码觉得一样」。
//!
//! # 契约：只给 key，不给译文
//!
//! [`ActionMeta::key`] / [`ParamSpec::label_key`] 是**前端 locale 文件里的 i18n key**，
//! 前端拿它去自己的文案表里取人话名字。**这里不下发译文** —— 译文只留一份（四份 locale），
//! 在 Rust 里再抄一份中文就多出一个迟早会漂开的副本。
//!
//! # 已知差异（刻意的，写在代码里而不是等它咬人）
//!
//! 与 Go / 前端**不完全一致**的地方，都就近写在对应动作的注释里，并且只冻结两边的公共部分：
//! 比如 `text.sort` 的**中文次序**（前端用 `localeCompare(b, 'zh')`，这里用字节序）、
//! `encode.html.decode` 的**罕见命名实体**（Go 有 2000+ 项的表）。与其做一个半吊子的替代品，
//! 不如把差异和理由写清楚 —— 这个项目对「两边悄悄不一样」的容忍度是零。
//!
//! # 现状
//!
//! 注册表**已经全了**（当前是 Go 侧那 34 项，理由与目标集合见 [`registry`] 的模块文档 ——
//! 一句话：**目标是全部动作，不是 Go 的子集**，先接这 34 项只是因为它们有现成的行为基准）。
//!
//! 动作实现分批落地：已经能跑的走 [`run`]，还没实现的在 [`not_yet_implemented`] 里
//! **显式列着**（测试拿它跟 `cases/actions/registry.json` 对账，所以「漏了一个」不会静默 ——
//! 少一个就红。那份清单的长度就是进度）。

pub mod actions;
pub mod error;
pub mod registry;

pub use error::ActionError;
pub use registry::{
    ActionContext, ActionMeta, ChainStep, ParamCondition, ParamKind, ParamOption, ParamSpec,
    all_meta, group_enabled, is_implemented, meta, not_yet_implemented, run, run_chain,
};
