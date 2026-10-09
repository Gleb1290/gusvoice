package tech.gusik.gusvoice

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Полноэкранный «Входящий звонок» (09.10, #211, G73) — его запускает `fullScreenIntent` уведомления [CallNotifier], когда
 * экран выключен или заблокирован; тап по всплывающему уведомлению открывает его же. Как у Telegram (`VoIPFragment` /
 * `LaunchActivity` с `showWhenLocked` + `turnScreenOn`, код не копировался): аватар, имя, «Входящий звонок», внизу две
 * круглые кнопки — «Отклонить» (красная) и «Ответить» (зелёная). Вид — как телефонный экран входящего в самом клиенте
 * (`CallLayer.tsx`, `.call-scrim.phone`): фон `--bg`, аватар 128 в верхней трети, имя 20/600, статус 14 `--muted`,
 * кнопки 68 с подписью 13.
 *
 * Своя нативная активити, а не WebView: показ поверх блокировки не открывает само приложение. «Ответить» сперва просит
 * снять блокировку (`requestDismissKeyguard`), потом открывает приложение — звонок принимает клиент (`call:` ссылка,
 * `nativeUnifiedPush.navigateDeepLink`). «Отклонить» — без открытия приложения ([CallActionReceiver]).
 */
class IncomingCallActivity : Activity() {
  private var callId = ""
  private val handler = Handler(Looper.getMainLooper())
  private val gone: (String) -> Unit = { id -> if (id == callId) finish() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    showOverLock()
    if (!bind(intent)) return
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    bind(intent)
  }

  override fun onDestroy() {
    if (CallNotifier.onGone === gone) CallNotifier.onGone = null
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  /** Звонок из интента ещё звонит — построить экран; нет (сняли, вышел срок, открыли из «Недавних») — закрыться. */
  private fun bind(intent: Intent?): Boolean {
    val id = intent?.getStringExtra(CallNotifier.EXTRA_CALL).orEmpty()
    val call = CallNotifier.current(this)?.takeIf { it.callId == id }
    if (call == null) {
      finish()
      return false
    }
    callId = call.callId
    CallNotifier.onGone = gone
    handler.removeCallbacksAndMessages(null)
    handler.postDelayed({ finish() }, (call.until - System.currentTimeMillis()).coerceAtLeast(0L))
    setContentView(build(call))
    return true
  }

  private fun showOverLock() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    window.statusBarColor = BG
    window.navigationBarColor = BG
  }

  private fun answer(call: CallNotifier.Call) {
    val open = {
      startActivity(CallNotifier.answerIntent(this, call))
      CallNotifier.dismiss(this, call.callId)
      finish()
    }
    val km = getSystemService(KEYGUARD_SERVICE) as? KeyguardManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km?.isKeyguardLocked == true) {
      // Отменил разблокировку — экран входящего остаётся, звонок звонит дальше.
      km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = open()
      })
    } else {
      open()
    }
  }

  private fun decline(call: CallNotifier.Call) {
    sendBroadcast(
      Intent(this, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_DECLINE)
        .putExtra(CallNotifier.EXTRA_CALL, call.callId).putExtra(ConversationNotifier.EXTRA_UID, call.uid),
    )
    finish()
  }

  private fun build(call: CallNotifier.Call): View {
    val root = FrameLayout(this).apply { setBackgroundColor(BG) }
    val body = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(16), 0, dp(16), 0)
    }
    val avatar = ImageView(this).apply {
      setImageBitmap(CallNotifier.avatarBitmap(this@IncomingCallActivity, call))
      scaleType = ImageView.ScaleType.CENTER_CROP
    }
    body.addView(avatar, LinearLayout.LayoutParams(dp(128), dp(128)).apply { topMargin = (resources.displayMetrics.heightPixels * 0.14f).toInt() })
    body.addView(text(call.name, 20f, TEXT, bold = true), wrap().apply { topMargin = dp(16) })
    body.addView(text(call.status, 14f, MUTED), wrap().apply { topMargin = dp(4) })
    root.addView(body, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))

    // Кнопки по краям экрана, как у Telegram (`AcceptDeclineView`: кнопка 60, отступ от края 46 + поля 27, весь блок
    // увеличен в 1.15 раза → ~68 и ~53 от края; подпись 11 → ~13 на 4 ниже кнопки). Зелёная «Ответить» слева, красная
    // «Отклонить» справа — как там (флаг ANSWER_LEFT). Низ — над системной панелью (вставки ниже).
    val answerLeft = ANSWER_LEFT
    val declineBtn = round(R.drawable.ic_call_end, DANGER, "Отклонить") { decline(call) }
    val answerBtn = round(R.drawable.ic_stat_call, GREEN, "Ответить") { answer(call) }
    val edge = dp(EDGE_DP)
    val bottom = dp(BOTTOM_DP)
    root.addView(
      if (answerLeft) answerBtn else declineBtn,
      FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START)
        .apply { leftMargin = edge; bottomMargin = bottom },
    )
    root.addView(
      if (answerLeft) declineBtn else answerBtn,
      FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END)
        .apply { rightMargin = edge; bottomMargin = bottom },
    )
    // targetSdk 36: с Android 15 окно рисуется под системными панелями — отступаем на их размер.
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, ins ->
      val bars = ins.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    return root
  }

  private fun round(icon: Int, color: Int, label: String, onClick: () -> Unit): View {
    val col = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
    }
    val btn = ImageButton(this).apply {
      setImageResource(icon)
      setColorFilter(Color.WHITE)
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
      }
      contentDescription = label
      // Значок 28 в кнопке 60 у Telegram → ~32 в 68.
      setPadding(dp(18), dp(18), dp(18), dp(18))
      scaleType = ImageView.ScaleType.FIT_CENTER
      setOnClickListener { onClick() }
    }
    col.addView(btn, LinearLayout.LayoutParams(dp(BTN_DP), dp(BTN_DP)))
    col.addView(text(label, 13f, MUTED), wrap().apply { topMargin = dp(5) })
    return col
  }

  private fun text(s: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
    text = s
    setTextColor(color)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    gravity = Gravity.CENTER
    if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  private fun wrap() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  private companion object {
    // Токены тёмной темы клиента (`styles.css`): --bg, --text, --muted, --danger, --green.
    const val ANSWER_LEFT = true
    const val BTN_DP = 68
    const val EDGE_DP = 53
    const val BOTTOM_DP = 64
    val BG = 0xFF1B1A20.toInt()
    val TEXT = 0xFFECE9F0.toInt()
    val MUTED = 0xFF9C97A8.toInt()
    val DANGER = 0xFFE0574E.toInt()
    val GREEN = 0xFF3FB97A.toInt()
  }
}
