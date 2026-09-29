package com.clip9.app

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 远端服务器密码的**落盘形态**：加密 + base64。
 *
 * ⚠️★ 明文密码**不许**进 `SharedPreferences`。那个文件就在
 * `data/data/com.clip9.app/shared_prefs/`，`adb backup`（没关 `allowBackup` 的话）、
 * root 过的机器、以及不少「手机管家」类工具都能直接读出来。
 * 而这里存的是**用户那台服务端的密码** —— 泄漏的后果是别人可以直接进他的看板。
 *
 * ⚠️★ 用 Android Keystore，而不是自己 `SecureRandom` 生成一把密钥再存进偏好里：
 * 那样等于把钥匙和锁放进同一个抽屉。Keystore 里的密钥**不出应用沙箱**
 * （有 TEE / StrongBox 的机器上连应用沙箱都不出），而且**不跟着备份走**。
 *
 * ⚠️★ 代价要在界面上说清：**换机、恢复出厂、清应用数据之后这些密码就解不开了**。
 * 这不是 bug —— 正是「不跟着备份走」的意思。所以文案是「密码不会跟着备份走」，
 * 而不是「密码会被安全地备份」。
 *
 * ⚠️ 它**只管加解密**，不管存哪儿 —— 存法在 [RemoteServers]。
 */
object SecretBox {

    private const val LOG_TAG = "clip9-secret"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "clip9-remote-server"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    /** GCM 的 IV 长度（字节）。12 是规范与所有实现都推荐的值。 */
    private const val IV_BYTES = 12

    /** GCM 认证标签长度（位）。 */
    private const val TAG_BITS = 128

    /**
     * 加密。返回 base64（`iv ‖ 密文`）；失败返回 `null`。
     *
     * ⚠️ **失败不抛异常**：极少数 ROM 上 Keystore 不可用，那不该让整个配置页崩掉。
     * 调用方的处理是「这一项就不记住了」，而且**要在界面上说出来**
     * —— 闷声不存的结果是用户以为存了、下次还要重输。
     *
     * ⚠️ 空串原样返回空串（= 没存密码），不走加解密：给「没设密码」这件事
     * 留一个**不需要密钥**的表达，免得 Keystore 坏了就分不清「没密码」和「解不开」。
     */
    fun seal(plain: String): String? {
        if (plain.isEmpty()) return ""
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            // ⚠️ IV 必须**每次新生成**（`init(ENCRYPT_MODE)` 已经做了这件事），
            // 而且要和密文一起存 —— GCM 复用 IV 会直接毁掉它的安全性。
            val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.encodeToString(sealed, Base64.NO_WRAP)
        } catch (t: Throwable) {
            Log.w(LOG_TAG, "加密失败（这一项不会被记住）", t)
            null
        }
    }

    /**
     * 解密。解不开（换了设备 / 应用数据被清了 / 密文被改过）返回 `null`。
     *
     * ⚠️★ **解不开是一种正常结果，不是错误。** 设备换了、Keystore 里的钥匙被系统丢了、
     * 数据被别的版本写过 —— 这些都会让密文变成一段读不懂的字节。
     * 那时候正确的做法是「当作没存过密码」（让用户重填一次），
     * 而不是让界面崩、或者把乱码当密码发出去。
     */
    fun open(sealed: String): String? {
        if (sealed.isEmpty()) return ""
        return try {
            val raw = Base64.decode(sealed, Base64.NO_WRAP)
            // ⚠️ 比 IV 还短的密文不可能是我们写出来的 —— 直接判失败，别让
            // `GCMParameterSpec` 拿到一个越界的偏移。
            if (raw.size <= IV_BYTES) return null
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES))
            String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
        } catch (t: Throwable) {
            Log.w(LOG_TAG, "解密失败（按「没存过密码」处理）", t)
            null
        }
    }

    /**
     * 取（或首次生成）那一把对称密钥。
     *
     * ⚠️ `@Synchronized`：`KeyGenerator.generateKey()` 撞在一起会抛
     * `KeyStoreException`（同一个别名被同时创建），而调用点分散在配置页与打开界面那两条路上。
     */
    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // ⚠️★ 刻意**不**开 `setUserAuthenticationRequired(true)`：
                // 开了之后「打开网页界面前自动换令牌」会在**锁屏状态下**直接失败
                // （那时候没有人能按指纹），而那正是这个功能最常用的时刻之一。
                // 安全性由「密钥不出沙箱 + 不跟备份走」保证，不靠每次解锁。
                .build(),
        )
        return generator.generateKey()
    }
}
