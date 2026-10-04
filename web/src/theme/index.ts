import { createTheme } from '@mui/material/styles';

// 从 web-vue3/src/plugins/vuetify.js 移植：明暗两套主题共用同一组主色
// （primary #1e88e5 / secondary #424242 / error #ff5252）。
//
// ⚠️ 用 MUI 的 **CSS 变量主题**（`cssVariables`）而不是纯 JS 主题：现有组件里大量手写 CSS
// 引用 `--v-theme-*` / `--v-border-color` 这类变量，Phase 3–5 迁移那些样式时，会在
// `styles/global.css` 里放一层**兼容别名**（`--v-theme-primary` → MUI 变量），
// 让搬过来的 `.module.css` 第一轮不必改选择器。
//
// ⚠️ `colorSchemeSelector: 'class'` → 暗色由根元素上的 `.dark` 类切换。这与现有
// `App.vue` 里那套（`dark ∈ {time, prefer, enable, disable}` + 定时器 + matchMedia）**不冲突**：
// 业务判定仍写在 appStore，最终只是决定要不要挂 `.dark`。
const palette = {
    primary: { main: '#1e88e5' },
    secondary: { main: '#424242' },
    error: { main: '#ff5252' },
};

export const theme = createTheme({
    cssVariables: { colorSchemeSelector: 'class' },
    colorSchemes: {
        light: { palette },
        dark: { palette },
    },
});
