#!/usr/bin/env node
/*
  把「这个 Worker 现在到底开没开 *.workers.dev」写回 wrangler 配置。

  # ⚠️★ 为什么需要这一步

  这个开关的**主人是操作者**（CF 控制台 → 该 Worker → Settings → Domains & Routes
  里那颗 Disable / Enable），不是仓库里那份配置。
  但 wrangler **没有**「别管这个键」这一说：**配置里不写 = 用默认值**，而默认是 `true`
  （官方文档：`workers_dev` … *Defaults to `true`*）——
  于是「在控制台关掉」会被**下一次部署原样打开**。2026-09-30 就是这么被报上来的。

  `workers_dev = false` 只能表达「关」；要表达「**别表态**」，只能部署前先读一眼现在是什么、
  再照原样写回去：

    · Worker 已经存在 → 写它现在那个值（**部署从此不再对这个键表态**）；
    · 首次部署（还查不到这个脚本）→ 写 `true`，于是新部署者拿到一个能访问的地址。

  # 用法

    node sync-workers-dev.mjs wrangler.toml
      # 读 CLOUDFLARE_API_TOKEN / CF_API_TOKEN、CLOUDFLARE_ACCOUNT_ID / CF_ACCOUNT_ID、
      # WORKER_NAME（默认从配置里的 name = "…" 读）

    node sync-workers-dev.mjs wrangler.toml --assume enabled|disabled|missing
      # 不联网：当成「现在就是这个状态」。给测试与调试用（也是唯一能在 CI 外验证的路径）。

  # ⚠️ 读不到就**让它红**

  这一步读失败时**不静默继续**：继续下去等于把 `true` 又写一遍（也就是回到那个 bug），
  而「部署成功了、域名却被悄悄打开」比红一次难查得多 —— 与这个仓库里
  「宁可少一张预览卡，也不要吐一份半截 HTML」是同一条取舍。
  唯一算「成功」的例外是 **HTTP 404**：那表示这个 Worker 还没建过 = 首次部署。
*/

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 给定「读到的当前状态」，决定要写进配置的两个值。
 *
 * `current` 为 `null` = 那个 Worker 还不存在（首次部署）。
 *
 * ⚠️ `preview_urls` 一起写：它的默认值是 `workers_dev` 的值 —— 只写前者的话，
 * 「关掉 workers.dev 但显式开着 Preview URLs」那种搭配会被我们顺手关掉，
 * 那还是**部署替操作者表了态**，只是换了个方向。
 */
export function decideSubdomain(current) {
    if (!current) return { workers_dev: true, preview_urls: true };
    return {
        workers_dev: current.enabled === true,
        preview_urls: current.previews_enabled === true,
    };
}

/**
 * 把两个值写进 toml 原文（只动那两行的 `true`/`false`）。
 *
 * ⚠️★ 键**必须已经写在模板里**：不在的话这里直接报错，不「顺手加一行」。
 * 加一行等于把「这个键归谁管」这件事藏进代码里，而配置里看得见的那一行
 * 正是下一个读模板的人唯一能发现它的地方。
 */
export function writeSubdomainLines(toml, values) {
    let out = toml;
    const missing = [];
    for (const [key, on] of Object.entries(values)) {
        const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)(true|false)\\s*$`, 'm');
        if (!pattern.test(out)) {
            missing.push(key);
            continue;
        }
        out = out.replace(pattern, `$1${on}`);
    }
    return { toml: out, missing };
}

/** 从配置原文里读 `name = "…"`（脚本名 = Worker 名）。 */
export function workerNameOf(toml) {
    const match = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
}

/** 读这个 Worker 当前的 subdomain 开关。`null` = 还没有这个 Worker（首次部署）。 */
async function readSubdomain({ accountId, token, workerName }) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    // ⚠️ 404 = **还没这个 Worker**，那是首次部署的正常情形，不是错误。
    if (response.status === 404) return null;
    if (!response.ok || !body?.success) {
        const detail = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
        throw new Error(`读不到 ${workerName} 的 workers.dev 状态：${detail}`);
    }
    return body.result;
}

/**
 * 账号 id 没给时**自己认**（token 只够一个账号的情形）。
 *
 * ⚠️ 为什么不直接报错要账号 id：工作流里 `CLOUDFLARE_ACCOUNT_ID` 是**可选**的
 *（`wrangler` 自己也能认出来，那边为此专门打印了一句 warning）——
 * 这一步不该把一件本来能用的事变成必须配一个变量。
 * ⚠️ 多个账号就必须显式给：挑错账号去读状态，会把**另一个账号**的开关写进配置。
 */
async function resolveAccountId(token) {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=2', {
        headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
        const detail = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
        throw new Error(`认不出账号 id（也没给 CLOUDFLARE_ACCOUNT_ID）：${detail}`);
    }
    const accounts = body.result ?? [];
    if (accounts.length !== 1) {
        throw new Error(
            `这个 token 能看到 ${accounts.length} 个账号 —— 请显式给 CLOUDFLARE_ACCOUNT_ID` +
                '（挑错账号会把别的账号的开关写进配置）。',
        );
    }
    console.log(`· 没给 CLOUDFLARE_ACCOUNT_ID，用 /accounts 认出来：${accounts[0].id}`);
    return accounts[0].id;
}

async function main() {
    const [path = 'wrangler.toml'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const assumeArg = process.argv.indexOf('--assume');
    const assume = assumeArg >= 0 ? process.argv[assumeArg + 1] : null;

    const toml = readFileSync(path, 'utf8');
    const workerName = process.env.WORKER_NAME || workerNameOf(toml);
    if (!workerName) throw new Error(`配置里没有 name = "…"，也没给 WORKER_NAME：${path}`);

    let current;
    if (assume) {
        if (!['enabled', 'disabled', 'missing'].includes(assume)) {
            throw new Error(`--assume 只认 enabled / disabled / missing，给的是 ${assume}`);
        }
        current =
            assume === 'missing'
                ? null
                : { enabled: assume === 'enabled', previews_enabled: assume === 'enabled' };
        console.log(`· 按 --assume ${assume} 处理（没联网）`);
    } else {
        const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
        if (!token) {
            throw new Error(
                '要读 workers.dev 的当前状态，得给 CLOUDFLARE_API_TOKEN（或 CF_API_TOKEN）。' +
                    '⚠️ 这里**不静默跳过** —— 跳过等于把 true 再写一遍。',
            );
        }
        const accountId =
            process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || (await resolveAccountId(token));
        current = await readSubdomain({ accountId, token, workerName });
    }

    const values = decideSubdomain(current);
    const { toml: next, missing } = writeSubdomainLines(toml, values);
    if (missing.length) {
        throw new Error(
            `配置里没有这几行：${missing.join('、')} —— 模板必须**显式**写出来，` +
                '否则「部署会不会动这个开关」就没人看得见（这正是当初那个 bug 的成因）。',
        );
    }
    writeFileSync(path, next);

    const now = current
        ? `现在是 ${current.enabled ? '开' : '关'} / preview ${current.previews_enabled ? '开' : '关'}`
        : '还没有这个 Worker（首次部署）';
    console.log(`· ${workerName}：${now} → 写回 workers_dev = ${values.workers_dev}、preview_urls = ${values.preview_urls}`);
    console.log('  ⚠️ 这一步是「照原样写回」：部署之后这个开关与部署前一致（首次部署除外）。');
}

// ⚠️ 只有**直接跑**时才执行（被 import 去做测试时不要动文件、也不要联网）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`✗ ${error.message}`);
        process.exit(1);
    });
}
