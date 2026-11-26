import { Fragment, memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Card, CardContent, Chip, Divider, IconButton, Tooltip, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useInView } from '@/hooks/useInView';
import { useMarkdown } from '@/hooks/useMarkdown';
import { useTaskListToggle } from '@/hooks/useTaskListToggle';
import {
    copyTextToClipboard, deviceLabel, errorMessage, formatTimestamp, isAutomationMessage, isLateMessage,
} from '@/lib/util';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MarkdownToggle } from '@/components/MarkdownToggle';
import { SegmentWords } from '@/components/ui/SegmentWords';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 文本条目卡片 —— 从 web-vue3/src/components/received-item/Text.vue 移植。
 *
 * ⚠️ 正文（含任务列表打勾 + 落盘）走共享 hook `useTaskListToggle`；复制也用它返回的 `text`
 * （用户看到什么就复制什么）。
 * ⚠️ 卡片默认**收起**（标准模式的主要动作是「扫一眼最近来了什么」，一张卡突然高两三倍会打断节奏）。
 * ⚠️★ 样式走 `.text-card*`（styles/components.css），**不用 `sx`** —— 理由见那段 CSS 注释。
 * ⚠️★ `useInView` 只为**省掉屏外条目的 markdown 计算**（见 `useMarkdown` 的 `enabled`）。
 */
/**
 * ⚠️★ 包 `memo`：标准模式的时间线是**分批挂载**的（见 DefaultMode 的 `renderLimit`），
 * 每加一批都会重跑一次 `map`。没有 `memo` 的话已经画好的卡片会跟着重渲染 ——
 * 总工作量从 50 次变成 12+24+36+48+50=170 次，分批反而更慢。
 * `meta` 是 store 数组里的稳定引用，所以这个比较是有意义的。
 */
export const ReceivedText = memo(function ReceivedText({ meta }: { meta: ReceivedItem }) {
    const { t } = useTranslation();
    const display = useDisplaySettings();
    const [expand, setExpand] = useState(false);

    const { text: decodedContent, onMdClick } = useTaskListToggle(meta, () => useWebSocketStore.getState().room);
    // ⚠️★ 屏外就先不算 markdown：那是异步动作链 + 二次重渲染，50 条一起跑就是切换时最贵的一块。
    const { ref: cardRef, inView } = useInView<HTMLDivElement>();
    const md = useMarkdown(() => decodedContent, undefined, inView);

    // ⚠️ 卡片的三个动作是**固定顺序**（复制 → 分享 → 删除），不按频次排（用户 2026-11-26：
    //    这三个位置是肌肉记忆，换位只会让人点错）。
    //    频次只用于**动作库**（`⋯` 里的动作、预览条那两颗）。
    const actionOrder = 'copy,share,delete';

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

    /** 真正提交删除（5 秒撤销窗口之后，或者压根没法撤销时）。 */
    const commitDelete = async () => {
        try {
            await axios.post(`revoke/${meta.id}`, null, { params: new URLSearchParams([['room', useWebSocketStore.getState().room]]) });
            toast(t('deleteSuccessText'));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedMessageMsg', { msg }) : t('deleteFailedMessage'));
        }
    };

    /**
     * 删除 = **先本地摘掉 + 5 秒撤销窗口**，超时才真发 revoke。
     *
     * ⚠️★ 为什么不是「弹个确认框」：删除是 `revoke + （文件时）DELETE file/{cache}` 双写，
     *    确认框只是多一次点击，误删照样发生、而且不可逆。**唯一能撤销的做法是把提交推迟** ——
     *    5 秒内点撤销，一个字节都不用发给服务端。
     * ⚠️ 5 秒内刷新/关页面 = 删除没生效（内容还在）。这比「删了找不回来」好。
     */
    const deleteItem = () => {
        const { removeReceivedLocal, restoreReceivedLocal } = useAppStore.getState();
        const removed = removeReceivedLocal(meta.id);
        if (!removed) {
            // 列表里已经没有它（别的端删过 / 并发竞态）：别再假装能撤销，直接提交
            void commitDelete();
            return;
        }
        let undone = false;
        const timer = window.setTimeout(() => {
            if (undone) {
                return;
            }
            useToastStore.getState().hide(toastId);
            void commitDelete();
        }, 5000);
        const toastId = useToastStore.getState().show(t('deletedUndo'), {
            forever: true,
            action: {
                label: t('undo'),
                onClick: () => {
                    undone = true;
                    window.clearTimeout(timer);
                    restoreReceivedLocal(removed.item, removed.index);
                },
            },
        });
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
        <Card ref={cardRef} variant="outlined" className="text-card">
            <Box className="text-card__bar" />
            {meta.id && (
                <Typography variant="caption" color="text.secondary" className="text-card__id">
                    <MdiIcon name="mdi-pound" size={12} /> {meta.id}
                </Typography>
            )}
            <CardContent className="text-card__content">
                {showMeta && (
                    <div className="text-card__meta">
                        <Chip size="small" label={t('textMessage')} className="text-card__chip" />
                        {/* 定时消息的来源标记：**刻意不受** display 开关管 —— 那是「这条不是人发的」这个事实本身。 */}
                        {isAutomation && (
                            <Typography variant="caption" className="text-card__meta-item">
                                <MdiIcon name="mdi-calendar-clock" size={12} /> {t('automationSource')}
                            </Typography>
                        )}
                        {display.timestamp && (
                            <Typography variant="caption" className="text-card__meta-item">
                                <MdiIcon name="mdi-clock-outline" size={12} /> {formatTimestamp(meta.timestamp)}
                            </Typography>
                        )}
                        {isLate && (
                            <Tooltip title={t('automationLateHint')}>
                                <Typography variant="caption" color="warning.main" className="text-card__meta-item">
                                    <MdiIcon name="mdi-clock-alert-outline" size={12} /> {t('automationLate')}
                                </Typography>
                            </Tooltip>
                        )}
                        {display.device && meta.senderDevice?.type && (
                            <Typography variant="caption" className="text-card__meta-item">
                                <MdiIcon name={deviceIcon(meta.senderDevice.type)} size={12} /> {deviceLabel(meta.senderDevice)}
                            </Typography>
                        )}
                        {display.ip && meta.senderIP && (
                            <Typography variant="caption" className="text-card__meta-item">
                                <MdiIcon name="mdi-ip-network-outline" size={12} /> {meta.senderIP}
                            </Typography>
                        )}
                    </div>
                )}

                <div className="text-card__row">
                    <div className="text-card__summary" onClick={() => setExpand((v) => !v)}>
                        <MdiIcon
                            name="mdi-chevron-right"
                            size={18}
                            className={expand ? 'text-card__chevron text-card__chevron--open' : 'text-card__chevron'}
                        />
                        <Typography variant="body2" color="text.secondary" noWrap className="text-card__summary-text">
                            {decodedContent}
                        </Typography>
                    </div>
                    {/* 固定顺序：复制 → 分享 → 删除。删除恒在最右（不可逆的动作不该挨着复制）。 */}
                    <div className="text-card__actions" onClick={(e) => e.stopPropagation()}>
                        {actionOrder.split(',').map((id) => {
                            if (id === 'copy') {
                                return display.cardCopy ? (
                                    <Tooltip key="copy" title={t('copyText')}>
                                        <IconButton size="small" onClick={copyText} aria-label={t('copyText')}>
                                            <MdiIcon name="mdi-content-copy" size={18} />
                                        </IconButton>
                                    </Tooltip>
                                ) : null;
                            }
                            if (id === 'share') {
                                // 分享的点击在 `ShareLinkButton` 内部，这里靠冒泡记一次使用
                                return (
                                    <Fragment key="share">
                                        <span style={{ display: 'inline-flex' }}>
                                            <ShareLinkButton meta={meta} />
                                        </span>
                                    </Fragment>
                                );
                            }
                            if (id === 'delete') {
                                return display.cardDelete ? (
                                    <Tooltip key="delete" title={t('delete')}>
                                        <IconButton size="small" onClick={deleteItem} aria-label={t('delete')}>
                                            <MdiIcon name="mdi-close" size={18} />
                                        </IconButton>
                                    </Tooltip>
                                ) : null;
                            }
                            return null;
                        })}
                    </div>
                </div>

                {expand && (
                    <>
                        <Divider className="text-card__divider" />
                        <Box
                            className={`md-preview${md.available ? ' md-preview--md' : ''}${md.leadsWithBlock ? ' md-preview--block' : ''}`}
                            style={{ '--md-toggle-gutter': md.gutter } as React.CSSProperties}
                            onClick={onMdClick}
                        >
                            {md.available && (
                                <MarkdownToggle mode={md.mode} actions={md.actions} text={md.copyText} onModeChange={md.setMode} />
                            )}
                            {/* ⚠️ 「切出词」的结果要能按词点选 —— 卡片上也一样，
                                不能只在动作台里能用（用户 2026-11-26 报的）。 */}
                            {md.mode === 'zh.segment'
                                ? <SegmentWords text={md.copyText} />
                                : md.html
                                    ? <MarkdownBody html={md.html} />
                                    : <div className="text-card__preview">{decodedContent}</div>}
                        </Box>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
);
