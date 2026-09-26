//! 界面上要显示的东西 —— **页面只认这几个结构**。
//!
//! # 这一层为什么存在
//!
//! 页面是手写的（`docs/specs/desktop-client.md` §6），而剪贴板同步是 `clip9-client`
//! 的活（§2 的硬边界）。中间这一层**只做三件事，一件业务逻辑都不做**：
//!
//! 1. 把 `ReceiveHolder`（线上协议形状）压成界面要的那几个字段；
//! 2. 补上**界面上必须有、而协议里没有**的两样：这条**是不是本机发的**、文件的预览地址；
//! 3. `serde` 化（IPC 走的就是 JSON）。
//!
//! ⚠️ **渲染规则要照抄 SPA**（§3.6 末 + §8 审计清单那条硬要求）—— 手写 UI 唯一真实的
//! 漂移风险就在这里。所以下面每条「界面上怎么显示」都对着 `web-vue3` 的约定写，
//! 并在注释里指出对照点。

use clip9_client::endpoint::download_url;
use clip9_protocol::ReceiveHolder;
use serde::Serialize;

/// 定时任务发出来的消息在 `source` 上的取值。
///
/// ⚠️ 与 Go 的 `broadcast.go` 对齐（`Source: "automation"`），不是「非空就算自动」。
const AUTOMATION_SOURCE: &str = "automation";

/// 一条时间线条目。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    /// 服务端给的 id —— **列表的 key 就用它**（三边 id 单调，`CONTRIBUTING.md` §6）。
    pub id: i32,
    /// `text` / `file`。页面据此选卡片形状（⚠️ 别按「有没有正文」猜：
    /// 文件条目**没有**正文，见 `FileReceive` 的注释）。
    pub kind: &'static str,
    /// 文本正文（`kind == "text"` 时有值）。
    pub text: String,
    /// 文件名（`kind == "file"` 时有值）。
    pub file_name: String,
    /// 文件字节数（`kind == "file"` 时有值；`0` = 服务端没给）。
    pub file_size: i64,
    /// 文件预览地址（`kind == "file"` 时有值）。
    ///
    /// ⚠️★ **本地拼的**（`endpoint::download_url`），**不信条目里那个 `url`** ——
    /// 那个字段是「谁发的、从哪发的」，可能是别人的服务端。
    pub preview_url: Option<String>,
    /// 发送端设备名（界面上「来自谁」）。
    pub device: String,
    /// **是不是本机发的** —— 比的是 `senderClientID` 与本机的持久 id。
    ///
    /// ⚠️ 比 `senderIP` 可靠得多：同一台机器上多个客户端、以及手机和电脑同网段，
    /// 都会让「按 IP 判断本机」出错，而错的方向是「把自己的消息显示成别人的」。
    pub mine: bool,
    /// Unix 秒（服务端落的绝对时间，**与时区无关**）。
    pub timestamp: i64,
    /// 定时任务发出来的（界面上要标出来）。
    pub automation: bool,
    /// 错过触发窗口后补发的（不标的话用户会以为任务乱跑了）。
    pub late: bool,
    /// 定时任务的**预定触发时刻**（Unix 秒）。`0` = 没有。
    ///
    /// ⚠️ 这三个字段（`source` / `scheduledAt` / `late`）是 2026-09-26 才补进投影的
    /// （`docs/specs/ws-live-only.md` §0.6），漏掉它们的表现是「定时消息看不出是自动发的」，
    /// 而且**不会有任何报错**。所以下面有专门的测试钉住它们。
    pub scheduled_at: i64,
}

impl EntryView {
    /// 从一个协议条目造出界面上要的形状。
    ///
    /// - `our_client_id`：本机的持久客户端 id（用来判 `mine`）；
    /// - `server`：这个房间**自己的**服务端地址（拼预览地址用）——
    ///   传空就**不给**预览地址，而不是去猜一个（宁可少一个预览，不要指到别人的服务端）。
    #[must_use]
    pub fn from_holder(holder: &ReceiveHolder, our_client_id: &str, server: &str) -> Self {
        let base = holder.base();
        let (kind, text, file_name, file_size, preview_url) = match holder {
            ReceiveHolder::Text(t) => ("text", t.content.clone(), String::new(), 0, None),
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
                ("file", String::new(), f.name.clone(), f.size, url)
            }
        };

        Self {
            id: base.id,
            kind,
            text,
            file_name,
            file_size,
            preview_url,
            device: device_label(base.sender_device.as_ref()),
            // ⚠️ 两边都非空才比 —— 空 client id 会和所有「没带 id 的老条目」撞上，
            // 那会让一堆别人的消息都被标成「本机发的」。
            mine: !our_client_id.is_empty() && base.sender_client_id == our_client_id,
            timestamp: base.timestamp,
            automation: base.source == AUTOMATION_SOURCE,
            late: base.late,
            scheduled_at: base.scheduled_at,
        }
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
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    /// `wait` / `on` / `off` / `warn` —— 页面据此换圆点颜色。
    pub kind: &'static str,
    pub text: String,
    /// 连上之后拿到的边界（`latestId`）—— 界面上用它核对「历史到哪为止」。
    pub latest_id: Option<i32>,

    /// 「正在连哪台」—— 只有 `wait` 那一拍有值（给那句「连接 work …」用）。
    pub room: Option<String>,
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
        let view = EntryView::from_holder(&text_entry(7, "hello"), "", "http://127.0.0.1:9501");
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
        let view = EntryView::from_holder(&holder, "", "http://127.0.0.1:9501");
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
        let view = EntryView::from_holder(&file_entry(9, "u-1", "a.png", 1), "", "");
        assert!(view.preview_url.is_none());
        assert_eq!(view.file_name, "a.png", "名字照常显示");
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

        let view = EntryView::from_holder(&holder, "", "http://127.0.0.1:9501");
        assert!(view.automation, "定时消息要标出来");
        assert!(view.late, "补发也要标出来");
        assert_eq!(view.scheduled_at, 1_757_000_400);
        // ⚠️ 预定时刻与落库时刻**差得远**（这正是补发的判据），所以不能只看时间早晚。
        assert!(view.timestamp - view.scheduled_at >= 60);
    }

    /// 不是定时的消息不能被误标成定时（`source` 为空或别的值）。
    #[test]
    fn a_human_entry_is_not_marked_as_automation() {
        let view = EntryView::from_holder(&text_entry(13, "x"), "", "");
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
        assert!(EntryView::from_holder(&holder, "client-a", "").mine);
        assert!(!EntryView::from_holder(&holder, "client-b", "").mine);
        // 本机 id 还没拿到（还没连过）→ 一条都不算自己的。
        assert!(!EntryView::from_holder(&holder, "", "").mine);

        // 老条目压根没带 id → 也不能算自己的。
        assert!(!EntryView::from_holder(&text_entry(22, "old"), "client-a", "").mine);
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
