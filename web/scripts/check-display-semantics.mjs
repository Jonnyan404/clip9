#!/usr/bin/env node
// 显示语义的契约检查（纯 Node，不需要浏览器、不需要起服务）。
//
//     cd web && node scripts/check-display-semantics.mjs        # 查源码 + 已构建产物
//     cd web && node scripts/check-display-semantics.mjs --src  # 只查源码（没构建过也能跑）
//
// 为什么需要它：这几条约定**跨文件、跨界面**，而且改错了都不报错 —— 只会静默退化：
//   1. 「默认看原文还是渲染视图」全站只有一份判断（`src/lib/util.ts` 的 prefersRenderedView），
//      标准 / 便签 / 速览 / 看板都走它 —— 各写一套的话同一条内容在不同界面长相不同；
//   1b. 默认渲染的那几种必须**同时**过 looksLikeMarkdown —— 否则图标不出现，
//      那条「默认渲染」根本走不到（渲染路径上还有一道 looksLikeMarkdown 的闸）；
//   2. 那个开关的**名字**必须说它真管的东西（动作图标），不能还叫「Markdown 切换」；
//      它的 labelKey 还要在四份语言文件里都在（漏一份就显示成 key 本身）；
//   3. 消费点（useMarkdown）必须复用那一份判断，不许自己再拼一套；
//   4. 输入框粘文件时必须**拦下浏览器的默认粘贴行为**，而且只在该拦的时候拦：
//      漏了它 → 文件名会落进输入框；无条件拦 → 纯文本粘贴被吞掉。两个输入组件各有一份；
//   5. 快捷指令更新时间轴的日期清单是**人工维护**的（`shortcuts/history.json`）——
//      顺序写反 / 写重复 / 平台名打错都不会报错，只会让时间轴显示得莫名其妙。
//
// ⚠️★ 这个文件是 `web-vue3/scripts/check-display-semantics.mjs` 的**后继**：
// 2026-10-04 起生产前端是 `web/`（React 版），`web-vue3/`（Vue 版）不再构建、不再入库，
// 而那份脚本盯的是**不再发货的源码** —— 修好它只能得到「有保护」的假信号
// （同一个坑：它还 import 了 `util.js` → axios，于是 CI 上必挂，见 ci.yml 那一步的注释）。
// 判据跟着**在跑的那份代码**走，所以这里读的是 `web/src`。
//
// ⚠️★ 这个脚本要能在**纯 Node** 里跑，所以：
//   · `prefersRenderedView` 住在 `src/lib/util.ts`（TS，还 import 了 `./base`）—— 导入不了，
//     这里把它的**函数体原样抠出来真跑**（判据 1），既跑的是发货的那份实现，
//     又不用为它装任何依赖；抠不到 / 跑不动都会**判红**，不是静默跳过；
//   · 能直接 import 的那两个模块（`data/displayToggles.js`、`lib/actions/pure.js`）
//     都是**零 import** 的普通 ESM —— 它们本来就要被桌面端加载（见 tools/sync-action-catalog.mjs）。
//
// 断言的是**语义**，不是实现：prefersRenderedView 里换一种写法、把几条正则合并，
// 只要答案不变，这个脚本就该继续绿。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const REPO = resolve(WEB, '..');

// 零 import 的两个模块：可以直接 import（它们本来就要被桌面端原样加载）。
const { looksLikeMarkdown, looksLikeTable, looksLikeTaskList } = await import(
    new URL('../src/lib/actions/pure.js', import.meta.url).href
);
const { DISPLAY_TOGGLES, DEFAULT_DISPLAY } = await import(
    new URL('../src/data/displayToggles.js', import.meta.url).href
);

let failed = 0;
function ok(name, condition, detail = '') {
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail && !condition ? `  → ${detail}` : ''}`);
    if (!condition) failed += 1;
}

/** 从源码里抠出一段函数体（花括号配平）。`function name(` / `const name = (` 两种写法都认。
 *
 *  ⚠️ 只在声明之后 200 字符内找 `=> {`：TS 的类型注解里也可能出现 `{`，
 *  而全文件搜 `=>` 会撞上后面某个箭头函数，判据就盯错地方了。 */
function functionBody(source, declaration) {
    const at = source.indexOf(declaration);
    if (at < 0) return null;
    const head = source.slice(at, at + 200);
    let open = source.indexOf('{', at);
    const arrow = head.indexOf('=>');
    if (arrow >= 0 && at + arrow < open) open = source.indexOf('{', at + arrow);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    return null;
}

// ── 1. 默认视图：只有「结构化内容」默认渲染 ────────────────────────────
//
// ⚠️ 这里跑的是 `src/lib/util.ts` 里**那一份**实现：把函数体抠出来、把 pure.js 的两个
// 谓词注入进去执行。所以它真能盯住「util.ts 改了规则」这件事（而不是盯一份抄过来的表）。
const utilSource = readFileSync(join(WEB, 'src/lib/util.ts'), 'utf8');
const prefersBody = functionBody(utilSource, 'function prefersRenderedView(');
ok('util.ts 里找得到 prefersRenderedView', Boolean(prefersBody));

let prefersRenderedView = null;
if (prefersBody) {
    try {
        const compiled = new Function(
            'text',
            'looksLikeTaskList',
            'looksLikeTable',
            'looksLikeMarkdown',
            prefersBody,
        );
        // ⚠️ 抠出来的体里若引用了没注入的标识符，下面这一行就会 ReferenceError —— 那样要红，不是跳过。
        const probe = compiled('# 标题', looksLikeTaskList, looksLikeTable, looksLikeMarkdown);
        if (typeof probe !== 'boolean') throw new Error(`返回值是 ${typeof probe}，不是 boolean`);
        prefersRenderedView = (text) => compiled(text, looksLikeTaskList, looksLikeTable, looksLikeMarkdown);
    } catch (error) {
        ok('抠出来的 prefersRenderedView 跑得动', false, String(error));
    }
}

const CASES = [
    // [内容, 默认该渲染吗, 说明]
    ['- [ ] 买牛奶\n- [x] 写周报', true, '任务列表'],
    ['1. [ ] 有序任务列表', true, '有序任务列表'],
    ['| a | b |\n| --- | --- |\n| 1 | 2 |', true, 'GFM 表格'],
    ['# 标题', false, '普通 markdown 默认原文'],
    ['**加粗** 和 `inline code`', false, '行内标记默认原文'],
    ['- 普通列表项', false, '普通无序列表默认原文'],
    ['5 * 3 = 15', false, '普通文本不能被误判成 markdown'],
    ['这是一句普通的话', false, '中文普通文本'],
    ['见 https://example.com/a_b_c', false, '裸链接'],
];
if (prefersRenderedView) {
    for (const [text, expected, label] of CASES) {
        let got = null;
        try {
            got = Boolean(prefersRenderedView(text));
        } catch (error) {
            ok(`prefersRenderedView 跑得动：${label}`, false, String(error));
            continue;
        }
        ok(`prefersRenderedView: ${label} → ${expected ? '渲染' : '原文'}`, got === expected, JSON.stringify(text.slice(0, 30)));
    }

    // 默认渲染的那几种，必须**同时**过 looksLikeMarkdown —— 否则图标不出现，
    // 那条「默认渲染」根本走不到（渲染路径上还有一道 looksLikeMarkdown 的闸）。
    for (const [text, expected, label] of CASES) {
        if (!expected) continue;
        ok(`默认渲染的内容也拿得到图标: ${label}`, looksLikeMarkdown(text), JSON.stringify(text.slice(0, 30)));
    }
}

// ── 2. 动作图标开关：名字与语言文件 ──────────────────────────────────
const toggle = DISPLAY_TOGGLES.find((item) => item.key === 'markdown');
ok('存储键仍是 markdown（改名要迁移用户已存配置）', Boolean(toggle));
ok('labelKey 已改成 actionIcons', toggle?.labelKey === 'actionIcons', String(toggle?.labelKey));
ok('默认开着（关了等于升级后功能消失）', DEFAULT_DISPLAY.markdown === true);
ok(
    '两个模式都露面，且只有这两个（面板是「每模式一组开关」）',
    JSON.stringify(toggle?.modes) === JSON.stringify(['default', 'sticky']),
    JSON.stringify(toggle?.modes),
);

const LOCALES = ['zh', 'zh-TW', 'en', 'ja'];
const allDicts = {};
for (const locale of LOCALES) {
    allDicts[locale] = JSON.parse(readFileSync(join(WEB, 'src/i18n/locales', `${locale}.json`), 'utf8'));
}
for (const locale of LOCALES) {
    const label = allDicts[locale][toggle.labelKey];
    ok(`locale ${locale}: 有 ${toggle.labelKey} 且非空`, typeof label === 'string' && label.trim().length > 0);
    ok(`locale ${locale}: 已不残留旧的 markdownToggle`, !('markdownToggle' in allDicts[locale]));
}
// 中文那份额外钉一下措辞：Jonny 定的就是「动作图标」这四个字。
ok('zh: 措辞就是「动作图标」', allDicts.zh[toggle.labelKey] === '动作图标', allDicts.zh[toggle.labelKey]);

// ⚠️ 四份语言文件的**键集合**一致由 `scripts/check-contracts.mjs` 判据 E 守着（它还查死键），
// 这里不重复；那条没接进门禁时才会在这里补。

// ── 3. 消费点没有各写一套默认值 ─────────────────────────────────────
//
// ⚠️ 别顺手把「没有第二份判定组合」这条扩到全仓去：`lib/actions/pure.js` 里
// `looksLikeMarkdown` 自己的实现就是 `… || looksLikeTaskList || looksLikeTable`，
// 「要不要给这个动作图标」的 match 也长得一样 —— 两者都不是「又抄了一份默认视图判断」。
// 所以这里只钉**消费点**（useMarkdown）。
const hook = readFileSync(join(WEB, 'src/hooks/useMarkdown.ts'), 'utf8');
ok('useMarkdown 复用 prefersRenderedView', /prefersRenderedView\(/.test(hook));
ok(
    'useMarkdown 里没有自己拼一套「任务列表 / 表格」判定',
    !/looksLikeTaskList\([^)]*\)\s*\|\|\s*looksLikeTable/.test(hook),
    '除了 prefersRenderedView，别处又拼了一套',
);

// ── 4. 粘贴文件：必须拦下浏览器的默认行为 ─────────────────────────────
//
// 「在主输入框里粘一张截图 → 输入框里多出一行文件名」这个 bug 就是漏了
// `event.preventDefault()` 造成的：剪贴板里带文件时（复制的文件、截图），浏览器默认
// 会把**文件名**当文本插进光标处，而且那行字还会被当成正文发出去。
//
// 但这个修法有**两个方向**都会坏，而两个方向都没有编译期保护：
//   · 漏了 preventDefault   → 文件名照样落进输入框（就是用户报的那个 bug）；
//   · 无条件 preventDefault → 纯文本粘贴被吞掉（「按了粘贴没反应」）。
// 所以判的不是「有没有这一句」，而是**顺序**：拦的动作要落在「有文件」的判断之后、
// 收文件之前。两个输入组件各有一份 onPaste，两份都要过。
const COMPOSERS = [
    { label: '主输入框', file: 'src/components/UnifiedComposer.tsx' },
    { label: '便签输入框', file: 'src/components/sticky/StickyComposer.tsx' },
];
for (const { label, file } of COMPOSERS) {
    const source = readFileSync(join(WEB, file), 'utf8');
    const body = functionBody(source, 'const onPaste = (');
    if (body === null) {
        ok(`${label} 里找得到 onPaste`, false, `${file} 里没有 const onPaste = ( —— 这条判据要跟着代码改`);
        continue;
    }
    const lines = body.split('\n');
    const guard = lines.findIndex((line) => /files\.length/.test(line));
    const prevent = lines.findIndex((line) => /event\.preventDefault\(\)/.test(line));
    const call = lines.findIndex((line) => /handleSelectFiles\(/.test(line));
    ok(
        `${label}：有文件时拦下默认粘贴（否则文件名会落进输入框）`,
        prevent >= 0 && prevent > guard && call > prevent,
        prevent < 0
            ? 'onPaste 里没有 event.preventDefault()'
            : `顺序不对（判断在第 ${guard} 行 / 拦在第 ${prevent} 行 / 收文件在第 ${call} 行）—— 拦在判断之前会把纯文本粘贴也吞掉`,
    );
    // 抠出来的那段还得真的挂上：没注册的话上面那条顺序再对也是死代码。
    ok(`${label}：这个处理真的挂到了 paste 上`, /addEventListener\('paste'/.test(source));
}

// ── 5. 快捷指令的更新时间轴 ────────────────────────────────────────────
//
// 日期清单是**人工维护**的（`shortcuts/history.json`），不是 git 日期：本仓库的
// `shortcuts/` 是 2026-09-28 整批导入的，`git log` 只会给出搬家那天（详见
// `scripts/sync-shortcuts.mjs`）。人工清单最容易出的三种错都不会报错，只会让时间轴
// 显示得莫名其妙，所以逐条钉住：
//   · 写反顺序  → 「最近一次更新」显示成最早那次，用户据此以为自己的捷径是新的；
//   · 写重复    → 轴上多一个假节点；
//   · 平台名打错 → 那个平台的时间轴整块空掉（没有报错）。
let history = null;
try {
    history = JSON.parse(readFileSync(join(REPO, 'shortcuts', 'history.json'), 'utf8'));
} catch {
    history = null;
}
ok('shortcuts/history.json 存在且能解析', history !== null && typeof history === 'object');

const PLATFORMS = ['apple', 'android'];
if (history) {
    for (const key of Object.keys(history)) {
        ok(`history.json 里没有多余的平台键：${key}`, PLATFORMS.includes(key), '打错字不会报错，那个平台的时间轴会整块空掉');
    }
    for (const platform of PLATFORMS) {
        const dates = history[platform];
        ok(`${platform}: 是日期数组`, Array.isArray(dates), `${typeof dates} —— 弹窗会挡掉，时间轴不显示`);
        if (!Array.isArray(dates) || dates.length === 0) continue;
        ok(`${platform}: 全是 YYYY-MM-DD`, dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), JSON.stringify(dates));
        ok(`${platform}: 没有重复`, new Set(dates).size === dates.length, JSON.stringify(dates));
        const sorted = [...dates].sort().reverse();
        ok(`${platform}: 最新在前`, JSON.stringify(dates) === JSON.stringify(sorted), `应该是 ${JSON.stringify(sorted)}`);
    }
    for (const platform of PLATFORMS) {
        ok(`${platform} 有更新记录（时间轴要有内容可画）`, (history[platform] ?? []).length > 0);
    }
}

// 弹窗那一侧：确实在画时间轴，而且旧的那条警告已经拆干净（拆一半会同时看到两套说法）。
const dialog = readFileSync(join(WEB, 'src/components/ShortcutsDialog.tsx'), 'utf8');
ok('弹窗用 scUpdateHistory 当时间轴标题', dialog.includes("t('scUpdateHistory')"));
ok('弹窗按当前 tab 取更新记录并且倒序画', /history\.slice\(/.test(dialog) && /\.reverse\(\)/.test(dialog));
ok('旧的「旧版请重新导入」提示已拆掉', !dialog.includes('scOutdatedNotice'));
ok('旧的「更新于 {date}」已拆掉', !dialog.includes('scUpdatedAt'));
for (const locale of LOCALES) {
    const dict = allDicts[locale];
    ok(`locale ${locale}: 有 scUpdateHistory 且非空`, typeof dict.scUpdateHistory === 'string' && dict.scUpdateHistory.trim().length > 0);
    ok(`locale ${locale}: 已不残留 scOutdatedNotice / scUpdatedAt`, !('scOutdatedNotice' in dict) && !('scUpdatedAt' in dict));
}

// ── 6. i18n 插值：`t('key', …)` 填的变量必须**覆盖**文案里的占位符 ──────────
//
// ⚠️★ 为什么必须有它：i18next 对「缺的变量」**不报错** —— 它把占位符原样吐出来，
// 屏幕上就是「{minutes}分钟前」。而这一族的成因特别隐蔽：文案是 vue-i18n 的
// 单花括号命名（`{minutes}` / `{keys}`），调用处却按 React 的习惯传了 `{ count }`
// （i18next 的 `count` 只填 `{{count}}`，且它会去找 `key_one` / `key_other` 复数键）——
// 两边单独看都「对」，只有把列表渲染出来才发现。
//
// 实测（2026-10-07）：一屏里两处 —— 房间侧栏的相对时间（`{minutes}` 被传成 `count`）、
// 便签输入框附件按钮的 aria-label（`t('addFiles')` 少传了 `keys`）。
// 两处都不会抛错，只有肉眼看界面 / 用读屏才知道。
//
// 判据的方向：**文案里要的 ⊆ 调用处给的**。（多给无害，i18next 会忽略多余的。）
// 只判「第二个参数是对象字面量」和「没有第二个参数」两种可静态判定的写法；
// 事件里/变量里传进来的（`t(key, opts)`）**不判** —— 宁漏勿误。
function walkTsFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name !== 'locales') walkTsFiles(full, out);
        } else if (['.ts', '.tsx'].includes(extname(name))) {
            out.push(full);
        }
    }
    return out;
}

/** 取 `(` 之后第一个顶层对象字面量的顶层键名；不是字面量 / 有展开 → null。 */
function topLevelKeysAfter(src, start) {
    let i = start;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '{') return null;
    const keys = [];
    let depth = 0;
    let quote = null;
    let pending = '';
    let inValue = false;
    const flush = () => {
        const k = pending.trim().replace(/^['"]|['"]$/g, '');
        if (k) keys.push(k);
        pending = '';
    };
    for (; i < src.length; i += 1) {
        const ch = src[i];
        if (quote) {
            if (ch === '\\') i += 1;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '(' || ch === '[') { depth += 1; continue; }
        if (ch === ')' || ch === ']') { depth -= 1; continue; }
        if (ch === '{') {
            depth += 1;
            if (depth === 1) { pending = ''; inValue = false; }
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) { if (!inValue) flush(); break; }
            continue;
        }
        if (depth !== 1) continue;
        if (ch === ':') {
            if (pending.trim().startsWith('...')) return null;
            if (!inValue) { keys.push(pending.trim()); pending = ''; }
            inValue = true;
            continue;
        }
        if (ch === ',') {
            // ⚠️★ 简写属性（`{ total }`）没有冒号，但它**也是**一个真的插值变量。
            // 漏掉这一支会误报 —— 2026-10-07 实测：`{ shown: n, total }` 被读成只有 shown。
            // ⚠️ 不过那次误报的元凶是**收尾的 `}` 分支**（那个简写落在最后一位）。
            // 这一支（非末位的简写）今天**没有调用点覆盖**，属于前瞻性的宽度 ——
            // 只删它不会让判据变红（实测过）。别把它当成「已验证」。
            if (!inValue) flush();
            else pending = '';
            inValue = false;
            continue;
        }
        if (!inValue) pending += ch;
    }
    return keys
        .map((k) => k.trim().replace(/^['"]|['"]$/g, ''))
        .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'defaultValue');
}

const PLACEHOLDER = /\{([A-Za-z_$][\w$]*)\}/g;
const I18N_CALL = /\bt\(\s*'([A-Za-z0-9_]+)'\s*([,)])/g;
let i18nChecked = 0;
const i18nProblems = [];
for (const file of walkTsFiles(join(WEB, 'src'))) {
    const src = readFileSync(file, 'utf8');
    let m;
    while ((m = I18N_CALL.exec(src)) !== null) {
        const [, key, next] = m;
        const template = allDicts.zh[key];
        if (typeof template !== 'string') continue;
        const wanted = new Set([...template.matchAll(PLACEHOLDER)].map((x) => x[1]));
        if (wanted.size === 0) continue;

        if (next === ')') {
            i18nChecked += 1;
            i18nProblems.push(
                `${file.replace(`${WEB}/`, '')}  t('${key}') 没传变量，文案里的 ${[...wanted].map((w) => `{${w}}`).join('')} 会原样显示`,
            );
            continue;
        }
        // ⚠️★ 偏移量必须落在**逗号之后**：写成 `- 1` 会指向逗号本身，
        //    `topLevelKeysAfter` 于是每次都返回 null → 一处都不判、判据**永远绿**。
        //    （2026-10-07 实测踩到：屏幕上「检查了 0 处」但结论是全绿。）
        const provided = topLevelKeysAfter(src, m.index + m[0].length);
        if (!provided || provided.length === 0) continue;
        i18nChecked += 1;
        const missing = [...wanted].filter((w) => !provided.includes(w));
        if (missing.length) {
            i18nProblems.push(
                `${file.replace(`${WEB}/`, '')}  t('${key}') 少传 ${missing.map((x) => `{${x}}`).join('')}（实际给了 ${provided.join(', ')}）`,
            );
        }
    }
}
// ⚠️★ 光判「没有不一致」不够：**读不到东西也是「没有不一致」**。
// 走查坏了 / 文件挪了 / 正则写歪了，都会让上面那个计数变成 0 —— 而结论仍然是绿。
// 所以再钉一条数量下限（当前实测 50 处；留了余量，只拦「整片扫不到」）。
const I18N_MIN_CHECKED = 30;
ok(
    `i18n 插值：扫到 ${i18nChecked} 处可静态判定的 t() 调用（少于 ${I18N_MIN_CHECKED} 说明判据自己坏了）`,
    i18nChecked >= I18N_MIN_CHECKED && i18nProblems.length === 0,
);
for (const problem of i18nProblems) console.log(`      · ${problem}`);

// ── 7. 已构建产物（有就查，没有就跳过）────────────────────────────────
if (!process.argv.includes('--src')) {
    const assetsDir = join(WEB, 'dist/assets');
    const bundle = existsSync(assetsDir)
        ? readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
            .map((f) => readFileSync(join(assetsDir, f), 'utf8')).join('\n')
        : '';
    if (!bundle) {
        console.log('skip  dist/assets 不存在或没有 JS（没构建过；先跑 npm run build）');
    } else {
        // 压缩器可能把非 ASCII 转成 \uXXXX，两种形态都认。
        const hasLabel = bundle.includes('动作图标') || bundle.includes('\\u52a8\\u4f5c\\u56fe\\u6807');
        ok('产物里有新标签「动作图标」', hasLabel);
        ok('产物里不再有 markdownToggle 这个 key', !bundle.includes('markdownToggle'));
    }
}

console.log(failed ? `\n${failed} 条失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
