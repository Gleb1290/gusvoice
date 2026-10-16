/**
 * Своё сообщение в ленте СРАЗУ, до ответа сервера (#194, 23.09) — чистые правила списка «в пути».
 *
 * 🔴 **Откуда взялось.** Нажал «отправить» — поле очистилось сразу (очередь 19.09), а само сообщение
 * появлялось в ленте только по ответу сервера, с задержкой в пинг; на плохой сети казалось, что оно
 * потерялось. Показывать сразу долго не решались по одной причине: сервер может отказать (нет прав,
 * мут, слишком длинное, упала сеть), и в ленте осталось бы сообщение, которого нет ни у кого.
 *
 * Поэтому оно рисуется БЛЕДНЫМ «отправляется» и живёт в своём списке, а не среди настоящих:
 * - ответ пришёл — строка уходит, её место занимает настоящее сообщение (то, что вернул сервер);
 * - отказ — строка остаётся с пометкой «не отправлено» и кнопками «Повторить» / «Удалить». Текст не
 *   пропадает и не возвращается молча в поле (раньше при отказе он возвращался, только если поле
 *   было пустым, — иначе уезжал в тост и терялся).
 *
 * Список живёт в компоненте ленты, а не в сторе: он про ЭТО окно ввода, и после перезагрузки его быть
 * не должно — неотправленное тогда честно пропадает вместе с набранным текстом, как было всегда.
 */

import { fedErrorText, isFedErrorCode, messageErrorText } from './fedErrorText';
import { humanLengthError } from './longTextRules';

export type OutgoingStatus = 'sending' | 'failed';

export interface OutgoingMessage<F = File> {
  /** Свой ключ строки — у сообщения в пути ещё нет id от сервера. */
  key: string;
  content: string;
  files: F[];
  replyToId: string | null;
  status: OutgoingStatus;
  /** Почему не ушло — словами, для строки «не отправлено». */
  error: string | null;
}

export function addOutgoing<T extends OutgoingMessage<unknown>>(list: readonly T[], item: T): T[] {
  return [...list, item];
}

/** Сервер ответил — строка уходит: настоящее сообщение уже в ленте. */
export function outgoingSent<T extends OutgoingMessage<unknown>>(list: readonly T[], key: string): T[] {
  return list.filter((x) => x.key !== key);
}

export function outgoingFailed<T extends OutgoingMessage<unknown>>(list: readonly T[], key: string, error: string): T[] {
  return list.map((x) => (x.key === key ? { ...x, status: 'failed' as const, error } : x));
}

/** «Повторить» — строка снова «отправляется», прежняя ошибка стирается. */
export function outgoingRetry<T extends OutgoingMessage<unknown>>(list: readonly T[], key: string): T[] {
  return list.map((x) => (x.key === key ? { ...x, status: 'sending' as const, error: null } : x));
}

/**
 * Текст отказа для строки. `null` — отказ не про это сообщение: человек ушёл в другой инстанс, пока
 * запрос летел (метка `switched`, та же, что гасит тост в `toastError`), — строку тогда просто убираем.
 */
export function sendErrorText(e: unknown): string | null {
  if ((e as { switched?: boolean } | null)?.switched === true) return null;
  const raw = e instanceof Error ? e.message : String(e);
  // Сырая строка проверки длины (zod) от сервера постарше — словами (07.10).
  return (isFedErrorCode(raw) && fedErrorText(raw)) || messageErrorText(raw) || humanLengthError(raw) || raw || 'не удалось отправить';
}

/** Подпись вложений в строке «в пути»: «photo.png», «photo.png и ещё 2». */
export function outgoingFilesLabel(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : `${names[0]} и ещё ${names.length - 1}`;
}
