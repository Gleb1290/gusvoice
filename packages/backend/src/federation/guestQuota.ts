/**
 * Квота хранилища для файлов гостей (#139, F3, план §5.10, требование 30).
 *
 * Вложения, звуки и стикеры гостя лежат в НАШЕМ хранилище и стоят нам места. Предел на связку, а не
 * «на гостей вообще»: держателю нужно знать, с кем разговаривать — «инстанс «Друзья» занял 2 ГБ»
 * это повод написать его держателю, а «гости заняли 2 ГБ» — повод только развести руками.
 *
 * ⚠️ Учёт приблизительный и НАМЕРЕННО односторонний: занятое растёт при загрузке и не уменьшается
 * при удалении сообщения. Точный учёт требовал бы связывать каждый объект хранилища с сообщением и
 * чистить его при удалении — это отдельная задача про сборку мусора в S3, и делать её половинчато
 * хуже, чем честно назвать предел «сколько загружено», а не «сколько лежит». Держатель может
 * поднять предел или обнулить счётчик во вкладке «Федерация».
 */

import { and, eq, sql } from 'drizzle-orm';
import { FED_ERRORS, type FedErrorCode } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationLinks, users } from '../db/schema.js';

/**
 * Занять место под файл гостя — ОДНИМ запросом, атомарно.
 *
 * 🔴 Раньше здесь были две операции: «проверить, влезает ли» и потом «прибавить». Нашёл Codex
 * 16.09: два одновременных файла по 10 МБ при занятых 90 из 100 оба читали 90, оба проходили
 * проверку и оба прибавляли — в итоге 110 при пределе 100. Предел, который обходится двумя
 * вкладками, это не предел.
 *
 * Теперь проверка и прибавление — одно `UPDATE ... WHERE used + bytes <= quota`: база сама решает,
 * кто успел. Ноль изменённых строк = не влезло.
 *
 * ⚠️ Место занимается ДО записи в хранилище, а при неудачной записи возвращается (`releaseQuota`).
 * Наоборот нельзя: между «записали файл» и «посчитали» помещается ровно та же гонка.
 */
export async function reserveQuota(userId: string, bytes: number): Promise<FedErrorCode | null> {
  if (bytes <= 0) return null;
  const [user] = await db
    .select({ home: users.homeInstanceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // Местного человека квота не касается: она про то, сколько места занимает ЧУЖОЙ инстанс.
  if (!user?.home) return null;
  return await reserveLinkQuota(user.home, bytes);
}

/**
 * То же — по СВЯЗКЕ, когда файл кладётся не от имени человека, а от имени соседа: аватары его людей
 * из каталога (аудит 19.09, F-05). До этого квоту тратили только вложения сообщений, а картинки
 * соседа ложились в бакет мимо предела, который вкладка «Федерация» показывала как соблюдаемый.
 */
export async function reserveLinkQuota(instanceId: string, bytes: number): Promise<FedErrorCode | null> {
  if (bytes <= 0) return null;
  const updated = await db
    .update(federationLinks)
    .set({ usedBytes: sql`${federationLinks.usedBytes} + ${bytes}` })
    .where(
      and(
        eq(federationLinks.instanceId, instanceId),
        // `quota_bytes = 0` — без предела (решение держателя).
        sql`(${federationLinks.quotaBytes} = 0 OR ${federationLinks.usedBytes} + ${bytes} <= ${federationLinks.quotaBytes})`,
      ),
    )
    .returning({ used: federationLinks.usedBytes });

  // Ни одной строки: либо предел, либо связки уже нет (разорвали, пока человек загружал). Второе
  // тоже отказ — место чужому инстансу мы больше не отдаём, а причина для человека та же.
  return updated.length > 0 ? null : FED_ERRORS.quotaExceeded;
}

/**
 * Вернуть занятое, если файл в итоге не лёг.
 *
 * ⚠️ `GREATEST(…, 0)`: счётчик не должен уходить в минус, если держатель обнулил его между
 * резервом и возвратом.
 */
export async function releaseQuota(userId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const [user] = await db
    .select({ home: users.homeInstanceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.home) return;
  await releaseLinkQuota(user.home, bytes);
}

/** То же — по связке (аватары соседей, ревью #195 п. 7). */
export async function releaseLinkQuota(instanceId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await db
    .update(federationLinks)
    .set({ usedBytes: sql`GREATEST(${federationLinks.usedBytes} - ${bytes}, 0)` })
    .where(eq(federationLinks.instanceId, instanceId));
}

/**
 * Сколько места у связки занято и сколько можно — для вкладки «Федерация».
 *
 * ⚠️ Отдельно от резерва намеренно: это ЧТЕНИЕ для показа, и решение «пускать ли» по нему принимать
 * нельзя — между чтением и загрузкой всё то же окно гонки, ради которого резерв и сделан атомарным.
 */
export async function quotaOf(instanceId: string): Promise<{ used: number; quota: number } | null> {
  const [link] = await db
    .select({ used: federationLinks.usedBytes, quota: federationLinks.quotaBytes })
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, instanceId))
    .limit(1);
  return link ? { used: link.used, quota: link.quota } : null;
}

/** Сбросить счётчик связки (держатель убрал файлы руками или поднял предел). */
export async function resetQuota(instanceId: string): Promise<void> {
  await db.update(federationLinks).set({ usedBytes: 0 }).where(eq(federationLinks.instanceId, instanceId));
}

/** Изменить предел связки. `0` — без предела. */
export async function setQuota(instanceId: string, bytes: number): Promise<void> {
  await db
    .update(federationLinks)
    .set({ quotaBytes: Math.max(0, Math.trunc(bytes)) })
    .where(eq(federationLinks.instanceId, instanceId));
}
