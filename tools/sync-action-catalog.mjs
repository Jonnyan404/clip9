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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

// 「动作实现包」：`actions/desktop.js` 是**入口**，esbuild 把它连同 marked / highlight.js /
// pinyin-pro 打成自足的 ESM 交给桌面端（那一侧没有构建步骤，装不下这几样）。
// ⚠️ `--external:./opencc.js`：简繁那两条**不进桌面**（词典压完还有 2.2MB，2026-10-03 定）。
//    动态 import 不参与摇树，光靠「入口不 re-export」拦不住它 —— 必须显式排除，
//    排完还要核对（见 buildImplBundle 里的断言），不然哪天一改 import 写法它就悄悄回来了。
const DESKTOP_ENTRY = join(SRC, 'desktop.js');
const IMPL_OUT = { entry: 'actions-impl.js', list: 'actions-impl.json' };
const ESBUILD = join(ROOT, 'web-vue3/node_modules/.bin/esbuild');
const HIGHLIGHT_CSS = join(ROOT, 'web-vue3/src/styles/highlight.css');

const COPY = [
  { from: join(SRC, 'catalog.json'), to: join(DEST, 'actions-catalog.json') },
  { from: join(SRC, 'pure.js'), to: join(DEST, 'actions-pure.js') },
  { from: SLASH_SOURCE, to: join(DEST, 'slash-template.js') },
  // 代码高亮的令牌配色（桌面端 markdown / 代码高亮那两条动作要用）。⚠️ 与网页同一份。
  { from: HIGHLIGHT_CSS, to: join(DEST, 'highlight.css') },
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
  const cssText = read(COPY[3].from);
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
  // ⚠️ 实现包的入口也是「源」：它变了而包没重打，就是桌面端跑着旧实现。
  const fingerprint = sha([catalogText, pureText, slashText, implText, cssText, read(DESKTOP_ENTRY),
    ...LANGS.map((l) => read(join(LOCALES, `${l}.json`)))].join('\0'));

  return { fingerprint, labelsText, keys, catalogText, pureText, slashText, cssText };
}

/** 打「动作实现包」：esbuild 产出 `actions-impl.js` + 若干按内容哈希命名的 chunk。
 *
 * 返回 `{ files: Map<文件名, 文本>, exports: string[] }`。
 *
 * ⚠️★ 三条断言都别拆（它们拦的都是「不报错、但桌面上悄悄不对」）：
 *   · opencc 的输入一个都不许出现 —— `--external` 靠**字面量**匹配 import 写法，
 *     哪天有人把 `import('./opencc.js')` 改成别的拼法，排除就静默失效，词典悄悄回到包里；
 *   · 拼音必须是**单独的 chunk** —— 它 449KB，混进主包就是每次启动都白背一遍；
 *   · 产物要**可复现**（连打两次逐字节一致）—— 它们的哈希要写进 sync 清单，不可复现 = --check 没法比。
 */
function buildImplBundle() {
  const outdir = join(tmpdir(), `clip9-impl-out-${Date.now()}`);
  const metafile = join(tmpdir(), `clip9-impl-meta-${Date.now()}.json`);
  mkdirSync(outdir, { recursive: true });
  execFileSync(ESBUILD, [
    DESKTOP_ENTRY,
    '--bundle', '--minify', '--format=esm', '--splitting', '--target=es2020',
    `--alias:@=${join(ROOT, 'web-vue3/src')}`,
    '--external:./opencc.js',
    `--outdir=${outdir}`,
    `--entry-names=${IMPL_OUT.entry.replace('.js', '')}`,
    '--chunk-names=actions-impl-[hash]-chunk',
    `--metafile=${metafile}`,
  ], { stdio: 'pipe' });

  const meta = JSON.parse(read(metafile));
  const inputs = Object.keys(meta.inputs);
  const openccInputs = inputs.filter((p) => /opencc/i.test(p));
  if (openccInputs.length) {
    throw new Error(`实现包里混进了 opencc（${openccInputs.join(', ')}）——\n`
      + '简繁那两条 2026-10-03 定了不进桌面（词典 2.2MB）。'
      + "多半是 impl.js 里 `import('./opencc.js')` 的写法变了，--external 的字面量匹配不上。");
  }
  // ⚠️★ DOMPurify 必须在包里：`format.markdown` / `format.code` 的输出是 **HTML**，桌面端
  // 直接用 `innerHTML` 画它 —— 消毒发生在**包内**（`util.js` 的 `renderMarkdownHtml`），
  // 那一侧没有第二道。少了它，一条别人剪贴板里带 `<script>` 的内容就能在桌面上执行。
  if (!inputs.some((p) => /dompurify/i.test(p))) {
    throw new Error('实现包里没有 dompurify —— markdown / 代码高亮那两条返回的是 HTML，\n'
      + '桌面端按 innerHTML 画，消毒只能靠包内这一道（剪贴板是别人能往里塞字符串的通道）。');
  }
  const entryOutput = Object.entries(meta.outputs).find(([, v]) => v.entryPoint);
  if (!entryOutput) throw new Error('metafile 里找不到入口产物 —— esbuild 的输出形状变了，这条脚本要跟着改');
  const exports = [...(entryOutput[1].exports ?? [])].sort();

  const files = new Map();
  for (const name of readdirSync(outdir)) {
    if (name.endsWith('.js')) files.set(name, read(join(outdir, name)));
  }
  if (!files.has(IMPL_OUT.entry)) throw new Error(`esbuild 没产出 ${IMPL_OUT.entry}`);
  // 拼音（449KB）必须**单独成 chunk**：主包是每次启动都要 parse 的那份，
  // 混进去就是「不用拼音的人也白背一遍」（判定靠导出名，minify 不会改导出的名字）。
  const pinyinChunks = [...files.entries()].filter(([name, text]) => name !== IMPL_OUT.entry && text.includes('toWordGroups'));
  if (pinyinChunks.length !== 1) {
    throw new Error(`拼音的实现没有单独成 chunk（命中 ${pinyinChunks.map(([n]) => n).join(', ') || '无'}）—— 主包会被它撑大 449KB`);
  }
  return { files, exports };
}

const built = build();
const staged = [
  { to: COPY[0].to, text: built.catalogText },
  { to: COPY[1].to, text: built.pureText },
  { to: COPY[2].to, text: built.slashText },
  { to: COPY[3].to, text: built.cssText },
  { to: join(DEST, 'actions-labels.json'), text: built.labelsText },
];

const check = process.argv.includes('--check');

// 实现包只在**同步**时打包（--check 不碰 esbuild —— CI 那边没有 node_modules 也要能跑）。
// ⚠️ 产物清单写进 sync 清单：--check 拿它逐个对 sha，拦住「有人手改了产物」与「重打了一半」。
const impl = check ? null : buildImplBundle();

const implListText = impl
  ? `${JSON.stringify({
      _comment: [
        '桌面端「动作实现包」的导出名 —— 由 tools/sync-action-catalog.mjs 从构建产物的',
        'metafile 抽出（源头是 web-vue3/src/data/actions/desktop.js 的再导出清单）。',
        '桌面端按它决定哪条动作的实现要**点了才加载**（actions-impl.js）；',
        '不在这个名单里的（简繁那两条）在动作菜单里照旧置灰。',
      ],
      exports: impl.exports,
    }, null, 2)}\n`
  : null;

const manifestFiles = {};
for (const { to, text } of staged) manifestFiles[to.split('/').pop()] = sha(text);
if (impl) {
  for (const [name, text] of impl.files) manifestFiles[name] = sha(text);
  manifestFiles[IMPL_OUT.list] = sha(implListText);
}
const manifestText = `${JSON.stringify({
  _comment: '由 tools/sync-action-catalog.mjs 生成。--check 用 source 指纹 + files 里的 sha 比对。',
  source: built.fingerprint,
  files: manifestFiles,
}, null, 2)}\n`;

if (check) {
  const problems = [];
  for (const { to, text } of staged) {
    if (!existsSync(to)) problems.push(`${to} 不存在`);
    else if (read(to) !== text) problems.push(`${to} 与源不一致`);
  }
  if (!existsSync(MANIFEST)) problems.push(`${MANIFEST} 不存在`);
  else {
    const manifest = JSON.parse(read(MANIFEST));
    if (manifest.source !== built.fingerprint) {
      problems.push(`${MANIFEST} 的源指纹对不上（源文件动过，含实现包入口）`);
    }
    for (const [name, want] of Object.entries(manifest.files ?? {})) {
      const p = join(DEST, name);
      if (!existsSync(p)) problems.push(`${name} 在清单里，但文件不存在`);
      else if (sha(read(p)) !== want) problems.push(`${name} 与清单里的 sha 不一致（手改过 / 重打了一半）`);
    }
  }
  if (problems.length) {
    console.error(`✗ 桌面端的动作目录没同步（${problems.length} 处）：`);
    for (const p of problems) console.error(`    ${p}`);
    console.error('\n  跑一下：node tools/sync-action-catalog.mjs');
    process.exit(1);
  }
  console.log(`✓ 动作目录已同步（${built.keys.length} 个文案键 × ${LANGS.length} 语种，指纹 ${built.fingerprint}）`);
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
// ⚠️★ 上一轮的 chunk 要**挪走**：文件名带内容哈希，重打一次就换一批名字，
// 留着旧的那几个 = 仓库里白攒 450KB 的死文件（而且 `.gitignore` 认不出它们）。
// 挪而不是删（与上面旧文件的处理同一条规矩）：删错就没了，挪走还能捞回来。
const orphanChunks = readdirSync(DEST)
  .filter((f) => /^actions-impl-.+-chunk\.js$/.test(f) && !impl.files.has(f));
for (const name of orphanChunks) {
  renameSync(join(DEST, name), join(tmpdir(), `clip9-impl-orphan-${Date.now()}-${name}`));
}
for (const [name, text] of impl.files) {
  writeFileSync(join(DEST, name), text);
}
writeFileSync(join(DEST, IMPL_OUT.list), implListText);
writeFileSync(MANIFEST, manifestText);

console.log(`✓ 已同步 ${staged.length} 个文件 + 实现包（${impl.files.size} 个 js，导出 ${impl.exports.length} 条）到 rust/crates/desktop/ui/`);
console.log(`  文案键 ${built.keys.length} 个 × ${LANGS.length} 语种；指纹 ${built.fingerprint}`);
if (orphanChunks.length) {
  console.log(`  上一轮的 ${orphanChunks.length} 个旧 chunk 挪到了 /tmp（${orphanChunks.join(', ')}）`);
}
if (backups.length) {
  console.log('  旧文件挪到了（要删自己删）：');
  for (const b of backups) console.log(`    ${b}`);
}
const extra = readdirSync(DEST).filter((f) => f.startsWith('actions-') && !staged.some((s) => s.to.endsWith(f)) && f !== 'actions.sync.json' && !impl.files.has(f) && f !== IMPL_OUT.list);
if (extra.length) console.log(`  ⚠️ 目录里还有别的 actions-* 文件（不是这个脚本管的）：${extra.join(', ')}`);
