#!/usr/bin/env node
// SPA 实机验收：用真浏览器把前端跑起来，验证它连得上**这个**服务端。
//
// 用法（先起一个带静态资源的服务端）：
//
//   cargo run -p clip9-server -- --port 19531 --data /tmp/ccg-spa \
//       --static ../cloud-clip/lib/static
//   node tools/spa-acceptance.mjs http://127.0.0.1:19531
//
// 这是 `ARCHITECTURE.md` §8 给 P0 定的**验收标准**：
// 「现有 SPA 指向 Rust 服务端，发文本 / 传文件 / 删条目 / 看历史全部正常」。
//
// # 为什么断言「发一条 → 它出现在 DOM 里」就够
//
// 这一条串起了整条链路，任何一环断了它都会红：
//
//   浏览器 fetch POST /text → 服务端入库 → **WS 广播** → SPA 收到 receive → 列表渲染
//
// 也就是说它同时验证了 HTTP 写接口、存储、WebSocket 握手（`config` 事件）、广播分发、
// 以及前端的渲染。**比逐个 curl 接口有意义得多** —— 那些 `tools/compare-with-go.mjs` 已经做了。
//
// ⚠️ 需要真浏览器：`cloud-clip/tools/page-smoke.mjs` 那套 DOM 桩只适用**服务端渲染页面**
// （它抽页面里的内联 `<script>`），Vue SPA 是打包出来的模块，桩跑不了。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2];
if (!BASE) {
  console.error('用法: node tools/spa-acceptance.mjs <baseUrl>');
  process.exit(2);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// ⚠️ 端口用 9700 + rand(200)：别撞 9501（用户的正式实例）和 9599/9600/9602。
// 撞上之后 `/json/version` 会拿到一份 SPA 的 index.html，报出来是一句莫名其妙的 `Invalid URL`。
const PORT = 9700 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), 'clip9-spa-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
};
process.on('exit', cleanup);
// ⚠️ `process.on('exit')` **不**在 Ctrl-C / SIGTERM 时触发 —— 少了这几个处理器，
// 每中断一次就留一个无头 Chrome，它会占着调试端口、还会让 macOS 认为「Chrome 正在运行」，
// 于是点图标打不开 Chrome。（2026-09-25 实际踩到过。）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined ? ` -> ${extra}` : ''}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 拿 **page target** 的调试地址。
 *
 * ⚠️ 别用 `/json/version` —— 那个给的是**浏览器级**的 WebSocket，
 * 在它上面调 `Runtime.enable` 会报 `'Runtime.enable' wasn't found`。
 * `Page.navigate` / `Runtime.evaluate` 这些是**页面级**的域，必须连 page target。
 */
async function pageTargetUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const targets = await r.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('找不到 Chrome 的 page target');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? '未捕获异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    this.errors = [];
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    // ⚠️ CDP 调用**必须带超时**：页面崩了 / Chrome 被干掉时 `send` 永不返回，
    // 整个脚本会静默挂死（不是报错，是卡住）。
    return Promise.race([
      new Promise((res, rej) => this.pending.set(id, { res, rej })),
      sleep(20000).then(() => {
        throw new Error(`CDP ${method} 超时`);
      }),
    ]);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? '页面里抛异常了');
    }
    return r.result.value;
  }
}

try {
  const wsUrl = await pageTargetUrl();
  const cdp = new CDP(wsUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  console.log(`\n=== SPA 验收：${BASE} ===`);

  // ① 打开首页
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(2500); // 等 SPA 挂载（首屏要拉 chunk + 建 WS）

  const mounted = await cdp.eval(
    `document.querySelector('#app') && document.querySelector('#app').children.length > 0`
  );
  ok('SPA 挂载了（#app 有子节点）', mounted === true);

  // ② 没有运行时报错。⚠️ 这条抓的是「具名导入写错 = 整页白屏」那类问题 ——
  // 它不会让 curl 失败，只会让页面空白。
  ok(
    '没有 console error / 未捕获异常',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : undefined
  );

  /** 轮询直到页面上出现（`present=true`）或消失（`false`）某段文字。 */
  async function waitForText(text, present, timeoutMs = 10000) {
    const expr = `document.body.innerText.includes(${JSON.stringify(text)})`;
    for (let i = 0; i < timeoutMs / 250; i++) {
      if ((await cdp.eval(expr)) === present) return true;
      await sleep(250);
    }
    return false;
  }

  // ③ 发文本 → 它得自己出现在页面上。
  // 这条串起 HTTP 写 + 存储 + **WS 握手与广播** + 前端渲染，任何一环断了都会红。
  const marker = `SPA验收-${Date.now()}`;
  const textId = await cdp.eval(`
    fetch('/text', { method: 'POST', body: ${JSON.stringify(marker)} })
      .then(r => r.json()).then(j => j.id)
      .catch(e => 'ERR ' + e.message)
  `);
  ok('从页面里 POST /text 成功', /^\d+$/.test(String(textId)), `id=${textId}`);
  {
    // ⚠️ 提示语**只在失败时**打出来。无条件打会让成功那行也写着「等了 10 秒没出现」——
    // 那种自相矛盾的输出比没有输出更糟，下一个人会以为这条其实没验到。
    const appeared = await waitForText(marker, true);
    ok('★ 那条文本经由 WS 广播出现在页面上', appeared, appeared ? undefined : '等了 10 秒没出现');
  }

  // ④ 传文件（multipart）→ 文件名出现在页面上
  const fname = `accept-${Date.now()}.txt`;
  const fileId = await cdp.eval(`
    (() => {
      const fd = new FormData();
      fd.append('file', new Blob(['file-body'], { type: 'text/plain' }), ${JSON.stringify(fname)});
      return fetch('/upload', { method: 'POST', body: fd })
        .then(r => r.json()).then(j => j.id)
        .catch(e => 'ERR ' + e.message);
    })()
  `);
  ok('从页面里 POST /upload 成功', /^\d+$/.test(String(fileId)), `id=${fileId}`);
  {
    const appeared = await waitForText(fname, true);
    ok('★ 文件条目出现在页面上', appeared, appeared ? undefined : '等了 10 秒没出现');
  }

  // ⑤ 删条目 → 它从页面上消失（这条验证 WS 的 `revoke` 广播也通了）
  const revoked = await cdp.eval(
    `fetch('/revoke/${textId}', { method: 'POST' }).then(r => r.status)`
  );
  ok('从页面里 POST /revoke 成功', revoked === 200, `status=${revoked}`);
  {
    const gone = await waitForText(marker, false);
    ok('★ 撤销后那条从页面上消失', gone, gone ? undefined : '等了 10 秒还在');
  }

  // ⑥ 看历史：刷新 → 服务端回放历史，文件条目还在（文本那条已经被删了）
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(2500);
  ok(
    '★ 刷新后历史回放（文件条目还在、被删的没回来）',
    (await cdp.eval(`document.body.innerText.includes(${JSON.stringify(fname)})`)) === true &&
      (await cdp.eval(`document.body.innerText.includes(${JSON.stringify(marker)})`)) === false
  );

  // ⑦ 深链：直接进一个前端路由，服务端要兜底给同一份 HTML（否则刷新 404）
  await cdp.send('Page.navigate', { url: `${BASE}/s/whatever` });
  await sleep(1200);
  ok(
    '深链 /s/<token> 能加载（服务端兜底到 index.html）',
    (await cdp.eval(`document.querySelector('#app') !== null`)) === true
  );

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  if (fail > 0) {
    console.log('\n页面报的错：');
    cdp.errors.slice(0, 10).forEach((e) => console.log('  - ' + e));
  }
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n验收脚本自己挂了：${e.message}`);
  process.exit(2);
}
