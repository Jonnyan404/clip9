/**
 * display 数学公式在**窄容器**里按宽度等比缩小。
 *
 * 为什么需要它：KaTeX 的块公式（`.katex-display`）是一整块不可断行的盒子，宽度由内容决定。
 * 便签卡片、手机屏这种窄容器里，一条长公式比容器还宽 —— 于是那个卡片出现**横向滚动条**，
 * 而横向滚动条又吃掉 3px 高度，连带把纵向也撑出滚动条（2026-10-30 用户报的
 * 「便签模式首页的数学公式卡片预览有滚动条」）。实测：长公式那一条 330 宽装 361 宽的内容。
 *
 * 缩字号而不是 `transform: scale()`：KaTeX 的尺寸几乎全是 em，改 `font-size` 是**等比**的，
 * 而且**影响布局**（缩放后占位跟着变小）。`transform` 不改变占位，缩完会在公式周围留一圈空白，
 * 卡片里那点高度经不起。
 *
 * ⚠️ 只缩不放：容器比公式宽时保持原样（放大只会把短公式糊成一片）。
 * ⚠️ 有下限（`MIN_RATIO`）：缩到 0.55 还放不下就交给 CSS 的 `overflow-x` 局部滚动 ——
 *    字号再小就只是「完整但读不了」，不如让读者自己滑。
 */

/** 最小缩放比。低于它就停止，改由容器横向滚动。 */
const MIN_RATIO = 0.55;

/**
 * 把 `root` 里所有 display 公式缩到容器宽度以内。
 *
 * 幂等：每次都先复位 `font-size` 再测量，所以可以反复调用（字体加载完、容器变宽变窄时都要再调一次）。
 * ⚠️ 复位会让元素瞬间回到原尺寸 —— 只在 effect / resize 里调用，别放进动画循环。
 */
export function fitDisplayMathIn(root) {
    if (!root || !root.querySelectorAll) {
        return;
    }
    for (const box of root.querySelectorAll('.katex-display')) {
        // ⚠️ 必须先复位：上一次的缩放已经改过 font-size，不复位就量不出「原始宽度」，
        //    反复调用会越缩越小。
        box.style.removeProperty('font-size');

        const parent = box.parentElement;
        if (!parent) {
            continue;
        }
        const avail = parent.clientWidth;
        if (avail <= 1) {
            continue;
        }

        // `.katex` 才是那个按 em 排版的盒子；量它的宽度比量 `.katex-display`（block、撑满容器）
        // 更接近「公式本身有多宽」。两者取大值兜底。
        const katex = box.querySelector('.katex');
        const natural = Math.max(box.scrollWidth, katex ? katex.getBoundingClientRect().width : 0);
        // +1 的容差：亚像素舍入会让「刚好放得下」也判成溢出，于是每次都在缩。
        if (!Number.isFinite(natural) || natural <= avail + 1) {
            continue;
        }

        const base = parseFloat(getComputedStyle(box).fontSize) || 16;
        // ⚠️ 留 1px 余量：按 avail/natural 精确缩完，`scrollWidth - clientWidth` 还会剩下 1px
        //    （亚像素舍入），个别浏览器就为这 1px 画一条滚动条。少这 1px 才真的干净。
        const ratio = Math.max((avail - 1) / natural, MIN_RATIO);
        box.style.fontSize = `${(base * ratio).toFixed(2)}px`;
    }
}
