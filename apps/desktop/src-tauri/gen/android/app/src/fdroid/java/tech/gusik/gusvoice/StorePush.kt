package tech.gusik.gusvoice

import android.content.Context

/**
 * Пуши магазина в F-Droid-сборке (#247, без `GV_STORE=play`): их нет — ни одной библиотеки Google. Пара —
 * `src/play/java/.../StorePush.kt` (Google FCM) с теми же именами; подключается ровно один каталог (`app/build.gradle.kts`).
 * Пуши здесь — встроенный распространитель (`PushDistributorService`) или внешний UnifiedPush (ntfy).
 */
object StorePush {
  /** Встроенный WS-распространитель в этой сборке есть. */
  const val EMBEDDED_DISTRIBUTOR = true

  fun available(@Suppress("UNUSED_PARAMETER") context: Context): Boolean = false

  fun start(@Suppress("UNUSED_PARAMETER") context: Context) {}

  fun endpoint(@Suppress("UNUSED_PARAMETER") context: Context): String = ""

  fun stop(@Suppress("UNUSED_PARAMETER") context: Context) {}
}
