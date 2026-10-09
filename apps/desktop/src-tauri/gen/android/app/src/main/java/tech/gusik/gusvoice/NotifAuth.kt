package tech.gusik.gusvoice

import android.content.Context
import org.json.JSONArray

/**
 * Чем ходить на сервер из шторки (07.10, #211, Р1, G17): адрес API и токен каждого инстанса со входом. Клиент
 * передаёт список через мост `setNotifAuth` (`nativeUnifiedPush.syncNotifAuth`) при старте, входе, возврате и выходе;
 * токен тот же, что лежит в localStorage WebView этого же приложения. Хранится в личных настройках
 * `gusvoice_notif_auth` (не в Keystore — как и ключи пуша, `PushCrypto`). Пуш несёт `uid` получателя — по нему
 * выбирается запись; нет `uid` (старый сервер) — активный инстанс.
 */
object NotifAuth {
  private const val PREFS = "gusvoice_notif_auth"
  private const val KEY = "entries"

  data class Entry(val apiUrl: String, val token: String, val userId: String, val active: Boolean)

  /** Признаки приложения для `/api/push/register` (`caps`). */
  const val CAPS_JSON = "[\"read1\",\"reply1\"]"

  fun set(context: Context, json: String) {
    // Проверка формы, чтобы мусор с моста не лёг в настройки.
    val parsed = parse(json)
    val clean = JSONArray()
    for (e in parsed) {
      clean.put(
        org.json.JSONObject().put("apiUrl", e.apiUrl).put("token", e.token).put("userId", e.userId).put("active", e.active),
      )
    }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, clean.toString()).apply()
  }

  fun forUser(context: Context, uid: String): Entry? {
    val all = parse(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return null)
    if (uid.isNotEmpty()) all.firstOrNull { it.userId == uid }?.let { return it }
    return all.firstOrNull { it.active } ?: all.singleOrNull()
  }

  /** Адреса API всех инстансов со входом — белый список ссылок «Скачать» для `LegacyDownloads` (09.10). */
  fun apiUrls(context: Context): List<String> {
    val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return emptyList()
    return parse(json).map { it.apiUrl }
  }

  /** Сервер продлил сессию (`x-refresh-token`) — запомнить свежий токен этой записи. */
  fun updateToken(context: Context, entry: Entry, token: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val arr = try {
      JSONArray(prefs.getString(KEY, "[]"))
    } catch (_: Exception) {
      return
    }
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      if (o.optString("apiUrl") == entry.apiUrl && o.optString("userId") == entry.userId) o.put("token", token)
    }
    prefs.edit().putString(KEY, arr.toString()).apply()
  }

  private fun parse(json: String): List<Entry> = try {
    val arr = JSONArray(json)
    (0 until arr.length()).mapNotNull { i ->
      val o = arr.optJSONObject(i) ?: return@mapNotNull null
      val api = o.optString("apiUrl").trimEnd('/')
      val token = o.optString("token")
      if (!(api.startsWith("https://") || api.startsWith("http://")) || token.isEmpty()) null
      else Entry(api, token, o.optString("userId"), o.optBoolean("active"))
    }
  } catch (_: Exception) {
    emptyList()
  }
}
