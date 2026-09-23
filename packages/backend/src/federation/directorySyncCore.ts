/**
 * Синхронизация каталогов — порядок и сроки без базы (вынос для тестов 22.09; проводка — `directorySync.ts`).
 *
 * Здесь: постраничный поход к соседу (`fetchPages`), разбор ответа о членствах, срок на работу
 * (`withBudget`) и сам проход по связкам с кнопкой «синхронизировать сейчас» (`createSyncRunner`):
 * аварийная пауза, досылка подтверждения, отметка «заход идёт», сроки прохода и кнопки. Снаружи —
 * сеть (`getSignedFromPeer`), подпись, часы, чтение связок и то, что пишет в базу.
 */

import type { PeerResult } from './peerClient.js';
import { peerRejectionReason } from './linkService.js';

/**
 * Сколько страниц берём за один заход.
 *
 * Предел обязателен: страницы соседа приходят с курсором, и сосед с ошибкой (или со злым умыслом)
 * может отдавать курсор бесконечно. При пределе в 50 страниц по 200 записей это 10 000 человек за
 * заход — больше, чем бывает у самостоятельного инстанса, а остальное доберёт следующая сверка.
 */
export const MAX_PAGES = 50;

export interface SyncOutcome {
  ok: boolean;
  problem?: string;
  /** Сколько записей приняли (не считая отброшенных как устаревшие). */
  entries: number;
  pages: number;
}

export type SyncReport = { synced: number; failed: number; skipped: number };

/** Чем подписывать: наша личность и сменный ключ. `null` — федерация без личности, ходить нечем. */
export type SyncSigner = { instanceId: string; kid: string; privateKeyDer: Uint8Array };

export interface PageFetchDeps {
  getSignedFromPeer: (input: {
    apiBase: string;
    path: string;
    query?: Record<string, string | number | null | undefined>;
    keyid: string;
    privateKeyDer: Uint8Array;
    allowHosts: ReadonlySet<string>;
    now: number;
  }) => Promise<PeerResult<{ status: number; body: string }>>;
  signer: () => SyncSigner | null;
  now: () => number;
}

/** Общая часть обоих видов каталога: постранично забрать у соседа и применить. */
export async function fetchPages<T>(
  deps: PageFetchDeps,
  input: {
    instanceId: string;
    apiBase: string;
    path: string;
    since: number | null;
    parse: (raw: unknown) => { entries: T[]; nextCursor: string | null; instanceId: string; now: number } | null;
    apply: (entries: T[]) => Promise<{ upserted: number; removed: number }>;
    idOf: (entry: T) => string;
  },
): Promise<SyncOutcome & { seen: string[]; peerNow: number | null }> {
  const signer = deps.signer();
  if (!signer) return { ok: false, problem: 'нечем подписать', entries: 0, pages: 0, seen: [], peerNow: null };

  let host: string;
  try {
    host = new URL(input.apiBase).host;
  } catch {
    return { ok: false, problem: 'кривой адрес связки', entries: 0, pages: 0, seen: [], peerNow: null };
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  let entries = 0;
  let pages = 0;
  let peerNow: number | null = null;

  for (; pages < MAX_PAGES; pages++) {
    const res = await deps.getSignedFromPeer({
      apiBase: input.apiBase,
      path: input.path,
      query: { instance_id: signer.instanceId, since: input.since ?? undefined, cursor: cursor ?? undefined },
      keyid: signer.kid,
      privateKeyDer: signer.privateKeyDer,
      allowHosts: new Set([host]),
      // Подпись — временем отправки каждой страницы: заход длится минуты, подпись живёт ~120 с.
      now: deps.now(),
    });
    if (!res.ok) return { ok: false, problem: res.detail ?? res.problem, entries, pages, seen, peerNow };
    if (res.value.status < 200 || res.value.status >= 300) {
      // Причина соседа — только машинным кодом (#199 п. 10): строка идёт держателю в панель как системная.
      const refusal = peerRejectionReason(res.value.body);
      return {
        ok: false,
        problem: `ответ ${res.value.status}${refusal ? ` (${refusal})` : ''}`,
        entries,
        pages,
        seen,
        peerNow,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(res.value.body);
    } catch {
      return { ok: false, problem: 'ответ не JSON', entries, pages, seen, peerNow };
    }
    const page = input.parse(raw);
    if (!page) return { ok: false, problem: 'ответ не разобрался', entries, pages, seen, peerNow };
    // 🔴 Отвечать обязан тот, кого мы спрашивали. Подписи у ОТВЕТА нет (подписываются запросы, ответ
    // защищён TLS), и это поле ловит не подделку, а разъехавшуюся связку: перепривязанный сосед,
    // подменённый адрес, чужой инстанс за тем же доменом. Приняв такой ответ, мы записали бы чужих
    // людей в кеш соседа.
    if (page.instanceId !== input.instanceId) {
      return { ok: false, problem: 'ответ от другого инстанса', entries, pages, seen, peerNow };
    }
    peerNow = page.now;

    const applied = await input.apply(page.entries);
    entries += applied.upserted;
    for (const e of page.entries) seen.push(input.idOf(e));

    cursor = page.nextCursor;
    if (!cursor) return { ok: true, entries, pages: pages + 1, seen, peerNow };
  }

  // Страницы не кончились. Это не ошибка связи, но и полной картины у нас нет — значит сверять
  // «чего нет в ответе, того нет у соседа» нельзя.
  return { ok: false, problem: 'слишком много страниц', entries, pages, seen, peerNow };
}

export type SeenMembership = {
  userId: string;
  serverId: string;
  serverName: string;
  state: string;
  method: string | null;
  invitedBy: string | null;
};

/**
 * Ответ хоста о членствах наших людей (§5.4) → список для сверки индекса.
 *
 * 🔴 `null` — ответ негодный ЦЕЛИКОМ (не JSON, нет массива `memberships`): свести по нему значило бы
 * стереть индекс. Отдельные кривые записи (без `user_id`/`server_id`) просто отбрасываются.
 */
export function parseMembershipList(body: string): SeenMembership[] | null {
  let parsed: { memberships?: unknown };
  try {
    parsed = JSON.parse(body) as { memberships?: unknown };
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const list = Array.isArray(parsed.memberships) ? parsed.memberships : null;
  if (!list) return null;
  // Элемент — не объект (`null`, число): ответ битый ЦЕЛИКОМ, как и прежде (раньше тут падало и сверка не шла).
  // Молча отбросить нельзя — «чего нет в списке, того нет» стёрло бы то членство из индекса.
  if (list.some((raw) => !raw || typeof raw !== 'object')) return null;
  return (list as Record<string, unknown>[])
    .filter((m) => typeof m.user_id === 'string' && typeof m.server_id === 'string')
    .map((m) => ({
      userId: String(m.user_id),
      serverId: String(m.server_id),
      serverName: typeof m.server_name === 'string' ? m.server_name : '',
      state: typeof m.state === 'string' ? m.state : 'active',
      method: typeof m.method === 'string' ? m.method : null,
      invitedBy: typeof m.invited_by === 'string' ? m.invited_by : null,
    }));
}

/**
 * Дождаться работы, но не дольше `ms`. Не уложилась — `null`; ⚠️ сама работа НЕ отменяется, её лишь
 * перестают ждать (у каждого запроса к соседу свой общий срок, так что «фон» конечен).
 */
export async function withBudget<T>(ms: number, work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Срок на одну связку за проход. Три минуты — с запасом на 50 страниц каталога у здорового соседа. */
export const LINK_BUDGET_MS = 3 * 60_000;

/**
 * Срок ответа кнопке (#198 п. 8): обратный прокси рвёт запрос через 60 с, и трёхминутного срока прохода
 * человек никогда не дождался бы — видел бы «HTTP 504» вместо «доделывается в фоне».
 */
export const SYNC_NOW_BUDGET_MS = 45_000;

export type SyncNowResult =
  | { problem: 'busy' | 'not-active' | 'paused' | 'timeout' }
  | { problem: null; directory: SyncOutcome; servers: SyncOutcome };

export interface SyncRunnerDeps<L extends { instanceId: string; confirmPending: boolean }> {
  /** Есть ли у инстанса личность — без неё ходить не с чем. */
  hasIdentity: () => boolean;
  /** Аварийная пауза держателя. */
  paused: () => Promise<boolean>;
  /** Рабочие (`active`) связки для прохода. */
  activeLinks: () => Promise<L[]>;
  /** Состояние одной связки для кнопки; `null` — связки нет. */
  linkState: (instanceId: string) => Promise<{ state: string; confirmPending: boolean } | null>;
  /** `linkService.resendConfirmation` — досылка «подтверждено» (#199). */
  resendConfirmation: (instanceId: string, opts?: { force?: boolean }) => Promise<unknown>;
  /** Всё, что проход делает с одной связкой (отзывы, членства, каталоги); итог — в `report`. */
  syncOneLink: (link: L, now: number, hour: number, report: SyncReport) => Promise<unknown>;
  /** Полная сверка обоих каталогов — для кнопки. */
  syncFull: (instanceId: string) => Promise<{ directory: SyncOutcome; servers: SyncOutcome }>;
  now: () => number;
  /** Час по местному времени сервера — от него расписание ночной сверки. По умолчанию `getHours()`. */
  hourOf?: (now: number) => number;
  linkBudgetMs?: number;
  syncNowBudgetMs?: number;
  warn?: (message: string) => void;
}

export function createSyncRunner<L extends { instanceId: string; confirmPending: boolean }>(deps: SyncRunnerDeps<L>) {
  const linkBudgetMs = deps.linkBudgetMs ?? LINK_BUDGET_MS;
  const syncNowBudgetMs = deps.syncNowBudgetMs ?? SYNC_NOW_BUDGET_MS;
  const hourOf = deps.hourOf ?? ((now: number) => new Date(now).getHours());
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  /** Связки, чей заход ещё не кончился (в том числе брошенный по сроку) — следующий проход их пропускает. */
  const syncing = new Set<string>();

  /**
   * Один проход по всем связкам.
   *
   * ⚠️ Синхронизируем только РАБОЧИЕ связки и только тех соседей, кто объявил у себя каталог: связка
   * на паузе или потерявшая доверие — это «не разговариваем», а не «разговариваем пореже».
   */
  async function runSyncPass(now = deps.now()): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, failed: 0, skipped: 0 };
    if (!deps.hasIdentity()) return report;
    // Аварийная пауза держателя — рубильник на всю федерацию, включая наши исходящие запросы.
    if (await deps.paused()) return report;

    const links = await deps.activeLinks();
    const hour = hourOf(now);

    for (const link of links) {
      /**
       * Наше «подтверждено» до соседа не дошло (#199) — досылаем у любого соседа, в том числе без каталога
       * (#199 п. 5). Не ждём: зависший сосед не должен задерживать отзывы и каталоги остальных (F-09).
       * Сервис сам перечитает связку, проверит паузу, не повторит раньше срока и не пошлёт дважды разом.
       */
      if (link.confirmPending) {
        void Promise.resolve()
          .then(() => deps.resendConfirmation(link.instanceId))
          .catch((err: unknown) => {
            warn(`[fed] досылка подтверждения ${link.instanceId} упала: ${errText(err)}`);
          });
      }
      /**
       * 🔴 Срок на связку (аудит 19.09, F-09): связки обходятся по очереди, и одна медленная держала
       * отзывы и каталоги всех остальных. Не уложилась — идём дальше, её работа доделается в фоне (у
       * каждого запроса свой общий срок, так что «фон» конечен). ⚠️ Срок не отменяет работу — он лишь
       * перестаёт её ждать, поэтому следующий проход эту связку ПРОПУСКАЕТ, пока прежний заход не
       * кончился (`syncing`, ревью #195 п. 10): второй заход поверх первого — то самое наложение.
       */
      if (syncing.has(link.instanceId)) {
        report.skipped += 1;
        warn(`[fed] связка ${link.instanceId}: прежний заход синхронизации ещё не кончился — проход пропущен`);
        continue;
      }
      syncing.add(link.instanceId);
      const work = Promise.resolve()
        .then(() => deps.syncOneLink(link, now, hour, report))
        .then(() => true as const)
        .catch((err: unknown) => {
          warn(`[fed] синхронизация ${link.instanceId} упала: ${errText(err)}`);
          return true as const;
        })
        .finally(() => {
          syncing.delete(link.instanceId);
        });
      const done = await withBudget(linkBudgetMs, () => work);
      if (done === null) {
        report.failed += 1;
        warn(`[fed] связка ${link.instanceId} не уложилась в ${linkBudgetMs / 1000} с — идём к следующей`);
      }
    }
    return report;
  }

  /**
   * Кнопка держателя «синхронизировать сейчас» — под той же отметкой `syncing`, что и плановый проход
   * (#196 п. 9): иначе она запускала вторую сверку поверх брошенной по сроку, то самое наложение.
   *
   * Только у РАБОЧЕЙ связки (#197 п. 7) и не в аварийную паузу федерации (#198 п. 7): у разорванной кнопка
   * заново наполняла бы кеш, который разрыв вычистил; пауза и «доверие потеряно» — «не разговариваем»,
   * как и в плановом проходе. Срок ответа — `SYNC_NOW_BUDGET_MS`: кнопка не висит дольше, работа
   * доделывается в фоне, и, как и в проходе, отметка `syncing` держится до её конца.
   */
  async function syncLinkNow(instanceId: string): Promise<SyncNowResult> {
    const link = await deps.linkState(instanceId);
    if (!link || link.state !== 'active') return { problem: 'not-active' };
    if (await deps.paused()) return { problem: 'paused' };
    if (syncing.has(instanceId)) return { problem: 'busy' };
    syncing.add(instanceId);
    const work = (async () => {
      // Сосед не знает, что мы подтвердили, — сначала скажем ему (#199 п. 5), иначе сверка упрётся в его
      // отказ. Внутри работы: под отметкой `syncing` и в сроке кнопки; упала досылка — сверка всё равно идёт.
      if (link.confirmPending) {
        await Promise.resolve()
          .then(() => deps.resendConfirmation(instanceId, { force: true }))
          .catch((err: unknown) => {
            warn(`[fed] досылка подтверждения ${instanceId} упала: ${errText(err)}`);
          });
      }
      const { directory, servers } = await deps.syncFull(instanceId);
      return { problem: null, directory, servers } as const;
    })().finally(() => {
      syncing.delete(instanceId);
    });
    const done = await withBudget(syncNowBudgetMs, () => work);
    return done ?? { problem: 'timeout' };
  }

  /** Идёт ли сейчас заход по связке (для проверок). */
  function isSyncing(instanceId: string): boolean {
    return syncing.has(instanceId);
  }

  return { runSyncPass, syncLinkNow, isSyncing };
}
