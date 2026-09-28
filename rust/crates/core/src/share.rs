//! 分享令牌、会话令牌、预览令牌。
//!
//! 对应 Go `share_token.go`。这里是**签发与校验的唯一实现** —— 服务端不许自己再写一份。
//!
//! # token 的形状（**契约**，别改）
//!
//! ```text
//! base64url_nopad(JSON claims) + "." + base64url_nopad(HMAC-SHA256(签名密钥, 前半段))
//! ```
//!
//! claims 的字段名照抄 Go 的 json tag：`typ` / `id` / `room` / `sc` / `exp` / `jti` / `mu` / `p`。
//! 三种 `typ` 共用同一个信封：`content`（一条内容）、`file`（一个上传文件）、`room_session`
//! （会话令牌）。**同一个密钥**签它们，靠 `typ` 区分用途 —— 所以每个校验点都必须先看 `typ`，
//! 否则一张只读的内容分享令牌会被当成能进整个房间的会话令牌。
//!
//! # 密钥怎么来
//!
//! [`ShareKey::derive`]：`SHA256("clip9-share-v1" || 0 || 全局密码 || 各房间(0||房间||0||密码))`。
//! 用配置派生而不是随机密钥，是为了**重启后已发出的分享链接不失效**；配置里一个字都没配时
//! 再混入调用方给的随机盐（那时也没有别的秘密可保护）。
//!
//! ⚠️ 派生输入里**只有密码**：改了全局密码或房间密码，所有未过期的分享链接会一起失效。
//! 这是刻意的（密码是这项部署的根秘密），但要写进换密码的操作说明里。
//!
//! # 为什么 core 不自己取随机数
//!
//! `jti`（分享的档案号）与无配置时的盐都由**调用方**给：一是单测要能确定复现，
//! 二是 `core` 要保持能被编到 `wasm32`（`getrandom` 在 `wasm32-unknown-unknown` 上要额外
//! feature，加上去会变成给前端编译时的隐藏地雷）。服务端用的是 `uuid` v4（本来就在依赖里，
//! 底层就是系统随机源）。

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use clip9_protocol::normalize_room_name;

use crate::config::Config;

type HmacSha256 = Hmac<Sha256>;

/// 派生密钥时的域分隔标签。改它 = 让所有已发出的分享链接失效。
///
/// ⚠️ 这是 clip9 自己的标签：独立成独立项目时从 `cloud-clipboard-share-v1` 改成了这个，
/// 所以**同一份配置在 clip9 与 Go 版上算出来的密钥不同** —— 两边的分享链接互不通用。
/// 这是有意的（不要求兼容旧项目），代价是升级时已发出的链接全部失效。
const SHARE_KEY_LABEL: &[u8] = b"clip9-share-v1";

/// 分享有效期默认值（15 分钟）。
pub const DEFAULT_SHARE_TTL_SECONDS: i64 = 15 * 60;
/// 分享有效期下限。TTL 小于它会被**抬到**它（不是报错）。
pub const MIN_SHARE_TTL_SECONDS: i64 = 60;
/// 分享有效期上限（24 小时）。
pub const MAX_SHARE_TTL_SECONDS: i64 = 24 * 60 * 60;
/// `maxUses` 上限。超过就夹到这个值。
pub const MAX_SHARE_MAX_USES: i64 = 1000;

/// 分享令牌在 URL 里的参数名（`?t=`）。预览令牌走的也是它。
pub const SHARE_TOKEN_QUERY_KEY: &str = "t";
/// 分享密码的请求头名。**绝不进 URL** —— query 会进浏览器历史和服务器访问日志。
pub const SHARE_PASSWORD_HEADER: &str = "X-Share-Password";
/// 存进 token 的密码哈希长度（十六进制字符数）。只存前 16 位：它是「密码对不对」的
/// 比对值，不是密码本身，短一点无所谓，但要能防离线爆破（所以是 HMAC 而不是裸哈希）。
pub const SHARE_PASSWORD_HASH_LEN: usize = 16;

/// 预览令牌有效期（10 分钟）。
pub const PREVIEW_TOKEN_TTL_SECONDS: i64 = 10 * 60;
/// 会话令牌有效期（1 小时）。
pub const ROOM_SESSION_TTL_SECONDS: i64 = 60 * 60;
/// 会话令牌的 `typ`。
pub const SESSION_TYPE: &str = "room_session";
/// 会话令牌的全局作用域标记（`sc` 字段）。
pub const SCOPE_GLOBAL: &str = "global";
/// 分享指向一条内容的 `typ`。
pub const TYPE_CONTENT: &str = "content";
/// 分享指向一个上传文件的 `typ`。
pub const TYPE_FILE: &str = "file";

/// 一张分享令牌/会话令牌里的声明。
///
/// ⚠️ 字段顺序 = Go 结构体的顺序，`Option` + `skip_serializing_if` = Go 的 `omitempty`。
/// 顺序不影响校验，但影响**签出来的字节**：同一个 claims 用两种顺序签会得到两个 token，
/// 而 token 会进用户剪贴板、二维码、聊天记录 —— 能逐字节对上才方便排查。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareClaims {
    /// content | file | room_session
    #[serde(rename = "typ")]
    pub share_type: String,
    /// content id / file uuid / 房间名（会话令牌时）
    #[serde(rename = "id")]
    pub id: String,
    /// 绑定的房间（归一化过，默认房间是 `default`）
    #[serde(rename = "room")]
    pub room: String,
    /// 会话令牌的作用域：`None` = 房间专属，`Some("global")` = 对所有房间有效。
    ///
    /// ⚠️ 用 `Option` 而不是空串：Go 那边是 `omitempty`，空串不出现在 JSON 里，
    /// 用 `String` 会让签出来的 token 多一个 `"sc":""`。
    #[serde(rename = "sc", default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// 过期时刻（Unix 秒）。**必须有**，没有的话解析直接判无效。
    #[serde(rename = "exp")]
    pub exp: i64,
    /// 档案号：分享记录（`/share/list`）与用量计数的键。
    #[serde(rename = "jti", default, skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
    /// 次数上限。`None` / `<= 0` = 不限次。
    #[serde(rename = "mu", default, skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i64>,
    /// 分享密码的哈希（十六进制前 16 位）。`None` = 这条分享不要密码。
    #[serde(rename = "p", default, skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
}

impl ShareClaims {
    /// 次数上限，负数一律当「不限次」。
    #[must_use]
    pub fn max_uses(&self) -> i64 {
        self.max_uses.unwrap_or(0).max(0)
    }

    /// 这条分享要不要密码。
    #[must_use]
    pub fn needs_password(&self) -> bool {
        self.password_hash.as_ref().is_some_and(|h| !h.is_empty())
    }

    /// 是不是「对所有房间有效」的会话令牌。
    #[must_use]
    pub fn is_global_scope(&self) -> bool {
        self.scope.as_deref() == Some(SCOPE_GLOBAL)
    }

    /// 档案号（没有就是空串）。
    #[must_use]
    pub fn jti_str(&self) -> &str {
        self.jti.as_deref().unwrap_or("")
    }
}

/// 分享令牌的签名密钥。
///
/// 服务端启动时 [`ShareKey::derive`] 一次，之后只读共享（`&` 就够，不需要锁）。
#[derive(Clone)]
pub struct ShareKey {
    key: [u8; 32],
}

/// ⚠️ 手写 `Debug`：derive 出来的版本会把密钥打进日志。
/// 密钥能从配置算出来，但仍然不该出现在任何一行日志里。
impl fmt::Debug for ShareKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ShareKey(<redacted>)")
    }
}

impl ShareKey {
    /// 从配置派生密钥。`fallback_salt` 只在**配置里一个密码都没有**时用得上。
    ///
    /// 派生输入与 Go 逐字一致（房间按名字升序，`BTreeMap` 的迭代顺序就是它）：
    /// ```text
    /// SHA256("clip9-share-v1" || 0 || 全局密码 || Σ(0 || 房间 || 0 || 房间密码))
    /// ```
    /// 没有认证材料时再套一层 `SHA256(上面那份 || fallback_salt)`。
    ///
    /// ⚠️ **只有那个域分隔标签与 Go 不同**（见 [`SHARE_KEY_LABEL`]）—— 算式其余部分逐字照抄，
    /// 所以算法本身仍然被 `cases/share/tokens.json` 那份夹具钉着。
    ///
    /// ⚠️ 加了盐就**不能**在重启后保持稳定（盐是每进程随机的）—— 但没有密码的部署本来
    /// 就没有「分享链接」以外的秘密，Go 那边同样如此。
    #[must_use]
    pub fn derive(config: &Config, fallback_salt: &[u8]) -> Self {
        let global = config.server.auth.normalize();
        let rooms = &config.server.room_auth.0;

        let mut hasher = Sha256::new();
        hasher.update(SHARE_KEY_LABEL);
        hasher.update([0]);
        hasher.update(global.as_bytes());
        for (room, entry) in rooms {
            hasher.update([0]);
            hasher.update(room.as_bytes());
            hasher.update([0]);
            hasher.update(entry.password.as_bytes());
        }
        let mut derived = hasher.finalize();

        if global.is_empty() && rooms.is_empty() {
            let mut salted = Sha256::new();
            salted.update(derived);
            salted.update(fallback_salt);
            derived = salted.finalize();
        }

        Self {
            key: derived.into(),
        }
    }

    fn mac(&self) -> HmacSha256 {
        // HMAC 接受任意长度的密钥，这里不可能失败（`new_from_slice` 的 Result 是给
        // 固定长度密钥的算法准备的）。真失败了也只能是编程错误，不该静默继续。
        HmacSha256::new_from_slice(&self.key).expect("HMAC-SHA256 接受任意长度的密钥")
    }

    /// 密钥的十六进制指纹。
    ///
    /// ⚠️ **只给契约 fixture 测试用**（`tests/share_tokens.rs` 拿它和 Go 导出的 `keyHex` 对比）。
    /// 密钥能从配置算出来，所以这不是泄密；但**别把它写进日志**，也别拿它当「密钥 ID」用 ——
    /// 它和密钥是同一件事，改名不改变这个事实。
    #[must_use]
    pub fn key_fingerprint_hex(&self) -> String {
        to_hex(&self.key)
    }

    /// 密码 → 存进 token 的短哈希。空密码返回空串（= 这条分享不要密码）。
    ///
    /// 用**带密钥**的 HMAC 而不是裸 `SHA256(密码)`：token 在 URL 里，裸哈希能被离线爆破
    /// （「1234」这种密码一秒就出来）；带密钥的算不出来，除非先拿到服务端密钥。
    #[must_use]
    pub fn password_hash(&self, password: &str) -> String {
        let password = password.trim();
        if password.is_empty() {
            return String::new();
        }
        let mut mac = self.mac();
        mac.update(b"share-password:");
        mac.update(password.as_bytes());
        let digest = mac.finalize().into_bytes();
        to_hex(&digest)[..SHARE_PASSWORD_HASH_LEN].to_owned()
    }

    /// 这个请求头里的密码对不对。
    ///
    /// ⚠️ 常数时间比较：字符串 `==` 在第一个不同的字节就返回，能按时间差逐字节猜出哈希。
    #[must_use]
    pub fn password_matches(&self, expected_hash: &str, password: &str) -> bool {
        if expected_hash.is_empty() {
            return true;
        }
        constant_time_eq(
            self.password_hash(password).as_bytes(),
            expected_hash.as_bytes(),
        )
    }

    /// 签发一串令牌。
    ///
    /// 形状：`base64url_nopad(JSON) + "." + base64url_nopad(HMAC-SHA256(密钥, 前半段))`。
    /// 签的是**编码后的前半段**而不是原始 JSON —— 免得 base64 的两种等价写法给出两个不同的
    /// 签名（Go 也是这么做的）。
    #[must_use]
    pub fn sign(&self, claims: &ShareClaims) -> String {
        // ⚠️ 这里**不能**写 `unwrap_or_default()`：序列化失败时它会静默签出一个空 payload 的串
        // （`parse` 必然拒绝），表现为「签发成功了但链接用不了」，而且没有任何日志 ——
        // 正是 `CONTRIBUTING.md` §6 点名的「用默认值掩盖失败」。
        // claims 只有 `String` / `i64` / `Option<String>`，序列化不可能失败；真失败了说明
        // 这个结构被改错了，那是该当场炸掉的事，不该悄悄降级成一个废 token。
        let payload = serde_json::to_vec(claims)
            .expect("ShareClaims 只有 String / i64 / Option<String>，序列化不会失败");
        let payload_part = URL_SAFE_NO_PAD.encode(payload);

        let mut mac = self.mac();
        mac.update(payload_part.as_bytes());
        let signature_part = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        format!("{payload_part}.{signature_part}")
    }

    /// 校验并解析一串令牌。`None` = 无效（签名不对 / 结构不对 / 已过期 / 缺字段）。
    ///
    /// ⚠️ 判定顺序与 Go 一致，**先验签名再看内容** —— 反过来等于让任何人都能用任意 payload
    /// 探测解析行为。
    #[must_use]
    pub fn parse(&self, token: &str, now: i64) -> Option<ShareClaims> {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }

        // Go 用 `strings.Split` + `len(parts) != 2`：多一个点就是无效，不是「取前两段」。
        let mut parts = token.split('.');
        let (payload_part, signature_part) = (parts.next()?, parts.next()?);
        if parts.next().is_some() || payload_part.is_empty() || signature_part.is_empty() {
            return None;
        }

        let signature = URL_SAFE_NO_PAD.decode(signature_part).ok()?;
        let mut mac = self.mac();
        mac.update(payload_part.as_bytes());
        // `verify_slice` 是常数时间比较 —— 别换成 `==`。
        mac.verify_slice(&signature).ok()?;

        let payload = URL_SAFE_NO_PAD.decode(payload_part).ok()?;
        let mut claims: ShareClaims = serde_json::from_slice(&payload).ok()?;

        claims.share_type = claims.share_type.trim().to_owned();
        claims.id = claims.id.trim().to_owned();
        claims.room = normalize_room_name(&claims.room);
        claims.jti = claims
            .jti
            .map(|j| j.trim().to_owned())
            .filter(|j| !j.is_empty());
        claims.password_hash = claims.password_hash.filter(|p| !p.is_empty());

        if claims.share_type.is_empty() || claims.id.is_empty() || claims.exp <= 0 {
            return None;
        }
        if now > claims.exp {
            return None;
        }
        if claims.max_uses.is_some_and(|mu| mu < 0) {
            claims.max_uses = None;
        }
        // 限次分享**必须**带档案号：没有它，「已用几次」无处可记，
        // 而「查不到就当成 0」等于让限量静默失效。宁可让这串 token 无效。
        if claims.max_uses() > 0 && claims.jti.is_none() {
            return None;
        }

        Some(claims)
    }
}

/// 签发一份分享 claims 需要的全部输入。
///
/// ⚠️ 收成结构体而不是六个位置参数：这里有五个字符串，而**传错位置不会有编译错误**
/// —— 只会在签出一张「指向别人房间 / 别人条目」的令牌。同样的理由，项目里已经因为
/// `handle_socket` 的八个位置参数吃过一次亏（见 HANDOVER §6.1）。
#[derive(Debug, Clone)]
pub struct NewShare<'a> {
    pub share_type: &'a str,
    /// content id / file uuid。
    pub id: &'a str,
    pub room: &'a str,
    pub ttl_seconds: i64,
    pub max_uses: i64,
    pub password: &'a str,
    /// 档案号由**调用方**生成（core 不碰系统随机源，理由见模块注释）。
    pub jti: String,
    pub now: i64,
}

impl ShareKey {
    /// 造一份分享 claims（**无条件使用传入的 `jti`**）。
    ///
    /// `jti` 不只是限次用的：它还是这条分享在记录列表里的档案号 ——
    /// 「不限次的分享立不了档、统计不了打开次数」就是这么来的（Go 的注释里记着这个坑）。
    ///
    /// `ttl` / `maxUses` 会先归一化（夹到合法区间），所以响应里回给调用方的值
    /// 必须用**返回的** `expires_at` 和归一化后的 `max_uses`，不能回原始入参。
    #[must_use]
    pub fn share_claims(&self, new: NewShare<'_>) -> (ShareClaims, i64) {
        let expires_at = new.now + normalize_share_ttl(new.ttl_seconds);
        let max_uses = normalize_share_max_uses(new.max_uses);
        let password_hash = self.password_hash(new.password);
        (
            ShareClaims {
                share_type: new.share_type.to_owned(),
                id: new.id.to_owned(),
                room: normalize_room_name(new.room),
                scope: None,
                exp: expires_at,
                jti: Some(new.jti),
                max_uses: (max_uses > 0).then_some(max_uses),
                password_hash: (!password_hash.is_empty()).then_some(password_hash),
            },
            expires_at,
        )
    }

    // ── 会话令牌 ──────────────────────────────────────────────────────

    /// 签发会话令牌。`scope` 为 `Some(SCOPE_GLOBAL)` 时对所有房间有效。
    ///
    /// ⚠️ TTL 越界会被**夹**而不是报错：调用方永远传 3600，这个夹子只防手滑
    /// （比如把天数当秒数传进来）。
    #[must_use]
    pub fn session_token(
        &self,
        room: &str,
        ttl_seconds: i64,
        scope: Option<&str>,
        now: i64,
    ) -> (String, i64) {
        let exp = now + clamp_session_ttl(ttl_seconds);
        let room = normalize_room_name(room);
        let claims = ShareClaims {
            share_type: SESSION_TYPE.to_owned(),
            id: room.clone(),
            room,
            scope: scope
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            exp,
            ..ShareClaims::default()
        };
        (self.sign(&claims), exp)
    }

    /// 解析会话令牌（只看 `typ`，**不**匹配房间）。
    #[must_use]
    pub fn parse_session(&self, token: &str, now: i64) -> Option<ShareClaims> {
        let claims = self.parse(token, now)?;
        (claims.share_type == SESSION_TYPE).then_some(claims)
    }

    /// 这串会话令牌对这个房间有效吗。
    ///
    /// 三条都成立才算：`typ` 是 `room_session`、未过期，以及作用域覆盖这个房间 ——
    /// `scope: "global"` 对**所有**房间有效（它是用全局密码换来的），
    /// 否则必须同时匹配 `claims.room` 与 `claims.id`（两者都归一化过）。
    #[must_use]
    pub fn session_matches_room(&self, room: &str, token: &str, now: i64) -> bool {
        let Some(claims) = self.parse_session(token, now) else {
            return false;
        };
        if claims.is_global_scope() {
            return true;
        }
        let room = normalize_room_name(room);
        room == claims.room && normalize_room_name(&claims.id) == room
    }

    // ── 预览令牌 ──────────────────────────────────────────────────────

    /// 换发一个**短期、不带密码**的能力令牌，专给浏览器自己发起的请求用。
    ///
    /// 为什么需要它：`<img>` / `<video>` / `<a download>` 由浏览器直接发起，**加不了自定义
    /// 请求头**，而带密码的分享要求 `X-Share-Password` —— 于是有密码的部署上，图片、视频、
    /// 下载按钮一律 401（文本却是好的，因为那条走 JS，带得上头）。这个不对称最容易误判成
    /// 「只有文件坏了」。根子是**凭据放错了层**：自定义头只服务于 JS，浏览器直连的资源
    /// 必须把凭据放进 URL。
    ///
    /// ⚠️ 它**没有 maxUses**（= 不限次）：预览一张图、拖一下视频进度条都会被算成一次完整
    /// 访问，带配额会让预览把次数白白烧光。代价是「拿到密码的人在 TTL 内可以无限次取这一条」——
    /// 所以 TTL 要短，而且**只能由已经验过密码的请求**换发（见 `/share` 的 GET 分支）。
    #[must_use]
    pub fn preview_token(&self, claims: &ShareClaims, now: i64) -> (String, i64) {
        let mut exp = now + PREVIEW_TOKEN_TTL_SECONDS;
        // 不越过原分享的有效期：预览令牌不该比它服务的那条分享活得更久。
        if claims.exp > 0 && claims.exp < exp {
            exp = claims.exp;
        }
        let preview = ShareClaims {
            share_type: claims.share_type.clone(),
            id: claims.id.clone(),
            room: claims.room.clone(),
            exp,
            ..ShareClaims::default()
        };
        (self.sign(&preview), exp)
    }
}

// ── 归一化 ────────────────────────────────────────────────────────────

/// 夹一次 TTL。`<= 0` = 用默认值（15 分钟），不是「永不过期」——
/// 「没写」和「永远有效」在分享链接上是两件事，默认必须是有期限的那个。
#[must_use]
pub fn normalize_share_ttl(ttl_seconds: i64) -> i64 {
    if ttl_seconds <= 0 {
        DEFAULT_SHARE_TTL_SECONDS
    } else {
        ttl_seconds.clamp(MIN_SHARE_TTL_SECONDS, MAX_SHARE_TTL_SECONDS)
    }
}

/// 夹一次 `maxUses`：`<= 0` = 不限次。
#[must_use]
pub fn normalize_share_max_uses(max_uses: i64) -> i64 {
    if max_uses <= 0 {
        0
    } else {
        max_uses.min(MAX_SHARE_MAX_USES)
    }
}

/// 会话令牌的 TTL：`<= 0` = 1 小时，上限 1 天。
#[must_use]
pub fn clamp_session_ttl(ttl_seconds: i64) -> i64 {
    if ttl_seconds <= 0 {
        ROOM_SESSION_TTL_SECONDS
    } else {
        ttl_seconds.min(24 * 60 * 60)
    }
}

/// 这次请求要不要扣一次使用额度？
///
/// 规则（对应 Go `shouldConsumeShareUse`）：
/// - 只有 `GET` 扣；`HEAD` 不扣（探活/预览用），其它方法（POST/DELETE…）本来就不该拿
///   分享令牌读内容，不扣；
/// - 带 `Range` 且**不是从头开始**的不扣：拖动视频进度条、断点续传会把「打开一次」
///   算成好几次；
/// - 多段 Range 一律扣（判断复杂、而且那不是正常播放行为）。
#[must_use]
pub fn should_consume_share_use(method: &str, range_header: Option<&str>) -> bool {
    if !method.eq_ignore_ascii_case("GET") {
        return false;
    }

    let Some(range) = range_header.map(str::trim).filter(|r| !r.is_empty()) else {
        return true;
    };

    let lower = range.to_lowercase();
    let Some(spec) = lower.strip_prefix("bytes=") else {
        // 认不出的 Range 头：当成完整请求，扣一次（宁可少给一次，也不能无限次）。
        return true;
    };
    let spec = spec.trim();
    if spec.is_empty() || spec.contains(',') {
        return true;
    }
    let start = spec.split('-').next().unwrap_or("").trim();
    start.is_empty() || start == "0"
}

// ── 「这次请求能不能用这串分享令牌」 ──────────────────────────────────

/// 校验一次「拿分享令牌取内容」的请求所需的全部输入。
///
/// 做成结构体而不是七个位置参数：`expected_type` 和 `expected_id` 都是字符串，
/// 传反了不会报错 —— 只会变成「拿 A 的令牌能读 B」，那是静默的越权。
#[derive(Debug, Clone)]
pub struct ShareCheck<'a> {
    pub token: &'a str,
    /// `content` 或 `file`。
    pub expected_type: &'a str,
    /// content id 或 file uuid。
    pub expected_id: &'a str,
    pub expected_room: &'a str,
    /// `X-Share-Password` 请求头的值。
    pub password: &'a str,
    pub method: &'a str,
    pub range_header: Option<&'a str>,
    pub now: i64,
}

/// 校验通过的结论。
#[derive(Debug, Clone)]
pub struct ShareVerdict {
    pub claims: ShareClaims,
    /// ⚠️ `true` 表示**调用方要去扣一次使用额度**（core 不碰存储）。
    /// 扣不动（已用完）时调用方必须把请求判成失败 —— 否则限量形同虚设。
    pub consume_use: bool,
}

impl ShareKey {
    /// 校验一串分享令牌能不能用来取这条内容。
    ///
    /// 要点（每一条都对应 Go 里踩过的坑）：
    /// - `typ` 必须**正好**是期望的那个：拿文件分享的令牌读内容、或反过来，都要拒；
    /// - `id` 与 `room` 都要匹配 —— `room` 是为了「换个 `?room=` 就把受保护房间的内容读走」
    ///   这类绕过；
    /// - 需要密码的分享，请求头里的密码必须对（常数时间比较）；
    /// - 限次分享：本请求要不要扣额度由 [`should_consume_share_use`] 决定，扣的动作在校验之后
    ///   （`consume_use = true`），由调用方原子地做掉。
    #[must_use]
    pub fn validate_share(&self, check: &ShareCheck<'_>) -> Option<ShareVerdict> {
        let claims = self.parse(check.token, check.now)?;

        if claims.share_type != check.expected_type {
            return None;
        }
        if claims.id != check.expected_id.trim() {
            return None;
        }
        if normalize_room_name(check.expected_room) != claims.room {
            return None;
        }
        if !self.password_matches(
            claims.password_hash.as_deref().unwrap_or(""),
            check.password,
        ) {
            return None;
        }

        Some(ShareVerdict {
            consume_use: claims.max_uses() > 0
                && should_consume_share_use(check.method, check.range_header),
            claims,
        })
    }
}

/// 十六进制编码（小写）。只在这里用一次，不值得引一个 crate。
fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 常数时间比较。长度不同直接返回 false（长度本身不是秘密）。
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthValue;

    pub(super) const NOW: i64 = 1_700_000_000;

    pub(super) fn key() -> ShareKey {
        let mut config = Config::default();
        config.server.auth = AuthValue::Str("global-pw".into());
        ShareKey::derive(&config, b"test-salt")
    }

    /// 造一份 claims 的测试夹具。
    #[allow(clippy::too_many_arguments)] // 测试里八个参数比一个结构体字面量好读
    pub(super) fn new_claims(
        key: &ShareKey,
        share_type: &str,
        id: &str,
        room: &str,
        ttl: i64,
        max_uses: i64,
        password: &str,
        jti: &str,
    ) -> (ShareClaims, i64) {
        key.share_claims(NewShare {
            share_type,
            id,
            room,
            ttl_seconds: ttl,
            max_uses,
            password,
            jti: jti.to_owned(),
            now: NOW,
        })
    }

    fn open_key() -> ShareKey {
        ShareKey::derive(&Config::default(), b"test-salt")
    }

    /// 「没写」和「永远有效」是两件事：TTL 缺省必须是 **15 分钟**，而不是无限。
    #[test]
    fn ttl_defaults_to_fifteen_minutes_and_is_clamped() {
        assert_eq!(normalize_share_ttl(0), DEFAULT_SHARE_TTL_SECONDS);
        assert_eq!(normalize_share_ttl(-1), DEFAULT_SHARE_TTL_SECONDS);
        assert_eq!(normalize_share_ttl(30), MIN_SHARE_TTL_SECONDS);
        assert_eq!(normalize_share_ttl(900), 900);
        assert_eq!(normalize_share_ttl(999_999), MAX_SHARE_TTL_SECONDS);
    }

    #[test]
    fn max_uses_zero_means_unlimited_and_positive_is_capped() {
        assert_eq!(normalize_share_max_uses(0), 0);
        assert_eq!(normalize_share_max_uses(-5), 0);
        assert_eq!(normalize_share_max_uses(3), 3);
        assert_eq!(normalize_share_max_uses(999_999), MAX_SHARE_MAX_USES);
    }

    /// ⚠️ 限次分享**没有 jti** 时必须判无效 —— 没有档案号就没地方记「用了几次」，
    /// 而「查不到就当 0」等于限量静默失效。
    #[test]
    fn a_limited_share_without_jti_is_rejected() {
        let token = key().sign(&ShareClaims {
            share_type: TYPE_CONTENT.into(),
            id: "7".into(),
            room: "default".into(),
            exp: NOW + 600,
            max_uses: Some(3),
            ..ShareClaims::default()
        });
        assert!(key().parse(&token, NOW).is_none());
    }

    /// 每次签发都必须带档案号（Go 那边曾经只在限次时才发，于是不限次的分享立不了档）。
    #[test]
    fn every_issued_share_carries_a_jti() {
        let (claims, exp) = new_claims(&key(), TYPE_CONTENT, "7", "default", 900, 0, "", "jti-1");
        assert_eq!(claims.jti_str(), "jti-1");
        assert_eq!(claims.max_uses(), 0, "不限次就不该写 mu");
        assert_eq!(exp, NOW + 900);
        // `mu` / `p` / `sc` 不出现在 JSON 里（Go 的 omitempty）。
        let json = serde_json::to_string(&claims).unwrap();
        assert!(!json.contains("\"mu\""), "不限次不该写 mu: {json}");
        assert!(!json.contains("\"p\""), "没有密码就不该写 p: {json}");
    }

    #[test]
    fn password_hash_is_sixteen_hex_chars_and_constant_time_compared() {
        let key = key();
        let hash = key.password_hash("hunter2");
        assert_eq!(hash.len(), SHARE_PASSWORD_HASH_LEN);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));

        assert_eq!(key.password_hash("  hunter2  "), hash, "两端空白要忽略");
        assert_ne!(key.password_hash("hunter3"), hash);
        assert_eq!(key.password_hash(""), "", "空密码 = 不需要密码");

        assert!(key.password_matches(&hash, "hunter2"));
        assert!(!key.password_matches(&hash, "Hunter2"));
        assert!(
            key.password_matches("", "随便"),
            "token 里没有密码哈希 = 这条分享不要密码"
        );
    }

    /// ⚠️ 密码是**带密钥**的 HMAC，不是裸 SHA256：token 在 URL 里，裸哈希能被离线爆破。
    /// 换一把钥匙 → 同一个密码的哈希就不同。
    #[test]
    fn password_hash_depends_on_the_key_not_just_the_password() {
        assert_ne!(
            key().password_hash("hunter2"),
            open_key().password_hash("hunter2")
        );
    }

    #[test]
    fn tampered_tokens_are_rejected() {
        let key = key();
        let token = key.sign(&ShareClaims {
            share_type: TYPE_CONTENT.into(),
            id: "7".into(),
            room: "default".into(),
            exp: NOW + 600,
            ..ShareClaims::default()
        });

        assert!(key.parse(&token, NOW).is_some());
        assert!(key.parse("", NOW).is_none());
        assert!(key.parse("没有点", NOW).is_none());
        assert!(key.parse(&format!("{token}.多了一段"), NOW).is_none());

        // 改动 payload 的任意一个字符，签名就对不上了。
        let mut bytes = token.clone().into_bytes();
        bytes[0] = if bytes[0] == b'a' { b'b' } else { b'a' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert!(key.parse(&tampered, NOW).is_none());

        // 别的钥匙签的串，我们验不过（这就是「改密码 → 旧链接失效」）。
        let foreign = open_key().sign(&ShareClaims {
            share_type: TYPE_CONTENT.into(),
            id: "7".into(),
            room: "default".into(),
            exp: NOW + 600,
            ..ShareClaims::default()
        });
        assert!(key.parse(&foreign, NOW).is_none());
    }

    /// ⚠️ `exp` 是**闭区间端点**：到点那一刻还算有效，下一秒才过期。
    /// Go 那边就是 `time.Now().Unix() > claims.Exp` —— 换成 `>=` 会让所有链接提前一秒失效，
    /// 这种差异在正常使用中根本看不出来。
    #[test]
    fn expiry_boundary_matches_go() {
        let key = key();
        let (claims, exp) = new_claims(&key, TYPE_CONTENT, "7", "default", 60, 0, "", "j");
        let token = key.sign(&claims);

        assert!(key.parse(&token, exp).is_some(), "到点那一刻仍然有效");
        assert!(key.parse(&token, exp + 1).is_none());
        assert!(key.parse(&token, exp - 1).is_some(), "还没到点当然有效");
    }
}

/// 校验路径的测试单独一个模块：`validate_share` 的输入比较多，和归一化那些混在一起不好读。
#[cfg(test)]
mod validate_tests {
    use super::tests::{NOW, key, new_claims};
    use super::*;

    fn check<'a>(token: &'a str, expected_type: &'a str, password: &'a str) -> ShareCheck<'a> {
        ShareCheck {
            token,
            expected_type,
            expected_id: "7",
            expected_room: "work",
            password,
            method: "GET",
            range_header: None,
            now: NOW,
        }
    }

    /// ⚠️★ 三种令牌不能互换：`typ` 必须**正好**是期望的那个。
    /// 反过来（只比对 id）的话，一张 `file` 分享的令牌就能读同 id 的内容。
    #[test]
    fn share_token_type_id_and_room_must_all_match() {
        let key = key();
        let (claims, _) = new_claims(&key, TYPE_CONTENT, "7", "work", 900, 0, "", "jti-1");
        let token = key.sign(&claims);

        assert!(
            key.validate_share(&check(&token, TYPE_CONTENT, ""))
                .is_some()
        );
        assert!(
            key.validate_share(&check(&token, TYPE_FILE, "")).is_none(),
            "typ 不符必须拒"
        );

        // 换个 id / 换个房间都不行。
        let mut wrong_id = check(&token, TYPE_CONTENT, "");
        wrong_id.expected_id = "8";
        assert!(key.validate_share(&wrong_id).is_none());

        let mut wrong_room = check(&token, TYPE_CONTENT, "");
        wrong_room.expected_room = "default";
        assert!(
            key.validate_share(&wrong_room).is_none(),
            "换个 ?room= 就能读受保护房间的内容 —— 这正是要防的绕过"
        );
    }

    #[test]
    fn password_protected_share_needs_the_matching_header() {
        let key = key();
        let (claims, _) = new_claims(&key, TYPE_CONTENT, "7", "work", 900, 0, "hunter2", "jti-1");
        let token = key.sign(&claims);

        assert!(
            key.validate_share(&check(&token, TYPE_CONTENT, "hunter2"))
                .is_some()
        );
        assert!(
            key.validate_share(&check(&token, TYPE_CONTENT, ""))
                .is_none()
        );
        assert!(
            key.validate_share(&check(&token, TYPE_CONTENT, "hunter3"))
                .is_none(),
            "密码不对必须拒"
        );
        // 密码只在 `X-Share-Password` 里比对；token 本身不含密码明文。
        assert!(!token.contains("hunter2"));
    }

    /// 预览令牌：不带密码、不限次，有效期**不越过**原分享。
    #[test]
    fn preview_token_is_passwordless_unlimited_and_never_outlives_the_share() {
        let key = key();
        let (claims, _) = new_claims(&key, TYPE_CONTENT, "7", "work", 900, 5, "hunter2", "jti-1");

        let (preview, exp) = key.preview_token(&claims, NOW);
        assert_eq!(exp, NOW + PREVIEW_TOKEN_TTL_SECONDS);

        let parsed = key.parse(&preview, NOW).unwrap();
        assert!(!parsed.needs_password(), "预览令牌不带密码");
        assert_eq!(parsed.max_uses(), 0, "预览令牌不限次");
        assert_eq!(parsed.jti_str(), "", "预览令牌不是一条新分享，没有档案号");
        // 限次的分享：拿预览令牌去取内容**不该**扣额度（它没有 mu）。
        let verdict = key
            .validate_share(&check(&preview, TYPE_CONTENT, ""))
            .expect("预览令牌要能用");
        assert!(!verdict.consume_use);

        // 原分享只剩 60 秒时，预览令牌不能比它活得久。
        let (short_claims, _) = new_claims(&key, TYPE_CONTENT, "7", "work", 60, 0, "", "jti-2");
        let (_, short_exp) = key.preview_token(&short_claims, NOW);
        assert_eq!(short_exp, NOW + 60);
    }

    /// 扣不扣额度只看**这一条分享**的 `mu`，而且 Range 续传不算一次。
    #[test]
    fn only_limited_shares_consume_a_use() {
        let key = key();
        let (unlimited, _) = new_claims(&key, TYPE_CONTENT, "7", "work", 900, 0, "", "jti-u");
        let (limited, _) = new_claims(&key, TYPE_CONTENT, "7", "work", 900, 3, "", "jti-l");

        let unlimited_token = key.sign(&unlimited);
        let limited_token = key.sign(&limited);

        assert!(
            !key.validate_share(&check(&unlimited_token, TYPE_CONTENT, ""))
                .unwrap()
                .consume_use,
            "不限次的分享不该扣额度"
        );
        assert!(
            key.validate_share(&check(&limited_token, TYPE_CONTENT, ""))
                .unwrap()
                .consume_use
        );

        // Range：从头取算一次，续传不算，多段一律算。
        let mut resume = check(&limited_token, TYPE_CONTENT, "");
        resume.range_header = Some("bytes=1024-");
        assert!(
            !key.validate_share(&resume).unwrap().consume_use,
            "续传不该扣"
        );

        let mut first = check(&limited_token, TYPE_CONTENT, "");
        first.range_header = Some("bytes=0-1023");
        assert!(key.validate_share(&first).unwrap().consume_use);

        let mut multi = check(&limited_token, TYPE_CONTENT, "");
        multi.range_header = Some("bytes=0-99,200-299");
        assert!(key.validate_share(&multi).unwrap().consume_use);
    }

    /// 只有 GET 才扣额度：HEAD（探活/预览）和写方法都不该烧掉一次。
    #[test]
    fn should_consume_share_use_follows_the_method() {
        assert!(should_consume_share_use("GET", None));
        assert!(should_consume_share_use("get", None), "方法名大小写不敏感");
        assert!(!should_consume_share_use("HEAD", None));
        assert!(!should_consume_share_use("POST", None));
        // 认不出的 Range：当成完整请求扣一次（宁可少给一次，也不能无限次）。
        assert!(should_consume_share_use("GET", Some("pages=1-2")));
        assert!(should_consume_share_use("GET", Some("bytes=")));
        assert!(should_consume_share_use("GET", Some("bytes=0-")));
        assert!(!should_consume_share_use("GET", Some("bytes=1-")));
    }
}
