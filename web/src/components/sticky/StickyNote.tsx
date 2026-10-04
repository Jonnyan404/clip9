import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Dialog, DialogContent, DialogTitle, Divider, IconButton, Stack, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useMarkdown } from '@/hooks/useMarkdown';
import { useTaskListToggle } from '@/hooks/useTaskListToggle';
import { copyTextToClipboard, deviceLabel, errorMessage, formatTimestamp, prettyFileSize } from '@/lib/util';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

const NOTE_COLORS = ['#fffbe8', '#eef7ff', '#f3fff0', '#fff0f3', '#f7f0ff'];

/**
 * 便签卡片 —— 从 web-vue3/src/components/sticky/StickyNote.vue 移植。
 *
 * ⚠️ 正文（含任务列表打勾 + 落盘）走共享 hook；复制也用它返回的 `text`。
 * ⚠️ md 渲染只接在**阅读器**（点开便签后的大视图）—— 便签卡片本身是贴纸风格、面积也小，
 * 渲染排版反而破坏那个感觉。
 * ⚠️ 取文源必须分岔：文本便签在 `meta.content`，**文件的 FileReceive 没有 content 字段**，
 * 正文只能等 `loadPreview` 抓回来的文本。
 */
export function StickyNote({ meta }: { meta: ReceivedItem }) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const [expanded, setExpanded] = useState(false);
    const [textPreview, setTextPreview] = useState('');
    const [previewSrc, setPreviewSrc] = useState('');
    const [loadingPreview, setLoadingPreview] = useState(false);

    const isFile = meta.type === 'file';
    const { text: decodedContent, onMdClick } = useTaskListToggle(meta, () => useWebSocketStore.getState().room);

    const md = useMarkdown(
        () => (isFile ? textPreview : decodedContent),
        () => /\.(md|markdown|mdown|mkd)$/i.test(meta.name || ''),
    );

    // 便签配色与旋转由 id 哈希决定（同一张便签每次都长一样）。
    const colorIndex = useMemo(() => {
        const id = String(meta.id || '');
        let hash = 0;
        for (const ch of id) {
            hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        }
        return hash % 5;
    }, [meta.id]);
    const rotation = [-1.5, 1.5, -1, 2, -2][colorIndex] ?? 0;

    const expired = Boolean(meta.expire && meta.expire > 0 && Date.now() / 1000 > meta.expire);

    const isLink = !isFile && /^https?:\/\/[^\s]+$/i.test(decodedContent.trim());
    const noteLabel = isFile ? 'FILE' : isLink ? 'LINK' : 'TEXT';

    const loadPreview = async () => {
        if (!isFile || loadingPreview) return;
        setLoadingPreview(true);
        try {
            const name = String(meta.name || '');
            if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|ogv|mov|mp3|wav|ogg|opus|m4a|flac)$/i.test(name)) {
                const { createShareLink } = await import('@/services/share');
                const data = await createShareLink({ type: 'file', uuid: meta.cache, ttl: 900, maxUses: 0, room: useWebSocketStore.getState().room });
                setPreviewSrc(data?.rawUrl || '');
            } else {
                const response = await axios.get(`file/${meta.cache}/${encodeURIComponent(name)}`, { responseType: 'text' });
                setTextPreview(typeof response.data === 'string' ? response.data : String(response.data || ''));
            }
        } catch (error) {
            toast(errorMessage(error) || t('fileFetchFailed'));
        } finally {
            setLoadingPreview(false);
        }
    };

    const openReader = () => {
        setExpanded(true);
        if (isFile && !textPreview && !previewSrc) void loadPreview();
    };

    const copyText = async () => {
        try {
            await copyTextToClipboard(isFile ? textPreview : decodedContent);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    const deleteItem = async () => {
        try {
            await axios.delete(`revoke/${meta.id}`, { params: new URLSearchParams([['room', useWebSocketStore.getState().room]]) });
            toast(t('deleteSuccessText'));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedMessageMsg', { msg }) : t('deleteFailedMessage'));
        }
    };

    const timestampLabel = [
        meta.timestamp && display.timestamp ? formatTimestamp(meta.timestamp) : '',
        display.device ? deviceLabel(meta.senderDevice) : '',
    ].filter(Boolean).join(' ');

    return (
        <>
            <Box
                onClick={openReader}
                sx={{
                    width: '100%',
                    bgcolor: NOTE_COLORS[colorIndex],
                    border: '1px solid rgba(0,0,0,0.06)',
                    borderRadius: 1.5,
                    p: 1.5,
                    cursor: 'pointer',
                    transform: `rotate(${rotation}deg)`,
                    boxShadow: '0 2px 6px rgba(68,64,42,0.10)',
                    color: '#444034',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.75,
                    minHeight: 120,
                }}
            >
                <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.06em', opacity: 0.55 }}>{noteLabel}</Typography>
                    <span style={{ flex: 1 }} />
                    {expired && <Typography variant="caption" color="error">{t('expired')}</Typography>}
                    <MdiIcon name={isFile ? 'mdi-paperclip' : 'mdi-pin'} size={14} />
                </Stack>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                    {isFile ? (meta.name || 'file') : decodedContent}
                </Typography>
                <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography variant="caption" sx={{ opacity: 0.6, flex: 1 }} noWrap>
                        {isFile ? prettyFileSize(Number(meta.size || 0)) : timestampLabel}
                    </Typography>
                    <ShareLinkButton meta={meta} />
                </Stack>
            </Box>

            <Dialog open={expanded} onClose={() => setExpanded(false)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.06em', opacity: 0.55 }}>{noteLabel}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                        {[meta.timestamp ? formatTimestamp(meta.timestamp) : '', display.ip && meta.senderIP ? String(meta.senderIP) : ''].filter(Boolean).join(' · ')}
                    </Typography>
                    <IconButton size="small" onClick={() => setExpanded(false)} aria-label={t('close')}>
                        <MdiIcon name="mdi-close" size={16} />
                    </IconButton>
                </DialogTitle>
                <DialogContent>
                    {isFile ? (
                        <>
                            {previewSrc && /\.(mp4|webm|ogv|mov)$/i.test(String(meta.name)) && <video src={previewSrc} controls style={{ width: '100%', borderRadius: 8 }} />}
                            {previewSrc && /\.(mp3|wav|ogg|opus|m4a|flac)$/i.test(String(meta.name)) && <audio src={previewSrc} controls style={{ width: '100%' }} />}
                            {previewSrc && /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(String(meta.name)) && <img src={previewSrc} alt={meta.name} style={{ maxWidth: '100%', borderRadius: 8 }} />}
                            {!previewSrc && (
                                <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}>
                                    {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                                    {md.html ? <MarkdownBody html={md.html} /> : <pre className="code-block">{textPreview || (loadingPreview ? '…' : '')}</pre>}
                                </div>
                            )}
                            <Typography variant="body2" sx={{ mt: 1, wordBreak: 'break-all' }}>{meta.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{prettyFileSize(Number(meta.size || 0))}</Typography>
                        </>
                    ) : (
                        <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties} onClick={onMdClick}>
                            {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                            {md.html ? <MarkdownBody html={md.html} /> : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{decodedContent}</div>}
                        </div>
                    )}
                    <Divider sx={{ my: 2 }} />
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                        {!isFile && (
                            <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-content-copy" size={16} />} onClick={copyText}>
                                {t('copyText')}
                            </Button>
                        )}
                        <ShareLinkButton meta={meta} iconOnly={false} />
                        <span style={{ flex: 1 }} />
                        <Button size="small" variant="text" color="error" startIcon={<MdiIcon name="mdi-close-circle-outline" size={16} />} onClick={deleteItem}>
                            {t('delete')}
                        </Button>
                    </Stack>
                </DialogContent>
            </Dialog>
        </>
    );
}
