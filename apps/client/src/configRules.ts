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
 * on instance B. Переход между инстансами — мягкий, без перезапуска приложения (§5.7,
 * `instanceSwitch.ts`); `config` живой и отвечает по активной записи. Token-only: we remember the
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
  /**
   * `instance_id` этого инстанса в федерации (#139, F4) — не путать с локальным `id` записи.
   *
   * ⚠️ Локальный `id` случайный и живёт только в этом браузере; сопоставлять записи с тем, что
   * приходит от бэкенда (связки, членства гостя, отзывы), можно ТОЛЬКО по этому полю.
   */
  federationInstanceId?: string;
  /**
   * 🔴 Запись «**гость на хосте через дом**» (§5.7): локальный `id` той записи, чей человек здесь
   * гость. Пароля у этой записи нет и быть не может — токен выдан хостом под поручительство дома,
   * и когда он протухнет, войти заново можно опять же только через дом. Поэтому на такой записи
   * экран входа показывать нельзя: человеку там нечего вводить.
   */
  guestOf?: string;
  /** Домен хоста — им подписан значок инстанса в рейле и по нему человек узнаёт, куда попал. */
  domain?: string;
  /**
   * 🔴 Снимок серверов ЭТОЙ записи — чтобы рейл показывал их, пока живой шлюз открыт у другого
   * инстанса (§5.7).
   *
   * Живой инстанс в клиенте пока один, а серверы в рейле должны стоять на месте ВСЕГДА: без снимка
   * человек, ушедший гостем к соседу, переставал видеть собственные серверы — и возвращался к ним
   * отдельной кнопкой «вернуться в свой инстанс». Кнопки не должно быть, значит список должен
   * помниться.
   *
   * ⚠️ Снимок, а не правда: пишется после каждой удачной загрузки списка на этом инстансе. Счётчиков
   * непрочитанного здесь нет намеренно — их неоткуда взять, пока шлюз не открыт, а показывать
   * вчерашнее число хуже, чем не показывать никакого.
   */
  servers?: InstanceServer[];
  /**
   * Аккаунт этой записи — супер-админ своего инстанса (снимок, 23.09). Пишется при каждой загрузке
   * профиля, пока запись активна (`noteActiveSuperAdmin`).
   *
   * 🔴 Нужен ровно на то время, когда человек стоит гостем у соседа: живой `user` тогда — его гостевая
   * учётка там, прав у неё нет, и кнопка админки СОБСТВЕННОГО инстанса пропадала — хотя администрирует
   * он по-прежнему свой (находка на мегаприёмке 23.09). Правило — `adminTarget`.
   */
  superAdmin?: boolean;
}

/** Строка снимка серверов инстанса: ровно то, что нужно нарисовать кнопку в рейле. */
export interface InstanceServer {
  id: string;
  name: string;
  iconUrl?: string | null;
}

/**
 * Веб-клиент открыт по `http://`, а API инстанса — на `https://` → адрес той же страницы по `https://`;
 * иначе `null` (22.09).
 *
 * 🔴 CORS пускает только собственный источник клиента (аудит F-21, `corsOrigins.ts`), а это `https://…`.
 * Со страницы по `http://` тот же домен — ДРУГОЙ источник: каждый запрос к API браузер обрывает, и
 * человек видит «Load failed» уже на регистрации (так и случилось у первого нового человека после F-21;
 * до F-21 CORS отражал любой источник, и http-страница работала). Возвращать http в CORS нельзя —
 * страница по http читается и подменяется по дороге, пароль с неё не защищён. Поэтому уводим на https.
 *
 * Не трогаем: оболочку Tauri (Windows/Android живут на `http://tauri.localhost`), `localhost`,
 * `*.localhost` и адреса-IP (разработка, домашняя сеть), инстансы с API по http (TLS у них нет вовсе).
 */
export function httpsUpgradeUrl(
  loc: { protocol: string; hostname: string; href: string },
  apiUrl: string | undefined,
  tauri: boolean,
): string | null {
  if (tauri || loc.protocol !== 'http:') return null;
  const host = loc.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (!apiUrl || !/^https:\/\//i.test(apiUrl.trim())) return null;
  if (!/^http:\/\//i.test(loc.href)) return null;
  return `https://${loc.href.slice('http://'.length)}`;
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

/**
 * Годится ли найденная запись гостя — или её надо завести заново.
 *
 * 🔴 Запись, чей адрес API совпадает с адресом ДОМА, негодна всегда. Гостем у самого себя быть
 * нельзя: связку с собой инстанс отвергает (`self-link`), поэтому такая запись — только след
 * ошибки. На стенде 17.09 она стоила рабочего вечера: реестр говорил «ты в гостях у соседа», рейл
 * рисовал гостевую группу, а запросы уходили ДОМОЙ и отвечали 404 на чужой id сервера. Человек
 * видел пустой рейл и «Выбери сервер», и починить это руками было нечем — запись переиспользовалась
 * при каждой попытке (#152).
 *
 * ⚠️ Сравниваем, стоя ДОМА (`home.guestOf` пуст). На гостевой записи «дом» — это сам хост, и
 * совпадение адресов там законно.
 */
/**
 * Уже заведённая гостевая запись на этом хосте: по `federationInstanceId`, иначе по сохранённому в записи
 * `domain`, иначе по хосту адреса API.
 *
 * 🔴 Поиск по `domain` записи — прогон F-20 на стенде 23.09. Хост сменил ключ (новая личность) и был
 * перепривязан: по `federationInstanceId` старая запись уже не находится, а запасной поиск сравнивал
 * только `serverHost(apiUrl)` — у соседа с API на `api.example.org` и доменом `voice.example.org`
 * это `example.org`, мимо. Заводилась ВТОРАЯ запись, и в рейле вставали две группы одного соседа —
 * живая и мёртвая. Поле `domain` в записи было всё это время.
 */
export function findGuestEntry(list: readonly Instance[], federationInstanceId: string, domain?: string): Instance | null {
  const guests = list.filter((i) => i.guestOf);
  const byId = guests.find((i) => i.federationInstanceId === federationInstanceId);
  if (byId) return byId;
  if (!domain) return null;
  const d = domain.trim().toLowerCase();
  return (
    guests.find((i) => (i.domain ?? '').trim().toLowerCase() === d) ??
    guests.find((i) => serverHost(i.apiUrl).toLowerCase() === d) ??
    null
  );
}

/**
 * Найденная запись знает ПРЕЖНЮЮ личность хоста — хост сменил ключ и был перепривязан. Её сессия выдана
 * прежней личностью и погашена (перепривязка поднимает поколение токенов гостей): не пробуем её, а
 * берём новую — иначе человек получал бы «сессия истекла» и нажимал второй раз.
 */
export function guestEntryRebound(entry: Instance, federationInstanceId: string): boolean {
  return !!entry.federationInstanceId && entry.federationInstanceId !== federationInstanceId;
}

/**
 * Показывать ли кнопку админки и куда она ведёт (23.09).
 *
 * - Стоим в своей записи — решает живой профиль (`liveSuperAdmin`), переход не нужен: `{ homeId: null }`.
 * - Стоим гостем — решает снимок домашней записи: её аккаунт супер-админ и вход не потерян → кнопка есть
 *   и ведёт домой (`homeId`). Админку открываем уже там: окно говорит с API активного инстанса, и у
 *   соседа оно показало бы чужой инстанс или отказ.
 * - Иначе `null` — кнопки нет.
 */
export function adminTarget(
  list: readonly Instance[],
  activeId: string | null,
  liveSuperAdmin: boolean,
): { homeId: string | null } | null {
  const active = list.find((i) => i.id === activeId);
  if (!active?.guestOf) return liveSuperAdmin ? { homeId: null } : null;
  const home = list.find((i) => i.id === active.guestOf);
  return home && !home.guestOf && home.superAdmin && home.token ? { homeId: home.id } : null;
}

/**
 * Дом человека: активная запись, если она своя, иначе та, чьим гостем она числится (#205).
 *
 * 🔴 Всё, что делает ДОМ, — проверка ссылки, поручительство перед хостом, «где я гость», вступление по
 * своей ссылке — адресуется дому, а не активной записи. Стоя гостем у соседа, клиент раньше спрашивал
 * соседа: тот гостям такие маршруты закрывает (F-16) → 403, окно откатывалось на старый путь, хост
 * отвечал «invalid invite» на чужой код и засчитывал промах — через пару попыток блокировка на 15 минут.
 * Гостевая запись без живой домашней (дом удалён из реестра) — `null`: ручаться за человека некому.
 */
export function homeEntry(list: readonly Instance[], activeId: string | null): Instance | null {
  const active = list.find((i) => i.id === activeId) ?? null;
  if (!active?.guestOf) return active;
  const home = list.find((i) => i.id === active.guestOf);
  return home && !home.guestOf ? home : null;
}

export function usableGuestEntry(found: Instance | null, home: Instance | null): Instance | null {
  if (!found) return null;
  if (home && !home.guestOf && found.apiUrl === home.apiUrl) return null;
  return found;
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
    /**
     * 🔴 ГОСТЕВУЮ запись этим трогать нельзя (#152).
     *
     * `injected` описывает инстанс, который ОТДАЛ эту страницу, — то есть дом. Когда человек ушёл
     * гостем на чужой хост, активна запись хоста, а страница по-прежнему домашняя: перезапись
     * подставляла бы ей домашний адрес API. Причём при КАЖДОЙ загрузке, поэтому чинить такую
     * запись было бессмысленно — она портилась заново.
     *
     * Стоило вечера на стенде 17.09: реестр говорил «ты в гостях у соседа», рейл рисовал гостевую
     * группу, а запросы уходили домой — с токеном чужого инстанса. Дом отвечал 401, и человека
     * просто выбрасывало из аккаунта.
     */
    if (cur && !cur.guestOf) {
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

  /**
   * Вылечить записи, уже испорченные прежним поведением (#152).
   *
   * Гостевая запись, чей адрес API совпал с адресом СВОЕГО ЖЕ дома, — не рабочее состояние, а
   * мусор: гостем у самого себя быть нельзя, связку с собой инстанс отвергает. Держать её незачем,
   * и починить её содержимое мы не можем — верный адрес знает только хост. Выбрасываем, и вход
   * гостем заведёт запись заново, уже правильно.
   *
   * ⚠️ Если выброшенная запись была активной — возвращаем человека ДОМОЙ, а не на первую попавшуюся:
   * дом у гостевой записи записан, и именно там у человека есть пароль и своя жизнь.
   */
  const byId = new Map(list.map((i) => [i.id, i]));
  const broken = list.filter((i) => i.guestOf && byId.get(i.guestOf)?.apiUrl === i.apiUrl);
  if (broken.length) {
    const homeOfActive = broken.find((i) => i.id === activeId)?.guestOf ?? null;
    list = list.filter((i) => !broken.includes(i));
    if (homeOfActive && list.some((i) => i.id === homeOfActive)) activeId = homeOfActive;
  }

  if (list.length && !list.some((i) => i.id === activeId)) activeId = list[0].id;

  return { instances: list, activeId };
}
