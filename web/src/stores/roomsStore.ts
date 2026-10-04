import { create } from 'zustand';
import axios from 'axios';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import i18n from '@/i18n';

/**
 * 服务端房间列表 + 侧栏偏好 —— 从 web-vue3/src/App.vue 的房间相关逻辑移植。
 *
 * ⚠️★ 为什么抽成 store 而不是留在外壳组件里：这些状态被**三处**读/写 ——
 * 外壳（侧栏与底栏）、工具栏（那个开关按钮的状态与角标）、进房间弹窗（`ensureRoomPresent`）。
 * 留在组件里就得靠 Context 层层透传。
 *
 * ⚠️ 「工具栏那个房间图标是**开关**，不是『打开』」—— 两个方向都归这一个按钮
 * （跟 VS Code / 访达的侧栏开关一致）。
 */
export interface RoomEntry {
    name: string;
    isFavorite: boolean;
    isProtected: boolean;
    isActive: boolean;
    messageCount: number;
    deviceCount: number;
    lastActive: number;
}

export interface RoomGroup {
    key: string;
    title: string;
    rooms: RoomEntry[];
}

const FAVORITES_KEY = 'favoriteRooms';

function getFavoriteRooms(): string[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** 随机房间名（进房间弹窗那个骰子按钮）。 */
export function randomRoomName(): string {
    const names = ['reimu', 'marisa', 'rumia', 'cirno', 'meiling', 'patchouli', 'sakuya', 'remilia', 'flandre', 'letty', 'chen', 'lyrica', 'lunasa', 'merlin', 'youmu', 'yuyuko', 'ran', 'yukari', 'suika', 'mystia', 'keine', 'tewi', 'reisen', 'eirin', 'kaguya', 'mokou'];
    return `${names[Math.floor(Math.random() * names.length)]}-${Math.random().toString(16).substring(2, 6)}`;
}

interface RoomsState {
    availableRooms: RoomEntry[];
    roomsLoading: boolean;
    roomSearch: string;
    /** 桌面端侧栏（dock）是否可见。 */
    roomDockVisible: boolean;
    roomDockSide: 'left' | 'right';
    /** 窄屏底栏（bottom sheet）是否打开。 */
    roomSheetOpen: boolean;

    setRoomSearch: (value: string) => void;
    restorePreferences: () => void;
    toggleRoomDock: () => void;
    toggleDockSide: () => void;
    openRoomBrowser: (desktopDockEnabled: boolean) => void;
    closeRoomSheet: () => void;
    ensureRoomPresent: (roomName?: string) => void;
    fetchRoomList: () => Promise<void>;
    switchRoom: (roomName: string) => Promise<void>;
    toggleFavoriteRoom: (roomName: string) => void;
}

function createOptimisticRoom(roomName: string): RoomEntry {
    const normalized = roomName || '';
    return {
        name: normalized,
        isFavorite: getFavoriteRooms().includes(normalized),
        // 占位条目：房间还没出现在 /rooms 的返回里时先按缓存画。
        // 语义与工具栏 chip 上那个锁一致 ——「要不要密码」，不是「roomAuth 里有没有这一项」。
        isProtected: Boolean(useWebSocketStore.getState().roomProtectionCache?.[normalized]),
        isActive: true,
        messageCount: 0,
        deviceCount: 0,
        lastActive: Math.floor(Date.now() / 1000),
    };
}

export const useRoomsStore = create<RoomsState>((set, get) => ({
    availableRooms: [],
    roomsLoading: false,
    roomSearch: '',
    roomDockVisible: true,
    roomDockSide: 'right',
    roomSheetOpen: false,

    setRoomSearch: (value) => set({ roomSearch: String(value || '') }),

    restorePreferences: () => {
        const storedVisible = localStorage.getItem('roomDockVisible');
        const storedSide = localStorage.getItem('roomDockSide');
        set({
            roomDockVisible: storedVisible === null ? true : storedVisible === 'true',
            roomDockSide: storedSide === 'left' ? 'left' : 'right',
        });
    },

    toggleRoomDock: () => {
        const next = !get().roomDockVisible;
        set({ roomDockVisible: next });
        localStorage.setItem('roomDockVisible', String(next));
        localStorage.setItem('roomDockSide', get().roomDockSide);
        if (next) {
            get().ensureRoomPresent();
            void get().fetchRoomList();
        }
    },

    toggleDockSide: () => {
        const next = get().roomDockSide === 'right' ? 'left' : 'right';
        set({ roomDockSide: next });
        localStorage.setItem('roomDockVisible', String(get().roomDockVisible));
        localStorage.setItem('roomDockSide', next);
    },

    openRoomBrowser: (desktopDockEnabled) => {
        if (desktopDockEnabled) {
            get().toggleRoomDock();
            return;
        }
        const next = !get().roomSheetOpen;
        set({ roomSheetOpen: next });
        if (next) {
            get().ensureRoomPresent();
            void get().fetchRoomList();
        }
    },

    closeRoomSheet: () => set({ roomSheetOpen: false }),

    ensureRoomPresent: (roomName) => {
        const normalized = roomName ?? useWebSocketStore.getState().room ?? '';
        const name = normalized || '';
        if (get().availableRooms.some((room) => room.name === name)) {
            return;
        }
        set({ availableRooms: [createOptimisticRoom(name), ...get().availableRooms] });
    },

    fetchRoomList: async () => {
        const ws = useWebSocketStore.getState();
        const config = useAppStore.getState().config;
        if (!config || !config.server || !config.server.roomList) {
            return;
        }
        if (get().roomsLoading) {
            return;
        }
        set({ roomsLoading: true });
        try {
            const candidateTokens = ws.getKnownAuthTokens();
            const dedupedTokens = Array.from(new Set(candidateTokens.map((token) => (token || '').trim()).filter(Boolean)));
            const response = await axios.get('rooms', {
                headers: dedupedTokens.length ? { 'X-Room-Auth-Tokens': JSON.stringify(dedupedTokens) } : undefined,
                __skipRoomAuthHandling: true,
            });
            const rooms = Array.isArray(response.data?.rooms) ? response.data.rooms : [];
            const favorites = getFavoriteRooms();
            const nextRooms: RoomEntry[] = rooms.map((room: Partial<RoomEntry> & { name: string }) => ({
                ...room,
                isFavorite: favorites.includes(room.name),
            })) as RoomEntry[];
            // 合并：保留已有对象（角标/高亮不闪），只覆盖字段
            const existingByName = new Map(get().availableRooms.map((room) => [room.name, room]));
            const ordered = nextRooms.map((roomData) => {
                const existing = existingByName.get(roomData.name);
                if (existing) {
                    return { ...existing, ...roomData };
                }
                return roomData;
            });
            const currentRoomName = useWebSocketStore.getState().room || '';
            if (!ordered.some((room) => room.name === currentRoomName)) {
                ordered.unshift(existingByName.get(currentRoomName) || createOptimisticRoom(currentRoomName));
            }
            set({ availableRooms: ordered });
            get().ensureRoomPresent();
        } catch (error) {
            console.error('Failed to fetch room list:', error);
            toast(i18n.t('failedToLoadRooms'));
        } finally {
            set({ roomsLoading: false });
        }
    },

    switchRoom: async (roomName) => {
        set({ roomSheetOpen: false });
        await useWebSocketStore.getState().navigateToRoom(roomName);
    },

    toggleFavoriteRoom: (roomName) => {
        const favorites = getFavoriteRooms();
        const index = favorites.indexOf(roomName);
        if (index > -1) {
            favorites.splice(index, 1);
            toast(i18n.t('removedFromFavorites', { room: roomName || i18n.t('publicRoom') }));
        } else {
            favorites.push(roomName);
            toast(i18n.t('addedToFavorites', { room: roomName || i18n.t('publicRoom') }));
        }
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
        set({
            availableRooms: get().availableRooms.map((room) =>
                room.name === roomName ? { ...room, isFavorite: !room.isFavorite } : room,
            ),
        });
    },
}));

// ── 选择器 ────────────────────────────────────────────────────────────────

export function selectFilteredRooms(state: Pick<RoomsState, 'availableRooms' | 'roomSearch'>): RoomEntry[] {
    let rooms = state.availableRooms.slice();
    if (state.roomSearch) {
        const q = state.roomSearch.toLowerCase();
        rooms = rooms.filter((room) => (room.name || i18n.t('publicRoom')).toLowerCase().includes(q));
    }
    return rooms.sort((a, b) => {
        if (a.isFavorite !== b.isFavorite) {
            return Number(b.isFavorite) - Number(a.isFavorite);
        }
        return 0;
    });
}

export function selectCurrentRoomEntry(
    state: Pick<RoomsState, 'availableRooms' | 'roomSearch'>,
    currentRoom: string,
): RoomEntry | null {
    const matching = selectFilteredRooms(state).find((room) => room.name === currentRoom);
    if (matching) {
        return matching;
    }
    if (state.roomSearch) {
        return null;
    }
    return createOptimisticRoom(currentRoom);
}

/** 分组（收藏 / 活跃 / 其他）。空组会被过滤掉。 */
export function selectRoomGroups(
    state: Pick<RoomsState, 'availableRooms' | 'roomSearch'>,
    currentRoom: string,
): RoomGroup[] {
    const rooms = selectFilteredRooms(state);
    const favorites = rooms.filter((room) => room.isFavorite && room.name !== currentRoom);
    const active = rooms.filter((room) => !room.isFavorite && room.isActive && room.name !== currentRoom);
    const other = rooms.filter((room) => !room.isFavorite && !room.isActive && room.name !== currentRoom);
    return [
        { key: 'favorites', title: i18n.t('favoriteRoomsLabel'), rooms: favorites },
        { key: 'active', title: i18n.t('activeRoomsLabel'), rooms: active },
        { key: 'other', title: i18n.t('otherRoomsLabel'), rooms: other },
    ].filter((group) => group.rooms.length > 0);
}

export function selectFavoriteRoomCount(state: Pick<RoomsState, 'availableRooms'>): number {
    return state.availableRooms.filter((room) => room.isFavorite).length;
}

export function selectActiveRoomCount(state: Pick<RoomsState, 'availableRooms'>): number {
    return state.availableRooms.filter((room) => room.isActive).length;
}
