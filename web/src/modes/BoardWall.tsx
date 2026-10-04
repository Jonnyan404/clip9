import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Menu, MenuItem, Stack, Typography } from '@mui/material';
import axios from 'axios';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { BoardCardBody } from '@/components/board/BoardCardBody';
import { StickyComposer } from '@/components/sticky/StickyComposer';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore, type ReceivedItem } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { copyTextToClipboard, deviceLabel, errorMessage, formatTimestamp, isImageName, prettyFileSize } from '@/lib/util';
import { updateEntryColumn } from '@/services/share';

const COLUMNS = [
    { key: 'todo', labelKey: 'boardColumnTodo', icon: 'mdi-tray-arrow-down' },
    { key: 'doing', labelKey: 'boardColumnDoing', icon: 'mdi-progress-clock' },
    { key: 'done', labelKey: 'boardColumnDone', icon: 'mdi-check-circle-outline' },
] as const;

/**
 * 看板模式 —— 从 web-vue3/src/views/modes/BoardWall.vue 移植。
 *
 * ⚠️ 刻意做成**最小实现**：列固定三个、卡片就是普通条目（列只是条目上的一个字段）、
 * 不引入「列内顺序」（拖动只改「在哪一列」）。
 * ⚠️ 拖放用 HTML5 原生事件（桌面），**手机上拖不动** —— 所以每张卡片另有「移到」菜单。
 * ⚠️ 挪列是**乐观更新**：先动界面，失败再退回去（不回退的话「服务端没存上」会显示成成功）。
 */
export default function BoardWall() {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const received = useAppStore((s) => s.received);
    const historyLimit = useAppStore((s) => s.config?.server?.history || 0);

    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragOverColumn, setDragOverColumn] = useState('');
    const [savingId, setSavingId] = useState('');
    const [detailItem, setDetailItem] = useState<ReceivedItem | null>(null);
    const [moveMenu, setMoveMenu] = useState<{ anchor: HTMLElement; item: ReceivedItem } | null>(null);

    const columnOf = (item: ReceivedItem) => (item.column === 'doing' || item.column === 'done' ? item.column : 'todo');
    const itemsIn = (key: string) => received.filter((item) => columnOf(item) === key);

    const moveTo = async (item: ReceivedItem, column: string) => {
        if (columnOf(item) === column || savingId === item.id) return;
        // 乐观更新：先动界面，失败再退回去。
        const previous = item.column;
        useAppStore.setState({
            received: useAppStore.getState().received.map((entry) => (entry.id === item.id ? { ...entry, column } : entry)),
        });
        setSavingId(item.id);
        try {
            await updateEntryColumn(String(item.id), useWebSocketStore.getState().room, column);
        } catch (error) {
            console.error('挪动看板卡片失败:', error);
            useAppStore.setState({
                received: useAppStore.getState().received.map((entry) => (entry.id === item.id ? { ...entry, column: previous } : entry)),
            });
            toast(t('boardMoveFailed'));
        } finally {
            setSavingId('');
        }
    };

    const cardMeta = (item: ReceivedItem) => {
        const parts: string[] = [];
        if (display.timestamp && item.timestamp) parts.push(formatTimestamp(item.timestamp));
        if (display.device && item.senderDevice) {
            const device = deviceLabel(item.senderDevice);
            if (device) parts.push(device);
        }
        if (display.ip && item.senderIP) parts.push(String(item.senderIP));
        if (item.type === 'file' && item.size) parts.push(prettyFileSize(Number(item.size)));
        return parts.join(' · ');
    };

    const copyItemText = async (item: ReceivedItem) => {
        try {
            await copyTextToClipboard(String(item?.content || ''));
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    const deleteItem = async (item: ReceivedItem) => {
        try {
            await axios.delete(`revoke/${item.id}`, { params: new URLSearchParams([['room', useWebSocketStore.getState().room]]) });
            setDetailItem(null);
            toast(t('deleteSuccessText', { name: item.name || '' }));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedMessageMsg', { msg }) : t('deleteFailedMessage'));
        }
    };

    const historyUsageLabel = useMemo(() => `${received.length}/${historyLimit}`, [received.length, historyLimit]);

    return (
        // ⚠️★ `board-wall` 这个类名**必须留着**：看板那几个面板色（`--board-panel-bg` /
        // `--board-hairline` / `--board-hint`）由它（以及 `.dark .board-wall`）提供，
        // 而发送区（StickyComposer variant="board"）靠这几个变量取色。
        // 它同时也是与 Vue 版对齐的锚点 —— Vue 的 BoardWall 根节点就是这个类。
        // 少了它：浅色下靠 var() 兜底值看着还正常，**暗色下会白底配浅字**（等于看不见）。
        <Box className="board-wall" sx={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
            <PageToolbar variant="board" />
            <Box sx={{ flex: 1, minHeight: 0, width: '100%', maxWidth: 1200, mx: 'auto', px: 1.5, display: 'flex', flexDirection: 'column' }}>
                <Stack direction="row" justifyContent="space-between" sx={{ py: 1 }}>
                    <Typography variant="body2" fontWeight={500}>{t('uiModeBoard')}</Typography>
                    <Typography variant="caption" color="text.secondary">{historyUsageLabel}</Typography>
                </Stack>

                <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'minmax(0, 1fr)', gap: 1.25, overflowX: 'auto' }}>
                    {COLUMNS.map((column) => (
                        <Box
                            key={column.key}
                            onDragOver={(e) => { e.preventDefault(); setDragOverColumn(column.key); }}
                            onDragLeave={() => setDragOverColumn((prev) => (prev === column.key ? '' : prev))}
                            onDrop={(e) => {
                                e.preventDefault();
                                setDragOverColumn('');
                                const item = received.find((entry) => entry.id === draggingId);
                                setDraggingId(null);
                                if (item) void moveTo(item, column.key);
                            }}
                            sx={{
                                minHeight: 0,
                                display: 'flex',
                                flexDirection: 'column',
                                border: 1,
                                borderColor: dragOverColumn === column.key ? 'primary.main' : 'divider',
                                borderRadius: 2,
                                p: 0.75,
                            }}
                        >
                            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ pb: 1 }}>
                                <MdiIcon name={column.icon} size={16} />
                                <Typography variant="body2" fontWeight={500}>{t(column.labelKey)}</Typography>
                                <span style={{ flex: 1 }} />
                                <Typography variant="caption" color="text.secondary">{itemsIn(column.key).length}</Typography>
                            </Stack>
                            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                                {itemsIn(column.key).map((item) => (
                                    <Box
                                        key={item.id}
                                        draggable
                                        onDragStart={(e) => {
                                            setDraggingId(item.id);
                                            setDragOverColumn('');
                                            e.dataTransfer.effectAllowed = 'move';
                                            e.dataTransfer.setData('text/plain', String(item.id));
                                        }}
                                        onDragEnd={() => setDraggingId(null)}
                                        onClick={() => setDetailItem(item)}
                                        sx={{
                                            position: 'relative',
                                            border: 1,
                                            borderColor: 'divider',
                                            borderRadius: 1.5,
                                            bgcolor: 'background.paper',
                                            p: '7px 26px 7px 9px',
                                            cursor: 'grab',
                                            opacity: savingId === item.id ? 0.6 : 1,
                                        }}
                                    >
                                        <Stack direction="row" alignItems="flex-start" spacing={0.5}>
                                            {item.type === 'file' ? (
                                                <>
                                                    <MdiIcon name={isImageName(item.name) ? 'mdi-image-outline' : 'mdi-file-outline'} size={14} />
                                                    <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>{item.name || 'file'}</Typography>
                                                </>
                                            ) : (
                                                <BoardCardBody meta={item} />
                                            )}
                                        </Stack>
                                        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', mt: 0.5, fontSize: 10.5 }}>
                                            {cardMeta(item)}
                                        </Typography>
                                        <IconButton
                                            size="small"
                                            sx={{ position: 'absolute', top: 2, right: 2 }}
                                            onClick={(e) => { e.stopPropagation(); setMoveMenu({ anchor: e.currentTarget, item }); }}
                                            aria-label={t('boardMoveTo')}
                                        >
                                            <MdiIcon name="mdi-dots-vertical" size={14} />
                                        </IconButton>
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    ))}
                </Box>

                <Box sx={{ flexShrink: 0, pt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                        {t('boardNewCardIn', { column: t('boardColumnTodo') })}
                    </Typography>
                    <StickyComposer variant="board" />
                </Box>
            </Box>

            <Menu anchorEl={moveMenu?.anchor ?? null} open={Boolean(moveMenu)} onClose={() => setMoveMenu(null)}>
                {COLUMNS.map((target) => (
                    <MenuItem
                        key={target.key}
                        disabled={moveMenu ? columnOf(moveMenu.item) === target.key : false}
                        onClick={() => {
                            if (moveMenu) void moveTo(moveMenu.item, target.key);
                            setMoveMenu(null);
                        }}
                    >
                        <MdiIcon name={target.icon} size={16} style={{ marginRight: 8 }} />
                        {t(target.labelKey)}
                    </MenuItem>
                ))}
            </Menu>

            <Dialog open={Boolean(detailItem)} onClose={() => setDetailItem(null)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ letterSpacing: '0.04em' }}>
                        {detailItem?.type === 'file' ? 'FILE' : 'TEXT'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                        {detailItem?.timestamp ? formatTimestamp(detailItem.timestamp) : ''}
                    </Typography>
                    <IconButton size="small" onClick={() => setDetailItem(null)} aria-label={t('close')}>
                        <MdiIcon name="mdi-close" size={16} />
                    </IconButton>
                </DialogTitle>
                <DialogContent>
                    {detailItem?.type === 'file' ? (
                        <Stack direction="row" alignItems="center" spacing={1}>
                            <MdiIcon name={isImageName(detailItem.name) ? 'mdi-image-outline' : 'mdi-file-outline'} size={18} />
                            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{detailItem.name || 'file'}</Typography>
                            <Typography variant="caption" color="text.secondary">{prettyFileSize(Number(detailItem.size || 0))}</Typography>
                        </Stack>
                    ) : detailItem ? (
                        <BoardCardBody meta={detailItem} />
                    ) : null}
                    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 2, flexWrap: 'wrap' }}>
                        {detailItem && detailItem.type !== 'file' && (
                            <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-content-copy" size={16} />} onClick={() => copyItemText(detailItem)}>
                                {t('copyText')}
                            </Button>
                        )}
                        {detailItem && <ShareLinkButton meta={detailItem} iconOnly={false} />}
                        <span style={{ flex: 1 }} />
                        {detailItem && (
                            <Button size="small" variant="text" color="error" startIcon={<MdiIcon name="mdi-close-circle-outline" size={16} />} onClick={() => deleteItem(detailItem)}>
                                {t('delete')}
                            </Button>
                        )}
                    </Stack>
                </DialogContent>
            </Dialog>
        </Box>
    );
}
