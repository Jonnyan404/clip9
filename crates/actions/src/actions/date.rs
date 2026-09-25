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
//! ⚠️ 日期 token 的三条正则**已经搬到 `crate::offset`**（服务端的 `?at=` 也要认同一套写法），
//! 那边的 `parse_date_token` 上重复写着这条约定。

use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset};
use regex::Regex;

use crate::error::ActionError;
use crate::offset::{DateOffset, DateUnit, parse_date_token, start_of_day};
use crate::registry::{ActionContext, Params};

/// `date.add` 的输入约定：`基准 运算符 数量 单位`，基准可省（省了用 `ctx.now`）。
///
/// ⚠️ 基准是**惰性**捕获（`.*?`）：`2026-09-24 -1d` 里那个 `-` 既是日期分隔符又是运算符，
/// 惰性 + 回溯才能把基准定成 `2026-09-24` 而不是 `2026`。Go 的 leftmost-first 语义
/// 与 `regex` crate 的默认语义（非 POSIX）在这里一致 —— **别加 `(?-u)` 或开 POSIX 模式**，
/// 那会换成 leftmost-longest，两边就此分叉。
const DATE_ADD_SOURCE: &str = r"^(.*?)\s*([+-])\s*([0-9]+)\s*([dwmy]?)\s*$";

/// 两个操作数之间的分隔符，与前端 `date.diff` 保持一致。
///
/// ⚠️ 这里的 `\s*` 只是让它**顺便**吃掉分隔符旁边的空白，而「两行写法」是另一条路
/// （分隔符本身不匹配裸换行，所以 `A\nB` 会落到下面那个按 `\n` 拆的分支）。
const DATE_DIFF_SEP_SOURCE: &str = r"\s*(?:~|～|→|->|至|到|\.\.+)\s*";

fn compiled(source: &'static str) -> Regex {
    Regex::new(source).expect("内置正则必须能编译")
}

static DATE_ADD_RE: LazyLock<Regex> = LazyLock::new(|| compiled(DATE_ADD_SOURCE));
static DATE_DIFF_SEP_RE: LazyLock<Regex> = LazyLock::new(|| compiled(DATE_DIFF_SEP_SOURCE));

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

    // ⚠️ 单位从正则里已经是小写（`[dwmy]`），`from_letter` 里那层 lower 只是防御。
    let unit =
        DateUnit::from_letter(caps.get(4).map_or("", |m| m.as_str())).unwrap_or(DateUnit::Days);
    let result = DateOffset::new(amount, unit)
        .apply(base)
        .ok_or_else(|| invalid("日期超出可表示范围"))?;

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
