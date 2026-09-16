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
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Voice-call foreground service that keeps the LiveKit session alive while the app is backgrounded or
 * the screen is locked (#89). Without it Android — Samsung's battery management especially — suspends
 * the WebView's mic capture and the call silently drops. Started/stopped from JS via the GusVoiceNative
 * bridge (MainActivity) on voice join/leave. It captures/plays no audio itself; it only holds the
 * process in the foreground + declares the FGS types so the OS lets the WebView keep doing audio in bg:
 *   - microphone   → getUserMedia keeps RECORDING in the background (upstream — others keep hearing us).
 *   - mediaPlayback → our audio OUTPUT stays alive in the background too. The mic type alone doesn't
 *     protect playback, so aggressive OEMs (Xiaomi/MIUI/HyperOS, Oppo, Vivo) suspend background output
 *     ~40s after backgrounding: remote voices go silent while our mic keeps flowing, and it recovers on
 *     resume. Declaring mediaPlayback fixes the downstream half. (On MIUI the app ALSO needs Autostart
 *     on + battery "No restrictions" + locked in Recents — OEM power management overrides FGS types.)
 */
class VoiceForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel()
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("GusVoice")
      .setContentText("В голосовом канале")
      .setSmallIcon(R.drawable.ic_stat_mic)
      .setContentIntent(open)
      .setOngoing(true)
      .setSilent(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    // API 29+ requires the FGS type at start; it must match the manifest's foregroundServiceType.
    // microphone|mediaPlayback: keep both the bg RECORD (upstream) and the bg audio OUTPUT (downstream)
    // paths alive — see class doc for why mediaPlayback matters on Xiaomi/MIUI et al.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      startForeground(NOTIF_ID, notification, fgsType)
    } else {
      startForeground(NOTIF_ID, notification)
    }
    // Don't auto-restart with a null intent if the OS kills us — the call context is gone by then.
    return START_NOT_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
      mgr.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Голосовой канал", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Активный голосовой звонок GusVoice"
          setShowBadge(false)
        },
      )
    }
  }

  companion object {
    private const val CHANNEL_ID = "gusvoice_voice"
    private const val NOTIF_ID = 4210

    fun start(ctx: Context) {
      val intent = Intent(ctx, VoiceForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, VoiceForegroundService::class.java))
    }
  }
}
