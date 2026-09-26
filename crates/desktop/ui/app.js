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
    up.title = room.upload ? '本机剪贴板要发到这个房间（点击关掉）' : '不发到这个房间（点击打开）';
    up.dataset.action = 'upload';
    up.dataset.index = String(index);
    const down = h('span', room.download ? 'dir dn on' : 'dir dn', '↓');
    down.title = '同步到本机剪贴板（全局只能一个房间）';
    down.dataset.action = 'download';
    down.dataset.index = String(index);
    node.append(up, down, h('span', 'ct', String(room.count)));
    node.dataset.index = String(index);
    host.append(node);
  });
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
  el('conn-text').textContent = state.monitoring
    ? state.status.text
    : '已暂停（上行与下行都停）';
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
  el('room-meta').textContent = room
    ? `· ${room.count} 条 · ${room.room} @ ${room.server}`
    : '';

  // ⚠️ 限额是**握手**里下发的（不在 `/server`）。没连上就是「不知道」，
  // 这里要写「还不知道」而不是「0」—— 那会让用户以为「一个字都发不了」。
  el('limits').textContent = state.limits.textLimit
    ? `上限 ${state.limits.textLimit} 字`
    : '上限还不知道（还没连上）';

  el('diag').textContent = `${state.dataDir}\n配置：${state.configPath}`;

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
    el('diag').textContent = `取不到状态：${error}`;
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
el('btn-web').addEventListener('click', () => {
  invoke('open_web').catch((error) => {
    el('notice').hidden = false;
    el('notice').className = 'notice err';
    el('notice').textContent = `打不开网页版：${error}`;
  });
});
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
