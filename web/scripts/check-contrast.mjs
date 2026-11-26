/**
 * 颜色令牌的对比度守卫。
 *
 * ⚠️★ 为什么要有这个脚本：2026-11-26 的 UI 评审量出 **16 处文字没过 WCAG**，
 *    而且几乎全部只在**浅色**下不过（时间线 5 个分类色当 10px 标签字用时 2.15–2.77:1、
 *    便签的 TEXT 标签 2.88、实心主色白字 3.68）。这些色值是写死在 CSS 里的常量，
 *    改错了没有任何东西会红 —— 界面还是那个界面，只是字看不清。
 *
 * 它只盯**令牌**（`--cat-*` / `--timeline-muted` / `--board-hint` / 主色），
 * 不去扫每一处内联色值：那会把几百条「刻意写死的 slate」一次全报出来（没人会修）。
 * 令牌正是为了「能被自动验证」才被拎出来的，所以这里盯它们。
 *
 * ⚠️ 用 `web/src/lib/contrast.js` 的**同一份**实现（它是零依赖 JS，Node 能直接 import）——
 *    自己抄一遍公式的话，一处改了另一处没改，判据会变成假绿。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contrastRatio, parseHex, SURFACE_DARK, SURFACE_LIGHT } from '../src/lib/contrast.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');

let failed = 0;
function ok(name, condition, detail = '') {
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail && !condition ? `  → ${detail}` : ''}`);
    if (!condition) {
        failed += 1;
    }
}

/** 剥掉 CSS 注释 —— 这个仓库的注释里到处引用色值与选择器，不剥就会被散文满足。 */
function stripCssComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某个选择器的声明块（第一个匹配）。找不到返回 null。 */
function block(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    return match ? match[1] : null;
}

/** 从一个声明块里取自定义属性；没有就返回 null。 */
function token(decls, name) {
    if (!decls) {
        return null;
    }
    const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(decls);
    return match ? match[1].trim() : null;
}

/** 把 `fg` 以 alpha 混到 `bg` 上（模拟 `color-mix(in srgb, fg a%, bg)`）。 */
function mix(fg, bg, alpha) {
    const a = parseHex(fg);
    const b = parseHex(bg);
    if (!a || !b) {
        return null;
    }
    const channel = (index) => Math.round(a[index] * alpha + b[index] * (1 - alpha)).toString(16).padStart(2, '0');
    return `#${channel(0)}${channel(1)}${channel(2)}`;
}

const cssPath = join(WEB, 'src/styles/components.css');
const css = existsSync(cssPath) ? stripCssComments(readFileSync(cssPath, 'utf8')) : '';

if (!css) {
    console.error('✗ 读不到 components.css');
    process.exit(1);
}

const light = block(css, '.timeline-wall');
const dark = block(css, '.dark .timeline-wall');
const boardLight = block(css, '.board-wall');
const boardDark = block(css, '.dark .board-wall');

ok('找得到 `.timeline-wall` 的令牌块', Boolean(light));
ok('找得到 `.dark .timeline-wall` 的令牌块', Boolean(dark));

// ── 1. 分类色：浅色对白底 / 页底都要 ≥4.5（它们是 10px 标签字） ──────────
//
// ⚠️ 阈值 4.5 而不是 3：同一支色既用于 24px 图标块（非文本，3:1 够），
//    也用于 10px 的分类文字。取两者更严的那个 —— 否则「图标块合规、标签字不合规」。
const CATEGORIES = ['text', 'image', 'file', 'task', 'table'];
const lightFails = [];
for (const name of CATEGORIES) {
    const value = token(light, `--cat-${name}`);
    if (!value) {
        lightFails.push(`${name}: 没有 --cat-${name} 令牌`);
        continue;
    }
    // ⚠️ 严格 6 位 hex：`#fff` 这种会让 parseHex 返回 null → 对比度算不出来 →
    //    如果不在这里判红，改成一个缩写就等于把判据关掉了（静默假绿）。
    if (!parseHex(value)) {
        lightFails.push(`${name}: \`${value}\` 不是 6 位 hex`);
        continue;
    }
    for (const bg of ['#ffffff', SURFACE_LIGHT]) {
        const ratio = contrastRatio(value, bg);
        if (ratio === null || ratio < 4.5) {
            lightFails.push(`${name} ${value} on ${bg} = ${ratio === null ? '?' : ratio.toFixed(2)}`);
        }
    }
}
ok('分类色（浅色）对白底与页底都 ≥4.5:1', lightFails.length === 0, lightFails.join('；'));

// ── 2. 分类色：深色版对**面板实际合成色** ≥4.5 ────────────────────────
//
// ⚠️ 深色面板不是 `SURFACE_DARK`（`#0f172a`）：`.timeline-panel` 是
//    `rgba(30,41,59,.62)` 叠在页底上。按 `#0f172a` 算会**偏乐观**（紫色 3.76 会被算成过）。
const PANEL_DARK = mix('#1e293b', SURFACE_DARK, 0.62) || '#182235';
const darkFails = [];
for (const name of CATEGORIES) {
    const value = token(dark, `--cat-${name}`);
    if (!value || !parseHex(value)) {
        darkFails.push(`${name}: 缺少合法的深色令牌`);
        continue;
    }
    const ratio = contrastRatio(value, PANEL_DARK);
    if (ratio === null || ratio < 4.5) {
        darkFails.push(`${name} ${value} on ${PANEL_DARK} = ${ratio === null ? '?' : ratio.toFixed(2)}`);
    }
}
ok('分类色（深色）对面板合成色 ≥4.5:1', darkFails.length === 0, darkFails.join('；'));

// ── 3. 次级文字：muted / hint 两套都要 ≥4.5 ────────────────────────────
function checkToken(decls, name, backgrounds, minimum, label) {
    const value = token(decls, name);
    if (!value) {
        return [`${name}: 找不到`];
    }
    if (!parseHex(value)) {
        return [`${name}: \`${value}\` 不是 6 位 hex`];
    }
    const bad = [];
    for (const bg of backgrounds) {
        const ratio = contrastRatio(value, bg);
        if (ratio === null || ratio < minimum) {
            bad.push(`${value} on ${bg} = ${ratio === null ? '?' : ratio.toFixed(2)}`);
        }
    }
    return bad.length ? [`${label}（${bad.join('，')}）`] : [];
}

const textFails = [
    ...checkToken(light, '--timeline-muted', ['#ffffff', SURFACE_LIGHT], 4.5, '--timeline-muted 浅色'),
    ...checkToken(dark, '--timeline-muted', [PANEL_DARK], 4.5, '--timeline-muted 深色'),
    ...checkToken(boardLight, '--board-hint', ['#ffffff'], 4.5, '--board-hint 浅色'),
    ...checkToken(boardDark, '--board-hint', [SURFACE_DARK], 4.5, '--board-hint 深色'),
];
ok('次级文字令牌（muted / hint，浅深各一套）都 ≥4.5:1', textFails.length === 0, textFails.join('；'));

// ── 4. 主色上的白字：默认主色必须撑得住 4.5 ────────────────────────────
//
// ⚠️ 主色是**用户可改**的（传统色 742 支），所以这里只能盯默认那一支 ——
//    但默认值是「实心按钮 + 白字」的主路径，它塌了全站都塌。
//    用户自选亮色导致白字糊，靠 chip 那套 tonal（低饱和底 + 深字）绕开，见 components.css。
const themeStore = readFileSync(join(WEB, 'src/stores/themeStore.ts'), 'utf8');
const defaultPrimary = /DEFAULT_PRIMARY\s*=\s*'(#[0-9a-fA-F]{6})'/.exec(themeStore)?.[1];
ok('读得到 DEFAULT_PRIMARY', Boolean(defaultPrimary), 'themeStore.ts 里的格式变了？');
if (defaultPrimary) {
    const ratio = contrastRatio('#ffffff', defaultPrimary);
    ok(
        `默认主色 ${defaultPrimary} 上的白字 ≥4.5:1`,
        ratio !== null && ratio >= 4.5,
        `实测 ${ratio === null ? '?' : ratio.toFixed(2)} —— 实心按钮/发送键/今天 chip 全部受影响`,
    );
}

// ── 5. 便签：浅色纸上不能再用 opacity 做次级字 ──────────────────────────
//
// ⚠️ 这是**结构性**断言，不是色值断言：`opacity` 会和纸色相乘，
//    纸越深字越糊（原来 10px 的小字被压到 2.68–2.88:1）。次级字必须给实色。
const stickyBlocks = ['.sticky-note__label', '.sticky-note__meta', '.sticky-note__time']
    .map((selector) => ({ selector, decls: block(css, selector) }));
const opacityFails = stickyBlocks
    .filter((entry) => entry.decls && /opacity\s*:\s*0?\.\d+/.test(entry.decls))
    .map((entry) => entry.selector);
ok('便签的 label / meta / time 不用 opacity 降透明', opacityFails.length === 0, opacityFails.join('、'));

console.log(failed ? `\n${failed} 条失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
