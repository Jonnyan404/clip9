import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Stack, Typography } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { StickyNote } from '@/components/sticky/StickyNote';
import { StickyComposer, type StickyComposerHandle } from '@/components/sticky/StickyComposer';
import { useAppStore, selectVisibleReceived } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { useStickyAutoscroll } from '@/hooks/useStickyAutoscroll';
import { useMemo } from 'react';
import { prettyFileSize } from '@/lib/util';
import { toast } from '@/stores/toastStore';

/**
 * 便签墙 —— 从 web-vue3/src/views/modes/StickyWall.vue 移植。
 *
 * ⚠️ 顺序直接用 `visibleReceived`（store 里 `mergeMessages` 按时间倒序排，**最新的在最前**）——
 * 不要再 `.reverse()`（那是「最新在底部」的老语义）。
 * ⚠️ 拖放：整个页面都是落点，`dragenter/dragleave` 用深度计数避免子元素抖动。
 */
export default function StickyWall() {
    const { t } = useTranslation();
    const composerRef = useRef<StickyComposerHandle | null>(null);
    const streamRef = useRef<HTMLDivElement | null>(null);

    const received = useAppStore((s) => s.received);
    const searchQuery = useAppStore((s) => s.searchQuery);
    const historyLimit = useAppStore((s) => s.config?.server?.history || 0);
    const fileLimit = useAppStore((s) => s.config?.file?.limit || 0);
    const room = useWebSocketStore((s) => s.room);

    const items = useMemo(() => selectVisibleReceived({ received, searchQuery }), [received, searchQuery]);
    // 吸顶自动滚动：新消息到达时（读者在顶部附近才跟随）。返回的 pinToTop 供 composer 用，
    // 这里暂不接（发送后由用户的滚动位置决定），所以不取用。
    useStickyAutoscroll(streamRef, { items: () => items, room: () => room });

    const [dragover, setDragover] = useState(false);
    const dragDepth = useRef(0);

    const onDrop = (event: React.DragEvent) => {
        dragDepth.current = 0;
        setDragover(false);
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return;
        if (files.some((file) => !file.size)) {
            toast(t('cannotSendEmptyFile'));
            return;
        }
        if (files.some((file) => file.size > fileLimit)) {
            toast(t('fileSizeExceeded', { limit: prettyFileSize(fileLimit) }));
            return;
        }
        composerRef.current?.addFiles(files);
    };

    const historyUsageLabel = `${received.length}/${historyLimit}`;

    return (
        <Box
            onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragover(true); }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragover(false); }}
            onDrop={(e) => { e.preventDefault(); onDrop(e); }}
            sx={{
                display: 'flex',
                flexDirection: 'column',
                height: '100dvh',
                bgcolor: dragover ? 'rgba(217,119,6,0.06)' : 'transparent',
            }}
        >
            <PageToolbar variant="sticky" />
            {/* 拖放高亮：整个页面都是落点，这块提示只在拖拽期间出现 */}
            {dragover && (
                <Box
                    sx={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 999,
                        bgcolor: 'rgba(217,119,6,0.14)',
                        backdropFilter: 'blur(2px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                        fontSize: 20,
                        fontWeight: 700,
                        color: '#d97706',
                        border: '3px dashed #d97706',
                    }}
                >
                    {t('stickyDropHere')}
                </Box>
            )}
            <Box sx={{ width: '100%', maxWidth: 1100, mx: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', px: 2, pb: 3 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ pt: 2.25, pb: 1.25, flexShrink: 0 }}>
                    <span>📌</span>
                    <Typography variant="body2" fontWeight={700}>
                        {historyUsageLabel} {t('uiModeStickyCount')}
                    </Typography>
                </Stack>

                {received.length > 0 ? (
                    <Box
                        ref={streamRef}
                        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexWrap: 'wrap', gap: 1.75, py: 1.75, alignContent: 'flex-start' }}
                    >
                        {items.map((item) => (
                            <Box key={item.id} sx={{ flex: '1 1 220px', maxWidth: '100%', minWidth: 0, display: 'flex' }}>
                                <StickyNote meta={item} />
                            </Box>
                        ))}
                    </Box>
                ) : (
                    <Stack alignItems="center" spacing={1.5} sx={{ flex: 1, justifyContent: 'center', border: '1.5px dashed', borderColor: 'divider', borderRadius: 2 }}>
                        <Typography variant="h6">{t('emptyTimelineTitle')}</Typography>
                        <Typography variant="body2" color="text.secondary">{t('timelineEmptySubtitle')}</Typography>
                        <Button size="small" variant="contained" onClick={() => composerRef.current?.focus()}>{t('quickSend')}</Button>
                    </Stack>
                )}

                <Box sx={{ flexShrink: 0, pt: 1.75 }}>
                    <StickyComposer ref={composerRef} />
                </Box>
            </Box>
        </Box>
    );
}
