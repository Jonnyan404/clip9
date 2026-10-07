import { Box, Dialog, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useColorScheme } from '@mui/material/styles';
import { traditionalColorGroups } from '@/data/traditionalColors.js';
import { useThemeStore } from '@/stores/themeStore';
import { MdiIcon } from '@/components/ui/MdiIcon';

/** 色块的边长。⚠️ 与悬停时的放大倍数一起决定了「会不会挤到邻居」。 */
const SWATCH = 34;

/**
 * 这个色该配深色还是浅色的对勾。
 *
 * ⚠️★ 用**相对亮度**判，不写死白色：传统色里既有「月白」「缟」这种接近白的，
 * 也有「玄」「黛」这种接近黑的 —— 一律白勾的话，浅色块上那个勾**看不见**，
 * 而用户会以为「点不上」。
 */
function checkColor(hex: string): string {
    const value = hex.replace('#', '');
    if (value.length !== 6) {
        return '#fff';
    }
    const channel = (i: number) => parseInt(value.slice(i, i + 2), 16) / 255;
    const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    // 相对亮度（WCAG 的公式），系数与 sRGB 一致。
    const luminance =
        0.2126 * linear(channel(0)) + 0.7152 * linear(channel(2)) + 0.0722 * linear(channel(4));
    return luminance > 0.5 ? '#1f2937' : '#ffffff';
}

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
    // ⚠️ 订阅**当前明暗那一份**：浅色下选中的是 `primaryLight`，深色下是 `primaryDark` ——
    // 两个是各自独立的（与 Vue 版一致），拿错那一份会把另一个模式的选中色标出来。
    const primary = useThemeStore((s) => (isDark ? s.primaryDark : s.primaryLight));
    const setPrimary = useThemeStore((s) => s.setPrimary);

    const isSelected = (hex: string) => hex.toLowerCase() === primary.toLowerCase();

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle>{t('traditionalColors')}</DialogTitle>
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
                                            <MdiIcon name="mdi-check" size={18} color={checkColor(color.hex)} />
                                        )}
                                    </Box>
                                );
                            })}
                        </Box>
                    </section>
                ))}
            </DialogContent>
        </Dialog>
    );
}
