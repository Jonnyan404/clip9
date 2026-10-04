import { create } from 'zustand';

/**
 * 主题主色（明/暗各一份）。
 *
 * ⚠️★ 为什么要单独一个 store：Vue 版是直接改 `theme.themes.value.dark.colors.primary`
 * （Vuetify 的主题是可变对象）。MUI 的 theme 是**不可变**的 —— 要动态换主色就得让
 * `<ThemeProvider>` 拿到一个新的 theme 对象，所以把主色提到 store 里、由 App 用
 * `useMemo` 重建 theme。
 */
export const DEFAULT_PRIMARY = '#1e88e5';

interface ThemeState {
    primaryLight: string;
    primaryDark: string;
    setPrimary: (scope: 'light' | 'dark', hex: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
    primaryLight: localStorage.getItem('lightPrimary') || DEFAULT_PRIMARY,
    primaryDark: localStorage.getItem('darkPrimary') || DEFAULT_PRIMARY,
    setPrimary: (scope, hex) => {
        localStorage.setItem(scope === 'dark' ? 'darkPrimary' : 'lightPrimary', hex);
        set(scope === 'dark' ? { primaryDark: hex } : { primaryLight: hex });
    },
}));
