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
window.ActionLibrary = (() => {
  const CATALOG = './actions-catalog.json';
  const PURE = './actions-pure.js';
  const LABELS = './actions-labels.json';

  let loading = null;
  /** 最近一次**成功**加载的结果。⚠️ `run` 要用它（见下面 `translate`），所以必须留一份。 */
  let loaded = null;

  async function load() {
    // ⚠️ `import()` 而不是再抄一份实现 —— 这一句就是「一份实现、两侧共用」的落点。
    // 相对路径按**脚本自己所在的目录**解析（`app.js` 与本文件同目录）✓。
    const [catalogResponse, labelsResponse, pure] = await Promise.all([
      fetch(CATALOG),
      fetch(LABELS),
      import(PURE),
    ]);
    if (!catalogResponse.ok) {
      throw new Error(`动作目录取不到（HTTP ${catalogResponse.status}）`);
    }
    if (!labelsResponse.ok) {
      throw new Error(`动作文案取不到（HTTP ${labelsResponse.status}）`);
    }
    const catalog = await catalogResponse.json();
    const labels = await labelsResponse.json();

    const actions = (catalog.actions || []).map((spec) => ({
      ...spec,
      // 查不到就是 null —— **不是** undefined，好让调用点一眼看出「这一侧没有」
      run: typeof pure[spec.run] === 'function' ? pure[spec.run] : null,
      match: spec.match && typeof pure[spec.match] === 'function' ? pure[spec.match] : null,
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

  /** 这条动作在**这一侧**能不能跑。不能跑时给一个说得清的**原因键**（不是布尔）。 */
  function availability(action) {
    if (!action.run) {
      return { ok: false, reasonKey: '这条要网页视图才能跑' };
    }
    if (Array.isArray(action.params) && action.params.length) {
      return { ok: false, reasonKey: '这条要先填参数' };
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
   */
  async function run(action, text) {
    return Promise.resolve(action.run(text, { t: translate }));
  }

  return { ensure, label, translate, availability, run };
})();
