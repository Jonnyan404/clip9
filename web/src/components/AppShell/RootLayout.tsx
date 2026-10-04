import { useEffect } from 'react';
import { Outlet, useMatches } from 'react-router';
import { AppShell } from './AppShell';
import { startRealtime } from '@/services/bootstrap';

/**
 * 路由根布局 —— 决定「这一屏走完整外壳，还是裸壳」，并在**挂载后**启动实时连接。
 *
 * ⚠️★ 对应 web-vue3/src/App.vue 模板顶部那个 `v-if="isShareRoute"`：
 * 分享页是给收件人看的独立页面，**不能带主应用外壳**（工具栏、房间侧栏、设置面板）。
 * 包一层而不是给每一块加条件 —— 外壳的部件太多，漏一个就漏出去了。
 *
 * ⚠️★ 实时连接（WebSocket / 宿主桥）放在这里而不是 main.tsx：那时首个 location 才解析完，
 * `isShareRoute()` 才可信；而且**不能**手动调 `router.initialize()`（会让 history 注册两个
 * 监听器、整树挂掉）。详见 services/bootstrap.ts 的文件头。
 */
export function RootLayout() {
    const matches = useMatches();
    const isSharePage = matches.some(
        (match) => (match as unknown as { handle?: { sharePage?: boolean } }).handle?.sharePage === true,
    );

    useEffect(() => {
        startRealtime();
    }, []);

    if (isSharePage) {
        return <Outlet />;
    }

    return (
        <AppShell>
            <Outlet />
        </AppShell>
    );
}
