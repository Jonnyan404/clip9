import { useEffect, useRef } from 'react';
import { highlightCodeBlocksIn } from '@/lib/highlight.js';
import { fitDisplayMathIn } from '@/lib/fit-math.js';

/**
 * markdown 渲染结果的展示层 —— 从 web-vue3/src/components/MarkdownBody.vue 移植。
 *
 * ⚠️ `html` 必须已经过 DOMPurify（见 `lib/markdown.js` 的 `renderMarkdownHtml`）。
 * ⚠️ 上色那一步在 `lib/highlight.js`（桌面端画的是同一段 HTML，那边是唯一实现，两边共用）：
 *    marked 的 renderer 是同步的，而高亮器是 `import()` 按需加载的 —— 在 renderer 里 await 不了。
 *    所以先照常渲染，再把代码块找出来上色。
 */
export function MarkdownBody({ html }: { html: string }) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) {
            return;
        }
        void highlightCodeBlocksIn(root);

        // 块公式缩到容器宽度以内（窄卡片里否则会出横向滚动条，见 `lib/fit-math.js`）。
        fitDisplayMathIn(root);
        // ⚠️★ KaTeX 的字体是**异步**加载的：字体没就位时量出来的宽度偏小，会缩不够（或不必缩却缩了）。
        //    `fonts.ready` 之后重量一次。它是个 Promise，且在不支持的老 WebView 上是 undefined。
        void document.fonts?.ready.then(() => fitDisplayMathIn(root)).catch(() => {});

        // 容器宽度变了（旋转屏幕、拖窗口、切模式、便签列数变化）要重算。
        // ⚠️ 只看**宽度**：我们改 font-size 会改高度，拿高度当判据会和自己的缩放互相触发。
        let lastWidth = root.clientWidth;
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width ?? 0;
            if (Math.abs(width - lastWidth) < 1) {
                return;
            }
            lastWidth = width;
            fitDisplayMathIn(root);
        });
        observer.observe(root);

        return () => observer.disconnect();
    }, [html]);

    return <div ref={rootRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
