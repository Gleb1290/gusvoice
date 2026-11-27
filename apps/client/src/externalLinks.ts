import { openExternal } from './desktopWindow';
import { isAndroid, isDesktop } from './hotkeys';
import { toast } from './toast';

/**
 * Внешние ссылки в десктопе (30.10, повторяющийся баг «кнопка-ссылка не работает»): в WebView2 `<a target="_blank">`
 * молча ничего не делает, а переход самой страницы на чужой адрес теряет хранилище окна (#43). Один общий перехватчик
 * вместо правки каждой ссылки: клик по ссылке «в новой вкладке» или на чужой http(s)-адрес уходит в системный браузер.
 *
 * Слушает ВСПЛЫТИЕ на `window` — после обработчиков React: ссылку, которую уже обработали сами (`linkGuard` с окном
 * «Открыть ссылку?», `openLink`), пропускает по `defaultPrevented`, поэтому предупреждение о подозрительной ссылке
 * не обходится. Не трогает клики с модификаторами, не левой кнопкой, `download`, свой адрес без `target="_blank"`, не http(s) (нативный `gv_open_external` берёт только их).
 */
export function externalLinkHref(e: MouseEvent, origin: string): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return null;
  const start = e.target as Element | null;
  const a = start && typeof start.closest === 'function' ? (start.closest('a[href]') as HTMLAnchorElement | null) : null;
  if (!a || a.hasAttribute('download')) return null;
  let url: URL;
  try {
    url = new URL(a.getAttribute('href') || '', origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const blank = (a.getAttribute('target') || '').toLowerCase() === '_blank';
  if (!blank && url.origin === origin) return null;
  return url.href;
}

/** На Android передаём ссылку системе. При отказе моста оставляем чат открытым. */
export function openAndroidWebLink(raw: string): boolean {
  if (!isAndroid()) return false;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const bridge = (window as Window & {
        GusVoiceNative?: { openExternalUri?: (uri: string, fallback: string) => boolean };
      }).GusVoiceNative;
      if (bridge?.openExternalUri?.(url.href, '')) return true;
    }
  } catch { /* Показываем общую ошибку, оставляя чат на экране. */ }
  toast('warn', 'Не удалось открыть ссылку во внешнем приложении');
  return true;
}

export function installExternalLinks(): void {
  if (typeof window === 'undefined' || (!isDesktop() && !isAndroid())) return;
  window.addEventListener('click', (e) => {
    const href = externalLinkHref(e, window.location.origin);
    if (!href) return;
    e.preventDefault();
    if (openAndroidWebLink(href)) return;
    void openExternal(href).catch(() => {});
  });
}
