#!/usr/bin/env node
// 桌面端**手写界面**的静态自检。
//
// 用法：
//   node tools/desktop-ui-smoke.mjs                       # 在 clip9/ 下跑
//   node tools/desktop-ui-smoke.mjs <app.js> <index.html> [commands.rs] [capabilities.json] [boot.js] [client-config.rs] [i18n.js] [rust 源码目录] [say 夹具]
//                                                         # 用别的夹具跑（变异验证 / 临时排查）
//   ⚠️ 位置参数写 `-` 就是「这一项用默认值」（变异验证常常只想换**其中一个**，
//      而默认值只在实参是 `undefined` 时才生效 —— 空串不是 `undefined`）。
//   ⚠️ 第 8 个参数是**冒号分隔的目录表**（判据 16 / 17 要扫一整个目录，不是一个文件），
//      第 9 个参数是**两份渲染器共用的夹具**（判据 18）。两个都给了默认值。
//
// # ⚠️ 为什么要有它
//
// `rust/crates/desktop/ui/app.js` 里到处是 `el('cfg-textlimit')` 这种**字符串 id**，
// 而这一侧**没有任何测试运行器**（`web-vue3` 与 `ui/*.js` 都没有，见 MEMORY.md）。
// 于是「id 打错一个字」的表现是**那个功能静默失效**：不报错、不 panic，
// 控制台里可能只有一行 `null.classList` —— 而这一版连控制台都不给用户看。
//
// 这类错**不需要跑起来才能发现**：两侧都是静态文本，比一下就知道。
// 对照：SPA 有 `web-vue3/scripts/check-display-semantics.mjs`、服务端渲染页有
// `cloud-clip/tools/page-smoke.mjs`，**只有手写 UI 这一侧是裸奔的**
//（见 `dev-docs/specs/desktop-client.md` §1.1 缺口 C）。
//
// # 判据（**第 1、2、4、5、6、7、8、9、10、11、12、13、14、15、16、17、18、19、20 条算失败**）
//
// 1. `app.js` 引用到的每一个 id，`index.html` 里必须存在 —— 不通过 = 退出码 1；
// 2. `index.html` 真的加载了**每一个**该加载的脚本（`boot.js` / `i18n.js` / `app.js`）；
//    ⚠️ 少一个的症状**各不相同**，所以每一条都写清了「少了会怎样」（见下面那张表）——
//    「改名只改一侧」这句话对 `boot.js` 是不准的：少了它页面照常能用，
//    只有深色用户会发现启动时闪一下白屏（那是**最容易被当成「本来就那样」**的一类）；
// 3. 反向（HTML 有、JS 没引用）**只提示**，而且分两种：
//    · 「只被选择器用」（`#rooms-table { … }` 这类样式钩子）→ 正常，**不吵**；
//    · 「既没被 JS 引用、也没有选择器用它」→ 才提一句（可能是死标记，与 §8.1 第 6 条那两段死 CSS 同类）。
// 4. 每一个**能打字**的输入框（`type="text"` / `type="password"` / 不带 `type` 的
//    `<input>` / `<textarea>`）必须带 `autocapitalize="off"` —— 不通过 = 退出码 1。理由见下。
//    ⚠️★ `password` 也要：它掩着的时候无所谓，但那旁边有个「看一眼」的 👁
//    （`cellSecret`）—— 按开之后它就是普通文本框，而凭据那一格**恰恰是**
//    「一个字符都不能差」的地方。
// 5. 新建房间的默认**不许打开上行**（`addRoomRow`）—— 不通过 = 退出码 1。理由见下。
// 6. **提示不许自己拼房间名** —— 「一条提示归哪个房间」只有壳说了算
//    （`store` 里每个房间各一格），界面只显示壳给的那一条。不通过 = 退出码 1。理由见下。
// 7. `NOTICE_MS` 不许再回到「挂十几秒」—— 不通过 = 退出码 1。理由见下。
// 8. **设置项的字段名要跨语言对得上**：`SettingsView` 的每个字段，`openSettings` 里都要读；
//    `SettingsPatch` 的每个字段，保存时都要发回去 —— 不通过 = 退出码 1。理由见下。
// 9. **页面不许拿到系统通知 / 全局快捷键的权限**（`capabilities/default.json` 里不许出现
//    `notification*` 或 `global-shortcut*`）—— 不通过 = 退出码 1。理由见下。
// 10. **界面偏好的存储键，`boot.js` 与「拥有它的那份脚本」必须一致**（`const X_KEY = '…'` 那一族）
//    —— 不通过 = 退出码 1。理由见下。
// 11. **三份脚本合起来要能过一遍解析** —— 不通过 = 退出码 1。理由见下。
// 12. **房间清单里每个 `Channel` 字段，界面都得发得回去**（`addRoomRow` 与保存那两处）
//    —— 不通过 = 退出码 1。理由见下。
// 13. **脚本往 `<html>` 上写的属性，样式表要真的读它** —— 不通过 = 退出码 1。理由见下。
// 14. **文案字典要盖住界面用到的每一个键，两种键各有各的规矩** —— 不通过 = 退出码 1。理由见下。
// 15. **`index.html` 里不许留下没挂 key 的中文 / 脚本里不许留中文串** —— 不通过 = 退出码 1。理由见下。
// 16. **壳（Rust）那一侧不许自己拼界面文案**（含汉字的字面量只许出现在日志、断言、
//     `panic!`，或者带 `// i18n-ok:` 标记的行上）—— 不通过 = 退出码 1。理由见下。
// 17. **壳发出去的每一个键都得在字典里真的有**（`Msg::key("…")` 与 `ui/i18n.js` 对账）
//     —— 不通过 = 退出码 1。理由见下。
// 18. **两份渲染器（壳 / 页面）读同一份夹具、逐字一致**（`say-cases.json`）
//     —— 不通过 = 退出码 1。理由见下。
// 19. **快照里每条条目的字段（`EntryView`），`renderEntry` 都要读**（与第 8 条同族，
//     但管的是**卡片**那一个形状）—— 不通过 = 退出码 1。理由见下。
// 20. **`hidden` 属性要真的能藏住**（样式表里恰好一条 `[hidden] { display: none !important; }`，
//     且全表只有这一处 `!important`）—— 不通过 = 退出码 1。理由见下。
//
// # ⚠️ 第 4 条为什么算失败，而不是「提一句」
//
// macOS 会把文本框里**每句的首字母**自动大写，而这个界面里被用户手打的每一格
// 都是**不许改字面**的东西：服务端地址、房间名、凭据、要发出去的消息正文。
// 实测踩到（2026-09-27）：地址格里的 `https://` 被写成 `Https://`，
// 表现是「明明填对了却连不上」—— 而**一个字母的大小写**是看不出来的，
// 用户查了半天网络。⚠️ 它不会让任何东西报错，所以只有这里能拦。
//
// ⚠️★ 看**两个**入口：`index.html` 里写死的，与 `app.js` 现造的（`cellInput` / `cellSecret`）。
// 只看一边的话，另一边新加的框会静默漏过去 —— 而漏过去**不报错**。
// ⚠️ 两侧的「算不算要关自动大写」是**同一条规则**（`text` + `password`）：下面 HTML 那侧
// 的 `typesText` 与 JS 那侧的正则字符类要一起改，漏一边就是那一半失效。
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
// # ⚠️ 第 19 条为什么算失败（快照里每条条目的字段都要读）
//
// 第 8 条那句话（「读的是全部字段」）只覆盖**设置**那一个形状。**卡片**那个形状
//（`EntryView`）是另一份字段表，而它当时**一条判据都没有** —— 于是 2026-09-26
// 补进投影的 `scheduledAt` **从来没有被界面读过**，躺了三天：
//
// · 快照里字段一个不少（`model.rs` 那条测试还钉着它）；
// · 界面一个像素都不差、不报错、不崩 —— 因为**没人读它**这件事没有任何外部表现；
// · 唯一的表现是「功能缺了一块」：看不出这条定时消息**本来定在什么时候**。
//
// ⚠️★ 这是「加一个字段」这类改动最容易留下的洞，而且它**与第 8 条不是同一个地方**：
// 第 8 条的清单是从 `SettingsView` / `SettingsPatch` 数出来的，`EntryView` 压根不在里面。
// 「一个形状有判据」不等于「另一个形状也有」—— 判据的作用域同样要有东西守着。
//
// ⚠️ 所以它有**两半**，缺一不可：① 去 `rustSrcArg` 那几个目录里**找到**声明 `EntryView`
// 的那份文件（要**恰好一份**，找不到就报失败：0 个字段会让「每个字段都读了」**恒真**）；
// ② 一个字段一个字段地对着 `renderEntry` 的函数体找 `entry.<字段>`。
//
// # ⚠️ 第 9 条为什么算失败（页面不许拿到系统通知 / 全局快捷键的权限）
//
// 2026-09-27 加了系统通知（「本机剪贴板没发出去」「房间的内容写进剪贴板了」）。
// 那个插件**会给页面注入一段它自带的 JS**，所以「页面能不能发通知」只由一件事决定：
// `capabilities/default.json` 里给不给 `notification:*`。
//
// ⚠️★ 2026-09-28 加**全局快捷键**（`hotkeys.rs`）时，同一条道理再来一遍，而这次
// 顺手查出**这条判据原来只有一半**：它只按 `notification` 前缀过滤，
// 而 `hotkeys.rs` 的文件头当时就写着「判据 9 盯着这一个」—— **注释在骗人**。
// 现场验过：把 `global-shortcut:default` 加进能力文件，旧写法**照样全绿**。
// 现在两个前缀都管，那句注释才是真的。⚠️ 教训与「判据不能靠一个全局搜索」同源：
// **一条判据的「范围」本身要有东西守着** —— 否则它绿着，而你以为它盖住了整片。
//
// ⚠️★ 我们**决定不给**，而且这是一个**刻意的架构选择**，不是忘了配：
// 这个项目里页面与壳的分工是「页面只跟 IPC 命令说话」（`desktop-client.md` §2 的硬边界），
// 每给页面开一个插件的口子，那条边界就薄一分 —— 而**发系统通知**还给了一个
// 「页面能弹东西到用户桌面」的能力（一个页面 bug 就能变成通知轰炸），
// **抢全局快捷键**则更直接：页面里的脚本能占住 `⌘⇧V`（那是**系统级**的，
// 别的程序也受影响）。
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
// # ⚠️ 第 20 条为什么算失败（`hidden` 属性要真的能藏住）
//
// 2026-09-29 的真实 bug：内容区想在「手写时间线」与「嵌进来的 SPA」之间二选一
// （`.tl` 与 `iframe` 同一个位置、都 `flex: 1`），JS 那边是 `el('timeline').hidden = true` ——
// 结果**两个都摊开着、上下各占一半**。
//
// ⚠️★ 根因不是写错了属性，而是**属性管不了作者样式表**：`hidden` 只是浏览器自带那条
// `[hidden] { display: none }` 的开关，而**作者样式表的 `display` 赢过它** ——
// `.tl { … display: flex; … }` 一写，那个元素就再也藏不住了。
// 同类：`.view-switch`（`display: flex`）、`.overlay`（当年就是它，所以那时补了一条
// `.overlay[hidden] { display: none; }`）。
//
// ⚠️★ 这类错**三样都齐**：不报错、控制台干净、**静态自检也扫不到**（第 1 条判的是
// 「id 对得上」，看不见 CSS 与属性的这层交互）。所以只能在**这一侧**钉一条。
//
// ⚠️ 判法（收敛成两句，**不是**逐处去查「这个类有没有 display」——那样每加一个
// `display: flex` 的元素就静默复发）：
//   ① 样式表里必须有**恰好一条** `[hidden] { … display: none !important; }`；
//   ② 全表 `!important` **只许这一处** —— 多一处就可能盖掉它。
// ⚠️ 为什么非要 `!important`：靠**顺序**没用。`[hidden]` 与 `.tl` 的选择器权重相同
// （都是「一个类 / 一个属性选择器」），谁写在后面谁赢 —— 而 `.view-switch` 恰好就写在
// 那条基础规则**后面**。顺序一改就悄悄失效，`!important` 才与位置无关。
//
// ⚠️ 边界（这一条**管不到**的地方，别当成漏检）：
//   · 它只管「`hidden` 藏不藏得住」；**该藏谁**（哪个模式可见）是运行时的事，
//     由「真渲染一遍看计算样式」那种验法管（2026-09-29 就是这么验的）。
//   · `<style>` 之外的样式（行内 `style=`）不归它 —— 而 `!important` 也赢过行内，
//     所以真有人用行内 `display` 去藏东西，那是另一类问题（本仓库没有这种写法）。

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
// · 第 19 条**只看 `renderEntry` 的函数体**：字段在**函数体外**读也算没读。
//   ⚠️ 这是**故意偏严**的一侧：漏的那个方向是「红一次、看一眼就明白」，而放宽的方向是
//   「注释里写一句 `entry.x` 就满足了」—— 判据 8 就是那样栽的。
//   哪天真的有个字段只在函数体外用，**要么在卡片上也读它、要么把这里的边界写宽并说明**，
//   别默默加白名单（白名单里的字段从此没人看）。
// · **`boot.js` 不参与第 1 条**（id 引用）：它跑在 `<body>` 解析之前，本来就碰不到任何
//   元素 —— 里面出现一个 `getElementById('x')` 才是错的。它只被第 10 条读（比对常量）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// ⚠️ `-` → `undefined`：位置参数只有实参是 `undefined` 时才走默认值，
// 而变异验证常常只想换**其中一个**（写 8 个 `-` 比把前面 7 个路径全抄一遍清楚）。
const cliArgs = process.argv.slice(2).map((value) => (value === '-' ? undefined : value));
const [
  jsPath = join(root, 'rust/crates/desktop/ui/app.js'),
  htmlPath = join(root, 'rust/crates/desktop/ui/index.html'),
  rustPath = join(root, 'rust/crates/desktop/src/commands.rs'),
  capabilitiesPath = join(root, 'rust/crates/desktop/capabilities/default.json'),
  bootPath = join(root, 'rust/crates/desktop/ui/boot.js'),
  clientPath = join(root, 'rust/crates/client/src/config.rs'),
  i18nPath = join(root, 'rust/crates/desktop/ui/i18n.js'),
  /** ⚠️★ 判据 16 / 17 要扫的是**一整个目录**，不是一个文件（壳发出去的键散在
   * `desktop/src/*.rs` 与 `client/src/*.rs` 里）。`:` 分隔几个目录。
   * ⚠️ 为什么是这两颗 crate：它们是**桌面端会跑到**的那些句子（`desktop` 是壳本身，
   * `client` 是它下面那一层，两边的 `Msg` 都会变成界面上的话）。
   * `server` / `core` / `actions` / `store` **故意不在里面** —— 它们的中文是**服务端 API
   * 的报错文案**（与 Go 版逐字对齐，随 `{"error":…}` 出去），这一版不翻它们
   *（见 `dev-docs/specs/desktop-client.md` §8.10 的边界）。 */
  rustSrcArg = join(root, 'rust/crates/desktop/src') + ':' + join(root, 'rust/crates/client/src'),
  /** ⚠️ 判据 18：两份渲染器（壳 / 页面）共用的那份夹具。 */
  sayFixturePath = join(root, 'rust/crates/desktop/tests/fixtures/say-cases.json'),
] = cliArgs;

/** `:` 分隔的目录表 → 里面所有 `.rs` 的绝对路径（**排序**：报告要稳定，变异验证要能逐条对）。 */
function rustSources(spec) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.rs')) found.push(path);
    }
  };
  for (const dir of spec.split(':').filter(Boolean)) walk(dir);
  return found;
}

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
  // ⚠️★ `type="password"` **也算**：它平时是掩着的，但凭据那一格旁边有一个「看一眼」
  // （`cellSecret` 里的 👁）—— 按开之后它就是一个**普通文本框**，macOS 照样会
  // 把首字母大写。2026-09-29 加那个 👁 时补的：只数 `text` 的话，这一格是这条自检
  // **看不见**的一处，而它恰恰是「一个字符都不能差」的那一格。
  const typesText = !/\btype\s*=/i.test(tag)
    || /\btype\s*=\s*["']text["']/i.test(tag)
    || /\btype\s*=\s*["']password["']/i.test(tag);
  if (typesText && !/autocapitalize\s*=\s*["']off["']/i.test(tag)) autoCapMissing.push(tag.trim());
}

// ⚠️ JS 那侧用**计数**：`cellInput` / `cellSecret` 这类工厂每造一个文本框就该关一次
// 自动大写。不是逐个匹配（那是给文本做结构分析，假的精确），而是「造了几个、关了几个」
// 对不上就说话。
// ⚠️★ 字符类里那个 `(?:text|password)` 与上面 HTML 那侧的 `typesText` 是**同一条规则**：
// 改了这里要一起改（漏一边 = 那一半静默失效）。收窄成只数 `text` 的话，`cellSecret`
// 那一格就没人管了 —— 而它绿着，看起来一切正常。
const jsTextFields = (js.match(/\.type\s*=\s*['"](?:text|password)['"]/g) ?? []).length;
const jsNoAutoCap = (js.match(/\.setAttribute\(\s*['"]autocapitalize['"]\s*,\s*['"]off['"]\s*\)/g) ?? []).length;

if (autoCapMissing.length || jsTextFields !== jsNoAutoCap) {
  failed = true;
  console.error('✗ 有能打字的输入框没关掉「首字母自动大写」（macOS 会把地址打成 `Https://`）：');
  for (const tag of autoCapMissing) console.error(`    index.html: ${tag}`);
  if (jsTextFields !== jsNoAutoCap) {
    console.error(
      `    app.js: 造了 ${jsTextFields} 个文本输入框（含 password），只关了 ${jsNoAutoCap} 个的自动大写` +
        '（找 `cellInput` / `cellSecret` 那一类工厂）。',
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

// ③ 换房间要**立刻收起**上一条（2026-09-30，Jonny 报的「切到 B 还挂着 A 的」）。
// ⚠️★ 钉的是那一句的形状：`state.selected !== noticeRoom` 时调 `hideNotice()`。
//    拆掉它 = 提示又跨房间挂着，而界面看起来**完全正常** —— 只是主语错了
//（「已发出」挂在 B 的房间标题下面，读起来就是 B 发的事）。
if (!/state\.selected !== noticeRoom[^\n]*hideNotice\(\)/.test(js)) {
  failed = true;
  console.error('✗ 换房间那一拍不再收起提示了（`render` 里那句 `state.selected !== noticeRoom` → `hideNotice()`）：');
  console.error('    症状是 Jonny 2026-09-30 报的那条：切到 B 房间，上面还挂着 A 房间那条提示 ——');
  console.error('    提示归房间，而这一格长在那个房间的标题下面，挂着上一条读起来就是这个房间的事。');
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

/** 从一份 Rust 源码里取一个结构体的字段名（serde camelCase 之后的那一份）。
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
 *
 * ⚠️★ 参数是**源码**、不是文件名：判据 8 读 `commands.rs`、判据 19 读 `EntryView`
 * 所在的那一份（`model.rs`）—— 两个结构体不在同一个文件里。
 */
function structFields(source, name) {
  const pattern = new RegExp(
    `#\\[serde\\(rename_all = "camelCase"[^)]*\\)\\]((?:(?!\\n\\})[\\s\\S])*?)pub struct ${name} \\{([\\s\\S]*?)\\n\\}`,
  );
  const body = source.match(pattern);
  if (!body) return null;
  return [...body[2].matchAll(/^\s*pub (\w+):/gm)].map((match) => camelCase(match[1]));
}

const viewFields = structFields(rust, 'SettingsView');
const patchFields = structFields(rust, 'SettingsPatch');
/** 判据 8 / 19 的「读了没有」判在**去掉注释**之后的函数体上。
 *
 * ⚠️★ 这是 2026-09-28 补的，补掉的是判据 8 自己那段注释里的**半个谎**：
 * 它写着「判的是 `view.<字段>` 这个写法，不是『出现过这个名字』——后者会被注释满足」，
 * 但**注释里写全 `view.notifyUpload`** 照样满足它。也就是说那一半根本没关上。
 * `stripJs` 把注释整段丢掉（字符串字面量被包成 `\0…\0`），这一半才真的关上。
 *
 * ⚠️★ 所以**先按原名定位、再按去注释的内容判** —— 定位那两个正则**不能**吃 `stripJs`
 * 的输出：`el('settings-save')` 在那里会变成 `el(\0settings-save\0)`，正则当场找不到，
 * 症状是「这条自检跑不了」（红，但红错了地方）。剥注释与定位是两件事，别一起改。
 */
const stripComments = (slice) => stripJs(slice);
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
  console.error('  ⚠️ 快照里**每条条目的形状**（`EntryView`）是同一族的问题，由**判据 19** 管');
  console.error('    —— 它在文件末尾（编号顺序），别以为这里没写就没人管。');
} else {
  // ① 接住：`settings_view` 给的每个字段，`openSettings` 里都要读一次。
  //
  // ⚠️★ 判的是 **`view.<字段>`** 这个写法，不是「函数体里出现过这个名字」：
  // 后者会被**注释**满足。2026-09-28 现场验过：删掉读它的那一行、注释里留着
  // `view.xxx`，旧写法全绿 —— 也就是说「读过就算」是**没有牙**的。
  // ⚠️ 判据 15 是同一个病（「判据不能靠一个全局搜索」）；这里再加一层：
  // **连 `view.X` 写全的注释也不认**（`stripComments`，见它上面那段）。
  // ⚠️ 代价：读法必须是 `view.X`（解构 `const { X } = view` 会被误判）——
  // 这一侧每个字段都是 `view.X`，而「读法只有一种」本来就是想要的。
  const notRead = viewFields.filter((name) =>
    !stripComments(openSettingsBody[0]).includes(`view.${name}`)
  );

  // ② 发还：保存时每个字段都要发回去。
  const notSent = patchFields.filter((name) => !stripComments(saveBody[0]).includes(name));
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

// ── 判据 9：页面不许拿到**系统通知 / 全局快捷键**的权限（理由见文件头）────────
//
// ⚠️★ 2026-09-28 加全局快捷键时**发现这条原来漏了一半**：它只按 `notification`
// 前缀过滤，而 `hotkeys.rs` 的文件头当时就写着「判据 9 盯着这一个」——
// **注释在骗人**：把 `global-shortcut:default` 加进能力文件，旧写法**照样全绿**。
// 两个前缀都由这条管了之后，那句注释才是真的。
let capabilities = null;
let capabilitiesReadError = null;
try {
  capabilities = JSON.parse(readFileSync(capabilitiesPath, 'utf8'));
} catch (error) {
  capabilitiesReadError = error;
}
/** ⚠️★ 页面**一格都不该有**的插件权限。加新插件时要想清楚：
 * 它给页面的 JS API 一旦有权限，这个项目「页面只跟 IPC 命令说话」那条边界就薄一分。
 * ⚠️ 用**前缀**匹配（`notification:*` / `global-shortcut:*` / `notification:default` 都要拦）。 */
const PAGE_FORBIDDEN_PLUGIN_PREFIXES = ['notification', 'global-shortcut'];
if (capabilitiesReadError) {
  failed = true;
  console.error(`✗ 判据 9 跑不了：读不出能力文件（${capabilitiesPath}）：${capabilitiesReadError}`);
} else if (capabilities) {
  // ⚠️ 一条权限可以是字符串，也可以是 `{ identifier, allow }` —— 两种都要认。
  const granted = (capabilities.permissions ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry?.identifier ?? '')))
    .filter((identifier) =>
      PAGE_FORBIDDEN_PLUGIN_PREFIXES.some((prefix) => String(identifier).startsWith(prefix))
    );
  if (granted.length) {
    failed = true;
    console.error(`✗ 能力文件给页面放了不该给的插件权限：${granted.join('、')}`);
    console.error('  ⚠️ 系统通知只有 Rust 侧的 `notify::SystemNotifier` 该发，全局快捷键只有');
    console.error('    `hotkeys::apply` 该注册 —— 页面**不该**有这两个能力');
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

/** ⚠️★ **Rust 源码** → 「代码骨架」+「字符串字面量清单」。
 *
 * 判据 16 / 17 要知道「含汉字的字面量长在哪」与「`Msg::key("…")` 的实参是什么」，
 * 而这两件事都要求先分清**注释 / 字符串 / 代码**：这个仓库的注释里到处是中文，
 * 而且 `Msg::key("historyFailed")` 这种例子**就写在文档注释里** ——
 * 不剥的话一上来就是一堆假红（`stripJs` 的文件头记着 JS 那边同样的事）。
 *
 * ⚠️★ 不能复用 [`stripJs`]：Rust 的块注释**能嵌套**（一个块注释里面可以再开一个），
 * 还有原始字符串（`r"…"` / `r#"…"#`）与字符字面量（`'{'`）——
 * 拿 JS 那套扫 Rust，`r#"(?i)\bhttps?://…"#` 这种内置正则会当场把后面一大段吞掉
 *（吞掉的后果是**漏报**，不报错）。
 *
 * ⚠️★ 返回的是**骨架**：注释与字面量正文都换成空格，**换行保留、长度不变**。
 * 于是「这个字面量前面是什么」直接 `slice` 就能看，而 `{}` 计数也不会被
 * 模板里的 `{reason}` 干扰（`'{'` 这种字符字面量本来就不平衡，也会被剥掉）。
 * ⚠️ 引号本身**留着** —— 查找「这个位置是不是一个字符串」靠的就是引号的位置。
 */
function scanRust(source) {
  const blanked = source.split('');
  const literals = [];
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < to && k < blanked.length; k++) {
      if (source[k] !== '\n') blanked[k] = ' ';
    }
  };
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const to = end < 0 ? n : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '/' && next === '*') {
      // ⚠️ 嵌套：数到配对的那一层为止（`/* /* */ */` 是一个注释）
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (source[j] === '*' && source[j + 1] === '/') {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // 原始字符串：`r"…"` / `r#"…"#`（`#` 的个数要配对才收）
    const raw = /^r(#*)"/.exec(source.slice(i, i + 8));
    if (raw) {
      const hashes = raw[1];
      const bodyStart = i + raw[0].length;
      const close = source.indexOf('"' + hashes, bodyStart);
      const end = close < 0 ? n : close + 1 + hashes.length;
      literals.push({ start: i, end, body: source.slice(bodyStart, close < 0 ? n : close) });
      blank(bodyStart, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '"') break;
        j++;
      }
      literals.push({ start: i, end: j + 1, body: source.slice(i + 1, j) });
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    // 字符字面量（`'{'` / `'\n'` / `'\u{7f}'`）—— ⚠️ 与生命周期（`'a`）分得开：
    // 只认**三件套**那个形状（`'X'` 或 `'\x'`），配不上的当生命周期。
    // ⚠️ 漏判一个字符字面量无害：它里面放不下汉字，只可能让后面的 `{}` 计数偏一点。
    const chr = /^'(?:\\u\{[0-9a-fA-F]+\}|\\[\s\S]|[^'\\\n])'/.exec(source.slice(i, i + 14));
    if (chr) {
      blank(i + 1, i + chr[0].length - 1);
      i += chr[0].length;
      continue;
    }
    i++;
  }
  return { blanked: blanked.join(''), literals };
}

/** ⚠️ `#[cfg(test)] mod tests { … }` 盖住的范围（起止下标，左闭右开）。
 *
 * ⚠️★ 判据 16 / 17 **都必须跳过测试**，两边的理由不一样：
 *   · 16：测试里的中文是**断言消息**（`assert_eq!(a, b, "…")` —— 它恰恰应该写中文）；
 *   · 17：测试里的 `Msg::key("…")` 是**测试自己编的例子**（`Msg::key("x")`），
 *     要求字典里有它等于逼人编字典。
 * ⚠️ 只按行首找 `#[cfg(test)]` 不够：得从那个 `{` 数到配对的那个 `}`
 *（在**骨架**上数，所以字符串 / 注释里的括号不算）。
 */
function rustTestRanges(blanked) {
  const ranges = [];
  for (const match of blanked.matchAll(/#\[cfg\(test\)\]\s*mod\s+[A-Za-z_]\w*\s*\{/g)) {
    let depth = 0;
    let j = blanked.indexOf('{', match.index);
    for (; j < blanked.length; j++) {
      if (blanked[j] === '{') depth++;
      else if (blanked[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([match.index, j + 1]);
  }
  return ranges;
}

/** 「这个字面量长在哪个宏的参数里」—— 从**上一个语句边界**（`;` `{` `}`）截到它。
 *
 * ⚠️★ 为什么不能只看**那一行**：日志宏经常写成好几行
 *（`tracing::warn!(dropped = …, "有些历史条目读不进来，已跳过")` 里的中文落在**最后一行**），
 * 只看行会把这些日志误判成界面文案 —— 第一版就是这么错的。
 * ⚠️ 截到语句边界而不是「往前数 N 行」：N 是个魔法数，而边界是语法。
 */
function statementWindow(blanked, pos) {
  let from = pos;
  while (from > 0 && !';{}'.includes(blanked[from - 1])) from--;
  return blanked.slice(from, pos);
}


if (i18nSource) {
  // ⚠️ 字典是**跑一遍** `i18n.js` 拿到的，不是正则抠的：正则抠不出
  // 「少一个引号 / 两个语种键集合不一致」这些事，而它们都会让译文悄悄失效。
  // ⚠️ 给它两样假宿主：`window`（它把 `I18N` 挂在这上面）与 `document`
  //（`locale()` 读 `document.documentElement.dataset.locale`）—— 都是**判据 18** 要用的：
  // 那条判据要**在两种语种下**各渲染一遍夹具。⚠️ 这份文件在**加载时**不碰它们
  //（只在函数体里用），所以给个假的就够，不需要真 DOM。
  let dicts = null;
  let loadError = null;
  const win = {};
  const fakeDocument = { documentElement: { dataset: {}, lang: '' } };
  try {
    new Function('window', 'document', i18nSource)(win, fakeDocument);
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
      // ⚠️★ `console.*(…)` 的实参**不算**：那一行永远不上屏（打包后没有 devtools），
      // 它不是界面文案。⚠️ 与壳那一侧同一条规矩（判据 16 明写放行 `eprintln!` /
      // `tracing::warn!` 那种**中文日志**）—— 这里只认 `t()` 的话，等于逼日志写英文，
      // 而「界面文案必须能翻、日志不必」这条线两边就各划各的了。
      // ⚠️ 它**放不出真正的漏抽**：上不了屏的字符串不可能是「切语种时不变的那句话」。
      if (/console\.(?:log|info|warn|error|debug)\($/.test(before)) continue;
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
      console.error('  ⚠️ `console.*(…)` 的实参也不归这里管（日志不是界面文案 —— 判据 16 放行 Rust 日志是同一条）。');
    }
  }

  // ── 判据 16 / 17：**壳那一侧**（Rust）────────────────────────────────────
  //
  // ⚠️★ 这一段是上两段的**镜像**：判据 14 / 15 管**页面**（`ui/*.js` + `index.html`），
  //    这两条管**壳**。少了它们，「界面支持英文」只覆盖了一半 —— 而恰好是用户最常
  //    看到的那一半（连接状态、一次性提示、命令报错、托盘菜单、系统通知都从壳里出来）。
  //
  // ⚠️ 判据 16：壳里**不许再自己拼界面文案**（含汉字的字面量）。
  //    症状是「切了语言，壳递过来那几十句一个字都没变」—— 而且**不报错**：
  //    多语言之前它们就是 `String`（`rust/crates/client/src/msg.rs` 的文件头记着这件事）。
  //    ⚠️★ 放行**开发者面**的东西：日志宏 / 断言 / `panic!` / `expect(`。它们上不了屏，
  //    而且这个仓库的日志**就是中文**（改英文只是噪声）—— 页面那边同一条规矩
  //    （判据 15 放行 `console.*(…)` 的实参）。
  //    ⚠️ 剩下真的不该翻的（命令行文案、落盘的数据、`tauri::Error` 收 `String` 那种塞不进
  //    `Msg` 的地方）走**显式标记**：`// i18n-ok: 理由`。打了标记的**每次都会印出来**
  //    （不失败，但一直看得见）—— 静默的例外清单是会长大的。
  //
  // ⚠️ 判据 17：壳发出去的**每一个键**都得在字典里真的有。
  //    症状：屏幕上印出一个像变量的词（`serverStartTimeoutNoLog`）—— 连一级回落都没有，
  //    因为键打错字时源语言那条也查不到。⚠️ 它靠的是「壳里每个键都长成 `Msg::key("…")`」
  //    这个**形态**（`Msg` 上故意没有 `From<&str>`、`ShellText` 也没有收裸键的入口，
  //    两处都是为了让这条静态检查看得见）。拼出来的键（`Msg::key(some_var)`）它看不见 ——
  //    所以下面会把这种地方**数出来印一遍**（有它的那天要人工过一眼）。
  //
  // ⚠️ 范围（`rust/crates/desktop/src` + `rust/crates/client/src`，以及**为什么不含** server/core/…）
  //    写在文件头第 8 个参数那段注释里。
  const rustFiles = rustSources(rustSrcArg);
  if (!rustFiles.length) {
    failed = true;
    console.error('✗ 判据 16/17 跑不了：`' + rustSrcArg + '` 里一个 `.rs` 都没有 —— 这条自检要跟着仓库结构改。');
  } else {
    /** 开发者面的宏 —— ⚠️ 只看**语句窗口**里有没有它，不看那一行（日志宏常常分好几行写）。 */
    const LOG_MACRO =
      /(?:\b(?:eprintln|println|eprint|print|panic|unreachable|todo|unimplemented|assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne|dbg)\s*!|tracing::\w+\s*!|log::\w+\s*!|\.expect(?:_err)?\s*\()/;
    const I18N_OK = /\/\/ i18n-ok:/;
    const bareCjk = [];
    const markedCjk = [];
    const shellKeys = new Map(); // 键 -> 第一处「文件:行」
    const dynamicKeys = [];
    for (const file of rustFiles) {
      const source = readFileSync(file, 'utf8');
      const { blanked, literals } = scanRust(source);
      const tests = rustTestRanges(blanked);
      const inTest = (pos) => tests.some(([from, to]) => from <= pos && pos < to);
      const lines = source.split('\n');
      const lineAt = (pos) => source.slice(0, pos).split('\n').length;
      const literalAt = new Map(literals.map((lit) => [lit.start, lit]));
      // ⚠️ 仓库里的文件用相对路径报（好读），传进来的别的目录（变异验证）用绝对路径 ——
      // 一律按 `root` 截会截出一串没有开头的怪路径。
      const where = (pos) =>
        (file.startsWith(root) ? file.slice(root.length + 1) : file) + ':' + lineAt(pos);

      // 16：含汉字的字面量（**非测试**）
      for (const lit of literals) {
        if (inTest(lit.start) || !IDEOGRAPH.test(lit.body)) continue;
        if (LOG_MACRO.test(statementWindow(blanked, lit.start))) continue;
        // ⚠️ 字面量可能跨行（命令行那段用法就是）：把盖到的行 + 前一行整段取出来找标记
        const span = lines.slice(Math.max(0, lineAt(lit.start) - 2), lineAt(lit.end) + 1).join('\n');
        if (I18N_OK.test(span)) markedCjk.push([where(lit.start), lit.body]);
        else bareCjk.push([where(lit.start), lit.body]);
      }

      // 17：`Msg::key("…")` 的实参（**非测试**）
      for (const match of blanked.matchAll(/Msg::key\(\s*/g)) {
        const at = match.index + match[0].length;
        if (inTest(at)) continue;
        const lit = literalAt.get(at);
        // ⚠️ 拼出来的键（`Msg::key(name)`）这条看不见 —— 记下来，最后印一遍
        if (!lit) dynamicKeys.push(where(at));
        else if (!shellKeys.has(lit.body)) shellKeys.set(lit.body, where(at));
      }
    }

    if (bareCjk.length) {
      failed = true;
      console.error('✗ 判据 16：壳（Rust）里有 ' + bareCjk.length + ' 处**界面文案**没走 `Msg`'
        + '（切到别的语种时它们一个字都不会变）：');
      for (const [at, body] of bareCjk.slice(0, 15)) {
        console.error('    ' + at + '  ' + JSON.stringify(body.slice(0, 50)));
      }
      if (bareCjk.length > 15) console.error('    …还有 ' + (bareCjk.length - 15) + ' 处');
      console.error('  ⚠️ 修法：`Msg::key("…")` + 参数（`param` / `param_list` / `param_msg`），译文写进 `ui/i18n.js`。');
      console.error('  ⚠️ 日志 / 断言 / `panic!` / `expect(` **放行**（它们上不了屏）——判据 15 对 `console.*` 是同一条。');
      console.error('  ⚠️ 真的不该翻的（命令行文案、落盘的数据）→ **紧邻的那一行**写 `// i18n-ok: 理由`。');
    }
    if (markedCjk.length) {
      console.log('· 有 ' + markedCjk.length + ' 处中文串打了 `i18n-ok`（**不算失败**，只是每次印出来提醒）：');
      for (const [at, body] of markedCjk) {
        console.log('    ' + at + '  ' + JSON.stringify(body.slice(0, 50)));
      }
    }

    // ⚠️ 分类与判据 14 **同一条**：键里有汉字 ⇒ 「原文即键」，`zh` 那份不用自己再有一条。
    // ⚠️★ 按下标（键）归组再报：一个键在**两种语种**里都缺时，那**是同一个漏**——
    // 按 (键, 语种) 数出来的「2 个键」会让人以为有两处（变异验证时就看出来了）。
    const missingKeys = new Map(); // 键 -> { at, locales: [] }
    for (const [key, at] of shellKeys) {
      const lost = [];
      for (const locale of isSourceKey(key) ? ['en'] : ['zh', 'en']) {
        if (!(key in (dicts[locale] ?? {}))) lost.push(locale);
      }
      if (lost.length) missingKeys.set(key, { at, locales: lost });
    }
    if (missingKeys.size) {
      failed = true;
      console.error('✗ 判据 17：壳发出去的 ' + missingKeys.size + ' 个键在字典里没有（屏幕上会印出键本身）：');
      for (const [key, { at, locales }] of missingKeys) {
        console.error('    ' + key + '   （`' + locales.join('` / `') + '` 缺；' + at + ' 发出来的）');
      }
      console.error('  ⚠️ 症状：界面上顶着一句 `serverStartTimeoutNoLog` 这样的词 —— 难看，但正是要它难看。');
    } else {
      console.log('· 判据 17：壳发出去的 ' + shellKeys.size + ' 个键都在字典里（两种语种都有）。');
    }
    if (dynamicKeys.length) {
      console.warn('⚠ 有 ' + dynamicKeys.length + ' 处 `Msg::key(…)` 不是字面量（这条检查看不见它们），人工过一眼：');
      for (const at of dynamicKeys) console.warn('    ' + at);
    }

    // ── 判据 18：**同一份夹具**，两份渲染器逐字一致 ──────────────────────
    //
    // ⚠️★ 为什么要它：壳与页面**各有一份渲染器**（`ShellText::say` / `I18N.say`）——
    //    因为系统通知 / 托盘菜单 / 文件对话框是**操作系统画的**，页面碰不到它们。
    //    两份实现一定会漂，而症状是最坏的一类：「同一条通知，系统通知里是一个说法、
    //    切回界面看是另一个说法」，**没人会同时看两处**。
    //    ⚠️ 钉住它们的不是「两边代码看起来一样」，而是这份**输入输出表**
    //    （`rust/crates/desktop/tests/fixtures/say-cases.json`，Rust 那一半在
    //    `shell_text.rs` 的 `the_fixture_renders_the_same_on_this_side`）。
    //
    // ⚠️★ 顺序要紧：这一条会**就地换掉 `DICTS` 的内容**（见下），所以它必须排在
    //    判据 14 / 17 之后 —— 那两条要的是 `ui/i18n.js` 里**真的**那份字典。
    let fixture = null;
    try {
      fixture = JSON.parse(readFileSync(sayFixturePath, 'utf8'));
    } catch (error) {
      failed = true;
      console.error('✗ 判据 18 跑不了：读不了 / 解析不了 `sayFixturePath`（' + error.message + '）'
        + ' —— 那条路径来自文件头第 9 个参数。');
      console.error('    ' + sayFixturePath);
    }
    if (fixture) {
      // ⚠️ `say` / `t` 闭包引用的是**同一个对象**，所以只能就地换内容（换引用没用）。
      // 这么做是为了让两边吃**同一份字典**：壳测 A 字典、页面测 B 字典的话，
      // 「两份渲染器一致」这句话什么都证明不了。
      for (const key of Object.keys(win.I18N.DICTS)) delete win.I18N.DICTS[key];
      for (const [locale, table] of Object.entries(fixture.dicts ?? {})) win.I18N.DICTS[locale] = table;
      const drift = [];
      const locales = Object.keys(fixture.dicts ?? {});
      for (const testCase of fixture.cases ?? []) {
        for (const locale of locales) {
          const want = testCase.expect?.[locale];
          if (typeof want !== 'string') {
            failed = true;
            console.error('✗ 判据 18：夹具里用例「' + testCase.name + '」缺 `' + locale + '` 那一列期望值。');
            continue;
          }
          fakeDocument.documentElement.dataset.locale = locale;
          const got = win.I18N.say(testCase.msg);
          if (got !== want) drift.push([testCase.name, locale, got, want]);
        }
      }
      if (drift.length) {
        failed = true;
        console.error('✗ 判据 18：**页面这一侧的渲染器和夹具对不上**（漂了 ' + drift.length + ' 处）：');
        for (const [name, locale, got, want] of drift) {
          console.error('    用例「' + name + '」@' + locale);
          console.error('      页面渲染出：' + JSON.stringify(got));
          console.error('      夹具要求是：' + JSON.stringify(want));
        }
        console.error('  ⚠️ 修法：让 `ui/i18n.js` 的 `say` / `renderParam` / `fill` 与夹具一致 ——');
        console.error('     **不是**改夹具去迁就它（夹具是两份渲染器的**共同**约定）。');
      } else {
        const count = (fixture.cases ?? []).length * locales.length;
        console.log(`· 判据 18：${(fixture.cases ?? []).length} 条夹具用例 × ${locales.length} 种语种`
          + `（共 ${count} 次渲染）在**页面这一侧**逐字对上。`);
      }
    }
  }
}

// ── 判据 19：快照里每条条目的字段，卡片渲染都得读（理由见文件头）──────────────
//
// ⚠️★ 与判据 8 **同一族**（壳给出的字段 ↔ 界面接住），只是形状不同：
//    判据 8 管 `SettingsView`（一个**设置页**读一次），这条管 `EntryView`
//    （一条**卡片**的形状，`renderEntry` 读）。⚠️ 它只有「接住」那一半 ——
//    `EntryView` 是壳**下发**的，界面没有要发回去的东西。
//
// ⚠️★ 为什么非有它不可：`EntryView::scheduled_at` 是 **2026-09-26 补进 `/content` 投影的**，
//    而它**从来没有被界面读过**（`app.js` 里只有一句注释提到它）。没人看得出来 ——
//    快照里字段一个不少、界面一个像素不差、不报错。这正是「多一个字段」这类改动
//    最容易留下的洞，而它只在**功能缺了一块**的时候才显形（这里缺的是「看出这条定时消息
//    本来定在什么时候」）。⚠️ 2026-09-28 补上那次顺手加了这条判据。
const entryViewFiles = rustSources(rustSrcArg).filter((path) =>
  readFileSync(path, 'utf8').includes('pub struct EntryView')
);
if (entryViewFiles.length !== 1) {
  failed = true;
  console.error(`✗ 判据 19 跑不了：在 \`${rustSrcArg}\` 里找到 ${entryViewFiles.length} 份声明 \`EntryView\` 的文件`
    + '（要**恰好一份**）—— 这条自检要跟着仓库结构改。');
  console.error('  ⚠️★ 找不到就当成 0 个字段 → 「每个字段都读了」**恒真**，这条检查会悄悄失效。');
} else {
  const entryFields = structFields(readFileSync(entryViewFiles[0], 'utf8'), 'EntryView');
  /** ⚠️★ 判的是 **`renderEntry` 的函数体**（而且**去掉注释**之后的那一份，见 `stripComments`），
   * 不是全文 grep —— 判据 8 在这上面栽过：注释里写一句 `entry.text` 就能满足全文 grep
   *（这个文件里**真的有**那样一句注释），而「读法只有一种」（`entry.X`）本来就是想要的。 */
  const renderEntryBody = js.match(/function renderEntry\(entry\)\s*\{[\s\S]*?\n\}/);
  if (!entryFields || !renderEntryBody) {
    failed = true;
    console.error('✗ 判据 19 找不到要比对的东西 —— 这条自检要跟着代码改：');
    if (!entryFields) console.error('    · `EntryView` 上找不到带 camelCase 的字段（属性被删了？）');
    if (!renderEntryBody) console.error('    · `app.js` 里找不到 `function renderEntry(entry)`');
  } else {
    const notRead = entryFields.filter((name) =>
      !stripComments(renderEntryBody[0]).includes(`entry.${name}`)
    );
    if (notRead.length) {
      failed = true;
      console.error(`✗ 有 ${notRead.length} 个字段，壳在快照里发了、界面**没读**（那部分功能是缺的）：`);
      for (const name of notRead) console.error(`    ${name}`);
      console.error('  ⚠️ 症状：字段一直在快照里，界面上却一个像素都不差 —— 不报错、不崩，');
      console.error('    只是那一块功能**没有**（`scheduledAt` 就是这么躺了三天）。');
      console.error('    要么在 `renderEntry` 里用它，要么把它从 `EntryView` 上删掉 ——');
      console.error('    **别**在这里加白名单：白名单里的字段从此没人看。');
    } else {
      console.log(`· 判据 19：\`EntryView\` 的 ${entryFields.length} 个字段，卡片渲染都读了。`);
    }
  }
}

// ── 判据 20：`hidden` 属性要真的能藏住（理由见文件头）──────────────────────────
//
// ⚠️ 读的是 `styleText`（判据 13 那一段剥好注释的 `<style>`）—— 注释里写一句
// `[hidden] { display: none }` **不算**有这条规则（判据 8 就是被注释喂饱的）。
{
  /** 所有带 `!important` 的规则（选择器 + 声明）。 */
  const importantRules = [];
  for (const match of styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[2].includes('!important')) importantRules.push([match[1].trim(), match[2].replace(/\s+/g, ' ')]);
  }
  const base = importantRules.filter(([selector, decl]) =>
    selector === '[hidden]' && /display\s*:\s*none/.test(decl)
  );
  if (importantRules.length !== 1 || base.length !== 1) {
    failed = true;
    console.error(`✗ 判据 20：\`hidden\` 属性不一定藏得住 —— 样式表里带 \`!important\` 的规则有 ${importantRules.length} 条：`);
    for (const [selector, decl] of importantRules) console.error(`    ${selector} { ${decl} }`);
    console.error('  ⚠️★ 症状：`el(\'x\').hidden = true` **一点视觉效果都没有**（属性加上了、元素照样占位）——');
    console.error('    不报错、控制台干干净净，第 1 条那种「id 对得上」的检查也看不见。');
    console.error('    2026-09-29 的实际表现：「时间线和嵌进来的 SPA 上下对半平分内容区」。');
    console.error('  ⚠️ 要求**恰好一条**，而且长的就是这一条：`[hidden] { display: none !important; }`。');
    console.error('    别处不要用 `!important`（那会盖掉它），也别靠**顺序**去赢 —— 顺序一改就悄悄失效。');
  } else {
    console.log('· 判据 20：`hidden` 藏得住（全表唯一一处 `!important` 就是 `[hidden]` 那条）。');
  }
}

// ── 判据 21：网页视图跟着**当前房间的站点**，而且**先探测再嵌**（理由见文件头）─────
//
// ⚠️★ 它钉的是 2026-09-30 修掉的那条毛病，而那条毛病**修不修都一个样**：
//    改之前 `syncSpa` 用的是壳递来的**本机**地址，于是房间连的是别处的服务端
//    （Docker / VPS / Cloudflare）时，网页视图照样显示本机的内容 —— 不报错、控制台干净，
//    列表里那个房间的名字与条数**全是对的**，只有看见的那个网页不是那台的。
//    ⚠️ 另一半同样静默：探测命令没注册的话，那一格永远停在「正在检查这个站点…」——
//    没有超时、没有失败提示，用户只会以为「这个站点很慢」。
//
// ⚠️ 五条各自对应一个「拆掉就静默变坏」的零件，都是**一句话**的改动
//（把基址换回本机、删掉早退那行、删掉作废那行、少注册一条命令），
// 而后果都要用户报过来才知道。所以宁可写得碎一点、每条都点名。
{
  const mainPath = join(dirname(rustPath), 'main.rs');
  let mainSource = null;
  let mainError = null;
  try {
    mainSource = readFileSync(mainPath, 'utf8');
  } catch (error) {
    mainError = error;
  }

  if (mainSource === null) {
    failed = true;
    console.error(`✗ 判据 21 跑不了：读不出 ${mainPath}（${mainError.message}）`);
    console.error('  ⚠️ 读不到就看不出「探测命令没注册」—— 那正是「网页永远停在检查中」。');
  } else {
    // ⚠️ 先剥注释：`app.js` 与 `main.rs` 的注释里都**大量**提到这些名字
    //    （说明「以前是那样」），不剥的话删掉真正的代码也照样绿 —— 判据 8 就是这么栽的。
    const bareJs = stripComments(js);
    const bareMain = stripComments(mainSource);
    const syncSpaBody = bareJs.match(/function syncSpa\(state\)\s*\{[\s\S]*?\n\}/);
    const probeSiteBody = bareJs.match(/async function probeSite\(base\)\s*\{[\s\S]*?\n\}/);
    const applyProbeBody = bareJs.match(/function applyProbe\(base, view\)\s*\{[\s\S]*?\n\}/);
    const renderBlockedBody = bareJs.match(/function renderBlocked\(\)\s*\{[\s\S]*?\n\}/);

    if (!syncSpaBody || !probeSiteBody || !applyProbeBody || !renderBlockedBody) {
      failed = true;
      console.error('✗ 判据 21 找不到要比对的东西 —— 这条自检要跟着代码改：');
      if (!syncSpaBody) console.error('    · `app.js` 里找不到 `function syncSpa(state)`');
      if (!probeSiteBody) console.error('    · `app.js` 里找不到 `async function probeSite(base)`');
      if (!applyProbeBody) console.error('    · `app.js` 里找不到 `function applyProbe(base, view)`');
      if (!renderBlockedBody) console.error('    · `app.js` 里找不到 `function renderBlocked()`');
    } else {
      const sync = syncSpaBody[0];
      const probe = probeSiteBody[0];
      const applied = applyProbeBody[0];
      const blocked = renderBlockedBody[0];
      const problems = [];

      if (!sync.includes('siteBaseOf(')) {
        problems.push(
          '`syncSpa` 不再按**当前房间**算站点基址（`siteBaseOf(`）—— 那就会退回\n' +
            '    「网页视图永远嵌本机」那条老路，而界面上看不出来（房间名 / 条数都对）。',
        );
      }
      if (!sync.includes('probeSite(')) {
        problems.push('`syncSpa` 换站点时不再探测那台有没有网页版（`probeSite(`）。');
      }
      // ⚠️★ 下面两条要匹配**字符串字面量**，而 `stripJs` 把字面量换成了 `\0内容\0`
      //（见判据 15 那一段）—— 直接写 `'ready'` / `'spa_url'` 会**永远匹配不上**，
      // 而它报出来的却是一句很像真话的「少了这个零件」。
      // 2026-09-30 就是这么踩到的：`spaSite !== 'ready'` 明明在代码里，基线却报红。
      // 加上哨兵（`\u0000?` 允许它缺席，这样剥与不剥都能匹配）才是对的。
      if (!/spaSite\s*!==\s*\u0000?ready/.test(sync)) {
        problems.push(
          '`syncSpa` 少了「探测没通过就别往下」那条早退（`spaSite !== ready`）——\n' +
            '    后果是**先嵌上去再问**，用户会先看到那个陌生页面的首页。',
        );
      }
      if (!applied.includes('!== spaBase')) {
        // ⚠️★ 2026-09-30：这条判断原来在 `probeSite` 里，加探测缓存时挪进了 `applyProbe`
        //（缓存命中也走它）—— 于是判据当场红了。**它红得对**：那段保护换了个函数住，
        // 这里就得跟着换，否则下一次「顺手删掉一行」就真的没人看着了。
        problems.push(
          '`applyProbe` 少了「回来时用户已经切走 → 这次结果作废」（`!== spaBase`）——\n' +
            '    后果是网速慢一点就按**上一个**站点画那一格。',
        );
      }
      if (!probe.includes('probeCache.set(')) {
        problems.push(
          '`probeSite` 不再把结论写进 `probeCache` —— 缓存永远是空的，\n' +
            '    于是每次切房间都要重新探一遍（跨站点的那一趟串在 iframe 加载之前）。',
        );
      }
      if (!sync.includes('probeCache.get(')) {
        problems.push(
          '`syncSpa` 不再查 `probeCache` —— 探测那一趟白缓存了，\n' +
            '    「网页那一版里来回切房间」每次都还是要等一次 HTTP 往返。',
        );
      }
      if (/invoke\(\s*\u0000?spa_url/.test(bareJs)) {
        problems.push(
          '页面又在调 `spa_url` —— 那条命令已经删了（它只会算**本机**地址），\n' +
            '    重新调它只可能是回退到老路上，而且调用处只会 `catch` 到一个「命令不存在」。',
        );
      }
      if (!/commands::probe_site\b/.test(bareMain)) {
        problems.push(
          '`main.rs` 的 `generate_handler!` 里没有 `commands::probe_site` ——\n' +
            '    那一格会永远停在「正在检查这个站点…」，没有超时也没有失败提示。',
        );
      }
      // ⚠️★ 这条钉的是「别给人**错建议**」：`renderBlocked` 必须按原因决定要不要摆那句
      //    「把它更新到 clip9」和那颗「去 clip9 项目」的按钮。
      //    2026-09-30 的实际代价：地址写成 `Https://…`（大小写而已），界面却把人指去
      //    「查你的部署为什么没有网页版」—— 他真去查了，还来问了。
      if (!/\u0000?spaProbeNotClip9/.test(blocked)) {
        problems.push(
          '`renderBlocked` 不再按原因区分文案 —— 「把它更新到 clip9」与「去 clip9 项目」\n' +
            '    会对**所有**原因显示。地址打错 / 连不上时，那句话改变不了任何事，\n' +
            '    只会把用户指向一个没问题的部署。',
        );
      }

      if (problems.length) {
        failed = true;
        console.error(`✗ 判据 21：「网页视图跟着房间走、先探测再嵌」这条链上少了 ${problems.length} 个零件：`);
        for (const one of problems) console.error(`    · ${one}`);
        console.error('  ⚠️ 症状全都**不报错**：网页显示的是**另一个站点**的内容，永远停在检查中，');
        console.error('    或者给出了一个改变不了现状的建议。');
      } else {
        console.log('· 判据 21：网页视图按当前房间的站点走，先探测再嵌（带缓存），且按原因给对的话（9 个零件都在）。');
      }
    }
  }
}

// ── 判据 22：提示的等级三处逐字一致；且 `#notice` 只有一个所有者（理由见下）──────
//
// ⚠️★ 2026-09-30 加（「把提示收成一套」那一步）。它钉的是两件**拆掉就静默变坏**的事：
//
//   ① **等级这条接缝**：`NoticeLevel`（壳）→ `state.notice.level`（IPC）→ `#notice` 的
//      CSS 类名（页面）。三处**各写一份**，谁改了另一处都不会报错 —— 症状只是那条提示
//      掉回默认样式（分不清「做成了 / 被跳过 / 失败了」），而那正是当初留一个分类字段
//      要解决的事。做法同判据 18（两份渲染器读同一份夹具）：比的是**集合逐字一致**。
//   ② **所有者**：`#notice` 只许 `showNotice` 碰；「一条提示什么时候结束」只有两个事件
//      —— 计时器到点，或者新的一条顶上。⚠️ 别再从「快照里还有没有 notice」去收：
//      那一拍是 `clear_notice` 之后的下一拍，照着 `null` 抹就把刚显示的那条**一闪抹掉**
//      —— 上一版正是为它留了 `noticeVisible` 那个补丁（用户报过的「提示只闪一下」）。
//      补丁再出现的那天，那个 bug 就回来了，所以这里连那个名字一起钉。
{
  const storePath = join(dirname(rustPath), 'store.rs');
  let storeSource = null;
  let storeError = null;
  try {
    storeSource = readFileSync(storePath, 'utf8');
  } catch (error) {
    storeError = error;
  }

  if (storeSource === null) {
    failed = true;
    console.error(`✗ 判据 22 跑不了：读不出 ${storePath}（${storeError.message}）`);
    console.error('  ⚠️ 读不到就看不出等级这条接缝 —— 而它断了**不报错**，只是提示掉回默认样式。');
  } else {
    const problems = [];
    const bareStore = stripComments(storeSource);
    const bareJs = stripComments(js);

    // ① 壳那一侧：枚举体 + serde 的改名规则（改名规则不对 → 序列化出来的是 `Ok` 那样的大写）。
    const enumAt = bareStore.indexOf('enum NoticeLevel');
    const enumBody =
      enumAt < 0 ? null : /enum\s+NoticeLevel\s*\{([\s\S]*?)\n\}/.exec(bareStore.slice(enumAt));
    if (!enumBody) {
      problems.push('`store.rs` 里找不到 `enum NoticeLevel` —— 判据要跟着代码改（或者那个枚举被删了）');
    } else if (!/rename_all\s*=\s*"lowercase"/.test(bareStore.slice(Math.max(0, enumAt - 300), enumAt))) {
      problems.push(
        '`NoticeLevel` 上面没有 `#[serde(rename_all = "lowercase")]` —— 序列化出来会是 `Ok/Warn/Error`，' +
          '而 CSS 那几档是小写：接缝从这里断，页面上只是掉回默认样式',
      );
    }
    const variants = enumBody ? [...enumBody[1].matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*,/gm)].map((m) => m[1]) : [];
    if (enumBody && variants.length < 3) {
      problems.push(
        `只认出 ${variants.length} 个枚举变体（${variants.join('、') || '一个都没有'}）—— 读不懂就当红，别当绿`,
      );
    }
    const fromRust = new Set(variants.map((one) => one.toLowerCase()));

    // ② 样式表那一侧：`.notice.<名字>` 的类名。
    const fromCss = new Set([...html.matchAll(/\.notice\.([a-z0-9-]+)\s*\{/g)].map((m) => m[1]));
    if (!fromCss.size) problems.push('`index.html` 里一条 `.notice.<名字>` 规则都没有 —— 提示会没有颜色');

    // ③ 页面那一侧：`showNotice('…')` 传的那些字面量（传变量/字段的地方不在此列）。
    // ⚠️★ 哨兵 `\u0000` **必需**（不是可选）：非字面量的实参（`showNotice(state.notice.level…)`
    // 与函数定义里的形参那一行）也长得像 `showNotice(` 后面跟个名字 —— 可选哨兵会把它们
    // 当成等级报出来（2026-09-30 第一版就这么假红了两条）。
    const fromJs = new Set([...bareJs.matchAll(/showNotice\(\s*\u0000([a-z0-9-]+)\u0000/g)].map((m) => m[1]));

    // 三处逐字一致。⚠️ 只报**差集**，别只说一句「不一致」—— 差集才指得出该改哪一处。
    for (const one of fromRust) {
      if (!fromCss.has(one)) {
        problems.push(`壳会发出等级 \`${one}\`，而样式表里没有 \`.notice.${one}\`（那条提示掉回默认样式）`);
      }
    }
    for (const one of fromCss) {
      if (!fromRust.has(one)) {
        problems.push(`样式表有 \`.notice.${one}\`，而 \`NoticeLevel\` 发不出这个值（一条死样式，或者枚举改了名）`);
      }
    }
    for (const one of fromJs) {
      if (!fromRust.has(one)) {
        problems.push(
          `页面在 \`showNotice('${one}')\` 里用了这个等级，而壳/样式表里没有它（少一个字母就是这个症状，不报错）`,
        );
      }
    }

    // ④ 所有者：`#notice` 只被 `showNotice` 碰。
    const showNoticeBody = /function showNotice\(level, text\)\s*\{[\s\S]*?\n\}/.exec(bareJs);
    const hideNoticeBody = /function hideNotice\(\)\s*\{[\s\S]*?\n\}/.exec(bareJs);
    if (!showNoticeBody || !hideNoticeBody) {
      problems.push(
        '`app.js` 里找不到 `function showNotice(level, text)` / `function hideNotice()` —— 判据要跟着代码改',
      );
    } else {
      // ⚠️★ 恰好 **2** 处：显示（`showNotice`）与收起（`hideNotice`）各一处
      //（2026-09-30 加 `hideNotice` 时这条从 1 → 2）。别处再碰它 = 又冒出第三个所有者。
      const touches = [...bareJs.matchAll(/el\(\s*\u0000?notice\u0000?\s*\)/g)].length;
      if (touches !== 2) {
        problems.push(
          `\`el('notice')\` 在 app.js 里出现了 ${touches} 次 —— 只能有 2 次（showNotice 与 hideNotice 各 1）；` +
            '别处再碰它，就等于又冒出第三个所有者',
        );
      }
      // ⚠️★ 恰好 **3** 处赋值：显示、计时器收起、换房间收起。
      const assignments = [...bareJs.matchAll(/notice\.hidden\s*=/g)].length;
      if (assignments !== 3) {
        problems.push(
          `\`notice.hidden =\` 出现了 ${assignments} 次 —— 只能有 3 次（显示 / 计时器 / 换房间）；` +
            '多在那一处就是从别的地方收（照着快照的 `null` 收会把提示闪掉）',
        );
      }
      if (/\bnoticeVisible\b/.test(bareJs)) {
        problems.push('`noticeVisible` 又出现了 —— 那个补丁是「照快照收提示」留下的，它回来 = 提示又会一闪而过');
      }
    }

    // ③ 「只有日志」的失败必须**表态**（2026-09-30 加）。壳里每个 `eprintln!` 要么
    //    紧挨着一次 `notice*`（日志 + 提示两条路都给），要么带一行 `// log-only-ok: 理由`。
    //    ⚠️★ 症状：一句失败只进日志、界面上一个字都没有 —— 就是「点了没反应」那一类；
    //    2026-09-30 之前 `desktop/src` 有十几处是这样，而没有任何东西看着它们。
    //    ⚠️ 带标记的**每次都会印出来**（不失败，但一直看得见）—— 静默的例外清单是会长大的
    //    （与判据 16 的 `i18n-ok` 同一条道理）。
    //    ⚠️ 边界：只扫 `#[cfg(test)]` **之前**那半（测试里打印「跳过」是正常的），
    //    窗口取 ±3 行 —— 这个仓库的写法就是「日志那行、提示下一行」。
    {
      const files = rustSources(join(root, 'rust/crates/desktop/src'));
      if (!files.length) {
        problems.push('`rust/crates/desktop/src` 里一个 .rs 都没扫到 —— 这条判据要跟着仓库结构改');
      } else {
        const offenders = [];
        const marked = [];
        for (const path of files) {
          const rel = path.slice(root.length + 1);
          const raw = readFileSync(path, 'utf8');
          // ⚠️★ 在**骨架**上找 `eprintln!`：注释里到处在提它（说明「以前只进日志」），
          // 直接在原文里找会假红 —— 2026-09-30 的第一版就这么报了两条（`server_process.rs`）。
          // ⚠️ 而**标记**是注释，只在原文里有 → 窗口取原文那几行。
          // ⚠️ 测试段跳过（`rustTestRanges`，与判据 16/17 同一套）：那里打印「跳过：… 不在」是正常的。
          const { blanked } = scanRust(raw);
          const tests = rustTestRanges(blanked);
          const rawLines = raw.split('\n');
          const codeLines = blanked.split('\n');
          let lineStart = 0;
          for (let i = 0; i < codeLines.length; i += 1) {
            const at = lineStart;
            lineStart += codeLines[i].length + 1; // +1 = 那个 `\n`
            if (!codeLines[i].includes('eprintln!')) continue;
            if (tests.some(([from, to]) => at >= from && at < to)) continue;
            const window = rawLines.slice(Math.max(0, i - 3), i + 4).join('\n');
            if (window.includes('log-only-ok')) marked.push(`${rel}:${i + 1}`);
            else if (!/\.notice(_in)?\(/.test(window)) offenders.push(`${rel}:${i + 1}`);
          }
        }
        for (const one of offenders) {
          problems.push(
            `\`${one}\` 的 \`eprintln!\` 既没紧挨着一次提示、也没有 \`// log-only-ok:\` 标记 —— 那句失败用户在界面上看不到`,
          );
        }
        if (marked.length) {
          console.log(`· 判据 22 · 只进日志的例外（${marked.length} 处，不算失败，但每次印出来）：`);
          for (const one of marked) console.log(`    ${one}`);
        }
      }
    }

    if (problems.length) {
      failed = true;
      console.error(`✗ 判据 22：提示的等级 / 所有者这条链断了（${problems.length} 处）：`);
      for (const one of problems) console.error(`    · ${one}`);
      console.error('  ⚠️ 症状：提示掉回默认样式（分不出成功 / 失败 / 被跳过），或者只闪一下就没了。');
    } else {
      console.log(
        `· 判据 22：等级三处一致（壳 ${[...fromRust].join(' / ')}），且 \`#notice\` 只有一个所有者。`,
      );
    }
  }
}

// ── 判据 23：「连不上就别再去取历史」那条链（理由见下）────────────────────
//
// ⚠️★ 2026-09-30 加（Jonny 报的原话：「不管房间连不连得上，都会疯狂去获取历史消息，
//    然后疯狂提示每 5 秒获取历史消息」）。这条链上的零件**拆掉任何一个都不会报错**：
//   ① `store.rs` 记下「上一次取历史失败了」，而且**只说一次**（`note_history_failure`）；
//   ② `runtime.rs` 的**自动**那条路（`Ask::Auto`）据此**停下**（不打服务端、也不再提示）；
//   ③ `app.js` 的 `ensureHistory` 别再问、`nextDelay` 别再按 150ms 快轮询。
//    ⚠️★ 而**手动**那条路（切房间 / 改下载 = `Ask::ByUser`）**必须留着**：
//    那是用户的重试路径（空状态那句话就叫用户「点一下这个房间」）。
{
  const problems = [];
  const read1 = (name) => {
    const path = join(dirname(rustPath), name);
    try {
      return scanRust(readFileSync(path, 'utf8')).blanked;
    } catch {
      return null;
    }
  };
  const storeSrc = read1('store.rs');
  const runtimeSrc = read1('runtime.rs');
  const commandsSrc = read1('commands.rs');
  const bareApp = stripComments(js);

  if (!storeSrc || !runtimeSrc || !commandsSrc) {
    problems.push('读不到 `store.rs` / `runtime.rs` / `commands.rs` —— 判据要跟着仓库结构改');
  } else {
    // ① 记下来 + 只说一次（`first` 那个判断就是「只说一次」）。
    if (!storeSrc.includes('fn note_history_failure')) {
      problems.push('`store.rs` 里没有 `note_history_failure` —— 取历史的失败没地方记，自动重试就停不下来');
    } else if (!storeSrc.includes('let first = !inner.rooms[index].history_failed;')) {
      problems.push('`note_history_failure` 不再判断「是不是第一次」—— 每 5 秒一条提示那个毛病就回来了');
    }
    if (!storeSrc.includes('fn history_is_failed')) {
      problems.push('`store.rs` 里没有 `history_is_failed` —— 自动那条路没得问');
    }
    // ② 自动那条路真的会停下。
    if (!/ask == Ask::Auto\s*&&\s*self\.store\.history_is_failed\(/.test(runtimeSrc)) {
      problems.push(
        '`runtime.rs` 的 `refresh_history` 少了「自动那条路遇到失败过就返回」的闸' +
          '（`ask == Ask::Auto && self.store.history_is_failed(…)`）—— 连不上也会每 5 秒打一次服务端',
      );
    }
    // ③ 用户那条重试路径还在 —— ⚠️ 钉**`select` 的函数体**，不是「整个文件里有没有」：
    //    文件里还有第二处（`set_download`），只要那一处在，全文搜索就永远绿
    //（2026-09-30 的变异验证当场验到：删掉 `select` 里那行，全文搜索看不出来）。
    const selectBody = /pub fn select\([\s\S]*?\n\}/.exec(commandsSrc)?.[0] ?? '';
    if (!selectBody.includes('refresh_history(Ask::ByUser)')) {
      problems.push('`select` 里没有 `refresh_history(Ask::ByUser)` —— 用户切回房间时不会重试了');
    }
    // ④ 界面上别问、也别快轮询。
    if (!/function ensureHistory\(state\)\s*\{[\s\S]*?room\.historyFailed[\s\S]*?\n\}/.test(bareApp)) {
      problems.push('`ensureHistory` 不再看 `room.historyFailed` —— 界面又会每 5 秒问一次壳');
    }
    if (!/room\.historyLoaded\s*&&\s*!room\.historyFailed/.test(bareApp)) {
      problems.push('`nextDelay` 不再看 `room.historyFailed` —— 取不到历史的房间会一直按 150ms 快轮询');
    }
  }
  if (problems.length) {
    failed = true;
    console.error(`✗ 判据 23：「连不上就别再取历史」这条链断了（${problems.length} 处）：`);
    for (const one of problems) console.error(`    · ${one}`);
    console.error('  ⚠️ 症状：连不上的房间每 5 秒打一次服务端、每 5 秒弹一条「取历史失败」。');
  } else {
    console.log('· 判据 23：取历史失败会记下、自动重试会停、手动那条路还在（5 个零件都在）。');
  }
}

// ── 判据 24：默认视图是「列表」，而且选过的那个记得住（理由见下）──────────────
//
// ⚠️★ 2026-09-30 加。Jonny 报的原话：「桌面端为什么一直默认加载网页，即使改了列表，
//    重启又变成网页了？**默认就列表好了，然后记住用户的偏好**」。
//
// ⚠️★ 这不是「忘了加持久化」那么简单 —— 它是**实现违背了已经写下的设计决定**：
//    `dev-docs/specs/desktop-client.md` 的 §3.5.1 更正注记里写着「**别把它做成默认** ——
//    那等于把『桌面端』做成『带壳的浏览器』」，而 `app.js` 当时是 `let mainView = 'spa';`。
//    → 所以这条判据钉的不是「有没有那几行」，是**那个立场**。
//
// ⚠️ 拆掉任何一个零件**都不报错**，症状全是「重启之后才发现」：
//   ① 初值写死 `'spa'` → 默认又变网页（用户报的那个原样回来）；
//   ② 点击不走 `setMainView` → 点一下能换、重启变回去（「记不住」）；
//   ③ `setMainView` 不写存储 → 同上；
//   ④ 兜底不是「列表」而是「网页」→ 存储读不到（隐私模式）时去加载 iframe。
{
  const problems = [];
  const bareApp = stripComments(js);
  // ⚠️★ 哨兵还原**必须补回引号**：`stripJs` 写的是 `out += '\u0000' + body + '\u0000'`
  //    —— 它把 `'spa'` 变成 `\u0000spa\u0000`，**引号是吃掉的**（见它的实现）。
  //    所以 `split('\u0000').join('')` 得到的是 `=== spa`，拿 `'spa'` 去匹配**永远匹配不上**，
  //    而报出来的是一句很像真话的「少了这个零件」——判据 21 就是在这上面栽过一次。
  //    ⚠️ 这份界面通篇单引号，所以统一还原成单引号；哪天有人改用双引号，这条判据会红
  //    （那时把这里的 `'` 换成 `['"]?` 那种写法即可）。
  const code = bareApp.split('\u0000').join("'");

  // ① 初值必须**经过 `storedView()`**（写死一个字面量就是用户报的那个 bug）。
  const init = /\nlet mainView = ([^;]+);/.exec(code)?.[1] ?? '';
  if (!init.includes('storedView(')) {
    problems.push(
      `\`mainView\` 的初值不是从存储里读的（现在是 \`${init || '(找不到这一行)'}\`）——\n` +
        '    默认视图又变回写死的那个：用户改了、重启又回去。',
    );
  }
  // ② 兜底那一侧必须是「列表」：只认 `'spa'`，其余一律当列表。
  //    ⚠️ 与侧栏「只认 narrow」同一条理由 —— 兜底要落在**安全**的那一边，
  //    而这里的「安全」= 不去加载那个 iframe（它自己开 WebSocket，是第二个客户端）。
  if (!/getItem\(VIEW_KEY\) === 'spa' \? 'spa' : 'timeline'/.test(code)) {
    problems.push(
      '`storedView` 不再「只认 spa、其余一律当列表」——\n' +
        '    存储读不到（隐私模式 / 被策略挡）时会去加载那个 iframe。',
    );
  }
  // ③ 切换函数：写存储 + 立刻画。两个都少不得（少了前者＝记不住，少了后者＝点了没反应）。
  const setter = /function setMainView\(view\) \{[\s\S]*?\n\}/.exec(code)?.[0] ?? '';
  if (!setter) {
    problems.push('找不到 `function setMainView(view)` —— 这条判据要跟着代码改。');
  } else {
    if (!setter.includes('localStorage.setItem(VIEW_KEY, view)')) {
      problems.push('`setMainView` 没有写存储 —— 点一下能换、**重启就变回去**。');
    }
    if (!setter.includes('applyView()')) {
      problems.push('`setMainView` 没有调 `applyView()` —— 点了什么都不会发生。');
    }
  }
  // ④ 两颗按钮**都**走它。⚠️ 不钉的话「只给其中一颗接上」这种半吊子会全绿，
  //    而它的症状恰好是「网页记得住、列表记不住」（或者反过来）——
  //    用户只会说「有时候记得住有时候记不住」。
  //    ⚠️ 不用「整行一模一样」当判据（那样改个空格、换行就假红）；
  //    用**惰性区间**：从这颗按钮的监听器出发，160 个字符内要出现它该切的那一版。
  for (const [id, view] of [
    ['view-list', 'timeline'],
    ['view-web', 'spa'],
  ]) {
    const wired = new RegExp(`el\\('${id}'\\)[\\s\\S]{0,160}?setMainView\\('${view}'\\)`).test(code);
    if (!wired) {
      problems.push(
        `\`${id}\` 那颗按钮没有走 \`setMainView('${view}')\` ——\n` +
          '    它那一边的选择就记不住（症状是「另一版记得住、这一版记不住」），\n' +
          '    或者反过来（点列表却切到网页）。',
      );
    }
  }
  // ⑤ 默认值要和 **DOM 初值同向**：`#timeline` 不带 `hidden`、`#spa` 带 `hidden`。
  //    不同向的表现是「默认这一版**先空一帧**再跳」（时间线那一刻还是空的，看不出内容，
  //    但那正是主题闪白屏 / 侧栏先宽后窄那一族病）。
  if (!/<div class="tl" id="timeline"><\/div>/.test(html)) {
    problems.push('`index.html` 里 `#timeline` 的初值带上了 `hidden` —— 默认列表时会先空一帧。');
  }
  if (!/id="spa"[^>]*\shidden/.test(html)) {
    problems.push('`index.html` 里 `#spa` 的初值不再带 `hidden` —— 启动时会先露一下 iframe 那格。');
  }

  if (problems.length) {
    failed = true;
    console.error(`✗ 判据 24：「默认列表 + 记住偏好」这条链断了（${problems.length} 处）：`);
    for (const one of problems) console.error(`    · ${one}`);
    console.error('  ⚠️ 症状全是**重启之后才看得出来**的，而且不报错。');
  } else {
    console.log('· 判据 24：默认视图是列表、选过的那个记得住、两颗按钮都接上了（7 个零件都在）。');
  }
}

// ── 判据 25：输入框那个「/」菜单（理由见下）──────────────────────────────────
//
// ⚠️★ 2026-10-03 加。Jonny：「桌面端输入框要支持 `/` 快捷方式」。
//
// ⚠️★ 它的**判定**与网页版是同一份文件（`ui/slash-template.js`，由同步工具逐字节搬过来）。
//    这条判据钉的是**桌面这一侧**的接线 —— 而这里的每一个零件拆掉都**不报错**：
//   ① 没有样式 → 那排胶囊是裸的一竖列，看不出是个浮层（用户只说「弹出来的东西怪怪的」）；
//   ② 另写一份判定 → 与网页版漂开，症状是「这边弹、那边不弹」这种最难查的；
//   ③ 判定用活的 `event` 而不是快照 → 同一 tick 两个 input 事件会**叠出两个**菜单，
//      而 `closeSlashMenu` 只认最后一个，先前的成了孤儿（按 Escape 收不掉一半，实测到过）；
//   ④ `openSlashMenu` 没有并发守卫 → 同上（第三次改才对的那一个）；
//   ⑤ 藏输入区时不收 → 下次展开又冒出来一排胶囊（那时用户早忘了当初打了什么）；
//   ⑥ 胶囊上不拦 `mousedown` → 点它先让输入框失焦，插入位置就错。
//
// ⚠️ 判「用了快照」用**惰性区间**而不是整行相等（改个换行就假红没意义）。
{
  const problems = [];
  const bare = stripComments(js).split('\u0000').join("'");

  // ① 样式：`.slashmenu` 得有规则（少不了的那一层是「它浮在输入区上方」）。
  if (!/\.slashmenu\s*\{/.test(html)) {
    problems.push('index.html 里没有 `.slashmenu` 的规则 —— 那排胶囊是裸的，看不出是个浮层');
  }

  // ② 判定**来自共用文件**，不许另写一份。
  if (!/import\('\.\/slash-template\.js'\)/.test(js)) {
    problems.push('app.js 不再从 ./slash-template.js 取判定 —— 桌面端那份判定要漂');
  }
  for (const fn of [
    'slashMenuShouldOpen',
    'slashMenuShouldStay',
    'slashPendingAt',
    'stripTrailingSlash',
    'resolveSlashText',
  ]) {
    // ⚠️ 钉**定义**（`function X`），不是「出现过」—— 调用点当然要出现这些名字。
    if (new RegExp(`function\\s+${fn}\\b`).test(js)) {
      problems.push(`app.js 里自己定义了 \`${fn}\` —— 判定有了第二份，会与网页版漂开`);
    }
  }

  // ③ 两条入口都得用快照。⚠️ `keydown` 那条与 `input` 那条**分别**判：
  //    只改其中一条的症状是「硬件键盘弹得对、输入法上屏的那次叠两个」（反过来也一样），
  //    而用户只会说「有时候会多出一排」。
  // ⚠️★ 同一个事件上**不止一条**监听（`#input` 上本来就有 `keydown` / `input` 各一条干别的），
  //    所以取**全部**再判「其中一条用了快照」—— 写成「第一条」的话，
  //    这条判据盯的会是那一条无关的监听，永远绿（判据 8 就是这么栽的）。
  const listenerBodies = (kind) => [
    ...bare.matchAll(
      new RegExp(`el\\('input'\\)\\.addEventListener\\('${kind}'[\\s\\S]*?\\n\\}\\);`, 'g'),
    ),
  ].map((m) => m[0]);
  const keydowns = listenerBodies('keydown');
  const inputs = listenerBodies('input');
  // ⚠️★ 判的是「判定**吃的是快照**」，不是「文件里有 `slashSnapshot` 这几个字」：
  //    那几个字出现在 `const snap = slashSnapshot(event)` 那一行就够了，而真正会坏事的是
  //    `await` 之后那次调用又去读活的 `event.target.value` —— 变异验证里
  //    「留着快照、只把调用换回 event」这一组**绿着**，就是这么漏掉的。
  const usesSnap = (body, fn) => body.includes(`${fn}(snap`);
  if (!keydowns.length) {
    problems.push('找不到 #input 的 keydown 监听 —— 这条判据要跟着代码改');
  } else if (!keydowns.some((body) => body.includes('slashSnapshot(') && usesSnap(body, 'slashPendingAt'))) {
    problems.push('keydown 那条没把快照喂给 `slashPendingAt` —— await 之后读到的是新文本，会叠出两个菜单');
  }
  if (!inputs.length) {
    problems.push('找不到 #input 的 input 监听 —— 这条判据要跟着代码改');
  } else {
    const good = inputs.some(
      (body) =>
        body.includes('slashSnapshot(') &&
        usesSnap(body, 'slashMenuShouldOpen') &&
        usesSnap(body, 'slashMenuShouldStay'),
    );
    if (!good) {
      problems.push('input 那条没把快照喂给 `slashMenuShouldOpen` / `slashMenuShouldStay` —— 同上，「刚打了一个 /」会被算两次');
    }
  }

  // ④ 并发守卫：开菜单那一刻领号，await 回来时号不对就作废。
  const openBody = /function openSlashMenu\([\s\S]*?\n\}/.exec(bare)?.[0] ?? '';
  if (!openBody) {
    problems.push('找不到 `function openSlashMenu` —— 这条判据要跟着代码改');
    // ⚠️★ 判的是「await 回来时**作废旧的**」那一行，不是「函数里出现过 slashSeq」——
    //    领号那一行（`const seq = (slashSeq += 1)`）也带这个词，光看词是拦不住的
    //    （变异验证里「只删掉作废那一行」这一组绿着，就是这么漏掉的）。
  } else if (!/seq\s*!==\s*slashSeq/.test(openBody)) {
    problems.push(
      '`openSlashMenu` 没有「await 回来时号不对就作废」（`seq !== slashSeq`）——\n' +
        '        两次同时开会各挂一个面板，先挂的那个成了孤儿（按 Escape 收不掉）',
    );
  }

  // ⑤ 藏输入区那一处要收掉它（`setComposerHidden` 是隐藏的唯一入口）。
  const hideBody = /function setComposerHidden\(hidden\)[\s\S]*?\n\}/.exec(bare)?.[0] ?? '';
  if (!hideBody) problems.push('找不到 `function setComposerHidden` —— 这条判据要跟着代码改');
  else if (!hideBody.includes('closeSlashMenu')) {
    problems.push('`setComposerHidden` 没收那排胶囊 —— 藏掉再展开，它会又冒出来');
  }

  // ⑥ 胶囊上要拦 `mousedown`（点了不失焦 → 插入位置才对）。
  if (!/addEventListener\('mousedown'[\s\S]{0,120}?preventDefault\(\)/.test(bare)) {
    problems.push('那排胶囊没有拦 `mousedown` —— 点它会先让输入框失焦，插入的位置就错了');
  }

  if (problems.length) {
    failed = true;
    console.error(`✗ 判据 25：输入框的「/」菜单这条链断了（${problems.length} 处）：`);
    for (const one of problems) console.error(`    · ${one}`);
    console.error('  ⚠️ 症状全是「弹出来了但不对」，而且不报错。');
  } else {
    console.log('· 判据 25：「/」菜单用共用判定、两条入口都读快照、有并发守卫、藏输入区会收（7 个零件都在）。');
  }
}

// ── 判据 26：CSS 变量不许用没定义的（理由见下）────────────────────────────────
//
// ⚠️★ 2026-10-03 加。当天写动作结果那块样式时用了 `var(--input-bg)`，而它**没在
//    任何变量块里定义过** —— `background: var(--input-bg)` 整条失效（回退成透明），
//    **不报错**，要靠眼睛看出来。这类错的成本极低（写的时候顺手）、排查成本极高
//    （「为什么这段没有底色」），所以让机器数。
//
// ⚠️ 定义要**两处一起数**：`index.html` 的 `<style>` 与 `highlight.css`
//（两侧共用那份令牌配色，`code.hljs` 的 `--cb-*` 定义在那里）。
// 用途要**两处一起数**：样式表之外，`app.js` 也可能拼 `style="--x: …"`。
{
  const highlightPath = join(dirname(jsPath), 'highlight.css');
  const highlightCss = existsSync(highlightPath) ? readFileSync(highlightPath, 'utf8') : '';
  const allCss = `${html}\n${highlightCss}`;
  // 「定义」有三种，都要数：
  //   · CSS 里的声明（`--x: …`）；
  //   · `app.js` 运行时 `setProperty('--x', …)`（`--composer-h` 就是这样，拖拽调输入区高度）；
  //   · 用的时候带了回落（`var(--x, auto)`）—— 那是**设计好的**缺省，不是漏。
  const defined = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of js.matchAll(/setProperty\(\s*'(--[\w-]+)'/g)) defined.add(m[1]);
  const used = new Map(); // 名字 → 有没有带回落
  for (const source of [html, js, highlightCss]) {
    for (const m of source.matchAll(/var\((--[\w-]+)(\s*,[^)]*)?\)/g)) {
      used.set(m[1], (used.get(m[1]) ?? false) || Boolean(m[2]));
    }
  }
  const missing = [...used].filter(([name, hasFallback]) => !defined.has(name) && !hasFallback);
  if (missing.length) {
    failed = true;
    console.error(`✗ 判据 26：${missing.length} 个 CSS 变量**用了但没定义、也没回落**（整条声明失效，回退成透明，不报错）：`);
    for (const [name] of missing) console.error(`    ${name}`);
    console.error('  ⚠️ 定义在 `:root` / `[data-theme]` 的变量块里；`--cb-*` 那组在 highlight.css；');
    console.error('     运行时给的那种（setProperty）也行，但必须真的有人 set。');
  } else {
    console.log(`· 判据 26：用到的 ${used.size} 个 CSS 变量全都有定义（声明 / setProperty / 回落，三样算一样）。`);
  }
}

// ── 判据 27：桌面端跑「原本只有网页能跑」的那几条（理由见下）─────────────────
//
// ⚠️★ 2026-10-03 加。markdown / 代码高亮 / 查找替换 / 拼音从「置灰」变成能跑：
//    实现打进了 `actions-impl.js`（esbuild 产物），参数照目录画一张表。
//    这条钉的是**桌面这一侧的接线**，每个零件拆掉都不报错：
//   ① 参数写死某条动作的 id → 目录里再加带参数的动作，桌面就又回到「置灰」；
//   ② `visibleWhen` 不跟着目录走 → 「查找」在 digits 模式下还杵在那（填了也没用）；
//   ③ html 结果走 `textContent` → 用户看到一整屏 `<p>` 标签；
//   ④ html 不消毒就上 innerHTML → 别人剪贴板里的一条 `<script>` 就能在桌面上跑；
//   ⑤ 不补上色 → 「代码高亮」这条动作名存实亡（只有类名没有颜色）；
//   ⑥ `availability` 又把「带参数」当成「跑不了」→ 那张表永远开不出来。
{
  const libPath = join(dirname(jsPath), 'action-library.js');
  const lib = existsSync(libPath) ? readFileSync(libPath, 'utf8') : '';
  // ⚠️★ 一律在**剥掉注释**的源上判：渲染段 / 表单段的注释里就写着 `innerHTML` /
  // `textContent` 这些词 —— 拿原文判，「把 innerHTML 改成 textContent」这种变异照样绿
  //（变异验证里④、④b两组就是这么漏掉的）。
  const bareJs = stripComments(js).split('\u0000').join("'");
  const bareLib = stripComments(lib).split('\u0000').join("'");
  const problems = [];

  // ① 参数表**照目录画**：字段循环与可见性循环都要从 `action.params` 走（两处，缺一不可）。
  const formBody = /function openActionForm\([\s\S]*?\n\}/.exec(bareJs)?.[0] ?? '';
  const paramLoops = (formBody.match(/for \(const spec of action\.params\) \{/g) || []).length;
  if (!formBody) {
    problems.push('找不到 `function openActionForm` —— 参数表没了，带参数的动作点了没反应');
  } else {
    if (paramLoops < 2) {
      problems.push(`参数表没有照 \`action.params\` 画（两处循环只找到 ${paramLoops} 处）`
        + ' —— 建字段 / 算可见性都得来自目录，目录里加一条带参数的动作桌面才跟得上');
    }
    if (!formBody.includes('if (!spec.visibleWhen) continue;')) {
      problems.push('参数表没有按 `visibleWhen` 跳过 —— 「查找」在非文本模式下还杵在那（填了也没用）');
    }
    if (!formBody.includes('visibleWhen.equals')) {
      problems.push('参数表没有用 `visibleWhen.equals` 比较 —— 条件形同虚设');
    }
    if (/text\.replace/.test(formBody)) {
      problems.push('参数表里写死了 `text.replace` —— 字段的形状只有目录一处知道，这里别再抄一遍');
    }
    if (!formBody.includes('settle')) {
      problems.push('参数表没有把结果交给 `settle` —— 表填完了也没法把参数递给动作');
    }
  }

  // ② 带参数**不算跑不了**：`availability` 里不许再拿 params 挡（旧规则的回归点）。
  const availBody = /function availability\(action\)\s*\{[\s\S]*?\n  \}/.exec(bareLib)?.[0] ?? '';
  if (!availBody) {
    problems.push('action-library.js 里找不到 `function availability` —— 可用性判定没了');
  } else if (/params/.test(availBody)) {
    problems.push('`availability` 还在拿 params 挡 —— 桌面端现在有参数表了，带参数的动作不该置灰');
  }

  // ③④ html 结果：`viewed.html` 为真才走 `innerHTML`，且旁边得有 `textContent` 兜底；
  //     上色那一步必须在（没有它「代码高亮」只剩类名）。
  const renderBody = /const viewed = actionViews\.get\(entry\.id\);[\s\S]*?card\.append\(box\);/.exec(bareJs)?.[0] ?? '';
  if (!renderBody) {
    problems.push('找不到动作结果的渲染段 —— 这条判据要跟着代码改');
  } else {
    if (!renderBody.includes('viewed.html')) {
      problems.push('渲染段没认 `viewed.html` —— markdown / 代码高亮的结果会被画成一整屏 `<p>` 标签');
    }
    // ⚠️★ 画的是 `viewed.htmlText`，**不是** `viewed.output`：双表示那条（注音制表）的
    // output 是复制用的纯文本，HTML 在另一份里。拿 output 去 innerHTML 的症状最像
    // 「功能就是坏的」 —— 表格不出，只出一行 tab（2026-10-03 修的就是这个）。
    if (!renderBody.includes('box.innerHTML = viewed.htmlText')) {
      problems.push('html 结果画的是 `viewed.output` 而不是 `viewed.htmlText`'
        + ' —— 注音制表会只剩一行 tab 文本（双表示的 HTML 在另一份里）');
    }
    if (!renderBody.includes('box.innerHTML')) {
      problems.push('html 结果没有走 `box.innerHTML` —— 那用户看到的就是标签本身');
    }
    if (!renderBody.includes('box.textContent')) {
      problems.push('渲染段没有 `box.textContent` 兜底 —— 纯文本动作的结果也会被当成 HTML 解析');
    }
    if (!renderBody.includes('highlightIn')) {
      problems.push('html 画完没有调 `highlightIn` —— 代码块只有 `language-x` 类名、没有颜色');
    }
  }

  // ⑤ `highlightIn` 必须到实现包里取（两侧共用同一个 `highlightCodeBlocksIn`）。
  if (!/highlightCodeBlocksIn/.test(bareLib)) {
    problems.push('action-library.js 没有调实现包的 `highlightCodeBlocksIn` —— 桌面上色就是抄了第二份');
  }

  // ⑥ 动作跑的时候要把 params 递到第三位（`run(action, text, params)`）。
  const runBody = /async function run\(action, text, params\)\s*\{[\s\S]*?\n  \}/.exec(bareLib)?.[0] ?? '';
  if (!runBody) {
    problems.push('action-library.js 的 `run` 不再收 `params` —— 替换那条跑起来全是默认值');
  } else if (!/, params\)/.test(runBody)) {
    problems.push('`run` 收了 `params` 却没递给实现 —— 表填了个寂寞');
  }

  // ⑥b ⚠️★ `run` 必须走 **pure.js 那份 `actionOutput`** 拆双表示 —— 不许再 `String(raw)`：
  //      那样拿不到 `html`，注音制表就只剩纯文本（而动作**不报错**）。
  if (runBody && !runBody.includes('actionOutput(')) {
    problems.push('`run` 没有用 `actionOutput` 拆双表示 —— 注音制表的 `<table>` 拿不到，'
      + '而且 `String({html,text})` 就是 `[object Object]`（2026-10-03 报的那一个）');
  }
  if (runBody && !/return\s+pure\.actionOutput\(raw\)/.test(runBody)) {
    problems.push('`run` 的返回值不是 `pure.actionOutput(raw)` —— 网页 `runChain` 用同一个函数，'
      + '这里另写一份就会两边各说一套（「哪些形态合法」只有一处答案）');
  }

  // ⑥c `runAction` 要把「画的那一份」单独存成 `htmlText`，并用它判空。
  const runActionBody = /async function runAction\(entry, action, library, params\)\s*\{[\s\S]*?\n\}/.exec(bareJs)?.[0] ?? '';
  if (!runActionBody) {
    problems.push('找不到 `runAction` —— 这条判据要跟着代码改');
  } else {
    if (!runActionBody.includes('htmlText')) {
      problems.push('`runAction` 没有存 `htmlText` —— html 那一版丢了，画出来的是复制用的纯文本');
    }
    if (!/\bhtml\b/.test(runActionBody) || !/render === 'html'/.test(runActionBody)) {
      problems.push('`runAction` 没有合并「目录声明的 render」与「返回值自带的 html」两个来源'
        + ' —— 少一个就有一条动作被画成一屏标签');
    }
  }

  // ⑦ 样式：那张表浮着，字段行 / 按钮排都得有规则。
  //    ⚠️ 判**规则本身**（`.field {`），不判前缀：`.field-k` / `.field-v` 的规则还在
  //    也会让 `includes('.actform .field')` 绿着 —— 那是判了个寂寞。
  for (const rule of [/\.actform \.field\s*\{/, /\.actform-ft\s*\{/]) {
    if (!rule.test(html)) problems.push(`index.html 里没有 \`${rule}\` 的规则 —— 参数表是裸的`);
  }
  // ⑧ 「要先填参数」那句文案不许回来（它说的「还没做参数表单」已经不成立了）。
  if (i18nSource.includes('这条要先填参数')) {
    problems.push('i18n.js 里还有「这条要先填参数」—— 参数表已经做了，这句是旧的');
  }

  if (problems.length) {
    failed = true;
    console.error(`✗ 判据 27：桌面端跑「原本网页专属」那几条的接线断了（${problems.length} 处）：`);
    for (const one of problems) console.error(`    · ${one}`);
    console.error('  ⚠️ 症状全是「能点但跑出来不对」，而且不报错。');
  } else {
    console.log('· 判据 27：参数表照目录画（visibleWhen 在内）、html 结果走 innerHTML + 补上色、带参数不再置灰（8 个零件都在）。');
  }
}

// ── 判据 30：发送框那一行要把**两个**上限都说出来，而且用同一句话（理由见下）─────
//
// ⚠️★ 2026-10-03 加。字节的那个数一直都在（`0 / 4096`），文件的只在「设置 → 下载」
// 那一段出现过 —— 而真正要发文件的时刻就在这一屏。要拖一个 300MB 的文件进来，
// 得先猜服务端收不收，猜错了才在别处看到那个数。
//
// 另一件事是**一句话**：发送框与设置页各写一份的话，「这一屏说 256 MB、那一屏说还不知道」
// 就是迟早的事（`0` 有两种含义 —— 服务端说 0 = 不限、还没连上也是 0 —— 这个坑只能填一次）。
{
  const bareJs = stripComments(js).split('\u0000').join("'");
  const problems = [];

  if (!html.includes('id="limits-file"')) {
    problems.push('index.html 里没有 #limits-file —— 发送框只有字节数，文件上限还是得去别处找');
  }
  const fn = /function fileLimitText\(\)\s*\{[\s\S]*?\n\}/.exec(bareJs)?.[0] ?? '';
  if (!fn) {
    problems.push('找不到 `fileLimitText` —— 那句话要么没了、要么又写回了两个调用点里');
  } else {
    // ⚠️★ `0` 的两种含义必须在**这一处**分开：只判 `fileLimit` 真假的话，
    // 「服务端说 0 = 不限」会被说成「还没连上」（发出去被拒了才知道那条界没问到）。
    if (!/kind === 'on' \|\| kind === 'warn'/.test(fn)) {
      problems.push('`fileLimitText` 没有用房间的连接状态分「不限」与「还不知道」'
        + ' —— 服务端设 0（不限）会被说成「还没连上」，明明连着却说不清');
    }
    if (!/lastLimits\.fileLimit > 0/.test(fn)) {
      problems.push('`fileLimitText` 没有判 `fileLimit > 0` —— 上限值画不出来');
    }
  }
  // 两个调用点都要在（少一个就是「各写一份」或者「有一屏不显示」）。
  for (const [where, what] of [
    [/function updateCounter\(\)\s*\{[\s\S]*?\n\}/, '发送框那一行'],
    [/el\('sc-file-hint'\)\.textContent = fileLimitText\(\)/, '设置页下载那段'],
  ]) {
    const body = typeof where === 'string' ? (bareJs.includes(where) ? where : '') : (where.exec(bareJs)?.[0] ?? '');
    if (!body || !(body.includes ? body.includes('fileLimitText()') : true)) {
      problems.push(`${what}没有用 \`fileLimitText()\` —— 那句话就有了第二份定义`);
    }
  }

  if (problems.length) {
    failed = true;
    console.error(`✗ 判据 30：发送框的文件上限接线断了（${problems.length} 处）：`);
    for (const one of problems) console.error(`    · ${one}`);
  } else {
    console.log('· 判据 30：发送框与设置页共用一句 `fileLimitText`（0 = 不限 与 还没连上 分得开）。');
  }
}

if (cssOnly.length) {
  console.log(`· ${cssOnly.length} 个 id 只被选择器用（形如 #id { … }），正常：${cssOnly.join('、')}`);
}if (dynamicPrefixes.size) {
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
