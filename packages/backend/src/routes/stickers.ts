import {
  checkUserPackQuota,
  MY_STICKER_PACKS_MAX,
  parseStickerSetName,
  reorderStickerPacks,
  STICKER_PACKS_PER_USER,
  stickerPackMatches,
  type StickerCatalog,
} from '@gusvoice/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { stickerPacks, userStickerPacks } from '../db/schema.js';
import {
  addToMine,
  anyPackByName,
  catalogDto,
  catalogPackById,
  catalogPackByName,
  catalogPackOfSticker,
  catalogUploadedBy,
  downloadTelegramPack,
  ensureCatalogCopy,
  mineIds,
  packStickerData,
  stickerCounts,
  stickersOf,
  type PackRow,
} from '../stickerCatalog.js';
import {
  catalogStickerFor,
  clearRecent,
  publishMineChanged,
  publishStickerLists,
  pushRecent,
  setFaved,
  stickerListsOf,
} from '../stickerLists.js';
import { asUserId } from '../superAdminRules.js';
import { telegramConfigured } from '../telegram.js';

/** Сколько наборов отдаёт каталог за раз и сколько стикеров-обложек у каждого (ряд превью, как в «Популярных» Telegram). */
const CATALOG_MAX = 500;
const CATALOG_PREVIEW = 5;
/** Загрузок из Telegram — 5 в минуту на человека: каждая качает до 120 файлов. */
const IMPORT_MAX = 5;
const IMPORT_WINDOW_S = 60;
/** Правок «моих наборов» (добавить, убрать, порядок) — 60 за 10 с. */
const MINE_MAX = 60;
const MINE_WINDOW_S = 10;

async function limited(reply: FastifyReply, key: string, max: number, windowS: number): Promise<boolean> {
  const wait = await rateHit(key, max, windowS);
  if (!wait) return false;
  await reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
  return true;
}

const canDelete = (p: PackRow, me: string) => p.createdBy === me || isSuperAdmin(asUserId(me));

/**
 * Стикеры в ЛС (С2, #211, признак `stickers2`): общий каталог наборов инстанса и «мои наборы». Описание ручек —
 * `FEATURE_STICKERS2` (`packages/shared/src/ws.ts`), модель — `stickerCatalog.ts`.
 */
export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Мои наборы целиком, в моём порядке — это и есть панель стикеров ЛС. */
  app.get('/stickers/mine', async (req) => {
    const me = req.user!.sub;
    const ids = await mineIds(me);
    if (!ids.length) return { packs: [] };
    const rows = await db
      .select()
      .from(stickerPacks)
      .where(and(isNull(stickerPacks.serverId), inArray(stickerPacks.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lists = await stickersOf(ids);
    return {
      packs: ids
        .map((pid) => byId.get(pid))
        .filter((p): p is PackRow => !!p)
        .map((p) => {
          const list = lists.get(p.id) ?? [];
          return catalogDto(p, list, list.length, true, canDelete(p, me));
        }),
    };
  });

  /** Каталог инстанса: новые сверху, поиск по названию и имени (`?q=`). */
  app.get('/stickers/catalog', async (req): Promise<StickerCatalog> => {
    const me = req.user!.sub;
    const { q } = z.object({ q: z.string().max(64).optional() }).parse(req.query);
    const all = await db
      .select()
      .from(stickerPacks)
      .where(isNull(stickerPacks.serverId))
      .orderBy(desc(stickerPacks.createdAt));
    const hits = all.filter((p) => stickerPackMatches(p, q ?? '')).slice(0, CATALOG_MAX);
    const ids = hits.map((p) => p.id);
    const [mine, previews, counts, uploaded] = await Promise.all([
      mineIds(me),
      stickersOf(ids, CATALOG_PREVIEW),
      stickerCounts(ids),
      catalogUploadedBy(me),
    ]);
    const mineSet = new Set(mine);
    return {
      packs: hits.map((p) => catalogDto(p, previews.get(p.id) ?? [], counts.get(p.id) ?? 0, mineSet.has(p.id), canDelete(p, me))),
      uploaded,
      uploadLimit: STICKER_PACKS_PER_USER,
      importEnabled: telegramConfigured(),
    };
  });

  /** Набор каталога целиком — окно «Набор стикеров» с кнопкой «Добавить N стикеров». */
  app.get('/stickers/packs/:id', async (req, reply) => {
    const me = req.user!.sub;
    const { id: packId } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const p = await catalogPackById(packId);
    if (!p) return reply.code(404).send({ error: 'набор не найден' });
    const list = (await stickersOf([p.id])).get(p.id) ?? [];
    return catalogDto(p, list, list.length, (await mineIds(me)).includes(p.id), canDelete(p, me));
  });

  /** Набор, из которого полученный стикер: `?id=` стикера в сообщении и/или `?url=` его картинки. */
  app.get('/stickers/lookup', async (req, reply) => {
    const me = req.user!.sub;
    const q = z.object({ id: z.string().min(1).max(64).optional(), url: z.string().min(1).max(2048).optional() }).parse(req.query);
    if (!q.id && !q.url) return reply.code(400).send({ error: 'нужен id или url стикера' });
    const p = await catalogPackOfSticker(q.id ?? null, q.url ?? null);
    if (!p) return reply.code(404).send({ error: 'набора этого стикера нет в каталоге' });
    const list = (await stickersOf([p.id])).get(p.id) ?? [];
    return catalogDto(p, list, list.length, (await mineIds(me)).includes(p.id), canDelete(p, me));
  });

  /**
   * Загрузить набор себе (`{ name }` — ссылка `t.me/addstickers/…` или имя). Уже в каталоге — просто встаёт в «мои»
   * (ничего не качается, предел не тратится); лежит только на каком-то сервере — копия его файлов; иначе качается из
   * Telegram. Привезти в каталог можно не больше `STICKER_PACKS_PER_USER` наборов — 41-й получает 400 с `reason`.
   */
  app.post('/stickers/packs', async (req, reply) => {
    const me = req.user!.sub;
    const { name: rawName } = z.object({ name: z.string().max(256) }).parse(req.body);
    const parsed = parseStickerSetName(rawName);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const ready = await catalogPackByName(parsed.name);
    if (ready) {
      await addToMine(me, ready.id);
      void publishMineChanged(me);
      const list = (await stickersOf([ready.id])).get(ready.id) ?? [];
      return reply.code(200).send({ ...catalogDto(ready, list, list.length, true, canDelete(ready, me)), reused: true });
    }
    if (await limited(reply, `stickers-import:${me}`, IMPORT_MAX, IMPORT_WINDOW_S)) return;
    const quota = checkUserPackQuota(await catalogUploadedBy(me));
    if (!quota.ok) return reply.code(400).send({ error: quota.error, reason: 'stickers.quota', limit: STICKER_PACKS_PER_USER });

    let title: string;
    let rows;
    let skipped = 0;
    const onServer = await anyPackByName(parsed.name);
    if (onServer) {
      title = onServer.title;
      rows = await packStickerData(onServer.id);
    } else {
      if (!telegramConfigured()) return reply.code(503).send({ error: 'загрузка стикеров из Telegram не настроена на этом инстансе' });
      const got = await downloadTelegramPack(parsed.name, 0);
      if (!got.ok) return reply.code(got.status).send({ error: got.error });
      title = got.title;
      rows = got.rows;
      skipped = got.skipped;
    }
    const { pack } = await ensureCatalogCopy({ name: parsed.name, title, createdBy: me }, rows);
    await addToMine(me, pack.id);
    void publishMineChanged(me);
    const list = (await stickersOf([pack.id])).get(pack.id) ?? [];
    return reply.code(201).send({ ...catalogDto(pack, list, list.length, true, canDelete(pack, me)), reused: false, skipped });
  });

  /** Убрать набор из каталога: загрузивший или админ инстанса. Отправленные стикеры остаются (лежат копией). */
  app.delete('/stickers/packs/:id', async (req, reply) => {
    const me = req.user!.sub;
    const { id: packId } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const p = await catalogPackById(packId);
    if (!p) return reply.code(404).send({ error: 'набор не найден' });
    if (!canDelete(p, me)) return reply.code(403).send({ error: 'убрать набор может только загрузивший его или админ инстанса' });
    await db.delete(stickerPacks).where(and(eq(stickerPacks.id, p.id), isNull(stickerPacks.serverId)));
    return reply.code(204).send();
  });

  /** Добавить набор каталога в «мои» (первым). */
  app.put('/stickers/mine/:packId', async (req, reply) => {
    const me = req.user!.sub;
    const { packId } = z.object({ packId: z.string().min(1).max(64) }).parse(req.params);
    if (await limited(reply, `stickers-mine:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    const p = await catalogPackById(packId);
    if (!p) return reply.code(404).send({ error: 'набор не найден' });
    const have = await mineIds(me);
    if (!have.includes(p.id) && have.length >= MY_STICKER_PACKS_MAX)
      return reply.code(400).send({ error: `У вас уже ${MY_STICKER_PACKS_MAX} наборов — уберите ненужные`, reason: 'stickers.mine_full' });
    await addToMine(me, p.id);
    void publishMineChanged(me);
    return reply.code(204).send();
  });

  /** Убрать набор из «моих» (из каталога он не уходит). */
  app.delete('/stickers/mine/:packId', async (req, reply) => {
    const me = req.user!.sub;
    const { packId } = z.object({ packId: z.string().min(1).max(64) }).parse(req.params);
    if (await limited(reply, `stickers-mine:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    await db.delete(userStickerPacks).where(and(eq(userStickerPacks.userId, me), eq(userStickerPacks.packId, packId)));
    void publishMineChanged(me);
    return reply.code(204).send();
  });

  /** Новый порядок «моих» — перестановка всех текущих; иначе 409 (клиент перечитает список). */
  app.put('/stickers/mine', async (req, reply) => {
    const me = req.user!.sub;
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(64)).max(MY_STICKER_PACKS_MAX) }).parse(req.body);
    if (await limited(reply, `stickers-mine:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    const order = reorderStickerPacks(await mineIds(me), ids);
    if (!order) return reply.code(409).send({ error: 'список наборов изменился — обновите его' });
    await db.transaction(async (tx) => {
      for (const [i, pid] of order.entries())
        await tx
          .update(userStickerPacks)
          .set({ position: i })
          .where(and(eq(userStickerPacks.userId, me), eq(userStickerPacks.packId, pid)));
    });
    void publishMineChanged(me);
    return reply.code(204).send();
  });

  /**
   * Избранные и недавние (С2 порция 2, признак `stickers3`, миграция 0100) — общие для всех моих устройств, как у Telegram.
   * Каждая правка отвечает списками целиком и шлёт их событием `stickers.update` моим устройствам (`stickerLists.ts`).
   */
  app.get('/stickers/lists', async (req) => stickerListsOf(req.user!.sub));

  const stickerRef = z.object({ id: z.string().min(1).max(64) });
  const urlQuery = z.object({ url: z.string().min(1).max(2048).optional() });

  /** В избранное: стикер каталога по id, стикер набора сервера — по картинке (`?url=`); шестой вытесняет старый. */
  app.put('/stickers/faved/:id', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = stickerRef.parse(req.params);
    const { url } = urlQuery.parse(req.query);
    if (await limited(reply, `stickers-mine:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    const s = await catalogStickerFor(id, url ?? null);
    if (!s) return reply.code(404).send({ error: 'этого стикера нет в каталоге' });
    await setFaved(me, s.id, true);
    const lists = await stickerListsOf(me);
    void publishStickerLists(me, lists);
    return lists;
  });

  /** Из избранного. Нет такого — ответ тот же (списки как есть). */
  app.delete('/stickers/faved/:id', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = stickerRef.parse(req.params);
    const { url } = urlQuery.parse(req.query);
    if (await limited(reply, `stickers-mine:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    const s = await catalogStickerFor(id, url ?? null);
    await setFaved(me, s?.id ?? id, false);
    const lists = await stickerListsOf(me);
    void publishStickerLists(me, lists);
    return lists;
  });

  /** Стикер отправлен — первым в недавние (зовёт клиент после отправки, и в беседу, и в канал). */
  app.post('/stickers/recent', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = stickerRef.parse(req.body);
    const { url } = urlQuery.parse(req.query);
    if (await limited(reply, `stickers-recent:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    const s = await catalogStickerFor(id, url ?? null);
    if (!s) return reply.code(404).send({ error: 'этого стикера нет в каталоге' });
    await pushRecent(me, s.id);
    const lists = await stickerListsOf(me);
    void publishStickerLists(me, lists);
    return lists;
  });

  /** «Очистить недавние» (как пункт Telegram). */
  app.delete('/stickers/recent', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, `stickers-recent:${me}`, MINE_MAX, MINE_WINDOW_S)) return;
    await clearRecent(me);
    const lists = await stickerListsOf(me);
    void publishStickerLists(me, lists);
    return lists;
  });
}
