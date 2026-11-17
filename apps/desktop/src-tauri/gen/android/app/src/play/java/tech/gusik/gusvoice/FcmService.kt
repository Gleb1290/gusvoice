package tech.gusik.gusvoice

import android.util.Base64
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Приём Google FCM в сборке Google Play (#247; объявлена в `src/play/AndroidManifest.xml`). Шлюз FCM нашего бэкенда
 * кладёт зашифрованное web-push тело (то же, что уходит в ntfy) в `data["gv"]` base64 — здесь оно декодируется и идёт
 * в тот же показ, что у встроенного распространителя и внешнего UnifiedPush: `PushNotifier.show` (расшифровка
 * `PushCrypto`, подавление при открытом приложении, диплинк).
 */
class FcmService : FirebaseMessagingService() {
  override fun onCreate() {
    // Процесс мог подняться ради пуша: FirebaseApp по умолчанию без google-services сам не создаётся.
    StorePush.ensureFirebase(this)
    super.onCreate()
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val raw = message.data["gv"]
    if (raw.isNullOrEmpty()) {
      Log.w(TAG, "fcm message without gv payload")
      return
    }
    val bytes = try {
      // Обычный base64; на всякий случай принимаем и url-safe алфавит.
      Base64.decode(raw.replace('-', '+').replace('_', '/'), Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "fcm payload is not base64", e)
      return
    }
    PushNotifier.show(applicationContext, bytes)
  }

  override fun onNewToken(token: String) {
    StorePush.saveToken(applicationContext, token)
  }

  private companion object {
    const val TAG = "GusVoicePush"
  }
}
