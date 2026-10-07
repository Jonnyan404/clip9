//! 桌面端自动更新的**判定**（纯逻辑：无 IO、无网络、不知道 `/Applications` 存在）。
//!
//! # 为什么判定在这儿、而不是在壳里
//!
//! 照 `CONTRIBUTING §4` 的规矩：**判定在 core，平台动作在壳**。
//! 壳那边（`crates/desktop/src/update.rs`）负责下载、替换、重启、提权；
//! 「这一版装起来了吗」「该不该回滚」这种判断留在这里 —— 它能被单测，
//! 而**装崩了的时候恰恰是最不能靠实机试的时候**。
//!
//! # ⚠️★ 为什么这里**没有**版本比较
//!
//! 因为那件事 `tauri-plugin-updater` 已经做了，而且做得比这里手写的好：
//! 它内部用 `semver` 解析、只把**更新的**版本报上来（预发布版天然排在正式版之前，
//! 所以正式用户不会被 `v0.1.3-beta1` 打扰）。
//!
//! 在这里再抄一份比较逻辑，就是**第二份定义** —— 而两份一定会漂，
//! 这个项目已经为这件事付过几次代价（见 `CONTRIBUTING` 里那条「一份 Rust 编译两次」）。
//! 所以 core 只拿插件**不做**的那两件事：
//!
//! 1. **装完之后到底算不算成功**（[`judge_startup`]）—— 插件不管这个；
//! 2. **用户说过「跳过这一版」**（[`should_offer`]）—— 插件不管这个。

use serde::{Deserialize, Serialize};

/// 连续启动失败几次就认定「这一版装不起来」。
///
/// ⚠️ 为什么不是 1：**一次失败不一定是版本的问题** —— 断电、被系统杀掉、磁盘满了、
/// 用户自己手快点了退出，都会记一次。把阈值设成 1 的话，那些情况会被误判成
/// 「新版本坏了」而回滚掉一个好版本。
///
/// ⚠️ 为什么也不是 10：3 次意味着用户**已经连开三次都没用成** ——
/// 那时候他要的是「回到能用的那一版」，不是再等第四次。
pub const FAILURE_THRESHOLD: u32 = 3;

/// 「上次更新还没被确认」的那条记录。由壳落盘（放在**数据目录**，不在安装目录）。
///
/// ⚠️★ 为什么一定要落盘：判「新版本装崩了」的唯一证据是**上一次启动没能善终**，
/// 而那件事只存在于进程之外。写在安装目录里的话，更新一替换就没了 ——
/// 恰恰在最需要它的时候丢。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartupMarker {
    /// 刚装上、还没被确认的那个版本（`None` = 没有待确认的更新）。
    #[serde(default)]
    pub pending: Option<String>,
    /// 自从装上它以来，**连续**启动了几次都没能确认成功。
    #[serde(default)]
    pub failures: u32,
}

/// 启动自检的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupVerdict {
    /// 没有待确认的更新 —— 正常启动，什么都不用做。
    Healthy,
    /// 刚更新过、还在观察期 —— 保留标记，等这一轮跑满观察期再确认。
    Pending,
    /// 连续失败到阈值 —— **这一版装不起来**，该回滚（或至少告诉用户）。
    RollBack {
        /// 装不起来的那个版本（要报给用户，不然他不知道该躲开哪一版）。
        version: String,
        /// 连续失败了几次。
        failures: u32,
    },
}

/// 记一次启动。**在启动最早期调**（早于任何可能崩的东西）。
///
/// ⚠️ 只有「有待确认的更新」时才累加 —— 正常情况下这个计数器一直是 0，
/// 不会因为用户日常开关机而慢慢爬上去。
pub fn note_start(marker: &mut StartupMarker) {
    if marker.pending.is_some() {
        marker.failures = marker.failures.saturating_add(1);
    }
}

/// 判这一次启动该怎么办。**在 [`note_start`] 之后调**。
#[must_use]
pub fn judge_startup(marker: &StartupMarker) -> StartupVerdict {
    let Some(version) = marker.pending.clone() else {
        return StartupVerdict::Healthy;
    };
    if marker.failures >= FAILURE_THRESHOLD {
        return StartupVerdict::RollBack {
            version,
            failures: marker.failures,
        };
    }
    StartupVerdict::Pending
}

/// 确认这一版能跑（跑满观察期之后调）—— 清掉标记，从此不再数失败。
pub fn confirm(marker: &mut StartupMarker) {
    marker.pending = None;
    marker.failures = 0;
}

/// 刚装完一个版本，写下「待确认」。
pub fn note_installed(marker: &mut StartupMarker, version: impl Into<String>) {
    marker.pending = Some(version.into());
    marker.failures = 0;
}

/// 用户对更新的偏好（界面上能选的那几项）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    /// 用户说过「跳过这一版」的那个版本号。
    ///
    /// ⚠️ 它**只跳过一个具体版本**，不是「以后都别提示我」——
    /// 后者是另一个开关，混在一起的话，用户想跳过 v0.1.3 会连 v0.1.4 一起错过。
    #[serde(default)]
    pub skipped: Option<String>,
}

/// 这个远端版本该不该提示给用户。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 提示。
    Offer,
    /// 用户跳过过这一版 —— 不提示，但**下次有更新的版本照样提示**。
    Skipped,
}

/// 该不该把这个版本提示给用户。
///
/// ⚠️ 只判「用户跳过没有」。**版本新不新由插件判**（见模块头那段）。
#[must_use]
pub fn should_offer(policy: &Policy, version: &str) -> Decision {
    match &policy.skipped {
        Some(skipped) if skipped == version => Decision::Skipped,
        _ => Decision::Offer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★ 正常启动：没有待确认的更新时，什么都不该发生。
    #[test]
    fn healthy_start_is_a_no_op() {
        let mut marker = StartupMarker::default();
        note_start(&mut marker);
        assert_eq!(marker.failures, 0, "没有待确认的更新时计数器不该动");
        assert_eq!(judge_startup(&marker), StartupVerdict::Healthy);
    }

    /// ★★ 装崩了的那条路：连续启动到阈值 → 判回滚，并**报出是哪个版本**。
    ///
    /// ⚠️ 这条是这次更新里**唯一**「新版本装不起来」的兜底。
    /// 判错的表现是：应用打不开、而且**每次重开都一样**（用户唯一的出路是重装）。
    #[test]
    fn three_failed_starts_ask_for_a_rollback() {
        let mut marker = StartupMarker::default();
        note_installed(&mut marker, "0.1.3");

        note_start(&mut marker);
        assert_eq!(
            judge_startup(&marker),
            StartupVerdict::Pending,
            "第 1 次还不该回滚"
        );

        note_start(&mut marker);
        assert_eq!(
            judge_startup(&marker),
            StartupVerdict::Pending,
            "第 2 次也再给一次机会"
        );

        note_start(&mut marker);
        assert_eq!(
            judge_startup(&marker),
            StartupVerdict::RollBack {
                version: "0.1.3".to_owned(),
                failures: 3,
            },
            "第 3 次：用户连开三次都没用成，该回滚了"
        );
    }

    /// ★ 确认成功之后：标记清掉、计数器归零，**再启动就是健康**。
    ///
    /// ⚠️ 少了 `confirm` 那一半，症状是「用得好好的应用，某天忽然说要回滚」——
    /// 因为计数器在几次正常开关机之后自己爬到了阈值。
    #[test]
    fn confirming_clears_the_marker_and_the_counter() {
        let mut marker = StartupMarker::default();
        note_installed(&mut marker, "0.1.3");
        note_start(&mut marker);
        note_start(&mut marker);
        assert_eq!(marker.failures, 2);

        confirm(&mut marker);
        assert_eq!(marker, StartupMarker::default(), "确认之后应当回到初始状态");

        // 再启动几次也不会攒出回滚
        for _ in 0..5 {
            note_start(&mut marker);
        }
        assert_eq!(judge_startup(&marker), StartupVerdict::Healthy);
    }

    /// 装了新版本会**重置**计数（上一版的失败不该算到这一版头上）。
    #[test]
    fn installing_again_resets_the_counter() {
        let mut marker = StartupMarker::default();
        note_installed(&mut marker, "0.1.3");
        note_start(&mut marker);
        note_start(&mut marker);
        assert_eq!(marker.failures, 2);

        note_installed(&mut marker, "0.1.4");
        assert_eq!(marker.failures, 0, "换了版本，计数从头开始");
        assert_eq!(marker.pending.as_deref(), Some("0.1.4"));
    }

    /// ★ 「跳过这一版」**只跳这一版**，下一版照样提示。
    ///
    /// ⚠️ 写成「跳过 = 以后都别提示」的话，用户想躲开一个坏版本，
    /// 结果连后面的修复版一起错过了 —— 而那正是他最需要的那一版。
    #[test]
    fn skipping_one_version_does_not_mute_the_next() {
        let policy = Policy {
            skipped: Some("0.1.3".to_owned()),
        };
        assert_eq!(
            should_offer(&policy, "0.1.3"),
            Decision::Skipped,
            "这一版跳过"
        );
        assert_eq!(
            should_offer(&policy, "0.1.4"),
            Decision::Offer,
            "下一版照样提示"
        );
    }

    /// 没有跳过记录时一律提示。
    #[test]
    fn no_skip_record_offers_everything() {
        let policy = Policy::default();
        assert_eq!(should_offer(&policy, "0.1.3"), Decision::Offer);
    }

    /// 标记能原样过一遍 JSON（它要落盘，形状就是契约）。
    #[test]
    fn marker_round_trips_through_json() {
        let marker = StartupMarker {
            pending: Some("0.1.3".to_owned()),
            failures: 2,
        };
        let text = serde_json::to_string(&marker).expect("序列化");
        assert_eq!(
            serde_json::from_str::<StartupMarker>(&text).expect("反序列化"),
            marker
        );
        // ⚠️ 老文件缺字段也要能读（升级那一刻，盘上那份是上一版写的）
        let old: StartupMarker = serde_json::from_str("{}").expect("缺字段要能读");
        assert_eq!(old, StartupMarker::default());
    }
}
