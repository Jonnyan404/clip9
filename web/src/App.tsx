import { useMemo } from 'react';
import { RouterProvider } from 'react-router';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { router } from '@/router';
import { createAppTheme } from '@/theme';
import { useThemeStore } from '@/stores/themeStore';

/**
 * 应用根组件 —— 对应 web-vue3/src/App.vue 的**最外层**。
 *
 * ⚠️ 外壳（工具栏 / 房间侧栏 / 各类弹窗 / 暗色系统）在 `components/AppShell/RootLayout.tsx`：
 * 它要在**路由树内部**（分享页走裸壳、其余走完整外壳），所以不能挂在 `RouterProvider` 外面。
 */
export function App() {
    const primaryLight = useThemeStore((s) => s.primaryLight);
    const primaryDark = useThemeStore((s) => s.primaryDark);
    const theme = useMemo(() => createAppTheme(primaryLight, primaryDark), [primaryLight, primaryDark]);

    return (
        <ThemeProvider theme={theme} defaultMode="light">
            <CssBaseline />
            <RouterProvider router={router} />
        </ThemeProvider>
    );
}
