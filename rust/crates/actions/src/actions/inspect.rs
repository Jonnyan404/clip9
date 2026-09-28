//! `inspect` 组：校验类 / 时间戳类。

use std::sync::LazyLock;

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::error::ActionError;
use crate::registry::{ActionContext, Params};

/// 只认 10 位（秒）/ 13 位（毫秒）—— 写的是 `[0-9]{9,13}`，所以 9~12 位都按**秒**算。
/// ⚠️ `\d` → `[0-9]`：Go 与 JS 的 `\d` 都是 ASCII，全角数字不算时间戳（见 `text.rs` 的说明）。
const UNIX_TIMESTAMP_SOURCE: &str = r"^[0-9]{9,13}$";

static UNIX_TIMESTAMP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(UNIX_TIMESTAMP_SOURCE).expect("内置正则必须能编译"));

/// `dateTextToTimestamp` 认的写法，**顺序即优先级**。
///
/// ⚠️ 这是 Go 那五条 layout 的等价物，而且必须是**同一套**：
/// 「2025-01-01」按 UTC 解释（`Date.parse('2025-01-01')` 也是这条路），
/// 按本地解释会整体差一个时区，东八区就是 8 小时、日期还可能跟着错一天。
///
/// ⚠️ 第二列 `date_only` 决定用哪个 chrono 解析器。`chrono` 的 `%m` / `%d` 认 1~2 位数字，
/// 而 Go 的 `time.Parse` 认的是**固定的两位**（`2025-1-1` 在 Go 那边报错）——
/// 所以每条解析完都要做一次**回写比对**（见 [`date_text_to_timestamp`]），
/// 把「解析得更宽松」这件事挡在门口。
const LAYOUTS: [(&str, bool); 5] = [
    ("%Y-%m-%d", true),
    ("%Y-%m-%dT%H:%M:%S", false),
    ("%Y-%m-%dT%H:%M", false),
    ("%Y-%m-%d %H:%M:%S", false),
    ("%Y-%m-%d %H:%M", false),
];

pub(crate) fn run(
    id: &str,
    input: &str,
    _params: &Params,
    ctx: &ActionContext,
) -> Option<Result<String, ActionError>> {
    Some(match id {
        // 小写十六进制、无分隔（Go 是 `hex.EncodeToString(sum[:])`）。
        "inspect.sha256" => Ok(format!("{:x}", Sha256::digest(input.as_bytes()))),
        "inspect.timestamp" => timestamp_to_date_text(input, ctx),
        "inspect.dateToTimestamp" => date_text_to_timestamp(input),
        _ => return None,
    })
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

/// Unix 时间戳（秒或毫秒）→ 日期时间。
///
/// ⚠️ 用**任务时区**渲染（`ctx.now` 的偏移），不是浏览器本地时区、也不是 UTC。
/// 定时任务的正文必须跟任务自己的时区走 —— 否则「一个按 Asia/Shanghai 排的任务跑在 UTC
/// 容器里」会发出差 8 小时的时间，而那只有真到了那一天才看得出来。
fn timestamp_to_date_text(input: &str, ctx: &ActionContext) -> Result<String, ActionError> {
    let s = input.trim();
    if !UNIX_TIMESTAMP_RE.is_match(s) {
        return Err(invalid("不是 10 位（秒）或 13 位（毫秒）时间戳"));
    }
    let value: i64 = s.parse().map_err(|_| invalid("时间戳超出可表示范围"))?;
    let millis = if s.len() < 13 {
        value
            .checked_mul(1000)
            .ok_or_else(|| invalid("时间戳超出可表示范围"))?
    } else {
        value
    };
    let at =
        DateTime::from_timestamp_millis(millis).ok_or_else(|| invalid("时间戳超出可表示范围"))?;
    Ok(at
        .with_timezone(ctx.now.offset())
        .format("%Y-%m-%d %H:%M:%S")
        .to_string())
}

/// 日期字符串 → Unix 时间戳（秒）。
fn date_text_to_timestamp(input: &str) -> Result<String, ActionError> {
    // 前端把 `2026/09/23` 的斜杠归一成 `-`（Safari 对斜杠的解析行为不一致）。
    let s = input.trim().replace('/', "-");

    for (layout, date_only) in LAYOUTS {
        let parsed: Option<NaiveDateTime> = if date_only {
            NaiveDate::parse_from_str(&s, layout)
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
        } else {
            NaiveDateTime::parse_from_str(&s, layout).ok()
        };
        let Some(datetime) = parsed else { continue };
        // ⚠️★ 回写比对：`chrono` 比 Go 宽松（`%m` 认一位数），不挡住的话
        // `2025-1-1` 会在两边分叉 —— 而「一边能认、一边报错」正是最该避免的那类差异。
        //
        // 拿格式化回去比，而不是自己写一串长度检查：它同时盖住了「位数不够」
        // （`2025-1-1` → `2025-01-01`）与「多出来的字符」（`…T08:00:00Z`）两种情形。
        if datetime.format(layout).to_string() != s {
            continue;
        }
        return Ok(datetime.and_utc().timestamp().to_string());
    }

    Err(invalid("认不出这个日期"))
}
