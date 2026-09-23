import {
  hostOf,
  instanceFrom,
  migrateRegistry,
  normalizeServerInput,
  serverHost,
  stripSlash,
  type Instance,
  type InstanceServer,
  type RuntimeConfig,
  type ServerConfig,
} from './configRules';
import { isTauri } from './hotkeys';

// Чистые правила (нормализация адреса, переход реестра) — в `configRules.ts`, там же и типы.
// Реэкспорт, чтобы компоненты продолжали импортировать их из `./config`.
export type { Instance, InstanceServer, ServerConfig } from './configRules';
export { normalizeServerInput, serverHost } from './configRules';

declare global {
  interface Window {
    __GUSVOICE_CONFIG__?: RuntimeConfig;
  }
}

const SERVER_KEY = 'gv_server'; // legacy single-server (pre-#7)
const TOKEN_KEY = 'gv_token'; // legacy single-token (pre-#7)
const INSTANCES_KEY = 'gv_instances';
const ACTIVE_KEY = 'gv_active_instance';

/** Public "picker" clients (desktop .exe/.msi + Android APK) are published here. Used as the download
 *  FALLBACK on instances without their own signed build feed (turnkey → /download/windows 503s): the
 *  picker clients connect to ANY server via the server-picker, so they're the right client for a
 *  self-hoster with no build pipeline. (#48) A rebrand points this at its own releases page. */
export const RELEASES_URL = 'https://github.com/Gleb1290/gusvoice/releases/latest';

const injected: RuntimeConfig = window.__GUSVOICE_CONFIG__ ?? {};

/**
 * Кеш посчитанного `config` (само вычисление и зачем оно живое — ниже, у `config`).
 *
 * 🔴 **Объявлены ЗДЕСЬ, а не рядом с `config`, и это не вкусовщина.** `migrate()` вызывается на
 * загрузке модуля и пишет в реестр, а запись зовёт `invalidateConfig()`. Пока объявление стояло
 * ниже по файлу, к моменту вызова переменная была в мёртвой зоне `let` — и приложение падало
 * насмерть ещё до первой отрисовки: `Cannot access 'resolvedCache' before initialization`, чёрный
 * экран у КАЖДОГО, у кого реестр на старте меняется (то есть у всех при первом заходе).
 *
 * ⚠️ Правило шире одного случая: всё, к чему тянется `migrate()`, обязано быть объявлено ВЫШЕ его
 * вызова. Типы такого не ловят, и сборка тоже — только запуск.
 */
let resolvedCache: ResolvedConfig | null = null;

/** Сбросить посчитанный конфиг — зовётся из любой записи в реестр. */
export function invalidateConfig(): void {
  resolvedCache = null;
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `i_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function readInstances(): Instance[] {
  try {
    const a = JSON.parse(localStorage.getItem(INSTANCES_KEY) || 'null');
    return Array.isArray(a) ? (a as Instance[]) : [];
  } catch {
    return [];
  }
}

function writeInstances(list: Instance[]): void {
  invalidateConfig();
  try {
    localStorage.setItem(INSTANCES_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

function readActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActiveId(id: string | null): void {
  invalidateConfig();
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The legacy single server the user chose via the old picker (pre-#7). */
function legacyStoredServer(): ServerConfig | null {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<ServerConfig>;
    return s && typeof s.apiUrl === 'string' && s.apiUrl ? (s as ServerConfig) : null;
  } catch {
    return null;
  }
}

/** The build-time / nginx-injected base, if any (embedded builds). */
function envBase(): ServerConfig | null {
  const apiUrl = injected.apiUrl || import.meta.env.VITE_API_URL || null;
  if (!apiUrl) return null;
  return {
    apiUrl,
    presenceWs: injected.presenceWs || import.meta.env.VITE_PRESENCE_WS || '',
    pushGateway: injected.pushGateway || import.meta.env.VITE_PUSH_GATEWAY || '',
    ntfyServer: injected.ntfyServer || import.meta.env.VITE_NTFY_SERVER || '',
    diagEnabled: injected.diagEnabled === true,
    economyEnabled: injected.economyEnabled === true,
  };
}

function legacyToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * One-time migration from the legacy single `gv_server`/`gv_token` to the instance registry (#7).
 * Runs at module load, BEFORE `config` is computed, so an existing session is never logged out.
 * Сам переход — чистый `migrateRegistry` (правила и порядок шагов описаны там); здесь только
 * чтение/запись `localStorage`.
 */
function migrate(): void {
  const before = readInstances();
  const next = migrateRegistry({
    instances: before,
    activeId: readActiveId(),
    legacy: legacyStoredServer(),
    envBase: envBase(),
    injected,
    legacyToken: legacyToken(),
    newId: makeId,
  });

  if (JSON.stringify(next.instances) !== JSON.stringify(before)) writeInstances(next.instances);
  if (next.activeId !== readActiveId()) writeActiveId(next.activeId);

  // Legacy gv_server is fully superseded; gv_token is kept mirrored by setToken() for safety.
  if (before.length === 0) {
    try {
      localStorage.removeItem(SERVER_KEY);
    } catch {
      /* ignore */
    }
  }
}
migrate();

// ---- Registry accessors (#7) ---------------------------------------------------------------------

/** All saved instances, sorted by their list position. */
export function instances(): Instance[] {
  return readInstances().slice().sort((a, b) => a.order - b.order);
}

/** The currently-active instance (what `config`/`api` resolve to at boot), or null. */
export function activeInstance(): Instance | null {
  const id = readActiveId();
  const list = readInstances();
  return list.find((i) => i.id === id) || list[0] || null;
}

export function activeInstanceId(): string | null {
  return activeInstance()?.id ?? null;
}

/** Mark an instance active. Caller restarts the app so all config re-resolves from it. */
export function setActiveInstance(id: string): void {
  if (readInstances().some((i) => i.id === id)) writeActiveId(id);
}

export function updateInstance(id: string, patch: Partial<Instance>): void {
  const list = readInstances();
  const idx = list.findIndex((i) => i.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...patch };
  writeInstances(list);
}

/** Patch the active instance's record (used by setToken / post-login profile cache). */
export function updateActiveInstance(patch: Partial<Instance>): void {
  const id = activeInstanceId();
  if (id) updateInstance(id, patch);
}

/**
 * Запомнить, супер-админ ли аккаунт активной записи (`Instance.superAdmin`, 23.09). Гостевые записи не
 * трогаем: там живой профиль — учётка у соседа, и её «нет прав» затёрло бы домашний снимок. Пишем только
 * при изменении — зовётся на каждой загрузке профиля.
 */
export function noteActiveSuperAdmin(superAdmin: boolean): void {
  const cur = activeInstance();
  if (!cur || cur.guestOf || !!cur.superAdmin === superAdmin) return;
  updateInstance(cur.id, { superAdmin });
}

/** Add a new (token-less) instance from a discovered ServerConfig. Optionally make it active. */
export function addInstance(cfg: ServerConfig, opts?: { name?: string; activate?: boolean }): Instance {
  const list = readInstances();
  const order = list.length ? Math.max(...list.map((i) => i.order)) + 1 : 0;
  const inst = instanceFrom(cfg, null, order, makeId());
  if (opts?.name) inst.name = opts.name;
  writeInstances([...list, inst]);
  if (opts?.activate) writeActiveId(inst.id);
  return inst;
}

/**
 * Forget an instance (drops its token too). If it was active, activate the first remaining one.
 *
 * 🔴 Дом уходит — с ним и его гостевые записи (аудит 19.09, F-23): иначе они оставались в реестре с
 * живыми токенами, и фоновые шлюзы продолжали к ним подключаться от имени аккаунта, которого у
 * человека здесь больше нет. Хостам при этом сообщаем «завершить сессию» — как при выходе.
 */
export function removeInstance(id: string): void {
  const all = readInstances();
  endGuestSessions(all.filter((i) => i.guestOf === id));
  const list = all.filter((i) => i.id !== id && i.guestOf !== id);
  writeInstances(list);
  const active = readActiveId();
  if (active === null || !list.some((i) => i.id === active)) writeActiveId(list[0]?.id ?? null);
}

/**
 * Попросить хосты завершить гостевые сессии — ДО того, как токены будут стёрты (F-23).
 *
 * «Выйти» раньше забывало токены только в браузере: на хостах они жили до своего срока, и угнанный
 * токен переживал нажатие. `POST /fed/guest-session/end` поднимает поколение теневой строки — то же,
 * что «выйти везде» дома. Без ожидания и с `keepalive`: за выходом следует перезагрузка, и запрос
 * обязан её пережить; хост лежит — выход всё равно происходит, его сессия умрёт по сроку.
 */
function endGuestSessions(guests: Instance[]): void {
  for (const inst of guests) {
    if (!inst.token || !inst.apiUrl) continue;
    try {
      void fetch(`${inst.apiUrl}/api/fed/guest-session/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${inst.token}` },
        keepalive: true,
      }).catch(() => {
        /* хост недоступен — сессия умрёт по сроку */
      });
    } catch {
      /* fetch недоступен (тесты без окна) — не повод ломать выход */
    }
  }
}

/**
 * Запомнить, какие серверы у этой записи (§5.7).
 *
 * 🔴 Ради рейла: он обязан показывать серверы ВСЕХ инстансов всегда, а живой шлюз у нас пока один.
 *
 * ⚠️ Зовётся ТОЛЬКО с удачного ответа списка серверов, поэтому пустой список здесь значит «серверов
 * правда не осталось», а не «сеть не ответила», — и тогда снимок честно очищается. Сорванный запрос
 * сюда не доходит вовсе: он бросает исключение выше.
 * ⚠️ Пишем, только если список ИЗМЕНИЛСЯ: `loadServers()` зовётся часто (после каждого вступления и
 * выхода), а каждая запись в реестр — это `JSON.stringify` всего реестра в `localStorage`.
 */
export function rememberInstanceServers(id: string, servers: InstanceServer[]): void {
  const cur = readInstances().find((i) => i.id === id);
  if (!cur) return;
  const next = servers.map((s) => ({ id: s.id, name: s.name, iconUrl: s.iconUrl ?? null }));
  if (JSON.stringify(cur.servers ?? []) === JSON.stringify(next)) return;
  updateInstance(id, { servers: next });
}

/**
 * Выйти из аккаунта ЦЕЛИКОМ: у дома и у всех его гостевых записей (#139, §5.7).
 *
 * 🔴 **Повод — «пришлось нажать „Выйти“ дважды»** (найдено владельцем 19.09). Гостевая сессия принадлежит
 * дому: токен хосту выдан под его поручительство. Но «Выйти» стирал токен только АКТИВНОЙ записи, и
 * если человек стоял в гостях, после перезагрузки его возвращало домой — где он по-прежнему вошедший.
 * Со стороны это выглядит как «кнопка не сработала»: человек жал второй раз, и только тогда выходил.
 *
 * ⚠️ Семья — это дом и ЕГО гости, а не весь реестр: у человека может быть несколько своих аккаунтов
 * на разных инстансах, и выход из одного не должен выбрасывать из остальных.
 */
export function logoutFamily(id: string | null): void {
  const list = readInstances();
  const me = list.find((i) => i.id === id);
  if (!me) return;
  const homeId = me.guestOf ?? me.id;
  const family = new Set([homeId, ...list.filter((i) => i.guestOf === homeId).map((i) => i.id)]);
  // Хостам — «завершить сессию», пока токены ещё на руках (F-23), и только потом стираем.
  endGuestSessions(list.filter((i) => i.guestOf === homeId));
  writeInstances(list.map((i) => (family.has(i.id) ? { ...i, token: null } : i)));
}

export function renameInstance(id: string, name: string): void {
  const trimmed = name.trim();
  const fallback = serverHost(readInstances().find((i) => i.id === id)?.apiUrl || '');
  updateInstance(id, { name: trimmed || fallback });
}

/**
 * True for a generic "picker" build — nothing baked in and nothing injected. Only these builds show
 * the legacy "change server" affordance (embedded builds have a fixed home instance). Multi-instance
 * switching is offered on ANY native build — desktop AND mobile (see multiInstanceEnabled()).
 */
export function isPickerBuild(): boolean {
  return !injected.apiUrl && !import.meta.env.VITE_API_URL;
}

/**
 * Gate for the multi-instance switcher UI (#7). Enabled on any NATIVE shell — desktop AND mobile
 * (the Android app must be able to pick/switch servers too, not just connect to a single one). A
 * browser can opt in via `localStorage.gv_mi_debug='1'` to iterate/screenshot it in the web preview
 * (harmless: no real user sets it, and switching falls back to a page reload on web).
 */
export function multiInstanceEnabled(): boolean {
  if (isTauri()) return true; // native shell — desktop OR mobile (was desktop-only)
  try {
    return localStorage.getItem('gv_mi_debug') === '1';
  } catch {
    return false;
  }
}

// ---- Active config: живое, а не замороженное на загрузке (§5.7) ---------------------------------

/**
 * 🔴 **Раньше это был замороженный объект**, посчитанный один раз при загрузке модуля: смена
 * инстанса обязана была перезапускать приложение, иначе `config.apiUrl` продолжал указывать на
 * прежний. Переход между инстансами перестал быть перезапуском (`instanceSwitch.ts`), поэтому
 * поля стали геттерами и всегда отвечают по АКТИВНОЙ записи реестра.
 *
 * ⚠️ Значения кешируются до первой записи в реестр: `config.apiUrl` читается на каждом запросе, а
 * `activeInstance()` каждый раз разбирает JSON из хранилища. Сброс кеша — в `writeInstances` и
 * `writeActiveId`, то есть в ЕДИНСТВЕННЫХ местах, где реестр меняется.
 * ⚠️ Из-за геттеров нельзя разворачивать конфиг в переменные на загрузке модуля
 * (`const { apiUrl } = config`) — это снова заморозит его. Обращаться полем в момент нужды.
 */
interface ResolvedConfig {
  apiUrl: string;
  presenceWs: string;
  pushGateway: string;
  ntfyServer: string;
  diagEnabled: boolean;
  economyEnabled: boolean;
}

function resolveConfig(): ResolvedConfig {
  const boot = activeInstance();
  return {
    apiUrl: boot?.apiUrl || injected.apiUrl || import.meta.env.VITE_API_URL || 'http://localhost:4000',
    presenceWs: boot?.presenceWs || injected.presenceWs || import.meta.env.VITE_PRESENCE_WS || 'ws://localhost:4001',
    pushGateway: boot?.pushGateway || injected.pushGateway || import.meta.env.VITE_PUSH_GATEWAY || '',
    ntfyServer: boot?.ntfyServer || injected.ntfyServer || import.meta.env.VITE_NTFY_SERVER || '',
    // ⚠️ Строго `=== true`: у инстанса, который про диагностику ничего не знает, поле отсутствует, и
    // это должно читаться как «выключено», а не как «неизвестно, попробуем».
    diagEnabled: (boot?.diagEnabled ?? injected.diagEnabled) === true,
    economyEnabled: (boot?.economyEnabled ?? injected.economyEnabled) === true,
  };
}

function current(): ResolvedConfig {
  return (resolvedCache ??= resolveConfig());
}

export const config: ResolvedConfig = {
  get apiUrl() {
    return current().apiUrl;
  },
  get presenceWs() {
    return current().presenceWs;
  },
  get pushGateway() {
    return current().pushGateway;
  },
  get ntfyServer() {
    return current().ntfyServer;
  },
  get diagEnabled() {
    return current().diagEnabled;
  },
  get economyEnabled() {
    return current().economyEnabled;
  },
};

/**
 * True when this build must ask the user which server to connect to: a native (desktop/mobile) shell
 * with NO instance chosen and nothing baked in. The web build is never in picker mode; a desktop build
 * that bakes VITE_API_URL (or has a migrated instance) skips it too.
 */
export function needsServerPick(): boolean {
  return isTauri() && !activeInstance()?.apiUrl && !injected.apiUrl && !import.meta.env.VITE_API_URL;
}

/** The active instance as a plain ServerConfig (for the settings "change server" row), or null. */
export function currentServer(): ServerConfig | null {
  const a = activeInstance();
  return a
    ? {
        apiUrl: a.apiUrl,
        presenceWs: a.presenceWs,
        pushGateway: a.pushGateway,
        ntfyServer: a.ntfyServer,
        diagEnabled: a.diagEnabled,
        economyEnabled: a.economyEnabled,
      }
    : null;
}

/**
 * Fetch <base>/config.json — the instance discovery doc — and return its server config. Throws on any
 * failure (unreachable / not a GusVoice instance / no apiUrl) so the picker can show "check the address".
 */
export async function fetchDiscovery(rawInput: string): Promise<ServerConfig> {
  const base = normalizeServerInput(rawInput);
  if (!base) throw new Error('empty server address');
  const res = await fetch(`${base}/config.json`, { headers: { accept: 'application/json' }, mode: 'cors' });
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
  const d = (await res.json()) as Partial<ServerConfig>;
  if (!d || typeof d.apiUrl !== 'string' || !d.apiUrl) throw new Error('not a GusVoice instance (no apiUrl)');
  return {
    apiUrl: stripSlash(d.apiUrl),
    presenceWs: stripSlash(d.presenceWs),
    pushGateway: stripSlash(d.pushGateway),
    ntfyServer: stripSlash(d.ntfyServer),
    diagEnabled: d.diagEnabled === true,
    economyEnabled: d.economyEnabled === true,
  };
}

/** Legacy first-run picker path: seed instance #1 from the chosen server and make it active. */
export function saveServer(cfg: ServerConfig): void {
  addInstance(cfg, { activate: true });
}

/** Legacy "change server": forget the active instance (→ picker or next instance on reload). */
export function clearServer(): void {
  const id = activeInstanceId();
  if (id) removeInstance(id);
}

/**
 * Restart the app so all config/token re-resolve from the (now) active instance. On the desktop this
 * is a real process relaunch (tauri-plugin-process); in a browser it's a page reload — both re-run the
 * frozen `config` above from the active instance. Used by the instance switcher (#7).
 */
export async function restartApp(): Promise<void> {
  if (isTauri()) {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
      return;
    } catch (e) {
      console.warn('[instances] relaunch failed, reloading webview:', e);
    }
  }
  location.reload();
}

/** Derive the gateway ws:// URL from the REST base URL. */
export function gatewayWsUrl(): string {
  const u = new URL(config.apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/gateway';
  u.search = '';
  return u.toString();
}

/**
 * Base URL for the DeepFilterNet3 noise-filter assets (wasm + onnx model), which the client
 * nginx serves same-origin under /noise/ (baked into the image — no external CDN at runtime).
 * The web client is same-origin, so we use its own origin. The desktop app runs from tauri://,
 * which can't serve them, so we derive the prod web origin from the API URL (api.X -> X).
 */
export function noiseAssetBase(): string {
  const origin = window.location.origin;
  if (origin.startsWith('http')) return `${origin}/noise/deepfilternet3`;
  try {
    const u = new URL(config.apiUrl);
    const host = u.host.replace(/^api\./, '');
    return `${u.protocol}//${host}/noise/deepfilternet3`;
  } catch {
    return '/noise/deepfilternet3';
  }
}
