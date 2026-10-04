import { create } from 'zustand';
import { readLocationParam } from '@/lib/util';

/**
 * 全局应用状态 —— 对应 web-vue3/src/store/app.js。
 *
 * Phase 1 只落**骨架必需**的字段（暗色 / 界面模式 / 嵌入态 / 搜索词）。
 * 其余字段（config / send / received / roomMessagesCache / device / displayByMode /
 * shareDefaults / composerPrimary / fullscreenSendClose）与对应 action 在 Phase 2 迁移。
 *
 * ⚠️ 与 Pinia 的对应关系（计划 §5.1）：
 *   · state → `create()` 的初始值；
 *   · actions → store 方法（持久化**写在 action 里**，别分散到组件）；
 *   · getters（visibleReceived / display / useDark …）→ **选择器函数**，不进 store。
 */
export type DarkMode = 'time' | 'prefer' | 'enable' | 'disable' | '';

interface AppState {
    /** 深浅色策略。`null`（此处用空串）→ 解析成浅色。 */
    dark: DarkMode;
    /** 界面模式：**地址里的 `?mode=` 优先**，其次是上次用过的，最后是标准模式。 */
    uiMode: string;
    /** 嵌入态（桌面端把网页版塞进 iframe 时带 `?embed=1`）。 */
    embedded: boolean;
    /** 搜索词。各模式渲染列表都取「过滤后」的那一份（Phase 2 加选择器）。 */
    searchQuery: string;
    setUiMode: (mode: string) => void;
    setSearchQuery: (value: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
    dark: (localStorage.getItem('darkmode') as DarkMode) || 'prefer',
    uiMode: readLocationParam('mode') || localStorage.getItem('uiMode') || 'default',
    embedded: readLocationParam('embed') === '1',
    searchQuery: '',

    // 搜索条只存在于标准模式；不清掉的话，切到别的模式会看到一份被悄悄过滤过的列表，
    // 而那个模式里根本没有搜索框可以清。
    setUiMode: (mode) => {
        set({ uiMode: mode, searchQuery: '' });
        localStorage.setItem('uiMode', mode);
    },
    setSearchQuery: (value) => set({ searchQuery: String(value || '') }),
}));
