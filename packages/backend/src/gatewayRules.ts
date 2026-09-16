import { isServerMessageType, type GatewayServerMessage } from '@gusvoice/shared';

/**
 * Чистые правила доставки по сокету — БЕЗ Redis, базы и Fastify.
 *
 * Вынесено в рамках #91. Здесь решается, дойдёт ли событие до конкретного соединения. До этого
 * решения не было вовсе: серверная ветка разворачивала событие на всех подписчиков, и тело
 * сообщения из приватного канала уезжало тем, кому канал закрыт.
 */

/** Внутренний конверт шины: наружу уходит только `m`, `to` — маршрутизация. */
export interface Envelope {
  m: GatewayServerMessage;
  /** `undefined` — событие всего сервера; иначе только этим пользователям. */
  to?: string[];
}

/**
 * Разобрать сообщение шины. Мусор и старый формат (голое событие без конверта) → `null`.
 *
 * ⚠️ **Fail-closed намеренно.** Соблазн «не разобралось — считаем событием сервера и шлём всем»
 * ровно и воссоздал бы дыру, которую чиним. Потерянное событие лечится следующим bootstrap'ом,
 * лишний получатель не лечится ничем.
 */
export function parseEnvelope(raw: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const env = parsed as { m?: unknown; to?: unknown };
  // ⚠️ `typeof m === 'object'` НЕДОСТАТОЧНО (нашёл Codex): под это подходит и массив, и объект с
  // незнакомым `t` — а гейтвей отправил бы такой payload клиенту. Тип проверяем по таблице, которая
  // синхронна union'у по построению (`isServerMessageType` в shared).
  if (!env.m || typeof env.m !== 'object' || Array.isArray(env.m)) return null;
  if (!isServerMessageType((env.m as { t?: unknown }).t)) return null;
  if (env.to !== undefined && !Array.isArray(env.to)) return null;
  if (Array.isArray(env.to) && env.to.some((x) => typeof x !== 'string')) return null;
  return { m: env.m as GatewayServerMessage, to: env.to as string[] | undefined };
}

/**
 * Отдавать ли это событие соединению данного пользователя.
 *
 * ⚠️ Неидентифицированное соединение (`userId === null`) не получает НИЧЕГО адресного: до `identify`
 * мы не знаем, кто там, а значит не можем утверждать, что он в аудитории.
 */
export function shouldDeliver(env: Envelope, userId: string | null): boolean {
  if (!env.to) return true;
  if (!userId) return false;
  return env.to.includes(userId);
}

/**
 * Может ли `viewerId` знать об онлайне, статусе, профиле и игре человека `subjectId` (#136).
 *
 * Раньше эти события (`online.update`, `user.status`, `user.update`, `user.activity`) уходили ВСЕМ
 * сокетам инстанса — включая те, что ещё не представились. Анонимный сокет, переподключаясь раз в
 * 10 секунд, вёл постоянную слежку за всем инстансом; это подтверждено на проде 14.09.
 *
 * Правило: видят сам человек, супер-админ (он виртуальный участник любого сервера) и те, с кем у
 * человека есть общий сервер или ЛС (`peers` — посчитанный на стороне шлюза набор).
 *
 * ⚠️ Неидентифицированное соединение не получает НИЧЕГО — мы не знаем, кто там.
 * ⚠️ Отношение «есть общий сервер или ЛС» симметрично, поэтому набор можно брать у любой из сторон:
 * у субъекта при рассылке события и у зрителя при сборке снимка — ответ один и тот же.
 */
export function mayObserveUser(
  viewerId: string | null,
  subjectId: string,
  peers: ReadonlySet<string>,
  superAdminId: string | null,
): boolean {
  if (!viewerId) return false;
  if (viewerId === subjectId) return true;
  if (superAdminId && viewerId === superAdminId) return true;
  return peers.has(viewerId);
}

/**
 * Снимок «кто онлайн» для одного зрителя (#136): только те, о ком ему можно знать.
 * `viewerPeers` — набор зрителя (см. симметрию в `mayObserveUser`).
 */
export function visibleOnline(
  onlineIds: Iterable<string>,
  viewerId: string,
  viewerPeers: ReadonlySet<string>,
  superAdminId: string | null,
): string[] {
  // ⚠️ Здесь набор — ЗРИТЕЛЯ, поэтому ищем в нём субъекта (`has(id)`), а не зрителя, как в
  // `mayObserveUser`. Перепутать легко: первая версия так и сделала, и снимок пустел у всех.
  const isSuper = !!superAdminId && viewerId === superAdminId;
  const out: string[] = [];
  for (const id of onlineIds) if (isSuper || id === viewerId || viewerPeers.has(id)) out.push(id);
  return out;
}

/**
 * Изменился ли состав сервера и чьи наборы «с кем есть общий сервер» могли поменяться (#136).
 *
 * `prev === undefined` — шлюз ещё не знает прошлого состава (сервер впервые после старта): считаем,
 * что изменилось, и пересылаем снимок всем нынешним участникам. Лишний снимок безвреден, пропущенный
 * — это человек, который после вступления в сервер видит всех остальных «не в сети».
 * ⚠️ В `affected` входят и ушедшие: у них набор сузился, и прежний снимок показывал лишнее.
 */
export function membershipDiff(
  prev: ReadonlySet<string> | undefined,
  next: ReadonlySet<string>,
): { changed: boolean; affected: string[] } {
  if (!prev) return { changed: true, affected: [...next] };
  const added = [...next].filter((id) => !prev.has(id));
  const removed = [...prev].filter((id) => !next.has(id));
  if (added.length === 0 && removed.length === 0) return { changed: false, affected: [] };
  return { changed: true, affected: [...next, ...removed] };
}

/**
 * Кому уходит «печатает…» и уходит ли вообще (#88).
 *
 * Раньше и `serverId`, и `recipientId` брались ИЗ СООБЩЕНИЯ КЛИЕНТА без единой проверки, поэтому
 * посторонний мог светиться в чужом сервере и стучаться в ЛС к тем, с кем не переписывался.
 *
 * ⚠️ Для ЛС получатель НЕ берётся из сообщения — он выводится из состава диалога. Проверять
 * присланный `recipientId` было бы полумерой: правильный ответ в том, чтобы перестать ему верить.
 */
export function typingRoute(
  msg: { serverId?: string; channelId?: string; dmId?: string },
  conn: { userId: string; servers: Set<string> },
  dmPeer: (dmId: string) => string | null,
): { kind: 'dm'; dmId: string; peerId: string } | { kind: 'channel'; serverId: string; channelId: string } | null {
  if (msg.dmId) {
    const peerId = dmPeer(msg.dmId);
    return peerId ? { kind: 'dm', dmId: msg.dmId, peerId } : null;
  }
  if (msg.serverId && msg.channelId) {
    // Подписка выдаётся только после проверки членства (`subscribe` → `getMemberContext`), поэтому
    // множество уже проверенное. Право ВИДЕТЬ канал проверяется отдельно, по аудитории.
    if (!conn.servers.has(msg.serverId)) return null;
    return { kind: 'channel', serverId: msg.serverId, channelId: msg.channelId };
  }
  return null;
}
