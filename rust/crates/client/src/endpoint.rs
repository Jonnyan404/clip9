//! 端点拼装 —— **全项目只有这一处拼 URL**。
//!
//! # 为什么不各拼各的
//!
//! `dev-docs/specs/desktop-client.md` §8 审计清单里有两条：
//!
//! - 「**没有自己拼 URL**」（尤其别用会清洗路径的 join）；
//! - 「**凭据不进 URL**」。
//!
//! 这两条都不是风格问题，是踩过的：
//!
//! 1. **路径清洗**：`filepath.Join` 那一类（以及手写 `format!("{base}/{path}")`）会把
//!    `http://host` 里的 `//` 吃成一个 `/`，结果是 `http:/host/text` —— 请求直接打不出去，
//!    而错误信息只会说「连接失败」。这里一律走 [`url::Url`] 的 `set_path`，
//!    它按 URL 语法改路径，不做「猜你想去哪」的清洗。
//! 2. **子路径前缀**：服务端可以部署在 `/clip9` 这种子路径下
//!    （`dev-docs/api.md` §1.1），所以拼的时候必须**保留** `server` 里已有的路径前缀。
//!    丢了它，表现是「主页能开、接口全 404」。
//! 3. **凭据**：房间密码 / 会话令牌一律走 `Authorization: Bearer` 请求头。
//!    进了 URL 就会进服务端访问日志、进反代日志、进用户随手分享的那串地址 ——
//!    而这个项目为「密码泄进日志」付过代价（`dev-docs/api.md` §1.2 专门写了这一条）。

use url::Url;

use crate::msg::Msg;

/// 一个端点的绝对地址（含查询串）。
pub type Endpoint = Url;

/// 拼一个接口地址：`server` + `path` + `params`。
///
/// - `path` 必须以 `/` 开头（接口路径，**不含**服务端的子路径前缀 —— 那个从 `server` 里读）；
/// - `params` 会**按顺序 append** 到查询串（不是覆盖，所以同名参数不会互相吃掉）；
/// - ⚠️ **凭据不该出现在 `params` 里**，见模块文档第 3 条。
pub fn api_url(server: &str, path: &str, params: &[(&str, &str)]) -> Result<Endpoint, Msg> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return Err(Msg::key("serverAddressEmpty"));
    }
    let mut url = Url::parse(trimmed).map_err(|err| {
        Msg::key("serverAddressUnparsable")
            .param("url", trimmed)
            .param("reason", err)
    })?;

    if !url.path().starts_with('/') {
        // `Url::parse` 对 `http://host` 会给出 path = "/"，所以这里其实到不了；
        // 留着是为了 `set_path` 的输入永远是合法形状（防御性，不是猜测）。
        url.set_path("/");
    }
    // ⚠️ 保留子路径前缀：`https://host/clip` + `/text` → `/clip/text`。
    let base_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{base_path}{path}"));

    // ⚠️★ 只在**真的有参数**时才碰查询串：`query_pairs_mut()` 会把查询串**创建出来**，
    // 于是 `http://h:9501/push` 会变成 `http://h:9501/push?` —— 一个尾随问号。
    // 服务端当然还是认的，但它出现在日志、出现在断言里、出现在「为什么我的 URL 长这样」
    // 的疑问里 —— 没必要。
    if !params.is_empty() {
        let mut query = url.query_pairs_mut();
        for (key, value) in params {
            query.append_pair(key, value);
        }
    }
    Ok(url)
}

/// `POST /text` —— 文本上行。
///
/// 带 `name`（给人看的设备名）与 `client`（程序判断「是不是我自己发的」）。
/// ⚠️ 两个都带上是**刻意的**，不是冗余：`dev-docs/api.md` §11 第 5 条点名不许混用它们。
/// 空值也带（`name=`）—— 「空」和「没这个参数」含义不同，服务端对前者会去推 User-Agent。
pub fn text_url(
    server: &str,
    room: &str,
    device_name: &str,
    client_id: &str,
) -> Result<Endpoint, Msg> {
    api_url(
        server,
        "/text",
        &[("room", room), ("name", device_name), ("client", client_id)],
    )
}

/// `POST /upload` —— 文件与**图片**上行（图片走文件那条路，见 [`crate::UploadKind`]）。
///
/// ⚠️★ **`client` 必须带**（2026-10-04 补）：服务端拿它填 `senderClientID`，而界面用它
/// 判「这条是不是我发的」（`EntryView::mine` → 卡片靠左还是靠右）。少了它，自己发的
/// **文件**会排到「别人那一边」—— 而文本那条一直带着，于是只有文件看着不对。
/// ⚠️ 与 `text_url` 同一套：`name`（给人看的设备名）与 `client`（程序判归属）都要带。
/// 空值也带 —— 「空」与「没这个参数」含义不同（服务端对 `name` 空会去推 User-Agent）。
pub fn upload_url(
    server: &str,
    room: &str,
    device_name: &str,
    client_id: &str,
) -> Result<Endpoint, Msg> {
    api_url(
        server,
        "/upload",
        &[("room", room), ("name", device_name), ("client", client_id)],
    )
}

/// `POST /upload/chunk` —— **分片上传的初始化**（body 是文件名，回一个 uuid）。
///
/// ⚠️★ 这一条与 `/upload` **是同一个 handler**，靠 `Content-Type: text/plain`（**全等**）
/// 在服务端分叉（`files.rs`）。所以这里只给地址，那一个头由 `uploader` 自己带。
///
/// ⚠️★ `client` 同样必须带（理由见 [`upload_url`]）：收尾那一步才是真正**入库广播**的
/// 那一步，服务端是在那里填 `senderClientID` 的 —— 少一个参数，大文件就又排到左边去了。
pub fn chunk_init_url(
    server: &str,
    room: &str,
    device_name: &str,
    client_id: &str,
) -> Result<Endpoint, Msg> {
    api_url(
        server,
        "/upload/chunk",
        &[("room", room), ("name", device_name), ("client", client_id)],
    )
}

/// `POST /upload/chunk/:uuid` —— **追加一片**（body 就是那一片的字节）。
///
/// ⚠️ 它**不带 `client`** 也不带房间：身份（房间 / 设备 / 客户端 id）在初始化那一步已经
/// 记在服务端的文件登记里了，而这一条只是往文件后面追加字节。
///
/// ⚠️ 房间**不带**：服务端按 uuid 查到文件自己登记的那个房间
///（`files.rs` 的 `file_room`）—— 客户端传什么不算数。
pub fn chunk_push_url(server: &str, uuid: &str) -> Result<Endpoint, Msg> {
    api_url(server, &format!("/upload/chunk/{uuid}"), &[])
}

/// `POST /upload/finish/:uuid` —— 分片上传**收尾**（登记消息 + 广播）。
///
/// ⚠️ 房间要带：收尾那一趟服务端还在做鉴权，而「文件自己登记的房间」只在
/// 客户端传 `default` 时才被采用（`files.rs::finish`）—— 带上我们真正要发的那个，
/// 就不必依赖那条兜底。
pub fn chunk_finish_url(
    server: &str,
    room: &str,
    device_name: &str,
    client_id: &str,
    uuid: &str,
) -> Result<Endpoint, Msg> {
    api_url(
        server,
        &format!("/upload/finish/{uuid}"),
        &[("room", room), ("name", device_name), ("client", client_id)],
    )
}

/// `GET /content` —— 取历史（**游标是 id、返回正序**，见 `dev-docs/api.md` §2）。
///
/// ⚠️ 不带 `?format=`：这个端点**永远**是 JSON（`{"messages":[…]}`），
/// 而 `?format=` 那套只对 `/content/latest` 与 `/content/:id` 生效（§1.3）。
/// 顺手也就不用操心「别用 `.json` 后缀」那条了。
pub fn history_url(server: &str, room: &str, limit: usize) -> Result<Endpoint, Msg> {
    api_url(
        server,
        "/content",
        &[("room", room), ("limit", &limit.to_string())],
    )
}

/// `WS /push` —— 下行。
///
/// ⚠️ 协议要跟着换：`http`→`ws`、`https`→`wss`。换了域名不换协议，
/// 表现是「https 站点上 WebSocket 静默连不上」（混合内容被浏览器/系统拦掉）。
pub fn ws_url(server: &str, room: &str) -> Result<Endpoint, Msg> {
    let mut url = api_url(server, "/push", &[("room", room)])?;
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        _ => "ws",
    };
    url.set_scheme(scheme)
        .map_err(|()| Msg::key("schemeChangeFailed").param("scheme", scheme))?;
    Ok(url)
}

/// `GET /file/:cache/:name` —— 下载一个文件。
///
/// ⚠️★ **本地拼，不用条目里那个 `url`**。
/// 条目里的 `url` 是**上传时**服务端按当时的 `Host` 拼出来的 ——
/// 换了域名、走了反代、或者上传方是从内网地址进来的，那个 url 就是别人家的地址。
/// 下载必须打在我们**正在用的这台**服务端上。
///
/// ⚠️ 文件名要过 [`crate::download::sanitize_file_name`] 再用：
/// 带 `/` 或 `..` 的名字会拼出别的路径（这是**路径穿越**，不只是显示问题）。
pub fn download_url(server: &str, cache: &str, name: &str) -> Result<Endpoint, Msg> {
    let safe = crate::download::sanitize_file_name(name);
    if safe.is_empty() {
        return Err(Msg::key("fileNameEmpty"));
    }
    api_url(server, &format!("/file/{cache}/{safe}"), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️★ 子路径前缀**必须保留**（`dev-docs/api.md` §1.1）。
    /// 丢了它的表现是「主页能开、接口全 404」—— 一个很难往回推的症状。
    #[test]
    fn keeps_the_sub_path_prefix() {
        assert_eq!(
            api_url("http://host:9501/clip9", "/text", &[])
                .unwrap()
                .as_str(),
            "http://host:9501/clip9/text"
        );
        assert_eq!(
            api_url("http://host:9501/clip9/", "/text", &[])
                .unwrap()
                .as_str(),
            "http://host:9501/clip9/text"
        );
        assert_eq!(
            api_url("http://host:9501", "/text", &[]).unwrap().as_str(),
            "http://host:9501/text"
        );
    }

    /// ⚠️★ 这条钉的正是「`http://` 被吃成 `http:/`」那类路径清洗 ——
    /// 只用 `Url`，不做「猜你想去哪」的拼接。
    #[test]
    fn the_scheme_slashes_survive() {
        let url = api_url("http://127.0.0.1:9501", "/push", &[("room", "default")]).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:9501/push?room=default");
        assert!(
            url.as_str().starts_with("http://"),
            "协议里的双斜杠不能被吃掉"
        );
    }

    /// 查询参数是 **append**，不是覆盖；而且值会被正确转义。
    ///
    /// ⚠️ 转义规则要说清：**查询串走表单编码**（`url::Url::query_pairs_mut` 的规定），
    /// 所以空格是 `+` 而不是 `%20`。这不是随便定的 —— 两边的服务端（Go 的
    /// `url.ParseQuery`、Rust axum 的 `serde_urlencoded`）都按表单编码解，
    /// `+` 会还原成空格。而**路径**里空格仍然是 `%20`（见下载地址那条测试）。
    #[test]
    fn query_params_are_appended_and_encoded() {
        let url = api_url(
            "http://h:9501",
            "/text",
            &[("room", "我的 房间"), ("name", "Mac & iPhone")],
        )
        .unwrap();

        // 解出来必须与传进去的一模一样（这是最要紧的一条）。
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![
                ("room".into(), "我的 房间".into()),
                ("name".into(), "Mac & iPhone".into()),
            ]
        );
        // 原始串里：空格 → `+`，`&` → `%26`（不转义 `&` 会把一个参数切成两个）。
        assert!(url.as_str().contains('+'), "空格按表单编码成 +：{url}");
        assert!(url.as_str().contains("%26"), "& 必须转义：{url}");
        assert!(!url.as_str().contains("Mac & iPhone"), "不许原样带进查询串");

        // 没有参数时**不留尾随问号**。
        let bare = api_url("http://h:9501", "/push", &[]).unwrap();
        assert_eq!(bare.as_str(), "http://h:9501/push");
    }

    /// `room` 一律**显式下发**（§11.6：省略 room 在部分端点上等于「任意房间」）。
    #[test]
    fn room_is_always_sent_explicitly() {
        for url in [
            text_url("http://h:9501", "default", "", "").unwrap(),
            upload_url("http://h:9501", "default", "", "client-1").unwrap(),
            history_url("http://h:9501", "default", 50).unwrap(),
            ws_url("http://h:9501", "default").unwrap(),
        ] {
            assert_eq!(
                url.query_pairs()
                    .find(|(k, _)| k == "room")
                    .map(|(_, v)| v.into_owned()),
                Some("default".to_owned()),
                "{url} 必须显式带 room"
            );
        }
    }

    /// ⚠️★ **凭据不进 URL**（§8 审计清单那条）。
    #[test]
    fn credentials_never_land_in_the_url() {
        // 真实用法里凭据只在请求头里 —— 这些端点根本没有「塞凭据」的参数槽。
        let urls = [
            text_url("http://h:9501", "work", "Mac", "client-1").unwrap(),
            upload_url("http://h:9501", "work", "Mac", "client-1").unwrap(),
            history_url("http://h:9501", "work", 50).unwrap(),
            ws_url("http://h:9501", "work").unwrap(),
        ];
        for url in &urls {
            let text = url.as_str();
            assert!(!text.contains("auth="), "凭据不能进查询串：{text}");
            assert!(
                !text.contains('@'),
                "连 userinfo 形式的凭据也不许出现：{text}"
            );
        }

        // 反向再钉一次：**把密码当房间名传进去，它也只是房间名**（不是「凭据泄漏」），
        // 而真正的凭据通道是请求头 —— 那是 `uploader` 的职责，见那里的断言。
        let url = text_url("http://h:9501", "work", "Mac", "client-1").unwrap();
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![
                ("room".into(), "work".into()),
                ("name".into(), "Mac".into()),
                ("client".into(), "client-1".into()),
            ]
        );
    }

    /// `name` 与 `client` 两个参数**都要有**，而且各是各的（不许混用）。
    #[test]
    fn name_and_client_are_distinct_params() {
        let url = text_url("http://h:9501", "work", "书房的 Mac", "uuid-42").unwrap();
        let pairs: std::collections::HashMap<_, _> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(pairs.get("name").map(String::as_str), Some("书房的 Mac"));
        assert_eq!(pairs.get("client").map(String::as_str), Some("uuid-42"));
    }

    /// ⚠️★ **上传那三条也要带 `client`**（2026-10-04 修的那条）。
    ///
    /// 服务端拿 `client` 填 `senderClientID`，界面据此判「这条是不是我发的」
    /// （`EntryView::mine` → 卡片靠左还是靠右）。**文本那条一直带着，只有文件没带** ——
    /// 症状精确得有点好笑：「我发的文字在右边，我发的文件跑到左边去了」。
    /// ⚠️ 分片那条的收尾（`finish`）才是真正入库广播的一步，所以它也必须带。
    #[test]
    fn the_upload_carries_the_client_id() {
        let client_of = |url: &url::Url| {
            url.query_pairs()
                .find(|(k, _)| k == "client")
                .map(|(_, v)| v.into_owned())
        };
        assert_eq!(
            client_of(&upload_url("http://h:9501", "work", "Mac", "client-1").unwrap()).as_deref(),
            Some("client-1"),
            "整份上传要带 client（不然自己发的文件排到别人那边）"
        );
        assert_eq!(
            client_of(&chunk_init_url("http://h:9501", "work", "Mac", "client-1").unwrap())
                .as_deref(),
            Some("client-1"),
            "分片初始化要带 client"
        );
        assert_eq!(
            client_of(
                &chunk_finish_url("http://h:9501", "work", "Mac", "client-1", "u-1").unwrap()
            )
            .as_deref(),
            Some("client-1"),
            "分片收尾要带 client —— 入库广播是在那一步"
        );
    }

    /// ⚠️ 协议要跟着换：`https` → `wss`。不换的表现是「https 上 WebSocket 静默连不上」。
    #[test]
    fn ws_scheme_follows_the_server_scheme() {
        assert_eq!(
            ws_url("https://host:9501", "default").unwrap().as_str(),
            "wss://host:9501/push?room=default"
        );
        assert_eq!(
            ws_url("http://127.0.0.1:9501", "default").unwrap().as_str(),
            "ws://127.0.0.1:9501/push?room=default"
        );
    }

    /// 历史地址带 limit（缺省值/上限是服务端那根旋钮，客户端只管要）。
    #[test]
    fn history_url_carries_the_limit() {
        let url = history_url("http://h:9501", "work", 50).unwrap();
        assert_eq!(url.path(), "/content");
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "limit")
                .map(|(_, v)| v.into_owned()),
            Some("50".to_owned())
        );
    }

    /// 空地址 / 畸形地址要**报错**，不能拼出一个看起来像 URL 的东西。
    #[test]
    fn bad_server_addresses_are_errors() {
        assert!(api_url("", "/text", &[]).is_err());
        assert!(api_url("   ", "/text", &[]).is_err());
        assert!(api_url("不是地址", "/text", &[]).is_err());
    }

    /// ⚠️★ 下载地址**本地拼**，而且文件名要过清洗 —— `..` 不能拼出别的路径。
    #[test]
    fn download_url_is_built_locally_and_sanitised() {
        let url = download_url("http://h:9501", "uuid-1", "照片 一.png").unwrap();
        // ⚠️ `Url::path()` 给的是**编码后**的路径（不是解码后的），所以这里断言编码形式；
        // 空格在**路径**里是 `%20`（与查询串的 `+` 不同 —— 两条规则别混）。
        assert_eq!(
            url.path(),
            "/file/uuid-1/%E7%85%A7%E7%89%87%20%E4%B8%80.png"
        );
        assert_eq!(
            url.as_str(),
            "http://h:9501/file/uuid-1/%E7%85%A7%E7%89%87%20%E4%B8%80.png"
        );

        // 路径穿越：`../../etc/passwd` 只能留下最后一段。
        let evil = download_url("http://h:9501", "uuid-1", "../../etc/passwd").unwrap();
        assert_eq!(evil.path(), "/file/uuid-1/passwd");

        // 名字被清洗成空 → 报错，而不是拼出 `/file/uuid-1/`。
        assert!(download_url("http://h:9501", "uuid-1", "   ").is_err());
    }
}
