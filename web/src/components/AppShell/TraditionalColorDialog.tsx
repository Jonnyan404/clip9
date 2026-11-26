import { Box, Button, Dialog, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useColorScheme, useTheme } from '@mui/material/styles';
import { traditionalColorGroups } from '@/data/traditionalColors.js';
import { useThemeStore } from '@/stores/themeStore';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { contrastRatio, readableOn } from '@/lib/contrast';

/** 色块的边长。⚠️ 与悬停时的放大倍数一起决定了「会不会挤到邻居」。 */
const SWATCH = 34;

/**
 * 与当前背景的对比度低于这个值就标出来。
 *
 * ⚠️ 3:1 是 WCAG 对**非文本**（图形、图标、界面组件边界）的 AA 要求 —— 主色恰恰是用在
 *    按钮底色、选中态这类地方，比的是它和页面底色的区分度，不是文字可读性（那是 4.5:1）。
 *    用 4.5 当门槛会把「深一点的蓝」也标上，提示就失去意义了。
 */
const LOW_CONTRAST = 3;

/**
 * 中华传统色选择 —— 对应 web-vue3/src/components/TraditionalColorDialog.vue。
 * 点一个色块就把它设成**当前明暗模式**的主色（与 Vue 版一致：各改各的那一份）。
 *
 * # ⚠️★ 2026-10-07 修的三件事
 *
 * 1. **悬停没有反馈**：原来那些色块是内联 `style`，只有 `border` 与 `background` ——
 *    既没有 `:hover`、也没有 `:focus-visible`，鼠标划过去**什么都没有**。
 * 2. **根本没有「选中」这个概念**：组件**没读当前主色**，所以用户看不出现在用的是哪一个，
 *    点完也不知道成没成（只能看背后的界面颜色变没变）。
 * 3. **悬停态与选中态分不开**：这两件事必须一眼能分辨 ——
 *    悬停是**放大 + 中性灰环**（临时的），选中是**主题色环 + 对勾**（持久的）。
 *    两者都做成「一个圈」的话，鼠标停在已选色块上时会分不清是哪个状态。
 *
 * ⚠️ 点击的即时反馈靠**状态本身**：`setPrimary` 是同步的（写 localStorage + 改 store），
 * 而 `<ThemeProvider>` 会立刻用新主色重建主题 —— 所以环与对勾**当拍就位**，不需要额外的动画。
 */
export function TraditionalColorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { mode } = useColorScheme();
    const isDark = mode === 'dark';
    const theme = useTheme();
    // ⚠️ 订阅**当前明暗那一份**：浅色下选中的是 `primaryLight`，深色下是 `primaryDark` ——
    // 两个是各自独立的（与 Vue 版一致），拿错那一份会把另一个模式的选中色标出来。
    const primary = useThemeStore((s) => (isDark ? s.primaryDark : s.primaryLight));
    const setPrimary = useThemeStore((s) => s.setPrimary);
    const setPrimaryBoth = useThemeStore((s) => s.setPrimaryBoth);

    /**
     * 当前这一套的页面底色 —— 用来算「这个色和背景差多少」。
     *
     * ⚠️ 从 `theme.colorSchemes` 取，**不要**用 `theme.palette.background.default`：
     *    开了 CSS 变量主题之后 `theme.palette` 是**默认那套**（浅色）的值，
     *    暗色下用它算出来的对比度是错的，而那些「几乎看不见」的色恰恰都在暗色模式下才出问题。
     */
    const background = (() => {
        const scheme = (theme as unknown as { colorSchemes?: Record<string, { palette?: { background?: { default?: string } } }> })
            .colorSchemes?.[isDark ? 'dark' : 'light'];
        return scheme?.palette?.background?.default || (isDark ? '#0f172a' : '#f4f7fb');
    })();

    const isSelected = (hex: string) => hex.toLowerCase() === primary.toLowerCase();

    /**
     * 当前选中的色在**这套背景**上的对比度。
     *
     * ⚠️★ 为什么不在每个色块上提前标出来（做过，撤了）：742 个色里有 189 个（25%）
     * 低于 3:1 —— 满屏角标的结果是**提示失去意义**，还盖住了色块本身。
     * 改成「选了以后才说一句」：没有视觉噪音，而且只在真的会看不清时才出现。
     */
    const currentRatio = contrastRatio(primary, background);
    const tooFaint = currentRatio !== null && currentRatio < LOW_CONTRAST;

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle>
                {t('traditionalColors')}
                {/* ⚠️★ 必须说清「改的是哪一套」：主色明暗各存一份，在浅色模式下选色
                    不会影响深色模式。不说的话，用户切到深色发现没变，会以为设置没保存。 */}
                <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
                    {t('themeScopeNow', { scope: isDark ? t('themeScopeDark') : t('themeScopeLight') })}
                </Typography>
            </DialogTitle>
            <DialogContent dividers sx={{ maxHeight: '70vh' }}>
                {(traditionalColorGroups as Array<{ name: string; colors: Array<{ name: string; hex: string }> }>).map((group) => (
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
                                        onClick={() => setPrimary(isDark ? 'dark' : 'light', color.hex)}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 16px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="caption" color="text.secondary" component="div">
                        {t('themeScopeHint')}
                    </Typography>
                    {/* ⚠️ 只在**当前选中的色**与背景对比度不足时出现 —— 不预先标 189 个色块，
                        那是视觉噪音（见 `tooFaint` 的注释）。仍允许用户这么选，只是把后果说清楚。 */}
                    {tooFaint && (
                        <Typography variant="caption" color="warning.main" component="div" sx={{ mt: 0.5 }}>
                            {t('themeLowContrastWarn', { ratio: currentRatio.toFixed(1) })}
                        </Typography>
                    )}
                </div>
                {/* 「两套都用这个色」：多数人只想换一个颜色，不想在两套里各选一遍。
                    默认不勾，因为深色底上往往需要更亮的一支（那是分成两份的原因）。 */}
                {/* ⚠️ `color="inherit"` 不是随手写的：这颗按钮如果走 primary，
                    而用户刚好选了个接近背景的色（正是上面那条警告说的情况），
                    它自己就会变成「白底白字」—— 一个提示别人看不清的按钮，自己也看不清。 */}
                <Button
                    size="small"
                    variant="outlined"
                    color="inherit"
                    onClick={() => setPrimaryBoth(primary)}
                >
                    {t('themeApplyToBoth')}
                </Button>
            </div>
        </Dialog>
    );
}
