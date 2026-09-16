import type { AdminInstanceSettings, AdminServer, InstanceUpdateInfo, SmtpSettings } from '@gusvoice/shared';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { anonymizeAccount } from '../accountDelete.js';
import { requireSuperAdmin } from '../auth.js';
import { economyStats } from '../economyStats.js';
import { avatarPriceMinutes, INSTANCE_PRICE_MAX_MINUTES, setAvatarPriceMinutes } from '../instanceSettings.js';
import { db } from '../db/index.js';
import { channels, serverMembers, servers, users } from '../db/schema.js';
import { sendTestEmail } from '../mailer.js';
import { serializeUser } from '../serialize.js';
import { getSmtpConfig, isSmtpConfigured, setSmtpConfig, smtpSource, type SmtpConfig } from '../settings.js';
import { instanceMeta, registrationPolicy, setInstanceMeta, setRegistrationPolicy } from '../instanceSetup.js';
import { instanceUpdateInfo, writeUpdateRequest } from '../instanceUpdate.js';
import { normalizeReleaseVersion } from '../instanceUpdateRules.js';
import { cleanInstanceName, REGISTRATION_POLICIES } from '../setupRules.js';
import { isSupportedImage, putMedia } from '../storage.js';

const MAX_INSTANCE_ICON_BYTES = 2 * 1024 * 1024;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperAdmin);

  // All users on the instance.
  /**
   * Цена анимированного аватара — ручка ДЕРЖАТЕЛЯ ИНСТАНСА (решение 02.09).
   *
   * 🔴 Здесь, в админке инстанса, а не в настройках сервера: аватар единственная награда, которая
   * расходует хранилище и трафик ПОСТОЯННО, а платит за них держатель железа. Остальной прайс
   * остаётся у владельца сервера — это его валюта и его экономика.
   * 🔴 В МИНУТАХ сидения: минуты значат одно и то же на любом сервере, монеты — нет, у каждого своя
   * ставка. Каждый сервер переводит их в монеты сам.
   */
  app.get('/admin/economy', async () => {
    /**
     * ⚠️ Статистика идёт ВМЕСТЕ с ценой, а не отдельным запросом: держатель назначает минуты именно
     * по ней, и цена без статистики — число из воздуха. Два запроса разъехались бы во времени.
     */
    return {
      avatarPriceMinutes: await avatarPriceMinutes(),
      maxMinutes: INSTANCE_PRICE_MAX_MINUTES,
      stats: await economyStats(30),
    };
  });

  app.put('/admin/economy', async (req, reply) => {
    const body = z
      .object({ avatarPriceMinutes: z.number().int().min(0).max(INSTANCE_PRICE_MAX_MINUTES) })
      .parse(req.body);
    await setAvatarPriceMinutes(body.avatarPriceMinutes);
    return reply.send({ ok: true, avatarPriceMinutes: body.avatarPriceMinutes });
  });

  app.get('/admin/users', async () => {
    // Удалённые (обезличенные) аккаунты в списке не показываем: управлять там нечем (F0 #139).
    const rows = await db.select().from(users).where(isNull(users.deletedAt));
    return rows
      .map(serializeUser)
      .sort((a, b) => a.username.localeCompare(b.username));
  });

  // All servers (guilds) with channel/voice/member counts.
  app.get('/admin/servers', async () => {
    const [list, chans, mems, allUsers] = await Promise.all([
      db.select().from(servers),
      db.select({ serverId: channels.serverId, type: channels.type }).from(channels),
      db.select({ serverId: serverMembers.serverId }).from(serverMembers),
      db.select({ id: users.id, username: users.username }).from(users),
    ]);
    const usernameById = new Map(allUsers.map((u) => [u.id, u.username]));

    const result: AdminServer[] = list.map((s) => ({
      id: s.id,
      name: s.name,
      ownerId: s.ownerId,
      ownerUsername: usernameById.get(s.ownerId) ?? null,
      channels: chans.filter((c) => c.serverId === s.id).length,
      voiceChannels: chans.filter((c) => c.serverId === s.id && c.type === 'voice').length,
      members: mems.filter((m) => m.serverId === s.id).length,
      createdAt: s.createdAt.toISOString(),
    }));
    return result.sort((a, b) => a.name.localeCompare(b.name));
  });

  // Grant / revoke a user's ability to create servers.
  app.patch('/admin/users/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { canCreateServers } = z.object({ canCreateServers: z.boolean() }).parse(req.body);
    const [row] = await db.update(users).set({ canCreateServers }).where(eq(users.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'user not found' });
    return serializeUser(row);
  });

  // Manually verify a user — the super-admin approval that replaces the e-mail code when this
  // instance has no SMTP (turnkey installs without mail). Idempotent; lets the user log in.
  // С мастером установки (#142) это же — одобрение при политике `approval`: одна кнопка «Подтвердить» делает
  // аккаунт полностью рабочим (и почта, и одобрение), двух разных кнопок человеку не нужно.
  app.post('/admin/users/:id/verify', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [current] = await db.select({ approvedAt: users.approvedAt }).from(users).where(eq(users.id, id)).limit(1);
    const [row] = await db
      .update(users)
      .set({ verified: true, approvedAt: current?.approvedAt ?? new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'user not found' });
    return serializeUser(row);
  });

  // Delete a user (super-admin). Main use: "stuck" accounts that registered with a bogus e-mail —
  // they can't log in (unverified) but their username/email stay taken so nobody can re-register.
  // Can't delete yourself or a server owner (transfer/delete their servers first).
  // 🔴 Строка обезличивается, а не стирается: логин и почта освобождаются, переписка остаётся (F0 #139).
  app.delete('/admin/users/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (id === req.user!.sub) return reply.code(400).send({ error: 'нельзя удалить свой аккаунт' });
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row || row.deletedAt) return reply.code(404).send({ error: 'user not found' });
    const owned = await db.select({ id: servers.id }).from(servers).where(eq(servers.ownerId, id));
    // Супер-админ сюда попасть не может: маршрут доступен только ему, а себя удалить запрещено строкой выше.
    if (owned.length > 0) {
      return reply.code(409).send({ error: `Пользователь владеет серверами (${owned.length}) — сначала передайте или удалите их` });
    }
    await anonymizeAccount(id);
    return { ok: true };
  });

  // --- Инстанс: название, иконка, политика регистрации (мастер установки #142 и админ-панель) ---------------
  app.get('/admin/instance', async (): Promise<AdminInstanceSettings> => {
    const [meta, policy, smtp] = await Promise.all([instanceMeta(), registrationPolicy(), isSmtpConfigured()]);
    return { name: meta.name, iconUrl: meta.iconUrl, registration: policy, smtpConfigured: smtp };
  });

  app.put('/admin/instance', async (req, reply) => {
    const body = z
      .object({
        name: z.string().max(200).nullable().optional(),
        registration: z.enum(REGISTRATION_POLICIES).optional(),
      })
      .parse(req.body ?? {});
    if (body.name !== undefined) {
      const name = body.name === null ? null : cleanInstanceName(body.name);
      if (body.name !== null && !name) return reply.code(400).send({ error: 'Название: от 1 до 64 символов' });
      await setInstanceMeta({ name });
    }
    if (body.registration) await setRegistrationPolicy(body.registration);
    return reply.send({ ok: true });
  });

  // Иконка инстанса. Ключ с меткой времени, старый файл остаётся — как у иконок серверов.
  app.post('/admin/instance/icon', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'нет файла' });
    if (!isSupportedImage(file.mimetype)) return reply.code(400).send({ error: 'нужен PNG, JPEG, WebP или GIF' });
    const buffer = await file.toBuffer();
    if (buffer.length > MAX_INSTANCE_ICON_BYTES) return reply.code(413).send({ error: 'файл больше 2 МБ' });
    let iconUrl: string;
    try {
      iconUrl = await putMedia('instance-icons', 'instance', buffer, file.mimetype, Date.now());
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'не удалось загрузить' });
    }
    await setInstanceMeta({ iconUrl });
    return reply.send({ iconUrl });
  });

  app.delete('/admin/instance/icon', async () => {
    await setInstanceMeta({ iconUrl: null });
    return { ok: true };
  });

  // --- Обновление инстанса (О2б): бэкенд только просит хост, обновляет `update.sh --from-panel` ----------------
  // `?refresh=1` — «Проверить снова»: свежий выпуск спрашивается не чаще раза в минуту (instanceUpdateRules.ts).
  app.get('/admin/instance/update', async (req): Promise<InstanceUpdateInfo> => {
    const { refresh } = z.object({ refresh: z.string().optional() }).parse(req.query);
    return instanceUpdateInfo(refresh === '1');
  });

  app.post('/admin/instance/update', async (req, reply) => {
    const { version } = z.object({ version: z.string().max(32) }).parse(req.body ?? {});
    const info = await instanceUpdateInfo(false);
    if (!info.canUpdate || !info.latest) {
      return reply.code(409).send({ error: 'Обновление сейчас недоступно — обновите страницу', reason: info.blockedReason });
    }
    // Человек видел одну версию, а за это время вышла другая — пусть посмотрит, что ставит.
    if (normalizeReleaseVersion(version) !== info.latest.version) {
      return reply.code(409).send({ error: `Уже доступна ${info.latest.version} — обновите страницу`, reason: 'latest-changed' });
    }
    await writeUpdateRequest(info.latest.version);
    req.log.info({ from: info.installed, to: info.latest.version, by: req.user?.sub }, 'instance update requested from the panel');
    return reply.code(202).send({ ok: true });
  });

  // --- SMTP config: let the operator set up mail from the UI (no .env edit + rebuild) --------------
  // The effective config is the DB row if set, else the SMTP_* env vars (settings.ts). GET never
  // returns the stored password — `hasPass` just says whether one exists.
  app.get('/admin/smtp', async (): Promise<SmtpSettings> => {
    const cfg = await getSmtpConfig();
    return {
      host: cfg?.host ?? '',
      port: cfg?.port ?? 587,
      secure: cfg?.secure ?? false,
      user: cfg?.user ?? '',
      from: cfg?.from ?? '',
      hasPass: !!cfg?.pass,
      source: await smtpSource(),
    };
  });

  app.put('/admin/smtp', async (req, reply) => {
    const body = z
      .object({
        host: z.string().trim(),
        port: z.number().int().min(1).max(65535).default(587),
        secure: z.boolean().default(false),
        user: z.string().trim().default(''),
        pass: z.string().optional(), // omitted/empty => keep the currently-stored password
        from: z.string().trim().default(''),
      })
      .parse(req.body);
    // Empty host clears the DB override (fall back to env, or log-only if env is empty too).
    if (!body.host) {
      await setSmtpConfig(null);
      return reply.send({ ok: true, cleared: true });
    }
    const current = await getSmtpConfig();
    const cfg: SmtpConfig = {
      host: body.host,
      port: body.port,
      secure: body.secure,
      user: body.user,
      pass: body.pass && body.pass.length ? body.pass : current?.pass ?? '',
      from: body.from || `GusVoice <noreply@${body.host}>`,
    };
    await setSmtpConfig(cfg);
    return reply.send({ ok: true });
  });

  // Send a test e-mail with the saved config (the panel's "Проверить" button). Save first, then test.
  app.post('/admin/smtp/test', async (req, reply) => {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    try {
      await sendTestEmail(to);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
