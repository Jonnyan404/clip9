/**
 * 界面模式的**元数据**（key / 文案键 / 图标）—— 不含任何 React 组件引用。
 *
 * ⚠️★ 为什么把元数据与组件拆成两个文件：`stores/appStore.ts` 要读模式列表
 * （`composerDisabledEverywhere` 判定「所有模式都把发送区关掉」），而 registry 会 import
 * 每一个模式组件、组件又 import store —— 元数据与组件不拆的话就是一个模块循环
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
    // ⚠️ `canvas` 排在**最后**：它是 2026-10-10 才加的第 6 个模式，加在中间会让
    // 已经习惯前五个顺序的人每次切模式都多点一下。顺序不是「按重要性排」的。
    { key: 'canvas', labelKey: 'uiModeCanvas', icon: 'mdi-draw' },
    // ⚠️ 同样**排在最后**（理由同上）：加在中间会让已经习惯顺序的人每次切模式多点一下。
    // ⚠️ 它和 `canvas` 用的是**同一条**转换管线（`services/convert.ts`），
    // 只是白板要布局、这个只要文本 —— 别在这里另写一套转换。
    { key: 'convert', labelKey: 'uiModeConvert', icon: 'mdi-language-markdown-outline' },
    // ⚠️ 还是**排在最后**（理由同上）：2026-10-25 加的第 8 个模式。
    // 它按本地日分组、一条一行（展开即完整预览）—— 与标准模式的区别是**密度**，不是皮肤。
    { key: 'timeline', labelKey: 'uiModeTimeline', icon: 'mdi-timeline-text-outline' },
];
