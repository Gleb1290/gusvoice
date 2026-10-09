package tech.gusik.gusvoice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Входящий звонок 1:1 на Android (09.10, #211, G73) — как у Telegram (`VoIPService.showIncomingNotification`, код не
 * копировался): уведомление категории CALL в своём канале со звонком и вибрацией, на Android 12+ —
 * `CallStyle.forIncomingCall` (кнопки «Отклонить» / «Ответить» рисует система), полноэкранная активити
 * [IncomingCallActivity] через `fullScreenIntent`, когда экран выключен или заблокирован (разблокирован — система сама
 * показывает его всплывающим, heads-up). Android 14+ без права `USE_FULL_SCREEN_INTENT` (`canUseFullScreenIntent`) —
 * обычное всплывающее уведомление с теми же двумя кнопками, без полноэкранного.
 *
 * Нагрузка — пуш `type: "call"` сервера (`callRules.incomingCallPush`: `callId`, `dmId`, `title` = звонящий, `body` =
 * «Входящий звонок» / «Входящий видеозвонок», `avatar`, `ts`, `video`, `uid`). Снимается: тихим пушем `type: "read"`
 * той же беседы (`calls.unringPush` — ответили на любом устройстве, отклонили, отменили, не дождались) после сверки
 * `GET /api/calls/active` (тот же пуш шлёт и обычное «прочитано» беседы, а звонок при этом ещё звонит), по сроку
 * `CALL_RING_TIMEOUT_MS` (`setTimeoutAfter`), по «Ответить» / «Отклонить».
 *
 * Один звонок за раз (у Telegram тоже одна линия): текущий — в личных настройках [PREFS].
 */
object CallNotifier {
  const val CHANNEL_ID = "gusvoice_calls"
  const val EXTRA_CALL = "gv_call"
  /** «Ответить»: этот id уходит в `MainActivity.stashDeepLink` → ссылка `call:<callId>:<dmId>` для клиента. */
  const val EXTRA_ANSWER = "gv_call_answer"
  private const val TAG = "GusVoiceCall"
  private const val PREFS = "gusvoice_call"
  private const val KEY = "current"
  private const val NOTIF_TAG = "call"
  /** `CALL_RING_TIMEOUT_MS` из `packages/shared/src/calls.ts` (tdesktop `callRingTimeoutMs`). */
  private const val RING_MS = 90_000L
  /** Запас к [RING_MS] на доставку пуша и расхождение часов телефона и сервера: старше — звонок уже не звонит. */
  private const val LATE_SLACK_MS = 30_000L
  /** id звонка — `randomUUID()` сервера (`calls.ts`); иное в адрес запроса (`/api/calls/:id/…`) не подставляем. */
  private val CALL_ID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

  fun validCallId(callId: String): Boolean = CALL_ID.matches(callId)
  private val JSON = "application/json; charset=utf-8".toMediaType()
  private val http by lazy {
    OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
  }
  private val main = Handler(Looper.getMainLooper())

  /** Открытая [IncomingCallActivity] слушает: звонок `callId` перестал звонить — закрыться. */
  @Volatile var onGone: ((String) -> Unit)? = null

  data class Call(
    val callId: String,
    val dmId: String,
    val uid: String,
    val name: String,
    val status: String,
    val avatar: String,
    val video: Boolean,
    /** Звонящий: ключ цвета буквы-аватара — тот же, что у уведомления беседы (`ConversationNotifier`, `aid`). */
    val authorId: String,
    /** До какого момента (часы телефона) звонит: срок сервера считается от доставки, часы сервера не нужны. */
    val until: Long,
  )

  fun notifId(dmId: String): Int = "call:$dmId".hashCode()

  /** Пуш `type: "call"`. `title` / `body` — уже разобранные `PushNotifier.show` (с подстановкой «GusVoice»). */
  fun show(context: Context, payload: JSONObject, title: String, body: String) {
    val callId = payload.optString("callId")
    val dmId = payload.optString("dmId")
    if (!validCallId(callId) || dmId.isEmpty()) return
    // Опоздавший пуш (телефон был без сети, распространитель отдал очередь) — звонок давно не звонит: не показывать.
    // `ts` — начало звонка на сервере (`callRules.incomingCallPush`); нет поля — пуш не от сервера со звонками.
    val ts = payload.optLong("ts", 0L)
    val now = System.currentTimeMillis()
    if (ts <= 0L || now - ts > RING_MS + LATE_SLACK_MS) {
      Log.i(TAG, "call push is stale or has no ts — not ringing")
      return
    }
    val prev = current(context)
    // Повторная доставка того же звонка — не звонить второй раз.
    if (prev != null && prev.callId == callId) return
    if (prev != null) dismiss(context, prev.callId)
    val call = Call(
      callId = callId,
      dmId = dmId,
      uid = payload.optString("uid"),
      name = payload.optString("author").ifEmpty { title },
      status = body,
      avatar = payload.optString("avatar"),
      video = payload.optBoolean("video"),
      authorId = payload.optString("authorId"),
      // Срок — от начала звонка, а не от доставки; часы телефона впереди/позади — в пределах [5 с, RING_MS].
      until = (ts + RING_MS).coerceIn(now + 5_000L, now + RING_MS),
    )
    save(context, call)
    post(context, call)
    // Аватар звонящего — в фоне, как у уведомления беседы: сначала буква, по готовности тихо перерисовать.
    if (call.avatar.isNotEmpty() && ConversationNotifier.avatarFile(context, call.avatar)?.exists() == false) {
      Thread {
        if (ConversationNotifier.downloadAvatar(context, call.avatar) && current(context)?.callId == callId) post(context, call, refresh = true)
      }.start()
    }
  }

  /**
   * Тихий пуш `type: "read"` беседы `dmId`. Звонок этой беседы мог закончиться (`calls.unringPush`), а мог и звонить
   * дальше (собеседника просто прочитали на ПК), — спросить сервер; нет ответа — снять (срок всё равно близок).
   */
  fun onRead(context: Context, dmId: String) {
    val call = current(context)?.takeIf { it.dmId == dmId } ?: return
    val app = context.applicationContext
    Thread {
      val still = try {
        stillRinging(app, call)
      } catch (e: Exception) {
        Log.w(TAG, "call state check failed", e)
        false
      }
      if (!still) dismiss(app, call.callId)
    }.start()
  }

  /** Снять уведомление звонка `callId` (если оно ещё его) и закрыть экран входящего. */
  fun dismiss(context: Context, callId: String) {
    val call = current(context)
    if (call != null && call.callId == callId) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
      NotificationManagerCompat.from(context).cancel(NOTIF_TAG, notifId(call.dmId))
    }
    main.post { onGone?.invoke(callId) }
  }

  /** Текущий звонящий звонок; срок вышел — забыть. */
  fun current(context: Context): Call? {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
    return try {
      val o = JSONObject(raw)
      val c = Call(
        o.getString("callId"), o.getString("dmId"), o.optString("uid"), o.optString("name"), o.optString("status"),
        o.optString("avatar"), o.optBoolean("video"), o.optString("authorId"), o.optLong("until"),
      )
      if (c.until < System.currentTimeMillis()) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
        null
      } else c
    } catch (_: Exception) {
      null
    }
  }

  /** Аватар для экрана и уведомления: скачанный круглый или буква. */
  fun avatarBitmap(context: Context, call: Call): Bitmap {
    ConversationNotifier.avatarFile(context, call.avatar)?.takeIf { it.exists() }?.let { f ->
      BitmapFactory.decodeFile(f.path)?.let { return it }
    }
    return ConversationNotifier.letterAvatar(call.name, call.authorId.ifEmpty { call.name })
  }

  /** Отклонить без открытия интерфейса: `POST /api/calls/:id/decline` токеном получателя ([NotifAuth]). */
  fun decline(context: Context, callId: String, uid: String): Boolean {
    if (!validCallId(callId)) return false
    val auth = NotifAuth.forUser(context, uid) ?: return false
    val req = Request.Builder()
      .url("${auth.apiUrl}/api/calls/$callId/decline")
      .header("Authorization", "Bearer ${auth.token}")
      .post("{}".toRequestBody(JSON))
      .build()
    http.newCall(req).execute().use { res ->
      res.header("x-refresh-token")?.takeIf { it.isNotEmpty() }?.let { NotifAuth.updateToken(context, auth, it) }
      if (!res.isSuccessful) Log.w(TAG, "decline -> ${res.code}")
      return res.isSuccessful
    }
  }

  /** Интент «Ответить»: открыть приложение — клиент примет звонок обычным путём (`callStore.answer`). */
  fun answerIntent(context: Context, call: Call): Intent =
    Intent(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_ANSWER, call.callId)
      .putExtra(UnifiedPushReceiver.EXTRA_DM, call.dmId)

  /** Право показать полноэкранное: до Android 14 есть всегда, с 14 — `canUseFullScreenIntent` (настройки → «Полноэкранные»). */
  fun canFullScreen(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 34) return true
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return nm.canUseFullScreenIntent()
  }

  private fun stillRinging(context: Context, call: Call): Boolean {
    val auth = NotifAuth.forUser(context, call.uid) ?: return false
    val req = Request.Builder()
      .url("${auth.apiUrl}/api/calls/active")
      .header("Authorization", "Bearer ${auth.token}")
      .get()
      .build()
    http.newCall(req).execute().use { res ->
      res.header("x-refresh-token")?.takeIf { it.isNotEmpty() }?.let { NotifAuth.updateToken(context, auth, it) }
      if (!res.isSuccessful) return false
      val active = JSONObject(res.body?.string().orEmpty()).optJSONObject("call") ?: return false
      return active.optString("id") == call.callId && active.optString("phase") == "ringing"
    }
  }

  private fun post(context: Context, call: Call, refresh: Boolean = false) {
    ensureChannel(context)
    val code = call.callId.hashCode()
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val screen = Intent(context, IncomingCallActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
      .putExtra(EXTRA_CALL, call.callId)
    val screenPi = PendingIntent.getActivity(context, code, screen, flags)
    val answerPi = PendingIntent.getActivity(context, code + 1, answerIntent(context, call), flags)
    val declinePi = PendingIntent.getBroadcast(
      context,
      code + 2,
      Intent(context, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_DECLINE)
        .putExtra(EXTRA_CALL, call.callId).putExtra(ConversationNotifier.EXTRA_UID, call.uid),
      flags,
    )
    val avatar = avatarBitmap(context, call)
    val person = Person.Builder().setName(call.name.ifEmpty { "GusVoice" }).setIcon(IconCompat.createWithBitmap(avatar))
      .setImportant(true).build()
    val left = (call.until - System.currentTimeMillis()).coerceAtLeast(1_000L)
    val fullScreen = canFullScreen(context)
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_call)
      .setContentTitle(call.name)
      .setContentText(call.status)
      .setLargeIcon(avatar)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(screenPi)
      .setOngoing(true)
      .setAutoCancel(false)
      .setShowWhen(false)
      .setTimeoutAfter(left)
      .setOnlyAlertOnce(refresh)
      .addPerson(person)
    if (fullScreen) {
      // Экран выключен / заблокирован — система запускает активити; разблокирован — показывает уведомление всплывающим.
      builder.setFullScreenIntent(screenPi, true)
      // CallStyle без fullScreenIntent (и без службы переднего плана) система не принимает — только вместе.
      builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, declinePi, answerPi))
    } else {
      builder.addAction(R.drawable.ic_call_end, "Отклонить", declinePi)
      builder.addAction(R.drawable.ic_stat_call, "Ответить", answerPi)
    }
    val n = builder.build()
    // Звонит, пока не сняли (как телефонный звонок): звук канала повторяется.
    n.flags = n.flags or Notification.FLAG_INSISTENT
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_TAG, notifId(call.dmId), n)
    } catch (e: SecurityException) {
      Log.w(TAG, "no POST_NOTIFICATIONS", e)
    }
  }

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    mgr.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Звонки", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Входящие звонки GusVoice"
        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), attrs)
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 1000, 1000)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      },
    )
  }

  private fun save(context: Context, call: Call) {
    val o = JSONObject().put("callId", call.callId).put("dmId", call.dmId).put("uid", call.uid).put("name", call.name)
      .put("status", call.status).put("avatar", call.avatar).put("video", call.video).put("authorId", call.authorId).put("until", call.until)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, o.toString()).apply()
  }
}

/**
 * «Отклонить» из уведомления или с экрана входящего (09.10, G73): снять сразу, запрос — следом, интерфейс не открывается
 * (как `VoIPActionsReceiver` у Telegram). Не экспортирован: интенты шлют только наши PendingIntent и [IncomingCallActivity].
 */
class CallActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_DECLINE = "tech.gusik.gusvoice.CALL_DECLINE"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_DECLINE) return
    val callId = intent.getStringExtra(CallNotifier.EXTRA_CALL).orEmpty()
    if (callId.isEmpty()) return
    val uid = intent.getStringExtra(ConversationNotifier.EXTRA_UID).orEmpty()
    val app = context.applicationContext
    CallNotifier.dismiss(app, callId)
    val pending = goAsync()
    Thread {
      try {
        CallNotifier.decline(app, callId, uid)
      } catch (e: Exception) {
        Log.w("GusVoiceCall", "decline failed", e)
      } finally {
        pending.finish()
      }
    }.start()
  }
}
