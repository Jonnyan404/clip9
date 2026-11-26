import { Fragment, memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Card, CardContent, Chip, Divider, IconButton, Tooltip, Typography } from '@mui/material';
import axios from 'axios';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import { useInView } from '@/hooks/useInView';
import { useMarkdown } from '@/hooks/useMarkdown';
import { cardActionKey, orderCardActions, useActionPrefStore } from '@/stores/actionPrefStore';
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

    const recordUse = useActionPrefStore((s) => s.recordUse);
    // ⚠️ 只存**字符串**（zustand 用 Object.is 比较）：存数组的话每帧都是新引用，
    //    50 张卡片会全部重渲染，而 `memo` 也救不了 —— 是这个组件自己的订阅变了。
    const actionOrder = useActionPrefStore((s) => orderCardActions(s.usage));

    // 定时消息的两个标记。**判定在 lib/util**（单点），这里只负责画。
    const isAutomation = isAutomationMessage(meta);
    const isLate = isLateMessage(meta);

    const copyText = async () => {
        try {
            // 复制**当前视图**的正文（`md.copyText`）：切到压缩 JSON 后拿到的就是压缩后的那一行。
            await copyTextToClipboard(md.copyText);
            recordUse(cardActionKey('copy'));
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    const deleteItem = async () => {
        try {
            await axios.post(`revoke/${meta.id}`, null, { params: new URLSearchParams([['room', useWebSocketStore.getState().room]]) });
            recordUse(cardActionKey('delete'));
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
                    {/* ⚠️★ 动作按**使用频率**排（用户 2026-11-26 的要求），但删除不参与：
                        它是不可逆的，永远留在最右 —— 「我删得多」不该把删除挪到复制旁边。 */}
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
                                        <span onClick={() => recordUse(cardActionKey('share'))} style={{ display: 'inline-flex' }}>
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
                                <MarkdownToggle mode={md.mode} actions={md.actions} onModeChange={md.setMode} />
                            )}
                            {md.html
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
