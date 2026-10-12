//! `POST /convert/{uuid}` —— 把一条**已上传的文件条目**转成 Markdown。
//!
//! 这是 `clip9-actions` 的 [`clip9_actions::doc`] 在服务端的落点。
//! 白板要「文档进画布」，而画布只认结构化的东西 —— 中间那一步就是「字节 → Markdown」。
//!
//! # 为什么挂在**已有的文件条目**上，而不是新开一条「传字节过来转」
//!
//! 三条理由，一条比一条硬：
//!
//! 1. **白板要留溯源**（`dev-docs/specs/whiteboard-anydoc-integration.md` §2.4）：
//!    铺到画布上的元素要带 `clip9FileId` 指回原始文档 —— 文档本来就得先是一条文件条目。
//! 2. **白嫖整条文件管线**：房间鉴权、分享令牌、过期双检、房间归属 —— 一条都不用重写。
//!    新开一条「传字节」的路，等于把 `files.rs` 那些坑（过期竞态、目录穿越、
//!    `?room=` 不能当鉴权依据）在旁边**再踩一遍**。
//! 3. **不用再定一次请求体上限**：读的是磁盘上已经存在的东西，不是客户端送来的字节。
//!
//! # 为什么**没有** `?format=` 之类的参数
//!
//! 格式判定只有一处（[`clip9_actions::doc::to_markdown`] 的「内容优先、扩展名兜底」）。
//! 在这里再开一个「你自己说是什么格式」的旋钮，等于**把同一件事判两遍** ——
//! 判得不一样时，症状是「同一个文件走两条路转出不同结果」，而那正是
//! `ARCHITECTURE.md` §5.3.1 记着的那类坑。
//!
//! # 只在 `doc` feature 打开时才存在
//!
//! anydoc 连带的解析器是几 MB，OpenWrt（flash 几十 MB）那条线默认不带
//! （判据同 `clip9-actions` 的 `highlight`）。关着时**这条路径压根不注册** ——
//! 请求落到静态资源兜底，是 404，而不是「500 说功能没编进来」。
//! 前端据此显隐入口，判据从 `GET /server` 的 `convert.enabled` 读，**别自己猜**。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::json;

use crate::auth_gate::require_file_read_access;
use crate::error::{codes, write_error};
use crate::files::{file_room, stored_path};
use crate::handlers::json_response;
use crate::state::{AppState, now_secs};

/// 愿意读进内存的**输入**上限。
///
/// ⚠️ 为什么不复用 `UPLOAD_BODY_HARD_CAP`（16 MiB）：那条管的是「一次 HTTP 请求的 body」，
/// 而这里读的是**磁盘上的整个文件** —— 两个不同的问题。混用会让其中一条失去意义
/// （前者管的是「客户端一次能送多大」，后者管的是「我们一次愿意解多大」）。
///
/// ⚠️ 取 32 MiB 的依据：anydoc 在内存里展开整份文档（zip 解包 + XML 解析 + 文本缓冲），
/// 峰值通常是原文件的**几倍**；而 `files::THUMBNAIL_MAX_SOURCE` 也是同一个数
/// —— 「一次解码愿意吃多大源文件」在这个项目里已经有过一次取舍，不另立一个。
/// 再大的文档该走「前端 WASM 本地转」或干脆不做，而不是让服务端把它读进来。
/// ⚠️ `pub` 而不是 `pub(crate)`：`tests/convert_api.rs` 要拿它造「刚好超一点」的用例
/// （集成测试是**另一个 crate**，`pub(crate)` 它看不见）。
pub const CONVERT_INPUT_MAX: i64 = 32 * 1024 * 1024;

/// `GET /server` 里 `convert` 那一段。
///
/// ⚠️ 与 `automation::capability` **不同**：那里要算「这个房间能不能用自动化」，
/// 因为它是**房间级的策略**；而能不能转换只取决于**编译时有没有带 `doc` feature**
/// （部署方的选择），与房间、与请求者都无关。
/// 而「这一份文件转不转得成」要读了字节才知道 —— 它会随文件而变，不是握手时能回答的问题。
///
/// `extensions` 给前端的 `<input accept>` 用。⚠️ 它只是**提示**：
/// 真正的判定在 [`clip9_actions::doc::to_markdown`] 里（内容优先、扩展名兜底），
/// 所以界面拿到「不在列表里」时该说「可能转不了」，不是「这个文件不行」。
pub fn capability() -> serde_json::Value {
    json!({
        "enabled": true,
        "extensions": clip9_actions::doc::SUPPORTED_EXTENSIONS,
    })
}

/// `POST /convert/{uuid}` —— 转换一条已上传的文件，回 `{markdown, name, chars}`。
///
/// 鉴权与 `GET /file/{uuid}` **完全一致**（含分享令牌那一支）：转换读的就是这个文件的字节，
/// 凭据要求不该比直接下载更松 —— 否则「转成 Markdown」就是一条绕过分享限制读内容的侧门。
pub async fn document(
    State(state): State<Arc<AppState>>,
    Path(params): Path<HashMap<String, String>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let uuid = params.get("uuid").cloned().unwrap_or_default();
    let room = file_room(&state, &uuid, &query);

    if let Some(response) =
        require_file_read_access(&state, &headers, &query, &room, Some(uuid.as_str()))
    {
        return response;
    }

    let Ok(Some(info)) = state.store.get_file(&uuid) else {
        return write_error(
            StatusCode::NOT_FOUND,
            "file_not_found",
            "File not found or expired",
            "文件未找到或已过期",
        );
    };

    // ⚠️ 与 `files::file` 同样的过期双检：后台清理（`file_cleanup`，每 5 分钟一轮）是异步的，
    // 中间有时间窗，这里兜住「后台还没跑到就被访问」的那一下。
    // `expire_time == 0` 是**永不过期**。
    if info.expire_time > 0 && info.expire_time < now_secs() {
        return write_error(
            StatusCode::NOT_FOUND,
            codes::FILE_EXPIRED,
            "File expired",
            "文件已过期",
        );
    }

    // ⚠️★ 按**登记的大小**先拦一道，再读盘。`tokio::fs::read` 会把整份读进内存 ——
    // 让一个 300 MiB 的 PDF 走到那一步就是一次现成的 OOM。
    // ⚠️ 用登记的 `size` 而不是先 `metadata()` 问盘：登记值就是当初写下去的那个数，
    // 而多一次 `stat` 只是把同一个判断往后挪一格。
    if info.size > CONVERT_INPUT_MAX {
        return write_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large_to_convert",
            "File is too large to convert",
            &format!(
                "文件太大，无法转换（上限 {} MiB，这份约 {} MiB）",
                CONVERT_INPUT_MAX / 1024 / 1024,
                // ⚠️ 向上取整：1.4 MiB 报成「1 MiB」会让人以为没超限。
                (info.size + 1024 * 1024 - 1) / (1024 * 1024)
            ),
        );
    }

    let bytes = match tokio::fs::read(stored_path(&state, &uuid)).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(error = %e, uuid = %uuid, "读文件失败（转换）");
            return write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "file_read_failed",
                "Failed to read file",
                "读取文件失败",
            );
        }
    };

    // ⚠️ 扩展名从**登记的名字**来（磁盘上是裸 uuid，见 `stored_path` 的注释）。
    // 它只是兜底：CSV 之外都靠内容嗅探，把 `.docx` 改名成 `.bin` 照样能转。
    match clip9_actions::doc::convert(&bytes, Some(&info.name)) {
        Ok(converted) => {
            // ⚠️ 先算字符数再搬走 `markdown`：`json!` 里的表达式是**按值**取的，
            // 写在 `"markdown"` 之后就是「用了已经搬走的东西」。
            // ⚠️ 字符数不是字节数 —— 前端拿它决定「这份文档铺不铺得下」，而画布上按字符排。
            let chars = converted.markdown.chars().count();
            // 内嵌图片。⚠️ `null` **不是**「没有图」，是「这个格式读不出文档模型」
            // （`to_document` 对 PDF 不支持）。前端必须把 `null` 和「0 张」分开说 ——
            // 把 `null` 当 0 等于对一份满是插图的 PDF 说「这份文档没有图片」。
            let images = converted.images.map(|set| {
                json!({
                    "total": set.total,
                    "truncated": set.truncated,
                    "items": set.items.iter().map(|image| json!({
                        "mime": image.media_type,
                        "data": image.data_base64,
                        "bytes": image.bytes,
                    })).collect::<Vec<_>>(),
                })
            });
            // PDF 的版面分析。⚠️ `null` = **不是 PDF**（不是「没有多栏」）。
            // ⚠️ 前端**必须**把「检测到多栏」变成一句显式警告：双栏 PDF 抽出来的
            // 文字是**左右交错**的，而它**看起来像正常文字** —— 不警告就是静默出错。
            let pdf = converted.pdf.map(|layout| {
                json!({
                    "pageCount": layout.page_count,
                    "multiColumnPages": layout.multi_column_pages,
                })
            });
            json_response(&json!({
                "markdown": converted.markdown,
                "name": info.name,
                "chars": chars,
                "images": images,
                "pdf": pdf,
            }))
        }
        Err(error) => {
            // ⚠️ 转换失败是**这份文档的问题**（格式不认 / 加密 / 扫描件 / 结构损坏 / 超上限），
            // 所以是 400 而不是 500 —— 客户端据此提示「换一份文件」，而不是「服务端坏了」。
            //
            // ⚠️ 文案直接用 `doc.rs` 那句中文，**不在这里另写一套**：那是唯一一处知道
            // 「为什么转不了」的地方（它按 `ConvertError` 的变体逐条翻译），在这儿复述必然漂。
            // 于是这里只给一个**粗粒度**的 `code`（`convert_failed`），细因在 `message` 里。
            // ⚠️ 哪天界面需要按细因分支（比如给「需要 OCR」配一个「了解为什么」的链接），
            // 正确的做法是让 `doc.rs` 把它**结构化**地暴露出来，而不是在这儿解析中文字符串。
            tracing::info!(uuid = %uuid, name = %info.name, error = %error, "文档转换失败");
            write_error(
                StatusCode::BAD_REQUEST,
                "convert_failed",
                "Failed to convert document",
                &error.to_string(),
            )
        }
    }
}

// ⚠️★ 下面三条是**编译期**断言，不是测试：它们全是常量之间的比较。
// 理由与 `lib.rs` 那两条 `const _` 完全一样 —— 常量比较就该在编译期断。
// （写 `#[test]` 的版本会被 clippy 的 `assertions_on_constants` 拦下，它是对的。）
//
// ⚠️ 第一条是这条链路上最容易踩的一处：转换上限**必须**比单次上传上限大，
// 否则会出现一个说不通的窗口 —— 文件传得上来了，却永远转不了。
const _: () = assert!(
    CONVERT_INPUT_MAX as usize > crate::UPLOAD_BODY_HARD_CAP,
    "转换上限比单次上传上限还小 —— 会有「传得上来、转不了」的文件"
);
const _: () = assert!(
    CONVERT_INPUT_MAX >= 16 * 1024 * 1024,
    "小于 16 MiB 会把常见的 PPT / 带图文档挡在外面"
);
const _: () = assert!(
    CONVERT_INPUT_MAX <= 64 * 1024 * 1024,
    "大于 64 MiB 之后「先读进内存再解析」就不再是个可辩护的取舍了"
);
