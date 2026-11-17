/**
 * «Запустить игры» (ГусКоины 2, решения владельца 29.10, пп. 8–9) — общие числа и DTO запуска мини-игр на сервере.
 *
 * Запуск — разовое действие управляющего: включает игры, ставит отметку «запущено» (`server_economy.games_launched_*`,
 * миграция 0166) и дарит `gift` монет каждому, кто в этот момент сидит в голосовых каналах сервера. Логика —
 * `backend/src/gameLaunch.ts`, правила отказов — `backend/src/gameLaunchRules.ts`, кнопка — `EconomyPanel.tsx`, карточка —
 * `GamesLaunchNotice.tsx`.
 *
 * 🔴 Без зависимостей: модуль читают и бэкенд, и клиент.
 */

/** Ползунок подарка в кнопке запуска: 0…2000 шагом 50, по умолчанию 500 (решение 29.10, п. 8). */
export const GAMES_LAUNCH_GIFT = { min: 0, max: 2000, step: 50, default: 500 } as const;

/** Сколько после запуска карточка «Игры пришли в голос» ещё всплывает тем, кто был офлайн (7 суток). */
export const GAMES_LAUNCH_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Подарок — целое в пределах ползунка и кратное шагу. */
export function isGamesLaunchGift(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= GAMES_LAUNCH_GIFT.min &&
    n <= GAMES_LAUNCH_GIFT.max &&
    n % GAMES_LAUNCH_GIFT.step === 0
  );
}

/**
 * Запуск игр сервера в снимке экономики (`GET /servers/:id/economy`, поле `gamesLaunch`). `null` — ещё не запускали.
 * ⚠️ Поле ДОБАВЛЕНО: старый сервер его не шлёт, старый клиент не читает.
 */
export interface GamesLaunchDto {
  /** Когда запустили (ISO). */
  at: string;
  /** Сколько дарили каждому сидевшему в голосе. */
  gift: number;
  /** Сколько досталось МНЕ (0 — не был в голосе, отказался от экономики/игр, бот). */
  mine: number;
}

/** Ответ `POST /servers/:id/games/launch`. */
export interface GamesLaunchResult {
  at: string;
  gift: number;
  /** Скольким подарили. */
  people: number;
}
