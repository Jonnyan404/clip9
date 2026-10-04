// markdown → 可以安全插进 DOM 的 HTML。
//
// 从 web-vue3/src/util.js 的 renderMarkdownHtml 段移植。分工说明：
//   · 纯文本工具（判型 / 格式化 / 转义）在 `lib/util.ts`；
//   · 这里只放**依赖 marked / DOMPurify** 的那一部分。
// ⚠️ 为什么单独一个文件：`lib/actions/impl.js`（.js）要 import 它，而 impl.js 是
//    「动作库的带依赖实现」—— 让 .js 与 .js 相互引用最省事，不牵扯 .ts 的解析。
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * **必须清洗**：内容可能是别人发过来的，`<img src=x onerror=...>` 这类注入是真实风险
 * —— 剪贴板本身就是个「别人能往你这里塞字符串」的通道。DOMPurify 默认配置会去掉
 * script、事件属性、javascript: 这类 URL。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.interactiveTasks] 任务列表的复选框可点。默认 false（清洗后
 *        `disabled` 会被去掉但没人处理点击，看着能点其实没反应）—— 只有真的会接住
 *        点击的调用点才开。
 */
let allowCheckboxInteraction = false;
let checkboxHookInstalled = false;
function ensureCheckboxHook() {
    if (checkboxHookInstalled) return;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (!allowCheckboxInteraction) return;
        if (node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox') {
            // marked 给任务列表的复选框加 `disabled`；要能点就得摘掉。
            // 只在交互开关打开时摘 —— 否则聊天气泡里的复选框也能点，而那里没人接住点击。
            node.removeAttribute('disabled');
        }
    });
    checkboxHookInstalled = true;
}

export function renderMarkdownHtml(text, opts = {}) {
    ensureCheckboxHook();
    const html = marked.parse(String(text || ''), { breaks: true, gfm: true });
    allowCheckboxInteraction = Boolean(opts.interactiveTasks);
    try {
        return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    } finally {
        allowCheckboxInteraction = false;
    }
}
