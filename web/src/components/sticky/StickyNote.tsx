import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Dialog, DialogContent, DialogTitle, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useMarkdown } from '@/hooks/useMarkdown';
import { useTaskListToggle } from '@/hooks/useTaskListToggle';
import {
    SHARE_DEFAULT_TTL, copyTextToClipboard, deviceLabel, errorMessage, formatTimestamp, isFileEntry, isImageName, prettyFileSize,
} from '@/lib/util';
import { createShareLink } from '@/services/share';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 便签卡片 —— 从 web-vue3/src/components/sticky/StickyNote.vue 移植。
 *
 * ⚠️ 正文（含任务列表打勾 + 落盘）走共享 hook；复制也用它返回的 `text`。
 * ⚠️ 卡片**本身就渲染 md**（任务列表 / 表格默认就是 md），所以卡片上的复选框也能直接勾。
 * ⚠️ 取文源必须分岔：文本便签在 `meta.content`，**文件的 FileReceive 没有 content 字段**，
 * 正文只能等 `loadPreview` 抓回来的文本。
 * ⚠️★ 配色 / 旋转 / 胶带条 / 悬停动作行**全部走 CSS 的 `.sticky-note*`**（styles/components.css），
 *    与 Vue 同名同值 —— 别在这里用 MUI 的 `sx` 再描一遍：两处一定会漂（这次就是这么漂的）。
 * ⚠️ 「文件 / 文本」的判据是 `isFileEntry`，**不是** `type === 'file'` —— 理由见 util.ts。
 */
export function StickyNote({ meta }: { meta: ReceivedItem }) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const [expanded, setExpanded] = useState(false);
    const [textPreview, setTextPreview] = useState('');
    const [previewSrc, setPreviewSrc] = useState('');
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [downloading, setDownloading] = useState(false);

    const isFile = isFileEntry(meta);
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
    const isExpirable = Boolean(meta.expire && meta.expire > 0);
    const expireLabel = isExpirable
        ? (expired ? t('expired') : t('expiresAt', { time: formatTimestamp(meta.expire as number) }))
        : '';

    const isLink = !isFile && /^https?:\/\/[^\s]+$/i.test(decodedContent.trim());
    // ⚠️ 文件的标签恒为 `FILE`（Vue 也是）—— 别按扩展名换成「图片」，
    //    那是下面 `fileMetaLabel` 的活。
    const noteLabel = isFile ? 'FILE' : isLink ? 'LINK' : 'TEXT';

    // 文件条目的行内图标（emoji，与 Vue 一致）与「大小 · 图片」小字。
    const fileIcon = (() => {
        const name = String(meta.name || '');
        if (!name) return '📄';
        if (isImageName(name)) return '🖼️';
        if (/\.(mp4|webm|ogv|mov)$/i.test(name)) return '🎬';
        if (/\.(mp3|wav|ogg|opus|m4a|flac)$/i.test(name)) return '🎵';
        return '📄';
    })();
    const fileMetaLabel = isImageName(meta.name)
        ? `${prettyFileSize(Number(meta.size || 0))} · ${t('stickyImage')}`
        : prettyFileSize(Number(meta.size || 0));

    const ensureRawUrl = async (): Promise<string> => {
        const data = await createShareLink({ type: 'file', uuid: meta.cache, ttl: SHARE_DEFAULT_TTL, maxUses: 0, room: useWebSocketStore.getState().room });
        return data?.rawUrl || '';
    };

    const loadPreview = async () => {
        if (!isFile || loadingPreview) return;
        setLoadingPreview(true);
        try {
            const name = String(meta.name || '');
            if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|ogv|mov|mp3|wav|ogg|opus|m4a|flac)$/i.test(name)) {
                setPreviewSrc(await ensureRawUrl());
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

    // 下载：一次签发拿到直连地址，再补 `download=true` 走浏览器的保存流程。
    const downloadFile = async () => {
        if (expired || downloading) return;
        setDownloading(true);
        try {
            const url = await ensureRawUrl();
            if (!url) return;
            const target = new URL(url, window.location.origin);
            target.searchParams.set('download', 'true');
            const anchor = document.createElement('a');
            anchor.href = target.toString();
            anchor.download = String(meta.name || 'file');
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
        } catch (error) {
            console.error('下载失败:', error);
            toast(t('fileFetchFailed'));
        } finally {
            setDownloading(false);
        }
    };

    const deleteItem = async () => {
        try {
            await axios.delete(`revoke/${meta.id}`, { params: new URLSearchParams([['room', useWebSocketStore.getState().room]]) });
            toast(t(isFile ? 'deleteSuccessFile' : 'deleteSuccessText', { name: meta.name }));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedMessageMsg', { msg }) : t('deleteFailedMessage'));
        }
    };

    const timestampLabel = [
        meta.timestamp && display.timestamp ? formatTimestamp(meta.timestamp) : '',
        display.device && deviceLabel(meta.senderDevice) ? t('stickyFromDevice', { device: deviceLabel(meta.senderDevice) }) : '',
    ].filter(Boolean).join(' ');
    // 详情弹窗那一行 = 卡片页脚那行 + IP（卡片太小，塞不下 IP）。
    const readerTimeLabel = [
        timestampLabel,
        display.ip && meta.senderIP ? String(meta.senderIP) : '',
    ].filter(Boolean).join(' · ');

    const opLabel = isFile ? (expired ? t('expired') : t('download')) : t('copyText');

    return (
        <>
            <div
                className={`sticky-note sticky-note--c${colorIndex}${expired ? ' sticky-note--expired' : ''}`}
                style={{ '--rt': `${rotation}deg` } as React.CSSProperties}
                role="button"
                tabIndex={0}
                onClick={openReader}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        openReader();
                    }
                }}
            >
                {isFile && (
                    <div className="sticky-note__file">
                        <span className="sticky-note__fic">{fileIcon}</span>
                        <span className="sticky-note__fname" title={String(meta.name || '')}>{meta.name}</span>
                    </div>
                )}
                <div className="sticky-note__label">{noteLabel}</div>
                {isFile ? (
                    <div className="sticky-note__meta">{fileMetaLabel}</div>
                ) : (
                    <div
                        className={`sticky-note__text${isLink ? ' sticky-note__text--link' : ''}${md.html ? ' sticky-note__text--rendered' : ''}`}
                        title={decodedContent}
                        onClick={onMdClick}
                    >
                        {md.html ? <MarkdownBody html={md.html} /> : decodedContent}
                    </div>
                )}
                {timestampLabel && <span className="sticky-note__time">{timestampLabel}</span>}

                {/* 悬停才出现（触摸设备恒显，见 CSS 的 `@media (hover: none)`）。
                    ⚠️ 容器上 `stopPropagation`：卡片整块是「点开阅读器」，
                    不拦的话一点下载/删除就把大视图打开了。 */}
                <span className="sticky-note__ops" onClick={(event) => event.stopPropagation()}>
                    <Tooltip title={opLabel} placement="top">
                        <span>
                            <IconButton
                                size="small"
                                className="sticky-note__op"
                                disabled={isFile && expired}
                                aria-label={opLabel}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (isFile) void downloadFile();
                                    else void copyText();
                                }}
                            >
                                <MdiIcon name={isFile ? 'mdi-download' : 'mdi-content-copy'} size={18} />
                            </IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title={t('delete')} placement="top">
                        <span>
                            <IconButton
                                size="small"
                                className="sticky-note__op"
                                aria-label={t('delete')}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    void deleteItem();
                                }}
                            >
                                <MdiIcon name="mdi-close" size={18} />
                            </IconButton>
                        </span>
                    </Tooltip>
                </span>
            </div>

            <Dialog open={expanded} onClose={() => setExpanded(false)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.06em', opacity: 0.55 }}>{noteLabel}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                        {readerTimeLabel}
                    </Typography>
                    <IconButton size="small" onClick={() => setExpanded(false)} aria-label={t('close')}>
                        <MdiIcon name="mdi-close" size={16} />
                    </IconButton>
                </DialogTitle>
                <DialogContent>
                    {isFile ? (
                        <>
                            {/* ⚠️ 文件的名字 / 大小 / 过期**永远**显示。这几行曾经跟着预览一起被藏掉，
                                .md 文件就变成「没有名字、没有大小、没有过期」的一张空对话框。
                                过期信息**只在这里**（Vue 的卡片上也没有）—— 卡片太小，塞不下。 */}
                            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap' }}>
                                <span className="sticky-note__fic">{fileIcon}</span>
                                <Typography variant="body2" fontWeight={700} sx={{ wordBreak: 'break-all' }}>{meta.name}</Typography>
                                <Typography variant="caption" color="text.secondary">{fileMetaLabel}</Typography>
                            </Stack>
                            {isExpirable && (
                                <Typography
                                    variant="caption"
                                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: expired ? 'error.main' : 'text.secondary' }}
                                >
                                    <MdiIcon name="mdi-clock-outline" size={12} />
                                    {expireLabel}
                                </Typography>
                            )}
                            <Box sx={{ mt: 1 }}>
                                {previewSrc && /\.(mp4|webm|ogv|mov)$/i.test(String(meta.name)) && (
                                    <video src={previewSrc} controls style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 8, display: 'block', margin: '0 auto' }} />
                                )}
                                {previewSrc && /\.(mp3|wav|ogg|opus|m4a|flac)$/i.test(String(meta.name)) && (
                                    <audio src={previewSrc} controls style={{ width: '100%' }} />
                                )}
                                {previewSrc && /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(String(meta.name)) && (
                                    <img src={previewSrc} alt={meta.name} style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 8, display: 'block', margin: '0 auto' }} />
                                )}
                                {!previewSrc && (
                                    <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}>
                                        {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                                        {md.html ? <MarkdownBody html={md.html} /> : <pre className="code-block">{textPreview || (loadingPreview ? '…' : '')}</pre>}
                                    </div>
                                )}
                            </Box>
                        </>
                    ) : (
                        <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties} onClick={onMdClick}>
                            {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                            {md.html ? <MarkdownBody html={md.html} /> : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{decodedContent}</div>}
                        </div>
                    )}
                    <Divider sx={{ my: 2 }} />
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                        {isFile ? (
                            <Button
                                size="small"
                                variant="contained"
                                disabled={expired}
                                loading={downloading}
                                startIcon={<MdiIcon name="mdi-download" size={16} />}
                                onClick={downloadFile}
                            >
                                {expired ? t('expired') : t('download')}
                            </Button>
                        ) : (
                            <Button size="small" variant="contained" startIcon={<MdiIcon name="mdi-content-copy" size={16} />} onClick={copyText}>
                                {t('copyText')}
                            </Button>
                        )}
                        {!isFile && <ShareLinkButton meta={meta} iconOnly={false} />}
                        <span style={{ flex: 1 }} />
                        <Button size="small" variant="text" color="error" startIcon={<MdiIcon name="mdi-delete-outline" size={16} />} onClick={deleteItem}>
                            {t('delete')}
                        </Button>
                    </Stack>
                </DialogContent>
            </Dialog>
        </>
    );
}
