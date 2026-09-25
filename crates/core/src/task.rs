//! 定时任务：模型、校验、下次/到期求值。
//!
//! # 为什么任务必须是**声明式**的（存动作 id + 模板 + 时刻，不是一段脚本）
//!
//! 1. 执行载体可以有多个（服务端进程内的 ticker、将来的常驻客户端），同一份定义谁跑都得
//!    出一模一样的结果 —— 存脚本就做不到这一点；
//! 2. 脚本是「以服务端身份执行任意代码」，而模板 + 动作 id 是可枚举、可校验、可预览的，
//!    用户能在保存前看到「下次触发会发出什么」。
//!
//! # 时区：固定偏移，不是带夏令时的时区
//!
//! 与 `cron` / 动作库的 `ActionContext` 同一套约定（`DateTime<FixedOffset>`）。
//! 对默认的 `Asia/Shanghai`（东八区、无夏令时）**逐秒正确**；配成 `America/New_York`
//! 这类有夏令时的区时，换季那几天会差一小时。修它是一次跨 crate 的约定改动
//! （换成带 tz 数据库的类型 + 处理 `LocalResult` 的不存在/重叠两个分支），
//! 见 `HANDOVER.md` §6 —— 别在这个模块里单方面换类型。
//!
//! [`resolve_tz_offset`] 把 IANA 名（`Asia/Shanghai`）或显式偏移（`+08:00`）解析成
//! 一个 `FixedOffset`：有夏令时的时区取**标准时偏移**（这就是上面那条限制的来源）。
//!
//! # 求值基准是「预定触发时刻」，不是「实际发送时刻」
//!
//! 服务重启 / 机器合盖导致的补发，正文里写的仍然是那个「本该发出的时刻」。
//! 差异靠消息上的 `late` 标记体现（见 `scheduler` 侧）。

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveTime, Offset, TimeZone};
use chrono_tz::Tz;

use crate::cron::CronSpec;
use crate::template;

/// 幂等键的格式：精确到分钟。调度精度就是分钟，秒级差异只是同一刻的不同表述，
/// 用它做键会让「同一分钟内的两次 tick」被当成两次不同的触发。
const RUN_KEY_LAYOUT: &str = "%Y-%m-%dT%H:%M";

/// 单个房间的任务条数上限（管理员不受限）。这不是安全边界（真正的边界是鉴权），
/// 是防止一个房间被塞满任务、把调度器变成一个人的广播台。
pub const MAX_TASKS_PER_ROOM: usize = 20;

/// 默认发送者名。
pub const DEFAULT_SENDER: &str = "定时任务";

/// 任务名长度上限（rune）。列表要能一眼看完，太长的名字会被截断成没用的东西。
pub const NAME_MAX_CHARS: usize = 60;

/// 设备名（sender）长度上限（rune）。
const SENDER_MAX_CHARS: usize = 32;

/// 频率的四种取值。
pub const FREQ_ONCE: &str = "once";
pub const FREQ_DAILY: &str = "daily";
pub const FREQ_WEEKLY: &str = "weekly";
pub const FREQ_CRON: &str = "cron";

/// 动作链上的一步。
///
/// 两种 JSON 形态都认，**读写都兼容**：
///
/// ```json
/// "text.trimLines"                                          // 无参数（绝大多数）
/// {"id":"text.replace","params":{"find":"a","with":"b"}}     // 带参数
/// ```
///
/// ⚠️ **必须两种都认**：链元素带参数是后加的能力，而 tasks 里的存量数据全是字符串形态。
/// 只认对象的话，用户升一次级就会丢掉整条链 —— 「更新把用户数据弄坏」比功能缺失严重得多。
///
/// ⚠️ 写回时**无参数一律写成字符串**：和存量数据保持同形，diff 也干净。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum ChainStep {
    Id(String),
    WithParams {
        id: String,
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        params: std::collections::BTreeMap<String, String>,
    },
}

impl ChainStep {
    /// 这一步的动作 id。
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            ChainStep::Id(id) => id.trim(),
            ChainStep::WithParams { id, .. } => id.trim(),
        }
    }
}

/// 按 Go 的 `time.RFC3339` 渲染一个时刻。
///
/// ⚠️★ **别直接用 chrono 的 `to_rfc3339()`**：它对**零偏移**输出 `+00:00`，而 Go 的
/// `time.RFC3339` 输出 `Z`。这个差别会落在用户看得见的字段上 —— `taskView` 的 `runAt`、
/// 试跑响应的 `scheduledAt` / `referenceAt2`（管理页把它们原样显示出来）。
/// 2026-09-25 由双跑比对抓到（`?at=2026-09-25T01:30:00Z` 那条用例；带 `+08:00` 的
/// 时刻两边一样，所以只有「基准恰好是 UTC」时才现形）。
///
/// `SecondsFormat::Secs` 同样是照 Go：RFC3339 不带小数秒。
#[must_use]
pub fn format_rfc3339(t: &chrono::DateTime<chrono::FixedOffset>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 把 JSON `null` 当成「没有这一项」。
///
/// ⚠️ `#[serde(default)]` **只管「字段缺失」，不管 `null`** —— 收到 `"byWeekday": null`
/// 时 `Vec<u32>` 会直接解析失败。而 Go 那边这两个字段是 nil 切片，`taskView` 序列化出来
/// 正是 `null`。于是「客户端把从 Go 读到的任务原样回传」这条路会在 Rust 上变成 400
/// `invalid_body`，而两边**都不是坏的** —— 只是对「空列表」的表达不同。
///
/// 收下 `null` 是「宽进」的那一半；出参侧仍然给 `[]`（见 `server::automation::task_view`，
/// 那条是**刻意**和 Go 不同，比对脚本里单独断言着）。
fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Default,
{
    // `Deserialize` 这个 trait 得在作用域里才调得到 `Option::<T>::deserialize`。
    use serde::Deserialize as _;
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// 一条定时任务。
///
/// ⚠️ Room 是**服务端根据凭据推导出来**并写死的，不是客户端说了算的字段。
/// 建好之后改房间 = 越权向别的房间投递，所以更新时**不允许改 Room**（见 server 侧的 upsert）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AutomationTask {
    pub id: String,
    /// ⚠️★ **内部排序键**：单调递增，由 `Store::put_task` 分配，**不出现在任何响应里**
    /// （`task_view` 不写它，`TaskRequest` 也没有它）。
    ///
    /// 为什么需要它 —— 根因是「拿随机值当排序兜底键」：
    /// 1. 任务在 redb 里按 `id`（uuid）做键，所以「按 key 遍历」= **按随机串排序**；
    ///    用户新建一条任务，它会落在列表中间某个随机位置而不是末尾。
    /// 2. 用 `createdAt` 当兜底也救不了：它是**秒级**的，同一秒内建的两条分不出先后。
    ///
    /// 消息那边早就用同一个办法解决了同一个问题（`meta.next_id` 单调计数器 +
    /// `(room, ts_desc, id_desc)` 的键），这里只是把同一套办法用到任务上。
    /// **顺序必须来自单调序列，不能来自随机值** —— 这是那条约定的可执行形式。
    ///
    /// `0` = 还没分配（`put_task` 会补上）；更新时调用方带着已有的值进来，位置因此不变。
    #[serde(default)]
    pub seq: i64,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    /// once | daily | weekly | cron
    pub freq: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub time: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cron: String,
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub by_weekday: Vec<u32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub run_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tz: String,
    pub room: String,
    pub template: String,
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub chain: Vec<ChainStep>,
    /// 这条任务的消息是否占房间历史额度。默认 false —— 房间历史按房间计数，
    /// 一个每天 09:30 的任务十几天就能把房间里的历史全换成「今天是几号」。
    #[serde(default)]
    pub keep_history: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sender: String,

    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,

    /// **预定触发时刻**的幂等键（不是实际发送时刻）。补发也写同一个键，所以不会重复发。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_run_key: String,
    #[serde(default)]
    pub last_run_at: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_error: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_output: String,

    /// 「single 档房间」（通常是开放房间）里这条任务的钥匙的 SHA-256（十六进制）。
    /// 开放房间的客户端没有任何凭据，服务端无法区分谁是谁 —— 没有这个键，
    /// 那条任务谁都能改、谁都能删。明文只在创建时返回一次。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub owner_hash: String,
}

/// 任务相关的错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TaskError {
    #[error("{0}")]
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> TaskError {
    TaskError::Invalid(message.into())
}

/// 把 IANA 名或显式偏移解析成一个 `FixedOffset`。认不出返回 `None`。
///
/// 支持三种写法：`Asia/Shanghai`（IANA 名）、`+08:00` / `-05:30`（显式偏移）、`UTC`。
/// 有夏令时的时区取**标准时偏移**（见模块文档的「时区」那条限制）。
#[must_use]
pub fn resolve_tz_offset(name: &str) -> Option<FixedOffset> {
    let name = name.trim();
    if name.is_empty() {
        return Some(default_tz_offset());
    }
    // 显式偏移：`+08:00` / `+0800` / `+08`
    if let Some(offset) = parse_explicit_offset(name) {
        return Some(offset);
    }
    // IANA 名。取标准时偏移（1970-01-01，避开夏令时）。
    let tz: Tz = name.parse().ok()?;
    let base = NaiveDate::from_ymd_opt(1970, 1, 1)?.and_time(NaiveTime::MIN);
    Some(tz.offset_from_utc_datetime(&base).fix())
}

fn parse_explicit_offset(name: &str) -> Option<FixedOffset> {
    // 形如 +08:00 / -0530 / +08
    let (sign, rest) = match name.as_bytes().first() {
        Some(b'+') => (1, &name[1..]),
        Some(b'-') => (-1, &name[1..]),
        _ => return None,
    };
    let compact: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
    let (hour, minute) = match compact.len() {
        1 | 2 => (compact.parse::<i32>().ok()?, 0),
        3 => (
            compact[..1].parse::<i32>().ok()?,
            compact[1..].parse::<i32>().ok()?,
        ),
        4 => (
            compact[..2].parse::<i32>().ok()?,
            compact[2..].parse::<i32>().ok()?,
        ),
        _ => return None,
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    let seconds = (hour * 3600 + minute * 60) * sign;
    FixedOffset::east_opt(seconds)
}

/// 默认时区偏移：`Asia/Shanghai` = 东八区。
#[must_use]
pub fn default_tz_offset() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("+08:00 必然合法")
}

/// 默认时区名。
pub const DEFAULT_TZ_NAME: &str = "Asia/Shanghai";

impl AutomationTask {
    /// 解析这个任务自己的时区偏移。
    pub fn tz_offset(&self) -> Result<FixedOffset, TaskError> {
        resolve_tz_offset(&self.tz).ok_or_else(|| {
            invalid(format!(
                "无法识别的时区 {:?}（写法如 Asia/Shanghai）",
                self.tz
            ))
        })
    }

    /// 解析 `HH:MM`。越界报错。
    fn parse_clock(&self) -> Result<(u32, u32), TaskError> {
        let s = self.time.trim();
        let Some((hour, minute)) = s.split_once(':') else {
            return Err(invalid(format!("时间写法应为 HH:MM（收到 {s:?}）")));
        };
        let hour: u32 = hour
            .parse()
            .map_err(|_| invalid(format!("时间写法应为 HH:MM（收到 {s:?}）")))?;
        let minute: u32 = minute
            .parse()
            .map_err(|_| invalid(format!("时间写法应为 HH:MM（收到 {s:?}）")))?;
        if hour > 23 || minute > 59 {
            return Err(invalid(format!("时间超出范围（收到 {s:?}）")));
        }
        Ok((hour, minute))
    }

    fn matches_weekday(&self, weekday: chrono::Weekday) -> bool {
        if self.by_weekday.is_empty() {
            // weekly 却没写周几：按「每天」处理。校验会拦住这种写法，
            // 这里的宽容只是为了「配置被手改坏了也别让调度器崩」。
            return true;
        }
        let index = weekday.num_days_from_sunday();
        self.by_weekday.contains(&index)
    }

    /// 解析 cron 表达式。每次调用都重新解析（不缓存）：解析是微秒级，
    /// 而缓存一个 `CronSpec` 就要加锁。
    fn cron_spec(&self) -> Option<CronSpec> {
        if self.cron.trim().is_empty() {
            return None;
        }
        CronSpec::parse(&self.cron).ok()
    }

    /// `once` 任务的那个时刻。
    fn once_instant(&self, offset: FixedOffset) -> Option<DateTime<FixedOffset>> {
        let raw = self.run_at.trim();
        if raw.is_empty() {
            return None;
        }
        if let Ok(at) = DateTime::parse_from_rfc3339(raw) {
            // ⚠️ **保留输入里的偏移**，不要 `with_timezone(&offset)` 转成任务时区 ——
            // 归一化之后 `runAt` 的**字符串形状**会变（`2026-12-31T16:00:00Z` →
            // `2027-01-01T00:00:00+08:00`），而 Go 那边是 `at.Format(time.RFC3339)`，
            // 原样保留。同一个时刻、两个字符串，管理页把它显示出来 —— 属于线上形状。
            // 2026-09-25 由双跑比对抓到。
            return Some(at);
        }
        // 本地写法：按任务时区解释。
        for layout in ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"] {
            if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(raw, layout) {
                let dt = offset.from_local_datetime(&naive).single()?;
                return Some(dt);
            }
        }
        None
    }

    /// 返回**严格晚于** `after` 的下一次触发时刻（用于展示「下次触发时间」）。
    #[must_use]
    pub fn next_run_after(&self, after: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
        let offset = self.tz_offset().ok()?;
        let after = after.with_timezone(&offset);

        if self.freq == FREQ_CRON {
            return self.cron_spec()?.next(after);
        }
        if self.freq == FREQ_ONCE {
            let at = self.once_instant(offset)?;
            return (at > after).then_some(at);
        }

        let (hour, minute) = self.parse_clock().ok()?;
        // 7 天足够覆盖 weekly 的最坏情况（今天刚过 + 本周最后一个可执行日）。
        for i in 0..=7 {
            let day = after.date_naive() + chrono::Days::new(i);
            let candidate = offset
                .from_local_datetime(&day.and_hms_opt(hour, minute, 0)?)
                .single()?;
            if candidate <= after {
                continue;
            }
            if self.freq == FREQ_WEEKLY && !self.matches_weekday(candidate.weekday()) {
                continue;
            }
            return Some(candidate);
        }
        None
    }

    /// 返回**不晚于** `now` 的最近一次计划触发时刻（用于调度器判到期）。
    ///
    /// 为什么取「最近的过去」而不是「下一次未来」：服务可能重启、机器可能合盖，
    /// 用「下一次未来」判断会让错过的那些**永远没人发现**（now 一直在往后走，
    /// 每次都算出下一个未来时刻，于是那一趟就静静消失了）。取最近的过去 + 幂等键，
    /// 才既能发现「该跑了」，又不会重复跑。
    #[must_use]
    pub fn due_occurrence(&self, now: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
        let offset = self.tz_offset().ok()?;
        let now = now.with_timezone(&offset);

        if self.freq == FREQ_CRON {
            return self.cron_spec()?.prev(now);
        }
        if self.freq == FREQ_ONCE {
            let at = self.once_instant(offset)?;
            return (at <= now).then_some(at);
        }

        let (hour, minute) = self.parse_clock().ok()?;
        for i in 0..=7 {
            let day = now.date_naive() - chrono::Days::new(i);
            let candidate = offset
                .from_local_datetime(&day.and_hms_opt(hour, minute, 0)?)
                .single()?;
            if candidate > now {
                continue;
            }
            if self.freq == FREQ_WEEKLY && !self.matches_weekday(candidate.weekday()) {
                continue;
            }
            return Some(candidate);
        }
        None
    }

    /// 某个触发时刻的幂等键（分钟级）。
    #[must_use]
    pub fn run_key(&self, occurrence: DateTime<FixedOffset>) -> String {
        let offset = self.tz_offset().unwrap_or_else(|_| default_tz_offset());
        occurrence
            .with_timezone(&offset)
            .format(RUN_KEY_LAYOUT)
            .to_string()
    }

    /// 给管理页展示用：下一次触发时刻（Unix 秒）；没有后续触发返回 0。
    #[must_use]
    pub fn next_run_at(&self, now: DateTime<FixedOffset>) -> i64 {
        self.next_run_after(now).map_or(0, |at| at.timestamp())
    }
}

// ── 校验 ──────────────────────────────────────────────────────────────

/// 把客户端传来的任务整理成可落盘的形态，顺带挡掉写错的配置。
///
/// ⚠️ 校验要发生在**保存时**，不是首次触发时。后者意味着用户写完要等一整个周期
/// 才知道时区名拼错了、动作 id 服务端跑不了 —— 而那时房间里已经（或者永远没有）消息了。
pub fn normalize_and_validate(task: &mut AutomationTask) -> Result<(), TaskError> {
    task.name = task.name.trim().to_owned();
    task.freq = task.freq.to_lowercase().trim().to_owned();
    task.time = task.time.trim().to_owned();
    task.cron = task.cron.trim().to_owned();
    task.tz = task.tz.trim().to_owned();
    task.template = task.template.replace("\r\n", "\n");
    task.sender = sanitize_device_name(&task.sender);

    if task.template.is_empty() {
        return Err(invalid("正文不能为空"));
    }
    template::validate(&task.template).map_err(|e| invalid(e.to_string()))?;

    let offset = task.tz_offset()?;

    match task.freq.as_str() {
        FREQ_ONCE => {
            let Some(at) = task.once_instant(offset) else {
                return Err(invalid(
                    "「仅一次」需要 runAt（RFC3339 或 2006-01-02T15:04）",
                ));
            };
            // 归一化成带时区的 RFC3339，落盘之后不再有「按谁的时区解释」这个问题。
            // ⚠️ 用 `format_rfc3339` 而不是 `to_rfc3339()` —— 零偏移要写成 `Z`（见它的注释）。
            task.run_at = format_rfc3339(&at);
            task.time.clear();
            task.by_weekday.clear();
        }
        FREQ_DAILY => {
            task.parse_clock()?;
            task.run_at.clear();
            task.by_weekday.clear();
        }
        FREQ_WEEKLY => {
            task.parse_clock()?;
            if task.by_weekday.is_empty() {
                return Err(invalid("「每周」需要至少选一天"));
            }
            let mut seen = std::collections::BTreeSet::new();
            for &d in &task.by_weekday {
                if d > 6 {
                    return Err(invalid(format!(
                        "星期取值应在 0（周日）到 6（周六）之间，收到 {d}"
                    )));
                }
                seen.insert(d);
            }
            // BTreeSet 天然升序 —— 与 Go 的「去重 + sort.Ints」等价。
            task.by_weekday = seen.into_iter().collect();
            task.run_at.clear();
        }
        FREQ_CRON => {
            let spec = CronSpec::parse(&task.cron).map_err(|e| invalid(e.to_string()))?;
            // 能解析 ≠ 能触发：`0 0 30 2 *`（2 月 30 日）语法完全合法，但永远等不到。
            // 在保存时就算一次未来 —— 否则用户会在几个月后才发现任务从没跑过。
            let now = chrono::Utc::now().with_timezone(&offset);
            if spec.next(now).is_none() {
                return Err(invalid(format!(
                    "cron 表达式 {:?} 在未来算不出任何触发时刻（检查「日」和「月」是不是不可能的组合）",
                    spec.expression()
                )));
            }
            // 归一化：验证通过后写的这份就是唯一写法。
            task.cron = spec.expression().to_owned();
            task.time.clear();
            task.run_at.clear();
            task.by_weekday.clear();
        }
        other => {
            return Err(invalid(format!(
                "频率只能是 once / daily / weekly / cron（收到 {other:?}）"
            )));
        }
    }

    for step in &task.chain {
        if step.id().is_empty() {
            continue;
        }
        if !clip9_actions::is_implemented(step.id()) {
            return Err(invalid(format!(
                "动作 {:?} 不能用于定时任务（服务端可执行的动作见动作库）",
                step.id()
            )));
        }
    }

    if task.name.is_empty() {
        task.name = derive_task_name(&task.template);
    }
    if task.name.chars().count() > NAME_MAX_CHARS {
        task.name = task.name.chars().take(NAME_MAX_CHARS).collect();
    }
    if task.sender.is_empty() {
        task.sender = DEFAULT_SENDER.to_owned();
    }
    Ok(())
}

/// 从模板第一行非空内容推导任务名。
pub fn derive_task_name(tpl: &str) -> String {
    for line in tpl.lines() {
        let line = line.trim();
        if !line.is_empty() {
            let chars: Vec<char> = line.chars().collect();
            if chars.len() > 20 {
                return chars[..20].iter().collect::<String>() + "…";
            }
            return line.to_owned();
        }
    }
    DEFAULT_SENDER.to_owned()
}

/// 剔除控制字符 + 按 rune 截断（与 Go 的 `sanitizeDeviceName` 同义）。
pub fn sanitize_device_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|&c| !(c < '\u{20}' || c == '\u{7f}'))
        .collect();
    let trimmed = cleaned.trim();
    trimmed.chars().take(SENDER_MAX_CHARS).collect()
}

// ── single 档房间的钥匙 ────────────────────────────────────────────────

/// 生成一把任务 token（UUID v4）。
#[must_use]
pub fn new_task_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 算 token 的 SHA-256（十六进制）。存的是它，不是明文。
#[must_use]
pub fn hash_task_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex_encode(&hasher.finalize())
}

/// 常数时间比较 token 与哈希（避免计时侧信道）。
#[must_use]
pub fn task_token_matches(token: &str, hash: &str) -> bool {
    if token.is_empty() || hash.is_empty() {
        return false;
    }
    let candidate = hash_task_token(token);
    // 长度相同（都是 64 个 hex），逐字节常数时间比较。
    let a = candidate.as_bytes();
    let b = hash.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
