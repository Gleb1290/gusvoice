import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  FED_ERRORS,
  FED_FEATURES,
  serializeDirectoryPage,
  serializeGuestSession,
  serializeInvitePreview,
  serializeInstanceDocument,
  serializeServerPage,
  type FederationBanRow,
  type FederationDirectoryView,
  type FederationReportRow,
  type FederationSyncRow,
  type GuestPlacesView,
} from '@gusvoice/shared';
import { bumpTokenGeneration, requireAuth, requireSuperAdmin } from '../auth.js';
import { db } from '../db/index.js';
import { federationPeerUsers, users } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { env } from '../env.js';
import { alertSettings, openAlerts, runFederationAlerts, saveAlertSettings } from '../federation/alerts.js';
import { federation } from '../federation/instance.js';
import { verifyRequest } from '../federation/httpSignature.js';
import { findPeerKey, fetchPeerDocument, LINK_STEP_DEADLINE_MS } from '../federation/peerClient.js';
import { findCodeBySecret, getLink, linkService, listLinks } from '../federation/links.js';
import { authenticateLinkedPeer, refusalFor, targetUriOf } from '../federation/peerAuth.js';
import type { StoredLink } from '../federation/linkService.js';
import { createAdmitPeer, createEventsHandler, signatureOf } from './fedAdmission.js';
import { isInstanceId } from '../federation/instanceIdentity.js';
import { fedAudit, recentAudit } from '../federation/auditLog.js';
import { linkDisplayNames } from '../federation/linkRules.js';
import { rateHit } from '../authGuard.js';
import { requireLocalUser } from '../guestGuard.js';
import { directoryPageFor, serverPageFor } from '../federation/directoryFeed.js';
import { decodeCursor, encodeCursor, parseDirectoryQuery, type DirectoryQuery } from '../federation/directoryRules.js';
import { peerServers, peerUsers } from '../federation/directoryCache.js';
import { ownAvatarFor, peerAvatarUrl } from '../federation/avatars.js';
import { contactsOfPeer } from '../federation/guestAccess.js';
import { quotaOf, resetQuota, setQuota } from '../federation/guestQuota.js';
import { acceptIdentity } from '../federation/guestHost.js';
import { previewForPeer, previewInvite } from '../federation/invitePreview.js';
import { REVOCATION_PAGE_MAX, revocationsSince } from '../federation/guestRevocation.js';
import { guestMembershipsOf, membershipsForPeer } from '../federation/guestMembership.js';
import {
  banInstanceUser,
  listInstanceBans,
  listReports,
  replyToReport,
  sendReport,
  unbanInstanceUser,
} from '../federation/instanceBan.js';
import { issueIdentityFor } from '../federation/guestHome.js';
import { peekIdentityToken } from '../federation/identityToken.js';
import { readSyncState, syncLinkNow, type SyncKind } from '../federation/directorySync.js';
import { freshnessText } from '../federation/syncSchedule.js';
import { receiveEvents } from '../federation/eventStream.js';
import {
  checkInstanceName,
  readInstanceMeta,
  setFederationPaused,
  writeInstanceMeta,
} from '../federation/instanceMeta.js';
import { checkContacts, parseContacts, serializeContacts } from '../federation/contacts.js';
import { fedRateBlock, seenSignature } from '../federation/guardsRuntime.js';
import { parseRevocation } from '../federation/keyRevocation.js';
import { receiveRevocation, revokeOwnKey } from '../federation/revocation.js';
import { realClientIp } from '@gusvoice/shared';

/**
 * Протокол федерации (#139, F1) — `/api/fed/v1/*` для соседей и `/admin/federation/*` для держателя.
 *
 * 🔴 Документ инстанса ПУБЛИЧЕН намеренно: чтобы связаться, сосед должен уметь прочитать нашу визитку
 * до всякой связки — иначе первый шаг был бы невозможен. В нём только то, что и так уходит наружу:
 * идентификатор, домен, версии, возможности и ПУБЛИЧНЫЕ ключи. Закрытых ключей, контактов держателя
 * (они отдаются только связанным, §5.1.1) и чего-либо о людях здесь нет.
 *
 * Версия в пути (`v1`) — часть контракта: ломающее изменение появится как `/api/fed/v2/` РЯДОМ,
 * а v1 проживёт окно поддержки (`docs/federation-compat.md`).
 */

type SignatureHeaders = { 'content-digest'?: string; 'signature-input'?: string; signature?: string };

/**
 * Адрес, с которого пришёл запрос соседа.
 *
 * Тот же разбор, что и для обычных клиентов: заголовок от прокси читается справа налево и только от
 * доверенных сетей — иначе счётчик обходится подделкой заголовка.
 */
function clientIpOf(req: FastifyRequest): string {
  return realClientIp(req.headers['x-forwarded-for'], req.ip);
}

/**
 * Общий порядок допуска подписанного запроса соседа (F-07, F-12): форма → адрес → подпись → связка.
 * Сам порядок и пачка событий — `routes/fedAdmission.ts` (без Redis и базы, вынос для тестов 22.09).
 */
const admitPeer = createAdmitPeer({
  rateBlock: (kind, who) => fedRateBlock(kind, who),
  authenticate: (req, instanceId, opts) => authenticateLinkedPeer(req, instanceId, opts),
  clientIp: clientIpOf,
});

/** Свежесть обоих каталогов по связке — для блока «Синхронизация» (§4.1.1). */
/** Занятое место и предел связки для карточки во вкладке «Федерация» (§5.10). */
async function quotaRowFor(instanceId: string): Promise<{ used: number; limit: number }> {
  const q = await quotaOf(instanceId);
  return { used: q?.used ?? 0, limit: q?.quota ?? 0 };
}

async function syncRowsFor(instanceId: string): Promise<FederationSyncRow[]> {
  const rows: FederationSyncRow[] = [];
  // Во вкладке показываем ТОЛЬКО каталоги: «отзывы» это не список, у которого бывает свежесть, а
  // отметка «до какого момента догнали», и держателю она ничего не говорит.
  for (const kind of ['directory', 'servers'] as const) {
    const state = await readSyncState(instanceId, kind);
    rows.push({
      kind,
      entries: state.entries,
      lastDeltaAt: state.lastDeltaAt === null ? null : new Date(state.lastDeltaAt).toISOString(),
      lastFullAt: state.lastFullAt === null ? null : new Date(state.lastFullAt).toISOString(),
      failures: state.failures,
      problem: state.problem,
      needsFull: state.needsFull,
    });
  }
  return rows;
}

export async function federationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fed/v1/instance', async (_req, reply) => {
    const doc = await federation.document();
    // Сюда попадаем только при включённой федерации (иначе маршрут не зарегистрирован), значит пустой
    // документ = ключ не открылся. Наружу без подробностей: они для своей вкладки, не для чужих.
    if (!doc) return reply.code(503).send({ error: 'федерация на этом инстансе временно недоступна' });
    // Ответ кладётся в кеш соседа; короткий срок — компромисс между ротацией ключей и лишними запросами.
    reply.header('cache-control', 'public, max-age=300');
    return serializeInstanceDocument(doc);
  });

  /**
   * Каталог наших людей (F2, §5.2) и список открытых серверов (§5.3).
   *
   * 🔴 Запрос ПОДПИСАННЫЙ, хотя это чтение: каталог отдаётся только связанным инстансам, и без
   * подписи «связанный» значило бы «знающий наш идентификатор» — то есть кто угодно. Личность
   * спрашивающего едет в строке запроса, а строка запроса входит в подписываемый адрес, поэтому
   * подменить её нельзя.
   * ⚠️ GET, а не POST: это именно чтение, у него нет тела, и повторный такой же запрос ничего не
   * меняет — поэтому проверки одноразовости здесь нет (см. `authenticateLinkedPeer`).
   */
  async function directoryRoute(
    req: FastifyRequest,
    reply: FastifyReply,
    serve: (self: string, instanceId: string, query: DirectoryQuery) => Promise<unknown>,
  ) {
    const q = req.query as Record<string, string | undefined>;
    const link = await admitPeer(req, reply, q.instance_id, 'directory');
    if (!link) return;

    const parsed = parseDirectoryQuery({ since: q.since, cursor: q.cursor, limit: q.limit });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.problem });

    const self = federation.identity();
    if (!self) return reply.code(503).send({ error: 'федерация на этом инстансе временно недоступна' });
    return await serve(self.instanceId, link.instanceId, parsed.value);
  }

  app.get('/fed/v1/directory', async (req, reply) =>
    directoryRoute(req, reply, async (self, _peer, query) =>
      serializeDirectoryPage(await directoryPageFor(self, query, Date.now())),
    ),
  );

  app.get('/fed/v1/servers', async (req, reply) =>
    directoryRoute(req, reply, async (self, peer, query) =>
      serializeServerPage(await serverPageFor(self, peer, query, Date.now())),
    ),
  );

  /**
   * Аватар нашего человека для связанного соседа (§5.4).
   *
   * 🔴 Отдаётся только тому, кто виден в каталоге: у скрытого и удалённого картинки нет, даже если
   * файл на месте. Иначе маршрут стал бы обходом скрытия — «в списке нет, а лицо есть».
   * ⚠️ Отдаём БАЙТЫ, а не адрес в хранилище: адрес увёл бы чужой бэкенд на наш MinIO, то есть за
   * пределы связки, — и это ровно то, от чего защищает список разрешённых хостов.
   */
  app.get('/fed/v1/avatar/:userId', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!(await admitPeer(req, reply, q.instance_id, 'directory'))) return;

    const { userId } = req.params as { userId: string };
    const avatar = await ownAvatarFor(userId);
    // 404 и «нет аватара», и «человек скрыт» — одинаково: по разнице ответов сосед узнавал бы о
    // существовании скрытых людей.
    if (!avatar) return reply.code(404).send({ error: 'no-avatar' });
    reply.header('content-type', avatar.contentType);
    reply.header('cache-control', 'private, max-age=300');
    return reply.send(avatar.bytes);
  });

  /**
   * Членства гостей одной связки — для суточной сверки индекса на её доме (F3, §5.4).
   *
   * 🔴 Отдаём только людей ЭТОЙ связки: спрашивающий узнаёт, где состоят его собственные люди, и
   * ничего больше. Иначе один запрос выдавал бы соседу карту всех гостей инстанса, включая чужих.
   * ⚠️ Снятые членства в ответ не попадают: «чего нет в ответе, того нет» — то же правило, по
   * которому работает сверка каталога.
   */
  app.get('/fed/v1/memberships', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const link = await admitPeer(req, reply, q.instance_id, 'directory');
    if (!link) return;

    const rows = await membershipsForPeer(link.instanceId);
    return {
      instance_id: federation.identity()?.instanceId ?? null,
      now: Date.now(),
      memberships: rows.map((r) => ({
        user_id: r.homeUserId,
        server_id: r.serverId,
        server_name: r.serverName,
        state: r.state,
        method: r.method,
        invited_by: r.invitedBy,
      })),
    };
  });

  /**
   * Журнал отзывов для хоста, который догоняет пропущенное (F3, §5.6.1).
   *
   * 🔴 Ради этого маршрута и заведён журнал: хост мог быть выключен, когда наш человек нажал «выйти
   * везде», — события он не получил, повторы упёрлись в мёртвый адрес. Вернувшись, он спрашивает
   * сам, и «выйти везде» перестаёт зависеть от того, все ли были живы в ту минуту.
   * ⚠️ В ответе едет НАШЕ время: следующий `since` сосед берёт отсюда, а не со своих часов (грабли
   * разъехавшихся часов — те же, что в каталоге F2).
   */
  app.get('/fed/v1/revocations', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const link = await admitPeer(req, reply, q.instance_id, 'directory');
    if (!link) return;

    const sinceRaw = typeof q.since === 'string' ? Number(q.since) : NaN;
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : null;

    /**
     * 🔴 Курсор обязателен (нашёл Codex 16.09). Раньше выборка молча обрезалась на 500 записях, а в
     * ответе ехало текущее время — хост запоминал его и всё, что не влезло, не получал НИКОГДА.
     * Негодный курсор — ОТКАЗ, а не «начнём сначала»: молчаливый откат к началу превращает выдачу в
     * бесконечный круг, который снаружи выглядит работающим.
     */
    let after: { updatedAt: number; id: string } | null = null;
    if (typeof q.cursor === 'string' && q.cursor.length > 0) {
      after = decodeCursor(q.cursor);
      if (!after) return reply.code(400).send({ error: 'bad-cursor' });
    }

    // 🔴 Только адресованное СПРАШИВАЮЩЕМУ (аудит run-1 20.09, F-26): раньше журнал отдавался любому
    // соседу целиком — хронология «кто из наших менял пароль и жал «выйти везде»» за 30 дней.
    const rows = await revocationsSince(since, after, REVOCATION_PAGE_MAX, link.instanceId);
    const last = rows.at(-1);
    // Курсор есть ТОЛЬКО когда страница полная: иначе сосед пошёл бы за заведомо пустой добавкой.
    const nextCursor = last && rows.length >= REVOCATION_PAGE_MAX ? encodeCursor(last.createdAt, last.id) : null;
    return {
      instance_id: federation.identity()?.instanceId ?? null,
      now: Date.now(),
      next_cursor: nextCursor,
      revocations: rows.map((r) => ({ user_id: r.userId, kind: r.kind, gen: r.gen, created_at: r.createdAt })),
    };
  });

  /**
   * Карточка нашей ссылки для связанного соседа (F3, §4.2.1).
   *
   * 🔴 Подписанный GET, как и каталог: предпросмотр отдаётся только тем, с кем есть связка. Предел
   * частоты здесь — защита от ПОДБОРА кода: код короткий, а предпросмотр доступен всякому, кто его
   * назовёт. При отказе наружу уходит только код причины, без имени сервера.
   */
  app.get('/fed/v1/invites/:code/preview', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const link = await admitPeer(req, reply, q.instance_id, 'invitePreview');
    if (!link) return;

    const { code } = req.params as { code: string };
    const res = await previewForPeer({ code, peerInstanceId: link.instanceId, now: Date.now() });
    if (!res.ok) return reply.code(404).send({ error: res.problem });
    return serializeInvitePreview(res.preview);
  });

  /**
   * Гостевая сессия по токену личности (F3, §5.5).
   *
   * 🔴 Этот POST приходит от КЛИЕНТА человека, а не от соседа: подписи запроса здесь нет и быть не
   * может — у чужого клиента нет нашего ключа. Поэтому маршрут живёт вне протокольного скоупа и
   * опирается целиком на токен: подпись дома, срок две минуты, наш `aud`, одноразовая метка.
   * ⚠️ Частота — двумя счётчиками (аудит 19.09, F-07): до проверки подписи по АДРЕСУ (щедро: за
   * одним адресом сидит весь офис соседа), а по связке — уже внутри `acceptIdentity`, только для
   * токенов с верной подписью. Раньше счётчик связки брался из непроверенного `iss`, и посторонний
   * поддельными токенами закрывал вход гостям настоящего соседа.
   */
  app.post('/fed/v1/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token : null;
    if (!token || token.length > 8192) return reply.code(400).send({ error: 'bad-request' });

    const retryAfter = await fedRateBlock('guestSessionAddress', clientIpOf(req));
    if (retryAfter > 0) return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'rate-limited' });

    const res = await acceptIdentity({ token, now: Date.now() });
    if (!res.ok) {
      if (res.detail) console.warn(`[fed] гостевая сессия отклонена (${res.error}): ${res.detail}`);
      // В журнал — только отказы токенам с верной подписью (F-25): мусор без подписи журнал не засоряет.
      if (res.status === 403 || res.status === 409) {
        fedAudit('federation.guest_session_refused', {
          instanceId: peekIdentityToken(token)?.iss ?? null,
          error: res.error,
          detail: res.detail ?? null,
        });
      }
      if (res.retryAfterS) reply.header('retry-after', String(res.retryAfterS));
      return reply.code(res.status).send({ error: res.error });
    }
    // Первый вход гостя — событие для держателя (§5.10, журнал F-25). Дальше он живёт обычной сессией.
    if (res.created) fedAudit('federation.guest_first_login', { instanceId: peekIdentityToken(token)?.iss ?? null, userId: res.userId });
    return serializeGuestSession({ userId: res.userId, token: res.token, expiresAt: res.expiresAt });
  });

  /**
   * Протокольные POST-запросы живут в СВОЁМ скоупе, потому что им нужен особый разбор тела.
   *
   * 🔴 Подпись считается по ИСХОДНЫМ байтам тела, а Fastify отдаёт обработчику уже разобранный
   * объект. Пересобирать байты обратно через `JSON.stringify` нельзя: `1.0` вернётся как `1`,
   * экранированная escape-последовательность вернётся обычной буквой, и подпись, честно посчитанная отправителем, у нас не
   * сойдётся. Поэтому здесь сырая строка сохраняется до разбора — и сверяется именно она.
   * Скоуп отдельный, чтобы этот разбор не распространился на остальной API.
   */
  await app.register(async (proto) => {
    /**
     * 🔴 СНАЧАЛА снять унаследованный разбор, иначе `add` бросает `FST_ERR_CTP_ALREADY_PRESENT` и
     * бэкенд не поднимается ВООБЩЕ. В `index.ts` уже стоит свой разбор `application/json` (терпит
     * пустое тело), а Fastify считает повтор в дочернем скоупе ошибкой, а не переопределением.
     *
     * Это не всплывало до 17.09, потому что скоуп регистрируется только при `FEDERATION_ENABLED`,
     * а проверки поднимают маршруты на голом Fastify, где глобального разбора нет. Нашлось первым же
     * включением федерации на проде — падением в цикле (#150).
     *
     * Снятие ограничено этим скоупом: проверено запуском — обычные маршруты снаружи по-прежнему
     * берут разбор из `index.ts`, и пустое тело у них по-прежнему не ошибка.
     */
    proto.removeContentTypeParser('application/json');
    proto.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
      (req as { rawBody?: string }).rawBody = typeof raw === 'string' ? raw : raw.toString('utf8');
      try {
        done(null, JSON.parse((req as { rawBody?: string }).rawBody || '{}'));
      } catch {
        done(null, {});
      }
    });

    /**
     * Заявка на связку от соседа, который получил наш код.
     *
     * 🔴 Порядок проверок выбран НАМЕРЕННО: сначала секрет по своей базе, и только потом поход в сеть за
     * визиткой заявителя. Иначе кто угодно заставлял бы наш сервер ходить по адресу из тела запроса —
     * бесплатный сканер чужих сетей нашими руками. Незнакомый секрет отсекается без единого запроса.
     */
    proto.post('/fed/v1/link/request', async (req, reply) => {
      // 🔴 Частота — первым делом, до разбора и до криптографии (#148): иначе поток мусора заставит
      // нас считать подписи, что и есть отказ в обслуживании.
      const retryAfter = await fedRateBlock('linkRequest', clientIpOf(req));
      if (retryAfter > 0) return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'rate-limited' });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const secret = typeof body.secret === 'string' ? body.secret : null;
      const apiBase = typeof body.api_base === 'string' ? body.api_base : null;
      if (!secret || !apiBase) return reply.code(400).send({ error: 'bad-request' });

      const code = await findCodeBySecret(secret);
      if (!code) return reply.code(400).send({ error: 'bad-code' });
      if (code.usedAt !== null) return reply.code(400).send({ error: 'code-used' });
      if (code.expiresAt <= Date.now()) return reply.code(400).send({ error: 'code-expired' });

      let host: string;
      try {
        host = new URL(apiBase).host;
      } catch {
        return reply.code(400).send({ error: 'bad-request' });
      }
      // Короткий срок (#198 п. 3): у заявителя на весь запрос 20 с, а внутри — визитка и `config.json`.
      const peer = await fetchPeerDocument({ apiBase, allowHosts: new Set([host]), now: Date.now(), deadlineMs: LINK_STEP_DEADLINE_MS });
      if (!peer.ok) return reply.code(400).send({ error: peer.problem });

      // Подпись проверяется ключом ИЗ ЕГО ЖЕ визитки: так мы знаем, что заявку прислал владелец ключа,
      // а не тот, кто просто узнал секрет из чужой переписки.
      const verdict = verifyRequest({
        method: req.method,
        targetUri: targetUriOf(req),
        body: (req as { rawBody?: string }).rawBody ?? '',
        headers: req.headers as SignatureHeaders,
        findKey: (kid) => {
          const found = findPeerKey(peer.value.doc, kid, Date.now());
          return found && !found.expired ? Buffer.from(found.key.publicKey, 'base64url') : null;
        },
        nowS: Math.floor(Date.now() / 1000),
      });
      if (!verdict.ok) return reply.code(401).send({ error: verdict.reason, skew_s: verdict.skewS });
      // 🔴 Тот же самый запрос второй раз (#148): подпись верна и срок не вышел, но применять его
      // повторно нельзя — событие вроде «человека забанили» меняет состояние при каждом применении.
      if (await seenSignature(signatureOf(req))) return reply.code(409).send({ error: 'replay' });

      const res = await linkService.receiveRequest({ secret, peer: peer.value });
      if (!res.ok) return reply.code(400).send({ error: res.problem });
      return { state: res.value.state };
  });

    /** Сосед подтвердил нашу заявку. Ключ берём из связки, которая у нас уже есть. */
    proto.post('/fed/v1/link/confirmed', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Связка в этот момент ещё НЕ работает — мы как раз ждём подтверждения, — поэтому рабочего
      // состояния от неё не требуем: иначе установить её было бы невозможно.
      const link = await admitPeer(req, reply, body.instance_id, 'linkConfirm', { requireActive: false });
      if (!link) return;
      // 🔴 Тот же самый запрос второй раз (#148): подпись верна и срок не вышел, но применять его
      // повторно нельзя — событие вроде «человека забанили» меняет состояние при каждом применении.
      if (await seenSignature(signatureOf(req))) return reply.code(409).send({ error: 'replay' });

      const res = await linkService.receiveConfirmed(link.instanceId);
      if (!res.ok) return reply.code(400).send({ error: res.problem });
      return { state: res.value.state };
    });

    /**
     * Пачка событий от связанного соседа (§5.1).
     *
     * 🔴 Связка обязана быть УЖЕ рабочей: события меняют состояние у нас, и принимать их от того, с
     * кем связка на паузе, разорвана или потеряла доверие, нельзя. Поэтому вердикт считается до
     * всякой работы с содержимым.
     * ⚠️ Повтор — не ошибка: отправитель мог не дождаться ответа и послать снова. Отвечаем тем, что
     * реально приняли, а дубли считаем отдельно.
     */
    proto.post(
      '/fed/v1/events',
      createEventsHandler({
        admitPeer,
        seenSignature: (sig) => seenSignature(sig),
        receiveEvents: (instanceId, events) => receiveEvents(instanceId, events),
      }),
    );

    /**
     * Контакты держателя (§5.1.1).
     *
     * 🔴 Не публичны: отдаются только СВЯЗАННОМУ соседу и только по подписанному запросу. Иначе это
     * был бы способ собрать почты и телеграмы администраторов обходом всех инстансов.
     */
    proto.post('/fed/v1/host/contacts', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!(await admitPeer(req, reply, body.instance_id, 'events'))) return;

      // ⚠️ Повтор здесь не проверяем намеренно: это ЧТЕНИЕ, второй такой же запрос ничего не меняет,
      // а тратить на него запись одноразовых меток — платить за защиту от безобидного.
      const meta = await readInstanceMeta();
      return { contacts: serializeContacts(meta.contacts) };
    });

    /**
     * Сосед сообщил, что сменил корневой ключ (кража, §5.1.3).
     *
     * 🔴 Подпись сверяется с тем корневым ключом, что записан у нас В СВЯЗКЕ, а не с визиткой соседа:
     * визитка уже отдаёт НОВУЮ личность, и по ней старый отзыв не проверить. Отсюда и `keyid: 'root'` —
     * сменные ключи сосед стёр вместе со старым корнем.
     * ⚠️ Частота считается по адресу: связка после отзыва всё равно замораживается, а вот поток
     * поддельных отзывов не должен заставлять нас проверять подписи без конца.
     */
    proto.post('/fed/v1/key/revoked', async (req, reply) => {
      const retryAfter = await fedRateBlock('linkConfirm', clientIpOf(req));
      if (retryAfter > 0) return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'rate-limited' });

      const notice = parseRevocation(req.body);
      if (!notice) return reply.code(400).send({ error: 'bad-request' });

      const link = await getLink(notice.oldInstanceId);
      if (!link) return reply.code(401).send({ error: 'unknown' });

      const verdict = verifyRequest({
        method: req.method,
        targetUri: targetUriOf(req),
        body: (req as { rawBody?: string }).rawBody ?? '',
        headers: req.headers as SignatureHeaders,
        findKey: (kid) => (kid === 'root' ? Buffer.from(link.rootKey, 'base64url') : null),
        nowS: Math.floor(Date.now() / 1000),
      });
      if (!verdict.ok) {
        // До верной подписи — тот же `unknown`, что и на «нет такой связки» (F-12).
        const refusal = refusalFor(verdict.reason, verdict.skewS);
        return reply.code(refusal.status).send({ error: refusal.error, skew_s: refusal.skewS });
      }
      if (await seenSignature(signatureOf(req))) return reply.code(409).send({ error: 'replay' });

      const res = await receiveRevocation(notice);
      if (!res.ok) return reply.code(400).send({ error: res.problem });
      return { state: 'trust-lost' };
    });
  });

  /**
   * Наша копия аватара человека с соседнего инстанса — для своих клиентов (§5.4).
   *
   * 🔴 Картинку забирает БЭКЕНД, а клиент получает адрес в нашем хранилище. Ходи клиент за ней сам,
   * достаточно было бы открыть список людей соседа, чтобы браузер оставил свой адрес на чужом домене,
   * а держатель того инстанса собрал бы адреса всех, кто эту вкладку открывал.
   * ⚠️ Это POST, хотя по сути чтение: «подготовь картинку» — действие, и у него бывают последствия
   * (поход в сеть, запись в хранилище). Обычным GET его нельзя было бы отличить от бесплатного чтения.
   */
  await app.register(async (mine) => {
    mine.addHook('preHandler', requireAuth);

    /**
     * Токен личности для входа на чужой инстанс (§5.5).
     *
     * 🔴 Выдаётся ТОЛЬКО своему вошедшему человеку и только на себя: `sub` берётся из сессии, а не
     * из тела запроса. Иначе любой вошедший выписывал бы поручительства за соседей по инстансу.
     */
    mine.post('/fed/identity-token', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hostInstanceId = typeof body.instance_id === 'string' ? body.instance_id : null;
      if (!hostInstanceId) return reply.code(400).send({ error: 'bad-request' });

      const res = await issueIdentityFor({ userId: req.user!.sub, hostInstanceId, now: Date.now() });
      if (!res.ok) {
        // 404 только на «нет такого человека»: остальное — состояние федерации, и о нём человеку
        // честно говорят кодом, по которому клиент подберёт текст (§4.2.1).
        const status = res.problem === 'not-found' ? 404 : res.problem === 'unavailable' ? 503 : 409;
        return reply.code(status).send({ error: res.problem });
      }
      return { token: res.token, expires_at: res.expiresAt };
    });

    /**
     * Проверить вставленную ссылку (§4.2.1). Ходит к соседу НАШ бэкенд, а не клиент человека.
     */
    // 🔴 Только местным и с пределом по человеку (аудит 19.09, F-16): гость чужого инстанса иначе
    // заставлял НАШ бэкенд подписанно спрашивать других соседей, а один человек выбирал весь часовой
    // лимит предпросмотров у соседа — окно проверки ссылок переставало работать у всех наших людей.
    mine.post('/fed/invite-preview', { preHandler: requireLocalUser }, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = typeof body.url === 'string' ? body.url : null;
      if (!raw || raw.length > 2048) return reply.code(400).send({ error: 'bad-request' });
      const wait = await rateHit(`fed:preview:${req.user!.sub}`, 20, 10 * 60);
      if (wait > 0) return reply.code(429).header('retry-after', String(wait)).send({ error: 'rate-limited' });

      const view = await previewInvite({ userId: req.user!.sub, raw, now: Date.now() });
      // `null` — это не «ссылка не работает», а «это вообще не ссылка и не код»: клиент по такому
      // ответу просит человека проверить, что он вставил.
      if (!view) return reply.code(400).send({ error: 'bad-invite' });
      return view;
    });

    /**
     * «Где я гость» (§5.7): инстансы и серверы из НАШЕГО индекса членств.
     *
     * ⚠️ Состояние связки приклеиваем к каждому месту здесь, а не заставляем клиент искать его
     * отдельным запросом: список без него врал бы — сервер виден, а войти нельзя.
     */
    mine.get('/fed/my-guest', async (req): Promise<GuestPlacesView> => {
      const [rows, links, meta] = await Promise.all([guestMembershipsOf(req.user!.sub), listLinks(), readInstanceMeta()]);
      // Имена — через защиту от одноимённых (F-11): совпавшее с нашим или с другой связкой идёт с доменом.
      const names = linkDisplayNames(links, meta.name);
      const byInstance = new Map<string, GuestPlacesView['places'][number]>();
      for (const row of rows) {
        const link = links.find((l) => l.instanceId === row.instanceId);
        // Связки нет вовсе (её удалили, а членство осталось) — место всё равно показываем: человеку
        // важно знать, что он там числится. Молча прятать значило бы врать про свои же данные.
        let place = byInstance.get(row.instanceId);
        if (!place) {
          place = {
            instanceId: row.instanceId,
            name: names.get(row.instanceId) ?? null,
            domain: link?.domain ?? '',
            clientOrigin: link?.clientOrigin ?? '',
            linkState: link?.state ?? 'unknown',
            servers: [],
          };
          byInstance.set(row.instanceId, place);
        }
        place.servers.push({
          serverId: row.serverId,
          name: row.serverName,
          state: row.state,
          reason: row.reason,
        });
      }
      const places = [...byInstance.values()];
      for (const p of places) p.servers.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      places.sort((a, b) => (a.name ?? a.domain).localeCompare(b.name ?? b.domain, 'ru'));
      return { places };
    });

    /**
     * «Завершить сессию на этом инстансе» — просит ХОЗЯИН сессии, то есть сам гость (§5.7).
     *
     * 🔴 Это маршрут ХОСТА, хотя лежит рядом с домашними: зовёт его гость своим гостевым токеном,
     * и поднимает он поколение теневой строки — то же самое, что «выйти везде» делает у себя дома.
     * Отдельная кнопка нужна затем, что гостевая сессия живёт БЕЗ дома (§5.6): выйти из неё через
     * дом нельзя в принципе, когда дом лежит.
     *
     * ⚠️ Местному человеку тут делать нечего: у него есть обычный «выйти везде» с паролем. Гостю
     * пароль предъявить неоткуда — его пароль хранится дома.
     */
    mine.post('/fed/guest-session/end', async (req, reply) => {
      const [me] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
      if (!me?.homeInstanceId) return reply.code(403).send({ error: FED_ERRORS.guestForbidden });
      const gen = await bumpTokenGeneration(me.id);
      return { ok: true, gen };
    });

    // Только местным и с пределом по человеку (F-16): картинка качается с соседа и ложится в наше хранилище.
    mine.post('/fed/avatar/:instanceId/:userId', { preHandler: requireLocalUser }, async (req, reply) => {
      const { instanceId, userId } = req.params as { instanceId: string; userId: string };
      if (!isInstanceId(instanceId) || userId.length > 64) return reply.code(400).send({ error: 'bad-request' });
      const wait = await rateHit(`fed:pavatar:${req.user!.sub}`, 60, 10 * 60);
      if (wait > 0) return reply.code(429).header('retry-after', String(wait)).send({ error: 'rate-limited' });
      const url = await peerAvatarUrl(instanceId, userId);
      if (!url) return reply.code(404).send({ error: 'no-avatar' });
      return { url };
    });
  });

  /**
   * Имена людей по парам (инстанс, id) из кеша каталога соседей (F2).
   *
   * 🔴 Держателю в журнале запретов и в жалобах нужен ЧЕЛОВЕК, а не идентификатор: по «u_8f31…» он
   * никого не узнает и решение принять не сможет. Спрашивать соседа ради строки списка мы не идём —
   * ровно для этого кеш каталога и держится.
   * ⚠️ Не нашлось — `null`, и интерфейс покажет идентификатор. Выдумывать «неизвестный» нельзя:
   * человека могли скрыть от соседей или удалить, и это не наша ошибка.
   */
  async function peerNameMap(
    pairs: { instanceId: string; userId: string }[],
  ): Promise<Map<string, { username: string; displayName: string }>> {
    const ids = [...new Set(pairs.map((p) => p.userId))];
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({
        instanceId: federationPeerUsers.instanceId,
        userId: federationPeerUsers.userId,
        username: federationPeerUsers.username,
        displayName: federationPeerUsers.displayName,
      })
      .from(federationPeerUsers)
      .where(inArray(federationPeerUsers.userId, ids));
    return new Map(
      rows.map((r) => [`${r.instanceId}:${r.userId}`, { username: r.username, displayName: r.displayName }]),
    );
  }

  /** Вкладка «Федерация» — только для держателя инстанса. */
  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAuth);
    admin.addHook('preHandler', requireSuperAdmin);

    admin.get('/admin/federation', async () => {
      const identity = federation.identity();
      const meta = await readInstanceMeta();
      return {
        status: federation.status(),
        problem: federation.problem(),
        paused: meta.paused,
        contacts: meta.contacts,
        // 🔴 Поводы едут вместе с обзором, а не отдельным запросом: баннер обязан быть виден ровно
        // тогда, когда держатель открыл вкладку, а не «когда догрузится».
        alerts: await openAlerts(),
        alertSettings: await alertSettings(),
        instance: identity
          ? {
              instanceId: identity.instanceId,
              fingerprint: identity.fingerprint,
              domain: env.clientOrigin,
              name: meta.name,
              iconHash: meta.iconHash,
            }
          : null,
        links: await Promise.all(
          (await listLinks()).map(async (l) => ({
          instanceId: l.instanceId,
          domain: l.domain,
          name: l.localName ?? l.theirName,
          theirName: l.theirName,
          state: l.state,
          protocolVersion: l.protocolVersion,
          features: l.features,
          confirmedAt: l.confirmedAt,
          lastSeenAt: l.lastSeenAt,
          clockSkewMs: l.clockSkewMs,
          queued: l.queued,
          sync: await syncRowsFor(l.instanceId),
          // Файлы гостей лежат в НАШЕМ хранилище и стоят нам места (§5.10): держатель обязан
          // видеть, сколько занято, до того как гость упрётся в предел.
          quota: await quotaRowFor(l.instanceId),
        })),
        ),
      };
    });

    /** Журнал федерации (F-25): последние события связок, гостей и потери доверия — для вкладки. */
    admin.get('/admin/federation/audit', async () => ({ entries: await recentAudit(200) }));

    /**
     * Настройки оповещений (§5.10): тема ntfy, письма, порог «связка лежит».
     *
     * ⚠️ Проверку гоняем сразу после правки: держатель, поставивший порог в пять минут, должен
     * увидеть результат, а не ждать следующего круга.
     */
    admin.patch('/admin/federation/alerts', async (req) => {
      // Тело читаем так же, как соседние маршруты этого файла: руками, без zod — его тут нет.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const minutes = typeof body.linkDownAfterMinutes === 'number' ? Math.round(body.linkDownAfterMinutes) : undefined;
      const next = await saveAlertSettings({
        ...(typeof body.ntfyTopic === 'string' ? { ntfyTopic: body.ntfyTopic.slice(0, 200) } : {}),
        ...(typeof body.email === 'boolean' ? { email: body.email } : {}),
        // Порог держим в разумных границах: минута — минимум, за которым проверка начинает врать,
        // сутки — предел, за которым оповещение опаздывает настолько, что теряет смысл.
        ...(minutes && minutes >= 1 && minutes <= 1440 ? { linkDownAfterMinutes: minutes } : {}),
      });
      void runFederationAlerts().catch(() => {
        /* круг проверки не должен ронять сохранение настройки */
      });
      return next;
    });

    /**
     * Запреты чужим людям на весь инстанс (§5.11, требование 36).
     *
     * 🔴 Ставит ТОЛЬКО админ инстанса — этот скоуп уже под `requireSuperAdmin`. Владелец сервера
     * банит у себя на сервере, но закрыть человеку весь инстанс — решение держателя.
     */
    admin.get('/admin/federation/bans', async (): Promise<{ bans: FederationBanRow[] }> => {
      const rows = await listInstanceBans();
      // Ник запрещённого — из кеша каталога соседа: держателю нужен человек, а не идентификатор.
      const names = await peerNameMap(rows.map((r) => ({ instanceId: r.homeInstanceId, userId: r.homeUserId })));
      return {
        bans: rows.map((r) => ({
          instanceId: r.homeInstanceId,
          userId: r.homeUserId,
          username: names.get(`${r.homeInstanceId}:${r.homeUserId}`)?.username ?? null,
          displayName: names.get(`${r.homeInstanceId}:${r.homeUserId}`)?.displayName ?? null,
          reason: r.reason,
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
          removedAt: r.removedAt ? r.removedAt.toISOString() : null,
          removedBy: r.removedBy,
        })),
      };
    });

    admin.post('/admin/federation/bans', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : null;
      const userId = typeof body.user_id === 'string' ? body.user_id : null;
      if (!instanceId || !userId) return reply.code(400).send({ error: 'bad-request' });

      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      const days = typeof body.days === 'number' && Number.isFinite(body.days) ? body.days : null;
      const expiresAt = days && days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

      const res = await banInstanceUser({
        homeInstanceId: instanceId,
        homeUserId: userId,
        reason,
        expiresAt,
        createdBy: req.user!.sub,
      });

      // Жалоба — отдельная галочка в том же окне: запрет работает и без неё (§5.11).
      let report: { sent: boolean; problem?: string } = { sent: false };
      if (body.report === true) {
        const link = await getLink(instanceId);
        if (!link || !link.features.includes(FED_FEATURES.reports)) {
          report = { sent: false, problem: FED_ERRORS.unsupported };
        } else {
          const evidence = Array.isArray(body.evidence) ? body.evidence : [];
          const sent = await sendReport({
            instanceId,
            reportedUserId: userId,
            action: 'instance_ban',
            serverName: null,
            reason,
            evidence: evidence
              .map((e) => e as Record<string, unknown>)
              .filter((e) => typeof e.text === 'string')
              .map((e) => ({
                text: String(e.text).slice(0, 2000),
                at: typeof e.at === 'number' ? e.at : Date.now(),
                channel: typeof e.channel === 'string' ? e.channel : '',
              })),
          });
          report = sent.ok ? { sent: true } : { sent: false, problem: sent.problem };
        }
      }

      /**
       * ⚠️ Журнал запретов — САМА таблица `instance_bans` (кто, кого, срок, причина, снятие), а не
       * серверный аудит: тот читается по серверу и правом `VIEW_AUDIT_LOG`, а запрет на инстанс —
       * решение держателя, к отдельному серверу не относящееся.
       */
      return { ok: true, servers: res.servers.length, report };
    });

    admin.delete('/admin/federation/bans/:instanceId/:userId', async (req, reply) => {
      const { instanceId, userId } = req.params as { instanceId: string; userId: string };
      const removed = await unbanInstanceUser(instanceId, userId, req.user!.sub);
      if (!removed) return reply.code(404).send({ error: 'not-found' });
      // Прежние членства НЕ возвращаются (как бан в Discord) — человек входит заново по ссылке.
      return { ok: true };
    });

    /**
     * Контакты держателя СОСЕДНЕГО инстанса (§5.1.1).
     *
     * ⚠️ Нужны ровно там, где мы чего-то не можем сами: сосед не принимает жалобы — значит писать
     * ему придётся руками, и окно обязано показать куда. Берутся из кеша связки, в сеть не идём.
     */
    admin.get('/admin/federation/links/:instanceId/contacts', async (req) => {
      const { instanceId } = req.params as { instanceId: string };
      return { contacts: await contactsOfPeer(instanceId) };
    });

    /** Жалобы: наши соседям и соседей на наших людей (§5.11). */
    admin.get('/admin/federation/reports', async (): Promise<{ reports: FederationReportRow[] }> => {
      const rows = await listReports();
      const names = await peerNameMap(rows.map((r) => ({ instanceId: r.instanceId, userId: r.reportedUserId })));
      const incoming = rows.filter((r) => r.direction === 'in').map((r) => r.reportedUserId);
      const localRows = incoming.length
        ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, incoming))
        : [];
      const localNames = new Map(localRows.map((r) => [r.id, r.displayName]));
      return {
        reports: rows.map((r) => ({
          id: r.id,
          direction: r.direction === 'in' ? 'in' : 'out',
          instanceId: r.instanceId,
          reportedUserId: r.reportedUserId,
          // У ВХОДЯЩЕЙ жалобы речь о нашем человеке, и кеш каталога соседа про него ничего не знает —
          // имя тогда достаём из своей же таблицы людей.
          reportedName:
            names.get(`${r.instanceId}:${r.reportedUserId}`)?.displayName ?? localNames.get(r.reportedUserId) ?? null,
          action: r.action,
          serverName: r.serverName,
          reason: r.reason,
          evidence: r.evidence,
          status: r.status,
          reply: r.reply,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    });

    admin.post('/admin/federation/reports/:id/reply', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : null;
      if (!text) return reply.code(400).send({ error: 'bad-request' });
      const done = await replyToReport(id, text);
      if (!done) return reply.code(404).send({ error: 'not-found' });
      return { ok: true };
    });

    /**
     * Каталоги соседей для вкладок «Пользователи» и «Серверы» (§4.1).
     *
     * ⚠️ Свежесть считается ЗДЕСЬ и отдаётся словами: интерфейс не должен сам решать, с какого
     * момента кеш стоит называть устаревшим — иначе два места будут называть его по-разному.
     */
    admin.get('/admin/federation/directory', async (): Promise<FederationDirectoryView> => {
      if (federation.status() === 'off') return { enabled: false, peers: [] };
      const now = Date.now();
      const [links, meta] = await Promise.all([listLinks(), readInstanceMeta()]);
      // 🔴 Имя — через защиту от одноимённых (F-11), как у значка гостя и предпросмотра приглашения.
      // Без неё окно «Запретить вход» писало «с инстанса «<наше имя>»» и «Пожаловаться держателю «<наше
      // имя>»» про соседа, назвавшегося как мы, — без домена (мегаприёмка 23.09).
      const names = linkDisplayNames(links, meta.name);
      const peers = await Promise.all(
        links.map(async (link) => {
          const state = await readSyncState(link.instanceId, 'directory');
          const users = await peerUsers(link.instanceId);
          const servers = await peerServers(link.instanceId);
          return {
            instanceId: link.instanceId,
            name: names.get(link.instanceId) ?? null,
            domain: link.domain,
            state: link.state,
            freshness: freshnessText(state.lastDeltaAt ?? state.lastFullAt, now),
            // «Недоступен» здесь — это про синхронизацию, а не про связку: связка может быть рабочей,
            // а сосед лежать, и держателю важно именно второе.
            reachable: state.failures === 0,
            users: users.map((u) => ({
              userId: u.userId,
              username: u.username,
              displayName: u.displayName,
              avatarHash: u.avatarHash,
              avatarUrl: u.avatarLocalUrl,
            })),
            servers: servers.map((srv) => ({
              serverId: srv.serverId,
              name: srv.name,
              iconHash: srv.iconHash,
              members: srv.members,
            })),
          };
        }),
      );
      return { enabled: true, peers };
    });

    /**
     * «Синхронизировать сейчас» (§4.1.1).
     *
     * Всегда ПОЛНАЯ сверка, а не дельта: держатель жмёт эту кнопку именно тогда, когда подозревает
     * расхождение, — а дельта по определению не может его найти.
     */
    /**
     * Предел места для файлов гостей связки и счётчик занятого (§5.10, требование 30).
     *
     * ⚠️ `reset` и `bytes` — одно действие, а не два маршрута: держатель, поднимая предел после
     * разбора завалов, обычно тем же движением обнуляет счётчик (учёт односторонний, см.
     * `guestQuota.ts`), и разносить это по двум кнопкам значило бы заставлять его делать два шага.
     */
    admin.patch('/admin/federation/links/:instanceId/quota', async (req, reply) => {
      const { instanceId } = req.params as { instanceId: string };
      const body = (req.body ?? {}) as { bytes?: unknown; reset?: unknown };
      const link = await getLink(instanceId);
      if (!link) return reply.code(404).send({ error: 'unknown-link' });
      if (typeof body.bytes === 'number' && Number.isFinite(body.bytes)) {
        if (body.bytes < 0) return reply.code(400).send({ error: 'предел не может быть отрицательным' });
        await setQuota(instanceId, body.bytes);
      }
      if (body.reset === true) await resetQuota(instanceId);
      const now = await quotaOf(instanceId);
      return { used: now?.used ?? 0, limit: now?.quota ?? 0 };
    });

    admin.post('/admin/federation/links/:instanceId/sync', async (req, reply) => {
      const { instanceId } = req.params as { instanceId: string };
      const link = await getLink(instanceId);
      if (!link) return reply.code(404).send({ error: 'unknown-link' });
      // Под той же отметкой, что и плановый проход (#196 п. 9): второй заход поверх незаконченного —
      // наложение, от которого F-09 и защищала.
      const res = await syncLinkNow(instanceId);
      if (res.problem) return reply.code(409).send({ error: `sync-${res.problem}` });
      return { directory: res.directory, servers: res.servers };
    });

    /**
     * Название и иконка инстанса (§5.1.2): людям домен ничего не говорит, поэтому у инстанса есть имя.
     *
     * Пустое имя — не ошибка, а «показывать домен». Смена рассылается связкам событием, так что сосед
     * узнаёт новое имя сразу, а не при следующем чтении визитки.
     */
    admin.patch('/admin/federation/instance', async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; iconHash?: unknown };
      const rawName = typeof body.name === 'string' ? body.name.trim() : '';
      if (rawName.length > 0) {
        const problem = checkInstanceName(rawName);
        if (problem) return reply.code(400).send({ error: problem });
      }
      return await writeInstanceMeta({
        name: rawName.length > 0 ? rawName : null,
        iconHash: typeof body.iconHash === 'string' && body.iconHash.length > 0 ? body.iconHash : null,
      });
    });

    /** Шаг 1: выдать код. 🔴 Секрет показывается ОДИН раз — у нас остаётся только его хеш. */
    admin.post('/admin/federation/code', async (req, reply) => {
      const res = await linkService.issueCode({ issuedBy: req.user!.sub });
      if (!res.ok) return reply.code(409).send({ error: res.problem });
      return { code: res.value.code, expiresAt: res.value.expiresAt };
    });

    /** Шаг 2: держатель вставил код соседа. */
    admin.post('/admin/federation/link', async (req, reply) => {
      const code = (req.body as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || code.length > 4096) return reply.code(400).send({ error: 'bad-request' });
      const res = await linkService.requestLink(code);
      if (!res.ok) return reply.code(409).send({ error: res.problem, detail: res.detail });
      return res.value;
    });

    /** Шаг 3: держатель подтверждает пришедшую заявку. */
    admin.post('/admin/federation/links/:instanceId/confirm', async (req, reply) => {
      const { instanceId } = req.params as { instanceId: string };
      const res = await linkService.confirmLink(instanceId);
      if (!res.ok) return reply.code(409).send({ error: res.problem, detail: res.detail });
      return res.value;
    });

    /** Контакты держателя: до пяти записей, ссылка строится только из разрешённых схем. */
    admin.put('/admin/federation/contacts', async (req, reply) => {
      const raw = (req.body as { contacts?: unknown } | null)?.contacts;
      const contacts = parseContacts(raw);
      // Разбор уже отбросил негодные записи; проверка ловит то, что человек ввёл лишнего.
      const problem = checkContacts(contacts);
      if (problem) return reply.code(400).send({ error: problem });
      const meta = await readInstanceMeta();
      const saved = await writeInstanceMeta({ name: meta.name, iconHash: meta.iconHash, contacts });
      return { contacts: saved.contacts };
    });

    /**
     * Аварийная пауза ВСЕЙ федерации (требование 30).
     *
     * ⚠️ Не то же самое, что пауза одной связки: это рубильник на случай «что-то происходит, разберусь
     * позже». Входящие получают понятный отказ, исходящие копятся, перезапуск не нужен.
     */
    admin.post('/admin/federation/pause', async (req) => {
      const paused = (req.body as { paused?: unknown } | null)?.paused !== false;
      const meta = await setFederationPaused(paused);
      return { paused: meta.paused };
    });

    /**
     * «Ключ скомпрометирован» (§5.1.3).
     *
     * 🔴 Необратимо: у инстанса меняется личность, и ВСЕ связки требуют перепривязки. Поэтому
     * подтверждение приходит телом запроса — случайный клик по кнопке не должен этого делать.
     */
    admin.post('/admin/federation/revoke-key', async (req, reply) => {
      const body = (req.body ?? {}) as { confirm?: unknown };
      if (body.confirm !== true) return reply.code(400).send({ error: 'confirm-required' });
      const res = await revokeOwnKey();
      if (!res) return reply.code(409).send({ error: 'federation-off' });
      return res;
    });

    /** Код перепривязки для одной связки: тот же механизм, что код связки, но помнит старую личность. */
    admin.post('/admin/federation/links/:instanceId/rebind-code', async (req, reply) => {
      const { instanceId } = req.params as { instanceId: string };
      const res = await linkService.issueCode({
        issuedBy: req.user!.sub,
        purpose: 'rebind',
        previousInstanceId: instanceId,
      });
      if (!res.ok) return reply.code(409).send({ error: res.problem });
      return { code: res.value.code, expiresAt: res.value.expiresAt };
    });

    /**
     * Перепривязка: держатель вставил код новой личности соседа НА КАРТОЧКЕ его связки (§5.1.3).
     *
     * 🔴 Какую связку переносить, говорит адрес маршрута — то есть клик держателя, — а не поле `o`
     * внутри кода: код пишет тот, кто его выдал. Общее поле «Связаться» коды перепривязки не берёт
     * вовсе (`rebind-code`). До 19.09 было наоборот, и подложенный код уводил чужую рабочую связку
     * вместе с гостями (аудит, F-01).
     */
    admin.post('/admin/federation/links/:instanceId/rebind', async (req, reply) => {
      const { instanceId } = req.params as { instanceId: string };
      const code = (req.body as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || code.length > 4096) return reply.code(400).send({ error: 'bad-request' });
      const res = await linkService.requestLink(code, { rebindOf: instanceId });
      if (!res.ok) return reply.code(409).send({ error: res.problem, detail: res.detail });
      return res.value;
    });

    /** Пауза, снятие паузы и разрыв — кнопки во вкладке. */
    admin.post('/admin/federation/links/:instanceId/:action', async (req, reply) => {
      const { instanceId, action } = req.params as { instanceId: string; action: string };
      if (action !== 'pause' && action !== 'resume' && action !== 'block') {
        return reply.code(404).send({ error: 'unknown-action' });
      }
      const res = await linkService.applyAdminAction(instanceId, action);
      if (!res.ok) return reply.code(409).send({ error: res.problem, detail: res.detail });
      return res.value;
    });
  });
}
