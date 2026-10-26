import { Fragment, useEffect, useState } from 'react';
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
import {
    API_BASE_LIST_MAX, API_BASE_URL, apiBaseLabel, normalizeApiBase,
    readActiveApiBase, readSavedApiBases, writeActiveApiBase, writeSavedApiBases,
    type SavedApiBase,
} from '@/lib/base';
import { toast } from '@/stores/toastStore';
import i18n from '@/i18n';

const LANGUAGE_OPTIONS = [
    { code: 'zh', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
];

const iconStyle = { marginRight: 8, color: 'var(--mui-palette-primary-main)' } as const;

/**
 * 一行设置：图标 + 标题/说明 + 右侧控件。
 *
 * ⚠️★ 为什么不用 MUI 的 `secondaryAction`（2026-10-26 用户报的「通用页文字重叠」）：
 * 它给正文只留 **48px** 的右内边距，而这一页右侧的控件是 **140px 的 Select** 或
 * 85px 的开关组 —— 窄屏上正文直接跑到控件**底下**（实测 390 宽时重叠 92px：
 * 正文右边缘 x=396、Select 从 x=304 开始）。MUI 的解法是调用方自己写 `pr`，
 * 而控件宽度**随语种变**（`Traditional colors` 比「中华传统色」宽一截），算不准。
 *
 * 所以改成**可换行**的 flex 行：放不下时控件整体换到下一行并靠右，
 * 正文永远在自己的宽度里换行 —— 没有魔数，也不怕长译文。
 *
 * ⚠️ `minWidth: 0` 不能少：flex 项默认 `min-width: auto`，正文里那个
 * `http://127.0.0.1:1210/` 这种长串会把整行撑宽（`overflow-wrap: anywhere` 才是
 * 真正让「最小内容宽度」也跟着缩的那个值，`break-word` 不会）。
 */
function SettingRow({ icon, primary, secondary, children }: {
    /** 不给图标 = 「从属于上面那一行」的子项（如分享弹框那三个默认值）。 */
    icon?: string;
    primary: React.ReactNode;
    secondary?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <ListItem disableGutters sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 1 }}>
            {icon ? <MdiIcon name={icon} style={iconStyle} /> : null}
            <ListItemText
                primary={primary}
                secondary={secondary}
                sx={{
                    flex: '1 1 180px',
                    minWidth: 0,
                    '& .MuiListItemText-secondary': { overflowWrap: 'anywhere' },
                }}
            />
            {children ? (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: 'auto', flexShrink: 0 }}>
                    {children}
                </Stack>
            ) : null}
        </ListItem>
    );
}

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

    /**
     * 「后端地址」—— 前后端分离部署 / 多个后端来回切时用（`lib/base.ts` 的 `API_BASE_URL`）。
     *
     * ⚠️★ 嵌在桌面客户端的网页视图里时**不显示这一段**：那里连的必须是**本机**那个服务端
     * （桌面端自己的配置页才是改这个的地方）。在这儿改了，网页视图会静默变成另一个服务端的
     * 数据，而桌面自己的列表还是本机的 —— 两边对不上且没有任何提示。
     */
    const embedded = typeof window !== 'undefined' && window.self !== window.top;
    // ⚠️ 列表与「当前选中」是两件事（见 `lib/base.ts` 里两个 key 的注释）：切换只改后者。
    const [savedBases, setSavedBases] = useState<SavedApiBase[]>(() => readSavedApiBases());
    // ⚠️ 不做 `setActiveBase`：切换 = 写存储 + 整页 reload（见 `switchTo`），
    // 组件里再维护一份「当前值」只会多一处可能与存储不一致的状态。
    const [activeBase] = useState<string>(() => readActiveApiBase());
    const [draftUrl, setDraftUrl] = useState('');
    const [draftName, setDraftName] = useState('');
    const draftInvalid = Boolean(draftUrl.trim()) && !normalizeApiBase(draftUrl);

    // ⚠️★ 只有**一个**地址的老用户（键里存着一个值、列表还是空的）：把它收进列表。
    // 不做这一步的话，列表里看不到它，切走一次就再也找不回来（切换会覆盖同一个键）。
    useEffect(() => {
        if (!open || !activeBase || savedBases.some((entry) => entry.url === activeBase)) {
            return;
        }
        const seeded = [{ name: apiBaseLabel(activeBase), url: activeBase }, ...savedBases].slice(0, API_BASE_LIST_MAX);
        writeSavedApiBases(seeded);
        setSavedBases(seeded);
    }, [open, activeBase, savedBases]);

    /**
     * 切到一个后端 / 回到默认。
     *
     * ⚠️★ 整页 reload 而不是就地改 axios + WS：接口地址、WebSocket、房间里缓存的令牌、
     * 已建好的分享链接全都挂在它上面。就地改一半的形态最容易出现「有的请求打到旧的、
     * 有的打到新的」，而那类问题几乎没法从界面上看出来。
     */
    const switchTo = (url: string) => {
        writeActiveApiBase(url);
        window.location.reload();
    };

    const addAndSwitch = () => {
        const url = normalizeApiBase(draftUrl);
        if (!url) {
            toast(t('serverAddressInvalid'));
            return;
        }
        const name = draftName.trim().slice(0, 40) || apiBaseLabel(url);
        // ⚠️ 同一个地址重复添加 = 更新名字（按 url 去重），不是多出一行。
        const next = [{ name, url }, ...savedBases.filter((entry) => entry.url !== url)].slice(0, API_BASE_LIST_MAX);
        writeSavedApiBases(next);
        switchTo(url);
    };

    const removeActive = () => {
        writeSavedApiBases(savedBases.filter((entry) => entry.url !== activeBase));
        // 删掉正在用的那个 = 回到「默认」（`config.js` / 同源）。
        switchTo('');
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
                            <SettingRow
                                icon="mdi-brightness-4"
                                primary={t('darkMode')}
                                secondary={darkModeDesc}
                            >
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
                            </SettingRow>
                            {/* 菜单布局（2026-10-07）。⚠️ 与「暗色模式」并列：两者都是
                                **外观**这一类的选择，而且都要求**即时生效 + 记住**。
                                ⚠️ 它只影响工具栏排在哪 —— 不改任何功能的位置。 */}
                            <SettingRow
                                icon="mdi-view-column-outline"
                                primary={t('menuLayout')}
                                secondary={t('menuLayoutHint')}
                            >
                                <ToggleButtonGroup
                                    size="small"
                                    exclusive
                                    value={menuLayout}
                                    onChange={(_e, v) => v && setMenuLayout(v)}
                                >
                                    <ToggleButton value="top">{t('menuLayoutTop')}</ToggleButton>
                                    <ToggleButton value="side">{t('menuLayoutSide')}</ToggleButton>
                                </ToggleButtonGroup>
                            </SettingRow>
                            <SettingRow icon="mdi-palette" primary={t('changeThemeColor')}>
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
                            </SettingRow>
                        </List>

                        <Typography variant="subtitle2" color="text.secondary">{t('language')}</Typography>
                        <List dense disablePadding>
                            <SettingRow icon="mdi-translate" primary={t('language')}>
                                <Select size="small" value={currentLocale} onChange={(e) => changeLocale(e.target.value)} sx={{ minWidth: 140 }}>
                                    {LANGUAGE_OPTIONS.map((option) => (
                                        <MenuItem key={option.code} value={option.code}>{option.name}</MenuItem>
                                    ))}
                                </Select>
                            </SettingRow>
                        </List>

                        <Typography variant="subtitle2" color="text.secondary">{t('shareSettings')}</Typography>
                        <List dense disablePadding>
                            <ListItem disableGutters onClick={onOpenShareHistory} sx={{ cursor: 'pointer' }}>
                                <MdiIcon name="mdi-share-variant" style={iconStyle} />
                                <ListItemText primary={t('shareHistory')} secondary={t('shareHistoryEntryHint')} />
                                <MdiIcon name="mdi-chevron-right" size={18} />
                            </ListItem>
                        </List>

                        {/* 后端地址（前后端分离部署）—— 见上面 `embedded` 那段注释。 */}
                        {!embedded && (
                            <>
                                <Typography variant="subtitle2" color="text.secondary">{t('serverSettings')}</Typography>
                                <List dense disablePadding>
                                    <SettingRow
                                        icon="mdi-server-network"
                                        primary={t('serverAddress')}
                                        secondary={t('serverAddressHint', { current: API_BASE_URL })}
                                    />
                                </List>
                                {/* 切换：改一行就生效（整页重新加载），不需要再点保存。
                                    ⚠️ 空值 = 「默认」，即 `config.js` / 同源 —— 与没配过一样。 */}
                                <Stack direction="row" spacing={1} alignItems="center">
                                    <Select
                                        size="small"
                                        fullWidth
                                        value={activeBase}
                                        onChange={(e) => switchTo(e.target.value)}
                                        inputProps={{ 'aria-label': t('serverAddress') }}
                                    >
                                        <MenuItem value="">
                                            <em>{t('serverDefault')}</em>
                                        </MenuItem>
                                        {savedBases.map((entry) => (
                                            <MenuItem key={entry.url} value={entry.url}>
                                                {entry.name || apiBaseLabel(entry.url)}
                                            </MenuItem>
                                        ))}
                                    </Select>
                                    <Button
                                        size="small"
                                        color="error"
                                        variant="outlined"
                                        onClick={removeActive}
                                        // 只有「当前用的是列表里那条」才删得掉：默认那条不是列表项。
                                        disabled={!activeBase || !savedBases.some((entry) => entry.url === activeBase)}
                                        sx={{ flexShrink: 0 }}
                                    >
                                        {t('serverRemove')}
                                    </Button>
                                </Stack>

                                {/* 添加一条：填完点一下就直接切过去（否则还要再选一次，多余）。 */}
                                <Stack direction="row" spacing={1} alignItems="flex-start">
                                    <TextField
                                        size="small"
                                        fullWidth
                                        value={draftUrl}
                                        placeholder="https://api.example.com/"
                                        onChange={(e) => setDraftUrl(e.target.value)}
                                        error={draftInvalid}
                                        helperText={draftInvalid ? t('serverAddressInvalid') : t('serverAddressExample')}
                                        slotProps={{ htmlInput: { 'aria-label': t('serverAddress') } }}
                                    />
                                    <TextField
                                        size="small"
                                        value={draftName}
                                        onChange={(e) => setDraftName(e.target.value)}
                                        placeholder={t('serverNamePlaceholder')}
                                        slotProps={{ htmlInput: { 'aria-label': t('serverNamePlaceholder'), maxLength: 40 } }}
                                        sx={{ maxWidth: 132, flexShrink: 0 }}
                                    />
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        onClick={addAndSwitch}
                                        disabled={!draftUrl.trim() || draftInvalid}
                                        sx={{ flexShrink: 0 }}
                                    >
                                        {t('serverAdd')}
                                    </Button>
                                </Stack>
                            </>
                        )}

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
                                            <Fragment key={toggle.key}>
                                                <ListItem
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
                                                {/* ⚠️★ 这三项**紧跟着**「分享时弹出设置框」那一行，不能排在组末尾
                                                    （2026-10-26 用户报的）：它们是**那个弹框的内容** ——
                                                    关掉弹框时用的就是这三个默认值。排在「下载/预览/复制/分享/删除」
                                                    后面，看起来像是「删除」的选项，而且离那个开关隔了五行。
                                                    ⚠️ 走 `SettingRow`（不给图标 = 从属于上面那一行）：`secondaryAction`
                                                    只留 48px，而默认密码那个输入框有 180px —— 窄屏上正文会钻到框底下
                                                    （实测中文就撞了 22px）。 */}
                                                {toggle.key === 'shareDialog' && !display.shareDialog && (
                                                    <>
                                                        <SettingRow primary={t('shareDefaultTtl')}>
                                                            <TextField
                                                                size="small"
                                                                type="number"
                                                                value={shareDefaults.ttlMinutes}
                                                                onChange={(e) => setShareDefaults({ ttlMinutes: Number(e.target.value) })}
                                                                slotProps={{ htmlInput: { 'aria-label': t('shareDefaultTtl') } }}
                                                                sx={{ width: 96 }}
                                                            />
                                                        </SettingRow>
                                                        <SettingRow primary={t('shareDefaultMaxUses')}>
                                                            <TextField
                                                                size="small"
                                                                type="number"
                                                                value={shareDefaults.maxUses}
                                                                onChange={(e) => setShareDefaults({ maxUses: Number(e.target.value) })}
                                                                slotProps={{ htmlInput: { 'aria-label': t('shareDefaultMaxUses') } }}
                                                                sx={{ width: 96 }}
                                                            />
                                                        </SettingRow>
                                                        <SettingRow primary={t('shareDefaultPassword')}>
                                                            <TextField
                                                                size="small"
                                                                type="password"
                                                                autoComplete="new-password"
                                                                value={shareDefaults.password}
                                                                onChange={(e) => setShareDefaults({ password: String(e.target.value || '') })}
                                                                slotProps={{ htmlInput: { 'aria-label': t('shareDefaultPassword') } }}
                                                                sx={{ width: 180 }}
                                                            />
                                                        </SettingRow>
                                                    </>
                                                )}
                                            </Fragment>
                                        ))}
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
