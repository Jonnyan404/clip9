//! 日期偏移与日期 token：`+1d` / `-2w` / `+3m` / `+1y`，以及 `2026-09-25` 这类基准写法。
//!
//! ⚠️ 这个模块**不随任何 feature 裁剪**：它被三处用 ——
//! 动作库的 `date.add` / `date.diff`（`actions/date.rs`）、`core` 的模板引擎
//! （`{{date:+1d}}` / `{{weekday:+1d}}`）、以及**服务端的 `?at=` 基准时刻**
//! （`server/scheduler.rs`，对应 Go 的 `parsePreviewReference` → `parseDateToken`）。
//! 而「加月夹取」「紧凑日期没有时间组」这类微妙规则如果各写一份，迟早会有一边漂，
//! 那种漂在预览区和定时任务之间制造的是**最难看**的错（同一个输入两个结果）。
//! 所以 `DateOffset` / `parse_date_token` 是纯逻辑基础工具，不该因为「某个动作分组被裁剪」
//! 就跟着消失 —— `?at=` 是文档里写明的参数（`docs/api.md`），它不能因为 OpenWrt 那档
//! 关掉了 `date` 动作就变成 400。

use std::sync::LazyLock;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone,
};
use regex::Regex;

/// 日期偏移的正则：`+1d` / `-2w` / `+3m` / `+1y`（符号与单位都可省，省了按天）。
///
/// ⚠️ 这串正则同时被动作库的 `date.add` 与模板引擎的 `{{date:+1d}}` 用 —— 见
/// [`DateOffset`] 的注释，别在别处再抄一份。
const OFFSET_SOURCE: &str = r"^([+-])?\s*([0-9]+)\s*([dwmy]?)$";

fn compiled(source: &'static str) -> Regex {
    Regex::new(source).expect("内置正则必须能编译")
}

static OFFSET_RE: LazyLock<Regex> = LazyLock::new(|| compiled(OFFSET_SOURCE));

/// 日期偏移的单位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateUnit {
    Days,
    Weeks,
    Months,
    Years,
}

impl DateUnit {
    /// `date.add` 与模板偏移共用的单位写法：`""` / `d` → 天，`w` → 周，`m` → 月，`y` → 年。
    #[must_use]
    pub fn from_letter(letter: &str) -> Option<Self> {
        match letter.to_ascii_lowercase().as_str() {
            "" | "d" => Some(Self::Days),
            "w" => Some(Self::Weeks),
            "m" => Some(Self::Months),
            "y" => Some(Self::Years),
            _ => None,
        }
    }
}

/// 一次日期偏移：`+1d` / `-2w` / `3m` / `1y`。
///
/// ⚠️ 这段必须**只有一份**：`date.add` 的动作、模板引擎的 `{{date:+1d}}`、`{{weekday:+1d}}`
/// 用的是同一种写法（Go 的注释明说「偏移语法直接沿用动作库 date.add 的 `[+-]N[dwmy]`，
/// 不新造一套」）。把「加月要夹到目标月最后一天」在两边各写一遍，迟早会有一边漂，
/// 而那种漂在预览区和定时任务之间制造的是**最难看**的错（同一个输入两个结果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateOffset {
    /// 已经带上符号：`-2` 表示往回。
    pub amount: i64,
    pub unit: DateUnit,
}

impl DateOffset {
    /// 从「符号 + 数量 + 单位」直接构造（`date.add` 已经从正则里拆好了这三个）。
    #[must_use]
    pub fn new(amount: i64, unit: DateUnit) -> Self {
        Self { amount, unit }
    }

    /// 解析 `[+-]N[dwmy]`。认不出返回 `None`，**错误文案交给调用方拼**（两处的措辞不一样）。
    #[must_use]
    pub fn parse(spec: &str) -> Option<Self> {
        let caps = OFFSET_RE.captures(spec.trim())?;
        let amount: i64 = caps.get(2)?.as_str().parse().ok()?;
        let amount = if caps.get(1).map_or("", |m| m.as_str()) == "-" {
            -amount
        } else {
            amount
        };
        let unit = DateUnit::from_letter(caps.get(3).map_or("", |m| m.as_str()))?;
        Some(Self { amount, unit })
    }

    /// 应用到一个时刻。月份 / 年数会把「日」夹到目标月最后一天。
    ///
    /// 溢出（年份超范围、`×7` / `×12` 越界）返回 `None` —— 调用方把它转成「数量太大」这类错误。
    #[must_use]
    pub fn apply(self, base: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
        match self.unit {
            DateUnit::Days => shift_days(base, self.amount),
            DateUnit::Weeks => shift_days(base, self.amount.checked_mul(7)?),
            DateUnit::Months => add_months_clamped(base, self.amount),
            DateUnit::Years => add_months_clamped(base, self.amount.checked_mul(12)?),
        }
    }
}

/// 加 N 个月，并把「日」**夹到**目标月的最后一天。
///
/// ⚠️ 不能直接做月份加法：`1月31日 + 1个月` 会因为 2 月没有 31 号而**溢出到 3 月 3 日**。
/// 正确结果应该是 2 月 28/29 日。前端的 `addMonths` 是同一套处理。
fn add_months_clamped(t: DateTime<FixedOffset>, months: i64) -> Option<DateTime<FixedOffset>> {
    let day = t.day();
    let time = t.time();
    // 先归到 1 号再加月，避免加法过程中发生溢出；再夹「日」。
    let total = i64::from(t.year()) * 12 + i64::from(t.month()) - 1 + months;
    let year = i32::try_from(total.div_euclid(12)).ok()?;
    let month = (total.rem_euclid(12) + 1) as u32;
    let day = day.min(days_in_month(year, month));
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    Some(at_local(*t.offset(), date.and_time(time)))
}

/// 按天偏移。用 `checked_*` 而不是让 `NaiveDate` 自己滚：溢出要说得出来。
fn shift_days(t: DateTime<FixedOffset>, days: i64) -> Option<DateTime<FixedOffset>> {
    let date = t.date_naive();
    let shifted = if days >= 0 {
        date.checked_add_days(chrono::Days::new(days.unsigned_abs()))
    } else {
        date.checked_sub_days(chrono::Days::new(days.unsigned_abs()))
    }?;
    Some(at_local(*t.offset(), shifted.and_time(t.time())))
}

/// 某年某月有多少天。
///
/// 自己算而不是借 `chrono` 的「下个月第 0 天」：Go 那边就是这个意思，而这个表一眼能核。
const fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// 把一个**墙上时间**（`naive`）按固定偏移变成时刻。
///
/// 用 `from_utc_datetime` 而不是 `from_local_datetime`：后者返回 `LocalResult`（要处理
/// 夏令时的不存在/重叠），而固定偏移下那些分支永远走不到 —— 与其写一个 `unwrap_or` 兜底
/// （等于把「不可能」写成一个假的默认值），不如直接用**总函数**，类型上就没有失败这条岔路。
///
/// ⚠️ `pub(crate)`：`actions/date.rs` 的 `parse_date_token` / `start_of_day` 也要用这同一个
/// 转换，别在那边再写一份（那份「固定偏移下夏令时分支永远走不到」的判断最好只出现一次）。
pub(crate) fn at_local(offset: FixedOffset, naive: NaiveDateTime) -> DateTime<FixedOffset> {
    let utc = naive - chrono::Duration::seconds(i64::from(offset.local_minus_utc()));
    offset.from_utc_datetime(&utc)
}

// ── 日期 token ────────────────────────────────────────────────────────────
//
// 下面这一段原来在 `actions/date.rs`（被 `date` feature 关着）。提到这里是因为
// **服务端的 `?at=` 也要认同一套写法** —— 而 `?at=` 是 `docs/api.md` 里写明的参数，
// 不该因为某个部署把 `date` 动作分组裁掉就跟着失效。

/// 日期 token 的三种写法，与前端 `parseDateToken` 认的一致：
///
/// - ISO / 斜杠：`2026-09-23`、`2026/9/23`（可跟 `10:30` 或 `T10:30:00`）
/// - 中文：`2026年09月23日`
/// - 紧凑：`20260923`
///
/// ⚠️★ 第三条**没有时间捕获组**（`m` 只有 4 项）—— Go 那边正因此有过一次
/// **下标越界 panic**（`date.add` 传紧凑日期 → 调度器 goroutine 崩 → 整个进程退出）。
/// 这里用 `caps.get(4)` 取组，组不存在与组没参与都回 `None`，两种情形自然合一，
/// 不会再犯同一个错。
const DATE_TOKEN_SOURCES: [&str; 3] = [
    r"^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$",
    r"^([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日?(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$",
    r"^([0-9]{4})([0-9]{2})([0-9]{2})$",
];

/// 日期关键词 → 相对「今天」的天数偏移。查表前先转小写（所以 `TODAY` 也认）。
const DATE_KEYWORDS: [(&str, i64); 6] = [
    ("今天", 0),
    ("明天", 1),
    ("昨天", -1),
    ("today", 0),
    ("tomorrow", 1),
    ("yesterday", -1),
];

static DATE_TOKEN_RES: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    DATE_TOKEN_SOURCES.map(|source| Regex::new(source).expect("内置正则必须能编译"))
});

/// 解析一个日期 token，返回**给定偏移**下的时刻；认不出返回 `None`。
///
/// ⚠️ 关键字（今天/明天/昨天）按**基准时刻** `now` 算，**不要**在函数里取 `now()`：
/// 试算用的 `ctx.now` 是「下次触发时刻」（未来），实发时才是当前时刻 —— 用真实时间的话
/// **同一份正文试算和实发会得到不同结果**，而测试里注入的固定 `now` 也会失效，
/// 于是断言跟着真实日期漂（每天早上红一次）。
///
/// ⚠️ 这里的 `[0-9]` 是刻意写的（不是 `\d`）：`\d` 在 Go/JS 里是 ASCII、在 Rust 默认是
/// Unicode，用 `\d` 会让「全角数字」在两个实现里一个认一个不认。同 `text.rs` 的说明。
#[must_use]
pub fn parse_date_token(raw: &str, now: &DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let offset = *now.offset();

    if let Some((_, days)) = DATE_KEYWORDS
        .iter()
        .find(|(key, _)| *key == s.to_lowercase())
    {
        // 归到零点再加偏移 —— 不归一的话「明天」会把当前的时分秒一起带上。
        return Some(start_of_day(now) + Duration::days(*days));
    }

    for re in DATE_TOKEN_RES.iter() {
        let Some(caps) = re.captures(s) else { continue };
        // 三条正则的前三组都是纯数字，解析不会失败；`unwrap_or_default` 是照 Go 的
        // `_ := strconv.Atoi(...)` 写法（那里也忽略错误 —— 忽略之后得 0，
        // 于是自然在下面的构造/回读校验那一步被拒）。
        let year: i32 = num(&caps[1]);
        let month: u32 = num(&caps[2]);
        let day: u32 = num(&caps[3]);
        // ⚠️ 紧凑写法没有时间组：`get(4)` 在「组不存在」与「组没参与」两种情形下都回 None，
        // 所以这一句同时兜住了 Go 那个越界 panic 的两种根因。
        let hour: u32 = caps.get(4).map_or(0, |m| num(m.as_str()));
        let minute: u32 = caps.get(5).map_or(0, |m| num(m.as_str()));
        let second: u32 = caps.get(6).map_or(0, |m| num(m.as_str()));

        // ⚠️ 这里是**严格构造**（月/日/时分秒越界 / 不存在的日期一律 None），
        // 与 Go 的「构造完再回读校验年月日」在绝大多数输入上等价；
        // 差别只在时分秒越界那种输入上，见 `actions/date.rs` 模块文档第 1 条。
        let date = NaiveDate::from_ymd_opt(year, month, day)?;
        let time = NaiveTime::from_hms_opt(hour, minute, second)?;
        return Some(at_local(offset, date.and_time(time)));
    }

    None
}

/// 某个时刻所在那一天的**本地零点**。
#[must_use]
pub fn start_of_day(t: &DateTime<FixedOffset>) -> DateTime<FixedOffset> {
    at_local(*t.offset(), t.date_naive().and_time(NaiveTime::MIN))
}

/// 捕获组里的数字。三条正则里出现过数字的位置都是纯数字，解析不会失败。
fn num<T: std::str::FromStr + Default>(raw: &str) -> T {
    raw.parse().unwrap_or_default()
}
