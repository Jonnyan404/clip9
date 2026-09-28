package com.clip9.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.WebSettings
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter

/**
 * 原生管理页：启停本机服务端、显示局域网地址与二维码、切换「本机 / 远端」。
 *
 * ⚠️★ 它**不渲染看板** —— 看板是 [WebAppActivity] 里那个 WebView 加载服务端地址。
 * 别把两者混起来（设计稿 §2：别在 WebView 里嵌原生，也别让 WebView 成为唯一界面）。
 *
 * ⚠️★ 它**不镜像状态**：每一轮都问 [ServerBridge.status]（Rust 那边是唯一权威）。
 * Go 版把 `isRunning` 抄进了 Kotlin 的静态字段，于是「服务端已经挂了、界面还写着运行中」
 * 只能靠人去翻日志发现。这里的轮询是廉价的（一个 JNI 调用取锁读一个枚举），
 * 换来的是「界面永远与服务端一致」。
 *
 * ⚠️ 它**只**负责发 Intent 给 [ServerService]：服务端必须在**前台服务**里起，
 * 否则 App 一退到后台就可能被回收，而用户以为它还在跑。启停的阻塞调用也在那边（后台线程）。
 *
 * ⚠️★ 它也是**分享进来**的落点（manifest 里那个 `ACTION_SEND` 过滤器挂在它身上）：
 * 冷启动分享时服务端还没起来，必须先有个人把服务端起起来、再给 [WebAppActivity] 一个地址。
 * 那段绕路见 [handleShareIntent]。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        /** 轮询间隔。⚠️ 要短到「点了停止很快看到变化」，长到不浪费 —— 它只取锁读枚举。 */
        private const val POLL_MS = 700L

        private const val NOTIFICATION_PERMISSION_REQUEST = 11

        /** 低于这个 Chrome 大版本就在界面上提示「WebView 偏旧」（设计稿 §3.6）。 */
        private const val MIN_WEBVIEW_CHROME = 90
    }

    private val handler = Handler(Looper.getMainLooper())

    private lateinit var statusText: TextView
    private lateinit var powerButton: Button
    private lateinit var errorText: TextView
    private lateinit var libMissingText: TextView
    private lateinit var addressText: TextView
    private lateinit var addressActions: View
    private lateinit var qrImage: ImageView
    private lateinit var qrButton: Button
    private lateinit var portInput: EditText
    private lateinit var portNote: TextView
    private lateinit var remoteInput: EditText
    private lateinit var webViewVersionText: TextView
    private lateinit var dataDirText: TextView
    private lateinit var versionText: TextView

    /** 上一次真的画过的地址 —— 免得每 700ms 重算一次二维码。 */
    private var renderedAddress: String? = null

    /**
     * 「手上这次分享还没送进 WebView」。
     *
     * ⚠️★ 冷启动分享时（App 根本没在跑）服务端**还没起来**，所以这一刻不能直接开 WebView：
     * 先把它起起来，等 [refresh] 看到真的 RUNNING 了再开。
     * ⚠️ 用这个标志防重开：`refresh` 每 700ms 跑一次，不加标志就会一直往栈上叠 Activity。
     */
    private var waitingToDeliver = false

    private val poll = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, POLL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        bindViews()
        // ⚠️ 这里顺手把本地组件也读一次版本 —— 它同时是「.so 加载成功了吗」的第一次探针：
        // 失败的话下面 `refresh()` 会把原因显示在界面上，而不是等到用户点启动才炸。
        versionText.text = getString(R.string.version_format, appVersion(), ServerBridge.version())
        portInput.setText(AppPrefs.port(this).toString())
        remoteInput.setText(AppPrefs.remoteUrl(this))
        dataDirText.text = getString(R.string.data_dir, filesDir.absolutePath)

        powerButton.setOnClickListener { toggle() }

        portInput.setOnFocusChangeListener { _, hasFocus -> if (!hasFocus) savePort() }
        findViewById<Button>(R.id.portSaveButton).setOnClickListener {
            if (savePort()) toast(getString(R.string.port_saved))
        }

        findViewById<Button>(R.id.copyAddressButton).setOnClickListener { copyAddress() }
        findViewById<Button>(R.id.openLocalButton).setOnClickListener { openLocal() }
        qrButton.setOnClickListener { toggleQr() }

        findViewById<Button>(R.id.openRemoteButton).setOnClickListener { openRemote() }

        findViewById<Button>(R.id.batteryButton).setOnClickListener { requestBatteryWhitelist() }
        findViewById<Button>(R.id.webViewCheckButton).setOnClickListener { checkWebView() }

        askNotificationPermission()

        // ⚠️ 最后做：它可能只是 toast 一句（分享文件那条还没做），也可能去起服务端。
        // 放最后是为了「界面已经画好了」—— 起服务端要几秒，这段时间用户得看到东西。
        handleShareIntent(intent)
    }

    /**
     * ⚠️★ `launchMode="singleTop"` + 分享进来时走的是**这里**，不是 [onCreate] ——
     * 不实现它的话「App 已经开着时分享一段文本」会看起来什么都没发生。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // ⚠️ 必须 setIntent：不设的话 `getIntent()` 还是启动时那一个，
        // `onResume` 里再来一轮就会把同一次分享又处理一遍。
        setIntent(intent)
        handleShareIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        // ⚠️ 从 [WebAppActivity] 回来时状态可能已经变了（比如服务端在那边挂了）→ 立刻刷一次。
        refresh()
        handler.post(poll)
    }

    override fun onPause() {
        super.onPause()
        // ⚠️ 必须停：Activity 在后台还每 700ms 轮询是白耗电（用户能看见的后台耗电会被骂）。
        handler.removeCallbacks(poll)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST &&
            grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED
        ) {
            // ⚠️ 说清楚后果：服务端**照常运行**，只是通知栏里看不到它。
            // 不说的话用户会以为「没给权限 = 服务端起不来」。
            toast(getString(R.string.notification_denied))
        }
    }

    private fun bindViews() {
        statusText = findViewById(R.id.statusText)
        powerButton = findViewById(R.id.powerButton)
        errorText = findViewById(R.id.errorText)
        libMissingText = findViewById(R.id.libMissingText)
        addressText = findViewById(R.id.addressText)
        addressActions = findViewById(R.id.addressActions)
        qrImage = findViewById(R.id.qrImage)
        qrButton = findViewById(R.id.qrButton)
        portInput = findViewById(R.id.portInput)
        portNote = findViewById(R.id.portNote)
        remoteInput = findViewById(R.id.remoteInput)
        webViewVersionText = findViewById(R.id.webViewVersionText)
        dataDirText = findViewById(R.id.dataDirText)
        versionText = findViewById(R.id.versionText)
    }

    // ── 状态刷新 ───────────────────────────────────────────────────────

    private fun refresh() {
        val loadFailure = ServerBridge.loadFailure()
        libMissingText.visibility = if (loadFailure != null) View.VISIBLE else View.GONE
        if (loadFailure != null) libMissingText.text = getString(R.string.lib_missing, loadFailure)

        val status = ServerBridge.status()

        statusText.text = getString(R.string.status_label, getString(ServerBridge.statusLabelRes(status)))
        when (status) {
            ServerBridge.STATUS_RUNNING -> {
                powerButton.text = getString(R.string.action_stop)
                powerButton.isEnabled = true
            }
            ServerBridge.STATUS_IDLE -> {
                powerButton.text = getString(R.string.action_start)
                // ⚠️ 本地组件没加载成功时按钮必须是灰的 —— 点下去只会得到同一句话。
                powerButton.isEnabled = loadFailure == null
            }
            // ⚠️ 过渡态要**禁用**按钮：允许点的话用户会得到
            // 「服务端正在停止，请等它停完再启动」这种自找的错（Rust 那边如实拒绝了，
            // 但界面本来就不该让这件事发生）。
            else -> {
                powerButton.text = getString(R.string.action_busy)
                powerButton.isEnabled = false
            }
        }

        val error = ServerBridge.lastError()
        if (status == ServerBridge.STATUS_IDLE && !error.isNullOrBlank()) {
            errorText.visibility = View.VISIBLE
            errorText.text = error
        } else {
            errorText.visibility = View.GONE
        }

        val running = status == ServerBridge.STATUS_RUNNING
        val port = AppPrefs.port(this)
        val address = if (running) ServerAddress.lanUrl(port) else null

        // ⚠️★ 手上还压着一次分享（冷启动那一下刚把服务端起起来）→ 现在才开 WebView。
        // 早一步开的话页面会先显示「连不上」再自己恢复，而投递那边还得多等一轮。
        // ⚠️ `waitingToDeliver` 在这里归零 = 只开一次 —— 不然每 700ms 叠一个 Activity。
        if (waitingToDeliver && running) {
            waitingToDeliver = false
            openLocal()
        }

        if (address == null) {
            addressText.text = getString(R.string.no_address_yet)
            addressActions.visibility = View.GONE
            qrImage.visibility = View.GONE
            qrButton.visibility = View.GONE
            renderedAddress = null
            qrImage.setImageDrawable(null)
        } else {
            addressText.text = address
            addressActions.visibility = View.VISIBLE
            qrButton.visibility = View.VISIBLE
            if (renderedAddress != address) {
                // ⚠️ 只在地址**变了**的时候重画二维码 —— 这段循环每 700ms 跑一次，
                // 每次重画会白白造一张 480×480 的 Bitmap（那是能看出来的卡顿）。
                renderedAddress = address
                renderQr(address)
            }
        }

        // ⚠️ 端口改了要重启服务端才生效 —— 不说的话用户会以为「保存了 = 生效了」。
        portNote.visibility = if (running) View.VISIBLE else View.GONE
    }

    // ── 启停 ──────────────────────────────────────────────────────────

    private fun toggle() {
        when (ServerBridge.status()) {
            ServerBridge.STATUS_RUNNING -> sendAction(ServerService.ACTION_STOP, null)
            ServerBridge.STATUS_IDLE -> {
                val port = portInput.text.toString().toIntOrNull()
                if (port == null || port !in 1..65535) {
                    toast(getString(R.string.port_invalid))
                    return
                }
                AppPrefs.setPort(this, port)
                sendAction(ServerService.ACTION_START, port)
            }
            else -> toast(getString(R.string.action_busy))
        }
    }

    private fun sendAction(action: String, port: Int?) {
        val intent = Intent(this, ServerService::class.java).setAction(action)
        if (port != null) intent.putExtra(ServerService.EXTRA_PORT, port)
        // ⚠️ 用 `startForegroundService`：服务端要在 App 退到后台之后继续活着。
        // 「停止」那条也走它 —— 服务里第一件事就是 `startForeground`，所以不会踩 5 秒的线。
        ContextCompat.startForegroundService(this, intent)
    }

    // ── 分享进来 ──────────────────────────────────────────────────────

    /**
     * 处理一次「分享 → clip9」。
     *
     * 设计稿 §4 第 2 条：「热的那次立刻送，冷的那次不能丢」。
     *
     * ⚠️★ 冷启动那条路绕了一圈，值得写下来：Intent 先被**暂存**在 [PendingShare]，
     * 这里只负责「把服务端起起来」，等 [refresh] 看到真的 RUNNING 了才开 [WebAppActivity]，
     * 由那边等 SPA 的 `isReady()` 再真的投递。中途任何一步都不许丢东西。
     * ⚠️ 这里**不能**同步等服务端起来 —— 那是几秒钟的阻塞，在 UI 线程上就是 ANR。
     */
    private fun handleShareIntent(intent: Intent?) {
        if (ShareIntent.isUnsupportedShare(intent)) {
            // ⚠️ 分享文件那条还没做 → 明说一句。什么都不说看起来就是「clip9 坏了」。
            toast(getString(R.string.share_files_unsupported))
            return
        }
        val payload = ShareIntent.parse(intent) ?: return
        PendingShare.hold(payload)
        waitingToDeliver = true
        when (ServerBridge.status()) {
            ServerBridge.STATUS_RUNNING -> openLocal()
            // ⚠️ 没起就顺手起起来：用户分享的意图就是「把它发到我的看板上」，
            // 这里再让他自己去点一下「启动」是说不过去的。
            ServerBridge.STATUS_IDLE -> sendAction(ServerService.ACTION_START, AppPrefs.port(this))
            // 过渡态（正在起 / 正在停）：不动手 —— 抢着动手只会撞上 Rust 那边的四态拒绝，
            // 由 refresh() 接上就够了。
            else -> Unit
        }
    }

    // ── 地址 / 二维码 ─────────────────────────────────────────────────

    private fun copyAddress() {
        val address = ServerAddress.lanUrl(AppPrefs.port(this)) ?: return
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("clip9", address))
        toast(getString(R.string.address_copied))
    }

    private fun openLocal() {
        openWeb(ServerAddress.loopbackUrl(AppPrefs.port(this)), getString(R.string.section_local))
    }

    private fun openRemote() {
        val url = ServerAddress.normalize(remoteInput.text.toString())
        if (url.isEmpty()) {
            toast(getString(R.string.remote_empty))
            return
        }
        // ⚠️ 存**补过协议的**那一份：下次打开时会照它加载，存原文就会出现
        // 「界面上显示 192.168.1.10:9501，实际加载的是 http://…」这种对不上的情况。
        AppPrefs.setRemoteUrl(this, url)
        remoteInput.setText(url)
        openWeb(url, getString(R.string.section_remote))
    }

    private fun openWeb(url: String, title: String) {
        startActivity(
            Intent(this, WebAppActivity::class.java)
                .putExtra(WebAppActivity.EXTRA_URL, url)
                .putExtra(WebAppActivity.EXTRA_TITLE, title),
        )
    }

    private fun toggleQr() {
        if (qrImage.visibility == View.VISIBLE) {
            qrImage.visibility = View.GONE
            qrButton.text = getString(R.string.show_qr)
        } else {
            qrImage.visibility = View.VISIBLE
            qrButton.text = getString(R.string.hide_qr)
        }
    }

    private fun renderQr(content: String) {
        try {
            val hints = hashMapOf<EncodeHintType, Any>(
                EncodeHintType.MARGIN to 0,
                EncodeHintType.CHARACTER_SET to "UTF-8",
            )
            val matrix: BitMatrix =
                QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, 480, 480, hints)
            val bitmap = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565)
            for (x in 0 until matrix.width) {
                for (y in 0 until matrix.height) {
                    bitmap.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
                }
            }
            qrImage.setImageBitmap(bitmap)
        } catch (t: Throwable) {
            // 画不出来不该让界面崩 —— 地址本来就是以文字显示的，二维码只是顺手。
            android.util.Log.w("clip9", "二维码生成失败", t)
            qrImage.setImageDrawable(null)
        }
    }

    // ── 端口 ──────────────────────────────────────────────────────────

    private fun savePort(): Boolean {
        val port = portInput.text.toString().toIntOrNull()
        if (port == null || port !in 1..65535) {
            toast(getString(R.string.port_invalid))
            portInput.setText(AppPrefs.port(this).toString())
            return false
        }
        AppPrefs.setPort(this, port)
        return true
    }

    // ── 其它 ──────────────────────────────────────────────────────────

    /**
     * 引导用户把 App 加进电池优化白名单。
     *
     * ⚠️★ 不做这一步的症状是「**锁屏一段时间后莫名其妙断连**」，而它在日志里什么都留不下
     * （设计稿 §3.3）。所以这个入口要显眼。
     * ⚠️ `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 在 Google Play 上是受限的
     * （要申报理由）—— 这个 App 本来就不走 Play，但换发布方式时要记得这件事。
     */
    private fun requestBatteryWhitelist() {
        val manager = getSystemService(PowerManager::class.java)
        if (manager != null && manager.isIgnoringBatteryOptimizations(packageName)) {
            toast(getString(R.string.battery_already))
            return
        }
        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                ),
            )
        } catch (e: Exception) {
            // ⚠️ 有些 ROM 没有那个直达界面 → 退到「电池优化」列表页（用户自己找）。
            android.util.Log.w("clip9", "打不开电池优化白名单界面", e)
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (inner: Exception) {
                toast(inner.message ?: getString(R.string.battery_unavailable))
            }
        }
    }

    /** 读系统 WebView 的版本，太旧就直说（设计稿 §3.6）。 */
    private fun checkWebView() {
        val userAgent = try {
            WebSettings.getDefaultUserAgent(this)
        } catch (t: Throwable) {
            android.util.Log.w("clip9", "取不到 WebView UA", t)
            ""
        }
        webViewVersionText.visibility = View.VISIBLE
        val major = Regex("Chrome/(\\d+)").find(userAgent)?.groupValues?.get(1)?.toIntOrNull()
        webViewVersionText.text = if (major != null && major < MIN_WEBVIEW_CHROME) {
            getString(R.string.webview_version, userAgent) + "\n" + getString(R.string.webview_old, major)
        } else {
            getString(R.string.webview_version, userAgent)
        }
    }

    private fun askNotificationPermission() {
        // ⚠️ POST_NOTIFICATIONS 只在 Android 13+ 存在，低版本问它会被直接拒。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        }
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (t: Throwable) {
        "?"
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
