import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/stores/toastStore';
import { Box, Card, Chip, Stack, TextField, Typography } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { UnifiedComposer, type UnifiedComposerHandle } from '@/components/UnifiedComposer';
import { ReceivedText } from '@/components/received-item/Text';
import { ReceivedFile } from '@/components/received-item/File';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore, selectComposerDisabledEverywhere, selectComposerFullyHidden, selectVisibleReceived, type ReceivedItem } from '@/stores/appStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { isFileEntry, isImageName, looksLikeTable, looksLikeTaskList } from '@/lib/util';

const TIMELINE_FILTER_KEY = 'timelineFilter';
/** `timestamp`（秒）→ **本地**的 `YYYY-MM-DD`。
 *
 * ⚠️★ 不用 `toISOString()`：那给的是 **UTC** 日，会把本地晚上的条目算到第二天 ——
 * 而服务端是按**本地日**分桶的（见 `clip9-core::stats`），两边对不上就会「跳错一天」，
 * 而且**不报错**。 */
function localDateOf(timestamp?: number): string {
    if (!timestamp) {
        return '';
    }
    const d = new Date(timestamp * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 每帧最多挂载多少条（见下面 `renderLimit` 那段注释）。 */
const FIRST_CHUNK = 12;
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
        return visible.filter((item) => isFileEntry(item) && isImageName(item.name) === wantImage);
    }, [visible, display.timelineFilter, filter]);

    // ⚠️★ 分批挂载：一帧只画 `FIRST_CHUNK` 条，剩下的用 rAF 一帧加一批。
    //
    // 为什么必须这么做：50 条卡片一次性渲染是**一个 ~250ms 的同步任务** ——
    // 主线程被占满，滚动、悬停、点按全部卡住（实测 ScriptDuration 218ms）。
    // 分成几帧之后总工作量不变（配 `memo` 之后也不重复），但**没有任何一帧是长的**，
    // 而且首屏只要画十几条 —— 切过去的那一下从 240ms 降到几十毫秒。
    // ⚠️ 只按 `filter` / `searchQuery` 重置，**不要按 `filtered` 的数组身份重置**：
    //    来一条新消息就会重算数组，那样会把已经展开的列表打回 12 条、再重放一遍。
    const [renderLimit, setRenderLimit] = useState(FIRST_CHUNK);
    useEffect(() => {
        setRenderLimit(FIRST_CHUNK);
    }, [filter, searchQuery]);

    useEffect(() => {
        if (renderLimit >= filtered.length) {
            return;
        }
        const id = requestAnimationFrame(() => {
            setRenderLimit((n) => Math.min(n + FIRST_CHUNK, filtered.length));
        });
        return () => cancelAnimationFrame(id);
    }, [renderLimit, filtered.length]);

    // ⚠️★ 热力图点了某一天 → 滚到那天的第一条（2026-10-07）。
    //
    // ⚠️ 信号走 store 而且**用掉就清**：留着的话下一次因为别的原因重渲染会再跳一次，
    // 表现是「页面自己乱跳」。
    const jumpToDay = useAppStore((s) => s.jumpToDay);
    useEffect(() => {
        if (!jumpToDay) {
            return;
        }
        useAppStore.setState({ jumpToDay: null });
        const index = filtered.findIndex((item) => localDateOf(item.timestamp) === jumpToDay);
        if (index < 0) {
            // ⚠️ 那一天可能已经被历史窗口裁掉了 —— 要**说清**，别静默跳到别的地方。
            toast(t('activityDayGone', { date: jumpToDay }));
            return;
        }
        // ⚠️★ 目标可能在**分批挂载**的后面（`renderLimit` 一帧只加 12 条）——
        // 所以先把 limit 撑到它，再等它真的挂出来才滚。少了这一步，
        // 对老房间（几百条）点最近一个月之外的那天会**什么都不发生**。
        setRenderLimit((n) => Math.max(n, index + 1));
        let tries = 0;
        const tick = () => {
            const node = document.querySelectorAll<HTMLElement>('.timeline-item')[index];
            if (node) {
                node.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            if (tries < 60) {
                tries += 1;
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    }, [jumpToDay, filtered, t]);

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
                    <Card
                        variant="outlined"
                        sx={{
                            borderRadius: 4,
                            p: { xs: 0.5, md: 1.5 },
                            mb: 1,
                            position: 'sticky',
                            // ⚠️ 吸顶位置要**让开工具栏的实际高度**（由 PageToolbar 写进这个 CSS 变量）。
                            // 写死 8px 的话，向上滚动时输入区会滑到工具栏底下被遮住一部分。
                            top: 'var(--page-toolbar-height, 0px)',
                            zIndex: 2,
                        }}
                    >
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
                                    // ⚠️ 窄屏只留图标（六个带字的分类在手机上会折成两行，白占一条横条的高度）。
                                    // 文案靠 chip 上的 aria-label 保住可访问性。
                                    label={<Box component="span" className="timeline-filter-label">{t(option.labelKey)}</Box>}
                                    aria-label={t(option.labelKey)}
                                    color={filter === option.key ? 'primary' : 'default'}
                                    variant={filter === option.key ? 'filled' : 'outlined'}
                                    onClick={() => setTimelineFilter(option.key)}
                                    sx={{
                                        '& .MuiChip-icon': { ml: 1, mr: 0.5 },
                                        '@media (max-width: 768px)': {
                                            '& .timeline-filter-label': { display: 'none' },
                                            '& .MuiChip-icon': { ml: '7px', mr: '7px' },
                                        },
                                    }}
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
                                    className="timeline-count-chip"
                                    label={historyUsageLabel}
                                    sx={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', zIndex: 1 }}
                                />
                            )}
                            {filtered.slice(0, renderLimit).map((item: ReceivedItem) => (
                                // ⚠️★ `timeline-item` 带着 `content-visibility: auto` ——
                                // 屏外卡片**不参与布局与绘制**，切换时省掉约 20%（实测中位 323→258ms）。
                                // 详见 components.css 里那段注释。
                                <Box
                                    key={item.id}
                                    className="timeline-item"
                                    sx={{ pt: item === filtered[0] ? 1.5 : 0 }}
                                >
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
