package com.clip9.app

import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioGroup
import android.widget.Switch
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import org.json.JSONArray
import org.json.JSONObject

/**
 * 配置页：把服务端的 `config.json` 画成一张表单。
 *
 * ⚠️★ 这里**不校验**任何东西、也**不发明**默认值：
 * 校验在 Rust 那一侧（`Config::validate_for_save` + 反序列化那道闸），
 * 默认值在 `Config::default()` 里。这里只做「JSON 字段 ↔ 控件」的搬运。
 * 理由：「配了不生效」是这个项目一条**有明确判据**的规则（见 `TEXT_LIMIT_MAX` 的注释），
 * 它必须只有一处实现 —— 在这边再抄一遍必然漂，而漂了的两种结果都很难看：
 * 「界面放行、服务端拒绝」或者更坏的「界面拒绝、其实能配」。
 *
 * ⚠️★ 「改过了吗」靠**整份比对**，而不是每个控件各挂一个监听：
 * 后者要在二十来个控件上各写一遍「置脏」的代码，漏一个的症状是
 * 「改了它，但底部那条『未生效』不出现」—— 用户以为存过了，其实什么都没写。
 * 参照物是装载时存下来的那份**深拷贝**。
 *
 * ⚠️★ 「没动过的字段要原样放回去」：`server.auth` 可以是 `false` / `"pw"` / `123`，
 * `roomAuth` 的一项可以是 `"pw"` / `123` / `{"open":true}` —— 这些都是**合法的同义写法**。
 * 如果读出来再写回去时统一成一种形态，用户什么都没改也会在配置文件里产生一大片 diff，
 * 而「改了没有」这件事就再也看不出来了。所以每个字段都记着**它的原文**，
 * 文本与原文一样时就原样放回。
 *
 * ⚠️ 控件值读不出来（数字框里是空的、或者写着字母）时取默认值、不抛异常：
 * `toInt()` 抛出去会让整页崩在 `onCreate` 里。而真的配不进去的值由服务端那道闸拒，
 * 那时候用户会看到一句明确的话。
 */
class ConfigPage(
    private val activity: AppCompatActivity,
    private val root: View,
) {

    /** 一个配置项的取值方式。 */
    private enum class Kind {
        /** 整数（`toLong`）。 */
        INT,

        /** 原样字符串。 */
        STRING,

        /** `server.auth`：`false` / `"pw"` / `123` 三种写法都合法。 */
        AUTH,

        /** `server.host`：`"0.0.0.0"`、`["0.0.0.0","::"]`、以及 `-host` 那种逗号分隔的
         *  `"0.0.0.0,::"` —— **三种都合法**（服务端 `serve::resolve_hosts` 三种都收）。 */
        HOST,
    }

    /**
     * 一个「文本框 ↔ 配置里的某个位置」的对应关系。
     *
     * ⚠️★ 字段名（[path]）**只在这张表里出现一次** —— 它是这一页与
     * `rust/crates/core/src/config.rs` 之间那条契约的唯一落点，
     * `tools/android-contract-smoke.mjs` 就盯着这张表。
     * 别在别处再写一遍字段名字符串（那种重复没有编译器兜着）。
     */
    private class Field(val id: Int, val path: String, val kind: Kind) {
        /** 装载时控件里显示的文本。取样时拿它判断「用户动过没有」。 */
        var originalText: String = ""

        /** 装载时那个字段的**原始 JSON 值**（可能是数字、布尔、数组…）。 */
        var originalRaw: Any? = null
    }

    private val fields: List<Field> = listOf(
        Field(R.id.configGlobalPassword, "server.auth", Kind.AUTH),
        Field(R.id.configRoomCleanup, "server.roomCleanup", Kind.INT),
        Field(R.id.configHost, "server.host", Kind.HOST),
        Field(R.id.configPort, "server.port", Kind.INT),
        Field(R.id.configPrefix, "server.prefix", Kind.STRING),
        Field(R.id.configCert, "server.cert", Kind.STRING),
        Field(R.id.configKey, "server.key", Kind.STRING),
        Field(R.id.configDbPath, "server.dbPath", Kind.STRING),
        Field(R.id.configStorageDir, "server.storageDir", Kind.STRING),
        Field(R.id.configHistory, "server.history", Kind.INT),
        Field(R.id.configTextLimit, "text.limit", Kind.INT),
        Field(R.id.configFileLimit, "file.limit", Kind.INT),
        Field(R.id.configFileChunk, "file.chunk", Kind.INT),
        Field(R.id.configFileExpire, "file.expire", Kind.INT),
        Field(R.id.configTickSeconds, "automation.tickSeconds", Kind.INT),
        Field(R.id.configGraceSeconds, "automation.graceSeconds", Kind.INT),
        Field(R.id.configDefaultTz, "automation.defaultTZ", Kind.STRING),
    )

    /** 两个开关：它们没有「原文」的歧义（JSON 里就是 `true` / `false`）。 */
    private val switches: List<Pair<Int, String>> = listOf(
        R.id.configRoomListSwitch to "server.roomList",
        R.id.configAutomationEnabled to "automation.enabled",
    )

    /** 「有什么东西被改了」时回调（Activity 用它刷新底部那条横栏）。 */
    var onChange: (() -> Unit)? = null

    /** 装载时那份配置的深拷贝。「改过了吗」拿它当参照物。 */
    private var original: JSONObject? = null

    /**
     * 装载时**画成了房间行**的那些键。
     *
     * ⚠️★ 它用来区分两种「`roomAuth` 里有、但界面上没有」的键，而这两者的处理正好相反：
     *
     * - 在 [drawn] 里、但取样时没了 → 用户**删掉了**这一行 → 要真的删掉；
     * - 不在 [drawn] 里（形态不合法，比如 `null` 或者数组，读进来就会被服务端拒）
     *   → **原样保留**，不能因为界面上看不见就顺手抹掉。
     *
     * 少了它就只能二选一：要么删不掉房间，要么把配置里读不懂的部分静默清掉。
     */
    private val drawn = mutableSetOf<String>()

    /** 一个房间行和它的原始条目。 */
    private class RoomRow(val view: View, val entry: Any) {
        /** 装载时各控件的值（用来判断这一行动过没有）。 */
        var snapshot: JSONObject = JSONObject()
    }

    private val rows = mutableListOf<RoomRow>()

    private val roomList: LinearLayout = root.findViewById(R.id.configRoomList)
    private val roomsEmpty: TextView = root.findViewById(R.id.configRoomsEmpty)
    private val roomsTitle: TextView = root.findViewById(R.id.configRoomsTitle)
    private val authFlag: TextView = root.findViewById(R.id.configAuthFlag)
    private val notice: TextView = root.findViewById(R.id.configNotice)
    private val notCreated: TextView = root.findViewById(R.id.configNotCreated)

    init {
        // 每个开关动一下就刷新一遍底部那条「未生效」—— 开关没有文本框那种「原文」问题，
        // 所以不需要在取样时做等价判断。
        for ((id, _) in switches) {
            root.findViewById<Switch>(id).setOnCheckedChangeListener { _, _ -> onChange?.invoke() }
        }
        for (field in fields) {
            root.findViewById<EditText>(field.id).doAfterTextChanged { onChange?.invoke() }
        }
        // ⚠️ 单独再挂一个：全局密码那一格还要顺手刷新「需要密码 / 不需要密码」那个标签，
        // 而它是**这一格自己的事**，不该让所有文本框都去猜自己是不是密码框。
        root.findViewById<EditText>(R.id.configGlobalPassword)
            .doAfterTextChanged { refreshAuthFlag() }
        root.findViewById<Button>(R.id.configAddRoomButton).setOnClickListener { addRoom("", null) }
    }

    // ── 装载 ──────────────────────────────────────────────────────────

    /**
     * 把配置画到表单上。
     *
     * ⚠️ 每次调用都会**丢掉**所有房间行重建（房间数量不定，逐行 diff 不值当）。
     * 所以别在用户正在填的时候调它 —— 只有「刚打开」和「放弃改动」两处会调。
     */
    fun load(loaded: ServerConfigStore.Loaded) {
        rows.clear()
        drawn.clear()
        roomList.removeAllViews()

        if (loaded is ServerConfigStore.Loaded.Broken) {
            original = null
            notice.visibility = View.VISIBLE
            notice.text = activity.getString(R.string.config_broken, loaded.message) +
                "\n\n" + activity.getString(R.string.config_broken_note)
            notCreated.visibility = View.GONE
            return
        }

        val config = (loaded as ServerConfigStore.Loaded.Ok).config
        original = deepCopy(config)
        notice.visibility = View.GONE
        notCreated.visibility = if (loaded.exists) View.GONE else View.VISIBLE

        for (field in fields) {
            val raw = at(config, field.path)
            field.originalRaw = raw
            field.originalText = toText(field.kind, raw)
            root.findViewById<EditText>(field.id).setText(field.originalText)
        }
        for ((id, path) in switches) {
            root.findViewById<Switch>(id).isChecked = at(config, path) as? Boolean ?: false
        }

        root.findViewById<TextView>(R.id.configDataDir).text =
            activity.getString(R.string.data_dir, activity.filesDir.absolutePath)

        val roomAuth = at(config, "server.roomAuth") as? JSONObject
        if (roomAuth != null) {
            // ⚠️ 按房间名排序：`JSONObject` 内部是插入序，而它来自配置文件的行序 ——
            // 直接按它画的话，同一份配置在两次装载之后可能顺序不同（服务端写回时重排过），
            // 于是「什么都没改」也会看起来变了个样。
            for (name in roomAuth.keys().asSequence().sorted()) {
                val raw = roomAuth.opt(name)
                // ⚠️★ 只有那**四种合法形态**才画成行（见 `RoomAuthEntry::from_json`）。
                //    其余形态（`null`、数组、嵌套对象…）读了会让服务端**整个配置解析失败**，
                //    所以它们既不该画、也不该动 —— `build()` 会把没画出来的键原样放回去。
                if (raw !is JSONObject && raw !is String && raw !is Number) continue
                drawn += name
                addRoom(name, raw)
            }
        }
        refreshRoomsHeader()
        refreshAuthFlag()
    }

    // ── 取样 ──────────────────────────────────────────────────────────

    /**
     * 把表单上的东西拼成一份**完整**的配置（整份替换，不是补丁）。
     *
     * ⚠️ 返回 `null` = 没得拼（配置本来就读不出来）。⚠️ 这时候**绝不能**编一份默认值出来：
     * 那正是「用户一按保存，真配置被默认值盖掉」那条路。
     */
    fun build(): JSONObject? {
        val origin = original ?: return null
        val config = deepCopy(origin)

        for (field in fields) {
            val text = root.findViewById<EditText>(field.id).text.toString()
            val value = if (text == field.originalText) field.originalRaw else fromText(field.kind, text)
            put(config, field.path, value)
        }
        for ((id, path) in switches) {
            put(config, path, root.findViewById<Switch>(id).isChecked)
        }

        val server = config.optJSONObject("server") ?: JSONObject().also { config.put("server", it) }
        val merged = mergeRooms(origin, readRooms())
        // ⚠️★ 「没有房间」与「这个键本来就不在」是两件事（2026-09-29，Jonny 在真机上看到
        // 底部那条「未生效的更改」**永远挂着**——他什么都没改）：
        // 服务端的默认配置里就写着 `"roomAuth": {}`（`RoomAuthConfig` 是空 map，
        // `#[serde(transparent)]` 序列化成空对象），而「空就删」会把它删掉 ——
        // 与装载时那份比**永远不同**，`changed()` 恒为 true，横栏常显，
        // 而且一按「保存并重启」还会把这个键从文件里抹掉。
        // ⚠️ 所以「空就删」只对**装载时就没有这个键**的那份成立；装载时有（哪怕是空的）
        // 就得原样放回去 —— 放一个空对象与不写这个键，在服务端眼里语义相同，但只有前者
        // 能让「没改就是没改」成立。用 Node 逐行复刻过这条往返（`/tmp` 夹具，§0.4）。
        if (merged.length() > 0 || at(origin, "server.roomAuth") != null) {
            server.put("roomAuth", merged)
        } else {
            server.remove("roomAuth")
        }

        return config
    }

    /**
     * 把「界面上画出来的那些房间」合并回**原来那一份** `roomAuth`。
     *
     * ⚠️★ 从原来的那份出发，而不是从空对象出发 —— 界面上没有画出来的键
     * （形态不合法、读进来就会被服务端拒的那种）要**原样留着**。
     * 判据是装载时记下来的 [drawn]：
     *
     * - 在 [drawn] 里、但取样时没了 → 用户删掉了这一行 → 真的删掉；
     * - 不在 [drawn] 里 → 不是我们画的，别动。
     *
     * 少了这个区分就只能二选一：要么房间删不掉，要么把配置里读不懂的部分静默抹掉。
     */
    private fun mergeRooms(origin: JSONObject, current: JSONObject): JSONObject {
        val old = origin.optJSONObject("server")?.optJSONObject("roomAuth") ?: JSONObject()
        val merged = JSONObject()
        for (name in old.keys().asSequence().sorted()) {
            if (drawn.contains(name)) continue
            merged.put(name, old.opt(name))
        }
        for (name in current.keys().asSequence().sorted()) {
            merged.put(name, current.opt(name))
        }
        return merged
    }

    /** 表单和装载时那份比，变了吗。⚠️ 拿字符串比：`JSONObject` 的 `toString` 顺序稳定。 */
    fun changed(): Boolean {
        val origin = original ?: return false
        val current = build() ?: return false
        return current.toString() != origin.toString()
    }

    /**
     * 现在能不能保存。`null` = 能；非 null = **一句能原样显示给用户的话**。
     *
     * ⚠️★ 这里只判**表单这一层**才看得见的两件事：
     *
     * ① 配置根本读不出来 —— 保存会把盘上那份真配置盖成一份默认值；
     * ② 某个数字框里填的**不是整数**。Rust 那边收到的是一个「已经被读成 0」的数，
     *    它**分不出**「用户真想填 0」与「用户打了一串字母」。
     *
     * ⚠️★ 别的（端口能不能用、正文上限超没超、证书是不是配了一半…）**一概不在这里判**：
     * 那些是**配置语义**，只在 `clip9-core` 的 `validate_for_save` 里实现一次
     * （理由见类文档）。在这边抄一遍必然漂，而漂了的两种结果都很难看。
     * 所以这里判出来的话与那边给的**原话**是两句不同的话，各说各的那一层。
     */
    fun blockReason(): String? {
        if (original == null) return activity.getString(R.string.config_unreadable)
        for (field in fields) {
            if (field.kind != Kind.INT) continue
            val text = root.findViewById<EditText>(field.id).text.toString().trim()
            if (text.toLongOrNull() != null) continue
            return if (text.isEmpty()) {
                activity.getString(R.string.config_number_missing)
            } else {
                // ⚠️ 把**用户填的那串字符**原样带出来：「哪个框错了」这件事只有表单知道，
                //    而这一句是唯一能告诉他「就是这一格」的地方。
                activity.getString(R.string.config_invalid_number, text)
            }
        }
        return null
    }

    /** 变了多少个**顶层块**（`server` / `text` / `file` / `automation`）。只用于那句提示。 */
    fun changedAreaCount(): Int {
        val origin = original ?: return 0
        val current = build() ?: return 0
        var count = 0
        for (key in listOf("server", "text", "file", "automation")) {
            val a = origin.optJSONObject(key)?.toString()
            val b = current.optJSONObject(key)?.toString()
            if (a != b) count += 1
        }
        // ⚠️ 一个块都没变时也要给出 1 —— 免得出现「0 处更改未生效」这种自相矛盾的横幅。
        return count.coerceAtLeast(if (changed()) 1 else 0)
    }

    // ── 房间（动态行）──────────────────────────────────────────────────

    /**
     * 加一个房间行。
     *
     * @param name 房间名（空串 = 还没起名）。
     * @param raw 这一项在配置里的**原始形态**（`"pw"` / `123` / `{…}` / null）。
     *   ⚠️ 原样留着：用户没动它的时候要原样放回去。
     */
    private fun addRoom(name: String, raw: Any?) {
        val row = LayoutInflater.from(activity).inflate(R.layout.layout_room_row, roomList, false)
        // ⚠️ `JSONObject.NULL`（配置里真的写着 `null`）也要当成「没有原始条目」：
        // 原样放回去会让 `RoomAuthEntry::from_json` 报错，而那是**整份配置**解析失败、
        // 服务端起不来。
        val entry: Any = if (raw == null || raw === JSONObject.NULL) JSONObject() else raw

        val nameInput = row.findViewById<EditText>(R.id.roomName)
        val password = row.findViewById<EditText>(R.id.roomPassword)
        val open = row.findViewById<Switch>(R.id.roomOpen)
        val expire = row.findViewById<EditText>(R.id.roomExpire)

        nameInput.setText(name)
        password.setText(normalizedEntry(entry).optString("password"))
        open.isChecked = normalizedEntry(entry).opt("open") as? Boolean ?: false
        val fileExpire = normalizedEntry(entry).opt("fileExpire")
        expire.setText(if (fileExpire is Number) fileExpire.toLong().toString() else "")
        setAutomation(row, normalizedEntry(entry).optString("automation"))

        val globalExpire = at(original ?: JSONObject(), "file.expire") as? Number
        row.findViewById<TextView>(R.id.roomExpireHint).text = activity.getString(
            R.string.config_room_expire_hint,
            globalExpire?.toLong() ?: 0L,
        )

        val record = RoomRow(row, entry)
        record.snapshot = roomSnapshot(row)
        rows += record

        // 顶部那一行：房间名 + 一个标签 + 展开 / 收起。
        nameInput.doAfterTextChanged { refreshRoomsHeader(); onChange?.invoke() }
        open.setOnCheckedChangeListener { _, _ -> refreshRoomsHeader(); onChange?.invoke() }
        password.doAfterTextChanged { onChange?.invoke() }
        expire.doAfterTextChanged { onChange?.invoke() }
        row.findViewById<RadioGroup>(R.id.roomAutomation)
            .setOnCheckedChangeListener { _, _ -> onChange?.invoke() }

        row.findViewById<Button>(R.id.roomExpand).setOnClickListener {
            val body = row.findViewById<View>(R.id.roomBody)
            val opening = body.visibility != View.VISIBLE
            body.visibility = if (opening) View.VISIBLE else View.GONE
            row.findViewById<Button>(R.id.roomExpand)
                .setText(if (opening) R.string.config_room_collapse else R.string.config_room_expand)
        }

        row.findViewById<Button>(R.id.roomRemove).setOnClickListener {
            // ⚠️ 删一个**已经存在**的房间要问一句：它是「保存并重启」才会真的生效，
            // 但那之后这个房间就没有单独的密码了 —— 是不可逆的一步。
            val label = nameInput.text.toString().trim().ifEmpty { "default" }
            AlertDialog.Builder(activity)
                .setMessage(activity.getString(R.string.config_room_remove_confirm, label))
                .setPositiveButton(R.string.config_room_remove) { _, _ ->
                    roomList.removeView(row)
                    rows.remove(record)
                    refreshRoomsHeader()
                    onChange?.invoke()
                }
                .setNegativeButton(R.string.remote_cancel, null)
                .show()
        }

        roomList.addView(row)
        refreshRoomsHeader()
    }

    /** 把 `roomAuth` 里一项的四种合法形态归一成对象（只为**显示**；写回时仍用原文）。 */
    private fun normalizedEntry(raw: Any?): JSONObject = when (raw) {
        is JSONObject -> raw
        is String -> JSONObject().put("password", raw)
        is Number -> JSONObject().put("password", raw.toLong().toString())
        else -> JSONObject()
    }

    private fun setAutomation(row: View, value: String) {
        val id = when (value) {
            "none" -> R.id.roomAutoNone
            "single" -> R.id.roomAutoSingle
            "room" -> R.id.roomAutoRoom
            else -> R.id.roomAutoFollow
        }
        row.findViewById<RadioGroup>(R.id.roomAutomation).check(id)
    }

    private fun automationOf(row: View): String =
        when (row.findViewById<RadioGroup>(R.id.roomAutomation).checkedRadioButtonId) {
            R.id.roomAutoNone -> "none"
            R.id.roomAutoSingle -> "single"
            R.id.roomAutoRoom -> "room"
            else -> ""
        }

    /** 这一行现在的值（用来和装载时的 [RoomRow.snapshot] 比）。 */
    private fun roomSnapshot(row: View): JSONObject = JSONObject()
        .put("name", row.findViewById<EditText>(R.id.roomName).text.toString().trim())
        .put("password", row.findViewById<EditText>(R.id.roomPassword).text.toString())
        .put("open", row.findViewById<Switch>(R.id.roomOpen).isChecked)
        .put("expire", row.findViewById<EditText>(R.id.roomExpire).text.toString().trim())
        .put("automation", automationOf(row))

    /**
     * 拼 `roomAuth`。
     *
     * ⚠️★ 只写「真的设过的」键：全写上会让配置里多出一堆
     * `{"password":"","open":false}` —— 语义上确实等价，但在**配置文件**里是噪音，
     * 用户拿它跟别的实现 diff 时会以为哪儿被改了。
     *
     * ⚠️★ 一行**完全没动过**时放回它的**原始形态**（`"pw"` 还是 `"pw"`，不是 `{"password":"pw"}`）。
     * 理由见类文档那段「没动过的字段要原样放回去」。
     */
    private fun readRooms(): JSONObject {
        val out = JSONObject()
        for (record in rows) {
            val row = record.view
            val now = roomSnapshot(row)
            val name = now.optString("name")
            // ⚠️ 名字留空 = 默认房间：服务端那边 `normalize_room_name("")` 也是 `default`，
            // 所以两种写法落到同一格。写成空串会在 `roomAuth` 里多出一个没人认得的键。
            val key = if (name.isEmpty() || name == "default") "default" else name

            if (now.toString() == record.snapshot.toString()) {
                // ⚠️★ 没动过 → 原样放回它**原来**的样子（`"pw"` 还是 `"pw"`，
                //    不是被我们规整成 `{"password":"pw"}`）—— 否则用户什么都没改，
                //    配置文件里也会出现一大片 diff，「到底改了没有」就再也看不出来了。
                // ⚠️ 原本就**没有内容**的（键不存在、或者是个读不出来的形态）就别写回去：
                //    写一个空对象等于凭空多出一条，而 `null` 更会让**整份配置解析失败**。
                when (val raw = record.entry) {
                    is JSONObject -> if (raw.length() > 0) out.put(key, raw)
                    is String, is Number -> out.put(key, raw)
                    else -> Unit
                }
                continue
            }

            val entry = JSONObject()
            val password = now.optString("password")
            if (password.isNotEmpty()) entry.put("password", password)
            if (now.optBoolean("open")) entry.put("open", true)
            now.optString("expire").toLongOrNull()?.let { entry.put("fileExpire", it) }
            now.optString("automation").takeIf { it.isNotEmpty() }?.let { entry.put("automation", it) }

            // 什么都清空了 = 用户想让这个房间「回到没配过」，那就别写这一条。
            if (entry.length() == 0) continue
            out.put(key, entry)
        }
        return out
    }

    private fun refreshRoomsHeader() {
        roomsTitle.text = activity.getString(R.string.config_rooms_count, rows.size)
        roomsEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        for (record in rows) {
            val name = record.view.findViewById<EditText>(R.id.roomName).text.toString().trim()
            val open = record.view.findViewById<Switch>(R.id.roomOpen).isChecked
            val label = name.ifEmpty { "default" }
            record.view.findViewById<TextView>(R.id.roomHeadName).text = label
            record.view.findViewById<TextView>(R.id.roomHeadFlag).text =
                activity.getString(if (open) R.string.config_room_opened else R.string.config_room_locked)
        }
    }

    private fun refreshAuthFlag() {
        val empty = root.findViewById<EditText>(R.id.configGlobalPassword).text.toString().trim().isEmpty()
        authFlag.text = activity.getString(
            if (empty) R.string.config_flag_open else R.string.config_flag_password_set,
        )
    }

    // ── JSON 小工具 ────────────────────────────────────────────────────

    private fun deepCopy(json: JSONObject): JSONObject = JSONObject(json.toString())

    /** 读 `"a.b.c"`。⚠️ JSON 里的 `null` 与「键不存在」在这里是同一件事（都当没配过）。 */
    private fun at(json: JSONObject, path: String): Any? {
        var node: Any = json
        for (part in path.split('.')) {
            val object_ = node as? JSONObject ?: return null
            val value = object_.opt(part)
            if (value == null || value === JSONObject.NULL) return null
            node = value
        }
        return node
    }

    /** 写 `"a.b.c"`。`null` = 把这个键删掉（而不是写一个 `null` 进去）。 */
    private fun put(json: JSONObject, path: String, value: Any?) {
        val parts = path.split('.')
        var node = json
        for (part in parts.dropLast(1)) {
            node = node.optJSONObject(part) ?: JSONObject().also { node.put(part, it) }
        }
        val last = parts.last()
        when {
            value == null -> node.remove(last)
            else -> node.put(last, value)
        }
    }

    private fun toText(kind: Kind, raw: Any?): String = when (kind) {
        Kind.INT -> when (raw) {
            is Number -> raw.toLong().toString()
            null -> ""
            else -> raw.toString()
        }
        Kind.STRING -> raw?.toString().orEmpty()
        // ⚠️ `false` 与数字 `0` 都是「没配密码」的写法 → 显示成空框。
        //    `true` 没有密码含义（`normalize` 也给空串），同样显示成空框。
        Kind.AUTH -> when (raw) {
            null, is Boolean -> ""
            is Number -> if (raw.toLong() == 0L) "" else raw.toString()
            else -> raw.toString()
        }
        Kind.HOST -> when (raw) {
            null -> ""
            // ⚠️ 数组那一种在框里画成**逗号分隔的一行**（`0.0.0.0,::`）—— 那正是
            //    `serve::resolve_hosts` 认的第三种写法，所以「看一眼再存回去」不会改变语义。
            is JSONArray -> (0 until raw.length())
                .map { raw.optString(it) }
                .filter { it.isNotEmpty() }
                .joinToString(",")
            else -> raw.toString()
        }
    }

    private fun fromText(kind: Kind, text: String): Any? {
        val trimmed = text.trim()
        return when (kind) {
            Kind.INT -> trimmed.toLongOrNull() ?: 0L
            Kind.STRING -> trimmed
            // ⚠️ 空 → `false`（不是空串）：`false` 是这份配置里「没配密码」的**标准写法**，
            //    与 Go 的 `defaultConfig()` 一致。存空串语义上等价，但会让 diff 变吵。
            Kind.AUTH -> if (trimmed.isEmpty()) false else text
            // ⚠️ 空 → `["0.0.0.0"]`（与 `Config::default()` 一致）：空的 host 会被
            //    服务端补成 `0.0.0.0`，那不如就在这里写成它。
            Kind.HOST -> if (trimmed.isEmpty()) JSONArray().put("0.0.0.0") else trimmed
        }
    }
}
