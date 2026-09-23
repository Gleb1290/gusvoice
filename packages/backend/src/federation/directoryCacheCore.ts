/**
 * Кеш каталога соседа — решения без базы (вынос для тестов 22.09; проводка — `directoryCache.ts`).
 *
 * Здесь: какие записи пачки устарели, какие удаляются надгробием, у кого снять копию аватара
 * (`planDirectoryBatch`), и уборка снятых копий с точным возвратом квоты (`dropMediaFiles`). Условия
 * записи (`ON CONFLICT … CASE WHEN`) — SQL, они в проводке и проверяются на PGlite.
 */

import { stateWins, type FedDirectoryEntry } from '@gusvoice/shared';

/** Что уже лежит в кеше по людям пачки. */
export interface KnownPeerRow {
  userId: string;
  updatedAt: number | string | Date;
  avatarLocalUrl: string | null;
}

export interface DirectoryBatchPlan {
  /** Записи, которые кладём (новые и обновлённые); `staleCopy` — копия аватара, снятого дома, её снять. */
  upserts: Array<{ entry: FedDirectoryEntry; staleCopy: string | null }>;
  /** Люди, чьи строки удаляются надгробием (только те, что у нас есть). */
  doomed: string[];
  /** Копии аватаров, снятых дома: ссылку снимает сама запись, файл — следом (#196 п. 6). */
  orphaned: string[];
  /** Надгробий в пачке — включая надгробия на незнакомых (это норма, а не ошибка). */
  removed: number;
  /** Отброшено как устаревшие — по ним видно, что события и сверка спорят. */
  stale: number;
}

/**
 * Разложить пачку записей каталога против того, что уже в кеше.
 *
 * Версия — само время изменения у соседа (`stateWins`): запись не новее нашей — устаревшая. Надгробие
 * на незнакомого считается в `removed`, но строки для удаления нет. Запись без отпечатка аватара при
 * скачанной копии — копию снять (дома аватар сняли).
 */
export function planDirectoryBatch(
  entries: readonly FedDirectoryEntry[],
  known: readonly KnownPeerRow[],
): DirectoryBatchPlan {
  const versionOf = new Map(known.map((r) => [r.userId, Number(r.updatedAt)]));
  const localCopyOf = new Map(known.filter((r) => r.avatarLocalUrl).map((r) => [r.userId, r.avatarLocalUrl as string]));
  const plan: DirectoryBatchPlan = { upserts: [], doomed: [], orphaned: [], removed: 0, stale: 0 };
  for (const entry of entries) {
    const current = versionOf.get(entry.userId);
    if (!stateWins(entry.updatedAt, current)) {
      plan.stale += 1;
      continue;
    }
    if (entry.removed) {
      // Записи могло и не быть — надгробие на незнакомого человека это норма, а не ошибка.
      if (current !== undefined) plan.doomed.push(entry.userId);
      plan.removed += 1;
      continue;
    }
    // Дома аватар сняли — наша копия больше не нужна: ссылку снимает запись, файл — следом (#196 п. 6).
    const staleCopy = entry.avatarHash ? null : (localCopyOf.get(entry.userId) ?? null);
    if (staleCopy) plan.orphaned.push(staleCopy);
    plan.upserts.push({ entry, staleCopy });
  }
  return plan;
}

/** Сколько файлов снимаем из хранилища разом: разрыв связки с тысячами аватаров — не тысячи запросов (#196 п. 7). */
export const DROP_CONCURRENCY = 4;
/** Через сколько снятых файлов возвращаем место (#197 п. 9): перезапуск посреди пачки теряет хвост, а не всё. */
export const RELEASE_EVERY = 25;

export interface DropMediaDeps {
  /** Снять файл из своего хранилища; сколько байт освободилось (`0` — файла уже нет). */
  removeOwnMedia: (url: string) => Promise<number>;
  /** Вернуть байты в квоту владельца. */
  release: (owner: string, bytes: number) => Promise<void>;
  concurrency?: number;
  releaseEvery?: number;
}

/**
 * Убрать из хранилища снятые копии аватаров и вернуть их байты в квоту — пачками, а не по файлу
 * (F-05; ревью #195 п. 7; #196 пп. 7 и 11). Пустые ссылки пропускаются. Упавший файл место не
 * возвращает (он остался лежать); упавший возврат квоты глотается — это потеря места, а не данных.
 *
 * Возвращает, сколько байт вернули в квоту, — ждать не обязательно (проводка зовёт без ожидания).
 */
export async function dropMediaFiles(
  deps: DropMediaDeps,
  quotaOwner: string,
  urls: readonly (string | null)[],
): Promise<number> {
  const queue = urls.filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (queue.length === 0) return 0;
  const concurrency = Math.max(1, deps.concurrency ?? DROP_CONCURRENCY);
  const releaseEvery = Math.max(1, deps.releaseEvery ?? RELEASE_EVERY);
  let freed = 0;
  let returned = 0;
  let done = 0;
  let next = 0;
  const flush = async (): Promise<void> => {
    const bytes = freed;
    freed = 0;
    if (bytes <= 0) return;
    try {
      await deps.release(quotaOwner, bytes);
      returned += bytes;
    } catch {
      /* база не ответила — место не вернули */
    }
  };
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const url = queue[next];
      next += 1;
      if (url === undefined) break;
      try {
        // Сначала дождаться, потом прибавить (#198 п. 5): `freed += await …` читает `freed` ДО
        // ожидания, и при четырёх работниках прибавки терялись, а сброс пачки возвращал возвращённое.
        const bytes = await deps.removeOwnMedia(url);
        freed += bytes;
      } catch {
        /* хранилище лежит — файл останется, место не возвращаем */
      }
      done += 1;
      if (done % releaseEvery === 0) await flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  await flush();
  return returned;
}
