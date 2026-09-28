//! 标准 5 字段 cron：解析、前后求时刻、以及「翻译」成人话的**结构化形状**。
//!
//! # 为什么自己写，不引一个 cron 库
//!
//! 与 Go 侧同一套理由（`cron.go` 的文件头），一条没变：
//!
//! 1. 要的只是「算下一次 / **上一次**时刻」这两个纯函数，不要调度器、不要 Job 抽象、
//!    不要日志钩子 —— 调度由 `scheduler` 统一做，它自己处理幂等与补发窗口；
//! 2. 「上一次时刻」不是 cron 库的常见能力，但调度器判到期**必须**有它
//!    （用「下一次」判会让错过的那些永远没人发现：now 一直在往后走）；
//! 3. 字段格式与错误信息要能**直接讲给用户听**（「分钟只能 0-59」比 `invalid expression` 有用），
//!    而这些信息要跟着四份语言的界面走。
//!
//! # 支持的语法
//!
//! ```text
//! ?        任意（Quartz 的写法，从网上抄表达式的人常常带着它）
//! 5        单个值
//! 1-5      范围
//! */10     步长
//! 1-30/5   带步长的范围
//! 1,15,30  列表（列表项本身也可以是范围或带步长）
//! MON-FRI  JAN-DEC  月份 / 星期的英文前三个字母（大小写都认，全拼也认）
//! ```
//!
//! ⚠️ 只认 **5 个字段**（分 时 日 月 周）。带秒的 6 字段表达式会被**明确拒绝**并提示怎么改 ——
//! 静默忽略第一段会让 `0 */5 * * * *`（本意每 5 分钟）变成「每小时第 0 分」，
//! 而用户要过一整天才会发现少发了。
//!
//! # 「翻译」给的是形状，不是句子
//!
//! [`CronSpec::describe`] 返回的是**结构化形状 + 参数**（[`CronDescription`]），**不是成句文案**。
//! 界面有 zh / zh-TW / en / ja 四份语言，服务端在这里拼一句中文，英文和日文用户就会看到中文 ——
//! 那比没有翻译还糟。归纳不出来时 [`CronMode::Unknown`]，界面退回「只看具体时刻」：
//! 宁可说「这个表达式太复杂」，也不要编一句听起来对、实际错的话。
//!
//! ⚠️ 句子里**只许出现人能读的东西**（`1-5` / `1,15` / 展开后的具体值），
//! 绝不出现 `*/3` 这样的**代码** —— 过去把原始 token 直接拼进句子，
//! 于是 `0 9 */3 * *` 被描述成「每月 */3 日 09:00」，那不是描述，是把表达式念了一遍。
//! 读不出来就整句退回 `unknown`（由 [`field_text`] 把守）。
//!
//! # 验证
//!
//! 行为基准是 Go 那 682 行（`cron.go`），期望值由 `cases/cron/cron.json` 给出 ——
//! 那份 fixture 是**冻结的输入**（拆库时从 Go 实现那边带过来的，这边不再重新生成）：
//!
//! ```bash
//! cd <Go 仓库>/cloud-clip && UPDATE_FIXTURES=1 go test ./lib -run TestCronFixtures
//! cargo test -p clip9-core --test go_cron   # 回到本仓库根跑这个
//! ```
//!
//! # ⚠️ 已知限制：时间只看固定偏移，不看时区数据库
//!
//! 这里的时间一律是 [`DateTime<FixedOffset>`]（与动作库的 `ActionContext` 同一套约定）。
//! 对默认的 `Asia/Shanghai`（东八区、**没有夏令时**）完全够用，而且与 Go 逐秒一致。
//! ⚠️ 但要是有人把任务时区配成有夏令时的区（`America/New_York` 之类），
//! 固定的偏移会在换季那天整体差一小时 —— 那是**跨 crate 的约定问题**（动作库的日期动作同样受影响），
//! 不是这里单独能修的，记在 `HANDOVER.md` §6 的未决问题里。

use std::collections::BTreeSet;

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, Months, NaiveDate, NaiveDateTime, TimeZone, Timelike,
};
use serde::Serialize;

/// 求下一次 / 上一次时刻时的迭代上限。
///
/// 因为下面用了「整段跳过」（月份不对就跳到下个月），实际迭代次数远小于这个值 ——
/// 它只是**兜底**：`0 0 30 2 *`（2 月 30 日）语法完全合法但永远等不到，
/// 靠它才能「算出算不出来」而不是把调度器卡死。
const SEARCH_LIMIT: usize = 200_000;

/// 「翻译」里展开成具体时刻的上限。超了就截断并置 `more` ——
/// `0,30 9-18 * * *` 能展开出 20 个时刻，全列出来会把提示行撑爆。
const DESC_MAX_TIMES: usize = 6;

/// 「翻译」里展开成列表的上限。
///
/// 上限的意义不是怕长，而是**超过它就不该叫描述了**：`*/3` 在「日」上展开是 1,4,…,31 共 11 个，
/// 罗列 11 个日期读起来比表达式还费劲 —— 那时候说「说不准，请看具体时刻」才是诚实的。
const DESC_MAX_LIST: usize = 6;

const MONTH_NAMES: [(&str, i32); 12] = [
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const DOW_NAMES: [(&str, i32); 7] = [
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

/// 解析失败。
///
/// ⚠️ 文案**刻意与 Go 一致**：它不是契约（fixture 只钉「哪些输入算错」，不钉措辞），
/// 但界面上正显示着它，切换实现时不该突然换一套说法给用户看。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CronError(String);

impl CronError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// 一个字段的取值集合。
///
/// ⚠️ `any` 必须**单独**记：`*` 与「显式写全」展开出来的集合是一样的，
/// 而「日 / 周」的 OR 语义要靠它区分（`* * 1 * *` 与 `* * 1 * 0-6` 不是一回事）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct CronField {
    set: BTreeSet<u8>,
    any: bool,
}

impl CronField {
    fn contains(&self, value: u8) -> bool {
        self.set.contains(&value)
    }
}

/// 一个解析好的表达式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSpec {
    /// 归一化后的表达式（多余空白压成单个空格、字段原样保留大小写）。
    expr: String,
    minute: CronField,
    hour: CronField,
    dom: CronField,
    month: CronField,
    dow: CronField,
}

impl CronSpec {
    /// 解析一个 5 字段 cron 表达式。
    pub fn parse(expr: &str) -> Result<Self, CronError> {
        let trimmed = expr.trim();
        // `split_whitespace` 与 Go 的 `strings.Fields` 同义：按任意空白切、丢掉空段。
        let fields: Vec<&str> = trimmed.split_whitespace().collect();
        if fields.is_empty() {
            return Err(CronError::new("cron 表达式不能为空"));
        }
        if fields.len() == 6 {
            return Err(CronError::new(format!(
                "只支持 5 个字段（分 时 日 月 周），收到的看起来带「秒」：\
                 请去掉第一段，例如 `0 */5 * * * *` 应写成 `*/5 * * * *`（{trimmed:?}）"
            )));
        }
        if fields.len() != 5 {
            return Err(CronError::new(format!(
                "cron 表达式需要 5 个字段（分 时 日 月 周），收到 {} 个：{trimmed:?}",
                fields.len()
            )));
        }

        let mut spec = Self {
            // 同一条表达式的两种写法不该在库里存成两份。
            expr: fields.join(" "),
            minute: parse_field(fields[0], 0, 59, None, "分钟")?,
            hour: parse_field(fields[1], 0, 23, None, "小时")?,
            dom: parse_field(fields[2], 1, 31, None, "日")?,
            month: parse_field(fields[3], 1, 12, Some(&MONTH_NAMES), "月")?,
            // 星期字段的上界取 7：0 和 7 都是周日（两种写法在 crontab 里都常见）
            dow: parse_field(fields[4], 0, 7, Some(&DOW_NAMES), "星期")?,
        };
        // ⚠️ 7 折进 0，但**不删掉 7**：`day_matches` 只会查 0..=6，没有任何地方读 7，
        // 留着它只是为了让这里的字段集合与 Go 的 `cronSpec` 形状一致（少一处「看着不一样」）。
        if spec.dow.contains(7) {
            spec.dow.set.insert(0);
        }
        Ok(spec)
    }

    /// 归一化后的表达式。
    #[must_use]
    pub fn expression(&self) -> &str {
        &self.expr
    }

    /// 严格**晚于** `after` 的下一次触发时刻。
    ///
    /// ⚠️ 逐分钟硬扫不可行：`0 0 29 2 *`（闰年 2 月 29 日）要扫四年。
    /// 所以每一层不匹配就**整段跳过** —— 月不对跳到下月、日不对跳到明天、时不对跳到下一个整点。
    /// 最坏情况的迭代次数因此被压到「年 × 12 + 年 × 366 + 日 × 24 + 60」这个量级。
    #[must_use]
    pub fn next(&self, after: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
        let offset = *after.offset();
        let mut t = truncate_to_minute(after.naive_local()) + Duration::minutes(1);
        for _ in 0..SEARCH_LIMIT {
            if !self.month.contains(u8_of(t.month())) {
                t = start_of_next_month(t)?;
                continue;
            }
            if !self.day_matches(t) {
                t = start_of_next_day(t)?;
                continue;
            }
            if !self.hour.contains(u8_of(t.hour())) {
                t = start_of_next_hour(t)?;
                continue;
            }
            if !self.minute.contains(u8_of(t.minute())) {
                t += Duration::minutes(1);
                continue;
            }
            return Some(at_local(offset, t));
        }
        None
    }

    /// 不晚于 `before` 的最近一次触发时刻。
    ///
    /// 调度器判到期**必须**用到它：用「下一次」判断会让错过的那些**永远没人发现**
    /// （now 一直在往后走，每次都算出下一个未来时刻）。
    #[must_use]
    pub fn prev(&self, before: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
        let offset = *before.offset();
        let mut t = truncate_to_minute(before.naive_local());
        for _ in 0..SEARCH_LIMIT {
            if !self.month.contains(u8_of(t.month())) {
                t = end_of_prev_month(t)?;
                continue;
            }
            if !self.day_matches(t) {
                t = end_of_prev_day(t)?;
                continue;
            }
            if !self.hour.contains(u8_of(t.hour())) {
                t = end_of_prev_hour(t)?;
                continue;
            }
            if !self.minute.contains(u8_of(t.minute())) {
                t -= Duration::minutes(1);
                continue;
            }
            return Some(at_local(offset, t));
        }
        None
    }

    /// 连续算 `count` 个未来时刻，给「表达式对不对」的即时预览用。
    ///
    /// ⚠️ 界面上的「翻译」只是辅助，**具体时刻列表不能省** —— 描述是对表达式的归纳，
    /// 归纳总有说不全的时候（`*/5 9-18 * * 1-5` 说成「每 5 分钟」就漏了 9-18 点这个限制）。
    /// 两者并排给，用户核对的是时刻，翻译只用来第一眼判断方向对不对。
    #[must_use]
    pub fn next_times(
        &self,
        from: DateTime<FixedOffset>,
        count: usize,
    ) -> Vec<DateTime<FixedOffset>> {
        let mut out = Vec::with_capacity(count);
        let mut cursor = from;
        for _ in 0..count {
            let Some(next) = self.next(cursor) else { break };
            out.push(next);
            cursor = next;
        }
        out
    }

    /// 标准 cron 里那条不直观但必须遵守的规则：
    ///
    /// 「日」和「星期」都**被限制**时，任一个匹配就算匹配（**OR**）；只限制了一个时只看那一个。
    ///
    /// 为什么不能按 AND 理解：写 `0 9 1 * 1` 的人想表达的是「每月 1 号**或**每周一 9 点」。
    /// 按 AND 的话只有「既是 1 号又是周一」才触发，一年也就几次 —— 用户会以为任务坏了。
    fn day_matches(&self, t: NaiveDateTime) -> bool {
        if self.dom.any && self.dow.any {
            return true;
        }
        if self.dom.any {
            return self.dow.contains(u8_of(t.weekday().num_days_from_sunday()));
        }
        if self.dow.any {
            return self.dom.contains(u8_of(t.day()));
        }
        self.dom.contains(u8_of(t.day()))
            || self.dow.contains(u8_of(t.weekday().num_days_from_sunday()))
    }
}

/// `chrono` 的日历字段是 `u32`，而字段集合按 `u8` 存（取值最大 59）。
/// 真到 255 以上是不可能的 —— 那是「秒」的范围，而这里根本不处理秒。
fn u8_of(value: u32) -> u8 {
    u8::try_from(value).unwrap_or(u8::MAX)
}

/// 把一个**墙上时间**按固定偏移变成时刻。
///
/// 用 `from_utc_datetime` 而不是 `from_local_datetime`：后者返回 `LocalResult`
/// （要处理夏令时的不存在/重叠），而固定偏移下那些分支永远走不到。
/// 与其写一个 `unwrap_or` 兜底（等于把「不可能」写成一个假默认值），不如直接用**总函数**。
fn at_local(offset: FixedOffset, naive: NaiveDateTime) -> DateTime<FixedOffset> {
    let utc = naive - Duration::seconds(i64::from(offset.local_minus_utc()));
    offset.from_utc_datetime(&utc)
}

// ── 时刻运算：一律**按日历字段**构造 ──────────────────────────────────
//
// ⚠️ 不能用 `Truncate`：它是按「相对 Unix 纪元」截断的，在 UTC 里正好是整点/整分，
// 但在 +05:30 这类半小时偏移的时区里会把结果挪到 :30 —— 那是个只在别人机器上复现的 bug。
// 按字段构造没有这个问题（Go 侧同一套理由）。
//
// 这些函数都在**墙上时间**（`NaiveDateTime`）上做，最后一次性换回带偏移的时刻。

fn truncate_to_minute(t: NaiveDateTime) -> NaiveDateTime {
    date_and_time(t.date(), t.hour(), t.minute(), 0).unwrap_or(t)
}

fn date_and_time(date: NaiveDate, hour: u32, minute: u32, second: u32) -> Option<NaiveDateTime> {
    date.and_hms_opt(hour, minute, second)
}

fn start_of_day(t: NaiveDateTime) -> Option<NaiveDateTime> {
    date_and_time(t.date(), 0, 0, 0)
}

fn start_of_next_hour(t: NaiveDateTime) -> Option<NaiveDateTime> {
    Some(date_and_time(t.date(), t.hour(), 0, 0)? + Duration::hours(1))
}

fn start_of_next_day(t: NaiveDateTime) -> Option<NaiveDateTime> {
    Some(start_of_day(t)? + Duration::days(1))
}

fn start_of_next_month(t: NaiveDateTime) -> Option<NaiveDateTime> {
    let first = NaiveDate::from_ymd_opt(t.year(), t.month(), 1)?;
    let next = first.checked_add_months(Months::new(1))?;
    date_and_time(next, 0, 0, 0)
}

fn end_of_prev_hour(t: NaiveDateTime) -> Option<NaiveDateTime> {
    Some(date_and_time(t.date(), t.hour(), 0, 0)? - Duration::minutes(1))
}

fn end_of_prev_day(t: NaiveDateTime) -> Option<NaiveDateTime> {
    Some(start_of_day(t)? - Duration::minutes(1))
}

fn end_of_prev_month(t: NaiveDateTime) -> Option<NaiveDateTime> {
    let first = NaiveDate::from_ymd_opt(t.year(), t.month(), 1)?;
    date_and_time(first, 0, 0, 0).map(|at| at - Duration::minutes(1))
}

// ── 解析 ──────────────────────────────────────────────────────────────

/// 解析单个字段。`label` 只用于错误信息：用户看到「分钟只能 0-59」才知道改哪里，
/// 看到「字段取值超范围」还得自己猜是哪个字段。
fn parse_field(
    raw: &str,
    min: i32,
    max: i32,
    names: Option<&[(&str, i32)]>,
    label: &str,
) -> Result<CronField, CronError> {
    let mut field = CronField {
        set: BTreeSet::new(),
        any: false,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CronError::new(format!("{label}字段不能为空")));
    }
    if trimmed == "*" || trimmed == "?" {
        field.any = true;
        for value in min..=max {
            field.set.insert(value as u8);
        }
        return Ok(field);
    }

    for part in trimmed.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(CronError::new(format!(
                "{label}字段里有空的列表项：{raw:?}"
            )));
        }

        let mut step = 1;
        let mut range_part = part;
        if let Some(index) = part.find('/') {
            range_part = part[..index].trim();
            let step_raw = part[index + 1..].trim();
            let parsed = step_raw
                .parse::<i32>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    CronError::new(format!("{label}字段的步长 {step_raw:?} 不是正整数"))
                })?;
            step = parsed;
        }

        let (mut start, mut end) = (min, max);
        if range_part == "*" || range_part == "?" {
            // 保持 min..max
        } else if range_part.contains('-') {
            let mut segments = range_part.splitn(2, '-');
            let raw_start = segments.next().unwrap_or("");
            let raw_end = segments.next().unwrap_or("");
            start = cron_value(raw_start, names)
                .map_err(|e| CronError::new(format!("{label}字段：{e}")))?;
            end = cron_value(raw_end, names)
                .map_err(|e| CronError::new(format!("{label}字段：{e}")))?;
        } else {
            let value = cron_value(range_part, names)
                .map_err(|e| CronError::new(format!("{label}字段：{e}")))?;
            start = value;
            end = value;
            // `a/n` 按标准 cron 理解成 `a-max/n`（不是「从 a 开始走 n 步到 a」）
            if step > 1 {
                end = max;
            }
        }

        if start < min || end > max {
            return Err(CronError::new(format!(
                "{label}字段的取值必须在 {min}-{max} 之间：{part:?}"
            )));
        }
        if start > end {
            return Err(CronError::new(format!(
                "{label}字段的范围起点大于终点：{part:?}"
            )));
        }
        let mut value = start;
        while value <= end {
            field.set.insert(value as u8);
            value += step;
        }
    }

    if field.set.is_empty() {
        return Err(CronError::new(format!(
            "{label}字段没有匹配任何值：{raw:?}"
        )));
    }
    Ok(field)
}

/// 单个取值：数字，或（月份 / 星期）英文名的前三位。
///
/// 返回 `String` 里的内容是**拼给用户看的**，所以这里不定义错误枚举 ——
/// 它只在这一个函数里产生，再往上都会被包进「{label}字段：…」。
fn cron_value(raw: &str, names: Option<&[(&str, i32)]>) -> Result<i32, String> {
    let s = raw.trim().to_uppercase();
    if s.is_empty() {
        return Err("空的取值".to_owned());
    }
    if let Some(names) = names {
        if let Some((_, value)) = names.iter().find(|(name, _)| *name == s) {
            return Ok(*value);
        }
        // 允许 `JAN-DEC` 这种写法的名字，也允许完整单词 `MONDAY` 的前三位
        if s.chars().count() > 3 {
            let head: String = s.chars().take(3).collect();
            if let Some((_, value)) = names.iter().find(|(name, _)| *name == head) {
                return Ok(*value);
            }
        }
    }
    s.parse::<i32>()
        .map_err(|_| format!("{raw:?} 既不是数字也不是已知的名称"))
}

// ── 「翻译」──────────────────────────────────────────────────────────

/// 时刻部分长什么样。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CronMode {
    EveryMinute,
    EveryNMinutes,
    EveryNHours,
    MinutesEachHour,
    Times,
    /// 归纳不出来。**这是正常输出之一，不是错误** —— 界面会说「请看下面的具体时刻」。
    Unknown,
}

/// 日期部分长什么样。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CronDay {
    Daily,
    Weekly,
    Monthly,
    /// ⚠️ 「日」和「周」同时被限制时**必须**是这个 —— 那是 OR 语义（每月 1 号**或**每周一）。
    /// 说成 AND 就把一年几次说成一年一次了。
    MonthlyOrWeekly,
    /// 近似说法，见 [`CronDescription::day_n`]。
    EveryNDays,
    EveryNDaysOrWeekly,
}

/// 表达式的「形状」。字段名与 JSON 键**必须**与 Go 的 `cronDescription` 一致
/// （渲染那一页的脚本读的就是它），由 fixture 逐字节钉住。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CronDescription {
    pub mode: CronMode,

    /// `everyNMinutes` / `everyNHours` 里的 N。
    #[serde(skip_serializing_if = "is_zero")]
    pub n: u32,

    /// `minutesEachHour`：原样回显的分钟写法（可能是 `0,30` 这样的列表）。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub minutes: String,

    /// 非空 = 时刻被限制在这些小时里，原样回显（`9-18` / `9,12,18`）。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub hours: String,

    /// `times`：展开成具体时刻 `HH:MM`。超过上限会被截断并置 [`Self::more`]。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub times: Vec<String>,

    #[serde(skip_serializing_if = "is_false")]
    pub more: bool,

    pub day: CronDay,

    /// 0 = 周日。只在「按星期」的分支里有。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub weekdays: Vec<u8>,

    /// 「日」字段的原样回显（能读的写法）。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub dom: String,

    /// 「每隔 N 天」里的 N。
    ///
    /// ⚠️ **不能和 [`Self::n`] 共用一个字段**：`0 */2 */3 * *` 同时有「每 2 小时」和
    /// 「每隔 3 天」，两个 N 都得在。
    ///
    /// ⚠️ 这是**近似说法**，界面上必须交代清楚：`*/3` 落在「日」上展开是 1,4,7,…,31，
    /// 跨月时会从 31 直接跳到下月 1 号 —— 间隔只有 1 天，不是 3 天。
    /// 标准 5 字段 cron 表达不出真正等距的「每 N 天」，所以只能给最接近的说法。
    #[serde(rename = "dayN", skip_serializing_if = "is_zero")]
    pub day_n: u32,

    /// 非空 = 只在某些月份。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub month: String,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl CronSpec {
    /// 把表达式归纳成一个形状。
    ///
    /// 归纳不出来（或某一段读不出来）时返回 `mode: unknown` —— 那**不是错误**，
    /// 界面会说「表达式太复杂，请看下面的具体时刻」。
    #[must_use]
    pub fn describe(&self) -> CronDescription {
        let mut desc = CronDescription {
            mode: CronMode::Unknown,
            n: 0,
            minutes: String::new(),
            hours: String::new(),
            times: Vec::new(),
            more: false,
            day: CronDay::Daily,
            weekdays: Vec::new(),
            dom: String::new(),
            day_n: 0,
            month: String::new(),
        };

        let fields: Vec<&str> = self.expr.split(' ').collect();
        if fields.len() != 5 {
            return desc;
        }
        let (min_tok, hour_tok, dom_tok, month_tok) = (fields[0], fields[1], fields[2], fields[3]);

        // ── 日期部分 ──────────────────────────────────────────────
        let month_text = field_text(&self.month, month_tok);

        // 「日」字段带步长 → 「每隔 N 天」。日的字段最小值是 1，所以 `1/n` 与 `*/n` 等价。
        let dom_step = step_token(dom_tok, 1);

        match (self.dom.any, self.dow.any) {
            (true, true) => desc.day = CronDay::Daily,
            (true, false) => {
                desc.day = CronDay::Weekly;
                desc.weekdays = weekday_list(&self.dow);
            }
            (false, true) => {
                // 先试**精确**的写法：展开后短就列出具体日期（`*/15` → 「每月 1,16,31 日」）。
                if let Some(text) = field_text(&self.dom, dom_tok) {
                    desc.day = CronDay::Monthly;
                    desc.dom = text;
                } else if dom_step > 0 {
                    // 列不全（`*/3` 是 11 个）才退回近似说法。
                    desc.day = CronDay::EveryNDays;
                    desc.day_n = dom_step;
                } else {
                    return desc;
                }
            }
            (false, false) => {
                // 「日」和「周」都被限制 = OR 语义，两边都得说得出来
                if let Some(text) = field_text(&self.dom, dom_tok) {
                    desc.day = CronDay::MonthlyOrWeekly;
                    desc.dom = text;
                } else if dom_step > 0 {
                    desc.day = CronDay::EveryNDaysOrWeekly;
                    desc.day_n = dom_step;
                } else {
                    return desc;
                }
                desc.weekdays = weekday_list(&self.dow);
            }
        }
        if !self.month.any {
            let Some(text) = month_text else {
                return desc;
            };
            desc.month = text;
        }

        // ── 时刻部分 ──────────────────────────────────────────────
        let min_any = token_is_any(min_tok);
        let hour_any = token_is_any(hour_tok);

        if min_any && hour_any {
            desc.mode = CronMode::EveryMinute;
            return desc;
        }
        if min_any {
            // 「每分钟」但只在某些小时里 —— `* 9 * * *` 是很常见的 crontab 写法
            let Some(hours) = field_text(&self.hour, hour_tok) else {
                return desc;
            };
            desc.mode = CronMode::EveryMinute;
            desc.hours = hours;
            return desc;
        }

        // 分钟带步长：`*/n` / `0/n` → 每 n 分钟
        let minute_step = step_token(min_tok, 0);
        if minute_step > 0 {
            // ⚠️ 先把要用的都算出来、**全部可读**了再写 desc。以前是先写 mode 再校验 hours，
            // hours 不可读时直接 return —— 于是 `*/5 */2 * * *` 会输出「每 5 分钟」，
            // 把「只在每 2 小时」这个限制**整段丢掉**。那不是「说不准」，那是说了一句错话。
            let hours = if hour_any {
                String::new()
            } else {
                let Some(text) = field_text(&self.hour, hour_tok) else {
                    return desc;
                };
                text
            };
            desc.mode = CronMode::EveryNMinutes;
            desc.n = minute_step;
            desc.hours = hours;
            return desc;
        }

        // 小时带步长：`0 */2 * * *` = 每 2 小时的第 0 分。
        // 单独给一个 mode，因为「每 2 小时」是个完整、有用的说法 —— 展开成 12 个时刻去数反而看不懂。
        let hour_step = step_token(hour_tok, 0);
        if hour_step > 0 {
            if min_any {
                // 「每 2 小时里的每分钟」不值得多造一个句子，老实说不准
                return desc;
            }
            let Some(minutes) = field_text(&self.minute, min_tok) else {
                return desc;
            };
            desc.mode = CronMode::EveryNHours;
            desc.n = hour_step;
            desc.minutes = minutes;
            return desc;
        }

        // 分钟、小时都不带步长：能翻的两种说法
        let mins = plain_values(min_tok, 0, 59);
        let hours = plain_values(hour_tok, 0, 23);

        if hour_any {
            // 小时不限 → 「每小时的第 M 分」
            let Some(minutes) = field_text(&self.minute, min_tok) else {
                return desc;
            };
            desc.mode = CronMode::MinutesEachHour;
            desc.minutes = minutes;
            return desc;
        }

        // 两边都是枚举值 → 展开成 HH:MM（「每天 09:30」这种最常见的样子）
        if let (Some(hours), Some(mins)) = (hours, mins) {
            let mut times = Vec::with_capacity(hours.len() * mins.len());
            for hour in &hours {
                for minute in &mins {
                    times.push(format!("{hour:02}:{minute:02}"));
                }
            }
            if times.len() > DESC_MAX_TIMES {
                times.truncate(DESC_MAX_TIMES);
                // 截断了就要标出来 —— 否则界面会把 6 个时刻当成全部，
                // 用户以为「一天就这 6 次」。
                desc.more = true;
            }
            desc.mode = CronMode::Times;
            desc.times = times;
            return desc;
        }

        // 小时是范围 / 列表 / 短展开 → 「每小时的第 M 分（只在 … 点）」
        let (Some(minutes), Some(hours_text)) = (
            field_text(&self.minute, min_tok),
            field_text(&self.hour, hour_tok),
        ) else {
            return desc;
        };
        desc.mode = CronMode::MinutesEachHour;
        desc.minutes = minutes;
        desc.hours = hours_text;
        desc
    }
}

/// 字段写法里有没有字母（月份 / 星期的英文名）。有字母就走展开，别把 `JAN` 直接念进句子里。
fn has_letter(token: &str) -> bool {
    token.chars().any(|c| c.is_ascii_alphabetic())
}

/// 把一个字段写成人能读的一小段，读不出来返回 `None`。
///
/// 三种能读的写法直接原样用：单值 `9`、列表 `1,15`、范围 `9-18`。
/// 带步长的（`*/2`）展开成具体值 —— 短就列出来（`*/2` 在「月」上是 1,3,5,7,9,11），长就放弃。
/// **绝不把 `*/2` 这样的原文放进句子里**：那不是描述，是把代码念了一遍。
fn field_text(field: &CronField, raw: &str) -> Option<String> {
    if field.any {
        return Some(String::new());
    }
    let token = raw.trim();
    // 数字以外的写法（步长 `*/2`、月份名 `JAN`）都走展开这条路：
    // 原样放进句子会得到「JAN 月」「*/2 月」这种东西。
    if !token.contains('/') && !has_letter(token) {
        return Some(token.to_owned());
    }
    if field.set.is_empty() || field.set.len() > DESC_MAX_LIST {
        return None;
    }
    let values: Vec<String> = field.set.iter().map(u8::to_string).collect();
    Some(values.join(","))
}

fn token_is_any(token: &str) -> bool {
    token == "*" || token == "?"
}

/// 认出「从字段最小值开始、每 n 走一步」这一种形状，返回 n；否则返回 0。
///
/// 认三种写法，它们其实**完全等价**：`*/n`、`?/n`、以及 `0/n`（字段最小值/n）。
/// 最后一种很容易被忽略 —— 导出的 crontab 里 `0/4` 和 `*/4` 一样常见，
/// 不认它就会掉进「说不准」，用户会以为描述功能坏了。
///
/// 起点**不是**最小值的（`5/10`）仍然留给未知分支：它是「从第 5 分起每 10 分」，
/// 说成「每 10 分钟」会漏掉「从 5 开始」那半句。
fn step_token(token: &str, field_min: u8) -> u32 {
    let Some(index) = token.find('/') else {
        return 0;
    };
    if index == 0 {
        return 0;
    }
    let Ok(n) = token[index + 1..].trim().parse::<u32>() else {
        return 0;
    };
    if n == 0 {
        return 0;
    }
    match token[..index].trim() {
        "*" | "?" => n,
        head => match head.parse::<u32>() {
            Ok(value) if value == u32::from(field_min) => n,
            _ => 0,
        },
    }
}

/// 只接受「逗号分隔的单个数字」这种最朴素的写法（返回去重升序）。
///
/// 刻意不认范围和步长：`9-18` 展开成 10 个时刻再拼成一句话，不如直接说「9-18 点」。
/// 区分开之后，「展开成具体时刻」这条路就只走那些真的能列清楚的表达式。
fn plain_values(token: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut seen = BTreeSet::new();
    for item in token.split(',') {
        let item = item.trim();
        if item.is_empty() || item.contains('-') || item.contains('/') {
            return None;
        }
        let value = item
            .parse::<u32>()
            .ok()
            .filter(|v| *v >= min && *v <= max)?;
        seen.insert(value);
    }
    if seen.is_empty() {
        return None;
    }
    Some(seen.into_iter().collect())
}

/// 取星期字段里被选中的值，0 = 周日。
///
/// 7 是周日的另一种写法，[`CronSpec::parse`] 已把它折进 0，这里只需跳过 7 本身。
fn weekday_list(field: &CronField) -> Vec<u8> {
    (0..=6).filter(|value| field.contains(*value)).collect()
}
