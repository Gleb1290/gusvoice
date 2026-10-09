package tech.gusik.gusvoice

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Предложить включить «Полноэкранные уведомления» (Android 14+, 09.10, #211; источник — Telegram Android
 * `DialogsActivity.onResume`: `SDK >= 34 && !canUseFullScreenIntent()` + флаг «спрашивали», диалог «Настройки» /
 * «Не сейчас», код не копировался). Без этого права входящий звонок на заблокированном экране — обычная всплывашка
 * ([CallNotifier.canFullScreen]).
 *
 * Спрашиваем из [MainActivity.onResume], только когда в приложении есть вход ([NotifAuth.forUser]) — на экране входа
 * просить рано. Как у Telegram (решение владельца 09.10): флаг «спрашивали» ставит ТОЛЬКО «Не сейчас». «Настройки» флаг
 * не ставит — если право так и не включили, спросим снова при следующем возврате в приложение (в том числе сразу после
 * возврата из настроек) или запуске, пока право не появится или не нажмут «Не сейчас». Закрыли мимо (тап вне окна,
 * «назад») — флаг не ставится, спросим снова. Частоты у Telegram нет (каждый `onResume`), у нас тоже: одновременно
 * показывается не больше одного окна ([showing]).
 */
object FullScreenAsk {
  private const val PREFS = "gusvoice_fsi_ask"
  private const val KEY_ASKED = "asked"

  /** Нужно ли спросить сейчас: чистое правило — отдельно, чтобы его можно было проверить без экрана. */
  fun shouldAsk(sdk: Int, canFullScreen: Boolean, asked: Boolean, loggedIn: Boolean): Boolean =
    sdk >= 34 && !canFullScreen && !asked && loggedIn

  private var showing = false

  fun maybeAsk(activity: Activity) {
    if (showing || activity.isFinishing || activity.isDestroyed) return
    val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val ask = shouldAsk(
      Build.VERSION.SDK_INT,
      CallNotifier.canFullScreen(activity),
      prefs.getBoolean(KEY_ASKED, false),
      NotifAuth.forUser(activity, "") != null,
    )
    if (!ask) return
    showing = true
    AlertDialog.Builder(activity)
      .setMessage("Чтобы входящий звонок показывался на весь экран, даже когда телефон заблокирован, разрешите это для GusVoice в настройках.")
      .setPositiveButton("Настройки") { _, _ ->
        // Флаг НЕ ставим (Telegram `DialogsActivity`: только «Не сейчас»): не включили — спросим снова.
        try {
          activity.startActivity(
            Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${activity.packageName}")),
          )
        } catch (_: Exception) {
          // Нет такого экрана настроек (редкая прошивка) — тихо: ничего страшного, звонок придёт всплывашкой.
        }
      }
      .setNegativeButton("Не сейчас") { _, _ -> prefs.edit().putBoolean(KEY_ASKED, true).apply() }
      .setOnDismissListener { showing = false }
      .show()
  }
}
