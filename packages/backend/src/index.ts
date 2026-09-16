import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { startActivitySweeper } from './activity.js';
import { startDailyCleanup } from './cleanup.js';
import { startSteamPoller } from './steam.js';
import { startVoiceActivityCollector } from './voiceActivity.js';
import { runMigrations } from './db/index.js';
import { env } from './env.js';
import { registerGateway } from './gateway.js';
import { verifyMailer } from './mailer.js';
import { bindSuperAdmin, seedSuperAdmin } from './seed.js';
import { ensureMediaBucket } from './storage.js';
import { adminRoutes } from './routes/admin.js';
import { appInfoRoutes } from './routes/appinfo.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { channelRoutes } from './routes/channels.js';
import { dmRoutes } from './routes/dm.js';
import { downloadRoutes } from './routes/download.js';
import { economyRoutes } from './routes/economy.js';
import { diagRoutes } from './routes/diag.js';
import { inviteRoutes } from './routes/invites.js';
import { linkPreviewRoutes } from './routes/linkPreview.js';
import { messageRoutes } from './routes/messages.js';
import { pushRoutes } from './routes/push.js';
import { roleRoutes } from './routes/roles.js';
import { serverRoutes } from './routes/servers.js';
import { soundboardRoutes } from './routes/soundboard.js';
import { soundRoutes } from './routes/sounds.js';
import { steamRoutes } from './routes/steam.js';
import { userRoutes } from './routes/users.js';
import { voiceRoutes } from './routes/voice.js';

const app = Fastify({ logger: true });

// Bearer-token auth (no cookies), so reflecting the origin is safe. Tighten to
// CLIENT_ORIGIN if you prefer; the desktop (Tauri) client uses a different origin.
// exposedHeaders обязателен: клиент живёт на voice.*, API на api.*, и кросс-доменный ответ отдаёт
// скрипту только «безопасные» заголовки. Без этой строки продление сессии (x-refresh-token) тихо
// не работает, а выглядит как прежний баг «выкидывает раз в неделю».
await app.register(cors, { origin: true, exposedHeaders: ['x-refresh-token'] });
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
    await api.register(pushRoutes);
    await api.register(roleRoutes);
    await api.register(voiceRoutes);
    await api.register(inviteRoutes);
    await api.register(adminRoutes);
    await api.register(auditRoutes);
    await api.register(soundRoutes);
    await api.register(soundboardRoutes);
    await api.register(downloadRoutes);
    await api.register(appInfoRoutes);
    // Диагностика — ТОЛЬКО если инстанс явно её включил (#113). Не «регистрируем и проверяем флаг
    // внутри», а не регистрируем вовсе: тогда выключенный сбор — это отсутствие маршрута, а не
    // ветка в обработчике, которую можно однажды случайно обойти.
    if (env.diagEnabled) await api.register(diagRoutes);
    // Экономика (#117) — по тому же правилу и по той же причине: выключено => маршрута НЕТ.
    if (env.economyEnabled) await api.register(economyRoutes);
    await api.register(linkPreviewRoutes);
  },
  { prefix: '/api' },
);

// Realtime gateway (text + channel events) at /gateway.
registerGateway(app);

try {
  await runMigrations();
  await seedSuperAdmin();
  // Строго после сида и до listen: до привязки супер-админа нет ни у кого (#140).
  await bindSuperAdmin();
  await verifyMailer();
  await ensureMediaBucket();
  await app.listen({ host: '0.0.0.0', port: env.port });
  app.log.info(`backend listening on :${env.port}`);
  // Anti-bot: sweep abandoned unverified registrations (startup + daily).
  startDailyCleanup();
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
