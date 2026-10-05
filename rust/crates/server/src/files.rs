//! 文件上传与下载。
//!
//! 对应 Go `handler.go` 的 `handle_upload` / `handle_chunk` / `handle_finish` / `handle_file`。
//!
//! # 四条路径
//!
//! ```text
//! POST   /upload                   整份 multipart 上传（小文件走这条）
//! POST   /upload/chunk             分片上传的**初始化**：body 是文件名，回一个 uuid
//! POST   /upload/chunk/<uuid>      追加一个分片
//! POST   /upload/finish/<uuid>     收尾：登记消息 + 广播
//! GET    /file/<uuid>[/<name>]     下载 / 预览（支持 Range）
//! DELETE /file/<uuid>[/<name>]     删除
//! ```
//!
//! # ⚠️ 鉴权按**文件自己记录的房间**，不信客户端传的 `?room=`
//!
//! 这是整条链路上最容易出洞的一处：`GET /file/<uuid>/<name>?room=default` 如果按
//! `?room=` 去查策略，而 default 往往没设密码 → **直接放行**，受保护房间的文件就被读走了。
//! Go 那边的 `inferRequestRoom` 专门处理了这件事，这里照做（见 [`file_room`]）。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::response::Response;
use clip9_core::resolve_file_expire_seconds;
use clip9_protocol::{File, FileReceive, ReceiveBase, ReceiveHolder, normalize_room_name};
use serde_json::json;
use tower::ServiceExt;

use crate::auth_gate::{require_file_read_access, require_room_access};
use crate::error::{codes, write_error};
use crate::handlers::{content_url, determine_response_type, json_response, sender_base};
use crate::state::{AppState, now_secs};

/// 超过这个大小的文件**不生成缩略图**（解码一张 100MB 的图会把内存吃光）。
const THUMBNAIL_MAX_SOURCE: u64 = 32 * 1024 * 1024;

/// 缩略图短边目标尺寸。
const THUMBNAIL_MIN_SIDE: u32 = 64;

/// 缩略图的 JPEG 质量（Go 用 70）。
const THUMBNAIL_JPEG_QUALITY: u8 = 70;

/// 计算文件的过期时刻。`0` = 永不过期。
///
/// ⚠️ 房间级的 `roomAuth[x].fileExpire` **覆盖**全局 `file.expire`，
/// 而 `fileExpire: 0` 的含义是**永不过期**（不是「立刻过期」）。
fn expire_at(state: &AppState, room: &str) -> i64 {
    let seconds = resolve_file_expire_seconds(&state.config, room);
    if seconds > 0 { now_secs() + seconds } else { 0 }
}

/// 文件在磁盘上的路径。
///
/// ⚠️ 存成 `<uuid>`、**不带扩展名** —— 和 Go 一致。别「顺手」加上原名后缀：
/// 用户上传的名字里可能有 `/` 或 `..`，那是一个**目录穿越**。
fn stored_path(state: &AppState, uuid: &str) -> PathBuf {
    FsPath::new(&state.config.server.storage_dir).join(uuid)
}

/// 删掉一个文件的**磁盘字节**。
///
/// ⚠️ 幂等：文件本来就不在（`NotFound`）当成功 —— 清理路径上「已经没了」不是错误。
/// ⚠️ 删字节**必须排在删登记之前**：反过来的话，中途失败会留下「登记没了、字节还在」
/// 的孤儿字节，而那种状态在界面上完全看不出来（见 `file_cleanup.rs`）。
///
/// ⚠️ 返回 `Result` 而不是自己吞掉：**「删不掉」在两条路径上的含义完全不同** ——
/// 后台清理只需记一条日志（下一轮再试），而用户点的 `DELETE /file/<uuid>`
/// 必须回 500（他要求删、我们就得说清有没有删成）。把这件事收在调用方。
pub(crate) async fn remove_stored_file(state: &AppState, uuid: &str) -> std::io::Result<()> {
    let path = stored_path(state, uuid);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// 这个文件属于哪个房间。
///
/// ⚠️★ 已登记的文件**以它自己记录的房间为准**，不看客户端传的 `?room=`。
/// 否则 `GET /file/<uuid>/<name>?room=default` 就能把受保护房间的文件读出来 ——
/// 鉴权会去查 default 的策略，而 default 往往没设密码，直接放行。
///
/// 没登记过的 uuid 才回落到 `?room=`（那种情况下下面自己也找不到文件，会 404，不泄字节）。
fn file_room(state: &AppState, uuid: &str, query: &HashMap<String, String>) -> String {
    if let Ok(Some(file)) = state.store.get_file(uuid) {
        return normalize_room_name(&file.room);
    }
    normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""))
}

// ── POST /upload 与 /upload/chunk（初始化） ───────────────────────────

/// `POST /upload` —— 整份 multipart 上传。
pub async fn upload(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let room = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    if let Some(resp) = require_room_access(&state, &headers, &query, &room) {
        return resp;
    }

    if let Some(len) = content_length(&headers)
        && state.config.file.limit > 0
        && len > state.config.file.limit as u64
    {
        return write_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "File too large",
            &format!("文件大小超出限制 (最大 {} 字节)", state.config.file.limit),
        );
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // ⚠️ Go 那边判「分片初始化」用的是 `path` 后缀 **且** `Content-Type == "text/plain"`（**全等**，
    // 所以 `text/plain; charset=utf-8` 不算）。这里照抄：不等就走 multipart。
    let boundary = multer::parse_boundary(content_type).ok();

    // ⚠️ 判「分片初始化」只看 `Content-Type == "text/plain"`（**全等** ——
    // `text/plain; charset=utf-8` 不算，会落到 multipart 解析然后 400）。
    // 路径那一半由**路由表**保证：`/upload` 和 `/upload/chunk` 都指向这个 handler，
    // 只有后者是初始化。
    //
    // Go 那边靠「路径后缀 + Content-Type 全等」在一个 handler 里分叉；这里路径交给 axum 分，
    // 判定条件就只剩 Content-Type 一半 —— 所以原来那个 `is_chunk_init_path`（恒 true）
    // 是**死代码**，删了。
    if content_type == "text/plain" {
        return init_chunk_upload(&state, &room, &body).await;
    }

    let Some(boundary) = boundary else {
        return write_error(
            StatusCode::BAD_REQUEST,
            "form_parse_failed",
            "Cannot parse form data",
            "无法解析表单数据",
        );
    };

    let Some((filename, data)) = read_multipart_file(body, boundary).await else {
        return write_error(
            StatusCode::BAD_REQUEST,
            "file_field_missing",
            "Cannot read uploaded file",
            "无法获取文件",
        );
    };

    let uuid = uuid::Uuid::new_v4().to_string();
    if let Err(e) = write_all(&state, &uuid, &data).await {
        tracing::error!(error = %e, uuid, "写入文件失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "file_save_failed",
            "Cannot save file",
            "无法保存文件",
        );
    }

    let size = data.len() as i64;
    let expire = expire_at(&state, &room);
    let file = File {
        name: filename.clone(),
        uuid: uuid.clone(),
        size,
        upload_time: now_secs(),
        expire_time: expire,
        room: room.clone(),
    };
    if let Err(e) = state.store.put_file(&file) {
        tracing::error!(error = %e, "登记文件失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "file_save_failed",
            "Cannot save file",
            "无法保存文件",
        );
    }

    finish_file_message(&state, &headers, peer, &query, file).await
}

/// `POST /upload/chunk` —— 分片上传的初始化。body 是**文件名**，回一个 uuid。
///
/// ⚠️ 这一路**不落盘**，只登记；真正的字节在后续的 `/upload/chunk/<uuid>` 里追加。
async fn init_chunk_upload(state: &Arc<AppState>, room: &str, body: &Bytes) -> Response {
    let filename = String::from_utf8_lossy(body).into_owned();
    let uuid = uuid::Uuid::new_v4().to_string();

    let file = File {
        name: filename,
        uuid: uuid.clone(),
        size: 0, // 初始大小为 0，分片会累加
        upload_time: now_secs(),
        expire_time: expire_at(state, room),
        room: room.to_owned(),
    };
    if let Err(e) = state.store.put_file(&file) {
        tracing::error!(error = %e, "登记分片上传失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "file_save_failed",
            "Cannot save file",
            "无法保存文件",
        );
    }

    json_response(&json!({ "result": { "uuid": uuid } }))
}

// ── POST /upload/chunk/<uuid> ─────────────────────────────────────────

pub async fn chunk(
    State(state): State<Arc<AppState>>,
    ConnectInfo(_peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let room = file_room(&state, &uuid, &query);
    if let Some(resp) = require_room_access(&state, &headers, &query, &room) {
        return resp;
    }

    let Ok(Some(mut file)) = state.store.get_file(&uuid) else {
        return write_error(
            StatusCode::BAD_REQUEST,
            "invalid_uuid",
            "Invalid UUID",
            "无效的 UUID",
        );
    };

    let new_size = file.size + body.len() as i64;
    if state.config.file.limit > 0 && new_size > state.config.file.limit {
        return write_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "File too large",
            &format!("文件大小已超过限制 (最大 {} 字节)", state.config.file.limit),
        );
    }

    if let Err(e) = append_all(&state, &uuid, &body).await {
        tracing::error!(error = %e, uuid, "追加分片失败");
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "file_write_failed",
            "Cannot write file",
            "无法写入文件",
        );
    }

    // ⚠️ 每个分片都要更新登记的 size —— 否则 `/upload/finish` 报出去的大小是 0。
    file.size = new_size;
    if let Err(e) = state.store.put_file(&file) {
        tracing::error!(error = %e, uuid, "更新文件大小失败");
    }

    // Go 回一个空对象（不是 204）。
    json_response(&json!({}))
}

// ── POST /upload/finish/<uuid> ────────────────────────────────────────

pub async fn finish(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(uuid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(Some(file)) = state.store.get_file(&uuid) else {
        return write_error(
            StatusCode::BAD_REQUEST,
            "invalid_uuid",
            "Invalid UUID",
            "无效的 UUID",
        );
    };

    // ⚠️ 房间以**文件自己登记的**为准：分片初始化时定了房间，收尾时客户端传什么不算数。
    // Go 那边只在「传的是 default 且文件有房间」时才覆盖，效果等价于「文件优先」。
    let requested = normalize_room_name(query.get("room").map(String::as_str).unwrap_or(""));
    let room = if requested == "default" && !file.room.is_empty() {
        normalize_room_name(&file.room)
    } else {
        requested
    };

    if let Some(resp) = require_room_access(&state, &headers, &query, &room) {
        return resp;
    }

    finish_file_message(&state, &headers, peer, &query, file).await
}

/// 收尾：生成 FileReceive（含缩略图）→ 入库 → 广播 → 回 `{url, id, type}`。
///
/// 整份上传和分片上传的最后一步**是同一件事**，所以抽出来 —— Go 那边是抄了两遍的。
async fn finish_file_message(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    peer: SocketAddr,
    query: &HashMap<String, String>,
    file: File,
) -> Response {
    let room = normalize_room_name(&file.room);
    let (ip, device, client_id) = sender_base(headers, Some(peer), query);
    let url = format!(
        "{}://{}{}/file/{}",
        scheme_of(headers),
        host_of(headers),
        state.config.server.prefix,
        file.uuid
    );

    let mut receive = FileReceive {
        base: ReceiveBase {
            kind: "file".to_owned(),
            room: room.clone(),
            timestamp: now_secs(),
            sender_ip: ip,
            sender_device: Some(device),
            sender_client_id: client_id,
            ..ReceiveBase::default()
        },
        name: file.name.clone(),
        size: file.size,
        cache: file.uuid.clone(),
        expire: file.expire_time,
        thumbnail: String::new(),
        url,
    };

    // 缩略图：只有不太大、且能解码的文件才做。
    // ⚠️ 失败**不算错** —— 大部分文件（zip / pdf / 视频）本来就解不出来。
    if file.size as u64 <= THUMBNAIL_MAX_SOURCE
        && let Some(thumb) = make_thumbnail(&stored_path(state, &file.uuid)).await
    {
        receive.thumbnail = thumb;
    }

    let entry = ReceiveHolder::File(receive);
    let stored = match state.store.insert(entry) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!(error = %e, "写入文件消息失败");
            return write_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "store_failed",
                "Failed to store message",
                "保存消息失败",
            );
        }
    };

    state.broadcast("receive", &stored, &room);

    let id = stored.id();
    json_response(&json!({
        "url": content_url(headers, &state.config, id, &room),
        "id": id.to_string(),
        "type": determine_response_type(&file.name),
    }))
}

// ── GET / DELETE /file/<uuid>[/<name>] ────────────────────────────────

pub async fn file(
    State(state): State<Arc<AppState>>,
    ConnectInfo(_peer): ConnectInfo<SocketAddr>,
    Path(params): Path<HashMap<String, String>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    method: Method,
) -> Response {
    let uuid = params.get("uuid").cloned().unwrap_or_default();
    let room = file_room(&state, &uuid, &query);
    // ⚠️ **只有 GET 能用分享令牌**（`DELETE` 是写操作）。
    // 少这个区分的后果：一张只读令牌能删文件。
    let shared_uuid = (method == Method::GET).then_some(uuid.as_str());
    if let Some(resp) = require_file_read_access(&state, &headers, &query, &room, shared_uuid) {
        return resp;
    }

    let Ok(Some(info)) = state.store.get_file(&uuid) else {
        return write_error(
            StatusCode::NOT_FOUND,
            "file_not_found",
            "File not found or expired",
            "文件未找到或已过期",
        );
    };

    // ⚠️ 双重检查过期。后台清理任务（`file_cleanup`，每 5 分钟一轮）是异步的，
    // 中间有时间窗；这里兜住「后台还没跑到就被访问」的那一下。
    // `expire_time == 0` 是**永不过期**。
    if info.expire_time > 0 && info.expire_time < now_secs() {
        // ⚠️★ 顺序：先删字节、再删登记、最后收条目。
        // 条目也要在这里一起收掉（不能只等后台）—— 否则这 5 分钟里
        // 各端界面上还挂着一条点不开的卡片。广播 `revoke` 让它们立刻消失。
        let _ = remove_stored_file(&state, &uuid).await;
        let _ = state.store.remove_file(&uuid);
        if let Err(e) = crate::file_cleanup::drop_entries_for(&state, std::slice::from_ref(&uuid)) {
            tracing::warn!(error = %e, uuid = %uuid, "收过期文件的条目不成功（后台对账会再试）");
        }
        return write_error(
            StatusCode::NOT_FOUND,
            codes::FILE_EXPIRED,
            "File expired",
            "文件已过期",
        );
    }

    match method {
        Method::GET => serve_file(&state, &headers, &query, &info).await,
        Method::DELETE => {
            // ⚠️ 这一路**不能吞错误**：用户明确要求删，删不成必须回 500
            //（与 Go 的 `file_delete_failed` 一致），而且**不删登记** ——
            // 留着让用户能重试，比「登记没了、字节还在」好查得多。
            if let Err(e) = remove_stored_file(&state, &uuid).await {
                tracing::error!(error = %e, uuid = %uuid, "删除文件失败");
                return write_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "file_delete_failed",
                    "Failed to delete file",
                    "删除文件失败",
                );
            }
            let _ = state.store.remove_file(&uuid);
            // ⚠️ 显式 DELETE 也把引用它的条目收掉 —— 否则界面上会留一条点不开的卡片。
            // （客户端通常自己会先 revoke 条目再删文件，但**别依赖调用方**：
            //  API 是公开的，谁都能只删文件。）
            if let Err(e) =
                crate::file_cleanup::drop_entries_for(&state, std::slice::from_ref(&uuid))
            {
                tracing::warn!(error = %e, uuid = %uuid, "收已删文件的条目不成功（后台对账会再试）");
            }
            json_response(&json!({ "status": "文件删除成功" }))
        }
        _ => write_error(
            StatusCode::METHOD_NOT_ALLOWED,
            codes::METHOD_NOT_ALLOWED,
            "Method not allowed",
            "方法不允许",
        ),
    }
}

/// 把文件内容吐出去，**支持 Range**（视频拖动进度靠它）。
async fn serve_file(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    info: &File,
) -> Response {
    let path = stored_path(state, &info.uuid);

    // ⚠️ `ServeFile` 自己做 Range / If-Modified-Since / HEAD。为了复用它，这里手工拼一个
    // 最小请求，只把影响它的那几个头带过去 —— 它认的是**请求**，不是我们手上这些 extractor。
    let mut builder = Request::builder().method(Method::GET).uri("/");
    for name in [
        header::RANGE,
        header::IF_MODIFIED_SINCE,
        header::IF_NONE_MATCH,
    ] {
        if let Some(v) = headers.get(&name) {
            builder = builder.header(name, v);
        }
    }
    let Ok(req) = builder.body(Body::empty()) else {
        return write_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "file_stat_failed",
            "Cannot read file info",
            "无法读取文件状态",
        );
    };

    let mut resp = match tower_http::services::ServeFile::new(&path)
        .oneshot(req)
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return write_error(
                StatusCode::NOT_FOUND,
                "file_missing_on_disk",
                "File missing on disk",
                "文件在磁盘上未找到",
            );
        }
    };

    // ⚠️ 磁盘上的名字是**没有扩展名的 uuid**，所以 ServeFile 猜不出 MIME。
    // 按**原始文件名**重设一次，否则图片/视频在浏览器里会被当成 octet-stream 下载。
    if let Some(mime) = mime_guess::from_path(&info.name).first_raw() {
        // ⚠️ Go 的 `mime.TypeByExtension` 给 **text/\*** 都带上 `; charset=utf-8`（内置表里写死的）。
        // 少了 charset，浏览器会把中文 `.txt` 当 Latin-1 渲染成乱码 —— 这是**用户看得见**的差别，
        // 不是「多几个字节」。`application/json` 那类不带 charset，和 Go 一致。
        let mime = if mime.starts_with("text/") && !mime.contains("charset") {
            format!("{mime}; charset=utf-8")
        } else {
            mime.to_owned()
        };
        if let Ok(v) = mime.parse() {
            resp.headers_mut().insert(header::CONTENT_TYPE, v);
        }
    }

    // `?download=true` → 附件；否则内联（浏览器里直接看）。
    let disposition = if query.get("download").map(String::as_str) == Some("true") {
        "attachment"
    } else {
        "inline"
    };
    // ⚠️ 文件名里的 `"` 要去掉：它会把 Content-Disposition 的头**提前截断**，
    // 于是后面的字节被当成新头 —— 那是一个响应头注入。
    let encoded = format!("{disposition}; filename=\"{}\"", info.name.replace('"', ""));
    if let Ok(v) = encoded.parse() {
        resp.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }

    // ⚠️ `ServeFile` 的响应体是它自己的类型，要 `map(Body::new)` 换成 axum 的 `Body`
    // 才能当 `Response` 返回。头已经改完了，`map` 只动 body。
    resp.map(Body::new)
}

// ── 工具 ──────────────────────────────────────────────────────────────

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

fn scheme_of(headers: &HeaderMap) -> &'static str {
    match headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        Some(v) if v.eq_ignore_ascii_case("https") => "https",
        _ => "http",
    }
}

fn host_of(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned()
}

/// 从 multipart body 里取 `file` 字段（文件名 + 字节）。
async fn read_multipart_file(body: Bytes, boundary: String) -> Option<(String, Bytes)> {
    let stream = futures_util::stream::once(async move { Ok::<Bytes, std::io::Error>(body) });
    let mut multipart = multer::Multipart::new(stream, boundary);
    while let Some(field) = multipart.next_field().await.ok()? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("file").to_owned();
        let data = field.bytes().await.ok()?;
        return Some((filename, data));
    }
    None
}

async fn write_all(state: &AppState, uuid: &str, data: &[u8]) -> std::io::Result<()> {
    tokio::fs::write(stored_path(state, uuid), data).await
}

async fn append_all(state: &AppState, uuid: &str, data: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut f = tokio::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(stored_path(state, uuid))
        .await?;
    f.write_all(data).await?;
    f.flush().await
}

/// 生成缩略图：解码 → 缩到短边 64 → JPEG q70 → `data:image/jpeg;base64,…`。
///
/// ⚠️ 对应 Go `utils.go:94`。**失败是正常的**（zip / pdf / 视频都解不出来），
/// 调用方不该把失败当成错误 —— 只是这条消息没有缩略图而已。
async fn make_thumbnail(path: &FsPath) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;

    // ⚠️ 解码是 CPU 密集的，放到阻塞线程池 —— 直接在 async 上下文里做会把整个 runtime 卡住。
    tokio::task::spawn_blocking(move || -> Option<String> {
        use base64::Engine as _;
        use image::imageops::FilterType;

        let img = image::load_from_memory(&bytes).ok()?;
        let (w, h) = (img.width(), img.height());
        let min_side = w.min(h);
        let (tw, th) = if min_side > THUMBNAIL_MIN_SIDE {
            let ratio = f64::from(THUMBNAIL_MIN_SIDE) / f64::from(min_side);
            (
                ((f64::from(w) * ratio) as u32).max(1),
                ((f64::from(h) * ratio) as u32).max(1),
            )
        } else {
            (w.max(1), h.max(1))
        };

        // CatmullRom 和 Go 那边用的是同一个滤波（缩小图时质量明显好于最近邻）。
        let thumb = img.resize_exact(tw, th, FilterType::CatmullRom);

        let mut out = Vec::new();
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, THUMBNAIL_JPEG_QUALITY);
        encoder.encode_image(&thumb).ok()?;

        Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&out)
        ))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_path_uses_the_uuid_verbatim() {
        // ⚠️ 磁盘上的名字必须是**原样**的 uuid：用户给的文件名可能含 `/` 或 `..`，
        // 拼进路径就是一次目录穿越。
        assert_eq!(
            stored_path_for("/data/uploads", "abc-123"),
            "/data/uploads/abc-123"
        );
        assert_eq!(
            stored_path_for("/data/uploads", "../../etc/passwd"),
            "/data/uploads/../../etc/passwd"
        );
    }

    fn stored_path_for(dir: &str, uuid: &str) -> String {
        FsPath::new(dir).join(uuid).to_string_lossy().into_owned()
    }
}
