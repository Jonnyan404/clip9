import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { Alert, Box, Drawer } from '@mui/material';
import { router, isShareRoute } from '@/router';
import { MODES_META } from '@/modes/meta';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { useRoomsStore } from '@/stores/roomsStore';
import { useDarkMode } from '@/hooks/useDarkMode';
import { PageToolbarContext, type PageToolbarActions } from './PageToolbarContext';
import { RoomList } from './RoomList';
import { SettingsDialog } from './SettingsDialog';
import { AuthDialog } from './AuthDialog';
import { RoomDialog } from './RoomDialog';
import { ClearAllDialog } from './ClearAllDialog';
import { PageQrDialog } from './PageQrDialog';
import { DonateDialog } from './DonateDialog';
import { TraditionalColorDialog } from './TraditionalColorDialog';
import { ShareHistoryDialog } from './ShareHistoryDialog';
import { ToastHost } from './ToastHost';

/**
 * 应用外壳 —— 对应 web-vue3/src/App.vue 的 `<v-app>` 那一层。
 *
 * 包含：背景 / 「已清空」提示条 / 工作区（内容 + 房间侧栏 dock）/ 全部顶层弹窗 / toast，
 * 并通过 `PageToolbarContext` 把「打开这些弹窗」的能力提供给各模式里的工具栏。
 *
 * ⚠️ 分享页**不走这里**（见 `RootLayout`）—— 它是给收件人看的独立页面，不能带主应用外壳。
 */
export function AppShell({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const location = useLocation();
    // 深浅色系统（含 time/prefer 的定时器与 matchMedia 监听）
    useDarkMode();

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [clearAllOpen, setClearAllOpen] = useState(false);
    const [pageQrOpen, setPageQrOpen] = useState(false);
    const [donateOpen, setDonateOpen] = useState(false);
    const [traditionalColorsOpen, setTraditionalColorsOpen] = useState(false);
    const [shareHistoryOpen, setShareHistoryOpen] = useState(false);
    const [clearedVisible, setClearedVisible] = useState(false);

    const uiMode = useAppStore((s) => s.uiMode);
    const roomListEnabled = useAppStore((s) => s.config?.server?.roomList === true);

    const roomDockVisible = useRoomsStore((s) => s.roomDockVisible);
    const roomDockSide = useRoomsStore((s) => s.roomDockSide);
    const roomSheetOpen = useRoomsStore((s) => s.roomSheetOpen);
    const availableRooms = useRoomsStore((s) => s.availableRooms);

    const connected = useWebSocketStore((s) => s.websocket !== null);

    // 桌面端才用 dock（窄屏走 bottom sheet）。阈值与 Vue 版一致（1263）。
    const [windowWidth, setWindowWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
    useEffect(() => {
        const onResize = () => setWindowWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const desktopDockEnabled = windowWidth > 1263 && roomListEnabled;
    const desktopDockVisible = desktopDockEnabled && roomDockVisible;

    // 初始化：恢复侧栏偏好 + 纠正地址里手打错的模式 key（否则地址栏一直挂着一个不存在的键骗人）
    useEffect(() => {
        useRoomsStore.getState().restorePreferences();
        if (!MODES_META.some((entry) => entry.key === useAppStore.getState().uiMode)) {
            useAppStore.getState().setUiMode('default');
        }
    }, []);

    // 连上且有 roomList 能力 → 拉一次房间列表
    useEffect(() => {
        if (connected && roomListEnabled) {
            void useRoomsStore.getState().fetchRoomList();
        }
    }, [connected, roomListEnabled]);

    // 侧栏可见 → 补数据（打开时才需要）
    useEffect(() => {
        if (desktopDockVisible) {
            useRoomsStore.getState().ensureRoomPresent();
            void useRoomsStore.getState().fetchRoomList();
        }
    }, [desktopDockVisible]);

    // 模式写回地址 —— **replace**（每切一次模式就 push 的话，后退键会变成「回到上一个模式」）。
    // ⚠️ 分享页不写（会把收件人的地址顶掉）。
    useEffect(() => {
        if (isShareRoute()) {
            return;
        }
        const params = new URLSearchParams(router.state.location.search);
        if (params.get('mode') === uiMode) {
            return;
        }
        params.set('mode', uiMode);
        void router.navigate(
            { pathname: router.state.location.pathname, search: `?${params.toString()}` },
            { replace: true },
        );
    }, [uiMode]);

    // 地址变化 → 同步房间（一个 tab 一个房间）+ 清掉「已清空」提示
    useEffect(() => {
        setClearedVisible(false);
        const params = new URLSearchParams(location.search);
        const ws = useWebSocketStore.getState();
        const routeRoom = ws.normalizeRoomName(params.get('room') || '');
        if (ws.normalizeRoomName(ws.room) !== routeRoom) {
            ws.switchRoom(routeRoom);
        }
        if (roomListEnabled) {
            useRoomsStore.getState().ensureRoomPresent(routeRoom);
        }
    }, [location.search, location.pathname, roomListEnabled]);

    const toolbarActions = useMemo<PageToolbarActions>(() => ({
        openSettings: () => setSettingsOpen(true),
        openClearAll: () => setClearAllOpen(true),
        openRoomDialog: () => {
            useWebSocketStore.setState({ roomInput: useWebSocketStore.getState().room, roomDialog: true });
        },
        toggleConnection: () => {
            const ws = useWebSocketStore.getState();
            if (!ws.websocket && !ws.websocketConnecting) {
                useWebSocketStore.setState({ retry: 0 });
                void ws.connect();
            }
        },
        openRoomBrowser: () => useRoomsStore.getState().openRoomBrowser(desktopDockEnabled),
        openPageQr: () => setPageQrOpen(true),
        goHome: () => {
            if (router.state.location.pathname !== '/' || router.state.location.search) {
                void router.navigate('/');
            }
        },
        roomBrowserVisible: desktopDockVisible || roomSheetOpen,
        roomCount: availableRooms.length,
        roomListEnabled,
    }), [desktopDockEnabled, desktopDockVisible, roomSheetOpen, availableRooms.length, roomListEnabled]);

    return (
        <PageToolbarContext.Provider value={toolbarActions}>
            <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default' }}>
                {clearedVisible && (
                    <Alert severity="error" onClose={() => setClearedVisible(false)} sx={{ borderRadius: 0, justifyContent: 'center' }}>
                        {t('clipboardClearedRefresh')}
                    </Alert>
                )}

                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: desktopDockEnabled ? 0 : '20px',
                        flexDirection: desktopDockEnabled && roomDockSide === 'left' ? 'row-reverse' : 'row',
                        minHeight: '100vh',
                    }}
                >
                    <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>

                    {desktopDockVisible && (
                        <Box
                            component="aside"
                            sx={{
                                position: 'sticky',
                                top: 0,
                                height: '100vh',
                                alignSelf: 'flex-start',
                            }}
                        >
                            <RoomList
                                variant="dock"
                                dockSide={roomDockSide}
                                onSelect={(name) => void useRoomsStore.getState().switchRoom(name)}
                                onFavorite={(name) => useRoomsStore.getState().toggleFavoriteRoom(name)}
                                actions={(
                                    <Box
                                        component="button"
                                        type="button"
                                        title={roomDockSide === 'right' ? t('dockLeft') : t('dockRight')}
                                        onClick={() => useRoomsStore.getState().toggleDockSide()}
                                        sx={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', p: 0.5 }}
                                    >
                                        {roomDockSide === 'right' ? '‹' : '›'}
                                    </Box>
                                )}
                            />
                        </Box>
                    )}
                </Box>

                {/* 窄屏：房间列表走底部抽屉 */}
                <Drawer anchor="bottom" open={roomSheetOpen} onClose={() => useRoomsStore.getState().closeRoomSheet()}>
                    <Box sx={{ height: '60vh' }}>
                        <RoomList
                            variant="sheet"
                            onSelect={(name) => void useRoomsStore.getState().switchRoom(name)}
                            onFavorite={(name) => useRoomsStore.getState().toggleFavoriteRoom(name)}
                            onClose={() => useRoomsStore.getState().closeRoomSheet()}
                        />
                    </Box>
                </Drawer>

                <SettingsDialog
                    open={settingsOpen}
                    onClose={() => setSettingsOpen(false)}
                    onOpenShareHistory={() => setShareHistoryOpen(true)}
                    onOpenTraditionalColors={() => setTraditionalColorsOpen(true)}
                    onOpenDonate={() => setDonateOpen(true)}
                />
                <ShareHistoryDialog open={shareHistoryOpen} onClose={() => setShareHistoryOpen(false)} />
                <TraditionalColorDialog open={traditionalColorsOpen} onClose={() => setTraditionalColorsOpen(false)} />
                <DonateDialog open={donateOpen} onClose={() => setDonateOpen(false)} />
                <ClearAllDialog open={clearAllOpen} onClose={() => setClearAllOpen(false)} onCleared={setClearedVisible} />
                <PageQrDialog open={pageQrOpen} onClose={() => setPageQrOpen(false)} />
                <AuthDialog />
                <RoomDialog />
                <ToastHost />
            </Box>
        </PageToolbarContext.Provider>
    );
}
