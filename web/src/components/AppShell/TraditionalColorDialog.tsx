import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Tab, Tabs, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useColorScheme } from '@mui/material/styles';
import { traditionalColorGroups } from '@/data/traditionalColors.js';
import { useThemeStore } from '@/stores/themeStore';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { SURFACE_DARK, SURFACE_LIGHT, paletteScopeOf, readableOn } from '@/lib/contrast';

/** 色块的边长。⚠️ 与悬停时的放大倍数一起决定了「会不会挤到邻居」。 */
const SWATCH = 34;

type Scope = 'light' | 'dark';

const groupList = traditionalColorGroups as Array<{ name: string; colors: Array<{ name: string; hex: string }> }>;

/** 点了「两套都用」之后，按钮上的确认文案停留多久。 */
const APPLIED_MS = 2000;

/**
 * 中华传统色选择。
 *
 * # ⚠️★ 2026-11-26 改成「按适配的配色分两组」
 *
 * 原来是一个 742 个色块的平铺大表，点谁就是给**当前明暗**那一套换主色。三个问题：
 *
 * 1. **找不到能用的色**：742 个里有一半在浅色模式下几乎看不见（乳白、茉莉黄、粉彩），
 *    用户得先点一下、看背后的界面变没变，才知道这个色能不能用。
 * 2. **想给另一套挑色必须先切模式**：切过去界面全变、设置页也跟着重排，很打断。
 * 3. **「两套都用」点了没反馈**：它只改**另一个**模式那一份，当前界面一个像素都不变 ——
 *    看起来就像按钮坏了（用户原话）。
 *
 * 现在的做法：
 * · 顶部两个页签 = **要改哪一套**，同时**只显示适合那一套的色**（`paletteScopeOf`，
 *   判据在 `check-display-semantics.mjs`：浅色系对浅底 ≥3:1、深色系对深底 ≥4.5:1）。
 * · 每个页签顶上有**一条预览**，用那一套的底色 + 当前主色画出来 —— 改的是哪一套都看得见效果。
 *   这是「点击没反馈」的正解：反馈不能依赖「背后的界面变了」。
 * · 底部补了**关闭**按钮（原来只能点遮罩或按 Esc 退出）。
 *
 * # 历史（2026-10-07 修的三件事，仍然有效）
 *
 * 1. 色块原来是内联 `style`，没有 `:hover` / `:focus-visible`，鼠标划过去什么都没有。
 * 2. 组件不读当前主色，用户看不出现在用的是哪一个。
 * 3. 悬停态与选中态要能分辨 —— 悬停是**放大 + 中性灰环**（临时的），
 *    选中是**主题色环 + 对勾**（持久的）。
 *
 * ⚠️ 点击的即时反馈靠**状态本身**：`setPrimary` 同步写 store + localStorage，
 *    `<ThemeProvider>` 当拍用新主色重建主题 —— 环与对勾立刻到位。
 */
export function TraditionalColorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { mode } = useColorScheme();
    const isDark = mode === 'dark';

    // ⚠️ 两套都订阅：选中的环要按**当前页签**那一份画，不是按当前明暗模式。
    const primaryLight = useThemeStore((s) => s.primaryLight);
    const primaryDark = useThemeStore((s) => s.primaryDark);
    const setPrimary = useThemeStore((s) => s.setPrimary);
    const setPrimaryBoth = useThemeStore((s) => s.setPrimaryBoth);

    const [scope, setScope] = useState<Scope>(isDark ? 'dark' : 'light');
    const [applied, setApplied] = useState(false);

    // ⚠️ 每次打开都回到「当前明暗模式」那个页签：对话框是常挂载的（`open={false}` 不卸载），
    //    不重置的话，上次看的是深色页签，这次在浅色模式下打开还停在深色页签上。
    useEffect(() => {
        if (open) {
            setScope(isDark ? 'dark' : 'light');
            setApplied(false);
        }
    }, [open, isDark]);

    // 确认文案自己退场，不用用户去关
    useEffect(() => {
        if (!applied) {
            return undefined;
        }
        const id = window.setTimeout(() => setApplied(false), APPLIED_MS);
        return () => window.clearTimeout(id);
    }, [applied]);

    const activePrimary = scope === 'dark' ? primaryDark : primaryLight;

    /**
     * 当前页签下要显示的色 —— **在这里就筛掉**，不是渲染时 `display:none`。
     *
     * ⚠️ 只在 `scope` 变化时重算：742 次对比度计算虽然只要 1–2ms，
     *    但列表里每个色块 hover 都会让父组件重渲染，没必要每帧重算一遍。
     */
    const sections = useMemo(
        () =>
            groupList
                .map((group) => ({ name: group.name, colors: group.colors.filter((c) => paletteScopeOf(c.hex) === scope) }))
                .filter((section) => section.colors.length > 0),
        [scope],
    );

    const isSelected = (hex: string) => hex.toLowerCase() === activePrimary.toLowerCase();

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle>
                {t('traditionalColors')}
                <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
                    {t('themeClassifyHint')}
                </Typography>
            </DialogTitle>
            <Tabs value={scope} onChange={(_event, value: Scope) => setScope(value)} variant="fullWidth" sx={{ borderBottom: 1, borderColor: 'divider' }}>
                <Tab value="light" label={t('themeColorsLightTab')} />
                <Tab value="dark" label={t('themeColorsDarkTab')} />
            </Tabs>
            {/* 预览条 —— 这一套的底色 + 当前主色。改的是哪一套，效果都在这里看得见。
                ⚠️★ 必须放在**滚动区之外**：色板有几百个色块，用户滚到下面点色时
                    预览条若跟着滚走，「点了有没有生效」就又看不见了 —— 那正是这次要修的病。 */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    mx: 3,
                    my: 1.5,
                    px: 1.5,
                    py: 1,
                    borderRadius: 1.5,
                    bgcolor: scope === 'dark' ? SURFACE_DARK : SURFACE_LIGHT,
                    border: '1px solid',
                    borderColor: 'divider',
                }}
            >
                <Box
                    sx={{
                        px: 1.5,
                        py: 0.5,
                        borderRadius: 1,
                        bgcolor: activePrimary,
                        color: readableOn(activePrimary),
                        fontSize: 13,
                        fontWeight: 600,
                    }}
                >
                    {t('themePreviewSample')}
                </Box>
                <Typography sx={{ color: readableOn(scope === 'dark' ? SURFACE_DARK : SURFACE_LIGHT), fontSize: 12, opacity: 0.8 }}>
                    {t('themePreviewCaption', { scope: t(scope === 'dark' ? 'themeScopeDark' : 'themeScopeLight') })}
                </Typography>
            </Box>
            <DialogContent dividers sx={{ maxHeight: '52vh' }}>
                {sections.map((group) => (
                    <section key={group.name} style={{ marginBottom: 16 }}>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>{t(group.name)}</Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {group.colors.map((color) => {
                                const selected = isSelected(color.hex);
                                return (
                                    <Box
                                        component="button"
                                        type="button"
                                        key={`${group.name}-${color.hex}-${color.name}`}
                                        // ⚠️ `title` 只是鼠标提示；读屏靠 `aria-label`。
                                        title={color.name}
                                        aria-label={color.name}
                                        // ⚠️★ 选中态要**说给读屏**听：只画一个环的话，
                                        // 屏幕阅读器用户完全不知道现在用的是哪一个。
                                        aria-pressed={selected}
                                        onClick={() => setPrimary(scope, color.hex)}
                                        sx={{
                                            position: 'relative',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            width: SWATCH,
                                            height: SWATCH,
                                            p: 0,
                                            borderRadius: '6px',
                                            background: color.hex,
                                            border: '1px solid rgba(148,163,184,0.45)',
                                            cursor: 'pointer',
                                            // ⚠️ 过渡只给 transform / box-shadow：给 `background` 会拖慢
                                            // 「点下去立刻变色」那一下的观感。
                                            transition: 'transform .12s ease, box-shadow .12s ease',
                                            // ── 悬停：**放大 + 中性灰环**（临时的）──
                                            '&:hover': {
                                                transform: 'scale(1.12)',
                                                boxShadow:
                                                    '0 0 0 2px var(--mui-palette-background-paper), 0 0 0 3px var(--mui-palette-text-secondary)',
                                                zIndex: 1,
                                            },
                                            // ── 键盘聚焦：与悬停**不同**（虚线轮廓）──
                                            '&:focus-visible': {
                                                outline: '2px dashed var(--mui-palette-text-primary)',
                                                outlineOffset: '2px',
                                            },
                                            // ── 选中：**主题色环 + 对勾**（持久的，而且不放大）──
                                            // ⚠️ 放大留给悬停：一个色块既被选中、又被指着时，
                                            // 放大说明「你正指着它」，色环与对勾说明「用的是它」。
                                            ...(selected
                                                ? {
                                                      boxShadow:
                                                          '0 0 0 2px var(--mui-palette-background-paper), 0 0 0 4px var(--mui-palette-primary-main)',
                                                  }
                                                : {}),
                                        }}
                                    >
                                        {selected && (
                                            <MdiIcon name="mdi-check" size={18} color={readableOn(color.hex)} />
                                        )}
                                    </Box>
                                );
                            })}
                        </Box>
                    </section>
                ))}
            </DialogContent>
            <DialogActions sx={{ px: 2, py: 1.5, gap: 1 }}>
                {/* 「两套都用这个色」：多数人只想换一个颜色，不想在两套里各选一遍。
                    ⚠️★ 按钮文案会**自己变**成「已应用到两套」（2 秒）——
                        这颗按钮只改**另一个**模式那一份，当前界面一个像素都不变，
                        没有这句确认的话，用户会以为它坏了（就是这个 bug 来的）。 */}
                <Button size="small" variant="outlined" color="inherit" sx={{ mr: 'auto' }} startIcon={applied ? <MdiIcon name="mdi-check" size={16} /> : undefined} onClick={() => { setPrimaryBoth(activePrimary); setApplied(true); }}>
                    {applied ? t('themeApplyToBothDone') : t('themeApplyToBoth')}
                </Button>
                <Button size="small" variant="contained" color="inherit" onClick={onClose}>
                    {t('close')}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
