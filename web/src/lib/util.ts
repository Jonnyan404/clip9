/**
 * 框架无关的工具函数。
 *
 * ⚠️ 这一层（`src/lib/`）**不许 import React / MUI / 路由**：它同时要被
 *   ① 网页版、② 桌面端（经 tools/sync-action-catalog.mjs 字节同步）、③ 未来的共享包复用。
 *
 * Phase 1 只搬了 store 初值需要的那一个；其余纯函数（prettyFileSize / formatTimestamp /
 * filePreviewKind / errorMessage / …）在 Phase 2 从 web-vue3/src/util.js 继续移植。
 */

/**
 * 从地址里读一个 query 参数。**开局读一次**用（store 的初值），不订阅后续变化。
 *
 * 这个 app 是 **history 路由**，参数就在 search 里（`http://host/?mode=board`）——
 * 外部链接、书签、站内切换都是这一种写法。fragment 不参与（老 hash 地址已不兼容）。
 *
 * 为什么不用 `useSearchParams()`：store 的初值要在**第一次渲染之前**定下来，
 * 而路由解析是异步的 —— 那时候定不了，会先按旧值渲染一帧再跳，模式差异大的话就是一次可见的闪烁。
 */
export function readLocationParam(key: string): string {
    const name = String(key || '');
    if (!name || typeof window === 'undefined') {
        return '';
    }
    return new URLSearchParams(window.location.search).get(name) || '';
}
