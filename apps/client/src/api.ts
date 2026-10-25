import type {
  EconomyPreview,
  EconomySettingsDto,
  EconomySummary,
  EconomyView,
  Leaderboard,
  LedgerEntry,
  RetroPreview,
  ShopEntry,
  UserEconomyCard,
} from './economy';
import type {
  CreateGroupRequest,
  ConvReadAt,
  ConvReaders,
  LastSeenPrivacy,
  MessagePrivacy,
  NotifyView,
  LastSeenExceptions,
  UserLastSeen,
  StickerCatalog,
  StickerCatalogPack,
  StickerLists,
  SavedGif,
  SavedGifsResponse,
  ExternalGifsResponse,
  AdminServer,
  AdminUser,
  FederationAlertSettings,
  FederationAuditRow,
  FederationBanRow,
  FederationDirectoryView,
  FederationReportRow,
  DmReportReason,
  DmReportRow,
  Attachment,
  AuditLogEntry,
  AuthResponse,
  BackupCodesResponse,
  BanInfo,
  Webhook,
  WebhookWithToken,
  AdminInstanceSettings,
  InstanceUpdateInfo,
  Channel,
  Category,
  ConvDeleteManyRequest,
  ConvAlbumItemDeleteResponse,
  ConvDraftRequest,
  ConvForwardRequest,
  ConvForwardResponse,
  ConvHistoryResponse,
  ConvSearchResponse,
  ConvSearchAllResponse,
  ConvFrequentResponse,
  ConvFrequentHideRequest,
  ConvFrequentHideResponse,
  ServerSearchResponse,
  ConvUnreadReactionsResponse,
  ConvListResponse,
  ConvMessage,
  ConvPinRequest,
  ConvPinsResponse,
  ConvPinOrderResponse,
  ConvScheduledEditRequest,
  ConvScheduledResponse,
  ConvScheduledSendResponse,
  ConvScheduleRequest,
  ConvSummary,
  ConvSyncResponse,
  DmChannel,
  DmPolicy,
  FederationOverview,
  FederationSwitchPatch,
  FederationSwitchView,
  GameActivity,
  InstanceInfo,
  GuestPlacesView,
  InvitePreviewView,
  InviteScopeView,
  Invite,
  Message,
  PermissionOverwrite,
  Poll,
  PollVoters,
  PresenceStatus,
  RegisterResponse,
  RegistrationPolicy,
  Role,
  Server,
  ServerBootstrap,
  ServerEmoji,
  ServerMemberInfo,
  SetupStatus,
  SmtpSettings,
  TotpRequiredResponse,
  TotpSetupResponse,
  User,
  UserSearchResponse,
  VoiceTestToken,
  VoiceTokenResponse,
  DmFolderInput,
  DmFolderList,
  DmFolderPinOrderRequest,
  DmFolderPinOwnRequest,
  DmFolderPinRequest,
  ContactList,
  SharedMediaCounts,
  SharedMediaKind,
  SharedMediaResponse,
  CallActiveResponse,
  CallJoinResponse,
} from '@gusvoice/shared';
import { mirrorToBg } from './bgGateways';
import { activeInstance, activeInstanceId, config, instances, updateActiveInstance, updateInstance } from './config';
import { measureMediaFile } from './imageSize';
import type { ChunkDeps, ChunkOpts } from './chunkedUpload';
import type { UploadOpts } from './uploadProgress';

/** Отмена загрузки самим человеком — как `uploadProgress.uploadAborted` (значение не импортируем: харнесс тестов). */
/** IANA-пояс этого устройства (`Intl`); не определился — `null`. Уходит в `/push/register`: повтор уведомления — только днём. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function uploadAborted(): Error & { aborted: true } {
  return Object.assign(new Error('загрузка отменена'), { name: 'AbortError', aborted: true as const });
}

/** A push-mute source: 'server' suppresses a server's @mention pushes; 'dm_user' a person's DM pushes. */
/** Ответ отправки GIF в беседу (`gifs1`): незавершённое вложение и его размеры для подсказок `convSend`. */
export interface GifAttachResponse {
  attachmentId: string;
  contentType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export type PushMuteScope = 'server' | 'dm_user';
export interface PushMute {
  scope: PushMuteScope;
  targetId: string;
  /** До какого времени (07.10, сервер `conv11`); нет поля — навсегда. Истёкших сервер не отдаёт. */
  until?: string;
  /** «Выключить звук» (07.10, сервер `conv13`): уведомление без звука; нет поля — полная заглушка. */
  soundOnly?: true;
}

/**
 * Сэмпл саундборда (#21): кнопка в сетке.
 *
 * ⚠️ `url` публичный — в том же бакете, что и звуки событий. Приватного в сэмпле нет по
 * определению: его слышит весь голосовой канал.
 */
export interface SoundboardClip {
  id: string;
  name: string;
  url: string;
  /**
   * 🔴 Действующая цена В МОНЕТАХ, посчитанная сервером: своя у звука хранится в монетах, общая
   * приезжает из каталога в минутах, и перевод делает сервер. Клиент не должен ни знать ставку, ни
   * уметь переводить: две реализации одного перевода разошлись бы на округлении — человек увидел
   * бы одно, а списалось бы другое.
   */
  priceCoins: number;
  /** Справочно: во сколько минут сидения обходится эта цена сегодня. */
  priceMinutes: number;
  /** `null` — своей цены нет, действует общая. Нужно панели управления, а не пикеру. */
  ownPriceCoins: number | null;
}

/**
 * Токен АКТИВНОГО инстанса (#7): источник правды — реестр. Старый ключ `gv_token` — запасной, и только пока в реестре
 * не больше одной записи (старая установка, веб без реестра). 🔴 При нескольких записях в нём лежит последний токен
 * ЛЮБОГО инстанса: активная запись без токена (новый инстанс до входа, гость с протухшей сессией) отправляла бы чужой
 * токен чужому API и не давала сработать уводу гостя домой (`bounceStrandedGuestHome`) — разведка 30.09, ЛС этап 2.
 */
function initialToken(): string | null {
  const active = activeInstance();
  if (active?.token) return active.token;
  return instances().length <= 1 ? localStorage.getItem('gv_token') : null;
}
let token: string | null = initialToken();

export function getToken(): string | null {
  return token;
}

/**
 * Номер «поколения» активного инстанса (§5.7). Растёт на каждом переходе между инстансами.
 *
 * 🔴 Зачем. Переход перестал быть перезапуском приложения, а запросы к прежнему инстансу в этот
 * момент могут быть в полёте. Их ответы придут уже после перехода — с чужими серверами, чужими
 * людьми и чужими непрочитанными, и запишутся в стор нового инстанса. Один счётчик в ОДНОМ месте
 * (`req`) закрывает это для всего REST разом: проверять эпоху в каждом действии стора значило бы
 * забыть её ровно там, где она нужна.
 */
let epoch = 0;

/** Ошибка «ответ пришёл не тому инстансу» — её глушит `toastError`, человеку показывать нечего. */
export function switchedAway(): Error & { switched: true } {
  return Object.assign(new Error('инстанс сменился'), { switched: true as const });
}

/**
 * Перечитать токен активной записи после перехода между инстансами и объявить новое поколение.
 * ⚠️ Зовётся ПОСЛЕ `setActiveInstance`, иначе перечитается прежний токен.
 */
export function reloadToken(): void {
  token = activeInstance()?.token ?? null;
  epoch++;
}
export function setToken(t: string | null): void {
  token = t;
  // Write into the active instance's record; keep the legacy mirror so any stray reader still works.
  updateActiveInstance({ token: t });
  try {
    if (t) localStorage.setItem('gv_token', t);
    else localStorage.removeItem('gv_token');
  } catch {
    /* storage unavailable */
  }
}

/**
 * Продление сессии: бэкенд кладёт свежий токен в `x-refresh-token`, если старому больше суток.
 * Так «протух» означает «неделю не заходил», а не «неделя с момента входа» — раньше людей,
 * сидящих в приложении каждый день, всё равно выкидывало.
 *
 * Заголовок кросс-доменный, поэтому он читается только благодаря `exposedHeaders` на бэкенде.
 * Если продление вдруг перестанет работать — проверять надо там, а не здесь.
 */
function absorbRefresh(res: Response): void {
  const fresh = res.headers.get('x-refresh-token');
  if (fresh && fresh !== token) setToken(fresh);
}

/** Человек в моём чёрном списке ЛС (#212). */
export interface BlockedUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Курсор порции истории (`historyPage.olderCursor`). */
export interface HistoryCursor {
  /** Время самого старого загруженного — запасной путь для сервера до 28.09. */
  before: string;
  /** Его id — по нему новый сервер берёт точное время и не теряет соседей по миллисекунде. */
  beforeId: string;
}

function historyQuery(cursor?: HistoryCursor): string {
  if (!cursor) return '';
  return `?before=${encodeURIComponent(cursor.before)}&beforeId=${encodeURIComponent(cursor.beforeId)}`;
}

/** Разбор ответа: 204 → `undefined`, ошибка — с HTTP-статусом, машинной причиной и контактами держателя. */
async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Attach the HTTP status so callers can tell a genuine auth failure (401 → log out) from a
    // transient network/5xx blip (e.g. backend mid-deploy → keep the session, retry).
    const err = new Error((data as { error?: string }).error || `HTTP ${res.status}`) as Error & {
      status?: number;
      reason?: string;
      contacts?: { kind: string; label: string; value: string }[];
    };
    err.status = res.status;
    // ⚠️ Машинная причина отказа, если сервер её прислал. Текст предназначен человеку и меняется;
    // ветвиться по нему в коде — значит однажды сломаться от правки формулировки.
    err.reason = (data as { reason?: string }).reason;
    // ⚠️ Контакты держателя приезжают вместе с отказом «сервер закрыт для гостей» (§5.3.1): окно
    // обязано показать, к кому идти, а второй запрос за ними идти уже некуда — нас туда не пускают.
    const contacts = (data as { contacts?: unknown }).contacts;
    if (Array.isArray(contacts)) err.contacts = contacts as { kind: string; label: string; value: string }[];
    // Э7 (#141, `fedm6`): 403 `group_not_invitable { userIds }` — кого из выбранных инстанс не пускает в группы (имена инстансов в тосте).
    const userIds = (data as { userIds?: unknown }).userIds;
    if (Array.isArray(userIds)) (err as Error & { userIds?: string[] }).userIds = userIds.filter((x): x is string => typeof x === 'string');
    throw err;
  }
  return data as T;
}

/**
 * Как запрос доходит до инстанса (01.10, федерация без перехода). Методы `api` описаны ОДИН раз (`makeApi`), а
 * доставка — двумя способами:
 * - **активный инстанс** (`api`): адрес и токен активной записи, поколение (`epoch`) выбрасывает ответы, пришедшие
 *   после перехода, продлённый токен — в активную запись (`setToken`);
 * - **конкретная запись реестра** (`apiFor(id)`): адрес и токен ЭТОЙ записи на каждый вызов, поколения нет (переход
 *   на экране такой запрос не отменяет), продлённый токен — только в неё, 401 никого не разлогинивает. Так админка
 *   дома открывается поверх гостевого экрана, а голос ходит к своему инстансу, пока на экране другой.
 */
/**
 * `keepalive` — запрос переживает выгрузку страницы (черновик при закрытии окна, Р7); тело ≤ 64 КБ. `timeoutMs` — без
 * ответа дольше запрос обрывается отказом без статуса «сервер не ответил» (отправка ЛС, 05.10: зависший запрос держал
 * сообщение «в пути» минутами).
 */
interface ReqOptions {
  keepalive?: boolean;
  timeoutMs?: number;
}

/**
 * Обрыв по `timeoutMs` — отказ без статуса (как сбой сети) с меткой `timeout` и словами для строки «не отправлено».
 */
function fetchWithin(input: string, init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
  if (!timeoutMs || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return fetch(input, init);
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch((e: unknown) => {
    if ((e as { name?: string } | null)?.name === 'TimeoutError') {
      throw Object.assign(new Error('сервер не ответил'), { timeout: true as const });
    }
    throw e;
  });
}

/**
 * Загрузка с прогрессом и отменой (порция «Отправка», 07.10): у `fetch` нет событий отправки тела, поэтому — XHR
 * (`upload.onprogress`, `abort`). Ответ — тот же `Response`, что дал бы `fetch`: дальше разбор общий. Сбой сети —
 * `TypeError`, как у `fetch` (очередь ЛС считает его «нет связи»); отмена — `uploadAborted()`. Заголовок
 * `Authorization` и так делает запрос «непростым», так что подписка на `upload` лишнего предзапроса CORS не добавляет;
 * `x-refresh-token` читается так же, как у `fetch` (`exposedHeaders` бэкенда).
 */
function xhrUpload(url: string, headers: Record<string, string>, body: FormData | Blob, opts: UploadOpts, method = 'POST'): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(uploadAborted());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    const onProgress = opts.onProgress;
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    const stop = () => xhr.abort();
    opts.signal?.addEventListener('abort', stop, { once: true });
    const settle = () => opts.signal?.removeEventListener('abort', stop);
    xhr.onload = () => {
      settle();
      const headersOut = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const at = line.indexOf(':');
        if (at > 0) headersOut.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      const empty = xhr.status === 204 || xhr.status === 205 || xhr.status === 304;
      try {
        resolve(new Response(empty ? null : xhr.responseText, { status: xhr.status, headers: headersOut }));
      } catch {
        reject(new TypeError('Failed to fetch'));
      }
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Failed to fetch'));
    };
    xhr.onabort = () => {
      settle();
      reject(uploadAborted());
    };
    xhr.send(body);
  });
}

/** Ответ `GET /conv/:id/fallback` (Э5): куда и с чем писать, пока дом недоступен. `expiresAt` — мс. */
export interface ConvFallbackSession {
  instanceId: string;
  apiBase: string;
  userId: string;
  token: string;
  expiresAt: number;
}

/** Строка отчёта `POST /conv/via-claims` (Э5): что отправлено в обход дома; `payloadHash` — `fedViaRules.viaPayloadHash`. */
export interface ConvViaClaim {
  conversationId: string;
  clientId: string;
  payloadHash: string;
}

interface Transport {
  req<T>(method: string, path: string, body?: unknown, opts?: ReqOptions): Promise<T>;
  /** Адрес API (для ссылок на скачивание). */
  base(): string;
  /**
   * Загрузка файла (`multipart`) — ответ как есть, продление токена уже учтено. `opts` (прогресс, отмена) — XHR, без
   * них — прежний `fetch`.
   */
  upload(path: string, body: FormData, opts?: UploadOpts): Promise<Response>;
  /** Кусок файла (`bigfile1`): `PUT` сырых байт с прогрессом и отменой (`chunkedUpload.ts`). */
  putPart(path: string, body: Blob, opts: UploadOpts): Promise<Response>;
  /** `GET` с входом, ответ как есть (картинка карты `yamap1`: `<img>` заголовок входа не шлёт). Продление токена учтено. */
  raw(path: string, timeoutMs?: number): Promise<Response>;
  /** Отражение статуса/игры в фоновые шлюзы — только у активного. */
  mirror(method: 'PATCH' | 'POST', path: string, body: unknown): void;
}

const activeTransport: Transport = {
  async req<T>(method: string, path: string, body?: unknown, opts?: ReqOptions): Promise<T> {
    const sent = epoch;
    const res = await fetchWithin(
      `${config.apiUrl}/api${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(opts?.keepalive ? { keepalive: true } : {}),
      },
      opts?.timeoutMs,
    );
    // Пока ходили, человек перешёл в другой инстанс — ответ относится к прежнему, и место ему в
    // мусоре, а не в сторе. 401 от покинутого инстанса тем более не должен никого разлогинивать.
    if (sent !== epoch) throw switchedAway();
    absorbRefresh(res);
    // Тело дочитывается позже заголовков — переход мог случиться и в это время (рейл открыт во время перехода, 01.10).
    let out: T;
    try {
      out = await parseResponse<T>(res);
    } catch (e) {
      if (sent !== epoch) throw switchedAway();
      throw e;
    }
    if (sent !== epoch) throw switchedAway();
    return out;
  },
  base: () => config.apiUrl,
  async upload(path: string, body: FormData, opts?: UploadOpts): Promise<Response> {
    const sent = epoch;
    const url = `${config.apiUrl}/api${path}`;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res =
      opts && (opts.onProgress || opts.signal) ? await xhrUpload(url, headers, body, opts) : await fetch(url, { method: 'POST', headers, body });
    // Продлённый токен прежнего инстанса не пишем в новую активную запись (загрузка шла во время перехода).
    if (sent === epoch) absorbRefresh(res);
    return res;
  },
  async putPart(path: string, body: Blob, opts: UploadOpts): Promise<Response> {
    const sent = epoch;
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await xhrUpload(`${config.apiUrl}/api${path}`, headers, body, opts, 'PUT');
    if (sent !== epoch) throw switchedAway();
    absorbRefresh(res);
    return res;
  },
  async raw(path: string, timeoutMs?: number): Promise<Response> {
    const sent = epoch;
    const res = await fetchWithin(`${config.apiUrl}/api${path}`, { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} }, timeoutMs);
    if (sent !== epoch) throw switchedAway();
    absorbRefresh(res);
    return res;
  },
  mirror: (method, path, body) => mirrorToBg(method, path, body),
};

/** Отказ «вход на этой записи кончился» — текст для человека, разлогина нет. */
function sessionGone(localId: string): Error & { status: number; reason: string } {
  const name = instances().find((i) => i.id === localId)?.name || 'этом инстансе';
  return Object.assign(new Error(`Вход на «${name}» истёк — перейдите туда и войдите снова.`), {
    status: 401,
    reason: 'instance.session_expired',
  });
}

function recordTransport(localId: string): Transport {
  const record = () => instances().find((i) => i.id === localId) ?? null;
  const send = async (
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: BodyInit; keepalive?: boolean },
    timeoutMs?: number,
    upload?: UploadOpts,
    putMethod?: 'PUT',
  ): Promise<Response> => {
    const r = record();
    if (!r?.token) throw sessionGone(localId);
    const sent = r.token;
    const headers = { ...init.headers, Authorization: `Bearer ${sent}` };
    // Загрузка с прогрессом или отменой — XHR (`xhrUpload`), остальное — как было.
    const res =
      upload && (upload.onProgress || upload.signal) && (init.body instanceof FormData || init.body instanceof Blob)
        ? await xhrUpload(`${r.apiUrl}/api${path}`, headers, init.body, upload, putMethod ?? 'POST')
        : await fetchWithin(`${r.apiUrl}/api${path}`, { ...init, headers }, timeoutMs);
    // Продление — только в эту запись и только если в ней всё ещё тот токен, с которым ходили: между запросом и
    // ответом человек мог перелогиниться, и старое продление затёрло бы новый вход.
    const fresh = res.headers.get('x-refresh-token');
    const now = record();
    if (fresh && now && now.token === sent && fresh !== sent) {
      if (localId === activeInstanceId()) setToken(fresh);
      else updateInstance(localId, { token: fresh });
    }
    if (res.status === 401) throw sessionGone(localId);
    return res;
  };
  return {
    async req<T>(method: string, path: string, body?: unknown, opts?: ReqOptions): Promise<T> {
      const res = await send(
        path,
        {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          ...(opts?.keepalive ? { keepalive: true } : {}),
        },
        opts?.timeoutMs,
      );
      return parseResponse<T>(res);
    },
    base: () => record()?.apiUrl ?? config.apiUrl,
    upload: (path, body, opts) => send(path, { method: 'POST', body }, undefined, opts),
    putPart: (path, body, opts) =>
      send(path, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } }, undefined, { ...opts, signal: opts.signal ?? new AbortController().signal }, 'PUT'),
    raw: (path, timeoutMs) => send(path, { method: 'GET' }, timeoutMs),
    mirror: () => {},
  };
}

/**
 * Э5: запросы по долгой сессии на инстансе собеседника (`ConvFallbackSession`). Адрес и токен — из сессии на каждый вызов; поколения
 * нет (переход между инстансами такой запрос не отменяет), продление токена и 401 не трогают вход в основной инстанс.
 */
function viaTransport(session: ConvFallbackSession): Transport {
  const url = (path: string) => `${session.apiBase.replace(/\/+$/, '')}/api${path}`;
  const auth = { Authorization: `Bearer ${session.token}` };
  return {
    async req<T>(method: string, path: string, body?: unknown, opts?: ReqOptions): Promise<T> {
      const res = await fetchWithin(
        url(path),
        {
          method,
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...auth },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        opts?.timeoutMs,
      );
      return parseResponse<T>(res);
    },
    base: () => session.apiBase,
    upload: () => Promise.reject(new Error('Дом недоступен — пока только текст')),
    putPart: () => Promise.reject(new Error('Дом недоступен — пока только текст')),
    raw: (path, timeoutMs) => fetchWithin(url(path), { method: 'GET', headers: auth }, timeoutMs),
    mirror: () => {},
  };
}

/**
 * Загрузка вложения беседы (`/conv/:id/attachments`; каналы — `/channels/:id/attachments`).
 * Размер картинки (и с 06.10 видео — с длительностью) меряем параллельно загрузке (#194): лента оставит место до скачивания.
 */
async function uploadVia(t: Transport, path: string, file: File, opts?: UploadOpts): Promise<Attachment> {
  const dims = measureMediaFile(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await t.upload(path, fd, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${res.status}`), { status: res.status });
  const size = await dims;
  return size ? { ...(data as Attachment), ...size } : (data as Attachment);
}

/**
 * Загрузка кусками (`bigfile1`, 09.10): ставит `main.tsx` (`chunkedUpload.uploadInChunks` + `attachRules.dmChunkedUploads`).
 * Через привязку, а не импорт: харнессы тестов грузят `api.ts` с перечнем импортов (как `bindUploadProgress` у `convStore`).
 * Не привязано — всё прежним одним запросом.
 */
let chunked: {
  use: (size: number) => boolean;
  run: (deps: ChunkDeps, convId: string, file: File, opts: ChunkOpts) => Promise<Attachment>;
} | null = null;
export function bindChunkedUpload(c: typeof chunked): void {
  chunked = c;
}

function makeApi(t: Transport) {
  const req = <T>(method: string, path: string, body?: unknown): Promise<T> => t.req<T>(method, path, body);
  /** `opts` — прогресс и отмена загрузки (строка «в пути», 07.10). */
  const uploadTo = (path: string, file: File, opts?: UploadOpts): Promise<Attachment> => uploadVia(t, path, file, opts);
  /**
   * Вложение беседы: файл больше куска при `bigfile1` — кусками (`chunkedUpload.ts` через `bindChunkedUpload`, продолжение
   * после обрыва), иначе — прежним одним запросом. Признак — только у активного инстанса; у записи соседа — прежний путь.
   */
  const convUploadVia = async (convId: string, file: File, opts?: UploadOpts): Promise<Attachment> => {
    if (!(t === activeTransport && chunked?.use(file.size))) return uploadTo(`/conv/${convId}/attachments`, file, opts);
    const dims = measureMediaFile(file);
    const att = await chunked.run({ req: (m, p, b) => t.req(m, p, b), putPart: (p, b, o) => t.putPart(p, b, o) }, convId, file, opts ?? {});
    const size = await dims;
    return size ? { ...att, ...size } : att;
  };
  return {
  register: (username: string, email: string, password: string, displayName?: string, inviteCode?: string) =>
    req<RegisterResponse>('POST', '/auth/register', { username, email, password, displayName, inviteCode }),
  verify: (identifier: string, code: string) => req<AuthResponse>('POST', '/auth/verify', { identifier, code }),
  resend: (identifier: string) => req<{ status: string }>('POST', '/auth/resend', { identifier }),
  login: (username: string, password: string) =>
    req<AuthResponse | TotpRequiredResponse>('POST', '/auth/login', { username, password }),
  // UnifiedPush device registration (Android push — see nativeUnifiedPush.ts). Backend upserts per (user,device).
  // `keys` — ключи шифрования пуша устройства (#213, WebPush): без них бэкенд шлёт пуш без текста.
  /** `caps` (Р1, G17) — что умеет APK (`read1`, `reply1`); старый сервер поле отбросит. `tz` — IANA-пояс устройства (`deviceTimeZone`). */
  registerPush: (endpoint: string, deviceId: string, keys?: { p256dh: string; auth: string } | null, caps?: string[], tz?: string | null) =>
    req<void>('POST', '/push/register', {
      endpoint,
      deviceId,
      platform: 'android',
      ...(keys ? { keys } : {}),
      ...(caps && caps.length > 0 ? { caps } : {}),
      // Пояс устройства (IANA): сервер повторяет уведомление «пока не прочитано» только днём по местному времени (миграция 0128).
      ...(tz ? { tz } : {}),
    }),
  unregisterPush: (deviceId: string) => req<void>('POST', '/push/unregister', { deviceId }),
  // Push-mute rules (account-wide push suppression: a server's @mentions or a person's DMs).
  listPushMutes: () => req<PushMute[]>('GET', '/push/mutes'),
  // Чёрный список ЛС (#212): кого я заблокировал — с профилями; заблокированный об этом не узнаёт.
  listBlocks: () => req<BlockedUser[]>('GET', '/blocks'),
  blockUser: (userId: string) => req<void>('POST', '/blocks', { userId }),
  unblockUser: (userId: string) => req<void>('DELETE', `/blocks/${userId}`),
  /** `seconds` (07.10, сервер `conv11`) — на срок; без него навсегда. Старый сервер поле отбросит — заглушит навсегда. */
  setPushMute: (scope: PushMuteScope, targetId: string, seconds?: number, soundOnly?: boolean) =>
    req<void>('POST', '/push/mute', {
      scope,
      targetId,
      ...(seconds ? { seconds } : {}),
      // «Выключить звук» (07.10, сервер `conv13`): старый сервер поле отбросит — заглушит полностью (тише, не громче).
      ...(soundOnly ? { soundOnly: true } : {}),
    }),
  removePushMute: (scope: PushMuteScope, targetId: string) => req<void>('DELETE', '/push/mute', { scope, targetId }),
  /**
   * Исключения «Уведомления включены» (08.10, решение владельца 38, сервер `push4`): беседа уведомляет при выключенных «Личных» /
   * группах. Цель — как у заглушки `dm_user` (id собеседника или `group:<id беседы>`). Без признака не звать: у старого сервера пути нет.
   */
  listPushAlways: () => req<{ scope: 'dm_user'; targetId: string }[]>('GET', '/push/always'),
  setPushAlways: (targetId: string) => req<void>('POST', '/push/always', { scope: 'dm_user', targetId }),
  removePushAlways: (targetId: string) => req<void>('DELETE', '/push/always', { scope: 'dm_user', targetId }),
  loginTotp: (challenge: string, code: string) =>
    req<AuthResponse>('POST', '/auth/login/totp', { challenge, code }),
  me: () => req<User>('GET', '/auth/me'),
  updateProfile: (body: {
    displayName?: string;
    showGameActivity?: boolean;
    economyWelcomeSeen?: true;
    /** «Время захода» и «Скрывать время прочтения» (С1, `lastseen1`). */
    lastSeenPrivacy?: LastSeenPrivacy;
    hideReadTime?: boolean;
    /** «Кто может звонить» (`presence4`). */
    callPrivacy?: LastSeenPrivacy;
    /** «Кто может мне писать» (`msgpriv1`). */
    messagePrivacy?: MessagePrivacy;
    /** «Показывать имя / текст» и «Уведомления из групп» (G38, `push2`). */
    notifyView?: NotifyView;
    notifyGroups?: boolean;
    /** «Личные сообщения» и «Повторять уведомления» (G38, `push3`). */
    notifyDm?: boolean;
    notifyRepeat?: number;
  }) => req<User>('PATCH', '/users/me', body),
  /** «В сети» / «был(а) …» человека моими глазами (С1, `lastseen1`). */
  userLastSeen: (userId: string) => req<UserLastSeen>('GET', `/users/${encodeURIComponent(userId)}/last-seen`),
  /** Пачка «в сети» / `exact` для точек списка бесед (Р-2, `lastseen2`): до 200 человек. */
  usersLastSeen: (ids: string[]) => req<{ items: UserLastSeen[] }>('POST', '/users/last-seen', { ids }),
  /** Исключения «Времени захода» (G07, `lastseen3`). */
  lastSeenExceptions: () => req<LastSeenExceptions>('GET', '/users/me/last-seen-exceptions'),
  /** «Кто может звонить» (`presence4`): исключения — та же форма, что у «Времени захода». */
  callExceptions: () => req<LastSeenExceptions>('GET', '/users/me/call-exceptions'),
  setCallExceptions: (body: { always: string[]; never: string[] }) => req<LastSeenExceptions>('PUT', '/users/me/call-exceptions', body),
  // «Кто может мне писать» (`msgpriv1`): только «Всегда разрешать».
  messageExceptions: () => req<LastSeenExceptions>('GET', '/users/me/message-exceptions'),
  setMessageExceptions: (always: string[]) => req<LastSeenExceptions>('PUT', '/users/me/message-exceptions', { always, never: [] }),
  setLastSeenExceptions: (body: { always: string[]; never: string[] }) =>
    req<LastSeenExceptions>('PUT', '/users/me/last-seen-exceptions', body),
  /** «Прочитано в 12:34» своего сообщения в беседе 1:1 (С1, `lastseen1`). */
  convReadAt: (convId: string, messageId: string) =>
    req<ConvReadAt>('GET', `/conv/${convId}/messages/${encodeURIComponent(messageId)}/read-at`),
  /** «Кто прочитал» своё сообщение в группе (`readers1`) — строка «N прочитали» в меню. */
  convReaders: (convId: string, messageId: string) =>
    req<ConvReaders>('GET', `/conv/${convId}/messages/${encodeURIComponent(messageId)}/readers`),
  // Steam link (#40 Phase 1B): get the OpenID redirect URL (client navigates to it), or unlink.
  steamLinkUrl: () => req<{ url: string }>('POST', '/users/me/steam/link-url'),
  steamUnlink: () => req<User>('DELETE', '/users/me/steam'),
  setStatus: (body: {
    status?: PresenceStatus;
    /**
     * Смену делает автоматика (авто-«отошёл»), а не человек. ⚠️ Запрос БЕЗ этого поля считается
     * ручным и снимает признак на сервере — так и надо: ручной статус автоматика больше не трогает
     * (#118).
     */
    auto?: boolean;
    customStatus?: { emoji: string | null; text: string | null; clearAfterMinutes: number | null } | null;
  }) => {
    // 🔴 Статус — про человека, а не про инстанс (§5.7): «не беспокоить», поставленное дома, обязано
    // действовать и там, где он гость. Иначе у соседа он остаётся зелёным «в сети» — то есть просьба
    // не стучаться до тех людей, которые её и должны увидеть, не доходит.
    t.mirror('PATCH', '/users/me/status', body);
    return req<User>('PATCH', '/users/me/status', body);
  },
  // Game activity (#40): report what I'm playing (`game: null` clears it); fetch everyone's snapshot.
  setActivity: (game: GameActivity | null) => {
    // «Играет в X» — по той же причине: на чужом сервере в списке участников человек стоит рядом со
    // своими, и пустая строка там означала бы «ничем не занят», а не «мы не знаем».
    t.mirror('PATCH', '/users/me/activity', { game });
    return req<{ ok: true }>('PATCH', '/users/me/activity', { game });
  },
  getActivities: () => req<{ activities: Record<string, GameActivity> }>('GET', '/users/activities'),
  /**
   * Люди своего инстанса по логину (05.10, признак `users1` — `dmRules.serverSearchesUsers`): `q` — уже логин без «@»
   * (`dmRules.userSearchQuery`), ответ — до 8 строк, точное совпадение первым. 400 — не логин, 429 — 30 поисков в минуту.
   */
  searchUsers: (q: string) => req<UserSearchResponse>('GET', `/users/search?q=${encodeURIComponent(q)}`),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true; token: string }>('POST', '/auth/password', { currentPassword, newPassword }),
  // Revokes every other session (token-generation bump); returns a fresh token for THIS device.
  logoutAll: (password: string) => req<{ token: string }>('POST', '/auth/logout-all', { password }),
  forgotPassword: (email: string) => req<{ status: string }>('POST', '/auth/password/forgot', { email }),
  resetPassword: (identifier: string, code: string, newPassword: string) =>
    req<{ status: string }>('POST', '/auth/password/reset', { identifier, code, newPassword }),
  changeEmail: (newEmail: string, password: string) => req<User>('POST', '/auth/email', { newEmail, password }),
  deleteAccount: (password: string) => req<{ ok: true }>('POST', '/auth/delete', { password }),
  twoFactorSetup: () => req<TotpSetupResponse>('POST', '/auth/2fa/setup'),
  twoFactorEnable: (code: string) => req<BackupCodesResponse>('POST', '/auth/2fa/enable', { code }),
  twoFactorDisable: (password: string, code: string) =>
    req<{ user: User }>('POST', '/auth/2fa/disable', { password, code }),
  twoFactorRegenerateBackup: (code: string) =>
    req<BackupCodesResponse>('POST', '/auth/2fa/backup/regenerate', { code }),
  uploadAvatar: async (file: File): Promise<User> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/users/me/avatar`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as User;
  },

  /** Свой ник в пределах сервера (#19). Чужие ники не меняются — только свой. */
  setNickname: (serverId: string, nickname: string | null) =>
    req<{ nickname: string | null }>('PATCH', `/servers/${serverId}/nickname`, { nickname }),

  /** Создать опрос (#17) — это сообщение особого вида, возвращается как обычное. */
  createPoll: (
    channelId: string,
    body: { question: string; options: string[]; multi: boolean; anonymous: boolean; hours: number },
  ) => req<Message>('POST', `/channels/${channelId}/polls`, body),
  /** Проголосовать. Голос один и окончательный — переголосовать нельзя. */
  votePoll: (channelId: string, messageId: string, optionIds: string[]) =>
    req<Poll>('POST', `/channels/${channelId}/messages/${messageId}/poll/vote`, { optionIds }),
  /** Кто за что проголосовал — только публичный опрос и только после своего голоса. */
  pollVoters: (channelId: string, messageId: string) =>
    req<PollVoters[]>('GET', `/channels/${channelId}/messages/${messageId}/poll/voters`),

  listServers: () => req<Server[]>('GET', '/servers'),
  createServer: (name: string) => req<ServerBootstrap>('POST', '/servers', { name }),
  getServer: (id: string) => req<ServerBootstrap>('GET', `/servers/${id}`),
  updateServer: (serverId: string, body: { name?: string; iconUrl?: string | null }) =>
    req<Server>('PATCH', `/servers/${serverId}`, body),
  deleteServer: (serverId: string) => req<void>('DELETE', `/servers/${serverId}`),

  /** Иконка сервера (#74). Убрать — это `updateServer(id, { iconUrl: null })`, отдельного роута нет. */
  uploadServerIcon: async (serverId: string, file: File): Promise<Server> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/servers/${serverId}/icon`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Server;
  },

  uploadServerSound: async (serverId: string, event: string, file: File): Promise<{ event: string; url: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/servers/${serverId}/sounds/${event}`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { event: string; url: string };
  },
  deleteServerSound: (serverId: string, event: string) =>
    req<void>('DELETE', `/servers/${serverId}/sounds/${event}`),

  /** Кастомные эмодзи сервера (#18). Имя — в query, чтобы не зависеть от порядка частей multipart. */
  uploadServerEmoji: async (serverId: string, name: string, file: File): Promise<ServerEmoji> => {
    const fd = new FormData();
    fd.append('file', file);
    const q = new URLSearchParams({ name });
    const res = await t.upload(`/servers/${serverId}/emojis?${q}`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as ServerEmoji;
  },
  deleteServerEmoji: (serverId: string, emojiId: string) =>
    req<void>('DELETE', `/servers/${serverId}/emojis/${emojiId}`),

  /** Наборы стикеров из Telegram (#68). `name` — ссылка t.me/addstickers/… либо голое имя набора. */
  importStickerPack: (serverId: string, name: string) =>
    req<{ id: string; name: string; title: string; count: number; skipped: number }>(
      'POST',
      `/servers/${serverId}/sticker-packs`,
      { name },
    ),
  deleteStickerPack: (serverId: string, packId: string) =>
    req<void>('DELETE', `/servers/${serverId}/sticker-packs/${packId}`),

  // Channel "general" + per-channel sound overrides.
  setChannelGeneral: (channelId: string, userId: string | null) =>
    req<{ ok: true }>('PUT', `/channels/${channelId}/general`, { userId }),
  /** Купить награду «себе» (анимированный аватар). Адресные и канальные — своими маршрутами. */
  buySelfItem: (serverId: string, item: string) =>
    req<{ spent: number; balance: number }>('POST', `/servers/${serverId}/shop/${item}/buy`),
  /** Снять анимацию, оставив обычный аватар. Право покупки не отбирается. */
  clearAnimatedAvatar: () => req<User>('DELETE', '/users/me/avatar/animated'),
  uploadAnimatedAvatar: async (file: File): Promise<User> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/users/me/avatar/animated`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as User;
  },
  /**
   * Забрать пойманного гуся.
   * ⚠️ Отказ несёт `reason` — по нему клиент решает, гасить подсказку молча или показать сожаление.
   */
  claimGoose: (serverId: string, offerId: string) =>
    req<{ bonus: number; balance: number }>('POST', `/servers/${serverId}/economy/goose/${offerId}`),
  /** Баланс и уровень ЧУЖОГО человека для карточки профиля; `null`, если показывать нечего. */
  userEconomy: (serverId: string, userId: string) =>
    req<{ card: UserEconomyCard | null }>('GET', `/servers/${serverId}/economy/user/${userId}`),
  // ─── Саундборд (#21) ───────────────────────────────────────────────────────────────────────
  /**
   * Список сэмплов И действующие пределы.
   * ⚠️ Пределы приезжают с сервера, а не повторяются здесь константами: длительность проверяет
   * клиент, размер и число — сервер, и разъехавшиеся числа выглядели бы капризом, а не ошибкой.
   */
  listSoundboard: (serverId: string) =>
    req<{
      clips: SoundboardClip[];
      max: number;
      maxBytes: number;
      maxSeconds: number;
      defaultPriceCoins: number;
      maxPriceCoins: number;
    }>('GET', `/servers/${serverId}/soundboard`),
  deleteSoundboardClip: (serverId: string, clipId: string) =>
    req<void>('DELETE', `/servers/${serverId}/soundboard/${clipId}`),
  /**
   * Поменять цену звука. `null` — вернуть на общую цену каталога.
   * ⚠️ `null` и `0` — РАЗНОЕ: ноль это «даром», и владелец должен уметь поставить его осознанно.
   */
  setSoundboardPrice: (serverId: string, clipId: string, priceCoins: number | null) =>
    req<{ ok: true }>('PATCH', `/servers/${serverId}/soundboard/${clipId}`, { priceCoins }),
  /**
   * Выстрелить сэмплом в голосовой канал. Списывает монеты — отказ приходит текстом для человека.
   * ⚠️ Ничего не проигрывает сама: звук придёт СОБЫТИЕМ по сокету, тем же, что и всем остальным.
   * Иначе стреляющий слышал бы свой выстрел дважды или раньше других.
   */
  fireSoundboard: (channelId: string, clipId: string) =>
    req<{ spent: number; balance: number }>('POST', `/channels/${channelId}/soundboard/${clipId}`),
  uploadSoundboardClip: async (
    serverId: string,
    name: string,
    file: File,
    priceCoins?: number | null,
  ): Promise<SoundboardClip> => {
    const fd = new FormData();
    // ⚠️ Имя и цена ПЕРЕД файлом: fastify-multipart отдаёт поля, разобранные до файла, и поле после
    // него в `file.fields` уже не попадёт.
    fd.append('name', name);
    if (priceCoins !== null && priceCoins !== undefined) fd.append('price', String(priceCoins));
    fd.append('file', file);
    const res = await t.upload(`/servers/${serverId}/soundboard`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as SoundboardClip;
  },
  uploadChannelSound: async (channelId: string, event: string, file: File): Promise<{ event: string; url: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/channels/${channelId}/sounds/${event}`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { event: string; url: string };
  },
  deleteChannelSound: (channelId: string, event: string) =>
    req<void>('DELETE', `/channels/${channelId}/sounds/${event}`),

  createCategory: (serverId: string, name: string) =>
    req<Category>('POST', `/servers/${serverId}/categories`, { name }),
  updateCategory: (categoryId: string, name: string) =>
    req<Category>('PATCH', `/categories/${categoryId}`, { name }),
  reorderCategories: (serverId: string, items: { categoryId: string; position: number }[]) =>
    req<void>('PUT', `/servers/${serverId}/categories/reorder`, { items }),
  deleteCategory: (categoryId: string) => req<void>('DELETE', `/categories/${categoryId}`),
  createChannel: (serverId: string, name: string, type: 'text' | 'voice', categoryId?: string | null) =>
    req<Channel>('POST', `/servers/${serverId}/channels`, { name, type, categoryId }),
  updateChannel: (
    channelId: string,
    body: {
      name?: string;
      topic?: string | null;
      categoryId?: string | null;
      syncedToCategory?: boolean;
      icon?: string | null;
      /** Качество звука голосового канала в кбит/с (#101); null = умолчание. */
      voiceBitrate?: number | null;
    },
  ) => req<Channel>('PATCH', `/channels/${channelId}`, body),
  deleteChannel: (channelId: string) => req<void>('DELETE', `/channels/${channelId}`),
  reorderChannels: (
    serverId: string,
    items: { channelId: string; categoryId: string | null; position: number }[],
  ) => req<void>('PUT', `/servers/${serverId}/channels/reorder`, { items }),

  listChannelOverwrites: (channelId: string) =>
    req<PermissionOverwrite[]>('GET', `/channels/${channelId}/overwrites`),
  setChannelOverwrite: (channelId: string, o: PermissionOverwrite) =>
    req<void>('PUT', `/channels/${channelId}/overwrites/${o.targetType}/${o.targetId}`, { allow: o.allow, deny: o.deny }),
  deleteChannelOverwrite: (channelId: string, targetType: string, targetId: string) =>
    req<void>('DELETE', `/channels/${channelId}/overwrites/${targetType}/${targetId}`),

  listCategoryOverwrites: (categoryId: string) =>
    req<PermissionOverwrite[]>('GET', `/categories/${categoryId}/overwrites`),
  setCategoryOverwrite: (categoryId: string, o: PermissionOverwrite) =>
    req<void>('PUT', `/categories/${categoryId}/overwrites/${o.targetType}/${o.targetId}`, {
      allow: o.allow,
      deny: o.deny,
    }),
  deleteCategoryOverwrite: (categoryId: string, targetType: string, targetId: string) =>
    req<void>('DELETE', `/categories/${categoryId}/overwrites/${targetType}/${targetId}`),

  // Курсор порции — (время, id): сервер берёт точное время из строки `beforeId` (#212, `historyPage.ts`).
  listMessages: (channelId: string, cursor?: HistoryCursor) =>
    req<Message[]>('GET', `/channels/${channelId}/messages${historyQuery(cursor)}`),
  sendMessage: (
    channelId: string,
    content: string,
    attachments: Attachment[] = [],
    replyToId?: string | null,
    stickerId?: string | null,
  ) => req<Message>('POST', `/channels/${channelId}/messages`, { content, attachments, replyToId, stickerId }),
  editMessage: (channelId: string, messageId: string, content: string) =>
    req<Message>('PATCH', `/channels/${channelId}/messages/${messageId}`, { content }),
  deleteMessage: (channelId: string, messageId: string) =>
    req<void>('DELETE', `/channels/${channelId}/messages/${messageId}`),
  react: (channelId: string, messageId: string, emoji: string, op: 'add' | 'remove') =>
    req<void>('POST', `/channels/${channelId}/messages/${messageId}/reactions`, { emoji, op }),
  pinMessage: (channelId: string, messageId: string) =>
    req<Message>('PUT', `/channels/${channelId}/messages/${messageId}/pin`),
  unpinMessage: (channelId: string, messageId: string) =>
    req<Message>('DELETE', `/channels/${channelId}/messages/${messageId}/pin`),
  listPins: (channelId: string) => req<Message[]>('GET', `/channels/${channelId}/pins`),
  uploadAttachment: async (channelId: string, file: File, opts?: UploadOpts): Promise<Attachment> => {
    // Размер картинки (и видео с длительностью, 06.10) меряем параллельно загрузке (#194): лента оставит место до скачивания.
    const dims = measureMediaFile(file);
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/channels/${channelId}/attachments`, fd, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    const size = await dims;
    return size ? { ...(data as Attachment), ...size } : (data as Attachment);
  },
  uploadChannelIcon: async (channelId: string, file: File): Promise<Channel> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/channels/${channelId}/icon`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Channel;
  },

  // Входящие вебхуки канала (#24). Токен приходит ТОЛЬКО в ответе создания и «Сгенерировать заново» — в базе лежит хеш.
  listWebhooks: (channelId: string) => req<Webhook[]>('GET', `/channels/${channelId}/webhooks`),
  /** Все вебхуки сервера в каналах, где у меня `MANAGE_WEBHOOKS` (раздел «Интеграции» настроек сервера). */
  listServerWebhooks: (serverId: string) => req<Webhook[]>('GET', `/servers/${serverId}/webhooks`),
  createWebhook: (channelId: string, name: string) => req<WebhookWithToken>('POST', `/channels/${channelId}/webhooks`, { name }),
  updateWebhook: (webhookId: string, body: { name?: string; channelId?: string; avatarUrl?: null }) =>
    req<Webhook>('PATCH', `/webhooks/${webhookId}`, body),
  regenerateWebhookToken: (webhookId: string) => req<WebhookWithToken>('POST', `/webhooks/${webhookId}/token`),
  deleteWebhook: (webhookId: string) => req<void>('DELETE', `/webhooks/${webhookId}`),
  uploadWebhookAvatar: async (webhookId: string, file: File): Promise<Webhook> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/webhooks/${webhookId}/avatar`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Webhook;
  },
  /** Адрес приёма, который вставляют во внешнюю программу (как у Discord): `<api>/api/webhooks/<id>/<token>`. */
  webhookUrl: (webhookId: string, token: string) => `${t.base().replace(/\/+$/, '')}/api/webhooks/${webhookId}/${token}`,

  listRoles: (serverId: string) => req<Role[]>('GET', `/servers/${serverId}/roles`),
  createRole: (serverId: string, body: { name: string; color?: number; permissions?: string; mentionable?: boolean }) =>
    req<Role>('POST', `/servers/${serverId}/roles`, body),
  updateRole: (
    roleId: string,
    body: {
      name?: string;
      color?: number;
      permissions?: string;
      hoist?: boolean;
      position?: number;
      mentionable?: boolean;
      membersCanAssign?: boolean;
    },
  ) => req<Role>('PATCH', `/roles/${roleId}`, body),
  deleteRole: (roleId: string) => req<void>('DELETE', `/roles/${roleId}`),
  reorderRoles: (serverId: string, order: string[]) => req<void>('PUT', `/servers/${serverId}/roles/reorder`, { order }),

  listAudit: (serverId: string, before?: string) =>
    req<AuditLogEntry[]>('GET', `/servers/${serverId}/audit${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  searchMessages: (serverId: string, q: string, channelId?: string) =>
    req<Message[]>(
      'GET',
      `/servers/${serverId}/search?q=${encodeURIComponent(q)}${channelId ? `&channelId=${channelId}` : ''}`,
    ),

  listMembers: (serverId: string) => req<ServerMemberInfo[]>('GET', `/servers/${serverId}/members`),
  /** Покинуть сервер по своей воле (#92). Владельцу нельзя — сначала передать владение. */
  leaveServer: (serverId: string) => req<void>('POST', `/servers/${serverId}/leave`),
  /** Отчёт диагностики показа экрана (#100) — уходит на сервер по кнопке, читается там psql. */
  sendDiagReport: (body: unknown) => req<{ ok: boolean }>('POST', '/diag/report', body),
  kickMember: (serverId: string, userId: string) => req<void>('DELETE', `/servers/${serverId}/members/${userId}`),
  /**
   * Бан на сервере с необязательной жалобой держателю инстанса гостя (§5.11).
   *
   * ⚠️ Ответ РАЗНЫЙ по смыслу: без жалобы это 204, с жалобой — исход отправки. Бан при этом
   * случился в обоих случаях: отказ жалобы его не отменяет.
   */
  banMemberWithReport: (
    serverId: string,
    userId: string,
    body: { reason?: string; report?: boolean; evidence?: { text: string; at: number; channel: string }[] },
  ) => req<{ ok: true; report?: { sent: boolean; problem?: string } } | void>('POST', `/servers/${serverId}/members/${userId}/ban`, body),
  banMember: (serverId: string, userId: string, reason?: string) =>
    req<void>('POST', `/servers/${serverId}/members/${userId}/ban`, { reason }),
  listBans: (serverId: string) => req<BanInfo[]>('GET', `/servers/${serverId}/bans`),
  unbanMember: (serverId: string, userId: string) => req<void>('DELETE', `/servers/${serverId}/bans/${userId}`),
  transferOwnership: (serverId: string, newOwnerId: string) =>
    req<void>('POST', `/servers/${serverId}/transfer`, { newOwnerId }),
  assignRole: (serverId: string, userId: string, roleId: string) =>
    req<void>('PUT', `/servers/${serverId}/members/${userId}/roles/${roleId}`),
  unassignRole: (serverId: string, userId: string, roleId: string) =>
    req<void>('DELETE', `/servers/${serverId}/members/${userId}/roles/${roleId}`),

  voiceToken: (channelId: string) => req<VoiceTokenResponse>('POST', `/channels/${channelId}/voice/token`),
  // Companion token for a native (desktop) screen share — same { url, token, room } shape.
  voiceScreenToken: (channelId: string) =>
    req<VoiceTokenResponse>('POST', `/channels/${channelId}/voice/screen-token`),
  voiceMute: (channelId: string, userId: string, muted: boolean) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/mute`, { muted }),
  voiceDisconnect: (channelId: string, userId: string) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/disconnect`),
  voiceMove: (channelId: string, userId: string, toChannelId: string) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/move`, { toChannelId }),
  /** «Ткнуть» человека, сидящего в голосовом канале. Пустое сообщение допустимо. */
  voicePoke: (channelId: string, userId: string, message: string) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/poke`, { message }),
  /** Удалить все свои отчёты диагностики (#113). Возвращает, сколько удалено. */
  deleteMyDiag: () => req<{ deleted: number }>('DELETE', '/diag/mine'),

  // ─── Экономика: ГусКоины (#117) ──────────────────────────────────────────────────────────────
  /** Настройки + мой кошелёк. `settings` приходит только тому, кто может их менять. */
  /**
   * Настройки экономики + мой кошелёк.
   *
   * ⚠️ Когда экономика на инстансе выключена (`ECONOMY_ENABLED=false`), маршрута на бэкенде НЕТ —
   * ходить туда незачем. Гейт стоит НЕ здесь, а в `economyClient.ensureEconomy`, и решает его
   * `economyVisible` по живому полю профиля: здешняя проверка опиралась на сохранённый флаг
   * инстанса, который не обновляется с момента добавления сервера, и в десктопе намертво отрезала
   * экономику, включённую позже (04.09). Панель настроек ходит сюда только из своей вкладки, а её
   * показ гейтится тем же правилом.
   */
  getEconomy: (serverId: string) => req<EconomyView>('GET', `/servers/${serverId}/economy`),
  /** Покрутить ползунки (MANAGE_ECONOMY). */
  saveEconomy: (serverId: string, patch: Partial<EconomySettingsDto>) =>
    req<EconomySettingsDto>('PATCH', `/servers/${serverId}/economy`, patch),
  /**
   * Сколько заработали бы люди за последнюю неделю ПРИ ЭТИХ настройках.
   *
   * Считается той же функцией, что и начисление, — иначе панель обещала бы одно, а начислялось бы
   * другое, и доверия к ней больше не будет.
   */
  previewEconomy: (serverId: string, patch: Partial<EconomySettingsDto>) =>
    req<EconomyPreview>('POST', `/servers/${serverId}/economy/preview`, patch),
  /** Ретроначисление за сухой прогон — один раз за всю жизнь сервера. */
  grantRetro: (serverId: string) =>
    req<{ granted: number; people: number; skipped: number }>('POST', `/servers/${serverId}/economy/retro`),

  /** Что ретро выдаст, если нажать сейчас. Ничего не меняет — обязательный шаг перед выдачей. */
  previewRetro: (serverId: string) => req<RetroPreview>('POST', `/servers/${serverId}/economy/retro/preview`),
  /** Не участвовать в экономике: не копить и не попадать в таблицу лидеров. */
  /**
   * Мои переключатели экономики на сервере. Два РАЗНЫХ (#122): «не участвовать» останавливает и
   * начисление, «не принимать типы» — только входящие, заработок при этом идёт.
   */
  setEconomyOptOut: (serverId: string, patch: { optedOut?: boolean; tipsOptOut?: boolean }) =>
    req<{ optedOut: boolean; tipsOptOut: boolean }>('PATCH', `/servers/${serverId}/economy/me`, patch),
  /** Мои настройки участника на сервере (только свои — чужие не раскрываем). */
  getMyMember: (serverId: string) => req<{ pokesOptOut: boolean }>('GET', `/servers/${serverId}/members/me`),
  /** Принимать ли тычки на этом сервере. Решение человека, не владельца. */
  setPokesOptOut: (serverId: string, pokesOptOut: boolean) =>
    req<{ pokesOptOut: boolean }>('PATCH', `/servers/${serverId}/members/me/pokes`, { pokesOptOut }),
  /** Мои последние операции — ответ на «было 500, стало 300». */
  /** Купить награду и применить её к человеку в этом канале (МЕГА пок). */
  buyForUser: (channelId: string, userId: string, item: string, message?: string) =>
    req<{ spent: number; balance: number }>('POST', `/channels/${channelId}/voice/${userId}/buy`, { item, message }),

  /** Цена и доступность позиции каталога (MANAGE_ECONOMY). */
  /** `priceMinutes: null` — снять свою цену сервера и вернуться к умолчанию (у аватара — к цене инстанса). */
  setShopItem: (serverId: string, item: string, patch: { priceMinutes?: number | null; enabled?: boolean }) =>
    req<{ shop: ShopEntry[] }>('PATCH', `/servers/${serverId}/shop/${item}`, patch),

  /** Сезонная таблица лидеров + корона. Доступна любому участнику: это витрина, а не настройки. */
  getLeaderboard: (serverId: string) => req<Leaderboard>('GET', `/servers/${serverId}/economy/leaderboard`),

  /**
   * Свой журнал. Без периода — последние 20 (это «что было только что», а не архив).
   * ⚠️ Границу периода считает СЕРВЕР: у сезона она зависит от разбивки сервера, и клиент,
   * посчитавший её сам, разошёлся бы с сервером ровно на стыке сезонов.
   */
  getEconomyLedger: (serverId: string, period?: 'week' | 'month' | 'season') =>
    req<LedgerEntry[]>('GET', `/servers/${serverId}/economy/ledger${period ? `?period=${period}` : ''}`),

  /** Сводка за сутки + сверка журнала с балансами (MANAGE_ECONOMY). */
  getEconomySummary: (serverId: string) => req<EconomySummary>('GET', `/servers/${serverId}/economy/summary`),
  /** Загрузить иконку валюты. Проверки (тип, размер, анимация) — на сервере, в `checkCoinIcon`. */
  uploadCoinIcon: async (serverId: string, file: File): Promise<{ iconUrl: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/servers/${serverId}/economy/icon`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { iconUrl: string };
  },
  /** Типнуть человека, сидящего с тобой в канале. Сумму назначает сервер, не клиент. */
  tip: (channelId: string, userId: string) =>
    req<{ debited: number; credited: number; burned: number }>('POST', `/channels/${channelId}/voice/${userId}/tip`),
  /** Отдать СВОЙ свежий кадр показа (#115). Картинка — data-URL, правила в `shared/streamPreview`. */
  putStreamPreview: (channelId: string, image: string) =>
    req<void>('PUT', `/channels/${channelId}/voice/preview`, { image }),
  /** Взять чужое превью показа. 404 — превью нет (человек не показывает или выключил отдачу). */
  getStreamPreview: (channelId: string, userId: string) =>
    req<{ image: string }>('GET', `/channels/${channelId}/voice/preview/${userId}`),

  // --- беседы ЛС, этап 1 сервера (`/api/conv/*`, `docs/dm/STAGE1.md`); клиент ходит сюда в режиме бесед (этап 2) ---
  // `groups=1` (07.10, `groups1`): клиент умеет группы ЛС. Сервер без групп параметр не знает и не смотрит на него.
  // `former=1` (08.10, `groups3`): ещё и бывшие группы (только на чтение); старый сервер параметр не знает и не шлёт.
  convList: () => req<ConvListResponse>('GET', '/conv?groups=1&former=1'),
  convSync: (pts: number, limit = 500) => req<ConvSyncResponse>('GET', `/conv/sync?pts=${pts}&limit=${limit}&groups=1`),
  /** Э1 (`fedm1`): вместо id — человек связанного инстанса из поиска (`RemoteUserHit`), строки у нас у него может не быть. */
  convDirect: (who: string | { instanceId: string; homeUserId: string }) =>
    req<ConvSummary | { id: string }>('POST', '/conv/direct', typeof who === 'string' ? { userId: who } : who),
  /** «Избранное» (08.10, `saved1`): найти беседу с самим собой или завести; ответ — её сводка (`saved: true`). */
  convSaved: () => req<ConvSummary | { id: string }>('POST', '/conv/saved'),
  /** Одно из `before`/`after` (курсор `"<sortKey>_<id>"`) или `around` (id сообщения); без них — последние. */
  /** `date` (ISO, признак `search1`) — окно вокруг первого сообщения не раньше этого момента («Перейти к дате», G25). */
  convHistory: (convId: string, q: { before?: string; after?: string; around?: string; date?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    // `groups3`: бывшая группа читается до выхода; старый сервер параметр не знает.
    p.set('former', '1');
    const qs = p.toString();
    return req<ConvHistoryResponse>('GET', `/conv/${convId}/messages${qs ? `?${qs}` : ''}`);
  },
  /** Общие медиа беседы (G29, `media1`): вложения вида `kind` (или ссылки), новые первыми; `former` — бывшая группа (до выхода). */
  convMedia: (convId: string, kind: SharedMediaKind, before?: string | null, former?: boolean) => {
    const p = new URLSearchParams({ kind });
    if (before) p.set('before', before);
    if (former) p.set('former', '1');
    return req<SharedMediaResponse>('GET', `/conv/${convId}/media?${p.toString()}`);
  },
  /** Позвонить собеседнику беседы 1:1 (С5, `calls1`); 409 `line_busy` — занят. `device` — id этой вкладки. */
  callStart: (convId: string, device: string) => req<CallJoinResponse>('POST', `/conv/${convId}/call`, { device }),
  callAnswer: (callId: string, device: string) => req<CallJoinResponse>('POST', `/calls/${callId}/answer`, { device }),
  callDecline: (callId: string) => req<CallActiveResponse>('POST', `/calls/${callId}/decline`, {}),
  callHangup: (callId: string) => req<CallActiveResponse>('POST', `/calls/${callId}/hangup`, {}),
  /** Знак жизни звонка; `video` (`calls2`) — у меня включена камера или показ: звонок станет «Видеозвонком». */
  callPing: (callId: string, video?: boolean) =>
    req<CallActiveResponse>('POST', `/calls/${callId}/ping`, video ? { video: true } : {}),
  /** `fed` (Э6, `fedcall1`): отдать и входящий звонок с другого инстанса (`DmCall.host`); без него сервер его не показывает. */
  callActive: (fed?: boolean) => req<CallActiveResponse>('GET', `/calls/active${fed ? '?fed=1' : ''}`),
  /** Сколько общих медиа каждого вида (G29, `media1`). */
  convMediaCounts: (convId: string, former?: boolean) =>
    req<SharedMediaCounts>('GET', `/conv/${convId}/media/counts${former ? '?former=1' : ''}`),
  /** Поиск по беседе (G05, признак `search1`): подстрока, новые первыми; `before` — курсор `next` прошлой порции. */
  convSearch: (convId: string, q: string, before?: string, limit?: number) => {
    const p = new URLSearchParams({ q });
    if (before) p.set('before', before);
    if (limit) p.set('limit', String(limit));
    return req<ConvSearchResponse>('GET', `/conv/${convId}/search?${p.toString()}`);
  },
  /**
   * Поиск из списка бесед (G35, `gsearch1`): по тексту во всех моих беседах; `conversationId` — чип «человек», `since` / `until` —
   * чип «дата». `before` — курсор `next` прошлой порции. `full` — вкладки поиска на телефоне (12.10): имена вложений в поиск
   * (`names=1`) и целые сообщения в ответ (`full=1`, `ConvSearchAllHit.message`); старый сервер оба параметра пропускает.
   */
  convSearchAll: (a: {
    q: string;
    conversationId?: string;
    since?: string;
    until?: string;
    kind?: SharedMediaKind;
    before?: string;
    limit?: number;
    full?: boolean;
  }) => {
    const p = new URLSearchParams({ q: a.q });
    if (a.full) {
      p.set('names', '1');
      p.set('full', '1');
    }
    if (a.conversationId) p.set('conversationId', a.conversationId);
    if (a.since) p.set('since', a.since);
    if (a.until) p.set('until', a.until);
    if (a.kind) p.set('kind', a.kind);
    if (a.before) p.set('before', a.before);
    if (a.limit) p.set('limit', String(a.limit));
    return req<ConvSearchAllResponse>('GET', `/conv/search?${p.toString()}`);
  },
  /** «Частые» беседы (G35, `freq1`): по убыванию числа моих сообщений за 90 дней с затуханием. */
  convFrequent: (limit = 20) => req<ConvFrequentResponse>('GET', `/conv/frequent?limit=${limit}`),
  /** «Убрать из частых» на сервере (09.10, `freq2`): `at` — когда убрано на устройстве (разовый перенос), нет — сейчас. */
  convFrequentHide: (items: ConvFrequentHideRequest['items']) =>
    req<ConvFrequentHideResponse>('POST', '/conv/frequent/hide', { items } satisfies ConvFrequentHideRequest),
  /** Поиск по сообщениям каналов всех моих серверов (G35, `srvsearch1`); `before` — курсор `next` прошлой порции. */
  searchServers: (a: { q: string; before?: string; limit?: number }) => {
    const p = new URLSearchParams({ q: a.q });
    if (a.before) p.set('before', a.before);
    if (a.limit) p.set('limit', String(a.limit));
    return req<ServerSearchResponse>('GET', `/search/servers?${p.toString()}`);
  },
  /** Мои сообщения беседы с непрочитанными реакциями, самые старые первыми (G24, `reactunread1`). */
  convUnreadReactions: (convId: string) => req<ConvUnreadReactionsResponse>('GET', `/conv/${convId}/unread-reactions`),
  /** Непрочитанные упоминания меня в группе (`groups2`, G24), самые старые первыми — для кнопки «@». */
  convUnreadMentions: (convId: string) => req<ConvUnreadReactionsResponse>('GET', `/conv/${convId}/unread-mentions`),
  /** Реакции увидены (G24): `messageIds` — показанные на экране, без списка — все («Прочитать все»). */
  convReactionsRead: (convId: string, messageIds?: string[]) =>
    req<{ read: number }>('POST', `/conv/${convId}/reactions-read`, messageIds ? { messageIds } : {}),
  /**
   * Отправка с id отправки: повтор с тем же `clientId` и тем же содержимым — 200 и то же сообщение (дублей нет), с
   * другим — 409 `client_id_conflict`. Вложения — id загрузок `convUpload` + подсказки клиента.
   * `silent: true` — «Отправить без звука» (С3): слать только при `convSyncRules.serverSilentSend(features)` (`conv8`),
   * старый сервер поле молча отбросит. В отпечаток повтора не входит: повтор с другим `silent` — 200 и сообщение как есть.
   * `timeoutMs` — без ответа дольше отказ без статуса «сервер не ответил» (очередь исходящих, 05.10).
   */
  convSend: (
    convId: string,
    body: {
      clientId: string;
      content: string;
      attachments: Array<Pick<Attachment, 'width' | 'height' | 'waveform' | 'durationMs' | 'asFile' | 'gif' | 'spoiler' | 'once' | 'onceTtl' | 'round'> & { id: string }>;
      replyToId?: string | null;
      silent?: boolean;
      /** «Без превью ссылки» (G19, признак `linkprev1`): слать только при нём — старый сервер поле отбросит. */
      noPreview?: boolean;
      /** «Подпись над медиа» (G48, признак `media2`): слать только при нём — старый сервер поле отбросит. */
      captionAbove?: boolean;
      /** Цитата фрагмента (G55, признак `quote1`): кусок текста цитируемого; слать только при нём. */
      replyQuote?: { text: string; offset: number };
      /** Стикер каталога (С2, признак `stickers2`): сообщение-стикер — `content: ''` и без вложений. */
      stickerId?: string;
      /**
       * Геопозиция / контакт (G69, признак `geocontact1`): отдельное сообщение — `content: ''`, без вложений; запасной текст
       * собирает сервер. Слать только при признаке.
       */
      media?: import('@gusvoice/shared').ConvMediaInput;
    },
    timeoutMs?: number,
  ) => t.req<ConvMessage>('POST', `/conv/${convId}/messages`, body, timeoutMs ? { timeoutMs } : undefined),
  /**
   * Э5 (#141, `fedm5`): долгая сессия на инстансе собеседника — «мой дом лежит, пишу через него». Только в беседе 1:1 с человеком
   * соседа; ошибки: 409 `federation.unsupported`/код связки, 503 `federation.peer_unreachable`, 404. `userId` — наш id ТАМ.
   */
  convFallback: (convId: string, purpose?: 'call') =>
    req<ConvFallbackSession>('GET', `/conv/${convId}/fallback${purpose === 'call' ? '?for=call' : ''}`),
  /** Э5: отчёт об отправленном в обход дома (вся очередь устройства; пустой тоже), после него дом сверяет и подтверждает задним числом. */
  convViaClaims: (items: ConvViaClaim[]) => req<unknown>('POST', '/conv/via-claims', { items }),
  // ── Контакты (08.10, #211, признак `contacts1`) — каждая запись отвечает списком целиком ──
  contacts: () => req<ContactList>('GET', '/contacts'),
  contactAdd: (userId: string, name?: string | null) =>
    req<ContactList>('POST', '/contacts', name === undefined ? { userId } : { userId, name }),
  contactRename: (userId: string, name: string | null) =>
    req<ContactList>('PATCH', `/contacts/${encodeURIComponent(userId)}`, { name }),
  contactRemove: (userId: string) => req<ContactList>('DELETE', `/contacts/${encodeURIComponent(userId)}`),
  // ── Папки бесед ЛС (07.10, #211, G40, признак `folders1`) — каждая запись отвечает списком целиком ──
  dmFolders: () => req<DmFolderList>('GET', '/dm-folders'),
  /** `pinnedOwn` (09.10, `pinset1`) — новая папка сразу со своим набором закреплённых; сервер постарше поле не читает. */
  dmFolderCreate: (body: DmFolderInput & { pinnedOwn?: boolean }) => req<DmFolderList & { id: string }>('POST', '/dm-folders', body),
  dmFolderUpdate: (id: string, body: DmFolderInput) =>
    req<DmFolderList>('PUT', `/dm-folders/${encodeURIComponent(id)}`, body),
  dmFolderDelete: (id: string) => req<DmFolderList>('DELETE', `/dm-folders/${encodeURIComponent(id)}`),
  dmFolderOrder: (ids: string[]) => req<DmFolderList>('PUT', '/dm-folders/order', { ids }),
  /** Свой порядок закреплённых в папке сверху вниз (09.10, `pinorder2`); у системной — 400 `folders.system`. */
  dmFolderPinOrder: (folderId: string, ids: string[]) =>
    req<DmFolderList>('PUT', `/dm-folders/${encodeURIComponent(folderId)}/pinned-order`, { ids } satisfies DmFolderPinOrderRequest),
  /** Перевести папки на свой набор закреплённых (09.10, `pinset1`): `ids` — что сейчас видно закреплённым в каждой. */
  dmFolderPinOwn: (folders: DmFolderPinOwnRequest['folders']) =>
    req<DmFolderList>('POST', '/dm-folders/pinned-own', { folders } satisfies DmFolderPinOwnRequest),
  /** Закрепить / открепить беседу только в папке (09.10, `pinset1`); предел — 409 `folders.pin_limit` с `max`. */
  dmFolderPin: (folderId: string, convId: string, pinned: boolean) =>
    req<DmFolderList>(
      'PUT',
      `/dm-folders/${encodeURIComponent(folderId)}/pinned/${encodeURIComponent(convId)}`,
      { pinned } satisfies DmFolderPinRequest,
    ),
  // ── Стикеры в ЛС (С2, #211, признак `stickers2`): каталог инстанса и «мои наборы» ──
  stickersMine: () => req<{ packs: StickerCatalogPack[] }>('GET', '/stickers/mine'),
  stickersCatalog: (q = '') => req<StickerCatalog>('GET', `/stickers/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  stickerPack: (packId: string) => req<StickerCatalogPack>('GET', `/stickers/packs/${encodeURIComponent(packId)}`),
  /** Набор полученного стикера: по id стикера в сообщении и его картинке (копия могла уйти из каталога). */
  stickerLookup: (stickerId: string, url: string) =>
    req<StickerCatalogPack>('GET', `/stickers/lookup?id=${encodeURIComponent(stickerId)}&url=${encodeURIComponent(url)}`),
  /** Загрузить набор из Telegram себе (ссылка или имя); уже лежащий в каталоге — просто встаёт в «мои». */
  stickerImport: (name: string) =>
    req<StickerCatalogPack & { reused: boolean; skipped?: number }>('POST', '/stickers/packs', { name }),
  stickerPackDelete: (packId: string) => req<void>('DELETE', `/stickers/packs/${encodeURIComponent(packId)}`),
  stickerMineAdd: (packId: string) => req<void>('PUT', `/stickers/mine/${encodeURIComponent(packId)}`),
  stickerMineRemove: (packId: string) => req<void>('DELETE', `/stickers/mine/${encodeURIComponent(packId)}`),
  stickerMineOrder: (ids: string[]) => req<void>('PUT', '/stickers/mine', { ids }),
  /** Избранные и недавние стикеры (С2 порция 2, `stickers3`) — общие для всех устройств; правка отвечает списками целиком. */
  stickerLists: () => req<StickerLists>('GET', '/stickers/lists'),
  stickerFave: (s: { id: string; url: string }, on: boolean) =>
    req<StickerLists>(on ? 'PUT' : 'DELETE', `/stickers/faved/${encodeURIComponent(s.id)}?url=${encodeURIComponent(s.url)}`),
  stickerRecentPush: (s: { id: string; url: string }) =>
    req<StickerLists>('POST', `/stickers/recent?url=${encodeURIComponent(s.url)}`, { id: s.id }),
  stickerRecentClear: () => req<StickerLists>('DELETE', '/stickers/recent'),
  // ── «Мои GIF» и поиск GIF (Р-7, #211, признак `gifs1`) ──
  gifs: () => req<SavedGifsResponse>('GET', '/gifs'),
  gifSave: (a: { attachmentId: string; width?: number | null; height?: number | null; durationMs?: number | null }) =>
    req<SavedGif>('POST', '/gifs', a),
  gifDelete: (id: string) => req<void>('DELETE', `/gifs/${encodeURIComponent(id)}`),
  /** Копия «Моего GIF» в беседу — id незавершённого вложения для обычной отправки (`convSend`, подсказка `gif: true`). */
  gifAttach: (id: string, conversationId: string) =>
    req<GifAttachResponse>('POST', `/gifs/${encodeURIComponent(id)}/attach`, { conversationId }),
  gifSearch: (q: string, pos?: string) =>
    req<ExternalGifsResponse>('GET', `/gifs/search?q=${encodeURIComponent(q)}${pos ? `&pos=${encodeURIComponent(pos)}` : ''}`),
  gifExternalAttach: (body: { conversationId: string; url: string; width: number | null; height: number | null }) =>
    req<GifAttachResponse>('POST', '/gifs/external/attach', body),
  convEdit: (convId: string, messageId: string, content: string) =>
    req<ConvMessage>('PATCH', `/conv/${convId}/messages/${messageId}`, { content }),
  convDelete: (convId: string, messageId: string, scope: 'me' | 'both') =>
    req<void>('DELETE', `/conv/${convId}/messages/${messageId}?for=${scope}`),
  /** `big` (08.10, `bigreact1`) — «большая» реакция удержанием; ключ шлётся, только когда он есть (старый сервер его отбросит). */
  convReact: (convId: string, messageId: string, emoji: string, op: 'add' | 'remove', big?: boolean) =>
    req<void>('POST', `/conv/${convId}/messages/${messageId}/reactions`, big ? { emoji, op, big: true } : { emoji, op }),
  /** Опрос в ЛС (14.10, `convpoll1`): голос (`optionIds`) или отмена (пустой список) — ответ: сообщение моими глазами. */
  convPollVote: (convId: string, messageId: string, optionIds: string[]) =>
    req<ConvMessage>('POST', `/conv/${convId}/messages/${messageId}/poll/vote`, { optionIds }),
  /** «Остановить опрос» — только автор (`convpoll1`). */
  convPollClose: (convId: string, messageId: string) => req<ConvMessage>('POST', `/conv/${convId}/messages/${messageId}/poll/close`),
  /** «Посмотреть голоса» неанонимного опроса (`convpoll1`): итоги должны быть открыты (свой голос или опрос остановлен). */
  convPollVoters: (convId: string, messageId: string) =>
    req<import('@gusvoice/shared').ConvPollVotersResponse>('GET', `/conv/${convId}/messages/${messageId}/poll/voters`),
  /** Трансляция геопозиции в ЛС (14.10, `geolive1`): новая точка (только автор, пока идёт) — ответ: сообщение моими глазами. */
  convGeoLiveUpdate: (convId: string, messageId: string, point: { lat: number; lon: number; accuracy?: number | null; heading?: number | null }) =>
    req<ConvMessage>('POST', `/conv/${convId}/messages/${messageId}/live`, point),
  /** «Остановить трансляцию» — только автор (`geolive1`). */
  convGeoLiveStop: (convId: string, messageId: string) => req<ConvMessage>('POST', `/conv/${convId}/messages/${messageId}/live/stop`),
  /** «Прослушал голосовое» (07.10, G12, признак `voice1`): гасит точку у меня и показывает автору; повтор безвреден. */
  convListened: (convId: string, messageId: string) => req<void>('POST', `/conv/${convId}/messages/${messageId}/listened`),
  /** Одноразовое голосовое дослушано или закрыто (`voice3`, G54): сервер удаляет файл, у обоих — «прослушано». */
  convOnceSpent: (convId: string, messageId: string) => req<void>('POST', `/conv/${convId}/messages/${messageId}/once-spent`),
  /** Одноразовое фото/видео открыто (`ttlmedia1`, #226): отметка первого открытия; 410 — уже сгорело. */
  convOnceOpen: (convId: string, messageId: string) =>
    req<{ openedAt: string; serverNow?: string }>('POST', `/conv/${convId}/messages/${messageId}/once-open`),
  /** «Прочитано до» — ключ сообщения (`sortKey`), сервер двигает только вперёд. */
  convRead: (convId: string, key: number) => req<{ lastReadKey: number }>('POST', `/conv/${convId}/read`, { key }),
  /** Черновик между моими устройствами (Р7, признак `conv3`); `keepalive` — запись при закрытии окна. */
  convDraft: (convId: string, body: ConvDraftRequest, keepalive = false) =>
    t.req<void>('PUT', `/conv/${convId}/draft`, body, { keepalive }),
  /** Закреп беседы наверху своего списка (07.10, `conv11`); лимит — 409 с `reason: 'conv_pin_limit'` и `max`. */
  convSetPinned: (convId: string, pinned: boolean) =>
    req<{ pinnedAt: string | null }>('PUT', `/conv/${convId}/pinned`, { pinned }),
  /**
   * Новый порядок моих закреплённых бесед сверху вниз (08.10, `pinorder1`, G02/G42); повтор или не мой закреп — 400
   * `reason: 'conv_pin_order'`. Ответ — все мои закреплённые с новыми `pinnedAt`.
   */
  convPinOrder: (ids: string[]) => req<ConvPinOrderResponse>('PUT', '/conv/pinned-order', { ids }),
  /** «Пометить как непрочитанное / прочитанное» (07.10, `conv13`, G04): точка без числа в моём списке. */
  convSetUnreadMark: (convId: string, marked: boolean) =>
    req<{ marked: boolean }>('PUT', `/conv/${convId}/unread-mark`, { marked }),
  /** «В архив» / «Вернуть из архива» (07.10, `archive1`, G41): отметка только в моей строке участника. */
  convSetArchived: (convId: string, archived: boolean) =>
    req<{ archived: boolean }>('PUT', `/conv/${convId}/archived`, { archived }),
  /** Крестик на плашке незнакомца (08.10, `stranger1`, С7): запоминается в моей строке участника и едет на мои устройства. */
  convHideStranger: (convId: string) => req<{ ok: true }>('POST', `/conv/${convId}/stranger/hide`, {}),
  /** «Пожаловаться» на собеседника 1:1 (08.10, `stranger1`, С7): держателю инстанса, с последними сообщениями собеседника. */
  convReport: (convId: string, body: { reason: DmReportReason; comment?: string }) =>
    req<{ ok: true; merged: boolean }>('POST', `/conv/${convId}/report`, body),
  /** Жалобы из ЛС у держателя инстанса (08.10, `stranger1`): новые сверху. */
  dmReports: () => req<{ reports: DmReportRow[] }>('GET', '/admin/dm-reports'),
  closeDmReport: (id: string) => req<{ ok: true }>('POST', `/admin/dm-reports/${id}/close`, {}),
  /** «Прочитать все» (07.10, `conv13`): все мои беседы с непрочитанным или пометкой прочитаны; `count` — сколько затронуто. */
  convReadAll: () => req<{ count: number }>('POST', '/conv/read-all', {}),
  /** «Очистить историю» (07.10, `conv12`): вся переписка уходит у меня или у обоих; беседа остаётся. */
  convClear: (convId: string, scope: 'me' | 'both') => req<void>('POST', `/conv/${convId}/clear`, { for: scope }),
  /** «Удалить чат» (07.10, `conv12`): переписка очищается, беседа уходит из списка (у обоих — и у собеседника) до нового сообщения. */
  convHide: (convId: string, scope: 'me' | 'both') => req<void>('POST', `/conv/${convId}/hide`, { for: scope }),
  /** Группы ЛС (07.10, `groups1`): создать — название и участники (кроме себя); ответ — сводка группы. */
  convCreateGroup: (body: CreateGroupRequest) => req<ConvSummary>('POST', '/conv/group', body),
  // Э7 (#141, `fedm6`): в группе чужого дома переименовать / позвать / удалить / выйти отвечают `{ ok: true, pending: true }` — сводка доедет `conv.change`.
  convRenameGroup: (convId: string, title: string) => req<ConvSummary | { ok: true; pending?: true }>('PATCH', `/conv/${convId}/group`, { title }),
  convGroupPhoto: async (convId: string, file: File): Promise<ConvSummary> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/conv/${convId}/group/photo`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as ConvSummary;
  },
  convAddMembers: (convId: string, userIds: string[]) => req<ConvSummary | { ok: true; pending: true }>('POST', `/conv/${convId}/members`, { userIds }),
  convRemoveMember: (convId: string, userId: string) => req<ConvSummary | { ok: true; pending: true }>('DELETE', `/conv/${convId}/members/${userId}`),
  convLeaveGroup: (convId: string) => req<{ id: string; left: true } | { ok: true; pending: true }>('POST', `/conv/${convId}/leave`, {}),
  /** Загрузка в закрытое хранилище (шаг 1в): ответ — прежний DTO вложения + `id` для отправки. */
  convUpload: (convId: string, file: File, opts?: UploadOpts) => convUploadVia(convId, file, opts),
  /**
   * Переслать сообщения беседы `fromConversationId` в беседу `convId` (признак сервера `conv5`, только ЛС → ЛС).
   * `clientId` — id отправки ВСЕЙ пачки: держать его до успеха — повтор с ним даёт 200 и те же сообщения (дублей нет).
   * 201 — новые по порядку оригиналов; 400 `forward source not found` + `missing` (чего уже не видно), `forward too large`;
   * 409 `client_id_conflict`; 503 — закрытое хранилище файлов не готово. Ответ — в стор через `convAfterForward`.
   * `body.silent` — переслать «без звука» (С3, только при `conv8`, как у `convSend`).
   */
  convForward: (convId: string, body: ConvForwardRequest) =>
    req<ConvForwardResponse>('POST', `/conv/${convId}/forward`, body),
  /**
   * Удалить пачкой (признак `conv5`): `both` — свои, а при `conv6` в беседе 1:1 и чужие (С1,
   * `convSyncRules.serverDeletesOthersForBoth`); чужое там, где нельзя, — 403 и не удаляется ничего. `me` — любые
   * видимые. Ответ 204; в стор — `convAfterDeleteMany`.
   */
  /**
   * Убрать ОДИН элемент альбома (G56, признак `album1`): `both` — у всех (только своё), `me` — у себя. `removed: 'message'` —
   * элемент был последним видимым, сообщение удалено целиком. 409 `album_item_peer_old` — дом собеседника не понимает.
   */
  convDeleteAlbumItem: (convId: string, messageId: string, attachmentId: string, scope: 'me' | 'both') =>
    req<ConvAlbumItemDeleteResponse>(
      'DELETE',
      `/conv/${convId}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?for=${scope}`,
    ),
  convDeleteMany: (convId: string, ids: string[], scope: 'me' | 'both') =>
    req<void>('POST', `/conv/${convId}/messages/delete`, { ids, for: scope } satisfies ConvDeleteManyRequest),
  /**
   * Закреплённые беседы (С2, признак `conv7` — `convSyncRules.serverDmPins`): МОИ, от старых к новым по порядку ленты,
   * превью в форме `ConvLastMessage` (раунд 11) + `thumb` у фото, `forBoth` — спросить ли при откреплении «Также открепить
   * для собеседника». `pts` — свежесть списка: список из `conv.change`/догонки с номером не больше — не новее.
   */
  convPins: (convId: string) => req<ConvPinsResponse>('GET', `/conv/${convId}/pins`),
  /**
   * Закрепить (`conv7`): `me` — только у себя, `both` — ещё у собеседника. Только видимое мне живое сообщение — иначе
   * 404; мой список полон — 409 `{error: 'pin limit', max}`. Ответ — мой список с `pts`; собеседнику — `conv.change`.
   */
  convPin: (convId: string, messageId: string, scope: 'me' | 'both', notify?: boolean) =>
    req<ConvPinsResponse>(
      'PUT',
      `/conv/${convId}/messages/${messageId}/pin`,
      // G4: «Уведомить всех участников» — только из окна закрепа группы; иначе тело как раньше.
      (notify === undefined ? { for: scope } : { for: scope, notify }) satisfies ConvPinRequest,
    ),
  /**
   * Открепить (`conv7`): `me` — только мой закреп, `both` — и закреп «для обоих» у собеседника. Сообщения нет в беседе —
   * 404, для меня его нет — 200 без изменений. Ответ — мой список с `pts`.
   */
  convUnpin: (convId: string, messageId: string, scope: 'me' | 'both') =>
    req<ConvPinsResponse>('DELETE', `/conv/${convId}/messages/${messageId}/pin?for=${scope}`),
  /**
   * Мои отложенные в беседе (С4, признак `conv9` — `convSyncRules.serverScheduled`): сначала по времени, затем «Когда будет
   * в сети». `pts` — свежесть списка: список из `conv.change`/догонки с номером не больше — не новее.
   */
  convScheduled: (convId: string) => req<ConvScheduledResponse>('GET', `/conv/${convId}/scheduled`),
  /**
   * «Отправить позже» / «Когда будет в сети» (`conv9`): ровно одно из `sendAt` (ISO с поясом, до года вперёд) и
   * `whenOnline: true`. 201 — мой список с новым; повтор `clientId` — 200 / 409 `client_id_conflict`;
   * 400 — режим/время (`schedule mode required`, `bad send_at`, `send_at in the past`, `send_at too far` + `maxDays`),
   * `empty message`, `invalid reply target`; 409 `scheduled limit` (`scope`, `max`). Вложения (`attachments` — id загрузок
   * `convUpload` + подсказки, как у `convSend`) — только при `conv10` (`convSyncRules.serverScheduledAttachments`): сервер
   * без него ответит 400 `scheduled attachments unsupported`; не те файлы — 400 `вложение уже отправлено или не найдено`;
   * предел отложенных с файлами — 409 с `reason: 'scheduled_media_limit'` (`error` — словами).
   */
  convSchedule: (convId: string, body: ConvScheduleRequest) => req<ConvScheduledResponse>('POST', `/conv/${convId}/scheduled`, body),
  /** Правка отложенного (`conv9`): текст и/или время/режим (снимает «не отправлено»). 404 — уже ушло или удалено. */
  convScheduledEdit: (convId: string, scheduledId: string, body: ConvScheduledEditRequest) =>
    req<ConvScheduledResponse>('PATCH', `/conv/${convId}/scheduled/${scheduledId}`, body),
  /** «Отправить сейчас» (`conv9`): 201 — ушло (сообщение + мой список без него); 404 — уже ушло или удалено. */
  convScheduledSendNow: (convId: string, scheduledId: string) =>
    req<ConvScheduledSendResponse>('POST', `/conv/${convId}/scheduled/${scheduledId}/send`),
  /** Удалить отложенное (`conv9`). 404 — уже ушло или удалено. Ответ — мой список. */
  convScheduledDelete: (convId: string, scheduledId: string) =>
    req<ConvScheduledResponse>('DELETE', `/conv/${convId}/scheduled/${scheduledId}`),

  createInvite: (serverId: string, opts?: { expiresInMinutes?: number | null; maxUses?: number | null }) =>
    req<Invite>('POST', `/servers/${serverId}/invites`, opts ?? {}),
  /** Где сработает ссылка этого сервера — для подсказки под выбором срока (§4.2). */
  inviteScope: (serverId: string) => req<InviteScopeView>('GET', `/servers/${serverId}/invite-scope`),
  listInvites: (serverId: string) => req<Invite[]>('GET', `/servers/${serverId}/invites`),
  deleteInvite: (code: string) => req<void>('DELETE', `/invites/${code}`),
  acceptInvite: (code: string) => req<ServerBootstrap>('POST', `/invites/${code}`),

  // --- desktop installer download (public; reads the updater feed server-side) ---
  latestDownload: () => req<{ version: string; windows: string }>('GET', '/download/latest'),
  downloadWindowsUrl: () => `${t.base()}/api/download/windows`,

  // --- Android F-Droid install info (AUTHED — the add-URL carries the repo's basic-auth creds, so it
  //     must not live in the public bundle; the backend hands it out only to logged-in users). ---
  fdroidInfo: () =>
    req<{ repoUrl: string; fingerprint: string; addUrl: string; qr: string }>('GET', '/app/fdroid'),
  /**
   * Картинка карты для геопозиции (`yamap1`): свой сервер проксирует Static API Яндекса. Не картинка / отказ — исключение, карточка
   * остаётся без картинки (`mapImage.ts`).
   */
  /** Что есть в файле карты сервера (`osmmap1`): масштабы, границы, центр. Как есть — разбирает `mapSource.loadMapInfo` (`parseMapInfo`). */
  // Метка десятиминутки обходит кеш браузера (`/info` отдаётся с `max-age=3600`): новые границы карты — не позже 10 минут (`mapSource`).
  mapInfo: () => req<unknown>('GET', `/maps/info?v=${Math.floor(Date.now() / 600_000)}`),
  mapStaticImage: async (path: string): Promise<Blob> => {
    const res = await t.raw(path, 15_000);
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
  /** Карточка ссылки (#64). Бэкенд отвечает 204, когда карточки нет — тогда получаем null. */
  linkPreview: (url: string) =>
    req<{ url: string; title: string | null; description: string | null; siteName: string | null } | null>(
      'GET',
      `/link-preview?url=${encodeURIComponent(url)}`,
    ),

  // --- persisted read marks (migration 0018) ---
  markChannelRead: (channelId: string) => req<{ ok: true }>('POST', `/channels/${channelId}/read`),

  // Force-download URL for a chat attachment: the backend streams the MinIO object with
  // Content-Disposition: attachment (the <a download> attribute is a no-op cross-origin).
  attachmentDownloadUrl: (a: Attachment): string => {
    const m = a.url.match(/\/(attachments\/[A-Za-z0-9._-]+)$/);
    return m
      ? `${t.base()}/api/download/attachment?key=${encodeURIComponent(m[1])}&name=${encodeURIComponent(a.name)}`
      : a.url;
  },

  // --- admin (super-admin only) ---
  /**
   * Инстанс-ручки экономики. Сейчас одна — цена анимированного аватара В МИНУТАХ сидения.
   * ⚠️ Именно инстанса, а не сервера: аватар единственная награда, расходующая хранилище и трафик
   * постоянно, и платит за них держатель железа.
   */
  adminEconomy: () =>
    req<{
      avatarPriceMinutes: number;
      maxMinutes: number;
      /** Потолок аренды аватара, дней вперёд (#228) и его границы; нет полей (старый сервер) — 60 / 30 / 365. */
      avatarRentalMaxDays?: number;
      rentalMaxDaysMin?: number;
      rentalMaxDaysLimit?: number;
      stats: {
        windowDays: number;
        people: number;
        userDays: number;
        hours: number;
        avgSitMinutes: number;
        avgEarnMinutes: number;
        avgGooseMinutes: number;
      };
    }>('GET', '/admin/economy'),
  adminSetEconomy: (patch: { avatarPriceMinutes?: number; avatarRentalMaxDays?: number }) =>
    req<{ ok: true; avatarPriceMinutes: number; avatarRentalMaxDays?: number }>('PUT', '/admin/economy', patch),
  adminUsers: () => req<AdminUser[]>('GET', '/admin/users'),
  adminServers: () => req<AdminServer[]>('GET', '/admin/servers'),
  adminSetCreateServers: (userId: string, canCreateServers: boolean) =>
    req<AdminUser>('PATCH', `/admin/users/${userId}`, { canCreateServers }),
  adminVerifyUser: (userId: string) => req<AdminUser>('POST', `/admin/users/${userId}/verify`),
  adminDeleteUser: (userId: string) => req<{ ok: boolean }>('DELETE', `/admin/users/${userId}`),
  /** «Скрыть от соседей» (F2, §5.2.1) — решение админа инстанса, не самого человека. */
  adminSetUserHidden: (userId: string, hidden: boolean) =>
    req<AdminUser>('PATCH', `/admin/users/${userId}/hidden`, { hidden }),
  /** Галочка «Разрешить федеративный доступ» и список связок-исключений (F2, §5.3). */
  adminSetServerFederation: (serverId: string, enabled: boolean, exclusions?: string[]) =>
    req<{ federatedAccess: boolean; federationExclusions: string[] }>(
      'PATCH',
      `/admin/servers/${serverId}/federation`,
      { enabled, ...(exclusions ? { exclusions } : {}) },
    ),
  // Федерация (#139). Все эти маршруты — только для супер-админа; выключенная федерация отвечает
  // сводкой со `status: 'off'`, а не ошибкой: вкладка должна уметь объяснить, почему пусто.
  federationOverview: () => req<FederationOverview>('GET', '/admin/federation'),
  // Тумблеры «Федерация» и «Личные сообщения с другими инстансами» (#224): отвечают и при выключенной федерации;
  // 404 — сервер старше тумблера (включается только в `.env`).
  federationSwitch: () => req<FederationSwitchView>('GET', '/admin/federation/switch'),
  federationSetSwitch: (patch: FederationSwitchPatch) => req<FederationSwitchView>('PATCH', '/admin/federation/switch', patch),
  federationSetName: (name: string) => req<{ name: string | null }>('PATCH', '/admin/federation/instance', { name }),
  federationPause: (paused: boolean) => req<{ paused: boolean }>('POST', '/admin/federation/pause', { paused }),
  // Оповещения держателю (§5.10): куда слать и с какого молчания считать связку упавшей.
  federationSetAlerts: (body: { ntfyTopic?: string; email?: boolean; linkDownAfterMinutes?: number }) =>
    req<FederationAlertSettings>('PATCH', '/admin/federation/alerts', body),
  federationIssueCode: () => req<{ code: string; expiresAt: number }>('POST', '/admin/federation/code'),
  /**
   * «Ключ скомпрометирован» (§5.1.3): новая личность инстанса, все связки — в «доверие потеряно». Необратимо;
   * `confirm: true` — требование маршрута, чтобы случайный запрос этого не сделал. До 23.09 кнопки не было
   * вовсе (прогон F-20 на стенде): держатель с украденным ключом не мог сменить его сам.
   */
  federationRevokeKey: () =>
    req<{ previousInstanceId: string; newInstanceId: string; newFingerprint: string; notified: number; unreachable: number }>(
      'POST',
      '/admin/federation/revoke-key',
      { confirm: true },
    ),
  federationRebindCode: (instanceId: string) =>
    req<{ code: string; expiresAt: number }>('POST', `/admin/federation/links/${instanceId}/rebind-code`),
  federationLink: (code: string) => req<{ instanceId: string; state: string }>('POST', '/admin/federation/link', { code }),
  /** Перепривязка: код новой личности соседа вставляется на карточке ЕГО связки, не в общее поле (F-01). */
  federationRebind: (instanceId: string, code: string) =>
    req<{ instanceId: string; state: string }>('POST', `/admin/federation/links/${instanceId}/rebind`, { code }),
  federationConfirm: (instanceId: string) =>
    req<{ state: string }>('POST', `/admin/federation/links/${instanceId}/confirm`),
  federationLinkAction: (instanceId: string, action: 'pause' | 'resume' | 'block') =>
    req<{ state: string }>('POST', `/admin/federation/links/${instanceId}/${action}`),
  /**
   * Предел места под файлы гостей связки и счётчик занятого (§5.10). `bytes` — новый предел
   * (`0` — без предела), `reset` — обнулить счётчик; можно вместе.
   */
  federationSetQuota: (instanceId: string, body: { bytes?: number; reset?: boolean }) =>
    req<{ used: number; limit: number }>('PATCH', `/admin/federation/links/${instanceId}/quota`, body),
  /** Каталоги соседей для вкладок «Пользователи» и «Серверы» — кеш со словами о свежести (F2). */
  federationDirectory: () => req<FederationDirectoryView>('GET', '/admin/federation/directory'),
  // ---- Запреты на инстанс и жалобы (§5.11) ------------------------------------------------------
  federationBans: () => req<{ bans: FederationBanRow[] }>('GET', '/admin/federation/bans'),
  /**
   * Запретить чужому человеку вход на весь инстанс. Ключ — ГЛОБАЛЬНАЯ личность: запретить можно и
   * того, кто ни разу не заходил, а переживает запрет и разрыв связки, и перепривязку.
   */
  federationBan: (b: {
    instanceId: string;
    userId: string;
    reason?: string;
    days: number | null;
    report?: boolean;
    evidence?: { text: string; at: number; channel: string }[];
  }) =>
    req<{ ok: true; servers: number; report: { sent: boolean; problem?: string } }>('POST', '/admin/federation/bans', {
      instance_id: b.instanceId,
      user_id: b.userId,
      reason: b.reason,
      days: b.days,
      report: b.report,
      evidence: b.evidence,
    }),
  federationUnban: (instanceId: string, userId: string) =>
    req<{ ok: true }>('DELETE', `/admin/federation/bans/${instanceId}/${userId}`),
  /** Контакты держателя соседа — показываем там, где жалобу отправить нельзя и надо писать руками. */
  federationPeerContacts: (instanceId: string) =>
    req<{ contacts: { kind: string; label: string; value: string }[] }>(
      'GET',
      `/admin/federation/links/${instanceId}/contacts`,
    ),
  federationReports: () => req<{ reports: FederationReportRow[] }>('GET', '/admin/federation/reports'),
  /** Журнал федерации (F-25): события связок, гостей и потери доверия — последние 200. */
  federationAudit: () => req<{ entries: FederationAuditRow[] }>('GET', '/admin/federation/audit'),
  federationReplyReport: (id: string, text: string) =>
    req<{ ok: true }>('POST', `/admin/federation/reports/${id}/reply`, { text }),
  /** «Синхронизировать сейчас» — всегда полная сверка, дельта расхождения не находит. */
  federationSyncNow: (instanceId: string) =>
    req<{ directory: { ok: boolean; problem?: string }; servers: { ok: boolean; problem?: string } }>(
      'POST',
      `/admin/federation/links/${instanceId}/sync`,
    ),
  /**
   * Попросить ХОСТ подготовить аватар человека с соседнего инстанса и отдать адрес в нашем хранилище.
   * 🔴 Никогда не берём картинку с чужого домена напрямую: браузер оставил бы там наш адрес.
   */
  federationPeerAvatar: (instanceId: string, userId: string) =>
    req<{ url: string }>('POST', `/fed/avatar/${instanceId}/${userId}`),

  // ---- Федерация: человек, а не держатель (F4, §4.2.1 и §5.5) ----------------------------------
  /**
   * Проверить вставленную ссылку. 🔴 Спрашиваем СВОЙ бэкенд: к чужому инстансу клиент до согласия
   * человека не ходит вовсе — иначе его адрес уезжал бы туда от одного взгляда на ссылку.
   */
  fedInvitePreview: (url: string) => req<InvitePreviewView>('POST', '/fed/invite-preview', { url }),
  /** Попросить дом поручиться за нас перед хостом. Токен живёт 2 минуты и годен только этому хосту. */
  fedIdentityToken: (instanceId: string) =>
    req<{ token: string; expires_at: number }>('POST', '/fed/identity-token', { instance_id: instanceId }),
  /** «Где я гость» — по индексу членств СВОЕГО инстанса: он знает это и на новом устройстве. */
  fedMyGuest: () => req<GuestPlacesView>('GET', '/fed/my-guest'),
  adminGetSmtp: () => req<SmtpSettings>('GET', '/admin/smtp'),
  adminSetSmtp: (s: { host: string; port: number; secure: boolean; user: string; pass?: string; from: string }) =>
    req<{ ok: boolean; cleared?: boolean }>('PUT', '/admin/smtp', s),
  adminTestSmtp: (to: string) => req<{ ok: boolean }>('POST', '/admin/smtp/test', { to }),

  // ---- Инстанс и мастер первичной настройки (#142) ----------------------------------------------
  /** Публично, без входа: название, иконка, политика регистрации. */
  instance: () => req<InstanceInfo>('GET', '/instance'),
  /** Публично: что предложить на странице `/i/<код>` тому, кто ещё не вошёл (§4.2.2). */
  inviteOpen: (code: string) =>
    req<{ known: boolean; peers: { name: string; clientOrigin: string }[] }>('GET', `/invites/${encodeURIComponent(code)}/open`),
  setupStatus: () => req<SetupStatus>('GET', '/setup/status'),
  setupCheckToken: (token: string) => req<void>('POST', '/setup/check-token', { token }),
  setupAdmin: (b: { token: string; username: string; email: string; password: string; displayName?: string }) =>
    req<AuthResponse>('POST', '/setup/admin', b),
  setupComplete: () => req<{ ok: boolean }>('POST', '/setup/complete'),
  setupVoiceTest: () => req<VoiceTestToken>('POST', '/setup/voice-test'),
  adminInstance: () => req<AdminInstanceSettings>('GET', '/admin/instance'),
  adminSetInstance: (b: {
    name?: string | null;
    registration?: RegistrationPolicy;
    dmPolicy?: DmPolicy;
    fedDmPolicy?: 'shared' | 'anyone';
  }) =>
    req<{ ok: boolean }>('PUT', '/admin/instance', b),
  adminDeleteInstanceIcon: () => req<{ ok: boolean }>('DELETE', '/admin/instance/icon'),
  adminInstanceUpdate: (refresh = false) =>
    req<InstanceUpdateInfo>('GET', `/admin/instance/update${refresh ? '?refresh=1' : ''}`),
  adminStartInstanceUpdate: (version: string) => req<{ ok: boolean }>('POST', '/admin/instance/update', { version }),
  adminUploadInstanceIcon: async (file: File): Promise<{ iconUrl: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await t.upload(`/admin/instance/icon`, fd);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { iconUrl: string };
  },
};
}

export type Api = ReturnType<typeof makeApi>;

export const api = makeApi(activeTransport);

const recordApis = new Map<string, Api>();
const viaApis = new Map<string, Api>();

/**
 * Клиент по долгой сессии на инстансе собеседника (Э5): `POST /conv/:id/messages` (текст и ответ), `GET` истории беседы.
 * Ответы НЕ пишутся в стор прямо (чужие номера `pts`) — их сводит `convStore` отдельным путём (`applyViaPage`).
 */
export function apiVia(session: ConvFallbackSession): Api {
  const key = `${session.apiBase}|${session.token}`;
  let a = viaApis.get(key);
  if (!a) {
    if (viaApis.size > 16) viaApis.clear();
    a = makeApi(viaTransport(session));
    viaApis.set(key, a);
  }
  return a;
}

/**
 * Клиент, привязанный к записи реестра (01.10): админка дома из гостей, голос своего инстанса, пока на экране другой.
 * 🔴 Его ответы НЕ пишутся в стор активного инстанса — поколения у него нет, и ответ «прежнего» инстанса после
 * перехода попал бы в стор нового. Результат — в состояние компонента или в голос.
 */
export function apiFor(localId: string): Api {
  let a = recordApis.get(localId);
  if (!a) {
    a = makeApi(recordTransport(localId));
    recordApis.set(localId, a);
  }
  return a;
}
