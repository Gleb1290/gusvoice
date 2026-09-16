import { and, eq, gte, sql } from 'drizzle-orm';
import type { ServerEconomy } from './coins.js';
import { dayStart } from './coinRules.js';
import { db } from './db/index.js';
import { coinPurchases, serverShop, serverSoundboard } from './db/schema.js';
import { SHOP_CATALOG, SHOP_ITEMS, avatarMinutesFor, priceCoins, type ShopItem } from './shopRules.js';
import { avatarPriceMinutes } from './instanceSettings.js';

/**
 * Витрина магазина: каталог с ценами — хранилище и склейка с умолчаниями.
 *
 * Правила и арифметика — в `shopRules.ts`, здесь только база. Разделение то же, что у начисления
 * (`coinRules` / `coins`) и перевода: цена награды — это чужие деньги, и считать её должно то, что
 * проверяется тестом.
 */

export interface ShopEntry {
  item: ShopItem;
  label: string;
  hint: string;
  /** Цена в минутах сидения — то, что хранится и что крутит владелец. */
  priceMinutes: number;
  /** Она же в монетах по ТЕКУЩЕЙ ставке — то, что видит человек. */
  priceCoins: number;
  enabled: boolean;
  target: 'user' | 'none' | 'channel';
  /**
   * Разброс РЕАЛЬНЫХ цен, если у награды они свои у каждого экземпляра (сейчас только саундборд).
   *
   * 🔴 Без него витрина ВРАЛА: она показывала общую цену каталога (8 минут = 16 монет), тогда как у
   * каждого звука своя, и человек видел одно число, а платил другое (замечание 03.09).
   * ⚠️ Общая цена при этом остаётся и остаётся нужной: по ней идут звуки, которым свою не назначали.
   */
  priceRange?: { minCoins: number; maxCoins: number };
  /**
   * Пол цены — только у аватара: цена инстанса, ниже которой сервер опуститься не может (14.09).
   * ⚠️ Отдаётся и в монетах: панель показывает его владельцу, а пересчитывать на клиенте нельзя.
   */
  floor?: { minutes: number; coins: number };
  /** Своя цена сервера, если владелец её назначил; `null` — действует пол инстанса. Только аватар. */
  serverMinutes?: number | null;
}

/**
 * Каталог сервера.
 *
 * ⚠️ Строки в базе может не быть — тогда берём умолчание из `SHOP_CATALOG`. Так магазин работает на
 * свежем сервере без единой настройки, и turnkey-инстансу не нужно ничего заполнять руками.
 */
export async function shopFor(economy: ServerEconomy | null): Promise<ShopEntry[]> {
  const rows = economy
    ? await db.select().from(serverShop).where(eq(serverShop.serverId, economy.serverId))
    : [];
  const byItem = new Map(rows.map((r) => [r.item, r]));
  const rate = economy?.ratePer5min ?? 0;
  /**
   * 🔴 Цена анимированного аватара — ДВЕ ступени (14.09): пол задаёт держатель инстанса (02.09 —
   * аватар единственный расходует хранилище и трафик постоянно, и платит за это он), а владелец
   * сервера вправе наценить сверху. Считает `avatarMinutesFor`, здесь только склейка.
   * В минутах — потому что минуты значат одно и то же на любом сервере, а монеты нет; поэтому и пол,
   * и наценка переживают сдвиг ставки вместе и разойтись не могут.
   * ⚠️ Раньше строка сервера для аватара игнорировалась ЦЕЛИКОМ — чтобы владелец не ушёл ниже
   * инстанса. Пол через `max` закрывает то же опасение, не отнимая права наценить.
   */
  const avatarFloorMinutes = await avatarPriceMinutes();

  /**
   * Цены КЛИПОВ саундборда — чтобы витрина показала разброс, а не одно общее число.
   * ⚠️ Клипу без своей цены считаем общую: он по ней и стреляет.
   * 🔴 Своя цена клипа хранится уже В МОНЕТАХ (миграция 0057), общая — в минутах, как весь прайс.
   * Поэтому пересчёт применяется ТОЛЬКО к запасной: применив его к своей, мы бы умножили монеты на
   * ставку и получили цену, которой нигде нет.
   */
  const soundboardFallbackCoins = priceCoins(
    byItem.get('soundboard')?.priceMinutes ?? SHOP_CATALOG.soundboard.defaultMinutes,
    rate,
  );
  const clipCoins: number[] = economy
    ? (await db
        .select({ priceCoins: serverSoundboard.priceCoins })
        .from(serverSoundboard)
        .where(eq(serverSoundboard.serverId, economy.serverId))
      ).map((c) => c.priceCoins ?? soundboardFallbackCoins)
    : [];

  return SHOP_ITEMS.map((key) => {
    const spec = SHOP_CATALOG[key];
    const row = byItem.get(key);
    const isAvatar = key === 'animated-avatar';
    const priceMinutes = isAvatar
      ? avatarMinutesFor(avatarFloorMinutes, row?.priceMinutes)
      : (row?.priceMinutes ?? spec.defaultMinutes);
    return {
      item: key,
      label: spec.label,
      hint: spec.hint,
      priceMinutes,
      priceCoins: priceCoins(priceMinutes, rate),
      enabled: row?.enabled ?? true,
      target: spec.target,
      ...(key === 'soundboard' && clipCoins.length > 0
        ? { priceRange: { minCoins: Math.min(...clipCoins), maxCoins: Math.max(...clipCoins) } }
        : {}),
      ...(isAvatar
        ? {
            floor: { minutes: avatarFloorMinutes, coins: priceCoins(avatarFloorMinutes, rate) },
            serverMinutes: row?.priceMinutes ?? null,
          }
        : {}),
    };
  });
}

/**
 * Сколько таких наград человек ПОЛУЧИЛ за сегодня.
 *
 * 🔴 Защита получателя, а не отправителя (план, этап 3: «свой суточный предел на получателя»). Цена
 * сдерживает кошельком, но у того, кто много сидит, монет всегда достаточно; а МЕГА пок вмешивается
 * в чужой экран и звук. Считаем по чекам — отдельного счётчика заводить незачем, `coin_purchases`
 * уже знает точный ответ.
 */
export async function receivedToday(serverId: string, item: ShopItem, userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(coinPurchases)
    .where(
      and(
        eq(coinPurchases.serverId, serverId),
        eq(coinPurchases.item, item),
        eq(coinPurchases.targetUserId, userId),
        gte(coinPurchases.createdAt, dayStart(now)),
      ),
    );
  return row?.n ?? 0;
}
