import { checkCoinIcon, has, Permission } from '@gusvoice/shared';
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { applyCoins, claimGooseBonus, economyOf, economySeenBy, pushWallet, toEconomy, walletOf, type ServerEconomy } from '../coins.js';
import { economyDefaults } from '../economyDefaults.js';
import {
  GOOSE_CLAIM_TEXT,
  gooseBonusFor,
  gooseCooldownKey,
  gooseCurrentKey,
  gooseEnabled,
  gooseTokenKey,
} from '../gooseRules.js';
import {
  accrualStamp,
  beforeCutoff,
  dayStart,
  economyTotals,
  raiseCompensation,
  shouldCompensate,
  shouldSpendToggle,
  dayKey,
  replay,
  retroCutoff,
  rollPeriods,
  seasonId,
  seasonName,
  seasonRange,
  type ReasonTotal,
  type ReplaySample,
} from '../coinRules.js';
import { db } from '../db/index.js';
import {
  coinBalances,
  coinLedger,
  serverEconomy,
  serverMembers,
  serverShop,
  users,
  voiceActivity,
} from '../db/schema.js';
import { getMemberContext } from '../permissions.js';
import { SAMPLE_PERIOD_MS } from '../voiceActivityRules.js';
import { levelOf, levelStages } from '../levelRules.js';
import { streakView } from '../streakRules.js';
import { closeSeasonIfNeeded, crownHolder } from '../seasons.js';
import { shopFor } from '../shop.js';
import { avatarPriceAllowed, avatarRentalUntil, BUY_BLOCK_TEXT, buyBlock, shopItem } from '../shopRules.js';
import { avatarPriceMinutes } from '../instanceSettings.js';
import { buyItem } from '../purchase.js';
import { putMedia, storageConfigured } from '../storage.js';
import { publishToServer, redisPub } from '../realtime.js';

/**
 * Экономика сервера (GusCoins, #117). План — `docs/guscoins-plan.md`.
 *
 * Здесь маршруты и права; арифметика — в `coinRules.ts`, хранилище — в `coins.ts`.
 */

/** Ползунки. Границы намеренно широкие: это ручки владельца, а не защита от него. */
const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  currencyName: z.string().trim().min(1).max(24).optional(),
  ratePer5min: z.number().int().min(0).max(10_000).optional(),
  alonePercent: z.number().int().min(0).max(100).optional(),
  companyPercent: z.number().int().min(100).max(500).optional(),
  dailyCap: z.number().int().min(0).max(1_000_000).optional(),
  decayAfterMinutes: z.number().int().min(0).max(1440).optional(),
  decayPercent: z.number().int().min(0).max(100).optional(),
  mutedPercent: z.number().int().min(0).max(100).optional(),
  deafenedPercent: z.number().int().min(0).max(100).optional(),
  awayPercent: z.number().int().min(0).max(100).optional(),
  // Минимум минута: ноль означал бы выплату на каждом срезе, то есть отмену самой идеи шага.
  payoutMinutes: z.number().int().min(1).max(120).optional(),
  compensateOnRaise: z.boolean().optional(),
  tipAmount: z.number().int().min(1).max(10_000).optional(),
  tipTaxPercent: z.number().int().min(0).max(100).optional(),
  tipDailyOut: z.number().int().min(0).max(1_000_000).optional(),
  tipDailyIn: z.number().int().min(0).max(1_000_000).optional(),
  tipDailyPair: z.number().int().min(0).max(1_000_000).optional(),
  /** ⚠️ Смена разбивки ДОСРОЧНО закрывает текущий сезон — панель об этом предупреждает. */
  seasonLength: z.enum(['quarter', 'month']).optional(),
  // Бонус по клику. Потолок надбавки намеренно скромный: это добавка за присутствие, а не второй
  // источник дохода рядом с основной ставкой.
  gooseBonus: z.number().int().min(0).max(1000).optional(),
  gooseMinutes: z.number().int().min(0).max(240).optional(),
  // Надбавка в деафене. Верхняя граница НЕ проверяется относительно `gooseBonus`: одно поле не
  // видит другого при частичном PATCH, а обрезка живёт в `gooseBonusFor` — там, где считается плата.
  gooseDeafenedBonus: z.number().int().min(0).max(1000).optional(),
  streakBonus: z.number().int().min(0).max(1000).optional(),
});

/** Сколько суток истории берём для пересчёта под ползунками. */
const PREVIEW_DAYS = 7;

export async function economyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Настройки + мой кошелёк. Видит любой участник: баланс — не секрет. */
  app.get('/servers/:id/economy', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    // Закрытый показ: тому, кого нет в списке допуска, снимок приезжает выключенным (#117).
    const economy = await economySeenBy(serverId, req.user!.sub);
    const raw = await walletOf(serverId, req.user!.sub);
    const now = new Date();
    // 🔴 Разбивка сезона — из настроек сервера, как и везде. Здесь её не передавали, и на сервере
    // с помесячными сезонами виртуальный перекат сравнивал «m2026-09» с «autumn-2026»: счётчик
    // сезона в кошельке показывался нулём ВСЕГДА, а подпись врала «Осень» вместо «Сентябрь»
    // (аудит помесячных сезонов, 03.09).
    const length = economy?.seasonLength ?? 'quarter';
    // ⚠️ Перекат периодов ВИРТУАЛЬНО, только для показа (#124, С6). В базе он произойдёт при первом
    // же начислении или переводе; но человек, не заходивший с прошлого сезона, до тех пор видел бы
    // прошлогоднее число рядом с подписью нового сезона — и решил бы, что счётчик сломан.
    // Записывать отсюда НЕЛЬЗЯ: чтение кошелька не должно быть операцией над деньгами.
    const wallet = { ...raw, ...rollPeriods(raw, now, length) };
    return reply.send({
      enabled: economy?.enabled ?? false,
      currencyName: economy?.currencyName ?? 'ГусКоины',
      /**
       * Процент ставки в статусе «отошёл» — ВСЕМ, а не только управляющему (04.09).
       * 🔴 Человек должен видеть, что его статус стоит денег. Первый же день показал, как это бывает
       * тихо: двое застряли в «Отошёл» ещё со старой сборки (она не помечала авто-уход как авто,
       * поэтому автоматика их не возвращала) — играли и не знали, что получают четверть.
       */
      awayPercent: economy?.awayPercent ?? null,
      iconUrl: economy?.iconUrl ?? null,
      canManage: has(ctx.serverPermissions, Permission.MANAGE_ECONOMY),
      // Ползунки отдаём ТОЛЬКО тому, кто может их крутить: обычному человеку они ничего не
      // объясняют, а показывать чужую кухню без нужды незачем.
      // 🔴 Строки ещё нет — отдаём УМОЛЧАНИЯ, а не `null` (04.09). Иначе панель владельца вечно
      // висела на «Загрузка…» ровно там, где экономику и надо включить первый раз: строка
      // появляется при первом сохранении, а сохранить было негде. Поймано на боевом сервере в
      // момент включения фичи людям.
      settings: has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)
        ? (economy ?? economyDefaults(serverId))
        : null,
      wallet: {
        balance: wallet.balance,
        earnedTotal: wallet.earnedTotal,
        seasonEarned: wallet.seasonEarned,
        optedOut: wallet.optedOut,
        tipsOptOut: wallet.tipsOptOut,
      },
      season: { id: seasonId(now, length), name: seasonName(seasonId(now, length)) },
      // Уровень едет тем же ответом: он про этого же человека и нужен там же, где баланс.
      level: levelOf(raw),
      // Лестница званий в числах — рядом с уровнем, из того же источника (03.09: «этапы в
      // числах»). Восемь пар «звание → монеты», дублировать их на клиенте незачем.
      levelStages: levelStages(),
      // Серия дней — той же логикой, что и награда (правка 03.09: «в кошельке не видно стрик»).
      streak: streakView({ streakDay: raw.streakDay, streakDays: raw.streakDays }, dayKey(now), economy?.streakBonus ?? 0),
      /**
       * 🔴 Корона едет в ОБЩИЙ снимок, а не только в таблицу лидеров. Носят её на живых
       * поверхностях — в списке голосового канала, на плитке сцены, в списке участников, — и туда
       * снимок экономики уже приезжает. Отдельный запрос ради одного идентификатора означал бы
       * лишний поход к серверу на каждом экране, где человек нарисован.
       * ⚠️ `null` — сезон ещё ни разу не закрывался, короны нет ни у кого.
       */
      /**
       * 🔴 Гусь, который висит ПРЯМО СЕЙЧАС. Предложение приходит одним пушем и больше нигде не
       * лежало: обновил вкладку — живой гусь становился невидимым до следующего. Снимок его
       * восстанавливает (03.09, «не могу протестить получение бонуса»).
       */
      goose:
        economy?.enabled && gooseEnabled(economy)
          ? await redisPub.get(gooseCurrentKey(serverId, req.user!.sub)).then((offerId) => (offerId ? { offerId } : null))
          : null,
      crown: economy ? await crownHolder(serverId, now, economy.seasonLength) : null,
      // 🔴 Витрина приезжает ВМЕСТЕ с кошельком, а не отдельным запросом. Цена нужна там же, где
      // баланс: пункт «Сильно ткнуть» в меню обязан показывать её всегда, а не только когда хватает
      // монет — серый пункт без числа человек прочитает как «сломалось», а с ценой он учит экономике.
      shop: await shopFor(economy),
    });
  });

  /**
   * Купить БЕЗАДРЕСНУЮ награду — ту, что достаётся себе (анимированный аватар).
   *
   * 🔴 Маршрут серверный, а не канальный, и это следует из вида награды: адресные живут рядом с
   * человеком (меню участника), канальные — рядом с голосом, а косметика не привязана ни к тому,
   * ни к другому. Тот же принцип, из-за которого маршрут МЕГА пока проверяет вид адресата сам.
   *
   * ⚠️ Разрешение выдаётся ПОСЛЕ успешного списания и в отдельном запросе: `buyItem` уже завершил
   * свою транзакцию, и втискивать в неё правку `users` значило бы тянуть чужую таблицу в денежную
   * транзакцию ради одного флага. Сбой между ними оставит чек без разрешения — это видно в чеках и
   * чинится руками, тогда как обратный порядок раздавал бы разрешение без оплаты.
   */
  app.post('/servers/:id/shop/:item/buy', async (req, reply) => {
    const { id: serverId, item } = z.object({ id: z.string(), item: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const spec = shopItem(item);
    if (!spec) return reply.code(404).send({ error: BUY_BLOCK_TEXT['unknown-item'] });
    // Здесь покупается ТОЛЬКО безадресное. Адресное и канальное применяются в своих маршрутах, и
    // пропусти мы их сюда — деньги списались бы, а награда не применилась бы никак.
    if (spec.target !== 'none') return reply.code(404).send({ error: BUY_BLOCK_TEXT['unknown-item'] });

    const economy = await economySeenBy(serverId, req.user!.sub);
    const entry = (await shopFor(economy)).find((e) => e.item === spec.key)!;
    const mine = await walletOf(serverId, req.user!.sub);
    const [me] = await db
      .select({ until: users.animatedAvatarUntil })
      .from(users)
      .where(eq(users.id, req.user!.sub))
      .limit(1);
    const nowAt = new Date();

    const block = buyBlock({
      item: spec,
      buyerId: req.user!.sub,
      targetId: null,
      economyEnabled: economy?.enabled ?? false,
      itemEnabled: entry.enabled,
      buyerInVoice: false,
      targetInVoice: false,
      buyerOptedOut: mine.optedOut,
      targetOptedOut: false,
      targetDnd: false,
      targetGotToday: 0,
      targetDailyLimit: 0,
      onCooldown: false,
      /**
       * ⚠️ Аренду можно ПРОДЛЕВАТЬ, поэтому «уже есть» её больше не блокирует. Раньше здесь стоял
       * флаг «куплено навсегда», и с ним второй покупки быть не могло по определению.
       */
      alreadyOwned: false,
      balance: mine.balance,
      price: entry.priceCoins,
    });
    if (block) return reply.code(403).send({ error: BUY_BLOCK_TEXT[block] });

    const bought = await buyItem({
      serverId,
      userId: req.user!.sub,
      item: spec,
      targetUserId: null,
      price: entry.priceCoins,
      priceMinutes: entry.priceMinutes,
      ratePer5min: economy?.ratePer5min ?? 0,
      now: new Date(),
    });
    if (bought.block) return reply.code(403).send({ error: BUY_BLOCK_TEXT.poor });

    if (spec.key === 'animated-avatar') {
      // 🔴 Продлеваем от большего из «сейчас» и текущего срока: покупка за день до конца обязана
      // давать 31 день, иначе экономика наказывает за то, что человек продлил заранее.
      const until = avatarRentalUntil(me?.until ?? null, nowAt);
      await db.update(users).set({ animatedAvatarUntil: until }).where(eq(users.id, req.user!.sub));
      await pushWallet(serverId, req.user!.sub);
      return reply.send({ spent: entry.priceCoins, balance: bought.balance, until: until.toISOString() });
    }
    await pushWallet(serverId, req.user!.sub);
    return reply.send({ spent: entry.priceCoins, balance: bought.balance });
  });

  /**
   * Забрать пойманного гуся (план, модель G).
   *
   * 🔴 **Решение — удаление жетона, а не проверка перед начислением.** Идентификатор предложения
   * лежит в ИМЕНИ ключа, поэтому `DEL` по точному имени сам по себе атомарен: первый вернувший
   * идентификатор получает единицу и забирает бонус, второй получает ноль. Проверь мы «жетон
   * существует», а потом начисли и удали — двойное нажатие успело бы пролезть между шагами и
   * выдало бы надбавку дважды.
   *
   * ⚠️ Начисление идёт через `moveCoins` с причиной `goose`, а не через начисление за голос: это
   * НАДБАВКА поверх ставки, и в журнале она обязана быть отличима — иначе разбор «откуда монеты»
   * снова упрётся в «было столько, стало столько».
   */
  app.post('/servers/:id/economy/goose/:offerId', async (req, reply) => {
    const { id: serverId, offerId } = z.object({ id: z.string(), offerId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const economy = await economySeenBy(serverId, req.user!.sub);
    if (!economy?.enabled || !gooseEnabled(economy)) {
      return reply.code(403).send({ error: GOOSE_CLAIM_TEXT.unavailable, reason: 'unavailable' });
    }
    // ⚠️ Свой отказ от экономики уважается и здесь: не участвуешь — не копишь ничем, включая гуся.
    const mine = await walletOf(serverId, req.user!.sub);
    if (mine.optedOut) {
      return reply.code(403).send({ error: GOOSE_CLAIM_TEXT.unavailable, reason: 'unavailable' });
    }

    const won = await redisPub.del(gooseTokenKey(serverId, req.user!.sub, offerId));
    // ⚠️ Снимаем и указатель «сейчас висит вот это»: иначе снимок экономики вернул бы уже забранного
    // гуся, и кнопка воскресла бы после перезагрузки страницы.
    if (won === 1) await redisPub.del(gooseCurrentKey(serverId, req.user!.sub));
    if (won !== 1) {
      return reply.code(409).send({ error: GOOSE_CLAIM_TEXT.expired, reason: 'expired' });
    }

    /**
     * 🔴 **Откат до следующего гуся заводится ЗДЕСЬ, а не при его выходе** (решение 07.09).
     * Ставим сразу после того, как жетон достался нам, и ДО начисления: упади начисление — человек
     * потеряет одну надбавку, но метроном не собьётся. Обратный порядок при той же аварии выпустил
     * бы следующего гуся немедленно.
     * ⚠️ Отказ Redis не должен превращать состоявшуюся поимку в ошибку: потерянный откат — это один
     * лишний гусь, потерянная надбавка — это жалоба.
     */
    await redisPub
      .set(gooseCooldownKey(serverId, req.user!.sub), '1', 'PX', economy.gooseMinutes * 60_000)
      .catch(() => undefined);

    const bonus = gooseBonusFor(economy, { deafened: await deafenedNow(serverId, req.user!.sub) });
    const balance = await claimGooseBonus(serverId, req.user!.sub, bonus);
    return reply.send({ bonus, balance });
  });

  /**
   * Экономическая карточка ЧУЖОГО человека — для карточки профиля (план, «Где показывать баланс»).
   *
   * 🔴 **Наружу идут баланс и уровень — и всё.** Ни часов, ни отметок времени, ни `earnedTotal`:
   * приватность §9 плана. Баланс — это косвенно «сколько он тут провёл», но то же самое уже
   * публикует таблица лидеров, а часы и время посещений не публикует ничто.
   *
   * ⚠️ Отказавшемуся от экономики отдаём `null` — ровно то же, что отдали бы при выключенной
   * экономике. Это НЕ мелочь: отдай мы отдельный признак «он отказался», и выключатель превратился
   * бы в повод для подколок, ради чего его безликость и заводилась (та же логика, что у текстов
   * отказа в переводе).
   */
  app.get('/servers/:id/economy/user/:userId', async (req, reply) => {
    const { id: serverId, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    // Спрашиваемый обязан быть участником ТОГО ЖЕ сервера: кошелёк посерверный, и заглядывать в
    // чужой сервер по одному идентификатору нельзя.
    const theirs = await getMemberContext(serverId, userId);
    if (!theirs) return reply.code(404).send({ error: 'not found' });

    // Гейт по СМОТРЯЩЕМУ, а не по тому, чью карточку смотрят: показ закрыт для зрителя.
    const economy = await economySeenBy(serverId, req.user!.sub);
    if (!economy?.enabled) return reply.send({ card: null });

    const raw = await walletOf(serverId, userId);
    if (raw.optedOut) return reply.send({ card: null });
    return reply.send({ card: { balance: raw.balance, level: levelOf(raw) } });
  });

  /**
   * Цена и доступность позиции каталога (MANAGE_ECONOMY).
   *
   * ⚠️ Цена задаётся в МИНУТАХ сидения. В монеты её переводит сервер в момент покупки по текущей
   * ставке — иначе сдвиг ползунка ставки разом ломает весь прайс.
   */
  app.patch('/servers/:id/shop/:item', async (req, reply) => {
    const { id: serverId, item } = z.object({ id: z.string(), item: z.string() }).parse(req.params);
    const patch = z
      .object({
        // `null` — снять свою цену и вернуться к умолчанию (для аватара — к цене инстанса).
        priceMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });

    const spec = shopItem(item);
    if (!spec) return reply.code(404).send({ error: 'такой награды не существует' });
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing to change' });
    /**
     * 🔴 Цену аватара владелец сервера МОЖЕТ поднять, но не опустить ниже цены инстанса (14.09).
     * ⚠️ Отказ явный, с числом пола: молча прижатая цена выглядела бы как сломанное поле. Чтение
     * (`avatarMinutesFor`) всё равно берёт максимум — это страховка на случай, если пол поднимут уже
     * после того, как владелец назначил свою цену.
     */
    if (spec.key === 'animated-avatar' && typeof patch.priceMinutes === 'number') {
      const floorMinutes = await avatarPriceMinutes();
      if (!avatarPriceAllowed(floorMinutes, patch.priceMinutes)) {
        return reply.code(400).send({
          error: `Цена аватара не может быть ниже цены инстанса — ${floorMinutes} мин`,
          floorMinutes,
        });
      }
    }

    await db
      .insert(serverShop)
      // ⚠️ Без своей цены — `null`, а НЕ умолчание каталога: строку создаёт и тумблер продажи, и
      // наливная цена выглядела бы как решение владельца (миграция 0059).
      .values({ serverId, item, priceMinutes: patch.priceMinutes ?? null, enabled: patch.enabled ?? true })
      .onConflictDoUpdate({
        target: [serverShop.serverId, serverShop.item],
        set: { ...patch, updatedAt: new Date() },
      });
    await writeAudit(serverId, req.user!.sub, 'economy.shop', {
      targetType: 'server',
      targetId: serverId,
      // ⚠️ Кладём и ЧЕЛОВЕЧЕСКОЕ имя награды, а не только ключ: иначе журнал показывал бы
      // «изменил в лавке mega-poke». Источник имени один — `shopRules.ts`, дублировать его
      // словарём в клиенте нельзя: разъедутся.
      data: { item, label: spec.label, ...patch },
    });
    return reply.send({ shop: await shopFor(await economyOf(serverId)) });
  });

  /** Покрутить ползунки (MANAGE_ECONOMY). */
  app.patch('/servers/:id/economy', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const patch = settingsSchema.parse(req.body ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });

    // 🔴 Чтение старой ставки и запись новой — ОДНОЙ транзакцией под блокировкой строки настроек
    // (#124, Д5). Раньше `before` читался снаружи: два PATCH-а, пришедшие одновременно, видели одну
    // и ту же старую ставку и компенсировали ОДНО повышение дважды.
    const { row, compensated, touched } = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(serverEconomy)
        .where(eq(serverEconomy.serverId, serverId))
        .limit(1)
        .for('update');

      // 🔴 Момент, с которого монеты капают вживую (#124, Д1). Ставим ровно один раз — при первом
      // включении — и больше не двигаем: он и есть граница, до которой платит ретро. Перенеси её
      // вперёд при повторном включении, и ретро оплатит вторым разом всё, за что уже заплатил тикер.
      const startsAccrual = accrualStamp(before?.accrualSince, patch.enabled, new Date());
      const stamp = startsAccrual ? { accrualSince: startsAccrual } : {};

      const [saved] = await tx
        .insert(serverEconomy)
        .values({ serverId, ...patch, ...stamp })
        .onConflictDoUpdate({
          target: serverEconomy.serverId,
          // ⚠️ `accrualSince` попадает в `set` ТОЛЬКО когда его ещё не было: иначе повторный PATCH
          // с `enabled: true` (кнопка нажата дважды, два клиента) сдвинул бы границу.
          set: { ...patch, ...stamp, updatedAt: new Date() },
        })
        .returning();

      // Решение вынесено в чистые правила — там же его и проверяют (разбор Codex).
      if (!shouldCompensate(saved.compensateOnRaise, before?.ratePer5min, saved.ratePer5min)) {
        return { row: saved, compensated: 0, touched: [] as string[] };
      }
      const done = await compensateRateRise(tx, serverId, before?.ratePer5min, saved.ratePer5min);
      // ⚠️ Ничего не доначислилось (кошельки пустые) — тумблер НЕ тратим: он взведён под одно
      // повышение, а этого повышения фактически не произошло.
      if (!shouldSpendToggle(done.sum)) return { row: saved, compensated: 0, touched: [] as string[] };

      // 🔴 Сработал — гасим тумблер (#124, Д5). Он задуман на ОДНО осознанное повышение; забытый
      // включённым, он превращает калибровку в станок: на каждом «вверх» доначисляет, на «вниз» не
      // отыгрывает, и балансы едут вверх на качелях.
      const [reset] = await tx
        .update(serverEconomy)
        .set({ compensateOnRaise: false })
        .where(eq(serverEconomy.serverId, serverId))
        .returning();
      return { row: reset, compensated: done.sum, touched: done.userIds };
    });

    // Шина — за коммитом: числа уже в базе.
    for (const userId of touched) await pushWallet(serverId, userId);

    await writeAudit(serverId, req.user!.sub, 'economy.settings', {
      targetType: 'server',
      targetId: serverId,
      // Доначисление не должно происходить молча — оно и в ответе, и в журнале действий.
      data: { ...patch, compensated, people: touched.length } as Record<string, unknown>,
    });
    // Название и иконка валюты видны всем — пусть подхватят без перезахода.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.send({ ...toEconomy(row), compensated });
  });

  /**
   * Живой пересчёт под ползунками: сколько заработали бы люди за последнюю неделю ПРИ ЭТИХ
   * настройках.
   *
   * 🔴 Смысл всей панели. Ползунок без цифры последствий — это гадание; здесь владелец видит не
   * абстрактную ставку, а «Петя получил бы столько, ты столько» по своим же реальным вечерам.
   * Считает `replay` — та же функция, что и ретроначисление, иначе панель обещала бы одно, а
   * начислилось бы другое.
   */
  app.post('/servers/:id/economy/preview', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const patch = settingsSchema.parse(req.body ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });

    const current = await economyOf(serverId);
    const settings = { ...(current ?? economyDefaults(serverId)), ...patch };
    const since = new Date(Date.now() - PREVIEW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        userId: voiceActivity.userId,
        seconds: voiceActivity.seconds,
        peers: voiceActivity.peers,
        muted: voiceActivity.muted,
        deafened: voiceActivity.deafened,
        away: voiceActivity.away,
        at: voiceActivity.createdAt,
        name: users.displayName,
      })
      .from(voiceActivity)
      .innerJoin(users, eq(users.id, voiceActivity.userId))
      .where(and(eq(voiceActivity.serverId, serverId), gte(voiceActivity.createdAt, since)))
      // ⚠️ Сортировка ОБЯЗАТЕЛЬНА: `replay` копит состояние суток по ходу и на перемешанном вводе
      // посчитает потолок и затухание неправильно.
      .orderBy(asc(voiceActivity.createdAt));

    const names = new Map(rows.map((r) => [r.userId, r.name]));
    const totals = replay(rows as ReplaySample[], settings);
    return reply.send({
      days: PREVIEW_DAYS,
      samples: rows.length,
      people: totals.map((t) => ({
        userId: t.userId,
        displayName: names.get(t.userId) ?? t.userId,
        coins: t.coins,
        hours: Math.round((t.seconds / 3600) * 10) / 10,
      })),
    });
  });

  /**
   * Что БУДЕТ выдано, если нажать ретро прямо сейчас (MANAGE_ECONOMY). Ничего не меняет.
   *
   * 🔴 Ретро необратимо и одноразово, а настройки при нажатии — любые. Нажали с неверной ставкой —
   * всё, откатывать руками по журналу (#121, «ретро может уехать с неверной ставкой»). Поэтому
   * подтверждение обязано показывать ИТОГОВЫЕ ЧИСЛА ПО ЛЮДЯМ, а не общий вопрос «начислить?».
   *
   * ⚠️ И это НЕ то же самое, что панельный пересчёт под ползунками: тот показывает последнюю
   * НЕДЕЛЮ, а ретро платит за ВСЮ историю до момента включения. Чем дольше идёт прогон, тем сильнее
   * эти два числа расходятся — на третьем месяце ожидания панель обещает недельные сотни, а ретро
   * выдаст тысячи. Считаем ровно тем же кодом, что и выдача, иначе предпросмотр обещал бы одно, а
   * начислилось бы другое.
   */
  app.post('/servers/:id/economy/retro/preview', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });

    const economy = await economyOf(serverId);
    if (!economy) return reply.code(400).send({ error: 'экономика ещё не настроена' });

    const plan = await planRetro(serverId, economy);
    const names = await namesOf(plan.paid.map((t) => t.userId));
    return reply.send({
      until: plan.until.toISOString(),
      samples: plan.samples,
      alreadyGranted: !!economy.retroGrantedAt,
      granted: plan.paid.reduce((s, t) => s + t.coins, 0),
      skipped: plan.skipped,
      people: plan.paid
        .map((t) => ({
          userId: t.userId,
          displayName: names.get(t.userId) ?? t.userId,
          coins: t.coins,
          hours: Math.round((t.seconds / 3600) * 10) / 10,
        }))
        .sort((a, b) => b.coins - a.coins),
    });
  });

  /**
   * Ретроначисление за сухой прогон — ОДИН раз (MANAGE_ECONOMY).
   *
   * Смысл: в день включения экономики у всех уже что-то есть, а не пустой ноль, с которым монеты
   * первую неделю выглядят декорацией. И это единственная неподкрученная выборка в жизни экономики —
   * пока шёл прогон, никто не знал, что идёт счёт.
   *
   * ⚠️ Одноразовость держится отметкой `retro_granted_at`: повторный вызов иначе удвоил бы всем
   * балансы, а откатывать такое пришлось бы руками по журналу.
   * 🔴 А от пересечения с ЖИВЫМ начислением держит верхняя граница `accrual_since` (#124, Д1):
   * `retro_granted_at` защищал только от второго ретро — вечера, за которые уже заплатил тикер,
   * оплачивались вторым разом при первом же нажатии.
   */
  app.post('/servers/:id/economy/retro', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });

    const economy = await economyOf(serverId);
    if (!economy) return reply.code(400).send({ error: 'экономика ещё не настроена' });
    if (economy.retroGrantedAt) return reply.code(409).send({ error: 'ретроначисление уже выдано' });

    const plan = await planRetro(serverId, economy);
    if (plan.samples === 0) return reply.code(400).send({ error: 'статистики ещё нет' });
    const { until, paid, skipped, rows } = plan;

    // 🔴 Отметка и все начисления — ОДНОЙ транзакцией (#124, С5). Раньше отметка ставилась первой,
    // а люди обходились циклом: упади он на восьмом из семнадцати — восьмерым выдано, девяти нет, и
    // кнопка заблокирована навсегда. Теперь либо всем, либо никому, и повтор после сбоя безопасен.
    // ⚠️ Отметка внутри транзакции по условию `IS NULL` работает и как замок от второго нажатия:
    // параллельный запрос ждёт на строке и, дождавшись, видит её занятой.
    const granted = await db.transaction(async (tx) => {
      const marked = await tx
        .update(serverEconomy)
        .set({ retroGrantedAt: new Date() })
        .where(and(eq(serverEconomy.serverId, serverId), sql`${serverEconomy.retroGrantedAt} IS NULL`))
        .returning({ serverId: serverEconomy.serverId });
      if (marked.length === 0) return null;

      let sum = 0;
      for (const t of paid) {
        // Ретро — это заработанное, а не подарок: растит и `earnedTotal`, и сезонный счётчик.
        await applyCoins(tx, {
          serverId,
          userId: t.userId,
          amount: t.coins,
          reason: 'retro',
          data: { seconds: t.seconds, samples: rows.length, until: until.toISOString() },
          countsAsEarned: true,
        });
        sum += t.coins;
      }
      return sum;
    });
    if (granted === null) return reply.code(409).send({ error: 'ретроначисление уже выдано' });

    // Шина — после коммита: числа уже в базе, и никакой откат их не отберёт.
    for (const t of paid) await pushWallet(serverId, t.userId);

    await writeAudit(serverId, req.user!.sub, 'economy.retro', {
      targetType: 'server',
      targetId: serverId,
      data: { granted, samples: plan.samples, paid: paid.length, skipped, until: until.toISOString() },
    });
    return reply.send({ granted, people: paid.length, skipped });
  });

  /**
   * Загрузить иконку валюты (MANAGE_ECONOMY).
   *
   * ⚠️ Проверка — в `checkCoinIcon` (shared): там же, где объяснено, почему нельзя анимацию и
   * почему нет SVG. Здесь только права, хранилище и запись.
   */
  app.post('/servers/:id/economy/icon', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });
    // Хранилища нет — говорим об этом прямо. Экономика при этом обязана работать со значком по
    // умолчанию: на turnkey-инстансе без MinIO она не должна упираться в иконку.
    if (!storageConfigured()) return reply.code(503).send({ error: 'хранилище не настроено' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'нет файла' });
    const buffer = await file.toBuffer();
    const check = checkCoinIcon(file.mimetype || '', buffer);
    if (!check.ok) return reply.code(400).send({ error: check.error });

    const iconUrl = await putMedia('coin-icons', serverId, buffer, file.mimetype, Date.now());
    await db
      .insert(serverEconomy)
      .values({ serverId, iconUrl })
      .onConflictDoUpdate({ target: serverEconomy.serverId, set: { iconUrl, updatedAt: new Date() } });
    await writeAudit(serverId, req.user!.sub, 'economy.icon', { targetType: 'server', targetId: serverId, data: {} });
    // Значок видят все — пусть подхватят без перезахода.
    await publishToServer(serverId, { t: 'server.invalidate', serverId });
    return reply.send({ iconUrl });
  });

  /** Не участвовать в экономике (не копить, не попадать в таблицу лидеров). Свой выбор. */
  app.patch('/servers/:id/economy/me', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { optedOut, tipsOptOut } = z
      .object({ optedOut: z.boolean().optional(), tipsOptOut: z.boolean().optional() })
      .parse(req.body ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    // Меняем ТОЛЬКО присланное: два выключателя независимы, и правка одного не должна молча
    // переставлять другой (#122).
    const patch: { optedOut?: boolean; tipsOptOut?: boolean } = {};
    if (optedOut !== undefined) patch.optedOut = optedOut;
    if (tipsOptOut !== undefined) patch.tipsOptOut = tipsOptOut;
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing to change' });

    const [row] = await db
      .insert(coinBalances)
      .values({ serverId, userId: req.user!.sub, ...patch })
      .onConflictDoUpdate({ target: [coinBalances.serverId, coinBalances.userId], set: patch })
      .returning({ optedOut: coinBalances.optedOut, tipsOptOut: coinBalances.tipsOptOut });
    return reply.send(row);
  });

  /**
   * Принимать ли тычки на этом сервере. 🔴 Решение ЧЕЛОВЕКА, а не владельца (#122).
   *
   * Живёт здесь рядом с остальными личными переключателями, хотя тык и не экономика: человеку эти
   * настройки нужны в одном месте, а не в двух разных углах.
   */
  app.get('/servers/:id/members/me', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    const [row] = await db
      .select({ pokesOptOut: serverMembers.pokesOptOut })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, req.user!.sub)))
      .limit(1);
    // ⚠️ Только СВОИ настройки и отдельным маршрутом: в общий список участников это класть нельзя —
    // тогда любой видел бы, кто отключил приём, а это ровно та подсказка, которой не должно быть.
    return reply.send({ pokesOptOut: row?.pokesOptOut === true });
  });

  app.patch('/servers/:id/members/me/pokes', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { pokesOptOut } = z.object({ pokesOptOut: z.boolean() }).parse(req.body ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    await db
      .update(serverMembers)
      .set({ pokesOptOut })
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, req.user!.sub)));
    return reply.send({ pokesOptOut });
  });

  /**
   * Сводка по экономике сервера (MANAGE_ECONOMY) — #121 «нет наблюдаемости» + #124 К4.
   *
   * 🔴 Смысл: включим на семнадцать человек — и как поймём, что считается верно? До этой сводки
   * первым признаком бага была бы жалоба человека, а не наш собственный взгляд на цифры.
   *
   * 🔴 **Главное здесь — не суммы, а `drift`.** Инвариант денег простой: сумма всех строк журнала
   * человека обязана равняться его балансу. Каждый писатель баланса пишет и строку журнала, в одной
   * транзакции, — значит расхождение НЕ МОЖЕТ появиться при исправной работе. Появилось — значит
   * где-то деньги поменялись мимо журнала, и это ровно тот класс тихой порчи, из-за которого
   * заводились Д2 и С4. В норме массив пустой; непустой — повод останавливаться и разбираться.
   */
  app.get('/servers/:id/economy/summary', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.MANAGE_ECONOMY)) return reply.code(403).send({ error: 'forbidden' });

    const since = dayStart(new Date());

    // Движение за сутки, свёрнутое по причинам. Арифметика (в том числе «сколько сгорело») — в
    // `economyTotals`, чтобы её можно было проверить тестом без базы.
    const byReason = await db
      .select({
        reason: coinLedger.reason,
        total: sql<number>`SUM(${coinLedger.amount})::int`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(coinLedger)
      .where(and(eq(coinLedger.serverId, serverId), gte(coinLedger.createdAt, since)))
      .groupBy(coinLedger.reason);

    // Кто сколько наработал за сутки — чтобы выброс было видно глазами, а не только в среднем.
    const top = await db
      .select({
        userId: coinLedger.userId,
        displayName: users.displayName,
        coins: sql<number>`SUM(${coinLedger.amount})::int`,
      })
      .from(coinLedger)
      .innerJoin(users, eq(users.id, coinLedger.userId))
      .where(and(eq(coinLedger.serverId, serverId), eq(coinLedger.reason, 'voice'), gte(coinLedger.createdAt, since)))
      .groupBy(coinLedger.userId, users.displayName)
      .orderBy(sql`SUM(${coinLedger.amount}) DESC`)
      .limit(10);

    // 🔴 СВЕРКА (#124, К4). Считаем по ВСЕЙ истории, а не за сутки: расхождение, случившееся месяц
    // назад, никуда не делось и обязано быть видно сегодня.
    // ⚠️ Полный проход по журналу. На минутном тикере это сотни тысяч строк в год на семнадцать
    // человек — для запроса, который открывают руками и изредка, приемлемо. Станет тесно —
    // считать инкрементально, но не раньше: преждевременный кеш здесь означал бы, что сверка
    // сверяет сама с собой.
    const drift = await db.execute(sql`
      SELECT b.user_id, u.display_name, b.balance, COALESCE(l.total, 0)::int AS ledger
        FROM coin_balances b
        JOIN users u ON u.id = b.user_id
        LEFT JOIN (
          SELECT user_id, SUM(amount)::int AS total
            FROM coin_ledger
           WHERE server_id = ${serverId}
           GROUP BY user_id
        ) l ON l.user_id = b.user_id
       WHERE b.server_id = ${serverId}
         AND b.balance <> COALESCE(l.total, 0)
       ORDER BY ABS(b.balance - COALESCE(l.total, 0)) DESC
       LIMIT 50
    `);

    const [circulation] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${coinBalances.balance}), 0)::int`,
        people: sql<number>`COUNT(*)::int`,
      })
      .from(coinBalances)
      .where(eq(coinBalances.serverId, serverId));

    return reply.send({
      since: since.toISOString(),
      totals: economyTotals(byReason as ReasonTotal[]),
      top,
      circulation: circulation?.total ?? 0,
      wallets: circulation?.people ?? 0,
      drift: ((drift.rows ?? []) as { user_id: string; display_name: string; balance: number; ledger: number }[]).map(
        (r) => ({ userId: r.user_id, displayName: r.display_name, balance: r.balance, ledger: r.ledger }),
      ),
    });
  });

  /**
   * Сезонная таблица лидеров + корона (этап 4).
   *
   * 🔴 Запрос ОБЯЗАН фильтровать по текущему `season_id`. Сброс `season_earned` ленивый — он
   * случается у человека при первом начислении в новом сезоне. Тот, кто не заходил с зимы, весной
   * висел бы в топе с прошлогодним числом как действующий лидер (поймал Codex ещё в разборе плана).
   *
   * ⚠️ Перед чтением закрываем сезон, если он сменился: иначе итоги замёрзнут только когда кто-то
   * первым зайдёт в голос, а корону надо показать сразу.
   */
  app.get('/servers/:id/economy/leaderboard', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const now = new Date();
    await closeSeasonIfNeeded(serverId, now);
    const economy = await economySeenBy(serverId, req.user!.sub);
    const length = economy?.seasonLength ?? 'quarter';
    const season = seasonId(now, length);

    const rows = await db
      .select({
        userId: coinBalances.userId,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        earned: coinBalances.seasonEarned,
        /**
         * 🔴 Для УРОВНЯ берём пожизненное `earnedTotal`, а НЕ сезонное `earned`.
         *
         * Уровень — это «сколько ты с нами всего», он не обнуляется вместе с сезоном. Посчитай его
         * от сезонного — и в таблице человек показывался бы ниже, чем в собственном кошельке, а
         * первого числа нового сезона у всех стало бы «Птенец». Таблица меряет СЕЗОН, звание меряет
         * ПУТЬ, и это два разных числа рядом.
         */
        earnedTotal: coinBalances.earnedTotal,
      })
      .from(coinBalances)
      .innerJoin(users, eq(users.id, coinBalances.userId))
      .where(
        and(
          eq(coinBalances.serverId, serverId),
          // 🔴 Вот эта строка и есть защита от «висит с прошлого сезона».
          eq(coinBalances.seasonId, season),
          gt(coinBalances.seasonEarned, 0),
          // Отказавшийся от участия в таблице не показывается: он просил его не считать.
          eq(coinBalances.optedOut, false),
        ),
      )
      .orderBy(sql`${coinBalances.seasonEarned} DESC`)
      .limit(20);

    const crown = await crownHolder(serverId, now, length);
    return reply.send({
      season: { id: season, name: seasonName(season) },
      crown,
      people: rows.map((r, i) => ({
        place: i + 1,
        userId: r.userId,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        earned: r.earned,
        level: levelOf({ earnedTotal: r.earnedTotal }),
      })),
    });
  });

  /** Мои последние операции — чтобы «было 500, стало 300» имело ответ. */
  /**
   * Свой журнал операций.
   *
   * 🔴 **По умолчанию 20 записей** (решение 03.09). В кошельке журнал — это «что было только
   * что», а не архив: длинный список отжимает вниз всё остальное и всё равно не читается.
   * За большим — `period`, и это уже ВЫГРУЗКА, а не просмотр.
   *
   * ⚠️ Границу периода считает СЕРВЕР, а не клиент: у сезона она зависит от разбивки сервера
   * (квартал или месяц), и клиент, посчитавший её сам, разошёлся бы с сервером ровно на стыке
   * сезонов — там, где выгрузка нужнее всего.
   */
  app.get('/servers/:id/economy/ledger', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const { period, limit } = z
      .object({
        period: z.enum(['week', 'month', 'season']).optional(),
        limit: z.coerce.number().int().min(1).max(5_000).optional(),
      })
      .parse(req.query ?? {});
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });

    const now = new Date();
    let from: Date | null = null;
    if (period === 'week') from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (period === 'month') from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (period === 'season') {
      const economy = await economyOf(serverId);
      from = seasonRange(seasonId(now, economy?.seasonLength ?? 'quarter')).from;
    }

    const rows = await db
      .select()
      .from(coinLedger)
      .where(
        and(
          eq(coinLedger.serverId, serverId),
          eq(coinLedger.userId, req.user!.sub),
          ...(from ? [gte(coinLedger.createdAt, from)] : []),
        ),
      )
      .orderBy(sql`${coinLedger.createdAt} DESC`)
      // Период — выгрузка целиком, потолок здесь только чтобы не утащить базу в память.
      .limit(limit ?? (period ? 5_000 : 20));
    return reply.send(rows);
  });
}

/**
 * Что ретроначисление выдало бы прямо сейчас: граница, срезы, кому и сколько.
 *
 * 🔴 ОДНА функция на предпросмотр и на выдачу — по той же причине, по которой `replay` одна на
 * панель и на ретро: разойдись они, подтверждение показывало бы одни числа, а начислялись бы
 * другие, и доверия к кнопке не осталось бы никогда.
 */
async function planRetro(serverId: string, economy: ServerEconomy) {
  // 🔴 ВЕРХНЯЯ ГРАНИЦА (#124, Д1). Без неё ретро прогоняло и те вечера, за которые тикер уже
  // заплатил вживую, и люди получали за них ВТОРОЙ раз. Граница — `accrualSince`, момент первого
  // включения экономики. Её нет (ретро жмут до включения) — значит вживую ещё ничего не
  // начислялось, и берём всё до текущего мгновения.
  const until = retroCutoff(economy.accrualSince, new Date());
  const rows = await db
    .select({
      userId: voiceActivity.userId,
      seconds: voiceActivity.seconds,
      peers: voiceActivity.peers,
      muted: voiceActivity.muted,
      deafened: voiceActivity.deafened,
      away: voiceActivity.away,
      at: voiceActivity.createdAt,
    })
    .from(voiceActivity)
    .where(and(eq(voiceActivity.serverId, serverId), lt(voiceActivity.createdAt, until)))
    .orderBy(asc(voiceActivity.createdAt));

  // Отсекаем ещё раз, уже в коде: SQL-условие выше — оптимизация, а гарантия должна держаться там,
  // где её проверяет тест.
  const totals = replay(beforeCutoff(rows as ReplaySample[], until), economy);

  /**
   * 🔴 Кому ретро НЕ идёт (#124, В3). Начисление уважает «не участвую», а `moveCoins` — нет, и
   * ретро было единственным начислением, которое приходило человеку вопреки его выбору.
   *
   * Правило: **`optedOut` значит «не начислять мне», а не «отобрать то, что есть»**. Поэтому ретро
   * (это начисление за прошлое время) отказавшихся обходит, а доначисление при повышении ставки
   * (`rescale`) — нет: оно не заработок, а сохранение покупательной способности уже лежащих монет.
   *
   * ⚠️ И только ТЕКУЩИМ участникам. `replay` идёт по статистике присутствия, а она помнит и тех,
   * кто с тех пор ушёл или забанен. Кошелёк ушедшего живёт намеренно (вернётся — всё на месте), но
   * разовый подарок в день запуска — это про тех, кто на сервере в этот день.
   */
  const memberRows = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));
  const members = new Set(memberRows.map((r) => r.userId));

  const optedOutRows = await db
    .select({ userId: coinBalances.userId })
    .from(coinBalances)
    .where(and(eq(coinBalances.serverId, serverId), eq(coinBalances.optedOut, true)));
  const optedOut = new Set(optedOutRows.map((r) => r.userId));

  const earned = totals.filter((t) => t.coins > 0);
  const paid = earned.filter((t) => members.has(t.userId) && !optedOut.has(t.userId));
  // Пропущенных считаем и показываем: «почему мне не пришло» обязано иметь ответ, а тихая разница
  // между «начислено девятерым» и «людей на сервере одиннадцать» его не даёт.
  return { until, rows, samples: rows.length, paid, skipped: earned.length - paid.length };
}

/**
 * Сидит ли человек в деафене ПРЯМО СЕЙЧАС — по последнему минутному срезу присутствия.
 *
 * 🔴 Источник — `voice_activity`, а не presence напрямую: срез пишет тикер раз в минуту, и в нём
 * лежит ровно то состояние, по которому уже считается ставка голоса. Спросить второе место значило
 * бы завести вторую правду об одном и том же — а расходятся такие пары молча.
 *
 * ⚠️ Срез старше двух тактов не считаем деафеном. Гусь теперь ждёт сколько угодно, и его забирают в
 * том числе после выхода из голоса: там среза просто нет, и «нет данных» — это не «в деафене».
 * Ошибаться надо в сторону полной надбавки: недоплата за состояние, которого не было, — это спор,
 * который человек всегда выигрывает.
 */
async function deafenedNow(serverId: string, userId: string): Promise<boolean> {
  const [last] = await db
    .select({ deafened: voiceActivity.deafened, createdAt: voiceActivity.createdAt })
    .from(voiceActivity)
    .where(and(eq(voiceActivity.serverId, serverId), eq(voiceActivity.userId, userId)))
    .orderBy(desc(voiceActivity.createdAt))
    .limit(1);
  if (!last?.deafened) return false;
  return Date.now() - last.createdAt.getTime() <= 2 * SAMPLE_PERIOD_MS;
}

/** Имена для показа. Отдельно, потому что расчёт ретро именами не интересуется. */
async function namesOf(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

/**
 * Доначислить всем разницу, если время подорожало.
 *
 * 🔴 Требование (2026-08-30): «ползунки первый месяц я буду трогать часто, у людей из
 * кошельков ничего не должно испаряться».
 *
 * Цены у нас в МИНУТАХ, поэтому прайс переживает смену ставки сам. А балансы — в монетах, и тут
 * было три пути:
 *  - масштабировать симметрично: честно по покупательной способности, но при снижении ставки число
 *    в кошельке ПАДАЕТ. За месяц калибровки человек несколько раз увидит «было 500, стало 400», и
 *    никакое объяснение этого не отменит;
 *  - не трогать вовсе: число не падает, но при повышении ставки старые накопления молча дешевеют;
 *  - **компенсировать только вверх**: ползунок может ДОБАВИТЬ, но не отнять.
 *
 * 🔴 Выбран ВТОРОЙ как умолчание (`compensateOnRaise = false`), третий — тумблером. Причина в
 * словах «трогать буду часто»: при частой калибровке компенсация вверх раскручивает балансы
 * на качелях вверх-вниз, потому что вниз она не отыгрывает. Не трогать вовсе — единственный режим,
 * где число в кошельке не может уменьшиться И не может незаметно раздуться.
 *
 * Тумблер — для ОДНОГО осознанного крупного повышения, когда старые накопления иначе обесценятся
 * заметно. Каждое доначисление идёт в журнал строкой `rescale`, а ответ маршрута говорит, скольким
 * людям оно пришло: молча это происходить не должно.
 *
 * 🔴 `countsAsEarned` НЕ ставим: это не заработок. Иначе смена ползунка накручивала бы уровни и
 * место в сезонной таблице тем, кто просто оказался с большим балансом в нужный момент.
 *
 * ⚠️ Отказавшихся от участия и ушедших с сервера доначисление НЕ обходит, и это осознанно (#124,
 * В3): `optedOut` значит «не начислять мне», а не «пусть моё обесценится». Здесь не появляются
 * новые заработанные монеты — сохраняется покупательная способность уже лежащих. Ретро, наоборот,
 * отказавшихся обходит: оно как раз начисление.
 *
 * ⚠️ Работает ВНУТРИ транзакции вызывающей стороны (#124, Д5): и решение «подорожало ли время», и
 * все доначисления, и гашение тумблера обязаны быть неделимы. Шину не трогает — отдаёт наружу
 * список тех, кому надо разослать новый кошелёк после коммита.
 */
async function compensateRateRise(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  serverId: string,
  before: number | undefined,
  after: number,
): Promise<{ sum: number; userIds: string[] }> {
  if (!before || before <= 0 || after <= before) return { sum: 0, userIds: [] };

  const rows = await tx
    .select({ userId: coinBalances.userId, balance: coinBalances.balance })
    .from(coinBalances)
    .where(and(eq(coinBalances.serverId, serverId), gt(coinBalances.balance, 0)));

  let sum = 0;
  const userIds: string[] = [];
  for (const r of rows) {
    const add = raiseCompensation(r.balance, before, after);
    if (add <= 0) continue;
    await applyCoins(tx, {
      serverId,
      userId: r.userId,
      amount: add,
      reason: 'rescale',
      data: { rateBefore: before, rateAfter: after },
    });
    sum += add;
    userIds.push(r.userId);
  }
  return { sum, userIds };
}

/**
 * ⚠️ Копия умолчаний, что жила здесь, УДАЛЕНА (04.09). Она успела разойтись с боевыми — держала
 * потолок 400, когда в схеме уже стояло 800, — и тихо считала предпросмотр не по тем числам, что
 * применились бы. Умолчания теперь ровно одни: `economyDefaults`, читающий их из самой схемы.
 */
