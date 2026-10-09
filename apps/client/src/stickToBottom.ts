/**
 * «Прилипание к низу» ленты сообщений — чистые правила, без DOM и без React.
 *
 * 🔴 **Повод (19.09).** Лента прокручивалась в самый низ на ЛЮБОЕ изменение числа сообщений:
 * `useEffect(() => { bottomRef.current?.scrollIntoView(); }, [messages.length])`, без единой
 * проверки, где человек сейчас находится. То есть читать историю в живом канале было нельзя:
 * каждое чужое сообщение выдёргивало экран в конец на полуслове. Отдельным следствием была ещё
 * одна потеря — черта «Новые сообщения» рисовалась правильно, но человек её не видел, потому что
 * экран сразу уезжал ниже неё.
 *
 * Правило, которое это лечит, звучит просто: **догонять «сейчас» надо только тому, кто и так
 * смотрит в «сейчас»**. Отлистал вверх — читай спокойно, лента под ногами не поедет.
 *
 * ⚠️ Два исключения, без которых правило ощущается сломанным:
 *   - СВОЁ отправленное сообщение прокручивает всегда: человек только что нажал «отправить» и
 *     ждёт увидеть результат, где бы он до этого ни стоял;
 *   - смена ленты (другой канал, другой диалог) открывается внизу всегда — это не «новое
 *     сообщение приехало», а новое место, и начинают его читать с последнего.
 */

/**
 * Насколько далеко от нижней кромки человек всё ещё считается «смотрящим в сейчас».
 *
 * ⚠️ Не ноль намеренно: на субпиксельных высотах строк и при появлении полосы «печатает…»
 * `scrollTop + clientHeight` не сходится со `scrollHeight` ровно, и нулевой допуск превратил бы
 * прилипание в лотерею. 64 пикселя — это примерно строка-полторы: человек, у которого последнее
 * сообщение наполовину видно, ещё «внизу».
 */
export const NEAR_BOTTOM_PX = 64;

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Стоит ли человек у нижней кромки ленты (с допуском). */
export function isNearBottom(box: ScrollBox): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - NEAR_BOTTOM_PX;
}

export interface AutoScrollInput {
  /** Был ли человек у низа ПЕРЕД тем, как лента изменилась. */
  wasNearBottom: boolean;
  /** Последнее сообщение написал он сам. */
  ownMessage: boolean;
  /** Лента сменилась целиком: другой канал или диалог. */
  switchedFeed: boolean;
}

/** Догонять ли низ после изменения ленты. */
export function shouldAutoScroll({ wasNearBottom, ownMessage, switchedFeed }: AutoScrollInput): boolean {
  if (switchedFeed) return true;
  if (ownMessage) return true;
  return wasNearBottom;
}

/**
 * Показывать ли кнопку «вниз, к новым».
 *
 * Нужна ровно там, где сработал запрет прокрутки: человек читает выше, а внизу что-то накопилось.
 * Без неё правило выше было бы половинчатым — лента перестала бы дёргаться, но и узнать о новом
 * стало бы неоткуда, кроме счётчика в списке каналов.
 */
export function shouldShowJumpDown({ nearBottom, unseenBelow }: { nearBottom: boolean; unseenBelow: number }): boolean {
  return !nearBottom && unseenBelow > 0;
}

/**
 * За сколько пикселей до верхней кромки начинаем подтягивать более старые сообщения.
 *
 * ⚠️ Не ноль: если ждать, пока человек упрётся в самый верх, он успеет увидеть пустоту и решить,
 * что история кончилась. Запас примерно в экран даёт подгрузке произойти незаметно.
 */
export const HISTORY_TRIGGER_PX = 600;

/** Пора ли просить следующую порцию истории. */
export function shouldLoadOlder({
  scrollTop,
  loading,
  hasMore,
}: {
  scrollTop: number;
  loading: boolean;
  hasMore: boolean;
}): boolean {
  if (loading || !hasMore) return false;
  return scrollTop <= HISTORY_TRIGGER_PX;
}

/**
 * Куда поставить прокрутку после того, как СВЕРХУ добавили сообщений.
 *
 * 🔴 Без этой поправки подгрузка истории выглядит как провал в прошлое: содержимое выросло вверх,
 * а прокрутка осталась на прежнем числе пикселей — значит человека утащило туда, где он уже читал.
 * Держим его на том же месте текста: прибавляем ровно столько, на сколько лента подросла.
 */
export function keepPositionAfterPrepend(before: { scrollTop: number; scrollHeight: number }, afterHeight: number): number {
  return before.scrollTop + (afterHeight - before.scrollHeight);
}

/**
 * Сколько сообщений добавилось СНИЗУ — то есть сколько человек реально пропустил.
 *
 * 🔴 **Повод (19.09, поймано живой проверкой.)** Пока счёт шёл по разнице длины списка, подгрузка
 * истории засчитывалась как новые сообщения: долистал до начала, приехало 50 старых — и внизу
 * зажглась кнопка «50 новых», хотя снизу не появилось ни одного. Разница длины не знает, с какой
 * стороны прибыло; знает только положение прошлого последнего сообщения.
 *
 * Отсюда правило: ищем, где в новом списке стоит сообщение, бывшее последним, и считаем всё, что
 * после него. Не нашли (сменилась лента, историю почистили) — ноль: врать про «новое» хуже, чем
 * промолчать.
 */
export function addedBelow(ids: readonly string[], prevLastId: string | undefined): number {
  if (!prevLastId) return 0;
  const at = ids.lastIndexOf(prevLastId);
  return at < 0 ? 0 : ids.length - 1 - at;
}

/** Подпись на кнопке: с числом, пока оно осмысленно, и с потолком — как у счётчиков каналов. */
export function jumpDownLabel(unseenBelow: number): string {
  if (unseenBelow > 99) return '99+ новых';
  if (unseenBelow === 1) return '1 новое';
  return `${unseenBelow} новых`;
}

/**
 * Куда ведёт «Вниз» (G26, Telegram 03·3.3.1–3.3.2, 03·3.1.2, Н9–Н10): к первому непрочитанному, если его верх НИЖЕ
 * нижней кромки ленты (`firstUnreadTop` и `viewBottom` — в одних координатах; `null` — непрочитанного в ленте нет), иначе
 * в конец. Так же — повторный клик по уже открытой беседе в списке.
 */
export function jumpDownTarget(firstUnreadTop: number | null, viewBottom: number): 'unread' | 'end' {
  return firstUnreadTop !== null && firstUnreadTop >= viewBottom ? 'unread' : 'end';
}

/**
 * Рисовать ли черту «Новые сообщения» при открытии (G26, Telegram ПК Н8: «первое непрочитанное выше последнего экрана»):
 * от черты до конца ленты больше высоты её окна. Иначе всё непрочитанное помещается на последний экран — беседа
 * открывается внизу и без черты. Окно ленты не у хвоста беседы (`atTail = false`) — конец дальше, черта нужна всегда.
 */
export function unreadDividerNeeded(dividerToEnd: number, viewHeight: number, atTail: boolean): boolean {
  return !atTail || dividerToEnd > viewHeight;
}

/**
 * Порог «вниз» в беседе, px от нижней кромки: как у Telegram Desktop (`chat_helpers.style` `historyToDownShownAfter: 480px`,
 * `HistoryWidget::cornerButtonsDownShown`: `scrollTop + historyToDownShownAfter < scrollTopMax`). Ближе к низу кнопка не
 * мешает читать — до конца и так один взмах колеса.
 */
export const JUMP_DOWN_SHOWN_AFTER = 480;

/** Отлистал ли человек от нижней кромки дальше порога кнопки «вниз». */
export function isFarFromBottom(box: ScrollBox, after: number = JUMP_DOWN_SHOWN_AFTER): boolean {
  return box.scrollTop + after < box.scrollHeight - box.clientHeight;
}

/**
 * Видна ли круглая «вниз» в беседе (пузыри, `MessagePane`), как у Telegram Desktop: дальше порога от низа; или внизу ещё
 * не загруженное (`hasNewer`); или есть куда вернуться по цитате (`back`); или ниже видимого есть непрочитанное (`unread`)
 * и человек не у самого низа.
 */
export function shouldShowCornerDown(s: {
  far: boolean;
  nearBottom: boolean;
  hasNewer: boolean;
  back: boolean;
  unread: number;
}): boolean {
  return s.far || s.hasNewer || s.back || (!s.nearBottom && s.unread > 0);
}
