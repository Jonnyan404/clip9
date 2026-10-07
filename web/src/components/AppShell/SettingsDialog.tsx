import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColorScheme } from '@mui/material/styles';
import {
    Button, Dialog, DialogContent, DialogTitle, Divider, IconButton, List, ListItem, ListItemText,
    MenuItem, Select, Stack, Switch, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { DISPLAY_GROUPS, togglesForMode } from '@/data/displayToggles.js';
import { MODES } from '@/modes/registry';
import { setMenuLayout, useAppStore } from '@/stores/appStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useThemeStore } from '@/stores/themeStore';
import { buildId } from '@/services/swUpdate';
import { MdiIcon } from '@/components/ui/MdiIcon';
import i18n from '@/i18n';

const LANGUAGE_OPTIONS = [
    { code: 'zh', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
];

const iconStyle = { marginRight: 8, color: 'var(--mui-palette-primary-main)' } as const;

/**
 * 设置弹窗 —— 对应 web-vue3/src/App.vue 里的 `settingsDialog`（两个页签）。
 *
 * ⚠️ 个性化页只显示「当前模式真的能用」的开关（`togglesForMode`）—— 显示一个拨了没反应的
 * 开关比不显示它更糟。
 * ⚠️ 每组右上角那个「整组开关」：**全开才算开**，点它要么全开、要么全关（半开显示为关）。
 */
export function SettingsDialog({
    open,
    onClose,
    onOpenShareHistory,
    onOpenTraditionalColors,
    onOpenDonate,
}: {
    open: boolean;
    onClose: () => void;
    onOpenShareHistory: () => void;
    onOpenTraditionalColors: () => void;
    onOpenDonate: () => void;
}) {
    const { t } = useTranslation();
    const { mode } = useColorScheme();
    const [tab, setTab] = useState<'general' | 'personalization'>('general');
    const menuLayout = useAppStore((s) => s.menuLayout);

    const config = useAppStore((s) => s.config);
    const dark = useAppStore((s) => s.dark);
    const uiMode = useAppStore((s) => s.uiMode);
    const setUiMode = useAppStore((s) => s.setUiMode);
    const setDisplayToggle = useAppStore((s) => s.setDisplayToggle);
    const shareDefaults = useAppStore((s) => s.shareDefaults);
    const setShareDefaults = useAppStore((s) => s.setShareDefaults);
    const display = useDisplaySettings();

    const primaryLight = useThemeStore((s) => s.primaryLight);
    const primaryDark = useThemeStore((s) => s.primaryDark);
    const setPrimary = useThemeStore((s) => s.setPrimary);

    const isDark = mode === 'dark';
    const currentPrimary = isDark ? primaryDark : primaryLight;
    const currentLocale = i18n.resolvedLanguage || i18n.language || 'zh';

    const darkModeOptions = [
        { value: 'time', title: t('switchByTime'), desc: t('switchByTimeDesc') },
        { value: 'prefer', title: t('switchBySystem'), desc: t('switchBySystemDesc') },
        { value: 'enable', title: t('keepEnabled'), desc: '' },
        { value: 'disable', title: t('keepDisabled'), desc: '' },
    ];
    const darkModeDesc = darkModeOptions.find((option) => option.value === dark)?.desc || '';

    const togglesInGroup = (groupKey: string) =>
        togglesForMode(uiMode, groupKey) as Array<{ key: string; labelKey: string; icon: string }>;

    const groupAllOn = (groupKey: string) => {
        const list = togglesInGroup(groupKey);
        return list.length > 0 && list.every((toggle) => display[toggle.key]);
    };
    const setGroupAll = (groupKey: string, value: boolean) => {
        togglesInGroup(groupKey).forEach((toggle) => setDisplayToggle(toggle.key, value));
    };

    const changeLocale = (code: string) => {
        if (currentLocale !== code) {
            void i18n.changeLanguage(code);
            localStorage.setItem('locale', code);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <div style={{ flex: 1, lineHeight: 1.3 }}>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>{t('settings')}</div>
                    <Typography variant="caption" color="text.secondary">
                        {t('cloudClipboard')} {config.version || ''}
                        {buildId ? ` · web ${buildId}` : ''}
                    </Typography>
                </div>
                <IconButton size="small" onClick={onClose} aria-label={t('close')}>
                    <MdiIcon name="mdi-close" size={18} />
                </IconButton>
            </DialogTitle>
            <Divider />
            <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="fullWidth">
                <Tab value="general" label={t('settingsGeneral')} />
                <Tab value="personalization" label={t('personalization')} />
            </Tabs>
            <DialogContent dividers sx={{ maxHeight: '62vh' }}>
                {tab === 'general' && (
                    <Stack spacing={1}>
                        <Typography variant="subtitle2" color="text.secondary">{t('appearance')}</Typography>
                        <List dense disablePadding>
                            <ListItem
                                disableGutters
                                secondaryAction={
                                    <Select
                                        size="small"
                                        value={dark}
                                        onChange={(e) => useAppStore.setState({ dark: e.target.value as never })}
                                        sx={{ minWidth: 140 }}
                                    >
                                        {darkModeOptions.map((option) => (
                                            <MenuItem key={option.value} value={option.value}>{option.title}</MenuItem>
                                        ))}
                                    </Select>
                                }
                            >
                                <MdiIcon name="mdi-brightness-4" style={iconStyle} />
                                <ListItemText primary={t('darkMode')} secondary={darkModeDesc} />
                            </ListItem>
                            {/* 菜单布局（2026-10-07）。⚠️ 与「暗色模式」并列：两者都是
                                **外观**这一类的选择，而且都要求**即时生效 + 记住**。
                                ⚠️ 它只影响工具栏排在哪 —— 不改任何功能的位置。 */}
                            <ListItem
                                disableGutters
                                secondaryAction={
                                    <ToggleButtonGroup
                                        size="small"
                                        exclusive
                                        value={menuLayout}
                                        onChange={(_e, v) => v && setMenuLayout(v)}
                                    >
                                        <ToggleButton value="top">{t('menuLayoutTop')}</ToggleButton>
                                        <ToggleButton value="side">{t('menuLayoutSide')}</ToggleButton>
                                    </ToggleButtonGroup>
                                }
                            >
                                <MdiIcon name="mdi-view-column-outline" style={iconStyle} />
                                <ListItemText primary={t('menuLayout')} secondary={t('menuLayoutHint')} />
                            </ListItem>
                            <ListItem disableGutters>
                                <MdiIcon name="mdi-palette" style={iconStyle} />
                                <ListItemText primary={t('changeThemeColor')} />
                                <Stack direction="row" spacing={1} alignItems="center">
                                    <input
                                        type="color"
                                        value={currentPrimary}
                                        onChange={(e) => setPrimary(isDark ? 'dark' : 'light', e.target.value)}
                                        style={{ width: 36, height: 28, border: 'none', background: 'none', cursor: 'pointer' }}
                                        title={t('selectThemeColor')}
                                        aria-label={t('colorPicker')}
                                    />
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        startIcon={<MdiIcon name="mdi-palette-swatch" size={16} />}
                                        onClick={onOpenTraditionalColors}
                                    >
                                        {t('traditionalColors')}
                                    </Button>
                                </Stack>
                            </ListItem>
                        </List>

                        <Typography variant="subtitle2" color="text.secondary">{t('language')}</Typography>
                        <List dense disablePadding>
                            <ListItem
                                disableGutters
                                secondaryAction={
                                    <Select size="small" value={currentLocale} onChange={(e) => changeLocale(e.target.value)} sx={{ minWidth: 140 }}>
                                        {LANGUAGE_OPTIONS.map((option) => (
                                            <MenuItem key={option.code} value={option.code}>{option.name}</MenuItem>
                                        ))}
                                    </Select>
                                }
                            >
                                <MdiIcon name="mdi-translate" style={iconStyle} />
                                <ListItemText primary={t('language')} />
                            </ListItem>
                        </List>

                        <Typography variant="subtitle2" color="text.secondary">{t('shareSettings')}</Typography>
                        <List dense disablePadding>
                            <ListItem disableGutters onClick={onOpenShareHistory} sx={{ cursor: 'pointer' }}>
                                <MdiIcon name="mdi-share-variant" style={iconStyle} />
                                <ListItemText primary={t('shareHistory')} secondary={t('shareHistoryEntryHint')} />
                                <MdiIcon name="mdi-chevron-right" size={18} />
                            </ListItem>
                        </List>

                        <Typography variant="subtitle2" color="text.secondary">{t('about')}</Typography>
                        <List dense disablePadding>
                            <ListItem disableGutters>
                                <MdiIcon name="mdi-github" style={iconStyle} />
                                <ListItemText
                                    primary={
                                        <a href="https://github.com/Jonnyan404/clip9" target="_blank" rel="noopener" style={{ color: 'inherit' }}>
                                            {t('github')}
                                        </a>
                                    }
                                />
                            </ListItem>
                        </List>
                        <Divider sx={{ my: 1 }} />
                        <Button
                            fullWidth
                            size="small"
                            color="error"
                            variant="outlined"
                            startIcon={<MdiIcon name="mdi-heart-outline" />}
                            endIcon={<MdiIcon name="mdi-chevron-right" size={16} />}
                            onClick={onOpenDonate}
                        >
                            {t('donatePrompt')}
                        </Button>
                    </Stack>
                )}

                {tab === 'personalization' && (
                    <Stack spacing={1.5}>
                        <Typography variant="caption" color="text.secondary">{t('personalizationHint')}</Typography>
                        <ToggleButtonGroup
                            value={uiMode}
                            exclusive
                            size="small"
                            onChange={(_e, value) => { if (value) setUiMode(value); }}
                            sx={{ flexWrap: 'wrap' }}
                        >
                            {MODES.map((m) => (
                                <ToggleButton key={m.key} value={m.key} sx={{ textTransform: 'none', gap: 0.5 }}>
                                    <MdiIcon name={m.icon} size={18} />
                                    {t(m.labelKey)}
                                </ToggleButton>
                            ))}
                        </ToggleButtonGroup>

                        {DISPLAY_GROUPS.map((group: { key: string; labelKey: string }) => {
                            const list = togglesInGroup(group.key);
                            if (!list.length) return null;
                            return (
                                <div key={group.key}>
                                    <Stack direction="row" alignItems="center" justifyContent="space-between">
                                        <Typography variant="subtitle2" color="text.secondary">{t(group.labelKey)}</Typography>
                                        <Switch
                                            size="small"
                                            checked={groupAllOn(group.key)}
                                            onChange={(e) => setGroupAll(group.key, e.target.checked)}
                                            title={t('toggleGroupAll')}
                                        />
                                    </Stack>
                                    <List dense disablePadding>
                                        {list.map((toggle) => (
                                            <ListItem
                                                key={toggle.key}
                                                disableGutters
                                                secondaryAction={
                                                    <Switch
                                                        size="small"
                                                        checked={Boolean(display[toggle.key])}
                                                        onChange={(e) => setDisplayToggle(toggle.key, e.target.checked)}
                                                    />
                                                }
                                            >
                                                <MdiIcon name={toggle.icon} style={iconStyle} />
                                                <ListItemText primary={t(toggle.labelKey)} />
                                            </ListItem>
                                        ))}
                                        {/* 紧挨着「分享时弹出设置框」：关掉它之后，这三项就是那次弹框的全部内容 */}
                                        {group.key === 'card' && !display.shareDialog && (
                                            <>
                                                <ListItem disableGutters secondaryAction={
                                                    <TextField
                                                        size="small"
                                                        type="number"
                                                        value={shareDefaults.ttlMinutes}
                                                        onChange={(e) => setShareDefaults({ ttlMinutes: Number(e.target.value) })}
                                                        sx={{ width: 96 }}
                                                    />
                                                }>
                                                    <ListItemText primary={t('shareDefaultTtl')} />
                                                </ListItem>
                                                <ListItem disableGutters secondaryAction={
                                                    <TextField
                                                        size="small"
                                                        type="number"
                                                        value={shareDefaults.maxUses}
                                                        onChange={(e) => setShareDefaults({ maxUses: Number(e.target.value) })}
                                                        sx={{ width: 96 }}
                                                    />
                                                }>
                                                    <ListItemText primary={t('shareDefaultMaxUses')} />
                                                </ListItem>
                                                <ListItem disableGutters secondaryAction={
                                                    <TextField
                                                        size="small"
                                                        type="password"
                                                        autoComplete="new-password"
                                                        value={shareDefaults.password}
                                                        onChange={(e) => setShareDefaults({ password: String(e.target.value || '') })}
                                                        sx={{ width: 180 }}
                                                    />
                                                }>
                                                    <ListItemText primary={t('shareDefaultPassword')} />
                                                </ListItem>
                                            </>
                                        )}
                                    </List>
                                </div>
                            );
                        })}
                    </Stack>
                )}
            </DialogContent>
        </Dialog>
    );
}
