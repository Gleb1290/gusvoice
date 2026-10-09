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
 * Payload JSON: {type,title,body,dmId?,channelId?,serverId?,silent?}. Foreground-suppresses (#119) so an
 * open GusVoice UI on THIS phone doesn't double-notify. The tap deep-link ids ride as extras for the
 * web client to consume (#118).
 */
object PushNotifier {
  const val CHANNEL_ID = "gusvoice_messages"
  private const val TAG = "GusVoicePush"

  fun show(context: Context, message: ByteArray) {
    // Шифр WebPush (#213) — расшифровать ключом этого телефона; открытый JSON старого бэкенда — как есть.
    val encrypted = PushCrypto.looksEncrypted(message)
    val clear = if (encrypted) PushCrypto.decrypt(context, message) else message
    val payload = try {
      clear?.let { JSONObject(String(it, Charsets.UTF_8)) }
    } catch (_: Exception) {
      null
    }
    val title = payload?.optString("title").takeUnless { it.isNullOrEmpty() } ?: "GusVoice"
    // Не расшифровалось — «новое сообщение», а не байты шифра на экране.
    val body = payload?.optString("body").takeUnless { it.isNullOrEmpty() }
      ?: if (encrypted) "Новое сообщение" else String(message, Charsets.UTF_8)

    // «Беседу прочитали» (Р1, G17, сервер шлёт только приложениям с `read1`): снять уведомление беседы — и когда
    // приложение на экране тоже. Своего показа у такого пуша нет.
    if (payload?.optString("type") == "read") {
      val readKey = if (payload.has("key")) payload.optLong("key") else null
      ConversationNotifier.onRead(context, payload.optString("dmId"), readKey)
      // Тот же пуш снимает и входящий звонок беседы (`calls.unringPush`) — после сверки с сервером (G73).
      CallNotifier.onRead(context, payload.optString("dmId"))
      return
    }

    // Foreground suppression (#119): if the GusVoice UI is in front ON THIS PHONE, the in-app path
    // already shows the message — don't also post a system notification.
    if (isAppInForeground(context)) {
      Log.i(TAG, "app in foreground — suppressing push notification")
      return
    }

    val dmId = payload?.optString("dmId").orEmpty()
    val channelId = payload?.optString("channelId").orEmpty()
    val serverId = payload?.optString("serverId").orEmpty()
    // Пусто — событие у нас же, как было всегда. Заполнено — у другого инстанса, и тап обязан
    // привести туда: сервера с таким идентификатором в домашнем инстансе просто нет.
    val instanceId = payload?.optString("instanceId").orEmpty()

    ensureChannel(context)

    // Входящий звонок (G73, `calls3`): уведомление CALL со звонком, полноэкранное поверх блокировки (`CallNotifier`).
    // 🔴 Только расшифрованный: открытый JSON на топик ntfy может прислать любой, кто узнал адрес, — и поддельный
    // «звонок» встал бы полноэкранным поверх блокировки. Сервер со звонками шифрует всем устройствам с ключами (#213),
    // а приложение со звонками ключи всегда регистрирует. Открытый `call` — мимо (и не обычным уведомлением).
    if (payload != null && payload.optString("type") == "call") {
      if (!encrypted) {
        Log.w(TAG, "plaintext call push — ignored")
        return
      }
      if (CallNotifier.validCallId(payload.optString("callId")) && dmId.isNotEmpty()) CallNotifier.show(context, payload, title, body)
      return
    }

    // ЛС — уведомление беседы как у Telegram (Р1, G17): MessagingStyle, история, «Ответить», «Прочитано».
    if (payload != null && payload.optString("type") == "dm" && dmId.isNotEmpty()) {
      ConversationNotifier.onMessage(context, payload, title, body)
      return
    }

    val openIntent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (dmId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_DM, dmId)
    if (channelId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_CHANNEL, channelId)
    if (serverId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_SERVER, serverId)
    if (instanceId.isNotEmpty()) openIntent.putExtra(UnifiedPushReceiver.EXTRA_INSTANCE, instanceId)
    val pi = PendingIntent.getActivity(
      context,
      (dmId + channelId + title).hashCode(),
      openIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(R.drawable.ic_stat_mic)
      .setContentIntent(pi)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
    // «Без звука» (С3, признак сервера `conv8`, как в Telegram): уведомление ЕСТЬ, но без звука и вибрации, хотя канал
    // `gusvoice_messages` звенит (`IMPORTANCE_HIGH`). Флаг едет внутри расшифрованной нагрузки (`pushRules.withSilent`);
    // у старого бэкенда его нет — как было. `setOnlyAlertOnce` — тихое поверх уже показанного уведомления той же беседы
    // не звенит повторно. Оба метода — `androidx.core` 1.13 (приходит с appcompat 1.7.1).
    if (payload?.optBoolean("silent") == true) {
      builder.setSilent(true).setOnlyAlertOnce(true)
    }
    val notification = builder.build()

    // Collapse repeats from the same conversation; distinct DMs/channels get distinct notifications.
    val notifId = (dmId + channelId).ifEmpty { title }.hashCode()
    try {
      NotificationManagerCompat.from(context).notify(notifId, notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS not granted (API 33+) — nothing to show.
    }
  }

  fun ensureChannel(context: Context) {
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
