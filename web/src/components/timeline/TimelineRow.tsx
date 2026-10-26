import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { GlancePreview } from '@/components/glance/GlancePreview';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';
import {
    copyTextToClipboard, decodeHtmlEntities, deviceLabel,
    isAutomationMessage, isFileEntry, isLateMessage, looksLikeTable,
} from '@/lib/util';
import { toast } from '@/stores/toastStore';
import type { ReceivedItem } from '@/stores/appStore';
import { categoryIcon, categoryLabelKey, type TimelineCategory } from './categories';

/**
 * 时间线里的一行 —— 收起时是一行摘要，展开时是**同一条的完整预览**（复用 `GlancePreview`）。
 *
 * ⚠️★ 收起态**不渲染 markdown**：一屏十几行，每行跑一遍动作链（异步 + 二次渲染）是白花的。
 *    只有展开后才挂 `GlancePreview` —— 它负责正文渲染、文件取字节、下载 / 分享 / 删除。
 * ⚠️ 行首的时间是**结构**，不受「显示时间戳」开关管（速览模式的时间栏同理）：
 *    这个模式的意义就是「什么时候来的」。
 * ⚠️ 复制按钮是 `<button>` 而不是 MUI 的 IconButton：一屏几十个，别为一个小图标套 Tooltip +
 *    IconButton 两层组件（标准模式用 IconButton 是因为卡片数量少一半）。
 */
export const TimelineRow = memo(function TimelineRow({
    meta,
    category,
    expanded,
    onToggle,
}: {
    meta: ReceivedItem;
    category: TimelineCategory;
    expanded: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const display = useDisplaySettings();

    const isFile = isFileEntry(meta);
    const isAutomation = isAutomationMessage(meta);
    const isLate = isLateMessage(meta);
    const device = display.device ? deviceLabel(meta.senderDevice) : '';
    const showIp = display.ip && Boolean(meta.senderIP);
    const time = clockOf(meta.timestamp);

    const copyText = async () => {
        try {
            await copyTextToClipboard(decodeHtmlEntities(String(meta.content || '')));
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    return (
        <div className={`timeline-row${expanded ? ' is-open' : ''}`} data-category={category}>
            <button
                type="button"
                className="timeline-row__main"
                aria-expanded={expanded}
                onClick={() => onToggle(meta.id)}
            >
                <span className="timeline-row__time">{time}</span>
                <span className="timeline-row__icon">
                    <MdiIcon name={categoryIcon(category, meta.name)} size={14} />
                </span>
                <span className="timeline-row__body">
                    <span className="timeline-row__preview">{previewOf(meta) || t('emptyHere')}</span>
                    <span className="timeline-row__meta">
                        <span className="timeline-row__cat">{t(categoryLabelKey(category))}</span>
                        {meta.id && (
                            <>
                                <span className="timeline-row__sep" />
                                <span className="timeline-row__id">#{meta.id}</span>
                            </>
                        )}
                        {device && (
                            <>
                                <span className="timeline-row__sep" />
                                <span className="timeline-row__meta-item">
                                    <MdiIcon name={deviceIcon(meta.senderDevice?.type)} size={11} />
                                    {device}
                                </span>
                            </>
                        )}
                        {showIp && (
                            <>
                                <span className="timeline-row__sep" />
                                <span className="timeline-row__meta-item">
                                    <MdiIcon name="mdi-ip-network-outline" size={11} />
                                    {String(meta.senderIP)}
                                </span>
                            </>
                        )}
                        {isAutomation && (
                            <span className="timeline-row__flag timeline-row__flag--auto">
                                <MdiIcon name="mdi-calendar-clock" size={10} />
                                {t('automationSource')}
                            </span>
                        )}
                        {isLate && (
                            <span className="timeline-row__flag timeline-row__flag--late" title={t('automationLateHint')}>
                                <MdiIcon name="mdi-clock-alert-outline" size={10} />
                                {t('automationLate')}
                            </span>
                        )}
                    </span>
                </span>
                {category === 'image' && meta.thumbnail && (
                    <img className="timeline-row__thumb" src={String(meta.thumbnail)} alt="" loading="lazy" />
                )}
                <span className="timeline-row__chev">
                    <MdiIcon name="mdi-chevron-right" size={16} />
                </span>
            </button>

            {!isFile && (
                <button
                    type="button"
                    className="timeline-row__copy"
                    onClick={copyText}
                    title={t('copyText')}
                    aria-label={t('copyText')}
                >
                    <MdiIcon name="mdi-content-copy" size={15} />
                </button>
            )}

            {expanded && (
                <div className="timeline-row__full">
                    <GlancePreview item={meta} enableTaskToggle inline />
                </div>
            )}
        </div>
    );
});

/** 本地 `HH:mm`。日期由外层分组负责，这里只画时刻。 */
function clockOf(timestamp?: number): string {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 一行的摘要：文件用文件名，文本压平空白（任务列表顺手去掉复选框记号）。 */
function previewOf(item: ReceivedItem): string {
    if (isFileEntry(item)) {
        return String(item.name || 'file');
    }
    const raw = String(item.content || '');
    const clipped = raw.length > 600 ? raw.slice(0, 600) : raw;
    if (looksLikeTable(clipped)) {
        // 表格只取表头 + 第一行数据：分隔行（| --- | --- |）在摘要里只会变成一排横杠。
        const lines = clipped
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('|') && !/^\|?[\s:|-]+\|?$/.test(line));
        return lines.slice(0, 2).map((line) => line.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()).join(' · ');
    }
    return clipped
        .replace(/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function deviceIcon(type?: string): string {
    const lower = (type || '').toLowerCase();
    if (lower.includes('mobile') || lower.includes('phone') || lower.includes('tablet') || lower.includes('ios') || lower.includes('android')) {
        return 'mdi-cellphone';
    }
    return 'mdi-desktop-tower';
}
