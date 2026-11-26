import { createTheme } from '@mui/material/styles';
import { PAPER_DARK, PAPER_LIGHT, SURFACE_DARK, SURFACE_LIGHT } from '@/lib/contrast';

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
                    // ⚠️ 页面底色跟随 Vue 版（App.vue 的 `.app-shell { background: #f4f7fb }`）——
                    // MUI 默认是纯白，跟 Vue 的浅灰蓝对不上。
                    // ⚠️ 值住在 `lib/contrast.js`（传统色板要拿它算「这支色在浅底上看得见吗」），
                    //    两处各写一份迟早会漂。
                    // ⚠️ `paper` 是**纸面**（卡片 / 对话框 / 菜单），`default` 是页面。
                    //    两个都显式给，别让 MUI 回落它的默认值。
                    background: { default: SURFACE_LIGHT, paper: PAPER_LIGHT },
                },
            },
            dark: {
                palette: {
                    primary: { main: primaryDark },
                    secondary: { main: '#424242' },
                    error: { main: '#ff5252' },
                    // Vue：`.app-shell--dark { background: #0f172a }`
                    // ⚠️★ `paper` **必须显式给**：不给的话 MUI 回落 `#121212`（中性黑），
                    //    于是卡片 / 看板列 / 所有 Dialog·Menu 都成了浮在墨蓝页面上的一块暖黑 ——
                    //    明度只差 1.05:1，肉眼看到的是「两种黑」而不是层次。
                    //    受影响面全局（14 个文件用了 Dialog），所以这个值只该有一个来源。
                    background: { default: SURFACE_DARK, paper: PAPER_DARK },
                },
            },
        },
    });
}
