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
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

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
 *
 * 🔴 Старт из фона (#210). С Android 14 службу с типом `microphone` нельзя вывести на передний план, пока у приложения
 * нет окна на экране: `RECORD_AUDIO` — разрешение «пока приложение используется», и `startForeground` бросает
 * `SecurityException` («the app must be in the eligible state/exemptions to access the foreground only permission»).
 * Сам `startForegroundService` система при этом пропускает, если приложение «без ограничений батареи» (`Background
 * started FGS: Allowed` — в логе тестера на POCO 27.09; на эмуляторе с таким исключением — `code:SYSTEM_ALLOW_LISTED`).
 * Исключение не ловилось → «Unable to start service» на главном потоке → процесс падал; система перезапускала службу
 * ради недоставленного старта и падала второй раз, а поверх рабочего стола всплывало «GusVoice keeps stopping»
 * (воспроизведено на эмуляторе Android 16).
 * Теперь:
 *   - микрофон в типе — только когда его дают: нет `RECORD_AUDIO` — сразу `mediaPlayback`; отказ системы — тоже
 *     `mediaPlayback` без микрофона: процесс жив, чужие голоса слышно, свой микрофон система в фоне глушит до возврата;
 *   - повторный старт (клиент зовёт его на каждом возврате страницы на экран, `nativeVoiceService.ts`) поднимает тип до
 *     `microphone|mediaPlayback`, если его не хватало, а при полном типе ничего не делает;
 *   - отказ самого `startForegroundService` (Android 12+ из фона без исключений —
 *     `ForegroundServiceStartNotAllowedException`) ловится здесь, а не уходит исключением в мост WebView.
 * Правила системы — developer.android.com/develop/background-work/services/fgs/restrictions-bg-start (раздел while-in-use).
 */
class VoiceForegroundService : Service() {
  // Тип, с которым служба СЕЙЧАС на переднем плане; NOT_FOREGROUND — ещё не вышла.
  private var activeType = NOT_FOREGROUND

  // Что сейчас нарисовано в уведомлении (без `speaking`): перестраиваем только при смене видимого.
  private var shownKey = ""

  // Пузырь микрофона поверх других приложений (#156, порция 2, `MicBubble.kt`): живёт, пока живёт служба.
  private var bubble: MicBubble? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    live = this
    bubble = MicBubble(this) { action -> MainActivity.sendMicAction(action) }
    syncBubble()
  }

  override fun onDestroy() {
    if (live === this) live = null
    bubble?.remove()
    bubble = null
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    bubble?.onScreenChanged()
  }

  /** Показать/перерисовать/снять пузырь по последнему состоянию страницы и условиям показа ([MicBubble.shouldShow]). */
  private fun syncBubble() {
    val b = bubble ?: return
    val mic = parseMicState(micStateJson)
    b.sync(mic?.let { MicBubble.Look(it.muted, it.deafened, it.ptt, it.speaking, it.pttReleaseMs) })
  }

  /** Состояние от страницы сменилось — перерисовать уведомление, если служба уже на переднем плане и видимое изменилось. */
  private fun refreshNotification() {
    if (activeType == NOT_FOREGROUND) return
    if (notificationKey(parseMicState(micStateJson)) == shownKey) return
    try {
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification())
    } catch (e: RuntimeException) {
      Log.w(TAG, "voice service: notification update failed: $e")
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (pendingStarts > 0) pendingStarts--
    val wanted = wantedType()
    if (activeType != wanted) goForeground(wanted)
    // Выход из голоса пришёл, пока служба выходила на передний план (stop() его отложил), — или выйти не дали вовсе.
    if (activeType == NOT_FOREGROUND || (stopRequested && pendingStarts == 0)) {
      stopRequested = false
      stopSelf()
    }
    // Don't auto-restart with a null intent if the OS kills us — the call context is gone by then.
    return START_NOT_STICKY
  }

  /**
   * microphone|mediaPlayback: keep both the bg RECORD (upstream) and the bg audio OUTPUT (downstream) paths alive — see
   * class doc for why mediaPlayback matters on Xiaomi/MIUI et al. Микрофон — только при выданном `RECORD_AUDIO`: без него
   * Android 14+ откажет даже с экрана, а слушать канал без микрофона можно.
   */
  private fun wantedType(): Int {
    // API 29+ requires the FGS type at start; it must be a subset of the manifest's foregroundServiceType.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return NO_TYPE
    val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    return if (mic) MIC or MEDIA else MEDIA
  }

  /** Выйти на передний план с [type] (или поднять до него тип); микрофона не дали — без микрофона. Итог — [activeType]. */
  private fun goForeground(type: Int) {
    val notification = buildNotification()
    if (tryForeground(notification, type)) return
    // Уже на переднем плане (не вышло поднять тип, приложение ещё в фоне) — остаёмся с прежним типом до следующего возврата.
    if (activeType != NOT_FOREGROUND || type == MEDIA || type == NO_TYPE) return
    if (tryForeground(notification, MEDIA)) Log.w(TAG, "voice service: in foreground WITHOUT microphone type until the app is on screen")
  }

  private fun tryForeground(notification: Notification, type: Int): Boolean = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIF_ID, notification, type) else startForeground(NOTIF_ID, notification)
    activeType = type
    true
  } catch (e: RuntimeException) {
    // SecurityException — Android 14+: микрофон из фона или без RECORD_AUDIO; IllegalStateException и наследники
    // (ForegroundServiceStartNotAllowedException, ForegroundServiceTypeException) — прочие отказы системы.
    Log.w(TAG, "voice service: startForeground(type=0x${Integer.toHexString(type)}) refused: $e")
    false
  }

  private fun buildNotification(): Notification {
    ensureChannel()
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    // Состояние микрофона от страницы (#156, `nativeMicActions.ts`). Нет его (страница старее APK или ещё не прислала) —
    // уведомление как до #156: без кнопок.
    val mic = parseMicState(micStateJson)
    shownKey = notificationKey(mic)
    val b = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(mic?.channelName?.ifEmpty { null } ?: "GusVoice")
      .setContentText(statusText(mic))
      .setSmallIcon(if (mic != null && (mic.muted || mic.deafened)) R.drawable.ic_stat_mic_off else R.drawable.ic_stat_mic)
      .setContentIntent(open)
      .setOngoing(true)
      .setSilent(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    if (mic != null) {
      // Подписи — что СДЕЛАЕТ кнопка. Включить микрофон в «Не слышу» снимает и его (`voiceSelf.toggleSelfMute`).
      val micOff = mic.muted || mic.deafened
      b.addAction(
        if (micOff) R.drawable.ic_stat_mic else R.drawable.ic_stat_mic_off,
        // Коротко: в три кнопки Android даёт ~12 знаков, «Выключить микрофон» резалось до «Выключить ми…» (S20, 17.10).
        if (micOff) "Говорить" else "Заглушить",
        actionIntent(VoiceActionReceiver.ACTION_TOGGLE_MUTE, 1),
      )
      b.addAction(
        R.drawable.ic_stat_mic_off,
        if (mic.deafened) "Слышать" else "Не слышу",
        actionIntent(VoiceActionReceiver.ACTION_TOGGLE_DEAFEN, 2),
      )
      b.addAction(R.drawable.ic_call_end, "Выйти", actionIntent(VoiceActionReceiver.ACTION_LEAVE, 3))
    }
    return b.build()
  }

  private fun actionIntent(action: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
    this,
    code,
    Intent(this, VoiceActionReceiver::class.java).setAction(action),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
  )

  private fun statusText(mic: MicState?): String = when {
    mic == null -> "В голосовом канале"
    mic.deafened -> "Звук и микрофон выключены"
    mic.muted -> "Микрофон выключен"
    mic.ptt -> "Рация"
    else -> "Микрофон включён"
  }

  /** Последнее состояние страницы; `inVoice:false`, пустое или битое — null. */
  private class MicState(
    val muted: Boolean,
    val deafened: Boolean,
    val ptt: Boolean,
    val speaking: Boolean,
    val channelName: String,
    val pttReleaseMs: Int,
  )

  private fun parseMicState(json: String?): MicState? {
    if (json.isNullOrEmpty()) return null
    return try {
      val o = JSONObject(json)
      if (!o.optBoolean("inVoice", false)) null
      else MicState(
        o.optBoolean("muted", false),
        o.optBoolean("deafened", false),
        o.optBoolean("ptt", false),
        o.optBoolean("speaking", false),
        o.optString("channelName", "").take(100),
        o.optInt("pttReleaseMs", 0),
      )
    } catch (e: org.json.JSONException) {
      null
    }
  }

  // `speaking` в ключ не входит: он мигает с каждой фразой, а система душит частые перерисовки уведомления; он — для пузыря.
  private fun notificationKey(mic: MicState?): String =
    if (mic == null) "" else "${mic.muted}|${mic.deafened}|${mic.ptt}|${mic.channelName}"

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
    private const val TAG = "GusVoice"
    private const val CHANNEL_ID = "gusvoice_voice"
    private const val NOTIF_ID = 4210
    private const val NOT_FOREGROUND = -1
    private const val NO_TYPE = 0
    private const val MIC = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    private const val MEDIA = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK

    private val main = Handler(Looper.getMainLooper())

    // Только главный поток: start/stop пересылаются туда, onStartCommand и так на нём — поэтому без синхронизации.
    private var pendingStarts = 0 // запросов старта, до которых ещё не дошёл onStartCommand
    private var stopRequested = false // выход из голоса пришёл раньше, чем служба вышла на передний план
    // Живой экземпляр службы (onCreate…onDestroy, главный поток) — перерисовать уведомление по новому состоянию.
    private var live: VoiceForegroundService? = null
    // Последний JSON состояния микрофона от страницы (#156): пишет главный поток, читает и он; @Volatile — на всякий.
    @Volatile private var micStateJson: String? = null
    // Был ли голос в прошлом состоянии: вход в голос (false → true) возвращает пузырь, спрятанный крестиком.
    private var lastInVoice = false

    /** Из моста JS: новое состояние микрофона (`nativeMicActions.ts`). Уведомление и пузырь — на главном потоке. */
    fun updateMicState(ctx: Context, json: String) {
      val app = ctx.applicationContext
      main.post {
        micStateJson = json
        val inVoice = try {
          JSONObject(json).optBoolean("inVoice", false)
        } catch (e: org.json.JSONException) {
          false
        }
        if (inVoice && !lastInVoice) MicBubble.setHidden(app, false)
        lastInVoice = inVoice
        live?.refreshNotification()
        live?.syncBubble()
      }
    }

    /** `MainActivity.onResume`/`onPause`: GusVoice на экране — пузырь не нужен. */
    fun setAppForeground(foreground: Boolean) {
      main.post {
        MicBubble.appForeground = foreground
        live?.syncBubble()
      }
    }

    /** Мост `micBubbleSet`: тумблер «Кнопка поверх приложений» в настройках. */
    fun setBubbleEnabled(ctx: Context, enabled: Boolean) {
      val app = ctx.applicationContext
      main.post {
        MicBubble.setEnabled(app, enabled)
        live?.syncBubble()
      }
    }

    /** Из моста JS (поток JavaBridge) или откуда угодно: сам вызов — на главном потоке. */
    fun start(ctx: Context) {
      val app = ctx.applicationContext
      main.post { startNow(app) }
    }

    fun stop(ctx: Context) {
      val app = ctx.applicationContext
      main.post { stopNow(app) }
    }

    private fun startNow(ctx: Context) {
      stopRequested = false
      val intent = Intent(ctx, VoiceForegroundService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
        pendingStarts++
      } catch (e: RuntimeException) {
        // Android 12+ из фона: ForegroundServiceStartNotAllowedException; 8–11: IllegalStateException «Not allowed to
        // start service». Службы нет — клиент повторит старт, когда страница вернётся на экран.
        Log.w(TAG, "voice service: start refused: $e")
      }
    }

    private fun stopNow(ctx: Context) {
      // 🔴 Службу, запущенную startForegroundService, нельзя останавливать раньше её startForeground: система роняет
      // приложение («Context.startForegroundService() did not then call Service.startForeground()»). Ждём onStartCommand.
      if (pendingStarts > 0) {
        stopRequested = true
        return
      }
      ctx.stopService(Intent(ctx, VoiceForegroundService::class.java))
    }
  }
}
