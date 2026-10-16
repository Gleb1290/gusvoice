/**
 * События сервер-сервер (#139, F1, план §5.1) — то, чем связанные инстансы сообщают друг другу об
 * изменениях: кто вступил в сервер, кто сменил имя, кого забанили. Позже по этому же каналу пойдут
 * копии личных сообщений (§7.2), поэтому правила доставки закладываются сразу.
 *
 * Три вещи, без которых такой канал разваливается на практике:
 *  - **номер на связку**: получатель помнит последний принятый и отбрасывает то, что уже видел.
 *    Повтор бывает не от злого умысла — отправитель не дождался ответа и послал снова;
 *  - **свой идентификатор у события**: номера хватает для порядка, но не для «это ровно то же самое»,
 *    когда события приходят разными путями;
 *  - **версия у событий состояния**: сеть переставляет сообщения местами, и без версии старое
 *    «человек офлайн» затирало бы более свежее «человек онлайн».
 *
 * 🔴 Правки — только добавлением (`docs/federation-compat.md`): новый тип события сосед постарше
 * обязан молча пропустить, а не упасть.
 */

/** Типы событий. Неизвестный получателю тип пропускается молча — это не ошибка, а сосед новее. */
export const FED_EVENTS = {
  /** Профиль человека изменился (имя, аватар) — у события есть версия. */
  userUpdated: 'user.updated',
  /** Членство в сервере появилось или исчезло — версия есть. */
  membershipChanged: 'membership.changed',
  /** Инстанс сменил название или иконку — версия есть. */
  instanceUpdated: 'instance.updated',
  /**
   * Сервер, открытый для федеративного доступа, изменился или закрылся (F2, §5.3) — версия есть.
   *
   * ⚠️ Отдельно от `user.updated`, хотя оба «каталог изменился»: у сервера свой набор полей и своя
   * причина исчезнуть (сняли галочку), и сводить их в одно событие значило бы проверять тип внутри
   * обработчика — то есть заводить второй, неявный, вид события.
   */
  serverUpdated: 'server.updated',
  /** Человеку закрыт доступ на нашем инстансе (§5.11) — версии нет, это факт на момент. */
  userBanned: 'user.banned',
  /**
   * Человек нажал «выйти везде» или сменил пароль (F3, §5.6.1) — версии нет, есть поколение.
   *
   * 🔴 Отдельно от `user.revoked`: здесь человек жив и может войти заново сию секунду, а там
   * аккаунта больше нет. Свести их в одно значило бы выбирать смысл по содержимому нагрузки.
   */
  userSessionsRevoked: 'user.sessions_revoked',
  /** Аккаунт удалён или заблокирован дома (§5.6) — входить больше некому. */
  userRevoked: 'user.revoked',
  /** Жалоба держателю на его человека (§5.11) — факт на момент. */
  reportCreate: 'report.create',
  /** Ответ держателя на жалобу (§5.11). */
  reportReply: 'report.reply',
  /**
   * Гостя позвали у нас — разбудить его телефон через ЕГО дом (F5, требование 33).
   *
   * 🔴 **Без содержимого сообщения.** Устройство гостя зарегистрировано в пушах дома, а не у нас, и
   * другого пути к его телефону у хоста нет. Но это не повод пересылать дому переписку: дом узнаёт
   * ровно «вашего человека позвали на сервере таком-то» и будит телефон своим обычным пушем. Текст
   * клиент забирает у хоста сам, когда человек откроет приложение.
   *
   * ⚠️ Версии нет намеренно: это факт на момент, а не состояние. Пропущенное событие догонять
   * бессмысленно — пуш, приехавший через сутки, хуже, чем не приехавший.
   */
  guestNotify: 'guest.notify',
} as const;
export type FedEventKind = (typeof FED_EVENTS)[keyof typeof FED_EVENTS];

export interface FedEvent {
  /** Свой идентификатор события: по нему ловится повтор, пришедший другим путём. */
  eventId: string;
  /** Порядковый номер в рамках ОДНОЙ связки; у каждой связки своя нумерация. */
  seq: number;
  kind: string;
  /** Когда отправитель его создал (миллисекунды эпохи) — для порядка в журнале, не для решений. */
  createdAt: number;
  /** Версия состояния: у событий состояния обязательна, у фактов-на-момент её нет. */
  version?: number;
  payload: Record<string, unknown>;
}

export function serializeFedEvent(e: FedEvent): Record<string, unknown> {
  return {
    event_id: e.eventId,
    seq: e.seq,
    kind: e.kind,
    created_at: e.createdAt,
    ...(e.version === undefined ? {} : { version: e.version }),
    payload: e.payload,
  };
}

/** Разобрать событие соседа. Терпимо к лишним полям, строго к обязательным. */
export function parseFedEvent(raw: unknown): FedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const eventId = typeof r.event_id === 'string' && r.event_id.length > 0 ? r.event_id : null;
  const seq = typeof r.seq === 'number' && Number.isInteger(r.seq) && r.seq > 0 ? r.seq : null;
  const kind = typeof r.kind === 'string' && r.kind.length > 0 ? r.kind : null;
  const createdAt = typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? r.created_at : null;
  if (!eventId || seq === null || !kind || createdAt === null) return null;
  const version =
    typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 0 ? r.version : undefined;
  const payload = r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {};
  return { eventId, seq, kind, createdAt, version, payload };
}

export type EventVerdict =
  /**
   * Принять и применить. `late: true` (Э0 ЛС между инстансами, 12.10) — опоздавшее: номер ниже последнего принятого, но
   * он числится в пропусках (`missing`), то есть его не видели. Последний принятый номер такое событие НЕ двигает.
   */
  | { accept: true; gap: boolean; late?: true }
  /** Уже видели — тихо подтвердить, не применяя. Повтор это норма, а не повод для тревоги. */
  | { accept: false; reason: 'duplicate' };

/**
 * Принимать ли событие.
 *
 * `gap: true` — между последним принятым и этим номером есть дыра: что-то не доехало. Событие всё
 * равно принимается (отказ ничего бы не починил, а состояние ушло бы ещё дальше), но получатель
 * обязан отметить пропуск: в F2 по нему запрашивается сверка каталога.
 *
 * ⚠️ Дедуп идёт по ДВУМ признакам, и оба нужны: номер ловит обычный повтор, а список недавних
 * идентификаторов — событие, которое пришло дважды разными путями и обогнало само себя.
 */
export function judgeEvent(
  event: Pick<FedEvent, 'eventId' | 'seq'>,
  state: {
    lastSeq: number;
    recentIds: ReadonlySet<string>;
    /**
     * Номера, перепрыгнутые прошлыми дырами и ещё не пришедшие (Э0, `federation_links.missing_event_seqs`). Необязательно:
     * без него поведение прежнее — всё, что не выше последнего, считается повтором.
     *
     * 🔴 Зачем (дыра доставки, `docs/dm/FEDERATION.md` §2.2): сосед прошлой версии шлёт событие сразу, мимо своей очереди,
     * пока более раннее ещё ждёт повтора. Мы принимали «дыру», сдвигали последний номер — и раннее, доехав очередью,
     * выбрасывалось как повтор. Изменение пропадало без всякой ошибки.
     */
    missing?: ReadonlySet<number>;
  },
): EventVerdict {
  if (state.recentIds.has(event.eventId)) return { accept: false, reason: 'duplicate' };
  if (event.seq <= state.lastSeq) {
    if (state.missing?.has(event.seq)) return { accept: true, gap: false, late: true };
    return { accept: false, reason: 'duplicate' };
  }
  return { accept: true, gap: event.seq > state.lastSeq + 1 };
}

/**
 * Сколько пропущенных номеров помним на связку. Больше — самые старые забываются: событие, опоздавшее на тысячу номеров,
 * давно выброшено очередью отправителя (12 попыток / 3 суток), а для каталогов дыру и так закрывает полная сверка.
 */
export const MISSING_EVENT_SEQS_MAX = 1024;

/**
 * Обновить множество пропусков после принятого события (Э0): дыра `lastSeq+1 … seq-1` добавляется, опоздавшее — вычёркивается.
 * Возвращает новый отсортированный список не длиннее `max` (выбрасываются самые старые номера).
 */
export function trackMissingSeqs(
  missing: readonly number[],
  lastSeq: number,
  seq: number,
  max = MISSING_EVENT_SEQS_MAX,
): number[] {
  const set = new Set(missing);
  if (seq <= lastSeq) {
    set.delete(seq);
  } else {
    // Дыра длиннее предела целиком не нужна: запомнится только её хвост.
    for (let n = Math.max(lastSeq + 1, seq - max); n < seq; n += 1) set.add(n);
  }
  const out = [...set].sort((a, b) => a - b);
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Перетирать ли текущее состояние пришедшим.
 *
 * 🔴 Строго «больше», а не «больше или равно»: при равных версиях выигрывает то, что уже лежит.
 * Иначе повтор того же события применялся бы заново — и, например, «вернуть имя по умолчанию»
 * отменяло бы правку, сделанную между доставками.
 */
export function stateWins(incomingVersion: number | undefined, currentVersion: number | undefined): boolean {
  if (incomingVersion === undefined) return true; // факт-на-момент: версии нет, применяем как есть
  if (currentVersion === undefined) return true;
  return incomingVersion > currentVersion;
}

/** Сколько идентификаторов держим для дедупа: хватает, чтобы пережить переотправку пачки. */
export const RECENT_EVENT_IDS = 256;

/** Добавить идентификатор в окно недавних, выбросив самые старые. */
export function rememberEventId(recent: readonly string[], eventId: string, max = RECENT_EVENT_IDS): string[] {
  const next = [...recent.filter((id) => id !== eventId), eventId];
  return next.length > max ? next.slice(next.length - max) : next;
}
