import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { DmReportRow } from '@gusvoice/shared';
import { type ConvAccess, type Delivery, journal, lockConversation } from './conversations.js';
import { db } from './db/index.js';
import { conversationMembers, conversationMessages, dmReports } from './db/schema.js';
import { cleanReportComment, DM_REPORT_MERGE_MS, evidenceFrom } from './strangerRules.js';
import { uuidv7 } from './util.js';

/**
 * Плашка незнакомца и жалоба из ЛС (08.10, #211, С7, G30, Р-10, `stranger1`): запись в БД. Правила — `strangerRules.ts`.
 * Состояние плашки («скрыл крестиком») — столбец МОЕЙ строки участника, поэтому едет на мои устройства тем же `conv.change`,
 * что архив и закреп (строка журнала `'draft'` = «моя строка изменилась»).
 */

export type StrangerHideResult = { kind: 'ok'; delivery: Delivery | null } | { kind: 'not-found' };

/** Крестик «скрыть» (Telegram: `hide_peer_settings_bar`): пометить моей строке. Повтор — без записи и события. */
export async function hideStrangerBar(me: string, access: ConvAccess): Promise<StrangerHideResult> {
  const conversationId = access.conversationId;
  const mine = and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me));
  return db.transaction(async (tx): Promise<StrangerHideResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    const [row] = await tx
      .select({ at: conversationMembers.strangerHiddenAt, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(mine);
    if (!row || row.leftAt) return { kind: 'not-found' };
    if (row.at) return { kind: 'ok', delivery: null };
    await tx.update(conversationMembers).set({ strangerHiddenAt: sql`now()` }).where(mine);
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return { kind: 'ok', delivery: { conversationId, messageId: null, pts } };
  });
}

export type DmReportResult =
  | { kind: 'ok'; reportId: string; merged: boolean; delivery: Delivery | null }
  | { kind: 'not-found' }
  | { kind: 'not-direct' };

/**
 * Жалоба на собеседника 1:1. Улики — до пяти последних сообщений собеседника, видимых МНЕ (не удалённых, не спрятанных у
 * меня, не придержанных). Повторная жалоба на того же человека за сутки заменяет причину, комментарий и улики первой
 * (одна строка у держателя, а не поток). После жалобы плашка гаснет — как после «Заблокировать».
 */
export async function reportConversationPeer(
  me: string,
  access: ConvAccess,
  input: { reason: string; comment: unknown },
): Promise<DmReportResult> {
  const peerId = access.peerId;
  if (access.kind !== 'direct' || !peerId) return { kind: 'not-direct' };
  const conversationId = access.conversationId;
  const mine = and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, me));
  return db.transaction(async (tx): Promise<DmReportResult> => {
    if (!(await lockConversation(tx, conversationId))) return { kind: 'not-found' };
    const [row] = await tx.select({ leftAt: conversationMembers.leftAt }).from(conversationMembers).where(mine);
    if (!row || row.leftAt) return { kind: 'not-found' };
    const msgs = await tx
      .select({
        id: conversationMessages.id,
        content: conversationMessages.content,
        attachments: conversationMessages.attachments,
        at: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          eq(conversationMessages.authorId, peerId),
          sql`${conversationMessages.deletedAt} IS NULL AND NOT ${conversationMessages.withheld} AND NOT (${me} = ANY(${conversationMessages.hiddenFor})) AND ${conversationMessages.service} IS NULL`,
        ),
      )
      .orderBy(desc(conversationMessages.sortKey))
      .limit(10);
    const evidence = evidenceFrom(
      msgs.map((m) => ({ id: m.id, content: m.content, attachmentCount: m.attachments.length, at: m.at })),
    );
    const comment = cleanReportComment(input.comment);
    const now = Date.now();
    const [prev] = await tx
      .select({ id: dmReports.id })
      .from(dmReports)
      .where(
        and(
          eq(dmReports.reporterId, me),
          eq(dmReports.reportedId, peerId),
          gt(dmReports.createdAt, new Date(now - DM_REPORT_MERGE_MS)),
        ),
      )
      .orderBy(desc(dmReports.createdAt))
      .limit(1);
    let reportId: string;
    if (prev) {
      reportId = prev.id;
      await tx
        .update(dmReports)
        .set({ reason: input.reason, comment, evidence, status: 'new', updatedAt: new Date(now) })
        .where(eq(dmReports.id, reportId));
    } else {
      reportId = uuidv7();
      await tx
        .insert(dmReports)
        .values({ id: reportId, reporterId: me, reportedId: peerId, conversationId, reason: input.reason, comment, evidence });
    }
    await tx
      .update(conversationMembers)
      .set({ strangerHiddenAt: sql`COALESCE(${conversationMembers.strangerHiddenAt}, now())` })
      .where(mine);
    const pts = await journal(tx, [{ userId: me, conversationId, kind: 'draft', messageId: null }]);
    return { kind: 'ok', reportId, merged: !!prev, delivery: { conversationId, messageId: null, pts } };
  });
}

/** Список жалоб из ЛС для супер-админа: новые сверху, закрытые ниже. */
export async function listDmReports(): Promise<DmReportRow[]> {
  const res = await db.execute(sql`
    SELECT r.id, r.reason, r.comment, r.evidence, r.status, r.created_at,
      a.id AS a_id, a.username AS a_username, a.display_name AS a_name,
      b.id AS b_id, b.username AS b_username, b.display_name AS b_name
    FROM dm_reports r
    JOIN users a ON a.id = r.reporter_id
    JOIN users b ON b.id = r.reported_id
    ORDER BY (r.status = 'new') DESC, r.created_at DESC
    LIMIT 200`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    reason: String(r.reason),
    comment: typeof r.comment === 'string' ? r.comment : null,
    evidence: Array.isArray(r.evidence) ? (r.evidence as DmReportRow['evidence']) : [],
    status: r.status === 'closed' ? 'closed' : 'new',
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))).toISOString(),
    reporter: { id: String(r.a_id), username: String(r.a_username), displayName: String(r.a_name) },
    reported: { id: String(r.b_id), username: String(r.b_username), displayName: String(r.b_name) },
  }));
}

/** Закрыть жалобу (рассмотрена). `false` — такой нет ИЛИ она уже закрыта (повтор → 404, R61). */
export async function closeDmReport(id: string): Promise<boolean> {
  const rows = await db
    .update(dmReports)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(and(eq(dmReports.id, id), eq(dmReports.status, 'new')))
    .returning({ id: dmReports.id });
  return rows.length > 0;
}
