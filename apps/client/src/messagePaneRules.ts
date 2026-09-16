import { emojiForCode } from './emojiShortcodes';

/**
 * Правила ленты сообщений и композера — чистые, БЕЗ React и DOM.
 *
 * Вынуто из `MessagePane.tsx` по просьбе Codex (2026-07-27): жило внутри компонента на 1300 строк,
 * то есть проверялось только набором текста руками. Ошибка в композере ломает ввод молча (список
 * подсказок не открылся, `:code:` не превратился в эмодзи, замена съела соседний символ), а ошибка в
 * ленте рисует разделитель «Новые сообщения» не там, где человек остановился.
 */

// ---- Композер: автодополнение --------------------------------------------------------------

export type AcTrigger = '@' | '#' | ':';

export interface AcToken {
  trigger: AcTrigger;
  query: string;
  /** Индекс символа-триггера в тексте (`:`/`@`/`#`), с него начинается замена. */
  start: number;
}

/**
 * Токен автодополнения под кареткой, либо `null`.
 *
 * ⚠️ `:code` требует минимум ДВУХ символов, иначе список открывался бы на каждом руками набранном
 * смайлике («:)»).
 * ⚠️ Перед триггером обязателен пробел или начало строки — это то, что оставляет в покое `10:30`,
 * `http://host:8080` и почту вида `a@b`.
 * ⚠️ `@`/`#` работают только там, где есть серверный контекст (`serverScoped`): в ЛС ни ролей, ни
 * каналов нет, и подсказка была бы про пустоту.
 */
export function acTokenAt(value: string, caret: number | null, serverScoped: boolean): AcToken | null {
  if (caret == null) return null;
  const head = value.slice(0, caret);
  const em = /(^|\s):([\p{L}\p{N}_+-]{2,})$/u.exec(head);
  if (em) return { trigger: ':', query: em[2], start: caret - em[2].length - 1 };
  const m = serverScoped ? /(^|\s)([@#])([\p{L}\p{N}_.-]*)$/u.exec(head) : null;
  if (m) return { trigger: m[2] as '@' | '#', query: m[3], start: caret - m[3].length - 1 };
  return null;
}

/**
 * Подставить выбранную подсказку вместо набранного токена. Возвращает новый текст и позицию каретки.
 * ⚠️ Пробел после вставки добавляется намеренно: следующее слово почти всегда идёт сразу, а без него
 * каретка липнет к вставленному имени и следующий символ дописывается внутрь упоминания.
 */
export function applyAc(text: string, ac: AcToken, insert: string): { text: string; caret: number } {
  const before = text.slice(0, ac.start);
  const after = text.slice(ac.start + 1 + ac.query.length);
  const withSpace = `${insert} `;
  return { text: before + withSpace + after, caret: (before + withSpace).length };
}

// ---- Композер: замена `:code:` на эмодзи ----------------------------------------------------

/**
 * `:fire:` → 🔥 в момент, когда набрана закрывающая двоеточие. Возвращает `null`, если заменять
 * нечего.
 *
 * Подсказка из пикера это обещает, а список автодополнения сам по себе не справлялся: закрывающее
 * `:` завершает токен, список закрывается, и текст остаётся буквальным.
 *
 * ⚠️ Требуется пробел (или начало строки) перед открывающим двоеточием И ТОЧНО известный код —
 * именно это оставляет целыми `10:30:` и `http://host:8080:`: ни у одного нет пробела перед
 * подходящим кодом.
 */
export function emojiSubstitution(value: string, caret: number | null): { text: string; caret: number } | null {
  if (caret == null) return null;
  const m = /(^|\s):([\p{L}\p{N}_+-]{2,}):$/u.exec(value.slice(0, caret));
  if (!m) return null;
  const emoji = emojiForCode(m[2]);
  if (!emoji) return null;
  const start = caret - (m[2].length + 2); // ':' + code + ':'
  return { text: value.slice(0, start) + emoji + value.slice(caret), caret: start + emoji.length };
}

// ---- Лента: разделитель непрочитанного и группировка ----------------------------------------

/** Минимум полей сообщения, нужный правилам ленты. */
export interface ListMessage {
  createdAt: string;
  authorId: string;
  /** Есть ли цитата-ответ (такое сообщение всегда начинает новый блок). */
  hasReply?: boolean;
}

/** Подряд идущие сообщения одного автора в пределах этого окна схлопываются в группу. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Первое сообщение новее последнего визита — над ним рисуется «Новые сообщения» (#15).
 *
 * ⚠️ Своё сообщение новостью не считается: человек его сам и написал.
 * ⚠️ Условие `prev <= newSince` — это то, что делает разделитель ЕДИНСТВЕННЫМ: без него он повторился
 * бы над каждым новым сообщением подряд.
 */
export function isFirstUnread(
  m: ListMessage,
  prev: ListMessage | undefined,
  meId: string | undefined,
  newSince: number | null | undefined,
): boolean {
  if (!newSince) return false;
  if (new Date(m.createdAt).getTime() <= newSince) return false;
  if (m.authorId === meId) return false;
  return !prev || new Date(prev.createdAt).getTime() <= newSince;
}

/**
 * Схлопывать ли сообщение с предыдущим (шапка «аватар + имя + время» показывается только у первого).
 * ⚠️ Ответ всегда начинает новый блок, иначе цитата читается как продолжение чужой мысли.
 */
export function isGrouped(m: ListMessage, prev: ListMessage | undefined): boolean {
  if (!prev || prev.authorId !== m.authorId || m.hasReply) return false;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() <= GROUP_WINDOW_MS;
}
