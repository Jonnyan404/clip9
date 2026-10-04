/**
 * 框架无关的工具函数 —— 从 web-vue3/src/util.js 移植。
 *
 * ⚠️ 这一层（`src/lib/`）**不许 import React / MUI / 路由**：它同时要被
 *   ① 网页版、② 桌面端（经 tools/sync-action-catalog.mjs 字节同步）、③ 未来的共享包复用。
 * ⚠️ 与 `lib/markdown.js` 的分工：依赖 marked / DOMPurify 的 `renderMarkdownHtml` 在那边。
 */
import { APP_BASE_URL } from './base';
import { looksLikeTable, looksLikeTaskList } from './actions/pure.js';

// 这些**纯函数**住在 `actions/pure.js`（零 import，两端共用）—— 这里只是再导出一次，
// 让调用点（`import { looksLikeTable } from '@/lib/util'`）保持与 Vue 版一致的写法。
export {
    decodeHtmlEntities,
    formatJson,
    looksLikeCode,
    looksLikeMarkdown,
    looksLikeTable,
    looksLikeTaskList,
    minifyJson,
} from './actions/pure.js';

// 分享的限额与形状住在 `share-config.js`（零 import，两端共用）—— 同样只转出来。
export {
    SHARE_DEFAULT_TTL,
    SHARE_DEFAULT_TTL_MINUTES,
    SHARE_MAX_TTL,
    SHARE_MAX_TTL_MINUTES,
    SHARE_MAX_USES_LIMIT,
    SHARE_MIN_TTL,
    SHARE_MIN_TTL_MINUTES,
    SHARE_TTL_PRESET_MINUTES,
    formatShareDuration,
    minutesToShareTTL,
    normalizeShareMaxUses,
    normalizeShareTTL,
    shareTtlProgress,
} from './share-config.js';

export function prettyFileSize(size: number): string {
    const units = ['TB', 'GB', 'MB', 'KB'];
    let unit = 'Bytes';
    while (size >= 1024 && units.length) {
        size /= 1024;
        unit = units.pop() as string;
    }
    return `${Math.floor(100 * size) / 100} ${unit}`;
}

export function percentage(value: number, decimal = 2): string {
    return `${(value * 100).toFixed(decimal)}%`;
}

export function formatTimestamp(timestamp?: number): string {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    // 返回更详细的日期和时间格式，例如: YYYY-MM-DD HH:mm:ss
    return date.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
}

/**
 * 构建不带房间密码的绝对 URL。
 * 分享/下载鉴权应使用服务端签发的短期 token（?t=），而不是 ?auth= 房间密码。
 */
export function buildCleanAbsoluteRouteUrl(path: string, prefix = ''): string {
    const normalizedPath = String(path || '').replace(/^\/+/, '');
    return new URL(`${prefix}/${normalizedPath}`, `${window.location.origin}/`).toString();
}

/**
 * 应用内**静态资源**的绝对地址：相对「应用基准目录」而不是相对 `config.server.prefix`。
 *
 * ⚠️★ `config.server.prefix` **只能从 WebSocket 握手的 `config` 事件拿到**，所以在
 * 「应用还没连上」的那一刻它是空串。任何**在那一刻就要用**的地址都不能依赖它 ——
 * 否则拼出来是 `/shortcuts/meta.json`，而 `/clip` 部署下正确地址是
 * `/clip/shortcuts/meta.json` → **404**，而且往往还被 `catch` 吞掉，只表现为
 * 「某块内容静默不见了」。
 */
export function buildAppUrl(path: string): string {
    return new URL(String(path || '').replace(/^\/+/, ''), APP_BASE_URL).href;
}

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

/**
 * 把服务端给的分享页地址**换成本浏览器自己的 origin**（保留它的路径与 `#` 片段）。
 *
 * 为什么必须换：服务端是用**请求的 Host** 拼这个地址的。而分享页是**前端路由**，
 * 它得落在前端所在的 origin 上 —— 只要中间有一层会改写 Host 的代理，服务端拼出来的主机就是错的。
 */
export function withCurrentOrigin(url: string): string {
    const raw = String(url || '');
    if (!raw || typeof window === 'undefined') {
        return raw;
    }
    const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i);
    return m ? window.location.origin + (m[1] || '/') : raw;
}

/**
 * 往分享地址上补「这是扫码进来的」（q=1）—— 给二维码那个地址专用。
 * 扫码和点链接打开的是**同一个页面**，服务端分不出来，只有地址上带了这个参数，
 * 分享页上报时才能告诉服务端「这次是扫过来的」。
 */
export function withShareQrFlag(url: string): string {
    const raw = String(url || '');
    if (!raw) {
        return raw;
    }
    const queryIndex = raw.indexOf('?');
    const head = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex < 0 ? '' : raw.slice(queryIndex + 1));
    params.set('q', '1');
    return `${head}?${params.toString()}`;
}

export function copyTextToClipboard(textToCopy: string): Promise<void> {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(textToCopy);
    }
    return new Promise((resolve, reject) => {
        try {
            const textArea = document.createElement('textarea');
            textArea.value = textToCopy;
            textArea.style.position = 'absolute';
            textArea.style.left = '-9999px';
            document.body.appendChild(textArea);
            textArea.select();
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (successful) {
                resolve();
            } else {
                reject(new Error('execCommand copy failed'));
            }
        } catch (err) {
            reject(err);
        }
    });
}

const CLIENT_ID_KEY = 'ccgDeviceId';

export function getClientId(): string {
    try {
        let id = localStorage.getItem(CLIENT_ID_KEY);
        if (!id) {
            id = (globalThis.crypto && typeof crypto.randomUUID === 'function')
                ? crypto.randomUUID()
                : `ccg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            localStorage.setItem(CLIENT_ID_KEY, id);
        }
        return id;
    } catch {
        return '';
    }
}

export interface SenderDevice {
    name?: string;
    os?: string;
    type?: string;
}

// 设备显示名：客户端声明的 name 优先，没有才回落 UA 推断出的 os / type。
export function deviceLabel(senderDevice?: SenderDevice | null, fallback = ''): string {
    if (!senderDevice) {
        return fallback;
    }
    return senderDevice.name || senderDevice.os || senderDevice.type || fallback;
}

/**
 * 这条消息是不是**定时任务**发的。
 * 服务端在 `deliverMessage` 里给定时投递的消息打上 `source: 'automation'`，人发的该字段为空。
 *
 * ⚠️ 判定**只写这一处**。各模式的呈现方式不同，但「是不是定时消息」必须是同一个答案。
 */
export function isAutomationMessage(meta?: { source?: string } | null): boolean {
    return meta?.source === 'automation';
}

/** 这条定时消息是不是「错过触发窗口后补发」的（服务端只在超出补发窗口时才置 `late`）。 */
export function isLateMessage(meta?: { late?: boolean } | null): boolean {
    return Boolean(meta?.late);
}

/**
 * 从 axios 错误里取出「给人看」的文案。
 * 服务端统一返回 { code, error, message }：message 是中文人话，error 是英文人话。
 * 优先用 message，退回 error。纯文本/HTML 就截断后原样兜出来 —— 总比只显示一句泛化的「失败」强。
 */
export function errorMessage(error: unknown): string {
    const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
    if (!data) return '';
    if (typeof data === 'string') return data.trim().slice(0, 200);
    const obj = data as { message?: unknown; error?: unknown };
    return String(obj.message || obj.error || '');
}

/**
 * 这条内容**默认**该看渲染视图，还是原文。
 *
 * 这是「默认值」的**唯一**判断处，标准模式卡片、便签阅读器、速览预览、看板卡片都走它 ——
 * 各写一套的话，同一条内容在不同界面里长相不同，用户没法预期。
 * 规则：任务列表和表格默认渲染，其余默认原文。
 */
export function prefersRenderedView(text: string): boolean {
    return Boolean(looksLikeTaskList(text) || looksLikeTable(text));
}

/**
 * 翻转第 `index` 个任务列表项（`- [ ]` ↔ `- [x]`），返回新文本。
 * 按**渲染顺序**数，和页面上复选框的顺序一一对应。越界就原样返回，不抛错。
 */
export function toggleTaskListItem(text: string, index: number): string {
    let seen = 0;
    return String(text || '').replace(
        /(^|\n)(\s{0,3}(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/g,
        (match, lead, prefix, mark, close) => {
            if (seen++ !== index) return match;
            return lead + prefix + (mark === ' ' ? 'x' : ' ') + close;
        },
    );
}

// 文件名是不是图片。**全站唯一实现** —— 判型只看扩展名，不看内容：
// 服务端不嗅探、客户端也不该嗅探，两边同一套标准。
const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export function isImageName(name?: string): boolean {
    return IMAGE_NAME_RE.test(String(name || ''));
}

// 文件条目「能不能就地预览、该按哪一类渲染」—— **全站唯一实现**。
// 返回 `'image' | 'video' | 'audio' | 'text'`，不预览时返回 `''`（调用方退回图标）。
const VIDEO_NAME_RE = /\.(mp4|webm|ogv|mov)$/i;
const AUDIO_NAME_RE = /\.(mp3|wav|ogg|opus|m4a|flac)$/i;
const TEXT_NAME_RE = /\.(txt|text|md|markdown|json|log|csv|tsv|ya?ml|xml|ini|conf|cfg|toml|properties|env|gitignore|dockerfile|js|jsx|mjs|cjs|ts|tsx|vue|css|scss|sass|less|html|htm|sql|sh|bash|zsh|fish|ps1|bat|cmd|go|py|java|kt|kts|rb|php|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|proto)$/i;

export type FilePreviewKind = 'image' | 'video' | 'audio' | 'text' | '';

export function filePreviewKind(name?: string): FilePreviewKind {
    const value = String(name || '');
    if (!value) {
        return '';
    }
    if (isImageName(value)) {
        return 'image';
    }
    if (VIDEO_NAME_RE.test(value)) {
        return 'video';
    }
    if (AUDIO_NAME_RE.test(value)) {
        return 'audio';
    }
    if (TEXT_NAME_RE.test(value)) {
        return 'text';
    }
    return '';
}
