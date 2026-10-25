import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { BIGFILE_MAX_BYTES, BIGFILE_PART_BYTES, sanitizeFilename } from '../attachmentRules.js';
import { privateAttachmentsReady, attachmentStore } from '../attachments.js';
import { attachmentUploadBlock, rateHit, retryMessage } from '../authGuard.js';
import { abortUpload, completeUpload, partTarget, startUpload, uploadPart, uploadStatus, type UploadFail } from '../bigUploads.js';
import { loadAccess } from '../conversations.js';
import { fedFilesRefused } from './conv.js';
import { attachmentBlocked } from '../storage.js';
import { uploadGate, type GateTicket } from '../uploadGate.js';
import { uploadedAttachmentDto } from './att.js';

/**
 * Загрузка кусками в беседу (`bigfile1`, 09.10; правила — `attachmentRules.ts`, база и хранилище — `bigUploads.ts`).
 * Только добавление: прежняя `POST /conv/:id/attachments` (одним запросом, до 25 МБ) не меняется, старые клиенты на ней.
 *
 * - `POST   /conv/:id/uploads` `{ name, size, type? }` → `{ uploadId, partSize, parts, maxBytes }` (413 — больше предела,
 *   429 — суточный объём / много открытых разом, 415 — запрещённый тип);
 * - `PUT    /conv/:id/uploads/:uploadId/parts/:n` тело `application/octet-stream` ровно `partSize` (последний — остаток) → `{ n }`;
 * - `GET    /conv/:id/uploads/:uploadId` → `{ uploadId, size, partSize, parts, done }` (продолжение после обрыва; 404 — нет);
 * - `POST   /conv/:id/uploads/:uploadId/complete` → DTO вложения, как у одиночной загрузки (`id` для отправки + ссылка);
 *   409 `{ missing }` — не все куски; 202 `{ assembling: true }` + `Retry-After` — сборка уже идёт (повтор после 504 прокси
 *   на долгой сборке), спросить ещё раз позже; повтор после успеха — то же вложение;
 * - `DELETE /conv/:id/uploads/:uploadId` → 204 (отмена).
 *
 * Кусок (ревью безопасности H1, 09.10): тело в 8 МиБ читается в память, поэтому ВСЁ, что может отказать, — до чтения тела, в
 * `onRequest` ручки: тип и `Content-Length` (ровно ожидаемый размер куска), частота, пропуск памяти (`uploadGate`: 4 куска
 * человека и 256 МиБ на процесс разом, сверх — 429/503 с `Retry-After`), владелец и участие в беседе. Выдуманный uploadId,
 * чужая загрузка и лавина параллельных кусков отбиваются без единого прочитанного байта тела.
 */

const params = z.object({ id: z.string().min(1).max(64) });
const uploadParams = z.object({ id: z.string().min(1).max(64), uploadId: z.guid() });
const partParams = uploadParams.extend({ n: z.coerce.number().int().min(1).max(10_000) });

/** Кусков в минуту на человека: 300 × 8 МиБ ≈ 2,4 ГиБ — человеку с запасом, петле — потолок. */
const PARTS_PER_MIN = 300;

function fail(reply: FastifyReply, f: UploadFail) {
  if (f.assembling) return reply.code(f.code).header('Retry-After', '3').send({ error: f.error, assembling: true });
  return reply.code(f.code).send(f.missing ? { error: f.error, missing: f.missing } : { error: f.error });
}

/** Пропуск памяти куска, взятый в `onRequest` (отдаётся при закрытии ответа или по окончании записи в хранилище). */
const tickets = new WeakMap<FastifyRequest, GateTicket>();

/**
 * Всё про кусок — ДО чтения тела (H1). Отказ — ответ сразу (`return reply` — Fastify дальше не идёт); тело не дочитывается
 * (Node сбрасывает остаток, не копя).
 */
async function admitPart(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const me = req.user!.sub;
  const parsed = partParams.safeParse(req.params);
  if (!parsed.success) return reply.code(400).send({ error: 'неверный адрес куска' });
  const { id: conversationId, uploadId, n } = parsed.data;
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/octet-stream'))
    return reply.code(415).send({ error: 'тело куска — application/octet-stream' });
  const lenHeader = req.headers['content-length'];
  const length = lenHeader !== undefined && /^\d+$/.test(lenHeader) ? Number(lenHeader) : NaN;
  if (!Number.isSafeInteger(length)) return reply.code(411).send({ error: 'нужен Content-Length куска' });
  if (length > BIGFILE_PART_BYTES) return reply.code(413).send({ error: 'кусок больше допустимого' });
  // Пропуск памяти — синхронно и первым: лавина параллельных запросов отбивается без похода в Redis и базу.
  const ticket = uploadGate.acquire(me, length);
  if ('code' in ticket) return reply.code(ticket.code).header('Retry-After', String(ticket.retryAfter)).send({ error: ticket.error });
  tickets.set(req, ticket);
  // Ответ закрыт (отдан или оборван) — место свободно (если кусок ещё пишется в хранилище — когда допишется, `track`).
  reply.raw.once('close', () => ticket.release());
  const wait = await rateHit(`upload-part:${me}`, PARTS_PER_MIN, 60);
  if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
  const target = await partTarget(me, conversationId, uploadId, n);
  if ('code' in target) return fail(reply, target);
  if (target.want !== length) return reply.code(400).send({ error: `кусок ${n}: ждали ${target.want} байт, заявлено ${length}` });
  return undefined;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Вход проверяется ДО разбора тела: кусок в 8 МиБ от чужого не дочитывается.
  app.addHook('onRequest', requireAuth);
  // Тело куска — сырые байты; предел — кусок с небольшим запасом (заголовки считаются отдельно).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: BIGFILE_PART_BYTES + 1024 }, (_req, body, done) =>
    done(null, body),
  );

  const ready = async (reply: FastifyReply): Promise<boolean> => {
    if ((privateAttachmentsReady() || (await attachmentStore.ensureReady())) && attachmentStore.multipart) return true;
    await reply.code(503).send({ error: 'Файлы в личных сообщениях сейчас недоступны: закрытое хранилище не готово' });
    return false;
  };

  app.post('/conv/:id/uploads', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId } = params.parse(req.params);
    const body = z
      .object({
        name: z.string().max(1000).optional().default('file'),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        type: z.string().max(200).optional(),
      })
      .parse(req.body);
    const access = await loadAccess(conversationId, me);
    if (!access) return reply.code(404).send({ error: 'not found' });
    // Э3 часть 1 (#141): в беседу с человеком соседа без `dm2` файлы не уходят (`conv.fedFilesRefused`), как у одиночной загрузки.
    if (await fedFilesRefused(reply, access.peerId)) return;
    if (!(await ready(reply))) return;
    const name = sanitizeFilename(body.name || 'file');
    const declared = body.type || 'application/octet-stream';
    if (attachmentBlocked(declared, name)) return reply.code(415).send({ error: 'этот тип файла запрещён (SVG/HTML)' });
    // Начало загрузки — та же частота, что одиночная загрузка (`attachmentUploadBlock`): одно начало = один файл.
    const wait = await attachmentUploadBlock(me);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
    const res = await startUpload({ ownerId: me, conversationId, name, declaredType: declared, size: body.size });
    if ('code' in res) return fail(reply, res);
    return reply.code(201).send({ uploadId: res.id, partSize: res.partSize, parts: res.parts, maxBytes: BIGFILE_MAX_BYTES });
  });

  app.put('/conv/:id/uploads/:uploadId/parts/:n', { bodyLimit: BIGFILE_PART_BYTES + 1024, onRequest: admitPart }, async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, uploadId, n } = partParams.parse(req.params);
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'тело куска — application/octet-stream' });
    if (!(await ready(reply))) return;
    const res = await uploadPart({ ownerId: me, conversationId, uploadId, n, bytes: req.body, track: tickets.get(req)?.track });
    if ('code' in res) return fail(reply, res);
    return res;
  });

  app.get('/conv/:id/uploads/:uploadId', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, uploadId } = uploadParams.parse(req.params);
    const st = await uploadStatus(me, conversationId, uploadId);
    if (!st) return reply.code(404).send({ error: 'загрузка не найдена' });
    return { uploadId: st.id, size: st.size, partSize: st.partSize, parts: st.parts, done: st.done };
  });

  app.post('/conv/:id/uploads/:uploadId/complete', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, uploadId } = uploadParams.parse(req.params);
    if (!(await ready(reply))) return;
    const res = await completeUpload(me, conversationId, uploadId);
    if ('code' in res) return fail(reply, res);
    return uploadedAttachmentDto(res, me);
  });

  app.delete('/conv/:id/uploads/:uploadId', async (req, reply) => {
    const me = req.user!.sub;
    const { id: conversationId, uploadId } = uploadParams.parse(req.params);
    await abortUpload(me, conversationId, uploadId);
    return reply.code(204).send();
  });
}
