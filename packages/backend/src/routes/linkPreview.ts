import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { getLinkPreview } from '../linkPreview.js';

/**
 * Предпросмотр ссылок (#64). Только для залогиненных: незакрытый эндпоинт, который по запросу
 * ходит наружу, — это открытый прокси, которым воспользуется кто угодно и с нашего адреса.
 *
 * Ограничение частоты — на пользователя, а не на IP: за NPM все запросы приходят с одного адреса,
 * и лимит по IP резал бы всех разом. Счётчик в памяти, потому что переживать перезапуск ему незачем.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { n: number; until: number }>();

function overLimit(userId: string): boolean {
  const now = Date.now();
  const cur = hits.get(userId);
  if (!cur || now > cur.until) {
    hits.set(userId, { n: 1, until: now + WINDOW_MS });
    return false;
  }
  cur.n += 1;
  return cur.n > MAX_PER_WINDOW;
}

// Раз в час выкидываем протухшие счётчики, иначе карта растёт на каждого, кто хоть раз кинул ссылку.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.until) hits.delete(k);
}, 3600_000).unref();

const query = z.object({ url: z.string().min(8).max(2048) });

export async function linkPreviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/link-preview', async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'нужен параметр url' });
    const userId = req.user!.sub;
    if (overLimit(userId)) return reply.code(429).send({ error: 'слишком часто' });

    const preview = await getLinkPreview(parsed.data.url);
    // 204 — «карточки нет и не будет»: страница не отдала ни заголовка, ни описания, либо цель
    // отбита фильтром. Клиенту различать эти случаи незачем, а нам незачем рассказывать, что
    // именно не так с адресом.
    if (!preview) return reply.code(204).send();
    return preview;
  });
}
