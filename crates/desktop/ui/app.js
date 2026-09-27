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
 *    （`Msg`，见 `crates/desktop/src/commands.rs` 的模块文档）。⚠️ 不认它的症状是
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
 * （壳那边收完顺带把托盘菜单重建一遍）。取舍写在 `crates/desktop/src/shell_text.rs` 的模块文档里。
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
 */
const POLL_MS = 700;

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
 * ⚠️ 代价明说：多留一份整屏条目（与 `lastEntries` 那份重叠）。等到哪天真的嫌大了，
 * 正确的做法是**删掉 `lastEntries`** 让它从这份里取，而不是反过来再存第三份。
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

/** 上一次渲染的**条目**（右键菜单要靠它从卡片的下标找回那一条）。
 *
 * ⚠️ 不复用 `lastVersion`（那只是个数字了，什么也读不出来）：为了读一条正文去留一份
 * 整屏条目的副本不值得 —— 而这份东西是「右键菜单从卡片下标反查那一条」唯一的路。
 */
let lastEntries = [];

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

/** 超过多少字节才画「展开」。
 *
 * ⚠️ 这个数是**估的**：卡片宽约 590px、13px 字体 ≈ 一行 80 字符，
 * 而 CSS 里 clamp 的是 12 行 → 约 960 字节。两处要对得上（改了 clamp 行数就该改这里），
 * 但**对不齐也不致命**：判据偏小只是多画一个「展开」，点了照样正常。
 * ⚠️ 不改成「量一下有没有被 clamp」的理由：那要为每张卡片强制一次排版。
 */
const EXPANDABLE_BYTES = 960;

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
 * ⚠️★ **自己设的提示要自己收**：`render` 里那条清理走的是「壳里有没有 notice」
 *（`invoke('clear_notice')`），而这里设的那些**壳里没有** —— 于是它们只会在
 * 「下一次形状变化」时才被抹掉，而那可能是几分钟后。
 *
 * ⚠️★ **3 秒**（Jonny 2026-09-27：「提示停留时间过长了，3s 就挺好的」）。
 * 原来写的是 15 秒，理由写的是「够看清、够去点一下」—— 那是**替用户做的取舍，而做错了**：
 * 一条只说了「刚才发生了什么」的提示挂十几秒，用户会开始怀疑它是不是当前状态
 *（「它到底还有效吗」），而且切个房间它还杵在那儿 —— 看起来就像**别的房间**的提示
 *（Jonny 同时报的「提示串房间了」有一半是这么来的：不是内容串了，是**它活得比
 * 你看那个房间的时间还长**）。真要留住的信息该进时间线 / 状态栏，不是靠一条提示挂久一点。
 *
 * ⚠️★★ 而且**壳里那条也归这里管**（2026-09-27 修）。原来 `render` 自己把壳里那条
 * 写进 DOM，然后 `clear_notice` —— 清掉会**前进版本号**，于是**下一拍**（≤700ms）
 * 的重绘就走 `else` 把它 `hidden = true`。用户看到的是一次闪动：
 * 「已发送 3 个文件」这种提示**根本来不及看**（他报的就是这条）。
 * 现在「显示多久」只有一个说法（这个计时器），`render` 那边只负责**喂**给它。
 */
let noticeTimer = null;

/** 「那条提示现在正显示着吗」—— `render` 用它决定能不能抹掉。
 *
 * ⚠️ 必须单独记：清了壳里那条之后**还会再来一次重绘**（版本号前进过），
 * 而那一拍 `state.notice` 已经是 `null` 了 —— 不记这个标志就会**立刻**把它抹掉，
 * 也就是把那个 bug 原样搬到了另一个分支里。
 */
let noticeVisible = false;

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
function showNotice(kind, text) {
  const notice = el('notice');
  notice.hidden = false;
  notice.className = `notice ${kind}`;
  notice.textContent = text;
  noticeVisible = true;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
    noticeVisible = false;
  }, NOTICE_MS);
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
      meta.append(h('div', 'fn', entry.fileName || t('(没有文件名)')));
      const size = sizeLabel(entry.fileSize);
      if (size) meta.append(h('div', 'fs', size));
      row.append(meta);
      card.append(row);
    }
  } else {
    // ⚠️★ 这里的 `entry.text` 是**截断预览**（壳只给这么多，见 `EntryView::for_snapshot`）。
    // 展开过的那些改用取回来的全文来画（`openedBodies`），所以**下一次重绘不会把它收回去**。
    // ⚠️ 两处规则要一致（这里与 `toggleEntry`），不一致的表现是「展开之后过一会儿自己收起来」。
    const open = openedIds.has(entry.id);
    card.append(h('div', open ? 'txt open' : 'txt', openedBodies.get(entry.id) ?? entry.text));
  }

  const foot = h('div', 'ft');
  // ⚠️ 发送端没给设备信息时（老条目 / 定时消息）**不编一个名字** ——
  // 服务端专门为无 UA 的定时消息塞了 `type: "Automation"`，这里照它给的显示。
  foot.append(h('span', null, entry.mine ? t('本机') : entry.device || t('未知设备')));
  foot.append(h('span', null, '·'));
  foot.append(h('span', null, timeLabel(entry.timestamp)));
  if (entry.mine) {
    foot.append(h('span', 'spacer'));
    // ⚠️★ 这两条标签**二选一**：`fromClipboard` 说的是「这条不是在这个窗口里敲的 /
    // 拖进来的，而是本机剪贴板被复制之后同步过去的」（壳算好递过来，见 `EntryView`
    // 那个字段 —— 服务端不知道这件事，是本机记的）。
    // 少了它，用户看着一条自己刚复制的东西被标成「我发的」会以为是自己误点的。
    foot.append(h('span', 'tag', entry.fromClipboard ? t('剪贴板同步') : t('我发的')));
  }
  // ⚠️ 定时 / 补发**必须**标出来：`source` / `late` / `scheduledAt` 三个字段是
  // 2026-09-26 才补进 `/content` 投影的，漏掉它们的症状是「看不出这条是自动发的」。
  if (entry.automation) {
    foot.append(h('span', 'spacer'));
    foot.append(h('span', 'tag auto', entry.late ? t('自动·补发') : t('自动')));
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
  if (entry.kind === 'text' && (entry.truncated || entry.textBytes > EXPANDABLE_BYTES)) {
    const toggle = h('button', 'lnk', expandLabel(entry));
    toggle.addEventListener('click', () => toggleEntry(card, entry, toggle));
    foot.append(h('span', 'spacer'), toggle);
  }
  card.append(foot);
  return card;
}

/** 「展开」那颗按钮上的字（⚠️ 两处渲染点都要用它，别各写一份）。 */
function expandLabel(entry) {
  if (openedIds.has(entry.id)) return t('收起');
  // ⚠️ 被截断的说清「一共多大」—— 否则用户以为这就是全文（只是有点长）。
  return entry.truncated
      ? t('展开全文（共 {size}）', { size: sizeLabel(entry.textBytes) })
      : t('展开');
}

/** 展开 / 收起一条。
 *
 * ⚠️★ 只改**这一张卡片**的 DOM，不触发整屏重绘；`openedIds` / `openedBodies` 才是状态，
 * 所以下一次重绘会照同样的规则画回来。
 *
 * ⚠️★ **只有真被截断的才去取全文**（`entry.truncated`）：短消息本地摊开就够，
 * 省一次 IPC。判错的代价是「本地摊开却没内容」—— 而截断与否是壳算好给的，不会错。
 */
async function toggleEntry(card, entry, button) {
  const text = card.querySelector('.txt');
  if (openedIds.has(entry.id)) {
    openedIds.delete(entry.id);
    text.classList.remove('open');
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
      showNotice('skip', t('取不到全文：{error}', { error: errorText(error) }));
      return;
    }
    button.disabled = false;
    text.textContent = openedBodies.get(entry.id);
  }
  openedIds.add(entry.id);
  text.classList.add('open');
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
    host.append(h('div', 'empty', t('没有房间。')));
    return;
  }
  if (!state.entries.length) {
    // ⚠️ 「还没加载」与「这个房间确实是空的」**必须**分开说 ——
    // 两种都画成空列表的话，用户会以为功能坏了。
    // ⚠️ 「还没加载」那句**不能**再说「点右上角刷新」：那个按钮按界面稿删掉了
    //（历史是自动取的，见 `ensureHistory`），留着就是指向一个不存在的东西。
    host.append(h('div', 'empty', room.historyLoaded
      ? t('这个房间还没有内容。')
      : t('正在取这个房间的历史…（取不到会每 5 秒重试一次）')));
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
 *
 * ⚠️★ 数的是**字节**，与两侧同一口径：服务端 `handlers.rs` 用 `text.len()` 判，
 * 而这一页的标签写的就是「文本上限（**字节**）」（`index.html`）。
 * 这里**原来数码点**（`[...value].length`）—— 于是同一页上三个说法：标签说字节、
 * 服务端按字节判、而计数器和提示语说的是「字符」。后果：一条 3000 汉字的长文
 * 会显示「3000 / 4096」然后被服务端按 9000 字节拒掉，用户完全看不懂
 *（`docs/specs/desktop-client.md` §8.2 第 4 条 / `long-message-hardening.md` S2）。
 * ⚠️ 也别改用 `value.length`：那是 **UTF-16 码元**数（emoji 算 2），第三种口径。
 *
 * ⚠️★ `0` 有**两种**含义，必须分开说：**没连上**（上限不知道）与
 * **服务端设了 0 = 不限**（`handlers.rs` 那条 `text.limit > 0` 的判断）。
 * 只判 `limit` 真值的话，后一种会被画成「还没连上」—— 明明连着却说不清。
 */
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
function render(state) {
  lastRooms = state.rooms;
  // ⚠️★ 换房间**必须**把「展开」那两份状态清掉：`entry.id` 是每个房间各自单调的，
  // 不清就会把「B 房间的 7 号」当成「A 房间展开过的 7 号」—— 展开出**别人的内容**，
  // 而且不报错。⚠️ 这段必须在下面更新 `lastSelected` **之前**判。
  if (state.selected !== lastSelected) {
    openedIds.clear();
    openedBodies.clear();
  }
  lastSelected = state.selected;
  lastLimits = state.limits;
  el('room-count').textContent = String(state.rooms.length);
  renderRooms(state);
  renderTimeline(state);
  renderDevices(state);
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

  // ⚠️★ 壳里那条提示**走同一条显示路径**（`showNotice`）—— 见它的注释：
  // 原来这里直接写进 DOM，而 `clear_notice` 会让**下一拍**的重绘把它抹掉，
  // 于是「已发送 3 个文件」只闪一下（2026-09-27 修的）。
  if (state.notice) {
    // ⚠️★ 没有房间参数了：壳给出来的**就是当前选中房间那一条**
    //（没有才退回与房间无关的那一格）—— 见 `showNotice` 的注释。
    // ⚠️★ `state.notice.text` 是壳的一句话（`{key, params}`），要走 `say` 渲染 ——
    // 直接塞进 `textContent` 会印出 `[object Object]`。
    showNotice(state.notice.kind, say(state.notice.text));
    // ⚠️ 顺手把壳里那条清掉：否则一条三分钟前的错误会一直重播。
    // 清掉会前进版本号 → 下一拍还会重绘一次，而那一拍会走到下面的 `else` ——
    // 那时提示**正在显示**，所以用 `noticeVisible` 挡住，别把它抹掉。
    invoke('clear_notice');
  } else if (!noticeVisible) {
    el('notice').hidden = true;
  }
}

async function tick() {
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
    showNotice('err', t('取不到状态：{error}', { error: errorText(error) }));
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

function sendCurrentInput() {
  const input = el('input');
  const text = input.value;
  if (!text.trim()) return;
  invoke('send_text', { text }).catch((error) => showNotice('err', t('发不出去：{error}', { error: errorText(error) })));
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
  invoke('send_files', { paths: list }).catch((error) => showNotice('err', t('发不出去：{error}', { error: errorText(error) })));
}

/** 📎 / 🖼：让**壳**弹系统文件选择框（页面自己没有这个能力，见 `commands::pick_files`）。 */
async function pickAndSend(imagesOnly) {
  try {
    sendFiles(await invoke('pick_files', { imagesOnly }));
  } catch (error) {
    showNotice('err', t('打不开文件选择框：{error}', { error: errorText(error) }));
  }
}

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
  copyText.append(h('span', null, '📋'), h('span', null, t('复制内容')));
  copyText.addEventListener('click', () => {
    closeMenu();
    // ⚠️★ 文本条目**不在页面里取正文**：页面手里的 `entry.text` 是**截断预览**
    //（壳只给 4 KiB，见 `EntryView::for_snapshot`），传回去会把长文**复制成半截**，
    // 而且不报错（用户粘出来才发现少了）。所以文本条目一律走 `copy_entry`：
    // 全文在壳里取、在壳里写剪贴板，一个字节都不进 webview。
    if (entry.kind === 'text') {
      invoke('copy_entry', { id: entry.id }).catch((error) =>
        showNotice('err', t('复制失败：{error}', { error: errorText(error) })),
      );
      return;
    }
    // ⚠️ 文件条目**没有正文**，能复制的是**文件名**（§4.4 表格里写着这一条）——
    // 那是元数据，页面手里本来就有。
    if (!entry.fileName) {
      showNotice('skip', t('这条没有可复制的内容。'));
      return;
    }
    invoke('copy_to_clipboard', { text: entry.fileName }).catch((error) =>
      showNotice('err', t('复制失败：{error}', { error: errorText(error) })),
    );
  });
  menu.append(copyText);

  // ⚠️ 只有文件条目才有链接。文本条目**不画**这一项 —— 画一个点了没反应的项
  // 比没有这一项更坏（§4.4 的原则）。
  if (entry.kind === 'file' && entry.previewUrl) {
    const copyLink = h('div', 'mi');
    copyLink.append(h('span', null, '🔗'), h('span', null, t('复制链接')));
    // ⚠️★ 这条地址**不带凭据**（凭据只走请求头，见 `endpoint.rs` 那段）——
    // 有密码的房间拿这条链接是**打不开**的。照实说，别让用户以为能用。
    copyLink.title = t('这条文件的下载地址。⚠️ 房间要密码的话，这条链接打不开（凭据只在请求头里）。');
    copyLink.addEventListener('click', () => {
      closeMenu();
      invoke('copy_to_clipboard', { text: entry.previewUrl }).catch((error) =>
        showNotice('err', t('复制失败：{error}', { error: errorText(error) })),
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

// ⚠️ 这里原来绑的是 `#conn`（那个同步胶囊的点击 → `set_monitoring`）。
// 胶囊和那条命令 2026-09-26 一起删了，见上面那段注释。
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
  const { bundled, running } = status;

  // `.hd`：状态灯 + 一句话。⚠️ 「没有自带服务端」要说出来 —— 那时起停按钮点了也不会有反应。
  el('srv-dot').className = running ? 'dot' : 'dot off';
  el('srv-state').textContent = !bundled
    ? t('没有自带服务端（找不到 clip9-server）')
    : running
      ? t('本地服务端运行中')
      : t('本地服务端没在跑');

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
    : running
      ? t('本地服务端：运行中')
      : t('本地服务端：没在跑');
  el('dg-server').textContent = !bundled ? t('没有自带') : running ? t('运行中') : t('没在跑');
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

/** 一个单元格里的文本框。⚠️ 用 `input` 事件更新草稿，不重渲染 ——
 *  每次重渲染都把 `value` 重设会把用户正在输入的光标顶掉。
 *
 *  ⚠️★ `autocapitalize="off"`：macOS 会在这个框里把首字母**自动大写**，
 *  而这一格填的是**地址**（用户实测把 `https://…` 打成了 `Https://…`，
 *  然后怎么都连不上）。见 `tools/desktop-ui-smoke.mjs` 里那条静态自检 ——
 *  这一侧没有测试运行器，「新加的输入框忘了关」只能靠它拦。
 */
function cellInput(value, onChange, placeholder) {
  const td = h('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('autocapitalize', 'off');
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onChange(input.value));
  td.append(input);
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

/** 一个方向开关（表格里的 ↑ / ↓）。 */
function cellDir(on, kind, title, onToggle) {
  const td = h('td', 'tiny');
  const box = h('span', on ? `dir ${kind} on` : `dir ${kind}`, kind === 'up' ? '↑' : '↓');
  box.title = title;
  box.addEventListener('click', () => onToggle(!on));
  td.append(box);
  return td;
}

/** 房间图标那一格（表格里唯一一个**故意很窄**的文本框）。
 *
 * ⚠️★ 它画的**只是用户填的那个**（`Channel::emoji`）；留空 = 自动。
 * ⚠️ 留空时**不显示**壳自动挑的那个图标，占位符就是两个字「自动」——
 * 显示出来会变成第二份定义：那一格看起来像「他选的」，而保存时又真的会被当成
 * 「他选的」发回去（于是**打开过一次设置页**就把「自动」钉死了）。
 * 「现在用的是哪一个」在侧栏那一格上（`RoomView::emoji`，壳算好的那一份）。
 * ⚠️ 复用 `cellInput` 而不是再抄一遍 `createElement('input')`：
 * 静态自检第 4 条是**数数**的（造了几个文本框就得关几个自动大写），
 * 抄一份就多一处要对齐；而且 `autocapitalize="off"` 在这一格同样不能少
 *（它收的是要粘进来的 emoji，界面不许替用户改字面）。
 */
function cellEmoji(value, onChange) {
  const td = cellInput(value, onChange, t('自动'));
  td.className = 'tiny';
  td.firstElementChild.title = t('房间图标：填一个 emoji；留空 = 自动挑一个不重样的（侧栏那个就是）');
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
    const td = h('td', 'sub', t('还没有房间。点下面的「添加房间」—— 服务端留空就是本机那个。'));
    td.colSpan = 8;
    tr.append(td);
    body.append(tr);
    return;
  }
  roomDraft.forEach((room, index) => {
    const tr = h('tr');
    // ⚠️ 图标放**第一格**：与侧栏那个房间行的顺序一致（先图标、再名字）。
    tr.append(cellEmoji(room.emoji, (v) => { roomDraft[index].emoji = v; }));
    tr.append(cellInput(room.name, (v) => { roomDraft[index].name = v; }));
    tr.append(cellInput(room.server, (v) => { roomDraft[index].server = v; }, 'http://127.0.0.1:9502'));
    tr.append(cellInput(room.room, (v) => { roomDraft[index].room = v; }, 'default'));
    tr.append(cellInput(room.auth_token, (v) => { roomDraft[index].auth_token = v; }, t('（空 = 无密码）')));
    // ⚠️ ↓ 是**全局单选**：点开一个，别的自动关掉。做成多选再靠后端「取第一个」
    // 的话，用户点第二个会**没反应** —— 那正是「配了不生效」。
    // ⚠️★ 悬停提示与侧栏那两个开关**逐字一致**（Jonny 2026-09-26 给的文案）——
    // 同一个图标在同一个 app 里说两句不同的话，就是第二份定义。
    // ⚠️「可多选」「全局只能一个」不再写进 title：这一页的说明文字
    //（上面那段 `.sub`）已经写着「收进剪贴板全局只能一个」了。
    tr.append(cellDir(uploadOn(room), 'up', t('发送本地剪贴板到远程房间'), (on) => {
      roomDraft[index].enable_upload = on;
      renderRoomRows();
    }));
    tr.append(cellDir(room.enable_download === true, 'dn', t('获取远程房间最新消息写入本地剪贴板'), (on) => {
      roomDraft.forEach((other, position) => { other.enable_download = on && position === index; });
      renderRoomRows();
    }));
    const del = h('td', 'tiny');
    const button = h('button', 'btn', t('删'));
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
      ? t('上限 {size}', { size: sizeLabel(lastLimits.fileLimit) })
      : t('上限还不知道（还没连上）');
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
    tr.append(cellInput(entry.password, (v) => { entry.password = v; }, t('（空 = 无密码）')));
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
