import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Card, Chip, Stack, TextField, Typography } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { UnifiedComposer, type UnifiedComposerHandle } from '@/components/UnifiedComposer';
import { ReceivedText } from '@/components/received-item/Text';
import { ReceivedFile } from '@/components/received-item/File';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore, selectComposerDisabledEverywhere, selectComposerFullyHidden, selectVisibleReceived, type ReceivedItem } from '@/stores/appStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { isImageName, looksLikeTable, looksLikeTaskList } from '@/lib/util';

const TIMELINE_FILTER_KEY = 'timelineFilter';
const TIMELINE_FILTER_KEYS = ['all', 'text', 'image', 'file', 'task', 'table'] as const;
type TimelineFilter = (typeof TIMELINE_FILTER_KEYS)[number];

const FILTER_OPTIONS: Array<{ key: TimelineFilter; labelKey: string; icon: string }> = [
    { key: 'all', labelKey: 'filterAll', icon: 'mdi-timeline' },
    { key: 'text', labelKey: 'filterText', icon: 'mdi-text-box-outline' },
    { key: 'image', labelKey: 'filterImage', icon: 'mdi-image-outline' },
    { key: 'file', labelKey: 'filterFile', icon: 'mdi-file-outline' },
    { key: 'task', labelKey: 'filterTaskList', icon: 'mdi-checkbox-marked-outline' },
    { key: 'table', labelKey: 'filterTable', icon: 'mdi-table' },
];

/**
 * 标准模式（时间流）—— 从 web-vue3/src/views/modes/DefaultMode.vue 移植。
 *
 * ⚠️ 列表来源是 `selectVisibleReceived`（已套搜索），**不是** `received` ——
 * 否则搜索框只在部分模式生效，看着像坏了。计数、空态判断仍用 `received`。
 * ⚠️ 「图片」= 文件条目里文件名是图片扩展名的那些；「任务列表 / 表格」是**文本条目里的
 * markdown 结构**（用 lib/util 的判型，别在这里再抄一份正则）。
 */
export default function DefaultMode() {
    const { t } = useTranslation();
    const composerRef = useRef<UnifiedComposerHandle | null>(null);

    const display = useDisplaySettings();
    const received = useAppStore((s) => s.received);
    const searchQuery = useAppStore((s) => s.searchQuery);
    const setSearchQuery = useAppStore((s) => s.setSearchQuery);
    const historyLimit = useAppStore((s) => s.config?.server?.history || 0);

    const composerFullyHidden = useAppStore((s) => selectComposerFullyHidden(s));
    const composerDisabledEverywhere = useAppStore((s) => selectComposerDisabledEverywhere(s));

    const [filter, setFilter] = useState<TimelineFilter>(() => {
        const stored = localStorage.getItem(TIMELINE_FILTER_KEY);
        return (TIMELINE_FILTER_KEYS as readonly string[]).includes(stored || '') ? (stored as TimelineFilter) : 'all';
    });
    const setTimelineFilter = (key: TimelineFilter) => {
        setFilter(key);
        localStorage.setItem(TIMELINE_FILTER_KEY, key);
    };

    // 搜索条：开关打开，或者「纯预览模式」（所有模式都把发送区关掉）—— 后者是 Jonny 要求的「自动出现」。
    const showTimelineSearch = Boolean(display.timelineSearch || composerDisabledEverywhere);

    // ⚠️ 用 useMemo 组合而不是 `useAppStore(selectVisibleReceived)`：后者在「有搜索词」时
    // 每次返回**新数组**，Zustand v5 用 Object.is 比较 → 会无限重渲染。
    const visible = useMemo(() => selectVisibleReceived({ received, searchQuery }), [received, searchQuery]);
    const filtered = useMemo(() => {
        // 开关关掉时整个过滤不生效（不只是藏起分类条），否则列表会停在上次选的分类上，看着像内容丢了。
        if (!display.timelineFilter) return visible;
        if (filter === 'all') return visible;
        if (filter === 'text') return visible.filter((item) => item.type === 'text');
        if (filter === 'task') return visible.filter((item) => item.type === 'text' && looksLikeTaskList(String(item.content || '')));
        if (filter === 'table') return visible.filter((item) => item.type === 'text' && looksLikeTable(String(item.content || '')));
        const wantImage = filter === 'image';
        return visible.filter((item) => item.type === 'file' && isImageName(item.name) === wantImage);
    }, [visible, display.timelineFilter, filter]);

    // 新消息到达时吸顶（读者在顶部附近才跟随）。
    const prevCountRef = useRef(received.length);
    useEffect(() => {
        const prev = prevCountRef.current;
        prevCountRef.current = received.length;
        if (received.length > prev && window.scrollY < 120) {
            requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        }
    }, [received.length]);

    const focusComposer = useCallback((type?: string) => {
        requestAnimationFrame(() => composerRef.current?.focus(type));
    }, []);

    const historyUsageLabel = `${received.length}/${historyLimit}`;

    return (
        <Box>
            <PageToolbar variant="default" />
            <Box sx={{ maxWidth: 980, mx: 'auto', px: { xs: 1.5, md: 3 }, pb: 4, pt: 1 }}>
                {!composerFullyHidden && (
                    <Card variant="outlined" sx={{ borderRadius: 4, p: { xs: 0.5, md: 1.5 }, mb: 1, position: 'sticky', top: 8, zIndex: 2 }}>
                        <UnifiedComposer ref={composerRef} />
                    </Card>
                )}

                {received.length > 0 && showTimelineSearch && (
                    <Box sx={{ maxWidth: 420, mx: 'auto', mb: 1 }}>
                        <TextField
                            fullWidth
                            size="small"
                            value={searchQuery}
                            placeholder={t('searchPlaceholder')}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            slotProps={{
                                input: {
                                    startAdornment: <MdiIcon name="mdi-magnify" size={18} style={{ marginRight: 6 }} />,
                                },
                            }}
                        />
                    </Box>
                )}

                <Card variant="outlined" sx={{ borderRadius: 4, px: { xs: 1.5, md: 2.5 }, py: 1.5, minHeight: '24rem' }}>
                    {received.length > 0 && display.timelineFilter && (
                        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'center', pb: 1.5 }}>
                            {FILTER_OPTIONS.map((option) => (
                                <Chip
                                    key={option.key}
                                    size="small"
                                    icon={<MdiIcon name={option.icon} size={16} />}
                                    label={t(option.labelKey)}
                                    color={filter === option.key ? 'primary' : 'default'}
                                    variant={filter === option.key ? 'filled' : 'outlined'}
                                    onClick={() => setTimelineFilter(option.key)}
                                />
                            ))}
                        </Stack>
                    )}

                    {received.length > 0 && (
                        <Box sx={{ position: 'relative' }}>
                            {filtered.length > 0 && (
                                <Chip
                                    size="small"
                                    variant="outlined"
                                    color="primary"
                                    label={historyUsageLabel}
                                    sx={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', zIndex: 1 }}
                                />
                            )}
                            {filtered.map((item: ReceivedItem) => (
                                <Box key={item.id} sx={{ pt: item === filtered[0] ? 1.5 : 0 }}>
                                    {item.type === 'text' ? <ReceivedText meta={item} /> : <ReceivedFile meta={item} />}
                                </Box>
                            ))}
                            {filtered.length === 0 && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 3 }}>
                                    {t('filterEmpty')}
                                </Typography>
                            )}
                            {filtered.length > 0 && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', pt: 1 }}>
                                    {t('alreadyAtBottom')}
                                </Typography>
                            )}
                        </Box>
                    )}

                    {received.length === 0 && (
                        <Stack alignItems="center" spacing={1.5} sx={{ py: 6 }}>
                            <MdiIcon name="mdi-timeline" size={42} color="var(--mui-palette-primary-main)" />
                            <Typography variant="h6">{t('emptyTimelineTitle')}</Typography>
                            <Typography variant="body2" color="text.secondary">{t('timelineEmptySubtitle')}</Typography>
                            <Box sx={{ pt: 1 }}>
                                <Chip label={t('quickSend')} color="primary" onClick={() => focusComposer('text')} />
                            </Box>
                        </Stack>
                    )}
                </Card>
            </Box>
        </Box>
    );
}
