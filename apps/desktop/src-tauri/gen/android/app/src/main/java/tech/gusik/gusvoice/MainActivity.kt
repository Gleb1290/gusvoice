package tech.gusik.gusvoice

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.ActionMode
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Install-once flag for the renderer-gone guard: onCreate re-runs on activity recreation, but the
 *  uncaught-exception handler is process-wide — re-wrapping it would stack delegation layers. */
private var rendererGoneGuardInstalled = false

class MainActivity : TauriActivity() {
  // Registered at construction (before the activity is STARTED) — the required ActivityResult pattern.
  private val requestPerms =
    registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

  // Медиа для клиента (05.10, вложения «как в Telegram»): своя галерея, «Файлы», «Сохранить» / «Копировать изображение» —
  // MediaBridge.kt. Окна системы — через эти два контракта: регистрировать их можно только при создании активности.
  private val media = MediaBridge(this)
  private val requestMediaPerms =
    registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { media.onPermissionResult() }
  private val pickDocuments =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { media.onDocumentsPicked(it) }

  fun launchMediaPermissions(perms: Array<String>) = requestMediaPerms.launch(perms)

  // Системное приложение «Файлы» (DocumentsUI): ACTION_OPEN_DOCUMENT с несколькими, любой тип.
  fun launchDocumentPicker() = pickDocuments.launch(arrayOf("*/*"))

  // The WebView we hand the back gesture to. Captured in onWebViewCreate; null until the shell builds it.
  private var webViewRef: WebView? = null

  // Системная строка над выделенным текстом («Вставить / Копировать…») — пока она открыта, «назад» закрывает её.
  private var textActionMode: ActionMode? = null

  private var backCallback: OnBackPressedCallback? = null

  // 🔴 Ход жеста AndroidX отдаёт только ВЕРХНЕМУ обработчику, а `AppPlugin` Tauri вешает свой позже нашего (при загрузке
  // плагинов вместе с WebView): начало и ход уходили ему и пропадали (эмулятор, Android 15), отпускание доходило до нас
  // кружным путём через его `activity.onBackPressed()`. На 14+ поднимаем свой наверх; WebView истории не ведёт (одна
  // страница), так что ветка `goBack` плагина и раньше не срабатывала.
  private fun raiseBackCallback() {
    if (Build.VERSION.SDK_INT < 34) return
    val cb = backCallback ?: return
    cb.remove()
    onBackPressedDispatcher.addCallback(this, cb)
  }

  // Жест «назад» в клиент: фаза, прогресс 0..1, край (0 — левый, 1 — правый), высота пальца в CSS-px.
  private fun sendBackGesture(phase: String, e: BackEventCompat) {
    val wv = webViewRef ?: return
    val y = e.touchY / resources.displayMetrics.density
    wv.evaluateJavascript("window.__gvBackGesture && window.__gvBackGesture('$phase', ${e.progress}, ${e.swipeEdge}, $y)", null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    installRendererGoneGuard()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    fitAboveKeyboard()

    // 🔴 Back gesture (#157). Without this the system back left the app from ANY screen — inside a
    // channel, inside settings, anywhere — because nothing claimed it. On Android that gesture is how
    // people go back, so the app felt foreign.
    //
    // The DECISION belongs to the web client: only it knows which sheet/panel/pane is open. We just
    // hand the gesture over; if the client has nothing to close it calls exitApp() itself. That also
    // sidesteps evaluateJavascript being async — we never need its answer.
    val back = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // 🔴 Открыта системная строка над полем («Вставить») — закрываем только её (#212, 29.09, S25): иначе
        // жест уходил клиенту, и тот уводил из беседы в список, а строка закрывалась заодно. У Telegram так же.
        textActionMode?.let {
          it.finish()
          return
        }
        val wv = webViewRef
        if (wv == null) {
          moveTaskToBack(true)
          return
        }
        wv.evaluateJavascript("window.__gvBack && window.__gvBack()", null)
      }

      // Предиктивная «назад» Android 14+ (G16): AndroidX сам вешает OnBackAnimationCallback (манифест —
      // enableOnBackInvokedCallback у MainActivity) и шлёт сюда начало, ход и отмену жеста. Отдаём их клиенту
      // (`window.__gvBackGesture` в androidBack.ts): решать, вести ли экран за пальцем, снова ему. Отпустил —
      // handleOnBackPressed выше, тот же путь, что у кнопки. Старые Android сюда не заходят.
      // Как у Telegram Android: LaunchActivity (OnBackAnimationCallback) -> ActionBarLayout.onBackStarted/onBackProgress.
      override fun handleOnBackStarted(backEvent: BackEventCompat) {
        if (Build.VERSION.SDK_INT < 34 || textActionMode != null) return
        sendBackGesture("start", backEvent)
      }

      override fun handleOnBackProgressed(backEvent: BackEventCompat) {
        if (Build.VERSION.SDK_INT < 34 || textActionMode != null) return
        sendBackGesture("progress", backEvent)
      }

      override fun handleOnBackCancelled() {
        if (Build.VERSION.SDK_INT < 34) return
        webViewRef?.evaluateJavascript("window.__gvBackGesture && window.__gvBackGesture('cancel', 0, 0, 0)", null)
      }
    }
    backCallback = back
    onBackPressedDispatcher.addCallback(this, back)

    // NB: do NOT force AudioManager.MODE_IN_COMMUNICATION here. On Samsung it routes the mic through
    // the VoIP capture path with aggressive HARDWARE ECNS (echo-cancel + noise-suppress), which mutes
    // sustained speech ("spike then silence") and adds latency. Chromium/WebRTC manages the audio mode
    // itself for getUserMedia calls and does its own software AEC — let it. (Confirmed via logcat:
    // VOIP_RECORD / voip_tx / SetECNSForVoipEnter engaged only while the mode was set.)

    // Layer 1 of Android WebView's two-layer media permission model: the OS-level grant.
    val perms = mutableListOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
    // POST_NOTIFICATIONS (API 33+) so the voice foreground-service notification shows immediately (#89).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) perms.add(Manifest.permission.POST_NOTIFICATIONS)
    requestPerms.launch(perms.toTypedArray())

    // Push deep-link (#118): a notification tap launches (cold start) or resumes (singleTask →
    // onNewIntent) us with gv_dm / gv_channel extras. Stash them; the web client polls
    // consumePendingDeepLink() on boot/foreground and navigates. Prefs (not memory) so a cold start
    // that reads the intent before the WebView bridge exists doesn't lose the target.
    stashDeepLink(intent)
    // «Поделиться в GusVoice» (09.10, G79; Telegram `LaunchActivity.handleIntent`): файлы и текст из чужого приложения —
    // копия в кеш (`MediaBridge.onShareIntent`), выбор беседы — клиент. Пересоздание активности (savedInstanceState) несёт
    // ТО ЖЕ намерение — второй раз его не предлагаем.
    if (savedInstanceState == null) media.onShareIntent(intent)
  }

  /**
   * Background-crash guard. wry's generated RustWebViewClient does NOT override onRenderProcessGone,
   * and the generated/ folder is gitignored + regenerated by the tauri CLI, so it can't be patched
   * there. Android's default for an unhandled dead WebView renderer = throw "Render process ... gone/
   * crash wasn't handled ..." on the main thread → the system "GusVoice произошел сбой" dialog. MIUI
   * and friends routinely reap the renderer of a BACKGROUNDED app to reclaim memory → users saw the
   * dialog repeatedly without ever touching the app. The renderer is the entire Tauri UI and Kotlin
   * can't rebuild it (wry owns the WebView), so recovery = exit the process quietly: no dialog, the
   * sticky push service is restarted by the system, and the next launch is a fresh process. Every
   * OTHER crash is delegated to the previous (default) handler unchanged — real bugs still produce
   * the dialog + dropbox/logcat records exactly as before.
   */
  private fun installRendererGoneGuard() {
    if (rendererGoneGuardInstalled) return
    rendererGoneGuardInstalled = true
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, e ->
      if (isRendererGone(e)) {
        android.util.Log.e("GusVoice", "WebView renderer gone — exiting quietly (no crash dialog)", e)
        android.os.Process.killProcess(android.os.Process.myPid())
      } else {
        previous?.uncaughtException(thread, e)
          ?: android.os.Process.killProcess(android.os.Process.myPid())
      }
    }
  }

  /** True when the crash is the framework's unhandled-renderer-death RuntimeException (all known
   *  message variants contain "Render process"); checks the cause chain, bounded for safety. */
  private fun isRendererGone(e: Throwable): Boolean {
    var cur: Throwable? = e
    var depth = 0
    while (cur != null && depth < 8) {
      if (cur.message?.contains("Render process", ignoreCase = true) == true) return true
      cur = cur.cause
      depth++
    }
    return false
  }

  // singleTask: when we're already running, the tap arrives here instead of a fresh onCreate. setIntent
  // so getIntent() reflects it, then stash the deep-link for the client to consume.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    stashDeepLink(intent)
    media.onShareIntent(intent)
  }

  /** Encode a deep-link into prefs: "dm:<id>", "ch:<serverId>:<channelId>" or "invite:<url>". */
  private fun stashDeepLink(intent: Intent?) {
    /*
     * Ссылка-приглашение (#139, F4, §4.2.2): `gusvoice://join?invite=https://host/i/CODE`.
     * Кладём её в ТЕ ЖЕ prefs, что и переход по пушу: путь до клиента уже есть и проверен, а два
     * механизма «отложенного намерения» однажды разошлись бы в поведении.
     * ⚠️ Разбор адреса — на стороне клиента (`deepLinkInvite.ts`): здесь только передаём строку.
     * Решать, что считать годной ссылкой, должно одно место, а не Kotlin и TypeScript по-разному.
     */
    val data = intent?.data
    if (data != null && data.scheme.equals("gusvoice", ignoreCase = true)) {
      getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE)
        .edit().putString(UnifiedPushReceiver.KEY_DEEPLINK, "invite:" + data.toString()).apply()
      return
    }
    val dmId = intent?.getStringExtra(UnifiedPushReceiver.EXTRA_DM).orEmpty()
    val channelId = intent?.getStringExtra(UnifiedPushReceiver.EXTRA_CHANNEL).orEmpty()
    val serverId = intent?.getStringExtra(UnifiedPushReceiver.EXTRA_SERVER).orEmpty()
    val instanceId = intent?.getStringExtra(UnifiedPushReceiver.EXTRA_INSTANCE).orEmpty()
    // Тап по уведомлению беседы (Р1, G17): уведомление снято (`autoCancel`) — забыть и его историю, иначе следующий пуш
    // покажет уже увиденные сообщения.
    if (dmId.isNotEmpty()) ConversationNotifier.clear(this, dmId)
    // «Ответить» входящего звонка (G73): снять уведомление звонка; клиент примет звонок по ссылке `call:<callId>:<dmId>`.
    val answer = intent?.getStringExtra(CallNotifier.EXTRA_ANSWER).orEmpty()
    if (answer.isNotEmpty()) CallNotifier.dismiss(this, answer)
    /*
     * Отдельный вид ссылки, а не лишнее поле в существующей (#139, F5): у старых сборок клиента
     * "fed:…" просто не совпадёт ни с одним разбором и будет пропущен, тогда как четвёртая часть в
     * "ch:…" увела бы их в несуществующий канал. Правило то же, что во всём протоколе: добавлять
     * так, чтобы сторона постарше молча не поняла, а не поняла неправильно.
     */
    val link = when {
      answer.isNotEmpty() && dmId.isNotEmpty() -> "call:$answer:$dmId"
      dmId.isNotEmpty() -> "dm:$dmId"
      channelId.isNotEmpty() && instanceId.isNotEmpty() -> "fed:$instanceId:$serverId:$channelId"
      channelId.isNotEmpty() -> "ch:$serverId:$channelId"
      else -> return
    }
    getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE)
      .edit().putString(UnifiedPushReceiver.KEY_DEEPLINK, link).apply()
  }

  override fun onActionModeStarted(mode: ActionMode) {
    super.onActionModeStarted(mode)
    textActionMode = mode
  }

  override fun onActionModeFinished(mode: ActionMode) {
    super.onActionModeFinished(mode)
    if (textActionMode === mode) textActionMode = null
  }

  /**
   * 🔴 Страница сжимается под клавиатуру, а не уезжает вверх (#212, 29.09, проход по касаниям на S25).
   *
   * С `enableEdgeToEdge()` окно под клавиатуру не ужимается само (Android 15 игнорирует `adjustResize` для
   * приложений на весь экран), и WebView поступал по-браузерному: сдвигал видимую часть страницы. Замер: из 891 px
   * видно 559, сдвиг 332 — шапка беседы и верх ленты уходили за экран, в короткой беседе над полем было пусто,
   * а панель вкладок прежде вставала прямо над клавиатурой. У Telegram лента сжимается, шапка остаётся.
   *
   * Поэтому высоту клавиатуры отдаём ОТСТУПОМ снизу у корня содержимого: WebView становится короче ровно на неё, и
   * вёрстка раскладывается заново (`innerHeight` меньше). Детям вставку клавиатуры не передаём — иначе WebView
   * вдобавок сдвинул бы страницу ещё раз. Пока клавиатура открыта, прячем и нижний отступ системной панели: она
   * под клавиатурой, и `env(safe-area-inset-bottom)` дал бы пустую полосу между полем и клавишами.
   */
  private fun fitAboveKeyboard() {
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, ime.bottom)
      val out = if (ime.bottom == 0) insets else {
        val b = WindowInsetsCompat.Builder(insets).setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        for (type in intArrayOf(
          WindowInsetsCompat.Type.navigationBars(),
          WindowInsetsCompat.Type.systemBars(),
          WindowInsetsCompat.Type.tappableElement(),
          WindowInsetsCompat.Type.mandatorySystemGestures(),
        )) {
          val i = insets.getInsets(type)
          b.setInsets(type, Insets.of(i.left, i.top, i.right, 0))
        }
        b.build()
      }
      publishSafeArea(out)
      out
    }
  }

  /**
   * 🔴 Системные панели — в страницу сами (08.10, S20+ с WebView 111 и тремя кнопками: панель вкладок уезжала под
   * «назад / домой / недавние»). WebView до ~M135 при edge-to-edge кладёт в `env(safe-area-inset-*)` только вырез
   * экрана, а строку состояния и панель навигации — нет (замер на эмуляторе: WebView 124 — низ 0, WebView 145 — 48 px).
   * Поэтому те же вставки (системные панели ∪ вырез, при открытой клавиатуре низ уже обнулён выше) отдаём странице
   * CSS-переменными `--gv-sat/-sar/-sab/-sal` в CSS-пикселях; CSS берёт `max(env(…), var(--gv-sa…))` — на новом
   * WebView оба числа равны, двойного отступа нет. Пока страницы нет — значение ждёт в [safeAreaJson], клиент забирает
   * его на старте мостом `GusVoiceNative.safeArea()` (и после перезагрузки страницы тоже).
   */
  @Volatile private var safeAreaJson = ""

  private fun publishSafeArea(insets: WindowInsetsCompat) {
    val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val d = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
    fun css(px: Int) = String.format(java.util.Locale.US, "%.2f", px / d)
    val json = "{\"top\":${css(i.top)},\"right\":${css(i.right)},\"bottom\":${css(i.bottom)},\"left\":${css(i.left)}}"
    if (json == safeAreaJson) return
    safeAreaJson = json
    webViewRef?.evaluateJavascript("window.__gvSafeArea && window.__gvSafeArea($json)", null)
  }

  // Layer 2: grant the media-capture resources the page requests; the OS grant above is the real gate.
  // ⚠️ 05.10: wry 0.55.1 ставит СВОЙ RustWebChromeClient сразу ПОСЛЕ этого хука (main_pipe.rs: setWebView →
  // onWebViewCreate → … → setWebChromeClient), поэтому клиент ниже заменяется и в работе не участвует: разрешения и окно
  // выбора файлов (onShowFileChooser, несколько файлов — через ClipData) обслуживает клиент wry. Оставлен на случай
  // другого порядка в будущих wry. «Выбрал файлы — ничего не добавилось» (05.10) — ошибка не здесь, а в клиенте
  // (MessagePane.addFiles читал уже очищенный FileList).
  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView
    webView.post { raiseBackCallback() }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) {
        runOnUiThread {
          val media = request.resources.filter {
            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
          }.toTypedArray()
          if (media.isNotEmpty()) request.grant(media) else request.deny()
        }
      }
    }

    // JS→native bridge (#89): the web client calls window.GusVoiceNative.{start,stop}VoiceService() on
    // voice join/leave to run a microphone foreground service, so locking the screen / backgrounding the
    // app doesn't let Android suspend mic capture and drop the call. Safe: this WebView only ever loads
    // our own bundled dist (no untrusted/remote page can reach this interface). Added here — before the
    // initial page load — so window.GusVoiceNative exists by the time the client runs.
    webView.addJavascriptInterface(NativeBridge(), "GusVoiceNative")

    // Объект `GusVoiceMedia` для галереи, «Файлов» и меню фото — байты сообщениями ArrayBuffer (MediaBridge.kt). Тоже до
    // первой загрузки: объект вставляется в документы, которые начнут грузиться после этого вызова.
    media.attach(webView)
  }

  override fun onResume() {
    super.onResume()
    // Android 14+: один раз предложить «Полноэкранные уведомления» (входящий звонок поверх блокировки).
    // Не посреди «Ответить» на звонок (приложение открыто принять его) — тогда не лезем с вопросом.
    if (intent?.hasExtra(CallNotifier.EXTRA_ANSWER) != true) FullScreenAsk.maybeAsk(this)
  }

  override fun onDestroy() {
    media.shutdown()
    super.onDestroy()
  }

  inner class NativeBridge {
    // @JavascriptInterface methods run on the WebView's JS-bridge thread; starting/stopping a service
    // is thread-safe. Fire-and-forget — the web side treats these as best-effort no-ops off Android.
    @JavascriptInterface
    fun startVoiceService() {
      VoiceForegroundService.start(this@MainActivity)
    }

    @JavascriptInterface
    fun stopVoiceService() {
      VoiceForegroundService.stop(this@MainActivity)
    }

    // Системные вставки в CSS-пикселях (`publishSafeArea`): JSON {top,right,bottom,left} или "" до первого прохода.
    @JavascriptInterface
    fun safeArea(): String = safeAreaJson

    // «Поделиться в GusVoice» со старым WebView (D22, без объекта `GusVoiceMedia`): пришедший текст — JSON или "" (`MediaBridge.legacyShare`).
    @JavascriptInterface
    fun sharedText(): String = media.legacySharedJson()

    @JavascriptInterface
    fun sharedTextDrop(token: String) {
      media.legacySharedDrop(token)
    }

    // Файл из ленты со старым WebView (без `GusVoiceMedia`, 09.10): JSON {url, name, mime, then: save|open} → системный
    // DownloadManager в «Загрузки/GusVoice»; только ссылки «Скачать» своих инстансов (`LegacyDownloads`). Ответ — код.
    @JavascriptInterface
    fun downloadFile(json: String): String = LegacyDownloads.start(this@MainActivity, json)

    // Back gesture (#157): the client calls this when it has nothing left to close. Задача уходит В
    // ФОН, а не закрывается: голос переживает сворачивание (микрофонная служба переднего плана), и
    // человек, нажавший «назад» на списке каналов, не должен вылетать из разговора.
    @JavascriptInterface
    fun exitApp() {
      runOnUiThread { moveTaskToBack(true) }
    }

    // --- Push (UnifiedPush) --- driven by the web client on mobile boot. registerForPush kicks off
    // distributor registration (ntfy); the resulting endpoint lands in prefs via UnifiedPushReceiver,
    // and the client polls getPushEndpoint() then POSTs it to /api/push/register with its auth token.
    @JavascriptInterface
    fun registerForPush() {
      runOnUiThread {
        try {
          org.unifiedpush.android.connector.UnifiedPush.registerAppWithDialog(this@MainActivity)
        } catch (e: Exception) {
          android.util.Log.w("GusVoicePush", "registerForPush failed", e)
        }
      }
    }

    @JavascriptInterface
    fun getPushEndpoint(): String =
      getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE)
        .getString(UnifiedPushReceiver.KEY_ENDPOINT, "") ?: ""

    // True if at least one UnifiedPush distributor (e.g. the ntfy app) is installed — the client shows
    // an "install ntfy" hint otherwise.
    @JavascriptInterface
    fun hasPushDistributor(): Boolean =
      org.unifiedpush.android.connector.UnifiedPush.getDistributors(this@MainActivity).isNotEmpty()

    @JavascriptInterface
    fun unregisterPush() {
      runOnUiThread {
        try {
          org.unifiedpush.android.connector.UnifiedPush.unregisterApp(this@MainActivity)
        } catch (e: Exception) {
          android.util.Log.w("GusVoicePush", "unregisterPush failed", e)
        }
      }
    }

    // --- Embedded push distributor --- the multi-instance path: no separate ntfy app. The client
    // passes the instance's ntfy base (from /config.json discovery); we pick a stable random topic,
    // start the foreground socket service, and return the endpoint (https://<base>/<topic>) for the
    // client to POST to /api/push/register. Reused across calls (topic persists in prefs).
    @JavascriptInterface
    fun enableEmbeddedPush(ntfyBase: String): String {
      val base = ntfyBase.trim().trimEnd('/')
      if (base.isEmpty()) return ""
      val prefs = getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE)
      var topic = prefs.getString(PushDistributorService.KEY_TOPIC, "").orEmpty()
      if (topic.isEmpty()) {
        topic = "up" + java.util.UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString(PushDistributorService.KEY_TOPIC, topic).apply()
      }
      prefs.edit().putString(PushDistributorService.KEY_NTFY_BASE, base).apply()
      runOnUiThread { PushDistributorService.start(this@MainActivity) }
      return "$base/$topic"
    }

    @JavascriptInterface
    fun disableEmbeddedPush() {
      runOnUiThread { PushDistributorService.stop(this@MainActivity) }
      getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE).edit()
        .remove(PushDistributorService.KEY_NTFY_BASE)
        .remove(PushDistributorService.KEY_TOPIC)
        .apply()
    }

    // Ключи шифрования пуша этого телефона (#213, WebPush): открытый ключ и секрет для регистрации на
    // бэкенде. Закрытый ключ остаётся в `PushCrypto`. "" — не вышло создать ключи (регистрация без них).
    @JavascriptInterface
    fun pushKeys(): String = try {
      PushCrypto.keysJson(this@MainActivity)
    } catch (e: Exception) {
      android.util.Log.w("GusVoicePush", "pushKeys failed", e)
      ""
    }

    // Уведомления как у Telegram (Р1, G17): признаки для регистрации пуша и адрес/токен для «Ответить» из шторки.
    @JavascriptInterface
    fun notifCaps(): String = NotifAuth.CAPS_JSON

    @JavascriptInterface
    fun setNotifAuth(json: String) {
      NotifAuth.set(this@MainActivity, json)
    }

    @JavascriptInterface
    fun embeddedPushEndpoint(): String {
      val prefs = getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE)
      val base = prefs.getString(PushDistributorService.KEY_NTFY_BASE, "").orEmpty()
      val topic = prefs.getString(PushDistributorService.KEY_TOPIC, "").orEmpty()
      return if (base.isNotEmpty() && topic.isNotEmpty()) "$base/$topic" else ""
    }

    // Deep-link (#118): return the pending target ("dm:<id>" / "ch:<serverId>:<channelId>") from a
    // notification tap AND clear it, so the client navigates exactly once. "" when there's nothing.
    @JavascriptInterface
    fun consumePendingDeepLink(): String {
      val prefs = getSharedPreferences(UnifiedPushReceiver.PREFS, MODE_PRIVATE)
      val link = prefs.getString(UnifiedPushReceiver.KEY_DEEPLINK, "") ?: ""
      if (link.isNotEmpty()) prefs.edit().remove(UnifiedPushReceiver.KEY_DEEPLINK).apply()
      return link
    }
  }
}
