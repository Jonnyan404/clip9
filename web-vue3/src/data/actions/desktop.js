// 桌面端的「动作实现包」入口 —— `tools/sync-action-catalog.mjs` 以它为入口，
// 用 esbuild 打成一个**自足的 ESM**（`ui/actions-impl.js`，第三方库全在里面），
// 桌面那个没有构建步骤的界面 `import('./actions-impl.js')` 就能跑。
//
// ⚠️★ 这里**只**再导出桌面端跑得动的那几条：`runSimplified` / `runTraditional`
// **不在此列**（opencc-js 的词典压完还有 2.2MB，2026-10-03 定：暂不进桌面）——
// 没被导出 ⇒ 没被打包 ⇒ 桌面那侧查不到实现，动作菜单里照旧**置灰**并说明
//（`availability` 的既有约定：隐藏会让人以为功能不存在）。
// 哪天要放行简繁：把这两个名字加进下面的清单、重新同步即可，桌面侧零改动。
//
// ⚠️ 这份清单同时是**契约**：构建时从 metafile 抽出这里的导出名写进
// `ui/actions-impl.json`，桌面端按它决定「哪条动作的实现要点了才加载」。
// 所以**别**在这里 re-export 没必要的名字 —— 多一个名字，桌面端就多一条「能点」的动作。

export {
    REPLACE_MODES,
    REPLACE_MODE_KEYS,
    replaceLiteral,
    renderFenced,
    runMarkdown,
    runCode,
    runReplace,
    runPinyin,
    runPinyinTable,
    runPinyinWord,
} from './impl.js';

// ⚠️★ markdown / 代码高亮吐出来的 `<pre><code class="language-x">` 是**没有颜色**的
//（marked 的 renderer 是同步的，而高亮器只能 `import()` 按需加载，renderer 里 await 不了）—
// 颜色是**渲染完之后**回头补的。网页版补在 `MarkdownBody.vue` 里，桌面对应地补在
// 卡片画完 HTML 之后 —— 两边调的是 `highlight.js` 里同一个函数。
export { highlightCodeBlocksIn } from '../../highlight.js';
