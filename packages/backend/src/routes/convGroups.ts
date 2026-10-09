import { isAnimatedImage } from '@gusvoice/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { isBlockedBy } from '../blocks.js';
import { addGroupMembers, createGroup, removeGroupMember, updateGroupInfo, type GroupOpResult } from '../convGroups.js';
import { deliver, findDirect, listConversations, type Delivery } from '../conversations.js';
import { db } from '../db/index.js';
import { shareServer } from '../db/peerQueries.js';
import { users } from '../db/schema.js';
import { decideDmOpen } from '../dmRules.js';
import { GROUP_MEMBER_LIMIT, GROUP_TITLE_MAX, normalizeGroupTitle } from '../groupRules.js';
import { requireLocalUser } from '../guestGuard.js';
import { dmPolicy } from '../instanceSetup.js';
import { sendPushToUsers } from '../push.js';
import { isSupportedImage, putMedia } from '../storage.js';
import { asUserId } from '../superAdminRules.js';
import { reachableUser } from '../userSearchRules.js';

/**
 * Групповые ЛС (07.10, #211, С4, признак `groups1`) — ручки. Запись — `convGroups.ts`, правила — `groupRules.ts`.
 * Позвать в группу можно только того, кому я могу написать в личку (те же правила, что у «Написать», `dmRules.decideDmOpen`:
 * общий сервер, уже есть переписка, супер-админ или политика инстанса `anyone` к своему живому человеку), и кто меня не
 * заблокировал. Предел — `GROUP_MEMBER_LIMIT` вместе с создателем (Р-5): ответ 409 `group_too_many` клиент показывает
 * подсказкой «Больше 5 — создайте сервер».
 */

const GROUP_OP_MAX = 20;
const WINDOW_S = 10;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const convParams = z.object({ id: z.string().min(1).max(64) });
const userIdList = z.array(z.string().min(1).max(64)).min(1).max(GROUP_MEMBER_LIMIT);

async function limited(reply: FastifyReply, me: string): Promise<boolean> {
  const wait = await rateHit(`conv-group:${me}`, GROUP_OP_MAX, WINDOW_S);
  if (!wait) return false;
  await reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
  return true;
}

/** Кого из `ids` звать НЕЛЬЗЯ (нет такого, гость, удалён, меня заблокировал, писать ему мне нельзя). */
async function notInvitable(me: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(users).where(inArray(users.id, [...ids]));
  const byId = new Map(rows.map((u) => [u.id, u]));
  const superAdmin = await isSuperAdmin(asUserId(me));
  const out: string[] = [];
  for (const id of ids) {
    const u = byId.get(id);
    if (!u || !reachableUser(u) || (await isBlockedBy(id, me))) {
      out.push(id);
      continue;
    }
    const exists = !!(await findDirect(me, id));
    const sharedServer = exists ? false : await shareServer(me, id);
    const policy = !exists && !sharedServer && !superAdmin ? await dmPolicy() : 'shared';
    const verdict = decideDmOpen({ exists, sharedServer, initiatorIsSuperAdmin: superAdmin, policy, peerReachable: true });
    if (verdict === 'no-shared-server' || verdict === 'peer-unreachable') out.push(id);
  }
  return out;
}

/** Ответ на действие: ошибка — код, иначе событие участникам и сводка группы глазами меня. */
async function answer(reply: FastifyReply, me: string, res: GroupOpResult, created = false) {
  if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
  if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
  if (res.kind === 'empty') return reply.code(400).send({ error: 'group_empty' });
  if (res.kind === 'too-many') return reply.code(409).send({ error: 'group_too_many', limit: GROUP_MEMBER_LIMIT });
  await deliver(res.delivery).catch(() => {});
  const list = await listConversations(me, true);
  const summary = list.conversations.find((c) => c.id === res.conversationId);
  return reply.code(created ? 201 : 200).send(summary ?? { id: res.conversationId, left: true });
}

/** Пуш добавленным: «Название» — «Имя добавил(а) …» (текст служебной записи). */
async function pushAdded(conversationId: string, delivery: Delivery, added: readonly string[]): Promise<void> {
  if (added.length === 0 || !delivery.messageId) return;
  const { conversationMessages, conversations } = await import('../db/schema.js');
  const [m] = await db.select({ content: conversationMessages.content }).from(conversationMessages).where(eq(conversationMessages.id, delivery.messageId));
  const [c] = await db.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, conversationId));
  await sendPushToUsers([...added], { type: 'dm', title: c?.title ?? '', body: m?.content ?? '', dmId: conversationId });
}

export async function convGroupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Создать группу: название обязательно (как Telegram), участники — кроме себя, всего с создателем ≤ 5. */
  app.post('/conv/group', { preHandler: requireLocalUser }, async (req, reply) => {
    const me = req.user!.sub;
    const body = z.object({ title: z.string().max(GROUP_TITLE_MAX * 4), userIds: z.array(z.string().min(1).max(64)).max(50) }).parse(req.body);
    const title = normalizeGroupTitle(body.title);
    if (!title) return reply.code(400).send({ error: 'group_title' });
    const ids = [...new Set(body.userIds)].filter((id) => id !== me);
    if (ids.length + 1 > GROUP_MEMBER_LIMIT) return reply.code(409).send({ error: 'group_too_many', limit: GROUP_MEMBER_LIMIT });
    if (await limited(reply, me)) return;
    const refused = await notInvitable(me, ids);
    if (refused.length > 0) return reply.code(403).send({ error: 'group_not_invitable', userIds: refused });
    const res = await createGroup(me, title, ids);
    if (res.kind === 'ok') void pushAdded(res.conversationId, res.delivery, ids).catch(() => {});
    return answer(reply, me, res, true);
  });

  /** Переименовать (любой участник). */
  app.patch('/conv/:id/group', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = convParams.parse(req.params);
    const title = normalizeGroupTitle(z.object({ title: z.string().max(GROUP_TITLE_MAX * 4) }).parse(req.body).title);
    if (!title) return reply.code(400).send({ error: 'group_title' });
    if (await limited(reply, me)) return;
    const res = await updateGroupInfo(me, id, { title });
    if (res.kind === 'same') return reply.code(200).send({ ok: true });
    return answer(reply, me, res);
  });

  /** Фото группы (любой участник): картинка, не анимация, до 5 МБ — как аватар человека (`routes/users.ts`). */
  app.post('/conv/:id/group/photo', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = convParams.parse(req.params);
    if (await limited(reply, me)) return;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    if (!isSupportedImage(file.mimetype)) return reply.code(400).send({ error: 'unsupported image type (png/jpeg/webp/gif)' });
    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' }); // обрезан по пределу multipart — см. att.ts
    if (buffer.length > MAX_PHOTO_BYTES) return reply.code(413).send({ error: 'image too large (max 5 MB)' });
    if (isAnimatedImage(new Uint8Array(buffer), file.mimetype)) return reply.code(400).send({ error: 'анимированное фото группы не поддерживается' });
    let url: string;
    try {
      url = await putMedia('group-avatars', id, buffer, file.mimetype, Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'upload failed' });
    }
    const res = await updateGroupInfo(me, id, { avatarUrl: url });
    if (res.kind === 'same') return reply.code(200).send({ ok: true });
    return answer(reply, me, res);
  });

  /** Добавить людей (любой участник; только тех, кому я могу написать). */
  app.post('/conv/:id/members', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = convParams.parse(req.params);
    const { userIds } = z.object({ userIds: userIdList }).parse(req.body);
    if (await limited(reply, me)) return;
    const ids = [...new Set(userIds)].filter((x) => x !== me);
    const refused = await notInvitable(me, ids);
    if (refused.length > 0) return reply.code(403).send({ error: 'group_not_invitable', userIds: refused });
    const res = await addGroupMembers(me, id, ids);
    if (res.kind === 'ok') void pushAdded(id, res.delivery, ids).catch(() => {});
    return answer(reply, me, res);
  });

  /** Удалить участника (только владелец); себя — то же, что «Покинуть группу». */
  app.delete('/conv/:id/members/:uid', async (req, reply) => {
    const me = req.user!.sub;
    const { id, uid } = z.object({ id: z.string().min(1).max(64), uid: z.string().min(1).max(64) }).parse(req.params);
    if (await limited(reply, me)) return;
    return answer(reply, me, await removeGroupMember(me, id, uid));
  });

  /** «Покинуть группу». */
  app.post('/conv/:id/leave', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = convParams.parse(req.params);
    if (await limited(reply, me)) return;
    return answer(reply, me, await removeGroupMember(me, id, me));
  });
}
