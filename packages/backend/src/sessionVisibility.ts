/**
 * «В сети» в ЛС только у соединения, где человек «здесь» (08.10, #211, D4/D10, решения владельца 42–44). Раньше «в сети» =
 * открыт сокет шлюза, и свёрнутое приложение Android, которое держит сокет ради сообщений и звонков, показывало собеседнику
 * «в сети» бесконечно. На серверах так и остаётся (как Discord): серверный онлайн считает сокеты, этот модуль его не трогает.
 *
 * Клиент сообщает шлюзу «здесь / нет»: поле `identify.hidden` (сокет открылся, когда приложение уже в фоне) и кадр
 * `{ t: 'visible', on }` (скрыто, свёрнуто или 30 с без ввода на ПК — и не в голосе, не в звонке). Ушедшее соединение
 * перестаёт считаться через `HIDDEN_OFFLINE_MS`, вернувшееся — сразу. Сокет при этом не рвётся. Клиент без этих полей
 * (выпущенные APK и десктопы) — «здесь» всегда, как раньше.
 *
 * Задержка ухода — как у Telegram для Android: `MessagesController.updateTimerProc` шлёт `account.updateStatus offline`
 * не раньше 2 с после паузы приложения (`ConnectionsManager.getPauseTime`); возврат — сразу (`setAppPaused(false)`).
 * Здесь без таймеров и сокетов, чтобы проверялось тестом: таймер и «стал / перестал считаться» даёт обвязка (`gateway.ts`).
 */

/** Сколько скрытое соединение ещё считается «в сети» (мс). Telegram Android: 2 с после паузы. */
export const HIDDEN_OFFLINE_MS = 2_000;

export interface SessionVisibilityDeps<C> {
  graceMs: number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Соединение стало считаться «здесь» (обвязка: счёт `presentCount`, `online.away: false` соседям). */
  show: (conn: C) => void;
  /** Соединение перестало считаться (обвязка: счёт `presentCount`, `online.away: true`, если сокеты ещё есть). */
  hide: (conn: C) => void;
}

export interface SessionVisibility<C> {
  /** Соединение представилось (`identify`); `hidden` — приложение уже в фоне. */
  open(conn: C, hidden: boolean): void;
  /** Кадр `visible`: `hidden = !on`. До `open` и после `close` — ничего. */
  set(conn: C, hidden: boolean): void;
  /** Соединение закрылось. */
  close(conn: C): void;
  /** Скрыто ли соединение сейчас (по последнему кадру, без задержки) — для «за устройством» (`isUserActive`). */
  isHidden(conn: C): boolean;
  /** Считается ли соединение «в сети» сейчас. */
  isCounted(conn: C): boolean;
}

interface State {
  hidden: boolean;
  counted: boolean;
  timer: unknown;
}

export function createSessionVisibility<C extends object>(deps: SessionVisibilityDeps<C>): SessionVisibility<C> {
  const states = new WeakMap<C, State>();

  function stopTimer(st: State): void {
    if (st.timer === null) return;
    deps.cancel(st.timer);
    st.timer = null;
  }

  return {
    open(conn, hidden) {
      if (states.has(conn)) return;
      const st: State = { hidden, counted: !hidden, timer: null };
      states.set(conn, st);
      if (st.counted) deps.show(conn);
    },
    set(conn, hidden) {
      const st = states.get(conn);
      if (!st) return;
      st.hidden = hidden;
      if (!hidden) {
        stopTimer(st);
        if (!st.counted) {
          st.counted = true;
          deps.show(conn);
        }
        return;
      }
      if (!st.counted || st.timer !== null) return;
      st.timer = deps.schedule(() => {
        st.timer = null;
        if (!st.hidden || !st.counted || states.get(conn) !== st) return;
        st.counted = false;
        deps.hide(conn);
      }, deps.graceMs);
    },
    close(conn) {
      const st = states.get(conn);
      if (!st) return;
      states.delete(conn);
      stopTimer(st);
      if (st.counted) {
        st.counted = false;
        deps.hide(conn);
      }
    },
    isHidden(conn) {
      return states.get(conn)?.hidden === true;
    },
    isCounted(conn) {
      return states.get(conn)?.counted === true;
    },
  };
}
