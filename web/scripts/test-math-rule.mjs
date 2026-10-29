// 公式判定的边界用例 —— 拿 `src/lib/markdown.js` 的**真实现**跑，不是抄一份正则。
//
//   node scripts/test-math-rule.mjs
//
// ⚠️ 为什么需要它：`$…$` 天生有歧义（价格、shell 变量、中文紧邻），而**判错的代价不对称**——
//    漏判只是公式显示成原文（还能看），误判是「一段普通中文被渲染成数学乱码」（很显眼）。
//    所以规则收紧到「结尾 `$` 后面必须是空白/标点/汉字」，这几条用例把两侧都钉住。
//
// ⚠️ 它不在 `npm run build` 里：跑一次几百毫秒，但构建门禁已经够长了。
//    改 `INLINE_MATH` / `BLOCK_MATH` / `MATH_BOUNDARY` 之后手动跑一下。

import { marked } from 'marked';
import katex from 'katex';
import { mathExtension } from '../src/lib/markdown-math.js';

marked.use(mathExtension(katex));

let failed = 0;
let passed = 0;

/** 这条文本渲染出来**是不是**公式。 */
const isMath = (src) => /class="katex/.test(marked.parse(src, { breaks: true, gfm: true }));

/** 这条文本渲染出来**是不是**行间公式（`katex-display`）。 */
const isDisplayMath = (src) => /class="katex-display/.test(marked.parse(src, { breaks: true, gfm: true }));

const cases = [
    // ── 该认的 ──────────────────────────────────────────────────────────────
    ['中文紧邻（无空格）', '质能方程$E=mc^2$成立', isMath, true],
    ['标准行内（两侧空格）', '公式 $x$ 结束', isMath, true],
    ['行尾收尾', '这一条结尾是 $x$', isMath, true],
    ['行首开始', '$x$ 开头', isMath, true],
    ['句号收尾', '答案是 $x$.', isMath, true],
    ['块公式', '$$\n\\frac{a}{b}\n$$', isDisplayMath, true],
    ['块公式（中文夹着）', '上文\n\n$$\nE=mc^2\n$$\n\n下文', isDisplayMath, true],

    // ── 不该认的（误判代价更高）────────────────────────────────────────────
    ['价格（两个 $ 夹中文）', '苹果 $5，香蕉 $3', isMath, false],
    ['shell 变量', 'echo $HOME 和 $PATH', isMath, false],
    ['行内代码', '看这段 `$x$` 代码', isMath, false],
    ['代码块', '```\n$a$\n```', isMath, false],
    ['单个 $', '只要 $ 一个', isMath, false],
    ['转义', '这不是公式 \\$x\\$', isMath, false],
];

for (const [name, src, probe, want] of cases) {
    const got = probe(src);
    if (got === want) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failed += 1;
        console.log(`  ✗ ${name}  实际=${got} 期望=${want}`);
    }
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
