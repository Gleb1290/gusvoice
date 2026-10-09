package tech.gusik.gusvoice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Действия уведомления беседы (07.10, #211, Р1, G17): «Ответить» из шторки, «Прочитано», смахивание.
 *
 * Как у Telegram (`WearReplyReceiver`): ответ уходит без открытия приложения, после него беседа помечается прочитанной
 * и уведомление снимается; «Прочитано» снимает уведомление сразу, запрос — следом. Ходим тем же API, что и клиент
 * (`POST /api/conv/:id/messages`, `POST /api/conv/:id/read`), с токеном инстанса получателя из [NotifAuth]. Не
 * экспортирован: интенты шлют только наши PendingIntent.
 */
class NotifActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_REPLY = "tech.gusik.gusvoice.NOTIF_REPLY"
    const val ACTION_READ = "tech.gusik.gusvoice.NOTIF_READ"
    const val ACTION_DISMISS = "tech.gusik.gusvoice.NOTIF_DISMISS"
    private const val TAG = "GusVoicePush"
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val http by lazy {
      OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    val dmId = intent.getStringExtra(ConversationNotifier.EXTRA_CONV).orEmpty()
    if (dmId.isEmpty()) return
    val uid = intent.getStringExtra(ConversationNotifier.EXTRA_UID).orEmpty()
    val app = context.applicationContext
    when (intent.action) {
      ACTION_DISMISS -> ConversationNotifier.clear(app, dmId)
      ACTION_READ -> {
        val key = ConversationNotifier.lastKey(app, dmId)
        ConversationNotifier.clear(app, dmId)
        if (key < 0) return
        val pending = goAsync()
        Thread {
          try {
            markRead(app, uid, dmId, key)
          } catch (e: Exception) {
            Log.w(TAG, "notif read failed", e)
          } finally {
            pending.finish()
          }
        }.start()
      }
      ACTION_REPLY -> {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(ConversationNotifier.KEY_REPLY)
          ?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        val key = ConversationNotifier.lastKey(app, dmId)
        val pending = goAsync()
        Thread {
          try {
            reply(app, uid, dmId, text, key)
          } finally {
            pending.finish()
          }
        }.start()
      }
    }
  }

  private fun reply(context: Context, uid: String, dmId: String, text: String, lastKey: Long) {
    val auth = NotifAuth.forUser(context, uid)
    if (auth == null) {
      ConversationNotifier.onReplyFailed(context, dmId, text, "Не отправлено — войдите в приложение")
      return
    }
    val body = JSONObject().put("clientId", UUID.randomUUID().toString()).put("content", text).put("attachments", JSONArray())
    try {
      val sent = call(context, auth, "/conv/$dmId/messages", body)
      if (sent == null) {
        ConversationNotifier.onReplyFailed(context, dmId, text, "Не отправлено")
        return
      }
      // Как Telegram после ответа: беседа прочитана до своего сообщения, уведомление снимается.
      val key = sent.optLong("sortKey", lastKey)
      ConversationNotifier.clear(context, dmId)
      if (key >= 0) markRead(context, uid, dmId, key)
    } catch (e: Exception) {
      Log.w(TAG, "notif reply failed", e)
      ConversationNotifier.onReplyFailed(context, dmId, text, "Не отправлено — нет связи")
    }
  }

  private fun markRead(context: Context, uid: String, dmId: String, key: Long) {
    val auth = NotifAuth.forUser(context, uid) ?: return
    call(context, auth, "/conv/$dmId/read", JSONObject().put("key", key))
  }

  /** POST к API инстанса; ответ 2xx — тело JSON (или пустой объект), иначе `null`. Свежий токен — запоминаем. */
  private fun call(context: Context, auth: NotifAuth.Entry, path: String, body: JSONObject): JSONObject? {
    val req = Request.Builder()
      .url("${auth.apiUrl}/api$path")
      .header("Authorization", "Bearer ${auth.token}")
      .post(body.toString().toRequestBody(JSON))
      .build()
    http.newCall(req).execute().use { res ->
      res.header("x-refresh-token")?.takeIf { it.isNotEmpty() }?.let { NotifAuth.updateToken(context, auth, it) }
      if (!res.isSuccessful) {
        Log.w(TAG, "notif action $path -> ${res.code}")
        return null
      }
      val raw = res.body?.string().orEmpty()
      return try {
        if (raw.isBlank()) JSONObject() else JSONObject(raw)
      } catch (_: Exception) {
        JSONObject()
      }
    }
  }
}
