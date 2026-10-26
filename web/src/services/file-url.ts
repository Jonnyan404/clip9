/**
 * 文件字节的**直连地址** —— 全站唯一一份。
 *
 * ⚠️★ 为什么需要这个文件（2026-10-26）：在这之前，凡是「把一张图 / 一段视频塞进
 * `<img src>` / `<video src>`」的地方，都是先去 `POST /share` 要一条分享令牌、再拿
 * 回来的 `rawUrl` 当预览地址。那是**拿分享换显示**，代价有三条，而且一条都不会报错：
 *
 *   1. **污染分享记录**。`GET /share/list` 列的是「这个房间最近的分享」，用户每看一眼图
 *      就多一条。翻 40 张图 = 40 条记录，打开分享历史会看到一片自己没分享过的条目。
 *   2. **每条预览都要一次往返**。列表里 20 张缩略图展开就是 20 次 `POST /share`，
 *      而它签出来的东西和「直接读这个文件」在权限上是同一件事（服务端
 *      `require_file_read_access` 本来就认房间凭据）。
 *   3. **令牌有 TTL**。分享令牌会过期，预览地址就跟着失效；而文件本身的寿命与房间一致。
 *
 * 正确的地址一直是存在的：`GET /file/<uuid>`，房间凭据走 `?auth=`（`auth_gate.rs` 的
 * `extract_auth_token` 就认 query，WebSocket 那条路一直是这么传的）。所以这里只做一件事：
 * **把那个地址拼对**。
 *
 * ⚠️★ 必须绝对化到 `API_BASE_URL`（**后端**），不能写相对地址：`<img src>` / `<video src>` /
 * `<a download>` 是**浏览器自己**发的请求，不经过 axios 的 `baseURL`。前后端分离部署时
 * 相对地址会按**页面**目录解析到静态托管那边，症状是「图挂了 / 视频转圈 / 下载 404」，
 * 而页面本身一切正常 —— 同一条坑 `pages/SharePage.tsx` 已经踩过一次（见
 * `scripts/check-contracts.mjs` 判据 I）。
 *
 * ⚠️ 地址里**不带文件名**：服务端 `serve_file` 的 MIME 与 `Content-Disposition` 都取自
 * 登记时的 `info.name`（`files.rs`），路径上的 name 只是给人看的。少拼一段就少一处
 * 「文件名里有 `/` 或 `#` 导致 404」的机会。
 *
 * ⚠️ 令牌进 query 这件事**是有意的取舍**：`<img>` 没法带 `Authorization` 头，而用
 * `fetch` + blob 会丢掉 Range（视频拖进度条要靠它）、把整段视频读进内存、也拿不到
 * 浏览器缓存。代价是令牌会出现在服务端访问日志里 —— 与 WebSocket 那条路一致，
 * 别在日志里回显完整 URL。
 */
import { API_BASE_URL } from '@/lib/base';
import { useWebSocketStore } from '@/stores/wsStore';

export interface FileUrlOptions {
    /** 房间名。默认取当前房间。 */
    room?: string;
    /** `true` = `Content-Disposition: attachment`（下载而不是内联预览）。 */
    download?: boolean;
}

/**
 * 拼一条文件字节的直连地址。`cache` 为空（条目没有文件、或还没登记）时返回空串 ——
 * 调用方据此**不渲染** `src`，而不是塞一个必然 404 的地址进去。
 */
export function fileUrl(cache: string | undefined | null, options: FileUrlOptions = {}): string {
    const uuid = String(cache || '').trim();
    if (!uuid) {
        return '';
    }
    const ws = useWebSocketStore.getState();
    // ⚠️ 必须过 `normalizeRoomName`：空串在**整个应用里**都表示「默认房间」，只有这里
    // 直接拼 query 的话，地址上就少了 `?room=`（服务端会退回「文件自己登记的room」，
    // 所以能跑 —— 但「看起来对、其实少了一个参数」正是这个仓库最怕的那种状态）。
    const room = ws.normalizeRoomName(options.room ?? ws.room ?? '');

    // ⚠️ 用 `new URL` 而不是字符串拼接：`API_BASE_URL` 可能带子路径前缀（`-prefix` / 静态托管
    // 子目录），手拼斜杠会在「有没有结尾斜杠」上出错，而那种错只会表现成 404。
    const url = new URL(`file/${encodeURIComponent(uuid)}`, API_BASE_URL);
    if (room) {
        url.searchParams.set('room', room);
    }
    // 房间不要密码时这里就是空串 —— 那种房间的地址**本来就不该带凭据**。
    const token = ws.getAuthTokenForRoom(room);
    if (token) {
        url.searchParams.set('auth', token);
    }
    if (options.download) {
        url.searchParams.set('download', 'true');
    }
    return url.href;
}

/**
 * 触发一次「下载到本地」。
 *
 * ⚠️ 仍然用 `<a download>`（而不是 `location.href = …`）：后者在 SPA 里会把**当前页面**
 * 换成一个下载响应，用户回到列表时状态全丢。`download` 属性只是给浏览器一个提示，
 * 真正的文件名来自服务端的 `Content-Disposition`（`?download=true` 那一支）。
 */
export function downloadFile(cache: string | undefined | null, name: string | undefined | null, room?: string): boolean {
    const href = fileUrl(cache, { room, download: true });
    if (!href) {
        return false;
    }
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = String(name || 'file');
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    return true;
}
