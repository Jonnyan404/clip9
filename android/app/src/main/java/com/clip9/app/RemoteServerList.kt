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
 * 连接页里的**远端服务器清单**：可保存多台、每台带自己的房间与密码。
 *
 * ⚠️★ 清单本身归 [RemoteServers] 管（哪来的、存在哪、密码怎么加密），
 * 这里只管**画**与**编辑**。分开的理由：以后（比如分享页里）也想列一下这些服务器时，
 * 不该被迫连着这一整页的视图一起搬。
 *
 * ⚠️★ 「增删改」是**整份替换**：拿 `load` 出来的那份改完再 `save` 回去，
 * 不是「就地改一项」。这一条与前端那条「列表字段整份替换」是同一个理由 ——
 * 就地改要求每一处都知道自己在改哪一项，而那个「哪一项」在下一次列表重排之后就不一定对了。
 *
 * ⚠️ 行上的那个小圆点与状态词是**本地推断**，不是真的连过：有密码 = 打开时能直接进（绿），
 * 没密码 = 打开时可能还要输一次（灰）。真连一次才知道服务端要不要密码，
 * 而为了显示一个颜色去连一次是不值的 —— 所以文案写成「可能」。
 */
class RemoteServerList(
    private val activity: AppCompatActivity,
    private val root: View,
) {

    /** 用户点了某一台（要打开它的界面）。 */
    var onOpen: ((RemoteServer) -> Unit)? = null

    /** 清单变了（增删改 / 换选中）。调用方用它重画这一页。 */
    var onChange: (() -> Unit)? = null

    private val list: LinearLayout = root.findViewById(R.id.remoteList)
    private val empty: TextView = root.findViewById(R.id.remoteEmpty)

    init {
        root.findViewById<Button>(R.id.remoteAddButton).setOnClickListener { edit(null) }
    }

    /** 重画整个清单。⚠️ 每次都重建视图（台数不定，逐行 diff 不值当）。 */
    fun render(snapshot: RemoteServers.Snapshot) {
        list.removeAllViews()
        empty.visibility = if (snapshot.servers.isEmpty()) View.VISIBLE else View.GONE
        for (server in snapshot.servers) {
            list.addView(row(server, server.id == snapshot.selectedId))
        }
    }

    private fun row(server: RemoteServer, selected: Boolean): View {
        val view = LayoutInflater.from(activity).inflate(R.layout.layout_remote_row, list, false)
        view.findViewById<TextView>(R.id.remoteName).text = displayName(server)
        view.findViewById<TextView>(R.id.remoteAddress).text = server.url
        view.findViewById<TextView>(R.id.remoteCurrent).visibility =
            if (selected) View.VISIBLE else View.GONE

        val saved = server.password.isNotEmpty()
        view.findViewById<TextView>(R.id.remoteLed)
            .setTextColor(activity.getColor(if (saved) R.color.led_running else R.color.led_idle))
        val state = activity.getString(
            if (saved) R.string.remote_status_logged_in else R.string.remote_status_needs_password,
        )
        val room = server.room.trim()
        view.findViewById<TextView>(R.id.remoteState).text = if (room.isEmpty()) state else "$state · $room"

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

    // ── 编辑对话框 ────────────────────────────────────────────────────

    /**
     * 打开编辑框。
     *
     * @param existing `null` = 新建一台。
     *
     * ⚠️ 用 `setPositiveButton(..., null)` + `setOnShowListener` 手动接管「保存」：
     * 默认的那个会在点一下之后**无条件**关掉对话框，于是「名字没填」这种校验
     * 就只能靠先关再弹一次（用户填的东西全丢）。手动接管之后校验不过就不关。
     */
    private fun edit(existing: RemoteServer?) {
        val view = LayoutInflater.from(activity).inflate(R.layout.dialog_remote_server, null, false)
        val isNew = existing == null
        val server = existing ?: RemoteServer.blank()

        val nameInput = view.findViewById<EditText>(R.id.editorName)
        val urlInput = view.findViewById<EditText>(R.id.editorUrl)
        val roomInput = view.findViewById<EditText>(R.id.editorRoom)
        val passwordInput = view.findViewById<EditText>(R.id.editorPassword)
        val rememberInput = view.findViewById<Switch>(R.id.editorRemember)
        val autoAuthInput = view.findViewById<Switch>(R.id.editorAutoAuth)
        val testButton = view.findViewById<Button>(R.id.editorTest)
        val testResult = view.findViewById<TextView>(R.id.editorTestResult)

        nameInput.setText(server.name)
        urlInput.setText(server.url)
        roomInput.setText(server.room)
        passwordInput.setText(server.password)
        rememberInput.isChecked = server.rememberPassword
        autoAuthInput.isChecked = server.autoAuth

        val dialog = AlertDialog.Builder(activity)
            .setTitle(if (isNew) R.string.remote_editor_new else R.string.remote_editor_edit)
            .setView(view)
            .setPositiveButton(R.string.remote_save, null)
            .setNegativeButton(R.string.remote_cancel, null)
            .setNeutralButton(R.string.remote_delete, null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val name = nameInput.text.toString().trim()
                val url = ServerAddress.normalize(urlInput.text.toString())
                if (name.isEmpty()) {
                    toast(activity.getString(R.string.remote_name_required))
                    return@setOnClickListener
                }
                if (url.isEmpty()) {
                    toast(activity.getString(R.string.remote_url_required))
                    return@setOnClickListener
                }
                upsert(
                    server.copy(
                        name = name,
                        // ⚠️ 存**补过协议**的那一份：下次打开时会照它加载。
                        // 存原文就会出现「界面上显示 192.168.1.10:9501，实际加载的是 http://…」。
                        url = url,
                        room = roomInput.text.toString().trim(),
                        password = passwordInput.text.toString(),
                        rememberPassword = rememberInput.isChecked,
                        autoAuth = autoAuthInput.isChecked,
                    ),
                )
                dialog.dismiss()
            }

            // ⚠️ 新建的时候「删除」没有意义 → 直接藏起来（而不是禁用：
            // 一个灰着的按钮会让人猜「要满足什么条件才能删」）。
            val remove = dialog.getButton(AlertDialog.BUTTON_NEUTRAL)
            if (isNew) {
                remove.visibility = View.GONE
            } else {
                remove.setOnClickListener {
                    AlertDialog.Builder(activity)
                        .setMessage(activity.getString(R.string.remote_delete_confirm, displayName(server)))
                        .setPositiveButton(R.string.remote_delete) { _, _ ->
                            remove(server)
                            dialog.dismiss()
                        }
                        .setNegativeButton(R.string.remote_cancel, null)
                        .show()
                }
            }

            testButton.setOnClickListener {
                testButton.isEnabled = false
                testResult.visibility = View.VISIBLE
                testResult.text = activity.getString(R.string.remote_testing)
                testConnection(
                    ServerAddress.normalize(urlInput.text.toString()),
                    roomInput.text.toString().trim(),
                    passwordInput.text.toString(),
                ) { text: String ->
                    // ⚠️ 回调可能晚于对话框的销毁（用户等不及点了取消）→ 先看还活着没有。
                    if (!dialog.isShowing) return@testConnection
                    testButton.isEnabled = true
                    testResult.text = text
                }
            }
        }

        dialog.show()
    }

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

    private fun remove(server: RemoteServer) {
        val snapshot = RemoteServers.load(activity)
        val servers = snapshot.servers.filterNot { it.id == server.id }
        // ⚠️ 删掉的正好是「当前用这一台」时要把选中清掉 —— 留着一个指向不存在那一台的 id，
        // 下次画清单时没有任何一行会高亮，而「当前用哪一台」就再也看不出来了。
        val selected = if (snapshot.selectedId == server.id) "" else snapshot.selectedId
        RemoteServers.save(activity, RemoteServers.Snapshot(servers, selected))
        onChange?.invoke()
        toast(activity.getString(R.string.remote_removed))
    }

    private fun toast(message: String) {
        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
    }
}
