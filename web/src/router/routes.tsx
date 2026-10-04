import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import Home from '@/pages/Home';

// 分享页懒加载：它只在 `/s/<token>` 上用到，不该进首屏。
const SharePage = lazy(() => import('@/pages/SharePage'));

/**
 * 路由表 —— 对应 web-vue3/src/router/index.js。
 *
 * 两条路由，与 Vue 侧一一对应：
 *   · `/`          → Home（模式分发器）
 *   · `/s/:token?` → 分享页。token 允许缺失（直接打开 `/s`）：给一个可读的「链接无效」，
 *                    而不是无路由白屏。
 *
 * ⚠️★ `handle.sharePage` 对应 Vue 侧的 `route.meta.sharePage`：main.tsx 的引导逻辑靠它
 *    **跳过分享页**（分享页不建 WebSocket、不碰房间状态、不装宿主桥）。
 *    React Router 里用 `useMatches()` 读 `handle`（见 Phase 2 的引导改造）。
 */
export const routes: RouteObject[] = [
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
];
