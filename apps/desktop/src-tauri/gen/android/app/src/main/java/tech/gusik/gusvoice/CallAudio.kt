package tech.gusik.gusvoice

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Вывод звука звонка 1:1 (кнопка «Динамик», 13.10, #218; Telegram Android: `VoIPFragment.setSpeakerPhoneAction` /
 * `updateSpeakerPhoneIcon`, `VoIPService.toggleSpeakerphoneOrShowRouteSheet` / `setAudioOutput` / `switchToSpeaker`,
 * `VoipAudioManager`). Мост для веба — `NativeBridge.callAudio*` в MainActivity, клиент — `nativeCallAudio.ts`.
 *
 * Четыре вида вывода (имена общие с клиентом): `earpiece` (разговорный динамик у уха), `speaker` (громкий), `wired`
 * (проводные наушники, USB-гарнитура), `bluetooth` (SCO / BLE-гарнитура / слуховой аппарат).
 *
 * Как включаем: Android 12+ (API 31) — `AudioManager.setCommunicationDevice` / `clearCommunicationDevice`
 * (developer.android.com/reference/android/media/AudioManager#setCommunicationDevice); ниже — `setSpeakerphoneOn` и
 * `startBluetoothSco` / `setBluetoothScoOn` (устарели с API 31, но ниже 31 это единственный способ; minSdk 24).
 *
 * Начальное: голосовой звонок — у уха, видео — громкий (Telegram `VoIPService`: `setAudioOutput(0)` для видео, иначе
 * разговорный). Подключили проводные/Bluetooth — идём в них (Telegram: приёмник `ACTION_HEADSET_PLUG`, `setAudioOutput`);
 * отключили — возвращаемся к последнему выбору из встроенных.
 *
 * 🔴 РЕЖИМ ЗВУКА (`MODE_IN_COMMUNICATION`) мы НЕ ставим — по умолчанию (`FORCE_COMM_MODE = false`). Причина записана в
 * `MainActivity.onCreate`: на Samsung этот режим включает аппаратные ECNS-фильтры и «съедает» микрофон («всплеск и тишина»),
 * а режим на время разговора выставляет сам Chromium/WebRTC (лог: VOIP_RECORD / SetECNSForVoipEnter). Выбор устройства
 * запоминается и применяется заново, когда режим становится разговорным (`OnModeChangedListener`, API 31+). Если на
 * телефоне разговорный динамик не включится — поставить `FORCE_COMM_MODE = true` (режим вернётся прежним в `stop`).
 *
 * 🔴 ВЫБОР ДЕРЖИМ (14.10, проверка на S20 13.10): через ~0,4 с после `start` Chromium/WebRTC внутри WebView сам ставит устройство
 * связи (громкий) поверх нашего. Поэтому (1) Android 12+: слушатель `OnCommunicationDeviceChangedListener` сверяет фактическое
 * устройство с нашим выбором и, если перебили не мы, ставит выбор заново (`verifyRoute`; не чаще `REASSERT_MAX` раз за
 * `REASSERT_WINDOW_MS`, иначе стычка с Chromium бесконечна — сдаёмся и честно показываем то, что есть); (2) все версии — сверка по
 * таймеру после `start` (0,5 / 1,5 / 3,5 с), а ниже API 31 (слушателя нет) — раз в 2 с на всё время звонка. В журнал (`GusVoice`)
 * пишется строка `call audio: <причина> mode=… want=… have=…` — по ней видно, кто и когда перебил.
 * Звук звонка в WebView — поток USAGE_MEDIA при MODE_NORMAL: выбор устройства СВЯЗИ его может не касаться. Единственный
 * надёжный способ для такого потока — разговорный режим (`commMode`, `MODE_IN_COMMUNICATION`); он за флагом (см. выше), включается
 * мостом `callAudioSetCommMode` (клиент: `localStorage['gv.callAudio.commMode']='1'`) без пересборки.
 *
 * Потоки: изменяющее — только на одном потоке `io` (на Samsung `setSpeakerphoneOn` и `isSpeakerphoneOn` медленные,
 * Telegram `VoipAudioManager` выносит их так же); опросы `state()` из моста читают `AudioManager` напрямую (потокобезопасно).
 */
class CallAudio(ctx: Context, private val changed: () -> Unit) {
  private val app = ctx.applicationContext
  private val am = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val main = Handler(Looper.getMainLooper())
  private val io: ExecutorService = Executors.newSingleThreadExecutor()

  @Volatile private var active = false

  /** Ставить `MODE_IN_COMMUNICATION` на время звонка (см. «РЕЖИМ ЗВУКА»); по умолчанию `FORCE_COMM_MODE`, мост может включить. */
  @Volatile var commMode: Boolean = FORCE_COMM_MODE

  // Ниже — только поток io.
  private var choice: String? = null // явный выбор человека или подключённое устройство; null — по умолчанию
  private var base = EARPIECE // последний выбор из встроенных (куда вернуться, когда внешнее отключили)
  private var applied = EARPIECE // что включили мы (до API 31 — единственный источник правды: SCO подключается позже)
  private var externals: Set<String> = emptySet()
  private var prevSpeaker = false
  private var prevMode = AudioManager.MODE_NORMAL
  private var modeForced = false // режим поставили мы (в `stop` вернуть `prevMode`)
  private var lastApplyAt = 0L // elapsedRealtime последнего нашего `apply`: смена устройства приходит позже запроса
  private val reasserts = ArrayDeque<Long>() // времена переутверждений — предел против стычки с Chromium

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = devicesChanged()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = devicesChanged()
  }

  // Слушатели API 31+ живут в отдельном классе: на Android 7–11 интерфейсов `OnCommunicationDeviceChangedListener` /
  // `OnModeChangedListener` нет, и объект-лямбда прямо в полях CallAudio уронил бы создание активности (NoClassDefFoundError).
  @RequiresApi(Build.VERSION_CODES.S)
  private inner class Api31 {
    val commDeviceListener = AudioManager.OnCommunicationDeviceChangedListener { onCommDeviceChanged() }
    val modeListener = AudioManager.OnModeChangedListener { mode ->
      Log.i(TAG, "call audio: mode changed to $mode")
      if (mode == AudioManager.MODE_IN_COMMUNICATION || mode == AudioManager.MODE_IN_CALL) reroute()
    }
  }

  private var api31: Any? = null // Api31; тип скрыт, чтобы поле не тянуло класс на старых Android

  // Сверка выбора по таймеру: на io. Тип явный — `watchdog` ссылается на самого себя.
  private val checkTask: Runnable = Runnable { io.execute { guarded("timer") { verifyRoute("timer") } } }
  private val watchdog: Runnable = object : Runnable {
    override fun run() {
      if (!active) return
      io.execute { guarded("watchdog") { verifyRoute("watchdog") } }
      main.postDelayed(this, WATCHDOG_MS)
    }
  }

  /** Идёт ли звонок на нашей стороне (RaiseToEar в это время не трогает маршрут звука). */
  fun isActive(): Boolean = active

  /** Начало звонка (исходящего или принятого): запомнить прежнее, выбрать вывод. [video] — видеозвонок → громкий. */
  @Suppress("DEPRECATION")
  fun start(video: Boolean) {
    io.execute {
      try {
        if (active) return@execute
        active = true
        prevSpeaker = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) am.isSpeakerphoneOn else false
        prevMode = am.mode
        modeForced = commMode
        if (modeForced) am.mode = AudioManager.MODE_IN_COMMUNICATION
        base = if (video) SPEAKER else EARPIECE
        choice = null
        externals = externalKinds()
        am.registerAudioDeviceCallback(deviceCallback, main)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          val l = Api31()
          api31 = l
          am.addOnCommunicationDeviceChangedListener(io, l.commDeviceListener)
          am.addOnModeChangedListener(io, l.modeListener)
        }
        reroute()
        auditRoute("start")
        for (d in CHECK_DELAYS_MS) main.postDelayed(checkTask, d)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) main.postDelayed(watchdog, WATCHDOG_MS)
      } catch (e: RuntimeException) {
        Log.w(TAG, "call audio: start failed: $e")
      }
    }
  }

  /** Конец звонка: вернуть то, что было до него. */
  @Suppress("DEPRECATION")
  fun stop() {
    io.execute {
      try {
        if (!active) return@execute
        active = false
        main.removeCallbacks(checkTask)
        main.removeCallbacks(watchdog)
        am.unregisterAudioDeviceCallback(deviceCallback)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          (api31 as? Api31)?.let {
            am.removeOnCommunicationDeviceChangedListener(it.commDeviceListener)
            am.removeOnModeChangedListener(it.modeListener)
          }
          api31 = null
          am.clearCommunicationDevice()
        } else {
          if (am.isBluetoothScoOn) {
            am.isBluetoothScoOn = false
            am.stopBluetoothSco()
          }
          am.isSpeakerphoneOn = prevSpeaker
        }
        if (modeForced) am.mode = prevMode
        modeForced = false
        choice = null
        applied = EARPIECE
        reasserts.clear()
      } catch (e: RuntimeException) {
        Log.w(TAG, "call audio: stop failed: $e")
      }
    }
  }

  /** Человек выбрал вывод ([kind] — `earpiece` / `speaker` / `wired` / `bluetooth`). Недоступный вид молча игнорируется. */
  fun select(kind: String) {
    io.execute {
      try {
        if (!active || kind !in available()) return@execute
        choice = kind
        if (kind == EARPIECE || kind == SPEAKER) base = kind
        reasserts.clear() // явный выбор человека — счёт стычек с Chromium начинается заново
        reroute()
      } catch (e: RuntimeException) {
        Log.w(TAG, "call audio: select($kind) failed: $e")
      }
    }
  }

  /** Android 12+: подключена Bluetooth-гарнитура, а разрешения «Устройства поблизости» нет — без него нет имени гарнитуры. */
  fun needsBluetoothPermission(): Boolean = try {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      app.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED &&
      BLUETOOTH in available()
  } catch (e: RuntimeException) {
    false
  }

  /** JSON для клиента: `{"active":bool,"route":"speaker","devices":[{"kind":"earpiece"},{"kind":"bluetooth","name":"…"}]}`. */
  fun state(): String = try {
    val devs = JSONArray()
    val list = available()
    for (k in list) {
      val o = JSONObject().put("kind", k)
      if (k == BLUETOOTH) bluetoothName()?.let { o.put("name", it) }
      devs.put(o)
    }
    JSONObject().put("active", active).put("route", currentKind(list)).put("devices", devs).toString()
  } catch (e: RuntimeException) {
    Log.w(TAG, "call audio: state failed: $e")
    ""
  }

  // ─── Внутреннее (поток io) ────────────────────────────────────────────────────────────────────────────────────────

  private fun devicesChanged() {
    io.execute {
      try {
        if (!active) return@execute
        val now = externalKinds()
        val appeared = now - externals
        externals = now
        // Появилось внешнее — идём в него (как телефонное приложение); пропал выбранный вывод — к умолчанию.
        if (appeared.isNotEmpty()) choice = appeared.first() else if (choice != null && choice !in available()) choice = null
        reroute()
      } catch (e: RuntimeException) {
        Log.w(TAG, "call audio: devices changed failed: $e")
      }
    }
  }

  private fun guarded(what: String, block: () -> Unit) {
    try {
      block()
    } catch (e: RuntimeException) {
      Log.w(TAG, "call audio: $what failed: $e")
    }
  }

  /** Устройство связи поменялось (Android 12+, поток io): перебили не мы — поставить наш выбор заново; клиенту — перечитать. */
  private fun onCommDeviceChanged() {
    guarded("comm device changed") { verifyRoute("comm-listener") }
    notifyJs()
  }

  /** Что звучит на самом деле (для сверки с [want]); null — устройство связи не из наших видов (или не выбрано). */
  @Suppress("DEPRECATION")
  private fun actualKind(want: String): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return am.communicationDevice?.let { kindOf(it) }
    // Ниже API 31 вид «устройство связи» не читается: громкая связь — единственный признак; SCO подключается позже — не сверяем.
    return when {
      want == BLUETOOTH -> want
      am.isSpeakerphoneOn -> SPEAKER
      want == SPEAKER -> EARPIECE
      else -> want
    }
  }

  /**
   * Звук идёт не туда, куда выбрано (перебил Chromium или система) → поставить выбор заново. Свой запрос ещё может не
   * дойти (`setCommunicationDevice` асинхронный) — первые [APPLY_SETTLE_MS] после него не сверяем, а откладываем проверку.
   */
  private fun verifyRoute(why: String) {
    if (!active) return
    val want = target(available()) ?: return
    val now = SystemClock.elapsedRealtime()
    val have = actualKind(want)
    if (have == want) return
    if (now - lastApplyAt < APPLY_SETTLE_MS) {
      main.postDelayed(checkTask, APPLY_SETTLE_MS)
      return
    }
    while (reasserts.isNotEmpty() && now - reasserts.first() > REASSERT_WINDOW_MS) reasserts.removeFirst()
    Log.i(TAG, "call audio: $why: route overridden (mode=${am.mode} want=$want have=$have), reasserts=${reasserts.size}")
    if (reasserts.size >= REASSERT_MAX) {
      if (reasserts.size == REASSERT_MAX) {
        reasserts.addLast(now) // запись об отказе — в журнал один раз за окно
        Log.w(TAG, "call audio: giving up re-asserting $want for a while: something keeps overriding it")
      }
      return
    }
    reasserts.addLast(now)
    apply(want)
    notifyJs()
  }

  /** Строка в журнал для разбора на устройстве: `adb logcat -s GusVoice`, искать `call audio`. */
  @Suppress("DEPRECATION")
  private fun auditRoute(why: String) {
    val comm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.communicationDevice?.let { "${it.type}/${kindOf(it)}" } else "n/a"
    Log.i(TAG, "call audio: $why mode=${am.mode} comm=$comm speakerphone=${am.isSpeakerphoneOn} choice=$choice applied=$applied")
  }

  private fun target(avail: List<String>): String? {
    val c = choice
    return when {
      c != null && c in avail -> c
      BLUETOOTH in avail -> BLUETOOTH
      WIRED in avail -> WIRED
      base in avail -> base
      SPEAKER in avail -> SPEAKER
      else -> avail.firstOrNull()
    }
  }

  private fun reroute() {
    if (!active) return
    val kind = target(available())
    if (kind != null) apply(kind)
    notifyJs()
  }

  @Suppress("DEPRECATION")
  private fun apply(kind: String) {
    applied = kind
    lastApplyAt = SystemClock.elapsedRealtime()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val dev = am.availableCommunicationDevices.firstOrNull { kindOf(it) == kind } ?: return
      if (!am.setCommunicationDevice(dev)) Log.w(TAG, "call audio: setCommunicationDevice($kind) refused")
      return
    }
    if (kind == BLUETOOTH) {
      am.isSpeakerphoneOn = false
      am.startBluetoothSco()
      am.isBluetoothScoOn = true
    } else {
      if (am.isBluetoothScoOn) {
        am.isBluetoothScoOn = false
        am.stopBluetoothSco()
      }
      am.isSpeakerphoneOn = kind == SPEAKER
    }
  }

  private fun notifyJs() {
    main.post { changed() }
  }

  /** Доступные виды вывода в порядке показа: у уха, громкий, проводные, Bluetooth. */
  private fun available(): List<String> {
    val kinds = HashSet<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      for (d in am.availableCommunicationDevices) kindOf(d)?.let { kinds.add(it) }
    } else {
      for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) kindOf(d)?.let { kinds.add(it) }
    }
    return ORDER.filter { it in kinds }
  }

  private fun externalKinds(): Set<String> = available().filter { it == WIRED || it == BLUETOOTH }.toSet()

  @Suppress("DEPRECATION")
  private fun currentKind(avail: List<String>): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      am.communicationDevice?.let { d -> kindOf(d)?.let { return it } }
    }
    return if (active) applied else if (am.isSpeakerphoneOn) SPEAKER else avail.firstOrNull() ?: EARPIECE
  }

  private fun bluetoothName(): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      app.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
    ) return null
    val devices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.availableCommunicationDevices else am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    val name = devices.firstOrNull { kindOf(it) == BLUETOOTH }?.productName?.toString()?.trim()
    return if (name.isNullOrEmpty()) null else name
  }

  /** Вид вывода у [d]; null — тип нам не нужен (A2DP-музыка, HDMI, телефония и т. п.). */
  private fun kindOf(d: AudioDeviceInfo): String? {
    val sdk = Build.VERSION.SDK_INT
    return when (d.type) {
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> EARPIECE
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> SPEAKER
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> WIRED
      AudioDeviceInfo.TYPE_USB_HEADSET -> if (sdk >= Build.VERSION_CODES.O) WIRED else null
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> BLUETOOTH
      // До API 31 гарнитура с HFP видна как A2DP-выход (SCO появляется, когда звук уже идёт) — это признак «гарнитура есть».
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> if (sdk < Build.VERSION_CODES.S) BLUETOOTH else null
      AudioDeviceInfo.TYPE_HEARING_AID -> if (sdk >= Build.VERSION_CODES.P) BLUETOOTH else null
      AudioDeviceInfo.TYPE_BLE_HEADSET -> if (sdk >= Build.VERSION_CODES.S) BLUETOOTH else null
      else -> null
    }
  }

  companion object {
    private const val TAG = "GusVoice"
    const val EARPIECE = "earpiece"
    const val SPEAKER = "speaker"
    const val WIRED = "wired"
    const val BLUETOOTH = "bluetooth"
    private val ORDER = listOf(EARPIECE, SPEAKER, WIRED, BLUETOOTH)

    /** См. «РЕЖИМ ЗВУКА» в описании класса: по умолчанию режим звука не трогаем. */
    private const val FORCE_COMM_MODE = false

    private val CHECK_DELAYS_MS = longArrayOf(500L, 1500L, 3500L) // сверка выбора после `start` (Chromium перебивает через ~0,4 с)
    private const val WATCHDOG_MS = 2000L // ниже API 31 слушателя смены устройства нет — сверяем по таймеру
    private const val APPLY_SETTLE_MS = 400L // сколько после своего `apply` не считать расхождение чужой правкой
    private const val REASSERT_MAX = 4 // не больше стольких переутверждений…
    private const val REASSERT_WINDOW_MS = 5000L // …за столько мс: дальше стычка с Chromium, сдаёмся
  }
}
