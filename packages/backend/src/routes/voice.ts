import {
  canPublishScreen,
  checkStreamPreview,
  has,
  Permission,
  roomForChannel,
  STREAM_PREVIEW_TTL_S,
  type VoiceParticipant,
  type VoiceTokenResponse,
} from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { coinBalances, channels, serverMembers, users } from '../db/schema.js';
import { env } from '../env.js';
import { createScreenShareToken, createVoiceToken, disconnectUser, removeFromOtherRooms, serverMute } from '../livekit.js';
import { getChannelPermissions, getMemberContext } from '../permissions.js';
import { publishToChannel, publishToUser, redisPub, streamPreviewKey, voiceServerMuteKey } from '../realtime.js';
import { pushWallet } from '../coins.js';
import { transferCoins } from '../transferCoins.js';
import {
  POKE_BLOCK_TEXT,
  POKE_COOLDOWN_MS,
  POKE_RECEIVE_LIMIT,
  POKE_RECEIVE_WINDOW_MS,
  pokeBlock,
  pokeCooldownKey,
  pokeMessage,
  pokeReceiveKey,
} from '../pokeRules.js';
import { voiceHierarchyDecision } from '../voiceRules.js';
import { inVoiceChannel, voiceParticipantIds } from '../voicePresence.js';
import { economySeenBy, moveCoins, walletOf } from '../coins.js';
import { TIP_BLOCK_TEXT, TIP_COOLDOWN_MS, tipBlock, tipCooldownKey, tipSplit , MAX_TIPPERS_PER_DAY } from '../tipRules.js';
import { buyItem } from '../purchase.js';
import { receivedToday, shopFor } from '../shop.js';
import {
  BUY_BLOCK_TEXT,
  BUY_COOLDOWN_MS,
  MEGA_DAILY_TO_ONE,
  buyBlock,
  buyCooldownKey,
  shopItem,
} from '../shopRules.js';

/**
 * Сидит ли человек прямо сейчас в этом голосовом канале — по срезу presence в Redis
 * (`presence:ch:<id>`, его пишет сервис presence из вебхуков LiveKit).
 *
 * ⚠️ Читаем presence, а не спрашиваем LiveKit: тот же самый источник, который видит клиент, поэтому
 * «вижу человека в канале, а ткнуть нельзя» невозможно. Ошибка чтения = «не в канале» (fail-closed).
 */
// Реализация переехала в `voicePresence.ts` — её спрашивают не только маршруты голоса.

/**
 * Загрузить оба контекста и спросить решение у `voiceHierarchyDecision` (`voiceRules.ts`).
 *
 * ⚠️ Здесь НЕТ логики намеренно (вынос 2026-08-01 по просьбе Codex): само правило — почему равные
 * ранги пускаются, почему `MOVE_ANYONE` снимает щит только для перемещения, и почему мут с
 * отключением остаются под иерархией — живёт и объясняется в `voiceRules.ts`, где его можно
 * проверить тестом. Из роута оно непроверяемо: импорт файла поднимает Pool/Redis.
 *
 * Returns a 403 error string, or null if allowed.
 */
async function voiceHierarchyBlock(
  serverId: string,
  actorId: string,
  targetId: string,
  /** Перемещение — единственное действие, которое может обойти щит по праву `MOVE_ANYONE`. */
  isMove = false,
): Promise<string | null> {
  const [actor, target] = await Promise.all([
    getMemberContext(serverId, actorId),
    getMemberContext(serverId, targetId),
  ]);
  return voiceHierarchyDecision(actor, target, isMove);
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Issue a LiveKit access token to join a voice channel's room.
  app.post('/channels/:id/voice/token', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);

    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: 'not found' });
    if (channel.type !== 'voice') return reply.code(400).send({ error: 'not a voice channel' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not a member' });
    if (!has(perms.permissions, Permission.CONNECT)) return reply.code(403).send({ error: 'cannot connect' });

    const [user] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);

    const room = roomForChannel(channelId);
    // Single-channel presence: drop the user from any OTHER voice room before they join this one, so a
    // quick move→switch can't leave a ghost showing them in two channels at once. Best-effort.
    await removeFromOtherRooms(user.id, room);
    // Carry an active server-mute into the token so it survives reconnects / token refreshes
    // (otherwise a re-mint would hand the muted user a fresh mic grant).
    const serverMuted = (await redisPub.sismember(voiceServerMuteKey(channelId), user.id)) === 1;
    const token = await createVoiceToken({
      identity: user.id,
      name: user.displayName,
      room,
      permissions: perms.permissions,
      avatarUrl: user.avatarUrl,
      serverMuted,
    });

    const res: VoiceTokenResponse = { url: env.livekit.urlExternal, token, room };
    return res;
  });

  // Issue a COMPANION token for a NATIVE (desktop) screen share — a second participant "<id>#screen"
  // that publishes the screen captured outside the WebView (Plan B, bypasses getDisplayMedia). The
  // desktop app connects this alongside the user's voice participant. Requires SHARE_SCREEN.
  app.post('/channels/:id/voice/screen-token', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);

    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: 'not found' });
    if (channel.type !== 'voice') return reply.code(400).send({ error: 'not a voice channel' });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not a member' });
    if (!has(perms.permissions, Permission.CONNECT)) return reply.code(403).send({ error: 'cannot connect' });
    if (!canPublishScreen(perms.permissions)) return reply.code(403).send({ error: 'cannot share screen' });

    const [user] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    const room = roomForChannel(channelId);
    const token = await createScreenShareToken({ userId: user.id, name: user.displayName, room });

    const res: VoiceTokenResponse = { url: env.livekit.urlExternal, token, room };
    return res;
  });

  // Server-mute / unmute a participant's mic (MUTE_MEMBERS).
  app.post('/channels/:id/voice/:userId/mute', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const { muted } = z.object({ muted: z.boolean() }).parse(req.body);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MUTE_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });
    const hblock = await voiceHierarchyBlock(perms.serverId, req.user!.sub, userId);
    if (hblock) return reply.code(403).send({ error: hblock });
    // The target's own resolved permissions decide which sources to restore on unmute.
    const targetPerms = await getChannelPermissions(channelId, userId);
    if (!targetPerms) return reply.code(404).send({ error: 'target not a member' });
    await serverMute(roomForChannel(channelId), userId, muted, targetPerms.permissions);
    // Track who's server-muted so presence can distinguish it from self-mute.
    if (muted) await redisPub.sadd(voiceServerMuteKey(channelId), userId);
    else await redisPub.srem(voiceServerMuteKey(channelId), userId);
    await writeAudit(perms.serverId, req.user!.sub, muted ? 'voice.mute' : 'voice.unmute', {
      targetType: 'member',
      targetId: userId,
      data: { channelId },
    });
    return reply.code(204).send();
  });

  // Disconnect a participant from the voice channel (MOVE_MEMBERS).
  app.post('/channels/:id/voice/:userId/disconnect', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MOVE_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });
    const hblock = await voiceHierarchyBlock(perms.serverId, req.user!.sub, userId);
    if (hblock) return reply.code(403).send({ error: hblock });
    await disconnectUser(roomForChannel(channelId), userId);
    await writeAudit(perms.serverId, req.user!.sub, 'voice.disconnect', {
      targetType: 'member',
      targetId: userId,
      data: { channelId },
    });
    return reply.code(204).send();
  });

  // Move a participant to another voice channel (MOVE_MEMBERS here; the user needs CONNECT there).
  app.post('/channels/:id/voice/:userId/move', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const { toChannelId } = z.object({ toChannelId: z.string() }).parse(req.body);
    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.MOVE_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });
    // ⚠️ `isMove` — единственное место, где щит по старшинству может быть снят правом MOVE_ANYONE.
    // Базовое MOVE_MEMBERS выше всё равно обязательно: право снимает иерархию, а не заменяет допуск.
    const hblock = await voiceHierarchyBlock(perms.serverId, req.user!.sub, userId, true);
    if (hblock) return reply.code(403).send({ error: hblock });
    const [target] = await db.select().from(channels).where(eq(channels.id, toChannelId)).limit(1);
    if (!target || target.type !== 'voice') return reply.code(400).send({ error: 'target is not a voice channel' });
    // The target channel must be on THIS server (P3-2) — no cross-server move (server isolation).
    if (target.serverId !== perms.serverId) return reply.code(400).send({ error: 'target channel is on another server' });
    const targetPerms = await getChannelPermissions(toChannelId, userId);
    if (!targetPerms || !has(targetPerms.permissions, Permission.CONNECT)) {
      return reply.code(400).send({ error: 'user cannot connect to the target channel' });
    }
    // The self-hosted LiveKit (edition 0) doesn't implement MoveParticipant, so we drive the
    // move from the target's own client: tell it to reconnect to the new channel's room.
    // Server-muted state is per-room, so clear it for the source channel.
    await redisPub.srem(voiceServerMuteKey(channelId), userId);
    await publishToUser(userId, { t: 'voice.move', channelId: toChannelId });
    await writeAudit(perms.serverId, req.user!.sub, 'voice.move', {
      targetType: 'member',
      targetId: userId,
      data: { fromChannelId: channelId, toChannelId, toChannelName: target.name },
    });
    return reply.code(204).send();
  });

  /**
   * «Ткнуть» человека, сидящего в голосовом канале (TeamSpeak-style): у него всплывает окно со
   * звуком и мигает окно в панели задач.
   *
   * ⚠️ Событие ЭФЕМЕРНОЕ и адресное (`publishToUser`): не дошло — значит не было. Очереди для офлайна
   * нет намеренно — «тебя тыкали два часа назад» бессмысленно, а копить такое означало бы хранить
   * готовый спам-буфер.
   * ⚠️ Ответ 429/403 не различает «нет права» и «слишком часто» по коду ради тайны — различает по
   * тексту, потому что отправителю надо понять, ждать ему или это вообще запрещено.
   */
  app.post('/channels/:id/voice/:userId/poke', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const { message } = z.object({ message: z.string().max(500).optional() }).parse(req.body ?? {});

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });

    const [target] = await db
      .select({ id: users.id, presenceStatus: users.presenceStatus })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) return reply.code(404).send({ error: 'not found' });

    const key = pokeCooldownKey(req.user!.sub, userId);
    const recvKey = pokeReceiveKey(userId);
    // Личный выключатель получателя — посерверный: травля случается на конкретном сервере (#122).
    const [targetMember] = await db
      .select({ pokesOptOut: serverMembers.pokesOptOut })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, perms.serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    const block = pokeBlock({
      fromUserId: req.user!.sub,
      toUserId: userId,
      allowed: has(perms.permissions, Permission.POKE_MEMBERS),
      targetInChannel: await inVoiceChannel(channelId, userId),
      targetDnd: target.presenceStatus === 'dnd',
      onCooldown: (await redisPub.exists(key)) === 1,
      targetOptedOut: targetMember?.pokesOptOut === true,
      // Быстрый путь: понятный отказ до всякой работы. Настоящее решение — ниже, по значению,
      // которое ВЕРНЁТ инкремент: прочитанное здесь успевает устареть, и толпа, нажавшая
      // одновременно, проходила предел (#123).
      targetReceived: Number((await redisPub.get(recvKey)) ?? 0),
    });
    if (block) {
      return reply.code(block === 'cooldown' ? 429 : 403).send({ error: POKE_BLOCK_TEXT[block] });
    }

    // 🔴 Тот же атомарный захват, что и у типа (#124, Д3): `exists` выше — быстрый путь ради
    // понятного отказа, а решение принимает `NX`. Пару «кто→кому» параллельные запросы обходили
    // так же, как обходили её у типа; предел получателя ниже страхует от толпы, но не от одного
    // человека с двойным кликом.
    // ⚠️ Кулдаун ставим ДО отправки: упасть после публикации и не записать его — значит открыть
    // окно на повторный тык, а это ровно то, от чего кулдаун и стоит.
    const claimed = await redisPub.set(key, '1', 'PX', POKE_COOLDOWN_MS, 'NX');
    if (claimed !== 'OK') return reply.code(429).send({ error: POKE_BLOCK_TEXT.cooldown });
    // Счётчик ПОЛУЧЕННЫХ за окно: против наплыва толпы, где каждый формально в своём праве.
    // ⚠️ Срок ставим только при создании ключа, иначе окно продлевалось бы каждым новым тыком и
    // никогда не заканчивалось.
    const received = await redisPub.incr(recvKey);
    if (received === 1) await redisPub.pexpire(recvKey, POKE_RECEIVE_WINDOW_MS);
    // 🔴 Решение по ВОЗВРАЩЁННОМУ значению: `incr` атомарен, и только он говорит, каким по счёту
    // оказался именно этот тык. Проверка выше читала счётчик ДО инкремента, поэтому десять человек,
    // нажавших в одно мгновение, проходили предел все (#123).
    if (received > POKE_RECEIVE_LIMIT) {
      await redisPub.del(key).catch(() => {});
      return reply.code(403).send({ error: POKE_BLOCK_TEXT.flooded });
    }

    const [me] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, req.user!.sub)).limit(1);
    await publishToUser(userId, {
      t: 'poke',
      fromUserId: req.user!.sub,
      fromName: me?.displayName ?? 'Кто-то',
      // ⚠️ БЕЗ повторного `.slice(POKE_MAX_LEN)`: он резал бы по code units и снова разрубал
      // суррогатную пару, которую `pokeMessage` только что аккуратно сохранил.
      message: pokeMessage(message),
      channelId,
    });
    return reply.code(204).send();
  });

  /**
   * Типнуть человека в своём канале (жест из Доты) — ГусКоины, #117.
   *
   * ⚠️ Сумма НЕ приходит от клиента: она в настройках сервера. Иначе жест превратился бы в перевод
   * произвольного размера, а на клиент в таких вещах полагаться нельзя.
   * ⚠️ Оба должны сидеть в ЭТОМ канале — и отправитель тоже. Это не формальность: тип платит за
   * присутствие рядом, и «перевод кому угодно откуда угодно» — уже банк, а не жест.
   */
  app.post('/channels/:id/voice/:userId/tip', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });

    const [ch] = await db.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!ch) return reply.code(404).send({ error: 'not found' });

    // Закрытый показ (#117): для того, кого нет в списке, экономики тут нет — как и для сервера
    // с выключенной экономикой. `tipBlock` вернёт обычный отказ «экономика выключена».
    const economy = await economySeenBy(ch.serverId, req.user!.sub);
    const settings = {
      tipAmount: economy?.tipAmount ?? 5,
      tipTaxPercent: economy?.tipTaxPercent ?? 20,
      tipDailyOut: economy?.tipDailyOut ?? 100,
      tipDailyIn: economy?.tipDailyIn ?? 100,
      tipDailyPair: economy?.tipDailyPair ?? 25,
    };
    const [mine, theirs] = await Promise.all([
      walletOf(ch.serverId, req.user!.sub),
      walletOf(ch.serverId, userId),
    ]);
    const key = tipCooldownKey(req.user!.sub, userId);
    const block = tipBlock(
      {
        fromUserId: req.user!.sub,
        toUserId: userId,
        economyEnabled: economy?.enabled ?? false,
        together: (await inVoiceChannel(channelId, req.user!.sub)) && (await inVoiceChannel(channelId, userId)),
        // Свой отказ от экономики закрывает и отдачу тоже: контракт `optedOut` — «ни начисления,
        // ни типов», и раньше работала только первая половина.
        senderOptedOut: mine.optedOut,
        // Два разных выключателя: «не участвую в экономике» и «не принимаю типы» (#122). Для
        // отправителя они неразличимы намеренно — см. TIP_BLOCK_TEXT.
        targetOptedOut: theirs.optedOut || theirs.tipsOptOut,
        onCooldown: (await redisPub.exists(key)) === 1,
        balance: mine.balance,
        givenToday: mine.givenToday,
        receivedToday: theirs.receivedToday,
      },
      settings,
    );
    if (block) return reply.code(block === 'cooldown' ? 429 : 403).send({ error: TIP_BLOCK_TEXT[block] });

    // 🔴 Кулдаун ставится АТОМАРНО и он же — решение (#124, Д3). Раньше было два шага: `exists`
    // выше, потом `set` здесь. Двойной клик по Alt-кнопке, два клиента одного человека или пара
    // параллельных запросов проходили проверку оба — и оба доходили до денег: N типов одним
    // мгновением, N звуков в канале, чужой суточный предел приёма забивается за раз. `NX` отдаёт
    // `OK` ровно одному, остальные получают `null` — тот же приём, что уже держит счётчик тыков.
    // ⚠️ Кулдаун по-прежнему ДО денег: упасть после перевода и не записать его — значит открыть
    // окно на повторный жест.
    const claimed = await redisPub.set(key, '1', 'PX', TIP_COOLDOWN_MS, 'NX');
    if (claimed !== 'OK') return reply.code(429).send({ error: TIP_BLOCK_TEXT.cooldown });
    const split = tipSplit(settings.tipAmount, settings.tipTaxPercent);

    // 🔴 Деньги двигает ОДНА транзакция с блокировкой обоих кошельков (#123). Проверки выше — для
    // понятного отказа и быстрого пути; на них одних полагаться нельзя: между чтением и записью
    // состояние успевает измениться, и два одновременных типа проходили по одному старому числу.
    // Настоящее решение принимается внутри блокировки, там же где и списание.
    let moved;
    try {
      moved = await transferCoins({
        serverId: ch.serverId,
        fromUserId: req.user!.sub,
        toUserId: userId,
        debit: split.debit,
        credit: split.credit,
        burned: split.burned,
        dailyOut: settings.tipDailyOut,
        dailyIn: settings.tipDailyIn,
        dailyPair: settings.tipDailyPair,
        maxTippersPerDay: MAX_TIPPERS_PER_DAY,
        // Разбивка сезона — с сервера; без неё перекат в переводе считал бы по временам года.
        seasonLength: economy?.seasonLength ?? 'quarter',
        // ⚠️ Часы приходят аргументом: своих внутри `transferCoins` нет — иначе перекат суток было
        // бы нечем проверить.
        now: new Date(),
      });
    } catch (e) {
      // Транзакция откатилась целиком — денег не тронули, значит и держать кулдаун не за что: он
      // отмеряет паузу между СОСТОЯВШИМИСЯ жестами, а не наказывает за сбой базы (замечание Codex).
      await redisPub.del(key).catch(() => {});
      throw e;
    }
    if (moved.block) {
      // Отказ пришёл из-под блокировки: значит гонку мы и поймали. Кулдаун снимаем — жеста не было.
      await redisPub.del(key).catch(() => {});
      return reply.code(403).send({ error: TIP_BLOCK_TEXT[moved.block] });
    }

    await pushWallet(ch.serverId, req.user!.sub);
    await pushWallet(ch.serverId, userId);

    // 🔴 Момент, когда получатель упёрся в свой суточный предел приёма. Говорим ему ОДИН раз —
    // ровно на переходе, — а не на каждую следующую отклонённую попытку: иначе типом в упор можно
    // было бы завалить человека уведомлениями (#121).
    // ⚠️ Числа берём из транзакции, а не из чтения до неё: только они не врут при одновременности.
    if (settings.tipDailyIn > 0 && moved.receivedBefore < settings.tipDailyIn && moved.receivedAfter >= settings.tipDailyIn) {
      await publishToUser(userId, {
        t: 'economy.tipsFull',
        serverId: ch.serverId,
        received: moved.receivedAfter,
      });
    }

    // Оба имени одним запросом: получателя кладём в событие, иначе клиент без него в ростере
    // напишет «типнул кого-то».
    const named = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [req.user!.sub, userId]));
    const me = named.find((u) => u.id === req.user!.sub);
    const target = named.find((u) => u.id === userId);
    /**
     * Звук слышит весь канал — это часть жеста: публичная благодарность, а не тихий перевод.
     *
     * 🔴 **«Весь канал» = сидящие в ГОЛОСЕ, и аудиторию надо задавать ЯВНО** (фикс 05.09). Без
     * третьего аргумента `publishToChannel` рассылает всем, кому канал ВИДЕН, — то есть звук и
     * уведомление «кто-то кого-то типнул» доставались человеку, который вообще ни в каком канале не
     * сидит и просто держит приложение открытым. Именно так это и поймали.
     * ⚠️ Ровно об этом предупреждает комментарий в маршруте саундборда: там аудиторию задали сразу,
     * а тип и щипок остались с умолчанием — урок применили в одном месте из трёх.
     */
    await publishToChannel(
      ch.serverId,
      channelId,
      {
        t: 'tip',
        fromUserId: req.user!.sub,
        fromName: me?.displayName ?? 'Кто-то',
        toUserId: userId,
        // ⚠️ Имя получателя кладём В СОБЫТИЕ: клиент, у которого только что вошедшего ещё нет в
        // ростере, иначе писал «типнул кого-то» (05.09).
        toName: target?.displayName ?? 'Кто-то',
        amount: split.credit,
        channelId,
      },
      await voiceParticipantIds(channelId),
    );
    return reply.send({ debited: split.debit, credited: split.credit, burned: split.burned });
  });

  /**
   * Купить награду и применить её к человеку в этом канале (#117, этап 3).
   *
   * 🔴 Живёт рядом с тыком и типом намеренно: адресные награды начинаются с ЧЕЛОВЕКА, а не с
   * каталога. Магазин отвечает на «что вообще есть и почём», меню — «сделать это вот ему».
   *
   * ⚠️ Право то же, что у тыка (`POKE_MEMBERS`): МЕГА пок — это его громкая версия, и заводить под
   * него отдельное право значило бы, что человек без права тыкать может купить право тыкать.
   */
  app.post('/channels/:id/voice/:userId/buy', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const { item, message } = z
      .object({ item: z.string(), message: z.string().max(500).optional() })
      .parse(req.body ?? {});

    const spec = shopItem(item);
    if (!spec) return reply.code(404).send({ error: BUY_BLOCK_TEXT['unknown-item'] });
    /**
     * 🔴 Маршрут применяет РОВНО адресные награды, и проверять это обязан он сам.
     *
     * Пока в каталоге лежал один МЕГА пок, ключ можно было брать как есть. Как только появилась
     * вторая позиция, «любой ключ каталога» превратилось в дыру: запрос с ключом канальной награды
     * списал бы её цену — а разослан всё равно был бы эффект МЕГА пока, потому что ниже он зашит
     * константой. Дешёвая награда покупала бы дорогой эффект.
     *
     * ⚠️ Проверка нарочно по ВИДУ адресата, а не по имени ключа: следующая адресная награда сюда
     * пройдёт, но применяться будет тем же кодом ниже — значит, добавляя её, надо будет развести и
     * рассылку. Пусть об этом спотыкаются здесь, а не в проде.
     */
    if (spec.target !== 'user') return reply.code(404).send({ error: BUY_BLOCK_TEXT['unknown-item'] });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    if (!has(perms.permissions, Permission.POKE_MEMBERS)) return reply.code(403).send({ error: 'forbidden' });

    const [ch] = await db.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!ch) return reply.code(404).send({ error: 'not found' });

    const [target] = await db
      .select({ id: users.id, displayName: users.displayName, presenceStatus: users.presenceStatus })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) return reply.code(404).send({ error: 'not found' });

    const economy = await economySeenBy(ch.serverId, req.user!.sub);
    const entry = (await shopFor(economy)).find((e) => e.item === spec.key)!;
    const now = new Date();

    // Личные выключатели получателя: «не участвую в экономике» и «не принимаю тычки» одинаково
    // закрывают МЕГА пок — он и денежный, и тычок сразу.
    const [targetMember] = await db
      .select({ pokesOptOut: serverMembers.pokesOptOut })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, ch.serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    const theirs = await walletOf(ch.serverId, userId);
    const mine = await walletOf(ch.serverId, req.user!.sub);
    const key = buyCooldownKey(spec.key, req.user!.sub, spec.target === 'user' ? userId : null);

    const block = buyBlock({
      item: spec,
      buyerId: req.user!.sub,
      targetId: spec.target === 'user' ? userId : null,
      economyEnabled: economy?.enabled ?? false,
      itemEnabled: entry.enabled,
      buyerInVoice: await inVoiceChannel(channelId, req.user!.sub),
      targetInVoice: await inVoiceChannel(channelId, userId),
      buyerOptedOut: mine.optedOut,
      targetOptedOut: theirs.optedOut || targetMember?.pokesOptOut === true,
      targetDnd: target.presenceStatus === 'dnd',
      targetGotToday: await receivedToday(ch.serverId, spec.key, userId, now),
      targetDailyLimit: MEGA_DAILY_TO_ONE,
      onCooldown: (await redisPub.exists(key)) === 1,
      // Расходник: «уже есть» к нему не относится вовсе.
      alreadyOwned: false,
      balance: mine.balance,
      price: entry.priceCoins,
    });
    if (block) return reply.code(block === 'cooldown' ? 429 : 403).send({ error: BUY_BLOCK_TEXT[block] });

    // 🔴 Кулдаун захватывается АТОМАРНО и он же решение (#124, Д3): двойной клик по строке меню
    // иначе списал бы дважды, а дорогая награда — это не тот случай, где можно «ну бывает».
    const claimed = await redisPub.set(key, '1', 'PX', BUY_COOLDOWN_MS, 'NX');
    if (claimed !== 'OK') return reply.code(429).send({ error: BUY_BLOCK_TEXT.cooldown });

    let bought;
    try {
      bought = await buyItem({
        serverId: ch.serverId,
        userId: req.user!.sub,
        item: spec,
        targetUserId: spec.target === 'user' ? userId : null,
        price: entry.priceCoins,
        priceMinutes: entry.priceMinutes,
        ratePer5min: economy?.ratePer5min ?? 0,
        data: { message: pokeMessage(message) },
        now,
      });
    } catch (e) {
      // Транзакция откатилась целиком — денег не тронули, значит и кулдаун держать не за что.
      await redisPub.del(key).catch(() => {});
      throw e;
    }
    if (bought.block) {
      // Отказ пришёл из-под блокировки: гонку поймали, покупки не было.
      await redisPub.del(key).catch(() => {});
      return reply.code(403).send({ error: BUY_BLOCK_TEXT.poor });
    }

    await pushWallet(ch.serverId, req.user!.sub);
    const [me] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, req.user!.sub)).limit(1);
    // Аудитория задана ЯВНО — сидящие в голосе, а не все, кто видит канал (разбор выше, у типа).
    await publishToChannel(
      ch.serverId,
      channelId,
      {
        t: 'mega-poke',
        fromUserId: req.user!.sub,
        fromName: me?.displayName ?? 'Кто-то',
        toUserId: userId,
        toName: target.displayName,
        message: pokeMessage(message),
        amount: entry.priceCoins,
        channelId,
      },
      await voiceParticipantIds(channelId),
    );
    return reply.send({ spent: entry.priceCoins, balance: bought.balance });
  });

  // ─── Превью показа (#115) ───────────────────────────────────────────────────────────────────
  //
  // Кадр отдаёт САМ показывающий, раз в несколько секунд. Сервер держит только последний и только в
  // Redis с TTL.
  //
  // 🔴 Почему не в MinIO, куда уезжает вся остальная медиа: бакет `gusvoice` **public-read**. Кадр
  // чужого экрана по угадываемому URL, открытому всему интернету, — недопустимо ни при каких
  // удобствах. Здесь картинка вообще не становится файлом.

  /** Положить СВОЁ превью. Ключ включает того, кто прислал, — подделать чужое нельзя устройством. */
  app.put('/channels/:id/voice/preview', async (req, reply) => {
    const { id: channelId } = z.object({ id: z.string() }).parse(req.params);
    const { image } = z.object({ image: z.string() }).parse(req.body);

    // Сначала форма, потом права: отбить мусор дешевле, чем ходить в базу за членством.
    const check = checkStreamPreview(image);
    if (!check.ok) return reply.code(400).send({ error: check.error });

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not a member' });
    if (!canPublishScreen(perms.permissions)) return reply.code(403).send({ error: 'cannot share screen' });
    // ⚠️ И реально сидеть в канале. Без этого участник сервера мог бы подвесить картинку на себя
    // там, где его нет, — а зритель увидел бы её рядом с иконкой показа, которой нет.
    if (!(await inVoiceChannel(channelId, req.user!.sub))) return reply.code(409).send({ error: 'not in channel' });

    await redisPub.setex(streamPreviewKey(channelId, req.user!.sub), STREAM_PREVIEW_TTL_S, image);
    return reply.code(204).send();
  });

  /** Взять чужое превью. Право то же, по которому канал вообще виден в списке. */
  app.get('/channels/:id/voice/preview/:userId', async (req, reply) => {
    const { id: channelId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not a member' });
    if (!has(perms.permissions, Permission.VIEW_CHANNEL)) return reply.code(403).send({ error: 'forbidden' });

    const image = await redisPub.get(streamPreviewKey(channelId, userId));
    if (!image) return reply.code(404).send({ error: 'no preview' });
    // Превью живёт секунды — закешированное браузером показывало бы прошлое.
    reply.header('Cache-Control', 'no-store');
    return { image };
  });
}
