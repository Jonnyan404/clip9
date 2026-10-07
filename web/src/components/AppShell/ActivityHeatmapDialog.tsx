import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Box, CircularProgress, Dialog, DialogContent, DialogTitle, Stack, Typography,
} from '@mui/material';
import { errorMessage } from '@/lib/util';
import {
    ActivityUnsupported, ActivityBadResponse, HEATMAP_DAYS, fetchDailyActivity, legendLabels, levelOf,
    type DailyActivity, type DailyActivityResponse,
} from '@/services/stats';
import { useWebSocketStore } from '@/stores/wsStore';

/** 格子的边长与间距（GitHub 同款：11 + 3）。 */
const CELL = 11;
const GAP = 3;
/** 行标签那一列的宽度（「一 / 三 / 五」）。 */
const ROW_LABEL = 22;

/** `YYYY-MM-DD` → 星期几（**0 = 周一**）。 */
function weekdayOf(date: string): number {
    const [y, m, d] = date.split('-').map(Number);
    // ⚠️★ 用 `Date.UTC` + `getUTCDay`：`new Date("2026-10-07")` 是按 **UTC** 解析的，
    // 而 `getDay()` 取的是**本地**星期 —— 在 UTC-x 的时区里会把每格都算错一天。
    const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = 周日
    return (jsDay + 6) % 7; // 0 = 周一
}

/** 把每天摊进「列 = 周、行 = 周一…周日」的格子表，前面按需补空格。 */
function layout(days: DailyActivity['days']) {
    if (days.length === 0) {
        return { cells: [], columns: 0 };
    }
    const lead = weekdayOf(days[0].date);
    const slots: (DailyActivity['days'][number] | null)[] = Array.from({ length: lead }, () => null);
    slots.push(...days);
    // 尾部补齐，保证最后一列也是 7 行（否则最后一周会缺角，看起来像数据丢了）
    while (slots.length % 7 !== 0) {
        slots.push(null);
    }
    return { cells: slots, columns: slots.length / 7 };
}

/**
 * 房间活跃度热力图 —— 类 GitHub 贡献图。
 *
 * ⚠️★ 数据来自 `GET /stats/daily`，而 **`tz` 由这里给**（`localTimeZone()`）：
 * 服务端不知道看图的人在哪个时区，用 UTC 分桶会让东八区晚上的活跃落到第二天。
 *
 * ⚠️ 配色**跟着主题的 `primary` 走**（它可由「传统颜色」改）——
 * 写死绿色会出现「界面是红色系、图是绿色」的割裂。
 * 每档用 `color-mix` 把主色混进**纸色**（`background-paper`），于是深浅两个主题各自
 * 都得到一条正确的梯度；⚠️ 只调透明度是不行的 —— 深色下低透明会糊进背景。
 */
export function ActivityHeatmapDialog({
    open,
    onClose,
    onJumpToDay,
}: {
    open: boolean;
    onClose: () => void;
    /** 点某一格 → 让时间流跳到那天。⚠️ 没有它这张图就只是张装饰画。 */
    onJumpToDay?: (date: string) => void;
}) {
    const { t } = useTranslation();
    const room = useWebSocketStore((s) => s.room);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [data, setData] = useState<DailyActivityResponse | null>(null);
    const [focusIndex, setFocusIndex] = useState(0);
    const gridRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setData(await fetchDailyActivity({ room, days: HEATMAP_DAYS }));
        } catch (err) {
            // ⚠️★ 「后端还没有这个接口」要单独说：显示一句笼统的「读取失败」的话，
            // 用户会以为前端坏了，而**实际要做的去更新那个服务端**。
            // ⚠️★ 三类分开说（2026-10-07）：接口没有（去更新服务端）/ 回来的不是数据
            //（请求没打到服务端 —— dev 下 vite 的代理漏了 `/stats` 就是这个）/ 其它（网络、凭据）。
            setError(
                err instanceof ActivityUnsupported
                    ? t('activityUnsupported')
                    : err instanceof ActivityBadResponse
                        ? t('activityBadResponse')
                        : errorMessage(err) || t('activityLoadFailed'),
            );
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [room, t]);

    useEffect(() => {
        if (open) {
            void load();
        }
    }, [open, load]);

    const activity = data?.activity ?? null;
    const { cells } = useMemo(() => layout(activity?.days ?? []), [activity]);
    // ⚠️★ 初始焦点必须落在**真实的格子**上：下标 0 很可能是开头补位的空格子
    //（第一列不满一周时），而空格子没有 `tabIndex` —— 那样整个网格**一个都 Tab 不进去**，
    // 键盘用户完全够不着这张图。
    useEffect(() => {
        const last = cells.map((c) => Boolean(c)).lastIndexOf(true);
        setFocusIndex(last >= 0 ? last : 0);
    }, [cells]);
    const legend = activity ? legendLabels(activity.levels) : [];

    /** 键盘：上下 = ±1 天，左右 = ±7 天（一列）。⚠️ 与 GitHub 一致。 */
    const onKeyDown = (event: React.KeyboardEvent) => {
        const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
        if (step === undefined) {
            return;
        }
        event.preventDefault();
        const next = Math.min(Math.max(focusIndex + step, 0), Math.max(cells.length - 1, 0));
        setFocusIndex(next);
        const node = gridRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`);
        node?.focus();
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle sx={{ pb: 0.5 }}>{t('roomActivity')}</DialogTitle>
            <DialogContent>
                {loading && (
                    <Stack alignItems="center" sx={{ py: 6 }}>
                        <CircularProgress size={26} />
                    </Stack>
                )}

                {!loading && error && (
                    <Typography variant="body2" color="error" sx={{ py: 3 }}>
                        {error}
                    </Typography>
                )}

                {!loading && !error && activity && (
                    <>
                        {/* 这四个数就是「这个房间用得怎么样」的答案。 */}
                        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', mb: 1.5, rowGap: 0.5 }}>
                            <Typography variant="body2" color="text.secondary">
                                {t('activityTotal', { count: activity.total })}
                            </Typography>
                            {activity.busiest && (
                                <Typography variant="body2" color="text.secondary">
                                    {t('activityBusiest', { date: activity.busiest.date, count: activity.busiest.count })}
                                </Typography>
                            )}
                            <Typography variant="body2" color="text.secondary">
                                {t('activityStreak', { current: activity.streak.current, longest: activity.streak.longest })}
                            </Typography>
                        </Stack>

                        {activity.total === 0 ? (
                            // ⚠️ 空房间**不画空网格** —— 一张全灰的图看起来像加载失败。
                            <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
                                {t('activityEmpty')}
                            </Typography>
                        ) : (
                            <>
                                {data?.truncated && (
                                    // ⚠️ 撞了服务端的扫描上限就要说 —— 否则用户看到的是
                                    // 「数字比实际少」，而他没有任何办法知道。
                                    <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 1 }}>
                                        {t('activityTruncated')}
                                    </Typography>
                                )}
                                {/* ⚠️★ `role="grid"` / `tabIndex` / 键盘处理都挂在**真正的网格**上，
                                    不是外面那层滚动容器 —— 外面那层只是 `overflow-x`。
                                    挂错了的症状：`role="grid"` 的元素算不出 `gridTemplateRows`，
                                    读屏与自动化都拿不到「几行几列」。 */}
                                <Box sx={{ overflowX: 'auto', pb: 0.5 }}>
                                    <Box
                                        ref={gridRef}
                                        role="grid"
                                        tabIndex={0}
                                        onKeyDown={onKeyDown}
                                        aria-label={t('roomActivity')}
                                        sx={{
                                            display: 'grid',
                                            outline: 'none',
                                            gridTemplateRows: `repeat(7, ${CELL}px)`,
                                            gridAutoFlow: 'column',
                                            gridAutoColumns: `${CELL}px`,
                                            gap: `${GAP}px`,
                                            // 行标签那一列占位（用 padding 而不是再塞一列格子）
                                            ml: `${ROW_LABEL}px`,
                                            width: 'max-content',
                                        }}
                                    >
                                        {cells.map((cell, index) => {
                                            if (!cell) {
                                                return <Box key={`blank-${index}`} sx={{ width: CELL, height: CELL }} />;
                                            }
                                            const level = levelOf(cell.count, activity.levels);
                                            return (
                                                <Box
                                                    key={cell.date}
                                                    data-index={index}
                                                    role="gridcell"
                                                    tabIndex={index === focusIndex ? 0 : -1}
                                                    aria-label={t('activityCell', { date: cell.date, count: cell.count })}
                                                    title={t('activityCell', { date: cell.date, count: cell.count })}
                                                    onClick={() => {
                                                        onJumpToDay?.(cell.date);
                                                        onClose();
                                                    }}
                                                    onFocus={() => setFocusIndex(index)}
                                                    sx={{
                                                        width: CELL,
                                                        height: CELL,
                                                        borderRadius: '2px',
                                                        cursor: 'pointer',
                                                        // ⚠️★ 空格子用**中性灰**（拿文字色混一点），
                                                        // 不是透明 —— 透明的格子在深色主题下会消失，
                                                        // 整张图看起来像缺了几块。
                                                        bgcolor:
                                                            level === 0
                                                                ? 'color-mix(in srgb, var(--mui-palette-text-primary) 8%, transparent)'
                                                                : `color-mix(in srgb, var(--mui-palette-primary-main) ${
                                                                    [0, 25, 45, 70, 100][level]
                                                                }%, var(--mui-palette-background-paper))`,
                                                        '&:focus-visible': {
                                                            outline: '2px solid var(--mui-palette-primary-main)',
                                                            outlineOffset: '1px',
                                                        },
                                                    }}
                                                />
                                            );
                                        })}
                                    </Box>
                                </Box>

                                {/* 图例 ⚠️ 必须带**实际区间**：分档是相对这个房间的，
                                    所以不同房间的同一个颜色不代表同一个条数。 */}
                                <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 1.5, ml: `${ROW_LABEL}px` }}>
                                    <Typography variant="caption" color="text.secondary">
                                        {t('activityLess')}
                                    </Typography>
                                    {[0, 1, 2, 3, 4].map((level) => (
                                        <Box
                                            key={level}
                                            sx={{
                                                width: CELL,
                                                height: CELL,
                                                borderRadius: '2px',
                                                bgcolor:
                                                    level === 0
                                                        ? 'color-mix(in srgb, var(--mui-palette-text-primary) 8%, transparent)'
                                                        : `color-mix(in srgb, var(--mui-palette-primary-main) ${
                                                            [0, 25, 45, 70, 100][level]
                                                        }%, var(--mui-palette-background-paper))`,
                                            }}
                                        />
                                    ))}
                                    <Typography variant="caption" color="text.secondary">
                                        {t('activityMore')}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
                                        {legend.join(' · ')}
                                    </Typography>
                                </Stack>
                            </>
                        )}

                        {/* ⚠️ 把**实际用的**时区说出来：认不出来的名字会回落成 UTC
                            （`requestedTz` 是空串也一样 —— 那说明浏览器没给出时区），
                            不说的话用户会以为图是按他的时区画的，从而怀疑数据。 */}
                        {data && data.tz !== data.requestedTz && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                {t('activityTzFallback', { tz: data.tz })}
                            </Typography>
                        )}
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
