import { useEffect } from 'react';
import { useColorScheme } from '@mui/material/styles';
import { selectUseDark, useAppStore } from '@/stores/appStore';

/**
 * 深浅色系统 —— 从 web-vue3/src/App.vue 的 `applyDarkMode` / `setupDarkModeTimers` 移植。
 *
 * 四种策略（`dark`）：
 *   · `time`    —— 每秒重算一次（19:00–07:00 算暗色）
 *   · `prefer`  —— 跟随系统，监听 `prefers-color-scheme`
 *   · `enable`  —— 恒暗
 *   · `disable` —— 恒亮
 *
 * ⚠️★ 落点是 MUI 的 color scheme（`cssVariables.colorSchemeSelector: 'class'` → 根元素 `.dark`），
 * 业务判定仍在 appStore（`selectUseDark`）—— 与 Vue 版「判定在 store、主题在 Vuetify」一致。
 * ⚠️ 初值必须在**首次渲染之前**定下来（见 main.tsx），否则会先画浅色再切暗色（闪白）。
 */
export function useDarkMode(): boolean {
    const dark = useAppStore((s) => s.dark);
    const { mode, setMode } = useColorScheme();

    useEffect(() => {
        localStorage.setItem('darkmode', dark);
        let timer: ReturnType<typeof setInterval> | null = null;
        let mq: MediaQueryList | null = null;

        const apply = () => {
            setMode(selectUseDark(useAppStore.getState()) ? 'dark' : 'light');
        };
        apply();

        if (dark === 'time') {
            timer = setInterval(apply, 1000);
        } else if (dark === 'prefer') {
            mq = window.matchMedia('(prefers-color-scheme: dark)');
            mq.addEventListener('change', apply);
        }

        return () => {
            if (timer) clearInterval(timer);
            if (mq) mq.removeEventListener('change', apply);
        };
    }, [dark, setMode]);

    return mode === 'dark';
}
