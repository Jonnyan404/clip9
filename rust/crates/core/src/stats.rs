//! 房间活跃度：按**本地日**分桶、分位分级、连续天数。
//!
//! # 为什么是纯逻辑、放在 core
//!
//! 照 `CONTRIBUTING §4`：判定在 core，取数在 store，端点在 server。
//! 这里**不碰数据库、不碰网络** —— 进来一串时间戳，出去一串每天的计数。
//! 这样「时区边界」「跨月」「空房间」「连续天数怎么数」这些**最容易错**的部分
//! 全都能单测，而不用起一个库。
//!
//! # ⚠️★ 时区为什么必须由调用方给
//!
//! 热力图问的是「**看图那个人**的哪一天」，而服务端不知道他在哪个时区。
//! 用 UTC 分桶的话，东八区晚上 8 点之后的活跃会被算进**第二天** ——
//! 而这张图正是用来看「哪几天多」的，错一天等于整个结论是错的。
//!
//! ⚠️ 收的是 **IANA 名字**（`Asia/Shanghai`）而不是固定偏移：
//! 夏令时切换那天固定偏移会错一小时，而 IANA 名字在每个日期上各自算偏移。
//! 页面那边 `Intl.DateTimeFormat().resolvedOptions().timeZone` 给的就是这个名字。

use std::str::FromStr;

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// 一天的计数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DayCount {
    /// `YYYY-MM-DD`（**本地日**，不是 UTC 日）。
    pub date: String,
    pub count: u32,
}

/// 连续天数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Streak {
    /// 到今天为止连着有多少天有消息（今天没有就是 0）。
    ///
    /// ⚠️ 「今天」是**本地日**。今天还没发消息不代表断了 —— 所以这里数的是
    /// 「从今天（或昨天）往回连续」。见 [`streak_of`] 的注释。
    pub current: u32,
    /// 这段窗口里最长的一段。
    pub longest: u32,
}

/// 一个房间的按天活跃度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyActivity {
    /// 每天一条，**旧的在前面**，长度恰好是请求的天数（没有的那天是 0）。
    pub days: Vec<DayCount>,
    /// 这段窗口里的总条数。
    pub total: u64,
    /// 最活跃的那天（并列取最近的；全 0 时是 `None`）。
    pub busiest: Option<DayCount>,
    pub streak: Streak,
    /// 四道**分位**阈值，用来把计数分成 5 档（含 0 那一档）。
    ///
    /// ⚠️★ 用分位而不是固定阈值：一个每天 3 条的房间，固定阈值（1/5/10/20）会让
    /// **整张图都是最浅色** —— 而「哪几天多」正是他来看这张图的原因。
    /// ⚠️ 代价：不同房间的同一个颜色不代表同一个条数，所以**图例必须写实际区间**。
    pub levels: [u32; 4],
}

/// 把时间戳按**给定时区**的本地日分桶。
///
/// - `stamps`：UTC 秒（顺序无所谓）。
/// - `last_day`：窗口的最后一天（本地日，通常是「今天」）。
/// - `days`：窗口长度。落在窗口外的戳**直接丢掉**（不报错 —— 调用方可能多读了几天）。
///
/// 返回的数组**旧的在前面**，长度恰好是 `days`。
#[must_use]
pub fn bucket_by_day(
    stamps: &[i64],
    last_day: NaiveDate,
    days: usize,
    tz: &Tz,
) -> Vec<u32> {
    let mut counts = vec![0u32; days];
    if days == 0 {
        return counts;
    }
    let first_day = last_day - Duration::days(days as i64 - 1);
    for &stamp in stamps {
        let Some(utc) = DateTime::<Utc>::from_timestamp(stamp, 0) else {
            continue;
        };
        let local = utc.with_timezone(tz).date_naive();
        let offset = (local - first_day).num_days();
        if offset < 0 {
            continue;
        }
        let index = offset as usize;
        if index >= days {
            continue;
        }
        // ⚠️ `saturating_add`：一天几百万条在剪贴板里不现实，但**溢出 panic** 更不划算。
        counts[index] = counts[index].saturating_add(1);
    }
    counts
}

/// 四道分位阈值（**只用非零天**算）。
///
/// ⚠️ 非零天少于 4 天时**退化**：四分位数在 1–3 个样本上没有意义，
/// 那时把所有非零天都算作同一档（阈值全取最大值）—— 图上看是「有 / 没有」两档。
#[must_use]
pub fn levels_of(counts: &[u32]) -> [u32; 4] {
    let mut nonzero: Vec<u32> = counts.iter().copied().filter(|&c| c > 0).collect();
    if nonzero.len() < 4 {
        let top = nonzero.iter().copied().max().unwrap_or(0);
        return [top, top, top, top];
    }
    nonzero.sort_unstable();
    let at = |q: f64| -> u32 {
        // 最近秩法：`ceil(q * n) - 1`，夹在 [0, n-1]。
        let n = nonzero.len() as f64;
        let index = (q * n).ceil() as isize - 1;
        nonzero[index.clamp(0, nonzero.len() as isize - 1) as usize]
    };
    // ⚠️ 阈值必须**单调不减**：分位数在并列值多的时候可能算出 `[4,4,4,4]` 之外的东西，
    // 但万一算出倒序，分级就会把「多的一天」画成浅色。夹一下。
    let mut out = [at(0.25), at(0.5), at(0.75), at(1.0)];
    for i in 1..4 {
        out[i] = out[i].max(out[i - 1]);
    }
    out
}

/// 连续天数。
///
/// ⚠️★ `current` 的算法**要容忍「今天还没发」**：如果最后一天（今天）是 0，
/// 就从**倒数第二天**往回数。不这么做的话，每天早上一打开图，
/// 「连续 N 天」会先变成 0 —— 而用户什么都没做错，只是今天还没复制东西。
#[must_use]
pub fn streak_of(counts: &[u32]) -> Streak {
    let longest = {
        let mut best = 0u32;
        let mut run = 0u32;
        for &count in counts {
            if count > 0 {
                run += 1;
                best = best.max(run);
            } else {
                run = 0;
            }
        }
        best
    };
    // 从末尾往回数；末尾那天是 0 就先跳过它（见上面那段）。
    let mut index = counts.len();
    if index > 0 && counts[index - 1] == 0 {
        index -= 1;
    }
    let mut current = 0u32;
    while index > 0 && counts[index - 1] > 0 {
        current += 1;
        index -= 1;
    }
    Streak { current, longest }
}

/// 把一串计数拼成完整的 [`DailyActivity`]。
#[must_use]
pub fn summarize(counts: &[u32], last_day: NaiveDate) -> DailyActivity {
    let days: Vec<DayCount> = counts
        .iter()
        .enumerate()
        .map(|(index, &count)| DayCount {
            date: (last_day - Duration::days(counts.len() as i64 - 1 - index as i64))
                .format("%Y-%m-%d")
                .to_string(),
            count,
        })
        .collect();
    let total: u64 = counts.iter().map(|&c| u64::from(c)).sum();
    // ⚠️ 并列取**最近**那天：`max_by_key` 在并列时返回**最后一个**，
    // 而我们要的是「最近的那次高峰」（更相关）。
    let busiest = days
        .iter()
        .filter(|d| d.count > 0)
        .max_by_key(|d| d.count)
        .cloned();
    DailyActivity {
        days,
        total,
        busiest,
        streak: streak_of(counts),
        levels: levels_of(counts),
    }
}

/// 这个时区名字认得出来吗（认不出来回落到 UTC）。
///
/// ⚠️ 不报错而是回落：一个客户端报了一个奇怪的时区名，不该让整张图打不开 ——
/// 那会退化成「统计坏了」，而实际上只是「按 UTC 画」。调用方可以把回落这件事
/// 告诉用户（响应里带上实际用的时区）。
#[must_use]
pub fn resolve_tz(name: &str) -> Tz {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return chrono_tz::UTC;
    }
    Tz::from_str(trimmed).unwrap_or(chrono_tz::UTC)
}

/// 某个时区里「今天」是哪一天。
#[must_use]
pub fn today_in(tz: &Tz, now: i64) -> NaiveDate {
    DateTime::<Utc>::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(tz).date_naive())
        // ⚠️ 时间戳离谱到 `from_timestamp` 返回 `None` 时别 panic —— 退回 1970。
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).expect("1970-01-01 一定合法"))
}

/// 窗口的第一天（本地日）—— 调用方拿它去 store 里定「扫到哪为止」。
#[must_use]
pub fn first_day_of(last_day: NaiveDate, days: usize) -> NaiveDate {
    if days == 0 {
        return last_day;
    }
    last_day - Duration::days(days as i64 - 1)
}

/// 本地日 → 那一天的**起点**（本地 00:00）对应的 UTC 秒。
///
/// ⚠️ 用它当 store 的扫描下界（比按 UTC 日算宽松一点没关系：多读几条会被
/// [`bucket_by_day`] 丢掉）。
#[must_use]
pub fn local_day_start_utc(day: NaiveDate, tz: &Tz) -> i64 {
    match tz.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap_or_default()) {
        chrono::LocalResult::Single(dt) => dt.timestamp(),
        // ⚠️ 夏令时那天 00:00 可能**不存在**（某些时区会跳到 01:00）——
        // 那就取那个时刻之后最早的一刻，而不是 panic。
        chrono::LocalResult::Ambiguous(a, _) => a.timestamp(),
        chrono::LocalResult::None => {
            let naive = day.and_hms_opt(1, 0, 0).unwrap_or_default();
            tz.from_local_datetime(&naive).earliest().map_or_else(
                || Utc.from_utc_datetime(&naive).timestamp(),
                |dt| dt.timestamp(),
            )
        }
    }
}

/// 一个固定偏移（测试与「只给了 ±HH:MM」的调用方用）。
#[must_use]
pub fn fixed_offset(hours: i32) -> FixedOffset {
    FixedOffset::east_opt(hours * 3600).unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC"))
}

/// `Datelike` 只是为了上面的 `date_naive` 之类能用；显式引用一下免得被判成未使用。
const _: fn() -> i32 = || NaiveDate::from_ymd_opt(2000, 1, 1).expect("合法").year();

#[cfg(test)]
mod tests {
    use super::*;

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("合法日期")
    }

    /// UTC 秒 —— **2026-10-07 12:00:00Z**。
    ///
    /// ⚠️★ 这个数是 `date -u -j -f '%Y-%m-%d %H:%M:%S' '2026-10-07 12:00:00' '+%s'` 算出来的，
    /// **不是手写的**。第一版我手填了一个「看着像」的数，结果它其实是 10-06 20:00Z，
    /// 于是三条测试一起红 —— 而它们红得**对**（错的是常量，不是逻辑）。
    const NOON: i64 = 1_791_374_400;

    /// ★ 基本分桶：同一天的都进同一格，且**旧的在前面**。
    #[test]
    fn buckets_by_day_oldest_first() {
        let tz = resolve_tz("UTC");
        // 10-05 有 2 条、10-06 有 1 条、10-07 有 3 条
        let stamps = vec![
            NOON - 2 * 86_400,
            NOON - 2 * 86_400 + 3600,
            NOON - 86_400,
            NOON,
            NOON + 60,
            NOON + 120,
        ];
        let counts = bucket_by_day(&stamps, day(2026, 10, 7), 3, &tz);
        assert_eq!(counts, vec![2, 1, 3], "旧的在前面");
    }

    /// ★★ 时区：同一时刻，东八区与 UTC 可能落在**不同的本地日**。
    ///
    /// ⚠️ 这条是整张图「对不对」的分水岭。UTC 16:30 在东八区已经是**第二天**的 00:30。
    #[test]
    fn the_same_instant_lands_on_different_local_days() {
        // 2026-10-06 16:30:00Z
        let stamp = NOON - 86_400 + 4 * 3600 + 1800;
        let utc = bucket_by_day(&[stamp], day(2026, 10, 7), 3, &resolve_tz("UTC"));
        let sh = bucket_by_day(&[stamp], day(2026, 10, 7), 3, &resolve_tz("Asia/Shanghai"));
        assert_eq!(utc, vec![0, 1, 0], "UTC 下是 10-06");
        assert_eq!(sh, vec![0, 0, 1], "东八区下已经是 10-07");
    }

    /// 窗口外的戳**丢掉**，不报错、也不算进任何一天。
    #[test]
    fn stamps_outside_the_window_are_dropped() {
        let tz = resolve_tz("UTC");
        let stamps = vec![NOON - 10 * 86_400, NOON, NOON + 5 * 86_400];
        let counts = bucket_by_day(&stamps, day(2026, 10, 7), 3, &tz);
        assert_eq!(counts, vec![0, 0, 1], "只有窗口里那天算数");
    }

    /// ★ 分位阈值只用**非零天**：一个「每天都有」的房间，阈值应当是它的日常水平，
    /// 而不是被那一堆 0 拉到 1。
    #[test]
    fn levels_ignore_zero_days() {
        // 10 天：5 天各 4 条、5 天是 0
        let counts = vec![0, 0, 0, 0, 0, 4, 4, 4, 4, 4];
        let levels = levels_of(&counts);
        assert_eq!(levels, [4, 4, 4, 4], "非零天全是 4 → 四道阈值都是 4");
        assert!(levels[0] > 1, "没有被那 5 个 0 拉到 1");
    }

    /// 非零天不足 4 天时**退化**成「有 / 没有」两档（而不是给出假的四分位）。
    #[test]
    fn levels_degrade_when_there_are_too_few_nonzero_days() {
        let levels = levels_of(&[0, 0, 0, 0, 0, 0, 0, 2, 0, 0]);
        assert_eq!(levels, [2, 2, 2, 2], "只有一天有 → 所有阈值取它");
        assert_eq!(levels_of(&[0, 0, 0]), [0, 0, 0, 0], "一条都没有 → 全 0");
    }

    /// ★ 「连续天数」要容忍**今天还没发**。
    ///
    /// ⚠️ 不容忍的话，每天早上一打开图，「连续 N 天」会先变成 0 ——
    /// 而用户什么都没做错，只是今天还没复制东西。
    #[test]
    fn current_streak_survives_a_quiet_today() {
        // 前几天连着 3 天有，今天是 0
        let counts = vec![0, 1, 1, 1, 0];
        let streak = streak_of(&counts);
        assert_eq!(streak.current, 3, "跳过今天那一格往回数");
        assert_eq!(streak.longest, 3);
    }

    /// 昨天也没发 → 连续断了。
    #[test]
    fn current_streak_breaks_after_two_quiet_days() {
        let streak = streak_of(&[1, 1, 0, 0]);
        assert_eq!(streak.current, 0);
        assert_eq!(streak.longest, 2);
    }

    /// 最长的那段与当前那段是两回事。
    #[test]
    fn longest_and_current_are_different_runs() {
        let streak = streak_of(&[1, 1, 1, 0, 1]);
        assert_eq!(streak.current, 1, "末尾那段");
        assert_eq!(streak.longest, 3, "中间那段更长");
    }

    /// 全空：什么都不该 panic，连续天数都是 0。
    #[test]
    fn an_empty_window_is_all_zeroes() {
        let streak = streak_of(&[0, 0, 0]);
        assert_eq!(streak, Streak::default());
        assert_eq!(levels_of(&[0, 0, 0]), [0, 0, 0, 0]);
    }

    /// `summarize` 的日期要对上（最后一个是 `last_day`），并列时取**最近**那天。
    #[test]
    fn summarize_dates_and_ties() {
        let counts = vec![0, 5, 5, 1];
        let out = summarize(&counts, day(2026, 10, 7));
        assert_eq!(out.days.len(), 4);
        assert_eq!(out.days[0].date, "2026-10-04");
        assert_eq!(out.days[3].date, "2026-10-07", "最后一天就是 last_day");
        assert_eq!(out.total, 11);
        assert_eq!(
            out.busiest.as_ref().map(|d| d.date.as_str()),
            Some("2026-10-06"),
            "并列 5 条时取**最近**那天（10-06 比 10-05 近）"
        );
    }

    /// 空窗口的 `summarize` 不该 panic（`days.len() - 1` 那种算法最容易在这儿翻车）。
    #[test]
    fn summarize_handles_an_empty_slice() {
        let out = summarize(&[], day(2026, 10, 7));
        assert!(out.days.is_empty());
        assert_eq!(out.total, 0);
        assert!(out.busiest.is_none());
    }

    /// 认不出来的时区名回落成 UTC（而不是让整张图打不开）。
    #[test]
    fn an_unknown_timezone_falls_back_to_utc() {
        assert_eq!(resolve_tz("Asia/Shanghai"), chrono_tz::Asia::Shanghai);
        assert_eq!(resolve_tz(""), chrono_tz::UTC);
        assert_eq!(resolve_tz("Not/AZone"), chrono_tz::UTC);
        assert_eq!(resolve_tz("  "), chrono_tz::UTC, "空白也算没给");
    }

    /// 窗口第一天与「本地日起点」的换算要对得上（store 拿它当下界）。
    #[test]
    fn the_window_start_maps_to_the_right_utc_instant() {
        let tz = resolve_tz("Asia/Shanghai");
        let start = local_day_start_utc(day(2026, 10, 07), &tz);
        // 东八区的 10-07 00:00 = UTC 10-06 16:00
        let utc = DateTime::<Utc>::from_timestamp(start, 0).expect("合法");
        assert_eq!(utc.format("%Y-%m-%d %H:%M").to_string(), "2026-10-06 16:00");
        assert_eq!(first_day_of(day(2026, 10, 7), 3), day(2026, 10, 5));
    }

    /// ★ 夏令时那天不能 panic，而且要落在那一天的范围内。
    ///
    /// ⚠️ 用 `America/New_York`：2026-03-08 那天本地 02:00 不存在。
    #[test]
    fn a_dst_transition_day_does_not_panic() {
        let tz = resolve_tz("America/New_York");
        let start = local_day_start_utc(day(2026, 3, 8), &tz);
        let utc = DateTime::<Utc>::from_timestamp(start, 0).expect("合法");
        // 那天的本地起点 = UTC 03-08 05:00（EST，UTC-5）
        assert_eq!(utc.format("%Y-%m-%d %H:%M").to_string(), "2026-03-08 05:00");
    }
}
