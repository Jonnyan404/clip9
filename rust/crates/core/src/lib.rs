//! clip9 领域逻辑。
//!
//! 这里的东西**不含 HTTP** —— 房间鉴权、会话令牌、分享 token、模板引擎、cron 都是纯逻辑，
//! 这样它们能被服务端、客户端、甚至 WASM 侧复用，也才好测（不用起服务器）。

pub mod auth;
pub mod config;
pub mod cron;
pub mod share;
pub mod task;
pub mod template;

pub use auth::{
    AutomationPolicy, RoomAuthRequirement, can_access_room, is_global_admin,
    resolve_automation_policy, resolve_file_expire_seconds, resolve_room_auth, token_matches_room,
};
pub use config::{
    AuthValue, Config, FileConfig, RoomAuthConfig, RoomAuthEntry, ServerConfig, TextConfig,
};
pub use cron::{CronDay, CronDescription, CronError, CronMode, CronSpec};
pub use share::{
    DEFAULT_SHARE_TTL_SECONDS, MAX_SHARE_MAX_USES, MAX_SHARE_TTL_SECONDS, MIN_SHARE_TTL_SECONDS,
    NewShare, PREVIEW_TOKEN_TTL_SECONDS, ROOM_SESSION_TTL_SECONDS, SCOPE_GLOBAL, SESSION_TYPE,
    SHARE_PASSWORD_HASH_LEN, SHARE_PASSWORD_HEADER, SHARE_TOKEN_QUERY_KEY, ShareCheck, ShareClaims,
    ShareKey, ShareVerdict, TYPE_CONTENT, TYPE_FILE, normalize_share_max_uses, normalize_share_ttl,
    should_consume_share_use,
};
pub use template::{RenderContext, TemplateError, latest_rooms, render, validate, variable_names};
