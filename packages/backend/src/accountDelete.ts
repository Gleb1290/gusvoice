import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DELETED_DISPLAY_NAME } from './accountRules.js';
import { anonymizeAccountRows } from './accountRows.js';
import { memberChanged } from './memberEvents.js';
import { clearActivity } from './activity.js';
import { purgeDeletedOf } from './attachments.js';
import { forgetTokenGeneration, hashPassword } from './auth.js';
import { deliverMany, journalForwardedFrom } from './conversations.js';
import { db } from './db/index.js';
import { announceUser } from './federation/directoryEvents.js';
import { revokeAccountEverywhere } from './federation/guestRevocation.js';
import { bots, users } from './db/schema.js';
import { broadcastUserProfile } from './gateway.js';
import { removeGifFiles, savedGifKeysOf } from './gifs.js';
import { removeFromOtherRooms } from './livekit.js';
import { publishToServer } from './realtime.js';
import { removeUserAvatars } from './storage.js';

/**
 * Удалить аккаунт — обезличить строку, оставив переписку (F0 федерации, #139). Правила, что уходит и что
 * остаётся, — в `accountRules.ts`; проверки «можно ли» делает вызывающий маршрут (`accountDeleteBlock`).
 *
 * Порядок важен:
 * 1. **Одна транзакция:** строка `users` и личные строки в соседних таблицах (`accountRows.ts`) **и подъём
 *    поколения токенов**. 🔴 Раньше поколение поднималось отдельным запросом ПОСЛЕ фиксации (нашёл Codex
 *    15.09): упади этот запрос — аккаунт уже обезличен, а старые токены живы до своего срока. Теперь либо
 *    всё, либо ничего. (`tokenGenValid` вдобавок отбивает удалённых сам — вторая линия.)
 * 2. После фиксации — сброс кэша поколений (синхронный, упасть нечему): иначе токены жили бы ещё до 10 с.
 * 3. Всё внешнее — **best-effort, без права уронить ответ**: события, файлы аватаров, голосовые комнаты.
 *    🔴 Раньше первое же `publishToServer` при упавшем Redis бросало исключение: маршрут отвечал 500 уже
 *    ПОСЛЕ удаления, а чистка аватаров и голоса не запускалась вовсе (нашёл Codex 15.09). Каждый шаг теперь
 *    сам по себе, провал пишется в лог. Открытые сокеты шлюза умирают на ближайшем `ping` (≤ ~40 с).
 */
export async function anonymizeAccount(userId: string, opts: { displayName?: string; bot?: boolean } = {}): Promise<void> {
  // Имя после обезличивания: людям — «Удалённый пользователь», боту (`botLifecycle.deleteBot`, 26.10) — «Удалённый бот».
  const goneName = opts.displayName ?? DELETED_DISPLAY_NAME;
  const unusable = await hashPassword(randomBytes(32).toString('hex'));
  /**
   * 🔴 Хостам, где человек был гостем, сообщаем ДО транзакции (F3, §5.6): она чистит индекс членств
   * каскадом, и список адресатов после неё был бы пуст. Гость остался бы жить на чужих серверах до
   * их суточной сверки — то есть до суток от имени удалённого аккаунта.
   */
  // Бот (`opts.bot`, аудит 26.10) соседям не виден (`hidden_from_peers`) и гостем у них не бывает — ни отзыва, ни надгробия
  // (`announceUser` ниже): иначе соседям ушёл бы пользователь, о котором они не знали.
  if (!opts.bot) {
    await revokeAccountEverywhere({ userId }).catch((err) => {
      console.warn(`[account] отзыв гостевых сессий ${userId} не разослан: ${err instanceof Error ? err.message : err}`);
    });
  }
  let gifKeys: string[] = [];
  const memberOf = await db.transaction(async (tx) => {
    // «Мои GIF» (0104, `gifs1`): ключи файлов — до удаления строк, сами файлы — после фиксации.
    gifKeys = await savedGifKeysOf(tx, userId);
    const servers = await anonymizeAccountRows(tx, userId, unusable, new Date());
    await tx
      .update(users)
      .set({ tokenGeneration: sql`${users.tokenGeneration} + 1`, ...(goneName !== DELETED_DISPLAY_NAME ? { displayName: goneName } : {}) })
      .where(eq(users.id, userId));
    // Боты человека (#229) гаснут В ТОЙ ЖЕ транзакции: полное удаление (`deleteBotsOwnedBy`) идёт после фиксации и его сбой
    // глотается — без этого бот удалённого человека остался бы с живым токеном (нашёл Codex R296).
    await tx.update(bots).set({ disabledAt: new Date() }).where(and(eq(bots.ownerId, userId), isNull(bots.disabledAt)));
    return servers;
  });
  forgetTokenGeneration(userId);

  const results = await Promise.allSettled([
    Promise.resolve().then(() => clearActivity(userId)),
    // Боты человека (#229) уходят вместе с ним (лениво: модуль ботов тянет маршруты Bot API).
    import('./bots/botLifecycle.js').then((m) => m.deleteBotsOwnedBy(userId)),
    // Собеседники по ЛС (беседы остаются) видят новое имя и пустой аватар без перезахода.
    Promise.resolve().then(() => broadcastUserProfile(userId, goneName, null, null)),
    // Копии пересланного от него: имя в снимках «Переслано от» уже обезличено транзакцией, участникам их бесед —
    // строки журнала и `conv.change`, иначе кеш клиента держал бы прежнее имя (догонка несёт только журнал). Сбой —
    // сервер и так отдаёт новый снимок; кеш поправится при первой свежей порции ленты.
    Promise.resolve().then(async () => deliverMany(await journalForwardedFrom(userId))),
    // Участники бывших серверов: ростер без призрака, а шлюз пересобирает, кто чей онлайн видит (#136).
    ...memberOf.map((serverId) => publishToServer(serverId, { t: 'server.invalidate', serverId })),
    // Боты бывших серверов (#231): `chat_member left`; если удалён бот — `my_chat_member` ему не нужен (он и так мёртв).
    Promise.resolve().then(() => memberChanged(memberOf.map((serverId) => ({ serverId, userId, actorId: userId, from: 'member' as const, to: 'left' as const })))),
    removeUserAvatars(userId),
    // Файлы его отложенных сообщений (`conv10`): транзакция пометила их «удалено» — стереть из хранилища сейчас.
    purgeDeletedOf(userId),
    // Файлы «Моих GIF» (`gif/…`, свои копии): строки ушли транзакцией — стереть и файлы.
    removeGifFiles(gifKeys),
    removeFromOtherRooms(userId, ''),
    removeFromOtherRooms(`${userId}#screen`, ''),
    // Соседям по федерации — надгробие «удалён» (F2, §5.2). Время правки каталога уже сдвинуто самой
    // транзакцией обезличивания, поэтому даже не доехавшее событие догонит дельтой.
    ...(opts.bot ? [] : [announceUser(userId)]),
  ]);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(
      `[account] аккаунт ${userId} обезличен, но ${failed.length} шаг(ов) после фиксации не удались: ` +
        failed.map((f) => (f.reason as Error)?.message ?? String(f.reason)).join('; '),
    );
  }
}
