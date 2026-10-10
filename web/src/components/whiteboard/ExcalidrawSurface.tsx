/**
 * Excalidraw 的**懒加载外壳**。
 *
 * ⚠️★ 这个文件**故意**只做一件事：把 `@excalidraw/excalidraw` 和它的 CSS 拉进来，
 * 别的什么都不做。理由只有一个 —— **它必须是一个能被 `React.lazy` 单独切出去的模块**。
 *
 * 为什么非要拆出去：Excalidraw 是这份前端里最大的一个依赖（它自己带字体、图标、
 * 一套完整的画布引擎），而 clip9 的前端产物**会被编进服务端二进制**
 * （`rust/crates/server/static/`），体积是实打实的约束 —— 五个模式里只有一个用得上它。
 * 把 import 写在模式组件里，它就会被算进主 chunk，**所有人**都得为白板多下一份包。
 *
 * ⚠️ CSS 也必须在**这个**模块里 import：写在别处的话，样式会进主 CSS，
 * 于是「没进过白板模式的人」也要下一份用不上的样式表。
 * ⚠️ 而且 Excalidraw 的样式**会改全局**（CSS 变量、字体族），
 * 所以它只能在这条懒加载路径上生效 —— 这同时是「它不会串味到别的模式」的保证。
 */

import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';

export type { ExcalidrawImperativeAPI };

/**
 * clip9 的 locale → Excalidraw 的 `langCode`。
 *
 * ⚠️★ 两边的代码**不一样**，不能直接传（2026-10-10 补）：
 *
 * | clip9（`i18n/index.ts`） | Excalidraw |
 * |---|---|
 * | `zh` | **`zh-CN`** |
 * | `zh-TW` | `zh-TW` |
 * | `en` | `en` |
 * | `ja` | **`ja-JP`** |
 *
 * ⚠️ 不接的后果：Excalidraw 的界面（工具栏提示、右键菜单、快捷键面板、Library）
 * 会**跟着 `navigator.language` 走**，而不是跟着用户在 clip9 里选的语言。
 * 症状是「界面一半中文一半英文」—— 用户把 clip9 切成中文、浏览器是英文时最容易撞上，
 * 而**两边都不报错**。
 *
 * ⚠️ 认不出的 locale 回 `en` 而**不是** `undefined`：`undefined` 会让 Excalidraw
 * 自己去猜（回到上面那个「跟浏览器走」的行为）。回 `en` 至少是确定的。
 * Excalidraw 的 `zh-CN` / `zh-TW` 译文完整度是 **100%**（它的语言选择器里就写着这个数）。
 */
const LANG_CODE: Record<string, string> = {
    zh: 'zh-CN',
    'zh-TW': 'zh-TW',
    en: 'en',
    ja: 'ja-JP',
};

export function excalidrawLangCode(locale: string): string {
    return LANG_CODE[locale] ?? 'en';
}

export interface ExcalidrawSurfaceProps {
    /** 跟 clip9 的主题走（Excalidraw 自己会在暗色下调整画布与网格）。 */
    theme: 'light' | 'dark';
    /** clip9 的当前 locale（`zh` / `zh-TW` / `en` / `ja`），由 [`excalidrawLangCode`] 翻译。 */
    locale: string;
    /** 首帧就放上去的元素（从房间加载回来的白板）。 */
    elements: readonly ExcalidrawElement[];
    /** 画布就绪 —— 调用方拿这个 api 去做 `updateScene` / `getSceneElements`。 */
    onReady: (api: ExcalidrawImperativeAPI) => void;
}

export default function ExcalidrawSurface({
    theme,
    locale,
    elements,
    onReady,
}: ExcalidrawSurfaceProps) {
    return (
        <Excalidraw
            theme={theme}
            langCode={excalidrawLangCode(locale) as never}
            excalidrawAPI={onReady}
            initialData={{ elements, appState: { viewBackgroundColor: 'transparent' } }}
            // ⚠️ 关掉「库」面板：它列的是 Excalidraw 官方的示例素材，
            // 与 clip9 的房间/文件没有半点关系，开着只会让人以为「这里能拿到别人的东西」。
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        />
    );
}
