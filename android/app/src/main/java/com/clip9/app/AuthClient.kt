package com.clip9.app

import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.SSLException

/**
 * 用密码换一张**会话令牌**（`POST /auth/token`）。
 *
 * ⚠️★ 这是「**免打开界面认证**」那两个动作里的第一个：
 * 原生外壳先用保存的密码换一张令牌 → 打开网页界面时把令牌交给 SPA
 * （第二个动作在 [WebAppActivity] 与 SPA 的 `store/websocket.js` 里）。
 *
 * ⚠️★ 为什么**不去拿密码做别的事**、也不把密码交给网页：
 * 密码是长期凭据，而令牌一小时后自己过期。把密码交出去意味着
 * 网页（以及任何注入进去的脚本）**一直**握着它；令牌则是一次性的、可丢的。
 * 这条与 `rust/crates/server/src/auth_token.rs` 抬头的说法是同一件事。
 *
 * ⚠️★ 它走的是**服务端真的那一条路**（同一个端点、同一个 body 形状），
 * 不是「ping 一下地址看通不通」。理由：只要「测试」和「真的用」是两条路，
 * 「测试通过、打开还是被拦」就会天天发生 —— 而那正是用户最难自己查的一类问题。
 * 协议见 `rust/crates/server/src/auth_token.rs`（`issue`）：
 *
 * ```text
 * POST {base}/auth/token?room={room}   体：{"password":"…"}
 * → 200 {"token":"…","expiresAt":<Unix 秒>,"scope":"" | "global"}
 * → 401 {"code":"wrong_password","error":"…","message":"密码不正确"}
 * ```
 */
object AuthClient {

    private const val LOG_TAG = "clip9-auth"

    /** 换令牌用的路径。⚠️ 与 `rust/crates/server/src/lib.rs` 的路由表逐字对应。 */
    private const val TOKEN_PATH = "auth/token"

    /**
     * 单次请求的超时。
     *
     * ⚠️ 取 8 秒：这条路上用户**正在等着界面打开**，等太久不如早点告诉他连不上
     * （他还能去网页界面里手输密码，那条路不受这里影响）。
     */
    private const val TIMEOUT_MS = 8_000

    /**
     * 探活用的路径。
     *
     * ⚠️★ 它必须与 `rust/crates/server/src/lib.rs` 的 `/server` 逐字对应。
     * 选它（而不是 `/healthz`）是因为 `/server` **会回一份带鉴权信息的 JSON**：
     * `auth` 说这台对**这个房间**要不要密码、`authorized` 说当前这次算不算数。
     * `/healthz` 只回一个 `ok` —— 任何 web 服务器（包括反代自己的门户页）都做得到，
     * 于是「测试通过、打开还是被拦」会变成常态。
     */
    private const val PROBE_PATH = "server"

    /**
     * 自签证书那一句。
     *
     * ⚠️ 只写一份：换令牌与探活两条路都会撞上它，而「同一件事在两处写着两句不同的话」
     * 正是这个项目反复踩的坑。
     */
    private const val SELF_SIGNED_MESSAGE =
        "这台服务端的证书没通过校验，没有发送密码。装好证书再来，或者先在网页界面里打开（那里可以逐次确认）。"

    /** 换令牌的结果。 */
    sealed interface Result {
        /**
         * 换到了。
         *
         * @property expiresAt **Unix 秒**（与 SPA 的 `roomAuthCache` 同一套坐标系），
         *   `0` = 不过期。
         * @property scope `global`（用全局密码换的，等于管理员）或空串（房间令牌）。
         */
        data class Ok(val token: String, val expiresAt: Long, val scope: String) : Result

        /** 换不到。`message` 是**一句能原样给用户看的话**。 */
        data class Failed(val message: String) : Result
    }

    /**
     * 「测试连接」的结果。
     *
     * ⚠️★ 它**不是** [Result] 的别名，因为多了一种「真的问过服务端、但它不需要密码」
     * 这种**成功**的形态 —— 硬塞进 `Result` 就只能捏一张假令牌出来，
     * 而假令牌的下一步就是「测试通过、打开还要输密码」。
     */
    sealed interface Probe {
        /** 密码对，换到令牌了。`expiresAt` 同 [Result.Ok]。 */
        data class Token(val expiresAt: Long) : Probe

        /**
         * 地址通了、也认出来是 clip9，但这次**没填密码**。
         *
         * @property needsPassword 服务端自己说的：这个房间要不要密码。
         *   它是**问出来的**（`/server` 的 `auth` 字段），不是我们猜的 ——
         *   行上那个小圆点是本地推断（见 [RemoteServerList]），两者刻意不同。
         */
        data class Reachable(val needsPassword: Boolean) : Probe

        /** 没通。`message` 是**一句能原样给用户看的话**。 */
        data class Failed(val message: String) : Probe
    }

    /**
     * 走一遍**真要用的那条路**去试。
     *
     * ⚠️★ 填了密码就用密码换令牌（和打开界面时同一个接口）；没填密码就只问到
     * `/server` 为止，**并如实报告服务端说的「要不要密码」**——
     * 不编结果。理由：只要「测试」和「真的用」是两条路，
     * 「测试通过、打开还是被拦」就会天天发生，而那正是用户最难自己查的一类问题。
     *
     * ⚠️ **阻塞**（最长约 [TIMEOUT_MS]）—— 别在 UI 线程调。
     */
    fun test(serverUrl: String, room: String, password: String): Probe {
        if (serverUrl.trim().isEmpty()) return Probe.Failed("地址不能为空")
        if (password.isEmpty()) return probe(serverUrl, room)
        return when (val result = requestToken(serverUrl, room, password)) {
            is Result.Ok -> Probe.Token(result.expiresAt)
            is Result.Failed -> Probe.Failed(result.message)
        }
    }

    /**
     * 用密码换一张牌。**阻塞**（最长约 [TIMEOUT_MS]）—— ⚠️ **别在 UI 线程调**。
     *
     * @param serverUrl 那台服务端的地址（`http://host:9501/`，可以带子路径前缀）。
     * @param room 要进哪个房间。空串 = 默认房间。
     * @param password 明文密码。⚠️ 空串直接判失败 —— 服务端对空密码也是 401，
     *   但那要跑一趟网络才知道；本地判掉还能说清「你没填密码」。
     */
    fun requestToken(serverUrl: String, room: String, password: String): Result {
        if (password.isEmpty()) return Result.Failed("没有可用的密码")

        val endpoint = tokenUrl(serverUrl, room)
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            val body = JSONObject().put("password", password).toString()
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { it.readText() }
                .orEmpty()

            if (code !in 200..299) Result.Failed(refusal(code, text)) else parse(text)
        } catch (e: SSLException) {
            // ⚠️★ 自签证书会走到这里，而这在实际部署里**很常见**（用户自己起的那台）。
            // 这里**刻意不放行**：原生侧没有「显示指纹让用户逐次确认」那一套，
            // 而无条件信任等于把 TLS 校验关掉。给一句**能行动**的话，
            // 并指出还有一条路（网页界面里能逐次确认）—— 但**不**替他决定。
            Result.Failed(SELF_SIGNED_MESSAGE)
        } catch (e: IOException) {
            Result.Failed("连不上 ${endpoint}（${e.message ?: e.javaClass.simpleName}）")
        } catch (t: Throwable) {
            Log.w(LOG_TAG, "换令牌时出了意料之外的错", t)
            Result.Failed("换令牌失败（${t.message ?: t.javaClass.simpleName}）")
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * 没密码时的那次探活：`GET {base}/server?room=…`。
     *
     * ⚠️★ **认形状**，不是「有东西应答就算通」：应答必须是 JSON、而且带 `server` 与 `auth`
     * 两个键（见 `rust/crates/server/src/handlers.rs` 的 `server()`）。
     * 少了这一步的话，反代自己的登录门户、路由器管理页、随便一个 404 页
     * 都会得到「地址通了」—— 而用户下一步就是拿一个通不了的东西去打开界面。
     *
     * ⚠️ 走这个端点**不需要令牌**：它对未授权者照常回 200，只是 `authorized` 是 `false`。
     * 我们只读 `auth`（「要不要密码」），不读 `authorized`。
     */
    private fun probe(serverUrl: String, room: String): Probe {
        val endpoint = probeUrl(serverUrl, room)
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
            }
            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { it.readText() }
                .orEmpty()

            if (code !in 200..299) return Probe.Failed(refusal(code, text))

            val json = try {
                JSONObject(text)
            } catch (t: Throwable) {
                return Probe.Failed(notClip9(endpoint))
            }
            // ⚠️ 两个键都要在：只认 `auth` 的话，一个恰好带 `auth` 字段的第三方 JSON 也算过。
            if (!json.has("server") || !json.has("auth")) return Probe.Failed(notClip9(endpoint))

            Probe.Reachable(needsPassword = json.optBoolean("auth", false))
        } catch (e: SSLException) {
            Probe.Failed(SELF_SIGNED_MESSAGE)
        } catch (e: IOException) {
            Probe.Failed("连不上 $endpoint（${e.message ?: e.javaClass.simpleName}）")
        } catch (t: Throwable) {
            Log.w(LOG_TAG, "探活时出了意料之外的错", t)
            Probe.Failed("连不上（${t.message ?: t.javaClass.simpleName}）")
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * `http://host:9501/` + `server?room=work`
     * → `http://host:9501/server?room=work`。
     *
     * ⚠️★ 房间**照传**，包括空串（`?room=`）—— 服务端那边「传了空 room」与
     * 「完全不传」是**两件事**（前者 = default 房间，后者 = 不限房间）。
     * 传空串问到的才是「我打开这个界面时要不要密码」。
     */
    private fun probeUrl(serverUrl: String, room: String): String {
        val base = serverUrl.trim().trimEnd('/')
        val query = URLEncoder.encode(room, "UTF-8")
        return "$base/$PROBE_PATH?room=$query"
    }

    /** 那一句「回的不是 clip9 的应答」。⚠️ 两处用，所以只写一份。 */
    private fun notClip9(endpoint: String): String =
        "$endpoint 回的不是 clip9 的应答（可能被反向代理或门户拦了）"

    /**
     * `http://host:9501/` + `auth/token?room=work`
     * → `http://host:9501/auth/token?room=work`。
     *
     * ⚠️ 去掉尾斜杠再拼，否则 `//auth/token` —— 多数服务端会容忍，但
     * 反代（`server.prefix` 那种部署）不一定，而症状是「网页界面能开、自动认证不行」。
     */
    private fun tokenUrl(serverUrl: String, room: String): String {
        val base = serverUrl.trim().trimEnd('/')
        val query = URLEncoder.encode(room, "UTF-8")
        return "$base/$TOKEN_PATH?room=$query"
    }

    /** 解析成功响应。 */
    private fun parse(text: String): Result {
        val json = try {
            JSONObject(text)
        } catch (t: Throwable) {
            // ⚠️ 2xx 但回的不是 JSON：多半是被反代的登录页或者门户拦了。
            // 说清楚，别让用户以为是密码错了。
            return Result.Failed("那台地址回的不是令牌（可能被反向代理或门户拦了）")
        }
        val token = json.optString("token")
        if (token.isEmpty()) return Result.Failed("服务端没有给令牌")
        return Result.Ok(token, json.optLong("expiresAt", 0L), json.optString("scope"))
    }

    /**
     * 把非 2xx 转成一句人话。
     *
     * ⚠️★ 优先用服务端自己的 `message`：那是**中文人话**，而且它知道得比我们多
     * （「密码不正确」和「密码不能为空」在这里都是 401，我们自己分不出来）。
     * 契约见 `rust/crates/server/src/error.rs`。
     */
    private fun refusal(code: Int, body: String): String {
        val message = try {
            JSONObject(body).optString("message")
        } catch (t: Throwable) {
            ""
        }
        if (message.isNotEmpty()) return message
        return "服务端拒了这次认证（HTTP $code）"
    }
}
