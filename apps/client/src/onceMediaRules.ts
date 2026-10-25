import { isOnceMedia, ONCE_TTL_MAX, type Attachment } from '@gusvoice/shared';

/**
 * Одноразовые фото и видео ЛС (19.10, #226, признак сервера `ttlmedia1`) — чистые правила без DOM. Как у Telegram Desktop
 * (`boxes/send_files_box.cpp`, пункт меню файла «Self-Destruct Timer»): «Просмотр один раз», 3, 10, 30 секунд, «Не удалять»
 * и своё время 1…60 с; только фото и видео кадром (не «как файлы», не GIF), только в личке 1:1 с человеком, отдельным
 * сообщением (не альбомом) и не отложенным (`lng_ttl_no_schedule`). Код Telegram не копирован.
 */

/** «Просмотр один раз» — без таймера: сгорает при закрытии просмотра. */
export const ONCE_VIEW = 0;
/** Готовые таймеры меню, с (tdesktop: 3, 10, 30). */
export const ONCE_TTL_PRESETS: readonly number[] = [3, 10, 30];
/** Своё время в меню по умолчанию, с (tdesktop `initial = 10`). */
export const ONCE_TTL_CUSTOM_DEFAULT = 10;

/** «3 секунды», «10 секунд», «21 секунда». */
export function secondsLabel(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'секунда' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'секунды' : 'секунд';
  return `${n} ${word}`;
}

/** Своё значение (не «один раз» и не готовый таймер) — пункт «Своё время (N с)» с галочкой. */
export function isCustomTtl(ttl: number | null): boolean {
  return ttl !== null && ttl !== ONCE_VIEW && !ONCE_TTL_PRESETS.includes(ttl);
}

/** Таймер в допустимых пределах: `ONCE_VIEW` или 1…60 с; иначе — `null` («Не удалять»). */
export function clampTtl(ttl: number | null): number | null {
  if (ttl === null || !Number.isFinite(ttl)) return null;
  const n = Math.round(ttl);
  if (n === ONCE_VIEW) return ONCE_VIEW;
  return n >= 1 && n <= ONCE_TTL_MAX ? n : null;
}

/** Значок на плитке: «1» у «просмотра один раз», число секунд — у таймера. */
export function onceBadge(ttl: number): string {
  return ttl === ONCE_VIEW ? '1' : String(ttl);
}

/** Можно ли файлу окна отправки поставить таймер: фото или видео, показанные кадром (не «как файлы», не GIF). */
export function canSetOnce(file: { type: string }, asFile: boolean): boolean {
  if (asFile) return false;
  if (file.type === 'image/gif') return false;
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/**
 * Разбивка плана отправки: одноразовые файлы — каждый своим сообщением (Telegram не собирает их в альбом), остальные остаются
 * группами как были. Подпись и ответ остаются у первого сообщения плана.
 */
export function splitOncePlan<F>(
  plan: readonly { files: F[]; content: string }[],
  once: ReadonlyMap<F, number>,
): { files: F[]; content: string; onceTtl?: number }[] {
  const out: { files: F[]; content: string; onceTtl?: number }[] = [];
  for (const p of plan) {
    const rest = p.files.filter((f) => !once.has(f));
    const singles = p.files.filter((f) => once.has(f));
    if (singles.length === 0) {
      out.push({ files: p.files, content: p.content });
      continue;
    }
    let content = p.content;
    for (const f of singles) {
      out.push({ files: [f], content, onceTtl: once.get(f)! });
      content = '';
    }
    if (rest.length > 0) out.push({ files: rest, content });
  }
  return out;
}

/** Подсказки вложения для отправки: `once` и (у таймера) `onceTtl`. */
export function onceRefFields(ttl: number | undefined): { once?: true; onceTtl?: number } {
  if (ttl === undefined) return {};
  return ttl === ONCE_VIEW ? { once: true } : { once: true, onceTtl: ttl };
}

/** Одноразовое фото/видео (пометка сервера) — плитка «закрыто» вместо кадра. */
export function isOnceAttachment(a: Attachment): boolean {
  return isOnceMedia(a);
}

/**
 * Когда просмотр закрывается сам, мс: от первого открытия — таймер (у видео — не раньше конца ролика); у «просмотра один
 * раз» — `null` (только по закрытию). Сервер жжёт с запасом (`onceOpenLimitMs`).
 */
export function onceDeadline(a: { onceTtl?: number; durationMs?: number | null; contentType: string }, openedAtMs: number): number | null {
  if (!a.onceTtl) return null;
  const video = a.contentType.startsWith('video/') ? (a.durationMs ?? 0) : 0;
  return openedAtMs + Math.max(a.onceTtl * 1000, video);
}

/**
 * Срок просмотра по СВОИМ часам (19.10, приёмка dev: часы ПК отставали от сервера на 5–6 с → вместо 10 с шло 15 с). Остаток —
 * срок от первого открытия минус то, что уже прошло по серверным часам (`serverNow − openedAt`, не меньше 0; при первом
 * открытии ≈ 0), и отсчёт идёт от МОМЕНТА ПОЛУЧЕНИЯ ответа на своих часах (`receivedAtMs`). Часы устройства с сервером не
 * сравниваются. Старый сервер без `serverNow` — полный срок от получения ответа.
 */
export function onceDeadlineLocal(
  a: { onceTtl?: number; durationMs?: number | null; contentType: string },
  openedAtMs: number,
  serverNowMs: number,
  receivedAtMs: number,
): number | null {
  const span = onceDeadline(a, 0); // полный срок, мс
  if (span === null) return null;
  const elapsed = Number.isFinite(openedAtMs) && Number.isFinite(serverNowMs) ? Math.max(0, serverNowMs - openedAtMs) : 0;
  return receivedAtMs + Math.max(0, span - elapsed);
}

/** Сколько секунд осталось (вверх, не меньше 0). */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
