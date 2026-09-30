import { sql } from 'drizzle-orm';
import { JOURNAL_TTL_DAYS } from './convRules.js';
import { db } from './db/index.js';

/**
 * Ночная уборка журнала догонки ЛС (этап 1, Р18) — отдельно от `conversations.ts` НАМЕРЕННО: её зовёт `cleanup.ts`,
 * а `conversations.ts` тянет шлюзовую рассылку (`realtime.ts` открывает Redis при загрузке модуля). Через него уборка
 * держала бы открытым Redis везде, где импортируют `cleanup.ts`, — так повис тест `accountCleanup.itest.ts`.
 *
 * Строки старше срока удаляются, `min_pts` поднимается до ПОСЛЕДНЕГО удалённого номера одним запросом — отставший
 * клиент получит `reset`, а не дыру. Возвращает число удалённых строк.
 */
export async function pruneJournal(): Promise<number> {
  const res = await db.execute(sql`
    WITH d AS (
      DELETE FROM user_changes WHERE at < now() - make_interval(days => ${JOURNAL_TTL_DAYS}) RETURNING user_id, pts
    ), m AS (
      SELECT user_id, max(pts) AS maxpts FROM d GROUP BY user_id
    ), u AS (
      UPDATE user_sync s SET min_pts = GREATEST(s.min_pts, m.maxpts) FROM m WHERE s.user_id = m.user_id RETURNING 1
    )
    SELECT (SELECT count(*) FROM d)::int AS n`);
  return Number((res.rows[0] as { n: unknown } | undefined)?.n ?? 0);
}
