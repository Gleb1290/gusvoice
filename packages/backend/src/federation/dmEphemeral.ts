/**
 * ЛС между инстансами, этап Э4 (#141, признак связки `dm3`): «печатает» и «в сети / был(а) в сети» с людьми соседа.
 * Провод — `shared/federation/ephemeral.ts`, маршрут приёма — `routes/fedEphemeral.ts`, план — `docs/dm/FEDERATION.md` §3, §4 п.3–4.
 *
 * Мгновенное: без журнала, номера и очереди (как EDU в Matrix). Не дошло — не страшно: «печатает» повторится через 3 с,
 * «в сети» — отметкой «жив» через минуту. Соседу без `dm3` ничего не шлём (тихо).
 *
 * Отправка (крючки шлюза `configureGatewayFed`):
 * - `typing` — наш человек печатает в беседе 1:1 с человеком соседа → его дому, не чаще раза в `FED_TYPING_RESEND_MS` на
 *   (беседа, человек, вид); наш человек его заблокировал — не шлём;
 * - `presence` — «в сети для ЛС» нашего человека сменилось (`isUserDmPresent`) → домам соседей, с людьми которых у него ЛС,
 *   после успокоения `PRESENCE_SETTLE_MS` (мигание вкладки не уходит соседу), плюс «жив» раз в `FED_PRESENCE_ALIVE_MS`, пока он
 *   в сети. Время захода — ОТДЕЛЬНО для каждого собеседника по правилам нашего человека (`sharesLastSeen`: правило + исключения;
 *   «Невидимый» на ЛС не влияет — `presence4`); скрыто → только «недавно». Заблокированному им — ничего.
 *
 * Приём (`acceptEphemeral`): запись только о человеке ДОМА-ОТПРАВИТЕЛЯ (`user.instance_id` = связка) и только если у нас есть его
 * теневая строка. `typing` → `relayFedTyping` (тот же путь, что местное: участник беседы, блокировка, показ, предел).
 * `presence` → `setRemoteDmPresence` (онлайн как у местного) + время захода по зрителю для `lastSeen.ts` (`remoteLastSeenFor`).
 * Устаревание: «в сети» без подтверждения дольше `FED_PRESENCE_STALE_MS` → «не в сети» с последним временем.
 * Перезапуск (исправление живой проверки 12.10): приём — копия записей в Redis (`EphemeralStore`, `dmEphemeralStore.ts`), при запуске
 * поднимается обратно (`online` = нет); отправка — `resendPresence` (проход при запуске и при `onLinkRestored`).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  FED_EPHEMERAL_PATH,
  FED_FEATURES,
  FED_PRESENCE_ALIVE_MS,
  FED_PRESENCE_STALE_MS,
  FED_TYPING_RESEND_MS,
  FED_TYPING_TTL_MS,
  parseEphemeralWire,
  parseTypingAction,
  serializeEphemeralWire,
  type FedEphemeralWire,
  type FedPresenceView,
  type LastSeenApprox,
} from '@gusvoice/shared';
import { isBlockedBy } from '../blocks.js';
import { db } from '../db/index.js';
import { federationLinks, lastSeenExceptions, users } from '../db/schema.js';
import { isUserDmPresent, relayFedTyping, setRemoteDmPresence } from '../gateway.js';
import { exceptionOf, normalizeLastSeenPrivacy, sharesLastSeen } from '../lastSeenRules.js';
import { refreshCapabilities } from './directorySync.js';
import { shadowUserFor } from './guestHost.js';
import { federation } from './instance.js';
import type { StoredLink } from './linkService.js';
import { postSignedToPeer } from './peerClient.js';

/** Сколько ждать, пока «в сети» успокоится, прежде чем сказать соседям (вкладку свернули и тут же вернули). */
const PRESENCE_SETTLE_MS = 2_000;
/** Опоздавшее «печатает» (часы соседа + сеть) старше этого — уже не показываем. */
const TYPING_LATE_MS = 30_000;
/** Кеш «чей это человек» (дом теневой строки) и «умеет ли связка `dm3`». */
const CACHE_MS = 5 * 60_000;
/** Человек без собеседников с других инстансов — сколько не перепроверять его при «жив». */
const NO_PEERS_RECHECK_MS = 10 * 60_000;

// ─── Связки ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const homeCache = new Map<string, { at: number; home: string | null; homeUserId: string | null }>();

async function homeOf(userId: string): Promise<{ home: string | null; homeUserId: string | null }> {
  const hit = homeCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const [row] = await db.select({ home: users.homeInstanceId, homeUserId: users.homeUserId }).from(users).where(eq(users.id, userId)).limit(1);
  if (homeCache.size > 20_000) homeCache.clear();
  const v = { at: Date.now(), home: row?.home ?? null, homeUserId: row?.homeUserId ?? null };
  homeCache.set(userId, v);
  return v;
}

const linkCache = new Map<string, { at: number; link: StoredLink | null }>();

/** Рабочая связка с домом `instanceId`, объявившая `dm3`; иначе `null` (визитка перечитывается не чаще раза в час — общий счётчик). */
async function dm3Link(instanceId: string): Promise<StoredLink | null> {
  const hit = linkCache.get(instanceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.link;
  const [row] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  let link: StoredLink | null = null;
  if (row && row.state === 'active') {
    const features = row.features.includes(FED_FEATURES.dm3) ? row.features : await refreshCapabilities(row, Date.now()).catch(() => row.features);
    if (features.includes(FED_FEATURES.dm3)) link = row as unknown as StoredLink;
  }
  linkCache.set(instanceId, { at: Date.now(), link });
  return link;
}

/** Отправить соседу одну запись мгновенного канала. Ошибки глотаются: потерялось — не страшно. */
async function post(link: StoredLink, e: FedEphemeralWire): Promise<boolean> {
  const key = federation.signingKey();
  const self = federation.identity();
  if (!key || !self) return false;
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return false;
  }
  const res = await postSignedToPeer({
    apiBase: link.apiBase,
    path: `/api${FED_EPHEMERAL_PATH}`,
    payload: serializeEphemeralWire(self.instanceId, e),
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
  });
  // Маршрута нет (сосед выключил ЛС, визитка устарела) — забыть связку из кеша, перечитаем через `CACHE_MS`.
  if (res.ok && res.value.status === 404) linkCache.set(link.instanceId, { at: Date.now(), link: null });
  return res.ok && res.value.status >= 200 && res.value.status < 300;
}

// ─── Отправка: «печатает» ────────────────────────────────────────────────────────────────────────────────────────────

const typingSentAt = new Map<string, number>();

/** Крючок шлюза: наш `senderId` печатает в беседе `dmId`, у собеседника `peerId` нет соединений здесь. */
export function fedTyping(dmId: string, senderId: string, peerId: string, action: string): void {
  void sendTyping(dmId, senderId, peerId, action).catch(() => {});
}

async function sendTyping(dmId: string, senderId: string, peerId: string, rawAction: string): Promise<void> {
  const action = parseTypingAction(rawAction);
  const key = `${dmId}:${senderId}:${action}`;
  const now = Date.now();
  if (now - (typingSentAt.get(key) ?? 0) < FED_TYPING_RESEND_MS) return;
  const peer = await homeOf(peerId);
  if (!peer.home) return; // местный собеседник просто не в сети
  const sender = await homeOf(senderId);
  if (sender.home) return; // от имени чужого человека не говорим
  // Наш человек заблокировал собеседника — ему ничего (заблокировавший нас сосед отсечёт у себя).
  if (await isBlockedBy(senderId, peerId)) return;
  const link = await dm3Link(peer.home);
  const self = federation.identity();
  if (!link || !self) return;
  if (typingSentAt.size > 20_000) typingSentAt.clear();
  typingSentAt.set(key, now);
  await post(link, {
    kind: 'typing',
    conversationId: dmId,
    user: { instanceId: self.instanceId, userId: senderId },
    action,
    until: now + FED_TYPING_TTL_MS,
    stop: false,
  });
}

// ─── Отправка: «в сети / был(а)» ─────────────────────────────────────────────────────────────────────────────────────

const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Наши люди, о которых соседям сказано «в сети» (им идёт «жив»). */
const reportedOnline = new Set<string>();
/** Наши люди без собеседников с других инстансов — до какого времени не перепроверять. */
const noFedPeersUntil = new Map<string, number>();

/** Крючок шлюза: «в сети для ЛС» нашего `userId` сменилось. Соседям — после успокоения. */
export function fedPresence(userId: string, _online: boolean): void {
  const prev = settleTimers.get(userId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    settleTimers.delete(userId);
    void flushPresence(userId, false).catch(() => {});
  }, PRESENCE_SETTLE_MS);
  t.unref?.();
  settleTimers.set(userId, t);
}

/**
 * Приёмка 15.10: у нашего `userId` появилась беседа 1:1 с человеком дома `home` (`convOpen.configureFedConvOpened`). Память
 * «собеседников с других инстансов нет» (`noFedPeersUntil`, 10 мин) забывается, и его «в сети / был(а)» уходит этому дому после
 * успокоения (`PRESENCE_SETTLE_MS`: к этому времени у соседа есть теневая строка и беседа — ответ на `conv.open` дошёл). Не в сети —
 * время ухода из базы (`fromDb`), как после перезапуска. Без этого человек, вошедший ДО первой беседы, оставался у соседа «был(а)
 * …» с прошлого раза до первой смены «в сети» или минутного «жив» через 10 мин, а шапка беседы по его действиям показывала «в сети».
 */
export function fedPeerAdded(userId: string, home: string): void {
  noFedPeersUntil.delete(userId);
  const t = setTimeout(() => {
    if (settleTimers.has(userId)) return; // смена «в сети» уже в пути — она и скажет (и этому дому)
    void flushPresence(userId, false, { onlyHome: home, fromDb: true }).catch(() => {});
  }, PRESENCE_SETTLE_MS);
  t.unref?.();
}

interface FedPeerRow {
  peer: string;
  home: string;
  home_user: string;
}

/** Собеседники `userId` в действующих беседах 1:1 — люди других инстансов (теневые строки). */
async function fedPeersOf(userId: string): Promise<FedPeerRow[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT p.user_id AS peer, u.home_instance_id AS home, u.home_user_id AS home_user
      FROM conversation_members m
      JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
      JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id <> m.user_id
      JOIN users u ON u.id = p.user_id AND u.home_instance_id IS NOT NULL AND u.home_user_id IS NOT NULL
     WHERE m.user_id = ${userId}`);
  return res.rows as unknown as FedPeerRow[];
}

/**
 * Повторная рассылка после перезапуска / восстановления связки (`resendPresence`): `onlyHome` — только этому дому; `fromDb` — не
 * в сети → время ухода берём из `users.last_seen_at` (шлюз пишет его на входе и выходе), а не «сейчас»; нет отметки — молчим.
 */
interface FlushOpts {
  onlyHome?: string;
  fromDb?: boolean;
  /**
   * F5 (приёмка 13.10): вызвано сменой блокировки (`fedBlockChanged`). Все собеседники с дома `onlyHome` заблокированы нашим
   * человеком — дому одна запись «не в сети» без видов: там он гаснет сразу, а «был(а)» у заблокированного — «давно» (зрителя
   * дом не назвал, `remoteLastSeenFor`). Без флага такой дом, как раньше, ничего не получает (и «жив» ему не идёт).
   */
  blockNotice?: boolean;
}

/**
 * Сказать домам собеседников, в сети ли наш `userId` сейчас. `alive` — повтор «жив» (без собеседников проверка реже).
 * Время захода не читаем из базы: отметка уходит на смене состояния и раз в минуту, так что «был(а)» = сейчас.
 */
async function flushPresence(userId: string, alive: boolean, opts: FlushOpts = {}): Promise<void> {
  const online = isUserDmPresent(userId);
  if (online) reportedOnline.add(userId);
  else reportedOnline.delete(userId);
  const now = Date.now();
  if (alive && (noFedPeersUntil.get(userId) ?? 0) > now) return;
  const self = federation.identity();
  if (!self) return;
  const [me] = await db
    .select({ privacy: users.lastSeenPrivacy, home: users.homeInstanceId, deletedAt: users.deletedAt, lastSeenAt: users.lastSeenAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!me || me.home || me.deletedAt) return;
  const peers = (await fedPeersOf(userId)).filter((p) => !opts.onlyHome || p.home === opts.onlyHome);
  if (peers.length === 0) {
    if (opts.onlyHome) return;
    if (noFedPeersUntil.size > 20_000) noFedPeersUntil.clear();
    noFedPeersUntil.set(userId, now + NO_PEERS_RECHECK_MS);
    return;
  }
  noFedPeersUntil.delete(userId);
  // Исключения нашего человека про этих собеседников — одним запросом.
  const ex = await db
    .select({ target: lastSeenExceptions.targetId, kind: lastSeenExceptions.kind })
    .from(lastSeenExceptions)
    .where(and(eq(lastSeenExceptions.ownerId, userId), inArray(lastSeenExceptions.targetId, peers.map((p) => p.peer))));
  const exceptions = { always: new Set<string>(), never: new Set<string>() };
  for (const r of ex) exceptions[r.kind].add(r.target);
  const privacy = normalizeLastSeenPrivacy(me.privacy);
  // Вышел — время ухода, а не конца успокоения (`PRESENCE_SETTLE_MS` назад); в сети / «жив» — сейчас.
  let seenAt = online || alive ? now : now - PRESENCE_SETTLE_MS;
  if (opts.fromDb && !online && !alive) {
    if (!me.lastSeenAt) return; // не заходил — сказать нечего
    seenAt = Math.min(me.lastSeenAt.getTime(), now);
  }
  const byHome = new Map<string, FedPresenceView[]>();
  const blockedHomes = new Set<string>();
  for (const p of peers) {
    if (await isBlockedBy(userId, p.peer)) {
      blockedHomes.add(p.home);
      continue;
    }
    // Собеседник по беседе — «свой» (`isPeer`); «Невидимый» на ЛС не влияет (`presence4`).
    const shares = sharesLastSeen(privacy, false, true, exceptionOf({ exceptions }, p.peer));
    const views = byHome.get(p.home) ?? [];
    // «Кто может мне писать» (`msgpriv1`): собеседник не проходит — пометка `noMessages` (поле только при `true`).
    const noMessages = messageGate !== null && !(await messageGate(p.peer, userId));
    views.push({
      user: { instanceId: p.home, userId: p.home_user },
      lastSeen: shares ? seenAt : null,
      approx: shares ? null : 'recently',
      ...(noMessages ? { noMessages: true as const } : {}),
    });
    byHome.set(p.home, views);
  }
  for (const [home, views] of byHome) {
    const link = await dm3Link(home);
    if (!link) continue;
    void post(link, { kind: 'presence', user: { instanceId: self.instanceId, userId }, online, at: now, views }).catch(() => {});
  }
  // F5: блок только что поставлен, и на этом доме остались одни заблокированные — погасить «в сети» там (старый сосед понимает ту же запись).
  if (opts.blockNotice && opts.onlyHome && blockedHomes.has(opts.onlyHome) && !byHome.has(opts.onlyHome)) {
    const link = await dm3Link(opts.onlyHome);
    if (link) void post(link, { kind: 'presence', user: { instanceId: self.instanceId, userId }, online: false, at: now, views: [] }).catch(() => {});
  }
}

/**
 * F5 (приёмка 13.10, как Telegram: заблокированный видит «был(а) давно», а не «в сети»): крючок `blocks.onBlockChange` (ставит
 * `index.ts` — без импорта: проверки исполняют модуль с закрытым перечнем зависимостей). Наш человек заблокировал (или
 * разблокировал) человека соседа — его дому сразу новая запись присутствия: при блоке заблокированный из видов пропадает, а
 * если на том доме больше некому — «не в сети» без видов (`FlushOpts.blockNotice`); при снятии — обычная запись с его видом.
 */
export function fedBlockChanged(blockerId: string, blockedId: string): void {
  void (async () => {
    const [u] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, blockedId)).limit(1);
    if (!u?.home) return;
    await flushPresence(blockerId, false, { onlyHome: u.home, blockNotice: true });
  })().catch(() => {});
}

/** Сколько наших людей обходим за один проход повторной рассылки (предел 600 записей/мин на связку у соседа). */
const RESEND_USERS_MAX = 400;

/**
 * Э4, исправление живой проверки 12.10: после перезапуска ЭТОГО инстанса (или когда связка с домом `onlyHome` снова рабочая) соседи
 * не знают, кто из наших людей не в сети: «жив» шлётся только сидящим, смена состояния не повторяется. Один проход: наши люди,
 * у которых есть ЛС 1:1 с людьми соседей (`onlyHome` — только с этого дома), по очереди → `flushPresence` (в сети — «жив»,
 * не в сети — «был(а)» из `users.last_seen_at`). Не по запросу на человека от каждого соседа: запись одна на (человек, дом).
 * Зовёт `index.ts`: через 20 с после запуска (клиенты успевают переподключиться — вернувшиеся уходят «в сети», а не «был(а)» на время
 * перезапуска) и при `onLinkRestored`.
 */
export async function resendPresence(onlyHome?: string): Promise<void> {
  const res = await db.execute(sql`
    SELECT DISTINCT m.user_id AS uid
      FROM conversation_members m
      JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
      JOIN conversation_members p ON p.conversation_id = c.id AND p.user_id <> m.user_id
      JOIN users me ON me.id = m.user_id AND me.home_instance_id IS NULL AND me.deleted_at IS NULL
      JOIN users u ON u.id = p.user_id AND u.home_instance_id IS NOT NULL AND u.home_user_id IS NOT NULL
       ${onlyHome ? sql`AND u.home_instance_id = ${onlyHome}` : sql``}
     LIMIT ${RESEND_USERS_MAX}`);
  for (const r of res.rows as unknown as { uid: string }[]) {
    if (settleTimers.has(r.uid)) continue; // смена уже в пути — она и скажет
    await flushPresence(r.uid, false, { onlyHome, fromDb: true }).catch(() => {});
  }
}

// ─── Приём ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface RemoteState {
  at: number;
  online: boolean;
  receivedAt: number;
  views: Map<string, { shares: boolean; lastSeenAt: Date | null }>;
}
/**
 * Теневая строка → последнее, что сказал о человеке его дом. Копия каждой принятой записи лежит в хранилище (`EphemeralStore`, Redis со
 * сроком 30 суток): после перезапуска `startDmEphemeral` поднимает её обратно, «был(а)» не пропадает до следующего захода человека.
 */
const remote = new Map<string, RemoteState>();

/**
 * Хранилище копии `remote` — крючок `index.ts` (`dmEphemeralStore.ts`, Redis), без импорта: модуль проверки исполняют с закрытым
 * перечнем зависимостей. Нет крючка — как до исправления (в памяти). `save` не бросает и не ждёт; `loadAll` — все сохранённые записи.
 */
export interface EphemeralStore {
  save(shadowId: string, json: string): void;
  loadAll(): Promise<[string, string][]>;
}
let ephemeralStore: EphemeralStore | null = null;
export function configureEphemeralStore(s: EphemeralStore | null): void {
  ephemeralStore = s;
}

/** Запись для хранилища: версия `at` и по зрителю `[id, shares, время мс | null]`. «В сети» не храним — после перезапуска без «жив» не покажем. */
function encodeRemote(st: RemoteState): string {
  const views: [string, boolean, number | null][] = [];
  for (const [viewer, v] of st.views) views.push([viewer, v.shares, v.lastSeenAt ? v.lastSeenAt.getTime() : null]);
  return JSON.stringify({ v: 1, at: st.at, views });
}

/** Обратное `encodeRemote`: `online` всегда `false`, `receivedAt` — сейчас. Негодная запись — `null`. */
function decodeRemote(raw: string, now: number): RemoteState | null {
  try {
    const o = JSON.parse(raw) as { v?: unknown; at?: unknown; views?: unknown };
    if (o.v !== 1 || typeof o.at !== 'number' || !Array.isArray(o.views)) return null;
    const views = new Map<string, { shares: boolean; lastSeenAt: Date | null }>();
    for (const row of o.views as unknown[]) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'boolean') continue;
      const ms = typeof row[2] === 'number' && Number.isFinite(row[2]) ? Math.min(row[2], now) : null;
      views.set(row[0], { shares: row[1], lastSeenAt: ms === null ? null : new Date(ms) });
    }
    return { at: o.at, online: false, receivedAt: now, views };
  } catch {
    return null;
  }
}

/** Поднять сохранённые записи в `remote` при запуске. Уже пришедшее новее (запись соседа успела раньше загрузки) не трогаем. */
async function restoreRemote(): Promise<void> {
  if (!ephemeralStore) return;
  const rows = await ephemeralStore.loadAll();
  const now = Date.now();
  for (const [id, raw] of rows) {
    if (remote.has(id) || remote.size > 50_000) continue;
    const st = decodeRemote(raw, now);
    if (st) remote.set(id, st);
  }
}

/** Представитель примерной категории: время не выдаётся (`shares: false`), из него `lastSeenView` выводит ту же категорию. */
function approxDate(approx: LastSeenApprox | null, now: number): Date | null {
  const DAY = 24 * 3600_000;
  if (approx === 'recently') return new Date(now);
  if (approx === 'week') return new Date(now - 5 * DAY);
  if (approx === 'month') return new Date(now - 15 * DAY);
  return null;
}

/**
 * «Кто может мне писать» (13.10, #218, `msgpriv1`). Отправка: `messageGate(senderId, recipientId)` — пускает ли наш человек
 * собеседника (`messagePrivacy.messageAllowedFor`; крючок `index.ts` — перечень зависимостей закрыт); нет крючка — поле не шлём.
 * Приём: теневая строка человека соседа → наши люди, которым его дом сказал `noMessages` (только в памяти: после перезапуска до
 * следующей записи его дома отказ решает сам дом получателя — сообщение ложится скрытым, `convAccept`).
 */
let messageGate: ((senderId: string, recipientId: string) => Promise<boolean>) | null = null;
export function configurePresenceMessagePrivacy(fn: ((senderId: string, recipientId: string) => Promise<boolean>) | null): void {
  messageGate = fn;
}
const remoteNoMessages = new Map<string, Set<string>>();

/** Крючок `routes/conv.configureRemoteMessageRefused`: дом человека соседа `subjectId` сказал, что `viewerId` писать ему нельзя. */
export function remoteMessageRefusedFor(subjectId: string, viewerId: string): boolean {
  return remoteNoMessages.get(subjectId)?.has(viewerId) === true;
}

/** Наш человек сменил «Кто может мне писать» или исключения — сказать домам собеседников сразу, а не с очередным «жив». */
export function announceMessagePrivacy(userId: string): void {
  void flushPresence(userId, false, { fromDb: !isUserDmPresent(userId) }).catch(() => {});
}

/** Крючок `lastSeen.configureRemoteLastSeen`: время захода человека соседа глазами нашего `viewerId`. */
export function remoteLastSeenFor(subjectId: string, viewerId: string): { shares: boolean; lastSeenAt: Date | null } | null {
  const st = remote.get(subjectId);
  if (!st) return null;
  // Зрителя дом не назвал (не собеседник, заблокирован) — ничего, кроме «давно».
  return st.views.get(viewerId) ?? { shares: false, lastSeenAt: null };
}

/**
 * Э7 часть 3 (#141, `dmgroup2`): «печатает» в группах со смешанным составом — крючки `federation/dmGroupTyping.ts` (ставит `index.ts`;
 * без импорта: модуль исполняют проверки с закрытым перечнем зависимостей). Нет крючков — как до части 3.
 */
export interface GroupTypingHooks {
  /** Запись о человеке ТРЕТЬЕГО инстанса — принять, если связка — хост группы. */
  accept(link: StoredLink, e: Extract<FedEphemeralWire, { kind: 'typing' }>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Хост: переслать «печатает» участника остальным домам (после показа своим). */
  forward(link: StoredLink, e: Extract<FedEphemeralWire, { kind: 'typing' }>, shadowId: string): Promise<void>;
}
let groupTyping: GroupTypingHooks | null = null;
export function configureGroupTyping(hooks: GroupTypingHooks | null): void {
  groupTyping = hooks;
}

/** `POST /fed/v1/ephemeral` от рабочей связки `link`. */
export async function acceptEphemeral(link: StoredLink, raw: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const e = parseEphemeralWire(raw);
  if (e === null) return { status: 400, body: { error: 'bad-request' } };
  if (e === 'unknown') return { status: 202, body: { ok: true, ignored: true } };
  // Э7 часть 3: «печатает» человека третьего инстанса — только от хоста группы (отдельная проверка; остальное — как раньше).
  if (e.kind === 'typing' && e.user.instanceId !== link.instanceId && groupTyping) return groupTyping.accept(link, e);
  // Говорить можно только о своих людях: дом отвечает за своих, чужих он не знает.
  if (e.user.instanceId !== link.instanceId) return { status: 403, body: { error: 'not-yours' } };
  const shadow = await shadowUserFor(link.instanceId, e.user.userId);
  if (!shadow || shadow.deletedAt) return { status: 202, body: { ok: true, ignored: true } };
  const now = Date.now();
  if (e.kind === 'typing') {
    if (!e.stop && e.until > now - TYPING_LATE_MS) await relayFedTyping(shadow.id, e.conversationId, e.action);
    // Э7 часть 3: мы хост группы — остальным домам участников (звезда; для 1:1 крючок молчит).
    if (!e.stop && e.until > now - TYPING_LATE_MS) void groupTyping?.forward(link, e, shadow.id).catch(() => {});
    return { status: 202, body: { ok: true } };
  }
  const prev = remote.get(shadow.id);
  if (prev && e.at <= prev.at) return { status: 202, body: { ok: true, ignored: true } };
  const self = federation.identity();
  const views = new Map<string, { shares: boolean; lastSeenAt: Date | null }>();
  for (const v of e.views) {
    if (!self || v.user.instanceId !== self.instanceId) continue;
    // Наш человек заблокировал собеседника — ему не показываем (как местного: точка и время у заблокированного не видны).
    if (await isBlockedBy(v.user.userId, shadow.id)) continue;
    views.set(
      v.user.userId,
      v.lastSeen !== null
        ? { shares: true, lastSeenAt: new Date(Math.min(v.lastSeen, now)) }
        : { shares: false, lastSeenAt: approxDate(v.approx, now) },
    );
  }
  if (remote.size > 50_000) remote.clear();
  // «Кто может мне писать» (`msgpriv1`): кому из наших его дом не даёт писать — заменяем целиком с каждой записью.
  const refused = new Set(e.views.filter((v) => v.noMessages && self && v.user.instanceId === self.instanceId).map((v) => v.user.userId));
  if (refused.size > 0) {
    if (remoteNoMessages.size > 50_000) remoteNoMessages.clear();
    remoteNoMessages.set(shadow.id, refused);
  } else remoteNoMessages.delete(shadow.id);
  const st: RemoteState = { at: e.at, online: e.online, receivedAt: now, views };
  remote.set(shadow.id, st);
  ephemeralStore?.save(shadow.id, encodeRemote(st));
  setRemoteDmPresence(shadow.id, e.online);
  return { status: 202, body: { ok: true } };
}

// ─── Таймеры ─────────────────────────────────────────────────────────────────────────────────────────────────────────

let started = false;

/**
 * Исправления ревью 12.10, п. 8: id теневых строк людей ДРУГИХ инстансов — синхронная проверка для шлюза (`isUserDmPresent`,
 * «печатает»): у теневого «в сети» и «печатает» — только от его дома, гостевые сокеты (он же гостем на нашем сервере) не в счёт.
 * Обновляется при старте и раз в минуту; заведённая между обновлениями — не дольше минуты по старым правилам.
 */
const shadowIds = new Set<string>();
async function refreshShadowIds(): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(sql`${users.homeInstanceId} IS NOT NULL`);
  shadowIds.clear();
  for (const r of rows) shadowIds.add(r.id);
}
export function isKnownShadow(userId: string): boolean {
  return shadowIds.has(userId);
}

/** Запустить «жив» (отправка) и устаревание (приём). Зовёт `index.ts` при `FEDERATION_DM_ENABLED`. */
export function startDmEphemeral(): void {
  if (started) return;
  started = true;
  void refreshShadowIds().catch(() => {});
  void restoreRemote().catch(() => {});
  // Тот же минутный такт обновляет и id теневых строк (`FED_PRESENCE_ALIVE_MS` = минута).
  const alive = setInterval(() => {
    void refreshShadowIds().catch(() => {});
    for (const uid of [...reportedOnline]) {
      if (settleTimers.has(uid)) continue; // смена уже в пути
      void flushPresence(uid, true).catch(() => {});
    }
  }, FED_PRESENCE_ALIVE_MS);
  alive.unref?.();
  const stale = setInterval(() => {
    const now = Date.now();
    for (const [id, st] of remote) {
      if (!st.online || now - st.receivedAt <= FED_PRESENCE_STALE_MS) continue;
      // Дом замолчал: «не в сети» с последним известным временем (последнее «жив» ≈ когда видели).
      st.online = false;
      setRemoteDmPresence(id, false);
    }
  }, 30_000);
  stale.unref?.();
}
