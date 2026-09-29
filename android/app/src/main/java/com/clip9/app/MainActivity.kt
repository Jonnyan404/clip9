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
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter

/**
 * 原生管理页（方案 B）：顶部状态条 + 「连接 / 配置 / 其它」三页。
 *
 * ⚠️★ 它**不渲染看板** —— 看板是 [WebAppActivity] 里那个 WebView 加载服务端地址。
 * 别把两者混起来（设计稿 §2：别在 WebView 里嵌原生，也别让 WebView 成为唯一界面）。
 *
 * ⚠️★ 它**不镜像状态**：每一轮都问 [ServerBridge.status]（Rust 那边是唯一权威）。
 * Go 版把 `isRunning` 抄进了 Kotlin 的静态字段，于是「服务端已经挂了、界面还写着运行中」
 * 只能靠人去翻日志发现。这里的轮询是廉价的（一个 JNI 调用取锁读一个枚举），
 * 换来的是「界面永远与服务端一致」。
 *
 * ⚠️★ 它**不转发配置**：`config.json` 怎么读怎么写、哪些值配了不生效，
 * 全在 [ConfigPage] + `clip9-core`（详见那两处的注释）。这一页只负责
 * 「把配置页画出来、把底下那条『未生效』的横栏摆对、保存之后按需重启」。
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

        /**
         * 三个页签 ↔ 三个页面容器（靠 `visibility` 切，不引 Fragment）。
         *
         * ⚠️★ 顺序要与 `activity_main.xml` 里 `tabGroup` 三个按钮的顺序一致 ——
         * 对不上的症状是「点了那个页签，出来的是另一页」，而且**不报错**。
         * `tools/android-contract-smoke.mjs` 有一条判据盯着这张表里的三个 id 在 XML 里都在。
         */
        private val TABS = listOf(
            R.id.tabConnect to R.id.pageConnect,
            R.id.tabConfig to R.id.pageConfig,
            R.id.tabOther to R.id.pageOther,
        )
    }

    private val handler = Handler(Looper.getMainLooper())

    private lateinit var versionText: TextView
    private lateinit var stripLed: TextView
    private lateinit var stripState: TextView
    private lateinit var stripAddress: TextView
    private lateinit var powerButton: Button
    private lateinit var errorText: TextView
    private lateinit var libMissingText: TextView
    private lateinit var tabGroup: MaterialButtonToggleGroup
    private lateinit var addressText: TextView
    private lateinit var addressActions: View
    private lateinit var qrImage: ImageView
    private lateinit var qrButton: Button
    private lateinit var dirtyBar: View
    private lateinit var dirtySave: Button
    private lateinit var dirtyText: TextView
    private lateinit var webViewVersionText: TextView
    private lateinit var dataDirText: TextView

    /** 配置页（把 `config.json` 画成一张表单）。 */
    private lateinit var configPage: ConfigPage

    /** 连接页里那份可保存多台的服务器清单。 */
    private lateinit var remoteList: RemoteServerList

    /**
     * 服务端**现在**监听的端口。
     *
     * ⚠️★ 权威来源是 `config.json` 的 `server.port`（见 [ServerConfigStore.port]）——
     * 这里只是把它读出来拼地址，**不是**第二份权威。
     * ⚠️★ 在「正在跑」的时候**不**重读它：刚保存了一个新端口、服务端还没重启完的那一小段时间里，
     * 重读会让状态条显示一个**还没有人在听**的地址。重读只发生在两处：
     * 服务端没在跑时（[onResume] 与保存之后）、以及停完准备重启时（[refresh]）。
     */
    private var port = AppPrefs.DEFAULT_PORT

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

    /**
     * 「保存过配置，等它真的停下来之后要把服务端重新起起来」。
     *
     * ⚠️★ 不能「一停就立刻起」：Rust 那边正在停（`Stopping`）的时候会**拒绝**启动，
     * 于是「保存并重启」会以一句「服务端正在启动/停止，请稍候」告终 —— 而那是自找的。
     * 所以先停，等 [refresh] 看到状态真的回到「未启动」了再起。
     * ⚠️ 它一定会有下文：`stop` 无论成败都把状态置回 `Idle`
     * （见 `rust/crates/android/src/lib.rs` 里 `stop()` 末尾那段注释）。
     */
    private var restartAfterStop = false

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
        dataDirText.text = getString(R.string.data_dir, filesDir.absolutePath)

        // ⚠️★ 这一步要在**配置页装载之前**做：`ensureCreated` 会把老版本存在偏好里的端口
        // 搬进 `server.port` 并顺手把文件建出来，搬完再画表单 —— 用户看到的才是那个端口。
        // 反过来的话他会先看到 9501、再自己改一次（而「改之前那次启动」已经用了错的端口）。
        ServerConfigStore.ensureCreated(this)
        port = ServerConfigStore.port(this)

        // ⚠️ 两张页各管各的视图（各有各的动态行要 inflate），所以各自持一份引用。
        // 传的是 `android.R.id.content`：里面那两棵子树都在它下面，而它们各自
        // `findViewById` 的是**自己那几个** id（见两个类的抬头注释）。
        val content = findViewById<View>(android.R.id.content)
        configPage = ConfigPage(this, content)
        remoteList = RemoteServerList(this, content)

        // ⚠️ 先接回调、再装载：`load` 里那串 `setText` / `isChecked =` 会触发 `onChange`，
        // 而那时候底部那条横栏已经该知道「现在到底有没有改动」了。
        configPage.onChange = { refreshDirty() }
        remoteList.onChange = { refreshRemoteList() }
        remoteList.onOpen = { openRemoteServer(it) }

        configPage.load(ServerConfigStore.load(this))
        refreshRemoteList()
        refreshDirty()

        powerButton.setOnClickListener { toggle() }
        findViewById<Button>(R.id.copyAddressButton).setOnClickListener { copyAddress() }
        findViewById<Button>(R.id.openLocalButton).setOnClickListener { openLocal() }
        qrButton.setOnClickListener { toggleQr() }
        findViewById<Button>(R.id.dirtyDiscard).setOnClickListener { discardChanges() }
        findViewById<Button>(R.id.dirtySave).setOnClickListener { saveAndRestart() }
        findViewById<Button>(R.id.batteryButton).setOnClickListener { requestBatteryWhitelist() }
        findViewById<Button>(R.id.webViewCheckButton).setOnClickListener { checkWebView() }

        tabGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            showPage(checkedId)
            // ⚠️ 切过来时重算一次那条横栏：改动了多少处是**切页这一刻**才需要知道的事。
            if (checkedId == R.id.tabConfig) refreshDirty()
        }
        // ⚠️ 用 `check()` 而不是在 XML 里写 `app:checkedButton`：走同一条代码路径，
        // 就少了「初始状态与切页逻辑不一致」这种只在某一次改动后才冒出来的问题。
        tabGroup.check(R.id.tabConnect)

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
        //
        // ⚠️ 顺手重读一次端口：回来时服务端通常**没在跑**（用户看完界面按了返回），
        // 而这一趟里文件可能刚被建出来（第一次启动时服务端自己会落一份）。
        // ⚠️ 在跑的时候**不**重读 —— 理由见 [port] 的注释。
        if (ServerBridge.status() != ServerBridge.STATUS_RUNNING) {
            port = ServerConfigStore.port(this)
        }
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
        versionText = findViewById(R.id.versionText)
        stripLed = findViewById(R.id.stripLed)
        stripState = findViewById(R.id.stripState)
        stripAddress = findViewById(R.id.stripAddress)
        powerButton = findViewById(R.id.powerButton)
        errorText = findViewById(R.id.errorText)
        libMissingText = findViewById(R.id.libMissingText)
        tabGroup = findViewById(R.id.tabGroup)
        addressText = findViewById(R.id.addressText)
        addressActions = findViewById(R.id.addressActions)
        qrImage = findViewById(R.id.qrImage)
        qrButton = findViewById(R.id.qrButton)
        dirtyBar = findViewById(R.id.dirtyBar)
        dirtySave = findViewById(R.id.dirtySave)
        dirtyText = findViewById(R.id.dirtyText)
        webViewVersionText = findViewById(R.id.webViewVersionText)
        dataDirText = findViewById(R.id.dataDirText)
    }

    // ── 分段切页 ───────────────────────────────────────────────────────

    /**
     * 切到某一页。
     *
     * ⚠️ 用 `visibility` 而不是 Fragment / `ViewPager`：三页都是**同一份数据**的三种看法，
     * 拆成三个生命周期之后「切页时谁负责重新读配置」会变成一个每页都要回答的问题。
     * ⚠️ 代价是切页会**重置滚动位置** —— 这是想要的：切过去就是想看那一页的开头。
     */
    private fun showPage(checkedId: Int) {
        for ((tab, page) in TABS) {
            findViewById<View>(page).visibility = if (tab == checkedId) View.VISIBLE else View.GONE
        }
    }

    // ── 状态刷新 ───────────────────────────────────────────────────────

    private fun refresh() {
        val loadFailure = ServerBridge.loadFailure()
        libMissingText.visibility = if (loadFailure != null) View.VISIBLE else View.GONE
        if (loadFailure != null) libMissingText.text = getString(R.string.lib_missing, loadFailure)

        val status = ServerBridge.status()
        val running = status == ServerBridge.STATUS_RUNNING

        // ── 顶部状态条 ──
        // ⚠️ 圆点的颜色只有两种：**真的在跑**是绿的，其余（没起 / 正在起 / 正在停）都是灰的。
        // 过渡态刻意不给自己一个颜色：它会在一秒内变成一个确定的状态，
        // 为它单独调一种颜色只会让「绿 = 现在能连」这条规则变模糊。
        stripLed.setTextColor(getColor(if (running) R.color.led_running else R.color.led_idle))
        stripState.text = getString(ServerBridge.statusLabelRes(status))
        when (status) {
            ServerBridge.STATUS_RUNNING -> {
                // ⚠️ 用短文案：状态条那一格要留给地址。
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

        val address = displayAddress(status)
        stripAddress.text = address ?: noAddressText(status)

        val error = ServerBridge.lastError()
        if (status == ServerBridge.STATUS_IDLE && !error.isNullOrBlank()) {
            errorText.visibility = View.VISIBLE
            errorText.text = error
        } else {
            errorText.visibility = View.GONE
        }

        // ── 连接页上那个大号的地址 + 二维码 ──
        if (address == null) {
            addressText.text = noAddressText(status)
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

        // ── 「保存并重启」的后半步 ──
        // ⚠️★ 只有**真的回到「未启动」**了才起。在 `Stopping` 里起会撞上 Rust 的拒绝。
        if (restartAfterStop && status == ServerBridge.STATUS_IDLE) {
            restartAfterStop = false
            // ⚠️ 现在换端口是安全的：服务端已经停了，而且地址条此刻也不显示地址。
            port = ServerConfigStore.port(this)
            sendAction(ServerService.ACTION_START)
        }

        // ⚠️★ 手上还压着一次分享（冷启动那一下刚把服务端起起来）→ 现在才开 WebView。
        // 早一步开的话页面会先显示「连不上」再自己恢复，而投递那边还得多等一轮。
        // ⚠️ `waitingToDeliver` 在这里归零 = 只开一次 —— 不然每 700ms 叠一个 Activity。
        if (waitingToDeliver && running) {
            waitingToDeliver = false
            openLocal()
        }
    }

    // ── 启停 ──────────────────────────────────────────────────────────

    private fun toggle() {
        when (ServerBridge.status()) {
            ServerBridge.STATUS_RUNNING -> sendAction(ServerService.ACTION_STOP)
            // ⚠️★ 端口**不再从这里写**：它归 `config.json` 管（在配置页改，服务端只从那儿读）。
            // 以前这里会先 `AppPrefs.setPort(portInput)` 再起 —— 那正是「界面上填的端口」
            // 与「真的监听的端口」能有分歧的来源，现在那条路整个没了。
            ServerBridge.STATUS_IDLE -> sendAction(ServerService.ACTION_START)
            else -> toast(getString(R.string.action_busy))
        }
    }

    /** 发一条动作给前台服务。⚠️ **不**带端口 —— 见 [ServerBridge.start] 的注释。 */
    private fun sendAction(action: String) {
        // ⚠️ 用 `startForegroundService`：服务端要在 App 退到后台之后继续活着。
        // 「停止」那条也走它 —— 服务里第一件事就是 `startForeground`，所以不会踩 5 秒的线。
        ContextCompat.startForegroundService(
            this,
            Intent(this, ServerService::class.java).setAction(action),
        )
    }

    // ── 配置页：底部的「未生效的更改」条 ────────────────────────────────

    /**
     * 重算底部那条横栏。
     *
     * ⚠️★ 它由**整份比对**驱动（`ConfigPage.changed()`），不是二十来个控件各挂一个监听：
     * 漏挂一个的症状是「改了它、底部却不提示」，而用户会以为已经存过了。
     *
     * ⚠️★ 出现这条横栏有两种原因，而它们**长得不一样**：
     * - 有改动待生效 → 说「N 处更改未生效」+ 为什么必须重启；
     * - **有填得不对的地方**（`ConfigPage.blockReason()`）→ 直接说那一句，
     *   并把「保存并重启」按灰。⚠️ 这时候**不能**只把横栏藏起来 ——
     *   用户会看到自己明明改了东西、底下却一片空白，然后把整张表单从头再对一遍。
     */
    private fun refreshDirty() {
        val reason = configPage.blockReason()
        val changed = reason == null && configPage.changed()
        dirtyBar.visibility = if (reason != null || changed) View.VISIBLE else View.GONE
        dirtySave.isEnabled = reason == null
        dirtyText.text = when {
            reason != null -> reason
            changed -> getString(R.string.dirty_title, configPage.changedAreaCount()) +
                "\n" + getString(R.string.dirty_note)
            else -> ""
        }
    }

    /** 「放弃」：重新从盘上读一遍 —— 把表单恢复成「最后一次落盘的那一份」。 */
    private fun discardChanges() {
        // ⚠️ 问一句再丢：那个按钮就在「保存并重启」旁边，而它丢掉的是整张表单。
        AlertDialog.Builder(this)
            .setMessage(R.string.dirty_discard_confirm)
            .setPositiveButton(R.string.dirty_discard) { _, _ ->
                configPage.load(ServerConfigStore.load(this))
                refreshDirty()
                toast(getString(R.string.config_discarded))
            }
            .setNegativeButton(R.string.remote_cancel, null)
            .show()
    }

    /**
     * 「保存并重启」。
     *
     * ⚠️★ 三道闸的顺序不能换，而且**都不在这一侧**（见 [ServerConfigStore.save]）：
     * ① 反序列化（界面上拼错了值 → 服务端下次启动直接失败）
     * ② `Config::validate_for_save`（「配了也不生效 / 起不来」）
     * ③ 原子写盘（半截 JSON 会让服务端**再也起不来**）
     * 这里做的只是「拼一份配置、交给它、把它的原话转给用户」。
     */
    private fun saveAndRestart() {
        // ⚠️ 先看表单自己有没有说不清的（数字框里不是个数）—— 那类东西到不了 Rust，
        // 因为到了那边已经被读成 0 了，它分不出「用户真想填 0」。
        val reason = configPage.blockReason()
        if (reason != null) {
            toast(reason)
            return
        }
        val config = configPage.build()
        if (config == null) {
            // ⚠️★ 读不出来的配置**不许**保存：那会把盘上那份真配置盖成一份默认值
            // （密码、房间、路径全没）。`blockReason()` 已经挡了一层，这里是兜底。
            toast(getString(R.string.config_unreadable))
            return
        }
        val error = ServerConfigStore.save(this, config)
        if (error != null) {
            // ⚠️★ 这是 Rust 校验没过时给的**原话**（「配了不生效 / 起不来」），原样显示。
            // 别在这里换个说法：换过之后用户照做还是存不进去，而两处说的话对不上，
            // 他只会觉得是界面在骗他。
            toast(error)
            return
        }

        // ⚠️★ 重新装载一遍：不重装的话「原文」还是旧的那一份，
        // 于是底部那条横栏会一直挂着（它比的是「表单 vs 装载时的原文」）。
        // 这一步与「放弃」走的是同一条路，差别只在于盘上那份已经换过了。
        configPage.load(ServerConfigStore.load(this))
        refreshDirty()

        if (ServerBridge.status() == ServerBridge.STATUS_RUNNING) {
            // ⚠️ 服务端**只在启动时读一次**配置 → 想让它生效只能重启。
            // 先停；起的那一步在 [refresh] 里（`Stopping` 期间起会被 Rust 拒）。
            toast(getString(R.string.config_saved_restarting))
            restartAfterStop = true
            sendAction(ServerService.ACTION_STOP)
        } else {
            // 没在跑 → 不用重启，但要说清「下一次启动才生效」，
            // 而不是让它看起来像已经生效了（按钮文案已经写着「保存并重启」）
            port = ServerConfigStore.port(this)
            toast(getString(R.string.config_saved))
        }
    }

    // ── 远端服务器 ─────────────────────────────────────────────────────

    private fun refreshRemoteList() {
        remoteList.render(RemoteServers.load(this))
    }

    /**
     * 打开清单里的一台。
     *
     * ⚠️★ 只把 `id` 交给 [WebAppActivity]，**密码不进 Intent**：
     * Intent 的 extras 在 `dumpsys activity` 里是明文可读的。那边拿着 id 自己去清单里取。
     */
    private fun openRemoteServer(server: RemoteServer) {
        val title = server.name.trim().ifEmpty { getString(R.string.remote_default_name) }
        startActivity(
            Intent(this, WebAppActivity::class.java)
                .putExtra(WebAppActivity.EXTRA_URL, server.url)
                .putExtra(WebAppActivity.EXTRA_TITLE, title)
                .putExtra(WebAppActivity.EXTRA_SERVER_ID, server.id),
        )
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
            ServerBridge.STATUS_IDLE -> sendAction(ServerService.ACTION_START)
            // 过渡态（正在起 / 正在停）：不动手 —— 抢着动手只会撞上 Rust 那边的四态拒绝，
            // 由 refresh() 接上就够了。
            else -> Unit
        }
    }

    // ── 地址 / 二维码 ─────────────────────────────────────────────────

    /**
     * 状态条与连接页上那个地址（没有就是 null）。
     *
     * ⚠️★ 只在**真的在跑**的时候有值，而且**不**退回 `127.0.0.1`：
     * 这个位置的用途是「别的设备连这个」，拿回环地址顶上等于给出一串
     * 别人永远连不上的东西，而两边都不报错（见 [ServerAddress.lanUrl]）。
     */
    private fun displayAddress(status: Int): String? =
        if (status == ServerBridge.STATUS_RUNNING) ServerAddress.lanUrl(port) else null

    /**
     * 没有地址时那句话。
     *
     * ⚠️★ 分两种：「还没起」与「起了但这台设备没有局域网地址」（连的是蜂窝、或者没接网）。
     * 合成一句「先启动服务端」的话，第二种情况下用户会一直去点启动 —— 而它已经在跑了。
     */
    private fun noAddressText(status: Int): String = getString(
        if (status == ServerBridge.STATUS_RUNNING) {
            R.string.strip_no_lan
        } else {
            R.string.no_address_yet
        },
    )

    private fun copyAddress() {
        val address = ServerAddress.lanUrl(port) ?: return
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("clip9", address))
        toast(getString(R.string.address_copied))
    }

    private fun openLocal() {
        openWeb(ServerAddress.loopbackUrl(port), getString(R.string.section_local))
    }

    /**
     * 打开网页界面。
     *
     * @param serverId 清单里那一台的 id；本机界面传 null
     *   （本机不需要「打开前自动认证」—— 它就在这台设备上，没有跨设备那一段）。
     */
    private fun openWeb(url: String, title: String, serverId: String? = null) {
        val intent = Intent(this, WebAppActivity::class.java)
            .putExtra(WebAppActivity.EXTRA_URL, url)
            .putExtra(WebAppActivity.EXTRA_TITLE, title)
        if (serverId != null) intent.putExtra(WebAppActivity.EXTRA_SERVER_ID, serverId)
        startActivity(intent)
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
