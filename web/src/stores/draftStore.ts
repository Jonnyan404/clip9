import { create } from 'zustand';

/**
 * 「工具类模式里正在做的事」—— 跨模式切换保活。
 *
 * ⚠️★ 为什么需要它：`bench` 的输入草稿和 `convert` 的转换结果原来都是组件内的
 *    `useState`。而**切模式会把模式组件卸载**，于是：
 *      · 在动作台粘一段文本、去标准模式看一眼、切回来 —— 文本没了；
 *      · 转一份几十页的 PDF 要几十秒，切一下模式输出归零，第二次就不敢在里面干活了。
 *    `pages/Home.tsx` 里那句「模式状态在 store 里，所以切换不会丢状态」只在
 *    store 那一半成立（比如发送框的 `send.text`），组件内的一律丢。
 *
 * ⚠️ 刻意**不持久化**（不写 localStorage）：这是「这一次编辑的中间态」，
 *    不是偏好。刷新页面还留着半截草稿，反而会让人怀疑内容是从哪来的。
 *    （白板自己有一套 localStorage 草稿，那是它的场景，别混。）
 */

/** 一次转换的状态机。⚠️ `failed` 要带**原因**，不能只有一个红点。 */
export type ConvertItemState =
    | { phase: 'converting' }
    | { phase: 'done'; markdown: string; chars: number; images: number | null; imagesTruncated: boolean; multiColumnPages: number[] }
    | { phase: 'failed'; reason: string };

export interface ConvertItem {
    /** 这一行的本地 id。⚠️ 不能用文件名 —— 同名文件丢两次会撞。 */
    key: string;
    name: string;
    size: number;
    state: ConvertItemState;
}

interface DraftState {
    /** 动作台里手输/粘进来的那段文本（不是发送框的 `send.text`）。 */
    benchDraft: string;
    setBenchDraft: (value: string) => void;
    /** 「转 Markdown」已经转出来的条目（含正在转 / 失败原因）。 */
    convertItems: ConvertItem[];
    setConvertItems: (next: ConvertItem[] | ((prev: ConvertItem[]) => ConvertItem[])) => void;
}

export const useDraftStore = create<DraftState>((set, get) => ({
    benchDraft: '',
    setBenchDraft: (value) => set({ benchDraft: value }),
    convertItems: [],
    setConvertItems: (next) => {
        // 支持函数式更新：两个模式里大量用 `setItems(prev => ...)`，
        // 直接换成「只能传数组」会让那些调用点全部要重写（而且容易读到旧值）。
        const value = typeof next === 'function' ? next(get().convertItems) : next;
        set({ convertItems: value });
    },
}));
