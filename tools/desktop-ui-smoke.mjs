#!/usr/bin/env node
// 桌面端**手写界面**的静态自检。
//
// 用法：
//   node tools/desktop-ui-smoke.mjs                       # 在 clip9/ 下跑
//   node tools/desktop-ui-smoke.mjs <app.js> <index.html> # 用别的夹具跑（变异验证 / 临时排查）
//
// # ⚠️ 为什么要有它
//
// `crates/desktop/ui/app.js` 里到处是 `el('cfg-textlimit')` 这种**字符串 id**，
// 而这一侧**没有任何测试运行器**（`web-vue3` 与 `ui/*.js` 都没有，见 MEMORY.md）。
// 于是「id 打错一个字」的表现是**那个功能静默失效**：不报错、不 panic，
// 控制台里可能只有一行 `null.classList` —— 而这一版连控制台都不给用户看。
//
// 这类错**不需要跑起来才能发现**：两侧都是静态文本，比一下就知道。
// 对照：SPA 有 `web-vue3/scripts/check-display-semantics.mjs`、服务端渲染页有
// `cloud-clip/tools/page-smoke.mjs`，**只有手写 UI 这一侧是裸奔的**
//（见 `docs/specs/desktop-client.md` §1.1 缺口 C）。
//
// # 判据（**只有第一条算失败**）
//
// 1. `app.js` 引用到的每一个 id，`index.html` 里必须存在 —— 不通过 = 退出码 1；
// 2. `index.html` 真的加载了 `app.js`（改名只改一侧 = 整页不工作）；
// 3. 反向（HTML 有、JS 没引用）**只提示**，而且分两种：
//    · 「只被选择器用」（`#rooms-table { … }` 这类样式钩子）→ 正常，**不吵**；
//    · 「既没被 JS 引用、也没有选择器用它」→ 才提一句（可能是死标记，与 §8.1 第 6 条那两段死 CSS 同类）。
//
// # ⚠️ 三条「看不见」的地方（写在这里，免得下次以为是漏检）
//
// · **只认字符串字面量**：`el('row-' + i)` 这种拼出来的看不见 ——
//   所以第 3 条里要**扣掉动态前缀**（见下）。`app.js` 现在只有一处动态：`pane-${name}`。
// · **间接路径要自己列**：`sqGet('x')` / `sqSet('x')` / `numField('x', …)` 的**首参也是 id**，
//   它们内部才调 `el` —— 只匹配 `el(` 会把一大批 id 误判成「没引用」（第一版就是这么错的）。
// · **不做**「HTML 里定义了就必须用」的强制检查：那会逼人去删标记，比留着更糟。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [jsPath = join(root, 'crates/desktop/ui/app.js'), htmlPath = join(root, 'crates/desktop/ui/index.html')] =
  process.argv.slice(2);

const js = readFileSync(jsPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');

/** 单参调用 `fn('literal')` 里的字面量。 */
function singleArgLiterals(source, fnName) {
  const pattern = new RegExp(`\\b${fnName}\\(\\s*(['"])([^'"]+)\\1\\s*\\)`, 'g');
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[2]);
  return found;
}

/** 首参是字面量、后面还有别的参数（`numField('cfg-port', 9501)`）。 */
function firstArgLiterals(source, fnName) {
  const pattern = new RegExp(`\\b${fnName}\\(\\s*(['"])([^'"]+)\\1\\s*,`, 'g');
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[2]);
  return found;
}

// ⚠️ 这几个是**间接取 id 的入口**（都在 app.js 里定义），少列一个就会误判。
// ⚠️★ 还要分清**几个参数**：`el('x')` / `sqGet('x')` 是单参；
// `sqSet('x', on)` / `numField('x', 4096)` 的首参才是 id。
// 第一版把 `sqSet` 当成单参匹配 → `srv-sq-local` / `srv-sq-remote`（**只写不读**，
// 所以没有任何 `sqGet` 兜住它们）被误报成「死标记」。这正是「判据比实现更难写」的例子。
const SINGLE_ARG_ID_HELPERS = ['el', 'getElementById', 'sqGet'];
const FIRST_ARG_ID_HELPERS = ['sqSet', 'numField'];

const referenced = new Set(SINGLE_ARG_ID_HELPERS.flatMap((fn) => [...singleArgLiterals(js, fn)]));
for (const fn of FIRST_ARG_ID_HELPERS) {
  for (const id of firstArgLiterals(js, fn)) referenced.add(id);
}

const declared = new Set();
for (const match of html.matchAll(/\bid="([^"]+)"/g)) declared.add(match[1]);

// 动态前缀：`` `pane-${name}` `` 这种 —— 声明的 id 只要以它开头，就说明「拼接可达」。
const dynamicPrefixes = new Set();
for (const match of js.matchAll(/`([A-Za-z][\w-]*)\$\{/g)) dynamicPrefixes.add(match[1]);

const isDynamic = (id) => [...dynamicPrefixes].some((prefix) => id.startsWith(prefix));
const usedAsSelector = (id) => new RegExp(`#${id}\\b`).test(html) || new RegExp(`#${id}\\b`).test(js);

const missing = [...referenced].filter((id) => !declared.has(id)).sort();
const cssOnly = [];
const suspicious = [];
for (const id of [...declared].filter((id) => !referenced.has(id) && !isDynamic(id)).sort()) {
  (usedAsSelector(id) ? cssOnly : suspicious).push(id);
}

let failed = false;

if (!/src=["'][^"']*app\.js["']/.test(html)) {
  failed = true;
  console.error('✗ index.html 没有加载 app.js —— 整页都是死的（改名只改了一侧？）');
}

if (missing.length) {
  failed = true;
  console.error(`✗ app.js 引用了 ${missing.length} 个 index.html 里**不存在**的 id：`);
  for (const id of missing) console.error(`    ${id}`);
  console.error('  ⚠️ 这一类错的表现是「那个功能静默失效」，不会 panic —— 别放过它。');
}

if (cssOnly.length) {
  console.log(`· ${cssOnly.length} 个 id 只被选择器用（形如 #id { … }），正常：${cssOnly.join('、')}`);
}
if (dynamicPrefixes.size) {
  console.log(`· 动态前缀（拼接出来的 id，脚本看不见）：${[...dynamicPrefixes].join('、')}`);
}
if (suspicious.length) {
  console.warn(`⚠ 有 ${suspicious.length} 个 id **既没被 app.js 引用、也没有选择器用它**，可能是死标记：`);
  for (const id of suspicious) console.warn(`    ${id}`);
  console.warn('  ⚠️ 只是提醒，不算失败 —— 先确认它是不是给将来用的。');
}

if (failed) process.exit(1);

console.log(
  `✓ 手写 UI 自检通过：app.js 引用 ${referenced.size} 个 id，全部存在于 index.html` +
    `（index.html 共 ${declared.size} 个 id）。`,
);
