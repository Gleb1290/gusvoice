import type { ConvMute, DmChannel, Message } from '@gusvoice/shared';

/**
 * Список бесед и входящие личные сообщения — чистые правила (#212, этап 0 плана ЛС).
 *
 * Вынесены из `store.ts` и `sockets.ts`, потому что оба бага, найденные здесь, жили в стыке двух мест
 * и тестом стора не ловились: сокет присылал беседу без поля, стор честно заменял ей запись, а
 * счётчик ломался третьим действием.
 */

/**
 * Свежие беседы сверху: по последнему сообщению, у пустой — по созданию. Закреплённые (07.10, `pinnedAt`, сервер `conv11`)
 * — первыми, свежезакреплённая выше, как у Telegram; без закрепов — прежний порядок. То же правило у сервера —
 * `convRules.convListOrder` (`GET /api/conv`).
 */
export function byRecent(
  a: Pick<DmChannel, 'pinnedAt' | 'lastMessageAt' | 'createdAt'>,
  b: Pick<DmChannel, 'pinnedAt' | 'lastMessageAt' | 'createdAt'>,
): number {
  const pa = a.pinnedAt ?? null;
  const pb = b.pinnedAt ?? null;
  if (pa !== null || pb !== null) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return pb.localeCompare(pa);
  }
  return (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);
}

// ─── Закреп и заглушка беседы (07.10, сервер `conv11`) ──────────────────────────────────────────────────────────────

/** Лимит закреплённых бесед — для текста тоста, если сервер не прислал свой `max` (умолчание Telegram, 03·1.3.5). */
export const DM_PIN_LIMIT = 5;

/** Тост при превышении лимита закрепа (Telegram: «Достигнут лимит», 03·1.2.3). */
export function dmPinLimitText(max: number | undefined): string {
  return `Достигнут лимит: закрепить можно не больше ${max ?? DM_PIN_LIMIT} бесед`;
}

// ─── Порядок закреплённых бесед (08.10, сервер `pinorder1`, G02/G42) ─────────────────────────────────────────────────

/**
 * Начало перетаскивания закреплённой мышью — сдвиг по вертикали не меньше этого: Telegram Desktop
 * `dialogs_inner_widget.cpp` `kStartReorderThreshold` (30 px; меньший сдвиг — обычный щелчок / выделение).
 */
export const PIN_DRAG_START_PX = 30;

/**
 * Удержание пальцем на строке беседы (07.10, G01) — как удержание пузыря в ленте (`MessagePane`, 480 мс); сдвиг дальше
 * `DM_ROW_HOLD_SLOP` раньше срока — прокрутка, не удержание. Общие у меню / выбора строки (`DmSidebar`) и перетаскивания
 * закреплённой пальцем (`DmPinDrag`): удержали — выбор, повели дальше — перестановка (Telegram Android `ItemTouchHelper`).
 */
export const DM_ROW_HOLD_MS = 480;
export const DM_ROW_HOLD_SLOP = 10;

/** Автопрокрутка списка при перетаскивании: курсор / палец ближе этого к краю списка — список едет (`_draggingScroll`). */
export const PIN_DRAG_EDGE_PX = 40;

/** Наибольшая скорость автопрокрутки, px за кадр (у самого края). */
export const PIN_DRAG_SCROLL_MAX = 14;

/** Скорость автопрокрутки: `0` вне полосы у края, к краю — до `PIN_DRAG_SCROLL_MAX` (вверх — отрицательная). */
export function pinDragScrollStep(y: number, top: number, bottom: number): number {
  if (y < top + PIN_DRAG_EDGE_PX) return -Math.ceil(PIN_DRAG_SCROLL_MAX * Math.min(1, (top + PIN_DRAG_EDGE_PX - y) / PIN_DRAG_EDGE_PX));
  if (y > bottom - PIN_DRAG_EDGE_PX) return Math.ceil(PIN_DRAG_SCROLL_MAX * Math.min(1, (y - (bottom - PIN_DRAG_EDGE_PX)) / PIN_DRAG_EDGE_PX));
  return 0;
}

/**
 * Куда встанет перетаскиваемая закреплённая: соседнюю она «перепрыгивает», когда её середина (`pos`) перешла середину
 * соседней (`mids` — середины строк по порядку, своя тоже), — порог Telegram Desktop `updateReorderPinned`
 * (`crossThreshold` = половина строки при равной высоте).
 */
export function pinDropIndex(mids: readonly number[], from: number, pos: number): number {
  const last = mids.length - 1;
  let to = from;
  /* D20 (приёмка S20+, 09.10): `pinDragClamp` режет сдвиг ровно по середине крайней строки, а строгое сравнение до неё не
     дотягивалось — на первое / последнее место встать было нельзя. На КРАЙНИХ строках граница нестрогая (с запасом на
     дробные пиксели): упёрся в предел — значит, встал на край (у Telegram `updateReorderPinned` крайнее место берётся так же). */
  for (let j = from + 1; j < mids.length; j++) if (j === last ? pos >= mids[j] - PIN_EDGE_EPS : pos > mids[j]) to = j;
  for (let j = from - 1; j >= 0; j--) if (j === 0 ? pos <= mids[j] + PIN_EDGE_EPS : pos < mids[j]) to = j;
  return to;
}

/** Запас на дробные пиксели у границы крайней закреплённой строки (px). */
const PIN_EDGE_EPS = 0.5;

/** Предел сдвига перетаскиваемой строки: только в пределах закреплённых (от первой до последней середины). */
export function pinDragClamp(mids: readonly number[], from: number, along: number): number {
  if (mids.length === 0) return 0;
  return Math.max(mids[0] - mids[from], Math.min(mids[mids.length - 1] - mids[from], along));
}

/**
 * Мои закреплённые беседы одного списка сверху вниз: основной список и архив — отдельные (у Telegram у архива свой
 * порядок закреплённых, `pinnedChatsOrder(folder)`). Порядок — `byRecent` (закреплённые идут по `pinnedAt`).
 */
export function pinnedGroupIds(dms: readonly DmChannel[], archived: boolean): string[] {
  return dms
    .filter((d) => !!d.pinnedAt && (d.archived === true) === archived)
    .slice()
    .sort(byRecent)
    .map((d) => d.id);
}

/** Пункт меню «Поднять выше» / «Опустить ниже»: новый порядок или `null`, если двигать некуда. */
export function pinnedStep(ids: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = ids.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Отметки закрепа для нового порядка у себя сразу (до ответа сервера) — то же правило, что у сервера
 * (`convRules.convPinOrderStamps`): верхняя — `base`, каждая следующая на миллисекунду раньше. Закреплённые этого списка,
 * которых нет в `ids`, сервер ставит после названных — здесь они не трогаются (придут сводками).
 */
export function pinOrderStamps(ids: readonly string[], base: number): Record<string, string> {
  const top = Math.floor(base);
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    out[id] = new Date(top - i).toISOString();
  });
  return out;
}

/**
 * Сроки «Выключить на время…» — барабан Telegram Desktop целиком (03·1.2.5, `DefaultTimePickerValues`): от 15 минут до
 * 3 месяцев (месяц = 31 день). `label` — после «Выключить на …».
 */
export const DM_MUTE_PERIODS: readonly { seconds: number; label: string }[] = [
  { seconds: 15 * 60, label: '15 минут' },
  { seconds: 30 * 60, label: '30 минут' },
  { seconds: 3600, label: '1 час' },
  { seconds: 2 * 3600, label: '2 часа' },
  { seconds: 3 * 3600, label: '3 часа' },
  { seconds: 4 * 3600, label: '4 часа' },
  { seconds: 8 * 3600, label: '8 часов' },
  { seconds: 12 * 3600, label: '12 часов' },
  { seconds: 24 * 3600, label: '1 день' },
  { seconds: 2 * 24 * 3600, label: '2 дня' },
  { seconds: 3 * 24 * 3600, label: '3 дня' },
  { seconds: 7 * 24 * 3600, label: '1 неделя' },
  { seconds: 14 * 24 * 3600, label: '2 недели' },
  { seconds: 31 * 24 * 3600, label: '1 месяц' },
  { seconds: 62 * 24 * 3600, label: '2 месяца' },
  { seconds: 93 * 24 * 3600, label: '3 месяца' },
];

/**
 * Сроки, которые предлагает окно «Выключить на время» (решение владельца 09.10: 16 пунктов барабана на телефоне не
 * умещались — список прокручивался). Короткий набор Telegram (Android `NotificationsController.java`: 1 час, 8 часов,
 * 2 дня; tweb `mute.ts`: 1 день) плюс «1 день» и «7 дней». Все — из `DM_MUTE_PERIODS`, поэтому старые выставленные и
 * запомненные сроки (15 минут … 3 месяца) по-прежнему действуют, подписываются и держатся в подменю — выбрать их заново
 * нельзя, только они доживают.
 */
export const DM_MUTE_PRESETS: readonly { seconds: number; label: string }[] = DM_MUTE_PERIODS.filter((p) =>
  [3600, 8 * 3600, 24 * 3600, 2 * 24 * 3600, 7 * 24 * 3600].includes(p.seconds),
);

/**
 * «Свой срок…» (09.10, `mute2`/`mute3`): пункт меню сообщает окну `MuteCustomHost` (у корня `App`) событием окна — `detail` = id
 * собеседника. Меню закрывается сразу и уносит свои состояния, а у ленты ЛС нет лишних зависимостей: окно ставят только в приложении.
 */
export const MUTE_CUSTOM_EVENT = 'gv:mute-custom';

/** Сервер принимает срок заглушки от минуты до 366 суток (`MUTE_SECONDS_MIN` / `MUTE_SECONDS_MAX`, `convRules.ts`). */
const MUTE_SECONDS_MIN = 60;
const MUTE_SECONDS_MAX = 366 * 24 * 3600;

/**
 * Пределы полей окна «Свой срок…» — как у Telegram Desktop (`ui/boxes/choose_time.cpp`: дни `setMaxValue(31)`, часы 23, минуты 59;
 * итого не больше 31 дня 23 ч 59 мин, это меньше предела сервера). Колесо мыши над полем у нас не крутит (↑ / ↓ и ввод цифр).
 */
export const MUTE_DUR_MAX = { days: 31, hours: 23, minutes: 59 } as const;

/** Значение окна «Свой срок…» по умолчанию — 8 часов (Telegram Desktop `kMuteDurSecondsDefault`, `menu_mute.cpp`). */
export const MUTE_DUR_DEFAULT = { days: 0, hours: 8, minutes: 0 } as const;

/**
 * «Свой срок…» (09.10, `mute3`, решение владельца: длительность, как у Telegram, а не дата): секунды из трёх полей окна —
 * дни, часы, минуты (`null` — поле не набрано до конца). Ноль — срока нет (у Telegram Desktop это «Включить», у нас кнопка
 * неактивна): `null`. Поля выше пределов Telegram (`MUTE_DUR_MAX`) зажимаются до них; итог — от минуты до предела сервера.
 */
export function muteDurationSeconds(days: number | null, hours: number | null, minutes: number | null): number | null {
  if (days === null || hours === null || minutes === null) return null;
  const d = Math.min(MUTE_DUR_MAX.days, Math.max(0, Math.trunc(days)));
  const h = Math.min(MUTE_DUR_MAX.hours, Math.max(0, Math.trunc(hours)));
  const m = Math.min(MUTE_DUR_MAX.minutes, Math.max(0, Math.trunc(minutes)));
  const total = d * 86400 + h * 3600 + m * 60;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(MUTE_SECONDS_MAX, Math.max(MUTE_SECONDS_MIN, total));
}

/** Подпись срока из `DM_MUTE_PERIODS` (для «Выключить на …»); незнакомый срок — пусто (в меню не рисуется). */
export function mutePeriodLabel(seconds: number): string {
  return DM_MUTE_PERIODS.find((p) => p.seconds === seconds)?.label ?? '';
}

/**
 * Запомненные сроки в подменю (Telegram Desktop `addMutePeriod`, 03·1.2.5): не «два последних», а выбранный сейчас и
 * БОЛЬШИЙ из прежней пары — по возрастанию (после 8 ч → 2 д → 3 ч в меню будут 3 ч и 2 д). Повтор не удваивается.
 */
export function rememberMutePeriod(prev: readonly number[], chosen: number): number[] {
  const sorted = [...prev].sort((a, b) => a - b);
  const biggest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  if (biggest === null) return [chosen];
  if (biggest === chosen) return sorted; // как в `addMutePeriod`: совпало с большим — список не меняется
  return [chosen, biggest].sort((a, b) => a - b);
}

/** Заглушка действует сейчас: есть и срок не вышел (`until: null` — навсегда). Истёкшая — не заглушено. */
function untilActive(mute: ConvMute, now: number): boolean {
  if (mute.until === null) return true;
  const t = Date.parse(mute.until);
  return Number.isFinite(t) && t > now;
}

/**
 * Беседа заглушена ПОЛНОСТЬЮ: срок не вышел (`until: null` — навсегда). Истёкшая — не заглушено. «Выключить звук»
 * (`soundOnly`, 07.10, `conv13`) — не заглушка: уведомление приходит (см. `muteSoundOff`).
 */
export function muteActive(mute: ConvMute | null | undefined, now: number): boolean {
  if (!mute || mute.soundOnly === true) return false;
  return untilActive(mute, now);
}

/** Выключен только звук (07.10, `conv13`, «Выключить звук» у Telegram): уведомление и счётчик есть, звука нет. */
export function muteSoundOff(mute: ConvMute | null | undefined, now: number): boolean {
  return !!mute && mute.soundOnly === true && untilActive(mute, now);
}

/**
 * «Прочитать все» читает сразу, пока непрочитанных не больше этого числа; больше — спрашивает подтверждение (tdesktop
 * `menu/menu_mark_as_read.cpp`: `kMaxUnreadWithoutConfirmation = 1000`, `unreadState.messages <= …` — без окна).
 */
export const READ_ALL_CONFIRM_ABOVE = 1000;

/**
 * Заглушка беседы: из сводки (`dm.muted`, сервер `conv11`), а у сервера постарше (поля нет) — из списка заглушек
 * собеседников (`pushMutedDmUsers`, срок — `pushMuteUntil`, нет срока — навсегда). Действует ли — `muteActive`.
 */
export function dmMuteOf(
  dm: { muted?: ConvMute | null; otherUser: { id: string } },
  mutedUsers: readonly string[],
  until: Readonly<Record<string, string>>,
): ConvMute | null {
  if (dm.muted !== undefined) return dm.muted;
  return mutedUsers.includes(dm.otherUser.id) ? { until: until[dm.otherUser.id] ?? null } : null;
}

/**
 * Остаток срока заглушки серым справа в пункте «Включить уведомления» (Telegram ПК, 03·1.2.5, Н16): «45 мин», «3 ч»,
 * «2 д»; округление вверх (остаток минуту не показывает «0»). Навсегда или вышло — пусто.
 */
export function muteLeftLabel(mute: ConvMute | null | undefined, now: number): string {
  if (!mute || mute.until === null) return '';
  const left = Date.parse(mute.until) - now;
  if (!Number.isFinite(left) || left <= 0) return '';
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `${min} мин`;
  const h = Math.ceil(min / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.ceil(h / 24)} д`;
}

/** Ближайший конец срока среди действующих заглушек (мс) — когда перерисовать список; `null` — ждать нечего. */
export function nextMuteExpiry(mutes: readonly (ConvMute | null | undefined)[], now: number): number | null {
  let best: number | null = null;
  for (const m of mutes) {
    if (!m || m.until === null) continue;
    const t = Date.parse(m.until);
    if (Number.isFinite(t) && t > now && (best === null || t < best)) best = t;
  }
  return best;
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
  /**
   * Поверх ленты открыт слой — окно, просмотр фото, шторка (`readByView.feedCovered`, G09): человек беседу не видит —
   * как окно не в фокусе (Telegram ПК: `!_layer`). Нет — слоя нет.
   */
  covered?: boolean;
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
 * «Смотрит» = беседа на экране И окно в фокусе И поверх нет слоя (G09). Тогда `markRead` — но отметка всё равно не дальше
 * того, что лента показала (`readByView.ts`, `convStore.convSeen`): прокрученная вверх беседа новое не читает.
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
  const looking = i.onScreen && i.focused && !i.covered;
  return { countUnread: !looking, markRead: looking, sound: !i.dnd && !looking, osNotify: !i.dnd && !looking };
}

/**
 * «Без звука» (ЛС, С3, сервер `conv8`, как в Telegram): сообщение пришло с `silent: true` — уведомление ЕСТЬ, нет только
 * звука. Гасится один `sound`; тост десктопа, уведомление браузера, мигание окна, счётчик непрочитанного и отметка
 * «прочитано» — ровно как решило `dmIncomingDecision` (само уведомление тогда показывается без звука системы —
 * `notifications.osNotify(…, { silent: true })`). Отдельным правилом ПОВЕРХ него: то правило — про «смотрит ли человек»,
 * это — про волю отправителя; оба пути входящего (`conv.change` и старый `dm.create`) зовут оба.
 * Только `silent === true`: сервер шлёт поле лишь у тихих, а непонятное значение не должно глушить сообщение.
 */
export function dmSilentDecision(d: DmIncomingDecision, m: Pick<Message, 'silent'>): DmIncomingDecision {
  return m.silent === true ? { ...d, sound: false } : d;
}

/**
 * Беседа заглушена (07.10, G03, как в Telegram): «Выключить уведомления» глушит не только пуш на телефон, но и звук,
 * тост (системное уведомление) и мигание окна в приложении; счётчик и «прочитано» — как решило `dmIncomingDecision`
 * (счётчик в строке серый). Поверх `dmSilentDecision`; оба пути входящего (`conv.change` и старый `dm.create`) зовут все три.
 */
export function dmMutedDecision(d: DmIncomingDecision, muted: boolean, soundOff = false): DmIncomingDecision {
  if (muted) return { ...d, sound: false, osNotify: false };
  // «Выключить звук» (07.10, `conv13`): гасится только `sound`; тост и мигание — как решило `dmIncomingDecision`.
  return soundOff ? { ...d, sound: false } : d;
}
