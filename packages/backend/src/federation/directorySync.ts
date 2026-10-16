/**
 * Синхронизация каталогов с соседями (#139, F2, план §5.4) — сеть, часы и состояние.
 *
 * Расписание («что пора делать») живёт в `syncSchedule.ts` и проверяется без базы; здесь — сами
 * походы к соседу, страницы и запись результата.
 *
 * 🔴 Главное правило кеша: неудача НИЧЕГО не стирает. Сосед не ответил — списки остаются прежними с
 * пометкой «обновлено N назад». Пустой список выглядит как «у соседа никого нет», и это худшая из
 * возможных неправд.
 *
 * Порядок, сроки и постраничный обход — в `directorySyncCore.ts` (без базы, вынос для тестов 22.09);
 * здесь то, что читает и пишет базу, и проводка.
 */

import { and, eq } from 'drizzle-orm';
import {
  FED_FEATURES,
  parseDirectoryPage,
  parseServerPage,
  type FedDirectoryEntry,
  type FedServerEntry,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationLinks, federationSyncState } from '../db/schema.js';
import { federation } from './instance.js';
import { fetchRevocations } from './guestRevocation.js';
import { reconcileMemberships } from './guestMembership.js';
import { fetchPeerDocument, getSignedFromPeer } from './peerClient.js';
import { linkService } from './links.js';
import { applyDirectoryEntries, applyServerEntries, cacheSizes, reconcileDirectory, reconcileServers } from './directoryCache.js';
import { nextSinceFrom } from './directoryRules.js';
import { planSync, type SyncPlan, type SyncState } from './syncSchedule.js';
import { readInstanceMeta } from './instanceMeta.js';
import {
  createSyncRunner,
  fetchPages as fetchPagesWith,
  parseMembershipList,
  type PageFetchDeps,
  type SyncOutcome,
  type SyncReport,
} from './directorySyncCore.js';

export type { SyncNowResult, SyncOutcome } from './directorySyncCore.js';

/**
 * Виды синхронизации.
 *
 * `revocations` — не каталог, но состояние у него того же вида: «до какого момента мы уже забрали»
 * (F3, §5.6.1). Держать для него отдельную таблицу значило бы завести второй способ помнить одно и
 * то же; дельт и страниц у него нет — только момент.
 */
export type SyncKind = 'directory' | 'servers' | 'revocations' | 'memberships';

/** Состояние синхронизации по связке и виду каталога; пустая строка = ни разу не синхронизировались. */
export async function readSyncState(
  instanceId: string,
  kind: SyncKind,
): Promise<SyncState & { since: number | null; entries: number; problem: string | null }> {
  const [row] = await db
    .select()
    .from(federationSyncState)
    .where(and(eq(federationSyncState.instanceId, instanceId), eq(federationSyncState.kind, kind)))
    .limit(1);
  return {
    lastDeltaAt: row?.lastDeltaAt ? row.lastDeltaAt.getTime() : null,
    lastFullAt: row?.lastFullAt ? row.lastFullAt.getTime() : null,
    failures: row?.failures ?? 0,
    needsFull: row?.needsFull ?? true,
    since: row?.since === undefined || row?.since === null ? null : Number(row.since),
    entries: row?.entries ?? 0,
    problem: row?.lastProblem ?? null,
  };
}

async function writeSyncState(
  instanceId: string,
  kind: SyncKind,
  patch: Partial<{
    since: number | null;
    lastDeltaAt: Date | null;
    lastFullAt: Date | null;
    failures: number;
    needsFull: boolean;
    lastProblem: string | null;
    entries: number;
  }>,
): Promise<void> {
  await db
    .insert(federationSyncState)
    .values({ instanceId, kind, ...patch })
    .onConflictDoUpdate({ target: [federationSyncState.instanceId, federationSyncState.kind], set: patch });
}

/**
 * Затребовать внеочередную полную сверку.
 *
 * Зовётся при пропуске в номерах событий: пропуск значит, что какое-то изменение до нас не доехало,
 * а какое именно — по номеру не понять. Сверка это и есть ответ «узнаем всё заново».
 */
export async function markNeedsFull(instanceId: string, kind?: SyncKind): Promise<void> {
  // Отзывы сюда не входят намеренно: у них нет «полной сверки», только «с какого момента».
  for (const k of kind ? [kind] : (['directory', 'servers'] as SyncKind[])) {
    await writeSyncState(instanceId, k, { needsFull: true });
  }
}

/** Сеть и подпись для постраничного обхода (`directorySyncCore.fetchPages`). */
const pageDeps: PageFetchDeps = {
  getSignedFromPeer: (input) => getSignedFromPeer(input),
  signer: () => {
    const self = federation.identity();
    const key = federation.signingKey();
    return self && key ? { instanceId: self.instanceId, kid: key.kid, privateKeyDer: key.privateKeyDer } : null;
  },
  now: () => Date.now(),
};

/** Общая часть обоих видов: постранично забрать у соседа и применить. */
function fetchPages<T>(input: Parameters<typeof fetchPagesWith<T>>[1]) {
  return fetchPagesWith<T>(pageDeps, input);
}

/** Забрать каталог людей: `full` — полная сверка, иначе дельта с прошлого раза. */
export async function syncDirectory(instanceId: string, mode: 'full' | 'delta'): Promise<SyncOutcome> {
  const [link] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  if (!link) return { ok: false, problem: 'связки нет', entries: 0, pages: 0 };
  const state = await readSyncState(instanceId, 'directory');
  const since = mode === 'full' ? null : state.since;

  const res = await fetchPages<FedDirectoryEntry>({
    instanceId,
    apiBase: link.apiBase,
    path: '/api/fed/v1/directory',
    since,
    parse: (raw) => {
      const page = parseDirectoryPage(raw);
      return page ? { ...page, entries: page.entries } : null;
    },
    apply: (entries) => applyDirectoryEntries(instanceId, entries),
    idOf: (e) => e.userId,
  });

  // 🔴 Уборка — ДО записи итога (23.09, мегаприёмка #185): итог несёт размер кеша, и посчитанный раньше
  // уборки он включал уходящих — админ видел «в кеше 27» после сверки, убравшей человека (в базе 26).
  // Заодно упавшая уборка больше не засчитывает полную сверку: `needsFull` остаётся, повторится.
  if (res.ok && mode === 'full') {
    const gone = await reconcileDirectory(instanceId, res.seen);
    if (gone > 0) console.log(`[fed] сверка каталога ${instanceId}: убрано лишних записей ${gone}`);
  }
  await finishSync(instanceId, 'directory', mode, res);
  return { ok: res.ok, problem: res.problem, entries: res.entries, pages: res.pages };
}

/** Забрать список открытых серверов соседа. */
export async function syncServers(instanceId: string, mode: 'full' | 'delta'): Promise<SyncOutcome> {
  const [link] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  if (!link) return { ok: false, problem: 'связки нет', entries: 0, pages: 0 };
  const state = await readSyncState(instanceId, 'servers');
  const since = mode === 'full' ? null : state.since;

  const res = await fetchPages<FedServerEntry>({
    instanceId,
    apiBase: link.apiBase,
    path: '/api/fed/v1/servers',
    since,
    parse: (raw) => {
      const page = parseServerPage(raw);
      return page ? { ...page, entries: page.servers } : null;
    },
    apply: (entries) => applyServerEntries(instanceId, entries),
    idOf: (e) => e.serverId,
  });

  // Уборка до итога — по той же причине, что у каталога людей выше.
  if (res.ok && mode === 'full') {
    const gone = await reconcileServers(instanceId, res.seen);
    if (gone > 0) console.log(`[fed] сверка серверов ${instanceId}: убрано лишних записей ${gone}`);
  }
  await finishSync(instanceId, 'servers', mode, res);
  return { ok: res.ok, problem: res.problem, entries: res.entries, pages: res.pages };
}

/**
 * Записать итог захода.
 *
 * ⚠️ `since` двигается ТОЛЬКО по часам соседа и только при удаче: подставь мы сюда своё время —
 * записи, изменившиеся у него в зазор между нашими и его часами, не попали бы ни в одну дельту.
 */
async function finishSync(
  instanceId: string,
  kind: SyncKind,
  mode: 'full' | 'delta',
  res: { ok: boolean; problem?: string; peerNow: number | null },
): Promise<void> {
  const state = await readSyncState(instanceId, kind);
  if (!res.ok) {
    await writeSyncState(instanceId, kind, {
      failures: state.failures + 1,
      lastProblem: (res.problem ?? 'неизвестно').slice(0, 200),
    });
    return;
  }
  const sizes = await cacheSizes(instanceId);
  await writeSyncState(instanceId, kind, {
    since: res.peerNow === null ? state.since : nextSinceFrom(res.peerNow),
    lastDeltaAt: new Date(),
    ...(mode === 'full' ? { lastFullAt: new Date(), needsFull: false } : {}),
    failures: 0,
    lastProblem: null,
    entries: kind === 'directory' ? sizes.users : sizes.servers,
  });
}

/**
 * Когда в последний раз перечитывали, что сосед умеет. Только в памяти процесса: цена промаха —
 * один запрос визитки, а лишний столбец в базе ради этого не нужен.
 */
const capsCheckedAt = new Map<string, number>();
const CAPS_RECHECK_MS = 60 * 60_000;
/**
 * Исправления ревью ЛС 12.10, п. 5 / п. 10: принудительное перечитывание (`force`) — сосед уже пользуется тем, чего нет в нашей
 * строке связки (`dm1` / `dm2`). Свой предел — раз в минуту на связку; неудача обычного перечитывания — повтор через минуту,
 * а не через час (раньше отметка ставилась ДО запроса, и сбой визитки оставлял старые признаки на час).
 */
const capsForcedAt = new Map<string, number>();
const CAPS_FORCE_MS = 60_000;

/**
 * Признаки связки реально изменились (п. 12 ревью ЛС 12.10): поля сводки бесед, считаемые из `federation_links.features`
 * (`ConvSummary.fedNoFiles`), меняются без нового номера `pts` — клиент с кешем бесед их не перечитал бы. Подключает `index.ts`
 * (`convLink.announceConvs`: строка журнала `conv` и `conv.change` людям бесед с этим инстансом), а не импорт.
 */
let featuresChanged: ((instanceId: string) => void) | null = null;
export function configureCapsChanged(fn: ((instanceId: string) => void) | null): void {
  featuresChanged = fn;
}

/**
 * Перечитать возможности соседа.
 *
 * 🔴 Без этого связка, заведённая ДО того, как сосед научился каталогам, не начала бы синхронизацию
 * НИКОГДА: список `features` записывается в строку связки один раз, при подтверждении, и сам по себе
 * не обновляется. Сосед обновил приложение — а мы про это не знаем, потому что не спрашивали.
 * ⚠️ Спрашиваем не чаще раза в час (сверка каталога — у каждой связки, `conv.open` — у соседа без `dm1`): строка связки
 * сама не обновляется, даже когда визитка соседа читается на его входящий запрос.
 */
export async function refreshCapabilities(
  link: { instanceId: string; apiBase: string; features: string[] },
  now: number,
  opts: { force?: boolean } = {},
): Promise<string[]> {
  if (opts.force) {
    if (now - (capsForcedAt.get(link.instanceId) ?? 0) < CAPS_FORCE_MS) return link.features;
    capsForcedAt.set(link.instanceId, now);
  } else {
    const last = capsCheckedAt.get(link.instanceId) ?? 0;
    if (now - last < CAPS_RECHECK_MS) return link.features;
    // Пока идёт запрос — не дублировать; неудача ниже переставит отметку на «повтор через минуту».
    capsCheckedAt.set(link.instanceId, now);
  }
  const failed = (): string[] => {
    if (!opts.force) capsCheckedAt.set(link.instanceId, now - CAPS_RECHECK_MS + CAPS_FORCE_MS);
    return link.features;
  };

  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return failed();
  }
  const peer = await fetchPeerDocument({ apiBase: link.apiBase, allowHosts: new Set([host]), now });
  // Личность обязана совпасть: иначе это уже другой инстанс по тому же адресу, и его возможности
  // нам записывать некуда.
  if (!peer.ok || peer.value.instanceId !== link.instanceId) return failed();
  capsCheckedAt.set(link.instanceId, now);
  // Строка связки в базе могла уйти вперёд от переданной копии — сравниваем с тем, что лежит сейчас.
  const [stored] = await db
    .select({ features: federationLinks.features })
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, link.instanceId))
    .limit(1);
  const before = new Set(stored?.features ?? link.features);
  const nowFeatures = peer.value.doc.features;
  const changed = before.size !== new Set(nowFeatures).size || nowFeatures.some((f) => !before.has(f));

  await db
    .update(federationLinks)
    .set({
      features: peer.value.doc.features,
      protocolVersion: peer.value.protocolVersion,
      updatedAt: new Date(),
    })
    .where(eq(federationLinks.instanceId, link.instanceId));
  if (changed) featuresChanged?.(link.instanceId);
  return peer.value.doc.features;
}

/**
 * Проход по связкам и кнопка «синхронизировать сейчас» — порядок, сроки и отметка «заход идёт» живут в
 * `directorySyncCore.createSyncRunner`; здесь только чем читать связки и что делать с одной.
 */
const runner = createSyncRunner({
  hasIdentity: () => !!federation.identity(),
  paused: async () => (await readInstanceMeta()).paused,
  activeLinks: () => db.select().from(federationLinks).where(eq(federationLinks.state, 'active')),
  linkState: async (instanceId) => {
    const [link] = await db
      .select({ state: federationLinks.state, confirmPending: federationLinks.confirmPending })
      .from(federationLinks)
      .where(eq(federationLinks.instanceId, instanceId))
      .limit(1);
    return link ?? null;
  },
  resendConfirmation: (instanceId, opts) => linkService.resendConfirmation(instanceId, opts),
  syncOneLink: (link, now, hour, report) => syncOneLink(link, now, hour, report),
  syncFull: async (instanceId) => {
    const directory = await syncDirectory(instanceId, 'full');
    const servers = await syncServers(instanceId, 'full');
    return { directory, servers };
  },
  now: () => Date.now(),
});

/** Один проход по всем рабочим связкам (см. `createSyncRunner`). */
export function runSyncPass(now = Date.now()): Promise<SyncReport> {
  return runner.runSyncPass(now);
}

/** Кнопка держателя «синхронизировать сейчас» (см. `createSyncRunner`). */
export function syncLinkNow(instanceId: string) {
  return runner.syncLinkNow(instanceId);
}

async function syncOneLink(
  link: typeof federationLinks.$inferSelect,
  now: number,
  hour: number,
  report: SyncReport,
): Promise<true> {
  {
    let features = link.features;
    // Сосед мог обновиться уже после того, как связка была подтверждена. Перечитываем у ВСЕХ связок (не чаще раза в час):
    // новые возможности (`dm1`, `dm2`, …) иначе не доезжали бы до строки связки никогда (живая проверка ЛС 12.10).
    features = await refreshCapabilities(link, now);
    if (!features.includes(FED_FEATURES.directory)) {
      report.skipped += 1;
      return true;
    }
    /**
     * 🔴 Отзывы — ПЕРВЫМ делом, до каталогов (§5.6.1). Пока мы обновляем списки людей, угнанная
     * гостевая сессия продолжает работать; отзыв — ровно то, что обязано примениться раньше всего.
     * Хост мог быть выключен, когда человек нажал «выйти везде», и событие до него не доехало.
     */
    try {
      const state = await readSyncState(link.instanceId, 'revocations');
      const got = await fetchRevocations({ link, since: state.since });
      if (got) {
        await writeSyncState(link.instanceId, 'revocations', { since: got.since, lastDeltaAt: new Date(now) });
        if (got.applied > 0) console.log(`[fed] догнали ${got.applied} отзыв(ов) от ${link.instanceId}`);
      }
    } catch (err) {
      // Не смогли догнать — не повод бросать каталоги: следующий проход попробует снова.
      console.warn(`[fed] отзывы от ${link.instanceId} не забрались: ${err instanceof Error ? err.message : err}`);
    }

    /**
     * Суточная сверка индекса членств (§5.4). Дельт у неё нет: список короткий (где мои люди
     * гостят), а событие `membership.changed` и так приходит на каждое изменение. Сверка ловит
     * НАКОПЛЕННОЕ — откат хоста из бэкапа и события, потерянные за долгий разрыв.
     */
    try {
      const memState = await readSyncState(link.instanceId, 'memberships');
      const plan = planSync(memState, now, hour);
      if (plan === 'full') await syncMemberships(link, now);
    } catch (err) {
      console.warn(`[fed] сверка членств с ${link.instanceId} упала: ${err instanceof Error ? err.message : err}`);
    }

    for (const kind of ['directory', 'servers'] as SyncKind[]) {
      const state = await readSyncState(link.instanceId, kind);
      const plan: SyncPlan = planSync(state, now, hour);
      if (plan === 'idle') continue;
      try {
        const res = kind === 'directory'
          ? await syncDirectory(link.instanceId, plan)
          : await syncServers(link.instanceId, plan);
        if (res.ok) report.synced += 1;
        else {
          report.failed += 1;
          console.warn(`[fed] сверка ${kind} с ${link.instanceId} не удалась: ${res.problem}`);
        }
      } catch (err) {
        report.failed += 1;
        console.warn(`[fed] сверка ${kind} с ${link.instanceId} упала: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return true;
}

/**
 * Забрать у хоста, где состоят НАШИ люди, и свести с индексом (§5.4).
 *
 * ⚠️ Сверка применяется ТОЛЬКО при полностью полученном ответе: «чего нет в списке, того нет» на
 * половине списка стёрло бы живые членства — те же грабли, что и в сверке каталога.
 */
async function syncMemberships(link: { instanceId: string; apiBase: string }, now: number): Promise<void> {
  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return;

  let host: string;
  try {
    host = new URL(link.apiBase).host;
  } catch {
    return;
  }

  const res = await getSignedFromPeer({
    apiBase: link.apiBase,
    path: '/api/fed/v1/memberships',
    query: { instance_id: self.instanceId },
    keyid: key.kid,
    privateKeyDer: key.privateKeyDer,
    allowHosts: new Set([host]),
    // Подпись — временем отправки, а не началом прохода (#199 п. 2): проход длится минуты, подпись ~120 с.
    now: Date.now(),
  });
  if (!res.ok || res.value.status < 200 || res.value.status >= 300) {
    await writeSyncState(link.instanceId, 'memberships', { failures: 1, lastProblem: 'unreachable' });
    return;
  }

  // Ответ без списка — негодный целиком: свести по нему значило бы стереть индекс.
  const seen = parseMembershipList(res.value.body);
  if (!seen) return;

  const { added, removed } = await reconcileMemberships(link.instanceId, seen, now);
  await writeSyncState(link.instanceId, 'memberships', {
    lastFullAt: new Date(now),
    failures: 0,
    lastProblem: null,
    needsFull: false,
    entries: seen.length,
  });
  if (removed > 0) console.log(`[fed] сверка членств с ${link.instanceId}: +${added}, −${removed}`);
}

/**
 * Как часто заглядывать в расписание.
 *
 * ⚠️ Это НЕ частота синхронизации: сам проход почти всегда решает «ещё не пора». Частый круг нужен
 * ради внеочередной сверки — она затребована пропуском события и ждать пятнадцать минут не должна.
 */
const PASS_INTERVAL_MS = 60_000;

export function startDirectorySyncWorker(): void {
  let running = false;
  const timer = setInterval(() => {
    // Поверх незавершённого прохода новый не стартует (F-09) — см. очередь исходящих.
    if (running) return;
    running = true;
    void runSyncPass()
      .catch((err: unknown) => {
        console.warn(`[fed] проход синхронизации упал: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  }, PASS_INTERVAL_MS);
  timer.unref();
}
