package tech.gusik.gusvoice

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * «Поднести к уху» (G67, 14.10, #218): пока в ленте ЛС играет голосовое и телефон поднесли к уху (датчик приближения), звук идёт в
 * разговорный динамик, экран гаснет (`PROXIMITY_SCREEN_OFF_WAKE_LOCK`); отвели — обратно на громкий, играет дальше без перезапуска.
 * Мост для веба — `NativeBridge.raiseToEar*` в MainActivity, клиент — `nativeRaiseToEar.ts` (включает слушание, только пока играет
 * голосовое и настройка «Поднести к уху» включена).
 *
 * Telegram Android: `MediaController.onSensorChanged` (датчик приближения, `isNearToSensor`: значение < 5 и не равно максимуму
 * диапазона), ветка «start listen» → `setUseFrontSpeaker(true)` (громкая связь выкл., SCO выкл.), «stop listen» →
 * `setUseFrontSpeaker(false)`; `forbidRaiseToListen` (гарнитура — не трогаем), `VoIPService.isAnyKindOfCallActive` (идёт звонок —
 * не трогаем), `proximityWakeLock` = `PROXIMITY_SCREEN_OFF_WAKE_LOCK`. Жест «подняли» у Telegram — разбор линейного ускорения
 * (`raisedToTop`/`raisedToBack`); у нас упрощённо: положение корпуса по акселерометру (вертикально, экраном к голове) — телефон,
 * лежащий экраном вниз/вверх на столе, не переключается (`RAISED_Z_MAX`, `RAISED_Y_MIN`; пороги проверить на устройстве).
 * Отличие от Telegram (по заданию): отвели от уха — голосовое НЕ ставится на паузу, а играет дальше на громком.
 *
 * 🔴 Звук голосового в WebView — `<audio>`, поток USAGE_MEDIA: выбор устройства СВЯЗИ его может не затронуть (см. `CallAudio.kt`).
 * Поэтому у уха, как у любой VoIP-программы, ставим `MODE_IN_COMMUNICATION` + разговорный динамик (`setCommunicationDevice` /
 * `setSpeakerphoneOn(false)`) и возвращаем всё как было. Микрофон при этом не включается (запись по поднесению не делаем),
 * поэтому «всплеск и тишина» Samsung (аппаратный ECNS записи) не при чём. Сработает ли такой маршрут для USAGE_MEDIA на конкретном
 * телефоне, проверяется на слух (чек-лист в отчёте); если нет — экран гаснет, а звук остаётся громким.
 *
 * Потоки: датчики и состояние — главный поток (слушатель зарегистрирован с `main`); изменение звука — один поток `io`
 * (`setSpeakerphoneOn` на Samsung медленный). Включать/выключать можно с любого потока.
 */
class RaiseToEar(private val ctx: Context, private val callBusy: () -> Boolean) : SensorEventListener {
  // Всё через lazy: в конструкторе Activity контекст ещё не привязан.
  private val app: Context by lazy { ctx.applicationContext }
  private val sensors: SensorManager by lazy { app.getSystemService(Context.SENSOR_SERVICE) as SensorManager }
  private val am: AudioManager by lazy { app.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private val proximity: Sensor? by lazy { sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY) }
  private val accelerometer: Sensor? by lazy { sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) }
  private val wakeLock: PowerManager.WakeLock? by lazy {
    val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
      pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "gusvoice:raise-to-ear").apply { setReferenceCounted(false) }
    } else {
      null
    }
  }
  private val main = Handler(Looper.getMainLooper())
  private val io: ExecutorService = Executors.newSingleThreadExecutor()

  // Главный поток.
  private var enabled = false
  private var near = false
  private var front = false // звук сейчас у уха (по нашему решению)
  private var accelY = 0f
  private var accelZ = 0f
  private var accelAt = 0L

  // Поток io.
  private var routed = false
  private var prevMode = AudioManager.MODE_NORMAL
  private var prevSpeaker = false

  /** Есть датчик приближения (на планшете без него — настройку и слушание не предлагаем). */
  fun supported(): Boolean = try {
    proximity != null
  } catch (e: RuntimeException) {
    false
  }

  /** Слушать датчик (голосовое играет и настройка включена) или перестать. Любой поток. */
  fun enable(on: Boolean) {
    main.post { guarded("enable") { setEnabled(on) } }
  }

  /** Закрытие активности (главный поток): снять всё, остановить `io`. */
  fun shutdown() {
    guarded("shutdown") { setEnabled(false) }
    io.shutdown()
  }

  private fun setEnabled(on: Boolean) {
    if (on == enabled) return
    enabled = on
    if (on) {
      val p = proximity ?: return
      sensors.registerListener(this, p, SensorManager.SENSOR_DELAY_NORMAL, main)
      accelerometer?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, main) }
    } else {
      sensors.unregisterListener(this)
      near = false
      accelAt = 0L
      if (front) leaveFront("disabled")
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  override fun onSensorChanged(event: SensorEvent) {
    guarded("sensor") {
      when (event.sensor.type) {
        Sensor.TYPE_PROXIMITY -> {
          val v = event.values[0]
          near = v < NEAR_CM && v != event.sensor.maximumRange // Telegram `isNearToSensor`
          evaluate()
        }
        Sensor.TYPE_ACCELEROMETER -> {
          accelY = event.values[1]
          accelZ = event.values[2]
          accelAt = SystemClock.elapsedRealtime()
        }
      }
    }
  }

  private fun evaluate() {
    if (!enabled) return
    if (front) {
      if (!near || callBusy()) leaveFront(if (near) "call" else "away")
    } else if (near && raisedPose() && !callBusy() && !phoneCallActive() && !headsetPresent()) {
      enterFront()
    }
  }

  /** Корпус вертикально, экраном к голове; нет данных акселерометра — считаем, что да (как Telegram без датчиков жеста). */
  private fun raisedPose(): Boolean {
    if (accelerometer == null || accelAt == 0L || SystemClock.elapsedRealtime() - accelAt > ACCEL_FRESH_MS) return true
    return abs(accelZ) < RAISED_Z_MAX && accelY > RAISED_Y_MIN
  }

  private fun phoneCallActive(): Boolean = am.mode == AudioManager.MODE_IN_CALL || am.mode == AudioManager.MODE_RINGTONE

  /** Проводные / Bluetooth-наушники подключены — у уха ничего переключать не надо (Telegram `forbidRaiseToListen`). */
  private fun headsetPresent(): Boolean {
    val sdk = Build.VERSION.SDK_INT
    for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
      when (d.type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> return true
        AudioDeviceInfo.TYPE_USB_HEADSET -> if (sdk >= Build.VERSION_CODES.O) return true
        AudioDeviceInfo.TYPE_HEARING_AID -> if (sdk >= Build.VERSION_CODES.P) return true
        AudioDeviceInfo.TYPE_BLE_HEADSET -> if (sdk >= Build.VERSION_CODES.S) return true
        else -> {}
      }
    }
    return false
  }

  private fun enterFront() {
    front = true
    Log.i(TAG, "raise to ear: near, switching to earpiece")
    setLock(true)
    io.execute { guarded("route to ear") { routeToEar() } }
  }

  private fun leaveFront(why: String) {
    front = false
    Log.i(TAG, "raise to ear: back to speaker ($why)")
    setLock(false)
    io.execute { guarded("route back") { routeBack() } }
  }

  private fun setLock(on: Boolean) {
    val l = wakeLock ?: return
    if (on && !l.isHeld) l.acquire(LOCK_MAX_MS) else if (!on && l.isHeld) l.release()
  }

  @Suppress("DEPRECATION")
  private fun routeToEar() {
    if (routed || callBusy()) return
    prevMode = am.mode
    prevSpeaker = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) am.isSpeakerphoneOn else false
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val ear = am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
      if (ear == null || !am.setCommunicationDevice(ear)) Log.w(TAG, "raise to ear: setCommunicationDevice(earpiece) refused")
    } else {
      am.isSpeakerphoneOn = false
    }
    routed = true
    Log.i(TAG, "raise to ear: routed mode=${am.mode}")
  }

  @Suppress("DEPRECATION")
  private fun routeBack() {
    if (!routed) return
    routed = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice() else am.isSpeakerphoneOn = prevSpeaker
    if (am.mode == AudioManager.MODE_IN_COMMUNICATION) am.mode = prevMode // режим уже чужой (начался звонок) — не трогаем
  }

  private fun guarded(what: String, block: () -> Unit) {
    try {
      block()
    } catch (e: RuntimeException) {
      Log.w(TAG, "raise to ear: $what failed: $e")
    }
  }

  companion object {
    private const val TAG = "GusVoice"

    /** Telegram `isNearToSensor`: расстояние меньше 5 см (и не «максимум» — так датчик говорит «далеко»). */
    private const val NEAR_CM = 5.0f

    /** Положение «у уха»: ось Z (из экрана) почти горизонтальна, верх телефона выше низа. Проверить на устройстве. */
    private const val RAISED_Z_MAX = 6.5f
    private const val RAISED_Y_MIN = 2.0f
    private const val ACCEL_FRESH_MS = 2000L

    /** Предел держания замка датчика: голосовое длится минуты, страховка от забытого замка. */
    private const val LOCK_MAX_MS = 30L * 60L * 1000L
  }
}
