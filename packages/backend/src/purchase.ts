import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { coinBalances, coinLedger, coinPurchases } from './db/schema.js';
import type { ShopItemSpec } from './shopRules.js';
import { id } from './util.js';

/**
 * Покупка награды — ОДНОЙ транзакцией с блокировкой кошелька.
 *
 * 🔴 Писано по тем же граблям, что и `transferCoins.ts` (#123/#124): проверка баланса и списание
 * обязаны быть неразделимы. Прочитай баланс снаружи, реши «хватает» и спиши третьим запросом — и
 * два одновременных нажатия купят обе награды по одному и тому же старому числу, а баланс уйдёт в
 * минус. Здесь состояние перечитывается ВНУТРИ блокировки, и только потом меняется.
 *
 * 🔴 Чек пишется в той же транзакции. Списать монеты и не записать, за что, — это ровно тот случай,
 * ради которого журнал и заводился: «было 500, стало 410» без ответа.
 */

export type PurchaseBlock = 'poor';

export interface PurchaseInput {
  serverId: string;
  userId: string;
  item: ShopItemSpec;
  /** Кому адресована награда; `null` для безадресных. */
  targetUserId: string | null;
  /** Цена в монетах — уже посчитана сервером по текущей ставке. */
  price: number;
  /** Цена в минутах и ставка на момент сделки — идут в чек. */
  priceMinutes: number;
  ratePer5min: number;
  /** Полезная нагрузка награды (текст сообщения и т.п.). */
  data?: Record<string, unknown>;
  /** Момент покупки. ⚠️ Аргументом: часов внутри модуля нет. */
  now: Date;
}

export interface PurchaseResult {
  /** Причина отказа или `null`, если покупка состоялась. */
  block: PurchaseBlock | null;
  /** Идентификатор чека. */
  purchaseId: string;
  /** Баланс после списания. */
  balance: number;
  /** До какого момента действует награда; `null` у расходников. */
  expiresAt: Date | null;
}

export async function buyItem(i: PurchaseInput): Promise<PurchaseResult> {
  return db.transaction(async (tx) => {
    // Строку кошелька создаём САМИ: `FOR UPDATE` блокирует только существующие, а покупатель может
    // ещё ни разу не попасть в кошельки (та же грабля, что укусила в переводе).
    await tx.insert(coinBalances).values({ serverId: i.serverId, userId: i.userId }).onConflictDoNothing();
    const [wallet] = await tx
      .select({ balance: coinBalances.balance })
      .from(coinBalances)
      .where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.userId)))
      .limit(1)
      .for('update');

    // Перепроверяем ПОД блокировкой, а не доверяем тому, что прочитал маршрут до неё.
    if (!wallet || wallet.balance < i.price) {
      return { block: 'poor' as const, purchaseId: '', balance: wallet?.balance ?? 0, expiresAt: null };
    }

    const [updated] = await tx
      .update(coinBalances)
      .set({ balance: sql`${coinBalances.balance} - ${i.price}` })
      .where(and(eq(coinBalances.serverId, i.serverId), eq(coinBalances.userId, i.userId)))
      .returning({ balance: coinBalances.balance });

    // ⚠️ `earnedTotal` и `seasonEarned` не трогаем: трата — не заработок, и уровни с таблицей
    // лидеров от покупок двигаться не должны ни в какую сторону.
    const purchaseId = id();
    const expiresAt =
      i.item.durationMinutes > 0 ? new Date(i.now.getTime() + i.item.durationMinutes * 60_000) : null;

    await tx.insert(coinPurchases).values({
      id: purchaseId,
      serverId: i.serverId,
      userId: i.userId,
      item: i.item.key,
      priceMinutes: i.priceMinutes,
      priceCoins: i.price,
      ratePer5min: i.ratePer5min,
      targetUserId: i.targetUserId,
      data: i.data ?? {},
      expiresAt,
    });

    await tx.insert(coinLedger).values({
      id: id(),
      serverId: i.serverId,
      userId: i.userId,
      amount: -i.price,
      reason: `shop.${i.item.key}`,
      refUserId: i.targetUserId ?? undefined,
      // Чек лежит и в журнале: человек смотрит именно туда, когда спрашивает «куда делись монеты».
      data: { purchaseId, priceMinutes: i.priceMinutes, ratePer5min: i.ratePer5min },
    });

    return { block: null, purchaseId, balance: updated?.balance ?? 0, expiresAt };
  });
}
