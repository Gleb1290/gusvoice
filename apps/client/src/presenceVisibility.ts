import { lastActivityAt, onActivity, osIdleMs } from './afk';
import { effectiveLastActive } from './afkRules';
import { useCall } from './callStore';
import { isMobile } from './hotkeys';
import { useStore } from './store';

/**
 * «Здесь ли человек» для ЛС (08.10, #211, D4/D10, решения владельца 42–44): кадр шлюза `{ t: 'visible', on }` и поле
 * `identify.hidden`. Для ЛС шлюз считает «в сети» только такие соединения (на серверах — сокет, как раньше), и свёрнутое
 * приложение Android (сокет живёт ради сообщений и звонков) больше не показывает собеседнику «в сети» бесконечно, а пуш на
 * телефон не ждёт «человека за устройством», которого нет.
 *
 * Как у Telegram:
 * - вкладка спрятана / приложение в фоне — не здесь (Android: `ConnectionsManager.setAppPaused`; Web K — по blur, но у нас
 *   окно без фокуса остаётся «здесь», решение 43);
 * - на ПК 30 с без ввода — не здесь (Telegram Desktop: `offlineIdleTimeout` = 30000, `Updates::updateOnline`; ввод —
 *   `Application::lastNonIdleTime` = позднее из ввода по всей системе и нажатия / клика / касания / колеса в приложении).
 *   Ввод берём у авто-«отошёл» (`afk.noteActivity`, `afk.osIdleMs` на десктопе) — второго набора слушателей нет. На телефоне
 *   простой не считается: у Telegram для Android его нет, только пауза приложения;
 * - голос и идущий звонок — здесь: Telegram на время звонка держит приложение «не на паузе» (`VoIPService` →
 *   `setAppPaused(false)`); свернул игру в голосе — всё ещё здесь.
 * Сокет не рвём. На Android `visibilitychange` приходит вместе с `onPause` / `onResume` WebView (замер в `codemap/android.md`).
 */

/** Сколько без ввода окно на ПК ещё «здесь» (мс). Telegram Desktop `offlineIdleTimeout`. */
export const PRESENCE_IDLE_MS = 30_000;

/** ЧИСТАЯ: присутствует ли человек на этом устройстве для собеседников в ЛС. */
export function presentForPeers(p: { visible: boolean; idle: boolean; inVoice: boolean; inCall: boolean }): boolean {
  return (p.visible && !p.idle) || p.inVoice || p.inCall;
}

/** ЧИСТАЯ: простаивает ли окно — с последнего ввода (в приложении или, на десктопе, в системе) прошло `PRESENCE_IDLE_MS`. */
export function presenceIdle(lastInputAt: number, now: number): boolean {
  return now - lastInputAt >= PRESENCE_IDLE_MS;
}

/** Считать ли простой на этом устройстве: на телефоне (приложение или касательный экран без мыши) — нет. */
function idleApplies(): boolean {
  if (isMobile()) return false;
  return !(typeof window !== 'undefined' && window.matchMedia?.('(hover: none) and (pointer: coarse)').matches);
}

/** Простаивает ли окно сейчас (ведёт `watchPresence`). */
let idleNow = false;

/** Сейчас, по документу, простою и сторам. Без `document` (тесты, сервер) — здесь. */
export function presentNow(): boolean {
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return presentForPeers({
    visible,
    idle: idleNow,
    inVoice: useStore.getState().voice !== null,
    inCall: useCall.getState().call?.phase === 'active',
  });
}

const listeners = new Set<(present: boolean) => void>();
let watching = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Подписаться на смену «здесь» (зовётся только на смене). Слушатели документа, ввода и сторов ставятся один раз за жизнь
 * страницы; подписчики — шлюз текущего инстанса (`sockets.ts`) и фоновые шлюзы соседей (`bgGateways.ts`).
 */
export function watchPresence(onChange: (present: boolean) => void): void {
  listeners.add(onChange);
  if (watching || typeof document === 'undefined') return;
  watching = true;
  let last = presentNow();
  const check = () => {
    const now = presentNow();
    if (now === last) return;
    last = now;
    for (const fn of listeners) fn(now);
  };
  document.addEventListener('visibilitychange', check);
  useStore.subscribe((s, prev) => {
    if ((s.voice === null) !== (prev.voice === null)) check();
  });
  useCall.subscribe((s, prev) => {
    if (s.call?.phase !== prev.call?.phase) check();
  });
  if (!idleApplies()) return;
  /*
   * Простой (решение 44): таймер на «последний ввод + 30 с». Сработал — спросить системный простой (десктоп): ввод был в другой
   * программе — ждать следующего срока; нет — «не здесь». Пока простаиваем, системный ввод DOM-событий не даёт, поэтому на
   * десктопе спрашиваем раз в 2 с (дёшево); в браузере системного ответа нет, и возврат — по первому вводу в приложении.
   */
  const arm = (ms: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void probe(), Math.max(ms, 250));
  };
  const probe = async () => {
    idleTimer = null;
    const now = Date.now();
    const os = await osIdleMs();
    const lastInput = effectiveLastActive({ webLastActive: lastActivityAt(), osIdleMs: os, now });
    const idle = presenceIdle(lastInput, now);
    if (idle !== idleNow) {
      idleNow = idle;
      check();
    }
    if (!idle) arm(lastInput + PRESENCE_IDLE_MS - now);
    else if (os !== null) arm(2000);
  };
  onActivity(() => {
    if (idleNow) {
      idleNow = false;
      check();
    }
    if (!idleTimer) arm(PRESENCE_IDLE_MS);
  });
  arm(PRESENCE_IDLE_MS);
}
