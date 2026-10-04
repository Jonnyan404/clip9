/**
 * WebSocket 连接、鉴权、房间与消息合并 —— 从 web-vue3/src/store/websocket.js 移植。
 *
 * ⚠️★ 与 Vue 版的**唯一结构性差异**：定时器（心跳 / ping / token 刷新 / 收件合帧）放在
 * **模块级变量**里，而不是 store state。React 严格模式下 effect 会双调用，把定时器放进
 * 响应式 state 很容易被重复创建、或随组件卸载被误清；集中在模块级、由本模块独占管理最稳。
 *
 * ⚠️★ 首次连接**不要**写在组件的 useEffect 里（开发期会连两次）。由 main.tsx 引导阶段调
 * `useWebSocketStore.getState().connect()`（与 Vue 版 `router.isReady().then(connect)` 对齐），
 * 且 `connect()` 自身幂等（`websocketConnecting` 守卫）。
 */
import { create } from 'zustand';
import axios from 'axios';
import { router, isShareRoute } from '@/router';
import { APP_BASE_URL } from '@/lib/base';
import { useAppStore, type AppConfig, type ReceivedItem } from './appStore';

const ROOM_AUTH_CACHE_KEY = 'roomAuthCache';
const DEFAULT_ROOM_KEY = '__default__';
const GLOBAL_ROOM_KEY = '__global__';

/**
 * 原生外壳交给页面的那个对象名。
 * ⚠️★ 必须与 `WebAppActivity.AUTH_BRIDGE`（以及 `AuthBridge.roomAuth()` 这个方法名）
 * **逐字一致**。对不上的症状是**什么都没发生** —— 不报错、不提示，只是又被问了一次密码。
 */
const NATIVE_AUTH_BRIDGE = 'clip9Auth';

/** 房间鉴权缓存的条目：新格式是对象（带过期），老格式是裸字符串（视为不过期）。 */
export type RoomAuthEntry = string | { token: string; expiresAt: number };

interface NativeAuthBridge {
    roomAuth?: () => string;
}

/**
 * 问一次原生外壳：有没有**已经换好的**房间凭据。
 * ⚠️ 浏览器里没有这个对象（不是 Android 壳），那就当没有 —— 这条路是**加分项**。
 */
function readNativeRoomAuth(): Record<string, RoomAuthEntry> {
    try {
        const bridge = (typeof window !== 'undefined' ? (window as unknown as Record<string, NativeAuthBridge>)[NATIVE_AUTH_BRIDGE] : null);
        if (!bridge || typeof bridge.roomAuth !== 'function') {
            return {};
        }
        const raw = bridge.roomAuth();
        if (!raw || typeof raw !== 'string') {
            return {};
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function loadRoomAuthCache(): Record<string, RoomAuthEntry> {
    let fromSession: Record<string, RoomAuthEntry> = {};
    try {
        const raw = sessionStorage.getItem(ROOM_AUTH_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                fromSession = parsed;
            }
        }
    } catch {
        fromSession = {};
    }
    // ⚠️★ 外壳给的那一份**盖在上面**：它是**刚刚**用密码换出来的，而 sessionStorage 里那份
    // 可能是上一次会话留下的、服务端早已不认的旧令牌。
    return { ...fromSession, ...readNativeRoomAuth() };
}

// ── 定时器（模块级，见文件头）────────────────────────────────────────────
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let receiveFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReceiveQueue: unknown[] = [];

function normalizeRoomName(room = ''): string {
    const normalized = (room || '').trim();
    return normalized === 'default' ? '' : normalized;
}

/** 房间名 → 地址栏 search（空串 = 公共房间，不写参数）。 */
function roomHref(room: string): string {
    const params = new URLSearchParams();
    if (room) {
        params.set('room', room);
    }
    const search = params.toString();
    return search ? `/?${search}` : '/';
}

interface WsState {
    websocket: WebSocket | null;
    websocketConnecting: boolean;
    authCode: string;
    inputPassword: string;
    authCodeDialog: boolean;
    authPendingRoom: string;
    authCodeError: string;
    authDialogLoading: boolean;
    roomAuthCache: Record<string, RoomAuthEntry>;
    roomProtectionCache: Record<string, boolean>;
    room: string;
    roomInput: string;
    roomDialog: boolean;
    retry: number;
    latency: number | null;

    initFromRoute: (roomQuery: string) => void;
    normalizeRoomName: (room?: string) => string;
    getRoomStorageKey: (room?: string) => string;
    persistRoomAuthCache: () => void;
    getGlobalAuthToken: () => string;
    getEffectiveAuthEntry: (room?: string) => { token: string; expiresAt: number; key: string } | null;
    getAuthTokenForRoom: (room?: string) => string;
    cacheAuthTokenForRoom: (room: string, token: string, expiresAt?: number) => void;
    clearAuthTokenForRoom: (room?: string) => void;
    getKnownAuthTokens: (room?: string) => string[];
    clearAuthRefreshTimer: () => void;
    setRoomProtection: (room: string, isProtected: boolean) => void;
    fetchServerInfo: (room?: string, opts?: { token?: string }) => Promise<Record<string, unknown>>;
    verifyRoomAccess: (room: string, token: string) => Promise<boolean>;
    openAuthDialog: (room: string, initialToken?: string) => void;
    resolveAuthTokenForRoom: (room: string, opts?: { interactive?: boolean }) => Promise<string | null>;
    obtainRoomSessionToken: (room: string, password: string) => Promise<{ token: string | null; expiresAt: number; scope: string } | null>;
    refreshRoomSessionToken: (room: string) => Promise<{ token: string | null; expiresAt: number; scope: string } | null>;
    scheduleAuthRefresh: (room?: string) => void;
    getWebSocketEndpoint: (room?: string) => string;
    connect: () => Promise<void>;
    syncRoomView: (targetRoom: string) => void;
    saveRoomCache: (room?: string) => void;
    flushPendingReceives: () => void;
    mergeMessages: (incomingItems: ReceivedItem[]) => void;
    queueReceive: (data: ReceivedItem) => void;
    loadHistoryFromHttp: (room?: string) => Promise<void>;
    handleEvent: (event: string, data: unknown) => void;
    disconnect: () => void;
    switchRoom: (targetRoom: string) => void;
    failure: () => void;
    handleHttpUnauthorized: (config?: { params?: unknown }) => void;
    getRequestRoom: (config?: { params?: unknown }) => string;
    getRequestAuthToken: (config?: { params?: unknown }) => string;
    navigateToRoom: (room: string) => Promise<boolean>;
    submitAuthCodeForPendingRoom: () => Promise<void>;
}

export const useWebSocketStore = create<WsState>((set, get) => ({
    websocket: null,
    websocketConnecting: false,
    authCode: '',
    inputPassword: '',
    authCodeDialog: false,
    authPendingRoom: '',
    authCodeError: '',
    authDialogLoading: false,
    roomAuthCache: loadRoomAuthCache(),
    roomProtectionCache: {},
    room: '',
    roomInput: '',
    roomDialog: false,
    retry: 0,
    latency: null,

    initFromRoute: (roomQuery) => set({ room: normalizeRoomName(roomQuery || '') }),

    /* ---------- 房间/鉴权工具 ---------- */
    normalizeRoomName,
    getRoomStorageKey: (room) => normalizeRoomName(room ?? get().room) || DEFAULT_ROOM_KEY,
    persistRoomAuthCache: () => {
        sessionStorage.setItem(ROOM_AUTH_CACHE_KEY, JSON.stringify(get().roomAuthCache));
    },
    getGlobalAuthToken: () => {
        const entry = get().roomAuthCache[GLOBAL_ROOM_KEY];
        if (typeof entry === 'string') {
            return entry;
        }
        if (entry && typeof entry === 'object' && typeof entry.token === 'string') {
            return entry.token;
        }
        return '';
    },
    getEffectiveAuthEntry: (room) => {
        const now = Math.floor(Date.now() / 1000);
        const cache = get().roomAuthCache;
        const read = (key: string) => {
            const entry = cache[key];
            if (typeof entry === 'string' && entry) {
                return { token: entry, expiresAt: 0, key };
            }
            if (entry && typeof entry === 'object' && typeof entry.token === 'string' && entry.token) {
                const expiresAt = Number(entry.expiresAt) || 0;
                if (expiresAt > 0 && expiresAt <= now) {
                    return null;
                }
                return { token: entry.token, expiresAt, key };
            }
            return null;
        };
        return read(get().getRoomStorageKey(room)) || read(GLOBAL_ROOM_KEY);
    },
    getAuthTokenForRoom: (room) => {
        const effective = get().getEffectiveAuthEntry(room);
        return effective ? effective.token : '';
    },
    cacheAuthTokenForRoom: (room, token, expiresAt = 0) => {
        const normalizedToken = (token || '').trim();
        const key = get().getRoomStorageKey(room);
        if (!normalizedToken) {
            get().clearAuthTokenForRoom(room);
            return;
        }
        const cache = { ...get().roomAuthCache };
        const existing = cache[key];
        const effectiveExpiresAt = Number(expiresAt) > 0
            ? Number(expiresAt)
            : (existing && typeof existing === 'object' && Number(existing.expiresAt) > 0 ? Number(existing.expiresAt) : 0);
        cache[key] = { token: normalizedToken, expiresAt: effectiveExpiresAt };
        set({ roomAuthCache: cache });
        get().persistRoomAuthCache();
        if (normalizeRoomName(room) === normalizeRoomName(get().room)) {
            set({ authCode: normalizedToken });
        }
        get().scheduleAuthRefresh(room);
    },
    clearAuthTokenForRoom: (room) => {
        const key = get().getRoomStorageKey(room);
        const cache = { ...get().roomAuthCache };
        if (Object.prototype.hasOwnProperty.call(cache, key)) {
            delete cache[key];
            set({ roomAuthCache: cache });
            get().persistRoomAuthCache();
        }
        if (normalizeRoomName(room ?? get().room) === normalizeRoomName(get().room)) {
            set({ authCode: '' });
            get().clearAuthRefreshTimer();
        }
    },
    getKnownAuthTokens: (room) => {
        const tokens: string[] = [];
        const push = (token: RoomAuthEntry | undefined) => {
            let value: unknown = token;
            if (token && typeof token === 'object' && typeof token.token === 'string') {
                value = token.token;
            }
            const normalized = String(value || '').trim();
            if (normalized && !tokens.includes(normalized)) {
                tokens.push(normalized);
            }
        };
        push(get().getAuthTokenForRoom(room));
        push(get().authCode);
        Object.values(get().roomAuthCache).forEach(push);
        return tokens;
    },
    clearAuthRefreshTimer: () => {
        if (authRefreshTimer) {
            clearTimeout(authRefreshTimer);
            authRefreshTimer = null;
        }
    },
    setRoomProtection: (room, isProtected) => {
        set({ roomProtectionCache: { ...get().roomProtectionCache, [normalizeRoomName(room)]: Boolean(isProtected) } });
    },
    fetchServerInfo: async (room, { token = '' } = {}) => {
        const response = await axios.get('server', {
            params: new URLSearchParams([['room', normalizeRoomName(room ?? get().room)]]),
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            __skipRoomAuthHandling: true,
        });
        if (Object.prototype.hasOwnProperty.call(response.data || {}, 'roomProtected')) {
            get().setRoomProtection(room ?? get().room, response.data.roomProtected);
        }
        return response.data;
    },
    verifyRoomAccess: async (room, token) => {
        if (!token) {
            return false;
        }
        const serverInfo = await get().fetchServerInfo(room, { token });
        return serverInfo.auth ? serverInfo.authorized === true : true;
    },
    openAuthDialog: (room, _initialToken = '') => {
        set({
            authPendingRoom: normalizeRoomName(room),
            roomDialog: false,
            inputPassword: '',
            authCodeError: '',
            authDialogLoading: false,
            authCodeDialog: true,
        });
    },
    resolveAuthTokenForRoom: async (room, { interactive = true } = {}) => {
        const normalizedRoom = normalizeRoomName(room);
        const cachedToken = get().getAuthTokenForRoom(normalizedRoom);
        if (cachedToken) {
            return cachedToken;
        }
        const serverInfo = await get().fetchServerInfo(normalizedRoom);
        if (!serverInfo.auth) {
            return '';
        }
        const candidates = get().getKnownAuthTokens(normalizedRoom);
        for (const token of candidates) {
            if (await get().verifyRoomAccess(normalizedRoom, token)) {
                return token;
            }
        }
        if (interactive) {
            get().openAuthDialog(normalizedRoom);
        }
        return null;
    },
    obtainRoomSessionToken: async (room, password) => {
        try {
            const response = await axios.post('auth/token', { password }, {
                params: new URLSearchParams([['room', normalizeRoomName(room)]]),
                __skipRoomAuthHandling: true,
            });
            const data = response.data || {};
            return {
                token: data.token || null,
                expiresAt: Number(data.expiresAt) || 0,
                scope: data.scope === 'global' ? 'global' : '',
            };
        } catch (error) {
            console.error('Failed to obtain session token:', error);
            return null;
        }
    },
    refreshRoomSessionToken: async (room) => {
        const normalizedRoom = normalizeRoomName(room);
        const currentToken = get().getAuthTokenForRoom(normalizedRoom);
        if (!currentToken) {
            return null;
        }
        try {
            const response = await axios.post('auth/token/refresh', null, {
                params: new URLSearchParams([['room', normalizedRoom]]),
                __skipRoomAuthHandling: true,
            });
            const data = response.data || {};
            return {
                token: data.token || null,
                expiresAt: Number(data.expiresAt) || 0,
                scope: data.scope === 'global' ? 'global' : '',
            };
        } catch (error) {
            console.error('Failed to refresh session token:', error);
            return null;
        }
    },
    scheduleAuthRefresh: (room) => {
        get().clearAuthRefreshTimer();
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        if (normalizedRoom !== normalizeRoomName(get().room)) {
            return;
        }
        const effective = get().getEffectiveAuthEntry(normalizedRoom);
        const token = effective ? effective.token : '';
        const expiresAt = effective ? effective.expiresAt : 0;
        if (!token || !expiresAt) {
            return;
        }
        const remainingSeconds = expiresAt - Math.floor(Date.now() / 1000);
        if (remainingSeconds <= 60) {
            return;
        }
        const delay = Math.max(0, Math.min((remainingSeconds - 60) * 1000, 24 * 60 * 60 * 1000));
        authRefreshTimer = setTimeout(async () => {
            authRefreshTimer = null;
            const refreshed = await get().refreshRoomSessionToken(normalizedRoom);
            if (refreshed && refreshed.token) {
                const cacheRoom = refreshed.scope === 'global' ? GLOBAL_ROOM_KEY : effective!.key;
                get().cacheAuthTokenForRoom(cacheRoom, refreshed.token, refreshed.expiresAt);
                get().scheduleAuthRefresh(normalizedRoom);
            } else {
                get().clearAuthTokenForRoom(normalizedRoom);
                if (normalizedRoom === normalizeRoomName(get().room)) {
                    get().openAuthDialog(normalizedRoom);
                }
            }
        }, delay);
    },

    getWebSocketEndpoint: (room) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // ⚠️ 必须用 APP_BASE_URL（从 `document.baseURI` 推导），**不能**用 config.server.prefix ——
        // 后者只能从 WS 握手的 `config` 事件拿到，而这里正是为了连上 WS 才拼地址（鸡生蛋）。
        const wsUrl = new URL('push', APP_BASE_URL);
        wsUrl.protocol = protocol;
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        if (normalizedRoom) {
            wsUrl.searchParams.set('room', normalizedRoom);
        }
        return wsUrl.toString();
    },

    /* ---------- 连接 ---------- */
    connect: async () => {
        if (get().websocketConnecting) {
            return;
        }
        set({ websocketConnecting: true });
        try {
            const currentRoom = normalizeRoomName(get().room);
            let resolvedToken: string | null = get().getAuthTokenForRoom(currentRoom);

            // 无论是否已缓存 token，都先探测 /server 以可靠获知房间是否需要认证。
            const serverInfo = await get().fetchServerInfo(currentRoom);
            if (!resolvedToken && serverInfo.auth) {
                resolvedToken = await get().resolveAuthTokenForRoom(currentRoom, { interactive: true });
                if (resolvedToken === null) {
                    set({ websocketConnecting: false });
                    return;
                }
            }

            const wsUrl = get().getWebSocketEndpoint(currentRoom);
            const protocols = resolvedToken ? [resolvedToken] : [];

            const ws = await new Promise<WebSocket>((resolve, reject) => {
                const socket = new WebSocket(wsUrl, protocols);
                socket.onopen = () => resolve(socket);
                socket.onerror = reject;
            });

            set({ websocket: ws, websocketConnecting: false, retry: 0 });
            set({ authCode: resolvedToken || get().getAuthTokenForRoom(currentRoom) });

            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
            }
            const heartbeat = () => {
                const socket = get().websocket;
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send('');
                }
            };
            heartbeatTimer = setInterval(heartbeat, 30000);

            const ping = () => {
                const socket = get().websocket;
                if (socket && socket.readyState === WebSocket.OPEN) {
                    try {
                        socket.send(JSON.stringify({ event: 'ping', data: Date.now() }));
                    } catch { /* 连接刚好断了就算了 */ }
                }
            };
            ping();
            pingTimer = setInterval(ping, 3000);

            ws.onclose = async () => {
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                set({ latency: null, websocket: null, websocketConnecting: false });
                useAppStore.setState({ device: [] });
                if (get().retry < 3) {
                    set({ retry: get().retry + 1 });
                    setTimeout(() => { void get().connect(); }, 3000);
                    return;
                }
                // 重试耗尽后，若服务器仍要求认证（可能因 token 失效/过期），
                // 清除本地 token 并弹出认证窗口，否则静默失败用户无法感知。
                try {
                    const info = await get().fetchServerInfo(get().room);
                    if (info.auth) {
                        get().clearAuthTokenForRoom(get().room);
                        get().openAuthDialog(get().room);
                    }
                } catch {
                    get().openAuthDialog(get().room);
                }
            };
            ws.onmessage = (e) => {
                try {
                    const parsed = JSON.parse(e.data);
                    get().handleEvent(parsed.event, parsed.data);
                } catch { /* 非 JSON 帧忽略 */ }
            };
        } catch {
            set({ websocketConnecting: false });
            get().failure();
        }
    },

    syncRoomView: (targetRoom) => {
        const app = useAppStore.getState();
        const normalizedRoom = normalizeRoomName(targetRoom);
        const cached = app.roomMessagesCache[normalizedRoom];
        if (cached && Array.isArray(cached)) {
            useAppStore.setState({ received: [...cached] });
        } else {
            useAppStore.setState({ received: [] });
        }
    },
    saveRoomCache: (room) => {
        const app = useAppStore.getState();
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        useAppStore.setState({
            roomMessagesCache: { ...app.roomMessagesCache, [normalizedRoom]: [...app.received] },
        });
    },
    flushPendingReceives: () => {
        if (receiveFlushTimer) {
            clearTimeout(receiveFlushTimer);
            receiveFlushTimer = null;
        }
        if (!pendingReceiveQueue.length) {
            return;
        }
        const newItems = pendingReceiveQueue.splice(0);
        get().mergeMessages(newItems as ReceivedItem[]);
    },
    mergeMessages: (incomingItems) => {
        if (!incomingItems || !incomingItems.length) {
            return;
        }
        const app = useAppStore.getState();
        const currentList = [...app.received];
        const existingIdMap = new Map<unknown, number>();
        currentList.forEach((item, index) => {
            existingIdMap.set(item.id, index);
        });

        for (const item of incomingItems) {
            if (existingIdMap.has(item.id)) {
                const idx = existingIdMap.get(item.id)!;
                currentList[idx] = { ...currentList[idx], ...item };
            } else {
                currentList.push(item);
            }
        }

        // 按时间倒序排列 (最新的排在最前)
        currentList.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

        // 如果有配置历史条数限制，进行截断
        const limit = Number(app.config?.server?.history || 0);
        if (limit > 0 && currentList.length > limit) {
            currentList.splice(limit);
        }

        useAppStore.setState({ received: currentList });
        get().saveRoomCache();
    },
    queueReceive: (data) => {
        pendingReceiveQueue.unshift(data);
        if (!receiveFlushTimer) {
            receiveFlushTimer = setTimeout(() => {
                get().flushPendingReceives();
            }, 32);
        }
    },
    loadHistoryFromHttp: async (room) => {
        const normalizedRoom = normalizeRoomName(room ?? get().room);
        try {
            const response = await axios.get('content', {
                params: new URLSearchParams([['room', normalizedRoom]]),
            });
            // 请求还在飞的时候房间被换掉了 —— 这批历史不属于当前房间，丢掉。
            if (normalizeRoomName(get().room) !== normalizedRoom) {
                return;
            }
            const messages = response.data && Array.isArray(response.data.messages)
                ? response.data.messages
                : [];
            get().mergeMessages(messages);
        } catch (error) {
            // 取历史失败**不影响实时**：WS 照样连着、新消息照收，只是这个房间暂时是空的。
            console.error('Failed to load history from /content:', error);
        }
    },
    handleEvent: (event, data) => {
        switch (event) {
            case 'receive':
                get().queueReceive(data as ReceivedItem);
                break;
            case 'receiveMulti':
                get().flushPendingReceives();
                get().mergeMessages(Array.isArray(data) ? (data as ReceivedItem[]) : [data as ReceivedItem]);
                break;
            case 'revoke': {
                get().flushPendingReceives();
                const app = useAppStore.getState();
                const received = [...app.received];
                const index = received.findIndex((e) => e.id === (data as ReceivedItem).id);
                if (index !== -1) {
                    received.splice(index, 1);
                    useAppStore.setState({ received });
                    get().saveRoomCache();
                }
                break;
            }
            case 'config': {
                get().flushPendingReceives();
                const config = data as AppConfig;
                useAppStore.setState({ config });
                // ⚠️ 拿到 `config` 就去取历史 —— 握手不再推历史，这条 HTTP 请求是**唯一**的来源。
                void get().loadHistoryFromHttp();
                console.log(
                    `%c clip9 ${config.version} by Jonnyan404 %c https://github.com/Jonnyan404/clip9 `,
                    'color:#fff;background-color:#1e88e5',
                    'color:#fff;background-color:#64b5f6',
                );
                break;
            }
            case 'connect':
                useAppStore.setState({ device: [...useAppStore.getState().device, data as { id: string }] });
                break;
            case 'disconnect': {
                const device = [...useAppStore.getState().device];
                const index = device.findIndex((e) => e.id === (data as { id: string }).id);
                if (index !== -1) {
                    device.splice(index, 1);
                    useAppStore.setState({ device });
                }
                break;
            }
            case 'update': {
                get().flushPendingReceives();
                const app = useAppStore.getState();
                const received = [...app.received];
                const index = received.findIndex((e) => e.id === (data as ReceivedItem).id);
                if (index !== -1) {
                    received.splice(index, 1, { ...received[index], ...(data as ReceivedItem) });
                    useAppStore.setState({ received });
                    get().saveRoomCache();
                }
                break;
            }
            case 'forbidden': {
                get().flushPendingReceives();
                get().clearAuthTokenForRoom(get().room);
                get().openAuthDialog(get().room);
                break;
            }
            case 'pong': {
                if (typeof data === 'number' && data > 0) {
                    const rtt = Date.now() - data;
                    if (rtt >= 0) {
                        set({ latency: rtt });
                    }
                }
                break;
            }
        }
    },
    disconnect: () => {
        set({ websocketConnecting: false });
        const socket = get().websocket;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            set({ websocket: null });
        }
        get().clearAuthRefreshTimer();
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        if (receiveFlushTimer) {
            clearTimeout(receiveFlushTimer);
            receiveFlushTimer = null;
        }
        pendingReceiveQueue = [];
        get().saveRoomCache();
        useAppStore.setState({ device: [] });
    },
    switchRoom: (targetRoom) => {
        const oldRoom = normalizeRoomName(get().room);
        const newRoom = normalizeRoomName(targetRoom);
        if (oldRoom === newRoom) {
            return;
        }
        const app = useAppStore.getState();
        // 1. 先把当前视图（旧房间内容）保存回旧房间的 cache，避免混入新房间
        useAppStore.setState({ roomMessagesCache: { ...app.roomMessagesCache, [oldRoom]: [...app.received] } });
        // 2. 断开旧连接并清空所有 handler，防止旧连接的残留消息写入新房间
        set({ websocketConnecting: false });
        const socket = get().websocket;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            set({ websocket: null });
        }
        get().clearAuthRefreshTimer();
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        set({ latency: null });
        if (receiveFlushTimer) {
            clearTimeout(receiveFlushTimer);
            receiveFlushTimer = null;
        }
        pendingReceiveQueue = [];
        useAppStore.setState({ device: [] });
        // 3. 切换当前房间
        set({ room: newRoom });
        // 4. 载入新房间的 cache
        get().syncRoomView(newRoom);
        // 5. 连接新房间
        void get().connect();
        // 6. 同步地址栏（使用 replace 避免历史堆栈膨胀）
        void router.navigate(roomHref(newRoom), { replace: true });
    },
    failure: () => {
        set({ websocket: null, latency: null });
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        useAppStore.setState({ device: [] });
        const retry = get().retry;
        set({ retry: retry + 1 });
        if (retry < 3) {
            void get().connect();
        }
    },
    handleHttpUnauthorized: (config = {}) => {
        const room = get().getRequestRoom(config);
        get().clearAuthTokenForRoom(room);
        get().openAuthDialog(room);
    },
    getRequestRoom: (config = {}) => {
        const params = config.params;
        if (params instanceof URLSearchParams) {
            return normalizeRoomName(params.get('room') || get().room);
        }
        if (params && typeof params === 'object' && (params as Record<string, unknown>).room !== undefined) {
            return normalizeRoomName(String((params as Record<string, unknown>).room));
        }
        return normalizeRoomName(get().room);
    },
    getRequestAuthToken: (config = {}) => {
        return get().getAuthTokenForRoom(get().getRequestRoom(config));
    },
    navigateToRoom: async (room) => {
        const normalizedRoom = normalizeRoomName(room);
        const currentQuery = new URLSearchParams(router.state.location.search);
        if (normalizedRoom === normalizeRoomName(currentQuery.get('room') || '')) {
            return true;
        }

        const knownToken = get().getAuthTokenForRoom(normalizedRoom);
        const isProtected = get().roomProtectionCache[normalizedRoom];
        const app = useAppStore.getState();
        const globalAuth = Boolean(app.config?.auth);

        if (!knownToken && (isProtected === true || (isProtected === undefined && globalAuth))) {
            const token = await get().resolveAuthTokenForRoom(normalizedRoom, { interactive: true });
            if (token === null) {
                return false;
            }
        }

        await router.navigate(roomHref(normalizedRoom));
        return true;
    },
    submitAuthCodeForPendingRoom: async () => {
        const state = get();
        const targetRoom = state.authPendingRoom || normalizeRoomName(state.room);
        const password = (state.inputPassword || '').trim();
        if (!password || state.authDialogLoading) {
            return;
        }
        set({ authDialogLoading: true, authCodeError: '' });
        try {
            const verified = await get().verifyRoomAccess(targetRoom, password);
            if (!verified) {
                set({ authCodeError: 'authInvalid' });
                return;
            }
            const session = await get().obtainRoomSessionToken(targetRoom, password);
            if (!session || !session.token) {
                set({ authCodeError: 'connectionFailedRetry' });
                return;
            }
            if (session.scope === 'global') {
                get().cacheAuthTokenForRoom(GLOBAL_ROOM_KEY, session.token, session.expiresAt);
            } else {
                get().cacheAuthTokenForRoom(targetRoom, session.token, session.expiresAt);
            }
            get().scheduleAuthRefresh(targetRoom);
            set({ inputPassword: '', authCodeDialog: false, authPendingRoom: '' });
            if (normalizeRoomName(targetRoom) !== normalizeRoomName(get().room)) {
                await get().navigateToRoom(targetRoom);
                return;
            }
            set({ retry: 0 });
            void get().connect();
        } catch (error) {
            console.error(error);
            set({ authCodeError: 'connectionFailedRetry' });
        } finally {
            set({ authDialogLoading: false });
        }
    },
}));

export { isShareRoute };
