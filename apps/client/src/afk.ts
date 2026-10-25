import { api } from './api';
import { IDLE_MS, effectiveLastActive, shouldGoAway, shouldReturnOnline } from './afkRules';
import { windowFocused } from './notifications';
import { noteGatewayActive } from './sockets';
import { useStore } from './store';

/**
 * Auto-away (#16): статус сам уходит в «отошёл» после простоя и возвращается в «в сети» при первом
 * признаке жизни.
 *
 * Трогает ТОЛЬКО пару «в сети» ↔ «отошёл». Статус, который человек поставил сам — «не беспокоить»
 * или «невидимка», — это заявление, и молча перетирать его через десять минут хуже, чем не иметь
 * авто-«отошёл» вовсе. По той же причине обратный переход срабатывает, только если «отошёл»
 * поставили МЫ.
 *
 * ## Что считается активностью — и почему список именно такой
 *
 * Как в Discord (решение владельца 20.10): «отошёл» наступает через десять минут без ВВОДА — мыши, клавиатуры,
 * касания, возврата в окно, на десктопе ещё и простоя ОС (ниже). **Речь и шум микрофона активностью НЕ считаются**,
 * как и переключение микрофона/наушников: человек, который сидит в канале и ничего не трогает, — «отошёл», а
 * микрофон (включая USB-микрофон с HID-шумом, который «двигает» ОС) не должен держать его «в сети» вечно.
 *
 * История, чтобы не повторить: первая версия (#16) слушала только `pointerdown`/`keydown`/`wheel`/`touchstart`.
 * Движение мыши ввели позже (`pointermove` с тормозом) — «пошевелил мышкой» не порождало НИЧЕГО. Затем (1f719e20)
 * добавили «речь снимает отошёл» и «переключение микрофона — активность» ради случая «игра поверх приложения,
 * микрофон хоткеем». Для этого случая теперь есть простой ОС (`gv_os_idle_ms`), а голосовые признаки (шум/речь
 * в открытом микрофоне) мешали «отошёл» появиться у сидящих в канале. Отменено 20.10.
 *
 * ## Простой уровня ОС (десктоп)
 *
 * Оставался последний случай: человек молча играет в полноэкранную игру, GusVoice в фоне, DOM-событий
 * нет ни одного — и через десять минут он «отошёл», сидя за компьютером. Закрыт нативной командой
 * `gv_os_idle_ms` (Windows `GetLastInputInfo`): она возвращает простой ввода по ВСЕЙ системе, мимо
 * нашего окна. В вебе и на Android команды нет — там всё работает ровно как раньше, по DOM.
 *
 * ⚠️ Остаток, который этим НЕ закрывается: `GetLastInputInfo` не видит геймпад (XInput), так что
 * играющий джойстиком молча всё ещё уедет в «отошёл».
 */
const TICK_MS = 30 * 1000;
/** Движение мыши сыплется сотнями событий в секунду — засекаем не чаще раза в это время. */
const MOVE_THROTTLE_MS = 5000;
let started = false;
let lastActive = Date.now();
let lastMoveNote = 0;

function myStatus(): string | undefined {
  return useStore.getState().user?.status;
}

/**
 * Поставила ли текущий статус автоматика. Признак приходит С СЕРВЕРА вместе с профилем и живёт
 * рядом со статусом.
 *
 * 🔴 Раньше он лежал в `localStorage` этого клиента — и это был баг #118. Статус общий для всех
 * клиентов человека, а признак был у каждого свой: снять авто-«отошёл» мог только тот клиент,
 * который его поставил. Любой другой (десктоп против браузера, телефон против ПК, почищенные
 * данные сайта) видел «отошёл», но признака у него не было — и не возвращал статус НИКОГДА,
 * сколько бы человек ни двигал мышью, ни говорил и ни играл.
 */
function isAutoAway(): boolean {
  return useStore.getState().user?.statusAuto === true;
}

/**
 * Сменить статус от имени автоматики.
 *
 * ⚠️ Локально признак не выставляем и заранее не угадываем: и статус, и «кто поставил» меняет
 * сервер одним UPDATE, а ответ приносит их обратно. Прежняя версия ставила флаг ДО запроса и
 * глотала его ошибку — упавший запрос оставлял «мы увели» при статусе `online`, после чего
 * авто-«отошёл» в этом клиенте не работал уже никогда (второй дефект #118).
 */
async function setStatus(status: 'online' | 'away') {
  try {
    const u = await api.setStatus({ status, auto: true });
    useStore.setState((s) => (s.user ? { user: { ...s.user, status: u.status, statusAuto: u.statusAuto } } : {}));
  } catch {
    /* transient — the next tick retries */
  }
}

/**
 * Подписчики на признак жизни (08.10, D4, решение 44): «в сети» в ЛС гаснет после 30 с без ввода и загорается на первом
 * вводе — `presenceVisibility.ts` берёт тот же ввод, что и авто-«отошёл», а не ставит второй набор слушателей.
 */
const activityListeners = new Set<() => void>();
export function onActivity(fn: () => void): void {
  activityListeners.add(fn);
}
/** Когда был последний ввод в самом приложении (мс). */
export function lastActivityAt(): number {
  return lastActive;
}

/** Любой признак жизни: ввод, движение мыши, возврат в окно (НЕ речь и не микрофон — решение 20.10). */
export function noteActivity(): void {
  lastActive = Date.now();
  for (const fn of activityListeners) fn();
  // «За устройством сидят» (G38, `push2`): только когда окно в фокусе — хоткеи из игры телефон не глушат.
  if (windowFocused()) noteGatewayActive(true);
  if (shouldReturnOnline({ status: myStatus(), autoAway: isAutoAway() })) void setStatus('online');
}

function onMove(): void {
  const now = Date.now();
  if (now - lastMoveNote < MOVE_THROTTLE_MS) return;
  lastMoveNote = now;
  noteActivity();
}

/** Простой ввода по всей системе (десктоп). `null` = веб/Android или команда недоступна. */
export async function osIdleMs(): Promise<number | null> {
  const c = (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string) => Promise<unknown> } } })
    .__TAURI__?.core;
  if (!c) return null;
  try {
    const v = await c.invoke('gv_os_idle_ms');
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

async function tick() {
  const now = Date.now();
  const la = effectiveLastActive({ webLastActive: lastActive, osIdleMs: await osIdleMs(), now });
  // Возврат тоже должен уметь опираться на ОС: человек, который вернулся к компьютеру и играет, для
  // DOM по-прежнему невидим — без этой ветки он остался бы «отошёл» до первого клика по GusVoice.
  if (shouldReturnOnline({ status: myStatus(), autoAway: isAutoAway() }) && now - la < IDLE_MS) {
    void setStatus('online');
    return;
  }
  if (!shouldGoAway({ now, lastActive: la, status: myStatus(), autoAway: isAutoAway() })) return;
  void setStatus('away');
}

/** Idempotent; safe to call from the App boot effect. */
export function initAfk(): void {
  if (started) return;
  started = true;
  const opts = { passive: true } as const;
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(ev, noteActivity, opts);
  }
  // Отдельно и с тормозом: движение мыши — самый частый признак «человек вернулся за компьютер».
  window.addEventListener('pointermove', onMove, opts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') noteActivity();
    else noteGatewayActive(false);
  });
  window.addEventListener('focus', noteActivity);
  // Окно ушло из фокуса — телефон снова получает пуш сразу (G38): у Telegram Desktop «не в сети» через 5 с после blur.
  window.addEventListener('blur', () => noteGatewayActive(false));

  window.setInterval(() => void tick(), TICK_MS);
}

/**
 * Человек сменил статус руками — «отошёл» больше не наш, отменять его нельзя.
 *
 * Сам признак снимает СЕРВЕР: запрос из выбора статуса идёт без `auto`, а такой запрос считается
 * ручным и обнуляет «поставила автоматика». Здесь остаётся только сдвинуть отсчёт простоя — иначе
 * человек, поставивший «в сети» на десятой минуте бездействия, тут же уехал бы обратно в «отошёл».
 */
export function noteManualStatusChange(): void {
  lastActive = Date.now();
}
