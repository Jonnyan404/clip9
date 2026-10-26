/**
 * axios 全局配置与拦截器 —— 从 web-vue3/src/store/interop.js + main.js 的两行移植。
 *
 * ⚠️★ 与 Vue 版一致：配置的是**默认 axios 实例**（不是新建实例），因为全站的接口调用
 * 都写成 `axios.get('content')` / `axios.post('text')`（相对路径、不带前导斜杠）。
 * 换成自建实例就得改所有调用点，且容易漏。
 *
 * ⚠️★ baseURL 用 **`API_BASE_URL`**（后端在哪），**不是** `APP_BASE_URL`（页面在哪）：
 * 同源部署时两者相等；前后端分离部署时页面在 CDN 上、接口在另一台机器上，
 * 用页面地址当 baseURL 会让**每一条**接口都打到静态托管那边去（拿到一份 HTML，
 * 前端只会报「未知错误」）。见 `lib/base.ts` 里那张表。
 *
 * ⚠️ 必须在**任何请求之前**执行（main.tsx 的引导第一步）。
 */
import axios from 'axios';
import { API_BASE_URL } from '@/lib/base';
import { getClientId } from '@/lib/util';
import { useWebSocketStore } from '@/stores/wsStore';

/**
 * 所有**写**请求的 query：`?room=` + `?client=`。
 *
 * ⚠️★ `client` **不是可选的调味**：服务端拿它填 `senderClientID`，而「这条是不是我发的」
 * 全靠那一个值（桌面端的左右分栏就是比它）。少一个参数的后果不会报错 ——
 * 消息照发、界面照显示，只是自己发的东西被当成别的设备发的。
 *
 * ⚠️ 为什么抽成一个函数：这条规矩在 2026-10-26 之前**每处各写一遍**，于是同一个
 * `sendFiles` 里四个请求有三种写法（整份上传带、分片初始化不带、收尾带），
 * 而**没人能一眼看出少了哪一个**。现在只有一种写法可写。
 *
 * ⚠️ 分片的中间那几个（`upload/chunk/{uuid}`）服务端其实不读 `client`，但照样带上：
 * 「哪些请求要带」这件事不该是一条需要背下来的规则，否则下一个加请求的人一定会漏。
 */
export function writeParams(room: string, client = getClientId(), extra?: Record<string, string>): URLSearchParams {
    const params = new URLSearchParams([['room', room ?? ''], ['client', client]]);
    for (const [key, value] of Object.entries(extra ?? {})) {
        params.set(key, value);
    }
    return params;
}

export function setupAxios(): void {
    // ⚠️★ 全部接口调用都用**相对路径**，而 history 模式下文档目录不再是 `<prefix>/`：
    // 分享页地址是 `<prefix>/s/<token>`，相对路径会被解析成 `<prefix>/s/share`。
    // 统一给 axios 一个绝对 baseURL（= 后端的基准目录）。
    axios.defaults.baseURL = API_BASE_URL;

    axios.interceptors.request.use((config) => {
        if (!config.headers) {
            config.headers = {} as never;
        }
        const ws = useWebSocketStore.getState();
        if (!config.headers.Authorization) {
            const token = ws.getRequestAuthToken(config);
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
        }
        return config;
    });

    axios.interceptors.response.use(
        (response) => response,
        (error) => {
            const status = error && error.response ? error.response.status : 0;
            const config = error && error.config ? error.config : {};
            if (status === 401 && !config.__skipRoomAuthHandling) {
                useWebSocketStore.getState().handleHttpUnauthorized(config);
            }
            return Promise.reject(error);
        },
    );
}
