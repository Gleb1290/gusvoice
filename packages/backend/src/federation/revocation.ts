/**
 * Отзыв ключа и перепривязка поверх базы и сети (#139, F1, §5.1.3).
 *
 * Правила — в `keyRevocation.ts`; здесь порядок действий и работа с настоящими связками.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  federationAlerts,
  federationGuestGrants,
  federationLinks,
  federationMemberships,
  federationOutbox,
  federationReports,
  federationRevocations,
  federationRevokedKeys,
  federationSyncState,
  instanceBans,
  serverFederationExclusions,
} from '../db/schema.js';
import { federation } from './instance.js';
import { forgetEventWindow } from './eventStream.js';
import { forgetPeerDocument } from './peerAuth.js';
import { forgetPeerCache } from './directoryCache.js';
import { freezeGuestsOf, moveGuestsToInstance, thawGuestsOf } from './guestAccess.js';
import { postSignedToPeer } from './peerClient.js';
import {
  checkRevocation,
  planRebind,
  serializeRevocation,
  signRevocation,
  type RevocationNotice,
} from './keyRevocation.js';

/** Отозван ли этот инстанс. Отдельно от «неизвестен»: отозванный — сигнал о возможной краже. */
export async function isRevoked(instanceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: federationRevokedKeys.instanceId })
    .from(federationRevokedKeys)
    .where(eq(federationRevokedKeys.instanceId, instanceId))
    .limit(1);
  return row !== undefined;
}

async function recordRevoked(input: {
  instanceId: string;
  replacedBy: string | null;
  domain: string | null;
  origin: 'own' | 'peer';
  revokedAt: Date;
}): Promise<void> {
  await db
    .insert(federationRevokedKeys)
    .values({
      instanceId: input.instanceId,
      replacedByInstanceId: input.replacedBy,
      domain: input.domain,
      origin: input.origin,
      revokedAt: input.revokedAt,
    })
    // Повторный отзыв того же ключа — не ошибка: сосед мог прислать сообщение дважды.
    .onConflictDoNothing({ target: federationRevokedKeys.instanceId });
}

export type RevokeOutcome = {
  previousInstanceId: string;
  newInstanceId: string;
  newFingerprint: string;
  notified: number;
  unreachable: number;
};

/**
 * «Ключ скомпрометирован»: сменить свой корневой ключ и разослать соседям отзыв, подписанный старым.
 *
 * 🔴 Порядок обязателен: подписать отзыв можно ТОЛЬКО пока старый ключ ещё у нас. Поэтому сначала
 * смена (она отдаёт обе личности), потом подпись старым, потом рассылка. Наоборот — и отзыв нечем
 * подписать, а соседи останутся с ключом вора.
 * ⚠️ Свои связки переводятся в «доверие потеряно» сразу, не дожидаясь ответов: наша личность уже
 * сменилась, и с точки зрения соседей мы — другой инстанс, что бы они ни ответили.
 */
export async function revokeOwnKey(): Promise<RevokeOutcome | null> {
  const rotated = await federation.rotateRootKey();
  if (!rotated) return null;

  const revokedAt = Date.now();
  const notice = signRevocation(rotated.previous.rootPrivateKeyDer, {
    oldInstanceId: rotated.previous.instanceId,
    newInstanceId: rotated.next.instanceId,
    newRootKey: Buffer.from(rotated.next.rootPublicKeyDer).toString('base64url'),
    revokedAt,
  });

  await recordRevoked({
    instanceId: rotated.previous.instanceId,
    replacedBy: rotated.next.instanceId,
    domain: null,
    origin: 'own',
    revokedAt: new Date(revokedAt),
  });

  const links = await db.select().from(federationLinks);
  let notified = 0;
  let unreachable = 0;
  for (const link of links) {
    let host: string;
    try {
      host = new URL(link.apiBase).host;
    } catch {
      unreachable += 1;
      continue;
    }
    // 🔴 Подписываем СТАРЫМ корневым ключом напрямую, а не сменным: сменные уже стёрты вместе с
    // корнем, да и сосед сверяет отзыв именно с тем корневым ключом, что записан у него в связке.
    const sent = await postSignedToPeer({
      apiBase: link.apiBase,
      path: '/api/fed/v1/key/revoked',
      payload: serializeRevocation(notice),
      keyid: 'root',
      privateKeyDer: rotated.previous.rootPrivateKeyDer,
      allowHosts: new Set([host]),
      now: revokedAt,
    });
    if (sent.ok && sent.value.status >= 200 && sent.value.status < 300) notified += 1;
    else unreachable += 1;

    /**
     * 🔴 Счётчики событий — с нуля (прогон F-20 на стенде 23.09). Сосед, перепривязывая нас, обнуляет
     * свои (`rebindLink`: для него мы — новая личность, нумерация заново). Оставь мы свои — он ждал бы
     * от нас №1 и получал старый №5 («пропуск», лишняя сверка), а мы помнили бы его №27 и молча
     * выбрасывали как повтор его первые 27 событий после перепривязки: закрытия серверов, запреты,
     * членства. Пока доверия нет, номера не выдаются вовсе (`queueOne`), так что ноль доживёт до
     * перепривязки.
     */
    await db
      .update(federationLinks)
      .set({ state: 'trust-lost', lastEventSeq: 0, missingEventSeqs: [], outEventSeq: 0, updatedAt: new Date() })
      .where(eq(federationLinks.instanceId, link.instanceId));
    forgetEventWindow(link.instanceId);
    forgetPeerDocument(link.instanceId);
    // Доверие потеряно — гости этой связки заморожены (F3, §5.6.2): пускать их по прежним пропускам
    // нельзя, но и историю их переписки терять незачем.
    await freezeGuestsOf(link.instanceId);
  }

  return {
    previousInstanceId: rotated.previous.instanceId,
    newInstanceId: rotated.next.instanceId,
    newFingerprint: rotated.next.fingerprint,
    notified,
    unreachable,
  };
}

export type ReceiveRevocationResult =
  | { ok: true; instanceId: string }
  | { ok: false; problem: 'unknown-link' | 'malformed' | 'wrong-instance' | 'bad-signature' | 'from-future' | 'same-key' };

/**
 * Сосед сообщил, что сменил ключ.
 *
 * 🔴 Принимается автоматически, и это осознанно: подделать такое сообщение может только тот, у кого
 * УЖЕ есть украденный ключ, а худшее, что он этим добьётся, — заморозит связку. Не принимать было бы
 * хуже: тогда после настоящей кражи мы продолжали бы доверять ключу вора.
 * 🔴 Связка переходит в «доверие потеряно», а НЕ на новый ключ: новый ключ в сообщении ничем не
 * подтверждён, и принимать его молча — значит отдать связку тому, кто прислал отзыв. Дальше только
 * перепривязка, где решение принимает человек.
 */
export async function receiveRevocation(raw: unknown): Promise<ReceiveRevocationResult> {
  const notice = (raw ?? null) as RevocationNotice | null;
  if (!notice) return { ok: false, problem: 'malformed' };

  const [link] = await db
    .select()
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, notice.oldInstanceId))
    .limit(1);
  if (!link) return { ok: false, problem: 'unknown-link' };

  const problem = checkRevocation(notice, {
    knownInstanceId: link.instanceId,
    knownRootKeyDer: Buffer.from(link.rootKey, 'base64url'),
    now: Date.now(),
  });
  if (problem) return { ok: false, problem };

  await recordRevoked({
    instanceId: notice.oldInstanceId,
    replacedBy: notice.newInstanceId,
    domain: link.domain,
    origin: 'peer',
    revokedAt: new Date(notice.revokedAt),
  });
  await db
    .update(federationLinks)
    .set({ state: 'trust-lost', updatedAt: new Date() })
    .where(eq(federationLinks.instanceId, notice.oldInstanceId));
  forgetEventWindow(notice.oldInstanceId);
  forgetPeerDocument(notice.oldInstanceId);
  // Ключ соседа объявлен украденным — значит гостевые сессии, заведённые по его поручительству,
  // могли заводиться вором. Гасим их так же, как это делает сам сменивший ключ (`revokeOwnKey`):
  // раньше здесь связка замирала, а уже выданные пропуска продолжали действовать до своего срока.
  await freezeGuestsOf(notice.oldInstanceId);

  return { ok: true, instanceId: notice.oldInstanceId };
}

/**
 * Перенести связку со старой личности соседа на новую (перепривязка, §5.1.3, шаг 4).
 *
 * ⚠️ Имя, которое наш держатель дал соседу, переезжает — оно его. Счётчики событий обнуляются: у
 * соседа с новым ключом нумерация начинается заново, и старый счётчик отбрасывал бы его первые
 * события как уже виденные.
 */
export async function rebindLink(fromInstanceId: string, to: {
  instanceId: string;
  domain: string;
  apiBase: string;
  clientOrigin: string;
  rootKey: string;
  theirName: string | null;
  protocolVersion: number | null;
  features: string[];
}): Promise<boolean> {
  const plan = planRebind(fromInstanceId, to.instanceId);
  const [old] = await db
    .select()
    .from(federationLinks)
    .where(eq(federationLinks.instanceId, plan.fromInstanceId))
    .limit(1);
  if (!old) return false;
  /**
   * 🔴 Второй рубеж F-01 (аудит 19.09), уже у самой базы: переносится только связка, которая была
   * рабочей. Решение «какую и на кого» принимает `linkService.requestLink` (карточка связки, тот же
   * хост, другая личность) — но перенос необратим и уносит с собой всех гостей, поэтому заявку,
   * ожидание подтверждения и разорванную человеком связку он не трогает, кто бы его ни позвал.
   */
  if (old.state !== 'trust-lost' && old.state !== 'active' && old.state !== 'paused') return false;

  await db.transaction(async (tx) => {
    // Под новой личностью могла остаться незавершённая заявка (держатель сначала попробовал обычный
    // код): она мешала бы вставке. Рабочую строку не трогаем — тогда вставка упадёт, и это верно.
    await tx
      .delete(federationLinks)
      .where(and(eq(federationLinks.instanceId, to.instanceId), inArray(federationLinks.state, ['requested', 'pending'])));
    await tx.delete(federationLinks).where(eq(federationLinks.instanceId, plan.fromInstanceId));
    await tx.insert(federationLinks).values({
      instanceId: to.instanceId,
      domain: to.domain,
      apiBase: to.apiBase,
      clientOrigin: to.clientOrigin,
      rootKey: to.rootKey,
      theirName: to.theirName,
      localName: plan.keepLocalName ? old.localName : null,
      iconHash: old.iconHash,
      state: 'active',
      protocolVersion: to.protocolVersion,
      features: to.features,
      lastEventSeq: plan.resetEventCounters ? 0 : old.lastEventSeq,
      missingEventSeqs: plan.resetEventCounters ? [] : old.missingEventSeqs,
      outEventSeq: plan.resetEventCounters ? 0 : old.outEventSeq,
      // Предел места, выставленный держателем, и занятое — это про ТЕХ ЖЕ людей и файлы (#196 п. 8):
      // без переноса предел молча становился умолчанием, а счётчик — нулём.
      quotaBytes: old.quotaBytes,
      usedBytes: old.usedBytes,
      confirmedAt: new Date(),
    });
    /**
     * 🔴 Всё, что у нас привязано к ЛИЧНОСТИ соседа, переезжает вместе со связкой — в той же
     * транзакции, иначе перенос оставляет хвосты на мёртвом идентификаторе:
     *  - запреты на инстанс (аудит 19.09, F-10): они ключуются парой (инстанс, человек), и без
     *    переноса забаненный после перепривязки входил бы снова — причём устроить это сменой ключа
     *    мог бы сам недобросовестный сосед;
     *  - наши поручительства и индекс членств НАШИХ людей у этого соседа (F-04): события о них после
     *    перепривязки приходят уже от новой личности, и без переноса мы отвергали бы их как чужие,
     *    пока каждый человек не войдёт к соседу заново.
     */
    await tx
      .update(instanceBans)
      .set({ homeInstanceId: to.instanceId })
      .where(eq(instanceBans.homeInstanceId, plan.fromInstanceId));
    await tx
      .update(federationGuestGrants)
      .set({ instanceId: to.instanceId })
      .where(eq(federationGuestGrants.instanceId, plan.fromInstanceId));
    await tx
      .update(federationMemberships)
      .set({ instanceId: to.instanceId })
      .where(eq(federationMemberships.instanceId, plan.fromInstanceId));
    /**
     * И журнал отзывов (F-26; ревью #195 п. 2): отзыв адресован хосту по личности, и пока хост
     * лежал без ключей, «выйти везде» записалось на старую. Без переноса новая личность его никогда
     * не догнала бы — угнанная гостевая сессия там жила бы дальше.
     */
    await tx
      .update(federationRevocations)
      .set({ instanceId: to.instanceId })
      .where(eq(federationRevocations.instanceId, plan.fromInstanceId));
    /**
     * 🔴 «Сервер закрыт для этой связки» (прогон F-20 на стенде 23.09). Исключение ключуется личностью
     * соседа, и без переноса оно оставалось на мёртвой: `thawGuestsOf(новая)` ниже не находило его и
     * ВОЗВРАЩАЛО гостей на сервер, который держатель закрыл именно для них. Перенос — «вставить под
     * новой, если там такого нет» и удалить старое: первичный ключ (сервер, инстанс) не даёт UPDATE,
     * если под новой личностью исключение уже стоит.
     */
    const exclusions = await tx
      .select({ serverId: serverFederationExclusions.serverId })
      .from(serverFederationExclusions)
      .where(eq(serverFederationExclusions.instanceId, plan.fromInstanceId));
    if (exclusions.length > 0) {
      await tx
        .insert(serverFederationExclusions)
        .values(exclusions.map((e) => ({ serverId: e.serverId, instanceId: to.instanceId })))
        .onConflictDoNothing();
      await tx.delete(serverFederationExclusions).where(eq(serverFederationExclusions.instanceId, plan.fromInstanceId));
    }
    // Жалобы — про тех же людей: без переноса в панели вместо имени сырой id, а ответ уходил бы по мёртвой личности.
    await tx
      .update(federationReports)
      .set({ instanceId: to.instanceId })
      .where(eq(federationReports.instanceId, plan.fromInstanceId));
    // Оповещения прежней личности — история («связка падала»), но открытыми им висеть незачем: повод снят
    // перепривязкой, а проход оповещений идёт по живым связкам и сам бы их не закрыл никогда.
    await tx
      .update(federationAlerts)
      .set({ resolvedAt: new Date() })
      .where(and(eq(federationAlerts.instanceId, plan.fromInstanceId), isNull(federationAlerts.resolvedAt)));
    // Очередь и отметки сверки — под старую нумерацию и старый кеш: новая связка начинает с нуля и с полной
    // сверки, а события из очереди с прежними номерами сосед счёл бы повтором или пропуском.
    await tx.delete(federationOutbox).where(eq(federationOutbox.instanceId, plan.fromInstanceId));
    await tx.delete(federationSyncState).where(eq(federationSyncState.instanceId, plan.fromInstanceId));
  });
  forgetEventWindow(plan.fromInstanceId);
  forgetEventWindow(to.instanceId);
  // Визитка старой личности больше не годится ни для чего: ключи у соседа уже другие.
  forgetPeerDocument(plan.fromInstanceId);
  forgetPeerDocument(to.instanceId);
  // Кеш каталога был записан под СТАРОЙ личностью: после перепривязки эти строки не принадлежат
  // никому, и новая связка начнёт с полной сверки (F2). Место снятых аватаров — уже новой связке.
  await forgetPeerCache(plan.fromInstanceId, to.instanceId);
  // 🔴 Гости переезжают на новую личность вместе со связкой: иначе каждый, войдя заново, завёл бы
  // ВТОРУЮ теневую строку — без истории, ролей и монет (чеклист §11).
  await moveGuestsToInstance(plan.fromInstanceId, to.instanceId);
  // Потеря доверия замораживала членства этих людей — связка снова рабочая, возвращаем разрешённое.
  await thawGuestsOf(to.instanceId);
  return true;
}
