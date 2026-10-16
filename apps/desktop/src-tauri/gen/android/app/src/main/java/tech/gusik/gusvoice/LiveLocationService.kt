package tech.gusik.gusvoice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * «Транслировать геопозицию» в ЛС (14.10, признак сервера `geolive1`): служба переднего плана с типом `location`, которая
 * шлёт новые точки на наш сервер, пока приложение свёрнуто. Как у Telegram: `LocationSharingService` (служба + постоянное
 * уведомление с кнопкой `StopLiveLocation`) и `LocationController` (подписка на GPS и сеть, `BACKGROUD_UPDATE_TIME` = 30 с,
 * `messages.editMessage` с новой точкой — у нас `POST /api/conv/:id/messages/:mid/live`).
 *
 * Запускается из моста [MainActivity] (`startLiveLocation`) в ответ на действие человека на ВИДИМОЙ странице: с Android 14
 * службу с типом `location` нельзя вывести на передний план из фона, но запущенная при открытом приложении она сохраняет
 * доступ «пока приложение используется» и в свёрнутом виде — `ACCESS_BACKGROUND_LOCATION` не нужен (Telegram его тоже не
 * просит: в манифесте только `ACCESS_COARSE/FINE_LOCATION` и `FOREGROUND_SERVICE_LOCATION`). Разрешение на геопозицию
 * человек уже выдал окном системы при выборе места в `GeoPickDialog` (wry `RustWebChromeClient`); нет разрешения — старт
 * отклоняется, трансляцию ведёт страница.
 *
 * Адрес API и токен приходят из JS при старте и живут ТОЛЬКО в памяти процесса ([Session]); в журнал не пишутся. Процесс
 * умер — служба и записи умерли вместе (`START_NOT_STICKY`), клиент при следующем запуске поднимет их заново, если окно на
 * экране. Служба уходит сама, когда трансляций не осталось: истёк срок, «Остановить» в приложении или в уведомлении, выход
 * из аккаунта, сервер ответил 401/403/404. Хватает системного `LocationManager` — новых зависимостей Gradle нет (OkHttp
 * уже подключён: `NotifActionReceiver`).
 */
class LiveLocationService : Service() {
  private val main = Handler(Looper.getMainLooper())
  private var foreground = false
  private var listening = false
  private var lastGpsAt = 0L // SystemClock.elapsedRealtime() последней точки GPS: сетевую в ближайшие 20 с не берём

  private val sweep = object : Runnable {
    override fun run() {
      dropExpired()
      if (sessions.isEmpty()) shutDown() else main.postDelayed(this, SWEEP_MS)
    }
  }

  private val listener = object : LocationListener {
    override fun onLocationChanged(loc: Location) = onFix(loc)

    @Deprecated("Deprecated in API 29")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
    }

    override fun onProviderEnabled(provider: String) {}

    override fun onProviderDisabled(provider: String) {}
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Сначала на передний план: служба, запущенная startForegroundService, обязана вызвать startForeground, иначе система роняет приложение.
    if (!foreground) goForeground()
    if (intent?.action == ACTION_STOP) {
      stopFromNotification()
      return START_NOT_STICKY
    }
    dropExpired()
    if (!foreground || sessions.isEmpty()) {
      shutDown()
    } else {
      startListening()
      main.removeCallbacks(sweep)
      main.postDelayed(sweep, SWEEP_MS)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    main.removeCallbacks(sweep)
    stopListening()
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun goForeground() {
    val n = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      else startForeground(NOTIF_ID, n)
      foreground = true
    } catch (e: RuntimeException) {
      // SecurityException — нет разрешения на геопозицию или старт из фона (Android 14+); прочие отказы системы. Службой
      // трансляций не будет: записи снимаются, страница увидит это (`liveLocationIds`) и поведёт сама, пока открыта.
      Log.w(TAG, "live location: startForeground refused: $e")
      sessions.clear()
    }
  }

  private fun buildNotification(): Notification {
    ensureChannel()
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, LiveLocationService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Трансляция геопозиции")
      .setContentText("GusVoice транслирует геопозицию")
      .setSmallIcon(R.drawable.ic_stat_location)
      .setContentIntent(open)
      .addAction(0, "Остановить", stop)
      .setOngoing(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
      mgr.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Трансляция геопозиции", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Постоянное уведомление, пока GusVoice транслирует вашу геопозицию в беседу"
          setShowBadge(false)
        },
      )
    }
  }

  @Suppress("MissingPermission")
  private fun startListening() {
    if (listening) return
    val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!fine && !coarse) {
      sessions.clear()
      shutDown()
      return
    }
    val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    try {
      // Как Telegram `LocationController.start`: GPS и сеть вместе (в помещении GPS молчит).
      if (fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, UPDATE_MS, 0f, listener, Looper.getMainLooper())
      if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, UPDATE_MS, 0f, listener, Looper.getMainLooper())
      listening = true
      // Последняя известная точка — сразу, не ждать первого обновления.
      for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
        val known = try {
          lm.getLastKnownLocation(p)
        } catch (_: SecurityException) {
          null
        }
        if (known != null && System.currentTimeMillis() - known.time < 120_000) {
          onFix(known)
          break
        }
      }
    } catch (e: SecurityException) {
      Log.w(TAG, "live location: no permission: $e")
      sessions.clear()
      shutDown()
    } catch (e: RuntimeException) {
      Log.w(TAG, "live location: updates refused: $e")
    }
  }

  private fun stopListening() {
    if (!listening) return
    listening = false
    try {
      (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(listener)
    } catch (_: RuntimeException) {
    }
  }

  private fun onFix(loc: Location) {
    val now = SystemClock.elapsedRealtime()
    if (loc.provider == LocationManager.GPS_PROVIDER) lastGpsAt = now
    else if (lastGpsAt != 0L && now - lastGpsAt < 20_000) return
    dropExpired()
    for (s in sessions.values) {
      if (!s.due(loc.latitude, loc.longitude, now)) continue
      s.markSent(loc.latitude, loc.longitude, now)
      val body = JSONObject().put("lat", loc.latitude).put("lon", loc.longitude)
      if (loc.hasAccuracy()) body.put("accuracy", loc.accuracy.toDouble())
      if (loc.hasBearing()) body.put("heading", loc.bearing.toDouble())
      io.execute { post(s, "/live", body) }
    }
    if (sessions.isEmpty()) shutDown()
  }

  /** Кнопка «Остановить» в уведомлении: серверу — стоп каждой (получатели увидят «завершена»), потом служба уходит. */
  private fun stopFromNotification() {
    val all = sessions.values.toList()
    sessions.clear()
    for (s in all) io.execute { post(s, "/live/stop", JSONObject()) }
    shutDown()
  }

  private fun dropExpired() {
    val now = System.currentTimeMillis()
    sessions.values.removeAll { it.until <= now }
  }

  private fun shutDown() {
    main.removeCallbacks(sweep)
    stopListening()
    if (foreground) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      foreground = false
    }
    stopSelf()
  }

  /** Одна трансляция: чат, сообщение, чем ходить на сервер, когда кончится. Токен — только в памяти. */
  class Session(val apiUrl: String, @Volatile var token: String, val conversationId: String, val messageId: String, val until: Long, private val keepAliveMs: Long) {
    private var lastLat = 0.0
    private var lastLon = 0.0
    private var lastAt = 0L

    /** Не чаще раза в 5 с и только при сдвиге на 10 м (как в клиенте, `geoLiveShouldSend`); без сдвига — раз в [keepAliveMs] (в фоне 30 с). */
    fun due(lat: Double, lon: Double, now: Long): Boolean {
      if (lastAt == 0L) return true
      val gap = now - lastAt
      if (gap < MIN_SEND_MS) return false
      if (gap >= keepAliveMs) return true
      val d = FloatArray(1)
      Location.distanceBetween(lastLat, lastLon, lat, lon, d)
      return d[0] >= MOVE_M
    }

    fun markSent(lat: Double, lon: Double, now: Long) {
      lastLat = lat
      lastLon = lon
      lastAt = now
    }
  }

  private fun post(s: Session, tail: String, body: JSONObject) {
    val req = Request.Builder()
      .url("${s.apiUrl}/api/conv/${s.conversationId}/messages/${s.messageId}$tail")
      .header("Authorization", "Bearer ${s.token}")
      .post(body.toString().toRequestBody(JSON))
      .build()
    try {
      http.newCall(req).execute().use { res ->
        res.header("x-refresh-token")?.takeIf { it.isNotEmpty() }?.let { s.token = it }
        // Токен не принят, трансляции нет или она завершена — слать дальше нечего (сеть и 429 — ждём следующей точки).
        if (res.code == 401 || res.code == 403 || res.code == 404) {
          Log.w(TAG, "live location: server refused (${res.code}), dropping this share")
          sessions.remove(s.messageId)
          if (sessions.isEmpty()) main.post { shutDown() }
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "live location: send failed: ${e.javaClass.simpleName}")
    }
  }

  companion object {
    private const val TAG = "GusVoiceLive"
    private const val CHANNEL_ID = "gusvoice_live_location"
    private const val NOTIF_ID = 4211
    const val ACTION_STOP = "tech.gusik.gusvoice.LIVE_LOCATION_STOP"
    private const val UPDATE_MS = 5_000L
    private const val SWEEP_MS = 30_000L
    private const val MIN_SEND_MS = 5_000L
    private const val MOVE_M = 10f
    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val http by lazy { OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build() }
    private val io = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Идущие трансляции: id сообщения → запись. Только память процесса. */
    private val sessions = ConcurrentHashMap<String, Session>()

    @Volatile
    private var instance: LiveLocationService? = null

    /**
     * Из моста JS: взять трансляцию. JSON `{apiUrl, token, conversationId, messageId, until, backgroundMs}`. `false` — не
     * взято (нет разрешения на геопозицию, кривые данные, система отказала): трансляцию ведёт страница.
     */
    fun start(ctx: Context, json: String): Boolean {
      val o = try {
        JSONObject(json)
      } catch (_: Exception) {
        return false
      }
      val api = o.optString("apiUrl").trimEnd('/')
      val token = o.optString("token")
      val conv = o.optString("conversationId")
      val mid = o.optString("messageId")
      val until = o.optLong("until", 0L)
      val keepAlive = o.optLong("backgroundMs", 30_000L).coerceIn(10_000L, 120_000L)
      if (!(api.startsWith("https://") || api.startsWith("http://")) || token.isEmpty() || !ID.matches(conv) || !ID.matches(mid) || until <= System.currentTimeMillis()) return false
      val app = ctx.applicationContext
      val fine = ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      val coarse = ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (!fine && !coarse) return false
      sessions[mid] = Session(api, token, conv, mid, until, keepAlive)
      val intent = Intent(app, LiveLocationService::class.java)
      mainHandler.post {
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
        } catch (e: RuntimeException) {
          // Android 12+ из фона: ForegroundServiceStartNotAllowedException — службы нет, запись снимаем.
          Log.w(TAG, "live location: start refused: $e")
          sessions.remove(mid)
        }
      }
      return true
    }

    /** «Остановить» из приложения: серверу стоп шлёт страница, здесь — только снять запись (записей нет — служба уйдёт сама). */
    fun stop(messageId: String) {
      sessions.remove(messageId)
      mainHandler.post { if (sessions.isEmpty()) instance?.shutDown() }
    }

    /** Выход из аккаунта: забыть все записи вместе с токенами. */
    fun stopAll() {
      sessions.clear()
      mainHandler.post { instance?.shutDown() }
    }

    /** JSON-массив id сообщений, которые служба ведёт сейчас (страница сверяется с ним). */
    fun idsJson(): String {
      val now = System.currentTimeMillis()
      val arr = JSONArray()
      for (s in sessions.values) if (s.until > now) arr.put(s.messageId)
      return arr.toString()
    }
  }
}
