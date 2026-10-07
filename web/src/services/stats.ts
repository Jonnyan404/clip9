/**
 * 房间活跃度（热力图的数据源）。
 *
 * ⚠️★ `tz` **必须由我们给**：服务端不知道看图的人在哪个时区，而「今天」是按
 * **他的**本地日算的。用 UTC 分桶的话，东八区晚上 8 点之后的活跃会被算进第二天 ——
 * 而这张图正是用来看「哪几天多」的。
 * ⚠️ 取的是 IANA 名字（`Asia/Shanghai`）而不是固定偏移：夏令时切换那天固定偏移会错一小时。
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` 给的就是这个名字。
 */
import axios from 'axios';

export interface DayCount {
    date: string;
    count: number;
}

export interface Streak {
    current: number;
    longest: number;
}

export interface DailyActivity {
    /** 每天一条，**旧的在前面**，长度恰好等于请求的天数（没有的那天是 0）。 */
    days: DayCount[];
    total: number;
    busiest: DayCount | null;
    streak: Streak;
    /** 四道**分位**阈值，把计数分成 5 档（含 0 那一档）。 */
    levels: [number, number, number, number];
}

export interface DailyActivityResponse {
    room: string;
    /** **实际用的**时区（认不出来的名字会回落成 UTC）。 */
    tz: string;
    requestedTz: string;
    /** 撞到服务端的扫描上限了吗（撞了的话图上的数字比实际少）。 */
    truncated: boolean;
    activity: DailyActivity;
}

/** 53 周 × 7 天 —— 与 GitHub 那张图同构（也是服务端的默认值）。 */
export const HEATMAP_DAYS = 371;

/** 本机时区名（拿不到就空串，服务端会回落 UTC）。 */
export function localTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

/**
 * ⚠️★ 这个服务端**根本没有这个接口**时抛的。
 *
 * 2026-10-07 加：用户报「热力图未生效」，而真机验下来前端与接口都是好的 ——
 * 真正的情形是**那个房间背后的服务端是旧版 / 是 CF workers 那份**（后者一直没有
 * `/stats/daily`）。原来那种情况只会显示一句笼统的「读取活跃度失败」，
 * 看起来像前端坏了；而它其实是**要更新后端**。
 */
export class ActivityUnsupported extends Error {
    constructor() {
        super('activity endpoint missing');
        this.name = 'ActivityUnsupported';
    }
}

/**
 * ⚠️★ 回来的**不是活跃度数据**时抛的（2026-10-07 加）。
 *
 * 最典型的来路是 **dev 下 vite 的 SPA 兜底**：请求没被代理转发（`vite.config.ts` 的
 * `server.proxy` 里少了 `/stats`），于是它用 **200 + 一份 `index.html`** 接住 ——
 * axios 一点不报错，而对话框拿到的 `data.activity` 是 `undefined`，画出来就是**一片空白**。
 * 用户报的「热力图不出图」正是这个：没出错、也没图、更没有任何提示。
 * ⚠️ 打包版没有这条路（相对路径直接打到服务端）—— 所以「真机验下来都是好的」验的是另一边。
 */
export class ActivityBadResponse extends Error {
    constructor() {
        super('activity response is not activity data');
        this.name = 'ActivityBadResponse';
    }
}

export async function fetchDailyActivity(params: {
    room: string;
    days?: number;
    tz?: string;
}): Promise<DailyActivityResponse> {
    try {
        const { data } = await axios.get('stats/daily', {
            params: {
                room: params.room,
                days: params.days ?? HEATMAP_DAYS,
                tz: params.tz ?? localTimeZone(),
            },
        });
        // ⚠️★ 形状不对就**说出来**（见 `ActivityBadResponse` 的注释）：把「不是数据」的东西
        // 当数据用，结果是对话框画成一片空白 —— 而那既不是加载中、也不是错误，用户没得猜。
        if (!data || !data.activity || !Array.isArray(data.activity.days)) {
            throw new ActivityBadResponse();
        }
        return data as DailyActivityResponse;
    } catch (error) {
        // ⚠️ 404 / 501 = 这个后端还没有这个接口 —— 与「网络断了」「凭据不对」是**两回事**，
        // 要分开说（前者要去更新服务端，后者要去看设置）。
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 404 || status === 501) {
            throw new ActivityUnsupported();
        }
        throw error;
    }
}

/** 这个计数属于第几档（0 = 空，1–4 = 由浅到深）。 */
export function levelOf(count: number, levels: [number, number, number, number]): number {
    if (count <= 0) {
        return 0;
    }
    if (count <= levels[0]) {
        return 1;
    }
    if (count <= levels[1]) {
        return 2;
    }
    if (count <= levels[2]) {
        return 3;
    }
    return 4;
}

/** 图例上每一档的实际区间（⚠️ 分档是**相对这个房间**的，所以必须写出来）。 */
export function legendLabels(levels: [number, number, number, number]): string[] {
    const [a, b, c, d] = levels;
    // ⚠️ 非零天少于 4 天时四道阈值会**相等**（见服务端 `levels_of`）——
    // 那时只有「有 / 没有」两档，图例也只该给两段，而不是编出四个假的区间。
    if (a === d) {
        return [`1–${d}`, `${d}+`];
    }
    const ranges: string[] = [];
    const push = (from: number, to: number) => ranges.push(from === to ? `${from}` : `${from}–${to}`);
    push(1, a);
    push(a + 1, b);
    push(b + 1, c);
    // 最后一档是「c 以上」，因为 `levels[3]` 是最大值（P100）——
    // 写成 `c+1–d` 会让「正好等于最大值」的那天没有归属。
    ranges.push(`${c + 1}+`);
    return ranges;
}
