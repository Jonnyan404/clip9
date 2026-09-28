# R8 / ProGuard 规则。
#
# ⚠️★ 这个文件不是可选的：release 开了 `isMinifyEnabled`，而 **R8 会把类名与方法名改短** ——
# 我们的 `.so` 里那些符号是**逐字写死**的
# （`Java_com_clip9_app_ServerBridge_nativeVersion` 这种）。名字一改，
# `System.loadLibrary` 能过、`external fun` 一调就是 `UnsatisfiedLinkError`。
#
# ⚠️ 所以：**JNI 相关的类与方法一律不许改名、不许删**。
-keep class com.clip9.app.ServerBridge { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}

# ⚠️ 另一半同样重要：`.so` 里的东西是**被 Kotlin 用字符串名加载**的，
# 静态分析看不出「谁在用」→ 不加这两条会有构建期的 warning，且行数一多容易被误删。
-keep class com.clip9.app.ServerService { *; }
