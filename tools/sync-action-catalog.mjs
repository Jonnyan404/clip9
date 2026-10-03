#!/usr/bin/env node
// 把「动作目录 + 纯实现 + 用到的文案」同步进桌面端的界面目录（`rust/crates/desktop/ui/`）。
//
// 用法：
//   node tools/sync-action-catalog.mjs            # 同步
//   node tools/sync-action-catalog.mjs --check    # 只比对不写；不一致退出 1
//
// ⚠️★ 为什么要有它：桌面那个手写界面是一个**没有构建步骤**的普通页面，而
// `web-vue3/src/data/actions.js` 是按模块拆的、还带着 `@/` 别名与第三方库
//（marked / highlight.js / opencc / pinyin）。所以「一份实现、两侧共用」在这个仓库里的
// **现实形式**只能是：源在 `web-vue3/` 下，由这个脚本把**能自足加载的那两个文件**
// 原样搬过去，再用 `--check` 保证搬运没漏。
//
// 搬的四样：
//   `actions/catalog.json` → `ui/actions-catalog.json`（**逐字节**）
//   `actions/pure.js`      → `ui/actions-pure.js`（**逐字节**；它的铁律是零 import）
//   `slash-template.js`    → `ui/slash-template.js`（**逐字节**；同样是零 import —— 见下）
//   `locales/{zh,en}.json` → `ui/actions-labels.json`（**只抽目录与实现真正用到的键**）
//
// ⚠️ 第三样是抽出来的、不是全量拷：桌面只有两种语种（SPA 有四种），而且动作的显示名
// 本就是「数据」——抄一遍就会漂。抽哪些键是**算出来的**：
//   · 目录里的每个 `nameKey` / `groups[].labelKey` / `params[].labelKey` / 选项的 labelKey
//   · `pure.js` 里出现的 `tr('…')`（那几个动作的**输出文案**要 i18n，见 translator）
//   · `slash-template.js` 里每一项的 `key: '…'`（`/` 菜单那几颗胶囊的文案）
//
// ⚠️ 忘了同步是**无症状**的：桌面照样跑，只是动作名是上一版的、或者新动作没有译文
//（`t()` 查不到会**回落成键名本身**，界面上就是一串 `actionFoo`）。
// 所以这个脚本与 `sync-web-assets.mjs` 一样，比的是**源文件的指纹**，`--check` 进 CI。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'web-vue3/src/data/actions');
const LOCALES = join(ROOT, 'web-vue3/src/locales');
const DEST = join(ROOT, 'rust/crates/desktop/ui');
const MANIFEST = join(DEST, 'actions.sync.json');

/** 桌面端支持的语种 —— 与 `ui/i18n.js` 的 DICTS 对齐（SPA 另有 ja / zh-TW）。 */
const LANGS = ['zh', 'en'];

// ⚠️ `slash-template.js` 住在 `src/` 下（不在 `data/actions/` 里）—— 它是「输入框的
// `/` 菜单」，不是动作库的一部分，只是**恰好**也被两侧共用。
const SLASH_SOURCE = join(ROOT, 'web-vue3/src/slash-template.js');

const COPY = [
  { from: join(SRC, 'catalog.json'), to: join(DEST, 'actions-catalog.json') },
  { from: join(SRC, 'pure.js'), to: join(DEST, 'actions-pure.js') },
  { from: SLASH_SOURCE, to: join(DEST, 'slash-template.js') },
];

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const read = (p) => readFileSync(p, 'utf8');

/** 三份源里真正引用到的 i18n 键（顺序稳定，便于 diff）。 */
function wantedKeys(catalog, sources) {
  const keys = new Set();
  const add = (k) => { if (typeof k === 'string' && k) keys.add(k); };
  for (const g of catalog.groups ?? []) add(g.labelKey);
  for (const a of catalog.actions ?? []) {
    add(a.nameKey);
    for (const p of a.params ?? []) {
      add(p.labelKey);
      for (const o of p.options ?? []) add(o.labelKey);
    }
  }
  // 实现的输出文案：`tr('inspectChars')` / `translator(ctx)('actionNothingToConvert')`
  for (const name of ['pure', 'impl']) {
    for (const m of sources[name].matchAll(/\b(?:tr|translator\(ctx\))\(['"]([\w.]+)['"]\)/g)) add(m[1]);
  }
  // `/` 菜单那几颗胶囊：`{ key: 'filterTaskList', icon: …, text: … }`
  for (const m of sources.slash.matchAll(/^\s*\{\s*key:\s*['"]([\w.]+)['"]/gm)) add(m[1]);
  return [...keys].sort();
}

function build() {
  const catalogText = read(COPY[0].from);
  const pureText = read(COPY[1].from);
  const slashText = read(COPY[2].from);
  // ⚠️ `impl.js` 只用来**抽键**（它 import 第三方库，搬不过去）—— 但那几个报错文案
  // （`actionReplaceBadMode` / `actionNothingToConvert` …）桌面端跑起来时要用到。
  const implText = read(join(SRC, 'impl.js'));
  const catalog = JSON.parse(catalogText);

  // ⚠️ 零 import 是**两份文件**的铁律（`pure.js` 与 `slash-template.js`）：
  // 桌面那个页面加载不了带 `@/` 别名或 JSON import 的模块。
  for (const [name, text] of [['pure.js', pureText], ['slash-template.js', slashText]]) {
    if (/^\s*(import|export\s+\{[^}]*\}\s+from)\s/m.test(text.replace(/^\/\/.*$/gm, ''))) {
      const bad = text.split('\n').findIndex((l) => /^\s*import\s/.test(l)) + 1;
      throw new Error(
        `${name} 里出现了 import（第 ${bad} 行）—— 那个文件的铁律是零 import，\n`
        + '桌面端加载不了带裸定名（@/…）或 JSON import 的模块。\n'
        + '（`slash-template.js` 里「怎么跑一条动作」要**当参数传进来**，不是 import 进来。）',
      );
    }
  }

  const keys = wantedKeys(catalog, { pure: pureText, impl: implText, slash: slashText });
  const labels = {};
  const missing = [];
  for (const lang of LANGS) {
    const dict = JSON.parse(read(join(LOCALES, `${lang}.json`)));
    labels[lang] = {};
    for (const k of keys) {
      if (k in dict) labels[lang][k] = dict[k];
      else missing.push(`${lang}:${k}`);
    }
  }
  if (missing.length) {
    // 缺译文不是小事：桌面侧会**显示键名本身**，看起来像界面坏了。
    throw new Error(`这些键在 locale 里找不到：\n  ${missing.join('\n  ')}\n`
      + '（多半是 catalog.json 里写了 nameKey、语言文件里没跟着加）');
  }

  const labelsText = `${JSON.stringify({
    _comment: [
      '动作库里**文案**的那一份 —— 由 tools/sync-action-catalog.mjs 从',
      'web-vue3/src/locales/{zh,en}.json 抽出（只取目录与实现真正引用的键）。',
      '⚠️ 手工改这个文件没用：下一次 --check/同步会覆盖它。要改文案去 SPA 的 locale 文件。',
    ],
    ...labels,
  }, null, 2)}\n`;

  // 指纹只记**源**：产物随源变，比源就够了（同 sync-web-assets 的理由）
  const fingerprint = sha([catalogText, pureText, slashText, implText,
    ...LANGS.map((l) => read(join(LOCALES, `${l}.json`)))].join('\0'));
  const manifestText = `${JSON.stringify({
    _comment: '由 tools/sync-action-catalog.mjs 生成。--check 用 source 指纹比对。',
    source: fingerprint,
    files: {
      'actions-catalog.json': sha(catalogText),
      'actions-pure.js': sha(pureText),
      'slash-template.js': sha(slashText),
      'actions-labels.json': sha(labelsText),
    },
  }, null, 2)}\n`;

  return { fingerprint, labelsText, manifestText, keys, catalogText, pureText, slashText };
}

const { fingerprint, labelsText, manifestText, keys, catalogText, pureText, slashText } = build();
const staged = [
  { to: COPY[0].to, text: catalogText },
  { to: COPY[1].to, text: pureText },
  { to: COPY[2].to, text: slashText },
  { to: join(DEST, 'actions-labels.json'), text: labelsText },
];

const check = process.argv.includes('--check');

if (check) {
  const problems = [];
  for (const { to, text } of staged) {
    if (!existsSync(to)) problems.push(`${to} 不存在`);
    else if (read(to) !== text) problems.push(`${to} 与源不一致`);
  }
  if (!existsSync(MANIFEST)) problems.push(`${MANIFEST} 不存在`);
  else if (JSON.parse(read(MANIFEST)).source !== fingerprint) {
    problems.push(`${MANIFEST} 的源指纹对不上（源文件动过）`);
  }
  if (problems.length) {
    console.error(`✗ 桌面端的动作目录没同步（${problems.length} 处）：`);
    for (const p of problems) console.error(`    ${p}`);
    console.error('\n  跑一下：node tools/sync-action-catalog.mjs');
    process.exit(1);
  }
  console.log(`✓ 动作目录已同步（${keys.length} 个文案键 × ${LANGS.length} 语种，指纹 ${fingerprint}）`);
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });
const backups = [];
for (const { to, text } of staged) {
  if (existsSync(to) && read(to) === text) continue;
  if (existsSync(to)) {
    // ⚠️ 旧文件**挪**进临时目录而不是删：这样「哪些文件变了」看得见（同 sync-web-assets）。
    const keep = join(tmpdir(), `clip9-actions-old-${Date.now()}-${to.split('/').pop()}`);
    renameSync(to, keep);
    backups.push(keep);
  }
  writeFileSync(to, text);
}
writeFileSync(MANIFEST, manifestText);

console.log(`✓ 已同步 ${staged.length} 个文件到 rust/crates/desktop/ui/`);
console.log(`  文案键 ${keys.length} 个 × ${LANGS.length} 语种；指纹 ${fingerprint}`);
if (backups.length) {
  console.log('  旧文件挪到了（要删自己删）：');
  for (const b of backups) console.log(`    ${b}`);
}
const extra = readdirSync(DEST).filter((f) => f.startsWith('actions-') && !staged.some((s) => s.to.endsWith(f)) && f !== 'actions.sync.json');
if (extra.length) console.log(`  ⚠️ 目录里还有别的 actions-* 文件（不是这个脚本管的）：${extra.join(', ')}`);
