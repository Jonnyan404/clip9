#!/usr/bin/env node
// 分享的三个上限：**前端常量与服务端常量必须一致** —— 而且不只是数值一致，行为也要一致。
//
// 用法：
//   node tools/share-limits-smoke.mjs                                  # 默认读真实源码
//   node tools/share-limits-smoke.mjs <share-config.js> <share.rs>     # 用别的夹具跑（变异验证）
//
// # ⚠️ 为什么要有它
//
// 「默认有效期 / 最小 / 最大 / 次数上限」这四个数**各写了两遍**：
// 服务端在 `rust/crates/core/src/share.rs`（那是真值，签发时按它归一化），
// 前端在 `web/src/lib/share-config.js`（滑块范围、档位按钮、提交前的兜底都要它）。
//
// ⚠️★ 那一份之所以单独一个文件：桌面端的界面（**没有构建步骤**）也有自己的分享弹窗，
// 它加载的是同一份 —— 由 `tools/sync-action-catalog.mjs` 逐字节拷过去。
// `util.js` 只是**再导出**（加上 `axios` 之类桌面端装不下的依赖）。
// 所以把这四个数抄回 `util.js` 就等于宣告第三处定义存在，忍一句判据 5 拦它。
//
// 两边不一致**不会报错**：服务端只是安静地夹一下。症状是
// **「用户填了 30 分钟，实际生效 15 分钟」**——或者反过来（前端拦掉了服务端本来接受的输入）。
//
// ⚠️★ 而 2026-10-03 这个位置上真的出过事：前端那个 `maxUses` 上限**根本没被声明**
//（`SHARE_MAX_USES_LIMIT` 只被用、没被定义），于是「填了次数、点生成」直接抛
// `ReferenceError`，界面上一片安静。所以这个判据不只比数字 ——
// 它把前端那两个 `normalize*` 函数**抽出来真跑一遍**，用**服务端的数**断言它们的行为：
// 补一个常量容易，补错值、或者忘了在函数里用上它，只有跑起来才看得见。
//
// # 判据（四条都算失败）
//
// 1. 四个上限：前端常量 === 服务端常量（逐个数，报出各自的行号）；
// 2. `normalizeShareTTL` 真的夹到服务端那个区间（下限抬、上限压、0 回落默认）；
// 3. `normalizeShareMaxUses` 同上（`<=0` 归 0 = 不限次数，超过夹到上限）；
// 4. 前端的「分钟」派生值 === 服务端秒数 / 60（UI 滑块用的是分钟，最容易各自取整）；
// 5. 这四个数与那两个 `normalize*` **不许在别处再声明一遍**（`util.js` 只能再导出）。

import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(join(ROOT, 'web/package.json'));
const acorn = require('acorn');

const sharePath = process.argv[2] && process.argv[2] !== '-'
  ? process.argv[2]
  : join(ROOT, 'web/src/lib/share-config.js');
const rustPath = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : join(ROOT, 'rust/crates/core/src/share.rs');

let failed = 0;
const bad = (msg) => { failed += 1; console.log(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);

// ── 服务端那一份：从 Rust 源码里取常量（它可能是个算式，如 `15 * 60`）────────
const rustCode = readFileSync(rustPath, 'utf8');
function rustConst(name) {
  const m = rustCode.match(new RegExp(`pub const ${name}: (?:i64|u64|usize) = ([^;]+);`));
  if (!m) return null;
  const expr = m[1].replace(/_/g, '').trim();
  if (!/^[\d\s*+\-()]+$/.test(expr)) throw new Error(`${name} 的值不是简单算式：${expr}`);
  const line = rustCode.slice(0, m.index).split('\n').length;
  // eslint-disable-next-line no-new-func
  return { value: Function(`return (${expr});`)(), expr, line };
}

const RUST = {
  defaultTtl: rustConst('DEFAULT_SHARE_TTL_SECONDS'),
  minTtl: rustConst('MIN_SHARE_TTL_SECONDS'),
  maxTtl: rustConst('MAX_SHARE_TTL_SECONDS'),
  maxUses: rustConst('MAX_SHARE_MAX_USES'),
};
for (const [key, one] of Object.entries(RUST)) {
  if (!one) bad(`服务端里找不到 ${key} 对应的常量（share.rs 改名字了？）`);
}
if (failed) process.exit(1);

// ── 前端那一份：用 acorn 取出常量与两个 normalize 函数的**源码** ────────────
const shareCode = readFileSync(sharePath, 'utf8');
const shareAst = acorn.parse(shareCode, { ecmaVersion: 'latest', sourceType: 'module' });

const WANTED_CONSTS = ['SHARE_DEFAULT_TTL', 'SHARE_MIN_TTL', 'SHARE_MAX_TTL', 'SHARE_MAX_USES_LIMIT',
  'SHARE_DEFAULT_TTL_MINUTES', 'SHARE_MIN_TTL_MINUTES', 'SHARE_MAX_TTL_MINUTES'];
const WANTED_FUNCS = ['normalizeShareTTL', 'normalizeShareMaxUses', 'minutesToShareTTL'];

const pieces = [];
const constLines = {};
const foundConsts = new Set();
const foundFuncs = new Set();

for (const node of shareAst.body) {
  const decl = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node;
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) {
      const name = d.id?.name;
      if (!WANTED_CONSTS.includes(name)) continue;
      foundConsts.add(name);
      constLines[name] = shareCode.slice(0, node.start).split('\n').length;
      pieces.push(shareCode.slice(node.start, node.end).replace(/^export\s+/, ''));
    }
  }
  if (decl.type === 'FunctionDeclaration' && WANTED_FUNCS.includes(decl.id?.name)) {
    foundFuncs.add(decl.id.name);
    pieces.push(shareCode.slice(node.start, node.end).replace(/^export\s+/, ''));
  }
}
for (const name of WANTED_CONSTS) if (!foundConsts.has(name)) bad(`判据 1：前端里找不到常量 ${name}（被删了 / 改名了？那几个 normalize 会当场抛 ReferenceError）`);
for (const name of WANTED_FUNCS) if (!foundFuncs.has(name)) bad(`判据 2-4：前端里找不到函数 ${name}`);
if (failed) process.exit(1);

// ⚠️ 把这几段源码放进一个临时模块真跑 —— 不 import util.js 本身：
// 它 import 了 axios / marked / DOMPurify，在 Node 里起不来（也正是不能直接测它的原因）。
const dir = mkdtempSync(join(tmpdir(), 'clip9-share-limits-'));
const modPath = join(dir, 'limits.mjs');
writeFileSync(modPath, `${pieces.join('\n\n')}\n\nexport { ${[...WANTED_CONSTS, ...WANTED_FUNCS].join(', ')} };\n`);
const spa = await import(modPath);

// ── 判据 1：四个上限逐个数 ─────────────────────────────────────────────────
const PAIRS = [
  ['默认有效期', 'SHARE_DEFAULT_TTL', RUST.defaultTtl],
  ['最小有效期', 'SHARE_MIN_TTL', RUST.minTtl],
  ['最大有效期', 'SHARE_MAX_TTL', RUST.maxTtl],
  ['次数上限', 'SHARE_MAX_USES_LIMIT', RUST.maxUses],
];
console.log('  上限         前端                服务端');
const mismatched = [];
for (const [label, spaName, rust] of PAIRS) {
  const mine = spa[spaName];
  const same = mine === rust.value;
  console.log(`  ${label.padEnd(12)} ${String(mine).padEnd(10)}(${spaName}:${constLines[spaName]})  ${String(rust.value).padEnd(8)}(share.rs:${rust.line})`);
  if (!same) mismatched.push(`${label}：前端 ${spaName}=${mine}，服务端=${rust.value}`);
}
if (mismatched.length) {
  bad(`判据 1：${mismatched.length} 个上限两边不一致（服务端会安静地夹，用户只会看到「填了没生效」）：`);
  for (const one of mismatched) console.log(`    ${one}`);
} else {
  ok(`判据 1：4 个上限两边一致（默认 ${RUST.defaultTtl.value}s / 区间 ${RUST.minTtl.value}-${RUST.maxTtl.value}s / 次数 ≤${RUST.maxUses.value}）`);
}

// ── 判据 2/3：两个 normalize 的**行为**得用服务端的数来说话 ────────────────
const checks = [
  ['判据 2', 'TTL 低于下限被抬到服务端下限', () => spa.normalizeShareTTL(RUST.minTtl.value - 1) === RUST.minTtl.value],
  ['判据 2', 'TTL 高于上限被压到服务端上限', () => spa.normalizeShareTTL(RUST.maxTtl.value + 1) === RUST.maxTtl.value],
  ['判据 2', 'TTL 给 0 / 空 → 落到服务端默认值', () => spa.normalizeShareTTL(0) === RUST.defaultTtl.value && spa.normalizeShareTTL('') === RUST.defaultTtl.value],
  ['判据 2', 'TTL 区间内的值原样保留', () => spa.normalizeShareTTL(RUST.minTtl.value) === RUST.minTtl.value],
  ['判据 3', '次数超过服务端上限被夹住', () => spa.normalizeShareMaxUses(RUST.maxUses.value + 1) === RUST.maxUses.value],
  ['判据 3', '次数正好等于上限 → 原样', () => spa.normalizeShareMaxUses(RUST.maxUses.value) === RUST.maxUses.value],
  ['判据 3', '次数 0 / 空 / 负数 → 0（不限次数）', () => spa.normalizeShareMaxUses(0) === 0 && spa.normalizeShareMaxUses('') === 0 && spa.normalizeShareMaxUses(-5) === 0],
  ['判据 3', '次数是小数 → 向下取整', () => spa.normalizeShareMaxUses(2.9) === 2],
  ['判据 4', '分钟档位 × 60 落回服务端默认值', () => spa.minutesToShareTTL(spa.SHARE_DEFAULT_TTL_MINUTES) === RUST.defaultTtl.value],
  ['判据 4', '分钟派生值 = 服务端秒数 / 60', () => spa.SHARE_MIN_TTL_MINUTES === Math.floor(RUST.minTtl.value / 60) && spa.SHARE_MAX_TTL_MINUTES === Math.floor(RUST.maxTtl.value / 60)],
];
const byJudge = new Map();
for (const [judge, what, run] of checks) {
  let pass = false;
  let err = '';
  try { pass = Boolean(run()); } catch (error) { err = `（抛了 ${error.constructor.name}: ${error.message}）`; }
  if (!byJudge.has(judge)) byJudge.set(judge, []);
  byJudge.get(judge).push({ what, pass, err });
}
for (const [judge, list] of byJudge) {
  const broken = list.filter((one) => !one.pass);
  if (broken.length) {
    bad(`${judge}：${broken.length}/${list.length} 条行为与**服务端的数**对不上：`);
    for (const one of broken) console.log(`    ${one.what}${one.err}`);
  } else {
    ok(`${judge}：${list.length} 条行为都与服务端的数一致`);
  }
}

// ── 判据 5：那四个数与那两个 normalize **不许在别处再声明一遍** ───────────────
// 「正面 comprise 一遍」很容易在 `util.js` 里发生：你想加一个小工具，顺手把 `SHARE_MAX_TTL`
// 再 const 一次 —— 那样桌面端的滑块用的是 `share-config.js` 那份，而网页的一部分调用点
// 用的是 `util.js` 那份，两边从此各走各路，**没有任何报错**。
{
  const reDeclared = [];
  // ⚠️ `rust/crates/desktop/ui/share-config.js` **故意不查**：它本来就是这一份的逐字节拷贝
  //（`tools/sync-action-catalog.mjs` 搬的），equality 由 `action-catalog-smoke` 那条判据盯。
  // 把它算进来只会让每条 Build -flag 的价值都变成零。
  const others = ['web/src/lib/util.ts'];
  for (const rel of others) {
    if (resolve(sharePath) === resolve(join(ROOT, rel))) continue; // 夹具模式：比的就是它自己
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    const code = readFileSync(path, 'utf8');
    // ⚠️★ 用正则而不是 acorn：这一份是 **TypeScript**（`.ts`），acorn 解不了 TS 语法
    //（会抛 SyntaxError 把整条门禁带崩）。这里只需要「有没有再声明一遍」这一个事实，正则够了。
    for (const name of [...WANTED_CONSTS, ...WANTED_FUNCS]) {
      const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var|function)\\s+${name}\\b`);
      if (re.test(code)) {
        reDeclared.push(`${rel} 里的 ${name}`);
      }
    }
  }
  if (reDeclared.length) {
    bad(`判据 5：这些名字在别处**又声明了一遍**（桌面端看不见那一份）：`);
    for (const one of reDeclared) console.log(`    ${one}`);
    console.log('  ⚠️ `util.js` 应当只用 `export { … } from "./share-config.js"` 转出来。');
  } else {
    ok(`判据 5：${WANTED_CONSTS.length + WANTED_FUNCS.length} 个名字只在 share-config.js 里声明过一次（util.js 是再导出）`);
  }
}

console.log();
if (failed) {
  console.log(`✗ 分享上限自检失败：${failed} 条`);
  process.exit(1);
}
console.log('✓ 分享上限前后端一致');
