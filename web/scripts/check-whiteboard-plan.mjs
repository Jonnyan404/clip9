#!/usr/bin/env node
// 白板映射器（`src/lib/whiteboard/markdown-plan.ts`）的自检 —— 纯 Node，不需要浏览器、不需要构建。
//
//     cd web && node scripts/check-whiteboard-plan.mjs
//
// ⚠️★ 为什么能直接跑 `.ts`：Node ≥ 22.18 **默认剥离类型**，于是这个模块可以原样 import
// （它只用了可擦除的语法：没有 enum、没有 namespace、没有参数属性，类型导入一律 `import type`）。
// 这条**必须留着** —— 它是这个模块「可测」的唯一保证。哪天有人往 `markdown-plan.ts` 里
// 加了 enum，这个脚本会当场炸，而不是静默变成「测不了」。
//
// 为什么值得有它：布局是**纯数字**，而纯数字错了不会报错 —— 只会让画布上两个块叠在一起、
// 或者子树被摆到屏幕外面。这两件事在浏览器里都**看不出来是 bug**（看起来就像「用户自己拖的」）。
//
// ⚠️ 断言的是**性质**，不是具体坐标：
//   · 兄弟不重叠、子在父右边、包围盒装得下所有块 —— 换一种布局算法，这些仍然该成立；
//   · 反过来，如果把断言写成「标题在 (0,0)」，那调一下间距就会红一片，
//     于是下一个人会去改断言而不是想清楚 —— 那种测试不如没有。

import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { markdownToPlan, stripInline, estimateTextWidth } from '../src/lib/whiteboard/markdown-plan.ts';

const problems = [];
let checks = 0;

function check(label, condition, detail = '') {
    checks += 1;
    if (!condition) {
        problems.push(`${label}${detail ? `\n      ${detail}` : ''}`);
    }
}

/** 两段纵向区间是否重叠（用于「兄弟不叠」那条）。 */
const overlaps = (a, b) => a.y < b.y + b.height && b.y < a.y + a.height;

// ── 1. 空输入 ─────────────────────────────────────────────────────────

{
    const plan = markdownToPlan('');
    check('空输入回空蓝图（不抛异常）', plan.nodes.length === 0 && plan.edges.length === 0);
    const blanks = markdownToPlan('   \n\n  \n');
    check('只有空白的输入也是空蓝图', blanks.nodes.length === 0);
}

// ── 2. 结构：标题层级 / 列表嵌套 / 卡片 ────────────────────────────────

{
    const plan = markdownToPlan(
        [
            '# 一级',
            '',
            '## 二级',
            '',
            '- 甲',
            '- 乙',
            '  - 乙一',
            '',
            '### 三级',
            '',
            '一段正文。',
            '',
            '```js',
            'const a = 1;',
            '```',
            '',
            '| 列一 | 列二 |',
            '| --- | --- |',
            '| a | b |',
        ].join('\n'),
    );

    const byText = (text) => plan.nodes.find((n) => n.text === text);
    const root = byText('一级');
    const second = byText('二级');
    const third = byText('三级');

    check('标题都成了块', !!root && !!second && !!third);
    check('`#` 的深度是 0', root?.depth === 0, `实际 ${root?.depth}`);
    check('`##` 的深度是 1', second?.depth === 1, `实际 ${second?.depth}`);
    check('`###` 的深度是 2', third?.depth === 2, `实际 ${third?.depth}`);

    check('`##` 挂在 `#` 下面', second && root?.children.includes(second));
    check('`###` 挂在 `##` 下面（不是挂在 `#` 下面）', third && second?.children.includes(third));

    const jia = byText('甲');
    const yi = byText('乙');
    const yiYi = byText('乙一');
    check('列表项成了块', !!jia && !!yi && !!yiYi);
    check('嵌套列表项挂在父项下面', yiYi && yi?.children.includes(yiYi));
    check(
        '嵌套项比父项深一级',
        yiYi && yi && yiYi.depth === yi.depth + 1,
        `${yi?.depth} → ${yiYi?.depth}`,
    );

    check('段落成了卡片', plan.nodes.some((n) => n.kind === 'card' && n.text.includes('一段正文')));
    const code = plan.nodes.find((n) => n.note.includes('js'));
    check('代码块成了卡片，且标出语言', !!code, `note 里没有 js：${code?.note}`);
    const table = plan.nodes.find((n) => n.text === '表格');
    check('表格成了卡片', !!table, '没找到表格块');
    check(
        '表格卡片说清了尺寸（2 列 × 2 行）',
        table?.note.includes('2 列') && table?.note.includes('2 行'),
        `实际：${table?.note}`,
    );

    check('每个非根块都有一条连线', plan.edges.length === plan.nodes.length - 1,
        `nodes=${plan.nodes.length} edges=${plan.edges.length}`);
    check(
        '每条连线的两端都在 nodes 里',
        plan.edges.every((e) => plan.nodes.includes(e.from) && plan.nodes.includes(e.to)),
    );
}

// ── 3. 布局性质（不锁死具体坐标）──────────────────────────────────────

{
    const plan = markdownToPlan(
        ['# 根', '', '- 甲', '- 乙', '- 丙', '', '## 子一', '', '## 子二'].join('\n'),
    );

    // ① 同一父下的兄弟不纵向重叠
    const siblingClash = [];
    const walk = (node) => {
        for (let i = 0; i < node.children.length; i += 1) {
            for (let j = i + 1; j < node.children.length; j += 1) {
                if (overlaps(node.children[i], node.children[j])) {
                    siblingClash.push(`${node.text} → ${node.children[i].text} / ${node.children[j].text}`);
                }
            }
            walk(node.children[i]);
        }
    };
    for (const node of plan.nodes.filter((n) => n.depth === 0)) {
        walk(node);
    }
    check('兄弟节点纵向不重叠', siblingClash.length === 0, siblingClash.join('；'));

    // ② 子节点在父节点右边（横向树的定义）
    const backwards = plan.edges.filter((e) => e.to.x <= e.from.x);
    check('子节点一律在父节点右边', backwards.length === 0,
        backwards.map((e) => `${e.from.text}→${e.to.text}`).join('；'));

    // ③ 同一深度的块左边缘对齐（列对齐）
    const byDepth = new Map();
    for (const node of plan.nodes) {
        byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node.x]);
    }
    const misaligned = [...byDepth.entries()].filter(([, xs]) => new Set(xs).size > 1);
    check('同一深度的块左边缘对齐', misaligned.length === 0,
        misaligned.map(([d, xs]) => `深度 ${d}: ${[...new Set(xs)].join(',')}`).join('；'));

    // ④ 包围盒装得下所有块，而且从 (0,0) 起
    check(
        '包围盒装得下所有块',
        plan.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + n.width <= plan.width + 0.001 && n.y + n.height <= plan.height + 0.001),
        `bbox=${plan.width}×${plan.height}`,
    );
    check(
        '包围盒从原点开始（调用方不用再算偏移）',
        Math.min(...plan.nodes.map((n) => n.x)) === 0 && Math.min(...plan.nodes.map((n) => n.y)) === 0,
    );
    check('每个块的宽高都是正数', plan.nodes.every((n) => n.width > 0 && n.height > 0));
}

// ── 4. 行内标记：剥掉成对的，留下落单的 ────────────────────────────────

{
    check('剥掉加粗', stripInline('**重点**') === '重点');
    check('剥掉斜体', stripInline('*斜*') === '斜');
    check('剥掉行内代码', stripInline('`code`') === 'code');
    check('剥掉删除线', stripInline('~~删~~') === '删');
    check('链接只留文字', stripInline('[文字](https://a.com)') === '文字');
    check('图片只留 alt', stripInline('![图](https://a.com/x.png)') === '图');

    // ⚠️★ 这两条是**防止「悄悄改内容」**的：落单的星号必须原样留着。
    // 吃掉它会让 `2 * 3 = 6` 变成 `2 3 = 6` —— 那是改了用户的内容，比留个星号糟得多。
    check('落单的星号原样留着', stripInline('2 * 3 = 6') === '2 * 3 = 6', stripInline('2 * 3 = 6'));
    check('落单的下划线原样留着', stripInline('file_name_here') === 'file_name_here');
}

// ── 5. 宽度估算：中日韩按两倍 ─────────────────────────────────────────

{
    const latin = estimateTextWidth('abcd', 16);
    const cjk = estimateTextWidth('中文', 16);
    check('4 个拉丁字符与 2 个汉字宽度相当', Math.abs(latin - cjk) <= 1, `${latin} vs ${cjk}`);
    check('宽度随字号线性变化', Math.abs(estimateTextWidth('abcd', 32) - latin * 2) <= 1);
    check('空串宽度是 0', estimateTextWidth('', 16) === 0);
}

// ── 6. 认不出的内容不许静默丢 ─────────────────────────────────────────

{
    // 引用块里的内容要**接上来**，不能因为「引用是个不认识的块」就整段消失。
    const plan = markdownToPlan('> 被引用的一句话\n\n# 后面的标题\n');
    check(
        '引用块的内容不会消失',
        plan.nodes.some((n) => n.text.includes('被引用的一句话')),
        `拿到的块：${plan.nodes.map((n) => n.text).join(' / ')}`,
    );
    check('引用后面的标题照常处理', plan.nodes.some((n) => n.text === '后面的标题'));

    // 列表项里的代码块也要接上来（只读 `item.text` 会丢掉它）。
    const nested = markdownToPlan('- 一项\n\n  ```py\n  x = 1\n  ```\n');
    check(
        '列表项里的代码块不会消失',
        nested.nodes.some((n) => n.note.includes('py')),
        `拿到的块：${nested.nodes.map((n) => `${n.text}[${n.note}]`).join(' / ')}`,
    );
}

// ── 7. 没有标题时也要能铺 ─────────────────────────────────────────────

{
    const plan = markdownToPlan('就一句话，没有任何标题。');
    check('没有标题的文档也能铺出一个块', plan.nodes.length === 1 && plan.nodes[0].depth === 0);
    check('单块蓝图的包围盒等于块本身',
        plan.width === plan.nodes[0].width && plan.height === plan.nodes[0].height);
}

// ── 8. 懒加载的**下载**侧：白板 chunk 不许进 PWA 预缓存 ─────────────────
//
// ⚠️★ 这一节是「白板懒加载」这件事**唯一**的牙，别删。
//
// `React.lazy` 只保证**执行**推迟，**不保证下载推迟** —— 下载推迟靠的是
// 「不进预缓存 + 用到才 fetch」。而 vite-plugin-pwa 的 `globPatterns` 默认会把
// `dist/assets/` 下**所有** js/css 都塞进预缓存，包括懒加载的那些。
// 于是「只在白板 mode 才加载」会被**一笔勾销**：每个人第一次访问都在后台把它下完，
// 而且每次发版（hash 变了）都要重下。
//
// ⚠️ 这个坑的可怕之处在于**构建产物看起来完全正常** —— 没有报错、没有警告，
// 只是每个人多下几 MB。所以只能靠这条判据。
//
// ⚠️ 没构建过就**跳过**（不是判红）：这一步在 `npm run build` 之前跑是完全合法的，
// 而「因为没构建所以判红」会逼着下一个人去绕过它。
{
    const swPath = new URL('../dist/sw.js', import.meta.url);
    if (!existsSync(swPath)) {
        console.log('  － 还没构建过（dist/sw.js 不在），跳过预缓存那条判据');
    } else {
        const sw = readFileSync(swPath, 'utf8');
        check(
            '白板 chunk 不在 PWA 预缓存清单里（否则懒加载的「下载推迟」失效）',
            !/whiteboard-[A-Za-z0-9_-]+\.(js|css)/.test(sw),
            'sw.js 里出现了 whiteboard-*：检查 vite.config.ts 的 globIgnores 与 manualChunks',
        );
    }
}

// ── 9. 白板的界面语言必须跟着 clip9 的 locale 走 ────────────────────────
//
// ⚠️★ 这一条是 2026-10-10 补的。Excalidraw 的界面（工具栏提示、右键菜单、
// 形状面板、快捷键面板）**自带完整的中文译文**（`zh-CN` / `zh-TW` 都是 100%），
// 但它默认跟的是 `navigator.language` —— 不显式传 `langCode` 的话，
// 用户把 clip9 切成中文、浏览器是英文时，白板会**中英混排**，而两边都不报错。
//
// 这里钉的是**映射的完整性**：我们的每份语言文件都要在 `LANG_CODE` 里有一项。
// 加了第 5 种语言却忘了加映射 → 那条语言的白板界面会静默退回英文。
//
// ⚠️ 为什么静态读源码而不是 import：`ExcalidrawSurface.tsx` 顶部 import 了
// `@excalidraw/excalidraw`（要 React / DOM），纯 node 里跑不起来。
{
    const surfacePath = new URL('../src/components/whiteboard/ExcalidrawSurface.tsx', import.meta.url);
    const localesDir = new URL('../src/i18n/locales/', import.meta.url);
    const ourLocales = readdirSync(localesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));

    const source = readFileSync(surfacePath, 'utf8');
    const block = /const LANG_CODE: Record<string, string> = \{([\s\S]*?)\}/.exec(source);
    const mapped = block
        ? [...block[1].matchAll(/^\s*(?:'([^']+)'|([A-Za-z-]+))\s*:/gm)].map((m) => m[1] ?? m[2])
        : [];

    const missing = ourLocales.filter((l) => !mapped.includes(l));
    check(
        `每种语言都有 Excalidraw 的 langCode 映射（${ourLocales.length} 种：${ourLocales.join(' / ')}）`,
        block !== null && missing.length === 0,
        block === null ? 'ExcalidrawSurface.tsx 里找不到 LANG_CODE' : `缺 ${missing.join(', ')}`,
    );
    // ⚠️ 顺带确认它真的被传下去了 —— 映射写全了但没传，等于没做。
    check(
        'ExcalidrawSurface 真的拿到了 locale',
        /locale=\{i18n\.language\}/.test(readFileSync(new URL('../src/modes/CanvasWall.tsx', import.meta.url), 'utf8')),
        'CanvasWall 没有把 locale 传给 ExcalidrawSurface',
    );
}

// ── 10. 白板文档的序列化：写得对、读得宽松 ──────────────────────────────
//
// ⚠️★ 这一节盯的是「保存出去的白板，别人（或别的 Excalidraw）打得开吗」。
// 写错的症状是**静默的**：文件存下来了、大小也对，只是任何地方都打不开。
//
// ⚠️ 读的那一侧要**宽松**（判据里那几条「认不出就回 null」），
// 但**不能只 catch JSON.parse** —— 一份合法的 JSON（`{"hello":1}`）会解析成功，
// 然后 `elements` 是 undefined，画布被清空而**用户以为加载成功了**。
{
    const doc = await import('../src/lib/whiteboard/document.ts');

    // 写出去的东西必须是 Excalidraw 认的形状
    const payload = JSON.parse(doc.serializeWhiteboard([{ id: 'a' }], {}, '#fff'));
    check('序列化出来的 type 是 excalidraw（少了它哪都打不开）', payload.type === 'excalidraw', `实际 ${payload.type}`);
    check('带 schema 版本号', payload.version === 2, `实际 ${payload.version}`);
    check('elements 是数组', Array.isArray(payload.elements) && payload.elements.length === 1);
    check('appState 里带了背景色', payload.appState?.viewBackgroundColor === '#fff');
    check('不缩进（画布 JSON 很容易上 MB，缩进会让体积翻几倍）', !doc.serializeWhiteboard([{}]).includes('\n  '));

    // ⚠️★ 图片资源**必须**一起存：图片元素只带一个 fileId，字节在 `files` 里。
    // 不存它的话重开时那些元素会渲染成一堆占位框，而**白板 JSON 本身完全合法**。
    const withFiles = { 'clip9-img-0': { id: 'clip9-img-0', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA', created: 1 } };
    const saved = doc.parseWhiteboard(doc.serializeWhiteboard([{ id: 'img', fileId: 'clip9-img-0' }], withFiles));
    check('图片资源跟着存下来了', saved?.files?.['clip9-img-0']?.mimeType === 'image/png', JSON.stringify(saved?.files));
    check('没有图片时 files 是空对象（不是 undefined）', JSON.stringify(doc.parseWhiteboard(doc.serializeWhiteboard([{}]))?.files) === '{}');
    check(
        '老文件缺 files 也能读（回空对象，不是崩）',
        JSON.stringify(doc.parseWhiteboard('{"type":"excalidraw","elements":[]}')?.files) === '{}',
    );

    // 往返
    const back = doc.parseWhiteboard(doc.serializeWhiteboard([{ id: 'x' }], {}, '#123456'));
    check('往返之后元素还在', back?.elements?.length === 1 && back.elements[0].id === 'x');
    check('往返之后背景色还在', back?.viewBackgroundColor === '#123456');

    // 读得宽松：认不出的都要回 null，**不能**回一个空画布
    check('坏 JSON → null', doc.parseWhiteboard('{not json') === null);
    check('合法 JSON 但不是白板 → null', doc.parseWhiteboard('{"hello":1}') === null);
    check('type 对但 elements 不是数组 → null', doc.parseWhiteboard('{"type":"excalidraw","elements":"nope"}') === null);
    check('空串 → null', doc.parseWhiteboard('') === null);
    check('缺 appState 也能读（老文件可能没有）', doc.parseWhiteboard('{"type":"excalidraw","elements":[]}')?.viewBackgroundColor === 'transparent');

    // 文件名
    check('认 .excalidraw（大小写都认）', doc.isWhiteboardName('a.EXCALIDRAW') && doc.isWhiteboardName('b.excalidraw'));
    check('不认别的文件', !doc.isWhiteboardName('a.png') && !doc.isWhiteboardName(undefined) && !doc.isWhiteboardName(''));
    const name = doc.whiteboardFileName('白板', new Date(2026, 9, 10, 21, 5));
    check('文件名带本地时间戳', name === '白板-20261010-2105.excalidraw', name);
    check(
        '前缀里的空格与斜杠被换掉（文件名会进 URL）',
        doc.whiteboardFileName('a b/c:d', new Date(2026, 0, 1, 0, 0)) === 'a-b-c-d-20260101-0000.excalidraw',
        doc.whiteboardFileName('a b/c:d', new Date(2026, 0, 1, 0, 0)),
    );
    check('空前缀有兜底', doc.whiteboardFileName('   ', new Date(2026, 0, 1, 0, 0)).startsWith('canvas-'));
}

// ── 汇总 ──────────────────────────────────────────────────────────────

if (problems.length) {
    console.error(`✗ 白板映射器自检没过（${problems.length} / ${checks} 条）：\n`);
    for (const p of problems) {
        console.error(`  ✗ ${p}`);
    }
    process.exit(1);
}
console.log(`✓ 白板映射器自检通过（${checks} 条判据）。`);
