/**
 * Звонки 1:1 в ЛС (08.10, #211, С5, G73 + G68, признак сервера `calls1`) — общие типы и правила подписи записи о звонке.
 *
 * Поведение — как Telegram: звонит один из двоих беседы 1:1, у собеседника звонит на ВСЕХ его устройствах, ответ на одном
 * гасит остальные; не ответил за `CALL_RING_TIMEOUT_MS` (tdesktop `callRingTimeoutMs` = 90 000 по умолчанию,
 * `mtproto_config.h`) — пропущенный. Медиа — комната LiveKit `dmcall_<id звонка>` (тот же сервер, что у голосовых каналов).
 * Итог звонка ложится в ленту служебной строкой `ConvCallService` (Telegram `messageActionPhoneCall`, причины
 * `missed / busy / hangup / disconnect`), автор строки — звонивший.
 */

/** Сколько звонить собеседнику до «пропущенного» (Telegram `call_ring_timeout_ms`, 90 с). */
export const CALL_RING_TIMEOUT_MS = 90_000;

/** Как часто участник идущего разговора подтверждает, что он ещё здесь (`POST /api/calls/:id/ping`). */
export const CALL_PING_MS = 15_000;

/** Тишина от участника идущего разговора дольше этого — обрыв (`disconnect`), разговор завершается. */
export const CALL_DROP_MS = 45_000;

/** Причина конца звонка (Telegram `PhoneCallDiscardReason`). */
export type CallEndReason = 'missed' | 'busy' | 'hangup' | 'disconnect';

/** Фаза звонка: звонит, идёт разговор, закончен. */
export type CallPhase = 'ringing' | 'active' | 'ended';

/** Звонок глазами участника (`call.state`, ответы `/api/calls*`). */
export interface DmCall {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  phase: CallPhase;
  /** Когда начал звонить (ISO). */
  createdAt: string;
  /** Когда ответили (ISO) — только после ответа. */
  answeredAt?: string;
  /** Какое устройство звонившего ведёт звонок (id вкладки, случайный). */
  callerDevice: string;
  /** Каким устройством ответили — остальные устройства собеседника гасят входящий. */
  calleeDevice?: string;
  /** Причина конца — только у `ended`. */
  reason?: CallEndReason;
  /** Длительность разговора, с — только у `ended` после ответа. */
  duration?: number;
  /** В звонке включали камеру (`calls2`) — запись в ленте «Видеозвонок». */
  video?: boolean;
  /**
   * Звонок с другого инстанса (Э6, `fedcall1`): только у входящего, которое дом собеседника завёл по приглашению соседа.
   * Комната и сам звонок — у инстанса звонящего: пропуск, ответ, отклонение, знак жизни и «положить» — туда
   * (`<apiBase>/api/calls/:id/*`) по гостевой сессии, которую выдаёт дом (`GET /api/conv/:id/fallback?for=call`).
   * `callerId` — теневая строка звонящего у дома. Добавление.
   */
  host?: { instanceId: string; apiBase: string };
}

/** Ответ на «позвонить» и «ответить»: звонок и пропуск в его комнату LiveKit. */
export interface CallJoinResponse {
  call: DmCall;
  url: string;
  token: string;
  room: string;
}

/** Ответ `GET /api/calls/active`: мой текущий звонок (звонит или идёт) — или `null`. */
export interface CallActiveResponse {
  call: DmCall | null;
}

/** Ошибка «собеседник занят другим звонком» (`POST /api/conv/:id/call` → 409). */
export const CALL_BUSY_ERROR = 'line_busy';

/**
 * Ошибка «звонить нельзя по его настройке «Кто может звонить»» (`presence4`, `POST /api/conv/:id/call` → 403). Telegram:
 * `USER_PRIVACY_RESTRICTED` → `lng_call_error_not_available`.
 */
export const CALL_PRIVACY_ERROR = 'call_privacy';

/** Запись о звонке в ленте (`ConvMessage.service`, вид `call`, `calls1`). Автор строки — звонивший. */
export interface ConvCallService {
  kind: 'call';
  callId: string;
  reason: CallEndReason;
  /** Длительность разговора, с; 0 — не разговаривали. */
  duration: number;
  /** Видеозвонок (`calls2`): в звонке включали камеру. Нет поля — голосовой. */
  video?: boolean;
}

/** «3 мин», «45 с», «1 ч 5 мин» — длительность в записи о звонке (Telegram `lng_call_duration_info`). */
export function callDurationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
}

/**
 * Подпись записи о звонке глазами читателя (tdesktop `MediaCall::Text`): я звонил — «Отменённый звонок», если не
 * дозвонился (`missed`), иначе «Исходящий звонок»; мне звонили — «Пропущенный звонок» (`missed`), «Отклонённый звонок»
 * (`busy` — я отклонил), иначе «Входящий звонок». Длительность — через запятую, если разговор был.
 */
export function callServiceText(mark: Pick<ConvCallService, 'reason' | 'duration' | 'video'>, outgoing: boolean): string {
  const head = callServiceTitle(mark, outgoing);
  return mark.duration > 0 ? `${head}, ${callDurationText(mark.duration)}` : head;
}

/**
 * Заголовок записи о звонке без длительности (`calls2`, пузырь в ленте — tdesktop `HistoryView::Call`: заголовок первой
 * строкой, ниже стрелка, время и длительность). Видеозвонок — tdesktop `lng_call_video_*`: «Исходящий / Входящий /
 * Пропущенный / Отменённый / Отклонённый видеозвонок».
 */
export function callServiceTitle(mark: Pick<ConvCallService, 'reason' | 'video'>, outgoing: boolean): string {
  const noun = mark.video ? 'видеозвонок' : 'звонок';
  const adj = outgoing
    ? mark.reason === 'missed'
      ? 'Отменённый'
      : 'Исходящий'
    : mark.reason === 'missed'
      ? 'Пропущенный'
      : mark.reason === 'busy'
        ? 'Отклонённый'
        : 'Входящий';
  return `${adj} ${noun}`;
}

/** Запасной текст записи (`ConvMessage.content`) — для клиента без `calls1`: нейтральный, без «я / мне». */
export function callServiceFallback(mark: Pick<ConvCallService, 'reason' | 'duration' | 'video'>): string {
  const noun = mark.video ? 'видеозвонок' : 'звонок';
  if (mark.reason === 'missed') return `Пропущенный ${noun}`;
  if (mark.reason === 'busy') return `Отклонённый ${noun}`;
  const head = mark.video ? 'Видеозвонок' : 'Звонок';
  return mark.duration > 0 ? `${head}, ${callDurationText(mark.duration)}` : head;
}

/** Пропущенный ли это звонок для читателя (не звонившего) — для счётчика и пуша. */
export function isMissedCall(mark: Pick<ConvCallService, 'reason'>): boolean {
  return mark.reason === 'missed';
}

/** Метка записи о звонке у сообщения (`ConvMessage.service`) или `null` — незнакомое и чужое мимо (правило 11). */
export function callServiceMark(m: { service?: unknown }): ConvCallService | null {
  const s = m.service as Partial<ConvCallService> | null | undefined;
  return s && s.kind === 'call' && typeof s.reason === 'string' && typeof s.callId === 'string'
    ? {
        kind: 'call',
        callId: s.callId,
        reason: s.reason,
        duration: typeof s.duration === 'number' ? s.duration : 0,
        ...(s.video === true ? { video: true } : {}),
      }
    : null;
}
