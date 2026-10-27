import '@livekit/components-styles';
// Self-hosted UI fonts (no external Google Fonts requests).
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isBlockedBrowserShortcut } from './browserShortcuts';
import { isEditableTag, keepNativeMenu } from './contextMenuRules';
import { effectiveUserSelect, shouldDropSelection } from './phoneSelectionRules';
import { VoiceOverlay } from './components/VoiceOverlay';
import { TipToast } from './components/TipToast';
import { NotifyPopups } from './components/NotifyPopups';
import { SplashScreen } from './components/SplashScreen';
import { WindowTitleBar } from './components/WindowTitleBar';
import { hasOwnTitleBar } from './titleBar';
// Телефонный профиль собеседника (#218): подставляет экран в `UserContextMenu` (`providePhoneProfile`) — без него на телефоне карточка ПК.
import './components/PhoneProfile';
import './styles.css';
import { applyTheme, getTheme } from './theme';
import { applyUiPrefs, applyUiScale, getUiScale } from './uiPrefs';
import { installAndroidBack } from './androidBack';
import { installNativeSafeArea } from './nativeSafeArea';
import { installNativeMicActions } from './nativeMicActions';
import { installViewerRotation } from './viewerRotation';
import { initPushRegistration } from './nativeUnifiedPush';
import { ensureNotifyPermission } from './notifications';
import { notifyIfJustUpdated, runLaunchUpdate, startUpdatePolling } from './updater';
import { watchWindowCovered } from './windowCovered';
import { httpsUpgradeUrl } from './configRules';
import { isTauri } from './hotkeys';
import { installLivekitTweaks } from './livekitTweaks';
import { applyLiteMode } from './liteMode';
import { bindUploadProgress } from './convStore';
import { startFedVia } from './fedVia';
import { startLastSeenRefresh } from './lastSeenRefresh';
import { startSelfInstanceName } from './selfInstanceName';
import { bindChunkedUpload } from './api';
import { dmChunkedUploads } from './attachRules';
import { CHUNK_FROM_BYTES, uploadInChunks } from './chunkedUpload';
import { clearUploadProgress, setUploadDone, setUploadProgress } from './uploadProgress';
import { installAttLinkRenewal } from './attLinks';

// До любого подключения к комнате: иначе первые дорожки успеют запустить вечный цикл отрисовки.
installLivekitTweaks();
applyTheme(getTheme());
applyUiPrefs();
applyLiteMode();
// Системная «назад» на Android: без этого жест выбрасывал из приложения с любого экрана (#157).
installAndroidBack();
// Android: системные панели в CSS-переменные — старый WebView не кладёт их в env(safe-area-inset-*) (nativeSafeArea.ts).
installNativeSafeArea();
// Android: кнопки микрофона в уведомлении голоса и состояние микрофона нативу (#156, nativeMicActions.ts).
installNativeMicActions();
// Android-телефон: поворот экрана только на время просмотра фото/видео, потом снова портрет (viewerRotation.ts).
installViewerRotation();
// Файлы ЛС: истёкшая ссылка (аудит #236, п.6) у картинки/видео/звука в документе — новая ссылка и повтор (attLinks.ts).
installAttLinkRenewal();

const root = createRoot(document.getElementById('root')!);

// The desktop in-game overlay runs in a SEPARATE always-on-top window that loads the same bundle with
// `?window=overlay`. There it renders just the voice widget (transparent bg) — no app, no updater/push.
const gvWindow = new URLSearchParams(location.search).get('window');
// Открыли по http://, а API на https:// — уводим на https ДО всего (22.09, правило и «почему» — `configRules`):
// CORS пускает только https-источник клиента, и со страницы по http не работал ни один запрос, даже регистрация.
const httpsUrl = httpsUpgradeUrl(location, window.__GUSVOICE_CONFIG__?.apiUrl, isTauri());
if (httpsUrl) {
  location.replace(httpsUrl);
} else if (gvWindow === 'overlay') {
  document.documentElement.classList.add('overlay-window');
  // silent: экран ошибки поверх чужой игры хуже, чем пропавший виджет (см. ErrorBoundary).
  root.render(
    <ErrorBoundary silent>
      <VoiceOverlay />
    </ErrorBoundary>,
  );
} else if (gvWindow === 'toast') {
  // Второе оверлейное окно: всплывающая плашка «кто кого типнул». Тот же прозрачный фон и тот же
  // принцип — ни приложения, ни апдейтера, ни пушей, только виджет.
  document.documentElement.classList.add('overlay-window');
  root.render(
    <ErrorBoundary silent>
      <TipToast />
    </ErrorBoundary>,
  );
} else if (gvWindow === 'notify') {
  // Третье окно: свои всплывающие уведомления на ПК (G38, ND-07, `notify_popup.rs`). Тот же прозрачный фон — видны
  // только карточки; ни приложения, ни апдейтера, ни пушей.
  document.documentElement.classList.add('overlay-window');
  // Тема и масштаб интерфейса сменились в главном окне (общий localStorage) — карточки следом, без перезапуска: окно живёт,
  // пока живёт приложение. Перемерить стопку под новый масштаб — забота `NotifyPopups` (тот же `storage`).
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === 'gv_theme') applyTheme(getTheme());
    if (e.key === null || e.key === 'gv_ui_scale') applyUiScale(getUiScale());
  });
  root.render(
    <ErrorBoundary silent>
      <NotifyPopups />
    </ErrorBoundary>,
  );
} else if (gvWindow === 'splash') {
  // Заставка при запуске десктопа (15.10, `SplashScreen`, `splash.rs`): окно 300×340 БЕЗ приложения, пушей и
  // опроса — проверяет и ставит обновление, потом показывает главное окно. Всегда тёмная (фон окна в
  // `tauri.windows.conf.json` тот же `--bg`) и без масштаба интерфейса: окно фиксированного размера.
  document.documentElement.classList.add('splash-window');
  document.documentElement.removeAttribute('data-theme');
  (document.documentElement.style as unknown as { zoom: string }).zoom = '';
  root.render(
    <ErrorBoundary silent>
      <SplashScreen />
    </ErrorBoundary>,
  );
} else {
  // Кольца загрузки у вложений строк «в пути» очереди ЛС (07.10): прогресс мимо стора, `convStore.bindUploadProgress`.
  bindUploadProgress({ progress: setUploadProgress, done: setUploadDone, clear: clearUploadProgress });
  // Файлы ЛС больше куска — кусками (`bigfile1`, 09.10): привязка в `api.ts`, предел и признак — `attachRules` из `/auth/me`.
  bindChunkedUpload({ use: (size) => dmChunkedUploads() && size > CHUNK_FROM_BYTES, run: uploadInChunks });
  // ЛС между инстансами, Э5 (#141, `fedm5`): «мой дом лежит — пишу через инстанс собеседника» (`fedVia.ts`), привязка к стору бесед.
  startFedVia();
  // «Был(а)» не врёт после сна вкладки и обрыва шлюза (Э7 ч.3, D): перезапрос времени захода (`lastSeenRefresh.ts`).
  startLastSeenRefresh();
  // Название своего инстанса для подписи «через «…»» у получателя (Э7 ч.3, D; `selfInstanceName.ts`).
  startSelfInstanceName();
  // Своя полоса окна десктопа (#219, `titleBar.ts`): системной у главного окна нет (`decorations: false`).
  // Отдельный корень ДО `#root` и вне `App`: упадёт приложение — полоса с крестиком останется.
  if (hasOwnTitleBar()) {
    document.documentElement.classList.add('gv-frameless');
    const bar = document.createElement('div');
    bar.id = 'gv-titlebar-root';
    document.body.insertBefore(bar, document.body.firstChild);
    createRoot(bar).render(
      <ErrorBoundary silent>
        <WindowTitleBar />
      </ErrorBoundary>,
    );
  }
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );

  // Гасим родное меню браузера (#75): в приложении «Печать», «Сохранить как» и «Отправить вкладку
  // на свои устройства» неуместны — в десктопе это прямо читается как «я всё ещё в браузере».
  // ⚠️ Не глушим там, где меню НУЖНО: поле ввода («Вставить» — иначе мышью в десктопе не вставить),
  // выделенный текст («Копировать»), ссылки («Копировать адрес») и медиа-КОНТЕНТ чата («Сохранить»).
  // Медиа-контент помечен `data-ctxsave` на самом элементе — аватар/иконка/эмодзи это тоже <img>,
  // но интерфейс, и «Сохранить изображение» на них не нужно. Правило — в `contextMenuRules.ts`,
  // под тестами; здесь только сбор признаков из события.
  window.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    const tag = el.tagName?.toLowerCase() ?? '';
    const inputType = tag === 'input' ? ((el as HTMLInputElement).type ?? '') : '';
    const editable =
      isEditableTag(tag, inputType) || !!el.closest?.('[contenteditable=""], [contenteditable="true"]');
    // ⚠️ Выделение — состояние ВСЕЙ страницы, а не места клика. Пока проверяли просто «есть ли
    // выделенный текст», одно забытое выделение в чате возвращало родное меню в любой точке
    // интерфейса — тестер словил его на всей панели инстансов. Меню с «Копировать» нужно там, куда
    // ткнули, поэтому требуем, чтобы выделение пересекалось с целью клика.
    const sel = window.getSelection();
    const hasSelection =
      !!sel && !sel.isCollapsed && !!sel.toString().trim() && sel.rangeCount > 0 && sel.getRangeAt(0).intersectsNode(el);
    const inLink = !!el.closest?.('a[href]');
    const savableMedia = !!el.closest?.('[data-ctxsave]');
    if (!keepNativeMenu({ editable, hasSelection, inLink, savableMedia })) e.preventDefault();
  });

  // Телефон: выделение системой там, где `user-select: none`, снимаем сразу (страховка к CSS — иначе тап по кнопке его не снимает
  // и подпись вкладки горит выделенной «всё время», 0.8.21). Правило — `phoneSelectionRules.ts`, под тестами.
  const phoneMq = window.matchMedia('(max-width: 760px)');
  // Значения `user-select` от элемента к предкам; расчёт «что действует» — чистая `effectiveUserSelect` (`phoneSelectionRules.ts`).
  const userSelectChain = (el: Element | null): string[] => {
    const out: string[] = [];
    for (let e = el; e; e = e.parentElement) out.push(getComputedStyle(e).userSelect);
    return out;
  };
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode) return;
    const at = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
    const a = document.activeElement;
    if (
      shouldDropSelection({
        phone: phoneMq.matches,
        collapsed: false,
        fieldFocused: a instanceof HTMLElement && (a.isContentEditable || a.matches('textarea, input')),
        anchorUserSelect: effectiveUserSelect(userSelectChain(at)),
      })
    )
      sel.removeAllRanges();
  });

  // Та же дыра, но с клавиатуры: меню погасили, а Ctrl+P печатал чат (проверено тестером). Правило —
  // в `browserShortcuts.ts` под тестами; здесь только сбор признаков. capture, чтобы успеть раньше
  // полей ввода и редакторов.
  window.addEventListener(
    'keydown',
    (e) => {
      if (isBlockedBrowserShortcut({ key: e.key, ctrlOrMeta: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey }))
        e.preventDefault();
    },
    true,
  );

  // Desktop only (no-op on web):
  //  1) if a previous session installed an update, show a persistent "обновлён до vX" toast (consumes marker);
  //  2) on launch, silently auto-update to the latest signed build (then offers restart) — unless the Windows
  //     launch splash already did it (`runLaunchUpdate`, `SplashScreen`);
  //  3) every 30 min while open, NON-intrusively OFFER any newer build (a small "Обновить?" card, no auto-install).
  notifyIfJustUpdated();
  void runLaunchUpdate();
  startUpdatePolling();
  ensureNotifyPermission();

  // Android only (no-op elsewhere): register this device for UnifiedPush push so DMs/@mentions wake it
  // even when the app is closed. Re-attempts on foreground (covers logging in after boot).
  initPushRegistration();

  // Desktop only: узнаём у оболочки, когда наше окно целиком накрыто чужим (игрой), и замораживаем
  // анимации — рисовать невидимое незачем (#193). Решение принимается по геометрии окон, поэтому на
  // втором мониторе, где окно видно, ничего не замирает.
  watchWindowCovered();
}
