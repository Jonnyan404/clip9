package com.clip9.app

import android.content.Context

/**
 * App 自己的偏好（**不是**服务端配置）。
 *
 * ⚠️★ 「存储键只有一处」：管理页与前台服务都要读端口/远端地址，
 * 两边各写一遍字符串 key 的后果是「改了一处、另一处读不到」——
 * 而症状是「端口填了不生效」这种没法一眼看出来的事。所以键名全在这个文件里。
 *
 * ⚠️ 这里的端口是**启动参数**，会覆盖配置文件里那个 `server.port`
 * （见 `crates/android/src/lib.rs` 的 `nativeStart`）：它必须在服务端起起来**之前**就知道，
 * 所以不能只存在配置文件里。服务端**真正**监听的是 `ServerBridge` 报的那个地址。
 *
 * ⚠️ 服务端自己的配置（密码、历史条数、大小限制…）**不在**这里，在 `filesDir/config.json`。
 */
object AppPrefs {
    private const val FILE = "clip9"

    /** 与 Go 版同一个默认端口。 */
    const val DEFAULT_PORT = 9501

    private const val KEY_PORT = "port"
    private const val KEY_REMOTE_URL = "remoteUrl"

    private fun prefs(context: Context) =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun port(context: Context): Int = prefs(context).getInt(KEY_PORT, DEFAULT_PORT)

    fun setPort(context: Context, port: Int) {
        prefs(context).edit().putInt(KEY_PORT, port).apply()
    }

    /** 远端服务端的地址（空串 = 还没填过）。 */
    fun remoteUrl(context: Context): String =
        prefs(context).getString(KEY_REMOTE_URL, "").orEmpty()

    fun setRemoteUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_REMOTE_URL, url).apply()
    }
}
