import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '@mui/material';
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

    // ⚠️★ 结构与 class 名**逐一对齐 Vue 版**（`sticky-composer` / `__files` / `__row` /
    // `__attach` / `__area` / `__go`）：那块「便签纸」的观感（米黄底 + 虚线边）靠的是
    // **裸 textarea + 自绘按钮**。换成 MUI 的 TextField/Button 之后输入框自带边框与底色，
    // 纸的观感就没了 —— 皮肤在 styles/components.css 的 `.sticky-composer*`。
    return (
        <div className={`sticky-composer sticky-composer--${variant}`}>
            {display.composerUpload && send.files.length > 0 && (
                <div className="sticky-composer__files">
                    {send.files.map((file, index) => (
                        <span key={`${file.name}-${index}`} className="sticky-composer__file">
                            {file.name}
                            <b
                                className="sticky-composer__closer"
                                onClick={() => useAppStore.setState({ send: { ...useAppStore.getState().send, files: send.files.filter((_, i) => i !== index) } })}
                            >
                                ✕
                            </b>
                        </span>
                    ))}
                    {sending && <span className="sticky-composer__progress">{Math.round(uploadProgress * 100)}%</span>}
                </div>
            )}

            {slashMenu && <ComposerSlashMenu items={SLASH_TEMPLATES as SlashTemplate[]} onPick={(item) => void insertSlashTemplate(item)} />}

            <div className="sticky-composer__row">
                {display.composerUpload && (
                    <button
                        type="button"
                        className="sticky-composer__attach"
                        title="📎"
                        aria-label={t('addFiles')}
                        onClick={() => selectFileRef.current?.click()}
                    >
                        ➕
                    </button>
                )}
                {display.composerText && (
                    <textarea
                        ref={textareaRef}
                        className="sticky-composer__area"
                        rows={1}
                        value={send.text}
                        placeholder={placeholder}
                        onChange={(e) => useAppStore.setState({ send: { ...useAppStore.getState().send, text: e.target.value } })}
                        onKeyDown={onKeyDown}
                        onInput={onAreaInput}
                        onCompositionEnd={onAreaInput}
                    />
                )}
                {canSend && (
                    <button
                        type="button"
                        className={`sticky-composer__go sticky-composer__go--${variant}`}
                        disabled={sendDisabled}
                        onClick={sendAll}
                    >
                        {variant === 'sticky' ? t('stickyStick') : t('send')}
                    </button>
                )}
                <input
                    ref={selectFileRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                        handleSelectFiles(Array.from(e.target.files || []));
                        e.target.value = '';
                    }}
                />
            </div>
        </div>
    );
});
