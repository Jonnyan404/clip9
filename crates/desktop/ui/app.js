/*
  连接自检 + 状态显示。

  ⚠️★ 这一块就是 **W0 要验的东西**（`docs/specs/desktop-client.md` §0.1.3）：
  手写页面（origin 是 **`tauri://localhost`**）能不能**跨源**调内嵌服务端的 API 与 WebSocket。

  两条路都要试，而且**要照真上线的形状试**：

  ① **HTTP 带 `Authorization` 头**（`GET /server`）。⚠️ 不是为了那个响应 ——
     是为了**触发 CORS 预检**：自定义头（`Authorization` 就是）会让浏览器先发 `OPTIONS`。
     不带头的 `fetch` 是「简单请求」，**不预检**，于是「读到了数据」是个假象 ——
     真上行的 `POST /text` 一定带凭据，那条路通不通才是要问的。
  ② **WebSocket 握手**。⚠️ CORS **不管** WebSocket（浏览器不对它做预检），
     管它的是 **CSP 的 `connect-src`** —— 两件事别混。

  服务端地址从 `window.__CLIP9_SERVER__` 读（W3 接内嵌服务端时由壳注入），
  读不到就用默认端口。**别在页面里写死端口** —— 那是「壳决定服务端在哪」的职责。
*/

const DEFAULT_SERVER = 'http://127.0.0.1:9501';
const SERVER = String(window.__CLIP9_SERVER__ || DEFAULT_SERVER).replace(/\/+$/, '');

const connEl = document.getElementById('conn');
const connText = document.getElementById('conn-text');
const diagEl = document.getElementById('diag');

/**
 * 两路自检各自的结果 —— ⚠️ 用两个槽**分别存**，别共用一个字符串。
 *
 * 共用一个的话，两个结果谁后到谁留下（异步，顺序不定）—— 于是「用户看到哪一行」
 * 是随机的。这种「看起来只是显示问题」的不确定，正是这个项目最忌讳的一类。
 */
const probe = { http: 'HTTP 自检中…', ws: 'WS 等待中…' };

function render() {
    if (diagEl) {
        diagEl.textContent = `${SERVER}\n${probe.http} · ${probe.ws}`;
    }
}

/** 改标题栏那个圆点 + 文案。 */
function setStatus(kind, text) {
    if (connEl) {
        connEl.classList.toggle('off', kind === 'off');
        connEl.classList.toggle('wait', kind === 'wait');
    }
    if (connText) connText.textContent = text;
    render();
}

/**
 * ① HTTP：**故意带 `Authorization`** 去触发预检。
 *
 * ⚠️ 预检失败的表现很容易认错：`fetch` 抛的是一句
 * 「Failed to fetch」/「Load failed」，**看不出是 CORS**（浏览器不给脚本看细节）。
 * 所以这里把「网络层失败」和「HTTP 状态码不对」分开报 —— 前者多半就是 CORS/CSP。
 *
 * ⚠️ 这里**读完整个 body**：CORS 真正管住的就是「能不能读到响应体」，
 * 只看状态码的话，一个「预检过了但响应被拦」的情况看不出来。
 *
 * ⚠️ 但**不从这里读版本号** —— `/server` 的载荷里**没有** `version`
 * （它只有 `server`/`auth`/`authorized`/`roomProtected`/`config`/`automation`）。
 * 版本在 WS 的 `config` 事件里，见下面那一处。
 */
async function probeHttp() {
    const url = `${SERVER}/server`;
    try {
        const response = await fetch(url, {
            headers: { Authorization: 'Bearer w0-probe' },
        });
        if (!response.ok) {
            probe.http = `HTTP ✗ ${response.status}`;
            setStatus('off', `服务端返回 ${response.status}`);
            return;
        }
        await response.json();
        probe.http = 'HTTP ✓';
        setStatus('on', '已连接');
    } catch (error) {
        // ⚠️ 到这儿基本就是 CORS 预检被拒 / CSP 拦了 —— 但**脚本看不到原因**，
        // 只能如实说「没连上」，原因要去服务端日志或抓包看。别在这里猜。
        probe.http = 'HTTP ✗ 请求失败';
        setStatus('off', '连不上');
        console.warn(`[clip9] ${url} 请求失败（CORS 或 CSP）：`, error);
    }
}

/**
 * ② WebSocket：连上之后**只等 `config`** 就收工。
 *
 * ⚠️★ 握手不再推历史（`docs/specs/ws-live-only.md` W5），`config` 是第一个该到的业务事件，
 * 而且它同时带着 `latestId`（边界）与 `version` / `text.limit` / `file.limit`
 * （**限额就在这儿，不在 `/server`** —— 见 `clip9-client` 的 `uploader` 模块文档）。
 * 收到它就说明「协议这一层是通的」。
 */
function openSocket() {
    const wsUrl = `${SERVER.replace(/^http/, 'ws')}/push?room=default`;
    let socket;
    try {
        socket = new WebSocket(wsUrl);
    } catch (error) {
        probe.ws = 'WS ✗ 建不起来';
        setStatus('off', 'WebSocket 建不起来');
        console.warn(`[clip9] ${wsUrl}：`, error);
        render();
        return;
    }

    socket.addEventListener('message', (event) => {
        let frame;
        try {
            frame = JSON.parse(event.data);
        } catch {
            return;
        }
        if (frame.event === 'config') {
            const data = frame.data || {};
            const latest = 'latestId' in data ? data.latestId : '缺';
            probe.ws = `WS ✓ v${data.version || '?'} latestId=${latest}`;
            setStatus('on', '已连接');
        }
    });

    socket.addEventListener('error', () => {
        // ⚠️ 同样：浏览器不给脚本看原因。CSP 的 `connect-src` 少一个协议（ws vs wss）就会走到这儿。
        probe.ws = 'WS ✗ 出错';
        render();
        console.warn(`[clip9] WS 出错：${wsUrl}（多半是 CSP 的 connect-src）`);
    });

    socket.addEventListener('close', () => {
        probe.ws = 'WS ✗ 已断开';
        setStatus('off', '已断开');
    });
}

setStatus('wait', '连接中…');
probeHttp();
openSocket();
