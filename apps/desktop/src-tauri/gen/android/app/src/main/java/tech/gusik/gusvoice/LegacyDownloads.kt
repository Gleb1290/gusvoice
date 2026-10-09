package tech.gusik.gusvoice

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.MimeTypeMap
import android.widget.Toast
import java.util.concurrent.ConcurrentHashMap

/**
 * Файлы из ленты на старом WebView (приёмка S20+ 09.10, WebView 111): без `WEB_MESSAGE_ARRAY_BUFFER` (WebView < 119) объекта
 * `GusVoiceMedia` нет (`MediaBridge.bridgeSupported`), и «Сохранить» / «Открыть» файла, «⬇» и «Сохранить» просмотра молчали —
 * страница качала байты сама и отдавала их `<a download>` по `blob:`, а у WebView приложения загрузок нет. Здесь — системный
 * `DownloadManager`: клиент зовёт строковый мост `GusVoiceNative.downloadFile(json)` (`MainActivity.NativeBridge`), файл ложится
 * в «Загрузки/GusVoice», ход виден в шторке; «Открыть» — после загрузки ACTION_VIEW по `content://` самого DownloadManager.
 *
 * 🔴 Безопасность: качаем ТОЛЬКО ссылки «Скачать» своих инстансов — адрес API из списка входов (`NotifAuth`, его ведёт клиент
 * `syncNotifAuth`) + ровно две формы пути: `/api/att/<id>/<смотрящий>/<подпись>` (закрытый файл ЛС, подпись в пути) и
 * `/api/download/attachment?key=attachments/…` (публичный). Обе — без заголовка входа: токен в загрузку не уходит вовсе. Адрес и
 * его части в журнал не пишутся (подпись = доступ к файлу). Имя файла — очищенное (`safeName`), без каталогов.
 */
object LegacyDownloads {
  private const val TAG = "GusVoiceDl"
  private const val SUBDIR = "GusVoice"
  // Формы частей — как у бэкенда (`attachmentRules.attPartsWellFormed`): id — UUID, смотрящий, подпись 32 знака.
  private val ATT_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  private val VIEWER = Regex("^[A-Za-z0-9-]{1,64}$")
  private val SIG = Regex("^[A-Za-z0-9_-]{32}$")
  private val KEY = Regex("^attachments/[A-Za-z0-9._-]{1,200}$")
  private val MIME = Regex("^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,127}$")

  /** id загрузки → тип: открыть по готовности («Открыть» карточки). Только свои — чужое «готово» игнорируется. */
  private val toOpen = ConcurrentHashMap<Long, String>()
  @Volatile private var receiverOn = false

  /**
   * Своя ли это ссылка «Скачать» (см. шапку). `bases` — адреса API инстансов со входом (`https://api.…`, без `/` в конце).
   * Чистая функция: проверяется строкой, без разбора `Uri` — его снисходительность (`\`, `@` в адресе) здесь только мешает.
   */
  fun allowedUrl(url: String, bases: Collection<String>): Boolean {
    if (url.length > 4096 || url.any { it.code < 0x21 || it.code > 0x7e || it == '\\' || it == '#' }) return false
    for (raw in bases) {
      val base = raw.trimEnd('/')
      if (!(base.startsWith("https://") || base.startsWith("http://"))) continue
      val authority = base.substringAfter("://").substringBefore('/')
      if (authority.isEmpty() || authority.contains('@')) continue
      val att = "$base/api/att/"
      if (url.startsWith(att)) {
        val parts = url.substring(att.length).split('/')
        return parts.size == 3 && ATT_ID.matches(parts[0]) && VIEWER.matches(parts[1]) && SIG.matches(parts[2])
      }
      val pub = "$base/api/download/attachment?"
      if (url.startsWith(pub)) {
        val q = url.substring(pub.length).split('&')
        var key: String? = null
        for (p in q) {
          val k = p.substringBefore('=')
          val v = Uri.decode(p.substringAfter('=', ""))
          when (k) {
            "key" -> if (key == null) key = v else return false
            "name" -> {}
            else -> return false
          }
        }
        return key != null && KEY.matches(key)
      }
    }
    return false
  }

  fun safeName(raw: String): String {
    val clean = raw.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]+"), "_").trim().trimStart('.').take(120)
    return if (clean.isEmpty()) "file" else clean
  }

  /** Тип для системы: заявленный клиентом, а если пуст, «просто байты» или странный — по расширению (как `MediaBridge.fileMime`). */
  fun mimeOf(declared: String, name: String): String {
    val d = declared.substringBefore(';').trim().lowercase()
    if (MIME.matches(d) && d != "application/octet-stream") return d
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  /**
   * Запрос клиента: JSON `{url, name, mime, then: "save" | "open"}`. Ответ: `ok` (загрузка поставлена), `denied` (чужой адрес /
   * не та форма), `bad` (не JSON), `error` (DownloadManager отказал).
   */
  fun start(context: Context, json: String): String {
    val o = try {
      org.json.JSONObject(json)
    } catch (_: Exception) {
      return "bad"
    }
    val url = o.optString("url")
    val bases = NotifAuth.apiUrls(context)
    if (!allowedUrl(url, bases)) {
      Log.w(TAG, "download denied (not an own attachment link)")
      return "denied"
    }
    val name = safeName(o.optString("name"))
    val mime = mimeOf(o.optString("mime"), name)
    val open = o.optString("then") == "open"
    return try {
      val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val req = DownloadManager.Request(Uri.parse(url))
        .setTitle(name)
        .setMimeType(mime)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      // Android 10+: общая папка «Загрузки» без разрешений; ниже нужно WRITE_EXTERNAL_STORAGE (его у приложения нет) —
      // тогда папка приложения: файл откроется из шторки и по «Открыть», в «Файлах» его не видно.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "$SUBDIR/$name")
      } else {
        req.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
      }
      if (open) ensureReceiver(context.applicationContext)
      val id = dm.enqueue(req)
      if (open) toOpen[id] = mime
      "ok"
    } catch (e: Exception) {
      Log.w(TAG, "enqueue failed: ${e.javaClass.simpleName}")
      "error"
    }
  }

  private fun ensureReceiver(app: Context) {
    if (receiverOn) return
    synchronized(this) {
      if (receiverOn) return
      val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
      // Шлёт системный DownloadProvider (другой процесс) — с Android 13 нужен явный флаг. Подделка чужим приложением
      // безвредна: открываем только свои id и только при статусе «успешно» из самого DownloadManager.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        app.registerReceiver(Done, filter, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        app.registerReceiver(Done, filter)
      }
      receiverOn = true
    }
  }

  private object Done : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
      val mime = toOpen.remove(id) ?: return
      val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      var ok = false
      try {
        dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
          if (c.moveToFirst()) {
            val col = c.getColumnIndex(DownloadManager.COLUMN_STATUS)
            ok = col >= 0 && c.getInt(col) == DownloadManager.STATUS_SUCCESSFUL
          }
        }
      } catch (_: Exception) {
        ok = false
      }
      if (!ok) {
        toast(context, "Не удалось скачать файл")
        return
      }
      val uri = dm.getUriForDownloadedFile(id) ?: return toast(context, "Не удалось открыть файл")
      // Неизвестный тип — не открываем наугад (на нём отзываются случайные приложения, см. `MediaBridge.viewFile`).
      if (mime == "application/octet-stream") return toast(context, "Нет приложения, чтобы открыть этот файл")
      val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, mime)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(view)
      } catch (_: ActivityNotFoundException) {
        toast(context, "Нет приложения, чтобы открыть этот файл")
      } catch (e: Exception) {
        Log.w(TAG, "open failed: ${e.javaClass.simpleName}")
        toast(context, "Не удалось открыть файл")
      }
    }
  }

  private fun toast(context: Context, text: String) {
    Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_LONG).show() }
  }
}
