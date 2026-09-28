// Android 外壳（A2 工程骨架）。
//
// ⚠️★ `namespace` / `applicationId` **是契约**：`crates/android/src/lib.rs` 里的 JNI 符号名
// 逐字写死了 `Java_com_clip9_app_ServerBridge_native*`。
// 改包名 = 改 `System.loadLibrary` + 改 `ServerBridge.kt` 的包 + **改 Rust 那边的符号名**
// （以及本文件、`AndroidManifest.xml`、`proguard-rules.pro`），漏一处的症状是
// `UnsatisfiedLinkError` —— 而它**不会告诉你**是哪一处不对。见 `android/README.md`。

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

        // ⚠️★ 不要 `splits { abi { ... } }`：那个会把 APK 按 ABI 拆开，
        // 而 jniLibs 里**有没有**某个 ABI 的 `.so` 是 `tools/sync-android-jni-libs.mjs` 决定的。
        // 拆了之后「APK 装上了但那个 ABI 没有 .so」会变成一件看起来正常的事。
        // 这里只做**过滤**（把不支持的 ABI 挡掉），不拆。
        ndk {
            // ⚠️ x86_64 是给模拟器留的（本机是 x86_64 的 Mac）。真机只需要前两个，
            // 但**必须真的存在对应的 `.so`**，否则那个 ABI 的 APK 装上去会在
            // `System.loadLibrary` 那一步炸 —— 而 abiFilters 不会替你检查这件事。
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
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
