import { FEATURE_TYPING2, parseTypingAction, typingActionField, typingActionFor, type GatewayServerMessage } from '@gusvoice/shared';
import { reachesPeer } from './blockRules.js';
import { typingRoute } from './gatewayRules.js';

/**
 * Пересылка «печатает…» — обработчик кадра `typing` шлюза, вынесенный из `gateway.ts` (просьба Codex 28.09).
 *
 * Всё, что трогает сеть, Redis и базу, приходит зависимостями: без них ветку нельзя было исполнить в тесте,
 * и двойное отрицание блокировки (#212) ловил только файловый страж. Модуль импортирует лишь чистые
 * правила, поэтому поднимается без `env`, базы и Redis.
 *
 * ⚠️ Граница авторизации та же, что у сообщений (#88): ЛС — только участнику беседы и не тому, кто
 * заблокировал отправителя; канал — только если отправитель сам входит в аудиторию канала.
 */

type TypingMessage = Extract<GatewayServerMessage, { t: 'typing' }>;

export interface TypingDeps<S> {
  /** Окно лимита; не ноль — лимит исчерпан (`authGuard.rateHit`). */
  rateHit(key: string, max: number, windowS: number): Promise<number>;
  /** Собеседник по беседе ЛС или `null`, если отправитель в ней не участвует. */
  dmPeerOf(dmId: string, senderId: string): Promise<string | null>;
  /** Заблокировал ли `blockerId` пользователя `blockedId` (`blocks.isBlockedBy`). */
  isBlockedBy(blockerId: string, blockedId: string): Promise<boolean>;
  /**
   * Показана ли беседа `dmId` человеку `userId` (05.10, `conversations.conversationShownTo`): пустую беседу, которую
   * завёл другой, получатель не видит до первого сообщения — и «печатает» в ней ему не шлём. Нет зависимости — не
   * проверяем (как до 05.10).
   */
  shownTo?(dmId: string, userId: string): Promise<boolean>;
  /**
   * Группа ЛС (07.10, `groups1`): остальные действующие участники, если отправитель в ней; не группа — `null`. Нет
   * зависимости — групп нет (как до `groups1`).
   */
  groupPeersOf?(dmId: string, senderId: string): Promise<string[] | null>;
  /** Открытые соединения пользователя на этом экземпляре шлюза. */
  /** `caps` — возможности соединения (`identify.caps`): по `typing2` решается, получит ли оно `round` или прежнее `voice`. */
  connsOf(userId: string): Iterable<{ socket: S; caps?: ReadonlySet<string> }>;
  send(socket: S, msg: TypingMessage): void;
  /**
   * #225: «печатает» в ЛС через Redis (`gw:user:<id>`, `realtime.publishToUser`) — доставит ВСЕМ процессам бэкенда, в том числе
   * этому (подписчик шлюза разошлёт локальным соединениям), поэтому при заданной зависимости `send` в ЛС НЕ зовётся — иначе
   * кадр удвоился бы. `route` — отбор соединений по возможностям (`cap`/`notCap`, как у `conv.change`): `round` уходит только
   * `typing2`, остальным — `voice`. Нет зависимости — прежнее поведение: только соединения этого процесса (`connsOf` + `send`).
   */
  publishToUser?(userId: string, msg: TypingMessage, route?: { cap?: string; notCap?: string }): Promise<unknown>;
  /**
   * ЛС между инстансами, Э4 (#141): у собеседника нет соединений здесь — если он человек другого инстанса, «печатает» уходит
   * его дому (решает и проверяет блокировку вызываемый). Нет зависимости — некому (как до Э4).
   */
  remoteTyping?(dmId: string, senderId: string, peerId: string, action: string): void;
  /** Исправления ревью 12.10, п. 8: собеседник — человек другого инстанса: «печатает» всегда его дому (`remoteTyping`). */
  isRemote?(userId: string): boolean;
  /**
   * Э7 часть 3 (#141, `dmgroup2`): наш человек печатает в группе — участникам других инстансов (через хост). Вызываемый сам
   * решает, есть ли они; от имени человека другого инстанса (теневая строка) не вызывается. Нет зависимости — некому.
   */
  remoteGroupTyping?(dmId: string, senderId: string, action: string): void;
  getChannelAudience(channelId: string): Promise<{ serverId: string; userIds: string[] } | null>;
  publishToChannel(serverId: string, channelId: string, msg: TypingMessage, audience: string[]): Promise<unknown>;
}

export async function relayTyping<S>(
  deps: TypingDeps<S>,
  conn: { userId: string; servers: Set<string> },
  msg: { serverId?: string; channelId?: string; dmId?: string; action?: unknown },
): Promise<void> {
  const uid = conn.userId;
  // Вид действия (G21): чужое/неизвестное — «печатает»; «печатает» в кадр не пишется (кадр как до G21, правило 11).
  const extra = typingActionField(parseTypingAction(msg.action));
  // `round` («записывает видеосообщение», `typing2`) уходит только соединениям, что его понимают; остальным — `voice` (см. `typingActionFor`).
  // Один кадр собеседнику через Redis (#225): `round` — двумя конвертами по возможности `typing2`, остальное — одним без отбора.
  const publishTo = async (userId: string, dmId: string) => {
    const publish = deps.publishToUser;
    if (!publish) return;
    if (extra.action === 'round') {
      await Promise.all([
        publish(userId, { t: 'typing', dmId, userId: uid, ...typingActionField(typingActionFor('round', new Set([FEATURE_TYPING2]))) }, { cap: FEATURE_TYPING2 }),
        publish(userId, { t: 'typing', dmId, userId: uid, ...typingActionField(typingActionFor('round', undefined)) }, { notCap: FEATURE_TYPING2 }),
      ]);
      return;
    }
    await publish(userId, { t: 'typing', dmId, userId: uid, ...extra });
  };
  const extraFor = (caps: ReadonlySet<string> | undefined) => (extra.action === 'round' ? typingActionField(typingActionFor('round', caps)) : extra);
  if (await deps.rateHit(`typing:${uid}`, 20, 10)) return; // честный клиент шлёт ≤1 / 2.5с
  const peerId = msg.dmId ? await deps.dmPeerOf(msg.dmId, uid) : null;
  // Группа (`groups1`): «Имя печатает» каждому участнику в сети, кроме заблокировавших отправителя (#212). Имя клиент
  // берёт из участников группы в сводке.
  if (msg.dmId && !peerId && deps.groupPeersOf) {
    const peers = await deps.groupPeersOf(msg.dmId, uid);
    if (!peers) return;
    for (const p of peers) {
      if (deps.publishToUser) {
        // #225: в сети ли участник на другом процессе, отсюда не видно — публикуем всем, кроме людей других инстансов.
        if (deps.isRemote?.(p)) continue;
        if (!reachesPeer(await deps.isBlockedBy(p, uid))) continue;
        await publishTo(p, msg.dmId);
        continue;
      }
      const conns = [...deps.connsOf(p)];
      if (conns.length === 0) continue;
      if (!reachesPeer(await deps.isBlockedBy(p, uid))) continue;
      for (const c of conns) deps.send(c.socket, { t: 'typing', dmId: msg.dmId, userId: uid, ...extraFor(c.caps) });
    }
    if (!deps.isRemote?.(uid)) deps.remoteGroupTyping?.(msg.dmId, uid, extra.action ?? 'typing');
    return;
  }
  const route = typingRoute(msg, conn, () => peerId);
  if (!route) return;
  if (route.kind === 'dm') {
    // Собеседник не в сети (ни одного открытого соединения) — слать некому; Telegram так же не шлёт «печатает» тому, кто не
    // в сети дольше 30 с (`api_send_progress.cpp: kSendTypingsToOfflineFor`) — у нас отсрочка не нужна: без соединения кадр
    // не доставить, а два запроса в базу (блок, показ беседы) экономим (07.10, G83).
    const conns = [...deps.connsOf(route.peerId)];
    if (deps.publishToUser) {
      // #225: нет соединений на ЭТОМ процессе ≠ собеседник не в сети (он может быть на другом) — выхода «слать некому» нет.
      if (deps.isRemote?.(route.peerId)) {
        deps.remoteTyping?.(route.dmId, uid, route.peerId, extra.action ?? 'typing');
        return;
      }
    } else if (conns.length === 0 || deps.isRemote?.(route.peerId)) {
      deps.remoteTyping?.(route.dmId, uid, route.peerId, extra.action ?? 'typing');
      return;
    }
    // Заблокированному «печатает» не доходит до того, кто его заблокировал (#212, `blockRules`).
    if (!reachesPeer(await deps.isBlockedBy(route.peerId, uid))) return;
    // Беседа собеседнику ещё не показана (её завёл я, до него не дошло ни одного сообщения) — «печатает» ему не шлём:
    // он узнал бы о беседе раньше первого сообщения (05.10).
    if (deps.shownTo && !(await deps.shownTo(route.dmId, route.peerId))) return;
    if (deps.publishToUser) await publishTo(route.peerId, route.dmId);
    else for (const c of conns) deps.send(c.socket, { t: 'typing', dmId: route.dmId, userId: uid, ...extraFor(c.caps) });
    return;
  }
  // Канал: аудитория считается по факту, и отправитель обязан в неё входить — иначе можно
  // было бы «печатать» в канал, который сам не видишь.
  const audience = await deps.getChannelAudience(route.channelId);
  if (!audience || audience.serverId !== route.serverId || !audience.userIds.includes(uid)) return;
  await deps.publishToChannel(
    route.serverId,
    route.channelId,
    { t: 'typing', channelId: route.channelId, userId: uid, ...extra },
    audience.userIds.filter((id) => id !== uid), // себе «печатает…» не показываем
  );
}
