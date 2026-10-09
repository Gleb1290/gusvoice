import {
  DM_FOLDER_CHATS_MAX,
  DM_FOLDER_EMOTICON_MAX,
  DM_FOLDER_PERSONAL,
  DM_FOLDER_PINNED_MAX,
  DM_FOLDERS_MAX,
  dmFolderInputError,
  dmFolderInputErrorText,
  dmFolderPinSlots,
  dmFolderPinToggled,
  normalizeDmFolderInput,
  reorderDmFolders,
  type DmFolder,
  type DmFolderInput,
  type DmFolderList,
} from '@gusvoice/shared';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { conversationMembers, dmFolders } from '../db/schema.js';
import { publishToUser } from '../realtime.js';
import { id as newId } from '../util.js';

/** Записей папок — 60 в минуту на человека (перетаскивание вкладок шлёт порядок на каждое отпускание). */
const WRITE_MAX = 60;
const WRITE_WINDOW_S = 60;

type Row = typeof dmFolders.$inferSelect;

function toDto(r: Row): DmFolder {
  const f: DmFolder = {
    id: r.id,
    title: r.system ? '' : r.title,
    emoticon: r.emoticon,
    flags: r.flags,
    include: r.includeIds,
    exclude: r.excludeIds,
  };
  // Свой порядок закреплённых (`pinorder2`) — только у своей папки и только непустой (старый клиент поле не знает).
  if (!r.system && r.pinnedIds.length > 0) f.pinned = r.pinnedIds;
  // Свой набор закреплённых (`pinset1`): `pinned` — набор, а не порядок общих. Старый клиент поле не знает и видит в папке общие.
  if (!r.system && r.pinnedOwn) f.pinnedOwn = true;
  if (r.system === 'dms') f.system = 'dms';
  return f;
}

/** Системная «Личные сообщения» — одна на человека; повторная вставка упирается в `dm_folders_system_uq`. */
async function ensureSystem(me: string): Promise<void> {
  await db
    .insert(dmFolders)
    .values({ id: newId(), userId: me, system: 'dms', flags: DM_FOLDER_PERSONAL, position: 0 })
    .onConflictDoNothing();
}

async function listOf(me: string): Promise<DmFolder[]> {
  const rows = await db
    .select()
    .from(dmFolders)
    .where(eq(dmFolders.userId, me))
    .orderBy(asc(dmFolders.position), asc(dmFolders.createdAt));
  return rows.map(toDto);
}

/** Список целиком — ответом и событием моим устройствам (второе устройство видит изменения сразу). */
async function sendList(me: string): Promise<DmFolderList> {
  const folders = await listOf(me);
  await publishToUser(me, { t: 'dmFolders.update', folders }).catch(() => {});
  return { folders };
}

/** Разослать список папок моим устройствам после записи не из этих ручек (закреп вычеркнул беседу из `pinned`, `pinorder2`). */
export async function publishDmFolders(me: string): Promise<void> {
  await sendList(me).catch(() => {});
}

/** Только мои беседы (как у Telegram: в папку попадают лишь чаты из списка); чужие и неизвестные id отбрасываются. */
async function ownChats(me: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.userId, me),
        inArray(conversationMembers.conversationId, ids),
        isNull(conversationMembers.leftAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Мои закреплённые беседы из `ids` (не покинутые) — для своего порядка папки (`pinorder2`). */
async function pinnedChats(me: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.userId, me),
        inArray(conversationMembers.conversationId, ids),
        isNull(conversationMembers.leftAt),
        isNotNull(conversationMembers.pinnedAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

const chatIds = z.array(z.string().min(1).max(64)).max(DM_FOLDER_CHATS_MAX);
const inputSchema = z.object({
  title: z.string().max(200),
  emoticon: z.string().max(DM_FOLDER_EMOTICON_MAX).nullable().optional(),
  flags: z.number().int().min(0).max(0xffff),
  include: chatIds,
  exclude: chatIds,
});

/** Проверка + чистка ввода; ошибка — 400 с текстом для человека и `reason`. */
async function cleanInput(me: string, body: unknown, reply: FastifyReply): Promise<DmFolderInput | null> {
  const input = normalizeDmFolderInput(inputSchema.parse(body));
  const own = await ownChats(me, [...input.include, ...input.exclude]);
  input.include = input.include.filter((x) => own.has(x));
  input.exclude = input.exclude.filter((x) => own.has(x));
  const err = dmFolderInputError(input);
  if (err) {
    await reply.code(400).send({ error: dmFolderInputErrorText(err), reason: `folders.${err}` });
    return null;
  }
  return input;
}

/** Замок записей набора закреплённых папок человека (`pinset1`): закреп с двух устройств не теряет второй и не превышает предел. */
async function lockFolderPins(tx: Pick<typeof db, 'execute'>, me: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dm-folder-pins:${me}`}))`);
}

/**
 * Папки бесед ЛС (07.10, #211, G40, решение владельца Р-8; признак `folders1`). Модель и правила — `shared/dmFolders.ts`.
 * Каждая запись отвечает списком целиком и шлёт его же событием `dmFolders.update` на все мои устройства.
 */
export async function dmFolderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const limited = async (reply: FastifyReply, me: string): Promise<boolean> => {
    const wait = await rateHit(`dm-folders:${me}`, WRITE_MAX, WRITE_WINDOW_S);
    if (!wait) return false;
    await reply.code(429).header('Retry-After', String(wait)).send({ error: retryMessage(wait) });
    return true;
  };

  /** Все мои папки по порядку; системная заводится при первом чтении. */
  app.get('/dm-folders', async (req): Promise<DmFolderList> => {
    const me = req.user!.sub;
    await ensureSystem(me);
    return { folders: await listOf(me) };
  });

  /** Новая папка — в конец; не больше `DM_FOLDERS_MAX` своих (системная не считается). */
  app.post('/dm-folders', async (req, reply) => {
    const me = req.user!.sub;
    if (await limited(reply, me)) return;
    const input = await cleanInput(me, req.body, reply);
    if (!input) return;
    await ensureSystem(me);
    const have = await listOf(me);
    if (have.filter((f) => !f.system).length >= DM_FOLDERS_MAX)
      return reply
        .code(400)
        .send({ error: `У вас уже ${DM_FOLDERS_MAX} папок — удалите ненужную`, reason: 'folders.limit', max: DM_FOLDERS_MAX });
    const fid = newId();
    // Клиент с `pinset1` заводит папку сразу со своим (пустым) набором закреплённых — как новая папка у Telegram.
    const own = z.object({ pinnedOwn: z.boolean().optional() }).safeParse(req.body);
    await db.insert(dmFolders).values({
      id: fid,
      userId: me,
      title: input.title,
      emoticon: input.emoticon ?? null,
      flags: input.flags,
      includeIds: input.include,
      excludeIds: input.exclude,
      pinnedOwn: own.success && own.data.pinnedOwn === true,
      position: have.length,
    });
    return { id: fid, ...(await sendList(me)) };
  });

  /** Изменить свою папку целиком; системную править нельзя (у Telegram «Все чаты» не редактируются). */
  app.put('/dm-folders/:id', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    if (await limited(reply, me)) return;
    const [row] = await db.select().from(dmFolders).where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
    if (!row) return reply.code(404).send({ error: 'папка не найдена' });
    if (row.system) return reply.code(400).send({ error: 'эту папку изменить нельзя', reason: 'folders.system' });
    const input = await cleanInput(me, req.body, reply);
    if (!input) return;
    /* Свой набор закреплённых (`pinset1`): исключённая или убранная из явно включённых беседа теряет и закреп в папке — у Telegram
       `pinned_peers` входят во «включённые», «Убрать из папки» снимает оба. Порядок старого смысла (`pinorder2`) не трогаем. */
    const pinnedIds = row.pinnedOwn
      ? row.pinnedIds.filter((x) => !input.exclude.includes(x) && !(row.includeIds.includes(x) && !input.include.includes(x)))
      : row.pinnedIds;
    await db
      .update(dmFolders)
      .set({
        title: input.title,
        emoticon: input.emoticon ?? null,
        flags: input.flags,
        includeIds: input.include,
        excludeIds: input.exclude,
        pinnedIds,
        updatedAt: new Date(),
      })
      .where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
    return sendList(me);
  });

  /** Удалить папку — беседы остаются (`lng_filters_remove_sure`); системную нельзя. */
  app.delete('/dm-folders/:id', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    if (await limited(reply, me)) return;
    const [row] = await db.select().from(dmFolders).where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
    if (!row) return reply.code(404).send({ error: 'папка не найдена' });
    if (row.system) return reply.code(400).send({ error: 'эту папку удалить нельзя', reason: 'folders.system' });
    await db.delete(dmFolders).where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
    return sendList(me);
  });

  /**
   * Свой порядок закреплённых в папке (09.10, признак `pinorder2`; Telegram — `pinned_peers` фильтра): `{ ids }` — закреплённые
   * беседы папки сверху вниз. Чужие, покинутые и незакреплённые id отбрасываются, повторы — тоже; у системной папки порядок
   * общий (`PUT /conv/pinned-order`) — 400 `folders.system`. Отвечает списком и шлёт его событием `dmFolders.update`.
   */
  app.put('/dm-folders/:id/pinned-order', async (req, reply) => {
    const me = req.user!.sub;
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const { ids } = z.object({ ids: chatIds }).parse(req.body);
    if (await limited(reply, me)) return;
    const [row] = await db.select().from(dmFolders).where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
    if (!row) return reply.code(404).send({ error: 'папка не найдена' });
    if (row.system) return reply.code(400).send({ error: 'у этой папки общий порядок', reason: 'folders.system' });
    if (row.pinnedOwn) {
      /* Свой набор (`pinset1`): только перестановка внутри набора (`dmFolderPinSlots`) — набор не меняется. Старый клиент шлёт сюда
         общие закреплённые папки: члены набора среди них меняются местами, остальное не действует. */
      await db.transaction(async (tx) => {
        await lockFolderPins(tx, me);
        const [cur] = await tx
          .select({ pinnedIds: dmFolders.pinnedIds })
          .from(dmFolders)
          .where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
        if (!cur) return;
        const next = dmFolderPinSlots(cur.pinnedIds, ids);
        if (next.every((x, i) => x === cur.pinnedIds[i])) return;
        await tx
          .update(dmFolders)
          .set({ pinnedIds: next, updatedAt: new Date() })
          .where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
      });
      return sendList(me);
    }
    const pinned = await pinnedChats(me, ids);
    const order = [...new Set(ids)].filter((x) => pinned.has(x));
    await db
      .update(dmFolders)
      .set({ pinnedIds: order, updatedAt: new Date() })
      .where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
    return sendList(me);
  });

  /**
   * Перевести папки на свой набор закреплённых (09.10, признак `pinset1`): `{ folders: [{ id, ids }] }`, `ids` — что сейчас видно
   * закреплённым в папке сверху вниз (клиент считает по правилам, заглушке и непрочитанному). В набор идут только мои общие
   * закреплённые (не покинутые) — перевод ничего не закрепляет заново; повторы отбрасываются, не больше `DM_FOLDER_PINNED_MAX`.
   * Уже переведённая (другим устройством), системная и чужая папка не трогаются. Отвечает списком и шлёт его событием.
   */
  app.post('/dm-folders/pinned-own', async (req, reply) => {
    const me = req.user!.sub;
    const { folders } = z
      .object({ folders: z.array(z.object({ id: z.string().min(1).max(64), ids: chatIds })).max(DM_FOLDERS_MAX + 1) })
      .parse(req.body);
    if (await limited(reply, me)) return;
    const pinned = await pinnedChats(me, folders.flatMap((f) => f.ids));
    await db.transaction(async (tx) => {
      await lockFolderPins(tx, me);
      for (const f of folders) {
        const set = [...new Set(f.ids)].filter((x) => pinned.has(x)).slice(0, DM_FOLDER_PINNED_MAX);
        await tx
          .update(dmFolders)
          .set({ pinnedOwn: true, pinnedIds: set, updatedAt: new Date() })
          .where(and(eq(dmFolders.id, f.id), eq(dmFolders.userId, me), isNull(dmFolders.system), eq(dmFolders.pinnedOwn, false)));
      }
    });
    return sendList(me);
  });

  /**
   * Закрепить / открепить беседу только в этой папке (09.10, признак `pinset1`; Telegram — `toggleDialogFilterPin`): `{ pinned }`.
   * Новый закреп — сверху набора; закреп снимает исключение беседы (иначе её не видно). Папка без своего набора — 409
   * `folders.pin_mode` (клиент сначала переводит её), больше `DM_FOLDER_PINNED_MAX` — 409 `folders.pin_limit` с `max`, не моя
   * беседа — 404. Общий закреп (`pinned_at`) не меняется. Отвечает списком и шлёт его событием `dmFolders.update`.
   */
  app.put('/dm-folders/:id/pinned/:convId', async (req, reply) => {
    const me = req.user!.sub;
    const { id, convId } = z.object({ id: z.string().min(1).max(64), convId: z.string().min(1).max(64) }).parse(req.params);
    const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);
    if (await limited(reply, me)) return;
    const out = await db.transaction(async (tx): Promise<'ok' | 'folder' | 'system' | 'mode' | 'chat' | 'limit'> => {
      await lockFolderPins(tx, me);
      const [row] = await tx.select().from(dmFolders).where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
      if (!row) return 'folder';
      if (row.system) return 'system';
      if (!row.pinnedOwn) return 'mode';
      // Покинутые и чужие из набора выпадают здесь же (их не видно, а место в пределе они занимали бы).
      const live = await ownChats(me, [...row.pinnedIds, convId]);
      if (pinned && !live.has(convId)) return 'chat';
      const set = row.pinnedIds.filter((x) => live.has(x));
      if (pinned && !set.includes(convId) && set.length >= DM_FOLDER_PINNED_MAX) return 'limit';
      const next = dmFolderPinToggled(set, convId, pinned);
      const exclude = pinned ? row.excludeIds.filter((x) => x !== convId) : row.excludeIds;
      const same =
        next.length === row.pinnedIds.length && next.every((x, i) => x === row.pinnedIds[i]) && exclude.length === row.excludeIds.length;
      if (same) return 'ok';
      await tx
        .update(dmFolders)
        .set({ pinnedIds: next, excludeIds: exclude, updatedAt: new Date() })
        .where(and(eq(dmFolders.id, id), eq(dmFolders.userId, me)));
      return 'ok';
    });
    if (out === 'folder') return reply.code(404).send({ error: 'папка не найдена' });
    if (out === 'system') return reply.code(400).send({ error: 'у этой папки общий закреп', reason: 'folders.system' });
    if (out === 'mode') return reply.code(409).send({ error: 'у папки общий закреп', reason: 'folders.pin_mode' });
    if (out === 'chat') return reply.code(404).send({ error: 'беседа не найдена' });
    if (out === 'limit')
      return reply.code(409).send({
        error: `В папке можно закрепить не больше ${DM_FOLDER_PINNED_MAX} бесед`,
        reason: 'folders.pin_limit',
        max: DM_FOLDER_PINNED_MAX,
      });
    return sendList(me);
  });

  /** Новый порядок — перестановка всех текущих (вместе с системной); иначе 409, клиент перечитает список. */
  app.put('/dm-folders/order', async (req, reply) => {
    const me = req.user!.sub;
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(64)).max(DM_FOLDERS_MAX + 1) }).parse(req.body);
    if (await limited(reply, me)) return;
    await ensureSystem(me);
    const order = reorderDmFolders(
      (await listOf(me)).map((f) => f.id),
      ids,
    );
    if (!order) return reply.code(409).send({ error: 'список папок изменился — обновите его' });
    await db.transaction(async (tx) => {
      for (const [i, fid] of order.entries())
        await tx
          .update(dmFolders)
          .set({ position: i })
          .where(and(eq(dmFolders.id, fid), eq(dmFolders.userId, me)));
    });
    return sendList(me);
  });
}
