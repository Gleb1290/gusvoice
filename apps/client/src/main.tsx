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
import { VoiceOverlay } from './components/VoiceOverlay';
import { TipToast } from './components/TipToast';
import './styles.css';
import { applyTheme, getTheme } from './theme';
import { applyUiPrefs } from './uiPrefs';
import { initPushRegistration } from './nativeUnifiedPush';
import { ensureNotifyPermission } from './notifications';
import { notifyIfJustUpdated, runDesktopUpdateCheck, startUpdatePolling } from './updater';

applyTheme(getTheme());
applyUiPrefs();

const root = createRoot(document.getElementById('root')!);

// The desktop in-game overlay runs in a SEPARATE always-on-top window that loads the same bundle with
// `?window=overlay`. There it renders just the voice widget (transparent bg) — no app, no updater/push.
const gvWindow = new URLSearchParams(location.search).get('window');
if (gvWindow === 'overlay') {
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
} else {
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
  //  2) on launch, silently auto-update to the latest signed build (then offers restart);
  //  3) every 30 min while open, NON-intrusively OFFER any newer build (a small "Обновить?" card, no auto-install).
  notifyIfJustUpdated();
  void runDesktopUpdateCheck();
  startUpdatePolling();
  ensureNotifyPermission();

  // Android only (no-op elsewhere): register this device for UnifiedPush push so DMs/@mentions wake it
  // even when the app is closed. Re-attempts on foreground (covers logging in after boot).
  initPushRegistration();
}
