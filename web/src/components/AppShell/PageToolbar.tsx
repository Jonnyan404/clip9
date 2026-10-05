import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Box, Chip, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, useTheme } from '@mui/material';
import { MODES_META } from '@/modes/meta';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { usePageToolbarActions } from './PageToolbarContext';
import { MdiIcon } from '@/components/ui/MdiIcon';

/**
 * 页面工具栏 —— 对应 web-vue3/src/components/PageToolbar.vue。
 *
 * ⚠️ 由**每个模式**自己渲染（`<PageToolbar variant="..."/>`），它触发的弹窗归外壳管
 * （通过 `PageToolbarContext`）。
 *
 * ⚠️ 连接图标只在「没连上」时出现：连上之后它是个**死按钮** —— 「连接好不好」已经由房间
 * chip 里的延迟数字（带颜色分级）表达了，常驻就只是白占一个位置。
 *
 * ⚠️ 那个房间列表图标是**开关**，不是「打开」（跟 VS Code / 访达的侧栏开关一致）。
 */
export function PageToolbar({ variant = 'default' }: { variant?: string }) {
    const { t } = useTranslation();
    const theme = useTheme();
    const actions = usePageToolbarActions();

    const room = useWebSocketStore((s) => s.room);
    const connected = useWebSocketStore((s) => s.websocket !== null);
    const connecting = useWebSocketStore((s) => s.websocketConnecting);
    const latency = useWebSocketStore((s) => s.latency);
    const roomProtectionCache = useWebSocketStore((s) => s.roomProtectionCache);

    const uiMode = useAppStore((s) => s.uiMode);
    const setUiMode = useAppStore((s) => s.setUiMode);
    const prefix = useAppStore((s) => s.config?.server?.prefix || '');
    const automationEnabled = useAppStore((s) => s.config?.automation?.enabled === true);

    const [collapsed, setCollapsed] = useState(() => localStorage.getItem('pageToolbarCollapsed') === 'true');
    const [modeMenuAnchor, setModeMenuAnchor] = useState<HTMLElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // ⚠️ 把工具栏**实际高度**写进 CSS 变量：标准模式里吸顶的输入区要拿它当 `top`，
    // 否则向上滚动时输入区会被工具栏遮住一部分（工具栏是 sticky，输入区 top 写死 8px 就会滑到它下面）。
    // 用 ResizeObserver 而不是写死数字：工具栏可折叠、模式不同、字号不同，高度都会变。
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const apply = () => {
            document.documentElement.style.setProperty('--page-toolbar-height', `${el.offsetHeight}px`);
        };
        apply();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(apply);
        observer.observe(el);
        return () => observer.disconnect();
    }, [collapsed]);

    const currentMode = MODES_META.find((m) => m.key === uiMode) || MODES_META[0];
    const normalizedRoom = useWebSocketStore.getState().normalizeRoomName(room);
    // ⚠️ 三态：true / false / undefined（还没问过服务端）。这里按「未知先当公开」画 ——
    // 窗口是一次 /server 往返（connect() 里必发），所以只会闪一下。
    const isProtected = Boolean(roomProtectionCache[normalizedRoom]);

    const latencyColor = latency === null
        ? undefined
        : latency < 60
            ? theme.palette.success.main
            : latency < 120
                ? theme.palette.warning.main
                : theme.palette.error.main;

    const automationUrl = `${prefix ? `/${prefix.replace(/^\/+|\/+$/g, '')}` : ''}/automation${room ? `?room=${encodeURIComponent(room)}` : ''}`;

    const toggleToolbar = () => {
        const next = !collapsed;
        setCollapsed(next);
        localStorage.setItem('pageToolbarCollapsed', String(next));
    };

    return (
        <Box
            ref={rootRef}
            className={`page-toolbar page-toolbar--${variant}`}
            sx={{
                position: 'sticky',
                top: 0,
                zIndex: 40,
                // ⚠️ 背景与下边框**不在这里**：它们按模式不同（见 styles/components.css 的
                // `.page-toolbar--*`）—— Vue 里 default 是 #f5f7fa、sticky 是 #f3ead2，
                // 而 glance / board **故意透明**（让模式自己的底色透上来）。
                // 统一写 `background.paper` 会让这几个模式的顶栏变成一块白，跟 Vue 对不上。
            }}
        >
            {!collapsed && (
                <Stack direction="row" alignItems="center" spacing={1} sx={{ maxWidth: 1100, mx: 'auto', px: 2, py: 1 }}>
                    {/* 左侧：回公共房间 / 连接态 / 房间 chip */}
                    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                        {room && (
                            <Tooltip title={t('backToDefaultRoom')}>
                                <IconButton size="small" aria-label={t('backToDefaultRoom')} onClick={() => useWebSocketStore.getState().switchRoom('')}>
                                    <MdiIcon name="mdi-home-outline" size={22} />
                                </IconButton>
                            </Tooltip>
                        )}
                        {!connected && (
                            <Tooltip title={connecting ? t('connecting') : t('disconnected')}>
                                <IconButton size="small" aria-label={connecting ? t('connecting') : t('disconnected')} onClick={actions.toggleConnection}>
                                    <MdiIcon
                                        name={connecting ? 'mdi-lan-pending' : 'mdi-lan-disconnect'}
                                        size={22}
                                        color={connecting ? undefined : theme.palette.error.main}
                                    />
                                </IconButton>
                            </Tooltip>
                        )}
                        <Tooltip title={t('showQrCode')}>
                            <Chip
                                size="small"
                                variant="outlined"
                                color="primary"
                                // MUI 的 Chip 只有 filled / outlined（`tonal` 是 Vuetify 的），
                                // 所以用主色的浅底补出那个观感 —— 房间名跟随主题色。
                                sx={{ bgcolor: 'color-mix(in srgb, var(--mui-palette-primary-main) 12%, transparent)' }}
                                onClick={actions.openPageQr}
                                icon={<MdiIcon name={isProtected ? 'mdi-lock' : 'mdi-earth'} size={16} />}
                                label={
                                    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }}>
                                        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                                            {room || t('publicRoom')}
                                        </Box>
                                        {connected && latency !== null && (
                                            <Box component="span" sx={{ color: latencyColor, fontWeight: 700, fontSize: 12 }}>
                                                {`${Math.round(latency)} ms`}
                                            </Box>
                                        )}
                                    </Stack>
                                }
                            />
                        </Tooltip>
                    </Stack>

                    {/* 右侧：模式 / 房间 / 系统 三组 */}
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                        <Chip
                            size="small"
                            variant="outlined"
                            onClick={(e) => setModeMenuAnchor(e.currentTarget)}
                            label={
                                <Stack direction="row" alignItems="center" spacing={0.5}>
                                    <Box component="span" sx={{ fontSize: 13 }}>{t(currentMode.labelKey)}</Box>
                                    <MdiIcon name="mdi-chevron-down" size={14} />
                                </Stack>
                            }
                            title={t('uiMode')}
                        />
                        <Menu anchorEl={modeMenuAnchor} open={Boolean(modeMenuAnchor)} onClose={() => setModeMenuAnchor(null)}>
                            {MODES_META.map((mode) => (
                                <MenuItem
                                    key={mode.key}
                                    selected={uiMode === mode.key}
                                    onClick={() => {
                                        setUiMode(mode.key);
                                        setModeMenuAnchor(null);
                                    }}
                                >
                                    <ListItemIcon><MdiIcon name={mode.icon} size={18} /></ListItemIcon>
                                    <ListItemText>{t(mode.labelKey)}</ListItemText>
                                </MenuItem>
                            ))}
                        </Menu>

                        <Stack direction="row" alignItems="center" spacing={0.25}>
                            {actions.roomListEnabled && (
                                <Tooltip title={actions.roomBrowserVisible ? t('hideRoomBrowser') : t('showRoomBrowser')}>
                                    <IconButton
                                        size="small"
                                        aria-label={actions.roomBrowserVisible ? t('hideRoomBrowser') : t('showRoomBrowser')}
                                        onClick={actions.openRoomBrowser}
                                        sx={actions.roomBrowserVisible ? { bgcolor: 'action.selected' } : undefined}
                                    >
                                        <Badge badgeContent={actions.roomCount} color="secondary" overlap="circular" invisible={actions.roomCount === 0}>
                                            <MdiIcon name="mdi-view-list" size={22} />
                                        </Badge>
                                    </IconButton>
                                </Tooltip>
                            )}
                            <Tooltip title={t('enterRoom')}>
                                <IconButton size="small" aria-label={t('enterRoom')} onClick={actions.openRoomDialog}>
                                    <MdiIcon name="mdi-door-open" size={22} />
                                </IconButton>
                            </Tooltip>
                        </Stack>

                        <Stack direction="row" alignItems="center" spacing={0.25}>
                            <Tooltip title={t('clearClipboard')}>
                                <IconButton size="small" aria-label={t('clearClipboard')} onClick={actions.openClearAll}>
                                    <MdiIcon name="mdi-broom" size={22} />
                                </IconButton>
                            </Tooltip>
                            {automationEnabled && (
                                <Tooltip title={t('automationEntryHint')}>
                                    <IconButton size="small" component="a" href={automationUrl} aria-label={t('automationEntry')}>
                                        <MdiIcon name="mdi-calendar-clock" size={22} />
                                    </IconButton>
                                </Tooltip>
                            )}
                            <Tooltip title={t('settings')}>
                                <IconButton size="small" aria-label={t('settings')} onClick={actions.openSettings}>
                                    <MdiIcon name="mdi-cog" size={22} />
                                </IconButton>
                            </Tooltip>
                        </Stack>
                    </Stack>
                </Stack>
            )}
            {/* 折叠开关：一枚小胶囊，**嵌在那条分割线上**（Vue 用 `bottom:-2px` + 绝对定位）。
                ⚠️ 它**不该自己占一行** —— 原来那样会把工具栏撑高一截，而且看起来不像「贴着边框」。 */}
            <Box
                component="button"
                type="button"
                onClick={toggleToolbar}
                title={collapsed ? t('expandToolbar') : t('collapseToolbar')}
                aria-label={collapsed ? t('expandToolbar') : t('collapseToolbar')}
                sx={{
                    position: 'absolute',
                    left: '50%',
                    bottom: -2,
                    transform: 'translateX(-50%)',
                    zIndex: 5,
                    width: 26,
                    height: 4,
                    borderRadius: 999,
                    border: 'none',
                    p: 0,
                    background: 'currentColor',
                    opacity: 0.35,
                    cursor: 'pointer',
                    transition: 'opacity .15s, width .15s',
                    '&:hover': { opacity: 0.8, width: 36 },
                }}
            />
        </Box>
    );
}
