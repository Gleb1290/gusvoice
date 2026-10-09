/**
 * Правила полосы закрепа (`PinnedBar`, раунд 12, `docs/design/design-step12/HANDOFF.md` §2.3) — ЧИСТОЕ, без React.
 */

/** Сколько держать палец на полосе, чтобы открылся список закреплённых (как долгое нажатие на пузыре ленты). */
export const PIN_BAR_LONG_PRESS_MS = 500;

/** Сколько делений слева от текста полосы — не больше четырёх (HANDOFF §2.3). */
export const PIN_BAR_SEGMENTS_MAX = 4;

/** Сколько закреплено: целое не меньше нуля (`NaN`, дробь и минус — мусор от зовущего, полоса из них не рисуется). */
function total(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/** Какое закреплённое показано: `index` прижат к `0 … count − 1` (0 — самое старое); не число — 0. */
export function clampPinIndex(count: number, index: number): number {
  const n = total(count);
  if (n === 0) return 0;
  return Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : 0, 0), n - 1);
}

/**
 * Деления слева от текста полосы: по одному на закреплённое, но не больше четырёх; закреплённых больше — окно из четырёх
 * вокруг текущего, и оно скользит вместе с ним. Сверху вниз — от старого к новому, как в ленте; `true` — горит текущее.
 *
 * Окно — двое старее текущего, само текущее и один новее (`index − 2 … index + 1`): человек идёт тапами к более старым,
 * и впереди по ходу видно больше делений; у краёв окно упирается в край (текущее тогда ближе к нему). Нет закреплённых —
 * пусто.
 */
export function pinSegments(count: number, index: number): boolean[] {
  const n = total(count);
  if (n === 0) return [];
  const current = clampPinIndex(n, index);
  const size = Math.min(n, PIN_BAR_SEGMENTS_MAX);
  const start = Math.min(Math.max(current - 2, 0), n - size);
  return Array.from({ length: size }, (_, i) => start + i === current);
}

// ─── Полоса следует за прокруткой, ПКМ, «Скрыть закреплённые» и служебная строка (G27 ост., G28; 07.10) ───────────────────

/**
 * Какое закреплённое показывать, пока человек листает ленту (Telegram Desktop `history_view_pinned_tracker.cpp`,
 * `PinnedTracker::refreshCurrentFromSlice`, и `HistoryWidget::updatePinnedViewer`): ближайшее закреплённое НЕ НИЖЕ нижнего
 * видимого сообщения — то есть самое новое из тех, что на экране или выше; ни одного выше — самое старое (`front`). У низа
 * ленты — значит самое новое, чем выше листаешь, тем старее.
 *
 * `keys` — ключи порядка закреплённых от старых к новым (`ConvPin.message.sortKey`), `bottomKey` — ключ нижнего видимого
 * сообщения (`null` — не измерили: лента не нарисована, строки без ключа; тогда ничего не меняем — `index: -1`).
 *
 * `clickedKey` — закреплённое, к которому ПЕРЕШЛИ нажатием на полосу (`_pinnedClickedId`): пока лента не пролистана выше
 * него, полоса показывает предыдущее (старее) — следующий нажим пойдёт дальше, как в Telegram; нажали на самое старое — после
 * него снова самое новое (`_minPinnedId >= _pinnedClickedId`). Пролистали так, что нижний край не ниже его места, — отметка
 * сбрасывается (`checkLastPinnedClickedIdReset`), полоса снова идёт за прокруткой; новая отметка — в ответе.
 */
export function pinTrack(input: {
  keys: readonly number[];
  bottomKey: number | null;
  clickedKey: number | null;
}): { index: number; clickedKey: number | null } {
  const { keys, bottomKey } = input;
  let clicked = Number.isFinite(input.clickedKey ?? NaN) ? (input.clickedKey as number) : null;
  if (keys.length === 0) return { index: -1, clickedKey: null };
  if (bottomKey === null || !Number.isFinite(bottomKey)) return { index: -1, clickedKey: clicked };
  if (clicked !== null && bottomKey <= clicked) clicked = null;
  let limit = bottomKey;
  let strict = false;
  if (clicked !== null) {
    if (clicked <= keys[0]) limit = Number.POSITIVE_INFINITY;
    else {
      limit = clicked;
      strict = true;
    }
  }
  let index = 0;
  for (let i = 0; i < keys.length; i++) {
    if (strict ? keys[i] < limit : keys[i] <= limit) index = i;
    else break;
  }
  return { index, clickedKey: clicked };
}

/**
 * Куда ведёт правый щелчок по полосе (Telegram Desktop `barRightClicks`): к следующему НОВЕЕ опорного закреплённого, а от
 * самого нового — по кругу к самому старому. Опорное — то, к которому перешли нажатием (`clickedKey`), иначе показанное
 * (`shownKey`). Ключи — от старых к новым; пусто — `-1`.
 */
export function pinNextIndex(keys: readonly number[], refKey: number | null): number {
  if (keys.length === 0) return -1;
  if (refKey === null || !Number.isFinite(refKey)) return 0;
  const i = keys.findIndex((k) => k > refKey);
  return i < 0 ? 0 : i;
}

/**
 * Заголовок полосы (Telegram Desktop `WithPinnedTitle`): показано самое новое — «Закреплённое сообщение»; закреплённых
 * два — у старого «Предыдущее сообщение»; иначе «Закреплённое сообщение #N» (N — номер от старого, с единицы).
 */
export function pinTitle(count: number, index: number): string {
  const n = total(count);
  const at = clampPinIndex(n, index);
  if (at + 1 >= n) return 'Закреплённое сообщение';
  if (n === 2) return 'Предыдущее сообщение';
  return `Закреплённое сообщение #${at + 1}`;
}

/**
 * «Скрыть закреплённые» (Telegram `HidePinnedBar`, `hiddenPinnedMessageId`): запоминается, что было закреплено на момент
 * скрытия, и полоса скрыта, пока закреплённое — только из этого набора. Появилось новое закреплённое (чьё угодно) — полоса
 * снова на месте; открепили часть — остаётся скрытой. (У Telegram запоминается самое новое по номеру сообщения; у нас закрепить
 * можно и старое сообщение — поэтому сверяем набор, иначе закрепление старого не вернуло бы полосу.) Только у себя, на этом
 * устройстве. `current` — id закреплённых сейчас; `hidden` — запомненные (`null` — не скрывали).
 */
export function pinBarHidden(current: readonly string[], hidden: readonly string[] | null): boolean {
  if (!hidden || current.length === 0) return false;
  const known = new Set(hidden);
  return current.every((id) => known.has(id));
}

/** Метка служебной строки «X закрепил(а) сообщение» (`ConvMessage.service`): только известный вид с id; прочее — не метка. */
export function pinServiceMark(m: { service?: unknown }): { kind: 'pin'; messageId: string } | null {
  const s = m.service as { kind?: unknown; messageId?: unknown } | null | undefined;
  if (!s || s.kind !== 'pin' || typeof s.messageId !== 'string' || !s.messageId) return null;
  return { kind: 'pin', messageId: s.messageId };
}

/**
 * Начало служебной строки (Telegram `lng_action_pinned_message`: «{from} pinned «{text}»»): свои — «Вы закрепили», чужие —
 * «Имя закрепил(а)» (пола у нас нет). Дальше клиент ставит «текст» в кавычках-ёлочках, а если закреплённого нет под рукой, —
 * «сообщение».
 */
export function pinServiceLead(mine: boolean, name: string): string {
  return mine ? 'Вы закрепили' : `${name.trim() || 'Собеседник'} закрепил(а)`;
}

/** Что закреплено, если у сообщения нет текста: слово для строки «Вы закрепили фото» (Telegram `lng_action_pinned_media_*`). */
export type PinMedia = 'photo' | 'voice' | 'video' | 'sticker' | 'file';

/**
 * Конец служебной строки: текст в ёлочках, обрезанный до 40 знаков («Вы закрепили «до завтра, в семь…»»), а у сообщения без
 * текста — слово по виду вложения; ни того ни другого (закреплённого нет под рукой) — «сообщение».
 */
export function pinServiceTail(text: string, media?: PinMedia | null): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t) return `«${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}»`;
  switch (media) {
    case 'photo':
      return 'фото';
    case 'voice':
      return 'голосовое сообщение';
    case 'video':
      return 'видео';
    case 'sticker':
      return 'стикер';
    case 'file':
      return 'файл';
    default:
      return 'сообщение';
  }
}
