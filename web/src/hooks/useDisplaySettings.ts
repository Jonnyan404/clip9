import { useMemo } from 'react';
import { selectDisplay, useAppStore } from '@/stores/appStore';

/**
 * 当前模式的显示开关（`app.display` 的 React 等价物）。
 *
 * ⚠️★ 必须用 `useMemo` 组合，**不能**直接 `useAppStore(selectDisplay)`：
 * `selectDisplay` 每次返回一个**新对象**，而 Zustand v5 用 `Object.is` 比较选择器结果 ——
 * 每次渲染都「变了」会触发无限重渲染。所以只订阅三个稳定引用（`displayByMode` / `uiMode` /
 * `embedded`），再用 useMemo 算派生值。
 */
export function useDisplaySettings(): Record<string, boolean> {
    const displayByMode = useAppStore((s) => s.displayByMode);
    const uiMode = useAppStore((s) => s.uiMode);
    const embedded = useAppStore((s) => s.embedded);
    return useMemo(
        () => selectDisplay({ displayByMode, uiMode, embedded }),
        [displayByMode, uiMode, embedded],
    );
}
