import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

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
const TIMEOUT_MS = 5000;
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

export type SafeResponse = { url: string; status: number; contentType: string; body: string };

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
  opts: { method?: 'GET' | 'POST'; body?: Buffer; maxBytes?: number } = {},
): Promise<SafeResponse & { location?: string; truncated: boolean }> {
  if (lookup === safeLookup) assertLiteralAllowed(url.hostname);
  const isHttps = url.protocol === 'https:';
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
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

  return new Promise((resolve, reject) => {
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
        resolve({
          url: url.toString(),
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
          location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          truncated,
        });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', reject);
    req.end(opts.body);
  });
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
  const url = assertPeerTarget(req.url, req.allowHosts, testLookup !== undefined);
  const body = req.method === 'POST' ? Buffer.from(req.body ?? '', 'utf8') : undefined;
  if (body && body.length > PEER_MAX_BYTES) throw new BlockedTargetError('тело запроса больше предела');

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'content-length' || key === 'transfer-encoding') continue;
    headers[key] = v;
  }
  headers.accept = 'application/json';
  headers['user-agent'] = 'GusVoice federation';
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }

  const res = await once(url, headers, testLookup ?? safeLookup, { method: req.method, body, maxBytes: PEER_MAX_BYTES });
  if (res.truncated) throw new BlockedTargetError('ответ соседа больше предела');
  return { url: res.url, status: res.status, contentType: res.contentType, body: res.body };
}
