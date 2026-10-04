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
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <TextField
                size="small"
                fullWidth
                value={query}
                placeholder={t('actionSearchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                sx={{ mb: 1 }}
            />
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
                {groups.map((group) => (
                    <div key={group.key}>
                        <div style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', opacity: 0.75, margin: '10px 0 6px' }}>
                            {t(group.labelKey)}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {group.actions.map((action) => {
                                const applicable = isApplicable(action);
                                return (
                                    <button
                                        key={action.id}
                                        type="button"
                                        title={applicable ? t(action.nameKey) : t('actionNotApplicable')}
                                        onClick={() => onPick(action.id)}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 5,
                                            padding: '5px 10px',
                                            border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
                                            borderRadius: 999,
                                            background: 'transparent',
                                            color: 'inherit',
                                            fontSize: '0.75rem',
                                            lineHeight: 1.4,
                                            cursor: 'pointer',
                                            maxWidth: '100%',
                                            opacity: applicable ? 1 : 0.42,
                                        }}
                                    >
                                        <MdiIcon name={action.icon} size={16} />
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {t(action.nameKey)}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
                {!groups.length && (
                    <div style={{ fontSize: '0.75rem', opacity: 0.7, padding: '14px 2px', textAlign: 'center' }}>
                        {t('actionSearchEmpty')}
                    </div>
                )}
            </div>
        </div>
    );
}
