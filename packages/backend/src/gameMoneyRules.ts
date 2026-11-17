import { dayStart } from './coinRules.js';

/**
 * Правила денег мини-игр (ГусКоины 2, этап 1) — чистые функции без базы. Транзакции — `gameMoney.ts`.
 *
 * План — `docs/guscoins-v2-plan.md` («Предохранители», «Деньги: гарантии»). Решения владельца: комиссия сгорает (Р2);
 * высокий потолок сервера + самоограничение человека (Р4); выигрыш — НЕ заработок (Р6): причины игр не входят в
 * `EARNED_REASONS`, не растят `earnedTotal`/сезон. Сутки — по Москве (`dayStart`), как во всей экономике.
 */

export type GameKind = 'wheel' | 'duel' | 'prediction';
export const GAME_KINDS: readonly GameKind[] = ['wheel', 'duel', 'prediction'];

/** Причины журнала одной игры: ставка (минус, эскроу), выигрыш и возврат (плюс). */
export interface GameReasons {
  stake: string;
  win: string;
  refund: string;
}

const REASONS: Record<GameKind, GameReasons> = {
  wheel: { stake: 'wheel.bet', win: 'wheel.win', refund: 'wheel.refund' },
  duel: { stake: 'duel.stake', win: 'duel.win', refund: 'duel.refund' },
  prediction: { stake: 'prediction.bet', win: 'prediction.win', refund: 'prediction.refund' },
};

export function gameReasons(kind: GameKind): GameReasons {
  return REASONS[kind];
}

/**
 * Все причины журнала игр. 🔴 Тот же перечень стоит в частичном UNIQUE `coin_ledger_game_once_uq` (миграция 0160) —
 * новая причина игры без новой миграции осталась бы без второго рубежа от двойной выплаты.
 * Комиссии здесь нет: она не строка журнала, а сгорает (разница банка и выплат, `game_rounds.data`).
 */
export const GAME_LEDGER_REASONS: readonly string[] = GAME_KINDS.flatMap((k) => [REASONS[k].stake, REASONS[k].win, REASONS[k].refund]);

/**
 * Доля сундука-джекпота колеса (этап 2, миграция 0161; `data: {roundId, pick: 'jackpot'}`). Выигрыш, НЕ заработок (Р6).
 * Отдельно от девяти «ставка/выигрыш/возврат»: у неё нет ставки. 🔴 Стоит в частичном UNIQUE `coin_ledger_game_once_uq`
 * (миграция 0161 пересоздаёт его с ней).
 */
export const WHEEL_JACKPOT_REASON = 'wheel.jackpot';

/** Строки журнала, из которых складывается суточный итог игр человека: девять причин игр и доля сундука (тоже выигрыш). */
export const GAME_LOSS_REASONS: readonly string[] = [...GAME_LEDGER_REASONS, WHEEL_JACKPOT_REASON];

/** Выбор в раунде (сектор, сторона, исход). У дуэли — `'duel'`. */
export const PICK_MAX_LENGTH = 64;

/** Начало следующих суток МСК — с этого момента вступает в силу отложенное повышение предела. */
export function nextDayStart(now: Date): Date {
  // В Москве нет перехода на летнее время: сутки всегда ровно 24 часа.
  return new Date(dayStart(now).getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Действующий предел проигрыша за сутки: меньший из личного и потолка сервера.
 * `serverMax` 0 — у сервера потолка нет; `personal` null — «как на сервере». `null` в ответе — без предела.
 */
export function effectiveLossLimit(personal: number | null, serverMax: number): number | null {
  const server = serverMax > 0 ? serverMax : null;
  if (personal === null) return server;
  if (server === null) return personal;
  return Math.min(personal, server);
}

/** Личный предел, как он хранится в кошельке: текущий и, возможно, ждущее повышение. */
export interface LossLimitState {
  lossLimit: number | null;
  /** Значение ждущего повышения; null при непустой отметке — «как на сервере». */
  raise: number | null;
  /** Когда повышение вступит в силу; null — повышения не ждём. */
  raiseAt: Date | null;
}

/**
 * Состояние предела НА МОМЕНТ `now`: наступившее повышение уже применено.
 * ⚠️ Чтение кошелька ничего не пишет — повышение применяется виртуально и записывается при следующей правке.
 */
export function resolveLossLimit(s: LossLimitState, now: Date): LossLimitState {
  if (s.raiseAt && now.getTime() >= s.raiseAt.getTime()) return { lossLimit: s.raise, raise: null, raiseAt: null };
  return s;
}

/**
 * Новая просьба человека о пределе → что записать.
 *
 * 🔴 Понижение (или то же) — сразу и отменяет ждущее повышение. Повышение — только с начала следующих суток МСК:
 * иначе самоограничение снимается в тот же вечер, ради которого его ставили. Сравниваются ДЕЙСТВУЮЩИЕ пределы (с
 * потолком сервера): «как на сервере» при сервере 3000 и личном 500 — это повышение.
 */
export function planLossLimit(current: LossLimitState, requested: number | null, serverMax: number, now: Date): LossLimitState {
  const cur = resolveLossLimit(current, now);
  const asNumber = (v: number | null) => v ?? Number.POSITIVE_INFINITY;
  const before = asNumber(effectiveLossLimit(cur.lossLimit, serverMax));
  const after = asNumber(effectiveLossLimit(requested, serverMax));
  if (after <= before) {
    // Ничего не повышается по сути (например, null ↔ число выше потолка сервера) — пишем как просили, сразу.
    return { lossLimit: requested, raise: null, raiseAt: null };
  }
  return { lossLimit: cur.lossLimit, raise: requested, raiseAt: nextDayStart(now) };
}

/**
 * «Проиграно за сутки» из суммы строк журнала игр за сутки МСК: ставки минус, выигрыши и возвраты плюс.
 * Чистый выигрыш за день проигрышем не считается (ноль, а не минус). Незакрытая ставка уже считается проигрышем —
 * монеты ушли из кошелька.
 */
export function lossTodayFrom(sumOfGameRowsToday: number): number {
  return sumOfGameRowsToday < 0 ? 0 - sumOfGameRowsToday : 0;
}

/** Снимок «игр» в кошельке (`GET /servers/:id/economy` → `wallet.games`). */
export interface GamesView {
  optOut: boolean;
  lossLimit: number | null;
  /** `value` null — повышение до «как на сервере». */
  lossLimitRaise: { value: number | null; from: string } | null;
  lossToday: number;
  effectiveLimit: number | null;
}

export function gamesView(i: { gamesOptOut: boolean; limit: LossLimitState; serverMax: number; lossToday: number; now: Date }): GamesView {
  const s = resolveLossLimit(i.limit, i.now);
  return {
    optOut: i.gamesOptOut,
    lossLimit: s.lossLimit,
    lossLimitRaise: s.raiseAt ? { value: s.raise, from: s.raiseAt.toISOString() } : null,
    lossToday: i.lossToday,
    effectiveLimit: effectiveLossLimit(s.lossLimit, i.serverMax),
  };
}

export type StakeBlock =
  | 'games-off'
  | 'bot'
  | 'opted-out'
  | 'games-opted-out'
  | 'bad-amount'
  | 'bad-pick'
  | 'over-bet-max'
  | 'poor'
  | 'loss-limit'
  | 'round-closed'
  | 'duplicate';

export interface StakeCheck {
  economyEnabled: boolean;
  gamesEnabled: boolean;
  isBot: boolean;
  optedOut: boolean;
  gamesOptOut: boolean;
  amount: number;
  pick: string;
  betMax: number;
  balance: number;
  lossToday: number;
  /** Действующий предел (`effectiveLossLimit`); null — без предела. */
  effectiveLimit: number | null;
}

/**
 * Можно ли поставить. Порядок — от «игр нет вовсе» к деньгам: человеку называется самая общая причина.
 * 🔴 Бот не играет никогда: `applyCoins` бота — тихий ноль, и без явной проверки второй участник заплатил бы в пустоту.
 * ⚠️ `optedOut` (отказ от экономики) выключает и игры; `gamesOptOut` — только игры.
 */
export function stakeBlock(c: StakeCheck): StakeBlock | null {
  if (!c.economyEnabled || !c.gamesEnabled) return 'games-off';
  if (c.isBot) return 'bot';
  if (c.optedOut) return 'opted-out';
  if (c.gamesOptOut) return 'games-opted-out';
  if (!Number.isInteger(c.amount) || c.amount <= 0) return 'bad-amount';
  if (c.pick.length === 0 || c.pick.length > PICK_MAX_LENGTH) return 'bad-pick';
  if (c.amount > c.betMax) return 'over-bet-max';
  if (c.amount > c.balance) return 'poor';
  if (c.effectiveLimit !== null && c.lossToday + c.amount > c.effectiveLimit) return 'loss-limit';
  return null;
}

/** Текст отказа — человеку. */
export const STAKE_BLOCK_TEXT: Record<StakeBlock, string> = {
  'games-off': 'На этом сервере игр нет',
  bot: 'Боты не играют',
  'opted-out': 'Ты не участвуешь в экономике — включи в настройках сервера',
  'games-opted-out': 'Игры у тебя выключены — включи в кошельке',
  'bad-amount': 'Неверная ставка',
  'bad-pick': 'Неверный выбор',
  'over-bet-max': 'Ставка больше, чем можно на этом сервере',
  poor: 'Не хватает монет',
  'loss-limit': 'На сегодня предел проигрыша исчерпан — завтра снова',
  'round-closed': 'Ставки на этот раунд уже не принимаются',
  duplicate: 'Эта ставка уже сделана',
};

/** Ставка в общем банке (дуэль, прогноз). `key` — любой идентификатор ставки у вызывающего. */
export interface PotStake {
  key: string;
  amount: number;
  winner: boolean;
}

export interface PotSplit {
  /** Выплата на каждую ставку (0 — проиграла). При возврате — сама ставка. */
  payouts: Map<string, number>;
  /** Сгорело: банк минус сумма выплат. */
  fee: number;
  /** Никто не угадал (или никто не проиграл) — всем вернуть ставки, комиссии нет. */
  refundAll: boolean;
}

/**
 * Делёж банка с комиссией (дуэль, прогноз).
 *
 * Комиссия — `feePercent` от банка вниз; остаток делится между угадавшими пропорционально ставкам, дробь вниз, всё,
 * что не разошлось из-за округления, тоже сгорает (комиссия = банк − Σ выплат). Монеты из воздуха не появляются никогда.
 * Никто не угадал — возврат всем. Никто не проиграл (все на одном исходе) — тоже возврат: забирать комиссию,
 * когда никто ничего не выиграл, значило бы просто сжечь людям деньги.
 */
export function splitPot(stakes: PotStake[], feePercent: number): PotSplit {
  const payouts = new Map<string, number>();
  const pot = stakes.reduce((s, x) => s + x.amount, 0);
  const winners = stakes.filter((x) => x.winner);
  const winStake = winners.reduce((s, x) => s + x.amount, 0);
  if (winners.length === 0 || winners.length === stakes.length || winStake <= 0) {
    for (const x of stakes) payouts.set(x.key, x.amount);
    return { payouts, fee: 0, refundAll: true };
  }
  const pct = Math.min(100, Math.max(0, Math.floor(feePercent)));
  const distributable = pot - Math.floor((pot * pct) / 100);
  let paid = 0;
  for (const x of stakes) {
    const p = x.winner ? Math.floor((distributable * x.amount) / winStake) : 0;
    payouts.set(x.key, p);
    paid += p;
  }
  return { payouts, fee: pot - paid, refundAll: false };
}

/*
 * ——— «Запустить игры» и замок игр до приёмки (решения владельца 29.10, пп. 8–9) ———
 * Замок: пока флаг инстанса `GAMES_OPEN` выключен (`env.gamesOpen`, читает `coins.gamesOpenOnInstance`), ВКЛЮЧИТЬ игры
 * сервера может только супер-админ — переключателем «Игры» (`PATCH /servers/:id/economy`) или кнопкой «Запустить игры»
 * (`POST /servers/:id/games/launch`, `routes/gameWheel.ts`). Выключить — любой управляющий экономикой, как и раньше.
 * Запуск: разовая отметка + подарок сидевшим в голосе (`gameWheel.launchGames`). Числа ползунка подарка — shared
 * `gameLaunch.ts`. Здесь, а не отдельным модулем: у маршрутов экономики и игр закрытые перечни импортов в проверках.
 */

/** Причина журнала «подарок за запуск игр». НЕ заработок (не растит `earnedTotal`/сезон) и не в перечне игр. */
export const GAMES_LAUNCH_REASON = 'games.launch';

export type GamesLaunchRefusal = 'games-locked' | 'forbidden' | 'economy-off' | 'already-launched' | 'bad-gift';

/** Отказы — `{error, reason, message}`, как у ставок колеса (`routes/gameWheel.ts`). */
export const GAMES_LAUNCH_REFUSAL_TEXT: Record<GamesLaunchRefusal, string> = {
  'games-locked': 'Игры на этом инстансе пока закрыты: включить их может только администратор инстанса',
  forbidden: 'Запускать игры может только тот, кто управляет экономикой сервера',
  'economy-off': 'Сначала включите монеты на сервере',
  'already-launched': 'Игры на этом сервере уже запущены',
  'bad-gift': 'Подарок — от 0 до 2000 монет шагом 50',
};

/** HTTP-код: неверный ввод — 400, «нельзя тебе» — 403, состояние сервера — 409. */
export function gamesLaunchRefusalStatus(code: GamesLaunchRefusal): number {
  if (code === 'bad-gift') return 400;
  if (code === 'games-locked' || code === 'forbidden') return 403;
  return 409;
}

/** Закрыт ли замок для этого человека: `true` — включать игры ему нельзя (флаг закрыт и он не супер-админ). */
export function gamesLockedFor(gamesOpen: boolean, superAdmin: boolean): boolean {
  return !gamesOpen && !superAdmin;
}

/**
 * Отказать ли правке настроек из-за замка. Только ВКЛЮЧЕНИЕ: `want === true` при выключенных сейчас играх.
 * ⚠️ Панель шлёт настройки ЦЕЛИКОМ (`api.saveEconomy`), и `gamesEnabled: true` в ней — обычное дело у сервера, где
 * игры уже включены (до замка): такое сохранение не включение, его не трогаем. Выключать можно всем.
 */
export function refuseGamesToggle(c: { want: boolean | undefined; wasEnabled: boolean; locked: boolean }): boolean {
  return c.locked && c.want === true && !c.wasEnabled;
}

/**
 * Проверки запуска до транзакции — от общего к частному: замок → право → монеты включены. «Уже запущено» решает сама
 * транзакция (`games_launched_at IS NULL`), подарок — маршрут (`isGamesLaunchGift`). `null` — можно.
 */
export function launchRefusal(c: { locked: boolean; canManage: boolean; economyEnabled: boolean }): GamesLaunchRefusal | null {
  if (c.locked) return 'games-locked';
  if (!c.canManage) return 'forbidden';
  if (!c.economyEnabled) return 'economy-off';
  return null;
}

/** Кого из сидящих в голосе одаривать: прошедшие `eligible` (участник, не бот, не отказался), без повторов, по порядку. */
export function launchRecipients(inVoice: readonly string[], eligible: (userId: string) => boolean): string[] {
  return [...new Set(inVoice)].filter(eligible).sort();
}
