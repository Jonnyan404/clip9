/**
 * 路由就绪之后的实时连接引导。
 *
 * ⚠️★ 为什么**不能**在 main.tsx 里手动 `await router.initialize()`：
 * React Router 的 `RouterProvider` 挂载时**自己会**调 `initialize()`。手动再调一次会让
 * history 被注册**两个**监听器，抛 `Error: A history only accepts one active listener`，
 * 整个路由树挂不起来 —— 表现是**白屏**，而且 curl 完全看不出来（服务端照常返回外壳）。
 * （2026-10-04 真浏览器验收抓到，见 tools/spa-acceptance.mjs 的「SPA 挂载了」那条。）
 *
 * 所以启动时机交给**路由树内部**的组件（`RootLayout` 的 effect）：那时首个 location
 * 已经解析完、`isShareRoute()` 才是可信的。
 *
 * ⚠️ 幂等：`started` 守卫，避免 React 严格模式的双调用重复建连。
 */
import { isShareRoute, router } from '@/router';
import { useWebSocketStore } from '@/stores/wsStore';
import { installHostBridge } from '@/services/hostBridge';

let started = false;

export function startRealtime(): void {
    if (started) {
        return;
    }
    started = true;

    // 分享页是给收件人看的独立页面：不建 WebSocket、不碰房间状态、不装宿主桥。
    // 它只认 URL 里的 token，走自己那几个相对路径请求（见 pages/SharePage.tsx）。
    if (isShareRoute()) {
        return;
    }

    const ws = useWebSocketStore.getState();
    ws.initFromRoute(new URLSearchParams(router.state.location.search).get('room') || '');
    void ws.connect();

    // 嵌入态的宿主消息通道（`?embed=1` 才真的装上）—— 桌面端用它切房间 / 切主题，
    // 免得每次重设 `iframe.src` 把整个页面重载一遍。契约见 services/hostBridge.ts。
    installHostBridge();
}
