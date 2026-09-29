package com.clip9.app

import android.content.Context

/**
 * App 自己的偏好（**不是**服务端配置）。
 *
 * ⚠️★ 2026-09-29 之后这里**只剩两个老键**，而且都只在「从老版本升上来」那一次被读：
 *
 * - `port` —— 由 [ServerConfigStore.ensureCreated] 读，搬到 `config.json` 的 `server.port`；
 * - `remoteUrl` —— 由 [RemoteServers.migrateLegacyRemoteUrl] 读，搬成服务器清单里的第一台。
 *
 * ⚠️★ 为什么必须搬走：两者原来都住在这里，于是**同一个事实有了两份**，
 * 而两份一定会漂（改了一边、另一边还是旧的）。现在：
 *
 * - **端口只有一处权威** = `config.json`（[ServerBridge.start] 也**不再收端口参数**）；
 * - 远端地址是**多台**的清单，一个字符串本来就装不下。
 *
 * ⚠️ 别把新东西加回这个文件：它现在是一个「历史遗留键的读取口」。
 * 要新开存储就新开一个**文件名**（像 [RemoteServers] 那样）——
 * 两个不相干的东西共用一个 `SharedPreferences` 的后果是「清一下 A，B 也没了」。
 */
object AppPrefs {
    private const val FILE = "clip9"

    /** 与 Go 版同一个默认端口。⚠️ 现在只在**迁移**那一步用得上。 */
    const val DEFAULT_PORT = 9501

    private const val KEY_PORT = "port"
    private const val KEY_REMOTE_URL = "remoteUrl"

    private fun prefs(context: Context) =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /**
     * 老版本存在这里的端口。
     *
     * ⚠️★ 它**不再是**服务端会监听的那个端口 —— 那个在 `config.json` 里，
     * 服务端只从那儿读。这个值现在的唯一读者是 [ServerConfigStore.ensureCreated]。
     * ⚠️ 所以**没有配套的 setter**：写它的地方（配置页）应该写 `config.json`，
     * 两边都写就又变成了「同一个事实两份」，而那正是这次改动要消灭的东西。
     */
    fun port(context: Context): Int = prefs(context).getInt(KEY_PORT, DEFAULT_PORT)

    /**
     * 老版本存在这里的**单个**远端地址。
     *
     * ⚠️ 现在的唯一读者是 [RemoteServers.migrateLegacyRemoteUrl]，而且它搬完就
     * 把它清成空串 —— 不清的话「用户把清单清空」之后下一次启动又会凭空冒出一台。
     */
    fun remoteUrl(context: Context): String =
        prefs(context).getString(KEY_REMOTE_URL, "").orEmpty()

    /** ⚠️ 只给**迁移**用（把老键清掉），不是「设置远端地址」的入口。 */
    fun setRemoteUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_REMOTE_URL, url).apply()
    }
}
