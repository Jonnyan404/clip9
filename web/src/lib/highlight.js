// 代码高亮 —— 按扩展名选语言，高亮器**按需加载**。
//
// 为什么按需：highlight.js 加上二十几个语言包不是个小数目，而这个 app 的主路径
// （收发剪贴板）根本用不到它。`import()` 会让打包器单独切一个 chunk，
// 只有真的预览到代码文件时才去下载 —— 不预览的人一个字节都不付。
//
// 为什么**优先**按扩展名 / 语言标记映射：`highlightAuto` 要把所有语言都试一遍，慢，
// 而且经常认错（一段 YAML 被判成 Ruby 那种）。扩展名我们本来就有（`filePreviewKind`
// 也是按它判的），直接映射更准也更快。
//
// ⚠️ 但**没有**任何标记时（markdown 里 ``` 后面直接换行 —— 贴代码的人大多这么写），
//    **不猜语言**（2026-10-30 Jonny 的决定，`highlightAuto` 对短片段实测全崩：
//    sql 判成 bash、rust 判成 javascript、单行 js 判不出），改用 `colorizePlain`
//    按词轮流上色 —— 不声称知道语言，所以不会给出错误结论。
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
 * **没有语言标记**时用的着色：不看语法，按「词」轮流上色。
 *
 * 这套抄的是 Artalk 用的 `hanabi`（「Highlight any code, in a colorful way」）：不判断语言，
 * 只把连续的「词」按调色板顺序染色，**同一个词永远同一个颜色** —— 于是 `function` 出现五次
 * 是同一个色，`foo` / `bar` 各一色，扫一眼就能认出哪两个标识符是同一个。注释单独灰掉。
 *
 * 为什么值得单独一个实现：
 *   · 没写语言的代码块占多数（``` 后面直接换行），而**猜语言猜不准**：实测
 *     `select … from users` 被猜成 bash、`fn main(){}` 被猜成 javascript、单行 js 干脆猜不出
 *     （见 `highlightCodeBlocksIn` 里那段）。猜错是给出**错误结论**；通用着色压根不声称
 *     自己知道那是什么语言，所以不会错，只是"每个词一个色"。
 *   · 对非代码同样无害：中文/日文也被当成「词」，贴一段诗进去也是彩色的。
 *     反倒按某门语言的语法去染，会把中文标点周围染得一塌糊涂。
 *
 * ⚠️★ **这条路是自己拼 HTML 的，必须自己转义**。highlight.js 那条路是它内部转义的。
 *   漏了就是一个 XSS 口子（内容来自别人的剪贴板）。
 * ⚠️ `https://…` 里的 `//` 不是注释 —— 判定前先看它前一个字符是不是冒号。
 */
const TONE_COUNT = 8;

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);

// 注释那个分支在前：同一位置上优先命中它。
// `\p{L}` / `\p{N}` 覆盖所有语言的字母与数字（含中日韩），所以中文诗句会整句算一个「词」。
const PLAIN_TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|([\p{L}\p{N}_]+)/gu;

export function colorizePlain(code) {
    const source = String(code || '');
    if (!source) {
        return '';
    }
    const tones = new Map();
    let next = 0;
    let out = '';
    let last = 0;
    for (const match of source.matchAll(PLAIN_TOKEN_RE)) {
        out += escapeHtml(source.slice(last, match.index));
        const [, comment, word] = match;
        if (comment) {
            // ⚠️ `https://…` / `curl x://y` 里的 `//` 不是注释：前一个是冒号就当普通文本。
            if (comment.startsWith('//') && source[match.index - 1] === ':') {
                out += escapeHtml(comment);
            } else {
                out += `<span class="hljs-comment">${escapeHtml(comment)}</span>`;
            }
        } else {
            let tone = tones.get(word);
            if (tone === undefined) {
                tone = next;
                tones.set(word, tone);
                next = (next + 1) % TONE_COUNT;
            }
            out += `<span class="hljs-tone-${tone}">${escapeHtml(word)}</span>`;
        }
        last = match.index + match[0].length;
    }
    out += escapeHtml(source.slice(last));
    return out;
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
    // ⚠️★ 选择器是 `code`（不是 `pre > code`），**行内代码也要上色**（2026-10-30 Jonny：
    //    「包括单行代码也是」）。行内代码本来只有一颗底色、文字还是正文色；
    //    走同一套之后 `npm run dev` 也会是两个颜色。
    //    之前只选 `pre > code` 是因为那时只有「按语言的语法高亮」这一条路 ——
    //    行内代码没有语言可言，自然被排除。现在有 `colorizePlain`，这个限制就没理由了。
    // ⚠️ 行内代码**永远**走 `colorizePlain`：markdown 的行内代码语法不支持指定语言，
    //    真出现 `language-` 类（页面里嵌的原始 HTML）也照旧按语言处理，不特殊对待。
    const codes = el.querySelectorAll('code');
    for (const code of codes) {
        if (code.classList.contains('hljs')) {
            continue;
        }
        const declared = (code.className.match(/language-([\w+#.-]+)/) || [])[1] || '';
        const source = code.textContent || '';
        if (!source) {
            continue;
        }
        // ⚠️★ 写了语言 → 按那门语言高亮；**没写就完全不猜**，走语言无关的通用着色。
        //
        // 原来是「没写就拿 `highlightAuto` 猜一次」，2026-10-30 撤掉：实测短片段根本猜不准 ——
        // `select … from users` 被猜成 bash（sql 连前三都没进）、`fn main(){}` 被猜成
        // javascript（和 rust 同分 4）、`const greeting = "hello";` 干脆猜不出。
        // 这不是阈值调得低不低的问题：这些片段 relevance 只有 1~5 分，第一名和第二名基本
        // 并列，还有 `ini`（`key = value` 就能拿分）在抢。降阈值只会把「漏掉」换成「猜错」，
        // 而**猜错比漏掉更糟** —— 用户看到的是「这段 JS 被标成了 C++ 的语法色」。
        //
        // 不猜之后用什么：`colorizePlain` 按「词」轮流上色（Artalk 的 `hanabi` 那套），
        // 不看语法、所以对任何内容都不会给出错误结论，纯文本也有颜色。
        const html = declared ? await highlightCode(source, declared) : colorizePlain(source);
        if (html) {
            // ⚠️ 直接进 innerHTML：上面两条路（highlight.js / colorizePlain）都自己转义了输入，
            // 所以是安全的；也正因为如此，**不要再往上拼任何没转义的内容**。
            code.innerHTML = html;
            code.classList.add('hljs');
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
