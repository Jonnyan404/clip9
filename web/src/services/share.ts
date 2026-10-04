/**
 * 分享与条目更新相关的 HTTP 调用 —— 从 web-vue3/src/util.js 里带 axios 的那几段移植。
 */
import axios from 'axios';
import { normalizeShareTTL, normalizeShareMaxUses } from '@/lib/share-config.js';

export interface CreateShareLinkOptions {
    type: string;
    id?: string | number;
    uuid?: string;
    ttl?: number;
    maxUses?: number;
    password?: string;
    room?: string;
}

/**
 * 向服务端申请分享链接。
 *
 * 服务端**一律**签发 token（开放房间也发），返回的 url 就是分享地址
 * `https://host<prefix>/s/<token>` —— token 在**路径**里，服务端读得到，社交平台抓到的是
 * 一份注入了 OG 卡片的 HTML。房间是否需要鉴权不影响这里。
 */
export async function createShareLink({ type, id, uuid, ttl, maxUses, password, room }: CreateShareLinkOptions) {
    const params = new URLSearchParams();
    if (room) {
        params.set('room', room);
    }

    const body: Record<string, unknown> = { type };
    if (id !== undefined && id !== null && id !== '') {
        body.id = String(id);
    }
    if (uuid) {
        body.uuid = uuid;
    }
    if (ttl !== undefined && ttl !== null && (ttl as unknown) !== '') {
        body.ttl = normalizeShareTTL(ttl);
    }
    if (maxUses !== undefined && maxUses !== null && (maxUses as unknown) !== '') {
        const uses = normalizeShareMaxUses(maxUses);
        if (uses > 0) {
            body.maxUses = uses;
        }
    }
    // 密码只进请求体，不进 URL（服务端把它 HMAC 进 token，URL 里连哈希都看不到）
    const pwd = String(password || '').trim();
    if (pwd) {
        body.password = pwd;
    }

    const response = await axios.post('share', body, { params });
    return response.data;
}

/**
 * 上报「分享页被真人打开了」一次。
 *
 * 相对路径（无前导斜杠）—— 与 createShareLink 同一约定，部署在子路径下不需要配置。
 * 上报失败一律静默：它是统计，不是功能。
 */
export async function reportShareVisit(token: string, { qr = false }: { qr?: boolean } = {}) {
    const value = String(token || '').trim();
    if (!value) {
        return null;
    }
    try {
        const response = await axios.post('share/visit', { token: value, qr: Boolean(qr) }, { __skipRoomAuthHandling: true });
        return response.data || null;
    } catch {
        return null;
    }
}

/**
 * 读某个房间的分享记录（最近分享过什么、被打开了几次）。
 * 鉴权和「在该房间签发分享」完全一致：房间设了密码就必须带该房间的凭据。
 */
export async function fetchShareRecords({ room = '', limit = 0 }: { room?: string; limit?: number } = {}) {
    const params: Record<string, string | number> = {};
    if (room) {
        params.room = room;
    }
    if (limit > 0) {
        params.limit = limit;
    }
    const response = await axios.get('share/list', { params });
    return response.data || {};
}

/**
 * 把一条内容挪到看板的某一列（`POST /content/<id>/column`）。
 * **固定三列**（todo / doing / done）、卡片就是剪贴板条目本身，而且**不动 timestamp**。
 */
export async function updateEntryColumn(id: string, room: string | undefined, column: string) {
    const response = await axios.post(
        `content/${encodeURIComponent(id)}/column`,
        { column },
        { params: new URLSearchParams([['room', room ?? '']]) },
    );
    return response.data;
}

/**
 * 覆盖一条**已有**文本条目的正文（`POST /text?id=<id>`）。
 * 落盘、广播 `update` 事件、id 不变。任务列表打勾是第一个用它的地方。
 */
export async function updateTextEntry(id: string, room: string, content: string) {
    await axios.post('text', String(content ?? ''), {
        params: new URLSearchParams([['room', room ?? ''], ['id', String(id)]]),
        headers: { 'Content-Type': 'text/plain' },
    });
}
