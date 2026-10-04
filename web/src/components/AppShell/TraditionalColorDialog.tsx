import { Dialog, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useColorScheme } from '@mui/material/styles';
import { traditionalColorGroups } from '@/data/traditionalColors.js';
import { useThemeStore } from '@/stores/themeStore';

/**
 * 中华传统色选择 —— 对应 web-vue3/src/components/TraditionalColorDialog.vue。
 * 点一个色块就把它设成**当前明暗模式**的主色（与 Vue 版一致：各改各的那一份）。
 */
export function TraditionalColorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { mode } = useColorScheme();
    const setPrimary = useThemeStore((s) => s.setPrimary);
    const isDark = mode === 'dark';

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle>{t('traditionalColors')}</DialogTitle>
            <DialogContent dividers sx={{ maxHeight: '70vh' }}>
                {(traditionalColorGroups as Array<{ name: string; colors: Array<{ name: string; hex: string }> }>).map((group) => (
                    <section key={group.name} style={{ marginBottom: 16 }}>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>{t(group.name)}</Typography>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {group.colors.map((color) => (
                                <button
                                    key={`${group.name}-${color.hex}-${color.name}`}
                                    type="button"
                                    title={color.name}
                                    onClick={() => setPrimary(isDark ? 'dark' : 'light', color.hex)}
                                    style={{
                                        width: 34,
                                        height: 34,
                                        borderRadius: 6,
                                        border: '1px solid rgba(148,163,184,0.45)',
                                        background: color.hex,
                                        cursor: 'pointer',
                                        padding: 0,
                                    }}
                                />
                            ))}
                        </div>
                    </section>
                ))}
            </DialogContent>
        </Dialog>
    );
}
