/**
 * Чистые правила медиа-хранилища — БЕЗ env и MinIO-клиента.
 *
 * Вынесено из `storage.ts` по просьбе Codex (2026-07-27): тот модуль на импорте читает env и
 * создаёт `Minio.Client`, поэтому границы MIME/расширений/origin тестом защищены не были. А цена
 * ошибки здесь — исполняемое вложение (XSS с нашего же домена), tracking-пиксель в чужом сообщении
 * или инъекция в HTTP-заголовок через имя файла.
 *
 * Всё, что зависит от конфигурации (`publicUrl`, `bucket`), принимается АРГУМЕНТАМИ — обёртки с
 * env остались в `storage.ts`.
 */

// Active/renderable types a browser could execute as script if ever tricked into rendering them inline
// (SVG/HTML/XHTML). Non-inline types already force-download (Content-Disposition), but we reject these
// outright at upload as defence-in-depth (P2-1/P3-8). Normal files (images/audio/pdf/zip/docs) pass.
const BLOCKED_ATTACHMENT_MIME = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml']);
const BLOCKED_ATTACHMENT_EXT = new Set(['svg', 'html', 'htm', 'xhtml']);

/** True if an attachment's declared MIME or filename extension is a script-capable web type (reject). */
export function attachmentBlocked(mime: string, filename: string): boolean {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (BLOCKED_ATTACHMENT_MIME.has(m)) return true;
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  return BLOCKED_ATTACHMENT_EXT.has(ext);
}

/**
 * True only if `url` points at OUR own media bucket. Chat attachments must — otherwise a client can
 * smuggle an arbitrary external URL into a message, which every recipient's client then fetches on
 * render = tracking pixel / IP-deanonymization (#4, P1-2). Legit attachments come from putAttachment,
 * which always returns `${publicUrl}/${bucket}/…`. Empty publicUrl ⇒ storage off ⇒ no valid URL.
 *
 * 🔴 **Сравнивать РАЗОБРАННЫЙ URL, а не строку** (#90, нашёл Codex). Прежняя проверка была
 * `url.startsWith(publicUrl + '/' + bucket + '/')`, и её обходили dot-segments: строка
 * `https://media/gv/../other/file` начинается с `https://media/gv/`, а запрос уходит на
 * `/other/file` — браузер нормализует путь перед отправкой. Процентная запись `%2e%2e` даёт то же
 * самое (WHATWG-парсер её раскрывает). Хост при этом оставался нашим, поэтому трекинг-пиксель так
 * не пронести, но заявленную границу «объект лежит В НАШЕМ бакете» проверка не держала.
 * `new URL()` нормализует путь сам, поэтому сравнение уже идёт по фактическому адресу.
 */
export function urlBelongsToBucket(url: string, publicUrl: string, bucket: string): boolean {
  if (publicUrl === '') return false;
  let base: URL;
  let target: URL;
  try {
    base = new URL(publicUrl);
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) return false;
  // publicUrl может нести путь (`https://cdn.example.com/minio`) — учитываем его как префикс.
  return target.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/${bucket}/`);
}

/** Картинки, которые принимаем от ПОЛЬЗОВАТЕЛЯ: аватар, иконка канала. */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Расширения для ключей в бакете. Шире, чем `IMAGE_EXT`, — сюда попадают форматы стикеров
 * Telegram (#68), которые к нам приходят не загрузкой от человека, а импортом.
 *
 * ⚠️ РАЗДЕЛЕНО НАМЕРЕННО. `isSupportedImage` раньше проверял «есть ли тип в этой таблице», и
 * дописать сюда `video/webm` значило бы заодно разрешить видео вместо аватара.
 */
const EXT: Record<string, string> = {
  ...IMAGE_EXT,
  'video/webm': 'webm',
  'application/gzip': 'tgs',
};

// Short notification sounds for custom server packs.
//
// 🔴 **Ключ — то, что ПРИСЛАЛ браузер, а он берёт тип из реестра ОС, а не из файла.** Один и тот же
// m4a приезжает то как `audio/mp4`, то как `audio/x-m4a`, то вообще как `application/octet-stream`,
// если расширение в системе ни за кем не закреплено. Поэтому здесь перечислены ПСЕВДОНИМЫ, а
// последнее слово всё равно за содержимым файла (`sniffAudioMime`).
// ⚠️ Так и вылезло (05.09): пользователь резал звуки в Soundpad, тот отдаёт m4a, GusVoice их
// отвергал — а в тексте отказа честно значилось «нужен MP3, OGG, WAV, WEBM или M4A». Формат в
// списке был, а MIME от его машины — нет.
const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
};

/** Канонический MIME по расширению — им подменяем присланный, когда решает содержимое. */
const CANON_AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
};

/** Есть ли по смещению `at` метка `tag` (ASCII). */
function audioTagAt(b: Uint8Array, at: number, tag: string): boolean {
  if (at + tag.length > b.length) return false;
  for (let i = 0; i < tag.length; i++) if (b[at + i] !== tag.charCodeAt(i)) return false;
  return true;
}

/**
 * Что это за звук НА САМОМ ДЕЛЕ — по первым байтам контейнера.
 *
 * 🔴 **Нужен потому, что присланному типу верить нельзя.** Он берётся из реестра машины
 * отправителя: у одного m4a приезжает как `audio/mp4`, у другого — `audio/x-m4a`, у третьего с
 * почищенными ассоциациями — `application/octet-stream`. Перечислять псевдонимы можно бесконечно и
 * всё равно не угадать; содержимое же однозначно.
 * ⚠️ Это ещё и СТРОЖЕ прежнего: раньше достаточно было объявить «audio/mpeg» у любого файла, теперь
 * при неизвестном типе решают байты, и html под видом звука не пройдёт.
 * ⚠️ Ровно тот же приём, что у анимированного аватара (`animatedAvatar.ts`): разбор контейнера, а не
 * доверие подписи.
 */
export function sniffAudioMime(bytes: Uint8Array): string | null {
  // MP4/M4A: размер бокса, затем 'ftyp' на 4-м байте.
  if (audioTagAt(bytes, 4, 'ftyp')) return CANON_AUDIO.m4a;
  // MP3: тег ID3 или сырой кадр (0xFF, затем старшие биты синхрослова).
  if (audioTagAt(bytes, 0, 'ID3')) return CANON_AUDIO.mp3;
  if (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return CANON_AUDIO.mp3;
  if (audioTagAt(bytes, 0, 'OggS')) return CANON_AUDIO.ogg;
  // WAV: RIFF....WAVE.
  if (audioTagAt(bytes, 0, 'RIFF') && audioTagAt(bytes, 8, 'WAVE')) return CANON_AUDIO.wav;
  // WebM/Matroska: сигнатура EBML.
  if (bytes.length > 3 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return CANON_AUDIO.webm;
  }
  return null;
}

/**
 * Окончательный тип звука. `null` — не звук вовсе, заливать нельзя.
 *
 * 🔴 **Решают БАЙТЫ, а подпись браузера — только запасной вариант**, и порядок здесь не косметика.
 * Замерено на живых файлах 05.09: `GPU-Z.exe`, объявленный как `audio/mpeg`, проходил проверку
 * насквозь — потому что при знакомой подписи содержимое не смотрели вовсе, а лежит всё это в
 * ПУБЛИЧНОМ бакете. Теперь такой файл отвергается: контейнер не опознан.
 * ⚠️ Подпись остаётся запасной ровно для одного случая — контейнер наш, но сигнатуры нет там, где
 * мы смотрим (например mp3 с мусором перед первым кадром). Тогда верим объявлению, но только если
 * оно из белого списка.
 */
export function resolveAudioMime(declared: string, bytes: Uint8Array): string | null {
  const sniffed = sniffAudioMime(bytes);
  if (sniffed) return sniffed;
  // ⚠️ Не опознали контейнер И подпись чужая — отказ. Раньше здесь проходило что угодно с верной
  // подписью, включая исполняемый файл.
  return declared in AUDIO_EXT && !looksExecutable(bytes) ? declared : null;
}

/** Заведомо не звук: исполняемые контейнеры, которые чаще всего и пытаются пронести подписью. */
function looksExecutable(bytes: Uint8Array): boolean {
  // PE (.exe/.dll) — 'MZ'; ELF — 0x7F 'ELF'.
  if (audioTagAt(bytes, 0, 'MZ')) return true;
  if (bytes.length > 3 && bytes[0] === 0x7f && audioTagAt(bytes, 1, 'ELF')) return true;
  return false;
}

export function isSupportedImage(mime: string): boolean {
  return mime in IMAGE_EXT;
}

export function isSupportedAudio(mime: string): boolean {
  return mime in AUDIO_EXT;
}

/**
 * Пауза перед следующей попыткой подготовить бакет, если хранилище ещё не ответило (#137 S1).
 *
 * Зачем повтор. Раньше бакет в коробке создавал отдельный `minio-init`, а бэкенд пробовал один раз и
 * только писал ошибку. Без `minio-init` медленный первый старт хранилища оставлял свежий инстанс без
 * бакета навсегда: загрузки падают, пока кто-то не перезапустит бэкенд. Теперь попытки идут, пока не
 * получится: 2 с, 4, 8, … с потолком 5 минут — не спамить лог, если хранилище лежит долго.
 *
 * `failures` — сколько попыток уже провалилось (≥ 1).
 */
export const BUCKET_RETRY = { firstDelayMs: 2_000, maxDelayMs: 300_000 } as const;

export function bucketRetryDelayMs(failures: number): number {
  const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1;
  // На очень долгом простое 2 ** n уходит в Infinity — потолок maxDelayMs срезает и его, второй границы не нужно
  // (отдельный предел степени снаружи был недоказуем: результат тот же при любом входе — замечание Codex 15.09).
  return Math.min(BUCKET_RETRY.maxDelayMs, BUCKET_RETRY.firstDelayMs * 2 ** (n - 1));
}

/** Проводка цикла «пробовать, пока не выйдет» — таймер и лог даёт вызывающий (#143). */
export interface RetryUntilOk {
  /** Одна попытка; исключение = неудача. */
  run: () => Promise<void>;
  /** Пауза перед следующей попыткой по числу уже проваленных (≥ 1). */
  delayMs: (failures: number) => number;
  /** Отложить следующую попытку (в проде — `setTimeout(...).unref()`). */
  schedule: (next: () => void, ms: number) => void;
  onFailure: (failures: number, delayMs: number, error: unknown) => void;
  /** `failures` — сколько попыток провалилось до успеха (0 — вышло с первой). */
  onSuccess: (failures: number) => void;
}

/**
 * Первая попытка выполняется и дожидается здесь же; неудача наружу не выходит — после `onFailure` ставится
 * ровно ОДНА следующая попытка, успех цепочку заканчивает. Так старт сервиса не ждёт медленное хранилище, но
 * и не остаётся без бакета навсегда (`ensureMediaBucket`, #137 S1).
 */
export async function startRetryUntilOk(opts: RetryUntilOk): Promise<void> {
  let failures = 0;
  const attempt = async (): Promise<void> => {
    try {
      await opts.run();
    } catch (e) {
      failures += 1;
      const delay = opts.delayMs(failures);
      opts.onFailure(failures, delay, e);
      opts.schedule(() => void attempt(), delay);
      return;
    }
    opts.onSuccess(failures);
  };
  await attempt();
}

/** Расширение для ключа медиа-объекта (аватар/иконка/стикер/эмодзи). */
export function mediaExt(mime: string): string {
  return EXT[mime] ?? 'bin';
}

/** Расширение для ключа звука уведомления. */
export function audioExt(mime: string): string {
  return AUDIO_EXT[mime] ?? 'bin';
}

// MIME types the browser may render INLINE when an attachment URL is opened directly.
// Everything else (html, svg, pdf, unknown binaries…) is stored with
// Content-Disposition: attachment so navigating to the public MinIO URL downloads the
// file instead of executing/rendering it — closes the "upload an .html/.svg and phish
// from the public media host" hole. NOTE: attachment disposition does NOT affect <img>/<video>
// embedding, only top-level navigation, so chat previews keep working either way.
const INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/webm',
]);

/**
 * Расширение в КЛЮЧЕ вложения. Имя файла пришло от пользователя, поэтому от него остаются только
 * `[a-z0-9]` и не больше 10 символов — иначе имя вида `a.exe%2F..%2F` полезло бы в путь объекта.
 */
export function attachmentExt(filename: string, mime: string): string {
  const fromName = (filename.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return fromName || EXT[mime] || 'bin';
}

/**
 * Заголовок `Content-Disposition` для вложения.
 *
 * 🔴 Имя файла приходит от пользователя и уезжает В ЗАГОЛОВОК. `\r`/`\n` там — это инъекция
 * заголовков ответа, кавычка и обратный слэш — выход из quoted-string. Режем их до кодирования,
 * а не полагаемся на `encodeURIComponent`.
 */
export function contentDisposition(mime: string, filename: string): string {
  const safeName = filename.replace(/[\r\n"\\]/g, '_').slice(0, 200);
  const kind = INLINE_MIME.has(mime) ? 'inline' : 'attachment';
  return `${kind}; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}
