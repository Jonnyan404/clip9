import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Box, CircularProgress, Divider, IconButton, LinearProgress, List, ListItemButton, ListItemText, Stack, TextField, Typography,
} from '@mui/material';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useWebSocketStore } from '@/stores/wsStore';
import { selectRoomGroups, useRoomsStore, type RoomEntry } from '@/stores/roomsStore';

/** 相对时间（`lastActive`）。键名都取自现有 i18n。 */
function relativeTime(timestamp: number | undefined, t: (key: string, opts?: Record<string, unknown>) => string): string {
    if (!timestamp || timestamp === 0) {
        return t('never');
    }
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return t('justNow');
    if (diff < 3600) return t('minutesAgo', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('hoursAgo', { count: Math.floor(diff / 3600) });
    return t('daysAgo', { count: Math.floor(diff / 86400) });
}

/**
 * 房间侧栏 —— 对应 web-vue3/src/components/RoomList.vue。
 *
 * ⚠️ 这里**没有**照搬 Vue 版那 6 套皮肤（`--rl-*` 六组 token）—— 那是「同一个结构、六份配色」，
 * 迁移时先落结构与交互，皮肤随后统一（见迁移计划 §8.2 的「先建兼容层、再逐步清理」）。
 */
export function RoomList({
    variant,
    dockSide = 'right',
    onSelect,
    onFavorite,
    onClose,
    actions,
}: {
    variant: 'dock' | 'sheet';
    dockSide?: 'left' | 'right';
    onSelect: (name: string) => void;
    onFavorite: (name: string) => void;
    onClose?: () => void;
    actions?: ReactNode;
}) {
    const { t } = useTranslation();
    const availableRooms = useRoomsStore((s) => s.availableRooms);
    const roomSearch = useRoomsStore((s) => s.roomSearch);
    const setRoomSearch = useRoomsStore((s) => s.setRoomSearch);
    const roomsLoading = useRoomsStore((s) => s.roomsLoading);
    const currentRoom = useWebSocketStore((s) => s.room);

    const groups = useMemo(
        () => selectRoomGroups({ availableRooms, roomSearch }, currentRoom),
        [availableRooms, roomSearch, currentRoom],
    );

    const currentRoomLabel = currentRoom || t('publicRoom');

    const renderRow = (room: RoomEntry) => {
        const isCurrent = room.name === currentRoom;
        return (
            <ListItemButton
                key={room.name || '__public__'}
                selected={isCurrent}
                onClick={() => onSelect(room.name)}
                sx={{ alignItems: 'flex-start', gap: 0.5 }}
            >
                <MdiIcon
                    name={room.isProtected ? 'mdi-lock' : 'mdi-earth'}
                    size={16}
                    style={{ marginTop: 4, opacity: 0.7 }}
                />
                <ListItemText
                    primary={room.name || t('publicRoom')}
                    secondary={[
                        room.deviceCount > 0 ? `${room.deviceCount} ${t('devices')}` : '',
                        room.messageCount > 0 ? `${t('messages')} ${room.messageCount}` : '',
                        room.lastActive ? `${t('lastActive')} · ${relativeTime(room.lastActive, t)}` : '',
                    ].filter(Boolean).join(' · ')}
                    slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true, variant: 'caption' } }}
                />
                <IconButton
                    size="small"
                    onClick={(e) => {
                        e.stopPropagation();
                        onFavorite(room.name);
                    }}
                    aria-label={t('favoriteRoomsLabel')}
                >
                    <MdiIcon name={room.isFavorite ? 'mdi-heart' : 'mdi-heart-outline'} size={16} />
                </IconButton>
            </ListItemButton>
        );
    };

    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                width: variant === 'dock' ? 260 : '100%',
                borderLeft: variant === 'dock' && dockSide === 'right' ? 1 : 0,
                borderRight: variant === 'dock' && dockSide === 'left' ? 1 : 0,
                borderColor: 'divider',
                bgcolor: 'background.paper',
            }}
        >
            <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1 }}>
                <MdiIcon name="mdi-view-list" size={18} />
                <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>{t('roomList')}</Typography>
                <Typography variant="caption" color="text.secondary">{availableRooms.length}</Typography>
                {actions}
                {onClose && (
                    <IconButton size="small" onClick={onClose} aria-label={t('close')}>
                        <MdiIcon name="mdi-close" size={18} />
                    </IconButton>
                )}
            </Stack>
            <Divider />
            <Box sx={{ px: 1.5, py: 1 }}>
                <TextField
                    size="small"
                    fullWidth
                    placeholder={t('searchRooms')}
                    value={roomSearch}
                    onChange={(e) => setRoomSearch(e.target.value)}
                />
            </Box>
            {roomsLoading && <LinearProgress />}
            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 0.5, pb: 2 }}>
                <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, py: 0.5, display: 'block' }}>
                    {t('currentRoomLabel')}
                </Typography>
                <List dense disablePadding>
                    <ListItemButton selected onClick={() => onSelect(currentRoom)}>
                        <MdiIcon name="mdi-home-outline" size={16} style={{ marginRight: 8 }} />
                        <ListItemText primary={currentRoomLabel} />
                    </ListItemButton>
                </List>

                {groups.length === 0 && (
                    <Stack alignItems="center" spacing={1} sx={{ py: 3 }}>
                        {roomsLoading ? (
                            <>
                                <CircularProgress size={20} />
                                <Typography variant="caption" color="text.secondary">{t('loadingRooms')}</Typography>
                            </>
                        ) : (
                            <Typography variant="caption" color="text.secondary">{t('noRoomsFound')}</Typography>
                        )}
                    </Stack>
                )}

                {groups.map((group) => (
                    <div key={group.key}>
                        <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, pt: 1.5, pb: 0.5, display: 'block' }}>
                            {group.title}
                        </Typography>
                        <List dense disablePadding>
                            {group.rooms.map(renderRow)}
                        </List>
                    </div>
                ))}
            </Box>
        </Box>
    );
}
