import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Box, Button, Chip, Dialog, DialogContent, DialogTitle, IconButton, Slider, Stack, TextField, Tooltip, Typography, useMediaQuery,
} from '@mui/material';
import axios from 'axios';
import { FULLSCREEN_OPACITY_MAX, FULLSCREEN_OPACITY_MIN, useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { errorMessage, mergeSelectedFiles, prettyFileSize } from '@/lib/util';
import { postText } from '@/services/send';
import { writeParams } from '@/services/http';
import { SLASH_TEMPLATES, resolveSlashText, slashMenuShouldOpen, slashMenuShouldStay, slashPendingAt, stripTrailingSlash } from '@/lib/slash-template.js';
import { runActionById } from '@/lib/actions/index.js';
import { ComposerSlashMenu, type SlashTemplate } from '@/components/ComposerSlashMenu';
import { TraditionalColorDialog } from '@/components/AppShell/TraditionalColorDialog';
import { DonateDialog } from '@/components/AppShell/DonateDialog';
import { ShortcutsDialog } from '@/components/ShortcutsDialog';
import { MdiIcon } from '@/components/ui/MdiIcon';

export interface UnifiedComposerHandle {
    focus: (type?: string) => void;
    addFiles: (files: File[]) => void;
}

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.userAgent || '');

/**
 * 标准模式输入区 —— 从 web-vue3/src/components/UnifiedComposer.vue 移植。
 *
 * ⚠️★ 发送那条 POST 的**唯一**定义在 `services/send.ts`（分享桥走的是同一个函数）。
 * ⚠️★ 有文件时**必须**拦下浏览器默认粘贴行为，否则会把文件名当文本插进输入框。
 */
export const UnifiedComposer = forwardRef<UnifiedComposerHandle>(function UnifiedComposer(_props, ref) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const send = useAppStore((s) => s.send);
    const config = useAppStore((s) => s.config);
    const composerPrimary = useAppStore((s) => s.composerPrimary);
    const fullscreenSendClose = useAppStore((s) => s.fullscreenSendClose);
    const fullscreenOpacity = useAppStore((s) => s.fullscreenOpacity);
    const connected = useWebSocketStore((s) => s.websocket !== null);

    const [dragover, setDragover] = useState(false);
    const [progress, setProgress] = useState(false);
    const [uploadedSizes, setUploadedSizes] = useState<number[]>([]);
    const [slashMenu, setSlashMenu] = useState(false);
    const [textFullscreen, setTextFullscreen] = useState(false);
    const [deviceDialog, setDeviceDialog] = useState(false);
    const [rewardDialog, setRewardDialog] = useState(false);
    const [colorDialog, setColorDialog] = useState(false);
    const [shortcutsDialog, setShortcutsDialog] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const selectFileRef = useRef<HTMLInputElement | null>(null);
    const slashElRef = useRef<HTMLTextAreaElement | null>(null);

    const isFilePrimary = composerPrimary === 'files';
    // 窄屏用短文案（Vue 版同一处：`mobile ? 'addFilesShort' : 'addFiles'`）。
    const mobile = useMediaQuery('(max-width:600px)');
    const canSend = Boolean(display.composerText || display.composerUpload);
    const fileSize = send.files.reduce((acc, cur) => acc + cur.size, 0);
    const uploadedSize = uploadedSizes.reduce((acc, cur) => acc + cur, 0);
    const uploadProgress = fileSize ? Math.min(uploadedSize / fileSize, 1) : 0;
    const sendDisabled = !connected || progress || (!send.text && !send.files.length) || send.text.length > config.text.limit;
    const pasteKey = isMac ? '⌘+V' : 'Ctrl+V';
    const sendShortcutLabel = t('sendShortcutTip', { keys: isMac ? '⌘+Enter' : 'Ctrl+Enter' });
    const textareaPlaceholder = `${t('composerSlashHint')} ${sendShortcutLabel}`;

    const handleSelectFiles = useCallback((files: File[]) => {
        if (!files.length) return;
        if (files.some((file) => !file.size)) {
            toast(t('cannotSendEmptyFile'));
            return;
        }
        if (files.some((file) => file.size > config.file.limit)) {
            toast(t('fileSizeExceeded', { limit: prettyFileSize(config.file.limit) }));
            return;
        }
        // ⚠️★ **追加，不是替换**（理由见 `mergeSelectedFiles` 的注释）：
        // 手机上「分几次添加」是常态，替换语义会把前几次选的全丢掉。
        const current = useAppStore.getState().send.files;
        useAppStore.setState({ send: { ...useAppStore.getState().send, files: mergeSelectedFiles(current, files) } });
    }, [config.file.limit, t]);

    useImperativeHandle(ref, () => ({
        focus: (type?: string) => {
            if (type === 'file') {
                selectFileRef.current?.click();
                return;
            }
            textareaRef.current?.focus();
        },
        addFiles: (files: File[]) => handleSelectFiles(files),
    }), [handleSelectFiles]);

    // 全局粘贴：有文件时拦下默认行为（否则文件名会被当文本插进输入框）。
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            if (!event.clipboardData) return;
            const items = Array.from(event.clipboardData.items || []);
            const files = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean) as File[];
            if (!files.length) {
                files.push(...Array.from(event.clipboardData.files || []));
            }
            if (files.length) {
                event.preventDefault();
                handleSelectFiles(files);
            }
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, [handleSelectFiles]);

    const onTextareaInput = (event: React.FormEvent<HTMLElement>) => {
        const target = event.target as HTMLTextAreaElement;
        if (!slashMenu) {
            if (!slashMenuShouldOpen(event.nativeEvent, send.text)) return;
            slashElRef.current = target;
            setSlashMenu(true);
            return;
        }
        if (!slashMenuShouldStay(event.nativeEvent, send.text)) {
            setSlashMenu(false);
        }
    };

    const insertSlashTemplate = async (item: SlashTemplate) => {
        const el = slashElRef.current || textareaRef.current;
        const text = send.text || '';
        // ⚠️ 光标位置要在 await **之前**读 —— 要插入的文本可能是动作算出来的（异步）。
        const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
        const head = stripTrailingSlash(text.slice(0, pos));
        const tail = text.slice(pos);
        const insert = await resolveSlashText(item, runActionById);
        useAppStore.setState({ send: { ...useAppStore.getState().send, text: head + insert + tail } });
        setSlashMenu(false);
        // ⚠️ 模板可以指定落点（`item.caret`）—— 代码模板的闭合符在末尾，
        // 光标停在那儿等于插完还得自己左移。没指定就是「插入内容之后」。
        const caret = head.length + (typeof item.caret === 'number' ? item.caret : insert.length);
        requestAnimationFrame(() => {
            el?.focus?.();
            el?.setSelectionRange?.(caret, caret);
        });
    };

    const sendText = async () => {
        const text = useAppStore.getState().send.text;
        if (!text) return;
        await postText({ room: useWebSocketStore.getState().room, text });
        useAppStore.setState({ send: { ...useAppStore.getState().send, text: '' } });
    };

    const sendFiles = async () => {
        const files = useAppStore.getState().send.files;
        if (!files.length) return;
        const chunkSize = config.file.chunk;
        const room = useWebSocketStore.getState().room;
        setUploadedSizes(Array(files.length).fill(0));
        setProgress(true);
        await Promise.all(files.map(async (file, index) => {
            if (file.size < chunkSize) {
                const formData = new FormData();
                formData.set('file', file);
                await axios.postForm('upload', formData, {
                    params: writeParams(room),
                    onUploadProgress: (e) => setUploadedSizes((prev) => prev.map((v, i) => (i === index ? e.loaded : v))),
                });
                return;
            }
            const response = await axios.post('upload/chunk', file.name, {
                headers: { 'Content-Type': 'text/plain' },
                params: writeParams(room),
            });
            const uuid = response.data.result.uuid;
            let uploaded = 0;
            while (uploaded < file.size) {
                const chunk = file.slice(uploaded, uploaded + chunkSize);
                await axios.post(`upload/chunk/${uuid}`, chunk, {
                    headers: { 'Content-Type': 'application/octet-stream' },
                    params: writeParams(room),
                    onUploadProgress: (e) => setUploadedSizes((prev) => prev.map((v, i) => (i === index ? uploaded + e.loaded : v))),
                });
                uploaded += chunkSize;
            }
            await axios.post(`upload/finish/${uuid}`, null, { params: writeParams(room) });
        }));
        useAppStore.setState({ send: { ...useAppStore.getState().send, files: [] } });
    };

    const sendAll = async () => {
        try {
            if (useAppStore.getState().send.text) await sendText();
            if (useAppStore.getState().send.files.length) await sendFiles();
            toast(t('sendSuccess'));
            if (useAppStore.getState().fullscreenSendClose) setTextFullscreen(false);
            textareaRef.current?.focus();
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('sendFailedMsg', { msg }) : t('sendFailed'));
        } finally {
            setProgress(false);
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape' && slashMenu) {
            setSlashMenu(false);
            event.stopPropagation();
            return;
        }
        if (event.key === '/') {
            if (slashPendingAt(event.target as HTMLTextAreaElement, send.text)) {
                slashElRef.current = event.target as HTMLTextAreaElement;
                setSlashMenu(true);
            }
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!sendDisabled) void sendAll();
        }
    };

    const devices = useAppStore((s) => s.device);
    const deviceStats = useMemo(() => {
        const desktop = devices.filter((d) => d.type === 'desktop').length;
        const mobile = devices.filter((d) => d.type === 'smartphone' || d.type === 'mobile' || d.type === 'tablet').length;
        return { desktop, mobile, other: devices.length - desktop - mobile };
    }, [devices]);

    // 设备没自报名字时的兜底标题（服务端对未声明的名字会 omitempty 掉，所以这条路径真的会走到）。
    const deviceTypeLabel = (type?: string) => {
        if (type === 'desktop') return t('desktopDevice');
        if (type === 'smartphone' || type === 'mobile' || type === 'tablet') return t('mobileDevice');
        return t('otherDevice');
    };

    return (
        <>
            <Box
                className="unified-composer"
                onDragEnter={(e) => { e.preventDefault(); setDragover(true); }}
                onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragover(false); }}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragover(false);
                    const files = Array.from(e.dataTransfer?.files || []);
                    if (files.length) handleSelectFiles(files);
                }}
                sx={{
                    border: 1,
                    borderColor: dragover ? 'primary.main' : 'divider',
                    borderRadius: 4,
                    p: { xs: 0.5, md: 1.5 },
                    display: 'flex',
                    flexDirection: 'column',
                    bgcolor: 'background.paper',
                }}
            >
                {display.composerText && (
                    <Box sx={{ position: 'relative', order: isFilePrimary ? 3 : 1 }}>
                        {slashMenu && <ComposerSlashMenu items={SLASH_TEMPLATES as SlashTemplate[]} onPick={(item) => void insertSlashTemplate(item)} />}
                        <Tooltip title={t('enterTextToSend')}>
                            <IconButton size="small" aria-label={t('enterTextToSend')} sx={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }} onClick={() => setTextFullscreen(true)}>
                                <MdiIcon name="mdi-fullscreen" size={18} />
                            </IconButton>
                        </Tooltip>
                        <TextField
                            inputRef={textareaRef}
                            fullWidth
                            multiline
                            rows={isFilePrimary ? 1 : 3}
                            value={send.text}
                            placeholder={textareaPlaceholder}
                            onChange={(e) => useAppStore.setState({ send: { ...useAppStore.getState().send, text: e.target.value } })}
                            onKeyDown={onKeyDown}
                            onInput={onTextareaInput}
                            onCompositionEnd={onTextareaInput}
                        />
                    </Box>
                )}

                {display.composerText && display.composerUpload && (
                    <Stack direction="row" alignItems="center" spacing={1} sx={{ py: 0.5, order: 2 }}>
                        <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
                        <Typography variant="caption" color="text.secondary">
                            {t('composerTextLimit', { current: send.text.length, limit: config.text.limit })}
                        </Typography>
                        <Box sx={{ width: 24, height: '1px', bgcolor: 'divider' }} />
                        {display.composerSwap && (
                            <Tooltip title={isFilePrimary ? t('textIsPrimaryTip') : t('fileIsPrimaryTip')}>
                                <IconButton size="small" aria-label={isFilePrimary ? t('textIsPrimaryTip') : t('fileIsPrimaryTip')} onClick={() => useAppStore.getState().toggleComposerPrimary()}>
                                    <MdiIcon name="mdi-swap-vertical" size={18} />
                                </IconButton>
                            </Tooltip>
                        )}
                        <Box sx={{ width: 24, height: '1px', bgcolor: 'divider' }} />
                        <Typography variant="caption" color="text.secondary">
                            {t('fileSizeLimit', { limit: prettyFileSize(config.file.limit) })}
                        </Typography>
                        <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
                    </Stack>
                )}

                {display.composerUpload && (
                    <Box sx={{ order: isFilePrimary ? 1 : 3 }}>
                        <Box
                            onClick={() => selectFileRef.current?.click()}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexDirection: isFilePrimary ? 'column' : 'row',
                                border: '1px dashed',
                                borderColor: 'divider',
                                borderRadius: 3,
                                minHeight: isFilePrimary ? 112 : 40,
                                cursor: 'pointer',
                            }}
                        >
                            <MdiIcon name="mdi-cloud-upload-outline" size={isFilePrimary ? 40 : 20} style={{ marginRight: 8 }} />
                            <Typography variant="body2">{t(mobile ? 'addFilesShort' : 'addFiles', { keys: pasteKey })}</Typography>
                        </Box>
                        {send.files.length > 0 && (
                            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', pt: 1 }}>
                                {send.files.map((file, index) => (
                                    <Chip
                                        key={`${file.name}-${file.size}-${index}`}
                                        size="small"
                                        variant="outlined"
                                        label={`${file.name} · ${prettyFileSize(file.size)}`}
                                        onDelete={() => useAppStore.setState({ send: { ...useAppStore.getState().send, files: send.files.filter((_, i) => i !== index) } })}
                                    />
                                ))}
                            </Stack>
                        )}
                    </Box>
                )}

                {progress && (
                    <Box sx={{ pt: 1, order: 4 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'right' }}>
                            {prettyFileSize(Math.min(uploadedSize, fileSize))} / {prettyFileSize(fileSize)} ({Math.round(uploadProgress * 100)}%)
                        </Typography>
                    </Box>
                )}

                {/* ⚠️ 页脚是**三列 grid**（对应 Vue 的 `minmax(0,1fr) auto minmax(0,1fr)`）：
                    图标组占第 2 列 → 视觉居中；发送按钮占第 3 列 → 右对齐。
                    用 flex + `flex:1` 撑开是做不到居中的（那样只会把图标推到右边）。 */}
                {/* ⚠️★ 页脚必须显式 `order: 5`。上面那三个块用了 `order` 1/2/3 做「交换」，
                    而**没写 order 的元素默认是 0** —— 于是页脚会被排到它们**前面**（跑到输入区顶部）。
                    这是引入 order 交换时踩的坑：凡是同容器里有元素用了 order，其余元素都要显式给值。 */}
                <Box
                    className="unified-composer__footer"
                    sx={{
                        order: 5,
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
                        alignItems: 'center',
                        gap: 1.5,
                        pt: 1,
                        borderTop: 1,
                        borderColor: 'divider',
                        mt: 1,
                    }}
                >
                    <Stack className="unified-composer__footer-icons" direction="row" alignItems="center" justifyContent="center" spacing={0.5} sx={{ gridColumn: 2, minWidth: 0 }}>
                    {display.composerDevice && (
                        <Tooltip title={t('connectedTotal', { count: devices.length })}>
                            <Button className="unified-composer__device" size="small" sx={{ color: 'text.secondary' }} startIcon={<MdiIcon name="mdi-laptop" size={16} />} onClick={() => setDeviceDialog(true)}>
                                {deviceStats.desktop} / {deviceStats.mobile} / {deviceStats.other}
                            </Button>
                        </Tooltip>
                    )}
                    {display.composerReward && (
                        <Tooltip title={t('reward')}>
                            <IconButton size="small" aria-label={t('reward')} onClick={() => setRewardDialog(true)}>
                                <MdiIcon name="mdi-currency-cny" size={18} className="unified-composer__reward-icon" />
                            </IconButton>
                        </Tooltip>
                    )}
                    {display.composerPalette && (
                        <Tooltip title={t('traditionalColors')}>
                            <IconButton size="small" aria-label={t('traditionalColors')} onClick={() => setColorDialog(true)}>
                                <MdiIcon name="mdi-palette-swatch" size={18} />
                            </IconButton>
                        </Tooltip>
                    )}
                    {display.composerShortcuts && (
                        <Tooltip title={t('shortcuts')}>
                            <IconButton size="small" aria-label={t('shortcuts')} onClick={() => setShortcutsDialog(true)}>
                                <MdiIcon name="mdi-flash" size={18} />
                            </IconButton>
                        </Tooltip>
                    )}
                    {display.composerTheme && (
                        <Tooltip title={t('toggleDarkMode')}>
                            <IconButton
                                size="small"
                                aria-label={t('toggleDarkMode')}
                                onClick={() => {
                                    const state = useAppStore.getState();
                                    useAppStore.setState({ dark: state.dark === 'enable' ? 'disable' : 'enable' });
                                }}
                            >
                                <MdiIcon name="mdi-theme-light-dark" size={18} />
                            </IconButton>
                        </Tooltip>
                    )}
                    </Stack>
                    {/* ⚠️ 发送按钮必须是**页脚 grid 的直接子项**（第 3 列、右对齐）——
                        之前它被写在了上面那个居中图标 Stack 的**内部**，于是 `gridColumn` 完全失效，
                        它被当成 flex 子项挤在图标排末尾（实测 centerPct 从 94% 变成 ~70%）。
                        Vue 版实测：图标组 centerPct=50（正中）、发送按钮 centerPct=94（最右）。 */}
                    {canSend && (
                        <Button className="unified-composer__send" variant="contained" size="small" disabled={sendDisabled} onClick={sendAll} startIcon={<MdiIcon name="mdi-send" size={16} />} sx={{ gridColumn: 3, justifySelf: 'end' }}>
                            {t('send')}
                        </Button>
                    )}
                </Box>

                <input
                    ref={selectFileRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                        handleSelectFiles(Array.from(e.target.files || []));
                        e.target.value = '';
                    }}
                />
            </Box>

            {/* 全屏输入窗 */}
            {/* ⚠️ 透明度**只做在面板底色**上（文字/按钮不跟着淡），目的是「透过面板看见背后的内容」。
                ⚠️★ `backgroundImage: 'none'` 不能省：暗色主题下 MUI 的 Paper 会叠一层 elevation
                提亮渐变，不关掉的话改 `backgroundColor` 根本看不出来。
                ⚠️ 遮罩（backdrop）跟着同一个比例变淡 —— 只调面板的话，背后仍压着一层 50% 黑，
                「能看清背后」就落空了。 */}
            <Dialog
                open={textFullscreen}
                onClose={() => setTextFullscreen(false)}
                fullWidth
                maxWidth="md"
                slotProps={{
                    paper: {
                        sx: {
                            backgroundColor: `color-mix(in srgb, var(--mui-palette-background-paper) ${fullscreenOpacity}%, transparent)`,
                            backgroundImage: 'none',
                        },
                    },
                    backdrop: {
                        sx: { backgroundColor: `rgba(0, 0, 0, ${0.5 * (fullscreenOpacity / 100)})` },
                    },
                }}
            >
                {/* ⚠️★ 窄屏这一行塞不下 5 个东西（返回 / 标题 / 滑块 / 收起开关 / 发送）——
                    实测 360px 下标题被挤到只剩 **7px**（等于没有标题）。所以让它**换行**：
                    xs 下把滑块 `order` 排到最后并占满一整行，第一行就腾出来给标题了。
                    （`Tooltip` 不产生 DOM 节点，flex 子项仍是那个 `Box`，`order` 因此生效。） */}
                <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <IconButton size="small" onClick={() => setTextFullscreen(false)}><MdiIcon name="mdi-arrow-left" size={18} /></IconButton>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('enterTextToSend')}</span>
                    {/* 透明度滑块：只调面板**底色**（见上面 `slotProps.paper` 的说明）。 */}
                    <Tooltip title={t('fullscreenOpacity')}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: '0 0 auto', width: { xs: '100%', sm: 200 }, order: { xs: 1, sm: 0 } }}>
                            <MdiIcon name="mdi-opacity" size={18} />
                            <Slider
                                size="small"
                                value={fullscreenOpacity}
                                min={FULLSCREEN_OPACITY_MIN}
                                max={FULLSCREEN_OPACITY_MAX}
                                step={5}
                                aria-label={t('fullscreenOpacity')}
                                onChange={(_event, value) => useAppStore.getState().setFullscreenOpacity(value as number)}
                                sx={{ flex: 1 }}
                            />
                            <Typography variant="caption" color="text.secondary" sx={{ width: 34, textAlign: 'right' }}>
                                {fullscreenOpacity}%
                            </Typography>
                        </Box>
                    </Tooltip>
                    <Tooltip title={fullscreenSendClose ? t('fullscreenCloseAfterSendOn') : t('fullscreenCloseAfterSendOff')}>
                        <IconButton size="small" aria-label={t('enterTextToSend')} onClick={() => useAppStore.getState().toggleFullscreenSendClose()}>
                            <MdiIcon name={fullscreenSendClose ? 'mdi-chevron-down-circle' : 'mdi-window-restore'} size={18} />
                        </IconButton>
                    </Tooltip>
                    <Button variant="contained" size="small" disabled={sendDisabled} onClick={sendAll} startIcon={<MdiIcon name="mdi-send" size={16} />}>
                        {t('send')}
                    </Button>
                </DialogTitle>
                <DialogContent>
                    {slashMenu && <ComposerSlashMenu items={SLASH_TEMPLATES as SlashTemplate[]} onPick={(item) => void insertSlashTemplate(item)} />}
                    <TextField
                        fullWidth
                        multiline
                        minRows={12}
                        value={send.text}
                        placeholder={textareaPlaceholder}
                        onChange={(e) => useAppStore.setState({ send: { ...useAppStore.getState().send, text: e.target.value } })}
                        onKeyDown={onKeyDown}
                        onInput={onTextareaInput}
                    />
                </DialogContent>
            </Dialog>

            {/* 设备列表 */}
            <Dialog open={deviceDialog} onClose={() => setDeviceDialog(false)} maxWidth="sm" fullWidth>
                <DialogTitle>{t('connectedDevices')}</DialogTitle>
                <DialogContent>
                    {devices.length === 0
                        ? <Typography variant="body2" color="text.secondary">{connected ? t('noDevicesConnected') : t('notConnectedToServer')}</Typography>
                        : (
                            <>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                    {t('devicesConnected', { count: devices.length, desktop: deviceStats.desktop, mobile: deviceStats.mobile })}
                                </Typography>
                                {devices.map((item) => (
                                    <Typography key={item.id} variant="body2">
                                        {item.name || deviceTypeLabel(item.type)} — {item.os} ({item.browser})
                                    </Typography>
                                ))}
                            </>
                        )}
                </DialogContent>
            </Dialog>

            {/* 赞助 —— 与设置里那个入口**共用一份定义**（见 DonateDialog 的注释）。
                ⚠️ 这里曾有一份手抄的副本，漏掉了腾讯云 / 阿里云两个按钮，
                于是 `cloudPromoHint` 的「可以看看这些活动价 👇」指向空气。
                `showSectionTitle={false}`：标题已经就是 `rewardTitle`，不再重复一条同义的分组标题。 */}
            <DonateDialog
                open={rewardDialog}
                onClose={() => setRewardDialog(false)}
                titleKey="rewardTitle"
                showSectionTitle={false}
            />

            <TraditionalColorDialog open={colorDialog} onClose={() => setColorDialog(false)} />
            <ShortcutsDialog open={shortcutsDialog} onClose={() => setShortcutsDialog(false)} />
        </>
    );
});
