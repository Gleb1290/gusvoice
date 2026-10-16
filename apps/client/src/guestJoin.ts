import { FED_ERRORS, type GuestPlacesView, type InvitePreviewView } from '@gusvoice/shared';
import { api } from './api';
import {
  addInstance,
  activeInstance,
  fetchDiscovery,
  instances,
  updateInstance,
  type Instance,
} from './config';
import { findGuestEntry, guestEntryRebound, homeEntry, usableGuestEntry } from './configRules';
import { switchInstance } from './instanceSwitch';

/**
 * Гость уходит с устройства без ответа хоста (15.10) — `guestGone.ts`; выставлено и отсюда, из модуля «гость», чтобы рейл и
 * «Где я гость» брали всё гостевое из одного места.
 */
export { dismissGuestGroup, dropGoneGuests, hostSilent, onGuestEntriesChanged, sweepOtherHomes } from './guestGone';

/**
 * Предел ожидания хоста (15.10): мёртвый сосед за «чёрной дырой» держал соединение минутами, и кнопки «Где я гость»
 * висели вместе с ним. Запросы здесь короткие (JSON), 20 с хватает с запасом.
 */
const HOST_FETCH_TIMEOUT_MS = 20_000;

/**
 * Вход гостем на сервер чужого инстанса (#139, F4, план §5.5).
 *
 * Порядок ровно такой и другим быть не может:
 *  1. **дом ручается** — `POST /fed/identity-token`: токен на 2 минуты и только этому хосту;
 *  2. **хост заводит гостевую сессию** — `POST /fed/v1/session`: проверяет подпись дома, заводит
 *     теневую строку и отдаёт СВОЙ обычный токен;
 *  3. **вступление по ссылке** — обычный `POST /invites/:code`, но уже токеном хоста.
 *
 * 🔴 К хосту мы идём ТОЛЬКО с этого шага. До нажатия «Войти» ссылку проверял дом (§4.2.1) — так
 * адрес человека не уходит к чужому инстансу от одного взгляда на присланную ссылку.
 *
 * 🔴 Шаг 1 пропускается, когда гостевая сессия на этом хосте уже есть. Дело не в экономии запроса:
 * поручительство дома нужно, только чтобы ПОЗНАКОМИТЬСЯ. Дальше гость живёт на хосте сам, и
 * требовать дом на каждое вступление значило бы, что при лежащем доме гость не может зайти на
 * второй сервер того же хоста, — а §5.6 обещает обратное.
 */

export interface GuestJoinResult {
  /** Локальный `id` записи реестра, в которой человек теперь гость. */
  instanceId: string;
  serverId: string;
  serverName: string;
}

/** Ошибка с кодом отказа федерации внутри — окно показывает её тем же текстом, что и предпросмотр. */
export class GuestJoinError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

async function hostFetch(apiUrl: string, path: string, init: RequestInit & { token?: string }): Promise<unknown> {
  const res = await fetch(`${apiUrl}/api${path}`, {
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? { signal: AbortSignal.timeout(HOST_FETCH_TIMEOUT_MS) }
      : {}),
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (data as { error?: unknown }).error;
    // ⚠️ Отказ хоста мы НЕ пересказываем своими словами здесь: коды стабильны (`FED_ERRORS`), текст
    // подбирает одно место — `inviteCheckRules`. Иначе у одной причины завелось бы две формулировки.
    throw new GuestJoinError(typeof code === 'string' ? code : `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Спросить «Где я гость» у ДОМА, даже когда мы сейчас стоим у соседа (§5.7).
 *
 * 🔴 Индекс членств ведёт дом, и только он. Активный инстанс у гостя — чужой, и `api.fedMyGuest()`
 * спрашивает именно его: тот про членства этого человека не знает ничего и честно отвечает пустым
 * списком. На стенде 19.09 это выглядело так: человек сидит гостем на сервере соседа, открывает
 * «Где я гость» — и читает «Вы пока нигде не гость».
 *
 * ⚠️ Стоя дома, идём обычным путём (`api.fedMyGuest`): там и токен свежее, и поколение запросов
 * учтено. Ходим на сторону только когда дом — не активная запись.
 */
export async function fetchGuestPlaces(): Promise<GuestPlacesView> {
  const active = activeInstance();
  if (!active?.guestOf) return api.fedMyGuest();
  const home = homeInstance();
  if (!home?.token) return api.fedMyGuest();
  return (await hostFetch(home.apiUrl, '/fed/my-guest', { method: 'GET', token: home.token })) as GuestPlacesView;
}

/** Дом человека, где бы он сейчас ни стоял (`configRules.homeEntry`, #205). */
export function homeInstance(): Instance | null {
  return homeEntry(instances(), activeInstance()?.id ?? null);
}

/**
 * Запрос к ДОМУ (#205). Стоя дома — обычным `api` (там поколение запросов и свежий токен), в гостях —
 * прямо к дому его токеном: активная запись тут чужая, и `api` спросил бы соседа.
 */
async function atHome<T>(viaApi: () => Promise<T>, path: string, init: RequestInit): Promise<T> {
  if (!activeInstance()?.guestOf) return viaApi();
  const home = homeInstance();
  if (!home?.token) throw new GuestJoinError('no-home');
  return (await hostFetch(home.apiUrl, path, { ...init, token: home.token })) as T;
}

/** Проверить ссылку-приглашение у своего дома (§4.2.1) — даже стоя гостем у соседа. */
export function homeInvitePreview(url: string): Promise<InvitePreviewView> {
  return atHome(() => api.fedInvitePreview(url), '/fed/invite-preview', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

/** Поручительство дома перед хостом (шаг 1 входа гостем). */
function homeIdentityToken(instanceId: string): Promise<{ token: string; expires_at: number }> {
  return atHome(() => api.fedIdentityToken(instanceId), '/fed/identity-token', {
    method: 'POST',
    body: JSON.stringify({ instance_id: instanceId }),
  });
}

/**
 * Вступить по ссылке на сервер САМОГО дома, стоя гостем у соседа (#205). Обычный `api.acceptInvite`
 * отправил бы код соседу, которому он не принадлежит, — «invalid invite» и засчитанный промах.
 */
export async function acceptInviteAtHome(code: string): Promise<{ instanceId: string; serverId: string }> {
  const home = homeInstance();
  if (!home?.token) throw new GuestJoinError('no-home');
  const boot = (await hostFetch(home.apiUrl, `/invites/${encodeURIComponent(code)}`, {
    method: 'POST',
    token: home.token,
  })) as { server?: { id?: string } };
  return { instanceId: home.id, serverId: boot.server?.id ?? '' };
}

/**
 * Уже заведённая запись гостя на этом хосте (по `instance_id` федерации, а не по адресу).
 * Годность записи решает чистое правило `usableGuestEntry` — см. его про адрес, равный домашнему.
 *
 * ⚠️ Запасной поиск ПО ХОСТУ нужен для записей, заведённых до появления `federationInstanceId`:
 * без него такая запись не находится, заводится вторая, и в рейле появляются ДВЕ одинаковые группы
 * одного соседа — живая и мёртвая. Человек жмёт по мёртвой и получает «доступ не подтверждён»
 * (стенд 18.09).
 */
export function guestEntryFor(federationInstanceId: string, domain?: string): Instance | null {
  // Порядок поиска и почему `domain` записи — в `configRules.findGuestEntry` (стенд 23.09).
  return usableGuestEntry(findGuestEntry(instances(), federationInstanceId, domain), homeInstance());
}

/**
 * Найти адрес API хоста по его домену — и УБЕДИТЬСЯ, что попали именно к нему.
 *
 * 🔴 Одной визитки `/config.json` мало: она говорит, какой у этого сайта API, но не говорит, ЧЕЙ
 * это инстанс. Дальше мы отправим туда поручительство дома, подписанное нашей личностью, поэтому
 * прежде чем запомнить адрес, спрашиваем у него самого `instance_id` и сверяем с тем, к кому шли.
 * Не сошлось — отказ, а не «запомним и посмотрим»: именно молчаливое запоминание не того адреса
 * и дало на стенде запись гостя, указывающую на собственный дом (#152).
 */
async function discoverHost(origin: string, expectedInstanceId: string) {
  const cfg = await fetchDiscovery(origin);
  const doc = (await hostFetch(cfg.apiUrl, '/fed/v1/instance', { method: 'GET' })) as { instance_id?: unknown };
  if (doc.instance_id !== expectedInstanceId) throw new GuestJoinError('wrong-host');
  return cfg;
}

/**
 * Пройти весь путь и запомнить запись «гость на хосте через дом».
 *
 * ⚠️ Запись создаётся ДО вступления: вступление может не выйти (ссылку успели отозвать), а гостевая
 * сессия к этому моменту уже настоящая — выкидывать её значило бы заставить человека знакомиться
 * заново на следующей попытке.
 */
/**
 * Похож ли отказ хоста на «твой токен больше не годится».
 *
 * ⚠️ Список короткий и по строкам, а не по статусу: `hostFetch` отдаёт КОД из тела, статус до сюда
 * не доезжает, а протухший токен хост называет по-разному — своим `invalid token` из auth-слоя и
 * протокольным `federation.identity_invalid`.
 */
function isStaleToken(code: string): boolean {
  return code === 'invalid token' || code === FED_ERRORS.identityInvalid || code === 'HTTP 401';
}

export async function joinAsGuest(view: InvitePreviewView): Promise<GuestJoinResult> {
  const peer = view.instance;
  if (!peer) throw new GuestJoinError('bad-invite');
  // Дом, а не активная запись: стоя гостем у соседа, «домом» оказался бы сосед (#205).
  const home = homeInstance();
  if (!home) throw new GuestJoinError('no-home');

  const existing = guestEntryFor(peer.instanceId, peer.domain);
  let entry = existing;
  let hostToken = existing?.token ?? null;

  if (!entry) {
    // Адрес API хоста берём у самого хоста (`/config.json`), а не выводим из домена: у инстанса API
    // может жить на другом поддомене, и угадывание тут кончилось бы запросом в никуда.
    const cfg = await discoverHost(`https://${peer.domain}`, peer.instanceId);
    entry = addInstance(cfg, { name: peer.name?.trim() || peer.domain });
    updateInstance(entry.id, { federationInstanceId: peer.instanceId, guestOf: home.id, domain: peer.domain });
    hostToken = null;
  }

  /**
   * Завести сессию на хосте: дом выдаёт токен личности, хост меняет его на свой.
   * Вынесено в функцию, потому что зовётся ДВАЖДЫ — см. повтор на «invalid token» ниже.
   */
  async function mintSession(): Promise<string> {
    const identity = await homeIdentityToken(peer!.instanceId);
    const session = (await hostFetch(entry!.apiUrl, '/fed/v1/session', {
      method: 'POST',
      body: JSON.stringify({ token: identity.token }),
    })) as { user_id?: string; token?: string };
    if (!session.token) throw new GuestJoinError('bad-session');
    updateInstance(entry!.id, { token: session.token, userId: session.user_id, guestOf: home!.id });
    return session.token;
  }

  if (!hostToken) hostToken = await mintSession();

  const acceptInvite = (token: string) =>
    hostFetch(entry!.apiUrl, `/invites/${encodeURIComponent(view.code)}`, {
      method: 'POST',
      token,
    }) as Promise<{ server?: { id?: string; name?: string } }>;

  let boot: { server?: { id?: string; name?: string } };
  try {
    boot = await acceptInvite(hostToken);
  } catch (e) {
    /**
     * 🔴 Сохранённый токен хоста мог быть ОТОЗВАН, пока нас там не было: запрет на инстанс, «выйти
     * везде», смена пароля дома. Тогда вход по свежей ссылке упирался в «invalid token» — человек
     * видел отказ, хотя ссылка годная и пускать его снова разрешили. На стенде 19.09 так и вышло:
     * сняли запрет, дали ссылку — «Войти по этой ссылке не получилось (invalid token)».
     *
     * Заводим сессию заново и повторяем ОДИН раз: за человека ручается дом, и спрашивать его тут
     * не о чем. Второй такой же отказ — уже настоящий, его и показываем.
     */
    if (!(e instanceof GuestJoinError) || !isStaleToken(e.code)) throw e;
    hostToken = await mintSession();
    boot = await acceptInvite(hostToken);
  }

  return {
    instanceId: entry.id,
    serverId: boot.server?.id ?? '',
    serverName: boot.server?.name ?? view.server?.name ?? '',
  };
}

/**
 * Перейти в запись реестра — свою или гостевую.
 *
 * ⚠️ Раньше назывался `openGuestInstance` и звался только из гостевых мест. Имя сменилось вместе со
 * смыслом: рейл ходит этой дорогой в ЛЮБОЙ инстанс, в том числе обратно домой, — отдельной кнопки
 * «вернуться в свой инстанс» больше нет (§5.7).
 * ⚠️ Перезапуска здесь больше нет: переход мягкий, вся разборка и сборка — в `instanceSwitch.ts`.
 */
export async function openInstance(localId: string): Promise<void> {
  await switchInstance(localId);
}

/**
 * Гостевая сессия на хосте — взять готовую или завести новую.
 *
 * 🔴 Завести новую можно С ЛЮБОГО устройства и в любой момент, потому что ручается дом, а не
 * запомненный токен. Ровно это и делает «Где я гость» работающим экраном, а не списком: человек
 * открыл приложение на новом ноутбуке и вышел с чужого сервера, куда заходил с телефона.
 */
export async function ensureGuestSession(place: {
  instanceId: string;
  name: string | null;
  domain: string;
  clientOrigin: string;
}): Promise<{ entry: Instance; token: string }> {
  const home = homeInstance();
  if (!home) throw new GuestJoinError('no-home');

  let entry = guestEntryFor(place.instanceId, place.domain);
  if (!entry) {
    const origin = place.clientOrigin || `https://${place.domain}`;
    const cfg = await discoverHost(origin, place.instanceId);
    entry = addInstance(cfg, { name: place.name?.trim() || place.domain });
    updateInstance(entry.id, { federationInstanceId: place.instanceId, guestOf: home.id, domain: place.domain });
    entry = instances().find((i) => i.id === entry!.id) ?? entry;
  } else if (!entry.federationInstanceId || !entry.domain || guestEntryRebound(entry, place.instanceId)) {
    // Нашли СТАРУЮ запись — дописываем ей то, чего не хватало. Иначе она так и останется
    // несопоставимой, и рядом каждый раз будет заводиться вторая. Хост сменил ключ — запись та же,
    // личность новая, а сессия прежней личности мертва: берём новую сразу (`guestEntryRebound`).
    const rebound = guestEntryRebound(entry, place.instanceId);
    updateInstance(entry.id, {
      federationInstanceId: place.instanceId,
      domain: place.domain,
      guestOf: home.id,
      ...(rebound ? { token: null } : {}),
    });
    entry = instances().find((i) => i.id === entry!.id) ?? entry;
  }
  if (entry.token) return { entry, token: entry.token };

  const identity = await homeIdentityToken(place.instanceId);
  const session = (await hostFetch(entry.apiUrl, '/fed/v1/session', {
    method: 'POST',
    body: JSON.stringify({ token: identity.token }),
  })) as { user_id?: string; token?: string };
  if (!session.token) throw new GuestJoinError('bad-session');
  updateInstance(entry.id, { token: session.token, userId: session.user_id, guestOf: home.id });
  return { entry, token: session.token };
}

/**
 * «Выйти со всех серверов этого инстанса» (§5.7).
 *
 * ⚠️ Уходим ПО ОДНОМУ и молча пропускаем отказы: членства могло уже не быть (кикнули, пока окно
 * было открыто), и падать на этом значило бы не дать человеку выйти с остальных серверов.
 * Владельцем сервера гость быть не может (§5.8), так что гарда «владельцу уходить некуда» здесь
 * не встретится.
 */
export async function leaveAllOn(
  place: { instanceId: string; name: string | null; domain: string; clientOrigin: string },
  serverIds: string[],
): Promise<void> {
  const { entry, token } = await ensureGuestSession(place);
  for (const serverId of serverIds) {
    try {
      await hostFetch(entry.apiUrl, `/servers/${encodeURIComponent(serverId)}/leave`, { method: 'POST', token });
    } catch {
      /* уже не участник — считаем, что цель достигнута */
    }
  }
}

/**
 * «Завершить сессию на этом инстансе» (§5.7).
 *
 * 🔴 Сначала просим ХОСТ поднять поколение (тогда умрут и те сессии, что остались на других
 * устройствах), и только потом забываем токен у себя. В обратном порядке мы бы всего лишь перестали
 * видеть свою сессию, а она продолжила бы работать — это ровно та разница, из-за которой кнопка и
 * называется «завершить», а не «забыть».
 */
export async function endGuestSession(place: {
  instanceId: string;
  name: string | null;
  domain: string;
  clientOrigin: string;
}): Promise<void> {
  const { entry, token } = await ensureGuestSession(place);
  await hostFetch(entry.apiUrl, '/fed/guest-session/end', { method: 'POST', token });
  updateInstance(entry.id, { token: null });
}
