// WebSocket protocols. Two independent sockets (per the target architecture):
//   * Backend gateway   — text messages + channel/server realtime events.
//   * Presence socket    — authoritative "who is in which voice channel", driven
//                          by LiveKit webhooks, pushed to every client.

import type { Channel, CustomStatus, DmChannel, GameActivity, Message, PresenceMap, PresenceStatus, VoiceParticipant } from './types';

// ===== Backend gateway =====================================================

/** Client -> gateway. */
export type GatewayClientMessage =
  | { t: 'identify'; token: string }
  | { t: 'subscribe'; serverId: string }
  | { t: 'unsubscribe'; serverId: string }
  // "I'm typing" — relayed to the channel's server subscribers (serverId+channelId) or to a
  // DM recipient (dmId+recipientId). Ephemeral; the gateway just fans out the sender's userId.
  | { t: 'typing'; serverId?: string; channelId?: string; dmId?: string; recipientId?: string }
  | { t: 'ping' };

/** Gateway -> client. */
export type GatewayServerMessage =
  | { t: 'ready'; userId: string }
  | { t: 'pong' }
  /**
   * Отказ гейтвея. `serverId` есть у отказа в ПОДПИСКЕ (#126): без него клиент не знает, какой
   * сервер не подписался, и не может пометить его для повторной попытки — а молча забытая
   * подписка означает человека без всех серверных событий до перезапуска приложения.
   */
  | { t: 'error'; message: string; serverId?: string }
  // `serverId` нужен получателю, у которого этот сервер НЕ открыт: канала он не знает (bootstrap
  // только про открытый сервер), а отнести непрочитанное к иконке в рейле обязан.
  | { t: 'message.create'; channelId: string; serverId: string; message: Message }
  | { t: 'message.delete'; channelId: string; messageId: string }
  | { t: 'message.update'; channelId: string; message: Message }
  // A reaction was added/removed; clients apply the delta to their local message state.
  | { t: 'message.reaction'; channelId: string; messageId: string; emoji: string; userId: string; op: 'add' | 'remove' }
  | { t: 'channel.create'; channel: Channel }
  | { t: 'channel.update'; channel: Channel }
  | { t: 'channel.delete'; serverId: string; channelId: string }
  // A permission/visibility change happened — clients re-fetch their bootstrap so each
  // re-evaluates which channels it may see (filtering is per-user and server-side).
  | { t: 'server.invalidate'; serverId: string }
  // General online presence (a user is online while they hold >=1 gateway connection).
  | { t: 'online.snapshot'; users: string[] }
  | { t: 'online.update'; userId: string; online: boolean }
  // A user changed their presence state / custom status — broadcast so every client updates
  // the colored status dot and custom-status line. (Invisible is masked to offline by clients.)
  | { t: 'user.status'; userId: string; status: PresenceStatus; customStatus: CustomStatus | null }
  /**
   * Свой статус + кто его поставил. Уходит ТОЛЬКО на собственные подключения человека
   * (`publishToUser`), потому что `statusAuto` — служебный признак для авто-«отошёл», а не
   * сведения для окружающих: им достаточно обычного `user.status` (#118).
   */
  | { t: 'self.status'; status: PresenceStatus; statusAuto: boolean }
  /**
   * Мой кошелёк на сервере изменился. Уходит ТОЛЬКО собственным подключениям человека
   * (`publishToUser`): чужой баланс — не их дело (#117).
   *
   * 🔴 Пуш вместо опроса. Монеты меняются только по событиям, и все они серверные: выплата,
   * тип в обе стороны, выдача модератора. Опрос раз в N минут выбирал бы между устаревшим числом
   * и дёрганьем без повода, а ещё лишал бы анимацию монеты настоящего повода сработать.
   * ⚠️ Шлём только при смене БАЛАНСА, а не на каждом минутном срезе: прогресс до выплаты человек
   * смотрит в кошельке по требованию, ради него будить всех каждую минуту незачем.
   */
  | { t: 'economy.wallet'; serverId: string; balance: number; earnedTotal: number; seasonEarned: number }
  /**
   * «На сегодня вам натипали сколько можно» — адресно и ОДИН раз за сутки (#121).
   *
   * 🔴 Зачем вообще. Без него получатель не узнаёт, что его хотели наградить: отправитель видит
   * отказ, а он — ничего. Жест пропадает, и это обидно именно тому, кому его делали.
   * ⚠️ Шлём в момент ДОСТИЖЕНИЯ предела, а не на каждую отклонённую попытку. Иначе это готовый
   * способ спамить человека: типай в упор и заваливай его уведомлениями об отказах.
   */
  | { t: 'economy.tipsFull'; serverId: string; received: number }
  // A user changed their profile (display name / avatar) — broadcast so every client refreshes
  // the member list, chat authors and DM list live, without that user having to re-login.
  //
  // 🔴 `animatedAvatarUrl` тут ОБЯЗАТЕЛЕН (#129). Пока его не было, смена анимированного аватара
  // не долетала ни до кого: маршруты аренды вообще ничего не рассылали, а нести им было нечего.
  // Люди видели чужую покупку только после полного перезахода на сервер.
  | {
      t: 'user.update';
      userId: string;
      displayName: string;
      avatarUrl: string | null;
      animatedAvatarUrl: string | null;
    }
  // Ник действует ТОЛЬКО в пределах сервера, поэтому событие серверное, а не глобальное как
  // user.update: на другом сервере тот же человек остаётся под своим обычным именем (#19).
  | { t: 'member.update'; serverId: string; userId: string; nickname: string | null }
  // Кто-то проголосовал. Всем в канал уходит ТОЛЬКО число проголосовавших: счётчики по вариантам
  // здесь были бы утечкой — их не должен видеть тот, кто ещё не голосовал сам.
  | { t: 'poll.update'; channelId: string; messageId: string; voters: number }
  // Счётчики по вариантам — адресно тем, кто уже проголосовал (им результаты и так открыты).
  | { t: 'poll.counts'; channelId: string; messageId: string; options: { id: string; votes: number }[] }
  // A user started / stopped / switched the game they're playing — broadcast so presence shows
  // "🎮 Играет в X". Ephemeral (in-memory, TTL'd on the backend); `activity: null` clears it.
  | { t: 'user.activity'; userId: string; activity: GameActivity | null }
  // A moderator moved this user to another voice channel — their client reconnects there.
  // (Client-driven because the self-hosted LiveKit may not implement MoveParticipant.)
  | { t: 'voice.move'; channelId: string }
  // Direct messages — routed to each participant's own connections (channelId = DM channel id).
  | { t: 'dm.channel'; channel: DmChannel }
  | { t: 'dm.create'; channelId: string; message: Message }
  | { t: 'dm.update'; channelId: string; message: Message }
  | { t: 'dm.delete'; channelId: string; messageId: string }
  // A reaction was added/removed on a DM message; both participants apply the delta.
  | { t: 'dm.reaction'; channelId: string; messageId: string; emoji: string; userId: string; op: 'add' | 'remove' }
  // Someone is typing in a channel or DM (the recipient resolves the display name locally).
  | { t: 'typing'; channelId?: string; dmId?: string; userId: string }
  // «Тебя ткнули» — адресно ОДНОМУ человеку (publishToUser). Эфемерно: не дошло — значит не было,
  // очереди для офлайна нет намеренно (в TeamSpeak так же). `fromName` кладёт сервер: получатель
  // может не знать отправителя (общий сервер есть, а в кэше его профиля может не быть).
  | { t: 'poke'; fromUserId: string; fromName: string; message: string; channelId: string }
  // «Кого-то типнули» (#117) — уходит ВСЕМУ каналу, а не только получателю: звук и подпись слышат
  // все, в этом и смысл жеста. `amount` — сколько ДОШЛО до получателя (после налога), а не сколько
  // списали: показывать надо то, что человек получил.
  /**
   * ⚠️ `toName` появился 05.09: событие несло имя ТОЛЬКО отправителя, и получателя клиент искал
   * в своём ростере. Только что вошедшего там ещё нет — и плашка поверх игры писала
   * «Маша типнула кого-то». Имя с сервера — запасное: ник этого сервера, если он
   * известен клиенту, всё равно важнее (#73).
   */
  | {
      t: 'tip';
      fromUserId: string;
      fromName: string;
      toUserId: string;
      toName: string;
      amount: number;
      channelId: string;
    }
  // МЕГА пок (#117, этап 3) — уходит ВСЕМУ каналу, как и тип.
  // 🔴 Публичность здесь не украшение, а тормоз: публичный прикол сам себя сдерживает, а тихий удар
  // в чужой экран — нет. Получатель по этому же событию получает перья, тряску и звук; остальные —
  // лёгкую отметку «кто кого и за сколько». Решает клиент по `toUserId`.
  | {
      t: 'mega-poke';
      fromUserId: string;
      fromName: string;
      toUserId: string;
      toName: string;
      message: string;
      /** Сколько монет это стоило — часть публичной отметки. */
      amount: number;
      channelId: string;
    }
  /**
   * Выстрел саундборда (#21) — команда «сыграйте вот этот звук», а НЕ сам звук.
   *
   * 🔴 Аудио не публикуется треком в LiveKit: файл уже лежит публичной ссылкой, у клиента уже есть
   * проигрывание звуков, и вторая дорожка на каждый выстрел означала бы пересогласование соединения
   * в самой хрупкой части медиа-стека. Разбор целиком — в `soundboardRules.ts`.
   *
   * ⚠️ `url` едет В СОБЫТИИ, а не ищется клиентом по `clipId`: сэмпл могли удалить между выстрелом
   * и приходом события, и тогда у половины канала звук бы просто не сыграл без всякой причины.
   */
  | {
      t: 'soundboard';
      fromUserId: string;
      fromName: string;
      clipId: string;
      /** Подпись кнопки — её же показываем в отметке «кто что включил». */
      name: string;
      url: string;
      /** Сколько монет это стоило — часть публичной отметки, как у типа и МЕГА пока. */
      amount: number;
      channelId: string;
    }
  /**
   * Гусь выглянул (план, модель G) — предложение забрать надбавку по клику.
   *
   * 🔴 Идёт ЛИЧНО, а не в канал: это доказательство присутствия конкретного человека, и показывать
   * чужого гуся незачем. Расписание и одноразовость целиком на сервере — клиент получает
   * идентификатор, и всё, что он может, — предъявить идентификатор обратно.
   *
   * 🔴 **Срока здесь БОЛЬШЕ НЕТ** (07.09). Гусь ждёт поимки: откат до следующего пошёл от поимки, и
   * сменить непойманного стало некому. Прежний `expiresAtMs` был не просто лишним, а вредным —
   * восстановленному из снимка гусю клиент подставлял ноль, и нажатие по нему молча гасило кнопку
   * без монет: после перезагрузки вкладки гуся было ВИДНО, но забрать его было нельзя.
   */
  | { t: 'goose.offer'; serverId: string; offerId: string };

// ===== Presence socket =====================================================

/** Client -> presence. The client identifies, then receives a full snapshot. */
export type PresenceClientMessage =
  | { t: 'identify'; token: string }
  | { t: 'ping' };

/** Presence -> client. */
/**
 * Рантайм-список типов серверных событий — для `parseEnvelope` в гейтвее: событие с незнакомым `t`
 * до клиента доходить не должно.
 *
 * ⚠️ Таблица, а не массив строк, НАМЕРЕННО: ключи типизированы как `GatewayServerMessage['t']`,
 * поэтому забытый вариант и лишний ключ — ошибки компиляции. Список не может разъехаться с union.
 */
const SERVER_MESSAGE_TYPES: Record<GatewayServerMessage['t'], true> = {
  ready: true,
  error: true,
  pong: true,
  'message.create': true,
  'message.delete': true,
  'message.update': true,
  'message.reaction': true,
  'channel.create': true,
  'channel.update': true,
  'channel.delete': true,
  'server.invalidate': true,
  'member.update': true,
  'online.snapshot': true,
  'online.update': true,
  'user.status': true,
  'self.status': true,
  'economy.wallet': true,
  'economy.tipsFull': true,
  'user.update': true,
  'user.activity': true,
  'poll.update': true,
  'poll.counts': true,
  'voice.move': true,
  'dm.channel': true,
  'dm.create': true,
  'dm.update': true,
  'dm.delete': true,
  'dm.reaction': true,
  typing: true,
  poke: true,
  'mega-poke': true,
  soundboard: true,
  'goose.offer': true,
  tip: true,
};

export function isServerMessageType(t: unknown): t is GatewayServerMessage['t'] {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(SERVER_MESSAGE_TYPES, t);
}

export type PresenceServerMessage =
  | { t: 'pong' }
  | { t: 'error'; message: string }
  // Full picture of every voice channel the user can see, sent on connect.
  //
  // 🔴 `occupied` — сколько миллисекунд канал занят НА МОМЕНТ ОТПРАВКИ, а не отметка времени. Так
  // клиенту не нужно сверять часы с сервером: он берёт число и считает вперёд от своего монотонного
  // счётчика. Расхождение часов на минуту — обычное дело, и на отметке времени оно было бы видно.
  | { t: 'presence.snapshot'; channels: PresenceMap; occupied: Record<string, number> }
  // Incremental update for a single channel (the authoritative participant list).
  // `occupiedMs` — `null`, когда канал пуст (и когда отметка истекла после grace-периода).
  | { t: 'presence.channel'; channelId: string; participants: VoiceParticipant[]; occupiedMs: number | null };

export const PRESENCE_WEBHOOK_PATH = '/livekit/webhook';

/** LiveKit room name <-> channel id helpers (room = `channel_<channelId>`). */
export const ROOM_PREFIX = 'channel_';
export function roomForChannel(channelId: string): string {
  return `${ROOM_PREFIX}${channelId}`;
}
export function channelFromRoom(room: string): string | null {
  return room.startsWith(ROOM_PREFIX) ? room.slice(ROOM_PREFIX.length) : null;
}
