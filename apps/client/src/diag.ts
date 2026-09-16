import { api } from './api';
import { finiteDeep } from './diagRules';
import { isDesktop } from './hotkeys';
import { gvScreenShareStats } from './nativeScreenShare';
import { toast } from './toast';
import { config } from './config';
import { diagDecision, getDiagConsent } from './diagConsent';

/**
 * Сбор диагностики во время показа экрана (#100 — «на Win10 отваливаются Alt+Tab и клавиша Win»).
 *
 * Почему это здесь, а не инструкцией человеку: сначала я просил снимать цифры в диспетчере задач
 * вручную (не приехало ни одной), потом дал PowerShell-скрипт (непонятно, как запускать). Данные
 * появляются только когда их собирает само приложение.
 *
 * Счётчики берутся из нативной команды `gv_diag_snapshot` — видеопамять и дескрипторы чужих
 * процессов из веб-слоя не видны в принципе.
 */

/**
 * Два темпа замеров.
 *
 * Сбор начинается при ВХОДЕ В ГОЛОСОВОЙ КАНАЛ, а не при старте показа, — иначе отделить «сколько
 * добавил показ» от «сколько машина ела и так» невозможно в принципе: первый же замер снимался уже
 * с включённым показом, и сравнивать его было не с чем. Пока показа нет, замеряем редко (фон стоит
 * денег, а меняется медленно); на время показа частим.
 */
const IDLE_INTERVAL_MS = 60_000;
const SHARE_INTERVAL_MS = 15_000;
/**
 * Как часто отправлять накопленное, НЕ дожидаясь конца показа.
 *
 * 🔴 Ждать остановки нельзя: баг ломает Alt+Tab, то есть ровно ту дорогу, по которой человек пришёл
 * бы в окно приложения. Дальше он либо снимает игру через диспетчер, либо перезагружается — и
 * отчёт, который отправлялся бы «в конце», не отправится никогда. Поэтому шлём порциями.
 */
const FLUSH_MS = 300_000;
/** Тот же потолок, что на сервере (`diagRules.MAX_SAMPLES`). При фоновом темпе это 16 часов в
 *  голосе, при показе — 4 часа непрерывного показа. */
const MAX_SAMPLES = 960;
/** Тот же потолок, что на сервере (`diagRules.MAX_MARKS`) — нужен при возврате порции в очередь. */
const MAX_MARKS = 200;

type ProcSample = {
  name: string;
  pid: number;
  handles: number;
  gdi: number;
  user: number;
  ws_mb: number;
  gpu_dedicated_mb: number;
  gpu_shared_mb: number;
  /** Доля процессора этого процесса, нормированная на все ядра (100 = вся машина). */
  cpu_pct?: number;
  /** Виртуальная память процесса (commit, «байты закрытых страниц») — НЕ то же, что `ws_mb`. */
  commit_mb?: number;
};
type Snapshot = {
  procs: ProcSample[];
  gpu_adapter_total_mb: number;
  /** Общая нагрузка — под жалобу «при показе игра лагает, падает fps». */
  cpu_pct: number;
  gpu_pct: number;
  ram_used_mb: number;
  ram_total_mb: number;
  /**
   * ВИРТУАЛЬНАЯ память системы (commit) — оперативка плюс файл подкачки.
   *
   * 🔴 Именно этот потолок упирается первым. 2026-08-22 Windows объявила «слишком мало виртуальной
   * памяти», клиент тут же упал на неудачном выделении — а `ram_used_mb` в тот момент показывал
   * спокойные 24 из 47 ГБ. Пока мерили только оперативку, такой отказ был невидим в принципе.
   */
  commit_used_mb?: number;
  commit_total_mb?: number;
  /** Число логических ядер — без него доля процессора нечитаема (8 % на 12 потоках ≠ 8 % на 4). */
  cores?: number;
  /** Настоящее состояние видеокарты из NVML — см. `src-tauri/src/gpu_nvml.rs`. Нет на не-NVIDIA. */
  gpu?: {
    name: string;
    vram_used_mb: number;
    vram_total_mb: number;
    clock_mhz: number;
    clock_max_mhz: number;
    mem_clock_mhz: number;
    pstate: number;
    throttle_reasons: number;
    util_gpu: number;
    util_mem: number;
    util_encoder: number;
    power_w: number;
    power_limit_w: number;
    temp_c: number;
  };
  /**
   * Отвечает ли ОБОЛОЧКА (`explorer`) — главное измерение под #100.
   *
   * У человека с воспроизведённым багом Alt+Tab и «Пуск» мертвы, а Alt+F4 и Ctrl+Shift+Esc
   * работают. Это ровно граница: первые два требуют оболочки, вторые идут мимо неё. Значит отказала
   * оболочка, а не ввод — а зависание потока в счётчиках объектов не видно вообще, там всё ровно.
   */
  shell_hung: boolean;
  taskbar_hung: boolean;
  /** Сколько назад человек в последний раз вводил (мышь/клавиатура) и когда система в последний раз
   *  звала наш низкоуровневый хук. Пара: вводит, а хук молчит = хук выбросили из цепочки. */
  input_idle_ms: number;
  hook_idle_ms?: number;
  /** Объекты по ВСЕЙ системе: лимит на сессию считается отдельно от лимита на процесс, а мы мерили
   *  только четыре процесса. `denied` — сколько процессов не открылись (чужая учётная запись). */
  sys_gdi_total: number;
  sys_user_total: number;
  sys_procs_denied: number;
};

/**
 * Метрики кодирования исходящего видео — под жалобу «рваные кадры при показе».
 *
 * Системные счётчики про это не знают ничего: они видят загрузку машины, но не то, что происходит с
 * самим потоком. Ключевое поле — `limitation`: браузер прямым текстом сообщает, во что упёрся
 * кодировщик («cpu», «bandwidth», «resolution»), и это сразу отделяет слабый процессор от узкого
 * канала. Раньше это приходилось угадывать.
 */
/**
 * Конвейер ЗАХВАТА — до кодирования (2026-08-22).
 *
 * 🔴 Появился, когда разбор упёрся в стену: у человека 4 кадра вместо 30, кодировщик простаивает,
 * упор в процессор, а наш процесс занимает ровно одно ядро — то есть 250 мс на кадр. Перевод кадра
 * 2560×1440 стоит порядка 10 мс, и куда девались остальные 96 % времени, сказать было НЕЧЕМ.
 * Снижение качества показа при этом не меняло ничего — улика, что работа идёт над ИСХОДНИКОМ.
 */
type CaptureStats = {
  /** Мс на захват кадра. Единицы — быстрый путь через видеокарту; сотни — старый, через копирование. */
  capture_ms: number;
  /** Мс на подготовку кадра (перевод формата + уменьшение). */
  convert_ms: number;
  /** РЕАЛЬНЫЙ размер источника. «Показывает 1080p» ничего не значит, если снимаем 1440p. */
  src_width: number;
  src_height: number;
  /** Сколько кадров пришло от захвата и сколько раз мы не уложились в бюджет кадра. */
  frames_captured: number;
  frames_late: number;
  /**
   * Время захвата за ПОСЛЕДНИЕ ~5 секунд, мс (#111).
   *
   * 🔴 Не дубль `capture_ms`: то — среднее с начала показа, и после часа тяжёлой игры оно остаётся
   * высоким навсегда, даже когда видеокарта давно свободна. На вопрос «карта разгрузилась?» —
   * который и решает, залипание перед нами или честная нагрузка, — отвечает только это число.
   */
  capture_ms_now?: number;
};

/**
 * Сторона ЗРИТЕЛЯ — что мы ПРИНИМАЕМ.
 *
 * 🔴 Самая большая дыра, закрытая последней. Пульсация картинки у всего канала (#109) шла от ОДНОГО
 * зрителя, который просил опорные кадры полтора раза в секунду. Чтобы его найти, пришлось руками
 * читать логи сервера: в диагностике не было НИЧЕГО про приём. `pli_sent` — ровно то число, которое
 * сделало бы виновника видимым за минуту вместо часа.
 */
type SubStats = {
  /** Сколько входящих видеопотоков смотрим. */
  streams: number;
  /** Сколько опорных кадров запросили МЫ САМИ — суммарно по всем потокам. */
  pli_sent: number;
  packets_lost: number;
  /** Худший джиттер среди принимаемых потоков, мс. */
  jitter_ms: number;
  /** Кадров в секунду у самого медленного принимаемого потока — «у меня всё тормозит» в цифрах. */
  fps_min: number;
};

type EncodeStats = {
  /** Кадров закодировано и отправлено. Расхождение = кадры теряются уже после кодирования. */
  frames_encoded: number;
  frames_sent: number;
  /** Реальная частота кадров у кодировщика — против той, что человек выбрал в настройках. */
  fps: number;
  /** Во что упёрлись: none | cpu | bandwidth | other. */
  limitation: string;
  /** Сколько секунд провели в каждом из состояний ограничения — накопительно за показ. */
  limited_cpu_s: number;
  limited_bw_s: number;
  /** Запросы ключевого кадра от получателей: растут, когда до них не доезжают куски картинки. */
  pli: number;
  nack: number;
  /** Ширина/высота того, что реально уходит (кодировщик мог понизить сам). */
  width: number;
  height: number;
  /** Целевой битрейт кодировщика, бит/с — падает, когда сеть не тянет. */
  target_bitrate: number;
  /** Средняя стоимость кодирования одного кадра, мс. Растёт — процессор не успевает. */
  encode_ms_per_frame: number;

  // ─── Только для НАТИВНОГО показа: этих полей у браузерного пути нет вовсе ───
  /**
   * Название кодировщика от libwebrtc: `NvCodec…` = аппаратный NVENC, `OpenH264`/`libvpx` = софт.
   *
   * 🔴 Прямой ответ на «почему при показе лагает игра»: софтверный кодировщик 1080p съедает заметную
   * долю процессора, и это ложится поверх игры. Раньше это было видно только косвенно.
   */
  encoder?: string;
  power_efficient?: boolean;
  /** Сеть до сервера: задержка, доля и число потерянных пакетов (из отчёта получателя). */
  rtt_ms?: number;
  fraction_lost?: number;
  packets_lost?: number;
  /** Сколько раз кодировщик сам понижал разрешение — прямой признак, что он не тянет. */
  resolution_changes?: number;
  key_frames?: number;
  codec?: string;
  /**
   * Сколько раз показ пересобрался САМ (#111) и сколько секунд подряд залипание держится сейчас.
   *
   * 🔴 Оба поля — проверка самолечения, а не украшение. У здорового показа `heals` обязан остаться
   * нулём: ненулевой у того, кто ни на что не жалуется, значит порог сработал вхолостую. А
   * `stuck_s` показывает «почти сработало», без него о промахах порога мы бы не узнали вовсе.
   */
  heals?: number;
  stuck_s?: number;
};

/** `sharing` размечает срез по фазе: 0 — просто сидим в голосе, 1 — идёт показ. Ради этой разметки
 *  сбор и переехал на вход в канал: без фоновых срезов «до» цифры показа не с чем сравнивать. */
type Sample = Snapshot & {
  t: number;
  sharing: 0 | 1;
  enc?: EncodeStats;
  cap?: CaptureStats;
  sub?: SubStats;
};

let timer: ReturnType<typeof setInterval> | null = null;
let samples: Sample[] = [];
let marks: number[] = [];
let context: Record<string, unknown> = {};
/** Идёт ли показ прямо сейчас — попадает в каждый срез и задаёт темп замеров. */
let sharing = false;
/** Когда и с какими настройками начинали показ. Массив, потому что за одно сидение в голосе показ
 *  включают и выключают по нескольку раз, и каждый раз — со своими настройками качества. */
let shares: Record<string, unknown>[] = [];
/**
 * Сколько порций отчёта не удалось отправить: подряд и всего за сессию.
 *
 * 🔴 Ради этого счётчика всё и переписано. 2026-08-22 клиент упал по нехватке виртуальной памяти, и
 * при разборе выяснилось, что телеметрия молчала ЧАС до аварии — то есть данных за нужное окно нет,
 * а понять, что их нет, было НЕЧЕМ: ошибка отправки глушилась пустым `catch`. Теперь неудача видна в
 * следующей же доехавшей порции и в консоли браузера.
 */
let sendFailsRow = 0;
let sendFailsTotal = 0;
let startedAt = 0;
let sessionId = '';
let flushTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* подписчик не должен ронять сбор */
    }
  }
}

/** Идёт ли сейчас сбор (то есть находимся ли в голосовом канале). */
export function diagActive(): boolean {
  return timer !== null;
}

export function diagStats(): { samples: number; marks: number; minutes: number } {
  return {
    samples: samples.length,
    marks: marks.length,
    minutes: startedAt ? Math.round((Date.now() - startedAt) / 60_000) : 0,
  };
}

export function subscribeDiag(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function snapshot(): Promise<Snapshot | null> {
  try {
    const core = (window as unknown as { __TAURI__?: { core?: { invoke: (c: string) => Promise<Snapshot> } } })
      .__TAURI__?.core;
    if (!core) return null;
    return await core.invoke('gv_diag_snapshot');
  } catch {
    return null;
  }
}

/** Комната, чьё исходящее видео замеряем. Держим ссылку отдельно: сбор живёт вне React-дерева. */
let watchedRoom: unknown = null;

/**
 * Снять метрики кодирования с ИСХОДЯЩЕГО видео.
 *
 * Читаем publisher-соединение напрямую, а не через трековую обёртку SDK: та прогоняет отчёт через
 * свой фильтр и выкидывает часть полей. Доступ внутренний (`livekit-client` прибит к 2.20.0), поэтому
 * всё под `try` — отвалится тихо и без последствий для показа.
 */
async function webEncodeStats(): Promise<EncodeStats | null> {
  try {
    const pc = (watchedRoom as { engine?: { pcManager?: { publisher?: { getStats?: () => Promise<RTCStatsReport> } } } })
      ?.engine?.pcManager?.publisher;
    const report = await pc?.getStats?.();
    if (!report) return null;

    // Исходящих видеопотоков может быть несколько (simulcast-слои). Берём самый крупный — именно он
    // определяет, что видит зритель; мелкие слои упираются в лимиты раньше и смазали бы картину.
    // Статистика WebRTC типизирована слабо (значения — числа, строки и вложенные объекты), поэтому
    // читаем её как «неизвестно что» и приводим поштучно при использовании.
    let best: Record<string, unknown> | null = null;
    const areaOf = (x: Record<string, unknown> | null): number =>
      x ? ((x.frameWidth as number) || 0) * ((x.frameHeight as number) || 0) : -1;
    report.forEach((raw) => {
      const s = raw as unknown as Record<string, unknown>;
      if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
      if (areaOf(s) > areaOf(best)) best = s;
    });
    if (!best) return null;
    const o: Record<string, unknown> = best;

    const dur = (o.qualityLimitationDurations ?? {}) as Record<string, number>;
    const encoded = (o.framesEncoded as number) ?? 0;
    const encodeTime = (o.totalEncodeTime as number) ?? 0; // секунды, накопительно
    return {
      frames_encoded: encoded,
      frames_sent: (o.framesSent as number) ?? 0,
      fps: Math.round(((o.framesPerSecond as number) ?? 0) * 10) / 10,
      limitation: (o.qualityLimitationReason as string) ?? '',
      limited_cpu_s: Math.round((dur.cpu ?? 0) * 10) / 10,
      limited_bw_s: Math.round((dur.bandwidth ?? 0) * 10) / 10,
      pli: (o.pliCount as number) ?? 0,
      nack: (o.nackCount as number) ?? 0,
      width: (o.frameWidth as number) ?? 0,
      height: (o.frameHeight as number) ?? 0,
      target_bitrate: Math.round((o.targetBitrate as number) ?? 0),
      encode_ms_per_frame: encoded > 0 ? Math.round((encodeTime / encoded) * 1000 * 100) / 100 : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Метрики кодирования нативного показа — из Rust.
 *
 * 🔴 Почему отдельный источник, а не тот же `getStats`: нативный показ публикует **companion-участник
 * из Rust**, со своим соединением. У основного клиента исходящего видео при этом нет вовсе, поэтому
 * браузерный путь возвращал пустоту — и в первых отчётах метрики кодирования не собрались НИ РАЗУ,
 * ровно у тех, ради кого делались (на десктопе показ всегда нативный).
 *
 * Заодно нативный отчёт богаче браузерного: он называет реализацию кодировщика (аппаратный NVENC или
 * софт) и несёт сетевые числа.
 */
/** Конвейер захвата — только нативный показ; в браузере таких чисел нет. */
async function captureStats(): Promise<CaptureStats | null> {
  const n = await gvScreenShareStats().catch(() => null);
  if (!n) return null;
  return {
    capture_ms: Math.round(n.capture_ms * 100) / 100,
    convert_ms: Math.round(n.convert_ms * 100) / 100,
    src_width: n.src_width,
    src_height: n.src_height,
    frames_captured: n.frames_captured,
    frames_late: n.frames_late,
    capture_ms_now: Math.round(n.capture_ms_now * 100) / 100,
  };
}

async function nativeEncodeStats(): Promise<EncodeStats | null> {
  // Возвращает null, когда нативного показа нет, — это и есть признак «брать браузерный путь».
  const n = await gvScreenShareStats().catch(() => null);
  if (!n) return null;
  return {
    frames_encoded: n.frames_encoded,
    // Нативный отчёт считает пакеты, а не кадры. Приравнивать пакеты к кадрам нельзя — это разные
    // величины, и подставленное сюда число врало бы. Расхождение «закодировано против отправлено»
    // для этого пути смотрим по потерям пакетов ниже.
    frames_sent: 0,
    fps: Math.round(n.fps * 10) / 10,
    limitation: n.limit_reason,
    limited_cpu_s: Math.round(n.limit_cpu_s * 10) / 10,
    limited_bw_s: Math.round(n.limit_bandwidth_s * 10) / 10,
    pli: n.pli,
    nack: n.nack,
    width: n.width,
    height: n.height,
    target_bitrate: Math.round(n.target_bitrate),
    encode_ms_per_frame: 0, // нативный отчёт не даёт суммарное время кодирования
    encoder: n.encoder,
    power_efficient: n.power_efficient,
    rtt_ms: Math.round(n.rtt_ms * 10) / 10,
    fraction_lost: Math.round(n.fraction_lost * 1000) / 1000,
    packets_lost: n.packets_lost,
    resolution_changes: n.resolution_changes,
    key_frames: n.key_frames,
    codec: n.codec,
    heals: n.heals,
    stuck_s: n.stuck_s,
  };
}

/** Нативный показ или браузерный — источник выбирается сам, по наличию нативной сессии. */
async function encodeStats(): Promise<EncodeStats | null> {
  return (await nativeEncodeStats()) ?? (await webEncodeStats());
}

/**
 * Начать сбор. `ctx` — настройки показа и окружение: без них цифры не с чем соотнести.
 * Первый срез снимается СРАЗУ, чтобы в отчёте была точка отсчёта, а не только «уже выросшее».
 */
export async function startDiag(room?: unknown): Promise<void> {
  if (!isDesktop()) return; // счётчики есть только в нативной сборке
  // 🔴 Два разрешения — инстанса и человека (#113). Не сошлись оба — не собираем ВООБЩЕ, а не
  // «собираем и не отправляем»: человек, снявший галочку, вправе рассчитывать, что приложение
  // перестанет лазить в его систему. Разбор — в `diagConsent.ts`.
  if (diagDecision(config.diagEnabled, getDiagConsent()) !== 'collect') return;
  if (startedAt) return; // уже идёт: повторный вход в тот же канал не начинает новую сессию
  stopDiagTimer();
  samples = [];
  marks = [];
  shares = [];
  sharing = false;
  watchedRoom = room ?? null;
  startedAt = Date.now();

  // Настоящая версия Windows. Строка браузера её НЕ различает — у десятки и одиннадцатой она
  // одинаковая («Windows NT 10.0»), а баг с Alt+Tab воспроизводится именно на десятке, так что без
  // этого поля выборку не разделить.
  let os = '';
  try {
    const core = (window as unknown as { __TAURI__?: { core?: { invoke: (c: string) => Promise<string> } } })
      .__TAURI__?.core;
    os = (await core?.invoke('gv_os_info')) ?? '';
  } catch {
    /* старая сборка без команды — не повод ломать показ */
  }
  let version = '';
  try {
    const core = (window as unknown as { __TAURI__?: { core?: { invoke: (c: string) => Promise<string> } } })
      .__TAURI__?.core;
    version = (await core?.invoke('gv_app_version')) ?? '';
  } catch {
    /* старая сборка без команды — не повод ломать сбор */
  }
  // 🔴 Версия явным полем. Дважды за вечер я определял её КОСВЕННО, по наличию новых полей в
  // отчёте, — это работает ровно до первой ошибки.
  context = { os, version };
  sendFailsRow = 0;
  sendFailsTotal = 0;

  const first = await snapshot();
  if (!first) {
    // Нативной команды нет (старая сборка) — молча не собираем, но и показ не ломаем.
    startedAt = 0;
    return;
  }
  // Общий идентификатор: порции одного показа сшиваются по нему на сервере.
  sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  samples.push({ ...first, t: 0, sharing: 0 });
  restartTimer();
  flushTimer = setInterval(() => void flush(false), FLUSH_MS);
  notify();
}

/**
 * Что мы ПРИНИМАЕМ — по всем входящим видеопотокам сразу.
 *
 * Читаем subscriber-соединение основного клиента: именно через него приходят чужие показы и камеры.
 * `pliCount` у входящего потока — это сколько опорных кадров запросили МЫ, и это ровно то число,
 * которого не хватало при разборе пульсации у всего канала (#109).
 *
 * Всё под `try`: доступ внутренний (`livekit-client` прибит к версии), отвалится — тихо и без
 * последствий для голоса.
 */
async function subStats(): Promise<SubStats | null> {
  try {
    const pc = (
      watchedRoom as { engine?: { pcManager?: { subscriber?: { getStats?: () => Promise<RTCStatsReport> } } } }
    )?.engine?.pcManager?.subscriber;
    const report = await pc?.getStats?.();
    if (!report) return null;
    let streams = 0;
    let pli = 0;
    let lost = 0;
    let jitter = 0;
    let fpsMin = Infinity;
    report.forEach((r: Record<string, unknown>) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      streams += 1;
      pli += (r.pliCount as number) ?? 0;
      lost += (r.packetsLost as number) ?? 0;
      jitter = Math.max(jitter, ((r.jitter as number) ?? 0) * 1000);
      const f = (r.framesPerSecond as number) ?? 0;
      if (f > 0) fpsMin = Math.min(fpsMin, f);
    });
    if (!streams) return null;
    return {
      streams,
      pli_sent: pli,
      packets_lost: lost,
      jitter_ms: Math.round(jitter * 10) / 10,
      fps_min: Number.isFinite(fpsMin) ? Math.round(fpsMin * 10) / 10 : 0,
    };
  } catch {
    return null;
  }
}

/** Один замер + запись. Вынесено, потому что зовётся и по таймеру, и сразу при смене фазы. */
async function tick(): Promise<void> {
  if (samples.length >= MAX_SAMPLES) return; // потолок как на сервере — дальше просто не копим
  const s = await snapshot();
  if (!s) return;
  // Метрики кодирования есть только пока идёт показ — вне его исходящего видео просто нет.
  const enc = sharing ? await encodeStats() : null;
  const cap = sharing ? await captureStats() : null;
  // Приём меряем ВСЕГДА, а не только во время показа: виновником пульсации у всего канала был
  // зритель, который сам ничего не показывал (#109).
  const sub = await subStats();
  // Чистим ВЕСЬ срез, а не только метрики показа: нечисловое значение где угодно (загрузка
  // видеокарты, память процесса) уезжает как пустое и отбивает срез целиком на сервере.
  samples.push(
    finiteDeep({
      ...s,
      t: Date.now() - startedAt,
      sharing: sharing ? 1 : 0,
      enc: enc ?? undefined,
      cap: cap ?? undefined,
      sub: sub ?? undefined,
    }),
  );
}

/** Перезапустить таймер под текущую фазу (частим во время показа, экономим вне его). */
function restartTimer(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), sharing ? SHARE_INTERVAL_MS : IDLE_INTERVAL_MS);
}

/**
 * Показ начался или закончился.
 *
 * `ctx` — настройки качества начавшегося показа (для остановки передавать `null`). Сразу за сменой
 * фазы снимаем внеочередной срез: иначе граница «до/во время» размазалась бы на целый интервал, а
 * ради этой границы вся перестройка и делалась.
 */
export function setDiagSharing(ctx: Record<string, unknown> | null): void {
  if (!startedAt) return; // не в голосе — сбор не идёт
  const on = ctx !== null;
  if (on === sharing) return;
  sharing = on;
  if (on) shares.push({ ...ctx, t: Date.now() - startedAt });
  restartTimer();
  void tick();
  notify();
}

/** «Прямо сейчас сломалось». Ради этой отметки всё и затевалось: без неё в отчёте виден только рост. */
export function markDiag(): void {
  if (!diagActive()) return;
  marks.push(Date.now() - startedAt);
  notify();
  toast('info', 'Отмечено', 'Момент поломки записан в отчёт');
}

function stopDiagTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/**
 * Отправить накопленное. `final` только помечает порцию как последнюю — сервер складывает их по
 * `sessionId`, поэтому потеря любой промежуточной порции не портит остальные.
 *
 * ⚠️ Очередь снимается СИНХРОННО, до первого `await`: если человек перезагрузится ровно в этот
 * момент, потеряется одна порция, а не весь показ. Но при ОШИБКЕ отправки порция возвращается в
 * очередь и уедет со следующей — раньше она просто пропадала.
 *
 * 🔴 Молча глотать ошибку здесь нельзя. 2026-08-22 телеметрия замолчала за час до аварии, и понять
 * это по данным было невозможно: провалы не считались и в консоль не писались. Теперь считаются.
 */
async function flush(final: boolean): Promise<void> {
  if (!startedAt || (!samples.length && !marks.length)) return;
  const sentSamples = samples;
  const sentMarks = marks;
  samples = [];
  marks = [];
  const payload = {
    kind: 'screenshare' as const,
    context: {
      ...context,
      sessionId,
      final,
      durationMs: Date.now() - startedAt,
      ua: navigator.userAgent,
      // Когда именно включали показ и с какими настройками — разметка к флагу `sharing` в срезах.
      shares,
      // Сколько порций не доехало. Ненулевое значение = в отчёте ДЫРА, и её видно сразу.
      sendFailsTotal,
    },
    marks: sentMarks,
    samples: sentSamples,
  };
  try {
    await api.sendDiagReport(payload);
    sendFailsRow = 0;
  } catch (e) {
    sendFailsRow += 1;
    sendFailsTotal += 1;
    // Возвращаем в начало очереди — но с потолком, иначе при затяжном отказе очередь съест память
    // ровно у того, у кого её и так не хватает.
    samples = [...sentSamples, ...samples].slice(-MAX_SAMPLES);
    marks = [...sentMarks, ...marks].slice(-MAX_MARKS);
    console.warn(`[diag] отчёт не отправлен (подряд ${sendFailsRow}, всего ${sendFailsTotal})`, e);
  }
}

/**
 * Остановить сбор и отправить отчёт. Зовётся при остановке показа.
 *
 * ⚠️ Отчёт без единого среза не отправляем — пустая запись в базе только мешает разбору.
 */
export async function stopDiagAndUpload(): Promise<void> {
  if (!startedAt) {
    stopDiagTimer();
    return;
  }
  stopDiagTimer();
  // 🔴 Порядок важен. Отправку запускаем, но состояние снимаем СИНХРОННО, не дожидаясь сети: при
  // смене канала React зовёт очистку старого эффекта и СРАЗУ за ней новый, а тот проверяет
  // `startedAt` гардом «сессия уже идёт». Обнули мы его после `await` — сбор в новом канале молча
  // не начался бы. Тело `flush` до первого `await` выполняется синхронно, так что порцию оно
  // забирает целиком ещё до обнуления.
  const sent = flush(true);
  startedAt = 0;
  sessionId = '';
  sharing = false;
  shares = [];
  watchedRoom = null;
  notify();
  await sent;
}
