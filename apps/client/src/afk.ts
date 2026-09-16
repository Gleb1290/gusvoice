import { api } from './api';
import { IDLE_MS, effectiveLastActive, shouldGoAway, shouldReturnOnVoice, shouldReturnOnline } from './afkRules';
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
 * Первая версия слушала только `pointerdown`, `keydown`, `wheel`, `touchstart`, а голос не считала
 * вовсе: мол, сидеть молча в канале — это и есть честное «отошёл». На практике это дало ровно
 * обратное. Отзыв с живого (2026-07-20): «пришёл, пошевелил мышкой, размутился, говорю с другом — статус так
 * и остался не-зелёным, у него так же».
 *
 * Разбор показал три дыры сразу:
 *  1. **Движение мыши не событие `pointerdown`.** «Пошевелил мышкой» не порождало НИЧЕГО.
 *  2. **Речь не считалась активностью.** Человек, который прямо сейчас разговаривает, — очевидно
 *     на месте. Оговорка про «сидеть молча» верна, но говорить ≠ сидеть молча.
 *  3. **Игра поверх приложения.** Когда GusVoice в фоне, DOM-события до него не доходят вообще:
 *     микрофон переключают глобальным хоткеем (нативный хук, не `keydown`), говорят в голос — и
 *     веб-слой не видит ни одного признака жизни.
 *
 * Отсюда: движение мыши считается, речь и переключение микрофона/наушников — тоже.
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

/** Любой признак жизни: ввод, движение мыши, речь, переключение микрофона. */
export function noteActivity(): void {
  lastActive = Date.now();
  if (shouldReturnOnline({ status: myStatus(), autoAway: isAutoAway() })) void setStatus('online');
}

function onMove(): void {
  const now = Date.now();
  if (now - lastMoveNote < MOVE_THROTTLE_MS) return;
  lastMoveNote = now;
  noteActivity();
}

/** Простой ввода по всей системе (десктоп). `null` = веб/Android или команда недоступна. */
async function osIdleMs(): Promise<number | null> {
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
  });
  window.addEventListener('focus', noteActivity);

  // Голос как признак присутствия. Работает и когда приложение в фоне, а человек играет и говорит —
  // именно тот случай, когда прежняя версия упорно держала «отошёл».
  let wasSpeaking = false;
  let wasMuted = useStore.getState().selfMuted;
  useStore.subscribe((s) => {
    const meId = s.user?.id;
    const speaking = meId ? (s.liveVoice[meId]?.speaking ?? false) : false;
    if (speaking && !wasSpeaking) noteActivity();
    wasSpeaking = speaking;
    // Переключение микрофона/наушников — тоже действие человека, даже если сделано глобальным
    // хоткеем мимо DOM.
    if (s.selfMuted !== wasMuted) {
      wasMuted = s.selfMuted;
      noteActivity();
    }
  });

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
