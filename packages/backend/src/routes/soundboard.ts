import { has, Permission } from '@gusvoice/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { economySeenBy, pushWallet, walletOf } from '../coins.js';
import { db } from '../db/index.js';
import { channels, serverSoundboard, users } from '../db/schema.js';
import { getChannelPermissions, getMemberContext } from '../permissions.js';
import { buyItem } from '../purchase.js';
import { publishToChannel, publishToServer, redisPub } from '../realtime.js';
import { shopFor } from '../shop.js';
import { BUY_BLOCK_TEXT, buyBlock, buyCooldownKey, minutesForPrice, shopItem } from '../shopRules.js';
import {
  CLIP_BLOCK_TEXT,
  SOUNDBOARD_CHANNEL_COOLDOWN_MS,
  SOUNDBOARD_MAX_BYTES,
  SOUNDBOARD_MAX_CLIPS,
  SOUNDBOARD_MAX_PRICE_COINS,
  SOUNDBOARD_MAX_SECONDS,
  clipBlock,
  clipPriceCoins,
  soundboardChannelKey,
  soundboardName,
} from '../soundboardRules.js';
import { putSound, resolveAudioMime, storageConfigured } from '../storage.js';
import { id } from '../util.js';
import { inVoiceChannel, voiceParticipantIds } from '../voicePresence.js';

/**
 * Саундборд сервера (#21): коллекция коротких сэмплов + платный выстрел в голосовой канал.
 *
 * 🔴 Управление коллекцией и выстрел живут в ОДНОМ файле, хотя первое привязано к серверу, а второе
 * к каналу. Это одна фича, и её правила (пределы, принадлежность сервера, пауза канала) должны
 * читаться рядом, иначе следующий правящий увидит половину.
 *
 * 🔴 **Права РАЗНЫЕ, и это суть.** Менять НАБОР — `MANAGE_SOUNDBOARD`, отдельное право (требование
 * к фиче): звук уведомления человек слышит по случаю, а сэмпл саундборда кто угодно проигрывает
 * всему каналу по своему желанию, и это разная мера доверия. СТРЕЛЯТЬ может любой участник канала —
 * там тормозом стоят монеты, а не право.
 */
export async function soundboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Что есть на сервере. Видит любой участник — жать кнопки может каждый, платит каждый сам. */
  app.get('/servers/:id/soundboard', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const rows = await db
      .select({
        id: serverSoundboard.id,
        name: serverSoundboard.name,
        url: serverSoundboard.url,
        priceCoins: serverSoundboard.priceCoins,
      })
      .from(serverSoundboard)
      .where(eq(serverSoundboard.serverId, serverId))
      // Порядок добавления — он же порядок кнопок: перетасовка убивает мышечную память.
      .orderBy(asc(serverSoundboard.createdAt));

    /**
     * 🔴 Действующую цену считаем ЗДЕСЬ: своя у звука — уже в монетах, общая приезжает из каталога
     * в минутах и переводится по текущей ставке. Клиент не должен ни знать ставку, ни уметь
     * переводить: две реализации одного перевода разошлись бы на округлении, и человек увидел бы
     * одну цену, а списалось бы другое.
     */
    const economy = await economySeenBy(serverId, req.user!.sub);
    const fallback = (await shopFor(economy)).find((e) => e.item === 'soundboard')!;
    const rate = economy?.ratePer5min ?? 0;
    const clips = rows.map((c) => {
      const coins = clipPriceCoins(c.priceCoins, fallback.priceCoins);
      return {
        id: c.id,
        name: c.name,
        url: c.url,
        /** `null` — своей цены нет, действует общая. Нужно панели управления, а не пикеру. */
        ownPriceCoins: c.priceCoins ?? null,
        priceCoins: coins,
        /** Справочно: во сколько минут сидения обходится эта цена сегодня. */
        priceMinutes: minutesForPrice(coins, rate),
      };
    });
    /**
     * 🔴 Пределы едут ОТСЮДА, а не повторяются константами в клиенте. Проверка длительности живёт
     * на клиенте (сервер звук не декодирует), и если бы число дублировалось, две стороны разошлись
     * бы при первой же правке — а разъехавшийся предел выглядит не как ошибка, а как каприз.
     */
    return reply.send({
      clips,
      max: SOUNDBOARD_MAX_CLIPS,
      maxBytes: SOUNDBOARD_MAX_BYTES,
      maxSeconds: SOUNDBOARD_MAX_SECONDS,
      // Общая цена — чтобы панель показывала, к чему откатится звук без своей цены.
      defaultPriceCoins: fallback.priceCoins,
      maxPriceCoins: SOUNDBOARD_MAX_PRICE_COINS,
    });
  });

  /**
   * Залить сэмпл (`MANAGE_SOUNDBOARD` — СВОЁ право, не то, что у звуков событий).
   *
   * ⚠️ Длительность здесь НЕ проверяется: сервер звук не декодирует, а по байтам её не узнать.
   * Ограничение длительности живёт на клиенте и держится на доверии к держателю права — разбор в
   * `soundboardRules.ts`.
   */
  app.post('/servers/:id/soundboard', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SOUNDBOARD)) return reply.code(403).send({ error: 'forbidden' });
    if (!storageConfigured()) return reply.code(503).send({ error: 'хранилище звуков не настроено' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const raw = file.fields?.name;
    const name = soundboardName(raw && 'value' in raw ? String(raw.value) : '');
    if (!name) return reply.code(400).send({ error: 'нужно короткое название кнопки' });

    /**
     * 🔴 Сначала БАЙТЫ, потом тип. Присланный MIME берётся из реестра машины отправителя, и один и
     * тот же m4a приезжает то `audio/mp4`, то `audio/x-m4a`. Решает содержимое — разбор в
     * `resolveAudioMime`.
     */
    const buffer = await file.toBuffer();
    const mime = resolveAudioMime(file.mimetype || '', new Uint8Array(buffer));
    if (!mime) {
      return reply.code(400).send({ error: 'формат не поддерживается — нужен MP3, OGG, WAV, WEBM или M4A' });
    }
    if (buffer.length > SOUNDBOARD_MAX_BYTES) {
      return reply.code(400).send({ error: `файл больше ${Math.round(SOUNDBOARD_MAX_BYTES / 1024)} КБ` });
    }

    // ⚠️ Считаем ДО заливки: иначе лишний файл уедет в хранилище и останется там сиротой.
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(serverSoundboard)
      .where(eq(serverSoundboard.serverId, serverId));
    if ((count?.n ?? 0) >= SOUNDBOARD_MAX_CLIPS) {
      return reply.code(400).send({ error: `больше ${SOUNDBOARD_MAX_CLIPS} звуков не поместится — удалите лишние` });
    }

    /**
     * Цена звука приходит формой и НЕОБЯЗАТЕЛЬНА: пусто — действует общая из каталога. Пустая
     * строка и мусор трактуются одинаково, потому что для человека это одно и то же — «не указал».
     */
    const rawPrice = file.fields?.price;
    const priceText = rawPrice && 'value' in rawPrice ? String(rawPrice.value).trim() : '';
    const parsedPrice = priceText === '' ? null : Number(priceText);
    if (parsedPrice !== null && (!Number.isFinite(parsedPrice) || parsedPrice < 0 || parsedPrice > SOUNDBOARD_MAX_PRICE_COINS)) {
      return reply.code(400).send({ error: `цена — от 0 до ${SOUNDBOARD_MAX_PRICE_COINS} монет` });
    }

    const clipId = id();
    const url = await putSound(serverId, `sb-${clipId}`, buffer, mime, Date.now());
    await db.insert(serverSoundboard).values({
      id: clipId,
      serverId,
      name,
      url,
      priceCoins: parsedPrice === null ? null : Math.floor(parsedPrice),
      createdBy: req.user!.sub,
    });
    await writeAudit(serverId, req.user!.sub, 'soundboard.add', {
      targetType: 'server',
      targetId: serverId,
      data: { name },
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.send({ id: clipId, name, url });
  });

  /**
   * Поменять цену звука (`MANAGE_SOUNDBOARD`).
   *
   * 🔴 Отдельным маршрутом, а не перезаливкой: цена — это настройка, а файл менять при этом не надо.
   * ⚠️ `null` возвращает звук на ОБЩУЮ цену каталога, и это не то же самое, что `0` («даром»).
   *    Различать обязательно: иначе владелец, стирающий поле, молча раздал бы звук бесплатно.
   */
  app.patch('/servers/:id/soundboard/:clipId', async (req, reply) => {
    const { id: serverId, clipId } = z.object({ id: z.string(), clipId: z.string() }).parse(req.params);
    const body = z
      .object({ priceCoins: z.number().int().min(0).max(SOUNDBOARD_MAX_PRICE_COINS).nullable() })
      .parse(req.body);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SOUNDBOARD)) return reply.code(403).send({ error: 'forbidden' });

    const [clip] = await db
      .select({ id: serverSoundboard.id, name: serverSoundboard.name })
      .from(serverSoundboard)
      .where(and(eq(serverSoundboard.id, clipId), eq(serverSoundboard.serverId, serverId)))
      .limit(1);
    if (!clip) return reply.code(404).send({ error: 'not found' });

    await db
      .update(serverSoundboard)
      .set({ priceCoins: body.priceCoins })
      .where(eq(serverSoundboard.id, clipId));
    await writeAudit(serverId, req.user!.sub, 'soundboard.price', {
      targetType: 'server',
      targetId: serverId,
      data: { name: clip.name, priceCoins: body.priceCoins },
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.send({ ok: true });
  });

  /** Удалить сэмпл (`MANAGE_SOUNDBOARD`). */
  app.delete('/servers/:id/soundboard/:clipId', async (req, reply) => {
    const { id: serverId, clipId } = z.object({ id: z.string(), clipId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_SOUNDBOARD)) return reply.code(403).send({ error: 'forbidden' });

    // ⚠️ Условие И по серверу: без него держатель права на одном сервере стирал бы сэмплы чужого.
    const gone = await db
      .delete(serverSoundboard)
      .where(and(eq(serverSoundboard.id, clipId), eq(serverSoundboard.serverId, serverId)))
      .returning({ name: serverSoundboard.name });
    if (!gone.length) return reply.code(404).send({ error: CLIP_BLOCK_TEXT['unknown-clip'] });

    await writeAudit(serverId, req.user!.sub, 'soundboard.remove', {
      targetType: 'server',
      targetId: serverId,
      data: { name: gone[0].name },
    });
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.code(204).send();
  });

  /**
   * ВЫСТРЕЛ: купить и проиграть сэмпл всем в голосовом канале.
   *
   * 🔴 Порядок захватов важен и стоил бы денег, если перепутать. Сначала общая пауза КАНАЛА (она
   * дешёвая, и её отказ ничего не стоит), потом личный кулдаун покупателя, и только потом деньги.
   * Любой откат ниже снимает то, что захватил выше, — иначе неудачная покупка оставила бы канал
   * запертым на несколько секунд ни за что.
   *
   * ⚠️ Отдельного права не заводим: жать кнопку может любой участник канала. Тормоз здесь монеты, а
   * не право; право означало бы, что у одних саундборд есть, а у других нет, — это уже другая фича.
   */
  app.post('/channels/:id/soundboard/:clipId', async (req, reply) => {
    const { id: channelId, clipId } = z.object({ id: z.string(), clipId: z.string() }).parse(req.params);

    const perms = await getChannelPermissions(channelId, req.user!.sub);
    if (!perms) return reply.code(404).send({ error: 'not found' });
    const [ch] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!ch) return reply.code(404).send({ error: 'not found' });

    const spec = shopItem('soundboard')!;
    const [clip] = await db
      .select({
        id: serverSoundboard.id,
        serverId: serverSoundboard.serverId,
        name: serverSoundboard.name,
        url: serverSoundboard.url,
        priceCoins: serverSoundboard.priceCoins,
      })
      .from(serverSoundboard)
      .where(eq(serverSoundboard.id, clipId))
      .limit(1);

    const chKey = soundboardChannelKey(channelId);
    const cBlock = clipBlock({
      clip: clip ?? null,
      serverId: ch.serverId,
      channelBusy: (await redisPub.exists(chKey)) === 1,
    });
    if (cBlock) return reply.code(cBlock === 'channel-busy' ? 429 : 404).send({ error: CLIP_BLOCK_TEXT[cBlock] });

    const economy = await economySeenBy(ch.serverId, req.user!.sub);
    const entry = (await shopFor(economy)).find((e) => e.item === spec.key)!;
    /**
     * 🔴 Списываем цену ЭТОГО звука, а не общую (запрос 02.09: ультимативные звуки дороже
     * посредственных). Общая остаётся запасной для тех, кому цену не назначали.
     * ⚠️ Своя цена звука уже в монетах (миграция 0057), общая приходит из каталога и переведена по
     * ТЕКУЩЕЙ ставке. Чек ниже всё равно фиксирует и минуты, и монеты, и ставку — чтобы спор
     * «сколько это стоило во вторник» был разрешим; минуты для чека считаем обратным переводом.
     */
    const clipCoins = clipPriceCoins(clip?.priceCoins, entry.priceCoins);
    const clipMinutes = minutesForPrice(clipCoins, economy?.ratePer5min ?? 0);
    const mine = await walletOf(ch.serverId, req.user!.sub);
    const buyKey = buyCooldownKey(spec.key, req.user!.sub, null);

    const block = buyBlock({
      item: spec,
      buyerId: req.user!.sub,
      targetId: null,
      economyEnabled: economy?.enabled ?? false,
      itemEnabled: entry.enabled,
      buyerInVoice: await inVoiceChannel(channelId, req.user!.sub),
      targetInVoice: false,
      buyerOptedOut: mine.optedOut,
      targetOptedOut: false,
      targetDnd: false,
      targetGotToday: 0,
      targetDailyLimit: 0,
      onCooldown: (await redisPub.exists(buyKey)) === 1,
      // Расходник: «уже есть» к нему не относится вовсе.
      alreadyOwned: false,
      balance: mine.balance,
      price: clipCoins,
    });
    if (block) return reply.code(block === 'cooldown' ? 429 : 403).send({ error: BUY_BLOCK_TEXT[block] });

    // Общая пауза канала — АТОМАРНО и раньше денег: она же решение, а не подсказка.
    const gotChannel = await redisPub.set(chKey, '1', 'PX', SOUNDBOARD_CHANNEL_COOLDOWN_MS, 'NX');
    if (gotChannel !== 'OK') return reply.code(429).send({ error: CLIP_BLOCK_TEXT['channel-busy'] });

    const claimed = await redisPub.set(buyKey, '1', 'PX', SOUNDBOARD_CHANNEL_COOLDOWN_MS, 'NX');
    if (claimed !== 'OK') {
      await redisPub.del(chKey).catch(() => {});
      return reply.code(429).send({ error: BUY_BLOCK_TEXT.cooldown });
    }

    let bought;
    try {
      bought = await buyItem({
        serverId: ch.serverId,
        userId: req.user!.sub,
        item: spec,
        targetUserId: null,
        price: clipCoins,
        priceMinutes: clipMinutes,
        ratePer5min: economy?.ratePer5min ?? 0,
        data: { clipId: clip!.id, name: clip!.name },
        now: new Date(),
      });
    } catch (e) {
      // Транзакция откатилась целиком — денег не тронули, значит и держать захваты не за что.
      await Promise.all([redisPub.del(chKey).catch(() => {}), redisPub.del(buyKey).catch(() => {})]);
      throw e;
    }
    if (bought.block) {
      await Promise.all([redisPub.del(chKey).catch(() => {}), redisPub.del(buyKey).catch(() => {})]);
      return reply.code(403).send({ error: BUY_BLOCK_TEXT.poor });
    }

    await pushWallet(ch.serverId, req.user!.sub);
    const [me] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, req.user!.sub))
      .limit(1);
    await publishToChannel(ch.serverId, channelId, {
      t: 'soundboard',
      fromUserId: req.user!.sub,
      fromName: me?.displayName ?? 'Кто-то',
      clipId: clip!.id,
      name: clip!.name,
      url: clip!.url,
      // 🔴 Цена ЭТОГО звука, а не общая: списывается `clipCoins`, и канал обязан слышать то же
      // число. Стояло `entry.priceCoins` — звук со своей ценой объявлялся чужой суммой.
      amount: clipCoins,
      channelId,
    },
    // 🔴 Аудитория задана ЯВНО — сидящие в голосе, а не все, кто видит канал. Без этого выстрел
    // услышал бы и тот, кто просто читает переписку, сидя голосом в другом канале.
    await voiceParticipantIds(channelId));
    return reply.send({ spent: clipCoins, balance: bought.balance });
  });
}
