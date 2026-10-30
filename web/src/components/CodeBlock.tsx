import { useEffect, useRef, useState } from 'react';
import { colorizePlain, highlightCode } from '@/lib/highlight.js';

/**
 * 代码块 —— 从 web-vue3/src/components/CodeBlock.vue 移植。
 * 按文件名（扩展名）选语言高亮；认不出来就**不猜**，走语言无关的通用着色。
 *
 * ⚠️ 竞态：换文件时上一次高亮可能还在飞（高亮器是动态 import 的）。用自增序号挡住 ——
 * 回来时序号已经不是当前那次就丢掉，否则会出现「B 的正文配 A 的高亮」。
 */
export function CodeBlock({ text, name }: { text: string; name?: string }) {
    const [html, setHtml] = useState('');
    const seqRef = useRef(0);

    useEffect(() => {
        const mine = ++seqRef.current;
        setHtml('');
        if (!text) {
            return;
        }
        let cancelled = false;
        void (async () => {
            const result = await highlightCode(text, name || '');
            if (!cancelled && mine === seqRef.current) {
                // ⚠️ 认不出语言（按文件名判断）就**不猜**，走语言无关的通用着色 ——
                //    与 md 里那些没写语言的代码块同一个实现，别在两处各留一条「纯文本」的路。
                setHtml(result || colorizePlain(text));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [text, name]);

    return (
        <pre className="code-block">
            {html
                // highlight.js 自己会转义输入，所以这样是安全的；不要再往上拼任何未转义内容。
                ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
                : <code>{text}</code>}
        </pre>
    );
}
