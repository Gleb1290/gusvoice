/**
 * Закрытие и возврат доступа гостям (#139, F3, план §5.3.1).
 *
 * Держатель снял галочку «Разрешить федеративный доступ» — гости с этого сервера выпадают. Требование
 * 16 говорит: **не молча**. Человек, который прямо сейчас сидит в канале, обязан увидеть
 * окно с объяснением и контактами, а не «сервер пропал».
 *
 * 🔴 Членство при этом НЕ удаляется, а переходит в `closed_by_host`. Вернули галочку — все внутри, с
 * историей, ролями и монетами. Удалять значило бы наказывать людей за решение держателя, да ещё и
 * без возможности отменить.
 *
 * Порядок действий выбран по видимости: сначала выкидываем из голоса (иначе человек продолжает
 * говорить на сервере, куда ему уже закрыт вход), потом шлём окно, потом сообщаем домам.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  FED_CLOSE_REASONS,
  FED_ERRORS,
  FED_MEMBERSHIP_STATES,
  roomForChannel,
  type FedCloseReason,
  type FedMembershipState,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { memberChanged } from '../memberEvents.js';
import { channels, federationLinks, serverFederationExclusions, serverMembers, servers, users } from '../db/schema.js';
import { disconnectUser, removeFromOtherRooms } from '../livekit.js';
import { publishToServer, publishToUser } from '../realtime.js';
import { announceMembership } from './guestMembership.js';
import { bumpTokenGeneration } from '../auth.js';
import { shadowUsername } from './guestRules.js';
import { peerContacts } from './peerContacts.js';
import { getLink } from './links.js';
import { readInstanceMeta } from './instanceMeta.js';

/**
 * Почему доступ закрыт. Сами строки — в `shared/federation/guest.ts` (`FED_CLOSE_REASONS`): они
 * едут и соседу в событии, и клиенту в шлюз, поэтому правда о них одна на все три стороны.
 */
export const CLOSE_REASONS = FED_CLOSE_REASONS;
export type CloseReason = FedCloseReason;

/**
 * Закрыть сервер для гостей — всех или только одной связки.
 *
 * `instanceId` пуст — закрываем всем (сняли галочку целиком); задан — только людям этой связки
 * (выключили её в списке исключений, §5.3).
 *
 * `deps` — только для проверок: подставные рассыльщики показывают `server.invalidate` и окно гостю
 * без Redis. В бою не передаётся, и события идут через `realtime`.
 */
export async function closeServerForGuests(
  input: {
    serverId: string;
    instanceId?: string | null;
    reason: CloseReason;
  },
  deps: { publish?: typeof publishToServer; publishToUser?: typeof publishToUser } = {},
): Promise<number> {
  const publish = deps.publish ?? publishToServer;
  const toUser = deps.publishToUser ?? publishToUser;
  const guests = await guestsOnServer(input.serverId, input.instanceId ?? null, FED_MEMBERSHIP_STATES.active);
  if (guests.length === 0) return 0;

  await db
    .update(serverMembers)
    .set({ state: FED_MEMBERSHIP_STATES.closedByHost, closedAt: new Date() })
    .where(
      and(
        eq(serverMembers.serverId, input.serverId),
        inArray(
          serverMembers.userId,
          guests.map((g) => g.id),
        ),
      ),
    );

  await dropFromVoice(input.serverId, guests.map((g) => g.id));
  // Боты сервера (#231): гости ушли (`member → left`, сделал держатель).
  memberChanged(guests.map((g) => ({ serverId: input.serverId, userId: g.id, actorId: null, from: 'member' as const, to: 'left' as const })));

  /**
   * 🔴 Снять у закрытых гостей ПОДПИСКУ шлюза (аудит 19.09, F-03). Личное `server.access_closed`
   * ниже — это окно для человека, а не граница: сокет, который на него не реагирует, оставался
   * подписан на сервер и получал его события дальше. Подписки шлюз перепроверяет только по
   * `server.invalidate` (`dropRevokedSubscribers`), а поколение токена здесь не поднимается — гость
   * может быть на других серверах, и выкидывать его оттуда не за что.
   */
  await publish(input.serverId, { t: 'server.invalidate', serverId: input.serverId }).catch(() => {});

  for (const guest of guests) {
    // Окно по центру экрана — тем, кто сейчас на сервере. Летит В ЛИЧНЫЕ подключения человека, а не
    // всему серверу: это сообщение адресное, и остальным участникам знать о нём незачем.
    await toUser(guest.id, {
      t: 'server.access_closed',
      serverId: input.serverId,
      reason: input.reason,
      contacts: await ownContactsView(),
    }).catch(() => {
      /* человек не в сети — увидит окно при следующем открытии сервера */
    });
    await announceMembership({
      guest,
      serverId: input.serverId,
      state: FED_MEMBERSHIP_STATES.closedByHost,
      reason: input.reason,
    });
  }
  return guests.length;
}

/**
 * Вернуть доступ: `closed_by_host` → `active`.
 *
 * ⚠️ Возвращаются ТОЛЬКО закрытые нами, а не все, кто когда-либо был: вышедший сам или забаненный
 * не должен вернуться от того, что держатель передумал насчёт федерации.
 */
export async function reopenServerForGuests(input: {
  serverId: string;
  instanceId?: string | null;
}): Promise<number> {
  const closed = await guestsOnServer(input.serverId, input.instanceId ?? null, FED_MEMBERSHIP_STATES.closedByHost);
  /**
   * 🔴 Гостей НЕРАБОЧЕЙ связки возврат галочки не впускает. Их закрыли не из-за неё: связку
   * разорвали, заблокировали или она потеряла доверие, — и открывать им дверь заодно значило бы
   * пускать внутрь тех, с кем держатель как раз перестал разговаривать.
   */
  const active = new Set(
    (await db.select({ instanceId: federationLinks.instanceId }).from(federationLinks).where(eq(federationLinks.state, 'active'))).map(
      (l) => l.instanceId,
    ),
  );
  const guests = closed.filter((g) => g.homeInstanceId !== null && active.has(g.homeInstanceId));
  if (guests.length === 0) return 0;

  await db
    .update(serverMembers)
    .set({ state: FED_MEMBERSHIP_STATES.active, closedAt: null })
    .where(
      and(
        eq(serverMembers.serverId, input.serverId),
        inArray(
          serverMembers.userId,
          guests.map((g) => g.id),
        ),
      ),
    );
  memberChanged(guests.map((g) => ({ serverId: input.serverId, userId: g.id, actorId: null, from: 'left' as const, to: 'member' as const })));

  for (const guest of guests) {
    /**
     * 🔴 Сначала «доступ вернули», потом обычное «перечитай сервер».
     *
     * `server.invalidate` НЕ снимает у клиента отметку «закрыт держателем»: он приходит по десятку
     * поводов (переименование, роли, каналы), и снимать по нему замок значило бы врать всякий раз,
     * когда сервер закрыт, а событие пришло про что-то другое. Поэтому у открытия своё событие —
     * без него гость на стенде 18.09 сидел с замком и окном «сервер закрыт» до перезагрузки.
     */
    await publishToUser(guest.id, { t: 'server.access_restored', serverId: input.serverId }).catch(() => {});
    await publishToUser(guest.id, { t: 'server.invalidate', serverId: input.serverId }).catch(() => {});
    await announceMembership({ guest, serverId: input.serverId, state: FED_MEMBERSHIP_STATES.active });
  }
  return guests.length;
}

/** Гости сервера в заданном состоянии; `instanceId` сужает до одной связки. */
async function guestsOnServer(serverId: string, instanceId: string | null, state: FedMembershipState) {
  const where = [
    eq(serverMembers.serverId, serverId),
    eq(serverMembers.state, state),
    // Теневая строка = гость. Местных это не касается никогда: закрытие федеративного доступа не
    // должно выкидывать с сервера его собственных людей.
    isNotNull(users.homeInstanceId),
  ];
  const rows = await db
    .select({ id: users.id, homeInstanceId: users.homeInstanceId, homeUserId: users.homeUserId })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(...where));
  return rows.filter((r) => r.homeInstanceId !== null && (!instanceId || r.homeInstanceId === instanceId));
}

/** Выкинуть из голоса и показа во всех каналах сервера. */
async function dropFromVoice(serverId: string, userIds: string[]): Promise<void> {
  const voice = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.type, 'voice')));
  for (const ch of voice) {
    for (const userId of userIds) {
      // 404 для того, кого в комнате нет, — обычное дело: гасим молча.
      await disconnectUser(roomForChannel(ch.id), userId).catch(() => {});
      // 🔴 И показ экрана: с десктопа он идёт ОТДЕЛЬНОЙ личностью `<id>#screen` в той же комнате
      // (`createScreenShareToken`), и без этой строки картинка гостя шла всем в канале и после
      // закрытия сервера (аудит run-1 20.09, F-27). Запрет и заморозка гасили обе — закрытие нет.
      await disconnectUser(roomForChannel(ch.id), `${userId}#screen`).catch(() => {});
    }
  }
}

async function ownContactsView() {
  const meta = await readInstanceMeta();
  return meta.contacts.map((c) => ({ kind: c.kind, label: c.label, value: c.value }));
}

/**
 * Почему гостю закрыт этот сервер, или `null` — доступ есть.
 *
 * Зовётся там, где человеку нужен ТЕКСТ, а не просто отказ: открытие сервера, вход в голос. Обычные
 * маршруты обходятся `getMemberContext`, который для закрытого членства отвечает «не участник», —
 * и это правильная сторона ошибки: закрытый гость не должен проходить нигде.
 */
export async function guestAccessRefusal(
  serverId: string,
  userId: string,
): Promise<{ error: string; reason: string; contacts: { kind: string; label: string; value: string }[] } | null> {
  const [row] = await db
    .select({ state: serverMembers.state, home: users.homeInstanceId })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (!row || row.home === null || row.state === FED_MEMBERSHIP_STATES.active) return null;

  return {
    error: FED_ERRORS.serverClosed,
    reason: CLOSE_REASONS.federationDisabled,
    // Контакты НАШЕГО держателя: закрыл сервер он, к нему и обращаться (§5.3.1).
    contacts: await ownContactsView(),
  };
}

/**
 * Контакты держателя ЧУЖОГО инстанса — для окна на стороне гостя, когда отказ пришёл к нам.
 * Вынесено сюда, чтобы клиентские маршруты не тянули протокольные модули напрямую.
 */
export async function contactsOfPeer(instanceId: string) {
  const link = await getLink(instanceId);
  if (!link) return [];
  const list = await peerContacts(link);
  return list.map((c) => ({ kind: c.kind, label: c.label, value: c.value }));
}

/** Все серверы, где этот гость числится (в любом состоянии) — для разрыва связки и запрета. */
export async function guestServerIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));
  return rows.map((r) => r.serverId);
}

/** Имя сервера — для сообщений об отказе. */
export async function serverName(serverId: string): Promise<string | null> {
  const [row] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).limit(1);
  return row?.name ?? null;
}

/**
 * Связку разорвали (или она потеряла доверие) — заморозить её гостей (§5.6.2).
 *
 * 🔴 Заморозить, а не удалить. Теневые строки остаются: на них ссылаются сообщения, роли и монеты, а
 * `DELETE` унёс бы каскадом всю переписку этих людей на наших серверах. Связались снова с ТЕМ ЖЕ
 * инстансом — гости возвращаются с историей, ровно как после возврата галочки (§5.3.1).
 *
 * Что делается: гасятся сессии, людей выкидывает из голоса, членства переходят в `closed_by_host`.
 * Дому при этом НЕ сообщаем: связки больше нет, событию некуда ехать — а очередь исходящих для
 * разорванной связки и так ничего не отправляет.
 */
export async function freezeGuestsOf(instanceId: string): Promise<number> {
  const guests = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.homeInstanceId, instanceId));
  if (guests.length === 0) return 0;

  for (const g of guests) {
    await bumpTokenGeneration(g.id);
    await removeFromOtherRooms(g.id, '').catch(() => {});
    await removeFromOtherRooms(`${g.id}#screen`, '').catch(() => {});
    const frozen = await db
      .update(serverMembers)
      .set({ state: FED_MEMBERSHIP_STATES.closedByHost, closedAt: new Date() })
      .where(and(eq(serverMembers.userId, g.id), eq(serverMembers.state, FED_MEMBERSHIP_STATES.active)))
      .returning({ serverId: serverMembers.serverId });
    memberChanged(frozen.map((m) => ({ serverId: m.serverId, userId: g.id, actorId: null, from: 'member' as const, to: 'left' as const })));
  }
  return guests.length;
}

/**
 * Связка снова рабочая (перепривязка, §5.1.3) — вернуть её гостям то, что закрыла заморозка.
 *
 * 🔴 Возвращается ровно то, что сейчас РАЗРЕШЕНО: сервер с галочкой федеративного доступа и без
 * исключения для этой связки. Считается состояние, а не «что было до заморозки» — так же, как при
 * возврате галочки (`reopenServerForGuests`): сервер, закрытый держателем отдельно, остаётся закрыт.
 * Снятые членства (`removed`: запрет, уход, отзыв аккаунта) не оживают никогда.
 *
 * ⚠️ Без этого шага перепривязка после «ключ скомпрометирован» оставляла гостей соседа запертыми
 * навсегда: заморозка при смене ключа есть, а обратного действия не было вовсе (аудит 19.09, F-20).
 */
export async function thawGuestsOf(instanceId: string): Promise<number> {
  const closed = await db
    .select({
      id: users.id,
      homeInstanceId: users.homeInstanceId,
      homeUserId: users.homeUserId,
      serverId: serverMembers.serverId,
    })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(
      and(
        eq(users.homeInstanceId, instanceId),
        eq(serverMembers.state, FED_MEMBERSHIP_STATES.closedByHost),
        eq(servers.federatedAccess, true),
      ),
    );
  if (closed.length === 0) return 0;

  const excluded = new Set(
    (
      await db
        .select({ serverId: serverFederationExclusions.serverId })
        .from(serverFederationExclusions)
        .where(eq(serverFederationExclusions.instanceId, instanceId))
    ).map((r) => r.serverId),
  );

  let thawed = 0;
  for (const row of closed) {
    if (excluded.has(row.serverId)) continue;
    await db
      .update(serverMembers)
      .set({ state: FED_MEMBERSHIP_STATES.active, closedAt: null })
      .where(and(eq(serverMembers.serverId, row.serverId), eq(serverMembers.userId, row.id)));
    memberChanged({ serverId: row.serverId, userId: row.id, actorId: null, from: 'left', to: 'member' });
    await publishToUser(row.id, { t: 'server.access_restored', serverId: row.serverId }).catch(() => {});
    await announceMembership({ guest: row, serverId: row.serverId, state: FED_MEMBERSHIP_STATES.active });
    thawed += 1;
  }
  return thawed;
}

/**
 * Перепривязка (§5.1.3): гости переезжают на новую личность соседа БЕЗ потерь.
 *
 * 🔴 Без этого переноса перепривязка означала бы, что все гости соседа стали чужими: их теневые
 * строки остались бы привязаны к мёртвому идентификатору, а войдя заново, каждый завёл бы ВТОРУЮ
 * строку — без истории, ролей и монет. Именно это чеклист §11 и называет «переносит теневые строки
 * без потерь».
 *
 * ⚠️ Сессии всё равно гасятся: новая личность — это новый ключ, и старые пропуска к ней отношения
 * не имеют (чеклист: «перепривязка гасит все гостевые сессии людей этого инстанса»).
 */
export async function moveGuestsToInstance(fromInstanceId: string, toInstanceId: string): Promise<number> {
  const guests = await db
    .select({ id: users.id, homeUserId: users.homeUserId })
    .from(users)
    .where(eq(users.homeInstanceId, fromInstanceId));
  if (guests.length === 0) return 0;

  for (const g of guests) {
    await db
      .update(users)
      .set({
        homeInstanceId: toInstanceId,
        // Служебный логин содержит идентификатор инстанса — он тоже переезжает, иначе уникальность
        // пары разошлась бы с уникальностью логина.
        username: shadowUsername(toInstanceId, g.homeUserId ?? g.id),
        // Поколение сессий дома считаем заново: у новой личности своя нумерация.
        homeGen: 0,
      })
      .where(eq(users.id, g.id));
    await bumpTokenGeneration(g.id);
  }
  return guests.length;
}
