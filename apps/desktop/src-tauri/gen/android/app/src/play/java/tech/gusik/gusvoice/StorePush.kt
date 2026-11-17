package tech.gusik.gusvoice

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Пуши магазина для сборки Google Play (#247, `GV_STORE=play`): Google FCM. Пара — `src/fdroid/java/.../StorePush.kt`
 * (то же имя и те же функции, всегда «нет»); подключается ровно один каталог (`app/build.gradle.kts`), поэтому main-код
 * (мост `MainActivity.NativeBridge.storePush*`) зовёт `StorePush`, не зная о Firebase.
 *
 * Firebase поднимается ВРУЧНУЮ из `BuildConfig` (параметры проекта — env сборки), без плагина google-services и без
 * `google-services.json`. Адрес для бэкенда — шлюз FCM нашего же бэкенда: `${GV_FCM_RELAY}/api/push/fcm/<токен>`;
 * бэкенд шлёт туда то же зашифрованное web-push тело, что и в ntfy, шлюз кладёт его в `data["gv"]` (`FcmService`).
 */
object StorePush {
  /** Встроенный WS-распространитель в этой сборке вычеркнут из манифеста — мост откажет клиенту. */
  const val EMBEDDED_DISTRIBUTOR = false

  private const val TAG = "GusVoicePush"
  private const val KEY_TOKEN = "fcm_token"

  /** Есть ли на устройстве рабочие Google Play services (без них FCM не доставит ничего). */
  fun available(context: Context): Boolean = try {
    GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  } catch (e: Exception) {
    Log.w(TAG, "play services check failed", e)
    false
  }

  /**
   * FirebaseApp по умолчанию из `BuildConfig`. Идемпотентно: `FirebaseInitProvider` без google-services приложение
   * не создаёт, а при повторе берём уже поднятое. false — не вышло (в журнал, без падения процесса).
   */
  fun ensureFirebase(context: Context): Boolean {
    val app = context.applicationContext
    return try {
      if (FirebaseApp.getApps(app).isEmpty()) {
        val options = FirebaseOptions.Builder()
          .setApplicationId(BuildConfig.GV_FIREBASE_APP_ID)
          .setApiKey(BuildConfig.GV_FIREBASE_API_KEY)
          .setProjectId(BuildConfig.GV_FIREBASE_PROJECT_ID)
          .setGcmSenderId(BuildConfig.GV_FIREBASE_SENDER_ID)
          .build()
        FirebaseApp.initializeApp(app, options)
      }
      true
    } catch (e: Exception) {
      Log.w(TAG, "firebase init failed", e)
      false
    }
  }

  /** Запросить токен (асинхронно); он ляжет в настройки, а клиент заберёт адрес опросом [endpoint]. */
  fun start(context: Context) {
    if (!available(context) || !ensureFirebase(context)) return
    val app = context.applicationContext
    try {
      FirebaseMessaging.getInstance().token
        .addOnSuccessListener { token -> if (!token.isNullOrEmpty()) saveToken(app, token) }
        .addOnFailureListener { e -> Log.w(TAG, "fcm token failed", e) }
    } catch (e: Exception) {
      Log.w(TAG, "fcm start failed", e)
    }
  }

  /** Адрес для `/api/push/register`; "" — токена ещё нет. */
  fun endpoint(context: Context): String {
    val token = prefs(context).getString(KEY_TOKEN, "").orEmpty()
    if (token.isEmpty()) return ""
    return "${BuildConfig.GV_FCM_RELAY.trimEnd('/')}/api/push/fcm/$token"
  }

  /** Выход: отозвать токен у Google и забыть его. */
  fun stop(context: Context) {
    prefs(context).edit().remove(KEY_TOKEN).apply()
    if (!ensureFirebase(context)) return
    try {
      FirebaseMessaging.getInstance().deleteToken()
        .addOnFailureListener { e -> Log.w(TAG, "fcm deleteToken failed", e) }
    } catch (e: Exception) {
      Log.w(TAG, "fcm stop failed", e)
    }
  }

  /**
   * Новый токен (`FcmService.onNewToken` или ответ [start]). Сменился — сохранить и, если страница жива, попросить её
   * перерегистрироваться (`window.__gvPushEndpointChanged`, `nativeUnifiedPush.ts`); мертва — клиент заберёт новый
   * адрес при следующем старте.
   */
  fun saveToken(context: Context, token: String) {
    val p = prefs(context)
    if (p.getString(KEY_TOKEN, "") == token) return
    p.edit().putString(KEY_TOKEN, token).apply()
    Log.i(TAG, "fcm token stored (len=${token.length})")
    MainActivity.sendPushEndpointChanged()
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(UnifiedPushReceiver.PREFS, Context.MODE_PRIVATE)
}
