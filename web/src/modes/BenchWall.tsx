import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { ActionChain } from '@/components/bench/ActionChain';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore, selectVisibleReceived, type ReceivedItem } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { decodeHtmlEntities, errorMessage, formatTimestamp } from '@/lib/util';
import { postText } from '@/services/send';

/**
 * 动作工作台 —— 从 web-vue3/src/views/modes/BenchWall.vue 移植。
 *
 * 和速览的区别（两个都是主从两栏）：速览是「**读**这条内容」（右侧只读预览）；
 * 工作台是「**加工**这条内容」（右侧是可叠多步的动作链 + 实时结果）。
 *
 * ⚠️ 只列**文本条目**（文件条目没有正文，取正文要另发请求，第一版不做）。
 * ⚠️ 这个模式**不改数据** —— 结果要落盘只能显式点「另存为新条目」（走现成的 `POST /text`）。
 * ⚠️ 上下键切换时，**焦点在输入框 / 可编辑元素里就不接管**（那里方向键是移光标）。
 * ⚠️★ 样式全部走 `.bench-wall*`（styles/components.css），与 Vue 同名同值 ——
 *    别在这里用 `sx` 再描一遍（原来是那样，边框色/圆角/底纹都和 Vue 对不上）。
 */
export default function BenchWall() {
    const { t } = useTranslation();
    const itemsRef = useRef<HTMLDivElement | null>(null);

    const received = useAppStore((s) => s.received);
    const searchQuery = useAppStore((s) => s.searchQuery);

    // 数据源与标准模式/速览**共用** `selectVisibleReceived`（已含搜索过滤）。
    const items = useMemo(
        () => selectVisibleReceived({ received, searchQuery }).filter((item) => item.type === 'text'),
        [received, searchQuery],
    );

    const [draft, setDraft] = useState('');
    const [activeIndex, setActiveIndex] = useState(-1);

    const [isWide, setIsWide] = useState(() => window.innerWidth >= 1024);
    useEffect(() => {
        const onResize = () => setIsWide(window.innerWidth >= 1024);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // 服务端存的是 HTML 实体编码过的正文，填进来之前要还原回原文。
    const fillFrom = (item: ReceivedItem) => setDraft(decodeHtmlEntities(String(item.content || '')));

    const selectIndex = (index: number) => {
        if (index < 0 || index >= items.length) return;
        setActiveIndex(index);
        fillFrom(items[index]);
        requestAnimationFrame(() => {
            itemsRef.current?.querySelectorAll('.bench-wall__item')[index]?.scrollIntoView({ block: 'nearest' });
        });
    };

    // 首次有内容时自动填第一条 —— 一进这个模式就有东西可试（只在输入框还空着时填）。
    useEffect(() => {
        if (!draft && items.length) {
            setActiveIndex(0);
            fillFrom(items[0]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const el = event.target as HTMLElement | null;
            // ⚠️ 焦点在输入框 / 可编辑元素里时不接管（那里方向键是移光标）。
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            selectIndex(activeIndex < 0 ? 0 : activeIndex + delta);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    });

    const saveAsNew = async (content: string) => {
        const body = String(content ?? '');
        if (!body) return;
        try {
            await postText({ room: useWebSocketStore.getState().room, text: body });
            toast(t('actionSaveAsNewDone'));
        } catch (error) {
            toast(errorMessage(error) || t('sendFailed'));
        }
    };

    const summary = (item: ReceivedItem) => decodeHtmlEntities(String(item.content || '')).replace(/\s+/g, ' ').trim() || t('shareHistoryText');

    return (
        <div className={isWide ? 'bench-wall bench-wall--wide' : 'bench-wall'}>
            <PageToolbar />
            <div className="bench-wall__body">
                {/* 左：输入源 */}
                <aside className="bench-wall__list">
                    <div className="bench-wall__list-head">
                        <MdiIcon name="mdi-inbox-arrow-down-outline" size={14} />
                        <span>{t('benchSourceTitle')}</span>
                        <span className="bench-wall__count">{items.length}</span>
                    </div>
                    <div ref={itemsRef} className="bench-wall__items">
                        {items.map((item, index) => (
                            <button
                                key={item.id}
                                type="button"
                                className={index === activeIndex ? 'bench-wall__item bench-wall__item--active' : 'bench-wall__item'}
                                onClick={() => selectIndex(index)}
                            >
                                <span className="bench-wall__item-time">{formatTimestamp(item.timestamp)}</span>
                                <span className="bench-wall__item-text">{summary(item)}</span>
                            </button>
                        ))}
                        {!items.length && <div className="bench-wall__empty">{t('benchEmpty')}</div>}
                    </div>
                </aside>

                {/* 右：输入框 + 动作链 + 结果 */}
                <section className="bench-wall__panel">
                    <textarea
                        className="bench-wall__draft"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={t('benchDraftPlaceholder')}
                        spellCheck={false}
                    />
                    {draft ? (
                        <div className="bench-wall__chain">
                            <ActionChain text={draft} onSaveAsNew={(content) => void saveAsNew(content)} />
                        </div>
                    ) : (
                        <div className="bench-wall__empty bench-wall__empty--panel">{t('benchDraftEmpty')}</div>
                    )}
                </section>
            </div>
        </div>
    );
}
