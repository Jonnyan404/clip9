#!/usr/bin/env node
// 桌面端**手写界面**的静态自检。
//
// 用法：
//   node tools/desktop-ui-smoke.mjs                       # 在 clip9/ 下跑
//   node tools/desktop-ui-smoke.mjs <app.js> <index.html> [commands.rs] [capabilities.json] [boot.js] [client-config.rs] [i18n.js]
//                                                         # 用别的夹具跑（变异验证 / 临时排查）
//
// # ⚠️ 为什么要有它
//
// `crates/desktop/ui/app.js` 里到处是 `el('cfg-textlimit')` 这种**字符串 id**，
// 而这一侧**没有任何测试运行器**（`web-vue3` 与 `ui/*.js` 都没有，见 MEMORY.md）。
// 于是「id 打错一个字」的表现是**那个功能静默失效**：不报错、不 panic，
// 控制台里可能只有一行 `null.classList` —— 而这一版连控制台都不给用户看。
//
// 这类错**不需要跑起来才能发现**：两侧都是静态文本，比一下就知道。
// 对照：SPA 有 `web-vue3/scripts/check-display-semantics.mjs`、服务端渲染页有
// `cloud-clip/tools/page-smoke.mjs`，**只有手写 UI 这一侧是裸奔的**
//（见 `docs/specs/desktop-client.md` §1.1 缺口 C）。
//
// # 判据（**第 1、2、4、5、6、7、8、9、10、11、12、13、14、15 条算失败**）
//
// 1. `app.js` 引用到的每一个 id，`index.html` 里必须存在 —— 不通过 = 退出码 1；
// 2. `index.html` 真的加载了**每一个**该加载的脚本（`boot.js` / `i18n.js` / `app.js`）；
//    ⚠️ 少一个的症状**各不相同**，所以每一条都写清了「少了会怎样」（见下面那张表）——
//    「改名只改一侧」这句话对 `boot.js` 是不准的：少了它页面照常能用，
//    只有深色用户会发现启动时闪一下白屏（那是**最容易被当成「本来就那样」**的一类）；
// 3. 反向（HTML 有、JS 没引用）**只提示**，而且分两种：
//    · 「只被选择器用」（`#rooms-table { … }` 这类样式钩子）→ 正常，**不吵**；
//    · 「既没被 JS 引用、也没有选择器用它」→ 才提一句（可能是死标记，与 §8.1 第 6 条那两段死 CSS 同类）。
// 4. 每一个**能打字**的输入框（`type="text"` / 不带 `type` 的 `<input>` / `<textarea>`）
//    必须带 `autocapitalize="off"` —— 不通过 = 退出码 1。理由见下。
// 5. 新建房间的默认**不许打开上行**（`addRoomRow`）—— 不通过 = 退出码 1。理由见下。
// 6. **提示不许自己拼房间名** —— 「一条提示归哪个房间」只有壳说了算
//    （`store` 里每个房间各一格），界面只显示壳给的那一条。不通过 = 退出码 1。理由见下。
// 7. `NOTICE_MS` 不许再回到「挂十几秒」—— 不通过 = 退出码 1。理由见下。
// 8. **设置项的字段名要跨语言对得上**：`SettingsView` 的每个字段，`openSettings` 里都要读；
//    `SettingsPatch` 的每个字段，保存时都要发回去 —— 不通过 = 退出码 1。理由见下。
// 9. **页面不许拿到系统通知的权限**（`capabilities/default.json` 里不许出现 `notification*`）
//    —— 不通过 = 退出码 1。理由见下。
// 10. **界面偏好的存储键，`boot.js` 与「拥有它的那份脚本」必须一致**（`const X_KEY = '…'` 那一族）
//    —— 不通过 = 退出码 1。理由见下。
// 11. **三份脚本合起来要能过一遍解析** —— 不通过 = 退出码 1。理由见下。
// 12. **房间清单里每个 `Channel` 字段，界面都得发得回去**（`addRoomRow` 与保存那两处）
//    —— 不通过 = 退出码 1。理由见下。
// 13. **脚本往 `<html>` 上写的属性，样式表要真的读它** —— 不通过 = 退出码 1。理由见下。
// 14. **文案字典要盖住界面用到的每一个键，两种键各有各的规矩** —— 不通过 = 退出码 1。理由见下。
// 15. **`index.html` 里不许留下没挂 key 的中文 / 脚本里不许留中文串** —— 不通过 = 退出码 1。理由见下。
//
// # ⚠️ 第 4 条为什么算失败，而不是「提一句」
//
// macOS 会把文本框里**每句的首字母**自动大写，而这个界面里被用户手打的每一格
// 都是**不许改字面**的东西：服务端地址、房间名、凭据、要发出去的消息正文。
// 实测踩到（2026-09-27）：地址格里的 `https://` 被写成 `Https://`，
// 表现是「明明填对了却连不上」—— 而**一个字母的大小写**是看不出来的，
// 用户查了半天网络。⚠️ 它不会让任何东西报错，所以只有这里能拦。
//
// ⚠️★ 看**两个**入口：`index.html` 里写死的，与 `app.js` 现造的（`cellInput`）。
// 只看一边的话，另一边新加的框会静默漏过去 —— 而漏过去**不报错**。
// ⚠️ 扫描前要先**剥掉注释与 `<style>`**：CSS 注释里就写着 `<input>`（讲表格列宽那段），
// 不剥的话会把它当成一个真的输入框来报。
//
// # ⚠️ 第 5 条为什么算失败
//
// 「加一个房间」是**用户已经养成的手势**（侧栏那个「＋」），而他不会想到要回头去关 ↑。
// 于是「新建房间默认打开上行」的实际后果是：**点一下加房间就开始把本机剪贴板发出去**
// —— 静默、不报错、也不在界面上留下任何痕迹（侧栏那个 ↑ 是亮的，但没人会去看）。
// Jonny 2026-09-27 明确改掉了这个默认（原来是 `true`），那就得有一条命令守着它。
// ⚠️ 这与 §4.1 第 3 条（装完不该自动接管剪贴板）是同一条规矩，只是触发点不同。
// ⚠️ 判据只钉**这一处默认值**，不做别的道德检查：改成 `false` 是对的，
// 而「保存时怎么读这个字段」由 `uploadOn()` 那一个定义管（缺字段 = 关）。
//
// # ⚠️ 第 6 条为什么算失败（提示不许自己拼房间名）
//
// 用户 2026-09-27 报的「提示串房间了」。**上一版**的修法是「一条全局提示 + 显示一句
// 房间名」（`默认：已发到 1 个房间`）—— 那是**说清它串到哪儿去了**，用户没接受，
// 他原话是「**房间的提示归每个房间**」。
//
// 现在的做法在**壳**里：每个房间各有一格（`store.rs` 的 `Room::notice`），
// 快照给出的 `state.notice` **就是当前选中房间那一条**。界面那一格本来就长在
// 那个房间的标题下面，所以「它是关于谁的」不需要再写一遍。
//
// ⚠️★ 于是这里钉的是一条**分工**：**「归哪个房间」只有壳说了算**。
// 界面要是又去读 `state.notice.room`（那个字段已经不存在了）或自己拼一个前缀，
// 症状是**两处都在判断同一件事**，而它们一定会漂（漂的那天没人会发现 ——
// 提示照样弹出来，只是主语错了）。
// ⚠️ 判据两头都看：`render` 不许传房间名，`showNotice` 不许收房间名。
// 少看一头的话，另一半加回来照样绿 —— 而那一半单独存在时正是「冗余判断」的起点。
//
// # ⚠️ 第 7 条为什么算失败（提示停留 3 秒）
//
// Jonny 2026-09-27：「提示停留时间过长了，3s 就挺好的」。原来写的是 15 秒，
// 于是「切个房间它还杵在那儿」—— 看起来就像**别的房间**的提示（与第 6 条同一个抱怨）。
// ⚠️ 这个数字**没有任何别的保护**：它不是契约、没有测试、也没写在别处，
// 改回去只是把用户报过的那条 bug 再种一遍，而**谁都不会注意到**。
// 判据只给一个上界（不是「必须等于 3000」）：留出微调空间，拦住的是「又挂回十几秒」。
//
// # ⚠️ 第 8 条为什么算失败（设置项的字段名要跨语言对得上）
//
// 一个设置项要跨**三个地方**才真的能用：壳给出它（`SettingsView` 的字段）、
// 界面**接住**它（`openSettings` 里读一次 → 画到那个勾上）、
// 界面**发还**它（保存时进 `SettingsPatch`）。而这三处**没有一处是同一个语言**：
// 前者是 Rust 的 `notify_upload`，后两处是 JS 里那个 `notifyUpload` 字符串
//（`#[serde(rename_all = "camelCase")]` 变的）。
//
// ⚠️★ 于是有**两个独立的坏法**，而且症状一模一样（勾永远是默认样子、点了也不生效）：
// ① **没接住** —— `openSettings` 里漏了一句 `sqSet('sc-notify-up', view.notifyUpload)`：
//    界面上那个勾**永远画的是 HTML 里写死的那个值**（`class="sq on"`），
//    用户关掉它、重开设置，勾又亮着 —— 而**不会有任何报错**；
// ② **没发还** —— 保存时漏了 `notifyUpload: sqGet('sc-notify-up')`：
//    勾能点、能变，但**永远存不下去**，下次启动又变回来。
//
// ⚠️ 只判①（「调用处出现过 `view.X`」）的话，把保存那半边删掉**照样全绿** ——
// 而用户看到的症状完全一样。所以**两头各判一次**，而且判的是**函数体内部**
//（不是全文 grep：`notifyUpload` 这个名字在另一个函数里也出现过，全文 grep 等于没测）。
//
// ⚠️ 判据**不收窄**到「通知那两项」：它读的是两个结构体的**全部字段** ——
// 下次谁加一个设置项而忘了界面那一半，这条会红。这才是它值钱的地方。
//
// # ⚠️ 第 9 条为什么算失败（页面不许拿到系统通知的权限）
//
// 2026-09-27 加了系统通知（「本机剪贴板没发出去」「房间的内容写进剪贴板了」）。
// 那个插件**会给页面注入一段它自带的 JS**，所以「页面能不能发通知」只由一件事决定：
// `capabilities/default.json` 里给不给 `notification:*`。
//
// ⚠️★ 我们**决定不给**，而且这是一个**刻意的架构选择**，不是忘了配：
// 这个项目里页面与壳的分工是「页面只跟 IPC 命令说话」（`desktop-client.md` §2 的硬边界），
// 每给页面开一个插件的口子，那条边界就薄一分 —— 而**发系统通知**还给了一个
// 「页面能弹东西到用户桌面」的能力（一个页面 bug 就能变成通知轰炸）。
//
// ⚠️ 那三处注释（`Cargo.toml` / `notify.rs` / 能力文件自己）都写着「故意不给」，
// 但**注释拦不住人**：`notification:default` 这七个字母加进去之后，
// 页面调得动、没有任何东西会报错 —— 直到有人发现通知的来源不对。
// 所以把它变成一条会红的检查。
//
// ⚠️ 这条**不是**「插件不许注册」：插件必须注册（Rust 侧要用它），
// 判的只是**权限那一格**。
//
// # ⚠️ 第 10 条为什么算失败（存储键两份要一致）
//
// 2026-09-28 加了「明暗主题」与「中英界面」。这两件事各需要一个**存储键**
// （`localStorage`），而它们都必须在**第一次绘制之前**生效 —— 所以读它的那一份
// （`ui/boot.js`）是**同步**的、在 `app.js` **之前**跑，**读不到 `app.js` 里的常量**。
// 于是同一个键名必然写了两份。
//
// ⚠️★ 漂了之后的症状很坏，而且**只在重启之后**才看得出来：
//   · `boot.js` 用 `theme` 读、`app.js` 用 `appTheme` 写 → 点一下能换、重启就变回去；
//   · 反过来 → 存下去了，可启动时贴的是另一个键的值（等于没存）。
// 两种都不报错、不 panic，用户只会觉得「这软件记不住我的选择」。
//
// ⚠️ 清单**从 `boot.js` 里数出来**、不手写：写死一份的话，下次谁在 `boot.js` 里多读一个键，
// 这条自检照样绿 —— 而它绿的时候看起来一切正常（这正是这类检查最容易失效的方式）。
//
// # ⚠️ 第 11 条为什么算失败（两份脚本要能一起解析）
//
// 2026-09-28 加 `boot.js` 时当场踩到的：它和 `app.js` 都是**普通脚本**（不是 module），
// 而普通脚本顶层的 `const` / `let` 进的是**同一个全局词法作用域** ——
// 于是「两份各自都对、各写一个 `const THEME_KEY`」的结果是**后解析的那一份整个不执行**：
// 页面还能显示，只是一动不动（一个字节的数据都画不出来）。
//
// ⚠️★ 这个错**没有任何前兆**：两份文件单独看都对、`node --check` 各自也过，
// 只有把两份**拼在一起**才看得见（浏览器就是这么干的）。所以这条判据也照着拼。
// ⚠️ 用 `new Function` 是**只编译不执行** —— 函数体一行都不会跑
//（`app.js` 开头那个 `throw` 是为了「用浏览器直接打开」时给人一句话，别让它在这里生效）。
//
// ⚠️ 它会**顺带**拦下所有语法错（漏括号之类）。那也算赚的：手写这一侧没有构建步骤，
// 语法错在别处一样没人拦。
//
// # ⚠️ 第 12 条为什么算失败（房间清单的字段一个都不能少）
//
// 第 8 条只看 `SettingsView` / `SettingsPatch` 的**顶层**字段 —— 而房间清单是
// `Vec<Channel>`，它的字段（`name` / `server` / `room` / `auth_token` / `enable_upload` /
// `enable_download` / `emoji`）是**嵌在里面**的另一份形状，第 8 条看不见
//（文件头那条「嵌进去的字段漏了这一条拦不住」说的就是它）。
//
// ⚠️★ 而「少一个字段」在这条路上的症状**特别坏**：
// `SettingsPatch::rooms` 是**整份替换**语义，发出去的每个房间都是一个**新对象字面量** ——
// 少写一个键就等于把那个字段**清成 serde 默认值**。三个真实的例子：
//   · 少 `auth_token` → 保存一次，**所有房间的密码全没了**；
//   · 少 `enable_download` → 下行开关自己关掉（而且没有任何报错）；
//   · 少 `emoji` → 所有房间的图标一起变回「自动」的，用户挑的全丢。
// 这三个都不会报错、都不 panic，用户只知道「我设的东西没了」。
//
// ⚠️ 两处**各判一次**（和判据 8 同一个道理）：`addRoomRow` 造新行那一处、
// 保存时 `roomDraft.map(...)` 那一处 —— 只判一边的话，另一边漏了照样绿。
//
// ⚠️ 判据是**从 `client/src/config.rs` 里数出来的**（不手写清单）：
// 写死的话，下次给 `Channel` 加字段时这条自检照样绿 —— 而它绿的时候看起来一切正常。
//
// # ⚠️ 第 13 条为什么算失败（写了 `<html>` 上的属性，样式表要有人读）
//
// 2026-09-28 长出了**第二条**这样的属性（`data-sidebar`，在那之前只有 `data-theme`）。
// 两个都是「界面偏好」：**脚本往 `<html>` 上贴一个属性，CSS 按它换一套样式**。
//
// ⚠️★ 这个接缝的坏法**只有一半会报错**：
//   · 属性写了、样式没人读 → 那个开关点下去**什么都不发生**（不是崩，是「没反应」）。
//     用户会再点一次、再看一眼，还是没反应 —— 而控制台里干干净净。
//   · 属性没人写、样式里有选择器 → 那个状态**永远进不去**（一条死样式）。
// 两种都不会让任何东西变红 —— 只有把两侧放在一起比才看得见。
//
// ⚠️ 所以两个方向都看，但**重量不同**（和判据 3 一个道理）：
//   · 「写了没人读」→ **算失败**：那是**已经做出来的功能不生效**；
//   · 「有人读没人写」→ **只提示**：它可能是写在 HTML 标记上的（`<div data-pane="rooms">`
//     那种不走 `dataset`，脚本当然不写它），也可能是功能删干净之后留下的死样式。
//
// ⚠️★ 只认**两种写法**：`document.documentElement.dataset.X = …` 与 `root.dataset.X = …`
//（`boot.js` 里那个 `root` 是它自己的局部名）。全文匹配 `dataset.X =` 会把
// `up.dataset.action = 'upload'` 那一大批**元素上的**属性也算进来 —— 那些不归这条管。
// ⚠️ 判「样式读到了没有」用的是**剥掉注释之后的 `<style>`**：注释里写一句
// `[data-sidebar='narrow']` 不算读过（判据 8 就在这上面栽过，见那段注释）。
//
// # ⚠️ 三条「看不见」的地方（写在这里，免得下次以为是漏检）
//
// · **只认字符串字面量**：`el('row-' + i)` 这种拼出来的看不见 ——
//   所以第 3 条里要**扣掉动态前缀**（见下）。`app.js` 现在只有一处动态：`pane-${name}`。
// · **间接路径要自己列**：`sqGet('x')` / `sqSet('x')` / `numField('x', …)` 的**首参也是 id**，
//   它们内部才调 `el` —— 只匹配 `el(` 会把一大批 id 误判成「没引用」（第一版就是这么错的）。
// · **不做**「HTML 里定义了就必须用」的强制检查：那会逼人去删标记，比留着更糟。
// · 第 8 条**只看两个结构体的顶层字段**：`sync` 里面那一组（`SyncScopePatch`）
//   是**另一个结构体**，它的字段在 JS 那边长在 `patch.sync` 里 ——
//   「哪个字段挂在哪一组」是**第三个地方**的知识，脚本猜不出来。
//   ⚠️ 所以嵌进去的字段漏了，这一条拦不住（先把边界写清，免得下次以为是漏检）。
//   ⚠️ `Vec<Channel>` 那种**同构列表**已经由第 12 条补上了（它直接去读 `Channel` 的字段），
//   但 `SyncScopePatch` 还没人管 —— 加它的字段时仍然只能靠人。
// · **`boot.js` 不参与第 1 条**（id 引用）：它跑在 `<body>` 解析之前，本来就碰不到任何
//   元素 —— 里面出现一个 `getElementById('x')` 才是错的。它只被第 10 条读（比对常量）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [
  jsPath = join(root, 'crates/desktop/ui/app.js'),
  htmlPath = join(root, 'crates/desktop/ui/index.html'),
  rustPath = join(root, 'crates/desktop/src/commands.rs'),
  capabilitiesPath = join(root, 'crates/desktop/capabilities/default.json'),
  bootPath = join(root, 'crates/desktop/ui/boot.js'),
  clientPath = join(root, 'crates/client/src/config.rs'),
  i18nPath = join(root, 'crates/desktop/ui/i18n.js'),
] = process.argv.slice(2);

const js = readFileSync(jsPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
const rust = readFileSync(rustPath, 'utf8');
/** ⚠️ 判据 10 要读它（界面偏好的存储键在 `boot.js` 与 `app.js` 里**各写了一份**）。
 * 读不到就是一条**真的失败** —— 那正是「`boot.js` 被改名 / 删掉」的样子，
 * 而它的症状是「主题与语言每次启动都闪一下默认值」，不报错、也看不出来。 */
let boot = null;
let bootReadError = null;
try {
  boot = readFileSync(bootPath, 'utf8');
} catch (error) {
  bootReadError = error;
}

/** ⚠️ 判据 10 / 11 / 14 / 15 都要读它。
 * ⚠️★ 读不到是**真的失败**（不是「跳过」）：那正是「`i18n.js` 被改名 / 删掉」的样子，
 * 而症状是**英文界面整片回到中文**（`app.js` 一上来就 `I18N.apply`，`I18N` 是 undefined
 * → 当场抛异常 → 整页不动）。⚠️ 判据 2 也管加载的那一侧。 */
let i18nSource = null;

/** ⚠️ 判据 12 要读它（房间清单里 `Channel` 有哪些字段）。读不到 = 一条**真的失败**：
 * 那正是「`Channel` 被改名 / 搬家」的样子，而它的症状是这条检查**悄悄失效**。 */
let client = null;
let clientReadError = null;
let i18nReadError = null;
try {
  i18nSource = readFileSync(i18nPath, 'utf8');
} catch (error) {
  i18nReadError = error;
}
try {
  client = readFileSync(clientPath, 'utf8');
} catch (error) {
  clientReadError = error;
}

/** 单参调用 `fn('literal')` 里的字面量。 */
function singleArgLiterals(source, fnName) {
  const pattern = new RegExp(`\\b${fnName}\\(\\s*(['"])([^'"]+)\\1\\s*\\)`, 'g');
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[2]);
  return found;
}

/** 首参是字面量、后面还有别的参数（`numField('cfg-port', 9501)`）。 */
function firstArgLiterals(source, fnName) {
  const pattern = new RegExp(`\\b${fnName}\\(\\s*(['"])([^'"]+)\\1\\s*,`, 'g');
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[2]);
  return found;
}

// ⚠️ 这几个是**间接取 id 的入口**（都在 app.js 里定义），少列一个就会误判。
// ⚠️★ 还要分清**几个参数**：`el('x')` / `sqGet('x')` 是单参；
// `sqSet('x', on)` / `numField('x', 4096)` 的首参才是 id。
// 第一版把 `sqSet` 当成单参匹配 → `srv-sq-local` / `srv-sq-remote`（**只写不读**，
// 所以没有任何 `sqGet` 兜住它们）被误报成「死标记」。这正是「判据比实现更难写」的例子。
const SINGLE_ARG_ID_HELPERS = ['el', 'getElementById', 'sqGet'];
const FIRST_ARG_ID_HELPERS = ['sqSet', 'numField'];

const referenced = new Set(SINGLE_ARG_ID_HELPERS.flatMap((fn) => [...singleArgLiterals(js, fn)]));
for (const fn of FIRST_ARG_ID_HELPERS) {
  for (const id of firstArgLiterals(js, fn)) referenced.add(id);
}

const declared = new Set();
for (const match of html.matchAll(/\bid="([^"]+)"/g)) declared.add(match[1]);

// 动态前缀：`` `pane-${name}` `` 这种 —— 声明的 id 只要以它开头，就说明「拼接可达」。
const dynamicPrefixes = new Set();
for (const match of js.matchAll(/`([A-Za-z][\w-]*)\$\{/g)) dynamicPrefixes.add(match[1]);

const isDynamic = (id) => [...dynamicPrefixes].some((prefix) => id.startsWith(prefix));
const usedAsSelector = (id) => new RegExp(`#${id}\\b`).test(html) || new RegExp(`#${id}\\b`).test(js);

const missing = [...referenced].filter((id) => !declared.has(id)).sort();
const cssOnly = [];
const suspicious = [];
for (const id of [...declared].filter((id) => !referenced.has(id) && !isDynamic(id)).sort()) {
  (usedAsSelector(id) ? cssOnly : suspicious).push(id);
}

let failed = false;

/** ⚠️★ 页面的脚本**一个都不能少**，而且「少了会怎样」每一条都不一样 ——
 * 所以这里逐条写清症状，而不是打印一句「缺少脚本」。
 *
 * ⚠️ `boot.js` 那条尤其值得单独说：它少了之后**页面照常能用**，只有界面偏好
 * （主题 / 语言）会在启动时闪一下默认值 —— 那是最容易被当成「本来就那样」的一类坏，
 * 而它**一次都不会报错**。
 */
const REQUIRED_SCRIPTS = [
  ['boot.js', '主题与语言不会在第一次绘制之前贴上 —— 深色用户每次启动都先闪一下白屏'],
  ['i18n.js', '`app.js` 第一行 `I18N.apply` 就抛异常 —— 整页不动（比「没翻译」严重得多）'],
  ['app.js', '整页都是死的（一个字节的数据都画不出来）'],
];
for (const [script, symptom] of REQUIRED_SCRIPTS) {
  const pattern = new RegExp(`src=["'][^"']*${script.replace('.', '\\.')}["']`);
  if (!pattern.test(html)) {
    failed = true;
    console.error(`✗ index.html 没有加载 ${script}：${symptom}（改名只改了一侧？）`);
  }
}

if (missing.length) {
  failed = true;
  console.error(`✗ app.js 引用了 ${missing.length} 个 index.html 里**不存在**的 id：`);
  for (const id of missing) console.error(`    ${id}`);
  console.error('  ⚠️ 这一类错的表现是「那个功能静默失效」，不会 panic —— 别放过它。');
}

// ── 判据 4：能打字的框都要 `autocapitalize="off"`（理由见文件头）──────────
// ⚠️ 先剥注释与样式表：CSS 注释里写着 `<input>`，不剥会被当成真的输入框。
const markup = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '');

const autoCapMissing = [];
for (const match of markup.matchAll(/<(input|textarea)\b[^>]*>/gi)) {
  const tag = match[0];
  // ⚠️ `<input>` **不带 `type` 就是 text**（HTML 的默认值）—— 别只看写了 type 的那些。
  const typesText = !/\btype\s*=/i.test(tag) || /\btype\s*=\s*["']text["']/i.test(tag);
  if (typesText && !/autocapitalize\s*=\s*["']off["']/i.test(tag)) autoCapMissing.push(tag.trim());
}

// ⚠️ JS 那侧用**计数**：`cellInput` 这类工厂每造一个文本框就该关一次自动大写。
// 不是逐个匹配（那是给文本做结构分析，假的精确），而是「造了几个、关了几个」对不上就说话。
const jsTextFields = (js.match(/\.type\s*=\s*['"]text['"]/g) ?? []).length;
const jsNoAutoCap = (js.match(/\.setAttribute\(\s*['"]autocapitalize['"]\s*,\s*['"]off['"]\s*\)/g) ?? []).length;

if (autoCapMissing.length || jsTextFields !== jsNoAutoCap) {
  failed = true;
  console.error('✗ 有能打字的输入框没关掉「首字母自动大写」（macOS 会把地址打成 `Https://`）：');
  for (const tag of autoCapMissing) console.error(`    index.html: ${tag}`);
  if (jsTextFields !== jsNoAutoCap) {
    console.error(
      `    app.js: 造了 ${jsTextFields} 个文本输入框，只关了 ${jsNoAutoCap} 个的自动大写` +
        '（找 `cellInput` 那一类工厂）。',
    );
  }
  console.error('  ⚠️ 加上 `autocapitalize="off"`；确实要自动大写的话，先想清楚那一格是不是「不许改字面」的。');
}

// ── 判据 5：新建房间不许默认开上行（理由见文件头）────────────────────
// ⚠️ 找的是**那个对象字面量**（`addRoomRow` 的函数体），而不是全文 grep `enable_upload: true`：
// 别处（保存、渲染）出现 `true` 是正常的，只有「新加的那一行」不许带上它。
// ⚠️ 找不到函数 = 也算失败：自检要跟着代码改，不能悄悄失效（那正是这个脚本存在的理由）。
const addRoomRow = js.match(/function addRoomRow\(\)\s*\{[\s\S]*?\n\}/);
if (!addRoomRow) {
  failed = true;
  console.error('✗ 找不到 `addRoomRow` —— 这条自检要跟着改（它钉的是「加房间不顺手打开 ↑」）。');
} else if (/enable_upload\s*:\s*true/.test(addRoomRow[0])) {
  failed = true;
  console.error('✗ `addRoomRow` 又把新房间的上行默认成 `true` 了：');
  console.error('    那等于「点一下加房间就开始往外发本机剪贴板」—— 用户不会回头去关那个 ↑。');
}

// ── 判据 6：提示不许自己拼房间名（理由见文件头）────────────────────────
// ① 喂：`render` 那次调用不许把房间名传进去（那字段已经不存在了）。
if (/showNotice\([^)]*\.room\b/.test(js)) {
  failed = true;
  console.error('✗ 界面又在往提示里塞房间名了（`showNotice(… .room)`）：');
  console.error('    「一条提示归哪个房间」只有壳说了算（每个房间各一格）—— 界面上这一格');
  console.error('    本来就长在那个房间的标题下面，再拼一遍就是**两处判断同一件事**。');
}

// ② 收：`showNotice` 的形参里不许再有 `room`。
// ⚠️ 找的是函数体本身（不是一个全局 grep `room`：全文到处都有这个名字，grep 等于没测）。
const showNoticeDef = js.match(/function showNotice\(([^)]*)\)\s*\{[\s\S]*?\n\}/);
if (!showNoticeDef) {
  failed = true;
  console.error('✗ 找不到 `showNotice` —— 这条自检要跟着改（它钉的是「提示不自己拼房间名」）。');
} else {
  const params = showNoticeDef[1].split(',').map((name) => name.trim());
  if (params.includes('room')) {
    failed = true;
    console.error(`✗ \`showNotice\` 又收房间名了（形参是 ${showNoticeDef[1].trim()}）：`);
    console.error('    收了就会有人去传 —— 而「归哪个房间」不该在界面上再判一次。');
  }
}

// ── 判据 7：提示不许再挂十几秒（理由见文件头）──────────────────────────
const noticeMs = js.match(/\bNOTICE_MS\s*=\s*(\d+)/);
const NOTICE_MS_MAX = 5000;
if (!noticeMs) {
  failed = true;
  console.error('✗ 找不到 `NOTICE_MS` —— 这条自检要跟着改（它钉的是「提示 3 秒后就收」）。');
} else if (Number(noticeMs[1]) > NOTICE_MS_MAX) {
  failed = true;
  console.error(`✗ 提示要停留 ${noticeMs[1]}ms —— 又回到「挂十几秒」了：`);
  console.error(`    Jonny 2026-09-27 定的是 3 秒（这里只给上界 ${NOTICE_MS_MAX}ms）。`);
  console.error('    挂久了用户会开始怀疑它是不是当前状态，而切房间时它还杵在那儿。');
}

// ── 判据 8：设置项的字段名要跨语言对得上（理由见文件头）──────────────────
// ⚠️★ 「接住」与「发还」**各判一次** —— 只判一头的话，另一头删掉照样全绿，
// 而用户看到的症状一模一样（勾不生效）。
// ⚠️ 判的是**函数体内部**，不是全文 grep：`notifyUpload` 这个名字在两个函数里都出现，
// 全文 grep 等于没测（这正是「判据不能靠一个全局搜索」那一条）。
const camelCase = (name) => name.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

/** 从 `commands.rs` 里取一个结构体的字段名（serde camelCase 之后的那一份）。
 *
 * ⚠️ 正则里**刻意带上 `#[serde(rename_all = "camelCase")]`**：那条属性是
 * 「字段名怎么变」的**唯一依据**。不带它的话，哪天有人把它删了（改成 snake_case 下发），
 * 这条自检会**拿着错的字段名去比对**、而且悄悄通过 —— 那比没有这条检查更坏。
 *
 * ⚠️★ 属性与结构体之间**不许跨过 `}`**（那个 `(?!\n\})` 的「温顺点」写法）：
 * 一开始写的是 `[\s\S]*?`，而它是**无界**的 —— 于是删掉 `SettingsView` 上面那条属性之后，
 * 正则掉头去吃**上面那个结构体**（`SettingsPatch`）的属性，照样匹配成功。
 * 也就是说这条自检对「属性被删」**完全没牙**，而它看起来一点问题都没有。
 * ⚠️ 判据里的「任意字符」要盯紧：`[\s\S]*?` 这种写法在**同构的文本块**里几乎总是错的。
 */
function structFields(name) {
  const pattern = new RegExp(
    `#\\[serde\\(rename_all = "camelCase"[^)]*\\)\\]((?:(?!\\n\\})[\\s\\S])*?)pub struct ${name} \\{([\\s\\S]*?)\\n\\}`,
  );
  const body = rust.match(pattern);
  if (!body) return null;
  return [...body[2].matchAll(/^\s*pub (\w+):/gm)].map((match) => camelCase(match[1]));
}

const viewFields = structFields('SettingsView');
const patchFields = structFields('SettingsPatch');
/** ① `openSettings` 的函数体（「接住」要在里面）。
 * ② `settings-save` 那个回调的函数体（「发还」要在里面）。 */
const openSettingsBody = js.match(/async function openSettings\(\)\s*\{[\s\S]*?\n\}/);
const saveBody = js.match(/el\('settings-save'\)\.addEventListener\([\s\S]*?\n\}\);/);

if (!viewFields || !patchFields || !openSettingsBody || !saveBody) {
  failed = true;
  console.error('✗ 判据 8 找不到要比对的东西 —— 这条自检要跟着代码改：');
  if (!viewFields) console.error('    · `commands.rs` 里找不到带 camelCase 的 `SettingsView`');
  if (!patchFields) console.error('    · `commands.rs` 里找不到带 camelCase 的 `SettingsPatch`');
  if (!openSettingsBody) console.error('    · `app.js` 里找不到 `async function openSettings()`');
  if (!saveBody) console.error('    · `app.js` 里找不到 `settings-save` 那个监听器');
  console.error('  ⚠️ 它钉的是「壳给出的每个设置项，界面都要读、也要发得回去」——');
  console.error('    单侧改名 / 加字段忘了改界面，就靠这里拦。');
} else {
  // ① 接住：`settings_view` 给的每个字段，`openSettings` 里都要读一次。
  //
  // ⚠️★ 判的是 **`view.<字段>`** 这个写法，不是「函数体里出现过这个名字」：
  // 后者会被**注释**满足 —— 这一条自己上面就写着 `view.notifyUpload` 之类的例子，
  // 于是「把读它的那一行删掉、注释留着」**照样绿**。
  // 2026-09-28 现场验过（加 `emoji` 那一版时）：删掉读的那一行、注释里留着
  // `view.xxx`，旧写法全绿 —— 也就是说「读过就算」是**没有牙**的。
  // 这跟文件头那条「判据不能靠一个全局搜索」是同一个病。
  // ⚠️ 代价：读法必须是 `view.X`（解构 `const { X } = view` 会被误判）——
  // 这一侧每个字段都是 `view.X`，而「读法只有一种」本来就是想要的。
  const notRead = viewFields.filter((name) => !openSettingsBody[0].includes(`view.${name}`));

  // ② 发还：保存时每个字段都要发回去。
  const notSent = patchFields.filter((name) => !saveBody[0].includes(name));
  if (notRead.length) {
    failed = true;
    console.error(`✗ 有 ${notRead.length} 个设置项，界面**没有读**（壳给的、界面没接）：`);
    for (const name of notRead) console.error(`    ${name}`);
    console.error('  ⚠️ 症状：那个控件**永远画的是 HTML 里写死的值** —— 用户改了、关掉再开又变回来，');
    console.error('    而且不会有任何报错。去 `openSettings` 里补一句 `view.<字段>` 读它。');
  }
  if (notSent.length) {
    failed = true;
    console.error(`✗ 有 ${notSent.length} 个设置项，界面**没有发回去**（能点、存不下去）：`);
    for (const name of notSent) console.error(`    ${name}`);
    console.error('  ⚠️ 症状：控件能点能变，但**永远存不下去**，下次启动又变回来。');
    console.error('    去 `settings-save` 那个回调的 `patch` 里补上它。');
  }
}

// ── 判据 9：页面不许拿到系统通知的权限（理由见文件头）────────────────────
let capabilities = null;
try {
  capabilities = JSON.parse(readFileSync(capabilitiesPath, 'utf8'));
} catch (error) {
  failed = true;
  console.error(`✗ 读不出能力文件（${capabilitiesPath}）：${error}`);
}
if (capabilities) {
  // ⚠️ 一条权限可以是字符串，也可以是 `{ identifier, allow }` —— 两种都要认。
  const granted = (capabilities.permissions ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry?.identifier ?? '')))
    .filter((identifier) => String(identifier).startsWith('notification'));
  if (granted.length) {
    failed = true;
    console.error(`✗ 能力文件给页面放了系统通知的权限：${granted.join('、')}`);
    console.error('  ⚠️ 发通知的只有 Rust 侧的 `notify::SystemNotifier` —— 页面**不该**有这个能力');
    console.error('    （desktop-client.md §2：页面只跟 IPC 命令说话）。要去掉它。');
  }
}

if (i18nReadError) {
  failed = true;
  console.error(`✗ 读不出 ${i18nPath}：${i18nReadError.message}`);
  console.error('  ⚠️ 它是那两份字典和 `I18N` 的家；少了它 `app.js` 第一行就抛异常（整页不动），');
  console.error('    判据 14 / 15 也无从谈起 —— 所以这里必须算失败，不能「跳过」。');
}

// ── 判据 10：界面偏好的存储键，两份脚本必须一致（理由见文件头）──────────────
/**
 * 取一份源码里 `const NAME = '值';` 的那个值。
 *
 * ⚠️★ 正则**锚在行首**（`^\s*const`，带 `m`）：不锚的话它会去匹配**注释里**提到的
 * `const X_KEY = '…'` —— 实测当场踩到过（那条注释就在解释这个常量）。
 * 症状是「对着注释里的示例报红」，而更坏的方向是**注释里随便写一个值就能让这条自检失去意义**。
 *
 * ⚠️ 也只认**单引号字面量**这一种写法：写得别致一点（模板串 / 拼出来）就返回 `null`，
 * 而 `null` 会让下面判红 —— 那是故意的。
 */
function constString(source, name) {
  const match = new RegExp(`^\\s*const ${name} = '([^']*)';?\\s*$`, 'm').exec(source ?? '');
  return match ? match[1] : null;
}

if (bootReadError) {
  failed = true;
  console.error(`✗ 读不出 ${bootPath}：${bootReadError.message}`);
  console.error('  ⚠️ 主题 / 语言就是靠它在第一次绘制之前贴上去的 —— 少了它，界面偏好会闪一下默认值。');
} else {
  // ⚠️★ 这些键**故意写了两份**：`boot.js` 要在 `app.js` **之前**跑（见它的模块注释），
  // 所以它读不到 `app.js` 里那份常量。而「两份会漂」这件事在这里是**真的危险**：
  // 键漂了之后，`boot.js` 用 A 键去读、`app.js` 用 B 键去写 ——
  // 症状是「**点一下能换、重启就变回去**」，或者反过来「存下去了、启动时又不生效」。
  // 两种都不报错，而且都只在**重启之后**才看得出来（用户早就忘了自己点过什么）。
  //
  // ⚠️ 清单是**从 `boot.js` 里数出来的**（不手写）：写死一份清单的话，
  // 下次谁在 `boot.js` 里多读一个键、忘了在对面那份里对上，这一条**照样绿**。
  // 方向只有一个（boot → 对面）：对面脚本里可以有自己的键（那些不需要 `boot.js` 认识）。
  // ⚠️ 锚在行首（同 `constString` 的理由）：`boot.js` 的注释里也写着 `const X_KEY = '…'`。
  //
  // ⚠️★ 对面**不止一份**：主题 / 侧栏两个键在 `app.js`，语种那个键在 `i18n.js`
  //（`app.js` 不读存储，它只看 `<html data-locale>`）。所以要**挨个找过去**，
  // 只查 `app.js` 的话「`LOCALE_KEY` 搬去了 i18n.js」会被误报成「只在 boot.js 里有」。
  const bootKeys = [...boot.matchAll(/^\s*const (\w+_KEY) = '([^']*)'/gm)];
  if (!bootKeys.length) {
    failed = true;
    console.error(`✗ 判据 10 在 ${bootPath} 里一个 \`const X_KEY = '值';\` 都没找到 —— 这条自检要跟着代码改。`);
  }
  const peers = [
    ['app.js', js, jsPath],
    ['i18n.js', i18nSource ?? '', i18nPath],
  ];
  for (const [, name, value] of bootKeys) {
    const homes = peers
      .map(([label, source]) => [label, constString(source, name)])
      .filter(([, found]) => found !== null);
    if (!homes.length) {
      failed = true;
      console.error(`✗ ${name} 只在 boot.js 里有（'${value}'），另外两份脚本里都没有同名常量`
        + ' —— 这条自检要跟着代码改。');
    } else if (homes.some(([, found]) => found !== value)) {
      failed = true;
      const where = homes.map(([label, found]) => `${label} 是 '${found}'`).join('、');
      console.error(`✗ ${name} 的值对不上：boot.js 是 '${value}'，${where}`);
      console.error('  ⚠️ 症状是「点一下能换、重启就变回去」（或反过来），**不报错**，只有重启后才看得出来。');
    }
  }
}

// ── 判据 11：两份脚本合起来要能过一遍解析（理由见文件头）────────────────
if (boot !== null) {
  try {
    // ⚠️ **只编译、不执行**：`new Function(…)` 只把源码过一遍解析器，
    // 函数体一行都不会跑（否则 `app.js` 开头那个 `throw` 会立刻把我们打停）。
    // ⚠️★ **三份都要拼进来**（`boot.js` / `i18n.js` / `app.js`）：共用一个全局词法作用域的
    // 是**所有普通脚本**，漏掉一份就等于漏掉一半的撞名。（2026-09-28 加 `i18n.js` 时补的。）
    new Function(`${boot}\n${i18nSource ?? ''}\n${js}`);
  } catch (error) {
    failed = true;
    console.error(`✗ 这几份脚本合起来解析不过：${error.message}`);
    console.error('  ⚠️★ 最常见的一种是「各自都好、合起来却死了」：它们都是**普通脚本**');
    console.error('    （不是 module），顶层的 `const` / `let` 进的是**同一个**全局词法作用域 ——');
    console.error('    同名变量会让**后解析的那一份整个不执行** = 整页不动。');
    console.error('    修法：常量放进各自的 IIFE（见 `boot.js` / `i18n.js` 的注释）。');
    console.error('  ⚠️ 顺带的收益：普通的语法错也会在这里被拦下 —— 这一侧没有构建步骤，别处没人拦。');
  }
}

// ── 判据 12：房间清单里每个 `Channel` 字段，界面都得发得回去（理由见文件头）────────
/**
 * `Channel` 的字段名（**原样**，不是 camelCase）。
 *
 * ⚠️ `Channel` 上**没有** `#[serde(rename_all)]`：嵌套类型不吃外层容器的
 * `rename_all`，所以它在 JSON 里就是 snake_case（`auth_token` / `enable_upload`）——
 * 这也是 `app.js` 里那些 `room.auth_token` 的由来。别顺手给它加 camelCase。
 */
function channelFields() {
  // ⚠️ 锚在结构体**自己的名字**上（`pub struct Channel {`），不锚的话
  // `[\s\S]*?` 会跨过别的结构体 —— 判据 8 里就踩过这个（见 `structFields` 的注释）。
  const body = (client ?? '').match(/pub struct Channel \{([\s\S]*?)\n\}/);
  if (!body) return null;
  return [...body[1].matchAll(/^\s*pub (\w+):/gm)].map((match) => match[1]);
}

/** 一个对象字面量里有没有这个**键**（`name:` 那种，不是 `room.name` 里的子串）。 */
const hasKey = (literal, field) => new RegExp(`(^|[,{])\\s*${field}\\s*:`, 'm').test(literal);

if (clientReadError) {
  failed = true;
  console.error(`✗ 读不出 ${clientPath}：${clientReadError.message}`);
  console.error('  ⚠️ 判据 12 要拿它里面的 `Channel` 字段名单 —— 读不到就等于这条检查失效了。');
} else {
  const fields = channelFields();
  // 两处**各判一次**：新加的那一行、以及保存时发回去的那一份。
  const addLiteral = js.match(/roomDraft\.push\(\{([\s\S]*?)\n\s*\}\);/);
  const saveLiteral = js.match(/roomDraft\.map\(\(room\) => \(\{([\s\S]*?)\}\)\)/);

  if (!fields || !fields.length || !addLiteral || !saveLiteral) {
    failed = true;
    console.error('✗ 判据 12 找不到要比对的东西 —— 这条自检要跟着代码改：');
    if (!fields || !fields.length) console.error(`    · ${clientPath} 里找不到 \`pub struct Channel {\``);
    if (!addLiteral) console.error('    · `app.js` 里找不到 `roomDraft.push({ … })\`（加房间那一行）');
    if (!saveLiteral) console.error('    · `app.js` 里找不到 `roomDraft.map((room) => ({ … }))\`（保存那一份）');
    console.error('  ⚠️ 它钉的是「房间清单是**整份替换**，少一个字段 = 那个字段被静默清掉」。');
  } else {
    const checks = [
      [addLiteral[0], '`addRoomRow` 造的那个新房间'],
      [saveLiteral[0], '保存时发回去的那一份'],
    ];
    for (const [literal, where] of checks) {
      const missing = fields.filter((field) => !hasKey(literal, field));
      if (missing.length) {
        failed = true;
        console.error(`✗ ${where}少了 ${missing.length} 个 \`Channel\` 字段：${missing.join('、')}`);
        console.error('  ⚠️ 房间清单是**整份替换**（`SettingsPatch::rooms`）—— 少一个键 =');
        console.error('    那个字段落回 serde 默认值。最典型的：少 `auth_token` → 保存一次密码全没；');
        console.error('    少 `emoji` → 用户挑的图标全变回「自动」。两者都**不报错**。');
      }
    }
  }
}

// ── 判据 13：往 `<html>` 上写的属性，样式表要有人读（理由见文件头）──────────────
// ⚠️★ 先剥掉注释：注释里出现一句 `[data-sidebar='narrow']` **不算**样式表读了它
//（判据 8 就是被注释喂饱的，见那段注释）。
const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  .map((match) => match[1].replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

// ⚠️ `(?!=)`：不加的话 `dataset.theme === 'dark'` 那种**读**也会被当成**写**。
const HTML_ATTR_WRITE = /(?:documentElement|\broot)\.dataset\.(\w+)\s*=(?!=)/g;
const writtenAttrs = new Set();
for (const source of [js, boot ?? '']) {
  for (const match of source.matchAll(HTML_ATTR_WRITE)) writtenAttrs.add(match[1]);
}

if (!writtenAttrs.size) {
  failed = true;
  console.error('✗ 判据 13 在两份脚本里一个 `<html>` 上的属性都没找到 —— 这条自检要跟着代码改：');
  console.error('    它找的是 `document.documentElement.dataset.X = …` / `root.dataset.X = …`。');
} else {
  for (const name of writtenAttrs) {
    if (!styleText.includes(`[data-${name}`)) {
      failed = true;
      console.error(`✗ 脚本往 <html> 上写了 \`data-${name}\`，而样式表里没有一条选择器读它：`);
      console.error('  ⚠️ 症状：那个开关点下去**什么都不发生** —— 属性真的变了、样式没人理，');
      console.error(`    不报错，再点一次还是没反应。要么在 index.html 里补一条 \`:root[data-${name}=…]\`,`);
      console.error('    要么就别写这个属性。');
    }
  }
  // ⚠️ 反方向**只提示**（理由见文件头）—— 它可能压根不是 `dataset` 写的。
  const cssAttrs = new Set(
    [...styleText.matchAll(/\[data-(\w+)/g)].map((match) => match[1]),
  );
  const neverWritten = [...cssAttrs].filter((name) => !writtenAttrs.has(name));
  if (neverWritten.length) {
    console.warn(`⚠ 样式表读了 ${neverWritten.length} 个**没有脚本会写**的属性：${neverWritten.join('、')}`);
    console.warn('  ⚠️ 只是提醒，不算失败 —— 它可能是写死在 HTML 标记上的（那种不走 `dataset`），');
    console.warn('    也可能是某条已经删掉的功能留下的死样式（§8.1 第 6 条那一类）。');
  }
}

// ── 判据 14 / 15：文案的字典与抽键（理由见文件头）──────────────────────────
//
// ⚠️★ 这两条管的是**同一件事的两端**：界面里每一句要翻的话都得有 key（15），
// 而每一个 key 都得有译文（14）。**只做一半的后果完全不同**：
//   · 只做 14：漏抽的那句中文在英文界面里**永远不会变** —— 看着像「翻译漏了一句」，
//     而它其实是「这句压根不在字典的覆盖范围里」，两种病的修法不一样；
//   · 只做 15：抽了 key 但没译文 → 英文界面里印着那句**中文原文**（三级回落里
//     第一级没命中、第二级命中），看起来也像「没翻译」，而真相是「译文没写」。
// 所以两条都要，而且**分开报**。

/** 剥掉 JS 的注释，把字符串字面量换成 `\0内容\0` 这样的包装。
 *
 * ⚠️★ 用途是判据 15：要找「字符串字面量里的中文」，就必须先能分清「这是字符串」
 * 和「这是注释」。⚠️ 注释里当然有中文（这个仓库的注释全中文），不能算。
 * ⚠️ 三段式扫描：注释 / 引号 / 正则。⚠️ 正则那一支只在「上一个有意义字符暗示这里
 * 能出现正则」时才切进去（`= ( , : [ ! & | ? { ;` 这些之后）—— 否则 `a / b` 这种除法
 * 会被当成正则的开头，把后面一大段代码吞掉（吞掉的后果是**漏报**，不报错）。
 */
function stripJs(source) {
  let out = '';
  let i = 0;
  let lastMeaningful = '';
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let body = '';
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          body += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        body += source[i];
        i++;
      }
      i++;
      out += '\u0000' + body + '\u0000';
      lastMeaningful = 'x';
      continue;
    }
    if (c === '/' && /[=(,:;[!&|?{;]/.test(lastMeaningful)) {
      i++;
      while (i < n && source[i] !== '/' && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      lastMeaningful = 'x';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastMeaningful = c;
    i++;
  }
  return out;
}

/** ⚠️★ **汉字** —— 「这个键是不是中文原文」按这个判（判据 14 的两条分类）。
 *  ⚠️ 它**故意只认汉字、不认标点**：`'{label}…'` 这种「没有中文词、只有标点」的键
 *  得当**符号键**看（两份字典都要有一条）—— 拿「有标点」当「有中文」的话，
 *  它会被当成源语言键、`zh` 那边就没有那一条了，而它的中文其实是拼出来的。 */
const IDEOGRAPH = /[\u4e00-\u9fff]/;

/** ⚠️★ **汉字 + 中文标点** —— 「这段文字该不该抽键」按这个判（判据 15）。
 *
 * 后面那一串是中文标点：`、。` / `〈〉《》「」『』【】` / `〔〕〖〗〘〙〚〛` / `！（）` /
 * `，：；？` / `…`。
 *
 * ⚠️★ 标点这一半是 2026-09-28 补的，起因是「一句话拆成几片 + 中间夹 `<b>`」那种写法：
 * 写完 `…<b>不改</b>。` 时那个句号留在了**键外面** —— 中文看不出来（拼起来还是那句话），
 * 而英文界面里会凭空多出一个中文句号。**7 处**都是这么来的。
 * 修法是「标点留在键里」（`<b data-i18n="不改。">`），这条判据负责不让它回来。
 *
 * ⚠️ 全角符号（`＋` `⚙` 那种图标）**不算** —— 它们是符号、不该翻
 * （`＋` 就是 `#btn-room-add` 里那个 `.gl`，窄栏收起后只剩它）。所以这里是**点名的集合**，
 * 不是「整段全角区」。⚠️ 破折号 `—` 也**不算**：中英都用它。
 */
const CN_TEXT = /[\u4e00-\u9fff\u3001\u3002\u3008-\u3011\u3014-\u301b\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f\u2026]/;

/** 键里有中文 ⇒ 「原文即键」，`zh` 那份不用自己再有一条（见 `ui/i18n.js` 文件头那张表）。 */
const isSourceKey = (key) => IDEOGRAPH.test(key);

/** 从 `index.html` 里数出所有挂过 key 的地方。 */
function htmlKeys(source) {
  const found = new Map(); // key -> 属性名（报告里要说清是哪一处）
  // ⚠️ 先剥注释 / `<style>` / `<script>`：CSS 注释里就写着 `data-i18n="pending"`
  //（那段在解释遮布），不剥的话它会变成一个「界面用到的键」—— 实测就是这么误报的。
  const bare = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');
  for (const attr of ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-html']) {
    const pattern = new RegExp(attr + '\\s*=\\s*"([^"]*)"', 'g');
    for (const match of bare.matchAll(pattern)) {
      if (!found.has(match[1])) found.set(match[1], attr);
    }
  }
  return found;
}

/** 从脚本里数出所有 `t('…')` / `I18N.html('…')` 的字面量首参。
 *
 * ⚠️★ 取出来的是**转义之后**的样子，所以要把 `\'` 和 `\n` **还原成运行时的值** ——
 * 字典里那两条键是按运行时的值写的（`'…都没有。\n去配置里加一个…'` 里是一个真换行）。
 * 不还原的话：`.empty` 那条多行提示**永远找不到译文**，而报出来的错是
 * 「`en` 里没有译文」—— 看着像漏译，其实是比对的两个字符串根本不是一个东西。
 */
function jsKeys(source) {
  const found = new Set();
  for (const fn of ['t', 'I18N\\.t', 'I18N\\.html']) {
    const pattern = new RegExp('\\b' + fn + '\\(\\s*\'((?:[^\'\\\\]|\\\\.)*)\'', 'g');
    for (const match of source.matchAll(pattern)) {
      found.add(match[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
    }
  }
  return found;
}

if (i18nSource) {
  // ⚠️ 字典是**跑一遍** `i18n.js` 拿到的，不是正则抠的：正则抠不出
  // 「少一个引号 / 两个语种键集合不一致」这些事，而它们都会让译文悄悄失效。
  // ⚠️ 只给一个假 `window`：这份文件在**加载时**不碰 `document` / `localStorage`
  //（它俩只在函数体里用）—— 所以这里不需要 DOM。
  let dicts = null;
  let loadError = null;
  try {
    const win = {};
    new Function('window', i18nSource)(win);
    dicts = (win.I18N && win.I18N.DICTS) || null;
  } catch (error) {
    loadError = error;
  }

  if (!dicts) {
    failed = true;
    const why = loadError ? '（' + loadError.message + '）' : '';
    console.error('✗ 判据 14 跑不了：`i18n.js` 没能给出 `DICTS`' + why + ' —— 这条自检要跟着代码改。');
  } else {
    const locales = Object.keys(dicts);
    const srcLang = locales.includes('zh') ? 'zh' : locales[0];
    const sourceTable = dicts[srcLang] || {};
    const others = locales.filter((l) => l !== srcLang);

    // ① 每个语种的键集合必须和源语言**对得上**（缺一条 = 那一句永远显示源语言）
    for (const locale of others) {
      const missing = Object.keys(sourceTable).filter((key) => !(key in dicts[locale]));
      if (missing.length) {
        failed = true;
        console.error('✗ 判据 14：`' + locale + '` 里少了 ' + missing.length + ' 条译文（那些句子会回落成源语言）：');
        for (const key of missing.slice(0, 12)) console.error('    ' + JSON.stringify(key));
        if (missing.length > 12) console.error('    …还有 ' + (missing.length - 12) + ' 条');
      }
    }

    // ② 界面用到的每个**符号键**都得有句子（缺了就会把键原样印在界面上）
    const used = new Map([...htmlKeys(html)].map(([k, attr]) => [k, 'index.html 的 ' + attr]));
    for (const key of jsKeys(js)) used.set(key, 'app.js 里的 t(…)');

    const symbolOnly = [...used].filter(([key]) => !isSourceKey(key));
    const unresolved = symbolOnly.filter(([key]) => !(key in sourceTable));
    if (unresolved.length) {
      failed = true;
      console.error('✗ 判据 14：' + unresolved.length + ' 个**符号键**在字典里没有对应句子（会原样印在界面上）：');
      for (const [key, where] of unresolved) console.error('    ' + key + '   （' + where + '）');
      console.error('  ⚠️ 症状：屏幕上直接印着 `desktop.problem.icon` 这样的键 —— 难看，但正是要它难看。');
    }

    // ③ 每个语种都要有译文
    //    · 符号键：必须两处都有（源语言那份也是「译文」，因为 Rust 不许拼中文）；
    //    · 静态文案的键（中文原文）：源语言那份走「回落到键本身」，**只要求别的语种有**。
    for (const locale of others) {
      const untranslated = symbolOnly
        .filter(([key]) => !(key in dicts[locale]))
        .map(([key]) => key);
      if (untranslated.length) {
        failed = true;
        console.error('✗ 判据 14：' + untranslated.length + ' 个符号键在 `' + locale + '` 里没有译文：');
        for (const key of untranslated) console.error('    ' + key);
      }
      const untranslatedSource = [...used]
        .filter(([key]) => isSourceKey(key) && !(key in dicts[locale]))
        .map(([key, where]) => JSON.stringify(key) + '（' + where + '）');
      if (untranslatedSource.length) {
        failed = true;
        console.error('✗ 判据 14：' + untranslatedSource.length + ' 处界面文案在 `' + locale + '` 里没有译文：');
        for (const line of untranslatedSource.slice(0, 15)) console.error('    ' + line);
        if (untranslatedSource.length > 15) {
          console.error('    …还有 ' + (untranslatedSource.length - 15) + ' 处');
        }
        console.error('  ⚠️★ 最常见的成因：改了中文原文（键跟着变了）而没补译文 —— 旧译文的键对不上，**不报错的**。');
      }
    }

    // ④ 同一句话在两处用时，`{参数}` 必须一致（少一个 = 参数原样印出来）
    const paramsOf = (template) => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const [locale, table] of Object.entries(dicts)) {
      for (const [name, template] of Object.entries(table)) {
        const mine = paramsOf(template);
        const theirs = paramsOf(sourceTable[name] ?? name);
        if (mine !== theirs) {
          failed = true;
          console.error('✗ 判据 14：`' + locale + '` 的 `' + name + '` 参数与源语言对不上：'
            + '`' + mine + '` vs `' + theirs + '`');
        }
      }
    }
  }

  // ── 判据 15：抽键完整性 ────────────────────────────────────────────────
  // ⚠️★ 判据 14 只证明「**用到的**键都有译文」，证明不了「**该抽的都抽了**」——
  //    漏抽一句中文，它压根不进 `used`，14 照样全绿。所以要有这一条。
  const stolen = [];
  // ① 文本节点：**含汉字或中文标点**、而所在元素**没有**挂 `data-i18n` 的
  //
  // ⚠️ 字符类从 `CN_TEXT.source` 拼出来，不再抄第二遍 —— 抄一遍就会出现
  //   「上面加了标点、下面还是只查汉字」这种**只有一半生效**的判据。
  // ⚠️ 找出「这段文字属于哪个元素」用的是「往回找最近一个 `<`」。这对**现在的**标记是准的
  //   （每段文字所在的元素自己就挂着 key，不存在「父元素挂 key、子元素没挂」）。
  //   ⚠️★ 将来要是用上 `data-i18n-html`（父元素一句、里面夹 `<b>`），这条就会开始**误报** ——
  //   那时得换成「顺着标签走一遍、记住祖先链上有没有 key」的写法。
  const textNode = new RegExp('>([^<>]*' + CN_TEXT.source + '[^<>]*)<', 'g');
  for (const match of markup.matchAll(textNode)) {
    const text = match[1].trim();
    if (!text) continue;
    const before = markup.slice(0, match.index);
    const lastOpen = before.lastIndexOf('<');
    const tag = lastOpen >= 0 ? markup.slice(lastOpen, match.index) : '';
    if (/data-i18n\b/.test(tag)) continue;
    stolen.push('文本「' + text.slice(0, 30) + '」');
  }
  // ② 属性：`title=` / `placeholder=` 里还留着中文（说明没搬成 `data-i18n-title`）
  // ⚠️ `(?<![\w-])`：不加的话 `data-i18n-title="…"` 也会被 `\btitle` 命中
  //（`-` 是非词字符，`\b` 在它后面成立）—— 实测一上来就是 5 个假红。
  for (const match of markup.matchAll(/(?<![\w-])(title|placeholder)\s*=\s*"([^"]*[\u4e00-\u9fff][^"]*)"/g)) {
    stolen.push('属性 ' + match[1] + '="' + match[2].slice(0, 30) + '"');
  }
  if (stolen.length) {
    failed = true;
    console.error('✗ 判据 15：index.html 里有 ' + stolen.length + ' 处中文**没挂 data-i18n**（切到别的语种时它们不会变）：');
    for (const line of stolen.slice(0, 15)) console.error('    ' + line);
    if (stolen.length > 15) console.error('    …还有 ' + (stolen.length - 15) + ' 处');
  }
  // ③ 脚本里**含中文的字符串字面量，必须是 `t(…)` / `html(…)` 的实参**
  //
  // ⚠️★ 判据不是「不许出现中文串」：抽完键之后中文**还在**（它是 `t()` 的实参）。
  //     真正要拦的是「**漏了一处**」—— 那就得看它**长在什么位置**。
  // ⚠️ `stripJs` 的输出里字符串已经换成 `\0内容\0`，所以「前面是不是 `t(`」
  //    直接看剥完之后的文本就够了（注释已经被扔掉，不会误判）。
  for (const [label, source] of [['app.js', js], ['boot.js', boot ?? '']]) {
    const stripped = stripJs(source);
    const bare = [];
    for (const match of stripped.matchAll(/\u0000([^\u0000]*)\u0000/g)) {
      // ⚠️ 这里用 `CN_TEXT`（含标点）：`'…'` `'。'` 这种**只有标点**的字面量同样得走 `t()`
      //（实测就是它抓到的：`` `${label}…` `` 那个模板串 —— 中文侧看着没问题，英文侧是个中文省略号）。
      if (!CN_TEXT.test(match[1])) continue;
      const before = stripped.slice(0, match.index).replace(/\s+$/, '');
      // `t(` / `I18N.t(` / `I18N.html(` 都算（`showNotice(kind, t(…))` 这种也在里面）
      if (/(?:I18N\.)?(?:t|html)\($/.test(before)) continue;
      bare.push(match[1]);
    }
    if (bare.length) {
      failed = true;
      console.error('✗ 判据 15：' + label + ' 里有 ' + bare.length + ' 处中文**没走 `t(…)`**'
        + '（切到别的语种时它们不会变）：');
      for (const line of bare.slice(0, 15)) console.error('    ' + JSON.stringify(line.slice(0, 60)));
      if (bare.length > 15) console.error('    …还有 ' + (bare.length - 15) + ' 处');
      console.error('  ⚠️ 注释里的中文**不算**（这个仓库的注释就是中文）—— 这里剥过注释了。');
      console.error('  ⚠️ 但**壳（Rust）下发的**句子不归这里管：它们的 key 在 `i18n.js` 里，');
      console.error('    由判据 14 的「符号键两边都要有译文」兜着。');
    }
  }
}

if (cssOnly.length) {
  console.log(`· ${cssOnly.length} 个 id 只被选择器用（形如 #id { … }），正常：${cssOnly.join('、')}`);
}
if (dynamicPrefixes.size) {
  console.log(`· 动态前缀（拼接出来的 id，脚本看不见）：${[...dynamicPrefixes].join('、')}`);
}
if (suspicious.length) {
  console.warn(`⚠ 有 ${suspicious.length} 个 id **既没被 app.js 引用、也没有选择器用它**，可能是死标记：`);
  for (const id of suspicious) console.warn(`    ${id}`);
  console.warn('  ⚠️ 只是提醒，不算失败 —— 先确认它是不是给将来用的。');
}

if (failed) process.exit(1);

console.log(
  `✓ 手写 UI 自检通过：app.js 引用 ${referenced.size} 个 id，全部存在于 index.html` +
    `（index.html 共 ${declared.size} 个 id）。`,
);
