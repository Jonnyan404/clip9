#!/usr/bin/env node
// `window.clip9Share` 的自检 —— 「外壳 → SPA」这条缝。
//
// 用法：
//   node tools/share-bridge-smoke.mjs
//   node tools/share-bridge-smoke.mjs --spa /tmp/mut/src --kt /tmp/mut/WebAppActivity.kt
//
// ⚠️★ 为什么需要它：这条缝的**两侧都没有测试运行器** ——
//   · `web` 是手写前端，没有 runner（见项目笔记）；
//   · `android/` 那半边**没有测试运行器**：Kotlin 只在 CI 里编过，
//     「跑起来对不对」要真机才算数（见 `android/DEVELOPING.md` §三）。
// 而它们之间的连接是**按字面量**做的：Kotlin 把 `window.clip9Share.sendText(...)` 当字符串
// 注入 WebView，SPA 回的是 reason **键**。对不上的症状是**什么都没发生**
// （`undefined is not a function` 会被 WebView 吞掉，reason 键对不上就只显示一句兜底话）。
// 这类「静默失效」正是该用静态判据钉住的。
//
// ⚠️ 判据只留**真会坏事**的那几条（缺少方法 / 没装上 / 键对不上 / 又抄了一份实现）。
// 反向的（「定义了但没人用」）**只提示**，见文件末尾。
//
// ⚠️★ 关于定位函数体：这里的正则**依赖缩进**（方法定义在 8 空格、对象结束在 4 空格），
// 那是因为它是手写文件、结构稳定。⚠️ 真要改格式的话**该来改这个脚本**，
// 而不是让它悄悄放过 —— 这也是为什么下面每个切片失败时都报得很具体。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const SPA = resolve(argValue('--spa', join(ROOT, 'web/src')));
const KT = resolve(
  argValue('--kt', join(ROOT, 'android/app/src/main/java/com/clip9/app/WebAppActivity.kt')),
);
// ⚠️ React 版里这三个各住一处（Vue 版是 src/ 下的扁平文件）。
const SHARE = join(SPA, 'services/shareBridge.ts');
const SEND = join(SPA, 'services/send.ts');
const MAIN = join(SPA, 'main.tsx');

/** 契约里的三个方法名。⚠️ 少一个 = 外壳那边那一句永远 undefined。 */
const METHODS = ['isReady', 'sendText', 'sendFiles'];

const failures = [];
const notices = [];

function fail(label, detail) {
  failures.push({ label, detail });
}

function ok(label) {
  console.log(`✓ ${label}`);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

/** 取 `from` 之后到 `to`（首次出现）之间的那段。⚠️ 找不到就返回 null，别静默返回空串。 */
function slice(src, from, to) {
  const start = src.indexOf(from);
  if (start < 0) return null;
  const end = src.indexOf(to, start + from.length);
  if (end < 0) return null;
  return src.slice(start, end);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const shareSrc = read(SHARE);
const sendSrc = read(SEND);
const mainSrc = read(MAIN);
const ktSrc = read(KT);

// ── 1. 契约里的三个方法都在 ────────────────────────────────────────────────
const bridgeBody = slice(shareSrc, 'const bridge', '\n    };');
let methods = [];
if (bridgeBody === null) {
  fail('share.js 里找得到 `const bridge = { … };`', '切不出对象字面量（格式改过了？）');
} else {
  methods = [...bridgeBody.matchAll(/^ {8}(?:async )?([A-Za-z_]\w*)\([^)]*\)\s*\{/gm)].map(
    (m) => m[1],
  );
  const missing = METHODS.filter((name) => !methods.includes(name));
  if (missing.length) {
    fail(`window.clip9Share 有 ${METHODS.join(' / ')}`, `缺：${missing.join('、')}`);
  } else {
    ok(`window.clip9Share 有 ${METHODS.join(' / ')}`);
  }
  const extra = methods.filter((name) => !METHODS.includes(name));
  if (extra.length) {
    notices.push(`share.js 还多了方法：${extra.join('、')}（外壳没用它，无害）`);
  }
}

// ── 2. SPA 真的把它装上了 ─────────────────────────────────────────────────
// ⚠️ 「定义了一处但没人调」= 整个能力不存在，而**构建照样成功**（这是最容易漏的坏法）。
if (mainSrc.includes('installShareBridge()') && mainSrc.includes('installShareBridge')) {
  ok('main.js 调了 installShareBridge()');
} else {
  fail('main.js 调了 installShareBridge()', '没找到调用 —— 桥定义了却没人装，等于没有');
}

// ── 3. Kotlin 侧用到的名字都在契约里 ──────────────────────────────────────
{
  const used = [...ktSrc.matchAll(/clip9Share\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
  const unknown = [...new Set(used)].filter((name) => !METHODS.includes(name));
  if (unknown.length) {
    fail(
      'Kotlin 注入的 JS 只调契约里的方法',
      `用到了不在契约里的名字：${unknown.join('、')}（注入过去只会是 undefined）`,
    );
  } else {
    ok(`Kotlin 侧用到的方法都在契约里（${[...new Set(used)].join('、') || '一个也没有'}）`);
  }
}

// ── 4. reason 键：Kotlin 不许凭空发明 SPA 不认识的键 ──────────────────────
const jsReasonsBody = slice(shareSrc, 'SHARE_REASONS = Object.freeze({', '});');
const ktReasonBody = slice(ktSrc, 'private fun shareReasonText', 'else ->');
let jsReasons = [];
if (jsReasonsBody === null) {
  fail('share.js 里找得到 SHARE_REASONS', '切不出来（改过名字？那 Kotlin 那边也得改）');
} else {
  jsReasons = [...jsReasonsBody.matchAll(/:\s*'([a-z][\w-]*)'/g)].map((m) => m[1]);
}
if (ktReasonBody === null) {
  fail('WebAppActivity 里有 shareReasonText 的 when 表', '切不出来（改名/换写法了？）');
} else {
  const ktReasons = [...ktReasonBody.matchAll(/"([a-z][\w-]*)"\s*->/g)].map((m) => m[1]);
  const invented = ktReasons.filter((key) => !jsReasons.includes(key));
  if (invented.length) {
    fail(
      'Kotlin 的 reason 表里没有 SPA 不认识的键',
      `${invented.join('、')} 不在 share.js 的 SHARE_REASONS 里 —— 外壳会永远显示兜底那句话`,
    );
  } else {
    ok(`Kotlin 的 reason 表（${ktReasons.length} 个键）都在 share.js 的 SHARE_REASONS 里`);
  }
  // 反向：只提示。⚠️ `files-unsupported` 现在**预期**会出现在这里（文件那条还没做）。
  const uncovered = jsReasons.filter((key) => !ktReasonBody.includes(`"${key}"`));
  if (uncovered.length) {
    notices.push(`SPA 定义了、外壳还没处理的键：${uncovered.join('、')}（会落到兜底那句话上）`);
  }
}

// ── 5. 「发一条文本」只有一处实现 ─────────────────────────────────────────
// ⚠️★ 这条是这次新加的**契约**：原来这条 POST 在四个地方各写了一份，而且带不带 `?client=`
// 都不一样（标准模式漏了它 → 「我发的」永远标不出来）。现在只许 `send.js` 有一份。
const TEXT_POST = "axios.post('text'";
{
  // ⚠️★ 剥掉行注释再找：注释里提一句 `axios.post('text')` 不该被当成「又一份实现」
  //（React 版的 services/http.ts 抬头正好有这么一句说明）。判据要盯的是**代码**。
  const codeOnly = (text) => text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  const hitFiles = walk(SPA)
    .filter((file) => /\.(js|ts|tsx|vue)$/.test(file))
    .filter((file) => codeOnly(read(file)).includes(TEXT_POST))
    .map((file) => relative(SPA, file).split(/[\\/]/).join('/'));
  const allowed = ['services/send.ts', 'services/share.ts'];
  const unexpected = hitFiles.filter((file) => !allowed.includes(file));
  if (unexpected.length) {
    fail(
      `\`axios.post('text'\` 只出现在 services/send.ts / services/share.ts`,
      `${unexpected.join('、')} 里又写了一份 —— 请改用 services/send.ts 的 postText()`,
    );
  } else if (!hitFiles.includes('services/send.ts') || !hitFiles.includes('services/share.ts')) {
    fail(
      `\`axios.post('text'\` 只出现在 services/send.ts / services/share.ts`,
      `实际是 ${hitFiles.join('、') || '一处都没有'} —— 有人把其中一处删了或挪了`,
    );
  } else {
    ok(`\`axios.post('text'\` 只在 services/send.ts（新建）与 services/share.ts（按 id 更新）各一份`);
  }
  // ⚠️ services/share.ts 那一处必须是**按 id 更新**（`?id=`），不是又一份新建。
  const updateSrc = codeOnly(read(join(SPA, 'services/share.ts')));
  const updateHit = updateSrc.indexOf(TEXT_POST);
  const updateTail = updateSrc.slice(updateHit, updateHit + 240);
  if (updateHit < 0 || !updateTail.includes("'id'")) {
    fail('services/share.ts 那一处带 `?id=`', '它看起来是又一次「新建」而不是「更新已有条目」');
  }
}

// ── 6. 分享桥自己走共享的那条路 ───────────────────────────────────────────
if (shareSrc.includes('postText(')) {
  ok('share.js 走 send.js 的 postText()（没有第五份实现）');
} else {
  fail('share.js 走 send.js 的 postText()', '分享桥自己发了请求 —— 那又是一份实现');
}

// ── 7. 共享函数必须带 `?client=` ─────────────────────────────────────────
// ⚠️ 服务端 `handlers.rs` 的 `sender_base` 注释：「客户端 ID 来自 `?client=`，
// 用于气泡收发归属」。缺了它的症状是**永远分不出「我发的」**，而且不报错。
if (sendSrc.includes("['client'")) {
  ok('send.js 的 postText 带 `?client=`');
} else {
  fail('send.js 的 postText 带 `?client=`', '缺了它服务端存下的 sender_client_id 是空串');
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
for (const notice of notices) {
  console.log(`· ${notice}`);
}

const total = 7;
console.log('');
if (failures.length) {
  for (const { label, detail } of failures) {
    console.error(`✗ ${label}\n    ${detail}`);
  }
  console.error(`\n✗ ${failures.length}/${total} 条判据没过。`);
  process.exit(1);
}
console.log(`✓ 分享桥自检通过：${total} 条判据全过（另有 ${notices.length} 条反向提示）。`);
