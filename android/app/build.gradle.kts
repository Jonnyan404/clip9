// Android 外壳（A2 工程骨架）。
//
// ⚠️★ `namespace` / `applicationId` **是契约**：`crates/android/src/lib.rs` 里的 JNI 符号名
// 逐字写死了 `Java_com_clip9_app_ServerBridge_native*`。
// 改包名 = 改 `System.loadLibrary` + 改 `ServerBridge.kt` 的包 + **改 Rust 那边的符号名**
// （以及本文件、`AndroidManifest.xml`、`proguard-rules.pro`），漏一处的症状是
// `UnsatisfiedLinkError` —— 而它**不会告诉你**是哪一处不对。见 `android/DEVELOPING.md`。

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.clip9.app"
    compileSdk = 34

    // 与父仓库的 Go 版 Android 工程同一套「从 -P 或 gradle.properties 读签名」的做法：
    // 签名材料**不进仓库**。
    //
    // ⚠️★ 四个属性都齐、且那个 keystore 真的在，才把 `storeFile` 填进去。
    // 没配时**不要把 `signingConfig` 指过去** —— 指向一个空的 signingConfig 会在
    // `assembleRelease` 时报「missing required property storeFile」，
    // 那句话听起来像「配置写错了」，而不是「你还没配签名」。
    signingConfigs {
        create("release") {
            val storeFilePath = project.findProperty("signing.store.file") as String?
            val storeFilePassword = project.findProperty("signing.store.password") as String?
            val alias = project.findProperty("signing.key.alias") as String?
            val aliasPassword = project.findProperty("signing.key.password") as String?
            if (storeFilePath != null && storeFilePassword != null && alias != null && aliasPassword != null) {
                val keystore = file(storeFilePath)
                if (keystore.exists()) {
                    storeFile = keystore
                    storePassword = storeFilePassword
                    keyAlias = alias
                    keyPassword = aliasPassword
                }
            }
        }
    }

    defaultConfig {
        applicationId = "com.clip9.app"
        // ⚠️ minSdk 24 = Android 7.0。这一档是设计稿 §3.6 认下来的：国内设备上系统 WebView
        // 可能很旧，24 是「还值得支持」的下限。
        minSdk = 24
        targetSdk = 34
        versionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
        versionName = project.findProperty("versionName") as String? ?: "0.1.0"

        // ⚠️★ 这里**没有** `ndk { abiFilters += … }`，**别加回来**：它与下面那段
        // `splits { abi { … } }` **并存会让 AGP 直接报错**（原话是
        // "Conflicting configuration : '…' in ndk abiFilters cannot be present when splits
        //  abi filters are set : …"）。两个都写等于两个都不生效。
        // 「要哪几个 ABI」现在**只有一处定义**：下面 `splits.abi.include(...)`。
    }

    // ── APK 拆分：三个 ABI 各一个包 + 一个合并包 ─────────────────────────────
    //
    // ⚠️★ 2026-09-29 改的（Jonny：「android 的包要三平台单独的包和合并的包，现在只有一个」）：
    // 发版同时出**三个 ABI 单独的包**和**一个含三者的合并包**。合并包沿用以前那个名字
    // （`clip9-android-v<版本>.apk`），单 ABI 的在后面接 `-<abi>`。
    // 理由很直接：合并包 53 MB，而单 ABI 约 18 MB —— 真机绝大多数是 arm64-v8a。
    //
    // ⚠️★ 原来这里写的是「**不要** splits」，理由是「拆了之后『APK 装上了但那个 ABI 没有
    //    `.so`』会变成一件看起来正常的事」。⚠️ 那条顾虑**没有消失**，只是它的正确位置是
    //    **打包流水线**而不是这里 —— 现在由三道闸兜住，缺一不可：
    //      · `tools/build-android.sh --require-all`（CI 用的就是它）：范围内某个 ABI 没编出来
    //        就非零退出（不加这个参数时它是**跳过**，那正是当年担心的那件事）；
    //      · `tools/sync-android-jni-libs.mjs --check`：`jniLibs/` 与 target 产物对不上就红；
    //      · `android.yml` 收产物那一步**逐包数原生库**（`lib/<abi>/libclip9_android.so`）：
    //        单 ABI 包必须恰好一个、合并包必须恰好是全部，少一个就报红。
    //
    // ⚠️ 四个包**共用** `defaultConfig.versionCode`：AGP **不会**替 ABI 拆分自动加偏移。
    //    这是故意的 —— 它们本来就是「同一个版本的四种装法」，共用同一个号，随便换着装
    //    都不会被版本号挡住。（想给每个 ABI 单独的号就得自己写 `versionCodeOverride`，
    //    那样反而会把「先装合并包、再换单 ABI 包」变成一次降级安装。）
    splits {
        abi {
            isEnable = true
            // ⚠️ `reset()` 必须有：不清空的话默认是「所有 ABI」，`include` 就成了追加。
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            // 合并包（含三者）。⚠️ x86_64 那个是给模拟器留的（本机是 x86_64 的 Mac）。
            isUniversalApk = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // ⚠️ 没配签名就**不指定**（`assembleRelease` 会出未签名的 APK，装不上，
            // 但至少不会因为一句看不懂的配置错而停在那儿）。debug 构建不受影响。
            signingConfigs.getByName("release").takeIf { it.storeFile != null }?.let {
                signingConfig = it
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    // ⚠️ appcompat 同时也带来了 `androidx.activity:activity`（`OnBackPressedCallback`
    // 与 `onBackPressedDispatcher` 从那里来）—— 所以**不**单独列 activity，列了只是多一个
    // 版本号要对齐的地方。
    implementation("androidx.appcompat:appcompat:1.6.1")
    // Material3 主题（`?attr/textAppearanceHeadlineSmall` 那些也来自它）。
    implementation("com.google.android.material:material:1.11.0")
    // 管理页上那个二维码（与 Go 版同一个库）。⚠️ 只用 `core`，不用 `zxing-android-embedded`：
    // 后者自带一个 Activity，而这里只要一个 BitMatrix。
    implementation("com.google.zxing:core:3.5.3")
}
