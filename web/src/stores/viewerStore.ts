import { create } from 'zustand';
import { selectVisibleReceived, useAppStore, type ReceivedItem } from './appStore';

/**
 * 全屏查看器的**开关与序列**。
 *
 * ⚠️★ 为什么存 id 而不是条目对象：列表是活的 —— 一条可能在这期间被 revoke、被新消息挤下去，
 * 也可能被「清空」整批带走。存对象的话查看器会继续展示一条**已经不存在**的内容，
 * 而屏幕上没有任何东西提示它是死的。存 id、渲染时到 `received` 里现查，就自然跟着列表走。
 *
 * ⚠️★ 序列是**打开那一刻**的可见集（尊重当时的筛选 / 搜索），之后**不跟着重新算**：
 * 否则新来一条消息会把用户正在看的位置整体挪一格 —— 那种「自己滑走了」的体验比停在旧序列上糟。
 *
 * ⚠️ 不存「当前第几条」：那是**滚动位置**的函数，由查看器自己按 `scrollTop` 算。
 * 两边都存就会有两份真相，而它们必然在某一帧里不一致（表现为计数跳一下 / 视频闪一下）。
 * 这里只记**打开时的落点**，组件读一次就够。
 */
interface ViewerState {
    /** 打开时的序列（条目 id，顺序即滚动顺序）。空数组 = 关着。 */
    ids: string[];
    /** 打开时落在第几条（组件只读一次，之后由滚动位置接管）。 */
    initialIndex: number;
    open: (items: ReceivedItem[], id: string) => void;
    close: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
    ids: [],
    initialIndex: 0,
    open: (items, id) => {
        const ids = items.map((item) => String(item.id));
        if (!ids.length) return;
        const at = ids.indexOf(String(id));
        set({ ids, initialIndex: at < 0 ? 0 : at });
    },
    close: () => set({ ids: [], initialIndex: 0 }),
}));

/** 查看器开着吗。`true` 时各模式的键盘导航要让开（否则方向键会同时翻列表和翻查看器）。 */
export function isViewerOpen(): boolean {
    return useViewerStore.getState().ids.length > 0;
}

/**
 * 用「当前可见集」打开 —— 给**拿不到模式自己筛选结果**的叶子组件用（便签、预览块）。
 *
 * ⚠️ 它尊重**搜索**（搜索是全站的），但**不尊重模式内的分类筛选**（「只看图片」那种）：
 * 那个筛选住在各模式自己的 `useState` 里，叶子组件看不见。
 * 模式自己知道列表时应当直接用 `useViewerStore.getState().open(自己的列表, id)` ——
 * 那条路更准，也别为了少写一行就把两件事混起来。
 */
export function openFromVisibleSet(item: ReceivedItem): void {
    const { received, searchQuery } = useAppStore.getState();
    useViewerStore.getState().open(selectVisibleReceived({ received, searchQuery }), item.id);
}
