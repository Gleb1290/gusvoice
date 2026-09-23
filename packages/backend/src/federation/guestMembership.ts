/**
 * Членство гостя: вступление на хосте и индекс на доме (#139, F3, план §5.5).
 *
 * Две стороны одного факта. **Хост** знает, кто у него на сервере, и обязан сообщить дому: иначе
 * «выйти везде» (§5.6.1) не найдёт, куда слать отзыв, а человек на новом устройстве не увидит
 * группу в рейле. **Дом** держит индекс — и по нему строятся «Где я гость» (§5.7) и отметка
 * «скрыт от соседей, но виден» у админа (§5.2.1).
 *
 * 🔴 Событие членства — с версией. Сеть переставляет события местами, и без версии запоздавшее
 * «вышел» затёрло бы уже пришедшее «вернулся»: человек видел бы в рейле сервер, которого у него нет,
 * или наоборот — не видел бы того, где состоит.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  FED_CLOSE_REASONS,
  FED_EVENTS,
  FED_MEMBERSHIP_STATES,
  parseMembershipEvent,
  serializeMembershipEvent,
  stateWins,
  type FedMembershipState,
} from '@gusvoice/shared';
import { db } from '../db/index.js';
import { federationGuestGrants, federationMemberships, serverMembers, servers, users } from '../db/schema.js';
import { env } from '../env.js';
import { onFedEvent, queueEventTo } from './eventStream.js';

/** Надгробие оставляем только для запрета на инстанс — см. ветку `removed` ниже. */
const BANNED_BY_INSTANCE = FED_CLOSE_REASONS.bannedByInstance;

/**
 * Пределы того, что хост может записать в НАШ индекс (аудит 19.09, F-04).
 *
 * Всё это приходит со слов чужого инстанса и ложится в нашу базу и в интерфейс наших людей. Без
 * пределов связанный сосед растил бы таблицу сколько хочет и писал бы в название сервера что угодно
 * любой длины. Числа с большим запасом над жизнью: столько серверов на одном чужом инстансе у
 * человека не бывает, а название сервера у нас самих короче.
 */
export const MEMBERSHIP_LIMITS = { perUserPerInstance: 200, serverName: 100, id: 64, note: 64 } as const;

const clip = (v: string | null, max: number): string | null => (v === null ? null : v.slice(0, max));

/**
 * Ручались ли мы за этого человека перед этим хостом (миграция 0070).
 *
 * 🔴 Единственное, что дом знает о гостевании САМ. Гостем становятся только по нашему токену личности,
 * поэтому пара, по которой токен не выдавался, гостем быть не может — что бы ни утверждал хост. До
 * 19.09 проверялось лишь «человек наш», и сосед объявлял гостем любого из каталога (F-04).
 */
export async function hasGuestGrant(userId: string, instanceId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: federationGuestGrants.userId })
    .from(federationGuestGrants)
    .where(and(eq(federationGuestGrants.userId, userId), eq(federationGuestGrants.instanceId, instanceId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Рассказать дому гостя, что у него изменилось членство.
 *
 * Молча ничего не делаем только при выключенной федерации: остальные отказы (связка лежит, пауза)
 * решает очередь событий — она же и повторит, когда сосед вернётся.
 */
export async function announceMembership(input: {
  /** Теневая строка гостя на НАШЕМ инстансе. */
  guest: { id: string; homeInstanceId: string | null; homeUserId: string | null };
  serverId: string;
  state: FedMembershipState;
  reason?: string | null;
  now?: number;
}): Promise<void> {
  if (!env.federation.enabled) return;
  const { guest } = input;
  if (!guest.homeInstanceId || !guest.homeUserId) return; // местный человек — дому сообщать нечего

  try {
    const [server] = await db.select().from(servers).where(eq(servers.id, input.serverId)).limit(1);
    const [member] = await db
      .select()
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, input.serverId), eq(serverMembers.userId, guest.id)))
      .limit(1);

    const at = input.now ?? Date.now();
    const payload = serializeMembershipEvent({
      // 🔴 Дому отдаём ЕГО идентификатор человека, а не наш теневой: у себя он про нашу строку
      // ничего не знает и сопоставить её ни с кем не сможет.
      userId: guest.homeUserId,
      serverId: input.serverId,
      serverName: server?.name ?? '',
      state: input.state,
      method: member?.joinMethod ?? null,
      invitedBy: member?.invitedBy ?? null,
      reason: input.reason ?? null,
      at,
    });
    /**
     * В очередь, а не сразу: людей на сервере закрывают десятками (§5.3.1), и двадцать подписанных
     * запросов подряд — это вал на соседа, а не скорость.
     *
     * 🔴 Поле `version` события НЕ заполняем, хотя версия у членства есть. Версия здесь — время в
     * миллисекундах, а `version` в очереди это `integer`: миллисекунды эпохи в него не влезают
     * (та же грабля, что и в каталоге F2). Версией служит `at` внутри самой записи — одно число,
     * одно место, и разойтись двум версиям негде.
     */
    await queueEventTo(guest.homeInstanceId, FED_EVENTS.membershipChanged, payload);
  } catch (err) {
    console.warn(`[fed] членство ${input.serverId} не ушло дому: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Приём события членства на ДОМЕ.
 *
 * ⚠️ Сервер с состоянием `removed` уходит из индекса строкой, а не остаётся с пометкой: «где я
 * гость» должен отвечать на вопрос «где я СЕЙЧАС», а история членств никому не нужна и была бы
 * ровно тем списком, который человек не просил о себе хранить.
 */
export function registerMembershipHandlers(): void {
  onFedEvent(FED_EVENTS.membershipChanged, async ({ instanceId, event }) => {
    const parsed = parseMembershipEvent(event.payload);
    if (!parsed) return;
    if (parsed.userId.length > MEMBERSHIP_LIMITS.id || parsed.serverId.length > MEMBERSHIP_LIMITS.id) return;
    const m = {
      ...parsed,
      serverName: parsed.serverName.slice(0, MEMBERSHIP_LIMITS.serverName),
      method: clip(parsed.method, MEMBERSHIP_LIMITS.note),
      invitedBy: clip(parsed.invitedBy, MEMBERSHIP_LIMITS.note),
      reason: clip(parsed.reason, MEMBERSHIP_LIMITS.note),
    };

    // 🔴 Человек обязан быть НАШИМ: сосед не вправе рассказывать нам о членствах чужих людей —
    // иначе связка становится способом подсунуть нам чужой индекс.
    const [user] = await db.select({ id: users.id, home: users.homeInstanceId }).from(users).where(eq(users.id, m.userId)).limit(1);
    if (!user || user.home !== null) return;
    // 🔴 И мы обязаны были за него ПОРУЧИТЬСЯ именно перед этим хостом (F-04, см. `hasGuestGrant`).
    if (!(await hasGuestGrant(m.userId, instanceId))) return;

    const [existing] = await db
      .select()
      .from(federationMemberships)
      .where(
        and(
          eq(federationMemberships.instanceId, instanceId),
          eq(federationMemberships.userId, m.userId),
          eq(federationMemberships.serverId, m.serverId),
        ),
      )
      .limit(1);

    // Версия события — часы ХОСТА; сравниваем с тем, что уже лежит.
    if (existing && !stateWins(m.at, existing.updatedAt)) return;

    // Новая строка сверх предела не заводится: индекс одного человека на одном хосте не бесконечен.
    if (!existing) {
      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(federationMemberships)
        .where(and(eq(federationMemberships.instanceId, instanceId), eq(federationMemberships.userId, m.userId)));
      if ((count?.n ?? 0) >= MEMBERSHIP_LIMITS.perUserPerInstance) return;
    }

    if (m.state === FED_MEMBERSHIP_STATES.removed) {
      /**
       * 🔴 Запрет на ВЕСЬ инстанс (§5.11) строку не удаляет, а оставляет надгробием.
       *
       * Повод — сценарий 5 на стенде 18.09: держатель запретил гостю вход, пока тот стоял ДОМА.
       * Окно «вход закрыт» уходит в шлюз хоста (`server.access_closed`), а шлюз у стоящего дома
       * закрыт — то есть человек не узнал ничего вовсе: сервер просто исчез из рейла, а «Где я
       * гость» бодро сообщил «вы пока нигде не гость». Надгробие — единственное место, где он
       * потом прочтёт, что случилось, и оно не зависит от того, где он был в ту минуту.
       *
       * ⚠️ Обычный уход (сам вышел, кик с сервера) удаляется КАК И РАНЬШЕ: там человек знает, что
       * сделал, и держать об этом запись значило бы копить мусор в списке у каждого.
       */
      if (m.reason === BANNED_BY_INSTANCE) {
        await db
          .insert(federationMemberships)
          .values({
            instanceId,
            userId: m.userId,
            serverId: m.serverId,
            serverName: m.serverName,
            state: m.state,
            method: m.method,
            invitedBy: m.invitedBy,
            reason: m.reason,
            updatedAt: m.at,
          })
          .onConflictDoUpdate({
            target: [federationMemberships.instanceId, federationMemberships.userId, federationMemberships.serverId],
            set: { state: m.state, reason: m.reason, serverName: m.serverName, updatedAt: m.at },
          });
        return;
      }
      await db
        .delete(federationMemberships)
        .where(
          and(
            eq(federationMemberships.instanceId, instanceId),
            eq(federationMemberships.userId, m.userId),
            eq(federationMemberships.serverId, m.serverId),
          ),
        );
      return;
    }

    /**
     * Человек снова вошёл на этот инстанс — старые надгробия запрета убираем: запрет сняли, и
     * висящая строка «вход закрыт» рядом с живым сервером противоречила бы сама себе.
     */
    if (m.state === FED_MEMBERSHIP_STATES.active) {
      await db
        .delete(federationMemberships)
        .where(
          and(
            eq(federationMemberships.instanceId, instanceId),
            eq(federationMemberships.userId, m.userId),
            eq(federationMemberships.state, FED_MEMBERSHIP_STATES.removed),
            eq(federationMemberships.reason, BANNED_BY_INSTANCE),
          ),
        );
    }

    const row = {
      instanceId,
      userId: m.userId,
      serverId: m.serverId,
      serverName: m.serverName,
      state: m.state,
      method: m.method,
      invitedBy: m.invitedBy,
      reason: m.reason,
      updatedAt: m.at,
    };
    await db
      .insert(federationMemberships)
      .values(row)
      .onConflictDoUpdate({
        target: [federationMemberships.instanceId, federationMemberships.userId, federationMemberships.serverId],
        set: {
          serverName: row.serverName,
          state: row.state,
          method: row.method,
          invitedBy: row.invitedBy,
          reason: row.reason,
          updatedAt: row.updatedAt,
        },
      });
  });
}

/** Где наш человек гость — для «Где я гость» (§5.7) и отметки §5.2.1. */
export async function guestMembershipsOf(userId: string) {
  return db.select().from(federationMemberships).where(eq(federationMemberships.userId, userId));
}

/**
 * Кому слать отзыв сессий этого человека (§5.6.1) — список хостов из индекса членств.
 *
 * 🔴 Собирается ДО очистки индекса: удаление аккаунта чистит его каскадом, и порядок здесь решает,
 * узнают ли хосты вообще. Дубли убираются множеством — на одном хосте человек бывает в пяти серверах.
 */
export async function hostsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ instanceId: federationMemberships.instanceId })
    .from(federationMemberships)
    .where(eq(federationMemberships.userId, userId));
  return [...new Set(rows.map((r) => r.instanceId))];
}

/**
 * Хосты, которым мы РУЧАЛИСЬ за человека (F-04, миграция 0070) — второй адресат отзыва (F-26).
 *
 * Членство человек мог потерять (ушёл с сервера, кик), а гостевая сессия на хосте живёт сама по
 * себе до срока: отзыв обязан дойти и туда, где членств уже нет.
 */
export async function grantHostsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ instanceId: federationGuestGrants.instanceId })
    .from(federationGuestGrants)
    .where(eq(federationGuestGrants.userId, userId));
  return [...new Set(rows.map((r) => r.instanceId))];
}

/**
 * Все членства гостей ОДНОЙ связки — для суточной сверки индекса (§5.4).
 *
 * 🔴 Сверка нужна не «на всякий случай»: события теряются при откате хоста из бэкапа и при долгом
 * разрыве, и тогда у человека в рейле навсегда остаётся сервер, откуда его давно убрали, — или
 * наоборот, не появляется тот, где он состоит. Событие чинит мгновенное, сверка — накопленное.
 */
export async function membershipsForPeer(instanceId: string) {
  const rows = await db
    .select({
      homeUserId: users.homeUserId,
      serverId: serverMembers.serverId,
      serverName: servers.name,
      state: serverMembers.state,
      method: serverMembers.joinMethod,
      invitedBy: serverMembers.invitedBy,
      joinedAt: serverMembers.joinedAt,
    })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(users.homeInstanceId, instanceId));
  // Снятые членства не отдаём: «чего нет в ответе, того нет» — то же правило, что в каталоге F2.
  return rows.filter((r) => r.state !== FED_MEMBERSHIP_STATES.removed && r.homeUserId !== null);
}

/**
 * Сверить индекс членств с тем, что отдал хост (сторона ДОМА).
 *
 * ⚠️ Зовётся ТОЛЬКО после полностью полученного ответа: «чего нет в списке, того нет» на половине
 * списка стёрло бы живые членства. Ровно те же грабли, что в сверке каталога (F2).
 */
export async function reconcileMemberships(
  instanceId: string,
  seen: { userId: string; serverId: string; serverName: string; state: string; method: string | null; invitedBy: string | null }[],
  now: number,
): Promise<{ added: number; removed: number }> {
  const existing = await db
    .select()
    .from(federationMemberships)
    .where(eq(federationMemberships.instanceId, instanceId));

  const key = (u: string, s: string) => `${u} ${s}`;
  const seenKeys = new Set(seen.map((m) => key(m.userId, m.serverId)));
  let removed = 0;
  for (const row of existing) {
    if (seenKeys.has(key(row.userId, row.serverId))) continue;
    /**
     * 🔴 Надгробие запрета (`removed` + `banned_by_instance`) сверка НЕ стирает (аудит run-1 20.09,
     * F-28). Хост строки `removed` в ответ не включает по построению — и первая же полная сверка
     * уносила единственное место, где человек прочёл бы, почему сервер пропал. Обычный уход в
     * таблице в этом состоянии не хранится (строка удаляется событием), так что лишнего исключение
     * не удержит; снимает надгробие событие `active` — человек снова вошёл.
     */
    if (row.state === FED_MEMBERSHIP_STATES.removed) continue;
    await db
      .delete(federationMemberships)
      .where(
        and(
          eq(federationMemberships.instanceId, instanceId),
          eq(federationMemberships.userId, row.userId),
          eq(federationMemberships.serverId, row.serverId),
        ),
      );
    removed += 1;
  }

  let added = 0;
  // Сколько строк у человека уже лежит — чтобы сверка не обходила предел, который держит событие.
  const perUser = new Map<string, number>();
  for (const row of existing) {
    if (seenKeys.has(key(row.userId, row.serverId))) perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1);
  }
  const known = new Set(existing.map((row) => key(row.userId, row.serverId)));
  for (const m of seen) {
    if (m.userId.length > MEMBERSHIP_LIMITS.id || m.serverId.length > MEMBERSHIP_LIMITS.id) continue;
    // Человек обязан быть нашим — та же проверка, что и у события.
    const [user] = await db.select({ home: users.homeInstanceId }).from(users).where(eq(users.id, m.userId)).limit(1);
    if (!user || user.home !== null) continue;
    // 🔴 И та же вторая: без нашего поручительства перед этим хостом членству взяться неоткуда (F-04).
    // Сверка — второй путь в тот же индекс, и оставить его без проверки значило бы оставить дыру.
    if (!(await hasGuestGrant(m.userId, instanceId))) continue;
    if (!known.has(key(m.userId, m.serverId))) {
      const have = perUser.get(m.userId) ?? 0;
      if (have >= MEMBERSHIP_LIMITS.perUserPerInstance) continue;
      perUser.set(m.userId, have + 1);
    }
    const row = {
      instanceId,
      userId: m.userId,
      serverId: m.serverId,
      serverName: m.serverName.slice(0, MEMBERSHIP_LIMITS.serverName),
      state: m.state.slice(0, MEMBERSHIP_LIMITS.note),
      method: clip(m.method, MEMBERSHIP_LIMITS.note),
      invitedBy: clip(m.invitedBy, MEMBERSHIP_LIMITS.note),
      reason: null,
      updatedAt: now,
      checkedAt: new Date(now),
    };
    const res = await db
      .insert(federationMemberships)
      .values(row)
      .onConflictDoUpdate({
        target: [federationMemberships.instanceId, federationMemberships.userId, federationMemberships.serverId],
        set: {
          serverName: row.serverName,
          state: row.state,
          method: row.method,
          invitedBy: row.invitedBy,
          checkedAt: row.checkedAt,
        },
      })
      .returning({ id: federationMemberships.serverId });
    if (res.length > 0) added += 1;
  }
  return { added, removed };
}
