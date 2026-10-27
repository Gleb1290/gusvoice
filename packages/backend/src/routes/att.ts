import type { Attachment } from '@gusvoice/shared';
import { FED_ERRORS, isOnceMedia, ONCE_TTL_MAX, VOICE_MAX_MS, WAVEFORM_BUCKETS } from '@gusvoice/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  attachmentHeaders,
  attPartsWellFormed,
  isAttId,
  parseRange,
  resolveAttachmentMime,
  sanitizeFilename,
} from '../attachmentRules.js';
import {
  attachmentLink,
  attachmentSigValid,
  attachmentStore,
  createPending,
  DailyQuotaError,
  privateAttachmentsReady,
} from '../attachments.js';
import { requireAuth } from '../auth.js';
import { attachmentUploadBlock, clientIp, rateHit, retryMessage } from '../authGuard.js';
import { attachmentAccess } from '../convRules.js';
import { formerLeftAt } from '../conversations.js';
import { db } from '../db/index.js';
import { attachments, conversationMembers, conversationMessages, users } from '../db/schema.js';
import { attachmentBlocked } from '../storage.js';

/**
 * Закрытые файлы ЛС (шаг 1в, `docs/dm/STAGE1.md`, «Файлы»): выдача по ссылке смотрящего и общий приём загрузки для
 * старой (`/dm/:id/attachments`) и новой (`/conv/:id/attachments`) ручек.
 *
 * 🔴 Выдача БЕЗ `requireAuth`: `<img>`/`<audio>` токена не несут. Доступ решают подпись ссылки (вложение + смотрящий +
 * поколение его токенов) и `convRules.attachmentAccess` на КАЖДОМ запросе. Отдаёт сам бэкенд потоком из закрытого
 * бакета (с диапазонами для перемотки голосовых) — не 302 на подписанную ссылку хранилища: та живёт минуты, завязана на
 * адрес хранилища и несёт в себе ключ бэкенда (разведка 30.09).
 */

async function tokenGenOf(userId: string): Promise<number> {
  const [u] = await db.select({ gen: users.tokenGeneration }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.gen ?? 0;
}

/** Границы полей, которые при отправке знает только клиент (как у `dmAttachmentSchema`). */
const clientHints = {
  width: z.number().int().positive().max(20_000).nullish(),
  height: z.number().int().positive().max(20_000).nullish(),
  waveform: z.array(z.number().int().min(0).max(100)).max(WAVEFORM_BUCKETS).nullish(),
  durationMs: z.number().int().positive().max(VOICE_MAX_MS).nullish(),
  /** «Отправить как файл» (`linkprev1`): картинка и видео остаются карточкой файла. */
  asFile: z.literal(true).nullish(),
  /** GIF (`gifs1`): видео без звука по кругу; сервер оставит пометку только у видео и `image/gif`. */
  gif: z.literal(true).nullish(),
  /** Спойлер (`media2`): фото и видео у получателя размыты до нажатия; сервер оставит пометку только у них. */
  spoiler: z.literal(true).nullish(),
  /** «Прослушать один раз» (`voice3`, G54): сервер оставит пометку только у голосового беседы 1:1. */
  once: z.literal(true).nullish(),
  /** Таймер одноразового фото/видео, с (`ttlmedia1`, #226): сервер оставит его только вместе с `once` у фото/видео. */
  onceTtl: z.number().int().min(1).max(ONCE_TTL_MAX).nullish(),
  /** Кружок (`circles1`, G68): сервер оставит пометку только у квадратного видео до минуты. */
  round: z.literal(true).nullish(),
};

/** Вложения новой отправки `/api/conv/:id/messages`: id загрузки + подсказки клиента. */
export const convAttachmentRefsSchema = z
  .array(z.object({ id: z.guid(), ...clientHints }))
  .max(10)
  .optional()
  .default([]);

/**
 * Приём файла в беседу (участие проверил вызывающий). Тип — по содержимому, строка `pending` — до записи файла.
 * Ответ — старый DTO вложения (им пользуется 0.8.x как есть) + `id`; ссылка — для самого загрузившего.
 */
export async function acceptDmUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  conversationId: string,
  me: string,
): Promise<Attachment | FastifyReply> {
  if (!privateAttachmentsReady() && !(await attachmentStore.ensureReady())) {
    return reply.code(503).send({ error: 'Файлы в личных сообщениях сейчас недоступны: закрытое хранилище не готово' });
  }
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'no file' });
  const buffer = await file.toBuffer();
  // 🔴 Обрезанный по пределу файл (09.10, стенд): `toBuffer` бросает не всегда — бывало 200 и файл ровно 25 МиБ вместо 26.
  if (file.file.truncated) return reply.code(413).send({ error: 'request file too large' });
  const declared = file.mimetype || 'application/octet-stream';
  // Имя уезжает в заголовок выдачи и в ленту собеседника: без управляющих символов и подмены расширения (U+202E).
  const name = sanitizeFilename(file.filename || 'file');
  // Reject script-capable web types (P2-1/P3-8) — SVG/HTML could execute if rendered inline.
  if (attachmentBlocked(declared, name)) return reply.code(415).send({ error: 'этот тип файла запрещён (SVG/HTML)' });
  // Upload rate-limit (P2-3) — after buffering (multipart drained), before the bucket write.
  const upWait = await attachmentUploadBlock(me);
  if (upWait) return reply.code(429).header('Retry-After', String(upWait)).send({ error: retryMessage(upWait) });
  // Суточный объём (`bigfile1`): одиночные загрузки считаются в тот же предел, что и куски. Проверка — внутри замка вставки
  // (`createPending` `daily`, ревью L3): снаружи параллельные загрузки проходили её вдвоём.
  const contentType = resolveAttachmentMime(declared, buffer.subarray(0, 64));
  let id: string;
  try {
    id = await createPending({ ownerId: me, conversationId, name, contentType, bytes: buffer, daily: true });
  } catch (e) {
    if (e instanceof DailyQuotaError) return reply.code(429).send({ error: e.message });
    throw e;
  }
  return uploadedAttachmentDto({ id, name, contentType, size: buffer.length }, me);
}

/** Ответ загрузки (одиночной и кусками): старый DTO вложения + `id`; ссылка — для самого загрузившего. */
export async function uploadedAttachmentDto(
  a: { id: string; name: string; contentType: string; size: number },
  me: string,
): Promise<Attachment & { id: string }> {
  return { id: a.id, url: attachmentLink(a.id, me, await tokenGenOf(me)), name: a.name, contentType: a.contentType, size: a.size };
}

/**
 * Э3 часть 2 (#141): отдача файла `remote` (копии у нас нет) — крючок, а не импорт: модуль федерации тянет шлюз и Redis, а
 * этот маршрут живёт и без федерации. Подключается в `index.ts` при `FEDERATION_DM_ENABLED` (`federation/convAtt.ts`
 * `serveRemoteAttachment`); без крючка `remote` — прежний 503 `federation.att_pending`.
 */
export type RemoteAttServe =
  | { kind: 'stream'; body: Readable }
  | { kind: 'unavailable'; instance: string | null }
  | { kind: 'gone' };
type RemoteServe = (att: typeof attachments.$inferSelect, range: { start: number; end: number } | null) => Promise<RemoteAttServe>;
let remoteServe: RemoteServe | null = null;
export function configureRemoteAttachments(fn: RemoteServe | null): void {
  remoteServe = fn;
}

/**
 * Одноразовое фото/видео ещё не открыто смотрящим (#226): смотрящий — не автор, у сообщения есть такое вложение, отметки
 * `once_opened_at` нет (или оно уже сгорело). Чистое правило — для маршрута выдачи файла.
 */
export function onceClosedFor(
  viewerId: string,
  message: { authorId: string; attachments: readonly Attachment[]; onceOpenedAt: Date | null; onceSpentAt: Date | null },
): boolean {
  if (message.authorId === viewerId) return false;
  if (!message.attachments.some((a) => isOnceMedia(a))) return false;
  return !message.onceOpenedAt || !!message.onceSpentAt;
}

export async function attRoutes(app: FastifyInstance): Promise<void> {
  /*
   * HEAD — свой маршрут, а не автоматический Fastify: тот зовёт этот же обработчик и дочитывает поток из хранилища
   * впустую, а на пустой ответ ставит `Content-Length: 0`. Здесь при HEAD поток не открывается вовсе.
   */
  const path = '/att/:id/:viewer/:sig';
  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, viewer, sig } = req.params as { id: string; viewer: string; sig: string };
    /**
     * Отказ. Переход по ссылке как по странице (старый клиент ведёт так «Скачать») получает 204 — он отменяет переход:
     * ответ с телом увёл бы окно десктопа с приложения, и человеку казалось бы, что его выкинуло из аккаунта (#43).
     */
    const asPage = req.headers['sec-fetch-dest'] === 'document';
    const deny = () => {
      reply.header('Cache-Control', 'no-store');
      return asPage ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
    };
    /**
     * Лимиты частоты (ревью 30.09): ручка без входа, и каждый запрос стоит нескольких запросов к базе и чтения из
     * хранилища. По адресу — до проверки подписи, по смотрящему — после. Щедро: лента с сотней картинок и их
     * повторные проверки (304) укладываются. Сверх — 429, а переходу как по странице — 204 (окно не уходит).
     */
    const limited = async (key: string, max: number) => {
      const wait = await rateHit(key, max, 60);
      if (!wait) return false;
      reply.header('Retry-After', String(wait)).header('Cache-Control', 'no-store');
      await (asPage ? reply.code(204).send() : reply.code(429).send({ error: retryMessage(wait) }));
      return true;
    };
    if (await limited(`att-ip:${clientIp(req)}`, 1200)) return reply;
    if (!attPartsWellFormed(id, viewer, sig) || !attachmentStore.configured()) return deny();
    const [att] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    if (!att) return deny();
    const [user] = await db
      .select({ gen: users.tokenGeneration, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, viewer))
      .limit(1);
    if (!user || !attachmentSigValid(id, viewer, user.gen, sig)) return deny();
    if (await limited(`att-v:${viewer}`, 900)) return reply;
    const [member] = await db
      .select({ leftAt: conversationMembers.leftAt, historyFromKey: conversationMembers.historyFromKey })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, att.conversationId), eq(conversationMembers.userId, viewer)))
      .limit(1);
    const [message] = att.messageId
      ? await db.select().from(conversationMessages).where(eq(conversationMessages.id, att.messageId)).limit(1)
      : [];
    const allowed = attachmentAccess({
      viewerId: viewer,
      viewerDeleted: !!user.deletedAt,
      att: { ownerId: att.ownerId, conversationId: att.conversationId, state: att.state, messageId: att.messageId },
      member: member ? { ...member, formerUntil: member.leftAt ? await formerLeftAt(att.conversationId, viewer) : null } : null,
      message: message ?? null,
    });
    if (!allowed) return deny();
    // Одноразовое фото/видео (#226, `ttlmedia1`): получателю файл — только после его `once-open` (отметка `once_opened_at`)
    // и до сгорания (после него строки файла нет — отказ выше). Автору — как всегда. Так же на доме соседа: его копия
    // раздаётся его человеку этим же маршрутом с отметкой на его копии сообщения.
    if (message && onceClosedFor(viewer, message)) return deny();
    // Э3 часть 1 (#141): файл из копии сообщения соседа ещё не скопирован к нам — 503 `federation.att_pending`
    // (в сообщении `fedState: 'copying'`); копия доедет — сообщение придёт обновлённым, ссылка та же.
    // Э3 часть 2: с крючком (`configureRemoteAttachments`, при `FEDERATION_DM_ENABLED`) такой файл отдаётся потоком с дома
    // автора — ниже; без него — по-прежнему 503.
    if (att.state === 'remote' && !remoteServe) {
      return reply.code(503).headers({ 'Retry-After': '5', 'Cache-Control': 'no-store' }).send({ error: FED_ERRORS.attPending });
    }

    const once = !!message?.attachments.some((a) => a.id === att.id && isOnceMedia(a));
    const headers = attachmentHeaders(att.contentType, att.name, att.id, once);
    // Условный запрос: доступ уже проверен, файл по id не меняется — 304 без тела (одноразовому — нет: в кеше его нет).
    const inm = req.headers['if-none-match'];
    if (!once && inm && inm.split(',').some((t) => t.trim() === headers.ETag)) {
      return reply.code(304).headers({ ETag: headers.ETag, 'Cache-Control': headers['Cache-Control'] }).send();
    }
    const st = att.state === 'remote' ? { size: att.size } : await attachmentStore.stat(att.storageKey);
    if (!st) return deny();
    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      return reply.code(416).headers({ 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' }).send();
    }
    // Э3 часть 2 (#141): копии у нас нет — поток с дома автора (тот же диапазон); автор недоступен — 503 `att_unavailable`.
    let remoteBody: Readable | null = null;
    if (att.state === 'remote' && remoteServe && req.method !== 'HEAD') {
      const r = await remoteServe(att, range);
      if (r.kind === 'gone') return deny();
      if (r.kind === 'unavailable') {
        return reply
          .code(503)
          .headers({ 'Retry-After': '30', 'Cache-Control': 'no-store' })
          .send({ error: FED_ERRORS.attUnavailable, ...(r.instance ? { instance: r.instance } : {}) });
      }
      remoteBody = r.body;
    }
    reply.headers(headers);
    if (range) {
      reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
        .header('Content-Length', String(range.end - range.start + 1));
    } else {
      reply.header('Content-Length', String(st.size));
    }
    // HEAD — только заголовки (ревью 30.09): маленький запрос не должен стоить чтения файла целиком.
    if (req.method === 'HEAD') return reply.send();
    return reply.send(remoteBody ?? (await attachmentStore.get(att.storageKey, range ?? undefined)));
  };
  app.get(path, { exposeHeadRoute: false }, serve);
  app.head(path, serve);

  /**
   * Свежие ссылки на файлы ЛС (аудит ЛС #236, п.6): у ссылки теперь срок (`attachmentRules.attLinkExpiry`), и клиент, у
   * которого картинка, видео, голосовое или скачивание получили 404, просит новую по id вложения и пробует снова. Отдаёт
   * только то, что выдача (`serve`) отдала бы этому человеку (`attachmentAccess`); прочие id молча пропускаются.
   */
  app.post('/att/links', { preHandler: requireAuth }, async (req, reply) => {
    const me = req.user!.sub;
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }).parse(req.body);
    const wait = await rateHit(`att-links:${me}`, 120, 60);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
    const want = [...new Set(ids)].filter(isAttId);
    const links: Record<string, string> = {};
    if (want.length === 0) return reply.send({ links });
    const [user] = await db
      .select({ gen: users.tokenGeneration, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, me))
      .limit(1);
    if (!user) return reply.send({ links });
    const rows = await db.select().from(attachments).where(inArray(attachments.id, want));
    const convIds = [...new Set(rows.map((a) => a.conversationId))];
    const msgIds = [...new Set(rows.flatMap((a) => (a.messageId ? [a.messageId] : [])))];
    const members = convIds.length
      ? await db
          .select({ conversationId: conversationMembers.conversationId, leftAt: conversationMembers.leftAt, historyFromKey: conversationMembers.historyFromKey })
          .from(conversationMembers)
          .where(and(eq(conversationMembers.userId, me), inArray(conversationMembers.conversationId, convIds)))
      : [];
    const messages = msgIds.length ? await db.select().from(conversationMessages).where(inArray(conversationMessages.id, msgIds)) : [];
    const memberOf = new Map(members.map((m) => [m.conversationId, m]));
    const messageOf = new Map(messages.map((m) => [m.id, m]));
    const formerOf = new Map<string, Date | null>();
    for (const a of rows) {
      const member = memberOf.get(a.conversationId);
      if (member?.leftAt && !formerOf.has(a.conversationId)) formerOf.set(a.conversationId, await formerLeftAt(a.conversationId, me));
      const message = a.messageId ? (messageOf.get(a.messageId) ?? null) : null;
      const allowed = attachmentAccess({
        viewerId: me,
        viewerDeleted: !!user.deletedAt,
        att: { ownerId: a.ownerId, conversationId: a.conversationId, state: a.state, messageId: a.messageId },
        member: member ? { ...member, formerUntil: formerOf.get(a.conversationId) ?? null } : null,
        message,
      });
      if (allowed && !(message && onceClosedFor(me, message))) links[a.id] = attachmentLink(a.id, me, user.gen);
    }
    return reply.send({ links });
  });
}
