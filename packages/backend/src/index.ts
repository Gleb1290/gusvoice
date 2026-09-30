import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { startActivitySweeper } from './activity.js';
import { startAttachmentSweeper, startDailyCleanup } from './cleanup.js';
import { startSteamPoller } from './steam.js';
import { startVoiceActivityCollector } from './voiceActivity.js';
import { runMigrations } from './db/index.js';
import { env } from './env.js';
import { registerGuestPushHandlers } from './federation/guestPush.js';
import { federation, startFederationAlerts, startFederationKeyRotation } from './federation/instance.js';
import { registerInstanceMetaHandler } from './federation/instanceMeta.js';
import { startOutboxWorker } from './federation/outbox.js';
import { registerDirectoryHandlers } from './federation/directoryEvents.js';
import { registerMembershipHandlers } from './federation/guestMembership.js';
import { registerRevocationHandlers } from './federation/guestRevocation.js';
import { registerReportHandlers } from './federation/instanceBan.js';
import { startDirectorySyncWorker } from './federation/directorySync.js';
import { federationRoutes } from './routes/federation.js';
import { registerGateway } from './gateway.js';
import { verifyMailer } from './mailer.js';
import { bindSuperAdmin, seedSuperAdmin } from './seed.js';
import { bootstrapIdentity } from './superAdminRules.js';
import { ensureMediaBucket, ensurePrivateBucket } from './storage.js';
import { corsOriginCheck, refreshPeerOrigins } from './corsOrigins.js';
import { adminRoutes } from './routes/admin.js';
import { appInfoRoutes } from './routes/appinfo.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { channelRoutes } from './routes/channels.js';
import { dmRoutes } from './routes/dm.js';
import { convRoutes } from './routes/conv.js';
import { downloadRoutes } from './routes/download.js';
import { attRoutes } from './routes/att.js';
import { redactLogUrl } from './attachmentRules.js';
import { economyRoutes } from './routes/economy.js';
import { diagRoutes } from './routes/diag.js';
import { inviteRoutes } from './routes/invites.js';
import { linkPreviewRoutes } from './routes/linkPreview.js';
import { messageRoutes } from './routes/messages.js';
import { pushRoutes } from './routes/push.js';
import { blockRoutes } from './routes/blocks.js';
import { roleRoutes } from './routes/roles.js';
import { serverRoutes } from './routes/servers.js';
import { soundboardRoutes } from './routes/soundboard.js';
import { soundRoutes } from './routes/sounds.js';
import { steamRoutes } from './routes/steam.js';
import { unreadRoutes } from './routes/unread.js';
import { userRoutes } from './routes/users.js';
import { voiceRoutes } from './routes/voice.js';

/**
 * Журнал запросов — как у Fastify по умолчанию, но с вырезанной подписью ссылок на закрытые файлы ЛС (шаг 1в):
 * ссылка `/api/att/<id>/<смотрящий>/<подпись>` — ключ на предъявителя, в журнале ей не место (`redactLogUrl`).
 */
const app = Fastify({
  logger: {
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: redactLogUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
});

// 🔴 CORS сужен до своего клиента, оболочек Tauri и клиентов связанных инстансов (аудит 19.09,
// F-21; список и кеш — `corsOrigins.ts`). Кук нет, токен в `localStorage`, поэтому чужая страница
// сама по себе токен не получала — но `origin: true` оставлял любую будущую XSS и утёкший токен
// рабочими с любого сайта. Нестандартный источник — `CORS_EXTRA_ORIGINS` в `.env`.
// exposedHeaders обязателен: клиент живёт на voice.*, API на api.*, и кросс-доменный ответ отдаёт
// скрипту только «безопасные» заголовки. Без этой строки продление сессии (x-refresh-token) тихо
// не работает, а выглядит как прежний баг «выкидывает раз в неделю».
await app.register(cors, { origin: corsOriginCheck, exposedHeaders: ['x-refresh-token'] });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

// Tolerate empty bodies on bodyless POST/DELETE requests that still carry a
// Content-Type: application/json header (e.g. voice-token, accept-invite).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = (body as string).trim();
  if (text === '') return done(null, undefined);
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    (err as { statusCode?: number }).statusCode = 400;
    done(err as Error, undefined);
  }
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ZodError) {
    // Surface the first issue so the client shows *what* to fix, not a bare "validation".
    const first = err.errors[0];
    return reply.code(400).send({ error: first?.message ?? 'Проверьте введённые данные', details: err.errors });
  }
  req.log.error(err);
  const e = err as { statusCode?: number; message?: string };
  return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'internal error' });
});

// Basic response hygiene: never let a browser MIME-sniff an API/file response into HTML.
app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
});

app.get('/health', async () => ({ ok: true }));

await app.register(
  async (api) => {
    await api.register(authRoutes);
    // Мастер первичной настройки + публичные сведения об инстансе (#142).
    await api.register(setupRoutes);
    await api.register(userRoutes);
    await api.register(steamRoutes);
    await api.register(serverRoutes);
    await api.register(channelRoutes);
    await api.register(messageRoutes);
    await api.register(dmRoutes);
    // Беседы ЛС (этап 1): с шага 1б живые ЛС лежат в них, и `/auth/me` объявляет `features: ['conv1']`.
    await api.register(convRoutes);
    // Сводка непрочитанного по всему инстансу — её спрашивает фоновый шлюз (#139, §5.7).
    await api.register(unreadRoutes);
    await api.register(pushRoutes);
    await api.register(blockRoutes);
    await api.register(roleRoutes);
    await api.register(voiceRoutes);
    await api.register(inviteRoutes);
    await api.register(adminRoutes);
    await api.register(auditRoutes);
    await api.register(soundRoutes);
    await api.register(soundboardRoutes);
    await api.register(downloadRoutes);
    // Закрытые файлы ЛС (шаг 1в): без входа — доступ решают подпись ссылки и проверка смотрящего (`routes/att.ts`).
    await api.register(attRoutes);
    await api.register(appInfoRoutes);
    // Диагностика — ТОЛЬКО если инстанс явно её включил (#113). Не «регистрируем и проверяем флаг
    // внутри», а не регистрируем вовсе: тогда выключенный сбор — это отсутствие маршрута, а не
    // ветка в обработчике, которую можно однажды случайно обойти.
    if (env.diagEnabled) await api.register(diagRoutes);
    // Экономика (#117) — по тому же правилу и по той же причине: выключено => маршрута НЕТ.
    if (env.economyEnabled) await api.register(economyRoutes);
    // Федерация (#139) — по тому же правилу, что диагностика и экономика: выключено => маршрутов НЕТ,
    // а не ветка в обработчике. Сосед получит честные 404 вместо «как бы федеративного» инстанса.
    if (env.federation.enabled) await api.register(federationRoutes);
    await api.register(linkPreviewRoutes);
  },
  { prefix: '/api' },
);

// Realtime gateway (text + channel events) at /gateway.
registerGateway(app);

try {
  await runMigrations();
  // Источники связок для CORS — до первого запроса, иначе гость соседа после перезапуска получал бы отказ.
  await refreshPeerOrigins();
  // Строго до listen и строго в порядке «создать аккаунт → привязать права к его id» (#140);
  // сам порядок живёт в bootstrapIdentity, чтобы его нельзя было переставить здесь по невнимательности.
  await bootstrapIdentity({ seedSuperAdmin, bindSuperAdmin });
  await verifyMailer();
  await ensureMediaBucket();
  // Закрытый бакет файлов ЛС: без политики; не вышло — загрузки в ЛС отвечают 503, а не уходят в открытый бакет.
  await ensurePrivateBucket();
  // Федерация поднимается ПОСЛЕ привязки личности и ДО listen: инстанс не должен успеть ответить
  // соседу документом, пока не решено, есть ли у нас печать. Отказ здесь не бросает — он гасит
  // только федерацию (`state.ts`), поэтому `await` без try: внутри уже всё поймано.
  await federation.start();
  // Обработчики событий соседей регистрируются до listen: иначе первая же пачка приехала бы в пустой
  // реестр и была бы принята «вхолостую» — номер двинулся, а изменение не применилось.
  if (env.federation.enabled) registerInstanceMetaHandler();
  // Каталоги соседей (F2): те же события, тот же довод — обработчик должен стоять до первой пачки.
  if (env.federation.enabled) registerDirectoryHandlers();
  // Членства гостей (F3): хост сообщает нам, где состоят наши люди, — без этого обработчика «Где я
  // гость» и адресаты отзыва сессий остались бы пустыми, а номера событий всё равно двигались бы.
  if (env.federation.enabled) registerMembershipHandlers();
  // Отзывы сессий и аккаунтов от домов наших гостей (F3, §5.6.1) — до первой пачки событий.
  if (env.federation.enabled) registerRevocationHandlers();
  // Жалобы соседей на наших людей (F3, §5.11) — держатель видит их во вкладке «Федерация».
  if (env.federation.enabled) registerReportHandlers();
  // Просьбы хостов разбудить наших людей, гостящих у них (F5, требование 33).
  if (env.federation.enabled) registerGuestPushHandlers();
  await app.listen({ host: '0.0.0.0', port: env.port });
  app.log.info(`backend listening on :${env.port}`);
  // Сменный ключ подписи истекает по сроку — проверять надо и на инстансе, который не перезапускали.
  startFederationKeyRotation();
  // Очередь исходящих событий: недоступный сосед не должен приводить к потере изменения (#148).
  if (env.federation.enabled) startOutboxWorker();
  // Оповещения держателю: связка легла, ключ истекает, всплеск отказов подписи (F5, §5.10).
  startFederationAlerts();
  // Синхронизация каталогов: дельта раз в 15 минут и полная сверка раз в сутки ночью (F2, §5.4).
  if (env.federation.enabled) startDirectorySyncWorker();
  // Anti-bot: sweep abandoned unverified registrations (startup + daily).
  startDailyCleanup();
  // Файлы ЛС (шаг 1в): брошенные и вытесненные загрузки, недоудалённое после «удалить у обоих» — раз в час.
  startAttachmentSweeper();
  // Expire stale game-activity reports from clients that went silent (#40).
  startActivitySweeper();
  // Steam game-activity poller (#40 Phase 1B) — no-op unless STEAM_API_KEY is configured.
  startSteamPoller();
  // Сырая статистика присутствия в голосе для экономики GusCoins — no-op без ECONOMY_STATS_ENABLED.
  startVoiceActivityCollector();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
