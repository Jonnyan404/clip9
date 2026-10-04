/**
 * 让「部署了新版本」这件事在所有设备上自动生效 —— 包括手机。
 * 从 web-vue3/src/sw-update.js 移植。
 *
 * 根因：PWA 的 Service Worker 把整站（含 index.html）precached，装机那一次的旧 bundle
 * 会一直服务到 SW 更新为止；手机上没人会去「强制刷新」，旧版本可能挂很久。
 *
 * 这个模块只做两件事：
 *   1. 新版本**接管页面**时刷新一次（`controllerchange`）；
 *   2. 页面一直挂着时每小时问一次有没有新版本。
 *
 * ⚠️★ 内嵌态（`?embed=1`）**不装 SW**，并把已装过的注销掉（理由见下）。
 */
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import i18n from '@/i18n';

export const buildId = import.meta.env.__BUILD_ID__;

/**
 * 现在刷新会不会弄丢用户正在写的东西。
 * 两类都要看：**还没发出去的内容**（`app.send` 只在内存里）、**屏幕上正在编辑的输入框**。
 */
function hasUnsavedInput(): boolean {
    const app = useAppStore.getState();
    if (app.send.text || app.send.files.length) {
        return true;
    }
    const el = document.activeElement;
    const editing = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    return Boolean(editing && (el as HTMLInputElement).value);
}

export function setupServiceWorkerUpdate(): void {
    // dev 下 vite-plugin-pwa 不生成 sw.js（没开 devOptions），注册只会 404 报错
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
        return;
    }

    // ⚠️★ 宿主内嵌时不装 SW，顺手把已经装过的注销掉：内嵌态的收益是零（页面从本机 HTTP 取，
    // 离线没意义），风险是「界面永远旧」（precache 把 index.html 也缓存了，SW 没换新则界面不换）。
    // ⚠️ 只注销、**不删 `caches`** —— 从页面里删正在运行的旧 SW 的 precache 等于在它脚下抽梯子。
    if (useAppStore.getState().embedded) {
        navigator.serviceWorker
            .getRegistrations()
            .then((list) => list.forEach((registration) => registration.unregister()))
            .catch((error) => {
                console.error('Unregistering the service worker failed:', error);
            });
        return;
    }

    // 只有「本来就被某个 SW 控制着」才说明这是版本更替，不是首次安装
    const isVersionChange = Boolean(navigator.serviceWorker.controller);
    // 新版本已经接管，只是在等一个不会丢数据的时机
    let waitingForIdle = false;

    const reloadForNewVersion = () => {
        if (hasUnsavedInput()) {
            // 用户正在写东西：别抢。等输入框空了再换，或者等他下次自己打开页面。
            if (!waitingForIdle) {
                waitingForIdle = true;
                toast(i18n.t('newVersionReady'));
            }
            return;
        }
        window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (isVersionChange) {
            reloadForNewVersion();
        }
    });

    // 输入框空了（消息发出去了、编辑器关了）→ 补上那次没刷成的刷新。
    // ⚠️ 对应 Vue 版的 `watch(hasUnsavedInput, ...)`：Zustand 下用 store 订阅。
    useAppStore.subscribe(() => {
        if (waitingForIdle && !hasUnsavedInput()) {
            window.location.reload();
        }
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('./sw.js', { scope: './', updateViaCache: 'none' })
            .then((registration) => {
                // 页面一直开着时定期找更新 —— 长开的标签页 / 手机 PWA 没有导航事件。
                setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
            })
            .catch((error) => {
                console.error('Service worker registration failed:', error);
            });
    });
}
