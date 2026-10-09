import { api, deviceTimeZone, getToken } from './api';
import { activeInstanceId, config, instances } from './config';
import { switchInstance } from './instanceSwitch';
import { setPendingOpen } from './pendingOpen';
import { parsePushKeys } from './pushKeys';
import { isAndroid } from './hotkeys';
import { subscribeToServer } from './sockets';
import { useCall } from './callStore';
import { useStore } from './store';
import { offerInviteLink } from './deepLinkInvite';

/**
 * UnifiedPush registration bridge (Android). The native shell (MainActivity `GusVoiceNative`) drives
 * the ntfy distributor; here we kick registration off, read back the endpoint it assigns, and register
 * that endpoint with the GusVoice backend (with the user's auth token) so pushes for DMs / @mentions
 * wake this device even when the app process is dead. No-op on web/desktop and on older APKs that lack
 * the push bridge methods. See UnifiedPushReceiver.kt + backend push.ts.
 */
interface GusVoicePushBridge {
  registerForPush(): void;
  getPushEndpoint(): string;
  hasPushDistributor(): boolean;
  unregisterPush(): void;
  /** #118: returns "dm:<id>" / "ch:<serverId>:<channelId>" from a notification tap, then clears it. */
  consumePendingDeepLink?(): string;
  /**
   * Embedded distributor (multi-instance builds): start our OWN foreground socket to the instance's
   * ntfy (address from /config.json discovery) and return the endpoint URL to register with the
   * backend. No separate ntfy app needed. Absent on older APKs → we fall back to the external path.
   */
  enableEmbeddedPush?(ntfyBase: string): string;
  disableEmbeddedPush?(): void;
  embeddedPushEndpoint?(): string;
  /**
   * Ключи шифрования пуша этого устройства (#213): JSON `{"p256dh":"…","auth":"…"}` (base64url). Закрытый
   * ключ не покидает телефон. Нет метода (старый APK) — регистрируемся без ключей, пуш придёт без текста.
   */
  pushKeys?(): string;
  /**
   * Уведомления как у Telegram (Р1, G17): что умеет приложение — JSON-массив признаков (`["read1","reply1"]`), уходит в
   * `/api/push/register` как `caps`. Нет метода (старый APK) — признаков нет, сервер шлёт как раньше.
   */
  notifCaps?(): string;
  /**
   * Чем отвечать из шторки (Р1, G17): JSON `[{apiUrl, token, userId, active}]` по всем инстансам со входом. Нативка
   * выбирает запись по `uid` из пуша и шлёт «Ответить» / «Прочитано» сама, без открытия приложения. Пустой список —
   * выход: стереть.
   */
  setNotifAuth?(json: string): void;
}

function bridge(): GusVoicePushBridge | null {
  if (!isAndroid()) return null;
  const b = (window as unknown as { GusVoiceNative?: Partial<GusVoicePushBridge> }).GusVoiceNative;
  // The same object carries the #89 voice methods; guard on a push method so an older installed APK
  // (voice-bridge only) is treated as "no push".
  return b && typeof b.registerForPush === 'function' ? (b as GusVoicePushBridge) : null;
}

/** Признаки приложения из моста (`notifCaps`); сбой или старый APK — `undefined` (регистрация без признаков). */
function notifCaps(b: GusVoicePushBridge): string[] | undefined {
  if (typeof b.notifCaps !== 'function') return undefined;
  try {
    const v: unknown = JSON.parse(b.notifCaps());
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').slice(0, 10) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Передать нативке, чем отвечать из шторки (Р1, G17): адрес и токен каждого инстанса со входом. Токен и так лежит в
 * хранилище этого же приложения (localStorage WebView); нативка держит копию в своих личных настройках. Зовётся при
 * старте, входе, возврате в приложение и выходе. Нет метода (старый APK) — ничего.
 */
export function syncNotifAuth(): void {
  const b = bridge();
  if (!b || typeof b.setNotifAuth !== 'function') return;
  const active = activeInstanceId();
  const list = instances()
    .filter((i) => i.token && i.apiUrl)
    .map((i) => ({ apiUrl: i.apiUrl, token: i.token, userId: i.userId ?? '', active: i.id === active }));
  try {
    b.setNotifAuth(JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** Ключи шифрования из моста; любой сбой — `null` (регистрация без ключей лучше, чем никакой). Разбор — `pushKeys.ts`. */
function pushKeys(b: GusVoicePushBridge): { p256dh: string; auth: string } | null {
  if (typeof b.pushKeys !== 'function') return null;
  try {
    return parsePushKeys(b.pushKeys()); // сам вызов моста тоже может бросить
  } catch {
    return null;
  }
}

const DEVICE_KEY = 'gv_push_device_id';
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `and-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

let inFlight = false;
let registered = false;

/**
 * Kick off registration and, once the distributor hands back an endpoint (async round-trip), register
 * it with the backend. Idempotent: guarded so rapid calls don't stack, and the backend upserts per
 * (user, device). Requires an auth token — safe to call before login (no-ops until one exists).
 */
export function startPushRegistration(): void {
  const b = bridge();
  if (b && getToken()) syncNotifAuth();
  if (!b || registered || inFlight || !getToken()) return;

  // Preferred: EMBEDDED distributor (no second app). Needs the instance's ntfy address from discovery
  // (config.pushGateway). enableEmbeddedPush starts our foreground socket and returns the endpoint
  // synchronously — no polling needed. Absent on older APKs → fall through to the external path below.
  if (typeof b.enableEmbeddedPush === 'function' && config.pushGateway) {
    inFlight = true;
    let endpoint = '';
    try {
      endpoint = b.enableEmbeddedPush(config.pushGateway);
    } catch (e) {
      console.warn('[push] enableEmbeddedPush failed', e);
    }
    inFlight = false;
    if (endpoint && getToken()) {
      registered = true;
      void api.registerPush(endpoint, deviceId(), pushKeys(b), notifCaps(b), deviceTimeZone()).catch((e) => {
        registered = false; // let a later foreground/boot retry
        console.warn('[push] backend register failed', e);
      });
    }
    return;
  }

  // Fallback: EXTERNAL UnifiedPush distributor (a separate ntfy app).
  inFlight = true;
  try {
    b.registerForPush();
  } catch (e) {
    console.warn('[push] registerForPush failed', e);
  }
  // The endpoint arrives asynchronously (distributor round-trip); poll the native prefs a few times.
  let tries = 0;
  const iv = window.setInterval(() => {
    tries += 1;
    let endpoint = '';
    try {
      endpoint = b.getPushEndpoint();
    } catch {
      /* ignore */
    }
    if (endpoint && getToken()) {
      window.clearInterval(iv);
      inFlight = false;
      registered = true;
      void api.registerPush(endpoint, deviceId(), pushKeys(b), notifCaps(b), deviceTimeZone()).catch((e) => {
        registered = false; // let a later foreground/boot retry
        console.warn('[push] backend register failed', e);
      });
    } else if (tries >= 20) {
      window.clearInterval(iv); // give up until next foreground/boot — the endpoint is stable once set
      inFlight = false;
    }
  }, 1000);
}

/** Unregister this device from push (on logout) so a previous account stops waking this phone. */
export function stopPushRegistration(): void {
  registered = false;
  inFlight = false;
  const b = bridge();
  if (!b) return;
  // Tell the backend first (we still hold the token), then drop the distributor registration.
  void api.unregisterPush(deviceId()).catch(() => {});
  // Ответ из шторки (Р1) — без токена вышедшего инстанса: запись активного выпадает, остальные остаются.
  try {
    const active = activeInstanceId();
    b.setNotifAuth?.(
      JSON.stringify(
        instances()
          .filter((i) => i.token && i.apiUrl && i.id !== active)
          .map((i) => ({ apiUrl: i.apiUrl, token: i.token, userId: i.userId ?? '', active: false })),
      ),
    );
  } catch {
    /* ignore */
  }
  try {
    b.unregisterPush();
  } catch {
    /* ignore */
  }
  // Embedded distributor (multi-instance builds): stop our foreground socket too.
  try {
    b.disableEmbeddedPush?.();
  } catch {
    /* ignore */
  }
}

/** True if a UnifiedPush distributor (the ntfy app) is installed — used by the settings guide (P4). */
export function hasPushDistributor(): boolean {
  try {
    return bridge()?.hasPushDistributor() ?? false;
  } catch {
    return false;
  }
}

let navigating = false;

/**
 * Navigate to a deep-link target from a notification tap: "dm:<id>", "ch:<serverId>:<channelId>" или
 * "fed:<instanceId>:<serverId>:<channelId>".
 *
 * 🔴 Последний вид — событие на ЧУЖОМ инстансе (#139, F5, требование 33): пуш приехал через дом,
 * потому что телефон зарегистрирован у него, а открывать надо то место, где написали. Ищем запись
 * реестра по `federationInstanceId` и переходим туда обычным путём — тем же, что и клик по серверу
 * соседа в рейле.
 */
async function navigateDeepLink(link: string): Promise<void> {
  const s = useStore.getState();
  if (link.startsWith('invite:')) {
    // Ссылка-приглашение (#139, F4): открываем ОКНО ПРОВЕРКИ, а не вступаем. Решение о входе
    // принимает человек, увидев карточку сервера, — ссылка из мессенджера этого права не даёт.
    offerInviteLink(link.slice('invite:'.length));
    return;
  }
  if (link.startsWith('call:')) {
    /*
     * «Ответить» входящего звонка из уведомления / полноэкранного экрана Android (G73, `CallNotifier.kt`): открыть беседу и
     * принять звонок обычным путём (`callStore.answer`). Звонок берём у сервера (`resync`) — сокет шлюза после холодного
     * старта мог ещё не прислать `call.state`; уже не звонит (отменили, ответили на ПК) — остаёмся в беседе.
     */
    const [callId, dmId] = link.slice(5).split(':');
    if (!callId || !dmId) return;
    await s.loadDms();
    await s.selectDm(dmId);
    const call = useCall.getState();
    if (call.call?.id !== callId) await call.resync();
    const now = useCall.getState().call;
    if (now?.id === callId && now.phase === 'ringing') await useCall.getState().answer();
    return;
  }
  if (link.startsWith('dm:')) {
    const dmId = link.slice(3);
    if (!dmId) return;
    // MainLayout renders the DM from the `dms` list — make sure the conversation is present first.
    await s.loadDms();
    await s.selectDm(dmId);
  } else if (link.startsWith('fed:')) {
    const [instanceId, serverId, channelId] = link.slice(4).split(':');
    if (!instanceId || !channelId) return;
    const entry = instances().find((i) => i.federationInstanceId === instanceId);
    /**
     * ⚠️ Записи нет — человек убрал инстанс из реестра или зашёл с другого устройства. Молчим: вести
     * его на экран входа чужого инстанса, где ему нечего ввести, хуже, чем не сделать ничего.
     */
    if (!entry) return;
    if (entry.id === activeInstanceId()) {
      if (serverId && s.currentServerId !== serverId) {
        await s.openServer(serverId);
        subscribeToServer(serverId);
      }
      s.setView('server');
      await s.openChannel(channelId);
      return;
    }
    // Намерение «открыть именно этот канал» переживает переход: его подхватит загрузка нового инстанса.
    setPendingOpen({ instanceId: entry.id, serverId: serverId || '', channelId });
    await switchInstance(entry.id);
  } else if (link.startsWith('ch:')) {
    const rest = link.slice(3);
    const sep = rest.indexOf(':');
    const serverId = sep >= 0 ? rest.slice(0, sep) : '';
    const channelId = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (!channelId) return;
    if (serverId && s.currentServerId !== serverId) {
      await s.openServer(serverId);
      subscribeToServer(serverId);
    }
    s.setView('server');
    await s.openChannel(channelId);
  }
}

/**
 * Consume a pending deep-link from a notification tap (if any) and navigate to it. Called on boot
 * (once authed) and on every foreground. No-op on web/desktop, when signed out, or when there's
 * nothing pending. Errors (e.g. a stale/inaccessible target) are swallowed — a failed jump must never
 * break resume.
 *
 * `true` — забрали ссылку, которая ВЕДЁТ куда-то (беседа, канал, сосед): тогда запуск не открывает «последнее место»
 * поверх неё. Приглашение только показывает окно проверки и никуда не ведёт — для него `false`, иначе после закрытия
 * окна человек остался бы на пустом экране.
 */
export function consumeDeepLink(): boolean {
  const b = bridge();
  if (!b || navigating || !getToken() || typeof b.consumePendingDeepLink !== 'function') return false;
  let link = '';
  try {
    link = b.consumePendingDeepLink();
  } catch {
    /* older APK without the method */
  }
  if (!link) return false;
  navigating = true;
  void navigateDeepLink(link)
    .catch((e) => console.warn('[push] deep-link navigation failed', e))
    .finally(() => {
      navigating = false;
    });
  return !link.startsWith('invite:');
}

/** Run registration at boot (if already logged in) and whenever the app returns to the foreground. */
export function initPushRegistration(): void {
  if (!isAndroid()) return;
  startPushRegistration();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startPushRegistration();
      // A notification tap that resumed us (singleTask → onNewIntent) leaves a pending deep-link.
      consumeDeepLink();
    }
  });
}
