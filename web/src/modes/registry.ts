import type { ComponentType } from 'react';
import { MODES_META, type ModeMeta } from './meta';
import DefaultMode from './DefaultMode';
import GlanceWall from './GlanceWall';
import BenchWall from './BenchWall';
import StickyWall from './StickyWall';
import BoardWall from './BoardWall';

/**
 * 界面模式注册表 —— 对应 web-vue3/src/views/modes/registry.js。
 *
 * ⚠️ 元数据（key / labelKey / icon）在 `./meta.ts`：`appStore` 只用元数据，这样就不会
 *    通过 registry 把 5 个模式组件（及其对 store 的依赖）拖进一个模块循环。
 */
export interface ModeDef extends ModeMeta {
    component: ComponentType;
}

/** key → 组件。未登记的 key 一律落 `DefaultMode`（见 meta.ts 的退役说明）。 */
const COMPONENTS: Record<string, ComponentType> = {
    default: DefaultMode,
    glance: GlanceWall,
    bench: BenchWall,
    sticky: StickyWall,
    board: BoardWall,
};

export const MODES: ModeDef[] = MODES_META.map((meta) => ({
    ...meta,
    component: COMPONENTS[meta.key] ?? DefaultMode,
}));

/**
 * 把模式 key 解析成组件。认不出的 key（含已退役那四个）落到 `DefaultMode`。
 * ⚠️ **不要**为退役的 key 加映射。
 */
export function resolveModeComponent(key: string): ComponentType {
    return COMPONENTS[key] ?? DefaultMode;
}
