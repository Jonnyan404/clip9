#!/usr/bin/env node
// 契约守卫 —— 检查 React 版**没有破坏那几条「改错不报错、只静默退化」的跨端/工程契约**。
//
// 用法：node scripts/check-contracts.mjs
//
// ⚠️★ 为什么需要它：迁移计划 §1.5 列的八条红线里，有四条是**纯静态**可查的，而它们一旦破坏
// 都不会在构建期报错：
//   A. 零 import 共享模块（逐字节同步到桌面端）
//   B. index.html 的外壳形状（服务端按字符串定位注入 <base> / OG）
//   D. PWA 的 navigateFallbackDenylist（漏一条服务端路由 → SW 导航兜底吞掉点击）
// 所以这里用脚本钉住，让「改坏了」变成**构建期可见**的失败。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');

const problems = [];

// ── A. 零 import 共享模块（会被逐字节拷到桌面端，那边没有构建步骤）──────
// ⚠️ 这些文件由 tools/sync-action-catalog.mjs 逐字节拷到 rust/crates/desktop/ui/，
// 桌面端没有构建步骤 —— 一旦引入 `@/` 别名或第三方 import，那边运行时加载失败
// （症状是「点分享没反应」，不是报错）。
// ⚠️★ 2026-10-30：`web-vue3/` 删了，这条原先还跟它那份副本逐字节比。
// 「页面这份和桌面那份一字不差」现在由 `action-catalog-smoke` 的判据 4 负责
// （它比的是真源与拷贝）；这里只留「零 import」这一半。两处各管一件事，别都松掉。
const SHARED = [
    'src/lib/actions/pure.js',
    'src/lib/actions/catalog.json',
    'src/lib/share-config.js',
    'src/lib/slash-template.js',
    'src/lib/replace-modes.json',
];

for (const mine of SHARED) {
    const minePath = join(WEB, mine);
    if (!existsSync(minePath)) {
        problems.push(`缺文件 ${mine}`);
        continue;
    }
    // 零 import 检查（只对 .js；.json 无 import 概念）
    if (mine.endsWith('.js')) {
        const source = readFileSync(minePath, 'utf8');
        const imports = [...source.matchAll(/^\s*import\s.+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
        if (imports.length) {
            problems.push(`${mine} 出现了 import（必须零 import）：${imports.join(', ')}`);
        }
    }
}

// ── B. index.html 的外壳形状（服务端注入契约）─────────────────────────────
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const SHELL = [
    ['data-build-id="__BUILD_ID__"', '构建指纹占位符（vite 插件替换）'],
    ['name="clip9-web"', '桌面端探测标记'],
    ['id="app"', '挂载点 id'],
];
for (const [needle, why] of SHELL) {
    if (!html.includes(needle)) {
        problems.push(`index.html 缺少 ${needle}（${why}）`);
    }
}

// ── D. PWA 放行表：服务端路由一条都不能漏 ────────────────────────────────
// ⚠️★ 2026-10-30：原先对着 `web-vue3/vite.config.js` 的条目集合比 —— 那个目录删了。
// 改成把「必须放行」的这几条写在这里。这条判据的意图本来就是「服务端路由不能被 SW 的
// 导航兜底吞掉」，而条目全集不该由另一份前端决定：两边一起漏掉一条新路由时，对照法
// 永远发现不了（这就是原先那句注释自己承认的漏洞）。
// ⚠️ 加服务端路由时**这里和 vite.config.ts 一起改**；下面 D2（dev 代理）盯的是同一批路由，
// 两处都漏才叫真漏。
const DENY_REQUIRED = [
    's', 'server', 'text', 'auth', 'upload', 'push', 'rooms', 'share',
    'file', 'revoke', 'content', 'automation', 'tasks', 'convert',
];
const extractDenylist = (source) => {
    const match = source.match(/navigateFallbackDenylist:\s*\[([\s\S]*?)\]/);
    if (!match) return null;
    return [...match[1].matchAll(/\/\^\\\/([a-z]+)/g)].map((m) => m[1]).sort();
};
const mineDenylist = extractDenylist(readFileSync(join(WEB, 'vite.config.ts'), 'utf8'));
if (!mineDenylist) {
    problems.push('vite.config.ts 里找不到 navigateFallbackDenylist');
} else {
    const missing = DENY_REQUIRED.filter((entry) => !mineDenylist.includes(entry));
    if (missing.length) {
        problems.push(`PWA 放行表缺条目：${missing.join(', ')}（这些服务端路由会被 SW 的导航兜底吞掉）`);
    }
}

// ── D2. dev 代理：服务端路由一条都不能漏 ─────────────────────────────────
//
// ⚠️★ 2026-10-10 加。这一条是**真出过事**才补的，而且那个 bug 的症状特别坏：
//
// 加了 `POST /convert` 却忘了往 `server.proxy` 里加一条。dev 下请求打到 vite 自己，
// 被 SPA 兜底用一个**没有 body 的 404** 接住；前端把「404 且没有 JSON」当成
// 「这个服务端没编 `doc` feature」，于是提示「换一份带它的构建」——
// **而服务端明明编了**（`--all-features`、`convert.enabled: true` 都验过）。
// 一条代理配置的遗漏，把人往「重编服务端」上带。
//
// ⚠️ 判据的形式是**单向**的：「PWA 放行表里的每条路由，dev 代理里都要有」。
// 为什么不要求两边相等：`/s/` 是**刻意不代理**的（它是服务端注入 OG 的外壳，
// 走 vite 会拿到一份没注入的），而 `/stats` 只在代理里有 —— 两个方向都有正当的例外，
// 要求相等会立刻误报。真正的不变式是**那条单向的**：
// 「需要绕开 SPA 兜底的路由」必然也是「dev 下必须转发的路由」。
{
    const source = readFileSync(join(WEB, 'vite.config.ts'), 'utf8');
    // ⚠️ 取 `proxy: {` 到它自己那行收尾 `},` 之间的一段。
    // ⚠️ 别用「花括号配平」去抠：这段里嵌着每个代理项自己的 `{ … }`，
    // 而且注释里还有反引号与斜杠 —— 配平写不对时会**静默**把范围截短，
    // 于是判据看到一份空名单、把每条路由都报成「没代理」（第一版就是这样）。
    const proxyStart = source.indexOf('proxy: {');
    const proxyEnd = source.indexOf('\n            },', proxyStart);
    const proxyBlock = proxyStart >= 0 && proxyEnd > proxyStart ? source.slice(proxyStart, proxyEnd) : null;
    // ⚠️ 键的形状是 `'/server': {` —— **有**前导斜杠、**没有**尾斜杠。
    // 两个方向都踩过：按 `'/server/'` 匹配会一条都找不到，
    // 而按 `'server'` 匹配同样一条都找不到（真踩了，两版都报「全部没代理」）。
    const proxyNames = new Set(
        proxyBlock ? [...proxyBlock.matchAll(/'\/?([a-z-]+)':\s*\{/g)].map((m) => m[1]) : [],
    );

    if (!proxyBlock) {
        problems.push('vite.config.ts 里找不到 server.proxy');
    } else if (mineDenylist) {
        // ⚠️ 去重：放行表里 `/^\/push/` 出现了两次（历史原因），
        // 不去重的话报错信息里同一条会重复两遍。
        const mustProxy = [...new Set(mineDenylist)].filter((entry) => entry !== 's');
        const notProxied = mustProxy.filter((entry) => !proxyNames.has(entry));
        if (notProxied.length) {
            problems.push(
                `这些服务端路由没有配 dev 代理（dev 下会被 SPA 兜底接住）：${notProxied.join(', ')}`,
            );
        }
    }
}

// ── E. i18n 卫生：4 个 locale 键集合一致 + 没有未被引用的死键 ──────────────
// ⚠️ 死键是「删了功能但没删文案」的残留 —— 它不会报错，只会让下一个人以为那个功能还在。
//    2026-10-04 清掉了 59 个（含四个已删除模式的整套文案）。
const LOCALES = ['zh', 'zh-TW', 'en', 'ja'];
const localeKeys = {};
for (const locale of LOCALES) {
    localeKeys[locale] = Object.keys(JSON.parse(readFileSync(join(WEB, 'src/i18n/locales', `${locale}.json`), 'utf8')));
}
const zhKeys = localeKeys.zh;
for (const locale of LOCALES) {
    const other = new Set(localeKeys[locale]);
    const missing = zhKeys.filter((key) => !other.has(key));
    const extra = localeKeys[locale].filter((key) => !zhKeys.includes(key));
    if (missing.length) problems.push(`${locale}.json 缺 ${missing.length} 个 zh 有的键：${missing.slice(0, 5).join(', ')}`);
    if (extra.length) problems.push(`${locale}.json 多出 ${extra.length} 个 zh 没有的键：${extra.slice(0, 5).join(', ')}`);
}

// 把 src 下除 locale 文件外的源码拼起来，判断「这个键被引用过吗」
function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (['.ts', '.tsx', '.js', '.json'].includes(extname(name))) out.push(full);
    }
    return out;
}
const haystack = walk(join(WEB, 'src'))
    .filter((file) => !file.includes('/i18n/locales/'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
const unusedKeys = zhKeys.filter((key) => !haystack.includes(`'${key}'`) && !haystack.includes(`"${key}"`));
if (unusedKeys.length) {
    problems.push(`i18n 有 ${unusedKeys.length} 个未被引用的死键：${unusedKeys.slice(0, 8).join(', ')}`);
}

// ── F. 已删除的模式不得复活 ───────────────────────────────────────────────
// ⚠️ chat / mega / workbench / terminal 于 2026-09-26 真删，**没有退役映射表、没有兼容垫片**
//    （这个项目没有老用户，兼容垫片是永久成本）。
// ⚠️ 判据用**剥离行注释**后的源码：代码里明确写着「这几个模式已删除、别加回来」的说明性注释
//    是**该保留的文档**（meta.ts / displayToggles.js 各有一处），不算残留引用。
const codeOnly = haystack
    .split('\n')
    .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
const MODE_LEFTOVERS = [
    [/key:\s*['"](chat|mega|terminal|workbench)['"]/, '模式注册表里出现了已删除的模式 key'],
    [/uiMode(Mega|Terminal|Workbench|Chat)\b/, '引用了已删除模式的 i18n 键'],
    [/(ChatWall|MegaWall|TerminalWall|WorkbenchWall)\b/, '引用了已删除模式的组件'],
];
for (const [pattern, why] of MODE_LEFTOVERS) {
    if (pattern.test(codeOnly)) {
        problems.push(`${why}（${pattern}）`);
    }
}

// ── G. 破坏性接口的方法：`revoke/*` 只许 POST ─────────────────────────────
// ⚠️★ 2026-10-20 加。服务端把 `/revoke/{id}` 与 `/revoke/all` 注册成 **POST-only**
//    （`rust/crates/server/src/lib.rs`：`post(handlers::revoke).fallback(only_post)`，
//    别的方法一律 405 `method_not_allowed`）。这是 Jonny 2026-09-25 拍的板：
//    **破坏性操作必须是显式 POST** —— Go 那边不检查方法，浏览器直接访问 `/revoke/5`
//    就会删掉 5 号条目。
// ⚠️★ 而前端是从 Vue 版照抄的 `axios.delete('revoke/…')`（当时打的是 Go，所以能用）；
//    切到 Rust 服务端之后**每一条删除都 405** —— 症状是「单条消息删除失败」，
//    文案是服务端那句「仅允许 POST 请求」。2026-10-20 全量改成 `axios.post(url, null, { params })`。
//     ⚠️ 空 body 必须写 `null`：axios 的签名是 `post(url, data, config)`，
//        写成 `post(url, { params })` 会把参数当 JSON body 发出去，服务端就收不到 `room`。
// ⚠️ 别顺手把 `file/{uuid}` 那条也改了 —— 它**本来就是 DELETE**（`get(...).delete(...)`）。
const BAD_REVOKE_METHOD = /axios\s*\.\s*(delete|get|put|patch)\s*\(\s*[`'"]revoke\b/;
for (const file of walk(join(WEB, 'src'))) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (!BAD_REVOKE_METHOD.test(line)) return;
        problems.push(
            `revoke 只收 POST，这里发的是别的方法：${file.slice(WEB.length + 1)}:${i + 1}  ${line.trim()}`,
        );
    });
}

// ── H. WS 事件的 id 比较必须归一化（id 有数字 / 字符串两种形状）──────────────
// ⚠️★ 2026-10-20 加。冻结契约里 id 有两种形状（Go 导出的，别去改它）：
//   · WS 事件（`receive` / `update` / `revoke`）→ **数字**：`cases/protocol/text_receive.json` 的 `"id":7`
//   · HTTP 历史（`/content`、`/content/latest`）→ **字符串**：`cases/protocol/content_list.json` 的 `"id":"7"`
// 而 `ReceivedItem.id` 声明的是 `string`。所以「拿事件里的 id 去和列表比」**必须**过 `itemId(...)`；
// 不过的后果是**静默**的：删除接口成功了、卡片却要刷新才消失（`e.id === 7` 对 `"7"` 永远 false）。
const wsStore = readFileSync(join(WEB, 'src/stores/wsStore.ts'), 'utf8');
if (!/function\s+itemId\s*\(/.test(wsStore)) {
    problems.push('wsStore.ts 里不见了 `itemId()` —— id 的数字/字符串两种形状又没人管了');
}
/** 取 `case 'xxx':` 到它那个 `break;` 之间的一段（找不到返回 null，判据要红）。 */
const eventCase = (name) => {
    const start = wsStore.indexOf(`case '${name}'`);
    if (start < 0) return null;
    const end = wsStore.indexOf('break;', start);
    return end < 0 ? null : wsStore.slice(start, end);
};
/**
 * ⚠️★ 先把**注释行**剥掉再判 —— 这一段的注释里就写着 `id: targetId` 与 `itemId`，
 * 不剥的话判据会被自己的说明骗过去（实测：变异删掉那段代码后判据照绿）。
 * 本仓库踩过同一类坑（`android-contract-smoke.mjs` 的判据 11 抬头写着）。
 */
const stripLineComments = (text) =>
    text
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        })
        .join('\n');
for (const name of ['revoke', 'update']) {
    const raw = eventCase(name);
    if (raw === null) {
        problems.push(`wsStore.ts 里找不到 \`case '${name}'\` 的完整块 —— 这条判据失效了（别报绿）`);
        continue;
    }
    const block = stripLineComments(raw);
    if (!block.includes('itemId(')) {
        problems.push(
            `\`case '${name}'\` 拿 id 比较却没走 \`itemId(...)\` —— WS 事件的 id 是**数字**、历史里是**字符串**，` +
                '严格相等对历史条目永远不成立（症状：删除成功但卡片要刷新才消失）',
        );
    }
    // ⚠️ 用「逗号 + `id: targetId` + 右花括号」的**代码形态**，别用 `includes('id: targetId')`
    //    —— 注释行里也写着这几个字（上面那个 stripLineComments 已经剥了，这里再加一道）。
    if (name === 'update' && !/,\s*id:\s*targetId\s*\}/.test(block)) {
        problems.push(
            "`case 'update'` 展开事件数据时没把 `id` 归一 —— 数字 id 会把字符串 id 盖掉，" +
                '下一次 revoke / update 又匹配不上（同一条 bug 换个入口复发）',
        );
    }
}

// ── I. 后端地址与页面地址是**两件事**（前后端分离部署，2026-10-20）────────────
// ⚠️★ 同源部署时 `APP_BASE_URL`（页面在哪）与 `API_BASE_URL`（后端在哪）**相等**，
//    所以「用错了」在本机开发时**完全看不出来** —— 而分离部署时用错的那个会让
//    **每一条**接口都打到静态托管那边（拿回一份 HTML，前端报一句没信息量的错）。
//    这一段的每一条都对应一个「改错了不会报错」的地方，逐条钉住。
{
    const configPath = join(WEB, 'public/config.js');
    if (!existsSync(configPath)) {
        problems.push(
            '缺 `public/config.js` —— 部署方没有地方写后端地址，分离部署只能靠重编前端',
        );
    } else {
        const source = readFileSync(configPath, 'utf8');
        // ⚠️ 判据只认「赋值给 window 上那个名字」：改成 const/module 导出的话，
        //    它是**构建期**的东西了（得重编），那就不是运行时配置了。
        if (!/window\.__CLIP9_API_BASE__\s*=/.test(source)) {
            problems.push(
                '`public/config.js` 没有给 `window.__CLIP9_API_BASE__` 赋值 —— 运行时读的就是它',
            );
        }
    }

    // index.html：必须在模块 bundle **之前**加载（`lib/base.ts` 在模块求值时就读它）。
    // ⚠️ 用**相对**地址：绝对 `/config.js` 在子路径部署（服务端 `-prefix` / 静态托管子目录）下会指错地方。
    const configTag = html.indexOf('src="./config.js"');
    const bundleTag = html.indexOf('type="module"');
    if (configTag < 0) {
        problems.push('index.html 没有引用 `./config.js`（部署方的后端地址读不到）');
    } else if (bundleTag >= 0 && configTag > bundleTag) {
        problems.push(
            'index.html 里 `./config.js` 排在了模块 bundle **之后** —— 它必须在 bundle 之前加载',
        );
    }

    const base = readFileSync(join(WEB, 'src/lib/base.ts'), 'utf8');
    if (!/export\s+const\s+API_BASE_URL\b/.test(base)) {
        problems.push('`src/lib/base.ts` 里没有 `API_BASE_URL` —— 后端地址这一份解析不见了');
    }

    // ⚠️★ 「多个后端」是**两个键**（当前选中 + 保存的列表），而这件事一旦退化成单值
    // 不会有任何报错：设置页只是少一行能选而已。这里钉住「列表这套还在」。
    if (
        !/export\s+const\s+API_BASE_LIST_KEY\b/.test(base) ||
        !/export\s+function\s+readSavedApiBases\b/.test(base) ||
        !/export\s+function\s+writeSavedApiBases\b/.test(base)
    ) {
        problems.push(
            '`src/lib/base.ts` 里没有 `API_BASE_LIST_KEY` / `readSavedApiBases` / `writeSavedApiBases` —— ' +
                '「多个后端来回切」退化成单值了',
        );
    }
    const settings = readFileSync(join(WEB, 'src/components/AppShell/SettingsDialog.tsx'), 'utf8');
    // ⚠️★ 必须**先剥 import** 再查用法：光有 `import { writeSavedApiBases }` 说明不了任何人
    // 调用它（同一个坑在判据 I 的分享页那条已经踩过一次 —— 变异删掉用法、判据照绿）。
    // ⚠️ 这里的 import 是**跨行**的，`split('\n').filter(startsWith('import'))` 去不干净。
    const settingsCode = settings.replace(/^import[\s\S]*?from\s+'[^']+';[ \t]*$/gm, '');
    for (const call of ['readSavedApiBases(', 'writeSavedApiBases(', 'writeActiveApiBase(', 'API_BASE_LIST_MAX']) {
        if (!settingsCode.includes(call)) {
            problems.push(
                `设置页里没有**调用** \`${call}\` —— 多后端列表那一套不完整（切不过去 / 存不下来）`,
            );
        }
    }

    // axios 的 baseURL 必须是**后端**地址。
    const http = readFileSync(join(WEB, 'src/services/http.ts'), 'utf8');
    if (!/axios\.defaults\.baseURL\s*=\s*API_BASE_URL\b/.test(http)) {
        problems.push(
            '`services/http.ts` 的 `axios.defaults.baseURL` 不是 `API_BASE_URL` —— ' +
                '分离部署时每条接口都会打到页面所在的那台机器上',
        );
    }

    // WS 地址同理，且协议要跟着**后端**地址走（页面 https + 后端 http 的内网部署下，
    // 按 `location.protocol` 拼会得到 wss 并被浏览器当成混合内容拦掉）。
    // ⚠️ 先剥注释：解释这件事的注释里就写着 `location.protocol`（同判据 H 的坑）。
    const wsCode = stripLineComments(wsStore);
    if (!/new URL\(\s*'push'\s*,\s*API_BASE_URL\s*\)/.test(wsCode)) {
        problems.push("`wsStore.ts` 的 WS 地址不是从 `API_BASE_URL` 拼的（分离部署会连不上）");
    }
    if (/location\.protocol/.test(wsCode)) {
        problems.push(
            '`wsStore.ts` 又按 `location.protocol` 决定 ws/wss 了 —— 要跟**后端**地址走',
        );
    }

    // 分享链接：只取结尾的 `/s/<token>` 再拼到**这份前端**的目录上。
    // ⚠️ 保留服务端给的前缀（旧写法）在「后端有 prefix、前端在根目录」时会把链接拼到
    //    前端匹配不到的路径上 —— 打开是一张空白页，而链接看起来完全正常。
    const util = readFileSync(join(WEB, 'src/lib/util.ts'), 'utf8');
    const withOrigin = util.slice(util.indexOf('export function withCurrentOrigin'));
    // ⚠️ 用**普通字符串**判断而不是正则：要匹配的正是源码里那串 `\/s\/`，
    //    写成正则得三层转义，读的人（和写的人）都会数错。
    if (!withOrigin.includes('\\/s\\/') || !withOrigin.includes('APP_BASE_URL')) {
        problems.push(
            '`withCurrentOrigin` 不再把分享地址重建成「前端目录 + /s/<token>」—— ' +
                '分离部署 + 后端有 prefix 时分享链接会打不开',
        );
    }

    // PWA 的预缓存必须排除它：否则托管方改完 `config.js`，回访用户拿到的还是缓存里那份旧的
    // （SW 的更新检查只看 SW 脚本本身，那个文件改了不触发任何更新）。
    const viteConfig = readFileSync(join(WEB, 'vite.config.ts'), 'utf8');
    const ignores = viteConfig.match(/globIgnores:\s*\[([^\]]*)\]/);
    if (!ignores || !ignores[1].includes('config.js')) {
        problems.push(
            '`vite.config.ts` 的 `globIgnores` 没有排除 `config.js` —— ' +
                '改了后端地址的部署方会看到「改了没反应」',
        );
    }

    // ⚠️★ 浏览器**自己**发的请求（`<img src>` / `<a download>` / `<video src>`）不经过
    // axios 的 baseURL —— 那些地址必须自己绝对化到后端。写成相对地址的话，分离部署时
    // 会按**页面**目录解析到静态托管那边，症状是「图挂了 / 下载 404」，而页面一切正常。
    const sharePage = readFileSync(join(WEB, 'src/pages/SharePage.tsx'), 'utf8');
    // ⚠️ 剥掉 import 行再判：光有 `import { API_BASE_URL }` 说明不了任何人用它
    //    （第一版就是这么写的，变异把用法删掉之后判据照绿）。
    const shareCode = sharePage
        .split('\n')
        .filter((line) => !line.trim().startsWith('import'))
        .join('\n');
    if (!shareCode.includes('API_BASE_URL')) {
        problems.push(
            '`pages/SharePage.tsx` 的文件地址没有绝对化到 `API_BASE_URL` —— ' +
                '分离部署时分享页里的图片/视频/下载全是 404（它们是浏览器自己发的请求）',
        );
    }
    // 自动化管理页同理：它是**服务端渲染**的页面，不在前端路由里。
    const toolbar = readFileSync(join(WEB, 'src/components/AppShell/PageToolbar.tsx'), 'utf8');
    if (!/new URL\(\s*'automation'\s*,\s*API_BASE_URL\s*\)/.test(toolbar)) {
        problems.push(
            "`PageToolbar` 的自动化入口不是从 `API_BASE_URL` 拼的 —— 分离部署时点进去是 404",
        );
    }
}

// ── J. 不再生成「没人读的」预压缩副本（2026-10-20）────────────────────────
// ⚠️★ `after-build.mjs` 原来给 dist 里每个 js/css/html/svg 各写一份 `.gz` 与 `.br`。
//    而**没有任何东西读它们**：`rust/crates/server/src/static_files.rs` 没有
//    `Accept-Encoding` / `Content-Encoding` 分支，仓库里也没有 nginx `gzip_static` 配置。
//    代价却是实的 —— 52 个文件 **6.3 MB**，跟着同步进 `static/` 被 `include_bytes!`
//    编进每一个二进制（CLI / Docker / OpenWrt / Android / 桌面）。
//
// ⚠️ 这条是**反向**判据（「别又加回来」），和「已删模式不得复活」同一类：
//    加回来不会报错，只会让所有产物静默胖 6 MB。
//    ⚠️ 真要有消费者了（给 `static_files` 加按 `Accept-Encoding` 挑预压缩文件的分支），
//    那就连这条判据一起改 —— 别只删判据、不接消费者。
{
    const after = readFileSync(join(WEB, 'after-build.mjs'), 'utf8');
    if (/gzipSync|brotliCompressSync|\.gz['"]|\.br['"]/.test(after)) {
        problems.push(
            '`after-build.mjs` 又在生成 `.gz` / `.br` 预压缩副本了 —— 服务端从不读它们，' +
                '却会被编进每一个二进制（6.3 MB × 每次发布的所有产物）',
        );
    }
}

// ── K. 选文件是**追加**，不是替换（2026-10-26）────────────────────────────
// ⚠️★ 两套发送区（标准 / 非标准）都必须走 `mergeSelectedFiles`。
//    原来的写法是 `setState({ send: { …, files } })` —— 整份**替换**。桌面上框选/拖一堆
//    感觉不出来，但手机上的典型操作是「点添加 → 选一个 → 再点添加」，
//    于是每加一个都把前面选的清空，最后只剩最后一个发出去
//    （用户报的「手机上发多个文件只成功其中一个」，2026-10-26）。
//    ⚠️ 这条**不会**在构建期报错：替换也是合法代码，页面照常能发、照常提示成功。
{
    const composers = [
        ['src/components/UnifiedComposer.tsx', '标准模式'],
        ['src/components/sticky/StickyComposer.tsx', '非标准模式'],
    ];
    for (const [file, label] of composers) {
        const source = readFileSync(join(WEB, file), 'utf8');
        if (!/mergeSelectedFiles\(/.test(source)) {
            problems.push(`${label}（${file}）没有走 mergeSelectedFiles —— 选文件又变成替换语义了`);
        }
        if (/setState\(\{\s*send:\s*\{[^}]*\bfiles\s*\}\s*\}\)/.test(source)) {
            problems.push(`${label}（${file}）把 \`send.files\` 整份覆盖回去了（选文件必须是追加）`);
        }
    }
}

// ── L. 每条「会落成一条消息」的写请求都带 `?client=`（2026-10-26）────────────
// ⚠️★ `?client=` 是服务端填 `senderClientID` 的唯一来源，而「这条是不是我发的」全靠它
//    （桌面端的左右分栏就是比它）。**少了它不会报错**：消息照发、界面照显示，
//    只是自己发的东西被当成别的设备发的。
//    ⚠️ 2026-10-26 之前这条规矩是**每处各写一遍**的，同一个 `sendFiles` 里四种写法
//    （整份上传带、分片初始化不带、分片不带、收尾带）—— 没人看得出来少了哪一个。
//    现在只有 `writeParams()` 一种写法，这条判据钉的就是「都用它」。
//
// ⚠️ 覆盖面：`src/` 下所有 `axios.post` / `axios.postForm`，**只看 URL 以 `upload` 开头
//    或等于 `text` 的**（`revoke` / `auth` / `share` / `convert` 那些不落消息，不在此列）。
//    ⚠️ 覆盖已有条目（`POST /text?id=`）也算：它同样走 `writeParams()`，`id` 用第三个参数的
//    `extra` 传 —— 不给「自己拼 URLSearchParams」留第二种写法。
{
    const ROOT = join(WEB, 'src');
    const files = readdirSync(ROOT, { recursive: true })
        .filter((f) => typeof f === 'string' && /\.tsx?$/.test(f))
        .map((f) => join(ROOT, f));

    /** 取出从 `marker` 那个 `(` 起、括号配平的那一段实参文本。 */
    const callArgs = (source, marker) => {
        const out = [];
        let from = 0;
        for (;;) {
            const at = source.indexOf(marker, from);
            if (at < 0) return out;
            let depth = 1;
            let i = at + marker.length;
            while (i < source.length && depth > 0) {
                const ch = source[i];
                if (ch === '(') depth += 1;
                else if (ch === ')') depth -= 1;
                else if (ch === "'" || ch === '"' || ch === '`') {
                    // 跳过字符串字面量（URL 里有 `${uuid}` 那种模板串）
                    const quote = ch;
                    i += 1;
                    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
                }
                i += 1;
            }
            out.push(source.slice(at + marker.length, i - 1));
            from = i;
        }
    };

    for (const file of files) {
        // ⚠️ 先剥注释：解释这条规矩的注释里就写着 `axios.post('text')`（同判据 H / I 的坑）。
        //    ⚠️ 行注释只剥「整行」的 —— 字符串里的 `http://` 不能被当成行注释。
        const source = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        const rel = file.slice(WEB.length + 1);
        for (const marker of ['axios.postForm(', 'axios.post(']) {
            for (const args of callArgs(source, marker)) {
                const url = /^\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/.exec(args);
                const target = (url && (url[1] ?? url[2] ?? url[3])) || '';
                const createsMessage = /^upload/.test(target) || target === 'text';
                if (!createsMessage) continue;
                if (!/params:\s*writeParams\(/.test(args)) {
                    problems.push(
                        `${rel}：\`${target}\` 这条写请求没走 \`writeParams()\` —— ` +
                            '少了 `?client=`，服务端就不知道这条是谁发的（桌面端会把它排到「别人」那一侧）',
                    );
                }
            }
        }
    }
}

// ── M. 文件预览**不许**为「显示」去签分享令牌（2026-10-26）──────────────────
//
// ⚠️★ 这一条是**真出过事**才补的。在这之前，凡是「把一张图塞进 `<img src>`」的地方
//    都是先 `POST /share` 签一条 `type=file` 的只读令牌、再拿 `rawUrl` 当预览地址。
//    代价三笔，一笔都不会报错：
//      · **污染分享记录** —— `GET /share/list` 列的是「这个房间最近的分享」，用户每看
//        一眼图就多一条；桌面端的相册视图翻一遍，分享历史里全是自己没分享过的条目。
//      · **每张图多一次往返** —— 而它和「直接读这个文件」在权限上是同一件事
//        （服务端 `require_file_read_access` 本来就认房间凭据）。
//      · **令牌有 TTL** —— 过期之后预览地址失效，而文件本身还活着。
//    正确地址一直是 `GET /file/<uuid>` + `?room=&auth=`（`auth_gate.rs` 的
//    `extract_auth_token` 认 query）。现在只有 `services/file-url.ts` 一处拼它。
//
// ⚠️ 判据的**形式**：`type: 'file'` 的分享**一次都不许出现**（分享按钮发的是
//    `type: 'content'`，那是真分享，不受影响）。这一条之所以能这么硬，是因为
//    「文件分享链接」除了当预览地址用，在这个仓库里**没有第二个用途**。
{
    const ROOT = join(WEB, 'src');
    const files = readdirSync(ROOT, { recursive: true })
        .filter((f) => typeof f === 'string' && /\.tsx?$/.test(f))
        .map((f) => join(ROOT, f));
    for (const file of files) {
        // 定义处不算用法（它自己不调用）。
        if (file.endsWith('/services/share.ts')) continue;
        const source = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        if (/createShareLink\(\s*\{[^}]*type:\s*['"]file['"]/.test(source)) {
            problems.push(
                `${file.slice(WEB.length + 1)}：为**预览**签了一条文件分享令牌 —— ` +
                    '那会在 `GET /share/list` 里留下用户没分享过的记录、每张图多一次往返、' +
                    '而且令牌过期后预览就失效。改用 `services/file-url.ts` 的 `fileUrl()`',
            );
        }
    }

    // 那个唯一的实现还在不在，而且**两样都必须有**：绝对化到后端、带凭据。
    const helperPath = join(ROOT, 'services/file-url.ts');
    if (!existsSync(helperPath)) {
        problems.push('缺 `src/services/file-url.ts` —— 文件字节的直连地址没有唯一实现了');
    } else {
        const code = readFileSync(helperPath, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^[ \t]*\/\/.*$/gm, '');
        if (!/export\s+function\s+fileUrl\b/.test(code)) {
            problems.push('`services/file-url.ts` 里没有 `fileUrl()` —— 直连地址的唯一实现不见了');
        }
        // ⚠️ 绝对化到 `API_BASE_URL`：`<img src>` 是**浏览器自己**发的请求，不走 axios 的
        //    baseURL。写成相对地址时，分离部署下会按**页面**目录解析到静态托管那边 ——
        //    症状是「图挂了」，而页面一切正常（同判据 I）。
        if (!code.includes('API_BASE_URL')) {
            problems.push('`fileUrl()` 没有绝对化到 `API_BASE_URL` —— 分离部署时图片/视频全 404');
        }
        // ⚠️ 少了 `auth` 不会报错，只会「开放房间能看、带密码的房间一片碎图标」。
        if (!code.includes("'auth'")) {
            problems.push("`fileUrl()` 没有把房间凭据挂进 query（`?auth=`）—— 带密码的房间预览全 401");
        }
    }
}

// ── N. 设置「通用」页不许用 `secondaryAction`（2026-10-26）──────────────────
//
// ⚠️★ 用户报的「移动端设置通用页文字重叠」：MUI 的 `secondaryAction` 只给正文留
//    **48px** 右内边距，而那一页右侧的控件是 **140px 的 Select** 或 85px 的开关组 ——
//    实测 390 宽时正文右边缘 x=396、Select 从 x=304 开始，**重叠 92px**。
//    MUI 的解法是调用方自己写 `pr`，而控件宽度**随语种变**（`Traditional colors`
//    比「中华传统色」宽一截），算不准；所以那一页统一走可换行的 `SettingRow`。
//
// ⚠️ 判据按**页签分界**切：个性化页里那个 `Switch` 只有 34px，48px 够用，不算问题 ——
//    一刀切「全文件禁止」会把它也误伤，然后有人就把判据删了。
{
    const settingsPath = join(WEB, 'src/components/AppShell/SettingsDialog.tsx');
    const settings = readFileSync(settingsPath, 'utf8');
    const start = settings.indexOf("{tab === 'general' && (");
    const end = settings.indexOf("{tab === 'personalization' && (");
    if (start < 0 || end < start) {
        // ⚠️ 找不到分界就**红**，别静默跳过 —— 那正是「判据自己坏了还报绿」的样子。
        problems.push('`SettingsDialog.tsx` 里找不到「通用 / 个性化」两个页签的分界 —— 判据 N 失效了');
    } else {
        const general = stripLineComments(settings.slice(start, end));
        if (/secondaryAction=/.test(general)) {
            problems.push(
                '设置「通用」页又用 `secondaryAction` 了 —— 它只给正文留 48px，而那一页的控件是'
                + ' 140px 的 Select / 85px 的开关组，窄屏上正文会跑到控件底下（2026-10-26 用户报的重叠）。'
                + '改用 `SettingRow`（可换行的 flex 行）',
            );
        }
        if (!/function SettingRow\(/.test(settings)) {
            problems.push('`SettingsDialog.tsx` 里没有 `SettingRow` —— 「通用」页那几行的可换行布局不见了');
        }
    }
}

// ── O. 便签阅读器进全屏查看器之前，必须先把自己关掉（2026-10-26）────────────
//
// ⚠️★ 用户报的「便签里点图片有重叠」：阅读器是 MUI `Dialog`（z-index **1300**），
//    而查看器是 **1200** —— 那个 1200 是**故意的**（见 `MediaViewer` 抬头：查看器开着时
//    弹出的分享/确认框必须还能盖在它上面）。两层同时开着，就是便签纸盖在黑色的全屏图上，
//    看着像「重叠」。别的模式都是从列表直接进查看器，只有便签这里是从一个对话框里进。
//
// ⚠️ 而且这个 bug **只看得见、不报错**：DOM 正常、控制台干净、关掉查看器还回到阅读器。
//    所以钉两条：① `openFullscreen` 必须先 `setExpanded(false)`；② 不许在它之外另开一扇门。
//
// ⚠️ 顺带钉住「视频也能进全屏」：`<video>` 自带 `controls`，点它是播放/暂停，
//    挂 onClick 会抢控制条 —— 所以视频**只能**靠 `.sticky-note__reader-zoom` 那个按钮。
{
    const stickyPath = join(WEB, 'src/components/sticky/StickyNote.tsx');
    const sticky = stripLineComments(readFileSync(stickyPath, 'utf8'));

    const at = sticky.indexOf('const openFullscreen');
    if (at < 0) {
        problems.push('`StickyNote.tsx` 里没有 `openFullscreen` —— 阅读器里进查看器的那条路不见了');
    } else {
        const end = sticky.indexOf('\n    };', at);
        const body = end > at ? sticky.slice(at, end) : '';
        if (!/setExpanded\(false\)/.test(body)) {
            problems.push(
                '`openFullscreen` 没有先 `setExpanded(false)` —— 阅读器（Dialog / 1300）会压在'
                + '全屏查看器（1200）上面，看起来就是「便签纸和图片重叠」',
            );
        }
        if (!/openFromVisibleSet\(/.test(body)) {
            problems.push('`openFullscreen` 里没有 `openFromVisibleSet` —— 那它并没有在开查看器');
        }
        const elsewhere = sticky.slice(0, at) + sticky.slice(end);
        if (/openFromVisibleSet\(/.test(elsewhere)) {
            problems.push(
                '`openFromVisibleSet` 在 `openFullscreen` 之外也被调用了 —— 那一处会把阅读器'
                + '留在查看器上面（就是 2026-10-26 那个重叠）',
            );
        }
    }

    if (!/sticky-note__reader-zoom/.test(sticky)) {
        problems.push(
            '阅读器的预览块少了「全屏」入口（`.sticky-note__reader-zoom`）—— 视频自带 `controls`，'
            + '点它只会播放，视频就永远进不了全屏',
        );
    }

    // 查看器的层级必须**低于** Dialog（1300）：它抬头那段注释写着理由 ——
    // 开着查看器时点分享弹出的那个框要能盖上来。谁为了消掉上面那个重叠把它抬到 1300，
    // 那条能力就悄悄断了。
    const viewer = stripLineComments(readFileSync(join(WEB, 'src/components/viewer/MediaViewer.tsx'), 'utf8'));
    if (!/zIndex:\s*1200\b/.test(viewer)) {
        problems.push(
            '`MediaViewer` 的 zIndex 不是 1200 —— 它必须低于 Dialog（1300），'
            + '否则查看器里点分享弹出的对话框会被压在下面',
        );
    }
}

// ── P. 图片工具条必须住在顶栏里，不许浮在图上（2026-10-26）──────────────────
//
// ⚠️★ 用户报的「白底图放大后完全看不到按钮」：工具条最早是**右下角浮层**，按钮底色
//    只有 14% 的白 —— 截图 / 文档照片一放大，白底直接把按钮吃了。改成顶部浮动居中
//    也不行：桌面端放大之后它挡住画面内容。现在它是顶栏（计数 ↔ 关闭）之间的一个
//    空位，靠 `createPortal` 送进去 —— 顶栏那条深色渐变本来就常驻，等于不额外占画面。
//
// ⚠️ 症状是**静默**的：DOM 在、按钮在、点得动，只是看不见（或者挡着内容）。
//    所以钉四条。
{
    const viewerPath = join(WEB, 'src/components/viewer/MediaViewer.tsx');
    const viewerRaw = stripLineComments(readFileSync(viewerPath, 'utf8'));

    // ① 顶栏里得有那个空位，而且是用**状态**存节点（`ref={setToolSlot}`）：
    //    图是深层子组件，首次渲染时 ref 还是 null，换成 `useRef` 就永远不重渲染。
    if (!/ref=\{setToolSlot\}/.test(viewerRaw)) {
        problems.push(
            '`MediaViewer` 的顶栏里没有 `ref={setToolSlot}` 那个空位 —— 图片工具条没地方挂，'
            + '会退回「浮在图上」的老样子（白底图放大后看不见按钮）',
        );
    }

    // ② 工具条得是 portal 进去的（文件里本来有一次 `createPortal` —— 查看器自己挂到 body）。
    if ((viewerRaw.match(/createPortal\(/g) || []).length < 2) {
        problems.push(
            '`MediaViewer.tsx` 里少于两次 `createPortal(` —— 图片工具条没有送进顶栏的空位，'
            + '它又变成图上的浮层了',
        );
    }

    // ③ 药丸自己不许定位：绝对定位 = 又浮回图上了。
    //    ⚠️ 只认**JSX 属性**那个出现位置（单独一行）：抬头注释里也提 `data-zoom-ui`，
    //    从注释开始切会把整个组件切进去，`position: 'relative'` 一堆全是误报。
    const pillAt = viewerRaw.search(/\n\s+data-zoom-ui\n/);
    const pillEnd = pillAt < 0 ? -1 : viewerRaw.indexOf('toolSlot,', pillAt);
    if (pillAt < 0 || pillEnd < 0) {
        problems.push('`MediaViewer.tsx` 里找不到工具条药丸（`data-zoom-ui` … `toolSlot,`）—— 判据 P 失效了');
    } else if (/position:/.test(viewerRaw.slice(pillAt, pillEnd))) {
        problems.push(
            '图片工具条药丸自己写了 `position:` —— 那就是浮在图上：白底图放大后会看不见，'
            + '桌面端放大后会挡住内容。它应该待在顶栏的空位里',
        );
    }

    // ④ 只有**当前**那条挂：邻近的也挂的话，同一个空位里会并排塞进三个工具条。
    if (!/toolSlot=\{index === current \? toolSlot : null\}/.test(viewerRaw)) {
        problems.push(
            '`ViewerBody` 的 `toolSlot` 没有按「是不是当前那条」判 —— 惰性挂载的邻近两条也会'
            + '把自己的工具条塞进顶栏，一个空位里并排三个',
        );
    }
}

// ── Q. 代码高亮：**不许猜语言**，没写语言就走语言无关的通用着色 ──────────
//
// ⚠️★ 2026-10-30 的真事：没写语言的代码块原来拿 `highlightAuto` 猜，而短片段根本猜不准 ——
// `select … from users` 被猜成 bash（sql 连前三都没进）、`fn main(){}` 被猜成 javascript
// （和 rust 同分）、单行 js 干脆猜不出。猜错是给出**错误结论**（一段 JS 顶着 C++ 的语法色），
// 比「没颜色」更糟。Jonny 的要求是「把猜语言的代码**全都删了**」—— 所以判据盯的是
// 「这套东西不存在」，而不是「没人调它」：留着函数，早晚有人又接回去。
//
// 这条盯四件事：
//   ① 整个文件里没有 `detectLanguage` 这个导出；
//   ② 没有 `hljs.highlightAuto(` 调用；
//   ③ `highlightCodeBlocksIn` 用 `colorizePlain`；
//   ④ 选的是 `code`（**含行内**），不是 `pre > code` —— 行内代码也要上色。
{
    const hiPath = join(WEB, 'src/lib/highlight.js');
    const hi = existsSync(hiPath) ? readFileSync(hiPath, 'utf8') : '';
    const blocksFn = /export async function highlightCodeBlocksIn[\s\S]*?\n\}/.exec(hi)?.[0] ?? '';
    if (!blocksFn) {
        problems.push('highlight.js 里找不到 highlightCodeBlocksIn');
    } else {
        if (/colorizePlain\s*\(/.test(blocksFn) === false) {
            problems.push('highlightCodeBlocksIn 没有用 colorizePlain —— 没写语言的代码块会是一坨纯文本');
        }
        // ⚠️ 行内代码（`<code>` 不在 `<pre>` 里）也算：2026-10-30 起它们同一套处理。
        //    写回 `pre > code` 的话，行内代码又只剩一颗底色。
        if (!/querySelectorAll\(['"]code['"]\)/.test(blocksFn)) {
            problems.push(
                "highlightCodeBlocksIn 的选择器不是 `querySelectorAll('code')` —— "
                + '行内代码（不在 pre 里的 code）不会上色',
            );
        }
    }
    if (/export\s+(async\s+)?function\s+detectLanguage\b/.test(hi)) {
        problems.push('highlight.js 里 `detectLanguage` 又回来了 —— 猜语言已经废弃，短片段猜不准反而误导');
    }
    if (/hljs\.highlightAuto\s*\(/.test(hi)) {
        problems.push('highlight.js 里又出现了 `hljs.highlightAuto(` —— 那是猜语言的入口，已经删掉的东西别加回来');
    }

    const plainFn = /export function colorizePlain[\s\S]*?\n\}/.exec(hi)?.[0] ?? '';
    if (!plainFn) {
        problems.push('highlight.js 里没有 colorizePlain —— 没写语言的代码块没有颜色');
    } else {
        // ⚠️ 三个「往外吐内容」的地方逐个点名，**不是**只看函数里有没有 `escapeHtml(`：
        // 只要还留着一处没转义的调用，光查 `escapeHtml(` 就照样绿（实测过：
        // 把 `${escapeHtml(word)}` 改成 `${word}` 时，旧的写法一点反应都没有）。
        const needs = [
            ['escapeHtml(word)', '词（tone span 里那段）'],
            ['escapeHtml(comment)', '注释'],
            ['escapeHtml(source.slice', '词与词之间的原文'],
        ];
        const missing = needs.filter(([needle]) => !plainFn.includes(needle)).map(([, why]) => why);
        if (missing.length) {
            problems.push(
                `colorizePlain 里这几处没有转义：${missing.join('、')} —— `
                + '它是自己拼 HTML 的（不走 highlight.js 的转义），漏一处就是 XSS',
            );
        }
    }
}

// ── 结果 ────────────────────────────────────────────────────────────────
if (problems.length) {
    console.error(`✗ 契约守卫失败（${problems.length} 处）：`);
    for (const line of problems) console.error(`    ${line}`);
    process.exit(1);
}
console.log('✓ 契约守卫通过：零依赖共享模块字节一致 · 外壳形状完整 · PWA 放行表一致 · dev 代理覆盖了每条服务端路由 · i18n 无死键 · 已删模式未复活 · revoke 只发 POST · WS 事件 id 已归一 · 后端地址与页面地址分开 · 选文件是追加 · 写请求都带 client · 预览不为显示签分享令牌 · 设置通用页不靠 secondaryAction · 便签进全屏先关阅读器 · 图片工具条住在顶栏 · 没写语言的代码块不猜语言');
