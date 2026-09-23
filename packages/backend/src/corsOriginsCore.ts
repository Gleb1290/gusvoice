/**
 * Кому разрешён CORS — сама логика, без базы и `env` (вынос для тестов 22.09; проводка — `corsOrigins.ts`).
 *
 * Здесь всё, что решает: нормализация источника, отказ `null`, источники разработки, какие связки
 * дают источник, кеш на минуту и порядок перечитываний. Снаружи — только чтение связок и часы.
 */

/**
 * Привести источник к сравнимому виду.
 *
 * 🔴 `new URL(...).origin` — ТОЛЬКО для `http(s)`: у нестандартной схемы (`tauri://localhost`) он
 * равен строке `"null"` — ровно той, что шлют страницы из `data:`, `file:` и «песочниц» любого сайта.
 * Первая версия (22.09, `75b1f3ab`) нормализовала так всё подряд, и в разрешённых оказался `null` —
 * ревью #195 п. 1 воспроизвело это на проде. Всё, что не `http(s)`, сравнивается строкой как есть.
 */
export function normalizeOrigin(origin: string): string {
  const raw = origin.trim().toLowerCase();
  if (!/^https?:\/\//.test(raw)) return raw;
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return raw;
  }
}

/** Источник «нет источника» — страницы `data:`/`file:`/песочницы. Никогда не разрешён (#195 п. 1). */
export const NULL_ORIGIN = 'null';

/**
 * Источники разработки — только когда и сам клиент локальный (`CLIENT_ORIGIN` на `localhost`).
 * На проде они разрешены были зря (#195 п. 12): любая программа на машине человека на этом порту
 * получала бы тот же доступ, что и наш клиент.
 */
export function devOrigins(clientOrigin: string): string[] {
  let host = '';
  try {
    host = new URL(clientOrigin).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (host !== 'localhost' && host !== '127.0.0.1') return [];
  return ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:1420'];
}

/** Постоянные источники: свой веб-клиент, оболочки Tauri, разработка, `CORS_EXTRA_ORIGINS`. */
export function staticOriginsFor(opts: { clientOrigin: string; extraOrigins: readonly string[] }): string[] {
  return [
    opts.clientOrigin,
    // Tauri v2: Windows и Android — `http://tauri.localhost` (`https://` при `useHttpsScheme`),
    // macOS, Linux и iOS — `tauri://localhost`.
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    ...devOrigins(opts.clientOrigin),
    ...opts.extraOrigins,
  ];
}

/**
 * Связки, чей `client_origin` разрешён. Не только рабочие (#195 п. 13): гостю связки «доверие
 * потеряно» или разорванной хост нарочно отвечает честным 409 — и браузер обязан дать странице его
 * прочитать, иначе человек видит безликую «ошибку сети». Токенов у таких гостей уже нет (заморозка),
 * так что разрешение источника ничего не открывает — только объяснение.
 * 🔴 Но НЕ заявки и ожидания (#196 п. 10): `requested`/`pending` — источники, которых держатель не
 * одобрял; заявка пишется до ответа соседа и остаётся даже после отказа.
 */
export const CORS_LINK_STATES: readonly string[] = ['active', 'paused', 'blocked', 'trust-lost'];

/** Источник связки годится в список: состояние из `CORS_LINK_STATES` и только `http(s)`, не `null`. */
export function peerOriginOf(row: { origin: string; state: string }): string | null {
  if (!CORS_LINK_STATES.includes(row.state)) return null;
  const o = normalizeOrigin(row.origin);
  if (o.length === 0 || o === NULL_ORIGIN || !/^https?:\/\//.test(o)) return null;
  return o;
}

export interface CorsOriginsDeps {
  /** Все связки: источник их клиента и состояние. Фильтрует `peerOriginOf`, не запрос. */
  readOrigins: () => Promise<Array<{ origin: string; state: string }>>;
  now: () => number;
  /** Сырые постоянные источники (`staticOriginsFor`); нормализуются и чистятся от `null` здесь. */
  staticOrigins: Iterable<string>;
  /** Срок кеша источников связок. По умолчанию минута. */
  ttlMs?: number;
}

export function createCorsOrigins(deps: CorsOriginsDeps) {
  const ttlMs = deps.ttlMs ?? 60_000;
  const staticSet = new Set<string>(
    [...deps.staticOrigins].map(normalizeOrigin).filter((o) => o.length > 0 && o !== NULL_ORIGIN),
  );
  let peerOrigins = new Set<string>();
  let refreshedAt = 0;
  let refreshing: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  /** Перечитать `client_origin` связок. Зовётся при старте, в фоне (кеш старше срока) и при смене связки. */
  function refreshPeerOrigins(opts: { force?: boolean } = {}): Promise<void> {
    /**
     * Чтение уже идёт. Для перемены связки (`force`) присоединяться к нему нельзя (#198 п. 9): оно могло
     * начаться ДО перемены и вернуть старый список — ставим ещё одно чтение следом, одно на всех, кто
     * ждёт. А обновлению по сроку свежесть до миллисекунды не нужна — оно присоединяется (#199 п. 9):
     * иначе каждое плановое обновление под нагрузкой читало базу дважды.
     */
    if (refreshing) {
      if (!opts.force) return refreshing;
      if (!queued) {
        queued = refreshing
          .catch(() => {})
          .then(() => {
            queued = null;
            return refreshPeerOrigins({ force: true });
          });
      }
      return queued;
    }
    refreshing = Promise.resolve()
      .then(() => deps.readOrigins())
      .then((rows) => {
        const next = new Set<string>();
        for (const row of rows) {
          const o = peerOriginOf(row);
          if (o) next.add(o);
        }
        peerOrigins = next;
        refreshedAt = deps.now();
      })
      .catch(() => {
        /* база не ответила — живём с прежним списком */
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /** Разрешён ли источник. Синхронно: проверка стоит на пути каждого запроса. */
  function originAllowed(origin: string): boolean {
    if (deps.now() - refreshedAt > ttlMs) void refreshPeerOrigins();
    const o = normalizeOrigin(origin);
    if (o.length === 0 || o === NULL_ORIGIN) return false;
    return staticSet.has(o) || peerOrigins.has(o);
  }

  /** Обработчик для `@fastify/cors`. Запрос без `Origin` проходит — CORS правило браузера, не проверка подлинности. */
  function corsOriginCheck(origin: string | undefined, cb: (err: Error | null, allow: boolean) => void): void {
    if (!origin) return cb(null, true);
    cb(null, originAllowed(origin));
  }

  return { refreshPeerOrigins, originAllowed, corsOriginCheck };
}

export type CorsOrigins = ReturnType<typeof createCorsOrigins>;
