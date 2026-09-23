import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationReports } from '../db/schema.js';

/**
 * Отметить исходящие жалобы доставленными — зовётся из очереди, когда сосед ПРИНЯЛ пачку событий.
 *
 * 🔴 Без этого держатель навсегда видел «отправлена»: `delivered` ставит у себя получатель, а
 * квитанции назад протокол не шлёт (и не должен — это лишний круг событий ради одной строки).
 * Единственное, что мы знаем достоверно на своей стороне, — сосед ответил 2xx на пачку с жалобой;
 * этого ровно и хватает на слово «доставлена», и говорить больше мы не вправе. «Прочитана» так и
 * останется за ответом держателя (`report.reply` → `answered`), потому что чтение видит только он.
 */
export async function markReportsDelivered(instanceId: string, reportIds: readonly string[]): Promise<void> {
  if (reportIds.length === 0) return;
  await db
    .update(federationReports)
    .set({ status: 'delivered', updatedAt: new Date() })
    .where(
      and(
        eq(federationReports.direction, 'out'),
        eq(federationReports.instanceId, instanceId),
        inArray(federationReports.reportId, [...reportIds]),
        // ⚠️ Только из «отправлена»: ответ держателя мог прийти раньше, чем очередь доложила о
        // доставке, и откатывать `answered` назад в `delivered` значило бы терять его ответ.
        eq(federationReports.status, 'sent'),
      ),
    );
}
