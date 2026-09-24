//! clip9 领域逻辑。
//!
//! 这里的东西**不含 HTTP** —— 房间鉴权、会话令牌、分享 token、模板引擎、cron 都是纯逻辑，
//! 这样它们能被服务端、客户端、甚至 WASM 侧复用，也才好测（不用起服务器）。

pub mod auth;
pub mod config;

pub use auth::{
    can_access_room, is_global_admin, resolve_automation_policy, resolve_file_expire_seconds,
    resolve_room_auth, token_matches_room, AutomationPolicy, RoomAuthRequirement,
};
pub use config::{
    AuthValue, Config, FileConfig, RoomAuthConfig, RoomAuthEntry, ServerConfig, TextConfig,
};
