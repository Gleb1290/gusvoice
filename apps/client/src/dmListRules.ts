import type { DmChannel, Message } from '@gusvoice/shared';

/**
 * Список бесед и входящие личные сообщения — чистые правила (#212, этап 0 плана ЛС).
 *
 * Вынесены из `store.ts` и `sockets.ts`, потому что оба бага, найденные здесь, жили в стыке двух мест
 * и тестом стора не ловились: сокет присылал беседу без поля, стор честно заменял ей запись, а
 * счётчик ломался третьим действием.
 */

/** Свежие беседы сверху: по последнему сообщению, у пустой — по созданию. */
export function byRecent(a: DmChannel, b: DmChannel): number {
  return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
}

/**
 * Влить беседу, присланную сокетом (`dm.channel`), в список.
 *
 * 🔴 Б1 «счётчик залипает на 1» (воспроизведено 28.09 на стенде: сервер считает 5, в строке «1»).
 * Сервер на КАЖДОЕ сообщение шлёт получателю сначала `dm.channel`, потом `dm.create`. В `dm.channel`
 * поля `unread` нет (оно считается только в `GET /dm`), а стор заменял запись целиком — и следующий
 * `+1` шёл от нуля. Теперь число берётся из того, что уже было в списке.
 * Время последнего сообщения — большее из двух: события одной беседы могут прийти не по порядку.
 */
export function mergeDmChannel(list: readonly DmChannel[], incoming: DmChannel): DmChannel[] {
  const prev = list.find((d) => d.id === incoming.id);
  const merged: DmChannel = prev
    ? {
        ...incoming,
        unread: incoming.unread ?? prev.unread,
        lastMessageAt: latest(prev.lastMessageAt, incoming.lastMessageAt),
      }
    : incoming;
  return [merged, ...list.filter((d) => d.id !== incoming.id)].sort(byRecent);
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) >= Date.parse(a) ? b : a;
}

/**
 * Удаление в беседе (`dm.delete`) — что стало со строкой списка (#212).
 *
 * 🔴 Удалённое последнее сообщение держало беседу наверху со своим временем (поймано на S25: строка с текстом и
 * временем удалённого сообщения над пустой перепиской), а непрочитанное удалённое оставляло у собеседника «1» на пустом месте. Сервер теперь шлёт
 * новое время беседы и новое число — применяем как есть: здесь время может и уменьшиться, в отличие от
 * `mergeDmChannel`, где события одной беседы приходят не по порядку и время берётся большее.
 * ⚠️ Число у беседы на экране не ставим: отметка «прочитано» уходит с задержкой, и сервер ещё может считать
 * непрочитанным то, что человек видит прямо сейчас (то же правило, что в `seedDmList`).
 * Поля не пришли (старый сервер) — строка не меняется.
 */
export function applyDmDelete(
  dms: readonly DmChannel[],
  unreadDms: readonly string[],
  dmId: string,
  ev: { lastMessageAt?: string | null; unread?: number },
  onScreenDmId: string | null,
): { dms: DmChannel[]; unreadDms: string[] } {
  const prev = dms.find((d) => d.id === dmId);
  if (!prev) return { dms: [...dms], unreadDms: [...unreadDms] };
  let next: DmChannel = prev;
  if (ev.lastMessageAt !== undefined) next = { ...next, lastMessageAt: ev.lastMessageAt };
  let unread = [...unreadDms];
  if (ev.unread !== undefined && dmId !== onScreenDmId) {
    next = { ...next, unread: ev.unread };
    unread = unread.filter((x) => x !== dmId);
    if (ev.unread > 0) unread.push(dmId);
  }
  return { dms: dms.map((d) => (d.id === dmId ? next : d)).sort(byRecent), unreadDms: unread };
}

/**
 * Список с сервера (`GET /dm`) + какие беседы горят непрочитанным.
 * Беседа на экране не горит и не носит число, даже если сервер его прислал: отметка «прочитано»
 * уходит с задержкой, и без этого значок мигал бы прямо под читающим.
 */
export function seedDmList(
  dms: readonly DmChannel[],
  onScreenDmId: string | null,
): { dms: DmChannel[]; unreadDms: string[] } {
  const list = dms.map((d) => (d.id === onScreenDmId && d.unread ? { ...d, unread: 0 } : d)).sort(byRecent);
  return { dms: list, unreadDms: list.filter((d) => (d.unread ?? 0) > 0).map((d) => d.id) };
}

/**
 * Правка сообщения (`dm.update`) поверх того, что уже в ленте.
 *
 * 🔴 Б4 (воспроизведено 28.09): сервер собирает реакции для `dm.update` глазами РЕДАКТОРА и шлёт тот же
 * объект собеседнику. Лента заменяла сообщение целиком — у получателя «моя реакция» становилась
 * чужой, и клик по ней отправлял «поставить» вместо «снять». Реакции меняются только событием
 * `dm.reaction`, поэтому правка их не трогает — так же, как в каналах.
 */
export function mergeDmUpdate(prev: Message, incoming: Message): Message {
  return { ...incoming, reactions: prev.reactions ?? incoming.reactions };
}

export interface DmIncoming {
  /** Моё же сообщение (эхо с другого устройства или ответ на отправку). */
  mine: boolean;
  /** Лента этой беседы показана (`channelRules.isFeedOnScreen`). */
  onScreen: boolean;
  /** Окно в фокусе и видно (`notifications.windowFocused`). */
  focused: boolean;
  /** «Не беспокоить». */
  dnd: boolean;
}

export interface DmIncomingDecision {
  /** Прибавить к непрочитанному. */
  countUnread: boolean;
  /** Отметить прочитанным на сервере (с задержкой, `sockets.scheduleRead`). */
  markRead: boolean;
  /** Звук в приложении. */
  sound: boolean;
  /** Системное уведомление. */
  osNotify: boolean;
}

/**
 * Что делать с входящим личным сообщением.
 *
 * «Смотрит» = беседа на экране И окно в фокусе. Только тогда сообщение прочитано.
 * - 🔴 Б2 (воспроизведено 28.09): беседа считалась «на экране», когда человек ушёл в канал сервера, —
 *   сообщение не горело, а через 2 с серверу уходило «прочитано». Лечится `view` в `isFeedOnScreen`.
 * - Окно свёрнуто или человек в игре, а беседа открыта — это не чтение: раньше и тут уходило тихое
 *   «прочитано», и непрочитанное пропадало с телефона. Теперь оно горит, а при возврате в окно гаснет
 *   (`channelVisit.ts`), как у Telegram.
 * - 🔴 Б8 (воспроизведено 28.09): звук играл на каждую реплику в открытой беседе при окне в фокусе.
 *   Человек, который переписывается вживую, слышит ответ глазами.
 */
export function dmIncomingDecision(i: DmIncoming): DmIncomingDecision {
  if (i.mine) return { countUnread: false, markRead: false, sound: false, osNotify: false };
  const looking = i.onScreen && i.focused;
  return { countUnread: !looking, markRead: looking, sound: !i.dnd && !looking, osNotify: !i.dnd && !looking };
}
