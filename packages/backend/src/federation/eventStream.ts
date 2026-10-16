/**
 * Доставка событий между связанными инстансами (#139, F1, §5.1).
 *
 * Отправка и приём поверх базы: номера событий живут в строке связки, поэтому переживают перезапуск —
 * иначе после рестарта мы начали бы нумерацию заново, и сосед принял бы наши свежие события за
 * давно виденные.
 *
 * ⚠️ Окно недавних идентификаторов держится В ПАМЯТИ процесса, и это осознанно: оно ловит повтор,
 * пришедший другим путём в пределах минут. После перезапуска окно пустое, но защита не пропадает —
 * остаётся дедуп по номеру, который в базе. Хранить окно в базе значило бы писать строку на каждое
 * входящее событие ради редкого случая.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import {
  judgeEvent,
  parseFedEvent,
  rememberEventId,
  serializeFedEvent,
  trackMissingSeqs,
  type FedEvent,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationLinks, federationOutbox } from '../db/schema.js';
import { federation } from './instance.js';
import { postSignedToPeer } from './peerClient.js';
import { canSendTo, shouldQueueFor, type LinkState } from './linkRules.js';
import { dequeueEvent, enqueueEvent } from './outbox.js';
import { markNeedsFull } from './directorySync.js';

/** Недавние идентификаторы по каждой связке — только в памяти, см. пояснение выше. */
const recentByLink = new Map<string, string[]>();

/** Обработчики событий: F1 знает про смену визитки соседа, каталоги и гостей добавят свои в F2/F3. */
export type FedEventHandler = (input: { instanceId: string; event: FedEvent }) => Promise<void>;
const handlers = new Map<string, FedEventHandler>();

export function onFedEvent(kind: string, handler: FedEventHandler): void {
  handlers.set(kind, handler);
}

/**
 * Следующий номер для связки — атомарно, одним запросом.
 *
 * 🔴 Именно в базе и именно инкрементом на месте: два одновременных события (человек сменил имя и
 * тут же вышел из сервера) иначе получили бы один номер, и второе сосед отбросил бы как повтор.
 */
async function nextSeq(instanceId: string): Promise<number | null> {
  const [row] = await db
    .update(federationLinks)
    .set({ outEventSeq: sql`${federationLinks.outEventSeq} + 1` })
    .where(eq(federationLinks.instanceId, instanceId))
    .returning({ seq: federationLinks.outEventSeq });
  return row ? Number(row.seq) : null;
}

export type SendOutcome = 'sent' | 'queued' | 'dropped' | 'unreachable';

/** Общее начало обоих путей: выдать номер и положить в очередь; дальше — отправлять или ждать пачки. */
async function queueOne(
  instanceId: string,
  kind: string,
  payload: Record<string, unknown>,
  version?: number,
): Promise<{ event: FedEvent; apiBase: string } | SendOutcome> {
  const [link] = await db
    .select()
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, instanceId))
    .limit(1);
  if (!link) return 'dropped';
  const state = link.state as LinkState;
  // Пауза временна, и «копим» должно значить именно копим: номер выдаём сейчас, кладём в очередь,
  // уедет после снятия паузы. Иначе после паузы у соседа была бы дыра в нумерации.
  if (!canSendTo(state) && !shouldQueueFor(state)) return 'dropped';

  const seq = await nextSeq(instanceId);
  if (seq === null) return 'dropped';
  const event: FedEvent = { eventId: crypto.randomUUID(), seq, kind, createdAt: Date.now(), version, payload };
  // 🔴 Сначала В ОЧЕРЕДЬ, потом попытка отправить. Наоборот нельзя: упади процесс между отправкой и
  // записью — событие исчезло бы бесследно. А лишняя запись, доставленная сразу, тут же и удаляется.
  await enqueueEvent(instanceId, event);
  return canSendTo(state) ? { event, apiBase: link.apiBase } : 'queued';
}

/**
 * Положить событие в очередь БЕЗ немедленной отправки — уедет пачкой ближайшим проходом (§5.4).
 *
 * 🔴 Так уходит всё, чего бывает много сразу: держатель скрыл от соседей два десятка человек, и
 * двадцать отдельных подписанных запросов подряд — это не «быстрее», а вал на соседа и двадцать
 * поводов ему нас придержать по частоте. Пачка раз в пять секунд решает и то и другое.
 */
export async function queueEventTo(
  instanceId: string,
  kind: string,
  payload: Record<string, unknown>,
  version?: number,
): Promise<SendOutcome> {
  const res = await queueOne(instanceId, kind, payload, version);
  return typeof res === 'string' ? res : 'queued';
}

/** То же для всех активных связок. */
export async function queueBroadcast(
  kind: string,
  payload: Record<string, unknown>,
  version?: number,
): Promise<void> {
  const rows = await db.select().from(federationLinks).where(eq(federationLinks.state, 'active'));
  for (const row of rows) {
    try {
      await queueEventTo(row.instanceId, kind, payload, version);
    } catch (err) {
      console.warn(`[fed] событие ${kind} не встало в очередь к ${row.instanceId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Отправить событие одному соседу ПРЯМО СЕЙЧАС.
 *
 * Так уходит то, чего бывает по одному: сменилось название инстанса, закрылся сервер. Всё, чего
 * бывает пачками, идёт через `queueEventTo`.
 *
 * Возвращает `queued`, когда связка на паузе (пауза временна, события копятся) или когда отправка не
 * удалась — событие осталось в очереди и уедет с повторами. `dropped` — связка разорвана или доверие
 * потеряно: копить бессмысленно, отправлять некому.
 */
export async function sendEventTo(
  instanceId: string,
  kind: string,
  payload: Record<string, unknown>,
  version?: number,
): Promise<SendOutcome> {
  const queued = await queueOne(instanceId, kind, payload, version);
  if (typeof queued === 'string') return queued;
  const { event, apiBase } = queued;

  /**
   * 🔴 Дыра доставки (Э0 ЛС между инстансами, `docs/dm/FEDERATION.md` §2.2). Раньше событие уходило сразу, даже если более
   * раннее с этой связки ещё ждало повтора в очереди: сосед принимал «дыру», сдвигал последний номер — и раннее, доехав
   * очередью, выбрасывал как повтор. Теперь сразу уходит только событие, раньше которого в очереди этой связки НИЧЕГО нет;
   * иначе оно ждёт своей очереди и уедет ближайшим проходом строго после ранних (`runOutboxPass` идёт по номерам и встаёт
   * на первом недоставленном). Цена — до одного прохода очереди задержки, и только когда сосед уже что-то не принял.
   */
  if (await hasEarlierQueued(instanceId, event.seq)) return 'queued';

  const key = federation.signingKey();
  if (!key) return 'unreachable';
  let host: string;
  try {
    host = new URL(apiBase).host;
  } catch {
    return 'dropped';
  }
  const self = federation.identity();
  if (!self) return 'unreachable';

  const res = await postSignedToPeer({
    apiBase,
    path: '/api/fed/v1/events',
    // `instance_id` — НАШ: по нему сосед находит у себя связку и берёт ключ для проверки подписи.
    payload: { instance_id: self.instanceId, events: [serializeFedEvent(event)] },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
  });
  if (res.ok && res.value.status >= 200 && res.value.status < 300) {
    await dequeueEvent(event.eventId);
    return 'sent';
  }
  // Не дошло — событие осталось в очереди, его заберёт проход с повторами. Для вызывающего это
  // «отложено», а не «потеряно»: в этом и была вся цель очереди (#148).
  return 'queued';
}

/** Лежит ли в очереди этой связки событие с меньшим номером — тогда отправлять «сразу» значит обогнать его. */
async function hasEarlierQueued(instanceId: string, seq: number): Promise<boolean> {
  const [row] = await db
    .select({ id: federationOutbox.id })
    .from(federationOutbox)
    .where(and(eq(federationOutbox.instanceId, instanceId), lt(federationOutbox.seq, seq)))
    .limit(1);
  return row !== undefined;
}

/** Разослать событие всем активным связкам — например, что мы сменили название инстанса. */
export async function broadcastEvent(
  kind: string,
  payload: Record<string, unknown>,
  version?: number,
): Promise<void> {
  const rows = await db.select().from(federationLinks).where(eq(federationLinks.state, 'active'));
  // Последовательно и с изоляцией: недоступный сосед не должен мешать остальным (`federation-compat` §5).
  for (const row of rows) {
    try {
      await sendEventTo(row.instanceId, kind, payload, version);
    } catch (err) {
      console.warn(`[fed] событие ${kind} не ушло к ${row.instanceId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export interface ReceiveResult {
  accepted: number;
  duplicates: number;
  gaps: number;
}

/**
 * Принять пачку событий от соседа. Подпись к этому моменту проверена маршрутом.
 *
 * ⚠️ События применяются ПО ПОРЯДКУ номеров, а не в том, в каком пришли: отправитель мог собрать
 * пачку как угодно, а состояние зависит от последовательности.
 */
export async function receiveEvents(instanceId: string, rawEvents: unknown[]): Promise<ReceiveResult> {
  const [link] = await db
    .select()
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, instanceId))
    .limit(1);
  if (!link) return { accepted: 0, duplicates: 0, gaps: 0 };

  const events = rawEvents
    .map(parseFedEvent)
    .filter((e): e is FedEvent => e !== null)
    .sort((a, b) => a.seq - b.seq);

  let lastSeq = Number(link.lastEventSeq);
  // Пропуски прошлых дыр (Э0): опоздавшее раннее событие из них принимается, а не выбрасывается повтором (`judgeEvent`).
  const missingBefore = Array.isArray(link.missingEventSeqs) ? link.missingEventSeqs.filter(Number.isInteger) : [];
  let missing: number[] = missingBefore;
  let recent = recentByLink.get(instanceId) ?? [];
  const result: ReceiveResult = { accepted: 0, duplicates: 0, gaps: 0 };

  for (const event of events) {
    const verdict = judgeEvent(event, { lastSeq, recentIds: new Set(recent), missing: new Set(missing) });
    if (!verdict.accept) {
      result.duplicates += 1;
      continue;
    }
    if (verdict.gap) {
      result.gaps += 1;
      // Дыра в нумерации: что-то не доехало. Применяем всё равно — отказ ничего бы не починил, а
      // состояние ушло бы ещё дальше.
      // 🔴 А вот КАКОЕ изменение потерялось, по номеру не узнать — поэтому заказываем внеочередную
      // полную сверку каталога (F2, §5.4). Без неё пропущенное «человека удалили» осталось бы в
      // кеше до следующей суточной сверки, и человек висел бы в списках как живой.
      void markNeedsFull(instanceId).catch(() => {
        /* не смогли отметить — сверка всё равно придёт по расписанию */
      });
      console.warn(`[fed] пропуск в событиях от ${instanceId}: ждали ${lastSeq + 1}, пришло ${event.seq}`);
    }
    if (verdict.late) {
      console.warn(`[fed] опоздавшее событие от ${instanceId}: №${event.seq} после №${lastSeq} — принято`);
    }

    const handler = handlers.get(event.kind);
    // 🔴 Неизвестный тип пропускается МОЛЧА и номер всё равно двигается: сосед новее нас, и это
    // штатная ситуация (`docs/federation-compat.md`). Бросить здесь значило бы застрять навсегда.
    if (handler) {
      try {
        await handler({ instanceId, event });
      } catch (err) {
        console.warn(`[fed] обработчик ${event.kind} упал: ${err instanceof Error ? err.message : err}`);
      }
    }
    missing = trackMissingSeqs(missing, lastSeq, event.seq);
    // Опоздавшее последний номер не двигает: он уже впереди.
    if (!verdict.late) lastSeq = event.seq;
    recent = rememberEventId(recent, event.eventId);
    result.accepted += 1;
  }

  recentByLink.set(instanceId, recent);
  const missingChanged = missing.length !== missingBefore.length || missing.some((n, i) => n !== missingBefore[i]);
  if (lastSeq !== Number(link.lastEventSeq) || missingChanged) {
    await db
      .update(federationLinks)
      .set({ lastEventSeq: lastSeq, missingEventSeqs: missing, lastSeenAt: new Date() })
      .where(eq(federationLinks.instanceId, instanceId));
  }
  return result;
}

/** Забыть окно дедупа для связки — при разрыве и перепривязке нумерация начинается заново. */
export function forgetEventWindow(instanceId: string): void {
  recentByLink.delete(instanceId);
}
