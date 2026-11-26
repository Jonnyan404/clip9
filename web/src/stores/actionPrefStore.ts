import { create } from 'zustand';

/**
 * 使用次数记录 —— 「哪个动作你常用」这一件事的全部状态。
 *
 * ⚠️ 只记**次数 + 最后一次用的时间**，不记顺序、不记模式：
 *    2026-11-26 之前这里还有「默认 / 常用 / 自定义」三档排序和一份手排顺序，
 *    用户要求去掉（动作库里多一排开关，每次打开都要先做个决定）。
 *    现在直接按使用频率排 —— `count` 相同就比 `lastUsedAt`，这样一堆「用过一次」的动作
 *    不会按 catalog 顺序排回来（那等于没排）。
 *
 * ⚠️★ 落 `localStorage`、不进配置文件、不上云：「我常用哪个动作」是**设备级**偏好，
 *    和「我的房间」不是一类东西 —— 换台机器不该被同步过去。
 * ⚠️ 读盘一律 try/catch：无痕模式 / 存储被禁时 `localStorage` 直接抛错，
 *    而排序失败**不该让整个面板打不开**（退化成默认顺序就好）。
 */

/** 一条动作的使用记录。`count` 是次数，`lastUsedAt` 是**最后一次**用的时间戳。 */
export interface ActionUsageEntry {
    count: number;
    lastUsedAt: number;
}

const USAGE_KEY = 'actionUsage';

function readUsage(): Record<string, ActionUsageEntry> {
    try {
        const raw = localStorage.getItem(USAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw) as unknown;
        // ⚠️ 逐条校验：这串东西是用户能在 devtools 里手改的，
        //    一个 `count: "abc"` 进来会让排序函数返回 NaN、面板顺序每次刷新都不一样。
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        const out: Record<string, ActionUsageEntry> = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            const entry = value as Partial<ActionUsageEntry> | null;
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const count = Number(entry.count);
            const lastUsedAt = Number(entry.lastUsedAt);
            if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt) || count <= 0) {
                continue;
            }
            out[id] = { count, lastUsedAt };
        }
        return out;
    } catch {
        return {};
    }
}

function write(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // 存不进去不影响当前会话 —— store 里的状态已经更新了
    }
}

interface ActionPrefState {
    /** 动作 id → 使用记录。动作库和卡片动作共用这一张表（key 不重叠）。 */
    usage: Record<string, ActionUsageEntry>;
    /** 记一次使用。 */
    recordUse: (id: string) => void;
    /** 清空使用记录（设置里那个「重置」用）。 */
    resetUsage: () => void;
}

export const useActionPrefStore = create<ActionPrefState>((set, get) => ({
    usage: readUsage(),

    recordUse: (id) => {
        if (!id) {
            return;
        }
        const now = Date.now();
        const prev = get().usage[id];
        const usage = {
            ...get().usage,
            [id]: { count: (prev?.count ?? 0) + 1, lastUsedAt: now },
        };
        set({ usage });
        write(USAGE_KEY, usage);
    },

    resetUsage: () => {
        set({ usage: {} });
        write(USAGE_KEY, {});
    },
}));

const ZERO: ActionUsageEntry = { count: 0, lastUsedAt: 0 };

/**
 * 按使用频率排序。**纯函数**（不改入参），方便单独验。
 *
 * @param applicable 可选：判定「这条当前能不能用」。
 *                   ⚠️ 适用性**优先于**频次：一个用得多、但当前不适用的动作排在最前面，
 *                   用户点开面板第一眼看到的是一排灰的。
 */
export function sortActions<T extends { id: string }>(
    actions: T[],
    usage: Record<string, ActionUsageEntry>,
    applicable?: (action: T) => boolean,
): T[] {
    const list = [...actions];
    return list.sort((a, b) => {
        if (applicable) {
            const diff = Number(applicable(b)) - Number(applicable(a));
            if (diff !== 0) {
                return diff;
            }
        }
        const sa = usage[a.id] ?? ZERO;
        const sb = usage[b.id] ?? ZERO;
        if (sb.count !== sa.count) {
            return sb.count - sa.count;
        }
        // 次数相同 → 最近用过的靠前
        return sb.lastUsedAt - sa.lastUsedAt;
    });
}
