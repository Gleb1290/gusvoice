/**
 * Типы и мелкие правила экономики ГусКоинов на клиенте (#117).
 *
 * План — `docs/guscoins-plan.md`. Здесь только то, что нужно интерфейсу; вся арифметика начисления
 * живёт на сервере (`coinRules.ts`) и клиенту не дублируется намеренно: две копии формулы разошлись
 * бы, и человек видел бы одно число в приложении и другое в кошельке.
 */

export interface EconomySettingsDto {
  enabled: boolean;
  currencyName: string;
  iconUrl: string | null;
  ratePer5min: number;
  alonePercent: number;
  companyPercent: number;
  dailyCap: number;
  /**
   * Порог монет одному в канале за сутки (28.10); `0` — без порога. Время одному с этого дня не
   * идёт в затухание — одиночный фарм держит этот порог.
   * ⚠️ Необязательное: сервер старой версии поля не знает, и тогда панель ползунок не рисует.
   */
  aloneCap?: number;
  decayAfterMinutes: number;
  decayPercent: number;
  mutedPercent: number;
  deafenedPercent: number;
  /** Процент ставки в статусе «отошёл» — сам поставил или увела автоматика по простою ОС. */
  awayPercent: number;
  payoutMinutes: number;
  compensateOnRaise: boolean;
  tipAmount: number;
  tipTaxPercent: number;
  tipDailyOut: number;
  tipDailyIn: number;
  tipDailyPair: number;
  /**
   * Длина сезона: времена года или месяц.
   * ⚠️ Смена — это смена календарной сетки (аудит 03.09): сезон, начавшийся в том же окне, продолжается
   * под новым именем, прошедшие полные периоды старой сетки подводятся досрочно. Панель предупреждает.
   */
  seasonLength: 'quarter' | 'month';
  /** Надбавка за пойманного гуся; `0` — гуся на сервере нет. */
  gooseBonus: number;
  /** Через сколько минут ПОСЛЕ ПОИМКИ гусь может выглянуть снова (07.09). */
  gooseMinutes: number;
  /** Надбавка за гуся, пойманного в деафене; больше `gooseBonus` не бывает. */
  gooseDeafenedBonus: number;
  /** Монет за каждый день цепочки стрика; `0` — стрика нет. Потолок цепочки — неделя. */
  streakBonus: number;
  retroGrantedAt: string | null;
  /**
   * Мини-игры на сервере (ГусКоины 2, этап 1): колесо, дуэли, прогнозы. Выключены по умолчанию.
   * ⚠️ Четыре поля ниже необязательны: сервер старой версии их не знает — тогда в панели нет раздела «Игры».
   */
  gamesEnabled?: boolean;
  /** Максимальная ставка одним нажатием, 1…1 000 000. */
  gamesBetMax?: number;
  /** Потолок проигрыша человека за сутки МСК на этом сервере; `0` — без потолка. */
  gamesDailyLossMax?: number;
  /** Комиссия банка дуэлей и прогнозов, 0…50 %. Сгорает — строкой журнала не пишется. */
  gamesFeePercent?: number;
  /**
   * Этап 4: сколько одна пара может выиграть друг у друга за сутки МСК в играх с выбором (КНБ, Жадный гусь) — чистый
   * поток пары; кубики не ограничены. `0` — без предела. Старый сервер поля не шлёт — ползунка нет.
   */
  gamesPairDailyMax?: number;
}

/**
 * Мои деньги в играх на сервере (ГусКоины 2, этап 1) — в снимке кошелька рядом с `optedOut`.
 *
 * 🔴 Самоограничение: понизить предел можно сразу, повысить — только с начала следующих суток МСК
 * (`lossLimitRaise`), иначе в азарте предел поднимают ровно тогда, когда он нужен.
 */
export interface GamesWallet {
  /** «Не показывать мне игры». */
  optOut: boolean;
  /** Мой предел проигрыша за сутки; `null` — как на сервере. */
  lossLimit: number | null;
  /** Отложенное повышение: какое значение и с какого момента (ISO, начало следующих суток МСК). */
  /** `value: null` — повышение до «как на сервере» (свой предел снимается с начала суток). */
  lossLimitRaise: { value: number | null; from: string } | null;
  /** Проиграно сегодня (сутки МСК): ставки − выигрыши − возвраты. */
  lossToday: number;
  /** Действующий предел = min(мой, потолок сервера); `null` — без предела. */
  effectiveLimit: number | null;
}

/**
 * Уровень человека.
 *
 * 🔴 Считается от ЗАРАБОТАННЫХ монет одной шкалой (решение 03.09): голос, пойманные гуси и дни
 * подряд несут ровно свои монеты. Полученные типы в `earnedTotal` не входят по конструкции — уровень
 * с альта не занести, и в кошельке это сказано человеку прямо.
 */
export interface LevelState {
  level: number;
  title: string;
  /** Заработанные монеты — те же, что «за всё время» в кошельке. */
  points: number;
  nextAt: number;
  /** Доля пути до следующего уровня, 0…1. */
  progress: number;
}

/** Ступень лестницы званий: звание и сколько заработанных монет на него нужно. */
export interface LevelStage {
  title: string;
  at: number;
}

import type { GamesLaunchDto } from '@gusvoice/shared';
import type { StreakView } from './streakView';
export type { StreakView };

export interface LeaderboardEntry {
  place: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  earned: number;
  level: LevelState;
}

export interface Leaderboard {
  season: { id: string; name: string };
  /** Победитель ПРОШЛОГО сезона — он носит корону. `null`, если сезон ещё ни разу не закрывался. */
  crown: { userId: string; seasonId: string; earned: number } | null;
  people: LeaderboardEntry[];
}

/**
 * Сводка по экономике сервера — то, по чему владелец видит, что она считает не то (#121, #124 К4).
 *
 * 🔴 Главное поле — `drift`. Сумма строк журнала человека обязана равняться его балансу; каждый
 * писатель баланса пишет и строку журнала одной транзакцией, поэтому расхождение при исправной
 * работе невозможно. Непустой массив = деньги где-то поменялись мимо журнала.
 */
export interface EconomySummary {
  /** Начало суток, за которые посчитано движение. */
  since: string;
  totals: {
    accrued: number;
    tipped: number;
    tips: number;
    burned: number;
    retro: number;
    rescale: number;
    granted: number;
    /** Разовый перерасчёт сезона (28.10). Необязательное: у старого сервера поля нет. */
    recount?: number;
    minted: number;
  };
  top: { userId: string; displayName: string; coins: number }[];
  /** Сколько монет всего на руках и в скольких кошельках. */
  circulation: number;
  wallets: number;
  drift: { userId: string; displayName: string; balance: number; ledger: number }[];
}

export interface EconomyWallet {
  balance: number;
  earnedTotal: number;
  seasonEarned: number;
  optedOut: boolean;
  /** Не принимать типы. ⚠️ Отдельно от `optedOut`: заработок при этом продолжается (#122). */
  tipsOptOut: boolean;
  /** Монет за ожидание одному сегодня (28.10) — для строки «X из порога». Нет у старого сервера. */
  aloneEarnedToday?: number;
  /** Мои настройки и счётчик игр. Нет у старого сервера — тогда блока «Игры» в кошельке нет. */
  games?: GamesWallet;
}

/** Позиция каталога с ценой по ТЕКУЩЕЙ ставке — то, что показывают человеку. */
/**
 * Экономическая карточка ЧУЖОГО человека — для карточки профиля.
 *
 * ⚠️ Только баланс и уровень. Ни часов, ни отметок времени: приватность §9 плана.
 * ⚠️ `null` вместо карточки означает И «экономика выключена», И «человек в ней не участвует» —
 * намеренно неразличимо, чтобы выключатель не стал поводом для подколок.
 */
export interface UserEconomyCard {
  balance: number;
  level: LevelState;
}

export interface ShopEntry {
  item: string;
  label: string;
  hint: string;
  /** Цена в минутах сидения — то, что хранится и крутит владелец. */
  priceMinutes: number;
  /** Она же в монетах: считает сервер, клиент не пересчитывает. */
  priceCoins: number;
  /**
   * Разброс РЕАЛЬНЫХ цен, когда они свои у каждого экземпляра награды (саундборд).
   * ⚠️ Есть разброс — показываем его, а не общее число: иначе витрина обещает одну цену, а платится
   * другая (замечание 03.09).
   */
  priceRange?: { minCoins: number; maxCoins: number };
  enabled: boolean;
  /**
   * Кому достаётся награда: `user` — выбранному человеку, `channel` — всем в голосовом канале
   * (саундборд, салют), `none` — себе.
   * ⚠️ Держать в согласии с `ShopItemSpec` на бэкенде: расхождение здесь ловится только сборкой
   * макета стенда — как и поймалось, когда `channel` появился на сервере и не появился тут.
   */
  target: 'user' | 'none' | 'channel';
  /**
   * Пол цены — только у анимированного аватара: цена инстанса, ниже которой сервер опуститься не
   * может (14.09). Приходит и в монетах, потому что пересчитывать цену на клиенте нельзя.
   */
  floor?: { minutes: number; coins: number };
  /** Своя цена сервера на аватар; `null` — наценки нет, действует пол инстанса. */
  serverMinutes?: number | null;
  /** Потолок аренды аватара в днях — настройка инстанса (#228); нет поля (старый сервер) — 60. */
  rentalMaxDays?: number;
}

export interface EconomyView {
  enabled: boolean;
  currencyName: string;
  iconUrl: string | null;
  canManage: boolean;
  /**
   * Процент ставки в статусе «отошёл» — виден ВСЕМ, а не только управляющему: человек должен знать,
   * что его статус стоит денег. `null` — экономики на сервере нет.
   */
  awayPercent: number | null;
  /** Ползунки — только тому, кто может их крутить. */
  settings: EconomySettingsDto | null;
  wallet: EconomyWallet;
  season: { id: string; name: string };
  /** Мой уровень — тем же ответом: он про этого же человека и нужен там же, где баланс. */
  level: LevelState;
  /**
   * Лестница званий В ЧИСЛАХ — из того же источника, что и уровень (03.09: «надо чтоб было
   * видно прям этапы в числах»). Человек видит, на какой ступени стоит и сколько монет до каждой.
   */
  levelStages: LevelStage[];
  /**
   * Серия дней — посчитана сервером той же логикой, что и награда (правка 03.09). Необязательное:
   * снимок в сторе мог приехать до появления поля.
   */
  streak?: StreakView;
  /**
   * Победитель прошлого сезона — он носит корону. `null`, если сезон ещё не закрывался.
   * 🔴 Едет в общем снимке, потому что корону рисуют на живых поверхностях, а не в модалке.
   */
  /**
   * Гусь, который висит ПРЯМО СЕЙЧАС (или `null`). Нужен, чтобы кнопка пережила перезагрузку
   * страницы: предложение приходит одним пушем и больше нигде не лежит.
   */
  goose?: { offerId: string } | null;
  crown: { userId: string; seasonId: string; earned: number } | null;
  /**
   * Лавка. 🔴 Приезжает ВМЕСТЕ с кошельком, а не отдельным запросом: цена нужна там же, где
   * баланс — пункт «Ущипнуть» в меню показывает её всегда, даже когда монет не хватает.
   */
  shop: ShopEntry[];
  /**
   * Непросмотренная карточка перерасчёта сезона (28.10): сколько доначислено по правилу «один —
   * затухание не бьёт» и за какой сезон. Поля нет — показывать нечего (и у старого сервера его нет).
   * Показ — `RecountNotice.tsx`, отметка — `api.markRecountSeen`.
   */
  recount?: { amount: number; seasonId: string };
  /**
   * Включены ли мини-игры на сервере и потолок проигрыша за сутки — ВСЕМ, а не только управляющему
   * (как `awayPercent`): без них кошелёк не знает, показывать ли блок «Игры» и до скольки двигать
   * личный предел. Необязательные: нет у старого сервера; тогда берём из `settings`, если они есть.
   */
  gamesEnabled?: boolean;
  gamesDailyLossMax?: number;
  /**
   * Замок игр до приёмки (29.10, `GAMES_OPEN`): `true` — этому человеку включать игры нельзя, переключатель «Игры» и
   * кнопка «Запустить игры» спрятаны (`gamesLaunchRules.ts`). Нет поля (старый сервер) — как раньше.
   */
  gamesLocked?: boolean;
  /** Запуск игр сервера (`null` — не запускали; нет поля — старый сервер): карточка «Игры пришли в голос». */
  gamesLaunch?: GamesLaunchDto | null;
}

/**
 * Включены ли игры и каков потолок сервера — с того, что прислал сервер (`null` — блок «Игры» не рисуем).
 *
 * Верхние поля снимка видны всем; `settings` — только управляющему. Нет ни того, ни другого (старый
 * сервер) или нет `wallet.games` — игр для этого клиента нет.
 */
export function gamesView(view: EconomyView): { games: GamesWallet; serverMax: number } | null {
  const games = view.wallet.games;
  const enabled = view.gamesEnabled ?? view.settings?.gamesEnabled;
  if (!games || enabled !== true) return null;
  const serverMax = view.gamesDailyLossMax ?? view.settings?.gamesDailyLossMax ?? 0;
  return { games, serverMax };
}

export interface EconomyPreview {
  days: number;
  samples: number;
  people: { userId: string; displayName: string; coins: number; hours: number }[];
}

/**
 * Что ретроначисление выдаст, если нажать прямо сейчас.
 *
 * 🔴 Не то же самое, что `EconomyPreview`: тот показывает последнюю НЕДЕЛЮ под ползунками, а ретро
 * платит за ВСЮ историю до момента включения экономики. Чем дольше идёт сухой прогон, тем сильнее
 * расходятся эти два числа.
 */
export interface RetroPreview {
  /** До какого момента считаем (момент включения экономики либо «сейчас»). */
  until: string;
  samples: number;
  alreadyGranted: boolean;
  granted: number;
  skipped: number;
  people: { userId: string; displayName: string; coins: number; hours: number }[];
}

export interface LedgerEntry {
  id: string;
  amount: number;
  reason: string;
  refUserId: string | null;
  createdAt: string;
  /** Для типов сервер отдаёт, сколько монет сгорело по дороге. */
  /** Подробности операции: у типа — сгоревший налог, у голоса — разбор начисления, у серии — её день. */
  /** У перерасчёта сезона (`recount`, 28.10) — `seasonId`, за который доплачено. */
  data?: { burned?: number; days?: number; seasonId?: string } & AccrualData;
}

/**
 * Разбор начисления из журнала — то, что сервер положил в `data` строки `voice` (#121).
 *
 * Всё в тысячных монеты: объяснение считается из тех же чисел, что и сама сумма.
 */
export interface AccrualData {
  seconds?: number;
  baseMilli?: number;
  presenceMilli?: number;
  companyMilli?: number;
  decayMilli?: number;
  cappedByDaily?: boolean;
}

/** Одна причина, изменившая сумму. `coins` со знаком: минус — потеря, плюс — надбавка. */
export interface ExplainPart {
  label: string;
  coins: number;
}

export interface AccrualExplain {
  /** «10 минут в голосе» */
  time: string;
  /** Сколько дала бы ставка без единого множителя. */
  fullCoins: number;
  parts: ExplainPart[];
  cappedByDaily: boolean;
}

/** Тысячные монеты → человеческое число: без хвоста у целых, с одним знаком у дробных. */
function coins(milli: number): number {
  return Math.round(milli / 100) / 10;
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m <= 0) return `${Math.max(1, Math.round(seconds))} с в голосовом канале`;
  const tail = m % 100 >= 11 && m % 100 <= 14 ? 'минут' : ['минут', 'минуту', 'минуты'][Math.min(2, m % 10 === 1 ? 1 : m % 10 >= 2 && m % 10 <= 4 ? 2 : 0)];
  return `${m} ${tail} в голосовом канале`;
}

/**
 * Объяснить строку журнала словами.
 *
 * 🔴 Зачем это вообще есть. Потолок выбран — начисление молча прекращается; включилось затухание —
 * ставка молча вдвое; один в канале — четверть, тоже молча. Три РАЗНЫЕ причины выглядят для
 * человека одинаково: «сломалось». А на вопрос «почему у Пети больше» ответить нечем, если журнал
 * хранит только суммы.
 *
 * ⚠️ Возвращает `null`, когда разбора нет: у старых строк журнала его не будет никогда, и это не
 * повод прятать саму строку — сумма важнее объяснения.
 * ⚠️ Ровные множители (никто не мешал, никто не помог) в список НЕ попадают: «затухание 0» — это
 * шум, а не объяснение.
 */
export function explainAccrual(data: AccrualData | undefined | null): AccrualExplain | null {
  if (!data || typeof data.baseMilli !== 'number') return null;
  const parts: ExplainPart[] = [];
  const add = (label: string, milli: number | undefined) => {
    if (typeof milli !== 'number' || Math.abs(milli) < 50) return; // меньше 0.05 монеты — не причина
    parts.push({ label, coins: coins(milli) });
  };
  add('микрофон был выключен', data.presenceMilli);
  add((data.companyMilli ?? 0) >= 0 ? 'вы были в компании' : 'вы были одни', data.companyMilli);
  // С 28.10 затухание считает только время в компании — ожидание одному сюда не попадает.
  add('сработало затухание за долгие часы в компании', data.decayMilli);
  return {
    time: minutes(data.seconds ?? 0),
    fullCoins: coins(data.baseMilli),
    parts,
    cappedByDaily: data.cappedByDaily === true,
  };
}

/** Человеческое имя операции в журнале. Незнакомую причину показываем как есть, а не прячем. */
export const LEDGER_REASON: Record<string, string> = {
  voice: 'За время в голосовом канале',
  // ⚠️ «Отдал/получил», а не «Типнул/Типнули»: строка склеивается с именем, и «Типнул Петя»
  // читалось как «Петя типнул меня», хотя это МОЁ списание в его пользу (аудит текстов 03.09).
  // Отглагольная форма с направлением снимает и падеж, и двусмысленность разом.
  'tip.in': 'Получил тип',
  'tip.out': 'Отдал тип',
  grant: 'Выдал модератор',
  // ⚠️ «За прошлую неделю» здесь было бы враньём в общем случае: ретро платит за ВСЁ, что записано
  // до включения монет, а это может быть и три дня, и месяц. Формулировка отвечает на настоящий
  // вопрос человека — «откуда у меня сразу пачка монет».
  retro: 'За активность до включения монет',
  rescale: 'Пересчёт при смене ставки',
  // Разовая доплата 28.10: сезон пересчитан по правилу «один — затухание не бьёт» (`RecountNotice.tsx`).
  recount: 'Перерасчёт сезона',
  goose: 'Поймал гуся',
  streak: 'Дни подряд',
  // ⚠️ Покупки: причина приходит с ключом награды, поэтому их тут по одной на каждую позицию
  // каталога. Забудешь дописать новую — в журнале останется машинный ключ, и человек прочитает
  // «mega-poke» вместо «Щипок».
  'shop.mega-poke': 'Ущипнул',
  'shop.soundboard': 'Выстрел саундборда',
  'shop.animated-avatar': 'Анимированный аватар',
  // Мини-игры (ГусКоины 2). Ставка — списание в момент ставки, выигрыш и возврат — отдельные строки;
  // комиссия строкой не пишется (сгорает). Ни одна из них не заработок и не идёт в сезон.
  'wheel.bet': 'Ставка в колесе',
  'wheel.win': 'Выигрыш в колесе',
  'wheel.refund': 'Возврат ставки (колесо)',
  // Доля сундука-джекпота (этап 2): не заработок, не сезон — как и выигрыш.
  'wheel.jackpot': 'Джекпот колеса',
  'duel.stake': 'Ставка в дуэли',
  'duel.win': 'Выигрыш дуэли',
  'duel.refund': 'Возврат ставки (дуэль)',
  'prediction.bet': 'Ставка на прогноз',
  'prediction.win': 'Выигрыш прогноза',
  'prediction.refund': 'Возврат ставки (прогноз)',
  // Подарок сидевшим в голосе в момент запуска игр (29.10): не заработок, не сезон.
  'games.launch': 'Подарок за запуск игр',
};

/**
 * Сколько монет выходит за час при таких настройках и такой компании.
 *
 * ⚠️ ПРИКИДКА для подписи под ползунком, а не расчёт начисления: затухание и суточный потолок здесь
 * не учитываются — они зависят от того, сколько человек уже просидел. Настоящие числа приходят с
 * сервера (`previewEconomy`), и именно им верить.
 */
export function coinsPerHour(ratePer5min: number, companyPct: number): number {
  return Math.round((ratePer5min * 12 * companyPct) / 100);
}

/**
 * Во сколько минут сидения обходится награда такой цены.
 *
 * 🔴 Главный приём всей панели: цены назначаются В МИНУТАХ, а не в монетах (практика Twitch, где
 * звуковой прикол стоит меньше 30 минут просмотра). Тогда сдвиг ставки меняет масштаб, а не ломает
 * прайс.
 */
export function minutesForCoins(coins: number, ratePer5min: number): number {
  if (ratePer5min <= 0) return 0;
  return Math.round((coins / ratePer5min) * 5);
}

/**
 * За сколько часов одному с включённым микрофоном выбирается порог `aloneCap` (28.10).
 *
 * ⚠️ ПРИКИДКА для подписи, как и `coinsPerHour`: мьют, «отошёл» и выплата шагами её сдвигают. Шаг —
 * полчаса, не меньше получаса: точнее подпись всё равно не станет, а «0 ч» читалось бы как «не капает».
 * `null` — одному не капает вовсе (ставка или «Один в канале» на нуле) или порога нет (`0`).
 */
export function aloneCapHours(aloneCap: number, ratePer5min: number, alonePercent: number): number | null {
  const perHour = (ratePer5min * 12 * alonePercent) / 100;
  if (aloneCap <= 0 || perHour <= 0) return null;
  return Math.max(0.5, Math.round((aloneCap / perHour) * 2) / 2);
}

/** «3 ч», «2,5 ч» — часы по-русски, с запятой. */
export function hoursLabel(hours: number): string {
  return `${String(hours).replace('.', ',')} ч`;
}

/**
 * «Запустить игры» (ГусКоины 2, решения владельца 29.10, пп. 8–9) — то, что нужно панели экономики (`EconomyPanel.tsx`)
 * и карточке запуска (`GamesLaunchNotice.tsx`, `gamesLaunchRules.ts`). Здесь, а не в отдельном модуле: у панели закрытый
 * перечень импортов, а у этого модуля — ни одного импорта значений.
 *
 * Ползунок подарка — зеркало shared `GAMES_LAUNCH_GIFT` (0…2000 шагом 50, по умолчанию 500); сервер проверяет подарок
 * сам (`isGamesLaunchGift`), разойдись числа — запрос получит понятный отказ `bad-gift`, а не лишние монеты.
 */
export const LAUNCH_GIFT_SLIDER = { min: 0, max: 2000, step: 50, default: 500 } as const;

/**
 * Кнопка «Запустить игры»: сервер её знает (`gamesLaunch` пришло полем — старый сервер не шлёт), игры ещё не запускали
 * и замок открыт для этого человека (`gamesLocked` false: флаг инстанса `GAMES_OPEN` открыт или он супер-админ).
 * Право `MANAGE_ECONOMY` проверено тем, что панель вообще открыта (настройки приходят только ему).
 */
export function launchButtonVisible(v: { gamesLaunch?: GamesLaunchDto | null; gamesLocked?: boolean }): boolean {
  return v.gamesLaunch === null && v.gamesLocked === false;
}

/**
 * Переключатель «Игры» в панели. Прячется, если замок закрыт для этого человека и игры на сервере были выключены
 * (включить их он не может). Игры уже включены (до замка) — оставляем: выключать можно всем. Старый сервер без
 * `gamesLocked` — как раньше.
 */
export function gamesToggleVisible(gamesLocked: boolean | undefined, loadedGamesOn: boolean): boolean {
  return gamesLocked !== true || loadedGamesOn;
}

/** Отметка «видел карточку запуска» — на сервер. Удобство, не данные: потерялась — карточка покажется ещё раз. */
export function launchSeenKey(serverId: string): string {
  return `gv_games_launch_seen:${serverId}`;
}

/** `localStorage` или `null` (приватный режим, запрет хранилища). */
export function launchStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLaunchSeen(store: Pick<Storage, 'getItem'> | null | undefined, serverId: string): boolean {
  try {
    return !!store?.getItem(launchSeenKey(serverId));
  } catch {
    return false;
  }
}

export function writeLaunchSeen(store: Pick<Storage, 'setItem'> | null | undefined, serverId: string): void {
  try {
    store?.setItem(launchSeenKey(serverId), '1');
  } catch {
    /* хранилище недоступно — страховка на сессию у `MainLayout` */
  }
}

/** Снять отметку (запуск из своей панели не удался — карточка должна прийти, когда запустят). */
export function clearLaunchSeen(store: Pick<Storage, 'removeItem'> | null | undefined, serverId: string): void {
  try {
    store?.removeItem(launchSeenKey(serverId));
  } catch {
    /* хранилище недоступно */
  }
}
