package com.clip9.app

/**
 * Rust 侧 `crates/android` 的 JNI 桥。
 *
 * ⚠️★ **这一整个文件是一份契约**：下面那五个 `external fun` 的名字被 Rust 那边
 * **逐字写死**（`Java_com_clip9_app_ServerBridge_native*`）。对不上的症状是
 * `UnsatisfiedLinkError` —— 而它**不会告诉你**是哪一处不对。三处必须同时一致：
 *
 * 1. 本文件的**包名 + 类名 + 方法名**（`com.clip9.app.ServerBridge.nativeStart`）；
 * 2. `System.loadLibrary("clip9_android")` 的那个名字（= `rust/crates/android/Cargo.toml`
 *    里 `[lib] name`，产物是 `libclip9_android.so`）；
 * 3. `app/src/main/jniLibs/<abi>/libclip9_android.so` 真的在。
 *
 * ⚠️ 而第 3 条**忘了做是没有任何提示的**：编得过、装得上、一调就炸。
 * 用 `node tools/sync-android-jni-libs.mjs` 搬 `.so`，`--check` 能提前问一句。
 *
 * ⚠️ 还有一处**不在本文件**：`app/proguard-rules.pro` 里的 `-keep`。
 * release 开了 R8，类名一改短，上面第 1 条就废了。
 */
object ServerBridge {

    /** 服务端状态。⚠️ 数值与 `crates/android/src/lib.rs` 的 `STATUS_*` **逐值对应**。 */
    const val STATUS_IDLE = 0
    const val STATUS_RUNNING = 1
    const val STATUS_STOPPING = 2
    const val STATUS_STARTING = 3

    private const val LIBRARY = "clip9_android"

    /**
     * `.so` 加载失败的原话（成功时为 null）。
     *
     * ⚠️ 字段名**故意**不叫 `loadFailure`：那会和下面的 `fun loadFailure()` 撞成一个
     * 「属性 / 函数同名」的形状 —— Kotlin 允许（JVM 上是 `getXxx` 与 `xxx`，签名不冲突），
     * 但读代码的人得过一遍才敢确定调的是哪个。加个 `Message` 就没了这个问题。
     */
    @Volatile
    private var loadFailureMessage: String? = null

    @Volatile
    private var loaded = false

    /**
     * 保证 `.so` 已加载。
     *
     * ⚠️★ 用返回值 + [loadFailure] 而不是让 [System.loadLibrary] 抛出去：
     * 「jniLibs 里没有那个 ABI 的 .so」会以 `UnsatisfiedLinkError` 的形式在**第一次调用**
     * 时炸出来，而那时候界面已经画完了 —— 用户看到的是闪退，
     * 排查的人看到的是一个跟他做的事毫无关系的堆栈。这里把它变成界面上的一行字。
     */
    private fun ensureLoaded(): Boolean {
        if (loaded) return true
        synchronized(this) {
            if (loaded) return true
            loaded = try {
                System.loadLibrary(LIBRARY)
                true
            } catch (t: Throwable) {
                // ⚠️ 抓 `Throwable` 而不是 `Exception`：`UnsatisfiedLinkError` 是 Error。
                loadFailureMessage = t.message ?: t.toString()
                false
            }
            return loaded
        }
    }

    // ⚠️★ 下面五个是**实例方法**（`object` 里的 `external fun` 不带 `@JvmStatic`），
    // 所以 Rust 那边第二个参数收的是 `JObject`。改法见本文件抬头。
    // ⚠️ 它们**只能在 ensureLoaded() 为 true 之后**调 —— 所以全部包在下面几个 public 函数里。
    private external fun nativeVersion(): String
    private external fun nativeStart(
        configPath: String,
        dataDir: String,
        host: String,
        port: Int,
    ): String?
    private external fun nativeStop(): String?
    private external fun nativeStatus(): Int
    private external fun nativeLastError(): String?

    /** `.so` 的版本号。拿得到它就说明整条链（加载 / 符号名 / ABI 目录）是通的。 */
    fun version(): String = if (ensureLoaded()) nativeVersion() else "（本地组件未加载）"

    /**
     * 起服务端。**阻塞**（最多 800ms + 建库时间）—— ⚠️ **别在主线程上调**。
     *
     * @return `null` = 成功；非 null = 一句话原文，应当原样显示给用户
     *   （失败时是错误原文，也可能是「正在启动 / 正在停止，请稍候」）。
     */
    fun start(configPath: String, dataDir: String, host: String, port: Int): String? {
        if (!ensureLoaded()) return loadFailureMessage ?: "本地组件未加载"
        return nativeStart(configPath, dataDir, host, port)
    }

    /** 停服务端。**阻塞**（等 redb 事务收尾，上界 15 秒）—— ⚠️ 别在主线程上调。 */
    fun stop(): String? {
        if (!ensureLoaded()) return loadFailureMessage ?: "本地组件未加载"
        return nativeStop()
    }

    /** 现在是什么状态。⚠️ 它不阻塞，**可以**在 UI 线程上调。 */
    fun status(): Int = if (ensureLoaded()) nativeStatus() else STATUS_IDLE

    /** 最近一次失败的**原话**（没有就 null）。 */
    fun lastError(): String? {
        loadFailureMessage?.let { return it }
        if (!ensureLoaded()) return "本地组件未加载"
        return nativeLastError()
    }

    /** 「装了但 `.so` 没搬进来」这一类问题，界面上要能一眼看出来。 */
    fun loadFailure(): String? = loadFailureMessage

    /** 状态码 → 显示文案的资源 id。 */
    fun statusLabelRes(status: Int): Int = when (status) {
        STATUS_RUNNING -> R.string.status_running
        STATUS_STARTING -> R.string.status_starting
        STATUS_STOPPING -> R.string.status_stopping
        else -> R.string.status_idle
    }
}
