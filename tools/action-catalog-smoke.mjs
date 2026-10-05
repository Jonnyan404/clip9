#!/usr/bin/env node
// 动作库的跨文件静态自检。
//
// 用法：
//   node tools/action-catalog-smoke.mjs                 # 在 clip9/ 下跑
//   node tools/action-catalog-smoke.mjs <catalog.json> <pure.js> <impl.js> <actions-labels.json> <ui 目录>
//                                                       # 用别的夹具跑（变异验证 / 临时排查）
//   ⚠️ 位置参数写 `-` 就是「这一项用默认值」。
//
// # ⚠️ 为什么要有它
//
// 动作库拆成了四份文件（`web/src/lib/actions/{catalog.json,pure.js,impl.js}` + 桌面侧那份
// 逐字节拷贝），它们之间靠**字符串名字**连着：目录里的 `run: "runUpper"` 指的是另一份文件里的
// 一个导出。没有任何编译器看着这条线 ——
//
//   · 名字写错 / 忘了写实现 → **网页版装载时当场抛错**（`actions.js` 的 registry 查表）；
//   · 桌面侧更是**运行时**才去 `fetch`/`import` 那两份文件，错了就是「动作菜单点了没反应」。
//
// ⚠️ 这一条不是假想：拆分过程中真的写错过一次 —— `encode.url` 的 run 被写成内建的
// `encodeURIComponent`（不是任何一份文件里的导出），是**拿老实现当 oracle 逐条对跑**才炸出来的。
// 那个台子是一次性的；这条判据是它的常驻版本。
//
// # 判据（前 7 条算失败，第 8 条只提示）
//
// 1. 目录里**每个 `match` / `run` 的名字都有实现**（在 pure.js 或 impl.js 的导出里）；
// 2. `id` 不重复、`group` 都在 `groups` 里、`direction` 合法、`run` 必填、`nameKey` 必填；
// 3. **`pure.js` 零 import**（铁律：桌面端只能加载自足的模块）；
// 4. 桌面那份拷贝与源**逐字节一致**（`sync-action-catalog.mjs --check` 的核心，这里再兜一次）；
// 5. 桌面那份 `actions-labels.json` 覆盖了**目录与 pure.js 引用到的全部键**，且 zh / en 都有；
// 6. 桌面**真的用上了**它：`ui/index.html` 加载了 `action-library.js`，`ui/app.js` 调了
//    `window.ActionLibrary`；
// 7. **两件事都接进了门禁**：CI 的 frontend job 里有 `sync-action-catalog.mjs --check`，
//    `tools/release.sh` 的 `GATES` 里有本判据 —— 没接进门禁的自检等于没有；
// 8. （只提示）`ui/app.js` 里出现了 `pure.js` 里的实现名 —— 那可能是有人把实现**又抄了一份**。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULTS = {
  catalog: join(ROOT, 'web/src/lib/actions/catalog.json'),
  pure: join(ROOT, 'web/src/lib/actions/pure.js'),
  impl: join(ROOT, 'web/src/lib/actions/impl.js'),
  labels: join(ROOT, 'rust/crates/desktop/ui/actions-labels.json'),
  ui: join(ROOT, 'rust/crates/desktop/ui'),
  sync: join(ROOT, 'rust/crates/desktop/ui/actions.sync.json'),
};

const argv = process.argv.slice(2);
const pick = (i, fallback) => (argv[i] && argv[i] !== '-' ? argv[i] : fallback);
const F = {
  catalog: pick(0, DEFAULTS.catalog),
  pure: pick(1, DEFAULTS.pure),
  impl: pick(2, DEFAULTS.impl),
  labels: pick(3, DEFAULTS.labels),
  ui: pick(4, DEFAULTS.ui),
  sync: existsSync(argv[5] ?? '') ? argv[5] : DEFAULTS.sync,
  // 「源」那一份永远在 web 下 —— 拷过去的那份要跟它逐字节比。
  // ⚠️ `slash-template.js` 也在这条线上（2026-10-03 起桌面端那个输入框也用它），
  // 所以它与 pure.js 受**同一条**「零 import + 逐字节一致」的约束。位置参数没给它留位置：
  // 它与 `pure.js` 一样是「只有一份源」的东西，用默认值就够（要跑夹具就改 `ui`）。
  source: {
    catalog: DEFAULTS.catalog,
    pure: DEFAULTS.pure,
    slash: join(ROOT, 'web/src/lib/slash-template.js'),
    // ⚠️ `share-config.js` 不是动作库的一部分，但走的**是同一条搬运线**
    //（2026-10-03 起桌面端的分享面板也加载它），所以受同一条「零 import + 逐字节一致」约束。
    share: join(ROOT, 'web/src/lib/share-config.js'),
  },
};

let failed = 0;
const bad = (msg) => { failed += 1; console.log(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);
const warn = (msg) => console.log(`⚠ ${msg}`);
const plain = (msg) => console.log(`  ${msg}`);

/** 一个模块里 `export function X` / `export const X` 的名字。 */
function exportNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_]\w*)/gm)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const one of m[1].split(',')) {
      const name = one.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const catalogText = readFileSync(F.catalog, 'utf8');
const pureText = readFileSync(F.pure, 'utf8');
const implText = existsSync(F.impl) ? readFileSync(F.impl, 'utf8') : '';
const catalog = JSON.parse(catalogText);
const actions = catalog.actions ?? [];
const groups = new Set((catalog.groups ?? []).map((g) => g.key));

// ── 判据 1：每个名字都有实现 ────────────────────────────────────────────────
const provided = new Set([...exportNames(pureText), ...exportNames(implText)]);
const missing = [];
for (const action of actions) {
  for (const field of ['match', 'run']) {
    const name = action[field];
    if (!name) continue;
    if (!provided.has(name)) missing.push(`${action.id}.${field} → ${name}`);
  }
}
if (missing.length) {
  bad(`判据 1：有 ${missing.length} 个名字找不到实现（网页版装载时会当场抛错）：`);
  for (const one of missing) plain(one);
} else {
  ok(`判据 1：${actions.length} 条动作的 match/run 共 ${actions.length + actions.filter((a) => a.match).length} 个名字，全部有实现`);
}

// ── 判据 2：目录自身的形状 ─────────────────────────────────────────────────
const problems = [];
const seen = new Set();
for (const action of actions) {
  if (!action.id) problems.push('有一条没有 id');
  if (seen.has(action.id)) problems.push(`id 重复：${action.id}`);
  seen.add(action.id);
  if (!groups.has(action.group)) problems.push(`${action.id} 的分组 ${action.group} 不在 groups 里`);
  if (!['view', 'insert'].includes(action.direction)) problems.push(`${action.id} 的 direction=${action.direction}`);
  if (!action.run) problems.push(`${action.id} 没有 run`);
  if (!action.nameKey) problems.push(`${action.id} 没有 nameKey`);
}
if (problems.length) {
  bad(`判据 2：目录形状有 ${problems.length} 处问题：`);
  for (const one of problems) plain(one);
} else {
  ok(`判据 2：${actions.length} 条动作的 id / 分组 / direction / run / nameKey 都齐（${groups.size} 个分组）`);
}

// ── 判据 3：pure.js / slash-template.js / share-config.js 零 import ─────────
// ⚠️ 三份一起管：后两份桌面端也要 `import()` 它们，而那一侧**没有构建步骤**，
//    一个 `@/…` 的路径在网页版里好好的、到了桌面端就是「菜单永远不弹 / 点了没反应」。
const slashText = existsSync(F.source.slash) ? readFileSync(F.source.slash, 'utf8') : '';
const shareText = existsSync(F.source.share) ? readFileSync(F.source.share, 'utf8') : '';
if (!slashText) {
  bad(`判据 3：找不到 ${F.source.slash}（桌面端的「/」菜单靠它）`);
}
if (!shareText) {
  bad(`判据 3：找不到 ${F.source.share}（桌面端的分享面板靠它 —— 那份区间只有一处定义）`);
}
const importLines = [pureText, slashText, shareText].flatMap((text) =>
  text.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*(import\s|export\s[^;]*\sfrom\s)/.test(line)));
if (importLines.length) {
  bad(`判据 3：pure.js / slash-template.js / share-config.js 里有 ${importLines.length} 处 import/再导出（桌面端加载不了，会静默失效）：`);
  for (const [n, line] of importLines.slice(0, 5)) plain(`第 ${n} 行：${line.trim().slice(0, 90)}`);
} else {
  ok('判据 3：pure.js / slash-template.js / share-config.js 都零 import / 零再导出（桌面端能自足加载）');
}

// ── 判据 4：桌面那份拷贝与源逐字节一致 ──────────────────────────────────────
const copies = [
  [join(F.ui, 'actions-catalog.json'), F.source.catalog, '目录'],
  [join(F.ui, 'actions-pure.js'), F.source.pure, '实现'],
  [join(F.ui, 'slash-template.js'), F.source.slash, '「/」模板'],
  [join(F.ui, 'share-config.js'), F.source.share, '分享限额'],
];
const drifted = copies.filter(([to, from]) => {
  if (!existsSync(to)) return true;
  return readFileSync(to, 'utf8') !== readFileSync(from, 'utf8');
});
// ⚠️ 夹具模式下（`ui` 指到别处）源与拷贝可能本来就是同一份，这时只比「有没有」
if (drifted.length && resolve(F.ui) !== DEFAULTS.ui) {
  warn(`判据 4：跳过（跑的是夹具，ui 目录不是仓库里那份）`);
} else if (drifted.length) {
  bad(`判据 4：桌面那份拷贝与源不一致（${drifted.map(([to]) => to.split('/').pop()).join('、')}）—— 跑 node tools/sync-action-catalog.mjs`);
} else {
  ok('判据 4：桌面那份 catalog.json / pure.js / slash-template.js / share-config.js 与源逐字节一致');
}

// ── 判据 5：文案键覆盖，且两种语种都有 ─────────────────────────────────────
const wanted = new Set();
for (const g of catalog.groups ?? []) if (g.labelKey) wanted.add(g.labelKey);
for (const action of actions) {
  if (action.nameKey) wanted.add(action.nameKey);
  for (const param of action.params ?? []) {
    if (param.labelKey) wanted.add(param.labelKey);
    for (const option of param.options ?? []) if (option.labelKey) wanted.add(option.labelKey);
  }
}
// 动作的输出文案（`tr('inspectChars')`）也要译文 —— 少了的症状是标签位置显示键名
for (const m of pureText.matchAll(/\b(?:tr|translator\(ctx\))\(['"]([\w.]+)['"]\)/g)) wanted.add(m[1]);
// 「/」菜单那几颗胶囊的文案。⚠️ 抽法与 `sync-action-catalog.mjs` 里那一条**逐字相同**
//（两处各写一份正则 = 抽出来的键会漂，漂出来的症状是「同步过去了但没译文」）。
for (const m of slashText.matchAll(/^\s*\{\s*key:\s*['"]([\w.]+)['"]/gm)) wanted.add(m[1]);

if (!existsSync(F.labels)) {
  bad(`判据 5：找不到 ${F.labels}（跑 node tools/sync-action-catalog.mjs）`);
} else {
  const labels = JSON.parse(readFileSync(F.labels, 'utf8'));
  const gaps = [];
  for (const key of wanted) {
    for (const lang of ['zh', 'en']) {
      if (!labels[lang]?.[key]) gaps.push(`${lang}:${key}`);
    }
  }
  const extra = Object.keys(labels.zh ?? {}).filter((k) => !wanted.has(k));
  if (gaps.length) {
    bad(`判据 5：${gaps.length} 个键缺译文（界面会显示键名本身）：`);
    for (const one of gaps.slice(0, 8)) plain(one);
  } else {
    ok(`判据 5：${wanted.size} 个文案键在 zh / en 都有译文${extra.length ? `（另有 ${extra.length} 个没被引用，无害）` : ''}`);
  }
}

// ── 判据 6：桌面真的用上了它 ───────────────────────────────────────────────
const html = readFileSync(join(F.ui, 'index.html'), 'utf8');
const app = readFileSync(join(F.ui, 'app.js'), 'utf8');
const wiring = [];
if (!/src="\.\/action-library\.js"/.test(html)) wiring.push('index.html 没有加载 action-library.js');
if (!app.includes('ActionLibrary')) wiring.push('app.js 里没有出现 ActionLibrary');
if (!app.includes('actions-catalog')) wiring.push('app.js 里没有提过 actions-catalog（那它从哪知道有哪些动作？）');
// ⚠️ 动作菜单那段：改成「不再打开菜单」很容易，而症状只是「⚡ 点了没反应」。钉住两个函数名。
for (const fn of ['openActionMenu', 'runAction']) {
  if (!new RegExp(`function ${fn}\\b`).test(app)) wiring.push(`app.js 里没有 ${fn}`);
}
if (resolve(F.ui) !== DEFAULTS.ui) {
  warn('判据 6：跳过（跑的是夹具）');
} else if (wiring.length) {
  bad(`判据 6：桌面侧没接上（${wiring.length} 处）：`);
  for (const one of wiring) plain(one);
} else {
  ok('判据 6：桌面侧加载并用上了 actions-catalog（action-library.js + openActionMenu/runAction）');
}

// ── 判据 7：两件事都接进了门禁 ─────────────────────────────────────────────
if (resolve(F.ui) !== DEFAULTS.ui) {
  warn('判据 7：跳过（跑的是夹具）');
} else {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const release = readFileSync(join(ROOT, 'tools/release.sh'), 'utf8');
  const gaps = [];
  if (!ci.includes('sync-action-catalog.mjs --check')) gaps.push('CI 的 frontend job 里没有 sync-action-catalog.mjs --check');
  if (!ci.includes('action-catalog-smoke.mjs')) gaps.push('CI 里没有跑本判据');
  if (!release.includes('action-catalog-smoke')) gaps.push("release.sh 的 GATES 里没有本判据");
  if (gaps.length) {
    bad(`判据 7：没接进门禁（${gaps.length} 处）—— 没接进门禁的自检等于没有：`);
    for (const one of gaps) plain(one);
  } else {
    ok('判据 7：同步与判据都接进了 CI 与 release.sh 的 GATES');
  }
}

// ── 判据 8（只提示）：实现有没有被抄第二份 ─────────────────────────────────
const implNames = [...exportNames(pureText)].filter((n) => n.length > 6);
const copied = implNames.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(app));
if (copied.length) {
  warn(`判据 8（只提示）：ui/app.js 里出现了 ${copied.length} 个纯实现的名字（${copied.slice(0, 4).join(', ')}…）—— 如果那是抄了一份实现，请删掉它、改用 ActionLibrary`);
} else {
  ok('判据 8：ui/app.js 里没有出现纯实现的名字（没有第二份实现）');
}

// ── 判据 9：实现包（actions-impl）与桌面端的约定 ─────────────────────────────
//
// ⚠️★ 2026-10-03 加。markdown / 代码高亮 / 查找替换 / 拼音从「置灰」变成能跑：
//    实现由 esbuild 打进 `ui/actions-impl.js`，导出名清单写在 `ui/actions-impl.json`，
//    桌面端**按清单**决定哪条动作「点了才加载」。
//    这条判据在**不打包**的前提下（CI 没有 node_modules 也要能跑）核对三件事：
//   ① 清单与 `desktop.js` 的再导出逐个对上 —— 桌面按错的清单放行，症状是
//      「点了报『实现包里没有 X』」或「永远置灰」，都不报错；
//   ② 声明 `render: 'html'` 的动作，实现必须过 `renderMarkdownHtml`（DOMPurify）——
//      桌面按 innerHTML 画，消毒**只此一道**（构建时同步工具也断言 dompurify 在包里，
//      这里断言的是「每个 html 动作走的都是那条路」）；
//   ③ `highlight.css` 与源逐字节一致，且暗色选择器**同时认**两种主题挂法
//      （网页 `.v-theme--dark` / 桌面 `[data-theme='dark']`）—— 一份文件两处用的前提。
{
  const listPath = join(F.ui, 'actions-impl.json');
  const entryPath = join(F.ui, 'actions-impl.js');
  const desktopEntry = join(ROOT, 'web/src/lib/actions/desktop.js');

  if (!existsSync(listPath) || !existsSync(entryPath)) {
    bad('判据 9：ui/ 里没有实现包（actions-impl.json / actions-impl.js）—— 跑 node tools/sync-action-catalog.mjs');
  } else if (!existsSync(desktopEntry)) {
    bad(`判据 9：找不到实现包入口 ${desktopEntry}`);
  } else {
    const listed = JSON.parse(readFileSync(listPath, 'utf8')).exports ?? [];
    const declared = [...exportNames(readFileSync(desktopEntry, 'utf8'))].sort();
    const missing = declared.filter((n) => !listed.includes(n));
    const extra = listed.filter((n) => !declared.includes(n));
    if (missing.length || extra.length) {
      bad(`判据 9：导出清单与 desktop.js 对不上（缺 ${missing.join(', ') || '—'}；多 ${extra.join(', ') || '—'}）`);
      plain('  ⚠️ 桌面端按清单决定「点了才加载」：清单里没有的永远置灰，清单里多的是放行一个跑不了的。');
      plain('  ⚠️ 清单是从构建产物的 metafile 抽的 —— 改了 desktop.js 就要重新同步。');
    } else {
      ok(`判据 9a：实现包清单与 desktop.js 一致（${listed.length} 个导出）`);
    }

    // ② html 动作必须走消毒那一条路。
    const implSource = readFileSync(join(ROOT, 'web/src/lib/actions/impl.js'), 'utf8');
    const htmlActions = actions.filter((a) => a.render === 'html');
    const offRoad = htmlActions.filter((a) => {
      const body = new RegExp(`export (?:async )?function ${a.run}\\([\\s\\S]*?\\n\\}`).exec(implSource)?.[0] ?? '';
      return !body || !/renderMarkdownHtml|renderFenced/.test(body);
    });
    if (!htmlActions.length) {
      warn('判据 9b：目录里没有 render: html 的动作（这条自检暂时没东西可盯）');
    } else if (offRoad.length) {
      bad(`判据 9b：${offRoad.map((a) => a.id).join('、')} 声明了 render: html，但实现没走 renderMarkdownHtml（DOMPurify）`);
      plain('  ⚠️ 桌面端按 innerHTML 画 html 动作的结果，消毒只在实现包里那一条路上。');
    } else {
      ok(`判据 9b：${htmlActions.length} 条 html 动作的实现都走 renderMarkdownHtml（DOMPurify）`);
    }

    // ③ highlight.css：逐字节一致 + 暗色选择器认两种挂法。
    //    ⚠️ 夹具模式下**照比**：源永远是真的，拷贝与源不一致就该红 ——
    //    写成「夹具跳过」的话，变异验证里「手改 highlight.css」的三组会假绿
    //    （2026-10-03 实测：三组全红，红的却全是这一条误报）。
    const cssTo = join(F.ui, 'highlight.css');
    const cssFrom = join(ROOT, 'web/src/styles/highlight.css');
    if (!existsSync(cssTo)) {
      bad('判据 9c：ui/ 里没有 highlight.css —— 代码块的令牌配色全丢');
    } else if (readFileSync(cssTo, 'utf8') !== readFileSync(cssFrom, 'utf8')) {
      bad('判据 9c：highlight.css 与源不一致（手改过？）—— 跑 node tools/sync-action-catalog.mjs');
    } else if (!/\[data-theme='dark'\]/.test(readFileSync(cssTo, 'utf8'))) {
      bad("判据 9c：highlight.css 的暗色选择器不认 `[data-theme='dark']` —— 桌面深色下代码块还是浅色配色");
    } else {
      ok('判据 9c：highlight.css 与源逐字节一致，且暗色选择器两种主题挂法都认');
    }

    // ④ 桌面端真的按清单放行（`resolveFn` 里查的是清单）。
    const libSource = existsSync(join(F.ui, 'action-library.js'))
      ? readFileSync(join(F.ui, 'action-library.js'), 'utf8') : '';
    if (!libSource.includes('implNames')) {
      bad('判据 9d：action-library.js 没有按清单（implNames）放行 —— 它要么全置灰、要么全放行');
    } else {
      ok('判据 9d：桌面端按实现包清单放行动作');
    }
  }
}

console.log();
if (failed) {
  console.log(`✗ 动作库自检失败：${failed} 条`);
  process.exit(1);
}
console.log('✓ 动作库自检通过');
