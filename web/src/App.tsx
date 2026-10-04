import { RouterProvider } from 'react-router';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { router } from '@/router';
import { theme } from '@/theme';

/**
 * 应用根组件 —— 对应 web-vue3/src/App.vue 的**最外层**。
 *
 * Phase 1 只挂三样：MUI 主题、`CssBaseline`、路由。
 * Phase 3 会在这里补上外壳（工具栏 / 房间侧栏 / 各类弹窗 / 暗色系统 / 模式↔地址同步），
 * 对应 web-vue3/src/App.vue 那 1419 行。
 */
export function App() {
    return (
        <ThemeProvider theme={theme} defaultMode="light">
            <CssBaseline />
            <RouterProvider router={router} />
        </ThemeProvider>
    );
}
