package com.clip9.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.security.MessageDigest

/**
 * 网页界面：**一个全屏 WebView** 加载服务端地址。
 *
 * ⚠️★ 它加载的是**地址**，不是打进 App 里的那份产物 —— 理由见
 * `docs/specs/android-client.md` §1.1（`web-vue3/src/base.js` 的 `APP_BASE` 是从
 * `document.baseURI` 推的，页面不是从服务端那个 origin 加载时，axios / WS 的地址会全打错，
 * 而症状是「静态资源正常、服务端一条请求都收不到」）。
 *
 * ⚠️ 本机与远端在这个 Activity 眼里**是同一件事**，差别只有 URL ——
 * 所以明文 HTTP、自签证书、返回键、外链这一套只需要写一遍（设计稿 §2）。
 */
class WebAppActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TITLE = "title"
    }

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorText: TextView

    /** 只允许在这一台主机内导航；别的都交给系统（见 [shouldStayInside]）。 */
    private var baseHost: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_webapp)

        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
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

        // ⚠️ 每次重建都重新加载：让 WebView 自己扛恢复状态比在这里猜它恢复得对不对更省事，
        // 而 SPA 的状态本来就在 URL / localStorage 里。
        webView.loadUrl(url)

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
