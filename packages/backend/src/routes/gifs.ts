/**
 * Ручки «Моих GIF» и внешнего поиска (Р-7, #211, признак `gifs1`). Логика — `gifs.ts`, правила — `gifRules.ts`.
 * Поиск — только если инстанс задал `GIF_PROVIDER` + `GIF_API_KEY`: запросы к поставщику идут отсюда, ключ клиенту не
 * отдаётся; файл в беседу сервер скачивает сам и только с медиа-хоста поставщика (`gifMediaUrlAllowed`).
 */
import type { ExternalGifsResponse, SavedGifsResponse } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { clientIp, rateHit, retryMessage } from '../authGuard.js';
import { attachmentHeaders, attPartsWellFormed, parseRange } from '../attachmentRules.js';
import { attachmentStore, gifSigValid, privateAttachmentsReady } from '../attachments.js';
import { loadAccess } from '../conversations.js';
import { db } from '../db/index.js';
import { fedFilesRefused } from './conv.js';
import { users } from '../db/schema.js';
import { env } from '../env.js';
import { GIF_MAX_BYTES, GIFS_SAVED_MAX, gifMediaUrlAllowed, gifProviderOf, gifSearchUrl, parseGifSearch } from '../gifRules.js';
import { announceGifs, attachExternalBytes, attachSavedGif, deleteGif, gifOf, listGifs, saveGifBytes, saveGifFromAttachment } from '../gifs.js';

const provider = () => gifProviderOf(env.gifProvider, env.gifApiKey);

const idParam = z.object({ id: z.string().uuid() });

async function limited(reply: FastifyReply, key: string, max: number, windowS: number): Promise<boolean> {
  const wait = await rateHit(key, max, windowS);
  if (!wait) return false;
  await reply.code(429).send({ error: retryMessage(wait) });
  return true;
}

/** Скачать файл поставщика с пределом размера (поток обрывается на превышении). */
async function fetchCapped(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok || !res.body) return null;
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'video/mp4') return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += c.length;
    if (total > GIF_MAX_BYTES) return null;
    chunks.push(Buffer.from(c));
  }
  return { bytes: Buffer.concat(chunks), contentType };
}

/** Файл «Моего GIF» по подписанной ссылке — без входа (как `/att/...`): `<video src>` заголовков не шлёт. */
/** Беседа с человеком соседа, чей инстанс не умеет вложения (`dm2`): 400 отправлен — `true`. Чужая беседа — дальше, там 404. */
async function gifToFedRefused(reply: FastifyReply, me: string, conversationId: string): Promise<boolean> {
  const access = await loadAccess(conversationId, me);
  return !!access && (await fedFilesRefused(reply, access.peerId));
}

export async function gifFileRoutes(app: FastifyInstance): Promise<void> {
  const path = '/gifs/:id/:viewer/:sig';
  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, viewer, sig } = req.params as { id: string; viewer: string; sig: string };
    const deny = () => reply.header('Cache-Control', 'no-store').code(404).send({ error: 'not found' });
    const wait = await rateHit(`gif-ip:${clientIp(req)}`, 1200, 60);
    if (wait) return reply.header('Retry-After', String(wait)).code(429).send({ error: retryMessage(wait) });
    if (!attPartsWellFormed(id, viewer, sig) || !attachmentStore.configured()) return deny();
    const [user] = await db.select({ gen: users.tokenGeneration, deletedAt: users.deletedAt }).from(users).where(eq(users.id, viewer)).limit(1);
    if (!user || user.deletedAt || !gifSigValid(id, viewer, user.gen, sig)) return deny();
    const gif = await gifOf(viewer, id);
    if (!gif) return deny();
    const headers = attachmentHeaders(gif.contentType, 'GIF', gif.id);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === headers.ETag)) {
      return reply.code(304).headers({ ETag: headers.ETag, 'Cache-Control': headers['Cache-Control'] }).send();
    }
    const st = await attachmentStore.stat(gif.storageKey);
    if (!st) return deny();
    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      return reply.code(416).headers({ 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' }).send();
    }
    reply.headers(headers);
    if (range) {
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`).header('Content-Length', String(range.end - range.start + 1));
    } else {
      reply.header('Content-Length', String(st.size));
    }
    if (req.method === 'HEAD') return reply.send();
    return reply.send(await attachmentStore.get(gif.storageKey, range ?? undefined));
  };
  app.get(path, { exposeHeadRoute: false }, serve);
  app.head(path, serve);
}

export async function gifRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // «Мои GIF», новые первыми + предел и есть ли поиск. Второе устройство берёт список отсюда при открытии вкладки.
  app.get('/gifs', async (req): Promise<SavedGifsResponse> => {
    return { gifs: await listGifs(req.user!.sub), limit: GIFS_SAVED_MAX, search: provider() !== null };
  });

  // «Сохранить GIF» из ленты (меню видео/GIF): вложение беседы, где я участник.
  app.post('/gifs', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, `gif-save:${me}`, 30, 60)) return reply;
    const body = z
      .object({
        attachmentId: z.string().uuid(),
        width: z.number().int().positive().max(20_000).nullish(),
        height: z.number().int().positive().max(20_000).nullish(),
        durationMs: z.number().int().positive().max(3_600_000).nullish(),
      })
      .parse(req.body);
    if (!privateAttachmentsReady()) return reply.code(503).send({ error: 'Файлы в личных сообщениях сейчас недоступны' });
    const res = await saveGifFromAttachment(me, body.attachmentId, body);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    if (res.kind === 'bad-type') return reply.code(400).send({ error: 'Это не GIF' });
    // 08.10 (`groups3`): список — на остальные мои устройства.
    void announceGifs(me);
    return reply.code(201).send(res.gif);
  });

  app.delete('/gifs/:id', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, `gif-save:${me}`, 30, 60)) return reply;
    const { id } = idParam.parse(req.params);
    if (!(await deleteGif(me, id))) return reply.code(404).send({ error: 'not found' });
    void announceGifs(me);
    return reply.code(204).send();
  });

  // Отправить «Мой GIF»: копия — незавершённое вложение беседы; клиент шлёт обычное сообщение с ним (`gif: true`).
  app.post('/gifs/:id/attach', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, `gif-attach:${me}`, 30, 60)) return reply;
    const { id } = idParam.parse(req.params);
    const { conversationId } = z.object({ conversationId: z.string().min(1).max(64) }).parse(req.body);
    if (!privateAttachmentsReady()) return reply.code(503).send({ error: 'Файлы в личных сообщениях сейчас недоступны' });
    // Э3 часть 1 (#141): GIF в беседу с человеком соседа без `dm2` — отказ, как у загрузки (`conv.fedFilesRefused`).
    if (await gifToFedRefused(reply, me, conversationId)) return reply;
    const res = await attachSavedGif(me, id, conversationId);
    if (res.kind === 'not-found') return reply.code(404).send({ error: 'not found' });
    return reply.code(201).send(res);
  });

  // Внешний поиск (только при ключе поставщика): пустой запрос — популярное.
  app.get('/gifs/search', async (req, reply): Promise<ExternalGifsResponse | FastifyReply> => {
    const me = req.user!.sub;
    const p = provider();
    if (!p) return reply.code(404).send({ error: 'Поиск GIF на этом сервере не настроен' });
    if (await limited(reply, `gif-search:${me}`, 60, 60)) return reply;
    const q = z.object({ q: z.string().max(100).optional().default(''), pos: z.string().max(64).optional() }).parse(req.query);
    try {
      const res = await fetch(gifSearchUrl(p, env.gifApiKey, q.q, q.pos ?? null), { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return reply.code(502).send({ error: 'Поиск GIF не ответил' });
      return parseGifSearch(p, await res.json(), q.pos ?? null);
    } catch {
      return reply.code(502).send({ error: 'Поиск GIF не ответил' });
    }
  });

  // Отправить найденный GIF: сервер скачивает mp4 с медиа-хоста поставщика, кладёт вложением беседы и в «Мои GIF».
  app.post('/gifs/external/attach', async (req, reply) => {
    const me = req.user!.sub;
    const p = provider();
    if (!p) return reply.code(404).send({ error: 'Поиск GIF на этом сервере не настроен' });
    if (await limited(reply, `gif-attach:${me}`, 30, 60)) return reply;
    const body = z
      .object({
        conversationId: z.string().min(1).max(64),
        url: z.string().max(2048),
        width: z.number().int().positive().max(20_000).nullish(),
        height: z.number().int().positive().max(20_000).nullish(),
      })
      .parse(req.body);
    if (!gifMediaUrlAllowed(p, body.url)) return reply.code(400).send({ error: 'Чужой адрес' });
    if (!privateAttachmentsReady()) return reply.code(503).send({ error: 'Файлы в личных сообщениях сейчас недоступны' });
    if (await gifToFedRefused(reply, me, body.conversationId)) return reply;
    const file = await fetchCapped(body.url).catch(() => null);
    if (!file) return reply.code(502).send({ error: 'GIF не скачался' });
    const attachmentId = await attachExternalBytes(me, body.conversationId, file.contentType, file.bytes);
    if (!attachmentId) return reply.code(404).send({ error: 'not found' });
    if (await saveGifBytes(me, `url:${body.url}`, file.contentType, file.bytes, body).then(() => true, () => false)) void announceGifs(me);
    return reply.code(201).send({ attachmentId, contentType: file.contentType, width: body.width ?? null, height: body.height ?? null, durationMs: null });
  });
}
