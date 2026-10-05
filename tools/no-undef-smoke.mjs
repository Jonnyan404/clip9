#!/usr/bin/env node
// 「用了、但从没声明过」的标识符扫描 —— 两边都没有测试运行器的那两个界面。
//
// 用法：
//   node tools/no-undef-smoke.mjs                              # 默认扫真实源码
//   node tools/no-undef-smoke.mjs <web/src> <desktop/ui>   # 用别的夹具跑（变异验证）
//
// # ⚠️ 为什么要有它
//
// `web` 与 `rust/crates/desktop/ui` **都没有测试运行器**（见 MEMORY.md）。于是
// 「标识符写错一个字」的表现是**那一段功能静默失效**：不报错、不 panic，
// 只有真的走到那一行才抛 `ReferenceError` —— 而它多半藏在「点某个按钮」后面。
//
// ⚠️ 这不是假想，是 2026-10-03 实际发生的：
//
// ```js
// export const SHARE_DEFAULT_TTL = 15 * 60;   // 这几行都在
// export const SHARE_MAX_TTL = 24 * 60 * 60;
// ...
// export function normalizeShareMaxUses(maxUses) {
//     if (value > SHARE_MAX_USES_LIMIT) {     // ← 这个常量**从来没声明过**
// ```
//
// 症状：**分享面板里填了次数、点「生成并复制」→ 什么都没发生**。
// 不填次数时 `Number('') === 0` 会在前面就 `return`，所以从来不会碰到那一行 ——
// 也就是说这个 bug 躲在**只有真去用「限制次数」这个功能**的人才会踩到的地方。
//
// # 判据（三条都算失败）
//
// 1. `web/src/**/*.js` 里没有自由标识符既不是声明、也不是 import、也不是内建；
// 2. `rust/crates/desktop/ui/*.js` 同上（那一侧是**多个 classic script 共用一个全局作用域**，
//    所以「顶层 function/var」与「`window.X = …`」都算声明）；
// 3. **`window.X` / `globalThis.X` 的读取，全树里必须有人写过它** ——
//    ⚠️ 这一条是变异验证逼出来的：`window.ActionLibary.ensure()`（少一个字母）在**前两条里
//    完全看不见**，因为 `window.X` 里的名字是**属性名**，不是自由标识符。
//    而桌面界面正是靠 `window.I18N` / `window.ActionLibrary` 这样跨文件连的 —— 拼错一个
//    症状就是「点了没反应」。所以属性名也得有人盯着。
//
// ⚠️ 只报**自由标识符**与**没人写过的 `window.X`**，不报未使用变量、不报风格。

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(join(ROOT, 'web/package.json'));
const acorn = require('acorn');

const WEB_SRC = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : join(ROOT, 'web/src');
const UI_SRC = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : join(ROOT, 'rust/crates/desktop/ui');

/** 宿主注入的全局 —— 不在源码里赋值，但运行时一定有。加名字必须写清是谁给的。 */
const HOST_GLOBALS = new Set([
  '__TAURI__', // Tauri 壳注入（`withGlobalTauri: true`）
  '__TAURI_INTERNALS__',
]);

/** 语言内建 + 浏览器全局。**只放真的全局**：放进来一个业务名字，就等于给它开了后门。 */
const BUILTINS = new Set(`globalThis String Number Boolean Array Object JSON Math Date RegExp Error TypeError
RangeError SyntaxError Map Set WeakMap WeakSet Promise Symbol BigInt Intl URL URLSearchParams TextEncoder TextDecoder
Uint8Array Uint16Array Uint32Array Int8Array Uint8ClampedArray Float32Array Float64Array ArrayBuffer
btoa atob encodeURI encodeURIComponent decodeURI decodeURIComponent parseInt parseFloat isNaN isFinite
structuredClone queueMicrotask setTimeout clearTimeout setInterval clearInterval setImmediate
crypto fetch document window self navigator location history screen console performance
requestAnimationFrame cancelAnimationFrame getComputedStyle matchMedia addEventListener removeEventListener
dispatchEvent innerWidth innerHeight outerWidth outerHeight devicePixelRatio scrollY scrollX pageYOffset
isSecureContext crossOriginIsolated
open close focus blur alert confirm prompt print postMessage top parent frames name origin
localStorage sessionStorage indexedDB
Event CustomEvent MouseEvent PointerEvent KeyboardEvent DragEvent InputEvent SubmitEvent
HTMLElement Element Node Text Comment DocumentFragment DOMParser XMLSerializer
File FileReader FileList Blob FormData Headers Request Response AbortController AbortSignal
Image Audio MediaQueryList ResizeObserver MutationObserver IntersectionObserver PerformanceObserver
Worker WebSocket EventSource BroadcastChannel MessageChannel
Notification caches importScripts skipWaiting clients registration
arguments undefined NaN Infinity this global`.split(/\s+/));

/** 桌面侧的额外全局：Tauri 注入的东西。 */
const UI_EXTRA = new Set(['__TAURI__', '__TAURI_INTERNALS__']);

const KEY_NODES = new Set();

/** 一个模块/脚本里「自由」的标识符（带行号）。 */
function freeIdentifiers(code, ast) {
  const declared = new Set();
  const skip = new Set();

  const walk = (node, visit) => {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (['type', 'start', 'end', 'raw', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
      else if (value && typeof value.type === 'string') walk(value, visit);
    }
  };

  const pattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': declared.add(node.name); skip.add(node); break;
      case 'ObjectPattern':
        node.properties.forEach((p) => pattern(p.type === 'RestElement' ? p.argument : p.value));
        break;
      case 'ArrayPattern': node.elements.forEach(pattern); break;
      case 'AssignmentPattern': pattern(node.left); break;
      case 'RestElement': pattern(node.argument); break;
      default: break;
    }
  };

  walk(ast, (node) => {
    // ⚠️ 三种「看起来像声明、其实不是 VariableDeclarator」的形态，漏一个就是假阳/假阴：
    //   · import 的花括号里那些名字
    //   · `export { X } from './y.js'`（**再导出**：本文件没有绑定，但这个名字不是「没声明」）
    //   · `import.meta`（MetaProperty，会把 `meta` / `import` 当成标识符抓出来）
    if (node.type === 'ImportDeclaration') {
      node.specifiers.forEach((s) => { declared.add(s.local.name); skip.add(s.local); });
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      for (const s of node.specifiers || []) {
        if (s.local) { declared.add(s.local.name); skip.add(s.local); }
        if (s.exported) skip.add(s.exported);
      }
    }
    if (node.type === 'MetaProperty') { skip.add(node.meta); skip.add(node.property); }
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id) { declared.add(node.id.name); skip.add(node.id); }
      node.params.forEach(pattern);
    }
    if (node.type === 'VariableDeclarator') pattern(node.id);
    if (node.type === 'CatchClause') pattern(node.param);
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.id) { declared.add(node.id.name); skip.add(node.id); }
    }
    // 属性名 / 成员访问 / 标签：都不是引用
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(node.type) && !node.computed) KEY_NODES.add(node.key);
    if (node.type === 'MemberExpression' && !node.computed) KEY_NODES.add(node.property);
    if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(node.type) && node.label) KEY_NODES.add(node.label);
  });

  const found = [];
  walk(ast, (node) => {
    if (node.type !== 'Identifier') return;
    if (skip.has(node) || KEY_NODES.has(node)) return;
    if (declared.has(node.name)) return;
    found.push(node);
  });
  return found;
}

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    // ⚠️ `actions-impl*.js` 是 esbuild 的**压缩产物**（tools/sync-action-catalog.mjs 打包的
    //    桌面实现包）：标识符全被改名，拿「未声明标识符」这条判据去读它只会满屏假红。
    //    它的正确性由构建那一刻保证（metafile 里的 exports 与输入清单），不归这里管。
    else if (/^actions-impl/.test(entry.name)) continue;
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

let failed = 0;
const bad = (msg) => { failed += 1; console.log(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);

function scan(label, files, { shared = false, extra = new Set() } = {}) {
  const parsed = [];
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    try {
      parsed.push({ file, code, ast: acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) });
    } catch (error) {
      bad(`${relative(ROOT, file)} 解析失败：${error.message}`);
    }
  }
  // ⚠️ 桌面那侧是**多个 classic script 共用一个全局作用域**：一个文件里定义的
  // `function el()` 在另一个文件里能直接用，所以先把「所有文件的顶层声明」合起来。
  const sharedNames = new Set();
  if (shared) {
    for (const { ast } of parsed) {
      for (const node of ast.body) {
        const d = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node;
        if (d.type === 'FunctionDeclaration' && d.id) sharedNames.add(d.id.name);
        if (d.type === 'VariableDeclaration') {
          for (const x of d.declarations) if (x.id?.type === 'Identifier') sharedNames.add(x.id.name);
        }
        if (d.type === 'ClassDeclaration' && d.id) sharedNames.add(d.id.name);
      }
    }
    // `window.X = …` / `globalThis.X = …` 也是「声明了一个全局」
    for (const { code } of parsed) {
      for (const m of code.matchAll(/(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g)) sharedNames.add(m[1]);
    }
  }

  const hits = [];
  for (const { file, code, ast } of parsed) {
    for (const node of freeIdentifiers(code, ast)) {
      if (BUILTINS.has(node.name) || extra.has(node.name) || sharedNames.has(node.name)) continue;
      hits.push({ file: relative(ROOT, file), name: node.name, line: lineOf(code, node.start) });
    }
  }
  if (hits.length) {
    bad(`${label}：${hits.length} 处用了没声明的标识符（走到那一行就是 ReferenceError）：`);
    for (const hit of hits) console.log(`    ${hit.file}:${hit.line}  ${hit.name}`);
    console.log('    ⇒ 要么补声明，要么删掉——别指望「反正没人点那里」。');
  } else {
    ok(`${label}：${parsed.length} 个文件里没有「用了但没声明」的标识符`);
  }
  return parsed.length;
}

const webCount = scan('web/src', jsFiles(WEB_SRC));
const uiCount = scan('rust/crates/desktop/ui', jsFiles(UI_SRC), { shared: true, extra: UI_EXTRA });

// ── 判据 3：`window.X` 的读取必须有人写过 ────────────────────────────────────
// ⚠️ 前两条看不见属性名：`window.ActionLibary.ensure()` 少一个字母，自由标识符扫描毫无反应。
// 而跨文件连的那几个全局（`window.I18N` / `window.ActionLibrary`）正是这一侧的地基。
{
  const trees = [['web/src', WEB_SRC], ['rust/crates/desktop/ui', UI_SRC]];
  const written = new Set();
  const read = new Map();
  for (const [, dir] of trees) {
    for (const file of jsFiles(dir)) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g)) written.add(m[1]);
      for (const m of code.matchAll(/\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)/g)) {
        const line = code.slice(0, m.index).split('\n').length;
        if (!read.has(m[1])) read.set(m[1], []);
        read.get(m[1]).push(`${relative(ROOT, file)}:${line}`);
      }
    }
  }
  const orphans = [...read].filter(([name]) => !written.has(name) && !BUILTINS.has(name) && !HOST_GLOBALS.has(name));
  if (orphans.length) {
    bad(`判据 3：${orphans.length} 个 window.<名字> 全树里**没人写过**（拼错了？还是宿主该给的没给？）：`);
    for (const [name, where] of orphans) {
      console.log(`    window.${name}  ← ${where.slice(0, 3).join(', ')}${where.length > 3 ? `  …(共 ${where.length} 处)` : ''}`);
    }
    console.log('    ⇒ 要么改对名字，要么在 HOST_GLOBALS 里写清「谁在运行时给这个」——别默默放过。');
  } else {
    ok(`判据 3：${read.size} 个 window.<名字> 都有人写过（或属内建 / 宿主注入）`);
  }
}

console.log();
if (failed) {
  console.log(`✗ 自检失败：${failed} 条（扫了 web ${webCount} 个 + ui ${uiCount} 个文件）`);
  process.exit(1);
}
console.log(`✓ 没有未声明的标识符（web ${webCount} 个 + ui ${uiCount} 个文件）`);
