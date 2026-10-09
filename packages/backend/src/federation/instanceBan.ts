/**
 * Запрет человеку на весь инстанс и жалоба его держателю (#139, F3, план §5.11).
 *
 * Требование 36: у друга один человек ведёт себя плохо, остальных пускать хочется. Бан на сервере
 * для этого мал (он про один сервер), а разрыв связки велик (он про всех). Нужен третий инструмент,
 * и он здесь.
 *
 * Требование 37: разбираться с человеком может только ЕГО держатель — у нас нет ни его переписки
 * дома, ни возможности что-то ему объяснить. Поэтому к запрету прилагается жалоба: от имени
 * инстанса, с причиной и — только если модератор выбрал вручную — с примерами сообщений.
 *
 * 🔴 Человек жалобу не видит и причину запрета не узнаёт. Он видит нейтральное «вход на инстанс
 * закрыт»: иначе запрет превращается в переписку с тем, кого только что выставили.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import { FED_EVENTS, FED_MEMBERSHIP_STATES } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationReports, instanceBans, serverMembers, users } from '../db/schema.js';
import { env } from '../env.js';
import { bumpTokenGeneration } from '../auth.js';
import { removeFromOtherRooms } from '../livekit.js';
import { publishToUser } from '../realtime.js';
import { banActive, mergeReportReason } from './guestRules.js';
import { announceMembership } from './guestMembership.js';
import { onFedEvent, queueEventTo } from './eventStream.js';
import { CLOSE_REASONS } from './guestAccess.js';

/** Сколько сообщений можно приложить к жалобе и сколько жалоб в сутки на связку (§5.11). */
export const REPORT_EVIDENCE_MAX = 5;
export const REPORTS_PER_DAY = 20;
/** Повторная жалоба на того же человека за это время приклеивается к первой, а не заводит новую. */
export const REPORT_MERGE_MS = 24 * 60 * 60 * 1000;

/** Действует ли запрет на инстанс для этой глобальной личности. */
export async function instanceBanFor(
  homeInstanceId: string,
  homeUserId: string,
  now = Date.now(),
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(instanceBans)
    .where(and(eq(instanceBans.homeInstanceId, homeInstanceId), eq(instanceBans.homeUserId, homeUserId)))
    .limit(1);
  return banActive(row ?? null, now);
}

/**
 * Запретить человеку вход на наш инстанс.
 *
 * Порядок как при закрытии сервера (§5.3.1) и по той же причине: сначала перестаёт действовать
 * сессия и голос, потом снимаются членства, потом узнаёт дом. Наоборот — человек несколько секунд
 * говорит на сервере, куда ему уже закрыт вход.
 */
export async function banInstanceUser(input: {
  homeInstanceId: string;
  homeUserId: string;
  reason: string | null;
  expiresAt: Date | null;
  createdBy: string;
}): Promise<{ servers: string[] }> {
  await db
    .insert(instanceBans)
    .values({
      homeInstanceId: input.homeInstanceId,
      homeUserId: input.homeUserId,
      reason: input.reason,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [instanceBans.homeInstanceId, instanceBans.homeUserId],
      set: {
        reason: input.reason,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
        createdAt: new Date(),
        // Забанили снова — отметка о прошлом снятии больше не действует.
        removedAt: null,
        removedBy: null,
      },
    });

  const [shadow] = await db
    .select()
    .from(users)
    .where(and(eq(users.homeInstanceId, input.homeInstanceId), eq(users.homeUserId, input.homeUserId)))
    .limit(1);
  // Запрещать можно и того, кто ни разу не заходил (нашли в каталоге соседа) — теневой строки нет,
  // и это не ошибка: запрет сработает, когда он попробует войти.
  if (!shadow) return { servers: [] };

  const memberships = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, shadow.id));

  await bumpTokenGeneration(shadow.id);
  await removeFromOtherRooms(shadow.id, '').catch(() => {});
  await removeFromOtherRooms(`${shadow.id}#screen`, '').catch(() => {});

  /**
   * 🔴 Членства СНИМАЮТСЯ (`removed`), а не закрываются: это не решение про сервер, как в §5.3.1, а
   * решение про человека. Сняли запрет — он входит заново по ссылке, но прежние членства не
   * возвращаются, ровно как бан в Discord.
   */
  await db
    .update(serverMembers)
    .set({ state: FED_MEMBERSHIP_STATES.removed })
    .where(eq(serverMembers.userId, shadow.id));

  for (const m of memberships) {
    await publishToUser(shadow.id, {
      t: 'server.access_closed',
      serverId: m.serverId,
      reason: CLOSE_REASONS.bannedByInstance,
      // Контактов здесь нет намеренно: запрет — не приглашение к разговору (§5.11).
      contacts: [],
    }).catch(() => {});
    await announceMembership({
      guest: shadow,
      serverId: m.serverId,
      state: FED_MEMBERSHIP_STATES.removed,
      reason: CLOSE_REASONS.bannedByInstance,
    });
  }
  return { servers: memberships.map((m) => m.serverId) };
}

/**
 * Снять запрет. Прежние членства НЕ возвращаются — человек входит заново по ссылке.
 *
 * ⚠️ Строка остаётся с отметкой о снятии: это журнал (§5.11), и вопрос «а его раньше не банили?»
 * возникает чаще, чем кажется. Повторный запрет той же личности просто перепишет строку.
 */
export async function unbanInstanceUser(
  homeInstanceId: string,
  homeUserId: string,
  removedBy: string,
): Promise<boolean> {
  const removed = await db
    .update(instanceBans)
    .set({ removedAt: new Date(), removedBy })
    .where(and(eq(instanceBans.homeInstanceId, homeInstanceId), eq(instanceBans.homeUserId, homeUserId)))
    .returning({ id: instanceBans.homeUserId });
  return removed.length > 0;
}

/** Список запретов для вкладки «Федерация». */
export async function listInstanceBans(now = Date.now()) {
  const rows = await db.select().from(instanceBans).orderBy(desc(instanceBans.createdAt));
  return rows.map((r) => ({ ...r, active: banActive(r, now) }));
}

// --------------------------------------------------------------------------------------------
// Жалобы
// --------------------------------------------------------------------------------------------

export type ReportEvidence = { text: string; at: number; channel: string };

export type ReportResult =
  | { ok: true; reportId: string; merged: boolean }
  | { ok: false; problem: 'rate-limited' | 'unsupported' | 'no-link' };

/**
 * Пожаловаться держателю инстанса на его человека.
 *
 * ⚠️ Возможность `reports` у соседа НЕ проверяется здесь: проверка по `features` — дело
 * вызывающего (галочка в окне бана неактивна, если сосед не умеет). Здесь бы она означала тихий
 * отказ уже после того, как человек нажал «Пожаловаться».
 */
export async function sendReport(input: {
  instanceId: string;
  reportedUserId: string;
  action: 'instance_ban' | 'server_ban';
  serverName: string | null;
  reason: string | null;
  evidence: ReportEvidence[];
  now?: number;
}): Promise<ReportResult> {
  const now = input.now ?? Date.now();

  // Предел на связку: жалоба это письмо живому человеку, и двадцать в сутки — уже поток.
  const recent = await db
    .select({ id: federationReports.id })
    .from(federationReports)
    .where(
      and(
        eq(federationReports.direction, 'out'),
        eq(federationReports.instanceId, input.instanceId),
        gt(federationReports.createdAt, new Date(now - REPORT_MERGE_MS)),
      ),
    );
  if (recent.length >= REPORTS_PER_DAY) return { ok: false, problem: 'rate-limited' };

  /**
   * Повторная жалоба на того же человека за сутки ПРИКЛЕИВАЕТСЯ к первой (§5.11).
   *
   * Иначе один разбушевавшийся человек превращается в десять писем держателю за вечер — и тот
   * перестаёт их читать ровно тогда, когда читать важнее всего.
   */
  const [existing] = await db
    .select()
    .from(federationReports)
    .where(
      and(
        eq(federationReports.direction, 'out'),
        eq(federationReports.instanceId, input.instanceId),
        eq(federationReports.reportedUserId, input.reportedUserId),
        gt(federationReports.createdAt, new Date(now - REPORT_MERGE_MS)),
      ),
    )
    .orderBy(desc(federationReports.createdAt))
    .limit(1);

  const evidence = input.evidence.slice(0, REPORT_EVIDENCE_MAX);

  if (existing) {
    const merged = [...existing.evidence, ...evidence].slice(0, REPORT_EVIDENCE_MAX);
    // Причины тоже склеиваются (#204): раньше новая затирала прежнюю, и держатель видел только последнюю. Уходит соседу
    // склеенная — его приём под тем же `report_id` заменяет причину целиком (`mergeReportReason`).
    const reason = mergeReportReason(existing.reason, input.reason);
    await db
      .update(federationReports)
      .set({ evidence: merged, reason, updatedAt: new Date(now) })
      .where(eq(federationReports.id, existing.id));
    await deliver(input.instanceId, existing.reportId, { ...input, reason, evidence: merged, now });
    return { ok: true, reportId: existing.reportId, merged: true };
  }

  const reportId = randomUUID();
  await db.insert(federationReports).values({
    id: randomUUID(),
    direction: 'out',
    instanceId: input.instanceId,
    reportId,
    reportedUserId: input.reportedUserId,
    action: input.action,
    serverName: input.serverName,
    reason: input.reason,
    evidence,
    status: 'sent',
  });
  await deliver(input.instanceId, reportId, { ...input, evidence, now });
  return { ok: true, reportId, merged: false };
}

async function deliver(
  instanceId: string,
  reportId: string,
  input: {
    reportedUserId: string;
    action: string;
    serverName: string | null;
    reason: string | null;
    evidence: ReportEvidence[];
    now: number;
  },
): Promise<void> {
  if (!env.federation.enabled) return;
  await queueEventTo(instanceId, FED_EVENTS.reportCreate, {
    report_id: reportId,
    reported_user_id: input.reportedUserId,
    action: input.action,
    server_name: input.serverName,
    reason: input.reason,
    evidence: input.evidence.map((e) => ({ text: e.text, at: e.at, channel: e.channel })),
    created_at: input.now,
  });
}

/** Ответить на входящую жалобу (держатель дома → хосту). */
export async function replyToReport(id: string, text: string): Promise<boolean> {
  const [row] = await db.select().from(federationReports).where(eq(federationReports.id, id)).limit(1);
  if (!row || row.direction !== 'in') return false;
  await db
    .update(federationReports)
    .set({ reply: text, status: 'answered', updatedAt: new Date() })
    .where(eq(federationReports.id, id));
  if (env.federation.enabled) {
    await queueEventTo(row.instanceId, FED_EVENTS.reportReply, {
      report_id: row.reportId,
      reply: text,
      at: Date.now(),
    });
  }
  return true;
}

/** Улики из нагрузки события — обрезанные по нашим пределам. */
function parseEvidence(raw: unknown): ReportEvidence[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .slice(0, REPORT_EVIDENCE_MAX)
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e.text === 'string')
    .map((e) => ({
      text: String(e.text).slice(0, 2000),
      at: typeof e.at === 'number' ? e.at : 0,
      channel: typeof e.channel === 'string' ? e.channel.slice(0, 64) : '',
    }));
}

/** Обработчики жалоб от соседей. */
export function registerReportHandlers(): void {
  onFedEvent(FED_EVENTS.reportCreate, async ({ instanceId, event }) => {
    const p = event.payload as Record<string, unknown>;
    // Длины строк — наши, а не соседа (F-08): идентификаторы у нас до 64, остальное как у своих жалоб.
    const reportId = typeof p.report_id === 'string' && p.report_id.length > 0 ? p.report_id.slice(0, 64) : null;
    const reported = typeof p.reported_user_id === 'string' && p.reported_user_id.length > 0 ? p.reported_user_id.slice(0, 64) : null;
    if (!reportId || !reported) return;

    /**
     * 🔴 Жалоба обязана быть на НАШЕГО человека: сосед не вправе жаловаться нам на людей третьего
     * инстанса — разбираться с ними мы всё равно не можем, а список чужих людей нам бы так
     * пересылали под видом модерации.
     */
    const [user] = await db
      .select({ home: users.homeInstanceId })
      .from(users)
      .where(eq(users.id, reported))
      .limit(1);
    if (!user || user.home !== null) return;

    const now = Date.now();
    /**
     * 🔴 Приём считает то же, что отправка (аудит 19.09, F-08; подтверждено run-1): суточный предел
     * на связку и склейка по человеку. Раньше предел стоял только на ОТПРАВКЕ, а входящие писались
     * все подряд — с полями любой длины, и на каждую держателю уходило по письму и пушу (см.
     * `alerts.ts`): таблица росла на десятки килобайт за событие, настоящие жалобы вытеснялись из
     * последних 200 во вкладке, а «доверие потеряно» тонуло в почте. Сверх предела — молча
     * отбрасываем: отвечать соседу тут нечем, событие уже принято. Предел стоит ДО слияния по
     * известному `report_id` (#196 п. 13): дополнения к жалобам — те же события от того же соседа.
     */
    const recent = await db
      .select({ id: federationReports.id })
      .from(federationReports)
      .where(
        and(
          eq(federationReports.direction, 'in'),
          eq(federationReports.instanceId, instanceId),
          gt(federationReports.createdAt, new Date(now - REPORT_MERGE_MS)),
        ),
      );
    if (recent.length >= REPORTS_PER_DAY) {
      console.warn(`[fed] жалоба от ${instanceId} отброшена: больше ${REPORTS_PER_DAY} за сутки`);
      return;
    }

    /**
     * Тот же `report_id` — либо повтор доставки, либо ДОПОЛНЕНИЕ (ревью #195 п. 11): отправитель
     * сливает вторую жалобу на того же человека за сутки в первую и шлёт её под тем же id с новыми
     * уликами. Улики склеиваем без дублей, причину обновляем; новой строки не заводим. Держатель о
     * новых уликах узнаёт как о новой жалобе: ключ записи журнала оповещений растёт вместе с числом
     * улик (`alerts.ts`).
     */
    const [known] = await db
      .select()
      .from(federationReports)
      .where(
        and(
          eq(federationReports.direction, 'in'),
          eq(federationReports.instanceId, instanceId),
          eq(federationReports.reportId, reportId),
        ),
      )
      .limit(1);
    if (known) {
      // 🔴 Дополнение — только к жалобе на ТОГО ЖЕ человека (#196 п. 13): иначе под известным id
      // подменяли бы, на кого жалоба, минуя проверку «наш ли это человек» выше.
      if (known.reportedUserId !== reported) {
        console.warn(`[fed] дополнение к жалобе ${reportId} от ${instanceId} отброшено: другой человек`);
        return;
      }
      const seen = new Set(known.evidence.map((e) => `${e.at}:${e.text}`));
      const merged = [...known.evidence, ...parseEvidence(p.evidence).filter((e) => !seen.has(`${e.at}:${e.text}`))].slice(
        0,
        REPORT_EVIDENCE_MAX,
      );
      const reason = typeof p.reason === 'string' ? p.reason.slice(0, 2000) : known.reason;
      if (merged.length !== known.evidence.length || reason !== known.reason) {
        await db
          .update(federationReports)
          .set({
            evidence: merged,
            reason,
            updatedAt: new Date(now),
            // Отметка улик двигается только с уликами (#197 п. 4): по ней `alerts.ts` решает, оповещать
            // ли заново; смена причины и ответ держателя её не трогают.
            ...(merged.length !== known.evidence.length ? { evidenceAt: new Date(now) } : {}),
          })
          .where(eq(federationReports.id, known.id));
      }
      return;
    }

    const evidence = parseEvidence(p.evidence);
    const reason = typeof p.reason === 'string' ? p.reason.slice(0, 2000) : null;

    // Повторная жалоба на того же человека за сутки приклеивается к первой — как на отправке.
    const [existing] = await db
      .select()
      .from(federationReports)
      .where(
        and(
          eq(federationReports.direction, 'in'),
          eq(federationReports.instanceId, instanceId),
          eq(federationReports.reportedUserId, reported),
          gt(federationReports.createdAt, new Date(now - REPORT_MERGE_MS)),
        ),
      )
      .orderBy(desc(federationReports.createdAt))
      .limit(1);
    if (existing) {
      const merged = [...existing.evidence, ...evidence].slice(0, REPORT_EVIDENCE_MAX);
      await db
        .update(federationReports)
        .set({
          evidence: merged,
          // Другая жалоба соседа (свой `report_id`) на того же человека — её причина добавляется к прежней, а не
          // затирает её (#204). Дополнение под ИЗВЕСТНЫМ `report_id` выше заменяет причину: её склеил отправитель.
          reason: mergeReportReason(existing.reason, reason),
          updatedAt: new Date(now),
          ...(merged.length !== existing.evidence.length ? { evidenceAt: new Date(now) } : {}),
        })
        .where(eq(federationReports.id, existing.id));
      return;
    }

    await db
      .insert(federationReports)
      .values({
        id: randomUUID(),
        direction: 'in',
        instanceId,
        reportId,
        reportedUserId: reported,
        action: typeof p.action === 'string' ? p.action.slice(0, 32) : 'server_ban',
        serverName: typeof p.server_name === 'string' ? p.server_name.slice(0, 100) : null,
        reason,
        evidence,
        evidenceAt: new Date(now),
        status: 'delivered',
      })
      .onConflictDoNothing();
  });

  onFedEvent(FED_EVENTS.reportReply, async ({ instanceId, event }) => {
    const p = event.payload as Record<string, unknown>;
    const reportId = typeof p.report_id === 'string' ? p.report_id : null;
    const reply = typeof p.reply === 'string' ? p.reply.slice(0, 2000) : null;
    if (!reportId || reply === null) return;
    await db
      .update(federationReports)
      .set({ reply, status: 'answered', updatedAt: new Date() })
      .where(
        and(
          eq(federationReports.direction, 'out'),
          eq(federationReports.instanceId, instanceId),
          eq(federationReports.reportId, reportId),
        ),
      );
  });
}

/** Жалобы для вкладки «Федерация» — свои и к нам. */
export async function listReports(direction?: 'in' | 'out') {
  const rows = await db
    .select()
    .from(federationReports)
    .where(direction ? eq(federationReports.direction, direction) : undefined)
    .orderBy(desc(federationReports.createdAt))
    .limit(200);
  return rows;
}
