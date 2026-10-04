import { useEffect, useRef } from 'react';
import { highlightCodeBlocksIn } from '@/lib/highlight.js';

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
        void highlightCodeBlocksIn(rootRef.current);
    }, [html]);

    return <div ref={rootRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
