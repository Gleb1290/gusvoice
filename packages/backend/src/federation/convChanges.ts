/**
 * Журнал изменений бесед на связку (Э0 ЛС между инстансами, `docs/dm/FEDERATION.md` §3.3): что МЫ должны отдать соседу.
 *
 * По образцу журнала догонки клиентов (`user_sync` / `user_changes`): `fed_conv_sync` — номер на соседа, `fed_conv_changes` —
 * указатели «запись беседы изменилась», сама запись отдаётся в ТЕКУЩЕМ виде (три правки подряд — один итог, удаление —
 * надгробием). Сосед забирает `GET /fed/v1/conv/changes?since=` (маршрут — `routes/federation.ts`); звонок в дверь
 * `conv.changed` и курсор приёма `fed_conv_cursor` — Э2.
 *
 * 🔴 Пишется только при `FEDERATION_DM_ENABLED` (`configureFederatedConv` из `index.ts`) и только для бесед, где есть
 * участник с того инстанса. В Э0 смешанных бесед ещё нет (`POST /conv/direct` их не открывает) — журнал пуст. Отбор «только
 * записи наших владельцев» (копии чужих сообщений соседу не отдаются, §3.2) — обязанность Э2 при приёме копий.
 *
 * Модуль не тянет `conversations.ts` (тот открывает Redis при загрузке). Ночная уборка журнала — `convJournal.pruneFedConvChanges`
 * (рядом с уборкой журнала догонки: `cleanup.ts` намеренно зависит только от `convJournal.ts`).
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  convMediaToWire,
  FED_CONV_CHANGE,
  FED_CONV_CHANGE_E2,
  FED_CONV_EXPORT_MESSAGES,
  FED_CONV_GROUPS_MAX,
  FED_CONV_LIMITS,
  FED_FEATURES,
  FED_FIELD_LIMITS,
  type FedConvAttachmentWire,
  type FedConvChange,
  type FedConvChangesPage,
  type FedConvExportPage,
  type FedConvMessageWire,
  type FedConvWire,
  type FedPersonRef,
  fedDomain,
  fedOptionalText,
  serializeConvListenWire,
  serializeConvMessageWire,
  serializeConvPinWire,
  serializeConvPollVotesWire,
  serializeConvReactionsWire,
  serializeConvReadsWire,
  serializeConvGroupExtras,
  serializeConvWire,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import {
  conversationMembers,
  conversationMessageReactions,
  conversationMessages,
  conversationPins,
  conversationVoiceListens,
  conversations,
  convPollVotes,
  fedConvChanges,
  fedConvSync,
  federationLinks,
  users,
} from '../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface FedConvChangeInput {
  conversationId: string;
  kind: (typeof FED_CONV_CHANGE)[keyof typeof FED_CONV_CHANGE] | (typeof FED_CONV_CHANGE_E2)[keyof typeof FED_CONV_CHANGE_E2];
  entityId: string | null;
  /**
   * Э7 часть 3: дом автора действия, которое хост группы пересылает дальше (`conversations.fedRecordRelay`) — ему строка не
   * пишется (своё он знает сам). Только для видов `GROUP_MARK_KINDS`.
   */
  exceptHome?: string;
}

/**
 * Э7 часть 3 (#141, §3.6): виды строк, которые в группе со смешанным составом идут звездой только соседу с признаком
 * `dmgroupmarks1` — реакции, «прочитано до», закреп «для всех», «прослушано». Старый сосед получает группу, как в Э7 части 1.
 */
export const GROUP_MARK_KINDS: ReadonlySet<string> = new Set([
  FED_CONV_CHANGE_E2.react,
  FED_CONV_CHANGE.read,
  FED_CONV_CHANGE.pin,
  FED_CONV_CHANGE_E2.listen,
]);

/**
 * Отметки, которые в группе идут звездой (маршрут, пересылка хостом, выгрузка) — `GROUP_MARK_KINDS` и голоса в опросе
 * (`pollvote`, признак `dmpoll1`: строку `materialize` ещё отбирает по `KIND_FEATURE`). Отдельный набор: контракт
 * `GROUP_MARK_KINDS` (четыре отметки `dmgroupmarks1`) не меняется.
 */
const MARK_KINDS: ReadonlySet<string> = new Set([...GROUP_MARK_KINDS, FED_CONV_CHANGE_E2.vote]);

/**
 * Э2: звонок в дверь соседу после записи журнала (`federation/convAccept.ringDoorbell`, подключает `index.ts`). Зовётся ДО
 * фиксации транзакции — звонок откладывается и несёт номер; сосед, не увидев его в журнале, повторит забор (`convAccept`).
 */
let doorbell: ((instanceId: string, seq: number) => void) | null = null;
export function configureFedConvDoorbell(ring: ((instanceId: string, seq: number) => void) | null): void {
  doorbell = ring;
}

/**
 * Записать изменения в журнал каждого инстанса-участника беседы — в ТОЙ ЖЕ транзакции, что и местное изменение (иначе
 * упавший процесс оставил бы изменение без строки журнала, и сосед его никогда бы не забрал). Зовётся из `journal`
 * (`conversations.ts`) только при `FEDERATION_DM_ENABLED` — подключает `index.ts` через `configureFederatedConv`.
 *
 * Замки `fed_conv_sync` берутся по возрастанию `instance_id` — у всех писателей одинаково (как `journalLockOrder`).
 */
export async function recordFedConvChanges(tx: Tx, items: readonly FedConvChangeInput[]): Promise<void> {
  if (items.length === 0) return;
  const seen = new Set<string>();
  const uniq = items.filter((i) => {
    const k = `${i.conversationId}|${i.kind}|${i.entityId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const msgIds = uniq.filter((i) => i.kind === FED_CONV_CHANGE.msg && i.entityId).map((i) => i.entityId as string);
  /** Автор сообщения с другого инстанса (копия) — его дом; служебная запись группы — пишет хост, едет всем. */
  const foreignHome = new Map<string, string>();
  const serviceIds = new Set<string>();
  /** Э7 часть 3: «через»-сообщения, что дом автора ещё не подтвердил, — остальным домам группы не пересылаем до его подписанной копии. */
  const pendingVia = new Set<string>();
  if (msgIds.length > 0) {
    const rows = await tx
      .select({ id: conversationMessages.id, home: users.homeInstanceId, deletedAt: conversationMessages.deletedAt, service: conversationMessages.service, viaState: conversationMessages.viaState })
      .from(conversationMessages)
      .innerJoin(users, eq(users.id, conversationMessages.authorId))
      .where(inArray(conversationMessages.id, msgIds));
    for (const r of rows) {
      if (r.home !== null && r.deletedAt === null) foreignHome.set(r.id, r.home);
      if (r.service) serviceIds.add(r.id);
      if (r.viaState === 'pending') pendingVia.add(r.id);
    }
  }
  const convIds = [...new Set(uniq.map((i) => i.conversationId))];
  const convRows = await tx
    .select({ id: conversations.id, kind: conversations.kind, origin: conversations.originInstanceId })
    .from(conversations)
    .where(inArray(conversations.id, convIds));
  const convInfo = new Map(convRows.map((c) => [c.id, c]));
  const marks = await groupMarkRouting(tx, uniq, convInfo);
  /*
   * Э7 часть 1 (§3.6): в группе — только действующие участники (и ушедшие ЭТОЙ транзакцией: `left_at = now()`, их дом получает
   * свой уход один раз, дальше ничего). 1:1 — как прежде.
   */
  const peers = await tx
    .selectDistinct({ conversationId: conversationMembers.conversationId, instanceId: users.homeInstanceId })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        inArray(conversationMembers.conversationId, convIds),
        isNotNull(users.homeInstanceId),
        sql`(${conversations.kind} <> 'group' OR ${conversationMembers.leftAt} IS NULL OR ${conversationMembers.leftAt} >= now())`,
      ),
    );

  const byInstance = new Map<string, FedConvChangeInput[]>();
  const push = (instanceId: string, list: FedConvChangeInput[]) => {
    if (list.length === 0) return;
    const cur = byInstance.get(instanceId) ?? [];
    cur.push(...list);
    byInstance.set(instanceId, cur);
  };
  for (const conversationId of convIds) {
    const info = convInfo.get(conversationId);
    const mine = uniq.filter((i) => i.conversationId === conversationId);
    const homes = [...new Set(peers.filter((p) => p.conversationId === conversationId && p.instanceId).map((p) => p.instanceId as string))];
    if (info?.kind === 'group' && info.origin) {
      // Группа другого инстанса (мы — дом участника): только хосту и только сообщения наших людей (звезда §3.6).
      push(
        info.origin,
        mine.filter((i) => i.kind === FED_CONV_CHANGE.msg && i.entityId && !foreignHome.has(i.entityId)),
      );
      // Э7 часть 3: реакции, «прочитано», закреп «для всех», «прослушано» наших людей — тоже хосту (он перешлёт остальным).
      if (marks.homes.has(info.origin)) push(info.origin, mine.filter((i) => MARK_KINDS.has(i.kind)));
      continue;
    }
    if (info?.kind === 'group') {
      // Мы — хост группы: состав (`conv`) и сообщения всем домам участников; копия чужого — всем, кроме дома автора
      // (служебная запись — и ему). Реакции, «прочитано», закреп, «прослушано» в группах между инстансами — не в части 1.
      for (const home of homes) {
        push(
          home,
          mine.filter(
            (i) =>
              i.kind === FED_CONV_CHANGE.conv ||
              (i.kind === FED_CONV_CHANGE.msg && !!i.entityId && !pendingVia.has(i.entityId) && (foreignHome.get(i.entityId) !== home || serviceIds.has(i.entityId))),
          ),
        );
      }
      // Э7 часть 3: реакции, «прочитано», закреп, «прослушано» — каждому дому с `dmgroupmarks1`, кроме дома автора действия
      // (`exceptHome`); «прослушано» — только дому автора сообщения (горит у него, `voiceListenedFor`).
      for (const home of homes) {
        if (!marks.homes.has(home)) continue;
        push(
          home,
          mine.filter(
            (i) =>
              MARK_KINDS.has(i.kind) &&
              i.exceptHome !== home &&
              (i.kind !== FED_CONV_CHANGE_E2.listen || (!!i.entityId && marks.listenHome.get(i.entityId) === home)),
          ),
        );
      }
      continue;
    }
    /*
     * Э2 (§3.2): соседу уходят только записи НАШИХ владельцев. Сообщение — дом автора; копия чужого (автор теневой) — только
     * надгробием (Ф8: «удалить у обоих» чужое в 1:1 делает наш человек). Приём копии сам журнал на связку не пишет
     * (`journal(..., { fed: false })`), так что надгробие копии здесь — всегда действие нашего человека.
     */
    const foreign = new Set(foreignHome.keys());
    let own = mine;
    if (foreign.size > 0) {
      own = mine.filter((i) => !(i.kind === FED_CONV_CHANGE.msg && i.entityId && foreign.has(i.entityId)));
    }
    for (const home of homes) push(home, own);
  }
  if (byInstance.size === 0) return;
  for (const instanceId of [...byInstance.keys()].sort()) {
    const mine = byInstance.get(instanceId) ?? [];
    if (mine.length === 0) continue;
    const [row] = await tx
      .insert(fedConvSync)
      .values({ instanceId, seq: mine.length })
      .onConflictDoUpdate({ target: fedConvSync.instanceId, set: { seq: sql`${fedConvSync.seq} + ${mine.length}` } })
      .returning({ seq: fedConvSync.seq });
    const last = Number(row.seq);
    await tx.insert(fedConvChanges).values(
      mine.map((i, k) => ({
        instanceId,
        seq: last - mine.length + 1 + k,
        conversationId: i.conversationId,
        kind: i.kind,
        entityId: i.entityId,
      })),
    );
    doorbell?.(instanceId, last);
  }
}

/**
 * Э7 часть 3: для строк `GROUP_MARK_KINDS` в группах — дома связок с `dmgroupmarks1` (кому их вообще можно писать) и дом
 * автора сообщения у «прослушано» (у хоста — адресат пересылки). Нет таких строк — пусто, без запросов.
 */
async function groupMarkRouting(
  tx: Tx,
  items: readonly FedConvChangeInput[],
  convInfo: ReadonlyMap<string, { kind: string }>,
): Promise<{ homes: Set<string>; listenHome: Map<string, string> }> {
  const out = { homes: new Set<string>(), listenHome: new Map<string, string>() };
  const marked = items.filter((i) => MARK_KINDS.has(i.kind) && convInfo.get(i.conversationId)?.kind === 'group');
  if (marked.length === 0) return out;
  const links = await tx.select({ instanceId: federationLinks.instanceId, features: federationLinks.features }).from(federationLinks);
  for (const l of links) if (l.features.includes(FED_FEATURES.dmgroupmarks1)) out.homes.add(l.instanceId);
  const listenIds = marked.filter((i) => i.kind === FED_CONV_CHANGE_E2.listen && i.entityId).map((i) => i.entityId as string);
  if (listenIds.length > 0) {
    const rows = await tx
      .select({ id: conversationMessages.id, home: users.homeInstanceId })
      .from(conversationMessages)
      .innerJoin(users, eq(users.id, conversationMessages.authorId))
      .where(inArray(conversationMessages.id, listenIds));
    for (const r of rows) if (r.home) out.listenHome.set(r.id, r.home);
  }
  return out;
}

type UserRef = {
  id: string;
  homeInstanceId: string | null;
  homeUserId: string | null;
  username?: string;
  homeUsername?: string | null;
  displayName?: string;
  homeAvatarHash?: string | null;
};

/**
 * Э7 часть 1 (§4 п. 1): подпись сообщения нашего человека в группе ключом инстанса (`federation/convGroup.signOwnMessage`,
 * подключает `index.ts`). Нет ключа — `null`: дом группы такую копию не примет (без подписи её не перешлёшь).
 */
let groupSigner: ((w: FedConvMessageWire) => Record<string, unknown> | null) | null = null;
export function configureFedGroupSigner(fn: ((w: FedConvMessageWire) => Record<string, unknown> | null) | null): void {
  groupSigner = fn;
}

function refOf(u: UserRef | undefined, fallbackId: string, selfInstanceId: string): FedPersonRef {
  if (!u || u.homeInstanceId === null) return { instanceId: selfInstanceId, userId: u?.id ?? fallbackId };
  return { instanceId: u.homeInstanceId, userId: u.homeUserId ?? u.id };
}

type MessageRow = typeof conversationMessages.$inferSelect;

/**
 * G6 (приёмка 13.10): служебная запись группы едет как есть, но у каждого из `users` («добавил», «удалил») — ещё `ref`, глобальная
 * личность (`FedPersonRef`, только добавлением): `id` в записи — НАШ id, дому участника он ничего не говорит, и удалённый у себя
 * дома не узнавал себя в «удалил(а)» (шапка «вы покинули группу»). Приём переводит `ref` в свой id (`convAccept.localService`);
 * старый сосед поле не читает. Человек не найден среди `people` — запись без `ref`, как раньше.
 */
/** id из `users` служебной записи группы (G6) — пусто у остальных. */
function serviceUserIds(service: unknown): string[] {
  const s = service as { kind?: unknown; users?: unknown } | null;
  if (!s || s.kind !== 'group' || !Array.isArray(s.users)) return [];
  return s.users.flatMap((u) => (u && typeof u === 'object' && typeof (u as { id?: unknown }).id === 'string' ? [(u as { id: string }).id] : []));
}

function serviceWire(service: Record<string, unknown>, people: ReadonlyMap<string, UserRef>, selfInstanceId: string): Record<string, unknown> {
  if (service.kind !== 'group' || !Array.isArray(service.users)) return service;
  const list = service.users as unknown[];
  return {
    ...service,
    users: list.map((u) => {
      if (!u || typeof u !== 'object' || typeof (u as { id?: unknown }).id !== 'string') return u;
      const id = (u as { id: string }).id;
      const person = people.get(id);
      return person ? { ...(u as Record<string, unknown>), ref: refOf(person, id, selfInstanceId) } : u;
    }),
  };
}

/**
 * Строка сообщения → провод (`FedConvMessageWire`). Явный сериализатор, не выгрузка строки: колонки БД провод не меняют.
 * Надгробие отдаётся пустым (текст и вложения уже стёрты). Вложения без `id` (старый публичный бакет) в провод не идут.
 */
export function toWireMessage(m: MessageRow, people: ReadonlyMap<string, UserRef>, selfInstanceId: string): FedConvMessageWire {
  const deleted = m.deletedAt !== null;
  const attachments: FedConvAttachmentWire[] = deleted
    ? []
    : m.attachments
        .filter((a) => typeof a.id === 'string')
        .map((a) => ({
          id: a.id as string,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          width: a.width ?? null,
          height: a.height ?? null,
          durationMs: a.durationMs ?? null,
          waveform: a.waveform ?? null,
          asFile: a.asFile === true,
          spoiler: a.spoiler === true,
          sha256: null,
          // Э3 (`dm2`): пометки вида — только `true`, у прочих ключей в проводе нет.
          ...(a.gif === true ? { gif: true } : {}),
          ...(a.round === true ? { round: true } : {}),
          // Э3 часть 3 (`dm2once`): «один раз» — запись решает, кому такое можно (`routes/conv.fedOnceRefused`).
          ...(a.once === true ? { once: true } : {}),
          // #226 (`dm2ttl`): таймер одноразового фото/видео — только вместе с `once`.
          ...(a.once === true && a.onceTtl ? { onceTtl: a.onceTtl } : {}),
        }));
  const fwd = m.forwardedFrom;
  return {
    id: m.id,
    conversationId: m.conversationId,
    author: refOf(people.get(m.authorId), m.authorId, selfInstanceId),
    clientId: m.clientId,
    payloadHash: m.payloadHash,
    createdAt: m.createdAt.getTime(),
    originSortKey: m.originSortKey ?? m.sortKey,
    content: deleted ? '' : m.content,
    replyToId: m.replyToId,
    forwardedFrom: fwd
      ? {
          author: fwd.userId ? refOf(people.get(fwd.userId), fwd.userId, selfInstanceId) : null,
          name: fwd.displayName,
          at: Date.parse(fwd.at) || 0,
        }
      : null,
    silent: m.silent,
    noPreview: m.noPreview,
    captionAbove: m.captionAbove,
    replyQuote: m.replyQuote ?? null,
    sticker: m.sticker ? { id: m.sticker.id, emoji: m.sticker.emoji, url: m.sticker.url, format: m.sticker.format } : null,
    service: m.service ? serviceWire(m.service as unknown as Record<string, unknown>, people, selfInstanceId) : null,
    attachments,
    editVersion: m.editVersion,
    editedAt: m.editedAt ? m.editedAt.getTime() : null,
    deleted,
    // G69 (`dmmedia1`): вид сообщения; соседу без признака `materialize` его снимает (запасной `content` уже в строке).
    ...(m.media && !deleted ? { media: convMediaToWire(m.media, selfInstanceId) } : {}),
  };
}

/**
 * Страница журнала для соседа `instanceId` после номера `since`.
 *
 * 🔴 Только беседы, где у этого соседа ЕСТЬ участник сейчас: строка журнала могла остаться от беседы, из которой его
 * человек ушёл, — отдавать её значило бы показать соседу чужую переписку. `since` ниже обрезанного уборкой — `reset`.
 * Повторы одной сущности в странице сворачиваются в последний номер: сущность всё равно отдаётся в текущем виде.
 */
export async function changesForPeer(
  instanceId: string,
  since: number,
  limit: number,
  selfInstanceId: string,
): Promise<FedConvChangesPage> {
  const cap = Math.max(1, Math.min(limit, FED_CONV_LIMITS.page));
  const [sync] = await db.select().from(fedConvSync).where(eq(fedConvSync.instanceId, instanceId)).limit(1);
  // Исправления ревью 12.10, п. 6: курсор соседа ВПЕРЕДИ нашего журнала (наша база пересоздана с теми же `fed-keys` или
  // восстановлена из бэкапа) — молчать значило бы потерять всё до его старого номера: `reset` с нашей головой, он сделает полный
  // проход и встанет на неё.
  if (!sync) return since > 0 ? { instanceId: selfInstanceId, reset: true, seq: 0 } : { instanceId: selfInstanceId, seq: since, more: false, items: [] };
  // Э2 часть Б: голова журнала в ответе — после полного прохода получатель ставит курсор на неё.
  if (since < Number(sync.minSeq) || since > Number(sync.seq)) return { instanceId: selfInstanceId, reset: true, seq: Number(sync.seq) };

  const rows = await db
    .select()
    .from(fedConvChanges)
    .where(
      and(
        eq(fedConvChanges.instanceId, instanceId),
        gt(fedConvChanges.seq, since),
        // Э7 часть 1: ушедший участник получает только то, что записано до его ухода (`at <= left_at`: уход пишет `left_at = now()`
        // той же транзакцией); группа, чей хост — спрашивающий, отдаётся ему, даже если его людей в ней не осталось.
        or(
          and(
            sql`EXISTS (SELECT 1 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                    WHERE cm.conversation_id = ${fedConvChanges.conversationId} AND u.home_instance_id = ${instanceId})`,
            // Все его люди вышли раньше этой строки — не отдаём (строка без ушедших/действующих решается EXISTS выше).
            sql`(NOT EXISTS (SELECT 1 FROM conversation_members cl JOIN users ul ON ul.id = cl.user_id
                    WHERE cl.conversation_id = ${fedConvChanges.conversationId} AND ul.home_instance_id = ${instanceId}
                      AND cl.left_at IS NOT NULL AND ${fedConvChanges.at} > cl.left_at)
                 OR EXISTS (SELECT 1 FROM conversation_members ca JOIN users ua ON ua.id = ca.user_id
                    WHERE ca.conversation_id = ${fedConvChanges.conversationId} AND ua.home_instance_id = ${instanceId}
                      AND (ca.left_at IS NULL OR ${fedConvChanges.at} <= ca.left_at)))`,
          ),
          sql`EXISTS (SELECT 1 FROM conversations c WHERE c.id = ${fedConvChanges.conversationId}
                    AND c.kind = 'group' AND c.origin_instance_id = ${instanceId})`,
        ),
      ),
    )
    .orderBy(asc(fedConvChanges.seq))
    .limit(cap + 1);
  const more = rows.length > cap;
  const page = rows.slice(0, cap);
  const lastSeq = page.length > 0 ? Number(page[page.length - 1].seq) : Math.max(since, 0);

  const latest = new Map<string, (typeof page)[number]>();
  for (const r of page) latest.set(`${r.conversationId}|${r.kind}|${r.entityId ?? ''}`, r);
  const picked = [...latest.values()].sort((a, b) => Number(a.seq) - Number(b.seq));

  const items = await materialize(picked, instanceId, selfInstanceId);
  return { instanceId: selfInstanceId, seq: lastSeq, more, items };
}

type PickedRow = { seq: number | bigint; kind: string; conversationId: string; entityId: string | null };

/** Опрос (14.10): знает ли сосед опросы (`dmpoll1`) — запрос только если среди сообщений выдачи есть опрос. */
async function peerKnowsPolls(msgs: readonly { media: { kind: string } | null }[], instanceId: string): Promise<boolean> {
  if (!msgs.some((m) => m.media?.kind === 'poll')) return false;
  const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  return !!link?.features.includes(FED_FEATURES.dmpoll1);
}

/**
 * Исправления ревью 12.10, п. 9: вид строки журнала → признак связки, без которого сосед этот вид не знает. Новый вид строки —
 * сюда с признаком того же этапа (строка без записи уходит всем: виды Э0–Э2 знает любой сосед с `dm1`).
 */
export const KIND_FEATURE: Readonly<Record<string, string | undefined>> = {
  [FED_CONV_CHANGE_E2.listen]: FED_FEATURES.dm2once,
  // Опрос (14.10): голоса — только соседу с `dmpoll1` (у старого опрос — текст, голосовать не во что).
  [FED_CONV_CHANGE_E2.vote]: FED_FEATURES.dmpoll1,
};

/** Строки журнала (или полного прохода) → строки провода с сущностями в ТЕКУЩЕМ виде. */
async function materialize(all: readonly PickedRow[], instanceId: string, selfInstanceId: string): Promise<FedConvChange[]> {
  // п. 9 ревью 12.10: строки вида, которого сосед не знает, — только соседу с нужным признаком (`KIND_FEATURE`): старый их
  // пропустил бы, курсор ушёл бы вперёд, и после его обновления они не приехали бы никогда.
  const gated = all.filter((r) => KIND_FEATURE[r.kind]);
  let picked = all;
  if (gated.length > 0) {
    const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
    // Без строки связки соседа забор не дойдёт сюда вовсе (запрос подписан связкой) — фильтровать нечем.
    const has = new Set(link?.features ?? []);
    if (link) picked = all.filter((r) => !KIND_FEATURE[r.kind] || has.has(KIND_FEATURE[r.kind] as string));
  }
  const msgIds = picked.filter((r) => r.kind === FED_CONV_CHANGE.msg && r.entityId).map((r) => r.entityId as string);
  const convIds = [...new Set(picked.filter((r) => r.kind === FED_CONV_CHANGE.conv).map((r) => r.conversationId))];
  const msgs = msgIds.length
    ? await db.select().from(conversationMessages).where(inArray(conversationMessages.id, msgIds))
    : [];
  const convs = convIds.length ? await db.select().from(conversations).where(inArray(conversations.id, convIds)) : [];
  const members = convIds.length
    ? await db
        .select({ conversationId: conversationMembers.conversationId, userId: conversationMembers.userId, role: conversationMembers.role, leftAt: conversationMembers.leftAt })
        .from(conversationMembers)
        .where(inArray(conversationMembers.conversationId, convIds))
    : [];
  // Э7 часть 1: беседы сообщений — подпись дома автора нужна только в группе.
  const msgConvIds = [...new Set(msgs.map((m) => m.conversationId))];
  const groupConvs = new Set(
    msgConvIds.length
      ? (await db.select({ id: conversations.id }).from(conversations).where(and(inArray(conversations.id, msgConvIds), eq(conversations.kind, 'group')))).map((c) => c.id)
      : [],
  );
  const userIds = new Set<string>([...members.map((m) => m.userId), ...msgs.map((m) => m.authorId)]);
  for (const m of msgs) if (m.forwardedFrom?.userId) userIds.add(m.forwardedFrom.userId);
  // G6: и те, кого коснулась служебная запись группы (`serviceWire` даёт им `ref`).
  for (const m of msgs) for (const id of serviceUserIds(m.service)) userIds.add(id);
  const people = new Map<string, UserRef>();
  if (userIds.size > 0) {
    const rowsU = await db
      .select({
        id: users.id,
        homeInstanceId: users.homeInstanceId,
        homeUserId: users.homeUserId,
        username: users.username,
        homeUsername: users.homeUsername,
        displayName: users.displayName,
        homeAvatarHash: users.homeAvatarHash,
      })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const u of rowsU) people.set(u.id, u);
  }
  // Э7 часть 3 (D): дом каждого участника группы — название и домен инстанса, как их знаем мы (по связке): третий дом без связки с
  // получателем иначе подписан «с другого инстанса». Один запрос на выборку.
  const groupHomes = new Map<string, { name: string | null; domain: string }>();
  if (convs.some((c) => c.kind === 'group')) {
    const homeIds = [...new Set([...people.values()].map((u) => u.homeInstanceId).filter((h): h is string => typeof h === 'string'))];
    if (homeIds.length > 0) {
      const rowsL = await db
        .select({ id: federationLinks.instanceId, domain: federationLinks.domain, theirName: federationLinks.theirName, localName: federationLinks.localName })
        .from(federationLinks)
        .where(inArray(federationLinks.instanceId, homeIds));
      for (const l of rowsL) {
        const domain = fedDomain(l.domain);
        if (domain) groupHomes.set(l.id, { name: fedOptionalText((l.localName ?? l.theirName ?? '').trim() || null, FED_FIELD_LIMITS.instanceName), domain });
      }
    }
  }
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  const convById = new Map(convs.map((c) => [c.id, c]));
  // G69: поле `media` — только соседу с `dmmedia1`; старый получает ту же строку без него (в `content` — запасная фраза).
  const mediaOk = msgs.some((m) => m.media)
    ? !!(await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1))[0]?.features.includes(
        FED_FEATURES.dmmedia1,
      )
    : false;
  // Опрос (14.10): `media` опроса — только соседу с `dmpoll1`; с одним `dmmedia1` он получает запасной `content` (как до признака).
  const pollOk = await peerKnowsPolls(msgs, instanceId);
  // Э7 часть 3: реакции/«прочитано»/закреп/«прослушано» группы — своим построителем (хост отдаёт и людей других домов).
  const grouped = await groupMarkConvs(picked);
  const extra = await e2Entities(grouped.size > 0 ? picked.filter((r) => !isGroupMark(r, grouped)) : picked, instanceId, selfInstanceId);
  if (grouped.size > 0) await groupMarkEntities(picked.filter((r) => isGroupMark(r, grouped)), grouped, instanceId, selfInstanceId, extra);

  return picked.map((r): FedConvChange => {
    let entity: Record<string, unknown> | null = null;
    if (r.kind === FED_CONV_CHANGE.msg && r.entityId) {
      const m = msgById.get(r.entityId);
      // Сущность — уже в проводе (snake_case): страница сериализуется как есть (`serializeConvChangesPage`).
      if (m) {
        const wFull = toWireMessage(m, people, selfInstanceId);
        const w = wFull.media && (!mediaOk || (wFull.media.kind === 'poll' && !pollOk)) ? { ...wFull, media: null } : wFull;
        entity = serializeConvMessageWire(w);
        // Э7 часть 1 (§4 п. 1): в группе — подпись дома автора: своё подписываем сейчас, у копии чужого — подпись его дома как есть.
        if (groupConvs.has(m.conversationId) && !m.service) {
          const sig = people.get(m.authorId)?.homeInstanceId ? m.originSig : (groupSigner?.(w) ?? null);
          if (sig) entity = { ...entity, sig };
        }
      }
    } else if (r.kind === FED_CONV_CHANGE.conv) {
      const c = convById.get(r.conversationId);
      const all = members.filter((m) => m.conversationId === r.conversationId);
      // Э7 часть 1: у группы — только действующие участники (ушедший узнаёт о своём уходе по их списку).
      const live = c?.kind === 'group' ? all.filter((m) => !m.leftAt) : all;
      const memberIds = live.map((m) => m.userId);
      if (c) {
        entity = serializeConvWire(toWireConv(c, memberIds, people, selfInstanceId));
        if (c.kind === 'group') {
          const owner = live.find((m) => m.role === 'owner');
          entity = {
            ...entity,
            ...serializeConvGroupExtras({
              version: c.groupVersion,
              avatarUrl: c.avatarUrl,
              owner: owner ? refOf(people.get(owner.userId), owner.userId, selfInstanceId) : null,
              profiles: memberIds.map((id) => {
                const u = people.get(id);
                return {
                  ref: refOf(u, id, selfInstanceId),
                  username: (u?.homeInstanceId ? u.homeUsername : u?.username) || u?.username || id,
                  displayName: u?.displayName ?? '',
                  avatarHash: u?.homeAvatarHash ?? null,
                  ...(u?.homeInstanceId && groupHomes.get(u.homeInstanceId) ? { home: groupHomes.get(u.homeInstanceId) } : {}),
                };
              }),
            }),
          };
        }
      }
    } else {
      entity = extra.get(`${r.conversationId}|${r.kind}|${r.entityId ?? ''}`) ?? null;
    }
    return { seq: Number(r.seq), kind: r.kind, conversationId: r.conversationId, entityId: r.entityId, entity };
  });
}

/**
 * Полный проход по общей беседе для соседа (Э2 часть Б, `GET /fed/v1/conv/:id/export`, §3.3): журнал обрезан (`reset`,
 * Ф12) или связку завели заново. `null` — беседа не общая с этим соседом (нет 1:1 с его человеком) или `after` не из неё.
 *
 * Страница — `FED_CONV_EXPORT_MESSAGES` сообщений беседы по порядку (`sort_key`): своё — строкой `msg` (с надгробием),
 * чужое этого соседа — только надгробием (Ф8); реакции наших людей — строкой `react` на каждое недалённое сообщение (пустая
 * — «снято»); придержанное от нас (`withheld`) соседа не касается. Последняя страница — ещё «прочитано до» и закрепы
 * «у обоих». Сущности — тем же `materialize`, что у журнала: один провод, один приём.
 */
export async function exportForPeer(
  instanceId: string,
  conversationId: string,
  after: string | null,
  selfInstanceId: string,
): Promise<FedConvExportPage | null> {
  const shared = await db.execute(sql`
    SELECT 1 FROM conversation_members cm JOIN users u ON u.id = cm.user_id JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.conversation_id = ${conversationId} AND c.kind = 'direct' AND u.home_instance_id = ${instanceId} LIMIT 1`);
  // Э7 часть 3: не 1:1 — может быть группа (`exportGroupForPeer`).
  if (shared.rows.length === 0) return exportGroupForPeer(instanceId, conversationId, after, selfInstanceId);
  let afterKey = 0;
  if (after) {
    const [a] = await db
      .select({ key: conversationMessages.sortKey })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, after), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);
    if (!a) return null;
    afterKey = Number(a.key);
  }
  const rows = await db
    .select({
      id: conversationMessages.id,
      deletedAt: conversationMessages.deletedAt,
      withheld: conversationMessages.withheld,
      home: users.homeInstanceId,
      media: conversationMessages.media,
    })
    .from(conversationMessages)
    .innerJoin(users, eq(users.id, conversationMessages.authorId))
    .where(and(eq(conversationMessages.conversationId, conversationId), gt(conversationMessages.sortKey, afterKey)))
    .orderBy(asc(conversationMessages.sortKey))
    .limit(FED_CONV_EXPORT_MESSAGES + 1);
  const more = rows.length > FED_CONV_EXPORT_MESSAGES;
  const page = rows.slice(0, FED_CONV_EXPORT_MESSAGES);
  const theirIds = page.filter((m) => m.home === instanceId && !m.deletedAt && !m.withheld).map((m) => m.id);
  const heard = new Set(
    theirIds.length
      ? (
          await db
            .selectDistinct({ messageId: conversationVoiceListens.messageId })
            .from(conversationVoiceListens)
            .innerJoin(users, eq(users.id, conversationVoiceListens.userId))
            .where(and(inArray(conversationVoiceListens.messageId, theirIds), isNull(users.homeInstanceId)))
        ).map((x) => x.messageId)
      : [],
  );
  const picked: PickedRow[] = [];
  const row = (kind: string, entityId: string | null): PickedRow => ({ seq: 0, kind, conversationId, entityId });
  for (const m of page) {
    if (m.home === null) picked.push(row(FED_CONV_CHANGE.msg, m.id));
    else if (m.home === instanceId && m.deletedAt) picked.push(row(FED_CONV_CHANGE.msg, m.id));
    if (!m.deletedAt && !m.withheld && (m.home === null || m.home === instanceId)) picked.push(row(FED_CONV_CHANGE_E2.react, m.id));
    // Э3 часть 3: «прослушано» нашими людьми — только на сообщения соседа (своё наш человек не слушает) и только где оно есть:
    // у такого сообщения нет строки `msg`, так что строк на сообщение по-прежнему не больше двух (предел разбора страницы).
    if (!m.deletedAt && !m.withheld && m.home === instanceId && heard.has(m.id)) picked.push(row(FED_CONV_CHANGE_E2.listen, m.id));
    // Опрос (14.10, `dmpoll1`): голоса наших людей — строкой на каждый опрос (пустая — «никто», снимает отменённое за разрыв, как
    // `react`). Опрос не голосовое — `listen` у него нет: строк на сообщение не больше трёх (`msg`/`react`/`pollvote`), опросов мало.
    if (!m.deletedAt && !m.withheld && m.media?.kind === 'poll') picked.push(row(FED_CONV_CHANGE_E2.vote, m.id));
  }
  if (!more) {
    picked.push(row(FED_CONV_CHANGE.read, null));
    const pins = await db
      .selectDistinct({ messageId: conversationPins.messageId })
      .from(conversationPins)
      .innerJoin(users, eq(users.id, conversationPins.userId))
      .where(and(eq(conversationPins.conversationId, conversationId), eq(conversationPins.forBoth, true), eq(users.homeInstanceId, instanceId)));
    for (const p of pins) picked.push(row(FED_CONV_CHANGE.pin, p.messageId));
  }
  const items = await materialize(picked, instanceId, selfInstanceId);
  return { instanceId: selfInstanceId, conversationId, next: more ? page[page.length - 1].id : null, items };
}

/** Признак групп у связки соседа: без `dmgroup1` группы ему не отдаются вовсе (он их не примет). */
async function peerKnowsGroups(instanceId: string): Promise<boolean> {
  const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  return !!link?.features.includes(FED_FEATURES.dmgroup1);
}

/**
 * Э7 часть 3 (`GET /fed/v1/conv/groups`): группы, чей хост — мы, где у соседа есть люди — действующие или бывшие. Полный проход
 * дома участника берёт по списку каждую через `exportForPeer`. `null` — сосед без `dmgroup1` (маршрут ответит 404, как раньше).
 */
export async function groupsForPeer(instanceId: string): Promise<string[] | null> {
  if (!(await peerKnowsGroups(instanceId))) return null;
  const res = await db.execute(sql`
    SELECT DISTINCT gm.conversation_id AS cid FROM conversation_members gm JOIN users gu ON gu.id = gm.user_id
    JOIN conversations gc ON gc.id = gm.conversation_id
    WHERE gc.kind = 'group' AND gc.origin_instance_id IS NULL AND gu.home_instance_id = ${instanceId}
    ORDER BY gm.conversation_id LIMIT ${FED_CONV_GROUPS_MAX}`);
  return (res.rows as { cid: string }[]).map((r) => r.cid);
}

/**
 * Э7 часть 3: полный проход по группе (`GET /fed/v1/conv/:id/export`, ветка не-1:1 `exportForPeer`). Только соседу с
 * `dmgroup1`; страница — `FED_CONV_EXPORT_MESSAGES` сообщений по порядку хоста, `after`/`next` — как у 1:1.
 * - Мы хост, у соседа в группе есть люди: первая страница начинается строкой `conv` (состав, версия — дом участника заведёт
 *   группу, если не знал о ней), дальше сообщения — тем же отбором, что журнал хоста (`recordFedConvChanges`): всё, кроме живой
 *   копии сообщения самого соседа (служебная запись и надгробие — и ему). Окно — правило местной группы (`sharedMediaScope`,
 *   `history` с `former`): есть действующий человек соседа — вся история (вернувшийся видит и время своего отсутствия, как в
 *   местной группе: `addGroupMembers` сбрасывает `hiddenKey`); все его люди вышли — только до последнего ухода (`created_at <= left_at`).
 * - Группа соседа (мы дом участника, спрашивает хост): только сообщения наших людей (и их надгробия), как журнал участника.
 * - Соседу с `dmgroupmarks1` (и пока у него есть действующие люди) — ещё отметки: реакции/закреп/«прослушано» строкой на
 *   сообщение окна, где они есть (`groupExportMarks`), на последней странице — «прочитано до»; содержимое — `groupMarkEntities`,
 *   ровно как в журнале. Строк на страницу — не больше `GROUP_EXPORT_ITEMS` (лишнее — следующей страницей).
 */
export async function exportGroupForPeer(
  instanceId: string,
  conversationId: string,
  after: string | null,
  selfInstanceId: string,
): Promise<FedConvExportPage | null> {
  if (!(await peerKnowsGroups(instanceId))) return null;
  const [c] = await db
    .select({ kind: conversations.kind, origin: conversations.originInstanceId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!c || c.kind !== 'group') return null;
  const hosting = c.origin === null;
  if (!hosting && c.origin !== instanceId) return null;
  let window: SQL | null = null;
  if (hosting) {
    const theirs = await db.execute(sql`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE gm.left_at IS NULL)::int AS live
      FROM conversation_members gm JOIN users gu ON gu.id = gm.user_id
      WHERE gm.conversation_id = ${conversationId} AND gu.home_instance_id = ${instanceId}`);
    const t = theirs.rows[0] as { n: number; live: number } | undefined;
    if (!t || Number(t.n) === 0) return null;
    // Все люди соседа вышли — как бывшему в местной группе: только до ухода (последнего из его людей).
    if (Number(t.live) === 0) {
      window = sql`${conversationMessages.createdAt} <= (SELECT max(gl.left_at) FROM conversation_members gl JOIN users ul ON ul.id = gl.user_id
        WHERE gl.conversation_id = ${conversationId} AND ul.home_instance_id = ${instanceId})`;
    }
  }
  let afterKey = 0;
  if (after) {
    const [a] = await db
      .select({ key: conversationMessages.sortKey })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, after), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);
    if (!a) return null;
    afterKey = Number(a.key);
  }
  const rows = await db
    .select({
      id: conversationMessages.id,
      deletedAt: conversationMessages.deletedAt,
      withheld: conversationMessages.withheld,
      service: conversationMessages.service,
      home: users.homeInstanceId,
    })
    .from(conversationMessages)
    .innerJoin(users, eq(users.id, conversationMessages.authorId))
    .where(and(eq(conversationMessages.conversationId, conversationId), gt(conversationMessages.sortKey, afterKey), ...(window ? [window] : [])))
    .orderBy(asc(conversationMessages.sortKey))
    .limit(FED_CONV_EXPORT_MESSAGES + 1);
  let more = rows.length > FED_CONV_EXPORT_MESSAGES;
  let page = rows.slice(0, FED_CONV_EXPORT_MESSAGES);
  // Отметки (шов частей A и B): только соседу с `dmgroupmarks1` и только пока у него есть действующие люди (бывшему — нет,
  // как журнал: строки отметок идут домам действующих участников).
  const marks = window === null && (await peerKnowsGroupMarks(instanceId)) ? await groupExportMarks(conversationId, hosting, instanceId, page) : null;
  const picked: PickedRow[] = [];
  const row = (kind: string, entityId: string | null): PickedRow => ({ seq: 0, kind, conversationId, entityId });
  if (hosting && !after) picked.push(row(FED_CONV_CHANGE.conv, null));
  for (let i = 0; i < page.length; i += 1) {
    const m = page[i];
    const start = picked.length;
    if (hosting) {
      const ownLiveCopy = m.home === instanceId && !m.deletedAt && !m.service;
      if (!ownLiveCopy && !(m.withheld && m.home !== null)) picked.push(row(FED_CONV_CHANGE.msg, m.id));
    } else if (m.home === null && !m.service) {
      picked.push(row(FED_CONV_CHANGE.msg, m.id));
    }
    if (!marks || m.deletedAt || m.withheld) continue;
    if (marks.react.has(m.id)) picked.push(row(FED_CONV_CHANGE_E2.react, m.id));
    if (marks.pin.has(m.id)) picked.push(row(FED_CONV_CHANGE.pin, m.id));
    // Опрос (`dmpoll1`): голоса владельцев — где они есть (опрос не голосовое: строк на сообщение по-прежнему не больше четырёх).
    if (marks.vote.has(m.id)) picked.push(row(FED_CONV_CHANGE_E2.vote, m.id));
    // «Прослушано» — как журнал: хост — только на сообщения людей адресата; участник хосту — на чужие (хост перешлёт дому автора).
    if (marks.listen.has(m.id) && (hosting ? m.home === instanceId : m.home !== null)) picked.push(row(FED_CONV_CHANGE_E2.listen, m.id));
    // Предел разбора страницы у получателя (`EXPORT_ITEMS_MAX`): не влезает — сообщение и остаток уходят следующей страницей.
    if (i > 0 && picked.length + 1 > GROUP_EXPORT_ITEMS) {
      picked.length = start;
      page = page.slice(0, i);
      more = true;
      break;
    }
  }
  if (marks && !more) picked.push(row(FED_CONV_CHANGE.read, null));
  const items = await materialize(picked, instanceId, selfInstanceId);
  // Хвост Э7 (14.10): отметки отдавались — они полные (`marksComplete`): получатель снимет те, которых в выгрузке не было.
  const complete = marks && (await marksWhole(instanceId)) ? { marksComplete: true as const } : {};
  return { instanceId: selfInstanceId, conversationId, next: more ? page[page.length - 1].id : null, items, ...complete };
}

/** Строк на страницу экспорта группы с отметками: до четырёх на сообщение плюс `conv`/`read` — ниже предела разбора (`* 2 + LIST_MAX + 1`). */
const GROUP_EXPORT_ITEMS = FED_CONV_EXPORT_MESSAGES * 4;

/**
 * Хвост Э7 (14.10): отметки страницы можно объявить полными (`marksComplete`), только если `materialize` не отрежет ни один их вид
 * по признакам связки (`KIND_FEATURE`, напр. `listen` без `dm2once`) — иначе «полная» выгрузка без строк сняла бы их у получателя.
 */
async function marksWhole(instanceId: string): Promise<boolean> {
  const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  const has = new Set(link?.features ?? []);
  // Голоса в опросе (`pollvote`) не в счёт: сосед без `dmpoll1` опросов не знает (у него текст) — снимать ему нечего.
  return Object.entries(KIND_FEATURE).every(([kind, f]) => !f || kind === FED_CONV_CHANGE_E2.vote || has.has(f));
}

/** Э7 часть 3: признак отметок групп у связки соседа (`dmgroupmarks1`) — без него экспорт группы прежний, только `conv`/`msg`. */
async function peerKnowsGroupMarks(instanceId: string): Promise<boolean> {
  const [link] = await db.select({ features: federationLinks.features }).from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  return !!link?.features.includes(FED_FEATURES.dmgroupmarks1);
}

/**
 * Э7 часть 3: у каких сообщений страницы экспорта группы есть отметки, которые мы отдаём адресату `peer` (те же владельцы, что у
 * `groupMarkEntities`: хост — действующие участники, кроме людей адресата; дом участника — свои местные действующие). Строка
 * экспорта — только где отметка есть (сообщения без реакций не раздуваем); содержимое строит `materialize` → `groupMarkEntities`.
 */
async function groupExportMarks(
  conversationId: string,
  hosting: boolean,
  peer: string,
  page: readonly { id: string }[],
): Promise<{ react: Set<string>; listen: Set<string>; pin: Set<string>; vote: Set<string> }> {
  const out = { react: new Set<string>(), listen: new Set<string>(), pin: new Set<string>(), vote: new Set<string>() };
  const ids = page.map((m) => m.id);
  if (ids.length === 0) return out;
  const live = await db
    .select({ id: users.id, home: users.homeInstanceId })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)));
  const who = live.filter((m) => (hosting ? m.home !== peer : m.home === null)).map((m) => m.id);
  if (who.length === 0) return out;
  const reacted = await db
    .selectDistinct({ messageId: conversationMessageReactions.messageId })
    .from(conversationMessageReactions)
    .where(and(inArray(conversationMessageReactions.messageId, ids), inArray(conversationMessageReactions.userId, who)));
  for (const r of reacted) out.react.add(r.messageId);
  const heard = await db
    .selectDistinct({ messageId: conversationVoiceListens.messageId })
    .from(conversationVoiceListens)
    .where(and(inArray(conversationVoiceListens.messageId, ids), inArray(conversationVoiceListens.userId, who)));
  for (const r of heard) out.listen.add(r.messageId);
  const pinned = await db
    .selectDistinct({ messageId: conversationPins.messageId })
    .from(conversationPins)
    .where(
      and(
        eq(conversationPins.conversationId, conversationId),
        inArray(conversationPins.messageId, ids),
        eq(conversationPins.forBoth, true),
        inArray(conversationPins.userId, who),
      ),
    );
  for (const r of pinned) out.pin.add(r.messageId);
  const voted = await db
    .selectDistinct({ messageId: convPollVotes.messageId })
    .from(convPollVotes)
    .where(and(inArray(convPollVotes.messageId, ids), inArray(convPollVotes.userId, who)));
  for (const r of voted) out.vote.add(r.messageId);
  return out;
}

/**
 * Э2: сущности реакций, «прочитано до» и закрепа «у обоих» — ТЕКУЩЕЕ состояние того, чем владеют наши люди (§3.2):
 * - `react` — все реакции наших людей (местных, `home_instance_id IS NULL`) на сообщение;
 * - `read` — для каждого нашего участника беседы последнее прочитанное сообщение АВТОРА-ЧЕЛОВЕКА ЭТОГО СОСЕДА (копия у нас, не
 *   придержанная) — по id: ключи порядка у домов свои. Своё читатель не «читает»: раньше уходило и оно, а у соседа порядок другой,
 *   и его последнее своё накрывало там ещё не прочитанные сообщения соседа — ложные ✓✓ (исправления ревью 12.10, п. 4);
 * - `pin` — закреплено ли сообщение у человека соседа на нашей стороне (строка «у обоих»), и кем.
 * Ключ карты — `conversationId|kind|entityId`.
 */
async function e2Entities(
  picked: readonly { conversationId: string; kind: string; entityId: string | null }[],
  peerInstanceId: string,
  selfInstanceId: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const key = (c: string, k: string, e: string | null) => `${c}|${k}|${e ?? ''}`;
  const reactIds = picked.filter((r) => r.kind === FED_CONV_CHANGE_E2.react && r.entityId).map((r) => r.entityId as string);
  if (reactIds.length > 0) {
    const rows = await db
      .select({ messageId: conversationMessageReactions.messageId, userId: conversationMessageReactions.userId, emoji: conversationMessageReactions.emoji })
      .from(conversationMessageReactions)
      .innerJoin(users, eq(users.id, conversationMessageReactions.userId))
      .where(and(inArray(conversationMessageReactions.messageId, reactIds), isNull(users.homeInstanceId)));
    for (const r of picked) {
      if (r.kind !== FED_CONV_CHANGE_E2.react || !r.entityId) continue;
      const mine = rows.filter((x) => x.messageId === r.entityId);
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvReactionsWire({
          messageId: r.entityId,
          reactions: mine.map((x) => ({ user: { instanceId: selfInstanceId, userId: x.userId }, emoji: x.emoji })),
        }),
      );
    }
  }
  // Опрос (`dmpoll1`): голоса наших людей (местных) — пусто, если никто не голосовал (строка всё равно отдаётся: снимает отменённое).
  const voteIds = picked.filter((r) => r.kind === FED_CONV_CHANGE_E2.vote && r.entityId).map((r) => r.entityId as string);
  if (voteIds.length > 0) {
    const rows = await db
      .select({ messageId: convPollVotes.messageId, userId: convPollVotes.userId, optionId: convPollVotes.optionId })
      .from(convPollVotes)
      .innerJoin(users, eq(users.id, convPollVotes.userId))
      .where(and(inArray(convPollVotes.messageId, voteIds), isNull(users.homeInstanceId)))
      .orderBy(asc(convPollVotes.createdAt), asc(convPollVotes.optionId));
    for (const r of picked) {
      if (r.kind !== FED_CONV_CHANGE_E2.vote || !r.entityId) continue;
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvPollVotesWire({ messageId: r.entityId, voters: votersOf(rows.filter((x) => x.messageId === r.entityId), (id) => ({ instanceId: selfInstanceId, userId: id })) }),
      );
    }
  }
  for (const r of picked) {
    if (r.kind !== FED_CONV_CHANGE.read) continue;
    const res = await db.execute(sql`
      SELECT cm.user_id AS user_id, (
        SELECT m.id FROM conversation_messages m LEFT JOIN users a ON a.id = m.author_id
        WHERE m.conversation_id = cm.conversation_id AND m.sort_key <= cm.last_read_key AND NOT m.withheld
          AND a.home_instance_id = ${peerInstanceId}
        ORDER BY m.sort_key DESC LIMIT 1) AS message_id
      FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ${r.conversationId} AND u.home_instance_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_blocks b JOIN users bu ON bu.id = b.blocked_id
          JOIN conversation_members cb ON cb.user_id = b.blocked_id AND cb.conversation_id = cm.conversation_id
          WHERE b.blocker_id = cm.user_id AND bu.home_instance_id = ${peerInstanceId})`);
    const reads = (res.rows as { user_id: string; message_id: string | null }[])
      .filter((x) => typeof x.message_id === 'string')
      .map((x) => ({ user: { instanceId: selfInstanceId, userId: x.user_id }, messageId: x.message_id as string }));
    out.set(key(r.conversationId, r.kind, r.entityId), serializeConvReadsWire({ reads }));
  }
  // Э3 часть 3: `listen` — наши люди (местные), прослушавшие голосовое или кружок; пусто — никто (строка всё равно отдаётся).
  const listenIds = picked.filter((r) => r.kind === FED_CONV_CHANGE_E2.listen && r.entityId).map((r) => r.entityId as string);
  if (listenIds.length > 0) {
    const rows = await db
      .select({ messageId: conversationVoiceListens.messageId, userId: conversationVoiceListens.userId })
      .from(conversationVoiceListens)
      .innerJoin(users, eq(users.id, conversationVoiceListens.userId))
      .where(and(inArray(conversationVoiceListens.messageId, listenIds), isNull(users.homeInstanceId)));
    const spent = new Set(
      (
        await db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(and(inArray(conversationMessages.id, listenIds), isNotNull(conversationMessages.onceSpentAt)))
      ).map((x) => x.id),
    );
    for (const r of picked) {
      if (r.kind !== FED_CONV_CHANGE_E2.listen || !r.entityId) continue;
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvListenWire({
          messageId: r.entityId,
          listeners: rows.filter((x) => x.messageId === r.entityId).map((x) => ({ instanceId: selfInstanceId, userId: x.userId })),
          spent: spent.has(r.entityId),
        }),
      );
    }
  }
  const pinIds = picked.filter((r) => r.kind === FED_CONV_CHANGE.pin && r.entityId).map((r) => r.entityId as string);
  if (pinIds.length > 0) {
    const rows = await db
      .select({ messageId: conversationPins.messageId, pinnedBy: conversationPins.pinnedBy })
      .from(conversationPins)
      .innerJoin(users, eq(users.id, conversationPins.userId))
      .where(and(inArray(conversationPins.messageId, pinIds), eq(users.homeInstanceId, peerInstanceId), eq(conversationPins.forBoth, true)));
    const byIds = [...new Set(rows.map((x) => x.pinnedBy).filter((x): x is string => !!x))];
    const who = byIds.length
      ? await db.select({ id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId }).from(users).where(inArray(users.id, byIds))
      : [];
    const whoById = new Map(who.map((u) => [u.id, u]));
    for (const r of picked) {
      if (r.kind !== FED_CONV_CHANGE.pin || !r.entityId) continue;
      const row = rows.find((x) => x.messageId === r.entityId);
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvPinWire({
          messageId: r.entityId,
          pinned: !!row,
          by: row?.pinnedBy ? refOf(whoById.get(row.pinnedBy), row.pinnedBy, selfInstanceId) : null,
        }),
      );
    }
  }
  return out;
}

/** Опрос: строки голосов (по порядку голосования) → человек и его варианты. */
function votersOf(rows: readonly { userId: string; optionId: string }[], ref: (userId: string) => FedPersonRef): { user: FedPersonRef; options: string[] }[] {
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.userId, [...(by.get(r.userId) ?? []), r.optionId]);
  return [...by].map(([userId, options]) => ({ user: ref(userId), options }));
}

// ─── Э7 часть 3: реакции, «прочитано», «прослушано» в группе со смешанным составом ────────────────────────────────────

/** Строка группы, сущность которой строит `groupMarkEntities`. */
function isGroupMark(r: { conversationId: string; kind: string }, grouped: ReadonlyMap<string, { host: boolean }>): boolean {
  return grouped.has(r.conversationId) && MARK_KINDS.has(r.kind);
}

/** Группы среди строк `GROUP_MARK_KINDS`: `host` — мы её дом (`origin_instance_id IS NULL`). */
async function groupMarkConvs(picked: readonly { conversationId: string; kind: string }[]): Promise<Map<string, { host: boolean }>> {
  const ids = [...new Set(picked.filter((r) => MARK_KINDS.has(r.kind)).map((r) => r.conversationId))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: conversations.id, origin: conversations.originInstanceId })
    .from(conversations)
    .where(and(inArray(conversations.id, ids), eq(conversations.kind, 'group')));
  return new Map(rows.map((c) => [c.id, { host: c.origin === null }]));
}

/**
 * Э7 часть 3 (#141, §3.6), звезда: ТЕКУЩЕЕ состояние того, чем владеет отдающий, глазами адресата `peer`.
 * - Мы дом участника (адресат — хост): владеем только своими людьми (местные), как в 1:1; «прочитано до» — последнее
 *   прочитанное сообщение ЛЮБОГО чужого автора (в группе пишут люди многих домов, не только хоста).
 * - Мы хост: владеем всеми, кроме людей адресата, — свои и люди третьих домов (их реакции/«прочитано»/«прослушано» к нам
 *   пришли от их домов); «прочитано до» — последнее прочитанное сообщение автора-человека адресата (порядок у домов свой).
 * - Закреп «для всех» — есть ли строка «для всех» у кого-то из действующих участников, чьё состояние мы отдаём (в группе
 *   хозяин закрепа — сама группа; в 1:1 смотрится строка людей адресата, но людей хоста в группе может не остаться).
 * Только действующие участники. Ссылка на человека третьего дома — его домашняя личность (`refOf`).
 */
async function groupMarkEntities(
  picked: readonly { conversationId: string; kind: string; entityId: string | null }[],
  grouped: ReadonlyMap<string, { host: boolean }>,
  peer: string,
  selfInstanceId: string,
  out: Map<string, Record<string, unknown>>,
): Promise<void> {
  if (picked.length === 0) return;
  const key = (c: string, k: string, e: string | null) => `${c}|${k}|${e ?? ''}`;
  const convIds = [...new Set(picked.map((r) => r.conversationId))];
  const live = await db
    .select({ conversationId: conversationMembers.conversationId, id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(and(inArray(conversationMembers.conversationId, convIds), isNull(conversationMembers.leftAt)));
  // Чьё состояние отдаём в этой группе: участник — своих местных; хост — всех, кроме людей адресата.
  const owners = (conversationId: string): Map<string, UserRef> => {
    const host = grouped.get(conversationId)?.host === true;
    return new Map(
      live
        .filter((m) => m.conversationId === conversationId && (host ? m.homeInstanceId !== peer : m.homeInstanceId === null))
        .map((m) => [m.id, { id: m.id, homeInstanceId: m.homeInstanceId, homeUserId: m.homeUserId }]),
    );
  };
  const reactIds = picked.filter((r) => r.kind === FED_CONV_CHANGE_E2.react && r.entityId).map((r) => r.entityId as string);
  const reactRows = reactIds.length
    ? await db
        .select({ messageId: conversationMessageReactions.messageId, userId: conversationMessageReactions.userId, emoji: conversationMessageReactions.emoji })
        .from(conversationMessageReactions)
        .where(inArray(conversationMessageReactions.messageId, reactIds))
    : [];
  const listenIds = picked.filter((r) => r.kind === FED_CONV_CHANGE_E2.listen && r.entityId).map((r) => r.entityId as string);
  const listenRows = listenIds.length
    ? await db
        .select({ messageId: conversationVoiceListens.messageId, userId: conversationVoiceListens.userId })
        .from(conversationVoiceListens)
        .where(inArray(conversationVoiceListens.messageId, listenIds))
    : [];
  const voteIds = picked.filter((r) => r.kind === FED_CONV_CHANGE_E2.vote && r.entityId).map((r) => r.entityId as string);
  const voteRows = voteIds.length
    ? await db
        .select({ messageId: convPollVotes.messageId, userId: convPollVotes.userId, optionId: convPollVotes.optionId })
        .from(convPollVotes)
        .where(inArray(convPollVotes.messageId, voteIds))
        .orderBy(asc(convPollVotes.createdAt), asc(convPollVotes.optionId))
    : [];
  const pinIds = picked.filter((r) => r.kind === FED_CONV_CHANGE.pin && r.entityId).map((r) => r.entityId as string);
  const pinRows = pinIds.length
    ? await db
        .select({ messageId: conversationPins.messageId, userId: conversationPins.userId, pinnedBy: conversationPins.pinnedBy })
        .from(conversationPins)
        .where(and(inArray(conversationPins.messageId, pinIds), eq(conversationPins.forBoth, true)))
    : [];
  const pinnerIds = [...new Set(pinRows.map((x) => x.pinnedBy).filter((x): x is string => !!x))];
  const pinners = new Map(
    (pinnerIds.length
      ? await db.select({ id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId }).from(users).where(inArray(users.id, pinnerIds))
      : []
    ).map((u) => [u.id, u]),
  );
  for (const r of picked) {
    const who = owners(r.conversationId);
    if (r.kind === FED_CONV_CHANGE.pin && r.entityId) {
      const row = pinRows.find((x) => x.messageId === r.entityId && who.has(x.userId));
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvPinWire({
          messageId: r.entityId,
          pinned: !!row,
          by: row?.pinnedBy ? refOf(pinners.get(row.pinnedBy), row.pinnedBy, selfInstanceId) : null,
        }),
      );
      continue;
    }
    if (r.kind === FED_CONV_CHANGE_E2.react && r.entityId) {
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvReactionsWire({
          messageId: r.entityId,
          reactions: reactRows
            .filter((x) => x.messageId === r.entityId && who.has(x.userId))
            .map((x) => ({ user: refOf(who.get(x.userId), x.userId, selfInstanceId), emoji: x.emoji })),
        }),
      );
    } else if (r.kind === FED_CONV_CHANGE_E2.listen && r.entityId) {
      // «Один раз» в группах не бывает (`onceOk` — только 1:1): `spent` всегда ложь.
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvListenWire({
          messageId: r.entityId,
          listeners: listenRows.filter((x) => x.messageId === r.entityId && who.has(x.userId)).map((x) => refOf(who.get(x.userId), x.userId, selfInstanceId)),
          spent: false,
        }),
      );
    } else if (r.kind === FED_CONV_CHANGE_E2.vote && r.entityId) {
      // Опрос (`dmpoll1`): голоса владельцев (участник — свои местные, хост — все, кроме людей адресата).
      out.set(
        key(r.conversationId, r.kind, r.entityId),
        serializeConvPollVotesWire({
          messageId: r.entityId,
          voters: votersOf(voteRows.filter((x) => x.messageId === r.entityId && who.has(x.userId)), (id) => refOf(who.get(id), id, selfInstanceId)),
        }),
      );
    } else if (r.kind === FED_CONV_CHANGE.read) {
      const host = grouped.get(r.conversationId)?.host === true;
      const authors = host ? sql`a.home_instance_id = ${peer}` : sql`a.home_instance_id IS NOT NULL`;
      const res = await db.execute(sql`
        SELECT cm.user_id AS user_id, (
          SELECT m.id FROM conversation_messages m LEFT JOIN users a ON a.id = m.author_id
          WHERE m.conversation_id = cm.conversation_id AND m.sort_key <= cm.last_read_key AND NOT m.withheld AND ${authors}
          ORDER BY m.sort_key DESC LIMIT 1) AS message_id
        FROM conversation_members cm
        WHERE cm.conversation_id = ${r.conversationId} AND cm.left_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_blocks b JOIN users bu ON bu.id = b.blocked_id
            JOIN conversation_members cb ON cb.user_id = b.blocked_id AND cb.conversation_id = cm.conversation_id
            WHERE b.blocker_id = cm.user_id AND bu.home_instance_id = ${peer})`);
      const reads = (res.rows as { user_id: string; message_id: string | null }[])
        .filter((x) => typeof x.message_id === 'string' && who.has(x.user_id))
        .map((x) => ({ user: refOf(who.get(x.user_id), x.user_id, selfInstanceId), messageId: x.message_id as string }));
      out.set(key(r.conversationId, r.kind, r.entityId), serializeConvReadsWire({ reads }));
    }
  }
}

/** Строка беседы → провод (`FedConvWire`). */
export function toWireConv(
  c: typeof conversations.$inferSelect,
  memberIds: readonly string[],
  people: ReadonlyMap<string, UserRef>,
  selfInstanceId: string,
): FedConvWire {
  return {
    id: c.id,
    kind: c.kind,
    originInstanceId: c.originInstanceId ?? selfInstanceId,
    createdAt: c.createdAt.getTime(),
    members: memberIds.map((id) => refOf(people.get(id), id, selfInstanceId)),
    title: c.title,
  };
}
