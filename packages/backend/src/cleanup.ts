import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { diagReports, users, voiceActivity } from './db/schema.js';
import { env } from './env.js';

/**
 * Purge abandoned, never-activated unverified accounts.
 *
 * A bot that hits /auth/register but never verifies otherwise leaves a `users` row (verified=false)
 * forever: it squats the username/email namespace so a real person can't take it, and bloats the DB.
 * IP-rotating botnets slip past the per-IP register ceiling, so the row accumulates without bound —
 * especially on SMTP-less instances (pending_admin) where nothing ever clears it.
 *
 * We delete accounts that are (a) unverified, (b) older than UNVERIFIED_TTL_DAYS, and (c) have ZERO
 * footprint — own no server, posted no message, hold no membership. The footprint guard is the safety
 * net for the ONE way an *active* account becomes unverified: changing e-mail (POST /auth/email) flips
 * verified=false on an existing user. Any such user has real activity (a server / a message / a
 * membership) and is therefore never touched — and the owner_id guard also avoids the servers.ownerId
 * FK (RESTRICT), which would otherwise abort the delete. FK cascades (schema 0014) clear each deleted
 * user's email_verifications / password_resets rows automatically.
 *
 * Returns the number of accounts removed.
 */
export async function purgeUnverifiedUsers(): Promise<number> {
  const ttlDays = env.unverifiedTtlDays;
  if (!(ttlDays > 0)) return 0; // 0 / NaN / empty => disabled (never delete on a bad value)
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(users)
    .where(
      and(
        eq(users.verified, false),
        lt(users.createdAt, cutoff),
        // 🔴 Обезличенные удалённые аккаунты (F0 #139) тоже `verified=false`, но их строка держит переписку:
        // DELETE унёс бы её каскадом 0014 — ровно то, от чего обезличивание и защищает.
        isNull(users.deletedAt),
        sql`${users.id} NOT IN (SELECT owner_id FROM servers)`,
        sql`${users.id} NOT IN (SELECT author_id FROM messages)`,
        // ⚠️ И личка: сменивший почту (снова `verified=false`) человек, у которого только ЛС, иначе
        // удалялся бы вместе со всеми своими сообщениями в беседах.
        sql`${users.id} NOT IN (SELECT author_id FROM dm_messages)`,
        // ⚠️ Беседа ЛС уходит каскадом ЦЕЛИКОМ — вместе с репликами второго человека, даже если этот
        // сам не написал ни слова. И членство: «не держит членства» раньше проверялось только по ролям.
        sql`${users.id} NOT IN (SELECT user_a FROM dm_channels UNION SELECT user_b FROM dm_channels)`,
        sql`${users.id} NOT IN (SELECT user_id FROM server_members)`,
        sql`${users.id} NOT IN (SELECT user_id FROM member_roles)`,
      ),
    )
    .returning({ id: users.id });
  return deleted.length;
}

/**
 * Сколько держим отчёты диагностики (#100).
 *
 * 🔴 Они растут быстрее всего остального вместе взятого: 2026-08-23 таблица занимала **63 МБ из
 * 73 МБ всей базы** — за четыре дня и на 17 человек. Отчёт нужен, пока по нему разбирают свежую
 * жалобу; недельной глубины на это хватает с запасом, а всё старше — балласт, который никто ни разу
 * не открывал.
 *
 * ⚠️ На клиенте они не копятся вовсе: срезы живут в памяти между отправками и стираются в момент
 * отправки (`diag.ts`, `flush`), на диск не пишется ничего. Так что срок хранения — только здесь.
 */
export const DIAG_TTL_DAYS = 7;

/**
 * Граница: всё, что СТАРШЕ этого момента, — балласт.
 *
 * Отдельной функцией, потому что ошибка ровно здесь стоит дорого в обе стороны: перепутанный
 * множитель либо сотрёт отчёты по свежей жалобе раньше, чем по ним разберутся, либо не сотрёт
 * ничего и таблица снова съест базу. Проверять это на живой базе нечем — время не подвинуть.
 */
export function diagCutoff(now: Date, ttlDays: number = DIAG_TTL_DAYS): Date {
  return new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
}

export interface DiagPurgerDeps {
  /** Текущее время инъекцией — тест ставит его сам. */
  now: () => Date;
  /** Удалить отчёты СТРОГО старше границы; вернуть, сколько удалено. */
  deleteOlderThan: (cutoff: Date) => Promise<number>;
  ttlDays?: number;
}

/**
 * Уборщик отчётов: считает границу и отдаёт удаление наружу.
 *
 * ⚠️ Граница СТРОГАЯ: отчёт, созданный ровно в момент отсечки, остаётся. Это не придирка к
 * миллисекундам, а зафиксированное направление ошибки — сомневаемся, значит храним.
 */
export function createDiagReportPurger(deps: DiagPurgerDeps): () => Promise<number> {
  return () => deps.deleteOlderThan(diagCutoff(deps.now(), deps.ttlDays ?? DIAG_TTL_DAYS));
}

/** Убрать отчёты диагностики старше срока. Возвращает, сколько удалено. */
export const purgeOldDiagReports = createDiagReportPurger({
  now: () => new Date(),
  deleteOlderThan: async (cutoff) => {
    const deleted = await db.delete(diagReports).where(lt(diagReports.createdAt, cutoff)).returning({ id: diagReports.id });
    return deleted.length;
  },
});

/**
 * Сколько держим сырые срезы присутствия в голосе (экономика GusCoins, шаг 0).
 *
 * Претензия Codex, и справедливая: у этих данных не было срока хранения вовсе. Это записи о том,
 * кто сколько часов сидел в голосе — держать их вечно нельзя ни из приличия, ни из соображений
 * объёма.
 *
 * Девяносто дней, потому что столько нужно самой задаче: неделя на первичный подбор ставки, дальше
 * запас на пересмотр, когда станет видно, как цифры плывут от месяца к месяцу. Всё старше — балласт:
 * постоянной записью станет журнал начислений (`coin_ledger`), а не эти срезы.
 */
export const VOICE_ACTIVITY_TTL_DAYS = 90;

/**
 * Уборщик срезов присутствия. Форма та же, что у отчётов диагностики (граница СТРОГАЯ: срез ровно
 * в момент отсечки остаётся — сомневаемся, значит храним).
 *
 * ⚠️ Намеренно отдельная фабрика, а не переиспользование `createDiagReportPurger` с другим сроком:
 * общая функция с именем про диагностику, которая на деле чистит и голосовую статистику, читается
 * как ошибка, и однажды кто-то поправит «лишний» срок не в той таблице.
 */
export function createVoiceActivityPurger(deps: DiagPurgerDeps): () => Promise<number> {
  return () => deps.deleteOlderThan(diagCutoff(deps.now(), deps.ttlDays ?? VOICE_ACTIVITY_TTL_DAYS));
}

/** Убрать срезы присутствия старше срока. Возвращает, сколько удалено. */
export const purgeOldVoiceActivity = createVoiceActivityPurger({
  now: () => new Date(),
  ttlDays: VOICE_ACTIVITY_TTL_DAYS,
  deleteOlderThan: async (cutoff) => {
    const deleted = await db
      .delete(voiceActivity)
      .where(lt(voiceActivity.createdAt, cutoff))
      .returning({ id: voiceActivity.id });
    return deleted.length;
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run the purges once at startup, then daily. Errors are logged, never fatal. */
export function startDailyCleanup(): void {
  const run = async () => {
    try {
      const n = await purgeUnverifiedUsers();
      if (n > 0) console.log(`[cleanup] purged ${n} abandoned unverified account(s) (>${env.unverifiedTtlDays}d)`);
    } catch (err) {
      console.error('[cleanup] purge failed:', (err as Error).message);
    }
    // Отдельным try: провал одной уборки не должен отменять другую — они не связаны ничем, кроме
    // расписания.
    try {
      const n = await purgeOldDiagReports();
      if (n > 0) console.log(`[cleanup] purged ${n} diag report(s) older than ${DIAG_TTL_DAYS}d`);
    } catch (err) {
      console.error('[cleanup] diag purge failed:', (err as Error).message);
    }
    // Снова отдельным try — по той же причине: уборки не связаны ничем, кроме расписания.
    try {
      const n = await purgeOldVoiceActivity();
      if (n > 0) console.log(`[cleanup] purged ${n} voice-activity sample(s) older than ${VOICE_ACTIVITY_TTL_DAYS}d`);
    } catch (err) {
      console.error('[cleanup] voice-activity purge failed:', (err as Error).message);
    }
  };
  void run();
  const timer = setInterval(run, DAY_MS);
  timer.unref(); // don't hold the process open on shutdown
}
