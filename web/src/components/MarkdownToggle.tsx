import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Tooltip } from '@mui/material';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { MarkdownAction } from '@/hooks/useMarkdown';
import { ActionPicker } from '@/components/bench/ActionPicker';
import { ActionParamsPopover } from '@/components/ActionParamsPopover';
import { findAction } from '@/lib/actions/index.js';
import { sortActions, useActionPrefStore } from '@/stores/actionPrefStore';

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
    text = '',
    onModeChange,
}: {
    mode: string | null;
    actions: MarkdownAction[];
    /** 当前正文。用来判断「这个动作对这段文本适不适用」—— 不适用的按钮要置灰。 */
    text?: string;
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
        // ⚠️★ 这一行是「频次排序」真正起作用的前提：预览条上露出的那两颗按钮
        //    **不经过** `ActionPicker.pick()`，所以它的使用次数原来从来没被记过 ——
        //    于是「分词 / 查找替换」永远排在最前，用别的动作一百次也不会上来
        //    （用户 2026-11-26 报的正是这个）。
        recordUse(action.id);
        if (action.params && action.params.length) {
            setParamAction({ action, anchor });
            return;
        }
        onModeChange(action.id);
    };

    /**
     * 除了「原文」，卡片上直接露出的图标按**使用频次**排（用户 2026-11-26 的要求）。
     *
     * ⚠️ 「原文」不在 `actions` 里 —— 它是那颗单独的 `</>` 按钮，永远在最左：
     *    它不是一个动作，是「什么都不跑」，位置漂了会让人找不到退路。
     * ⚠️ 频次用 `actionPrefStore` 里那张表（和动作面板共用），`count` 相同比 `lastUsedAt`。
     */
    const usage = useActionPrefStore((s) => s.usage);
    const recordUse = useActionPrefStore((s) => s.recordUse);

    /**
     * 用过的 `view` 动作 —— **不管它对这段文本 match 不 match**，都预热进候选池。
     *
     * ⚠️★ 这是「我反复用文本统计，预览条永远是分词/查找替换」的根因：
     *    `actions` 来自 `targetedActions()`，而它只收**有 `match` 且匹配当前文本**的动作。
     *    「文本统计」这类通用动作**根本没有 match 字段** → 永远进不了 targeted →
     *    频次再高也顶不上来，而它在动作库（`⋯`）里却排第一，看起来像两套逻辑。
     *    现在 candidates = targeted ∪ 用过的 view 动作，再统一按频次排。
     * ⚠️ 只收 `direction === 'view'`：`transform` 类的动作会改文本内容，不该常驻在「怎么看」这一排。
     */
    const frequentPool = useMemo(() => {
        const list: MarkdownAction[] = [];
        for (const [id, entry] of Object.entries(usage)) {
            if (!entry || entry.count <= 0) {
                continue;
            }
            const action = findAction(id) as (MarkdownAction & { direction?: string }) | undefined;
            if (action && action.direction === 'view') {
                list.push(action);
            }
        }
        return list;
    }, [usage]);

    /**
     * ⚠️★ 只保留**对这段文本适用**的动作（用户 2026-11-26：「直接在动作选择列表里置灰，
     *    不要点了不生效才置灰」）。
     *    预览条是「这一屏能看到的几个选项」，摆一个点了没反应的按钮在这里是误导；
     *    「不适用」这件事属于**动作选择列表**（`ActionPicker` 里本来就有 `--dim` 置灰），
     *    那里用户是在浏览全集，置灰是信息；这里是在快捷操作，置灰是噪音。
     */
    const orderedActions = useMemo(() => {
        const map = new Map<string, MarkdownAction>();
        for (const action of actions) {
            map.set(action.id, action);
        }
        for (const action of frequentPool) {
            map.set(action.id, action);
        }
        return sortActions([...map.values()], usage).filter((action) => {
            const matcher = (action as { match?: (value: string) => boolean }).match;
            return !matcher || matcher(text);
        });
    }, [actions, frequentPool, usage, text]);

    /**
     * 露在外面的两颗：**当前正在跑的那个动作固定第一**（占原来「原文」按钮的位置），
     * 其余按频次补齐。
     *
     * ⚠️★ 为什么当前动作必须钉在第一位：它可能在频次上排不进前二（比如第一次用一个冷门动作），
     *    那样用户点完就「看不见自己在跑什么」—— 只能靠 `⋯` 里那个高亮去猜。
     *    原文按钮删掉之后空出来的正好就是这个位置，语义也接得上：
     *    第一个位置永远是「你现在看到的是哪种视图」。
     * ⚠️ 被挤出去的那个动作会回到 `⋯` 里，不是消失。
     */
    // ⚠️★ 兜底到全量动作：当前动作**不一定在 `actions`（targeted）里** ——
    //    比如默认视图 `format.markdown` 在文本不像 markdown 时连 `match` 都不成立。
    //    找不到就不 pin，等于「当前在跑什么」看不见（用户报的「dev 里没效果」就可能是这一条）。
    /**
     * 这一段文本「适不适用」。没有 `match` 的动作 = 通用动作，永远适用。
     * ⚠️ 预览条的候选集现在包含「用过但不 match」的动作（见 `frequentPool`），
     *    所以必须能判出来并且**置灰** —— 否则用户点一个不适用的动作，`useMarkdown`
     *    会静默吞掉错误，表现就是「点了没反应」。
     */
    const activeAction = mode
        ? orderedActions.find((action) => action.id === mode) ?? (findAction(mode) as MarkdownAction | undefined)
        : undefined;

    /**
     * 三个槽位：**第一个留给「当前在用的动作」**（没有就空着、不占位），
     * 后面按频次补到 3 颗。
     *
     * ⚠️ 用户 2026-11-26 的原话是「当前在用的动作(初始留空) / 文本统计 / Markdown 渲染 / 更多」——
     *    即当前动作**不参与**频次竞争，它有位置就坐第一个；没动作时这一格空着。
     */
    const shownActions = activeAction
        ? [activeAction, ...orderedActions.filter((action) => action.id !== activeAction.id)].slice(0, 3)
        : orderedActions.slice(0, 2);
    // ⚠️ ⋯ 是**动作库的唯一入口**，它必须一直在：预览条过滤掉不适用的动作之后，
    //    剩余数量可能等于 `shownActions.length`，按「数量比大小」这条就会被吞掉。
    const hasMore = true;

    return (
        <div className="md-toggle">
            {/* ⚠️★ 原文按钮已移除（用户 2026-11-26）：它原来负责「回到不跑动作」，
                现在这件事交给**二次点击同一个动作**（见下面那个 onClick）——
                少一颗常驻按钮，且「点哪颗就撤哪颗」比「点最左边那颗原文」更直觉。 */}

            {shownActions.map((action) => (
                <Tooltip key={action.id} title={t(action.nameKey)}>
                    <button
                        type="button"
                        className={`md-toggle__icon${mode === action.id ? ' md-toggle__icon--active' : ''}`}
                        aria-label={t(action.nameKey)}
                        onClick={(e) => {
                            // ⚠️ 二次点击 = 取消：再点一次**已经选中**的动作，回到「不跑任何动作」。
                            //    这是原文按钮被移除后的唯一退路，别删。
                            if (mode === action.id) {
                                onModeChange(null);
                                return;
                            }
                            choose(action, e.currentTarget);
                        }}
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
                        {/* ⚠️★ 必须是 flex 列 + `minHeight: 0`：`ActionPicker` 的 `.action-picker__body`
                            靠 `overflow-y: auto` 自己滚，而它需要**有界**的父高。
                            原来这个 div 是 `display: block` + `overflow: hidden` ——
                            内容直接被裁掉、滚不动（用户报的「动作卡片无法滚动」就是这个）。
                            ⚠️ 这段是 JSX children，注释必须用花括号包成 JSX 注释块：
                            写成 `//` 会被当成**文本**渲染，在面板顶上糊出一条长注释
                            （2026-11-26 实际发生，tsc 不报错 —— 只能靠眼睛发现）。 */}
                        <div style={{ width: 340, maxWidth: 'calc(100vw - 32px)', maxHeight: 320, padding: 10, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                            <ActionPicker
                                // ⚠️★ 必须把正文传进去，否则 `ActionPicker` 里「这段文本适不适用」的判定
                                //    永远走 `if (!text) return true` 那条兜底 —— 菜单里一个置灰项都不会有，
                                //    和动作台（那边传了 text）的表现就对不上（用户 2026-11-26 报的）。
                                text={text}
                                onPick={(id) => {
                                    // ⚠️ 锚点要在 `setMenuAnchor(null)` **之前**取：菜单一关，
                                    // 那个「⋯」按钮虽然还在，但这个 state 已经被清掉了。
                                    const anchor = menuAnchor;
                                    setMenuAnchor(null);
                                    // 菜单里同样支持「二次点击 = 取消」（和露在外面的那两颗一致）
                                    if (mode === id) {
                                        onModeChange(null);
                                        return;
                                    }
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
