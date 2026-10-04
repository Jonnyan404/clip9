import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Tooltip } from '@mui/material';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { MarkdownAction } from '@/hooks/useMarkdown';
import { ActionPicker } from '@/components/bench/ActionPicker';

/**
 * 预览框右上角那排「用哪种方式看」的图标 —— **动作库驱动**。
 * 从 web-vue3/src/components/MarkdownToggle.vue 移植。
 *
 * ⚠️ 这里**不放复制** —— 复制统一走卡片上那个复制图标（它会复制**当前视图**的内容）。
 * ⚠️ 卡片上直接露图标的动作**最多 2 个**，其余（含全部通用动作）收进 `⋯`。
 * ⚠️ 浮动定位（absolute）由本组件自带，调用方要满足三件事（见 styles/components.css）：
 *    外层 position: relative 且不滚动；滚动盒上留 `--md-toggle-gutter`；那层别挂 overflow。
 */
export function MarkdownToggle({
    mode,
    actions,
    onModeChange,
}: {
    mode: string | null;
    actions: MarkdownAction[];
    onModeChange: (next: string | null) => void;
}) {
    const { t } = useTranslation();
    const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

    const inlineActions = actions.slice(0, 2);
    const hasMore = actions.length > 2;

    return (
        <div className="md-toggle">
            {/* 原文。`null` 不是动作 —— 它表示「不跑任何动作」。 */}
            <Tooltip title={t('rawText')}>
                <button
                    type="button"
                    className={`md-toggle__icon${mode === null ? ' md-toggle__icon--active' : ''}`}
                    aria-label={t('rawText')}
                    onClick={() => onModeChange(null)}
                >
                    <MdiIcon name="mdi-code-tags" size={20} />
                </button>
            </Tooltip>

            {inlineActions.map((action) => (
                <Tooltip key={action.id} title={t(action.nameKey)}>
                    <button
                        type="button"
                        className={`md-toggle__icon${mode === action.id ? ' md-toggle__icon--active' : ''}`}
                        aria-label={t(action.nameKey)}
                        onClick={() => onModeChange(action.id)}
                    >
                        <MdiIcon name={action.icon} size={20} />
                    </button>
                </Tooltip>
            ))}

            {/* 其余动作（含全部通用动作）。⚠️ 复用工作台的 ActionPicker —— 同一套分组和搜索，
                **别在这里再造一个简化版菜单**（两份迟早会漂）。 */}
            {hasMore && (
                <>
                    <Tooltip title={t('actionMore')}>
                        <button
                            type="button"
                            className="md-toggle__icon"
                            aria-label={t('actionMore')}
                            onClick={(e) => setMenuAnchor(e.currentTarget)}
                        >
                            <MdiIcon name="mdi-dots-horizontal" size={20} />
                        </button>
                    </Tooltip>
                    <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                        <div style={{ width: 340, maxWidth: 'calc(100vw - 32px)', maxHeight: 320, padding: 10, overflow: 'hidden' }}>
                            <ActionPicker
                                onPick={(id) => {
                                    onModeChange(id);
                                    setMenuAnchor(null);
                                }}
                            />
                        </div>
                    </Menu>
                </>
            )}
        </div>
    );
}
