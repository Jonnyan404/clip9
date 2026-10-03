// 代码高亮 —— 按扩展名选语言，高亮器**按需加载**。
//
// 为什么按需：highlight.js 加上二十几个语言包不是个小数目，而这个 app 的主路径
// （收发剪贴板）根本用不到它。`import()` 会让打包器单独切一个 chunk，
// 只有真的预览到代码文件时才去下载 —— 不预览的人一个字节都不付。
//
// 为什么不用 `highlightAuto`：它要把所有语言都试一遍，慢，而且经常认错
// （一段 YAML 被判成 Ruby 那种）。扩展名我们本来就有（`filePreviewKind` 也是按它判的），
// 直接映射更准也更快；认不出来就老老实实按纯文本渲染。
//
// ⚠️ 映射表**只此一份**。要加语言：这里登记扩展名 + `highlight-langs.js` 里注册。

// 扩展名 → highlight.js 的语言名。**没登记的一律不猜**（返回空串 → 纯文本渲染）。
const LANGUAGE_BY_EXT = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
    // 没有单独的 vue/html 语言包，用 xml（highlight.js 的 xml 就包含 HTML 方言）
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    yml: 'yaml',
    yaml: 'yaml',
    // toml / properties / .env 都归到 ini：键值对那一类，配色够用且不用再引包
    toml: 'ini',
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    properties: 'ini',
    env: 'ini',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    bat: 'dos',
    cmd: 'dos',
    go: 'go',
    py: 'python',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    rb: 'ruby',
    php: 'php',
    rs: 'rust',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hh: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    swift: 'swift',
    sql: 'sql',
    proto: 'protobuf',
    diff: 'diff',
    patch: 'diff',
    dockerfile: 'dockerfile',
};

let pending = null;

// 只加载一次。**失败也缓存住** —— 同一个会话里别为了一个拉不到的 chunk 反复重试。
function loadHighlighter() {
    if (!pending) {
        pending = import('./highlight-langs.js')
            .then((mod) => mod.default)
            .catch(() => null);
    }
    return pending;
}

// 已注册的语言名本身。markdown 的 ``` 代码块给的就是语言名（```js / ```python），
// 不是文件名 —— 所以两种输入都要认。
const LANGUAGE_IDS = new Set([
    'bash', 'c', 'cpp', 'css', 'diff', 'dockerfile', 'dos', 'go', 'ini', 'java',
    'javascript', 'json', 'kotlin', 'less', 'markdown', 'php', 'powershell',
    'protobuf', 'python', 'ruby', 'rust', 'scss', 'sql', 'swift', 'typescript',
    'xml', 'yaml',
]);

/**
 * 该用哪个高亮语言。两种输入都认（认不出来返回空串）：
 *   · **文件名**：`app.ts` → typescript、`Dockerfile` → dockerfile；
 *   · **语言名本身**：```js → javascript、```python → python。
 */
export function highlightLanguageFor(name) {
    const value = String(name || '').trim().toLowerCase();
    if (!value) {
        return '';
    }
    if (LANGUAGE_IDS.has(value)) {
        return value;
    }
    const dot = value.lastIndexOf('.');
    // 没有扩展名时拿整个名字去查 —— `Dockerfile` 就是这么被认出来的。
    const ext = dot < 0 ? value : value.slice(dot + 1);
    return LANGUAGE_BY_EXT[ext] || '';
}

/**
 * 猜一段源码是什么语言（给「代码视图」用）。
 *
 * 只在切到代码视图时调一次，别拿它到处跑 —— `highlightAuto` 会把注册过的语言挨个试一遍。
 *
 * 返回已注册的语言名，**认不出来返回空串**（调用方按无语言渲染：格式照样是转义后的原文，
 * 只是没颜色 —— 认错比不认更糟，满屏乱配色）。
 */
export async function detectLanguage(code) {
    const source = String(code || '').trim();
    if (!source) {
        return '';
    }
    const hljs = await loadHighlighter();
    if (!hljs) {
        return '';
    }
    try {
        const result = hljs.highlightAuto(source, [...LANGUAGE_IDS]);
        // relevance 是 highlight.js 给的匹配度，太低就别硬认。
        return result.relevance > 5 ? result.language : '';
    } catch {
        return '';
    }
}

/**
 * 把源码转成高亮后的 HTML。
 *
 * **返回 `null` 表示「按纯文本渲染」**：认不出语言、语言包没注册、高亮器没加载起来，
 * 全都走这条路 —— 代码照样看得到，只是没颜色，绝不能因为高亮失败让预览空掉。
 *
 * ⚠️ 返回值直接进 `v-html`。highlight.js **自己会转义输入**，所以这样是安全的；
 * 也正因为如此，**不要再往上拼任何没转义的内容**（那才是 XSS 的口子）。
 */
/**
 * 给一段**已经渲染成 DOM** 的 markdown 里的 ``` 代码块上色。
 *
 * ⚠️★ 为什么在**渲染之后**回头处理，而不是挂 marked 的 renderer：marked 的 renderer 是
 * **同步**的，而高亮器是 `import()` 按需加载的 —— 在 renderer 里 await 不了。
 * 所以先照常渲染（代码本来就是转义好的纯文本，看得见），再把这些块找出来上色。
 *
 * ⚠️★ 为什么收在这个文件里而不是留在组件里：桌面端也要这一步（它画的是同一段 HTML，
 * 但没有 Vue 组件）。留在 `MarkdownBody.vue` 里，桌面就只能抄一份 —— 而抄的那份
 * 一定会在「哪种块算代码块」这种地方慢慢漂走。这里是**唯一实现**，
 * `MarkdownBody.vue` 与桌面端的动作库都调它。
 */
export async function highlightCodeBlocksIn(el) {
    if (!el) {
        return;
    }
    const blocks = el.querySelectorAll('pre > code[class*="language-"]');
    for (const block of blocks) {
        if (block.classList.contains('hljs')) {
            continue;
        }
        const lang = (block.className.match(/language-([\w+#.-]+)/) || [])[1] || '';
        const source = block.textContent || '';
        if (!lang || !source) {
            continue;
        }
        const html = await highlightCode(source, lang);
        if (html) {
            // ⚠️ 直接进 innerHTML：highlight.js 自己会转义输入，所以是安全的；
            // 也正因为如此，**不要再往上拼任何没转义的内容**。
            block.innerHTML = html;
            block.classList.add('hljs');
        }
    }
}

export async function highlightCode(code, name) {
    const language = highlightLanguageFor(name);
    if (!language) {
        return null;
    }
    const hljs = await loadHighlighter();
    if (!hljs || !hljs.getLanguage(language)) {
        return null;
    }
    try {
        return hljs.highlight(String(code ?? ''), { language, ignoreIllegals: true }).value;
    } catch {
        return null;
    }
}
