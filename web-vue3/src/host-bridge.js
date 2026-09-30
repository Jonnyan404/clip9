// 嵌入态（桌面端把网页版塞进 iframe）的**宿主消息通道** —— 收父窗口的 postMessage，
// 转成这个页面自己的那两个动作。
//
// # ⚠️ 为什么需要它
//
// 桌面端的「网页」视图是**跨源 iframe**（父页面在 `tauri://`，这个页面在 `http(s)://`）：
// 宿主**碰不到**这里面的任何东西 —— 改不了 `app.dark`、也调不了 `navigateToRoom`。
// 唯一能过去的只有 postMessage。没有这条通道，宿主每换一次房间或主题就只剩一条路：
// **重设 `iframe.src`**，而那是**整页重载**（WebSocket 重连、界面跳一下、历史重新拉）。
//
// ⚠️★ 所以这条通道的价值不是「少写几行」，而是把「切房间 / 切主题」从**换一个页面**
// 降级成**这个页面自己换个房间** —— 而后者在 SPA 内部本来就不重载
//（`navigateToRoom` 只 `router.replace` 改地址，`app.dark` 只有一个 watch 落
// localStorage 再调 `theme.change()`，两处都不刷新）。
//
// # 协议
//
// 宿主 → 页面：
//   { type: 'clip9:room',  room: string }            → 切成这个房间（空串 = 公共房间）
//   { type: 'clip9:theme', theme: 'dark' | 'light' } → 深浅色
//   { type: 'clip9:ping' }                           → 探活
//
// 页面 → 宿主（只在收到 ping 之后回一条）：
//   { type: 'clip9:hello', protocol: number, room: string }
//
// ⚠️★ `protocol` 是**协议版本**，它是宿主判断「这个页面能不能被消息驱动」的**第二条**判据：
// 第一条是 `index.html` 里那个 `<meta name="clip9-web">`（宿主在**加载之前**读它，
// 决定要不要去嵌）。老版本的前端两条都没有 —— 两处一起改，别只改一处。
//
// # 安全
//
// ⚠️★ 只认 `event.source === window.parent`：别的窗口（同源的另一个标签页、
// 这个页面里再嵌的第三方 iframe）不该能指挥它。
// ⚠️ 刻意**不校验** `event.origin`：宿主的父页面在每个平台上的 origin 都不一样
//（macOS 是 `tauri://localhost`、Windows 是 `http://tauri.localhost`…），钉死一个
// 等于把其余平台全拒掉。⚠️ 这条通道能做的只有「切房间 / 切主题」，都发生在用户自己
// 那台机器上，风险不落在这一层 —— **别往协议里加会改数据的能力**（那样这个取舍就变了）。
//
// ⚠️ 只在**嵌入态**生效（`?embed=1`）：非嵌入态直接返回 `null`、一个监听都不装 ——
// 普通浏览器里这个页面没有父窗口，装了也只是多一个永远不会触发的监听。
// ⚠️ 由 `main.js` 在 `router.isReady()` 之后、**分享页提前 return 的那条分岔之后**调 ——
// 于是分享页天然装不上（它不建 WS、不碰房间，让它接受「切房间」只会把状态搅乱）。

import { readLocationParam } from './util.js';
import { useAppStore } from './store/app';
import { useWebSocketStore } from './store/websocket';

/** 宿主协议版本。⚠️ 改消息形状时要**一起**改 `index.html` 那个 meta 的 content。 */
export const HOST_PROTOCOL = 1;

/**
 * 装上游消息通道。返回一个句柄（方便调试与测试；页面活到老，不需要卸）。
 *
 * ⚠️ 必须在 `app.use(pinia)` 之后调 —— 里面要读 store。
 *
 * @returns {{ protocol: number } | null} 非嵌入态返回 `null`（没装）
 */
export function installHostBridge() {
    // 非嵌入态：这个页面不是被嵌进来的，没有宿主可谈（见文件头）。
    if (readLocationParam('embed') !== '1') {
        return null;
    }

    const ws = useWebSocketStore();
    const app = useAppStore();

    /** 往父窗口回话。
     *
     * ⚠️ 目标 origin 用 `'*'`：父页面各平台 origin 不同（见文件头），而这条消息里
     * 只有房间名与协议号，没有凭据 —— 收窄它换不来安全，只会换掉一两个平台。
     * ⚠️ 不是被嵌进来的时候（`window.parent === window`）直接不发：那种情况下
     * `postMessage` 会把消息发给自己，白转一圈。
     */
    const post = (payload) => {
        if (window.parent === window) return;
        window.parent.postMessage(payload, '*');
    };

    window.addEventListener('message', (event) => {
        // ⚠️★ 只认父窗口（理由见文件头「安全」那段）。
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        switch (data.type) {
            case 'clip9:room': {
                const room = typeof data.room === 'string' ? data.room : '';
                // ⚠️★ 走 SPA 自己的 `navigateToRoom`（与用户在侧栏点一下是**同一条路**）：
                // 它带鉴权判断 —— 受保护的房间会弹出这里自己的密码框。
                // ⚠️ **不要**改用 `switchRoom`：那个跳过鉴权，宿主递一个受保护的房间名
                // 就等于绕过了密码（而宿主那份凭据是客户端配置里的，不是这个页面的）。
                ws.navigateToRoom(room).catch(() => {});
                break;
            }
            case 'clip9:theme': {
                // ⚠️ 落点与 `main.js` 里读 `?theme=` 那次是**同一个字段**（`app.dark`）：
                // URL 那次管「刚加载」，这条管「之后每一次」。两处写同一个字段，所以不会漂。
                if (data.theme === 'dark') {
                    app.dark = 'enable';
                } else if (data.theme === 'light') {
                    app.dark = 'disable';
                }
                break;
            }
            case 'clip9:ping': {
                post({ type: 'clip9:hello', protocol: HOST_PROTOCOL, room: ws.room });
                break;
            }
            default:
                break;
        }
    });

    return { protocol: HOST_PROTOCOL };
}
