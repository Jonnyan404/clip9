import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, CardContent, Chip, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useMarkdown } from '@/hooks/useMarkdown';
import {
    SHARE_DEFAULT_TTL, deviceLabel, errorMessage, filePreviewKind,
    formatTimestamp, isImageName, prettyFileSize,
} from '@/lib/util';
import { createShareLink } from '@/services/share';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

const TEXT_PREVIEW_LIMIT = 16 * 1024;

/**
 * 文件条目卡片 —— 从 web-vue3/src/components/received-item/File.vue 移植。
 *
 * ⚠️ 判型（能不能就地预览、按哪一类渲染）用 `lib/util` 的 `filePreviewKind`（**全站唯一实现**）。
 * ⚠️ 下载/预览走**直连正文**的地址（服务端签发 token 时一起给出来的 `rawUrl`），不是分享页地址。
 */
export function ReceivedFile({ meta }: { meta: ReceivedItem }) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const room = useWebSocketStore((s) => s.room);

    const [expand, setExpand] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(0);
    const [srcPreview, setSrcPreview] = useState('');
    const [textPreview, setTextPreview] = useState('');
    const [showFullText, setShowFullText] = useState(false);
    const [downloading, setDownloading] = useState(false);

    const kind = useMemo(() => filePreviewKind(meta.name), [meta.name]);
    const isVideo = kind === 'video';
    const isAudio = kind === 'audio';
    const isText = kind === 'text';

    const expired = Boolean(meta.expire && meta.expire > 0 && Date.now() / 1000 > meta.expire);
    const hasTruncated = textPreview.length > TEXT_PREVIEW_LIMIT;
    const displayedText = hasTruncated && !showFullText ? `${textPreview.slice(0, TEXT_PREVIEW_LIMIT)}\n\n...` : textPreview;

    const md = useMarkdown(
        () => displayedText,
        () => /\.(md|markdown|mdown|mkd)$/i.test(meta.name || ''),
    );

    const ensureRawUrl = async (): Promise<string> => {
        const data = await createShareLink({ type: 'file', uuid: meta?.cache, ttl: SHARE_DEFAULT_TTL, maxUses: 0, room });
        return data?.rawUrl || '';
    };

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
            anchor.download = meta?.name || 'file';
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('fileFetchFailedMsg', { msg }) : t('fileFetchFailed'));
        } finally {
            setDownloading(false);
        }
    };

    const previewFile = async () => {
        if (expand) {
            setExpand(false);
            return;
        }
        if (srcPreview || textPreview) {
            setExpand(true);
            return;
        }
        setExpand(true);
        setLoading(true);
        setLoaded(0);
        try {
            if (isVideo || isAudio) {
                setSrcPreview(await ensureRawUrl());
            } else if (isText) {
                setShowFullText(false);
                const response = await axios.get(`file/${meta.cache}/${encodeURIComponent(meta.name || '')}`, {
                    responseType: 'text',
                    onDownloadProgress: (e) => setLoaded(e.loaded),
                });
                setTextPreview(typeof response.data === 'string' ? response.data : String(response.data || ''));
            } else {
                const response = await axios.get(`file/${meta.cache}/${encodeURIComponent(meta.name || '')}`, {
                    responseType: 'arraybuffer',
                    onDownloadProgress: (e) => setLoaded(e.loaded),
                });
                setSrcPreview(URL.createObjectURL(new Blob([response.data])));
            }
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('fileFetchFailedMsg', { msg }) : t('fileFetchFailed'));
        } finally {
            setLoading(false);
        }
    };

    const deleteItem = async () => {
        try {
            await axios.delete(`revoke/${meta.id}`, { params: new URLSearchParams([['room', room]]) });
            if (!expired && meta.cache) {
                await axios.delete(`file/${meta.cache}`);
            }
            toast(t('deleteSuccessFile', { name: meta.name }));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedFileMsg', { msg }) : t('deleteFailedFile'));
        }
    };

    const previewIcon = isVideo || isAudio ? 'mdi-movie-search-outline' : isText ? 'mdi-text-box-search-outline' : 'mdi-image-search-outline';
    const canPreview = Boolean(meta.thumbnail || kind);
    const showMeta = Boolean(meta.timestamp && (display.timestamp || display.device || display.ip));

    return (
        <Card variant="outlined" sx={{ borderRadius: 3, mb: 1.5, position: 'relative', overflow: 'hidden' }}>
            <Box sx={{ height: 4, background: 'linear-gradient(90deg, #10b981, #06b6d4)' }} />
            {meta.id && (
                <Typography variant="caption" color="text.secondary" sx={{ position: 'absolute', top: 6, right: 20 }}>
                    <MdiIcon name="mdi-pound" size={12} /> {meta.id}
                </Typography>
            )}
            <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                {showMeta && (
                    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1, flexWrap: 'nowrap', overflow: 'hidden' }}>
                        <Chip size="small" label={t('fileMessage')} color="secondary" sx={{ height: 20, fontSize: 10, '& .MuiChip-label': { px: 1 } }} />
                        {display.timestamp && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                <MdiIcon name="mdi-clock-outline" size={12} /> {formatTimestamp(meta.timestamp)}
                            </Typography>
                        )}
                        {display.device && meta.senderDevice?.type && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                {deviceLabel(meta.senderDevice)}
                            </Typography>
                        )}
                        {display.ip && meta.senderIP && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                <MdiIcon name="mdi-ip-network-outline" size={12} /> {meta.senderIP}
                            </Typography>
                        )}
                    </Stack>
                )}

                <Stack direction="row" alignItems="center" spacing={1.5}>
                    {meta.thumbnail && !isVideo && !isAudio ? (
                        <img src={String(meta.thumbnail)} alt="" style={{ width: 40, height: 40, borderRadius: 3, objectFit: 'cover' }} />
                    ) : (
                        <MdiIcon name={isAudio ? 'mdi-music-note' : isVideo ? 'mdi-movie' : isImageName(meta.name) ? 'mdi-image-outline' : 'mdi-file-outline'} size={40} />
                    )}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle1" noWrap sx={{ textDecoration: expired ? 'line-through' : 'none' }} title={meta.name}>
                            {meta.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                            {prettyFileSize(Number(meta.size || 0))}
                            {' | '}
                            {meta.expire && meta.expire > 0
                                ? (expired ? t('expiredAt', { time: formatTimestamp(meta.expire) }) : t('willExpireAt', { time: formatTimestamp(meta.expire) }))
                                : t('neverExpires')}
                        </Typography>
                    </Box>
                    <Stack direction="row" alignItems="center" spacing={0.25}>
                        {display.cardDownload && (
                            <Tooltip title={expired ? t('expired') : t('download')}>
                                <span>
                                    <IconButton size="small" disabled={expired || downloading} onClick={downloadFile} aria-label={t('download')}>
                                        <MdiIcon name={expired ? 'mdi-download-off' : 'mdi-download'} size={18} />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        )}
                        {display.cardPreview && canPreview && (
                            <Tooltip title={t('preview')}>
                                <IconButton size="small" onClick={() => { if (!expired) void previewFile(); }} aria-label={t('preview')}>
                                    <MdiIcon name={previewIcon} size={18} />
                                </IconButton>
                            </Tooltip>
                        )}
                        <ShareLinkButton meta={meta} />
                        {display.cardDelete && (
                            <Tooltip title={t('delete')}>
                                <IconButton size="small" onClick={deleteItem} aria-label={t('delete')}>
                                    <MdiIcon name="mdi-close" size={18} />
                                </IconButton>
                            </Tooltip>
                        )}
                    </Stack>
                </Stack>

                {expand && (
                    <>
                        <Divider sx={{ my: 1 }} />
                        {loading && (
                            <Typography variant="caption" color="text.secondary">
                                {meta.size ? `${Math.round((loaded / Number(meta.size)) * 100)}%` : '…'}
                            </Typography>
                        )}
                        {isVideo && <video src={srcPreview} controls preload="metadata" style={{ maxHeight: 480, maxWidth: '100%', display: 'block', margin: '0 auto' }} />}
                        {isAudio && <audio src={srcPreview} controls preload="metadata" style={{ width: '100%' }} />}
                        {isText && (
                            <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}>
                                {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                                {md.html
                                    ? <MarkdownBody html={md.html} />
                                    : <pre className="code-block" style={{ maxHeight: '30rem' }}>{displayedText}</pre>}
                            </div>
                        )}
                        {!isVideo && !isAudio && !isText && srcPreview && (
                            <img src={srcPreview} alt={meta.name} style={{ maxHeight: 480, maxWidth: '100%', display: 'block', margin: '0 auto' }} />
                        )}
                        {isText && hasTruncated && (
                            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}>
                                <Typography variant="caption" color="text.secondary">
                                    {t('textPreviewTruncated', { limit: prettyFileSize(TEXT_PREVIEW_LIMIT) })}
                                </Typography>
                                <Button size="small" onClick={() => setShowFullText((v) => !v)}>
                                    {showFullText ? t('collapseTextPreview') : t('expandTextPreview')}
                                </Button>
                            </Stack>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
