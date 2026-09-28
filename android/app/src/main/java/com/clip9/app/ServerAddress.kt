package com.clip9.app

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * 本机服务端的两个地址。
 *
 * ⚠️★ 这两个**不是一回事**，别混用：
 *
 * - [loopbackUrl]（`127.0.0.1`）：WebView 打开**本机界面**用。设计稿 §2 定的是这个。
 * - [lanUrl]（局域网 IP）：**显示给用户、给别的设备用**的那个地址（二维码也编它）。
 */
object ServerAddress {

    /** WebView 打开本机界面用的地址。 */
    fun loopbackUrl(port: Int): String = "http://127.0.0.1:$port/"

    /**
     * 局域网地址（拼成 `http://<ip>:<port>/`）。
     *
     * 找不到就返回 null —— ⚠️ **不要**兜底成 `http://0.0.0.0:…`（Go 版那么干过）：
     * `0.0.0.0` 不是「任何人都能连的地址」，把它显示出来只会让用户把一串
     * **永远连不上**的东西抄到别的设备上，而两边都不报错。
     */
    fun lanUrl(port: Int): String? = lanIpv4()?.let { "http://$it:$port/" }

    /**
     * 找一个「别的设备能连上」的 IPv4。
     *
     * 优先私网段（`10.` / `172.16-31.` / `192.168.`）—— 那是家里/办公室的局域网，
     * 也正是这个 App 的用法。找不到私网地址时退而求其次，返回第一个非回环的非链路本地地址。
     */
    fun lanIpv4(): String? {
        return try {
            var fallback: String? = null
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return null
            for (nic in interfaces) {
                // ⚠️ 跳过回环与虚拟网卡（VPN / Docker / 模拟器的虚拟网段会在这里冒出来，
                // 而它们给出的地址别的设备连不上）。
                if (!nic.isUp || nic.isLoopback || nic.isVirtual) continue
                for (address in nic.inetAddresses) {
                    // IPv6 也可能被列出来（`hostAddress` 还带 `%wlan0` 这种 scope），只要 v4。
                    val v4 = address as? Inet4Address ?: continue
                    if (v4.isLoopbackAddress || v4.isLinkLocalAddress) continue
                    val ip = v4.hostAddress ?: continue
                    if (isPrivate(ip)) return ip
                    if (fallback == null) fallback = ip
                }
            }
            fallback
        } catch (t: Throwable) {
            // 取地址失败不该让界面崩 —— 大不了这次不显示地址。
            null
        }
    }

    /** 私网段（RFC 1918）。 */
    private fun isPrivate(ip: String): Boolean {
        if (ip.startsWith("10.")) return true
        if (ip.startsWith("192.168.")) return true
        if (ip.startsWith("172.")) {
            val second = ip.split('.').getOrNull(1)?.toIntOrNull() ?: return false
            return second in 16..31
        }
        return false
    }

    /** 别的地方要用到「这是不是一个合法的 http(s) 地址」。 */
    fun isHttpUrl(value: String): Boolean {
        val v = value.trim()
        return v.startsWith("http://") || v.startsWith("https://")
    }

    /** 把用户填的地址补成 URL（没写协议就补 `http://`，与 Go 版同一个默认）。 */
    fun normalize(value: String): String {
        val v = value.trim()
        if (v.isEmpty()) return v
        return if (isHttpUrl(v)) v else "http://$v"
    }
}
