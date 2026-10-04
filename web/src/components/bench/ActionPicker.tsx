import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '@mui/material';
import { ACTION_GROUPS, ACTIONS } from '@/lib/actions/index.js';
import { MdiIcon } from '@/components/ui/MdiIcon';

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
 */
interface ActionSpec {
    id: string;
    group: string;
    nameKey: string;
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

    const isApplicable = (action: ActionSpec) => {
        if (!action.match) {
            return true; // 通用动作，任何文本都能跑
        }
        if (!text) {
            return true; // 没有内容可判断时，一律当作可用（别让人以为一半动作消失了）
        }
        return action.match(text);
    };

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const pool = (ACTIONS as ActionSpec[]).filter(
            (action) => action.direction === direction
                && (!q || t(action.nameKey).toLowerCase().includes(q) || action.id.toLowerCase().includes(q)),
        );
        return (ACTION_GROUPS as Array<{ key: string; labelKey: string }>)
            .map((group) => ({
                ...group,
                // 适用的排前面 —— 用户十有八九要的就是那几个
                actions: pool
                    .filter((action) => action.group === group.key)
                    .sort((a, b) => Number(isApplicable(b)) - Number(isApplicable(a))),
            }))
            .filter((group) => group.actions.length);
    }, [query, text, direction, t]);

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
                                        title={applicable ? t(action.nameKey) : t('actionNotApplicable')}
                                        onClick={() => onPick(action.id)}
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
