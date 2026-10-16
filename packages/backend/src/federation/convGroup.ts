/**
 * ЛС между инстансами, этап Э7 часть 1 (#141, `docs/dm/FEDERATION.md` §3.6, §4 п. 1, Ф2 (б)) — группы со смешанным составом.
 *
 * Власть над составом, названием и фото — у дома создателя группы (хост): только он пишет строку `conv` журнала на связку
 * (`convChanges.recordFedConvChanges`), дома участников заводят и обновляют копию группы по ней (`applyGroupConv`). Участник с
 * другого инстанса меняет состав запросом хосту (`groupOpRemote` → `POST /fed/v1/conv/group/op` → `acceptGroupOp`): хост
 * выполняет его теми же `convGroups.ts`, что и местное действие, от имени теневой строки участника.
 *
 * Сообщения — звездой «дом автора → хост → остальные дома» (связки попарные, дома участников могут быть не связаны). Хост
 * пересылает чужое, поэтому дом автора подписывает каноническое сообщение (`convMessageSigPayload`) сменным ключом инстанса
 * и прикладывает цепочку «сменный ключ (подписан корневым) + корневой ключ»: получатель выводит из корневого ключа `instance_id`
 * и сверяет с автором — подделать сообщение хост не может, связка получателя с домом автора не нужна.
 *
 * Подключается из `index.ts` крючками (`configureFedGroupAccept`, `configureFedGroupSigner`, `configureFedGroups`): модули
 * `convAccept.ts` и `routes/*` проверяются тестами с явным перечнем зависимостей.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  FED_ERRORS,
  FED_FEATURES,
  FED_GROUP_OP_PATH,
  convMessageSigPayload,
  parseConvGroupExtras,
  parseConvWire,
  parseGroupOp,
  parseMessageSig,
  serializeGroupOp,
  serializeMessageSig,
  type FedConvMessageWire,
  type FedGroupOp,
  type FedGroupProfile,
  type FedPersonRef,
} from '@gusvoice/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { addGroupMembers, removeGroupMember, updateGroupInfo, type GroupOpResult } from '../convGroups.js';
import { deliver, journal, lockConversation, type Delivery } from '../conversations.js';
import { db } from '../db/index.js';
import { conversationMembers, conversations, users } from '../db/schema.js';
import { GROUP_MEMBER_LIMIT, normalizeGroupTitle } from '../groupRules.js';
import { reachableUser } from '../userSearchRules.js';
import { refreshCapabilities } from './directorySync.js';
import { ensureShadowUser, shadowUserFor } from './guestHost.js';
import { federation } from './instance.js';
import { instanceIdFrom } from './instanceIdentity.js';
import { readInstanceMeta } from './instanceMeta.js';
import { linkVerdict } from './linkRules.js';
import { getLink, saveVouchedInstance } from './links.js';
import { postSignedToPeer } from './peerClient.js';
import { toDocumentKey, verifySigningKey } from './signingKeys.js';

// ─── Подпись дома автора ─────────────────────────────────────────────────────────────────────────────────────────────

/** Подписать сообщение нашего человека (текущее состояние: текст, правка, надгробие). Нет ключа — `null`. */
export function signOwnMessage(w: FedConvMessageWire): Record<string, unknown> | null {
  const id = federation.identity();
  const key = federation.signingKey();
  if (!id || !key) return null;
  try {
    const priv = createPrivateKey({ key: key.privateKeyDer, format: 'der', type: 'pkcs8' });
    const value = sign(null, Buffer.from(convMessageSigPayload(w), 'utf8'), priv).toString('base64url');
    return serializeMessageSig({ root: Buffer.from(id.rootPublicKeyDer).toString('base64url'), key: toDocumentKey(key), value });
  } catch {
    return null;
  }
}

/**
 * Проверить подпись дома автора: корневой ключ даёт `instance_id` автора, сменный ключ подписан корневым, сообщение — сменным.
 * Срок сменного ключа не сверяется: дом подписывает текущее состояние при отдаче (журнал, полный проход), а не в момент
 * написания, — выпущенный корневым ключ и есть доказательство.
 */
export function verifyMessageSig(w: FedConvMessageWire, entity: Record<string, unknown>): boolean {
  const s = parseMessageSig(entity.sig);
  if (!s) return false;
  try {
    const root = Buffer.from(s.root, 'base64url');
    if (instanceIdFrom(root) !== w.author.instanceId) return false;
    if (!verifySigningKey(root, s.key)) return false;
    const pub = createPublicKey({ key: Buffer.from(s.key.publicKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(convMessageSigPayload(w), 'utf8'), pub, Buffer.from(s.value, 'base64url'));
  } catch {
    return false;
  }
}

// ─── Связка с хостом / участником ────────────────────────────────────────────────────────────────────────────────────

const same = (a: FedPersonRef | null | undefined, b: FedPersonRef | null | undefined) =>
  !!a && !!b && a.instanceId === b.instanceId && a.userId === b.userId;

/** Можно ли звать в группу людей этого инстанса: связка рабочая и у него `dmgroup1` (визитка перечитывается раз в час). */
export async function groupInvitableHome(instanceId: string, now = Date.now()): Promise<boolean> {
  const link = await getLink(instanceId);
  if (!link || linkVerdict(link, (await readInstanceMeta()).paused)) return false;
  if (link.features.includes(FED_FEATURES.dmgroup1)) return true;
  return (await refreshCapabilities(link, now).catch(() => link.features)).includes(FED_FEATURES.dmgroup1);
}

// ─── Дом участника: строка `conv` от хоста ───────────────────────────────────────────────────────────────────────────

/**
 * Строка `conv` журнала соседа (`convAccept.configureFedConvRow`): группа его дома — завести/обновить (`applyGroupConv`); `true` —
 * группа у нас есть и строки за ней применяются, `false` — нашего человека в ней нет, строки беседы пропускаются. Не группа — `null`
 * (решает прежний разбор 1:1).
 */
export async function acceptGroupConvRow(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<boolean | null> {
  if (entity.kind !== 'group') return null;
  await applyGroupConv(peer, self, conversationId, entity);
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.originInstanceId, peer)))
    .limit(1);
  return !!row;
}

/**
 * Э7 часть 3 (D): названия и домены чужих (без связки с нами) инстансов из профилей строки `conv` — со слов дома группы (власть
 * хоста, решение владельца 13.10). Себя и самого хоста не пишем; связка с инстансом потом перекроет эти слова (`instanceLabels`).
 */
async function rememberVouchedHomes(peer: string, self: string, profiles: readonly FedGroupProfile[]): Promise<void> {
  const seen = new Set<string>();
  for (const p of profiles) {
    const id = p.ref.instanceId;
    if (!p.home || id === self || id === peer || seen.has(id)) continue;
    seen.add(id);
    await saveVouchedInstance({ instanceId: id, name: p.home.name, domain: p.home.domain, vouchedBy: peer });
  }
}

/**
 * Завести или обновить копию группы по строке `conv` её дома (`peer`). Принимается только от самого хоста
 * (`origin_instance_id = peer`) и только версия новее хранимой. Политика «кто может мне писать» не применяется: позвать в группу
 * может только человек дома, с которым у нас рабочая связка (решение части 1, `docs/dm/FEDERATION.md` §3.6); нет ни одного
 * нашего человека в составе — группу не заводим.
 */
export async function applyGroupConv(peer: string, self: string, conversationId: string, entity: Record<string, unknown>): Promise<void> {
  const w = parseConvWire(entity);
  const x = parseConvGroupExtras(entity);
  if (!w || !x || w.kind !== 'group' || w.id !== conversationId || w.originInstanceId !== peer) return;
  const link = await getLink(peer);
  if (!link || link.state !== 'active') return;
  // Э7 часть 3 (D): дома третьих — со слов хоста; ДО проверки версии (хост мог научиться присылать имена при той же версии состава).
  await rememberVouchedHomes(peer, self, x.profiles).catch(() => {});
  const [existing] = await db
    .select({ kind: conversations.kind, origin: conversations.originInstanceId, version: conversations.groupVersion })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (existing && (existing.kind !== 'group' || existing.origin !== peer || x.version <= existing.version)) return;

  // Состав → местные строки (вне транзакции: теневые строки заводятся своими запросами).
  const resolved: { id: string; ref: FedPersonRef }[] = [];
  for (const ref of w.members) {
    if (ref.instanceId === self) {
      const [u] = await db.select().from(users).where(and(eq(users.id, ref.userId), isNull(users.homeInstanceId))).limit(1);
      if (u && !u.deletedAt) resolved.push({ id: u.id, ref });
      continue;
    }
    const p = x.profiles.find((pp) => same(pp.ref, ref));
    const shadow = await ensureShadowUser(
      ref.instanceId,
      ref.userId,
      p ? { username: p.username, displayName: p.displayName, avatarHash: p.avatarHash } : null,
      { vouchedBy: peer },
    );
    if (shadow) resolved.push({ id: shadow.id, ref });
  }
  const ownerId = resolved.find((r) => same(r.ref, x.owner))?.id ?? null;
  if (!existing && !resolved.some((r) => r.ref.instanceId === self)) return;

  let delivery: Delivery | null = null;
  await db.transaction(async (tx) => {
    if (!existing) {
      await tx
        .insert(conversations)
        .values({
          id: conversationId,
          kind: 'group',
          originInstanceId: peer,
          title: w.title ?? '',
          avatarUrl: x.avatarUrl,
          groupVersion: x.version,
          createdAt: new Date(w.createdAt),
        })
        .onConflictDoNothing();
    }
    const lock = await lockConversation(tx, conversationId);
    if (!lock || lock.kind !== 'group') return;
    // Под замком: версия могла уйти вперёд параллельным забором.
    const [cur] = await tx.select({ version: conversations.groupVersion, origin: conversations.originInstanceId }).from(conversations).where(eq(conversations.id, conversationId));
    if (!cur || cur.origin !== peer || (existing && x.version <= cur.version)) return;
    await tx
      .update(conversations)
      .set({ title: w.title ?? '', avatarUrl: x.avatarUrl, groupVersion: x.version })
      .where(eq(conversations.id, conversationId));
    const rows = await tx
      .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt, role: conversationMembers.role, home: users.homeInstanceId })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(eq(conversationMembers.conversationId, conversationId));
    const byId = new Map(rows.map((r) => [r.userId, r]));
    const want = new Set(resolved.map((r) => r.id));
    const touched = new Set<string>();
    for (const r of resolved) {
      const role = r.id === ownerId ? ('owner' as const) : ('member' as const);
      const row = byId.get(r.id);
      if (!row) {
        await tx.insert(conversationMembers).values({ conversationId, userId: r.id, role, lastReadKey: lock.nextKey - 1 });
        touched.add(r.id);
      } else if (row.leftAt) {
        await tx
          .update(conversationMembers)
          .set({ leftAt: null, joinedAt: new Date(), role, pending: false, hiddenKey: null, lastReadKey: lock.nextKey - 1, archivedAt: null, pinnedAt: null })
          .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, r.id)));
        touched.add(r.id);
      } else if (row.role !== role) {
        await tx
          .update(conversationMembers)
          .set({ role })
          .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, r.id)));
      }
    }
    for (const row of rows) {
      if (row.leftAt || want.has(row.userId)) continue;
      await tx
        .update(conversationMembers)
        .set({ leftAt: sql`now()`, role: 'member', pinnedAt: null, archivedAt: null, unreadMarkedAt: null })
        .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, row.userId)));
      touched.add(row.userId);
    }
    // Сводка группы — всем нашим участникам (и ушедшему: его сводка станет «бывшей группой»).
    const local = new Set<string>([...resolved.filter((r) => r.ref.instanceId === self).map((r) => r.id)]);
    for (const row of rows) if (row.home === null) local.add(row.userId);
    const audience = [...local];
    if (audience.length === 0) return;
    const pts = await journal(
      tx,
      audience.map((userId) => ({ userId, conversationId, kind: 'conv' as const, messageId: null })),
      { fed: false },
    );
    delivery = { conversationId, messageId: null, pts };
  });
  if (delivery) await deliver(delivery).catch(() => {});
}

// ─── Дом участника → хост: изменить состав ───────────────────────────────────────────────────────────────────────────

export type GroupOpAnswer = { status: number; body: Record<string, unknown> };

const HOST_DOWN: GroupOpAnswer = { status: 403, body: { error: FED_ERRORS.dmGroupHostDown } };

async function refOfUser(id: string, self: string): Promise<FedGroupProfile | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!u) return null;
  if (u.homeInstanceId) {
    if (!u.homeUserId) return null;
    return { ref: { instanceId: u.homeInstanceId, userId: u.homeUserId }, username: u.homeUsername || u.username, displayName: u.displayName, avatarHash: u.homeAvatarHash ?? null };
  }
  if (!reachableUser(u)) return null;
  return { ref: { instanceId: self, userId: u.id }, username: u.username, displayName: u.displayName, avatarHash: null };
}

/**
 * Действие с группой чужого дома (`routes/convGroups.ts`): подписанный POST хосту, он выполняет и разносит новую строку `conv`.
 * Хост недоступен, связка не работает — 403 `federation.dm_group_host_down`; отказ хоста — его код как есть.
 */
export async function groupOpRemote(
  me: string,
  conversationId: string,
  host: string,
  op: FedGroupOp,
  args: { targetId?: string; userIds?: readonly string[]; title?: string },
): Promise<GroupOpAnswer> {
  const id = federation.identity();
  const key = federation.signingKey();
  if (!id || !key) return HOST_DOWN;
  const link = await getLink(host);
  if (!link || linkVerdict(link, (await readInstanceMeta()).paused)) return HOST_DOWN;
  let target: FedPersonRef | null = null;
  if (op === 'remove') {
    target = args.targetId ? ((await refOfUser(args.targetId, id.instanceId))?.ref ?? null) : null;
    if (!target) return { status: 404, body: { error: 'not found' } };
  }
  const people: FedGroupProfile[] = [];
  const refused: string[] = [];
  for (const uid of args.userIds ?? []) {
    const p = await refOfUser(uid, id.instanceId);
    if (p) people.push(p);
    else refused.push(uid);
  }
  if (refused.length > 0) return { status: 403, body: { error: 'group_not_invitable', userIds: refused } };
  let hostName: string;
  try {
    hostName = new URL(link.apiBase).host;
  } catch {
    return HOST_DOWN;
  }
  const res = await postSignedToPeer({
    apiBase: link.apiBase,
    path: `/api${FED_GROUP_OP_PATH}`,
    payload: serializeGroupOp({
      instanceId: id.instanceId,
      conversationId,
      actorUserId: me,
      op,
      target,
      users: people,
      title: args.title ?? null,
    }),
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([hostName]),
    now: Date.now(),
  });
  if (!res.ok || res.value.status >= 500 || res.value.status === 429) return HOST_DOWN;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.value.body) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.value.status, body };
}

// ─── Хост: запрос участника ──────────────────────────────────────────────────────────────────────────────────────────

function answerOf(res: GroupOpResult | { kind: 'same' }): GroupOpAnswer {
  if (res.kind === 'same') return { status: 200, body: { ok: true } };
  if (res.kind === 'not-found') return { status: 404, body: { error: 'not found' } };
  if (res.kind === 'forbidden') return { status: 403, body: { error: 'forbidden' } };
  if (res.kind === 'empty') return { status: 400, body: { error: 'group_empty' } };
  if (res.kind === 'too-many') return { status: 409, body: { error: 'group_too_many', limit: GROUP_MEMBER_LIMIT } };
  return { status: 200, body: { ok: true } };
}

/** `POST /fed/v1/conv/group/op` на хосте: действующий — теневая строка человека отправителя, права — как у местного. */
export async function acceptGroupOp(link: { instanceId: string }, raw: Record<string, unknown>): Promise<GroupOpAnswer> {
  const o = parseGroupOp(raw);
  const self = federation.identity()?.instanceId;
  if (!o || !self || o.instanceId !== link.instanceId) return { status: 400, body: { error: 'bad request' } };
  const [c] = await db
    .select({ kind: conversations.kind, origin: conversations.originInstanceId })
    .from(conversations)
    .where(eq(conversations.id, o.conversationId))
    .limit(1);
  if (!c || c.kind !== 'group' || c.origin) return { status: 404, body: { error: 'not found' } };
  const actor = await shadowUserFor(link.instanceId, o.actorUserId);
  if (!actor) return { status: 404, body: { error: 'not found' } };
  const resolve = async (p: FedGroupProfile | { ref: FedPersonRef }): Promise<string | null> => {
    if (p.ref.instanceId === self) {
      const [u] = await db.select().from(users).where(and(eq(users.id, p.ref.userId), isNull(users.homeInstanceId))).limit(1);
      return u && reachableUser(u) ? u.id : null;
    }
    if (!(await groupInvitableHome(p.ref.instanceId))) return null;
    const profile = 'username' in p ? { username: p.username, displayName: p.displayName, avatarHash: p.avatarHash } : null;
    return (await ensureShadowUser(p.ref.instanceId, p.ref.userId, profile))?.id ?? null;
  };
  let res: GroupOpResult | { kind: 'same' };
  if (o.op === 'leave') res = await removeGroupMember(actor.id, o.conversationId, actor.id);
  else if (o.op === 'remove') {
    const target = o.target ? await resolve({ ref: o.target }) : null;
    if (!target) return { status: 404, body: { error: 'not found' } };
    res = await removeGroupMember(actor.id, o.conversationId, target);
  } else if (o.op === 'add') {
    const ids: string[] = [];
    for (const p of o.users) {
      const uid = await resolve(p);
      if (!uid) return { status: 403, body: { error: 'group_not_invitable' } };
      ids.push(uid);
    }
    if (ids.length === 0) return { status: 400, body: { error: 'group_empty' } };
    res = await addGroupMembers(actor.id, o.conversationId, ids);
  } else {
    const title = normalizeGroupTitle(o.title);
    if (!title) return { status: 400, body: { error: 'group_title' } };
    res = await updateGroupInfo(actor.id, o.conversationId, { title });
  }
  if (res.kind === 'ok') await deliver(res.delivery).catch(() => {});
  return answerOf(res);
}
