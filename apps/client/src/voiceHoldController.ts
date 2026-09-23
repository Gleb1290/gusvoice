/**
 * Запись голосового из строки ввода — жизненный цикл без React и DOM (#159; вынос для тестов 22.09).
 *
 * Пороги жеста — `voiceHold.ts`; здесь то, что между нажатием и отправкой: микрофон открывается
 * асинхронно, палец к тому времени может быть отпущен или уведён, система может оборвать жест, а
 * запись без рук останавливают «стопом» и слушают перед отправкой. `MessagePane` только переводит
 * события указателя в `press`/`move`/`release`/`abort` и рисует `getState()`.
 *
 * Снаружи — микрофон (`openMic`), отправка, тосты, вибрация, часы и адрес файла для прослушивания.
 */

import { voiceHoldRelease, voiceHoldStep } from './voiceHold';

/** Сколько контроллеру нужно от готовой записи. `VoiceTake` подходит как есть. */
export interface HoldTake {
  durationMs: number;
}

/** Сколько контроллеру нужно от идущей записи. `VoiceRecording` подходит как есть. */
export interface HoldRecording<T extends HoldTake> {
  startedAt: number;
  level: () => number;
  stop: () => Promise<T>;
  cancel: () => void;
}

export interface VoiceHoldState<T extends HoldTake> {
  /** Микрофон открыт и пишет. */
  recording: boolean;
  /** Идёт остановка/отправка — новую запись не начинаем. */
  recBusy: boolean;
  /** Сколько уже записано (встаёт на потолке вместе с самой записью). */
  recMs: number;
  /** Громкость для полоски, 0..1. */
  recLevel: number;
  /** Остановленная запись, которую слушают перед отправкой. `null` — слушать нечего. */
  preview: { take: T; url: string } | null;
  /** Смещение пальца для подсказок; `null` — пальца на кнопке нет. */
  holdUi: { dx: number; dy: number } | null;
}

export interface VoiceHoldDeps<T extends HoldTake> {
  /** Открыть микрофон (в первый раз — через системный запрос разрешения). Отказ — отклонённый промис. */
  openMic: () => Promise<HoldRecording<T>>;
  send: (take: T) => Promise<void>;
  /** Адрес файла для прослушивания (`URL.createObjectURL`) и его возврат (`revokeObjectURL`). */
  previewUrl: (take: T) => string;
  releasePreviewUrl: (url: string) => void;
  toast: (kind: 'error' | 'info', title: string, body?: string) => void;
  toastError: (err: unknown) => void;
  vibrate?: () => void;
  /** Часы жеста (`performance.now`) — от них «короткое касание». */
  now: () => number;
  /** Часы записи (`Date.now`) — от них таймер; `startedAt` записи в тех же часах. */
  wallNow: () => number;
  /** Потолок длины записи (`VOICE_MAX_MS`). */
  maxMs: number;
  /** Состояние сменилось — перерисовать. */
  onChange: (state: VoiceHoldState<T>) => void;
}

/** Нажатие, которое может ещё дождаться микрофона. `dead` — запись, открывшаяся к нему, закрывается сразу. */
type HoldToken = { mode: 'hold' | 'locked' | 'dead' };

/** Точка указателя: `id` — `pointerId`, координаты — экранные. */
export interface HoldPoint {
  id: number;
  x: number;
  y: number;
}

/** Меньше половины секунды — промах по кнопке, а не сообщение (тот же порог, что `VOICE_HOLD.minHoldMs`). */
const MIN_TAKE_MS = 500;

export function createVoiceHoldController<T extends HoldTake>(deps: VoiceHoldDeps<T>) {
  let state: VoiceHoldState<T> = {
    recording: false,
    recBusy: false,
    recMs: 0,
    recLevel: 0,
    preview: null,
    holdUi: null,
  };
  let rec: HoldRecording<T> | null = null;
  /** Палец сейчас на кнопке. Запись без рук — это «запись идёт, а пальца нет», отдельного состояния нет. */
  let hold: { id: number; x0: number; y0: number; t0: number; token: HoldToken } | null = null;
  let lastToken: HoldToken | null = null;
  /** Запись без жеста (`start`) ждёт микрофона. */
  let opening: HoldToken | null = null;
  /** Нажатие, начатое, когда запись уже шла без рук (или слушают): это «отправить», а не новая запись. */
  let lockedPress: number | null = null;

  function set(patch: Partial<VoiceHoldState<T>>): void {
    const prevUrl = state.preview?.url;
    state = { ...state, ...patch };
    // Адрес файла живёт ровно пока жив плеер: сменилось прослушивание — старый отпускаем.
    if (prevUrl && state.preview?.url !== prevUrl) deps.releasePreviewUrl(prevUrl);
    deps.onChange(state);
  }

  function holdEnd(): void {
    hold = null;
    set({ holdUi: null });
  }

  /**
   * Запись без жеста — кнопка на компьютере, пункт шторки «+», клавиатура: сразу без рук.
   *
   * 🔴 Одна на раз (Codex 22.09, баг жил и до выноса): микрофон открывается асинхронно, и второе нажатие
   * до открытия запускало вторую запись — `rec` доставался второй, первая оставалась с занятым микрофоном
   * и без кнопки «стоп». `opening` — открытие идёт; пока оно идёт, ни `start`, ни `press` новую не заводят.
   */
  async function start(): Promise<void> {
    if (opening || rec || state.recording || state.preview || state.recBusy) return;
    const token: HoldToken = { mode: 'locked' };
    opening = token;
    try {
      const r = await deps.openMic();
      // Ушли со страницы, пока спрашивали разрешение (`dispose`) — закрываем сразу.
      if (token.mode === 'dead') {
        r.cancel();
        return;
      }
      rec = r;
      set({ recMs: 0, recLevel: 0, recording: true });
    } catch {
      // Единственная реальная причина — отказ в доступе к микрофону; говорим прямо.
      if (token.mode !== 'dead') deps.toast('error', 'Нет доступа к микрофону');
    } finally {
      if (opening === token) opening = null;
    }
  }

  function cancel(): void {
    rec?.cancel();
    rec = null;
    set({ recording: false });
  }

  /** Отпустил палец / «отправить» в записи без рук: остановить и отправить. */
  async function finish(): Promise<void> {
    const r = rec;
    if (!r) return;
    rec = null;
    set({ recording: false, recBusy: true });
    try {
      const take = await r.stop();
      // Полсекунды — это промах по кнопке, а не сообщение. Молча выбрасываем.
      if (take.durationMs < MIN_TAKE_MS) return;
      await deps.send(take);
    } catch (err) {
      deps.toastError(err);
    } finally {
      set({ recBusy: false });
    }
  }

  /**
   * «Стоп» в записи без рук: остановить и дать послушать, прежде чем отправить. `recording` гасим
   * вместе с появлением прослушивания, а не раньше: остановка занимает мгновение, и строка ввода
   * успевала бы моргнуть пустой между записью и плеером.
   */
  async function stop(): Promise<void> {
    const r = rec;
    if (!r) return;
    rec = null;
    let preview: VoiceHoldState<T>['preview'] = state.preview;
    try {
      const take = await r.stop();
      // Полсекунды — промах, как и в `finish`: слушать там нечего.
      if (take.durationMs >= MIN_TAKE_MS) preview = { take, url: deps.previewUrl(take) };
    } catch (err) {
      deps.toastError(err);
    } finally {
      set({ recording: false, preview });
    }
  }

  async function sendPreview(): Promise<void> {
    const p = state.preview;
    if (!p) return;
    set({ preview: null, recBusy: true });
    try {
      await deps.send(p.take);
    } catch (err) {
      deps.toastError(err);
    } finally {
      set({ recBusy: false });
    }
  }

  function discardPreview(): void {
    if (state.preview) set({ preview: null });
  }

  /**
   * Палец лёг на кнопку. `'hold'` — началось удержание (вызывающему стоит захватить указатель, чтобы
   * палец, уехавший с кнопки, продолжал вести жест); `'send-press'` — нажатие будет «отправить»;
   * `'ignored'` — второй палец или идёт отправка.
   */
  function press(p: HoldPoint): 'hold' | 'send-press' | 'ignored' {
    if ((state.recording && !hold) || state.preview) {
      lockedPress = p.id;
      return 'send-press';
    }
    lockedPress = null;
    // Идёт открытие записи без жеста — второй микрофон не заводим.
    if (hold || state.recBusy || opening) return 'ignored';
    const token: HoldToken = { mode: 'hold' };
    lastToken = token;
    hold = { id: p.id, x0: p.x, y0: p.y, t0: deps.now(), token };
    set({ recMs: 0, recLevel: 0, holdUi: { dx: 0, dy: 0 } });
    /**
     * ⚠️ Микрофон открывается асинхронно, и палец к этому моменту может быть уже отпущен или уведён.
     * Запись, пришедшая к мёртвому нажатию, тут же закрывается — иначе микрофон остался бы гореть без
     * интерфейса. К зафиксированному (`locked`) — идёт без рук.
     */
    deps.openMic().then(
      (r) => {
        if (token.mode === 'dead') {
          r.cancel();
          return;
        }
        rec = r;
        set({ recording: true });
        deps.vibrate?.();
      },
      () => {
        if (hold?.token === token) holdEnd();
        token.mode = 'dead';
        deps.toast('error', 'Нет доступа к микрофону');
      },
    );
    return 'hold';
  }

  function move(p: HoldPoint): void {
    const h = hold;
    if (!h || h.id !== p.id) return;
    const dx = p.x - h.x0;
    const dy = p.y - h.y0;
    const step = voiceHoldStep(dx, dy);
    if (step === 'lock') {
      h.token.mode = 'locked';
      holdEnd();
      deps.vibrate?.();
      return;
    }
    if (step === 'cancel') {
      h.token.mode = 'dead';
      holdEnd();
      cancel();
      deps.vibrate?.();
      return;
    }
    set({ holdUi: { dx, dy } });
  }

  function release(p: Pick<HoldPoint, 'id'>): void {
    if (lockedPress === p.id) {
      lockedPress = null;
      if (state.preview) void sendPreview();
      else if (state.recording && !hold) void finish();
      return;
    }
    const h = hold;
    if (!h || h.id !== p.id) return;
    holdEnd();
    if (voiceHoldRelease(deps.now() - h.t0) === 'short') {
      h.token.mode = 'dead';
      cancel();
      deps.toast('info', 'Держи кнопку, пока говоришь', 'Или смахни вверх — запись пойдёт без рук');
      return;
    }
    // Микрофон так и не открылся (висел запрос разрешения) — отправлять нечего.
    if (!rec) {
      h.token.mode = 'dead';
      return;
    }
    void finish();
  }

  /** Жест оборвала система (входящий звонок, запрос разрешения, потерян захват) — сказанное не отправляем. */
  function abort(p: Pick<HoldPoint, 'id'>): void {
    if (lockedPress === p.id) lockedPress = null;
    const h = hold;
    if (!h || h.id !== p.id) return;
    h.token.mode = 'dead';
    holdEnd();
    cancel();
  }

  /** Клик без указателя — только клавиатура (у настоящего касания `detail` ≥ 1): запись без рук. */
  function keyboardClick(): void {
    if (state.preview) void sendPreview();
    else if (state.recording) void finish();
    else void start();
  }

  /** Такт таймера и уровня, пока идёт запись. */
  function tick(): void {
    const r = rec;
    if (!r) return;
    // Таймер встаёт на потолке вместе с самой записью, а не бежит дальше в пустоту.
    set({ recMs: Math.min(deps.wallNow() - r.startedAt, deps.maxMs), recLevel: r.level() });
  }

  /**
   * Ушли со страницы: глушим микрофон (иначе индикатор записи в браузере горит, а устройство занято),
   * открывающийся — пусть закроется сам, когда откроется; адрес прослушивания отпускаем.
   */
  function dispose(): void {
    rec?.cancel();
    rec = null;
    if (lastToken) lastToken.mode = 'dead';
    if (opening) opening.mode = 'dead';
    if (state.preview) {
      deps.releasePreviewUrl(state.preview.url);
      state = { ...state, preview: null };
    }
  }

  return {
    getState: () => state,
    press,
    move,
    release,
    abort,
    keyboardClick,
    start,
    cancel,
    finish,
    stop,
    sendPreview,
    discardPreview,
    tick,
    dispose,
  };
}

export type VoiceHoldController<T extends HoldTake> = ReturnType<typeof createVoiceHoldController<T>>;
