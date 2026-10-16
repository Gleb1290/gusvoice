import type { AdminInstanceSettings, AdminServer, AdminUser, InstanceUpdateInfo, SmtpSettings } from '@gusvoice/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { anonymizeAccount } from '../accountDelete.js';
import { requireSuperAdmin } from '../auth.js';
import { economyStats } from '../economyStats.js';
import { avatarPriceMinutes, INSTANCE_PRICE_MAX_MINUTES, setAvatarPriceMinutes } from '../instanceSettings.js';
import { db } from '../db/index.js';
import {
  channels,
  federationMemberships,
  federationPeerUsers,
  serverFederationExclusions,
  serverMembers,
  servers,
  users,
} from '../db/schema.js';
import { closeServerForGuests, reopenServerForGuests, CLOSE_REASONS } from '../federation/guestAccess.js';
import { announceServer, announceUser } from '../federation/directoryEvents.js';
import { listLinks } from '../federation/links.js';
import { linkDisplayNames } from '../federation/linkRules.js';
import { readInstanceMeta } from '../federation/instanceMeta.js';
import { sendTestEmail } from '../mailer.js';
import { serializeUser } from '../serialize.js';
import { getSmtpConfig, isSmtpConfigured, setSmtpConfig, smtpSource, type SmtpConfig } from '../settings.js';
import { DM_POLICIES } from '../dmRules.js';
import { env } from '../env.js';
import { FED_DM_POLICIES } from '@gusvoice/shared';
import {
  dmPolicy,
  fedDmPolicy,
  instanceMeta,
  registrationPolicy,
  setDmPolicy,
  setFedDmPolicy,
  setInstanceMeta,
  setRegistrationPolicy,
} from '../instanceSetup.js';
import { instanceUpdateInfo, writeUpdateRequest } from '../instanceUpdate.js';
import { closeDmReport, listDmReports } from '../dmReports.js';
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

  app.get('/admin/users', async (req) => {
    // Удалённые (обезличенные) аккаунты в списке не показываем: управлять там нечем (F0 #139).
    // 🔴 И гостей тоже (23.09, #204): теневые строки соседей стояли в группе «Этот инстанс» как наши
    // люди — с пустой почтой и кнопками удаления/подтверждения, которые к ним неприменимы. Правило F3:
    // любой список «наших людей» обязан отсекать `home_instance_id IS NULL`. Гости видны в группе своего
    // инстанса (каталог соседа), а запрет на инстанс — отдельным путём.
    const rows = await db
      .select()
      .from(users)
      .where(and(isNull(users.deletedAt), isNull(users.homeInstanceId)));

    /**
     * «Скрыт от соседей, но виден» (§5.2.1) — отметка у СКРЫТЫХ людей.
     *
     * 🔴 Скрытие убирает человека только из каталога; войти по ссылке он вправе, и там он обычный
     * участник. Админ, который его скрывал, обязан это видеть — иначе он считает, что человека у
     * соседей нет вовсе, и принимает решения по неверной картине.
     * ⚠️ Список берётся из индекса членств (он и заводился ради этого), и ТОЛЬКО для скрытых:
     * тянуть его для всех значило бы при каждом открытии вкладки собирать карту «кто где гостит».
     */
    const hiddenIds = rows.filter((r) => r.hiddenFromPeers).map((r) => r.id);
    const guestRows = hiddenIds.length
      ? await db
          .select()
          .from(federationMemberships)
          .where(inArray(federationMemberships.userId, hiddenIds))
      : [];
    // С защитой от одноимённых (F-11, мегаприёмка 23.09) — как везде, где держатель видит имя соседа.
    const links = await listLinks();
    const shown = linkDisplayNames(links, (await readInstanceMeta()).name);
    const names = new Map(links.map((l) => [l.instanceId, shown.get(l.instanceId) ?? l.domain]));
    /**
     * Кто создал ссылку — хост присылает СВОЙ идентификатор человека, и в таком виде он держателю
     * бесполезен. Имя достаём из кеша каталога этого соседа (F2): именно для таких случаев кеш и
     * нужен — спрашивать соседа ради одной строки в списке пользователей мы не пойдём.
     *
     * ⚠️ Не нашлось — оставляем пусто и показываем «вошёл по ссылке» без имени. Выдумывать
     * «неизвестный» не за что: человека могли скрыть у соседа или удалить, и это не наша ошибка.
     */
    const inviterIds = [...new Set(guestRows.map((g) => g.invitedBy).filter((v): v is string => !!v))];
    const inviterRows = inviterIds.length
      ? await db
          .select({
            instanceId: federationPeerUsers.instanceId,
            userId: federationPeerUsers.userId,
            displayName: federationPeerUsers.displayName,
            username: federationPeerUsers.username,
          })
          .from(federationPeerUsers)
          .where(inArray(federationPeerUsers.userId, inviterIds))
      : [];
    const inviterName = new Map(
      inviterRows.map((r) => [`${r.instanceId}:${r.userId}`, r.displayName || r.username]),
    );
    const guestAt = new Map<string, NonNullable<AdminUser['guestAt']>>();
    for (const g of guestRows) {
      if (g.state !== 'active') continue;
      const list = guestAt.get(g.userId) ?? [];
      list.push({
        instance: names.get(g.instanceId) ?? g.instanceId,
        serverName: g.serverName,
        method: g.method,
        invitedBy: g.invitedBy,
        invitedByName: g.invitedBy ? (inviterName.get(`${g.instanceId}:${g.invitedBy}`) ?? null) : null,
        at: g.updatedAt,
      });
      guestAt.set(g.userId, list);
    }

    return rows
      // «Скрыт от соседей» живёт только здесь, а не в общем `serializeUser`: это знание админ-панели,
      // и обычным клиентам оно не нужно (F2, §5.2.1).
      .map((row) => ({
        ...serializeUser(row, req.user!.sub),
        hiddenFromPeers: row.hiddenFromPeers,
        guestAt: guestAt.get(row.id) ?? [],
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  });

  /**
   * «Скрыть от соседей» (F2, §5.2.1).
   *
   * 🔴 Скрытие убирает человека ТОЛЬКО из каталога. Уже вошедшего к соседу по ссылке оно не выгоняет:
   * там он остаётся обычным участником, иначе у него сломались бы переписка и голос. Соседям уезжает
   * надгробие — без ника: скрытый скрыт и от того, кто читает причину исчезновения.
   */
  app.patch('/admin/users/:id/hidden', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    const [row] = await db.update(users).set({ hiddenFromPeers: hidden }).where(eq(users.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'user not found' });
    // Рассылка сама двигает время правки каталога и переживает лежачего соседа (событие ляжет в очередь).
    await announceUser(id);
    return { ...serializeUser(row, req.user!.sub), hiddenFromPeers: hidden };
  });

  // All servers (guilds) with channel/voice/member counts.
  app.get('/admin/servers', async () => {
    const [list, chans, mems, allUsers, exclusions] = await Promise.all([
      db.select().from(servers),
      db.select({ serverId: channels.serverId, type: channels.type }).from(channels),
      db.select({ serverId: serverMembers.serverId }).from(serverMembers),
      db.select({ id: users.id, username: users.username }).from(users),
      db.select().from(serverFederationExclusions),
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
      federatedAccess: s.federatedAccess,
      federationExclusions: exclusions.filter((e) => e.serverId === s.id).map((e) => e.instanceId),
    }));
    return result.sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * «Разрешить федеративный доступ» и исключения по связке (F2, §5.3, требования 17 и 32).
   *
   * 🔴 Маршрут доступен ТОЛЬКО админу инстанса — как и вся эта админка. Владелец сервера и роль с
   * правом управлять сервером сюда не попадают вовсе: решение «пускать ли к нам чужие инстансы»
   * принимает тот, кто держит железо, а не тот, кто завёл сервер.
   * ⚠️ Исключения заменяются целиком, а не по одному: интерфейс показывает список галочек, и «снять
   * одну» и «снять все, кроме одной» должны приводить к одному и тому же состоянию.
   */
  app.patch('/admin/servers/:id/federation', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ enabled: z.boolean(), exclusions: z.array(z.string()).max(100).optional() })
      .parse(req.body);
    const [row] = await db
      .update(servers)
      .set({ federatedAccess: body.enabled })
      .where(eq(servers.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'server not found' });

    if (body.exclusions) {
      await db.delete(serverFederationExclusions).where(eq(serverFederationExclusions.serverId, id));
      if (body.exclusions.length > 0) {
        await db
          .insert(serverFederationExclusions)
          .values(body.exclusions.map((instanceId) => ({ serverId: id, instanceId })));
      }
    }

    /**
     * Доступ гостям закрывается и возвращается ЗДЕСЬ ЖЕ (F3, §5.3.1), а не «когда-нибудь потом».
     *
     * 🔴 Держатель снял галочку — человек, сидящий сейчас в голосовом канале, обязан выпасть и
     * увидеть окно с причиной. Иначе он продолжает говорить на сервере, куда ему уже закрыт вход, а
     * узнаёт об этом при следующем заходе — и выглядит это как поломка, а не как чужое решение.
     *
     * ⚠️ Считается СОСТОЯНИЕ, а не разница с прошлым: «галочка + список исключений» полностью
     * определяют, кто внутри. Разница потребовала бы, чтобы прошлое было верным, — а оно могло
     * разъехаться от неудавшегося события или отката базы.
     */
    if (!body.enabled) {
      await closeServerForGuests({ serverId: id, reason: CLOSE_REASONS.federationDisabled });
    } else {
      await reopenServerForGuests({ serverId: id });
      const current = await db
        .select({ instanceId: serverFederationExclusions.instanceId })
        .from(serverFederationExclusions)
        .where(eq(serverFederationExclusions.serverId, id));
      for (const e of current) {
        await closeServerForGuests({
          serverId: id,
          instanceId: e.instanceId,
          reason: CLOSE_REASONS.federationDisabled,
        });
      }
    }

    // Каждому соседу уедет СВОЯ карточка: у исключённого — надгробие (см. `announceServer`).
    await announceServer(id);
    const current = await db
      .select({ instanceId: serverFederationExclusions.instanceId })
      .from(serverFederationExclusions)
      .where(eq(serverFederationExclusions.serverId, id));
    return { federatedAccess: row.federatedAccess, federationExclusions: current.map((e) => e.instanceId) };
  });

  // Grant / revoke a user's ability to create servers.
  app.patch('/admin/users/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { canCreateServers } = z.object({ canCreateServers: z.boolean() }).parse(req.body);
    const [row] = await db.update(users).set({ canCreateServers }).where(eq(users.id, id)).returning();
    if (!row) return reply.code(404).send({ error: 'user not found' });
    return serializeUser(row, req.user!.sub);
  });

  // Manually verify a user — the super-admin approval that replaces the e-mail code when this
  // instance has no SMTP (turnkey installs without mail). Idempotent; lets the user log in.
  // С мастером установки (#142) это же — одобрение при политике `approval`: одна кнопка «Подтвердить» делает
  // аккаунт полностью рабочим (и почта, и одобрение), двух разных кнопок человеку не нужно.
  // Жалобы из ЛС («Пожаловаться» на плашке незнакомца, 08.10, #211, С7, `stranger1`): их читает только держатель инстанса.
  app.get('/admin/dm-reports', async () => ({ reports: await listDmReports() }));
  app.post('/admin/dm-reports/:id/close', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    if (!(await closeDmReport(id))) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post('/admin/users/:id/verify', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [current] = await db.select({ approvedAt: users.approvedAt }).from(users).where(eq(users.id, id)).limit(1);
    const [row] = await db
      .update(users)
      .set({ verified: true, approvedAt: current?.approvedAt ?? new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'user not found' });
    // Подтверждённый аккаунт впервые попадает в каталог соседей (F2): до этого его там не было.
    await announceUser(id);
    return serializeUser(row, req.user!.sub);
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
  // и (05.10) кто может начать личную переписку — `dmPolicy` (`dmRules.ts`; нет записи = `shared`).
  app.get('/admin/instance', async (): Promise<AdminInstanceSettings> => {
    const [meta, policy, smtp, dm] = await Promise.all([instanceMeta(), registrationPolicy(), isSmtpConfigured(), dmPolicy()]);
    // Э1 ЛС между инстансами (Ф6): поле есть, только пока включён `FEDERATION_DM_ENABLED` — иначе выбора в панели нет.
    const fedDm = env.federation.dmEnabled ? { fedDmPolicy: await fedDmPolicy() } : {};
    return { name: meta.name, iconUrl: meta.iconUrl, registration: policy, smtpConfigured: smtp, dmPolicy: dm, ...fedDm };
  });

  app.put('/admin/instance', async (req, reply) => {
    const body = z
      .object({
        name: z.string().max(200).nullable().optional(),
        registration: z.enum(REGISTRATION_POLICIES).optional(),
        dmPolicy: z.enum(DM_POLICIES).optional(),
        fedDmPolicy: z.enum(FED_DM_POLICIES).optional(),
      })
      .parse(req.body ?? {});
    if (body.name !== undefined) {
      const name = body.name === null ? null : cleanInstanceName(body.name);
      if (body.name !== null && !name) return reply.code(400).send({ error: 'Название: от 1 до 64 символов' });
      await setInstanceMeta({ name });
    }
    if (body.registration) await setRegistrationPolicy(body.registration);
    if (body.dmPolicy) await setDmPolicy(body.dmPolicy);
    if (body.fedDmPolicy && env.federation.dmEnabled) await setFedDmPolicy(body.fedDmPolicy);
    return reply.send({ ok: true });
  });

  // Иконка инстанса. Ключ с меткой времени, старый файл остаётся — как у иконок серверов.
  app.post('/admin/instance/icon', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'нет файла' });
    if (!isSupportedImage(file.mimetype)) return reply.code(400).send({ error: 'нужен PNG, JPEG, WebP или GIF' });
    const buffer = await file.toBuffer();
    if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' }); // обрезан по пределу multipart — см. att.ts
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
