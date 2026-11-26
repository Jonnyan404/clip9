import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyTextToClipboard } from '@/lib/util';
import { toast } from '@/stores/toastStore';

/**
 * 分词结果 —— 一颗词一颗胶囊，**点选后只复制选中的那几个**。
 *
 * ⚠️★ 为什么要单独一个组件：`切出词`（`zh.segment`）这个动作在**每个模式**里都能用
 *    （卡片上那颗 `⋯` 菜单里的动作对所有卡片都开放），而它的下游通常是
 *    「挑几个词去查 / 去拼」。原来结果是一整段空格分隔的文本，用户只能整段复制再删。
 *
 * ⚠️ 上一版只做在动作台的结果区 —— 但那个动作台只是 8 个模式里的一个，
 *    标准 / 便签 / 一瞥 / 文件卡片里跑同一动作时什么都点不了。所以抽到这里，
 *    四处（卡片正文 + 动作台结果）共用同一份交互。
 *
 * 交互约定：
 *   · 点一颗切换选中，选中的填实主色（与卡片的 hover 色分开，避免误认）
 *   · 「复制」按钮上带已选数量；**一个都没选就复制全部**（保持原来的行为）
 *   · `text` 变了就清空选择：否则上一段的选中下标会「继续选中」新结果的同位置
 */
export function SegmentWords({ text, className }: { text: string; className?: string }) {
    const { t } = useTranslation();
    const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
    const [picked, setPicked] = useState<Set<number>>(() => new Set());

    useEffect(() => {
        setPicked(new Set());
    }, [text]);

    const copy = async () => {
        const selected = words.filter((_word, index) => picked.has(index));
        try {
            await copyTextToClipboard(selected.length ? selected.join(' ') : text);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    return (
        <div className={className ? `segment-words ${className}` : 'segment-words'}>
            <div className="segment-words__list">
                {words.map((word, index) => {
                    const on = picked.has(index);
                    return (
                        <button
                            key={`${index}-${word}`}
                            type="button"
                            className={on ? 'segment-words__word segment-words__word--on' : 'segment-words__word'}
                            aria-pressed={on}
                            onClick={() => setPicked((prev) => {
                                const next = new Set(prev);
                                if (next.has(index)) {
                                    next.delete(index);
                                } else {
                                    next.add(index);
                                }
                                return next;
                            })}
                        >
                            {word}
                        </button>
                    );
                })}
            </div>
            <div className="segment-words__bar">
                <button type="button" className="segment-words__copy" onClick={copy}>
                    {picked.size ? `${t('copyText')} (${picked.size})` : t('copyText')}
                </button>
                {picked.size > 0 && (
                    <button type="button" className="segment-words__clear" onClick={() => setPicked(new Set())}>
                        {t('segmentClearPick')}
                    </button>
                )}
            </div>
        </div>
    );
}
