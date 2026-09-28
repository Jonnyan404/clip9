package com.clip9.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * 前台服务：**唯一**负责启停本机服务端的地方，同时让进程在 App 退到后台后不被回收。
 *
 * ⚠️★ 为什么必须是后台线程：`ServerBridge.start` / `stop` 都是**阻塞**的
 * （前者要建库 + 绑端口，后者要等 redb 事务收尾、上界 15 秒）。在 `onStartCommand` 里直接调
 * 就是 ANR —— 而 ANR 的表现是「点了按钮之后界面卡住几秒」，很容易被当成「服务端慢」。
 *
 * ⚠️★ 状态**不在这里镜像一份**：唯一的权威是 [ServerBridge.status]（Rust 那边持有）。
 * Go 版把 `isRunning` 抄成了 Kotlin 的静态字段，于是「服务端已经挂了、界面还显示运行中」
 * 这种事只能靠人去看日志 —— 这里不再抄第二份。
 */
class ServerService : Service() {

    private val main = Handler(Looper.getMainLooper())

    companion object {
        const val ACTION_START = "com.clip9.app.action.START"
        const val ACTION_STOP = "com.clip9.app.action.STOP"
        const val EXTRA_PORT = "port"

        /** ⚠️ 服务端监听 `0.0.0.0` = 局域网里别的设备也能连（这是本 App 的主要用途）。 */
        private const val HOST = "0.0.0.0"

        private const val CHANNEL_ID = "clip9-server"
        private const val NOTIFICATION_ID = 1
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ⚠️★ 无条件先 `startForeground`：`startForegroundService` 之后必须在 5 秒内进前台，
        // 否则 ANR。下面那些调用是阻塞的，先进前台再干活才没有那个窗口压力。
        // ⚠️ 停止那条也走这里 —— 所以它也必须能进前台（否则用 startForegroundService 起它就会崩）。
        startForeground(NOTIFICATION_ID, notification(getString(R.string.notification_starting)))

        if (intent?.action == ACTION_STOP) {
            onBackground {
                ServerBridge.stop()
                main.post { stopSelf() }
            }
            // ⚠️ 用户主动停的：别让系统再把它拉起来（那会变成「停不掉」）。
            return START_NOT_STICKY
        }

        // ⚠️★ 系统重启服务时 `intent` 是 null（START_STICKY 的正常行为）—— 那也要把服务端起起来，
        // 否则会停在「前台服务活着、服务端没了」这个最难查的状态上。
        // ⚠️ 端口从偏好里读，而不是从 intent（重启时没有 intent）。端口是**应用偏好**，
        // 不是服务端配置 —— 它必须在服务端起来之前就知道，见 [AppPrefs]。
        val port = intent?.getIntExtra(EXTRA_PORT, AppPrefs.port(this)) ?: AppPrefs.port(this)

        onBackground {
            val error = ServerBridge.start(configPath(), filesDir.absolutePath, HOST, port)
            main.post {
                if (error != null) {
                    // ⚠️★ 起失败就**别留着**「正在启动」那条常驻通知 —— 那也是谎话。
                    // 错误原文由 [ServerBridge.lastError] 留着，界面会显示它。
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                } else {
                    // 通知文案要说清「为什么要有这条通知」（ARCHITECTURE §4.1 第 2 条）。
                    val url = ServerAddress.lanUrl(port) ?: ServerAddress.loopbackUrl(port)
                    updateNotification(getString(R.string.notification_running, url))
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        // ⚠️★ 兜底：服务被系统杀掉时也要把服务端停掉。不停的话 tokio/axum 的线程还挂在这个
        // 进程里、端口还占着，而前台服务已经没了 —— 用户以为停了，再点启动就得到「端口被占用」。
        // ⚠️ 同样要放到后台线程（`nativeStop` 最长 15 秒）。进程真的在退出时这个线程可能跑不完，
        // 那也没关系：进程没了，端口自然就放开了。
        onBackground { ServerBridge.stop() }
        super.onDestroy()
    }

    /** 配置文件的位置。⚠️ 必须与传给 [ServerBridge.start] 的 `dataDir` 对得上（同一个目录）。 */
    private fun configPath(): String = File(filesDir, "config.json").absolutePath

    private fun onBackground(block: () -> Unit) {
        Thread(block, "clip9-service").start()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        // ⚠️ NotificationChannel 是 API 26 才有的（minSdk 是 24，所以必须判版本）。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            // ⚠️ IMPORTANCE_LOW：常驻通知不该响、不该震、不该弹 —— 它只是「看得见」。
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.notification_channel_desc)
        manager.createNotificationChannel(channel)
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, ServerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(R.drawable.ic_power)
            .setContentIntent(open)
            .addAction(0, getString(R.string.notification_stop), stop)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, notification(text))
    }
}
