#!/usr/bin/env node
/**
 * 把 `wrangler.toml.template` 渲染成一份**具体部署**用的 `wrangler.toml`。
 *
 *   node cloudflare/render-wrangler.mjs --out cloudflare/workers/wrangler.toml \
 *     --worker-name clip9-demo --db-name clip9-db-demo --db-id <uuid> \
 *     --bucket-name clip9-files-demo --set FILE_LIMIT=3145728 --set AUTH_PASSWORD=
 *
 * 为什么要有它：模板里有四处名字是**写死**的（`name` / DO 的 `script_name` /
 * `database_name` / `bucket_name`），而 `database_id` 本来就是「渲染时才填」的。
 * 生产那条工作流（`.github/workflows/deploy-cloudflare.yml`）是内联 python 干这件事的；
 * 演示站（`deploy-cloudflare-demo.yml`）用这个脚本 —— 于是「模板怎么变成配置」
 * 这条逻辑**有一份可读、可本地跑、可单独验的写法**，而不是又抄一段 heredoc。
 *
 * ⚠️★ 所有替换都是**锚在行首**的：模板里的注释也在解释 `name = …` 这些键，
 * 用全局 replace 会把注释也改掉（那看起来像正常文件，但下一次改注释的人会以为
 * 自己写错了）。找不到某一行时**报错退出**，不静默跳过 —— 少换一个 `script_name`
 * 会让 Durable Object 绑到另一个 Worker 上，而部署**照样成功**。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = join(HERE, 'workers/wrangler.toml.template');

const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const allOf = (name) => {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    }
    return out;
};

const template = argOf('template', DEFAULT_TEMPLATE);
const out = argOf('out');
if (!out) {
    console.error('✗ 缺 --out（渲染到哪）');
    process.exit(2);
}
if (!existsSync(template)) {
    console.error(`✗ 模板不存在：${template}`);
    process.exit(2);
}

let toml = readFileSync(template, 'utf8');
const problems = [];

/** 把 `^key = "…"` 这一行换成新值。⚠️ 锚行首 —— 注释里也在讲这些键。 */
function replaceLine(key, value, label) {
    if (value === '') return; // 没给就保持模板原值
    const pattern = new RegExp(`^([ \\t]*)${key}[ \\t]*=[ \\t]*"([^"]*)"`, 'm');
    if (!pattern.test(toml)) {
        problems.push(`模板里找不到 \`${key} = "…"\` 这一行（想换的是 ${label}）`);
        return;
    }
    toml = toml.replace(pattern, (_m, indent) => `${indent}${key} = ${JSON.stringify(value)}`);
}

const workerName = argOf('worker-name');
const dbName = argOf('db-name');
const dbId = argOf('db-id');
const bucketName = argOf('bucket-name');

/**
 * 换**顶层**的 `name`。
 *
 * ⚠️★ 不能直接 `replaceLine('name', …)`：`[[durable_objects.bindings]]` 里也有一个
 * `name = "WEBSOCKET_ROOM"`（那是绑定的名字，不是 Worker 的名字）。`String.replace`
 * 不带 `g` 时只换第一个 —— 现在文件顺序是对的，但那是**位置巧合**：哪天有人把顶层
 * `name` 挪到某个表后面，这条就会静默地把 DO 绑定名改掉，而部署照样成功
 * （表现是「房间连上就断」）。
 * 所以这里只在前**第一个 `[` 开头的小节之前**找。
 */
function replaceTopLevelName(value) {
    if (!value) return;
    const firstSection = toml.search(/^\[/m);
    const head = firstSection < 0 ? toml : toml.slice(0, firstSection);
    const tail = firstSection < 0 ? '' : toml.slice(firstSection);
    const pattern = /^([ \t]*)name[ \t]*=[ \t]*"([^"]*)"/m;
    if (!pattern.test(head)) {
        problems.push('模板里找不到顶层的 `name = "…"`（Worker 名）');
        return;
    }
    toml = head.replace(pattern, (_m, indent) => `${indent}name = ${JSON.stringify(value)}`) + tail;
}

replaceTopLevelName(workerName);
// ⚠️ DO 的 `script_name` 必须与 Worker 名**逐字相同**：不同的话 DO 绑到另一个脚本上，
//    部署不报错，而 WebSocket 房间会落到一个不存在的对象里（表现是「连上就断」）。
replaceLine('script_name', workerName, 'Durable Object 绑定的脚本名');
replaceLine('database_name', dbName, 'D1 库名');
replaceLine('database_id', dbId, 'D1 的 id');
replaceLine('bucket_name', bucketName, 'R2 桶名');

// `[vars]` 里的值：与生产那条工作流同一套转义（值里可能有引号/反斜杠，ROOM_AUTH_JSON 就是）。
const assigned = [];
for (const pair of allOf('set')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
        problems.push(`--set 要写成 KEY=VALUE（收到 ${JSON.stringify(pair)}）`);
        continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    // ⚠️ 值里可能有引号/反斜杠（`ROOM_AUTH_JSON` 就是一段带转义的 JSON），所以按
    //    「带转义的字符串」整段匹配，再用 JSON.stringify 生成新的 —— 手拼 `"${value}"`
    //    会得到一个坏 TOML。`String.raw` 是为了让正则里那几层反斜杠看得懂。
    const pattern = new RegExp(String.raw`(${key}[ \t]*=[ \t]*)"(?:\\.|[^"\\])*"`);
    if (!pattern.test(toml)) {
        problems.push(`模板的 [vars] 里没有 ${key} —— 这个值没写进去`);
        continue;
    }
    toml = toml.replace(pattern, (_match, prefix) => prefix + JSON.stringify(value));
    assigned.push(key);
}

if (problems.length) {
    console.error('✗ 渲染失败：');
    for (const p of problems) console.error(`    ${p}`);
    process.exit(1);
}

// ⚠️ 占位串留在里面 = 部署时 wrangler 报「database_id 不是合法 UUID」，而那句话
//    不告诉你要去哪拿 id。这里提前说清楚。
if (/^[ \t]*database_id[ \t]*=[ \t]*"your-d1-database-id"/m.test(toml)) {
    console.error('✗ database_id 还是占位串 —— 先 `wrangler d1 list` 拿到真的 id 再传 --db-id');
    process.exit(1);
}

writeFileSync(out, toml);

const readBack = (key) => {
    const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(?:"([^"]*)"|([^\\s#]+))`, 'm').exec(toml);
    return m ? (m[1] ?? m[2]) : '(缺)';
};
console.log('✓ 已渲染 wrangler.toml');
console.log(`    Worker   ${readBack('name')}`);
console.log(`    DO       ${readBack('script_name')}（必须与 Worker 名一致）`);
console.log(`    D1       ${readBack('database_name')} / ${readBack('database_id')}`);
console.log(`    R2       ${readBack('bucket_name')}`);
console.log(`    变量     ${assigned.length ? assigned.join(', ') : '（沿用模板值）'}`);
