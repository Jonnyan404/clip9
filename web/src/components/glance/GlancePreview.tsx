import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, CircularProgress, Stack, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useMarkdown } from '@/hooks/useMarkdown';
import {
    SHARE_DEFAULT_TTL, copyTextToClipboard, deviceLabel, errorMessage, filePreviewKind, formatTimestamp, isFileEntry, prettyFileSize,
} from '@/lib/util';
import { createShareLink } from '@/services/share';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 速览模式的右侧预览 —— 从 web-vue3/src/components/glance/GlancePreview.vue 移植。
 *
 * ⚠️ 与卡片的区别：卡片是**列表里的一行**（正文截断、可收起）；预览是**一条的完整呈现**
 * （正文不截断，动作行与元信息都在这里）。
 * ⚠️ 同一个预览出现在两处（宽屏右侧面板 / 窄屏全屏弹窗），所以必须抽成组件 ——
 * 否则会出现「面板里能做的事、弹窗里做不了」。
 */
export function GlancePreview({ item }: { item: ReceivedItem | null }) {
    const { t } = useTranslation();
    const room = useWebSocketStore((s) => s.room);
    const [previewSrc, setPreviewSrc] = useState('');
    const [textPreview, setTextPreview] = useState('');
    const [loading, setLoading] = useState(false);
    const [downloading, setDownloading] = useState(false);

    const isFile = isFileEntry(item);
    const content = String(item?.content || '');
    // 文件条目的**可预览类型**。判型收在 `lib/util.ts` 的 `filePreviewKind`（**全站唯一实现**）。
    // ⚠️ 只看扩展名、不看内容 —— 服务端不嗅探、客户端也不嗅探，两边同一套标准。
    const kind = isFile ? filePreviewKind(item?.name) : '';
    // ⚠️★ 过期文件**不去取预览**。取了必然失败（服务端回 `file_expired`），结果是
    // 「页面上什么都没有 + 白弹一个『文件已过期』的气泡」—— 用户明确不要这个气泡：
    // 过期状态应当**直接画在页面上**（见下面的兜底块）。
    //
    // ⚠️ 这一条**偏离**了 Vue（Vue 的 `canPreview` 不含过期判断，所以 Vue 会弹气泡）——
    // 是用户看了实际效果之后**明确要求**改的，不是自作主张。
    const expired = Boolean(item?.expire && Number(item.expire) > 0 && Date.now() / 1000 > Number(item.expire));
    const canPreview = Boolean(isFile && kind && !expired);
    const md = useMarkdown(() => content);

    const ensureRawUrl = async (): Promise<string> => {
        const data = await createShareLink({ type: 'file', uuid: item?.cache, ttl: SHARE_DEFAULT_TTL, maxUses: 0, room });
        return data?.rawUrl || '';
    };

    useEffect(() => {
        setPreviewSrc('');
        setTextPreview('');
        // ⚠️ 不是文件 / 类型不支持预览 / 已过期：什么都不取（也就不会弹气泡），
        // 直接落到下面的兜底块。
        if (!item || !canPreview) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        void (async () => {
            try {
                if (kind === 'text') {
                    // ⚠️ 文本文件**必须**另发一次请求取正文：文件条目本身没有 content。
                    const response = await axios.get(`file/${item.cache}/${encodeURIComponent(item.name || '')}`, { responseType: 'text' });
                    if (!cancelled) setTextPreview(typeof response.data === 'string' ? response.data : String(response.data || ''));
                } else {
                    const url = await ensureRawUrl();
                    if (!cancelled) setPreviewSrc(url);
                }
            } catch (error) {
                if (!cancelled) toast(errorMessage(error) || t('fileFetchFailed'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [item?.id]);

    const downloadFile = async () => {
        if (downloading || !item?.cache) return;
        setDownloading(true);
        try {
            const url = await ensureRawUrl();
            if (!url) return;
            const target = new URL(url, window.location.origin);
            target.searchParams.set('download', 'true');
            const anchor = document.createElement('a');
            anchor.href = target.toString();
            anchor.download = item?.name || 'file';
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
        } catch (error) {
            toast(errorMessage(error) || t('fileFetchFailed'));
        } finally {
            setDownloading(false);
        }
    };

    const copyContent = async () => {
        try {
            // ⚠️ 复制**当前视图**的正文（`md.copyText`）。
            await copyTextToClipboard(md.copyText);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    const deleteItem = async () => {
        if (!item) return;
        try {
            await axios.delete(`revoke/${item.id}`, { params: new URLSearchParams([['room', room]]) });
            toast(t('deleteSuccessText', { name: item.name || '' }));
        } catch (error) {
            toast(errorMessage(error) || t('deleteFailedMessage'));
        }
    };

    if (!item) {
        return (
            <Stack alignItems="center" justifyContent="center" sx={{ py: 6 }}>
                <Typography variant="body2" color="text.secondary">{t('glanceNothingSelected')}</Typography>
            </Stack>
        );
    }

    const charCount = isFile ? 0 : [...content].length;
    const byteCount = isFile ? Number(item.size || 0) : new TextEncoder().encode(content).length;

    return (
        <Stack spacing={1.5} sx={{ minHeight: 0 }}>
            {isFile ? (
                <>
                    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 60 }}>
                        {loading && <CircularProgress size={26} />}
                        {!loading && kind === 'image' && previewSrc && <img src={previewSrc} alt={item.name} style={{ maxWidth: '100%', maxHeight: '46vh', borderRadius: 8 }} />}
                        {!loading && kind === 'video' && previewSrc && <video src={previewSrc} controls style={{ maxWidth: '100%', maxHeight: '46vh', borderRadius: 8 }} />}
                        {!loading && kind === 'audio' && previewSrc && <audio src={previewSrc} controls style={{ width: '100%' }} />}
                        {!loading && kind === 'text' && textPreview && <pre className="code-block" style={{ width: '100%', maxHeight: '46vh' }}>{textPreview}</pre>}
                        {/* ⚠️★ 兜底块 = Vue 那条 `v-if/v-else-if` 链最后的 `v-else`：
                            **只要上面四路预览一路都没命中，就显示它**。
                            以前这里写的是 `!kind`，于是「类型认得出、但字节取不到」的情况
                            四路全空、图标也不显示 → 整块**空白**。
                            因为 `filePreviewKind` 只返回 image/video/audio/text/'' 这几种，
                            而 previewSrc / textPreview 又只在取数成功时才被赋值，
                            所以 `!previewSrc && !textPreview` 与 Vue 的 `v-else` **逐字等价**。
                            ⚠️ 过期的情况在这里**显式说明**（图标 + 「已过期」），
                            而不是像以前那样弹一个气泡了事 —— 状态要看得见，不靠一闪而过的提示。 */}
                        {!loading && !previewSrc && !textPreview && (
                            <Stack alignItems="center" spacing={0.5} sx={{ color: expired ? 'error.main' : 'text.secondary' }}>
                                <MdiIcon name={expired ? 'mdi-timer-off' : 'mdi-file-outline'} size={40} />
                                {expired && <Typography variant="caption" color="error.main">{t('expired')}</Typography>}
                            </Stack>
                        )}
                    </Stack>
                    <Stack>
                        <Typography variant="body2" fontWeight={500} sx={{ wordBreak: 'break-all' }}>{item.name || 'file'}</Typography>
                        <Typography variant="caption" color="text.secondary">{prettyFileSize(Number(item.size || 0))}</Typography>
                    </Stack>
                </>
            ) : (
                <div className={`md-preview${md.available ? ' md-preview--md' : ''}`} style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}>
                    {md.available && <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />}
                    {md.html ? <MarkdownBody html={md.html} /> : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>}
                </div>
            )}

            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ borderTop: 1, borderColor: 'divider', pt: 1, flexWrap: 'wrap' }}>
                {isFile ? (
                    // ⚠️★ 过期就**置灰**（与标准模式 `received-item/File.tsx` 同一套）：
                    // 禁用 + 换成划掉的下载图标 + 文案改成「已过期」。
                    // 不置灰的话点下去只会拿到一个「文件已过期」的气泡 ——
                    // 那颗按钮**看起来能点**才是真正的问题。
                    <Button
                        size="small"
                        variant="contained"
                        loading={downloading}
                        disabled={expired}
                        onClick={downloadFile}
                        startIcon={<MdiIcon name={expired ? 'mdi-download-off' : 'mdi-download'} size={16} />}
                    >
                        {expired ? t('expired') : t('download')}
                    </Button>
                ) : (
                    <Button size="small" variant="text" onClick={copyContent} startIcon={<MdiIcon name="mdi-content-copy" size={16} />}>
                        {t('copyText')}
                    </Button>
                )}
                <ShareLinkButton meta={item} iconOnly={false} />
                <span style={{ flex: 1 }} />
                <Button size="small" variant="text" color="error" onClick={deleteItem} startIcon={<MdiIcon name="mdi-close-circle-outline" size={16} />}>
                    {t('delete')}
                </Button>
            </Stack>

            <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
                {!isFile && <Typography variant="caption" color="text.secondary">{t('glanceChars', { count: charCount })}</Typography>}
                <Typography variant="caption" color="text.secondary">{prettyFileSize(byteCount)}</Typography>
                {item.timestamp && <Typography variant="caption" color="text.secondary">{formatTimestamp(item.timestamp)}</Typography>}
                {deviceLabel(item.senderDevice) && (
                    <Typography variant="caption" color="text.secondary">
                        {t('glanceFrom', { source: deviceLabel(item.senderDevice) })}
                    </Typography>
                )}
            </Stack>
        </Stack>
    );
}
