/**
 * Инстанс-ручки ЭКОНОМИКИ: то, что решает держатель железа, а не владелец сервера.
 *
 * 🔴 **Появились ради цены анимированного аватара** (решение 02.09). Он единственный в
 * каталоге расходует инфраструктуру ПОСТОЯННО — мегабайтный файл отдаётся каждому зрителю, — а
 * платит за это держатель инстанса. Всё остальное в экономике посерверное и таким остаётся.
 *
 * 🔴 **Цена в МИНУТАХ сидения, а не в монетах**. Минуты значат одно и то же на любом
 * сервере, монеты — нет: у каждого своя ставка. Держатель называет цену в человеческом времени —
 * «аватар стоит двадцать часов», — и каждый сервер переводит её в свои монеты сам. Владелец сервера
 * при этом не может её обесценить ставкой: поднимет ставку — вместе с доходом подорожает и аватар.
 *
 * ⚠️ **Честная граница приёма.** Владелец сервера управляет не только ставкой, но и ДОХОДОМ
 * (множители компании, затухание, потолок). Раздует множители — «двадцать часов» наберутся за
 * четыре. Ничто, выраженное в валюте сервера, нельзя защитить от того, кто этой валютой управляет.
 * Настоящая инфраструктурная защита — жёсткие пределы файла (1 МБ, 240 кадров) в
 * `packages/shared/src/animatedAvatar.ts`; цена здесь — защита социальная, «не раздавать даром».
 *
 * ⚠️ Живёт в УЖЕ существующей таблице `instance_settings` (миграция 0022, там же настройки почты),
 * а не в своей: заводить вторую таблицу того же назначения — верный способ развести их со временем.
 */
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { instanceSettings } from './db/schema.js';
import { SHOP_CATALOG } from './shopRules.js';

/** Ключ в `instance_settings`. Рядом с `smtp`, формат тот же — JSON-значение. */
export const ECONOMY_KEY = 'economy';

/** Потолок инстанс-цены. Защита от опечатки в форме, а не экономическое решение. */
export const INSTANCE_PRICE_MAX_MINUTES = 100_000;

/**
 * ⚠️ `Record<string, unknown>` в основе намеренно: колонка `value` в `instance_settings` — jsonb, и
 * drizzle требует именно такой формы. Именованные поля рядом дают подсказки в редакторе.
 */
type InstanceEconomy = Record<string, unknown> & {
  /** Цена анимированного аватара в минутах сидения. */
  avatarPriceMinutes?: number;
};

async function read(): Promise<InstanceEconomy> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, ECONOMY_KEY))
    .limit(1);
  return (row?.value as InstanceEconomy | undefined) ?? {};
}

/**
 * Цена анимированного аватара в минутах сидения.
 *
 * ⚠️ Значения нет — берём умолчание каталога: свежий turnkey обязан работать без единой настройки.
 * ⚠️ Мусор трактуем как отсутствие, а не как ноль: ноль означает «даром», и его надо поставить
 * осознанно, а не получить из битого значения.
 */
export async function avatarPriceMinutes(): Promise<number> {
  const fallback = SHOP_CATALOG['animated-avatar'].defaultMinutes;
  const v = (await read()).avatarPriceMinutes;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

/** Записать цену. Вызывать ТОЛЬКО из маршрута, закрытого супер-админом инстанса. */
export async function setAvatarPriceMinutes(minutes: number): Promise<void> {
  const next: InstanceEconomy = { ...(await read()), avatarPriceMinutes: Math.floor(minutes) };
  await db
    .insert(instanceSettings)
    .values({ key: ECONOMY_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: next, updatedAt: new Date() } });
}
