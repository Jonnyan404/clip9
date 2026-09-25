#!/usr/bin/env node
// 分享页（`/s/<token>`）的**真浏览器**验收 —— 补上 P1 最后一个验证缺口。
//
// 用法（先起一个带静态资源的服务端）：
//
//   ./cloud-clip -config cfg --port 19531 --data /tmp/ccg-spa --static ../cloud-clip/lib/static
//   node tools/share-page-acceptance.mjs http://127.0.0.1:19531
//
// # 为什么需要它
//
// `docs/HANDOVER.md` §5/§6 一直挂着这一条：落地页的 OG 标签与 `<base>` 只验到 **HTML 这一层**
// （`crates/server/tests/share_api.rs` 逐字断言那份 HTML），而「**前端拿这份外壳渲染出什么**」
// 没人验过。那份 HTML 对不对、和页面能不能用，是两件事 —— 下面四种都不会让服务端测试变红：
//
//   · 前端路由没接管（页面停在主应用 / 白屏）
//   · 深路径下相对资源 404（`<base>` 没生效）
//   · 密码闸门没出来（带密码的分享直接把正文露了，或者反过来谁都进不去）
//   · `<img>` / `<a download>` 取不到字节（浏览器直连加不了自定义头，要靠预览令牌）
//
// 断言的是**整条链**：点开分享链接 → 前端 history 路由接管 → 显示正文 → 输密码 →
// 预览图片 / 下载 / 换一条分享。一条断言串多环，跟 `tools/spa-acceptance.mjs` 一个路子。
//
// ⚠️ **必须在沙箱外跑**（`dangerouslyDisableSandbox`）。沙箱里 Chrome 起得来、`/json/list`
// 也通，但 `Runtime.enable` 永不返回，报出来是「CDP Runtime.enable 超时」——
// 看着像脚本自己的 bug，其实一个字都没错。
//
// ⚠️ 断言尽量**不绑文案**：这个前端有 zh / zh-TW / en / ja 四份语言，绑中文串等于把验收
// 挂在 locale 上。所以用结构信号（`.share-page__raw`、`.share-page__center--form`、
// `.v-field--error`）而不是「密码不正确」这类字符串。

import { launchChrome, reporter, sleep } from './lib/chrome-cdp.mjs';

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) {
  console.error('用法: node tools/share-page-acceptance.mjs <baseUrl>');
  process.exit(2);
}

// 分享密码由脚本自己定（是**分享**密码，不是房间密码），所以开放实例也能跑。
const SHARE_PW = 'share-pw-123';

const { ok, summary, state } = reporter();

/** 建数据用的 HTTP helper（不起浏览器，就是普通 fetch）。 */
async function api(method, path, body, headers) {
  const res = await fetch(`${BASE}${path}`, { method, body, headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function postText(marker) {
  const r = await api('POST', '/text', marker, { 'content-type': 'text/plain; charset=utf-8' });
  if (r.status !== 200) throw new Error(`POST /text 失败：${r.status} ${r.text}`);
  return r.json.id;
}

async function signShare(payload) {
  const r = await api('POST', '/share', JSON.stringify(payload), { 'content-type': 'application/json' });
  if (r.status !== 200) throw new Error(`POST /share 失败：${r.status} ${r.text}`);
  return r.json.token;
}

/** 一张 1×1 的 PNG —— 小到不占空间，但足够让 `naturalWidth > 0` 成立。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

/** 上传一个文件，返回它的 uuid。 */
async function uploadPng(name) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), name);
  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  const up = await res.json();
  // ⚠️ uuid 在**条目**上，`POST /upload` 的响应里只有 `{id, type, url}` ——
  // 所以拿不到就得回头问一次 `/content/<id>`（那里给的是 `uuid` 字段）。
  // 别把这里的字段名当成「本来就知道」：写错的表现是「脚本自己挂了」，
  // 而上一次上传其实已经成功了，真去查会查到别处。
  if (up.uuid || up.cache) return up.uuid || up.cache;
  const entry = await api('GET', `/content/${up.id}?format=json`);
  const uuid = entry.json?.uuid || entry.json?.cache;
  if (!uuid) throw new Error(`拿不到上传文件的 uuid：${JSON.stringify(entry.json ?? up)}`);
  return uuid;
}

try {
  // ── 建数据 ────────────────────────────────────────────────────────────
  const markerA = `分享页验收A-${Date.now()}`;
  const markerD = `分享页验收D-${Date.now()}`;
  const idA = await postText(markerA);
  const idD = await postText(markerD);
  const pngName = `share-probe-${Date.now()}.png`;
  const pngUuid = await uploadPng(pngName);

  const openToken = await signShare({ type: 'content', id: idA }); // 开放分享
  const pwToken = await signShare({ type: 'content', id: idA, password: SHARE_PW });
  const otherToken = await signShare({ type: 'content', id: idD }); // 换 token 用
  const fileToken = await signShare({ type: 'file', uuid: pngUuid, password: SHARE_PW });

  const { cdp } = await launchChrome();
  console.log(`\n=== 分享页验收：${BASE} ===`);

  /** 分享页在不在、里面有没有正文、外壳在不在 —— 一组查询全在页面里做。 */
  const probe = () =>
    cdp.eval(`JSON.stringify({
      page: !!document.querySelector('.share-page'),
      raw: document.querySelector('.share-page__raw')?.textContent || '',
      shellMain: !!document.querySelector('.app-shell__main'),
      roomAside: !!document.querySelector('.room-browser'),
      gate: !!document.querySelector('.share-page__center--form'),
      fieldError: !!document.querySelector('.share-page .v-field--error'),
      img: (() => { const i = document.querySelector('img.share-page__image'); return i ? i.naturalWidth : -1; })(),
      downloadHref: document.querySelector('.share-page a[download]')?.getAttribute('href') || '',
      url: location.pathname,
      baseURI: document.baseURI
    })`);

  // ── ① 开放分享：整条链走通 ─────────────────────────────────────────────
  await cdp.goto(`${BASE}/s/${openToken}`, 3000);
  let p = JSON.parse(await probe());

  ok('分享页接管了 /s/<token>（.share-page 在）', p.page === true);
  // ⚠️ 这条是 single-address-share.md §5「坑 1」的回归守卫：主应用的「模式写回地址」
  // 曾经把 `/s/<token>` 顶成 `/?mode=default` —— OG 标题还是对的，所以肉眼很难发现。
  ok('地址没被主应用顶掉（仍是 /s/<token>）', p.url === `/s/${openToken}`, p.url);
  // ⚠️ `<base>` 没注入的话，深路径下相对资源会解析成 /s/assets/… 全 404，
  // 表现是白屏 —— 而服务端那条断言只看 HTML，看不到这个。
  ok('深路径下 <base> 生效（baseURI 落在 /）', p.baseURI === `${BASE}/`, p.baseURI);
  ok('★ 正文渲染出来了（不是白屏）', p.raw.includes(markerA));

  // 分享页是**裸壳**：工具栏 / 房间侧栏 / 输入区都不该在。
  ok('主应用外壳不在（没把收件人带进应用里）', p.shellMain === false && p.roomAside === false);
  ok(
    '没有 console error / 未捕获异常',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : undefined
  );

  // ── ② 无效 token：给一句话，不是白屏 ──────────────────────────────────
  await cdp.goto(`${BASE}/s/not-a-real-token`, 2500);
  p = JSON.parse(await probe());
  ok(
    '无效 token → 有提示而不是空白',
    p.page === true && p.raw === '' && (await cdp.eval(`document.body.innerText.trim().length > 0`)) === true
  );

  // ── ③ 带密码：先闸门，再错一次，再对 ──────────────────────────────────
  await cdp.goto(`${BASE}/s/${pwToken}`, 2500);
  p = JSON.parse(await probe());
  ok('★ 带密码的分享先出密码闸门，正文不可见', p.gate === true && !p.raw.includes(markerA));
  ok('闸门阶段没有报错（不是一上来就说密码错）', p.fieldError === false);

  /**
   * 在页面里填密码并提交。
   *
   * ⚠️★ **必须等按钮真的可用，再单独点它**。Vuetify 那个提交按钮是 `:disabled="!password"`，
   * 而 `disabled` 要等**下一次渲染**才更新 —— 把「设值 + 派发 input + click」写在同一段同步
   * 代码里，点的是一个**还是 disabled** 的按钮，而 `HTMLElement.click()` 对 disabled 按钮
   * **静默无效**（不抛错、不报错）。于是助手会老老实实回一句「提交了」，
   * 其实什么都没发生 —— 本次写完第一次跑就这样假绿了 4 条。
   *
   * Vuetify 的 `v-text-field` 绑 `v-model`，只改 `input.value` 不触发 Vue 的更新，
   * 得派发一个 `input` 事件（`change` 顺带发了，防某些路径只监听它）。
   */
  const submitPassword = async (value) => {
    await cdp.eval(`
      (() => {
        const input = document.querySelector('.share-page .share-page__center--form input');
        if (!input) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set';
      })()
    `);
    const enabled = await cdp.waitFor(
      `(() => {
        const b = document.querySelector('.share-page .share-page__center--form button');
        return !!b && !b.disabled;
      })()`,
      true,
      5000
    );
    if (!enabled) return 'button-never-enabled';
    await cdp.eval(
      `document.querySelector('.share-page .share-page__center--form button').click()`
    );
    return 'submitted';
  };

  ok('密码闸门能填能提交', (await submitPassword('wrong-password')) === 'submitted');
  await sleep(1500);
  p = JSON.parse(await probe());
  ok('★ 密码错 → 有错误提示，且正文仍然不可见', p.fieldError === true && !p.raw.includes(markerA));

  await submitPassword(SHARE_PW);
  await sleep(1500);
  p = JSON.parse(await probe());
  ok('★ 密码对 → 正文出现', p.raw.includes(markerA));

  // ── ④ 图片分享：浏览器直连那条路（预览令牌）────────────────────────────
  await cdp.goto(`${BASE}/s/${fileToken}`, 2500);
  await submitPassword(SHARE_PW);
  await sleep(2000);
  p = JSON.parse(await probe());

  // ⚠️ 这条防的是「文本正常、文件 401」那个不对称：`<img>` 由浏览器发起，加不了
  // `X-Share-Password` 头，所以必须换发预览令牌。图片没解码出来就说明那条路断了 ——
  // 而它不会让任何服务端测试变红（服务端只发 HTML，字节是浏览器去取的）。
  ok('★ 图片真的解码出来了（浏览器直连取到了字节）', p.img > 0, `naturalWidth=${p.img}`);
  ok(
    '下载/预览地址用的是**预览令牌**，不是分享令牌',
    p.downloadHref.includes('t=') && !p.downloadHref.includes(fileToken),
    p.downloadHref.slice(0, 60)
  );
  {
    // 真去取一遍那个地址：200 且字节与上传的**逐字节相同**。
    const bytes = await cdp.eval(`
      fetch(${JSON.stringify(p.downloadHref)}).then(r => r.arrayBuffer())
        .then(b => { const u = new Uint8Array(b); return b.byteLength + ':' + [...u.slice(0, 8)].join(','); })
        .catch(e => 'ERR ' + e.message)
    `);
    const expectedBytes = [...PNG_1PX.slice(0, 8)].join(',');
    ok('★ 直接取那个地址拿到的就是原图字节', bytes === `${PNG_1PX.length}:${expectedBytes}`, bytes);
  }

  // ── ⑤ 同路由换 token（**不刷新**）→ 必须换内容 ─────────────────────────
  //
  // 这条是 ShareView 的 `watch(token)` 的回归守卫：分享页只有一条路由（`/s/:token`），
  // 换 token 时 vue-router **复用组件实例、onMounted 不再跑**。不 watch 就会一直显示
  // 上一条分享的内容 —— 连「无效 token」都显示成上一条的正文。实测踩到过。
  //
  // ⚠️ 必须**不刷新**地换：`Page.navigate` 会重新挂载组件，那条路走的是 onMounted，
  // 根本碰不到 watch，测了等于没测（这正是「换场景先 navigate 到 about:blank」那类假绿）。
  await cdp.goto(`${BASE}/s/${openToken}`, 2500);
  await cdp.eval(`
    (() => {
      const state = { clip9Probe: 1 };
      history.pushState(state, '', '/s/${otherToken}');
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
      return 'pushed';
    })()
  `);
  await sleep(2500);
  p = JSON.parse(await probe());
  const switched = p.raw.includes(markerD) && !p.raw.includes(markerA);
  ok(
    '★ 不刷新换 token → 显示新的那条（不是上一条的残留）',
    switched,
    switched ? undefined : `url=${p.url} 正文=${JSON.stringify(p.raw.slice(0, 40))}`
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
