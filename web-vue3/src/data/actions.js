// 动作库：把「用另一种方式看这条内容」做成一张可扩展的表。
//
// 为什么要有它：以前预览区右上角那排图标是**写死的分支** —— useMarkdown 里一个 switch
// （raw / md / code / json / json-min）、MarkdownToggle 里四个固定槽位、再加一套 gutter 宽度计算。
// 想加一个「Base64 解码」要同时改三处。收成注册表之后，**加动作 = 往 ACTIONS 里加一行**。
//
// 两条硬约定（照 data/displayToggles.js 的范式）：
//   · 每个动作必须声明 `group` —— 几十个动作不分组没法看（面板按组渲染小节）
//   · `match` 是**可选**的：声明了就只在内容匹配时出现；不声明就是通用动作，任何文本都能跑
//
// ⚠️ `match` 必须是**廉价纯函数**（只看首字符 / 单个正则，绝不做 JSON.parse）。
// 原因：动作轴要算「这一屏有哪些动作能跑」，会按「一屏条目 × 全部动作」调用它 ——
// 32 个动作 × 100 条就是 3200 次。JSON.parse 是 `run` 的事，不是 `match` 的事。
//
// ⚠️ 动作一律**不发网络请求**，全部在前端算。它是「看」的一部分，和「卡片怎么排版」同一层；
// 看的时候产生请求会让滚动时间流变成几百次调用（设计稿 §8 有完整论证）。
// 唯一要落盘的两个动作（另存 / 覆盖）走现成的 POST /text，**后端零改动**。
//
// ⚠️ 正文上限是 4096 字符（服务端 text.limit），所以这里不需要考虑大文本的性能问题。

// ⚠️★ 这个文件现在**只负责组装**。三份东西按职责拆开了：
//
//   `./actions/catalog.json`  46 条声明（id / 分组 / 图标 / 参数 / match 与 run 的**名字**）
//   `./actions/pure.js`       零 import 的实现 —— **桌面端的界面也跑这一份**（逐字节同步过去）
//   `./actions/impl.js`       需要 marked / highlight.js / opencc / pinyin / 替换模式表的实现
//
// 为什么这么拆：桌面那侧是一个**没有构建步骤**的普通页面，只能加载一个自足的模块。
// 拆之前这三样焊在一起，桌面要加动作库就只有「再抄一份 46 条」这一条路 —— 也就是第三份定义。
//
// ⚠️ 加一条动作 = catalog.json 加一条 + 在 pure.js（或 impl.js）里加实现。
// 漏了实现会在**装载时**当场抛错（下面那个 registry 查表），不会拖到用户点它才炸。

import catalog from './actions/catalog.json';
import * as pure from './actions/pure.js';
import * as impl from './actions/impl.js';
import { actionOutput, stepId, stepParams, makeStep } from './actions/pure.js';

/** 面板按这个顺序渲染小节（数据在 catalog.json 里，加分组要同时补 i18n）。 */
export const ACTION_GROUPS = catalog.groups;

/** 名字 → 实现。⚠️ pure 与 impl 有同名时会以后者为准（impl 只多不少，不该有同名）。 */
const REGISTRY = { ...pure, ...impl };

function resolve(name, where) {
    const fn = REGISTRY[name];
    if (typeof fn !== 'function') {
        throw new Error(
            `动作实现缺失：${name}（${where}）—— 声明在 catalog.json，实现要写进 pure.js 或 impl.js`,
        );
    }
    return fn;
}

/** 把声明里的名字换成真函数。字段顺序与拆分前一致（消费方按对象读，不看顺序）。 */
export const ACTIONS = catalog.actions.map((spec) => {
    const action = { ...spec };
    if (spec.match) {
        action.match = resolve(spec.match, `${spec.id}.match`);
    }
    action.run = resolve(spec.run, `${spec.id}.run`);
    return action;
});

// 这三个原本就由这个模块导出，继续从这里再导出（调用点一个字都不用改）。
export { stepId, stepParams, makeStep };
export { REPLACE_MODES, REPLACE_MODE_KEYS, renderFenced } from './actions/impl.js';

export function findAction(id) {
    return ACTIONS.find((action) => action.id === id);
}

/** 按 id 跑一条动作，返回它的输出（找不到那条动作 → 空串）。
 *
 * ⚠️★ 存在的理由只有一个：`/` 菜单里那几项「插入当前时间 / UUID」需要一个
 * **能当参数传出去**的运行器 —— `slash-template.js` 要零 import（桌面端也用它，
 * 见那个文件的抬头），所以「怎么跑一个动作」只能由调用方注入。
 * ⚠️ 别把它当成 `ACTIONS` 的通用入口：要拿动作对象就用 `findAction`。
 */
export async function runActionById(id) {
    const action = findAction(id);
    return action ? String((await action.run('')) ?? '') : '';
}

export function actionsInGroup(groupKey, direction = 'view') {
    return ACTIONS.filter((action) => action.group === groupKey && action.direction === direction);
}

export function matchedActions(text, direction = 'view') {
    return ACTIONS.filter(
        (action) => action.direction === direction && (!action.match || action.match(text)),
    );
}

export function targetedActions(text, direction = 'view') {
    return ACTIONS.filter(
        (action) => action.direction === direction && action.match && action.match(text),
    );
}

export async function runChain(text, chain, ctx = {}) {
    const steps = [];
    let current = String(text ?? '');
    let error = '';

    for (const step of chain) {
        // 链元素两种形态都认（见文件头的 stepId / stepParams）
        const id = stepId(step);
        const params = stepParams(step);
        const action = findAction(id);
        if (!action) {
            error = `未知动作: ${id}`;
            break;
        }
        const input = current;
        try {
            const raw = await action.run(input, ctx, params);
            // ⚠️★ 拆 `output` / `html` 走的是 pure.js 那份 `actionOutput` —— 桌面端跑的是
            // 同一个函数。别在这里自己 `String(raw)`：那样拿不到 `html`，
            // 于是「注音制表」在链条里只剩一行 tab 文本、丢了表格。
            const { output, html } = actionOutput(raw);
            steps.push({ id, params, action, input, output, html, error: '' });
            current = output;
        } catch (err) {
            const message = String(err?.message || err || '执行失败');
            steps.push({ id, params, action, input, output: '', html: '', error: message });
            error = message;
            break;
        }
    }

    return { steps, output: error ? '' : current, error };
}
