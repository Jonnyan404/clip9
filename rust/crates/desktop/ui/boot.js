/*
  启动脚本 —— **只管一件事**：在**第一次绘制之前**，把上次选的界面偏好贴到 `<html>` 上。

  # 为什么要有这个文件（而不是写在 app.js 里）

  主题是 `data-theme` 上的一对 CSS 令牌（`index.html` 里那两段 `:root[data-theme=…]`），
  **侧栏收没收起**是 `data-sidebar`（`index.html` 里那段 `:root[data-sidebar='narrow']`）——
  两个都是「晚一步贴就晚一步生效」。
  `app.js` 带 `defer`（解析完才跑），那一拍已经可能画过了；而 `boot.js` 是**同步**的，
  它跑的时候 `<body>` 还没解析出来，绘制一定还没开始。
  ⚠️ 两个的表现不同但都难看：主题晚了是**闪一下白屏**（深色用户每次启动），
  侧栏晚了是**先画一条 208px 的宽栏再跳成 56px**。两个都不报错 ——
  所以宁可在这里多读一个键。

  # ⚠️ 为什么不写成 `<head>` 里的内联 `<script>`

  `tauri.conf.json` 的 CSP 是 `default-src 'self'`（`script-src` 跟着它）——
  **内联脚本会被直接拦掉**，而症状是「主题不生效」这种静默的坏。
  放宽 CSP（加 `'unsafe-inline'`）换一行 `localStorage` 不值得：那一条会一起
  放开所有注入进页面的脚本。

  # ⚠️ 为什么没有「跟随系统」

  Jonny 2026-09-28：「深浅模式切换支持，图标放在侧栏顶部，**不要跟随系统选项**，
  本地要记住选择」。所以这里只认「用户选过的那一个」：**没有 `prefers-color-scheme`
  这一路**，也没打算加 —— 「跟随系统」与「手动选」两条路并存之后，
  「手动选完之后系统变了要不要跟」会变成一个没有正确答案的问题。
  没选过时用页面里写死的那个默认值（`<html data-theme="light">`），不猜系统。

  # ⚠️ 存不上怎么办

  `localStorage` 在「不允许存储」的上下文里会**抛异常**（隐私模式 / 被策略挡）。
  那种情况下退回默认值照常跑，**不报错也不打断** —— 这只是界面偏好，
  为它挡住整个窗口不值得。

  # ⚠️ 这份脚本**只往 `<html>` 上写属性**，不碰任何元素

  它跑在 `<body>` 解析之前，`getElementById` 在这时候一定拿不到东西。
  所以「侧栏收起」在这里也只是 `data-sidebar` 那个属性，样式由 CSS 读
  （那个属性**只有** `index.html` 里那段读，判据 13 钉着「写了没人读」那半边）。

  # ⚠️★ 语种：`data-locale`，以及**只在非源语言上**贴的那块遮布

  语种也归这里 —— 理由和上面两条不同，但更硬：文案是 `i18n.js`（也是 `defer`）刷的，
  而**刷之前的那一屏是中文**（源语言）。也就是说英文用户会先看到一屏中文再跳成英文。
  做法是给 `.win` 挂一层 `visibility: hidden`（`index.html` 里那段
  `:root[data-i18n='pending']`），刷完由 `I18N.ready()` 摘掉。

  ⚠️★ **只在非源语言上贴。** 中文用户看到的本来就是成品，没有可闪的东西；
  这一条同时是**失败安全**：要是 `i18n.js` 没跑起来，中文用户照常用，
  英文用户看到的是中文（难看，但看得见）—— **而不是一扇永远空白的窗口**。
  ⚠️ 兜底计时器：遮布是**真会挡住界面**的东西，所以除了 `i18n.js` 会摘它，
  这里再挂一个 1.5 秒的兜底（页面是本地小文件，正常情况下 `defer` 早跑完了）。
  ⚠️ 这两条判断都写在**同一个地方**（下面那一个 `if`）—— 别在别处再判一次「要不要藏」。
*/

/* ⚠️★ 里面的常量**必须写在 IIFE 里**，不能摆在文件顶层。
   这两份脚本都是**普通脚本**（不是 `type="module"`），而普通脚本的顶层 `const` / `let`
   进的是**同一个**「全局词法作用域」—— 于是 `boot.js` 与 `app.js` 各写一个同名的
   `const THEME_KEY` 会让**后解析的那一份当场抛 `SyntaxError`**，
   而症状是「`app.js` 整个不执行」＝整页不动，控制台里那句话说的是「重复声明」，
   跟主题一点关系都没有。

   ⚠️ 判据 10（`tools/desktop-ui-smoke.mjs`）读的是**文本里的 `const X_KEY = '…'`**，
   所以放进 IIFE 不影响它 —— 它比的是「两处的值一不一样」，不是「在哪个作用域里」。 */
(() => {
  const THEME_KEY = 'theme';
  const SIDEBAR_KEY = 'sidebar';
  // ⚠️ 存语种的键在 `i18n.js` 里还有一份（那边是正主，这里是**先读一步**的那一份）——
  // 判据 10 会把两边的值拿来对。⚠️ 名字与 SPA 那边一致，但**不是**契约：两者不同 origin。
  const LOCALE_KEY = 'locale';
  // ⚠️ 桌面端输入框藏不藏（2026-09-29）：`app.js` 里有一份同名常量，判据 10 对着。
  const COMPOSER_KEY = 'composer';
  // ⚠️★ 输入区**拖出来的高度**（2026-09-29，Jonny：「允许自由调整桌面端发送窗口的高度」）。
  // `app.js` 里有同名常量，判据 10 对着。
  //
  // ⚠️★ 它贴的**不是** `data-` 属性，而是一个自定义属性 `--composer-h`：CSS 里没有
  // 「属性等于某个 px 值」这种选择器（`attr()` 拿不到长度），所以只能走变量。
  // 这与文件头上说的「只往 `<html>` 上写属性」不冲突 —— `style` 也是 `<html>` 上的一个属性，
  // 而且**只**有 `index.html` 里 `.composer` 的 `height` 读它（一处写、一处读）。
  //
  // ⚠️ 为什么非要在**这里**贴：晚一步就是「先画出矮的输入区、再跳高」——
  // 与主题闪白屏、侧栏先宽后窄是同一个病（而且拖动过的高度通常差得更多）。
  const COMPOSER_H_KEY = 'composerHeight';
  const root = document.documentElement;
  try {
    const theme = localStorage.getItem(THEME_KEY);
    // ⚠️ 只认这两个值：别的值（手改过 / 以后改过名）**不贴** ——
    // 贴一个没定义过的 `data-theme` 会让两套令牌**都不匹配**，整页变成无样式的黑字白底。
    if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
    // ⚠️ 侧栏只认 `'narrow'` 这一个值：**读不到、值不认得、存的是 `'wide'`** 一律当宽的。
    // 所以这里**不需要**写 `'wide'`（`app.js` 那边会显式写，是为了让「点了一下」在 DOM 上看得见）。
    if (localStorage.getItem(SIDEBAR_KEY) === 'narrow') root.dataset.sidebar = 'narrow';
    // ⚠️ 输入框同款：只认 `'hidden'`。晚一步贴的代价是「先画一条输入区再跳没」——
    // 与侧栏那条同一个病，所以归进这个文件。
    if (localStorage.getItem(COMPOSER_KEY) === 'hidden') root.dataset.composer = 'hidden';

    // ⚠️★ 输入区高度：这里**只判「是不是一个正数」**，上下界交给 `app.js`
    //（上界跟着窗口大小走，只有它知道；在这里再写一份边界就是第二份定义）。
    // ⚠️ 脏值（没存过 / 手改成非数字 / 负数）**一律不贴**：贴一个 `NaNpx` 进去会让
    // 整条 `height: var(--composer-h)` 失效 —— 表现是「拖过的高度重启就没了」，
    // 而且**不报错**（与主题那条「只认 dark/light」同一个理由）。
    const composerHeight = Number(localStorage.getItem(COMPOSER_H_KEY));
    if (Number.isFinite(composerHeight) && composerHeight > 0) {
      root.style.setProperty('--composer-h', `${Math.round(composerHeight)}px`);
    }

    // ⚠️★ 语种：这里只认 `'en'`（源语言 `'zh'` 不贴，其余一律当源语言）。
    // 判据 14 会把这个字面量拿去 `i18n.js` 的 `LOCALES` 里找，并且要求它**不是**源语言。
    if (localStorage.getItem(LOCALE_KEY) === 'en') {
      root.dataset.locale = 'en';
      root.lang = 'en';
      // ⚠️ 遮布：只贴在**非源语言**上（见文件头上那条注释），带兜底计时器。
      // 摘它的有两条路：`I18N.ready()`（正常）、下面这个计时器（`i18n.js` 没跑起来时）。
      root.dataset.i18n = 'pending';
      setTimeout(() => {
        delete root.dataset.i18n;
      }, 1500);
    }
  } catch (error) {
    // 读不到就用 `index.html` 里写死的默认值 —— 这不是错误，不值得打断启动。
    // ⚠️ 连 `localStorage` 抛异常的情况也要保证**不留下遮布**（否则窗口永远空白）。
    delete root.dataset.i18n;
  }
})();
