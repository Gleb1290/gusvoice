/**
 * ЛС между инстансами, этап Э4 (#141, признак связки `dm3`): мгновенное — «печатает» и «в сети / был(а) в сети».
 *
 * `POST /fed/v1/ephemeral` (план `docs/dm/FEDERATION.md` §3, «как EDU в Matrix»): без журнала, номера и очереди — потерялось,
 * не страшно (следующее «печатает» через 3 с, следующее «жив» — через минуту). Одна запись на запрос.
 * - `typing` — человек ДОМА-ОТПРАВИТЕЛЯ печатает в беседе 1:1 с человеком получателя (id беседы на обоих инстансах один);
 * - `presence` — человек дома-отправителя в сети / вышел; время захода — ОТДЕЛЬНО для каждого собеседника на получателе
 *   (`views`): правила «был(а) в сети» дома этого человека (приватность, исключения) решаются на его доме, наружу уходит
 *   только итог — точное время или примерная категория.
 *
 * Разбор — терпимый читатель (`docs/federation-compat.md` п. 4): незнакомые поля игнорируются, незнакомый `kind` — `unknown`
 * (сосед новее: молча пропустить), негодный конверт — `null`. Исторические примеры — `fixtures/v1/ephemeral-*.json`.
 */
import type { LastSeenApprox } from '../types';
import { parseTypingAction, type TypingAction } from '../typingAction';
import { fedId } from './fieldRules';
import { parsePersonRef, serializePersonRef, type FedPersonRef } from './convWire';

/** Путь мгновенного канала (под `/api` у соседа). */
export const FED_EPHEMERAL_PATH = '/fed/v1/ephemeral';

/** Сколько живёт «печатает» без повтора (план §3: 6 с; отправитель повторяет не чаще раза в `FED_TYPING_RESEND_MS`). */
export const FED_TYPING_TTL_MS = 6_000;
/** Не чаще раза в столько отправитель шлёт соседу «печатает» одного человека в одной беседе. */
export const FED_TYPING_RESEND_MS = 3_000;
/** Раз в столько дом повторяет соседям «в сети» тех, кто в сети (подтверждение «жив»). */
export const FED_PRESENCE_ALIVE_MS = 60_000;
/** Без подтверждения дольше этого получатель считает человека соседа вышедшим (две потерянные отметки «жив» + запас). */
export const FED_PRESENCE_STALE_MS = 150_000;
/** Потолок собеседников в одной записи `presence`. */
export const FED_PRESENCE_VIEWS_MAX = 200;

const APPROX: readonly LastSeenApprox[] = ['recently', 'week', 'month', 'long'];

export interface FedTypingWire {
  kind: 'typing';
  conversationId: string;
  /** Кто печатает — человек дома-отправителя. */
  user: FedPersonRef;
  /** Вид действия (`typingAction.ts`); незнакомое — «печатает». */
  action: TypingAction;
  /** Мс эпохи (часы отправителя): до когда показывать. */
  until: number;
  /** Перестал печатать (пока получатель просто ждёт истечения — у местного кадра остановки нет). */
  stop: boolean;
}

/** Что видит ОДИН собеседник на инстансе-получателе. Ровно одно: `lastSeen` (точное, мс) либо `approx` (скрыто), либо ничего. */
export interface FedPresenceView {
  /** Собеседник — человек инстанса-ПОЛУЧАТЕЛЯ. */
  user: FedPersonRef;
  lastSeen: number | null;
  approx: LastSeenApprox | null;
  /**
   * «Кто может мне писать» (13.10, #218, `msgpriv1`; провод `no_messages: true`): человек дома-отправителя не пускает сообщения
   * этого собеседника (только контакты и те, кому писал сам). Дом собеседника отказывает ему в отправке заранее (403
   * `message_privacy`), вместо вечной «одной галочки». Нет поля — писать можно (старый сосед поле не шлёт и не читает).
   */
  noMessages?: true;
}

export interface FedPresenceWire {
  kind: 'presence';
  user: FedPersonRef;
  /** В сети для ЛС (как `isUserDmPresent` у местного). */
  online: boolean;
  /** Версия — мс эпохи отправителя: получатель не принимает более старое, чем уже видел. */
  at: number;
  views: FedPresenceView[];
}

export type FedEphemeralWire = FedTypingWire | FedPresenceWire;

export function serializeEphemeralWire(instanceId: string, e: FedEphemeralWire): Record<string, unknown> {
  if (e.kind === 'typing') {
    return {
      instance_id: instanceId,
      kind: 'typing',
      conversation_id: e.conversationId,
      user: serializePersonRef(e.user),
      // «печатает» в проводе не пишется (как в кадре шлюза).
      ...(e.action === 'typing' ? {} : { action: e.action }),
      until: e.until,
      ...(e.stop ? { stop: true } : {}),
    };
  }
  return {
    instance_id: instanceId,
    kind: 'presence',
    user: serializePersonRef(e.user),
    online: e.online,
    at: e.at,
    views: e.views.slice(0, FED_PRESENCE_VIEWS_MAX).map((v) => ({
      user: serializePersonRef(v.user),
      last_seen: v.lastSeen,
      ...(v.approx ? { approx: v.approx } : {}),
      ...(v.noMessages ? { no_messages: true } : {}),
    })),
  };
}

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseView(raw: unknown): FedPresenceView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const user = parsePersonRef(r.user);
  if (!user) return null;
  const lastSeen = finiteNum(r.last_seen);
  const approx = typeof r.approx === 'string' && (APPROX as readonly string[]).includes(r.approx) ? (r.approx as LastSeenApprox) : null;
  // Точное время сильнее категории: обе сразу — сосед ошибся, берём точное.
  return { user, lastSeen, approx: lastSeen === null ? approx : null, ...(r.no_messages === true ? { noMessages: true as const } : {}) };
}

/** Тело `POST /fed/v1/ephemeral`. `unknown` — вид, которого мы не знаем (молча пропустить); `null` — негодный конверт. */
export function parseEphemeralWire(raw: unknown): FedEphemeralWire | 'unknown' | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'typing') {
    const conversationId = fedId(r.conversation_id);
    const user = parsePersonRef(r.user);
    const until = finiteNum(r.until);
    if (!conversationId || !user || until === null) return null;
    return { kind: 'typing', conversationId, user, action: parseTypingAction(r.action), until, stop: r.stop === true };
  }
  if (r.kind === 'presence') {
    const user = parsePersonRef(r.user);
    const at = finiteNum(r.at);
    if (!user || at === null || typeof r.online !== 'boolean') return null;
    const views = Array.isArray(r.views)
      ? r.views
          .slice(0, FED_PRESENCE_VIEWS_MAX)
          .map(parseView)
          .filter((v): v is FedPresenceView => v !== null)
      : [];
    return { kind: 'presence', user, online: r.online, at, views };
  }
  return typeof r.kind === 'string' ? 'unknown' : null;
}
