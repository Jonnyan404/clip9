import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Stack, Typography } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { ActionChain } from '@/components/bench/ActionChain';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore, selectVisibleReceived, type ReceivedItem } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { decodeHtmlEntities, errorMessage, formatTimestamp } from '@/lib/util';
import { postText } from '@/services/send';

/**
 * 动作工作台 —— 从 web-vue3/src/views/modes/BenchWall.vue 移植。
 *
 * 和速览的区别（两个都是主从两栏）：速览是「**读**这条内容」（右侧只读预览）；
 * 工作台是「**加工**这条内容」（右侧是可叠多步的动作链 + 实时结果）。
 *
 * ⚠️ 只列**文本条目**（文件条目没有正文，取正文要另发请求，第一版不做）。
 * ⚠️ 这个模式**不改数据** —— 结果要落盘只能显式点「另存为新条目」（走现成的 `POST /text`）。
 * ⚠️ 上下键切换时，**焦点在输入框 / 可编辑元素里就不接管**（那里方向键是移光标）。
 */
export default function BenchWall() {
    const { t } = useTranslation();
    const itemsRef = useRef<HTMLDivElement | null>(null);

    const received = useAppStore((s) => s.received);
    const searchQuery = useAppStore((s) => s.searchQuery);

    // 数据源与标准模式/速览**共用** `selectVisibleReceived`（已含搜索过滤）。
    const items = useMemo(
        () => selectVisibleReceived({ received, searchQuery }).filter((item) => item.type === 'text'),
        [received, searchQuery],
    );

    const [draft, setDraft] = useState('');
    const [activeIndex, setActiveIndex] = useState(-1);

    const [isWide, setIsWide] = useState(() => window.innerWidth >= 1024);
    useEffect(() => {
        const onResize = () => setIsWide(window.innerWidth >= 1024);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // 服务端存的是 HTML 实体编码过的正文，填进来之前要还原回原文。
    const fillFrom = (item: ReceivedItem) => setDraft(decodeHtmlEntities(String(item.content || '')));

    const selectIndex = (index: number) => {
        if (index < 0 || index >= items.length) return;
        setActiveIndex(index);
        fillFrom(items[index]);
        requestAnimationFrame(() => {
            itemsRef.current?.querySelectorAll('.bench-wall__item')[index]?.scrollIntoView({ block: 'nearest' });
        });
    };

    // 首次有内容时自动填第一条 —— 一进这个模式就有东西可试（只在输入框还空着时填）。
    useEffect(() => {
        if (!draft && items.length) {
            setActiveIndex(0);
            fillFrom(items[0]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const el = event.target as HTMLElement | null;
            // ⚠️ 焦点在输入框 / 可编辑元素里时不接管（那里方向键是移光标）。
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            selectIndex(activeIndex < 0 ? 0 : activeIndex + delta);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    const saveAsNew = async (content: string) => {
        const body = String(content ?? '');
        if (!body) return;
        try {
            await postText({ room: useWebSocketStore.getState().room, text: body });
            toast(t('actionSaveAsNewDone'));
        } catch (error) {
            toast(errorMessage(error) || t('sendFailed'));
        }
    };

    const summary = (item: ReceivedItem) => decodeHtmlEntities(String(item.content || '')).replace(/\s+/g, ' ').trim() || t('shareHistoryText');

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }}>
            <PageToolbar />
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: isWide ? 'row' : 'column', gap: 1.25, p: '10px 12px 14px' }}>
                {/* 左：输入源 */}
                <Box
                    component="aside"
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                        flex: isWide ? '0 0 320px' : '0 0 30%',
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 2,
                        overflow: 'hidden',
                    }}
                >
                    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
                        <MdiIcon name="mdi-inbox-arrow-down-outline" size={14} />
                        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.04em' }}>{t('benchSourceTitle')}</Typography>
                        <span style={{ flex: 1 }} />
                        <Typography variant="caption" color="text.secondary">{items.length}</Typography>
                    </Stack>
                    <Box ref={itemsRef} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 0.75 }}>
                        {items.map((item, index) => (
                            <Box
                                key={item.id}
                                component="button"
                                type="button"
                                className="bench-wall__item"
                                onClick={() => selectIndex(index)}
                                sx={{
                                    display: 'flex',
                                    alignItems: 'baseline',
                                    gap: 1,
                                    width: '100%',
                                    textAlign: 'left',
                                    px: 1.125,
                                    py: 0.875,
                                    border: 1,
                                    borderColor: index === activeIndex ? 'primary.main' : 'transparent',
                                    borderRadius: 1.25,
                                    background: index === activeIndex ? 'action.selected' : 'none',
                                    cursor: 'pointer',
                                    fontSize: '0.75rem',
                                    color: 'inherit',
                                }}
                            >
                                <Typography variant="caption" sx={{ flex: '0 0 auto', fontSize: '0.625rem', color: 'text.secondary' }}>
                                    {formatTimestamp(item.timestamp)}
                                </Typography>
                                <Typography variant="caption" noWrap sx={{ flex: 1, minWidth: 0 }}>{summary(item)}</Typography>
                            </Box>
                        ))}
                        {!items.length && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 3 }}>
                                {t('benchEmpty')}
                            </Typography>
                        )}
                    </Box>
                </Box>

                {/* 右：输入框 + 动作链 + 结果 */}
                <Box
                    component="section"
                    sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', border: 1, borderColor: 'divider', borderRadius: 2, p: 1.5, overflow: 'hidden' }}
                >
                    <Box
                        component="textarea"
                        value={draft}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
                        placeholder={t('benchDraftPlaceholder')}
                        spellCheck={false}
                        sx={{
                            flex: '0 0 auto',
                            height: 88,
                            minHeight: 44,
                            resize: 'vertical',
                            border: 1,
                            borderColor: 'divider',
                            borderRadius: 1.25,
                            background: 'transparent',
                            p: '8px 10px',
                            mb: 1.25,
                            fontFamily: 'inherit',
                            fontSize: '0.75rem',
                            lineHeight: 1.55,
                            color: 'inherit',
                            outline: 'none',
                        }}
                    />
                    {draft ? (
                        <Box sx={{ flex: 1, minHeight: 0 }}>
                            <ActionChain text={draft} onSaveAsNew={(content) => void saveAsNew(content)} />
                        </Box>
                    ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ m: 'auto' }}>{t('benchDraftEmpty')}</Typography>
                    )}
                </Box>
            </Box>
        </Box>
    );
}
