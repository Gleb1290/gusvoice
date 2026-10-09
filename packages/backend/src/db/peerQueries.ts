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
 * 🔴 Связь «через беседу» не считается, если один из двоих заблокировал другого (05.10, #212): беседу 1:1 может
 * завести кто угодно на инстансе (политика `anyone`), и пустая беседа показывала её создателю онлайн того, кто его
 * заблокировал (`online.snapshot`). Общий сервер блокировка не отменяет — там онлайн виден всем участникам, как и
 * раньше. Кэш соседей шлюза при блокировке и разблокировке сбрасывается (`blocks.onBlockChange` →
 * `userVisibilityHub.refreshPeers`).
 */
export async function loadPeers(userId: string): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT b.user_id AS id FROM server_members a
      JOIN server_members b ON b.server_id = a.server_id AND b.state = 'active'
      WHERE a.user_id = ${userId} AND a.state = 'active'
    UNION SELECT p.user_id AS id FROM conversation_members m
      JOIN conversation_members p ON p.conversation_id = m.conversation_id AND p.user_id <> m.user_id
      WHERE m.user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = m.user_id AND ub.blocked_id = p.user_id)
             OR (ub.blocker_id = p.user_id AND ub.blocked_id = m.user_id))
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

/**
 * Связаны ли двое так же, как для онлайна (`loadPeers`): общий сервер ИЛИ беседа без блокировки между ними. Точечный
 * запрос для «был(а) в сети» (С1, #211) — `loadPeers` поднимает всех соседей разом.
 */
export async function arePeers(userA: string, userB: string): Promise<boolean> {
  if (await shareServer(userA, userB)) return true;
  const res = await db.execute(sql`
    SELECT 1 FROM conversation_members m
      JOIN conversation_members p ON p.conversation_id = m.conversation_id AND p.user_id = ${userB}
      WHERE m.user_id = ${userA}
        AND NOT EXISTS (SELECT 1 FROM user_blocks ub
          WHERE (ub.blocker_id = ${userA} AND ub.blocked_id = ${userB})
             OR (ub.blocker_id = ${userB} AND ub.blocked_id = ${userA}))
      LIMIT 1
  `);
  return res.rows.length > 0;
}

/**
 * «Принятый собеседник» хозяина `ownerId` для «Кто может звонить: Собеседники» (08.10, #211, решение владельца п.26: только
 * принятые беседы, не незнакомцы с плашкой). Принят, если ни один не блокировал другого и выполнено одно из: общий действующий
 * сервер; `otherId` в контактах хозяина; в беседе 1:1 с ним хозяин сам отвечал (тот же признак «я ответил», что гасит плашку
 * незнакомца в `conversations.strangerSql`: сообщение хозяина, не удалённое и не служебное). Пустая беседа, которую завёл
 * звонящий, и беседа с плашкой незнакомца — не приняты. Для «Времени захода» НЕ используется (там — `arePeers`).
 */
export async function isAcceptedPeer(ownerId: string, otherId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM user_blocks ub
        WHERE (ub.blocker_id = ${ownerId} AND ub.blocked_id = ${otherId})
           OR (ub.blocker_id = ${otherId} AND ub.blocked_id = ${ownerId}))
      AND (
        EXISTS (SELECT 1 FROM server_members a
          JOIN server_members b ON b.server_id = a.server_id AND b.user_id = ${otherId} AND b.state = 'active'
          WHERE a.user_id = ${ownerId} AND a.state = 'active')
        OR EXISTS (SELECT 1 FROM user_contacts uc WHERE uc.owner_id = ${ownerId} AND uc.contact_id = ${otherId})
        OR EXISTS (SELECT 1 FROM conversations c
          JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ${ownerId} AND m.left_at IS NULL
          JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id = ${otherId}
          WHERE c.kind = 'direct'
            AND EXISTS (SELECT 1 FROM conversation_messages sx WHERE sx.conversation_id = c.id AND sx.author_id = ${ownerId}
              AND sx.deleted_at IS NULL AND sx.service IS NULL))
      )
  `);
  return res.rows.length > 0;
}
