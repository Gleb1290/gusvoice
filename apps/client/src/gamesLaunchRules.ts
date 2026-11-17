import type { GamesLaunchDto } from '@gusvoice/shared';

/**
 * Сцена «Игры пришли в голос» (ГусКоины 2, решения владельца 29.10, пп. 8–9, 14) — когда показывать при входе
 * (`GamesLaunchNotice.tsx`, показ решает `MainLayout`). Отметка «видел», кнопка запуска и переключатель панели —
 * в `economy.ts` (у панели закрытый перечень импортов). Сервер — `backend/src/gameLaunch.ts`.
 */

/** Что показывает карточка: сервер, когда запустили, сколько дарили и сколько досталось мне. */
export interface GamesLaunchNotice {
  serverId: string;
  at: string;
  gift: number;
  mine: number;
  /** Повтор из «Активностей» («Что это у нас?», 29.10): показать, даже если видел, и без строки о подарке. */
  replay?: boolean;
}

/**
 * Сцена при входе тому, кто запуск пропустил: сервер запущен (`gamesLaunch` в снимке) и сцену на нём ещё не видели.
 * Окна «7 суток» больше нет (владелец 29.10, п. 14: кто зайдёт позже — видит один раз); shared `GAMES_LAUNCH_RECENT_MS`
 * остаётся константой протокола, клиент её не читает. Снимок без `gamesLaunch` (старый сервер, не запускали) или с
 * негодной датой — `null`.
 * `_now` — от прежней подписи (окно по времени), не используется.
 */
export function launchNoticeDue(
  serverId: string,
  launch: GamesLaunchDto | null | undefined,
  seen: boolean,
  _now?: number,
): GamesLaunchNotice | null {
  if (!launch || seen || !Number.isFinite(Date.parse(launch.at))) return null;
  return { serverId, at: launch.at, gift: launch.gift, mine: launch.mine };
}
