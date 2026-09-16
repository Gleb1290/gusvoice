/**
 * Статистика присутствия для ДЕРЖАТЕЛЯ ИНСТАНСА (запрос 02.09).
 *
 * 🔴 **Зачем именно ему.** Он назначает цену анимированного аватара в минутах сидения и должен
 * видеть, сколько у него в среднем сидят: «две тысячи минут» без этого — число из воздуха. Цифры
 * считаются по ВСЕМУ инстансу, потому что и цена одна на инстанс.
 *
 * 🔴 **Считаем по эталонной модели множителей, а не по настройкам сервера.** Ставка, компания и
 * затухание у каждого сервера свои, а статистика одна: смешивать их значило бы складывать
 * несравнимое.
 *
 * 🔴 **Эталон = УМОЛЧАНИЯ `server_economy`, и это не formality (правка 04.09).** Раньше он жил
 * своей жизнью — компания 125 % против боевых 150 %, затухание после 4 часов против 2, потолок 450
 * минут против 200 — и вместе с формульным гусём завышал доход **вчетверо**: 601 минута прайса за
 * активный день против 155 настоящих. По этой самой цифре держатель инстанса назначает цену
 * аватара, то есть врала она ровно там, где стоит дороже всего. Проверено на неделе живых данных.
 * ⚠️ Двигаешь умолчание в схеме — двигай и здесь: разъехавшись однажды, они разъедутся снова.
 *
 * 🔴 **Гусь считается ПО ФАКТУ журнала, а не формулой.** Формула «поймал каждого» давала 360 минут
 * прайса в день — больше, чем всё сидение, потому что предполагала, что человек ловит гуся каждые
 * 20 минут без промаха. На первом живом прогоне двое поймали ЧЕТЫРЁХ за сутки. Оценка, построенная
 * на недостижимом поведении, хуже отсутствия оценки, поэтому здесь среднее по тому, что реально
 * начислено (`coin_ledger`, `reason = 'goose'`). Где экономика ещё не включена, честный ноль.
 */
import { sql } from 'drizzle-orm';
import { db } from './db/index.js';

/**
 * Эталонные множители = УМОЛЧАНИЯ `server_economy` (миграция 0053). Держать в паре с ними.
 */
export const REF = {
  alone: 0.25,
  pair: 1.0,
  company: 1.5,
  deafened: 0.25,
  /** Затухание: вдвое каждые 2 часа за сутки. */
  decayAfterMinutes: 120,
  decayPercent: 0.5,
  /** Ставка умолчания: монет за 5 минут. Ею переводим монеты журнала в минуты прайса и обратно. */
  ratePer5min: 10,
  /** Потолок в ВЗВЕШЕННЫХ минутах = дневной потолок 800 монет при ставке умолчания. */
  capWeightedMinutes: 400,
} as const;

export interface EconomyStats {
  /** Окно наблюдения в днях. */
  windowDays: number;
  /** Сколько человек вообще сидели в голосе за окно. */
  people: number;
  /** Сколько человеко-дней. */
  userDays: number;
  /** Всего часов присутствия. */
  hours: number;
  /** Среднее СЫРЫХ минут за активный день на человека. */
  avgSitMinutes: number;
  /** Среднее ЗАРАБОТАННЫХ минут прайса за активный день — только сидение, с потолком. */
  avgEarnMinutes: number;
  /** Сколько гусь ДОБАВИЛ на самом деле — в минутах прайса за активный день. */
  avgGooseMinutes: number;
}

/**
 * Снять статистику за последние `windowDays` суток.
 *
 * ⚠️ Сутки режем по московской полуночи — той же границей, что и вся экономика. Иначе «день» здесь
 * и «день» в начислении означали бы разное, и числа не сошлись бы ни с чем.
 */
export async function economyStats(windowDays = 30): Promise<EconomyStats> {
  /**
   * 🔴 Каждый параметр идёт с ЯВНЫМ приведением (`::numeric`, `::int`), и это не украшение.
   *
   * Параметр без типа Postgres выводит по контексту, а в `CASE`, где ВСЕ ветки — параметры,
   * контекста нет: результат становится `text`, и умножение минут на него падает с
   * `operator does not exist: numeric * text`. Ровно это и случилось на проде 02.09.
   *
   * ⚠️ Первым фиксом я подставил числа литералами через `sql.raw` — запрос заработал, но упал гейт
   * semgrep, и по делу: `sql.raw` со вставкой есть шаблон инъекции, даже когда вставляешь свои
   * константы. Правило поймало форму, а не намерение, и это правильная работа правила. Приведение у
   * параметра решает ту же задачу, ничего не собирая строкой.
   */
  const days = Math.max(1, Math.min(365, Math.floor(windowDays)));

  const res = await db.execute(sql`
    WITH s AS (
      SELECT user_id,
             (created_at AT TIME ZONE 'Europe/Moscow')::date AS d,
             created_at, seconds, peers, deafened
      FROM voice_activity
      WHERE created_at >= now() - make_interval(days => ${days}::int)
    ), r AS (
      SELECT *, sum(seconds) OVER (PARTITION BY user_id, d ORDER BY created_at
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) / 60.0 AS cum_min
      FROM s
    ), w AS (
      SELECT user_id, d,
             sum(seconds) / 60.0 AS raw_min,
             least(${REF.capWeightedMinutes}::numeric, sum((seconds / 60.0)
               * (CASE WHEN peers = 0 THEN ${REF.alone}::numeric
                       WHEN peers = 1 THEN ${REF.pair}::numeric
                       ELSE ${REF.company}::numeric END)
               * (CASE WHEN deafened THEN ${REF.deafened}::numeric ELSE 1.0 END)
               * power(${REF.decayPercent}::numeric,
                       floor(greatest(cum_min - 1, 0) / ${REF.decayAfterMinutes}::numeric))
             )) AS wmin
      FROM r GROUP BY 1, 2
    )
    SELECT
      (SELECT count(DISTINCT user_id) FROM w)::int                    AS people,
      (SELECT count(*) FROM w)::int                                   AS user_days,
      coalesce((SELECT round(sum(raw_min) / 60.0) FROM w), 0)::int    AS hours,
      coalesce((SELECT round(avg(raw_min)) FROM w), 0)::int           AS avg_sit,
      coalesce((SELECT round(avg(wmin)) FROM w), 0)::int              AS avg_earn,
      -- Гусь по факту: сколько монет журнал записал за окно, делённое на активные человеко-дни и
      -- переведённое в минуты прайса по ставке умолчания. Никаких «а если бы ловил каждого».
      coalesce((SELECT round(
                  (SELECT coalesce(sum(amount), 0) FROM coin_ledger
                    WHERE reason = 'goose' AND created_at >= now() - make_interval(days => ${days}::int))
                  / greatest((SELECT count(*) FROM w), 1)::numeric
                  / (${REF.ratePer5min}::numeric / 5.0)
                )), 0)::int AS avg_goose
  `);

  // ⚠️ Драйверы возвращают либо массив строк, либо объект с `rows` — берём оба вида, чтобы смена
  // драйвера не роняла статистику молча.
  const row = ((res as unknown as { rows?: EconomyStatsRow[] }).rows ?? (res as unknown as EconomyStatsRow[]))[0];
  return {
    windowDays: days,
    people: Number(row?.people ?? 0),
    userDays: Number(row?.user_days ?? 0),
    hours: Number(row?.hours ?? 0),
    avgSitMinutes: Number(row?.avg_sit ?? 0),
    avgEarnMinutes: Number(row?.avg_earn ?? 0),
    avgGooseMinutes: Number(row?.avg_goose ?? 0),
  };
}

interface EconomyStatsRow {
  people: number;
  user_days: number;
  hours: number;
  avg_sit: number;
  avg_earn: number;
  avg_goose: number;
}
