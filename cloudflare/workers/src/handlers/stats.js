/**
 * 房间活跃度（热力图的数据源）—— `/stats/daily`。
 *
 * ⚠️★ 这是**服务端那条 `/stats/daily` 的 CF 版本**（2026-10-07 补）。
 * 在那之前只有自建服务端有它，于是「网页版能看热力图、CF 上的房间点开是空的」
 * —— 而界面只会说一句「读取活跃度失败」，看起来像前端坏了。
 *
 * ⚠️★★ **这里的算法与 `clip9-core::stats` 是两份实现**（Rust 一份、JS 一份）。
 * 这是 workers 那份实现**固有**的代价（content / share / auth 也都是两份），
 * 但它意味着**改一边就要改另一边**：分位、连续天数、时区回落这三条
 * 任何一条漂了，两边的图就会长得不一样，而且**不会报错**。
 * 规则本身（为什么用分位、为什么时区要客户端给）见 `clip9-core/src/stats.rs` 的模块文档。
 */
import { canAccessRoomAsync, extractAuthTokens, normalizeRoomName } from '../auth';
import { errorResponse } from '../errors';

/** 53 周 × 7 天 —— 与 GitHub 那张图同构（也是自建服务端的默认值）。 */
export const DAYS_DEFAULT = 371;
export const DAYS_MAX = 371;
/** 一次最多读多少条时间戳（防呆）。 */
export const SCAN_LIMIT = 50000;

/** `days` 的取值规则。⚠️ 0 / 负数 / 非数 = 「没给」，不是「空图」。 */
export function normalizeDays(raw) {
    const n = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) {
        return DAYS_DEFAULT;
    }
    return Math.min(n, DAYS_MAX);
}

/**
 * 把时间戳按**给定时区**的本地日分桶。
 *
 * ⚠️★ 时区由**客户端**给：服务端不知道看图的人在哪个时区，而「今天」是按**他的**本地日算的。
 * 用 UTC 分桶的话，东八区晚上 8 点之后的活跃会被算进第二天。
 * ⚠️ 认不出来的名字**回落 UTC**（`Intl` 会抛），并把实际用的那个回给客户端。
 */
export function resolveTimeZone(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
        return 'UTC';
    }
    try {
        // `Intl` 对不认识的时区名会抛 —— 拿它当校验，比自己维护一张表可靠。
        new Intl.DateTimeFormat('en-CA', { timeZone: trimmed });
        return trimmed;
    } catch {
        return 'UTC';
    }
}

/** 某个时刻在给定时区里是哪一天（`YYYY-MM-DD`）。 */
export function dayKey(timeZone, seconds) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(seconds * 1000));
}

/** `YYYY-MM-DD` 往前推 `n` 天（只用日历算，不碰时区）。 */
function shiftDay(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) - n * 86400000;
    const dt = new Date(t);
    const pad = (x) => String(x).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 那一组时间戳 → 窗口内每天的计数（**旧的在前面**，长度恰好 `days`）。 */
export function bucket(timestamps, lastDay, days, timeZone) {
    const counts = new Array(days).fill(0);
    if (days <= 0) {
        return counts;
    }
    const firstDay = shiftDay(lastDay, days - 1);
    const index = new Map();
    for (let i = 0; i < days; i += 1) {
        index.set(shiftDay(firstDay, -i), i);
    }
    for (const ts of timestamps) {
        const at = index.get(dayKey(timeZone, Number(ts)));
        if (at !== undefined) {
            counts[at] += 1;
        }
    }
    return counts;
}

/**
 * 四道**分位**阈值（只用非零天）。
 *
 * ⚠️★ 用分位而不是固定阈值：一个每天 3 条的房间，固定阈值会让整张图都是最浅色 ——
 * 而「哪几天多」正是他来看这张图的原因。代价是不同房间同色不同量，所以图例要写实际区间。
 * ⚠️ 非零天少于 4 天时**退化**（阈值全取最大值）。
 */
export function levelsOf(counts) {
    const nonzero = counts.filter((c) => c > 0).sort((a, b) => a - b);
    if (nonzero.length < 4) {
        const top = nonzero.length ? nonzero[nonzero.length - 1] : 0;
        return [top, top, top, top];
    }
    const at = (q) => {
        const i = Math.ceil(q * nonzero.length) - 1;
        return nonzero[Math.min(Math.max(i, 0), nonzero.length - 1)];
    };
    const out = [at(0.25), at(0.5), at(0.75), at(1)];
    // ⚠️ 阈值必须单调不减，否则分级会把「多的一天」画成浅色。
    for (let i = 1; i < 4; i += 1) {
        out[i] = Math.max(out[i], out[i - 1]);
    }
    return out;
}

/**
 * 连续天数。
 *
 * ⚠️★ 末尾（今天）是 0 时**先跳过它**再往回数 —— 不这么做的话，
 * 每天早上一打开图，「连续 N 天」会先变成 0，而用户什么都没做错。
 */
export function streakOf(counts) {
    let longest = 0;
    let run = 0;
    for (const c of counts) {
        if (c > 0) {
            run += 1;
            longest = Math.max(longest, run);
        } else {
            run = 0;
        }
    }
    let i = counts.length;
    if (i > 0 && counts[i - 1] === 0) {
        i -= 1;
    }
    let current = 0;
    while (i > 0 && counts[i - 1] > 0) {
        current += 1;
        i -= 1;
    }
    return { current, longest };
}

/** 计数 → 完整的响应体。 */
export function summarize(counts, lastDay) {
    const days = counts.map((count, i) => ({ date: shiftDay(lastDay, counts.length - 1 - i), count }));
    const total = counts.reduce((a, b) => a + b, 0);
    let busiest = null;
    for (const day of days) {
        // ⚠️ 并列取**最近**那天（`>=` 让后面的覆盖前面的）。
        if (day.count > 0 && (!busiest || day.count >= busiest.count)) {
            busiest = day;
        }
    }
    return { days, total, busiest, streak: streakOf(counts), levels: levelsOf(counts) };
}

/**
 * `GET /stats/daily?room=&days=&tz=`
 *
 * ⚠️ 鉴权与 `/content` 同一套（`canAccessRoomAsync`）。⚠️ **受保护的房间仍然要凭据**：
 * 「这个房间有多活跃」本身就是一个可探测的信号。
 */
export async function daily(request, env) {
    const url = new URL(request.url);
    const room = normalizeRoomName(url.searchParams.get('room') || '');
    const tokens = extractAuthTokens(request);
    const allowed = await Promise.all(tokens.map((t) => canAccessRoomAsync(env, room, t)));
    if (tokens.length > 0 && !allowed.some(Boolean)) {
        return errorResponse(403, 'room_forbidden', 'Room forbidden', '无权访问该房间');
    }

    const days = normalizeDays(url.searchParams.get('days'));
    const requestedTz = String(url.searchParams.get('tz') || '');
    const tz = resolveTimeZone(requestedTz);
    const now = Math.floor(Date.now() / 1000);
    const lastDay = dayKey(tz, now);
    const since = Math.floor(new Date(`${shiftDay(lastDay, days - 1)}T00:00:00Z`).getTime() / 1000);

    if (!env.DB) {
        return errorResponse(500, 'store_unavailable', 'Store unavailable', '存储不可用');
    }

    // ⚠️★ **过期文件不算活跃** —— 与自建服务端对齐：那边文件一过期就把时间线条目删掉，
    // 所以这里也要把「已过期的文件」排除掉，否则同一个房间在两边的图不一样。
    let rows;
    try {
        const result = await env.DB.prepare(
            `SELECT timestamp FROM messages
             WHERE room = ? AND timestamp >= ?
               AND (type != 'file' OR expireTime IS NULL OR expireTime = 0 OR expireTime > ?)
             ORDER BY timestamp DESC LIMIT ?`
        )
            .bind(room, since, now, SCAN_LIMIT)
            .all();
        rows = result.results || [];
    } catch (error) {
        console.error('stats/daily 查询失败:', error);
        return errorResponse(500, 'store_failed', 'Failed to read activity', '读取活跃度失败');
    }

    const counts = bucket(
        rows.map((r) => r.timestamp),
        lastDay,
        days,
        tz
    );
    return Response.json({
        room,
        tz,
        requestedTz,
        truncated: rows.length >= SCAN_LIMIT,
        activity: summarize(counts, lastDay),
    });
}
