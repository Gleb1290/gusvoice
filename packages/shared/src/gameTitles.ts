/**
 * Лидерборд игр, звания месяца и «Итоги» (ГусКоины 2, этап 6) — общие ключи, названия по умолчанию и DTO.
 *
 * 🔴 Без зависимостей. Ключ звания — стабильный идентификатор (латиница: им же названы иконки `assets/titles/<key>`), его
 * нельзя переименовывать: он лежит в замороженных итогах прошлых месяцев. Название — по умолчанию из этой карты, владелец
 * сервера переименовывает любое (`server_game_titles`); описание «людям» привязано к ПОВОДУ, а не к названию, поэтому верно
 * при любом переименовании. Условия выдачи — `backend/src/gameTitlesRules.ts`. Месяц игр — календарный месяц МСК.
 */

/** 27 званий месяца — в порядке таблицы плана (`docs/guscoins-v2-plan.md`, «Звания: описания и условия выдачи»). */
export const GAME_TITLE_KEYS = [
  'fortune',
  'regular',
  'twenty',
  'pensioner',
  'credit',
  'empty-hold',
  'slowpoke',
  'high-roller',
  'jet',
  'last-second',
  'follower',
  'night-owl',
  'straight-to-business',
  'truth-streak',
  'king-of-hill',
  'fiasco',
  'revenge',
  'sleight-of-hand',
  'english-exit',
  'greed',
  'careful',
  'vanga',
  'against-tide',
  'couch-analyst',
  'bookmaker',
  'hachiko',
  'holy-goose',
] as const;

export type GameTitleKey = (typeof GAME_TITLE_KEYS)[number];

export function isGameTitleKey(v: unknown): v is GameTitleKey {
  return typeof v === 'string' && (GAME_TITLE_KEYS as readonly string[]).includes(v);
}

/** Названия по умолчанию (выбраны владельцем 28.10). */
export const DEFAULT_GAME_TITLE_NAMES: Record<GameTitleKey, string> = {
  fortune: 'Фортуна в перьях',
  regular: 'Постоянный клиент',
  twenty: 'Охотник за двадцаткой',
  pensioner: 'Гусь-пенсионер',
  credit: 'Кредит одобрен',
  'empty-hold': 'Пустой трюм',
  slowpoke: 'Тугодум с крыльями',
  'high-roller': 'Кто не рискует, тот не пьёт шампанское',
  jet: 'Реактивный гусь',
  'last-second': 'Ставки сделаны, ставок больше нет',
  follower: 'Куда все, туда и я',
  'night-owl': 'Полуночник',
  'straight-to-business': 'Сразу к делу',
  'truth-streak': 'Сила в правде',
  'king-of-hill': 'Царь горы',
  fiasco: 'Это фиаско, братан',
  revenge: 'Отыграюсь',
  'sleight-of-hand': 'Ловкость рук и никакого мошенничества',
  'english-exit': 'Ушёл по-английски',
  greed: 'Жадность фраера сгубила',
  careful: 'Бережёного бог бережёт',
  vanga: 'Гусиная Ванга',
  'against-tide': 'Против течения',
  'couch-analyst': 'Аналитик с дивана',
  bookmaker: 'Букмекер в законе',
  hachiko: 'Хатико',
  'holy-goose': 'Святой гусь',
};

/** Описание «людям» — привязано к поводу, верно при любом названии. */
export const GAME_TITLE_ABOUT: Record<GameTitleKey, string> = {
  fortune: 'Чаще всех срывал джекпот колеса в этом месяце.',
  regular: 'Крутил колесо чаще всех.',
  twenty: 'Ставил на «20» чаще всех — верит в большую удачу.',
  pensioner: 'Ставил только на самое частое число — осторожность прежде всего.',
  credit: 'Больше всех оставил колесу в этом месяце.',
  'empty-hold': 'Проиграл почти всё за вечер — и остался с друзьями.',
  slowpoke: 'Дольше всех думал над ходом в дуэлях.',
  'high-roller': 'Сделал самую крупную ставку месяца.',
  jet: 'Ставил на колесе быстрее всех.',
  'last-second': 'Чаще всех ставил в последний момент.',
  follower: 'Чаще всех ставил вслед за другими.',
  'night-owl': 'Главный ночной игрок месяца.',
  'straight-to-business': 'Заходил и сразу играл — молча.',
  'truth-streak': 'Самая длинная серия побед в дуэлях.',
  'king-of-hill': 'Обыграл за вечер всех, кто вызвался.',
  fiasco: 'Проигрывал чаще всех — но не сдавался.',
  revenge: 'Чаще всех требовал реванша.',
  'sleight-of-hand': 'Чаще всех выигрывал «камень-ножницы-бумагу» всухую.',
  'english-exit': 'Чаще всех уходил посреди партии.',
  greed: 'Больше всех очков сгорело в Жадном гусе за один ход.',
  careful: 'Реже всех жадничал в Жадном гусе.',
  vanga: 'Самый точный прогнозист месяца.',
  'against-tide': 'Чаще всех угадывал то, во что не верил почти никто.',
  'couch-analyst': 'Чаще всех ставил против толпы — и мимо.',
  bookmaker: 'Провёл больше всех событий со ставками.',
  hachiko: 'Дольше всех ждал друзей в голосе.',
  'holy-goose': 'Весь месяц был в голосе и ни разу не играл на монеты.',
};

/**
 * В чём измеряется `value` звания: `count` — штук, `coins` — монет, `percent` — целых процентов, `ms` — миллисекунд
 * (медиана), `minutes` — минут, `points` — очков Жадного гуся.
 */
export type GameTitleUnit = 'count' | 'coins' | 'percent' | 'ms' | 'minutes' | 'points';

export const GAME_TITLE_UNIT: Record<GameTitleKey, GameTitleUnit> = {
  fortune: 'count',
  regular: 'count',
  twenty: 'percent',
  pensioner: 'percent',
  credit: 'coins',
  'empty-hold': 'percent',
  slowpoke: 'ms',
  'high-roller': 'coins',
  jet: 'ms',
  'last-second': 'count',
  follower: 'count',
  'night-owl': 'count',
  'straight-to-business': 'count',
  'truth-streak': 'count',
  'king-of-hill': 'count',
  fiasco: 'percent',
  revenge: 'count',
  'sleight-of-hand': 'count',
  'english-exit': 'count',
  greed: 'points',
  careful: 'percent',
  vanga: 'percent',
  'against-tide': 'count',
  'couch-analyst': 'count',
  bookmaker: 'count',
  hachiko: 'minutes',
  'holy-goose': 'minutes',
};

/** Своё название звания — не длиннее. */
export const GAME_TITLE_NAME_MAX = 60;

/** Игры с ведомостью: `wheel` — колесо, `duel` — дуэли, `prediction` — ставки на события. */
export type GameFamily = 'wheel' | 'duel' | 'prediction';

/** Разбивка результата человека за период (живой лидерборд и `game_month_results.stats`). */
export interface GameBoardStats {
  /** Чистый результат по играм (может быть < 0): выигрыши + возвраты − ставки, джекпот — внутри колеса. */
  wheel: number;
  duel: number;
  prediction: number;
  /** Срывы джекпота колеса (раунды с долей сундука) и их сумма. */
  jackpots: number;
  jackpotCoins: number;
  /** Дуэлей с исходом (без возвратов) и побед по видам игры. */
  duels: number;
  duelWins: { dice: number; rps: number; greedy: number; twentyone?: number };
}

export interface GameBoardRowDto extends GameBoardStats {
  place: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Чистый результат по всем играм. Отрицательные — в хвосте таблицы. */
  net: number;
  /** Звания последнего закрытого месяца (ключи) — чипы у строки. */
  titles: GameTitleKey[];
}

/**
 * `GET /servers/:id/games/leaderboard?period=month|season[&month=mYYYY-MM]`. `enabled: false` — игры сервера выключены
 * (или экономика не видна), вкладки нет. Прошлый месяц (`month`) — из заморозки, `frozen: true`.
 */
export interface GameLeaderboardDto {
  enabled: boolean;
  period: { kind: 'month' | 'season'; id: string; name: string; from: string; to: string } | null;
  frozen: boolean;
  people: GameBoardRowDto[];
  /** Имена званий с учётом переименований сервера — для чипов. */
  titleNames: Record<GameTitleKey, string>;
}

export interface GameTitleHolderDto {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Число повода в единицах `GAME_TITLE_UNIT[key]`. */
  value: number;
}

export interface GameTitleDto {
  key: GameTitleKey;
  name: string;
  defaultName: string;
  /** Переименовано владельцем сервера. */
  renamed: boolean;
  about: string;
  unit: GameTitleUnit;
  /** Носители за последний закрытый месяц (пусто — звание в том месяце не выдано). */
  holders: GameTitleHolderDto[];
}

/** `GET /servers/:id/games/titles` и ответ `PATCH /servers/:id/games/titles/:titleId`. */
export interface GameTitlesDto {
  /** Последний закрытый месяц; `partialFrom` — игры включились посреди месяца (ISO первого раунда). */
  month: { id: string; name: string; partialFrom: string | null } | null;
  titles: GameTitleDto[];
  canManage: boolean;
}

/** Рекорд сервера в «Итогах»: `userId` пуст, если держатель отказался от игр или экономики (сумма остаётся). */
export interface RecapRecordDto {
  userId: string | null;
  amount: number;
}

/** Общая часть «Итогов месяца игр». */
export interface GamesRecapServerDto {
  partialFrom: string | null;
  people: number;
  rounds: { wheel: number; duel: number; prediction: number };
  jackpots: number;
  jackpotCoins: number;
  /** Сгорело комиссией и преимуществом колеса (`game_rounds.data.fee`). */
  fees: number;
  biggestBet: RecapRecordDto | null;
  biggestWin: RecapRecordDto | null;
  /** Первое место таблицы (без отказавшихся). */
  topUserId: string | null;
  titles: { key: GameTitleKey; userIds: string[]; value: number }[];
}

/** Личная часть «Итогов месяца игр». */
export interface GamesRecapPersonalDto extends GameBoardStats {
  net: number;
  place: number | null;
  /** Любимое число колеса и сколько раз на него ставил. */
  favoriteNumber: { pick: string; count: number } | null;
  biggestWin: number;
  predictions: { hits: number; misses: number };
  titles: GameTitleKey[];
}

/** Общая часть «Итогов сезона экономики». */
export interface EconomyRecapServerDto {
  /** Заработано за сезон (`EARNED_REASONS`), потрачено в магазине и типами, доля потраченного (целые %). */
  earned: number;
  spent: number;
  spentPercent: number;
  /** Сгорело налогом типов и комиссиями игр. */
  burned: number;
  /** Чистая эмиссия за окно (все строки журнала). */
  minted: number;
  /** Монет на руках на момент заморозки. */
  circulation: number;
  people: number;
  topUserId: string | null;
  voiceHours: number;
  biggestBet: RecapRecordDto | null;
  biggestWin: RecapRecordDto | null;
}

/** Личная часть «Итогов сезона экономики». */
export interface EconomyRecapPersonalDto {
  earned: number;
  spent: number;
  tipsIn: number;
  /** Чистый результат в играх — отдельно от заработка (Р6); `null` — отказался от игр. */
  gamesNet: number | null;
  place: number | null;
  voiceMinutes: number;
  /** Минут один в голосе в отрезках, после которых пришла компания (повод «Хатико»). */
  waitedMinutes: number;
  /** Самая частая покупка: причина журнала `shop.<ключ>` и сколько раз. */
  favoritePurchase: { reason: string; count: number } | null;
}

export type RecapKind = 'economy' | 'games';

/**
 * `GET /servers/:id/economy/recap?kind=economy|games[&period=]` (замороженные, без `period` — последние) и
 * `GET /servers/:id/economy/recap/preview?kind=&period=` (сухой прогон на текущих данных, только `MANAGE_ECONOMY`).
 * `me: null` — у человека нет личной части (отказался или не участвовал).
 */
export interface RecapDto {
  kind: RecapKind;
  periodId: string;
  name: string;
  from: string;
  to: string;
  frozenAt: string | null;
  preview: boolean;
  server: EconomyRecapServerDto | GamesRecapServerDto;
  me: EconomyRecapPersonalDto | GamesRecapPersonalDto | null;
}
