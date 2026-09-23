/**
 * Журнал федерации уровня ИНСТАНСА (#139; аудит 19.09, F-25).
 *
 * До этого события связок, первый вход гостя и отказы гостевых сессий писались только в вывод
 * процесса — и терялись при пересоздании контейнера. После происшествия вроде F-01/F-02 держатель
 * не смог бы восстановить, что случилось. Серверный `audit_log` для этого не годится: он ведётся ПО
 * СЕРВЕРУ (нужны `serverId` и `actorId`), а связка — событие инстанса, где ни того ни другого нет.
 *
 * ⚠️ Запись не ждётся и не роняет вызывающего: журнал — след, а не условие. Не записалось —
 * осталась строка в выводе процесса, как и раньше.
 */

import { randomUUID } from 'node:crypto';
import { desc, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationAudit } from '../db/schema.js';

/** Сколько держим записи: полгода хватает разобрать любое «а что тогда случилось». */
export const AUDIT_KEEP_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Записать событие. `instanceId` и `actorId`/`issuedBy` из подробностей выносятся в свои колонки —
 * по ним журнал фильтруется во вкладке, остальное лежит как есть.
 */
export function fedAudit(event: string, detail: Record<string, unknown> = {}): void {
  const instanceId = typeof detail.instanceId === 'string' ? detail.instanceId : null;
  const actorId =
    typeof detail.actorId === 'string' ? detail.actorId : typeof detail.issuedBy === 'string' ? detail.issuedBy : null;
  console.log(`[fed] ${event} ${JSON.stringify(detail)}`);
  void db
    .insert(federationAudit)
    .values({ id: randomUUID(), event: event.slice(0, 64), instanceId, actorId, detail })
    .catch((err: unknown) => {
      console.warn(`[fed] журнал не записал ${event}: ${err instanceof Error ? err.message : String(err)}`);
    });
}

export interface FederationAuditEntry {
  id: string;
  at: string;
  event: string;
  instanceId: string | null;
  actorId: string | null;
  detail: Record<string, unknown>;
}

/** Последние записи — для вкладки «Федерация». */
export async function recentAudit(limit = 200): Promise<FederationAuditEntry[]> {
  const rows = await db.select().from(federationAudit).orderBy(desc(federationAudit.at)).limit(Math.min(limit, 500));
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    event: r.event,
    instanceId: r.instanceId,
    actorId: r.actorId,
    detail: (r.detail ?? {}) as Record<string, unknown>,
  }));
}

/** Убрать старое: журнал — не архив. */
export async function pruneAudit(now: number): Promise<number> {
  const rows = await db
    .delete(federationAudit)
    .where(lt(federationAudit.at, new Date(now - AUDIT_KEEP_MS)))
    .returning({ id: federationAudit.id });
  return rows.length;
}
