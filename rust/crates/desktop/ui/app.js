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

/** 取一句界面文案。**这是唯一入口** —— 别在别处再写死一句中文或英文。
 *
 * ⚠️ 包一层而不是到处写 `I18N.t`：将来要换实现（比如加缓存、加复数）只改这一行。
 *
 * ⚠️★ 它必须**排在下面那个守卫之前**。原来它在守卫后面（`const`），于是「没有壳」那条路上
 * 守卫里那两句 `t(…)` 会先抛 `ReferenceError: Cannot access 't' before initialization` ——
 * 结果**那句提示一个字母都没显示出来**（页面停在一副空壳上），而控制台里说的是变量初始化，
 * 跟「没有 `__TAURI__`」一点关系都看不出来。2026-09-28 实测踩到（用浏览器直接打开这个页面）。
 * ⚠️ 这里是安全的：`i18n.js` 在 `index.html` 里排在 `app.js` **前面**（都是 `defer`），
 * 而 `I18N.t` 只读 `<html>` 上的属性、不碰 DOM。
 */
const t = (key, params) => I18N.t(key, params);

/** **壳递过来的**一句话（`{key, params}`）→ 成文的文本。
 *
 * ⚠️★ 与 `t()` 分开是**故意的**：`t()` 收的是一个键（页面自己知道要哪句），
 * 而这里收的是壳说的一件事（壳才知道发生了什么，页面只负责把它说成人话）。
 * 渲染规则（参数可能是字符串 / 整份列表 / 另一句话）在 `i18n.js` 的 `I18N.say` 里。
 */
const say = (msg) => I18N.say(msg);

/** `catch` 到的东西 → 一句能显示的话。
 *
 * ⚠️★ 三种都要认，**少一种就是一个假象**：
 *  - **对象**（`{key, params}`）：壳的 15 条命令报错从 2026-09-28 起是这个形状
 *    （`Msg`，见 `rust/crates/desktop/src/commands.rs` 的模块文档）。⚠️ 不认它的症状是
 *    界面上顶着一句 `取不到状态：[object Object]` —— 完全看不出哪里坏了；
 *  - **`Error`**：JS 自己抛的（`TypeError`、以及 `invoke` 参数写错时 Tauri 抛的那种）；
 *  - **字符串**：`throw 'x'`、以及老版本壳的交界期。
 *
 * ⚠️ 顺序要紧：先认**具体**的（字符串 / `Error`），再落回「是不是壳的一句话」——
 * 反过来会让 `Error` 走到 `say` 里（它不是句子，`say` 会返回空串）。
 */
function errorText(error) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return say(error);
}

/** 把两份字典**整个推给壳** —— 系统通知 / 托盘菜单 / 系统文件对话框的标题要用它。
 *
 * ⚠️★ 为什么是「推」而不是让壳自己去读这份文件：`i18n.js` 是**普通脚本**（不是 JSON），
 * 壳读不了；而语言设置只在页面这边（`<html data-locale>` + `localStorage`），
 * 壳不知道用户选了哪个语种。所以**启动时推一次、每次换语种再推一次**
 * （壳那边收完顺带把托盘菜单重建一遍）。取舍写在 `rust/crates/desktop/src/shell_text.rs` 的模块文档里。
 *
 * ⚠️ 失败**不弹提示**：这三处（通知 / 托盘 / 文件对话框）用的字典缺了，
 * **界面本身一点问题都没有** —— 表现只是「壳说的那几句还是旧语言」。
 * 为它打断用户不值得；留一行 `console.error` 是为了排查时看得见。
 */
function pushShellMessages() {
  invoke('set_shell_messages', { locale: I18N.locale(), dicts: I18N.DICTS }).catch((error) => {
    console.error('把字典推给壳失败（通知/托盘会停在旧语言）：', error);
  });
}

// ⚠️ 用普通浏览器打开时（开发时双击 index.html）没有 `__TAURI__`。
// 那时要说清「怎么才对」，而不是抛一句 undefined 的错。
if (!window.__TAURI__ || !window.__TAURI__.core) {
  // ⚠️ 遮布也要摘掉：不摘的话（英文用户）`<html data-i18n="pending">` 会一直留着 ——
  // 这一趟 `.win` 整块被换成了这句话，遮布其实挡不住它，但留一个「还没刷完」的属性是脏状态，
  // 而 `/server` 那种地方将来顺手读它就会读到假的。
  I18N.ready();
  document.body.textContent =
    t('这个页面要在桌面壳里打开（cargo run -p clip9-desktop）。') +
    t('直接用浏览器打开它拿不到剪贴板，也连不上服务端。');
  throw new Error('no tauri bridge');
}

const { invoke } = window.__TAURI__.core;

// ⚠️★ 上来第一件事：把静态文案刷成 `boot.js` 定下来的语种，然后**摘掉那块遮布**。
// ⚠️ 顺序不能反：先 `ready` 的话，摘布那一拍界面还是中文（源语言），遮布白贴了。
// ⚠️ 这一步**必须在 `tick()` 之前** —— 首次绘制里就有 `data-i18n` 的节点。
I18N.apply(document);
I18N.ready();
// ⚠️★ 紧接着把那两份字典推给壳：系统通知、托盘菜单、系统文件对话框的标题
// 是**操作系统画的**，页面渲染不了它们（见 `shell_text.rs`）。推晚了不会错，
// 但那一小段里壳弹的通知 / 托盘菜单会显示成键（`notifyUploadFailed` 那样的词）。
pushShellMessages();

/** 多久取一次快照。
 *
 * ⚠️ 用**轮询**而不是事件推送：一份快照就是界面的全部真相，轮询天然不会出现
 * 「丢了一条更新」或「两条更新乱序到达」。700ms 对一个托盘级客户端绰绰有余。
 * ⚠️ 串行取（取完再排下一次），否则服务端卡住时会有几十个请求堆在上面。
 * ⚠️★ 2026-09-30 补：**这个数只管「后台安静地盯着」的节奏**，不是
 * 「点一下之后界面多久才有反应」—— 后者由 `refreshNow()` 单独负责（动作之后立刻取一次）。
 */
const POLL_MS = 700;

/** 「正在等一个**已知会来**的东西」时的节奏。
 *
 * ⚠️★ 它只为一个场景存在：切房间之后那一段 —— `select` 在壳里顺带就发了取历史的请求，
 * 内容**正在路上**，而用户正盯着那块空白等。那段窗口很短（一次 HTTP 往返），
 * 用 700ms 的话内容到了还要再等半拍才画出来。
 * ⚠️ 判据是「当前房间的历史还没到」（`historyLoaded` 为假），一旦到了就回到 `POLL_MS` ——
 * 所以它**不是**「把轮询调快了」，只是「在等东西的那一小段里问得勤一点」。
 */
const POLL_FAST_MS = 150;

/** 上一份快照的**版本号** —— 只用来判断「要不要重画」。
 *
 * ⚠️★ 原来是拿整份快照的 JSON 字符串与上一份比，2026-09-27 换成了版本号（`store.rs` 的
 * `Snapshot::version`）。换的理由是**代价**：那趟 `JSON.stringify` 每 700ms **无条件**跑一遍，
 * 而且与内容长度成正比；`lastShape` 那份字符串还常驻一份。现在这里只读一个数。
 *
 * ⚠️★ **字段清单从此只有一份**（在 Rust 那个结构体上），这是这次换法的**主要**收益：
 * 原来页面自己列一遍字段，漏一个就是「那个字段变了界面不刷新」，而且**完全静默**
 * （§8.1 第 2 条就是 `notice` 被漏掉那次）。
 *
 * ⚠️ 但要说清：**风险是搬家，不是消失** —— 现在变成「某条写入忘了让版本号前进」，
 * 表现一模一样。换来的好处是它搬到了**有测试运行器的那一侧**：`store` 的测试里
 * 逐条列出了每一条会改动快照的写入。所以这一侧只需要读 `state.version`，
 * **不要再自己攒一份字段清单**（那就是又造出第二份）。
 */
let lastVersion = null;

/** 上一次渲染的**房间视图**（点按 ↑/↓ 时要读「现在是开着还是关着」）。
 *
 * ⚠️ 单独存一份，而不是每次去 `lastShape` 那种整份快照里翻 —— 为读两个布尔值
 * 去遍历整屏条目，浪费得没道理（而且 `lastShape` 现在只剩一个版本号了，更读不出来）。
 */
let lastRooms = [];

/** 上一次拿到的**整份快照**。
 *
 * ⚠️★ 它只有一个用处：**换语种之后把界面重画一遍**（`applyLocale`）。
 * 换语种**不改变**版本号（壳那边的数据一个字节都没动），所以不能指望下一拍 `tick()`
 * 会重画 —— 快照得自己留一份。
 */
let lastState = null;

/** 上一次渲染时**选中的是哪个房间**（下标）。
 *
 * ⚠️ 与 `lastRooms` 配对用：光有房间数组、没有下标，读不到「当前那个」的状态。
 * 现在的用处是计数器要判「这条连接到底通没通」—— 因为 `textLimit === 0` 有
 * 「没连上」与「服务端不限」两种含义（见 `updateCounter`）。
 */
let lastSelected = 0;

/** 上一次渲染的**限额**（握手下发的那一份）。只给输入区右下角那个计数器用。 */
let lastLimits = { textLimit: 0, fileLimit: 0 };

/** 「展开」的两份状态。⚠️ 都按 **entry.id**，而且**切房间时必须清**。
 *
 * ⚠️★ 为什么按 id 而不是下标：`renderTimeline` 每次都是**整表重建**，
 * 下标会被新消息挤走 —— 那样「展开」的会是**另一条**，而且不报错。
 * ⚠️★ 为什么切房间要清：id 是**每个房间各自**单调的（`CONTRIBUTING.md` §6），
 * 不清的话会把「B 房间的 7 号」当成「A 房间展开过的 7 号」，展开出**别人的内容**。
 *
 * ⚠️ `openedBodies` 会一直留着取回来的**全文**（收起也不丢，免得反复过 IPC）——
 * 它**不是无界**的：里面的正文只可能来自**当前这个房间**，而那个房间的正文总量被
 * `store.rs` 的 `MAX_BYTES_PER_ROOM` 封着（2026-09-27 加的）。真到了要动这个缓存的那天，
 * 这句话是「为什么现在不用管它」的依据。
 */
const openedIds = new Set(); // 现在摊开的那几条
const openedBodies = new Map(); // id -> 取回来的**全文**（取过一次就留着，收起也不丢）

/** id -> 这条上「跑过什么动作、结果是什么」。
 *
 * ⚠️★ 结果画在卡片上、**按 id 存**（不是画在 DOM 里就地改）：时间线每 700ms 会被整个重画，
 * 就地改的那份下一次轮询就没了（表现是「跑出来的结果闪一下又变回原文」）。
 *
 * ⚠️ 结果是用**全文**跑出来的（`runAction` 里现取 `entry_text`），不是列表里那份截断预览 ——
 * 拿预览跑，用户看到的和跑出来的对不上，而这件事**不会报错**。
 */
const actionViews = new Map();

/* ── 滚动与「N 条新消息」───────────────────────────────────────────────
 *
 * ⚠️★ 三条规矩（2026-10-04 Jonny 报的那两件）：
 *   ① 往上翻着读历史时，新内容**不许把人拽回底部**（原来就是这样，别改回去）；
 *   ② 于是必须有一个**不侵入**的提示：「输入框上方」一颗「N 条新消息」，点它跳到底；
 *   ③ 而**自己发东西**的那一刻反过来 —— 必须跟到最新（不然发完看不见自己发的那条）。
 * ⚠️ ②与③共用同一份「贴不贴底」的判断，所以一起写在这里，别拆到两处各判一遍。
 */

/** 不在底部那段时间新来了几条（`> 0` 才把那颗胶囊亮出来）。 */
let unseenCount = 0;

/** 「已经看过的末尾条目 id」—— 算 `unseenCount` 的**基线**。
 *
 * ⚠️ 用 id 而不是「条数」：撤销 / 清空都会让条数变少，只比条数会把「看过」算错。
 * ⚠️ 换房间必须清（见 `render` 里清展开态那一处）：id 是**每个房间各自**单调的。
 */
let seenLastId = 0;

/** 「刚发过东西」——下一拍不管贴不贴底都跟到最新。见 [`followToNewest`]。 */
let followAfterSend = false;

/** 发之前列表有几条（发出去的那条到了就比它多，见 [`followToNewest`]）。 */
let followBaseline = 0;

/** 「跟到底」那个状态的兜底超时（上行失败 / 半天不回来时别一直挂着）。 */
let followTimer = null;

/** 「视图现在贴在底部吗」—— **记住**的状态，不是每次重绘现算的。
 *
 * ⚠️★ 为什么不能现算（2026-10-04 修的那个「卡片只露 1-2 行」就是这个）：
 * 「贴不贴底」是**用户意图**，而现算出来的是**几何**，两者会在内容长高之后分叉 ——
 * 卡片里的图片是**加载完才长高的**（固有尺寸要等字节到；`loading=lazy` 更要等它进视口），
 * 于是「刚才明明到底了」在这一刻算出「离底 220px」，看起来像用户自己往上翻了：
 * ① 那一条最新的卡片被顶到视口外面（露在屏幕上的只有它的 meta 那一行）；
 * ② 下一条新消息也不再跟到底（它以为用户在读历史）。
 * ⚠️ 初值是 `true`：第一帧必须贴底画（列表末尾才是最新的）。
 * ⚠️ 只有两处写它：**滚动事件**（用户真的滚了）与 [`pinTimeline`]（我们主动贴过去）。
 */
let timelinePinned = true;

/** 超过多少字节才画「展开」。
 *
 * ⚠️ 这个数是**估的**：卡片宽约 590px、13px 字体 ≈ 一行 80 字符，
 * 而 CSS 里 clamp 的是 12 行 → 约 960 字节。两处要对得上（改了 clamp 行数就该改这里），
 * 但**对不齐也不致命**：判据偏小只是多画一个「展开」，点了照样正常。
 * ⚠️ 不改成「量一下有没有被 clamp」的理由：那要为每张卡片强制一次排版。
 */
const EXPANDABLE_BYTES = 960;

const el = (id) => document.getElementById(id);

/* ── 内容区的两个视图：手写时间线 / 嵌进来的 SPA（2026-09-29 的实验）────────────
   ⚠️★ 「网页」那个视图是一个 **iframe**，加载的是**本机自带那个服务端**的网页版
   （`http://127.0.0.1:<port>/`）。父页面在 `tauri://`、它在新源的 `http://` —— 这是
   **跨源 iframe**，要 `tauri.conf.json` 的 `frame-src` 放行（原来只有 `default-src 'self'`，
   跨源会被**直接拒**，而 WebView 里只留一条 console 消息、页面上什么都不发生）。
   ⚠️★ 嵌进来的那份 SPA **不是哑视图**：它自己开 WebSocket、自己取历史、自己拿
   `config.latestId` 对齐实时边界 —— 它是**第二个客户端**（「同一台机器在设备列表里
   显示成两台」那条代价就是这么来的，见 `dev-docs/specs/desktop-client.md`）。
   ⚠️ 原时间线**一行没删**：iframe 白屏时它是兜底，切回去也是对照的那一份。
   ⚠️★ **默认是「列表」，并且记住用户选的那一个**（2026-09-30）。
   Jonny 的原话：「桌面端为什么一直默认加载网页，即使改了列表，重启又变成网页了？
   **默认就列表好了，然后记住用户的偏好**」。所以 `let mainView = 'spa'` 那个写死的初值
   （它后面没有任何存储）换成了 [`storedView()`]。
   ⚠️ 为什么默认是列表：网页那一格要**先探测再嵌**（`probe_site` + iframe 加载），
   把一个白屏当默认视图说不通 —— 而且那趟加载对**从没点过「网页」的人**是白花的。
   ⚠️ 为什么这条路**一帧都不用跳**：`index.html` 里 `#timeline` 的 DOM 初值本来就是「可见」
   （`#spa` 带 `hidden`），与这里的兜底值正好同向。存的是 `'spa'` 时才会跳一下 ——
   而那一跳**今天本来就有**（默认值是 `spa` 而 DOM 初值是列表），没人看得出：
   时间线那一刻还是空的，与「网页那格正在加载」长得一样。
*/

/** 内容区两个视图的存储键。
 *
 * ⚠️★ 与 `theme` / `sidebar` / `composer` 同一个模子，但**故意没有** `boot.js` 里那一份：
 * 那三样是 **CSS 令牌**（晚一步贴就是「先画错再跳」：白屏 / 宽栏跳窄 / 输入区跳没），
 * 而视图不是 —— 它走 `hidden` 属性，晚一步只差「先画一屏空的列表」，见上面那条注释。
 * ⚠️★ 另一层：判据 13 要求「往 `<html>` 上写的属性，样式表里得有人读它」。视图**没有**
 * 该被 CSS 读的地方（显隐的唯一权威是 `applyView` / `paintSpa`），所以它**不走 `data-` 属性** ——
 * 写一个没人读的属性是给自己留一条会漂的第二定义。
 * ⚠️ 这一个键**只有这一处**读写（不像主题那三样要跟 `boot.js` 对齐），所以没有「两份漂掉」的问题。
 */
const VIEW_KEY = 'view';

/** 上次选的是哪一版视图。
 *
 * ⚠️ 只认 `'spa'`：读不到 / 值不认得 / 存的是 `'timeline'` **一律当列表**
 *（与侧栏「只认 narrow」同一个理由：兜底要落在**安全**的那一边，
 * 而这里的「安全」= 不去加载那个 iframe）。
 * ⚠️ 存储读不到（隐私模式 / 被策略挡）也当列表 —— 界面偏好不值得打断启动。
 */
function storedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'spa' ? 'spa' : 'timeline';
  } catch (error) {
    return 'timeline';
  }
}

let mainView = storedView();
/* ── 网页视图：跟着**当前房间的服务端**走，而且**先探测再嵌**（2026-09-30）────────
 *
 * ⚠️★ 2026-09-30 之前这里只认**本机**那一个地址（`spa_url` 命令），于是房间连的是别处的
 * 服务端（Docker / OpenWrt / Cloudflare）时，网页视图**照样显示本机**的内容 —— 而房间里
 * 那台服务端**自己也带网页版**（前端就编在它的二进制里）。用户报的「切到网页什么都没提示、
 * 直接显示本机的」就是这一条。
 *
 * ⚠️★ 现在按当前房间的 `RoomView.server` 走，并且**先问一句那台有没有可嵌的网页版**
 *（`probe_site`；跨源 `fetch` 会被 CORS 挡掉，所以只能问壳）。三种状态各自的样子：
 *
 *   `checking` → 覆盖层（「正在检查…」），**什么都不嵌** —— 别先闪一下那个陌生页面
 *   `ready`    → 设 iframe 的 `src`；之后切房间 / 切主题走 postMessage，不再重载
 *   `blocked`  → 覆盖层（那台不是 clip9 的网页版 / 连不上 / 地址不是 http(s)）
 */
/** 当前站点的基址（去掉尾斜杠；跟着房间走）。`null` = 那个房间没配服务端 → 不给切换按钮。 */
let spaBase = null;
/** 那个站点的探测状态：`'checking' | 'ready' | 'blocked'`。 */
let spaSite = 'checking';
/** `checking` / `blocked` 时覆盖层上那句话（**壳给的 `Msg`**，见 `probe_site`）。 */
let spaReason = null;
/** 已经设进 iframe 的地址。
 *
 * ⚠️★ 只在**变了**的时候才重设 `src`：快照每 700ms 来一次，每次都重设等于把整个 SPA
 * 重载一遍（WebSocket 跟着重连）。「当前房间」变了下一次快照就会看见，所以不会漏。
 * ⚠️ 它现在只承载**首屏那一次**（URL 是唯一的初始入口：房间名 / `embed` / 主题三个参数）；
 * 之后的切换走 postMessage（见 `postToSpa`）。
 */
let spaSrc = null;
/** iframe 里那份 SPA 回过一声没有 —— 回过了才敢用 postMessage 驱动它（见 `sayHello`）。 */
let spaReady = false;

/** 「那个站点是不是 clip9 的网页版」的探测结论缓存：`站点基址` → `{view, at}`。
 *
 * ⚠️★ 为什么要有它：在**网页**那一版里来回切房间时，只要跨了站点就要重新探一遍
 *（`probe_site` 是一次 IPC + 一次 HTTP 往返，还可能 3 秒超时），而它**串在
 * iframe 加载之前** —— 用户看到的是「切过去先愣一下，然后才开始加载」。
 * 实测（2026-09-30）：A→B→C→A→B→C 这么来回六下，探测被调了 **9** 次；
 * 而里面只有**两台**站点。
 *
 * ⚠️ 失败也缓存，但**短**得多：站点可能刚被更新（装上带标记的新版本），
 * 让用户为此等满 5 分钟是说不通的；而「连不上」更不该每次都等满超时 ——
 * 那正是最该少问的那种情况。
 */
const PROBE_TTL_MS = 5 * 60 * 1000;
const PROBE_TTL_BAD_MS = 20 * 1000;
const probeCache = new Map();

/** 那个房间该嵌哪个站点。
 *
 * ⚠️ 只做最轻的规范化（去尾斜杠）—— **scheme 的校验不在这里**：真正拦住 `iframe.src` 的
 * 是「探测没通过就不设 `src`」（`probe_site` 会回 `spaProbeBadAddress`）。页面里再判一次
 * 就是第二份定义，而它其实管不住什么。
 */
function siteBaseOf(room) {
  const raw = (room?.server || '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/** 把 iframe 的地址对齐到「当前房间 / 当前站点」。⚠️ 只在真的变了时才动 `src`。
 *
 * ⚠️★ 传的是 **`room.room`（服务端那边的房间名）**，**不是** `room.name`（给用户看的名字）——
 * 两个是**两个配置字段**（`Channel::name` / `Channel::room`），可以一个叫「默认」一个叫
 * `default`。2026-09-29 实测踩到：传了展示名 → SPA 打开的是一个服务端**不存在**的房间
 * → 「列表 30 多条、网页空的」。快照里两个都给了（`RoomView`），各用各的。
 *
 * ⚠️ **不传 `?mode=`**：模式选择是 SPA 自己的事（它按 `?mode=` → localStorage → 标准模式
 * 的顺序挑，还有整套切换界面），桌面端再摆一份就是第二份要跟着漂的东西
 *（Jonny 2026-09-29：「模式切换网页带的有」—— 那版下拉已经删了）。
 */
function syncSpa(state) {
  const room = state.rooms[state.selected];
  const base = siteBaseOf(room);
  // ⚠️ 「有没有可嵌的地址」决定那颗切换按钮露不露：那个房间没配服务端就不给 ——
  //    与原来的老规矩同一条（不给一个点下去是白屏的按钮）。
  el('view-switch').hidden = !base;
  if (!base) return;

  if (base !== spaBase) {
    // 站点换了（或头一次）：⚠️ 换站点**必须**重设 `src`（跨源，postMessage 过不去），
    // 而在此之前**什么都不嵌** —— 探测没回来之前不许把 `src` 设出去，否则用户会先看到
    // 那个陌生页面的首页（那正是要修的那个毛病）。
    spaBase = base;
    spaReady = false;
    spaSrc = null;
    closeHello();
    // ⚠️★ 先看缓存（见 `probeCache`）：命中就不摆「正在检查」、也不问壳 ——
    //    那样会先闪一下「检查中」再跳成结论，而答案我们早就有了。
    const hit = probeCache.get(base);
    const fresh =
      hit && Date.now() - hit.at < (hit.view?.supported ? PROBE_TTL_MS : PROBE_TTL_BAD_MS);
    if (fresh) {
      applyProbe(base, hit.view);
    } else {
      spaSite = 'checking';
      spaReason = null;
      paintSpa(mainView === 'spa');
      renderBlocked();
      probeSite(base);
    }
    return;
  }

  // 不在网页那一版上就不必往下（探测与 `src` 都只为「要显示的那一格」服务）。
  if (mainView !== 'spa' || spaSite !== 'ready') return;
  if (spaReady) {
    // ⚠️★ 握手过了 → 让 SPA **自己**切房间：`host-bridge.js` 那条 `clip9:room` 走的是它
    // 内部的 `navigateToRoom`（只 `router.replace` 改地址，**不重载**、不重连、不跳）。
    postToSpa({ type: 'clip9:room', room: room.room });
  } else {
    // 还没握手（首屏正在加载）→ 走 URL（那是唯一的初始入口）。
    setSpaSrc(room.room);
  }
}

/** 设 iframe 的地址（首屏 / 换站点那一次）。
 *
 * ⚠️ `embed=1`：让网页版把发送区整个让给宿主（SPA 的 `display` getter 把 composer
 * 那组预置成关，走的就是个性化里「关掉输入区」同一条路）——
 * 不然网页视图里会有两个输入框（桌面端底下一条 + 网页版自己的）。
 * ⚠️ `theme=`：首屏那次把桌面端选的深浅色带过去（SPA 只在 embed 下认这个参数）；
 * 之后换主题走 `clip9:theme` 那条消息。
 */
function setSpaSrc(roomName) {
  const url = `${spaBase}/?room=${encodeURIComponent(roomName)}&embed=1&theme=${currentTheme()}`;
  if (url === spaSrc) return;
  spaSrc = url;
  spaReady = false;
  el('spa').src = url;
}

/** 问壳「那台站点有没有可嵌的网页版」，并把结论记进缓存。 */
async function probeSite(base) {
  let view = null;
  try {
    view = await invoke('probe_site', { base });
  } catch (error) {
    view = null;
  }
  // ⚠️ 连「没答上来」也记进去（`view = null`）：不然每次切到这个站点都要再等一遍
  //    3 秒超时 —— 而「连不上」正是最该少问的那一种。
  probeCache.set(base, { view: view ?? null, at: Date.now() });
  applyProbe(base, view);
}

/** 探测有结论了（刚问回来的，或缓存命中的）：把它落到界面上。
 *
 * ⚠️★ `spaSite` / `spaReason` 只在这里改（外加 `syncSpa` 里那条「正在检查」）——
 * 两处都写就会漂，而漂起来的表现是「覆盖层和 iframe 叠在一起」或者「一片空白」，都不报错。
 */
function applyProbe(base, view) {
  // ⚠️★ 结果回来时用户可能已经切到别的房间了 —— 那这次结果**作废**
  //（拿它去画覆盖层或设 `src`，就是「网速慢一点就按上一个站点画」）。
  if (base !== spaBase) return;
  if (view && view.supported) {
    spaSite = 'ready';
    spaReason = null;
    const room = lastState?.rooms?.[lastState.selected];
    if (room && mainView === 'spa') setSpaSrc(room.room);
  } else {
    spaSite = 'blocked';
    // ⚠️ 壳没给原因就拿「连不上」兜底 —— 那是唯一一种「我们说不出更细的话」的情形。
    spaReason = view?.reason ?? { key: 'spaProbeUnreachable' };
  }
  paintSpa(mainView === 'spa');
  renderBlocked();
}

/** 覆盖层上那几句（`checking` 与 `blocked` 共用这一块，只有文案与按钮不同）。 */
function renderBlocked() {
  el('spa-blocked-addr').textContent = spaBase || '';
  const why = el('spa-blocked-why');
  const update = el('spa-blocked-update');
  const project = el('spa-blocked-project');
  if (spaSite === 'checking') {
    why.textContent = t('正在检查这个站点…');
    update.hidden = true;
    project.hidden = true;
    return;
  }
  // ⚠️ 原因句是**壳给的 `Msg`**（键 + 参数），走 `I18N.say` 渲染 —— 不在这里拼中文。
  // ⚠️★ 它是**标题**（`.t`），不是小字：这一格原来是写死的一句「这个站点没有可嵌入的
  // 网页版」，而那句话只对三种原因里的第一种成立。2026-09-30 的实际后果：
  // 用户配的地址写成 `Https://…`（大小写），界面却告诉他「这个站点没有可嵌入的网页版」，
  // 于是他跑去查部署 —— 真正的原因在下一行，而那一行被当成了备注。
  why.textContent = spaReason ? I18N.say(spaReason) : '';
  // ⚠️★ 「把它更新到 clip9」这条建议**只对一种原因成立**（那台答了、答的不是我们的网页版）。
  //    地址不是 http(s) / 连不上时，更新服务器改变不了任何事 —— 那时候摆着这句话和那颗
  //    「去 clip9 项目」的按钮，等于把人指向**错误的方向**。
  //    ⚠️ 判的是键名：`spaReason` 是壳递过来的 `Msg`（`{key, params}`），键名是两边的契约
  //    （`probe_site` 那三个 `Msg::key`），不是抄一句中文。
  const canUpdate = spaReason?.key === 'spaProbeNotClip9';
  update.hidden = !canUpdate;
  project.hidden = !canUpdate;
}

/** 给 iframe 里那份 SPA 发一条消息。
 *
 * ⚠️ 目标 origin 只能写 `'*'`：那份页面在**另一个源**上（用户自己那台服务端），而宿主这边
 * **拿不到**它的 origin 串（协议 / 端口 / 路径前缀都是用户配的）。
 * ⚠️ 消息里只有房间名与主题，没有凭据 —— 别往里加东西（加了这条 `'*'` 就得重新算）。
 */
function postToSpa(payload) {
  const frame = el('spa');
  if (!frame.contentWindow) return;
  frame.contentWindow.postMessage(payload, '*');
}

/* 握手：iframe 里那份 SPA 说一声「我是 clip9 的网页版」之后，才敢用消息驱动它。
 *
 * ⚠️★ 为什么要握手而不是看 `load` 事件：`load` 只说明**文档**加载完了，而那份 SPA 的消息
 * 监听是在 `router.isReady()` **之后**才装的（见 `web-vue3/src/host-bridge.js`）—— 早发的
 * 消息会**静默丢失**，表现是「切了房间网页没反应」，而且什么都不报。所以 `load` 之后要
 * **重试着问**。
 * ⚠️ 重试完还是没有回应就停手（不弹东西）：那份页面可能只是慢。这时 `spaReady` 仍是
 * `false` → 下一次切房间会走 `setSpaSrc`（重载一次，但**结果是对的**）。
 * 「退化到重载」比「假装成功」好。
 */
const HELLO_RETRY_MS = 250;
const HELLO_TRIES = 12; // ≈ 3 秒
let helloTries = 0;
let spaHelloTimer = null;

function sayHello() {
  const frame = el('spa');
  if (!frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: 'clip9:ping' }, '*');
  helloTries += 1;
  if (helloTries < HELLO_TRIES) {
    clearTimeout(spaHelloTimer);
    spaHelloTimer = setTimeout(sayHello, HELLO_RETRY_MS);
  }
}

function closeHello() {
  clearTimeout(spaHelloTimer);
  spaHelloTimer = null;
  helloTries = 0;
}

// 覆盖层上那颗「去 clip9 项目」。
// ⚠️ 命令刻意是**窄的**（`open_project_page` 只开项目主页，不从页面收 URL）——
// 页面这里也就不拼地址、不传参。
el('spa-blocked-project').addEventListener('click', () => {
  // ⚠️ 失败就只写一条控制台日志：那条命令只打开一个写死的地址，真失败（比如这台机器没有
  // 默认浏览器）也没有「下一步」可以给用户。⚠️ 但**要 catch** —— 未处理的 reject 会在
  // 控制台留一条没人看的红字（这一版连控制台都不给用户看）。
  invoke('open_project_page').catch((error) => {
    console.error('opening the project page failed:', error);
  });
});

// 「关于」里的项目地址。**与上面那颗「去 clip9 项目」同一个命令、同一套理由** ——
// 命令是窄的（只开那一个写死的地址），所以这里也不拼地址、不传参。
// ⚠️ 失败同样只写控制台：那条命令只会去起系统 opener，真失败（这台机器没有默认浏览器）
// 也没有「下一步」可以给用户。⚠️ 但要 catch —— 未处理的 reject 会留一条没人看的红字。
el('dg-project').addEventListener('click', () => {
  invoke('open_project_page').catch((error) => {
    console.error('opening the project page failed:', error);
  });
});

el('spa').addEventListener('load', () => {
  // 每次加载（首屏 / 换站点）都重新握一次手。
  spaReady = false;
  closeHello();
  sayHello();
});

window.addEventListener('message', (event) => {
  const frame = el('spa');
  // ⚠️ 只认**那个 iframe** 发来的（同源的别的窗口、这份页面里再嵌的东西都不算）。
  if (!frame.contentWindow || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'clip9:hello') return;
  spaReady = true;
  closeHello();
});

/** 两个视图的可见性。
 *
 * ⚠️ 切回「列表」时**不卸** iframe（不清 `src`）：它继续在后台连着，切回来不用重连 ——
 * 而那正是「两个客户端」那条代价本身，藏起来不等于不存在。
 */
function applyView() {
  const web = mainView === 'spa';
  el('timeline').hidden = web;
  el('view-list').classList.toggle('on', !web);
  el('view-web').classList.toggle('on', web);
  // ⚠️★ 「网页」视图里把桌面端自己的状态栏**整条藏掉**（房间名 / 条数 / 设备圆圈）：
  // Jonny 2026-09-29：「列表的右侧状态栏和网页的顶部菜单栏叠一起了」——
  // SPA 自己的头部有房间名，桌面端再挂一条就是上下两根横杆。
  // ⚠️ 代价明说：「N 台在线」在网页视图里没地方看（拿「看得见」换「不叠」）。
  el('main-head').hidden = web;
  paintSpa(web);
  // ⚠️ 切到「网页」时**立刻**对齐地址（用最后那份快照）—— 不然要等下一拍（700ms）才动，
  // 点了像卡了一下。⚠️ 放在这里而不是点击处理器里：启动时的那次 `applyView` 也要走这条路。
  //
  // ⚠️★ 默认改成列表（2026-09-30）之后，这一条**同时**是「第一次点『网页』才开始加载 iframe」
  // 那件事的落点：默认列表时 `syncSpa` 会在末尾的 `mainView !== 'spa'` 那条早退，
  // `setSpaSrc` 一次都不跑 —— 也就是说**启动时不加载那个 SPA**（它自己开 WebSocket、
  // 自己取历史，是实打实的第二个客户端）。代价明说：第一次点「网页」会有一次
  // 「只有 iframe 在加载」的等待，而以前那一次加载发生在启动时（用户在列表上，看不到）。
  // 之后切来切去不再重载（`spaSrc` 没变就不重设），所以只付这一次。
  if (web && lastState) syncSpa(lastState);
}

/** 网页那一格里到底露哪一个：正常时是 iframe，`checking` / `blocked` 时是覆盖层。
 *
 * ⚠️★ 这两个的显隐**只在这里**定 —— 别处再写一次 `el('spa').hidden = …` 就是第二份定义，
 * 而两份漂起来的表现是「覆盖层和 iframe 叠在一起」或者「一片空白」，都不报错。
 */
function paintSpa(web) {
  const blocked = spaSite !== 'ready';
  el('spa').hidden = !web || blocked;
  el('spa-blocked').hidden = !web || !blocked;
}

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

/* ── 主题（浅色 / 深色）─────────────────────────────────────────────
 *
 * ⚠️★ **只有两个取值，没有「跟随系统」**（Jonny 2026-09-28：「深浅模式切换支持，
 * 图标放在侧栏顶部，**不要跟随系统选项**，本地要记住选择」）。所以这里既不读
 * `prefers-color-scheme`，也不留「跟随系统」那一档 —— 「手动选完之后系统变了要不要跟」
 * 是一个没有正确答案的问题，别把它引进来。
 *
 * ⚠️★ 启动那一次**不在这里**：`boot.js` 是**同步**的，在第一次绘制之前就把
 * `data-theme` 贴上去了（晚一步就是「深色用户每次启动先闪一下白屏」）。这里只管
 * 「点一下」和「点了之后那颗按钮画成什么样」。
 *
 * ⚠️ 存储键在这个文件里**又写了一遍**（`boot.js` 里有一份）：那一份要在这个文件
 * 之前跑，读不到这里的常量。两处的**值**由 `tools/desktop-ui-smoke.mjs` 比对。
 */
const THEME_KEY = 'theme';

/** 现在是什么主题。
 *
 * ⚠️★ **以 DOM 为准**，不以 `localStorage` 为准：启动那一下是 `boot.js` 贴的，
 * 而「上次选了什么」只有它知道。在这里再读一遍存储，就等于给「谁说了算」立第二份定义 ——
 * 两份漂了的表现是「存的是深色、界面是浅色」，而且不报错。
 */
const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

/** 换主题：贴到 DOM + 存下来 + 把那个按钮画成新的样子。 */
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    // ⚠️ 存不上**照样换**：这一次点的就得生效，只是下次启动记不住。
    // 也不弹提示 —— 界面偏好记不住不值得打断用户，而且它没有「怎么办」可给。
  }
  const button = el('btn-theme');
  // ⚠️★ 图标画的是**点下去会变成什么**，不是现在是什么（浅色时画 🌙）。
  // 画「现在」的话，那颗月亮看起来像在说「你已经在深色里了」——
  // 而按钮上的图标，用户默认当**动作**读。
  button.textContent = theme === 'dark' ? '☀️' : '🌙';
  // ⚠️ 提示是**有状态的话**（「切到浅色」还是「切到深色」），所以它走 `t()` 而不是
  // `data-i18n-title` —— 后者只能给一句固定的。⚠️ 换语种时这里**要再调一次**
  //（`applyLocale` 里做了），否则那句话会留在上一个语种里。
  button.title = theme === 'dark' ? t('side.theme.tip.light') : t('side.theme.tip.dark');
  // ⚠️★ 主题同步给网页视图（Jonny 2026-09-29）。**现在走消息**：`clip9:theme` 让 SPA 自己
  // 改 `app.dark`（它内部只落 localStorage + 换主题，**不重载**）。
  // ⚠️ 只有握手没过时才退回「重载一次」（URL 里的 `theme=` 变了，`syncSpa` 会发现）——
  // 所以原来那句「切一次主题 = iframe 重连一次」现在只在**退化路径**上成立。
  // ⚠️ 启动那一次（下面紧跟着的 `setTheme(currentTheme())`）`spaReady` 一定是 `false`
  //（iframe 还没加载），于是走 `syncSpa`，而那边 `spaBase` 还没定 → 自己早退，不用额外挡。
  if (spaReady) {
    postToSpa({ type: 'clip9:theme', theme });
  } else if (lastState) {
    syncSpa(lastState);
  }
}

// 启动时先对一次：`boot.js` 贴的是存储里的值，而按钮的图标 / 悬停提示得跟它一致
// （不一致的表现是「界面是深色、按钮上画着月亮」）。
setTheme(currentTheme());
el('btn-theme').addEventListener('click', () => {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

const SIDEBAR_KEY = 'sidebar';

/** 侧栏收起了没有。
 *
 * ⚠️★ 与主题同一个规矩：**以 DOM 为准**（`boot.js` 在第一次绘制之前就贴好了，
 * 而「上次收没收起」只有它知道）。再读一遍存储就等于立第二份定义。
 */
const sidebarNarrow = () => document.documentElement.dataset.sidebar === 'narrow';

/** 收起 / 展开侧栏：贴属性 + 存下来 + 把那个按钮画成新的样子。
 *
 * ⚠️★ **宽的时候也显式写 `'wide'`**（不是删掉属性）：CSS 里两者同义，但显式写出来之后
 * 「点了一下」在 DOM 上**看得见**—— 排查时能分清「事件没挂上」和「样式没生效」。
 */
function setSidebar(narrow) {
  document.documentElement.dataset.sidebar = narrow ? 'narrow' : 'wide';
  try {
    localStorage.setItem(SIDEBAR_KEY, narrow ? 'narrow' : 'wide');
  } catch (error) {
    // ⚠️ 与主题同一条：存不上**照样收**（这一次点的就得生效），只是下次启动记不住。
  }
  const button = el('btn-sidebar');
  // ⚠️ 与主题那颗图标同一条规矩：画的是**点下去会变成什么**（宽的时候画「收起」）。
  // ⚠️ 而它的 `title` 是收回来的**唯一**线索之一 —— 收起之后这一行还在，全靠它把人劝回来。
  button.textContent = narrow ? '▶' : '◀';
  button.title = narrow ? t('side.expand.tip') : t('side.collapse.tip');
}

setSidebar(sidebarNarrow());
el('btn-sidebar').addEventListener('click', () => {
  setSidebar(!sidebarNarrow());
});

/** 换语种：交给 `I18N` 贴属性 + 存，然后把界面**整份重画一遍**。
 *
 * ⚠️★ 语种这件东西**没有自己的状态**：当前是哪个语种只有一个地方知道
 *（`<html data-locale>`，`boot.js` 与 `I18N.setLocale` 都往那上面贴）。
 * 这里只负责「换完之后怎么让它生效」。
 *
 * ⚠️★ 三件事**一件都不能少**：
 *   1. `I18N.apply` —— 把静态文案（`data-i18n*`）刷一遍；
 *   2. 把两颗**有状态**的按钮重画一遍 —— 它们的提示是动态的（`data-i18n-title`
 *      表达不了「切到浅色 / 切到深色」这种二选一），**`apply` 管不到它们**；
 *   3. `render(lastState)` —— 把**壳画的那部分**（房间名、条数、延迟、提示…）重画。
 *      ⚠️ 缺这一条的症状最难发现：静态那句变了、动态那句还是旧语种，
 *      看上去像「翻译漏了一半」。
 */
function applyLocale() {
  I18N.apply(document);
  setTheme(currentTheme());
  setSidebar(sidebarNarrow());
  renderComposerHint();
  // ⚠️★ 这一条是**页面之外**那几处（系统通知 / 托盘菜单 / 文件对话框标题）的唯一更新路径：
  // 它们由操作系统画，`I18N.apply` 碰不到。漏了的表现是「界面全变了、托盘还是旧语言」。
  pushShellMessages();
  if (lastState) render(lastState);
}

el('btn-lang').addEventListener('click', () => {
  // ⚠️ 只认「另一个」：现在两个语种，`=== 'en' ? 'zh' : 'en'` 就够 ——
  // 加到第三种时这里要改成「按 `I18N.LOCALES` 轮转」，别在这儿再抄一份语种清单。
  if (I18N.setLocale(I18N.locale() === 'en' ? 'zh' : 'en')) applyLocale();
});

/** 主界面顶部那条**一次性**提示（发不出去 / 存不上 / 配置有毛病）。
 *
 * ⚠️ 抽出来是因为同一段三行已经抄了三四遍 —— 而抄的时候最容易漏掉
 * `hidden = false`（漏了的症状是「设了文字但看不见」，而且不报错）。
 *
 * ⚠️★ **所有提示都归这个计时器收**（2026-09-30 改）：壳里来的那条（页面显示之后 ack 一次）
 * 与页面自己设的那几条**共用这一条路径**，而「结束」只有两个事件 —— 计时器到点，
 * 或者新的一条把它顶掉（后者覆盖前者是定下来的语义）。
 * ⚠️★ 别再从「快照里还有没有 notice」去收：那一拍是 `clear_notice` 之后的下一拍，
 * 照着 `null` 抹就会把刚显示的那条一闪抹掉 —— 上一版正是为它留了 `noticeVisible`
 * 那个补丁，现在整条路删掉了（判据 22 钉着「只有这一个所有者」）。
 *
 * ⚠️★ **3 秒**（Jonny 2026-09-27：「提示停留时间过长了，3s 就挺好的」）。
 * 原来写的是 15 秒，理由写的是「够看清、够去点一下」—— 那是**替用户做的取舍，而做错了**：
 * 一条只说了「刚才发生了什么」的提示挂十几秒，用户会开始怀疑它是不是当前状态
 *（「它到底还有效吗」），而且切个房间它还杵在那儿 —— 看起来就像**别的房间**的提示
 *（Jonny 同时报的「提示串房间了」有一半是这么来的：不是内容串了，是**它活得比
 * 你看那个房间的时间还长**）。真要留住的信息该进时间线 / 状态栏，不是靠一条提示挂久一点。
 *
 * ⚠️★★ 而且**壳里那条也归这里管**（2026-09-27 修）：`render` 那边只负责**喂**给它。
 */
let noticeTimer = null;

/** 这一条提示是在**哪个房间**下标下显示的（`null` = 现在没有提示）。
 *
 * ⚠️★ 2026-09-30 加（Jonny：「切到 B 房间，还挂着 A 房间那条提示」）：提示归房间
 *（壳里每个房间一格，`Room::notice`），而这一格长在**房间标题下面** ——
 * A 的「发出去了」挂在 B 的标题下，读起来就是 B 发的事。
 * 所以「换了房间」也是那条提示的**结束事件之一**（另两个：3 秒到点、新的一条顶掉），
 * 见 `render` 里那一句 `hideNotice()`。
 */
let noticeRoom = null;

const NOTICE_MS = 3000;

/** 显示一条提示。
 *
 * ⚠️★ **它不该再带房间名**（2026-09-27 改）：提示在壳里已经是**按房间各一格**
 *（`store` 的 `Room::notice`），`state.notice` 给出来的**就是当前选中房间那一条**
 * —— 这一格本来就长在那个房间的标题下面（`#notice` 在 `.main` 里），
 * 再写一遍房间名是**冗余**（`默认：已发到 1 个房间` 挂在「默认」的标题下）。
 *
 * ⚠️ 上一版是「全局一格 + 显示房间名」，那是**说清它串到哪儿去了**；
 * 现在是从**表示法上**让它不可能串（Jonny 2026-09-27：「房间的提示归每个房间」）。
 *
 * ⚠️ 内容（含用户配置里的自由文本）整句只走 `textContent`，绝不进 innerHTML。
 */
function showNotice(level, text) {
  const notice = el('notice');
  notice.hidden = false;
  notice.className = `notice ${level}`;
  notice.textContent = text;
  noticeRoom = lastState ? lastState.selected : null;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
    noticeTimer = null;
  }, NOTICE_MS);
}

/** 收起那条提示（换房间那一拍用，见 `noticeRoom`）。
 *
 * ⚠️★ 它和 `showNotice` 是**仅有的两个**碰 `#notice` 的函数（判据 22 钉着）——
 * 「谁显示谁计时」这条规矩在换房间这个场景下也要成立：上一条属于**上一个**房间。
 */
function hideNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  const notice = el('notice');
  notice.hidden = true;
  noticeRoom = null;
}

/** 这一份快照要不要重画 —— **只看版本号**。
 *
 * ⚠️★ 别在这里加任何字段：`Snapshot::version` 是「快照内容变没变」的**唯一**判据，
 * 而它什么时候前进由 `store.rs` 的 `Inner::touch` 负责（那边逐条写了前进规则）。
 * 在这个函数里再列一遍字段，就等于把「哪些字段参与判定」变成两份，漏一个就是静默失效。
 */
function shapeOf(state) {
  return String(state.version);
}

/** 一个元素。`text` 走 `textContent` —— ⚠️ 消息正文是**网络来的**，绝不能进 `innerHTML`。 */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ── 图标：内联 SVG ────────────────────────────────────────────────────────
 *
 * ⚠️★ 卡片脚那一排**不混用 emoji 与文字符号**（2026-10-03 Jonny：「统一…图标样式，
 * 现在的不好看」）。原来那一排是 `📋`（彩色 emoji）、`⚡`（彩色 emoji）、`↗`（**文字**箭头）、
 * `🗑`（彩色 emoji）—— 四颗三种来源：
 *   · emoji 的字面是**系统彩色字形**，粗细/基线/留白由字体决定，**不跟主题走**
 *     （深色主题下依然是一片饱和色块，而那排本该是弱化的次要操作）；
 *   · `↗` 是一个**文本字符**，字重与 emoji 完全不同，混在一起像「凑出来的」。
 * ⇒ 一套同一 `viewBox`(24)、同一线宽(2)、`stroke="currentColor"` 的图标：
 *   颜色自动跟着 `.lnk.ico` 的 `color` 走（悬停/置灰/选中都不用再写死颜色）。
 *
 * ⚠️ 别退回 emoji：要加图标就在这里加一条 path，**不要**在调用点直接写一个 emoji ——
 * 那一处立刻就会再次和别的图标不一致，而且没有任何判据看得见。
 * ⚠️ 这里的形状取自 Feather 那一套（MIT），只抄了 path 数据。 */
const ICON_PATHS = {
  // 复制：两张叠在一起的纸
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>'
    + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  // 动作库：闪电
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  // 下载：箭头落进托盘（Feather 的 `download`）
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
    + '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  // 放大：四角向外（Feather 的 `maximize-2`）
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>'
    + '<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  // 灯箱那两颗缩放按钮（Feather 的 `plus` / `minus`）。
  // ⚠️★ 它们**不用文字字形**（`+` / `−`）：字形在 22px 的方块里不居中 —— 位置按字体
  // 自己的基线走，全角 `＋` 与数学减号 `−` 的偏移还各不一样，于是两颗一上一下、
  // 看着像没对齐（Jonny 2026-10-04 一眼看出来了）。图标是**几何图形**，
  // `place-items: center` 一下就正中。
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  // 关闭（Feather 的 `x`）：与上面两颗同一个道理 —— 这一排四颗要长得像一套。
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  // 分享：一个向上的箭头从盒子里出去
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>'
    + '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
  // 删除：垃圾桶
  trash: '<polyline points="3 6 5 6 21 6"/>'
    + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
    + '<path d="M10 11v6M14 11v6"/>'
    + '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 造一颗图标。⚠️ 认不出的名字**当场抛**（画一个空白按钮＝用户以为那个功能没了）。
 *
 * ⚠️ 抛出来那句是**英文**：它是**给自己人看的**（调用点写错了名字），不是给用户的文案 ——
 * 而判据 15 要求 `app.js` 里的中文一律走 `t(…)`（同一个理由下 `'no tauri bridge'` 也是英文）。
 */
function icon(name) {
  const paths = ICON_PATHS[name];
  if (!paths) throw new Error(`unknown icon: ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // ⚠️ 图标是**装饰**：按钮自己已经有 `title` / `aria-label`（读屏读那个），
  // 这里再让读屏念一遍「图形」只是噪音。
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${paths}</svg>`, 'image/svg+xml');
  for (const child of [...parsed.documentElement.childNodes]) {
    svg.append(document.importNode(child, true));
  }
  return svg;
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

/** 带**日期**的时刻 —— 过期时间用它。
 *
 *  ⚠️★ `timeLabel` 只给到分钟、而且**不带日期**，那是给「今天收到的这条」用的。
 *  而一份文件可能**后天**才过期，只显示 `20:11` 是看不出哪一天的 —— 那正是
 *  「说过期了却看不出什么时候」的那类含糊。
 */
function dateTimeLabel(unixSeconds) {
  if (!unixSeconds) return '—';
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 这条文件条目**过期了吗**。
 *
 *  ⚠️★ 判据与服务端 `file_expired`（`handlers.rs`）**同一条**：`expire` 是**绝对时刻**
 *  （Unix 秒），`0` = 永不过期。`> 0` 那一半不能省 —— 省了的话「永不过期」会被算成过期
 *  （`0 < now` 恒真），于是**每一份文件都显示成过期**。
 *
 *  ⚠️★ 用**当前时间**现算，别让壳预先算好一个布尔发下来：快照是**会缓存**的，
 *  预先算好的那个值过一会儿就变成假话（而它看起来一模一样）。
 */
function entryExpired(entry) {
  return entry.expire > 0 && Date.now() / 1000 > entry.expire;
}

const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
// ⚠️ 视频只列**浏览器自己就能放**的那几种（`mkv` / `avi` 里的编码五花八门，
// 容器后缀认得出来不代表里面的流能播 —— 真放不出来时会走下面那个 `error` 回退）。
const VIDEO_SUFFIX = /\.(mp4|m4v|mov|webm)$/i;

/** 文件条目那一行（📄 + 名字 + 大小）。⚠️ 预览**加载不出来**时退回的也是它 ——
 *  两种情形画成同一个样子是对的：对用户来说都是「看不到内容，只知道有这么个文件」。
 *
 *  ⚠️★ 这一行**可点**（2026-10-04）：点下去把它存进下载目录，并在文件管理器里选中它。
 *  壳画不出 pdf / zip / docx，把用户踢给系统程序是上一版的行为，而它的实际后果是
 *  「点一下就离开应用」—— 他要的是拿到那份文件，不是看一个打不开的弹窗。
 */
/** 把这一条**存进下载目录，并在文件管理器里选中它**。
 *
 * ⚠️★ 只有一份（文件行的点击与灯箱里那颗「存下来」共用）：两处各写一遍的话，
 * 提示语、错误处理、以及「递什么给壳」三样都会漂 —— 而它们漂了都不报错。
 * ⚠️ 只递条目 id：地址与文件名都由壳从它自己的列表里查（收了地址就等于
 * 给页面一个「让壳去取任意 URL」的能力）。
 */
function saveEntryFile(entry) {
  return invoke('save_entry_file', { id: entry.id })
    .then((path) => showNotice('ok', t('已存到 {path}', { path })))
    .catch((error) => showNotice('error', t('存不下来：{error}', { error: errorText(error) })));
}

function fileRow(entry) {
  const row = h('div', 'filerow');
  // ⚠️★ 过期状态**必须看得见**（2026-10-04 Jonny：「桌面端也一样，显示文件的过期时间和状态，
  // 并且过期文件的下载按钮置灰」）。不标出来的话，点一下只会弹一句「存不下来」，
  // 而用户分不清是**过期了**还是网络坏了 —— 这两件事该做的事完全不同。
  const expired = entryExpired(entry);
  if (expired) row.classList.add('expired');
  row.append(h('div', 'fi', '📄'));
  const meta = h('div');
  meta.append(h('div', 'fn', entry.fileName || t('(没有文件名)')));
  const size = sizeLabel(entry.fileSize);
  if (size) meta.append(h('div', 'fs', size));
  // ⚠️ `0` = 永不过期 → **不显示这一行**（写「永久有效」等于给每一份文件都加一行废话）。
  if (entry.expire > 0) {
    meta.append(h('div', expired ? 'fs bad' : 'fs',
      expired ? t('已过期') : t('{time} 过期', { time: dateTimeLabel(entry.expire) })));
  }
  row.append(meta);
  row.title = expired ? t('已过期，存不下来了') : t('点开存到下载目录，并在文件管理器里选中它');
  // ⚠️★ 过期就**不给点**：点下去壳只会拿到服务端 404 的正文（`file_expired`），
  // 而那时弹出的是一句「存不下来」—— 一颗**看起来能点**的按钮才是真正的问题。
  if (!expired) row.addEventListener('click', () => saveEntryFile(entry));
  return row;
}

/** 图片 / 视频的预览。
 *
 * ⚠️★ 三件事都是「**不出声的坏**」，所以每一条都得写：
 *   · 图片不 `loading='lazy'`：一次进来 200 条时浏览器会把**所有**图都拉一遍
 *     （流量与卡顿都算在用户头上，而他只看得见最下面那几张）；
 *   · **载入失败不处理**：屏幕上留一个破图图标 —— 用户分不清「这个文件坏了」
 *     还是「界面画错了」，而这两件事该去的地方完全不同；
 *   · 视频不写 `preload='metadata'`：要么什么都不拉（点开才拉，第一帧是黑的），
 *     要么整段都拉（同上面那条流量问题）。
 * ⚠️ 不自动播放、不静音自动播：这条内容是要**看**的，不该自己动起来、更不该出声。
 * ⚠️ 点开走**壳内的灯箱**（`openLightbox`），不再叫系统程序打开。
 * ⚠️★ 地址可能是**回头问壳要**的（房间要密码时，见 `previewSrc`）—— 由 `loadPreviewSrc` 负责。
 */
function mediaPreview(entry) {
  const isVideo = VIDEO_SUFFIX.test(entry.fileName || '');
  const media = isVideo ? h('video', 'preview') : h('img', 'preview');
  if (isVideo) {
    // ⚠️ `playsinline`：iOS 上不给它就是「一点播放就全屏」，而这里要的是**在卡片里**看。
    media.controls = true;
    media.preload = 'metadata';
    media.playsInline = true;
  } else {
    // ⚠️ `title` 只给图片：视频那块点一下是**播放**，写着「点开看大图」就是一句假话
    //（视频的「放大」在画面右上角那颗按钮上，它自己带着提示）。
    media.title = t('点开看大图（原始大小）');
    media.loading = 'lazy';
    media.decoding = 'async';
    media.alt = entry.fileName || '';
  }
  // ⚠️★ 视频外面**套一层**（`.media`）：右上角那颗「放大」需要一个贴着**画面**的锚点。
  //   · 直接挂到卡片上 → 那颗按钮跑到**卡片**的右上角，与画面隔着 meta 那一行；
  //   · 挂到 `<video>` **里面**更不行 —— 替换元素（replaced element）的子节点不参与渲染。
  const node = isVideo ? h('div', 'media') : media;
  if (isVideo) node.append(media, mediaExpand(entry));
  media.addEventListener('error', () => {
    // ⚠️★ 换成文件行，而不是留一个破图在那儿 —— 见上面那条注释。
    // ⚠️ 换掉的是**最外层那个节点**：视频那份是 `.media` 这一层，只换里面的 `<video>`
    // 会留下一层空壳 + 一颗悬空的「放大」。
    node.replaceWith(fileRow(entry));
  });
  // ⚠️★ 视频**不挂**这个点击（2026-10-04 Jonny：「开始/暂停按钮会触发大屏预览，
  // 导致操作冲突」）：那个元素自己带着**播放条**，整块点击区是**它的**；
  // 视频的大号预览走画面右上角那颗「放大」（见 `mediaExpand`）。
  if (!isVideo) media.addEventListener('click', () => openLightbox(entry));
  loadPreviewSrc(media, entry, node);
  return node;
}

/** 视频画面**右上角**那颗「放大」（浮在画面上，见 `.card .media` 的样式）。
 *
 * ⚠️★ 为什么让它浮在画面上，而不是留在卡片脚那一排（2026-10-04 Jonny 拍的）：
 * 视频的**播放条**就在那个元素自己身上，而那一排按钮离画面隔着一段距离 ——
 * 「把这块画面放大」是一件针对**画面**的事，挨着画面才说得通。
 * ⚠️ 只给视频：图片没有播放条，点一下**整张图**就是放大（见 `mediaPreview` 里的分支），
 * 再挂一颗按钮就是同一个动作有两个入口。
 */
function mediaExpand(entry) {
  const button = h('button', 'expand');
  button.type = 'button';
  button.append(icon('expand'));
  button.title = t('打开大号预览');
  button.setAttribute('aria-label', t('打开大号预览'));
  button.addEventListener('click', (event) => {
    // ⚠️ 拦一下：这一下只管「开大号预览」，不该再冒到卡片那层去
    //（卡片上可真点的地方各管各的事，见 `entryActions` 的 `add` 同一套做法）。
    event.stopPropagation();
    openLightbox(entry);
  });
  return button;
}

/** 已经向壳要到的预览地址（条目 id → 能直接塞进 `src` 的地址）。
 *
 * ⚠️ 页面这一层也要缓存：卡片会重建（`repaint()` / 签名变了），
 * 不缓存就会为同一张图反复问壳（壳那边还有一层，但那也是一次 IPC + 一次查表）。
 * ⚠️★ 键只用 id 的前提是「它只在当前选中房间里找」——**换房间必须清掉**
 *（id 是每个房间各自单调的，见 `render` 里清展开态那一处）。
 */
const previewSrcs = new Map();

/** 一个**能直接当 `src` 用**的预览地址。
 *
 * ⚠️★ 两条来源（见 `EntryView::preview_needs_token`）：
 *   · 快照里给了 `previewUrl` → 那是**不要密码的房间**的裸地址，直接用，一次网络都不用；
 *   · 没给 → 房间要密码，而 `<img src>` / `<video src>` **带不了 `Authorization` 头**
 *     （裸地址一定 401，而 `<img>` 的 error 会把它静默换成一介文件行）——
 *     必须回头问壳要一条**带只读令牌**的地址。
 */
async function previewSrc(entry) {
  if (entry.previewUrl) return entry.previewUrl;
  const cached = previewSrcs.get(entry.id);
  if (cached) return cached;
  const url = await invoke('preview_url', { id: entry.id });
  if (typeof url === 'string' && url) previewSrcs.set(entry.id, url);
  return typeof url === 'string' ? url : '';
}

/** 把 `src` 装上 —— 需要的话先问壳要地址；取不到就退回文件行，**并且说一句**。
 *
 * ⚠️★ 不许静默：静默的表现是「一张永远空着的框」或者「一行 📄」，
 * 而真因（令牌签不出来 / 密码不对 / 这一条已经不在了）没人知道。
 *
 * ⚠️★ `swap` 是「出了事要换掉的那个节点」—— 图片就是 `<img>` 自己，视频是外面那层
 * `.media`（只换里面的 `<video>` 会留下一层空壳 + 一颗悬空的「放大」）。
 */
function loadPreviewSrc(media, entry, swap) {
  const direct = entry.previewUrl || '';
  if (direct) {
    media.src = direct;
    return;
  }
  // ⚠️★ 等到**真的进入视口**再问（见 `whenVisible`）：预览令牌是一次网络请求
  //（远端服务端就是一次往返），而列表里大多数条目用户根本没看 —— 为看不见的东西
  // 签令牌，用户那边什么都不会多出来，只会在「分享记录」里多出一串他自己没签过的。
  whenVisible(media, () => {
    previewSrc(entry)
      .then((url) => {
        if (!url) {
          showNotice('error', t('previewTokenFailed'));
          swap.replaceWith(fileRow(entry));
          return;
        }
        media.src = url;
      })
      .catch((error) => {
        showNotice('error', t('取不到预览地址：{error}', { error: errorText(error) }));
        swap.replaceWith(fileRow(entry));
      });
  });
}

/** 等这个元素**进入视口**再跑一次（跑完就断开）。
 *
 * ⚠️★ 用它而不是「渲染时就问」：见 `loadPreviewSrc` 里那段（令牌要一次网络请求）。
 * ⚠️ 拿不到 `IntersectionObserver`（老 webview）就**直接跑** —— 宁可多问一次，
 * 也不要让图片永远不显示。
 * ⚠️ 观察器挂在这个节点上（`__previewObserver`）：卡片被丢掉时要断开
 *（`renderTimeline` 里那一处），不然观察器会一直拽着那个节点不放。
 */
function whenVisible(node, run) {
  if (typeof IntersectionObserver !== 'function') {
    run();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((one) => one.isIntersecting)) return;
    observer.disconnect();
    run();
  });
  node.__previewObserver = observer;
  observer.observe(node);
}

/** 灯箱现在放大到几倍（`1` = 恰好放得下）。
 *
 * ⚠️★ 这是**灯箱自己的**状态，与条目无关：开下一条 / 关掉都归 1（`lbResetZoom`）——
 * 留着上一条的倍数，下一条打开时就是「莫名其妙放得很大」。
 */
let lbZoom = 1;

/** 这一条在 `zoom === 1` 时该画多大（按它**自己的**固有尺寸缩到灯箱里）。
 *
 * ⚠️ `null` = 还没量出来（图没加载完 / 视频还没有元数据）—— **那时不许缩放**：
 * 拿「屏幕上现在这个尺寸」当基准是最常见的写法，但那个尺寸已经被上限缩过一次，
 * 于是滚一格就得到一个完全对不上的倍率。
 */
let lbFit = null;

/** 点一次 ＋ / − 走几倍（滚轮走的是连续值，见那条 `wheel` 监听）。 */
const LB_ZOOM_STEP = 1.25;

/** 缩放的上下限（`0.1` = 缩到十分之一，`8` = 放大到八倍）。
 * ⚠️ 要有上限：没有它，滚轮多转几下就是几百倍 —— 那张图会变成一块纯色，
 * 而用户**没有任何办法**回到看得见的状态（只能关掉重开）。 */
const LB_ZOOM_MIN = 0.1;
const LB_ZOOM_MAX = 8;

/** 壳内灯箱：点开一条图片 / 视频，在**壳里**看原始大小。
 *
 * ⚠️★ 为什么**不再**交给系统默认程序（2026-10-04 之前的行为）：那一下把用户**踢出应用**
 * 去看一张图，而图在这里本来就看得全 —— 为了少写一层浮层付这个代价不划算。
 *
 * ⚠️★ 大图 / 大视频靠**浏览器自己流式拉**：地址直连服务端 `/file/<uuid>`，那一端是
 * `ServeFile`（支持 Range，见 `files.rs`），于是拖动进度条只取那一段、内存里也不落整份。
 * ⚠️ 反过来**不要**照网页版 `File.vue` 那条 `axios({ responseType: 'arraybuffer' })` 的做法：
 * 它把整份字节读进内存再转成 Blob —— 一个 200MB 的视频就是 200MB 常驻，还把 Range 丢了。
 *
 * ⚠️ 那一行「正在载入」是给**大文件**看的：小图一瞬间就到，而几百兆的那份
 * 在 `load` 之前是**一块空白** —— 没有它，用户会以为点开了个空窗口。
 * ⚠️★ 地址可能是**回头问壳要**的（带密码的房间）—— 所以这里是**异步**拿到 `src` 的：
 * 先挂「正在载入」、拿到再设；设一个空串会立刻算一次加载失败。
 */
function openLightbox(entry) {
  const box = el('lightbox');
  const stage = el('lightbox-stage');
  if (!box || !stage) return;

  const isVideo = VIDEO_SUFFIX.test(entry.fileName || '');
  el('lightbox-name').textContent = entry.fileName || '';

  stage.replaceChildren();
  // ⚠️★ 每开一条都从「恰好放得下」开始：上一条转过的倍数**不带过来**
  //（否则下一条一打开就是「莫名其妙放得很大」，而且那时还没有可滚动的余量）。
  lbResetZoom();
  const loading = h('div', 'lb-load', t('正在载入…'));
  stage.append(loading);

  const media = isVideo ? h('video') : h('img');
  if (isVideo) {
    media.controls = true;
    media.preload = 'metadata';
    media.playsInline = true;
  } else {
    media.alt = entry.fileName || '';
    // ⚠️ 关掉原生的「拖图」：不给它，按住一拖跟着指针走的是浏览器那个半透明的缩略图，
    // 而我们的平移一行都没执行（见 `.lb-stage img` 那条 CSS）。
    media.draggable = false;
    lbBindPan(stage, media);
  }
  // ⚠️★ 加载完（图 `load` / 视频 `loadedmetadata`）做两件事：摘掉那行「正在载入」，
  // 以及**量一次固有尺寸** —— 量到之前滚轮什么也不做（见 `lbFit`）。
  // ⚠️ 出错也要摘：否则用户盯着一行「正在载入…」永远等下去（那条内容其实取不回来）。
  const settle = () => {
    loading.remove();
    if (lbMeasure(media)) lbApplyZoom(1);
  };
  media.addEventListener('load', settle);
  media.addEventListener('loadedmetadata', settle);
  media.addEventListener('error', () => {
    loading.remove();
    stage.append(h('div', 'lb-load', t('这一条取不回来（可能已经被删了）')));
  });
  media.addEventListener('click', (event) => event.stopPropagation());

  // ⚠️★ 地址先问一次（开放房间就是快照里那份裸地址，一次网络都不用）——
  // 拿到之后再设 `src`。
  previewSrc(entry)
    .then((url) => {
      if (!url) {
        loading.remove();
        stage.append(h('div', 'lb-load', t('previewTokenFailed')));
        return;
      }
      media.src = url;
      stage.append(media);
    })
    .catch((error) => {
      loading.remove();
      stage.append(h('div', 'lb-load', t('取不到预览地址：{error}', { error: errorText(error) })));
    });

  box.hidden = false;
}

/** 回到「恰好放得下」，并把那颗百分比复位（开一条新的 / 关掉时都走它）。 */
function lbResetZoom() {
  lbZoom = 1;
  lbFit = null;
  const pct = el('lightbox-zoom-reset');
  if (pct) pct.textContent = '100%';
}

/** 量一次「恰好放得下」的尺寸（`lbFit`）。
 *
 * ⚠️★ 量的是**固有尺寸**（`naturalWidth` / `videoWidth`），基准框是 `.lb-stage` 的
 * `clientWidth` / `clientHeight` —— 那一层的大小是**定死的**（`flex: 1` + `overflow: auto`，
 * 内容撑不大它），所以这两个数就是「放得下」的定义，不依赖此刻画成了多大。
 * ⚠️ 拿屏幕上那个尺寸当基准是另一条常见的写法，但它已经被上限缩过一次：滚一格得到的
 * 倍率与用户以为的对不上（而且越滚越小）。
 * ⚠️ 量不到（字节还没到 / 视频没有元数据）→ `false`，调用方据此**先不许缩放**。
 */
function lbMeasure(media) {
  const stage = el('lightbox-stage');
  if (!stage || !media) return false;
  const natural = media.tagName === 'VIDEO'
    ? { w: media.videoWidth, h: media.videoHeight }
    : { w: media.naturalWidth, h: media.naturalHeight };
  if (!natural.w || !natural.h) return false;
  const scale = Math.min(1, stage.clientWidth / natural.w, stage.clientHeight / natural.h);
  if (!(scale > 0)) return false;
  lbFit = { w: natural.w * scale, h: natural.h * scale };
  return true;
}

/** 画面比容器小的时候它离**滚动起点**多远（居中）；比容器大时是 0（贴左上）。
 *
 * ⚠️★ 这两个偏移量是「指针底下那一点不动」那套算式的必需品：居中状态下 `scrollLeft`
 * 是 0，而画面并不是从容器左边开始的 —— 少减这一项，指针不在正中间时缩放就会偏。
 * ⚠️ 与 CSS 那边 `margin: auto` 是同一条规矩（那边把画面居中，这边把它算回来）。
 */
const lbOffset = (size, box) => (size >= box ? 0 : (box - size) / 2);

/** 缩到 `next` 倍。`anchor` 是**指针在容器里的坐标**（不给就用容器正中）。
 *
 * ⚠️★ 为什么缩放要围着指针转：看图工具的标准手感 —— 指针停住的那块细节，放大之后**还在
 * 指针底下**。不这么做（围着正中缩放）的话，想看清右上角就得「放大 → 拖 → 放大 → 拖」，
 * 每放一次都要重新找位置。
 * ⚠️ 做法是把「指针底下那一点在画面里的相对位置」先记下来，换完尺寸再把滚动位置摆回去
 *（`scrollLeft` 是整数像素，所以是「基本不动」而不是「一个像素都不差」）。
 */
function lbApplyZoom(next, anchor) {
  const stage = el('lightbox-stage');
  const media = stage ? stage.querySelector('img, video') : null;
  if (!media || !lbFit) return;
  const box = { w: stage.clientWidth, h: stage.clientHeight };
  const zoom = Math.min(LB_ZOOM_MAX, Math.max(LB_ZOOM_MIN, next));
  const before = { w: lbFit.w * lbZoom, h: lbFit.h * lbZoom };
  const after = { w: lbFit.w * zoom, h: lbFit.h * zoom };
  const at = anchor || { x: box.w / 2, y: box.h / 2 };
  const keep = {
    x: (stage.scrollLeft + at.x - lbOffset(before.w, box.w)) / before.w,
    y: (stage.scrollTop + at.y - lbOffset(before.h, box.h)) / before.h,
  };
  lbZoom = zoom;
  media.style.width = `${Math.round(after.w)}px`;
  media.style.height = `${Math.round(after.h)}px`;
  // ⚠️★ 把 CSS 那两条上限内联掉：留着它们，**放大**时会被 `max-width: 100%` 顶回来
  //（症状：滚轮转了、读数也变了，画面纹丝不动 —— 最难查的一类）。
  media.style.maxWidth = 'none';
  media.style.maxHeight = 'none';
  stage.scrollLeft = keep.x * after.w + lbOffset(after.w, box.w) - at.x;
  stage.scrollTop = keep.y * after.h + lbOffset(after.h, box.h) - at.y;
  const pct = el('lightbox-zoom-reset');
  if (pct) pct.textContent = `${Math.round(zoom * 100)}%`;
}

/** 放大之后可以用指针**拖着看**（为什么非有不可，见 `.lb-stage img` 那条 CSS）。 */
function lbBindPan(stage, media) {
  media.addEventListener('pointerdown', (event) => {
    // ⚠️ 只有左键、而且**确实有东西可移**时才接管：没放大时按下去不该有任何反应。
    if (event.button !== 0 || !lbOverflows()) return;
    const from = {
      x: event.clientX,
      y: event.clientY,
      left: stage.scrollLeft,
      top: stage.scrollTop,
    };
    let moved = false;
    const move = (one) => {
      // ⚠️ 4px 门槛：小于它不许动 —— 于是「点一下」还是点一下（缩放过的图也点得中），
      // 而拖动一定是真的在拖（不然手一抖就把画面蹭走半个像素）。
      if (!moved && Math.abs(one.clientX - from.x) + Math.abs(one.clientY - from.y) < 4) return;
      moved = true;
      stage.scrollLeft = from.left - (one.clientX - from.x);
      stage.scrollTop = from.top - (one.clientY - from.y);
    };
    const up = () => {
      media.removeEventListener('pointermove', move);
      media.removeEventListener('pointerup', up);
      media.removeEventListener('pointercancel', up);
    };
    // ⚠️ 抓住指针：滑出画面之后事件仍然归它（不抓的话，往窗外一拖就断了，
    // 而用户以为「拖不动」）。
    if (media.setPointerCapture) media.setPointerCapture(event.pointerId);
    media.addEventListener('pointermove', move);
    media.addEventListener('pointerup', up);
    media.addEventListener('pointercancel', up);
  });
}

/** 画面比容器大吗（也就是「有没有东西可以移」）。 */
function lbOverflows() {
  const stage = el('lightbox-stage');
  if (!stage) return false;
  return stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight;
}

function closeLightbox() {
  const box = el('lightbox');
  if (!box) return;
  box.hidden = true;
  // ⚠️★ 关掉就**清空**：留着 `<video>` 在隐藏的层里，它会继续占着那条连接
  // （`preload='metadata'` 已经拉过一次了），下次开是另一条内容时还会先闪一下旧的。
  el('lightbox-stage').replaceChildren();
  // ⚠️ 倍数一起忘掉：它跟的是**上一条**画面的大小，留着没有任何意义
  //（下一条一打开就会按那个倍率画，而它的固有尺寸完全是另一回事）。
  lbResetZoom();
}

/** 一张卡片。 */
function renderEntry(entry) {
  const card = h('div', entry.mine ? 'card me' : 'card');
  // ⚠️★ 卡片带上**条目 id**：整条时间线被重画之后（`repaint()`）卡片是新的节点，
  // 要按这个 id 把那一张找回来 —— 见 `holdCardPosition`（还原 / 跑动作都靠它定位）。
  card.dataset.id = String(entry.id);

  if (entry.kind === 'file') {
    // ⚠️ 预览只认**壳拼出来的**地址（`EntryView::from_holder` 用这个房间自己的服务端），
    // 而且只认图片 / 视频；别的按文件条目显示。
    // 一个非 http 的地址（配置被人手改坏）不许进 `src`。
    const url = entry.previewUrl || '';
    const name = entry.fileName || '';
    // ⚠️★ 两个来源：`previewNeedsToken` 为真时快照里**故意没有地址**
    //（房间要密码，裸地址一定 401，见 `EntryView::preview_needs_token`）——
    // 那种情况这里照样要画媒体，地址由 `mediaPreview` 回头问壳要。
    const ask = entry.previewNeedsToken === true;
    if ((ask || url.startsWith('http')) && (IMAGE_SUFFIX.test(name) || VIDEO_SUFFIX.test(name))) {
      card.append(mediaPreview(entry));
    } else {
      card.append(fileRow(entry));
    }
  } else {
    // ⚠️★ 这里的 `entry.text` 是**截断预览**（壳只给这么多，见 `EntryView::for_snapshot`）。
    // 展开过的那些改用取回来的全文来画（`openedBodies`），所以**下一次重绘不会把它收回去**。
    // ⚠️ 两处规则要一致（这里与 `toggleEntry`），不一致的表现是「展开之后过一会儿自己收起来」。
    //
    // ⚠️★ 跑过动作的那条，画的是**动作的结果**（而且那份结果是用全文跑出来的）。
    const viewed = actionViews.get(entry.id);
    if (viewed) {
      // ⚠️★ `render: 'html'` 那两条（markdown / 代码高亮）返回的是 **HTML**，只能走
      // `innerHTML` —— 走 `textContent` 的话用户看到的是一整屏 `<p>…</p>` 标签。
      // ⚠️★ 但它是**已经消过毒**的 HTML：消毒在动作实现包里（`util.js` 的
      // `renderMarkdownHtml` 过 DOMPurify），这一侧**不自己也来一遍**（第二份消毒 =
      // 第二套规则，两套规则早晚漂移）。「包里一定有 DOMPurify」由同步工具在构建时断言。
      // ⚠️★ 「画什么」用 `htmlText`（没有就是 `output`），「怎么画」用 `html` ——
      // 两个不能合成一个：双表示那条（注音制表）的 `output` 是**复制用**的纯文本，
      // 真要画的是另一份 HTML —— 拿 output 去 innerHTML 就恰好是「表格没出来，只出了一行 tab」。
      const box = h('div', 'txt actout');
      if (viewed.html) {
        box.innerHTML = viewed.htmlText;
        // ⚠️★ 颜色是**回头补**的（marked 的 renderer 同步、高亮器只能按需加载）：
        // 先按没颜色画出来（代码本来就是转义好的纯文本，看得见），chunk 回来了再上色。
        // 与网页版 `MarkdownBody.vue` 走的是 `highlight.js` 里同一个函数。
        window.ActionLibrary.highlightIn(box);
      } else {
        box.textContent = viewed.output;
      }
      card.append(box);
    } else {
      const open = openedIds.has(entry.id);
      card.append(h('div', open ? 'txt open' : 'txt', openedBodies.get(entry.id) ?? entry.text));
    }
  }

  const foot = h('div', 'ft');
  // ⚠️ 发送端没给设备信息时（老条目 / 定时消息）**不编一个名字** ——
  // 服务端专门为无 UA 的定时消息塞了 `type: "Automation"`，这里照它给的显示。
  //
  // ⚠️★ 自己发的**也显示客户端名**（2026-09-29，Jonny：「桌面客户端的列表页把我发的也
  // 改为对应客户端」）：壳现在会把「macOS 桌面客户端」这类名字带上去（`?name=`，
  // 见 `rust/crates/desktop/src/store.rs` 的 `default_device_name`），
  // 所以自己那条的 `entry.device` 也是有值的 —— 从前写死的「本机」只留作兜底。
  //
  // ⚠️★ `Automation` 是服务端给「既没有 UA 又没有名字」的来源塞的**类型名**
  //（`handlers.rs` 的 `sender_base`）：桌面端在 2026-09-29 之前正是这个样子，
  // 所以**自己**的历史条目里躺着一批。对它来说 `Automation` 就是「没名字」，
  // 照实显示会变成一行 `Automation · 19:20` —— 看着像**另一个人**发的。
  // 别人发的照实显示（定时 / 补发那些消息靠的就是它，见上一段）。
  const senderName = entry.mine && entry.device === 'Automation' ? '' : entry.device;
  foot.append(h('span', null, senderName || (entry.mine ? t('本机') : t('未知设备'))));
  foot.append(h('span', null, '·'));
  foot.append(h('span', null, timeLabel(entry.timestamp)));
  // ⚠️★ **只剩「剪贴板同步」这一条标签了**（2026-09-29，Jonny：「把桌面客户端列表页的
  // 「我发的」删掉」）。原来是二选一（`fromClipboard` 决定画哪一条）——
  // 「我发的」现在**一点信息量都没有**：脚注第一格已经写着客户端名（`macOS 桌面客户端`），
  // 而卡片本身还有 `me` 那个类管外观。留着它，等于每条自己的消息后面都跟四个字的废话。
  //
  // ⚠️★ 但「剪贴板同步」**不能跟着一起删**：它说的是「这条不是在这个窗口里敲的 /
  // 拖进来的，而是本机剪贴板被复制之后同步过去的」—— 服务端**不知道**这件事，是本机记的
  //（`EntryView::from_clipboard`）。少了它，用户看着一条自己刚复制的东西被列出来
  // 会以为是自己误发的。
  if (entry.mine && entry.fromClipboard) {
    foot.append(h('span', 'spacer'));
    foot.append(h('span', 'tag', t('剪贴板同步')));
  }
  // ⚠️ 定时 / 补发**必须**标出来：`source` / `late` / `scheduledAt` 三个字段是
  // 2026-09-26 才补进 `/content` 投影的，漏掉它们的症状是「看不出这条是自动发的」。
  if (entry.automation) {
    foot.append(h('span', 'spacer'));
    const tag = h('span', 'tag auto', entry.late ? t('自动·补发') : t('自动'));
    // ⚠️★ 预定时刻**搬到 `title` 上**（§8.9 那条规矩：不丢掉、也不占画面）。
    // ⚠️★ 这一段是 2026-09-28 补的，而它补的是**一个躺了三天的洞**：
    //    `scheduledAt` 从 2026-09-26 起就在快照里，但这个文件里**只有上面那句注释
    //    提到过它** —— 字段一直在发，界面上一个像素都不差、不报错，只是那一块功能**没有**。
    //    现在由判据 19 盯着「`EntryView` 的每个字段都要在 `renderEntry` 里读一次」。
    if (entry.scheduledAt > 0) {
      tag.title = t('预定 {time}', { time: timeLabel(entry.scheduledAt) });
    }
    foot.append(tag);
  }
  if (entry.kind === 'file') {
    foot.append(h('span', 'spacer'));
    foot.append(h('span', 'tag', t('文件')));
  }
  // ⚠️★ 长文默认**截断**（CSS clamp 12 行），这里给一个「展开 / 收起」。
  // ⚠️ 判据用**字节数**而不是「量一下高度」：量高度要为每张卡片强制排版一次
  //（200 张 = 200 次），而算术不碰 DOM。
  // 代价是**偶尔**点开之后看不到变化（那条恰好没被 clamp 住）—— 但按钮会变成「收起」，
  // 所以那是「点了有反应但没必要」，不是「点了没反应」（后者才是这个项目最忌讳的）。
  //
  // ⚠️ 跑过动作的那条**不给这个按钮**：那时卡片上画的已经是结果，展开原文只会让人更糊涂
  //（展开的是「结果」，而这个按钮的文案说的是「展开全文」）。还原之后它自己回来。
  if (entry.kind === 'text' && !actionViews.has(entry.id)
      && (entry.truncated || entry.textBytes > EXPANDABLE_BYTES)) {
    const toggle = h('button', 'lnk', expandLabel(entry));
    toggle.addEventListener('click', () => toggleEntry(card, entry, toggle));
    foot.append(h('span', 'spacer'), toggle);
  }
  const viewed = actionViews.get(entry.id);
  if (viewed) {
    // 单独一行，**不再塞一个 `.spacer`** 进脚注：那一行里可能已经有一两个 spacer，
    // 再加会把本来靠右的图标推到中间（同 `.acts` 用 `margin-left: auto` 的理由）。
    const bar = h('div', 'actbar');
    bar.append(h('span', 'tag', viewed.label));
    const back = h('button', 'lnk', t('还原'));
    back.addEventListener('click', () => {
      // ⚠️★ 还原走的是**整条重画**（`repaint()`）—— 卡片会换成新节点，所以这里传**条目 id**：
      // 传这张（`card`）的话，`holdCardPosition` 事后量的是一个已经被丢掉的节点（顶边 0），
      // 于是「偏移」算出几千像素、视口被拨走 —— 点了「还原」反而找不着那条消息。
      holdCardPosition(String(entry.id), () => {
        actionViews.delete(entry.id);
        repaint();
      });
    });
    bar.append(back);
    card.append(bar);
  }
  foot.append(entryActions(entry));
  card.append(foot);
  return card;
}

/** 重画时间线（动作结果变了 / 还原时用）。
 *
 * ⚠️ 走 `render(lastState)` 这条**正路**，不就地改 DOM：就地改的那份活不过下一次轮询
 * （700ms 后整个时间线会被重画），于是「跑出来的结果自己变回原文」。
 */
function repaint() {
  if (lastState) render(lastState);
}

/* ── 卡片脚那三颗图标（复制 / 分享 / 删除）─────────────────────────────────
 *
 * ⚠️★ 三颗都走**壳命令**，页面上不碰 `navigator.clipboard`，两个理由都不是风格：
 *   ① 页面手里那份是**截断预览**（`EntryView::for_snapshot`）—— 复制/分享要的是**全文**，
 *      拿预览去复制会把长文截断，而且**不报错**（用户粘出来才发现少了半截）；
 *   ② 写剪贴板之前壳会先 `prime` 去重指纹 —— 不走壳的话，监控线程会把这一行当成
 *      一次**新的复制**、又发回房间（用户只想分享一下，房间里却多出一条）。
 *
 * ⚠️★ 这里**曾经**是一份右键菜单（复制内容 / 复制链接），2026-09-29 Jonny 要求移除
 *（「列表内容页移除右键菜单」），当时的理由是「网页视图里的卡片自己带复制按钮，
 * 桌面这份紧凑列表不再需要」。**那条理由在 2026-10-01 之后不成立了** —— 那天起桌面端
 * **默认落在列表**，一个从不切到「网页」的人就没有任何入口。所以入口放回列表，
 * 形态改成一行图标（**不是**把右键菜单搬回来）。
 *
 * ⚠️ 三颗的行为**对齐网页版那三颗**：删除**不**二次确认（网页版也不确认，删完出一条提示）。
 * 两套界面同一颗按钮有两种行为，比误删一次更麻烦 —— 要改就两边一起改。
 */
function entryActions(entry) {
  const acts = h('div', 'acts');

  /** 加一颗。⚠️ `stopPropagation`：这一下不能冒泡到条目/房间那层的点击处理上。
   *
   * ⚠️ `name` 是 `ICON_PATHS` 里的名字（**不是**一个字形字符串）：那一排必须同源同规格，
   * 颜色交给 CSS（`.lnk.ico` 的 `color`），所以这里不设任何颜色/字号。
   */
  function add(name, label, run) {
    const button = h('button', 'lnk ico');
    button.append(icon(name));
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run(button);
    });
    acts.append(button);
    return button;
  }

  /** 点一下 → 禁用 → 跑 → 恢复。⚠️ **只**管这四件事，成功/失败的话各自在调用点说 ——
   *
   * ⚠️★ 别把「失败的句子」当参数传进来（`once(button, '复制不了：{error}', …)`）：
   * 那样中文就成了一处**裸字面量**，而判据 15 专门扫这个（它会红，而且红得对 ——
   * 从字面量上看不出它将来会被 `t()` 翻掉）。句子留在调用点的 `t(…)` 里。
   */
  function once(button, run) {
    button.disabled = true;
    return Promise.resolve(run()).finally(() => {
      button.disabled = false;
    });
  }

  // ⚠️★ **文件条目没有复制**（2026-10-04）：
  //   · 它根本没有正文（`EntryView::text` 对文件条目是空串），`copy_entry` 于是走到
  //     `copy_to_clipboard("")` —— 那个函数**空串直接 return**，所以那是一颗
  //     **点了没反应**的按钮（这个项目最忌讳的一类）；
  //   · 网页版也一致：`File.vue` 那一排只有下载 / 预览 / 分享 / 删除，没有复制。
  // ⚠️ 于是「复制动作的结果」那条分支也只在文本条目上出现（动作库本来就只给文本条目）。
  const viewed = actionViews.get(entry.id);
  if (entry.kind === 'text') {
    // ⚠️★ 跑过动作时，📋 复制的是**卡片上那份结果**（`copy_to_clipboard` 直接收文本）。
    // 反过来（还去复制原文）的症状是「屏幕上明明是天梯图/大写的，粘出来是原来的」——
    // 而复制这条命令在文档里写的就是「复制这一条」，不复制「你看的那一份」是说不通的。
    add('copy', viewed ? t('复制动作的结果') : t('复制这条'), (button) => {
      const copy = viewed
        ? () => invoke('copy_to_clipboard', { text: viewed.output })
        : () => invoke('copy_entry', { id: entry.id });
      once(button, copy).catch((error) => {
        showNotice('error', t('复制不了：{error}', { error: errorText(error) }));
      });
    });
  }

  // 动作库：只有文本条目才有（文件条目的正文是一串文件名，跑「转大写」没有意义）。
  if (entry.kind === 'text') {
    const actionButton = add('bolt', t('给这条跑个动作'), () => openActionMenu(actionButton, entry));
    if (viewed) actionButton.classList.add('on');
  }

  // ⚠️★ 文件条目要有**一颗下载**（2026-10-04 Jonny：「点击预览，下载单个放个下载按钮」）。
  // 为什么非有不可：图片 / 视频的卡片上画的**就是那条媒体本身**，点它是**预览**（壳内灯箱）
  // —— 于是「非图非视频」那种 📄 文件行（点一下存到下载目录）在媒体条目上**根本不存在**，
  // 媒体的存盘入口只剩从前那条「叫系统程序打开」（而它已经按 Jonny 的要求换成灯箱了）。
  //
  // ⚠️ 走壳的 `save_entry_file`，与文件行**同一个入口**（`saveEntryFile`）：
  // 地址 / 文件名 / 凭据全在壳里查，页面只递 id。
  // ⚠️ 用 `once` 禁用它：存一个大文件要一会儿，禁掉才不会点出第二份
  //（`unique_path` 会老老实实存成 `报告 (1).pdf`）。
  if (entry.kind === 'file') {
    // ⚠️★ 过期的**置灰**（2026-10-04 Jonny：「过期文件的下载按钮置灰」）——
    // 与网页版标准模式（`received-item/File.tsx` 的 `disabled={expired || downloading}`）同一套。
    // ⚠️ 灰掉**不是**为了好看：过期文件的字节在服务端已经没了，点下去只会拿到 404 的正文
    // 并被报成「存不下来」—— 那等于把「过期」说成了「出错了」。
    // ⚠️ 这里**不能**用 `once`（它会在 finally 里把 `disabled` 恢复成 false）——
    // 所以下面那颗按钮不用 `once` 包，禁用它靠 `entryExpired` 现算。
    const expired = entryExpired(entry);
    const download = add('download', expired ? t('已过期') : t('存到下载目录，并在文件管理器里选中它'), (button) => {
      once(button, () => saveEntryFile(entry));
    });
    if (expired) download.disabled = true;
    // ⚠️★ 视频的「放大」**不在这里**（2026-10-04 Jonny：「视频的放大预览图标浮动在
    // 视频的右上角」）—— 它在画面右上角那颗浮着的按钮上，见 `mediaPreview` / `mediaExpand`。
    // 那一排按钮与画面隔着 meta 一行，而「放大这块画面」挨着画面才说得通。
  }

  // ⚠️★ 以前这里是「点一下直接建一个默认链接」—— 网页那颗分享按钮有完整的配置画面
  //（有效期 / 次数 / 密码），两处不一致的结果是「同一份内容，手机上能设密码、桌面不能」。
  // 现在走同一条路：先填，再生成。默认值就是**旧的**那三个（默认有效期 / 不限 / 无密码），
  // 所以「点一下就分享」这条路并没有断 —— 只是中间多了一屏可以改的东西。
  add('share', t('生成分享链接并复制'), () => openShareForm(entry));

  add('trash', t('删除这条'), (button) => {
    once(button, () => invoke('delete_entry', { id: entry.id }))
      .then(() => {
        showNotice('ok', t('已从房间里删掉。'));
        // ⚠️ 删完**立刻取一次**：下一次轮询要等 700ms，而这一条已经不在服务端了 ——
        // 等轮询的话，那 700ms 里界面上还挂着一条已经删掉的内容。
        refreshNow();
      })
      .catch((error) => {
        showNotice('error', t('删不掉：{error}', { error: errorText(error) }));
      });
  });

  return acts;
}

/* ── 动作库：菜单与执行 ─────────────────────────────────────────────────
 *
 * ⚠️★ 「一份实现、两侧共用」在**这一侧**的落点：动作的**实现**在 `actions-pure.js`
 * （由 `tools/sync-action-catalog.mjs` 从 `web-vue3/src/data/actions/pure.js` 逐字节搬来），
 * 声明在 `actions-catalog.json`，文案在 `actions-labels.json`。这个文件里**没有任何动作实现**。
 *
 * ⚠️★ 加载不了的（要 marked / highlight.js / opencc / pinyin 的那几条）**置灰 + 说明**，
 * 不隐藏 —— 隐藏会让人以为功能不存在（同 `ActionPicker.vue` 的既有约定）。
 */

let actionMenu = null;
/** 「填参数」那个面板（同一时刻只会开一个；没有就是 null）。 */
let actionForm = null;

/** 关掉动作菜单。点了外面、按了 Esc、或选中一条之后都会走这里。 */
function closeActionMenu() {
  if (!actionMenu) return;
  actionMenu.panel.remove();
  document.removeEventListener('mousedown', actionMenu.onOutside, true);
  document.removeEventListener('keydown', actionMenu.onKey, true);
  actionMenu = null;
}

/** 开动作菜单。
 *
 * ⚠️★ 用 `position: fixed` 挂在 `body` 上，坐标由**按钮的矩形**算出来 ——
 * 不用「卡片里的绝对定位」：卡片住在一个 `overflow: auto` 的滚动容器里，绝对定位的子元素
 * 会被那个容器裁掉（表现是「菜单下半截看不见，还得先滚一下」）。
 */
async function openActionMenu(anchor, entry) {
  closeActionMenu();

  let library;
  try {
    library = await window.ActionLibrary.ensure();
  } catch (error) {
    // ⚠️ 加载失败要**说出来**：一声不响的按钮＝用户以为这个功能不存在。
    showNotice('error', t('动作库没加载起来：{error}', { error: errorText(error) }));
    return;
  }

  const panel = h('div', 'actmenu');
  const header = h('div', 'actmenu-hd');
  header.append(h('span', null, t('动作')));
  const close = h('button', 'lnk', '×');
  close.addEventListener('click', closeActionMenu);
  header.append(close);
  panel.append(header);

  const body = h('div', 'actmenu-bd');
  for (const group of library.groups) {
    const items = library.actions.filter((one) => one.group === group.key && one.direction === 'view');
    if (!items.length) continue;
    body.append(h('div', 'actgroup', window.ActionLibrary.label(library, group.labelKey)));
    const grid = h('div', 'actgrid');
    for (const one of items) {
      const available = window.ActionLibrary.availability(one);
      const button = h('button', 'act', window.ActionLibrary.label(library, one.nameKey));
      if (!available.ok) {
        button.disabled = true;
        // ⚠️ 这里给的是**原因键**，不是那句中文本身 —— 让它在两种语种下都成立。
        button.title = t(available.reasonKey);
      }
      button.addEventListener('click', () => {
        // ⚠️★ 位置要**先量再关**：菜单一关按钮就没了，量出来是全零。
        const at = button.getBoundingClientRect();
        closeActionMenu();
        // 带参数的那几条（目前只有「查找替换」）先填表；表是**照目录画的**，
        // 不是这里手写字段（见 `openActionForm` 的注释）。
        if (!actionNeedsParams(one)) {
          runAction(entry, one, library, {});
          return;
        }
        openActionForm(one, library, at).then((params) => {
          if (params) runAction(entry, one, library, params);
        });
      });
      grid.append(button);
    }
    body.append(grid);
  }
  panel.append(body);

  document.body.append(panel);
  // 贴按钮的下沿；超出窗口就往回收（窄窗口下菜单比窗口高，靠 `max-height` + 滚动兜住）。
  const box = anchor.getBoundingClientRect();
  const top = Math.min(box.bottom + 6, Math.max(8, window.innerHeight - panel.offsetHeight - 8));
  const left = Math.min(box.left, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
  panel.style.top = `${Math.max(8, top)}px`;
  panel.style.left = `${Math.max(8, left)}px`;

  const onOutside = (event) => {
    if (!panel.contains(event.target)) closeActionMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') closeActionMenu();
  };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  actionMenu = { panel, onOutside, onKey };
}

/** 一条动作要不要**先填参数**（目录里 `params` 非空）。
 *
 * ⚠️★ 判据用的是**目录里的声明**，不是「哪些 id 我记得要参数」—— 后者一加动作就漏。 */
function actionNeedsParams(action) {
  return Array.isArray(action.params) && action.params.length > 0;
}

/** 关掉「填参数」面板。`resolve` 只被调用一次（关窗与提交都走 `close`，后者先传值）。 */
function closeActionForm(value) {
  if (!actionForm) return;
  const { panel, onOutside, onKey, settle } = actionForm;
  actionForm = null;
  panel.remove();
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  settle(value ?? null);
}

/** 让「填参数」那张表**跟着目录画** —— 不手写字段。
 *
 * ⚠️★ 这里**不**写死「查找替换有哪些框」：字段的形状在 `actions-catalog.json` 里
 *（`type` / `options` / `visibleWhen`），网页版读的是同一份声明。抄一份在这里，
 * 加一个参数就是两边各改一次（而漏改的那边**不报错**，只是少一个框）。
 *
 * 返回 Promise：填完并点「跑」→ 参数对象；取消 / Esc / 点外面 → `null`。
 *
 * ⚠️ `visibleWhen`（「查找」只在「文本」模式下出现）是**声明里的规则**，
 * 所以这里也只有一份实现：每次任一字段变了就重算一遍谁该露脸。
 */
function openActionForm(action, library, at) {
  closeActionForm(null);
  return new Promise((settle) => {
    const panel = h('div', 'actmenu actform');
    const header = h('div', 'actmenu-hd');
    header.append(h('span', null, window.ActionLibrary.label(library, action.nameKey)));
    const close = h('button', 'lnk', '×');
    close.addEventListener('click', () => closeActionForm(null));
    header.append(close);
    panel.append(header);

    const body = h('div', 'actmenu-bd');
    const fields = new Map(); // param.key → 那个 <select> / <input>
    const rows = new Map();   // param.key → 那一整行（藏起来要用）
    for (const spec of action.params) {
      const row = h('label', 'field');
      row.append(h('span', 'field-k', window.ActionLibrary.label(library, spec.labelKey)));
      let input;
      if (spec.type === 'select') {
        input = document.createElement('select');
        for (const option of spec.options ?? []) {
          const node = document.createElement('option');
          node.value = option.value;
          node.textContent = window.ActionLibrary.label(library, option.labelKey);
          input.append(node);
        }
      } else {
        // ⚠️★ 走 `inputEl`（不是自己 `createElement`）：「文本输入框要关掉自动大写」
        // 这条规矩**只有那一份定义**，自己造一个就漏（而漏了**不报错** ——
        // 只是 macOS 上把 `https://` 打成 `Https://`，静态判据为此存在）。
        // ⚠️ 留空的语义在**实现里**（`actionReplaceWith` 那句「留空即删除」就写在标签上），
        // 这里不做任何「必填」判断 —— 判断一做，就与网页版那份规则分叉了。
        input = inputEl('', () => {});
      }
      input.className = 'field-v';
      row.append(input);
      fields.set(spec.key, input);
      rows.set(spec.key, row);
      body.append(row);
    }

    /** 谁该露脸：把每条 `visibleWhen` 重算一遍（只有一个字段时也不特判）。 */
    function syncVisibility() {
      for (const spec of action.params) {
        if (!spec.visibleWhen) continue;
        const watch = fields.get(spec.visibleWhen.key);
        rows.get(spec.key).hidden = watch ? watch.value !== spec.visibleWhen.equals : false;
      }
    }
    for (const input of fields.values()) input.addEventListener('change', syncVisibility);
    syncVisibility();
    panel.append(body);

    const foot = h('div', 'actform-ft');
    const cancel = h('button', 'lnk', t('取消'));
    cancel.addEventListener('click', () => closeActionForm(null));
    const go = h('button', 'btn primary', t('跑'));
    foot.append(cancel, go);
    panel.append(foot);

    /** 关面板的方式有四种（×/取消/Esc/点外面）→ 全是 `null`；只有「跑」给值。 */
    go.addEventListener('click', () => {
      const params = {};
      for (const [key, input] of fields) params[key] = input.value;
      closeActionForm(params);
    });

    document.body.append(panel);
    // ⚠️ `at` 是**关菜单之前**量好的那条按钮的位置：菜单一关按钮就没了，
    // 那时再 `getBoundingClientRect()` 拿到的是全零（面板会飞到左上角）。
    panel.style.top = `${Math.min(at.bottom + 6, Math.max(8, window.innerHeight - panel.offsetHeight - 8))}px`;
    panel.style.left = `${Math.min(at.left, Math.max(8, window.innerWidth - panel.offsetWidth - 8))}px`;
    // ⚠️ 面板刚挂上就让它拿到焦点 —— 否则用户还得再点一下框才能打字。
    const first = fields.values().next().value;
    if (first) first.focus();

    const onOutside = (event) => {
      if (!panel.contains(event.target)) closeActionForm(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') closeActionForm(null);
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    actionForm = { panel, onOutside, onKey, settle };
  });
}

/* ── 分享那一屏 ──────────────────────────────────────────────────────────
 *
 * ⚠️★ 有效期区间、次数上限、「多少分钟算小时」这些答案在 `share-config.js` ——
 * 与网页版那颗分享按钮、与服务端的 `share.rs` 是同一份（靠 `tools/share-limits-smoke.mjs` 盯）。
 * 这里**不许**出现写死的 15 / 1440 / 1000：写死的那一刻起，桌面与网页就是两个功能了，
 * 而两边不一致**不报错**，症状只是「填了 6 小时、实际生效 24 小时」。
 */

/** 那一份共用实现。**点第一下**才加载（不打开发享就不用付这一跳）。 */
let shareKit = null;
/** 加载回来的模块。⚠️ 与 `shareKit`（那个 Promise）分开存：滑块要用它的是**模块**，
 *  每次 `await` 一遍也不是不行，但 `syncShareTtl` 是**同步**的（拖滑块时每帧都来一次）。 */
let shareCfg = null;
function shareConfig() {
  if (!shareKit) shareKit = import('./share-config.js');
  return shareKit;
}

/** 当前正在配的那一条（结果回来之后要用它的 id 之外的东西，见 `shareRecent`）。 */
let shareTarget = null;
/** 刚刚签出来的那一条（给「再复制一次」用）。 */
let shareRecent = null;

function syncShareTtl() {
  const minutes = Number(el('share-ttl').value);
  const seconds = shareCfg.minutesToShareTTL(minutes);
  el('share-ttl-label').textContent = shareCfg.formatShareDuration(seconds, shareTranslate);
  el('share-ttl-fill').style.width = `${shareCfg.shareTtlProgress(minutes)}%`;
  for (const chip of el('share-ttl-presets').children) {
    chip.classList.toggle('on', Number(chip.dataset.minutes) === minutes);
  }
}

/** `formatShareDuration` 要一个 `t`，这里递的是**这一侧**的字典。
 *
 * ⚠️★ 那三个键（是多少分钟 / 多少小时）必须两边都在：网页在自己的 locale 文件里，桌面在
 * `ui/i18n.js`。少了的表现是屏幕上印出 `shareDurationMinutes` 这个键本身。 */
const shareTranslate = (key, params) => t(key, params);

function paintShareTtlScale() {
  el('share-ttl').min = String(shareCfg.SHARE_MIN_TTL_MINUTES);
  el('share-ttl').max = String(shareCfg.SHARE_MAX_TTL_MINUTES);
  el('share-ttl').step = '1';
  el('share-ttl-min').textContent = shareCfg.formatShareDuration(shareCfg.SHARE_MIN_TTL, shareTranslate);
  el('share-ttl-max').textContent = shareCfg.formatShareDuration(shareCfg.SHARE_MAX_TTL, shareTranslate);
  el('share-uses').max = String(shareCfg.SHARE_MAX_USES_LIMIT);
  const presets = el('share-ttl-presets');
  presets.textContent = '';
  for (const minutes of shareCfg.SHARE_TTL_PRESET_MINUTES) {
    const chip = h('button', '', shareCfg.formatShareDuration(shareCfg.minutesToShareTTL(minutes), shareTranslate));
    chip.dataset.minutes = String(minutes);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      el('share-ttl').value = String(minutes);
      syncShareTtl();
    });
    presets.append(chip);
  }
}

function closeShare() {
  el('share-overlay').hidden = true;
  shareTarget = null;
}

/** 打开配置那一屏（卡片脚那颗 ↗）。 */
async function openShareForm(entry) {
  shareTarget = entry;
  let kit;
  try {
    kit = await shareConfig();
  } catch {
    showNotice('error', t('分享用不上：{error}', { error: t('那一屏的常量没加载起来') }));
    return;
  }
  shareCfg = kit;
  paintShareTtlScale();
  // ⚠️ 每开一次都从默认值起 —— 上一次的密码留在框里是最糟的那一种「体贴」
  //（用户以为这次也没设密码，或者以为这次也设了）。
  el('share-ttl').value = String(kit.SHARE_DEFAULT_TTL_MINUTES);
  el('share-uses').value = '0';
  el('share-password').value = '';
  el('share-msg').textContent = '';
  if (!el('share-go').dataset.bound) {
    el('share-go').dataset.bound = '1';
    el('share-ttl').addEventListener('input', syncShareTtl);
    el('share-cancel').addEventListener('click', closeShare);
    el('share-close').addEventListener('click', closeShare);
    el('share-copy').addEventListener('click', () => {
      if (!shareRecent) return;
      invoke('copy_to_clipboard', { text: shareRecent }).catch((error) => {
        showNotice('error', t('复制不了：{error}', { error: errorText(error) }));
      });
    });
    el('share-go').addEventListener('click', submitShare);
    // ⚠️ 点浮层自己的**空白**（不是里面的面板）算「算了」—— 和设置窗那一套一致。
    el('share-overlay').addEventListener('mousedown', (event) => {
      if (event.target === el('share-overlay')) closeShare();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el('share-overlay').hidden) closeShare();
    }, true);
  }
  syncShareTtl();
  el('share-result-win').hidden = true;
  el('share-form-win').hidden = false;
  el('share-overlay').hidden = false;
  el('share-ttl').focus();
}

async function submitShare() {
  if (!shareTarget) return;
  const ttl = shareCfg.minutesToShareTTL(el('share-ttl').value);
  const maxUses = shareCfg.normalizeShareMaxUses(el('share-uses').value);
  const password = String(el('share-password').value || '').trim();
  const entry = shareTarget;
  el('share-go').disabled = true;
  el('share-msg').textContent = t('正在找服务端签发…');
  try {
    const link = await invoke('share_entry', { id: entry.id, ttl, maxUses, password });
    shareRecent = link.url;
    el('share-url').textContent = link.url;
    const uses = (link.maxUses ?? maxUses) > 0
      ? t('还能打开 {count} 次', { count: link.maxUses ?? maxUses })
      : t('次数不限');
    el('share-meta').textContent = [
      t('有效期 {duration}', { duration: shareCfg.formatShareDuration(link.ttl || ttl, shareTranslate) }),
      uses,
      t('已经打开过 {count} 次', { count: link.visits ?? 0 }),
    ].join(' · ');
    el('share-form-win').hidden = true;
    el('share-result-win').hidden = false;
    el('share-go').disabled = false;
    el('share-msg').textContent = '';
    // ⚠️★ 地址已经进剪贴板了（壳在做签发时一并复制），但**没设密码这件事要说清**：
    // 无密码的链接贴进聊天工具时，内容首行会出现在对方的预览里，而那份预览进了对方的
    // 缓存就删不掉。用户点「分享」时心里的模型是「拿到链接的人能看」。
    if (!password) {
      showNotice('ok', t('链接已复制（没设密码）——贴进聊天工具会显示内容摘要，别贴到公开的地方。'));
    } else {
      showNotice('ok', t('链接已复制。'));
    }
  } catch (error) {
    el('share-go').disabled = false;
    el('share-msg').textContent = '';
    showNotice('error', t('分享不了：{error}', { error: errorText(error) }));
  }
}

/** 跑一条动作：取**全文** → 用那一份跑 → 把结果挂到卡片上。
 *
 * ⚠️★ 必须取全文：列表里的 `entry.text` 是**截断预览**，拿它跑出来的结果与用户看到的那条
 * 对不上 —— 而且这件事**不报错**（同「复制」和「分享」两条命令的坑）。
 */
async function runAction(entry, action, library, params) {
  try {
    const text = await invoke('entry_text', { id: entry.id });
    const { output, html } = await window.ActionLibrary.run(action, text, params);
    // ⚠️★ 「这条的产出是 HTML」由 `ActionLibrary.run` 归一（双表示 / 目录里的 `render`），
    // 画的那一份单独存 —— 见上面渲染处那条注释。
    const htmlText = html || (action.render === 'html' ? output : '');
    if (!output && !htmlText) {
      showNotice('warn', t('这个动作跑出来是空的 —— 这条本来就是这个样子。'));
      return;
    }
    // ⚠️★ 结果挂上去之后同样是**整条重画**（`repaint()`），位置要走同一条锚定 ——
    // 不然「跑完动作，屏幕上换了一段别的内容」，与收起长文是同一个毛病（不报错，只是找不着）。
    holdCardPosition(String(entry.id), () => {
      actionViews.set(entry.id, {
        actionId: action.id,
        label: window.ActionLibrary.label(library, action.nameKey),
        output,
        htmlText,
        html: Boolean(htmlText),
      });
      repaint();
    });
  } catch (error) {
    showNotice('error', t('这个动作没跑成：{error}', { error: errorText(error) }));
  }
}

/** 「展开」那颗按钮上的字（⚠️ 两处渲染点都要用它，别各写一份）。 */
function expandLabel(entry) {
  if (openedIds.has(entry.id)) return t('收起');
  // ⚠️ 被截断的说清「一共多大」—— 否则用户以为这就是全文（只是有点长）。
  return entry.truncated
      ? t('展开全文（共 {size}）', { size: sizeLabel(entry.textBytes) })
      : t('展开');
}

/** 改一张卡片的高度时，把它**钉在同一个屏幕位置**。
 *
 * ⚠️★ 存在的理由：展开／收起会让这条消息的正文高度变几千像素，而 `#timeline` 是一次
 * 可滚动的列表。紧跟着它下面的那些卡片会整体往上（或往下）**挪同样多** —— 浏览器的滚动位置
 * （`scrollTop`）却原地不动，于是屏幕上剩下的完全是**另一段内容**。
 * 收起一条长文时最明显：一按「收起」，视口立刻跳到很远的地方，用户找不到刚才那一条。
 *
 * ⚠️ 目标位置怎么算：
 *   · 卡片的顶边**本来就在视口里**（最常见）→ 让它留在原处（钉在上一次那个 y 上）；
 *   · 顶边**已经滚到视口上方**（长文读到一半再收起是这种）→ 把顶边贴到视口顶部。
 *     关键是「定位到这一条」—— 停在别处和跳走一样糟，用户要找的是**那条消息**。
 *
 * ⚠️★ `card` 也可以是一个**条目 id**（字符串）—— 「还原」与「跑动作」走的是 `repaint()`，
 * 也就是**整条时间线重画**：那张卡片被丢掉了，改之后是一个新节点。拿旧节点量顶边，
 * 量到的是 `0`（它已经不在文档里），于是「偏移」算成几千像素 —— 视口被拨到很远的地方，
 * **比不钉还糟**。所以那两处传 id，这里按 id 在**改之后**再找一次（同一个条目，新节点）。
 */
function holdCardPosition(card, mutate) {
  const host = el('timeline');
  const find = () => (typeof card === 'string'
    ? host.querySelector(`[data-id="${card}"]`)
    : card);
  const view = host.getBoundingClientRect();
  const target = find();
  // ⚠️ 这条已经不在列表里了（被删 / 换了房间）：没得钉 —— 也别拿一个不存在的节点算出假偏移。
  if (!target) { mutate(); return; }
  const before = target.getBoundingClientRect().top;
  const wanted = before >= view.top ? before : view.top;
  mutate();
  const after = find();
  // ⚠️ 重画之后它不见了（同上）：拨什么都错，直接不拨。
  if (!after) return;
  const drift = after.getBoundingClientRect().top - wanted;
  if (drift) host.scrollTop += drift;
}

/** 展开 / 收起一条。
 *
 * ⚠️★ 只改**这一张卡片**的 DOM，不触发整屏重绘；`openedIds` / `openedBodies` 才是状态，
 * 所以下一次重绘会照同样的规则画回来。
 *
 * ⚠️★ **只有真被截断的才去取全文**（`entry.truncated`）：短消息本地摊开就够，
 * 省一次 IPC。判错的代价是「本地摊开却没内容」—— 而截断与否是壳算好给的，不会错。
 *
 * ⚠️ 两个方向都过一遍 `holdCardPosition`：展开同样会把下面的内容整段往下挪。
 */
async function toggleEntry(card, entry, button) {
  const text = card.querySelector('.txt');
  if (openedIds.has(entry.id)) {
    holdCardPosition(card, () => {
      openedIds.delete(entry.id);
      text.classList.remove('open');
    });
    button.textContent = expandLabel(entry);
    return;
  }
  if (entry.truncated && !openedBodies.has(entry.id)) {
    button.disabled = true;
    button.textContent = t('取全文中…');
    try {
      openedBodies.set(entry.id, await invoke('entry_text', { id: entry.id }));
    } catch (error) {
      // ⚠️ 取不到要**说出来**：最常见的原因是这条已经被挤出去了（或换了房间）。
      button.disabled = false;
      button.textContent = expandLabel(entry);
      showNotice('warn', t('取不到全文：{error}', { error: errorText(error) }));
      return;
    }
    button.disabled = false;
    text.textContent = openedBodies.get(entry.id);
  }
  holdCardPosition(card, () => {
    openedIds.add(entry.id);
    text.classList.add('open');
  });
  button.textContent = expandLabel(entry);
}

/** 那个延迟胶囊（§4.3）。三种取值**分开画**。 */
function renderLatency(latency) {
  const kind = latency?.kind ?? 'unknown';
  if (kind === 'rtt') {
    const node = h('span', 'ms', `${latency.ms}ms`);
    node.title = t('这条连接的往返延迟（最近几次的中位数）。⚠️ 只量得到正在收的那个房间。');
    return node;
  }
  // ⚠️★ 超时**必须说出来**（§4.3 第 4 条）：画一个 `9999ms` 看起来只是「慢」，
  // 而真相是这条连接其实已经坏了、客户端正在重连。不说的话用户只会觉得界面坏了。
  if (kind === 'timeout') {
    const node = h('span', 'ms warn', t('超时'));
    node.title = t('ping 没有回来：这条连接其实已经坏了，客户端会自己重连。');
    return node;
  }
  // ⚠️ 刚连上还没测到 —— 画 `—` 而不是不画：这个房间**是**在量的，
  // 「正在量但还没有数字」和「这个房间量不到」是两件事。
  const node = h('span', 'ms', '—');
  node.title = t('还没测到延迟（刚连上，第一次 ping 还没回来）。');
  return node;
}

/** 侧栏的房间列表。 */
function renderRooms(state) {
  const host = el('rooms');
  host.textContent = '';
  if (!state.rooms.length) {
    host.append(h('div', 'empty', t('配置里一个房间都没有。\n去配置里加一个（数据目录下的 client.json）。')));
    return;
  }
  state.rooms.forEach((room, index) => {
    const node = h('div', index === state.selected ? 'room on' : 'room');
    // ⚠️ 房间名是**用户配置**里的自由文本 → 只能走 textContent。
    // ⚠️★ 图标**只从壳里拿**（`resolve_emojis` 算好的；`emoji` 字段本身可能为空 = 自动）。
    // 原来的做法是「选中的画 🏠、别的画 💬」—— 那是**按位置猜**的（真实房间名是自由文本，
    // 按名字猜图标只会猜错）。2026-09-28 Jonny：「添加房间允许用户自定义 emoji，
    // 否则随机一个不重样的 emoji」→ 于是图标成了**用户能选的东西**，不用再猜。
    // ⚠️ 代价明说：**「选中」不再有自己那个图标了**，只剩 `.room.on` 那层底色与描边
    //（它本来就一直在）。别再顺手加一个 🏠 回来 —— 那会盖掉用户挑的图标。
    // ⚠️ 这里**不兜底**（不写 `room.emoji || '💬'`）：壳那边保证非空且有测试，
    // 兜底就是第二份「自动挑哪一个」的定义。
    node.append(h('span', 'ico', room.emoji));
    node.append(h('span', 'nm', room.name));
    node.append(h('span', 'ct', String(room.count)));

    // ⚠️★ 第二行：**↑ / ↓ 靠左、延迟靠右**（Jonny 2026-09-26：
    // 「把主界面的上传下载图标居左，延迟也挪下来居右」）。
    // 延迟原来在第一行（排在条数前面），挪下来之后名字那一格宽出十几个像素。
    // ⚠️ 延迟**每个房间都画**（Jonny 2026-09-26：「每个在连接状态的都要显示延迟」）——
    // 每个房间各自有一条连接（§4.7），所以每个房间都量得到自己那个数。
    // ⚠️ 还没连上时画 `—`（**不是**不画）：这个房间是在量的，
    //「正在量但还没有数字」和「这个房间量不到」是两件事。
    // ⚠️★ 它们包进一个 `.dirs`，因为**换行和靠右都是 CSS 的事**
    //（`.room { flex-wrap: wrap }` + `.dirs { width: 100% }` + `.dirs .ms { margin-left: auto }`）——
    // 这里只负责把它们放在一起。⚠️ `dirs` 必须**排在条数后面**：它有 `width: 100%`，
    // 排在前面的话条数会被一起挤到第三行去。
    const up = h('span', room.upload ? 'dir up on' : 'dir up', '↑');
    // ⚠️ 悬停提示只写「这个图标是干什么的」，不写「点击开/关」：
    // 开关的形状（按下去会变色）本身就在说这件事，而 Jonny 给的文案就这两句。
    up.title = t('发送本地剪贴板到远程房间');
    up.dataset.action = 'upload';
    up.dataset.index = String(index);
    const down = h('span', room.download ? 'dir dn on' : 'dir dn', '↓');
    down.title = t('获取远程房间最新消息写入本地剪贴板');
    down.dataset.action = 'download';
    down.dataset.index = String(index);
    // ⚠️ 延迟那个胶囊**留住引用**：下面那句 `title` 要读它的文字（见那段注释）。
    const latency = renderLatency(room.connection?.latency);
    const dirs = h('span', 'dirs');
    dirs.append(up, down, latency);
    node.append(dirs);

    // ⚠️★ 收起侧栏之后，这一行的**名字 / 条数 / 延迟都不画了**（见 `index.html` 里
    // `[data-sidebar='narrow']` 那一段）—— 所以这个 `title` 不是「可有可无的悬停提示」，
    // 它是那三样在收起状态下的**唯一出口**。
    // ⚠️ 延迟那一句**直接取那个胶囊的文字**（`latency.textContent`）：
    // 不在这里另写一遍「多少 ms / 超时 / —」—— 那就是第二份「延迟怎么显示」的定义，
    // 而它一定会在某次改动里漂（`超时` 那条最容易被漏掉）。
    // ⚠️ 宽栏里这个 `title` 也在（同一个属性、不分模式）：要「只在收起时设」就得让
    // `renderRooms` 去读 DOM 状态，而**多一个会漂的状态**比多一个冗余的悬停提示更贵。
    node.title = t('{name} · {count} 条 · 延迟 {latency}', {
      name: room.name,
      count: room.count,
      latency: latency.textContent,
    });

    node.dataset.index = String(index);
    host.append(node);
  });
  // ⚠️ 「＋ 添加房间」**不在这里**了：Jonny 2026-09-26 把它挪到侧栏底部
  //（「全局设置」上面），见 `index.html` 的 `#btn-room-add` 与它那段注释。
  // ⚠️ 挪走是有理由的：原来它是列表的最后一项，房间一多就得**滚到底**才看得见。
}

/* ⚠️★ 这里原来有一个 `renderStatus`（主区那一行右边那个「剪贴板同步中」胶囊）。
   2026-09-26 删掉了 —— Jonny：「移除房间手机/电脑图标旁边的剪贴板同步状态，
   **功能也一并移除**，侧栏的图标功能足够了」。
   ⚠️ 删掉它**不是**「少画一个胶囊」：它背后的那个总开关
   （`ClientConfig::enable_monitoring`，管「要不要读本机剪贴板」）整条没了，
   连托盘菜单里那一项一起。**要不要发出去只看每个房间的 ↑**（侧栏）。
   ⚠️ 所以这里**没有**留下一个「状态在哪看」的缺口：每个房间的连接状态仍然在
   `rooms[i].connection` 上，只是不再重复画第二遍（侧栏那个房间行是它唯一的落点）。
   留一份就会有两份「哪条连接」的定义 —— §4.7 明说了不要。 */

/** 贴到底部，并记下「现在是贴着的」（见 [`timelinePinned`]）。
 *
 * ⚠️★ 滚动这件事**只有这一个地方**做：从前是「哪里需要哪里写一句
 * `host.scrollTop = host.scrollHeight`」，后面每加一个新场景（发送之后、图片加载完）
 * 就多一句，而每一句都要自己记得改状态 —— 迟早漏一处。
 */
function pinTimeline() {
  const host = el('timeline');
  if (!host) return;
  host.scrollTop = host.scrollHeight;
  timelinePinned = true;
}

/** 现在贴在底部吗（阈值与从前那句 `wasPinned` 一样是 24px：滚动是像素级的，
 *  停在「差一两像素」的地方不该算「没贴底」）。 */
function timelineAtBottom() {
  const host = el('timeline');
  if (!host) return true;
  return host.scrollHeight - host.scrollTop - host.clientHeight < 24;
}

/** ⚠️★ **贴底看门狗**：卡片长高之后要再贴一次。
 *
 * ⚠️★ 为什么必须有它（2026-10-04 Jonny：「发送文字/图片/文件时，消息卡片只露出大概
 * 1-2 行的内容区，其余被输入框遮挡」）：`pinTimeline()` 贴的是**那一刻**算出来的
 * `scrollHeight`，而卡片的高度**之后还会变** —— 图片的固有尺寸要等字节到，视频要等元数据。
 * 长高的那 220px 全在视口底下（也就是输入框那一片的下面），屏幕上剩下的正好是这张卡片的
 * meta 那一行。真浏览器量过：图片加载完，末尾那张卡片底边比时间线可见区低 **208px**。
 *
 * ⚠️ 观察的是**卡片节点**，不是时间线本身：时间线的大小是 `flex: 1` 定死的，
 * 内容长高它一点都不变（所以用 `ResizeObserver` 盯它等于没盯）。
 * ⚠️ 只在**贴着底**时才补一次 —— 用户翻上去读历史时，内容长高把他往下推是正常的，
 * 一把拽回底部才是那个更烦的行为（见 [`timelinePinned`]）。
 * ⚠️ 拿不到 `ResizeObserver`（老 webview）就是**没有这个补偿**，其余一切照常 ——
 * 不降级成一个「每次都拽到底」的坏行为。
 */
const timelineSizes = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => {
    if (timelinePinned) pinTimeline();
  })
  : null;

/** 盯住这张卡片的大小（新造出来时挂上，被丢掉时摘掉 —— 见 `reconcileChildren`）。 */
function watchCardSize(node) {
  if (timelineSizes) timelineSizes.observe(node);
}

function renderTimeline(state) {
  const host = el('timeline');
  // ⚠️★ 「贴不贴底」读的是**记住**的那个状态（[`timelinePinned`]），**不再现算**：
  // 现算出来的几何会在「卡片里的图片加载完、长高了一截」之后与用户意图分叉，而分叉的
  // 两个后果都很坏 —— 最新的那条被顶到视口外面；下一条新消息也不再跟到底。
  //
  // ⚠️ 只有贴底（或**刚发过东西**）时才自动滚：无条件滚的话，用户往上翻着读历史时，
  // 来一条新消息就把他**拽回底部**。那比「不自动滚」烦得多（「我在看旧的，它一直弹走」）。
  // ⚠️★ 「刚发过」也算贴底（见 `followToNewest`）：发完必须看得见自己那一条。
  const follow = timelinePinned || followAfterSend;
  const lastId = lastEntryId(state);
  // ⚠️★ 贴底（或刚发过）= **看过了** → 基线推到末尾；否则数一数这段时间新来了几条
  //（那颗「N 条新消息」就是给它用的，见文件里那段状态注释）。
  // ⚠️ `state.entries` 在空态那三条分支里是空的，`filter` 自然是 0，不用另判。
  if (follow) {
    unseenCount = 0;
    seenLastId = lastId;
  } else if (lastId > seenLastId) {
    unseenCount = state.entries.filter((entry) => entry.id > seenLastId).length;
  }
  const room = state.rooms[state.selected];
  const fresh = [];
  if (!room) {
    fresh.push(h('div', 'empty', t('没有房间。')));
  } else if (!state.entries.length) {
    // ⚠️ 「还没加载」与「这个房间确实是空的」**必须**分开说 ——
    // 两种都画成空列表的话，用户会以为功能坏了。
    // ⚠️ 「还没加载」那句**不能**再说「点右上角刷新」：那个按钮按界面稿删掉了
    //（历史是自动取的，见 `ensureHistory`），留着就是指向一个不存在的东西。
    // ⚠️★ 三态（2026-09-30）：取失败过要说「取不到」并告诉用户**怎么再试**
    //（点一下这个房间 = 壳里那条 `ByUser`）—— 否则它会永远写着「正在取…」，
    // 而那是假话（自动重试已经停了，见 `ensureHistory`）。
    fresh.push(h('div', 'empty', room.historyFailed
      ? t('这个房间的历史取不到（多半是连不上服务端）—— 点一下这个房间再试一次。')
      : room.historyLoaded
        ? t('这个房间还没有内容。')
        : t('正在取这个房间的历史…')));
  } else {
    fresh.push(...timelineCards(host, state));
  }
  reconcileChildren(host, fresh);
  // 新的内容在末尾 → 贴底（或刚发过东西）时跟到底（用户刚复制的东西要立刻看见）。
  // ⚠️ 顺带把「贴着」这件事写进状态：这次贴完之后，图片再长高由看门狗接着贴
  //（见 `timelineSizes`）。
  if (follow) pinTimeline();
  // ⚠️★ 自己那条（或那张「正在发送」的占位）到了就收工；没到就继续跟着 ——
  // 超时兜底在 `followToNewest` 里（免得上行失败时这个状态一直挂着，把用户往回拽）。
  if (followAfterSend && state.entries.length > followBaseline) {
    followAfterSend = false;
    clearTimeout(followTimer);
  }
  renderNewPill();
}

/** 末尾那条的 id（空列表 = `0`）。
 *
 * ⚠️ 取的是**末尾**那条，不是「最大的 id」：列表本来就旧的在前（末尾最新），
 * 而撤销之后「最大 id」可能是别人那条、且不在末尾 —— 拿它当基线会数错。
 */
function lastEntryId(state) {
  const entries = state?.entries ?? [];
  return entries.length ? entries[entries.length - 1].id : 0;
}

/** 那颗「N 条新消息」胶囊 —— 只在真有没看过的东西时亮出来。
 *
 * ⚠️ 文案（含条数）在这里拼（`t(…)`），标记里一个字都不写：那份界面是手写的、没有构建步骤，
 * 中文写在 HTML 里就没有第二份字典能翻它（判据 15 会红）。
 */
function renderNewPill() {
  const pill = el('new-pill');
  if (!pill) return;
  pill.hidden = unseenCount <= 0;
  if (unseenCount > 0) pill.textContent = t('↓ {n} 条新消息', { n: unseenCount });
}

/** 把「最新的已经看过了」记下来（用户自己滚到底、或点了那颗胶囊都会走这里）。 */
function markTimelineRead() {
  unseenCount = 0;
  seenLastId = lastEntryId(lastState);
  renderNewPill();
}

/** 刚在输入框里发了东西 —— 让**下一拍**不管贴不贴底都跟到最新。
 *
 * ⚠️★ 为什么是「下一拍」而不是当场滚：发出去的东西要等它从服务端**广播回来**才在列表里
 *（文本与文件都是这条通路；文件还会先长出一张「正在发送」的占位卡）—— 现在滚到底，
 * 等它到了会发现自己还在原地。所以这里只**置一个标志**，由 `renderTimeline` 在
 * 内容真的到了那一拍跟上去。
 * ⚠️ 清掉的时机 = **列表真的长了一条**（`followBaseline` 是发之前那条数）；
 * 另配一个超时兜底，免得上行失败时「跟到底」一直挂着（那会把用户往底部拽 8 秒）。
 */
function followToNewest() {
  followAfterSend = true;
  followBaseline = lastState?.entries?.length ?? 0;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    followAfterSend = false;
  }, 8000);
  // ⚠️ 别干等下一拍（700ms 才轮询一次）：立刻问一次，那一拍就能跟上。
  refreshNow();
}

/** 已经画出来的卡片各自的**签名**（节点 → 它就是照哪一份内容画的）。
 *
 * ⚠️ 用 `WeakMap` 而不是往节点上写个属性：签名可能很长（含正文），
 * 而节点被丢掉时这张表也该跟着放掉 —— `WeakMap` 正好是这个语义。
 */
const cardSignatures = new WeakMap();

/** 一张卡片的**签名**：只要它不变，那张卡就不必重建。
 *
 * ⚠️★ 签名里要有什么 = **`renderEntry` 读过的东西**（外加那几份参与渲染的页面状态：
 * 展开过没有、动作结果是什么）。往 `renderEntry` 里加一处读，就要往这里加一处 ——
 * 漏了的表现是「那一处变了、卡片不更新」，很轻，但很难查。
 * ⚠️ 正文（`entry.text`）也算进去：动作结果、展开的那份都在别处，但原文变了
 *（同一条被 `update` 改过）时必须重画。
 */
function entrySignature(entry) {
  const viewed = actionViews.get(entry.id);
  const common = [
    entry.id, entry.kind, entry.mine ? 'me' : '', entry.device, entry.timestamp,
    entry.fromClipboard ? 'cb' : '', entry.automation ? 'auto' : '',
    entry.late ? 'late' : '', entry.scheduledAt,
  ];
  const own = entry.kind === 'file'
    ? [entry.fileName, entry.fileSize, entry.previewUrl, entry.previewNeedsToken ? 'tok' : '']
    : [
      entry.text,
      entry.textBytes,
      entry.truncated ? 'tr' : '',
      openedIds.has(entry.id) ? 'open' : '',
      openedBodies.get(entry.id) ?? '',
      viewed ? `act\u0000${viewed.label}\u0000${viewed.html ? viewed.htmlText : viewed.output}` : '',
    ];
  return common.concat(own).join('\u0000');
}

/** 时间线要画的那几张卡片 —— **能复用就复用原来的节点**。
 *
 * ⚠️★ 为什么非复用不可（2026-10-04，Jonny：「桌面端列表现在每过一会儿就会闪一下」）：
 * 从前每一拍都 `replaceChildren`，而每张卡片都是**新 `createElement` 出来的**。
 * 而版本号**每 ~1.4 秒就会前进一次**：`ReceiverEvent::Latency` 每轮 ping 都推一份，
 * RTT 本来就在抖，`store` 里那道「先比再写」的护拦对**会抖的数**天然无效 ——
 * 于是每 1.4 秒整列重建一次，**图片节点被丢掉再造**（浏览器要重新解码、重新画），
 * 屏幕就闪一下。复用一个节点时图片不会被重新拉（元素没变，资源还在）。
 */
function timelineCards(host, state) {
  const wanted = new Map();
  state.entries.forEach((entry) => wanted.set(String(entry.id), entrySignature(entry)));

  // 现有节点里，签名**没变**的那些可以留着用（按 `data-id` 找）。
  const reusable = new Map();
  for (const node of host.children) {
    const id = node.dataset ? node.dataset.id : '';
    if (!id || cardSignatures.get(node) !== wanted.get(id)) continue;
    reusable.set(id, node);
  }

  const fresh = state.entries.map((entry) => {
    const id = String(entry.id);
    const kept = reusable.get(id);
    if (kept) return kept;
    const node = renderEntry(entry);
    cardSignatures.set(node, wanted.get(id));
    // ⚠️★ 新造的卡片要**盯住它的大小**：里面的图片/视频是**之后**才长高的
    //（见 `timelineSizes` 那段）。复用下来的那些早就盯着了。
    watchCardSize(node);
    return node;
  });
  // ⚠️★ 「正在发送」那几张**排在末尾**：新内容本来就出现在末尾，而用户按下发送之后
  // 视线就在那儿。放在顶部的话，他会先看到一张新卡片从上面长出来（那不像「我发的」）。
  // ⚠️ 它们**不复用**：进度每一片都在变，而重造一张只有两行字的卡片没有代价。
  // ⚠️ 也盯一下大小：占位卡与真卡片差着几十像素，传完换掉的那一下同样是「内容长高/变矮」。
  (state.uploads || []).forEach((upload) => {
    const node = renderUpload(upload);
    watchCardSize(node);
    fresh.push(node);
  });
  return fresh;
}

/** 把 `host` 的子节点换成 `fresh`，**一个都没变就不动它**。
 *
 * ⚠️ 顺序也要比：复用回来的节点可能换了位置（撤销 / 清空之后）——
 * 逐个 `===` 比一遍最省事，也比「算一遍序列化」便宜得多。
 * ⚠️★ 被丢掉的那些节点要**断开预览观察器**（见 `whenVisible`）：
 * `IntersectionObserver` 会一直拽着它的目标不放。
 */
function reconcileChildren(host, fresh) {
  const keep = new Set(fresh);
  for (const node of host.children) {
    if (keep.has(node)) continue;
    // ⚠️ 丢掉的两样**都得摘**：预览观察器（不进视口就没它的事了）与尺寸观察器
    //（`ResizeObserver` 会一直拽着节点不放 —— 不摘就是**慢泄漏**，而且摘了才知道
    // 那张卡片真的走了）。
    if (node.__previewObserver) {
      node.__previewObserver.disconnect();
      node.__previewObserver = null;
    }
    if (timelineSizes) timelineSizes.unobserve(node);
  }
  const same = host.children.length === fresh.length
    && fresh.every((node, index) => host.children[index] === node);
  if (same) return;
  host.replaceChildren(...fresh);
}

/** 一张**正在发送**的卡片（带进度条）。
 *
 * ⚠️★ 它**不是**一条条目：条目是服务端已经收下的东西（有服务端给的 id），
 * 而这份还没有 id —— 所以它没有「复制 / 分享 / 删除」那一排，也不进 `openedBodies` 那些表。
 * 传完壳会把它撤掉，真条目由下行广播回来（那时才有 id）。
 *
 * ⚠️ `total === 0` = **还不知道**总共多少（`stat` 没读出来）。这时**不许画成 0%**
 * —— 「0%」看着像卡住了，而真相是「正在开始」。画成满格 + 一句「正在发送…」。
 */
function renderUpload(upload) {
  const card = h('div', 'card me');
  card.append(h('div', 'fn', upload.name || ''));

  const bar = h('div', 'ubar');
  const fill = h('div', 'ufill');
  const known = upload.total > 0;
  const pct = known ? Math.min(100, Math.round((upload.sent / upload.total) * 100)) : 0;
  fill.style.width = known ? `${pct}%` : '100%';
  bar.append(fill);
  card.append(bar);

  card.append(h('div', 'fs', known
    ? t('已发 {sent} / 共 {total}（{pct}%）', {
      sent: sizeLabel(upload.sent),
      total: sizeLabel(upload.total),
      pct,
    })
    : t('正在发送…')));
  return card;
}

/** 输入区右下角那个计数（稿 1 画的是 `0 / 4096`）。
 *
 * ⚠️ 上限是**握手**里下发的（不在 `/server`）。没连上就是「不知道」，
 * 这时要写「还不知道」而不是 `0 / 0` —— 后者会让用户以为「一个字都发不了」。
 *
 * ⚠️★ 数的是**字节**，与两侧同一口径：服务端 `handlers.rs` 用 `text.len()` 判，
 * 而这一页的标签写的就是「文本上限（**字节**）」（`index.html`）。
 * 这里**原来数码点**（`[...value].length`）—— 于是同一页上三个说法：标签说字节、
 * 服务端按字节判、而计数器和提示语说的是「字符」。后果：一条 3000 汉字的长文
 * 会显示「3000 / 4096」然后被服务端按 9000 字节拒掉，用户完全看不懂
 *（`dev-docs/specs/desktop-client.md` §8.2 第 4 条 / `long-message-hardening.md` S2）。
 * ⚠️ 也别改用 `value.length`：那是 **UTF-16 码元**数（emoji 算 2），第三种口径。
 *
 * ⚠️★ `0` 有**两种**含义，必须分开说：**没连上**（上限不知道）与
 * **服务端设了 0 = 不限**（`handlers.rs` 那条 `text.limit > 0` 的判断）。
 * 只判 `limit` 真值的话，后一种会被画成「还没连上」—— 明明连着却说不清。
 */
/** 单文件上限那一句话 —— ⚠️★ 发送框与设置页**这一处**算。
 * 两处各写一份的表现是「同一份上限，这一屏说 256 MB、那一屏说还不知道」。
 *
 * ⚠️★ `0` 有两种含义，与字节那条同一个坑：**服务端说 0 = 不限**（`ClientConfig` 的
 * `max_file_size_mb` 默认就是 0）与**还没连上**（初值也是 0）。只判 `fileLimit` 真假，
 * 后一种会被说成「不限」—— 发出去被拒了才知道那条界其实没问到。
 * 分开它们看的是**房间的连接状态**（它既能回答「连上没有」，
 * 也是这一屏上唯一知道「问到过没有」的地方）。
 */
function fileLimitText() {
  if (lastLimits.fileLimit > 0) {
    return t('文件 ≤ {size}', { size: sizeLabel(lastLimits.fileLimit) });
  }
  const kind = lastRooms[lastSelected]?.connection?.kind;
  if (kind === 'on' || kind === 'warn') return t('文件不限大小');
  return t('文件大小上限还不知道（还没连上）');
}

function updateCounter() {
  const bytes = new TextEncoder().encode(el('input').value).length;
  const kind = lastRooms[lastSelected]?.connection?.kind;
  if (lastLimits.textLimit > 0) {
    el('limits').textContent = `${bytes} / ${lastLimits.textLimit}`;
  } else if (kind === 'on' || kind === 'warn') {
    el('limits').textContent = t('{bytes} / 不限', { bytes });
  } else {
    el('limits').textContent = t('上限还不知道（还没连上）');
  }
  el('limits-file').textContent = fileLimitText();
}

/** 主区那一行**右边**的设备行（稿 1 有：几个圆圈 + 「N 台在线」）。
 *
 * ⚠️★ 画的是**当前选中那个房间**的设备 —— 每个房间各自有一条连接（§4.7），
 * 所以每个房间都有自己的设备列表（`rooms[i].connection.devices`）。
 *
 * ⚠️★ **永远画一行**，哪怕一个设备都没有。
 * 原来这里是「空数组就直接 `return`」—— 理由是「『一台都没有』和『还不知道』
 * 是两件事，混起来就是骗人」，那个理由**仍然成立**，所以这里**不画「0 台在线」**；
 * 但「什么都不画」有个更坏的后果：**整条状态栏的右半边会凭空消失**，
 * 看着像功能被删了。Jonny 2026-09-26 就是这么以为的 ——
 * 「手机图标和统计，你怎么也给我删了?恢复」。
 * ⚠️ 所以现在**照实说**：数不到就说数不到（把房间的连接状态摆出来，
 * 那也正是原来那个同步胶囊删掉之后、主窗口里唯一还说得清「连上没有」的地方）。
 * ⚠️ 设备列表只在连接活着（`on` / `warn`）时才有内容（`store.rs` 的
 * `connection_view`）—— 所以「空」和「没连上」在这个界面上是同一件事，不是两件。
 */
function renderDevices(state) {
  const host = el('devices');
  host.textContent = '';
  const room = state.rooms[state.selected];
  const devices = room?.connection?.devices || [];
  if (!devices.length) {
    // ⚠️ 用连接状态自己的那句话（「还没开始连」/「已断开：连接被拒绝」…），
    // **不在这里另编一句** —— 那句话是壳给的，两处说法不一致就是第二份定义。
    // ⚠️ 那句状态也是壳给的（`Msg`），同样要 `say`。
    const status = room?.connection?.text ? say(room.connection.text) : '';
    host.append(h('span', null, room ? (status || t('还没连上')) : t('没有房间')));
    return;
  }
  for (const device of devices) {
    // ⚠️ 图标按服务端认出来的 `kind` 选（`user_agent.rs` 的 desktop/smartphone/tablet），
    // **不靠设备名猜** —— 名字是用户自己起的自由文本，猜出来的图标会乱。
    // ⚠️ 没有平板专用的 emoji，平板与手机同用一个 📱（这是有意的，不是漏了）。
    const icon = device.kind === 'smartphone' || device.kind === 'tablet' ? '📱' : '💻';
    const dot = h('span', device.me ? 'd me' : 'd', icon);
    // ⚠️ 名字可能是**空的**（客户端没声明过设备名）—— 那时要说「本机」/「未知设备」，
    // 而不是留一个空 title（鼠标停上去什么都没有 = 看着像坏了）。
    dot.title = device.me
      ? (device.name ? t('{name}（本机）', { name: device.name }) : t('本机'))
      : (device.name || t('未知设备'));
    host.append(dot);
  }
  host.append(h('span', null, t('{n} 台在线', { n: devices.length })));
}

/** 整个界面。⚠️ 「有没有房间」也要画出来 —— 半个状态是骗人的。 */
/* ── 自动更新（2026-10-07）───────────────────────────────────────────────
 *
 * ⚠️★ 状态**不是这里查出来的** —— 它在 `snapshot.update` 里（壳每 500ms 推一次），
 * 与主界面走同一条路。所以这里只负责**画**，以及把按钮接上。
 * ⚠️ 推进那一格的是**壳**（`Store::set_update` 会让快照版本号前进），
 * 所以 `render` 被调用时这一格自然就是最新的。
 *
 * ⚠️ 页面**拿不到 updater 插件的 JS API**（`capabilities/default.json` 里故意没给，
 * 判据 9 盯着这件事）—— 下面几个按钮调的都是壳自己的命令。
 */

/** 「下载并重启」按过第一下之后、等用户确认的那一步。
 *  ⚠️ 它是**模块级**的，不是每次渲染重置的：`render` 会因为别的原因（来了一条消息、
 *  下载进度变了）被调用，把确认状态重置掉的话，用户点完「下载并重启」会发现按钮
 *  自己又变回去了 —— 看起来就是「点了没反应」。 */
let updateConfirming = false;
/** 上一次画出来的那份更新状态。
 *  ⚠️★ 「下载并重启」按第一下之后要**就地重画一次**（把确认露出来），而那次重画
 *  不该依赖 `lastState` 还在不在 —— 它是 tick 的产物，而按钮的点击与 tick 无关。
 *  记住它自己那一份，重画就只依赖自己。 */
let lastUpdate = null;

function renderUpdate(update) {
  lastUpdate = update || null;
  const phase = (update && update.phase) || 'idle';
  const text = el('dg-update-state');
  const notes = el('dg-update-notes');
  const check = el('dg-update-check');
  const install = el('dg-update-install');
  const skip = el('dg-update-skip');
  const confirm = el('dg-update-confirm');
  const cancel = el('dg-update-cancel');

  let label = t('已是最新');
  let busy = false;
  let offer = null; // 有新版时那个版本号（下载 / 跳过都要用它）
  let body = '';

  switch (phase) {
    case 'checking':
      label = t('正在检查…');
      busy = true;
      break;
    case 'available':
      label = t('发现新版本 {version}', { version: 'v' + update.version });
      offer = update.version;
      body = update.notes || '';
      break;
    case 'downloading': {
      // ⚠️ 对面没给 `Content-Length` 时**没有**百分比可比 —— 那就只说「正在下载」。
      // 编一个假进度（或者一直显示 0%）比不显示更糟：用户会盯着一个不动的数字。
      const total = update.total;
      label = total
        ? t('正在下载 {percent}%', { percent: Math.floor((update.received / total) * 100) })
        : t('正在下载…');
      busy = true;
      break;
    }
    case 'ready':
      label = t('已下载 v{version}，重启后生效', { version: update.version });
      busy = true;
      break;
    case 'skipped':
      label = t('已跳过 v{version}', { version: update.version });
      break;
    case 'failed':
      // ⚠️★ 壳给的是 `{key, params}`（`Msg`），**不是成文的句子** —— 要走 `say` 渲染。
      // 直接塞进 `textContent` 会印出 `[object Object]`（判据 16 要的就是这个形状）。
      label = say(update.msg);
      break;
    default:
      break;
  }

  text.textContent = label;
  notes.hidden = body === '';
  notes.textContent = body;
  // ⚠️ 查的时候禁用「检查更新」：连点几下会并发发几个网络请求，而它们回来时
  // 会互相覆盖状态（先回来的那个反而是旧的）。
  check.disabled = busy;
  // ⚠️★ 只有「有新版、且没在忙」时才露出那三个动作按钮。
  // 下载中/装完/失败时露着它们，用户会以为还能再点一次。
  const canAct = offer !== null && !busy;
  install.hidden = !canAct || updateConfirming;
  skip.hidden = !canAct || updateConfirming;
  confirm.hidden = !canAct || !updateConfirming;
  cancel.hidden = !canAct || !updateConfirming;
  install.dataset.version = offer || '';
  skip.dataset.version = offer || '';
  // 状态不再是「有新版」时，把确认那一步收回去（比如用户点了跳过、或者查出来没新版）
  if (!canAct) updateConfirming = false;
}

el('dg-update-check').addEventListener('click', () => {
  updateConfirming = false;
  invoke('update_check').catch((error) => {
    showNotice('error', t('检查更新失败：{error}', { error: errorText(error) }));
  });
});

el('dg-update-install').addEventListener('click', () => {
  // 第一步：只把「确认」露出来，**不**开始下载。
  updateConfirming = true;
  renderUpdate(lastUpdate);
});

el('dg-update-cancel').addEventListener('click', () => {
  updateConfirming = false;
  renderUpdate(lastUpdate);
});

el('dg-update-confirm').addEventListener('click', () => {
  // ⚠️★ 从这一刻起**壳会把应用关掉重装** —— 所以这里不做任何「等它回来」的事，
  // 也不用管返回值（macOS/Linux 上这个命令不会返回）。
  updateConfirming = false;
  invoke('update_install').catch((error) => {
    showNotice('error', t('更新失败：{error}', { error: errorText(error) }));
  });
});

el('dg-update-skip').addEventListener('click', () => {
  updateConfirming = false;
  invoke('update_skip', { version: el('dg-update-skip').dataset.version }).catch((error) => {
    showNotice('error', t('跳过失败：{error}', { error: errorText(error) }));
  });
});

function render(state) {
  lastRooms = state.rooms;
  // ⚠️★ 换房间**必须**把「展开」那两份状态清掉：`entry.id` 是每个房间各自单调的，
  // 不清就会把「B 房间的 7 号」当成「A 房间展开过的 7 号」—— 展开出**别人的内容**，
  // 而且不报错。⚠️ 这段必须在下面更新 `lastSelected` **之前**判。
  if (state.selected !== lastSelected) {
    openedIds.clear();
    openedBodies.clear();
    // ⚠️ 预览地址那份缓存**也要清**：它的键是条目 id，而 id 是每个房间各自单调的 ——
    // 留着就会把 A 房间那条 7 的地址用到 B 房间的 7 上（显示**别人的内容**，不报错）。
    previewSrcs.clear();
    // ⚠️★ 「看过哪里」与「有几条新的」同样是**按房间**的：基线不清的话，那颗胶囊会
    // 拿 A 房间的 id 去数 B 房间的条目 —— 数字是假的，而界面上看不出来。
    unseenCount = 0;
    seenLastId = 0;
    // ⚠️★ 换房间**从底部开始看**：`#timeline` 是同一个节点，`scrollTop` 会跟着上一个房间
    // 的位置带过来（只在超出新内容高度时被浏览器夹一下）—— 换过去停在半空中看不出因果。
    // 置 `true` 之后下一次重绘就贴底（见 `timelinePinned`）。
    timelinePinned = true;
  }
  lastSelected = state.selected;
  lastLimits = state.limits;
  // ⚠️ 更新那一格**每次重绘都要画**（它不在主界面上，但状态随时会变 ——
  // 检查中 / 下载中 / 装完待重启）。设置窗口没开着时写它也无害。
  renderUpdate(state.update);
  el('room-count').textContent = String(state.rooms.length);
  renderRooms(state);
  renderTimeline(state);
  renderDevices(state);
  // ⚠️ iframe 的地址要跟着**当前房间**走，而房间只在快照里 —— 所以对齐放在渲染这一拍
  //    （`syncSpa` 自己只在真变了时才动 `src`）。
  //    ⚠️ `lastState` 的赋值**在别处**（`tick` / 换语种那两条路要用它），这里不碰。
  syncSpa(state);
  updateCounter();

  const room = state.rooms[state.selected];
  el('room-name').textContent = room ? room.name : '—';
  // ⚠️ 只留「几条」：房间 id 和服务端地址塞进标题是**噪音**，
  // 而它们都能在「设置」里查到（诊断那一页专门放这些）。
  el('room-meta').textContent = room ? t('· {n} 条', { n: room.count }) : '';

  // ⚠️★ 本机窗口里**留多少**要照实说，而且是**两道界**：
  // ① 条数（`MAX_ENTRIES_PER_ROOM`）；② 正文总字节（`MAX_BYTES_PER_ROOM`，2026-09-27 加的）。
  // 只说条数的话，用户看到列表停在 37 条只会以为「消息丢了」—— 而真凶是字节那道界
  // （服务端的 `text.limit` 被调大之后，200 条那一格永远填不满）。
  // 这不是历史长度 —— 历史长度是服务端的 `server.history`，两件事别混。
  // ⚠️ 它原来在**侧栏底部**（`#max-entries`，跟着那行 ↑↓ 说明一起），2026-09-26 那行说明
  // 被 Jonny 要求删掉，于是这一句搬到了「设置 → 关于」那一页（`#dg-max`）——
  // 搬而不是删：这一句是「列表为什么停在这儿」的唯一解释。
  // ⚠️ 在 `render` 里写它（而不是 `openSettings` 里）是有意的：这两个上限在
  // **快照**里、不在 `settings_view` 里，而这一页随时可能开着 —— 在 `render` 里写，
  // 它就不会是一个「打开设置那一刻的旧值」。
  // ⚠️ 值里**不重复**「本机」：左边那一格的标签已经写着「本机保留」了。
  if (state.maxEntries) {
    const bytes = state.maxBytes ? t(' / 正文 {size}', { size: sizeLabel(state.maxBytes) }) : '';
    el('dg-max').textContent = t('最多留最近 {n} 条{bytes}', { n: state.maxEntries, bytes });
  } else {
    el('dg-max').textContent = '—';
  }

  // ⚠️★ 长文的**代价要看得见**：`dg-max` 说的是**条数**那道界，而真正的内存是
  // 「条数 × 每条多大」，后者由服务端的 `text.limit` 决定。不显示的话，
  // 「把上限调大」在用户眼里是**免费**的（而 §8.2 那节算过：10 万字符 × 200 条 = 几十 MB）。
  // ⚠️ 数的是**选中那个房间**的条目正文（`text_bytes` 是**全文**字节数，不是快照里那份
  // 预览的长度 —— 所以这个数与「快照现在有多小」是两件事，别混）。
  el('dg-roombytes').textContent = room ? sizeLabel(room.textBytes) : '—';

  const problems = el('problems');
  // ⚠️★ 全文**同时**挂到那一块的 `title` 上：侧栏收起时它只画一个 `⚠`
  //（56px 放不下这句话），悬停读得到 —— 「收起来就看不见了」是静默失败，不能那么干。
  // ⚠️ 这里两个出口写的是**同一个字符串**（不是两句同义的话）：一处是画出来的正文，
  // 一处是它的悬停提示。所以「有毛病 / 没毛病」也只需要判一次。
  const problemText = state.problems.length
    ? t('配置有毛病：{list}', { list: state.problems.map(say).join(t('problem.sep')) })
    : '';
  problems.hidden = problemText === '';
  problems.title = problemText;
  // ⚠️ 只写那一格 `span`，不写 `problems` 本身 —— 它里面还有一个收起来时才画的 `⚠`。
  el('problems-text').textContent = problemText;

  // ⚠️★ 换了房间 → 上一条提示**立刻收掉**（2026-09-30，Jonny 报的「切到 B 还挂着 A 的」）：
  // 提示归房间，而这一格长在房间标题下面 —— 挂着上一条读起来就是**这个**房间的事。
  // 之后这一拍照常显示**新房间**自己那条（`if (state.notice)` 那半，如果它有）。
  if (state.selected !== noticeRoom) hideNotice();

  // ⚠️★ 壳里那条提示**走同一条显示路径**（`showNotice`）—— 见它的注释：
  // 原来这里直接写进 DOM，而 `clear_notice` 会让**下一拍**的重绘把它抹掉，
  // 于是「已发送 3 个文件」只闪一下（2026-09-27 修的）。
  if (state.notice) {
    // ⚠️★ 没有房间参数了：壳给出来的**就是当前选中房间那一条**
    //（没有才退回与房间无关的那一格）—— 见 `showNotice` 的注释。
    // ⚠️★ `state.notice.text` 是壳的一句话（`{key, params}`），要走 `say` 渲染 ——
    // 直接塞进 `textContent` 会印出 `[object Object]`。
    showNotice(state.notice.level, say(state.notice.text));
    // ⚠️ 顺手把壳里那条清掉：否则一条三分钟前的错误会一直重播。
    // ⚠️★ 清掉之后**还会**再来一次重绘（版本号前进过），而那一拍 `state.notice` 已经是
    // `null` 了 —— 但这里**没有**「否则就抹掉」那一支：收尾只归 `showNotice` 的计时器
    //（上一版在这儿照着 `null` 抹，才需要 `noticeVisible` 那个补丁）。
    invoke('clear_notice');
  }
}

/** 下一拍的那个 timer。
 *
 * ⚠️★ 必须留住它：`refreshNow()` 要能**取消**已排的那一拍 ——
 * 不取消的话那条 `setTimeout` 链还在，同一时刻就变成两条轮询
 *（频率翻倍，而用户每点一下就再多一条）。
 */
let tickTimer = null;
/** 正在取快照吗。⚠️ `tick` 是 async，用户连点几下就会并发进来两条。 */
let ticking = false;
/** 取这一拍的时候又来了请求 —— 跑完**立刻再跑一次**（不丢，也不并发）。 */
let tickAgain = false;

/** 排下一拍（永远只有一条链）。 */
function scheduleTick(delay) {
  clearTimeout(tickTimer);
  tickTimer = setTimeout(tick, delay);
}

/** 立刻取一次快照，**不等**那一拍。
 *
 * ⚠️★ 为什么需要它：界面是**轮询**驱动的（`POLL_MS`），于是每个用户动作
 *（切房间、开 ↑/↓）都要等下一次轮询才看得见 —— 实测「点一下到界面有反应」
 * 就是 282–700ms，而那段时间里什么都没发生（数据早就在壳里了）。
 * 动作之后自己叫一次，这段死等就没了。
 *
 * ⚠️ 只用于**用户动作之后**，别拿它去替换轮询：轮询是「后台盯着」，
 * 而这里是「刚发生了我知道的事，立刻看一眼」。
 */
function refreshNow() {
  if (ticking) {
    tickAgain = true;
    return;
  }
  clearTimeout(tickTimer);
  tick();
}

/** 下一拍等多久。⚠️ 正在等那个房间的历史时问得勤一点（见 `POLL_FAST_MS`）。
 *
 * ⚠️★ 取失败过（`historyFailed`）就**不再快轮询**：自动重试已经停了，还按 150ms 问
 * 只是空转（2026-09-30）。
 */
function nextDelay() {
  const room = lastState?.rooms?.[lastState.selected];
  return room && !room.historyLoaded && !room.historyFailed ? POLL_FAST_MS : POLL_MS;
}

async function tick() {
  ticking = true;
  try {
    const state = await invoke('snapshot');
    // ⚠️★ 留下来是给**换语种**用的（见 `lastState` 的注释）：换语种不动版本号，
    // 所以不能指望下一拍会重画。⚠️ 在判「要不要重画」**之前**存：形状没变的那几拍
    // 也照样更新它（否则换语种会重画一份过期的房子）。
    lastState = state;
    // ⚠️ 取历史是**每一轮**都要判的，不能放在 `render` 里 ——
    // `render` 只在「形状变了」时跑，而「取不到历史」恰恰**什么都不改**
    //（这正是这个文件开头那段注释说的那类坑）。放这里，失败才追得下去。
    ensureHistory(state);
    const shape = shapeOf(state);
    if (shape !== lastVersion) {
      lastVersion = shape;
      render(state);
    }
  } catch (error) {
    // ⚠️ 取不到状态要把「为什么」说出来：最常见的是窗口比壳活得久（壳崩了/正在退出）。
    // 主界面上没有地方放它（侧栏那块调试信息已删），所以进一次性提示。
    showNotice('error', t('取不到状态：{error}', { error: errorText(error) }));
  } finally {
    ticking = false;
  }
  // ⚠️★ 取这一拍期间来的请求（用户连点几下）**不丢**：立刻再跑一次。
  //    并发跑两条的话，`lastState` / `lastVersion` 会被乱序写。
  if (tickAgain) {
    tickAgain = false;
    tick();
    return;
  }
  scheduleTick(nextDelay());
}

function sendCurrentInput() {
  const input = el('input');
  const text = input.value;
  if (!text.trim()) return;
  invoke('send_text', { text }).catch((error) => showNotice('error', t('发不出去：{error}', { error: errorText(error) })));
  input.value = '';
  // ⚠️★ 发完**跟到最新**（2026-10-04 Jonny：「我发送消息时，窗口应该定位到最新消息」）——
  // 用户往上翻着读历史时也不会「发完了看不见自己那条」。
  followToNewest();
}

/* ── 从界面发文件：📎 / 🖼 / 拖进来 / 粘贴 ────────────────────────────
 *
 * ⚠️★ 四条路（两颗按钮 / 拖放 / 粘贴）**必须汇到同一条命令**
 *（`send_files`）—— 它们只是「怎么选到文件」不同，「怎么发出去」是同一件事。
 * 分开写一定会漂（比如只有按钮那条做了校验）。
 *
 * ⚠️★ 页面**不自己发请求**：走壳的命令，限额/凭据/多文件那些规则全在
 * `clip9-client` 里（`runtime.rs` 的 `send_files` 注释）。
 *
 * ⚠️★ 「粘贴即发送」当年**刻意没做**，那两条理由现在的答案（2026-10-04 补的）：
 *   ① 「webview 拿不到粘贴文件的**真实路径**」→ 走得通了：`save_pasted_file`
 *      把字节落成临时文件（`File` 只有字节和名字，而 `send_files` 要的是路径）；
 *   ② 「粘的东西本来就在剪贴板里，监听**已经在发它了**」→ **仍然成立**，而且
 *      **去重兜不住它** —— 界面这条路上行**不过去重**（`Runtime::upload` 里
 *      `UploadSource::FromUi` 直接 `upload_explicit`），而文件那条去重是按**路径**
 *      算的（`Debouncer::accept` 的 `hash_paths`），临时文件每次都是新路径。
 *      所以「↑ 开着的时候粘一次」**可能多出一条**：与「🖼 选同一个文件发两次」
 *      是同一类（主动发送本来就不去重），**不是粘贴独有的**。
 *      ⚠️ 反过来：↑ **关着**的时候（默认全关）粘贴是**唯一**的入口 —— 那时剪贴板里的
 *      截图根本不会自己出去，用户想发只能在这儿粘。
 */

/** 把一批路径交给壳去发。⚠️ 空数组**什么都不做**：那是用户按了「取消」。 */
function sendFiles(paths) {
  const list = (paths || []).filter((path) => typeof path === 'string' && path.trim() !== '');
  if (!list.length) return;
  invoke('send_files', { paths: list }).catch((error) => showNotice('error', t('发不出去：{error}', { error: errorText(error) })));
  // ⚠️ 与 `sendCurrentInput` 同一条规矩：发完跟到最新（那几张「正在发送」的占位卡
  // 就长在列表末尾，用户得看得见它们）。
  followToNewest();
}

/** 📎 / 🖼：让**壳**弹系统文件选择框（页面自己没有这个能力，见 `commands::pick_files`）。 */
async function pickAndSend(imagesOnly) {
  try {
    sendFiles(await invoke('pick_files', { imagesOnly }));
  } catch (error) {
    showNotice('error', t('打不开文件选择框：{error}', { error: errorText(error) }));
  }
}

/** 粘进来的一个文件 → 字节交给壳落成临时文件 → 拿回路径。
 *
 * ⚠️★ 为什么绕这一趟：webview 的 `File` **没有路径**（macOS 上从访达复制一个文件再粘
 * 也是这样），而 `send_files` 认的是路径；页面自己又落不了盘。
 */
async function pastedPath(file) {
  // ⚠️ `readAsDataURL` 是这份手写界面里唯一不用打包器就能拿到字节的路 ——
  // 它是**异步**的，所以这里包一层 Promise（别的路都要 `FileReader` 之外的 API）。
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').split(',').pop() || '');
    reader.onerror = () => reject(new Error(t('读不出粘进来的这个文件')));
    reader.readAsDataURL(file);
  });
  return invoke('save_pasted_file', { name: file.name || 'pasted-file', base64 });
}

/** 发送框里 ⌘/Ctrl+V 粘到图 / 文件时：直接发出去（与 🖼 那条一致 —— 选到就发）。 */
async function pasteFiles(files) {
  const paths = [];
  try {
    for (const file of files) paths.push(await pastedPath(file));
  } catch (error) {
    showNotice('error', t('发不出去：{error}', { error: errorText(error) }));
    return;
  }
  sendFiles(paths);
}

// ⚠️★ **只在剪贴板里真有文件时动手**：粘一段文字时 `files` 是空的，那时必须
// **什么都不做** —— 拦了默认行为又不自己把文字插回去，就是「粘贴坏了」。
// ⚠️ 两个来源都看：有的平台把文件放进 `files`，有的只在 `items` 里给（`kind==='file'`）。
el('input').addEventListener('paste', (event) => {
  const data = event.clipboardData;
  if (!data) return;
  const files = Array.from(data.files ?? []);
  const picked = files.length ? files : Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!picked.length) return;
  // ⚠️ 不拦的话浏览器会把文件名（或者什么都没有）插进输入框 —— 那一段字还会被当成正文发出去。
  event.preventDefault();
  pasteFiles(picked);
});

el('btn-send').addEventListener('click', sendCurrentInput);
el('btn-attach').addEventListener('click', () => pickAndSend(false));
el('btn-image').addEventListener('click', () => pickAndSend(true));
el('input').addEventListener('input', updateCounter);
// ⚠️ 这一行是按界面稿写的（稿 1 的输入区左边那个 `.lim`）。
// 说的是**本界面的**动作，不是稿子里的「粘贴即发送」—— 那个为什么不做，见上面那段。
// ⚠️★ 包一层再调用，而不是直接写一句：这句**只在这里写一次**（`render()` 不碰它），
// 换语种时 `applyLocale()` 得能再刷一遍 —— 直接写的话英文界面里它就停在中文
//（不报错，而且中文界面永远是对的，所以只有真的切过去才看得见；探针抓到过）。
function renderComposerHint() {
  el('composer-hint').textContent = t('回车发送 · Shift+回车换行');
}
renderComposerHint();

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


/* ⚠️ 时间线的**右键菜单整块删掉了**（2026-09-29，Jonny：「列表内容页移除右键菜单」）。
 * 原来是一份自绘菜单（复制内容 / 复制链接），复制走 `copy_entry` / `copy_to_clipboard`
 * 两条壳命令 —— 现在网页视图里的卡片自己带复制按钮，桌面这份紧凑列表不再需要。
 * ⚠️ 连带清掉的：`lastEntries`（它存在的唯一理由就是「菜单从下标反查条目」）、
 * 卡片上的 `data-index`、`.ctxmenu` 那段 CSS、菜单专属的几条文案。
 * ⚠️ 壳里的 `copy_entry` / `copy_to_clipboard` 两条命令**留着**（有测试钉着，
 * 而且网页视图之外将来未必不用）。 */

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
  // ⚠️★ 上一次就取失败过 → **停**（2026-09-30，Jonny：「连不上还每 5 秒取一次、
  // 每 5 秒弹一次」）。手动重试不在这里：点一下那个房间就走 `select`（壳里记 `ByUser`）。
  if (room.historyFailed) return;
  const key = `${room.server}\u0000${room.room}`;
  const last = historyAsked.get(key) ?? 0;
  if (Date.now() - last < HISTORY_RETRY_MS) return;
  historyAsked.set(key, Date.now());
  invoke('refresh')
    .finally(refreshNow)
    .catch(() => {});
}

// ⚠️ 这里原来绑的是 `#conn`（那个同步胶囊的点击 → `set_monitoring`）。
// 胶囊和那条命令 2026-09-26 一起删了，见上面那段注释。
el('rooms').addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], .room');
  if (!target) return;
  const index = Number(target.dataset.index);
  if (Number.isNaN(index)) return;
  const room = currentRoom(index);
  if (target.dataset.action === 'upload') {
    // ⚠️★ 下面三条都跟着 `.finally(refreshNow)`：界面是**轮询**驱动的
    //（`POLL_MS`），不叫这一下，用户点完要等最多 700ms 才看见那颗开关变色 ——
    // 而那 700ms 里什么都没发生（壳那边早就改完了）。见 `refreshNow` 的注释。
    invoke('set_upload', { index, on: !room.upload }).finally(refreshNow);
  } else if (target.dataset.action === 'download') {
    // ⚠️ 下载是**单选**：点已选中的那个 = 关掉它（而不是「点了没反应」）。
    invoke('set_download', { index: room.download ? null : index }).finally(refreshNow);
  } else {
    // ⚠️★ `select` 在壳里**顺带就发了取历史那条请求**（`commands::select` → `refresh_history`），
    // 所以这一下之后立刻取一份快照，就能看见选中态（以及可能已经到的内容）——
    // 不用等那一拍。剩下的「等内容」那半由 `POLL_FAST_MS` 接管。
    invoke('select', { index }).finally(refreshNow);
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

/* 内容区那两个视图的切换。
   ⚠️ 绑在文件末尾这一串里 —— 与其它 `el(…).addEventListener` 同一处：这份界面
   没有模块体系，启动代码就是末尾这些顶层语句。 */

/** 切视图：换状态 + 记住 + 立刻画。
 *
 * ⚠️★ 与 `setTheme` / `setSidebar` 同款：**存不上照样切**（这一次点的就得生效，
 * 只是下次启动记不住），也不弹提示 —— 界面偏好记不住没有「怎么办」可给。
 * ⚠️ 「记住」这件事在**点击**这一侧，不在 `applyView` 里：启动时那次 `applyView` 也会跑，
 * 在那儿写存储等于**每次启动都把当前值再存一遍**（把「没选过」这个状态抹掉）。
 */
function setMainView(view) {
  mainView = view;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch (error) {
    // 与主题 / 侧栏同一条：这一次点的得生效，只是下次启动记不住。
  }
  applyView();
}

el('view-list').addEventListener('click', () => setMainView('timeline'));

el('view-web').addEventListener('click', () => {
  // ⚠️ 地址的对齐就在 `applyView` 末尾那条（它也要服务启动时的那一次），这里不重复调。
  setMainView('spa');
});

/* ── 桌面端自己的输入框藏不藏（2026-09-29）───────────────────────────
   ⚠️★ 与主题 / 侧栏同一个规矩：**以 DOM 为准**（`data-composer`）—— `boot.js` 在
   第一次绘制之前就贴好了，这里只管「点一下」和存起来。存储键在 `boot.js` 里另有一份
   （判据 10 对着两处的值）。⚠️ 藏的是**整条输入区**：发消息改走网页视图里 SPA 自己的
   输入区（那边在个性化里也有输入区开关，`?embed=1` 只是替用户**预置**成关，
   用户随时可以在网页版里拨回来 —— 两边各关各的，用哪边由用户挑）。 */
const COMPOSER_KEY = 'composer';

const composerHidden = () => document.documentElement.dataset.composer === 'hidden';

function setComposerHidden(hidden) {
  const root = document.documentElement;
  // ⚠️ 藏输入区时把那排 `/` 胶囊一起收掉（见文件末尾那段注释）。
  // `closeSlashMenu` 是**函数声明**，在这里调用没问题（提升到整个脚本作用域）。
  if (hidden) closeSlashMenu();
  // ⚠️ `'shown'` 也显式写（跟 `data-sidebar` 写 `'wide'` 同一个理由：让「点了一下」在存储里看得见）。
  if (hidden) root.dataset.composer = 'hidden';
  else delete root.dataset.composer;
  try {
    localStorage.setItem(COMPOSER_KEY, hidden ? 'hidden' : 'shown');
  } catch (error) {
    // 存不上**照样生效**，只是下次启动记不住 —— 界面偏好不值得打断用户。
  }
  sqSet('sq-composer', !hidden);
}

// 启动对一次：`boot.js` 贴的是存储里的值，方块要跟它一致（不一致的表现是
// 「输入区藏了、方块却亮着」）。
sqSet('sq-composer', !composerHidden());
el('composer-toggle').addEventListener('click', () => {
  setComposerHidden(!composerHidden());
});

/* ── 输入区拖高（2026-09-29）─────────────────────────────────────────
   Jonny：「允许自由调整桌面端发送窗口的高度」。

   ⚠️★ 改的是**整条输入区**（`#composer` 的高度），**不是**给 `.box` / textarea 加
   `resize`：那两个只能改自己，改完下面那排按钮与边框的间距不跟着走（看着像「框破了」）。

   ⚠️ 高度挂在 `<html>` 的 `--composer-h` 上（`style` 属性），只有 `index.html` 里
   `.composer` 的 `height` 读它 —— 一处写、一处读，与 `data-theme` / `data-sidebar` 同族。
   ⚠️ `boot.js` 另有一份 `COMPOSER_H_KEY`（它要在第一次绘制之前先贴一次，判据 10 对着）。 */
const COMPOSER_H_KEY = 'composerHeight';

/** 再矮就放不下「一行输入 + 那排按钮 + 边框」。 */
const COMPOSER_H_MIN = 64;

/** 上界 = 屏高的 7 成。再高时间线就只剩一两行 —— 那是把主区挤没了，不叫「自由」。 */
function composerMaxHeight() {
  return Math.max(COMPOSER_H_MIN, Math.round(window.innerHeight * 0.7));
}

const composerCurrentHeight = () => el('composer').getBoundingClientRect().height;

/**
 * 把高度贴到 `<html>` 上（并可选地记下来）。
 *
 * ⚠️★ `save` 分开是**故意的**：窗口变小那一拍只**收边界、不记** —— 记了的话，
 * 「在大窗口下拖到 400」这个意图就被一个临时的小窗口覆盖掉，之后拉大也不再恢复。
 *
 * ⚠️ 拖动 / 键盘 / 窗口变化**三处都走它**：夹取只写一遍（三处各写一遍必然漂，
 * 而漂出来的表现是「拖到头了还能再拖一点」这种说不清的东西）。
 */
function applyComposerHeight(height, save) {
  const clamped = Math.min(Math.max(Math.round(height), COMPOSER_H_MIN), composerMaxHeight());
  document.documentElement.style.setProperty('--composer-h', `${clamped}px`);
  if (save) {
    try {
      localStorage.setItem(COMPOSER_H_KEY, String(clamped));
    } catch (error) {
      // 存不上**照样生效**（同 `setComposerHidden`）—— 只是下次启动记不住。
    }
  }
  return clamped;
}

// 拖拽带：`pointerdown` 之后**捕获**指针 ——
// ⚠️★ 往上拖时指针会跑进上面的 **iframe**（网页视图）里，而跨源 iframe 会把
// `pointermove` 吃掉（不冒泡到外层）→ 不捕获的话是「一拖进网页区就断」。
// ⚠️ 监听**仍挂在 `window` 上**（两层保险）：捕获成功时事件从拖拽带冒泡上来照样收到；
// 捕获失败时至少没跑出输入区这一段还能拖。
// ⚠️★ `setPointerCapture` 在**合成的 pointer 事件**上会抛 `NotFoundError` ——
// 所以必须包 `try`，而且它要放在**注册监听之前**：一次异常把监听器一起带走的话，
// 表现成「按下去拖不动」而控制台里那句话跟拖动一点关系都没有。
el('composer-resize').addEventListener('pointerdown', (event) => {
  event.preventDefault(); // 拖动时别把页面文字选中
  const startY = event.clientY;
  const startHeight = composerCurrentHeight();
  // ⚠️ 往上拖 = 变高，所以是 `startY - 当前`（反过来就是「往上拖反而变矮」）。
  const onMove = (moveEvent) =>
    applyComposerHeight(startHeight + (startY - moveEvent.clientY), true);
  const onEnd = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
  };
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch (error) {
    // 捕不上就退化成「只在输入区这一块能拖」—— 比整个拖不动好。
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
});

// ⚠️ 键盘也走同一条路（拖拽带是 `tabindex="0"` 的，见 `index.html`）：
// 一个**只能用鼠标**的功能不算做完了。
// ⚠️ 只在这个元素**自己有焦点**时响应 —— 挂到 `window` 上的话，输入框里按方向键
// 也会跟着改高度（而方向键在输入框里本来是有含义的）。
el('composer-resize').addEventListener('keydown', (event) => {
  const step = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
  if (!step) return;
  event.preventDefault();
  applyComposerHeight(composerCurrentHeight() + step, true);
});

/* ── 输入框的 `/` 快捷菜单（2026-10-03）────────────────────────────────
 *
 * Jonny：「桌面端输入框要支持 `/` 快捷方式」。
 *
 * ⚠️★ 它**与网页版是同一条实现**：模板与那五个判定函数都在 `slash-template.js`
 *（由 `tools/sync-action-catalog.mjs` 逐字节搬过来，与 `actions-pure.js` 受同一条
 *「零 import」的检查）。这里只写**桌面这一侧**的三件事：什么时候开/关、
 * 浮层长什么样、往 textarea 里插什么。
 * ⇒ 别在这里另写一份「行首才算」之类的判定：两份一定会在某次改动里漂，而漂出来的
 * 表现是「网页版弹得出来、桌面弹不出来」这种最难查的东西。
 *
 * ⚠️ 判定**只看文本**（`/` 落在行首、前面只有空白），不看按键事件 —— 理由见那个文件
 *（手机上 keydown 报不出 `/`）。桌面有硬件键盘，所以两条路都接：
 * keydown 是「快一帧」的那条，input 才是唯一可靠的那条。
 */

let slashModule = null;
/** 现在挂着的那排胶囊（没有就是 null）。 */
let slashMenu = null;
/** 第几次开菜单。⚠️ 用来挡住**并发**的两次开启（理由见 `openSlashMenu`）。 */
let slashSeq = 0;

/** 按需加载那份共用实现。⚠️ 打第一个 `/` 时才加载 —— 不打就不付这一跳。 */
function slashKit() {
  if (!slashModule) slashModule = import('./slash-template.js');
  return slashModule;
}

/** 把一个 input 事件的**决定性字段**冻结在这一刻。
 *
 * ⚠️★ 为什么必须快照：`slashKit()` 是**异步**的，而判定读的是 `event.target.value` ——
 * 等它回来时那已经是**新值**了。于是同一 tick 里连发两个 input 事件（先发的那个看见
 * 后一个的文本）会**两次**都判成「刚打了一个 `/`」，叠出**两个**菜单；
 * 而 `closeSlashMenu` 只认 `slashMenu` 里最后那一个，先前的就成了**孤儿**，
 * 表现是「按 Escape 收不掉一半」（实测到过，见 2026-10-03）。
 * 判定只吃这四个字段，那就把这四个冻结下来，别让 `await` 之后再读活的 DOM。
 */
function slashSnapshot(event) {
  const box = event.target;
  return {
    isComposing: event.isComposing,
    inputType: event.inputType,
    target: {
      value: box.value,
      selectionStart:
        typeof box.selectionStart === 'number' ? box.selectionStart : box.value.length,
    },
  };
}

function closeSlashMenu() {
  if (slashMenu) {
    slashMenu.remove();
    slashMenu = null;
  }
}

/** 开那一排胶囊。⚠️ 里面那一次 `await` 之后要**回过头再判一次**：
 *  等动作库的这段时间里用户完全可能又敲了几个字（那时这排就不该弹出来了），
 *  而「弹了但已经不该弹」比「没弹」更烦人 —— 它挡在输入框上面。
 *
 * ⚠️★ `seq` 是**并发**用的：两次开启同时跑（同一 tick 里的两个 input 事件）时，
 * 先开始的那次在 `await` 回来后就**作废** —— 不然它会把自己那个面板挂上去，
 * 而后开始的那次的 `closeSlashMenu()` 早在它挂之前就跑完了，
 * 于是两个面板一起留在 DOM 里（见 `slashSnapshot` 那条注释）。
 */
async function openSlashMenu(input) {
  const seq = (slashSeq += 1);
  closeSlashMenu();
  let kit;
  let library;
  try {
    [kit, library] = await Promise.all([slashKit(), window.ActionLibrary.ensure()]);
  } catch (error) {
    // ⚠️ 加载不了要**说出来**：一声不响的斜杠＝用户以为这个功能不存在。
    showNotice('error', t('动作库没加载起来：{error}', { error: errorText(error) }));
    return;
  }
  if (seq !== slashSeq) return;
  // ⚠️ 这里**故意读活的** `input.value`（不是快照）：等动作库那段时间里用户又敲了字，
  // 就不该再弹 —— 与 `slashSnapshot` 那条正好相反，两处要的不是同一个时刻。
  if (!kit.slashMenuShouldStay({ target: input }, input.value)) return;

  const panel = h('div', 'slashmenu');
  for (const item of kit.SLASH_TEMPLATES) {
    const chip = h('button', 'act', window.ActionLibrary.label(library, item.key));
    chip.type = 'button';
    // ⚠️★ 在 `mousedown` 上就拦掉：不拦的话点胶囊会让 textarea 先失焦
    //（光标丢了 → 插入的位置就错了），网页版那颗胶囊同一条理由。
    chip.addEventListener('mousedown', (event) => event.preventDefault());
    chip.addEventListener('click', () => insertSlashTemplate(input, item));
    panel.append(chip);
  }
  // ⚠️ 挂在 `#composer` 里（它是 `position: relative`），CSS 用 `bottom: 100%`
  // 把它顶到输入框**上方** —— 不塞进 `.box` 里：那会把输入区撑高、把下面那排按钮
  // 往下推（输入区高度是用户拖出来的，不该被一个浮层改掉）。
  el('composer').append(panel);
  slashMenu = panel;
}

/** 插一项：把光标前那个 `/` 换成它算出来的文本。
 *
 * ⚠️ 光标位置要在 `await` **之前**读：动作项（插入时间 / UUID）是算出来的，
 * 等回来时光标未必还在原处（与网页版那两处同一条）。
 */
async function insertSlashTemplate(input, item) {
  const kit = await slashKit();
  const text = input.value;
  const pos = typeof input.selectionStart === 'number' ? input.selectionStart : text.length;
  const head = kit.stripTrailingSlash(text.slice(0, pos));
  const tail = text.slice(pos);
  closeSlashMenu();
  let insert = '';
  try {
    insert = await kit.resolveSlashText(item, (id) => window.ActionLibrary.runById(id));
  } catch (error) {
    showNotice('error', t('这个动作没跑成：{error}', { error: errorText(error) }));
    return;
  }
  input.value = head + insert + tail;
  // ⚠️ 光标落在插入内容的**后面**（不是原地）：插模板就是为了接着往下写那几行。
  const caret = head.length + insert.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  updateCounter();
}

el('input').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (slashMenu) {
      closeSlashMenu();
      event.stopPropagation();
    }
    return;
  }
  if (event.key !== '/') return;
  // 硬件键盘：这里的 `/` **还没落进文本**，判定点在光标当前位置（快一帧的那条路）。
  // 屏幕键盘不保证走到这里 —— 靠下面那个 `input` 监听兜住。
  // ⚠️ 传**快照**（`slashSnapshot`）：等 `slashKit()` 回来时文本已经是新的了。
  const snap = slashSnapshot(event);
  slashKit()
    .then((kit) => {
      if (kit.slashPendingAt(snap.target, snap.target.value)) openSlashMenu(event.target);
    })
    .catch(() => {});
});

// `/` **只有** `input` 事件一定看得见（理由见 `slash-template.js`）：刚打完就弹，
// 继续敲别的（终端里的 `/usr/bin`、以 `/` 开头的日期）就收。
// ⚠️ 这两半都要有：只有「弹」没有「收」的话，模板那排会一直挂在输入框上面挡着。
el('input').addEventListener('input', (event) => {
  // ⚠️★ 判定用**快照**（`slashSnapshot`），不用 `event` 本身：见那个函数的注释 ——
  // 用活的 `event.target.value` 会叠出两个菜单。
  const snap = slashSnapshot(event);
  slashKit()
    .then((kit) => {
      if (!slashMenu) {
        if (kit.slashMenuShouldOpen(snap, snap.target.value)) openSlashMenu(event.target);
        return;
      }
      if (!kit.slashMenuShouldStay(snap, snap.target.value)) closeSlashMenu();
    })
    .catch(() => {});
});

// ⚠️ 失焦就收：`mousedown` 已经被胶囊自己拦住了（点胶囊不会失焦），所以走到这里的
// 一定是「点到别处去了」。缺这一条的话，点了侧栏还挂着一排胶囊挡在输入框上面。
el('input').addEventListener('blur', closeSlashMenu);

// ⚠️ 输入区被藏起来时也要收那排胶囊：它挂在 `#composer` 里，而那个容器会被整块
// `display:none` —— 留着的话下次展开又冒出来（那时用户早就忘了当初打了什么）。
// 收的那一句写在 `setComposerHidden` 里（那里是输入区隐藏的**唯一**入口）。

// ⚠️ 窗口变小之后，存下来的高度可能已经超过上界 —— 那一拍收一次（**不记**）。
// 不收的表现：输入区把时间线挤到 0 高，最下面那颗「发送」被顶出可视区（点不到了）。
// ⚠️ 只在**真的设过**的时候收：`documentElement.style` 里没有这个变量 = 用户没拖过
//（`boot.js` 也没贴）= 让它按内容自然高，别凭空给它一个高度。
window.addEventListener('resize', () => {
  if (!document.documentElement.style.getPropertyValue('--composer-h')) return;
  applyComposerHeight(composerCurrentHeight(), false);
});

// ⚠️ 不 `await`：地址拿不到就一直留在时间线上 —— **不该**为它拦住 `tick()`（那是整个界面）。
// ⚠️ 启动时只把两个视图的可见性对一次就够（`mainView` 的初值由 [`storedView()`] 从存储里读，
// 而 DOM 的初值是「时间线可见」—— 没选过时两者同向，一帧都不用跳）。
// 「有没有可嵌的站点」现在由 `syncSpa` 按**当前房间**决定，不再问壳要一个
// 本机地址 —— 所以这里不需要异步那一步；切换按钮等第一份快照到了才会露出来。
applyView();

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
      // ⚠️★ 这个表单是**逐字段重建**服务端配置的：新加的服务端配置项如果这里不写，
      // 用户点一次「保存」就会把它**悄悄冲回默认值**（而界面上看不出任何变化）。
      fileCleanup: numField('cfg-filecleanup', 300),
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

/** 运行时长：稿子里是 `2 小时 14 分` 这个写法。`null` = 不是这个客户端起的 → `—`。 */
function uptimeLabel(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return t('不到 1 分钟');
  if (minutes < 60) return t('{n} 分钟', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? t('{hours} 小时 {rest} 分', { hours, rest })
    : t('{hours} 小时', { hours });
}

/** 本地服务端那一块（设置 → 本机，以及两处顺带显示它的地方）。
 *
 * ⚠️★ **一次读全**（`server_status` 一条命令给五行）：这张卡片上的五样本来就该是
 * **同一瞬间**的快照 —— 分几次取的话，页面会在中间某一刻画出「监听有了、房间还是上一秒的」。
 *
 * ⚠️ 在不在跑是**问出来的**（壳真的去打了一条 `GET /server`），不是壳记着的 ——
 * 记着的那个在「进程被杀」「用户手动起了一个」时就是错的。
 * ⚠️ 拿不到的值**一律画 `—`，不编**：`—` 的意思在稿子里就是「这一格没有值」。
 */
async function refreshServerState() {
  let status;
  try {
    status = await invoke('server_status');
  } catch (error) {
    el('srv-state').textContent = t('读不到本地服务端的状态：{error}', { error: errorText(error) });
    return;
  }
  const { bundled, running, owned, startError } = status;

  // `.hd`：状态灯 + 一句话。⚠️ 「没有自带服务端」要说出来 —— 那时起停按钮点了也不会有反应。
  //
  // ⚠️★ 2026-09-30 起要把**三件不同的事**分开说（`running` 只说明「端口上有人答话」，
  // 见 `ServerStatusView` 那两个字段的注释）：
  //   · 那个服务端**不是这个客户端起的**（上次没收干净的孤儿 / 用户自己跑的）→ 灯换成
  //     警告色、并把这件事说出来；写「运行中」是**假话**（跑的是别人那一份前端）；
  //   · 起不来（`startError`：端口被占 / 15 秒没答话 / 二进制起不来）→ 把**原因**摆在这儿。
  //     启动那一拍没有「用户点了什么」，这句话只进日志就等于没人看得见；
  //   · 其余照旧。
  // ⚠️ `startError` 是壳给的一句话（`{key, params}`），要走 `say` 渲染 —— 别直接塞进 textContent。
  el('srv-dot').className = running ? 'dot' : 'dot off';
  let stateLine;
  if (!bundled) {
    stateLine = t('没有自带服务端（找不到 clip9-server）');
  } else if (running && !owned) {
    stateLine = startError ? say(startError) : t('端口上是别的服务端（不是这个客户端起的）');
    el('srv-dot').className = 'dot warn';
  } else if (!running && startError) {
    stateLine = say(startError);
  } else {
    stateLine = running ? t('本地服务端运行中') : t('本地服务端没在跑');
  }
  el('srv-state').textContent = stateLine;

  // `.kv` 五行 —— **逐行对着稿子**。
  el('srv-version').textContent = status.version || '—';
  el('srv-listen').textContent = status.listen || '—';
  el('srv-data').textContent = status.dataDir;
  el('srv-rooms').textContent = status.rooms === null || status.rooms === undefined
    ? '—'
    : `${status.rooms} / ${status.entries}`;
  el('srv-uptime').textContent = uptimeLabel(status.uptimeSeconds);

  // ⚠️ 「运行方式」那两选一：**选中的那个**加 `.on`，两个方块画勾 ——
  // 和稿子里 `.mode.on` 的写法一致。
  sqSet('srv-sq-local', status.localServer);
  sqSet('srv-sq-remote', !status.localServer);
  el('srv-mode-local').classList.toggle('on', status.localServer);
  el('srv-mode-remote').classList.toggle('on', !status.localServer);

  // 顺带刷另外两处显示同一件事的地方。
  el('server-state').textContent = !bundled
    ? t('本地服务端：这个客户端没有自带（找不到 clip9-server）')
    : running && !owned
      ? t('本地服务端：端口上那个不是这个客户端起的')
      : running
        ? t('本地服务端：运行中')
        : t('本地服务端：没在跑');
  el('dg-server').textContent = !bundled
    ? t('没有自带')
    : running && !owned
      ? t('不是本客户端起的')
      : running
        ? t('运行中')
        : t('没在跑');
}

// ── 本地服务端那一页（设置 → 本机）───────────────────────────────
//
// ⚠️ 这里的动作和后端的能力是**一一对应**的：状态是问出来的、起停只碰自己起的那个
//（`server_process::stop` 的文档里写着为什么）。界面上不编任何「大概在跑」的话。
//
// ⚠️ 三个动作**共用一个收尾**：先问一遍真状态，再决定灯与按钮 ——
// 而不是「点了停止就自己把灯改成灰的」（那是在**猜**结果，失败时界面会撒谎）。
// ⚠️ 失败时**先刷状态、再把那句话盖到 `.hd` 上**：这样灯是新的、话是刚发生的。
// 稿子这一页没有第二处放错误信息的地方，而「失败要留在界面上」是硬要求。
async function runServerAction(command, args, label) {
  // ⚠️ 这句也是**拼出来**的（`label` 是上一行的 `t('重启')` / `t('停止')`），所以它是一个
  // **符号键** —— 键里没有中文词、只有那个省略号。⚠️ 别写成模板串：那会让这个省略号
  // 永远停在中文那个字形上（判据 15 抓到过它）。
  el('srv-state').textContent = t('{label}…', { label });
  try {
    await invoke(command, args);
  } catch (error) {
    await refreshServerState();
    // ⚠️ 失败要**留在界面上**：重启失败而界面写着「运行中」，用户会以为好了。
    // 最常见的失败是「端口上那个不是这个客户端起的，所以不替你停」—— 那句话原样显示。
    el('srv-state').textContent = t('{label}失败：{error}', { label, error: errorText(error) });
    return;
  }
  await refreshServerState();
}

el('srv-restart').addEventListener('click', () =>
  runServerAction('server_restart', undefined, t('重启')));
el('srv-stop').addEventListener('click', () => runServerAction('server_stop', undefined, t('停止')));
el('srv-open').addEventListener('click', () => {
  invoke('open_web').catch(async (error) => {
    await refreshServerState();
    el('srv-state').textContent = t('打不开网页版：{error}', { error: errorText(error) });
  });
});
// 「运行方式」两选一。
// ⚠️★ 点**已经选中的那个**也要发命令：`set_local_server(true)` 顺带把服务端起起来 ——
// 而这一页**没有「启动」按钮**（稿子里只有重启 / 停止），所以那是「停了之后怎么回来」
// 的唯一入口。少了它，那个「停止」就是个单向门。
for (const [id, on] of [['srv-mode-local', true], ['srv-mode-remote', false]]) {
  el(id).addEventListener('click', () =>
    runServerAction('set_local_server', { on }, on ? t('切到「随客户端启动」') : t('切到「连别人的服务端」')));
}

/** 「服务端配置」这一层是从「设置」里点进来的吗 —— 关掉它时要**回到设置**。
 *
 * ⚠️★ 为什么需要这个标志（而不是「干脆别关设置」或「关的时候直接 `openSettings()`」）：
 * · 两个 `.overlay` 都铺满窗口，同时可见 = 两层窗口糊在一起（见设置导航那段注释）；
 * · `openSettings()` 会**重新读一遍壳里的设置**，把用户在设置里**还没保存的改动**冲掉 ——
 *   而「点开服务端配置看一眼就回来」正是最容易连着发生的操作。
 * 所以关掉时只是把设置那层**重新显示出来**：草稿还在 DOM 里，用户改了一半的东西不动。
 */
let serverPanelFromSettings = false;

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
    el('cfg-filecleanup').value = server.fileCleanup ?? 300;
    sqSet('cfg-roomlist', server.roomList === true);
    el('cfg-dbpath').value = server.dbPath ?? 'clip9.redb';
    el('cfg-storage').value = server.storageDir ?? 'uploads';
    el('cfg-textlimit').value = text.limit ?? 4096;
    // ⚠️★ 真实天花板要说出来，而且要和保存时那条校验**同一个数**（都来自 `clip9-core`）。
    // 不说的话，用户把上限填到 16 MiB 会以为生效了 —— 真相是 8 MiB 以上那部分
    // 在服务端的 HTTP 层就被拒了，报错还不是契约形状（`TEXT_LIMIT_MAX` 的注释里有完整推导）。
    // ⚠️ `max` 只挡**微调箭头**，手输的值它拦不住（这个表单没有 form 校验）——
    // 真正的闸是 `server_config.rs::patch` 里那条校验，这里只是「别让用户白填」。
    el('cfg-textlimit').max = String(view.textLimitMax);
    el('cfg-textlimit-max').textContent =
    t('{size}（{n} 字节）', { size: sizeLabel(view.textLimitMax), n: view.textLimitMax });
    el('cfg-fileexpire').value = file.expire ?? 3600;
    el('cfg-filechunk').value = file.chunk ?? 1048576;
    el('cfg-filelimit').value = file.limit ?? 268435456;
    sqSet('cfg-automation', automation.enabled === true);
    el('cfg-tick').value = automation.tickSeconds ?? 30;
    el('cfg-grace').value = automation.graceSeconds ?? 600;
    el('cfg-tz').value = automation.defaultTZ ?? 'Asia/Shanghai';
  } catch (error) {
    el('server-msg').textContent = t('读不到配置：{error}', { error: errorText(error) });
  }
  await refreshServerState();
}

el('cfg-close').addEventListener('click', () => {
  el('server-overlay').hidden = true;
  // ⚠️★ 从「设置」进来的 → **回到设置**（不是把两层一起关掉）。
  // 清掉标志：下一次打开这一层会自己重新设一次（否则它会在「不是从设置进来的」时候
  // 也把设置弹出来）。
  if (serverPanelFromSettings) {
    serverPanelFromSettings = false;
    el('settings-overlay').hidden = false;
  }
});

el('cfg-save').addEventListener('click', async () => {
  try {
    await invoke('server_config_save', { patch: serverPatch() });
    el('server-msg').textContent = t('已保存 —— 重启服务端后生效');
  } catch (error) {
    el('server-msg').textContent = t('没保存：{error}', { error: errorText(error) });
  }
});

el('cfg-save-restart').addEventListener('click', async () => {
  try {
    await invoke('server_config_save', { patch: serverPatch() });
  } catch (error) {
    // ⚠️ 没保存成功就**别重启** —— 拿一份没生效的配置去重启，只会让用户更糊涂。
    el('server-msg').textContent = t('没保存：{error}', { error: errorText(error) });
    return;
  }
  el('server-msg').textContent = t('正在重启…');
  try {
    await invoke('server_restart');
    el('server-msg').textContent = t('已保存并重启');
  } catch (error) {
    // ⚠️ 说清是「保存成功了、重启失败」—— 这两种的下一步完全不同。
    el('server-msg').textContent = t('保存了，但重启失败：{error}', { error: errorText(error) });
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

/** 「自动挑一个图标」那个池子（**壳递过来的** —— `SettingsView::emoji_pool`）。
 *
 * ⚠️★ 它必须在 `renderRoomRows()` **之前**填好（见 `openSettings` 里的顺序）：
 * 那一格是照它铺出来的，空着的话用户打开设置页只看到一项「自动」。
 * ⚠️ 初值是空数组而不是 `null`：`for…of` 对 `null` 会抛，而抛在渲染里 =
 * 整个设置页空白（这一版连控制台都不给用户看）。
 */
let emojiPool = [];

/** 一个「填字」输入框（**不带 `<td>`**）。⚠️ 用 `input` 事件更新草稿，不重渲染 ——
 *  每次重渲染都把 `value` 重设会把用户正在输入的光标顶掉。
 *
 *  ⚠️★ `autocapitalize="off"`：macOS 会在这个框里把首字母**自动大写**，
 *  而这一格填的是**地址**（用户实测把 `https://…` 打成了 `Https://…`，
 *  然后怎么都连不上）。见 `tools/desktop-ui-smoke.mjs` 里那条静态自检 ——
 *  这一侧没有测试运行器，「新加的输入框忘了关」只能靠它拦。
 *
 *  ⚠️★ 2026-09-30 拆成两层：**这里只管造那个 `<input>`**，包不包 `<td>` 是调用方的事。
 *  房间清单从 8 列表格改成了卡片（见 `renderRoomRows`），同一个输入框现在要放进
 *  两种容器里；而「这一格是地址、必须关自动大写」这件事**只许有一份定义**
 *  —— `roomauth-table` 那张表还在用 `<td>`（走 `cellInput`），房间卡片直接用它。
 */
function inputEl(value, onChange, placeholder) {
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('autocapitalize', 'off');
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/** 表格里的一个文本框单元格（`roomauth-table` 用；房间卡片改用 `inputEl`）。 */
function cellInput(value, onChange, placeholder) {
  const td = h('td');
  td.append(inputEl(value, onChange, placeholder));
  return td;
}

/** 凭据那一格：**不明文显示**（`type="password"`），旁边带一个「看一眼」。
 *
 * ⚠️★ 2026-09-29，Jonny：「客户端的添加房间里凭据要密码格式，不要明文显示」。
 *
 * ⚠️★ 为什么要那个 👁：掩上之后**没法核对**自己填了什么 —— 而这一格恰恰是
 * 「填错了就连不上」的地方（一个字符都不能差）。桌上摆着一张**看不清的表**，
 * 用户只能整段重打一遍。所以默认掩上、但给一个**当场能按**的开关。
 *
 * ⚠️★ 它**也要** `autocapitalize="off"`：按开之后它就是个普通文本框，那时
 * macOS 照样会把首字母大写 —— 而这一格同样是「不许改字面」的。
 * ⚠️ 判据 4 因此要把 `type='password'` 一起数进去（见 `tools/desktop-ui-smoke.mjs`）：
 * 只数 `text` 的话，这一格就是那条自检**看不见**的一处。
 *
 * ⚠️★ 与 `inputEl` 同一条：这里只造「输入框 + 👁」那一组（`.secret` 包着），
 * `cellSecret` 才是把它塞进 `<td>` 的那一层。
 */
function secretEl(value, onChange, placeholder) {
  const wrap = h('span', 'secret');
  const input = document.createElement('input');
  input.type = 'password';
  input.setAttribute('autocapitalize', 'off');
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));

  const peek = h('button', 'rv', '👁');
  peek.type = 'button';
  peek.setAttribute('aria-pressed', 'false');
  // ⚠️ 写成两个**直接**的取值、不要写成「条件 ? 甲 : 乙」塞进一次调用里：
  // 判据 15 找的是「字面量**紧跟在**调用名与左括号之后」，三元里那一半会被它判成
  // 「中文没走 t()」。⚠️ 注释里也**别写出带引号的调用样子**（判据 14 读的是**原文**、
  // 不剥注释，于是它会把这个例子当成一个真的键、要求字典里有它）。
  const label = () => (input.type === 'password' ? t('看一眼') : t('藏起来'));
  peek.title = label();
  peek.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    peek.setAttribute('aria-pressed', showing ? 'false' : 'true');
    if (showing) peek.classList.remove('on');
    else peek.classList.add('on');
    // ⚠️ 提示语要跟着换：不换的话按下去之后那行字说的是**上一个状态**。
    peek.title = label();
    // ⚠️ 焦点留在输入框上：用户按完 👁 多半是要接着改那一格，
    //   焦点跑到按钮上的话他还得再点一下。
    input.focus();
  });

  wrap.append(input, peek);
  return wrap;
}

/** 表格里的凭据单元格（`roomauth-table` 用）。 */
function cellSecret(value, onChange, placeholder) {
  const td = h('td');
  td.append(secretEl(value, onChange, placeholder));
  return td;
}

/** 草稿里这个房间的 ↑ 打开了吗。
 *
 * ⚠️★ 判据是 `=== true`：**字段缺了算关**。原来这里（和保存那处）写的是
 * `!== false` —— 那是「字段没有就是**开**」，与侧栏（直接读 `room.upload` 这个真布尔）
 * 以及 `Channel::new`（两个方向都关）**说两套话**。而 2026-09-27 把新建房间的默认
 * 也改成关之后，三种说法必须是同一个（「加个房间就悄悄往外发剪贴板」不能再有任何入口）。
 * ⚠️ 只有一个定义：保存时用**同一个函数**，别再抄一遍 `=== true`。
 */
const uploadOn = (room) => room.enable_upload === true;

/** 一个方向开关（↑ / ↓）。
 *
 * ⚠️ 返回的是那个 `<span>` 本身，**不带 `<td>`** —— 2026-09-30 房间清单改成卡片之后
 * 它不再住在表格里（`#roomauth-table` 没有这一列，所以也不用像 `cellInput` 那样留一层包装）。
 */
function dirToggle(on, kind, title, onToggle) {
  const box = h('span', on ? `dir ${kind} on` : `dir ${kind}`, kind === 'up' ? '↑' : '↓');
  box.title = title;
  box.addEventListener('click', () => onToggle(!on));
  return box;
}

/** 房间图标那一格：**点选**，不是输入框。
 *
 * ⚠️★ 2026-09-29，Jonny：「客户端的添加房间里图标可以点选，不要输入，用户又不懂输入
 * 啥」。原来它是一个文本框（留空 = 自动，占位符写着「自动」）—— 那要求用户
 * **自己知道去哪儿复制一个 emoji 过来**，而他多半只会打字（`work` / `room1`），
 * 而 `clean_emoji` 只收 1–2 个非 ASCII 字符 → 打了也等于没填。
 *
 * ⚠️★ 用**原生 `<select>`**，不自己拿 div 画一个下拉：
 *  · 这一格只有 7% 宽（660px 的窗口上约 46px），自己画就要处理「弹出层被表格裁掉」
 *    那类定位问题 —— 而它在窄窗口上才现形；
 *  · 原生控件自带键盘操作、读屏、点外面收起这些行为，自己写要再补一遍；
 *  · 这个项目对「平台已经有的东西」一律不重造（同一个判据见 `Cargo.toml` 里
 *    那几个插件的取舍）。
 *
 * ⚠️★ 选项来自**壳递过来的那份池子**（`SettingsView::emoji_pool` ←
 * `clip9_client::EMOJI_POOL`）—— **不在这里抄一份**。
 * ⚠️ 第一项是**空值 = 自动**：它对应 `Channel::emoji` 里「用户没选过」那件事
 *（不是「选了某一项」）—— 见 `SettingsView::rooms` 那段注释。
 *
 * ⚠️ 与 `dirToggle` 同一条：返回的是那个 `<select>` 本身，**不带 `<td>`**
 *（2026-09-30 房间清单改成卡片，这一格不再住在表格里）。
 */
function emojiPicker(value, onChange) {
  const pick = document.createElement('select');
  pick.className = 'ico';
  // ⚠️ 第一项固定是「自动」（`value=''`）—— 顺序不跟着池子走。
  // ⚠️★ 这里用的是**符号键**（`room.iconAuto`）而不是中文原文「自动」：后者在字典里
  // 已经被**卡片上那个定时标签**占了（`'自动': 'Scheduled'`）—— 共用的话，英文界面里
  // 这一项会写成 `Scheduled`，而且不报错。理由与代价写在 `i18n.js` 那一条上。
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('room.iconAuto');
  pick.append(auto);
  for (const glyph of emojiPool) {
    const option = document.createElement('option');
    option.value = glyph;
    option.textContent = glyph;
    pick.append(option);
  }
  pick.value = value ?? '';
  // ⚠️★ 「用户填过一个**不在池子里**的图标」（老配置 / 手改过配置文件）要单独补一个
  // option：`select.value = X` 在没有那个 option 时**静默落空**（`value` 变成 `''`），
  // 于是控件显示「自动」、而草稿里还是原来那个字符 —— 用户看着「自动」、保存下去却不是。
  // ⚠️ 这也是「`select` 的 value 只在选项里挑」这条 HTML 规矩唯一咬人的地方。
  if (pick.value !== (value ?? '')) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    pick.append(option);
    pick.value = value;
  }
  pick.title = t('房间图标：不选就是自动挑一个不重样的（侧栏那个就是）');
  pick.addEventListener('change', () => onChange(pick.value));
  return pick;
}

/** 房间清单（设置 →「服务端与房间」）。
 *
 * ⚠️★ 2026-09-30，Jonny：「添加房间可否换个形式，目前的列表编辑框都太窄了，
 * 展示不全，编辑的时候也不看见自己写了啥」。
 * 原来是一张 **8 列的 `<table class="ra">`**（图标/名字/服务端/房间/凭据/↑/↓/删），
 * 而它是 `table-layout: fixed` —— 列宽按百分比**硬切**，660px 的窗口里
 * 「服务端」只分到 26%（约 170px），一个 `https://…` 的地址在里面只能看见开头，
 * 光标一进去什么都读不出来。改成卡片之后每一行**横向分两层**，
 * 两个长字段（服务端 / 凭据）各占半宽（约 290px），名字与房间在上层同宽。
 *
 * ⚠️★ 布局全部交给 CSS（`.rlist` / `.rcard` / `.rc-top` / `.rc-bot`，见 `index.html`）——
 * 这里只负责**把哪些控件放进哪一层**。行内 `style` 一律不写：窗口宽度是变的，
 * 写着像素的样式在窄窗口上就是溢出（这正是上一版那张表踩过的坑）。
 */
function renderRoomRows() {
  // ⚠️ 放**最前面**：下面「一个房间都没有」那条会提前 return，
  // 放末尾的话那一格会留着上一次的内容（而列表已经空了）。
  renderDownloadSource();
  const body = el('rooms-body');
  body.textContent = '';
  if (!roomDraft.length) {
    // ⚠️ 从「一行 8 列的表格」改成卡片之后，这条空态也从 `<tr><td colspan=8>` 变成
    // 一个普通块 —— `colspan` 那个数（8）在卡片里已经没有意义，留着它就是一句谎话。
    body.append(h('div', 'empty', t('还没有房间。点下面的「添加房间」—— 服务端留空就是本机那个。')));
    return;
  }
  roomDraft.forEach((room, index) => {
    const card = h('div', 'rcard');

    const top = h('div', 'rc-top');
    // ⚠️ 图标放**最前面**：与侧栏那个房间行的顺序一致（先图标、再名字）。
    top.append(emojiPicker(room.emoji, (v) => { roomDraft[index].emoji = v; }));
    top.append(inputEl(room.name, (v) => { roomDraft[index].name = v; }));
    top.append(inputEl(room.room, (v) => { roomDraft[index].room = v; }, 'default'));

    // ⚠️ ↓ 是**全局单选**：点开一个，别的自动关掉。做成多选再靠后端「取第一个」
    // 的话，用户点第二个会**没反应** —— 那正是「配了不生效」。
    // ⚠️★ 悬停提示与侧栏那两个开关**逐字一致**（Jonny 2026-09-26 给的文案）——
    // 同一个图标在同一个 app 里说两句不同的话，就是第二份定义。
    // ⚠️「可多选」「全局只能一个」不再写进 title：这一页的说明文字
    //（上面那段 `.sub`）已经写着「收进剪贴板全局只能一个」了。
    const dirs = h('span', 'rc-dirs');
    dirs.append(dirToggle(uploadOn(room), 'up', t('发送本地剪贴板到远程房间'), (on) => {
      roomDraft[index].enable_upload = on;
      renderRoomRows();
    }));
    dirs.append(dirToggle(room.enable_download === true, 'dn', t('获取远程房间最新消息写入本地剪贴板'), (on) => {
      roomDraft.forEach((other, position) => { other.enable_download = on && position === index; });
      renderRoomRows();
    }));
    top.append(dirs);

    const button = h('button', 'btn rc-del', t('删'));
    button.addEventListener('click', () => {
      roomDraft.splice(index, 1);
      renderRoomRows();
    });
    top.append(button);
    card.append(top);

    // ⚠️★ 第二层：两个**长字段**。它们是这一页唯一会填 `https://…` / 长凭据的地方，
    // 所以这一层的两个格子带 `flex-basis: 280px`（见 CSS 里 `.rc-bot` 那段）——
    // 装得下就并排、装不下就各占一行。⚠️ 别改成固定两列：设置窗口是**固定 640px**
    // （`.overlay .win.settings`），并排之后每个输入框约 173px，
    // 而一个 `https://clip9.example.com/clip9` 要 190px 才够 —— 那等于没修。
    // ⚠️ 带标签（`.rc-l`）：表格那张版式靠**表头**说明每一格是什么，卡片没有表头，
    // 不补标签就只能靠占位符猜 —— 而占位符在**用户填上东西之后就消失了**。
    const bottom = h('div', 'rc-bot');
    bottom.append(labelField(t('服务端'),
      inputEl(room.server, (v) => { roomDraft[index].server = v; }, 'http://127.0.0.1:9502')));
    // ⚠️★ 凭据走 `secretEl`（**不明文显示**，2026-09-29）—— 别改回 `inputEl`。
    bottom.append(labelField(t('凭据'),
      secretEl(room.auth_token, (v) => { roomDraft[index].auth_token = v; }, t('（空 = 无密码）'))));
    card.append(bottom);

    body.append(card);
  });
}

/** 卡片第二层的一格：一个小标签 + 控件（横排，控件吃掉剩下的宽度）。
 *
 * ⚠️ 标签是**这里传进来的**（`t('服务端')` 那一句在调用点上）—— 不在这里按索引或
 * 字段名反查：那种「一个看不到的映射表」在改字段名时会静默错位（标签还在，只是配错了格）。
 */
function labelField(label, control) {
  const box = h('label', 'rc-f');
  box.append(h('span', 'rc-l', label));
  box.append(control);
  return box;
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
  const name = index >= 0 ? roomDraft[index].name || roomDraft[index].room || t('房间') : t('没有');
  host.textContent = '';
  host.append(name);
  host.append(h('span', 'src-note', index >= 0 ? t('在左侧栏用 ↓ 选') : t('没开：哪个房间的内容都收不到')));
}

async function refreshLog() {
  try {
    const view = await invoke('server_log');
    el('log-path').textContent = view.path;
    const text = (view.text || '').trim();
    el('log-text').textContent = text || t('（还没有日志 —— 服务端起来之后才会有）');
    el('log-state').textContent = text ? '' : '';
  } catch (error) {
    el('log-text').textContent = t('读日志失败：{error}', { error: errorText(error) });
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

/** 那条全局快捷键**现在到底占上了没有**（问系统，不是问配置）。
 *
 * ⚠️★ 为什么这一行非要有：勾选框画的是**配置里的意图**，而组合键被别的程序占着时
 * 勾照旧亮着 —— 用户看到的是「按了没反应」，而他会去查别的程序、去重启客户端。
 * 这一行是唯一能看出「它没占上」的地方。提示区那条会被下一个动作顶掉，这一行不会。
 * （自启那个勾是同一条规矩的另一半：那边**勾本身就是真相**，所以它不用这一行。）
 *
 * ⚠️ **关着的时候它不说话**：「关掉就不占这个组合键」那句就在勾选框旁边，再说一遍是噪音。
 * ⚠️ 只在两处刷：打开设置（读到配置之后）与保存成功之后 —— 那正是配置与系统
 * 可能不一致的两个时刻。⚠️ **勾选框本身被点的时候不刷**：那一刻草稿已经跑到配置前面，
 * 此时画出来的「没占上」会被读成「被别的程序占了」，而真正的原因是「你还没点保存」。
 */
async function refreshHotkeyState() {
  const state = el('sc-hotkey-state');
  if (!sqGet('sc-hotkey')) {
    state.textContent = '';
    return;
  }
  try {
    // ⚠️ 两个分支都是 `t(…)` 的**整句**（不是拼出来的）：中文的破折号在英文里是别的写法。
    state.textContent = (await invoke('hotkey_registered'))
      ? t('占上了 —— 现在按这个键有效。')
      : t('⚠️ 没占上（多半是别的程序占着它）—— 现在按这个键没反应。');
  } catch (error) {
    state.textContent = t('⚠️ 问不到系统里的快捷键状态：{error}', { error: errorText(error) });
  }
}

async function openSettings() {
  el('settings-msg').textContent = '';
  el('settings-overlay').hidden = false;
  showPane('rooms');
  try {
    const view = await invoke('settings_view');
    // ⚠️★ **顺序要紧**：图标那一格是照池子铺出来的，`renderRoomRows()` 之前没填好
    // 的话，用户打开设置页只能看到一项「自动」—— 而那是「功能没做」，不是报错。
    emojiPool = view.emojiPool;
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
    // ⚠️ 那一句由 `fileLimitText` 算，发送框用的是同一句（见那里的注释）。
    el('sc-file-hint').textContent = fileLimitText();
    el('sc-poll').value = view.pollIntervalMs;
    el('sc-dir').value = view.downloadDir;
    // ⚠️ 自启那个勾画的是**系统里的真相**（壳去问的系统），不是配置里的意图。
    sqSet('sc-autostart', view.autostart);
    // ⚠️ 这两个画的是**配置里的意图**（与上面那个自启的勾不一样）——
    // 它们没有「系统里的真相」这一说：发不发通知只有我们自己知道。
    sqSet('sc-notify-up', view.notifyUpload);
    sqSet('sc-notify-dl', view.notifyDownload);
    // ⚠️★ 这一格画的是**配置里的意图**（与自启那个勾**不一样**）——「系统里的真相」
    // 在它下面那一行（`refreshHotkeyState`）。两者**会**不一致（那个组合键被别的程序
    // 占着），而那时用户要能看出来，所以它们分开画、各有各的来源。
    sqSet('sc-hotkey', view.hotkeyEnabled);
    // ⚠️★ 那个组合键的写法**由壳算好递过来**（`hotkeys::display_toggle_window`）——
    // 界面里再写一份「⌘⇧V」的话，另一台机器上那一份就是错的（macOS 是 ⌘、别处是 Ctrl），
    // 而错的那一份**看起来一样正常**。算法只有一处。
    el('sc-hotkey-key').textContent = view.hotkeyToggleWindow;
    // ⚠️ 顺序要紧：它读的是**上面那句刚画上去的**勾（`sqGet('sc-hotkey')`）。
    await refreshHotkeyState();
    // ⚠️★ 客户端壳自己的版本 —— **只从壳拿**（`view.clientVersion`），页面里不许写死：
    // 发布时那份真值来自 tag（CI 用 `tauri build --config …` 注进构建），
    // 页面再抄一份就会与用户装的包各说各话。
    // ⚠️ 前缀 `v` 是照 Release 上的写法（`v0.1.1-beta1`）—— 用户报版本时念的就是那个。
    el('dg-client-version').textContent = 'v' + view.clientVersion;
    el('dg-data').textContent = view.dataDir;
    el('dg-config').textContent = view.configPath;
  } catch (error) {
    el('settings-msg').textContent = t('读不到设置：{error}', { error: errorText(error) });
  }
  // ⚠️ 本地服务端那一块（`#srv-*` / `#dg-server`）**不从这里填** ——
  // 它有自己的来源（`server_status`：状态 + 连接地址 + 哪些房间指向它）。
  // 两处各填一遍的话，`settings_view` 里就得再放一份「运行中」，而那两份会漂。
  await refreshServerState();
}

el('btn-settings').addEventListener('click', openSettings);
el('settings-close').addEventListener('click', () => {
  el('settings-overlay').hidden = true;
});
el('settings-nav').addEventListener('click', (event) => {
  const item = event.target.closest('.it');
  if (!item) return;
  // ⚠️ 有的项是**动作**不是页（`data-open`）：它打开另一个浮层，而不是切页。
  // ⚠️★ 两层不许同时可见 —— 两个 `.overlay` 都是**铺满窗口**的，叠起来时下面那层的
  // 暗底会把设置窗口一起压暗，用户看到「两个窗口糊在一起」，分不清在改哪个。
  // 所以这里先关掉设置，并**记住是从设置进来的**：关掉那个浮层要**回到设置**，
  // 而不是把两层一起关掉（2026-09-27 修 —— 用户报的就是「点进去再关，两层都没了」）。
  if (item.dataset.open) {
    el('settings-overlay').hidden = true;
    serverPanelFromSettings = true;
    openServerPanel();
    return;
  }
  showPane(item.dataset.pane);
  // ⚠️ 日志只在**切到那一页**时读一次：它可能很大，打开设置就读是白读。
  if (item.dataset.pane === 'log') refreshLog();
  // ⚠️ 快捷键那一页的最后一行是**问系统要的**（`hotkey_registered`）：每次切过来重问 ——
  // 用户可能刚在别处关掉了它，或者那个组合键被新装的程序占走了。
  if (item.dataset.pane === 'hotkeys') refreshHotkeyState();
});
/** 往草稿里加一个空房间。
 *
 * ⚠️★ **两个入口共用这一个函数**：设置页里那个「＋ 添加房间」（`#room-add`）和
 * 侧栏底部那个（`#btn-room-add`）。分开写的话，两边迟早会不一样
 * （比如只有一边补了某个新字段）—— 而这个项目最忌讳「同一个动作两套定义」。
 *
 * ⚠️ 服务端留空**不是**省事：空地址会被 `ClientConfig::problems()` 报出来，
 * 而界面会显示那条问题 —— 比悄悄填一个「大概是这个」强。
 */
function addRoomRow() {
  roomDraft.push({
    name: '',
    server: '',
    room: 'default',
    // ⚠️ 空 = **自动**（壳会挑一个不重样的）：所以「加一个房间」不用问图标，
    // 它自己就有一个，而且与已有的都不重样（`resolve_emojis`，有测试）。
    emoji: '',
    auth_token: '',
    // ⚠️★ 两个方向**都默认关**（Jonny 2026-09-27 改的：原来上行是 `true`）。
    // 理由：新建的房间还没填地址、还没测过通不通，先把 ↑ 打开等于「加一个房间就
    // 悄悄开始往外发本地剪贴板」—— 那与 §4.1 第 3 条（装完不该自动接管剪贴板）
    // 是同一个道理，只是触发点从「首次运行」换成了「点了添加房间」。
    // 另外这也与 `Channel::new`（两个都关）**一致**了 —— 原来两处不一样，
    // 于是「侧栏那个 ↑ 显示什么」在保存前后会变一次（保存前按草稿算、保存后按配置算）。
    enable_upload: false,
    enable_download: false,
  });
  renderRoomRows();
}

el('room-add').addEventListener('click', addRoomRow);

// 侧栏底部那个「＋ 添加房间」：**先把设置窗口打开到房间那一页，再加一行**。
// ⚠️ 顺序不能反：`openSettings()` 会拿壳里的配置**重铺**一遍草稿
//（`roomDraft = view.rooms.map(...)`），先加的那一行会被它冲掉。
// ⚠️ 为什么要「打开 + 加一行」而不是只打开设置页（那正是原来 `.room.add` 的行为）：
// 用户点的是「添加房间」，那就该**看到一个新的空行**等着填；
// 只把他丢到一个页面上、还要再点一次「＋ 添加房间」，是「点了没反应」的一种。
// ⚠️ 不用再 `showPane('rooms')` —— `openSettings` 自己就落在房间那一页。
el('btn-room-add').addEventListener('click', async () => {
  await openSettings();
  addRoomRow();
});

el('settings-save').addEventListener('click', async () => {
  const patch = {
    // ⚠️★ 这里的字段**必须**与 `Channel` 一个一个对上（少一个 = 那个字段被静默清掉）：
    // 整份房间清单是**替换**语义（`SettingsPatch::rooms` 给了就整份换），
    // 而 `Channel` 上缺的字段按 `#[serde(default)]` 落回默认值 ——
    // 少写一个 `emoji` 的症状是「保存一次，所有房间的图标全变回自动的」。
    // ⚠️ 静态自检第 12 条就是数这里的（它去 `client/src/config.rs` 读字段名）。
    rooms: roomDraft.map((room) => ({
      name: room.name || room.room || t('房间'),
      server: room.server.trim(),
      room: (room.room || 'default').trim(),
      // ⚠️ 发回去的是**用户填的那个**（可能为空 = 自动）——
      // 空就是空，别在这里把壳算出来的图标填进来（那等于替他做了选择）。
      emoji: (room.emoji || '').trim(),
      auth_token: (room.auth_token || '').trim() || null,
      enable_upload: uploadOn(room),
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
    // ⚠️ 通知这两个**不在 `sync` 那一组里**（壳那边 `SettingsPatch` 也是平级的）：
    // 它们是「通知」的事，与「同步范围」无关 —— 放进 `sync` 会让那个分组名开始说谎。
    notifyUpload: sqGet('sc-notify-up'),
    notifyDownload: sqGet('sc-notify-dl'),
    // ⚠️★ 这一项与上面几个**不一样**：它落地时要**真的去注册 / 撤销**那个全局键
    //（`hotkeys::apply`）—— 只改配置的话，用户勾了、界面勾着、键却没占上，
    // 那就是「配了不生效」。⚠️ 它失败了**不会**让这次保存整个失败（别的设置已经存下去了），
    // 失败只走提示区 + 快捷键那一页的「系统里的真相」那一行。
    hotkeyEnabled: sqGet('sc-hotkey'),
  };
  try {
    await invoke('apply_settings', { patch });
    el('settings-msg').textContent = t('已保存');
    // ⚠️ 保存会**真的去注册 / 撤销**那个全局键 —— 重新问一次系统。
    // 不重问的话，「没抢到」这件事只留在提示区里，而它一闪就过去了。
    await refreshHotkeyState();
  } catch (error) {
    // ⚠️ 失败要**留在界面上**：设置没存上而界面看着像存了，用户下次启动会发现白改。
    el('settings-msg').textContent = t('没保存：{error}', { error: errorText(error) });
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
    const td = h('td', 'sub', t('没有逐房间的凭据 —— 所有房间都用上面的全局密码（或都不需要密码）。'));
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
    // ⚠️★ 同一件事的第二处：这儿的「密码」也不明文（见 `cellSecret`）。
    // 两处一起改，别只改「添加房间」那一张表 —— 那是同一个秘密的两个入口。
    tr.append(cellSecret(entry.password, (v) => { entry.password = v; }, t('（空 = 无密码）')));
    // ⚠️ 「留空 = 不改」：这个键在配置里可以缺省，而清空它会让服务端解析失败。
    tr.append(cellInput(entry.fileExpire, (v) => { entry.fileExpire = v; }, t('（留空 = 不改）')));
    tr.append(cellInput(entry.automation, (v) => { entry.automation = v; }, t('（留空 = 跟随）')));
    // ⚠️ `open` 是**可编辑的**：原来画成一个只读胶囊，用户能看见「要密码 / 开放」
    // 却改不了 —— 而它就在这张可编辑的表里，那是最别扭的一种「看得见摸不着」。
    // ⚠️ 表格里的布尔，主流就是复选框（开关也行，但表格里复选框更省地方、也更准）。
    const state = h('td', 'tiny');
    const openBox = document.createElement('input');
    openBox.type = 'checkbox';
    openBox.checked = entry.open === true;
    openBox.title = t('这个房间是公开的（不需要密码）');
    openBox.addEventListener('change', () => {
      entry.open = openBox.checked;
    });
    state.append(openBox);
    tr.append(state);
    const del = h('td', 'tiny');
    const button = h('button', 'btn', t('删'));
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
  let name = t('新房间');
  let n = 2;
  while (name in roomAuthDraft) name = t('新房间{n}', { n: n++ });
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

// ── 灯箱的三种关法 ────────────────────────────────────────────────────────────
//
// ⚠️★ 三种都要：只有叉号的话，鼠标停在图上的人会被迫去找那颗按钮；
// 只有背景的话，习惯了「右上角 ✕」的人会以为关不掉；没有 ESC 就只能在窗口里摸。
// ⚠️ 三种都走**同一个** `closeLightbox` —— 关掉要做的事（清空 stage）只有一份。
el('lightbox-close').addEventListener('click', closeLightbox);
el('lightbox-bg').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (event) => {
  // ⚠️ 只在**灯箱开着**时管键盘：它盖着整个窗口，那时这些键没有别的含义；
  // 而关着的时候 ESC 归动作菜单 / 动作表单（它们各自的 `onKey` 已经先注册了），
  // `+` / `-` / `0` 归输入框（用户在一行字里打减号是很正常的事）。
  if (el('lightbox').hidden) return;
  if (event.key === 'Escape') {
    closeLightbox();
    return;
  }
  // ⚠️ `+` 在多数键盘上要按着 Shift（而 `key` 仍然报 `+`），`=` 是同一个键不按 Shift ——
  // 两个都收，免得分不清用户按的是哪个。
  if (event.key === '+' || event.key === '=') lbApplyZoom(lbZoom * LB_ZOOM_STEP);
  else if (event.key === '-' || event.key === '_') lbApplyZoom(lbZoom / LB_ZOOM_STEP);
  else if (event.key === '0') lbApplyZoom(1);
}, true);

// ── 灯箱的缩放（滚轮 / 三颗按钮 / 上面那套键盘）────────────────────────────────
//
// ⚠️★ 滚轮是**主**入口（2026-10-04 Jonny：「大图预览窗口需要支持鼠标滚轮放大缩小，
// 和 + - 号图标放大缩小」），而且**指针在哪就往哪放大**（见 `lbApplyZoom` 的锚点那一段）。
// ⚠️★ `{ passive: false }` 是**必须**的：默认（passive）下 `preventDefault()` 是个空操作，
// 于是滚轮会**同时**缩放和滚动背后那条时间线 —— 用户看到的是「底下的列表也跟着动」。
// ⚠️ 滚不动的时候（`lbFit` 还是 `null`）**什么也不做**，而且**不拦**：那一刻还没有可缩的
// 画面，让事件照常走比吃掉它更对。
el('lightbox').addEventListener('wheel', (event) => {
  const stage = el('lightbox-stage');
  if (!stage || !lbFit) return;
  event.preventDefault();
  // ⚠️ `deltaMode === 1` 是「按行」（Firefox、以及一部分鼠标驱动），一行按 16px 算 ——
  // 不归一化的话，那些环境里滚一格就是十倍上下。
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  const box = stage.getBoundingClientRect();
  lbApplyZoom(lbZoom * Math.exp(-delta * 0.0015), {
    x: event.clientX - box.left,
    y: event.clientY - box.top,
  });
}, { passive: false });

// ⚠️ 三颗按钮围着**容器正中**缩放（`lbApplyZoom` 的默认锚点）：键盘 / 按钮都没有「指针在哪」
// 这个信息，而正中是唯一一个说得清的基准。
// ⚠️★ 四颗按钮的图标（`−` / `＋` / `✕`）由这里挂上，标记里**不写字形**：
// 字形在 22px 的方块里不居中（全角 `＋` 与数学减号 `−` 的基线偏移各不一样），
// 而图标是几何图形，`place-items: center` 一下就正中（Jonny 2026-10-04 指出的那条）。
// ⚠️ `#lightbox-zoom-reset` 那颗**不挂图标**：它身上是「100%」这个读数（由 `lbApplyZoom` 写）。
el('lightbox-zoom-out').append(icon('minus'));
el('lightbox-zoom-in').append(icon('plus'));
el('lightbox-close').append(icon('close'));
el('lightbox-zoom-out').addEventListener('click', () => lbApplyZoom(lbZoom / LB_ZOOM_STEP));
el('lightbox-zoom-in').addEventListener('click', () => lbApplyZoom(lbZoom * LB_ZOOM_STEP));
// ⚠️ 那颗百分比既是**读数**又是**复位键**（见标记里那段注释）：回到「恰好放得下」。
el('lightbox-zoom-reset').addEventListener('click', () => lbApplyZoom(1));

// ── 「N 条新消息」那颗胶囊（见文件里 `unseenCount` 那段状态注释）──────────────────
//
// ⚠️★ 点了就**跳到底**并清掉 —— 用户按它就是在说「我要看新的」。
el('new-pill').addEventListener('click', () => {
  pinTimeline();
  markTimelineRead();
});

// ⚠️★ 用户**自己**滚到底也算看过了：不清的话那颗胶囊会一直挂着，而它写着「有 3 条新消息」
// —— 明明已经看到最新的了（这种「界面在说假话」是这个项目最忌讳的一类）。
// ⚠️★ 顺序要紧：「贴不贴底」这个状态**先更新**（`renderTimeline` 读它决定跟不跟到底），
// 早退放在它前面就会漏掉 —— 症状是「明明翻上去了，下一条新消息还是把他拽回底部」，
// 而那条早退恰好是绝大多数滚动事件都会走的那一支（没新消息时 `unseenCount` 是 0）。
el('timeline').addEventListener('scroll', () => {
  timelinePinned = timelineAtBottom();
  if (!timelinePinned || unseenCount <= 0) return;
  markTimelineRead();
});
