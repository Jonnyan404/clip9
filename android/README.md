# clip9 的 Android 外壳

这个目录**不是**一个完整的界面实现，它是「一个原生管理页 + 一个 WebView」的壳：

- `MainActivity` —— **原生**管理页。启停本机服务端、显示局域网地址与二维码、切换「本机 / 远端」、
  电池优化白名单、WebView 版本提示。
- `WebAppActivity` —— **一个全屏 WebView**，加载服务端下发的界面（看板 / 分享页）。
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

> ⚠️ 还有一条**只能靠注释**记着的：Kotlin 那边是 `object ServerBridge { external fun … }`，
> 也就是**实例方法** —— 所以 Rust 侧第二个参数收的是 `JObject`（`jobject`）而不是 `JClass`（`jclass`）。
> 改成 `companion object` + `@JvmStatic` 会静默变成静态方法。**两种在 ABI 上都是指针、都不会崩，
> 没有任何测试能发现这件事。**

---

## 二、怎么构建

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

⚠️ `x86_64-linux-android` 这个 target **本机还没装**（它是给模拟器用的，真机不需要）：

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

### 4. 构建

```bash
cd android
./gradlew assembleDebug        # 或 assembleRelease
```

release 的签名材料也**不进仓库**，通过 `-P` 传（四个都给齐才会签名 —— 没给齐会出一个未签名的 APK，
而不是报一句看不懂的配置错）：

```bash
./gradlew assembleRelease \
  -Psigning.store.file=/abs/path/clip9.jks \
  -Psigning.store.password=… \
  -Psigning.key.alias=… \
  -Psigning.key.password=…
```

⚠️ 本机**没有 `gradle` CLI**（PATH 里那个不存在），但有 wrapper —— 所以**一律用 `./gradlew`**。
wrapper 的发行版已经缓存在 `~/.gradle/wrapper/dists/gradle-8.13-bin`。

⚠️★ 别在本项目的沙箱里跑 `./gradlew`：Gradle 会**批量建目录**（一次几百个），而沙箱按目录记账 —— 
规则表撑大之后**每条命令都会被 SIGTERM**（连 `echo` 都不行，看起来像「shell 坏了」）。
要跑就在普通终端里跑。

---

## 三、本仓库**没有**验过的部分

这一节是**清单，不是免责声明** —— 接手的人先看这里，别把「文件齐了」当成「能跑」。

- ⚠️★ **Gradle 构建从没在本机跑过**（见上面那条沙箱的原因）。
  也就是说：`build.gradle.kts` / `settings.gradle.kts` / `AndroidManifest.xml` / 资源 是否真的能编过，
  **没有验证**。
- ⚠️★ **Kotlin 代码从未编译过**（`MainActivity` / `WebAppActivity` / `ServerService` /
  `ServerBridge` / `AppPrefs` / `ServerAddress`）。写的时候是逐行对着 API 与资源名核的
  （id / string / color / drawable 都逐个对过），但「对过名字」不等于「编得过」。
- ⚠️ **只有 `arm64-v8a` 的 `.so`**。`armeabi-v7a` 与 `x86_64` 的 Rust target 一个没编
  （`x86_64-linux-android` 连 target 都没装）。`abiFilters` 里列着它们，所以在这两个 ABI 上
  装出来的 APK 会在 `System.loadLibrary` 那一步炸 —— **`abiFilters` 不会替你检查这件事**。
- ⚠️ **没有在真机或模拟器上跑过**。所以「明文 HTTP 能不能连、自签 HTTPS 那个确认框长什么样、
  前台服务会不会被 ROM 杀掉、锁屏之后还活着吗」这些都**只是照着设计稿写的**。
- ⚠️ **Rust 侧那半边验过**：`crates/android` 在主机上 `clippy --all-targets -D warnings` 干净、
  5 条测试全绿（含两条四态状态机的决策表）；`aarch64-linux-android` 也真的编得出来。

---

## 四、还没做的

- **A5 分享菜单**：`ACTION_SEND` → 灌进 WebView 的发送路径，契约是
  `window.clip9Share = { sendText, sendFiles, isReady }`。
- **A6 打包**：签名 / 两个 ABI 的 release / CI 里怎么出 APK。

（切片表在 `docs/specs/android-client.md` §0.2。）

---

## 五、目录里有什么

```
android/
├── app/build.gradle.kts          namespace/applicationId/minSdk/abiFilters（⚠️ 契约见 §一）
├── app/proguard-rules.pro        ⚠️ R8 会改短类名 → JNI 符号名失效，见 §一
└── app/src/main/
    ├── AndroidManifest.xml       权限、两个 Activity、那个前台服务
    ├── java/com/clip9/app/
    │   ├── MainActivity.kt       原生管理页（每 700ms 轮询 ServerBridge.status）
    │   ├── WebAppActivity.kt     全屏 WebView（明文 HTTP / 自签证书 / 返回键 / 外链都在这）
    │   ├── ServerService.kt      前台服务：唯一起停服务端的地方
    │   ├── ServerBridge.kt       ⚠️ JNI 契约，见 §一
    │   ├── AppPrefs.kt           端口 / 远端地址（⚠️ 这是**应用偏好**，不是服务端配置）
    │   └── ServerAddress.kt      回环地址 与 局域网地址（⚠️ 两者不是一回事）
    ├── res/layout/               activity_main.xml（管理页）/ activity_webapp.xml（WebView）
    ├── res/values*/              strings / colors / themes（+ 暗色）
    └── res/xml/network_security_config.xml   明文 HTTP 策略（见下面那条）
```

⚠️ `res/xml/network_security_config.xml` 选的是「**全局放行明文**」：
Android 9 起 `usesCleartextTraffic` 默认为 false，而**服务端默认就是 http**，
选「只列私网段」那种写法会因为地址是运行时填的而**让这个 App 的主要用法直接不可用**。
里面同时放开了 `<certificates src="user" />` —— 那是「自签服务端」的正解：
用户装一次自己的 CA，WebView 就走正常校验、根本不会弹确认框。
