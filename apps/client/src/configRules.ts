/**
 * Чистые правила конфигурации клиента — БЕЗ `window`, `localStorage` и `import.meta.env`.
 *
 * Вынесено из `config.ts` по просьбе Codex (2026-07-27): тот модуль выполняет миграцию реестра
 * инстансов ПРЯМО НА ИМПОРТЕ и трогает `window`, поэтому в Node не грузился вовсе. Цена ошибки —
 * потерянный токен (человека разлогинило), не тот активный инстанс или запрос discovery не туда.
 */

export interface RuntimeConfig {
  apiUrl?: string;
  presenceWs?: string;
  pushGateway?: string;
  // Display-only: which ntfy server the push-setup guide tells users to configure. DECOUPLED from
  // pushGateway (which also switches Android to the built-in push distributor) — this never changes
  // the push flow, it's just the address shown in the guide. Keeps our prod's ntfy out of the shared
  // client source (set per-server via VITE_NTFY_SERVER / discovery).
  ntfyServer?: string;
  /**
   * Собирает ли ЭТОТ инстанс диагностику (#113). Приезжает из его же `/config.js` (веб) или
   * `/config.json` (десктопный пикер), то есть от того сервера, к которому мы подключены.
   *
   * ⚠️ Это не разрешение человека, а разрешение ИНСТАНСА: у самохостера сбор выключен, и клиент не
   * должен даже спрашивать согласия — спрашивать не о чем. Согласие человека — отдельный слой.
   */
  diagEnabled?: boolean;
  /**
   * Включена ли на ЭТОМ инстансе экономика ГусКоинов (#117). Приезжает оттуда же, откуда
   * `diagEnabled`.
   *
   * ⚠️ Это про инстанс, а не про сервер внутри него: выключено — вкладки «Монеты» нет ни у кого,
   * включая владельца, и маршрутов экономики на бэкенде тоже нет.
   */
  economyEnabled?: boolean;
}

/**
 * A resolved instance the client talks to. Two ways it is supplied:
 *  - **embedded build (web):** an instance's own nginx injects `window.__GUSVOICE_CONFIG__` at
 *    container start (see docker-entrypoint.sh), so the web client is same-origin and needs no picker.
 *  - **picker build (generic desktop/mobile):** nothing is baked in; the user enters their server's
 *    address once (server-picker → fetches <base>/config.json → stored here), and everything derives
 *    from it. A desktop build that DOES bake VITE_API_URL (an instance's own branded build) skips the
 *    picker too.
 */
export interface ServerConfig {
  apiUrl: string;
  presenceWs: string;
  pushGateway?: string;
  ntfyServer?: string;
  diagEnabled?: boolean;
  economyEnabled?: boolean;
}

/**
 * A saved instance in the multi-instance registry (#7). Each instance is a SEPARATE backend
 * (own domain / accounts / JWT secret / servers) — a token minted by instance A is meaningless
 * on instance B. Switching instances = pick one active + restart the app (the frozen `config`
 * re-resolves from the active instance on the next module load). Token-only: we remember the
 * per-instance JWT (7-day) so a switch is instant; when it expires the instance's login screen
 * shows with the email pre-filled. NO password is stored anywhere.
 */
export interface Instance extends ServerConfig {
  id: string; // local uuid (NOT the backend userId)
  name: string; // display name (defaults to the apiUrl host)
  token: string | null; // JWT of THIS instance (was the single gv_token)
  userId?: string; // whose account (for the rail icon)
  displayName?: string; // cached for the rail icon label
  avatarUrl?: string; // cached for the rail icon
  lastLogin?: string; // username/email to pre-fill next login on this instance
  color?: string; // fallback icon colour
  order: number; // position in the switcher list
}

export function stripSlash(s: string | undefined | null): string {
  return (s || '').replace(/\/+$/, '');
}

/** Host label from an apiUrl ("https://api.voice.example.com" → "api.voice.example.com"), best-effort. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Friendly "server" host for display: the apiUrl host with a leading `api.` stripped
 * ("api.voice.example.com" → "voice.example.com") — the address users think of as their server
 * (the web origin), not the API sub-domain. Used as the default instance name / display label (#7).
 */
export function serverHost(url: string): string {
  return hostOf(url).replace(/^api\./i, '');
}

/**
 * Свободный ввод адреса сервера → ГОЛЫЙ origin. Мусор (в том числе пустая строка) → `''`, и это
 * сигнал «адрес не годится»: и пикер, и `fetchDiscovery` проверяют результат на пустоту.
 *
 * 🔴 **Раньше здесь резалась строка** (#89): дописывалась схема и срезались хвостовые слэши — а путь
 * и query выживали. `fetchDiscovery` клеит `/config.json` В КОНЕЦ, поэтому скопированный из адресной
 * строки браузера адрес (`voice.example.org/channels/12`) уходил запросом на
 * `…/channels/12/config.json` и рабочий сервер отвечал «проверьте адрес». Разбираем через `URL` и
 * берём `origin`: порт и схема сохраняются, всё лишнее отваливается.
 *
 * 🔴 **И схема дописывалась вслепую** (#95), из-за чего негодный ввод становился ЧУЖИМ рабочим
 * origin вместо отказа: `ftp://example.org` → `https://ftp`, `mailto:a@b.c` → `https://b.c`. Хуже
 * всего `voice.example.com@evil.org` → `https://evil.org`: всё до `@` браузер считает user-info, так
 * что строка читается как наш адрес, а инстанс добавится чужой — а это ровно то поле, куда человек
 * вставляет присланный кем-то адрес. Поэтому ниже три отказа вместо молчаливого «почти получилось».
 */
export function normalizeServerInput(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const explicit = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (explicit) {
    if (!/^https?$/i.test(explicit[1])) return ''; // ws://, ftp://, file:// — не наш транспорт
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) {
    // Схема без `//`: `mailto:`, `javascript:`, `data:`. ⚠️ Цифра после двоеточия ОБЯЗАНА оставаться
    // разрешённой — иначе под этот же отказ попадёт `localhost:3000`, штатный ввод самохостера.
    return '';
  }
  try {
    const u = new URL(explicit ? s : `https://${s}`);
    if (u.username || u.password) return ''; // user-info: хост не тот, что видит человек
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

export function instanceFrom(src: ServerConfig, token: string | null, order: number, id: string): Instance {
  return {
    id,
    name: serverHost(src.apiUrl),
    apiUrl: stripSlash(src.apiUrl),
    presenceWs: stripSlash(src.presenceWs),
    pushGateway: stripSlash(src.pushGateway),
    ntfyServer: stripSlash(src.ntfyServer),
    token,
    order,
  };
}

export interface RegistryState {
  instances: Instance[];
  activeId: string | null;
}

export interface MigrateInput extends RegistryState {
  /** Легаси-сервер из старого одиночного `gv_server` (до #7), если он ещё лежит. */
  legacy: ServerConfig | null;
  /** База из nginx-инъекции или VITE-переменных (embedded-сборки). */
  envBase: ServerConfig | null;
  /** `window.__GUSVOICE_CONFIG__` — присутствует ТОЛЬКО у embedded-веба, у десктопа его нет никогда. */
  injected: RuntimeConfig;
  /** Легаси-токен `gv_token` — переезжает в первый инстанс, иначе сессию бы выбросило. */
  legacyToken: string | null;
  newId: () => string;
}

/**
 * Одноразовый переезд со старого одиночного сервера на реестр инстансов (#7) плюс поддержание
 * реестра в порядке. Чистая функция: получает текущее состояние, возвращает новое.
 *
 * Три шага, порядок важен:
 * 1. **Пустой реестр** — засеять инстанс №1 из легаси-сервера или из embedded-базы, перенеся токен.
 *    Пикер-сборка без выбранного сервера остаётся пустой (`needsServerPick()` покажет пикер).
 * 2. **Embedded-веб** — инъекция nginx авторитетна (это same-origin, оператор мог сменить домен),
 *    поэтому сетевые поля активного инстанса подтягиваются к ней. ⚠️ Срабатывает только при наличии
 *    `injected.apiUrl`, то есть у десктопа не может затереть выбранный вручную инстанс.
 * 3. **Освежение авто-имён** — старые имена вида `api.voice.example.org` подтягиваются к дружелюбному
 *    `voice.example.org`. ⚠️ Только если имя РАВНО сырому хосту, то есть переименованное человеком
 *    не трогаем.
 *
 * Плюс гарантия: при непустом реестре активный id всегда указывает на существующий инстанс.
 */
export function migrateRegistry(inp: MigrateInput): RegistryState {
  let list = inp.instances.slice();
  let activeId = inp.activeId;

  if (list.length === 0) {
    const src = inp.legacy || inp.envBase;
    if (src) {
      const inst = instanceFrom(src, inp.legacyToken, 0, inp.newId());
      list = [inst];
      activeId = inst.id;
    }
  }

  if (inp.injected.apiUrl) {
    let idx = list.findIndex((i) => i.id === activeId);
    if (idx < 0) idx = 0;
    const cur = list[idx];
    if (cur) {
      list[idx] = {
        ...cur,
        apiUrl: stripSlash(inp.injected.apiUrl),
        presenceWs: stripSlash(inp.injected.presenceWs || cur.presenceWs),
        pushGateway: stripSlash(inp.injected.pushGateway || cur.pushGateway),
        ntfyServer: stripSlash(inp.injected.ntfyServer || cur.ntfyServer),
      };
      if (!activeId) activeId = list[idx].id;
    }
  }

  list = list.map((i) =>
    i.name === hostOf(i.apiUrl) && i.name !== serverHost(i.apiUrl) ? { ...i, name: serverHost(i.apiUrl) } : i,
  );

  if (list.length && !list.some((i) => i.id === activeId)) activeId = list[0].id;

  return { instances: list, activeId };
}
