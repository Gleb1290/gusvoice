package tech.gusik.gusvoice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Кнопки уведомления голоса (#156): «Микрофон», «Не слышу», «Выйти» из [VoiceForegroundService] — без открытия приложения.
 * Действие уходит странице (`window.__gvMicAction`, клиент `nativeMicActions.ts`): мьют, «Не слышу» и выход ведёт она, а
 * уведомление перестраивается, когда страница пришлёт новое состояние (`GusVoiceNative.micState`). Не экспортирован:
 * интенты шлют только наши PendingIntent.
 */
class VoiceActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_TOGGLE_MUTE = "tech.gusik.gusvoice.VOICE_TOGGLE_MUTE"
    const val ACTION_TOGGLE_DEAFEN = "tech.gusik.gusvoice.VOICE_TOGGLE_DEAFEN"
    const val ACTION_LEAVE = "tech.gusik.gusvoice.VOICE_LEAVE"
  }

  override fun onReceive(context: Context, intent: Intent) {
    // Перечень закрыт: в строку JS попадает только одно из этих слов (MainActivity.sendMicAction).
    val action = when (intent.action) {
      ACTION_TOGGLE_MUTE -> "toggle-mute"
      ACTION_TOGGLE_DEAFEN -> "toggle-deafen"
      ACTION_LEAVE -> "leave"
      else -> return
    }
    // Страницы нет (активность убита, служба осталась) — голоса без неё уже нет; «Выйти» хотя бы снимает службу.
    if (!MainActivity.sendMicAction(action)) {
      Log.w("GusVoice", "voice action $action: no page")
      if (action == "leave") VoiceForegroundService.stop(context)
    }
  }
}
