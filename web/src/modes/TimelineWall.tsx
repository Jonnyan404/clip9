import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Chip } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { StickyComposer, type StickyComposerHandle } from '@/components/sticky/StickyComposer';
import {
    categoriesOf, TIMELINE_FILTERS, filterMatches, categoryLabelKey,
    type TimelineCategory, type TimelineFilter,
} from '@/components/timeline/categories';
import { TimelineRow } from '@/components/timeline/TimelineRow';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { localDateKey } from '@/lib/util';
import { selectVisibleReceived, useAppStore, type ReceivedItem } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';

const FILTER_STORAGE_KEY = 'timelineFilter';

/**
 * 时间线模式（方案 B：日志流）。
 *
 * 与标准模式的区别**不在样式，在密度**：按日分块，一条一行；短内容不展开也能判断要不要复制。
 * 展开才挂 `GlancePreview`（正文渲染 / 文件预览 / 下载分享删除都在那儿），收起态一行不跑 markdown。
 *
 * ⚠️★ 分类条与搜索是**这个模式自己的头部**，不读 `display.timelineFilter` / `timelineSearch`：
 *    那两个开关的注释写明是「标准模式的时间流」专属（`modes: ['default']`），
 *    在新模式里放一个拨了没反应的开关比不放更糟。
 * ⚠️★ 输入区两个开关都关掉时**不渲染** `StickyComposer`：它在「不能发」时会退化成搜索框，
 *    而这一屏的头部已经有搜索框了 —— 并排两个搜索框只会让人不知道哪个算数。
 * ⚠️ 按日分组的键用 `lib/util` 的 `localDateKey`（本地日）—— 与热力图跳转同一份实现，
 *    别在这里再写一次 `new Date(...)` 拼日期。
 */
export default function TimelineWall() {
    const { t, i18n } = useTranslation();
    const display = useDisplaySettings();
    const composerRef = useRef<StickyComposerHandle | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const received = useAppStore((s) => s.received);
    const searchQuery = useAppStore((s) => s.searchQuery);
    const setSearchQuery = useAppStore((s) => s.setSearchQuery);
    const historyLimit = useAppStore((s) => s.config?.server?.history || 0);

    const [filter, setFilter] = useState<TimelineFilter>(() => {
        const stored = localStorage.getItem(FILTER_STORAGE_KEY);
        return TIMELINE_FILTERS.some((option) => option.key === stored) ? (stored as TimelineFilter) : 'all';
    });
    const changeFilter = (next: TimelineFilter) => {
        setFilter(next);
        localStorage.setItem(FILTER_STORAGE_KEY, next);
    };

    const [foldedDays, setFoldedDays] = useState<Set<string>>(() => new Set());
    const toggleDay = useCallback((key: string) => {
        setFoldedDays((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const toggleRow = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // 切房间时清掉展开 / 折叠状态：条目 id 是**每个房间各自**的，跨房间保留会让新房间的
    // 第 5 条莫名其妙地是展开的（两个房间都有 id=5）。
    const room = useWebSocketStore((s) => s.room);
    const prevRoomRef = useRef(room);
    useEffect(() => {
        if (prevRoomRef.current === room) return;
        prevRoomRef.current = room;
        setExpandedIds(new Set());
        setFoldedDays(new Set());
    }, [room]);

    // ⚠️ 用 useMemo 组合而不是 `useAppStore(selectVisibleReceived)`：有搜索词时它每次返回**新数组**，
    // Zustand v5 用 Object.is 比较，会无限重渲染（标准模式里踩过）。
    const visible = useMemo(() => selectVisibleReceived({ received, searchQuery }), [received, searchQuery]);

    // 分类只算一遍：筛选、计数、日头摘要、行图标都读它。判型走 `categories.ts`（单点）。
    const categories = useMemo(() => categoriesOf(visible), [visible]);

    const filtered = useMemo(() => {
        if (filter === 'all') return visible;
        return visible.filter((item) => filterMatches(categories.get(item.id) || 'text', filter));
    }, [visible, categories, filter]);

    const counts = useMemo(() => {
        const result: Record<TimelineFilter, number> = { all: visible.length, text: 0, image: 0, file: 0, task: 0, table: 0 };
        for (const item of visible) {
            const category = categories.get(item.id) || 'text';
            if (category === 'text' || category === 'task' || category === 'table') result.text += 1;
            if (category === 'image') result.image += 1;
            if (category === 'file') result.file += 1;
            if (category === 'task') result.task += 1;
            if (category === 'table') result.table += 1;
        }
        return result;
    }, [visible, categories]);

    /**
     * 按本地日分组。顺序**沿用 store 的顺序**（最新在前）—— 插进 Map 的第一条决定这一天出现的位置，
     * 别再排一次（那会把「今天」排到最后）。
     */
    const groups = useMemo(() => {
        const map = new Map<string, ReceivedItem[]>();
        for (const item of filtered) {
            const key = localDateKey(item.timestamp);
            const list = map.get(key);
            if (list) list.push(item);
            else map.set(key, [item]);
        }
        return [...map.entries()].map(([key, items]) => ({ key, items }));
    }, [filtered]);

    const todayKey = localDateKey(Math.floor(Date.now() / 1000));
    const canCompose = Boolean(display.composerText || display.composerUpload);

    // ── 热力图点了某一天 → 展开并滚到那天的块首 ─────────────────────────────
    // ⚠️ 信号是**一次性**的：用掉就清，否则下一次因别的原因重渲染会再跳一次（标准模式同样的约定）。
    // ⚠️ 只展开、不依赖「展开后再滚」：日头一直在 DOM 里，滚到 section 顶部即可，body 长出来也不挪位置。
    const jumpToDay = useAppStore((s) => s.jumpToDay);
    useEffect(() => {
        if (!jumpToDay) return;
        useAppStore.setState({ jumpToDay: null });
        if (!groups.some((group) => group.key === jumpToDay)) {
            toast(t('activityDayGone', { date: jumpToDay }));
            return;
        }
        setFoldedDays((prev) => {
            if (!prev.has(jumpToDay)) return prev;
            const next = new Set(prev);
            next.delete(jumpToDay);
            return next;
        });
        const target = scrollRef.current?.querySelector<HTMLElement>(`[data-day="${jumpToDay}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [jumpToDay, groups, t]);

    // 新消息到达时吸顶（读者在顶部附近才跟随）。
    const prevCountRef = useRef(received.length);
    useEffect(() => {
        const prev = prevCountRef.current;
        prevCountRef.current = received.length;
        if (received.length > prev) {
            const el = scrollRef.current;
            if (el && el.scrollTop < 120) {
                requestAnimationFrame(() => el.scrollTo({ top: 0, behavior: 'smooth' }));
            }
        }
    }, [received.length]);

    return (
        <Box className="timeline-wall" sx={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
            <PageToolbar variant="timeline" />
            <Box sx={{ flex: 1, minHeight: 0, width: '100%', maxWidth: 980, mx: 'auto', px: { xs: 1.5, md: 2.5 }, display: 'flex', flexDirection: 'column' }}>
                <div className="timeline-wall__head">
                    <span className="timeline-wall__title">{t('uiModeTimeline')}</span>
                    <span className="timeline-wall__usage">{received.length}/{historyLimit}</span>
                    <div className="timeline-wall__search">
                        <MdiIcon name="mdi-magnify" size={14} />
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={t('searchPlaceholder')}
                            aria-label={t('searchPlaceholder')}
                        />
                    </div>
                </div>

                <div className="timeline-wall__filters">
                    {TIMELINE_FILTERS.map((option) => (
                        <Chip
                            key={option.key}
                            className="timeline-filter-chip"
                            size="small"
                            icon={<MdiIcon name={option.icon} size={15} />}
                            label={(
                                <Box component="span" className="timeline-filter-label">
                                    {t(option.labelKey)}
                                    <span className="timeline-filter-count">{counts[option.key]}</span>
                                </Box>
                            )}
                            aria-label={t(option.labelKey)}
                            color={filter === option.key ? 'primary' : 'default'}
                            variant={filter === option.key ? 'filled' : 'outlined'}
                            onClick={() => changeFilter(option.key)}
                            sx={{ '& .MuiChip-icon': { ml: 1, mr: 0.5 } }}
                        />
                    ))}
                </div>

                {canCompose && (
                    <Box sx={{ flexShrink: 0, pb: 1.25 }}>
                        <StickyComposer ref={composerRef} variant="timeline" />
                    </Box>
                )}

                <Box ref={scrollRef} className="timeline-wall__scroll">
                    {groups.map((group) => {
                        const folded = foldedDays.has(group.key);
                        const bars = dayBars(group.items);
                        const summary = dayCategoryCounts(group.items, categories);
                        const { label, week } = dayLabels(group.key, i18n.language);
                        return (
                            <section
                                key={group.key || 'unknown'}
                                className={`timeline-day${folded ? ' is-folded' : ''}`}
                                data-day={group.key}
                            >
                                <button
                                    type="button"
                                    className="timeline-day__head"
                                    aria-expanded={!folded}
                                    title={folded ? t('timelineExpandDay') : t('timelineCollapseDay')}
                                    onClick={() => toggleDay(group.key)}
                                >
                                    <span className="timeline-day__date">{label}</span>
                                    <span className="timeline-day__week">{week}</span>
                                    {group.key === todayKey && <span className="timeline-day__today">{t('timelineToday')}</span>}
                                    {bars.length > 0 && (
                                        <span
                                            className="timeline-day__hist"
                                            aria-hidden="true"
                                            title={bars.map((bar) => `${String(bar.hour).padStart(2, '0')}:00 · ${t('timelineDayCount', { count: bar.count })}`).join(' / ')}
                                        >
                                            <span className="timeline-day__track" />
                                            {bars.map((bar) => (
                                                <span
                                                    key={bar.hour}
                                                    className="timeline-day__bar"
                                                    style={{ left: `${(bar.hour / 24) * 100}%`, height: bar.height }}
                                                    title={`${String(bar.hour).padStart(2, '0')}:00 · ${t('timelineDayCount', { count: bar.count })}`}
                                                />
                                            ))}
                                        </span>
                                    )}
                                    {summary.length > 0 && (
                                        <span className="timeline-day__types">
                                            {summary.slice(0, 3).map(([category, count]) => (
                                                <span key={category} className="timeline-day__type" data-category={category}>
                                                    {t(categoryLabelKey(category))} {count}
                                                </span>
                                            ))}
                                            {summary.length > 3 && (
                                                <span className="timeline-day__type timeline-day__type--more">
                                                    +{summary.slice(3).reduce((sum, [, count]) => sum + count, 0)}
                                                </span>
                                            )}
                                        </span>
                                    )}
                                    <span className="timeline-day__count">{t('timelineDayCount', { count: group.items.length })}</span>
                                    <MdiIcon name="mdi-chevron-down" size={16} className="timeline-day__caret" />
                                </button>
                                {!folded && (
                                    <div className="timeline-day__body">
                                        {group.items.map((item) => (
                                            <TimelineRow
                                                key={item.id}
                                                meta={item}
                                                category={categories.get(item.id) || 'text'}
                                                expanded={expandedIds.has(item.id)}
                                                onToggle={toggleRow}
                                            />
                                        ))}
                                    </div>
                                )}
                            </section>
                        );
                    })}

                    {groups.length === 0 && (
                        <div className="timeline-wall__empty">
                            <MdiIcon name="mdi-timeline-text-outline" size={38} color="var(--mui-palette-primary-main)" />
                            {received.length > 0 ? (
                                <span>{t('filterEmpty')}</span>
                            ) : (
                                <>
                                    <strong>{t('timelineEmptyTitle')}</strong>
                                    <span>{t('timelineEmptySubtitle')}</span>
                                    {canCompose && (
                                        <Button size="small" variant="contained" onClick={() => composerRef.current?.focus()}>
                                            {t('quickSend')}
                                        </Button>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </Box>
            </Box>
        </Box>
    );
}

/** 本地日 → 日期 / 星期文案。用**界面语言**（不是系统语言）格式化，四个语言包里不用再各存一份月名。 */
function dayLabels(key: string, locale?: string): { label: string; week: string } {
    const [year, month, day] = key.split('-').map(Number);
    if (!year || !month || !day) {
        return { label: '—', week: '' };
    }
    const date = new Date(year, month - 1, day);
    return {
        label: date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
        week: date.toLocaleDateString(locale, { weekday: 'short' }),
    };
}

/** 日头的小时分布柱：**按 24 小时的比例定位**（不是只按先后排），高度按当天最大值归一。
 *  ⚠️ 只有一条记录时也要画：那是「这一条在几点」的唯一图形线索，藏起来会让人以为功能没生效。 */
function dayBars(items: ReceivedItem[]): Array<{ hour: number; count: number; height: number }> {
    const counts = new Map<number, number>();
    for (const item of items) {
        if (!item.timestamp) continue;
        const hour = new Date(item.timestamp * 1000).getHours();
        counts.set(hour, (counts.get(hour) || 0) + 1);
    }
    const max = Math.max(1, ...counts.values());
    return [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, count]) => ({ hour, count, height: 3 + Math.round((count / max) * 11) }));
}

/** 日头的类型摘要（按出现顺序；超过三种由调用方折成 `+N`）。 */
function dayCategoryCounts(
    items: ReceivedItem[],
    categories: Map<string, TimelineCategory>,
): Array<[TimelineCategory, number]> {
    const counts = new Map<TimelineCategory, number>();
    for (const item of items) {
        const category = categories.get(item.id) || 'text';
        counts.set(category, (counts.get(category) || 0) + 1);
    }
    return [...counts.entries()];
}
