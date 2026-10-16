/**
 * Очередь исходящих событий поверх базы (#139 F1, #148).
 *
 * Правила — в `outboxRules.ts`; здесь работа с настоящей таблицей, сетью и часами.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { FED_EVENTS, serializeFedEvent, type FedEvent } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationLinks, federationOutbox } from '../db/schema.js';
import { federation } from './instance.js';
import { postSignedToPeer } from './peerClient.js';
import { dropReason, nextAttemptDelayMs, queueAction } from './outboxRules.js';
import { markReportsDelivered } from './reportStatus.js';

/** Положить событие в очередь. Доставку выполнит проход — здесь только запись. */
export async function enqueueEvent(instanceId: string, event: FedEvent): Promise<void> {
  await db.insert(federationOutbox).values({
    id: randomUUID(),
    instanceId,
    seq: event.seq,
    eventId: event.eventId,
    kind: event.kind,
    version: event.version ?? null,
    payload: event.payload,
  });
}

/** Убрать доставленное событие из очереди. */
export async function dequeueEvent(eventId: string): Promise<void> {
  await db.delete(federationOutbox).where(eq(federationOutbox.eventId, eventId));
}

/** Выбросить всю очередь связки — при разрыве и потере доверия отправлять уже некому. */
export async function discardQueue(instanceId: string): Promise<number> {
  const rows = await db
    .delete(federationOutbox)
    .where(eq(federationOutbox.instanceId, instanceId))
    .returning({ id: federationOutbox.id });
  return rows.length;
}

/** Сколько событий ждёт доставки — для вкладки «Федерация». */
export async function queueDepth(instanceId: string): Promise<number> {
  const rows = await db
    .select({ id: federationOutbox.id })
    .from(federationOutbox)
    .where(eq(federationOutbox.instanceId, instanceId));
  return rows.length;
}

/**
 * Как пачка уезжает к соседу. Отдельным типом, чтобы проход можно было прогнать с подставной
 * отправкой: настоящая уходит в сеть, а проверять надо порядок, границы пачек и остановку на первом
 * недоставленном — то есть всё, кроме сети.
 */
export type DeliverBatch = typeof postSignedToPeer;

export interface DeliveryReport {
  delivered: number;
  failed: number;
  dropped: number;
  held: number;
}

/**
 * Один проход очереди: по каждой связке доставляем, что накопилось.
 *
 * 🔴 Внутри связки идём строго по возрастанию номера и **останавливаемся на первом недоставленном**.
 * Иначе пятое уедет раньше четвёртого, получатель запомнит номер пять — и четвёртое, придя следом,
 * будет отброшено им как уже виденное. Изменение при этом пропадёт без всякой ошибки.
 */
export async function runOutboxPass(
  now = Date.now(),
  deliver: DeliverBatch = postSignedToPeer,
  /**
   * Чем подписываем. Параметром — по просьбе Codex (16.09): при выключенной федерации личности нет,
   * проход сразу возвращал пустой отчёт, и пачки 50/50/20 с остановкой на первом отказе нельзя было
   * проверить вообще. Сеть здесь уже инъецирована, а личность оставалась глобальной — то есть
   * проверялось всё, кроме главного.
   */
  signer: () => { self: { instanceId: string } | null; key: { kid: string; privateKeyDer: Uint8Array } | null } = () => ({
    self: federation.identity(),
    key: federation.signingKey(),
  }),
): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, failed: 0, dropped: 0, held: 0 };
  const { self, key } = signer();
  if (!self || !key) return report;

  const links = await db.select().from(federationLinks);
  for (const link of links) {
    const action = queueAction(link.state);
    if (action === 'discard') {
      report.dropped += await discardQueue(link.instanceId);
      continue;
    }
    if (action === 'hold') {
      report.held += 1;
      continue;
    }

    const pending = await db
      .select()
      .from(federationOutbox)
      .where(eq(federationOutbox.instanceId, link.instanceId))
      .orderBy(asc(federationOutbox.seq));

    let host: string;
    try {
      host = new URL(link.apiBase).host;
    } catch {
      continue;
    }

    // Протухшее выбрасываем ДО сборки пачки: иначе одно застрявшее событие тащило бы за собой
    // всю пачку и та упиралась бы в него на каждом проходе.
    const alive = [];
    /**
     * 🔴 Отправляем только НЕПРЕРЫВНОЕ начало очереди, чей срок повтора наступил (Э0, `docs/dm/FEDERATION.md` §2.2). Раньше
     * выборка брала «всё, чей срок наступил»: пачка 1–50 не дошла и получила паузу, а 51-е и дальше паузы не имели — следующий
     * проход отправлял их первыми, сосед сдвигал последний номер, и 1–50 потом выбрасывались им как повторы.
     */
    let waiting = false;
    for (const row of pending) {
      const drop = dropReason({ attempts: row.attempts, createdAt: row.createdAt.getTime() }, now);
      if (!drop) {
        if (row.nextAttemptAt.getTime() > now) waiting = true;
        if (!waiting) alive.push(row);
        continue;
      }
      await db.delete(federationOutbox).where(eq(federationOutbox.id, row.id));
      report.dropped += 1;
      console.warn(`[fed] событие ${row.kind} для ${link.instanceId} выброшено из очереди: ${drop}`);
      // ⚠️ Выбросив одно, продолжаем: порядок уже нарушен самим фактом потери, и держать
      // остальные в заложниках у протухшего смысла нет.
    }

    let deliveredHere = 0;
    for (let i = 0; i < alive.length; i += BATCH_MAX) {
      const batch = alive.slice(i, i + BATCH_MAX);
      const events: FedEvent[] = batch.map((row) => ({
        eventId: row.eventId,
        seq: Number(row.seq),
        kind: row.kind,
        createdAt: row.createdAt.getTime(),
        version: row.version ?? undefined,
        payload: row.payload,
      }));
      const sent = await deliver({
        apiBase: link.apiBase,
        path: '/api/fed/v1/events',
        payload: { instance_id: self.instanceId, events: events.map(serializeFedEvent) },
        keyid: key.kid,
        privateKeyDer: key.privateKeyDer,
        allowHosts: new Set([host]),
        now,
      });

      const ok = sent.ok && sent.value.status >= 200 && sent.value.status < 300;
      if (ok) {
        await db.delete(federationOutbox).where(
          inArray(federationOutbox.id, batch.map((row) => row.id)),
        );
        /**
         * Жалоба в этой пачке дошла — держателю пора увидеть «доставлена» вместо «отправлена»
         * (§5.11). Это единственный момент, когда мы знаем о доставке достоверно: дальше состояние
         * меняет только ответ соседа.
         */
        const reportIds = batch
          .filter((row) => row.kind === FED_EVENTS.reportCreate)
          .map((row) => (row.payload as { report_id?: unknown } | null)?.report_id)
          .filter((v): v is string => typeof v === 'string');
        await markReportsDelivered(link.instanceId, reportIds);
        report.delivered += batch.length;
        deliveredHere += batch.length;
        continue;
      }

      const detail = sent.ok ? `ответ ${sent.value.status}` : (sent.detail ?? sent.problem);
      // Неудача считается КАЖДОМУ событию пачки: они и правда не доставлены, и срок жизни у каждого
      // должен идти своим ходом, иначе хвост пачки жил бы вечно.
      for (const row of batch) {
        const attempts = row.attempts + 1;
        await db
          .update(federationOutbox)
          .set({
            attempts,
            nextAttemptAt: new Date(now + nextAttemptDelayMs(attempts)),
            lastError: detail.slice(0, 200),
          })
          .where(eq(federationOutbox.id, row.id));
      }
      report.failed += batch.length;
      // 🔴 Дальше по ЭТОЙ связке не идём — см. пояснение про порядок номеров выше.
      break;
    }

    // ⚠️ «Последний раз видели» обновляем ТОЛЬКО после удачной доставки: иначе лежачий сосед
    // выглядел бы во вкладке «Федерация» живым просто потому, что мы к нему стучались.
    if (deliveredHere > 0) {
      await db
        .update(federationLinks)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(federationLinks.instanceId, link.instanceId));
    }
  }

  return report;
}

/**
 * Сколько событий уезжает одним запросом (план §5.4 — «пачками раз в ~5 с»).
 *
 * Предел нужен с обеих сторон: у соседа есть предел на размер тела, а у нас — правило «упёрлись в
 * недоставленное, дальше по связке не идём». Слишком большая пачка делает это правило грубым: одна
 * неудача откладывает сотни событий разом.
 */
const BATCH_MAX = 50;

/**
 * Как часто разбирать очередь.
 *
 * ⚠️ Пять секунд — это не «частота синхронизации», а обещание из плана: изменения каталога копятся
 * и уезжают пачкой примерно раз в пять секунд. Нагрузки это не добавляет — повторы всё равно
 * отодвинуты по своему сроку, а свежая пачка обычно одна на проход.
 */
const PASS_INTERVAL_MS = 5_000;

export function startOutboxWorker(): void {
  let running = false;
  const timer = setInterval(() => {
    // 🔴 Поверх незавершённого прохода новый не стартует (аудит 19.09, F-09): пока один сосед цедит
    // ответ, каждые пять секунд начинался ещё один проход и вис там же — за сутки тысячи сокетов.
    if (running) return;
    running = true;
    void runOutboxPass()
      .catch((err: unknown) => {
        console.warn(`[fed] проход очереди упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  }, PASS_INTERVAL_MS);
  timer.unref();
}
