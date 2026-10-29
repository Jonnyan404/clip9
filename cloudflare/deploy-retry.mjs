#!/usr/bin/env node
// 跑 `wrangler deploy`，只在**认得出的临时故障**上退避重试。
//
// 用法（工作目录都是 `cloudflare/workers`，与直接敲 `wrangler deploy` 一样）：
//   node ../deploy-retry.mjs                 # = wrangler deploy
//   node ../deploy-retry.mjs deploy --env="" # 参数原样透传给 wrangler
//
// ── 为什么需要它（2026-10-29）───────────────────────────────────────────────
// 部署连续挂在 `assets-upload-session` 上，HTTP 500 / `code: 10013`
//（"An unknown error has occurred"）。**不是**配置或代码问题，证据：
//   · 最小 1 个文件的 manifest 直接打那个接口，照样 500（别人替我们试过）；
//   · 同一个 token、同一个账号，**新建**一个 Worker 能完整传完；
//   · 4.148 / 4.151.3 / 4.152.0 / 4.153.0 / 4.155.0 全中招 —— 升级 wrangler 没用；
//   · 我们自己 2026-10-27 那次失败后，5 分钟后手动重跑就绿了。
// workers-sdk 的 #16447 / #16517 记的就是这件事，官方结论是「Cloudflare 内部的
// assets-upload-session 临时故障，服务端自己恢复，无需改客户端」。
// → 所以唯一有效的工程对策是**等一会儿重试**。别指望升级依赖能治它。
//
// ⚠️★ 只重试**认得出**的临时错误。配置写错 / 脚本语法错 / 绑定不存在这类，
//    重试只会把 2 分钟拖成 6 分钟，还会把真正的原因埋进一堆重复日志里。
// ⚠️ 重试是安全的：`wrangler deploy` 是「传完才切」，失败时线上仍是上一版；
//    已经传过的 assets 在重试时会命中「already present」，不会重传。
// ⚠️ 不要在这里加 `--force` 之类的绕法：绕不过服务端 500，只会换个错误码。

import { spawn } from 'node:child_process';

// 10013 是服务端**在 ~20 秒后**才返回的（它自己在超时），所以别贴脸重试。
const MAX_ATTEMPTS = Number(process.env.DEPLOY_RETRY_ATTEMPTS || 3);
const BASE_DELAY_MS = Number(process.env.DEPLOY_RETRY_DELAY_MS || 30_000);

// 这些子串只要出现一个，就认为「服务端/网络临时抽风」，值得再试一次。
// ⚠️ 别把 `code: 10000`（认证失败）、`code: 10021`（脚本太大）之类塞进来 ——
//    那些重试一万次也是同样的结果。
const RETRYABLE = [
  'code: 10013',
  'An unknown error has occurred',
  'Internal Server Error',
  'HTTP 500',
  'fetch failed',
  'ECONNRESET',
  'socket hang up',
  'ETIMEDOUT',
  'net::ERR_',
];

const wrangler = process.env.WRANGLER_BIN || 'wrangler';
const argv = process.argv.slice(2);
const wranglerArgs = argv.length ? argv : ['deploy'];

/** 在 CI 里用 annotation，本地直接说话。 */
const warn = (msg) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`);
  else console.warn(`[WARN] ${msg}`);
};
const fail = (msg) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${msg}`);
  else console.error(`[ERROR] ${msg}`);
};

/** 跑一次，边跑边透传输出（同时攒起来判断要不要重试）。 */
function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(wrangler, wranglerArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let out = '';
    const pump = (stream, target) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        out += chunk;
        target.write(chunk);
      });
    };
    pump(child.stdout, process.stdout);
    pump(child.stderr, process.stderr);

    // ⚠️ `error` 和 `close` 可能都来，Promise 只认第一个，不用去重。
    child.on('error', (err) => resolve({ code: 1, out: `${out}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

let attempt = 1;
for (;;) {
  if (attempt > 1) {
    console.log(`\n── 第 ${attempt} 次尝试（最多 ${MAX_ATTEMPTS} 次）──\n`);
  }

  const { code, out } = await runOnce();
  if (code === 0) process.exit(0);

  const hit = RETRYABLE.find((marker) => out.includes(marker));
  if (!hit) {
    fail(
      `部署失败（退出码 ${code}），但没匹配到任何可重试的临时错误标记 —— 不重试，` +
        '这大概率是配置/代码问题，看上面的原话。',
    );
    process.exit(code);
  }

  if (attempt >= MAX_ATTEMPTS) {
    fail(`部署连续 ${attempt} 次失败，最后一次是「${hit}」—— 放弃。`);
    console.error(
      '若是 code: 10013 / assets-upload-session：那是 Cloudflare 侧的间歇故障，' +
        '过十几分钟手动重跑即可（`gh workflow run deploy-cloudflare.yml`）。' +
        '持续几小时不退，就带上 Ray ID 找 Cloudflare 支持 —— 改配置和升级 wrangler 都没用。',
    );
    process.exit(code);
  }

  const waitMs = BASE_DELAY_MS * attempt;
  warn(
    `部署第 ${attempt} 次失败（临时错误「${hit}」），${Math.round(waitMs / 1000)} 秒后重试`,
  );
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  attempt += 1;
}
