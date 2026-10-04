import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Chip, Stack, TextField } from '@mui/material';
import axios from 'axios';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { errorMessage, getClientId, prettyFileSize } from '@/lib/util';
import { postText } from '@/services/send';
import { SLASH_TEMPLATES, resolveSlashText, slashMenuShouldOpen, slashMenuShouldStay, slashPendingAt, stripTrailingSlash } from '@/lib/slash-template.js';
import { runActionById } from '@/lib/actions/index.js';
import { ComposerSlashMenu, type SlashTemplate } from '@/components/ComposerSlashMenu';

export interface StickyComposerHandle {
    focus: () => void;
    addFiles: (files: File[]) => void;
}

const isApplePlatform = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.userAgent || '');
const isTouchOnly = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;

/**
 * 非标准模式的输入区 —— 从 web-vue3/src/components/sticky/StickyComposer.vue 移植。
 *
 * ⚠️ 五个非标准模式（glance 除外）与看板共用这一个组件，靠 `variant` 换皮肤 ——
 * 「改发送区只需改一处」。
 * ⚠️ 文本区与上传区**都关掉**时不留空：把这块位置改成搜索框（不能发的时候，搜索才是主操作）。
 * ⚠️ 发送约定：**主修饰键 + Enter**（跨平台、跨模式一套）。回车本身永远是换行。
 */
export const StickyComposer = forwardRef<StickyComposerHandle, { variant?: string }>(function StickyComposer({ variant = 'sticky' }, ref) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const send = useAppStore((s) => s.send);
    const config = useAppStore((s) => s.config);
    const searchQuery = useAppStore((s) => s.searchQuery);
    const connected = useWebSocketStore((s) => s.websocket !== null);

    const [sending, setSending] = useState(false);
    const [slashMenu, setSlashMenu] = useState(false);
    const [uploadedSizes, setUploadedSizes] = useState<number[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const selectFileRef = useRef<HTMLInputElement | null>(null);
    const slashElRef = useRef<HTMLTextAreaElement | null>(null);
    const clientId = getClientId();

    const sendShortcutLabel = t('sendShortcutTip', { keys: isApplePlatform ? '⌘+Enter' : 'Ctrl+Enter' });
    const placeholder = isTouchOnly
        ? t(variant === 'board' ? 'composerSlashHint' : 'stickyNewNote')
        : `${t(variant === 'board' ? 'composerSlashHint' : 'stickyNewNote')} ${sendShortcutLabel}`;

    const fileSize = send.files.reduce((acc, cur) => acc + cur.size, 0);
    const uploadedSize = uploadedSizes.reduce((acc, cur) => acc + cur, 0);
    const uploadProgress = fileSize ? Math.min(uploadedSize / fileSize, 1) : 0;
    const canSend = Boolean(display.composerText || display.composerUpload);
    const sendDisabled = !connected || sending || (!send.text && !send.files.length) || send.text.length > config.text.limit;

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
        useAppStore.setState({ send: { ...useAppStore.getState().send, files } });
    }, [config.file.limit, t]);

    useImperativeHandle(ref, () => ({
        focus: () => textareaRef.current?.focus(),
        addFiles: (files: File[]) => handleSelectFiles(files),
    }), [handleSelectFiles]);

    // 全局粘贴：有文件时拦下默认行为（与标准模式同一套逻辑）。
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            if (!event.clipboardData) return;
            const files = Array.from(event.clipboardData.items || [])
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .filter(Boolean) as File[];
            if (!files.length) files.push(...Array.from(event.clipboardData.files || []));
            if (files.length) {
                event.preventDefault();
                handleSelectFiles(files);
            }
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, [handleSelectFiles]);

    const onAreaInput = (event: React.FormEvent<HTMLElement>) => {
        const target = event.target as HTMLTextAreaElement;
        if (!slashMenu) {
            if (!slashMenuShouldOpen(event.nativeEvent, send.text)) return;
            slashElRef.current = target;
            setSlashMenu(true);
            return;
        }
        if (!slashMenuShouldStay(event.nativeEvent, send.text)) setSlashMenu(false);
    };

    const insertSlashTemplate = async (item: SlashTemplate) => {
        const el = slashElRef.current || textareaRef.current;
        const text = send.text || '';
        const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
        const head = stripTrailingSlash(text.slice(0, pos));
        const tail = text.slice(pos);
        const insert = await resolveSlashText(item, runActionById);
        useAppStore.setState({ send: { ...useAppStore.getState().send, text: head + insert + tail } });
        setSlashMenu(false);
        const caret = head.length + insert.length;
        requestAnimationFrame(() => {
            el?.focus?.();
            el?.setSelectionRange?.(caret, caret);
        });
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
            void sendAll();
        }
    };

    const sendText = async () => {
        const text = useAppStore.getState().send.text;
        if (!text) return;
        await postText({ room: useWebSocketStore.getState().room, text, client: clientId });
        useAppStore.setState({ send: { ...useAppStore.getState().send, text: '' } });
    };

    const sendFiles = async () => {
        const files = useAppStore.getState().send.files;
        if (!files.length) return;
        const chunkSize = config.file.chunk;
        const room = useWebSocketStore.getState().room;
        setUploadedSizes(Array(files.length).fill(0));
        setSending(true);
        await Promise.all(files.map(async (file, index) => {
            if (file.size < chunkSize) {
                const formData = new FormData();
                formData.set('file', file);
                await axios.postForm('upload', formData, {
                    params: new URLSearchParams([['room', room], ['client', clientId]]),
                    onUploadProgress: (e) => setUploadedSizes((prev) => prev.map((v, i) => (i === index ? e.loaded : v))),
                });
                return;
            }
            const response = await axios.post('upload/chunk', file.name, {
                headers: { 'Content-Type': 'text/plain' },
                params: new URLSearchParams([['room', room]]),
            });
            const uuid = response.data.result.uuid;
            let uploaded = 0;
            while (uploaded < file.size) {
                const chunk = file.slice(uploaded, uploaded + chunkSize);
                await axios.post(`upload/chunk/${uuid}`, chunk, {
                    headers: { 'Content-Type': 'application/octet-stream' },
                    onUploadProgress: (e) => setUploadedSizes((prev) => prev.map((v, i) => (i === index ? uploaded + e.loaded : v))),
                });
                uploaded += chunkSize;
            }
            await axios.post(`upload/finish/${uuid}`, null, { params: new URLSearchParams([['room', room], ['client', clientId]]) });
        }));
        useAppStore.setState({ send: { ...useAppStore.getState().send, files: [] } });
    };

    async function sendAll() {
        if (sendDisabled) return;
        try {
            await sendText();
            await sendFiles();
            toast(t('sendSuccess'));
            textareaRef.current?.focus();
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('sendFailedMsg', { msg }) : t('sendFailed'));
        } finally {
            setSending(false);
            setSlashMenu(false);
        }
    }

    // 文本区与上传区都关掉 = 这个模式只想接收 → 把这块位置改成搜索框。
    if (!display.composerText && !display.composerUpload) {
        return (
            <TextField
                fullWidth
                size="small"
                value={searchQuery}
                placeholder={t('searchPlaceholder')}
                onChange={(e) => useAppStore.getState().setSearchQuery(e.target.value)}
                slotProps={{ input: { startAdornment: null } }}
            />
        );
    }

    const isBoard = variant === 'board';

    return (
        <Box
            sx={{
                border: '1px dashed',
                borderColor: 'divider',
                borderRadius: isBoard ? 2 : 3,
                p: isBoard ? '7px 11px' : '10px 13px',
                bgcolor: 'background.paper',
            }}
        >
            {display.composerUpload && send.files.length > 0 && (
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', mb: 1 }}>
                    {send.files.map((file, index) => (
                        <Chip
                            key={`${file.name}-${index}`}
                            size="small"
                            label={`${file.name}${sending ? ` · ${Math.round(uploadProgress * 100)}%` : ''}`}
                            onDelete={() => useAppStore.setState({ send: { ...useAppStore.getState().send, files: send.files.filter((_, i) => i !== index) } })}
                        />
                    ))}
                </Stack>
            )}

            {slashMenu && <ComposerSlashMenu items={SLASH_TEMPLATES as SlashTemplate[]} onPick={(item) => void insertSlashTemplate(item)} />}

            <Stack direction="row" alignItems="center" spacing={1}>
                {display.composerUpload && (
                    <Button size="small" onClick={() => selectFileRef.current?.click()} aria-label={t('addFiles')}>
                        ➕
                    </Button>
                )}
                {display.composerText && (
                    <TextField
                        inputRef={textareaRef}
                        fullWidth
                        multiline
                        minRows={isBoard ? 5 : 3}
                        maxRows={isBoard ? 14 : 6}
                        value={send.text}
                        placeholder={placeholder}
                        onChange={(e) => useAppStore.setState({ send: { ...useAppStore.getState().send, text: e.target.value } })}
                        onKeyDown={onKeyDown}
                        onInput={onAreaInput}
                        onCompositionEnd={onAreaInput}
                    />
                )}
                {canSend && (
                    <Button variant="contained" size="small" disabled={sendDisabled} onClick={sendAll}>
                        {variant === 'sticky' ? t('stickyStick') : t('send')}
                    </Button>
                )}
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
            </Stack>
        </Box>
    );
});
