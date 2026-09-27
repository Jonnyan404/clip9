/*
  界面文案的字典 + `data-i18n*` 的刷写器。**只做这一件事**。

  # ⚠️ 为什么单独一个文件、而且是普通脚本（不是 module）

  和 `boot.js` 同一个理由：`app.js` 是普通脚本（不是 module），而**普通脚本共用一个
  全局词法作用域** —— 三份里的顶层 `const` 撞名会让**后解析的那一份整个不执行**
  （判据 11 钉着这件事）。所以这里所有东西都包在 IIFE 里，只往 `window` 上挂一个 `I18N`。

  ⚠️ 它**必须排在 `app.js` 前面**（都是 `defer`，按文档顺序执行）——
  `app.js` 一上来就要 `I18N.apply(document)`。

  # ⚠️★ 两类键，一条判据把它们分开

  这份字典里**同时**有两种键，看起来不整齐，但这是**故意**的：

  | 哪来的 | 键长什么样 | 为什么 |
  |---|---|---|
  | `index.html` 里写死的静态文案 | **中文原文本身**（如 `'添加房间'`） | 原文就是源语言。再给它起一个 `side.add` 之类的名字，等于把中文抄第二遍，而**两份一定会漂**（改了文案忘了改键 = 译文悄悄失效）。gettext 那一系就是这么做的 |
  | **壳（Rust）下发的**句子（item 3b） | 符号（如 `'desktop.problem.icon'`） | ⚠️★ **Rust 侧不许拼中文**。拼了就没法翻（翻的是「句子」，不是「拼出来的那一份」），而且拼出来的中文和界面上的中文会各说各话。所以那边只发 key + 参数，句子在这份字典里 |

  ⚠️★ 判据 14 就是照这条分的：**键里有中文 → 只要求 `en` 有译文**（`zh` 回落到键本身）；
  **键里没有中文 → `zh` 和 `en` 都必须有**。于是「Rust 拼了中文」
  （在 `zh` 里缺一条符号键）和「改了文案忘了补译文」（`en` 里缺一条）都会当场变红。
  ⚠️★ 判据 17 是这条的补集：**壳发出去的每一个键都得在这两份字典里**（抠的是
  `Msg::key("…")` 那个形态）—— 上面那条只保证「字典自己一致」，不保证「壳要的那条在不在」。

  # ⚠️★ 两份渲染器，一份夹具

  `t()` 是给**页面自己**的句子用的；壳递过来的「一句话」（`{key, params}`）走 [`say`] ——
  它多一步**参数渲染**（字符串 / 整份列表 / 另一句话，见 `clip9_client::ParamValue`）。

  ⚠️★ 而**壳那边也有一份一模一样的渲染器**（`crates/desktop/src/shell_text.rs`）：
  系统通知、托盘菜单、系统文件对话框的标题都是**操作系统画的**，页面碰不到它们，
  所以那几句只能由壳自己查表。⚠️ 两份实现一定会漂，钉住它们的是**同一份夹具**：
  `crates/desktop/tests/fixtures/say-cases.json` —— 页面侧就是这里的 `say`（判据 18 跑它），
  壳侧是 `shell_text.rs` 测试模块里的 `the_fixture_renders_the_same_on_this_side`。
  ⚠️ 那两半**都要在**：只跑一边的话，漂掉的正好可能是另一边（变异验证过：把壳里那个
  分隔符写死成「、」，JS 这一侧的判据 18 照样全绿）。加一种参数形状就得往夹具里加一条，
  **两边一起变红才算数** —— 「两边代码看起来一样」不是判据。

  # ⚠️★ 三级回落，缺键时**故意画得难看**

  `t(key)` = `DICTS[当前语种][key]` → `DICTS[源语言][key]` → **`key` 本身**。
  最后那一级是故意的：缺键时屏幕上直接印着那句话的键（符号键就是 `desktop.problem.icon`），
  一眼就知道该补哪条 —— 比空白、比「英文里混着中文」都好找。⚠️ 中文用户永远走不到第三级。

  # ⚠️★ 为什么 `pending` 只对**非源语言**贴

  译文是 `defer` 之后才刷的，所以英文用户会先看到一屏中文再变成英文（在 WKWebView 里
  这不是理论问题：`boot.js` 存在的原因就是「第一次绘制早于 `defer` 脚本」）。
  做法是 `boot.js` 在**源语言之外**贴 `data-i18n="pending"`，样式表把 `.win` 藏起来
  （`visibility: hidden`），刷完再摘掉。

  ⚠️★ **中文用户永远不贴这个属性** —— 他看到的本来就是成品，没有可闪的东西。
  这一条同时是**失败安全**：要是 `i18n.js` 压根没跑起来，中文用户照常用，
  英文用户看到的是中文（难看，但看得见），**而不是一扇永远空白的窗口**。
*/

(() => {
  /** 存语种的键。
   *
   * ⚠️★ `boot.js` 里**也有一份**（它要先读，见那边的模块注释），判据 10 会比对两边。
   * ⚠️ 名字故意和 SPA 那边一样（`web-vue3` 也是 `localStorage['locale']`）——
   * 两者是**不同的 origin**（桌面主窗口是本地文件、SPA 在服务端端口上），存储**并不共享**，
   * 所以这里只是「同一个概念用同一个名字」，不是契约。
   */
  const LOCALE_KEY = 'locale';

  /** 源语言：`index.html` 里写死的那一份中文就是它。
   *  ⚠️★ 它同时是「哪些键不需要自己有一条」的判据 —— 见文件头那张表。 */
  const SOURCE = 'zh';

  /** 支持的语种。
   *  ⚠️★ 这个数组是**唯一**一份（`boot.js` 里只认一个具体值，判据 14 会把那个值
   *  拿来这里找，并要求它**不是** `SOURCE`）。 */
  const LOCALES = ['zh', 'en'];

  /**
   * 两份字典。
   *
   * ⚠️ 写的时候守三条：
   *   1. **句子整条进字典**，别拆成「前半句 + 后半句」两个键去拼 —— 那是翻译最常见的坑
   *      （词序不同，拼出来的英文一定别扭）。⚠️ 例外只有一类：句子中间夹着**活元素**
   *      （值由 JS 填，如 `#cfg-textlimit-max`）或夹着 `.sq` 勾选框时只能拆，
   *      那种地方在 `index.html` 里有注释。拆出来的每一片**都是一段**，按 DOM 顺序拼起来
   *      必须还是一句通顺的话 —— 所以**空白要带在片内**（英文少一个空格就是 `reads itwith`）。
   *   2. **参数用 `{名字}`**（如 `{n}` / `{name}`），不要用 `%s` —— 替换是简单的
   *      「按名字找」，`%s` 连着出现两次时没法区分。
   *   3. ★ 标点**必须留在键里**。`。` `（` 这些要是写在键外面（`</b>。` 这种），
   *      英文界面里就会印出一个中文句号。⚠️★ 这条**不是靠自觉**：判据 15 会去找
   *      「没挂 `data-i18n` 的中文标点」（2026-09-28 从「只查表意文字」扩到「连标点一起查」，
   *      起因就是这里 - 修之前有 7 处 `</b>。`）。
   */
  const DICTS = {
    zh: {
      // ⚠️ 这张表里**只有符号键**（键里没有中文的那些）。
      //    静态文案的键就是中文原文，走「回落到键本身」那条路，这里不用抄第二遍。

      // ── 侧栏：按钮的悬停提示（句子随状态变，`data-i18n-title` 表达不了二选一）──
      'side.theme.tip.dark': '切到深色模式',
      'side.theme.tip.light': '切到浅色模式',
      'side.collapse.tip': '收起侧栏',
      'side.expand.tip': '展开侧栏',
      'side.lang.tip': '切换界面语言（当前中文）',
      // ⚠️ 语言自称（`EN` / `中`）在中英两份里**都一样**，但还是两边都写：
      //    判据 14 的规矩是「键里没中文 ⇒ 两份都要有」，为了省这两行去给它开例外不值得。
      'EN': 'EN',
      '中': '中',
      // ── 壳下发的「配置有毛病」列表之间的分隔符（item 3b 之后列表本身也是 key）──
      'problem.sep': '，',
      // ⚠️ 本地服务端那一页「正在做…」：`label` 是 `t('重启')` / `t('停止')`，拼出来的。
      //    ⚠️★ 它是**符号键**（键里没有汉字，只有省略号）—— 所以中文这份也得有一条。
      '{label}…': '{label}…',

      // ── ★ 列表参数的分隔符：**它是译文，不是常量** ──
      //    ⚠️★ 中文用顿号、英文用「逗号 + 空格」，所以它必须住在字典里。
      //    壳那边（`crates/desktop/src/shell_text.rs` 的 `LIST_SEP_KEY`）查的是**同一个键**：
      //    写死在任一侧都等于「替另一种语言定了一个中国标点」。
      'list.sep': '、',
      // ── ★ 原样照搬的外来文本（`Msg::verbatim`）──
      //    ⚠️★ 模板**只有 `{text}`**、一个字都不加：这一条存在的意义就是「不翻」。
      //    加任何前缀都会把别人的话（服务端的一句 `message`、系统抛出来的原话、
      //    同步过来那段正文）变成我们的话，而**改文案不该动别人的字**。
      'verbatim': '{text}',
      'configNoRooms': '配置里一个房间都没有',
      'configRoomNoServer': '房间「{room}」没填服务端地址',
      'configRoomBadServer': '房间「{room}」的服务端地址不对：{reason}',
      'configRoomBadScheme': '房间「{room}」的地址用了 {scheme}，只支持 http/https',
      'configRoomEmojiIgnored': '房间「{room}」的图标「{emoji}」不像 emoji，已忽略',
      'configMultipleDownloads': '{count} 个房间同时开着下载：{rooms}',
      'configNotSaved': '配置没存下去：{reason}',
      'configUnreadable': '读配置文件失败（{path}）：{reason}',
      'configFileBroken': '配置文件不是合法 JSON（{path}）：{reason}',
      'configDirCreateFailed': '建目录失败（{path}）：{reason}',
      'configWriteFailed': '写配置失败（{path}）：{reason}',
      'configTempWriteFailed': '写临时文件失败（{path}）：{reason}',
      'configRenameFailed': '覆盖配置失败（{from} → {to}）：{reason}',
      'configSerializeFailed': '配置序列化失败：{reason}',
      'downloadDirNeedsDataDir': '「{path}」是相对路径，但拿不到数据目录',
      'downloadDirCreateFailed': '建下载目录失败（{path}）：{reason}',
      'serverAddressEmpty': '还没填服务端地址',
      'serverAddressUnparsable': '「{url}」不是能用的服务端地址：{reason}',
      'schemeChangeFailed': '把这个地址换成 {scheme} 失败了',
      'fileNameEmpty': '文件名是空的',
      'credentialHeaderInvalid': '凭据里不能有换行这类字符：{reason}',
      'notConnectedToServer': '还没连上服务端',
      'connectingTo': '正在连 {room}…',
      'connected': '已连接',
      'serverTooOldNoWatermark': '连上了，但服务端太旧（没有水印）',
      'connectedButHistoryFailed': '已连接，但取不到历史：{reason}',
      'disconnectedWithReason': '已断开：{reason}',
      'connectFailed': '连不上：{reason}',
      'connectNeedsCredentials': '服务端要凭据，但配置里没有或者不对：{detail}',
      'connectRejected': '服务端拒绝了这条连接：{detail}',
      'httpClientFailed': '建 HTTP 客户端失败：{reason}',
      'requestFailed': '请求失败：{reason}',
      'historyFailed': '取历史失败：{reason}',
      'historyNotJson': '历史不是合法 JSON：{reason}',
      'wsHandshakeBuildFailed': '拼 WebSocket 握手请求失败：{reason}',
      'wsReadFailed': '读 WebSocket 失败：{reason}',
      'wsPingFailed': 'ping 没有回来',
      'wsIdleTimeout': '{seconds} 秒没收到心跳',
      'clipboardUnavailable': '用不了系统剪贴板：{reason}',
      'clipboardWriteTextFailed': '把文本写进剪贴板失败：{reason}',
      'clipboardWriteFilesFailed': '把文件写进剪贴板失败：{reason}',
      'clipboardNoFiles': '剪贴板里没有文件',
      'downloadFailed': '下载失败：{reason}',
      'downloadReadFailed': '读下载内容失败：{reason}',
      'downloadWriteFailed': '写文件失败（{path}）：{reason}',
      'fileEntryNoCache': '这条文件记录里没有 cache 字段',
      'uploadTextEmpty': '剪贴板里的文本是空的',
      'uploadImageEmpty': '这张图片是空的',
      'uploadFileListEmpty': '没有文件可发',
      'uploadBadFileName': '这个路径没有文件名，发不了：{path}',
      'uploadFileUnreadable': '读不了这个文件（{path}）：{reason}',
      'uploadFileTooLarge': '文件 {size}，超过上限 {limit}',
      'uploadSkippedContentKind': '这类内容按配置不发（去「↑ 方向与内容」里开）',
      'uploadSkippedNoRoom': '没有房间开着「↑」（去侧栏开一个）',
      'uploadNothingSent': '什么都没发出去',
      'uploadSentToRooms': '已发到 {count} 个房间',
      'uploadSomeFailed': '{payloads} 份内容里有 {failed} 份没发成：{reasons}',
      'uploadAllRoomsFailed': '{count} 个房间全部失败：{reasons}',
      'roomScopedFailure': '{room}：{text}',
      'payloadText': '文本「{text}」',
      'payloadFile': '文件「{name}」（{bytes} 字节）',
      'trayOpen': '打开主窗口',
      'trayAutostart': '开机自动启动',
      'trayRooms': '切换房间',
      'trayQuit': '退出',
      'notifyUploadFailed': '本机剪贴板没发出去',
      'notifyWroteToClipboard': '房间的内容写进本机剪贴板了',
      'notifyEmptyText': '（空文本）',
      'notifyFilePreview': '文件 {name}（{size}）',
      'pickFilesTitle': '选文件发到房间',
      'pickImagesTitle': '选图片发到房间',
      'imageFilterName': '图片',
      'noRoomToSend': '没有房间开着「↑」，没地方发',
      'noRoomsConfigured': '一个房间都没有，先去「服务端与房间」加一个',
      'entryGone': '这条内容已经不在了（可能换了房间，或者被本机的条数 / 字节上限挤出去了）',
      'entryGoneCannotCopy': '这条内容已经不在了，复制不了',
      'noSuchRoom': '没有第 {index} 个房间（一共 {count} 个）',
      'serverTaskFailed': '{label}失败：{reason}',
      'serverStart': '启动',
      'serverStop': '停止',
      'serverRestart': '重启',
      'serverStatusTaskFailed': '读本地服务端状态失败：{reason}',
      'localServerNotRunning': '本地服务端没在跑，先把这一页上面那两选一切到「随客户端启动」',
      'serverUrlEmpty': '地址是空的',
      'serverUrlNotHttp': '只支持 http/https：{url}',
      'openWebTaskFailed': '打开网页版失败：{reason}',
      'openBrowserFailed': '用系统浏览器打开 {url} 失败：{reason}',
      'noBundledServer': '这个客户端没有自带服务端（找不到 clip9-server）',
      // ── 桌面行为：全局快捷键（`crates/desktop/src/hotkeys.rs`）──
      //    ⚠️★ 这三条只在**注册 / 撤销那一下**发出来，落到提示区（`Store::notice`）。
      //    用户看到的症状是「按了没反应」，而原因在这里 —— 所以文案要说**为什么**，
      //    不能只说「失败了」（他会去查别的程序、去重启客户端）。
      'hotkeyRegisterFailed': '占不住 {shortcut}（多半是别的程序占着它）：{reason}',
      'hotkeyUnregisterFailed': '撤掉那条全局快捷键失败：{reason}',
      'hotkeyUnparsable': '快捷键 {shortcut} 写错了，认不出来：{reason}',
      'logUnreadable': '读日志失败（{path}）：{reason}',
      'logSeekFailed': '日志太长了，跳到结尾那段失败（{path}）',
      'logReadFailed': '读日志失败（{path}）：{reason}',
      'serverConfigUnreadable': '读服务端配置失败（{path}）：{reason}',
      'serverConfigBroken': '服务端配置不是合法 JSON（{path}）：{reason}。这个文件没被动过 —— 改好它再打开这一页',
      'serverConfigInvalid': '这份配置服务端读不了，没有保存：{reason}',
      'textLimitUnreachable': '文本上限 {limit} 字节服务端收不到，没有保存。能生效的最大值是 {max} 字节（{mib} MiB）；填 0 = 不限。要支持更大的内容请走文件（分片上传），别把消息上限调大。',
      'serverStartTimeout': '本地服务端 {seconds} 秒内没有答话（端口 {port}）。日志最后一行：{reason}\n完整日志：{log}',
      'serverStartTimeoutNoLog': '本地服务端 {seconds} 秒内没有答话（端口 {port}），而且它一行日志都没写。日志：{log}',
      'foreignServerNotStopped': '端口 {port} 上有一个服务端在跑，但不是这个客户端起的，所以不替你停它',
      'serverStopFailed': '停本地服务端失败：{reason}',
      'serverLogCreateFailed': '建日志文件失败（{path}）：{reason}',
      'serverLogCloneFailed': '复制日志句柄失败：{reason}',
      'serverSpawnFailed': '起不了本地服务端（{path}）：{reason}',
      'binaryPathUnavailable': '取不到自己的路径：{reason}',
      'binaryNoParent': '{path} 没有父目录',
      'binaryNotFound': '找不到本地服务端：{path}（它应该和客户端放在一起）',
      'noticeForMissingRoom': '{room}：{text}',
    },
    en: {
      // ══════════ 侧栏（`index.html`）══════════
      '房间': 'Rooms',
      '添加房间': 'Add room',
      '全局设置': 'Settings',

      // ══════════ 主窗口：输入区与消息卡 ══════════
      '发送': 'Send',
      '输入内容，或直接把文件拖进来…': 'Type something, or drop files straight in…',
      '选文件发到房间': 'Choose files to send to the room',
      '选图片发到房间': 'Choose images to send to the room',
      '回车发送 · Shift+回车换行': 'Enter sends · Shift+Enter makes a new line',

      // ══════════ 设置窗口：标题与左侧导航 ══════════
      '设置': 'Settings',
      '连接': 'Connection',
      '🖧 服务端与房间': '🖧 Server & rooms',
      '同步': 'Sync',
      '↑↓ 方向与内容': '↑↓ Direction & content',
      '⏱ 监听与去重': '⏱ Watcher & dedup',
      '桌面': 'Desktop',
      '🖥 窗口与托盘': '🖥 Window & tray',
      '⌨ 快捷键': '⌨ Hotkeys',
      '🔔 通知': '🔔 Notifications',
      '本机': 'This machine',
      '🗄 本地服务端': '🗄 Local server',
      '⚙ 服务端配置': '⚙ Server config',
      '其它': 'Other',
      '≡ 日志': '≡ Log',
      'ⓘ 关于': 'ⓘ About',
      '关闭': 'Close',
      '保存': 'Save',

      // ── 页：服务端与房间 ────────────────────────────────────────
      '服务端与房间': 'Server & rooms',
      // ⚠️ 这一整句被 `<b>` 拆成两片（`index.html` 那行的注释里写了为什么），
      //   **空白带在片内**：拼起来是 `…clipboard (only one room globally).`
      '↑ 把本机剪贴板发到这个房间，↓ 把这个房间的内容收进本机剪贴板（': "↑ sends this machine's clipboard to the room, ↓ pulls the room's content into this machine's clipboard (",
      '全局只能一个）。': 'only one room globally).',
      '图标': 'Icon',
      '留空 = 自动挑一个不重样的': 'empty = pick a unique one automatically',
      '名字': 'Name',
      '服务端': 'Server',
      '凭据': 'Credential',
      '＋ 添加房间': '＋ Add room',

      // ── 页：方向与内容 ──────────────────────────────────────────
      '方向与内容': 'Direction & content',
      '↑ 发到房间（可多房间同时开）': '↑ Send to the room (several at once is fine)',
      '文本': 'Text',
      '默认开': 'on by default',
      '文件（图片走这条）': 'Files (images go through here)',
      '上限还不知道': 'limit unknown yet',
      '富文本 / HTML': 'Rich text / HTML',
      '本版按文本处理': 'treated as text for now',
      '本版不做富文本：服务端的存储（api.md 的 ReceiveBase）和渲染都没有这条路径（设计稿 §6）':
        'No rich text in this version: neither the server storage (ReceiveBase in api.md) nor the renderer has that path (design §6)',
      '↓ 收进剪贴板（全局只能一个房间）': '↓ Receive into the clipboard (one room globally)',
      '文件（含图片）': 'Files (images included)',
      '来源房间': 'Source room',
      '在左侧栏用 ↓ 选': 'pick one with ↓ in the sidebar',
      '收到的文件存哪（相对 = 数据目录下）': 'Where received files go (relative = under the data dir)',
      '装完两个方向都关着。连上时服务端会重放历史 ——':
        'Both directions start off. On connect the server replays history — ',
      '历史只进列表，不写剪贴板。': 'history only fills the list, it is never written to the clipboard.',

      // ── 页：监听与去重 ──────────────────────────────────────────
      '监听与去重': 'Watcher & dedup',
      '剪贴板是': 'The clipboard is ',
      '轮询': 'polled',
      '读的（系统没有「剪贴板变了」这个通知）。间隔 = 多快同步过去 / 空转多少。':
        ' (the OS gives no "clipboard changed" event). The interval decides how fast a change syncs over, and how much idle work there is.',
      '监听间隔（毫秒）': 'Watch interval (ms)',
      '改完点「保存」才生效 —— 它会重启监听线程。': 'Applies after you press "Save" — it restarts the watcher thread.',
      '什么时候在读你的剪贴板': 'When your clipboard is being read',
      '有房间开着': 'While a room has its ',
      '才读；一个都没开就把轮询线程':
        ' on the watcher reads it; with none of them on, the polling thread is ',
      '停掉。': 'stopped. ',
      '↓ 与此无关，': '↓ has nothing to do with it: ',
      '连接照常': 'the connection stays up',
      '—— 设备、延迟、别人发来的内容都不受影响。': ' — devices, latency and incoming content are all unaffected.',
      '去重': 'Dedup',
      '同一份内容连着出现不会发两遍（按类型记指纹）。':
        'The same content appearing twice in a row is not sent twice (fingerprinted per type). ',
      '没有开关。': 'there is no switch.',

      // ── 页：窗口与托盘 ──────────────────────────────────────────
      '窗口与托盘': 'Window & tray',
      '开机自动启动': 'Start at login',
      '勾的是': 'The tick shows ',
      '系统里的真相': 'what the system really says',
      '（启动项在不在），不是我们「想要」的值。装完默认不开。':
        ' (whether the login item exists), not what we "want". Off by default after install.',
      '托盘': 'Tray',
      '菜单：打开主窗口 / 开机自动启动 / 切换房间 / 退出。':
        'Menu: open the main window / start at login / switch rooms / quit. ',
      '关掉窗口只是': 'Closing the window only ',
      '藏起来': 'hides it',
      '—— 同步照常跑，要退出得走托盘。': ' — syncing keeps running; quitting goes through the tray.',

      // ── 页：快捷键 ──────────────────────────────────────────────
      // ⚠️ 中间那一行被 `<b id="sc-hotkey-key">` 拆成两片（那个组合键的写法**由壳算**），
      //   所以**空白带在片内**：英文拼起来是 `Press ⌘⇧V to show / …`（少一个空格就是 `Press⌘⇧V`）。
      '快捷键': 'Hotkeys',
      '按一下': 'Press ',
      '显示 / 隐藏主窗口 —— 再按一下换回来。':
        ' to show / hide the main window — press again to switch back.',
      '全局快捷键': 'Global shortcut',
      '关掉就不占这个组合键': 'off = the combination is released',
      // ⚠️ 下面两条是**系统里的真相**那一行的两个分支（`refreshHotkeyState`）——
      //   它们说的是「现在这个键按下去有没有用」，所以都带「现在」。
      '占上了 —— 现在按这个键有效。': 'Held — the key works right now.',
      '⚠️ 没占上（多半是别的程序占着它）—— 现在按这个键没反应。':
        '⚠️ Not held (another program probably owns it) — pressing the key does nothing right now.',
      '⚠️ 问不到系统里的快捷键状态：{error}':
        '⚠️ Could not ask the system about the shortcut: {error}',

      // ── 页：通知 ────────────────────────────────────────────────
      '通知': 'Notifications',
      '剪贴板上那两件事发生时你多半不在这个窗口里，所以走':
        'When either clipboard event happens you are probably not looking at this window, so these go through ',
      '系统通知。': 'system notifications.',
      '剪贴板的系统通知': 'Clipboard system notifications',
      '本机剪贴板': "This machine's clipboard ",
      '没发出去': 'could not be sent',
      '时通知我': ' — notify me ',
      '成功不通知': 'silent on success',
      '房间的内容': "The room's content ",
      '写进本机剪贴板': 'was written to this machine',
      '第一条': 'The first ',
      '只在没发出去时': 'rings only when sending failed',
      '响（「已发送」是噪音）；第二条': ' ("sent" is noise); the second ',
      '每次写成都': 'rings on every write',
      '响（剪贴板被改你看不见）。': ' (you cannot see your clipboard being changed).',

      // ── 页：本地服务端 ──────────────────────────────────────────
      '本地服务端': 'Local server',
      '版本': 'Version',
      '监听': 'Listening',
      '数据目录': 'Data dir',
      '房间 / 条目': 'Rooms / entries',
      '运行时长': 'Uptime',
      '重启': 'Restart',
      '停止': 'Stop',
      '🌐 打开网页版': '🌐 Open the web UI',
      '运行方式': 'How it runs',
      '随客户端启动（推荐）': 'Start with the client (recommended)',
      '客户端退出时一并停止。数据目录在「服务端配置」里改。':
        'Stops together with the client. Change the data dir under "Server config".',
      '连别人的服务端（本机不起）': "Use someone else's server (none started here)",
      '只做客户端。适合已有服务器 / Docker / OpenWrt 的场景。':
        'Client only. For when you already have a server / Docker / OpenWrt.',

      // ── 页：日志 ────────────────────────────────────────────────
      '日志': 'Log',
      '内嵌服务端的日志。客户端自己的提示在':
        "The embedded server's log. The client's own notices flash at the ",
      '主界面顶部': 'top of the main window ',
      '闪一次，不在这儿。': 'and are not here.',
      '文件': 'File',
      '刷新': 'Refresh',

      // ── 页：关于 ────────────────────────────────────────────────
      '关于': 'About',
      '出问题时先看这里。': 'Look here first when something breaks.',
      '客户端配置': 'Client config',
      '本机保留': 'Kept on this machine',
      '本房间正文': 'Body text in this room',

      // ══════════ 服务端配置窗口 ══════════
      '服务端配置': 'Server config',
      '只读原始 JSON': 'read-only raw JSON',
      '网络': 'Network',
      '监听地址（0.0.0.0 = 局域网可访问）': 'Listen address (0.0.0.0 = reachable on the LAN)',
      '端口': 'Port',
      '子路径前缀（反代到 /clip 时填）': 'Sub-path prefix (set when reverse-proxying to /clip)',
      '证书（空 = 不用 HTTPS）': 'Certificate (empty = no HTTPS)',
      '私钥': 'Private key',
      '访问控制': 'Access control',
      '全局密码（空 = 不设）': 'Global password (empty = none)',
      '逐房间凭据（roomAuth）': 'Per-room credentials (roomAuth)',
      '密码': 'Password',
      '文件过期': 'File expiry',
      '定时任务': 'Scheduled tier',
      '开放': 'Open',
      '＋ 添加': '＋ Add',
      '定时任务档位：留空 = 跟随房间鉴权；或':
        'Scheduled tier: empty = follow the room auth; or ',
      '。⚠️ 「文件过期」留空 =': '. ⚠️ "File expiry" empty = ',
      '不改。': 'leave it unchanged.',
      '容量与限额': 'Capacity & limits',
      '历史条数': 'History entries',
      '文本上限（字节）': 'Text limit (bytes)',
      '⚠️ 按': '⚠️ Judged in ',
      '字节': 'bytes',
      '判：一个汉字 3 字节，所以填 4096 时中文大约只能发 1365 个字。填':
        ': one CJK character is 3 bytes, so with 4096 you can send about 1365 Chinese characters. Fill in ',
      '（服务端就不判了）。能生效的最大值：':
        ' (the server stops checking). The largest value that still works: ',
      '不限': 'unlimited',
      '，比它大的正文在服务端': ', and anything longer than that ',
      '收不到': 'never gets through',
      '（超出的部分不是「被拒」，而是': ' (the excess is not "rejected" — it simply ',
      '根本到不了': 'never arrives at',
      '那条判定）。': ' that check).',
      '文件过期（秒）': 'File expiry (s)',
      '分片大小（字节）': 'Chunk size (bytes)',
      '单文件上限（字节）': 'Per-file limit (bytes)',
      '数据': 'Data',
      '库文件（相对 = 服务端数据目录下）': 'Database file (relative = under the server data dir)',
      '上传文件目录': 'Upload directory',
      '定时自动化': 'Scheduled automation',
      '启用定时自动化': 'Enable scheduled automation',
      '调度间隔（秒）': 'Tick interval (s)',
      '补发窗口（秒）': 'Grace window (s)',
      '默认时区': 'Default time zone',
      '房间与内务': 'Rooms & housekeeping',
      '启用房间列表': 'Enable the room list',
      '房间清理间隔（秒，0 = 不清理）': 'Room cleanup interval (s, 0 = never)',
      '⚠️ 保存后': '⚠️ Takes effect only after ',
      '需要重启服务端才生效': 'the server is restarted',
      '（配置只在启动时读一次）': ' (the config is read once at startup)',
      '保存并重启': 'Save & restart',

      // ══════════ app.js：壳拿不到东西时的兜底页 ══════════
      // ⚠️ 这一条与下一条在 `app.js` 里是用 `+` 拼的（没有 `data-i18n` 那份的拆法），
      //    所以**空白同样要带在片内**：中文不需要，英文少了就是 `….desktop).Opening it…`。
      '这个页面要在桌面壳里打开（cargo run -p clip9-desktop）。':
        'This page has to be opened inside the desktop shell (cargo run -p clip9-desktop). ',
      '直接用浏览器打开它拿不到剪贴板，也连不上服务端。':
        'Opening it straight in a browser gets you no clipboard and no server connection.',

      // ══════════ app.js：侧栏 / 主区动态文案 ══════════
      '(没有文件名)': '(no file name)',
      '未知设备': 'Unknown device',
      '我发的': 'Sent by me',
      '自动·补发': 'Scheduled · late',
      '自动': 'Scheduled',
      '收起': 'Collapse',
      '展开全文（共 {size}）': 'Show full text ({size})',
      '展开': 'Expand',
      '取全文中…': 'Loading the full text…',
      '取不到全文：{error}': 'Could not load the full text: {error}',
      '这条连接的往返延迟（最近几次的中位数）。⚠️ 只量得到正在收的那个房间。':
        'Round-trip latency of this connection (median of the last few). ⚠️ Only measurable for the room currently receiving.',
      '超时': 'timeout',
      'ping 没有回来：这条连接其实已经坏了，客户端会自己重连。':
        'No ping came back: this connection is already broken and the client will reconnect on its own.',
      '还没测到延迟（刚连上，第一次 ping 还没回来）。':
        'No latency yet (just connected; the first ping has not come back).',
      '配置里一个房间都没有。\n去配置里加一个（数据目录下的 client.json）。':
        'No rooms in the config.\nAdd one there (client.json in the data dir).',
      '发送本地剪贴板到远程房间': "Send this machine's clipboard to the room",
      '获取远程房间最新消息写入本地剪贴板':
        "Pull the room's latest message into this machine's clipboard",
      '{name} · {count} 条 · 延迟 {latency}': '{name} · {count} entries · latency {latency}',
      '没有房间。': 'No rooms.',
      '这个房间还没有内容。': 'This room has nothing in it yet.',
      '正在取这个房间的历史…（取不到会每 5 秒重试一次）':
        "Loading this room's history… (it retries every 5 s if that fails)",
      '{bytes} / 不限': '{bytes} / unlimited',
      '上限还不知道（还没连上）': 'limit unknown yet (not connected)',
      '还没连上': 'not connected yet',
      '没有房间': 'no room',
      '{name}（本机）': '{name} (this machine)',
      '{n} 台在线': '{n} online',
      '· {n} 条': '· {n} entries',
      ' / 正文 {size}': ' / body {size}',
      '最多留最近 {n} 条{bytes}': 'Keeps the latest {n} entries{bytes}',
      '配置有毛病：{list}': 'Config problems: {list}',

      // ══════════ app.js：提示条 / 动作 ══════════
      '取不到状态：{error}': 'Could not fetch the state: {error}',
      '发不出去：{error}': 'Could not send: {error}',
      '打不开文件选择框：{error}': 'Could not open the file picker: {error}',
      '复制内容': 'Copy text',
      '复制失败：{error}': 'Copy failed: {error}',
      '这条没有可复制的内容。': 'This entry has nothing to copy.',
      '复制链接': 'Copy link',
      '这条文件的下载地址。⚠️ 房间要密码的话，这条链接打不开（凭据只在请求头里）。':
        'Download URL of this file. ⚠️ With a password-protected room the link will not open (credentials only travel in request headers).',

      // ══════════ app.js：本地服务端 ══════════
      '不到 1 分钟': 'under a minute',
      '{n} 分钟': '{n} min',
      '{hours} 小时 {rest} 分': '{hours} h {rest} min',
      '{hours} 小时': '{hours} h',
      '读不到本地服务端的状态：{error}': 'Could not read the local server state: {error}',
      '没有自带服务端（找不到 clip9-server）': 'No bundled server (clip9-server not found)',
      '本地服务端运行中': 'The local server is running',
      '本地服务端没在跑': 'The local server is not running',
      '本地服务端：这个客户端没有自带（找不到 clip9-server）':
        'Local server: this client has no bundled one (clip9-server not found)',
      '本地服务端：运行中': 'Local server: running',
      '本地服务端：没在跑': 'Local server: not running',
      '没有自带': 'not bundled',
      '运行中': 'running',
      '没在跑': 'not running',
      '{label}失败：{error}': '{label} failed: {error}',
      '打不开网页版：{error}': 'Could not open the web UI: {error}',
      '切到「随客户端启动」': 'Switch to "start with the client"',
      '切到「连别人的服务端」': 'Switch to "use someone else\'s server"',

      // ══════════ app.js：服务端配置 / 房间表 ══════════
      '{size}（{n} 字节）': '{size} ({n} bytes)',
      '读不到配置：{error}': 'Could not read the config: {error}',
      '已保存 —— 重启服务端后生效': 'Saved — takes effect after the server restarts',
      '没保存：{error}': 'Not saved: {error}',
      '正在重启…': 'Restarting…',
      '已保存并重启': 'Saved and restarted',
      '保存了，但重启失败：{error}': 'Saved, but the restart failed: {error}',
      '房间图标：填一个 emoji；留空 = 自动挑一个不重样的（侧栏那个就是）':
        'Room icon: put in one emoji; empty = pick a unique one automatically (that is the one in the sidebar)',
      '还没有房间。点下面的「添加房间」—— 服务端留空就是本机那个。':
        'No rooms yet. Use "Add room" below — leaving the server empty means this machine\'s own.',
      '（空 = 无密码）': '(empty = no password)',
      '删': 'Delete',
      '没有': 'none',
      '没开：哪个房间的内容都收不到': 'off: content from no room is received',
      '（还没有日志 —— 服务端起来之后才会有）': '(no log yet — there will be one once the server is up)',
      '读日志失败：{error}': 'Could not read the log: {error}',
      '上限 {size}': 'Limit {size}',
      '读不到设置：{error}': 'Could not read the settings: {error}',
      '已保存': 'Saved',
      '没有逐房间的凭据 —— 所有房间都用上面的全局密码（或都不需要密码）。':
        'No per-room credentials — every room uses the global password above (or none of them needs one).',
      '（留空 = 不改）': '(empty = leave unchanged)',
      '（留空 = 跟随）': '(empty = follow)',
      '这个房间是公开的（不需要密码）': 'This room is public (no password needed)',
      '新房间': 'New room',
      '新房间{n}': 'New room {n}',

      // ── 侧栏：按钮的悬停提示（句子随状态变，`data-i18n-title` 表达不了二选一）──
      'side.theme.tip.dark': 'Switch to dark mode',
      'side.theme.tip.light': 'Switch to light mode',
      'side.collapse.tip': 'Collapse the sidebar',
      'side.expand.tip': 'Expand the sidebar',
      'side.lang.tip': 'Switch the interface language (currently English)',
      'EN': 'EN',
      '中': '中',
      // ⚠️ 分隔符在英文里要**多一个空格**：`A;B` 挤在一起，`A; B` 才读得下去。
      'problem.sep': '; ',
      '{label}…': '{label}…',

      'list.sep': ', ',
      'verbatim': '{text}',
      'configNoRooms': 'No rooms in the config',
      'configRoomNoServer': 'Room "{room}" has no server address',
      'configRoomBadServer': 'Room "{room}" has a bad server address: {reason}',
      'configRoomBadScheme': 'Room "{room}" uses {scheme}; only http/https is supported',
      'configRoomEmojiIgnored': 'Room "{room}" has an icon "{emoji}" that does not look like an emoji, so it was ignored',
      'configMultipleDownloads': '{count} rooms download at once: {rooms}',
      'configNotSaved': 'The config was not saved: {reason}',
      'configUnreadable': 'Could not read the config file ({path}): {reason}',
      'configFileBroken': 'The config file is not valid JSON ({path}): {reason}',
      'configDirCreateFailed': 'Could not create the directory ({path}): {reason}',
      'configWriteFailed': 'Could not write the config ({path}): {reason}',
      'configTempWriteFailed': 'Could not write the temporary file ({path}): {reason}',
      'configRenameFailed': 'Could not replace the config ({from} → {to}): {reason}',
      'configSerializeFailed': 'Could not serialize the config: {reason}',
      'downloadDirNeedsDataDir': '"{path}" is relative, but the data dir is unavailable',
      'downloadDirCreateFailed': 'Could not create the download dir ({path}): {reason}',
      'serverAddressEmpty': 'No server address yet',
      'serverAddressUnparsable': '"{url}" is not a usable server address: {reason}',
      'schemeChangeFailed': 'Could not switch this address to {scheme}',
      'fileNameEmpty': 'The file name is empty',
      'credentialHeaderInvalid': 'Credentials cannot contain newlines and the like: {reason}',
      'notConnectedToServer': 'Not connected to the server yet',
      'connectingTo': 'Connecting to {room}…',
      'connected': 'Connected',
      'serverTooOldNoWatermark': 'Connected, but the server is too old (no watermark)',
      'connectedButHistoryFailed': 'Connected, but history could not be fetched: {reason}',
      'disconnectedWithReason': 'Disconnected: {reason}',
      'connectFailed': 'Could not connect: {reason}',
      'connectNeedsCredentials': 'The server wants credentials, but none are set (or they are wrong): {detail}',
      'connectRejected': 'The server refused the connection: {detail}',
      'httpClientFailed': 'Could not create the HTTP client: {reason}',
      'requestFailed': 'Request failed: {reason}',
      'historyFailed': 'Could not fetch history: {reason}',
      'historyNotJson': 'History is not valid JSON: {reason}',
      'wsHandshakeBuildFailed': 'Could not build the WebSocket handshake: {reason}',
      'wsReadFailed': 'Could not read from the WebSocket: {reason}',
      'wsPingFailed': 'No ping came back',
      'wsIdleTimeout': 'No heartbeat for {seconds} s',
      'clipboardUnavailable': 'The system clipboard is unavailable: {reason}',
      'clipboardWriteTextFailed': 'Could not write text to the clipboard: {reason}',
      'clipboardWriteFilesFailed': 'Could not write files to the clipboard: {reason}',
      'clipboardNoFiles': 'There are no files on the clipboard',
      'downloadFailed': 'Download failed: {reason}',
      'downloadReadFailed': 'Could not read the download: {reason}',
      'downloadWriteFailed': 'Could not write the file ({path}): {reason}',
      'fileEntryNoCache': 'This file entry has no cache field',
      'uploadTextEmpty': 'The clipboard text is empty',
      'uploadImageEmpty': 'This image is empty',
      'uploadFileListEmpty': 'There are no files to send',
      'uploadBadFileName': 'This path has no file name, so it cannot be sent: {path}',
      'uploadFileUnreadable': 'Could not read this file ({path}): {reason}',
      'uploadFileTooLarge': 'The file is {size}, over the {limit} limit',
      'uploadSkippedContentKind': 'This kind of content is off in the config (turn it on under "↑ Direction & content")',
      'uploadSkippedNoRoom': 'No room has "↑" on (turn one on in the sidebar)',
      'uploadNothingSent': 'Nothing was sent',
      'uploadSentToRooms': 'Sent to {count} rooms',
      'uploadSomeFailed': '{failed} of {payloads} payloads failed: {reasons}',
      'uploadAllRoomsFailed': 'All {count} rooms failed: {reasons}',
      'roomScopedFailure': '{room}: {text}',
      'payloadText': 'text "{text}"',
      'payloadFile': 'file "{name}" ({bytes} bytes)',
      'trayOpen': 'Open the main window',
      'trayAutostart': 'Start at login',
      'trayRooms': 'Switch rooms',
      'trayQuit': 'Quit',
      'notifyUploadFailed': 'This machine\'s clipboard could not be sent',
      'notifyWroteToClipboard': 'The room\'s content was written to this machine',
      'notifyEmptyText': '(empty text)',
      'notifyFilePreview': 'file {name} ({size})',
      'pickFilesTitle': 'Choose files to send to the room',
      'pickImagesTitle': 'Choose images to send to the room',
      'imageFilterName': 'Images',
      'noRoomToSend': 'No room has "↑" on, so there is nowhere to send it',
      'noRoomsConfigured': 'No rooms at all — add one under "Server & rooms" first',
      'entryGone': 'This entry is gone (the room changed, or it was pushed out by the local entry / byte limit)',
      'entryGoneCannotCopy': 'This entry is gone and cannot be copied',
      'noSuchRoom': 'There is no room #{index} (there are {count} in total)',
      'serverTaskFailed': '{label} failed: {reason}',
      'serverStart': 'Start',
      'serverStop': 'Stop',
      'serverRestart': 'Restart',
      'serverStatusTaskFailed': 'Could not read the local server state: {reason}',
      'localServerNotRunning': 'The local server is not running — switch the choice above to "start with the client" first',
      'serverUrlEmpty': 'The address is empty',
      'serverUrlNotHttp': 'Only http/https is supported: {url}',
      'openWebTaskFailed': 'Could not open the web UI: {reason}',
      'openBrowserFailed': 'Could not open {url} in the system browser: {reason}',
      'noBundledServer': 'This client has no bundled server (clip9-server not found)',
      'hotkeyRegisterFailed': 'Could not grab {shortcut} (another program probably holds it): {reason}',
      'hotkeyUnregisterFailed': 'Could not release the global shortcut: {reason}',
      'hotkeyUnparsable': 'The shortcut {shortcut} cannot be parsed: {reason}',
      'logUnreadable': 'Could not read the log ({path}): {reason}',
      'logSeekFailed': 'The log is too long and seeking to its tail failed ({path})',
      'logReadFailed': 'Could not read the log ({path}): {reason}',
      'serverConfigUnreadable': 'Could not read the server config ({path}): {reason}',
      'serverConfigBroken': 'The server config is not valid JSON ({path}): {reason}. The file was left untouched — fix it, then reopen this page',
      'serverConfigInvalid': 'The server cannot read this config, so nothing was saved: {reason}',
      'textLimitUnreachable': 'A text limit of {limit} bytes never reaches the server, so nothing was saved. The largest value that works is {max} bytes ({mib} MiB); 0 = unlimited. For bigger content use files (chunked upload) instead of raising the message limit.',
      'serverStartTimeout': 'The local server did not answer within {seconds} s (port {port}). Last log line: {reason}\nFull log: {log}',
      'serverStartTimeoutNoLog': 'The local server did not answer within {seconds} s (port {port}) and wrote not a single log line. Log: {log}',
      'foreignServerNotStopped': 'Something is serving on port {port}, but this client did not start it, so it will not be stopped for you',
      'serverStopFailed': 'Could not stop the local server: {reason}',
      'serverLogCreateFailed': 'Could not create the log file ({path}): {reason}',
      'serverLogCloneFailed': 'Could not duplicate the log handle: {reason}',
      'serverSpawnFailed': 'Could not start the local server ({path}): {reason}',
      'binaryPathUnavailable': 'Could not determine my own path: {reason}',
      'binaryNoParent': '{path} has no parent directory',
      'binaryNotFound': 'Local server not found: {path} (it should sit next to the client)',
      'noticeForMissingRoom': '{room}: {text}',
    },
  };

  /** 当前语种。
   *
   * ⚠️★ 与主题、侧栏同一条规矩：**以 DOM 为准**（`boot.js` 在第一次绘制之前就贴好了
   * `data-locale`），不在这里再读一遍存储 —— 那就等于立第二份定义。
   */
  function locale() {
    const now = document.documentElement.dataset.locale;
    return LOCALES.includes(now) ? now : SOURCE;
  }

  /** 取一句译文（三级回落，见文件头）。 */
  function t(key, params) {
    const raw = DICTS[locale()]?.[key] ?? DICTS[SOURCE]?.[key] ?? key;
    return fill(raw, params);
  }

  /** 参数替换。⚠️ `{名字}` 只替换**已知**的：没给的值原样留着（同样是为了看得见）。 */
  function fill(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
    );
  }

  /** 一个**壳下发的句子**（`{key, params}`）→ 成文的文本。
   *
   * ⚠️★ 它和 `t()` 只差**参数那一步**：`t()` 的参数是页面自己拼好的字符串，
   * 而壳递过来的参数可能是三种形状（见 `clip9_client::ParamValue`）：
   *
   * | JSON | 有哪几种 | 怎么渲染 |
   * |---|---|---|
   * | `"reason": "HTTP 401"` | 字符串 | 原样 |
   * | `"rooms": ["默认","工作"]` | **一整份列表** | 按**译文里的**分隔符拼（`list.sep`） |
   * | `"text": {"key":…,"params":…}` | **另一句话** | 递归 `say` |
   *
   * ⚠️★ 规则**与壳那边是同一条**（`crates/desktop/src/shell_text.rs` 的 `render_param`）：
   * 系统通知 / 托盘菜单 / 文件对话框标题那几处**页面渲染不了**（操作系统画的），
   * 所以壳自己也有一份渲染器。两份一定会漂 —— 钉住它们的是**同一份夹具**
   * （`crates/desktop/tests/fixtures/say-cases.json`：壳侧一条测试 + 判据 18）。
   *
   * ⚠️ 返回值是**纯文本**（调用方走 `textContent`）：参数里可能是用户的东西
   * （房间名、路径、服务端原话），所以这条路**不碰 `innerHTML`**。
   */
  function say(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.key !== 'string') return '';
    const params = {};
    for (const [name, value] of Object.entries(msg.params ?? {})) {
      params[name] = renderParam(value);
    }
    return t(msg.key, params);
  }

  /** 一个占位符的值 → 文本。三种形状见 [`say`]。 */
  function renderParam(value) {
    // ⚠️ 数组要**整份**拼，分隔符从字典拿：`A、B` 与 `A, B` 是两件事。
    if (Array.isArray(value)) return value.map(renderParam).join(t('list.sep'));
    // ⚠️ 认「是不是一句话」看的是 `key`：`ParamValue` 三种形状里只有 `Msg` 有 `key`
    //（`Many` 是数组，`One` 是字符串），而 `untagged` 的序列化形状就是这个。
    if (value && typeof value === 'object' && typeof value.key === 'string') return say(value);
    return String(value);
  }

  /** 转义 `&<>`。⚠️★ 只给 `html()` 用，`t()` 那条路走 `textContent`、不需要转义。
   *  ⚠️ 为什么要转：`html()` 会把整句塞进 `innerHTML`（句子里有 `<b>`），
   *  而参数里可能带用户的东西（房间名、路径）。 */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 带内联标记（`<b>`）的译文。**只给句子里有标记的那几处用** —— 参数会先转义。 */
  function html(key, params) {
    const safe = {};
    for (const [name, value] of Object.entries(params ?? {})) safe[name] = escapeHtml(value);
    return t(key, safe);
  }

  /** 换语种：贴属性 + 存下来。
   *
   * ⚠️ 语种**不认识就不动**（返回 `false`）—— 贴一个没定义过的 `data-locale` 会让
   * 「当前是哪个语种」变成一团糊，而界面还得照常画。调用方只在返回 `true` 时重画。
   */
  function setLocale(next) {
    if (!LOCALES.includes(next) || next === locale()) return false;
    document.documentElement.dataset.locale = next;
    // ⚠️ `lang` 是给**系统**看的（字体回退 / 断行规则 / 读屏），不只是装饰：
    // 中文和日文的字形在同一个 Unicode 段里，只能靠它区分。
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : next;
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch (error) {
      // ⚠️ 与主题、侧栏同一条：存不上**照样换**（这一次点的就得生效），只是下次启动记不住。
    }
    return true;
  }

  const TEXT = '[data-i18n]';
  const TITLE = '[data-i18n-title]';
  const PLACEHOLDER = '[data-i18n-placeholder]';
  const RICH = '[data-i18n-html]';

  /** 把 `root` 底下所有挂过 key 的地方刷一遍。**整份重刷**，不做增量。
   *
   * ⚠️★ 整份重刷是**故意**的：增量要记住「上一次是哪个语种、哪些节点动过」，
   * 那就是又一份会漂的状态；这个页面只有几百个节点，重刷一次是微秒级。
   * ⚠️ 四个属性各刷各的：一个元素上可以同时挂 `data-i18n` 与 `data-i18n-title`。
   */
  function apply(root) {
    const scope = root ?? document;
    for (const node of scope.querySelectorAll(TEXT)) {
      // ⚠️ 用 `textContent`：字典是**我们自己**的字面量，但这条规矩不因为「是我们写的」
      // 就松掉 —— 将来有人把动态值拼进字典就是一个注入点。带标记的走 `html()`。
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of scope.querySelectorAll(TITLE)) {
      node.title = t(node.dataset.i18nTitle);
    }
    for (const node of scope.querySelectorAll(PLACEHOLDER)) {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    }
    for (const node of scope.querySelectorAll(RICH)) {
      node.innerHTML = html(node.dataset.i18nHtml);
    }
  }

  /** 摘掉「还没刷完」那块遮布。
   *  ⚠️★ 只有 `boot.js` 在**非源语言**上贴过它；中文用户这条路径上什么都没发生。 */
  function ready() {
    delete document.documentElement.dataset.i18n;
  }

  window.I18N = {
    LOCALE_KEY,
    SOURCE,
    LOCALES,
    DICTS,
    locale,
    setLocale,
    t,
    say,
    html,
    apply,
    ready,
  };
})();
