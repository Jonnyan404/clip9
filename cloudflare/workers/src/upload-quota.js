/**
 * 「这台实例一共能存多少文件字节」—— 公共演示站用它把 R2 用量钉在免费额度以内。
 *
 * ⚠️★ 为什么需要它：`FILE_LIMIT` 管的是**一个**文件，管不住**总量**。
 * 公开站谁都能传，3 MB × 反复传可以把 R2 的 10 GB-month 免费额度填满 ——
 * 而填满之后**不是报错，是开始计费**。所以再加一条「总量」的闸。
 *
 * 语义：只算**未过期**的文件（`expireTime = 0` 是「永不过期」，算在内）。
 * 于是它和「文件 1 小时过期 + 每 5 分钟清理」配套之后是**自愈**的：
 * 顶满了不用人工干预，等过期就行。
 *
 * ⚠️ 边角：**没有消息行的字节不算** —— 分片上传在 `finish` 之前，字节已经在 R2 里、
 * 但 `messages` 里还没有那一行。所以这里还有第二道闸（`checkInflightBudget`）：
 * 限制同时存在的上传会话数，把「写了一半就没人管」的那部分也框住。
 *
 * `FILE_TOTAL_LIMIT` 不设 / <= 0 = **不限制**（既有部署的行为一个字不变）。
 */
import { errorResponse } from './errors';

/** 同时允许几个「还没收尾」的上传会话。每个最多 `FILE_LIMIT` 字节。 */
const MAX_INFLIGHT_UPLOADS = 20;

export function getTotalLimit(env) {
    const raw = env.FILE_TOTAL_LIMIT;
    if (!raw) return 0;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatBytes(bytes) {
    const mb = Number(bytes || 0) / 1024 / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** 当前占用：未过期（或永不过期）的文件消息之和。 */
export async function queryUsedBytes(env, nowSeconds = Math.floor(Date.now() / 1000)) {
    const row = await env.DB.prepare(
        "SELECT COALESCE(SUM(size), 0) AS used FROM messages " +
        "WHERE type = 'file' AND (expireTime IS NULL OR expireTime = 0 OR expireTime > ?)",
    ).bind(nowSeconds).first();
    return Number(row?.used || 0);
}

/**
 * 放不下就返回一个 507；放得下返回 `null`。
 *
 * @param {number} incomingBytes 这次要写进去的字节（不含已经在库里的）
 */
export async function checkUploadBudget(env, incomingBytes, { nowSeconds } = {}) {
    const limit = getTotalLimit(env);
    if (!limit) return null;
    const used = await queryUsedBytes(env, nowSeconds);
    const incoming = Number(incomingBytes) || 0;
    if (used + incoming <= limit) return null;
    return errorResponse(
        507,
        'storage_quota_exceeded',
        'Storage quota exceeded',
        `文件空间已满（已占用 ${formatBytes(used)}，上限 ${formatBytes(limit)}）。` +
        '旧文件过期或删除后会自动释放，请稍后再试。',
    );
}

/**
 * 同时在跑的「没写完」的上传会话数上限。
 *
 * ⚠️ 只在配了总量上限的实例上生效（公开站）；自建实例不受影响。
 * ⚠️ 会话元数据在 R2 的 `uploads/` 前缀下（见 `handlers/file.js` 的 `createUploadMetaKey`），
 *    这里用一次 `list` 数它 —— 一次 Class A 操作，比让攻击者无限开会话便宜得多。
 */
export async function checkInflightBudget(env) {
    if (!getTotalLimit(env)) return null;
    if (!env.R2_BUCKET?.list) return null;
    const listed = await env.R2_BUCKET.list({ prefix: 'uploads/', limit: MAX_INFLIGHT_UPLOADS + 1 });
    const count = (listed?.objects || []).length;
    if (count < MAX_INFLIGHT_UPLOADS) return null;
    return errorResponse(
        429,
        'too_many_uploads',
        'Too many uploads in flight',
        `同时进行的上传太多了（上限 ${MAX_INFLIGHT_UPLOADS} 个），稍等几十秒再试。`,
    );
}
