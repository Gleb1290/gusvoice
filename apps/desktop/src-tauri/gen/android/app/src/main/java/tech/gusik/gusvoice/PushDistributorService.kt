package tech.gusik.gusvoice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * EMBEDDED UnifiedPush distributor. Instead of requiring a SEPARATE distributor app (the ntfy app),
 * GusVoice holds its OWN persistent WebSocket to the instance's ntfy — address learned from the
 * server's /config.json discovery (`pushGateway`) and handed in via the JS bridge. So one prebuilt
 * client wakes on DMs/@mentions with zero extra apps and no manual server entry.
 *
 * Wire-up: subscribes to `wss://<ntfyBase>/<topic>/ws`; the backend publishes wake payloads to
 * `https://<ntfyBase>/<topic>` (that URL is the endpoint the client registers with the backend). The
 * ntfy topic must be anon-readable (ntfy's default). Reconnects with capped exponential backoff.
 *
 * COST (inherent to embedding): a persistent low-priority foreground notification + a kept-alive
 * socket (battery). This is the same thing the ntfy app does — we just do it in-process so the user
 * installs nothing extra. Scope: Android only (desktop stays connected via its gateway WS while open).
 */
class PushDistributorService : Service() {
  private var ws: WebSocket? = null
  private var client: OkHttpClient? = null
  private var closed = false
  private var backoffMs = 1_000L
  private val main = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val ntfyBase = prefs().getString(KEY_NTFY_BASE, "").orEmpty()
    val topic = prefs().getString(KEY_TOPIC, "").orEmpty()
    if (ntfyBase.isEmpty() || topic.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      startForegroundNotice()
    } catch (e: Exception) {
      // Android 12+: when the system restarts this STICKY service while the app is
      // background-restricted (battery saver / OEM policies), startForeground() throws
      // ForegroundServiceStartNotAllowedException. Uncaught, that crash-loops the app in the
      // BACKGROUND — repeated system "GusVoice произошел сбой" dialogs with the app untouched.
      // Give up quietly instead; push resumes on the next app open / device boot.
      Log.w(TAG, "startForeground denied (${e.javaClass.simpleName}: ${e.message}) — stopping quietly")
      stopSelf()
      return START_NOT_STICKY
    }
    connect(ntfyBase, topic)
    // STICKY: if the OS kills us, restart to keep receiving pushes (that's the whole point). The
    // prefs still hold ntfyBase+topic, so a null-intent restart reconnects fine.
    return START_STICKY
  }

  private fun connect(ntfyBase: String, topic: String) {
    if (closed) return
    // https://host -> wss://host ; http://host -> ws://host
    val wsUrl = ntfyBase.replaceFirst("http", "ws").trimEnd('/') + "/" + topic + "/ws"
    val c = client ?: OkHttpClient.Builder()
      .pingInterval(45, TimeUnit.SECONDS) // keepalive through NAT / doze idle
      .retryOnConnectionFailure(true)
      .build()
      .also { client = it }
    Log.i(TAG, "connecting embedded push ws")
    ws = c.newWebSocket(
      Request.Builder().url(wsUrl).build(),
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          backoffMs = 1_000L
          Log.i(TAG, "embedded push ws open")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          handleFrame(text)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          Log.w(TAG, "embedded push ws failure: ${t.message}")
          scheduleReconnect(ntfyBase, topic)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          scheduleReconnect(ntfyBase, topic)
        }
      },
    )
  }

  private fun handleFrame(text: String) {
    // ntfy WS envelope: {id,time,event,topic,message,...}. Only "message" events carry a publish;
    // other events (open/keepalive) are ignored. Our backend publishes the wake JSON as the body.
    val env = try {
      JSONObject(text)
    } catch (_: Exception) {
      return
    }
    if (env.optString("event") != "message") return
    val body = env.optString("message")
    if (body.isEmpty()) return
    PushNotifier.show(this, body.toByteArray(Charsets.UTF_8))
  }

  private fun scheduleReconnect(ntfyBase: String, topic: String) {
    if (closed) return
    val delay = backoffMs
    backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
    main.postDelayed({ connect(ntfyBase, topic) }, delay)
  }

  private fun startForegroundNotice() {
    ensureChannel()
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("GusVoice")
      .setContentText("Уведомления включены")
      .setSmallIcon(R.drawable.ic_stat_mic)
      .setContentIntent(open)
      .setOngoing(true)
      .setSilent(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .build()
    // API 29+ requires the FGS type at start; it must match the manifest's foregroundServiceType.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, n)
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
      mgr.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Фоновые уведомления", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Держит связь для доставки уведомлений, когда приложение закрыто"
          setShowBadge(false)
        },
      )
    }
  }

  override fun onDestroy() {
    closed = true
    main.removeCallbacksAndMessages(null)
    ws?.close(1000, null)
    ws = null
    super.onDestroy()
  }

  private fun prefs() = getSharedPreferences(UnifiedPushReceiver.PREFS, Context.MODE_PRIVATE)

  companion object {
    private const val CHANNEL_ID = "gusvoice_push_bg"
    private const val NOTIF_ID = 4211
    private const val TAG = "GusVoicePush"
    const val KEY_NTFY_BASE = "emb_ntfy_base"
    const val KEY_TOPIC = "emb_topic"

    fun start(ctx: Context) {
      val i = Intent(ctx, PushDistributorService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, PushDistributorService::class.java))
    }
  }
}
