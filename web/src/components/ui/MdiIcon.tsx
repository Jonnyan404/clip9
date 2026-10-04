import type { CSSProperties } from 'react';

/**
 * MDI 图标（`@mdi/font` 的 CSS 字体）。
 *
 * ⚠️★ 为什么用 `<i className="mdi mdi-xxx" />` 而不是 `@mdi/js` 的路径组件：
 * 数据层（`catalog.json` 46 处、`displayToggles` 25 处、`modes/meta.ts` 5 处）里的 `icon`
 * 字段存的就是**类名字符串**（`mdi-brightness-4`）。保留字体方案可让**数据层零改动**；
 * 换成 `@mdi/js` 就得把每个字符串映射成路径对象，属于无谓成本。
 */
export function MdiIcon({
    name,
    size = 24,
    color,
    className,
    style,
    title,
}: {
    name: string;
    size?: number | string;
    color?: string;
    className?: string;
    style?: CSSProperties;
    title?: string;
}) {
    return (
        <i
            className={`mdi ${name}${className ? ` ${className}` : ''}`}
            style={{ fontSize: size, color, lineHeight: 1, display: 'inline-block', ...style }}
            aria-hidden={title ? undefined : true}
            title={title}
        />
    );
}
