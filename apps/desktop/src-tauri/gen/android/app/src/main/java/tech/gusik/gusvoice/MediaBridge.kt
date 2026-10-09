package tech.gusik.gusvoice

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.BaseColumns
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.system.Os
import android.util.Log
import android.util.Size
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Медиа для веб-клиента (05.10, вложения «как в Telegram»): своя галерея (MediaStore), системное приложение «Файлы»
 * (ACTION_OPEN_DOCUMENT), «Сохранить» в галерею и «Копировать изображение» для меню фото. JS-сторона —
 * `apps/client/src/nativeMedia.ts`, там же протокол целиком.
 *
 * Файлы из ленты (06.10): у WebView нет обработчика загрузок — ссылка с `download` молча ничего не делала. Теперь байты
 * качает страница (ссылка бэкенда с CORS) и отдаёт сюда тем же `put`: `then: open` — копия в кеше
 * (`cache/gv-media/open/<метка>/<имя>`) и ACTION_VIEW через FileProvider (системное приложение по типу файла),
 * `then: download` — MediaStore «Загрузки» (Download/GusVoice, Android 10+); `reopen` открывает уже скачанную копию.
 * `then: share` (07.10, «Поделиться» в меню сообщения) — копия в `cache/gv-media/share/<имя>` и системное окно
 * «Поделиться» (ACTION_SEND через FileProvider); клиент узнаёт про него по `canShare` в `info` (старая сборка — пункта нет).
 *
 * 🔴 **Почему сообщения WebView, а не `@JavascriptInterface` и не протокол ассетов Tauri.** Мост `GusVoiceNative` носит только
 * строки — фото пришлось бы гнать base64 (+33 % и строка в десятки мегабайт через JNI). Протокол ассетов (`convertFileSrc`)
 * требует фичу `protocol-asset` у крейта `tauri` и область в `tauri.conf.json`, то есть правку сборки и ПК, и телефона,
 * а файл без Range-запроса он читает в память целиком. `WebViewCompat.addWebMessageListener` (androidx.webkit, уже в
 * зависимостях) отдаёт странице объект `GusVoiceMedia`, сообщения которого несут `ArrayBuffer` в обе стороны — байты без
 * перекодирования, частями. Объект видит только наша страница (`ORIGINS`), и только если WebView умеет `ArrayBuffer`
 * (`WEB_MESSAGE_ARRAY_BUFFER`); иначе его нет вовсе, и клиент идёт системным выбором файла.
 *
 * Потоки: сообщения приходят на главный поток; запросы к MediaStore и миниатюры — `work` (параллельно, листание не ждёт
 * оригиналов), оригиналы туда и обратно — `io` (по одному: части одного файла не перемешиваются). Ответы — только с главного
 * потока (`main.post`), пара «заголовок + байты» — одним заходом, чтобы между ними не встало чужое сообщение.
 */
class MediaBridge(private val activity: MainActivity) {
  private val main = Handler(Looper.getMainLooper())
  private val work: ExecutorService = Executors.newFixedThreadPool(3)
  private val io: ExecutorService = Executors.newSingleThreadExecutor()

  /** Сколько частей оригинала ждут отправки на главном потоке: очередь в памяти ограничена (4 × 512 КБ). */
  private val inFlight = Semaphore(4)

  /** Потоки файлов, которые клиент попросил остановить (лист закрыли). */
  private val cancelled: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

  private var permWaiter: Pair<JavaScriptReplyProxy, String>? = null
  private var docsWaiter: DocsRequest? = null

  /** Отправка «туда» (put): части `ArrayBuffer` не несут id, клиент шлёт отправки строго по одной. */
  private var put: PutRequest? = null

  private class DocsRequest(val proxy: JavaScriptReplyProxy, val id: String, val limit: Int, val max: Long)

  /**
   * «Поделиться в GusVoice» (09.10, G79): пришедшее из чужого приложения, уже скопированное в `cache/gv-media/inbox/<метка>/`.
   * Одно на всё приложение (новое заменяет старое, как у Telegram); трогается только на `io`.
   */
  private class SharedFile(val name: String, val mime: String, val size: Long, val file: File?, val skip: String?)
  private class Shared(val token: String, val text: String, val subject: String, val files: List<SharedFile>, val dropped: Int)

  private var shared: Shared? = null

  /**
   * Копирование пришедшего — НЕ на `io`: медленный или зависший чужой поставщик (`query`/`read` без конца) повесил бы весь
   * мост (`io` однопоточный). Своё задание на поток; общий срок [SHARE_COPY_MS]; новое намерение отменяет прежнее.
   */
  private val shareCopy: ExecutorService = Executors.newCachedThreadPool()
  private val shareGen = AtomicInteger()
  @Volatile private var shareJob: ShareJob? = null

  /** WebView без `ArrayBuffer`-сообщений (или мост не встал): клиент про пришедшее не узнает — и копировать незачем. */
  @Volatile private var bridgeOff = false

  /** Страница — и без объекта `GusVoiceMedia` (старый WebView): ей говорят `__gvShare()` про пришедший текст (D22). */
  @Volatile private var pageRef: WebView? = null

  /**
   * «Поделиться» со старым WebView (D22): только текст, JSON `{token, text, subject, dropped: 0, files: [], filesOff}` —
   * клиент берёт его обычным мостом (`MainActivity.NativeBridge.sharedText`). Файлы не копируются: передать их странице без
   * `ArrayBuffer`-сообщений нечем, `filesOff` — сколько их было (клиент скажет «обновите WebView»).
   */
  @Volatile private var legacyShared: JSONObject? = null

  /** Одно копирование «поделиться»: `kill` — срок вышел или пришло новое; закрывает открытое, чтобы встал зависший `read`. */
  private class ShareJob(val gen: Int, val token: String) {
    val signal = CancellationSignal()
    val open: MutableSet<Closeable> = Collections.newSetFromMap(ConcurrentHashMap<Closeable, Boolean>())
    @Volatile var dead = false

    fun kill() {
      dead = true
      try {
        signal.cancel()
      } catch (_: Exception) {
      }
      open.toList().forEach {
        try {
          it.close()
        } catch (_: Exception) {
        }
      }
    }
  }

  /** WebView, куда сказать «пришло поделиться» (`window.__gvShare`). Есть только при включённом объекте `GusVoiceMedia`. */
  @Volatile private var webViewRef: WebView? = null

  private class PutRequest(val id: String, val file: File, val name: String, val mime: String, val then: String) {
    var out: FileOutputStream? = null
    var bytes = 0L
    var failed = false
  }

  private class Item(
    val id: Long,
    val video: Boolean,
    val mime: String,
    val size: Long,
    val w: Int,
    val h: Int,
    val dur: Long,
    val added: Long,
    val name: String,
    val rot: Int,
  ) {
    fun json(): JSONObject = JSONObject()
      .put("id", id.toString())
      .put("kind", if (video) "video" else "image")
      .put("mime", mime)
      .put("size", size)
      .put("w", w)
      .put("h", h)
      .put("dur", dur)
      .put("added", added)
      .put("name", name)
      .put("rot", rot)
  }

  private val cr: ContentResolver get() = activity.contentResolver
  private val root: File get() = File(activity.cacheDir, "gv-media")
  private val prefs get() = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Вставить объект `GusVoiceMedia` в страницу. Зовётся из `onWebViewCreate` — до первой загрузки страницы. */
  fun attach(webView: WebView) {
    pageRef = webView
    val on = bridgeSupported() && try {
      WebViewCompat.addWebMessageListener(webView, CHANNEL, ORIGINS) { _, message, _, isMainFrame, proxy ->
        if (isMainFrame) onMessage(message, proxy)
      }
      true
    } catch (e: Exception) {
      Log.w(TAG, "addWebMessageListener failed", e)
      false
    }
    if (!on) {
      Log.i(TAG, "WebView without ArrayBuffer messages: native media is off, the client uses the system picker")
      // Чистка — и без моста: копии прошлых запусков (до отката WebView) иначе лежали бы в кеше вечно.
      bridgeOff = true
      shareJob?.kill()
      io.execute {
        shared = null
        File(root, INBOX).deleteRecursively()
        File(root, "put").deleteRecursively()
      }
      return
    }
    webViewRef = webView
    io.execute {
      File(root, "put").deleteRecursively()
      trimOpened(null)
      // Брошенное «поделиться» прошлых запусков; текущее (готовое или ещё копируемое) не трогаем.
      val keep = setOfNotNull(shared?.token, shareJob?.token)
      File(root, INBOX).listFiles()?.forEach { if (it.name !in keep) it.deleteRecursively() }
    }
  }

  /** Мост возможен: WebView умеет сообщения с `ArrayBuffer` (известно и до создания WebView — по установленному поставщику). */
  private fun bridgeSupported(): Boolean = try {
    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
  } catch (e: Exception) {
    false
  }

  fun shutdown() {
    shareJob?.kill()
    shareCopy.shutdownNow()
    work.shutdownNow()
    io.shutdownNow()
  }

  private fun onMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy) {
    if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
      val p = put ?: return
      val bytes = message.arrayBuffer
      io.execute { appendPut(p, bytes) }
      return
    }
    val req = try {
      JSONObject(message.data ?: return)
    } catch (e: Exception) {
      return
    }
    val id = req.optString("id")
    if (id.isEmpty()) return
    when (req.optString("op")) {
      "info" -> reply(proxy, info(id))
      "perm" -> perm(proxy, id, req.optString("ask"))
      "page" -> work.execute { page(proxy, id, req) }
      "thumb" -> work.execute { thumb(proxy, id, req) }
      "open" -> io.execute { open(proxy, id, req) }
      "docs" -> docs(proxy, id, req)
      "cancel" -> cancelled.add(req.optString("target"))
      "put" -> startPut(id, req)
      "putEnd" -> {
        val p = put
        put = null
        if (p != null && p.id == id) io.execute { finishPut(proxy, p) } else reply(proxy, err(id, "no-put"))
      }
      "reopen" -> io.execute { reopen(proxy, id, req) }
      // «Поделиться в GusVoice» (G79): что пришло — без байтов; байты — тем же потоком, что «Файлы»; забыть — по метке.
      "shared" -> io.execute { reply(proxy, ok(id).put("share", sharedJson())) }
      "sharedOpen" -> io.execute { sharedOpen(proxy, id, req.optString("token")) }
      "sharedDrop" -> io.execute { sharedDrop(req.optString("token")); reply(proxy, ok(id)) }
      else -> reply(proxy, err(id, "unknown-op"))
    }
  }

  // ——— Ответы ————————————————————————————————————————————————————————————————————————————————————————————————

  private fun ok(id: String): JSONObject = JSONObject().put("id", id).put("ok", true)

  private fun err(id: String, code: String): JSONObject = JSONObject().put("id", id).put("ok", false).put("error", code)

  private fun reply(proxy: JavaScriptReplyProxy, msg: JSONObject) {
    val s = msg.toString()
    main.post {
      try {
        proxy.postMessage(s)
      } catch (e: Exception) {
        Log.w(TAG, "reply failed", e)
      }
    }
  }

  /** Заголовок и байты — одним заходом главного потока: между ними не встанет чужое сообщение. */
  private fun replyBinary(proxy: JavaScriptReplyProxy, head: JSONObject, bytes: ByteArray, release: Boolean = false) {
    val s = head.toString()
    main.post {
      try {
        proxy.postMessage(s)
        proxy.postMessage(bytes)
      } catch (e: Exception) {
        Log.w(TAG, "binary reply failed", e)
      } finally {
        if (release) inFlight.release()
      }
    }
  }

  // ——— Разрешения ————————————————————————————————————————————————————————————————————————————————————————————

  private fun granted(p: String): Boolean =
    ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED

  /** Что просить: Android 14+ — с частичным доступом (окно «Выбрать фото и видео»), 13 — фото и видео, ниже — память. */
  private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO,
      Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    )
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
      Manifest.permission.READ_MEDIA_IMAGES,
      Manifest.permission.READ_MEDIA_VIDEO,
    )
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
  }

  /**
   * `granted` / `partial` (Android 14: человек выбрал часть фото) / `ask` / `blocked`. «Больше не спрашивать» Android прямо
   * не сообщает: спрашивали раньше (флаг в настройках) и объяснение показывать уже нельзя — значит, окно не появится, и
   * клиент ведёт в настройки приложения.
   */
  private fun permState(): String {
    val full = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      granted(Manifest.permission.READ_MEDIA_IMAGES) || granted(Manifest.permission.READ_MEDIA_VIDEO)
    } else {
      granted(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    if (full) return "granted"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
      granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    ) return "partial"
    val asked = prefs.getBoolean(KEY_ASKED, false)
    val rationale = mediaPermissions().any { activity.shouldShowRequestPermissionRationale(it) }
    return if (asked && !rationale) "blocked" else "ask"
  }

  private fun info(id: String): JSONObject = ok(id)
    .put("sdk", Build.VERSION.SDK_INT)
    .put("perm", permState())
    // Спрашивали ли уже: окно разрешения клиент показывает сам только при первом открытии галереи, дальше — плашкой.
    .put("asked", prefs.getBoolean(KEY_ASKED, false))
    .put("camera", granted(Manifest.permission.CAMERA))
    // Микрофон нужен видео с камеры листа: без разрешения клиент пишет без звука и окна разрешения не просит — оно
    // «скрывает» страницу и роняет поток камеры посреди записи (стенд 06.10).
    .put("mic", granted(Manifest.permission.RECORD_AUDIO))
    .put("canSave", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
    // «Поделиться» файлом из ленты (`then: share`, 07.10): есть в этой сборке — у старых поля нет, клиент пункт прячет.
    .put("canShare", true)
    // «Поделиться в GusVoice» (09.10, G79): эта сборка принимает ACTION_SEND и отвечает на `shared` / `sharedOpen` / `sharedDrop`.
    .put("canInbox", true)

  private fun perm(proxy: JavaScriptReplyProxy, id: String, ask: String) {
    when (ask) {
      "ask" -> {
        val state = permState()
        if (state == "granted" || permWaiter != null) {
          reply(proxy, ok(id).put("perm", state))
          return
        }
        permWaiter = proxy to id
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
        try {
          activity.launchMediaPermissions(mediaPermissions())
        } catch (e: Exception) {
          Log.w(TAG, "permission request failed", e)
          permWaiter = null
          reply(proxy, ok(id).put("perm", permState()))
        }
      }
      "settings" -> {
        try {
          activity.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)),
          )
        } catch (e: Exception) {
          Log.w(TAG, "app settings failed", e)
        }
        reply(proxy, ok(id).put("perm", permState()))
      }
      else -> reply(proxy, ok(id).put("perm", permState()))
    }
  }

  /** Результат окна разрешений (`MainActivity.requestMediaPerms`). */
  fun onPermissionResult() {
    val w = permWaiter ?: return
    permWaiter = null
    reply(w.first, ok(w.second).put("perm", permState()))
  }

  // ——— Галерея: порции и миниатюры ————————————————————————————————————————————————————————————————————————————

  private fun collection(video: Boolean): Uri =
    if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI

  /**
   * Порция «новые сверху» по курсору `(date_added, _id)`: фото и видео — двумя запросами к своим коллекциям, слиянием по тому
   * же ключу. Курсор вместо OFFSET: MediaStore до Android 11 смещение из `Bundle` молча игнорирует, а с Android 11 запрещает
   * `LIMIT` в сортировке; курсор правилен при любом из этих поведений (лишние строки просто не читаются).
   */
  private fun page(proxy: JavaScriptReplyProxy, id: String, req: JSONObject) {
    try {
      val limit = req.optInt("limit", 60).coerceIn(1, 200)
      val before = req.optJSONObject("before")
      val bAdded = before?.optLong("added", -1L) ?: -1L
      val bId = before?.optString("id")?.toLongOrNull() ?: -1L
      val images = queryKind(false, limit, bAdded, bId)
      val videos = queryKind(true, limit, bAdded, bId)
      val all = (images + videos).sortedWith(compareByDescending<Item> { it.added }.thenByDescending { it.id })
      val arr = JSONArray()
      for (it in all.take(limit)) arr.put(it.json())
      val end = images.size < limit && videos.size < limit && all.size <= limit
      reply(proxy, ok(id).put("items", arr).put("end", end))
    } catch (e: SecurityException) {
      reply(proxy, err(id, "denied"))
    } catch (e: Exception) {
      Log.w(TAG, "gallery page failed", e)
      reply(proxy, err(id, "query"))
    }
  }

  private fun queryKind(video: Boolean, limit: Int, bAdded: Long, bId: Long): List<Item> {
    val extra = if (video) MediaStore.Video.VideoColumns.DURATION else MediaStore.Images.ImageColumns.ORIENTATION
    val proj = arrayOf(
      BaseColumns._ID,
      MediaStore.MediaColumns.MIME_TYPE,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.WIDTH,
      MediaStore.MediaColumns.HEIGHT,
      MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.DISPLAY_NAME,
      extra,
    )
    val added = MediaStore.MediaColumns.DATE_ADDED
    val sel = StringBuilder("${MediaStore.MediaColumns.SIZE} > 0")
    val args = ArrayList<String>()
    if (bAdded >= 0 && bId >= 0) {
      sel.append(" AND ($added < ? OR ($added = ? AND ${BaseColumns._ID} < ?))")
      args.add(bAdded.toString())
      args.add(bAdded.toString())
      args.add(bId.toString())
    }
    val order = "$added DESC, ${BaseColumns._ID} DESC"
    val cursor: Cursor? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val b = Bundle()
      b.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, sel.toString())
      b.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toTypedArray())
      b.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order)
      b.putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
      cr.query(collection(video), proj, b, null)
    } else {
      cr.query(collection(video), proj, sel.toString(), args.toTypedArray(), "$order LIMIT $limit")
    }
    val out = ArrayList<Item>()
    cursor?.use { c ->
      val iId = c.getColumnIndexOrThrow(BaseColumns._ID)
      val iMime = c.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE)
      val iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
      val iW = c.getColumnIndex(MediaStore.MediaColumns.WIDTH)
      val iH = c.getColumnIndex(MediaStore.MediaColumns.HEIGHT)
      val iAdded = c.getColumnIndex(added)
      val iName = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
      val iExtra = c.getColumnIndex(extra)
      while (out.size < limit && c.moveToNext()) {
        val mid = c.getLong(iId)
        out.add(
          Item(
            id = mid,
            video = video,
            mime = (if (iMime >= 0) c.getString(iMime) else null) ?: if (video) "video/mp4" else "image/jpeg",
            size = if (iSize >= 0) c.getLong(iSize) else 0L,
            w = if (iW >= 0) c.getInt(iW) else 0,
            h = if (iH >= 0) c.getInt(iH) else 0,
            dur = if (video && iExtra >= 0) c.getLong(iExtra) else 0L,
            added = if (iAdded >= 0) c.getLong(iAdded) else 0L,
            name = (if (iName >= 0) c.getString(iName) else null) ?: "$mid",
            rot = if (!video && iExtra >= 0) c.getInt(iExtra) else 0,
          ),
        )
      }
    }
    return out
  }

  private fun thumb(proxy: JavaScriptReplyProxy, id: String, req: JSONObject) {
    val mid = req.optString("mid").toLongOrNull()
    if (mid == null) {
      reply(proxy, err(id, "bad-id"))
      return
    }
    val video = req.optString("kind") == "video"
    val px = req.optInt("px", 320).coerceIn(64, 640)
    try {
      val bytes = thumbBytes(mid, video, px, req.optInt("rot", 0))
      if (bytes == null) reply(proxy, err(id, "no-thumb"))
      else replyBinary(proxy, JSONObject().put("id", id).put("bin", JSONObject().put("mime", "image/jpeg")), bytes)
    } catch (e: Exception) {
      reply(proxy, err(id, "thumb"))
    }
  }

  private fun thumbBytes(mid: Long, video: Boolean, px: Int, rot: Int): ByteArray? {
    val raw: Bitmap? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      cr.loadThumbnail(ContentUris.withAppendedId(collection(video), mid), Size(px, px), null)
    } else if (video) {
      @Suppress("DEPRECATION")
      MediaStore.Video.Thumbnails.getThumbnail(cr, mid, MediaStore.Video.Thumbnails.MINI_KIND, null)
    } else {
      @Suppress("DEPRECATION")
      MediaStore.Images.Thumbnails.getThumbnail(cr, mid, MediaStore.Images.Thumbnails.MINI_KIND, null)
    }
    if (raw == null) return null
    // До Android 10 миниатюра лежит как снята — поворачиваем по EXIF сами (с 10-го `loadThumbnail` делает это сам).
    val bmp = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && !video && rot % 360 != 0) rotated(raw, rot) else raw
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 82, out)
    bmp.recycle()
    return out.toByteArray()
  }

  private fun rotated(src: Bitmap, degrees: Int): Bitmap {
    val m = Matrix()
    m.postRotate(degrees.toFloat())
    val r = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
    if (r !== src) src.recycle()
    return r
  }

  // ——— Оригиналы и документы → клиент ————————————————————————————————————————————————————————————————————————

  private fun open(proxy: JavaScriptReplyProxy, id: String, req: JSONObject) {
    val items = req.optJSONArray("items") ?: JSONArray()
    val max = req.optLong("max", DEFAULT_MAX)
    val compress = req.optBoolean("compress", false)
    for (i in 0 until items.length()) {
      if (cancelled.contains(id)) break
      val entry = items.optJSONObject(i) ?: continue
      val mid = entry.optString("id").toLongOrNull() ?: continue
      val video = entry.optString("kind") == "video"
      val uri = ContentUris.withAppendedId(collection(video), mid)
      val name = safeName(entry.optString("name"), if (video) "video.mp4" else "photo.jpg")
      val mime = entry.optString("mime").ifEmpty { cr.getType(uri) ?: if (video) "video/mp4" else "image/jpeg" }
      val photo = !video && mime.startsWith("image/") && mime != "image/gif"
      if (compress && photo && streamCompressed(proxy, id, i, uri, name)) continue
      streamOne(proxy, id, i, uri, name, mime, max)
    }
    cancelled.remove(id)
    reply(proxy, ok(id).put("done", true))
  }

  /**
   * Фото «как в Telegram»: длинная сторона до 2560 px, JPEG 85. Поворот по EXIF применяется при декодировании, а
   * перекодированный JPEG метаданных не несёт вовсе — GPS и модель телефона не уходят. Не вышло (формат, память) — `false`,
   * и уходит оригинал.
   */
  private fun streamCompressed(proxy: JavaScriptReplyProxy, id: String, index: Int, uri: Uri, name: String): Boolean {
    val bytes = try {
      compressedJpeg(uri)
    } catch (e: Throwable) {
      Log.w(TAG, "compress failed, sending the original", e)
      null
    } ?: return false
    val jpgName = name.substringBeforeLast('.', name) + ".jpg"
    reply(proxy, JSONObject().put("id", id).put("file", index).put("name", jpgName).put("mime", "image/jpeg").put("size", bytes.size))
    var off = 0
    while (off < bytes.size) {
      if (cancelled.contains(id)) return true
      val n = min(CHUNK, bytes.size - off)
      sendChunk(proxy, id, index, bytes.copyOfRange(off, off + n))
      off += n
    }
    reply(proxy, JSONObject().put("id", id).put("file", index).put("end", true))
    return true
  }

  private fun compressedJpeg(uri: Uri): ByteArray? {
    val decoded = decodeScaled(uri, PHOTO_MAX_SIDE) ?: return null
    // Прозрачное (PNG) — на белом: JPEG альфы не знает, без подложки прозрачное стало бы чёрным.
    val bmp = if (decoded.hasAlpha()) onWhite(decoded) else decoded
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, PHOTO_QUALITY, out)
    bmp.recycle()
    return out.toByteArray()
  }

  private fun decodeScaled(uri: Uri, maxSide: Int): Bitmap? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return ImageDecoder.decodeBitmap(ImageDecoder.createSource(cr, uri)) { decoder, info, _ ->
        val w = info.size.width
        val h = info.size.height
        val longest = max(w, h)
        if (longest > maxSide) {
          val k = maxSide.toDouble() / longest
          decoder.setTargetSize(max(1, (w * k).roundToInt()), max(1, (h * k).roundToInt()))
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    }
    // Android 7–8: BitmapFactory с прореживанием, затем точный размер и поворот по EXIF вручную.
    val bounds = BitmapFactory.Options()
    bounds.inJustDecodeBounds = true
    cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val opts = BitmapFactory.Options()
    opts.inSampleSize = sample
    val decoded = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
    val longest = max(decoded.width, decoded.height)
    val scaled = if (longest > maxSide) {
      val k = maxSide.toDouble() / longest
      val s = Bitmap.createScaledBitmap(decoded, max(1, (decoded.width * k).roundToInt()), max(1, (decoded.height * k).roundToInt()), true)
      if (s !== decoded) decoded.recycle()
      s
    } else {
      decoded
    }
    val rot = cr.openInputStream(uri)?.use { exifRotation(it) } ?: 0
    return if (rot != 0) rotated(scaled, rot) else scaled
  }

  private fun exifRotation(ins: InputStream): Int = try {
    when (ExifInterface(ins).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
      ExifInterface.ORIENTATION_ROTATE_90 -> 90
      ExifInterface.ORIENTATION_ROTATE_180 -> 180
      ExifInterface.ORIENTATION_ROTATE_270 -> 270
      else -> 0
    }
  } catch (e: Exception) {
    0
  }

  private fun onWhite(src: Bitmap): Bitmap {
    val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawColor(Color.WHITE)
    canvas.drawBitmap(src, 0f, 0f, null)
    src.recycle()
    return out
  }

  /** Оригинал байт в байт, частями. Больше предела — не тянем вовсе (`skip: too-big`), сервер такое всё равно не примет. */
  private fun streamOne(proxy: JavaScriptReplyProxy, id: String, index: Int, uri: Uri, name: String, mime: String, max: Long) {
    fun skip(reason: String) =
      reply(proxy, JSONObject().put("id", id).put("file", index).put("name", name).put("skip", reason))
    try {
      val size = sizeOf(uri)
      if (size > max) {
        skip("too-big")
        return
      }
      val input = cr.openInputStream(uri)
      if (input == null) {
        skip("unreadable")
        return
      }
      input.use { s ->
        reply(proxy, JSONObject().put("id", id).put("file", index).put("name", name).put("mime", mime).put("size", size))
        val buf = ByteArray(CHUNK)
        var total = 0L
        while (true) {
          if (cancelled.contains(id)) return
          val n = readFully(s, buf)
          if (n <= 0) break
          total += n
          if (total > max) {
            skip("too-big")
            return
          }
          sendChunk(proxy, id, index, buf.copyOf(n))
          if (n < buf.size) break
        }
      }
      reply(proxy, JSONObject().put("id", id).put("file", index).put("end", true))
    } catch (e: SecurityException) {
      skip("unreadable")
    } catch (e: IOException) {
      skip("unreadable")
    }
  }

  private fun sendChunk(proxy: JavaScriptReplyProxy, id: String, index: Int, bytes: ByteArray) {
    inFlight.acquireUninterruptibly()
    replyBinary(proxy, JSONObject().put("id", id).put("bin", JSONObject().put("file", index)), bytes, release = true)
  }

  private fun readFully(s: InputStream, buf: ByteArray): Int {
    var off = 0
    while (off < buf.size) {
      val n = s.read(buf, off, buf.size - off)
      if (n < 0) break
      off += n
    }
    return off
  }

  /** Размер по дескриптору; неизвестен — -1 (тогда предел проверяется по прочитанному). */
  private fun sizeOf(uri: Uri): Long = try {
    cr.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
  } catch (e: Exception) {
    -1L
  }

  private fun docs(proxy: JavaScriptReplyProxy, id: String, req: JSONObject) {
    if (docsWaiter != null) {
      reply(proxy, err(id, "busy"))
      return
    }
    docsWaiter = DocsRequest(proxy, id, req.optInt("limit", 10).coerceIn(1, 50), req.optLong("max", DEFAULT_MAX))
    try {
      activity.launchDocumentPicker()
    } catch (e: Exception) {
      Log.w(TAG, "document picker failed", e)
      docsWaiter = null
      reply(proxy, err(id, "no-picker"))
    }
  }

  /** Результат «Файлов» (`MainActivity.pickDocuments`): документы уходят оригиналами, как выбраны. */
  fun onDocumentsPicked(uris: List<Uri>) {
    val w = docsWaiter ?: return
    docsWaiter = null
    if (uris.isEmpty()) {
      reply(w.proxy, ok(w.id).put("done", true).put("cancelled", true))
      return
    }
    io.execute {
      val take = uris.take(w.limit)
      reply(w.proxy, JSONObject().put("id", w.id).put("total", take.size))
      take.forEachIndexed { i, uri ->
        if (cancelled.contains(w.id)) return@forEachIndexed
        val (name, mime) = docMeta(uri)
        streamOne(w.proxy, w.id, i, uri, name, mime, w.max)
      }
      cancelled.remove(w.id)
      reply(w.proxy, ok(w.id).put("done", true).put("dropped", max(0, uris.size - w.limit)))
    }
  }

  private fun docMeta(uri: Uri, signal: CancellationSignal? = null): Pair<String, String> {
    var name: String? = null
    try {
      cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null, signal)?.use { c ->
        if (c.moveToFirst()) {
          val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (i >= 0) name = c.getString(i)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "document name failed", e)
    }
    val mime = cr.getType(uri) ?: "application/octet-stream"
    return safeName(name ?: uri.lastPathSegment ?: "", "file") to mime
  }

  // ——— «Поделиться в GusVoice» (09.10, G79) ———————————————————————————————————————————————————————————————————————

  /**
   * Намерение ACTION_SEND / ACTION_SEND_MULTIPLE (`MainActivity`: холодный старт и `onNewIntent`). Файлы копируются в кеш СРАЗУ:
   * право чтения чужого `content://` живёт, пока жива активность, а человек может выбирать беседу долго (или процесс убьют).
   * Больше 512 МБ (`SHARE_MAX`, предел сервера с загрузкой кусками `bigfile1`) не копируем — `skip: too-big`, клиент назовёт
   * причину; предел ИМЕННО этого сервера (без `bigfile1` — 25 МБ) применяет клиент (`shareInbox.shareFilesWithin`). Готово — `__gvShare()`.
   */
  fun onShareIntent(intent: Intent?) {
    // Старый WebView (мост не встанет): файлы клиент не заберёт — не копируем (иначе копии копятся в кеше); текст — D22.
    if (bridgeOff || !bridgeSupported()) {
      legacyShare(intent)
      return
    }
    val parsed = ShareIntent.parse(intent, activity.packageName) ?: return
    val fallbackType = parsed.type.takeIf { !it.contains('*') && it.contains('/') } ?: ""
    val job = ShareJob(shareGen.incrementAndGet(), UUID.randomUUID().toString())
    // Новое заменяет прежнее (как у Telegram): незаконченное копирование прежнего — отменить, готовое — стереть.
    shareJob?.kill()
    shareJob = job
    io.execute {
      shared?.let { File(root, "$INBOX/${it.token}").deleteRecursively() }
      shared = null
    }
    main.postDelayed({ if (!job.dead) job.kill() }, SHARE_COPY_MS)
    val ownDirs = ownDirs()
    val dir = File(root, "$INBOX/${job.token}")
    try {
      shareCopy.execute {
        val deadline = SystemClock.elapsedRealtime() + SHARE_COPY_MS
        val files = parsed.uris.mapIndexed { i, uri -> copyShared(uri, dir, i, fallbackType, job, deadline, ownDirs) }
        io.execute publish@{
          // Пока копировали, пришло новое (или мост отказал) — это копирование уже никому не нужно.
          if (bridgeOff || shareGen.get() != job.gen) {
            dir.deleteRecursively()
            return@publish
          }
          shared = Shared(job.token, parsed.text, parsed.subject, files, parsed.dropped)
          main.post { webViewRef?.evaluateJavascript("window.__gvShare && window.__gvShare()", null) }
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "share copy rejected", e)
    }
  }

  /** Старый WebView (D22): запомнить текст пришедшего и сказать странице; файлы — только счётом (`filesOff`). */
  private fun legacyShare(intent: Intent?) {
    val parsed = ShareIntent.parse(intent, activity.packageName) ?: return
    legacyShared = JSONObject()
      .put("token", UUID.randomUUID().toString())
      .put("text", parsed.text)
      .put("subject", parsed.subject)
      .put("dropped", 0)
      .put("files", JSONArray())
      .put("filesOff", parsed.uris.size + parsed.dropped)
    main.post { pageRef?.evaluateJavascript("window.__gvShare && window.__gvShare()", null) }
  }

  /** `GusVoiceNative.sharedText()` (D22): JSON пришедшего текста или `""`, если ничего не ждёт. */
  fun legacySharedJson(): String = legacyShared?.toString() ?: ""

  /** `GusVoiceNative.sharedTextDrop(token)`: забыть пришедшее (беседа выбрана или «Отмена»); чужая метка — ничего. */
  fun legacySharedDrop(token: String) {
    val s = legacyShared ?: return
    if (s.optString("token") == token) legacyShared = null
  }

  /** Канонические каталоги данных нашего процесса — для [ShareIntent.ownPath]. */
  private fun ownDirs(): List<String> {
    val dirs = mutableListOf<File?>(activity.cacheDir, activity.filesDir, activity.codeCacheDir, activity.noBackupFilesDir)
    dirs.add(File(activity.applicationInfo.dataDir))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      dirs.add(activity.dataDir)
      try {
        dirs.add(activity.createDeviceProtectedStorageContext().dataDir)
      } catch (_: Exception) {
      }
    }
    return dirs.filterNotNull().flatMap { d ->
      listOf(d.absolutePath, try { d.canonicalPath } catch (_: Exception) { d.absolutePath })
    }.distinct()
  }

  /** Настоящий путь открытого дескриптора; не вышло — `null` (тогда [ShareIntent.ownPath] считает файл своим). */
  private fun fdPath(afd: AssetFileDescriptor): String? = try {
    val p = Os.readlink("/proc/self/fd/${afd.parcelFileDescriptor.fd}")
    if (p.startsWith("/")) (try { File(p).canonicalPath } catch (_: Exception) { p }) else p
  } catch (e: Exception) {
    null
  }

  /**
   * Копия одного файла. Срок общий на всё намерение (`deadline`), отмена — `job.kill` (закрывает дескриптор, `read` встаёт);
   * недокопированное стирается, файл уходит клиенту как `unreadable`. Дескриптор нашего же файла (путь внутри данных
   * пакета, `ShareIntent.ownPath`) — тоже `unreadable`, байты не читаются.
   */
  private fun copyShared(
    uri: Uri, dir: File, index: Int, fallbackType: String, job: ShareJob, deadline: Long, ownDirs: List<String>,
  ): SharedFile {
    if (job.dead) return SharedFile(safeName(uri.lastPathSegment ?: "", "file"), "application/octet-stream", -1L, null, "unreadable")
    val (name, rawMime) = docMeta(uri, job.signal)
    val mime = fileMime(if (rawMime == "application/octet-stream") fallbackType else rawMime, name)
    // Своя папка на файл: одинаковые имена (image.jpg ×3 из браузера) не затирают друг друга.
    val out = File(dir, "$index/$name")
    var afd: AssetFileDescriptor? = null
    return try {
      afd = cr.openAssetFileDescriptor(uri, "r", job.signal) ?: return SharedFile(name, mime, -1L, null, "unreadable")
      job.open.add(afd)
      if (job.dead) return SharedFile(name, mime, -1L, null, "unreadable")
      if (ShareIntent.ownPath(fdPath(afd), activity.packageName, ownDirs)) {
        Log.w(TAG, "shared uri resolves into our own data — rejected")
        return SharedFile(name, mime, -1L, null, "unreadable")
      }
      val size = if (afd.length >= 0) afd.length else afd.parcelFileDescriptor.statSize
      if (size > SHARE_MAX) return SharedFile(name, mime, size, null, "too-big")
      out.parentFile?.mkdirs()
      var total = 0L
      afd.createInputStream().use { s ->
        FileOutputStream(out).use { o ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            if (job.dead || SystemClock.elapsedRealtime() > deadline) throw IOException("share copy cancelled or timed out")
            val n = s.read(buf)
            if (n < 0) break
            total += n
            if (total > SHARE_MAX) {
              o.close()
              out.delete()
              return SharedFile(name, mime, total, null, "too-big")
            }
            o.write(buf, 0, n)
          }
        }
      }
      if (job.dead) throw IOException("share copy cancelled")
      SharedFile(name, mime, total, out, null)
    } catch (e: Exception) {
      // SecurityException, IOException, OperationCanceledException (срок / новое намерение) — частичную копию стереть.
      out.delete()
      SharedFile(name, mime, -1L, null, "unreadable")
    } finally {
      afd?.let {
        job.open.remove(it)
        try {
          it.close()
        } catch (_: Exception) {
        }
      }
    }
  }

  /** `{token, text, subject, dropped, files:[{name, mime, size, skip?}]}` или `null`, если ничего не ждёт. */
  private fun sharedJson(): Any {
    val s = shared ?: return JSONObject.NULL
    val list = JSONArray()
    s.files.forEach { f ->
      val o = JSONObject().put("name", f.name).put("mime", f.mime).put("size", f.size)
      if (f.skip != null) o.put("skip", f.skip)
      list.put(o)
    }
    return JSONObject().put("token", s.token).put("text", s.text).put("subject", s.subject).put("dropped", s.dropped).put("files", list)
  }

  /** Байты пришедшего — как поток «Файлов»: `{total}`, по файлу `{file, name, mime, size}` + части + `{file, end}` / `skip`, `{done}`. */
  private fun sharedOpen(proxy: JavaScriptReplyProxy, id: String, token: String) {
    val s = shared
    if (s == null || s.token != token) {
      reply(proxy, err(id, "missing"))
      return
    }
    reply(proxy, JSONObject().put("id", id).put("total", s.files.size))
    s.files.forEachIndexed { i, f ->
      if (cancelled.contains(id)) return@forEachIndexed
      val file = f.file
      if (file == null || !file.isFile) {
        reply(proxy, JSONObject().put("id", id).put("file", i).put("name", f.name).put("skip", f.skip ?: "unreadable"))
      } else {
        streamOne(proxy, id, i, Uri.fromFile(file), f.name, f.mime, SHARE_MAX)
      }
    }
    cancelled.remove(id)
    reply(proxy, ok(id).put("done", true).put("dropped", s.dropped))
  }

  /** Забыть пришедшее (беседа выбрана и файлы приняты — или «Отмена»): копии стираются. Чужая метка — ничего. */
  private fun sharedDrop(token: String) {
    val s = shared ?: return
    if (s.token != token) return
    shared = null
    File(root, "$INBOX/$token").deleteRecursively()
  }

  // ——— Клиент → натив: «Сохранить» и «Копировать изображение» ——————————————————————————————————————————————————————

  private fun startPut(id: String, req: JSONObject) {
    val name = safeName(req.optString("name"), "image.jpg")
    val p = PutRequest(id, File(File(root, "put"), id), name, req.optString("mime"), req.optString("then"))
    put = p
    io.execute {
      try {
        p.file.parentFile?.mkdirs()
        p.out = FileOutputStream(p.file)
      } catch (e: IOException) {
        p.failed = true
      }
    }
  }

  private fun appendPut(p: PutRequest, bytes: ByteArray) {
    if (p.failed) return
    try {
      p.bytes += bytes.size
      val out = p.out
      if (out == null || p.bytes > PUT_MAX) {
        p.failed = true
        return
      }
      out.write(bytes)
    } catch (e: IOException) {
      p.failed = true
    }
  }

  private fun finishPut(proxy: JavaScriptReplyProxy, p: PutRequest) {
    try {
      p.out?.close()
    } catch (e: IOException) {
      p.failed = true
    }
    if (p.failed || p.out == null) {
      p.file.delete()
      reply(proxy, err(p.id, "write"))
      return
    }
    // Файл из ленты (06.10): тип — любой (PDF, архив, таблица), картиночное правило `mimeFor` ему не годится.
    if (p.then == "open" || p.then == "download" || p.then == "share") {
      finishFile(proxy, p, fileMime(p.mime, p.name))
      return
    }
    val mime = mimeFor(p.mime, p.name)
    when (p.then) {
      "save" -> {
        try {
          val uri = saveToGallery(p.file, p.name, mime)
          reply(proxy, ok(p.id).put("uri", uri.toString()))
        } catch (e: UnsupportedOperationException) {
          reply(proxy, err(p.id, "unsupported"))
        } catch (e: Exception) {
          Log.w(TAG, "save to gallery failed", e)
          reply(proxy, err(p.id, "save"))
        } finally {
          p.file.delete()
        }
      }
      "copy" -> copyToClipboard(proxy, p, mime)
      else -> {
        p.file.delete()
        reply(proxy, err(p.id, "unknown-then"))
      }
    }
  }

  /** Тип для MediaStore: коллекция картинок принимает только картинки (image), видео — видео (video); без типа — по расширению. */
  private fun mimeFor(declared: String, name: String): String {
    val d = declared.substringBefore(';').trim().lowercase()
    if (d.startsWith("image/") || d.startsWith("video/")) return d
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "image/jpeg"
  }

  /** Android 10+: своя запись в MediaStore разрешения не требует. Pictures/GusVoice (видео — Movies/GusVoice). */
  private fun saveToGallery(src: File, name: String, mime: String): Uri {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw UnsupportedOperationException("needs Android 10")
    val video = mime.startsWith("video/")
    val target = if (video) {
      MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }
    return insertMedia(target, if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES, src, name, mime)
  }

  /**
   * «Скачать» (06.10): Android 10+ — коллекция «Загрузки» MediaStore, папка Download/GusVoice; файл виден в системных
   * «Файлах» и в «Загрузках». Разрешений не нужно (своя запись). Ниже 10 — `unsupported`: туда без WRITE_EXTERNAL_STORAGE
   * не написать, клиент тогда открывает файл (из приложения просмотра его можно сохранить).
   */
  private fun saveToDownloads(src: File, name: String, mime: String): Uri {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw UnsupportedOperationException("needs Android 10")
    val target = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    return insertMedia(target, Environment.DIRECTORY_DOWNLOADS, src, name, mime)
  }

  /** Запись в коллекцию MediaStore через `IS_PENDING`: недописанный файл другие приложения не видят. Совпало имя — MediaStore сам допишет « (1)». */
  private fun insertMedia(target: Uri, dir: String, src: File, name: String, mime: String): Uri {
    val values = ContentValues()
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, name)
    values.put(MediaStore.MediaColumns.MIME_TYPE, mime)
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, "$dir/GusVoice")
    values.put(MediaStore.MediaColumns.IS_PENDING, 1)
    val uri = cr.insert(target, values) ?: throw IOException("insert")
    try {
      val out = cr.openOutputStream(uri) ?: throw IOException("open")
      out.use { o -> src.inputStream().use { it.copyTo(o) } }
      val done = ContentValues()
      done.put(MediaStore.MediaColumns.IS_PENDING, 0)
      cr.update(uri, done, null, null)
      return uri
    } catch (e: Exception) {
      try {
        cr.delete(uri, null, null)
      } catch (ignored: Exception) {
      }
      throw e
    }
  }

  /**
   * Картинка в буфер обмена ссылкой `content://` нашего FileProvider (`file_paths.xml`: `cache-path`). Копия лежит в
   * кеше, пока её не сменит следующая (в буфере одна картинка). Право чтения тому, кто вставит, выдаёт система
   * (`grantUriPermissions="true"` у провайдера).
   */
  private fun copyToClipboard(proxy: JavaScriptReplyProxy, p: PutRequest, mime: String) {
    try {
      val dir = File(root, "clip")
      dir.mkdirs()
      dir.listFiles()?.forEach { it.delete() }
      val dst = File(dir, p.name)
      if (!p.file.renameTo(dst)) {
        p.file.copyTo(dst, overwrite = true)
        p.file.delete()
      }
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", dst)
      main.post {
        try {
          val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
          cm.setPrimaryClip(ClipData.newUri(cr, p.name, uri))
          // Android 13+ сам показывает плашку «Скопировано» — клиенту свой тост тогда не нужен.
          proxy.postMessage(ok(p.id).put("systemNotice", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU).put("mime", mime).toString())
        } catch (e: Exception) {
          Log.w(TAG, "clipboard failed", e)
          proxy.postMessage(err(p.id, "clipboard").toString())
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "copy failed", e)
      p.file.delete()
      reply(proxy, err(p.id, "copy"))
    }
  }

  // ——— Файлы из ленты: «открыть» и «Скачать» (06.10) ———————————————————————————————————————————————————————————————

  /**
   * Тип файла для системы: заявленный клиентом (тип вложения от сервера), а если он пуст или «просто байты» — по
   * расширению имени. Неизвестное — `application/octet-stream`: такой файл откроет разве что «Файлы», но не потеряется.
   */
  private fun fileMime(declared: String, name: String): String {
    val d = declared.substringBefore(';').trim().lowercase()
    if (d.contains('/') && d != "application/octet-stream") return d
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  private fun finishFile(proxy: JavaScriptReplyProxy, p: PutRequest, mime: String) {
    if (p.then == "share") {
      shareFile(proxy, p, mime)
      return
    }
    if (p.then == "download") {
      try {
        val uri = saveToDownloads(p.file, p.name, mime)
        reply(proxy, ok(p.id).put("uri", uri.toString()))
      } catch (e: UnsupportedOperationException) {
        reply(proxy, err(p.id, "unsupported"))
      } catch (e: Exception) {
        Log.w(TAG, "save to downloads failed", e)
        reply(proxy, err(p.id, "save"))
      } finally {
        p.file.delete()
      }
      return
    }
    // open: своя папка на файл — имя остаётся как у вложения (по нему приложение просмотра показывает заголовок и
    // узнаёт тип), а одинаковые имена из разных сообщений друг друга не затирают.
    try {
      val token = UUID.randomUUID().toString()
      val dir = File(File(root, OPENED), token)
      dir.mkdirs()
      val dst = File(dir, p.name)
      if (!p.file.renameTo(dst)) {
        p.file.copyTo(dst, overwrite = true)
        p.file.delete()
      }
      trimOpened(dir)
      main.post {
        val res = viewFile(p.id, dst, mime)
        try {
          proxy.postMessage(res.put("token", token).toString())
        } catch (e: Exception) {
          Log.w(TAG, "open reply failed", e)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "open failed", e)
      p.file.delete()
      reply(proxy, err(p.id, "open"))
    }
  }

  /**
   * Показать файл системным приложением: ACTION_VIEW со ссылкой `content://` нашего FileProvider (`file_paths.xml`:
   * `cache-path`) и правом чтения ТОЛЬКО этого файла для того, кто откроет. Приложений по типу несколько — система сама
   * спросит, каким. Ни одного — `no-app`. Только с главного потока.
   *
   * 🔴 Тип неизвестен (`application/octet-stream`) — сразу `no-app`, без окна: на такой тип отзываются случайные
   * обработчики. Стенд 06.10 (эмулятор с Google-сервисами): `.bin` «открыл» `AliasSavePkPassActivity` Google Play (сохранение
   * пропуска в кошелёк) — окно мигнуло и закрылось, человек не увидел ничего. Такой файл клиент предлагает сохранить в «Загрузки».
   */
  private fun viewFile(id: String, file: File, mime: String): JSONObject = try {
    if (mime == "application/octet-stream") throw ActivityNotFoundException("unknown type")
    val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, mime)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    activity.startActivity(intent)
    ok(id)
  } catch (e: ActivityNotFoundException) {
    err(id, "no-app")
  } catch (e: Exception) {
    Log.w(TAG, "view failed", e)
    err(id, "open")
  }

  /**
   * «Поделиться» (07.10, меню сообщения у файла, видео и голосового — как у Telegram на Android): копия в
   * `cache/gv-media/share/<имя>` (прошлая уходит — приложение-получатель читает файл, пока его держит, а держать больше
   * одной незачем) и системное окно выбора, куда отправить: ACTION_SEND со ссылкой `content://` нашего FileProvider и
   * правом чтения только этого файла. Ответ — когда окно показано; что выбрал человек, система не сообщает.
   */
  private fun shareFile(proxy: JavaScriptReplyProxy, p: PutRequest, mime: String) {
    try {
      val dir = File(root, SHARED)
      dir.deleteRecursively()
      dir.mkdirs()
      val dst = File(dir, p.name)
      if (!p.file.renameTo(dst)) {
        p.file.copyTo(dst, overwrite = true)
        p.file.delete()
      }
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", dst)
      main.post {
        val res = try {
          val send = Intent(Intent.ACTION_SEND)
            .setType(mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          // Право чтения через окно выбора доходит до получателя только с `ClipData` (сама `EXTRA_STREAM` его не несёт).
          send.clipData = ClipData.newRawUri(p.name, uri)
          activity.startActivity(Intent.createChooser(send, null))
          ok(p.id)
        } catch (e: ActivityNotFoundException) {
          err(p.id, "no-app")
        } catch (e: Exception) {
          Log.w(TAG, "share failed", e)
          err(p.id, "share")
        }
        try {
          proxy.postMessage(res.toString())
        } catch (e: Exception) {
          Log.w(TAG, "share reply failed", e)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "share copy failed", e)
      p.file.delete()
      reply(proxy, err(p.id, "share"))
    }
  }

  /** Открыть уже скачанное в этом запуске (повторное нажатие на карточку): копия ещё в кеше — без новой загрузки. */
  private fun reopen(proxy: JavaScriptReplyProxy, id: String, req: JSONObject) {
    val token = req.optString("token")
    val file = if (TOKEN.matches(token)) File(File(root, OPENED), token).listFiles()?.firstOrNull { it.isFile } else null
    if (file == null) {
      reply(proxy, err(id, "missing"))
      return
    }
    file.parentFile?.setLastModified(System.currentTimeMillis())
    val mime = fileMime(req.optString("mime"), file.name)
    main.post {
      try {
        proxy.postMessage(viewFile(id, file, mime).toString())
      } catch (e: Exception) {
        Log.w(TAG, "reopen reply failed", e)
      }
    }
  }

  /**
   * Кеш открытых: копии живут сутки (приложение просмотра может перечитать файл, пока его держит) и в сумме не больше
   * `OPENED_MAX` — сверх того уходят самые старые. `keep` — только что положенный, его не трогаем.
   */
  private fun trimOpened(keep: File?) {
    val dirs = File(root, OPENED).listFiles()?.filter { it.isDirectory && it != keep } ?: return
    val old = System.currentTimeMillis() - OPENED_TTL_MS
    var total = keep?.walkBottomUp()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
    for (d in dirs.sortedByDescending { it.lastModified() }) {
      val size = d.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
      if (d.lastModified() < old || total + size > OPENED_MAX) d.deleteRecursively() else total += size
    }
  }

  private fun safeName(raw: String, fallback: String): String {
    val clean = raw.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]+"), "_").trim().take(120)
    return if (clean.isEmpty() || clean == "." || clean == "..") fallback else clean
  }

  companion object {
    private const val TAG = "GusVoiceMedia"
    const val CHANNEL = "GusVoiceMedia"

    /** Только наша страница (Tauri на Android: `http://tauri.localhost`; `https` — если схему когда-нибудь включат). */
    val ORIGINS: Set<String> = setOf("http://tauri.localhost", "https://tauri.localhost")

    private const val PREFS = "gusvoice_media"
    private const val KEY_ASKED = "perm_asked"

    /** Часть файла в сообщении: 512 КБ — мелко для памяти WebView, крупно для числа сообщений. */
    private const val CHUNK = 512 * 1024

    /** Предел файла, если клиент не прислал свой: тот же, что у сервера (25 МБ, `@fastify/multipart`). */
    private const val DEFAULT_MAX = 25L * 1024 * 1024

    /**
     * Предел копии «Поделиться в GusVoice» (09.10, `bigfile1`): сервер с загрузкой кусками берёт файл ЛС до 512 МБ
     * (`attachmentRules.BIGFILE_MAX_BYTES`). Копия делается до выбора беседы и сервера не знает — меньший предел сервера
     * без `bigfile1` (25 МБ) отсекает клиент.
     */
    private const val SHARE_MAX = 512L * 1024 * 1024

    /**
     * «Туда» (сохранить / копировать / открыть / скачать) — вложения из ленты; с запасом над пределом вложений. 520 МБ с
     * `bigfile1` (09.10, файл ЛС до 512 МБ; было 64 МБ): иначе принятый крупный файл не сохранить и не открыть.
     */
    private const val PUT_MAX = 520L * 1024 * 1024

    /** Папка кеша с открытыми файлами (`open/<метка>/<имя>`), их срок и общий предел. */
    private const val OPENED = "open"

    /** Папка кеша с файлом для «Поделиться» (`share/<имя>`): одна копия, прошлую заменяет следующая. */
    private const val SHARED = "share"

    /** Папка кеша с пришедшим через «Поделиться в GusVoice» (`inbox/<метка>/<n>/<имя>`), одно на приложение. */
    private const val INBOX = "inbox"
    /**
     * Общий срок копирования одного «поделиться» (все файлы): медленный чужой поставщик дольше — `unreadable`. 180 с с
     * `SHARE_MAX` 512 МБ (09.10; было 60 с при 25 МБ): облачный поставщик отдаёт крупный файл не мгновенно.
     */
    private const val SHARE_COPY_MS = 180_000L
    private const val OPENED_TTL_MS = 24L * 60 * 60 * 1000
    private const val OPENED_MAX = 200L * 1024 * 1024

    /** Метка открытого файла — UUID; другое в `reopen` не принимаем (путь из чужой строки не строим). */
    private val TOKEN = Regex("[0-9a-f-]{36}")

    private const val PHOTO_MAX_SIDE = 2560
    private const val PHOTO_QUALITY = 85
  }
}
