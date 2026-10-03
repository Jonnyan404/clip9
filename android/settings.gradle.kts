// Android 外壳的 Gradle 设置。
//
// ⚠️★ 这个工程**不参与** `rust/` 的 cargo 构建，两边的产物通过
// `tools/sync-android-jni-libs.mjs` 接起来（把 `rust/target/<target>/release/libclip9_android.so`
// 搬进 `app/src/main/jniLibs/<abi>/`）。见 `android/DEVELOPING.md`。

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "clip9"
include(":app")
