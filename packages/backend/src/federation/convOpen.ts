/**
 * ЛС между инстансами, этап Э1 (#141, `docs/dm/FEDERATION.md` §1.2, §3.3): открыть беседу 1:1 с человеком связанного инстанса.
 *
 * Две стороны одного подписанного запроса `POST /fed/v1/conv/open` (провод — `shared/federation/convOpen.ts`):
 * - `openFederatedDirect` — дом ИНИЦИАТОРА: проверки связки и `dm1`, предел новых переписок, запрос, по ответу «можно/уже
 *   есть» — теневая строка собеседника и беседа с ТЕМ ЖЕ id, что у соседа;
 * - `acceptConvOpen` — дом ПОЛУЧАТЕЛЯ: решает по своей настройке `fedDmPolicy` (Ф6), блокировке (маскируется под `policy`),
 *   скрытости от соседей (Ф11) и пределу 10/час от одного человека соседа; заводит беседу и теневую строку инициатора.
 *
 * 🔴 Встречное создание (оба нажали «Написать» одновременно): одна беседа на пару. Пока наш запрос в пути, его id лежит в
 * `inFlight` по ключу пары; встречный запрос соседа с БОЛЬШИМ id получает `exists: <наш>` (сосед примет наш), с меньшим —
 * принимается как обычно, а наш запрос получит от соседа `exists: <его>`. Проверка «есть ли беседа» + запись в `inFlight` и
 * вся обработка встречного — под замком пары в памяти (`withPairLock`): бэкенд инстанса — один процесс.
 * Ф10: дом получателя не ответил — беседу не открываем, отказ `federation.peer_unreachable` (текст — клиент).
 */
import {
  convOpenWinner,
  decideFedDmOpen,
  FED_CONV_OPEN_PATH,
  FED_DM_NEW_LIMIT,
  FED_DM_REFUSAL,
  FED_ERRORS,
  FED_FEATURES,
  fedDirectKey,
  parseConvOpenRequest,
  parseConvOpenResponse,
  parseConvWire,
  serializeConvOpenRequest,
  serializeConvOpenResponse,
  type FedConvOpenResponse,
} from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { rateHit } from '../authGuard.js';
import { isBlockedBy } from '../blocks.js';
import { createDirect, deliver, findDirect, revealDirect } from '../conversations.js';
import { db } from '../db/index.js';
import { shareServer } from '../db/peerQueries.js';
import { conversations, federationMemberships, users } from '../db/schema.js';
import { DM_OPEN_REASONS, dmNewLimitError } from '../dmRules.js';
import { fedDmPolicy } from '../instanceSetup.js';
import { reachableUser } from '../userSearchRules.js';
import { uuidv7 } from '../util.js';
import { refreshCapabilities } from './directorySync.js';
import { ensureShadowUser, shadowUserFor } from './guestHost.js';
import { federation } from './instance.js';
import { getLink } from './links.js';
import { postSignedToPeer } from './peerClient.js';
import type { StoredLink } from './linkService.js';

/** Наши запросы `conv.open` в пути: ключ пары → id беседы, который мы предложили. */
const inFlight = new Map<string, string>();
/**
 * Исправления ревью 12.10, п. 2 (а): id, которые предлагал наш человек и ответа соседа не дождался (сеть, таймаут). Сосед мог
 * беседу завести — её строка `conv` в его журнале тогда заводится у нас без политики (наш человек сам её открывал). В памяти,
 * не дольше `ASKED_TTL_MS`: после рестарта строка пройдёт обычную политику.
 */
const askedIds = new Map<string, { id: string; at: number }>();
const ASKED_TTL_MS = 7 * 24 * 3600_000;
const pairLocks = new Map<string, Promise<unknown>>();

/** Замок пары в памяти: проверка «беседа есть?» и её создание не перемешиваются со встречным запросом. */
async function withPairLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pairLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  pairLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (pairLocks.get(key) === tail) pairLocks.delete(key);
  }
}

async function convIdByKey(key: string): Promise<string | null> {
  const [row] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.directKey, key)).limit(1);
  return row?.id ?? null;
}

/** Серверы, где состоят оба (активные членства) — для `shared_server_ids` запроса. */
async function sharedServerIds(one: string, two: string): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT a.server_id AS id FROM server_members a
      JOIN server_members b ON b.server_id = a.server_id AND b.user_id = ${two} AND b.state = 'active'
      WHERE a.user_id = ${one} AND a.state = 'active'
      LIMIT 50
  `);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

export type FedOpenResult =
  | { ok: true; conversationId: string; created: boolean }
  | { ok: false; status: 403 | 404 | 409 | 429 | 503; body: Record<string, unknown>; retryAfter?: number };

const refuse = (
  status: 403 | 404 | 409 | 429 | 503,
  error: string,
  extra: Record<string, unknown> = {},
): Extract<FedOpenResult, { ok: false }> => ({ ok: false, status, body: { error, ...extra } });

/**
 * «Написать» человеку соседа (дом инициатора). `target` — его дом и id там (из кеша каталога или теневой строки).
 * Ответ маршрута — `routes/conv.ts` `POST /conv/direct`.
 */
export async function openFederatedDirect(me: string, target: { instanceId: string; homeUserId: string }): Promise<FedOpenResult> {
  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return refuse(403, FED_ERRORS.dmUnavailable);
  const [meRow] = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName, home: users.homeInstanceId, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, me))
    .limit(1);
  // Гость (теневой) пишет из своего дома, а не отсюда.
  if (!meRow || meRow.home) return refuse(403, FED_ERRORS.dmUnavailable);
  if (target.instanceId === self.instanceId) return refuse(404, 'user not found');

  const link = await getLink(target.instanceId);
  if (!link) return refuse(403, FED_ERRORS.noLink);
  if (link.state === 'paused') return refuse(403, FED_ERRORS.paused);
  if (link.state !== 'active') return refuse(403, FED_ERRORS.noLink);

  const pairKey = fedDirectKey({ instanceId: self.instanceId, userId: me }, { instanceId: target.instanceId, userId: target.homeUserId });
  // Беседа уже есть — открыть без похода к соседу (у существующей права уже были; работает и когда сосед лежит).
  const known = await convIdByKey(pairKey);
  if (known) {
    const revealed = await revealDirect(me, known);
    if (revealed) {
      void deliver(revealed).catch(() => {});
      // Исправления ревью 12.10, п. 2 (в): беседу завёл сосед (его `conv.open`), а наш человек открывает её впервые — ответ
      // на тот запрос мог не дойти, и у соседа беседы может не быть. Идемпотентный `conv.open` с тем же id: есть — `exists`,
      // нет — заведёт. В фоне: открыть беседу можно и при лежащем соседе.
      if (link.features.includes(FED_FEATURES.dm1)) void reaskPeer(link, me, meRow, target, known, key).catch(() => {});
    }
    return { ok: true, conversationId: known, created: false };
  }

  // Признак `dm1` записан в связку при подтверждении; сосед мог обновиться позже — перечитать визитку (п. 10 ревью 12.10:
  // принудительно, свой предел раз в минуту на связку, а не раз в час).
  let features = link.features;
  if (!features.includes(FED_FEATURES.dm1)) features = await refreshCapabilities(link, Date.now(), { force: true });
  if (!features.includes(FED_FEATURES.dm1)) return refuse(409, FED_ERRORS.unsupported, { instanceId: link.instanceId });

  const wait = await rateHit(`fed-dm-new:${me}`, FED_DM_NEW_LIMIT.max, FED_DM_NEW_LIMIT.windowS);
  if (wait > 0) return { ...refuse(429, dmNewLimitError(wait), { reason: DM_OPEN_REASONS.newLimit }), retryAfter: wait };

  // UUIDv7 (тот же генератор, что у местных id): время в начале — встречное создание решает «раньше».
  const proposed = uuidv7();
  const raced = await withPairLock(pairKey, async () => {
    const existing = await convIdByKey(pairKey);
    if (existing) return existing;
    inFlight.set(pairKey, proposed);
    return null;
  });
  if (raced) {
    // Встречный запрос соседа успел завести беседу у нас между проверкой и замком — показать её мне (`pending` у меня).
    const revealed = await revealDirect(me, raced);
    if (revealed) void deliver(revealed).catch(() => {});
    return { ok: true, conversationId: raced, created: false };
  }

  let answer: FedConvOpenResponse | 'unreachable' | 'unsupported' | null;
  try {
    const shadow = await shadowUserFor(target.instanceId, target.homeUserId);
    const shared = shadow ? await sharedServerIds(me, shadow.id) : [];
    answer = await askPeer(link, {
      instanceId: self.instanceId,
      from: {
        userId: me,
        username: meRow.username,
        displayName: meRow.displayName ?? meRow.username,
        avatarHash: null,
      },
      toUserId: target.homeUserId,
      conversationId: proposed,
      createdAt: Date.now(),
      sharedServerIds: shared,
    }, key);
  } finally {
    if (inFlight.get(pairKey) === proposed) inFlight.delete(pairKey);
  }

  if (answer === 'unreachable' || answer === null) {
    // п. 2 (а): сосед мог беседу завести, а ответ потерялся — его строка `conv` заведёт её у нас без политики.
    askedIds.set(pairKey, { id: proposed, at: Date.now() });
    return refuse(503, FED_ERRORS.peerUnreachable, { instanceId: link.instanceId });
  }
  if (answer === 'unsupported') return refuse(409, FED_ERRORS.unsupported, { instanceId: link.instanceId });
  if (answer.kind === 'refused') return refuse(403, FED_ERRORS.dmRefused, { reason: answer.reason, instanceId: link.instanceId });

  const conversationId = answer.conversationId;
  return withPairLock(pairKey, async () => {
    const shadow = await ensureShadowUser(target.instanceId, target.homeUserId, answer.to ?? null);
    if (!shadow) return refuse(503, FED_ERRORS.peerUnreachable, { instanceId: link.instanceId });
    const made = await createDirect(me, shadow.id, { id: conversationId, originInstanceId: answer.kind === 'ok' ? self.instanceId : target.instanceId });
    if (made) {
      void deliver(made.delivery).catch(() => {});
      convOpened?.(me, target.instanceId);
      return { ok: true as const, conversationId: made.row.id, created: true };
    }
    // Встречный запрос соседа успел завести беседу у нас (тот же ключ пары) — она и есть.
    const found = await findDirect(me, shadow.id);
    if (!found) throw new Error('conv.open: беседа не создана и не найдена');
    const revealed = await revealDirect(me, found.id);
    if (revealed) void deliver(revealed).catch(() => {});
    return { ok: true as const, conversationId: found.id, created: false };
  });
}

async function askPeer(
  link: StoredLink,
  request: Parameters<typeof serializeConvOpenRequest>[0],
  key: { kid: string; privateKeyDer: Uint8Array },
): Promise<FedConvOpenResponse | 'unreachable' | 'unsupported' | null> {
  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return 'unreachable';
  }
  const res = await postSignedToPeer({
    apiBase: link.apiBase,
    path: `/api${FED_CONV_OPEN_PATH}`,
    payload: serializeConvOpenRequest(request),
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
  });
  if (!res.ok) return 'unreachable';
  // Маршрута нет — у соседа выключен `FEDERATION_DM_ENABLED` (визитка могла устареть): честное «не поддерживает».
  if (res.value.status === 404) return 'unsupported';
  if (res.value.status >= 500 || res.value.status === 429) return 'unreachable';
  try {
    return parseConvOpenResponse(JSON.parse(res.value.body));
  } catch {
    return null;
  }
}

/**
 * Дом получателя: ответ на `POST /fed/v1/conv/open` связанного соседа (`routes/federation.ts`). Возвращает статус и тело.
 */
/**
 * «Кто может мне писать» (13.10, #218, `msgpriv1`): пускает ли наш `recipientId` первое сообщение человека соседа (`senderId` — его
 * теневая строка; `null` — её ещё нет: ни контакта, ни исключения, ни «я писал первым» быть не может). Нет — `conv.open` отказывается
 * с причиной `privacy` (старый сосед прочтёт `policy`). Подключает `index.ts` — перечень зависимостей модуля закрыт.
 */
let messageGate: ((senderId: string | null, recipientId: string) => Promise<boolean>) | null = null;
export function configureFedOpenPrivacy(fn: ((senderId: string | null, recipientId: string) => Promise<boolean>) | null): void {
  messageGate = fn;
}

/**
 * Приёмка 15.10 (в шапке «в сети», в профиле «был(а) сегодня в 15:56»): у нашего человека появилась беседа 1:1 с человеком дома
 * `peerHome` — его «в сети / был(а)» уходит туда сразу (`dmEphemeral.fedPeerAdded`), а не через 10 минут, когда истечёт память
 * «собеседников с других инстансов нет». Подключает `index.ts` — перечень зависимостей модуля закрыт.
 */
let convOpened: ((localUserId: string, peerHome: string) => void) | null = null;
export function configureFedConvOpened(fn: ((localUserId: string, peerHome: string) => void) | null): void {
  convOpened = fn;
}

export async function acceptConvOpen(link: StoredLink, raw: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const reqOpen = parseConvOpenRequest(raw);
  if (!reqOpen || reqOpen.instanceId !== link.instanceId) return { status: 400, body: { error: 'bad-request' } };
  const self = federation.identity();
  if (!self) return { status: 503, body: { error: 'no-identity' } };
  // Связка помнит возможности соседа с подтверждения: пришёл `conv.open` — сосед уже умеет ЛС, а без `dm1` в строке связки наш
  // забор (`convAccept`) его не трогает и ответ не дойдёт (живая проверка 12.10). Перечитать визитку в фоне, не чаще раза в час.
  if (!link.features.includes(FED_FEATURES.dm1)) {
    try {
      void refreshCapabilities(link, Date.now(), { force: true }).catch(() => {});
    } catch {
      // только подсказка: отказ визитки не мешает ответить на открытие
    }
  }
  const answer = (r: FedConvOpenResponse) => ({ status: r.kind === 'refused' ? 403 : 200, body: serializeConvOpenResponse(r) });

  const [target] = await db.select().from(users).where(eq(users.id, reqOpen.toUserId)).limit(1);
  const pairKey = fedDirectKey(
    { instanceId: link.instanceId, userId: reqOpen.from.userId },
    { instanceId: self.instanceId, userId: reqOpen.toUserId },
  );

  // Профиль нашего человека — дому инициатора для теневой строки (в его кеше каталога его может ещё не быть).
  const to = target ? { username: target.username, displayName: target.displayName ?? target.username, avatarHash: null } : null;
  return withPairLock(pairKey, async () => {
    const existing = await convIdByKey(pairKey);
    if (existing) return answer({ kind: 'exists', conversationId: existing, to });

    // Встречное: наш человек сам открывает переписку с инициатором прямо сейчас — политика не нужна (оба хотят).
    const mine = inFlight.get(pairKey);
    if (mine && convOpenWinner(mine, reqOpen.conversationId) === 'mine') return answer({ kind: 'exists', conversationId: mine, to });

    const targetOk = !!target && reachableUser(target);
    const shadowBefore = await shadowUserFor(link.instanceId, reqOpen.from.userId);
    let sharedServer = false;
    if (!mine && targetOk && shadowBefore) sharedServer = await shareServer(target!.id, shadowBefore.id);
    if (!mine && targetOk && !sharedServer && reqOpen.sharedServerIds.length > 0) {
      // Наш человек — гость на сервере инициатора: верим своему индексу членств, а не списку соседа.
      const [hit] = await db
        .select({ s: federationMemberships.serverId })
        .from(federationMemberships)
        .where(
          and(
            eq(federationMemberships.instanceId, link.instanceId),
            eq(federationMemberships.userId, target!.id),
            eq(federationMemberships.state, 'active'),
            inArray(federationMemberships.serverId, reqOpen.sharedServerIds),
          ),
        )
        .limit(1);
      sharedServer = !!hit;
    }
    const verdict = decideFedDmOpen({
      exists: false,
      targetOk,
      hidden: !!target?.hiddenFromPeers,
      blocked: !!shadowBefore && targetOk && (await isBlockedBy(target!.id, shadowBefore.id)),
      sharedServer: sharedServer || !!mine,
      policy: mine ? 'anyone' : await fedDmPolicy(),
    });
    if (verdict !== 'create' && verdict !== 'create-limited' && verdict !== 'exists') {
      return answer({ kind: 'refused', reason: verdict });
    }
    // Встречное (`mine`) — наш человек сам пишет инициатору: ограничение не действует (Telegram: «кому я писал первым»).
    if (!mine && messageGate && !(await messageGate(shadowBefore?.id ?? null, target!.id))) {
      return answer({ kind: 'refused', reason: FED_DM_REFUSAL.privacy });
    }
    if (verdict === 'create-limited') {
      const wait = await rateHit(`fed-dm-in:${link.instanceId}:${reqOpen.from.userId}`, FED_DM_NEW_LIMIT.max, FED_DM_NEW_LIMIT.windowS);
      if (wait > 0) return answer({ kind: 'refused', reason: FED_DM_REFUSAL.rate });
    }
    // 🔴 Подмена id (§4.7): предложенный id не должен принадлежать другой беседе.
    const [taken] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, reqOpen.conversationId)).limit(1);
    if (taken) return { status: 409, body: { error: 'conversation-id-taken' } };

    const shadow = await ensureShadowUser(link.instanceId, reqOpen.from.userId, {
      username: reqOpen.from.username,
      displayName: reqOpen.from.displayName,
      avatarHash: reqOpen.from.avatarHash,
    });
    if (!shadow) return { status: 503, body: { error: 'shadow-unavailable' } };
    // Получателю беседа покажется с первым сообщением (`pending`, как у местной «Написать»); событие теневому не шлём.
    const made = await createDirect(shadow.id, target!.id, { id: reqOpen.conversationId, originInstanceId: link.instanceId });
    if (made) {
      convOpened?.(target!.id, link.instanceId);
      return answer({ kind: 'ok', conversationId: made.row.id, to });
    }
    const raced = await convIdByKey(pairKey);
    return raced ? answer({ kind: 'exists', conversationId: raced, to }) : { status: 500, body: { error: 'not-created' } };
  });
}

/** п. 2 (в): повторить `conv.open` для уже заведённой у нас беседы (тот же id) — у соседа её могло не остаться. */
async function reaskPeer(
  link: StoredLink,
  me: string,
  meRow: { username: string; displayName: string | null },
  target: { instanceId: string; homeUserId: string },
  conversationId: string,
  key: { kid: string; privateKeyDer: Uint8Array },
): Promise<void> {
  const self = federation.identity();
  if (!self) return;
  const [conv] = await db
    .select({ origin: conversations.originInstanceId, createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  // Завёл наш человек — сосед ответил `ok`/`exists` при создании, беседа у него есть.
  if (!conv || conv.origin === self.instanceId) return;
  const answer = await askPeer(
    link,
    {
      instanceId: self.instanceId,
      from: { userId: me, username: meRow.username, displayName: meRow.displayName ?? meRow.username, avatarHash: null },
      toUserId: target.homeUserId,
      conversationId,
      createdAt: conv.createdAt.getTime(),
      sharedServerIds: [],
    },
    key,
  );
  if (answer && typeof answer === 'object' && answer.kind !== 'refused' && answer.conversationId !== conversationId) {
    console.warn(`[fed-dm] ${link.instanceId}: пара уже живёт в беседе ${answer.conversationId}, у нас — ${conversationId}`);
  }
}

/**
 * Исправления ревью 12.10, п. 2 (а): строка `conv` журнала соседа (`FedConvWire` с участниками) — 1:1 нашего человека с
 * человеком этого соседа, которой у нас нет (ответ на `conv.open` потерялся; наша база восстановлена; сосед завёл беседу
 * встречным запросом, пока мы лежали). Заводим с ЭТИМ id по правилам `acceptConvOpen`: политика «кто пишет первым»,
 * блокировка, скрытый от соседей; отказ — не заводим (`false`, строки беседы пропускаются). Наш человек сам предлагал этот id
 * (`askedIds`) — без политики, беседа показывается ему сразу. Крючок `convAccept.configureFedConvRow` (подключает `index.ts`).
 * Ошибка (нет теневой строки) — исключение: строка повторится.
 */
export async function acceptConvRow(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<boolean> {
  const w = parseConvWire(entity);
  if (!w || w.id !== conversationId) return false;
  const [exists] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (exists) return true;
  // Группы между инстансами — Э7; третий инстанс в 1:1 — подделка.
  if (w.kind !== 'direct' || w.members.length !== 2) return false;
  const ours = w.members.find((m) => m.instanceId === self);
  const theirs = w.members.find((m) => m.instanceId === peer);
  if (!ours || !theirs) return false;
  const pairKey = fedDirectKey(ours, theirs);
  return withPairLock(pairKey, async () => {
    const existing = await convIdByKey(pairKey);
    if (existing) {
      if (existing !== conversationId) console.warn(`[fed-dm] ${peer}: строка conv ${conversationId}, а пара живёт в ${existing}`);
      return existing === conversationId;
    }
    const asked = askedIds.get(pairKey);
    const mine = !!asked && asked.id === conversationId && Date.now() - asked.at < ASKED_TTL_MS;
    const [target] = await db.select().from(users).where(eq(users.id, ours.userId)).limit(1);
    if (!target || target.homeInstanceId) return false;
    const targetOk = reachableUser(target);
    const shadowBefore = await shadowUserFor(peer, theirs.userId);
    const sharedServer = mine || (targetOk && !!shadowBefore && (await shareServer(target.id, shadowBefore.id)));
    const verdict = decideFedDmOpen({
      exists: false,
      targetOk,
      hidden: !mine && !!target.hiddenFromPeers,
      blocked: !!shadowBefore && targetOk && (await isBlockedBy(target.id, shadowBefore.id)),
      sharedServer,
      policy: mine ? 'anyone' : await fedDmPolicy(),
    });
    if (verdict !== 'create' && verdict !== 'create-limited' && verdict !== 'exists') {
      console.warn(`[fed-dm] ${peer}: строка conv ${conversationId} отклонена (${verdict})`);
      return false;
    }
    if (!mine && messageGate && !(await messageGate(shadowBefore?.id ?? null, target.id))) {
      console.warn(`[fed-dm] ${peer}: строка conv ${conversationId} отклонена (privacy)`);
      return false;
    }
    const shadow = await ensureShadowUser(peer, theirs.userId, null);
    if (!shadow) throw new Error('теневой строки собеседника нет');
    const made = mine
      ? await createDirect(target.id, shadow.id, { id: conversationId, originInstanceId: w.originInstanceId })
      : await createDirect(shadow.id, target.id, { id: conversationId, originInstanceId: w.originInstanceId });
    if (made) {
      if (mine) {
        askedIds.delete(pairKey);
        void deliver(made.delivery).catch(() => {});
      }
      convOpened?.(target.id, peer);
      return true;
    }
    return (await convIdByKey(pairKey)) === conversationId;
  });
}
