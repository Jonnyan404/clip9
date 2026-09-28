//! 定时任务的正文模板 —— 把「写死在正文里的日期」换成触发那一刻才算的变量。
//!
//! # 为什么需要这一层
//!
//! 定时任务的正文里必须有「会变的部分」。用户写的是「明天是几号、周几」，
//! 而「明天」只有在触发那一刻才知道。所以正文存成模板，求值推迟到投递前 ——
//! 也正因为如此，任务定义里**不能**存一段代码或一次求值结果。
//!
//! # ⚠️ 求值基准是「预定触发时刻」，不是「实际发送时刻」
//!
//! 服务重启 / 机器合盖导致的补发，正文里写的仍然是那个「本该发出的时刻」——
//! 用户写 `{{date:+1d}}` 指的是那一天的明天，补发时换成 now 会得到一条内容不对
//! 但看起来正常的消息。差异靠消息上的 `late` 标记体现。
//!
//! # ⚠️ 偏移量挂在**变量自己**身上，而不是共享一个「今天」
//!
//! `{{date:+1d}}` 和 `{{weekday:+1d}}` 各自偏移。原因是实际：用户写
//! 「明天是几号、明天是周几」，如果周几取的是今天，文案会自相矛盾，
//! 而且这种错很难一眼看出来。所以每个变量独立求值（各有各的基准）。
//!
//! # 语义：求值要么全成功、要么整体失败
//!
//! 任一变量求不出值就整体失败，**不返回「替换了一半」的正文**。静默放过未知变量
//! 会得到一条带着 `{{dtae}}` 原样发进房间的消息 —— 用户只有在读到自己房间里的乱码时
//! 才知道写错了，而那是几小时之后的事。
//!
//! # 纯引擎 + 注入的「来源读取器」
//!
//! [`RenderContext::latest`] 是唯一会读外部状态的变量（取某房间最新一条**人发的**文本）。
//! 引擎本身仍是纯的：读消息队列这件事由调用方注入（服务端侧见 `automation_source.go` 的
//! 对应实现）。`latest` 为 `None` 时用 `{{latest}}` 会报错 —— 宁可报错也不要静默留下空替换。
//!
//! 验证基准仍是 Go（`render.go`），fixture 在 `cases/render/render.json` ——
//! 那份是**冻结的输入**（拆库时从 Go 实现那边带过来的，这边不再重新生成）：
//!
//! ```bash
//! cd <Go 仓库>/cloud-clip && UPDATE_FIXTURES=1 go test ./lib -run TestRenderFixtures
//! cargo test -p clip9-core --test go_render   # 回到本仓库根跑这个
//! ```

use std::sync::LazyLock;

use chrono::{DateTime, Datelike, FixedOffset};
use clip9_actions::DateOffset;
use clip9_protocol::normalize_room_name;
use regex::Regex;
use uuid::Uuid;

// ── 变量名 ────────────────────────────────────────────────────────────

const VAR_DATE: &str = "date"; // 2026-09-25
const VAR_WEEKDAY: &str = "weekday"; // 周五 / 五 / Friday / Fri
const VAR_TIME: &str = "time"; // 09:30
const VAR_DATETIME: &str = "datetime"; // 2026-09-25 09:30
const VAR_TIMESTAMP: &str = "timestamp"; // 1758760200
const VAR_UUID: &str = "uuid";
const VAR_TASK: &str = "task"; // 任务名（便于一条正文被多个任务复用）
const VAR_ROOM: &str = "room";
const VAR_LATEST: &str = "latest"; // {{latest}} / {{latest:房间名}}

/// 所有可用变量名（**不含参数**），顺序稳定。
///
/// 给 `/server` 下发、给管理页渲染变量胶囊用。⚠️ 顺序是契约的一部分：
/// 界面按这个顺序渲染，改动会挪动胶囊的位置。
pub fn variable_names() -> &'static [&'static str] {
    &[
        VAR_DATE,
        VAR_WEEKDAY,
        VAR_TIME,
        VAR_DATETIME,
        VAR_TIMESTAMP,
        VAR_UUID,
        VAR_TASK,
        VAR_ROOM,
        VAR_LATEST,
    ]
}

// ── 正则 ──────────────────────────────────────────────────────────────

/// `{{name}}` 或 `{{name:参数}}`。
///
/// ⚠️ 参数用 `[^}]*?` 而不是 `\w`，因为它要装下 `+1d|en` 这种复合写法。
/// 惰性（`*?`）配合「参数里不许有 `}`」—— 这样 `{{a}} 和 {{b}}` 不会把两个变量吞成一个。
static VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^}]*?))?\s*\}\}")
        .expect("内置正则必须能编译")
});

/// `{{latest}}` 的来源读取器：给房间名，返回该房间最新一条**人发的**文本（`None` = 空来源）。
///
/// 与 Go 的 `renderContext.Latest func(room string) (string, bool)` 对应 ——
/// `Option<String>` 里的 `None` 就是那个 `ok == false`。单独一个别名既是文档、
/// 也让 clippy 的 `type_complexity` 闭嘴。
pub type LatestSource<'a> = dyn Fn(&str) -> Option<String> + 'a;

/// 一次求值需要的全部外部状态。
pub struct RenderContext<'a> {
    /// **预定触发时刻**（见模块文档）。
    pub now: DateTime<FixedOffset>,
    pub task: &'a str,
    pub room: &'a str,
    /// `{{latest}}` 的来源读取器。`None` = 引擎没注入读取器（此时用 `{{latest}}` 会报错）；
    /// 读取器返回的 `None` = 那个房间现在是空的（`EmptySource`，调度器据此记 `skipped`）。
    pub latest: Option<&'a LatestSource<'a>>,
}

/// 求值失败。
///
/// ⚠️ [`TemplateError::EmptySource`] 是**可识别的**、且**不是**「模板写错了」：
/// 空房间是常态（没人发言、或消息都被顶掉了），调度器据此记 `skipped` 而不是 `error`，
/// 否则「上次失败」会长期挂在那条任务上，用户以为功能坏了。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TemplateError {
    #[error("来源房间没有可用消息（房间 {0}）")]
    EmptySource(String),
    #[error("{0}")]
    Invalid(String),
}

impl TemplateError {
    /// 调度器用它区分「跳过」与「失败」。
    #[must_use]
    pub fn is_empty_source(&self) -> bool {
        matches!(self, Self::EmptySource(_))
    }
}

fn invalid(message: impl Into<String>) -> TemplateError {
    TemplateError::Invalid(message.into())
}

/// 把模板里的变量全部换掉。
pub fn render(tpl: &str, ctx: &RenderContext<'_>) -> Result<String, TemplateError> {
    if !tpl.contains("{{") {
        return Ok(tpl.to_owned());
    }

    let mut out = String::with_capacity(tpl.len());
    let mut last = 0;
    for caps in VAR_RE.captures_iter(tpl) {
        let whole = caps.get(0).expect("第 0 组必然存在");
        let name = &tpl[caps.get(1).expect("第 1 组必然存在").range()];
        let param = caps.get(2).map_or("", |m| m.as_str());

        out.push_str(&tpl[last..whole.start()]);
        let value = resolve_variable(name, param, ctx)?;
        out.push_str(&value);
        last = whole.end();
    }
    out.push_str(&tpl[last..]);
    Ok(out)
}

/// 保存前先跑一遍求值，把「变量名写错 / 偏移写错」挡在创建那一刻。
///
/// 用一个**固定时刻**求值：这里只关心模板本身是否可用，不关心结果是几号。
/// 放在保存时而不是首次触发时校验 —— 后者意味着用户要等一整个周期才知道自己写错了。
///
/// ⚠️ `{{latest}}` 给个桩：保存时要校验的是**模板写法**，而「那个房间现在有没有消息」
/// 是运行时的事 —— 谁也不能保证明天早上它还有消息。
pub fn validate(tpl: &str) -> Result<(), TemplateError> {
    let ctx = RenderContext {
        now: DateTime::parse_from_rfc3339("2026-01-01T00:00:00+08:00")
            .expect("固定校验时刻必须能解析"),
        task: "",
        room: "default",
        latest: Some(&|_room| Some("x".to_owned())),
    };
    render(tpl, &ctx).map(|_| ())
}

/// 模板里引用到的来源房间，供 HTTP 层做权限校验。
///
/// 返回 `(是否用了不带参数的 {{latest}}, 显式指定的房间名列表)`。
/// 不带参数的那种用的是**任务自己的房间**，调用方不用再判权限。
/// 房间名已归一化、去重、跳过空。
#[must_use]
pub fn latest_rooms(tpl: &str) -> (bool, Vec<String>) {
    let mut bare = false;
    let mut rooms: Vec<String> = Vec::new();
    for caps in VAR_RE.captures_iter(tpl) {
        let name = caps.get(1).map_or("", |m| m.as_str());
        if !name.eq_ignore_ascii_case(VAR_LATEST) {
            continue;
        }
        let param = caps.get(2).map_or("", |m| m.as_str()).trim();
        if param.is_empty() {
            bare = true;
            continue;
        }
        let room = normalize_room_name(param);
        if room.is_empty() || rooms.contains(&room) {
            continue;
        }
        rooms.push(room);
    }
    (bare, rooms)
}

fn resolve_variable(
    name: &str,
    param: &str,
    ctx: &RenderContext<'_>,
) -> Result<String, TemplateError> {
    let param = param.trim();

    if name.eq_ignore_ascii_case(VAR_DATE) {
        let base = apply_offset(ctx.now, param, true)?;
        return Ok(base.format("%Y-%m-%d").to_string());
    }

    if name.eq_ignore_ascii_case(VAR_WEEKDAY) {
        let (offset, style) = parse_weekday_param(param)?;
        let base = apply_offset(ctx.now, &offset, true)?;
        return format_weekday(base.weekday(), &style);
    }

    if name.eq_ignore_ascii_case(VAR_TIME) {
        if !param.is_empty() {
            return Err(invalid(format!("变量 time 不接受参数（收到 {param:?}）")));
        }
        return Ok(ctx.now.format("%H:%M").to_string());
    }

    if name.eq_ignore_ascii_case(VAR_DATETIME) {
        if !param.is_empty() {
            return Err(invalid(format!(
                "变量 datetime 不接受参数（收到 {param:?}）"
            )));
        }
        return Ok(ctx.now.format("%Y-%m-%d %H:%M").to_string());
    }

    if name.eq_ignore_ascii_case(VAR_TIMESTAMP) {
        if !param.is_empty() {
            return Err(invalid(format!(
                "变量 timestamp 不接受参数（收到 {param:?}）"
            )));
        }
        return Ok(ctx.now.timestamp().to_string());
    }

    if name.eq_ignore_ascii_case(VAR_UUID) {
        if !param.is_empty() {
            return Err(invalid(format!("变量 uuid 不接受参数（收到 {param:?}）")));
        }
        return Ok(Uuid::new_v4().to_string());
    }

    if name.eq_ignore_ascii_case(VAR_TASK) {
        return Ok(ctx.task.to_owned());
    }

    if name.eq_ignore_ascii_case(VAR_ROOM) {
        return Ok(ctx.room.to_owned());
    }

    if name.eq_ignore_ascii_case(VAR_LATEST) {
        // 不带参数 = 本房间；带参数 = 指定房间。
        let mut room = ctx.room.to_owned();
        if !param.is_empty() {
            if param.chars().any(char::is_whitespace) {
                return Err(invalid(format!(
                    "变量 latest 的房间名不能含空格（收到 {param:?}）"
                )));
            }
            room = normalize_room_name(param);
        }
        let Some(latest) = ctx.latest else {
            return Err(invalid("变量 latest 需要服务端提供来源消息"));
        };
        return match latest(&room) {
            Some(text) => Ok(text),
            None => Err(TemplateError::EmptySource(room)),
        };
    }

    Err(invalid(format!(
        "未知变量 {{{{{name}}}}}（可用：{}）",
        variable_names().join(" / ")
    )))
}

/// 按 `[+-]N[dwmy]` 偏移一个时刻。`spec` 为空且 `allow_empty` 时原样返回。
fn apply_offset(
    base: DateTime<FixedOffset>,
    spec: &str,
    allow_empty: bool,
) -> Result<DateTime<FixedOffset>, TemplateError> {
    let spec = spec.trim();
    if spec.is_empty() {
        return if allow_empty {
            Ok(base)
        } else {
            Err(invalid("日期偏移不能为空"))
        };
    }
    DateOffset::parse(spec)
        .and_then(|offset| offset.apply(base))
        .ok_or_else(|| {
            invalid(format!(
                "无法识别的日期偏移 {spec:?}（应形如 +1d / -2w / +3m / +1y）"
            ))
        })
}

// ── 周几 ──────────────────────────────────────────────────────────────

/// 周几的四种写法。索引就是 `chrono` 的 `num_days_from_sunday()`（0 = 周日），
/// 和前端 `getDay()` 一致。
const WEEKDAY_ZH_FULL: [&str; 7] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_ZH_SHORT: [&str; 7] = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_EN_FULL: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const WEEKDAY_EN_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

fn normalize_weekday_style(style: &str) -> &'static str {
    match style.to_lowercase().trim() {
        "zh" | "cn" | "中文" | "汉" => "zh",
        "zh-short" | "short" | "简" | "简写" => "zh-short",
        "en" | "英文" | "english" => "en",
        "en-short" => "en-short",
        _ => "",
    }
}

/// 解析 `{{weekday:...+1d|en}}` 里的参数。
///
/// 参数有两种成分，顺序可换：偏移（`+1d`）和样式（`en`），用 `|` 分隔 ——
/// 这样 `{{weekday:+1d|en}}` 和 `{{weekday:en|+1d}}` 都成立，用户不必记顺序。
fn parse_weekday_param(param: &str) -> Result<(String, String), TemplateError> {
    let mut style = "zh".to_owned();
    let param = param.trim();
    if param.is_empty() {
        return Ok((String::new(), style));
    }

    let parts: Vec<&str> = param.split('|').collect();
    if parts.len() > 2 {
        return Err(invalid(format!(
            "变量 weekday 的参数最多两段（偏移|样式），收到 {param:?}"
        )));
    }

    let mut offset = String::new();
    for segment in parts {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        if !normalize_weekday_style(segment).is_empty() {
            style = normalize_weekday_style(segment).to_owned();
            continue;
        }
        // 不是已知样式 → 那它只能是偏移。偏移已经占位时，说明这一段是**写错的样式名**
        // （比如 `cn-simple`）：报「无法识别的样式」比报「只能有一个偏移」有用得多，
        // 后者会让人以为是多写了一个偏移而去改错地方。
        if !offset.is_empty() {
            return Err(invalid(format!(
                "无法识别的周几样式 {segment:?}（可用 zh / zh-short / en / en-short）"
            )));
        }
        offset = segment.to_owned();
    }
    Ok((offset, style))
}

fn format_weekday(weekday: chrono::Weekday, style: &str) -> Result<String, TemplateError> {
    let index = weekday.num_days_from_sunday() as usize;
    let text = match style {
        "zh" => WEEKDAY_ZH_FULL[index],
        "zh-short" => WEEKDAY_ZH_SHORT[index],
        "en" => WEEKDAY_EN_FULL[index],
        "en-short" => WEEKDAY_EN_SHORT[index],
        _ => return Err(invalid(format!("无法识别的周几样式 {style:?}"))),
    };
    Ok(text.to_owned())
}
