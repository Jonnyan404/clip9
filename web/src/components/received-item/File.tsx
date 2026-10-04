import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, CardContent, Chip, Divider, IconButton, Tooltip, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useInView } from '@/hooks/useInView';
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
/**
 * ⚠️★ 包 `memo`：标准模式的时间线是**分批挂载**的（见 DefaultMode 的 `renderLimit`），
 * 每加一批都会重跑一次 `map`。没有 `memo` 的话已经画好的卡片会跟着重渲染 ——
 * 总工作量从 50 次变成 12+24+36+48+50=170 次，分批反而更慢。
 * `meta` 是 store 数组里的稳定引用，所以这个比较是有意义的。
 */
export const ReceivedFile = memo(function ReceivedFile({ meta }: { meta: ReceivedItem }) {
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

    // ⚠️★ 屏外就先不算 markdown（见 useMarkdown 的 enabled）。
    const { ref: cardRef, inView } = useInView<HTMLDivElement>();
    const md = useMarkdown(
        () => displayedText,
        () => /\.(md|markdown|mdown|mkd)$/i.test(meta.name || ''),
        inView,
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
        <Card ref={cardRef} variant="outlined" className="text-card">
            <Box className="text-card__bar text-card__bar--file" />
            {meta.id && (
                <Typography variant="caption" color="text.secondary" className="text-card__id">
                    <MdiIcon name="mdi-pound" size={12} /> {meta.id}
                </Typography>
            )}
            <CardContent className="text-card__content">
                {showMeta && (
                    <div className="text-card__meta">
                        <Chip size="small" label={t('fileMessage')} color="secondary" className="text-card__chip" />
                        {display.timestamp && (
                            <Typography variant="caption" className="text-card__meta-item">
                                <MdiIcon name="mdi-clock-outline" size={12} /> {formatTimestamp(meta.timestamp)}
                            </Typography>
                        )}
                        {display.device && meta.senderDevice?.type && (
                            <Typography variant="caption" className="text-card__meta-item">
                                {deviceLabel(meta.senderDevice)}
                            </Typography>
                        )}
                        {display.ip && meta.senderIP && (
                            <Typography variant="caption" className="text-card__meta-item">
                                <MdiIcon name="mdi-ip-network-outline" size={12} /> {meta.senderIP}
                            </Typography>
                        )}
                    </div>
                )}

                <div className="file-card__row">
                    {meta.thumbnail && !isVideo && !isAudio ? (
                        <img src={String(meta.thumbnail)} alt="" className="file-card__thumb" />
                    ) : (
                        <MdiIcon name={isAudio ? 'mdi-music-note' : isVideo ? 'mdi-movie' : isImageName(meta.name) ? 'mdi-image-outline' : 'mdi-file-outline'} size={40} />
                    )}
                    <div className="file-card__info">
                        <Typography variant="subtitle1" noWrap className={expired ? 'file-card__name--expired' : undefined} title={meta.name}>
                            {meta.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                            {prettyFileSize(Number(meta.size || 0))}
                            {' | '}
                            {meta.expire && meta.expire > 0
                                ? (expired ? t('expiredAt', { time: formatTimestamp(meta.expire) }) : t('willExpireAt', { time: formatTimestamp(meta.expire) }))
                                : t('neverExpires')}
                        </Typography>
                    </div>
                    <div className="text-card__actions">
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
                    </div>
                </div>

                {expand && (
                    <>
                        <Divider className="text-card__divider" />
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
                            <div className="file-card__truncated">
                                <Typography variant="caption" color="text.secondary">
                                    {t('textPreviewTruncated', { limit: prettyFileSize(TEXT_PREVIEW_LIMIT) })}
                                </Typography>
                                <Button size="small" onClick={() => setShowFullText((v) => !v)}>
                                    {showFullText ? t('collapseTextPreview') : t('expandTextPreview')}
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
);
