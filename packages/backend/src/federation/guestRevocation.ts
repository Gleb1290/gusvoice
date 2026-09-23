/**
 * Отзыв сессий и аккаунтов между инстансами (#139, F3, план §5.6, §5.6.1).
 *
 * Требование 24: «выйти везде» — это фича безопасности, и она обязана работать
 * ЗА пределами своего инстанса. Сценарий, который закрывается: аккаунт угнали, хозяин нажал «выйти
 * везде» или сменил пароль — угонщик не должен остаться гостем на чужих серверах.
 *
 * Два разных события, и разными они сделаны намеренно:
 *  - `user.sessions_revoked` — человек жив и может войти заново прямо сейчас (новое поколение);
 *  - `user.revoked` — аккаунта больше нет или он заблокирован; входить некому.
 * Свести их в одно значило бы выбирать смысл по содержимому нагрузки.
 *
 * 🔴 И журнал. Хост мог быть ВЫКЛЮЧЕН в момент нажатия: событие до него не доедет, повторы упрутся в
 * мёртвый адрес, а поднявшись, он обязан забрать пропущенное сам. Без журнала «выйти везде» было бы
 * обещанием, которое держится, только пока все живы.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import {
  FED_EVENTS,
  FED_MEMBERSHIP_STATES,
  parseRevocationEvent,
  serializeRevocationEvent,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationRevocations, serverMembers, users } from '../db/schema.js';
import { env } from '../env.js';
import { bumpTokenGeneration } from '../auth.js';
import { removeFromOtherRooms } from '../livekit.js';
import { publishToUser } from '../realtime.js';
import { onFedEvent, queueEventTo } from './eventStream.js';
import { grantHostsOf, hostsOf } from './guestMembership.js';
import { federation } from './instance.js';
import { getSignedFromPeer } from './peerClient.js';

/** Сколько отзывов отдаём одним ответом: больше — уже не «догнать», а выгрузка журнала. */
export const REVOCATION_PAGE_MAX = 500;

/** Сколько храним записи журнала: хост, не появлявшийся дольше, всё равно пересоберёт гостей заново. */
export const REVOCATION_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Сколько страниц отзывов забираем за один заход.
 *
 * Предел обязателен по той же причине, что и в каталоге: сосед с ошибкой (или со злым умыслом) может
 * отдавать курсор бесконечно. 50 страниц по 500 записей это 25 000 отзывов за проход — больше, чем
 * бывает у живого инстанса за месяц простоя хоста.
 */
export const REVOCATION_MAX_PAGES = 50;

// --------------------------------------------------------------------------------------------
// Сторона ДОМА: записать и разослать.
// --------------------------------------------------------------------------------------------

/**
 * Человек нажал «выйти везде» / сменил пароль (§5.6.1).
 *
 * 🔴 Порядок: сначала ЗАПИСЬ в журнал, потом рассылка. Упади процесс между ними — отзыв всё равно
 * догонит хоста при следующем его запросе. Обратный порядок терял бы отзыв ровно для тех хостов,
 * которые лежали в этот момент, — то есть для самого опасного случая.
 */
export async function revokeSessionsEverywhere(input: { userId: string; gen: number; now?: number }): Promise<string[]> {
  return await announce({ ...input, kind: 'sessions' });
}

/** Аккаунт удалён или заблокирован (§5.6): гостю на хостах жить больше нечем. */
export async function revokeAccountEverywhere(input: { userId: string; now?: number }): Promise<string[]> {
  return await announce({ ...input, gen: null, kind: 'revoked' });
}

async function announce(input: {
  userId: string;
  gen: number | null;
  kind: 'sessions' | 'revoked';
  now?: number;
}): Promise<string[]> {
  if (!env.federation.enabled) return [];
  const at = input.now ?? Date.now();

  /**
   * 🔴 Список хостов берётся ДО всего остального: при удалении аккаунта индекс членств чистится
   * каскадом, и собрав его после, мы не сообщили бы никому — гость остался бы жить на хостах до их
   * суточной сверки.
   */
  /**
   * И по индексу членств, и по поручительствам (F-26): у хоста, которому мы ручались за человека,
   * гостевая сессия могла остаться и без членства (сессия — это личность, не членство, §5.6).
   */
  const hosts = [...new Set([...(await hostsOf(input.userId)), ...(await grantHostsOf(input.userId))])];

  /**
   * 🔴 Строка журнала — на КАЖДОГО хоста, с его адресом (аудит run-1 20.09, F-26). Раньше запись
   * была одна и без адресата, и `GET /fed/v1/revocations` отдавал её любому соседу с рабочей связкой:
   * тот получал за 30 дней хронологию «кто из наших менял пароль, жал «выйти везде», был удалён» —
   * включая людей, которые у него никогда не гостили. Нет хостов — нет и записи: догонять некому.
   */
  if (hosts.length > 0) {
    await db.insert(federationRevocations).values(
      hosts.map((instanceId) => ({
        id: randomUUID(),
        userId: input.userId,
        kind: input.kind,
        gen: input.gen,
        createdAt: at,
        instanceId,
      })),
    );
  }

  const payload = serializeRevocationEvent({ userId: input.userId, gen: input.gen, at });
  const kind = input.kind === 'sessions' ? FED_EVENTS.userSessionsRevoked : FED_EVENTS.userRevoked;
  for (const instanceId of hosts) {
    try {
      await queueEventTo(instanceId, kind, payload);
    } catch (err) {
      // Не доехало — журнал остался, хост заберёт сам. Это и есть страховка, ради которой он заведён.
      console.warn(`[fed] отзыв ${kind} не встал в очередь к ${instanceId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return hosts;
}

/**
 * Отзывы для хоста, который спрашивает «что я пропустил».
 *
 * `since` — момент из НАШЕГО прошлого ответа (те же грабли часов, что и в каталоге F2: свои часы
 * здесь не годятся, они у двух инстансов разные).
 *
 * 🔴 **Страница с курсором, а не просто предел** (нашёл Codex 16.09). Раньше выборка обрезалась на
 * 500 записях, а в ответе ехало текущее время: хост сохранял его как новый `since` — и всё, что не
 * влезло в первые 500, не возвращалось НИКОГДА. Самый опасный случай тут же и самый вероятный: 500
 * отзывов копятся ровно тогда, когда хост долго лежал, то есть когда догонять важнее всего.
 *
 * Курсор — пара `(время, id)`, как в каталоге: по одному времени записи на границе страницы либо
 * терялись бы, либо повторялись бесконечно.
 */
export async function revocationsSince(
  since: number | null,
  after: { updatedAt: number; id: string } | null = null,
  limit = REVOCATION_PAGE_MAX,
  /** Кто спрашивает: отдаём только адресованное ему (F-26). Маршрут знает его после проверки подписи. */
  instanceId: string | null = null,
) {
  const conditions = [
    instanceId === null ? undefined : eq(federationRevocations.instanceId, instanceId),
    since === null ? undefined : gt(federationRevocations.createdAt, since),
    after === null
      ? undefined
      : sql`(${federationRevocations.createdAt}, ${federationRevocations.id}) > (${after.updatedAt}, ${after.id})`,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  return await db
    .select()
    .from(federationRevocations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(federationRevocations.createdAt), asc(federationRevocations.id))
    .limit(Math.min(limit, REVOCATION_PAGE_MAX));
}

// --------------------------------------------------------------------------------------------
// Сторона ХОСТА: применить.
// --------------------------------------------------------------------------------------------

/**
 * Применить отзыв к теневой строке.
 *
 * Возвращает `true`, если что-то изменилось. Незнакомый человек — не ошибка: дом рассылает отзыв
 * всем хостам из своего индекса, а наш мог обновиться иначе.
 */
export async function applyRevocation(input: {
  instanceId: string;
  homeUserId: string;
  gen: number | null;
  /** `null` у `gen` = аккаунта больше нет. */
  account: boolean;
}): Promise<boolean> {
  const [shadow] = await db
    .select()
    .from(users)
    .where(and(eq(users.homeInstanceId, input.instanceId), eq(users.homeUserId, input.homeUserId)))
    .limit(1);
  if (!shadow) return false;

  if (input.account) {
    /**
     * Аккаунта дома нет (§5.6.2). Строку НЕ удаляем никогда: на неё ссылаются сообщения, и `DELETE`
     * унёс бы каскадом всю переписку человека на наших серверах. Обезличивание делает вызывающий
     * (`anonymizeAccount`) — здесь только гасим сессии и снимаем членства.
     */
    await db
      .update(serverMembers)
      .set({ state: FED_MEMBERSHIP_STATES.removed })
      .where(eq(serverMembers.userId, shadow.id));
  } else if (input.gen !== null) {
    // Поколение ниже запомненного — откат дома из бэкапа: не понижаем (§5.6.1).
    if (input.gen <= shadow.homeGen) return false;
    await db.update(users).set({ homeGen: input.gen }).where(eq(users.id, shadow.id));
  }

  // 🔴 Гасим сессии В ЛЮБОМ случае: и «выйти везде», и «аккаунта нет» означают одно — тем токеном,
  // что сейчас на руках, дальше жить нельзя.
  await bumpTokenGeneration(shadow.id);
  await removeFromOtherRooms(shadow.id, '').catch(() => {});
  await removeFromOtherRooms(`${shadow.id}#screen`, '').catch(() => {});
  // Открытые сокеты шлюза умрут на ближайшей проверке токена; сообщение ускоряет это для тех, кто в сети.
  await publishToUser(shadow.id, { t: 'server.invalidate', serverId: '' }).catch(() => {});
  return true;
}

/** Обработчики отзывов от домов наших гостей. */
export function registerRevocationHandlers(): void {
  onFedEvent(FED_EVENTS.userSessionsRevoked, async ({ instanceId, event }) => {
    const r = parseRevocationEvent(event.payload);
    if (!r) return;
    await applyRevocation({ instanceId, homeUserId: r.userId, gen: r.gen, account: false });
  });

  onFedEvent(FED_EVENTS.userRevoked, async ({ instanceId, event }) => {
    const r = parseRevocationEvent(event.payload);
    if (!r) return;
    await applyRevocation({ instanceId, homeUserId: r.userId, gen: r.gen, account: true });
  });
}

/**
 * Забрать у дома пропущенные отзывы (§5.6.1).
 *
 * 🔴 Зовётся ПЕРВЫМ делом при восстановлении связи, до синхронизации каталогов. Порядок здесь и
 * есть смысл: пока мы обновляем списки, угнанная сессия продолжает жить, — а отзыв это ровно то,
 * что должно примениться раньше всего.
 *
 * Возвращает новое `since` (часы ДОМА из его же ответа) или `null`, если сходить не удалось.
 */
export async function fetchRevocations(input: {
  /** Связка нужна целиком ровно двумя полями — кого спрашиваем и куда стучаться. */
  link: { instanceId: string; apiBase: string };
  since: number | null;
}): Promise<{ applied: number; since: number } | null> {
  const self = federation.identity();
  const key = federation.signingKey();
  if (!self || !key) return null;

  let host: string;
  try {
    host = new URL(input.link.apiBase).host;
  } catch {
    return null;
  }

  let cursor: string | null = null;
  let applied = 0;
  let now: number | null = null;

  /**
   * 🔴 Страницы забираются в ОДИН заход, и `since` двигается только когда забрано ВСЁ. Оборвись мы
   * на середине и запомни время — остальное не вернулось бы никогда (это и был баг, найденный
   * Codex). Предел страниц тот же, что у каталога, и по той же причине: сосед с ошибкой может
   * отдавать курсор бесконечно.
   */
  for (let page = 0; page < REVOCATION_MAX_PAGES; page += 1) {
    const res = await getSignedFromPeer({
      apiBase: input.link.apiBase,
      path: '/api/fed/v1/revocations',
      query: { instance_id: self.instanceId, since: input.since ?? undefined, cursor: cursor ?? undefined },
      keyid: key.kid,
      privateKeyDer: key.privateKeyDer,
      allowHosts: new Set([host]),
      now: Date.now(),
    });
    if (!res.ok || res.value.status < 200 || res.value.status >= 300) return null;

    let body: { now?: unknown; revocations?: unknown; next_cursor?: unknown };
    try {
      body = JSON.parse(res.value.body) as { now?: unknown; revocations?: unknown; next_cursor?: unknown };
    } catch {
      return null;
    }
    const pageNow = typeof body.now === 'number' ? body.now : null;
    const list = Array.isArray(body.revocations) ? body.revocations : null;
    // Ответ без часов отправителя или без списка — негодный целиком: подвинуть `since` по нему
    // значило бы пропустить всё, что было между.
    if (pageNow === null || !list) return null;
    // Время берём из ПЕРВОГО ответа: последующие страницы отдаются позже, и записи, появившиеся
    // между ними, иначе оказались бы «до нашего since» и пропали.
    if (now === null) now = pageNow;

    for (const raw of list) {
      const item = raw as { user_id?: unknown; kind?: unknown; gen?: unknown };
      const userId = typeof item.user_id === 'string' ? item.user_id : null;
      if (!userId) continue;
      const account = item.kind === 'revoked';
      const gen = typeof item.gen === 'number' ? item.gen : null;
      if (await applyRevocation({ instanceId: input.link.instanceId, homeUserId: userId, gen, account })) {
        applied += 1;
      }
    }

    cursor = typeof body.next_cursor === 'string' && body.next_cursor.length > 0 ? body.next_cursor : null;
    if (!cursor) return { applied, since: now };
  }

  /**
   * Упёрлись в предел страниц: забрали не всё, и `since` НЕ двигаем — следующий проход начнёт с того
   * же места и доберёт остальное. Вернуть время здесь значило бы потерять хвост ровно так же, как в
   * найденном баге.
   */
  console.warn(`[fed] отзывы от ${input.link.instanceId}: страниц больше ${REVOCATION_MAX_PAGES}, доберём следующим проходом`);
  return null;
}

/**
 * Убрать из журнала то, что уже никому не догонять.
 *
 * ⚠️ Хост, не появлявшийся месяц, всё равно начнёт с полной сверки каталога и пересоберёт гостей
 * заново — держать ради него весь журнал значит хранить историю чужих выходов без всякой пользы.
 */
export async function pruneRevocations(now: number): Promise<number> {
  const removed = await db
    .delete(federationRevocations)
    .where(lt(federationRevocations.createdAt, now - REVOCATION_KEEP_MS))
    .returning({ id: federationRevocations.id });
  return removed.length;
}
