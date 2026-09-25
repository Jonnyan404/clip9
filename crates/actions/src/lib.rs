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
//! ⚠️ 除了上面那几条「实现能力本来就不同」的，还有一类是**同一串正则、不同引擎**造成的：
//! `\d` / `\b` / `\s` 在 Go（RE2）、前端（JS）与 `regex` crate 里的语义并不相同，
//! 而三处用的又是**同一串 source**。取舍逐条写在 `actions/text.rs` 的模块文档里；
//! 一句话是：**`\d` 与 `\b` 按 ASCII（三方一致），`\s` 跟前端**。
//!
//! ⚠️ 与 Go 的差异里还有两处是「这边更严格」的（Go 是那个宽松的，不是这边少做了什么）：
//! `text.upper/lower` 走**完整**大小写映射（`straße` → `STRASSE`，Go 是 `STRAßE`），
//! 日期解析对时分秒越界直接报错（Go 会归一化成 `02:39`）。两条都写在 `text.rs` / `date.rs`。
//!
//! # 现状
//!
//! 服务端动作（**定时任务能用的那 34 个**）**全部实现完**：`format` 2 / `text` 13 / `date` 2 /
//! `encode` 10 / `zh` 4 / `inspect` 3。`not_yet_implemented()` 现在是空的，机制留着。
//!
//! ⚠️ **这张表的范围是「定时任务能用的动作」，不是「全部动作」** —— 这一点在 2026-09-25
//! 被明确过（早先按 §5.3.1 写成「目标是全部动作」，那条作废了）：
//!
//! - `generate.*`（uuid / time / datetime）**不进**：它们是「生成」，放进链里会把正文整个丢掉。
//!   要那个效果就用模板变量（`{{uuid}}` / `{{time}}` / `{{datetime}}`），内联、不覆盖正文。
//! - 预览区专用的 9 个（`format.markdown` / `format.code` / `zh.pinyin*` / `zh.simplified` /
//!   `zh.traditional` / `inspect.stats` / `inspect.detect`）**不进**：它们的行为**就是前端那几个
//!   JS 库**，换成 Rust crate 是另一份实现、输出必然不同。完整理由见 [`registry`] 的模块文档
//!   与 `ARCHITECTURE.md` §5.3.1 的修订。
//!
//! 代价是**界面上必须说清楚**（页面那条 `actionScopeHint` 常驻说明就是干这个的）。

pub mod actions;
pub mod error;
pub mod offset;
pub mod registry;

pub use error::ActionError;
pub use registry::{
    ActionContext, ActionMeta, ChainStep, ParamCondition, ParamKind, ParamOption, ParamSpec,
    all_meta, group_enabled, is_implemented, meta, not_yet_implemented, run, run_chain,
};

/// 日期偏移的**唯一**实现（`date.add` 与 `core` 的模板引擎共用，见 [`offset::DateOffset`]）。
///
/// ⚠️ **不随 `date` feature 裁剪**：它是纯逻辑基础工具（几 KB），动作库与模板引擎都要用。
/// 它被 feature gate 的后果是「裁剪动作分组」会连带弄坏 `core` 的模板引擎 —— 那种耦合
/// 是错的（见 `offset` 模块文档）。
pub use offset::{DateOffset, DateUnit};
