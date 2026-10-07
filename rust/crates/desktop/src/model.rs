//! 界面上要显示的东西 —— **页面只认这几个结构**。
//!
//! # 这一层为什么存在
//!
//! 页面是手写的（`dev-docs/specs/desktop-client.md` §6），而剪贴板同步是 `clip9-client`
//! 的活（§2 的硬边界）。中间这一层**只做三件事，一件业务逻辑都不做**：
//!
//! 1. 把 `ReceiveHolder`（线上协议形状）压成界面要的那几个字段；
//! 2. 补上**界面上必须有、而协议里没有**的三样：这条**是不是本机发的**、
//!    这条**是不是本机剪贴板同步过去的**、文件的预览地址；
//! 3. `serde` 化（IPC 走的就是 JSON）。
//!
//! ⚠️ **渲染规则要照抄 SPA**（§3.6 末 + §8 审计清单那条硬要求）—— 手写 UI 唯一真实的
//! 漂移风险就在这里。所以下面每条「界面上怎么显示」都对着 `web-vue3` 的约定写，
//! 并在注释里指出对照点。

use clip9_client::{Msg, endpoint::download_url};
use clip9_protocol::ReceiveHolder;
use serde::{Deserialize, Serialize};

/// 定时任务发出来的消息在 `source` 上的取值。
///
/// ⚠️ 与 Go 的 `broadcast.go` 对齐（`Source: "automation"`），不是「非空就算自动」。
const AUTOMATION_SOURCE: &str = "automation";

/// 一条时间线条目。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    /// 服务端给的 id —— **列表的 key 就用它**（三边 id 单调，`CONTRIBUTING.md` §6）。
    /// ⚠️ 它是**每个房间各自**单调的：跨房间不唯一，所以「记住一条」要连房间一起记。
    pub id: i32,
    /// `text` / `file`。页面据此选卡片形状（⚠️ 别按「有没有正文」猜：
    /// 文件条目**没有**正文，见 `FileReceive` 的注释）。
    pub kind: &'static str,
    /// 文本正文（`kind == "text"` 时有值）。
    ///
    /// ⚠️★ **`Store` 里这份是全文；快照里那份是截断预览**（见 [`EntryView::for_snapshot`]）。
    /// 类型上区分不出来（刻意：少一份重复定义），所以**别把快照回来的那份当正文用** ——
    /// 要全文就走 `Store::entry_text`（IPC 命令 `entry_text`）。
    pub text: String,
    /// 正文的**完整字节数**（与 `text.len()` 不同：后者是预览的长度）。
    /// 界面用来说清「共 N 字节」与「这只是开头」。
    pub text_bytes: usize,
    /// 正文**被截断**了吗（只有 `text_bytes > PREVIEW_BYTES` 时为真）。
    /// ⚠️ 界面据此决定「展开」是**本地摊开**还是**真的去取全文**（少一次 IPC）。
    pub truncated: bool,
    /// 文件名（`kind == "file"` 时有值）。
    pub file_name: String,
    /// 文件字节数（`kind == "file"` 时有值；`0` = 服务端没给）。
    pub file_size: i64,
    /// 文件**过期时刻**（Unix 秒，绝对时刻、与时区无关）。`0` = 永不过期。
    ///
    /// ⚠️★ 2026-10-04 才补进投影（Jonny：「桌面端也一样，显示文件的过期时间和状态，
    /// 并且过期文件的下载按钮置灰」）。协议里它一直有（`FileReceive::expire`），
    /// 只是投影时被丢掉了 —— 于是桌面端**看不出**一份文件会不会过期、过没过期，
    /// 而点一下已经过期的那条只会拿到服务端 404 的正文（`handlers.rs` 的 `file_expired`），
    /// 表现成「存不下来」，用户没法知道是**过期**而不是网络坏了。
    ///
    /// ⚠️ 界面自己拿 `Date.now()` 比（别在这里预先算好 `expired` 布尔）：
    /// 快照是**会缓存**的，一份预先算好的布尔会随着时间推移变成假话。
    /// ⚠️ 判据 19 盯着「`EntryView` 的每个字段都要在卡片渲染那条调用链里读一次」——
    /// 加了字段不读，`tools/desktop-ui-smoke.mjs` 会红。
    pub expire: i64,
    /// 文件预览地址（`kind == "file"` 时有值）。
    ///
    /// ⚠️★ **本地拼的**（`endpoint::download_url`），**不信条目里那个 `url`** ——
    /// 那个字段是「谁发的、从哪发的」，可能是别人的服务端。
    ///
    /// ⚠️★ 它是**裸地址**（不带凭据）：房间**要密码**时这个地址一定 401 ——
    /// 那时 [`Self::preview_needs_token`] 为真，**快照里这一格是 `None`**，
    /// 由页面回头找壳要一条带令牌的地址（见 [`crate::runtime::Runtime::preview_url`]）。
    pub preview_url: Option<String>,
    /// 这条的预览**必须先换一条带令牌的地址**（房间要密码）——
    /// 页面看到它就**不要去读 `preview_url`**（那时它是 `None`），直接问壳。
    ///
    /// ⚠️★ 为什么必须有这个布尔：`<img>` / `<video>` 的 `src` **带不了
    /// `Authorization` 头**，而 `/file/...` 在配了密码的实例上要凭据
    /// （`server::auth_gate::require_file_read_access`）—— 裸地址一定 401，
    /// 而 `<img>` 的 error 会被静默换成一介文件行（2026-10-04 实测复现）。
    /// 项目自己给的解法是**分享令牌**：只读、按条、会过期、**本来就是给人贴进地址栏的**
    /// （与「房间凭据永远不进 URL」不冲突，见 `clip9_client::endpoint` 的模块文档第 3 条）。
    pub preview_needs_token: bool,
    /// 文件在服务端那边的编号（= 协议里的 `cache`，通常就是 uuid）。
    ///
    /// ⚠️★ `#[serde(skip)]`：**它不出现在快照里**，界面用不上它（页面只递 id，地址由壳查）。
    /// 壳自己要用：签分享令牌必须把 uuid 发给 `/share`（`payload.url` 里那段只是给人看的）。
    #[serde(skip)]
    pub file_cache: String,
    /// 发送端设备名（界面上「来自谁」）。
    pub device: String,
    /// **是不是本机发的** —— 比的是 `senderClientID` 与本机的持久 id。
    ///
    /// ⚠️ 比 `senderIP` 可靠得多：同一台机器上多个客户端、以及手机和电脑同网段，
    /// 都会让「按 IP 判断本机」出错，而错的方向是「把自己的消息显示成别人的」。
    pub mine: bool,
    /// **是不是本机剪贴板同步过去的**（而不是在这个窗口里敲的 / 拖进去的 / 选的）。
    ///
    /// ⚠️★ 它**只在 `mine` 为真时才有意义**（别人发的那些当然是 `false`）。界面上它是
    /// 二选一的另一条标签：`mine` 写着「我发的」，而这一条写着「剪贴板同步」
    /// （见 `ui/app.js` 里 `renderEntry` 那一处）。
    ///
    /// ⚠️★ **服务端不知道这件事**，协议里也没有这个字段 —— 它是**本机记的**：
    /// 上行成功时服务端回的 `id`（`clip9_client::UploadedEntry`）被 `Store` 记进
    /// 「这个房间的这一条是本机剪贴板发出去的」。所以：
    ///   · 翻**历史**翻出来的老条目、换台机器看到的同一条，都是 `false`；
    ///   · 客户端**重启之后**也是 `false`（那张表只在内存里）。
    /// ⚠️ 这两处退化的方向是**安全的**（显示回默认的「我发的」—— 那也不是假话，
    /// 只是少说了一句「它是从剪贴板来的」），所以不值得为它落一份盘。
    ///
    /// ⚠️★ 判据里**必须带上房间**：id 是每个房间各自单调的，两个房间可以同时有
    /// 一条 id 7（`CONTRIBUTING.md` §6）—— 只按 id 记会给另一个房间的条目也贴上标签。
    pub from_clipboard: bool,
    /// Unix 秒（服务端落的绝对时间，**与时区无关**）。
    pub timestamp: i64,
    /// 定时任务发出来的（界面上要标出来）。
    pub automation: bool,
    /// 错过触发窗口后补发的（不标的话用户会以为任务乱跑了）。
    pub late: bool,
    /// 定时任务的**预定触发时刻**（Unix 秒）。`0` = 没有。
    ///
    /// ⚠️ 这三个字段（`source` / `scheduledAt` / `late`）是 2026-09-26 才补进投影的
    /// （`dev-docs/specs/ws-live-only.md` §0.6），漏掉它们的表现是「定时消息看不出是自动发的」，
    /// 而且**不会有任何报错**。所以下面有专门的测试钉住它们。
    pub scheduled_at: i64,
}

/// 快照里每条正文最多多少**字节**。
///
/// ⚠️★ 取 4096 不是随手定的：**它就是缺省 `text.limit`**。于是「每条最多 4 KiB」这条
/// **设计基线**（`ARCHITECTURE.md` §2.1）在 `text.limit` 被调大之后**依然成立** ——
/// 快照体积被钉在「200 条 × 4 KiB ≈ 0.8 MB」，与用户把上限调到多大**无关**。
///
/// 这是 2026-09-27 拍板的形态：**快照只带截断预览，正文按需取**（原话：
/// 「放截断预览正文按需取」）。理由与业内做法见 `dev-docs/specs/desktop-client.md` §8.3 ④
/// 与 `long-message-hardening.md` S5。
pub(crate) const PREVIEW_BYTES: usize = 4096;

/// 把一段正文切成（预览、完整字节数、是否被截断）。
///
/// ⚠️★ 必须切在**字符边界**上：`&text[..4096]` 遇到多字节字符会**直接 panic**，
/// 而中文一个字 3 字节、4096 不是 3 的倍数 —— 这条几乎一踩一个准。
fn preview_of(text: &str) -> (String, usize, bool) {
    let bytes = text.len();
    if bytes <= PREVIEW_BYTES {
        return (text.to_owned(), bytes, false);
    }
    let mut end = PREVIEW_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), bytes, true)
}

impl EntryView {
    /// 从一个协议条目造出界面上要的形状。
    ///
    /// - `our_client_id`：本机的持久客户端 id（用来判 `mine`）；
    /// - `server`：这个房间**自己的**服务端地址（拼预览地址用）——
    ///   传空就**不给**预览地址，而不是去猜一个（宁可少一个预览，不要指到别人的服务端）。
    /// - `needs_token`：这个房间**要不要密码**（= 那条通道上有没有凭据）——
    ///   要的话预览地址必须换成带分享令牌的那一条，见 [`Self::preview_needs_token`]。
    #[must_use]
    pub fn from_holder(
        holder: &ReceiveHolder,
        our_client_id: &str,
        server: &str,
        needs_token: bool,
    ) -> Self {
        let base = holder.base();
        let (kind, text, file_name, file_size, expire, preview_url, file_cache) = match holder {
            ReceiveHolder::Text(t) => (
                "text",
                t.content.clone(),
                String::new(),
                0,
                // 文本条目**不会过期**（`expire` 是文件专有的字段）。
                0,
                None,
                String::new(),
            ),
            ReceiveHolder::File(f) => {
                // ⚠️ 文件名被清洗成空时 `download_url` 会报错 → 没有预览地址。
                // 这不是失败：一个没有预览的文件条目照样能显示（名字、大小、时间）。
                let url = if server.is_empty() {
                    None
                } else {
                    download_url(server, &f.cache, &f.name)
                        .ok()
                        // ⚠️ `download_url` 给的是 `url::Url` —— 跨 IPC 的是 JSON，
                        // 而 `Url` 的 `Serialize` 会变成一个**对象**（页面拿到会当成 `[object]`）。
                        // 所以这里显式转成字符串，形状与 `EntryView` 声明的一致。
                        .map(|url| url.to_string())
                };
                (
                    "file",
                    String::new(),
                    f.name.clone(),
                    f.size,
                    f.expire,
                    url,
                    f.cache.clone(),
                )
            }
        };

        Self {
            id: base.id,
            kind,
            text,
            // ⚠️ 这里是**全文**：`Store` 存的是它。截断只发生在 [`Self::for_snapshot`]。
            text_bytes: 0,
            truncated: false,
            file_name,
            file_size,
            expire,
            preview_url,
            preview_needs_token: needs_token,
            file_cache,
            device: device_label(base.sender_device.as_ref()),
            // ⚠️ 两边都非空才比 —— 空 client id 会和所有「没带 id 的老条目」撞上，
            // 那会让一堆别人的消息都被标成「本机发的」。
            mine: !our_client_id.is_empty() && base.sender_client_id == our_client_id,
            // ⚠️ 默认 `false`，**由 `Store` 在收进列表时补上**（它才知道「这个房间的
            // 第几条是本机剪贴板发出去的」，见 `Room::upsert`）。协议里没有这个信息。
            from_clipboard: false,
            timestamp: base.timestamp,
            automation: base.source == AUTOMATION_SOURCE,
            late: base.late,
            scheduled_at: base.scheduled_at,
        }
        // ⚠️ 把 `text_bytes` 补成真值 —— 上面写 0 只是占位，别忘（忘掉的表现是
        // 「界面说这条共 0 字节」，而它不报错）。
        .with_text_bytes_from_body()
    }

    /// 给**快照**看的那一份：正文**截断成预览**，并补上「一共多少字节 / 有没有被截断」。
    ///
    /// ⚠️★ 这是「快照只带截断预览」这条拍板唯一的落点（2026-09-27，原话
    /// 「放截断预览正文按需取」）。它**不改 `Store` 里那份** —— 要全文走
    /// `Store::entry_text`（IPC 命令 `entry_text`）。
    ///
    /// ⚠️ 之所以不另立一个 `EntrySnapshot` 类型：那会变成**第二份字段清单**，
    /// 而两份一定会漂（这个项目为这个付过几次代价）。代价是类型上分不出
    /// 「全文还是预览」，所以上面 `text` 那段注释与 `Store` 的测试里那条不变量
    /// （「快照之后 Store 里还是全文」）是**必须**的。
    #[must_use]
    pub fn for_snapshot(&self) -> Self {
        let (text, text_bytes, truncated) = preview_of(&self.text);
        Self {
            text,
            text_bytes,
            truncated,
            // ⚠️★ 要换令牌的那种房间**不给地址**（见 `preview_needs_token` 的注释）：
            // 递一个「拿去就 401」的地址过去，页面要么把它塞进 `src`（那条内容永远是空的），
            // 要么自己判错。**一个用不了的地址不该递出去** —— 要地址就回头问壳。
            preview_url: if self.preview_needs_token {
                None
            } else {
                self.preview_url.clone()
            },
            ..self.clone()
        }
    }

    fn with_text_bytes_from_body(mut self) -> Self {
        self.text_bytes = self.text.len();
        self
    }
}

/// 设备名：取 `name` → `os` → `type`。
///
/// ⚠️ 这个顺序**不是**这里发明的：`cloud-clip/lib/broadcast.go` 的 `senderDevice` 注释
/// 指着前端的 `deviceLabel` 就是这个取值顺序，而服务端为了「定时消息显示成空格」
/// 专门给无 UA 的来源塞了 `{"name":…, "type":"Automation"}`。
/// 三处保持一致，所以**没有 UA 的定时消息也有名字可显示**。
fn device_label(device: Option<&std::collections::HashMap<String, String>>) -> String {
    let Some(device) = device else {
        return String::new();
    };
    for key in ["name", "os", "type"] {
        if let Some(value) = device.get(key).map(|v| v.trim())
            && !value.is_empty()
        {
            return value.to_owned();
        }
    }
    String::new()
}

/// 一条连接的状态（房间行 + 标题栏那个圆点 + 一句话）。
///
/// ⚠️★ 它现在是**按房间**的一份（`store::ConnectionView` 里嵌着它）——
/// 每个房间各自有一条连接（§4.7），所以「唯一那条连接的状态」已经不存在了。
///
/// ⚠️★ `text` 是 [`Msg`]（键 + 参数），**不是成文的句子**（2026-09-28 改）——
/// 这一族的句子全是壳写的，成文的话界面切英文时它们一个字都不变。
/// 见 `clip9_client::msg` 的模块文档。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    /// `wait` / `on` / `off` / `warn` —— 页面据此换圆点颜色。
    pub kind: &'static str,
    pub text: Msg,
    /// 连上之后拿到的边界（`latestId`）—— 界面上用它核对「历史到哪为止」。
    pub latest_id: Option<i32>,

    /// 「正在连哪台」—— 只有 `wait` 那一拍有值（给那句「连接 work …」用）。
    pub room: Option<String>,
}

/// 「分享这一条」签出来的结果。
///
/// ⚠️★ 为什么不再像以前那样**只返回一个地址**：桌面那一侧现在也有一个与网页版对齐的
/// 配置面板，它要把「实际生效的有效期 / 次数 / 过期时刻 / 已被打开几次」回给用户 ——
/// 那几个数只有服务端知道（它会按自己的区间把入参夹一遍），界面自己算就是撒谎。
///
/// ⚠️ 缺字段一律按「没有」处理，而不是报错：老服务端不一定每个字段都给。
/// 少一个数只是结果面板上少一行，不该让已经建出来的链接失败。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkView {
    /// 分享页地址。⚠️ **空串不被允许**（见 `crate::runtime::Runtime::share_entry`）：
    /// 「复制成功」但粘出来是空，是这个功能里最能骗人的一种失败。
    pub url: String,
    /// **直连正文**的地址（带分享令牌的那一条）。
    ///
    /// ⚠️★ 它的用途只有一个：**塞进 `<img>` / `<video>` 的 `src`** ——
    /// 那两个标签带不了 `Authorization` 头，而配了密码的实例上 `/file/...` 要凭据。
    /// 没有它，带密码的房间里的图片与视频永远是 401（2026-10-04 实测复现）。
    /// ⚠️ 令牌进 URL 是**设计如此**：它是只读、按条、会过期、本来就是给人贴出去的东西
    /// （与「房间凭据永远不进 URL」不冲突，见 `clip9_client::endpoint` 模块文档第 3 条）。
    /// ⚠️ 老服务端可能不给这个字段 —— 那时是空串（不是错误：分享页地址照样能用）。
    pub raw_url: String,
    /// 实际生效的有效期（秒）。服务端归一化过的那个值。
    pub ttl: i64,
    /// 实际生效的次数上限（`0` = 不限次数）。
    pub max_uses: i64,
    /// 过期时刻（unix 秒）。
    pub expires_at: i64,
    /// 已经被打开过几次。
    pub visits: i64,
}
#[cfg(test)]
mod tests {
    use super::*;
    use clip9_protocol::{FileReceive, ReceiveBase, TextReceive};
    use std::collections::HashMap;

    fn text_entry(id: i32, content: &str) -> ReceiveHolder {
        ReceiveHolder::Text(TextReceive {
            base: ReceiveBase {
                id,
                kind: "text".to_owned(),
                room: "default".to_owned(),
                timestamp: 1_757_000_000,
                ..ReceiveBase::default()
            },
            content: content.to_owned(),
            ..TextReceive::default()
        })
    }

    fn file_entry(id: i32, cache: &str, name: &str, size: i64) -> ReceiveHolder {
        ReceiveHolder::File(FileReceive {
            base: ReceiveBase {
                id,
                kind: "file".to_owned(),
                room: "default".to_owned(),
                timestamp: 1_757_000_000,
                ..ReceiveBase::default()
            },
            name: name.to_owned(),
            size,
            cache: cache.to_owned(),
            ..FileReceive::default()
        })
    }

    #[test]
    fn a_text_entry_maps_to_a_text_card() {
        let view =
            EntryView::from_holder(&text_entry(7, "hello"), "", "http://127.0.0.1:9501", false);
        assert_eq!(view.kind, "text");
        assert_eq!(view.text, "hello");
        assert_eq!(view.id, 7);
        assert_eq!(view.timestamp, 1_757_000_000);
        assert!(view.preview_url.is_none());
    }

    /// ⚠️★ **文件条目没有正文** —— 而它的预览地址是**本地拼**的，
    /// 不是条目里那个 `url`（那个可能是**别人的**服务端）。
    #[test]
    fn a_file_entry_gets_a_locally_built_preview_url() {
        let holder = file_entry(9, "u-1", "报告.pdf", 2048);
        let view = EntryView::from_holder(&holder, "", "http://127.0.0.1:9501", false);
        assert_eq!(view.kind, "file");
        assert_eq!(view.text, "", "文件条目不该有正文");
        assert_eq!(view.file_name, "报告.pdf");
        assert_eq!(view.file_size, 2048);
        assert_eq!(
            view.preview_url.as_deref(),
            Some("http://127.0.0.1:9501/file/u-1/%E6%8A%A5%E5%91%8A.pdf")
        );
    }

    /// ⚠️ 不知道服务端地址时**不给**预览地址，而不是去猜一个 ——
    /// 指到别人的服务端的预览，比没有预览更糟。
    #[test]
    fn without_a_server_there_is_no_preview_url() {
        let view = EntryView::from_holder(&file_entry(9, "u-1", "a.png", 1), "", "", false);
        assert!(view.preview_url.is_none());
        assert_eq!(view.file_name, "a.png", "名字照常显示");
    }

    /// ⚠️★ **要密码的房间：快照里不许给裸地址。**
    ///
    /// `<img>` / `<video>` 的 `src` 带不了 `Authorization` 头，而配了密码的实例上
    /// `/file/...` 要凭据（`server::auth_gate::require_file_read_access`）——
    /// 那条地址拿去就是 401，而 `<img>` 的 error 会被静默换成一介文件行；
    /// 2026-10-04 实测过（裸 401 / `?auth=` 200），用户那边的症状正是「列表只显示文件名」。
    /// 所以：**一个用不了的地址不该递出去**，由页面回头找壳要一条带只读令牌的
    ///（`Runtime::preview_url`）。
    ///
    /// ⚠️ 壳自己那一份**必须留着**：存盘（`save_entry_file`）走的是同一个字段 +
    /// `Authorization` 头，那条路本来就能用。
    #[test]
    fn a_password_room_keeps_the_bare_url_away_from_the_page() {
        let holder = file_entry(4, "u-1", "a.png", 9);

        let open = EntryView::from_holder(&holder, "", "http://127.0.0.1:9501", false);
        assert!(!open.preview_needs_token);
        assert!(
            open.for_snapshot().preview_url.is_some(),
            "不要密码的房间照旧给地址（那一条真的取得回来）"
        );
        assert_eq!(open.file_cache, "u-1", "uuid 壳自己要留着（签令牌要用）");

        let guarded = EntryView::from_holder(&holder, "", "http://127.0.0.1:9501", true);
        assert!(
            guarded.preview_needs_token,
            "要密码的房间要告诉页面「去问壳」"
        );
        assert!(
            guarded.for_snapshot().preview_url.is_none(),
            "要密码的房间不许把裸地址递出去"
        );
        assert!(
            guarded.preview_url.is_some(),
            "壳手上那份还在（存盘那条路要用）"
        );
    }

    /// ⚠️★ 预览必须切在**字符边界**上。
    ///
    /// `&text[..4096]` 遇到中文会**直接 panic**（一个汉字 3 字节，而 4096 不是 3 的倍数），
    /// 而这条路径是「用户发一条长中文」—— 一踩一个准。
    #[test]
    fn a_long_cjk_body_is_truncated_on_a_char_boundary() {
        let view = EntryView::from_holder(&text_entry(1, &"汉".repeat(2000)), "", "", false);
        assert_eq!(view.text_bytes, 6000, "记录里那份是全文");
        assert!(!view.truncated, "记录自己不算「截断」");

        let preview = view.for_snapshot();
        assert!(preview.truncated, "6000 字节 > 4096，必须标成截断");
        assert_eq!(
            preview.text_bytes, 6000,
            "报的字节数要是**全文**的，不是预览的"
        );
        assert!(preview.text.len() <= PREVIEW_BYTES);
        assert_eq!(
            preview.text.len() % 3,
            0,
            "切在字符边界上 → 中文预览的字节数必然是 3 的倍数"
        );
        assert!(
            preview.text.chars().all(|c| c == '汉'),
            "切出了半个字：{:?}",
            preview.text.chars().last()
        );

        // ⚠️★ 关键不变量：`for_snapshot` **不能**改到记录里那份。
        // 改到的话就是「发出去的长文在本地被截断」—— 而它不报错，只是内容少了。
        assert_eq!(view.text.len(), 6000, "for_snapshot 改了原文");
    }

    /// 短正文（含**正好等于**缺省上限那一档）不该被标成截断 ——
    /// 否则界面会给一条本来就完整的消息显示「展开」。
    #[test]
    fn a_body_at_or_below_the_preview_size_is_not_truncated() {
        for size in [0, 1, PREVIEW_BYTES - 1, PREVIEW_BYTES] {
            let body = "x".repeat(size);
            let preview =
                EntryView::from_holder(&text_entry(2, &body), "", "", false).for_snapshot();
            assert!(!preview.truncated, "{size} 字节不该算截断");
            assert_eq!(preview.text_bytes, size);
            assert_eq!(preview.text, body, "没截断就该原样给");
        }
        // 多一个字节才算。
        let over = "x".repeat(PREVIEW_BYTES + 1);
        let preview = EntryView::from_holder(&text_entry(3, &over), "", "", false).for_snapshot();
        assert!(preview.truncated);
        assert_eq!(preview.text_bytes, PREVIEW_BYTES + 1);
        assert_eq!(preview.text.len(), PREVIEW_BYTES);
    }

    /// 文件条目**没有正文**，所以既不该被标成截断、字节数也得是 0。
    #[test]
    fn a_file_entry_has_no_body_and_no_preview() {
        let preview =
            EntryView::from_holder(&file_entry(4, "u-1", "a.png", 9), "", "http://x", false)
                .for_snapshot();
        assert_eq!(preview.kind, "file");
        assert_eq!(preview.text_bytes, 0);
        assert!(!preview.truncated);
    }

    /// ⚠️★ 定时消息的三个字段（`source` / `scheduledAt` / `late`）**不能丢** ——
    /// 丢了的表现是「界面上看不出这条是自动发的」，而**不会有任何报错**。
    /// 这三个字段是 2026-09-26 才补进 `/content` 投影的（`ws-live-only.md` §0.6）。
    #[test]
    fn an_automation_entry_keeps_its_badges() {
        let holder = ReceiveHolder::Text(TextReceive {
            base: ReceiveBase {
                id: 12,
                kind: "text".to_owned(),
                room: "default".to_owned(),
                timestamp: 1_757_000_600,
                source: "automation".to_owned(),
                scheduled_at: 1_757_000_400,
                late: true,
                ..ReceiveBase::default()
            },
            content: "值班：阿岚".to_owned(),
            ..TextReceive::default()
        });

        let view = EntryView::from_holder(&holder, "", "http://127.0.0.1:9501", false);
        assert!(view.automation, "定时消息要标出来");
        assert!(view.late, "补发也要标出来");
        assert_eq!(view.scheduled_at, 1_757_000_400);
        // ⚠️ 预定时刻与落库时刻**差得远**（这正是补发的判据），所以不能只看时间早晚。
        assert!(view.timestamp - view.scheduled_at >= 60);
    }

    /// 不是定时的消息不能被误标成定时（`source` 为空或别的值）。
    #[test]
    fn a_human_entry_is_not_marked_as_automation() {
        let view = EntryView::from_holder(&text_entry(13, "x"), "", "", false);
        assert!(!view.automation);
        assert!(!view.late);
        assert_eq!(view.scheduled_at, 0);
    }

    /// ⚠️★ `mine` 判错的方向很坏：把自己的消息显示成别人的（用户会以为「我没发过」）。
    /// 两条边界：① 本机 id 为空时**不能**把「没带 id 的老条目」判成自己的；
    /// ② 只有 `senderClientID` 逐字相同才算。
    #[test]
    fn mine_needs_a_non_empty_client_id_on_both_sides() {
        let mut holder = text_entry(21, "mine");
        if let ReceiveHolder::Text(t) = &mut holder {
            t.base.sender_client_id = "client-a".to_owned();
        }
        assert!(EntryView::from_holder(&holder, "client-a", "", false).mine);
        assert!(!EntryView::from_holder(&holder, "client-b", "", false).mine);
        // 本机 id 还没拿到（还没连过）→ 一条都不算自己的。
        assert!(!EntryView::from_holder(&holder, "", "", false).mine);

        // 老条目压根没带 id → 也不能算自己的。
        assert!(!EntryView::from_holder(&text_entry(22, "old"), "client-a", "", false).mine);
    }

    /// 设备名按 `name` → `os` → `type` 取；全都没有就是空串（**不是**一个空格 ——
    /// 服务端特意为无 UA 的定时消息塞了 `type: "Automation"`，就是为了避开空格那种脏值）。
    #[test]
    fn device_label_follows_the_spa_order() {
        let mut device = HashMap::new();
        device.insert("type".to_owned(), "Automation".to_owned());
        device.insert("name".to_owned(), "MacBook".to_owned());
        assert_eq!(device_label(Some(&device)), "MacBook");

        device.remove("name");
        assert_eq!(device_label(Some(&device)), "Automation");

        // 键存在但值是空白 → 当没有（不显示一个空格）。
        let blank = HashMap::from([("name".to_owned(), "   ".to_owned())]);
        assert_eq!(device_label(Some(&blank)), "");
        assert_eq!(device_label(None), "");
    }
}

/// 页面看到的**自动更新状态**。
///
/// ⚠️ 它是 `snapshot` 的一部分（页面每 500ms 拉一次），所以**必须**是纯数据 ——
/// 里面不能有 `AppHandle` 那类东西（那会让 `Snapshot` 不能 `Serialize`，也不能跨线程）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdatePhase {
    /// 还没查过，或者查过、已是最新。
    Idle,
    /// 正在查（界面上要转个圈 —— 查一次要发一个网络请求）。
    Checking,
    /// 有新版可用，等用户点。
    Available {
        version: String,
        /// 发布说明（`latest.json` 里的 `notes`）—— 直接来自 CHANGELOG 那一段。
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    /// 正在下载（`total` 为 `None` = 对面没给 `Content-Length`）。
    Downloading {
        version: String,
        received: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
    /// 下完装完了，**重启就生效**（macOS/Linux 上到这一步还没重启）。
    Ready { version: String },
    /// 用户跳过过这一版。
    Skipped { version: String },
    /// 上一次更新失败了 —— 把原因说出来（静默失败是这里最不该有的行为）。
    ///
    /// ⚠️★ 走 [`Msg`]（键 + 参数），**不是成文的句子** —— 判据 16 盯着这件事：
    /// 写死一句中文的话，切到英文时它一个字都不会变。
    /// `reason` 是**技术细节**（插件给的英文原文），当参数传 —— 与
    /// `serverSpawnFailed` 那条同一个形状。
    Failed { msg: Msg },
}
