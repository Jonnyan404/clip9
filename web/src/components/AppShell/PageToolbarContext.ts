import { createContext, useContext } from 'react';

/**
 * 外壳提供给工具栏的动作 —— 对应 Vue 版的 `provide('pageToolbarActions', ...)`。
 *
 * ⚠️★ 为什么走 Context 而不是把 props 一层层传：工具栏由**各个模式**自己渲染
 * （`DefaultMode` / `GlanceWall` / … 都挂一个 `<PageToolbar/>`），而它要触发的
 * 弹窗（设置 / 清空 / 进房间 / 二维码）全都归**外壳**管。Context 让模式不需要知道外壳。
 */
export interface PageToolbarActions {
    openSettings: () => void;
    openClearAll: () => void;
    openRoomDialog: () => void;
    toggleConnection: () => void;
    openRoomBrowser: () => void;
    openPageQr: () => void;
    /** 房间活跃度热力图（2026-10-07）。 */
    openActivity: () => void;
    goHome: () => void;
    roomBrowserVisible: boolean;
    roomCount: number;
    roomListEnabled: boolean;
}

const noop = () => {};

/** 默认值是一组空操作：工具栏在**外壳之外**被渲染时（比如测试）不该崩。 */
export const PageToolbarContext = createContext<PageToolbarActions>({
    openSettings: noop,
    openClearAll: noop,
    openRoomDialog: noop,
    toggleConnection: noop,
    openRoomBrowser: noop,
    openPageQr: noop,
    openActivity: noop,
    goHome: noop,
    roomBrowserVisible: false,
    roomCount: 0,
    roomListEnabled: false,
});

export function usePageToolbarActions(): PageToolbarActions {
    return useContext(PageToolbarContext);
}
