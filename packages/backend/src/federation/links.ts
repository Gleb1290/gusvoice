/**
 * Связки поверх настоящей базы (#139, F1) — единственное место, где правила из `linkService.ts`
 * встречаются с Postgres, сетью и часами.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { federationLinkCodes, federationLinks, federationMemberships, federationVouchedInstances } from '../db/schema.js';
import { hashLinkSecret } from './linkCode.js';
import { createLinkService, type StoredCode, type StoredLink } from './linkService.js';
import type { LinkState } from './linkRules.js';
import { fetchPeerDocument, postSignedToPeer, proveDomain } from './peerClient.js';
import { domainFromOrigin, federation } from './instance.js';
import { isRevoked, rebindLink } from './revocation.js';
import { fedAudit } from './auditLog.js';
import { queueDepth } from './outbox.js';
import { forgetPeerCache } from './directoryCache.js';
import { forgetPeerDocument } from './peerAuth.js';
import { freezeGuestsOf, thawGuestsOf } from './guestAccess.js';
import { env } from '../env.js';
import { superAdminId } from '../auth.js';
import { publishToUser } from '../realtime.js';
import { refreshPeerOrigins } from '../corsOrigins.js';
import { readInstanceMeta } from './instanceMeta.js';

/**
 * Разбудить вкладку «Федерация»: состояние связок изменилось, пусть перечитает.
 *
 * Зовётся из ОБОИХ мест, где строка связки меняется, — так событие не забудут при новом пути:
 * заявка соседа, его подтверждение, пауза, снятие паузы, разрыв, потеря доверия.
 *
 * ⚠️ Best-effort: шлём мимо ответа и глушим ошибку. Redis лежит — связка всё равно заведена, и
 * ронять из-за этого рукопожатие нельзя; человек увидит новое состояние, открыв вкладку заново.
 */
const linkListeners = new Set<() => void>();

/** Подписка на перемену связок (Э2 часть Б: беседы с людьми соседа — `convLink.refreshFedLinks`). Best-effort. */
export function onLinksChanged(fn: () => void): () => void {
  linkListeners.add(fn);
  return () => linkListeners.delete(fn);
}

function notifyLinksChanged(): void {
  for (const fn of linkListeners) {
    try {
      fn();
    } catch {
      // слушатель не вправе уронить смену связки
    }
  }
  // Источники CORS — сразу, а не через минуту кеша (#197 п. 8): гость только что подтверждённой связки
  // иначе ловил «ошибку сети» до следующего перечитывания. `force` — не присоединяться к чтению, начатому
  // до перемены (#198 п. 9; обновление по сроку присоединяется, #199 п. 9).
  void refreshPeerOrigins({ force: true });
  const admin = superAdminId();
  if (!admin) return;
  void publishToUser(admin, { t: 'federation.links' }).catch((err) => {
    console.warn(`[fed] событие о связках не разослано: ${err instanceof Error ? err.message : err}`);
  });
}

/**
 * Наших людей, что гостят у этого соседа (индекс членств), — разбудить: связка с ним сменила состояние (15.10).
 *
 * 🔴 Зачем: держатель разорвал связку с удалённым навсегда соседом, а у людей в рейле так и висела его группа — выйти
 * оттуда нельзя, хост мёртв. Клиент по событию перечитывает «Где я гость» (`linkState` у каждого места) и убирает группы
 * разорванных связок сам; выключенный клиент узнает то же из ответа при запуске. Событие без нагрузки: список связок
 * инстанса людям не раскрывается, каждый узнаёт только про свои гостевые места.
 * ⚠️ Best-effort, как и событие держателю: Redis лежит — смена связки всё равно состоялась.
 */
async function announceGuestLinks(instanceId: string): Promise<void> {
  try {
    const rows = await db
      .selectDistinct({ userId: federationMemberships.userId })
      .from(federationMemberships)
      .where(eq(federationMemberships.instanceId, instanceId));
    for (const r of rows) await publishToUser(r.userId, { t: 'federation.guest_links' });
  } catch (err) {
    console.warn(`[fed] событие гостям о связке не разослано: ${err instanceof Error ? err.message : err}`);
  }
}

function rowToLink(row: typeof federationLinks.$inferSelect): StoredLink {
  return {
    instanceId: row.instanceId,
    domain: row.domain,
    apiBase: row.apiBase,
    clientOrigin: row.clientOrigin,
    rootKey: row.rootKey,
    theirName: row.theirName,
    state: row.state as LinkState,
    protocolVersion: row.protocolVersion,
    features: row.features,
    confirmPending: row.confirmPending,
  };
}

/** Связка по личности соседа. */
export async function getLink(instanceId: string): Promise<StoredLink | null> {
  const [row] = await db.select().from(federationLinks).where(eq(federationLinks.instanceId, instanceId)).limit(1);
  return row ? rowToLink(row) : null;
}

/**
 * Все связки с метриками — для вкладки «Федерация».
 *
 * Метрики отвечают на три вопроса, которые держатель задаёт первыми, когда что-то не работает:
 * сколько событий не доставлено, когда сосед отвечал в последний раз и не разъехались ли часы.
 */
/** Э7 часть 3 (D, миграция 0143): имена чужих (без связки) инстансов со слов дома группы — для подписи значка (`instanceLabels`). */
export async function listVouchedInstances(): Promise<{ instanceId: string; name: string | null; domain: string }[]> {
  return db
    .select({ instanceId: federationVouchedInstances.instanceId, name: federationVouchedInstances.name, domain: federationVouchedInstances.domain })
    .from(federationVouchedInstances);
}

const vouchedListeners = new Set<() => Promise<void> | void>();

/** Подпись значка (`instanceLabels`) перечитывается, когда дом группы назвал нам новый инстанс. */
export function onVouchedChanged(fn: () => Promise<void> | void): () => void {
  vouchedListeners.add(fn);
  return () => vouchedListeners.delete(fn);
}

export async function saveVouchedInstance(v: { instanceId: string; name: string | null; domain: string; vouchedBy: string }): Promise<void> {
  await db
    .insert(federationVouchedInstances)
    .values(v)
    .onConflictDoUpdate({ target: federationVouchedInstances.instanceId, set: { name: v.name, domain: v.domain, vouchedBy: v.vouchedBy, updatedAt: new Date() } });
  for (const fn of vouchedListeners) await fn();
}

export async function listLinks(): Promise<
  (StoredLink & {
    localName: string | null;
    confirmedAt: Date | null;
    lastSeenAt: Date | null;
    clockSkewMs: number | null;
    queued: number;
  })[]
> {
  const rows = await db.select().from(federationLinks);
  const out = [];
  for (const r of rows) {
    out.push({
      ...rowToLink(r),
      localName: r.localName,
      confirmedAt: r.confirmedAt,
      lastSeenAt: r.lastSeenAt,
      clockSkewMs: r.clockSkewMs,
      queued: await queueDepth(r.instanceId),
    });
  }
  return out;
}

/**
 * Хосты, куда нам вообще можно ходить (`safePeerRequest` сверяется с этим списком).
 *
 * 🔴 Только АКТИВНЫЕ связки: приостановленная или заблокированная не должна оставаться дверью
 * наружу — иначе разрыв связки не разрывал бы исходящие запросы.
 */
export async function activePeerHosts(): Promise<Set<string>> {
  const rows = await db.select().from(federationLinks).where(eq(federationLinks.state, 'active'));
  const hosts = new Set<string>();
  for (const row of rows) {
    try {
      hosts.add(new URL(row.apiBase).host);
    } catch {
      /* кривой адрес в строке связки — просто не даёт разрешения */
    }
  }
  return hosts;
}

/** Найти код по секрету. Отдельно от сервиса: маршрут сверяет секрет ДО похода в сеть (см. ниже). */
export async function findCodeBySecret(secret: string): Promise<StoredCode | null> {
  const [row] = await db
    .select()
    .from(federationLinkCodes)
    .where(eq(federationLinkCodes.secretHash, hashLinkSecret(secret)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    secretHash: row.secretHash,
    purpose: row.purpose === 'rebind' ? 'rebind' : 'link',
    previousInstanceId: row.previousInstanceId,
    expiresAt: row.expiresAt.getTime(),
    usedAt: row.usedAt ? row.usedAt.getTime() : null,
  };
}

/** Убрать просроченные и использованные коды: они уже ничего не открывают, а место занимают. */
export async function purgeStaleCodes(now: Date): Promise<number> {
  const rows = await db
    .delete(federationLinkCodes)
    .where(lt(federationLinkCodes.expiresAt, now))
    .returning({ id: federationLinkCodes.id });
  return rows.length;
}

export const linkService = createLinkService({
  now: () => Date.now(),
  self: () => {
    const identity = federation.identity();
    if (!identity) return null;
    return {
      instanceId: identity.instanceId,
      fingerprint: identity.fingerprint,
      domain: domainFromOrigin(env.clientOrigin),
      apiBase: env.federation.apiBase,
      name: null,
    };
  },
  signing: () => {
    const key = federation.signingKey();
    return key ? { keyid: key.kid, privateKeyDer: key.privateKeyDer } : null;
  },
  fetchDocument: (apiBase, allowHosts) => fetchPeerDocument({ apiBase, allowHosts, now: Date.now() }),
  proveDomain: (doc) => proveDomain(doc),
  async postToPeer({ apiBase, path, payload, allowHosts }) {
    const key = federation.signingKey();
    if (!key) return { ok: false as const, problem: 'unreachable' as const, detail: 'нечем подписать' };
    return postSignedToPeer({
      apiBase,
      path,
      payload,
      keyid: key.kid,
      privateKeyDer: key.privateKeyDer,
      allowHosts,
      now: Date.now(),
    });
  },
  async saveCode(code) {
    await db.insert(federationLinkCodes).values({
      id: code.id,
      secretHash: code.secretHash,
      purpose: code.purpose,
      previousInstanceId: code.previousInstanceId,
      expiresAt: new Date(code.expiresAt),
    });
  },
  findCodeByHash: async (hash) => {
    const [row] = await db
      .select()
      .from(federationLinkCodes)
      .where(eq(federationLinkCodes.secretHash, hash))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      secretHash: row.secretHash,
      purpose: row.purpose === 'rebind' ? 'rebind' : 'link',
      previousInstanceId: row.previousInstanceId,
      expiresAt: row.expiresAt.getTime(),
      usedAt: row.usedAt ? row.usedAt.getTime() : null,
    };
  },
  async markCodeUsed(id, byInstanceId) {
    // 🔴 Атомарно: гасим только ещё не использованный, и база сама решает, кто успел (F-22).
    const rows = await db
      .update(federationLinkCodes)
      .set({ usedAt: new Date(), usedByInstanceId: byInstanceId })
      .where(and(eq(federationLinkCodes.id, id), isNull(federationLinkCodes.usedAt)))
      .returning({ id: federationLinkCodes.id });
    return rows.length > 0;
  },
  isRevoked,
  async domainTaken(domain, except) {
    const want = domain.trim().toLowerCase();
    if (want.length === 0) return false;
    if (domainFromOrigin(env.clientOrigin).toLowerCase() === want) return true;
    const rows = await db
      .select({ instanceId: federationLinks.instanceId, domain: federationLinks.domain, state: federationLinks.state })
      .from(federationLinks);
    // Домен держат только РАБОЧИЕ связки (ревью #195 п. 14): заявка, ожидание подтверждения, разрыв и
    // потеря доверия его не занимают — иначе переустановившийся сосед не завёл бы новую связку никогда.
    return rows.some(
      (r) => !except.includes(r.instanceId) && (r.state === 'active' || r.state === 'paused') && r.domain.toLowerCase() === want,
    );
  },
  getLink,
  async upsertLink(link) {
    const values = {
      instanceId: link.instanceId,
      domain: link.domain,
      apiBase: link.apiBase,
      clientOrigin: link.clientOrigin,
      rootKey: link.rootKey,
      theirName: link.theirName,
      state: link.state,
      protocolVersion: link.protocolVersion,
      features: link.features,
      updatedAt: new Date(),
      ...(link.confirmed ? { confirmedAt: new Date() } : {}),
    };
    await db
      .insert(federationLinks)
      .values(values)
      // Связка одна на инстанс: повторная заявка обновляет строку, а не плодит вторую.
      // ⚠️ `localName` сюда НЕ попадает намеренно: имя, которое держатель дал соседу у себя,
      // не должно стираться оттого, что сосед переподключился.
      .onConflictDoUpdate({ target: federationLinks.instanceId, set: values });
    // `confirmed` при вставке бывает только у перепривязки со стороны сменившего ключ: связка снова
    // рабочая, а её гостей заморозил `revokeOwnKey` — возвращаем то, что сейчас разрешено (F-20).
    if (link.confirmed && link.state === 'active') await thawGuestsOf(link.instanceId);
    notifyLinksChanged();
    void announceGuestLinks(link.instanceId);
  },
  async setConfirmPending(instanceId, pending) {
    await db.update(federationLinks).set({ confirmPending: pending }).where(eq(federationLinks.instanceId, instanceId));
  },
  paused: async () => (await readInstanceMeta()).paused,
  async setLinkState(instanceId, state, confirmed) {
    await db
      .update(federationLinks)
      .set({ state, updatedAt: new Date(), ...(confirmed ? { confirmedAt: new Date() } : {}) })
      .where(eq(federationLinks.instanceId, instanceId));
    // 🔴 Связку разорвали — кеш его людей и серверов у нас больше не хранится (F2, §5.6). Пауза так
    // НЕ работает: она временна, и выбросить кеш значило бы после снятия паузы качать его заново
    // целиком — а списки всё это время были бы пустыми, будто у соседа никого нет.
    if (state === 'blocked') {
      await forgetPeerCache(instanceId);
      forgetPeerDocument(instanceId);
      // Гости этой связки замораживаются: сессии гаснут, членства закрываются, но строки остаются —
      // связались снова, и люди внутри с историей (F3, §5.6.2).
      await freezeGuestsOf(instanceId);
    }
    notifyLinksChanged();
    void announceGuestLinks(instanceId);
  },
  newId: () => randomUUID(),
  // Перенос связки на новую личность соседа живёт в `revocation.ts`: там же и запись об отозванном
  // ключе, и сброс счётчиков событий.
  rebind: (fromInstanceId, to) =>
    rebindLink(fromInstanceId, {
      instanceId: to.instanceId,
      domain: to.domain,
      apiBase: to.apiBase,
      clientOrigin: to.clientOrigin,
      rootKey: to.rootKey,
      theirName: to.theirName,
      protocolVersion: to.protocolVersion,
      features: to.features,
    }),
  // Журнал уровня инстанса (`federation_audit`, F-25): серверный `audit_log` ведётся ПО СЕРВЕРУ
  // (нужны `serverId` и `actorId`), а связка — событие инстанса. Читается во вкладке «Федерация».
  audit: fedAudit,
});
