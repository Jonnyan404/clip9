import { create } from 'zustand';
import { DEFAULT_DISPLAY, DISPLAY_TOGGLES, LEGACY_STORAGE_KEYS } from '@/data/displayToggles.js';
import { MODES_META } from '@/modes/meta';
import { readLocationParam, type SenderDevice } from '@/lib/util';

// ────────────────────────────────────────────────────────────────────────────
// 从 web-vue3/src/store/app.js 移植。三处一次性迁移逻辑**原样保留**。
// ────────────────────────────────────────────────────────────────────────────

// 某个模式「没被用户单独配过」时的取值。老版本把三个开关存成三个全局 key，
// 升级后必须保证「看起来完全没变」—— 所以有老值就用老值，没有才用出厂默认。只算一次。
const INITIAL_DISPLAY: Record<string, boolean> = (() => {
    const initial: Record<string, boolean> = { ...DEFAULT_DISPLAY };
    for (const [key, storageKey] of Object.entries(LEGACY_STORAGE_KEYS) as [string, string][]) {
        const stored = localStorage.getItem(storageKey);
        if (stored !== null) {
            initial[key] = stored === 'true';
            localStorage.removeItem(storageKey); // 迁完就删，免得两处状态打架
        }
    }
    return initial;
})();

export interface ShareDefaults {
    ttlMinutes: number;
    maxUses: number;
    password: string;
}

function loadShareDefaults(): ShareDefaults {
    const fallback: ShareDefaults = { ttlMinutes: 15, maxUses: 0, password: '' };
    try {
        const raw = localStorage.getItem('shareDefaults');
        if (!raw) return fallback;
        const parsed = JSON.parse(raw) as Partial<ShareDefaults>;
        if (!parsed || typeof parsed !== 'object') return fallback;
        return {
            ttlMinutes: Number.isFinite(Number(parsed.ttlMinutes)) ? Number(parsed.ttlMinutes) : fallback.ttlMinutes,
            maxUses: Number.isFinite(Number(parsed.maxUses)) ? Number(parsed.maxUses) : fallback.maxUses,
            password: typeof parsed.password === 'string' ? parsed.password : fallback.password,
        };
    } catch {
        return fallback;
    }
}

function loadDisplayByMode(): Record<string, Record<string, boolean>> {
    const raw = localStorage.getItem('displayByMode');
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as Record<string, Record<string, boolean>>;
        if (!parsed || typeof parsed !== 'object') return {};
        // markdown 开关曾经只在 default 模式露面，便签等模式下存的 markdown:false 不可能是
        // 用户亲手关的，只能是「拨别的开关时把旧默认值(false)顺手存进去」的陈旧值。
        // 现在默认值已翻成 true，清掉这些陈旧 false 让新默认生效；只清一次（打版本戳）。
        if (localStorage.getItem('displayByModeMigrated') !== '1') {
            for (const [mode, cfg] of Object.entries(parsed)) {
                if (mode !== 'default' && cfg && typeof cfg === 'object' && cfg.markdown === false) {
                    delete cfg.markdown;
                }
            }
            localStorage.setItem('displayByMode', JSON.stringify(parsed));
            localStorage.setItem('displayByModeMigrated', '1');
        }
        return parsed;
    } catch {
        return {};
    }
}

// ────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────

export type DarkMode = 'time' | 'prefer' | 'enable' | 'disable' | '';

export interface AppConfig {
    version: string;
    server: { history: number; prefix: string; roomList: boolean; auth?: boolean };
    text: { limit: number };
    file: { expire: number; chunk: number; limit: number };
    automation?: { enabled?: boolean };
    /** 全局是否要求鉴权（服务端 `config` 事件里的顶层字段）。 */
    auth?: boolean;
}

export interface ReceivedItem {
    id: string;
    type: 'text' | 'file';
    content?: string;
    name?: string;
    size?: number;
    timestamp?: number;
    cache?: string;
    expire?: number;
    thumbnail?: string;
    column?: string;
    senderDevice?: SenderDevice;
    senderIP?: string;
    source?: string;
    late?: boolean;
    [key: string]: unknown;
}

export interface AppState {
    dark: DarkMode;
    config: AppConfig;
    send: { text: string; files: File[] };
    received: ReceivedItem[];
    roomMessagesCache: Record<string, ReceivedItem[]>;
    isRoomSyncing: boolean;
    device: Array<{ id: string; type?: string; os?: string; browser?: string; name?: string }>;
    displayByMode: Record<string, Record<string, boolean>>;
    searchQuery: string;
    shareDefaults: ShareDefaults;
    composerPrimary: string;
    fullscreenSendClose: boolean;
    uiMode: string;
    embedded: boolean;

    setSearchQuery: (value: string) => void;
    setShareDefaults: (next: Partial<ShareDefaults>) => void;
    setConfig: (config: AppConfig) => void;
    toggleComposerPrimary: () => void;
    toggleFullscreenSendClose: () => void;
    setUiMode: (mode: string) => void;
    setDisplayToggle: (key: string, value: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
    dark: (localStorage.getItem('darkmode') as DarkMode) || 'prefer',
    config: {
        version: '',
        server: { history: 0, prefix: '', roomList: false },
        text: { limit: 0 },
        file: { expire: 0, chunk: 0, limit: 0 },
    },
    send: { text: '', files: [] },
    received: [],
    roomMessagesCache: {},
    isRoomSyncing: false,
    device: [],
    displayByMode: loadDisplayByMode(),
    searchQuery: '',
    shareDefaults: loadShareDefaults(),
    composerPrimary: localStorage.getItem('composerPrimary') || 'text',
    fullscreenSendClose: localStorage.getItem('fullscreenSendClose') !== null
        ? localStorage.getItem('fullscreenSendClose') === 'true'
        : true,
    // 界面模式：**地址里的 `?mode=` 优先**，其次是上次用过的，最后是标准模式。
    // 这样「一个 tab 一个模式」——每个 tab 有自己的地址，就互不干扰。
    uiMode: readLocationParam('mode') || localStorage.getItem('uiMode') || 'default',
    // 嵌入态（桌面端把网页版塞进 iframe 时带 `?embed=1`）。
    embedded: readLocationParam('embed') === '1',

    setSearchQuery: (value) => set({ searchQuery: String(value || '') }),

    // 分享默认值：改完立刻落盘，不弹窗时要用
    setShareDefaults: (next) => {
        const merged = { ...get().shareDefaults, ...(next || {}) };
        set({ shareDefaults: merged });
        try {
            localStorage.setItem('shareDefaults', JSON.stringify(merged));
        } catch { /* 存不下就算了，内存里仍然生效 */ }
    },

    setConfig: (config) => set({ config }),

    toggleComposerPrimary: () => {
        const next = get().composerPrimary === 'files' ? 'text' : 'files';
        set({ composerPrimary: next });
        localStorage.setItem('composerPrimary', next);
    },

    toggleFullscreenSendClose: () => {
        const next = !get().fullscreenSendClose;
        set({ fullscreenSendClose: next });
        localStorage.setItem('fullscreenSendClose', String(next));
    },

    setUiMode: (mode) => {
        // 搜索条只存在于标准模式；不清掉的话，切到别的模式会看到一份被悄悄过滤过的列表，
        // 而那个模式里根本没有搜索框可以清。
        set({ uiMode: mode, searchQuery: '' });
        localStorage.setItem('uiMode', mode);
    },

    // 拨动的是**当前模式**的开关。持久化写在 action 里（跟 uiMode / composerPrimary 同一写法）。
    setDisplayToggle: (key, value) => {
        const state = get();
        const next = {
            ...state.displayByMode,
            [state.uiMode]: { ...selectDisplay(state), [key]: value },
        };
        set({ displayByMode: next });
        localStorage.setItem('displayByMode', JSON.stringify(next));
    },
}));

// ────────────────────────────────────────────────────────────────────────────
// 选择器（对应 Pinia 的 getters）—— 不进 store，避免全量订阅重渲染
// ────────────────────────────────────────────────────────────────────────────

/**
 * 搜索过滤后的内容列表。**各模式渲染列表都取这个，不要直接取 received** ——
 * 否则搜索框只在部分模式生效，看着像坏了。
 * 计数、空态判断仍然用 received（那是「房间里有多少内容」，与搜索无关）。
 */
export function selectVisibleReceived(state: AppState): ReceivedItem[] {
    const q = String(state.searchQuery || '').trim().toLowerCase();
    if (!q) return state.received;
    return state.received.filter((item) => {
        const haystack = item.type === 'text' ? String(item.content || '') : String(item.name || '');
        return haystack.toLowerCase().includes(q);
    });
}

/**
 * 当前模式的显示开关。缺的键用 INITIAL_DISPLAY 兜底 —— 加新开关时老用户不用迁移就能拿到默认值。
 *
 * ⚠️★ 嵌入态（`?embed=1`）：composer 那一组**没被用户拨过就当关** —— 「桌面端帮忙关一下」，
 * 但**允许手动打开**（用户在个性化里拨过的照旧算数）。为什么在源头改**默认值**而不是各模式
 * 各判一遍 `embedded`：发送区有两套实现，在源头改两边自动都吃到。
 */
export function selectDisplay(state: AppState): Record<string, boolean> {
    const stored = state.displayByMode[state.uiMode] || {};
    const base: Record<string, boolean> = { ...INITIAL_DISPLAY, ...stored };
    if (!state.embedded) {
        return base;
    }
    const hostTakesInput: Record<string, boolean> = { ...base };
    for (const toggle of DISPLAY_TOGGLES as Array<{ key: string; group: string }>) {
        if (toggle.group === 'composer' && !(toggle.key in stored)) {
            hostTakesInput[toggle.key] = false;
        }
    }
    return hostTakesInput;
}

/**
 * 输入区是不是**什么都不剩**了：文本区、上传区、以及 composer 那一整组图标全关。
 * 这时候只剩一个空外框，该把整个输入区一起藏掉。
 * ⚠️ 只是图标全关、输入框还在时**不该**藏 —— 框是输入框的容器。
 */
export function selectComposerFullyHidden(state: AppState): boolean {
    const d = selectDisplay(state);
    if (d.composerText || d.composerUpload) return false;
    const iconKeys = (DISPLAY_TOGGLES as Array<{ key: string; group: string }>)
        .filter((x) => x.group === 'composer' && x.key !== 'composerText' && x.key !== 'composerUpload')
        .map((x) => x.key);
    return !iconKeys.some((k) => d[k]);
}

/**
 * 六个模式**全都**把文本区与上传区关掉了 —— 即「纯预览模式」。
 * ⚠️ 模式列表**现取**（不要在模块顶层算成常量）：见 meta.ts 的循环依赖说明。
 */
export function selectComposerDisabledEverywhere(state: AppState): boolean {
    return MODES_META.map((m) => m.key).every((mode) => {
        const cfg = state.displayByMode[mode] || {};
        const off = (key: string) => (key in cfg ? cfg[key] : (DEFAULT_DISPLAY as Record<string, boolean>)[key]) === false;
        return off('composerText') && off('composerUpload');
    });
}

/** 深浅色策略解析成「现在是不是暗色」。 */
export function selectUseDark(state: AppState): boolean {
    switch (state.dark) {
        case 'time': {
            const hour = new Date().getHours();
            return hour < 7 || hour >= 19;
        }
        case 'prefer':
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        case 'enable':
            return true;
        case 'disable':
            return false;
        default:
            return false;
    }
}
