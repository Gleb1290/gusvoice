package tech.gusik.gusvoice

import android.os.Build
import android.util.Log
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat
import java.lang.ref.WeakReference

/**
 * Картинки и GIF из клавиатуры (Gboard и др.) — G50, 14.10. Поле ввода страницы (WebView) объявляет клавиатуре, какие типы
 * принимает ([MIME_TYPES]), и отдаёт то, что она прислала через `InputConnection.commitContent`, мосту медиа
 * ([MediaBridge.onKeyboardContent]): файл копируется в кеш тем же путём, что «Поделиться», и встаёт вложением в поле
 * (`window.__gvKeyboardContent` → `KeyboardContentIncoming.tsx`). Источник поведения — Telegram Android: `EditTextCaption`
 * (`onCreateInputConnection` → `EditorInfoCompat.setContentMimeTypes` + `InputConnectionCompat.createWrapper`) и
 * `ChatActivityEnterView` (превью вложения в поле); код Telegram не копировали.
 *
 * WebView создаёт wry (класс `RustWebView` генерируется при сборке), подкласса у нас нет — поэтому [wrap] зовёт переопределение
 * `onCreateInputConnection`, вставленное в сгенерированный класс через `WRY_RUSTWEBVIEW_CLASS_EXTENSION`
 * (`apps/desktop/src-tauri/.cargo/config.toml`, раздел `[env]`).
 */
object KeyboardContent {
  /** Что просим у клавиатуры: GIF, картинки и стикеры-картинки. Список как у Telegram `EditTextCaption`. */
  val MIME_TYPES = arrayOf("image/gif", "image/png", "image/jpg", "image/jpeg", "image/webp", "image/*")

  // Слабая ссылка: объект живёт дольше активности, держать её (и мост с ней) нельзя.
  @Volatile private var bridge: WeakReference<MediaBridge>? = null

  /** `MainActivity.onWebViewCreate`: кому отдавать присланное. */
  fun bind(media: MediaBridge?) {
    bridge = media?.let { WeakReference(it) }
  }

  /**
   * Подключение поля ввода: [ic] — родное от WebView (`null` — поле не редактируется, оставляем `null`). Любая беда с обёрткой —
   * отдаём родное подключение как есть: ввод текста важнее картинок из клавиатуры.
   */
  fun wrap(ic: InputConnection?, outAttrs: EditorInfo?): InputConnection? {
    if (ic == null || outAttrs == null) return ic
    return try {
      EditorInfoCompat.setContentMimeTypes(outAttrs, MIME_TYPES)
      InputConnectionCompat.createWrapper(
        ic,
        outAttrs,
        InputConnectionCompat.OnCommitContentListener { info, flags, _ -> commit(info, flags) },
      )
    } catch (e: Exception) {
      Log.w(TAG, "keyboard content wrapper failed", e)
      ic
    }
  }

  /** `true` — приняли (клавиатура покажет «вставлено»); `false` — нет моста, нет права на чтение или не картинка. */
  private fun commit(info: InputContentInfoCompat, flags: Int): Boolean {
    val media = bridge?.get() ?: return false
    val mime = if (info.description.mimeTypeCount > 0) info.description.getMimeType(0) else ""
    if (!mime.startsWith("image/")) return false
    // Права на чужой адрес даются по запросу (Android 7.1+); без них поставщик клавиатуры файл не отдаст.
    var asked = false
    if ((flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
      try {
        info.requestPermission()
        asked = true
      } catch (e: Exception) {
        Log.w(TAG, "keyboard content permission denied", e)
        return false
      }
    }
    // Право держится, пока жив объект: отпускаем после копирования (мост зовёт [release] сам, в любом исходе).
    media.onKeyboardContent(info.contentUri, mime) {
      if (asked) {
        try {
          info.releasePermission()
        } catch (_: Exception) {
        }
      }
    }
    return true
  }

  private const val TAG = "GusVoiceKeyboard"
}
