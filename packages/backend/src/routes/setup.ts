/**
 * Мастер первичной настройки (О2 плана открытия кода, #142) и публичные сведения об инстансе.
 *
 * Сценарий: `install.sh` печатает адрес и код → человек открывает сайт → код → создаёт супер-админа (сразу
 * входит) → шаги мастера идут обычными админ-ручками → `POST /setup/complete`. Правила — `setupRules.ts`,
 * решения — `docs/open-source-plan.md` §3.1.1.
 */
import type { AuthResponse, InstanceInfo, SetupStatus, VoiceTestToken } from '@gusvoice/shared';
import { randomUUID } from 'node:crypto';
import { or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, requireSuperAdmin, setSuperAdminId, signToken, superAdminId } from '../auth.js';
import { clientIp, rateHit, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { instanceSettings, users } from '../db/schema.js';
import { env } from '../env.js';
import { instanceMeta, markSetup, registrationPolicy, setupState } from '../instanceSetup.js';
import { createVoiceTestToken } from '../livekit.js';
import { serializeUser } from '../serialize.js';
import {
  decideSetupAdmin,
  hashSetupToken,
  SETUP_KEY,
  wizardPending,
  type SetupAdminDecision,
} from '../setupRules.js';
import { SUPERADMIN_ID_KEY } from '../superAdminRules.js';
import { id } from '../util.js';
import { registerBody } from './auth.js';

/** 10 попыток ввести код за 15 минут с одного адреса и 100 на весь инстанс — перебор 60-битного кода бессмыслен. */
const SETUP_IP_MAX = 10;
const SETUP_GLOBAL_MAX = 100;
const SETUP_WINDOW_S = 15 * 60;

const tokenBody = z.object({ token: z.string().min(1).max(64) });

const adminBody = registerBody.extend({
  token: z.string().min(1).max(64),
  password: z.string().min(8, 'Пароль супер-админа: минимум 8 символов').max(128, 'Пароль: максимум 128 символов'),
});

class AlreadySetUpError extends Error {}

/** Ответ на отказ мастера — текст человеку и машинная причина. */
function refuse(reply: FastifyReply, decision: Exclude<SetupAdminDecision, 'ok'>) {
  switch (decision) {
    case 'already-set-up':
      return reply.code(409).send({ error: 'Инстанс уже настроен — войдите обычным логином', reason: 'already_set_up' });
    case 'no-token':
      return reply.code(503).send({
        error: 'В .env нет SETUP_TOKEN. Запустите ./install.sh заново или задайте SETUP_TOKEN и перезапустите бэкенд.',
        reason: 'no_setup_token',
      });
    case 'bad-token':
      return reply.code(403).send({ error: 'Код установки не подходит', reason: 'bad_setup_token' });
  }
}

async function limited(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const wait =
    (await rateHit(`setup:${clientIp(req)}`, SETUP_IP_MAX, SETUP_WINDOW_S)) ||
    (await rateHit('setup:global', SETUP_GLOBAL_MAX, SETUP_WINDOW_S));
  if (!wait) return false;
  await reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
  return true;
}

async function decide(givenToken: string): Promise<SetupAdminDecision> {
  const state = await setupState();
  return decideSetupAdmin({
    superAdminBound: !!superAdminId(),
    expectedToken: env.setupToken,
    givenToken,
    consumedTokenHash: state.consumedTokenHash,
  });
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  // Публично: экран входа по нему решает, показывать ли мастер, а регистрация — нужно ли поле кода приглашения.
  app.get('/instance', async (): Promise<InstanceInfo> => {
    const [meta, policy] = await Promise.all([instanceMeta(), registrationPolicy()]);
    return { name: meta.name, iconUrl: meta.iconUrl, registration: policy };
  });

  app.get('/setup/status', async (): Promise<SetupStatus> => {
    const bound = !!superAdminId();
    return {
      needsSetup: !bound,
      tokenConfigured: !!env.setupToken.trim(),
      wizardPending: wizardPending(await setupState(), bound),
    };
  });

  // Шаг 1 мастера: проверить код, не создавая ничего (чтобы форма админа открылась только после верного кода).
  app.post('/setup/check-token', async (req, reply) => {
    if (await limited(req, reply)) return;
    const { token } = tokenBody.parse(req.body);
    const decision = await decide(token);
    if (decision !== 'ok') return refuse(reply, decision);
    return reply.code(204).send();
  });

  // Шаг 2: создать супер-админа и сразу войти. Одна транзакция — две вкладки не создадут двух админов.
  app.post('/setup/admin', async (req, reply) => {
    if (await limited(req, reply)) return;
    const body = adminBody.parse(req.body);
    const decision = await decide(body.token);
    if (decision !== 'ok') return refuse(reply, decision);

    const now = new Date();
    let row: typeof users.$inferSelect;
    try {
      const created = await db.transaction(async (tx) => {
        const clash = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            or(
              sql`lower(${users.username}) = ${body.username.trim().toLowerCase()}`,
              sql`lower(${users.email}) = ${body.email.trim().toLowerCase()}`,
            ),
          )
          .limit(1);
        if (clash.length) return null;
        const [inserted] = await tx
          .insert(users)
          .values({
            id: id(),
            username: body.username,
            email: body.email,
            displayName: body.displayName ?? body.username,
            passwordHash: await hashPassword(body.password),
            verified: true,
            approvedAt: now,
          })
          .returning();
        // 🔴 Привязка — вставкой с условием «ещё нет»: проиграл гонку → откат всей транзакции, аккаунта не будет.
        const bound = await tx
          .insert(instanceSettings)
          .values({ key: SUPERADMIN_ID_KEY, value: { userId: inserted.id }, updatedAt: now })
          .onConflictDoNothing({ target: instanceSettings.key })
          .returning({ key: instanceSettings.key });
        if (!bound.length) throw new AlreadySetUpError();
        const setupValue = {
          adminCreatedAt: now.toISOString(),
          completedAt: null,
          consumedTokenHash: hashSetupToken(env.setupToken),
        };
        await tx
          .insert(instanceSettings)
          .values({ key: SETUP_KEY, value: setupValue, updatedAt: now })
          .onConflictDoUpdate({ target: instanceSettings.key, set: { value: setupValue, updatedAt: now } });
        return inserted;
      });
      if (!created) return reply.code(409).send({ error: 'username or email already in use' });
      row = created;
    } catch (err) {
      if (err instanceof AlreadySetUpError) return refuse(reply, 'already-set-up');
      throw err;
    }

    setSuperAdminId(row.id);
    req.log.info({ userId: row.id }, 'setup: super-admin created by the setup wizard');
    const res: AuthResponse = {
      token: signToken({ sub: row.id, username: row.username, gen: row.tokenGeneration }),
      user: serializeUser(row),
    };
    return reply.code(201).send(res);
  });

  // Последний шаг мастера (или «пропустить настройку»): больше мастер не показываем.
  app.post('/setup/complete', { preHandler: requireSuperAdmin }, async () => {
    await markSetup({ completedAt: new Date().toISOString() });
    return { ok: true };
  });

  // Проверка голоса из браузера: подключение к служебной комнате доказывает, что медиа-порты открыты.
  app.post('/setup/voice-test', { preHandler: requireSuperAdmin }, async (req): Promise<VoiceTestToken> => {
    const room = `setup-voice-test-${randomUUID()}`;
    const token = await createVoiceTestToken(`setup-test-${req.user!.sub}`, room);
    return { url: env.livekit.urlExternal, token, room };
  });
}
