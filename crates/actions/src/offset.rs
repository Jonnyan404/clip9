//! 日期偏移：`+1d` / `-2w` / `+3m` / `+1y`。
//!
//! ⚠️ 这个模块**不随任何 feature 裁剪**：它被两处用 ——
//! 动作库的 `date.add`（`actions/date.rs`）与 `core` 的模板引擎（`{{date:+1d}}` /
//! `{{weekday:+1d}}`）。而「加月夹取」这类微妙规则如果各写一份，迟早会有一边漂，
//! 那种漂在预览区和定时任务之间制造的是**最难看**的错（同一个输入两个结果）。
//! 所以 `DateOffset` 是纯逻辑基础工具，不该因为「某个动作分组被裁剪」就跟着消失。

use std::sync::LazyLock;

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, TimeZone};
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
