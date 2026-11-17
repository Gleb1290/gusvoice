import type { DuelTwentyOneDto } from './duel21.js';

/**
 * «Гусиная дуэль» (ГусКоины 2, этап 3) — общие чистые правила сервера и клиента. Первая игра — «Кубики»: по 2d6
 * каждому, больше сумма — очко; новая партия до двух побед с одним банком, прежняя без цели — до одной.
 * Ничья — переброс без очка; исчерпание бюджета бросков без победителя — возврат обоим.
 *
 * 🔴 Без зависимостей, как `wheel.ts`: хеш считают вызывающие (сервер — `node:crypto`, клиент — `crypto.subtle`), сюда
 * приходят готовые байты. Зерно берётся при ВЫЗОВЕ, `commit = sha256(duelCommitInput)` виден в приглашении до ставок,
 * кости броска n — `sha256(duelRollInput(n))`; после итога клиент получает зерно и пересчитывает всё тем же кодом.
 * Все броски (вместе с перебросами) решены при принятии — кнопка «Бросить» только раскрывает уже решённое.
 */

/**
 * Игры дуэли. Этап 4 (ГусКоины 2): `rps` — «Камень-ножницы-бумага» до `RPS_WINS` побед, ходы скрыты до раскрытия обоих;
 * `greedy` — «Жадный гусь», копилка до `GREEDY_TARGET`. ⚠️ Добавлением: старый клиент знает только `dice` — выборные игры
 * сервер даёт вызвать лишь сопернику, чей клиент объявил шлюзу `FEATURE_DUEL2` (`ws.ts`).
 */
export type DuelGame = 'dice' | 'rps' | 'greedy' | 'twentyone';
export const DUEL_GAMES: readonly DuelGame[] = ['dice', 'rps', 'twentyone'];
/** Игры с выбором игрока (исход можно направить): на них действует суточный предел пары. */
export const DUEL_CHOICE_GAMES: readonly DuelGame[] = ['rps', 'greedy', 'twentyone'];
/** Срок ответа на вызов. */
export const DUEL_INVITE_MS = 30_000;
/** На нажатие «Бросить»; не нажал — бросок за него делает сервер. */
export const DUEL_ROLL_TURN_MS = 15_000;
/** Анимация одного броска на клиенте (итог рассчитывается не раньше, чем она доиграет). */
export const DUEL_ROLL_ANIM_MS = 1_500;
/** Бюджет перебросов сверх максимума очковых бросков (legacy: 1 + бюджет, новая партия: 3 + бюджет). */
export const DUEL_MAX_REROLLS = 5;
/** Новые кубики: одна ставка на партию до двух побед в бросках. */
export const DUEL_DICE_WINS = 2;
/** «Реванш» — новый вызов той же паре не раньше чем через столько после итога. */
export const DUEL_REMATCH_PAUSE_MS = 10_000;
/** Видимая сцена продлевает готовность раз в 2 с; просрочка только приостанавливает серию. */
export const DUEL_SERIES_LEASE_MS = 8_000;
export const DUEL_SERIES_PULSE_MS = 2_000;

export interface DuelSeriesDto {
  id: string;
  /** Номер ПАРТИИ в этой серии, начиная с 1 (не внутренний раунд КНБ). */
  round: number;
  /** Стороны привязаны к неизменным challengerId/targetId всей серии. */
  score: { challenger: number; target: number; draws: number };
  status: 'offered' | 'active' | 'waiting' | 'paused' | 'stopped';
  nextAt: string | null;
  stopReason?: 'user_stop' | 'idle' | 'unavailable' | 'settings_changed' | 'cancelled';
  pauseReason?: 'lease_expired' | 'not_ready';
  /** Commit следующей партии публикуется ДО новых ставок. Зерна здесь нет. */
  nextRoundId?: string;
  nextCommit?: string;
}

export interface DuelSeriesPulse {
  clientId: string;
  roundId: string;
  visible: boolean;
  ready: boolean;
}

export function isDuelGame(v: unknown): v is DuelGame {
  return v === 'greedy' || (typeof v === 'string' && (DUEL_GAMES as readonly string[]).includes(v));
}

/** Игра с выбором (`rps`/`greedy`): предел пары и возможность клиента `duel2`. */
export function isDuelChoiceGame(game: DuelGame): boolean {
  return (DUEL_CHOICE_GAMES as readonly string[]).includes(game);
}

/** Срок хода в играх с выбором (КНБ — выбрать руку, Жадный гусь — «Бросить ещё»/«Стоп»). */
export const DUEL_MOVE_MS = 20_000;
/** КНБ: партия — до стольких побед в раундах. */
export const RPS_WINS = 2;
/** КНБ: раундов в партии не больше (ничьи переигрываются); не решилось — возврат обоим (`draw-limit`). */
export const RPS_MAX_ROUNDS = 7;
/** Жадный гусь: цель — столько очков в копилке. */
export const GREEDY_TARGET = 20;
/** Жадный гусь: столько просрочек хода подряд — поражение партии. */
export const GREEDY_MAX_TIMEOUTS = 3;

export type DuelSide = 'challenger' | 'target';
export type RpsHand = 'rock' | 'paper' | 'scissors';
export const RPS_HANDS: readonly RpsHand[] = ['rock', 'paper', 'scissors'];

export function isRpsHand(v: unknown): v is RpsHand {
  return typeof v === 'string' && (RPS_HANDS as readonly string[]).includes(v);
}

/** Бьёт ли рука `a` руку `b` (камень > ножницы > бумага > камень). Равные — false в обе стороны. */
export function rpsBeats(a: RpsHand, b: RpsHand): boolean {
  return (a === 'rock' && b === 'scissors') || (a === 'scissors' && b === 'paper') || (a === 'paper' && b === 'rock');
}

/** Победитель раунда КНБ; ничья — null. */
export function rpsRoundWinner(challenger: RpsHand, target: RpsHand): DuelSide | null {
  if (rpsBeats(challenger, target)) return 'challenger';
  if (rpsBeats(target, challenger)) return 'target';
  return null;
}

/** Жадный гусь: кто ходит первым — младший бит первого байта `sha256(greedyFirstInput)` (1 — вызвавший, 0 — цель). */
export const greedyFirstInput = (roundId: string, seedHex: string) => `gv-duel-first:${roundId}:${seedHex}`;
export function greedyFirstSide(hash: Uint8Array): DuelSide {
  return (hash[0] & 1) === 1 ? 'challenger' : 'target';
}

/**
 * Жадный гусь: состояние партии. Бросок номер `n` (сквозной по партии, с нуля) — `diceFromHash(sha256(duelRollInput(n)))[0]`.
 * `winner` — набравший `GREEDY_TARGET`: копилка хода засчитывается и партия кончается сама, «рисковать дальше» нельзя.
 */
export interface GreedyState {
  scores: { challenger: number; target: number };
  turn: DuelSide;
  /** Копилка текущего хода (сгорает на «1»). */
  turnPoints: number;
  /** Номер следующего броска партии. */
  n: number;
  lastRoll: { by: DuelSide; die: number } | null;
  /** Сколько сгорело последним броском («1»); иначе 0. */
  burned: number;
  winner: DuelSide | null;
}

export function greedyStart(first: DuelSide): GreedyState {
  return { scores: { challenger: 0, target: 0 }, turn: first, turnPoints: 0, n: 0, lastRoll: null, burned: 0, winner: null };
}

const otherSide = (s: DuelSide): DuelSide => (s === 'challenger' ? 'target' : 'challenger');

/**
 * Один шаг Жадного гуся. `roll` — бросок `die` (1..6, из зерна по `s.n`): «1» сжигает копилку хода и передаёт ход, 2–6
 * копятся; набрал цель — победа. `stop` — копилка в счёт, ход сопернику; с пустой копилкой «Стоп» нельзя (иначе можно
 * вечно пасовать) — `null`. Партия решена или кость не 1..6 — `null`.
 */
export function greedyStep(s: GreedyState, move: 'roll' | 'stop', die = 0): GreedyState | null {
  if (s.winner) return null;
  const scores = { ...s.scores };
  if (move === 'stop') {
    if (s.turnPoints <= 0) return null;
    scores[s.turn] += s.turnPoints;
    return { ...s, scores, turn: otherSide(s.turn), turnPoints: 0, burned: 0 };
  }
  if (!Number.isInteger(die) || die < 1 || die > 6) return null;
  const lastRoll = { by: s.turn, die };
  if (die === 1) return { ...s, scores, turn: otherSide(s.turn), turnPoints: 0, n: s.n + 1, lastRoll, burned: s.turnPoints };
  const turnPoints = s.turnPoints + die;
  if (scores[s.turn] + turnPoints >= GREEDY_TARGET) {
    scores[s.turn] += turnPoints;
    return { ...s, scores, turnPoints: 0, n: s.n + 1, lastRoll, burned: 0, winner: s.turn };
  }
  return { ...s, scores, turnPoints, n: s.n + 1, lastRoll, burned: 0 };
}

function uint32At(hash: Uint8Array, i: number): number {
  return ((hash[i] << 24) | (hash[i + 1] << 16) | (hash[i + 2] << 8) | hash[i + 3]) >>> 0;
}

/**
 * Четыре кости из хеша без смещения: окна по 4 байта подряд (big-endian), значение ниже границы кратности 6 → `v % 6 + 1`.
 * Порядок: [кость 1 вызвавшего, кость 2 вызвавшего, кость 1 цели, кость 2 цели]. Окон 8 на 32 байта, нужно 4; отбрасывание
 * случается с вероятностью 4/2³² на окно — на случай исчерпания недостающие кости берутся из последнего окна по модулю.
 */
export function diceFromHash(hash: Uint8Array): [number, number, number, number] {
  const limit = 2 ** 32 - (2 ** 32 % 6);
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i + 4 <= hash.length && out.length < 4; i += 4) {
    v = uint32At(hash, i);
    if (v < limit) out.push((v % 6) + 1);
  }
  while (out.length < 4) out.push((v % 6) + 1);
  return [out[0], out[1], out[2], out[3]];
}

/** Строки под sha256 (UTF-8). `seedHex` — 64 hex-символа нижним регистром, `n` — номер броска с нуля. */
export const duelCommitInput = (roundId: string, seedHex: string) => `gv-duel-commit:${roundId}:${seedHex}`;
export const duelRollInput = (roundId: string, seedHex: string, n: number) => `gv-duel-roll:${roundId}:${seedHex}:${n}`;

/** Ничья в броске [a1, a2, b1, b2] — суммы равны. */
export function duelRollIsDraw(roll: readonly [number, number, number, number]): boolean {
  return roll[0] + roll[1] === roll[2] + roll[3];
}

/**
 * Исход по броскам до `winsTarget` побед одной стороны; ничья очков не даёт. Без цели — прежняя одна победа.
 * Бюджет — до `2 * winsTarget - 1` очковых бросков плюс `DUEL_MAX_REROLLS` перебросов. Цель не достигнута — возврат.
 * Броски сверх бюджета и после достигнутой цели не смотрятся. Явная цель добавляет `wins`; без аргумента точный legacy-вид `{ winner }`.
 */
export function duelOutcome(rolls: readonly (readonly [number, number, number, number])[]): { winner: DuelSide | null };
export function duelOutcome(rolls: readonly (readonly [number, number, number, number])[], winsTarget: 1 | 2): { winner: DuelSide | null; wins: { challenger: number; target: number } };
export function duelOutcome(rolls: readonly (readonly [number, number, number, number])[], winsTarget?: 1 | 2): { winner: DuelSide | null; wins?: { challenger: number; target: number } } {
  const required = winsTarget ?? 1;
  const wins = { challenger: 0, target: 0 };
  const result = (winner: DuelSide | null) => ({ winner, ...(winsTarget === undefined ? {} : { wins }) });
  const max = Math.min(rolls.length, 2 * required - 1 + DUEL_MAX_REROLLS);
  for (let i = 0; i < max; i++) {
    const r = rolls[i];
    const a = r[0] + r[1];
    const b = r[2] + r[3];
    if (a !== b) {
      const side = a > b ? 'challenger' : 'target';
      if (++wins[side] === required) return result(side);
    }
  }
  return result(null);
}

export interface DuelPlayerRoll {
  /** null — ещё не бросал в этом броске. */
  dice: [number, number] | null;
}

export type DuelState = 'invited' | 'playing' | 'settled' | 'cancelled';
/** `timeout` (этап 4): игры с выбором — просрочка хода; с `winnerId` — поражение молчавшего, без — оба молчали, возврат. */
export type DuelReason = 'declined' | 'expired' | 'withdrawn' | 'player-deleted' | 'games-off' | 'draw-limit' | 'timeout';

/** КНБ наружу (этап 4). 🔴 Нераскрытой руки здесь нет — только «готов»; своя рука — `DuelSnapshotDto.myHand`. */
export interface DuelRpsDto {
  /** Раскрытые раунды по порядку (ничьи тоже, `winner: null`). */
  rounds: { challenger: RpsHand; target: RpsHand; winner: DuelSide | null }[];
  /** Сделал ли ход в текущем раунде. */
  ready: { challenger: boolean; target: boolean };
  wins: { challenger: number; target: number };
  /** `seq` текущего раунда — его шлёт `POST …/move` (= `rounds.length`, пока партия идёт). */
  seq: number;
}

/**
 * Жадный гусь наружу (этап 4). С 29.10 (решение владельца) счёт соперника скрыт до конца партии: пока идут ходы, общий
 * `duel.state` и снимок несут маску `greedyHide` — свою сторону игрок видит, чужую нет, зритель канала не видит ничьей.
 */
export interface DuelGreedyDto {
  scores: { challenger: number; target: number };
  turn: DuelSide;
  turnPoints: number;
  lastRoll: { by: DuelSide; die: number } | null;
  /** Сгорело последним броском («1»), иначе 0. */
  burned: number;
  /** Просрочки хода подряд; `GREEDY_MAX_TIMEOUTS` — поражение. */
  timeouts: { challenger: number; target: number };
  /** `seq` следующего действия — его шлёт `POST …/move`. */
  seq: number;
  /** Кто ходил первым (из зерна, `greedyFirstSide`). */
  first: DuelSide;
  /** Все броски партии по порядку (`n` = индекс) — для «Проверить честность». Под маской — 0 вместо всего, кроме «1». */
  rolls: number[];
  /**
   * Добавлением (29.10): чьи числа скрыты маской `greedyHide` — у стороны с `true` счёт, копилка хода, последний бросок
   * (кроме «1») и сгоревшее — нули/null. Нет поля — всё открыто (итог партии или старый сервер).
   */
  hidden?: { challenger: boolean; target: boolean };
}

/**
 * Маска Жадного гуся для смотрящего `viewer` (игрок — своя сторона видна; зритель — `null`, скрыто всё). Только для
 * партии в игре: решённая/итоговая отдаётся целиком (так раскрывается счёт и работает «Проверить честность»).
 * Видно всем: чей ход, номер действия, первый ход, просрочки, сам факт броска (длина `rolls`) и «1» — сгорание без суммы.
 * Скрыто у чужой стороны: счёт (0), копилка её хода (0), её последний бросок, если не «1» (`lastRoll: null`), сгоревшее (0);
 * значения `rolls` кроме «1» — 0 у всех (по ним счёт сложился бы в уме). ⚠️ Совместимость: поля и типы прежние — старый
 * клиент видит у скрытого нули и кубик без значения (`lastRoll: null`), ничего не падает; признак — `hidden`.
 */
export function greedyHide(g: DuelGreedyDto, viewer: DuelSide | null): DuelGreedyDto {
  const hide = { challenger: viewer !== 'challenger', target: viewer !== 'target' };
  const last = g.lastRoll;
  const lastHidden = !!last && hide[last.by];
  return {
    scores: { challenger: hide.challenger ? 0 : g.scores.challenger, target: hide.target ? 0 : g.scores.target },
    turn: g.turn,
    turnPoints: hide[g.turn] ? 0 : g.turnPoints,
    lastRoll: !last || (lastHidden && last.die !== 1) ? null : { by: last.by, die: last.die },
    burned: lastHidden ? 0 : g.burned,
    timeouts: { challenger: g.timeouts.challenger, target: g.timeouts.target },
    seq: g.seq,
    first: g.first,
    rolls: g.rolls.map((v) => (v === 1 ? 1 : 0)),
    hidden: hide,
  };
}

export interface DuelDto {
  id: string;
  serverId: string;
  channelId: string;
  game: DuelGame;
  challengerId: string;
  targetId: string;
  /** Ставка КАЖДОГО (равные); банк — 2×amount. */
  amount: number;
  /** Комиссия банка, заморожена в момент вызова (ползунок владельца условия не меняет). */
  feePercent: number;
  state: DuelState;
  /** Срок ответа — только у `invited`. */
  inviteUntil: string | null;
  /** sha256 hex от `duelCommitInput` — виден с приглашения. */
  commit: string;
  /** Цель кубиков, замороженная до ставки; отсутствие — прежняя одна победа. */
  diceTarget?: 1 | 2;
  /** Номер текущего броска (0 — первый). */
  rollNo: number;
  /** `playing`: дедлайн нажатия «Бросить» текущего броска; когда раскрыты обе стороны — null. */
  turnUntil: string | null;
  /** ТОЛЬКО раскрытые кости: по броску 0..rollNo, сторона, что ещё не бросала, — null. */
  rolls: { challenger: [number, number] | null; target: [number, number] | null }[];
  winnerId: string | null;
  /** Выплата победителю (банк минус комиссия, дробь вниз); у ничьей после лимита — null. */
  payout: number | null;
  /** Зерно — только у `settled`. */
  seed: string | null;
  reason: DuelReason | null;
  settledAt: string | null;
  /** Этап 4 (добавлением): КНБ — только у `game: 'rps'` после принятия. */
  rps?: DuelRpsDto;
  /** Этап 4: Жадный гусь — только у `game: 'greedy'` после принятия. */
  greedy?: DuelGreedyDto;
  /** «21» — обе попытки завершаются до сравнения; неизвестное поле старый клиент игнорирует. */
  twentyOne?: DuelTwentyOneDto;
  /** Этап 4: срок текущего хода игры с выбором; у кубиков и вне хода — null. */
  moveUntil?: string | null;
  /** Добавлением: отсутствие — одиночная партия. Старый accept НЕ согласие на серию. */
  series?: DuelSeriesDto;
}

/** Снимок `GET /servers/:id/duel?channelId=`: партия канала (видна сидящим в нём и игрокам) и входящий вызов мне на этом сервере. */
export interface DuelSnapshotDto {
  duel: DuelDto | null;
  myInvite: DuelDto | null;
  serverNow: string;
  /** Этап 4: своя рука КНБ в текущем раунде (только лично спрашивающему игроку; ход не сделан — null). */
  myHand?: RpsHand | null;
  /** Потолок ставки и комиссия сервера — для формы вызова (настройки сервера обычный участник не видит). Нет у старого сервера. */
  betMax?: number;
  feePercent?: number;
}
