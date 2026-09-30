package com.clip9.app

import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * 远端服务器的**子页控制器**：列表子页（稿子 ④）+ 编辑子页（稿子 ⑤）。
 *
 * ⚠️★ 2026-09-30 从「连接页内嵌卡 + 编辑弹窗」换成了「一行入口 → 列表子页 →
 * 编辑子页」的两层结构。两个子页都是 `activity_main.xml` 根 FrameLayout 上的
 * **全屏覆盖层**（`remoteListPage` / `remoteEditPage`），显隐由这里的
 * [show] / [onBack] 管 —— 不开新 Activity，就没有「状态怎么传过去」的问题。
 *
 * ⚠️★ 清单本身归 [RemoteServers] 管（哪来的、存在哪、密码怎么加密），
 * 这里只管**画**与**编辑**。分开的理由：以后（比如分享页里）也想列一下这些服务器时，
 * 不该被迫连着这一整页的视图一起搬。
 *
 * ⚠️★ 「增删改」是**整份替换**：拿 `load` 出来的那份改完再 `save` 回去，
 * 不是「就地改一项」。这一条与前端那条「列表字段整份替换」是同一个理由 ——
 * 就地改要求每一处都知道自己在改哪一项，而那个「哪一项」在下一次列表重排之后就不一定对了。
 *
 * ⚠️ 行上的 led 与 tag 是**本地推断**，不是真的连过：有密码 = 打开时能直接进（「已登录」），
 * 没密码 = 打开时可能还要输一次（「要密码」）。真连一次才知道服务端要不要密码，
 * 而为了显示一个颜色去连一次是不值的 —— 所以文案写成「可能」的意思。
 */
class RemoteServerList(
    private val activity: AppCompatActivity,
    private val root: View,
) {

    /** 用户点了某一台（要打开它的界面）。 */
    var onOpen: ((RemoteServer) -> Unit)? = null

    /** 清单变了（增删改 / 换选中）。调用方用它刷新别处依赖这份数据的东西。 */
    var onChange: (() -> Unit)? = null

    // ── 列表子页 ──────────────────────────────────────────────────────
    private val listPage: View = root.findViewById(R.id.remoteListPage)
    private val list: LinearLayout = root.findViewById(R.id.remotePageList)
    private val empty: TextView = root.findViewById(R.id.remotePageEmpty)
    private val openButton: Button = root.findViewById(R.id.remoteOpenButton)

    // ── 编辑子页（字段 id 与弹窗时代一致）────────────────────────────
    private val editPage: View = root.findViewById(R.id.remoteEditPage)
    private val editTitle: TextView = root.findViewById(R.id.remoteEditTitle)

    /** 正在编辑的那一台；`null` = 新建。关闭编辑子页时清掉。 */
    private var editing: RemoteServer? = null

    /** 测试连接的网络线程跑着的时候记着它 —— 返回时不要让它把结果写进已关闭的子页。 */
    private var editAlive: (() -> Boolean) = { false }

    init {
        // 连接页那行入口 → 列表子页。
        root.findViewById<View>(R.id.remoteEntry).setOnClickListener { show() }
        root.findViewById<View>(R.id.remoteBack).setOnClickListener { hide() }
        root.findViewById<View>(R.id.remoteAddButton).setOnClickListener { edit(null) }
        root.findViewById<View>(R.id.remoteEditBack).setOnClickListener { closeEditor() }
        root.findViewById<View>(R.id.remoteSaveButton).setOnClickListener { saveEditor() }
        root.findViewById<View>(R.id.editorDelete).setOnClickListener { removeCurrent() }
    }

    // ── 显隐 ──────────────────────────────────────────────────────────

    /** 进列表子页。⚠️ 每次进去都重画：从编辑子页回来可能已经变了。 */
    fun show() {
        render(RemoteServers.load(activity))
        listPage.visibility = View.VISIBLE
    }

    /**
     * 返回键落点。`true` = 这次返回被子页吃掉了（关掉一层子页）；
     * `false` = 没有子页开着，调用方该走自己的默认（退出 App）。
     */
    fun onBack(): Boolean = when {
        editPage.visibility == View.VISIBLE -> { closeEditor(); true }
        listPage.visibility == View.VISIBLE -> { hide(); true }
        else -> false
    }

    private fun hide() {
        listPage.visibility = View.GONE
    }

    // ── 列表子页 ──────────────────────────────────────────────────────

    /** 重画清单、打开按钮与连接页那行入口。⚠️ 每次都重建视图（台数不定，逐行 diff 不值当）。 */
    fun render(snapshot: RemoteServers.Snapshot) {
        list.removeAllViews()
        empty.visibility = if (snapshot.servers.isEmpty()) View.VISIBLE else View.GONE
        for (server in snapshot.servers) {
            list.addView(row(server, server.id == snapshot.selectedId))
        }
        refreshEntry(snapshot)
        refreshOpenButton(snapshot)
    }

    /** 连接页那行入口的摘要：当前选中那台的「名字 · 地址」。 */
    private fun refreshEntry(snapshot: RemoteServers.Snapshot) {
        val line = root.findViewById<TextView>(R.id.remoteEntryCurrent)
        val current = snapshot.servers.firstOrNull { it.id == snapshot.selectedId }
        line.text = if (current == null) {
            activity.getString(R.string.remote_entry_none)
        } else {
            "${displayName(current)} · ${current.url}"
        }
    }

    /** 「用『家里』打开界面」：没有选中那台时灰掉（按钮自己说明它要什么）。 */
    private fun refreshOpenButton(snapshot: RemoteServers.Snapshot) {
        val current = snapshot.servers.firstOrNull { it.id == snapshot.selectedId }
        if (current == null) {
            openButton.isEnabled = false
            openButton.alpha = 0.4f
            openButton.text = activity.getString(R.string.remote_entry_none)
        } else {
            openButton.isEnabled = true
            openButton.alpha = 1f
            openButton.text = activity.getString(R.string.remote_open_with, displayName(current))
        }
        openButton.setOnClickListener {
            if (current != null) onOpen?.invoke(current)
        }
    }

    private fun row(server: RemoteServer, selected: Boolean): View {
        val view = LayoutInflater.from(activity).inflate(R.layout.layout_remote_row, list, false)
        view.findViewById<TextView>(R.id.remoteName).text = displayName(server)

        // 房间并进地址那一行（稿子 ④：「家里 · http://… · default」）。
        val room = server.room.trim()
        view.findViewById<TextView>(R.id.remoteAddress).text =
            if (room.isEmpty()) server.url else "${server.url} · $room"

        // ⚠️ led 的含义：绿 = **当前选中**（稿子 ④「当前那台是绿的」），
        // 灰 = 其余。不是「能不能免密」—— 那层意思在右侧那枚 tag 上。
        view.findViewById<TextView>(R.id.remoteLed)
            .setTextColor(activity.getColor(if (selected) R.color.led_running else R.color.led_idle))

        // ⚠️ tag 是**本地推断**：有密码 = 「已登录」（绿）—— 严格说是「打开时能直接进」；
        // 没密码 = 「要密码」（橙）—— 是「可能还要输一次」，不是错误（所以不用红）。
        val state = view.findViewById<TextView>(R.id.remoteState)
        val saved = server.password.isNotEmpty()
        state.text = activity.getString(
            if (saved) R.string.remote_status_logged_in else R.string.remote_status_needs_password,
        )
        state.setBackgroundResource(if (saved) R.drawable.bg_console_flag_ok else R.drawable.bg_console_flag)
        state.setTextColor(activity.getColor(if (saved) R.color.console_flag_ok_text else R.color.console_flag_text))

        // ⚠️ 整行点了就打开：这是这一页上最常做的事（比「编辑」常得多）。
        // ⚠️ 先 select 再打开：下一次进来时默认还是它。
        view.setOnClickListener {
            RemoteServers.select(activity, server.id)
            onChange?.invoke()
            onOpen?.invoke(server)
        }
        view.findViewById<Button>(R.id.remoteEdit).setOnClickListener { edit(server) }
        return view
    }

    private fun displayName(server: RemoteServer): String =
        server.name.trim().ifEmpty { activity.getString(R.string.remote_default_name) }

    // ── 编辑子页 ──────────────────────────────────────────────────────

    /**
     * 进编辑子页。
     *
     * @param existing `null` = 新建一台。
     */
    private fun edit(existing: RemoteServer?) {
        val isNew = existing == null
        val server = existing ?: RemoteServer.blank()
        editing = server

        editTitle.text = if (isNew) {
            activity.getString(R.string.remote_new_title)
        } else {
            displayName(server)
        }
        field(R.id.editorName).setText(server.name)
        field(R.id.editorUrl).setText(server.url)
        field(R.id.editorRoom).setText(server.room)
        field(R.id.editorPassword).setText(server.password)
        root.findViewById<Switch>(R.id.editorRemember).isChecked = server.rememberPassword
        root.findViewById<Switch>(R.id.editorAutoAuth).isChecked = server.autoAuth

        // ⚠️ 新建的时候「删除」没有意义 → 直接藏起来（而不是禁用：
        // 一个灰着的按钮会让人猜「要满足什么条件才能删」）。
        root.findViewById<View>(R.id.editorDelete).visibility =
            if (isNew) View.GONE else View.VISIBLE

        // 上一次的测试结果不带走：它说的是**那一台**的事。
        root.findViewById<TextView>(R.id.editorTestResult).visibility = View.GONE
        bindTestButton()

        listPage.visibility = View.GONE
        editPage.visibility = View.VISIBLE
    }

    private fun closeEditor() {
        editPage.visibility = View.GONE
        editing = null
        editAlive = { false }
        // 回到列表子页 —— 清单可能刚被这轮编辑改过（虽然保存才真改）。
        show()
    }

    private fun field(id: Int): EditText = root.findViewById(id)

    /** 「保存」：校验不过就**不关**子页（弹窗时代同一条规矩，理由见 git 历史）。 */
    private fun saveEditor() {
        val server = editing ?: return
        val name = field(R.id.editorName).text.toString().trim()
        val url = ServerAddress.normalize(field(R.id.editorUrl).text.toString())
        if (name.isEmpty()) {
            toast(activity.getString(R.string.remote_name_required))
            return
        }
        if (url.isEmpty()) {
            toast(activity.getString(R.string.remote_url_required))
            return
        }
        upsert(
            server.copy(
                name = name,
                // ⚠️ 存**补过协议**的那一份：下次打开时会照它加载。
                // 存原文就会出现「界面上显示 192.168.1.10:9501，实际加载的是 http://…」。
                url = url,
                room = field(R.id.editorRoom).text.toString().trim(),
                password = field(R.id.editorPassword).text.toString(),
                rememberPassword = root.findViewById<Switch>(R.id.editorRemember).isChecked,
                autoAuth = root.findViewById<Switch>(R.id.editorAutoAuth).isChecked,
            ),
        )
        editing = null
        editAlive = { false }
        editPage.visibility = View.GONE
        show()
    }

    /** 「测试连接」：走**真要用的那条路**（同 [testConnection]，弹窗时代原样搬过来）。 */
    private fun bindTestButton() {
        root.findViewById<Button>(R.id.editorTest).setOnClickListener {
            val testButton = root.findViewById<Button>(R.id.editorTest)
            val testResult = root.findViewById<TextView>(R.id.editorTestResult)
            testButton.isEnabled = false
            testResult.visibility = View.VISIBLE
            testResult.text = activity.getString(R.string.remote_testing)
            val ticket = ++testTicket
            editAlive = { editing != null && ticket == testTicket && editPage.visibility == View.VISIBLE }
            testConnection(
                ServerAddress.normalize(field(R.id.editorUrl).text.toString()),
                field(R.id.editorRoom).text.toString().trim(),
                field(R.id.editorPassword).text.toString(),
            ) { text: String ->
                // ⚠️ 回调可能晚于子页关闭（用户等不及点了返回）→ 先看还活着没有。
                if (!editAlive()) return@testConnection
                testButton.isEnabled = true
                testResult.text = text
            }
        }
    }

    /** 每次点「测试」加一：旧一轮的结果就算回来了也不再落笔。 */
    private var testTicket = 0

    /**
     * 走一遍**真要用的那条路**去试。
     *
     * ⚠️★ 填了密码就用密码换令牌（和打开界面时同一个接口）；没填密码就只问到
     * `/server` 为止 —— 但**如实报告**服务端说的「要不要密码」，不编结果：
     * 那句是「地址通了，但没填密码」或者「这台不需要密码」，
     * 而**不是**笼统的「测试通过」（后者会让用户以为打开时也不用密码）。
     */
    private fun testConnection(url: String, room: String, password: String, done: (String) -> Unit) {
        if (url.isEmpty()) {
            done(activity.getString(R.string.remote_url_required))
            return
        }
        // ⚠️ 网络请求不能在主线程（超时上界 8 秒）。
        Thread(
            {
                val message = when (val probe = AuthClient.test(url, room, password)) {
                    is AuthClient.Probe.Token -> activity.getString(
                        R.string.remote_test_ok,
                        timeOf(probe.expiresAt),
                    )
                    is AuthClient.Probe.Reachable -> activity.getString(
                        if (probe.needsPassword) {
                            R.string.remote_test_notoken
                        } else {
                            R.string.remote_test_open
                        },
                    )
                    is AuthClient.Probe.Failed -> activity.getString(R.string.remote_test_failed, probe.message)
                }
                activity.runOnUiThread { done(message) }
            },
            "clip9-remote-test",
        ).start()
    }

    /** 把「到期时刻」说成人看得懂的样子（只到分钟，秒对用户没意义）。 */
    private fun timeOf(epochSeconds: Long): String {
        if (epochSeconds <= 0) return "不过期"
        val format = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        return format.format(java.util.Date(epochSeconds * 1000))
    }

    // ── 增删改（整份替换）──────────────────────────────────────────────

    private fun upsert(server: RemoteServer) {
        val snapshot = RemoteServers.load(activity)
        val servers = snapshot.servers.toMutableList()
        val index = servers.indexOfFirst { it.id == server.id }
        if (index >= 0) {
            servers[index] = server
        } else {
            servers += server
            // ⚠️ 加第一台的时候顺手选中它：加完它却不「当前用它」，是说不通的。
            if (snapshot.selectedId.isEmpty()) {
                RemoteServers.save(activity, RemoteServers.Snapshot(servers, server.id))
                onChange?.invoke()
                toast(activity.getString(R.string.remote_saved))
                return
            }
        }
        RemoteServers.save(activity, RemoteServers.Snapshot(servers, snapshot.selectedId))
        onChange?.invoke()
        toast(activity.getString(R.string.remote_saved))
    }

    private fun removeCurrent() {
        val server = editing ?: return
        AlertDialog.Builder(activity)
            .setMessage(activity.getString(R.string.remote_delete_confirm, displayName(server)))
            .setPositiveButton(R.string.remote_delete) { _, _ ->
                val snapshot = RemoteServers.load(activity)
                val servers = snapshot.servers.filterNot { it.id == server.id }
                // ⚠️ 删掉的正好是「当前用这一台」时要把选中清掉 —— 留着一个指向不存在那一台的 id，
                // 下次画清单时没有任何一行会高亮，而「当前用哪一台」就再也看不出来了。
                val selected = if (snapshot.selectedId == server.id) "" else snapshot.selectedId
                RemoteServers.save(activity, RemoteServers.Snapshot(servers, selected))
                onChange?.invoke()
                toast(activity.getString(R.string.remote_removed))
                editing = null
                editAlive = { false }
                editPage.visibility = View.GONE
                show()
            }
            .setNegativeButton(R.string.remote_cancel, null)
            .show()
    }

    private fun toast(message: String) {
        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
    }
}
