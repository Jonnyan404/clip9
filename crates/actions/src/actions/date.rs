//! `date` 组：日期加减与日期差。
//!
//! # 时区：只有 `FixedOffset`，没有时区数据库
//!
//! [`ActionContext::now`] 带的是**固定的偏移**（`+08:00`），不是 `chrono_tz` 那种带
//! 夏令时规则的时区。这在本项目里是够的：任务时区默认 `Asia/Shanghai`，**没有夏令时**，
//! 固定的 +08:00 与「真正的 Asia/Shanghai」在所有日期上给出同一个墙上时间。
//!
//! ⚠️ 但不要据此把「按本地零点算差」写成「按秒差除 86400」：Go 那边特意用
//! `startOfDay(b).Unix() - startOfDay(a).Unix()`，理由是**有夏令时的时区**里那一天只有
//! 23 小时。这里照样按零点算 —— 现在两种写法等价，将来换成带时区库时前者不会重新踩坑。
//!
//! # 与 Go 的两处差异（都记在这儿，别等它咬人）
//!
//! 1. **时分秒越界**：Go 用 `time.Date(...)` 构造，它会把越界值**归一化**
//!    （`01:99` → `02:39`），而回读校验只比年月日 —— 于是这种输入在 Go 那边**是合法的**。
//!    这边按区间严格校验，直接报错。选严格是因为「悄悄给出一个看着合理、其实不对的时间」
//!    正是 Go 自己那段注释在防的事。
//! 2. **`\s` 的语义**：Go 的 `\s` 是 ASCII，这边是 Unicode（同前端、同 `text.rs` 的说明）。
//!    举例：`2026-09-24　+1d`（全角空格）在前端与这边能算，在 Go 那边报错。
//!
//! 下面这些 `[0-9]` 也是同一个理由（`\d` 在 Go/JS 里都是 ASCII，而 Rust 默认是 Unicode）。

use std::sync::LazyLock;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone,
};
use regex::Regex;

use crate::error::ActionError;
use crate::registry::{ActionContext, Params};

/// `date.add` 的输入约定：`基准 运算符 数量 单位`，基准可省（省了用 `ctx.now`）。
///
/// ⚠️ 基准是**惰性**捕获（`.*?`）：`2026-09-24 -1d` 里那个 `-` 既是日期分隔符又是运算符，
/// 惰性 + 回溯才能把基准定成 `2026-09-24` 而不是 `2026`。Go 的 leftmost-first 语义
/// 与 `regex` crate 的默认语义（非 POSIX）在这里一致 —— **别加 `(?-u)` 或开 POSIX 模式**，
/// 那会换成 leftmost-longest，两边就此分叉。
const DATE_ADD_SOURCE: &str = r"^(.*?)\s*([+-])\s*([0-9]+)\s*([dwmy]?)\s*$";

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

/// 两个操作数之间的分隔符，与前端 `date.diff` 保持一致。
///
/// ⚠️ 这里的 `\s*` 只是让它**顺便**吃掉分隔符旁边的空白，而「两行写法」是另一条路
/// （分隔符本身不匹配裸换行，所以 `A\nB` 会落到下面那个按 `\n` 拆的分支）。
const DATE_DIFF_SEP_SOURCE: &str = r"\s*(?:~|～|→|->|至|到|\.\.+)\s*";

/// 日期关键词 → 相对「今天」的天数偏移。查表前先转小写（所以 `TODAY` 也认）。
const DATE_KEYWORDS: [(&str, i64); 6] = [
    ("今天", 0),
    ("明天", 1),
    ("昨天", -1),
    ("today", 0),
    ("tomorrow", 1),
    ("yesterday", -1),
];

fn compiled(source: &'static str) -> Regex {
    Regex::new(source).expect("内置正则必须能编译")
}

static DATE_ADD_RE: LazyLock<Regex> = LazyLock::new(|| compiled(DATE_ADD_SOURCE));
static DATE_DIFF_SEP_RE: LazyLock<Regex> = LazyLock::new(|| compiled(DATE_DIFF_SEP_SOURCE));
static DATE_TOKEN_RES: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    DATE_TOKEN_SOURCES.map(|source| Regex::new(source).expect("内置正则必须能编译"))
});

pub(crate) fn run(
    id: &str,
    input: &str,
    _params: &Params,
    ctx: &ActionContext,
) -> Option<Result<String, ActionError>> {
    let now = ctx.now;
    Some(match id {
        "date.add" => date_add(input, &now),
        "date.diff" => date_diff(input, &now),
        _ => return None,
    })
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

/// 把一个**墙上时间**（`naive`）按固定偏移变成时刻。
///
/// 用 `from_utc_datetime` 而不是 `from_local_datetime`：后者返回 `LocalResult`（要处理
/// 夏令时的不存在/重叠），而固定偏移下那些分支永远走不到 —— 与其写一个 `unwrap_or` 兜底
/// （等于把「不可能」写成一个假的默认值），不如直接用**总函数**，类型上就没有失败这条岔路。
fn at_local(offset: FixedOffset, naive: NaiveDateTime) -> DateTime<FixedOffset> {
    let utc = naive - Duration::seconds(i64::from(offset.local_minus_utc()));
    offset.from_utc_datetime(&utc)
}

/// 某个时刻所在那一天的**本地零点**。
fn start_of_day(t: &DateTime<FixedOffset>) -> DateTime<FixedOffset> {
    at_local(*t.offset(), t.date_naive().and_time(NaiveTime::MIN))
}

/// 解析一个日期 token，返回**任务时区**下的时刻；认不出返回 `None`。
///
/// ⚠️ 关键字（今天/明天/昨天）按**基准时刻** `now` 算，**不要**在函数里取 `now()`：
/// 试算用的 `ctx.now` 是「下次触发时刻」（未来），实发时才是当前时刻 —— 用真实时间的话
/// **同一份正文试算和实发会得到不同结果**，而测试里注入的固定 `now` 也会失效，
/// 于是断言跟着真实日期漂（每天早上红一次）。
fn parse_date_token(raw: &str, now: &DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
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
        // 差别只在时分秒越界那种输入上，见模块文档第 1 条。
        let date = NaiveDate::from_ymd_opt(year, month, day)?;
        let time = NaiveTime::from_hms_opt(hour, minute, second)?;
        return Some(at_local(offset, date.and_time(time)));
    }

    None
}

/// 捕获组里的数字。三条正则里出现过数字的位置都是纯数字，解析不会失败。
fn num<T: std::str::FromStr + Default>(raw: &str) -> T {
    raw.parse().unwrap_or_default()
}

/// 加 N 个月，并把「日」**夹到**目标月的最后一天。
///
/// ⚠️ 不能直接做月份加法：`1月31日 + 1个月` 会因为 2 月没有 31 号而**溢出到 3 月 3 日**。
/// 正确结果应该是 2 月 28/29 日。前端的 `addMonths` 是同一套处理 ——
/// 两侧不一致的话，同一个动作在预览区和定时任务里会给出不同的日期。
fn add_months_clamped(
    t: DateTime<FixedOffset>,
    months: i64,
) -> Result<DateTime<FixedOffset>, ActionError> {
    let day = t.day();
    let time = t.time();
    // 先归到 1 号再加月，避免加法过程中发生溢出；再夹「日」。
    let total = i64::from(t.year()) * 12 + i64::from(t.month()) - 1 + months;
    let year = i32::try_from(total.div_euclid(12)).map_err(|_| invalid("日期超出可表示范围"))?;
    let month = (total.rem_euclid(12) + 1) as u32;
    let day = day.min(days_in_month(year, month));
    let date =
        NaiveDate::from_ymd_opt(year, month, day).ok_or_else(|| invalid("日期超出可表示范围"))?;
    Ok(at_local(*t.offset(), date.and_time(time)))
}

/// 按天偏移。用 `checked_*` 而不是让 `NaiveDate` 自己滚：溢出要说出来。
fn shift_days(t: DateTime<FixedOffset>, days: i64) -> Result<DateTime<FixedOffset>, ActionError> {
    let date = t.date_naive();
    let shifted = if days >= 0 {
        date.checked_add_days(chrono::Days::new(days.unsigned_abs()))
    } else {
        date.checked_sub_days(chrono::Days::new(days.unsigned_abs()))
    }
    .ok_or_else(|| invalid("日期超出可表示范围"))?;
    Ok(at_local(*t.offset(), shifted.and_time(t.time())))
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

fn date_add(input: &str, now: &DateTime<FixedOffset>) -> Result<String, ActionError> {
    let text = input.trim();
    let Some(caps) = DATE_ADD_RE.captures(text) else {
        return Err(invalid(
            "写法：2026-01-01 +30d（单位 d/w/m/y，省略基准则从触发时刻算）",
        ));
    };
    // 第一组可能参与但为空（省略基准），所以这里用 `map_or` 而不是索引。
    let base_raw = caps.get(1).map_or("", |m| m.as_str());
    let sign = caps.get(2).map_or("", |m| m.as_str());
    let amount_raw = caps.get(3).map_or("", |m| m.as_str());
    let unit = caps.get(4).map_or("", |m| m.as_str()).to_lowercase();

    let base = if base_raw.trim().is_empty() {
        *now
    } else {
        // 写了基准但认不出 → 报错，**别悄悄回落到「今天」**：那会让用户拿到一个
        // 看着合理、其实完全不对的结果。
        parse_date_token(base_raw, now)
            .ok_or_else(|| invalid(format!("认不出这个日期: {}", base_raw.trim())))?
    };

    let amount: i64 = amount_raw
        .parse()
        .map_err(|e| invalid(format!("无法解析数量 {amount_raw:?}: {e}")))?;
    let amount = if sign == "-" { -amount } else { amount };

    let result = match unit.as_str() {
        "m" => add_months_clamped(base, amount)?,
        "y" => add_months_clamped(
            base,
            amount.checked_mul(12).ok_or_else(|| invalid("年数太大"))?,
        )?,
        "w" => shift_days(
            base,
            amount.checked_mul(7).ok_or_else(|| invalid("周数太大"))?,
        )?,
        _ => shift_days(base, amount)?,
    };

    // 基准带不带时间决定输出带不带时间 —— 判据是**用户写的那段原始文本里有没有 `:`**
    // （不是解析结果里有没有），因为「2026-09-24」与「2026-09-24 00:00」应当得到不同形状的结果。
    Ok(if base_raw.contains(':') {
        result.format("%Y-%m-%d %H:%M").to_string()
    } else {
        result.format("%Y-%m-%d").to_string()
    })
}

fn date_diff(input: &str, now: &DateTime<FixedOffset>) -> Result<String, ActionError> {
    let text = input.trim();
    let mut parts: Vec<&str> = DATE_DIFF_SEP_RE.split(text).collect();
    if parts.len() < 2 {
        parts = text.split('\n').collect();
    }
    let cleaned: Vec<&str> = parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect();
    if cleaned.len() < 2 {
        return Err(invalid("写法：两行日期，或 2026-01-01 ~ 2026-03-15"));
    }

    let a = parse_date_token(cleaned[0], now).ok_or_else(|| invalid("认不出这个日期"))?;
    let b = parse_date_token(cleaned[1], now).ok_or_else(|| invalid("认不出这个日期"))?;

    let days = (start_of_day(&b) - start_of_day(&a)).num_days();
    let abs = days.abs();
    let weeks = abs / 7;
    let rest = abs % 7;

    let mut out = vec![format!("{days} 天")];
    if weeks > 0 {
        out.push(format!("{weeks} 周 {rest} 天"));
    }
    Ok(out.join("\n"))
}
