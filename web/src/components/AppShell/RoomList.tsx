import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, CircularProgress, IconButton, InputAdornment, ListItemButton, TextField, Typography } from '@mui/material';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import {
    selectActiveRoomCount,
    selectCurrentRoomEntry,
    selectFavoriteRoomCount,
    selectFilteredRooms,
    selectRoomGroups,
    useRoomsStore,
    type RoomEntry,
} from '@/stores/roomsStore';

/** i18next 的 `t`（`relativeTime` 只用到「取一条文案」这一件事）。 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 相对时间。键名与 `{minutes}` / `{hours}` / `{days}` 三个占位符都取自现有 i18n。
 *
 * ⚠️★ 插值变量名**必须与语言文件里的占位符逐字一致**：文案是 `"{minutes}分钟前"`，
 * 而 i18next 的 `count` 只会填 `{{count}}`（vue-i18n 那边用的是 `{minutes}`）。
 * 曾经在这里传 `{ count }`，后果是房间里直接显示字面量 `{minutes}分钟前` ——
 * 而且**不报错**，只有肉眼看列表才发现。
 */
function relativeTime(timestamp: number | undefined, t: Translate): string {
    if (!timestamp || timestamp === 0) {
        return t('never');
    }
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return t('justNow');
    if (diff < 3600) return t('minutesAgo', { minutes: Math.floor(diff / 60) });
    if (diff < 86400) return t('hoursAgo', { hours: Math.floor(diff / 3600) });
    return t('daysAgo', { days: Math.floor(diff / 86400) });
}

/** 房间名（空名 = 公共房间）。 */
function displayName(room: RoomEntry | null, t: Translate): string {
    return room && room.name ? room.name : t('publicRoom');
}

/** 摘要 pill 里显示的是**当前房间名**（空 = 公共房间），不是分组标题 —— 两个字符串别混用。 */
function currentRoomDisplayName(roomName: string, t: Translate): string {
    return roomName || t('publicRoom');
}

/**
 * 行内那一段「N 设备 · 消息 M」。
 *
 * ⚠️ 两处留白都是为了省宽度给房间名（实测这两个数占 40~90px，是行里最贵的一段）：
 *   · 设备数为 0 时不写 —— 活跃绿点已经编码了「有没有设备」，再写一遍等于说第二次；
 *   · 消息数为 0 时不写 —— 同上。
 * 两个都是 0 时整段不渲染（调用方据此决定连中间那个分隔点也一起不画）。
 */
function countsLabel(room: RoomEntry, t: Translate): string {
    const parts: string[] = [];
    const devices = room.deviceCount || 0;
    const messages = room.messageCount || 0;
    if (devices > 0) {
        parts.push(`${devices} ${t('devices')}`);
    }
    if (messages > 0) {
        parts.push(`${t('messages')} ${messages}`);
    }
    return parts.join(' · ');
}

/**
 * 行的 `title`（悬停提示）：名字 + 设备数 + 消息数 + 最后活跃。
 *
 * ⚠️★ 设备数/消息数**只在 title 里补零**，行内不写（见 `countsLabel`）。触屏没有 hover，
 * 所以行内必须自己够用；title 是给鼠标用户的加餐，不是唯一出口。
 */
function rowTitle(room: RoomEntry, t: Translate): string {
    return [
        displayName(room, t),
        `${room.deviceCount || 0} ${t('devices')}`,
        `${t('messages')} ${room.messageCount || 0}`,
        `${t('lastActive')} ${relativeTime(room.lastActive, t)}`,
    ].join(' · ');
}

/** 摘要 pill（当前房间 / 收藏 / 活跃）。 */
function Pill({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
    return (
        <Box
            component="span"
            sx={{
                fontSize: 'var(--rl-label-size)',
                color: accent ? 'var(--rl-current-accent)' : 'var(--rl-muted)',
                border: '1px solid',
                borderColor: accent ? 'var(--rl-current-accent)' : 'var(--rl-border)',
                borderRadius: 'calc(var(--rl-radius) * 0.6)',
                px: '8px',
                py: '2px',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
            }}
        >
            {children}
        </Box>
    );
}

/**
 * 房间侧栏 —— 对应 web-vue3/src/components/RoomList.vue。
 *
 * 结构与文案逐项对齐 Vue 版（摘要 pill、当前房间独立一节、行内「非零计数 · 时间」、
 * 行 title、头部计数胶囊、空态图标、loading 只在空态出现、搜索框放大镜与可清空）。
 *
 * 皮肤（`--rl-*`）见 `styles/components.css` 的「房间侧栏」一节：
 * Vue 那六套里**只有 base + sticky + 暗色是活的**，退役模式的那四套没有移植。
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
    const uiMode = useAppStore((s) => s.uiMode);

    const availableRooms = useRoomsStore((s) => s.availableRooms);
    const roomSearch = useRoomsStore((s) => s.roomSearch);
    const setRoomSearch = useRoomsStore((s) => s.setRoomSearch);
    const roomsLoading = useRoomsStore((s) => s.roomsLoading);
    const currentRoom = useWebSocketStore((s) => s.room);

    const selectorState = { availableRooms, roomSearch };
    const currentRoomEntry = useMemo(
        () => selectCurrentRoomEntry(selectorState, currentRoom),
        [availableRooms, roomSearch, currentRoom],
    );
    const groups = useMemo(
        () => selectRoomGroups(selectorState, currentRoom),
        [availableRooms, roomSearch, currentRoom],
    );
    const favoriteCount = useMemo(() => selectFavoriteRoomCount({ availableRooms }), [availableRooms]);
    const activeCount = useMemo(() => selectActiveRoomCount({ availableRooms }), [availableRooms]);
    // `hasRooms` 认的是**过滤之后**的列表（搜索空了也算空），Vue 侧同此。
    const hasRooms = useMemo(() => selectFilteredRooms(selectorState).length > 0, [availableRooms, roomSearch]);

    const currentRoomLabel = t('currentRoomLabel');
    const panelPadding = variant === 'dock' ? '14px 16px 18px' : '16px 20px 20px';

    /**
     * 一行房间。当前房间与分组里的房间**共用这一个渲染器** ——
     * Vue 那边是同一段模板抄了两遍，React 里抽成函数，改一处两边都跟着变。
     */
    const renderRow = (room: RoomEntry, isCurrent: boolean) => {
        const counts = countsLabel(room, t);
        return (
            <ListItemButton
                key={room.name || '__public__'}
                className={`rl-row${isCurrent ? ' rl-row--current' : ''}`}
                selected={isCurrent}
                title={rowTitle(room, t)}
                onClick={() => onSelect(room.name)}
                sx={{
                    minWidth: 0,
                    minHeight: 'var(--rl-row-h)',
                    padding: 'var(--rl-row-pad)',
                    gap: '8px',
                    borderRadius: 'var(--rl-radius)',
                    alignItems: 'center',
                    transition: 'background-color 0.15s ease',
                    '&:hover': { backgroundColor: 'var(--rl-surface-hover)' },
                    // MUI 自带的选中底色是 action.selected，这里换成皮肤给的 token。
                    '&.Mui-selected': { backgroundColor: 'var(--rl-current-bg)' },
                    '&.Mui-selected:hover': { backgroundColor: 'var(--rl-current-bg)' },
                    '&.Mui-focusVisible': { outline: '2px solid var(--rl-current-accent)', outlineOffset: '-2px' },
                }}
            >
                <Box component="span" className="rl-row__mark" aria-hidden />
                {/* 两行：名字（+ 活跃点 + 锁），然后元信息（计数 + 时间）。
                    挤成一行的话 332px 的侧栏里「名字 + 计数 + 时间 + 点 + 收藏」装不下，
                    实测名字只剩 93~117px，14 字的名字被砍成 7 个字。 */}
                <Box
                    component="span"
                    sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' }}
                >
                    <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                        <Box
                            component="span"
                            sx={{
                                flex: '0 1 auto',
                                minWidth: 0,
                                fontSize: 'var(--rl-name-size)',
                                fontWeight: 500,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {displayName(room, t)}
                        </Box>
                        {room.isActive && <Box component="span" className="rl-row__dot" aria-hidden />}
                        {room.isProtected && (
                            <Box component="span" className="rl-row__lock">
                                <MdiIcon name="mdi-lock" size={14} />
                            </Box>
                        )}
                    </Box>
                    {/* 元信息行：计数 · 时间。挤不下时优先截断的是计数（它可以少一段），
                        时间永远留到最后 —— 它是这一行里最该看到的。 */}
                    <Box
                        component="span"
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            minWidth: 0,
                            fontSize: 'var(--rl-time-size)',
                            color: 'var(--rl-muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                        }}
                    >
                        {counts && (
                            <>
                                <Box
                                    component="span"
                                    sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                                >
                                    {counts}
                                </Box>
                                <Box component="span" sx={{ flex: 'none', mx: '8px' }} aria-hidden>
                                    ·
                                </Box>
                            </>
                        )}
                        <Box component="span" sx={{ flex: 'none' }}>
                            {relativeTime(room.lastActive, t)}
                        </Box>
                    </Box>
                </Box>
                <IconButton
                    size="small"
                    className={`rl-row__fav${room.isFavorite ? ' rl-row__fav--on' : ''}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onFavorite(room.name);
                    }}
                    aria-label={t('favoriteRoomsLabel')}
                >
                    <MdiIcon name={room.isFavorite ? 'mdi-heart' : 'mdi-heart-outline'} size={14} />
                </IconButton>
            </ListItemButton>
        );
    };

    return (
        <Box
            className={`rl rl--${uiMode} rl--${variant}`}
            sx={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                width: variant === 'dock' ? 332 : '100%',
                bgcolor: 'var(--rl-panel-bg)',
                // 内侧发丝线画在朝向内容的那一边，颜色取皮肤的 --rl-border
                // （便签模式是暖色线，接缝不会突然变成一条冷灰）。
                borderLeft: variant === 'dock' && dockSide === 'right' ? '1px solid var(--rl-border)' : 0,
                borderRight: variant === 'dock' && dockSide === 'left' ? '1px solid var(--rl-border)' : 0,
            }}
        >
            {/* 头部放在组件里而不是留在外壳：它也得跟着模式走，
                否则上面是圆润的默认样式、下面是另一套 token，接缝一眼看得出来。 */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    px: '16px',
                    pt: '14px',
                    pb: '10px',
                    borderBottom: '1px solid var(--rl-border)',
                }}
            >
                <MdiIcon name="mdi-view-list" size={18} />
                <Typography
                    component="span"
                    sx={{ fontSize: 'var(--rl-title-size)', fontWeight: 500, whiteSpace: 'nowrap' }}
                >
                    {t('roomList')}
                </Typography>
                <Box
                    component="span"
                    sx={{
                        fontSize: 'var(--rl-label-size)',
                        color: 'var(--rl-muted)',
                        border: '1px solid var(--rl-border)',
                        borderRadius: 'calc(var(--rl-radius) * 0.6)',
                        px: '7px',
                        py: '1px',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {availableRooms.length} {t('rooms')}
                </Box>
                <Box sx={{ flex: 1 }} />
                {actions}
                {onClose && (
                    <IconButton size="small" onClick={onClose} aria-label={t('close')}>
                        <MdiIcon name="mdi-close" size={18} />
                    </IconButton>
                )}
            </Box>

            <Box
                sx={{
                    flex: variant === 'dock' ? 1 : undefined,
                    minHeight: variant === 'dock' ? 0 : undefined,
                    maxHeight: variant === 'sheet' ? '62vh' : undefined,
                    overflowY: 'auto',
                    padding: panelPadding,
                    display: 'grid',
                    gap: '14px',
                    alignContent: 'start',
                }}
            >
                <TextField
                    size="small"
                    fullWidth
                    placeholder={t('searchRooms')}
                    value={roomSearch}
                    onChange={(e) => setRoomSearch(e.target.value)}
                    slotProps={{
                        input: {
                            startAdornment: (
                                <InputAdornment position="start">
                                    <MdiIcon name="mdi-magnify" size={18} />
                                </InputAdornment>
                            ),
                            endAdornment: roomSearch ? (
                                <InputAdornment position="end">
                                    <IconButton
                                        size="small"
                                        onClick={() => setRoomSearch('')}
                                        aria-label={t('clear')}
                                    >
                                        <MdiIcon name="mdi-close" size={16} />
                                    </IconButton>
                                </InputAdornment>
                            ) : undefined,
                        },
                    }}
                    sx={{ '& .MuiOutlinedInput-root': { borderRadius: 'var(--rl-radius)' } }}
                />

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    <Pill accent>{currentRoomDisplayName(currentRoom, t)}</Pill>
                    <Pill>
                        {favoriteCount} {t('favoriteRoomsLabel')}
                    </Pill>
                    <Pill>
                        {activeCount} {t('activeRoomsLabel')}
                    </Pill>
                </Box>

                {roomsLoading && !hasRooms ? (
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', py: '32px' }}>
                        <CircularProgress size={28} />
                        <Typography sx={{ fontSize: 'var(--rl-name-size)', color: 'var(--rl-muted)' }}>
                            {t('loadingRooms')}
                        </Typography>
                    </Box>
                ) : !hasRooms ? (
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', py: '32px' }}>
                        <MdiIcon name="mdi-home-outline" size={48} style={{ opacity: 0.4 }} />
                        <Typography sx={{ fontSize: 'var(--rl-name-size)', color: 'var(--rl-muted)' }}>
                            {t('noRoomsFound')}
                        </Typography>
                    </Box>
                ) : (
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px', minWidth: 0 }}>
                        {currentRoomEntry && (
                            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '4px', minWidth: 0 }}>
                                <Box
                                    sx={{
                                        fontSize: 'var(--rl-label-size)',
                                        fontWeight: 500,
                                        letterSpacing: '0.08em',
                                        textTransform: 'var(--rl-label-transform)',
                                        color: 'var(--rl-muted)',
                                        px: '2px',
                                        pb: '2px',
                                    }}
                                >
                                    {currentRoomLabel}
                                </Box>
                                {renderRow(currentRoomEntry, true)}
                            </Box>
                        )}

                        {groups.map((group) => (
                            <Box
                                key={group.key}
                                sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '4px', minWidth: 0 }}
                            >
                                <Box
                                    sx={{
                                        fontSize: 'var(--rl-label-size)',
                                        fontWeight: 500,
                                        letterSpacing: '0.08em',
                                        textTransform: 'var(--rl-label-transform)',
                                        color: 'var(--rl-muted)',
                                        px: '2px',
                                        pb: '2px',
                                    }}
                                >
                                    {group.title}
                                </Box>
                                {group.rooms.map((room) => renderRow(room, false))}
                            </Box>
                        ))}
                    </Box>
                )}
            </Box>
        </Box>
    );
}
