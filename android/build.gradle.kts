// 顶层构建脚本。⚠️ 插件版本**写在这里**（不用 `gradle/libs.versions.toml`）。
//
// ⚠️★ 这两个版本不是随手挑的：本机上「能编」的那一对就是它们
// （`~/.gradle/caches/modules-2/files-2.1/com.android.tools.build/gradle/` 里只有 8.7.3，
// `org.jetbrains.kotlin/kotlin-gradle-plugin/` 里只有 2.0.21），
// 而父仓库的 Go 版 Android 工程（`cloud-clipboard-go/android/build.gradle.kts`）用的就是这两个。
// ⚠️ 改这里之前先确认缓存里有那个版本 —— 否则第一次构建要联网拉插件（也能跑，只是慢）。
//
// ⚠️ 那个 `libs.versions.toml` 里写的 `agp = "8.13.0"` 是**没被用上**的死值（那边脚本里硬写了版本），
// 别照抄它。
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
