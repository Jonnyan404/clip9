/*
  桌面端界面 —— **只做两件事**：把壳给的状态快照画出来、把点按转成命令。
  一行业务逻辑都不在这里（剪贴板读写、去重、边界判定全在 `clip9-client`）。

  # ⚠️ 为什么页面**不直接调服务端**
  上一版（W0 自检）页面是跨源 `fetch` + `WebSocket` 去探服务端的那一跳。
  那一跳验通之后就不需要了 —— **数据全走 IPC**：
  - 剪贴板在 Rust 那边（webview 碰不到系统剪贴板）；
  - 上行的规则（限额从握手来、凭据走请求头、多文件怎么办）都在 `clip9-client` 里，
    页面再写一遍就是**第二套**规则 —— 而两套规则一定会漂。
  所以 `tauri.conf.json` 的 CSP 里 `connect-src` 现在**只留 IPC**，
  而 `img-src` 还留着 http：文件预览的 `<img>` 是唯一还直接从服务端取的东西
  （显示图片不需要 CORS，所以那一关由 CSP 把着）。

  # ⚠️ 这份 JS 没有测试运行器
  `web-vue3` 也没有（见 MEMORY.md）—— 所以这里的正确性靠**能读懂 + 能手验**，
  而不是「构建过了就算验过」。凡是「看着对、其实骗人」的地方都在下面标出来了。
*/

// ⚠️ 用普通浏览器打开时（开发时双击 index.html）没有 `__TAURI__`。
// 那时要说清「怎么才对」，而不是抛一句 undefined 的错。
if (!window.__TAURI__ || !window.__TAURI__.core) {
  document.body.textContent =
    '这个页面要在桌面壳里打开（cargo run -p clip9-desktop）。' +
    '直接用浏览器打开它拿不到剪贴板，也连不上服务端。';
  throw new Error('no tauri bridge');
}

const { invoke } = window.__TAURI__.core;

/** 多久取一次快照。
 *
 * ⚠️ 用**轮询**而不是事件推送：一份快照就是界面的全部真相，轮询天然不会出现
 * 「丢了一条更新」或「两条更新乱序到达」。700ms 对一个托盘级客户端绰绰有余。
 * ⚠️ 串行取（取完再排下一次），否则服务端卡住时会有几十个请求堆在上面。
 */
const POLL_MS = 700;

/** 上一份快照的「形状」—— 只用来判断「要不要重画」。
 *
 * ⚠️ 用 JSON 字符串比：自己写逐字段比较函数就是**第二份字段清单**，
 * 而它一定会漏字段 —— 漏掉的那个字段变了也不会重画（界面就不动了，而且没有报错）。
 */
let lastShape = null;

/** 上一次渲染的**房间视图**（点按 ↑/↓ 时要读「现在是开着还是关着」）。
 *
 * ⚠️ 单独存一份，而不是每次去 `JSON.parse(lastShape)` —— 那个 JSON 里塞着整屏条目，
 * 为读两个布尔值去解析它，浪费得没道理。
 */
let lastRooms = [];

const el = (id) => document.getElementById(id);

function shapeOf(state) {
  return JSON.stringify([
    state.rooms, state.selected, state.entries, state.status,
    state.limits, state.problems, state.monitoring, state.dataDir,
    // ⚠️★ `notice` **必须**在里面。漏掉它的话，「上传失败」「因为开关关着而跳过」
    // 这两类提示**永远不会画出来** —— 因为它们**不改动上面任何一个字段**：
    // 上传失败什么都没变；而上传成功时，消息要靠下行回传才会进 `entries`，
    // 可**下载通道默认是关的**（§4.1 第 3 条），于是也没变化。
    // 结果是 `runtime.rs` 里「上传结果要能被界面看到」那句话**在界面上不成立**，
    // 而用户看到的只是「点了发送，没反应」。
    state.notice,
    // 这两个是常量，放进来只是为了让「形状」覆盖整份快照 ——
    // 少一个字段就多一处「变了也不重画」的隐患。
    state.configPath, state.maxEntries,
  ]);
}

/** 一个元素。`text` 走 `textContent` —— ⚠️ 消息正文是**网络来的**，绝不能进 `innerHTML`。 */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Unix 秒 → 本机时间。
 *
 * ⚠️ 服务端给的是**秒**（不是毫秒）—— 忘了乘 1000 会显示成 1970 年。
 * ⚠️ 只显示时分：秒在这张卡片上没有信息量（同一秒好几条是常事）。
 */
function timeLabel(unixSeconds) {
  if (!unixSeconds) return '—';
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sizeLabel(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

/** 一张卡片。 */
function renderEntry(entry) {
  const card = h('div', entry.mine ? 'card me' : 'card');

  if (entry.kind === 'file') {
    // ⚠️ 预览只认**壳本地拼出来的**地址，而且只认图片；别的按文件条目显示。
    // 一个非 http 的地址（配置被人手改坏）不许进 `src`。
    const url = entry.previewUrl || '';
    if (url.startsWith('http') && IMAGE_SUFFIX.test(entry.fileName)) {
      const img = h('img', 'preview');
      img.src = url;
      img.alt = entry.fileName;
      card.append(img);
    } else {
      const row = h('div', 'filerow');
      row.append(h('div', 'fi', '📄'));
      const meta = h('div');
      meta.append(h('div', 'fn', entry.fileName || '(没有文件名)'));
      const size = sizeLabel(entry.fileSize);
      if (size) meta.append(h('div', 'fs', size));
      row.append(meta);
      card.append(row);
    }
  } else {
    card.append(h('div', 'txt', entry.text));
  }

  const foot = h('div', 'ft');
  // ⚠️ 发送端没给设备信息时（老条目 / 定时消息）**不编一个名字** ——
  // 服务端专门为无 UA 的定时消息塞了 `type: "Automation"`，这里照它给的显示。
  foot.append(h('span', null, entry.mine ? '本机' : entry.device || '未知设备'));
  foot.append(h('span', null, '·'));
  foot.append(h('span', null, timeLabel(entry.timestamp)));
  if (entry.mine) {
    foot.append(h('span', 'spacer'));
    foot.append(h('span', 'tag', '我发的'));
  }
  // ⚠️ 定时 / 补发**必须**标出来：`source` / `late` / `scheduledAt` 三个字段是
  // 2026-09-26 才补进 `/content` 投影的，漏掉它们的症状是「看不出这条是自动发的」。
  if (entry.automation) {
    foot.append(h('span', 'spacer'));
    foot.append(h('span', 'tag auto', entry.late ? '自动·补发' : '自动'));
  }
  if (entry.kind === 'file') {
    foot.append(h('span', 'spacer'));
    foot.append(h('span', 'tag', '文件'));
  }
  card.append(foot);
  return card;
}

/** 侧栏的房间列表。 */
function renderRooms(state) {
  const host = el('rooms');
  host.textContent = '';
  if (!state.rooms.length) {
    host.append(h('div', 'empty', '配置里一个房间都没有。\n去配置里加一个（数据目录下的 client.json）。'));
    return;
  }
  state.rooms.forEach((room, index) => {
    const node = h('div', index === state.selected ? 'room on' : 'room');
    // ⚠️ 房间名是**用户配置**里的自由文本 → 只能走 textContent。
    node.append(h('span', 'ico', index === state.selected ? '📂' : '💬'));
    node.append(h('span', 'nm', room.name));
    const up = h('span', room.upload ? 'dir up on' : 'dir up', '↑');
    up.title = room.upload
      ? '↑ 发到房间：本机剪贴板的内容发到它（点击关掉）'
      : '↑ 不发到这个房间（点击打开）';
    up.dataset.action = 'upload';
    up.dataset.index = String(index);
    const down = h('span', room.download ? 'dir dn on' : 'dir dn', '↓');
    down.title = '↓ 收进剪贴板：这个房间的实时内容写进本机剪贴板（全局只能一个）';
    down.dataset.action = 'download';
    down.dataset.index = String(index);
    node.append(up, down, h('span', 'ct', String(room.count)));
    node.dataset.index = String(index);
    host.append(node);
  });
  // ⚠️★ 末尾这行「＋ 添加房间」不是装饰：没有它，用户在这个界面里**找不到加房间的入口**
  //（界面稿里就有这一行）。点了打开设置窗口的房间那一页。
  const add = h('div', 'room add');
  add.append(h('span', 'ico', '＋'), h('span', 'nm', '添加房间'));
  add.addEventListener('click', () => {
    openSettings();
    showPane('rooms');
  });
  host.append(add);
}

/** 标题栏那个状态点。四种状态**都要画出来**。 */
function renderStatus(state) {
  const pill = el('conn');
  const kind = ['on', 'off', 'wait', 'warn'].includes(state.status.kind) ? state.status.kind : 'wait';
  pill.className = `sync ${kind}${state.monitoring ? '' : ' paused'}`;
  // ⚠️⚠️ 「暂停」时要说清**它到底停了什么**：`enable_monitoring` 在配置里是
  // **上下行的总开关**（`ClientConfig::download_channel` 开头就判它），所以点一下
  // 暂停之后，**下行也一起停了** —— 而文案只写「监听」的话，用户会以为只是不读剪贴板，
  // 然后发现「别人的内容也不来了」。这属于「界面说一套、实际做另一套」。
  // ⚠️★ 胶囊上的字说的是**同步状态**（界面稿里就是「剪贴板同步中」），不是连接状态 ——
  // 两件事：连接由**点的颜色**表达（绿=通、灰=连、红=断、黄=服务端太旧），
  // 而「现在到底同没同步」才是用户点它之前要看的。
  // ⚠️ 但**出问题时要说问题**：连不上还写「同步中」就是在骗人（那是这个项目最忌讳的一类）。
  const text = !state.monitoring
    ? '已暂停（上行与下行都停）'
    : state.status.kind === 'on'
      ? '剪贴板同步中'
      : state.status.text;
  el('conn-text').textContent = text;
  pill.title = state.status.latestId === null || state.status.latestId === undefined
    ? '点击暂停/恢复同步（会同时停掉上行与下行）'
    : `边界 latestId=${state.status.latestId}；点击暂停/恢复同步`;
}

function renderTimeline(state) {
  const host = el('timeline');
  // ⚠️★ 先记「刚才是不是贴在底部」，**再**清空 —— 清空之后 `scrollHeight` 已经是 0，
  // 那时候判会永远算出「贴底」，等于没判。
  //
  // ⚠️ 只有贴底时才自动滚：无条件滚的话，用户往上翻着读历史时，
  // 来一条新消息就把他**拽回底部**。那比「不自动滚」烦得多（「我在看旧的，它一直弹走」）。
  const wasPinned = host.scrollHeight - host.scrollTop - host.clientHeight < 24;
  host.textContent = '';
  const room = state.rooms[state.selected];
  if (!room) {
    host.append(h('div', 'empty', '没有房间。'));
    return;
  }
  if (!state.entries.length) {
    // ⚠️ 「还没加载」与「这个房间确实是空的」**必须**分开说 ——
    // 两种都画成空列表的话，用户会以为功能坏了。
    host.append(h('div', 'empty', room.historyLoaded
      ? '这个房间还没有内容。'
      : '还没加载这个房间的历史。点右上角「刷新」。'));
    return;
  }
  state.entries.forEach((entry) => host.append(renderEntry(entry)));
  // 新的内容在末尾 → 贴底时跟到底（用户刚复制的东西要立刻看见）。
  if (wasPinned) host.scrollTop = host.scrollHeight;
}

/** 整个界面。⚠️ 「有没有房间」也要画出来 —— 半个状态是骗人的。 */
function render(state) {
  lastRooms = state.rooms;
  renderStatus(state);
  el('room-count').textContent = String(state.rooms.length);
  renderRooms(state);
  renderTimeline(state);

  const room = state.rooms[state.selected];
  el('room-name').textContent = room ? room.name : '—';
  // ⚠️ 只留「几条」：房间 id 和服务端地址塞进标题是**噪音**，
  // 而它们都能在「设置」里查到（诊断那一页专门放这些）。
  el('room-meta').textContent = room ? `· ${room.count} 条` : '';

  // ⚠️ 限额是**握手**里下发的（不在 `/server`）。没连上就是「不知道」，
  // 这里要写「还不知道」而不是「0」—— 那会让用户以为「一个字都发不了」。
  el('limits').textContent = state.limits.textLimit
    ? `上限 ${state.limits.textLimit} 字`
    : '上限还不知道（还没连上）';

  // ⚠️★ 本机窗口里**留多少条**要照实说：不说的话，用户看到列表停在 200 条
  // 会以为「前面的丢了」（`store.rs` 的 `MAX_ENTRIES_PER_ROOM` 注释里点名了这条要求）。
  // 这不是历史长度 —— 历史长度是服务端的 `server.history`，两件事别混。
  el('max-entries').textContent = state.maxEntries
    ? `本机最多留最近 ${state.maxEntries} 条`
    : '';

  const problems = el('problems');
  if (state.problems.length) {
    problems.hidden = false;
    problems.textContent = `配置有毛病：${state.problems.join('；')}`;
  } else {
    problems.hidden = true;
  }

  const notice = el('notice');
  if (state.notice) {
    notice.hidden = false;
    notice.className = `notice ${state.notice.kind}`;
    notice.textContent = state.notice.text;
    // ⚠️ 显示过一次就清掉：否则一条三分钟前的错误会一直挂在界面上，
    // 而「它到底还有效吗」用户判断不了。
    invoke('clear_notice');
  } else {
    notice.hidden = true;
  }
}

async function tick() {
  try {
    const state = await invoke('snapshot');
    const shape = shapeOf(state);
    if (shape !== lastShape) {
      lastShape = shape;
      render(state);
    }
  } catch (error) {
    // ⚠️ 取不到状态要把「为什么」说出来：最常见的是窗口比壳活得久（壳崩了/正在退出）。
    // 主界面上没有地方放它（侧栏那块调试信息已删），所以进一次性提示。
    el('notice').hidden = false;
    el('notice').className = 'notice err';
    el('notice').textContent = `取不到状态：${error}`;
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

function sendCurrentInput() {
  const input = el('input');
  const text = input.value;
  if (!text.trim()) return;
  invoke('send_text', { text }).catch((error) => {
    el('notice').hidden = false;
    el('notice').className = 'notice err';
    el('notice').textContent = `发不出去：${error}`;
  });
  input.value = '';
}

el('btn-send').addEventListener('click', sendCurrentInput);
el('btn-refresh').addEventListener('click', () => invoke('refresh'));

el('conn').addEventListener('click', () => {
  // ⚠️ 这里要的是「切换」而不是「按当前状态推断」—— 状态是 700ms 前的，
  // 拿旧状态去取反会来回横跳。
  const paused = el('conn').classList.contains('paused');
  invoke('set_monitoring', { on: paused });
});
el('rooms').addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], .room');
  if (!target) return;
  const index = Number(target.dataset.index);
  if (Number.isNaN(index)) return;
  const room = currentRoom(index);
  if (target.dataset.action === 'upload') {
    invoke('set_upload', { index, on: !room.upload });
  } else if (target.dataset.action === 'download') {
    // ⚠️ 下载是**单选**：点已选中的那个 = 关掉它（而不是「点了没反应」）。
    invoke('set_download', { index: room.download ? null : index });
  } else {
    invoke('select', { index });
  }
});

/** 上一次渲染里的房间视图（没渲染过就是「关着」）。 */
const currentRoom = (index) => lastRooms[index] || { upload: false, download: false };

el('input').addEventListener('keydown', (event) => {
  // ⚠️ 回车发送、Shift+回车换行 —— 多行文本是剪贴板里最常见的内容。
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendCurrentInput();
  }
});

tick();

/* ── 服务端配置（浮层）─────────────────────────────────────────────
 *
 * ⚠️★ 这个界面能改**密码**，所以它走的是 **IPC 命令**，不是服务端的一条 HTTP 路由 ——
 * 没有网络面，本机之外碰不到。§3.5.2 ① 那条硬要求是**由构造保证**的，
 * 不是靠「记得加鉴权」保证的。
 *
 * ⚠️★ 保存 ≠ 生效：服务端的配置**只在启动时读一次**。所以这里必须说清，
 * 并给一个「保存并重启」—— 否则用户会以为「改了没反应是坏了」。
 */

/** 表单里的数字。⚠️ 空/非法时用兜底值，而不是把 `NaN` 传给后端（那会得到一个
 *  连服务端都读不了的配置 —— 而后端会**拒绝保存**，用户看到的是一句看不懂的错）。 */
function numField(id, fallback) {
  const value = Number(el(id).value);
  return Number.isFinite(value) ? value : fallback;
}

/** 表单 → 补丁。
 *  ⚠️ 只放**认识的**那几个键；其余键由后端**原样保留**（它是打补丁，不是整体替换）。
 *  ⚠️ `roomAuth` **不在这里**：它是一张嵌套表，还没做进表单（面板上写了这件事）。
 *  漏掉它不会把它清掉 —— 补丁是深合并，没提到的键原样留着。 */
function serverPatch() {
  const auth = el('cfg-auth').value.trim();
  return {
    server: {
      // ⚠️ `host` 服务端那边收**字符串或数组**（`["0.0.0.0"]` 也合法）。
      // 表单给字符串，服务端自己认 —— 别在这里替它拼数组。
      host: el('cfg-host').value.trim() || '0.0.0.0',
      port: numField('cfg-port', 9501),
      prefix: el('cfg-prefix').value.trim(),
      // ⚠️ 空 = **不设密码**。服务端那边的 `auth` 是「false 或字符串」，
      // 给一个空串会被当成「设了一个空密码」—— 那是另一件事。
      auth: auth === '' ? false : auth,
      cert: el('cfg-cert').value.trim(),
      key: el('cfg-key').value.trim(),
      history: numField('cfg-history', 50),
      roomCleanup: numField('cfg-cleanup', 3600),
      roomList: el('cfg-roomlist').checked,
      dbPath: el('cfg-dbpath').value.trim() || 'clip9.redb',
      storageDir: el('cfg-storage').value.trim() || 'uploads',
      roomAuth: roomAuthPatch(),
    },
    text: { limit: numField('cfg-textlimit', 4096) },
    file: {
      expire: numField('cfg-fileexpire', 3600),
      chunk: numField('cfg-filechunk', 1048576),
      limit: numField('cfg-filelimit', 268435456),
    },
    automation: {
      enabled: el('cfg-automation').checked,
      tickSeconds: numField('cfg-tick', 30),
      graceSeconds: numField('cfg-grace', 600),
      defaultTZ: el('cfg-tz').value.trim() || 'Asia/Shanghai',
    },
  };
}

async function refreshServerState() {
  // ⚠️ 在不在跑是**问出来的**（壳真的去打了一条 `GET /server`），不是壳记着的。
  // 记着的那个在「进程被杀」「用户手动起了一个」时就是错的。
  const running = await invoke('server_running');
  const line = running
    ? '本地服务端：运行中'
    : '本地服务端：没在跑（改完配置点「保存并重启」会把它起来）';
  el('server-state').textContent = line;
  // 设置窗口里那一页也刷 —— 同一个「问出来的」状态，两处显示同一件事。
  if (el('srv-state')) {
    el('srv-state').textContent = running ? '运行中' : '没在跑';
  }
}

// ── 本地服务端那一页（设置 → 本机）───────────────────────────────
//
// ⚠️ 这里的动作和后端的能力是**一一对应**的：状态是问出来的、重启只碰自己起的那个
//（`server_process::stop` 的文档里写着为什么）。界面上不编任何「大概在跑」的话。
el('srv-restart').addEventListener('click', async () => {
  el('srv-state').textContent = '正在重启…';
  try {
    await invoke('server_restart');
  } catch (error) {
    // ⚠️ 失败要留在界面上：重启失败而界面写着「运行中」，用户会以为好了。
    el('srv-state').textContent = `重启失败：${error}`;
    return;
  }
  await refreshServerState();
});
el('srv-open').addEventListener('click', () => {
  invoke('open_web').catch((error) => {
    el('srv-state').textContent = `打不开网页版：${error}`;
  });
});

async function openServerPanel() {
  el('server-msg').textContent = '';
  el('server-overlay').hidden = false;
  try {
    const view = await invoke('server_config');
    // ⚠️ 路径也要显示：用户要能自己去开那个文件 ——
    // 「这个界面改的是哪个文件」是他判断「改了没生效」的第一条线索。
    el('server-path').textContent = view.path;
    const server = view.value.server || {};
    const text = view.value.text || {};
    const file = view.value.file || {};
    const automation = view.value.automation || {};
    // ⚠️ `host` 服务端可能给数组（`["0.0.0.0"]`）—— 表单只显示一个字符串，
    // 数组就取第一个（保存时给回字符串，服务端两种都收）。
    const host = Array.isArray(server.host) ? (server.host[0] ?? '') : (server.host ?? '');
    // ⚠️ `roomAuth` 三种形态都认（见文件末尾那段注释）—— 只认对象会显示成空、一保存就清密码。
    const auth = view.value.server?.roomAuth || {};
    roomAuthDraft = {};
    roomAuthOriginal = Object.keys(auth);
    for (const [room, entry] of Object.entries(auth)) {
      roomAuthDraft[room] = typeof entry === 'string'
        ? { password: entry, fileExpire: '', automation: '', open: false }
        : {
            password: entry?.password ?? '',
            fileExpire: entry?.fileExpire ?? '',
            automation: entry?.automation ?? '',
            // ⚠️ 必须记住它：裸字符串换成对象时丢了它，开放房间会静默变上锁。
            open: entry?.open === true,
          };
    }
    renderRoomAuthRows();
    el('cfg-host').value = host;
    el('cfg-port').value = server.port ?? 9501;
    el('cfg-prefix').value = server.prefix ?? '';
    el('cfg-auth').value = typeof server.auth === 'string' ? server.auth : '';
    el('cfg-cert').value = server.cert ?? '';
    el('cfg-key').value = server.key ?? '';
    el('cfg-history').value = server.history ?? 50;
    el('cfg-cleanup').value = server.roomCleanup ?? 3600;
    el('cfg-roomlist').checked = server.roomList === true;
    el('cfg-dbpath').value = server.dbPath ?? 'clip9.redb';
    el('cfg-storage').value = server.storageDir ?? 'uploads';
    el('cfg-textlimit').value = text.limit ?? 4096;
    el('cfg-fileexpire').value = file.expire ?? 3600;
    el('cfg-filechunk').value = file.chunk ?? 1048576;
    el('cfg-filelimit').value = file.limit ?? 268435456;
    el('cfg-automation').checked = automation.enabled === true;
    el('cfg-tick').value = automation.tickSeconds ?? 30;
    el('cfg-grace').value = automation.graceSeconds ?? 600;
    el('cfg-tz').value = automation.defaultTZ ?? 'Asia/Shanghai';
  } catch (error) {
    el('server-msg').textContent = `读不到配置：${error}`;
  }
  await refreshServerState();
}

el('cfg-close').addEventListener('click', () => {
  el('server-overlay').hidden = true;
});

el('cfg-save').addEventListener('click', async () => {
  try {
    await invoke('server_config_save', { patch: serverPatch() });
    el('server-msg').textContent = '已保存 —— 重启服务端后生效';
  } catch (error) {
    el('server-msg').textContent = `没保存：${error}`;
  }
});

el('cfg-save-restart').addEventListener('click', async () => {
  try {
    await invoke('server_config_save', { patch: serverPatch() });
  } catch (error) {
    // ⚠️ 没保存成功就**别重启** —— 拿一份没生效的配置去重启，只会让用户更糊涂。
    el('server-msg').textContent = `没保存：${error}`;
    return;
  }
  el('server-msg').textContent = '正在重启…';
  try {
    await invoke('server_restart');
    el('server-msg').textContent = '已保存并重启';
  } catch (error) {
    // ⚠️ 说清是「保存成功了、重启失败」—— 这两种的下一步完全不同。
    el('server-msg').textContent = `保存了，但重启失败：${error}`;
  }
  await refreshServerState();
});

/* ── 设置窗口 ────────────────────────────────────────────────────────
 *
 * ⚠️★ 房间清单是**草稿**：用户在表单里改到一半时，壳里的配置**不该**变 ——
 * 他还没点保存。所以这里维护一份 `roomDraft`，点「保存」才发出去。
 * 界面上也因此要**说清**「改了要点保存」（保存按钮 + 保存后的提示）。
 *
 * ⚠️ 房间字段名是 `Channel` 自己的（`name` / `server` / `room` / `auth_token`）——
 * 直接用它的形状，而不是再包一层镜像（少一份会漂的定义）。
 */

let roomDraft = [];

/** 一个单元格里的文本框。⚠️ 用 `input` 事件更新草稿，不重渲染 ——
 *  每次重渲染都把 `value` 重设会把用户正在输入的光标顶掉。 */
function cellInput(value, onChange, placeholder) {
  const td = h('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));
  td.append(input);
  return td;
}

/** 一个方向开关（表格里的 ↑ / ↓）。 */
function cellDir(on, kind, title, onToggle) {
  const td = h('td', 'tiny');
  const box = h('span', on ? `dir ${kind} on` : `dir ${kind}`, kind === 'up' ? '↑' : '↓');
  box.title = title;
  box.addEventListener('click', () => onToggle(!on));
  td.append(box);
  return td;
}

function renderRoomRows() {
  const body = el('rooms-body');
  body.textContent = '';
  if (!roomDraft.length) {
    const tr = h('tr');
    const td = h('td', 'sub', '还没有房间。点下面的「添加房间」—— 服务端留空就是本机那个。');
    td.colSpan = 7;
    tr.append(td);
    body.append(tr);
    return;
  }
  roomDraft.forEach((room, index) => {
    const tr = h('tr');
    tr.append(cellInput(room.name, (v) => { roomDraft[index].name = v; }));
    tr.append(cellInput(room.server, (v) => { roomDraft[index].server = v; }, 'http://127.0.0.1:9502'));
    tr.append(cellInput(room.room, (v) => { roomDraft[index].room = v; }, 'default'));
    tr.append(cellInput(room.auth_token, (v) => { roomDraft[index].auth_token = v; }, '（空 = 无密码）'));
    // ⚠️ ↓ 是**全局单选**：点开一个，别的自动关掉。做成多选再靠后端「取第一个」
    // 的话，用户点第二个会**没反应** —— 那正是「配了不生效」。
    tr.append(cellDir(room.enable_upload !== false, 'up', '↑ 发到房间：本机剪贴板发到它（可多选）', (on) => {
      roomDraft[index].enable_upload = on;
      renderRoomRows();
    }));
    tr.append(cellDir(room.enable_download === true, 'dn', '↓ 收进剪贴板：这个房间的内容写进本机剪贴板（全局只能一个）', (on) => {
      roomDraft.forEach((other, position) => { other.enable_download = on && position === index; });
      renderRoomRows();
    }));
    const del = h('td', 'tiny');
    const button = h('button', 'btn', '删');
    button.style.padding = '2px 7px';
    button.addEventListener('click', () => {
      roomDraft.splice(index, 1);
      renderRoomRows();
    });
    del.append(button);
    tr.append(del);
    body.append(tr);
  });
}

async function refreshLog() {
  try {
    const view = await invoke('server_log');
    el('log-path').textContent = view.path;
    const text = (view.text || '').trim();
    el('log-text').textContent = text || '（还没有日志 —— 服务端起来之后才会有）';
    el('log-state').textContent = text ? '' : '';
  } catch (error) {
    el('log-text').textContent = `读日志失败：${error}`;
  }
}

function showPane(name) {
  for (const item of el('settings-nav').querySelectorAll('.it')) {
    item.classList.toggle('on', item.dataset.pane === name);
  }
  for (const pane of el('settings-overlay').querySelectorAll('.pane')) {
    pane.hidden = pane.id !== `pane-${name}`;
  }
}

async function openSettings() {
  el('settings-msg').textContent = '';
  el('settings-overlay').hidden = false;
  showPane('rooms');
  try {
    const view = await invoke('settings_view');
    // ⚠️ 深拷贝一份草稿：`view` 是 IPC 回来的对象，改它不会影响壳，
    // 但「草稿」这个概念要在代码里看得出来（下面保存时才发出去）。
    roomDraft = view.rooms.map((room) => ({ ...room }));
    renderRoomRows();
    el('sc-text').checked = view.enableText;
    el('sc-file').checked = view.enableFile;
    el('sc-text-dl').checked = view.enableTextDownload;
    el('sc-file-dl').checked = view.enableFileDownload;
    el('sc-poll').value = view.pollIntervalMs;
    el('sc-dir').value = view.downloadDir;
    // ⚠️ 自启那个勾画的是**系统里的真相**（壳去问的系统），不是配置里的意图。
    el('sc-autostart').checked = view.autostart;
    el('dg-data').textContent = view.dataDir;
    el('dg-config').textContent = view.configPath;
    el('dg-server').textContent = view.serverRunning ? '运行中' : '没在跑';
    if (el('srv-data')) el('srv-data').textContent = view.dataDir;
    if (el('srv-state')) el('srv-state').textContent = view.serverRunning ? '运行中' : '没在跑';
  } catch (error) {
    el('settings-msg').textContent = `读不到设置：${error}`;
  }
}

el('btn-settings').addEventListener('click', openSettings);
el('settings-close').addEventListener('click', () => {
  el('settings-overlay').hidden = true;
});
el('settings-nav').addEventListener('click', (event) => {
  const item = event.target.closest('.it');
  if (!item) return;
  // ⚠️ 有的项是**动作**不是页（`data-open`）：它打开另一个浮层，而不是切页。
  // 先关掉设置窗口 —— 两个浮层叠在一起，用户分不清在改哪个。
  if (item.dataset.open) {
    el('settings-overlay').hidden = true;
    openServerPanel();
    return;
  }
  showPane(item.dataset.pane);
  // ⚠️ 日志只在**切到那一页**时读一次：它可能很大，打开设置就读是白读。
  if (item.dataset.pane === 'log') refreshLog();
});
el('room-add').addEventListener('click', () => {
  // ⚠️ 服务端留空**不是**省事：空地址会被 `ClientConfig::problems()` 报出来，
  // 而界面会显示那条问题 —— 比悄悄填一个「大概是这个」强。
  roomDraft.push({ name: '', server: '', room: 'default', auth_token: '', enable_upload: true, enable_download: false });
  renderRoomRows();
});

el('settings-save').addEventListener('click', async () => {
  const patch = {
    rooms: roomDraft.map((room) => ({
      name: room.name || room.room || '房间',
      server: room.server.trim(),
      room: (room.room || 'default').trim(),
      auth_token: (room.auth_token || '').trim() || null,
      enable_upload: room.enable_upload !== false,
      enable_download: room.enable_download === true,
    })),
    sync: {
      enableText: el('sc-text').checked,
      enableFile: el('sc-file').checked,
      enableTextDownload: el('sc-text-dl').checked,
      enableFileDownload: el('sc-file-dl').checked,
      pollIntervalMs: Number(el('sc-poll').value) || 500,
      downloadDir: el('sc-dir').value.trim() || 'downloads',
    },
    autostart: el('sc-autostart').checked,
  };
  try {
    await invoke('apply_settings', { patch });
    el('settings-msg').textContent = '已保存';
  } catch (error) {
    // ⚠️ 失败要**留在界面上**：设置没存上而界面看着像存了，用户下次启动会发现白改。
    el('settings-msg').textContent = `没保存：${error}`;
  }
});

/* ── 逐房间凭据（roomAuth）─────────────────────────────────────────
 *
 * ⚠️★ 它有三种历史形态，读的时候**都要认**：
 *   `"work": "密码"`（裸字符串，最常见）/ `{password, fileExpire, open, automation}` / `{}`。
 *   只认对象的话，用裸字符串写的房间在界面上**显示成空**，一保存就把密码清了。
 *
 * ⚠️★ 保存时要**带上 `open`**：裸字符串形态被替换成对象时，`open` 会丢，
 *   而它默认 `false` —— 于是一个**开放房间会静默变成上锁**。
 *   界面上不编辑它（只显示状态），但必须原样带回去。
 *
 * ⚠️ 档位的真实取值是 `""`（跟随）/ `none` / `single` / `room`。
 *   界面稿里写的 `admin` **不存在** —— 照它写会得到一个服务端读不了的配置。
 */

let roomAuthDraft = {};
let roomAuthOriginal = [];

function renderRoomAuthRows() {
  const body = el('roomauth-body');
  body.textContent = '';
  const rooms = Object.keys(roomAuthDraft);
  if (!rooms.length) {
    const tr = h('tr');
    const td = h('td', 'sub', '没有逐房间的凭据 —— 所有房间都用上面的全局密码（或都不需要密码）。');
    td.colSpan = 6;
    tr.append(td);
    body.append(tr);
    return;
  }
  rooms.forEach((room) => {
    const entry = roomAuthDraft[room];
    const tr = h('tr');
    tr.append(cellInput(room, (v) => {
      // ⚠️ 改房间名 = 换一个键：把内容搬到新键上，旧键删掉。
      if (v === room) return;
      roomAuthDraft[v] = roomAuthDraft[room];
      delete roomAuthDraft[room];
      renderRoomAuthRows();
    }, 'work'));
    tr.append(cellInput(entry.password, (v) => { entry.password = v; }, '（空 = 无密码）'));
    // ⚠️ 「留空 = 不改」：这个键在配置里可以缺省，而清空它会让服务端解析失败。
    tr.append(cellInput(entry.fileExpire, (v) => { entry.fileExpire = v; }, '（留空 = 不改）'));
    tr.append(cellInput(entry.automation, (v) => { entry.automation = v; }, '（留空 = 跟随）'));
    const state = h('td', 'tiny');
    state.append(h('span', entry.open ? 'pill ok' : 'pill', entry.open ? '开放' : '要密码'));
    tr.append(state);
    const del = h('td', 'tiny');
    const button = h('button', 'btn', '删');
    button.style.padding = '2px 7px';
    button.addEventListener('click', () => {
      delete roomAuthDraft[room];
      renderRoomAuthRows();
    });
    del.append(button);
    tr.append(del);
    body.append(tr);
  });
}

el('roomauth-add').addEventListener('click', () => {
  // 用一个不会撞上已有键的名字（空名字会被服务端归一化成 default，更糟）。
  let name = '新房间';
  let n = 2;
  while (name in roomAuthDraft) name = `新房间${n++}`;
  roomAuthDraft[name] = { password: '', fileExpire: '', automation: '', open: false };
  renderRoomAuthRows();
});

/** 草稿 → 补丁。⚠️ 删掉的房间发 `null`（后端的深合并按 RFC 7396 删键）。 */
function roomAuthPatch() {
  const patch = {};
  for (const [room, entry] of Object.entries(roomAuthDraft)) {
    const one = { password: entry.password, automation: entry.automation, open: entry.open === true };
    // ⚠️ 只有**填了**才带 `fileExpire`：留空 = 不改（见上面那段注释）。
    if (String(entry.fileExpire).trim() !== '') one.fileExpire = Number(entry.fileExpire);
    patch[room] = one;
  }
  for (const room of roomAuthOriginal) {
    if (!(room in roomAuthDraft)) patch[room] = null;
  }
  return patch;
}

el('log-refresh').addEventListener('click', refreshLog);
