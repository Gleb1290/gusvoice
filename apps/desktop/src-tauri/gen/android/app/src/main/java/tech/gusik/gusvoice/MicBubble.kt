package tech.gusik.gusvoice

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Point
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import androidx.core.content.ContextCompat
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Пузырь микрофона поверх других приложений (#156, порция 2): круглая кнопка поверх игр, пока идёт голос и GusVoice
 * не на экране. Живёт внутри [VoiceForegroundService] (служба знает состояние от страницы и живёт ровно столько, сколько
 * голос); действия уходят странице тем же путём, что кнопки уведомления (`MainActivity.sendMicAction` →
 * `window.__gvMicAction`, `nativeMicActions.ts`).
 *
 *   - тап — `toggle-mute`; с рацией (и микрофон не выключен) — держишь = говоришь: `ptt-down` на касание, `ptt-up` на
 *     отпускание/отмену (задержку отпускания даёт клиент); мьют и «Не слышу» сильнее рации — тогда тап снимает мьют;
 *   - сдвиг дальше `touchSlop` — уже перетаскивание (рация отпускается), снизу по центру появляется крестик; бросил на
 *     него — пузырь спрятан до следующего входа в голос или до включения в настройках; бросил мимо — прилипает к
 *     ближнему краю (как плавающее окно звонка Telegram Android), место — доли экрана в prefs (переживает поворот);
 *   - цвет = состояние: мьют/«Не слышу» — красный с перечёркнутым микрофоном, включён — тёмный нейтральный, говоришь —
 *     зелёная обводка; рация не зажата — серый, зажата — зелёный. Цвета — токены клиента (`styles.css`: `--bg-3`,
 *     `--danger`, `--green`, `--muted-2`, `--text`).
 *
 * Всё — на главном потоке. Разрешение «Показ поверх других приложений» могут отозвать на ходу: `addView`/`removeView`
 * в try/catch, а [canDraw] проверяется при каждой синхронизации.
 */
class MicBubble(private val ctx: Context, private val onAction: (String) -> Unit) {
  /** Что рисовать: последнее состояние от страницы. */
  class Look(val muted: Boolean, val deafened: Boolean, val ptt: Boolean, val speaking: Boolean, val pttReleaseMs: Int = 0)

  private val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private val density get() = ctx.resources.displayMetrics.density
  private val sizePx get() = (SIZE_DP * density).roundToInt()
  private val trashPx get() = (TRASH_DP * density).roundToInt()
  private val slop = ViewConfiguration.get(ctx).scaledTouchSlop

  private var look = Look(muted = false, deafened = false, ptt = false, speaking = false)
  private var view: BubbleView? = null
  private var params: WindowManager.LayoutParams? = null
  private var trash: TrashView? = null
  private var trashParams: WindowManager.LayoutParams? = null
  private var snap: ValueAnimator? = null

  // Касание: откуда начали, тащим ли, держим ли рацию.
  private var downX = 0f
  private var downY = 0f
  private var startX = 0
  private var startY = 0
  private var dragging = false
  private var holding = false

  /**
   * 🔴 Задержку отпускания рации (`pttReleaseMs` из настроек) отсчитываем ЗДЕСЬ, а странице шлём `ptt-up` уже по её
   * истечении — страница закрывает микрофон сразу. Свой `setTimeout` страницы у свёрнутого приложения не срабатывает
   * (таймеры WebView стоят), и микрофон висел открытым до возврата в приложение (приёмка на S20, 17.10).
   * Нажал снова до истечения — отложенное отпускание отменяется, страница так и не отпускала.
   */
  private val main = Handler(Looper.getMainLooper())
  private var pendingUp: Runnable? = null

  /** Новое состояние (null — не в голосе) или смена условий показа: показать, перерисовать или снять. */
  fun sync(next: Look?) {
    if (next != null) look = next
    val show = shouldShow(next != null, isEnabled(ctx), isHidden(ctx), canDraw(ctx), appForeground)
    if (!show) {
      remove()
      return
    }
    val v = view
    if (v == null) attach() else v.invalidate()
  }

  /** Поворот, смена размера экрана: вернуть пузырь на сохранённое место в долях нового экрана. */
  fun onScreenChanged() {
    val v = view ?: return
    val p = params ?: return
    if (dragging) return
    snap?.cancel()
    placeFromPrefs(p)
    relayout(v, p)
    val t = trash
    val tp = trashParams
    if (t != null && tp != null) {
      placeTrash(tp)
      relayout(t, tp)
    }
  }

  /** Снять пузырь (служба гаснет, вышли из голоса, приложение на экране, разрешение отозвали). */
  fun remove() {
    releasePtt(now = true)
    removeTrash()
    snap?.cancel()
    snap = null
    dragging = false
    val v = view ?: return
    view = null
    params = null
    try {
      wm.removeView(v)
    } catch (e: RuntimeException) {
      Log.w(TAG, "mic bubble: removeView failed: $e")
    }
  }

  private fun attach() {
    val p = WindowManager.LayoutParams(
      sizePx,
      sizePx,
      overlayType(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }
    placeFromPrefs(p)
    addTrash()
    val v = BubbleView()
    try {
      wm.addView(v, p)
    } catch (e: RuntimeException) {
      // BadTokenException / SecurityException: разрешение отозвали между проверкой и показом.
      Log.w(TAG, "mic bubble: addView failed: $e")
      removeTrash()
      return
    }
    view = v
    params = p
  }

  @SuppressLint("ClickableViewAccessibility")
  private inner class BubbleView : View(ctx) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = EDGE }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = GREEN }
    private val micOn: Drawable? = ContextCompat.getDrawable(ctx, R.drawable.ic_stat_mic)?.mutate()
    private val micOff: Drawable? = ContextCompat.getDrawable(ctx, R.drawable.ic_stat_mic_off)?.mutate()

    init {
      setOnTouchListener { _, e -> onTouch(e) }
    }

    override fun onDraw(c: Canvas) {
      super.onDraw(c)
      val d = density
      val r = width / 2f
      val off = look.muted || look.deafened
      fill.color = when {
        off -> DANGER
        look.ptt && holding -> GREEN
        look.ptt -> GREY
        else -> NEUTRAL
      }
      c.drawCircle(r, r, r - 3 * d, fill)
      edge.strokeWidth = d
      c.drawCircle(r, r, r - 3 * d, edge)
      if (look.speaking && !off && !(look.ptt && holding)) {
        ring.strokeWidth = 3 * d
        c.drawCircle(r, r, r - 1.5f * d, ring)
      }
      val g = (if (off) micOff else micOn) ?: return
      val gs = (26 * d).roundToInt()
      val l = (width - gs) / 2
      g.setBounds(l, l, l + gs, l + gs)
      g.setTint(GLYPH)
      g.draw(c)
      contentDescription = when {
        off -> "Микрофон выключен"
        look.ptt -> "Рация: держите, чтобы говорить"
        else -> "Микрофон включён"
      }
    }
  }

  /** Крестик снизу по центру — виден, пока пузырь тащат. Касаний не принимает. */
  private inner class TrashView : View(ctx) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val glyph: Drawable? = ContextCompat.getDrawable(ctx, R.drawable.ic_bubble_close)?.mutate()
    var hot = false
      set(value) {
        if (field == value) return
        field = value
        if (value) performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        invalidate()
      }

    override fun onDraw(c: Canvas) {
      super.onDraw(c)
      val r = width / 2f
      fill.color = if (hot) DANGER else TRASH
      c.drawCircle(r, r, if (hot) r else r * 0.85f, fill)
      val g = glyph ?: return
      val gs = (26 * density).roundToInt()
      val l = (width - gs) / 2
      g.setBounds(l, l, l + gs, l + gs)
      g.setTint(GLYPH)
      g.draw(c)
    }
  }

  private fun onTouch(e: MotionEvent): Boolean {
    val v = view ?: return false
    val p = params ?: return false
    when (e.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        snap?.cancel()
        downX = e.rawX
        downY = e.rawY
        startX = p.x
        startY = p.y
        dragging = false
        // Рация — только когда микрофон не выключен: мьют и «Не слышу» сильнее (`micActionRules.pttCanOpen`).
        if (look.ptt && !look.muted && !look.deafened) {
          holding = true
          v.invalidate()
          val pending = pendingUp
          if (pending != null) {
            main.removeCallbacks(pending)
            pendingUp = null
          } else {
            onAction("ptt-down")
          }
        }
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = e.rawX - downX
        val dy = e.rawY - downY
        if (!dragging && hypot(dx, dy) > slop) {
          dragging = true
          releasePtt()
          showTrash()
        }
        if (dragging) {
          val s = screen()
          p.x = (startX + dx).roundToInt().coerceIn(0, maxOf(0, s.x - sizePx))
          p.y = (startY + dy).roundToInt().coerceIn(0, maxOf(0, s.y - sizePx))
          relayout(v, p)
          trash?.hot = overTrash(p)
        }
      }
      MotionEvent.ACTION_UP -> {
        when {
          dragging -> finishDrag(p, drop = true)
          holding -> releasePtt()
          else -> {
            v.performClick()
            onAction("toggle-mute")
          }
        }
      }
      MotionEvent.ACTION_CANCEL -> {
        releasePtt()
        if (dragging) finishDrag(p, drop = false)
      }
    }
    return true
  }

  private fun releasePtt(now: Boolean = false) {
    if (holding) {
      holding = false
      view?.invalidate()
      val delay = look.pttReleaseMs.coerceIn(0, 5000)
      if (now || delay == 0) {
        onAction("ptt-up")
      } else {
        val r = Runnable {
          pendingUp = null
          onAction("ptt-up")
        }
        pendingUp = r
        main.postDelayed(r, delay.toLong())
      }
      return
    }
    // Пузырь снимают посреди хвоста отпускания — отпустить сейчас, а не по таймеру уже снятого пузыря.
    if (now) {
      val pending = pendingUp ?: return
      main.removeCallbacks(pending)
      pendingUp = null
      onAction("ptt-up")
    }
  }

  private fun finishDrag(p: WindowManager.LayoutParams, drop: Boolean) {
    dragging = false
    val onTrash = drop && overTrash(p)
    hideTrash()
    if (onTrash) {
      view?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      setHidden(ctx, true)
      remove()
      return
    }
    // Прилипнуть к ближнему краю по горизонтали; место — в доли экрана.
    val s = screen()
    val maxX = maxOf(0, s.x - sizePx)
    val maxY = maxOf(0, s.y - sizePx)
    val toX = if (p.x + sizePx / 2 < s.x / 2) 0 else maxX
    savePlace(ctx, if (maxX == 0) 1f else toX.toFloat() / maxX, if (maxY == 0) 0f else p.y.toFloat() / maxY)
    val v = view ?: return
    snap = ValueAnimator.ofInt(p.x, toX).apply {
      duration = SNAP_MS
      addUpdateListener {
        if (view !== v) return@addUpdateListener
        p.x = it.animatedValue as Int
        relayout(v, p)
      }
      start()
    }
  }

  private fun overTrash(p: WindowManager.LayoutParams): Boolean {
    val s = screen()
    val tx = s.x / 2f
    val ty = s.y - (TRASH_BOTTOM_DP * density) - trashPx / 2f
    return hypot(p.x + sizePx / 2f - tx, p.y + sizePx / 2f - ty) < trashPx
  }

  /**
   * Окно крестика добавляется ДО окна пузыря (из окон одного типа выше то, что добавлено позже) и до перетаскивания
   * невидимо: снять и вернуть пузырь посреди касания нельзя — касание оборвётся. Прозрачность окна 0.8 — потолок, при
   * котором Android 12+ пропускает касания сквозь чужое окно к приложению под ним (untrusted touch occlusion).
   */
  private fun addTrash() {
    if (trash != null) return
    val tp = WindowManager.LayoutParams(
      trashPx,
      trashPx,
      overlayType(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      alpha = 0.8f
    }
    placeTrash(tp)
    val t = TrashView()
    t.visibility = View.INVISIBLE
    try {
      wm.addView(t, tp)
    } catch (e: RuntimeException) {
      Log.w(TAG, "mic bubble: trash failed: $e")
      return
    }
    trash = t
    trashParams = tp
  }

  private fun placeTrash(tp: WindowManager.LayoutParams) {
    val s = screen()
    tp.x = (s.x - trashPx) / 2
    tp.y = s.y - trashPx - (TRASH_BOTTOM_DP * density).roundToInt()
  }

  private fun showTrash() {
    val t = trash ?: return
    val tp = trashParams ?: return
    placeTrash(tp)
    relayout(t, tp)
    t.hot = false
    t.visibility = View.VISIBLE
  }

  private fun hideTrash() {
    val t = trash ?: return
    t.hot = false
    t.visibility = View.INVISIBLE
  }

  private fun removeTrash() {
    val t = trash ?: return
    trash = null
    trashParams = null
    try {
      wm.removeView(t)
    } catch (e: RuntimeException) {
      Log.w(TAG, "mic bubble: trash remove failed: $e")
    }
  }

  private fun relayout(v: View, p: WindowManager.LayoutParams) {
    try {
      wm.updateViewLayout(v, p)
    } catch (e: RuntimeException) {
      Log.w(TAG, "mic bubble: updateViewLayout failed: $e")
    }
  }

  private fun placeFromPrefs(p: WindowManager.LayoutParams) {
    val s = screen()
    val prefs = prefs(ctx)
    val fx = prefs.getFloat(KEY_X, DEFAULT_X).coerceIn(0f, 1f)
    val fy = prefs.getFloat(KEY_Y, DEFAULT_Y).coerceIn(0f, 1f)
    p.x = (fx * maxOf(0, s.x - sizePx)).roundToInt()
    p.y = (fy * maxOf(0, s.y - sizePx)).roundToInt()
  }

  /** Полный размер экрана в пикселях (окно пузыря — `LAYOUT_IN_SCREEN`, координаты от угла экрана). */
  private fun screen(): Point =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val b = wm.currentWindowMetrics.bounds
      Point(b.width(), b.height())
    } else {
      val m = DisplayMetrics()
      @Suppress("DEPRECATION")
      wm.defaultDisplay.getRealMetrics(m)
      Point(m.widthPixels, m.heightPixels)
    }

  companion object {
    private const val TAG = "GusVoice"
    const val SIZE_DP = 56
    private const val TRASH_DP = 64
    private const val TRASH_BOTTOM_DP = 64
    private const val SNAP_MS = 200L
    private const val DEFAULT_X = 1f // у правого края
    private const val DEFAULT_Y = 0.3f

    private const val PREFS = "gusvoice_mic_bubble"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_HIDDEN = "hidden"
    private const val KEY_X = "x"
    private const val KEY_Y = "y"

    // Токены клиента (`styles.css`, тёмная тема): --bg-3, --muted-2, --danger, --green, --text; обводка — белый 20 %.
    private const val NEUTRAL = 0xFF2C2A33.toInt()
    private const val GREY = 0xFF8A8697.toInt()
    private const val DANGER = 0xFFE0574E.toInt()
    private const val GREEN = 0xFF3FB97A.toInt()
    private const val GLYPH = 0xFFECE9F0.toInt()
    private const val EDGE = 0x33FFFFFF
    private const val TRASH = 0xB3000000.toInt()

    /**
     * GusVoice на экране: пузырь не нужен. Ставит `MainActivity.onResume`/`onPause` (главный поток) через
     * [VoiceForegroundService.setAppForeground].
     */
    @Volatile var appForeground = false

    /** Показывать ли пузырь: чистое правило. */
    fun shouldShow(inVoice: Boolean, enabled: Boolean, hidden: Boolean, canDraw: Boolean, appForeground: Boolean): Boolean =
      inVoice && enabled && !hidden && canDraw && !appForeground

    /** «Показ поверх других приложений» выдан (до Android 6 — всегда). */
    fun canDraw(ctx: Context): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_ENABLED, false)

    fun isHidden(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_HIDDEN, false)

    /** Тумблер в настройках (мост `micBubbleSet`). Включили заново — пузырь, спрятанный крестиком, возвращается. */
    fun setEnabled(ctx: Context, on: Boolean) {
      val p = prefs(ctx)
      val was = p.getBoolean(KEY_ENABLED, false)
      val e = p.edit().putBoolean(KEY_ENABLED, on)
      if (on && !was) e.putBoolean(KEY_HIDDEN, false)
      e.apply()
    }

    /** Спрятан крестиком; снимается при следующем входе в голос ([VoiceForegroundService.updateMicState]). */
    fun setHidden(ctx: Context, hidden: Boolean) {
      prefs(ctx).edit().putBoolean(KEY_HIDDEN, hidden).apply()
    }

    private fun savePlace(ctx: Context, fx: Float, fy: Float) {
      prefs(ctx).edit().putFloat(KEY_X, fx).putFloat(KEY_Y, fy).apply()
    }

    @Suppress("DEPRECATION")
    private fun overlayType(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      else WindowManager.LayoutParams.TYPE_PHONE
  }
}
