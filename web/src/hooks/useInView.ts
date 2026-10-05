import { useEffect, useRef, useState } from 'react';

/**
 * 「这个元素进过视口了吗」—— **进去过就一直是真**（一次性，不会退回去）。
 *
 * ⚠️★ 为什么是「一次性」而不是实时跟随：调用方拿它来**跳过屏外条目的重活**
 * （markdown 动作链 + 二次重渲染，见 `useMarkdown` 的 `enabled`）。如果滚出去就变回 false，
 * 那条内容会退回原文、滚回来再算一遍 —— 用户看到的是内容闪来闪去。
 * 「算过就留着」只省「还没算过」的那些，正是我们要省的。
 *
 * ⚠️ 默认提前 `200px` 就开算：滚到时结果已经在了，看不出延迟。
 * ⚠️ 没有 `IntersectionObserver`（很老的浏览器 / 测试环境）时**直接当成可见** ——
 * 宁可多算，也不要让内容永远停在原文上。
 */
export function useInView<T extends Element>(rootMargin = '200px') {
    const ref = useRef<T | null>(null);
    const [inView, setInView] = useState(false);

    useEffect(() => {
        if (inView) {
            return;
        }
        const el = ref.current;
        if (!el) {
            return;
        }
        if (typeof IntersectionObserver === 'undefined') {
            setInView(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setInView(true);
                    observer.disconnect();
                }
            },
            { rootMargin },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [inView, rootMargin]);

    return { ref, inView };
}
