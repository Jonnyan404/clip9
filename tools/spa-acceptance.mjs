#!/usr/bin/env node
// SPA 实机验收：用真浏览器把前端跑起来，验证它连得上**这个**服务端。
//
// 用法（先起一个带静态资源的服务端）：
//
//   cargo run -p clip9-server -- --port 19531 --data /tmp/ccg-spa \
//       --static ../cloud-clip/lib/static
//   node tools/spa-acceptance.mjs http://127.0.0.1:19531
//
// ⚠️ `--static` 指的是**前端构建产物**，而 SPA 的源码与构建都在 **Go 仓库**里
// （`web/`，构建产物同步进 `rust/crates/server/static`，已入库）。
// 上面那个相对路径成立的前提是**本仓库在 Go 仓库里面**（clone 进它的根目录）；
// 两个仓库平级时要改成 `../cloud-clipboard-go/cloud-clip/lib/static`。
// ⚠️ **SPA 与 API 必须同源** —— 前端那些请求是相对根路径的。
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
// ⚠️ 需要真浏览器：`../cloud-clip/tools/page-smoke.mjs` 那套 DOM 桩只适用**服务端渲染页面**
// （它抽页面里的内联 `<script>`），Vue SPA 是打包出来的模块，桩跑不了。
//
// ⚠️ **必须在沙箱外跑**（`dangerouslyDisableSandbox`）：沙箱里 Chrome 起得来、调试端口也通，
// 但 `Runtime.enable` 永远不返回，报出来是一句「CDP Runtime.enable 超时」。
// 分享页那条链在 `tools/share-page-acceptance.mjs`，两者共用 `tools/lib/chrome-cdp.mjs`。

import { launchChrome, reporter } from './lib/chrome-cdp.mjs';

const BASE = process.argv[2];
if (!BASE) {
  console.error('用法: node tools/spa-acceptance.mjs <baseUrl>');
  process.exit(2);
}

const { ok, summary, state } = reporter();

try {
  const { cdp } = await launchChrome();

  console.log(`\n=== SPA 验收：${BASE} ===`);

  // ① 打开首页
  await cdp.goto(`${BASE}/`, 2500); // 首屏要拉 chunk + 建 WS

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
    const appeared = await cdp.waitForText(marker, true);
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
    const appeared = await cdp.waitForText(fname, true);
    ok('★ 文件条目出现在页面上', appeared, appeared ? undefined : '等了 10 秒没出现');
  }

  // ⑤ 删条目 → 它从页面上消失（这条验证 WS 的 `revoke` 广播也通了）
  const revoked = await cdp.eval(`fetch('/revoke/${textId}', { method: 'POST' }).then(r => r.status)`);
  ok('从页面里 POST /revoke 成功', revoked === 200, `status=${revoked}`);
  {
    const gone = await cdp.waitForText(marker, false);
    ok('★ 撤销后那条从页面上消失', gone, gone ? undefined : '等了 10 秒还在');
  }

  // ⑥ 看历史：刷新 → 服务端回放历史，文件条目还在（文本那条已经被删了）
  await cdp.goto(`${BASE}/`, 2500);
  ok(
    '★ 刷新后历史回放（文件条目还在、被删的没回来）',
    (await cdp.eval(`document.body.innerText.includes(${JSON.stringify(fname)})`)) === true &&
      (await cdp.eval(`document.body.innerText.includes(${JSON.stringify(marker)})`)) === false
  );

  // ⑦ 深链：直接进一个前端路由，服务端要兜底给同一份 HTML（否则刷新 404）。
  // ⚠️ 这里只验「外壳能加载」；分享页**渲染出什么**由 `tools/share-page-acceptance.mjs` 验。
  await cdp.goto(`${BASE}/s/whatever`, 1200);
  ok(
    '深链 /s/<token> 能加载（服务端兜底到 index.html）',
    (await cdp.eval(`document.querySelector('#app') !== null`)) === true
  );

  summary();
  if (state.fail > 0) {
    console.log('\n页面报的错：');
    cdp.errors.slice(0, 10).forEach((e) => console.log('  - ' + e));
  }
  process.exit(state.fail === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n验收脚本自己挂了：${e.message}`);
  process.exit(2);
}
