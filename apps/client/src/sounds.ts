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
  | 'tip';

export interface SoundSettings {
  enabled: boolean;
  volume: number; // 0..1 master
  events: Record<SoundEvent, boolean>;
}

const ALL_EVENTS: SoundEvent[] = ['join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen', 'dm', 'mention', 'stream', 'streamStop', 'move', 'connectionLost', 'connectionRestored', 'poke', 'tip'];

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
};

/** Громкость события: мастер, прижатый потолком события (если он есть). */
function eventVolume(event: SoundEvent): number {
  const cap = VOLUME_CAP[event] ?? 1;
  return Math.min(1, Math.max(0, Math.min(settings.volume, cap)));
}

const STORAGE_KEY = 'gv_sounds';

const DEFAULTS: SoundSettings = {
  enabled: true,
  volume: 0.6,
  events: ALL_EVENTS.reduce((acc, e) => ({ ...acc, [e]: true }), {} as Record<SoundEvent, boolean>),
};

function load(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, events: { ...DEFAULTS.events } };
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULTS.enabled,
      volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : DEFAULTS.volume,
      events: { ...DEFAULTS.events, ...(parsed.events ?? {}) },
    };
  } catch {
    return { ...DEFAULTS, events: { ...DEFAULTS.events } };
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
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
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
function coinCascade(ac: AudioContext, master: GainNode, strikes: number, spreadS: number, gain: number) {
  for (let i = 0; i < strikes; i++) {
    // Плотнее в начале, реже к концу — так падает настоящая горсть.
    const t = spreadS * (i / Math.max(1, strikes - 1)) ** 1.4;
    const jitter = (Math.random() - 0.5) * spreadS * 0.12;
    coinStrike(ac, master, {
      at: Math.max(0, t + jitter),
      gain: gain * (0.55 + 0.45 * (1 - i / strikes)),
      // 5.5–8.5 кГц: несущие. Боковые полосы от них уезжают в 10–20 кГц и дают блеск.
      f0: 5500 + Math.random() * 3000,
    });
  }
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
