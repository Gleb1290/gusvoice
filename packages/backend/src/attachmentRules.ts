import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveAudioMime, sniffAudioMime, sniffImageMime } from './storageRules.js';

/**
 * Закрытые файлы ЛС (этап 1, шаг 1в, `docs/dm/STAGE1.md`, «Файлы») — чистые правила. Без env, базы, S3 и сети:
 * подпись и разбор ссылки, тип по байтам, диапазон для перемотки, заголовки ответа, чистка журнала от подписей.
 * Доступ человека к файлу — `convRules.attachmentAccess`; запись и выдача — `attachments.ts`, `routes/att.ts`.
 *
 * 🔴 Ссылка своя у КАЖДОГО смотрящего: `/api/att/<id вложения>/<id смотрящего>/<подпись>`. `<img>` и `<audio>` не
 * несут токена, поэтому ссылка сама — ключ на предъявителя. Отзывается она не сроком, а проверкой доступа ЭТОГО
 * человека на каждом запросе (удалено у обоих, спрятано у него, вышел, аккаунт удалён) и поколением его токенов в
 * подписи: «выйти на всех устройствах» гасит и ссылки.
 */

/** Ключ подписи — из секрета JWT, но в своей области: ссылка не должна быть подписью того же вида, что токен. */
export function deriveAttKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('gv-att-v1').digest();
}

/** Подпись ссылки: 32 символа base64url (192 бита). В подписи — версия, вложение, смотрящий и поколение его токенов. */
export function attSig(key: Buffer, attId: string, viewerId: string, tokenGen: number): string {
  return createHmac('sha256', key).update(`v1\n${attId}\n${viewerId}\n${tokenGen}`).digest('base64url').slice(0, 32);
}

export function attSigValid(key: Buffer, attId: string, viewerId: string, tokenGen: number, sig: string): boolean {
  const want = Buffer.from(attSig(key, attId, viewerId, tokenGen));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Срок ссылки на файл ЛС (аудит ЛС #236, п.6): ссылка — ключ на предъявителя, и бессрочная утёкшая (лог прокси, история
 * браузера, пересланный адрес) открывала файл, пока человек в беседе. Теперь в подписи срок: конец СЛЕДУЮЩИХ суток UTC
 * от выдачи. Ссылка живёт 24–48 ч (запас на границе суток), а за одни сутки адрес один и тот же — кеш браузера по адресу
 * не сбрасывается на каждой порции ленты. Истёкшая — 404, клиент перечитывает ссылку (`POST /att/links`) и пробует снова.
 */
export const ATT_LINK_DAY_MS = 24 * 60 * 60 * 1000;
export function attLinkExpiry(nowMs: number): number {
  return (Math.floor(nowMs / ATT_LINK_DAY_MS) + 2) * ATT_LINK_DAY_MS;
}

/** Подпись ссылки со сроком: `<32 знака подписи>.<срок, секунды эпохи в base36>`; срок — внутри HMAC (`v2`). */
export function attSigExp(key: Buffer, attId: string, viewerId: string, tokenGen: number, expMs: number): string {
  const exp = Math.floor(expMs / 1000).toString(36);
  const sig = createHmac('sha256', key).update(`v2\n${attId}\n${viewerId}\n${tokenGen}\n${exp}`).digest('base64url').slice(0, 32);
  return `${sig}.${exp}`;
}

/**
 * Подпись со сроком подлинна и не истекла. Старая подпись без срока (`v1`, до аудита) больше не принимается: такие
 * ссылки бессрочны. Срок дальше, чем выдаёт `attLinkExpiry` сейчас, — подделка или чужие часы: отказ.
 */
export function attSigExpValid(key: Buffer, attId: string, viewerId: string, tokenGen: number, sig: string, nowMs: number): boolean {
  const dot = sig.indexOf('.');
  if (dot !== 32) return false;
  const exp36 = sig.slice(dot + 1);
  if (!/^[0-9a-z]{1,10}$/.test(exp36)) return false;
  const expMs = parseInt(exp36, 36) * 1000;
  if (!Number.isFinite(expMs) || expMs <= nowMs || expMs > attLinkExpiry(nowMs)) return false;
  const want = Buffer.from(attSigExp(key, attId, viewerId, tokenGen, expMs));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEWER_RE = /^[A-Za-z0-9-]{1,64}$/;
const SIG_RE = /^[A-Za-z0-9_-]{32}(?:\.[0-9a-z]{1,10})?$/;

/** id вложения — UUID. Проверяется ДО запроса в базу: мусор в пути не должен доходить до SQL. */
export function isAttId(s: string): boolean {
  return UUID_RE.test(s);
}

/** Части ссылки по отдельности годятся (формат, не подлинность). */
export function attPartsWellFormed(id: string, viewerId: string, sig: string): boolean {
  return UUID_RE.test(id) && VIEWER_RE.test(viewerId) && SIG_RE.test(sig);
}

/**
 * Полная ссылка. `apiBase` — внешний адрес API без завершающего `/` (десктоп ставит её прямо в `<img src>` на
 * источнике `tauri.localhost`, поэтому только абсолютная).
 * ⚠️ Путь НЕ кончается на `attachments/<имя>`: старый клиент такие отправляет в публичную `/api/download/attachment`.
 */
export function attLink(apiBase: string, attId: string, viewerId: string, sig: string): string {
  return `${apiBase}/api/att/${attId}/${viewerId}/${sig}`;
}

const VIDEO_MIME = new Set(['video/mp4', 'video/webm']);

function isMp4Box(b: Uint8Array): boolean {
  return b.length > 7 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70; // 'ftyp'
}

function isEbml(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

/** AVIF — это контейнер MP4 с маркой `avif`/`avis`: без этой проверки он уходил бы в «байты» (ревью 30.09). */
function isAvif(b: Uint8Array): boolean {
  if (!isMp4Box(b) || b.length < 12) return false;
  const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
  return brand === 'avif' || brand === 'avis';
}

function isBmp(b: Uint8Array): boolean {
  return b.length > 26 && b[0] === 0x42 && b[1] === 0x4d; // 'BM'
}

/** Метка порядка байт UTF-16 (FF FE / FE FF): такой текст сырой кадр MP3 «узнаёт» ложно (ревью 30.09). */
function isUtf16Bom(b: Uint8Array): boolean {
  return b.length > 1 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
}

/**
 * Тип файла ЛС по СОДЕРЖИМОМУ; объявление клиента — только подсказка там, где байты неоднозначны.
 *
 * 🔴 WebM и MP4 по байтам не отличить: это и голосовое, и видео. Голосовое у клиента опознаётся по `audio/*` и
 * огибающей (`voiceMessage.isVoiceMessage`), поэтому заявленный `audio/*` при контейнере WebM/MP4 остаётся звуком, а
 * заявленный `video/*` — видео. Без заявления такой контейнер — просто файл (`application/octet-stream`).
 * Всё непризнанное — `application/octet-stream`: отдаётся только скачиванием.
 */
export function resolveAttachmentMime(declared: string, bytes: Uint8Array): string {
  const image = sniffImageMime(bytes);
  if (image) return image;
  if (isAvif(bytes)) return 'image/avif';
  if (isBmp(bytes)) return 'image/bmp';
  const d = declared.trim().toLowerCase();
  if (VIDEO_MIME.has(d) && (isMp4Box(bytes) || isEbml(bytes))) return d;
  if (d.startsWith('audio/')) return resolveAudioMime(d, bytes) ?? 'application/octet-stream';
  // Угадывать звук по байтам — только когда тип не заявлен вовсе: иначе текст с меткой UTF-16 (FF FE — «сырой кадр
  // MP3» для сниффера) становился `audio/mpeg`, хотя клиент честно назвал его `text/plain`.
  if ((d === '' || d === 'application/octet-stream') && !isMp4Box(bytes) && !isEbml(bytes) && !isUtf16Bom(bytes)) {
    const audio = sniffAudioMime(bytes);
    if (audio) return audio;
  }
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'; // %PDF
  }
  return 'application/octet-stream';
}

/** Что ставить в `Content-Type` ответа: картинка, звук и видео — как есть (их показывают `<img>`/`<audio>`), остальное — безликие байты. */
export function servedContentType(mime: string): string {
  return /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+|video\/(mp4|webm))$/.test(mime) ? mime : 'application/octet-stream';
}

/**
 * Заголовки успешной выдачи файла.
 *
 * 🔴 Всегда `attachment`: старый клиент ведёт «Скачать» прямо на эту ссылку (регулярка `attachmentDownloadUrl` её не
 * узнаёт), и без `attachment` окно десктопа уходило бы с приложения на файл. На `<img>`/`<audio>` это не влияет.
 * 🔴 `sandbox` и `default-src 'none'`: файл отдаётся с домена API, и даже пропущенный мимо сниффера HTML не должен там
 * исполниться. `no-cache` + ETag: каждый показ — условный запрос с проверкой доступа, дешёвый 304 без тела.
 */
/**
 * Имя файла для хранения и заголовка: без управляющих и «форматирующих» символов Unicode (в том числе U+202E — им
 * подменяют видимое расширение: «фото‮gpj.exe»), без кавычки и обратного слэша, до `max` КОДОВЫХ ТОЧЕК.
 * 🔴 Резать по кодовым единицам UTF-16 нельзя (ревью 30.09): эмодзи на границе оставлял одинокий суррогат,
 * `encodeURIComponent` бросал, и файл не отдавался никому — навсегда.
 */
export function sanitizeFilename(name: string, max = 200): string {
  const clean = name
    .replace(/[\p{Cc}\p{Cf}"\\]/gu, '_')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_');
  return Array.from(clean).slice(0, max).join('') || 'file';
}

/**
 * `once` — одноразовое фото/видео (аудит ЛС #236, п.7): `no-store` — копия файла не остаётся в кеше браузера после
 * просмотра (с `no-cache` она лежала на диске и открывалась бы снова без сервера).
 */
export function attachmentHeaders(mime: string, filename: string, attId: string, once = false): Record<string, string> {
  const safeName = sanitizeFilename(filename);
  return {
    'Content-Type': servedContentType(mime),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': once ? 'private, no-store' : 'private, no-cache',
    ETag: `"${attId}"`,
    'Accept-Ranges': 'bytes',
  };
}

/**
 * Один диапазон `bytes=a-b` / `bytes=a-` / `bytes=-n` → границы включительно. Нет заголовка или он из нескольких
 * диапазонов/мусор → `null` (отдаём файл целиком — так делают и браузеры, и S3). За пределами файла → `unsatisfiable`.
 * Без 206 голосовое у старых клиентов не перематывается (`<audio>` двигает `currentTime` запросом диапазона).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size <= 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Адрес запроса для журнала: подпись ссылки на файл вырезается. Журнал бэкенда пишет адрес КАЖДОГО запроса, а
 * ссылка — ключ на предъявителя. id вложения оставляем — по нему разбирают жалобы.
 */
export function redactLogUrl(url: string): string {
  return url.replace(/(\/api\/att\/[^/?#]+)\/[^?#]*/, '$1/…');
}

/** Путь — наша ссылка на файл ЛС. Сервер не строит по таким ссылкам превью: иначе подпись уедет в базу превью и журнал. */
export function isAttPath(pathname: string): boolean {
  return /\/api\/att\//.test(pathname);
}

/** Есть ли в политике бакета разрешение для всех (`*`). На закрытом бакете это отказ запускать закрытые файлы. */
export function policyGrantsPublic(policyJson: string): boolean {
  if (!policyJson.trim()) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(policyJson);
  } catch {
    return true; // не разобрали — считаем опасной: закрытое хранилище работает только на доказуемо закрытом бакете
  }
  // `null`, число, строка — разрешений в документе нет вовсе (как у пустой политики), а не «упасть при подготовке».
  if (!doc || typeof doc !== 'object') return false;
  const statements = (doc as { Statement?: unknown }).Statement;
  const list = Array.isArray(statements) ? statements : statements ? [statements] : [];
  return list.some((st) => {
    if (!st || typeof st !== 'object') return false;
    const s = st as { Effect?: unknown; Principal?: unknown };
    if (s.Effect !== 'Allow') return false;
    const p = s.Principal;
    if (p === '*') return true;
    const aws = (p as { AWS?: unknown } | undefined)?.AWS;
    return aws === '*' || (Array.isArray(aws) && aws.includes('*'));
  });
}

/**
 * Сколько незавершённых загрузок человек держит разом: без предела сутки по 15 × 25 МиБ в минуту — сотни ГБ.
 * 🔴 Сверх предела НЕ отказ, а вытеснение самых старых (ревью 30.09): 0.8.x на каждую повторную попытку заново заливает
 * все файлы и id прежних не знает — отказ запирал бы файлы в ЛС на сутки-двое. Предел — с запасом на два сообщения
 * по 10 файлов × 25 МиБ, чтобы вытеснение не задело загрузки ТЕКУЩЕЙ отправки.
 */
export const PENDING_MAX_COUNT = 40;
/** Предел объёма незавершённых и пересылки (`convRules.FORWARD_BYTES_MAX`, равны — держат тесты Codex): 8 ГиБ с 10.10 = суточный
 * `DM_DAILY_UPLOAD_BYTES` (больше не имеет смысла: пересылка считается в суточный, и предел выше квоты недостижим — 429 раньше; 6 ГиБ с 09.10, было 600 МиБ). */
export const PENDING_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/**
 * Действующий предел объёма незавершённых с загрузкой кусками (`bigfile1`, 09.10; `attachments.insertPendingRow`) — 8 ГиБ (с 10.10,
 * = суточный `DM_DAILY_UPLOAD_BYTES`; было 6 ГиБ при файле до 512 МиБ): всё, что можно загрузить за сутки, не вытесняет само себя до
 * отправки (альбом из 8 файлов по `BIGFILE_MAX_BYTES`). `PENDING_MAX_BYTES` / `FORWARD_BYTES_MAX` — то же число (R127 п.5).
 */
export const PENDING_MAX_BYTES_BIGFILE = 8 * 1024 * 1024 * 1024;

/**
 * Какие незавершённые загрузки вытеснить, чтобы новая (`newSize`) уложилась в предел. `existing` — от старых к новым.
 */
export function pendingEvictions(
  existing: readonly { id: string; size: number }[],
  newSize: number,
  maxCount = PENDING_MAX_COUNT,
  maxBytes = PENDING_MAX_BYTES,
): string[] {
  let count = existing.length + 1;
  let bytes = existing.reduce((sum, e) => sum + e.size, 0) + newSize;
  const out: string[] = [];
  for (const e of existing) {
    if (count <= maxCount && bytes <= maxBytes) break;
    out.push(e.id);
    count -= 1;
    bytes -= e.size;
  }
  return out;
}
/** Незавершённая загрузка старше этого — удаляется вместе с файлом. */
export const PENDING_TTL_HOURS = 24;

/*
 * Загрузка кусками (`bigfile1`, 09.10, решение владельца: файл в ЛС до 500 МБ+, с 10.10 — до 1 ГиБ; у Telegram 2 ГБ). Куски идут через бэкенд
 * (`routes/uploads.ts`) в S3 multipart закрытого бакета. Числа — здесь, чистые правила — здесь же (тестируемы без базы).
 */

/** Предел одного файла ЛС при загрузке кусками, байт. Клиент узнаёт его из `/auth/me` (`dmFileMaxBytes`). */
export const BIGFILE_MAX_BYTES = 1024 * 1024 * 1024;
/** Прежний предел одиночной загрузки (`@fastify/multipart` `limits.fileSize`) — у старых клиентов и путь без кусков. */
export const SINGLE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Размер куска (кроме последнего), байт. Не меньше 5 МиБ — нижняя граница S3 для всех кусков, кроме последнего. */
export const BIGFILE_PART_BYTES = 8 * 1024 * 1024;
/**
 * Суточный предел объёма загрузок ЛС на человека (скользящие 24 ч: файлы + начатые загрузки кусками). Антиспам хранилища:
 * 8 файлов по 1 ГиБ в сутки (владелец 10.10: предел не менять). Сверх — 429 с понятным текстом. Решение за владельцем (у Telegram предела нет).
 */
export const DM_DAILY_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
/** Сколько загрузок кусками человек держит открытыми разом (альбом — 10). Сверх — 429. */
export const UPLOADS_OPEN_MAX = 12;
/** Брошенная загрузка кусками старше этого — уборка бросает её в хранилище и стирает строку. */
export const UPLOAD_TTL_HOURS = 24;

/**
 * Срок одной копии файла в хранилище (пересылка, ревью `bigfile1` M2): минута + секунда на каждые 4 МиБ — файл в 1 ГиБ
 * получает чуть больше пяти минут, мелкий — минуту, как раньше.
 */
export function copyTimeoutMs(size: number): number {
  return 60_000 + Math.ceil(Math.max(0, size) / (4 * 1024 * 1024)) * 1000;
}

/** Срок куска в хранилище (`bigUploads.uploadPart`): 8 МиБ даже по медленной связи с хранилищем успевают. */
export const PART_STORE_TIMEOUT_MS = 60_000;
/** Срок начала загрузки и отмены в хранилище. */
export const MULTIPART_OP_TIMEOUT_MS = 30_000;
/**
 * Срок сборки файла в хранилище (`bigUploads.completeUpload`): versitygw склеивает куски на диске — до гигабайта за минуты.
 * Метка сборки (`completing_at`) старше `ASSEMBLY_CLAIM_STALE_MS` (процесс упал посреди сборки) забирается заново.
 */
export const ASSEMBLY_TIMEOUT_MS = 10 * 60_000;
export const ASSEMBLY_CLAIM_STALE_MS = ASSEMBLY_TIMEOUT_MS + 5 * 60_000;

/** Сколько кусков у файла `size` при куске `partSize` (у пустого — один пустой). */
export function partCount(size: number, partSize = BIGFILE_PART_BYTES): number {
  return Math.max(1, Math.ceil(size / partSize));
}

/** Сколько байт обязан нести кусок `n` (с 1); `null` — такого номера у файла нет. */
export function expectedPartSize(size: number, n: number, partSize = BIGFILE_PART_BYTES): number | null {
  const count = partCount(size, partSize);
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return n < count ? partSize : size - (count - 1) * partSize;
}

/**
 * Готова ли загрузка к сборке: есть ВСЕ куски 1…N и каждый ровно нужного размера. Ответ — номера недостающих
 * (или с чужим размером); пусто — можно собирать.
 */
export function missingParts(size: number, parts: readonly { part: number; size: number }[], partSize = BIGFILE_PART_BYTES): number[] {
  const have = new Map(parts.map((p) => [p.part, p.size]));
  const out: number[] = [];
  for (let n = 1; n <= partCount(size, partSize); n++) {
    if (have.get(n) !== expectedPartSize(size, n, partSize)) out.push(n);
  }
  return out;
}

/** Отказ начала загрузки кусками по размеру и суточному объёму; `null` — можно. */
export function uploadStartBlock(
  size: number,
  usedToday: number,
  openUploads: number,
  max = BIGFILE_MAX_BYTES,
  daily = DM_DAILY_UPLOAD_BYTES,
): { code: 413 | 429; error: string } | null {
  if (size > max) return { code: 413, error: `Файл больше ${Math.round(max / 1024 / 1024)} МБ — такое не отправить` };
  if (openUploads >= UPLOADS_OPEN_MAX) return { code: 429, error: 'Слишком много загрузок разом — дождитесь окончания прежних' };
  if (usedToday + size > daily)
    return { code: 429, error: `За сутки можно загрузить в личные сообщения до ${Math.round(daily / 1024 / 1024 / 1024)} ГБ — попробуйте позже` };
  return null;
}
