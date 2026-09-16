import { previewAllows } from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { streakReward, streakStep } from './streakRules.js';
import {
  accrue,
  rollPeriods,
  seasonBump,
  seasonId,
  type AccrualSample,
  type EconomySettings,
  type SeasonLength,
} from './coinRules.js';
import { db } from './db/index.js';
import { coinBalances, coinLedger, serverEconomy } from './db/schema.js';
import { env } from './env.js';
import { publishToUser } from './realtime.js';
import { id } from './util.js';

/**
 * Начисление ГусКоинов — база и обвязка. Вся арифметика в `coinRules.ts`, здесь только хранилище.
 *
 * План — `docs/guscoins-plan.md`, зонтик — #117.
 */

/** Настройки экономики сервера + признак, что она вообще включена. */
export interface ServerEconomy extends EconomySettings {
  serverId: string;
  enabled: boolean;
  currencyName: string;
  iconUrl: string | null;
  tipAmount: number;
  tipTaxPercent: number;
  tipDailyOut: number;
  tipDailyIn: number;
  tipDailyPair: number;
  retroGrantedAt: Date | null;
  /** Момент первого включения — граница «ретро / живое начисление» (#124, Д1). */
  accrualSince: Date | null;
  /** Длина сезона: времена года или месяц. */
  seasonLength: SeasonLength;
  gooseBonus: number;
  gooseMinutes: number;
  /** Надбавка за гуся, пойманного в деафене (миграция 0058). */
  gooseDeafenedBonus: number;
  streakBonus: number;
}

type EconomyRow = typeof serverEconomy.$inferSelect;

/** Строка настроек → рабочий объект. Отдельной функцией, чтобы форма была в одном месте. */
export function toEconomy(row: EconomyRow): ServerEconomy {
  return {
    serverId: row.serverId,
    enabled: row.enabled,
    currencyName: row.currencyName,
    iconUrl: row.iconUrl,
    ratePer5min: row.ratePer5min,
    alonePercent: row.alonePercent,
    companyPercent: row.companyPercent,
    dailyCap: row.dailyCap,
    decayAfterMinutes: row.decayAfterMinutes,
    decayPercent: row.decayPercent,
    mutedPercent: row.mutedPercent,
    deafenedPercent: row.deafenedPercent,
    awayPercent: row.awayPercent,
    payoutMinutes: row.payoutMinutes,
    compensateOnRaise: row.compensateOnRaise,
    tipAmount: row.tipAmount,
    tipTaxPercent: row.tipTaxPercent,
    tipDailyOut: row.tipDailyOut,
    tipDailyIn: row.tipDailyIn,
    tipDailyPair: row.tipDailyPair,
    retroGrantedAt: row.retroGrantedAt,
    accrualSince: row.accrualSince,
    seasonLength: row.seasonLength,
    gooseBonus: row.gooseBonus,
    gooseMinutes: row.gooseMinutes,
    gooseDeafenedBonus: row.gooseDeafenedBonus,
    streakBonus: row.streakBonus,
  };
}

/** Настройки нескольких серверов разом (нужно тикеру: за срез он трогает сразу много серверов). */
export async function economyFor(serverIds: string[]): Promise<Map<string, ServerEconomy>> {
  const out = new Map<string, ServerEconomy>();
  if (serverIds.length === 0) return out;
  const rows = await db.select().from(serverEconomy).where(inArray(serverEconomy.serverId, serverIds));
  for (const row of rows) out.set(row.serverId, toEconomy(row));
  return out;
}

/** Настройки одного сервера; строки нет — значит экономика выключена и всё по умолчанию. */
export async function economyOf(serverId: string): Promise<ServerEconomy | null> {
  const [row] = await db.select().from(serverEconomy).where(eq(serverEconomy.serverId, serverId)).limit(1);
  return row ? toEconomy(row) : null;
}

/**
 * Настройки сервера ГЛАЗАМИ КОНКРЕТНОГО ЧЕЛОВЕКА — с учётом закрытого показа (#117).
 *
 * 🔴 Возвращает `null` тому, кого нет в списке допуска, ровно как если бы экономики на сервере не
 * было вовсе. Отдельного «вам нельзя» наружу нет намеренно: пока фича под NDA, её отсутствие
 * должно быть неотличимо от выключенной экономики, иначе сам отказ и выдаёт, что она существует.
 *
 * ⚠️ Ставить это ВМЕСТО `economyOf` во всех маршрутах нельзя: управление (ползунки,
 * ретроначисление) закрыто правом `MANAGE_ECONOMY` и работает со сервером, а не с собой. Здесь
 * гейт для того, что человек ВИДИТ и ТРАТИТ.
 */
export async function economySeenBy(serverId: string, userId: string): Promise<ServerEconomy | null> {
  if (!previewAllows(env.economyPreviewUsers, userId)) return null;
  return economyOf(serverId);
}

/** Транзакция (или сам `db`) — всё денежное умеет работать и там, и там. */
type Tx = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * Взять кошелёк ПОД БЛОКИРОВКОЙ, заведя строку, если её ещё нет.
 *
 * 🔴 Порядок важен: `FOR UPDATE` блокирует только СУЩЕСТВУЮЩИЕ строки, поэтому сначала вставка
 * (`onConflictDoNothing` — гонка двух срезов на одного новичка обычное дело), и только потом
 * блокировка. Обратный порядок однажды уже стоил бага: первый тип новому человеку возвращал «не
 * хватает монет», потому что блокировать было нечего.
 */
async function lockWallet(tx: Tx, serverId: string, userId: string) {
  await tx.insert(coinBalances).values({ serverId, userId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(coinBalances)
    .where(and(eq(coinBalances.serverId, serverId), eq(coinBalances.userId, userId)))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Длина сезона сервера — нужна, чтобы поставить ПРАВИЛЬНУЮ метку при движении монет.
 * ⚠️ Строки настроек может не быть (экономику ещё не сохраняли): тогда квартальная, как в схеме.
 */
async function seasonLengthOf(tx: Tx, serverId: string): Promise<SeasonLength> {
  const [row] = await tx
    .select({ seasonLength: serverEconomy.seasonLength })
    .from(serverEconomy)
    .where(eq(serverEconomy.serverId, serverId))
    .limit(1);
  return row?.seasonLength ?? 'quarter';
}

export interface CreditInput {
  serverId: string;
  userId: string;
  sample: AccrualSample;
  economy: ServerEconomy;
  now: Date;
}

/**
 * Начислить за один срез присутствия. Возвращает, сколько монет реально ушло человеку.
 *
 * ⚠️ Запись в журнал только когда монеты действительно начислены. Строки «плюс ноль» ничего не
 * объясняют, а журнал должен читаться человеком, который разбирается, куда делись его монеты.
 */
export async function creditVoice(i: CreditInput): Promise<number> {
  const coins = await db.transaction(async (tx) => creditVoiceTx(tx, i));
  // 🔴 Шина — ПОСЛЕ коммита. Отправь событие изнутри транзакции — и при откате человек увидел бы
  // число, которого в базе нет.
  if (coins > 0) await pushWallet(i.serverId, i.userId);
  return coins;
}

async function creditVoiceTx(tx: Tx, i: CreditInput): Promise<number> {
  const wallet = await lockWallet(tx, i.serverId, i.userId);
  if (!wallet || wallet.optedOut) return 0;

  const rolled = rollPeriods(
    {
      day: wallet.day,
      seasonId: wallet.seasonId,
      secondsToday: wallet.secondsToday,
      earnedToday: wallet.earnedToday,
      seasonEarned: wallet.seasonEarned,
    },
    i.now,
    // Разбивка сезона — из настроек сервера: помесячная меняет идентификатор, а значит и момент,
    // когда сезонный счётчик обнулится.
    i.economy.seasonLength,
  );
  // ⚠️ `pendingMilli`/`pendingSeconds` идут в расчёт МИМО `rollPeriods`: полночь их не трогает.
  // Это и есть заморозка — накопленное недосиженного отрезка переживает и смену суток, и уход.
  const { coins, next, breakdown } = accrue(
    i.sample,
    {
      ...rolled,
      pendingMilli: wallet.pendingMilli,
      pendingSeconds: wallet.pendingSeconds,
      baseMilli: wallet.baseMilli,
      deltaPresenceMilli: wallet.deltaPresenceMilli,
      deltaCompanyMilli: wallet.deltaCompanyMilli,
      deltaDecayMilli: wallet.deltaDecayMilli,
    },
    i.economy,
  );

  const dayRolled = rolled.day !== wallet.day;
  const seasonRolled = rolled.seasonId !== wallet.seasonId;

  /**
   * Стрик — В ТОЙ ЖЕ транзакции и по тем же суткам, что и начисление (план, модель F).
   *
   * 🔴 Считается от `rolled.day`, а не от `dayKey(now)` напрямую: перекат суток уже произошёл выше,
   * и взять день из другого источника значило бы завести второе мнение о том, какой сегодня день.
   * Разъехались бы они ровно на границе полуночи — там, где стрик и решается.
   *
   * ⚠️ Начисляется ДАЖЕ когда за этот срез монет не набежало (`coins === 0`): человек в канале, а
   * значит день ему засчитан. Привяжи мы бонус к выплате, стрик рвался бы у того, кто зашёл на
   * пять минут, — то есть ровно у того, кого регулярность и должна поощрять.
   */
  const streak = streakStep({ streakDay: wallet.streakDay, streakDays: wallet.streakDays }, rolled.day);
  const streakCoins = streakReward(streak.rewardDays, i.economy.streakBonus);

  await tx
    .update(coinBalances)
    .set({
      // 🔴 ИНКРЕМЕНТАМИ, а не «прочитанное + начисленное» (#124, Д2). Абсолютная запись поверх
      // незаблокированного чтения стирала всё, что закоммитилось между чтением и записью: тик
      // возвращал отправителю только что отданный тип, а получателю стирал полученный. Окно
      // миллисекундное, но открывалось КАЖДУЮ МИНУТУ у каждого сидящего в голосе, а типы ходят
      // ровно между теми же людьми. Блокировка выше это уже закрывает; инкременты — второй слой,
      // на случай будущего писателя, который про блокировку забудет.
      balance: sql`${coinBalances.balance} + ${coins + streakCoins}`,
      // Стрик — свой источник дохода наравне с голосом: он растит и общий счёт, и сезонный.
      earnedTotal: sql`${coinBalances.earnedTotal} + ${coins + streakCoins}`,
      // ⚠️ На границе сезона счётчик обнуляется, поэтому там запись абсолютная — иначе прошлый
      // сезон утёк бы в новый.
      seasonEarned: seasonRolled
        ? coins + streakCoins
        : sql`${coinBalances.seasonEarned} + ${coins + streakCoins}`,
      streakDay: streak.next.streakDay,
      streakDays: streak.next.streakDays,
      seasonId: rolled.seasonId,
      // Курсоры накопления считает только начисление, и считает от прочитанного ПОД БЛОКИРОВКОЙ
      // состояния — здесь абсолютная запись и есть правильная.
      pendingMilli: next.pendingMilli,
      pendingSeconds: next.pendingSeconds,
      baseMilli: next.baseMilli,
      deltaPresenceMilli: next.deltaPresenceMilli,
      deltaCompanyMilli: next.deltaCompanyMilli,
      deltaDecayMilli: next.deltaDecayMilli,
      day: rolled.day,
      secondsToday: next.secondsToday,
      // 🔴 Общее время — ИНКРЕМЕНТОМ и без всяких сбросов: это основа уровня, и обнулить его нельзя
      // ни полночью, ни сменой сезона, ни отказом от участия.
      secondsTotal: sql`${coinBalances.secondsTotal} + ${Math.max(0, Math.floor(i.sample.seconds))}`,
      earnedToday: next.earnedToday,
      // ⚠️ Суточные счётчики типов трогаем ТОЛЬКО на смене суток. Раньше сюда писалось прочитанное
      // значение — то есть тик откатывал `givenToday` соседнего типа и тихо возвращал человеку уже
      // потраченный за сутки лимит.
      ...(dayRolled ? { givenToday: 0, receivedToday: 0 } : {}),
    })
    .where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.userId)));

  // ⚠️ Журнал — В ТОЙ ЖЕ транзакции, что и кошелёк (#124, С4). Раздельно они разъезжались при
  // падении между двумя запросами: деньги есть, строки нет — и журнал молчит ровно в том случае,
  // ради которого он заведён.
  if (coins > 0) {
    await tx.insert(coinLedger).values({
      id: id(),
      serverId: i.serverId,
      userId: i.userId,
      amount: coins,
      reason: 'voice',
      // 🔴 Разбор, а не только сумма: без него на вопрос «почему у Пети больше» ответить нечем,
      // а молчаливо урезанное начисление читается как поломка (#121).
      data: { ...breakdown },
    });
  }
  /**
   * ⚠️ Стрик — ОТДЕЛЬНАЯ строка журнала, а не прибавка к строке голоса. Смешай их, и разбор
   * начисления перестал бы сходиться с суммой: он объясняет минуты, а стрик про минуты ничего не
   * знает. Своя причина и своя строка отвечают на «откуда взялись эти монеты» одним взглядом.
   */
  if (streakCoins > 0) {
    await tx.insert(coinLedger).values({
      id: id(),
      serverId: i.serverId,
      userId: i.userId,
      amount: streakCoins,
      reason: 'streak',
      data: { days: streak.rewardDays },
    });
  }
  return coins + streakCoins;
}

/**
 * Разослать собственным подключениям человека его новый кошелёк.
 *
 * ⚠️ Перечитываем строку, а не собираем снимок из локальных переменных: между расчётом и записью
 * баланс мог измениться другой операцией (входящий тип, выдача модератора). Число, которое человек
 * увидит, обязано быть тем, что реально лежит в базе, — иначе анимация покажет одно, а кошелёк
 * другое.
 * ⚠️ Ошибку глотаем: шина — это удобство, а не источник правды. Не доехало событие — число
 * поправится при следующем изменении или при перезапросе по возврату фокуса.
 */
export async function pushWallet(serverId: string, userId: string): Promise<void> {
  try {
    const w = await walletOf(serverId, userId);
    await publishToUser(userId, {
      t: 'economy.wallet',
      serverId,
      balance: w.balance,
      earnedTotal: w.earnedTotal,
      seasonEarned: w.seasonEarned,
    });
  } catch {
    /* шина недоступна — число догонит следующим событием */
  }
}

export interface MoveCoinsInput {
  serverId: string;
  userId: string;
  amount: number;
  reason: string;
  refUserId?: string;
  data?: Record<string, unknown>;
  /**
   * Длина сезона этого сервера. Не передали — прочитаем сами (один select по ключу): метку сезона
   * ставит эта функция, и ошибиться разбивкой значит обнулить людям счётчик.
   */
  seasonLength?: SeasonLength;
  /**
   * Растить ли `earnedTotal`/`seasonEarned`.
   *
   * 🔴 По умолчанию НЕТ, и это главное правило движения монет: входящие типы и выдачи модератора
   * пополняют только кошелёк. Иначе уровни и место в таблице лидеров покупаются переводом с альта —
   * ровно то, ради чего альтов и заводят.
   */
  countsAsEarned?: boolean;
}

/**
 * Изменить баланс и записать это в журнал — ОДНОЙ транзакцией. Возвращает новый баланс.
 *
 * ⚠️ Для вызова изнутри чужой транзакции есть `applyCoins`: ретроначисление гоняет его по всем
 * людям сразу, чтобы упавшее на середине не оставляло половину сервера с монетами, а половину без
 * (#124, С5).
 */
/**
 * Забранный бонус гуся: монеты И счётчик пойманных бонусов — ОДНОЙ транзакцией.
 *
 * ⚠️ Счётчик `bonusClaims` — статистика пойманных гусей. В уровень он больше НЕ входит (с 03.09
 * уровень считается от заработанных монет одной шкалой, `levelRules`), но пишется по-прежнему одной
 * транзакцией с монетами: разошедшиеся «монеты есть, гуся в счётчике нет» никто потом не сверит.
 *
 * ⚠️ `countsAsEarned` здесь ОБЯЗАН быть истиной: гусь — свой источник дохода наравне с голосом
 * (план, «earned_total растёт только от своих источников»). Входящие типы им не считаются, а гусь
 * считается — его нельзя занести с альта.
 */
export async function claimGooseBonus(serverId: string, userId: string, amount: number): Promise<number> {
  const balance = await db.transaction(async (tx) => {
    const next = await applyCoins(tx, { serverId, userId, amount, reason: 'goose', countsAsEarned: true });
    await tx
      .update(coinBalances)
      .set({ bonusClaims: sql`${coinBalances.bonusClaims} + 1` })
      .where(and(eq(coinBalances.serverId, serverId), eq(coinBalances.userId, userId)));
    return next;
  });
  await pushWallet(serverId, userId);
  return balance;
}

export async function moveCoins(i: MoveCoinsInput): Promise<number> {
  const balance = await db.transaction(async (tx) => applyCoins(tx, i));
  await pushWallet(i.serverId, i.userId);
  return balance;
}

/**
 * Ядро движения монет внутри уже открытой транзакции: кошелёк и журнал вместе, иначе никак.
 *
 * ⚠️ Шину здесь НЕ дёргаем — она живёт за коммитом, у вызывающей стороны.
 */
export async function applyCoins(tx: Tx, i: MoveCoinsInput): Promise<number> {
  const wallet = await lockWallet(tx, i.serverId, i.userId);
  if (!wallet) return 0;
  const earned = i.countsAsEarned ? Math.max(0, i.amount) : 0;
  /**
   * 🔴 Метка сезона ставится ЗДЕСЬ, а не только в тикере голоса (04.09).
   *
   * Раньше `season_earned` рос, а `season_id` оставался пустым — и таблица лидеров, которая
   * фильтрует по метке, не показывала человека вовсе; а первый же тик голоса видел «сезон сменился»
   * и обнулял счётчик, стирая ретро из сезонного зачёта. Разбор — в шапке `seasonBump`.
   * ⚠️ Длину сезона берём у сервера: при помесячной разбивке метка другая, и поставить квартальную
   * значило бы обнулить всем счётчик первого числа месяца.
   */
  const length = i.seasonLength ?? (await seasonLengthOf(tx, i.serverId));
  const bump = seasonBump(wallet.seasonId, seasonId(new Date(), length), wallet.seasonEarned, earned);
  const [updated] = await tx
    .update(coinBalances)
    .set({
      balance: sql`${coinBalances.balance} + ${i.amount}`,
      earnedTotal: sql`${coinBalances.earnedTotal} + ${earned}`,
      seasonId: bump.seasonId,
      seasonEarned: bump.seasonEarned,
    })
    .where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.userId)))
    .returning({ balance: coinBalances.balance });
  await tx.insert(coinLedger).values({
    id: id(),
    serverId: i.serverId,
    userId: i.userId,
    amount: i.amount,
    reason: i.reason,
    refUserId: i.refUserId,
    data: i.data ?? {},
  });
  return updated?.balance ?? 0;
}

/** Кошелёк человека для показа. Строки может не быть — тогда всё по нулям. */
export async function walletOf(serverId: string, userId: string) {
  const [row] = await db
    .select()
    .from(coinBalances)
    .where(and(eq(coinBalances.serverId, serverId), eq(coinBalances.userId, userId)))
    .limit(1);
  return (
    row ?? {
      serverId,
      userId,
      balance: 0,
      earnedTotal: 0,
      seasonEarned: 0,
      seasonId: '',
      pendingMilli: 0,
      pendingSeconds: 0,
      baseMilli: 0,
      deltaPresenceMilli: 0,
      deltaCompanyMilli: 0,
      deltaDecayMilli: 0,
      day: '',
      secondsToday: 0,
      secondsTotal: 0,
      bonusClaims: 0,
      recognitionTippers: 0,
      recognitionToday: 0,
      earnedToday: 0,
      givenToday: 0,
      receivedToday: 0,
      optedOut: false,
      tipsOptOut: false,
    }
  );
}
