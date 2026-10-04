// 动作库里**不含任何 import** 的那一半实现 —— 两个渲染器共用的那一份。
//
// ⚠️★ 铁律：**一个 import 都不许有**（连 `./xx.json` 也不行）。
//
// 桌面端是一个没有构建步骤的普通页面，它只能 `import('./actions-pure.js')` 加载一个
// **自足**的模块。这里一旦出现裸定名（`@/util.js` 这种别名）或 JSON import，桌面侧会在
// 运行时加载失败 —— 而失败的样子是「动作菜单点了没反应」。需要 marked / highlight.js /
// opencc / pinyin-pro / 替换模式表的实现放在 `impl.js`。
//
// ⚠️ `ctx` 是**注入**的（调用方给 `{ t }`），所以 `ctx.t('…')` 不算外部依赖。
// 桌面侧传进来的 `t` 要认识那些键 —— 由 `tools/sync-action-catalog.mjs` 从
// `web-vue3/src/locales/*.json` 抽出（见那里的注释）。
//
// ⚠️ 这个文件由 `tools/sync-action-catalog.mjs` **逐字节**拷到
// `rust/crates/desktop/ui/actions-pure.js`，那边同样跑这份实现。

/** 把一条动作的返回值拆成「显示用的文本」与「可选的 HTML」。
 *
 * ⚠️★ 动作有**两种**返回形态，而这件事只有这一处知道：
 *   · 字符串            —— 绝大多数动作。半数还得按目录里 `render: 'html'` 再判一次
 *                        （markdown / 代码高亮吐的是 HTML **串**，双表示之外的另一回事）；
 *   · `{ html, text }`  —— **双表示**：html 用来渲染、text 用来复制。
 * 只有「注音制表」用第二种（它的对齐非得靠 `<table>` 排版，而复制出去要能粘进表格软件）。
 *
 * ⚠️★ 为什么不各写一个 `String(raw)` 了事：`String({ html, text })` 是 **`[object Object]`**
 * —— 桌面端就把这一整串画进了卡片，而动作本身**没报错**（点了有反应，只是结果是一串废话）。
 * 「哪些形态合法」只有一处答案，谁各自 `String` 一遍，谁就漏掉另一半。
 * 2026-10-03：桌面端把 8 个动作打包进去之后注音制表**仍然**显示不出来，根因就在这一步。
 *
 * @returns {{ output: string, html: string }}
 */
export function actionOutput(raw) {
    if (raw && typeof raw === 'object' && typeof raw.html === 'string') {
        return { output: String(raw.text ?? ''), html: raw.html };
    }
    return { output: String(raw ?? ''), html: '' };
}

export function isJsonLike(text) {
    const s = String(text || '').trim();
    return s.length > 1 && (s[0] === '{' || s[0] === '[');
}

export const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });

export function isBase64Like(text) {
    const s = String(text || '').trim();
    // ① 形状：至少 8 位（更短的解码出来没有意义）+ 长度是 4 的倍数 + 只含 base64 字符集。
    if (s.length < 8 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
        return false;
    }
    // ② 内容：解码出来必须是**合法 UTF-8**。
    //
    // ⚠️ 光靠 ① 会把 `abcdefgh` 这种普通英文单词也判成 base64（它确实只由 base64 字符组成）——
    // 于是每条英文短句都多一个「Base64 解码」，点下去才发现是错的。
    // 补这一步之后，纯字母单词解出来是非法字节序列，自然被挡在外面。
    //
    // 这一步仍然廉价（atob 是纯计算，几十字节的输入是微秒级），但**绝不能省**。
    try {
        const binary = atob(s);
        utf8StrictDecoder.decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
        return true;
    } catch {
        return false;
    }
}

export function isUrlEncodedLike(text) {
    return /%[0-9A-Fa-f]{2}/.test(String(text || ''));
}

export function isHtmlEntityLike(text) {
    return /&(#\d+|#x[0-9A-Fa-f]+|[a-zA-Z]+);/.test(String(text || ''));
}

export function isUnicodeEscapedLike(text) {
    return /\\u[0-9A-Fa-f]{4}/.test(String(text || ''));
}

export function hasMultipleLines(text) {
    return String(text || '').includes('\n');
}

export function isLongerThan(min) {
    return (text) => String(text || '').length > min;
}

export function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function base64ToUtf8(text) {
    const binary = atob(String(text || '').trim());
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function utf8ToHex(text) {
    return Array.from(new TextEncoder().encode(text))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ');
}

export function hexToUtf8(text) {
    const clean = String(text || '').replace(/[^0-9A-Fa-f]/g, '');
    if (clean.length % 2 !== 0) {
        throw new Error('hex 长度必须是偶数');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
        bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return new TextDecoder().decode(bytes);
}

export function toUnicodeEscapes(text) {
    const source = String(text || '');
    let out = '';
    for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        out += (code > 0x7e || code < 0x20)
            ? `\\u${code.toString(16).padStart(4, '0')}`
            : source[i];
    }
    return out;
}

export function fromUnicodeEscapes(text) {
    return String(text || '').replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function encodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function dedupeLines(text) {
    const seen = new Set();
    const out = [];
    for (const line of String(text || '').split('\n')) {
        // 空行不去重 —— 连着几个空行是有意的排版，去掉会改变结构
        if (line.trim() && seen.has(line)) {
            continue;
        }
        seen.add(line);
        out.push(line);
    }
    return out.join('\n');
}

export function sortLines(text) {
    return String(text || '').split('\n').sort((a, b) => a.localeCompare(b, 'zh')).join('\n');
}

export function dropBlankLines(text) {
    return String(text || '').split('\n').filter((line) => line.trim()).join('\n');
}

export function trimEachLine(text) {
    return String(text || '').split('\n').map((line) => line.trim()).join('\n');
}

export function reverseText(text) {
    // 用 Array.from 而不是 split('')：中文之外还有 emoji，代理对拆开就成乱码
    return Array.from(String(text || '')).reverse().join('');
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"'，。；：、（）【】《》「」“”]+|\bwww\.[^\s<>"'，。；：、（）【】《》「」“”]+/gi;

export const URL_HINT = /https?:\/\/|www\./i;

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export const EMAIL_HINT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

export const CN_PHONE_RE = /(?:^|\D)(1[3-9]\d{9})(?!\d)/g;

export const CN_PHONE_HINT = /(?:^|\D)1[3-9]\d{9}(?!\d)/;

export const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/g;

export const IPV4_HINT = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/;

export const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

export const NUMBER_HINT = /-?\d[\d,]*(?:\.\d+)?/;

export function extractAll(text, re) {
    const matches = String(text || '').match(re) || [];
    return [...new Set(matches)];
}

export function extractUrls(text) {
    return extractAll(text, URL_RE).join('\n');
}

export function extractEmails(text) {
    return extractAll(text, EMAIL_RE).join('\n');
}

export function extractPhones(text) {
    // 用了捕获组（为了左边界的 `(?:^|\D)`），所以要走 replace 把 `$1` 取出来
    const out = [];
    const seen = new Set();
    String(text || '').replace(CN_PHONE_RE, (_, phone) => {
        if (!seen.has(phone)) {
            seen.add(phone);
            out.push(phone);
        }
        return '';
    });
    return out.join('\n');
}

export function extractIps(text) {
    return extractAll(text, IPV4_RE).join('\n');
}

export function extractNumbers(text) {
    return extractAll(text, NUMBER_RE).join('\n');
}

export function toFullWidth(text) {
    return String(text || '')
        .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
        .replace(/ /g, '\u3000');
}

export function toHalfWidth(text) {
    return String(text || '')
        .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, ' ');
}

export const CN_PUNCT_MAP = {
    '，': ',', '。': '.', '、': ',', '；': ';', '：': ':',
    '？': '?', '！': '!', '（': '(', '）': ')', '【': '[', '】': ']',
    '《': '<', '》': '>', '「': '"', '」': '"', '『': "'", '』': "'",
    '“': '"', '”': '"', '‘': "'", '’': "'", '～': '~',
    '…': '.', '—': '-', '－': '-', '　': ' ',
};

export function cnPunctuationToEn(text) {
    return Array.from(String(text || '')).map((ch) => CN_PUNCT_MAP[ch] ?? ch).join('');
}

export const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export const CN_SMALL_UNITS = ['', '十', '百', '千'];

export const CN_BIG_UNITS = ['', '万', '亿', '万亿'];

export function cnSectionToText(section) {
    let out = '';
    let zeroPending = false;
    for (let i = 0; i < section.length; i++) {
        const digit = Number(section[i]);
        const unit = CN_SMALL_UNITS[section.length - 1 - i];
        if (digit === 0) {
            zeroPending = true;
            continue;
        }
        if (zeroPending && out) {
            out += CN_DIGITS[0];
        }
        zeroPending = false;
        out += CN_DIGITS[digit] + unit;
    }
    return out;
}

export function numberToChinese(raw) {
    const s = String(raw || '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
        throw new Error('不是合法数字');
    }
    const negative = s.startsWith('-');
    const body = negative ? s.slice(1) : s;
    const [intPart, decPart] = body.split('.');

    let intText = CN_DIGITS[0];
    const trimmed = intPart.replace(/^0+/, '');
    if (trimmed) {
        // 从右往左每 4 位切一节，chunks[0] 是最低节
        const chunks = [];
        for (let i = trimmed.length; i > 0; i -= 4) {
            chunks.unshift(trimmed.slice(Math.max(0, i - 4), i));
        }
        let out = '';
        chunks.forEach((chunk, idx) => {
            const bigUnit = CN_BIG_UNITS[chunks.length - 1 - idx];
            const sectionText = cnSectionToText(chunk);
            if (!sectionText) {
                // 整节是 0：只有前面已经有内容才补零（`10000` 不该变成「一万零」）
                if (out && !out.endsWith(CN_DIGITS[0])) {
                    out += CN_DIGITS[0];
                }
                return;
            }
            // 这节有内容、但首位是 0（数值不满千）且前面已有输出 → 中间要补零
            // （`10000001` → 一千万**零**一）
            if (out && chunk[0] === '0' && !out.endsWith(CN_DIGITS[0])) {
                out += CN_DIGITS[0];
            }
            out += sectionText + bigUnit;
        });
        intText = out.replace(/零+$/, '');
        // 中文习惯说「十」「十二」，不说「一十」「一十二」；但「一百一十」要保留
        intText = intText.replace(/^一十/, '十');
    }

    let out = intText;
    if (decPart) {
        out += '点' + Array.from(decPart).map((d) => CN_DIGITS[Number(d)]).join('');
    }
    return (negative ? '负' : '') + out;
}

export function translator(ctx) {
    return typeof ctx?.t === 'function' ? ctx.t : (key) => key;
}

export function textStats(text, ctx) {
    const tr = translator(ctx);
    const s = String(text || '');
    const chars = Array.from(s).length;
    const lines = s ? s.split('\n').length : 0;
    const bytes = new TextEncoder().encode(s).length;
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    // 词数：中文没有空格分词，按「汉字数 + 西文单词数」算 —— 混排时才不会漏
    const latinWords = (s.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
    return [
        `${tr('inspectChars')}: ${chars}`,
        `${tr('inspectWords')}: ${latinWords + cjk}`,
        `${tr('inspectLines')}: ${lines}`,
        `${tr('inspectBytes')}: ${bytes}`,
        `${tr('inspectCjk')}: ${cjk}`,
    ].join('\n');
}

export function timestampToDate(text) {
    const s = String(text || '').trim();
    if (!/^\d{9,13}$/.test(s)) {
        throw new Error('不是 10 位（秒）或 13 位（毫秒）时间戳');
    }
    const ms = s.length >= 13 ? Number(s) : Number(s) * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
        throw new Error('时间戳超出可表示范围');
    }
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
        + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function dateToTimestamp(text) {
    const s = String(text || '').trim();
    // 把 `2026/09/23` 这种斜杠写法归一成 `-`（Safari 对斜杠的解析行为不一致）
    const ms = Date.parse(s.replace(/\//g, '-'));
    if (Number.isNaN(ms)) {
        throw new Error('认不出这个日期');
    }
    return String(Math.floor(ms / 1000));
}

export function detectFormat(text, ctx) {
    const tr = translator(ctx);
    const s = String(text || '').trim();
    const hits = [];
    if (isJsonLike(s)) {
        try {
            JSON.parse(s);
            hits.push('JSON');
        } catch {
            // 首字符像 JSON 但不是合法 JSON —— 不列，避免误导
        }
    }
    if (isBase64Like(s)) {
        hits.push('Base64');
    }
    if (/^(?:[0-9A-Fa-f]{2}[\s-]?)+$/.test(s) && s.replace(/[^0-9A-Fa-f]/g, '').length % 2 === 0) {
        hits.push('Hex');
    }
    if (isUrlEncodedLike(s)) {
        hits.push('URL encoded');
    }
    if (isHtmlEntityLike(s)) {
        hits.push('HTML entity');
    }
    if (isUnicodeEscapedLike(s)) {
        hits.push('Unicode escape');
    }
    if (/^\d{9,13}$/.test(s)) {
        hits.push('Unix timestamp');
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
        hits.push('UUID');
    }
    if (/^#[0-9A-Fa-f]{3,8}$/.test(s)) {
        hits.push('Hex color');
    }
    if (looksLikeMarkdown(s)) {
        hits.push('Markdown');
    }
    return hits.length ? hits.join(' / ') : tr('inspectNoMatch');
}

export async function sha256(text, ctx) {
    const tr = translator(ctx);
    if (!globalThis.crypto?.subtle) {
        throw new Error(tr('inspectHashNeedsHttps'));
    }
    const bytes = new TextEncoder().encode(String(text || ''));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export const DATE_KEYWORDS = {
    今天: 0, 明天: 1, 昨天: -1,
    today: 0, tomorrow: 1, yesterday: -1,
};

export const DATE_CORE = String.raw`(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日?|\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))`;

export const DATE_TIME_PART = String.raw`(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?`;

export const DATE_TOKEN_RE = new RegExp(
    `^(?:${DATE_CORE}${DATE_TIME_PART}|今天|明天|昨天|today|tomorrow|yesterday)?$`,
    'i',
);

export function parseDateToken(raw) {
    const s = String(raw || '').trim();
    if (!s) {
        return null; // 空 = 调用方自己决定默认值（date.add 用「今天」）
    }

    const offsetDays = DATE_KEYWORDS[s.toLowerCase()];
    if (offsetDays !== undefined) {
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        return d;
    }

    // 带时间分隔符的两种写法（ISO / 斜杠、中文），以及不带时间的紧凑 8 位
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
        || s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
        || s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) {
        return null;
    }
    const [, y, mo, d, hh, mi, ss] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh || 0), Number(mi || 0), Number(ss || 0));

    // ⚠️ 回读校验：`2026-02-31` 会被 Date **悄悄滚到** 3 月 3 日。不校验的话，
    // 用户写错了日期却拿到一个「看起来正常」的结果 —— 比直接报错糟糕得多。
    if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) {
        return null;
    }
    return date;
}

export function formatDate(date, withTime) {
    const p = (n) => String(n).padStart(2, '0');
    const base = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    return withTime ? `${base} ${p(date.getHours())}:${p(date.getMinutes())}` : base;
}

export function addMonths(date, n) {
    const day = date.getDate();
    const result = new Date(date.getTime());
    result.setDate(1);
    result.setMonth(result.getMonth() + n);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, lastDay));
    return result;
}

export function startOfDayMs(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export const DAY_MS = 86400000;

export function dateAdd(text, ctx) {
    const tr = translator(ctx);
    const s = String(text || '').trim();
    const m = s.match(/^(.*?)\s*([+-])\s*(\d+)\s*([dwmy]?)\s*$/i);
    if (!m) {
        throw new Error(tr('actionDateAddHint'));
    }
    const [, baseRaw, sign, amountRaw, unitRaw] = m;

    const parsedBase = parseDateToken(baseRaw);
    if (baseRaw.trim() && !parsedBase) {
        // 写了基准但认不出 → 报错。**别悄悄回落到「今天」** —— 那会让用户拿到一个
        // 看着合理、其实完全不对的结果。
        throw new Error(tr('actionDateUnrecognized'));
    }

    const base = parsedBase || new Date(); // 没写基准 = 今天
    const amount = Number(amountRaw) * (sign === '-' ? -1 : 1);
    const unit = (unitRaw || 'd').toLowerCase();
    const withTime = /:/.test(baseRaw); // 基准带时间就保留时间，否则只给日期

    let result;
    if (unit === 'm') {
        result = addMonths(base, amount);
    } else if (unit === 'y') {
        result = addMonths(base, amount * 12);
    } else {
        result = new Date(base.getTime());
        result.setDate(result.getDate() + (unit === 'w' ? amount * 7 : amount));
    }
    return formatDate(result, withTime);
}

export function dateDiff(text, ctx) {
    const tr = translator(ctx);
    const s = String(text || '').trim();

    // 两个日期：优先按分隔符拆，否则按行拆（一行一个）
    let parts = s.split(/\s*(?:~|～|→|->|至|到|\.\.+)\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) {
        parts = s.split('\n').map((x) => x.trim()).filter(Boolean);
    }
    if (parts.length < 2) {
        throw new Error(tr('actionDateDiffHint'));
    }

    const a = parseDateToken(parts[0]);
    const b = parseDateToken(parts[1]);
    if (!a || !b) {
        throw new Error(tr('actionDateUnrecognized'));
    }

    const days = Math.round((startOfDayMs(b) - startOfDayMs(a)) / DAY_MS);
    const abs = Math.abs(days);
    const weeks = Math.floor(abs / 7);
    const rest = abs % 7;

    const lines = [`${days} ${tr('actionDateUnitDay')}`];
    if (weeks) {
        lines.push(`${weeks} ${tr('actionDateUnitWeek')} ${rest} ${tr('actionDateUnitDay')}`);
    }
    return lines.join('\n');
}

export function looksLikeDateAdd(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 40) {
        return false;
    }
    const m = s.match(/^(.*?)\s*([+-]\s*\d+\s*[dwmy]?)$/i);
    return Boolean(m) && DATE_TOKEN_RE.test(m[1].trim());
}

export function looksLikeDateDiff(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 80) {
        return false;
    }
    let parts = s.split(/\s*(?:~|～|→|->|至|到|\.\.+)\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) {
        parts = s.split('\n').map((x) => x.trim()).filter(Boolean);
    }
    return parts.length === 2 && DATE_TOKEN_RE.test(parts[0]) && DATE_TOKEN_RE.test(parts[1]);
}

export function pad(n) {
    return String(n).padStart(2, '0');
}

export function nowTime() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function nowDateTime() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${nowTime()}`;
}

export function newUuid() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // 老浏览器兜底（非安全上下文里 crypto.randomUUID 不存在）
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
    });
}

export function stepId(step) {
    if (typeof step === 'string') {
        return step;
    }
    return String(step?.id || '');
}

export function stepParams(step) {
    if (step && typeof step === 'object' && step.params && typeof step.params === 'object') {
        return step.params;
    }
    return {};
}

export function makeStep(id, params) {
    const clean = {};
    Object.keys(params || {}).forEach((key) => {
        const value = String(params[key] ?? '');
        if (value !== '') {
            clean[key] = value;
        }
    });
    return Object.keys(clean).length ? { id, params: clean } : id;
}

export function matchMarkdown(text) {
    return looksLikeMarkdown(text) || looksLikeTaskList(text) || looksLikeTable(text);
}

export function runJsonPretty(text) {
    const out = formatJson(text);
    if (!out) {
        throw new Error('已经是美化过的 JSON');
    }
    return out;
}

export function runJsonMin(text) {
    const out = minifyJson(text);
    if (!out) {
        throw new Error('已经是一行，压不动了');
    }
    return out;
}

export function runUrl(text) {
    return encodeURIComponent(text);
}

export function runUrlDecode(text) {
    return decodeURIComponent(text);
}

export function matchHexDecode(text) {
    return /^(?:[0-9A-Fa-f]{2}[\s-]?)+$/.test(String(text || '').trim());
}

export function runUpper(text) {
    return String(text || '').toUpperCase();
}

export function runLower(text) {
    return String(text || '').toLowerCase();
}

// 有内容就能跑。空正文也放它进来 —— 让它跑到 run 里报一句具体的
// 「请先填『查找』的内容」，比在这里静默不出现好（用户至少知道为什么点了没反应）。
export function matchReplace(text) {
    return String(text || '').length > 0;
}

export const matchReverse = isLongerThan(1);

export function matchExtractUrl(text) {
    return URL_HINT.test(String(text || ''));
}

export function matchExtractEmail(text) {
    return EMAIL_HINT.test(String(text || ''));
}

export function matchExtractPhone(text) {
    return CN_PHONE_HINT.test(String(text || ''));
}

export function matchExtractIp(text) {
    return IPV4_HINT.test(String(text || ''));
}

export function matchExtractNumber(text) {
    return NUMBER_HINT.test(String(text || ''));
}

// 「含 ASCII 可打印字符」= 还有得转。已经全是全角的文本不该出现这个动作。
export function matchFullwidth(text) {
    return /[!-~]/.test(String(text || ''));
}

export function matchHalfwidth(text) {
    return /[\uff01-\uff5e\u3000]/.test(String(text || ''));
}

export function matchPunctuation(text) {
    return /[，。、；：？！（）【】《》「」『』“”‘’…—－　]/.test(String(text || ''));
}

export function matchNumber(text) {
    return /^-?\d+(\.\d+)?$/.test(String(text || '').trim());
}

export function matchPinyin(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
}

export function matchPinyinTable(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
}

export function matchPinyinWord(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
}

export function matchSimplified(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
}

export function matchTraditional(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''));
}

export function matchTimestamp(text) {
    return /^\d{9,13}$/.test(String(text || '').trim());
}

// ⚠️ Date.parse 相对贵，**不能**对每条内容都跑。先用长度 + 形状挡一道，
// 形状像日期了才真去解析 —— 这是 match 必须廉价这条约定的具体落法。
export function matchDateToTimestamp(text) {
    const s = String(text || '').trim();
    return s.length >= 8 && s.length <= 32
        && /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)
        && !Number.isNaN(Date.parse(s.replace(/\//g, '-')));
}

export function runTime() {
    return nowTime();
}

export function runDatetime() {
    return nowDateTime();
}

export function runUuid() {
    return newUuid();
}


// ── 从 `util.js` 搬来的纯函数 ────────────────────────────────────────
// ⚠️ 它们原本住在 `@/util.js`（那个文件 import 了 axios / marked / DOMPurify，桌面端加载不了）。
// `util.js` 现在从**这里**再导出，所以两边的调用点都不用改。
// 一眼就是代码的行首关键字。**故意列得宽**（Jonny 要求「不必太保守」）：
// 宁可把一段像代码的东西当代码 —— 那只是多一个图标，用户还能切回原文 / md；
// 而漏判的代价是「只能点 md，然后看着 markdown 把代码重排」。
//
// ⚠️ `type` 一开始**被我故意排除了**（怕撞英文散文的「Type ...」），结果 Go 的
// `type ID = int` 这种单行、又不带 `{` `}` 的定义就认不出来（Jonny 报的）。
// 权衡之后收回来：多一个图标 vs 少一个视图 —— 宁可多。
// 仍然不收 `from` / `use` / `new` 这几个：它们所在的语言另有更明确的信号
// （Python 有 `import`/`def`、Rust 有 `impl`/`fn`、TS 有 `const`/`interface`）。
export const CODE_HINT_RE = /(^|\n)\s*(package|import|export|require|module|func|fn|def|class|struct|interface|enum|trait|impl|namespace|public|private|protected|static|final|void|return|const|let|var|val|type|defer|chan|async|await|throw|except|elif|lambda|#include|#!|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|printf|println|console|echo|puts)\b/;

// 没有关键字时看行首的代码结构：if/for/while 开头，或 `{` `}` `;` 收尾。
export const CODE_LINE_RE = /([{};]\s*$|^\s*(if|for|while|else|try|catch|switch|case|do)\b)/;

// 代码的**形状**，不依赖关键字：`;` `{}` 收尾、`foo(...)` 调用、箭头 / 管道 / 泛型、
// 标签、模板插值、`%s` 这类格式符。
export const CODE_SHAPE_RE = /([;{}]\s*$|\w\s*\([^)]*\)\s*[;{]|=>|->|::|<\/?[a-z][\w-]*>|\$\{[^}]*\}|%[sdvf]\b)/;

/**
 * 把 HTML 实体还原成文本。
 *
 * 服务端存的是实体编码过的正文（`<` 之类），卡片里要显示原文就得先解回来。
 * **全站唯一实现** —— 之前 Text.vue / File.vue / StickyNote 各写了一份（第 4 份正在路上）。
 */
export function decodeHtmlEntities(text) {
    const el = document.createElement('textarea');
    el.innerHTML = String(text ?? '');
    return el.value;
}

/**
 * 把 JSON 美化（两空格缩进）。
 *
 * **不是 JSON、或本来就已美化过 → 返回空串**：调用方据此决定要不要给这个入口 ——
 * 已经美化过的内容上再放一个「美化」按钮，点了没反应，比没有更差。
 */
export function formatJson(text) {
    const raw = String(text || '');
    const parsed = parseJsonObject(raw);
    if (parsed === undefined) {
        return '';
    }
    const pretty = JSON.stringify(parsed, null, 2);
    return pretty === raw.trim() ? '' : pretty;
}

/**
 * 内容像**一段源码**吗（决定要不要给「代码」视图那个图标）。
 *
 * 判定顺序（从便宜到贵）：
 *   1. 已经带 ``` 围栏的**不算** —— 那本来就是 markdown，围栏里的代码会被 MarkdownBody 高亮；
 *   2. 是合法 JSON 的**不算** —— JSON 有自己的「美化 / 压缩」两个视图，别抢；
 *   3. 行首命中关键字 → 是；
 *   4. **单行**也能是代码：看形状（`const a = 1;` / `foo(1, 2)`）；
 *   5. 多行：看「像代码的行」占比，门槛 1/4（一段代码里常夹空行和注释）。
 */
export function looksLikeCode(text) {
    const s = String(text || '');
    if (!s.trim() || s.length > 20000) {
        return false;
    }
    if (/^\s*```|[\r\n]\s*```/.test(s)) {
        return false;
    }
    if (parseJsonObject(s) !== undefined) {
        return false;
    }
    if (CODE_HINT_RE.test(s)) {
        return true;
    }
    const lines = s.split('\n').filter((line) => line.trim());
    if (lines.length < 2) {
        const one = s.trim();
        // 单行也常是代码：`foo(1, 2)` / `const a = 1;` / `x => x + 1`。
        // 末一条**要求整行就是一个调用**（`标识符(...)`），否则散文里的「见附录 (a)」
        // 也会被算进去 —— 中文不算 `\w`，所以那条天然挡得住。
        return CODE_SHAPE_RE.test(one) || /^[A-Za-z_$][\w.$]*\s*\([^)]*\)\s*[;{]?$/.test(one);
    }
    const codeLines = lines.filter((line) => CODE_LINE_RE.test(line) || CODE_SHAPE_RE.test(line)).length;
    return codeLines >= Math.max(2, Math.ceil(lines.length / 4));
}

export function looksLikeMarkdown(text) {
    const s = String(text || '');
    // 太长不渲染：一个几万字的条目渲染一次就够列表卡一下了
    if (!s.trim() || s.length > 20000) return false;
    return /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```)/.test(s)
        || /\[[^\]]+\]\([^)\s]+\)/.test(s)                    // [文字](链接)
        || /\*\*[^\s][^*]*\*\*|__[^\s][^_]*__/.test(s)         // 粗体
        || /`[^`\n]+`/.test(s)                                  // 行内代码
        || looksLikeTable(s);                                   // 表格：上面几条都认不出来
}

/**
 * 内容里有 GFM 表格。
 *
 * 判据是「表头行 + 紧跟一行分隔线」，不是「有竖线」：随手打的 `a | b` 到处都是
 * （shell 管道、位运算），拿竖线当判据会误判一大片。分隔线（`|---|---|`）才是表格的签名。
 */
export function looksLikeTable(text) {
    const lines = String(text || '').split('\n');
    for (let i = 0; i + 1 < lines.length; i++) {
        if (!lines[i].includes('|')) continue;
        if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
            return true;
        }
    }
    return false;
}

/**
 * 内容里有 GFM 任务列表（`- [ ] xxx` / `- [x] xxx`）。
 *
 * 有序变体（`1. [ ]`）也算 —— GFM 允许，渲染出来同样是复选框。
 * 只看行首标记，不看缩进层级：嵌套任务列表的每一行都以 `- [ ]` 开头，自然命中。
 */
export function looksLikeTaskList(text) {
    return /(^|\n)\s{0,3}([-*+]|\d+\.)\s+\[[ xX]\](\s|$)/.test(String(text || ''));
}

/**
 * 把 JSON 压成一行。**不是 JSON、或本来就是一行 → 返回空串**（同 formatJson 的约定：
 * 点了没反应的按钮比没有更差）。
 */
export function minifyJson(text) {
    const raw = String(text || '');
    const parsed = parseJsonObject(raw);
    if (parsed === undefined) {
        return '';
    }
    const compact = JSON.stringify(parsed);
    return compact === raw.trim() ? '' : compact;
}

/**
 * 内容像不像 markdown。
 *
 * 为什么要判断而不是无脑渲染：剪贴板里绝大多数是普通文本，而 markdown 的标记跟日常
 * 符号高度重合 —— `5 * 3 = 15` 会被渲染成斜体、`1. 打开设置` 会被当成有序列表。
 * 所以宁可漏判：漏判的代价是用户看到原文，误判的代价是内容被改形。
 */
// 解析一段 JSON。**只认对象和数组** —— 裸的 `123` / `"abc"` / `true` 也是合法 JSON，
// 但对它们做「美化」没有任何意义，却会让这类普通文本凭空多出一个图标。认不出来返回 undefined。
export function parseJsonObject(text) {
    const s = String(text || '').trim();
    if (!s) {
        return undefined;
    }
    // 先按首字符挡一道：绝大多数普通文本到这就出去了，不用去试 JSON.parse。
    if (s[0] !== '{' && s[0] !== '[') {
        return undefined;
    }
    try {
        const value = JSON.parse(s);
        return value !== null && typeof value === 'object' ? value : undefined;
    } catch {
        return undefined;
    }
}
