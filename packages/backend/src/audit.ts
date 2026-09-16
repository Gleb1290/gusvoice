import type { AuditAction } from '@gusvoice/shared';
import { db } from './db/index.js';
import { auditLog } from './db/schema.js';
import { id } from './util.js';

export interface AuditOptions {
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
}

/**
 * Append an entry to a server's audit trail. Audit writes are best-effort: a failure here
 * must never break the action that triggered it, so errors are swallowed (and logged).
 *
 * 🔴 `action` — закрытый союз, а не строка. Так новое действие невозможно завести, не написав
 * для него человеческую строку в журнале: клиент разбирает тот же союз исчерпывающе, и типы
 * падают. Ровно этой связи не было до 06.09, и пятнадцать действий печатались кодом.
 */
export async function writeAudit(
  serverId: string,
  actorId: string,
  action: AuditAction,
  opts: AuditOptions = {},
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: id(),
      serverId,
      actorId,
      action,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      data: opts.data ?? {},
    });
  } catch (err) {
    console.error('[audit] failed to write entry', action, err);
  }
}
