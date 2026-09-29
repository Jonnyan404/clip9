package com.clip9.app

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 服务端配置（`filesDir/config.json`）的读写。
 *
 * ⚠️★ 它**不解释**配置里任何一个字段的含义 —— 那是 Rust 那边
 * `clip9_core::Config` 的事（字段名、默认值、四种 `roomAuth` 形状、路径解析规则全在那边）。
 * 这里只做三件事：把信封取出来、把配置对象原样交给界面、把界面改过的对象原样送回去。
 *
 * ⚠️ 字段名在**界面**那一侧出现是免不了的（表单要按名字读写），
 * 但它与 `rust/crates/core/src/config.rs` 的一致性**没有编译器兜着** ——
 * Kotlin 这一侧没有测试运行器。所以由 `tools/android-contract-smoke.mjs` 的一条判据盯着，
 * 加/改字段名时两边一起改。
 *
 * ⚠️★ 「保存」与「生效」是两件事：服务端**只在启动时**读一次配置
 * （见 `clip9_server::config_file` 的模块文档第 1 条）。所以界面上那一栏写的是
 * 「保存并重启」，不是「保存即生效」。
 */
object ServerConfigStore {

    /**
     * 配置文件的路径。
     *
     * ⚠️★ 必须与传给 [ServerBridge.start] 的 `configPath` 是**同一个文件** ——
     * 这里和 `ServerService` 各自 `File(filesDir, "config.json")` 是刻意的：
     * 「App 私有目录」只有 `Context` 知道，没有哪个常量能表达它。
     * ⚠️ 所以改这里要一起改 `ServerService.configPath()`（两处都写着同一行）。
     */
    fun path(context: Context): String = File(context.filesDir, "config.json").absolutePath

    /** 读的结果。⚠️ 做成分支而不是「一个可能为 null 的对象」：**读失败不能长成读成功的样子**。 */
    sealed interface Loaded {
        /** 读到了。`exists` 说文件在不在（不在时 `config` 是一份**默认值**）。 */
        data class Ok(val config: JSONObject, val exists: Boolean) : Loaded

        /**
         * 文件在、但读不出来。
         *
         * ⚠️★ 这个状态**必须**和 `Ok` 分得开：把一句错误话当成配置去解析，
         * 得到的是「所有字段都缺、看起来像全默认」的东西 —— 用户再一按保存，
         * 真配置就被默认值盖掉了（密码、房间、路径全没）。所以 [message] 原样显示，
         * 而**保存**在里面这状态下也要拦住（见 [MainActivity]）。
         */
        data class Broken(val message: String) : Loaded
    }

    fun load(context: Context): Loaded {
        val envelope = try {
            JSONObject(ServerBridge.loadConfig(path(context)))
        } catch (t: Throwable) {
            // 连信封都解析不了 = 本地组件没加载、或者它坏了。
            // ⚠️ 不能当成「读到一份空配置」—— 理由同上。
            return Loaded.Broken(context.getString(R.string.config_unreadable))
        }
        if (!envelope.optBoolean("ok", false)) {
            return Loaded.Broken(
                envelope.optString("error").ifEmpty { context.getString(R.string.config_unreadable) },
            )
        }
        return Loaded.Ok(
            config = envelope.optJSONObject("config") ?: JSONObject(),
            exists = envelope.optBoolean("exists", false),
        )
    }

    /**
     * 存。
     *
     * @return `null` = 成功；非 null = **一句能原样显示给用户的话**（Rust 那边给的）。
     *
     * ⚠️★ 校验在**那边**（`Config::validate_for_save` + 序列化那道闸），不在这一侧：
     * 「哪些值配了也不生效」是这个项目一条有明确判据的规则，写在 `clip9-core` 里
     * 桌面端与 Android 端才会是同一个答案。在这边再抄一遍必然漂。
     */
    fun save(context: Context, config: JSONObject): String? =
        ServerBridge.saveConfig(path(context), config.toString())

    /**
     * 服务端**现在真的**监听哪个端口（从配置里读）。
     *
     * ⚠️★ 它**不是**第二份权威：端口仍然是配置文件说了算，这里只是把它读出来拼地址。
     * 三个读者都是「要一个能拼进地址的数」—— 状态条、连接页、常驻通知 ——
     * 而它们各自都没有更好的兜底办法（一条没有地址的通知等于没发）。
     * 所以读不到就退回 [AppPrefs.DEFAULT_PORT]。
     *
     * ⚠️ 别拿它当「配置读成功了吗」用：那件事看 [load] 的分支
     * （读失败时这里给的默认端口看起来**和成功一模一样**）。
     */
    fun port(context: Context): Int {
        val loaded = load(context) as? Loaded.Ok ?: return AppPrefs.DEFAULT_PORT
        return loaded.config.optJSONObject("server")?.optInt("port", AppPrefs.DEFAULT_PORT)
            ?: AppPrefs.DEFAULT_PORT
    }

    /**
     * **首次运行**：把老版本存在 [AppPrefs] 里的端口搬进 `config.json`，并顺手把文件建出来。
     *
     * ⚠️★ 为什么必须搬：端口现在是**配置文件**说了算（[ServerBridge.start] 不再收端口参数，
     * 见它那段注释）。老版本里那个「界面上的端口」如果不搬过来，用户升完级会发现
     * **端口变回了 9501** —— 而别的设备上填的地址全都连不上，且两边都不报错。
     *
     * ⚠️★ 只在**文件不存在**时动手，而且**只做这一次**：文件已经在 = 用户（或服务端自己）
     * 已经有一份配置了，这时候再拿旧端口去覆盖，就是「升一次级、端口被改回去一次」。
     *
     * ⚠️ 失败**不抛**也不提示：这一步是尽力而为的补课。真失败的话端口就是默认值，
     * 而用户打开配置页会看到那个值 —— 他不会以为「端口被谁改过」。
     */
    fun ensureCreated(context: Context) {
        if (File(path(context)).exists()) return
        val loaded = load(context) as? Loaded.Ok ?: return
        val config = loaded.config
        val server = config.optJSONObject("server") ?: JSONObject().also { config.put("server", it) }
        server.put("port", AppPrefs.port(context))
        save(context, config)
    }
}
