import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, CircularProgress, Dialog, IconButton, Tooltip } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useMarkdown } from '@/hooks/useMarkdown';
import { useTaskListToggle } from '@/hooks/useTaskListToggle';
import {
    SHARE_DEFAULT_TTL, copyTextToClipboard, deviceLabel, errorMessage, filePreviewKind, formatTimestamp, isFileEntry, isImageName, prettyFileSize,
} from '@/lib/util';
import { createShareLink } from '@/services/share';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 便签卡片 + 阅读器（「大号便签纸」）—— 从 web-vue3/src/components/sticky/StickyNote.vue 移植。
 *
 * ⚠️ 正文（含任务列表打勾 + 落盘）走共享 hook；复制也用它返回的 `text`。
 * ⚠️ 卡片**本身就渲染 md**（任务列表 / 表格默认就是 md），所以卡片上的复选框也能直接勾。
 * ⚠️ 取文源必须分岔：文本便签在 `meta.content`，**文件的 FileReceive 没有 content 字段**，
 * 正文只能等 `loadPreview` 抓回来的文本。
 * ⚠️★ 配色 / 旋转 / 胶带条 / 悬停动作行 / 阅读器**全部走 CSS 的 `.sticky-note*`**
 *    （styles/components.css），与 Vue 同名同值 —— 别在这里用 MUI 的 `sx` 再描一遍：
 *    两处一定会漂（这次就是这么漂的）。
 * ⚠️ 「文件 / 文本」的判据是 `isFileEntry`，**不是** `type === 'file'` —— 理由见 util.ts。
 * ⚠️★ 判型统一用 `filePreviewKind`（全站唯一实现），**不要**再散着写扩展名正则 ——
 *    Vue 那边在阅读器里又写了一组（还漏了 `.mov`），正是「同一判型多份实现必然漂」的样本。
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

    const kind = isFile ? filePreviewKind(meta.name) : '';
    // ⚠️★ 过期就不去取字节（与 Vue 的 `canPreview` 一致）：取了必然失败、白弹一个
    // 「文件已过期」的气泡，而阅读器里本来就有一行「已过期」说明。
    const canPreview = Boolean(isFile && kind && !expired);

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
        if (!canPreview || loadingPreview) return;
        setLoadingPreview(true);
        try {
            if (kind === 'text') {
                const response = await axios.get(`file/${meta.cache}/${encodeURIComponent(String(meta.name || ''))}`, { responseType: 'text' });
                setTextPreview(typeof response.data === 'string' ? response.data : String(response.data || ''));
            } else {
                setPreviewSrc(await ensureRawUrl());
            }
        } catch (error) {
            toast(errorMessage(error) || t('fileFetchFailed'));
        } finally {
            setLoadingPreview(false);
        }
    };

    const openReader = () => {
        setExpanded(true);
        if (canPreview && !textPreview && !previewSrc) void loadPreview();
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
                {/* ⚠️★ 过期角标（右上角）。过期是**状态**，要一直看得见 ——
                    不能只靠文件名划掉，也不能靠一闪而过的气泡。
                    悬停时动作行会下移让位（见 CSS 的 `.sticky-note--expired .sticky-note__ops`）。 */}
                {isFile && expired && <span className="sticky-note__expired-badge">{t('expired')}</span>}
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
                                <MdiIcon name={isFile ? (expired ? 'mdi-download-off' : 'mdi-download') : 'mdi-content-copy'} size={18} />
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

            {/* 阅读器 = 「大号便签纸」。⚠️ 外壳仍用 MUI Dialog（背板 / Esc / 焦点陷阱都是它给的），
                但把 Paper 的底色与阴影清掉，让下面这张 `--cN` 色的纸自己说话 ——
                之前是直接拿 MUI 的白色对话框当正文，跟卡片完全不像一家人。 */}
            <Dialog
                open={expanded}
                onClose={() => setExpanded(false)}
                maxWidth={false}
                slotProps={{ paper: { sx: { backgroundColor: 'transparent', backgroundImage: 'none', boxShadow: 'none', maxWidth: 520, width: '100%', m: 2 } } }}
            >
                <div className={`sticky-note__reader sticky-note__reader--c${colorIndex}`}>
                    <div className="sticky-note__reader-head">
                        <div className="sticky-note__label">{noteLabel}</div>
                        {readerTimeLabel && <span className="sticky-note__reader-time">{readerTimeLabel}</span>}
                        <IconButton size="small" className="sticky-note__op" onClick={() => setExpanded(false)} aria-label={t('close')}>
                            <MdiIcon name="mdi-close" size={16} />
                        </IconButton>
                    </div>

                    {isFile ? (
                        <>
                            {/* ⚠️ 文件的名字 / 大小 / 过期**永远**显示。这几行曾经跟着预览一起被藏掉，
                                .md 文件就变成「没有名字、没有大小、没有过期」的一张空对话框。 */}
                            <div className="sticky-note__reader-file">
                                <span className="sticky-note__fic">{fileIcon}</span>
                                <span className="sticky-note__reader-name">{meta.name}</span>
                                <span className="sticky-note__meta">{fileMetaLabel}</span>
                            </div>
                            {isExpirable && (
                                <div className={`sticky-note__reader-expire${expired ? ' sticky-note__reader-expire--past' : ''}`}>
                                    <MdiIcon name="mdi-clock-outline" size={12} />
                                    {expireLabel}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="md-preview" onClick={onMdClick}>
                            {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                            <div
                                className={`sticky-note__reader-text${isLink ? ' sticky-note__text--link' : ''}${md.available ? ' sticky-note__reader-text--md' : ''}${md.leadsWithBlock ? ' sticky-note__reader-text--block' : ''}${md.html ? ' sticky-note__reader-text--rendered' : ''}`}
                            >
                                {md.html ? <MarkdownBody html={md.html} /> : decodedContent}
                            </div>
                        </div>
                    )}

                    {/* 预览块：过期就整块不渲染（Vue 的 `canPreview` 也含 `!expired`）——
                        否则会留一个「什么都没有」的灰盒子，看着像坏了。 */}
                    {canPreview && (
                        <div className="sticky-note__reader-preview">
                            {loadingPreview ? (
                                <div className="sticky-note__preview-loading">
                                    <CircularProgress size={36} />
                                </div>
                            ) : kind === 'video' ? (
                                <video src={previewSrc} controls preload="metadata" style={{ maxHeight: '60vh', maxWidth: '100%' }} />
                            ) : kind === 'audio' ? (
                                <audio src={previewSrc} controls preload="metadata" style={{ width: '100%' }} />
                            ) : kind === 'text' ? (
                                <div className="md-preview" style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}>
                                    {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                                    {md.html ? (
                                        <div className={`sticky-note__preview-scroll${md.available ? ' sticky-note__preview-scroll--md' : ''}${md.leadsWithBlock ? ' sticky-note__preview-scroll--block' : ''}`}>
                                            <MarkdownBody html={md.html} />
                                        </div>
                                    ) : (
                                        <pre className={`sticky-note__preview-text${md.available ? ' sticky-note__preview-text--md' : ''}`}>{textPreview}</pre>
                                    )}
                                </div>
                            ) : (
                                <img src={previewSrc || String(meta.thumbnail || '')} alt={meta.name} style={{ maxHeight: '60vh', maxWidth: '100%' }} />
                            )}
                        </div>
                    )}

                    <div className="sticky-note__reader-actions">
                        {isFile ? (
                            <Button
                                size="small"
                                variant="contained"
                                loading={downloading}
                                disabled={expired}
                                startIcon={<MdiIcon name={expired ? 'mdi-download-off' : 'mdi-download'} size={16} />}
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
                        <Button
                            size="small"
                            variant="text"
                            color="error"
                            className="sticky-note__reader-delete"
                            startIcon={<MdiIcon name="mdi-delete-outline" size={16} />}
                            onClick={deleteItem}
                        >
                            {t('delete')}
                        </Button>
                    </div>
                </div>
            </Dialog>
        </>
    );
}
