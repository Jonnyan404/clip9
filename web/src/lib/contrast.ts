/**
 * 颜色对比度（WCAG 2.x 的相对亮度公式）。
 *
 * 为什么单独一个模块：传统色板要用它干两件事 ——
 *   ① 决定色块上那个对勾是白的还是深的（`readableOn`）；
 *   ② 标出「这个色和当前背景几乎一样，选了等于没选」（`contrastRatio`）。
 * 两件事都在同一个公式上，写成两份迟早一处改了另一处没改。
 *
 * ⚠️ 只认 `#rrggbb`。色板里有 `#fff` 这种三位缩写时返回 `null`，
 *    调用方按「算不出来」处理（不标低对比，也不崩），而不是猜一个值。
 */

/** `#rrggbb` → 三个 0–255 的通道；认不出返回 null。 */
export function parseHex(hex: string): [number, number, number] | null {
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
export function relativeLuminance(hex: string): number | null {
    const rgb = parseHex(hex);
    if (!rgb) {
        return null;
    }
    const linear = (channel: number) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    // 系数是 sRGB 的规范值：人眼对绿最敏感、对蓝最不敏感
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** 两个颜色的对比度（1–21）。任一方认不出就返回 null。 */
export function contrastRatio(a: string, b: string): number | null {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    if (la === null || lb === null) {
        return null;
    }
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

/** 这个颜色上该用白字还是深字。 */
export function readableOn(hex: string): string {
    const luminance = relativeLuminance(hex);
    // 认不出颜色时给深字：传统色里浅色多（月白 / 缟 / 素），压深字更安全
    if (luminance === null) {
        return '#1f2937';
    }
    return luminance > 0.5 ? '#1f2937' : '#ffffff';
}
