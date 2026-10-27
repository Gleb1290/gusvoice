import { api } from './api';
import { attIdOfLink, isAttLink } from './attLinkRules';

/**
 * Свежие ссылки на файлы ЛС (аудит ЛС #236, п.6). У ссылки `/api/att/<id>/<смотрящий>/<подпись>.<срок>` теперь срок
 * (сервер: `attachmentRules.attLinkExpiry`, 24–48 ч), а лента, просмотрщик, «Общие медиа», голосовые и кружки держат
 * сообщения часами. Истёкшая ссылка — 404: здесь клиент просит новую по id вложения (`POST /api/att/links`) и пробует снова.
 *
 * Входы (все — одной точкой `installAttLinkRenewal`, чтобы не пропустить ни одного и не трогать модули с закрытым
 * перечнем импортов):
 * - `<img>`, `<video>`, `<audio>`, `<source>` в документе (лента, просмотрщик, «Общие медиа», кружки) — перехват `error` на
 *   фазе захвата: события ошибки загрузки не всплывают, но захват на `document` их видит;
 * - плеер голосовых вне документа (`voicePlayer`) — шлёт событие `gv-att-error` с элементом;
 * - скачивание, копирование, сохранение (`fetch` в `fileActions` / `imageActions` / `nativeMedia`) — обёртка `fetch`:
 *   404/403 по ссылке файла ЛС — новая ссылка и второй запрос. Прочие запросы обёртка не трогает.
 * Ссылки чужого инстанса (беседа через связку другого аккаунта) не продлеваются: их выдаёт не наш API.
 */

const BATCH_MS = 30;
/** Одна попытка на ссылку: новая ссылка тоже не открылась — файла нет или доступа нет, повтор не поможет. */
const tried = new Set<string>();
const fresh = new Map<string, Promise<string | null>>();
let queue: { id: string; resolve: (url: string | null) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function ours(url: string): boolean {
  try {
    return new URL(url).origin === new URL(api.apiBaseUrl() || window.location.origin, window.location.href).origin;
  } catch {
    return false;
  }
}

function flush(): void {
  timer = null;
  const batch = queue;
  queue = [];
  const ids = [...new Set(batch.map((b) => b.id))];
  api
    .attLinks(ids)
    .then((r) => batch.forEach((b) => b.resolve(r.links[b.id] ?? null)))
    .catch(() => batch.forEach((b) => b.resolve(null)));
}

/** Новая ссылка на тот же файл; `null` — не наша ссылка, уже пробовали или сервер не отдал (нет доступа). */
export function renewAttLink(url: string): Promise<string | null> {
  if (!isAttLink(url) || !ours(url)) return Promise.resolve(null);
  const id = attIdOfLink(url);
  if (!id || tried.has(url)) return Promise.resolve(null);
  tried.add(url);
  const known = fresh.get(id);
  if (known) return known;
  const p = new Promise<string | null>((resolve) => {
    queue.push({ id, resolve });
    timer ??= setTimeout(flush, BATCH_MS);
  });
  fresh.set(id, p);
  // Новая ссылка тоже когда-нибудь истечёт: держим обещание только до ответа, следующая ошибка спросит снова.
  void p.then((u) => {
    fresh.delete(id);
    if (u) tried.delete(u);
  });
  return p;
}

/** Медиа-элемент с истёкшей ссылкой — новая ссылка с того же места воспроизведения. */
export function renewMediaElement(el: HTMLImageElement | HTMLMediaElement | HTMLSourceElement): void {
  const src = el instanceof HTMLMediaElement ? el.currentSrc || el.getAttribute('src') || '' : el.getAttribute('src') || '';
  if (!src) return;
  void renewAttLink(src).then((next) => {
    if (!next || next === src) return;
    if (el instanceof HTMLMediaElement) {
      const at = el.currentTime;
      const wasPlaying = !el.paused;
      el.src = next;
      if (at > 0) el.addEventListener('loadedmetadata', () => (el.currentTime = at), { once: true });
      if (wasPlaying) void el.play().catch(() => {});
    } else if (el instanceof HTMLSourceElement) {
      el.src = next;
      const media = el.parentElement;
      if (media instanceof HTMLMediaElement) media.load();
    } else {
      el.src = next;
    }
  });
}

let installed = false;
/** Перехват ошибок загрузки медиа в документе (один раз, из `main.tsx`). */
export function installAttLinkRenewal(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (el instanceof HTMLImageElement || el instanceof HTMLMediaElement || el instanceof HTMLSourceElement) renewMediaElement(el);
    },
    true,
  );
  document.addEventListener('gv-att-error', (e) => {
    const el = (e as CustomEvent<unknown>).detail;
    if (el instanceof HTMLMediaElement) renewMediaElement(el);
  });
  if (typeof window.fetch === 'function') {
    const plain = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = await plain(input, init);
      if ((res.status !== 404 && res.status !== 403) || !isAttLink(url)) return res;
      const next = await renewAttLink(url);
      return next ? plain(next, init) : res;
    };
  }
}
