import type { ReactNode } from 'react';
import { MdiIcon } from './MdiIcon';

/**
 * 统一的「这里还没有东西」。
 *
 * ⚠️★ 2026-11-26：原来 8 个模式各自写了一套空态 —— 图标+h6+说明+主色 Chip（标准模式）、
 *    h6+说明+contained 按钮+虚线框（便签）、icon+strong+span+Button（时间线）、
 *    一行 caption（一瞥）、纯文字 div（动作台）、虚线大盒（转换）、**完全没有**（看板）。
 *    同一个「没内容」有 4 种按钮规格、3 套文案结构，换个模式就换一种说法。
 *
 * 这里只固定**结构**（图标 / 标题 / 一句说明 / 一个动作），
 * 各模式真正需要的差异（撑满、虚线框）用 `className` 传进来，不塞成 props。
 */
export function EmptyState({
    icon,
    title,
    desc,
    action,
    className,
}: {
    icon?: string;
    title: string;
    desc?: string;
    action?: ReactNode;
    /** `empty-state--fill` 撑满父级 / `empty-state--dashed` 虚线框（便签那种「这里能写」的暗示）。 */
    className?: string;
}) {
    return (
        <div className={className ? `empty-state ${className}` : 'empty-state'}>
            {icon && <MdiIcon name={icon} size={38} color="var(--mui-palette-primary-main)" />}
            <div className="empty-state__title">{title}</div>
            {desc && <div className="empty-state__desc">{desc}</div>}
            {action && <div className="empty-state__action">{action}</div>}
        </div>
    );
}
