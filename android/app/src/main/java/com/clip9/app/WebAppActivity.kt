package com.clip9.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.security.MessageDigest

/**
 * 网页界面：**一个全屏 WebView** 加载服务端地址。
 *
 * ⚠️★ 它加载的是**地址**，不是打进 App 里的那份产物 —— 理由见
 * `dev-docs/specs/android-client.md` §1.1（`web-vue3/src/base.js` 的 `APP_BASE` 是从
 * `document.baseURI` 推的，页面不是从服务端那个 origin 加载时，axios / WS 的地址会全打错，
 * 而症状是「静态资源正常、服务端一条请求都收不到」）。
 *
 * ⚠️ 本机与远端在这个 Activity 眼里**是同一件事**，差别只有 URL ——
 * 所以明文 HTTP、自签证书、返回键、外链这一套只需要写一遍（设计稿 §2）。
 *
 * ⚠️★ 分享进来的东西**由这里投递**（`window.clip9Share`，契约见 §4）：
 * 从「收到 Intent」（[MainActivity]）到「SPA 能收」之间隔着起服务端 + 加载页面 + 连上 WS，
 * 所以 payload 先落在 [PendingShare] 里，这里等 `isReady()` 再递。
 * ⚠️ 页面是谁的（本机 / 远端）不影响这件事：投递永远打到**当前正在看的那个**服务端上。
 *
 * ⚠️★ **免打开界面认证**（2026-09-29 加）分两步，第一步在这里：
 * 如果打开的是清单里某一台、而且它开着「打开前自动认证」并有保存的密码，
 * 那就**先用密码换一张会话令牌，换到了再 `loadUrl`**；页面来问的时候
 * （[AuthBridge.roomAuth]，SPA 在 `store/websocket.js` 里读凭据时调）立刻给它。
 * 第二步（读桥）在 SPA 那一侧 —— 两边的方法名与键名**逐字对应**，
 * 由 `tools/android-contract-smoke.mjs` 的一条判据盯着。
 *
 * ⚠️★ 为什么不走「改写服务端下发的 HTML」那条路（用 `shouldInterceptRequest` 自己拿主文档、
 * 往 `<head>` 里塞一段写 `sessionStorage` 的脚本）：那要**自己重放**一次 HTTP
 * （状态码、重定向、gzip、编码、以及**自签证书的确认**全都得自己处理一遍），
 * 而任何一处没重放对，症状都是「界面白了」或者「证书对话框不出现了」。
 * 让 SPA 主动问一句要小得多、也可靠得多。
 */
class WebAppActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TITLE = "title"

        /**
         * 打开的是清单里的哪一台（可空）。
         *
         * ⚠️ 有它才能「打开前自动认证」，也能让「已登录 / 要密码」那个状态
         * 跟着**这一台**走，而不是全局一个布尔。
         */
        const val EXTRA_SERVER_ID = "serverId"

        /**
         * 交给页面的那个对象名。
         *
         * ⚠️★ 必须与 SPA 那边读的名字**逐字一致**（`web-vue3/src/store/websocket.js`）。
         * 对不上的症状是**什么都没发生** —— 不报错、不提示，只是又被问了一次密码。
         */
        private const val AUTH_BRIDGE = "clip9Auth"

        /**
         * 默认房间在凭据缓存里的键。
         *
         * ⚠️★ 与 SPA 的 `getRoomStorageKey` 逐字对应：默认房间是 `__default__`，
         * **不是**空串、也不是 `default`（那边 `normalizeRoomName` 先把 `default` 变成空串）。
         * 对不上 = 令牌在缓存里躺着一个谁都不会去读的键。
         */
        private const val DEFAULT_ROOM_KEY = "__default__"

        /**
         * 等 SPA 就绪的上界。
         *
         * ⚠️★ 必须有上界：`isReady()` 为假的原因可能是「还没连上」，也可能是
         * 「这个页面根本没有那个桥」（旧的缓存产物、分享页 `/s/<token>` 没有房间）——
         * 而**等一个永远不会来的东西**对用户来说和卡死没区别。
         * ⚠️ 超时要**说出声**，别静默把这次分享吞掉。
         */
        private const val READY_TIMEOUT_MS = 20_000L

        /** 就绪探测的间隔。⚠️ 它是一次 `evaluateJavascript`，别调太密。 */
        private const val PROBE_INTERVAL_MS = 250L

        /**
         * 从「把 payload 递给 SPA」到「拿到 `{ok, reason}`」的上界。
         * ⚠️ 这条比就绪那条宽：发一条文本要等一次 HTTP 往返 + 服务端落盘。
         */
        private const val RESULT_TIMEOUT_MS = 20_000L

        /**
         * 就绪探测。
         *
         * ⚠️ `onPageFinished` **不代表** SPA 挂载完了（Vue 挂载、WS 连上都在后面），
         * 所以这里只能轮询 —— 这正是设计稿 §4 第 1 条要的那个东西。
         *
         * ⚠️★ 这两段 JS 必须待在 `companion object` 里：`const val` 只许出现在
         * 顶层 / `object` / `companion object` 三处，写进类体是编不过的
         * （`Const 'val' is only allowed on top level, in named objects, or in companion objects`）。
         * 2026-09-28 真踩过 —— 它们当初是紧挨着下面那几个属性写的。
         */
        private const val PROBE_READY_JS =
            "(function(){try{return !!(window.clip9Share&&typeof window.clip9Share.isReady==='function'&&window.clip9Share.isReady());}catch(e){return false;}})()"

        /**
         * 读回投递结果。
         *
         * ⚠️ `evaluateJavascript` **不能**等 Promise，所以结果是「写在一个全局变量上、
         * 由这边轮询取走」。取走时就地清掉（`undefined`），免得下一轮读到旧结果。
         * ⚠️ 返回的是**对象**（不是 JSON 字符串）：那样 WebView 回给我们的就是
         * `{"ok":true}` 本身，不用再解一层字符串转义。
         */
        private const val READ_RESULT_JS =
            "(function(){var v=window.__clip9ShareResult;if(v===undefined)return null;try{window.__clip9ShareResult=undefined;return JSON.parse(v);}catch(e){return null;}})()"
    }

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorText: TextView

    private val main = Handler(Looper.getMainLooper())

    /** 只允许在这一台主机内导航；别的都交给系统（见 [shouldStayInside]）。 */
    private var baseHost: String? = null

    /**
     * 已经换好的凭据，形如 `{"<房间键>":{"token":"…","expiresAt":…}}`；没换到就是 null。
     *
     * ⚠️ `@Volatile`：写它的是主线程（网络回来之后），读它的是
     * WebView 那个 JS 线程（[AuthBridge.roomAuth] 被页面调用时）。
     */
    @Volatile
    private var authCache: String? = null

    /** 等就绪已经等了多久（毫秒）。⚠️ 每次开始投递归零。 */
    private var waitedMs = 0L

    /** 正在投递中（防重入：`onPageFinished` 会因为页内跳转再来一次）。 */
    private var delivering = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_webapp)

        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        val serverId = intent.getStringExtra(EXTRA_SERVER_ID).orEmpty()
        title = intent.getStringExtra(EXTRA_TITLE) ?: getString(R.string.app_name)

        webView = findViewById(R.id.webView)
        progress = findViewById(R.id.webProgress)
        errorText = findViewById(R.id.webError)

        if (url.isEmpty()) {
            // ⚠️ 没给地址就直说，别留一片白屏让用户以为「加载失败」。
            progress.visibility = View.GONE
            errorText.visibility = View.VISIBLE
            errorText.text = getString(R.string.remote_empty)
            return
        }
        baseHost = Uri.parse(url).host

        webView.settings.apply {
            javaScriptEnabled = true
            // ⚠️★ 必须开：SPA 用 `localStorage`（语言键）与 `sessionStorage`（房间凭据缓存）。
            // 关掉的表现是「语言改不回去、密码房间每次都要重输」——看起来像 SPA 的 bug。
            domStorageEnabled = true
            // ⚠️ 这个 WebView 只该加载服务端给的页面，没有任何理由碰本机文件。
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }

        webView.webViewClient = object : WebViewClient() {

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = handleNavigation(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
                // ⚠️ 用真实落地的地址更新「同源」判断：服务端可能带前缀（`server.prefix`）。
                view.url?.let { baseHost = Uri.parse(it).host }
                // ⚠️ 这里只是「主文档加载完了」——**不代表** SPA 已经能收东西，
                // 所以下面是「开始等」，不是「开始投递」。
                startDelivering()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                // ⚠️ 只报**主文档**的错：子资源（一张图、一个 chunk）失败不该把整页判死，
                // 否则界面会显示「加载失败」而页面其实好好地在那儿。
                if (!request.isForMainFrame) return
                progress.visibility = View.GONE
                errorText.visibility = View.VISIBLE
                errorText.text = "${error.errorCode} ${error.description}\n${request.url}"
            }

            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: SslError,
            ) {
                askAboutCertificate(handler, error)
            }
        }

        // ⚠️★ 桥必须在 `loadUrl` **之前**装上：装晚了页面已经跑过一轮，
        // 而它对凭据**只问一次**（SPA 的 pinia store 第一次实例化时）。
        // ⚠️ 它是**只读**的一个方法，见 [AuthBridge] 的注释。
        webView.addJavascriptInterface(AuthBridge(), AUTH_BRIDGE)

        // ⚠️★ 先换令牌、换到了再加载 —— 见类文档那一段。
        // 没配（或者这台没保存密码 / 关掉了自动认证）就直接加载：
        // 那就是这次改动**之前**的行为，用户在网页里自己输密码。
        //
        // ⚠️ 这里只传 `serverId` 进来、密码**不进 Intent**：Intent 的 extras
        // 在 `dumpsys activity` 里是明文可读的，而密码不该出现在那儿。
        val server = serverId.takeIf { it.isNotEmpty() }?.let { id ->
            RemoteServers.load(this).servers.firstOrNull { it.id == id }
        }
        if (server != null && server.autoAuth && server.password.isNotEmpty()) {
            preAuthThenLoad(server, url)
        } else {
            // ⚠️ 每次重建都重新加载：让 WebView 自己扛恢复状态比在这里猜它恢复得对不对更省事，
            // 而 SPA 的状态本来就在 URL / localStorage 里。
            webView.loadUrl(url)
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    // ⚠️ 先在页面里退，退到头才退出这个页面 —— 否则用户按一次就回到了管理页。
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
    }

    override fun onDestroy() {
        // ⚠️ 必须撤掉：那两个 Runnable 里抓着 webView，页面没了还往里
        // `evaluateJavascript` 会得到一堆看不懂的报错（而且是在 Activity 已经死了之后）。
        main.removeCallbacks(probeReady)
        main.removeCallbacks(resultPoll)
        delivering = false
        super.onDestroy()
    }

    // ── 免打开界面认证（第一步：先在原生侧换好令牌）─────────────────────

    /**
     * 先用保存的密码换一张会话令牌，**换到了再加载页面**。
     *
     * ⚠️★ 顺序不能反。SPA 在启动时就会读一次凭据（`store/websocket.js` 的
     * `loadRoomAuthCache`，它进 pinia store 的初始 state）—— 而**页面开始加载之后**
     * 再去准备那份凭据，时序是不保证的：早一点、晚一点都有可能，
     * 晚一点的表现就是「还是被问了一次密码」，而且**时好时坏**。
     * 先把令牌攥在手里，等页面来问时立刻给（[AuthBridge.roomAuth]），这个竞态就不存在了。
     *
     * ⚠️★ 换不到**不拦着打开**：照常进网页界面、在里面手输密码 ——
     * 那正是这次改动之前的行为，不能因为「自动」那一步失败就让整个界面进不去。
     * 只是把原因说一句，不然用户不明白为什么又被问了密码。
     *
     * ⚠️ 网络请求不能在主线程（超时上界 8 秒，冻在那儿用户会以为死了）。
     */
    private fun preAuthThenLoad(server: RemoteServer, url: String) {
        Thread(
            {
                val result = AuthClient.requestToken(server.url, server.room, server.password)
                main.post {
                    // ⚠️ 回来时页面可能已经被关掉了（用户按了返回）。
                    if (isFinishing || isDestroyed) return@post
                    when (result) {
                        is AuthClient.Result.Ok -> authCache = cacheOf(server.room, result)
                        is AuthClient.Result.Failed ->
                            toast(getString(R.string.auto_auth_failed, result.message))
                    }
                    webView.loadUrl(url)
                }
            },
            "clip9-auth",
        ).start()
    }

    /**
     * 拼成 SPA 认的那一份凭据缓存。
     *
     * ⚠️★ 房间名要先归一化，而且规则必须与 SPA 的 `normalizeRoomName` **完全一致**：
     * 那边把 `default` 变成空串，再由 `getRoomStorageKey` 变成 `__default__`。
     * 这里少一步的后果是令牌落在一个**谁都不会去读的键**上 ——
     * 界面照常打开、照常问密码，而没有任何地方能看出「其实换到了」。
     */
    private fun cacheOf(room: String, ok: AuthClient.Result.Ok): String {
        val trimmed = room.trim()
        val key = if (trimmed.isEmpty() || trimmed == "default") DEFAULT_ROOM_KEY else trimmed
        return JSONObject()
            .put(
                key,
                JSONObject()
                    .put("token", ok.token)
                    .put("expiresAt", ok.expiresAt),
            )
            .toString()
    }

    /**
     * 交给页面的那个对象：**只有一个只读方法**。
     *
     * ⚠️★ 每多一个方法就是多开一个「网页能指挥外壳做什么」的口子 ——
     * 而这个 WebView 加载的是**别人的**服务端下发的页面（清单里那一台可能是远端）。
     * 所以这里只有「把已经换好的令牌读出去」这一件事，没有写、没有发请求、没有读文件。
     *
     * ⚠️ 它能被**任何**加载进来的页面调到（同主机的页面都在返回键与导航的白名单里）。
     * 这是可以接受的：那些页面本来就读得到自己的 `sessionStorage`。
     * 真正的边界是 [shouldStayInside]（外站点一律轰到系统浏览器），不是这个桥。
     *
     * ⚠️ `@JavascriptInterface` **不是可选的**：API 17 起，没有这个注解的方法
     * 不会被暴露给页面 —— 少了它的症状还是「什么都没发生」。
     *
     * ⚠️ 返回**字符串**（不是对象）：`addJavascriptInterface` 的返回值只能是
     * 基本类型与 String，复杂类型要自己序列化（页面那一侧再 `JSON.parse`）。
     */
    private inner class AuthBridge {
        @JavascriptInterface
        fun roomAuth(): String? = authCache
    }

    // ── 分享投递（外壳 → SPA）────────────────────────────────────────────

    /**
     * 开始等 SPA 就绪，然后把 [PendingShare] 里的东西一条条递进去。
     *
     * ⚠️ 幂等：`onPageFinished` 会因为页内跳转再来一次，而那时可能已经投过半条了。
     * 用 [delivering] 挡住重入 —— 但**不是**「投完就不再投」：还有排队的话要继续。
     */
    private fun startDelivering() {
        if (delivering || !PendingShare.has()) {
            return
        }
        delivering = true
        waitedMs = 0L
        main.post(probeReady)
    }

    /**
     * 就绪探测的循环。⚠️ 用 `postDelayed` 而不是 `sleep` —— 这条跑在主线程上。
     */
    private val probeReady = object : Runnable {
        override fun run() {
            if (isFinishing || isDestroyed) {
                delivering = false
                return
            }
            if (!PendingShare.has()) {
                // 别人（或上一次超时）已经清空 → 收工。
                delivering = false
                return
            }
            webView.evaluateJavascript(PROBE_READY_JS) { value ->
                if (value == "true") {
                    deliverNext()
                } else {
                    waitedMs += PROBE_INTERVAL_MS
                    if (waitedMs >= READY_TIMEOUT_MS) {
                        // ⚠️★ 超时要**说出来**：静默丢掉这次分享的话，
                        // 用户看到的就只是「我明明分享过来了，剪贴板里什么都没有」。
                        PendingShare.clear()
                        delivering = false
                        toast(getString(R.string.share_timeout))
                    } else {
                        main.postDelayed(this, PROBE_INTERVAL_MS)
                    }
                }
            }
        }
    }

    /** 递下一条：把 payload 交给 `window.clip9Share.sendText`，然后等它的结果。 */
    private fun deliverNext() {
        val payload = PendingShare.poll()
        if (payload == null) {
            delivering = false
            return
        }
        webView.evaluateJavascript(deliverJs(payload.text), null)
        waitedMs = 0L
        main.post(resultPoll)
    }

    /** 等 `window.__clip9ShareResult`。 */
    private val resultPoll = object : Runnable {
        override fun run() {
            if (isFinishing || isDestroyed) {
                delivering = false
                return
            }
            webView.evaluateJavascript(READ_RESULT_JS) { value ->
                // ⚠️ 没答复时 WebView 给的是字符串 `"null"` 或者真的 null，
                // 两种都要当成「还没好」。
                if (value == null || value == "null") {
                    waitedMs += PROBE_INTERVAL_MS
                    if (waitedMs >= RESULT_TIMEOUT_MS) {
                        delivering = false
                        toast(getString(R.string.share_failed))
                    } else {
                        main.postDelayed(this, PROBE_INTERVAL_MS)
                    }
                    return@evaluateJavascript
                }
                reportResult(value)
                // ⚠️ 还有排队的就继续递，别一起丢掉。
                if (PendingShare.has()) {
                    main.post(probeReady)
                } else {
                    delivering = false
                }
            }
        }
    }

    /**
     * 拼投递用的 JS。
     *
     * ⚠️★ 正文用 `JSONObject.quote` 转义后再拼进去：它可能是任意用户文本
     * （带引号、反斜杠、换行、甚至 `</script>`），手拼字符串就是一个注入口子。
     * ⚠️ 写成 `Promise.resolve(...).then(...)` 是因为 `evaluateJavascript` **不等 Promise** ——
     * 结果必须落到一个全局变量上由这边轮询取（见 [READ_RESULT_JS]）。
     */
    private fun deliverJs(text: String): String {
        val quoted = JSONObject.quote(text)
        return "(function(){" +
            "var done=function(r){try{window.__clip9ShareResult=JSON.stringify(r);}" +
            "catch(e){window.__clip9ShareResult='{\"ok\":false,\"reason\":\"server-error\"}';}};" +
            "try{" +
            "if(!window.clip9Share||typeof window.clip9Share.sendText!=='function'){" +
            "done({ok:false,reason:'not-ready'});return;}" +
            "Promise.resolve(window.clip9Share.sendText($quoted)).then(done,function(e){" +
            "done({ok:false,reason:'server-error',message:String(e)});});" +
            "}catch(e){done({ok:false,reason:'server-error',message:String(e)});}" +
            "})();"
    }

    /** 把 SPA 回的 `{ok, reason, message}` 说给用户听。 */
    private fun reportResult(raw: String) {
        val result = try {
            JSONObject(raw)
        } catch (t: Throwable) {
            // ⚠️ 解析不了 = 没听懂。别当成成功。
            null
        }
        if (result == null) {
            toast(getString(R.string.share_failed))
            return
        }
        if (result.optBoolean("ok", false)) {
            toast(getString(R.string.share_sent))
            return
        }
        val reason = result.optString("reason").takeIf { it.isNotEmpty() }
        val message = result.optString("message").takeIf { it.isNotEmpty() }
        toast(getString(R.string.share_failed_reason, shareReasonText(reason, message)))
    }

    /**
     * reason 键 → 文案。
     *
     * ⚠️★ 下面这张表与 `web-vue3/src/share.js` 的 `SHARE_REASONS` **逐键对应** ——
     * 那边回的是**稳定键**（不是句子），译文只有两边各存一份这一种做法才不会漂
     * （SPA 的四份 locale 里有它自己的界面文案，而这几句是给**外壳**说的）。
     * `tools/share-bridge-smoke.mjs` 对着这两处逐字比；加一个键要两边一起加。
     *
     * ⚠️★ `else` 分支**把键原样显示出来**，不要静默成一句「发送失败」：
     * 以后 SPA 加了一个壳还不认识的键时，这句话是唯一能看出「是哪个键」的地方。
     */
    private fun shareReasonText(reason: String?, message: String?): String = when (reason) {
        "not-ready" -> getString(R.string.share_reason_not_ready)
        "no-room" -> getString(R.string.share_reason_no_room)
        "empty" -> getString(R.string.share_reason_empty)
        "files-unsupported" -> getString(R.string.share_files_unsupported)
        "server-error" -> message?.takeIf { it.isNotBlank() }
            ?: getString(R.string.share_reason_server_error)
        else -> getString(R.string.share_reason_unknown, reason ?: "")
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    /** 这条链接该在 WebView 里加载（返回 false），还是交给系统（返回 true）。 */
    private fun handleNavigation(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase().orEmpty()
        if ((scheme == "http" || scheme == "https") && shouldStayInside(uri)) return false
        return openExternally(uri)
    }

    /**
     * 同主机（或本机回环）的链接留在 WebView 里。
     *
     * ⚠️★ 别写成「什么都留在里面」：分享链接外面套着的第三方站点、以及别的服务端，
     * 在这个壳里打开会丢地址栏和返回键（用户退不出去）。
     * ⚠️ 也别写成「什么都轰出去」：那样分享页一跳转就跑到浏览器里，看板用不了。
     */
    private fun shouldStayInside(uri: Uri): Boolean {
        val host = uri.host ?: return false
        if (host == "127.0.0.1" || host == "localhost") return true
        return host == baseHost
    }

    /** 交给系统打开（`mailto:` / `tel:` / 别的站点）。返回 true = 已处理。 */
    private fun openExternally(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (e: ActivityNotFoundException) {
            // 没有能处理它的 App —— 留在原地（返回 false 会让 WebView 自己试着加载，
            // 结果是又一个看不懂的 `ERR_UNKNOWN_URL_SCHEME` 页面）。
            android.util.Log.w("clip9", "没有 App 能打开 $uri", e)
            true
        }
    }

    /**
     * 自签证书的确认。
     *
     * ⚠️★ 默认**不**放行：无条件 `proceed()` 等于把 TLS 校验关掉（MITM 就成立了）。
     * 而 WebView 里**没有**浏览器那个「高级 → 继续前往」的入口，所以不给对话框的话
     * 用户唯一的办法是去改服务端 —— 那更糟。
     *
     * ⚠️ 做法是「显示指纹 + 逐条确认」，**不做**「记住这个决定」的开关
     * （那和 `proceed()` 没区别）。设计稿 §3.2。
     *
     * ⚠️ 更好的路是让用户把自签 CA 装进系统/用户证书库 —— 那样根本不会走到这里
     * （`network_security_config.xml` 里已经放开了 `src="user"`）。
     */
    private fun askAboutCertificate(handler: SslErrorHandler, error: SslError) {
        progress.visibility = View.GONE
        AlertDialog.Builder(this)
            .setTitle(R.string.ssl_title)
            .setMessage(
                getString(
                    R.string.ssl_message,
                    error.primaryError.toString(),
                    fingerprintOf(error),
                ),
            )
            .setPositiveButton(R.string.ssl_continue) { _, _ -> handler.proceed() }
            .setNegativeButton(R.string.ssl_cancel) { _, _ -> handler.cancel() }
            .setCancelable(false)
            .show()
    }

    /** 证书的 SHA-256 指纹。 */
    private fun fingerprintOf(error: SslError): String {
        val certificate = error.certificate ?: return "（取不到证书）"
        return try {
            // ⚠️ `SslCertificate` 没有公开「取 DER 字节」的接口 ——
            // `saveState()` 那个 Bundle 里的 `"x509-certificate"` 键是**事实上**的取法
            // （AOSP 自己就是这么存的）。拿不到就退回证书的可读描述，至少不是空白。
            val der = android.net.http.SslCertificate.saveState(certificate)
                ?.getByteArray("x509-certificate")
                ?: return certificate.toString()
            MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }
        } catch (t: Throwable) {
            certificate.toString()
        }
    }
}
