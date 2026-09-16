package tech.gusik.gusvoice

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Builds + shows a local message notification from a wake payload — shared by BOTH push paths:
 *  - [UnifiedPushReceiver] (external distributor, e.g. the ntfy app), and
 *  - [PushDistributorService] (our EMBEDDED distributor: our own socket to the instance's ntfy).
 *
 * Payload JSON: {type,title,body,dmId?,channelId?,serverId?}. Foreground-suppresses (#119) so an
 * open GusVoice UI on THIS phone doesn't double-notify. The tap deep-link ids ride as extras for the
 * web client to consume (#118).
 */
object PushNotifier {
  const val CHANNEL_ID = "gusvoice_messages"
  private const val TAG = "GusVoicePush"

  fun show(context: Context, message: ByteArray) {
    val payload = try {
      JSONObject(String(message, Charsets.UTF_8))
    } catch (_: Exception) {
      null
    }
    val title = payload?.optString("title").takeUnless { it.isNullOrEmpty() } ?: "GusVoice"
    val body = payload?.optString("body").takeUnless { it.isNullOrEmpty() }
      ?: String(message, Charsets.UTF_8)

    // Foreground suppression (#119): if the GusVoice UI is in front ON THIS PHONE, the in-app path
    // already shows the message — don't also post a system notification.
    if (isAppInForeground(context)) {
      Log.i(TAG, "app in foreground — suppressing push notification")
      return
    }

    val dmId = payload?.optString("dmId").orEmpty()
    val channelId = payload?.optString("channelId").orEmpty()
    val serverId = payload?.optString("serverId").orEmpty()

    ensureChannel(context)

    val openIntent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (dmId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_DM, dmId)
    if (channelId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_CHANNEL, channelId)
    if (serverId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_SERVER, serverId)
    val pi = PendingIntent.getActivity(
      context,
      (dmId + channelId + title).hashCode(),
      openIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(R.drawable.ic_stat_mic)
      .setContentIntent(pi)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .build()

    // Collapse repeats from the same conversation; distinct DMs/channels get distinct notifications.
    val notifId = (dmId + channelId).ifEmpty { title }.hashCode()
    try {
      NotificationManagerCompat.from(context).notify(notifId, notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS not granted (API 33+) — nothing to show.
    }
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
      mgr.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Сообщения", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Личные сообщения и упоминания GusVoice"
        },
      )
    }
  }

  /** True when our own UI process is currently in the foreground (interactive), not merely alive. */
  private fun isAppInForeground(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
    val mine = context.packageName
    return am.runningAppProcesses?.any {
      it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND &&
        (it.processName == mine || it.pkgList?.contains(mine) == true)
    } ?: false
  }
}
