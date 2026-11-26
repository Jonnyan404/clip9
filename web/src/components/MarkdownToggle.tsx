import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Tooltip } from '@mui/material';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { MarkdownAction } from '@/hooks/useMarkdown';
import { ActionPicker } from '@/components/bench/ActionPicker';
import { ActionParamsPopover } from '@/components/ActionParamsPopover';
import { findAction } from '@/lib/actions/index.js';

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
    onModeChange: (next: string | null, params?: Record<string, string>) => void;
}) {
    const { t } = useTranslation();
    const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
    // 「这个动作要先填参数」——记下它是谁、按钮在哪（Popover 要贴着那个按钮弹）。
    const [paramAction, setParamAction] = useState<{ action: MarkdownAction; anchor: HTMLElement | null } | null>(null);

    /**
     * 选中一个动作。
     *
     * ⚠️★ 这里是「查找替换点了没反应」那个 bug 的修复点：带 `params` 的动作**不能**直接
     * `onModeChange(id)` —— 那样动作拿不到 mode/find/with，`replaceLiteral` 当场抛错，
     * 而 `useMarkdown` 按「卡片预览区不弹错误」的原则把错误咽了，用户看到的就是**什么都没发生**。
     * 所以先收参数，再由 `onModeChange(id, params)` 带着参数跑。
     */
    const choose = (action: MarkdownAction | undefined, anchor: HTMLElement | null) => {
        if (!action) {
            return;
        }
        if (action.params && action.params.length) {
            setParamAction({ action, anchor });
            return;
        }
        onModeChange(action.id);
    };

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
                        onClick={(e) => choose(action, e.currentTarget)}
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
                        // ⚠️★ 必须是 flex 列 + `minHeight: 0`：`ActionPicker` 的 `.action-picker__body`
                        // 靠 `overflow-y: auto` 自己滚，而它需要**有界**的父高。
                        // 原来这个 div 是 `display: block` + `overflow: hidden` ——
                        // 内容直接被裁掉、滚不动（用户报的「动作卡片无法滚动」就是这个）。
                        <div style={{ width: 340, maxWidth: 'calc(100vw - 32px)', maxHeight: 320, padding: 10, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                            <ActionPicker
                                onPick={(id) => {
                                    // ⚠️ 锚点要在 `setMenuAnchor(null)` **之前**取：菜单一关，
                                    // 那个「⋯」按钮虽然还在，但这个 state 已经被清掉了。
                                    const anchor = menuAnchor;
                                    setMenuAnchor(null);
                                    choose(findAction(id) as MarkdownAction | undefined, anchor);
                                }}
                            />
                        </div>
                    </Menu>
                </>
            )}

            {/* 参数弹层与菜单**同级**：菜单一关它就接管，两个不会同时显示。 */}
            {paramAction && (
                <ActionParamsPopover
                    open
                    anchorEl={paramAction.anchor}
                    actionId={paramAction.action.id}
                    actionName={t(paramAction.action.nameKey)}
                    params={paramAction.action.params ?? []}
                    onClose={() => setParamAction(null)}
                    onSubmit={(values) => {
                        onModeChange(paramAction.action.id, values);
                        setParamAction(null);
                    }}
                />
            )}
        </div>
    );
}
