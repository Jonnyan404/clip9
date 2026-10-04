import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Card, CardContent, Chip, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useMarkdown } from '@/hooks/useMarkdown';
import { useTaskListToggle } from '@/hooks/useTaskListToggle';
import {
    copyTextToClipboard, deviceLabel, errorMessage, formatTimestamp, isAutomationMessage, isLateMessage,
} from '@/lib/util';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 文本条目卡片 —— 从 web-vue3/src/components/received-item/Text.vue 移植。
 *
 * ⚠️ 正文（含任务列表打勾 + 落盘）走共享 hook `useTaskListToggle`；复制也用它返回的 `text`
 * （用户看到什么就复制什么）。
 * ⚠️ 卡片默认**收起**（标准模式的主要动作是「扫一眼最近来了什么」，一张卡突然高两三倍会打断节奏）。
 */
export function ReceivedText({ meta }: { meta: ReceivedItem }) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const [expand, setExpand] = useState(false);

    const { text: decodedContent, onMdClick } = useTaskListToggle(meta, () => useWebSocketStore.getState().room);
    const md = useMarkdown(() => decodedContent);

    // 定时消息的两个标记。**判定在 lib/util**（单点），这里只负责画。
    const isAutomation = isAutomationMessage(meta);
    const isLate = isLateMessage(meta);

    const copyText = async () => {
        try {
            // 复制**当前视图**的正文（`md.copyText`）：切到压缩 JSON 后拿到的就是压缩后的那一行。
            await copyTextToClipboard(md.copyText);
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

    const deviceIcon = (type?: string) => {
        const lower = (type || '').toLowerCase();
        if (lower.includes('mobile') || lower.includes('phone') || lower.includes('tablet') || lower.includes('ios') || lower.includes('android')) {
            return 'mdi-cellphone';
        }
        return 'mdi-desktop-tower';
    };

    const showMeta = Boolean(meta.timestamp && (display.timestamp || display.device || display.ip || isAutomation));

    return (
        <Card variant="outlined" sx={{ borderRadius: 3, mb: 1.5, position: 'relative', overflow: 'hidden' }}>
            <Box sx={{ height: 4, background: 'linear-gradient(90deg, #0ea5e9, #14b8a6)' }} />
            {meta.id && (
                <Typography variant="caption" color="text.secondary" sx={{ position: 'absolute', top: 6, right: 20 }}>
                    <MdiIcon name="mdi-pound" size={12} /> {meta.id}
                </Typography>
            )}
            <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                {showMeta && (
                    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1, flexWrap: 'nowrap', overflow: 'hidden' }}>
                        <Chip size="small" label={t('textMessage')} color="primary" sx={{ height: 20, fontSize: 10, '& .MuiChip-label': { px: 1 } }} />
                        {/* 定时消息的来源标记：**刻意不受** display 开关管 —— 那是「这条不是人发的」这个事实本身。 */}
                        {isAutomation && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                <MdiIcon name="mdi-calendar-clock" size={12} /> {t('automationSource')}
                            </Typography>
                        )}
                        {display.timestamp && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                <MdiIcon name="mdi-clock-outline" size={12} /> {formatTimestamp(meta.timestamp)}
                            </Typography>
                        )}
                        {isLate && (
                            <Tooltip title={t('automationLateHint')}>
                                <Typography variant="caption" color="warning.main" sx={{ whiteSpace: 'nowrap' }}>
                                    <MdiIcon name="mdi-clock-alert-outline" size={12} /> {t('automationLate')}
                                </Typography>
                            </Tooltip>
                        )}
                        {display.device && meta.senderDevice?.type && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                <MdiIcon name={deviceIcon(meta.senderDevice.type)} size={12} /> {deviceLabel(meta.senderDevice)}
                            </Typography>
                        )}
                        {display.ip && meta.senderIP && (
                            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                                <MdiIcon name="mdi-ip-network-outline" size={12} /> {meta.senderIP}
                            </Typography>
                        )}
                    </Stack>
                )}

                <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Stack
                        direction="row"
                        alignItems="center"
                        spacing={0.5}
                        onClick={() => setExpand((v) => !v)}
                        sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                    >
                        <MdiIcon
                            name="mdi-chevron-right"
                            size={18}
                            style={{ transform: expand ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}
                        />
                        <Typography variant="body2" color="text.secondary" noWrap sx={{ flex: 1 }}>
                            {decodedContent}
                        </Typography>
                    </Stack>
                    <Stack direction="row" alignItems="center" spacing={0.25} onClick={(e) => e.stopPropagation()}>
                        {display.cardCopy && (
                            <Tooltip title={t('copyText')}>
                                <IconButton size="small" onClick={copyText} aria-label={t('copyText')}>
                                    <MdiIcon name="mdi-content-copy" size={18} />
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
                        <Box
                            className={`md-preview${md.available ? ' md-preview--md' : ''}${md.leadsWithBlock ? ' md-preview--block' : ''}`}
                            style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}
                            onClick={onMdClick}
                        >
                            {md.available && (
                                <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />
                            )}
                            {md.html
                                ? <MarkdownBody html={md.html} />
                                : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{decodedContent}</div>}
                        </Box>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
