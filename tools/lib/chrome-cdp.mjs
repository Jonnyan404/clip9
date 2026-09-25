// 真浏览器验收的公共脚手架：起无头 Chrome、连 page target、发 CDP 命令、数通过数。
//
// 用它的两个脚本：`tools/spa-acceptance.mjs`（P0）与 `tools/share-page-acceptance.mjs`（P1）。
//
// ⚠️ **为什么抽成模块**：这套东西里有四处**踩出来的**坑，写第二份就等于让下一个踩坑的人改两处 ——
// 正是 `docs/CONTRIBUTING.md` §6 说的「靠人肉同步的第二份定义」。四处坑分别写在下面各自的注释里：
//
// 1. 必须连 **page target**（`/json/list`），不能连浏览器级的 `/json/version`；
// 2. CDP 调用**必须带超时**，否则页面崩了会静默挂死；
// 3. `process.on('exit')` **不**在 Ctrl-C 时触发，信号要单独处理，否则会留下无头 Chrome；
// 4. 调试端口要避开正式实例（9501/9599/9600/9602），撞上会拿到 SPA 的 index.html。
//
// ⚠️ 本机跑它**必须在沙箱外**：Chrome 在沙箱里能起来、调试端口也通，但 `Runtime.enable`
// 永远不返回（表现成「超时」而不是报错）。见 `docs/HANDOVER.md` §2。

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { dispose, makeTempDir } from './tmpdir.mjs';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个无头 Chrome 并连上它的 page target。返回 `{ cdp, close }`。
 *
 * `close()` 会杀掉进程并删掉临时 profile —— 调用方在正常结束与信号处理里都要调它。
 */
export async function launchChrome({ width = 1280, height = 900 } = {}) {
  // ⚠️ 9700 + rand(200)：别撞 9501（正式实例）和 9599/9600/9602。
  const port = 9700 + Math.floor(Math.random() * 200);
  const profile = makeTempDir('clip9-spa-');

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const close = () => {
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    // ⚠️ **挪走，不删**：这个 profile 里有几百个文件，递归删除会撞沙箱的批量删除守卫、
    // 弹一次权限确认框。`mv` 一样能让它从视野里消失。见 `lib/tmpdir.mjs`。
    dispose(profile);
  };

  // ⚠️ `process.on('exit')` **不**在 Ctrl-C / SIGTERM 时触发。少了这几个处理器，
  // 每中断一次就留一个无头 Chrome：它占着调试端口，还会让 macOS 认为「Chrome 正在运行」，
  // 于是点图标打不开 Chrome。（2026-09-25 实际踩到过。）
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      close();
      process.exit(130);
    });
  }
  process.on('exit', close);

  const url = await pageTargetUrl(port);
  const cdp = new CDP(url);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { cdp, close };
}

/**
 * 拿 **page target** 的调试地址。
 *
 * ⚠️ 别用 `/json/version` —— 那个给的是**浏览器级**的 WebSocket，
 * 在它上面调 `Runtime.enable` 会报 `'Runtime.enable' wasn't found`。
 * `Page.navigate` / `Runtime.evaluate` 这些是**页面级**的域，必须连 page target。
 */
async function pageTargetUrl(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
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

export class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
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

  async goto(url, waitMs = 2500) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  /** 轮询直到某个表达式等于期望值（默认 `true`）。两个 `waitFor*` 都是它的特例。 */
  async waitFor(expression, expected = true, timeoutMs = 10000) {
    for (let i = 0; i < timeoutMs / 250; i++) {
      if ((await this.eval(expression)) === expected) return true;
      await sleep(250);
    }
    return false;
  }

  /** 轮询直到 `document.body.innerText` 里出现（`present=true`）或消失某段文字。 */
  async waitForText(text, present, timeoutMs = 10000) {
    return this.waitFor(
      `document.body.innerText.includes(${JSON.stringify(text)})`,
      present,
      timeoutMs
    );
  }

  /** 轮询直到某个选择器出现（`present=true`）或消失。 */
  async waitForSelector(selector, present, timeoutMs = 10000) {
    return this.waitFor(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      present,
      timeoutMs
    );
  }
}

/**
 * 通过/失败计数器。输出格式与两个脚本原来的写法一致（`  ok   name` / `  FAIL name`）。
 *
 * ⚠️ `extra` **只在需要说明时**才该传。无条件挂一句提示会让成功那行也写着
 * 「等了 10 秒没出现」—— 那种自相矛盾的输出比没有输出更糟，下一个人会以为这条没验到。
 */
export function reporter() {
  const state = { pass: 0, fail: 0, failures: [] };
  const ok = (name, cond, extra) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined ? ` -> ${extra}` : ''}`);
    if (cond) {
      state.pass++;
    } else {
      state.fail++;
      state.failures.push(name);
    }
  };
  const summary = () => {
    console.log(`\n通过 ${state.pass}，失败 ${state.fail}`);
    if (state.fail) {
      console.log('\n没过的：');
      state.failures.forEach((f) => console.log('  - ' + f));
    }
  };
  return { ok, summary, state };
}
