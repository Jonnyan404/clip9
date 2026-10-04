import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MdiIcon } from '@/components/ui/MdiIcon';

export interface SlashTemplate {
    key: string;
    icon: string;
    text?: string;
    actionId?: string;
}

/**
 * 「/」模板菜单 —— 从 web-vue3/src/components/ComposerSlashMenu.vue 移植。
 *
 * ⚠️ 有两个落点（行内输入框上方 + 全屏输入窗）—— 全屏正是「写长文」的场景，模板恰恰在那时最有用。
 * 组件本身不管开关和插入，只负责渲染 + 抛 `onPick`（「往哪个 textarea 的哪个位置插」只有调用方知道）。
 */
export function ComposerSlashMenu({
    items,
    onPick,
}: {
    items: SlashTemplate[];
    onPick: (item: SlashTemplate) => void;
}) {
    const { t } = useTranslation();
    // ⚠️ 触摸屏上点胶囊：`touchstart` 之后浏览器还会补一发合成 `mousedown`，
    // 不去重的话模板会被插进去两次。去重窗口取 400ms。
    const lastPickRef = useRef(0);

    const pick = (item: SlashTemplate) => {
        const now = Date.now();
        if (now - lastPickRef.current < 400) {
            return;
        }
        lastPickRef.current = now;
        onPick(item);
    };

    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 4px 6px' }}>
            {items.map((item) => (
                <button
                    key={item.key}
                    type="button"
                    // ⚠️ `prevent` 不能少：不拦的话点胶囊会先让输入框失焦（手机上键盘收起、光标丢失），
                    // 插入的位置就错了。
                    onMouseDown={(e) => { e.preventDefault(); pick(item); }}
                    onTouchStart={(e) => { e.preventDefault(); pick(item); }}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
                        background: 'transparent',
                        color: 'inherit',
                        borderRadius: 999,
                        padding: '3px 10px',
                        fontSize: 12,
                        lineHeight: 1.4,
                        cursor: 'pointer',
                    }}
                >
                    <MdiIcon name={item.icon} size={18} />
                    {t(item.key)}
                </button>
            ))}
        </div>
    );
}
