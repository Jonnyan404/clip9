/**
 * 颜色对比度（WCAG 2.x 的相对亮度公式）。
 *
 * 为什么单独一个模块：传统色板要用它干三件事 ——
 *   ① 决定色块上那个对勾是白的还是深的（`readableOn`）；
 *   ② 判断一支色**属于浅色还是深色那一套配色**（`paletteScopeOf`）；
 *   ③ 算「这个色和背景差多少」。
 * 三件事都在同一个公式上，写成三份迟早一处改了另两处没改。
 *
 * ⚠️★ 为什么是 `.js` 不是 `.ts`：`web/scripts/check-display-semantics.mjs` 要
 *    **直接 import 这个文件**、拿真实的 742 个传统色跑一遍分组（判「浅色系是不是真的
 *    在浅底上 ≥3:1」）。那个脚本跑在纯 Node 里，吃不了 TS —— 而它必须盯住**发货的那份
 *    实现**，不能自己抄一份公式（抄的那份永远绿）。同一个理由，`lib/actions/pure.js`
 *    和 `data/displayToggles.js` 也都是零依赖 JS：能被 Node 直接加载的，才配当单一来源。
 *    所以这个文件必须**保持零 import**、只用 ES2022 就有的语法。
 *
 * ⚠️ 只认 `#rrggbb`。色板里有 `#fff` 这种三位缩写时返回 `null`，
 *    调用方按「算不出来」处理（不标低对比，也不崩），而不是猜一个值。
 */

/** `#rrggbb` → 三个 0–255 的通道；认不出返回 null。 */
export function parseHex(hex) {
    const value = String(hex || '').trim().replace(/^#/, '');
    if (value.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(value)) {
        return null;
    }
    return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
    ];
}

/** WCAG 的相对亮度（0 = 黑，1 = 白）。 */
export function relativeLuminance(hex) {
    const rgb = parseHex(hex);
    if (!rgb) {
        return null;
    }
    const linear = (channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    // 系数是 sRGB 的规范值：人眼对绿最敏感、对蓝最不敏感
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** 两个颜色的对比度（1–21）。任一方认不出就返回 null。 */
export function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    if (la === null || lb === null) {
        return null;
    }
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * 两套配色的**页面底色** —— 与 `theme/index.ts` 里 `background.default` 是同一对值，
 * 那边从这边 import（这个文件零依赖，反过来引会把 MUI 拖进来）。
 */
export const SURFACE_LIGHT = '#f4f7fb';
export const SURFACE_DARK = '#0f172a';

/**
 * 「纸面」（卡片 / 对话框 / 菜单 / 面板）的底色。
 *
 * ⚠️★ 2026-11-26：原来主题只设了 `background.default`，**没设 `paper`** ——
 *    MUI 于是回落成它自己的 `#121212`（中性黑），浮在 `#0f172a`（墨蓝）页面上。
 *    两者明度只差 1.05:1，所以问题不是「太暗」而是**色相不对**：同一屏两套黑（暖/冷）。
 *    `PAPER_DARK` 取 `#182235`，正好等于时间线面板 `rgba(30,41,59,.62)` 叠在页底上的
 *    实际合成色 —— 于是「面板 = 纸 = 对话框」变成同一个色，而不是第三种深色。
 */
export const PAPER_LIGHT = '#ffffff';
export const PAPER_DARK = '#182235';

/**
 * 这支色属于哪一套配色；`null` = 两边都不合适，**色板上直接不显示**。
 *
 * 判据只有一条：**它在浅色模式的页面上还看得见吗**（与 `SURFACE_LIGHT` 的对比度 ≥ 3:1）。
 *
 *   · 看得见 → `'light'`：浅色模式下做主色有区分度。
 *   · 看不见 → `'dark'`：太亮/太淡，糊在白底上；这种色的相对亮度必然偏高，
 *     放到深底上对比度**必然 ≥5.1:1**（742 支里最低的一支是银褐 `#A88A6F` 的 5.55:1）——
 *     所以「深色系」这个定义顺带保证了它在深底上够用。不需要两组各自的阈值，
 *     也不存在「两边都勉强」的中间地带。
 *
 * ⚠️★ 例外是**几乎纯的白和黑**（亮度 > 0.97 / < 0.0008）：它们在某一端能算出很高的
 *    对比度，但当主色时 MUI 只会渲染出一个「纯白按钮」或「纯黑按钮」，没有任何色彩可言。
 *    全清单里只有 4 支：雪白 `#FFFEF9`、象牙白 `#FFFEF8`、海参灰 `#FFFEFA`、黑 `#000000`。
 *
 * ⚠️ 认不出 `#fff` 这种三位缩写时返回 `null`（不显示），**不猜**。
 */
export function paletteScopeOf(hex) {
    const luminance = relativeLuminance(hex);
    if (luminance === null) {
        return null;
    }
    if (luminance > 0.97 || luminance < 0.0008) {
        return null;
    }
    return (contrastRatio(hex, SURFACE_LIGHT) ?? 0) >= 3 ? 'light' : 'dark';
}

/** 这个颜色上该用白字还是深字。 */
export function readableOn(hex) {
    const luminance = relativeLuminance(hex);
    // 认不出颜色时给深字：传统色里浅色多（月白 / 缟 / 素），压深字更安全
    if (luminance === null) {
        return '#1f2937';
    }
    return luminance > 0.5 ? '#1f2937' : '#ffffff';
}
