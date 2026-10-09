package tech.gusik.gusvoice

import android.content.Intent
import android.net.Uri
import kotlin.math.max

/**
 * «Поделиться в GusVoice» (09.10, G79): разбор намерения ACTION_SEND / ACTION_SEND_MULTIPLE от галереи, браузера, «Файлов».
 * Источник поведения — Telegram Android `LaunchActivity.handleIntent` (ветки `ACTION_SEND` / `ACTION_SEND_MULTIPLE`: текст из
 * `EXTRA_TEXT`, тема `EXTRA_SUBJECT`, файлы из `EXTRA_STREAM`); код не копировали. Байты копирует `MediaBridge.onShareIntent`,
 * выбор беседы и поле ввода — клиент (`apps/client/src/shareIncoming.ts`).
 *
 * 🔴 Принимаем только `content://` чужих поставщиков. `file://` и свой `FileProvider` — нет: иначе чужое приложение
 * «поделилось» бы файлом из НАШЕЙ папки (`/data/data/<пакет>/…`: токены, кеш) и человек сам отправил бы его в беседу
 * (класс уязвимостей «share intent → чтение приватных файлов»; Telegram отсекает то же — `AndroidUtilities.isInternalUri`).
 */
object ShareIntent {
  /** Столько вложений в одном сообщении (`ATTACH_MAX` клиента). Лишние не копируются — клиент скажет, сколько отброшено. */
  const val MAX_FILES = 10

  /** Текст длиннее — обрезается (поле ввода всё равно уводит длинное в файл `message.txt`). */
  const val MAX_TEXT = 100_000

  class Parsed(val uris: List<Uri>, val dropped: Int, val text: String, val subject: String, val type: String)

  /** `null` — не «поделиться» или делиться нечем (нет ни годных файлов, ни текста). */
  fun parse(intent: Intent?, packageName: String): Parsed? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
    // Запуск из «Недавних» повторяет прошлое намерение — второй раз то же не предлагаем (Telegram проверяет тот же флаг).
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    val all = LinkedHashSet<Uri>()
    try {
      if (action == Intent.ACTION_SEND) {
        @Suppress("DEPRECATION")
        (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let { all.add(it) }
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<android.os.Parcelable>(Intent.EXTRA_STREAM)?.forEach { p -> (p as? Uri)?.let { all.add(it) } }
      }
    } catch (e: Exception) {
      // Чужой Parcelable, который не разбирается, — делимся тем, что есть (текстом).
    }
    // Часть отправителей кладёт адреса только в ClipData (с ним же приходит право чтения); одинаковые — один раз.
    intent.clipData?.let { c -> for (i in 0 until c.itemCount) c.getItemAt(i).uri?.let { all.add(it) } }
    val ok = all.filter { accepted(it, packageName) }
    val text = (intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: "").take(MAX_TEXT)
    val subject = (intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: "").take(1000)
    if (ok.isEmpty() && text.isBlank() && subject.isBlank()) return null
    return Parsed(ok.take(MAX_FILES), max(0, ok.size - MAX_FILES), text, subject, intent.type ?: "")
  }

  /**
   * Только `content://` и не наш поставщик (`<пакет>.fileprovider` и любые `<пакет>.*`). Поставщик — ПОСЛЕ последнего `@`:
   * `content://0@<пакет>.fileprovider/…` система открывает как `<пакет>.fileprovider` пользователя 0 (`userId@` она
   * отрезает, `ContentProvider.getAuthorityWithoutUserId`), а сравнение целиком пропустило бы его. Регистр — без учёта.
   * Это первый рубеж; второй — настоящий путь открытого дескриптора ([ownPath], `MediaBridge.copyShared`).
   */
  fun accepted(uri: Uri, packageName: String): Boolean {
    if (!uri.scheme.equals("content", ignoreCase = true)) return false
    val raw = uri.encodedAuthority ?: return false
    val auth = Uri.decode(raw.substringAfterLast('@')).lowercase()
    val pkg = packageName.lowercase()
    if (auth.isEmpty()) return false
    return auth != pkg && !auth.startsWith("$pkg.")
  }

  /**
   * Путь (из `readlink /proc/self/fd/N`) — внутри данных нашего пакета? Как Telegram `AndroidUtilities.isInternalUri(fd)`
   * (код не копировали): чужой поставщик может отдать дескриптор НАШЕГО файла (симлинк, проброс), а `accepted` видит
   * только адрес. `ownDirs` — канонические `dataDir`/`filesDir`/`cacheDir`/… этого процесса. Пустой путь — «свой» (не знаем,
   * что это, — не берём); каналы и сокеты (`pipe:[…]`, `socket:[…]`) — чужие.
   */
  fun ownPath(path: String?, packageName: String, ownDirs: List<String>): Boolean {
    if (path.isNullOrEmpty() || path.length > 4096) return true
    if (!path.startsWith("/")) return false
    val p = (if (path.endsWith("/")) path else "$path/").lowercase()
    val pkg = packageName.lowercase()
    if (p.contains("/data/data/$pkg/")) return true
    if (Regex("/user(_de)?/[0-9]+/" + Regex.escape(pkg) + "/").containsMatchIn(p)) return true
    return ownDirs.any { d ->
      val dir = d.trimEnd('/').lowercase()
      dir.isNotEmpty() && p.startsWith("$dir/")
    }
  }
}
