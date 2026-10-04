import type { ComponentType } from 'react';
import DefaultMode from './DefaultMode';
import GlanceWall from './GlanceWall';
import BenchWall from './BenchWall';
import StickyWall from './StickyWall';
import BoardWall from './BoardWall';

/**
 * 界面模式注册表 —— 对应 web-vue3/src/views/modes/registry.js。
 *
 * ⚠️★ 四个模式（chat / mega / workbench / terminal）已**退役并真删**（2026-09-26）。
 * 没有退役映射表、没有兼容分支 —— 认不出的 key（含那四个）一律落到 `DefaultMode`。
 * 别为了「优雅降级」再把映射表加回来：这个项目**没有老用户**，而兼容垫片是**永久成本**。
 *
 * ⚠️ 顺序就是模式切换器里的顺序，别随手排序（速览紧跟标准模式、动作台挨着速览、看板放最后，
 *    每条理由见 web-vue3 原文件的注释）。
 */
export interface ModeDef {
    key: string;
    labelKey: string;
    icon: string;
    component: ComponentType;
}

export const MODES: ModeDef[] = [
    { key: 'default', labelKey: 'uiModeDefault', icon: 'mdi-view-stream-outline', component: DefaultMode },
    { key: 'glance', labelKey: 'uiModeGlance', icon: 'mdi-magnify-scan', component: GlanceWall },
    { key: 'bench', labelKey: 'uiModeBench', icon: 'mdi-auto-fix', component: BenchWall },
    { key: 'sticky', labelKey: 'uiModeSticky', icon: 'mdi-pin-outline', component: StickyWall },
    { key: 'board', labelKey: 'uiModeBoard', icon: 'mdi-view-column-outline', component: BoardWall },
];

/**
 * 把模式 key 解析成组件。认不出的 key（含已退役那四个）落到 `DefaultMode`。
 * ⚠️ **不要**为退役的 key 加映射。
 */
export function resolveModeComponent(key: string): ComponentType {
    return MODES.find((mode) => mode.key === key)?.component || DefaultMode;
}
