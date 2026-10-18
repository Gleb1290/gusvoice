/**
 * ЛС между инстансами, этап Э5 часть 1 (#141, `docs/dm/FEDERATION.md` §1.5, §1.6, §4 п. 1 (б), п. 5; провод и правила —
 * `shared/federation/convVia.ts`): «мой дом лежит — пишу через инстанс собеседника». Подключает `index.ts` при
 * `FEDERATION_DM_ENABLED` крючками (`configureFedVia` в `routes/conv.ts`, `configureFedViaRoutes` в `routes/federation.ts`):
 * те модули собираются проверками с явным перечнем зависимостей.
 *
 * Дом автора (A):
 * - `fallbackFor` — `GET /conv/:id/fallback`: заранее заводит своему человеку долгую сессию на инстансе собеседника тем же
 *   входом гостя (`issueIdentityFor` → `POST /fed/v1/session` соседа). Поручительство пишет `issueIdentityFor`, поэтому
 *   сосед попадает в `grantHostsOf`, и «выйти везде» / удаление аккаунта гасят сессию (`guestRevocation.ts`). Срок — обычная
 *   сессия хоста (`TOKEN_TTL_S`, 8 суток), повтор в течение суток отдаётся из кеша (Redis), поколение сессий — в ключе кеша.
 * - `acceptClaims` — `POST /conv/via-claims`: отчёт клиента «это я отправил в обход» (`client_id` + отпечаток).
 * - `reconcileVia` — забирает у соседа «через»-сообщения наших людей (`GET /fed/v1/conv/via`), сверяет с отчётом: совпало —
 *   принимает своим с той же `id` (дальше копия уходит обычным журналом, у соседа — повтор без изменений) и отвечает
 *   `confirmed`; лишнее — `rejected` + запись в журнал федерации; без отчёта 7 суток — `unverified`.
 *
 * Инстанс собеседника (B):
 * - `viaGate` — отправка человека соседа по долгой сессии: только текст/ответ в 1:1 с нашим человеком, только если у его
 *   дома `dm4`; сообщение ложится с `via_state = 'pending'`.
 * - `pendingFor` — `GET /fed/v1/conv/via` для дома автора; `applyVerdict` — решение дома (`conv.via_verdict`): подтвердить,
 *   «не подтверждено навсегда» или надгробие (+ «возможна подделка» держателю в журнал федерации).
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  FED_ERRORS,
  FED_FEATURES,
  FED_VIA_LIMITS,
  FED_VIA_PATH,
  FED_VIA_VERDICT_EVENT,
  parseConvMessageWire,
  parseGuestSession,
  parseViaClaims,
  parseViaPage,
  parseViaVerdict,
  serializeConvMessageWire,
  serializeViaPage,
  serializeViaVerdict,
  viaVerdictFor,
  type FedConvMessageWire,
  type FedViaVerdict,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { conversationMessages, conversations, federationLinks, fedViaClaims, fedViaPending, fedViaReports, users } from '../db/schema.js';
import {
  deleteMessage,
  deliver,
  journal,
  loadAccess,
  lockConversation,
  msgEntries,
  sendMessage,
  type ConvAccess,
} from '../conversations.js';
import { changeAudience, payloadHash } from '../convRules.js';
import { redisPub } from '../realtime.js';
import { safePeerRequest } from '../safeFetch.js';
import { fedAudit } from './auditLog.js';
import { onLinkRestored } from './convLink.js';
import { toWireMessage } from './convChanges.js';
import { onFedEvent, sendEventTo } from './eventStream.js';
import { issueIdentityFor } from './guestHome.js';
import { federation } from './instance.js';
import { readInstanceMeta } from './instanceMeta.js';
import { linkVerdict } from './linkRules.js';
import { getLink } from './links.js';
import { getSignedFromPeer } from './peerClient.js';
import { refreshCapabilities } from './directorySync.js';

/** Повтор `GET /conv/:id/fallback` в течение суток — та же сессия (не плодим токены личности на каждое открытие беседы). */
const FALLBACK_CACHE_S = 24 * 60 * 60;
/** Сверка с соседями с `dm4` — раз в 10 минут (и сразу после отчёта клиента, при старте, при восстановлении связки). */
const RECONCILE_EVERY_MS = 10 * 60 * 1000;

type Answer = { status: number; body: Record<string, unknown> };

// ─── Дом автора: долгая сессия ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Э7 часть 3 (#141, `dmgroup2`): дом-хост группы со смешанным составом, если группа чужая (`origin_instance_id`) — иначе `null`.
 * «Через» в группе — только к хосту: дома остальных участников с нашим не связаны (звезда), а если хост — мы, группа лежит вместе с домом.
 */
async function groupHostOf(conversationId: string): Promise<string | null> {
  const [c] = await db.select({ origin: conversations.originInstanceId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return c?.origin ?? null;
}

/** Инстанс собеседника беседы 1:1 моего человека (в группе — её хост) — или причина, почему «через» здесь нет. */
async function peerHomeOf(me: string, conversationId: string): Promise<{ access: ConvAccess; home: string; group?: true } | Answer> {
  const access = await loadAccess(conversationId, me);
  if (access && access.kind === 'group' && !access.saved) {
    const [mine] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, me)).limit(1);
    const host = await groupHostOf(conversationId);
    if (!mine || mine.home !== null || !host) return { status: 404, body: { error: 'not found' } };
    return { access, home: host, group: true };
  }
  if (!access || access.kind !== 'direct' || access.saved || !access.peerId) return { status: 404, body: { error: 'not found' } };
  const rows = await db
    .select({ id: users.id, home: users.homeInstanceId })
    .from(users)
    .where(inArray(users.id, [me, access.peerId]));
  const mine = rows.find((r) => r.id === me);
  const peer = rows.find((r) => r.id === access.peerId);
  // Только своему человеку и только в беседе с человеком соседа: местная беседа в обходе не нуждается.
  if (!mine || mine.home !== null || !peer?.home) return { status: 404, body: { error: 'not found' } };
  return { access, home: peer.home };
}

/**
 * `purpose` `call` (Э6, `GET /conv/:id/fallback?for=call`): та же сессия, но нужен признак звонков соседа (`dmcall1`), а не `dm4` —
 * приложение отвечает на звонок у инстанса звонящего (`/api/calls/:id/answer`).
 */
export async function fallbackFor(me: string, conversationId: string, now = Date.now(), purpose: 'via' | 'call' = 'via'): Promise<Answer> {
  const found = await peerHomeOf(me, conversationId);
  if ('status' in found) return found;
  if (found.group && purpose !== 'via') return { status: 404, body: { error: 'not found' } }; // звонков в группах нет
  const link = await getLink(found.home);
  if (!link) return { status: 409, body: { error: FED_ERRORS.noLink } };
  // Список признаков в строке связки сам не обновляется — перечитать визитку (не чаще раза в час, как у `dm1`/`dm2`).
  const able = purpose === 'call' ? await hasFeature(link, FED_FEATURES.dmcall1, now) : await hasDm4(link, now);
  if (!able) return { status: 409, body: { error: FED_ERRORS.unsupported } };
  // Группа (Э7 часть 3): хост обязан уметь `dmgroup2`.
  if (found.group && !(await hasFeature(link, FED_FEATURES.dmgroup2, now))) return { status: 409, body: { error: FED_ERRORS.unsupported } };
  const refusal = linkVerdict(link, (await readInstanceMeta()).paused);
  if (refusal) return { status: 409, body: { error: refusal } };

  const [u] = await db.select({ gen: users.tokenGeneration }).from(users).where(eq(users.id, me)).limit(1);
  // Поколение в ключе: после «выйти везде» прежняя сессия у соседа мертва, кеш её больше не отдаст.
  const cacheKey = `fed:fallback:${me}:${link.instanceId}:${u?.gen ?? 0}`;
  const cached = await redisPub.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return { status: 200, body: JSON.parse(cached) as Record<string, unknown> };
    } catch {
      /* испорчено — заведём заново */
    }
  }

  const issued = await issueIdentityFor({ userId: me, hostInstanceId: link.instanceId, now });
  if (!issued.ok) return { status: issued.problem === 'not-found' ? 404 : 409, body: { error: issued.problem } };
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return { status: 409, body: { error: FED_ERRORS.noLink } };
  }
  let res;
  try {
    res = await safePeerRequest({
      method: 'POST',
      url: `${link.apiBase.replace(/\/+$/, '')}/api/fed/v1/session`,
      body: JSON.stringify({ token: issued.token }),
      headers: { 'content-type': 'application/json' },
      allowHosts: new Set([host]),
    });
  } catch {
    return { status: 503, body: { error: FED_ERRORS.peerUnreachable } };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    /* не JSON */
  }
  if (res.status !== 200) {
    const code = parsed && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : 'peer-refused';
    return { status: res.status >= 500 ? 503 : 409, body: { error: code } };
  }
  const session = parseGuestSession(parsed);
  if (!session) return { status: 503, body: { error: FED_ERRORS.peerUnreachable } };
  const body = {
    instanceId: link.instanceId,
    apiBase: link.apiBase,
    userId: session.userId,
    token: session.token,
    expiresAt: session.expiresAt,
  };
  const ttl = Math.min(FALLBACK_CACHE_S, Math.floor((session.expiresAt - now) / 1000) - 60);
  if (ttl > 0) await redisPub.set(cacheKey, JSON.stringify(body), 'EX', ttl).catch(() => {});
  return { status: 200, body };
}

// ─── Дом автора: отчёт клиента и сверка ──────────────────────────────────────────────────────────────────────────────

export async function acceptClaims(me: string, raw: unknown): Promise<Answer> {
  const [mine] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, me)).limit(1);
  if (!mine || mine.home !== null) return { status: 404, body: { error: 'not found' } };
  const items = parseViaClaims(raw);
  if (!items) return { status: 400, body: { error: 'bad-request' } };
  if (items.length > 0) {
    await db
      .insert(fedViaClaims)
      .values(items.map((c) => ({ userId: me, clientId: c.clientId, conversationId: c.conversationId, payloadHash: c.payloadHash })))
      .onConflictDoNothing();
  }
  // Отчёт — вся очередь отправленного в обход с этого устройства (и пустой — тоже отчёт: «в обход ничего не отправлял»).
  await db
    .insert(fedViaReports)
    .values({ userId: me, reportedAt: new Date() })
    .onConflictDoUpdate({ target: fedViaReports.userId, set: { reportedAt: new Date() } });
  // Сверка — в фоне: сосед может отвечать до 20 с, а клиенту важно лишь, что отчёт принят.
  void reconcileAll().catch((err) => console.warn('[fed-via] сверка после отчёта:', err instanceof Error ? err.message : err));
  return { status: 200, body: { accepted: items.length } };
}

const running = new Set<string>();

/** Сверка со всеми рабочими связками, у которых `dm4`. */
export async function reconcileAll(): Promise<void> {
  const links = await db.select({ id: federationLinks.instanceId, features: federationLinks.features, state: federationLinks.state }).from(federationLinks);
  for (const l of links) {
    if (l.state !== 'active') continue;
    const link = await getLink(l.id);
    if (link && (await hasDm4(link, Date.now()))) await reconcileVia(l.id);
  }
}

async function hasDm4(link: { instanceId: string; apiBase: string; features: string[] }, now: number): Promise<boolean> {
  return hasFeature(link, FED_FEATURES.dm4, now);
}

async function hasFeature(link: { instanceId: string; apiBase: string; features: string[] }, feature: string, now: number): Promise<boolean> {
  if (link.features.includes(feature)) return true;
  return (await refreshCapabilities(link, now).catch(() => link.features)).includes(feature);
}

/** Забрать у соседа «через»-сообщения наших людей и решить по каждому. Одиночка на связку. */
export async function reconcileVia(instanceId: string, now = Date.now()): Promise<void> {
  if (running.has(instanceId)) return;
  running.add(instanceId);
  try {
    await fetchPending(instanceId, now);
    await decidePending(instanceId, now);
    // Отчёты, к которым так и не пришло сообщение, — не копим.
    await db.delete(fedViaClaims).where(lt(fedViaClaims.createdAt, new Date(now - FED_VIA_LIMITS.claimKeepMs)));
  } finally {
    running.delete(instanceId);
  }
}

async function fetchPending(instanceId: string, now: number): Promise<void> {
  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return;
  const link = await getLink(instanceId);
  if (!link || link.state !== 'active' || !(await hasDm4(link, now))) return;
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return;
  }
  const res = await getSignedFromPeer({
    apiBase: link.apiBase,
    path: `/api${FED_VIA_PATH}`,
    query: { instance_id: self.instanceId },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now,
  });
  if (!res.ok || res.value.status !== 200) return;
  let page: FedConvMessageWire[] | null = null;
  try {
    page = parseViaPage(JSON.parse(res.value.body));
  } catch {
    page = null;
  }
  for (const w of page ?? []) {
    // Сосед отдаёт только наших людей; чужого автора не берём вовсе (не наше решать).
    if (w.author.instanceId !== self.instanceId) continue;
    const [author] = await db
      .select({ id: users.id, home: users.homeInstanceId })
      .from(users)
      .where(eq(users.id, w.author.userId))
      .limit(1);
    const access = author && author.home === null ? await loadAccess(w.conversationId, author.id) : null;
    const peerHome = access?.peerId
      ? (await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, access.peerId)).limit(1))[0]?.home
      : null;
    // Э7 часть 3: в группе «через» разрешён только к её хосту (сосед, что прислал сообщение, и есть хост этой группы).
    const groupHost = access && access.kind === 'group' && !access.saved ? await groupHostOf(w.conversationId) : null;
    if (!author || !access || (groupHost !== instanceId && (access.kind !== 'direct' || peerHome !== instanceId))) {
      // Беседы или автора у нас нет — дом за это не ручается.
      await sendVerdict(instanceId, w.conversationId, w.id, 'rejected');
      fedAudit('federation.dm_via_rejected', { instanceId, messageId: w.id, conversationId: w.conversationId, reason: 'no-conversation' });
      continue;
    }
    await db
      .insert(fedViaPending)
      .values({
        messageId: w.id,
        instanceId,
        conversationId: w.conversationId,
        authorId: author.id,
        clientId: w.clientId,
        entity: serializeConvMessageWire(w),
      })
      .onConflictDoNothing();
  }
}

async function decidePending(instanceId: string, now: number): Promise<void> {
  const rows = await db.select().from(fedViaPending).where(eq(fedViaPending.instanceId, instanceId));
  for (const row of rows) {
    const w = parseConvMessageWire(row.entity);
    let verdict: FedViaVerdict | 'wait';
    let claimed = false;
    if (!w || w.attachments.length > 0 || w.sticker || w.forwardedFrom || w.service || w.replyQuote || w.media) {
      // «Через» — только текст и ответ (`viaGate`); остальное дом не подтверждает.
      verdict = 'rejected';
    } else {
      const [claim] = row.clientId
        ? await db
            .select()
            .from(fedViaClaims)
            .where(and(eq(fedViaClaims.userId, row.authorId), eq(fedViaClaims.clientId, row.clientId)))
            .limit(1)
        : [];
      claimed = !!claim;
      const [report] = await db.select().from(fedViaReports).where(eq(fedViaReports.userId, row.authorId)).limit(1);
      // Отчёт в счёт, только если он позже отправки сообщения (время соседа): раньше клиент о нём и знать не мог. Сосед,
      // сдвинувший время вперёд, этим только оставит своё «не подтверждено» навсегда (`unverified`), своим дом его не сделает.
      const reportedAt = report && report.reportedAt.getTime() >= w.createdAt ? report.reportedAt.getTime() : null;
      // Отпечаток считаем САМИ по тексту копии: отпечатку соседа не верим.
      const wireHash = payloadHash({ conversationId: row.conversationId, content: w.content, attachmentRefs: [], replyToId: w.replyToId });
      verdict = viaVerdictFor({
        clientId: row.clientId,
        claimHash: claim && claim.conversationId === row.conversationId ? claim.payloadHash : claim ? '' : null,
        wireHash,
        ageMs: now - row.receivedAt.getTime(),
        sinceReportMs: reportedAt === null ? null : now - reportedAt,
      });
      if (verdict === 'confirmed') verdict = await acceptOwn(instanceId, row.authorId, w);
    }
    if (verdict === 'wait') continue;
    await sendVerdict(instanceId, row.conversationId, row.messageId, verdict);
    if (verdict === 'rejected') {
      console.warn(`[fed-via] ${instanceId}: «через»-сообщение ${row.messageId} не подтверждено клиентом — отвергнуто`);
      fedAudit('federation.dm_via_rejected', { instanceId, messageId: row.messageId, conversationId: row.conversationId, userId: row.authorId });
    }
    await db.delete(fedViaPending).where(eq(fedViaPending.messageId, row.messageId));
    if (claimed && row.clientId) {
      await db.delete(fedViaClaims).where(and(eq(fedViaClaims.userId, row.authorId), eq(fedViaClaims.clientId, row.clientId)));
    }
  }
}

/** Принять подтверждённое своим: та же `id`, `client_id`, время отправки; копия уйдёт соседу обычным журналом. */
async function acceptOwn(instanceId: string, authorId: string, w: FedConvMessageWire): Promise<FedViaVerdict> {
  const [exists] = await db
    .select({ authorId: conversationMessages.authorId, conversationId: conversationMessages.conversationId })
    .from(conversationMessages)
    .where(eq(conversationMessages.id, w.id))
    .limit(1);
  // Та же id в другой беседе — не «уже принято», а коллизия (находка Codex R201): подтверждать нечего.
  if (exists) return exists.authorId === authorId && exists.conversationId === w.conversationId ? 'confirmed' : 'rejected';
  const access = await loadAccess(w.conversationId, authorId);
  if (!access) return 'rejected';
  let replyToId: string | null = null;
  if (w.replyToId) {
    const [parent] = await db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, w.replyToId), eq(conversationMessages.conversationId, w.conversationId)))
      .limit(1);
    replyToId = parent?.id ?? null;
  }
  const res = await sendMessage(authorId, access, {
    clientId: w.clientId,
    content: w.content,
    attachments: [],
    replyToId,
    withheld: false,
    silent: w.silent,
    noPreview: w.noPreview,
    via: { instanceId, state: 'confirmed' },
    id: w.id,
    createdAt: new Date(w.createdAt),
  });
  if (res.kind === 'created') {
    await deliver(res.delivery);
    return 'confirmed';
  }
  // Клиент отправил то же и домой (тот же `client_id`): у дома уже есть своё — копию у соседа убрать без тревоги.
  if (res.kind === 'replay') return 'duplicate';
  return 'rejected';
}

async function sendVerdict(instanceId: string, conversationId: string, messageId: string, verdict: FedViaVerdict): Promise<void> {
  await sendEventTo(instanceId, FED_VIA_VERDICT_EVENT, serializeViaVerdict({ conversationId, messageId, verdict })).catch(() => {});
}

// ─── Инстанс собеседника ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Отправка человеком соседа по долгой сессии. `null` — пишет наш человек (обычный путь); `'refused'` — нельзя
 * (`federation.dm_via_limited`); иначе — «через» с домом автора.
 */
export async function viaGate(me: string, access: ConvAccess): Promise<null | 'refused' | { instanceId: string }> {
  const [u] = await db
    .select({ home: users.homeInstanceId, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, me))
    .limit(1);
  if (!u || u.home === null) return null;
  // Э7 часть 3 (#141): группа ЭТОГО хоста — человек соседа с `dmgroup2` пишет по долгой сессии (текст/ответ); группа чужого хоста — нет.
  if (!u.deletedAt && access.kind === 'group' && !access.saved) {
    if ((await groupHostOf(access.conversationId)) !== null) return 'refused';
    const groupLink = await getLink(u.home);
    if (!groupLink || !(await hasDm4(groupLink, Date.now())) || !(await hasFeature(groupLink, FED_FEATURES.dmgroup2, Date.now()))) return 'refused';
    if (linkVerdict(groupLink, (await readInstanceMeta()).paused)) return 'refused';
    return { instanceId: u.home };
  }
  if (u.deletedAt || access.kind !== 'direct' || access.saved || !access.peerId) return 'refused';
  const [peer] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, access.peerId)).limit(1);
  if (!peer || peer.home !== null) return 'refused';
  const link = await getLink(u.home);
  if (!link || !(await hasDm4(link, Date.now()))) return 'refused';
  if (linkVerdict(link, (await readInstanceMeta()).paused)) return 'refused';
  return { instanceId: u.home };
}

/** Писать, кроме «через»-отправки, человек соседа у нас не может (правка, удаление, реакции, закреп…). */
export async function isShadowUser(me: string): Promise<boolean> {
  const [u] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, me)).limit(1);
  return !!u && u.home !== null;
}

/** `GET /fed/v1/conv/via` — «через»-сообщения людей спрашивающего, ждущие решения. */
export async function pendingFor(instanceId: string, selfInstanceId: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(and(eq(conversationMessages.viaInstanceId, instanceId), eq(conversationMessages.viaState, 'pending')))
    .orderBy(conversationMessages.sortKey)
    .limit(FED_VIA_LIMITS.page);
  const live = rows.filter((m) => m.deletedAt === null);
  const ids = [...new Set(live.map((m) => m.authorId))];
  const people = new Map<string, { id: string; homeInstanceId: string | null; homeUserId: string | null }>();
  if (ids.length > 0) {
    for (const u of await db
      .select({ id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId })
      .from(users)
      .where(inArray(users.id, ids))) {
      people.set(u.id, u);
    }
  }
  // Только авторы — люди СПРАШИВАЮЩЕГО (пометку ставит `viaGate`, но строку мог тронуть кто угодно — проверяем снова).
  const items = live
    .filter((m) => people.get(m.authorId)?.homeInstanceId === instanceId)
    .map((m) => serializeConvMessageWire(toWireMessage(m, people, selfInstanceId)));
  return serializeViaPage(items);
}

/** Решение дома автора по «через»-сообщению его человека. */
export async function applyVerdict(instanceId: string, payload: unknown): Promise<void> {
  const v = parseViaVerdict(payload);
  if (!v) return;
  const [row] = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.id, v.messageId),
        eq(conversationMessages.conversationId, v.conversationId),
        eq(conversationMessages.viaInstanceId, instanceId),
        eq(conversationMessages.viaState, 'pending'),
      ),
    )
    .limit(1);
  if (!row || row.deletedAt) return;
  const [author] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, row.authorId)).limit(1);
  if (author?.home !== instanceId) return; // решает только дом автора

  if (v.verdict === 'confirmed' || v.verdict === 'unverified') {
    const state = v.verdict === 'confirmed' ? 'confirmed' : 'unverified';
    const d = await db.transaction(async (tx) => {
      if (!(await lockConversation(tx, row.conversationId))) return null;
      await tx.update(conversationMessages).set({ viaState: state }).where(eq(conversationMessages.id, row.id));
      if (state !== 'confirmed') return null; // вид не меняется: `confirmed: false` как было
      const access = await loadAccess(row.conversationId, row.authorId, tx);
      if (!access) return null;
      const audience = changeAudience({ action: 'edit', actorId: row.authorId, memberIds: access.memberIds, withheld: row.withheld, blockedActor: new Set() });
      const pts = await journal(tx, msgEntries(audience, row.conversationId, row.id), { fed: false });
      return { conversationId: row.conversationId, messageId: row.id, pts };
    });
    await deliver(d);
    return;
  }

  // `rejected` / `duplicate` — надгробие у обоих (у автора его нет — показывать нечего).
  const access = await loadAccess(row.conversationId, row.authorId);
  if (!access) return;
  const res = await deleteMessage(row.authorId, access, row.id, 'both');
  if (res.kind === 'ok') await deliver(res.delivery);
  if (v.verdict === 'rejected') {
    // «Возможна подделка» (§4 п. 1 (б)): дом автора не ручается за сообщение, которое у нас стояло от его имени.
    console.warn(`[fed-via] ${instanceId} отверг «через»-сообщение ${row.id} — возможна подделка`);
    fedAudit('federation.dm_via_forged', { instanceId, messageId: row.id, conversationId: row.conversationId, authorId: row.authorId });
  }
}

/** Подключение (зовёт `index.ts` при `FEDERATION_DM_ENABLED`): решения соседей, сверка при старте, по таймеру и по связке. */
let timer: ReturnType<typeof setInterval> | null = null;
/** `active` (#224): ЛС между инстансами включены прямо сейчас — выключили тумблером в админке, такты и приём пустые. */
export function startConvVia(active: () => boolean = () => true): void {
  onFedEvent(FED_VIA_VERDICT_EVENT, async ({ instanceId, event }) => {
    if (active()) await applyVerdict(instanceId, event.payload);
  });
  onLinkRestored((instanceId) => {
    if (active()) void reconcileVia(instanceId).catch(() => {});
  });
  if (timer) return;
  const pass = () => {
    if (active()) void reconcileAll().catch((err) => console.warn('[fed-via] сверка:', err instanceof Error ? err.message : err));
  };
  setTimeout(pass, 8_000).unref?.();
  timer = setInterval(pass, RECONCILE_EVERY_MS);
  timer.unref?.();
}
