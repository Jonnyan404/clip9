import { create } from 'zustand';

/**
 * 全局 toast —— 从 web-vue3/src/plugins/toast.js 移植。
 *
 * ⚠️ 与 Vue 版一样是**模块级单例**：`toast()` 可以在任何地方（store / service / 组件）调，
 * 不依赖 React 上下文。渲染由一个 `<ToastHost />` 订阅本 store 完成。
 *
 * ⚠️★ 2026-11-26 从**单槽**改成**队列**：原来 store 里只有一个 `text`，
 *    后一条直接覆盖前一条。而「白板导入成功」会连发两条（`canvasImported` + `pdfMultiColumn`），
 *    前一条永远看不到 —— 用户只知道「有一条提示闪了一下」。
 *    现在最多同时挂 3 条（再多会把屏幕糊住），超出丢最旧的。
 */
export interface ToastAction {
    label: string;
    onClick: () => void;
}

export interface ToastOptions {
    color?: string;
    timeout?: number;
    showClose?: boolean;
    dismissable?: boolean;
    forever?: boolean;
    /** 一颗内联按钮（典型用法：「撤销」）。点它之后这条 toast 自己关掉。 */
    action?: ToastAction;
}

export interface ToastItem {
    id: number;
    text: string;
    color: string;
    timeout: number;
    showClose: boolean;
    dismissable: boolean;
    forever: boolean;
    action?: ToastAction;
}

interface ToastStore {
    items: ToastItem[];
    /** 返回 id（调用方一般不用，`hide(id)` 时才有意义）。 */
    show: (text: string, options?: ToastOptions) => number;
    /** 不传 id = 全部关掉（兼容旧的 `hide()` 调用）。 */
    hide: (id?: number) => void;
}

/** 同时最多挂几条。 */
const MAX_VISIBLE = 3;
/** 默认时长；`-1` 表示不自动关。 */
const DEFAULT_TIMEOUT = 3000;

let seq = 0;
const timers = new Map<number, number>();

function clearTimer(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(id);
    }
}

export const useToastStore = create<ToastStore>((set, get) => ({
    items: [],

    show: (text, options = {}) => {
        const id = ++seq;
        const forever = options.forever ?? false;
        const dismissable = options.dismissable ?? false;
        const timeout = options.timeout ?? (forever || dismissable ? -1 : DEFAULT_TIMEOUT);
        const item: ToastItem = {
            id,
            text,
            color: options.color || '',
            timeout,
            showClose: options.showClose ?? false,
            dismissable,
            forever,
            action: options.action,
        };
        const next = [...get().items, item];
        // 超出上限时，把最旧的那条连它的定时器一起清掉
        while (next.length > MAX_VISIBLE) {
            const dropped = next.shift();
            if (dropped) {
                clearTimer(dropped.id);
            }
        }
        set({ items: next });
        if (timeout > 0) {
            timers.set(id, window.setTimeout(() => get().hide(id), timeout));
        }
        return id;
    },

    hide: (id) => {
        if (id === undefined) {
            for (const item of get().items) {
                clearTimer(item.id);
            }
            set({ items: [] });
            return;
        }
        clearTimer(id);
        set({ items: get().items.filter((item) => item.id !== id) });
    },
}));

type ToastFn = ((text: string, options?: ToastOptions) => void) & {
    error: (text: string, options?: ToastOptions) => void;
    success: (text: string, options?: ToastOptions) => void;
    info: (text: string, options?: ToastOptions) => void;
};

export const toast = ((text: string, options: ToastOptions = {}) => {
    useToastStore.getState().show(text, options);
}) as ToastFn;

toast.error = (text, options = {}) => toast(text, { ...options, color: 'error' });
toast.success = (text, options = {}) => toast(text, { ...options, color: 'success' });
toast.info = (text, options = {}) => toast(text, { ...options, color: 'info' });
