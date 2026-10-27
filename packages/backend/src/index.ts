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
import { configureDevPeers } from './federation/devPeers.js';
import { configureFedConvDoorbell, configureFedGroupSigner, recordFedConvChanges } from './federation/convChanges.js';
import { configureFedCallRecord, configureFedMessagePrivacy, configureFedConvAttachments, configureFedConvCaps, configureFedConvRow, configureFedGroupAccept, ringDoorbell, startConvPull } from './federation/convAccept.js';
import { acceptGroupConvRow, applyGroupConv, groupInvitableHome, groupOpRemote, signOwnMessage, verifyMessageSig } from './federation/convGroup.js';
import { fedGroupRoutes } from './routes/fedGroups.js';
import { callRecordCopied, callRecordPlanFor, homesWithoutCalls, inviteRemote, sendCallState, startDmCalls } from './federation/dmCalls.js';
import { fedCallRoutes } from './routes/fedCalls.js';
import { fedAlbumAllowedFor, fedFilesAllowedFor, fedOnceAllowedFor, homesWithoutFiles, kickAttCopies, purgeCopiesNow, remoteAttachmentsFor, serveRemoteAttachment, startAttCopies } from './federation/convAtt.js';
import {
  announceConvs,
  brokenHomes,
  downHomes,
  fedLinkBrokenFor,
  notePeerPull,
  onLinkRestored,
  refreshFedLinks,
  reportFedDmPeer,
  silentHomes,
  staleHomes,
  startFedLinkWatch,
} from './federation/convLink.js';
import { onLinksChanged } from './federation/links.js';
import { anonymizeShadow } from './federation/guestProfile.js';
import { acceptConvRow, configureFedConvOpened, configureFedOpenPrivacy, openFederatedDirect } from './federation/convOpen.js';
import { configureFederatedConv } from './conversations.js';
import { registerGuestPushHandlers } from './federation/guestPush.js';
import { federation, startFederationAlerts, startFederationKeyRotation } from './federation/instance.js';
import { onFederationSwitch, startFederationSwitch } from './federation/switch.js';
import { federationDmGate, federationGate } from './federation/gate.js';
import { federationSwitchRoutes } from './routes/federationSwitch.js';
import { registerInstanceMetaHandler } from './federation/instanceMeta.js';
import { startOutboxWorker } from './federation/outbox.js';
import { registerDirectoryHandlers } from './federation/directoryEvents.js';
import { registerMembershipHandlers } from './federation/guestMembership.js';
import { configureShadowGone, registerRevocationHandlers } from './federation/guestRevocation.js';
import { registerReportHandlers } from './federation/instanceBan.js';
import { configureCapsChanged, refreshCapabilities, startDirectorySyncWorker } from './federation/directorySync.js';
import { configureFedConvPeerSeen, configureFedViaRoutes, federationRoutes } from './routes/federation.js';
import { acceptClaims, fallbackFor, isShadowUser, pendingFor, startConvVia, viaGate } from './federation/convVia.js';
import { fedAttRoutes } from './routes/fedAtt.js';
import { configureGatewayFed, isUserActive, isUserDmPresent, registerGateway } from './gateway.js';
import { configureRemoteLastSeen } from './lastSeen.js';
import { announceMessagePrivacy, configureEphemeralStore, configureGroupTyping, configurePresenceMessagePrivacy, fedBlockChanged, fedPeerAdded, fedPresence, fedTyping, isKnownShadow, remoteLastSeenFor, remoteMessageRefusedFor, resendPresence, startDmEphemeral } from './federation/dmEphemeral.js';
import { messageAllowedFor, wroteInDirect } from './messagePrivacy.js';
import { acceptHostedTyping, fedGroupTyping, forwardGroupTyping } from './federation/dmGroupTyping.js';
import { redisEphemeralStore } from './federation/dmEphemeralStore.js';
import { fedEphemeralRoutes } from './routes/fedEphemeral.js';
import { sendPushToUsers } from './push.js';
import { setPushActivityProbe, startPushDeferWorker } from './pushDefer.js';
import { startLinkThreatsWorker } from './linkThreats.js';
import { startScheduledWorker } from './scheduled.js';
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
import { configureFedDirect, configureFedDmReport, configureMessagePrivacy, configureFedVia, configureFedFilesGuard, configureFedLinkGuard, configureFedOnceGuard, configureFedAlbumGuard, convRoutes } from './routes/conv.js';
import { callRoutes } from './routes/calls.js';
import { closeOrphanCalls, configureFedCalls } from './calls.js';
import { configureFedGroups, convGroupRoutes } from './routes/convGroups.js';
import { stickerRoutes } from './routes/stickers.js';
import { dmFolderRoutes } from './routes/dmFolders.js';
import { downloadRoutes } from './routes/download.js';
import { attRoutes, configureRemoteAttachments } from './routes/att.js';
import { uploadRoutes } from './routes/uploads.js';
import { gifFileRoutes, gifRoutes } from './routes/gifs.js';
import { redactLogUrl } from './attachmentRules.js';
import { economyRoutes } from './routes/economy.js';
import { diagRoutes } from './routes/diag.js';
import { inviteRoutes } from './routes/invites.js';
import { linkPreviewRoutes } from './routes/linkPreview.js';
import { mapsStaticRoutes } from './routes/mapsStatic.js';
import { mapsTilesRoutes } from './routes/mapsTiles.js';
import { messageRoutes } from './routes/messages.js';
import { webhookRoutes } from './routes/webhooks.js';
import { botRoutes } from './routes/bots.js';
import { botApiRoutes } from './routes/botApi.js';
import { botDocsRoutes } from './bots/botDocs.js';
import { botOpenApiRoutes } from './bots/botOpenApiRoute.js';
import { botPressRoutes } from './routes/botPress.js';
import { pushRoutes } from './routes/push.js';
import { onBlockChange } from './blocks.js';
import { blockRoutes } from './routes/blocks.js';
import { contactRoutes } from './routes/contacts.js';
import { roleRoutes } from './routes/roles.js';
import { serverRoutes } from './routes/servers.js';
import { soundboardRoutes } from './routes/soundboard.js';
import { soundRoutes } from './routes/sounds.js';
import { steamRoutes } from './routes/steam.js';
import { unreadRoutes } from './routes/unread.js';
import { configureMessagePrivacyChanged, userRoutes } from './routes/users.js';
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
    const first = err.issues[0];
    return reply.code(400).send({ error: first?.message ?? 'Проверьте введённые данные', details: err.issues });
  }
  req.log.error(err);
  const e = err as { statusCode?: number; message?: string };
  const code = e.statusCode ?? 500;
  // 🔴 Ревью `bigfile1` (L2, 09.10): текст непредвиденной ошибки (SQL, ключи, пути хранилища) — только в лог. Наружу — текст
  // лишь у ошибок с явно поставленным кодом, кроме 500 (валидация, «слишком большое тело», `DailyQuotaError` 429,
  // `TelegramError` 502, «хранилище не настроено» 503): эти тексты писались для человека.
  const expose = e.statusCode !== undefined && e.statusCode !== 500 && !!e.message;
  return reply.code(code).send({ error: expose ? e.message : 'internal error' });
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
    // Входящие вебхуки (#24): управление под входом + приём `POST /api/webhooks/:id/:token` без входа (`routes/webhooks.ts`).
    await api.register(webhookRoutes);
    // Боты (#229): «Мои боты» + админка и Bot API v1 (`/api/bot/v1/*`, свой вход `Authorization: Bot …`; фон — по `onListen`).
    await api.register(botRoutes);
    await api.register(botApiRoutes);
    // Справка для нейронки `GET /api/bot/v1/llms.txt` без токена (`bots/botDocs.ts`, план §6).
    await api.register(botDocsRoutes);
    // Схема OpenAPI 3.1 `GET /api/bot/v1/openapi.json` без токена — из реестра `bots/botSpec.ts` (этап 5, #233).
    await api.register(botOpenApiRoutes);
    // Боты, этап 2 (#230): нажатие кнопки под сообщением бота и карточка бота беседы (команды для «/»).
    await api.register(botPressRoutes);
    // Беседы ЛС (этап 1): с шага 1б живые ЛС лежат в них, и `/auth/me` объявляет `features: ['conv1']`.
    await api.register(convRoutes);
    await api.register(convGroupRoutes);
    // Звонки 1:1 в ЛС (08.10, С5, `calls1`).
    await api.register(callRoutes);
    // Стикеры в ЛС (С2, #211): общий каталог наборов инстанса и «мои наборы» (`stickers2`).
    await api.register(stickerRoutes);
    await api.register(dmFolderRoutes);
    // Сводка непрочитанного по всему инстансу — её спрашивает фоновый шлюз (#139, §5.7).
    await api.register(unreadRoutes);
    await api.register(pushRoutes);
    await api.register(blockRoutes);
    await api.register(contactRoutes);
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
    // Загрузка кусками в беседу (`bigfile1`, 09.10): свой разборщик сырых байт куска — в своей области.
    await api.register(uploadRoutes);
    // «Мои GIF» (Р-7, `gifs1`): файл по подписанной ссылке — без входа, остальное — с ним.
    await api.register(gifFileRoutes);
    await api.register(gifRoutes);
    await api.register(appInfoRoutes);
    // Диагностика — ТОЛЬКО если инстанс явно её включил (#113). Не «регистрируем и проверяем флаг
    // внутри», а не регистрируем вовсе: тогда выключенный сбор — это отсутствие маршрута, а не
    // ветка в обработчике, которую можно однажды случайно обойти.
    if (env.diagEnabled) await api.register(diagRoutes);
    // Экономика (#117) — по тому же правилу и по той же причине: выключено => маршрута НЕТ.
    if (env.economyEnabled) await api.register(economyRoutes);
    // Федерация (#139). До #224 при выключенной федерации маршрутов не было вовсе (сосед получал честный 404); теперь её
    // включают тумблером в админке без перезапуска, поэтому маршруты есть всегда, а крючок `federationGate` на КАЖДОМ запросе
    // отвечает тем же 404 обработчика «не найдено», пока флаг выключен (`federation/gate.ts`). Снаружи — то же самое.
    await api.register(async (fed) => {
      fed.addHook('onRequest', federationGate);
      await fed.register(federationRoutes);
    });
    // Тумблеры федерации во вкладке админки (#224) — отвечают и при выключенной федерации, иначе её нечем включить.
    await api.register(federationSwitchRoutes);
    // ЛС между инстансами (#141) — тем же приёмом, флаг `dmEnabled` (`federationDmGate`):
    // Э3 часть 1 — файл вложения ЛС соседу `GET /fed/v1/att/:id`; Э4 — «печатает» / «в сети» от соседа `POST /fed/v1/ephemeral`;
    // Э6 (`dmcall1`) — приглашение на звонок 1:1; Э7 часть 1 (`dmgroup1`) — запрос участника хосту группы со смешанным составом.
    await api.register(async (dm) => {
      dm.addHook('onRequest', federationDmGate);
      await dm.register(fedAttRoutes);
      await dm.register(fedEphemeralRoutes);
      await dm.register(fedCallRoutes);
      await dm.register(fedGroupRoutes);
    });
    await api.register(linkPreviewRoutes);
    // Картинка карты для геопозиции в ЛС (`yamap1`): без ключа Яндекса маршрута НЕТ (как у diag/economy).
    if (env.yandexMapsStaticKey) await api.register(mapsStaticRoutes);
    // Своя карта OpenStreetMap (`osmmap1`): плитки из файла PMTiles; без `MAP_PMTILES_PATH` маршрутов нет.
    if (env.mapPmtilesPath) await api.register(mapsTilesRoutes);
  },
  { prefix: '/api' },
);

// Realtime gateway (text + channel events) at /gateway.
registerGateway(app);

/**
 * Крючки федерации и ЛС между инстансами (#224): при старте (до `listen`) и при каждом переключении тумблера в админке
 * (`federation/switch.ts` → `onFederationSwitch`). Обработчики событий и фоновые задачи заводятся ОДИН раз (их такты сами
 * пропускают работу при выключенном флаге), крючки-сеттеры перевешиваются по текущим флагам, подписки ЛС снимаются при
 * выключении — выключенное без перезапуска ведёт себя как выключенное при старте.
 */
let fedHandlersWired = false;
let fedDmStarted = false;
let fedDmSubs: Array<() => void> | null = null;

/** ЛС выключили без перезапуска (#224): снять крючки и подписки — как при старте без `FEDERATION_DM_ENABLED`. */
function unwireFederationDm(): void {
  for (const off of fedDmSubs ?? []) off();
  fedDmSubs = null;
  configureFedDirect(null);
  configureFedConvDoorbell(null);
  configureFedConvRow(null);
  configureFedConvCaps(null);
  configureCapsChanged(null);
  configureFedConvPeerSeen(null);
  configureFedLinkGuard(null);
  configureFedFilesGuard(null);
  configureFedOnceGuard(null);
  configureFedAlbumGuard(null);
  configureFedConvAttachments(null);
  configureRemoteAttachments(null);
  configureShadowGone(null);
  configureFedDmReport(null);
  configureGatewayFed(null);
  configureGroupTyping(null);
  configureRemoteLastSeen(null);
  configureEphemeralStore(null);
  configureFedConvOpened(null);
  configureFedVia(null);
  configureFedViaRoutes(null);
  configureFedCalls(null);
  configureFedCallRecord(null);
  configureFedOpenPrivacy(null);
  configureFedMessagePrivacy(null);
  configurePresenceMessagePrivacy(null);
  configureMessagePrivacyChanged(null);
  configureFedGroupAccept(null);
  configureFedGroupSigner(null);
  configureFedGroups(null);
}

function wireFederation(): void {
  if (env.federation.enabled && !fedHandlersWired) {
    fedHandlersWired = true;
    // Обработчики событий соседей регистрируются до listen: иначе первая же пачка приехала бы в пустой
    // реестр и была бы принята «вхолостую» — номер двинулся, а изменение не применилось.
    registerInstanceMetaHandler();
    // Каталоги соседей (F2): те же события, тот же довод — обработчик должен стоять до первой пачки.
    registerDirectoryHandlers();
    // Членства гостей (F3): хост сообщает нам, где состоят наши люди, — без этого обработчика «Где я
    // гость» и адресаты отзыва сессий остались бы пустыми, а номера событий всё равно двигались бы.
    registerMembershipHandlers();
    // Отзывы сессий и аккаунтов от домов наших гостей (F3, §5.6.1) — до первой пачки событий.
    registerRevocationHandlers();
    // Жалобы соседей на наших людей (F3, §5.11) — держатель видит их во вкладке «Федерация».
    registerReportHandlers();
    // Просьбы хостов разбудить наших людей, гостящих у них (F5, требование 33).
    registerGuestPushHandlers();
  }
  // ЛС между инстансами (Э0): id инстанса для глобального ключа пары. Журнал на связку — ВСЕГДА при федерации (исправления
  // ревью 12.10, п. 3): `FEDERATION_DM_ENABLED` выключили откатом — сообщения в открытые беседы с людьми соседа всё равно
  // пишутся, и без строк журнала не доехали бы никогда; строки полежат (уборка 30 дней), флаг закрывает только маршруты и забор.
  if (env.federation.enabled) {
    configureFederatedConv({
      selfInstanceId: () => federation.identity()?.instanceId ?? null,
      record: recordFedConvChanges,
      // Э2 часть Б: `ConvSummary.fedLink` — связка с инстансом собеседника не работает (архив только для чтения, Ф7).
      linkBroken: env.federation.dmEnabled ? brokenHomes : null,
      // Э3 часть 1: `ConvSummary.fedNoFiles` — инстанс собеседника не умеет вложения (`dm2`).
      noFiles: env.federation.dmEnabled ? homesWithoutFiles : null,
      // Э6: `ConvSummary.fedNoCalls` — инстанс собеседника не умеет звонки (`dmcall1`).
      noCalls: env.federation.dmEnabled ? homesWithoutCalls : null,
      // Исправления ревью 12.10, п. 7: `ConvSummary.fedStale` — инстанс собеседника не забирает наши сообщения дольше 10 минут.
      linkStale: env.federation.dmEnabled ? staleHomes : null,
      // Э7 часть 3 (D): `ConvSummary.fedGroupHost.down` и при молчащем доме группы (не только при разорванной связке).
      groupHostSilent: env.federation.dmEnabled ? silentHomes : null,
      // Хвост Э7 (14.10): `ConvSummary.fedPeerDown` — дом собеседника 1:1 не отвечает дольше 10 минут.
      peerDown: env.federation.dmEnabled ? downHomes : null,
    });
  }
  // ЛС между инстансами (Э1): «Написать» человеку соседа — только при `FEDERATION_DM_ENABLED`.
  if (env.federation.dmEnabled) configureFedDirect(openFederatedDirect);
  // ЛС между инстансами (Э2): звонок в дверь после записи журнала на связку и приём копий (звонок, старт, раз в 2 мин).
  if (env.federation.enabled && env.federation.dmEnabled) {
    configureFedConvDoorbell(ringDoorbell);
    // Исправления ревью 12.10: строка `conv` журнала соседа заводит 1:1 (п. 2 (а)); визитка соседа без `dm1`/`dm2`, которыми он
    // уже пользуется, перечитывается принудительно (п. 5, 10); признаки связки сменились — сводки бесед с ним заново (п. 12);
    // сосед забрал журнал — подтверждённое для плашки «ждут» (п. 7) и перечитать визитку без `dm1` (п. 10).
    // Э7 часть 1: строка `conv` группы дома соседа — заводит/обновляет группу; остальное — прежний разбор 1:1.
    configureFedConvRow(async (peer, self, cid, entity) => (await acceptGroupConvRow(peer, self, cid, entity)) ?? acceptConvRow(peer, self, cid, entity));
    configureFedConvCaps((link) => refreshCapabilities(link, Date.now(), { force: true }).catch(() => link.features));
    configureCapsChanged((instanceId) => void announceConvs(instanceId).catch(() => {}));
    configureFedConvPeerSeen((link, since) => {
      if (since !== null) void notePeerPull(link.instanceId, since).catch(() => {});
      if (!link.features.includes('dm1')) void refreshCapabilities(link, Date.now(), { force: true }).catch(() => {});
    });
    if (!fedDmStarted) startConvPull(() => env.federation.dmEnabled);
    // Э2 часть Б: разрыв/пауза связки → запись 403 и `fedLink` в сводках; жалоба из ЛС — и держателю дома собеседника.
    configureFedLinkGuard(fedLinkBrokenFor);
    // Э3 часть 1: файлы человеку соседа — только если его инстанс объявил `dm2` (загрузка, GIF, отправка, пересылка);
    // вложения копий соседа — строки `remote` и копия к нам (при старте и раз в минуту; связка снова рабочая — сразу).
    configureFedFilesGuard(fedFilesAllowedFor);
    configureFedOnceGuard(fedOnceAllowedFor);
    // G56: один элемент альбома «у обоих» — только если дома людей соседа в беседе объявили `dmalbum1`.
    configureFedAlbumGuard(fedAlbumAllowedFor);
    configureFedConvAttachments({ remoteFor: remoteAttachmentsFor, kick: (origin) => kickAttCopies(origin), purge: purgeCopiesNow });
    // Подписки ЛС — по одной на включение: выключение их снимает (`unwireFederationDm`), включение вешает заново.
    const subscribe = fedDmSubs === null;
    fedDmSubs ??= [];
    if (subscribe) fedDmSubs.push(onLinkRestored((instanceId) => kickAttCopies(instanceId, { fresh: true })));
    configureRemoteAttachments(serveRemoteAttachment);
    startAttCopies(() => env.federation.dmEnabled);
    // Удалённый аккаунт собеседника по ЛС (`user.revoked` и журнал отзывов) — обезличить его теневую строку (Ф26).
    configureShadowGone(anonymizeShadow);
    configureFedDmReport(reportFedDmPeer);
    if (subscribe) fedDmSubs.push(onLinksChanged(() => void refreshFedLinks()));
    startFedLinkWatch(() => env.federation.dmEnabled);
    // Э4: «печатает» и «в сети / был(а)» с людьми соседа (`dm3`) — крючки шлюза и «был(а)», «жив» раз в минуту, устаревание.
    configureGatewayFed({ typing: fedTyping, presence: fedPresence, isRemote: isKnownShadow, groupTyping: fedGroupTyping });
    // Э7 часть 3 (#141, `dmgroup2`): «печатает» в группах со смешанным составом.
    configureGroupTyping({ accept: acceptHostedTyping, forward: forwardGroupTyping });
    configureRemoteLastSeen(remoteLastSeenFor);
    configureEphemeralStore(redisEphemeralStore); // копия принятого «был(а)» людей соседей — в Redis, переживает перезапуск
    startDmEphemeral(() => env.federation.dmEnabled);
    // Приёмка 15.10: новая беседа 1:1 с человеком соседа — «в сети / был(а)» нашего человека его дому сразу, а не через 10 минут.
    configureFedConvOpened(fedPeerAdded);
    // F5: блок человека соседа — его дому сразу «был(а) давно» вместо «в сети» (`fedBlockChanged`).
    if (subscribe) fedDmSubs.push(onBlockChange(fedBlockChanged));
    // Перезапуск этого инстанса / связка снова рабочая: соседи не знают, кто из наших людей не в сети — один проход «жив» / «был(а)».
    // Включили из админки (#224) — тот же проход сразу: соседи не знают, кто из наших в сети.
    const resendTimer = setTimeout(() => void resendPresence().catch(() => {}), fedDmStarted ? 0 : 20_000);
    resendTimer.unref?.();
    if (subscribe) fedDmSubs.push(onLinkRestored((instanceId) => void resendPresence(instanceId).catch(() => {})));
    // Э5 часть 1: «мой дом лежит — пишу через инстанс собеседника» — долгая сессия, приём «через», сверка задним числом.
    configureFedVia({ gate: viaGate, isShadow: isShadowUser, fallback: (me, id, purpose) => fallbackFor(me, id, Date.now(), purpose), claims: acceptClaims });
    configureFedViaRoutes(pendingFor);
    if (!fedDmStarted) startConvVia(() => env.federation.dmEnabled);
    // Э6: звонки 1:1 с людьми соседа — приглашение и снимки фазы (`calls.ts`), копия записи о звонке (`convAccept`), приём `call.state`.
    configureFedCalls({ invite: (call, home) => inviteRemote(call, home), state: sendCallState });
    configureFedCallRecord({ plan: callRecordPlanFor, read: callRecordCopied });
    // «Кто может мне писать» (`msgpriv1`, 13.10): отказ при `conv.open` (причина `privacy`), скрытое сообщение при приёме,
    // пометка `noMessages` в присутствии соседу и заранее 403 `message_privacy` нашему отправителю по его пометке.
    configureFedOpenPrivacy((sender, recipient) => messageAllowedFor(sender ?? '', recipient));
    configureFedMessagePrivacy(messageAllowedFor);
    configurePresenceMessagePrivacy(messageAllowedFor);
    configureMessagePrivacyChanged(announceMessagePrivacy);
    if (!fedDmStarted) startDmCalls(() => env.federation.dmEnabled);
    // Э7 часть 1: группы со смешанным составом — строка `conv` от хоста, подпись дома автора (своё — подписываем, чужое —
    // проверяем), позвать человека соседа и действие с группой чужого дома (`routes/convGroups.ts`).
    configureFedGroupAccept({ applyConv: applyGroupConv, verify: verifyMessageSig });
    configureFedGroupSigner(signOwnMessage);
    configureFedGroups({ invitable: (home) => groupInvitableHome(home), op: groupOpRemote });
    fedDmStarted = true;
  } else if (fedDmSubs) {
    unwireFederationDm();
  }
}

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
  // Флаги из `.env` и тумблера в админке (#224) и подъём ключа — на месте прежнего `federation.start()`.
  await startFederationSwitch();
  // Режим стенда для локальных соседей (Ф13): список пуст везде, кроме стенда; проверен при старте (`env.ts`).
  configureDevPeers(env.federation.devPeers);
  // «Кто может мне писать» (`msgpriv1`, 13.10): проверка отправки в 1:1; пометки соседей (`noMessages`) — из `dmEphemeral` (без ЛС
  // между инстансами там пусто). Вызов через `?.`: проверка запуска (`indexErrors.test.ts`) подменяет `routes/conv.js` одними
  // маркерами регистрации, а этот крючок, в отличие от остальных крючков `conv.js`, ставится и без федерации.
  configureMessagePrivacy?.({ allowed: messageAllowedFor, wrote: wroteInDirect, remoteRefused: remoteMessageRefusedFor });
  wireFederation();
  await app.listen({ host: '0.0.0.0', port: env.port });
  app.log.info(`backend listening on :${env.port}`);
  // Сменный ключ подписи истекает по сроку — проверять надо и на инстансе, который не перезапускали.
  startFederationKeyRotation();
  // Очередь исходящих событий: недоступный сосед не должен приводить к потере изменения (#148).
  if (env.federation.enabled) startOutboxWorker(() => env.federation.enabled);
  // Оповещения держателю: связка легла, ключ истекает, всплеск отказов подписи (F5, §5.10).
  startFederationAlerts();
  // Синхронизация каталогов: дельта раз в 15 минут и полная сверка раз в сутки ночью (F2, §5.4).
  if (env.federation.enabled) startDirectorySyncWorker(() => env.federation.enabled);
  // Тумблер в админке (#224): перевесить крючки и завести фоновые задачи федерации, если их ещё нет (повторный запуск —
  // пустой; при выключенном флаге их такты ничего не делают).
  onFederationSwitch(() => {
    wireFederation();
    startFederationKeyRotation();
    startFederationAlerts();
    if (env.federation.enabled) startOutboxWorker(() => env.federation.enabled);
    if (env.federation.enabled) startDirectorySyncWorker(() => env.federation.enabled);
  });
  // Anti-bot: sweep abandoned unverified registrations (startup + daily).
  startDailyCleanup();
  // Файлы ЛС (шаг 1в): брошенные и вытесненные загрузки, недоудалённое после «удалить у обоих» — раз в час.
  startAttachmentSweeper();
  // Опасные ссылки (#218 п.5): список угроз — раз в сутки (первый раз через 20 с); выключатель `LINK_THREATS_ENABLED`.
  startLinkThreatsWorker();
  // Отложенные сообщения ЛС (С4, `conv9`): такт раз в 5 с — созревшие по времени и «Когда будет в сети» (в сети —
  // соединения шлюза этого процесса и статус не «невидимый»).
  startScheduledWorker({ isOnline: isUserDmPresent });
  // Отложенный пуш, пока человек за ПК (G38, `push2`): кто «за устройством» — шлюз; созревшие пуши — такт раз в 2 с.
  setPushActivityProbe(isUserActive);
  startPushDeferWorker((item) =>
    sendPushToUsers([item.uid], item.payload, item.source, {
      noDefer: true,
      ...(item.private ? { private: true } : {}),
      ...(item.repeat ? { repeat: item.repeat } : {}),
      ...(item.repeat && typeof item.firstAt === 'number' ? { firstAt: item.firstAt } : {}),
    }),
  );
  // Expire stale game-activity reports from clients that went silent (#40).
  startActivitySweeper();
  // Steam game-activity poller (#40 Phase 1B) — no-op unless STEAM_API_KEY is configured.
  startSteamPoller();
  // Сырая статистика присутствия в голосе для экономики GusCoins — no-op без ECONOMY_STATS_ENABLED.
  startVoiceActivityCollector();
  // Звонки 1:1, оборванные перезапуском (`calls2`): закрыть записью в ленте — копия живых звонков лежит в Redis.
  void closeOrphanCalls()
    .then((n) => n > 0 && app.log.info(`[calls] closed ${n} call(s) cut by restart`))
    .catch((e) => app.log.warn(e, '[calls] orphan close failed'));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
