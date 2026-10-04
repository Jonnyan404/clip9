import { Outlet, useMatches } from 'react-router';
import { AppShell } from './AppShell';

/**
 * 路由根布局 —— 决定「这一屏走完整外壳，还是裸壳」。
 *
 * ⚠️★ 对应 web-vue3/src/App.vue 模板顶部那个 `v-if="isShareRoute"`：
 * 分享页是给收件人看的独立页面，**不能带主应用外壳**（工具栏、房间侧栏、设置面板）。
 * 包一层而不是给每一块加条件 —— 外壳的部件太多，漏一个就漏出去了。
 */
export function RootLayout() {
    const matches = useMatches();
    const isSharePage = matches.some(
        (match) => (match as unknown as { handle?: { sharePage?: boolean } }).handle?.sharePage === true,
    );

    if (isSharePage) {
        return <Outlet />;
    }

    return (
        <AppShell>
            <Outlet />
        </AppShell>
    );
}
