import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';

/**
 * 本地管理的房间列表 —— 从 web-vue3/src/composables/useLocalRooms.js 移植。
 *
 * 为什么要有这一套：服务端把 `server.roomList` 关掉时 `/rooms` 什么都不返回，
 * 于是「房间侧栏」那一套整个不可用 —— 但用户明明可以自己记住几个房间名、在它们之间切。
 *
 * ⚠️ localStorage 键从 `workbenchRooms` 改成了 `localRooms`，**旧键要读一次做迁移**。
 */
const STORAGE_KEY = 'localRooms';
const LEGACY_STORAGE_KEY = 'workbenchRooms';

function readStoredRooms(): string[] {
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            if (Array.isArray(parsed) && parsed.length) {
                return parsed as string[];
            }
        } catch {
            // 坏值就当没有，继续试下一个键
        }
    }
    return [];
}

function persistRooms(rooms: string[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
    } catch {
        // 存不下就算了，内存里仍然生效
    }
}

export function useLocalRooms() {
    const { t } = useTranslation();

    const [localRooms, setLocalRooms] = useState<string[]>(() => {
        const rooms: string[] = [];
        for (const room of readStoredRooms()) {
            const normalized = useWebSocketStore.getState().normalizeRoomName(room);
            if (!rooms.includes(normalized)) {
                rooms.push(normalized);
            }
        }
        // 空串代表「公共房间」，永远排第一 —— 它是默认房间，不能从列表里消失。
        if (!rooms.includes('')) {
            rooms.unshift('');
        }
        return rooms;
    });

    // 建房间 = 加进本地列表 + 切过去。返回是否成功（调用方据此决定关不关弹窗）。
    const createRoom = useCallback((rawName: string): boolean => {
        const ws = useWebSocketStore.getState();
        const name = ws.normalizeRoomName(rawName);
        if (!name) {
            toast(t('workbenchRoomNameInvalid'));
            return false;
        }
        setLocalRooms((prev) => {
            const next = prev.includes(name) ? prev : [...prev, name];
            persistRooms(next);
            return next;
        });
        ws.switchRoom(name);
        toast(t('workbenchRoomCreated', { room: name }));
        return true;
    }, [t]);

    // 只从本地列表里摘掉，**不删服务端的任何东西** —— 这里管的是「我记住哪几个房间」。
    const removeRoom = useCallback((room: string) => {
        const ws = useWebSocketStore.getState();
        setLocalRooms((prev) => {
            const next = prev.filter((r) => r !== room);
            persistRooms(next);
            return next;
        });
        // 删掉的正是当前房间 → 回公共房间，不然会停在一个已经从列表里消失的房间里。
        if (ws.room === room) {
            ws.switchRoom('');
        }
    }, []);

    const switchToRoom = useCallback((room: string) => {
        useWebSocketStore.getState().switchRoom(room);
    }, []);

    return { localRooms, createRoom, removeRoom, switchToRoom };
}
