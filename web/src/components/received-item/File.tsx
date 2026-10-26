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
    deviceLabel, errorMessage, filePreviewKind,
    formatTimestamp, isImageName, prettyFileSize,
} from '@/lib/util';
import { downloadFile as saveFileToDisk, fileUrl } from '@/services/file-url';
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
export const ReceivedFile = memo(function ReceivedFile({ meta, onOpen }: { meta: ReceivedItem; onOpen: (item: ReceivedItem) => void }) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const room = useWebSocketStore((s) => s.room);

    const [expand, setExpand] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(0);
    const [srcPreview, setSrcPreview] = useState('');
    const [textPreview, setTextPreview] = useState('');
    const [showFullText, setShowFullText] = useState(false);

    const kind = useMemo(() => filePreviewKind(meta.name), [meta.name]);
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

    // ⚠️ 同步的：地址本地拼（`services/file-url`），不再为「看一眼」去签一条分享令牌。
    const downloadFile = () => {
        if (expired || !meta.cache) return;
        saveFileToDisk(meta.cache, meta.name, room);
    };

    const loadText = async () => {
        setLoading(true);
        setLoaded(0);
        try {
            setShowFullText(false);
            const response = await axios.get(`file/${meta.cache}/${encodeURIComponent(meta.name || '')}`, {
                responseType: 'text',
                onDownloadProgress: (e) => setLoaded(e.loaded),
            });
            setTextPreview(typeof response.data === 'string' ? response.data : String(response.data || ''));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('fileFetchFailedMsg', { msg }) : t('fileFetchFailed'));
        } finally {
            setLoading(false);
        }
    };

    /**
     * 预览：**就地展开**（各模式原本的方式），不直接跳全屏。
     *
     * ⚠️★ 2026-10-26 用户的意见：全屏查看器很好，但「点一下就全屏」把各模式原来的预览方式
     * 顶掉了 —— 他最喜欢的是时间线那种**两步**：先展开看这一条，再点图片/视频进全屏翻。
     * 所以这里恢复就地展开，**第二下**（点展开块里的媒体）才进查看器。
     *
     * ⚠️ 媒体的字节仍然走 `fileUrl()`（本地拼、不发请求、不签分享令牌）——
     * 「两步」是交互问题，与「预览别用分享链接」是两件事，别一起退回去。
     */
    const previewFile = () => {
        if (expired) return;
        if (expand) {
            setExpand(false);
            return;
        }
        setExpand(true);
        if (isText) {
            if (!textPreview && !loading) {
                void loadText();
            }
            return;
        }
        // 图片 / 视频 / 音频：地址同步就有，不需要 loading 那一拍。
        if (!srcPreview) {
            setSrcPreview(fileUrl(meta.cache, { room }));
        }
    };

    const deleteItem = async () => {
        try {
            await axios.post(`revoke/${meta.id}`, null, { params: new URLSearchParams([['room', room]]) });
            if (!expired && meta.cache) {
                await axios.delete(`file/${meta.cache}`);
            }
            toast(t('deleteSuccessFile', { name: meta.name }));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedFileMsg', { msg }) : t('deleteFailedFile'));
        }
    };

    const previewIcon = kind === 'video' || kind === 'audio'
        ? 'mdi-movie-search-outline'
        : isText ? 'mdi-text-box-search-outline' : 'mdi-image-search-outline';
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
                    {/* ⚠️ 缩略图**不可点**：进全屏的唯一路径是「预览图标 → 展开 → 点媒体」，
                        与各模式原本的预览方式一致（2026-10-26 用户明确要求两步）。 */}
                    {meta.thumbnail && kind !== 'video' && kind !== 'audio' ? (
                        <img src={String(meta.thumbnail)} alt="" className="file-card__thumb" />
                    ) : (
                        <MdiIcon name={kind === 'audio' ? 'mdi-music-note' : kind === 'video' ? 'mdi-movie' : isImageName(meta.name) ? 'mdi-image-outline' : 'mdi-file-outline'} size={40} />
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
                                    <IconButton size="small" disabled={expired} onClick={downloadFile} aria-label={t('download')}>
                                        <MdiIcon name={expired ? 'mdi-download-off' : 'mdi-download'} size={18} />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        )}
                        {display.cardPreview && canPreview && (
                            // ⚠️ 过期就**置灰**（与下载按钮同一套）：`previewFile` 里那句
                            // `if (expired) return` 会让它点了没反应 —— 而**看起来能点**才是问题。
                            <Tooltip title={expired ? t('expired') : t('preview')}>
                                <span>
                                    <IconButton size="small" disabled={expired} onClick={previewFile} aria-label={t('preview')}>
                                        <MdiIcon name={previewIcon} size={18} />
                                    </IconButton>
                                </span>
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

                {/* 展开块：正文 / 图片 / 视频 / 音频都在**原地**显示（各模式原本的方式）。
                    ⚠️★ 媒体上再点一下才进全屏查看器（「二次点击」）：
                      · 图片 —— 直接点图（没有别的含义）；
                      · 视频 / 音频 —— `controls` 把单击吃掉了（那是播放/暂停），
                        所以给一颗**全屏按钮**，别去抢它自己的点击。
                    ⚠️ 认不出类型的（zip / pdf）：卡片上那个缩略图就是全部能预览的东西，
                    塞文件字节进 `<img>` 只会得到一个碎图标 —— 那种情况不给全屏入口。 */}
                {expand && (
                    <>
                        <Divider className="text-card__divider" />
                        {loading && (
                            <Typography variant="caption" color="text.secondary">
                                {meta.size ? `${Math.round((loaded / Number(meta.size)) * 100)}%` : '…'}
                            </Typography>
                        )}
                        {kind === 'video' && srcPreview && (
                            <div style={{ position: 'relative' }}>
                                <video
                                    src={srcPreview}
                                    controls
                                    preload="metadata"
                                    style={{ maxHeight: 480, maxWidth: '100%', display: 'block', margin: '0 auto' }}
                                />
                                <IconButton
                                    size="small"
                                    onClick={() => onOpen(meta)}
                                    aria-label={t('preview')}
                                    sx={{ position: 'absolute', top: 6, right: 6, bgcolor: 'rgba(0,0,0,0.45)', color: '#fff', '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' } }}
                                >
                                    {/* ⚠️ `mdi-arrow-expand-all` 而不是 `mdi-fullscreen`：后者和播放器
                                        自带的那颗（右下角、浏览器原生全屏）长得几乎一样，两颗并排会分不清。
                                        这一颗是「进查看器、能上下翻」，不是「铺满这一屏」。 */}
                                    <MdiIcon name="mdi-arrow-expand-all" size={18} />
                                </IconButton>
                            </div>
                        )}
                        {kind === 'audio' && srcPreview && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <audio src={srcPreview} controls preload="metadata" style={{ width: '100%' }} />
                                <IconButton size="small" onClick={() => onOpen(meta)} aria-label={t('preview')} sx={{ flexShrink: 0 }}>
                                    <MdiIcon name="mdi-arrow-expand-all" size={18} />
                                </IconButton>
                            </div>
                        )}
                        {isText && (
                            <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}>
                                {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                                {md.html
                                    ? <MarkdownBody html={md.html} />
                                    : <pre className="code-block" style={{ maxHeight: '30rem' }}>{displayedText}</pre>}
                            </div>
                        )}
                        {/* 图片（含「认不出类型但有缩略图」的）：点一下进全屏。 */}
                        {!isText && kind !== 'video' && kind !== 'audio' && (srcPreview || meta.thumbnail) && (
                            <img
                                src={srcPreview || String(meta.thumbnail || '')}
                                alt={meta.name}
                                onClick={kind ? () => onOpen(meta) : undefined}
                                style={{
                                    maxHeight: 480,
                                    maxWidth: '100%',
                                    display: 'block',
                                    margin: '0 auto',
                                    cursor: kind ? 'zoom-in' : 'default',
                                }}
                            />
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
