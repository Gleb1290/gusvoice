import { has, Permission } from '@gusvoice/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { bans, invites, memberRoles, serverFederationExclusions, serverMembers, servers, users } from '../db/schema.js';
import { inviteRefusalForGuest } from '../federation/guestRules.js';
import { announceMembership } from '../federation/guestMembership.js';
import { instanceBanFor } from '../federation/instanceBan.js';
import { FED_ERRORS, FED_MEMBERSHIP_STATES, type InviteScopeView } from '@gusvoice/shared';
import { env } from '../env.js';
import { listLinks } from '../federation/links.js';
import { linkDisplayNames } from '../federation/linkRules.js';
import { readInstanceMeta } from '../federation/instanceMeta.js';
import { getMemberContext } from '../permissions.js';
import { publishToServer } from '../realtime.js';
import { serializeInvite } from '../serialize.js';
import { inviteCode } from '../util.js';
import { buildBootstrap } from './servers.js';
import { inviteLockRemaining, recordInviteFailure } from '../inviteGuard.js';
import { clientIp } from '../authGuard.js';
import { isInviteSpent } from '../inviteRules.js';
import { inviteLockMessage, invitePreview, lookupInviteGuarded, type InviteLookupDeps } from '../inviteLookup.js';

/** Замок перебора и поиск кода — общие у чтения и вступления (`inviteLookup.ts`). */
const inviteLookupDeps: InviteLookupDeps<typeof invites.$inferSelect> = {
  lockRemaining: (userId) => inviteLockRemaining(userId),
  recordFailure: (userId, ip) => recordInviteFailure(userId, ip),
  findInvite: async (code) => {
    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    return invite ?? null;
  },
};

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Create an invite for a server, with optional expiry (minutes) and max-uses.
  app.post('/servers/:id/invites', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        expiresInMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
        maxUses: z.number().int().min(1).max(1000).nullable().optional(),
      })
      .parse(req.body ?? {});

    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });

    const expiresAt = body.expiresInMinutes ? new Date(Date.now() + body.expiresInMinutes * 60_000) : null;
    const [row] = await db
      .insert(invites)
      .values({ code: inviteCode(), serverId, inviterId: req.user!.sub, expiresAt, maxUses: body.maxUses ?? null })
      .returning();
    return reply.code(201).send(serializeInvite(row));
  });

  // List a server's active (non-expired, non-exhausted) invites. CREATE_INVITE.
  app.get('/servers/:id/invites', async (req, reply) => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });

    const rows = await db.select().from(invites).where(eq(invites.serverId, serverId)).orderBy(desc(invites.createdAt));
    return rows.filter((r) => !isInviteSpent(r, Date.now())).map(serializeInvite);
  });

  /**
   * Где сработает ссылка этого сервера (§4.2, требование 13).
   *
   * 🔴 Маршрут живёт ЗДЕСЬ, а не среди федеративных: те регистрируются только при включённой
   * федерации, а подсказка нужна всегда — на инстансе без федерации она честно говорит «только для
   * своих». Окно создания ссылки не должно знать, включена ли федерация, чтобы решить, спрашивать ли.
   */
  app.get('/servers/:id/invite-scope', async (req, reply): Promise<InviteScopeView | undefined> => {
    const { id: serverId } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await getMemberContext(serverId, req.user!.sub);
    if (!ctx) return reply.code(404).send({ error: 'not a member' });
    if (!has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    const meta = await readInstanceMeta();
    const base: InviteScopeView = {
      clientOrigin: env.clientOrigin,
      instanceName: meta.name,
      federated: !!server?.federatedAccess,
      peers: [],
    };
    if (!env.federation.enabled || !base.federated) return base;

    // Исключения по связке (§5.3): сервер может быть открыт всем, кроме одного соседа, — и называть
    // его в подсказке значило бы обещать вход, которого не будет.
    const excluded = new Set(
      (
        await db
          .select({ instanceId: serverFederationExclusions.instanceId })
          .from(serverFederationExclusions)
          .where(eq(serverFederationExclusions.serverId, serverId))
      ).map((r) => r.instanceId),
    );
    const links = await listLinks();
    // Имена — с защитой от одноимённых (F-11, мегаприёмка 23.09): сосед, назвавшийся как мы, в подсказке
    // «где сработает» выглядел бы нашим же инстансом.
    const names = linkDisplayNames(links, (await readInstanceMeta()).name);
    base.peers = links
      .filter((l) => l.state === 'active' && !excluded.has(l.instanceId))
      .map((l) => names.get(l.instanceId) ?? l.domain);
    return base;
  });

  // Inspect an invite (server name/id). Порядок защиты от перебора и отказ гостю — `inviteLookup.ts`.
  app.get('/invites/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const res = await invitePreview(
      {
        ...inviteLookupDeps,
        findServer: async (serverId) => {
          const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
          return server ?? null;
        },
        homeOf: async (userId) => {
          const [me] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, userId)).limit(1);
          return me?.home ?? null;
        },
        excludedFor: async (serverId, instanceId) => {
          const [excluded] = await db
            .select()
            .from(serverFederationExclusions)
            .where(
              and(eq(serverFederationExclusions.serverId, serverId), eq(serverFederationExclusions.instanceId, instanceId)),
            )
            .limit(1);
          return Boolean(excluded);
        },
        now: () => Date.now(),
      },
      { userId: req.user!.sub, ip: clientIp(req), code },
    );
    return reply.code(res.status).send(res.body);
  });

  // Revoke an invite — the inviter, or anyone with CREATE_INVITE on its server.
  app.delete('/invites/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) return reply.code(404).send({ error: 'invalid invite' });
    if (invite.inviterId !== req.user!.sub) {
      const ctx = await getMemberContext(invite.serverId, req.user!.sub);
      if (!ctx || !has(ctx.serverPermissions, Permission.CREATE_INVITE)) return reply.code(403).send({ error: 'forbidden' });
    }
    await db.delete(invites).where(eq(invites.code, code));
    return reply.code(204).send();
  });

  // Accept an invite — join the server. Increments the use counter on a real join.
  app.post('/invites/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const userId = req.user!.sub;

    // Защита от перебора — та же, что у чтения (`lookupInviteGuarded`): в блокировке код не ищем вовсе,
    // промах считаем, и если он включил блокировку — 429, иначе обычный 404.
    const ip = clientIp(req);
    const found = await lookupInviteGuarded(inviteLookupDeps, { userId, ip, code });
    if (found.kind === 'locked') return reply.code(429).send({ error: inviteLockMessage(found.retryS) });
    if (found.kind === 'missing') return reply.code(404).send({ error: 'invalid invite' });
    const invite = found.invite;
    // 🔴 Счётчик промахов обнуляется только при НАСТОЯЩЕМ вступлении (ниже), а не на любом найденном
    // коде (ревью #195 п. 3): свой собственный код иначе сбрасывал бы блокировку перебора без конца.
    if (isInviteSpent(invite, Date.now())) return reply.code(410).send({ error: 'invite expired' });

    const [banned] = await db
      .select()
      .from(bans)
      .where(and(eq(bans.serverId, invite.serverId), eq(bans.userId, userId)))
      .limit(1);
    if (banned) return reply.code(403).send({ error: 'вы забанены на этом сервере' });

    /**
     * Гость с другого инстанса (#139, F3, §5.5) — ему той же ссылки МАЛО.
     *
     * 🔴 Проверка стоит на ХОСТЕ, а не на клиенте и не на его доме: дом чужой, и верить ему решение
     * «пускать ли на наш сервер» нельзя в принципе. Здесь же и бессрочная ссылка (требование 13), и
     * галочка федеративного доступа, и исключение по связке — одним правилом (`inviteRefusalForGuest`),
     * тем же, по которому отвечает предпросмотр: два правила разошлись бы, и разошлись бы молча.
     */
    const [me] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const guestHome = me?.homeInstanceId ?? null;
    const [inviteServer] = await db.select().from(servers).where(eq(servers.id, invite.serverId)).limit(1);
    if (guestHome) {
      /**
       * Запрет на инстанс (§5.11) проверяется ДО ссылки: человеку закрыт вход целиком, и годная
       * ссылка этого не отменяет. Сессия у него могла остаться с прошлого раза — она и приведёт
       * его сюда.
       */
      if (me?.homeUserId && (await instanceBanFor(guestHome, me.homeUserId))) {
        return reply.code(403).send({ error: FED_ERRORS.banned });
      }
      const [excluded] = await db
        .select()
        .from(serverFederationExclusions)
        .where(
          and(
            eq(serverFederationExclusions.serverId, invite.serverId),
            eq(serverFederationExclusions.instanceId, guestHome),
          ),
        )
        .limit(1);
      const refusal = inviteRefusalForGuest({
        invite,
        server: inviteServer ?? null,
        excludedForLink: Boolean(excluded),
        now: Date.now(),
      });
      if (refusal) return reply.code(403).send({ error: refusal });
    }

    const [existing] = await db
      .select()
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, invite.serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    if (!existing) {
      await db
        .insert(serverMembers)
        .values({
          serverId: invite.serverId,
          userId,
          // Как вошёл и кто позвал: по этому дом покажет скрывшему админу «виден на сервере «Кино» —
          // вошёл по ссылке, ссылку создал N» (§5.2.1).
          joinMethod: guestHome ? 'invite' : null,
          invitedBy: guestHome ? invite.inviterId : null,
        })
        .onConflictDoNothing();
      await db.update(invites).set({ uses: sql`${invites.uses} + 1` }).where(eq(invites.code, code));
      // Счётчик промахов вступление НЕ обнуляет (#196 п. 3): «вступил → вышел» повторяемо, см. `inviteGuard`.
      // Новичок получает bootstrap прямо в ответе, а вот у ОСТАЛЬНЫХ ростер без этого события
      // обновится только при перезаходе.
      await publishToServer(invite.serverId, { t: 'server.invalidate', serverId: invite.serverId });
      if (guestHome && me) {
        await announceMembership({ guest: me, serverId: invite.serverId, state: FED_MEMBERSHIP_STATES.active });
      }
    } else if (guestHome && existing.state === FED_MEMBERSHIP_STATES.closedByHost) {
      // Членство есть, но закрыто держателем (§5.3.1): ссылка его не оживляет — это решение хозяина
      // сервера, а не вопрос наличия приглашения.
      return reply.code(403).send({ error: 'federation.server_closed' });
    } else if (guestHome && existing.state === FED_MEMBERSHIP_STATES.removed) {
      /**
       * 🔴 `removed` — «человека здесь больше нет», и по ссылке он входит ЗАНОВО (§5.11: «сняли
       * запрет — можно снова войти по ссылке»).
       *
       * Раньше сюда попадал тот же отказ, что и у закрытого держателем сервера, и это была не
       * мелочь, а тупик навсегда: снятый запрет (или отзыв аккаунта) оставлял строку в `removed`, и
       * человеку на КАЖДУЮ следующую ссылку отвечали «сервер закрыт для других инстансов» — текст,
       * который вдобавок врёт: сервер открыт, закрыт был он сам, и это уже отменили. Нашлось на
       * стенде 19.09, сразу после снятия тестового запрета.
       *
       * ⚠️ Роли снимаются: «прежние членства не возвращаются» — вход новый, а старые роли пережили
       * бы его молча. Сообщения остаются: их не отбирают ни при бане, ни при возвращении.
       */
      await db.delete(memberRoles).where(and(eq(memberRoles.serverId, invite.serverId), eq(memberRoles.userId, userId)));
      await db
        .update(serverMembers)
        .set({
          state: FED_MEMBERSHIP_STATES.active,
          joinedAt: new Date(),
          joinMethod: 'invite',
          invitedBy: invite.inviterId,
        })
        .where(and(eq(serverMembers.serverId, invite.serverId), eq(serverMembers.userId, userId)));
      await db.update(invites).set({ uses: sql`${invites.uses} + 1` }).where(eq(invites.code, code));
      await publishToServer(invite.serverId, { t: 'server.invalidate', serverId: invite.serverId });
      if (me) await announceMembership({ guest: me, serverId: invite.serverId, state: FED_MEMBERSHIP_STATES.active });
    }

    return buildBootstrap(invite.serverId, userId);
  });
}
