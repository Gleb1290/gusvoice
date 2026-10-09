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

import { VOICE_HOLD, voiceHoldRelease, voiceHoldStep } from './voiceHold';

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
  /** Пауза со снимком записанного (`VoiceRecording.pause`); нет — «стоп» останавливает запись насовсем. */
  pause?: () => Promise<T>;
  resume?: () => void;
  /** Записано без пауз, мс; нет — таймер по часам от `startedAt`. */
  elapsed?: () => number;
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
  /**
   * Прослушивание — это запись на паузе: её можно продолжить (`resume`), а «отправить» допишет файл до конца
   * (Telegram Desktop: замок в режиме прослушивания — «Продолжить запись», `lng_record_lock_resume`).
   */
  paused: boolean;
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
  /**
   * Короче — не отправляем (телефон: Android `duration > 700`, компьютер: Telegram Desktop — секунда). Функция: раскладка
   * может смениться посреди жизни контроллера. Нет — порог телефона `VOICE_HOLD.minHoldMs`.
   */
  minTakeMs?: () => number;
  /** Подсказка жеста после промаха («Удерживайте для записи», Android `HoldToAudioOnly`); нет — тост. */
  hint?: () => void;
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


export function createVoiceHoldController<T extends HoldTake>(deps: VoiceHoldDeps<T>) {
  let state: VoiceHoldState<T> = {
    recording: false,
    recBusy: false,
    recMs: 0,
    recLevel: 0,
    preview: null,
    paused: false,
    holdUi: null,
  };
  let rec: HoldRecording<T> | null = null;
  /** Запись на паузе, которую сейчас слушают: «продолжить» вернёт её в `rec`, «отправить» допишет и отправит. */
  let pausedRec: HoldRecording<T> | null = null;
  /** Рекордер, чью остановку ждёт `stop`; поколение растёт в `dispose` — поздний ответ после ухода не создаёт прослушивание. */
  let stopping: HoldRecording<T> | null = null;
  let generation = 0;
  const minTake = () => deps.minTakeMs?.() ?? VOICE_HOLD.minHoldMs;
  /** Палец сейчас на кнопке. Запись без рук — это «запись идёт, а пальца нет», отдельного состояния нет. */
  let hold: {
    id: number;
    x0: number;
    y0: number;
    t0: number;
    token: HoldToken;
    /** Компьютер: увод влево не отменяет — отменяет отпускание вне полосы (Telegram Desktop `stop(_inField)`). */
    desktop: boolean;
    /** Путь отмены (`voiceCancelPath`) и последнее смещение — для отмены отпусканием на 0,55 пути. */
    path: number;
    dx: number;
  } | null = null;
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
    if (opening || rec || pausedRec || state.recording || state.preview || state.recBusy) return;
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
      // Короче порога — промах по кнопке, а не сообщение. Молча выбрасываем (Telegram так же).
      if (take.durationMs < minTake()) return;
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
    // Пока ждём остановку, рекордер ни в `rec`, ни в `pausedRec`: `dispose` в этот промежуток найдёт его здесь,
    // а поздний ответ по смене поколения поймёт, что экран ушёл (находка Codex R40).
    stopping = r;
    const gen = generation;
    let preview: VoiceHoldState<T>['preview'] = state.preview;
    let paused = false;
    try {
      if (r.pause) {
        // Пауза: микрофон за нами, записанное до паузы слушаем, «продолжить» пишет дальше в тот же файл.
        const take = await r.pause();
        if (gen !== generation) {
          r.cancel();
          return;
        }
        pausedRec = r;
        paused = true;
        preview = { take, url: deps.previewUrl(take) };
      } else {
        const take = await r.stop();
        if (gen !== generation) return;
        // Короче порога — промах, как и в `finish`: слушать там нечего.
        if (take.durationMs >= minTake()) preview = { take, url: deps.previewUrl(take) };
      }
    } catch (err) {
      // Пауза не удалась — микрофон не оставляем гореть без интерфейса.
      if (r.pause && !paused) r.cancel();
      if (gen === generation) deps.toastError(err);
    } finally {
      if (stopping === r) stopping = null;
      if (gen === generation) set({ recording: false, preview, paused });
    }
  }

  /** «Продолжить запись» из прослушивания: тот же рекордер пишет дальше, прослушивание уходит. */
  function resume(): void {
    const r = pausedRec;
    if (!r || !state.preview) return;
    pausedRec = null;
    rec = r;
    r.resume?.();
    set({ preview: null, paused: false, recording: true, recLevel: 0 });
  }

  async function sendPreview(): Promise<void> {
    const p = state.preview;
    if (!p) return;
    const r = pausedRec;
    pausedRec = null;
    set({ preview: null, paused: false, recBusy: true });
    try {
      if (r) {
        // Запись на паузе: дописать файл до конца (снимок прослушивания — не последний кусок).
        const take = await r.stop();
        if (take.durationMs < minTake()) return;
        await deps.send(take);
        return;
      }
      await deps.send(p.take);
    } catch (err) {
      deps.toastError(err);
    } finally {
      set({ recBusy: false });
    }
  }

  function discardPreview(): void {
    pausedRec?.cancel();
    pausedRec = null;
    if (state.preview) set({ preview: null, paused: false });
  }

  /**
   * Черновик голосового (08.10, G54): вернуть прослушивание записи, сохранённой при уходе из беседы. Микрофона за ней нет —
   * «Продолжить запись» не предлагается. Идёт своя запись или прослушивание — `false`, ничего не меняется.
   */
  function restorePreview(take: T): boolean {
    if (opening || rec || pausedRec || stopping || state.recording || state.preview || state.recBusy || hold) return false;
    set({ preview: { take, url: deps.previewUrl(take) }, paused: false });
    return true;
  }

  /**
   * Уход из беседы с прослушиванием (G54): микрофон отпускается, записанное отдаётся черновиком (снимок паузы — весь файл
   * до паузы). Идёт запись или слушать нечего — `null` (тогда уход спрашивает, как раньше).
   */
  function detachPreview(): T | null {
    const p = state.preview;
    if (!p || rec || state.recording || state.recBusy) return null;
    pausedRec?.cancel();
    pausedRec = null;
    set({ preview: null, paused: false });
    return p.take;
  }

  /** Есть что терять: идёт запись, открывается микрофон или слушают несохранённое — уход спрашивает подтверждение. */
  function active(): boolean {
    return !!opening || !!rec || state.recording || !!state.preview || !!hold;
  }

  /**
   * Палец лёг на кнопку. `'hold'` — началось удержание (вызывающему стоит захватить указатель, чтобы
   * палец, уехавший с кнопки, продолжал вести жест); `'send-press'` — нажатие будет «отправить»;
   * `'ignored'` — второй палец или идёт отправка.
   */
  function press(
    p: HoldPoint,
    opts: { desktop?: boolean; path?: number } = {},
  ): 'hold' | 'send-press' | 'ignored' {
    if ((state.recording && !hold) || state.preview) {
      lockedPress = p.id;
      return 'send-press';
    }
    lockedPress = null;
    // Идёт открытие записи без жеста — второй микрофон не заводим.
    if (hold || state.recBusy || opening) return 'ignored';
    const token: HoldToken = { mode: 'hold' };
    lastToken = token;
    hold = {
      id: p.id,
      x0: p.x,
      y0: p.y,
      t0: deps.now(),
      token,
      desktop: !!opts.desktop,
      path: opts.path ?? VOICE_HOLD.cancelDx,
      dx: 0,
    };
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
    h.dx = dx;
    const step = voiceHoldStep(h.desktop ? 0 : dx, dy, h.path);
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

  /** `outside` — компьютер: кнопку отпустили вне полосы записи и строки ввода — отмена (Telegram Desktop). */
  function release(p: Pick<HoldPoint, 'id'> & { outside?: boolean }): void {
    if (lockedPress === p.id) {
      lockedPress = null;
      if (state.preview) void sendPreview();
      else if (state.recording && !hold) void finish();
      return;
    }
    const h = hold;
    if (!h || h.id !== p.id) return;
    holdEnd();
    const verdict = h.desktop
      ? p.outside
        ? 'cancel'
        : 'send'
      : voiceHoldRelease(deps.now() - h.t0, h.dx, h.path);
    if (verdict === 'cancel') {
      h.token.mode = 'dead';
      cancel();
      deps.vibrate?.();
      return;
    }
    if (verdict === 'short') {
      h.token.mode = 'dead';
      cancel();
      if (deps.hint) deps.hint();
      else deps.toast('info', 'Держи кнопку, пока говоришь', 'Или смахни вверх — запись пойдёт без рук');
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
    // Таймер встаёт на потолке вместе с самой записью, а не бежит дальше в пустоту; паузы не считает.
    const ms = r.elapsed ? r.elapsed() : deps.wallNow() - r.startedAt;
    set({ recMs: Math.min(ms, deps.maxMs), recLevel: r.level() });
  }

  /**
   * Ушли со страницы: глушим микрофон (иначе индикатор записи в браузере горит, а устройство занято),
   * открывающийся — пусть закроется сам, когда откроется; адрес прослушивания отпускаем.
   */
  function dispose(): void {
    generation++;
    stopping?.cancel();
    stopping = null;
    rec?.cancel();
    rec = null;
    pausedRec?.cancel();
    pausedRec = null;
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
    resume,
    active,
    sendPreview,
    discardPreview,
    restorePreview,
    detachPreview,
    tick,
    dispose,
  };
}

export type VoiceHoldController<T extends HoldTake> = ReturnType<typeof createVoiceHoldController<T>>;
