import { create } from 'zustand';

/**
 * 全局 toast —— 从 web-vue3/src/plugins/toast.js 移植。
 *
 * ⚠️ 与 Vue 版一样是**模块级单例**：`toast()` 可以在任何地方（store / service / 组件）调，
 * 不依赖 React 上下文。渲染由一个 `<ToastHost />` 订阅本 store 完成（Phase 3）。
 */
export interface ToastOptions {
    color?: string;
    timeout?: number;
    showClose?: boolean;
    dismissable?: boolean;
    forever?: boolean;
}

export interface ToastState {
    visible: boolean;
    text: string;
    color: string;
    timeout: number;
    showClose: boolean;
    dismissable: boolean;
    forever: boolean;
}

interface ToastStore extends ToastState {
    show: (text: string, options?: ToastOptions) => void;
    hide: () => void;
}

const initial: ToastState = {
    visible: false,
    text: '',
    color: '',
    timeout: 3000,
    showClose: false,
    dismissable: false,
    forever: false,
};

export const useToastStore = create<ToastStore>((set) => ({
    ...initial,
    show: (text, options = {}) => {
        const forever = options.forever ?? false;
        const dismissable = options.dismissable ?? false;
        set({
            text,
            color: options.color || '',
            timeout: options.timeout ?? (forever || dismissable ? -1 : 3000),
            visible: true,
            showClose: options.showClose ?? false,
            dismissable,
            forever,
        });
    },
    hide: () => set({ visible: false }),
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
