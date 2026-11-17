/**
 * Sound cues, mostly synthesized with the Web Audio API — short oscillator+envelope blips.
 * Discord/TeamSpeak-style feedback for voice join/leave, mute/deafen, DM pings, mentions and
 * stream start.
 *
 * 🔴 **Правило «ни одного вшитого файла» устояло, и вот почему это важно.** Референс, по которому
 * подбирали звук монет, оказался ассетом из **Terraria** (Re-Logic). Чужой игровой ассет в
 * раздаваемый продукт — turnkey-образы, релизы — класть нельзя ни при каких удобствах. Поэтому
 * монеты синтезируются, а не проигрываются файлом.
 * ⚠️ Захотим вшить СВОЙ или лицензированный звук — механизм готов: `playUrl` уже умеет файлы, а
 * пользовательские паки звуков сервера и канала ложатся поверх синтеза.
 *
 * Settings (master on/off, volume, per-event toggles) live in localStorage so they persist
 * per browser. Server/channel custom sound packs can layer on top later (play an <audio> URL
 * instead of synth when one is configured for the event).
 */

import { sharedAudioContext } from './voiceKeepAlive';

export type SoundEvent =
  | 'join'
  | 'leave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'dm'
  | 'mention'
  | 'stream'
  | 'streamStop'
  | 'move'
  | 'connectionLost'
  | 'connectionRestored'
  | 'poke'
  /**
   * ⚠️ События `coins` (начисление монет) здесь БОЛЬШЕ НЕТ: выплата проходит тихо, откликом
   * служит анимация кошелька (решение 03.09). Выключатель звука, который ничего не включает,
   * — обман настройки, поэтому событие снято целиком, а не оставлено немым.
   * Сама запись (`public/sounds/coins-750.wav`, своя) осталась: её же играет `tip`.
   */
  | 'tip'
  /**
   * Колесо гусей-пиратов (ГусКоины 2, этап 2): трещотка вращения и выигрыш. Звучат только тому, у кого открыта сцена
   * (или кто ставил в раунде — выигрыш); трещотку планирует `scheduleWheelTicks` по кривой вращения, а не `playSound`
   * на каждый щелчок.
   */
  | 'wheelTick'
  | 'wheelWin'
  /**
   * Гусиная дуэль (ГусКоины 2, этап 3): стук кубиков броска, победа и тихое приглашение. Бросок и победа — только игрокам и
   * тем, у кого открыта сцена; приглашение — тому, кого вызвали.
   */
  | 'diceRoll'
  | 'duelWin'
  /**
   * Поражение в дуэли (30.10, жалоба владельца «при проигрыше нет никакого звука»): проигравшему — короткий, тише победы и
   * не издевательский (проигрывают часто). Запись встаёт файлом `assets/sounds/duel-lose.mp3`; нет файла — синтез.
   */
  | 'duelLose'
  | 'duelInvite'
  /**
   * Полировка игр (ГусКоины 2, этап 7): пушечный выстрел сорванного сундука колеса (тем, кто ставил в раунде), сгорание
   * копилки на «1» в «Жадном гусе», раскрытие рук КНБ (раньше временно звучало щелчком трещотки) и выплата ставки на
   * событие. Правила те же, что у звуков игр выше (только участникам/открытой сцене, глухота).
   *
   * С 29.10 звуки игр — записи `assets/sounds/*.mp3` (регистрирует `builtinSounds.ts`, соответствие файл → событие
   * там же); синтез `CUES` — запаска на случай сборки без файла. Сундук и победа в дуэли — пока синтез (записи
   * переделываются: `wheel-jackpot.mp3` / `duel-win.mp3` подхватятся без правки кода).
   */
  | 'wheelJackpot'
  | 'greedyBurn'
  | 'rpsReveal'
  | 'predictionResult'
  /**
   * Горн «БУМ» (29.10): карточка «Игры пришли в голос» после запуска игр сервера (`GamesLaunchNotice.tsx`). Пока синтез;
   * настоящая запись встаёт файлом `assets/sounds/games-launch.mp3|ogg` без правки логики (`registerBuiltinSound`).
   */
  | 'gamesLaunch'
  /**
   * Ставки на события (29.10, записи `prediction-open|closed.mp3`): чайка «Новое событие» — вместе с тостом-полкой
   * «Новое событие · Смотреть» (`predictionSounds.ts`), рында «Приём ставок закрыт» — на живом переходе события
   * open→locked тем, кто поставил или сидит в голосе сервера (`sockets.ts`, `prediction.state`).
   */
  | 'predictionOpen'
  | 'predictionClosed';

export interface SoundSettings {
  enabled: boolean;
  volume: number; // 0..1 master
  events: Record<SoundEvent, boolean>;
}

const ALL_EVENTS: SoundEvent[] = ['join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'dm', 'mention', 'stream', 'streamStop', 'move', 'connectionLost', 'connectionRestored', 'poke', 'tip', 'wheelTick', 'wheelWin', 'diceRoll', 'duelWin', 'duelLose', 'duelInvite', 'wheelJackpot', 'greedyBurn', 'rpsReveal', 'predictionResult', 'gamesLaunch', 'predictionOpen', 'predictionClosed'];

/**
 * Звуки игр (ГусКоины 2). 🔴 Игры — неанонсированная работа: в общих настройках звуков их видит только суперадмин (как
 * раздел «Игры» в настройках сервера), иначе названия «Колесо», «Дуэль», «Ставки» — спойлер любому пользователю (30.10).
 */
export const GAME_SOUND_EVENTS: ReadonlySet<SoundEvent> = new Set<SoundEvent>(['wheelTick', 'wheelWin', 'diceRoll', 'duelWin', 'duelLose', 'duelInvite', 'wheelJackpot', 'greedyBurn', 'rpsReveal', 'predictionResult', 'gamesLaunch', 'predictionOpen', 'predictionClosed']);

export const SOUND_EVENT_LABELS: Record<SoundEvent, string> = {
  join: 'Вход в голосовой канал',
  leave: 'Выход из голосового канала',
  mute: 'Выключить микрофон',
  unmute: 'Включить микрофон',
  deafen: 'Заглушить звук',
  undeafen: 'Включить звук',
  dm: 'Личное сообщение',
  mention: 'Упоминание',
  stream: 'Начало стрима',
  streamStop: 'Конец стрима',
  move: 'Перемещение в канал',
  connectionLost: 'Связь с голосовым каналом потеряна',
  connectionRestored: 'Связь с голосовым каналом восстановлена',
  poke: 'Вас ткнули',
  tip: 'Тип в голосовом канале',
  wheelTick: 'Трещотка колеса',
  wheelWin: 'Выигрыш в колесе',
  diceRoll: 'Бросок кубиков',
  duelWin: 'Победа в дуэли',
  duelLose: 'Поражение в дуэли',
  duelInvite: 'Вызов на дуэль',
  wheelJackpot: 'Сундук колеса сорван',
  greedyBurn: 'Сгорание в «Жадном гусе»',
  rpsReveal: 'Раскрытие рук в КНБ',
  predictionResult: 'Выигрыш ставки на событие',
  gamesLaunch: 'Запуск игр на сервере',
  predictionOpen: 'Новое событие для ставок',
  predictionClosed: 'Приём ставок на событие закрыт',
};

/**
 * Вшитые записи — приоритетнее синтеза, но НИЖЕ паков сервера и канала.
 *
 * 🔴 **Правило «ни одного вшитого файла» снято ровно для своих записей.** Оно стояло из-за лицензии
 * (референс оказался ассетом Terraria), а не из-за веса: чужой игровой ассет в раздаваемый turnkey
 * класть нельзя, свой — можно. Этот файл записан автором проекта.
 *
 * ⚠️ **Имя файла несёт длину не для красоты.** Файлы из `public/` не хешируются сборкой, и nginx
 * отдаёт `/sounds/` как immutable. Меняешь звук — меняй ИМЯ, иначе у людей навсегда останется
 * старая запись в кеше.
 */
const BUILTIN: Partial<Record<SoundEvent, string>> = {
  /**
   * Тип — ТА ЖЕ полная запись, что и начисление (02.09: «надо запись 750мс»).
   *
   * ⚠️ Я предлагал короткий рез в 320 мс, опасаясь, что на частом жесте длинный звук будет налезать
   * сам на себя. На слух выбрали полный. Тормоз от налезания у нас и так есть — троттл
   * склейки в `sockets.ts` даёт один звук на серию быстрых типов.
   */
  tip: '/sounds/coins-750.wav',
};

/**
 * Вшитая запись, найденная сборкой (29.10): записи игр `assets/sounds/<имя>.mp3|ogg` ищет `builtinSounds.ts` (горн —
 * ещё и `GamesLaunchNotice.tsx`) через `import.meta.glob` — он только у Vite, сюда его не тащим: модуль звуков
 * исполняется тестами без сборки — и регистрирует здесь. Нет файла — синтез `CUES`. Порядок разрешения тот же: паки
 * канала и сервера главнее.
 */
export function registerBuiltinSound(event: SoundEvent, url: string): void {
  BUILTIN[event] = url;
}

/**
 * Заранее декодировать вшитую запись события (29.10). Нужна трещотке: `scheduleWheelTicks` планирует сотню щелчков
 * сразу на часах контекста и умеет это только с готовым буфером — без него щёлкает синтезом. Зовёт `builtinSounds.ts`
 * на первом жесте человека (до жеста браузер не даёт завести `AudioContext`). Нет записи — ничего.
 */
export function warmBuiltinSound(event: SoundEvent): void {
  const url = BUILTIN[event];
  if (url) warmBuffer(url);
}

/**
 * Потолок громкости на событие, 0..1.
 *
 * 🔴 **Решение 02.09: монетный звук — не громче 0.20.** Ползунок мастера ниже потолка
 * по-прежнему работает, потолок только не даёт задрать выше.
 * ⚠️ Заводился он ради начисления («прилетает само, по нескольку раз за вечер»); начисление с
 * 03.09 молчит вовсе, и предел остался у ТИПА — та же запись и тот же довод: жест частый.
 *
 * ⚠️ Потолок принадлежит СОБЫТИЮ, а не файлу: пак сервера, подменивший звук своей записью,
 * получает тот же предел. Иначе первый же чужой сэмпл вернул бы ровно ту громкость, от которой
 * потолок и заводили.
 */
const VOLUME_CAP: Partial<Record<SoundEvent, number>> = {
  /**
   * Тип: потолок был 0.2 — ровно уровень прежнего синтеза, чтобы замена его записью не сделала звук
   * резко громче.
   *
   * 🔴 **Поднят до 0.4 (04.09).** На первом живом вечере люди играли в Доту и сообщили, что «звука
   * типа нет вовсе». Звук был — но на 0.2 против 0.6 у щипка и всего остального, то есть втрое
   * тише, и на фоне игры его просто не слышно. Событие, о котором человек должен узнать, не может
   * быть самым тихим в приложении.
   * ⚠️ Тише мастера он остаётся намеренно: тип — частый жест, и полная громкость превратила бы
   * живой вечер в игровой автомат.
   */
  tip: 0.4,
  /** Трещотка — сотня щелчков за шесть секунд: на полной громкости это уже шум, а не звук. */
  wheelTick: 0.3,
  wheelWin: 0.5,
  /** Стук кубиков звучит на каждом броске (и на перебросах) — тише остальных. */
  diceRoll: 0.35,
  duelWin: 0.5,
  /** Поражение тише победы на ступень: слышно, что кончилось, но не тычет носом. */
  duelLose: 0.35,
  /** Приглашение — короткое и тихое: карточка на экране и так видна. */
  duelInvite: 0.3,
  /** Джекпот — редкое событие раунда, ему можно быть громче выигрыша (как правило «реже — громче»). */
  wheelJackpot: 0.55,
  greedyBurn: 0.35,
  /** Раскрытие рук звучит на каждом раунде КНБ — тихо, как трещотка. */
  rpsReveal: 0.3,
  predictionResult: 0.45,
  /** Горн запуска — раз за жизнь сервера, может быть громким, но не выше джекпота-пушки. */
  gamesLaunch: 0.55,
  /** Чайка нового события — как выплата ставки: слышно, но не громче итогов. */
  predictionOpen: 0.45,
  /** Рында закрытия — громче чайки на ступень: последний звонок «ставки сделаны». */
  predictionClosed: 0.5,
};

/** Громкость события: мастер, прижатый потолком события (если он есть). */
function eventVolume(event: SoundEvent): number {
  const cap = VOLUME_CAP[event] ?? 1;
  return Math.min(1, Math.max(0, Math.min(settings.volume, cap)));
}

const STORAGE_KEY = 'gv_sounds';

export const SOUND_DEFAULTS: SoundSettings = {
  enabled: true,
  volume: 0.6,
  events: ALL_EVENTS.reduce((acc, e) => ({ ...acc, [e]: true }), {} as Record<SoundEvent, boolean>),
};

function load(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...SOUND_DEFAULTS, events: { ...SOUND_DEFAULTS.events } };
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: parsed.enabled ?? SOUND_DEFAULTS.enabled,
      volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : SOUND_DEFAULTS.volume,
      events: { ...SOUND_DEFAULTS.events, ...(parsed.events ?? {}) },
    };
  } catch {
    return { ...SOUND_DEFAULTS, events: { ...SOUND_DEFAULTS.events } };
  }
}

let settings = load();

export function getSoundSettings(): SoundSettings {
  return settings;
}

export function setSoundSettings(next: SoundSettings): void {
  settings = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

// Custom per-server sound URLs (from the open server's bootstrap). When set for an event we play
// the uploaded file instead of the synthesized cue. Updated by the store on server open / refresh.
let customSounds: Record<string, string> = {};
export function setCustomSounds(map: Record<string, string> | undefined): void {
  customSounds = map ?? {};
}

// Per-channel sound overrides (set by a channel's "general"): channelId → { event: url }. A voice event
// happening in a channel with its own sound plays that; else it falls back to the server pack, then synth.
let channelSounds: Record<string, Record<string, string>> = {};
export function setChannelSounds(map: Record<string, Record<string, string>> | undefined): void {
  channelSounds = map ?? {};
}

const audioCache = new Map<string, HTMLAudioElement>();
/**
 * Декодированные сэмплы для проигрывания через Web Audio.
 *
 * 🔴 **Зачем, если есть `<audio>`.** У фоновой вкладки браузер отклоняет `play()` — и звук события
 * молча пропадал ровно тогда, когда он нужнее всего: человек в игре или смотрит стрим на весь
 * экран, окно GusVoice не в фокусе. Отказ уходил в `catch`, фолбэк вёл к синтезу, а синтез — к
 * `AudioContext`, который в фоне спит и без жеста не просыпается. Итог: «звука типа нет вовсе»
 * (сообщили игравшие в Доту 04.09).
 *
 * `AudioContext`, разбуженный однажды, продолжает звучать и в фоне — на нём же держится весь голос.
 * Поэтому звуки идут через него, а `<audio>` остаётся запасным путём.
 */
const bufferCache = new Map<string, AudioBuffer>();
const bufferPending = new Set<string>();

/** Загрузить и декодировать сэмпл в фоне. Не удалось (CORS, сеть) — молча остаёмся на `<audio>`. */
function warmBuffer(url: string): void {
  if (bufferCache.has(url) || bufferPending.has(url)) return;
  const ac = audioCtx();
  if (!ac) return;
  bufferPending.add(url);
  void (async () => {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return;
      bufferCache.set(url, await ac.decodeAudioData(await res.arrayBuffer()));
    } catch {
      /* остаёмся на <audio> */
    } finally {
      bufferPending.delete(url);
    }
  })();
}

/**
 * Длина записи события, мс (29.10): свечение сундука колеса держится, пока звучит выстрел с фанфарами. Своя запись
 * сервера — её длина, иначе вшитая; известна, когда буфер уже декодирован или `<audio>` прочитал заголовок. Не знаем
 * (синтез, ещё не загружено) — `null`, вызывающий берёт свою константу.
 */
export function soundDurationMs(event: SoundEvent): number | null {
  const url = customSounds[event] || BUILTIN[event];
  if (!url) return null;
  const sec = bufferCache.get(url)?.duration ?? audioCache.get(url)?.duration;
  return sec != null && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
}

/** Проиграть готовый сэмпл через контекст. `false` — нечем (нет буфера или контекст спит). */
function playBuffer(url: string, volume: number): boolean {
  const buf = bufferCache.get(url);
  const ac = audioCtx();
  if (!buf || !ac || ac.state !== 'running') return false;
  const gain = ac.createGain();
  gain.gain.value = Math.min(1, Math.max(0, volume));
  gain.connect(ac.destination);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(gain);
  src.start();
  return true;
}

function playUrl(url: string, volume = settings.volume, onFail?: () => void): void {
  // Первый раз буфера ещё нет — играем как раньше и греем на следующий раз.
  if (playBuffer(url, volume)) return;
  warmBuffer(url);

  let el = audioCache.get(url);
  if (!el) {
    el = new Audio(url);
    el.preload = 'auto';
    audioCache.set(url, el);
  }
  el.volume = Math.min(1, Math.max(0, volume));
  try {
    el.currentTime = 0;
  } catch {
    /* not seekable until loaded */
  }
  // Autoplay policy may reject until a gesture; a decode error also rejects — both are non-fatal.
  // ⚠️ Отказ БОЛЬШЕ НЕ МОЛЧИТ: именно молчание тут стоило вечера разбора «почему звука нет».
  void el.play().catch((e: unknown) => {
    console.warn('[sounds] play отклонён', url, e);
    onFail?.();
  });
}

/**
 * Проиграть произвольный звук по ссылке — выстрел саундборда (#21).
 *
 * 🔴 Отдельно от `playSound`, потому что это НЕ событие: у события есть имя, свой выключатель и
 * запасной синтезированный сигнал, а здесь ссылка приезжает в самом сообщении. Пропускать сэмпл
 * через список событий значило бы заводить фиктивное событие ради переиспользования одной строки.
 *
 * ⚠️ Общий выключатель звуков уважается: «звук выключен» должно означать выключен, без исключений
 * для того, за что кто-то заплатил. Кто не хочет слышать канал — глушится, и это проверяется на
 * стороне вызывающего, где известно состояние голоса.
 */
export function playClip(url: string): void {
  if (!settings.enabled) return;
  playUrl(url);
}

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  try {
    // Android (#209): общий контекст приложения (`voiceKeepAlive.ts`) — свой молчащий контекст был ещё одним выводом,
    // который HyperOS в фоне гасит за «60 с нулей». Вне Android — свой, как раньше.
    if (!ctx)
      ctx =
        sharedAudioContext() ??
        new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    // Autoplay policies suspend the context until a gesture; resume opportunistically.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One enveloped tone. `delay` schedules it relative to now (for two-note cues). */
function tone(
  ac: AudioContext,
  master: GainNode,
  opts: { freq: number; type?: OscillatorType; start?: number; dur: number; gain?: number; glideTo?: number },
) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = opts.type ?? 'sine';
  const t0 = ac.currentTime + (opts.start ?? 0);
  const peak = opts.gain ?? 0.5;
  o.frequency.setValueAtTime(opts.freq, t0);
  if (opts.glideTo) o.frequency.exponentialRampToValueAtTime(opts.glideTo, t0 + opts.dur);
  // Quick attack, smooth exponential release — avoids clicks.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + opts.dur + 0.02);
}

/**
 * Один удар монеты — частотная модуляция плюс шумовой щелчок.
 *
 * 🔴 **Почему ЧМ, а не сумма синусов.** Металл звучит металлом из-за НЕгармоничного спектра:
 * обертоны не кратны основному тону. Сложенные вручную синусы дают колокольчик — так звучала первая
 * версия, и её справедливо отвергли. Частотная модуляция с нецелым отношением рождает плотную
 * гребёнку негармоничных боковых полос; это классический способ синтеза металла и колоколов, и он
 * дешёвый: два осциллятора на пару.
 *
 * 🔴 **Индекс модуляции падает БЫСТРЕЕ амплитуды.** Отсюда яркий металлический удар в начале и
 * тонкий звон после. Постоянный индекс звучит гудком, а не ударом.
 *
 * Числа подобраны сверкой с эталоном по отпечатку (энергия по полосам, атака, спад), а не на слух:
 * получилось 3–6 кГц 33 %, 6–10 кГц 29 %, 10–22 кГц 30 %, атака 1 мс, спад до 10 % за 134 мс —
 * у эталона 126 мс.
 * ⚠️ Эталон держит 68 % энергии выше 10 кГц; мы там держим 30 % НАМЕРЕННО. Выше 10 кГц звук теряют
 * сразу две категории — люди старше сорока и ноутбучные динамики, — поэтому характер берём
 * металлический, а слышимый вес оставляем ниже.
 */
function coinStrike(ac: AudioContext, master: GainNode, opts: { at: number; gain: number; f0: number }) {
  const t0 = ac.currentTime + opts.at;
  const f0 = opts.f0;

  // Три пары «несущая + модулятор». Отношения нецелые — в этом и весь металл.
  for (const [ratio, index, idxDecay, decay, amp] of [
    [1.41, 10, 0.008, 0.028, 1],
    [2.37, 7, 0.005, 0.018, 0.7],
    [3.71, 4.5, 0.003, 0.012, 0.4],
  ] as const) {
    const car = ac.createOscillator();
    const mod = ac.createOscillator();
    const idx = ac.createGain();
    const amplitude = ac.createGain();
    car.frequency.setValueAtTime(f0, t0);
    mod.frequency.setValueAtTime(f0 * ratio, t0);

    // Глубина модуляции в герцах = индекс × частота модулятора. Падает почти до нуля за idxDecay:
    // ноль экспоненте недоступен, поэтому целимся в единицу.
    idx.gain.setValueAtTime(index * f0 * ratio, t0);
    idx.gain.exponentialRampToValueAtTime(1, t0 + idxDecay);

    const peak = Math.max(0.0002, opts.gain * amp);
    amplitude.gain.setValueAtTime(0.0001, t0);
    // Атака 0.8 мс: удар. Всё, что длиннее трёх миллисекунд, ухо читает уже как уведомление.
    amplitude.gain.exponentialRampToValueAtTime(peak, t0 + 0.0008);
    amplitude.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);

    mod.connect(idx).connect(car.frequency);
    car.connect(amplitude).connect(master);
    mod.start(t0);
    car.start(t0);
    mod.stop(t0 + decay + 0.02);
    car.stop(t0 + decay + 0.02);
  }

  // 🔴 Щелчок — не украшение. Именно широкополосный треск в первые миллисекунды говорит «металл о
  // металл»; без него удар остаётся чистым тоном. В первой версии он был вдвое тише и потому не
  // работал.
  const len = Math.floor(ac.sampleRate * 0.014);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(Math.min(f0 * 2.1, 17000), t0);
  bp.Q.setValueAtTime(4, t0);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(opts.gain * 1.8, t0);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.02);
  src.connect(bp).connect(ng).connect(master);
  src.start(t0);
}

/**
 * Россыпь монет.
 *
 * 🔴 В эталоне 53 отдельных удара — это ГОРСТЬ, и множественность как раз и читается «деньгами».
 * Один удар звучит как «дзынь по кружке».
 * ⚠️ Разброс по времени и частоте обязателен: ровная очередь превращается в стрекот. Небольшая
 * случайность заодно не даёт уху устать от повторов за вечер.
 */
function coinCascade(ac: AudioContext, master: GainNode, strikes: number, spreadS: number, gain: number, offsetS = 0) {
  for (let i = 0; i < strikes; i++) {
    // Плотнее в начале, реже к концу — так падает настоящая горсть.
    const t = spreadS * (i / Math.max(1, strikes - 1)) ** 1.4;
    const jitter = (Math.random() - 0.5) * spreadS * 0.12;
    coinStrike(ac, master, {
      at: offsetS + Math.max(0, t + jitter),
      gain: gain * (0.55 + 0.45 * (1 - i / strikes)),
      // 5.5–8.5 кГц: несущие. Боковые полосы от них уезжают в 10–20 кГц и дают блеск.
      f0: 5500 + Math.random() * 3000,
    });
  }
}

/**
 * Шумовой всплеск через фильтр (хлопок, «шух», «пшик»): белый шум с затуханием, полоса фильтра может ехать от `freq` к
 * `glideTo` за `dur`. Тональный синтез хлопка не даёт — нужен широкополосный шум.
 */
function noise(
  ac: AudioContext,
  master: GainNode,
  opts: { start?: number; dur: number; gain: number; freq: number; glideTo?: number; type?: BiquadFilterType; q?: number },
) {
  const t0 = ac.currentTime + (opts.start ?? 0);
  const len = Math.max(1, Math.floor(ac.sampleRate * opts.dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = opts.type ?? 'lowpass';
  f.frequency.setValueAtTime(opts.freq, t0);
  if (opts.glideTo) f.frequency.exponentialRampToValueAtTime(opts.glideTo, t0 + opts.dur);
  f.Q.setValueAtTime(opts.q ?? 0.8, t0);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + opts.dur + 0.02);
}

type Cue = (ac: AudioContext, master: GainNode) => void;

// Honey-goose cues: warm, short, two of them paired for join/leave directionality.
const CUES: Record<SoundEvent, Cue> = {
  join: (ac, m) => {
    tone(ac, m, { freq: 523.25, dur: 0.12, gain: 0.5 }); // C5
    tone(ac, m, { freq: 783.99, dur: 0.16, gain: 0.5, start: 0.1 }); // G5
  },
  leave: (ac, m) => {
    tone(ac, m, { freq: 587.33, dur: 0.12, gain: 0.45 }); // D5
    tone(ac, m, { freq: 392.0, dur: 0.18, gain: 0.45, start: 0.1 }); // G4
  },
  mute: (ac, m) => tone(ac, m, { freq: 320, dur: 0.1, gain: 0.4, glideTo: 200, type: 'triangle' }),
  unmute: (ac, m) => tone(ac, m, { freq: 380, dur: 0.1, gain: 0.4, glideTo: 560, type: 'triangle' }),
  deafen: (ac, m) => {
    tone(ac, m, { freq: 260, dur: 0.09, gain: 0.4, type: 'triangle' });
    tone(ac, m, { freq: 200, dur: 0.12, gain: 0.4, start: 0.08, type: 'triangle' });
  },
  undeafen: (ac, m) => {
    tone(ac, m, { freq: 300, dur: 0.09, gain: 0.4, type: 'triangle' });
    tone(ac, m, { freq: 460, dur: 0.12, gain: 0.4, start: 0.08, type: 'triangle' });
  },
  dm: (ac, m) => tone(ac, m, { freq: 880, dur: 0.16, gain: 0.4 }),
  mention: (ac, m) => {
    tone(ac, m, { freq: 880, dur: 0.1, gain: 0.45 });
    tone(ac, m, { freq: 1174.66, dur: 0.16, gain: 0.45, start: 0.09 }); // D6
  },
  stream: (ac, m) => tone(ac, m, { freq: 440, dur: 0.22, gain: 0.4, glideTo: 880, type: 'sawtooth' }),
  // Mirror of `stream`: a DESCENDING glide (880→330) — the "power-down" that reads as a stream ending.
  streamStop: (ac, m) => tone(ac, m, { freq: 660, dur: 0.24, gain: 0.4, glideTo: 330, type: 'sawtooth' }),
  // "Whoosh" of being carried to another channel — a rising two-step glide.
  // Падающая пара — «что-то оборвалось». Ниже и глуше остальных кью: это не действие человека,
  // а сообщение о беде, и оно не должно перебивать разговор, который всё ещё может идти.
  connectionLost: (ac, m) => {
    tone(ac, m, { freq: 440, dur: 0.14, gain: 0.4 }); // A4
    tone(ac, m, { freq: 311.13, dur: 0.22, gain: 0.4, start: 0.12 }); // D#4
  },
  // Зеркальная восходящая — «вернулось». Намеренно те же ноты в обратном порядке: пара читается
  // как одно событие с двумя концами, а не как два разных сигнала.
  connectionRestored: (ac, m) => {
    tone(ac, m, { freq: 311.13, dur: 0.12, gain: 0.4 }); // D#4
    tone(ac, m, { freq: 440, dur: 0.2, gain: 0.4, start: 0.1 }); // A4
  },
  move: (ac, m) => {
    tone(ac, m, { freq: 466.16, dur: 0.1, gain: 0.45, glideTo: 622.25, type: 'triangle' }); // A#4 → D#5
    tone(ac, m, { freq: 622.25, dur: 0.15, gain: 0.45, start: 0.09, glideTo: 830.61, type: 'triangle' }); // D#5 → G#5
  },
  // «Тук-тук-тук» — три коротких удара на одной ноте. Намеренно НЕ мелодия: тык должен читаться как
  // стук в дверь, а не как ещё одно уведомление, и отличаться от `mention` с первого же звука.
  // Громче остальных кью (0.55): он и должен выдёргивать из игры — ради этого фичу и просили.
  poke: (ac, m) => {
    tone(ac, m, { freq: 587.33, dur: 0.06, gain: 0.55, type: 'square' }); // D5
    tone(ac, m, { freq: 587.33, dur: 0.06, gain: 0.55, start: 0.12, type: 'square' });
    tone(ac, m, { freq: 587.33, dur: 0.09, gain: 0.55, start: 0.24, type: 'square' });
  },
  // Короткий тёплый «динь» для ВСЕГО канала: это публичный жест, а не личное уведомление.
  // Повторы склеивает проводка gateway в sockets.ts, чтобы три быстрых типа не сливались в шум.
  /**
   * Тип — короткая россыпь: три-четыре монетки, около 200 мс.
   *
   * ⚠️ Эталон длится 540 мс и состоит из полусотни ударов — это ГОРСТЬ, и для частого жеста она
   * слишком длинная и слишком богатая. Тип человек слышит десятки раз за вечер, а правило для
   * повторяемых действий — до 500 мс, и лучше заметно меньше. Поэтому от эталона берём тембр и
   * характер, а количество и длину режем.
   */
  tip: (ac, m) => coinCascade(ac, m, 4, 0.15, 0.16),
  /** Один щелчок трещотки (сухой, ~30 мс): им же звучит проба в настройках звуков. */
  wheelTick: (ac, m) => tone(ac, m, { freq: 1900, dur: 0.03, gain: 0.35, type: 'triangle', glideTo: 1300 }),
  /** Выигрыш: два восходящих тона и горсть монет — короче секунды. */
  wheelWin: (ac, m) => {
    tone(ac, m, { freq: 659.25, dur: 0.14, gain: 0.4 }); // E5
    tone(ac, m, { freq: 987.77, dur: 0.22, gain: 0.4, start: 0.11 }); // B5
    coinCascade(ac, m, 7, 0.35, 0.16);
  },
  /** Стук двух кубиков по столу: несколько глухих ударов с затуханием, ~0,5 с. */
  diceRoll: (ac, m) => {
    const hits = [0, 0.07, 0.16, 0.24, 0.34, 0.41];
    hits.forEach((at, i) => {
      const f = 210 + Math.random() * 120;
      tone(ac, m, { freq: f, dur: 0.045, gain: 0.45 * (1 - i / (hits.length + 1)), type: 'square', start: at, glideTo: f * 0.6 });
    });
  },
  /** Победа в дуэли: три восходящих тона и горсть монет. */
  duelWin: (ac, m) => {
    tone(ac, m, { freq: 523.25, dur: 0.12, gain: 0.4 }); // C5
    tone(ac, m, { freq: 659.25, dur: 0.12, gain: 0.4, start: 0.1 }); // E5
    tone(ac, m, { freq: 1046.5, dur: 0.24, gain: 0.4, start: 0.2 }); // C6
    coinCascade(ac, m, 6, 0.3, 0.14);
  },
  /** Поражение: две мягкие нисходящие ноты (G4 → E4), без монет — ~0,45 с. */
  duelLose: (ac, m) => {
    tone(ac, m, { freq: 392.0, dur: 0.16, gain: 0.32, type: 'triangle' }); // G4
    tone(ac, m, { freq: 329.63, dur: 0.3, gain: 0.3, type: 'triangle', start: 0.14, glideTo: 311.13 }); // E4 → D#4
  },
  /** Вызов на дуэль: два коротких мягких тона, тише остальных. */
  duelInvite: (ac, m) => {
    tone(ac, m, { freq: 698.46, dur: 0.08, gain: 0.3, type: 'triangle' }); // F5
    tone(ac, m, { freq: 932.33, dur: 0.12, gain: 0.3, start: 0.09, type: 'triangle' }); // A#5
  },
  /**
   * Сундук колеса сорван: пушечный выстрел (низкий удар с падением тона + шумовой хлопок), восходящее арпеджио и большая
   * горсть монет — ~1,3 с. Редкое событие, поэтому длиннее и богаче выигрыша.
   */
  wheelJackpot: (ac, m) => {
    tone(ac, m, { freq: 95, dur: 0.4, gain: 0.8, glideTo: 38 });
    noise(ac, m, { dur: 0.25, gain: 0.7, freq: 1400, glideTo: 180 });
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => tone(ac, m, { freq, dur: 0.16, gain: 0.32, start: 0.22 + i * 0.08 })); // C5 E5 G5 C6
    coinCascade(ac, m, 14, 0.7, 0.15, 0.3);
  },
  /** Сгорание на «1»: нисходящий «пшик» (шум и пила вниз) и два глухих удара — ~0,55 с. */
  greedyBurn: (ac, m) => {
    noise(ac, m, { dur: 0.32, gain: 0.35, freq: 3200, glideTo: 350, type: 'bandpass', q: 1.2 });
    tone(ac, m, { freq: 520, dur: 0.3, gain: 0.16, type: 'sawtooth', glideTo: 140 });
    tone(ac, m, { freq: 120, dur: 0.08, gain: 0.5, start: 0.34, glideTo: 70 });
    tone(ac, m, { freq: 105, dur: 0.1, gain: 0.42, start: 0.46, glideTo: 60 });
  },
  /** Раскрытие рук КНБ: короткий «шух» двух крыльев и сухой щелчок — ~0,2 с. */
  rpsReveal: (ac, m) => {
    noise(ac, m, { dur: 0.08, gain: 0.3, freq: 1300, glideTo: 2600, type: 'bandpass', q: 1.5 });
    noise(ac, m, { start: 0.06, dur: 0.08, gain: 0.3, freq: 1500, glideTo: 2900, type: 'bandpass', q: 1.5 });
    tone(ac, m, { freq: 1900, dur: 0.03, gain: 0.35, type: 'triangle', glideTo: 1300, start: 0.15 });
  },
  /**
   * Горн «БУМ» запуска игр (заглушка до записи): удар-«бум» и восходящий сигнал горна G4–C5–E5 с долгой G5 — ~1,1 с.
   * Заменяется файлом без правки логики (`registerBuiltinSound`, файл ищет `GamesLaunchNotice.tsx`).
   */
  gamesLaunch: (ac, m) => {
    tone(ac, m, { freq: 90, dur: 0.35, gain: 0.7, glideTo: 40 });
    noise(ac, m, { dur: 0.2, gain: 0.45, freq: 1200, glideTo: 200 });
    tone(ac, m, { freq: 392.0, dur: 0.14, gain: 0.3, type: 'sawtooth', start: 0.18 }); // G4
    tone(ac, m, { freq: 523.25, dur: 0.14, gain: 0.3, type: 'sawtooth', start: 0.32 }); // C5
    tone(ac, m, { freq: 659.25, dur: 0.14, gain: 0.3, type: 'sawtooth', start: 0.46 }); // E5
    tone(ac, m, { freq: 783.99, dur: 0.5, gain: 0.32, type: 'sawtooth', start: 0.6 }); // G5
  },
  /** Выплата ставки на событие: как выигрыш колеса, но короче — два тона и маленькая горсть. */
  predictionResult: (ac, m) => {
    tone(ac, m, { freq: 783.99, dur: 0.1, gain: 0.38 }); // G5
    tone(ac, m, { freq: 1174.66, dur: 0.16, gain: 0.38, start: 0.08 }); // D6
    coinCascade(ac, m, 5, 0.25, 0.14);
  },
  /** Запаска «Новое событие» (штатно — запись чайки): два коротких восходящих «крика» — ~0,4 с. */
  predictionOpen: (ac, m) => {
    tone(ac, m, { freq: 1250, dur: 0.14, gain: 0.3, type: 'triangle', glideTo: 1650 });
    tone(ac, m, { freq: 1350, dur: 0.2, gain: 0.3, type: 'triangle', glideTo: 1800, start: 0.18 });
  },
  /** Запаска «Приём ставок закрыт» (штатно — запись рынды): один колокольный удар с долгим хвостом — ~0,9 с. */
  predictionClosed: (ac, m) => {
    tone(ac, m, { freq: 880, dur: 0.9, gain: 0.4 }); // A5
    tone(ac, m, { freq: 2216, dur: 0.5, gain: 0.12 }); // негармоничный обертон колокола
  },
  /**
   * Начисление — полная горсть, длиной и плотностью как запись.
   *
   * ⚠️ Штатно НЕ звучит: у события есть вшитый файл, и синтез включается только если файла не
   * оказалось в сборке (self-hoster вырезал ассеты). Держим его именно поэтому — событие с
   * выключателем и без голоса было бы обманом настройки.
   */
};

/**
 * Play a cue if sounds are enabled and that event isn't muted. Pass the channel the event happens in
 * to honour that channel's general's overrides.
 *
 * Порядок разрешения: пак канала → пак сервера → **вшитый файл** → синтез. Своя запись стоит выше
 * синтеза, но ниже паков: то, что владелец залил руками, всегда главнее того, что мы положили в
 * коробку.
 */
export function playSound(event: SoundEvent, channelId?: string): void {
  if (!settings.enabled || !settings.events[event]) return;
  const volume = eventVolume(event);
  const custom = (channelId ? channelSounds[channelId]?.[event] : undefined) || customSounds[event];
  if (custom) {
    playUrl(custom, volume);
    return;
  }
  const builtin = BUILTIN[event];
  // Файла может не оказаться (обрезанная сборка) — тогда падаем на синтез, а не молчим.
  if (builtin) {
    playUrl(builtin, volume, () => synth(event, volume));
    return;
  }
  synth(event, volume);
}

/**
 * Трещотка вращения колеса: щелчок в каждый момент `timesMs` (мс от сейчас; считает `wheelRules.tickTimes` по той же
 * кривой, что у CSS). Все щелчки планируются сразу на часах `AudioContext` — без таймеров, которые плывут под нагрузкой.
 * Соблюдает общий и по-событийный выключатели; своя запись трещотки (пак) — не поддерживается: сотня сэмплов подряд
 * не то, что владелец имел в виду. Возвращает отмену (сцену закрыли посреди вращения).
 *
 * Вшитая запись щелчка (29.10, `wheel-tick.mp3`, ~86 мс): каждый щелчок — СВОЙ `AudioBufferSource` на своём моменте
 * часов, так что частые щелчки накладываются, а не обрывают друг друга, и задержка не копится (никакого одного
 * `<audio>` с перемоткой). Буфер ещё не декодирован (`warmBuiltinSound` не успел) — это вращение щёлкает синтезом.
 * Отмена глушит общий выход и останавливает ещё не прозвучавшие щелчки.
 * `anchorMs` (30.10) — от какого момента часов страницы отсчитаны `timesMs` (начало вращения колеса); без него — от вызова.
 */
/**
 * В записи `wheel-tick.mp3` до удара — 20 мс шороха (удар на 21-й мс, второй, отзвук дерева, — на 55-й): играем её с этого
 * места, чтобы удар звучал В момент срыва штырька, а не на 20 мс позже (30.10, рассинхрон на замедлении).
 */
const WHEEL_TICK_LEAD_S = 0.02;

/**
 * Насколько раньше `currentTime` надо ставить звук, чтобы он ПРОЗВУЧАЛ в момент `nowMs` часов страницы (30.10): между
 * `currentTime` и динамиком — буфер вывода (Windows ~10–40 мс, Bluetooth до 200+). `getOutputTimestamp` даёт пару
 * «время контекста ↔ время страницы» на выходе; нет её (старый браузер, тест) — 0. Сдвиг ≤ 0 и не больше 0,3 с.
 */
function outputShiftS(ac: AudioContext, nowMs: number): number {
  try {
    const ts = typeof ac.getOutputTimestamp === 'function' ? ac.getOutputTimestamp() : null;
    if (!ts || !(Number(ts.performanceTime) > 0) || !Number.isFinite(Number(ts.contextTime))) return 0;
    const heardAtNow = Number(ts.contextTime) + (nowMs - Number(ts.performanceTime)) / 1000;
    const shift = heardAtNow - ac.currentTime;
    return Number.isFinite(shift) ? Math.max(-0.3, Math.min(0, shift)) : 0;
  } catch {
    return 0;
  }
}

/**
 * Скорость колеса по зазору до прошлого щелчка (30.10): частые — колесо летит, щелчок легче и выше; редкие — медленный
 * финал, каждый штырёк звучит полнее и ниже. Разброс небольшой: громкость 0,75…1, высота ×1,08…×0,96.
 */
function tickVoice(timesMs: readonly number[], i: number): { gain: number; rate: number } {
  const gap = i > 0 ? timesMs[i] - timesMs[i - 1] : timesMs.length > 1 ? timesMs[1] - timesMs[0] : 400;
  const slow = Math.max(0, Math.min(1, (gap - 70) / 330));
  return { gain: 0.75 + 0.25 * slow, rate: 1.08 - 0.12 * slow };
}

export function scheduleWheelTicks(timesMs: readonly number[], anchorMs?: number): () => void {
  if (!settings.enabled || !settings.events.wheelTick || timesMs.length === 0) return () => {};
  const ac = audioCtx();
  if (!ac) return () => {};
  // Якорь (30.10): моменты — от `anchorMs` на часах страницы (`performance.now`), а не «от вызова». Отсчёт берём ПОСЛЕ
  // `audioCtx()`: первое его создание за сессию занимает ~50 мс, и трещотка на столько отставала от колеса. Прошедшие
  // щелчки выбрасываются (не играются пачкой «сейчас»).
  if (anchorMs !== undefined) {
    const lag = performance.now() - anchorMs;
    timesMs = timesMs.map((t) => t - lag).filter((t) => t >= 0);
    // Поправка на буфер вывода: ставим раньше на его длину — щелчок ПРОЗВУЧИТ в свой момент (опоздавшие — сразу).
    const shiftMs = outputShiftS(ac, anchorMs + lag) * 1000;
    if (shiftMs < 0) timesMs = timesMs.map((t) => t + shiftMs);
  }
  const master = ac.createGain();
  master.gain.value = eventVolume('wheelTick');
  master.connect(ac.destination);
  const click = BUILTIN.wheelTick ? bufferCache.get(BUILTIN.wheelTick) : undefined;
  if (BUILTIN.wheelTick && !click) warmBuffer(BUILTIN.wheelTick);
  const clicks: AudioBufferSourceNode[] = [];
  try {
    if (click) {
      const lead = Math.min(WHEEL_TICK_LEAD_S, click.duration / 2);
      timesMs.forEach((at, i) => {
        const v = tickVoice(timesMs, i);
        const src = ac.createBufferSource();
        src.buffer = click;
        src.playbackRate.value = v.rate;
        const g = ac.createGain();
        g.gain.value = v.gain;
        src.connect(g).connect(master);
        src.start(ac.currentTime + Math.max(0, at) / 1000, lead);
        clicks.push(src);
      });
    } else for (const t of timesMs) tone(ac, master, { freq: 1900, dur: 0.03, gain: 0.35, type: 'triangle', glideTo: 1300, start: Math.max(0, t) / 1000 });
  } catch {
    /* ignore */
  }
  return () => {
    for (const src of clicks.splice(0)) {
      try {
        src.stop();
      } catch {
        /* уже отзвучал */
      }
    }
    try {
      master.disconnect();
    } catch {
      /* ignore */
    }
  };
}

function synth(event: SoundEvent, volume: number): void {
  const ac = audioCtx();
  if (!ac) return;
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(ac.destination);
  try {
    CUES[event](ac, master);
  } catch {
    /* ignore */
  }
}
