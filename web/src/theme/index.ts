import { createTheme } from '@mui/material/styles';

/**
 * 应用主题 —— 从 web-vue3/src/plugins/vuetify.js 移植。
 *
 * ⚠️ 用 MUI 的 **CSS 变量主题**（`cssVariables`）而不是纯 JS 主题：现有组件里大量手写 CSS
 * 引用 `--v-theme-*` / `--v-border-color` 这类变量，迁移那些样式时会在 `styles/global.css`
 * 里放一层**兼容别名**，让搬过来的 CSS 第一轮不必改选择器。
 *
 * ⚠️ `colorSchemeSelector: 'class'` → 暗色由根元素上的 `.dark` 类切换。业务判定
 * （`dark ∈ {time, prefer, enable, disable}` + 定时器 + matchMedia）在 appStore / useDarkMode。
 *
 * ⚠️ 主色**从参数传入**：MUI 的 theme 不可变，动态换主色靠调用方用 `useMemo` 重建 theme
 * （见 stores/themeStore.ts）。
 */
export function createAppTheme(primaryLight: string, primaryDark: string) {
    return createTheme({
        cssVariables: { colorSchemeSelector: 'class' },
        colorSchemes: {
            light: {
                palette: {
                    primary: { main: primaryLight },
                    secondary: { main: '#424242' },
                    error: { main: '#ff5252' },
                },
            },
            dark: {
                palette: {
                    primary: { main: primaryDark },
                    secondary: { main: '#424242' },
                    error: { main: '#ff5252' },
                },
            },
        },
    });
}
