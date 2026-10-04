// 桌面端的**动作库**：读同步过来的三份文件，算出「哪些动作能在这一侧跑」。
//
// ⚠️★ 这个文件里**没有任何动作实现**。实现是 `actions-pure.js` —— 它与内嵌网页版用的
// 是**同一份源**（`web-vue3/src/data/actions/pure.js`），由 `tools/sync-action-catalog.mjs`
// 逐字节搬过来。所以这里只做四件事：加载、查表、算可用性、给动作注入 `t`。
//
// ⚠️★ 目录里的名字有些**只存在于网页版**（`runMarkdown` / `runCode` / `runPinyin` /
// `runSimplified` / `runReplace` —— 它们要 marked / highlight.js / opencc / pinyin-pro /
// 替换模式表，而这一侧的界面**没有构建步骤**，装不下）。查不到**不是错误**，是
// 「这条动作在桌面端跑不了」——界面要**置灰并说明**，不是隐藏。
// （同 `ActionPicker.vue` 的既有约定：隐藏会让人以为功能不存在。）
//
// ⚠️ 三份文件全部是**生成物**（见 `tools/sync-action-catalog.mjs` 抬头）：
//   `actions-catalog.json` 46 条声明 / `actions-pure.js` 零 import 的实现 / `actions-labels.json` 文案
// ⚠️★ 第四份 `actions-impl.json` 是**实现包的导出名清单**：有的动作实现要第三方库
//（marked / highlight.js / pinyin-pro），它们被打进 `actions-impl.js` + 按内容哈希命名的
// chunk（同一脚本打的）。**不在**名单里的（简繁那两条，opencc 的词典 2.2MB，2026-10-03 定
// 暂不进桌面）就是这一侧没有 —— 置灰并说明，不隐藏。
window.ActionLibrary = (() => {
  const CATALOG = './actions-catalog.json';
  const PURE = './actions-pure.js';
  const LABELS = './actions-labels.json';
  const IMPL_LIST = './actions-impl.json';
  const IMPL_BUNDLE = './actions-impl.js';

  let loading = null;
  /** 最近一次**成功**加载的结果。⚠️ `run` 要用它（见下面 `translate`），所以必须留一份。 */
  let loaded = null;
  /** 零依赖那一半的模块对象。⚠️★ 它是**模块级**的：`resolveFn` 要在 `load()` 之外用它，
   *  写成 `load()` 里的局部变量就是 undefined —— 而「查不到」又恰好是合法结果，
   *  症状是全部动作置灰，没有任何报错。 */
  let pure = null;
  /** 实现包（按需）。⚠️ 加载失败**不缓存** —— 下一次点还能重试（同 `ensure` 的理由）。 */
  let implLoading = null;
  /** 实现包里有哪些导出（`actions-impl.json`），用来决定「这条动作能不能点」。 */
  let implNames = new Set();

  /** 取实现包。⚠️ 只有真点到那几条动作时才会被调 —— 不点就不付这 ~685KB 的 parse。 */
  function implBundle() {
    if (!implLoading) {
      implLoading = import(IMPL_BUNDLE).catch((error) => {
        implLoading = null;
        throw error;
      });
    }
    return implLoading;
  }

  /** 给实现包里的某个导出**包一层**：等包回来再调。
   *
   * ⚠️ 返回的是**函数**而不是 Promise —— `availability()` 看 `run` 是不是函数来决定
   * 「能不能点」，所以按钮可以立刻亮起来，加载推迟到点下去那一刻。
   */
  function fromImpl(name) {
    return async (text, ctx, params) => {
      const mod = await implBundle();
      const fn = mod[name];
      if (typeof fn !== 'function') {
        throw new Error(`实现包里没有 ${name}（actions-impl.json 与包对不上，重新同步一次）`);
      }
      return fn(text, ctx, params);
    };
  }

  /** 一个动作的 `run` / `match` 落在哪：**先**查零依赖的那份（不用付实现包的钱），
   *  再查实现包的名单；两边都没有 = 这一侧没有（返回 null → 置灰）。
   */
  function resolveFn(name) {
    if (!name) return null;
    if (typeof pure[name] === 'function') return pure[name];
    if (implNames.has(name)) return fromImpl(name);
    return null;
  }

  async function load() {
    // ⚠️ `import()` 而不是再抄一份实现 —— 这一句就是「一份实现、两侧共用」的落点。
    // 相对路径按**脚本自己所在的目录**解析（`app.js` 与本文件同目录）✓。
    const [catalogResponse, labelsResponse, implListResponse, pureModule] = await Promise.all([
      fetch(CATALOG),
      fetch(LABELS),
      fetch(IMPL_LIST),
      import(PURE),
    ]);
    pure = pureModule;
    if (!catalogResponse.ok) {
      throw new Error(`动作目录取不到（HTTP ${catalogResponse.status}）`);
    }
    if (!labelsResponse.ok) {
      throw new Error(`动作文案取不到（HTTP ${labelsResponse.status}）`);
    }
    if (!implListResponse.ok) {
      throw new Error(`动作实现包清单取不到（HTTP ${implListResponse.status}）`);
    }
    const catalog = await catalogResponse.json();
    const labels = await labelsResponse.json();
    implNames = new Set((await implListResponse.json()).exports ?? []);

    const actions = (catalog.actions || []).map((spec) => ({
      ...spec,
      // 查不到就是 null —— **不是** undefined，好让调用点一眼看出「这一侧没有」
      run: resolveFn(spec.run),
      match: resolveFn(spec.match),
    }));

    loaded = { groups: catalog.groups || [], actions, labels };
    return loaded;
  }

  /** 只加载一次；失败**不缓存**，下一次点还能重试（否则一次网络抖动就永久残废）。 */
  function ensure() {
    if (!loading) {
      loading = load().catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading;
  }

  /** 文案：先查同步过来的那份（SPA 的 locale 是单一来源），再回落本界面自己的字典。
   *
   * ⚠️ 回落那一步不能省：`t()` 查不到时会**回落到键名本身**，界面上就是一串 `actionFoo`。
   */
  function label(state, key) {
    if (!key) return '';
    const locale = window.I18N?.locale?.() ?? 'zh';
    const synced = state?.labels?.[locale]?.[key] ?? state?.labels?.zh?.[key];
    return synced ?? window.I18N.t(key);
  }

  /** **动作自己**要的那句话（`ctx.t`）。
   *
   * ⚠️★ 它**不能**直接用 `window.I18N.t` —— 那本字典里只有界面自己那 300 多句，
   * 动作的**输出文案**（`inspectChars` / `actionNothingToConvert` …）在 SPA 的 locale 里，
   * 由同步工具抽进 `actions-labels.json`。用错那一个的后果是「文本统计」显示成
   * **一串键名**（英文界面下更像英文），而**查不到是不报错的** ——
   * `t()` 静悄悄回落到键名本身，所以这个 bug 只能靠眼睛看出来。
   * ⚠️ 参数替换复用 `I18N.fill`（**不在这里再写一份**）：`{count} 条` 这种模板的
   * 替换规则只有那一处定义。
   */
  function translate(key, params) {
    if (!key) return '';
    const raw = label(loaded, key);
    return window.I18N?.fill ? window.I18N.fill(raw, params) : raw;
  }

  /** 这条动作在**这一侧**能不能跑。不能跑时给一个说得清的**原因键**（不是布尔）。
   *
   * ⚠️ 带参数**不算跑不了**：桌面端照目录画一张表来收（`app.js` 的 `openActionForm`），
   * 2026-10-03 之前它确实是被置灰的（「桌面端还没做参数表单」）。
   */
  function availability(action) {
    if (!action.run) {
      return { ok: false, reasonKey: '这条要网页视图才能跑' };
    }
    return { ok: true };
  }

  /** 跑一条动作。
   *
   * ⚠️ 输入必须是**全文**（调用方去 `entry_text` 取）—— 列表里的 `entry.text` 是截断预览，
   * 拿它跑出来的结果对不上用户看到的那条（与「复制」那条命令同一个坑）。
   *
   * ⚠️ `ctx.t` 给的是**上面那个 `translate`**，不是 `window.I18N.t` ——
   * 理由见它的注释（动作自己的输出文案在同步过来的那一份里）。
   * ⚠️ `params` 是**带参数的动作**（目前只有 text.replace）要的第三个参数，
   * 与网页版 `runChain` 的同一个位置 —— 形状以目录里的 `params` 为准。
   *
   * ⚠️★ 返回**总是** `{ output, html }`，不是字符串 —— 拆双表示用的是 `pure.js` 那份
   * `actionOutput`（网页版 `runChain` 调的是同一个）。以前这里写 `String(...)`，
   * 于是「注音制表」那条画出来的是 ** `[object Object]` **：动作没报错、有反应，
   * 只是结果是一串废话（2026-10-03 报的「注音制表无法显示」）。
   * ⚠️ `html` 非空表示这一份**只能**当 HTML 画（`innerHTML`），走 `textContent` 会印出一屏标签。
   */
  async function run(action, text, params) {
    const raw = await Promise.resolve(action.run(text, { t: translate }, params));
    return pure.actionOutput(raw);
  }

  /** 给一段**已经画进 DOM** 的 HTML 里的 ``` 代码块上色。
   *
   * ⚠️★ 存在的理由：`runMarkdown` / `runCode` 吐出来的代码块**只有 `language-x` 类名，
   * 没有颜色** —— marked 的 renderer 是同步的，而高亮器只能按需 `import()`，
   * 在 renderer 里 await 不了。所以颜色是渲染完之后回头补的，网页版补在
   * `MarkdownBody.vue` 里，桌面补在这里 —— 调的是**同一个** `highlightCodeBlocksIn`。
   *
   * ⚠️ 只有真画了 HTML 才付这 145KB（语言包是单独 chunk）。失败**不出声**：
   * 代码照样看得见，只是没颜色 —— 那正是 `highlight.js` 里写明的行为。
   */
  async function highlightIn(root) {
    try {
      const mod = await implBundle();
      if (typeof mod.highlightCodeBlocksIn === 'function') await mod.highlightCodeBlocksIn(root);
    } catch {
      /* 上色失败不影响阅读 —— 代码本来就是转义好的纯文本。 */
    }
  }

  /** 按 id 跑一条动作（`/` 菜单里「插入时间 / UUID」那几项用）。
   *
   * ⚠️★ 存在的理由：假共用实现 `slash-template.js` 是**零 import** 的（桌面端也加载它），
   * 所以「怎么跑一个动作」必须由调用方**当参数递进去** —— 这里是桌面这一侧的递法。
   * ⚠️ 目录里没有、或者这一侧没有实现 → 返回**空串**（`resolveSlashText` 就是这么约定的）：
   * 插入一个空串只是「这一次没东西进来」，比抛一句用户看不懂的错好。
   */
  async function runById(id) {
    const state = loaded ?? (await ensure());
    const action = state.actions.find((one) => one.id === id);
    if (!action || !action.run) return '';
    const { output } = await run(action, '');
    return output;
  }

  return { ensure, label, translate, availability, run, runById, highlightIn };
})();
