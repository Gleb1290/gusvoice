/**
 * Правила каталога аккаунтов (#139, F2, план §5.2) — кого отдавать соседям и как нарезать на страницы.
 *
 * Чистый модуль: ни базы, ни сети, ни часов. Здесь решается единственный по-настоящему опасный
 * вопрос федерации каталога — **что именно уходит наружу**, и его хочется проверять построчно, а не
 * через живой инстанс.
 */

import { createHash } from 'node:crypto';
import { FED_DIRECTORY_REMOVED, type FedDirectoryEntry } from '@gusvoice/shared';

/** Строка `users` в том объёме, в каком её видят правила каталога. */
export interface DirectorySource {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
  /** `null` — аккаунт ждёт одобрения держателя (политика `approval`) и войти ещё не может. */
  approvedAt: Date | null;
  /** Аккаунт удалён — строка обезличена, но осталась (§5.6.2). */
  deletedAt: Date | null;
  /** Админ инстанса скрыл человека от соседей (§5.2.1). */
  hiddenFromPeers: boolean;
  /** Не `null` — это ТЕНЕВАЯ строка гостя с другого инстанса (F3). */
  homeInstanceId: string | null;
  /** Когда запись каталога менялась последний раз (мс эпохи, наши часы). */
  directoryUpdatedAt: number;
}

/**
 * Отпечаток картинки — аватара человека или иконки сервера: по его смене хост решает, качать ли
 * картинку заново (§5.4).
 *
 * Считается от АДРЕСА, а не от содержимого файла, и это осознанно: каждая загрузка кладёт новый
 * объект со своим именем, значит смена адреса и есть смена картинки. Читать мегабайты из хранилища
 * ради отпечатка пришлось бы на каждый запрос каталога.
 */
export function mediaHashOf(url: string | null): string | null {
  if (!url) return null;
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 32);
}

/** Отпечаток аватара — он же способ понять, что картинку пора перекачать (§5.4). */
export const avatarHashOf = mediaHashOf;

/**
 * Во что превращается строка `users` для соседа.
 *
 * `null` — записи в каталоге нет ВОВСЕ, и надгробия тоже: сосед о ней никогда не слышал. Так уходят
 * неподтверждённые, неодобренные и 🔴 **гости с третьих инстансов** — иначе список людей инстанса C
 * утекал бы к B через нас (план §5.2).
 */
export function directoryEntryOf(u: DirectorySource): FedDirectoryEntry | null {
  // Гость с третьего инстанса: он не наш человек, и рассказывать о нём мы не вправе.
  if (u.homeInstanceId !== null) return null;

  if (u.deletedAt !== null) {
    return { userId: u.userId, updatedAt: u.directoryUpdatedAt, removed: FED_DIRECTORY_REMOVED.deleted };
  }
  // Неподтверждённый и неодобренный не попадали к соседу ни разу — значит и убирать нечего: даже
  // надгробия (иначе скрытый до подтверждения выдавал бы соседу id человека, которого тот не видел, F-24).
  if (!u.verified || u.approvedAt === null) return null;
  if (u.hiddenFromPeers) {
    // 🔴 Надгробие БЕЗ имени: скрытый скрыт и от того, кто читает причину исчезновения.
    return { userId: u.userId, updatedAt: u.directoryUpdatedAt, removed: FED_DIRECTORY_REMOVED.hidden };
  }

  return {
    userId: u.userId,
    updatedAt: u.directoryUpdatedAt,
    username: u.username,
    displayName: u.displayName,
    avatarHash: avatarHashOf(u.avatarUrl),
  };
}

/** Сколько записей в странице. Больше предела сосед попросить не может — это его способ нас нагрузить. */
export const DIRECTORY_PAGE_DEFAULT = 200;
export const DIRECTORY_PAGE_MAX = 500;

/**
 * Перекрытие при следующей дельте.
 *
 * 🔴 Без него теряются записи, изменённые В ТУ ЖЕ секунду, что и снимок: транзакция могла ещё не
 * зафиксироваться, когда мы посчитали `now`, — и при строгом `updated_at > now` она не попала бы ни
 * в эту дельту, ни в следующую. Повторно присланная запись безвредна (кладётся поверх той же).
 */
export const SINCE_OVERLAP_MS = 5_000;

export interface DirectoryQuery {
  /** `null` — полная выдача (сверка): сосед заменит свой кеш целиком. */
  since: number | null;
  /** Откуда продолжать страницу: последняя отданная пара (время, идентификатор). */
  after: { updatedAt: number; id: string } | null;
  limit: number;
}

export type QueryProblem = 'bad-since' | 'bad-cursor' | 'bad-limit';

/** Курсор — непрозрачная для соседа строка: пара «время + идентификатор» в base64url. */
export function encodeCursor(updatedAt: number, id: string): string {
  return Buffer.from(`${updatedAt}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { updatedAt: number; id: string } | null {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const updatedAt = Number(text.slice(0, at));
  const id = text.slice(at + 1);
  if (!Number.isFinite(updatedAt) || id.length === 0) return null;
  return { updatedAt, id };
}

/**
 * Разобрать параметры запроса каталога.
 *
 * 🔴 Негодный курсор — ОТКАЗ, а не «начнём сначала»: молчаливый откат к началу превращает разбитую
 * страницами выдачу в бесконечный круг, который снаружи выглядит как работающая синхронизация.
 */
export function parseDirectoryQuery(raw: {
  since?: string | null;
  cursor?: string | null;
  limit?: string | null;
}): { ok: true; value: DirectoryQuery } | { ok: false; problem: QueryProblem } {
  let since: number | null = null;
  if (raw.since !== undefined && raw.since !== null && raw.since !== '') {
    const n = Number(raw.since);
    if (!Number.isFinite(n) || n < 0) return { ok: false, problem: 'bad-since' };
    since = n;
  }

  let after: { updatedAt: number; id: string } | null = null;
  if (raw.cursor !== undefined && raw.cursor !== null && raw.cursor !== '') {
    const decoded = decodeCursor(raw.cursor);
    if (!decoded) return { ok: false, problem: 'bad-cursor' };
    after = decoded;
  }

  let limit = DIRECTORY_PAGE_DEFAULT;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== '') {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, problem: 'bad-limit' };
    // Слишком большой предел не ошибка соседа, а его надежда: молча сужаем до своего максимума.
    limit = Math.min(n, DIRECTORY_PAGE_MAX);
  }

  return { ok: true, value: { since, after, limit } };
}

/**
 * Курсор следующей страницы — или `null`, если это была последняя.
 *
 * ⚠️ Страница СЧИТАЕТСЯ полной по числу строк, взятых из базы, а не по числу отданных записей:
 * часть строк отсеивается правилами (гости, неподтверждённые), и «отдали меньше предела» не значит
 * «строки кончились». Иначе синхронизация обрывалась бы на первой же странице с отсевом.
 */
export function nextCursorOf<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => { updatedAt: number; id: string },
): string | null {
  if (rows.length < limit) return null;
  const last = key(rows[rows.length - 1]);
  return encodeCursor(last.updatedAt, last.id);
}

/** С какого времени просить следующую дельту: часы ОТДАЮЩЕГО минус перекрытие (см. выше). */
export function nextSinceFrom(peerNow: number): number {
  return Math.max(0, peerNow - SINCE_OVERLAP_MS);
}
