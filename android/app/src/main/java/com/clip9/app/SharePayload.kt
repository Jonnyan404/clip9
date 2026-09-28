package com.clip9.app

import android.content.Intent

/**
 * 「分享进来的东西」这条链路上的三个小东西。
 *
 * ⚠️ 它们放在同一个文件里，是因为它们都不值得单独一个文件、而且**只有一起看才说得清**：
 * 解析（[ShareIntent]）→ 暂存（[PendingShare]）→ 投递（[WebAppActivity]）。
 *
 * 契约在 `docs/specs/android-client.md` §4；SPA 那一侧是 `web-vue3/src/share.js`。
 *
 * ⚠️★ **只支持文本**。文件那条路（`EXTRA_STREAM` / `ACTION_SEND_MULTIPLE`）还没做 ——
 * 原因不是懒：WebView 里拿不到文件路径，而 SPA 的上传路径要真正的 `File`。
 * ⚠️ 所以 `AndroidManifest.xml` 里的 `intent-filter` **只声明 `text/plain`** ——
 * 声明了 `image/*` 就会让用户在相册的分享面板里看到 clip9，点进来却只能说「还没做」。
 * 那比「分享面板里没有 clip9」更糟。
 */

/** 一次分享携带的正文。 */
data class SharePayload(val text: String)

/** 把 `Intent` 读成 [SharePayload]。 */
object ShareIntent {

    /**
     * 解析。不是分享、或者没有正文 → `null`（调用方当没发生）。
     *
     * ⚠️ **不 trim**：与界面里点发送保持一致（`sendText` 那条路也不 trim）。
     * 只把「全是空白」当成空 —— 别的 App 常常在正文前面带一个换行，
     * 但那是**内容**，不是我们该悄悄改掉的东西。
     */
    fun parse(intent: Intent?): SharePayload? {
        if (intent == null || intent.action != Intent.ACTION_SEND) return null
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: return null
        if (text.isBlank()) return null
        return SharePayload(text)
    }

    /**
     * 是不是「一次我们认得出、但还没做的分享」（分享文件）。
     *
     * ⚠️ 要有这个判断：用户从相册分享一张图时，如果 App 什么都不说就退了，
     * 那看起来就是「clip9 坏了」。这里至少回一句话。
     * ⚠️ 正常情况下走不到：manifest 里只声明了 `text/plain`，
     * 而别的 App 有可能会**忽略** mimeType 直接发 `ACTION_SEND` 带一个 stream。
     */
    fun isUnsupportedShare(intent: Intent?): Boolean {
        if (intent == null) return false
        val isShare = intent.action == Intent.ACTION_SEND ||
            intent.action == Intent.ACTION_SEND_MULTIPLE
        if (!isShare) return false
        if (intent.getCharSequenceExtra(Intent.EXTRA_TEXT) != null) return false
        return intent.hasExtra(Intent.EXTRA_STREAM)
    }
}

/**
 * 还没投递出去的那几次分享。
 *
 * ⚠️★ **为什么要有它**：冷启动分享时（App 根本没在跑），从「收到 Intent」到
 * 「SPA 就绪」之间隔着**起服务端 + 加载页面 + 连上 WS**，中间任何一步都不该让这次分享丢掉。
 * 设计稿 §4 第 2 条要的就是这个。
 *
 * ⚠️ 为什么不是单个槽位：连着分享两次（第二下在第一下投递完之前）时，
 * 单槽位会**悄悄丢掉第一次**。用队列就都不会丢。
 * ⚠️ 但队列**要有上界**：这是「还没送出去的东西」，无限攒只会在出错时越攒越多。
 */
object PendingShare {

    /** 上界。⚠️ 到顶了丢**最旧**的（新的那次才是用户刚做的动作）。 */
    private const val MAX = 8

    private val queue = ArrayDeque<SharePayload>()

    @Synchronized
    fun hold(payload: SharePayload) {
        if (queue.size >= MAX) {
            queue.removeFirst()
        }
        queue.addLast(payload)
    }

    @Synchronized
    fun has(): Boolean = queue.isNotEmpty()

    /** 取走最旧的那一条。投递失败时**不要再放回来** —— 会无限重投。 */
    @Synchronized
    fun poll(): SharePayload? = queue.removeFirstOrNull()

    @Synchronized
    fun size(): Int = queue.size

    @Synchronized
    fun clear() {
        queue.clear()
    }
}
