/**
 * «Колесо гусей-пиратов» (ГусКоины 2, этап 2) — общие чистые правила сервера и клиента.
 *
 * 🔴 Без зависимостей: ни `node:crypto`, ни DOM. Хеш считают вызывающие (сервер — `node:crypto`, клиент —
 * `crypto.subtle`), сюда приходят готовые байты. Так клиент проверяет честность раунда ТЕМ ЖЕ кодом, которым
 * сервер выбирал сектор (проверяемая честность, развилка Р5): до ставок виден `commit` = sha256 от зерна,
 * после итога — само зерно, и любой пересчитает сектор.
 *
 * Раскладка и порядок секторов — ровно как нарисовано (арт `wheel.json`, по часовой от «12 часов»); фаза +7.2°
 * уже запечена в картинке, поэтому сектор 0 стоит под указателем после поворота на `wheelRestAngle(0)`.
 * Выплаты — развилка Р1 «ровные ~92 %», включая ставку, дробь вниз.
 */

export type WheelPick = 1 | 3 | 5 | 10 | 20;
export const WHEEL_PICKS: readonly WheelPick[] = [1, 3, 5, 10, 20];
/** 25 секторов по часовой от «12 часов»: 12×1, 6×3, 4×5, 2×10, 1×20. */
export const WHEEL_SECTORS: readonly WheelPick[] = [
  5, 1, 20, 1, 3, 1, 3, 1, 10, 1, 3, 1, 5, 1, 3, 1, 5, 1, 10, 1, 3, 1, 5, 1, 3,
];
/** Выплата ВКЛЮЧАЯ ставку, в сотых (×1.9 / ×3.8 / ×5.75 / ×11.5 / ×23). */
export const WHEEL_PAYOUT_X100: Record<WheelPick, number> = { 1: 190, 3: 380, 5: 575, 10: 1150, 20: 2300 };
/** Окно ставок от ПЕРВОЙ ставки раунда. */
export const WHEEL_BET_WINDOW_MS = 30_000;
export const WHEEL_SPIN_MS = 6_000;
/** Пауза после итога, пока колесо не примет ставку нового раунда. */
export const WHEEL_COOLDOWN_MS = 10_000;
/**
 * Джекпот срывается в одном раунде из N (по хешу зерна). 500 — решение владельца 29.10 («реже и жирнее», было 200).
 * Срыв решается при блокировке раунда и пишется в раунд (`data.jackpotHit`), поэтому уже запертые/рассчитанные раунды
 * смена N не трогает; проверка честности в браузере (`verifyWheelResult`) пересчитывает только замок и сектор.
 * Смещение `% 500` от uint32 — ~1e-7 относительных (2^32 mod 500 = 296), для частоты срыва несущественно.
 */
export const WHEEL_JACKPOT_ODDS = 500;
/** Доля каждой ставки в сундук, базисные пункты (1.5 %) — из доли дома, не сверху ставки (Р0). */
export const WHEEL_JACKPOT_SHARE_BP = 150;
const SECTOR_DEG = 360 / 25;

export function isWheelPick(v: unknown): v is WheelPick {
  return typeof v === 'number' && (WHEEL_PICKS as readonly number[]).includes(v);
}

export function wheelPayout(pick: WheelPick, amount: number, sectorIndex: number): number {
  return WHEEL_SECTORS[sectorIndex] === pick ? Math.floor((amount * WHEEL_PAYOUT_X100[pick]) / 100) : 0;
}

function uint32At(hash: Uint8Array, i: number): number {
  return ((hash[i] << 24) | (hash[i + 1] << 16) | (hash[i + 2] << 8) | hash[i + 3]) >>> 0;
}

/**
 * Сектор из хеша без смещения: окна по 4 байта подряд, первое значение ниже границы кратности 25 → `% 25`.
 * ⚠️ Простой `% 25` от uint32 чуть чаще давал бы младшие секторы — для «проверяемо честного» это недопустимо.
 */
export function sectorFromHash(hash: Uint8Array): number {
  const limit = 2 ** 32 - (2 ** 32 % 25);
  let v = 0;
  for (let i = 0; i + 4 <= hash.length; i += 4) {
    v = uint32At(hash, i);
    if (v < limit) return v % 25;
  }
  return v % 25;
}

export function jackpotFromHash(hash: Uint8Array): boolean {
  return uint32At(hash, 0) % WHEEL_JACKPOT_ODDS === 0;
}

/** Взнос ставки в сундук, в сотых монеты. */
export function jackpotCentsOf(amount: number): number {
  return Math.floor((amount * WHEEL_JACKPOT_SHARE_BP) / 100);
}

/** Делёж сундука пропорционально сумме ставок в раунде; монеты вниз, остаток в сотых остаётся в сундуке. */
export function splitJackpot(
  poolCents: number,
  stakes: { userId: string; total: number }[],
): { shares: { userId: string; coins: number }[]; leftCents: number } {
  const sum = stakes.reduce((s, x) => s + Math.max(0, x.total), 0);
  if (sum <= 0 || poolCents <= 0) return { shares: [], leftCents: Math.max(0, poolCents) };
  const shares = stakes
    .filter((x) => x.total > 0)
    .map((x) => ({ userId: x.userId, coins: Math.floor((poolCents * x.total) / sum / 100) }));
  const paidCents = shares.reduce((s, x) => s + x.coins * 100, 0);
  return { shares: shares.filter((x) => x.coins > 0), leftCents: poolCents - paidCents };
}

/** Строки под sha256 (UTF-8). `seedHex` — 64 hex-символа нижним регистром. */
export const wheelCommitInput = (roundId: string, seedHex: string) => `gv-wheel-commit:${roundId}:${seedHex}`;
export const wheelSectorInput = (roundId: string, seedHex: string) => `gv-wheel-sector:${roundId}:${seedHex}`;
export const wheelJackpotInput = (roundId: string, seedHex: string) => `gv-wheel-jackpot:${roundId}:${seedHex}`;

/** Поворот колеса по часовой (градусы), при котором сектор встаёт под неподвижный указатель. */
export function wheelRestAngle(sectorIndex: number): number {
  return (((360 - (sectorIndex * SECTOR_DEG + SECTOR_DEG / 2)) % 360) + 360) % 360;
}

export interface WheelBetDto {
  userId: string;
  pick: WheelPick;
  amount: number;
}

export interface WheelRoundDto {
  id: string;
  state: 'open' | 'locked';
  lockAt: string;
  settleAt: string | null;
  commit: string;
  /** Известен только в `locked` — до блокировки клиент видит лишь `commit`. */
  sector: number | null;
  bets: WheelBetDto[];
}

export interface WheelResultDto {
  id: string;
  sector: number;
  seed: string;
  commit: string;
  jackpotHit: boolean;
  jackpotPaid: number;
  /**
   * Срыв навязан флагом тестового инстанса `WHEEL_FORCE_JACKPOT` (не по зерну) — такой раунд не честный, и проверка в
   * браузере говорит «принудительный (dev)». Поле добавлено позже: нет поля = обычный раунд.
   */
  forced?: boolean;
  settledAt: string;
  winners: { userId: string; pick: WheelPick | 'jackpot'; payout: number }[];
}

export interface WheelSnapshotDto {
  serverId: string;
  serverNow: string;
  enabled: boolean;
  betMax: number;
  /** Сундук, целые монеты (`floor(cents / 100)`). */
  jackpot: number;
  round: WheelRoundDto | null;
  last: WheelResultDto | null;
  cooldownUntil: string | null;
}
