import {
  diceFromHash,
  duelCommitInput,
  duelRollInput,
  greedyFirstInput,
  greedyFirstSide,
  RPS_MAX_ROUNDS,
  type DuelDto,
  type DuelGame,
  type RpsHand,
} from '@gusvoice/shared';
import { sha256, wheelBetErrorText } from './wheelRules';

/**
 * Гусиная дуэль (ГусКоины 2, этап 3) — чистые правила клиента: время по часам сервера, банк и выплата, стороны и
 * кости, тексты отказов и «Проверить честность». Слияние событий шлюза со стором — в `store.ts` (`applyDuelState`), как у
 * колеса: у стора закрытая граница импортов в тестах.
 */

/** Партия (или вызов) + поправка часов по `serverNow` того ответа/события, с которым она пришла. */
export interface DuelView {
  duel: DuelDto;
  skewMs: number;
  /** Только серии: watermark серверного времени, чтобы поздний GET не стирал более свежий push. */
  serverNowMs?: number;
  /**
   * Этап 4: своя рука КНБ в текущем раунде (`rps.seq`) — только из личного ответа (снимок `myHand`, ответ на ход);
   * в событии шлюза её нет, стор переносит её, пока раунд тот же (`applyDuelState`). Нет поля — ход не сделан/не КНБ.
   */
  myHand?: RpsHand | null;
}

/** Игры дуэли для формы вызова и подписей: название и одна строка правил (этап 4 — две игры с выбором). */
export const DUEL_GAME_INFO: Record<DuelGame, { title: string; rule: string }> = {
  dice: { title: 'Кубики', rule: 'По два кубика за бросок. Партия до двух побед: больше сумма — очко, ничья — переброс. Одна ставка на всю партию.' },
  rps: { title: 'Камень-ножницы-бумага', rule: 'Оба выбирают тайно, руки открываются разом. До двух побед, ничья — ещё раз.' },
  greedy: {
    title: 'Жадный гусь',
    rule: 'Бросай кубик и копи очки хода, пока не скажешь «Стоп». Выпала единица — копилка сгорела. Первый набрал 20 или больше — победил. Перебора нет.',
  },
  twentyone: {
    title: '21',
    rule: 'По два стартовых кубика, затем добор по очереди или «Стоп». Побеждает ближайший к 21 без перебора, когда оба закончат.',
  },
};

/** Эта версия клиента умеет показать игру. Игры новее — без ходов, с подсказкой обновиться. */
export function duelGameKnown(game: string | null | undefined): game is DuelGame {
  return game === 'dice' || game === 'rps' || game === 'greedy' || game === 'twentyone';
}

/** Название игры; неизвестная (игра новее этого клиента) — просто «Дуэль». */
export function duelGameTitle(game: string | null | undefined): string {
  return duelGameKnown(game) ? DUEL_GAME_INFO[game].title : 'Дуэль';
}

/** Название игры в середине фразы: «кубики», «камень-ножницы-бумага», «жадный гусь»; неизвестная — «дуэль». */
export function duelGameWord(game: string | null | undefined): string {
  return duelGameTitle(game).toLowerCase();
}

/** Руки КНБ: значок и подпись (кнопки хода и раскрытие), в порядке кнопок. */
export const RPS_HAND_INFO: Record<RpsHand, { emoji: string; label: string }> = {
  rock: { emoji: '✊', label: 'Камень' },
  scissors: { emoji: '✌️', label: 'Ножницы' },
  paper: { emoji: '✋', label: 'Бумага' },
};

/** Игроков вызов/партия ещё касается: ждём ответа или кидаем кости. */
export function duelLive(v: DuelView | null | undefined): boolean {
  return !!v && (v.duel.state === 'invited' || v.duel.state === 'playing');
}

/** Сколько мс до срока по часам сервера (`skewMs` = сервер − мы); нет срока или битая дата — 0. */
export function duelLeftMs(iso: string | null, skewMs: number, nowMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, t - (nowMs + skewMs)) : 0;
}

/**
 * Банк и выплата: ставки равные, банк 2×N, комиссия `feePercent` банка вниз сгорает (как `splitPot` этапа 1 при одном
 * победителе: выплата = банк − ⌊банк·%/100⌋).
 */
export function duelPot(amount: number, feePercent: number): { pot: number; fee: number; payout: number } {
  const pot = Math.max(0, Math.floor(amount)) * 2;
  const pct = Math.min(100, Math.max(0, Math.floor(feePercent)));
  const fee = Math.floor((pot * pct) / 100);
  return { pot, fee, payout: pot - fee };
}

export type DuelSide = 'challenger' | 'target';

export function duelSideOf(duel: Pick<DuelDto, 'challengerId' | 'targetId'>, userId: string | null | undefined): DuelSide | null {
  if (!userId) return null;
  if (duel.challengerId === userId) return 'challenger';
  if (duel.targetId === userId) return 'target';
  return null;
}

/**
 * Какие кости показывать стороне сейчас. Текущий бросок (`rollNo`) ещё не раскрыт — показываем прошлый бросок
 * тусклым (`stale`), чтобы после ничьей кубики не пропадали со стола.
 */
export function shownDice(duel: Pick<DuelDto, 'rolls' | 'rollNo' | 'state'>, side: DuelSide): { dice: [number, number] | null; stale: boolean } {
  const cur = duel.rolls[duel.rollNo]?.[side] ?? null;
  if (cur) return { dice: cur, stale: false };
  if (duel.state !== 'playing') {
    // Итог/отмена: последний раскрытый бросок этой стороны.
    for (let i = duel.rolls.length - 1; i >= 0; i--) {
      const d = duel.rolls[i]?.[side];
      if (d) return { dice: d, stale: false };
    }
    return { dice: null, stale: false };
  }
  const prev = duel.rollNo > 0 ? (duel.rolls[duel.rollNo - 1]?.[side] ?? null) : null;
  return { dice: prev, stale: !!prev };
}

/** Сторона уже бросила в текущем броске. */
export function hasRolled(duel: Pick<DuelDto, 'rolls' | 'rollNo'>, side: DuelSide): boolean {
  return !!duel.rolls[duel.rollNo]?.[side];
}

export function diceSum(d: readonly [number, number] | null): number {
  return d ? d[0] + d[1] : 0;
}

/** Реванш доступен через `pauseMs` после итога (по часам сервера). */
export function rematchLeftMs(duel: Pick<DuelDto, 'settledAt' | 'state'>, skewMs: number, nowMs: number, pauseMs: number): number {
  if (duel.state !== 'settled' && duel.state !== 'cancelled') return pauseMs;
  if (!duel.settledAt) return 0;
  const t = Date.parse(duel.settledAt);
  return Number.isFinite(t) ? Math.max(0, t + pauseMs - (nowMs + skewMs)) : 0;
}

/**
 * Почему вызов/партия закончились без победителя — человеку. `game` (этап 4) уточняет `draw-limit` игр с выбором;
 * без него — тексты кубиков, как раньше.
 */
export function duelReasonText(reason: DuelDto['reason'], game?: string): string {
  switch (reason) {
    case 'declined':
      return 'Вызов отклонён';
    case 'expired':
      return 'Вызов остался без ответа';
    case 'withdrawn':
      return 'Вызов отозван';
    case 'player-deleted':
      return 'Игрок удалил аккаунт — ставки вернулись обоим';
    case 'games-off':
      return 'Игры на сервере выключили — ставки вернулись';
    case 'draw-limit':
      if (game === 'rps') return `${RPS_MAX_ROUNDS} раундов без победителя — ставки вернулись обоим`;
      if (game === 'greedy') return 'Партия затянулась — ставки вернулись обоим';
      return 'Шесть ничьих подряд — ставки вернулись обоим';
    case 'timeout':
      if (game === 'twentyone') return 'После автоматического «Стоп» — ничья, ставки вернулись обоим';
      // С победителем — `duelTimeoutNote`; сюда — без него: молчали оба.
      return 'Оба не сходили вовремя — ставки вернулись обоим';
    default:
      return 'Дуэль отменена';
  }
}

/**
 * Отказ сервера — человеку. Код приходит строкой `error` (в `Error.message`) или `reason`; коды денег этапа 1 и общие
 * (`games-off`, `poor`, `loss-limit`…) — как у колеса.
 */
export function duelErrorText(code: string | undefined, fallback = 'Не получилось — попробуй ещё раз'): string {
  switch (code) {
    case 'not_in_voice':
      return 'Дуэль — только для сидящих в этом голосовом канале';
    case 'not_voice_channel':
      return 'Дуэли бывают только в голосовых каналах';
    case 'target_unavailable':
      return 'Этот гусь сейчас не может принять вызов';
    case 'self':
      return 'Себя на дуэль не вызывают';
    case 'busy':
    case 'in_duel':
      return 'Кто-то из вас уже в дуэли или ждёт ответа';
    case 'channel_busy':
      return 'В этом канале уже идёт дуэль — дождись итога';
    case 'cooldown':
      return 'Слишком часто — подожди немного и вызови снова';
    case 'expired':
      return 'Время на ответ вышло';
    case 'not_found':
      return 'Этой дуэли уже нет';
    case 'not_player':
      return 'Ты не участвуешь в этой дуэли';
    case 'not_playing':
      return 'Партия уже не идёт';
    case 'bad-amount':
      return 'Ставка — целое число монет, от одной';
    // Этап 4: игры с выбором.
    case 'pair_limit':
    case 'pair-limit':
      return 'Вы двое на сегодня исчерпали предел выигрыша друг у друга в играх с выбором — сыграйте в кубики или завтра';
    case 'not_your_turn':
      return 'Сейчас ход соперника';
    case 'stale_seq':
      return 'Ход уже засчитан — партия обновилась';
    case 'bad_move':
      return 'Так сходить нельзя';
    // Коды денег этапа 1 — общий текст с колесом.
    case 'games-off':
    case 'opted-out':
    case 'games-opted-out':
    case 'over-bet-max':
    case 'poor':
    case 'loss-limit':
    case 'bot':
      return wheelBetErrorText(code, fallback);
    default:
      return fallback;
  }
}

/**
 * Отказ на вызов: `target_unavailable` у игры с выбором — почти всегда старая версия приложения соперника (сервер
 * зовёт в КНБ и Жадного гуся только клиента с `duel2`); остальное — как `duelErrorText`.
 */
export function duelChallengeErrorText(code: string | undefined, game: DuelGame): string {
  if (code === 'target_unavailable' && game !== 'dice') return 'Эта игра на его версии пока не открывается — позови его на кубики';
  return duelErrorText(code);
}

/** Итог по просрочке хода (`timeout` с победителем): подпись, кто не сходил. Иначе null. */
export function duelTimeoutNote(duel: Pick<DuelDto, 'reason' | 'winnerId' | 'game'>, loserName: string): string | null {
  if (duel.reason !== 'timeout' || !duel.winnerId) return null;
  if (duel.game === 'twentyone') return 'Срок хода истёк — очки сравнили после автоматического «Стоп»';
  return duel.game === 'greedy' ? `${loserName} пропустил ходы — победа по времени` : `${loserName} не сходил вовремя — победа по времени`;
}

/** КНБ: последний раскрытый раунд (руки на столе) или null. */
export function rpsLastRound(duel: Pick<DuelDto, 'rps'>): NonNullable<DuelDto['rps']>['rounds'][number] | null {
  const r = duel.rps?.rounds;
  return r && r.length > 0 ? r[r.length - 1] : null;
}

/** Своя рука КНБ для показа: только в идущей партии КНБ (стор держит её лишь в пределах раунда — `applyDuelState`). */
export function shownMyHand(view: Pick<DuelView, 'duel' | 'myHand'> | null | undefined): RpsHand | null {
  if (!view?.myHand || view.duel.state !== 'playing' || !view.duel.rps) return null;
  return view.myHand;
}

/** Жадный гусь: доля пути к цели (0..1) для полосы счёта. */
export function greedyProgress(score: number, target: number): number {
  return target > 0 ? Math.max(0, Math.min(1, score / target)) : 0;
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export type DuelVerdict =
  | { ok: true; rolls: [number, number, number, number][] }
  | { ok: false; why: 'commit' | 'dice' | 'unavailable' | 'no-seed'; at?: number; got?: [number, number, number, number] };

/**
 * «Проверить честность»: зерно (открыто после итога) даёт тот самый замок `commit`, висевший с вызова, и кости
 * каждого раскрытого броска n: `diceFromHash(SHA-256(gv-duel-roll:id:seed:n))` = [a1, a2, b1, b2]. `digest` подменяемый.
 */
export async function verifyDuel(
  duel: Pick<DuelDto, 'id' | 'seed' | 'commit' | 'rolls'>,
  digest: (text: string) => Promise<Uint8Array | null> = sha256,
): Promise<DuelVerdict> {
  if (!duel.seed) return { ok: false, why: 'no-seed' };
  const commit = await digest(duelCommitInput(duel.id, duel.seed));
  if (!commit) return { ok: false, why: 'unavailable' };
  if (hexOf(commit) !== duel.commit.toLowerCase()) return { ok: false, why: 'commit' };
  const out: [number, number, number, number][] = [];
  for (let n = 0; n < duel.rolls.length; n++) {
    const h = await digest(duelRollInput(duel.id, duel.seed, n));
    if (!h) return { ok: false, why: 'unavailable' };
    const got = diceFromHash(h);
    const r = duel.rolls[n];
    const want = [r.challenger?.[0], r.challenger?.[1], r.target?.[0], r.target?.[1]];
    if (want.some((v, i) => v !== undefined && v !== got[i])) return { ok: false, why: 'dice', at: n, got };
    out.push(got);
  }
  return { ok: true, rolls: out };
}

export type GreedyVerdict =
  | { ok: true; first: 'challenger' | 'target'; rolls: number[] }
  | { ok: false; why: 'commit' | 'first' | 'die' | 'unavailable' | 'no-seed'; at?: number; got?: number };

/** «21»: пара каждой стороны из первого окна (любой порядок раскрытия), доборы из окон n >= 4. */
export async function verifyTwentyOne(
  duel: Pick<DuelDto, 'id' | 'seed' | 'commit' | 'twentyOne'>,
  digest: (text: string) => Promise<Uint8Array | null> = sha256,
): Promise<GreedyVerdict> {
  if (!duel.seed || !duel.twentyOne) return { ok: false, why: 'no-seed' };
  const commit = await digest(duelCommitInput(duel.id, duel.seed));
  if (!commit) return { ok: false, why: 'unavailable' };
  if (hexOf(commit) !== duel.commit.toLowerCase()) return { ok: false, why: 'commit' };
  const fh = await digest(greedyFirstInput(duel.id, duel.seed));
  const ih = await digest(duelRollInput(duel.id, duel.seed, 0));
  if (!fh || !ih) return { ok: false, why: 'unavailable' };
  const first = greedyFirstSide(fh);
  if (first !== duel.twentyOne.first) return { ok: false, why: 'first' };
  const initial = diceFromHash(ih);
  const rolls = duel.twentyOne.rolls.map(r => r.die);
  const started = duel.twentyOne.started;
  if (!started && rolls.length < 4) return { ok: false, why: 'die', at: rolls.length };
  const counts = { challenger: 0, target: 0 };
  let hit = 4;
  for (let n = 0; n < rolls.length; n++) {
    const side = duel.twentyOne.rolls[n].by;
    const count = counts[side]++;
    const index = started ? (count < 2 ? (side === 'challenger' ? 0 : 2) + count : hit++) : n;
    let got = initial[index];
    if (index >= 4) {
      const h = await digest(duelRollInput(duel.id, duel.seed, index));
      if (!h) return { ok: false, why: 'unavailable' };
      got = diceFromHash(h)[0];
    }
    if (got !== rolls[n]) return { ok: false, why: 'die', at: n, got };
  }
  if (started && (['challenger', 'target'] as const).some(side => started[side] ? counts[side] < 2 : counts[side] !== 0)) {
    return { ok: false, why: 'die', at: rolls.length };
  }
  return { ok: true, first, rolls };
}

/**
 * «Проверить честность» Жадного гуся: зерно открывает замок `commit`; кто ходил первым — младший бит
 * `SHA-256(gv-duel-first:id:seed)[0]` (`greedyFirstSide`); бросок n — `diceFromHash(SHA-256(gv-duel-roll:id:seed:n))[0]`.
 * `digest` подменяемый.
 */
export async function verifyGreedy(
  duel: Pick<DuelDto, 'id' | 'seed' | 'commit' | 'greedy'>,
  digest: (text: string) => Promise<Uint8Array | null> = sha256,
): Promise<GreedyVerdict> {
  if (!duel.seed || !duel.greedy) return { ok: false, why: 'no-seed' };
  const commit = await digest(duelCommitInput(duel.id, duel.seed));
  if (!commit) return { ok: false, why: 'unavailable' };
  if (hexOf(commit) !== duel.commit.toLowerCase()) return { ok: false, why: 'commit' };
  const fh = await digest(greedyFirstInput(duel.id, duel.seed));
  if (!fh) return { ok: false, why: 'unavailable' };
  const first = greedyFirstSide(fh);
  if (first !== duel.greedy.first) return { ok: false, why: 'first' };
  const rolls = duel.greedy.rolls;
  for (let n = 0; n < rolls.length; n++) {
    const h = await digest(duelRollInput(duel.id, duel.seed, n));
    if (!h) return { ok: false, why: 'unavailable' };
    const got = diceFromHash(h)[0];
    if (got !== rolls[n]) return { ok: false, why: 'die', at: n, got };
  }
  return { ok: true, first, rolls: [...rolls] };
}

/**
 * Поворот куба, при котором к зрителю смотрит грань `v` (грани в разметке: 1 спереди, 6 сзади, 2 справа, 5 слева,
 * 3 сверху, 4 снизу — сумма противоположных 7, как у настоящей кости).
 */
export const DIE_FACE_ROT: Record<number, string> = {
  1: 'rotateX(0deg) rotateY(0deg)',
  2: 'rotateX(0deg) rotateY(-90deg)',
  3: 'rotateX(-90deg) rotateY(0deg)',
  4: 'rotateX(90deg) rotateY(0deg)',
  5: 'rotateX(0deg) rotateY(90deg)',
  6: 'rotateX(0deg) rotateY(180deg)',
};

/** Точки грани на сетке 3×3 (номера ячеек 0..8) — рисуются `<i>` в разметке, без картинок. */
export const PIP_CELLS: Record<number, number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
