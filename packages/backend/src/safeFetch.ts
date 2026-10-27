import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isDevPeerHost } from './federation/devPeers.js';

/**
 * HTTP-клиент для URL, которые прислал ПОЛЬЗОВАТЕЛЬ.
 *
 * Обычный `fetch` тут применять нельзя. Бэкенд часто стоит внутри домашней сети: рядом гипервизор (8006),
 * Git-сервер, S3 (9000), обратный прокси, роутер. Любой участник чата, написав `http://192.168.1.100:8006`,
 * заставил бы сервер сходить туда и вернуть ответ — это SSRF, и через него видно то, что снаружи
 * не видно вообще. В облаке ставки те же: `169.254.169.254` отдаёт токены метаданных инстанса.
 *
 * Защита строится на трёх вещах, и все три обязательны:
 *
 * 1. **Проверка адреса, а не имени.** Блоклист по именам («localhost») обходится за секунду: свой
 *    домен резолвится куда угодно. Проверяем то, во что хост РЕЗОЛВИТСЯ.
 * 2. **Проверка внутри резолвинга (`lookup`).** Проверить отдельно, а потом позвать `fetch` —
 *    это TOCTOU: между проверкой и подключением DNS успевает ответить иначе (DNS rebinding),
 *    и соединение уходит на приватный адрес уже после «одобрения». Поэтому подключение получает
 *    РОВНО тот адрес, который прошёл проверку, из одного и того же вызова.
 * 3. **Перепроверка каждого редиректа.** Иначе обход делается одним `302` на внутренний адрес.
 *    Редиректы ведём вручную, `autoRedirect` у клиента выключен.
 */

const MAX_REDIRECTS = 3;
/** Срок ТИШИНЫ сокета: сбрасывается любым байтом — поэтому один он не защищает (см. ниже). */
const TIMEOUT_MS = 5000;
/**
 * Общий срок на весь запрос (аудит 19.09, F-09; подтверждено run-1).
 *
 * 🔴 `timeout` у `http.request` — это срок молчания, а не запроса: сосед, отдающий по байту раз в
 * четыре секунды, держал соединение часами (ответ до 1 МБ, файл до 6 МБ), и каждый проход очереди
 * или сверки добавлял ещё один зависший сокет. Документы федерации — килобайты, им хватает 20 с;
 * файлу (аватар до 5 МБ) — минуты.
 */
export const REQUEST_DEADLINE_MS = 20_000;
export const FILE_DEADLINE_MS = 60_000;
/** Хватает на `<head>`; тело дальше этого не читаем, чтобы гигабайтный ответ не занял память. */
const MAX_BYTES = 256 * 1024;

/** IPv4 как число — сравнивать диапазоны так надёжнее, чем строками. */
function v4ToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const b = Number(part);
    if (!Number.isInteger(b) || b < 0 || b > 255 || (part.length > 1 && part[0] === '0')) return null;
    n = n * 256 + b;
  }
  return n;
}

/** `a.b.c.d/bits` → диапазон. */
function v4Block(cidr: string): [number, number] {
  const [base, bitsRaw] = cidr.split('/');
  const start = v4ToInt(base) as number;
  const bits = Number(bitsRaw);
  const size = 2 ** (32 - bits);
  return [start, start + size - 1];
}

/**
 * Всё, что не является публичным интернетом. Не только «серые сети»: link-local содержит
 * `169.254.169.254` (метаданные облака), CGNAT и benchmark-диапазоны тоже не должны быть целью
 * запроса от нашего сервера.
 */
const V4_BLOCKED = [
  '0.0.0.0/8', // «этот хост»
  '10.0.0.0/8', // приватная
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local + метаданные облака
  '172.16.0.0/12', // приватная
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // документация
  '192.168.0.0/16', // приватная — здесь живут домашние сети
  '198.18.0.0/15', // benchmark
  '198.51.100.0/24', // документация
  '203.0.113.0/24', // документация
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
].map(v4Block);

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true; // не разобрали — считаем опасным
  return V4_BLOCKED.some(([lo, hi]) => n >= lo && n <= hi);
}

/**
 * Развернуть IPv6 в 8 групп. Нужен именно разбор, а не сопоставление с образцом: один и тот же
 * адрес записывается по-разному, и `new URL()` вдобавок ПЕРЕПИСЫВАЕТ запись в каноническую —
 * `[::ffff:192.168.1.44]` превращается в `[::ffff:c0a8:12c]`. Регулярка на запись через точки
 * такой адрес пропускала, то есть фильтр обходился сменой формы записи.
 */
function expandV6(a: string): number[] | null {
  let s = a;
  // хвост вида ::ffff:1.2.3.4 — переводим последние 32 бита в две hex-группы
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    if (n === null) return null;
    s = s.slice(0, -dotted[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : gap < 0) return null;
  const groups = halves.length === 2 ? [...head, ...Array(gap).fill(0), ...tail] : head;
  return groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff) ? null : groups;
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase().split('%')[0]; // отрезаем zone id (fe80::1%eth0)
  const g = expandV6(a);
  if (!g) return true; // не разобрали — считаем опасным
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::1 loopback и :: unspecified
  if (zeros(7) && (g[7] === 1 || g[7] === 0)) return true;
  // IPv4-mapped (::ffff:0:0/96) и IPv4-compatible (::a.b.c.d) — решает встроенный IPv4,
  // иначе весь фильтр v4 обходится записью адреса в виде v6
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.'));
  }
  if (g[0] === 0x2002) return true; // 6to4 — несёт v4 внутри
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // не IP — не наш случай, отбиваем
}

export class BlockedTargetError extends Error {
  constructor(readonly detail: string) {
    super(`заблокированная цель: ${detail}`);
  }
}

/**
 * `lookup` для http.request: резолвит и тут же отбивает приватные адреса. Именно здесь, а не
 * заранее — возвращённый адрес и есть тот, к которому пойдёт соединение (см. пункт 2 сверху).
 */
export type Addr = { address: string; family: number };

/**
 * Что вернуть вызывающему в зависимости от того, в каком режиме он спросил.
 *
 * 🔴 Отдельной функцией, потому что здесь уже была ошибка, положившая ВЕСЬ предпросмотр:
 * Node 20+ включает Happy Eyeballs (`autoSelectFamily`) по умолчанию и зовёт `lookup` с
 * `all: true`, ожидая в ответ МАССИВ адресов. Я возвращал `(address, family)`, как в старом
 * режиме, — Node получал не тот тип и падал с `ERR_INVALID_IP_ADDRESS` на КАЖДОМ запросе.
 * Снаружи это выглядело как «фильтр работает, просто ничего не грузится».
 */
export function chooseLookupResult(
  list: Addr[],
  wantAll: boolean,
): { all: Addr[] } | { address: string; family: number } | null {
  if (!list.length) return null;
  return wantAll ? { all: list } : { address: list[0].address, family: list[0].family };
}

const safeLookup: typeof dnsLookup = ((hostname: string, options: unknown, cb: unknown) => {
  const opts = (typeof options === 'function' ? {} : ((options ?? {}) as { all?: boolean })) ?? {};
  const done = (typeof options === 'function' ? options : cb) as (
    err: NodeJS.ErrnoException | null,
    address?: string | Addr[],
    family?: number,
  ) => void;
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return done(err);
    const list = Array.isArray(addrs) ? addrs : [];
    // Отбиваем, если ХОТЬ ОДИН адрес приватный: round-robin DNS иначе даёт лотерею, в которой
    // иногда выпадает внутренняя цель.
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) return done(new BlockedTargetError(`${hostname} → ${bad.address}`));
    const res = chooseLookupResult(list, opts.all === true);
    if (!res) return done(new BlockedTargetError(`${hostname} не резолвится`));
    if ('all' in res) return done(null, res.all);
    done(null, res.address, res.family);
  });
}) as typeof dnsLookup;

export type SafeResponse = {
  url: string;
  status: number;
  contentType: string;
  body: string;
  /**
   * Сырые байты ответа — заполняются только при `binary: true` (F2: аватар соседа).
   *
   * 🔴 У картинки `body` брать НЕЛЬЗЯ: он собран как utf8, и любой байт вне допустимой
   * последовательности превращается в символ замены — файл тихо портится, а размер даже растёт.
   */
  bytes?: Buffer;
  /**
   * Заголовок `retry-after` ответа 429 в секундах (исправления ревью ЛС 12.10, п. 1: забор журнала соседа ждёт столько,
   * а не долбит предел). Нет заголовка или не число — поля нет.
   */
  retryAfter?: number;
};

/**
 * Если в URL уже стоит IP-литерал — проверить его ЗДЕСЬ.
 *
 * `safeLookup` для таких адресов не вызывается вообще: `net.connect` видит готовый IP и идёт
 * подключаться напрямую, минуя резолвинг. То есть `http://localhost` отбивался, а
 * `http://127.0.0.1` — нет, и через него утекало содержимое внутренних сервисов. Поймано только
 * живым запросом к поднятому локально серверу; чтением кода эта дыра не видна.
 */
function assertLiteralAllowed(hostname: string): void {
  const bare = hostname.replace(/^\[|\]$/g, ''); // URL отдаёт IPv6 в скобках
  if (isIP(bare) && isBlockedAddress(bare)) throw new BlockedTargetError(bare);
}

/**
 * Разобрать и проверить цель редиректа. Вынесено отдельной функцией, чтобы ветку редиректа можно
 * было проверить тестом без сети: сам цикл до неё не доходит, пока первый хоп ведёт на локальный
 * адрес (а любой локальный адрес мы обязаны блокировать). Дублирует проверки внутри `once` —
 * так и задумано: обход через `302` слишком дёшев, чтобы полагаться на один рубеж.
 */
export function resolveRedirect(location: string, base: URL, skipLiteralCheck = false): URL {
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    throw new BlockedTargetError('битый Location');
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new BlockedTargetError(`редирект на схему ${next.protocol}`);
  }
  // skipLiteralCheck ставится ТОЛЬКО тестом с подменным резолвером: там целью заведомо служит
  // loopback, который боевой путь обязан блокировать.
  if (!skipLiteralCheck) assertLiteralAllowed(next.hostname);
  return next;
}

/**
 * Подменный резолвер — ТОЛЬКО для тестов.
 *
 * Нужен вот зачем: успешный путь иначе не проверить. Любой адрес, который можно поднять в тесте,
 * — это loopback, а его фильтр обязан блокировать. В результате все тесты проверяли только отказы,
 * и полная неработоспособность (Node звал резолвер с `all: true`, получал не тот тип и падал на
 * КАЖДОМ запросе) прошла мимо зелёного прогона.
 *
 * В боевом коде передавать НЕЛЬЗЯ: это снимает защиту от SSRF.
 */
export type TestLookup = typeof dnsLookup;

/**
 * Один запрос без следования редиректам. Тело обрезается на `maxBytes`; `truncated` говорит, было ли
 * обрезание (для страницы это норма, для JSON соседа — битый ответ).
 */
function once(
  url: URL,
  headers: Record<string, string>,
  lookup: TestLookup = safeLookup,
  opts: { method?: 'GET' | 'POST'; body?: Buffer; maxBytes?: number; binary?: boolean; deadlineMs?: number } = {},
): Promise<SafeResponse & { location?: string; truncated: boolean }> {
  if (lookup === safeLookup) assertLiteralAllowed(url.hostname);
  const isHttps = url.protocol === 'https:';
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const deadlineMs = opts.deadlineMs ?? REQUEST_DEADLINE_MS;
  const req = (isHttps ? httpsRequest : httpRequest)({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: opts.method ?? 'GET',
    headers,
    lookup,
    timeout: TIMEOUT_MS,
  });

  // 🔴 Общий срок: по истечении сокет рвётся, а уже полученный кусок ответа НЕ отдаётся — половина
  // JSON или картинки хуже, чем честная ошибка (см. `REQUEST_DEADLINE_MS`).
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    req.destroy(new Error(`срок запроса истёк (${deadlineMs} мс)`));
  }, deadlineMs);

  return new Promise<SafeResponse & { location?: string; truncated: boolean }>((resolve, reject) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
        else {
          truncated = true;
          res.destroy(); // хватит, `<head>` давно прочитан
        }
      });
      const finish = () =>
        timedOut
          ? reject(new Error(`срок запроса истёк (${deadlineMs} мс)`))
          : resolve({
          url: url.toString(),
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: opts.binary ? '' : Buffer.concat(chunks).toString('utf8'),
          ...(opts.binary ? { bytes: Buffer.concat(chunks) } : {}),
          location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          ...retryAfterOf(res.headers['retry-after']),
          truncated,
        });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
    req.end(opts.body);
  }).finally(() => clearTimeout(deadline));
}

/**
 * Забрать страницу по пользовательскому URL, следуя редиректам и проверяя КАЖДЫЙ переход.
 * Бросает `BlockedTargetError`, если цель оказалась внутренней.
 *
 * Заголовки намеренно бедные: ни кук, ни авторизации, ни наших внутренних заголовков — запрос
 * не должен нести ничего, что можно было бы утащить.
 */
export async function safeFetchPage(raw: string, testLookup?: TestLookup): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError('не URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError(`схема ${url.protocol}`); // file:, gopher:, ftp: и прочее — мимо
  }

  const headers = {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'ru,en;q=0.8',
    'user-agent': 'GusVoice link preview',
  };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await once(url, headers, testLookup ?? safeLookup);
    const redirect = res.status >= 300 && res.status < 400 && res.location;
    if (!redirect) return { url: res.url, status: res.status, contentType: res.contentType, body: res.body };
    // Новый адрес проходит ВСЕ проверки заново — включая схему и приватность (см. пункт 3 сверху).
    url = resolveRedirect(res.location as string, url, testLookup !== undefined);
  }
  throw new BlockedTargetError('слишком много редиректов');
}

// ---- Запросы к соседнему инстансу (F0 федерации, #139) -------------------------------------------

/** Предел тела запроса и ответа соседа. Документы и события федерации — килобайты, не мегабайты. */
export const PEER_MAX_BYTES = 1024 * 1024;

/**
 * Потолок для файлового ответа соседа (аватар, иконка сервера).
 *
 * Отдельно от `PEER_MAX_BYTES` и заметно выше: документы федерации — килобайты, а аватар у нас
 * разрешён до 5 МБ. 🔴 Но потолок всё равно есть, и его нельзя поднять параметром выше этого
 * значения: без него связанный сосед мог бы кормить нас гигабайтом на каждый запрос картинки.
 */
export const PEER_MAX_FILE_BYTES = 6 * 1024 * 1024;

/**
 * Э3 ЛС между инстансами (#141, Ф3): файл вложения соседа, который мы копируем к себе сразу при приёме, — до 25 МБ (порог
 * гибрида; больше — по первому открытию, часть 2). Свой потолок и свой общий срок: 25 МБ по медленной связке — минуты.
 * Включается только явным `attachment: true` запроса, общий `PEER_MAX_FILE_BYTES` для аватаров не меняется.
 */
export const PEER_MAX_ATT_BYTES = 25 * 1024 * 1024;
export const ATT_DEADLINE_MS = 5 * 60_000;

/**
 * Разрешён ли адрес соседа — до всякой сети.
 *
 * 🔴 **Список разрешённых хостов обязателен и сравнивается с `host` (имя + порт), а не с именем.**
 * Цель задаётся не пользователем, а связкой инстансов, — но URL внутри документа соседа (например,
 * адрес для событий) пишет СОСЕД. Без списка чужой инстанс направил бы наш бэкенд куда угодно.
 * ⚠️ Только `https:`: подпись запроса (F1) не заменяет шифрование — токены гостей и события едут в теле.
 * ⚠️ Логин и пароль в URL отбиваются: их некому было бы там оставить, кроме атакующего.
 *
 * `allowHttp` — ТОЛЬКО для тестов и стенда (флаг связки ставит супер-админ, план §10).
 */
export function assertPeerTarget(raw: string, allowHosts: ReadonlySet<string>, allowHttp = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError('не URL');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new BlockedTargetError(`схема ${url.protocol}`);
  }
  if (url.username || url.password) throw new BlockedTargetError('учётные данные в URL');
  const host = url.host.toLowerCase();
  const allowed = [...allowHosts].some((h) => h.toLowerCase() === host);
  if (!allowed) throw new BlockedTargetError(`хост ${host} не в списке связок`);
  return url;
}

export type PeerRequest = {
  method: 'GET' | 'POST';
  url: string;
  /** Уже сериализованный JSON. Только для POST. */
  body?: string;
  /** Дополнительные заголовки (подпись и т.п.). `host`, `content-length` задать нельзя. */
  headers?: Record<string, string>;
  /** Хосты активных связок (`host` вида `voice.example.com` или `example.com:8443`). */
  allowHosts: ReadonlySet<string>;
  /**
   * Ответ — файл, а не JSON (F2: аватар соседа). Байты приезжают в `bytes`, `body` остаётся пустым.
   * Свой `maxBytes` обязателен: общий предел рассчитан на документы в килобайтах, а картинка больше.
   */
  binary?: boolean;
  maxBytes?: number;
  /** Общий срок на запрос; выше `FILE_DEADLINE_MS` не поднимается. Нужен проверкам, боевой код берёт умолчания. */
  deadlineMs?: number;
  /** Э3: ответ — файл вложения ЛС (вместе с `binary`): потолок `PEER_MAX_ATT_BYTES`, срок `ATT_DEADLINE_MS`, любой тип. */
  attachment?: boolean;
};

/**
 * Запрос к соседнему инстансу — GET или POST (F0 федерации, #139).
 *
 * Та же защита, что у `safeFetchPage` (проверка адреса в резолвере, IP-литералы, приватные сети), плюс:
 * - цель обязана быть в `allowHosts` (`assertPeerTarget`);
 * - 🔴 **редиректы НЕ ведём вовсе** — 3xx возвращается как есть. `307/308` повторили бы POST с телом
 *   на другой адрес, и тело (токены, события) ушло бы туда, куда связка не вела;
 * - ответ больше `PEER_MAX_BYTES` — ошибка, а не обрезанный JSON;
 * - тело запроса больше `PEER_MAX_BYTES` не отправляется.
 */
export async function safePeerRequest(req: PeerRequest, testLookup?: TestLookup): Promise<SafeResponse> {
  /**
   * Режим стенда (Ф13, `federation/devPeers.ts`): хосту из явного списка `FEDERATION_DEV_PEERS` можно `http` и loopback —
   * резолвер без фильтра частных сетей. Остальные хосты проверяются как прежде; вне режима список пуст.
   */
  let dev = false;
  try {
    dev = isDevPeerHost(new URL(req.url).host);
  } catch {
    /* не URL — отобьёт assertPeerTarget */
  }
  const url = assertPeerTarget(req.url, req.allowHosts, testLookup !== undefined || dev);
  const body = req.method === 'POST' ? Buffer.from(req.body ?? '', 'utf8') : undefined;
  if (body && body.length > PEER_MAX_BYTES) throw new BlockedTargetError('тело запроса больше предела');

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'content-length' || key === 'transfer-encoding') continue;
    headers[key] = v;
  }
  headers.accept = req.binary ? (req.attachment ? '*/*' : 'image/*') : 'application/json';
  headers['user-agent'] = 'GusVoice federation';
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }

  const att = req.binary === true && req.attachment === true;
  const maxBytes = Math.min(req.maxBytes ?? PEER_MAX_BYTES, att ? PEER_MAX_ATT_BYTES : PEER_MAX_FILE_BYTES);
  const deadlineCap = att ? ATT_DEADLINE_MS : FILE_DEADLINE_MS;
  const res = await once(url, headers, testLookup ?? (dev ? dnsLookup : safeLookup), {
    method: req.method,
    body,
    maxBytes,
    binary: req.binary,
    deadlineMs: Math.min(req.deadlineMs ?? (req.binary ? deadlineCap : REQUEST_DEADLINE_MS), deadlineCap),
  });
  if (res.truncated) throw new BlockedTargetError('ответ соседа больше предела');
  return {
    url: res.url,
    status: res.status,
    contentType: res.contentType,
    body: res.body,
    bytes: res.bytes,
    ...(res.retryAfter !== undefined ? { retryAfter: res.retryAfter } : {}),
  };
}

/** `retry-after` в секундах (форму с датой соседи не шлют): 0…1 сутки, иначе поля нет. */
function retryAfterOf(raw: unknown): { retryAfter?: number } {
  const v = typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : null;
  return v !== null && v <= 86_400 ? { retryAfter: v } : {};
}

/**
 * Э3 часть 2 (#141): адрес соседа для запроса ПОТОКОМ (`federation/peerStream.ts`) — те же проверки, что у `safePeerRequest`
 * (список хостов, режим стенда, IP-литерал), и резолвер, которым подключаться. Сам поток живёт отдельным модулем: у этого
 * файла закрытый перечень зависимостей в проверках.
 */
export function resolvePeerTarget(raw: string, allowHosts: ReadonlySet<string>, testLookup?: TestLookup): { url: URL; lookup: TestLookup } {
  let dev = false;
  try {
    dev = isDevPeerHost(new URL(raw).host);
  } catch {
    /* не URL — отобьёт assertPeerTarget */
  }
  const url = assertPeerTarget(raw, allowHosts, testLookup !== undefined || dev);
  const lookup = testLookup ?? (dev ? dnsLookup : safeLookup);
  if (lookup === safeLookup) assertLiteralAllowed(url.hostname);
  return { url, lookup };
}

// ─── Доставка событий на адрес бота (#229, `bots/webhookDelivery.ts`) ─────────────────────────────────────────────────────
// Тот же принцип, что выше: адрес проверяется ВНУТРИ резолвинга, соединение идёт ровно на проверенный IP (повторного
// резолва нет), редиректы не ведутся вовсе (3xx — сбой доставки), ответ читается не дальше `maxBytes`.

/**
 * Куда нельзя НИКОГДА, даже с тумблером админа «внутренние адреса» (хоумлаб, бот в той же сети): «этот хост» и
 * неуказанный адрес, loopback (127.0.0.0/8, ::1 и v4-mapped `::ffff:127.x` — там сам бэкенд, Redis, база и служебные порты;
 * решение владельца 26.10, отменяет R297 «::1 при тумблере»), link-local (там `169.254.169.254` — метаданные облака),
 * multicast и зарезервированные. Тумблер открывает только локальную сеть (10/8, 172.16/12, 192.168/16, fc00::/7…).
 */
export function isNeverTargetAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = v4ToInt(ip);
    if (n === null) return true;
    return NEVER_V4.some(([lo, hi]) => n >= lo && n <= hi);
  }
  if (v === 6) {
    const g = expandV6(ip.toLowerCase().split('%')[0]);
    if (!g) return true;
    const zeros = (k: number) => g.slice(0, k).every((x) => x === 0);
    if (zeros(8)) return true; // ::
    if (zeros(7) && g[7] === 1) return true; // ::1 — loopback: закрыт всегда (владелец 26.10; R297 его пускал при тумблере)
    if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) {
      return isNeverTargetAddress([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.'));
    }
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (g[0] === 0xfd00 && g[1] === 0x0ec2) return true; // fd00:ec2::254 — метаданные AWS по v6
    return false;
  }
  return true;
}
const NEVER_V4 = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'].map(v4Block);

/** Адрес-цель доставки боту: при `allowInternal` отбиваются только «никогда» (`isNeverTargetAddress`), иначе — всё внутреннее. */
export function hookAddressBlocked(ip: string, allowInternal: boolean): boolean {
  return allowInternal ? isNeverTargetAddress(ip) : isBlockedAddress(ip);
}

/** `lookup` доставки: КАЖДЫЙ адрес имени проверяется (round-robin не даёт лотереи), соединение — на проверенный. */
function hookLookup(allowInternal: boolean): typeof dnsLookup {
  return ((hostname: string, options: unknown, cb: unknown) => {
    const opts = (typeof options === 'function' ? {} : ((options ?? {}) as { all?: boolean })) ?? {};
    const done = (typeof options === 'function' ? options : cb) as (
      err: NodeJS.ErrnoException | null,
      address?: string | Addr[],
      family?: number,
    ) => void;
    dnsLookup(hostname, { all: true }, (err, addrs) => {
      if (err) return done(err);
      const list = Array.isArray(addrs) ? addrs : [];
      const bad = list.find((a) => hookAddressBlocked(a.address, allowInternal));
      if (bad) return done(new BlockedTargetError(`${hostname} → ${bad.address}`));
      const res = chooseLookupResult(list, opts.all === true);
      if (!res) return done(new BlockedTargetError(`${hostname} не резолвится`));
      if ('all' in res) return done(null, res.all);
      done(null, res.address, res.family);
    });
  }) as typeof dnsLookup;
}

/**
 * Почему адрес доставки не годится (26.10): `ru` — возвращают `parseHookUrl`/`checkHookTarget` (лог и тексты для людей),
 * `en` — провод Bot API (`setWebhook` → `description`, как остальной провод, `hookUrlErrorEn`).
 */
export const HOOK_URL_ERRORS = {
  unparsed: { ru: 'адрес не разобран', en: 'invalid URL' },
  httpsOnly: { ru: 'нужен адрес https://', en: 'an HTTPS URL is required' },
  httpOrHttps: { ru: 'нужен адрес https:// или http://', en: 'an HTTPS or HTTP URL is required' },
  credentials: { ru: 'логин и пароль в адресе не принимаются', en: 'credentials in the URL are not allowed' },
  noHost: { ru: 'в адресе нет хоста', en: 'the URL has no host' },
  internal: { ru: 'адрес внутренний — доставка туда запрещена', en: 'internal addresses are not allowed' },
  unresolved: { ru: 'имя хоста не резолвится', en: 'failed to resolve host' },
} as const;

/** Текст `HOOK_URL_ERRORS[…].ru` → его английская пара для провода; незнакомое — как есть. */
export function hookUrlErrorEn(text: string): string {
  for (const e of Object.values(HOOK_URL_ERRORS)) if (e.ru === text) return e.en;
  return text;
}

/**
 * Разобрать и проверить адрес доставки без сети: схема (`https`; `http` — только при `allowInternal`), без логина в адресе,
 * IP-литерал — сразу по спискам. Ошибка — текст для автора бота.
 */
export function parseHookUrl(raw: string, allowInternal: boolean): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: HOOK_URL_ERRORS.unparsed.ru };
  }
  if (url.protocol !== 'https:' && !(allowInternal && url.protocol === 'http:')) {
    return { ok: false, error: allowInternal ? HOOK_URL_ERRORS.httpOrHttps.ru : HOOK_URL_ERRORS.httpsOnly.ru };
  }
  if (url.username || url.password) return { ok: false, error: HOOK_URL_ERRORS.credentials.ru };
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (!bare) return { ok: false, error: HOOK_URL_ERRORS.noHost.ru };
  if (isIP(bare) && hookAddressBlocked(bare, allowInternal)) return { ok: false, error: HOOK_URL_ERRORS.internal.ru };
  return { ok: true, url };
}

/** Проверка адреса доставки при `setWebhook`: разбор + резолв ВСЕХ адресов имени. `null` — годится. */
export async function checkHookTarget(raw: string, allowInternal: boolean, testLookup?: TestLookup): Promise<string | null> {
  const parsed = parseHookUrl(raw, allowInternal);
  if (!parsed.ok) return parsed.error;
  const bare = parsed.url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return null;
  const lookup = testLookup ?? hookLookup(allowInternal);
  return new Promise((resolve) => {
    (lookup as (h: string, o: { all: true }, cb: (err: Error | null) => void) => void)(bare, { all: true }, (err) =>
      resolve(err ? (err instanceof BlockedTargetError ? HOOK_URL_ERRORS.internal.ru : HOOK_URL_ERRORS.unresolved.ru) : null),
    );
  });
}

/**
 * POST события на адрес бота. Бросает при сетевой ошибке, отказе цели и сроке; ответ (статус и первые `maxBytes` тела)
 * возвращает как есть — успех решает вызывающий (2xx). Редиректы не ведутся.
 */
export async function safeHookPost(
  raw: string,
  body: Buffer,
  headers: Record<string, string>,
  opts: { allowInternal: boolean; deadlineMs: number; maxBytes: number },
  testLookup?: TestLookup,
): Promise<{ status: number; body: string }> {
  const parsed = parseHookUrl(raw, opts.allowInternal);
  if (!parsed.ok) throw new BlockedTargetError(parsed.error);
  const res = await once(parsed.url, { ...headers, 'content-length': String(body.length) }, testLookup ?? hookLookup(opts.allowInternal), {
    method: 'POST',
    body,
    maxBytes: opts.maxBytes,
    deadlineMs: opts.deadlineMs,
  });
  return { status: res.status, body: res.body };
}
