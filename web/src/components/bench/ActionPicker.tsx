import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import { ACTION_GROUPS, ACTIONS } from '@/lib/actions/index.js';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { sortActions, useActionPrefStore, type ActionSortMode } from '@/stores/actionPrefStore';

/**
 * 动作选择面板 —— 从 web-vue3/src/components/bench/ActionPicker.vue 移植。
 *
 * ⚠️ 是「追加」不是「替换」—— 这是它和普通下拉菜单的根本区别（点第二个动作时第一个不会消失）。
 * ⚠️ 不适用的动作**置灰但不隐藏**：隐藏会让人以为功能不存在；置灰 + 一句说明，
 *    用户能自己得出「哦，这条不是 JSON」。
 * ⚠️★ 样式走 `.action-picker*`（styles/components.css），与 Vue 同名同值 ——
 *    别在这里用 `sx` 再描一遍，两处一定会漂。
 * ⚠️ 这个面板**住在弹层里**，宿主（`.action-chain__picker`）负责给它一个**有界**的高度，
 *    否则里面的 `.action-picker__body` 滚不起来。
 *
 * # 排序（2026-11-26）
 *
 * 三种方式，各解决一个不同的场景 —— 混在一起就会互相打架：
 *   · `default`  —— 计划里的顺序 + **适用的排前面**。新用户没有任何使用记录，这个最可预期。
 *   · `frequent` —— 按「用了几次 → 最近一次用的时间」。⚠️ 两个都要比：只比次数的话，
 *                   一堆 `count = 1` 的动作会按 catalog 顺序排回来，等于没排。
 *   · `custom`   —— 用户自己排，**严格生效**。⚠️ 这个模式里**不加**「适用优先」：
 *                   刚排好的顺序被自动打乱，等于这个模式没有意义（不适用的仍然置灰）。
 */
interface ActionSpec {
    id: string;
    group: string;
    nameKey: string;
    descKey?: string;
    icon: string;
    direction?: string;
    match?: (text: string) => boolean;
}

const SORT_OPTIONS: Array<{ value: ActionSortMode; labelKey: string }> = [
    { value: 'default', labelKey: 'actionSortDefault' },
    { value: 'frequent', labelKey: 'actionSortFrequent' },
    { value: 'custom', labelKey: 'actionSortCustom' },
];

export function ActionPicker({
    text = '',
    direction = 'view',
    onPick,
}: {
    text?: string;
    direction?: string;
    onPick: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');

    const sortMode = useActionPrefStore((s) => s.sortMode);
    const usage = useActionPrefStore((s) => s.usage);
    const order = useActionPrefStore((s) => s.order);
    const setSortMode = useActionPrefStore((s) => s.setSortMode);
    const recordUse = useActionPrefStore((s) => s.recordUse);
    const moveAction = useActionPrefStore((s) => s.moveAction);

    const isApplicable = (action: ActionSpec) => {
        if (!action.match) {
            return true; // 通用动作，任何文本都能跑
        }
        if (!text) {
            return true; // 没有内容可判断时，一律当作可用（别让人以为一半动作消失了）
        }
        return action.match(text);
    };

    const pick = (id: string) => {
        // ⚠️ 记在这里而不是宿主里：`ActionPicker` 有两个宿主（动作链、预览图标排的 `⋯`），
        //    记录写在宿主就得写两遍，而漏一处会让「常用」在某个入口下永远排不出来。
        recordUse(id);
        onPick(id);
    };

    // 全部动作的 id —— 自定义排序需要一份「完整默认顺序」作底
    const allIds = useMemo(() => (ACTIONS as ActionSpec[]).map((action) => action.id), []);

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const pool = (ACTIONS as ActionSpec[]).filter(
            (action) => action.direction === direction
                && (!q
                    || t(action.nameKey).toLowerCase().includes(q)
                    || action.id.toLowerCase().includes(q)
                    // 描述也参与搜索：用户记得「它会加空行」但不记得叫什么，输入「空格」也该搜到
                    || (action.descKey ? t(action.descKey).toLowerCase().includes(q) : false)),
        );
        return (ACTION_GROUPS as Array<{ key: string; labelKey: string }>)
            .map((group) => ({
                ...group,
                actions: sortActions(
                    pool.filter((action) => action.group === group.key),
                    sortMode,
                    usage,
                    order,
                    isApplicable,
                ),
            }))
            .filter((group) => group.actions.length);
    }, [query, text, direction, t, sortMode, usage, order]);

    const titleOf = (action: ActionSpec) => {
        const name = t(action.nameKey);
        if (!isApplicable(action)) {
            return `${name} — ${t('actionNotApplicable')}`;
        }
        // 描述只在**有**的时候拼上去：46 条动作里带 descKey 的目前只有新增的那几条，
        // 拼一个空串会得到「名称 — 」这种尾巴。
        return action.descKey ? `${name} — ${t(action.descKey)}` : name;
    };

    return (
        <div className="action-picker">
            <TextField
                className="action-picker__search"
                size="small"
                fullWidth
                value={query}
                placeholder={t('actionSearchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
            />

            {/* ⚠️ 排序条放在搜索下面、列表上面：它是**这一整个面板**的视图设置，
                放进每一组里会变成 N 份互不同步的开关。 */}
            <div className="action-picker__sortbar">
                <span className="action-picker__sortlabel">{t('actionSortLabel')}</span>
                <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={sortMode}
                    onChange={(_e, next: ActionSortMode | null) => next && setSortMode(next)}
                    aria-label={t('actionSortLabel')}
                >
                    {SORT_OPTIONS.map((option) => (
                        <ToggleButton
                            key={option.value}
                            value={option.value}
                            sx={{ px: 1, py: 0.25, fontSize: 12, textTransform: 'none' }}
                        >
                            {t(option.labelKey)}
                        </ToggleButton>
                    ))}
                </ToggleButtonGroup>
                {sortMode === 'custom' && (
                    <span className="action-picker__sorthint">{t('actionSortCustomHint')}</span>
                )}
            </div>

            <div className="action-picker__body">
                {groups.map((group) => (
                    <div key={group.key}>
                        <div className="action-picker__group">{t(group.labelKey)}</div>
                        {sortMode === 'custom' ? (
                            // 自定义顺序要一条条挪，所以这一模式下换成竖排 ——
                            // grid 里每个格子塞两个箭头会挤成一条缝，点不中。
                            <div className="action-picker__list">
                                {group.actions.map((action) => {
                                    const applicable = isApplicable(action);
                                    return (
                                        <div
                                            key={action.id}
                                            className={`action-picker__row${applicable ? '' : ' action-picker__row--dim'}`}
                                        >
                                            <button
                                                type="button"
                                                className="action-picker__rowbtn"
                                                title={titleOf(action)}
                                                onClick={() => pick(action.id)}
                                            >
                                                <MdiIcon name={action.icon} size={16} />
                                                <span className="action-picker__label">{t(action.nameKey)}</span>
                                            </button>
                                            <Tooltip title={t('actionMoveUp')}>
                                                <button
                                                    type="button"
                                                    className="action-picker__move"
                                                    aria-label={`${t('actionMoveUp')} ${t(action.nameKey)}`}
                                                    onClick={() => moveAction(action.id, -1, allIds)}
                                                >
                                                    <MdiIcon name="mdi-chevron-up" size={16} />
                                                </button>
                                            </Tooltip>
                                            <Tooltip title={t('actionMoveDown')}>
                                                <button
                                                    type="button"
                                                    className="action-picker__move"
                                                    aria-label={`${t('actionMoveDown')} ${t(action.nameKey)}`}
                                                    onClick={() => moveAction(action.id, 1, allIds)}
                                                >
                                                    <MdiIcon name="mdi-chevron-down" size={16} />
                                                </button>
                                            </Tooltip>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="action-picker__grid">
                                {group.actions.map((action) => {
                                    const applicable = isApplicable(action);
                                    return (
                                        <button
                                            key={action.id}
                                            type="button"
                                            className={applicable ? 'action-picker__item' : 'action-picker__item action-picker__item--dim'}
                                            title={titleOf(action)}
                                            onClick={() => pick(action.id)}
                                        >
                                            <MdiIcon name={action.icon} size={16} />
                                            <span className="action-picker__label">{t(action.nameKey)}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ))}
                {!groups.length && <div className="action-picker__empty">{t('actionSearchEmpty')}</div>}
            </div>
        </div>
    );
}
