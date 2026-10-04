import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import Home from '@/pages/Home';
import { RootLayout } from '@/components/AppShell/RootLayout';

// 分享页懒加载：它只在 `/s/<token>` 上用到，不该进首屏。
const SharePage = lazy(() => import('@/pages/SharePage'));

/**
 * 路由表 —— 对应 web-vue3/src/router/index.js。
 *
 * ⚠️★ 包一层 `RootLayout`：它负责「分享页走裸壳、其余走完整外壳」的分岔
 * （对应 App.vue 模板顶部那个 `v-if="isShareRoute"`）。
 *
 * ⚠️★ `handle.sharePage` 对应 Vue 侧的 `route.meta.sharePage`：
 * main.tsx 的引导靠它**跳过分享页**（不建 WebSocket、不碰房间状态、不装宿主桥）。
 */
export const routes: RouteObject[] = [
    {
        element: <RootLayout />,
        children: [
            {
                path: '/',
                element: <Home />,
            },
            {
                path: '/s/:token?',
                element: (
                    <Suspense fallback={null}>
                        <SharePage />
                    </Suspense>
                ),
                handle: { sharePage: true },
            },
        ],
    },
];
