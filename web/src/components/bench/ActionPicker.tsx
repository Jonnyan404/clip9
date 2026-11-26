import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '@mui/material';
import { ACTION_GROUPS, ACTIONS } from '@/lib/actions/index.js';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { sortActions, useActionPrefStore } from '@/stores/actionPrefStore';

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
 * # 排序（2026-11-26 简化）
 *
 * ⚠️★ 这里原来有一排「默认 / 常用 / 自定义」开关，用户要求去掉：每次打开面板都要先
 *    做一个跟当下任务无关的决定，而三档里真正被用的只有一档。
 *    现在只有一条规则：**适用的在前，其次按用过多少次（同次数比最近一次）**。
 *    新用户没有记录 → 就是目录顺序，和「默认」一模一样，所以这个简化不会让任何人迷失。
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

    const usage = useActionPrefStore((s) => s.usage);
    const recordUse = useActionPrefStore((s) => s.recordUse);

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
                    usage,
                    isApplicable,
                ),
            }))
            .filter((group) => group.actions.length);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, text, direction, t, usage]);

    /**
     * 「最近使用」—— 按频次取前 6 条（`count → lastUsedAt`）。
     *
     * ⚠️★ 为什么在**保留分组**的前提下再加这一块，而不是把分组整个拆掉按频次平铺：
     *    分组是「我不知道那个动作叫什么」时的唯一入口（46 条动作里靠名字找不到的占多数），
     *    频次解决的是「我天天用这个、每次都要翻下去找」。两件事，不是二选一。
     * ⚠️ 搜索时隐藏它：搜索已经在做「筛」，再叠一块频次区只会让结果看起来重复。
     */
    const recent = useMemo(() => {
        if (query.trim()) {
            return [];
        }
        const pool = (ACTIONS as ActionSpec[]).filter((action) => action.direction === direction && usage[action.id]);
        return sortActions(pool, usage, isApplicable).slice(0, 6);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, direction, usage, text]);

    const titleOf = (action: ActionSpec) => {
        const name = t(action.nameKey);
        if (!isApplicable(action)) {
            return `${name} — ${t('actionNotApplicable')}`;
        }
        // 描述只在**有**的时候拼上去：动作里带 descKey 的只有少数几条，
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

            <div className="action-picker__body">
                {recent.length > 0 && (
                    <div>
                        <div className="action-picker__group">{t('actionRecent')}</div>
                        <div className="action-picker__grid">
                            {recent.map((action) => (
                                <button
                                    key={`recent-${action.id}`}
                                    type="button"
                                    className="action-picker__item"
                                    title={titleOf(action)}
                                    onClick={() => pick(action.id)}
                                >
                                    <MdiIcon name={action.icon} size={16} />
                                    <span className="action-picker__label">{t(action.nameKey)}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {groups.map((group) => (
                    <div key={group.key}>
                        <div className="action-picker__group">{t(group.labelKey)}</div>
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
                    </div>
                ))}
                {!groups.length && <div className="action-picker__empty">{t('actionSearchEmpty')}</div>}
            </div>
        </div>
    );
}
