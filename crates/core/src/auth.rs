//! 房间鉴权。
//!
//! 对应 Go `auth.go`。这里的每一条分支都对应一个**已经踩过的坑**，
//! 所以注释比代码多 —— 改之前先把注释读完。

use clip9_protocol::normalize_room_name;

use crate::config::Config;
use crate::share::ShareKey;

/// 一个房间的鉴权结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomAuthRequirement {
    /// 归一化后的房间名。
    pub room: String,
    /// ⚠️ **实际要不要密码** —— 不是「`roomAuth` 里有没有这一项」。
    ///
    /// `{"open": true}` 有配置项但**不要**密码；没配过 + 有全局密码**要**密码却没有配置项。
    /// 全仓库算它的唯一出口就是 `resolve_room_auth(...).required`。
    pub required: bool,
    /// 生效的密码。`required == false` 时无意义。
    pub password: String,
    /// 该房间配置里的自动化策略原样（`"none"` / `"single"` / `"room"` / 空）。
    pub automation: String,
    /// `None` = 用全局 `file.expire`；`Some(0)` = 该房间文件永不过期；`Some(n>0)` = 覆盖秒数。
    pub file_expire: Option<i64>,
}

/// 算出这个房间到底要不要密码。
///
/// 判定顺序（**顺序本身就是语义**，别重排）：
///
/// 1. 房间自己带密码 → 用它。全局密码**仍然有效** ——
///    `roomAuth` 是「多给一把钥匙」，不是「换锁」。
/// 2. 显式 `open: true` → 不要密码，**不回落全局 auth**。
///    这就是「全局加密 + 个别房间开放」的表达方式。
/// 3. 没配过、或配了个空密码 → 回落全局 `auth`（旧行为，别改回去）。
#[must_use]
pub fn resolve_room_auth(config: &Config, room: &str) -> RoomAuthRequirement {
    let normalized = normalize_room_name(room);
    let global_password = config.server.auth.normalize();
    let entry = config.server.room_auth.get(&normalized);

    let (file_expire, automation) = match entry {
        Some(e) => (e.file_expire, e.automation.clone()),
        None => (None, String::new()),
    };

    // 1. 房间自带密码。
    // ⚠️ 同时写了 `open` 和 `password` 是配置写错了。**密码优先** ——
    // 宁可多要一次密码，也不能因为配置里多打了一个字段就把房间敞开。
    if let Some(e) = entry {
        if !e.password.is_empty() {
            return RoomAuthRequirement {
                room: normalized,
                required: true,
                password: e.password.clone(),
                automation,
                file_expire,
            };
        }
        // 2. 显式开放。
        if e.open {
            return RoomAuthRequirement {
                room: normalized,
                required: false,
                password: String::new(),
                automation,
                file_expire,
            };
        }
    }

    // 3. 回落全局 auth。
    if !global_password.is_empty() {
        return RoomAuthRequirement {
            room: normalized,
            required: true,
            password: global_password,
            automation,
            file_expire,
        };
    }

    RoomAuthRequirement {
        room: normalized,
        required: false,
        password: String::new(),
        automation,
        file_expire,
    }
}

/// 这个房间文件上传生效的过期秒数：0 = 永不过期，>0 = 秒数。
///
/// ⚠️ 负数是配置写错了 → 回落全局并**告警**，不是当成 0（当成 0 就等于「永不过期」，
/// 那是把一次笔误放大成磁盘被写满）。
#[must_use]
pub fn resolve_file_expire_seconds(config: &Config, room: &str) -> i64 {
    let global = config.file.expire;
    match resolve_room_auth(config, room).file_expire {
        None => global,
        Some(v) if v < 0 => global,
        Some(v) => v,
    }
}

/// 这个凭据对这个房间有效吗？
///
/// 判定顺序（**顺序本身就是语义**，别重排）：
/// 1. **会话令牌**（`/auth/token` 换来的）—— 它带着房间与作用域，`scope: "global"` 对所有房间有效；
/// 2. 全局密码；
/// 3. 房间密码。
///
/// ⚠️ 会话令牌与密码的**区别**在这里体现：会话令牌是签过名的、会过期的、可撤销的（换密码即失效），
/// 而明文密码永远有效。所以两者都要认 —— 老客户端和脚本传的就是明文。
///
/// ⚠️ 但**房间会话令牌不算管理员**：它按房间签发，拿它当管理员等于把「能进这个房间」
/// 放大成「能管所有房间」。管理员只有两个来源：明文全局密码，或**用全局密码换来的**
/// `scope: "global"` 会话令牌（管理页不存明文密码，少了这一条，管理页里的「管理员」就不成立）。
#[must_use]
pub fn token_matches_room(
    config: &Config,
    share_key: &ShareKey,
    room: &str,
    token: &str,
    now: i64,
) -> bool {
    if token.is_empty() {
        return false;
    }

    if share_key.session_matches_room(room, token, now) {
        return true;
    }

    let global_password = config.server.auth.normalize();
    if !global_password.is_empty() && token == global_password {
        return true;
    }

    let normalized = normalize_room_name(room);
    match config.server.room_auth.get(&normalized) {
        Some(e) if !e.password.is_empty() => token == e.password,
        _ => false,
    }
}

/// 能不能进这个房间。
///
/// ⚠️ **全仓库唯一的入口**。`server` 那边不要再包一个 `room_password_ok(...)` 之类的
/// 第二实现 —— 这个项目已经被「两份实现慢慢漂开」咬过多次（见 `CONTRIBUTING.md` §6）。
/// 服务端包的那一层（`AppState::can_access_room`）只负责把配置、密钥和当前时间注入进来。
#[must_use]
pub fn can_access_room(
    config: &Config,
    share_key: &ShareKey,
    room: &str,
    token: &str,
    now: i64,
) -> bool {
    let requirement = resolve_room_auth(config, room);
    if !requirement.required {
        return true;
    }
    token_matches_room(config, share_key, room, token, now)
}

/// 这个凭据是不是**全局密码**（= 管理员）。
///
/// ⚠️ 「全局密码 = 管理员」不是代码能决定的事，是**部署约定**：
/// 如果部署者把它给全家共用，那在这个模型里「所有人都是管理员」。
/// 所以留了 `automation: "none"` 这个配置层开关 —— 写了它，连全局密码也改不了那个房间。
/// 「配置层 > 运行时最高权限」这个性质本身就是安全设计。
#[must_use]
pub fn is_global_admin(config: &Config, token: &str) -> bool {
    let global_password = config.server.auth.normalize();
    !global_password.is_empty() && token == global_password
}

/// 定时任务的房间策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationPolicy {
    None,
    Single,
    Room,
}

impl AutomationPolicy {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            AutomationPolicy::None => "none",
            AutomationPolicy::Single => "single",
            AutomationPolicy::Room => "room",
        }
    }
}

/// 算出房间的自动化策略：`none` | `single` | `room`。
///
/// 未显式配置时跟随房间鉴权档位：有密码 → `room`（持有房间密码 = 这个房间的成员），
/// 公开房间 → `none`。
///
/// ⚠️ 默认值这样定的理由：这条默认让「什么都没配」的部署行为**完全不变**，
/// 要开必须显式配。安全设置不该靠推断悄悄放宽 —— 但也不该把门彻底焊死，
/// 所以 `automation` 是配置项而不是硬编码分支。
///
/// ⚠️ 认不出的值（比如写成 `"enable"`）按**最保守**处理（`none`）。
/// 宁可功能不出现，也不能因为配置里多打了一个认不出的词就把房间敞开。
#[must_use]
pub fn resolve_automation_policy(config: &Config, room: &str) -> AutomationPolicy {
    let requirement = resolve_room_auth(config, room);
    match requirement.automation.to_lowercase().trim() {
        "none" => AutomationPolicy::None,
        "single" => AutomationPolicy::Single,
        "room" => AutomationPolicy::Room,
        "" => {
            if requirement.required {
                AutomationPolicy::Room
            } else {
                AutomationPolicy::None
            }
        }
        _ => AutomationPolicy::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AuthValue, RoomAuthEntry};
    use crate::share::{
        DEFAULT_SHARE_TTL_SECONDS, ROOM_SESSION_TTL_SECONDS, SCOPE_GLOBAL, ShareKey,
    };

    /// 测试用的固定时刻（钥匙派生出来的会话令牌要有一个确定的「现在」）。
    const NOW: i64 = 1_700_000_000;

    /// 测试里「能不能进」统一走这个包一层，省得每行都拼密钥和时刻。
    fn key(config: &Config) -> ShareKey {
        ShareKey::derive(config, b"test-salt")
    }

    fn can_enter(config: &Config, room: &str, token: &str) -> bool {
        can_access_room(config, &key(config), room, token, NOW)
    }

    fn cfg_with(global: AuthValue, entries: &[(&str, RoomAuthEntry)]) -> Config {
        let mut c = Config::default();
        c.server.auth = global;
        for (room, entry) in entries {
            c.server
                .room_auth
                .0
                .insert((*room).to_owned(), entry.clone());
        }
        c
    }

    fn pw(p: &str) -> RoomAuthEntry {
        RoomAuthEntry {
            password: p.to_owned(),
            ..RoomAuthEntry::default()
        }
    }

    fn open() -> RoomAuthEntry {
        RoomAuthEntry {
            open: true,
            ..RoomAuthEntry::default()
        }
    }

    #[test]
    fn nothing_configured_means_open() {
        let c = Config::default();
        let r = resolve_room_auth(&c, "");
        assert!(!r.required);
        assert_eq!(r.room, "default");
    }

    #[test]
    fn global_password_protects_unconfigured_rooms() {
        let c = cfg_with(AuthValue::Str("global".into()), &[]);
        let r = resolve_room_auth(&c, "work");
        assert!(r.required);
        assert_eq!(r.password, "global");
        assert!(can_enter(&c, "work", "global"));
        assert!(!can_enter(&c, "work", ""));
    }

    /// ⚠️ 这条是「全局加密 + 个别房间开放」的全部实现 —— 开放房间**不**回落全局密码。
    #[test]
    fn open_room_ignores_global_password() {
        let c = cfg_with(AuthValue::Str("global".into()), &[("public", open())]);
        let r = resolve_room_auth(&c, "public");
        assert!(!r.required, "open 的房间即使有全局密码也不要密码");
        assert!(can_enter(&c, "public", ""));
        assert!(can_enter(&c, "public", "随便什么"));
    }

    /// ⚠️ 房间密码是**多给一把钥匙**，不是换锁 —— 全局密码对那个房间仍然有效。
    #[test]
    fn room_password_adds_a_key_does_not_replace_the_lock() {
        let c = cfg_with(AuthValue::Str("global".into()), &[("work", pw("roompw"))]);
        let r = resolve_room_auth(&c, "work");
        assert!(r.required);
        assert_eq!(r.password, "roompw", "生效的密码是房间自己的");
        assert!(can_enter(&c, "work", "roompw"));
        assert!(can_enter(&c, "work", "global"), "全局密码仍然能进");
        assert!(!can_enter(&c, "work", "nope"));
    }

    /// ⚠️ 配置里同时写了 `open` 和 `password` → **密码优先**。
    /// 宁可多要一次密码，也不能因为多打一个字段就把房间敞开。
    #[test]
    fn password_wins_over_open() {
        let c = cfg_with(
            AuthValue::Bool(false),
            &[(
                "work",
                RoomAuthEntry {
                    password: "pw".into(),
                    open: true,
                    ..RoomAuthEntry::default()
                },
            )],
        );
        assert!(resolve_room_auth(&c, "work").required);
    }

    /// 空密码 + 全局密码 → 回落全局（旧行为，别改回去）。
    #[test]
    fn empty_room_password_falls_back_to_global() {
        let c = cfg_with(AuthValue::Str("global".into()), &[("work", pw(""))]);
        let r = resolve_room_auth(&c, "work");
        assert!(r.required);
        assert_eq!(r.password, "global");
    }

    #[test]
    fn room_key_is_normalized_before_lookup() {
        let c = cfg_with(AuthValue::Bool(false), &[("default", pw("d"))]);
        // 空房间名 = default 房间，要命中 `default` 那一条。
        assert!(resolve_room_auth(&c, "").required);
        assert!(resolve_room_auth(&c, "  default  ").required);
    }

    #[test]
    fn negative_file_expire_falls_back_to_global() {
        let mut c = Config::default();
        c.file.expire = 3600;
        c.server.room_auth.0.insert(
            "work".into(),
            RoomAuthEntry {
                file_expire: Some(-5),
                ..RoomAuthEntry::default()
            },
        );
        assert_eq!(resolve_file_expire_seconds(&c, "work"), 3600);
    }

    #[test]
    fn file_expire_zero_means_never_expires() {
        let mut c = Config::default();
        c.file.expire = 3600;
        c.server.room_auth.0.insert(
            "work".into(),
            RoomAuthEntry {
                file_expire: Some(0),
                ..RoomAuthEntry::default()
            },
        );
        assert_eq!(resolve_file_expire_seconds(&c, "work"), 0);
    }

    #[test]
    fn automation_policy_defaults_follow_auth() {
        let open_cfg = Config::default();
        assert_eq!(
            resolve_automation_policy(&open_cfg, "work"),
            AutomationPolicy::None,
            "公开房间默认不给自动化"
        );

        let locked = cfg_with(AuthValue::Str("global".into()), &[]);
        assert_eq!(
            resolve_automation_policy(&locked, "work"),
            AutomationPolicy::Room,
            "有密码 → 持密码者即成员"
        );
    }

    #[test]
    fn automation_policy_explicit_wins_and_unknown_is_conservative() {
        let mut c = Config::default();
        c.server.auth = AuthValue::Str("global".into());
        c.server.room_auth.0.insert(
            "work".into(),
            RoomAuthEntry {
                automation: "single".into(),
                ..RoomAuthEntry::default()
            },
        );
        assert_eq!(
            resolve_automation_policy(&c, "work"),
            AutomationPolicy::Single
        );

        c.server.room_auth.0.insert(
            "work".into(),
            RoomAuthEntry {
                automation: "enable".into(), // 写错了
                ..RoomAuthEntry::default()
            },
        );
        assert_eq!(
            resolve_automation_policy(&c, "work"),
            AutomationPolicy::None,
            "认不出的值必须按最保守处理"
        );
    }

    /// ⚠️ 「配置层 > 运行时最高权限」：`automation: "none"` 连全局密码也改不了那个房间。
    #[test]
    fn explicit_none_beats_global_admin() {
        let mut c = Config::default();
        c.server.auth = AuthValue::Str("global".into());
        c.server.room_auth.0.insert(
            "locked".into(),
            RoomAuthEntry {
                automation: "none".into(),
                ..RoomAuthEntry::default()
            },
        );
        assert!(is_global_admin(&c, "global"));
        assert_eq!(
            resolve_automation_policy(&c, "locked"),
            AutomationPolicy::None
        );
    }

    /// ⚠️★ 会话令牌必须能进它自己的房间 —— 而且**只**能进它自己的房间。
    ///
    /// 这条测试防的是「两张令牌可以互换使用」：`typ`、`room`、`id` 三个字段都得对上，
    /// 少对任何一个，A 房间的令牌就能读 B 房间的内容，而界面上看不出任何异常。
    #[test]
    fn room_session_token_opens_its_room_and_nothing_else() {
        let c = cfg_with(AuthValue::Str("global".into()), &[("secret", pw("roompw"))]);
        let key = key(&c);
        let (token, exp) = key.session_token("secret", ROOM_SESSION_TTL_SECONDS, None, NOW);
        assert_eq!(exp, NOW + ROOM_SESSION_TTL_SECONDS);

        assert!(can_enter(&c, "secret", &token));
        assert!(
            !can_enter(&c, "other", &token),
            "房间令牌不能开后门到别的房间"
        );
        assert!(
            !can_enter(&c, "default", &token),
            "房间令牌不能被当成全局令牌用"
        );
        // 明文密码依然有效（老客户端/脚本走的就是这条路）。
        assert!(can_enter(&c, "secret", "roompw"));
    }

    /// 全局会话令牌对所有房间有效 —— 管理页就是这么用的（它不存明文密码）。
    #[test]
    fn global_session_token_opens_every_room() {
        let c = cfg_with(AuthValue::Str("global".into()), &[("secret", pw("roompw"))]);
        let key = key(&c);
        let (token, _) =
            key.session_token("default", ROOM_SESSION_TTL_SECONDS, Some(SCOPE_GLOBAL), NOW);

        assert!(can_enter(&c, "default", &token));
        assert!(can_enter(&c, "secret", &token));
        assert!(can_enter(&c, "从来没有配过的房间", &token));
    }

    /// 过期的会话令牌一律作废 —— 时间由调用方给，所以这条不需要等一小时。
    #[test]
    fn expired_session_token_is_rejected() {
        let c = cfg_with(AuthValue::Str("global".into()), &[]);
        let key = key(&c);
        let (token, exp) = key.session_token("default", 60, Some(SCOPE_GLOBAL), NOW);

        assert!(can_enter(&c, "default", &token));
        assert!(
            !can_access_room(&c, &key, "default", &token, exp + 1),
            "过期之后必须失效（exp 是闭区间：exp+1 才过期）"
        );
    }

    /// ⚠️ 别的用途的令牌（内容分享）**不能**当会话令牌用。
    /// 只读的内容分享令牌如果能进房间，分享就变成了「给别人开了一个房间账号」。
    #[test]
    fn content_share_token_is_not_a_session_token() {
        let c = cfg_with(AuthValue::Str("global".into()), &[]);
        let key = key(&c);
        let (claims, _) = key.share_claims(crate::share::NewShare {
            share_type: crate::share::TYPE_CONTENT,
            id: "7",
            room: "default",
            ttl_seconds: DEFAULT_SHARE_TTL_SECONDS,
            max_uses: 0,
            password: "",
            jti: "jti-1".to_owned(),
            now: NOW,
        });
        let token = key.sign(&claims);
        assert!(!can_enter(&c, "default", &token));
    }
}
