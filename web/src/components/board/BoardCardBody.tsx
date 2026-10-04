import { useTranslation } from 'react-i18next';
import { useMarkdown } from '@/hooks/useMarkdown';
import { useTaskListToggle } from '@/hooks/useTaskListToggle';
import { MarkdownBody } from '@/components/MarkdownBody';
import { useWebSocketStore } from '@/stores/wsStore';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 看板卡片的正文 —— 从 web-vue3/src/components/board/BoardCardBody.vue 移植。
 *
 * ⚠️ 抽成组件不是为了复用，而是因为 `useMarkdown` / `useTaskListToggle` 都是**按条目**的
 * hook（各自持 ref 与防抖计时器），必须一条一个实例 —— 在列表里循环调用同一个实例会串状态。
 * ⚠️ 约定跟标准模式卡片、便签卡片完全一致：任务列表 / 表格默认渲染成 md，普通文本仍走原文预览。
 */
export function BoardCardBody({ meta }: { meta: ReceivedItem }) {
    const { t } = useTranslation();
    const { text, onMdClick } = useTaskListToggle(meta, () => useWebSocketStore.getState().room);
    const md = useMarkdown(() => text);
    const preview = text.trim() || t('emptyHere');

    return (
        <div
            className="board-card-body"
            onClick={onMdClick}
            style={{
                display: md.html ? 'block' : '-webkit-box',
                WebkitLineClamp: md.html ? undefined : 4,
                WebkitBoxOrient: 'vertical',
                overflow: md.html ? 'visible' : 'hidden',
                overflowX: md.html ? 'auto' : undefined,
                whiteSpace: md.html ? 'normal' : 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12.5,
                lineHeight: 1.5,
            }}
        >
            {md.html ? <MarkdownBody html={md.html} /> : preview}
        </div>
    );
}
