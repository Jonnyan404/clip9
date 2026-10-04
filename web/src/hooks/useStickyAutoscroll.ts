import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const STICK_TOLERANCE = 128;

/**
 * 消息流「最新在顶部」时的**吸顶自动滚动** —— 从 web-vue3/src/composables/useStickyAutoscroll.js 移植。
 *
 * 行为：
 *  - 加载 / 刷新：什么都不用做（最新的一条就在顶部）。
 *  - 切换房间：瞬时跳回顶部。
 *  - 新消息到达（条数增长）：它被**插在视口上方**。只有读者**在顶部附近**时才跟随 ——
 *    那时他就是冲着「看新来的」来的；如果他往下翻着旧内容，别把他拽回去。
 *
 * 返回的 `pinToTop()` 供 composer 用：用户自己发完消息后强制吸顶。
 */
export function useStickyAutoscroll(
    elRef: RefObject<HTMLElement | null>,
    { items, room, tolerance = STICK_TOLERANCE }: {
        items?: () => unknown[];
        room?: () => string;
        tolerance?: number;
    } = {},
) {
    const prevCountRef = useRef<number | null>(null);
    const roomValue = room ? room() : '';

    const pinToTop = useCallback((smooth = true) => {
        // 对应 Vue 版的 `nextTick`：等 DOM 更新完再滚。
        requestAnimationFrame(() => {
            const el = elRef.current;
            if (!el) return;
            try {
                el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
            } catch {
                el.scrollTop = 0;
            }
        });
    }, [elRef]);

    // 进入另一个房间 → 回到顶部（瞬时，无动画）
    useEffect(() => {
        pinToTop(false);
        prevCountRef.current = items ? items().length : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomValue]);

    const count = items ? items().length : 0;
    useEffect(() => {
        if (!items) return;
        const prev = prevCountRef.current;
        if (prev === null) {
            prevCountRef.current = count;
            return;
        }
        const el = elRef.current;
        const nearTop = el ? el.scrollTop < tolerance : false;
        if (count > prev && (prev === 0 || nearTop)) {
            pinToTop(true);
        }
        prevCountRef.current = count;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [count]);

    return { pinToTop };
}
