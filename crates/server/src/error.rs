//! 错误响应：**所有**错误走这里，一律 JSON。
//!
//! 对应 Go `handler.go:1292` 的 `writeError`。
//!
//! # 为什么绝不按 `Accept` 分叉
//!
//! 曾经按 Accept 分叉过，后果是：
//!
//! - Apple 快捷指令的「获取 URL 内容」**不暴露 HTTP 状态码**，只能读响应体，
//!   而且它用 `getDictionary` 解析 —— 纯文本错误让它解析不出字段，走到兜底分支；
//! - 更糟的是文件分支会拿错误文本去 `setName` + `saveFilePrompt`，
//!   **保存出一个顶着原文件名的假文件**；
//! - 捷径**根本不发 Accept 头**，于是「文本超限」这类错误仍然是纯文本，
//!   捷径读不到 `error`，把 413 误报成「服务器未确认保存，请检查部署地址及服务器状态」，
//!   把人往部署/网络方向带。
//!
//! 同一状态码对应两种响应体形状，等于要求每个客户端各写两套解析逻辑。
//!
//! # 三个字段的分工，别混用
//!
//! - `code`：机器码，snake_case。给程序判断用（前端据此分支、测试据此断言）。
//!   ⚠️ **一旦发布就不要改** —— 改了等于破坏契约。
//! - `error`：英文人话。给「会看英文的人」和日志用，与 Worker 侧同一风格。
//! - `message`：中文人话。已分发的捷径、Android 快捷方式、前端都在展示它。

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// 契约里的机器码。
///
/// ⚠️ 做成常量而不是散落的字符串字面量：这些值是**对外契约**，
/// 拼错一个字母不会有编译错误，只会让客户端的 `if code == ...` 静默走错分支。
pub mod codes {
    // 通用
    pub const METHOD_NOT_ALLOWED: &str = "method_not_allowed";
    pub const INVALID_BODY: &str = "invalid_body";

    // 房间 / 鉴权
    pub const ROOM_FORBIDDEN: &str = "room_forbidden";
    pub const ROOM_AUTH_REQUIRED: &str = "room_auth_required";
    pub const ROOM_LIST_DISABLED: &str = "room_list_disabled";
    /// WS 握手：一个凭据都没带。**和「凭据不对」分开** —— 客户端据此决定「提示输入密码」
    /// 还是「提示密码错了」。
    pub const UNAUTHORIZED_MISSING_TOKEN: &str = "unauthorized_missing_token";
    /// WS 握手：带了凭据但不对。
    pub const UNAUTHORIZED_INVALID_TOKEN: &str = "unauthorized_invalid_token";

    // 正文
    pub const TEXT_TOO_LONG: &str = "text_too_long";
    pub const INVALID_ID: &str = "invalid_id";
    pub const INVALID_REVOKE_ID: &str = "invalid_revoke_id";

    // 内容
    pub const CONTENT_NOT_FOUND: &str = "content_not_found";
    pub const NO_CONTENT: &str = "no_content";
    pub const INVALID_CONTENT_PATH: &str = "invalid_content_path";
    pub const INVALID_CONTENT_ID: &str = "invalid_content_id";
    pub const UNSUPPORTED_FORMAT: &str = "unsupported_format";
    pub const FILE_EXPIRED: &str = "file_expired";
    pub const MESSAGE_NOT_FOUND: &str = "message_not_found";
    pub const MESSAGE_NOT_UPDATABLE: &str = "message_not_updatable";

    // 看板
    pub const INVALID_COLUMN: &str = "invalid_column";
}

/// 构造一个错误响应。
///
/// 尾部补一个 `\n`，和 Go 的 `json.NewEncoder(w).Encode(...)` 一致 ——
/// 这样两边的错误响应可以**逐字节比对**，而不是每次都得先解析成 JSON 再比。
#[must_use]
pub fn write_error(status: StatusCode, code: &str, error: &str, message: &str) -> Response {
    let mut body = serde_json::to_string(&json!({
        "code": code,
        "error": error,
        "message": message,
    }))
    .unwrap_or_else(|_| {
        r#"{"code":"encode_failed","error":"encode failed","message":"编码失败"}"#.to_owned()
    });
    body.push('\n');

    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// 几个高频组合的快捷方式 —— 参数顺序容易记反，包一层省得每次核对。
pub mod shortcuts {
    use super::{codes, write_error};
    use axum::http::StatusCode;
    use axum::response::Response;

    #[must_use]
    pub fn method_not_allowed() -> Response {
        write_error(
            StatusCode::METHOD_NOT_ALLOWED,
            codes::METHOD_NOT_ALLOWED,
            "Only POST is allowed",
            "仅允许 POST 请求",
        )
    }

    #[must_use]
    pub fn room_forbidden() -> Response {
        write_error(
            StatusCode::UNAUTHORIZED,
            codes::ROOM_FORBIDDEN,
            "No access to this room",
            "无权访问该房间",
        )
    }

    #[must_use]
    pub fn content_not_found() -> Response {
        write_error(
            StatusCode::NOT_FOUND,
            codes::CONTENT_NOT_FOUND,
            "Content not found",
            "内容未找到",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn error_body_is_json_with_three_fields_and_a_trailing_newline() {
        let resp = write_error(
            StatusCode::UNAUTHORIZED,
            codes::ROOM_FORBIDDEN,
            "No access to this room",
            "无权访问该房间",
        );
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json; charset=utf-8"
        );

        let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.ends_with('\n'), "尾部要有换行，和 Go 的 Encode 对齐");

        // ⚠️ 三个字段一个都不能少 —— 捷径用 getDictionary 读，少一个字段它就解析不出来。
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["code", "error", "message"],
            "key 要按字典序（和 Go 的 map 一致）"
        );
    }
}
