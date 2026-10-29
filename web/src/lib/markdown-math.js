// markdown → HTML，**带数学公式**（`$…$` / `$$…$$`）。
//
// 为什么和 `markdown.js` 分成两个文件：桌面端的动作实现包（`actions/desktop.js`）用
// esbuild 打包，而它**不接公式**（理由见那个文件）。拆开之后 `desktop.js` 不导出
// `runMarkdown` ⇒ 这个模块整个被 tree-shake 掉，桌面包里一个 katex 字节都没有。
// 合在一起时 esbuild 摇不掉 —— `import('katex')` 被视为副作用，字体和 CSS 全进包。
//
// ⚠️ 两个文件共用同一个 `marked` 实例，所以 `marked.use()` 注册的扩展是**全局**的：
//    网页版一旦加载过公式，`markdown.js` 的同步渲染也会走它。这是想要的（同一个页面）。
import { marked } from 'marked';
import { renderMarkdownHtml } from './markdown.js';

// ── 数学公式（`$…$` / `$$…$$`）──────────────────────────────────────────────
//
// ⚠️★ KaTeX **按需加载**，照 `lib/highlight.js` 的先例走 `import()`：打包器会把它切成
//    一个独立 chunk（77 KB gzip + 20 个 woff2 字体），从不看公式的人一个字节都不付。
//    主路径是「收发剪贴板」，绝大多数内容里根本没有公式。
//
// ⚠️★ 但加载时机和高亮**相反**：高亮是「渲染完回头补」，因为它的失败模式只是「没颜色」；
//    公式的失败模式是「屏幕上全是 `$E=mc^2$` 原文」，那等于没做。所以这里 await 一下，
//    宁可让那一次渲染慢几十毫秒。
//
// ⚠️ 加载失败**不抛**：拉不到 chunk（离线、旧版缓存）就照原样渲染，用户看到的是
//    `$E=mc^2$` 的原文，而不是一个坏掉的预览 —— 与「失败可降级」一致。
//
// ⚠️ 判断「要不要加载」用 `MATH_HINT`，不是 `text.includes('$')`：价格、shell 变量里
//    到处是 `$`，那样会让一大票纯文本白下载 77 KB。
const MATH_HINT = /\$\$|\$[^$\n]+\$/;

// ⚠️★ 为什么**没有**用 marked-katex-extension：它在「结尾 `$` 后面跟什么」这件事上
//    只有两档，而这两档对本项目都不合适 ——
//      · 标准模式要求后面是空白或标点 → 中文里 `质能方程$E=mc^2$成立` **一条都认不出来**
//        （中文和 `$` 之间通常不打空格）；
//      · `nonStandard: true` 什么都不要求 → `苹果 $5，香蕉 $3`、`$HOME 和 $PATH`
//        都会被吞成公式，中文还会被塞进 math mode（KaTeX 刷一串 unicodeTextInMathMode 警告）。
//    这里的规则是第三档：**空白 / 标点 / 汉字** 都算公式结束，**字母数字不算**。
//    于是中文紧邻的公式能用，价格和 shell 变量不会被误吞。
//    判定规则只有下面四个正则，比读一个第三方包的实现更直接。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const MATH_BOUNDARY = /[\s?!.,:;、，。：；？！)\]}>】」』"'’”]/;
// 内容里不允许裸 `$` 和换行；`\$` 转义算内容。
const INLINE_MATH = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\1/;
// 块公式：`$$` 单独一行开头、单独一行结尾（与 CommonMark 的围栏代码块同一个形状）。
const BLOCK_MATH = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

/**
 * 公式扩展。`katex` 是**传进来**的 —— 它属于那个懒加载的 chunk，不能在这里静态 import。
 *
 * ⚠️ 导出是为了让 `scripts/test-math-rule.mjs` 能拿**真实现**测边界（价格 / shell 变量 /
 *    中文紧邻 / 行内代码），而不是在测试里抄一份正则 —— 抄的那份改了不会红。
 */
export function mathExtension(katex) {
    const render = (tex, displayMode) =>
        katex.renderToString(tex, {
            displayMode,
            // 渲染失败把 TeX 原文留在原地，而不是抛一个红框。
            throwOnError: false,
            // ⚠️★ `output: 'html'` 是**故意的**，不是省事：
            //    默认的 `htmlAndMathml` 会多吐一份 MathML，而 `renderMarkdownHtml` 的清洗是
            //    `USE_PROFILES: { html: true }` —— 那份 MathML 会被剥掉（实测 1160 → 945 字节）。
            //    留着它既进不了 DOM，又要为它放开 MathML profile（`<annotation-xml>` 是历史
            //    XSS 通道）。只用 html 那份：实测清洗前后 1159 → 1159 字节，class/style/span
            //    全保留 —— **清洗规则一个字都不用改**。
            output: 'html',
        });

    return {
        extensions: [
            {
                name: 'blockMath',
                level: 'block',
                tokenizer(src) {
                    const m = BLOCK_MATH.exec(src);
                    if (!m) return;
                    return { type: 'blockMath', raw: m[0], text: m[2].trim(), displayMode: m[1].length === 2 };
                },
                renderer: (token) => `${render(token.text, token.displayMode)}\n`,
            },
            {
                name: 'inlineMath',
                level: 'inline',
                start(src) {
                    const at = src.indexOf('$');
                    return at < 0 ? undefined : at;
                },
                tokenizer(src) {
                    const m = INLINE_MATH.exec(src);
                    if (!m) return;
                    // ⚠️★ 这一行就是整件事的关键：结尾 `$` 后面紧跟字母/数字时**不当公式**。
                    //    `$5`、`$HOME`、`$PATH`、`a$b$c` 都靠它挡住。
                    const next = src.charAt(m[0].length);
                    if (next && !MATH_BOUNDARY.test(next) && !CJK.test(next)) return;
                    return { type: 'inlineMath', raw: m[0], text: m[2].trim(), displayMode: m[1].length === 2 };
                },
                renderer: (token) => render(token.text, token.displayMode),
            },
        ],
    };
}

let mathLoading = null;

/** 加载并注册公式扩展。**只注册一次**（`marked.use` 是全局的）。 */
function ensureMath() {
    if (mathLoading) {
        return mathLoading;
    }
    mathLoading = (async () => {
        try {
            const [katex] = await Promise.all([
                import('katex'),
                // ⚠️ CSS 也走动态 import：20 个 woff2 字体是它引出来的，
                //    静态引入等于让「从不看公式的人」在首屏付这份钱。
                //    它挂了只影响观感，所以单独 catch —— 不该连累渲染本身。
                import('katex/dist/katex.min.css').catch(() => null),
            ]);
            marked.use(mathExtension(katex.default ?? katex));
            return true;
        } catch {
            return false;
        }
    })();
    return mathLoading;
}

/**
 * 渲染 markdown，**支持公式**。只有可能含 `$` 的路径才该走这个 —— 它可能是异步的。
 *
 * @param {string} text
 * @param {object} [opts] 同 `renderMarkdownHtml`
 * @returns {Promise<string>} 已清洗的 HTML
 */
export async function renderMarkdownHtmlAsync(text, opts = {}) {
    const source = String(text || '');
    if (MATH_HINT.test(source)) {
        await ensureMath();
    }
    return renderMarkdownHtml(source, opts);
}
