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
// # 判据（**只有第 1、4 条算失败**）
//
// 1. `app.js` 引用到的每一个 id，`index.html` 里必须存在 —— 不通过 = 退出码 1；
// 2. `index.html` 真的加载了 `app.js`（改名只改一侧 = 整页不工作）；
// 3. 反向（HTML 有、JS 没引用）**只提示**，而且分两种：
//    · 「只被选择器用」（`#rooms-table { … }` 这类样式钩子）→ 正常，**不吵**；
//    · 「既没被 JS 引用、也没有选择器用它」→ 才提一句（可能是死标记，与 §8.1 第 6 条那两段死 CSS 同类）。
// 4. 每一个**能打字**的输入框（`type="text"` / 不带 `type` 的 `<input>` / `<textarea>`）
//    必须带 `autocapitalize="off"` —— 不通过 = 退出码 1。理由见下。
// 5. 新建房间的默认**不许打开上行**（`addRoomRow`）—— 不通过 = 退出码 1。理由见下。
// 6. **提示要说得出它是「哪个房间」的事** —— `render` 要把 `state.notice.room`
//    喂给 `showNotice`，而 `showNotice` 要真的把它显示出来。不通过 = 退出码 1。理由见下。
// 7. `NOTICE_MS` 不许再回到「挂十几秒」—— 不通过 = 退出码 1。理由见下。
//
// # ⚠️ 第 4 条为什么算失败，而不是「提一句」
//
// macOS 会把文本框里**每句的首字母**自动大写，而这个界面里被用户手打的每一格
// 都是**不许改字面**的东西：服务端地址、房间名、凭据、要发出去的消息正文。
// 实测踩到（2026-09-27）：地址格里的 `https://` 被写成 `Https://`，
// 表现是「明明填对了却连不上」—— 而**一个字母的大小写**是看不出来的，
// 用户查了半天网络。⚠️ 它不会让任何东西报错，所以只有这里能拦。
//
// ⚠️★ 看**两个**入口：`index.html` 里写死的，与 `app.js` 现造的（`cellInput`）。
// 只看一边的话，另一边新加的框会静默漏过去 —— 而漏过去**不报错**。
// ⚠️ 扫描前要先**剥掉注释与 `<style>`**：CSS 注释里就写着 `<input>`（讲表格列宽那段），
// 不剥的话会把它当成一个真的输入框来报。
//
// # ⚠️ 第 5 条为什么算失败
//
// 「加一个房间」是**用户已经养成的手势**（侧栏那个「＋」），而他不会想到要回头去关 ↑。
// 于是「新建房间默认打开上行」的实际后果是：**点一下加房间就开始把本机剪贴板发出去**
// —— 静默、不报错、也不在界面上留下任何痕迹（侧栏那个 ↑ 是亮的，但没人会去看）。
// Jonny 2026-09-27 明确改掉了这个默认（原来是 `true`），那就得有一条命令守着它。
// ⚠️ 这与 §4.1 第 3 条（装完不该自动接管剪贴板）是同一条规矩，只是触发点不同。
// ⚠️ 判据只钉**这一处默认值**，不做别的道德检查：改成 `false` 是对的，
// 而「保存时怎么读这个字段」由 `uploadOn()` 那一个定义管（缺字段 = 关）。
//
// # ⚠️ 第 6 条为什么算失败（提示要带上房间名）
//
// 界面那一条提示是**全局一格**（`#notice`），却长在「当前选中房间」的标题下面 ——
// 于是一条**为别的房间**产生的提示（典型是异步回来才失败的「取历史失败」：用户很可能
// 已经切走了）会看起来像这个房间出的事。Jonny 2026-09-27 报的就是这个（「提示串房间了」）。
//
// 修法分两半，**一半在 Rust、一半在这里**：壳里 `Notice` 多了个 `room` 字段
// （`store.rs` 的 `notice_in`），而界面必须把它**接住并显示**。
// ⚠️★ 这就是「跨语言接缝」那一类：Rust 那半有测试钉着，**这半没有运行器** ——
// 界面要是把第三个参数丢掉，`cargo test` 全绿、界面也**不报错**，只是提示又变得没有主语
//（§8.1 第 2 条那种「漏一处字段就静默失效」的同一个形状）。
// 所以这里逐条钉：① `render` 有没有**把 `state.notice.room` 喂进去**；
// ② `showNotice` 有没有**拿 `room` 去拼那句话**。少任何一半都算失败。
// ⚠️ 判据只认「`room` 出现在那句模板串里」这一种写法 —— 换一种拼法会**红**，
// 那是**故意的**：这时该来改这条判据，而不是让它悄悄放过（脚本头那句话说过了）。
//
// # ⚠️ 第 7 条为什么算失败（提示停留 3 秒）
//
// Jonny 2026-09-27：「提示停留时间过长了，3s 就挺好的」。原来写的是 15 秒，
// 于是「切个房间它还杵在那儿」—— 看起来就像**别的房间**的提示（与第 6 条同一个抱怨）。
// ⚠️ 这个数字**没有任何别的保护**：它不是契约、没有测试、也没写在别处，
// 改回去只是把用户报过的那条 bug 再种一遍，而**谁都不会注意到**。
// 判据只给一个上界（不是「必须等于 3000」）：留出微调空间，拦住的是「又挂回十几秒」。
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

// ── 判据 4：能打字的框都要 `autocapitalize="off"`（理由见文件头）──────────
// ⚠️ 先剥注释与样式表：CSS 注释里写着 `<input>`，不剥会被当成真的输入框。
const markup = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '');

const autoCapMissing = [];
for (const match of markup.matchAll(/<(input|textarea)\b[^>]*>/gi)) {
  const tag = match[0];
  // ⚠️ `<input>` **不带 `type` 就是 text**（HTML 的默认值）—— 别只看写了 type 的那些。
  const typesText = !/\btype\s*=/i.test(tag) || /\btype\s*=\s*["']text["']/i.test(tag);
  if (typesText && !/autocapitalize\s*=\s*["']off["']/i.test(tag)) autoCapMissing.push(tag.trim());
}

// ⚠️ JS 那侧用**计数**：`cellInput` 这类工厂每造一个文本框就该关一次自动大写。
// 不是逐个匹配（那是给文本做结构分析，假的精确），而是「造了几个、关了几个」对不上就说话。
const jsTextFields = (js.match(/\.type\s*=\s*['"]text['"]/g) ?? []).length;
const jsNoAutoCap = (js.match(/\.setAttribute\(\s*['"]autocapitalize['"]\s*,\s*['"]off['"]\s*\)/g) ?? []).length;

if (autoCapMissing.length || jsTextFields !== jsNoAutoCap) {
  failed = true;
  console.error('✗ 有能打字的输入框没关掉「首字母自动大写」（macOS 会把地址打成 `Https://`）：');
  for (const tag of autoCapMissing) console.error(`    index.html: ${tag}`);
  if (jsTextFields !== jsNoAutoCap) {
    console.error(
      `    app.js: 造了 ${jsTextFields} 个文本输入框，只关了 ${jsNoAutoCap} 个的自动大写` +
        '（找 `cellInput` 那一类工厂）。',
    );
  }
  console.error('  ⚠️ 加上 `autocapitalize="off"`；确实要自动大写的话，先想清楚那一格是不是「不许改字面」的。');
}

// ── 判据 5：新建房间不许默认开上行（理由见文件头）────────────────────
// ⚠️ 找的是**那个对象字面量**（`addRoomRow` 的函数体），而不是全文 grep `enable_upload: true`：
// 别处（保存、渲染）出现 `true` 是正常的，只有「新加的那一行」不许带上它。
// ⚠️ 找不到函数 = 也算失败：自检要跟着代码改，不能悄悄失效（那正是这个脚本存在的理由）。
const addRoomRow = js.match(/function addRoomRow\(\)\s*\{[\s\S]*?\n\}/);
if (!addRoomRow) {
  failed = true;
  console.error('✗ 找不到 `addRoomRow` —— 这条自检要跟着改（它钉的是「加房间不顺手打开 ↑」）。');
} else if (/enable_upload\s*:\s*true/.test(addRoomRow[0])) {
  failed = true;
  console.error('✗ `addRoomRow` 又把新房间的上行默认成 `true` 了：');
  console.error('    那等于「点一下加房间就开始往外发本机剪贴板」—— 用户不会回头去关那个 ↑。');
}

// ── 判据 6：提示要带房间名，而且界面要真的显示它（理由见文件头）────────────
// ① 喂：`render` 里那次调用必须把 `state.notice.room` 传进去。
if (!/showNotice\([^)]*state\.notice\.room/.test(js)) {
  failed = true;
  console.error('✗ `render` 没有把 `state.notice.room` 喂给 `showNotice`：');
  console.error('    那样壳里那条提示的房间名就白带了 —— 它又会挂在「当前选中房间」下面。');
}

// ② 显示：`showNotice` 的函数体里要拿 `room` 去拼那句话。
// ⚠️ 找的是函数体本身（不是一个全局 grep `room`：全文到处都有这个名字，grep 等于没测）。
const showNoticeDef = js.match(/function showNotice\(([^)]*)\)\s*\{[\s\S]*?\n\}/);
if (!showNoticeDef) {
  failed = true;
  console.error('✗ 找不到 `showNotice` —— 这条自检要跟着改（它钉的是「提示要说清是哪个房间」）。');
} else {
  const params = showNoticeDef[1].split(',').map((name) => name.trim());
  if (!params.includes('room')) {
    failed = true;
    console.error(`✗ \`showNotice\` 没有接房间名（形参是 ${showNoticeDef[1].trim() || '空'}）：`);
    console.error('    壳里带了房间名，界面却收不下 —— 提示又变成「没有主语」。');
  } else if (!/\$\{room\}/.test(showNoticeDef[0])) {
    failed = true;
    console.error('✗ `showNotice` 收了 `room` 却没拿它拼那句话：');
    console.error('    房间名收下了不用，等于没带 —— 那句提示还是会被认成当前这个房间的事。');
  }
}

// ── 判据 7：提示不许再挂十几秒（理由见文件头）──────────────────────────
const noticeMs = js.match(/\bNOTICE_MS\s*=\s*(\d+)/);
const NOTICE_MS_MAX = 5000;
if (!noticeMs) {
  failed = true;
  console.error('✗ 找不到 `NOTICE_MS` —— 这条自检要跟着改（它钉的是「提示 3 秒后就收」）。');
} else if (Number(noticeMs[1]) > NOTICE_MS_MAX) {
  failed = true;
  console.error(`✗ 提示要停留 ${noticeMs[1]}ms —— 又回到「挂十几秒」了：`);
  console.error(`    Jonny 2026-09-27 定的是 3 秒（这里只给上界 ${NOTICE_MS_MAX}ms）。`);
  console.error('    挂久了用户会开始怀疑它是不是当前状态，而切房间时它还杵在那儿。');
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
