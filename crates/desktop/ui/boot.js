/*
  启动脚本 —— **只管一件事**：在**第一次绘制之前**，把上次选的界面偏好贴到 `<html>` 上。

  # 为什么要有这个文件（而不是写在 app.js 里）

  主题是 `data-theme` 上的一对 CSS 令牌（`index.html` 里那两段 `:root[data-theme=…]`），
  所以晚一步贴就晚一步生效 —— 表现是**深色用户每次启动都先闪一下白屏**。
  `app.js` 带 `defer`（解析完才跑），那一拍已经可能画过了；而 `boot.js` 是**同步**的，
  它跑的时候 `<body>` 还没解析出来，绘制一定还没开始。

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
  const root = document.documentElement;
  try {
    const theme = localStorage.getItem(THEME_KEY);
    // ⚠️ 只认这两个值：别的值（手改过 / 以后改过名）**不贴** ——
    // 贴一个没定义过的 `data-theme` 会让两套令牌**都不匹配**，整页变成无样式的黑字白底。
    if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
  } catch (error) {
    // 读不到就用 `index.html` 里写死的默认值 —— 这不是错误，不值得打断启动。
  }
})();
