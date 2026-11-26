import { create } from 'zustand';

/**
 * 动作面板的**排序偏好**：用过的次数、自定义顺序、当前排序方式。
 *
 * 为什么单独一个 store 而不是塞进 `appStore`：这三样只在动作面板里用，
 * 而 `appStore` 已经是整个应用最热的那份状态（每次输入都它变）。放一起等于
 * 每敲一个字都让面板重算一遍排序。
 *
 * ⚠️★ 全部落 `localStorage`，**不进配置文件、也不上云**：「我常用哪个动作」是设备级偏好，
 *    和「我的房间」不是一类东西 —— 换台机器不该被同步过去。
 * ⚠️ 读盘一律 try/catch：无痕模式 / 存储被禁时 `localStorage` 直接抛错，
 *    而排序失败**不该让整个面板打不开**（退化成默认顺序就好）。
 */

export type ActionSortMode = 'default' | 'frequent' | 'custom';

/** 一条动作的使用记录。`count` 是次数，`lastUsedAt` 是**最后一次**用的时间戳。 */
export interface ActionUsageEntry {
    count: number;
    lastUsedAt: number;
}

const USAGE_KEY = 'actionUsage';
const ORDER_KEY = 'actionOrder';
const MODE_KEY = 'actionSortMode';

const SORT_MODES: ActionSortMode[] = ['default', 'frequent', 'custom'];

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

function readOrder(): string[] {
    try {
        const raw = localStorage.getItem(ORDER_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
            return [];
        }
        // 只留字符串、去重（顺序取第一次出现）
        return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))];
    } catch {
        return [];
    }
}

function readMode(): ActionSortMode {
    try {
        const raw = localStorage.getItem(MODE_KEY);
        return SORT_MODES.includes(raw as ActionSortMode) ? (raw as ActionSortMode) : 'default';
    } catch {
        return 'default';
    }
}

function write(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch {
        // 存不进去不影响当前会话 —— store 里的状态已经更新了
    }
}

interface ActionPrefState {
    /** 动作 id → 使用记录。 */
    usage: Record<string, ActionUsageEntry>;
    /** 自定义顺序（只含用户动过的动作；不在里面的按默认顺序跟在后面）。 */
    order: string[];
    sortMode: ActionSortMode;
    /** 记一次使用（面板里选中动作时调用）。 */
    recordUse: (id: string) => void;
    setSortMode: (mode: ActionSortMode) => void;
    /** 把 `id` 在自定义顺序里上移/下移一位。`ids` 是当前面板里**全部**动作的默认顺序。 */
    moveAction: (id: string, delta: -1 | 1, ids: string[]) => void;
    /** 清空使用记录（设置里那个「重置」用）。 */
    resetUsage: () => void;
}

export const useActionPrefStore = create<ActionPrefState>((set, get) => ({
    usage: readUsage(),
    order: readOrder(),
    sortMode: readMode(),

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

    setSortMode: (mode) => {
        set({ sortMode: mode });
        write(MODE_KEY, mode);
    },

    moveAction: (id, delta, ids) => {
        const { order } = get();
        // ⚠️★ 不能只改 `order` 里已有的项：用户第一次点「上移」时 `order` 是空的，
        //    那样等于什么都没发生（点了没反应）。所以先把**当前完整顺序**物化出来，
        //    再在这个完整列表上交换 —— 这也是「自定义」第一次被激活时的行为。
        const base = ids.filter((item) => !order.includes(item));
        const full = [...order.filter((item) => ids.includes(item)), ...base];
        const at = full.indexOf(id);
        const to = at + delta;
        if (at < 0 || to < 0 || to >= full.length) {
            return;
        }
        full.splice(to, 0, ...full.splice(at, 1));
        set({ order: full });
        write(ORDER_KEY, full);
    },

    resetUsage: () => {
        set({ usage: {} });
        write(USAGE_KEY, {});
    },
}));

/**
 * 按当前模式排序。**纯函数**（不改入参），方便单独验。
 *
 * @param actions  一组动作（同一分组内）
 * @param mode     排序方式
 * @param usage    使用记录
 * @param order    自定义顺序
 * @param applicable 可选：判定「这条当前能不能用」，用于 `default` / `frequent` 的「适用优先」
 */
export function sortActions<T extends { id: string }>(
    actions: T[],
    mode: ActionSortMode,
    usage: Record<string, ActionUsageEntry>,
    order: string[],
    applicable?: (action: T) => boolean,
): T[] {
    const list = [...actions];

    if (mode === 'custom') {
        // 自定义顺序**严格生效**：这里再加「适用优先」会把用户刚排好的顺序打乱，
        // 那等于这个模式没有意义（不适用的那些仍然置灰，只是不换位置）。
        const rank = new Map(order.map((id, index) => [id, index]));
        const fallback = order.length;
        return list.sort((a, b) => (rank.get(a.id) ?? fallback) - (rank.get(b.id) ?? fallback));
    }

    if (mode === 'frequent') {
        const score = (action: T) => usage[action.id] ?? { count: 0, lastUsedAt: 0 };
        return list.sort((a, b) => {
            const sa = score(a);
            const sb = score(b);
            if (sb.count !== sa.count) {
                return sb.count - sa.count;
            }
            // 次数相同 → 最近用过的靠前（「最近使用频率」两项都要考虑，不然一堆 count=1 的
            // 动作按创建顺序排，跟没排一样）
            return sb.lastUsedAt - sa.lastUsedAt;
        });
    }

    // default：维持原来那条「适用的排前面」，其余保持 catalog 顺序。
    if (applicable) {
        return list.sort((a, b) => Number(applicable(b)) - Number(applicable(a)));
    }
    return list;
}
