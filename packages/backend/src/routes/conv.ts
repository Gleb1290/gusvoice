import { CONV_GEOLIVE_FEDERATED_ERROR, CONV_POLL_FEDERATED_ERROR, CONV_POLL_LIMITS, FEATURE_BIGREACT1, FED_ERRORS, MESSAGE_PRIVACY_ERROR, REPLY_QUOTE_MAX, SHARED_MEDIA_PAGE, convMediaFallback, convMediaPreview } from '@gusvoice/shared';
import type { ConvGone, ConvMessage } from '@gusvoice/shared';
import { ALBUM_ITEM_PEER_OLD_ERROR, type ConvAlbumItemDeleteResponse } from '@gusvoice/shared';
import { isOnceMedia, ONCE_MEDIA_REFUSED } from '@gusvoice/shared';
import { BOT_UNAVAILABLE_CODE, BOT_UNAVAILABLE_ERRORS, botUnavailableFor } from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { messageSendBlock, pushDebounced, rateHit, retryMessage } from '../authGuard.js';
import { requireLocalUser } from '../guestGuard.js';
import { acceptDmUpload, convAttachmentRefsSchema } from './att.js';
import { catalogSticker } from '../stickerCatalog.js';
import { dmDeliveryPlan } from '../blockRules.js';
import { blockedBy, isBlockedBy } from '../blocks.js';
import {
  botConv,
  queueBotChatMember,
  createDirect,
  resolveConvMedia,
  convHasRemote,
  convPollFederates,
  ensureSaved,
  deleteAlbumItem,
  deleteMessage,
  clearHistory,
  deleteMessages,
  hideConversation,
  hideFormerGroup,
  deliver,
  deliverMany,
  editMessage,
  findDirect,
  forwardMessages,
  history,
  searchConversation,
  sharedMedia,
  sharedMediaCounts,
  searchAllConversations,
  frequentConversations,
  FREQUENT_HIDE_MAX,
  hideFrequentConversations,
  unreadReactionMessages,
  unreadMentionMessages,
  markReactionsRead,
  listConversations,
  listPins,
  listScheduled,
  loadAccess,
  markAllRead,
  markRead,
  messageFor,
  messagesFor,
  pinMessage,
  listenVoice,
  spendVoiceOnce,
  openOnceMedia,
  formerLeftAt,
  reactionAllowed,
  reactMessage,
  reorderConversationPins,
  revealDirect,
  saveDraft,
  sendMessage,
  setConversationPinned,
  setConversationUnreadMark,
  setConversationArchived,
  syncSince,
  unpinMessage,
  type ConvAccess,
} from '../conversations.js';
import { fanOutSend, pushGroupPack } from '../convSendFanout.js';
// Опрос (convpoll1): действия — в `convPolls.ts`, подгружаются в ручках через `import()` (`pollActions`): тесты держат закрытый
// перечень импортов этого модуля при загрузке (`federationDmOpenRoutes.itest.ts`, `indexErrors.test.ts`).
import type { ConvPollActResult } from '../convPolls.js';
const pollActions = () => import('../convPolls.js');
// Трансляция геопозиции (geolive1): так же — через `import()` в ручках.
import type { ConvGeoLiveActResult } from '../convGeoLives.js';
const geoLiveActions = () => import('../convGeoLives.js');

import { hideStrangerBar, reportConversationPeer } from '../dmReports.js';
import { DM_REPORT_LIMIT, isDmReportReason } from '../strangerRules.js';
import { configureScheduledLinkGuard, createScheduled, deleteScheduled, editScheduled, sendScheduledNow } from '../scheduled.js';
import {
  SCHEDULE_MAX_AHEAD_DAYS,
  SCHEDULED_TEXT_MAX,
  scheduledMediaLimitBody,
  scheduleTarget,
  type ScheduleTarget,
  type ScheduleTargetError,
} from '../scheduleRules.js';
import {
  decodeCursor,
  SEARCH_QUERY_MAX,
  searchPattern,
  DRAFT_TEXT_MAX,
  MESSAGE_TEXT_MAX,
  TEXT_TOO_LONG,
  FORWARD_ATTACHMENTS_MAX,
  FORWARD_BYTES_MAX,
  HISTORY_LIMIT_MAX,
  isDraftDevice,
  isSortKey,
  bigReactionTargets,
  MESSAGE_BATCH_MAX,
  PINS_MAX,
  SYNC_LIMIT_MAX,
} from '../convRules.js';
import { contactNamesFor } from '../contacts.js';
import { pushNameFor } from '../contactRules.js';
import { db } from '../db/index.js';
import { publishToUser } from '../realtime.js';
import { publishDmFolders } from './dmFolders.js';
import { shareServer } from '../db/peerQueries.js';
import { canScheduleUntilOnline, readAtFor, readersFor } from '../lastSeen.js';
import { attachments as attachmentRows, bots, conversationMessages, users } from '../db/schema.js';
import { canWriteDm, DM_NEW_LIMIT, DM_PEER_GONE_ERROR, dmOpenRefusal, openDm } from '../dmRules.js';
import { dmPolicy } from '../instanceSetup.js';
import { reachableUser } from '../userSearchRules.js';
import { forwardPreview, pushThrottleSource, sendPushToUsers, sendReadSyncPush, withSilent } from '../push.js';
import { asUserId } from '../superAdminRules.js';

/**
 * ЛС, этап 1 — ручки бесед `/api/conv/*` (#211, `docs/dm/STAGE1.md`, «Новые ручки»). Вся запись и чтение — в
 * `conversations.ts`, правила — в `convRules.ts`; здесь разбор запроса, права, лимиты и коды ответа.
 *
 * С шага 1б живые ЛС лежат в беседах, и сервер объявляет `features: ['conv1']` (`instanceFeatures.ts`). Старые
 * ручки `/api/dm*` и их рассылка `dm.*`/`read.dm` клиентам 0.8.x сняты (вывод старых ЛС, шаг 5): изменение уходит
 * одним `conv.change` (`deliver`) соединениям с `conv1`.
 */

const convParams = z.object({ id: z.string().min(1).max(64) });
const msgParams = z.object({ id: z.string().min(1).max(64), mid: z.string().min(1).max(64) });

/** Лимиты правок, реакций и «прочитано» — раньше у ЛС их не было вовсе (разбор Codex 28.09). */
const EDIT_MAX = 30;
const REACT_MAX = 40;
const READ_MAX = 60;
/** `GET /conv/frequent`: полоса грузится при каждом открытии пустого поиска — 20 за минуту хватает с запасом. */
const FREQUENT_MAX = 20;
const FREQUENT_WINDOW_S = 60;
/** Черновик клиент пишет после паузы в наборе (Р7) — 30 за 10 с хватает с запасом и на несколько бесед сразу. */
const DRAFT_MAX = 30;
const WINDOW_S = 10;
/**
 * Пересылок (`conv5`) — 10 в минуту СВЕРХ одной операции общего бюджета отправки (`messageSendBlock`): пачка — до 100
 * сообщений и до 40 копий файлов, без своего предела 20 операций за 10 с давали бы 200 сообщений в секунду в чужую
 * беседу и сотни копий в хранилище.
 */
const FORWARD_MAX = 10;
const FORWARD_WINDOW_S = 60;
/**
 * Закрепов и откреплений (С2, `conv7`) — 20 за 10 с: «для обоих» меняет список собеседника и шлёт ему событие, а человеку
 * хватает с запасом и на «открепить всё» по одному.
 */
const PIN_MAX = 20;
/** Закреп беседы в списке (07.10, `conv11`): столько переключений за окно `WINDOW_S` у человека. */
const CONV_PINNED_MAX = 20;
/** Пометка «непрочитанным» (07.10, `conv13`) и «Прочитать все»: столько операций за окно `WINDOW_S` у человека. */
const CONV_UNREAD_MARK_MAX = 30;
const CONV_ARCHIVED_MAX = 60;
const CONV_READ_ALL_MAX = 3;
/**
 * Отложенных (С4, `conv9`): создать, поправить, перенести, удалить, «отправить сейчас» — 30 за 10 с на человека (как
 * правки); «отправить сейчас» вдобавок тратит операцию общего бюджета отправки (`messageSendBlock`). Сама отправка тактом
 * бюджет не тратит: она — следствие уже принятого создания.
 */
const SCHED_MAX = 30;
/** Список id сообщений пачки: 1…`MESSAGE_BATCH_MAX`. */
const batchIds = z.array(z.string().min(1).max(64)).min(1).max(MESSAGE_BATCH_MAX);
const schedParams = z.object({ id: z.string().min(1).max(64), sid: z.string().min(1).max(64) });

async function limited(reply: FastifyReply, wait: number): Promise<boolean> {
  if (!wait) return false;
  await reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
  return true;
}

/** 400 на режим/время отложенного (`scheduleRules.scheduleTarget`); «слишком далеко» — с пределом в днях. */
function scheduleError(reply: FastifyReply, error: ScheduleTargetError) {
  return reply.code(400).send(error === 'send_at too far' ? { error, maxDays: SCHEDULE_MAX_AHEAD_DAYS } : { error });
}

/**
 * ЛС между инстансами, Э1 (#141, `fedm1`): «Написать» человеку связанного инстанса — `federation/convOpen.openFederatedDirect`.
 * Подключает `index.ts` при `FEDERATION_DM_ENABLED` (как `configureFederatedConv`): этот модуль компилируют проверки с явным
 * перечнем зависимостей, и федерация (ключи, связки) ему не нужна. Не подключено — прежний отказ `federation.dm_unavailable`.
 */
export type FedDirectOpener = (
  me: string,
  target: { instanceId: string; homeUserId: string },
) => Promise<
  | { ok: true; conversationId: string; created: boolean }
  | { ok: false; status: number; body: Record<string, unknown>; retryAfter?: number }
>;
let fedDirect: FedDirectOpener | null = null;
export function configureFedDirect(open: FedDirectOpener | null): void {
  fedDirect = open;
}

/**
 * Файлы в беседу 1:1 с человеком другого инстанса (Э2 → Э3 часть 1, #141): можно, если его инстанс умеет вложения (`dm2`).
 * Проверку подключает `index.ts` при `FEDERATION_DM_ENABLED` (`federation/convAtt.fedFilesAllowedFor`, визитка перечитывается
 * не чаще раза в час) — крючком, как `configureFedDirect`: этот модуль проверки собирают с явным перечнем зависимостей.
 * Не подключено — прежний отказ Э2. Все входы записи с файлами (правило «все входы»): загрузка одним запросом и кусками
 * (`routes/uploads.ts`), «Мои GIF» и внешний GIF (`routes/gifs.ts`), отправка и отложенное с вложениями, пересылка с файлами.
 */
let fedFilesAllowed: ((peerId: string) => Promise<boolean>) | null = null;
export function configureFedFilesGuard(guard: ((peerId: string) => Promise<boolean>) | null): void {
  fedFilesAllowed = guard;
}

/** Собеседник — человек другого инстанса (теневая строка с `home_instance_id`). */
async function isRemotePeer(peerId: string | null): Promise<boolean> {
  if (!peerId) return false;
  const [row] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, peerId)).limit(1);
  return !!row?.home;
}

/**
 * «Кто может мне писать» (`msgpriv1`) — крючок `index.ts` (`messagePrivacy.ts`; проверки маршрута держат закрытый перечень модулей):
 * `allowed` — пускает ли получатель отправителя (`messageAllowedFor`), `wrote` — писал ли автор собеседнику в их 1:1
 * (`wroteInDirect`), `remoteRefused` — дом собеседника с другого инстанса сказал «тебе писать нельзя» (`dmEphemeral`, `noMessages`).
 * Нет крючка — проверки нет (как до настройки).
 */
export interface MessagePrivacyGuard {
  allowed(senderId: string, recipientId: string): Promise<boolean>;
  wrote(authorId: string, otherId: string): Promise<boolean>;
  remoteRefused?(peerId: string, me: string): boolean;
}
let messagePrivacy: MessagePrivacyGuard | null = null;
export function configureMessagePrivacy(guard: MessagePrivacyGuard | null): void {
  messagePrivacy = guard;
}

/**
 * «Кто может мне писать» (13.10, #218, `msgpriv1`): беседа 1:1, собеседник ограничил круг (только контакты и те, кому писал сам),
 * а я не прохожу — 403 `MESSAGE_PRIVACY_ERROR` (ответ отправлен — `true`). Telegram: `PRIVACY_PREMIUM_REQUIRED`, tdesktop
 * `Data::RestrictionError` → `lng_restricted_send_non_premium`. Группа и «Избранное» — мимо (группы — отдельная настройка у
 * Telegram «кто может приглашать»). Политика инстанса (`dmPolicy`) — отдельно, это ограничение поверх.
 */
async function messagePrivacyRefused(
  reply: FastifyReply,
  me: string,
  access: { kind?: string; saved?: boolean; peerId: string | null } | null,
): Promise<boolean> {
  if (await botSendRefused(reply, me, access)) return true;
  const g = messagePrivacy;
  if (!g || !access || access.kind === 'group' || access.saved || !access.peerId) return false;
  const local = !(await g.allowed(me, access.peerId));
  // Человек соседа: решает его дом (`noMessages`), но если он сам мне уже писал — отвечать можно (Telegram «кому я писал первым»).
  const remote = !local && g.remoteRefused?.(access.peerId, me) === true && !(await g.wrote(access.peerId, me));
  if (!local && !remote) return false;
  await reply.code(403).send({ error: MESSAGE_PRIVACY_ERROR });
  return true;
}

/**
 * Собеседник 1:1 — бот, и писать ему нельзя (решение владельца 26.10, A): выключен (админом или все боты инстанса) или
 * приватный, а пишу не владелец → 403 `{ error, code: 'bot_unavailable', reason }` (ответ отправлен — `true`). Гейт на ОТПРАВКЕ,
 * а не только на открытии беседы: бот мог стать приватным/выключенным уже после неё. Зовётся из `messagePrivacyRefused` —
 * значит, его проходят все входы отправки: текст, файлы/альбомы и голосовые (`POST /conv/:id/messages`), пересылка В беседу
 * (`/forward`), отложенные (`/scheduled`, `/scheduled/:sid/send`). Вторая линия — `bots/botUpdates.ts` не пишет боту событий.
 */
async function botSendRefused(
  reply: FastifyReply,
  me: string,
  access: { kind?: string; saved?: boolean; peerId: string | null } | null,
): Promise<boolean> {
  if (!access || access.kind === 'group' || access.saved || !access.peerId) return false;
  const [botRow] = await db
    .select({ disabledAt: bots.disabledAt, public: bots.public, ownerId: bots.ownerId })
    .from(bots)
    .where(eq(bots.userId, access.peerId))
    .limit(1);
  if (!botRow) return false;
  const why = botUnavailableFor(botRow, (await botConv()?.enabled()) !== false, me);
  if (!why) return false;
  await reply.code(403).send({ error: BOT_UNAVAILABLE_ERRORS[why], code: BOT_UNAVAILABLE_CODE, reason: why });
  return true;
}

/** Файлы этому собеседнику нельзя: 400 `federation.dm_attachments_later` (ответ отправлен — `true`). Группа и местный — можно. */
export async function fedFilesRefused(reply: FastifyReply, peerId: string | null): Promise<boolean> {
  if (!(await isRemotePeer(peerId))) return false;
  if (fedFilesAllowed && (await fedFilesAllowed(peerId!))) return false;
  await reply.code(400).send({ error: FED_ERRORS.dmAttachmentsLater });
  return true;
}

/** Вложения с «один раз» (`voice3`). */
function onceRefs(list: readonly { once?: true | null }[]): boolean {
  return list.some((a) => a.once === true);
}

/**
 * «Один раз» человеку соседа (Э3 часть 3, #141): можно, если его инстанс объявил `dm2once` — понимает пометку `once` в копии,
 * стирает копию после прослушивания и отдаёт «прослушано». Проверку подключает `index.ts` при `FEDERATION_DM_ENABLED`
 * (`federation/convAtt.fedOnceAllowedFor`) — крючком, как `configureFedFilesGuard`. Не подключено или признака нет — прежний
 * отказ `federation.dm_attachments_later` (старый сосед показал бы такое голосовое обычным навсегда).
 */
/**
 * G56: убрать один элемент альбома «у обоих» в беседе с людьми соседа — только если их дома понимают меньший список вложений
 * (`dmalbum1`). Подключает `index.ts` при `FEDERATION_DM_ENABLED` (`federation/convAtt.fedAlbumAllowedFor`); не подключено —
 * можно (соседу правка всё равно не уезжает).
 */
let fedAlbumAllowed: ((memberIds: readonly string[]) => Promise<boolean>) | null = null;
export function configureFedAlbumGuard(guard: ((memberIds: readonly string[]) => Promise<boolean>) | null): void {
  fedAlbumAllowed = guard;
}

let fedOnceAllowed: ((peerId: string, media?: boolean) => Promise<boolean>) | null = null;
export function configureFedOnceGuard(guard: ((peerId: string, media?: boolean) => Promise<boolean>) | null): void {
  fedOnceAllowed = guard;
}

async function fedOnceRefused(peerId: string | null): Promise<boolean> {
  if (!(await isRemotePeer(peerId))) return false;
  return !(fedOnceAllowed && (await fedOnceAllowed(peerId!)));
}

/**
 * Одноразовое фото/видео человеку соседа (19.10, #226): можно, если его дом объявил `dm2ttl` — тот же крючок
 * `configureFedOnceGuard` со вторым аргументом (`federation/convAtt.fedOnceAllowedFor(peerId, true)`). Старый сосед (только
 * `dm2once`) показал бы фото обычным навсегда — отказ `federation.dm_attachments_later`.
 */
async function fedOnceMediaRefused(peerId: string | null, refs: readonly { id: string; once?: true | null; asFile?: true | null; gif?: true | null; round?: true | null }[]): Promise<boolean> {
  const ids = refs.filter((r) => r.once === true).map((r) => r.id);
  if (ids.length === 0 || !(await isRemotePeer(peerId))) return false;
  const rows = await db
    .select({ id: attachmentRows.id, contentType: attachmentRows.contentType })
    .from(attachmentRows)
    .where(inArray(attachmentRows.id, ids));
  const byId = new Map(refs.map((r) => [r.id, r]));
  const media = rows.some((r) => {
    const ref = byId.get(r.id);
    return isOnceMedia({ once: true, contentType: r.contentType, asFile: ref?.asFile ?? undefined, gif: ref?.gif ?? undefined, round: ref?.round ?? undefined });
  });
  return media && !(fedOnceAllowed && (await fedOnceAllowed(peerId!, true)));
}

/** Одноразовое фото/видео не туда (группа, «Избранное», альбом, отложенное) — 400 с понятной фразой (`ONCE_MEDIA_REFUSED`). */
const ONCE_REFUSED_BODY = {
  error: 'Одноразовые фото и видео — только отдельным сообщением в личной переписке, без отложенной отправки',
  reason: ONCE_MEDIA_REFUSED,
};

/**
 * Э2 часть Б (#141, Ф7): связка с инстансом собеседника разорвана, на паузе или доверие потеряно — беседа становится архивом
 * только для чтения (`ConvSummary.fedLink`). Проверку подключает `index.ts` при `FEDERATION_DM_ENABLED`
 * (`federation/convLink.fedLinkBrokenFor`) — тем же крючком, что `configureFedDirect`. Не подключено — запись как раньше.
 */
let fedLinkGuard: ((peerId: string) => Promise<boolean>) | null = null;
export function configureFedLinkGuard(guard: ((peerId: string) => Promise<boolean>) | null): void {
  fedLinkGuard = guard;
  // Аудит ЛС #236, п.10: отложенное при срабатывании проверяет связку тем же крючком.
  configureScheduledLinkGuard(guard);
}

/**
 * Запись в беседу с человеком соседа при разорванной связке: 403 `federation.dm_link_broken` (ответ отправлен — `true`).
 * Действия «только у меня» (удалить, закрепить у себя, черновик, прочитано, архив) сюда не ходят: они не уезжают соседу.
 */
async function fedLinkRefused(
  reply: FastifyReply,
  access: { peerId: string | null; kind: string; memberIds?: readonly string[] } | null,
  opts: { viaOk?: boolean } = {},
): Promise<boolean> {
  // Э5 часть 1: человек соседа по долгой сессии («через») пишет только текст/ответ — остальная запись ему закрыта.
  const me = access?.peerId ? access.memberIds?.find((id) => id !== access.peerId) : undefined;
  if (fedVia && me && !opts.viaOk && (await fedVia.isShadow(me))) {
    await reply.code(403).send({ error: FED_ERRORS.dmViaLimited });
    return true;
  }
  // Э7 часть 3: в группе собеседника нет — человек соседа определяется по тому, кто сейчас пишет (`reply.request.user`).
  const groupActor = !access?.peerId && access?.kind === 'group' ? (reply.request as { user?: { sub?: string } }).user?.sub : undefined;
  if (fedVia && groupActor && !opts.viaOk && (await fedVia.isShadow(groupActor))) {
    await reply.code(403).send({ error: FED_ERRORS.dmViaLimited });
    return true;
  }
  if (!fedLinkGuard || !access?.peerId || access.kind === 'group') return false;
  if (!(await fedLinkGuard(access.peerId))) return false;
  await reply.code(403).send({ error: FED_ERRORS.dmLinkBroken });
  return true;
}

/**
 * Э5 часть 1 (#141, «мой дом лежит — пишу через инстанс собеседника», `federation/convVia.ts`): подключает `index.ts` при
 * `FEDERATION_DM_ENABLED` — крючком, как `configureFedDirect`. Не подключено — маршрутов `/conv/:id/fallback` и
 * `/conv/via-claims` нет (404), отправка человеком соседа — как раньше.
 * - `gate` — отправка: `null` — наш человек; `'refused'` — 403 `federation.dm_via_limited`; иначе «через» с домом автора.
 * - `isShadow` — человек соседа (теневая строка): прочая запись в беседу ему закрыта.
 * - `fallback` / `claims` — дом автора: реквизиты долгой сессии и отчёт клиента об отправленном в обход.
 */
export interface FedViaHooks {
  gate(me: string, access: ConvAccess): Promise<null | 'refused' | { instanceId: string }>;
  isShadow(me: string): Promise<boolean>;
  /** `purpose` (Э6): `call` — сессия для ответа на звонок у инстанса звонящего (нужен его `dmcall1`, а не `dm4`). */
  fallback(me: string, conversationId: string, purpose?: 'via' | 'call'): Promise<{ status: number; body: Record<string, unknown> }>;
  claims(me: string, raw: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}
let fedVia: FedViaHooks | null = null;
export function configureFedVia(hooks: FedViaHooks | null): void {
  fedVia = hooks;
}

/**
 * Э2 часть Б (#141, §4 п. 2): жалоба из ЛС на человека другого инстанса уходит и держателю его дома событием `report.create`
 * (`federation/convLink.reportFedDmPeer`); подключает `index.ts`. Местная жалоба (`dmReports`) пишется как раньше.
 */
type FedDmReporter = (me: string, conversationId: string, peerId: string, input: { reason: string; comment: string | null }) => Promise<void>;
let fedDmReport: FedDmReporter | null = null;
export function configureFedDmReport(fn: FedDmReporter | null): void {
  fedDmReport = fn;
}

export async function convRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // `groups=1` (07.10, `groups1`) — клиент умеет группы; без него групп в ответе нет (старый клиент их не знает).
  const wantsGroups = (q: unknown): boolean => (q as { groups?: unknown } | null)?.groups === '1';

  // 08.10 (`groups3`): `?former=1` — ещё и бывшие группы (только на чтение) отдельным полем `former`.
  const wantsFormer = (q: unknown): boolean => (q as { former?: unknown } | null)?.former === '1';
  /*
   * Аудит ЛС #236, п.13: список бесед и страницы ленты — тяжёлые чтения (сводки, вложения глазами смотрящего), и цикл по ним
   * ничем не сдерживался. Свои лимиты, щедрые для человека (как `heavyReadBlock`, но отдельные ключи: открытие беседы с
   * догрузкой страниц не должно отнимать квоту у поиска и списков участников).
   */
  const CONV_LIST_MAX = 30;
  const CONV_HISTORY_MAX = 120;
  const CONV_READ_WINDOW_S = 10;
  app.get('/conv', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, await rateHit(`conv-list:${me}`, CONV_LIST_MAX, CONV_READ_WINDOW_S))) return;
    return listConversations(me, wantsGroups(req.query), wantsFormer(req.query));
  });

  app.get('/conv/sync', async (req) => {
    const q = z
      .object({
        pts: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        limit: z.coerce.number().int().min(1).max(SYNC_LIMIT_MAX).default(200),
        groups: z.string().max(4).optional(),
      })
      .parse(req.query);
    return syncSince(req.user!.sub, q.pts, q.limit, q.groups === '1');
  });

  /**
   * Открыть или создать беседу 1:1 — те же правила, что у старого `POST /dm`: политика инстанса (`dmPolicy`, 05.10;
   * `shared` — общий сервер), предел новых переписок без общего сервера (`DM_NEW_LIMIT`, 429), федерация выключена.
   * Новая беседа получателю не видна до первого сообщения (`createDirect`); беседу, которую завёл собеседник и которая мне
   * ещё не показана, моё «Написать» показывает мне (`revealDirect`).
   */
  app.post('/conv/direct', async (req, reply) => {
    const me = req.user!.sub;
    // Э1 (`fedm1`): вместо `userId` — человек связанного инстанса из поиска, у которого может не быть строки у нас.
    const body = z
      .object({
        userId: z.string().min(1).max(64).optional(),
        instanceId: z.string().min(1).max(64).optional(),
        homeUserId: z.string().min(1).max(64).optional(),
      })
      .refine((b) => !!b.userId || (!!b.instanceId && !!b.homeUserId))
      .parse(req.body);
    const sendFed = async (target: { instanceId: string; homeUserId: string }) => {
      const r = await fedDirect!(me, target);
      if (!r.ok) {
        if (r.retryAfter) reply.header('Retry-After', String(r.retryAfter));
        return reply.code(r.status).send(r.body);
      }
      const list = await listConversations(me);
      const summary = list.conversations.find((c) => c.id === r.conversationId);
      return reply.code(r.created ? 201 : 200).send(summary ?? { id: r.conversationId });
    };
    if (!body.userId) {
      if (!fedDirect) return reply.code(403).send({ error: FED_ERRORS.dmUnavailable });
      return sendFed({ instanceId: body.instanceId!, homeUserId: body.homeUserId! });
    }
    const userId = body.userId;
    if (userId === me) return reply.code(400).send({ error: 'cannot DM yourself' });
    const [other] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!other) return reply.code(404).send({ error: 'user not found' });
    // Строка-автор вебхука (#24) — не человек: беседа с ней ушла бы в пустоту. Настоящий бот (#229) — запись в `bots`.
    const [botRow] = other.bot ? await db.select().from(bots).where(eq(bots.userId, userId)).limit(1) : [];
    if (!botRow) {
      if (other.bot) return reply.code(403).send({ error: 'Это вебхук — ему нельзя написать' });
    } else {
      if (other.deletedAt) return reply.code(404).send({ error: 'user not found' });
      // Выключен — 403; новый бот приватный: открыть беседу может только владелец, пока тот не включит «Доступен всем».
      const why = botUnavailableFor(botRow, (await botConv()?.enabled()) !== false, me);
      if (why) return reply.code(403).send({ error: BOT_UNAVAILABLE_ERRORS[why], code: BOT_UNAVAILABLE_CODE, reason: why });
    }
    const [meRow] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, me)).limit(1);
    // Человек другого инстанса: с Э1 — через его дом (`fedDirect`), без флага — прежний отказ (§5.8).
    if (other.homeInstanceId !== null && other.homeUserId && !meRow?.home && fedDirect) {
      return sendFed({ instanceId: other.homeInstanceId, homeUserId: other.homeUserId });
    }
    if (other.homeInstanceId !== null || meRow?.home) return reply.code(403).send({ error: FED_ERRORS.dmUnavailable });

    let created = null as Awaited<ReturnType<typeof createDirect>>;
    const opened = await openDm<{ id: string }>(
      {
        findExisting: (a, b) => findDirect(a, b),
        // Бот (#229): общий сервер и политика ЛС инстанса — правила о людях; к боту пускает его `public`/владелец (выше).
        shareServer: (one, two) => (botRow ? Promise.resolve(true) : shareServer(one, two)),
        initiatorIsSuperAdmin: () => isSuperAdmin(asUserId(me)),
        create: async () => {
          created = await createDirect(me, userId);
          return created?.row ?? null;
        },
        policy: () => dmPolicy(),
        peerReachable: () => reachableUser(other),
        spendNewDm: () => rateHit(`dm-new:${me}`, DM_NEW_LIMIT.max, DM_NEW_LIMIT.windowS),
      },
      me,
      userId,
    );
    if (!opened.ok) {
      const no = dmOpenRefusal(opened);
      if (no.retryAfter) reply.header('Retry-After', String(no.retryAfter));
      return reply.code(no.status).send(no.body);
    }
    const revealed = created ? null : await revealDirect(me, opened.row.id);
    if (created) void deliver(created.delivery).catch(() => {});
    if (revealed) void deliver(revealed).catch(() => {});
    // Бот (#229): человек открыл с ним беседу — событие `my_chat_member` (`member`): и новую, и убранную раньше
    // («Удалить чат» → «Написать» снова: `revealDirect` вернул её — для бота это новый вход, как в Telegram).
    if (botRow && (created || revealed)) queueBotChatMember(userId, me, opened.row.id, 'member');
    const list = await listConversations(me);
    const summary = list.conversations.find((c) => c.id === opened.row.id);
    return reply.code(created ? 201 : 200).send(summary ?? { id: opened.row.id });
  });

  /**
   * «Избранное» (08.10, #211, С6, G72, признак `saved1`): найти беседу с самим собой или завести — идемпотентно, ответ 200
   * со сводкой (`saved: true`). Заводит её человек сам (Ctrl+0, «Переслать» → «Избранное»), не сервер при регистрации.
   * Беседа локальная: гостю (человеку чужого инстанса) её нет — у него «дом» на другом инстансе.
   */
  /**
   * Э5 часть 1 (#141): реквизиты долгой сессии на инстансе собеседника — клиент берёт их заранее (при открытии беседы с
   * человеком соседа) и пишет по ним, когда дом лежит. Только владельцу беседы; `{ instanceId, apiBase, userId, token,
   * expiresAt }` (мс эпохи). Нет `dm4` у соседа — 409 `federation.unsupported`; сосед не ответил — 503.
   */
  app.get('/conv/:id/fallback', async (req, reply) => {
    if (!fedVia) return reply.code(404).send({ error: 'not found' });
    const { id } = convParams.parse(req.params);
    if (await limited(reply, await rateHit(`conv-fallback:${req.user!.sub}`, 30, 600))) return;
    const res = await fedVia.fallback(req.user!.sub, id, (req.query as { for?: unknown } | undefined)?.for === 'call' ? 'call' : 'via');
    return reply.code(res.status).send(res.body);
  });

  /**
   * Э5 часть 1 (#141): клиент вернулся домой — отчитывается, что отправил в обход (`{ items: [{ conversationId, clientId,
   * payloadHash }] }`, отпечаток — `convRules.payloadHash` по ОБРЕЗАННОМУ тексту и ответу). Дом сверяет с копиями соседа.
   */
  app.post('/conv/via-claims', async (req, reply) => {
    if (!fedVia) return reply.code(404).send({ error: 'not found' });
    if (await limited(reply, await rateHit(`conv-via-claims:${req.user!.sub}`, 30, 600))) return;
    const res = await fedVia.claims(req.user!.sub, req.body);
    return reply.code(res.status).send(res.body);
  });

  app.post('/conv/saved', { preHandler: requireLocalUser }, async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, await rateHit(`conv-saved:${me}`, 20, 10))) return;
    const made = await ensureSaved(me);
    if (!made.id) return reply.code(500).send({ error: 'saved_unavailable' });
    if (made.delivery) void deliver(made.delivery).catch(() => {});
    const list = await listConversations(me, true);
    const summary = list.conversations.find((c) => c.id === made.id);
    return reply.code(made.delivery ? 201 : 200).send(summary ?? { id: made.id });
  });

  app.get('/conv/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z
      .object({
        before: z.string().max(100).optional(),
        after: z.string().max(100).optional(),
        around: z.string().min(1).max(64).optional(),
        // «Перейти к дате» (G25, `search1`): ISO-момент начала дня по часам клиента.
        date: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(HISTORY_LIMIT_MAX).default(50),
        // 08.10 (`groups3`): `former=1` — клиент умеет бывшую группу (лента до выхода); без него бывшему — 404, как раньше.
        former: z.literal('1').optional(),
      })
      .parse(req.query);
    if ([q.before, q.after, q.around, q.date].filter(Boolean).length > 1)
      return reply.code(400).send({ error: 'only one of before/after/around/date' });
    if (await limited(reply, await rateHit(`conv-history:${me}`, CONV_HISTORY_MAX, CONV_READ_WINDOW_S))) return;
    const before = q.before ? decodeCursor(q.before) : undefined;
    const after = q.after ? decodeCursor(q.after) : undefined;
    if (before === null || after === null) return reply.code(400).send({ error: 'bad cursor' });
    const date = q.date ? new Date(q.date) : undefined;
    const page = await history(me, conversationId, { before, after, around: q.around, date, limit: q.limit, former: q.former === '1' });
    if (page === null || page === 'no-anchor') return reply.code(404).send({ error: 'not found' });
    return page;
  });

  /* Поиск по беседе (G05, признак `search1`): подстрока в тексте, новые первыми; `before` — курсор следующей порции.
     Только видимое мне — `searchConversation`. Лимит запросов — как у «прочитано»: стрелки и набор шлют часто. */
  app.get('/conv/:id/search', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z
      .object({
        q: z.string().max(SEARCH_QUERY_MAX),
        before: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(30),
      })
      .parse(req.query);
    const pattern = searchPattern(q.q);
    if (!pattern) return reply.code(400).send({ error: 'empty query' });
    if (await limited(reply, await rateHit(`conv-search:${me}`, READ_MAX, WINDOW_S))) return;
    const before = q.before ? decodeCursor(q.before) : undefined;
    if (before === null) return reply.code(400).send({ error: 'bad cursor' });
    const res = await searchConversation(me, conversationId, pattern, before, q.limit);
    if (!res) return reply.code(404).send({ error: 'not found' });
    return res;
  });

  /* Общие медиа (G29, признак `media1`): вложения вида `kind` (или ссылки), новые первыми, порцией; `before` — курсор.
     Только видимое мне (как лента); бывшему участнику группы — с `former=1`, до выхода. Лимит запросов — как у поиска. */
  app.get('/conv/:id/media', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z
      .object({
        kind: z.enum(['media', 'file', 'link', 'gif', 'voice']),
        before: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(SHARED_MEDIA_PAGE).default(SHARED_MEDIA_PAGE),
        former: z.literal('1').optional(),
      })
      .parse(req.query);
    if (await limited(reply, await rateHit(`conv-search:${me}`, READ_MAX, WINDOW_S))) return;
    const before = q.before ? decodeCursor(q.before) : undefined;
    if (before === null) return reply.code(400).send({ error: 'bad cursor' });
    const res = await sharedMedia(me, conversationId, q.kind, before, q.limit, q.former === '1');
    if (!res) return reply.code(404).send({ error: 'not found' });
    return res;
  });

  app.get('/conv/:id/media/counts', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z.object({ former: z.literal('1').optional() }).parse(req.query);
    if (await limited(reply, await rateHit(`conv-search:${me}`, READ_MAX, WINDOW_S))) return;
    const res = await sharedMediaCounts(me, conversationId, q.former === '1');
    if (!res) return reply.code(404).send({ error: 'not found' });
    return res;
  });

  /* Поиск из списка бесед (G35, признак `gsearch1`): по тексту во всех моих беседах; необязательно — одна беседа
     (`conversationId`, чип «человек») период (`since` / `until`, чип «дата») и вид (`kind`, чип «тип»). Без текста нужен хотя бы один чип.
     Только видимое мне — `searchAllConversations`. Лимит запросов — как у поиска по беседе. */
  app.get('/conv/search', async (req, reply) => {
    const me = req.user!.sub;
    const q = z
      .object({
        q: z.string().max(SEARCH_QUERY_MAX).default(''),
        conversationId: z.string().max(100).optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        kind: z.enum(['media', 'file', 'link', 'gif', 'voice']).optional(),
        before: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(30),
        // Вкладки поиска на телефоне (12.10): имена вложений в поиск и целые сообщения в ответ — `searchAllConversations`.
        names: z.enum(['1']).optional(),
        full: z.enum(['1']).optional(),
      })
      .parse(req.query);
    const pattern = searchPattern(q.q);
    if (!pattern && !q.conversationId && !q.since && !q.kind) return reply.code(400).send({ error: 'empty query' });
    if (await limited(reply, await rateHit(`conv-search:${me}`, READ_MAX, WINDOW_S))) return;
    const before = q.before ? decodeCursor(q.before) : undefined;
    if (before === null) return reply.code(400).send({ error: 'bad cursor' });
    return searchAllConversations(me, { pattern, conversationId: q.conversationId, since: q.since, until: q.until, kind: q.kind, before, limit: q.limit, names: q.names === '1', full: q.full === '1' });
  });

  /* «Частые» в поиске из списка (G35, признак `freq1`; Telegram top peers): мои беседы по числу моих сообщений за 90 дней с
     затуханием. Без записи: считается из сообщений. Лимит — СВОЙ, не общий с поиском: набор запроса в поиске выбирал общий
     предел, 429 откатывал полосу «Частые» к «Людям» по свежести. */
  app.get('/conv/frequent', async (req, reply) => {
    const me = req.user!.sub;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(30).default(20) }).parse(req.query);
    if (await limited(reply, await rateHit(`conv-frequent:${me}`, FREQUENT_MAX, FREQUENT_WINDOW_S))) return;
    return frequentConversations(me, q.limit);
  });

  /* «Убрать из частых» на сервере (09.10, признак `freq2`; Telegram `contacts.resetTopPeerRating`): `ConvFrequentHideRequest` →
     `ConvFrequentHideResponse`. Отметка в МОЕЙ строке участника; другие устройства увидят при следующем открытии поиска
     (`GET /conv/frequent` убранные не отдаёт). Событий нет. Лимит — свой: перенос убранных на устройстве шлёт пачку разом. */
  app.post('/conv/frequent/hide', async (req, reply) => {
    const me = req.user!.sub;
    const body = z
      .object({
        items: z
          .array(z.object({ conversationId: z.string().min(1).max(64), at: z.string().datetime({ offset: true }).optional() }))
          .min(1)
          .max(FREQUENT_HIDE_MAX),
      })
      .parse(req.body);
    if (await limited(reply, await rateHit(`conv-frequent-hide:${me}`, FREQUENT_MAX, FREQUENT_WINDOW_S))) return;
    const hidden = await hideFrequentConversations(
      me,
      body.items.map((it) => ({ conversationId: it.conversationId, at: it.at ? new Date(it.at) : undefined })),
    );
    return { hidden };
  });

  /**
   * Непрочитанные реакции на мои сообщения (G24, признак `reactunread1`; Telegram «♥» над «вниз»): список — самые старые
   * первыми (клик по «♥» идёт к первому), отметка «увидено» — по показанным на экране сообщениям (`messageIds` ≤ 100) или
   * сразу всех (`messageIds` нет — «Прочитать все»). Событие `conv.change` со сводкой — только моим устройствам.
   */
  app.get('/conv/:id/unread-reactions', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50) }).parse(req.query);
    if (await limited(reply, await rateHit(`conv-search:${me}`, READ_MAX, WINDOW_S))) return;
    const res = await unreadReactionMessages(me, conversationId, q.limit);
    if (!res) return reply.code(404).send({ error: 'not found' });
    return res;
  });

  // Непрочитанные упоминания меня в группе (`groups2`, G24): самые старые первыми — клик по «@» идёт к первому.
  app.get('/conv/:id/unread-mentions', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50) }).parse(req.query);
    if (await limited(reply, await rateHit(`conv-search:${me}`, READ_MAX, WINDOW_S))) return;
    const res = await unreadMentionMessages(me, conversationId, q.limit);
    if (!res) return reply.code(404).send({ error: 'not found' });
    return res;
  });

  app.post('/conv/:id/reactions-read', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ messageIds: z.array(z.string().max(100)).min(1).max(100).optional() }).parse(req.body ?? {});
    if (await limited(reply, await rateHit(`conv-reactions-read:${me}`, READ_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await markReactionsRead(me, access, body.messageIds ?? null);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return { read: res.read };
  });

  // Загрузка вложения в закрытое хранилище (шаг 1в): ответ — `id` для отправки и ссылка для самого загрузившего.
  app.post('/conv/:id/attachments', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (await fedLinkRefused(reply, access)) return;
    if (await fedFilesRefused(reply, access.peerId)) return;
    return acceptDmUpload(req, reply, conversationId, me);
  });

  /**
   * Отправка. `clientId` обязателен: повтор с тем же содержимым → 200 и то же сообщение, с другим → 409
   * `client_id_conflict` (`convRules.idempotencyDecision`). Новое → 201.
   * `silent: true` (С3, признак `conv8`) — «Отправить без звука»: у получателя счётчик и уведомление как обычно, нет только
   * звука; пуш уходит с `silent: true` в нагрузке. В отпечаток повтора не входит (`convRules.payloadHash` — почему).
   */
  app.post('/conv/:id/messages', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z
      .object({
        clientId: z.guid(),
        content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).optional().default(''),
        // Шаг 1в: вложения — id загрузок (`POST /conv/:id/attachments`) + подсказки клиента, не ссылки.
        attachments: convAttachmentRefsSchema,
        replyToId: z.string().min(1).max(64).nullish(),
        // Цитата фрагмента (`quote1`, G55): кусок текста цитируемого — сервер проверит, что это его подстрока (иначе 400).
        replyQuote: z
          .object({ text: z.string().min(1).max(REPLY_QUOTE_MAX), offset: z.number().int().min(0).max(MESSAGE_TEXT_MAX).optional() })
          .nullish(),
        silent: z.boolean().optional(),
        // «Без превью ссылки» (G19, `linkprev1`): получатель карточку под сообщением не рисует.
        noPreview: z.boolean().optional(),
        // «Подпись над медиа» (G48, `media2`): подпись над фото/альбомом; ложится только при подписи и вложении.
        captionAbove: z.boolean().optional(),
        // Стикер каталога (С2, `stickers2`): сообщение-стикер — без текста и вложений, как у Telegram.
        stickerId: z.string().min(1).max(64).nullish(),
        // Геопозиция / контакт (G69, `geocontact1`): отдельное сообщение без текста, вложений и стикера, как у Telegram.
        media: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('geo'), lat: z.number().finite(), lon: z.number().finite(), accuracy: z.number().finite().nullish() }),
            z.object({ kind: z.literal('contact'), userId: z.string().min(1).max(64) }),
            // Трансляция геопозиции (`geolive1`): срок и диапазоны проверяет `geoLiveStart` (общий с клиентом).
            z.object({
              kind: z.literal('geolive'),
              lat: z.number().finite(),
              lon: z.number().finite(),
              accuracy: z.number().finite().nullish(),
              heading: z.number().finite().nullish(),
              period: z.number().int(),
            }),
            // Опрос (`convpoll1`): форма — здесь (потолки длины), смысл — `convPollDraft` (общий с формой клиента).
            z.object({
              kind: z.literal('poll'),
              question: z.string().max(CONV_POLL_LIMITS.question * 2),
              options: z.array(z.string().max(CONV_POLL_LIMITS.option * 2)).max(CONV_POLL_LIMITS.maxOptions * 2),
              anonymous: z.boolean().optional(),
              multi: z.boolean().optional(),
              quiz: z.boolean().optional(),
              correct: z.number().int().min(0).max(CONV_POLL_LIMITS.maxOptions * 2).nullish(),
              solution: z.string().max(CONV_POLL_LIMITS.solution * 2).nullish(),
            }),
          ])
          .nullish(),
      })
      .parse(req.body);
    const silent = body.silent === true;
    let content = body.content.trim();
    if (body.media && (content || body.attachments.length > 0 || body.stickerId))
      return reply.code(400).send({ error: 'геопозиция и контакт отправляются отдельным сообщением' });
    // Вид сообщения собираем ДО проверок пустоты: `content` у него — запасная фраза (её видят старый клиент и старый сосед).
    const media = body.media ? await resolveConvMedia(body.media) : null;
    if (media === 'bad-geo') return reply.code(400).send({ error: 'координаты вне диапазона' });
    if (media === 'no-contact') return reply.code(400).send({ error: 'контакт не найден' });
    if (media && typeof media === 'object' && 'pollError' in media) return reply.code(400).send({ error: media.pollError });
    if (media) content = convMediaFallback(media);
    if (!content && body.attachments.length === 0 && !body.stickerId) return reply.code(400).send({ error: 'empty message' });
    if (body.stickerId && (content || body.attachments.length > 0))
      return reply.code(400).send({ error: 'стикер отправляется отдельным сообщением' });
    if (await limited(reply, await messageSendBlock(me))) return;
    const sticker = body.stickerId ? await catalogSticker(body.stickerId) : null;
    if (body.stickerId && !sticker) return reply.code(400).send({ error: 'стикер не найден' });

    const access = await loadAccess(conversationId, me);
    const isGroup = access?.kind === 'group';
    const [peer] = access?.peerId
      ? await db.select({ deletedAt: users.deletedAt, displayName: users.displayName }).from(users).where(eq(users.id, access.peerId)).limit(1)
      : [];
    // Группа (`groups1`): писать может любой действующий участник; собеседника, его блока и «удалён ли он» у группы нет.
    const write = isGroup || access?.saved ? (access ? 'ok' : 'not-a-member') : canWriteDm({ member: !!access, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write === 'not-a-member' || !access) return reply.code(404).send({ error: 'not found' });
    if (write === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });
    if (await messagePrivacyRefused(reply, me, access)) return;
    // Э5 часть 1: человек соседа по долгой сессии — «через», только текст и ответ (без цитаты фрагмента).
    const via = fedVia ? await fedVia.gate(me, access) : null;
    if (via === 'refused' || (via && (body.attachments.length > 0 || body.stickerId || body.replyQuote || media))) {
      return reply.code(403).send({ error: FED_ERRORS.dmViaLimited });
    }
    if (await fedLinkRefused(reply, access, { viaOk: !!via })) return;
    // Опрос с людьми других инстансов — только если все их дома объявили `dmpoll1` (`convPollFederates`): иначе их копия была бы текстом.
    if (media?.kind === 'poll' && (await convHasRemote(db, conversationId)) && !(await convPollFederates(db, conversationId))) return reply.code(403).send({ error: 'опрос в беседе с людьми других инстансов пока недоступен', reason: CONV_POLL_FEDERATED_ERROR });
    // Трансляция геопозиции — так же: провода соседям нет, точки им не дойдут (сосед видит только запасной текст первой точки).
    if (media?.kind === 'geolive' && (await convHasRemote(db, conversationId)))
      return reply.code(403).send({ error: 'трансляция геопозиции в беседе с людьми других инстансов пока недоступна', reason: CONV_GEOLIVE_FEDERATED_ERROR });
    if (body.attachments.length > 0 && (await fedFilesRefused(reply, access.peerId))) return;
    if (onceRefs(body.attachments) && (await fedOnceRefused(access.peerId))) return reply.code(400).send({ error: FED_ERRORS.dmAttachmentsLater });
    if (await fedOnceMediaRefused(access.peerId, body.attachments)) return reply.code(400).send({ error: FED_ERRORS.dmAttachmentsLater });

    // «Избранное»: получателя нет — придерживать и пушить некому (`saved1`).
    const plan = access.saved
      ? { withheld: false, notifyRecipient: false }
      : isGroup
        ? { withheld: false, notifyRecipient: true }
        : dmDeliveryPlan(await isBlockedBy(access.peerId!, me));
    const res = await sendMessage(me, access, {
      clientId: body.clientId,
      content,
      attachments: body.attachments,
      replyToId: body.replyToId ?? null,
      ...(body.replyQuote ? { replyQuote: body.replyQuote } : {}),
      withheld: plan.withheld,
      silent,
      noPreview: body.noPreview === true,
      captionAbove: body.captionAbove === true,
      ...(sticker ? { sticker } : {}),
      // Ссылка на карту в запасной фразе — не повод для карточки превью (сервер сходил бы на сторонний сайт).
      ...(media ? { media, noPreview: true } : {}),
      ...(via ? { via: { instanceId: via.instanceId, state: 'pending' as const } } : {}),
    });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'bad-reply') return reply.code(400).send({ error: 'invalid reply target' });
    if (res.kind === 'bad-quote') return reply.code(400).send({ error: 'цитата не найдена в сообщении' });
    if (res.kind === 'bad-attachments') return reply.code(400).send({ error: 'вложение уже отправлено или не найдено' });
    if (res.kind === 'once-refused') return reply.code(400).send(ONCE_REFUSED_BODY);
    if (res.kind === 'conflict') return reply.code(409).send({ error: 'client_id_conflict' });
    const view: ConvMessage | ConvGone | null = await messageFor(res.row.id, me);
    if (res.kind === 'replay') return reply.code(200).send(view);

    // Старые события, `conv.change` и пуш — общим путём с отложенными (С4, `convSendFanout.ts`): тот же пуш, что у старых
    // ЛС (один на получателя от отправителя за окно, заглушка «ЛС этого человека» чтится); «без звука» (С3) — пуш всё равно
    // уходит, но с `silent: true` и в своём окне (`pushRules.pushThrottleSource`).
    await fanOutSend({
      me,
      peerId: access.peerId,
      ...(isGroup ? { groupMemberIds: access.memberIds } : {}),
      ...(access.saved ? { saved: true } : {}),
      conversationId,
      row: res.row,
      delivery: res.delivery,
      notifyRecipient: plan.notifyRecipient,
      content,
      // Вложения строки, а не число: пуш назовёт их словами (05.10, `pushRules.contentPreview`).
      attachments: res.row.attachments,
      silent,
      sticker: res.row.sticker,
      // Пуш (G69): «Геопозиция» / «Контакт: Имя» вместо запасной фразы со ссылкой.
      ...(media ? { content: convMediaPreview(media) } : {}),
    });
    // Отправил — значит, прочитал всё до своего сообщения (как Telegram: tdesktop `ApiWrap::sendAction` → `readInbox`; решение
    // владельца 15.10): мои непрочитанные в беседе гаснут, собеседник получает ✓✓ на свои сообщения до этого. Тот же путь, что
    // у `/conv/:id/read` (журнал, ✓✓ соседу через `fedRecord`, тихий пуш моим телефонам). Придержанное (меня заблокировали) — без отметки.
    if (!access.saved && !plan.withheld) {
      const read = await markRead(me, access, res.row.sortKey);
      if (read.kind === 'ok' && read.delivery) {
        await deliver(read.delivery);
        void sendReadSyncPush(me, conversationId, read.lastReadKey).catch(() => {});
      }
    }
    return reply.code(201).send(view);
  });

  app.patch('/conv/:id/messages/:mid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { content: raw } = z.object({ content: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (await fedLinkRefused(reply, access)) return;
    const res = await editMessage(me, access, mid, raw.trim());
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    if (res.kind === 'empty') return reply.code(400).send({ error: 'empty message' });
    // Правка без изменений (`delivery` пуст) — событий нет: сообщение не менялось.
    await deliver(res.delivery);
    return reply.send(await messageFor(mid, me));
  });

  /**
   * Удалить одно. `both` — своё, а в беседе 1:1 и чужое видимое (С1, признак `conv6`, как в Telegram; следы и события
   * те же, что у своего); `me` — любое видимое, только у себя.
   */
  app.delete('/conv/:id/messages/:mid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    // Новая ручка требует явного выбора: «у меня» и «у обоих» — разные действия, умолчание было бы угадыванием.
    const { for: scope } = z.object({ for: z.enum(['me', 'both']) }).parse(req.query ?? {});
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (scope === 'both' && (await fedLinkRefused(reply, access))) return;
    const res = await deleteMessage(me, access, mid, scope, { othersForBoth: true });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    // Повтор уже сделанного удаления (`delivery` пуст) — событий второй раз нет.
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  /**
   * Удалить ОДИН элемент альбома (G56, признак `album1`; Telegram — элемент альбома отдельное сообщение): `both` — только своё
   * (элемент уходит из списка вложений у всех, файл — в уборку), `me` — спрятать у себя; последний видимый элемент — удаление
   * сообщения целиком (`removed: 'message'`). Повтор — 200 без событий. «У обоих» с человеком соседа, чей дом без `dmalbum1`, —
   * 409 `album_item_peer_old`.
   */
  app.delete('/conv/:id/messages/:mid/attachments/:aid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { aid } = z.object({ aid: z.string().min(1).max(64) }).parse(req.params);
    const { for: scope } = z.object({ for: z.enum(['me', 'both']) }).parse(req.query ?? {});
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (scope === 'both' && (await fedLinkRefused(reply, access))) return;
    if (scope === 'both' && fedAlbumAllowed && !(await fedAlbumAllowed(access.memberIds.filter((id) => id !== me)))) {
      return reply.code(409).send({ error: ALBUM_ITEM_PEER_OLD_ERROR });
    }
    const res = await deleteAlbumItem(me, access, mid, aid, scope, { othersForBoth: true });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
    await deliver(res.delivery);
    const body: ConvAlbumItemDeleteResponse = { removed: res.removed };
    return reply.send(body);
  });

  /**
   * Удаление пачкой (04.10, признак `conv5`): права те же, что у удаления по одному (`both` — своё, а в беседе 1:1 и
   * чужое видимое — С1, `conv6`; `me` — любое видимое), пачка целиком или ничего — не этой беседы → 404 с `missing`,
   * чужое видимое «у обоих» там, где нельзя (группа), → 403 с `ids`, и тогда не меняется ничего. Уже исчезнувшее для меня
   * пропускается молча (собеседник мог удалить, пока я выделял). Одна операция лимита правок/удалений на пачку; события и
   * старые `dm.delete` — на каждое изменённое, как у одиночного.
   */
  app.post('/conv/:id/messages/delete', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ ids: batchIds, for: z.enum(['me', 'both']) }).parse(req.body);
    if (new Set(body.ids).size !== body.ids.length) return reply.code(400).send({ error: 'duplicate message ids' });
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (body.for === 'both' && (await fedLinkRefused(reply, access))) return;
    const res = await deleteMessages(me, access, body.ids, body.for, { othersForBoth: true });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found', missing: res.missing });
    if (res.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden', ids: res.ids });
    await deliverMany(res.deliveries);
    return reply.code(204).send();
  });

  /**
   * Пересылка ЛС → ЛС (04.10, признак `conv5`): сообщения беседы `fromConversationId` — в эту, в порядке оригиналов, с
   * «переслано от» (`conversations.forwardMessages`). Пересылающий — участник обеих (иначе 404, как везде); из источника —
   * только видимое ему и не удалённое (иначе 400 с `missing`). Блокировка — как у отправки: получатель заблокировал меня →
   * пачка придержана, ни событий ему, ни пуша. Лимит — ОДНА операция общего бюджета отправки на пачку + свой предел
   * пересылок; пуш — один на пачку. `clientId` — id отправки пачки: повтор → 200 и те же сообщения, другая пачка с ним → 409.
   * `silent: true` (С3, `conv8`) — переслать «без звука»: флаг у каждого сообщения пачки, пуш пачки — с `silent: true`.
   * `hideSender` / `hideCaptions` (G71, `fwd2`) — «скрыть имя отправителя» (копия без «переслано от») и «скрыть подписи».
   */
  app.post('/conv/:id/forward', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z
      .object({
        clientId: z.guid(),
        fromConversationId: z.string().min(1).max(64),
        messageIds: batchIds,
        silent: z.boolean().optional(),
        hideSender: z.boolean().optional(),
        hideCaptions: z.boolean().optional(),
        // G56 (`album1`): один элемент альбома — только с одним сообщением.
        attachmentId: z.string().min(1).max(64).optional(),
      })
      .parse(req.body);
    const silent = body.silent === true;
    if (body.attachmentId !== undefined && body.messageIds.length !== 1) return reply.code(400).send({ error: 'attachmentId needs one message' });
    if (new Set(body.messageIds).size !== body.messageIds.length) return reply.code(400).send({ error: 'duplicate message ids' });
    if (await limited(reply, await messageSendBlock(me))) return;
    if (await limited(reply, await rateHit(`conv-forward:${me}`, FORWARD_MAX, FORWARD_WINDOW_S))) return;

    const access = await loadAccess(conversationId, me);
    // Бывший участник группы (аудит ЛС #236, п.9) пересылает из ленты до выхода (`forwardSources` режет по времени выхода).
    const source = (await loadAccess(body.fromConversationId, me)) ?? (await formerLeftAt(body.fromConversationId, me));
    const [peer] = access?.peerId
      ? await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, access.peerId)).limit(1)
      : [];
    // Группа (`groups2`, 07.10): собеседника нет — пересылать и откладывать может любой действующий участник.
    const write = access?.kind === 'group' || access?.saved ? 'ok' : canWriteDm({ member: !!access, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write === 'not-a-member' || !access || !source) return reply.code(404).send({ error: 'not found' });
    if (write === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });
    if (await messagePrivacyRefused(reply, me, access)) return;
    if (await fedLinkRefused(reply, access)) return;

    if (await isRemotePeer(access.peerId)) {
      const withFiles = await db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            inArray(conversationMessages.id, body.messageIds),
            sql`jsonb_array_length(${conversationMessages.attachments}) > 0`,
          ),
        )
        .limit(1);
      if (withFiles.length > 0 && (await fedFilesRefused(reply, access.peerId))) return;
    }
    const isGroup = access.kind === 'group';
    // «Избранное» (`saved1`): собеседника нет — не придерживается, ни пуша, ни старых событий.
    const plan = isGroup
      ? { withheld: false, notifyRecipient: true }
      : access.saved
        ? { withheld: false, notifyRecipient: false }
        : dmDeliveryPlan(await isBlockedBy(access.peerId!, me));
    const res = await forwardMessages(me, access, {
      clientId: body.clientId,
      fromConversationId: body.fromConversationId,
      messageIds: body.messageIds,
      withheld: plan.withheld,
      silent,
      hideSender: body.hideSender === true,
      hideCaptions: body.hideCaptions === true,
      ...(body.attachmentId !== undefined ? { attachmentId: body.attachmentId } : {}),
    });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'source-missing') return reply.code(400).send({ error: 'forward source not found', missing: res.missing });
    if (res.kind === 'too-large') {
      return reply
        .code(400)
        .send({ error: 'forward too large', maxAttachments: FORWARD_ATTACHMENTS_MAX, maxBytes: FORWARD_BYTES_MAX });
    }
    if (res.kind === 'storage') {
      return reply.code(503).send({ error: 'Файлы в личных сообщениях сейчас недоступны: закрытое хранилище не готово' });
    }
    if (res.kind === 'conflict') return reply.code(409).send({ error: 'client_id_conflict' });
    const rows = res.rows;
    const views = await messagesFor(rows.map((r) => r.id), me);
    const messages = rows.map((r) => views.get(r.id)).filter((v): v is ConvMessage | ConvGone => !!v);
    if (res.kind === 'replay') return reply.code(200).send({ messages });

    if (isGroup) {
      // Группа: пуш участникам — как у отправки в группу (один на пачку, заглушка группы чтится).
      await deliverMany(res.deliveries);
      const first = rows[0];
      pushGroupPack(me, conversationId, access.memberIds, forwardPreview(rows.length, { content: first.content, attachments: first.attachments }), silent);
      return reply.code(201).send({ messages });
    }
    await deliverMany(res.deliveries);
    if (plan.notifyRecipient) {
      const peerId = access.peerId!;
      const first = rows[0];
      const [author] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, me)).limit(1);
      const pushBody = forwardPreview(rows.length, { content: first.content, attachments: first.attachments });
      // Один пуш на ПАЧКУ — и то же окно «один от этого человека за 20 с», что у отправки; заглушка ЛС человека чтится.
      // «Без звука» — как у отправки: `silent: true` в нагрузке и своё окно.
      void (async () => {
        if (await pushDebounced(peerId, pushThrottleSource(me, silent))) return;
        // Подпись автора в контактах получателя (решение владельца 08.10 п.27, `contacts.contactNamesFor`).
        const title = pushNameFor(await contactNamesFor(me, [peerId]), peerId, author?.displayName ?? '');
        await sendPushToUsers(
          [peerId],
          withSilent({ type: 'dm', title, body: pushBody, dmId: conversationId }, silent),
          { scope: 'dm_user', targetId: me },
          { private: true },
        );
      })().catch(() => {});
    }
    return reply.code(201).send({ messages });
  });

  app.post('/conv/:id/messages/:mid/reactions', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    // `big` (08.10, `bigreact1`) — необязательное добавление: «большая» реакция удержанием; старый клиент его не шлёт.
    const { emoji, op, big } = z
      .object({ emoji: z.string().min(1).max(32), op: z.enum(['add', 'remove']), big: z.boolean().optional() })
      .parse(req.body);
    if (await limited(reply, await rateHit(`conv-react:${me}`, REACT_MAX, WINDOW_S))) return;
    // Аудит ЛС #236, п.4: реакция — только эмодзи; кастомный — существующий эмодзи сервера. Снимать можно любую уже стоящую.
    if (op === 'add' && !(await reactionAllowed(emoji))) return reply.code(400).send({ error: 'invalid reaction' });
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (await fedLinkRefused(reply, access)) return;
    // Кто из участников заблокировал меня — тем моя реакция не доходит ни событием, ни журналом (`blockRules.reachesPeer`).
    const blockedActor = new Set<string>();
    for (const uid of access.memberIds) if (uid !== me && (await blockedBy(uid)).has(me)) blockedActor.add(uid);
    const res = await reactMessage(me, access, mid, emoji, op, blockedActor);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    // Признак реакции (#231) — для `message_reaction` боту беседы; людям событие то же.
    await deliver(res.delivery ? { ...res.delivery, reaction: { userId: me, emoji, op } } : null);
    // «Большая» реакция — только эффект: соединениям с `bigreact1`, старые получают обычную реакцию выше.
    for (const uid of bigReactionTargets({ big: big === true, op, actorId: me, audience: res.audience })) {
      await publishToUser(uid, { t: 'reaction.big', conversationId, messageId: mid, emoji, userId: me }, { cap: FEATURE_BIGREACT1 }).catch(() => {});
    }
    return reply.code(204).send();
  });

  /**
   * Опрос в ЛС (14.10, `convpoll1`): голос (`optionIds`) или отмена голоса (пустой список) — ответ: сообщение моими глазами
   * (клиент кладёт его сразу, не дожидаясь `conv.change`); остальным участникам — `conv.change` с их видом опроса.
   */
  const pollReply = async (reply: FastifyReply, res: ConvPollActResult, mid: string, me: string) => {
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'refused') return reply.code(res.code).send({ error: res.error });
    await deliver(res.delivery);
    const view = await messageFor(mid, me);
    return view ? reply.send(view) : reply.code(404).send({ error: 'not found' });
  };
  app.post('/conv/:id/messages/:mid/poll/vote', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { optionIds } = z.object({ optionIds: z.array(z.string().min(1).max(8)).max(CONV_POLL_LIMITS.maxOptions) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-react:${me}`, REACT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (await fedLinkRefused(reply, access)) return;
    return pollReply(reply, await (await pollActions()).voteConvPoll(me, access, mid, optionIds), mid, me);
  });
  /** «Остановить опрос» — автор; навсегда (Telegram `StopPoll`). */
  app.post('/conv/:id/messages/:mid/poll/close', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    return pollReply(reply, await (await pollActions()).closeConvPoll(me, access, mid), mid, me);
  });
  /**
   * Трансляция геопозиции в ЛС (14.10, `geolive1`): новая точка автора и «Остановить». Ответ — сообщение моими глазами; остальным
   * участникам — `conv.change` (как правка опроса: без «изменено», без пуша, беседу не поднимает). Предел частоты: клиент шлёт не
   * чаще раза в 5 с, сервер точку чаще 3 с принимает молча (`geoLiveUpdate`); поверх — общий предел на человека.
   */
  const geoLiveReply = async (reply: FastifyReply, res: ConvGeoLiveActResult, mid: string, me: string) => {
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'refused') return reply.code(res.code).send({ error: res.error });
    await deliver(res.delivery);
    const view = await messageFor(mid, me);
    return view ? reply.send(view) : reply.code(404).send({ error: 'not found' });
  };
  app.post('/conv/:id/messages/:mid/live', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const point = z
      .object({ lat: z.number().finite(), lon: z.number().finite(), accuracy: z.number().finite().nullish(), heading: z.number().finite().nullish() })
      .parse(req.body);
    if (await limited(reply, await rateHit(`conv-live:${me}`, 40, 60))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    return geoLiveReply(reply, await (await geoLiveActions()).updateConvGeoLive(me, access, mid, point), mid, me);
  });
  /** «Остановить трансляцию» — автор; навсегда (Telegram `stopSharingLocation`). */
  app.post('/conv/:id/messages/:mid/live/stop', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    return geoLiveReply(reply, await (await geoLiveActions()).stopConvGeoLive(me, access, mid), mid, me);
  });
  /** «Посмотреть голоса» неанонимного опроса (Telegram `PollVotesAlert`): итоги должны быть открыты смотрящему. */
  app.get('/conv/:id/messages/:mid/poll/voters', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await (await pollActions()).convPollVoters(me, access, mid);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'refused') return reply.code(res.code).send({ error: res.error });
    return reply.send({ options: res.options });
  });

  /**
   * «Прослушал голосовое» (07.10, признак `voice1`, G12): снимает синюю точку у меня на всех устройствах и показывает автору,
   * что прослушано. Своё, не-голосовое и невидимое мне — 404; повтор — 204 без событий.
   */
  app.post('/conv/:id/messages/:mid/listened', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    if (await limited(reply, await rateHit(`conv-listen:${me}`, REACT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const blockedActor = new Set<string>();
    for (const uid of access.memberIds) if (uid !== me && (await blockedBy(uid)).has(me)) blockedActor.add(uid);
    const res = await listenVoice(me, access, mid, blockedActor);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  /**
   * Одноразовое голосовое прослушано (08.10, признак `voice3`, G54): получатель дослушал или закрыл — файл удаляется, у обоих
   * «Голосовое сообщение прослушано». Своё, не одноразовое и невидимое — 404; повтор — 204 без событий.
   */
  app.post('/conv/:id/messages/:mid/once-spent', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    if (await limited(reply, await rateHit(`conv-listen:${me}`, REACT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await spendVoiceOnce(me, access, mid);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  /**
   * Одноразовое фото/видео открыто (19.10, `ttlmedia1`, #226): отметка первого открытия — от неё таймер, и по ней сервер сам
   * сожжёт сообщение (`sweepOpenedOnce`), если закрытие (`once-spent`) не придёт. Ответ — `{ openedAt, serverNow }` (ISO; `serverNow` — часы сервера в миг ответа); уже сгорело — 410;
   * своё, не такое и невидимое — 404.
   */
  app.post('/conv/:id/messages/:mid/once-open', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    if (await limited(reply, await rateHit(`conv-listen:${me}`, REACT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await openOnceMedia(me, access, mid);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'spent') return reply.code(410).send({ error: 'gone' });
    // `serverNow` (только добавлением) — часы сервера в этот миг: клиент считает остаток срока без сверки своих часов с серверными.
    return reply.code(200).send({ openedAt: res.openedAt.toISOString(), serverNow: new Date().toISOString() });
  });

  /**
   * Закреплённые беседы (С2, признак `conv7`) — МОИ: «для меня» и «для обоих», от старых к новым по порядку ленты, с
   * превью (`ConvPinsResponse`). Не участник — 404.
   */
  app.get('/conv/:id/pins', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const list = await listPins(me, conversationId);
    if (!list) return reply.code(404).send({ error: 'not found' });
    return list;
  });

  /**
   * Закрепить (С2, `conv7`): `for: 'me'` — только у себя, `'both'` — ещё у собеседника («Также закрепить для
   * собеседника»; кто меня заблокировал, тому не ставится, как реакция, — я этого не узнаю). Только видимое мне живое
   * сообщение этой беседы — иначе 404. Мой список полон — 409 `{error: 'pin limit', max}`. Ответ — мой список и `pts`;
   * событие `conv.change` с `pins` — тем, у кого список изменился (повтор — без событий). Пуша нет: закреп — не сообщение.
   * Старых `dm.*` нет — у клиентов 0.8.x закрепа в ЛС нет вовсе.
   */
  app.put('/conv/:id/messages/:mid/pin', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { for: scope } = z.object({ for: z.enum(['me', 'both']) }).parse(req.body ?? {});
    // G4 (приёмка 13.10): «Уведомить всех участников» окна закрепа группы (Telegram `messages.updatePinnedMessage` с `silent`).
    // Только добавлением: старый клиент поля не шлёт — всё как раньше.
    const notify = pinNotifyOf(req.body);
    if (await limited(reply, await rateHit(`conv-pin:${me}`, PIN_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (scope === 'both' && (await fedLinkRefused(reply, access))) return;
    const groupNotify = access.kind === 'group' && scope === 'both' ? notify : undefined;
    const res = await pinMessage(me, access, mid, scope, groupNotify === false ? { silent: true } : undefined);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'limit') return reply.code(409).send({ error: 'pin limit', max: PINS_MAX });
    await deliver(res.delivery);
    await deliver(res.service ?? null); // строка «X закрепил(а) сообщение» (`pins2`) — после списка закрепов
    // G4: группа, галочка стоит и строка закрепа встала — пуш участникам «закрепил(а) «…»» (окно «Уведомить всех участников»).
    if (groupNotify === true && res.service) {
      const pinned = res.list.pins.find((x) => x.message.id === mid);
      pushGroupPack(me, conversationId, access.memberIds, pinPushText(pinned?.message.text ?? ''), false);
    }
    return res.list;
  });

  /**
   * Открепить (С2, `conv7`): `?for=me` — только мой закреп, `?for=both` — ещё закреп «для обоих» у собеседника (его закреп
   * «только у себя» не трогается). Умолчания нет, как у удаления. Сообщения нет в беседе — 404; для меня его нет (удалено,
   * спрятано) — 200 без изменений. Ответ — мой список и `pts`.
   */
  app.delete('/conv/:id/messages/:mid/pin', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const { for: scope } = z.object({ for: z.enum(['me', 'both']) }).parse(req.query ?? {});
    if (await limited(reply, await rateHit(`conv-pin:${me}`, PIN_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (scope === 'both' && (await fedLinkRefused(reply, access))) return;
    const res = await unpinMessage(me, access, mid, scope);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return res.list;
  });

  // ─── Отложенные (С4, 05.10, признак `conv9`): «Отправить позже» и «Когда будет в сети», как в Telegram ─────────────
  // Запись и планировщик — `scheduled.ts`, правила — `scheduleRules.ts`. Видит отложенные только автор: события и журнал —
  // только ему (его другие устройства); собеседник узнаёт о сообщении, когда оно уходит, — обычной отправкой.

  /** Мои отложенные беседы (`ConvScheduledResponse`): сначала по времени, затем «когда будет в сети». Не участник — 404. */
  app.get('/conv/:id/scheduled', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const list = await listScheduled(me, conversationId);
    if (!list) return reply.code(404).send({ error: 'not found' });
    return list;
  });

  /**
   * Создать отложенное (`ConvScheduleRequest`): ровно одно из `sendAt` (ISO с поясом; от «сейчас» минус минута до года
   * вперёд) и `whenOnline: true`, иначе 400 (`schedule mode required`, `bad send_at`, `send_at in the past`, `send_at too
   * far` + `maxDays`). Вложения (06.10, признак `conv10`) — как у отправки: id МОИХ незавершённых загрузок этой беседы +
   * подсказки клиента, до 10; не те (чужое, уже отправленное, другой беседы, повтор id) — 400 `вложение уже отправлено или
   * не найдено`; текст тогда может быть пустым (ни текста, ни файлов — 400 `empty message`). Права — как у отправки (не
   * участник — 404, собеседник удалён — 403). Ответ на невидимое мне — 400 `invalid reply target`. Предел — 409 `{error:
   * 'scheduled limit', scope: 'conversation'|'user', max}`, у отложенных с файлами ещё 409 `reason: 'scheduled_media_limit'`
   * (`scope: 'conversation'` + `max` — штук в беседе, `scope: 'user'` + `maxBytes`; `error` — словами). Повтор `clientId`:
   * 200 и список / 409 `client_id_conflict`. Новое — 201 и мой список с `pts`.
   */
  app.post('/conv/:id/scheduled', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z
      .object({
        clientId: z.guid(),
        content: z.string().max(SCHEDULED_TEXT_MAX, TEXT_TOO_LONG).optional().default(''),
        // `conv10`: те же ссылки на загрузки, что у отправки (`POST /conv/:id/attachments` → id + подсказки клиента).
        attachments: convAttachmentRefsSchema,
        replyToId: z.string().min(1).max(64).nullish(),
        silent: z.boolean().optional(),
        captionAbove: z.boolean().optional(),
        sendAt: z.string().max(64).nullish(),
        whenOnline: z.boolean().optional(),
      })
      .parse(req.body);
    const content = body.content.trim();
    if (!content && body.attachments.length === 0) return reply.code(400).send({ error: 'empty message' });
    const when = scheduleTarget({ sendAt: body.sendAt, whenOnline: body.whenOnline }, new Date());
    if (!when.ok) return scheduleError(reply, when.error);
    if (await limited(reply, await rateHit(`conv-sched:${me}`, SCHED_MAX, WINDOW_S))) return;

    const access = await loadAccess(conversationId, me);
    const [peer] = access?.peerId
      ? await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, access.peerId)).limit(1)
      : [];
    // Группа (`groups2`, 07.10): собеседника нет — пересылать и откладывать может любой действующий участник.
    const write = access?.kind === 'group' || access?.saved ? 'ok' : canWriteDm({ member: !!access, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write === 'not-a-member' || !access) return reply.code(404).send({ error: 'not found' });
    if (write === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });
    if (await messagePrivacyRefused(reply, me, access)) return;
    if (await fedLinkRefused(reply, access)) return;
    if (body.attachments.length > 0 && (await fedFilesRefused(reply, access.peerId))) return;
    if (onceRefs(body.attachments) && (await fedOnceRefused(access.peerId))) return reply.code(400).send({ error: FED_ERRORS.dmAttachmentsLater });
    if (when.target.whenOnline && !(await whenOnlineAllowed(me, access))) {
      return reply.code(409).send({ error: SCHEDULE_STATUS_PRIVATE });
    }

    const res = await createScheduled(me, access, {
      clientId: body.clientId,
      content,
      attachments: body.attachments,
      replyToId: body.replyToId ?? null,
      silent: body.silent === true,
      captionAbove: body.captionAbove === true,
      target: when.target,
    });
    if (res.kind === 'bad-reply') return reply.code(400).send({ error: 'invalid reply target' });
    if (res.kind === 'bad-attachments') return reply.code(400).send({ error: 'вложение уже отправлено или не найдено' });
    if (res.kind === 'once-refused') return reply.code(400).send(ONCE_REFUSED_BODY);
    if (res.kind === 'limit') return reply.code(409).send({ error: 'scheduled limit', scope: res.scope, max: res.max });
    if (res.kind === 'media-limit') return reply.code(409).send(scheduledMediaLimitBody(res));
    if (res.kind === 'conflict') return reply.code(409).send({ error: 'client_id_conflict' });
    if (res.kind === 'replay') return reply.code(200).send(res.list);
    await deliver(res.delivery);
    return reply.code(201).send(res.list);
  });

  /**
   * Поправить отложенное (`ConvScheduledEditRequest`): `content` — текст (пустой — только у отложенного с вложениями, иначе
   * 400 `empty message`; вложения правка не трогает); `sendAt` или `whenOnline: true` (не оба) — время или режим, это же
   * снимает «не отправлено» и счётчик повторов. Пусто — 400 `nothing to change`. Уже ушло или удалено — 404. Ответ — мой
   * список с `pts`.
   */
  app.patch('/conv/:id/scheduled/:sid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, sid } = schedParams.parse(req.params);
    const body = z
      .object({
        content: z.string().max(SCHEDULED_TEXT_MAX, TEXT_TOO_LONG).optional(),
        sendAt: z.string().max(64).optional(),
        whenOnline: z.literal(true).optional(),
      })
      .parse(req.body ?? {});
    if (body.content === undefined && body.sendAt === undefined && body.whenOnline === undefined) {
      return reply.code(400).send({ error: 'nothing to change' });
    }
    // Пустой текст решает `editScheduled`: у отложенного с вложениями это «убрать подпись» (`conv10`), у текстового — 400.
    const content = body.content !== undefined ? body.content.trim() : undefined;
    let target: ScheduleTarget | undefined;
    if (body.sendAt !== undefined || body.whenOnline !== undefined) {
      const when = scheduleTarget(body, new Date());
      if (!when.ok) return scheduleError(reply, when.error);
      target = when.target;
    }
    if (await limited(reply, await rateHit(`conv-sched:${me}`, SCHED_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (target?.whenOnline && !(await whenOnlineAllowed(me, access))) {
      return reply.code(409).send({ error: SCHEDULE_STATUS_PRIVATE });
    }
    const res = await editScheduled(me, access, sid, { content, target });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'empty') return reply.code(400).send({ error: 'empty message' });
    await deliver(res.delivery);
    return res.list;
  });

  /** Удалить отложенное. Уже ушло или удалено — 404. Ответ — мой список с `pts`. */
  app.delete('/conv/:id/scheduled/:sid', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, sid } = schedParams.parse(req.params);
    if (await limited(reply, await rateHit(`conv-sched:${me}`, SCHED_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await deleteScheduled(me, access, sid);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return res.list;
  });

  /**
   * «Отправить сейчас» (`ConvScheduledSendResponse`): обычная отправка с id отправки отложенного, время — сейчас; работает и
   * для «не отправлено» (ручной повтор). Права и лимит — как у отправки (не участник/строки нет — 404, собеседник удалён —
   * 403). 201 — ушло (с вложениями, если они есть); 200 — сообщение с этим id уже было (только убрано из списка); 409 — id
   * отправки занят другим (`client_id_conflict`) или файлов отложенного нет на месте (`scheduled attachments missing`).
   */
  app.post('/conv/:id/scheduled/:sid/send', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, sid } = schedParams.parse(req.params);
    if (await limited(reply, await messageSendBlock(me))) return;
    if (await limited(reply, await rateHit(`conv-sched:${me}`, SCHED_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    const [peer] = access?.peerId
      ? await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, access.peerId)).limit(1)
      : [];
    // Группа (`groups2`, 07.10): собеседника нет — пересылать и откладывать может любой действующий участник.
    const write = access?.kind === 'group' || access?.saved ? 'ok' : canWriteDm({ member: !!access, peerExists: !!peer, peerDeleted: !!peer?.deletedAt });
    if (write === 'not-a-member' || !access) return reply.code(404).send({ error: 'not found' });
    if (write === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });
    if (await messagePrivacyRefused(reply, me, access)) return;
    if (await fedLinkRefused(reply, access)) return;
    const res = await sendScheduledNow(me, access, sid);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'peer-gone') return reply.code(403).send({ error: DM_PEER_GONE_ERROR });
    if (res.kind === 'conflict') return reply.code(409).send({ error: 'client_id_conflict' });
    if (res.kind === 'broken') return reply.code(409).send({ error: 'scheduled attachments missing' });
    const message = await messageFor(res.messageId, me);
    return reply.code(res.created ? 201 : 200).send({ message, pts: res.list.pts, items: res.list.items });
  });

  /**
   * «Прочитано в 12:34» (С1, #211, `lastseen1`) — подвал меню СВОЕГО сообщения в беседе 1:1 (`ConvReadAt`). Чужое
   * сообщение, группа, не участник — 404. Время — только не старше 7 суток и если его не скрыл ни он, ни я.
   */
  app.get('/conv/:id/messages/:mid/read-at', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const view = await readAtFor(me, access, mid);
    if (!view) return reply.code(404).send({ error: 'not found' });
    return view;
  });

  /**
   * «Кто прочитал» (15.10, `readers1`) — строка «N прочитали» в меню СВОЕГО сообщения в группе (`ConvReaders`; Telegram
   * `messages.getMessageReadParticipants`). 1:1, «Избранное», чужое сообщение, не участник — 404. Старше 7 суток — `expired`.
   */
  app.get('/conv/:id/messages/:mid/readers', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, mid } = msgParams.parse(req.params);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const view = await readersFor(me, access, mid);
    if (!view) return reply.code(404).send({ error: 'not found' });
    return view;
  });

  app.post('/conv/:id/read', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const { key } = z.object({ key: z.number() }).parse(req.body);
    if (!isSortKey(key)) return reply.code(400).send({ error: 'bad key' });
    if (await limited(reply, await rateHit(`conv-read:${me}`, READ_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await markRead(me, access, key);
    if (res.kind === 'bad-key') return reply.code(400).send({ error: 'bad key' });
    // Собеседнику — `conv.change` со сводкой (Р6, ✓✓, `deliver`).
    await deliver(res.delivery);
    // Р1 (G17): мои телефоны снимают уведомление беседы — тихий пуш «прочитано» (только приложениям с `read1`).
    if (res.delivery) void sendReadSyncPush(me, conversationId, res.lastReadKey).catch(() => {});
    return { lastReadKey: res.lastReadKey };
  });

  /**
   * Черновик (Р7, признак `conv3`): между МОИМИ устройствами. Пусто (ни текста, ни ответа) — удалить. Событие
   * `conv.change` со сводкой (в ней `draft`) — только моим соединениям; старым (0.8.x) слать нечего: черновиков у них нет.
   */
  app.put('/conv/:id/draft', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z
      .object({
        text: z.string().max(DRAFT_TEXT_MAX, TEXT_TOO_LONG),
        replyToId: z.string().min(1).max(64).nullable(),
        device: z.string().refine(isDraftDevice),
      })
      .parse(req.body);
    if (await limited(reply, await rateHit(`conv-draft:${me}`, DRAFT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await saveDraft(me, access, body);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return reply.code(204).send();
  });

  /**
   * Закреп беседы наверху МОЕГО списка (07.10, признак `conv11`): `{ pinned }` → `{ pinnedAt }`. Шестой закреп —
   * 409 `{ reason: 'conv_pin_limit', max }`. Событие `conv.change` со сводкой (в ней `pinnedAt`) — только моим
   * соединениям; собеседник о закрепе не узнаёт. Старый клиент поле не знает и рисует список по времени, как раньше.
   */
  app.put('/conv/:id/pinned', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ pinned: z.boolean() }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-pinned:${me}`, CONV_PINNED_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await setConversationPinned(me, access, body.pinned);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'limit') return reply.code(409).send({ error: 'conv pin limit', reason: 'conv_pin_limit', max: res.max });
    await deliver(res.delivery);
    // Беседа вычеркнута из своего порядка папок (`pinorder2`) — мои устройства получают список папок заново.
    if (res.foldersChanged) await publishDmFolders(me);
    return { pinnedAt: res.pinnedAt };
  });

  /**
   * Перестановка закреплённых бесед МОЕГО списка (08.10, признак `pinorder1`, Telegram `messages.reorderPinnedDialogs`):
   * `{ ids }` — новый порядок сверху вниз → `ConvPinOrderResponse` (все мои закреплённые с новыми `pinnedAt`). Повтор id и
   * id не из моих закреплённых — 400 `reason: 'conv_pin_order'`. События — `conv.change` со сводкой каждой беседы, чья
   * отметка сменилась, только моим соединениям (как у закрепа); старый клиент сортирует по `pinnedAt` и видит тот же порядок.
   */
  app.put('/conv/pinned-order', async (req, reply) => {
    const me = req.user!.sub;
    const body = z.object({ ids: z.array(z.string().min(1).max(64)).max(50) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-pin-order:${me}`, CONV_PINNED_MAX, WINDOW_S))) return;
    const res = await reorderConversationPins(me, body.ids);
    if (res.kind === 'bad') return reply.code(400).send({ error: 'bad pin order', reason: 'conv_pin_order' });
    await deliverMany(res.deliveries);
    return { pins: res.pins };
  });

  /**
   * «Пометить как непрочитанное / прочитанное» (07.10, G04, признак `conv13`): `{ marked }` → `{ marked }`. Точка без числа
   * в МОЁМ списке; событие `conv.change` со сводкой (в ней `markedUnread`) — только моим соединениям, собеседник не узнаёт.
   * `marked: false` снимает только точку; чтение беседы (`/read`) снимает её само. Старые клиенты поле не знают.
   */
  app.put('/conv/:id/unread-mark', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ marked: z.boolean() }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-unread-mark:${me}`, CONV_UNREAD_MARK_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await setConversationUnreadMark(me, access, body.marked);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return { marked: res.marked };
  });

  /**
   * «В архив» / «Вернуть из архива» (07.10, #211, G41, признак `archive1`): `{ archived }` → `{ archived }`. Отметка только в
   * МОЕЙ строке участника; `conv.change` со сводкой (`archived`) — только моим соединениям. То же состояние — без записи и
   * события. Новое сообщение возвращает беседу, если она не заглушена (`conversations.unarchiveOnMessage`).
   */
  app.put('/conv/:id/archived', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ archived: z.boolean() }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-archived:${me}`, CONV_ARCHIVED_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await setConversationArchived(me, access, body.archived);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return { archived: res.archived };
  });

  /**
   * Крестик на плашке незнакомца (08.10, #211, С7, G30, признак `stranger1`; Telegram `hide_peer_settings_bar`): запомнить в
   * МОЕЙ строке участника — плашка гаснет на всех моих устройствах (`conv.change` со сводкой без `stranger`). Повтор — 200 без события.
   */
  app.post('/conv/:id/stranger/hide', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    if (await limited(reply, await rateHit(`conv-stranger:${me}`, CONV_ARCHIVED_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await hideStrangerBar(me, access);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(res.delivery);
    return { ok: true };
  });

  /**
   * «Пожаловаться» на собеседника 1:1 (08.10, #211, С7, G30, Р-10, признак `stranger1`): `{ reason, comment? }` → `{ ok, merged }`.
   * Жалоба уходит держателю инстанса (супер-админу, `GET /admin/dm-reports`) с последними пятью сообщениями собеседника;
   * плашка после неё гаснет. Собеседник с другого инстанса (Э2 часть Б) — жалоба ещё и держателю его дома (`fedDmReport`).
   */
  app.post('/conv/:id/report', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ reason: z.string().max(32), comment: z.string().max(2000).optional() }).parse(req.body);
    if (!isDmReportReason(body.reason)) return reply.code(400).send({ error: 'unknown reason' });
    if (await limited(reply, await rateHit(`conv-report:${me}`, DM_REPORT_LIMIT.max, DM_REPORT_LIMIT.windowS))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    const res = await reportConversationPeer(me, access, { reason: body.reason, comment: body.comment });
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'not-direct') return reply.code(400).send({ error: 'not a direct conversation' });
    await deliver(res.delivery);
    // Э2 часть Б: собеседник — человек соседа → жалоба ещё и держателю его дома (`report.create`, best-effort).
    if (fedDmReport && access.peerId) {
      await fedDmReport(me, access.conversationId, access.peerId, { reason: body.reason, comment: body.comment ?? null }).catch((err) => {
        console.warn(`[fed-dm] жалоба соседу не ушла: ${err instanceof Error ? err.message : err}`);
      });
    }
    return { ok: true, merged: res.merged };
  });

  /**
   * «Прочитать все» (07.10, G04, признак `conv13`): все мои беседы с непрочитанным или пометкой читаются до последнего
   * сообщения — события те же, что у обычного «прочитано» (✓✓ собеседникам, `conv.change` моим устройствам). `{ count }` —
   * сколько бесед затронуто. Подтверждение перед вызовом — дело клиента (у Telegram — от 1000 непрочитанных).
   */
  app.post('/conv/read-all', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, await rateHit(`conv-read-all:${me}`, CONV_READ_ALL_MAX, WINDOW_S))) return;
    const res = await markAllRead(me);
    await deliverMany(res.deliveries);
    // Р1 (G17): снять уведомления прочитанных бесед на моих телефонах (ключ не нужен — прочитано всё).
    for (const d of res.deliveries) void sendReadSyncPush(me, d.conversationId, null).catch(() => {});
    return { count: res.count };
  });

  /**
   * «Очистить историю» (07.10, #211, G01, признак `conv12`): вся переписка уходит у меня (`for: 'me'`) или у обоих
   * (`both`, только 1:1) — пачками обычного удаления (`conversations.clearHistory`), с теми же событиями, что у
   * `POST /conv/:id/messages/delete`: новым клиентам `conv.change`, старым — `dm.delete` по каждому. Беседа остаётся в
   * списке (пустой). Одна операция бюджета правок на всю очистку.
   */
  app.post('/conv/:id/clear', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ for: z.enum(['me', 'both']) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    if (body.for === 'both' && (await fedLinkRefused(reply, access))) return;
    for (const res of await clearHistory(me, access, body.for)) {
      await deliverMany(res.deliveries);
    }
    return reply.code(204).send();
  });

  /**
   * «Удалить чат» (07.10, #211, G01, `conv12`): беседа уходит из моего списка (`both` — и из списка собеседника) до
   * нового сообщения, переписка до этой минуты очищается так же, как «Очистить историю» с тем же `for`. Сначала метка
   * (`hideConversation` — устройствам уходит `ConvLeft`), затем очистка: события удаления по ушедшей беседе клиент
   * пропускает. Старый клиент собеседника беседу не убирает до перезагрузки (старый список `GET /dm` её уже не отдаёт).
   */
  app.post('/conv/:id/hide', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = convParams.parse(req.params);
    const body = z.object({ for: z.enum(['me', 'both']) }).parse(req.body);
    if (await limited(reply, await rateHit(`conv-edit:${me}`, EDIT_MAX, WINDOW_S))) return;
    const access = await loadAccess(conversationId, me);
    if (!access) {
      // Бывшая группа (`groups3`): «Удалить группу» — только у меня.
      const gone = await hideFormerGroup(me, conversationId);
      if (!gone) return reply.code(404).send({ error: 'not found' });
      await deliver(gone);
      return reply.code(204).send();
    }
    const hidden = await hideConversation(me, access, body.for === 'both');
    if (hidden.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    await deliver(hidden.delivery);
    // Бот (#229): человек удалил беседу с ботом — событие `my_chat_member` (`left`); не бот — функция ничего не делает.
    if (access.kind === 'direct' && access.peerId) queueBotChatMember(access.peerId, me, conversationId, 'left');
    for (const res of await clearHistory(me, access, body.for, hidden.upToKey)) {
      await deliverMany(res.deliveries);
    }
    return reply.code(204).send();
  });
}

/**
 * «Отправить, когда будет в сети» — только если время захода собеседника мне видно (С1, `lastseen1`; Telegram
 * `SCHEDULE_STATUS_PRIVATE`): иначе момент доставки выдал бы, когда он зашёл. Групп у отложенных нет — там пропускаем.
 */
const SCHEDULE_STATUS_PRIVATE = 'schedule_status_private';
async function whenOnlineAllowed(me: string, access: { peerId: string | null; kind?: string; saved?: boolean }): Promise<boolean> {
  // «Когда будет в сети» у Telegram — только в личной беседе (в группе такого пункта нет).
  if (access.kind === 'group') return false;
  // «Избранное» (`saved1`): «когда будет в сети» себе не бывает (Telegram: пункта нет у «Saved Messages»).
  if (access.saved) return false;
  return !access.peerId || (await canScheduleUntilOnline(me, access.peerId));
}

/** G4: поле `notify` тела закрепа — только булево; нет поля или мусор — `undefined` (как старый клиент). */
function pinNotifyOf(body: unknown): boolean | undefined {
  const v = body && typeof body === 'object' ? (body as { notify?: unknown }).notify : undefined;
  return typeof v === 'boolean' ? v : undefined;
}

/** G4: тело пуша закрепа группы — «закрепил(а) «текст»» (Telegram Android `NotificationMessageGroupPinned…`), без текста — «закрепил(а) сообщение». */
function pinPushText(content: string): string {
  const one = content.replace(/\s+/g, ' ').trim();
  if (!one) return 'закрепил(а) сообщение';
  return `закрепил(а) «${one.length > 60 ? `${one.slice(0, 60)}…` : one}»`;
}
