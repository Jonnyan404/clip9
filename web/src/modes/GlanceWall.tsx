import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Menu, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { GlancePreview } from '@/components/glance/GlancePreview';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore, selectVisibleReceived } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { useLocalRooms } from '@/hooks/useLocalRooms';
import { isFileEntry, isImageName, looksLikeTable, looksLikeTaskList } from '@/lib/util';

const WIDE_MIN = 500;
const TIMELINE_FILTER_KEY = 'timelineFilter';
const FILTER_OPTIONS = [
    { key: 'all', labelKey: 'filterAll' },
    { key: 'text', labelKey: 'filterText' },
    { key: 'image', labelKey: 'filterImage' },
    { key: 'file', labelKey: 'filterFile' },
    { key: 'task', labelKey: 'filterTaskList' },
    { key: 'table', labelKey: 'filterTable' },
] as const;

/**
 * 速览模式 —— 从 web-vue3/src/views/modes/GlanceWall.vue 移植。
 *
 * ⚠️ 主从两栏（左列表右预览）：单列里看一条完整内容要么展开卡片、要么开弹窗，两种都要
 * 「离开列表」；主从布局里选中即预览，这才是「查阅」。
 * ⚠️ 上下键导航必须 `preventDefault`（方向键默认是滚容器），且焦点通常在搜索框里 ——
 * 单行输入框里方向键本来就没有含义。
 * ⚠️ `WIDE_MIN` 是**唯一**一处宽窄阈值（Vue 版原来脚本与 CSS 各一份，会漂）。
 */
export default function GlanceWall() {
    const { t } = useTranslation();
    const { localRooms, createRoom, removeRoom, switchToRoom } = useLocalRooms();

    const received = useAppStore((s) => s.received);
    const searchQuery = useAppStore((s) => s.searchQuery);
    const setSearchQuery = useAppStore((s) => s.setSearchQuery);
    const room = useWebSocketStore((s) => s.room);

    const [filter, setFilter] = useState<string>(() => {
        const stored = localStorage.getItem(TIMELINE_FILTER_KEY);
        return FILTER_OPTIONS.some((option) => option.key === stored) ? (stored as string) : 'all';
    });
    const setTimelineFilter = (key: string) => {
        setFilter(key);
        localStorage.setItem(TIMELINE_FILTER_KEY, key);
    };

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [previewDialog, setPreviewDialog] = useState(false);
    const [roomMenuAnchor, setRoomMenuAnchor] = useState<HTMLElement | null>(null);
    const [newRoomOpen, setNewRoomOpen] = useState(false);
    const [newRoomName, setNewRoomName] = useState('');
    const rowsRef = useRef<HTMLDivElement | null>(null);

    const visible = useMemo(() => selectVisibleReceived({ received, searchQuery }), [received, searchQuery]);

    const filtered = useMemo(() => {
        if (filter === 'all') return visible;
        if (filter === 'text') return visible.filter((item) => item.type === 'text');
        if (filter === 'task') return visible.filter((item) => item.type === 'text' && looksLikeTaskList(String(item.content || '')));
        if (filter === 'table') return visible.filter((item) => item.type === 'text' && looksLikeTable(String(item.content || '')));
        const wantImage = filter === 'image';
        return visible.filter((item) => isFileEntry(item) && isImageName(item.name) === wantImage);
    }, [visible, filter]);

    // 一次遍历算完六个数（别对每个分类各 filter 一遍 —— 那是六趟）。
    const counts = useMemo(() => {
        const result: Record<string, number> = { all: visible.length, text: 0, image: 0, file: 0, task: 0, table: 0 };
        for (const item of visible) {
            if (item.type === 'text') {
                result.text += 1;
                if (looksLikeTaskList(String(item.content || ''))) result.task += 1;
                if (looksLikeTable(String(item.content || ''))) result.table += 1;
            } else if (isFileEntry(item)) {
                if (isImageName(item.name)) result.image += 1;
                else result.file += 1;
            }
        }
        return result;
    }, [visible]);

    const selected = filtered.find((item) => item.id === selectedId) || filtered[0] || null;

    // 宽窄判断只有这一处（初值用当前宽度算，避免窄屏先画一帧两栏）。
    const [isWide, setIsWide] = useState(() => window.innerWidth > WIDE_MIN);
    useEffect(() => {
        const sync = () => setIsWide(window.innerWidth > WIDE_MIN);
        window.addEventListener('resize', sync);
        return () => window.removeEventListener('resize', sync);
    }, []);

    const moveSelection = (step: number) => {
        if (!filtered.length) return;
        const current = filtered.findIndex((item) => item.id === selected?.id);
        const next = current < 0 ? 0 : current + step;
        if (next < 0 || next >= filtered.length) return;
        setSelectedId(filtered[next].id);
        requestAnimationFrame(() => {
            rowsRef.current?.querySelectorAll('.glance-wall__row')[next]?.scrollIntoView({ block: 'nearest' });
        });
    };

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            if (previewDialog || newRoomOpen) return;
            // ⚠️ 必须拦掉默认动作（方向键默认是滚容器）。
            event.preventDefault();
            moveSelection(event.key === 'ArrowDown' ? 1 : -1);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    const rowText = (item: typeof filtered[number]) => {
        if (isFileEntry(item)) return item.name || 'file';
        const text = String(item.content || '').replace(/\s+/g, ' ').trim();
        return text || t('emptyHere');
    };

    const timeGutter = (timestamp?: number) => {
        if (!timestamp) return '';
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
        if (timestamp >= todayStart) {
            return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        }
        if (timestamp >= todayStart - 86400) return t('dateYesterday');
        return `${date.getMonth() + 1}/${date.getDate()}`;
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
            <PageToolbar variant="glance" />
            <Box sx={{ flex: 1, minHeight: 0, width: '100%', maxWidth: 1200, mx: 'auto', px: 1.75, pb: 1.5, display: 'flex', flexDirection: 'column' }}>
                {/* 头部：搜索是这一屏的主操作，所以它不带外框、直接铺在头部 */}
                <Stack direction="row" alignItems="center" spacing={1} sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
                    <MdiIcon name="mdi-magnify" size={18} />
                    <Box
                        component="input"
                        value={searchQuery}
                        placeholder={t('glanceSearchPlaceholder', { count: received.length })}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                        sx={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'none', fontSize: 15, color: 'inherit' }}
                    />
                    {searchQuery && (
                        <IconButton size="small" onClick={() => setSearchQuery('')} aria-label={t('clear')}>
                            <MdiIcon name="mdi-close" size={16} />
                        </IconButton>
                    )}
                    <Button
                        size="small"
                        variant="outlined"
                        onClick={(e) => setRoomMenuAnchor(e.currentTarget)}
                        startIcon={<MdiIcon name="mdi-earth" size={14} />}
                    >
                        {room || t('publicRoom')}
                    </Button>
                    <Menu anchorEl={roomMenuAnchor} open={Boolean(roomMenuAnchor)} onClose={() => setRoomMenuAnchor(null)}>
                        {localRooms.map((r) => (
                            <MenuItem key={r || '__public__'} selected={room === r} onClick={() => { setRoomMenuAnchor(null); switchToRoom(r); }}>
                                {r || t('publicRoom')}
                                {r && (
                                    <IconButton size="small" sx={{ ml: 1 }} onClick={(e) => { e.stopPropagation(); removeRoom(r); }} aria-label={t('delete')}>
                                        <MdiIcon name="mdi-close" size={14} />
                                    </IconButton>
                                )}
                            </MenuItem>
                        ))}
                        <MenuItem onClick={() => { setRoomMenuAnchor(null); setNewRoomName(''); setNewRoomOpen(true); }}>
                            ＋ {t('workbenchNewRoom')}
                        </MenuItem>
                    </Menu>
                </Stack>

                {/* 分类 tab（文字 tab 比胶囊省横向空间） */}
                <Stack direction="row" spacing={2.25} sx={{ pt: 1.25, overflowX: 'auto', flexShrink: 0 }}>
                    {FILTER_OPTIONS.map((option) => (
                        <Box
                            key={option.key}
                            component="button"
                            type="button"
                            onClick={() => setTimelineFilter(option.key)}
                            sx={{
                                flexShrink: 0,
                                pb: 1,
                                border: 'none',
                                borderBottom: '2px solid',
                                borderColor: filter === option.key ? 'primary.main' : 'transparent',
                                background: 'none',
                                cursor: 'pointer',
                                fontSize: 13,
                                color: filter === option.key ? 'primary.main' : 'text.secondary',
                            }}
                        >
                            {t(option.labelKey)}
                            <span style={{ marginInlineStart: 5, fontSize: 11, opacity: 0.65 }}>{counts[option.key]}</span>
                        </Box>
                    ))}
                </Stack>

                {/* 两栏主从 */}
                <Box
                    sx={{
                        flex: 1,
                        minHeight: 0,
                        display: 'grid',
                        gridTemplateColumns: isWide ? 'minmax(0, min(300px, 38%)) minmax(0, 1fr)' : 'minmax(0, 1fr)',
                        gap: isWide ? 2 : 0,
                        pt: 1.25,
                    }}
                >
                    <Box ref={rowsRef} sx={{ minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                        {filtered.map((item) => (
                            <Box
                                key={item.id}
                                component="button"
                                type="button"
                                className="glance-wall__row"
                                onClick={() => {
                                    setSelectedId(item.id);
                                    if (!isWide) setPreviewDialog(true);
                                }}
                                sx={{
                                    display: 'flex',
                                    alignItems: 'baseline',
                                    gap: 1.25,
                                    width: '100%',
                                    px: 1,
                                    py: 0.875,
                                    border: 'none',
                                    borderRadius: 1,
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    background: selected?.id === item.id ? 'action.selected' : 'none',
                                    color: 'inherit',
                                }}
                            >
                                <span style={{ flex: '0 0 42px', fontSize: 11, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                                    {timeGutter(item.timestamp)}
                                </span>
                                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>{rowText(item)}</Typography>
                            </Box>
                        ))}
                        {!filtered.length && (
                            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
                                {received.length ? t('filterEmpty') : t('emptyTimelineTitle')}
                            </Typography>
                        )}
                    </Box>

                    {isWide && (
                        <Box sx={{ minHeight: 0, overflowY: 'auto', pl: 2, borderLeft: 1, borderColor: 'divider' }}>
                            <GlancePreview item={selected} />
                        </Box>
                    )}
                </Box>
            </Box>

            {/* 窄屏：预览是全屏弹窗（同一个 GlancePreview） */}
            <Dialog open={previewDialog} onClose={() => setPreviewDialog(false)} fullScreen>
                <DialogTitle sx={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>{t('preview')}</span>
                    <IconButton size="small" onClick={() => setPreviewDialog(false)} aria-label={t('close')}>
                        <MdiIcon name="mdi-close" size={18} />
                    </IconButton>
                </DialogTitle>
                <DialogContent>
                    <GlancePreview item={selected} />
                </DialogContent>
            </Dialog>

            <Dialog open={newRoomOpen} onClose={() => setNewRoomOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>{t('workbenchNewRoom')}</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        value={newRoomName}
                        placeholder={t('workbenchRoomPlaceholder')}
                        onChange={(e) => setNewRoomName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && createRoom(newRoomName)) setNewRoomOpen(false);
                        }}
                    />
                    <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
                        <Button variant="text" onClick={() => setNewRoomOpen(false)}>{t('cancel')}</Button>
                        <Button variant="contained" onClick={() => { if (createRoom(newRoomName)) setNewRoomOpen(false); }}>{t('workbenchCreate')}</Button>
                    </Stack>
                </DialogContent>
            </Dialog>
        </Box>
    );
}
