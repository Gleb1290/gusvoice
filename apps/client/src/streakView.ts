/**
 * Серия дней в кошельке — чистые правила показа (правка 03.09: «в кошельке не видно стрик»,
 * «непонятно, на что бонус»).
 *
 * Сервер присылает `StreakView` (посчитан той же логикой, что и награда); здесь только раскладка на
 * семь точек с днями недели — тот же рисунок, что в приветственном окне, — и слова.
 */

export interface StreakView {
  enabled: boolean;
  /** Сутки экономики `ГГГГ-ММ-ДД`, по которым сервер считал; дни недели подписываем по ним. */
  today: string;
  days: number;
  todayCounted: boolean;
  todayReward: number;
  nextReward: number;
  bonus: number;
  maxDays: number;
}

export type DotState = 'on' | 'today' | 'off';
export interface StreakDot {
  label: string;
  state: DotState;
}

/** Порядок недели, слева направо. Понедельник первым — календарь, а не скользящее окно. */
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/**
 * Неделя: семь точек ПН → ВС, слева направо.
 *
 * 🔴 **Календарная неделя, а не последние семь суток** (замечание 03.09: «каша из дней»).
 * Скользящее окно давало «пт сб вс пн вт ср чт» — набор верный, порядок нечитаемый: человек ищет
 * глазами понедельник, а находит пятницу. Неделя на месте, двигается только подсветка.
 *
 * 🔴 Дни недели берём из СЕРВЕРНОГО ключа суток, а не из часов клиента: сутки экономики идут по
 * московской полуночи, и у человека в другом поясе «сегодня» разъехалось бы с точкой.
 *
 * ⚠️ Подсвечиваем только те дни цепочки, что попали в ЭТУ неделю. Цепочка длиннее недели просто
 * заливает её целиком, а вчерашняя цепочка в понедельник не подсвечивает ничего — и это правда:
 * её дни лежат в прошлой неделе, которой тут не видно.
 */
export function streakDots(v: Pick<StreakView, 'today' | 'days' | 'todayCounted'>): StreakDot[] {
  const [y, m, d] = v.today.split('-').map(Number);
  // Полдень UTC — чтобы вычитание суток не уехало через перевод часов (тот же приём, что на сервере).
  const base = Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? Date.UTC(y, m - 1, d, 12) : Date.now();
  const counted = Math.max(0, Math.min(v.days, 7));
  // Понедельник = 0. `getUTCDay` считает от воскресенья, поэтому сдвигаем.
  const todayIdx = (new Date(base).getUTCDay() + 6) % 7;
  // Последний ЗАСЧИТАННЫЙ день недели: сегодня, если сегодня уже зачли, иначе вчера.
  const lastIdx = v.todayCounted ? todayIdx : todayIdx - 1;
  return WEEKDAYS.map((label, i) => {
    let state: DotState = 'off';
    if (counted > 0 && i <= lastIdx && i > lastIdx - counted) state = 'on';
    // Сегодня без захода — пунктиром: «вот сюда и зайди». Зашёл — обычная залитая точка цепочки.
    if (i === todayIdx && !v.todayCounted) state = 'today';
    return { label, state };
  });
}

function dayWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'дней';
  if (m10 === 1) return 'день';
  if (m10 >= 2 && m10 <= 4) return 'дня';
  return 'дней';
}

/**
 * Первая строка под точками: который день подряд и сколько монет это даёт.
 * ⚠️ Слово «серия» не взяли («стрик оставляем как есть») — в интерфейсе говорим «дни подряд».
 */
export function streakCaption(v: StreakView, currency: string): string {
  if (v.todayCounted) {
    const head = v.days === 1 ? 'Первый день' : `${v.days} ${dayWord(v.days)} подряд`;
    return `${head} · сегодня +${v.todayReward} ${currency}`;
  }
  if (v.days > 0) {
    return `${v.days} ${dayWord(v.days)} подряд · зайди в голосовой канал сегодня — +${v.todayReward} ${currency}`;
  }
  return `Начни заново: сегодня +${v.todayReward} ${currency}, завтра +${v.nextReward}`;
}

/**
 * Вторая строка: НА ЧТО распространяется бонус (вопрос на приёмке). Это монеты сверху к обычному
 * заработку — за сам приход в голос, раз в день; не множитель и не «за часы».
 */
export function streakExplain(v: StreakView, currency: string): string {
  return (
    `Бонус за сам приход в голосовой канал, раз в день, монетами сверху к обычному заработку: ` +
    `1-й день +${v.bonus} ${currency}, каждый следующий день подряд больше, с ${v.maxDays}-го — +${v.bonus * v.maxDays}. ` +
    `Пропустил день — счёт с первого.`
  );
}
