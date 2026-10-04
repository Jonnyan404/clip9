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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const REPO = resolve(WEB, '..');
const LEGACY = join(REPO, 'web-vue3');

const problems = [];
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// ── A. 零 import 共享模块：与 web-vue3 逐字节一致 ─────────────────────────
// ⚠️ 这些文件由 tools/sync-action-catalog.mjs 逐字节拷到 rust/crates/desktop/ui/，
// 桌面端没有构建步骤 —— 一旦引入 `@/` 别名或第三方 import，那边运行时加载失败
// （症状是「点分享没反应」，不是报错）。
const SHARED = [
    ['src/lib/actions/pure.js', 'src/data/actions/pure.js'],
    ['src/lib/actions/catalog.json', 'src/data/actions/catalog.json'],
    ['src/lib/share-config.js', 'src/share-config.js'],
    ['src/lib/slash-template.js', 'src/slash-template.js'],
    ['src/lib/replace-modes.json', 'src/data/replace-modes.json'],
];

for (const [mine, theirs] of SHARED) {
    const minePath = join(WEB, mine);
    const theirsPath = join(LEGACY, theirs);
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
    if (existsSync(theirsPath) && sha(minePath) !== sha(theirsPath)) {
        problems.push(`${mine} 与 web-vue3/${theirs} 不再逐字节一致（桌面端同步会失败）`);
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

// ── D. PWA 放行表：与 web-vue3 的条目集合一致 ─────────────────────────────
const extractDenylist = (source) => {
    const match = source.match(/navigateFallbackDenylist:\s*\[([\s\S]*?)\]/);
    if (!match) return null;
    return [...match[1].matchAll(/\/\^\\\/([a-z]+)/g)].map((m) => m[1]).sort();
};
const mineDenylist = extractDenylist(readFileSync(join(WEB, 'vite.config.ts'), 'utf8'));
const theirsDenylist = extractDenylist(readFileSync(join(LEGACY, 'vite.config.js'), 'utf8'));
if (!mineDenylist) {
    problems.push('vite.config.ts 里找不到 navigateFallbackDenylist');
} else if (theirsDenylist) {
    const missing = theirsDenylist.filter((entry) => !mineDenylist.includes(entry));
    const extra = mineDenylist.filter((entry) => !theirsDenylist.includes(entry));
    if (missing.length) problems.push(`PWA 放行表缺条目：${missing.join(', ')}`);
    if (extra.length) problems.push(`PWA 放行表多出条目（web-vue3 没有）：${extra.join(', ')}`);
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

// ── 结果 ────────────────────────────────────────────────────────────────
if (problems.length) {
    console.error(`✗ 契约守卫失败（${problems.length} 处）：`);
    for (const line of problems) console.error(`    ${line}`);
    process.exit(1);
}
console.log('✓ 契约守卫通过：零依赖共享模块字节一致 · 外壳形状完整 · PWA 放行表一致 · i18n 无死键 · 已删模式未复活');
