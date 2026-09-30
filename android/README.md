# clip9 的 Android 外壳

这个目录**不是**一个完整的界面实现，它是「一个原生管理页 + 一个 WebView」的壳：

- `MainActivity` —— **原生**管理页（**方案 B**：顶部状态条 + 「连接 / 配置 / 其它」三页）。
  起停服务端、显示局域网地址与二维码、把 `config.json` 画成表单、管理可保存多台的远端服务器、
  电池优化白名单、WebView 版本提示。
- `WebAppActivity` —— **一个全屏 WebView**，加载服务端下发的界面（看板 / 分享页）。
  打开清单里某一台之前，它会**先用保存的密码换一张会话令牌**（「免打开界面认证」，见 §一之四）。
- `ServerService` —— 前台服务。它让服务端在 App 退到后台之后继续活着，并且**是唯一起停服务端的地方**。

⚠️★ 看板**不**是原生写的：`web-vue3` 那一份产物由服务端下发，Android 只是把它显示出来。
设计稿与取舍在 `docs/specs/android-client.md`（⚠️ `docs/` **不进仓库**，交接要单独把文件给人）。

---

## 一、三层契约：改一处要改五处

下面三件事必须同时一致，**对不上的症状只有 `UnsatisfiedLinkError`**，
而它**不会告诉你**是哪一处不对：

| # | 在哪 | 是什么 |
|---|---|---|
| 1 | `rust/crates/android/src/lib.rs` | JNI 符号名 `Java_com_clip9_app_ServerBridge_native*`（逐字写死） |
| 2 | `app/src/main/java/com/clip9/app/ServerBridge.kt` | `object ServerBridge` 的包名 + 类名 + 方法名 |
| 3 | 同上 | `System.loadLibrary("clip9_android")` ↔ `rust/crates/android/Cargo.toml` 的 `[lib] name`（产物 `libclip9_android.so`） |

另外两处**不在代码里、所以最容易忘**：

- `app/src/main/jniLibs/<abi>/libclip9_android.so` 真的在（⚠️ 忘了**没有任何提示**：
  编得过、装得上、一调就炸）。用 `tools/sync-android-jni-libs.mjs` 搬，`--check` 能提前问一句。
- `app/proguard-rules.pro` 里的 `-keep`：release 开了 R8，**类名一改短第 1 条就废了**。

⚠️ 上面这五处现在**逐条有判据**：`node tools/android-contract-smoke.mjs`（已接进 CI 的
frontend job）。它管六组：

- 「ABI 名单在三处是否一致」+「库名 / JNI 符号名在六处是否一致」；
- 「`jniLibs/<abi>/` 真的有占位」「构建产物路径（`app/build`、`build`、`.gradle`、`.kotlin`、
  `local.properties`）**逐条**真的被 `android/.gitignore` 忽略了」「`.kt` 的块注释闭不闭合」；
- **契约 C**：`ConfigPage.kt` 那张「控件 ↔ JSON 字段名」表 ↔ `clip9-core` 的 `Config`
  （**双向**：写错的路径要红，`config.rs` 里新加的字段没人管也要红）；
- **契约 D / E**：资源引用是否存在（`R.id` / `R.string` / `R.color` / `@string` / `@color`）
  与跨端桥名（§一之四）；
- **契约 F**：布局里不许有「`wrap_content` 容器里撑满父向的裸 `<View>`」—— 裸 View 没有
  内容高宽，`AT_MOST` 之下会被量成**整屏高**（2026-09-29 一根 1dp 的分隔线就这样把
  整个管理页撑没了：面板 827dp、`ScrollView` 0 高，页签与三页内容全消失且不报错）。
  分隔线这类东西用稿子的 gap 做法（相邻格 margin 露出容器底色）。
- **契约 G**：全屏覆盖子页（`layout_height="match_parent"`、id 以 `Page` 结尾）必须是**根
  `FrameLayout` 的直接子**。`match_parent` 高只在 FrameLayout 里等于「铺满窗口」，塞进 vertical
  `LinearLayout` 就变成「父的整高」并被排到前面兄弟之后 —— 前面若有 `0dp + weight=1` 的
  兄弟，子页会被推到**屏幕外**，而它内部那个 ScrollView 自认为有整屏高 → **怎么划都不动**
  （2026-09-30：「远端服务器添加页面划不动」就是这个，层错了而症状在滚动上）。

⚠️ 变异验证分三份台本（都在 `/tmp`，仓库文件一行不碰；夹具是那边一个真的 git 仓库）：

| 台本 | 组数 | 它改坏什么 |
|---|---|---|
| `clip9-android-smoke-mutate.cjs` | 5 | 契约 C 的路径写错 / `config.rs` 加字段 / 文案改名 / 桥名改名 + 一组对照 |
| `clip9-cfg-mutate.cjs` | 6 | `validate_for_save` 的三道闸 + `config_file` 的读写 + 一组对照 |
| `kt-mutate.mjs` | 5 | 块注释的三种坏法 + 两组反向（字符串 / 行注释里出现结束符**不该**红） |
| `clip9-android-mutate-f.mjs` | 4 | 契约 F：把那根坏 View 原样造回来（要只红它）+ margin 改 2dp 的对照组 + 基线/还原 |

⚠️ 前两份都断言「**红的集合正好等于预期集合**」，不是「至少包含」——
多红一条说明这一处改动破坏的不止一条判据，那本身就是一条要看的信号。
⚠️ 本脚本还支持 `--root <别的仓库根>` —— 那是给变异验证用的。

⚠️ 它**抓不到**下面那段说的那件事（`JObject` vs `JClass`）—— 两种在 ABI 上都是指针、
都不会崩，静态也看不出「该用哪个」。那条**仍然只能靠注释**。

> ⚠️ 还有一条**只能靠注释**记着的：Kotlin 那边是 `object ServerBridge { external fun … }`，
> 也就是**实例方法** —— 所以 Rust 侧第二个参数收的是 `JObject`（`jobject`）而不是 `JClass`（`jclass`）。
> 改成 `companion object` + `@JvmStatic` 会静默变成静态方法。**两种在 ABI 上都是指针、都不会崩，
> 没有任何测试能发现这件事。**

---

## 一之二、第二份契约：分享桥（`window.clip9Share`）

「分享 → clip9」是**外壳与页面之间**的另一条契约，两侧**都没有测试运行器**
（`web-vue3` 是手写前端；这边连编译器都没跑过）。连接全是**按字面量**做的：

| 什么 | 在哪 | 对不上的症状 |
|---|---|---|
| 三个方法名 `isReady` / `sendText` / `sendFiles` | `web-vue3/src/share.js` ↔ `WebAppActivity.kt` 里那两个注入的 JS 串 | 注入过去是 `undefined is not a function`，**WebView 会把它吞掉** = 什么都没发生 |
| `reason` 键（`not-ready` / `no-room` / `empty` / `files-unsupported` / `server-error`） | `share.js` 的 `SHARE_REASONS` ↔ `WebAppActivity.shareReasonText` 的那张 `when` 表 | 落到兜底话「发送没有成功（键名）」上 —— 至少看得见是哪个键 |

⚠️ 这两处由 `node tools/share-bridge-smoke.mjs` 逐字对，**并已接进 CI**
（`.github/workflows/ci.yml` 的 frontend job）。改名字/加键时它会红 —— 那是提醒，
不是误报。

⚠️ 分享**只支持文本**（manifest 里只声明 `text/plain`）：文件那条路在 WebView 里做不通
（页面拿不到路径），候选与取舍在 `docs/specs/android-client.md` §4.3。
⚠️ 投递是「等 `isReady()` 为真 → 把 payload 交给 `sendText` → 轮询取回 `{ok, reason}`」，
**两条路都有超时**（各 20 秒），超时**会说出来**而不是静默吞掉。

---

## 一之三、第三份契约：配置页 ↔ `config.rs`

「把 `config.json` 画成表单」跨了一条**没有编译器**的边界：Kotlin 那一侧是字符串，
Rust 那一侧是 `serde` 的字段名。字段名写错的症状是**静默**的 ——
那个框永远读不到值，保存时又凭空多写一个键，而 Rust 把未知键忽略掉：

> 改了 → 存了 → 重启了 → **没反应**。

所以字段名**只在一处**出现：`ConfigPage.kt` 的 `fields` / `switches` 两张表
（`Field(R.id.configHost, "server.host", Kind.HOST)` 这种）。别在别的文件里再抄一遍。
判据是 `android-contract-smoke.mjs` 的契约 C（**双向**）：

- 表里每个路径都要能在 `config.rs` 里对上 JSON 键（`#[serde(rename = "…")]` 也算）；
- `config.rs` 里**每一个**配置项都要有控件 —— 这正是「服务端所有配置可视化」这条需求的判据。
  唯一的例外是 `server.roomAuth`：它走**动态行**（`layout_room_row.xml`），
  字段由 `ConfigPage.readRooms()` 拼，所以不在那两张表里、而是列进 `HANDLED_ELSEWHERE`。

⚠️★ **界面不校验配置语义**。三条闸全在写的那一侧（`Config::validate_for_save` 与反序列化），
界面做的是「把它的**原话**原样显示出来」。界面自己只判两件**只有表单才看得见**的事：

| 谁判 | 判什么 | 为什么只有它判得了 |
|---|---|---|
| 界面 | 配置**读不出来**（`Loaded.Broken`）→ 不许保存 | 那是「盘上这份坏了」，Rust 那边只回一句 `error` |
| 界面 | 某个数字框里填的**不是整数** → 不许保存 | 到 Rust 那边它已经是 `0` 了，分不出笔误与真值 |
| Rust | 端口 `0` / 正文上限超了 / 证书只给一个 / JSON 拼错 | 这些是**配置语义**，各端必须同一个答案 |

⚠️★ `roomAuth` 那一项有**三态**，少一个就会错：画出来的键（`drawn`）、
没画出来的（形态不合法 → **原样保留**）、画了但删了（→ 真删）。
只有「删/不删」两种的话，要么房间删不掉，要么把读不懂的部分静默抹掉。

⚠️★ **没动过的字段原样放回**（记着它的「原文」）：`server.auth` 可以是
`false` / `"pw"` / `123`，`roomAuth` 一项可以是 `"pw"` / `123` / `{…}` ——
统一成一种形态的话，用户什么都没改也会在配置文件里产生一大片 diff。

---

## 一之四、第四份契约：跨端桥名（`clip9Auth`）

「免打开界面认证」分两步，跨着外壳与页面：

1. **外壳**：打开清单里某一台之前，先用保存的密码换一张会话令牌（`AuthClient.requestToken`），
   **换到了才 `loadUrl`**；
2. **页面**：`web-vue3/src/store/websocket.js` 在读凭据时问一句
   `window.clip9Auth.roomAuth()`，拿到就并进 `roomAuthCache`。

| 什么 | 在哪 | 对不上的症状 |
|---|---|---|
| 对象名 `clip9Auth` | `WebAppActivity.AUTH_BRIDGE` ↔ `websocket.js` 的 `NATIVE_AUTH_BRIDGE` | **什么都没发生**（不报错、不提示，只是又被问了一次密码） |
| 方法名 `roomAuth` | `WebAppActivity.AuthBridge.roomAuth()` ↔ `websocket.js` 里那句 `typeof bridge.roomAuth` | 同上 |
| 默认房间键 `__default__` | `WebAppActivity.DEFAULT_ROOM_KEY` ↔ `websocket.js` 的 `getRoomStorageKey` | 令牌落在一个**谁都不会去读的键**上，界面照常问密码 |

判据是契约 E（`android-contract-smoke.mjs`），对着**两份** `web-vue3` 一起比：
`clip9` 是独立仓库，父仓库那份同源副本不在时**只记一条提示**（不失败），
但在的时候要逐字相同。

⚠️★ **顺序不能反**：SPA 在 pinia store 初始化时**只读一次**凭据。
页面开始加载之后再去准备令牌，时序是不保证的 —— 「时好时坏」的那种坏。

⚠️★ **换不到不拦着打开**：照常进网页界面、在里面手输密码（那正是这次改动之前的行为），
只把原因说一句。为了一个「自动」那一步失败，就把整个界面挡在外面，是不划算的。

⚠️★ **密码不进 Intent**：`dumpsys activity` 里 extras 是明文可读的，
所以只传 `EXTRA_SERVER_ID`，密码由 `WebAppActivity` 自己从清单里取。

---

## 二、怎么构建

⚠️ **一条命令**（推荐 —— 它把下面 1–4 步串起来，并且在**编之前**就把「哪个 ABI 没装 target /
NDK 里没有那个 clang / `.so` 没搬进 `jniLibs/`」说清楚）：

```bash
bash tools/build-android.sh               # 三个 ABI 的 .so → jniLibs/ → assembleDebug
bash tools/build-android.sh --release     # 换成 assembleRelease
bash tools/build-android.sh --abi arm64-v8a   # 只编一个 ABI 的冒烟
bash tools/build-android.sh --print       # 只把要跑的命令打出来，先看一眼
```

⚠️★ **别在 WorkBuddy 的沙箱里跑**（见 §二.4 末尾那条）；在**普通终端**里跑。

下面是手工的四步 —— 脚本出问题时按这个排查，也是「它在干什么」的说明。

### 1. 交叉编 `.so`

⚠️★ 三个环境变量必须与 `cargo` 在**同一条命令里**（每次 Bash 调用都是新 shell）：

```bash
cd rust
NDK=$HOME/Library/Android/sdk/ndk/27.3.13750724/toolchains/llvm/prebuilt/darwin-x86_64/bin
export CC_aarch64_linux_android=$NDK/aarch64-linux-android24-clang
export AR_aarch64_linux_android=$NDK/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android24-clang
cargo build -p clip9-android --release --target aarch64-linux-android
```

⚠️ 还要 `export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"`：本机有**两个** rust，
只有 `$HOME/.cargo/bin` 那个（rustup）装了 android target；Homebrew 那个在前面时会给出一句
`can't find crate for std`。

另外两个 ABI（把上面三处的 `aarch64_linux_android` 与目标名一起换掉）：

| ABI | target | clang |
|---|---|---|
| `arm64-v8a` | `aarch64-linux-android` | `aarch64-linux-android24-clang` |
| `armeabi-v7a` | `armv7-linux-androideabi` | `armv7a-linux-androideabi24-clang` |
| `x86_64` | `x86_64-linux-android` | `x86_64-linux-android24-clang` |

⚠️ `x86_64-linux-android`（给模拟器用的，真机不需要）**已经装上了，而且列在
`rust/rust-toolchain.toml` 的 `targets` 里**。它原来是漏的 —— 于是 `build-android.sh` 会
**静默跳过**它，最后由 Gradle 编出一个缺 x86_64 原生库的包（`abiFilters` 只过滤、不检查
`jniLibs/`）。现在由那份 `targets` 清单决定，`rustup` 会自动装齐；手工装就是：

```bash
rustup target add x86_64-linux-android
```

⚠️ `-p clip9-android` **会连带编出整个服务端**（`clip9-server` 是它的依赖）——
这是**故意的**：`.so` 里那个服务端与 `clip9-server` 命令行走的是**同一份**实现
（`clip9_server::{config_file, paths, serve}`）。别在这里塞第二份。

### 2. 把 `.so` 搬进 `jniLibs/`

```bash
node tools/sync-android-jni-libs.mjs            # 缺哪个 ABI 会逐条说
node tools/sync-android-jni-libs.mjs --check    # 只比对不写，不一致退出 1
```

⚠️ 它**不在 CI 里**（CI 上没有 NDK，也就没有 `.so` 可比），只在**你本机打 APK 之前**跑。
别把 `--check` 加进 CI：那只会得到一条永远红的判据。

### 3. 让 Gradle 找到 SDK

`local.properties`（**不进仓库**）里写一行，或者用 `ANDROID_HOME`：

```
sdk.dir=/Users/<你>/Library/Android/sdk
```

⚠️ 本机 `ANDROID_HOME` / `ANDROID_SDK_ROOT` **两个都没设**（`~/.zshrc` 里也没有），
所以这个文件是**必须**的。已经写好了一个（内容就是上面那行），而被 `android/.gitignore`
的 `/local.properties` 挡住 —— `git status` 里看不见它是正常的。

### 4. 构建

```bash
cd android
./gradlew assembleDebug        # 或 assembleRelease
```

⚠️★ **不带任务名跑 `./gradlew` 是没有意义的**：那跑的是默认的 `help` 任务，
输出一串 `Welcome to Gradle 8.13` + `BUILD SUCCESSFUL`，看起来像「编过了」，
其实**一个 Kotlin 文件都没过编译器、也没有 APK**（`app/build/` 根本不会出现）。
那一趟只证明「构建脚本能被解析、AGP 与 Kotlin 插件能解析」。
判断真的编了没有，看 `android/app/build/outputs/apk/` 里有没有文件。

release 的签名材料也**不进仓库**，通过 `-P` 传（四个都给齐才会签名 —— 没给齐会出一个未签名的 APK，
而不是报一句看不懂的配置错）：

```bash
./gradlew assembleRelease \
  -Psigning.store.file=/abs/path/clip9.jks \
  -Psigning.store.password=… \
  -Psigning.key.alias=… \
  -Psigning.key.password=…
```

### 4.1 正式的签名密钥（2026-09-28 生成）

本机那份在 **`~/keystore/clip9/`**（在仓库外，目录与文件都是 `600`）。口令与指纹是同一目录下
`CREDENTIALS.txt` 里的那几行。走项目脚本是这样（四个 `-P` 参数由 `--` 之后原样转给 Gradle）：

```bash
bash tools/build-android.sh --release -- \
  "-Psigning.store.file=$HOME/keystore/clip9/clip9-release.jks" \
  "-Psigning.store.password=…" \
  "-Psigning.key.alias=clip9" \
  "-Psigning.key.password=…"
```

- 密钥库 `clip9-release.jks`：PKCS12，**4096-bit RSA**，别名 `clip9`，有效期到 2054-02-13。
- SHA-256 指纹 `E6:B9:C9:E2:D7:E4:0C:E0:FF:98:2A:65:70:EB:05:4C:5B:B5:86:5D:B2:98:3A:83:6E:EF:EB:F4:2E:AA:D5:8F`
- SHA-1 指纹 `E2:F0:97:42:58:B6:77:7C:9C:AC:DB:83:C8:34:03:20:A1:18:5A:30`

⚠️★ **这把密钥库丢了就再也发不出能覆盖安装的包** —— 同一个 `applicationId`
（`com.clip9.app`）以后只能用同一把签名。口令可以换（`keytool -storepasswd`，不影响签名身份），
**密钥库本身不能丢**：备份到密码管理器或离线盘，别只留本机这一份。

⚠️ 它与 Go 版（`com.cloudclip`）那把**互不相干**：`applicationId` 不同就是两个独立的应用，
没有「必须能覆盖旧版」的包袱，所以没有复用旧密钥的必要。

⚠️★ 私钥留在仓库外这件事**是有判据的**（`tools/android-contract-smoke.mjs` 第 12 条）：
`android/.gitignore` 里那两条 `*.jks` / `*.keystore` 是防呆 —— Go 版的 workflow 正是
`base64 --decode > android/app/my-release-key.keystore`，照那个习惯手动解一份进来很自然，
而那一次 `git add -A` 会把私钥推上公开仓库，**进了 git 历史就再也拿不掉**。

CI 用的是同一把，走这四个 secret（名字与 Go 版一致；⚠️ **得在 clip9 这个仓库里各加一份**）：

| secret | 值 |
|---|---|
| `SIGNING_KEY_STORE_BASE64` | `clip9-release.jks.base64` 的全部内容（一行，5748 字符） |
| `SIGNING_KEY_STORE_PASSWORD` | 见 `~/keystore/clip9/CREDENTIALS.txt` |
| `SIGNING_KEY_ALIAS` | `clip9` |
| `SIGNING_KEY_PASSWORD` | 与 store 口令**相同**一个值（PKCS12 只有一份口令） |

⚠️ 口令**刻意不写在这里**（这是公开仓库）。`.github/workflows/android.yml` 的「准备签名材料」
那一步会把四个一起验，缺任何一个当场报红。

⚠️★ **`release.yml` 调 `android.yml` 时必须写 `secrets: inherit`**（那两处 `uses:` 下面）。
2026-09-28 就因为漏了它，发版时这一格报了「先给 clip9 这个仓库加上这几个 secret」——
而 `gh secret list` 里四个都在。**可复用工作流不会自动拿到调用方的 secret**（GitHub 的规则是
「secrets are only passed to directly called workflow」），不写就是四个**空串**。
⚠️★ 症状很容易认错方向：**手动 dispatch 是好的**（那时它是顶层工作流、直接读得到仓库 secret），
只有被 `release.yml` 调用时才红 —— 看着像「release 那条路坏了」。
`tools/workflows-smoke.mjs` 的第 8 条判据钉着这件事。

⚠️ 本机**没有 `gradle` CLI**（PATH 里那个不存在），但有 wrapper —— 所以**一律用 `./gradlew`**。
wrapper 的发行版已经缓存在 `~/.gradle/wrapper/dists/gradle-8.13-bin`。

⚠️★ 别在本项目的沙箱里跑 `./gradlew`：Gradle 会**批量建目录**（一次几百个），而沙箱按目录记账 —— 
规则表撑大之后**每条命令都会被 SIGTERM**（连 `echo` 都不行，看起来像「shell 坏了」）。
要跑就在普通终端里跑。

---

## 三、本仓库**没有**验过的部分

这一节是**清单，不是免责声明** —— 接手的人先看这里，别把「文件齐了」当成「能跑」。

- ✅ **构建脚本能配置**（2026-09-28，本机跑过一次）：不带任务名的 `./gradlew` 走到
  `BUILD SUCCESSFUL in 25s`。⚠️ 但那只跑默认的 `help` 任务 —— 于是它**只**证明了
  `settings.gradle.kts` 与两个 `build.gradle.kts` 能被求值、AGP 8.7.3 与 Kotlin 2.0.21
  能被解析。**一个 Kotlin 文件都没过编译器，`AndroidManifest.xml` 与资源都没被解析，也没有 APK。**
- ✅ **`assembleDebug` 走到过 `compileDebugKotlin`**（2026-09-28，本机，**两次**）。
  两次都是 `BUILD FAILED`，三个根因**都已修**：
  1. 第一次（20:22）`BUILD FAILED in 1m 16s`，`:app:compileDebugKotlin` 报 11 条，两个根因：
     - `SharePayload.kt` 的 KDoc 里写了「斜杠 + 星号」那种形式。**Kotlin 的块注释可以嵌套**，
       于是注释里又开了一层、外层一直不闭合，**把文件后半整个吞掉**（`ShareIntent` 与
       `PendingShare` 一起消失）。编译器报的是「文件末尾注释未闭合」+ 九条
       `Unresolved reference`，**读起来像「凭空少了几个类」**。
     - `WebAppActivity` 有两个 `const val` 写在类体里 —— 只许出现在顶层 / `object` /
       `companion object` 三处。已挪进 `companion object`。
  2. 第二次（20:35）`BUILD FAILED in 7s`。根因**是第 1 条那次改的时候我自己写下的**：那段解释
     注释的正文里带了块注释的**结束符**（星号紧跟斜杠）—— 注释就在那一行提前关掉，它后面几行
     变成顶层代码，报一串 `Syntax error: Expecting a top level declaration`，**列号指向注释里
     的那几个字**。
     ⚠️★ 当时判据 11 **只查「又开一层」那一种坏法**，所以在第二种坏法上是**绿的**。已补上
     `strays` 分支（扫「不在任何注释里却出现闭合符」），见 `tools/android-contract-smoke.mjs`；
     修法本身与那条判据在提交 `fff132b` 里。**教训**：解释这个坑的注释里，一个「斜杠 + 星号」
     的组合字面量都不能出现 —— 哪种顺序都不行。
  ⚠️ 这两趟**没白跑**：三个 ABI 的 `.so` 都由它编出来了（见下一条），`merged_native_libs`
  里三份都齐，`AndroidManifest.xml` 与资源也走完了合并 —— 停住的地方只有 Kotlin 编译。
- ✅ **三个 ABI 的 `.so` 都在 `jniLibs/` 里**（2026-09-28，都已 strip）：
  `arm64-v8a` 17.6 MB、`armeabi-v7a` 15.1 MB、`x86_64` 18.7 MB。
  ⚠️ 但那两趟都**没出 APK**（`android/app/build/outputs/apk/` 到写这份文档时**不存在**）：
  构建停在 Kotlin 编译，走不到打包。所以「APK 长什么样」仍然是未知。
- ⚠️★ **第三次还没跑。** 上面第 2 条的修法是**读代码推出来的**（那一段确实是注释提前闭合），
  没再编一次验过 —— 下一次 `bash tools/build-android.sh` 才知道对不对、以及后面还有没有别的错。
  ⚠️ R8（release 的 `isMinifyEnabled`）与 `jniLibs` 的处置要到 **release** 才验；
  `AndroidManifest.xml` 与资源的**内容**（不只是合并成功）也要到打包阶段才真验。
- ⚠️ **Kotlin 还没编过一次成功的。** 编译器现在只是还没抱怨到那些 API 用法上
  （`AlertDialog` / `evaluateJavascript` / `OnBackPressedCallback` …）—— 编过才算数。
- ⚠️★ **分享那条路的「跑起来对不对」完全没验过。** 它跨了四层：`Intent` 解析 → 起服务端
  → 开 WebView → 轮询 `isReady()` → 投递 → 取回 `{ok, reason}`。
  ⚠️ 其中「`evaluateJavascript` 回来的字符串长什么样」**只有真跑一次才知道** ——
  代码里按 `"true"` / `"null"` / `{"ok":true}` 写并加了注释，但那是**推断**，不是实测。
  ⚠️ 真机验收的第 6 条（设计稿 §7）就是它。
- ⚠️★ **CI 那条路一次都没跑过**（2026-09-28 写下这份文档时）。本机也验不了 —— 它要
  runner、Android SDK / NDK、四个 `SIGNING_*` secret。能提前问的只有
  `node tools/workflows-smoke.mjs`（7 条跨文件判据，已接进 CI 的 frontend job，19 组变异验过）：
  它管的是「artifact 名字 / 前缀 / 矩阵条目数 / ABI ↔ target / `--require-all` 还在不在」这些
  字符串约定，**管不了「编不编得出来」**。
  ⚠️ 所以第一次 CI 红了**先看 `.github/workflows/android.yml` 里「看清楚 Android SDK / NDK 在哪」
  那一步**，别先怀疑代码。
  ⚠️ **secrets 是按仓库存的**：`SIGNING_*`（还有 `DOCKERHUB_*`）在 `cloud-clipboard-go` 那边有，
  **不会跟到 clip9**，得在 clip9 里各加一份；缺了会在「准备签名材料」那一步当场报红
  （刻意如此：默默出一个未签名的包更难查）。
- ⚠️ **没有在真机或模拟器上跑过**。所以「明文 HTTP 能不能连、自签 HTTPS 那个确认框长什么样、
  前台服务会不会被 ROM 杀掉、锁屏之后还活着吗」这些都**只是照着设计稿写的**。
- ✅ **Rust 侧那半边验过**：`crates/android` 在主机上 `clippy --all-targets -D warnings` 干净、
  **6 条**测试全绿（含两条四态状态机的决策表，以及 `config_round_trips_through_the_bridge_and_bad_values_are_refused`
  —— 配置经过 JNI 桥走一圈回来逐字段相同、坏值被拒）；`aarch64-linux-android` 也真的编得出来。
- ✅ **配置文件的读写那半边验过**：`crates/server/src/config_file.rs` 有 3 条测试
  （存进去再读回来逐字段相同 / 首次保存会建文件且能覆盖 / 坏文件是致命错误而保存仍能修好它），
  `Config::validate_for_save` 的三道闸各有一条正反断言。⚠️ 但**界面把表单拼成 JSON 那一段**
  仍然没验过（那要真跑一次 App）。
- ✅ **分享桥的 SPA 那半边验过**：`npm run build` 过，且 `node tools/share-bridge-smoke.mjs`
  的 7 条判据全绿、8 组变异全部按预期变红（见设计稿 §0.4）。
- ✅ **「免打开界面认证」的 SPA 那半边验过**：`websocket.js` 里问桥、把外壳给的那份并到
  `roomAuthCache` 上面这十几行，由 `node tools/android-contract-smoke.mjs` 的契约 E 逐字对
  （桥名 / 方法名 / 默认房间键三处）；⚠️ 但**外壳那一半**（`AuthClient.requestToken` 真发出去、
  `addJavascriptInterface` 真的在 `loadUrl` 之前装上）仍然没验过 —— 同样要真跑一次。

---

## 四、还没做的

- **A5 的文件那条**（分享图片/文件）：原稿的 `sendFiles(uris)` 做不到（WebView 拿不到路径），
  四条候选（base64 / 分块 base64 / `WebViewAssetLoader` / `addWebMessageListener`）
  与取舍在 `docs/specs/android-client.md` §4.3。⚠️ 倾向最后一条，但它要加 `androidx.webkit`、
  还要面对「`allowedOriginRules` 对运行时填的远端地址」这件事 —— **是一片单独的活**。
- **A6 打包**：**CI 那条路已经搭好了** —— `.github/workflows/android.yml` 两个入口
  （`workflow_call` 给 `release.yml` 发版时调，`workflow_dispatch` 单独手动跑并可**覆盖上传**
  到指定 Release），产物名 `clip9-android-v<版本>.apk`，版本号由 `tools/release-version.mjs`
  **一处**算（`versionCode = MAJOR*100000 + MINOR*1000 + PATCH`，预发布后缀不参与）。
  但**一次都没跑过**，还欠：
  ① 在 CI 上真的跑通一次（要四个 `SIGNING_*` secret，见 §三）；
  ② 本机第三次 `bash tools/build-android.sh`（§三里那条修法还没重跑过）；
  ③ **release 那条从来没出过产物**（本机两次都是 `assembleDebug`）—— R8 与签名 APK 都没验过。

（切片表在 `docs/specs/android-client.md` §0.2。）

---

## 五、目录里有什么

```
android/
├── app/build.gradle.kts          namespace/applicationId/minSdk/splits.abi（⚠️ 契约见 §一）
├── app/proguard-rules.pro        ⚠️ R8 会改短类名 → JNI 符号名失效，见 §一
└── app/src/main/
    ├── AndroidManifest.xml       权限、两个 Activity、那个前台服务、分享过滤器（只 text/plain）
    ├── java/com/clip9/app/
    │   ├── MainActivity.kt       原生管理页（方案 B：状态条 + 连接/配置/其它三页）+ 分享进来的落点
    │   ├── ConfigPage.kt         把 config.json 画成表单（⚠️ 字段名那张表是跨语言契约，见 §一之三）
    │   ├── RemoteServerList.kt   连接页里的服务器清单（可存多台，每台带自己的房间与密码）
    │   ├── WebAppActivity.kt     全屏 WebView + 分享投递 + 打开前的自动认证
    │   ├── ServerService.kt      前台服务：唯一起停服务端的地方
    │   ├── ServerBridge.kt       ⚠️ JNI 契约，见 §一
    │   ├── ServerConfigStore.kt  服务端配置（config.json）的读写 —— 只搬运，不解释字段含义
    │   ├── RemoteServers.kt      服务器清单的存取（整份 JSON 落一个偏好键）
    │   ├── SecretBox.kt          清单里的密码怎么加密（Android Keystore，AES/GCM）
    │   ├── AuthClient.kt         用密码换会话令牌（`POST /auth/token`）+ 测试连接
    │   ├── SharePayload.kt       分享的解析 + 排队（⚠️ 契约见 §一之二）
    │   ├── AppPrefs.kt           ⚠️ 只剩两个**老版本的键**（port / remoteUrl），只给迁移读
    │   ├── ServerAddress.kt      回环地址 与 局域网地址（⚠️ 两者不是一回事）
    ├── res/layout/               activity_main.xml（管理页，四块拼起来）/ activity_webapp.xml
    │                             + layout_room_row.xml（房间行）/ layout_remote_row.xml（服务器行）
    │                             + dialog_remote_server.xml（编辑一台）
    ├── res/values*/              strings / colors / themes（+ 暗色）
    └── res/xml/network_security_config.xml   明文 HTTP 策略（见下面那条）
```

⚠️★ **动态行的 id 一律用 `row.findViewById`**：`layout_room_row.xml` / `layout_remote_row.xml`
会被 inflate **多次**（有几个房间/几台服务器就有几份），Activity 级的 `findViewById`
**只会拿到第一份** —— 症状是「界面上改了第三行，存下去的是第一行」。

⚠️★ **两份布局里的 id 不许与 `activity_main.xml` 重名**：重了之后 `row.findViewById(R.id.x)`
仍然是对的，但任何一处写漏 `row.` 就会**静默**绑到 Activity 那一份上。

⚠️★ **配置页不校验配置语义**（端口范围、正文上限、证书配一半…）：那些只在
`clip9-core` 的 `Config::validate_for_save` 里实现一次，界面把它的**原话**显示出来。
界面自己只判两件**只有表单才看得见**的事：① 配置读不出来（不许保存）；
② 某个数字框里填的**不是整数**（Rust 收到的是已经变成 `0` 的数，它分不出那是笔误还是真值）。
理由：抄一遍必然漂，而漂了的两种结果都很难看 ——「界面放行、服务端拒绝」，
或者更坏的「界面拒绝、其实能配」。

⚠️ `res/xml/network_security_config.xml` 选的是「**全局放行明文**」：
Android 9 起 `usesCleartextTraffic` 默认为 false，而**服务端默认就是 http**，
选「只列私网段」那种写法会因为地址是运行时填的而**让这个 App 的主要用法直接不可用**。
里面同时放开了 `<certificates src="user" />` —— 那是「自签服务端」的正解：
用户装一次自己的 CA，WebView 就走正常校验、根本不会弹确认框。
