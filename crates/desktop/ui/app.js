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

/** 上一次渲染的**限额**（握手下发的那一份）。只给输入区右下角那个计数器用。 */
let lastLimits = { textLimit: 0, fileLimit: 0 };

/** 上一次渲染的**条目**（右键菜单要靠它从卡片的下标找回那一条）。
 *
 * ⚠️ 不复用 `lastShape`（那是个 JSON 字符串）：为了读一条正文去解析整屏条目
 * 是白费，而且 `shapeOf` 那份清单随时可能加减字段 —— 菜单不该被那个牵连。
 */
let lastEntries = [];

const el = (id) => document.getElementById(id);

/** 一个方框开关（稿子里的 `<span class="sq">`）。
 *
 * ⚠️★ 为什么**不用** `<input type="checkbox">`：界面稿画的就是这个方块
 *（稿 2 的 `.sq`）。换成本机复选框在 macOS 上是一颗蓝色胶囊，跟稿子不是一个东西 ——
 * 而这一版的目标就是「1:1 还原稿子」（`desktop-client.md` §3.6.1）。
 * ⚠️ 代价：它不是原生控件，**没有键盘可达性、也不进 tab 序**。这是明确换来的取舍，
 * 不是漏掉的（要补的话得自己做 `tabindex` + 空格/回车，见 §3.6.1 的待办）。
 */
const sqGet = (id) => el(id).classList.contains('on');

function sqSet(id, on) {
  el(id).classList.toggle('on', on === true);
  el(id).textContent = on === true ? '✓' : '';
}

// 让方块能点。⚠️ 用**委托**而不是逐个绑：`#cfg-*` 那批在浮层里，
// 逐个绑的话每次打开浮层都要重绑一遍，漏一个就是「点了没反应」。
for (const id of ['settings-overlay', 'server-overlay']) {
  el(id).addEventListener('click', (event) => {
    const box = event.target.closest('.sq');
    if (!box?.id) return;
    sqSet(box.id, !sqGet(box.id));
  });
}

/** 主界面顶部那条**一次性**提示（发不出去 / 存不上 / 配置有毛病）。
 *
 * ⚠️ 抽出来是因为同一段三行已经抄了三四遍 —— 而抄的时候最容易漏掉
 * `hidden = false`（漏了的症状是「设了文字但看不见」，而且不报错）。
 *
 * ⚠️★ **自己设的提示要自己收**：`render` 里那条清理走的是「壳里有没有 notice」
 *（`invoke('clear_notice')`），而这里设的那些**壳里没有** —— 于是它们只会在
 * 「下一次形状变化」时才被抹掉，而那可能是几分钟后。
 * 15 秒：够看清、够去点一下，又不至于一直挂着（「它到底还有效吗」用户判断不了，
 * 这与 `render` 里那条注释是同一个理由）。
 */
let noticeTimer = null;

function showNotice(kind, text) {
  const notice = el('notice');
  notice.hidden = false;
  notice.className = `notice ${kind}`;
  notice.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 15000);
}

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
    // ⚠️★ 设备、延迟、连接状态都挂在 `state.rooms` 上了（§4.7：每个房间各自一条连接），
    // 所以上面那个 `state.rooms` 已经覆盖了它们 —— **不要再单独列一遍**
    //（列了也不会错，只是会让人以为顶层还有 `devices` / `latency` 这两个字段）。
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

/** 一张卡片。`index` 是它在**这一屏**里的位置（右键菜单要靠它找回这条）。 */
function renderEntry(entry, index) {
  const card = h('div', entry.mine ? 'card me' : 'card');
  // ⚠️★ 只存**下标**，不把条目内容塞进 DOM：内容会随重画换掉，而下标
  // 每次都跟着 `lastEntries` 一起更新（见 `openEntryMenu`）。
  // ⚠️ 也**不存 id**：切房间之后同一个 id 可能属于另一个房间的条目。
  card.dataset.index = String(index);

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

/** 那个延迟胶囊（§4.3）。三种取值**分开画**。 */
function renderLatency(latency) {
  const kind = latency?.kind ?? 'unknown';
  if (kind === 'rtt') {
    const node = h('span', 'ms', `${latency.ms}ms`);
    node.title = '这条连接的往返延迟（最近几次的中位数）。⚠️ 只量得到正在收的那个房间。';
    return node;
  }
  // ⚠️★ 超时**必须说出来**（§4.3 第 4 条）：画一个 `9999ms` 看起来只是「慢」，
  // 而真相是这条连接其实已经坏了、客户端正在重连。不说的话用户只会觉得界面坏了。
  if (kind === 'timeout') {
    const node = h('span', 'ms warn', '超时');
    node.title = 'ping 没有回来：这条连接其实已经坏了，客户端会自己重连。';
    return node;
  }
  // ⚠️ 刚连上还没测到 —— 画 `—` 而不是不画：这个房间**是**在量的，
  // 「正在量但还没有数字」和「这个房间量不到」是两件事。
  const node = h('span', 'ms', '—');
  node.title = '还没测到延迟（刚连上，第一次 ping 还没回来）。';
  return node;
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
    // ⚠️ 图标只分「选中的那个」和「别的」两种：稿 1 里每个房间的图标都不同
    //（🏠 / 💼 / 🔒），但那是**照着演示用的房间名画的** —— 真实房间名是自由文本，
    // 按名字猜图标只会猜错。🔒 那条尤其不能猜：客户端这边**拿不到**
    //「这个房间要不要密码」（凭据在 `Channel::auth_token` 里，界面不读它）。
    node.append(h('span', 'ico', index === state.selected ? '🏠' : '💬'));
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
    // ⚠️★ 延迟**每个房间都画**（Jonny 2026-09-26：「每个在连接状态的都要显示延迟」）——
    // 每个房间各自有一条连接（§4.7），所以每个房间都量得到自己那个数。
    // ⚠️ 还没连上时画 `—`（**不是**不画）：这个房间是在量的，
    //「正在量但还没有数字」和「这个房间量不到」是两件事。
    node.append(renderLatency(room.connection?.latency));
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

/** 标题栏那个状态点。
 *
 * ⚠️★ 圆点画的是**当前选中那个房间**的连接状态 —— 每个房间各自有一条连接（§4.7），
 * 已经没有一个「全局连接」可画了。主区显示的也是这个房间，两者对得上。
 * ⚠️ 胶囊上的**字**说的是**剪贴板监听**（点它就是切这个），而且必须照实说：
 * 上传默认是关的，所以「剪贴板同步中」在没开 ↑ 的时候是**假话** ——
 * 那时本机剪贴板一个字节都不会发出去。
 */
function renderStatus(state) {
  const pill = el('conn');
  const room = state.rooms[state.selected];
  const connection = room?.connection ?? { kind: 'off', text: '还没有房间' };
  const kind = ['on', 'off', 'wait', 'warn'].includes(connection.kind) ? connection.kind : 'wait';
  pill.className = `sync ${kind}${state.monitoring ? '' : ' paused'}`;

  // ⚠️ 「有没有东西真的在发」= 至少一个房间开着 ↑ **且**总开关没关。
  // 两者缺一，「同步中」都是假话。
  const sending = state.monitoring && state.rooms.some((one) => one.upload);
  el('conn-text').textContent = !state.monitoring
    ? '已暂停：不发你的剪贴板'
    : sending
      ? '剪贴板同步中'
      : '没开「发到房间」';

  const name = room ? room.name : '没有房间';
  const boundary =
    connection.latestId === null || connection.latestId === undefined
      ? ''
      : `｜边界 latestId=${connection.latestId}`;
  pill.title =
    `${name}：${connection.text}${boundary}` +
    `\n点击${state.monitoring ? '暂停' : '恢复'} —— 只影响**上行**（要不要读本机剪贴板），` +
    '不影响连接、接收与延迟。';
}

function renderTimeline(state) {
  // ⚠️ 先记下来，**不管后面走哪条提前返回**：右键菜单读的是它，
  // 而「空列表」时它必须是**空数组**（否则菜单会拿到上一个房间的条目）。
  lastEntries = state.entries;
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
    // ⚠️ 「还没加载」那句**不能**再说「点右上角刷新」：那个按钮按界面稿删掉了
    //（历史是自动取的，见 `ensureHistory`），留着就是指向一个不存在的东西。
    host.append(h('div', 'empty', room.historyLoaded
      ? '这个房间还没有内容。'
      : '正在取这个房间的历史…（取不到会每 5 秒重试一次）'));
    return;
  }
  state.entries.forEach((entry, index) => host.append(renderEntry(entry, index)));
  // 新的内容在末尾 → 贴底时跟到底（用户刚复制的东西要立刻看见）。
  if (wasPinned) host.scrollTop = host.scrollHeight;
}

/** 输入区右下角那个计数（稿 1 画的是 `0 / 4096`）。
 *
 * ⚠️ 上限是**握手**里下发的（不在 `/server`）。没连上就是「不知道」，
 * 这时要写「还不知道」而不是 `0 / 0` —— 后者会让用户以为「一个字都发不了」。
 * ⚠️ 用 `[...value].length` 而不是 `value.length`：后者数的是 UTF-16 码元，
 * 一个 emoji 会算成 2，而服务端那边按**字节**判限额 —— 两个数都不是精确的，
 * 但按「肉眼可见的字符」数最贴近用户心里的那个数，也最不容易吓到他。
 */
function updateCounter() {
  const limit = lastLimits.textLimit;
  el('limits').textContent = limit
    ? `${[...el('input').value].length} / ${limit}`
    : '上限还不知道（还没连上）';
}

/** 主区标题右侧的设备行（稿 1 有：几个圆圈 + 「N 台在线」）。
 *
 * ⚠️★ 画的是**当前选中那个房间**的设备 —— 每个房间各自有一条连接（§4.7），
 * 所以每个房间都有自己的设备列表（`rooms[i].connection.devices`）。
 *
 * ⚠️ 拿不到时**什么都不画**，而不是画「0 台在线」：
 *「一台都没有」和「还不知道」是两件事，混起来就是骗人。
 */
function renderDevices(state) {
  const host = el('devices');
  host.textContent = '';
  const devices = state.rooms[state.selected]?.connection?.devices || [];
  if (!devices.length) return;
  for (const device of devices) {
    // ⚠️ 图标按服务端认出来的 `kind` 选（`user_agent.rs` 的 desktop/smartphone/tablet），
    // **不靠设备名猜** —— 名字是用户自己起的自由文本，猜出来的图标会乱。
    // ⚠️ 没有平板专用的 emoji，平板与手机同用一个 📱（这是有意的，不是漏了）。
    const icon = device.kind === 'smartphone' || device.kind === 'tablet' ? '📱' : '💻';
    const dot = h('span', device.me ? 'd me' : 'd', icon);
    // ⚠️ 名字可能是**空的**（客户端没声明过设备名）—— 那时要说「本机」/「未知设备」，
    // 而不是留一个空 title（鼠标停上去什么都没有 = 看着像坏了）。
    dot.title = device.me
      ? (device.name ? `${device.name}（本机）` : '本机')
      : (device.name || '未知设备');
    host.append(dot);
  }
  host.append(h('span', null, `${devices.length} 台在线`));
}

/** 整个界面。⚠️ 「有没有房间」也要画出来 —— 半个状态是骗人的。 */
function render(state) {
  lastRooms = state.rooms;
  lastLimits = state.limits;
  renderStatus(state);
  el('room-count').textContent = String(state.rooms.length);
  renderRooms(state);
  renderTimeline(state);
  renderDevices(state);
  updateCounter();

  const room = state.rooms[state.selected];
  el('room-name').textContent = room ? room.name : '—';
  // ⚠️ 只留「几条」：房间 id 和服务端地址塞进标题是**噪音**，
  // 而它们都能在「设置」里查到（诊断那一页专门放这些）。
  el('room-meta').textContent = room ? `· ${room.count} 条` : '';

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
    // ⚠️ 取历史是**每一轮**都要判的，不能放在 `render` 里 ——
    // `render` 只在「形状变了」时跑，而「取不到历史」恰恰**什么都不改**
    //（这正是这个文件开头那段注释说的那类坑）。放这里，失败才追得下去。
    ensureHistory(state);
    const shape = shapeOf(state);
    if (shape !== lastShape) {
      lastShape = shape;
      render(state);
    }
  } catch (error) {
    // ⚠️ 取不到状态要把「为什么」说出来：最常见的是窗口比壳活得久（壳崩了/正在退出）。
    // 主界面上没有地方放它（侧栏那块调试信息已删），所以进一次性提示。
    showNotice('err', `取不到状态：${error}`);
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

function sendCurrentInput() {
  const input = el('input');
  const text = input.value;
  if (!text.trim()) return;
  invoke('send_text', { text }).catch((error) => showNotice('err', `发不出去：${error}`));
  input.value = '';
}

/* ── 从界面发文件：📎 / 🖼 / 拖进来 ──────────────────────────────────
 *
 * ⚠️★ 三条路（按钮 / 拖放 / 将来可能加的别的）**必须汇到同一条命令**
 *（`send_files`）—— 它们只是「怎么选到文件」不同，「怎么发出去」是同一件事。
 * 分开写一定会漂（比如只有按钮那条做了校验）。
 *
 * ⚠️★ 页面**不自己发请求**：走壳的命令，限额/凭据/多文件那些规则全在
 * `clip9-client` 里（`runtime.rs` 的 `send_files` 注释）。
 *
 * ⚠️ 「粘贴即发送」**没有做**，而且不是漏了：粘进来的东西是**系统剪贴板**里的内容，
 * 而本机的剪贴板监听（`clip9-client` 的 watcher）**已经在发它了** ——
 * 再加一条粘贴路径就是「同一份内容发两遍」，靠去重兜住而已。
 * 更关键的是 webview 里拿不到粘贴文件的**真实路径**（`File` 对象没有路径），
 * 所以那条路本来也走不通。
 */

/** 把一批路径交给壳去发。⚠️ 空数组**什么都不做**：那是用户按了「取消」。 */
function sendFiles(paths) {
  const list = (paths || []).filter((path) => typeof path === 'string' && path.trim() !== '');
  if (!list.length) return;
  invoke('send_files', { paths: list }).catch((error) => showNotice('err', `发不出去：${error}`));
}

/** 📎 / 🖼：让**壳**弹系统文件选择框（页面自己没有这个能力，见 `commands::pick_files`）。 */
async function pickAndSend(imagesOnly) {
  try {
    sendFiles(await invoke('pick_files', { imagesOnly }));
  } catch (error) {
    showNotice('err', `打不开文件选择框：${error}`);
  }
}

el('btn-send').addEventListener('click', sendCurrentInput);
el('btn-attach').addEventListener('click', () => pickAndSend(false));
el('btn-image').addEventListener('click', () => pickAndSend(true));
el('input').addEventListener('input', updateCounter);
// ⚠️ 这一行是按界面稿写的（稿 1 的输入区左边那个 `.lim`）。
// 说的是**本界面的**动作，不是稿子里的「粘贴即发送」—— 那个为什么不做，见上面那段。
el('composer-hint').textContent = '回车发送 · Shift+回车换行';

// 把文件**拖进窗口**。
// ⚠️★ 用 Tauri 的 webview 拖放事件，**不是** HTML5 的 `dragover` / `drop`：
// webview 默认把文件拖放交给系统，HTML5 那条路拿到的是一个 `File` 对象，
// 而它**读不出真实路径**（只能拿到字节）—— 那就得把整份内容再过一次 IPC，
// 而壳那边的上行本来就是按路径读文件的。
// ⚠️ 只在 `drop` 那一拍发：`over` 会在鼠标每移动一下都来一次。
{
  const webview = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
  if (webview?.onDragDropEvent) {
    webview.onDragDropEvent((event) => {
      if (event?.payload?.type === 'drop') sendFiles(event.payload.paths);
    });
  }
}

/* ── 时间线的右键菜单（§4.4）────────────────────────────────────────
 *
 * ⚠️★ 第一版**只放真能做的事**（设计稿 §4.4 的原话：
 *「一条菜单里放一堆点了没反应的东西，比没有菜单更坏」）。所以：
 * - ✅ 复制内容 —— 走壳的 `copy_to_clipboard`（页面碰不到系统剪贴板）；
 * - ✅ 复制链接 —— **只有文件条目**才有，给的是本地拼的 `/file/<uuid>/<name>`；
 * - ❌ **删除** —— 要服务端的 `/revoke`，而客户端**还没有**这个能力 → 不做；
 * - ❌ 编辑 / 收藏 / 置顶 —— 那是**网页版**的功能，桌面端是紧凑界面（§3.6）。
 *
 * ⚠️ 菜单是**自己画的 HTML**，不是系统原生菜单：这份界面其余部分都是手写的，
 * 混一个原生菜单进来就是两种视觉，而且它的样子我们控制不了。
 */

let menuNode = null;

function closeMenu() {
  menuNode?.remove();
  menuNode = null;
}

// 关菜单的三个触发：点别处、按 Esc、窗口失焦。
// ⚠️ 三条都要 —— 少一条就会留下一个「关不掉」的浮层。
document.addEventListener('mousedown', (event) => {
  if (menuNode && !menuNode.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);

/** 在鼠标位置弹一个菜单。 */
function openEntryMenu(entry, x, y) {
  closeMenu();
  const menu = h('div', 'ctxmenu');

  const copyText = h('div', 'mi');
  copyText.append(h('span', null, '📋'), h('span', null, '复制内容'));
  copyText.addEventListener('click', () => {
    closeMenu();
    // ⚠️ 文件条目**没有正文**，能复制的是**文件名**（§4.4 表格里写着这一条）。
    const text = entry.kind === 'file' ? entry.fileName : entry.text;
    if (!text) {
      showNotice('skip', '这条没有可复制的内容。');
      return;
    }
    invoke('copy_to_clipboard', { text }).catch((error) => showNotice('err', `复制失败：${error}`));
  });
  menu.append(copyText);

  // ⚠️ 只有文件条目才有链接。文本条目**不画**这一项 —— 画一个点了没反应的项
  // 比没有这一项更坏（§4.4 的原则）。
  if (entry.kind === 'file' && entry.previewUrl) {
    const copyLink = h('div', 'mi');
    copyLink.append(h('span', null, '🔗'), h('span', null, '复制链接'));
    // ⚠️★ 这条地址**不带凭据**（凭据只走请求头，见 `endpoint.rs` 那段）——
    // 有密码的房间拿这条链接是**打不开**的。照实说，别让用户以为能用。
    copyLink.title = '这条文件的下载地址。⚠️ 房间要密码的话，这条链接打不开（凭据只在请求头里）。';
    copyLink.addEventListener('click', () => {
      closeMenu();
      invoke('copy_to_clipboard', { text: entry.previewUrl }).catch((error) =>
        showNotice('err', `复制失败：${error}`),
      );
    });
    menu.append(copyLink);
  }

  document.body.append(menu);
  menuNode = menu;
  // ⚠️ 先挂上去**再**量尺寸：挂之前 `getBoundingClientRect()` 全是 0，
  // 那样算出来的位置会贴到边上。
  const rect = menu.getBoundingClientRect();
  // ⚠️ 贴边往回收 —— 不然在最后一条上点右键时，菜单会有一半在窗口外、点不到。
  // ⚠️ 用 `clientX/clientY` + `position: fixed`（**不要** `pageX/pageY`）。
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

el('timeline').addEventListener('contextmenu', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  // ⚠️ 必须拦：不拦的话 webview 会再弹一次它自己的菜单（两个叠在一起）。
  event.preventDefault();
  // ⚠️ 从**下标**找回那条 —— 见 `renderEntry` 那段（不把内容塞进 DOM 的理由）。
  const entry = lastEntries[Number(card.dataset.index)];
  if (entry) openEntryMenu(entry, event.clientX, event.clientY);
});

/** 历史是**自动取**的 —— 所以界面上没有「刷新」按钮（界面稿里也没有）。
 *
 * ⚠️★ 为什么需要它：切房间时壳会自己取一次（`commands::select`），
 * 但**启动时**不会 —— 那时只有「下载通道」那个房间的历史由下行自己取回来。
 * 少了它，用户切到别的房间会看到一个**永远空**的列表，而「刷新」按钮又按稿子删掉了
 * → 他没有任何办法。
 *
 * ⚠️ 按房间记住「上一次什么时候问的」：取不到（服务端挂了 / 凭据不对）时
 * **不能每 700ms 打一次** —— 那是在拿自己的客户端打自己的服务端。
 * 5 秒既让用户感觉不到，故障时也不会把服务端打爆。
 * ⚠️ 键用 `server + room` 而不是下标 —— 下标会随着增删房间指向别人。
 */
const historyAsked = new Map();
const HISTORY_RETRY_MS = 5000;

function ensureHistory(state) {
  const room = state.rooms[state.selected];
  if (!room || room.historyLoaded) return;
  const key = `${room.server}\u0000${room.room}`;
  const last = historyAsked.get(key) ?? 0;
  if (Date.now() - last < HISTORY_RETRY_MS) return;
  historyAsked.set(key, Date.now());
  invoke('refresh').catch(() => {});
}

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
      roomList: sqGet('cfg-roomlist'),
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
      enabled: sqGet('cfg-automation'),
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
    sqSet('cfg-roomlist', server.roomList === true);
    el('cfg-dbpath').value = server.dbPath ?? 'clip9.redb';
    el('cfg-storage').value = server.storageDir ?? 'uploads';
    el('cfg-textlimit').value = text.limit ?? 4096;
    el('cfg-fileexpire').value = file.expire ?? 3600;
    el('cfg-filechunk').value = file.chunk ?? 1048576;
    el('cfg-filelimit').value = file.limit ?? 268435456;
    sqSet('cfg-automation', automation.enabled === true);
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
  // ⚠️ 放**最前面**：下面「一个房间都没有」那条会提前 return，
  // 放末尾的话那一格会留着上一次的内容（而列表已经空了）。
  renderDownloadSource();
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

/** 「来源房间」那一格（稿 2 里是只读的：写着房间名 + 一句「在左侧栏用 ↓ 选」）。
 *
 * ⚠️★ 从**草稿**里算，不是从壳里问 —— 草稿才是用户眼前这张表格的真相
 *（他可能刚点了 ↓ 还没保存）。两边不一致的话，这一格会跟上面那张表打架，
 * 而「同一屏里两处说的是两件事」正是这个项目最忌讳的一类。
 */
function renderDownloadSource() {
  const host = el('sc-source');
  const index = roomDraft.findIndex((room) => room.enable_download === true);
  const name = index >= 0 ? roomDraft[index].name || roomDraft[index].room || '房间' : '没有';
  host.textContent = '';
  host.append(name);
  host.append(h('span', 'src-note', index >= 0 ? '在左侧栏用 ↓ 选' : '没开：哪个房间的内容都收不到'));
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
    sqSet('sc-text', view.enableText);
    sqSet('sc-file', view.enableFile);
    sqSet('sc-text-dl', view.enableTextDownload);
    sqSet('sc-file-dl', view.enableFileDownload);
    // ⚠️★ 文件上限**来自握手**（`ClientConfig::max_file_size_mb` 的默认是 **0 = 不限制**），
    // 所以这里照实显示服务端给的那个数 —— 界面稿里写死的「大于 50 MB 跳过」
    // 在代码里**根本不成立**，抄它就是抄一句假话。
    el('sc-file-hint').textContent = lastLimits.fileLimit
      ? `上限 ${sizeLabel(lastLimits.fileLimit)}`
      : '上限还不知道（还没连上）';
    el('sc-poll').value = view.pollIntervalMs;
    el('sc-dir').value = view.downloadDir;
    // ⚠️ 自启那个勾画的是**系统里的真相**（壳去问的系统），不是配置里的意图。
    sqSet('sc-autostart', view.autostart);
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
      enableText: sqGet('sc-text'),
      enableFile: sqGet('sc-file'),
      enableTextDownload: sqGet('sc-text-dl'),
      enableFileDownload: sqGet('sc-file-dl'),
      pollIntervalMs: Number(el('sc-poll').value) || 500,
      downloadDir: el('sc-dir').value.trim() || 'downloads',
    },
    autostart: sqGet('sc-autostart'),
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
    // ⚠️ `open` 是**可编辑的**：原来画成一个只读胶囊，用户能看见「要密码 / 开放」
    // 却改不了 —— 而它就在这张可编辑的表里，那是最别扭的一种「看得见摸不着」。
    // ⚠️ 表格里的布尔，主流就是复选框（开关也行，但表格里复选框更省地方、也更准）。
    const state = h('td', 'tiny');
    const openBox = document.createElement('input');
    openBox.type = 'checkbox';
    openBox.checked = entry.open === true;
    openBox.title = '这个房间是公开的（不需要密码）';
    openBox.addEventListener('change', () => {
      entry.open = openBox.checked;
    });
    state.append(openBox);
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
