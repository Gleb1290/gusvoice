import { FED_EVENTS, FED_MEMBERSHIP_STATES } from '@gusvoice/shared';
import { eq } from 'drizzle-orm';
import { rateHit } from '../authGuard.js';
import { db } from '../db/index.js';
import { servers, users } from '../db/schema.js';
import { env } from '../env.js';
import { sendPushToUsers, type PushPayload } from '../push.js';
import { onFedEvent, queueEventTo, type FedEventHandler } from './eventStream.js';
import { guestMembershipsOf, hasGuestGrant } from './guestMembership.js';

/** Окно, в которое хост может разбудить одного нашего человека не больше одного раза (F-04). */
export const GUEST_PUSH_WINDOW_S = 20;

/**
 * Пуш гостю на телефон — через его дом (#139, F5, требование 33).
 *
 * **Почему не напрямую.** Телефон гостя зарегистрирован в пушах ДОМА: устройство знает один инстанс,
 * тот, где человек завёл аккаунт. У хоста, куда он ходит гостем, его устройства нет и быть не
 * может — значит, разбудить телефон хост может только чужими руками. Поэтому событие идёт дому, а
 * дом шлёт свой обычный пуш.
 *
 * 🔴 **Содержимое сообщения дому не уходит.** Дом узнаёт «вашего человека позвали на сервере таком-то
 * у нас» — и всё. Текст, автор и вложения остаются на хосте; клиент заберёт их, когда человек
 * откроет приложение. Иначе «федерация» означала бы, что переписка на чужом сервере копится у дома.
 *
 * ⚠️ Пуш — факт на момент: пропущенное событие догонять бессмысленно, уведомление суточной давности
 * хуже, чем его отсутствие. Поэтому у события нет версии, а очередь его не бережёт особо.
 */

/** Разослать домам гостей просьбу разбудить их людей. Ошибка одного дома не мешает остальным. */
export async function notifyGuestHomes(
  guests: { instanceId: string; homeUserId: string }[],
  payload: PushPayload,
): Promise<void> {
  if (!env.federation.enabled) return;
  // Название сервера — единственное, что едет вместе с фактом: дом должен написать человеку, КУДА
  // его зовут, иначе пуш звучит как «вас где-то позвали». Это не содержимое переписки, а место,
  // куда гость и так вхож.
  let serverName: string | null = null;
  if (payload.serverId) {
    const [row] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, payload.serverId)).limit(1);
    serverName = row?.name ?? null;
  }
  const byInstance = new Map<string, string[]>();
  for (const g of guests) {
    const list = byInstance.get(g.instanceId) ?? [];
    list.push(g.homeUserId);
    byInstance.set(g.instanceId, list);
  }
  for (const [instanceId, userIds] of byInstance) {
    for (const userId of userIds) {
      try {
        await queueEventTo(instanceId, FED_EVENTS.guestNotify, {
          user_id: userId,
          kind: payload.type,
          server_id: payload.serverId ?? null,
          channel_id: payload.channelId ?? null,
          server_name: serverName,
        });
      } catch (err) {
        console.warn(`[fed] пуш гостю не встал в очередь к ${instanceId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

/**
 * Что приём просьбы разбудить берёт СНАРУЖИ, кроме базы: счётчик частоты (Redis) и сам пуш.
 * Вынесено ради проверок — база в них настоящая (PGlite), а эти двое подставные.
 */
export interface GuestPushDeps {
  /** Счётчик частоты: 0 — предел не превышен, иначе секунды до следующей попытки. */
  rateHit(key: string, max: number, windowS: number): Promise<number>;
  sendPushToUsers(recipientIds: string[], payload: PushPayload): Promise<void>;
}

/**
 * Дом принимает просьбу разбудить своего человека.
 *
 * 🔴 Две проверки, и обе обязательны: человек должен быть НАШ (сосед не вправе просить нас будить
 * людей третьего инстанса — так через нас рассылали бы уведомления кому угодно), и просьба должна
 * прийти от того инстанса, где он гость. Без второй сосед, к которому человек однажды заходил, мог
 * бы будить его от имени чужих серверов.
 */
export function registerGuestPushHandlers(): void {
  onFedEvent(FED_EVENTS.guestNotify, createGuestPushHandler({ rateHit, sendPushToUsers }));
}

/**
 * Обработчик `guestNotify` с подставляемыми зависимостями: в бою его вешает `registerGuestPushHandlers`,
 * а проверка зовёт напрямую и видит решение «будить или нет и с каким названием» без Redis и пушей.
 */
export function createGuestPushHandler(deps: GuestPushDeps): FedEventHandler {
  return async ({ instanceId, event }) => {
    const p = event.payload as Record<string, unknown>;
    const userId = typeof p.user_id === 'string' ? p.user_id : null;
    if (!userId) return;

    const [user] = await db
      .select({ home: users.homeInstanceId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    // `home !== null` — это чужой человек в нашей базе (теневая строка гостя), будить его не наше дело.
    if (!user || user.home !== null) return;

    /**
     * Вторая проверка: просьба пришла от того инстанса, где человек ДЕЙСТВИТЕЛЬНО гость. Без неё
     * сосед, к которому человек однажды заходил (или любой связанный с нами вовсе), мог бы будить
     * его от имени выдуманных серверов — то есть слать ему уведомления когда захочет.
     */
    /**
     * 🔴 Индекс членств заполняется со слов того же хоста, поэтому сам по себе он ничего не
     * доказывает (аудит 19.09, F-04): сосед объявлял членство — и тут же по нему проходил. Теперь
     * в индекс попадают только пары, за которые мы РУЧАЛИСЬ (`hasGuestGrant`), а здесь требуется
     * ещё и ДЕЙСТВУЮЩЕЕ членство: хост, откуда человек ушёл или где ему закрыт вход, будить его
     * больше не вправе — надгробие запрета в индексе лежит, но поводом для пуша не служит.
     */
    if (!(await hasGuestGrant(userId, instanceId))) return;
    const places = (await guestMembershipsOf(userId)).filter(
      (m) => m.instanceId === instanceId && m.state === FED_MEMBERSHIP_STATES.active,
    );
    if (places.length === 0) return;

    // Не чаще одного пуша на пару «человек + хост» за окно: событий в пачке может быть сколько
    // угодно, а телефон у человека один. Redis лежит — пропускаем пуш, а не шлём без счёта.
    const limited = await deps.rateHit(`fed:gnotify:${instanceId}:${userId}`, 1, GUEST_PUSH_WINDOW_S).catch(() => 1);
    if (limited > 0) return;

    /**
     * 🔴 Название сервера берём из СВОЕГО индекса по `server_id`, а не из просьбы. Текст пуша читает
     * человек, и подписан он нашим именем: строка из нагрузки позволяла хосту написать в кавычках что
     * угодно — «…». Ваш аккаунт взломан, зайдите на…» — и разослать это всем, кого он знает. В индексе
     * название тоже со слов хоста, но оно обрезано, привязано к серверу, где человек состоит, и то же
     * самое, что он видит у себя в рейле. Сервера в индексе нет — общий текст без названия.
     */
    const serverId = typeof p.server_id === 'string' ? p.server_id : null;
    const place = serverId ? places.find((m) => m.serverId === serverId) : undefined;
    const serverName = place?.serverName ? place.serverName.slice(0, 80) : null;
    const where = serverName ? `на сервере «${serverName}»` : 'на другом инстансе';
    const dm = p.kind === 'dm';
    await deps.sendPushToUsers([userId], {
      type: dm ? 'dm' : 'mention',
      title: 'GusVoice',
      // ⚠️ Ни текста, ни автора: их нам не присылали и присылать не должны. Человек откроет
      // приложение — и увидит всё у хоста, где оно и лежит.
      body: dm ? 'Вам написали в личные сообщения' : `Вас упомянули ${where}`,
      // Сервер — только тот, где человек состоит: иначе тап вёл бы туда, куда его не звали.
      serverId: place?.serverId,
      channelId: place && typeof p.channel_id === 'string' ? p.channel_id.slice(0, 64) : undefined,
      // 🔴 Инстанс, где случилось событие: без него тап по пушу искал бы этот сервер У НАС и не нашёл.
      instanceId,
    });
  };
}

