/**
 * ЛС между инстансами, Э2 часть Б (#141, `docs/dm/FEDERATION.md` §1.6, Ф7): связка с инстансом собеседника и беседы с его
 * людьми.
 *
 * «Связка не работает» (`brokenHomes`) — у нас строка связки не `active` (пауза, разрыв, потеря доверия, нет строки) или вся
 * федерация на аварийной паузе; у соседа — его явный отказ на наш забор журнала (`federation.paused` / `server_closed` /
 * `trust_lost`, `notePeerAnswer`): о своей паузе сосед не рассылает (канал событий сам на паузе), узнаём по ответу.
 * Тогда беседа — архив только для чтения: в сводке `fedLink: 'broken'` (`conversations.summariesFor`, крючок
 * `linkBroken`), запись — 403 `federation.dm_link_broken` (`routes/conv.ts` `fedLinkRefused`).
 *
 * Перемену видит `refreshFedLinks` (после смены связки — `links.onLinksChanged`, после аварийной паузы, после ответа соседа и
 * раз в `REFRESH_EVERY_MS` — страховка путей, пишущих связку мимо `links.ts`): людям бесед с этим инстансом — строка
 * журнала `conv` и `conv.change` с новой сводкой; связка снова рабочая — `onLinkRestored` (забор пропущенного и звонок соседу,
 * чтобы и он снял отметку у себя, `convAccept.startConvPull`).
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { FED_ERRORS } from '@gusvoice/shared';
import { deliver, journal, type Delivery } from '../conversations.js';
import { db } from '../db/index.js';
import { conversationMessages, federationLinks, fedConvSync, users } from '../db/schema.js';
import { readInstanceMeta } from './instanceMeta.js';
import { sendReport } from './instanceBan.js';

/** Страховочная сверка состояния связок (переходы мимо `links.ts`, напр. потеря доверия в `revocation.ts`). */
const REFRESH_EVERY_MS = 30_000;
/** Отказы соседа, означающие «связка у него не работает» (§5.1, `linkVerdict`). */
const REFUSALS = new Set<string>([FED_ERRORS.paused, FED_ERRORS.serverClosed, FED_ERRORS.trustLost]);

/** Сосед отказал нашему забору: instanceId → код. В памяти: после рестарта первый же забор (5 с) заполнит заново. */
const refusedBy = new Map<string, string>();

/**
 * Исправления ревью 12.10, п. 7: «Сообщения ждут, пока «X» их заберёт». Сосед не забирает журнал на связку дольше
 * `STALE_AFTER_MS` при том, что забирать есть что, — в сводке беседы `fedStale: true` (плашка над полем, писать можно).
 * Признаки: незабранная строка журнала старше `STALE_AFTER_MS` (подтверждённое — `fed_conv_sync.acked_seq`, пишет
 * `notePeerPull`), либо наш забор у него упирается в часы (401 `clock-skew` / `expired`) или в отсутствие маршрута (404 — у него
 * выключены ЛС) дольше того же срока: так же не сможет и он у нас.
 */
const STALE_AFTER_MS = 10 * 60_000;
/** Наш забор у соседа упирается в часы / 404: instanceId → с какого времени. */
const pullProblemSince = new Map<string, number>();
/**
 * Э7 часть 3 (D): сосед НЕ ОТВЕЧАЕТ нашему забору журнала (сеть, таймаут, 5xx): instanceId → с какого времени. Любой ответ ниже 500
 * (даже отказ) снимает отметку. Для группы чужого дома это и есть «хост лежит» (`silentHomes`, `ConvSummary.fedGroupHost.down`):
 * забор идёт раз в 2 минуты по всем связкам (`convAccept.startConvPull`), так что 10 минут молчания = пять неудачных заходов подряд.
 */
const pullDownSince = new Map<string, number>();

/**
 * Ответ соседа на наш подписанный запрос журнала (`convAccept.pullConvChanges`): 2xx снимает отметку отказа, явный отказ
 * связки ставит. Сеть, 5xx, 404 — не отказ (сосед лежит или без ЛС: беседа живёт, как в Ф10).
 */
export function notePeerAnswer(instanceId: string, status: number | null, body: string | null): void {
  if (status === null || status >= 500) {
    if (!pullDownSince.has(instanceId)) pullDownSince.set(instanceId, Date.now());
  } else {
    pullDownSince.delete(instanceId);
  }
  if (status !== null && status >= 200 && status < 300) {
    pullProblemSince.delete(instanceId);
    if (refusedBy.delete(instanceId)) void refreshFedLinks();
    return;
  }
  // 404 копит срок и с пустым телом (находка Codex R201): у соседа без ЛС тела ответа может не быть вовсе.
  if (status === 404 && !body) {
    if (!pullProblemSince.has(instanceId)) pullProblemSince.set(instanceId, Date.now());
    return;
  }
  if (status === null || status < 400 || status >= 500 || !body) return;
  let code: unknown = null;
  try {
    code = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    code = null;
  }
  // п. 7: не отказ связки, но и забирать у нас он, скорее всего, не может — копим срок для плашки «ждут».
  if (status === 404 || (status === 401 && (code === 'clock-skew' || code === 'expired'))) {
    if (!pullProblemSince.has(instanceId)) pullProblemSince.set(instanceId, Date.now());
    return;
  }
  if (typeof code !== 'string' || !REFUSALS.has(code) || refusedBy.get(instanceId) === code) return;
  refusedBy.set(instanceId, code);
  void refreshFedLinks();
}

/**
 * Из этих инстансов — те, связка с которыми не работает (у нас или по отказу соседа). `q` — транзакция вызывающего: список бесед
 * (`summariesFor`) держит свою, и чтение мимо неё ждало бы второе соединение пула (на одном соединении — вечно).
 */
export async function brokenHomes(homes: readonly string[], q: Pick<typeof db, 'select'> = db): Promise<Set<string>> {
  const uniq = [...new Set(homes)];
  if (uniq.length === 0) return new Set();
  if ((await readInstanceMeta(q)).paused) return new Set(uniq);
  const rows = await q
    .select({ id: federationLinks.instanceId, state: federationLinks.state })
    .from(federationLinks)
    .where(inArray(federationLinks.instanceId, uniq));
  const active = new Set(rows.filter((r) => r.state === 'active').map((r) => r.id));
  return new Set(uniq.filter((h) => !active.has(h) || refusedBy.has(h)));
}

/**
 * п. 7: сосед забрал наш журнал (`GET /fed/v1/conv/changes?since=`, крючок `routes/federation.configureFedConvPeerSeen`): `since` —
 * его курсор, всё до этого номера он применил. Только вперёд. Перемену плашки разошлёт ближайшая сверка (`refreshFedLinks`).
 */
export async function notePeerPull(instanceId: string, since: number): Promise<void> {
  await db
    .update(fedConvSync)
    .set({ ackedSeq: sql`GREATEST(${fedConvSync.ackedSeq}, ${since})`, ackedAt: new Date() })
    .where(eq(fedConvSync.instanceId, instanceId));
  if (known && staleKnown?.has(instanceId)) void refreshFedLinks();
}

/**
 * п. 7: из этих инстансов — те, что не забирают у нас дольше `STALE_AFTER_MS`, хотя есть что (строки журнала по беседам, где у
 * них сейчас есть участник, — как отдаёт `changesForPeer`). `q` — транзакция вызывающего (как у `brokenHomes`).
 */
export async function staleHomes(homes: readonly string[], q: Pick<typeof db, 'select' | 'execute'> = db): Promise<Set<string>> {
  const uniq = [...new Set(homes)];
  if (uniq.length === 0) return new Set();
  const out = new Set<string>();
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const res = await q.execute(sql`
    SELECT s.instance_id AS id FROM fed_conv_sync s
    WHERE s.instance_id IN (${sql.join(uniq.map((h) => sql`${h}`), sql`, `)}) AND s.seq > s.acked_seq AND EXISTS (
      SELECT 1 FROM fed_conv_changes c WHERE c.instance_id = s.instance_id AND c.seq > s.acked_seq AND c.at < ${cutoff}
        AND EXISTS (SELECT 1 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                    WHERE cm.conversation_id = c.conversation_id AND u.home_instance_id = s.instance_id))`);
  for (const r of res.rows as { id: string }[]) out.add(r.id);
  const now = Date.now();
  for (const h of uniq) {
    const since = pullProblemSince.get(h);
    if (since !== undefined && now - since > STALE_AFTER_MS) out.add(h);
  }
  return out;
}

/**
 * Э7 часть 3 (D): из этих инстансов — домов групп — те, что «не отвечают» дольше `STALE_AFTER_MS`: либо наш забор у них молчит
 * (`pullDownSince`: сеть / 5xx), либо они не забирают наше (`staleHomes`: незабранные строки журнала, часы, 404). Плашка группы
 * «Инстанс «X», где живёт группа, недоступен» (`fedGroupHost.down`) показывается и при разорванной связке (`brokenHomes`), и при этом.
 */
export async function silentHomes(homes: readonly string[], q: Pick<typeof db, 'select' | 'execute'> = db): Promise<Set<string>> {
  const out = await staleHomes(homes, q);
  for (const h of downHomes(homes)) out.add(h);
  return out;
}

/**
 * Хвост Э7 (14.10): из этих инстансов — те, что НЕ ОТВЕЧАЮТ нашему забору журнала дольше `STALE_AFTER_MS` (`pullDownSince`: сеть,
 * таймаут, 5xx) — та же «живость», что у дома группы в `silentHomes`, но без «не забирает наше» (`staleHomes`: у 1:1 это своя
 * плашка `fedStale`, и 404/часы — не «лежит»). Кормит `ConvSummary.fedPeerDown` ЛС 1:1 (крючок `peerDown`). Без запроса к базе.
 */
export function downHomes(homes: readonly string[]): Set<string> {
  const out = new Set<string>();
  const now = Date.now();
  for (const h of new Set(homes)) {
    const since = pullDownSince.get(h);
    if (since !== undefined && now - since > STALE_AFTER_MS) out.add(h);
  }
  return out;
}

/** Крючок записи (`routes/conv.configureFedLinkGuard`): собеседник — человек соседа, и связка с его домом не работает. */
export async function fedLinkBrokenFor(peerId: string): Promise<boolean> {
  const [u] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, peerId)).limit(1);
  if (!u?.home) return false;
  return (await brokenHomes([u.home])).has(u.home);
}

// ─── Перемены состояния → события людям ─────────────────────────────────────────────────────────────────────────────

let known: Set<string> | null = null;
/** п. 7: прошлая сверка «не забирает» (перемена — `conv.change` людям бесед). */
let staleKnown: Set<string> | null = null;
/** Э7 часть 3 (D): прошлая сверка «дом группы молчит» (перемена — `conv.change` людям групп этого дома). */
let silentKnown: Set<string> | null = null;
/** Хвост Э7 (14.10): прошлая сверка «дом собеседника 1:1 не отвечает» (`downHomes`; перемена — `conv.change` людям бесед). */
let downKnown: Set<string> | null = null;
let chain: Promise<void> = Promise.resolve();
const restoredListeners = new Set<(instanceId: string) => void>();

/** Связка с инстансом снова рабочая (была отметка `broken`). */
export function onLinkRestored(fn: (instanceId: string) => void): () => void {
  restoredListeners.add(fn);
  return () => restoredListeners.delete(fn);
}

/** Сверить, у каких инстансов собеседников связка не работает, и разослать перемену. Вызовы выстраиваются в очередь. */
export function refreshFedLinks(): Promise<void> {
  chain = chain.then(refreshOnce).catch((err) => {
    console.warn(`[fed-dm] сверка связок упала: ${err instanceof Error ? err.message : err}`);
  });
  return chain;
}

async function refreshOnce(): Promise<void> {
  const res = await db.execute(sql`
    SELECT DISTINCT u.home_instance_id AS home FROM conversation_members cm JOIN users u ON u.id = cm.user_id
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE c.kind = 'direct' AND u.home_instance_id IS NOT NULL`);
  const directHomes = (res.rows as { home: string }[]).map((r) => r.home);
  // Э7 часть 3 (D): дома групп, в которых состоит кто-то из наших, — тоже под сверкой («хост недоступен» в сводке группы).
  const hostRes = await db.execute(sql`
    SELECT DISTINCT c.origin_instance_id AS home FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
    JOIN users u ON u.id = cm.user_id
    WHERE c.kind = 'group' AND c.origin_instance_id IS NOT NULL AND cm.left_at IS NULL AND u.home_instance_id IS NULL`);
  const groupHosts = (hostRes.rows as { home: string }[]).map((r) => r.home);
  const homes = [...new Set([...directHomes, ...groupHosts])];
  const now = await brokenHomes(homes);
  const stale = await staleHomes(directHomes);
  const silent = await silentHomes(groupHosts);
  const silentBefore = silentKnown;
  silentKnown = silent;
  const down = downHomes(directHomes);
  const downBefore = downKnown;
  downKnown = down;
  const before = known;
  const staleBefore = staleKnown;
  known = now;
  staleKnown = stale;
  // Первая сверка после старта — точка отсчёта: сводки и так несут поле, событий слать не о чем.
  if (!before) return;
  const changed = homes.filter((h) => before.has(h) !== now.has(h));
  for (const instanceId of changed) {
    await announceConvs(instanceId);
    if (!now.has(instanceId)) for (const fn of restoredListeners) fn(instanceId);
  }
  // п. 7: «не забирает» сменилось (а связка та же) — сводки с плашкой / без.
  for (const instanceId of homes) {
    if (changed.includes(instanceId)) continue;
    if ((staleBefore?.has(instanceId) ?? false) !== stale.has(instanceId)) await announceConvs(instanceId);
  }
  // Э7 часть 3 (D): «дом группы молчит» сменилось — сводки групп этого дома с плашкой / без.
  for (const instanceId of groupHosts) {
    if (changed.includes(instanceId)) continue;
    if ((silentBefore?.has(instanceId) ?? false) !== silent.has(instanceId)) await announceConvs(instanceId);
  }
  // Хвост Э7 (14.10): «дом собеседника 1:1 не отвечает» сменилось — сводки с плашкой `fedPeerDown` / без. Дом, который уже
  // объявили выше (связка, «не забирает», дом группы), второй раз не объявляется.
  for (const instanceId of directHomes) {
    if ((downBefore?.has(instanceId) ?? false) === down.has(instanceId)) continue;
    if (changed.includes(instanceId) || (staleBefore?.has(instanceId) ?? false) !== stale.has(instanceId)) continue;
    if (groupHosts.includes(instanceId) && (silentBefore?.has(instanceId) ?? false) !== silent.has(instanceId)) continue;
    await announceConvs(instanceId);
  }
}

/**
 * Людям бесед с человеком этого инстанса — строка журнала `conv` (без журнала на связку) и `conv.change` с новой сводкой. Зовут
 * и снаружи (п. 12 ревью 12.10: `directorySync.refreshCapabilities` сменил признаки связки — `fedNoFiles` в сводках).
 */
export async function announceConvs(instanceId: string): Promise<void> {
  const res = await db.execute(sql`
    SELECT cm.conversation_id AS cid, array_agg(cm.user_id) AS locals
    FROM conversation_members cm JOIN users u ON u.id = cm.user_id
    WHERE u.home_instance_id IS NULL AND cm.left_at IS NULL AND EXISTS (
      SELECT 1 FROM conversation_members o JOIN users ou ON ou.id = o.user_id
      WHERE o.conversation_id = cm.conversation_id AND ou.home_instance_id = ${instanceId})
      OR EXISTS (SELECT 1 FROM conversations gc WHERE gc.id = cm.conversation_id AND gc.kind = 'group' AND gc.origin_instance_id = ${instanceId})
    GROUP BY cm.conversation_id`);
  for (const row of res.rows as { cid: string; locals: string[] }[]) {
    const pts = await db.transaction((tx) =>
      journal(
        tx,
        row.locals.map((userId) => ({ userId, conversationId: row.cid, kind: 'conv' as const, messageId: null })),
        { fed: false },
      ),
    );
    const d: Delivery = { conversationId: row.cid, messageId: null, pts };
    await deliver(d).catch(() => {});
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Включить сверку (зовёт `index.ts` при `FEDERATION_DM_ENABLED`): точка отсчёта сразу, дальше раз в `REFRESH_EVERY_MS`. */
/** `active` (#224): ЛС между инстансами включены прямо сейчас — выключили тумблером в админке, такты и приём пустые. */
export function startFedLinkWatch(active: () => boolean = () => true): void {
  if (timer) return;
  void refreshFedLinks();
  timer = setInterval(() => {
    if (active()) void refreshFedLinks();
  }, REFRESH_EVERY_MS);
  timer.unref?.();
}

// ─── Жалоба из ЛС держателю дома собеседника ─────────────────────────────────────────────────────────────────────────

/** Сколько последних сообщений собеседника уходит уликами (как местная жалоба, `dmReports`). */
const DM_REPORT_EVIDENCE = 5;

/**
 * Жалоба на человека соседа из ЛС (плашка незнакомца, «Пожаловаться», §4 п. 2) — держателю ЕГО дома событием `report.create`
 * (существующий провод F3, `instanceBan.sendReport`: предел на связку, склейка по человеку). `action: 'dm_report'` — новое
 * значение (строка до 32, старый приёмник показывает её как есть). Связка без `reports` или не рабочая — молча: местная
 * жалоба нашему держателю уже записана.
 */
export async function reportFedDmPeer(
  _me: string,
  conversationId: string,
  peerId: string,
  input: { reason: string; comment: string | null },
): Promise<void> {
  const [peer] = await db
    .select({ home: users.homeInstanceId, homeUserId: users.homeUserId })
    .from(users)
    .where(eq(users.id, peerId))
    .limit(1);
  if (!peer?.home || !peer.homeUserId) return;
  const [link] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, peer.home)).limit(1);
  if (!link || link.state !== 'active' || !link.features.includes('reports')) return;
  const msgs = await db
    .select({ content: conversationMessages.content, at: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.authorId, peerId),
        isNull(conversationMessages.deletedAt),
        eq(conversationMessages.withheld, false),
        isNull(conversationMessages.service),
      ),
    )
    .orderBy(desc(conversationMessages.sortKey))
    .limit(DM_REPORT_EVIDENCE);
  const reason = input.comment ? `${input.reason}: ${input.comment}`.slice(0, 500) : input.reason;
  await sendReport({
    instanceId: peer.home,
    reportedUserId: peer.homeUserId,
    action: 'dm_report',
    serverName: null,
    reason,
    evidence: msgs.filter((m) => m.content).map((m) => ({ text: m.content.slice(0, 2000), at: m.at.getTime(), channel: 'dm' })),
  });
}
