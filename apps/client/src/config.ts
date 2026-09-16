import {
  hostOf,
  instanceFrom,
  migrateRegistry,
  normalizeServerInput,
  serverHost,
  stripSlash,
  type Instance,
  type RuntimeConfig,
  type ServerConfig,
} from './configRules';
import { isTauri } from './hotkeys';

// Чистые правила (нормализация адреса, переход реестра) — в `configRules.ts`, там же и типы.
// Реэкспорт, чтобы компоненты продолжали импортировать их из `./config`.
export type { Instance, ServerConfig } from './configRules';
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

/** Forget an instance (drops its token too). If it was active, activate the first remaining one. */
export function removeInstance(id: string): void {
  const list = readInstances().filter((i) => i.id !== id);
  writeInstances(list);
  if (readActiveId() === id) writeActiveId(list[0]?.id ?? null);
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

// ---- Frozen active config (re-resolved on each module load = each app restart) -------------------

const boot = activeInstance();

export const config = {
  apiUrl: boot?.apiUrl || injected.apiUrl || import.meta.env.VITE_API_URL || 'http://localhost:4000',
  presenceWs: boot?.presenceWs || injected.presenceWs || import.meta.env.VITE_PRESENCE_WS || 'ws://localhost:4001',
  pushGateway: boot?.pushGateway || injected.pushGateway || import.meta.env.VITE_PUSH_GATEWAY || '',
  ntfyServer: boot?.ntfyServer || injected.ntfyServer || import.meta.env.VITE_NTFY_SERVER || '',
  // ⚠️ Строго `=== true`: у инстанса, который про диагностику ничего не знает, поле отсутствует, и
  // это должно читаться как «выключено», а не как «неизвестно, попробуем».
  diagEnabled: (boot?.diagEnabled ?? injected.diagEnabled) === true,
  economyEnabled: (boot?.economyEnabled ?? injected.economyEnabled) === true,
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
