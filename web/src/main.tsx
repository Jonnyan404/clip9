import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// 图标字体（MDI）：数据层（catalog.json / displayToggles / registry）里存的是
// `mdi-brightness-4` 这类**类名**，靠这套 CSS 字体渲染 —— 保留 `@mdi/font` 可让数据层零改动。
import '@mdi/font/css/materialdesignicons.css';
import './styles/highlight.css';
import './styles/components.css';
import './styles/global.css';

// i18n 实例必须在使用 `t()` 的代码之前初始化（资源随包打进 bundle，所以是同步完成的）。
import '@/i18n';

import { readLocationParam } from '@/lib/util';
import { setupAxios } from '@/services/http';
import { setupServiceWorkerUpdate } from '@/services/swUpdate';
import { installShareBridge } from '@/services/shareBridge';
import { installHostBridge } from '@/services/hostBridge';
import { isShareRoute, router } from '@/router';
import { useAppStore, type DarkMode } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { App } from './App';

/**
 * 应用引导 —— 与 web-vue3/src/main.js **一一对应**，顺序敏感（每一步都写了原因）。
 */
async function bootstrap(): Promise<void> {
    // 1. axios：baseURL（= 外壳基准目录）+ 拦截器。必须最先 —— 后面所有请求都靠它。
    setupAxios();

    // 2. 深浅色：**必须赶在首次渲染之前**定下来。
    //    ⚠️★ 原来它写在路由就绪的回调里，而 App 的 onMounted 在 mount() 时跑 —— 回调那时还没执行，
    //    于是**每一帧都先画浅色、再切深色**，表现就是「打开闪一下白」。
    //    嵌入态（`?embed=1`）会带 `?theme=dark|light`，把桌面端选的主题同步进来。
    const themeParam = readLocationParam('theme');
    const forcedTheme: DarkMode | '' = readLocationParam('embed') === '1'
        ? (themeParam === 'dark' ? 'enable' : themeParam === 'light' ? 'disable' : '')
        : '';
    useAppStore.setState({ dark: (forcedTheme || localStorage.getItem('darkmode') || 'prefer') as DarkMode });

    // 3. SW 更新检测在 store 之后装：它要读「有没有还没发出去的内容」来决定现在刷还是等会刷。
    //    ⚠️ 内嵌态会顺手把已装的 SW 注销掉（理由见 services/swUpdate.ts）。
    setupServiceWorkerUpdate();

    // 4. 外壳分享入口（`window.clip9Share`）：必须在**页面加载完**之前挂好 ——
    //    外壳是「页面加载完就调」，晚一步那次分享就落在空的 window 上。
    installShareBridge();

    // 5. 等首个 location 解析完 —— 之后才谈得上「是不是分享页」。
    await router.initialize();

    // 6. 分享页是给收件人看的独立页面：不建 WebSocket、不碰房间状态、不装宿主桥。
    //    它只认 URL 里的 token，走自己那几个相对路径请求（见 pages/SharePage.tsx）。
    if (!isShareRoute()) {
        const ws = useWebSocketStore.getState();
        ws.initFromRoute(new URLSearchParams(router.state.location.search).get('room') || '');
        void ws.connect();
        // 嵌入态的宿主消息通道（`?embed=1` 才真的装上）—— 桌面端用它切房间 / 切主题，
        // 免得每次重设 `iframe.src` 把整个页面重载一遍。契约见 services/hostBridge.ts。
        installHostBridge();
    }

    createRoot(document.getElementById('app')!).render(
        <StrictMode>
            <App />
        </StrictMode>,
    );
}

void bootstrap();
