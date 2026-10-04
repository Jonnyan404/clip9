// 动作库里**需要第三方库**的那一半实现（marked / highlight.js / opencc-js / pinyin-pro
// 与「替换模式表」）。⚠️ 只有内嵌的网页版能跑这些 —— 桌面端没有构建步骤，装不下这几个库，
// 所以用它们的动作在桌面侧是**置灰**的（见 `ui/app.js` 的 availability 与 actionMenu）。
//
// ⚠️ 别把这里的东西挪进 `pure.js`：那个文件的铁律是「零 import」，而这里每一条都是 import。

import { looksLikeTaskList, translator } from './pure.js';
import { detectLanguage } from '@/lib/highlight.js';
import { renderMarkdownHtml } from '@/lib/markdown.js';
// ⚠️ 这个文件住在 `data/actions/` 里，替换模式表在 `data/` 下 —— 少一层 `../` 的后果
// 是**构建期**报错（Could not resolve），不是运行期；构建时就炸反而是好事。
import replaceModeTable from '../replace-modes.json';

export const REPLACE_MODES = Object.fromEntries(
    (replaceModeTable.modes || []).map((m) => [m.key, { source: m.source || '', flags: m.flags || '' }]),
);

export const REPLACE_MODE_KEYS = (replaceModeTable.modes || []).map((m) => m.key);

export function replaceLiteral(text, params, ctx) {
    const modeKey = String(params?.mode ?? '').trim() || 'text';
    const mode = REPLACE_MODES[modeKey];
    if (!mode) {
        throw new Error(translator(ctx)('actionReplaceBadMode'));
    }
    const withText = String(params?.with ?? '');
    const source = String(text || '');

    // 「文本」模式：字面替换。
    // ⚠️ 用 split/join 而不是 `String.replace(find, with)`：后者传字符串时**只替换第一个**，
    // 要全局就得转义成正则 —— 又绕回了正则。
    if (!mode.source) {
        const find = String(params?.find ?? '');
        if (!find) {
            throw new Error(translator(ctx)('actionReplaceNeedFind'));
        }
        return source.split(find).join(withText);
    }

    // 其余模式：表里的固定正则。补一个 `g` 保证替换全部（表里只写语义相关的标志，如 `i`）。
    const flags = mode.flags.includes('g') ? mode.flags : `${mode.flags}g`;
    return source.replace(new RegExp(mode.source, flags), () => withText);
}

export function renderFenced(code, language = '') {
    const runs = String(code).match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    return renderMarkdownHtml(`${fence}${language}\n${code}\n${fence}`);
}

// ⚠️ `interactiveTasks` 不能省：不开的话 marked 会给复选框加 `disabled`，
// 任务列表就**点不动**了。（原本在 useMarkdown 的 md 分支里，重构成动作库时弄丢过一次。）
//
// ⚠️ 但**文件预览那条路不接**：那边的正文是**截断过**的，按下标回写会把截断后的
// 内容当成全文。用 `ctx.truncated` 区分（useMarkdown 传 `isMarkdownFile()`）。
export function runMarkdown(text, ctx) {
    return renderMarkdownHtml(text, {
        interactiveTasks: looksLikeTaskList(text) && !ctx?.truncated,
    });
}

// 语言检测是**异步**的（highlight.js 的 highlightAuto），所以这个动作是 async。
// 不检测也能渲染（只是没颜色），但「代码高亮」的全部价值就在颜色上 ——
// 原来的 useMarkdown 里就有这一步，别在重构里弄丢。
export async function runCode(text) {
    const language = await detectLanguage(text);
    return renderFenced(text, language);
}

export function runReplace(text, ctx, params) {
    return replaceLiteral(text, params, ctx);
}

// ⚠️ 动态 import = **懒加载**：拼音表 317KB，只在用户真的点了这个动作时才下载，
// 不进主包。ESM 自己缓存模块，所以下面三个注音动作不用各写一层缓存。
export async function runPinyin(text) {
    const mod = await import('./pinyin.js');
    return mod.annotate(text);
}

// 制表格式：拼音一行、汉字一行（tab 分隔），垂直对齐便于对照朗读
export async function runPinyinTable(text) {
    const mod = await import('./pinyin.js');
    return mod.toTable(text);
}

// 分词格式：按词分组、拼音连写。分词走**浏览器原生**的 Intl.Segmenter（零依赖）。
export async function runPinyinWord(text) {
    const mod = await import('./pinyin.js');
    return mod.toWordGroups(text);
}

// 懒加载（opencc-js 带词典，6MB 量级），同上。
//
// ⚠️ 转完和原文一样就**报错**，不返回原样 —— 「点了没反应」是最糟的体验，
// 用户分不清是「没有可转的字」还是「功能坏了」。match 挡不住这种情况：
// 判「是不是繁体」需要词典，而 match 必须廉价。
export async function runSimplified(text, ctx) {
    const mod = await import('./opencc.js');
    const source = String(text || '');
    const out = mod.toSimplified(source);
    if (out === source) {
        throw new Error(translator(ctx)('actionNothingToConvert'));
    }
    return out;
}

export async function runTraditional(text, ctx) {
    const mod = await import('./opencc.js');
    const source = String(text || '');
    const out = mod.toTraditional(source);
    if (out === source) {
        throw new Error(translator(ctx)('actionNothingToConvert'));
    }
    return out;
}
