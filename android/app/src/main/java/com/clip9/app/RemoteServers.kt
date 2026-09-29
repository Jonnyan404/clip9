package com.clip9.app

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 一台远端服务端。
 *
 * ⚠️★ 字段与 Rust 客户端的 `Channel` 对齐（`rust/crates/client/src/config.rs` 里的
 * `Channel { name, server, room, auth_token, … }`）—— 那是**同一个概念**，
 * 别在这边另起一套名字（「同一个东西在两个端上有两个名字」是这个项目反复踩的坑）。
 *
 * ⚠️ 只有一处差别，而且是**故意**的：那边存 `auth_token`（一张会话令牌），
 * 这边存**明文密码** —— 因为「打开界面前自动认证」必须能自己拿密码去换令牌。
 * 落盘时它由 [SecretBox] 加密，所以字段名叫 `password`（内存语义）而不是 `secret`。
 *
 * @property id 稳定标识。改名、改地址都不会让它变 —— 清单里靠它定位那一行。
 * @property name 用户给这台起的名字（「家里」「公司」）。
 * @property url **已经补过协议**的地址（`http://192.168.1.10:9501/`）。
 *   ⚠️ 存补过的那一份，不存用户原样输入的 —— 见 `MainActivity.openRemote` 里那段注释。
 * @property room 打开界面时落在哪个房间。空串 = 默认房间（就是 `default`）。
 * @property password 明文密码，**只在内存里是这样**。空串 = 没存。
 * @property rememberPassword 要不要把密码落盘（关掉时 `password` 只活在这一次编辑里）。
 * @property autoAuth 打开网页界面前先用密码换一张会话令牌。
 */
data class RemoteServer(
    val id: String,
    val name: String,
    val url: String,
    val room: String,
    val password: String,
    val rememberPassword: Boolean,
    val autoAuth: Boolean,
) {
    companion object {
        /** 新建一台（还没填任何东西）。 */
        fun blank(): RemoteServer = RemoteServer(
            id = UUID.randomUUID().toString(),
            name = "",
            url = "",
            room = "",
            password = "",
            rememberPassword = true,
            autoAuth = true,
        )
    }
}

/**
 * 远端服务器清单：**可以保存多台**，各自带自己的密码与开关。
 *
 * ⚠️★ 整份落在一个 `SharedPreferences` 键里的一段 JSON，不是「每台一组 key」。
 * 后者在删掉中间那一台之后会留下**孤儿键**（再也读不到、也永远不会被清掉），
 * 而且「清单」这个整体被拆散之后，遍历、排序、去重都得靠人拼。
 * 这一条与前端那条「列表字段整份替换」是同一个理由。
 *
 * ⚠️★ 密码**不在这里明文落盘**：`secret` 字段是 [SecretBox] 的输出。
 * 解不开时按「没存过密码」处理（换机 / 清数据之后的正常形态），**不报错**。
 *
 * ⚠️ 与 [AppPrefs] 的分工：这里装的是**用户配的那些服务器**，
 * 那边是 App 自己的开关。两者都**不**进 `config.json` —— 那个文件是**服务端**的配置，
 * 与「这台手机连过谁」没有任何关系（别把两端的东西混在一个文件里）。
 */
object RemoteServers {

    private const val LOG_TAG = "clip9-servers"

    /**
     * ⚠️ 文件名叫 `clip9_servers` 而不是复用 `clip9`：那份偏好里装的是
     * 端口这类**启动参数**，混进来之后「清一下服务器的配置」这种操作就会连
     * 用户的服务器清单一起清掉。
     */
    private const val FILE = "clip9_servers"
    private const val KEY = "servers"
    private const val KEY_SELECTED = "selected"

    /** 整份清单 + 当前选中的那一台。⚠️ 两者**一起**读写，免得出现「选中的那台已经不在清单里」。 */
    data class Snapshot(val servers: List<RemoteServer>, val selectedId: String) {
        val selected: RemoteServer? get() = servers.firstOrNull { it.id == selectedId }
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /**
     * 读清单。
     *
     * ⚠️★ 这段 JSON 解析**不能抛**、也**不能顺手写回**：解析失败时返回空清单，
     * 但盘上那份原样留着（用户可能还有救回它的机会，而一次「读失败就写回空清单」
     * 会把最后一个字节也抹掉）。
     */
    fun load(context: Context): Snapshot {
        migrateLegacyRemoteUrl(context)

        val raw = prefs(context).getString(KEY, "").orEmpty()
        if (raw.isEmpty()) return Snapshot(emptyList(), "")

        val root = try {
            JSONObject(raw)
        } catch (t: Throwable) {
            Log.w(LOG_TAG, "服务器清单读不出来（按空清单显示，盘上那份不动）", t)
            return Snapshot(emptyList(), "")
        }

        val array = root.optJSONArray("servers") ?: JSONArray()
        val servers = ArrayList<RemoteServer>(array.length())
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString("id")
            // ⚠️ 没有 id 的条目**丢掉**：它是「改名时定位不到」的那种数据，
            // 留着只会在保存时被当成新的一台又写一遍（清单越用越长）。
            if (id.isEmpty()) continue
            val remember = item.optBoolean("remember", false)
            servers += RemoteServer(
                id = id,
                name = item.optString("name"),
                url = item.optString("url"),
                room = item.optString("room"),
                // ⚠️ 解不开 = 空串 = 「没存过密码」。这是**正常**结果，不是错误。
                password = if (remember) SecretBox.open(item.optString("secret")).orEmpty() else "",
                rememberPassword = remember,
                autoAuth = item.optBoolean("autoAuth", false),
            )
        }
        val selectedId = root.optString("selected").takeIf { id -> servers.any { it.id == id } }.orEmpty()
        return Snapshot(servers, selectedId)
    }

    /** 整份写回。⚠️ 保存**不**碰 `selected` 之外的东西：调用方给什么就是什么。 */
    fun save(context: Context, snapshot: Snapshot) {
        prefs(context).edit().putString(KEY, encode(snapshot)).apply()
    }

    /**
     * 换一台「当前用它」的。
     *
     * ⚠️★ 它是**立刻生效**的（不像服务端配置那样要保存并重启）：用户点了一下
     * 「用这台打开」，下一个动作就是打开界面 —— 这时候再让他去按一次保存是说不过去的。
     * 所以它单独一个入口，而不是混在 `save` 里。
     */
    fun select(context: Context, id: String) {
        val current = load(context)
        save(context, current.copy(selectedId = id))
    }

    private fun encode(snapshot: Snapshot): String {
        val array = JSONArray()
        for (server in snapshot.servers) {
            array.put(
                JSONObject().apply {
                    put("id", server.id)
                    put("name", server.name)
                    put("url", server.url)
                    put("room", server.room)
                    put("remember", server.rememberPassword)
                    // ⚠️ 关掉「记住密码」时**连密文都不留**：留着的话用户以为已经删了，
                    // 而它还在盘上（只是不被读）—— 「关掉开关 = 删掉」比「关掉开关 = 藏起来」好懂。
                    put(
                        "secret",
                        if (server.rememberPassword) SecretBox.seal(server.password).orEmpty() else "",
                    )
                    put("autoAuth", server.autoAuth)
                },
            )
        }
        return JSONObject().apply {
            put("servers", array)
            put("selected", snapshot.selectedId)
        }.toString()
    }

    /**
     * 把老版本那个**单台**的 `AppPrefs.remoteUrl` 搬进清单（一次性）。
     *
     * ⚠️★ 搬完就把老键**清掉** —— 不清的话「用户把清单清空」之后
     * 下一次启动又会凭空冒出一台（因为迁移条件仍然成立）。
     *
     * ⚠️ 只在「清单还是空的」时候搬：清单非空 = 用户已经在用新的形态了，
     * 这时候再往里塞一台是**添乱**（而且他刚才删掉的可能就是那一台）。
     */
    private fun migrateLegacyRemoteUrl(context: Context) {
        val legacy = AppPrefs.remoteUrl(context)
        if (legacy.isEmpty()) return
        val current = prefs(context).getString(KEY, "").orEmpty()
        if (current.isNotEmpty()) {
            // 已经用过新形态 → 老键只是残留，清掉（不搬）。
            AppPrefs.setRemoteUrl(context, "")
            return
        }
        val migrated = RemoteServer(
            id = UUID.randomUUID().toString(),
            name = context.getString(R.string.remote_default_name),
            url = legacy,
            room = "",
            password = "",
            rememberPassword = true,
            autoAuth = true,
        )
        save(context, Snapshot(listOf(migrated), migrated.id))
        AppPrefs.setRemoteUrl(context, "")
        Log.i(LOG_TAG, "把老版本的单个远端地址搬进了服务器清单")
    }
}
