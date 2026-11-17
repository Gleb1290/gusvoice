import { openExternal } from './desktopWindow';
import { isDesktop } from './hotkeys';

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

export function installExternalLinks(): void {
  if (typeof window === 'undefined' || !isDesktop()) return;
  window.addEventListener('click', (e) => {
    const href = externalLinkHref(e, window.location.origin);
    if (!href) return;
    e.preventDefault();
    void openExternal(href).catch(() => {});
  });
}
