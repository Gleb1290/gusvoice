import { replay, seasonId, seasonRange, type EconomySettings, type ReplaySample, type SeasonLength } from './coinRules.js';

/**
 * Разовый перерасчёт сезона по правилу «один — затухание не бьёт» (28.10) — ЧИСТЫЕ правила.
 * Обвязка с базой — `aloneRecount.ts`.
 *
 * Старое правило тратило затухание и на время одному: кто днём ждал компанию один, к вечеру в компании
 * получал заметно меньше пришедших сразу. Владелец решил доначислить разницу за текущий сезон.
 */

/** Вид перерасчёта в `coin_recounts.kind` — по одной строке на человека и вид. */
export const ALONE_RECOUNT_KIND = 'alone-2026-10';

/**
 * Окно перерасчёта: от начала сезона, в котором лежит смена правила, до самой смены.
 *
 * 🔴 Верхняя граница — момент применения миграции `0158_alone_cap.sql` (`cutoff`), а НЕ «сейчас»: после
 * смены правила тикер уже платит по новому, и пересчитать эти срезы значило бы заплатить дважды.
 * ⚠️ Нижняя граница не раньше `accrualSince` (первое включение экономики): срезы до него вживую не
 * оплачивались вовсе — их закрывает ретро, и доплата «разницы» за них была бы подарком сверх ретро.
 * Экономику ни разу не включали — окна нет.
 */
export function recountWindow(
  cutoff: Date,
  length: SeasonLength,
  accrualSince: Date | null | undefined,
): { from: Date; to: Date; seasonId: string } | null {
  if (!accrualSince) return null;
  const season = seasonId(cutoff, length);
  const seasonFrom = seasonRange(season).from;
  const from = accrualSince > seasonFrom ? accrualSince : seasonFrom;
  if (from >= cutoff) return null;
  return { from, to: cutoff, seasonId: season };
}

/** Кому сколько доначислить. */
export interface RecountDiff {
  userId: string;
  /** Новое минус старое, монеты; всегда > 0. */
  amount: number;
  /** По новому и по старому правилу — для журнала (`data`). */
  coinsNew: number;
  coinsOld: number;
}

/**
 * Разница «новое правило минус старое» на одних и тех же срезах с одними и теми же (текущими)
 * настройками. 🔴 Только положительная: у кого по новому правилу вышло меньше, ничего не забираем.
 * ⚠️ Срезы — по возрастанию времени (как у `replay`), отсечь окно — дело вызывающего.
 */
export function recountDiffs(samples: ReplaySample[], s: EconomySettings): RecountDiff[] {
  const legacy = new Map(replay(samples, s, 'legacy').map((t) => [t.userId, t.coins]));
  const out: RecountDiff[] = [];
  for (const t of replay(samples, s, 'v2')) {
    const coinsOld = legacy.get(t.userId) ?? 0;
    const amount = t.coins - coinsOld;
    if (amount > 0) out.push({ userId: t.userId, amount, coinsNew: t.coins, coinsOld });
  }
  return out.sort((a, b) => b.amount - a.amount || a.userId.localeCompare(b.userId));
}
