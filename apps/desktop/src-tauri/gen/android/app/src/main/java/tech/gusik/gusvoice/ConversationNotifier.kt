package tech.gusik.gusvoice

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Shader
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Уведомление беседы ЛС как у Telegram (07.10, #211, Р1, G17).
 *
 * Источник поведения — Telegram Android `NotificationsController.showExtraNotifications` (MessagingStyle с Person
 * собеседника и его аватаром, несколько последних сообщений в одном уведомлении, у группы — название беседы заголовком,
 * действия «Ответить» (RemoteInput, SEMANTIC_ACTION_REPLY) и «Пометить прочитанным» (SEMANTIC_ACTION_MARK_AS_READ),
 * снятие уведомления, когда беседу прочитали на другом устройстве) и `WearReplyReceiver` (после ответа — «прочитано»).
 * Код Telegram не копировался; здесь своя реализация на androidx.core.
 *
 * История последних сообщений живёт в личных настройках `gusvoice_notif_hist` (по беседе, до [MAX_ITEMS]) — пуши
 * приходят по одному, а MessagingStyle перерисовывается целиком. Чистится при «прочитано» (пуш `read`, действие,
 * ответ), смахивании и тапе по уведомлению. Действия обрабатывает [NotifActionReceiver]; чем ходить на сервер —
 * [NotifAuth] (адрес и токен инстанса получателя, их передаёт клиент через мост `setNotifAuth`).
 */
object ConversationNotifier {
  private const val TAG = "GusVoicePush"
  private const val PREFS = "gusvoice_notif_hist"
  private const val MAX_ITEMS = 7
  const val KEY_REPLY = "gv_reply_text"
  const val EXTRA_CONV = "gv_conv"
  const val EXTRA_UID = "gv_uid"

  /** Заголовок и тело безличного пуша — те же, что у сервера (`packages/shared/src/notifyView.ts`). */
  private const val HIDDEN_TITLE = "GusVoice"
  private const val HIDDEN_BODY = "Новое сообщение"

  /** Тот же номер, что и у прежнего уведомления беседы (`PushNotifier`: `(dmId + channelId).hashCode()`). */
  fun notifId(dmId: String): Int = dmId.hashCode()

  /** Новое сообщение беседы из пуша (`type: "dm"`). `payload` — расшифрованная нагрузка. */
  fun onMessage(context: Context, payload: JSONObject, title: String, body: String) {
    val dmId = payload.optString("dmId")
    // «Показывать имя» выключено: сервер убирает автора и аватар, заголовок — «GusVoice» (`pushRules.maskPushPayload`).
    // Автор пуша обязан быть непустым у любого сервера с этой настройкой; у старого без поля заголовок — имя, не «GusVoice».
    val hidden = payload.optString("author").isEmpty() && title == HIDDEN_TITLE
    // «Показывать текст» выключено: тело — безличная строка; прежние строки с текстами в истории не оставляем.
    val textHidden = body == HIDDEN_BODY
    val author = payload.optString("author").ifEmpty { title }
    val item = JSONObject()
      .put("t", body)
      .put("ts", payload.optLong("ts").takeIf { it > 0 } ?: System.currentTimeMillis())
      .put("k", payload.optLong("key", -1L))
    if (hidden) {
      item.put("hid", true)
    } else {
      item.put("a", author).put("aid", payload.optString("authorId")).put("av", payload.optString("avatar"))
    }
    val conv = load(context, dmId)
    // Безличный пуш заменяет уведомление целиком: прежние имена и тексты не показываем (у Telegram скрытое уведомление —
    // без имени и аватара собеседника). Обычный пуш после безличного — наоборот, безличные строки отбрасываются.
    val items = JSONArray()
    val old = conv.optJSONArray("items") ?: JSONArray()
    for (i in 0 until old.length()) {
      val o = old.optJSONObject(i) ?: continue
      val keep = if (hidden) o.optBoolean("hid") else !o.optBoolean("hid") && (!textHidden || o.optString("t") == HIDDEN_BODY)
      if (keep) items.put(o)
    }
    conv.put("hidden", hidden)
    // Тот же id сообщения второй раз (повтор доставки пуша) — не дублировать.
    val mid = payload.optString("mid")
    if (mid.isNotEmpty()) {
      item.put("mid", mid)
      for (i in 0 until items.length()) if (items.optJSONObject(i)?.optString("mid") == mid) {
        // Повтор «Повторять уведомления» (D10, сервер ставит `repeat`): то же сообщение ещё раз, но не дубль доставки —
        // как Telegram (`repeatNotificationMaybe`: cancel + showOrUpdateNotification со звуком) снять уведомление беседы и
        // показать заново со звуком. Строка в историю не добавляется. Раньше повтор отбрасывался здесь молча.
        if (payload.optInt("repeat", 0) > 0 && !payload.optBoolean("silent")) {
          NotificationManagerCompat.from(context).cancel(notifId(dmId))
          post(context, dmId, load(context, dmId), silent = false, alertOnce = false)
        }
        return
      }
    }
    items.put(item)
    conv.put("items", trim(items))
    if (payload.has("group")) conv.put("group", payload.optString("group")) else conv.remove("group")
    payload.optString("uid").takeIf { it.isNotEmpty() }?.let { conv.put("uid", it) }
    conv.put("instanceId", payload.optString("instanceId"))
    save(context, dmId, conv)
    post(context, dmId, conv, silent = payload.optBoolean("silent"), alertOnce = false)
    // Аватар автора — в фоне: уведомление уже показано с буквой, по готовности перерисуется тихо.
    val av = item.optString("av")
    if (av.isNotEmpty() && avatarFile(context, av)?.exists() == false) {
      Thread {
        if (downloadAvatar(context, av) && load(context, dmId).has("items")) {
          post(context, dmId, load(context, dmId), silent = true, alertOnce = true)
        }
      }.start()
    }
  }

  /** Беседу прочитали (на этом или другом устройстве): снять уведомление; `key` — до какого сообщения включительно. */
  fun onRead(context: Context, dmId: String, key: Long?) {
    if (dmId.isEmpty()) return
    val conv = load(context, dmId)
    val items = conv.optJSONArray("items")
    if (key == null || items == null) return clear(context, dmId)
    val left = JSONArray()
    for (i in 0 until items.length()) {
      val it = items.optJSONObject(i) ?: continue
      val k = it.optLong("k", -1L)
      // Без ключа (старый сервер) или новее прочитанного — остаётся.
      if (k < 0 || k > key) if (!it.optBoolean("me")) left.put(it)
    }
    if (left.length() == 0) return clear(context, dmId)
    conv.put("items", left)
    save(context, dmId, conv)
    post(context, dmId, conv, silent = true, alertOnce = true)
  }

  /** Снять уведомление беседы и забыть её историю. */
  fun clear(context: Context, dmId: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(dmId).apply()
    // Ярлык беседы не удаляем: он долгоживущий (раздел «Беседы», приоритет беседы в настройках Android).
    NotificationManagerCompat.from(context).cancel(notifId(dmId))
  }

  /** Ответ не ушёл: строка «не отправлено» в истории, уведомление остаётся (без звука). */
  fun onReplyFailed(context: Context, dmId: String, text: String, reason: String) {
    val conv = load(context, dmId)
    val items = conv.optJSONArray("items") ?: JSONArray()
    items.put(JSONObject().put("me", true).put("t", "$reason: $text").put("ts", System.currentTimeMillis()))
    conv.put("items", trim(items))
    save(context, dmId, conv)
    post(context, dmId, conv, silent = true, alertOnce = true)
  }

  /** Наибольший ключ сообщения в истории беседы (для «Пометить прочитанным»), -1 — неизвестен. */
  fun lastKey(context: Context, dmId: String): Long {
    val items = load(context, dmId).optJSONArray("items") ?: return -1L
    var max = -1L
    for (i in 0 until items.length()) max = maxOf(max, items.optJSONObject(i)?.optLong("k", -1L) ?: -1L)
    return max
  }

  fun uidOf(context: Context, dmId: String): String = load(context, dmId).optString("uid")

  private fun post(context: Context, dmId: String, conv: JSONObject, silent: Boolean, alertOnce: Boolean) {
    val items = conv.optJSONArray("items") ?: return
    if (items.length() == 0) return
    PushNotifier.ensureChannel(context)
    val hidden = conv.optBoolean("hidden")
    val group = conv.optString("group").takeIf { conv.has("group") && !hidden }
    val self = Person.Builder().setName("Вы").setKey("self").build()
    val style = NotificationCompat.MessagingStyle(self)
    if (group != null) {
      style.setConversationTitle(group.ifEmpty { "Группа" })
      style.setGroupConversation(true)
    }
    val avatars = HashMap<String, IconCompat>()
    var lastAuthor = ""
    var lastIcon: IconCompat? = null
    var count = 0
    for (i in 0 until items.length()) {
      val it = items.optJSONObject(i) ?: continue
      val ts = it.optLong("ts", System.currentTimeMillis())
      if (hidden) {
        count++
        continue
      }
      if (it.optBoolean("me")) {
        style.addMessage(NotificationCompat.MessagingStyle.Message(it.optString("t"), ts, null as Person?))
        continue
      }
      count++
      val name = it.optString("a").ifEmpty { "GusVoice" }
      lastAuthor = name
      val key = it.optString("aid").ifEmpty { name }
      val icon = avatars.getOrPut(key) { avatarIcon(context, it.optString("av"), name, key) }
      lastIcon = icon
      val person = Person.Builder().setName(name).setKey(key).setIcon(icon).build()
      style.addMessage(NotificationCompat.MessagingStyle.Message(it.optString("t"), ts, person))
    }

    val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(UnifiedPushReceiver.EXTRA_DM, dmId)
    conv.optString("instanceId").takeIf { it.isNotEmpty() }?.let { open.putExtra(UnifiedPushReceiver.EXTRA_INSTANCE, it) }
    val id = notifId(dmId)
    val openPi = PendingIntent.getActivity(
      context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val builder = NotificationCompat.Builder(context, PushNotifier.CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_mic)
      .setContentTitle(if (hidden) HIDDEN_TITLE else group ?: lastAuthor)
      .setContentText(items.optJSONObject(items.length() - 1)?.optString("t").orEmpty())
      .setContentIntent(openPi)
      .setDeleteIntent(actionPi(context, NotifActionReceiver.ACTION_DISMISS, dmId, conv, id + 3, mutable = false))
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setNumber(count)
      .setOnlyAlertOnce(alertOnce)
    if (silent) builder.setSilent(true).setOnlyAlertOnce(true)

    // Раздел «Беседы» шторки (Android 11+) и аватар собеседника крупно — только у уведомления с долгоживущим ярлыком
    // беседы (как у Telegram: `NotificationsController` публикует ярлык диалога). Ярлык ведёт в ту же беседу.
    // Безличное уведомление — без ярлыка и MessagingStyle: иначе Android кладёт его в «Беседы» с именем и аватаром собеседника.
    if (!hidden) builder.setStyle(style)
    if (!hidden) try {
      val shortcutId = "dm_$dmId"
      val label = (group ?: lastAuthor).ifEmpty { "GusVoice" }
      val shortcut = ShortcutInfoCompat.Builder(context, shortcutId)
        .setShortLabel(label)
        .setLongLived(true)
        .setIntent(Intent(open).setAction(Intent.ACTION_VIEW))
        .apply { (if (group == null) lastIcon else null)?.let { setIcon(it) } }
        .build()
      ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
      builder.setShortcutId(shortcutId)
    } catch (e: Exception) {
      Log.w(TAG, "conversation shortcut failed", e)
    }

    // Действия — только если есть, чем ходить на сервер (вход в инстанс получателя есть в приложении). У безличного
    // уведомления «Ответить» нет (как у Telegram: скрытое уведомление `canReply = false`), «Прочитано» остаётся.
    if (NotifAuth.forUser(context, conv.optString("uid")) != null) {
      if (!hidden) {
        val remote = RemoteInput.Builder(KEY_REPLY).setLabel("Сообщение").build()
        builder.addAction(
          NotificationCompat.Action.Builder(
            R.drawable.ic_stat_mic, "Ответить",
            actionPi(context, NotifActionReceiver.ACTION_REPLY, dmId, conv, id + 1, mutable = true),
          )
            .addRemoteInput(remote)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build(),
        )
      }
      if (lastKey(context, dmId) >= 0) {
        builder.addAction(
          NotificationCompat.Action.Builder(
            R.drawable.ic_stat_mic, "Прочитано",
            actionPi(context, NotifActionReceiver.ACTION_READ, dmId, conv, id + 2, mutable = false),
          )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build(),
        )
      }
    }
    try {
      NotificationManagerCompat.from(context).notify(id, builder.build())
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS не выдано (API 33+) — показывать нечего.
    }
  }

  private fun actionPi(context: Context, action: String, dmId: String, conv: JSONObject, code: Int, mutable: Boolean): PendingIntent {
    val i = Intent(context, NotifActionReceiver::class.java).setAction(action)
      .putExtra(EXTRA_CONV, dmId)
      .putExtra(EXTRA_UID, conv.optString("uid"))
    // RemoteInput дописывает текст в интент — ему нужен изменяемый PendingIntent (Android 12+).
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (mutable && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE
      else PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getBroadcast(context, code, i, flags)
  }

  private fun load(context: Context, dmId: String): JSONObject = try {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(dmId, null)?.let { JSONObject(it) } ?: JSONObject()
  } catch (_: Exception) {
    JSONObject()
  }

  private fun save(context: Context, dmId: String, conv: JSONObject) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(dmId, conv.toString()).apply()
  }

  private fun trim(items: JSONArray): JSONArray {
    if (items.length() <= MAX_ITEMS) return items
    val out = JSONArray()
    for (i in items.length() - MAX_ITEMS until items.length()) out.put(items.get(i))
    return out
  }

  // ---- Аватары: круг из скачанной картинки или буква на цветном круге (как заглушка у Telegram) ----

  private val http by lazy {
    OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).build()
  }

  internal fun avatarFile(context: Context, url: String): File? {
    if (!url.startsWith("http://") && !url.startsWith("https://")) return null
    return File(File(context.cacheDir, "notif-avatars"), "${url.hashCode().toUInt()}.png")
  }

  internal fun downloadAvatar(context: Context, url: String): Boolean {
    val file = avatarFile(context, url) ?: return false
    return try {
      http.newCall(Request.Builder().url(url).build()).execute().use { res ->
        if (!res.isSuccessful) return false
        val bytes = res.body?.bytes() ?: return false
        if (bytes.size > 5 * 1024 * 1024) return false
        val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return false
        val circle = circleCrop(src, 128)
        file.parentFile?.mkdirs()
        file.outputStream().use { circle.compress(Bitmap.CompressFormat.PNG, 100, it) }
        true
      }
    } catch (e: Exception) {
      Log.w(TAG, "avatar download failed", e)
      false
    }
  }

  private fun avatarIcon(context: Context, url: String, name: String, key: String): IconCompat {
    avatarFile(context, url)?.takeIf { it.exists() }?.let { f ->
      BitmapFactory.decodeFile(f.path)?.let { return IconCompat.createWithBitmap(it) }
    }
    return IconCompat.createWithBitmap(letterAvatar(name, key))
  }

  private fun circleCrop(src: Bitmap, size: Int): Bitmap {
    val side = minOf(src.width, src.height)
    val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
    val scaled = Bitmap.createScaledBitmap(square, size, size, true)
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
    Canvas(out).drawCircle(size / 2f, size / 2f, size / 2f, paint)
    return out
  }

  private val LETTER_COLORS = intArrayOf(
    0xFFE17076.toInt(), 0xFFFAA774.toInt(), 0xFFA695E7.toInt(), 0xFF7BC862.toInt(),
    0xFF6EC9CB.toInt(), 0xFF65AADD.toInt(), 0xFFEE7AAE.toInt(),
  )

  internal fun letterAvatar(name: String, key: String): Bitmap {
    val size = 128
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = LETTER_COLORS[Math.floorMod(key.hashCode(), LETTER_COLORS.size)] }
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, bg)
    val letter = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = size * 0.45f
      textAlign = Paint.Align.CENTER
      isFakeBoldText = true
    }
    val y = size / 2f - (text.descent() + text.ascent()) / 2f
    canvas.drawText(letter, size / 2f, y, text)
    return out
  }
}
