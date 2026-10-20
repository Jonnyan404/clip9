/**
 * 前端的两份「基准目录」，**别混**：
 *
 * | 常量 | 是什么 | 谁在用 |
 * |---|---|---|
 * | `APP_BASE` / `APP_BASE_URL` | **这份前端自己**在哪（页面目录） | 路由 `basename`、静态资源、分享页面的前半截 |
 * | `API_BASE_URL` | **后端**在哪（接口与 WebSocket 的根） | axios 的 baseURL、WS 地址 |
 *
 * ⚠️★ 同源部署（默认，也是绝大多数情况）时两者**相等** —— 服务端自己渲染这份前端，
 * 接口就在同一个 origin 下。而**前后端分离部署**时它们不同：页面在 CDN / 静态托管上，
 * 接口在另一台机器上，这时 `API_BASE_URL` 由 `window.__CLIP9_API_BASE__`
 * （`public/config.js`，托管方可改）或用户界面里存的地址决定。
 *
 * ⚠️★ 路由与静态资源**永远**跟 `APP_BASE` 走，不能跟 API 走：把 `basename` 指到后端
 * 会让「页面地址」变成接口地址 —— 那是一个连页面都打不开的部署。
 *
 * ⚠️ `APP_BASE` 这个模块必须在 router 之前被求值：`createBrowserRouter(..., { basename })` 用它的值。
 * 值来自 `document.baseURI`：
 *   - 服务端在 `/s/<token>` 这类**深路径**上会注入 `<base href="<prefix>/">`（见 rust/crates/server/src/spa_shell.rs），
 *     否则外壳里 `./assets/…` 会按 `/clip/s/` 去解析，整套资源 404；
 *   - 根路径（`<prefix>/`）本来就不需要注入，因为文档目录就是 `<prefix>/`；
 *   - dev 由 vite.config.ts 注入 `<base href="/">`（dev 没有 prefix）。
 *
 * 为什么不用 `import.meta.env.BASE_URL`：那是**构建期**常量（本项目 `base: ''`），而 prefix 是
 * **运行时**配置（服务端 `-prefix`）——同一个产物要能部署在任意子路径下。
 */
function resolveAppBase(): string {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return '/';
    }
    try {
        const base = new URL(document.baseURI, window.location.origin);
        return base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    } catch {
        return '/';
    }
}

/** 路径形式（`/clip/`、`/`）——给 React Router 的 `basename` 用（调用方负责去掉结尾斜杠） */
export const APP_BASE = resolveAppBase();

/** 绝对形式（`https://host/clip/`）——给静态资源地址与 `new URL(path, base)` 用 */
export const APP_BASE_URL = typeof window === 'undefined'
    ? APP_BASE
    : new URL(APP_BASE, window.location.origin).href;

/** 「**当前在用**的后端地址」的本地存储键（空/没有 = 用 `config.js` 或同源）。 */
export const API_BASE_STORAGE_KEY = 'clip9ApiBase';

/**
 * 「**保存过的后端地址列表**」（JSON 数组，`{name, url}`）—— 多后端切换用。
 *
 * ⚠️★ 为什么是**两个**键而不是一个对象：`API_BASE_URL` 在模块求值时就要定下来（axios 与
 * 路由都依赖它），而「列表」只有设置页用。把当前值放在单独的键里，`config.js` / 同源
 * 那些既有路径就完全不用知道「列表」这回事；坏掉的列表（手改 localStorage）也只影响设置页，
 * 不会让整页连不上后端。
 */
export const API_BASE_LIST_KEY = 'clip9ApiBases';

/** 一个保存过的后端。`name` 只用于显示（空 = 用主机名）。 */
export interface SavedApiBase {
    name: string;
    url: string;
}

/** 列表最多留几条 —— 它是给人**切换**用的，不是收藏夹。超了丢最旧的（追加时）。 */
export const API_BASE_LIST_MAX = 12;

/**
 * 把「用户/部署方填的后端地址」归一成 `https://host[:port][/path]/`；不是个能用的地址就回 `null`。
 *
 * ⚠️★ **必须带协议**：`new URL('clip.example.com', location.href)` 会把裸主机名当成
 * **同源下的一个路径**（`https://page/clip.example.com/`），于是每个请求都 404，
 * 而配置看起来「填了」。所以这里显式要求 `http(s)://` 开头，不合规就当没填（并在控制台说一句）。
 *
 * ⚠️ 查询串与片段一律丢掉：base 不是一条链接，带上它们会给**每个**请求挂一截尾巴。
 */
export function normalizeApiBase(raw: unknown): string | null {
    const text = String(raw ?? '').trim();
    if (!text || !/^https?:\/\//i.test(text)) {
        return null;
    }
    try {
        const url = new URL(text);
        url.search = '';
        url.hash = '';
        if (!url.pathname.endsWith('/')) {
            url.pathname += '/';
        }
        return url.href;
    } catch {
        return null;
    }
}

/** 读用户存下的覆盖值（隐私模式下 localStorage 会抛，别让它把整页拖死）。 */
function readStoredApiBase(): string {
    try {
        return localStorage.getItem(API_BASE_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

/**
 * 显示用的名字：`https://api.example.com/clip/` → `api.example.com`。
 *
 * ⚠️ 带上路径（`api.example.com/clip`）是有意的：同一个域名下不同子路径是**两个**后端，
 * 只显示主机名会让列表里出现两行一模一样的东西，切换起来完全靠猜。
 */
export function apiBaseLabel(url: string): string {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.host}${path}`;
    } catch {
        return url;
    }
}

/**
 * 读保存过的后端列表。
 *
 * ⚠️★ 这里对**坏数据一律宽容**（回空列表），不抛：这个函数在设置页渲染时调用，
 * 抛出去就是整页白屏 —— 而用户能自己修的东西（清 localStorage）不该被一屏白挡着。
 * 同理，列表里不合规的条目**逐条丢弃**，别一条坏的把整份列表作废。
 */
export function readSavedApiBases(): SavedApiBase[] {
    let raw: unknown;
    try {
        raw = JSON.parse(localStorage.getItem(API_BASE_LIST_KEY) || '[]');
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: SavedApiBase[] = [];
    for (const item of raw) {
        // 兼容「只存了字符串」的写法（手改 localStorage 时很常见）。
        const url = normalizeApiBase(typeof item === 'string' ? item : (item as SavedApiBase)?.url);
        if (!url || out.some((saved) => saved.url === url)) {
            continue;
        }
        const name = typeof item === 'object' && item ? String((item as SavedApiBase).name || '') : '';
        out.push({ name: name.trim().slice(0, 40), url });
    }
    return out.slice(0, API_BASE_LIST_MAX);
}

/** 写回列表。写不进去（隐私模式 / 配额满）就安静放弃 —— 调用方紧接着会整页 reload。 */
export function writeSavedApiBases(list: SavedApiBase[]): void {
    try {
        localStorage.setItem(API_BASE_LIST_KEY, JSON.stringify(list.slice(0, API_BASE_LIST_MAX)));
    } catch {
        /* 忽略：下一句是 reload，写不进去也只是这条没记住 */
    }
}

/** 当前选中的那个（归一化后的 URL；空串 = 「默认」，即 `config.js` / 同源）。 */
export function readActiveApiBase(): string {
    return normalizeApiBase(readStoredApiBase()) || '';
}

/** 切到某个后端。传空串 = 回到「默认」。 */
export function writeActiveApiBase(url: string): void {
    try {
        const normalized = normalizeApiBase(url);
        if (normalized) {
            localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
        } else {
            localStorage.removeItem(API_BASE_STORAGE_KEY);
        }
    } catch {
        /* 同上 */
    }
}

/**
 * 解析后端地址。优先级：**嵌在 iframe 里？ → 直接同源** > `config.js` > 用户设置 > 同源。
 *
 * ⚠️★ 为什么 iframe 里要**忽略**覆盖值：桌面客户端把这份前端嵌在自己的网页视图里
 * （`services/hostBridge.ts`），而它连的是**本机**那个服务端。在那儿改了后端地址，
 * 网页视图会静默变成「另一个服务端的数据」，而桌面自己的列表还是本机的 —— 两边对不上，
 * 且没有任何提示。要连远程服务端请用桌面端自己的配置，或者在浏览器里打开网页版。
 */
function resolveApiBase(): string {
    if (typeof window === 'undefined') {
        return APP_BASE_URL;
    }
    try {
        if (window.self !== window.top) {
            return APP_BASE_URL;
        }
    } catch {
        // 跨源父窗口读 `window.top` 会抛 —— 那正说明被嵌着，按同源处理。
        return APP_BASE_URL;
    }

    for (const [source, raw] of [
        ['config.js', window.__CLIP9_API_BASE__],
        ['本机设置', readStoredApiBase()],
    ] as const) {
        const normalized = normalizeApiBase(raw);
        if (normalized) {
            return normalized;
        }
        // ⚠️ 配了但用不了 → **说出来**。静默回落成同源的话，用户会以为填的值生效了，
        // 而症状是「所有接口都打到页面所在的域名上」，与「填错了」看起来毫无关系。
        if (String(raw ?? '').trim()) {
            console.warn(
                `[clip9] ${source} 里的后端地址用不了（要写成完整的 http(s)://host[:port][/path]）：` +
                    JSON.stringify(raw),
            );
        }
    }
    return APP_BASE_URL;
}

/** 后端根地址的绝对形式（总带结尾斜杠）——axios 的 baseURL、WS 地址都从它拼 */
export const API_BASE_URL = resolveApiBase();
