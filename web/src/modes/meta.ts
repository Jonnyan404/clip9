/**
 * 界面模式的**元数据**（key / 文案键 / 图标）—— 不含任何 React 组件引用。
 *
 * ⚠️★ 为什么把元数据与组件拆成两个文件：`stores/appStore.ts` 要读模式列表
 * （`composerDisabledEverywhere` 判定「六个模式都把发送区关掉」），而 registry 会 import
 * 5 个模式组件、组件又 import store —— 元数据与组件不拆的话就是一个模块循环
 * （web-vue3 里靠「在 getter 里现取 MODES」绕开，React 侧用拆文件更干净）。
 *
 * ⚠️★ 四个模式（chat / mega / workbench / terminal）已**退役并真删**（2026-09-26）。
 * 没有退役映射表、没有兼容分支 —— 认不出的 key（含那四个）一律落到 `default`。
 * 别为了「优雅降级」再把映射表加回来：这个项目**没有老用户**，而兼容垫片是**永久成本**。
 *
 * ⚠️ 顺序就是模式切换器里的顺序，别随手排序（每条理由见 web-vue3 原 registry.js 的注释）。
 */
export interface ModeMeta {
    key: string;
    labelKey: string;
    icon: string;
}

export const MODES_META: ModeMeta[] = [
    { key: 'default', labelKey: 'uiModeDefault', icon: 'mdi-view-stream-outline' },
    { key: 'glance', labelKey: 'uiModeGlance', icon: 'mdi-magnify-scan' },
    { key: 'bench', labelKey: 'uiModeBench', icon: 'mdi-auto-fix' },
    { key: 'sticky', labelKey: 'uiModeSticky', icon: 'mdi-pin-outline' },
    { key: 'board', labelKey: 'uiModeBoard', icon: 'mdi-view-column-outline' },
];
