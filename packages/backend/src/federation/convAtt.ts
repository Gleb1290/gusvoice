/**
 * ЛС между инстансами, этап Э3 часть 1 (12.10, #141, docs/dm/FEDERATION.md §3.5, Ф3 — гибрид): вложения.
 *
 * - Можно ли файлы в беседу с человеком соседа: связка с его домом объявила `dm2` (`fedFilesAllowedFor` — крючок
 *   `routes/conv.ts` `configureFedFilesGuard`; `homesWithoutFiles` — поле сводки `fedNoFiles`). Нет признака — визитка перечитывается не чаще раза
 *   в час (`directorySync.refreshCapabilities`, общий с проверкой `dm1`).
 * - Отдача соседу: `fedAttachmentForPeer` — файл НАШЕГО человека (оригинал, не копия), прикреплён, сообщение не надгробие,
 *   в беседе есть участник спрашивающего инстанса (маршрут `GET /fed/v1/att/:id`, `routes/fedAtt.ts`).
 * - Приём: `remoteAttachmentsFor` — строки `attachments` в состоянии `remote` для копии сообщения (`convAccept.applyMessage`);
 *   `kickAttCopies` / `startAttCopies` — копия файлов до 25 МБ в наш закрытый бакет: подписанный GET соседа, размер сверяется
 *   с проводом, затем `attached` + сообщение без `fedState` и `conv.change` своим людям (тем же путём, что правка копии).
 *   Сосед лежит или ответил сбоем — повтор позже (пауза по дому растёт до 10 мин, такт раз в минуту), строка не теряется.
 * - Часть 2 (12.10): больше 25 МБ — по первому открытию (`serveRemoteAttachment`: поток с соседа смотрящему с его `Range`,
 *   и фоновая полная копия кусками S3 multipart — `startBigCopy`); в сообщении такие с приёма — `fedState: 'remote'`.
 *   Квота по связке (`federation_links.quota_bytes/used_bytes`, общая с файлами гостей `guestQuota.ts`): копия занимает место
 *   ДО записи (`reserveLinkQuota`), сбой — возврат; стёртая копия возвращает место триггером базы (миграция 0138) — по всем
 *   путям удаления сразу. Нет места — копии нет, файл отдаётся только потоком, пока дом автора на связи (у файла ≤ 25 МБ
 *   в сообщении `copying` → `remote`). Дом недоступен, копии нет — `unavailable` (`/api/att` → 503 `federation.att_unavailable`).
 */
import { FED_FEATURES, type Attachment, type FedConvAttachmentWire } from '@gusvoice/shared';
import type { Readable } from 'node:stream';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { BIGFILE_PART_BYTES } from '../attachmentRules.js';
import { attachmentStore, purgeDeleted } from '../attachments.js';
import { deliver, journal, lockConversation, msgEntries, storedAttachment } from '../conversations.js';
import { changeAudience } from '../convRules.js';
import { db } from '../db/index.js';
import { attachments, conversationMembers, conversationMessages, federationLinks, users } from '../db/schema.js';
import { PEER_MAX_ATT_BYTES } from '../safeFetch.js';
import { refreshCapabilities } from './directorySync.js';
import { federation } from './instance.js';
import { releaseLinkQuota, reserveLinkQuota } from './guestQuota.js';
import { getSignedFromPeer } from './peerClient.js';
import { streamSignedFromPeer } from './peerStream.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Q = Pick<typeof db, 'select'>;
type AttachmentRow = typeof attachments.$inferSelect;

/** Порог гибрида (Ф3): до него копия сразу при приёме, больше — по первому открытию (часть 2). */
export const FED_ATT_COPY_MAX = PEER_MAX_ATT_BYTES;
const COPY_EVERY_MS = 60_000;
const COPY_BATCH = 20;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

// ─── Можно ли файлы ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Из этих инстансов — те, чья связка не объявила `dm2` (или строки связки нет): в сводке беседы — `fedNoFiles`.
 * Без признака визитка перечитывается в фоне (не чаще раза в час) — следующая сводка уже честная. `q` — транзакция списка.
 */
export async function homesWithoutFiles(homes: readonly string[], q: Q = db): Promise<Set<string>> {
  const uniq = [...new Set(homes)];
  if (uniq.length === 0) return new Set();
  const rows = await q
    .select({ instanceId: federationLinks.instanceId, apiBase: federationLinks.apiBase, features: federationLinks.features })
    .from(federationLinks)
    .where(inArray(federationLinks.instanceId, uniq));
  const byId = new Map(rows.map((r) => [r.instanceId, r]));
  const out = new Set<string>();
  for (const h of uniq) {
    const link = byId.get(h);
    if (link?.features.includes(FED_FEATURES.dm2)) continue;
    out.add(h);
    if (link) void refreshCapabilities(link, Date.now()).catch(() => {});
  }
  return out;
}

/** Крючок записи (`routes/conv.configureFedFilesGuard`): файлы человеку `peerId` можно (местный или его дом с `dm2`). */
export async function fedFilesAllowedFor(peerId: string): Promise<boolean> {
  return peerHomeHas(peerId, FED_FEATURES.dm2);
}

/** Крючок записи (`routes/conv.configureFedOnceGuard`, Э3 часть 3): «один раз» человеку `peerId` — его дом объявил `dm2once`. */
export async function fedOnceAllowedFor(peerId: string, media = false): Promise<boolean> {
  // #226: одноразовое фото/видео (`media`) — только дому с `dm2ttl` (старый с одним `dm2once` показал бы его обычным навсегда).
  return peerHomeHas(peerId, media ? FED_FEATURES.dm2ttl : FED_FEATURES.dm2once);
}

/**
 * Крючок записи (`routes/conv.configureFedAlbumGuard`, G56): убрать один элемент альбома «у обоих» в беседе с `memberIds` можно,
 * если дом КАЖДОГО человека соседа объявил `dmalbum1` (старый сосед меньший список вложений не применит — фото у него осталось бы).
 */
export async function fedAlbumAllowedFor(memberIds: readonly string[]): Promise<boolean> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) return true;
  const rows = await db.select({ id: users.id, home: users.homeInstanceId }).from(users).where(inArray(users.id, ids));
  for (const r of rows) if (r.home && !(await peerHomeHas(r.id, FED_FEATURES.dmalbum1))) return false;
  return true;
}

/** Местный человек — `true`; человек соседа — связка с его домом объявила признак (иначе визитка перечитывается, не чаще раза в час). */
async function peerHomeHas(peerId: string, feature: string): Promise<boolean> {
  const [u] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, peerId)).limit(1);
  if (!u?.home) return true;
  const [link] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, u.home)).limit(1);
  if (!link) return false;
  if (link.features.includes(feature)) return true;
  return (await refreshCapabilities(link, Date.now())).includes(feature);
}

// ─── Отдача соседу ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Файл, который можно отдать инстансу `peer` (`GET /fed/v1/att/:id`): вложение нашего человека (не копия чужого — у неё
 * `origin_instance_id`, и владелец — теневой), `attached`, сообщение той же беседы и не надгробие, в беседе есть участник
 * с домом `peer`. Иначе `null` — маршрут отвечает 404, не различая причин.
 */
export async function fedAttachmentForPeer(peer: string, attId: string): Promise<AttachmentRow | null> {
  const [row] = await db
    .select({ att: attachments })
    .from(attachments)
    .innerJoin(users, eq(users.id, attachments.ownerId))
    .innerJoin(conversationMessages, eq(conversationMessages.id, attachments.messageId))
    .where(
      and(
        eq(attachments.id, attId),
        eq(attachments.state, 'attached'),
        or(
          and(
            isNull(attachments.originInstanceId),
            isNull(users.homeInstanceId),
          ),
          // Э7 часть 1 (#141, §3.6): хост группы со смешанным составом отдаёт и СКОПИРОВАННЫЙ файл чужого автора — дома
          // участников, не связанные с домом автора, берут файл у хоста (звезда, как само сообщение).
          sql`EXISTS (SELECT 1 FROM conversations gc WHERE gc.id = ${attachments.conversationId}
            AND gc.kind = 'group' AND gc.origin_instance_id IS NULL)`,
        ),
        eq(conversationMessages.conversationId, attachments.conversationId),
        isNull(conversationMessages.deletedAt),
        sql`EXISTS (SELECT 1 FROM ${conversationMembers} cm JOIN ${users} pu ON pu.id = cm.user_id
          WHERE cm.conversation_id = ${attachments.conversationId} AND pu.home_instance_id = ${peer})`,
      ),
    )
    .limit(1);
  return row?.att ?? null;
}

// ─── Приём: строки `remote` ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Вложения копии сообщения → строки `attachments` (`remote`, дом `origin`, владелец — теневой автор) и список для
 * `conversation_messages.attachments` (у каждого `fedState: 'copying'`). Вызывать ПОСЛЕ вставки сообщения той же
 * транзакцией (`message_id` ссылается на него). id из провода, уже занятый у нас (столкновение или подделка), выпадает
 * вместе со своим файлом — чужую строку не трогаем.
 */
export async function remoteAttachmentsFor(
  tx: Tx,
  input: { conversationId: string; ownerId: string; messageId: string; origin: string; list: readonly FedConvAttachmentWire[] },
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const w of input.list) {
    const row = {
      id: w.id,
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      messageId: input.messageId,
      storageKey: `dm/${w.id}`,
      name: w.name,
      contentType: w.contentType,
      size: w.size,
      state: 'remote' as const,
      originInstanceId: input.origin,
    };
    const [ins] = await tx.insert(attachments).values(row).onConflictDoNothing().returning();
    if (!ins) continue;
    const stored = storedAttachment(ins, {
      id: w.id,
      width: w.width,
      height: w.height,
      waveform: w.waveform,
      durationMs: w.durationMs,
      asFile: w.asFile,
      gif: w.gif === true,
      spoiler: w.spoiler,
      round: w.round === true,
      // Э3 часть 3 (`dm2once`): «один раз» — после первого прослушивания копия стирается (`spendVoiceOnce`).
      once: w.once === true ? true : null,
      // #226 (`dm2ttl`): таймер одноразового фото/видео.
      onceTtl: w.once === true && w.onceTtl ? w.onceTtl : null,
    });
    // Больше порога копии — по первому открытию: обычная карточка/плитка, не «загружается» (часть 2).
    out.push({ ...stored, fedState: w.size > FED_ATT_COPY_MAX ? 'remote' : 'copying' });
  }
  return out;
}

// ─── Приём: копия файлов ─────────────────────────────────────────────────────────────────────────────────────────────

const running = new Set<string>();
const again = new Set<string>();
/** Пауза по дому файлов после сбоя соседа: до какого момента не ходить, текущий шаг. */
const homeBackoff = new Map<string, { until: number; step: number }>();
/** Пауза по одному файлу (404 у соседа, размер не сошёлся): до какого момента, шаг. */
const fileBackoff = new Map<string, { until: number; step: number }>();

function bump(map: Map<string, { until: number; step: number }>, key: string): void {
  const step = Math.min((map.get(key)?.step ?? BACKOFF_MIN_MS / 2) * 2, BACKOFF_MAX_MS);
  map.set(key, { until: Date.now() + step, step });
}

/** Скопировать не скопированные файлы дома `origin` (одиночка на дом; повторный пинок во время прохода — ещё проход). */
export function kickAttCopies(origin: string, opts: { fresh?: boolean } = {}): void {
  if (opts.fresh) homeBackoff.delete(origin);
  if (running.has(origin)) {
    again.add(origin);
    return;
  }
  const b = homeBackoff.get(origin);
  if (b && b.until > Date.now()) return;
  running.add(origin);
  void copyLoop(origin)
    .catch((e) => console.error(`[fed-dm] копия вложений ${origin}:`, (e as Error).message))
    .finally(() => {
      running.delete(origin);
      if (again.delete(origin)) kickAttCopies(origin);
    });
}

type Outcome = 'done' | 'peer-down' | 'file-fail' | 'gone' | 'quota';

async function copyLoop(origin: string): Promise<void> {
  const tried = new Set<string>();
  for (;;) {
    const now = Date.now();
    const rows = (
      await db
        .select()
        .from(attachments)
        .where(and(eq(attachments.state, 'remote'), eq(attachments.originInstanceId, origin), lte(attachments.size, FED_ATT_COPY_MAX)))
        .orderBy(asc(attachments.createdAt))
        .limit(COPY_BATCH + tried.size)
    ).filter((r) => !tried.has(r.id) && (fileBackoff.get(r.id)?.until ?? 0) <= now);
    if (rows.length === 0) return;
    for (const row of rows.slice(0, COPY_BATCH)) {
      tried.add(row.id);
      const res = await copyOne(origin, row);
      if (res === 'peer-down') {
        bump(homeBackoff, origin);
        return;
      }
      homeBackoff.delete(origin);
      if (res === 'file-fail' || res === 'quota') bump(fileBackoff, row.id);
      else fileBackoff.delete(row.id);
    }
  }
}

async function copyOne(origin: string, row: AttachmentRow): Promise<Outcome> {
  if (!federation.identity() || !federation.signingKey() || !attachmentStore.ready()) return 'peer-down';
  const { link, host } = await workingLink(origin);
  if (!link || !host) return 'peer-down';
  // Квота связки (часть 2): место занимается ДО записи; не влезло — копии нет, файл только потоком с соседа.
  if (await reserveLinkQuota(origin, row.size)) {
    await markNoRoom(row);
    return 'quota';
  }
  let kept = false;
  try {
    const res = await fetchSmall(row, link.apiBase, host);
    if (res !== 'ok') return res;
    kept = await markCopied(row);
    return kept ? 'done' : 'gone';
  } finally {
    if (!kept) await releaseLinkQuota(origin, row.size).catch(() => {});
  }
}

/** Файл ≤ 25 МБ целиком в память и в бакет (часть 1); `ok` — лёг под `row.storageKey`. */
async function fetchSmall(row: AttachmentRow, apiBase: string, host: string): Promise<'ok' | 'peer-down' | 'file-fail'> {
  const origin = row.originInstanceId;
  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return 'peer-down';
  const res = await getSignedFromPeer({
    apiBase,
    path: `/api/fed/v1/att/${encodeURIComponent(row.id)}`,
    query: { instance_id: self.instanceId },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
    binary: true,
    attachment: true,
    // Ровно заявленный в проводе размер: больше — обрыв на лету (`safePeerRequest`: ответ больше предела), не копия.
    maxBytes: Math.max(1, row.size),
  });
  if (!res.ok) {
    const oversize = /больше предела/.test(res.detail ?? '');
    if (oversize) console.warn(`[fed-dm] ${origin}: вложение ${row.id} больше заявленного размера ${row.size} — отказ`);
    return oversize ? 'file-fail' : 'peer-down';
  }
  const status = res.value.status;
  if (status === 404) return 'file-fail'; // у соседа нет (надгробие ещё едет) — отдельно, дом не наказываем
  if (status < 200 || status >= 300) return 'peer-down';
  const bytes = res.value.bytes ?? Buffer.alloc(0);
  if (bytes.length !== row.size) {
    console.warn(`[fed-dm] ${origin}: вложение ${row.id} — ${bytes.length} байт вместо ${row.size} — отказ`);
    return 'file-fail';
  }
  await attachmentStore.put(row.storageKey, bytes, row.contentType);
  return 'ok';
}

/**
 * Файл лёг в бакет: строка `attached`, у сообщения пропадает `fedState`, люди беседы получают обновлённое сообщение
 * (`conv.change` — тем же путём, что правка копии). Строки уже нет или она не `remote` (надгробие успело) — файл стираем.
 */
async function markCopied(row: AttachmentRow): Promise<boolean> {
  let delivery: Parameters<typeof deliver>[0] = null;
  const ok = await db.transaction(async (tx) => {
    if (!row.messageId || !(await lockConversation(tx, row.conversationId))) return false;
    const [upd] = await tx
      .update(attachments)
      .set({ state: 'attached' })
      .where(and(eq(attachments.id, row.id), eq(attachments.state, 'remote')))
      .returning({ id: attachments.id });
    if (!upd) return false;
    delivery = await restateInMessage(tx, row, 'drop');
    return true;
  });
  if (!ok) {
    await attachmentStore.remove(row.storageKey).catch(() => {});
    return false;
  }
  await deliver(delivery);
  return true;
}

/**
 * Копия ≤ 25 МБ не влезла в квоту связки (часть 2): в сообщении `copying` → `remote` (обычная карточка, открытие — потоком
 * с соседа), люди беседы получают обновлённое сообщение. Уже `remote` — ничего (повтор такта не шумит).
 */
async function markNoRoom(row: AttachmentRow): Promise<void> {
  const delivery = await db.transaction(async (tx) => {
    if (!row.messageId || !(await lockConversation(tx, row.conversationId))) return null;
    return await restateInMessage(tx, row, 'remote');
  });
  await deliver(delivery);
}

/** Поле `fedState` вложения `row` в сообщении: `drop` — убрать (копия легла), `remote` — `copying` → `remote`. Журнал как у правки. */
async function restateInMessage(tx: Tx, row: AttachmentRow, mode: 'drop' | 'remote'): Promise<Parameters<typeof deliver>[0]> {
  if (!row.messageId) return null;
  const hit = mode === 'drop' ? sql`e->>'id' = ${row.id}` : sql`e->>'id' = ${row.id} AND e->>'fedState' = 'copying'`;
  const next = mode === 'drop' ? sql`e - 'fedState'` : sql`jsonb_set(e, '{fedState}', '"remote"'::jsonb)`;
  const [msg] = await tx
    .update(conversationMessages)
    .set({
      attachments: sql`(SELECT COALESCE(jsonb_agg(CASE WHEN ${hit} THEN ${next} ELSE e END ORDER BY n), '[]'::jsonb)
        FROM jsonb_array_elements(${conversationMessages.attachments}) WITH ORDINALITY AS t(e, n))`,
    })
    .where(
      and(
        eq(conversationMessages.id, row.messageId),
        isNull(conversationMessages.deletedAt),
        mode === 'drop' ? undefined : sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${conversationMessages.attachments}) AS x(e) WHERE ${hit})`,
      ),
    )
    .returning({ id: conversationMessages.id, authorId: conversationMessages.authorId, withheld: conversationMessages.withheld });
  if (!msg) return null;
  const memberIds = (
    await tx.select({ id: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, row.conversationId))
  ).map((m) => m.id);
  const audience = changeAudience({ action: 'edit', actorId: msg.authorId, memberIds, withheld: msg.withheld, blockedActor: new Set() });
  const pts = await journal(tx, msgEntries(audience, row.conversationId, msg.id), { fed: false });
  return { conversationId: row.conversationId, messageId: msg.id, pts };
}

// ─── Часть 2: по первому открытию ────────────────────────────────────────────────────────────────────────────────────

/** Что отдать смотрящему вместо файла `remote` (`routes/att.ts`, крючок `configureRemoteAttachments`). */
export type RemoteAttServe =
  | { kind: 'stream'; body: Readable }
  /** Дом автора недоступен (лежит, связка не рабочая) — 503 `federation.att_unavailable`; `instance` — как его назвать. */
  | { kind: 'unavailable'; instance: string | null }
  /** Сосед ответил 404 (файла у него нет — надгробие едет) — для смотрящего как нет файла. */
  | { kind: 'gone' };

/** Одновременных фоновых копий больших файлов на весь инстанс: каждая держит поток соседа и кусок 8 МБ в памяти. */
const BIG_PARALLEL = 2;
const bigRunning = new Set<string>();

type LinkRow = typeof federationLinks.$inferSelect;
function linkName(link: LinkRow | undefined): string | null {
  return link ? link.localName || link.theirName || link.domain : null;
}

/** Связка с домом файла и её хост, если она рабочая (активна, объявила `dm2`, адрес разбирается); иначе `host: null`. */
async function workingLink(origin: string): Promise<{ link: LinkRow | undefined; host: string | null }> {
  const [link] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, origin)).limit(1);
  if (!link || link.state !== 'active' || !link.features.includes(FED_FEATURES.dm2)) return { link, host: null };
  try {
    return { link, host: new URL(link.apiBase).host };
  } catch {
    return { link, host: null };
  }
}

/**
 * Файл `remote` смотрящему — потоком с дома автора (подписанный GET `/fed/v1/att/:id`, его `Range` как есть; поток ограничен
 * длиной диапазона или размером из провода, ответ соседа сверяется: 206 с тем же `Content-Range` / 200 той же длины).
 * Файл больше 25 МБ заодно начинает фоновую копию к нам (`startBigCopy`); повторные открытия до её конца — снова поток.
 */
export async function serveRemoteAttachment(row: AttachmentRow, range: { start: number; end: number } | null): Promise<RemoteAttServe> {
  const origin = row.originInstanceId;
  if (!origin) return { kind: 'gone' };
  const self = federation.identity();
  const key = federation.signingKey();
  const { link, host } = await workingLink(origin);
  if (!self || !key || !link || !host) return { kind: 'unavailable', instance: linkName(link) };
  const res = await streamSignedFromPeer({
    apiBase: link.apiBase,
    path: `/api/fed/v1/att/${encodeURIComponent(row.id)}`,
    query: { instance_id: self.instanceId },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    now: Date.now(),
    maxBytes: range ? range.end - range.start + 1 : row.size,
    ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}),
  });
  if (!res.ok) return { kind: 'unavailable', instance: linkName(link) };
  const v = res.value;
  if (v.status === 404) {
    v.body.destroy();
    return { kind: 'gone' };
  }
  const fits = range
    ? v.status === 206 &&
      v.contentRange === `bytes ${range.start}-${range.end}/${row.size}` &&
      // Длина тела — ровно запрошенный кусок (нет заголовка — верим `Content-Range`; поток сверху и так ограничен `maxBytes`).
      (v.contentLength === null || v.contentLength === range.end - range.start + 1)
    : v.status === 200 && (v.contentLength === null || v.contentLength === row.size);
  if (!fits) {
    v.body.destroy();
    console.warn(`[fed-dm] ${origin}: вложение ${row.id} — ответ ${v.status} ${v.contentRange ?? ''} не сходится с проводом (${row.size}) — не отдаём`);
    return { kind: 'unavailable', instance: linkName(link) };
  }
  if (row.size > FED_ATT_COPY_MAX) startBigCopy(origin, row);
  return { kind: 'stream', body: v.body };
}

/** Фоновая полная копия большого файла (одна на файл, не больше `BIG_PARALLEL` всего; после отказа — пауза по файлу). */
function startBigCopy(origin: string, row: AttachmentRow): void {
  if (bigRunning.has(row.id) || bigRunning.size >= BIG_PARALLEL) return;
  if ((fileBackoff.get(row.id)?.until ?? 0) > Date.now()) return;
  bigRunning.add(row.id);
  void copyBig(origin, row)
    .then((res) => {
      if (res === 'done' || res === 'gone') fileBackoff.delete(row.id);
      else bump(fileBackoff, row.id);
    })
    .catch((e) => {
      bump(fileBackoff, row.id);
      console.error(`[fed-dm] копия большого вложения ${row.id}:`, (e as Error).message);
    })
    .finally(() => bigRunning.delete(row.id));
}

/**
 * Копия большого файла ПОТОКОМ: тело соседа режется на куски `BIGFILE_PART_BYTES` и уходит S3 multipart (как загрузка
 * кусками `bigUploads.ts`) — в памяти не больше куска. Место по квоте связки — до начала; сбой — возврат места и отмена
 * загрузки. Длина сверяется с проводом (больше — поток рвётся на лету). Затем `attached`, как у копии ≤ 25 МБ.
 */
async function copyBig(origin: string, row: AttachmentRow): Promise<Outcome> {
  const mp = attachmentStore.multipart;
  const self = federation.identity();
  const key = federation.signingKey();
  if (!mp || !self || !key || !attachmentStore.ready()) return 'peer-down';
  const { link, host } = await workingLink(origin);
  if (!link || !host) return 'peer-down';
  if (await reserveLinkQuota(origin, row.size)) return 'quota';
  let kept = false;
  let uploadId: string | null = null;
  try {
    const res = await streamSignedFromPeer({
      apiBase: link.apiBase,
      path: `/api/fed/v1/att/${encodeURIComponent(row.id)}`,
      query: { instance_id: self.instanceId },
      keyid: key.kid,
      privateKeyDer: key.privateKeyDer,
      allowHosts: new Set([host]),
      now: Date.now(),
      maxBytes: row.size,
    });
    if (!res.ok) return 'peer-down';
    const body = res.value.body;
    if (res.value.status !== 200) {
      body.destroy();
      return res.value.status === 404 ? 'file-fail' : 'peer-down';
    }
    const id = await mp.create(row.storageKey, row.contentType);
    uploadId = id;
    const parts: { part: number; etag: string }[] = [];
    let buf: Buffer[] = [];
    let bufLen = 0;
    let total = 0;
    const flush = async () => {
      const n = parts.length + 1;
      const chunk = Buffer.concat(buf, bufLen);
      buf = [];
      bufLen = 0;
      parts.push({ part: n, etag: await mp.part(row.storageKey, id, n, chunk) });
    };
    for await (const c of body as AsyncIterable<Buffer>) {
      buf.push(c);
      bufLen += c.length;
      total += c.length;
      if (bufLen >= BIGFILE_PART_BYTES) await flush();
    }
    if (bufLen > 0 || parts.length === 0) await flush();
    if (total !== row.size) {
      console.warn(`[fed-dm] ${origin}: большое вложение ${row.id} — ${total} байт вместо ${row.size} — отказ`);
      return 'file-fail';
    }
    await mp.complete(row.storageKey, id, parts);
    uploadId = null;
    kept = await markCopied(row);
    return kept ? 'done' : 'gone';
  } catch (e) {
    console.warn(`[fed-dm] ${origin}: большое вложение ${row.id} — обрыв: ${(e as Error).message}`);
    return /больше предела/.test((e as Error).message) ? 'file-fail' : 'peer-down';
  } finally {
    if (uploadId) await mp.abort(row.storageKey, uploadId).catch(() => {});
    if (!kept) await releaseLinkQuota(origin, row.size).catch(() => {});
  }
}

/** Копии, которые ждут, — сразу при старте и раз в минуту (сосед лежал, бэкенд перезапускался, файл отказал раньше). */
export async function kickAllAttCopies(): Promise<void> {
  const homes = await db
    .selectDistinct({ origin: attachments.originInstanceId })
    .from(attachments)
    .where(and(eq(attachments.state, 'remote'), lte(attachments.size, FED_ATT_COPY_MAX)));
  for (const h of homes) if (h.origin) kickAttCopies(h.origin);
}

let timer: ReturnType<typeof setInterval> | null = null;
/** `active` (#224): ЛС между инстансами включены прямо сейчас — выключили тумблером в админке, такты и приём пустые. */
export function startAttCopies(active: () => boolean = () => true): void {
  if (timer) return;
  void kickAllAttCopies().catch(() => {});
  timer = setInterval(() => {
    if (active()) void kickAllAttCopies().catch(() => {});
  }, COPY_EVERY_MS);
  timer.unref?.();
}

/** Файлы копий, помеченные надгробием `deleted`, — стереть сейчас, а не часовой уборкой (§3.5: надгробие стирает копию). */
export function purgeCopiesNow(keys: readonly string[]): void {
  if (keys.length > 0) void purgeDeleted(keys).catch(() => {});
}
