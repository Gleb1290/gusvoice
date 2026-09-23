import { sql } from 'drizzle-orm';
import { db } from './index.js';

/**
 * Запросы «кто с кем связан» — общий сервер или личная переписка (F0 #139).
 *
 * Оба жили внутри своих модулей: `loadPeers` — в `gateway.ts` (тот тянет Redis и Fastify),
 * `shareServer` — приватной функцией в `routes/dm.ts`. Проверить сам SQL было нельзя ничем, кроме
 * живого Postgres, а это ровно те два запроса, от которых зависит, кто видит чужой онлайн и кому
 * можно написать. Здесь они видны, и интеграционный тест (#143) зовёт их напрямую.
 */

/**
 * С кем у человека есть общий сервер или ЛС. Индексы — миграция 0060.
 *
 * 🔴 Считаются только ДЕЙСТВУЮЩИЕ членства (аудит 19.09, F-03). Строка членства гостя переживает
 * закрытие сервера и запрет (`closed_by_host` / `removed`) — и без этого условия выставленный гость
 * продолжал видеть, кто из участников в сети, а они — его.
 */
export async function loadPeers(userId: string): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT b.user_id AS id FROM server_members a
      JOIN server_members b ON b.server_id = a.server_id AND b.state = 'active'
      WHERE a.user_id = ${userId} AND a.state = 'active'
    UNION SELECT user_b AS id FROM dm_channels WHERE user_a = ${userId}
    UNION SELECT user_a AS id FROM dm_channels WHERE user_b = ${userId}
  `);
  return new Set((res.rows as { id: string }[]).map((r) => r.id));
}

/** Есть ли сервер, где состоят оба. Один запрос по индексу `server_members(user_id)`. */
export async function shareServer(userA: string, userB: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM server_members a
      JOIN server_members b ON b.server_id = a.server_id AND b.user_id = ${userB} AND b.state = 'active'
      WHERE a.user_id = ${userA} AND a.state = 'active'
      LIMIT 1
  `);
  return res.rows.length > 0;
}
