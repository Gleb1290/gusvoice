/**
 * Стрик — бонус за то, что человек заходит день за днём (план, модель F).
 *
 * 🔴 **Награждает регулярность, а не длительность.** Базовая ставка платит за часы; стрик платит за
 * то, что ты вообще пришёл сегодня. Это разные вещи, и складываются они хорошо: сидящий вечерами
 * понемногу получает столько же внимания, сколько марафонец по выходным.
 *
 * 🔴 **Одна ручка, а не две.** Размер бонуса настраивается, потолок стрика — нет: он зафиксирован
 * НЕДЕЛЕЙ. Неделя объясняется одной фразой («ходишь всю неделю — получаешь семикратный бонус»), а
 * настраиваемый потолок пришлось бы объяснять дважды и в паре с размером давал бы числа, которые
 * владелец сам не предскажет.
 *
 * ⚠️ Пропуск дня обнуляет стрик до единицы, а НЕ до нуля: человек всё равно сегодня пришёл, и
 * оставить его совсем без бонуса значило бы наказать за вчерашнее отсутствие дважды.
 */

/** Дальше этого стрик не растёт. Неделя — срок, который человек держит в голове без подсказки. */
export const STREAK_MAX_DAYS = 7;

/** Ключ суток на день раньше указанного. Формат тот же, что у `dayKey`: `ГГГГ-ММ-ДД`. */
function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  // ⚠️ Через UTC-полдень, а не полночь: полночь в местной зоне при вычитании суток может уехать в
  // предыдущий день из-за перевода часов, и стрик рвался бы дважды в год у всех сразу.
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

export interface StreakState {
  /** Сутки, за которые бонус уже выдан; пусто — ещё ни разу. */
  streakDay: string;
  /** Сколько дней подряд человек приходит, включая эти сутки. */
  streakDays: number;
}

export interface StreakStep {
  /** Новое состояние стрика. */
  next: StreakState;
  /** Сколько дней подряд засчитано к награде (уже с потолком); `0` — сегодня уже награждали. */
  rewardDays: number;
}

/**
 * Шаг стрика на приход в сутки `today`.
 *
 * 🔴 Награда полагается РОВНО ОДИН раз за сутки, и решает это сравнение `streakDay === today`.
 * Начисление за голос происходит каждые несколько минут; без этой отсечки бонус капал бы весь
 * вечер, и «раз в день» превратилось бы в «сколько досидишь».
 */
export function streakStep(state: StreakState, today: string): StreakStep {
  if (state.streakDay === today) return { next: state, rewardDays: 0 };
  const continued = state.streakDay === previousDay(today);
  const days = continued ? Math.min(state.streakDays + 1, STREAK_MAX_DAYS) : 1;
  return { next: { streakDay: today, streakDays: days }, rewardDays: days };
}

/**
 * Сколько монет причитается за `rewardDays` подряд.
 *
 * ⚠️ Умножение, а не лестница из порогов: пороги («на третий день — вот столько, на седьмой — вот
 * столько») владелец не настроит одной ручкой, а объяснить их человеку можно только таблицей.
 */
export function streakReward(rewardDays: number, bonus: number): number {
  if (rewardDays <= 0 || bonus <= 0) return 0;
  return Math.min(rewardDays, STREAK_MAX_DAYS) * bonus;
}

/**
 * Серия глазами человека — то, что показывает кошелёк (правка 03.09: «в кошельке не видно
 * стрик» и «непонятно, на что бонус»).
 *
 * 🔴 Считается ТОЙ ЖЕ логикой, что и награда (`streakStep`/`streakReward`), а не пересказом: иначе
 * кошелёк обещал бы одно, а начислялось бы другое. Три состояния:
 *   • сегодня уже засчитан — цепочка `days`, награда за сегодня уже выдана;
 *   • цепочка жива, но сегодня ещё не заходил — `days` вчерашних, «зайди сегодня — получишь»;
 *   • цепочка оборвана — `days = 0`, первый заход даёт единичный бонус.
 * `bonus = 0` — серии на сервере нет, блок не рисуется.
 */
export interface StreakView {
  enabled: boolean;
  /** Сутки экономики, по которым считалось (ключ `dayKey`) — клиент подписывает по ним дни недели. */
  today: string;
  /** Длина цепочки: с сегодняшним днём, если он засчитан, иначе — по вчерашний. */
  days: number;
  todayCounted: boolean;
  /** Монеты за сегодня: уже выданные или те, что дадут за заход. */
  todayReward: number;
  /** Монеты за следующий день цепочки. */
  nextReward: number;
  bonus: number;
  maxDays: number;
}

export function streakView(state: StreakState, today: string, bonus: number): StreakView {
  const enabled = bonus > 0;
  const base = { enabled, today, bonus, maxDays: STREAK_MAX_DAYS };
  if (state.streakDay === today) {
    const days = Math.min(Math.max(state.streakDays, 1), STREAK_MAX_DAYS);
    return {
      ...base,
      days,
      todayCounted: true,
      todayReward: streakReward(days, bonus),
      nextReward: streakReward(Math.min(days + 1, STREAK_MAX_DAYS), bonus),
    };
  }
  const alive = state.streakDay === previousDay(today);
  const days = alive ? Math.min(state.streakDays, STREAK_MAX_DAYS) : 0;
  const todayDays = Math.min(days + 1, STREAK_MAX_DAYS);
  return {
    ...base,
    days,
    todayCounted: false,
    todayReward: streakReward(todayDays, bonus),
    nextReward: streakReward(Math.min(todayDays + 1, STREAK_MAX_DAYS), bonus),
  };
}
