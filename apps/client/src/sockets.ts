import {
  type GatewayClientMessage,
  type GatewayServerMessage,
  mentionsMe,
  type PresenceServerMessage,
  voicePublishBits,
} from '@gusvoice/shared';
import { api, getToken } from './api';
import { notifyLevel } from './channelPrefs';
import { shouldPulseWallet } from './coinsCue';
import { ensureEconomy } from './economyClient';
import { resolveMemberName } from './memberName';

/**
 * Имя валюты ОТКРЫТОГО сервера — для отметок в канале.
 *
 * ⚠️ Берём по открытому серверу, а не из события: канальные события несут только `channelId`, а
 * приходят они ровно тем, кто сидит в этом канале, то есть на этом же сервере.
 *
 * ⚠️ Раньше в этих строках было вшито «монет», и при переименованной валюте отметка расходилась с
 * кошельком, где имя подставляется (аудит текстов 03.09). Снимка нет — отдаём нейтральное слово.
 */
function currencyNow(): string {
  const s = useStore.getState();
  return (s.bootstrap ? s.economy[s.bootstrap.server.id]?.currencyName : null) ?? 'монет';
}
import { config, gatewayWsUrl } from './config';
import { flashWindow } from './flashWindow';
import { shouldNotifyCoin } from './coinNotifyRules';
import {
  authorName,
  coinNotifyLevel,
  messagePreview,
  osNotify,
  osNotifyLevel,
  osNotifyRaw,
  windowFocused,
} from './notifications';
import { passesThrottle, shouldOsNotify } from './notifyRules';
import { CONNECT_TIMEOUT_MS, PING_MS, socketStale } from './socketHealth';
import { playClip, playSound } from './sounds';

/**
 * Подписка на «гусь выглянул».
 *
 * 🔴 Набором слушателей, а не полем в сторе: предложение — СОБЫТИЕ, а не состояние. Живое
 * состояние «висит ли сейчас гусь» приезжает снимком экономики (`economy[serverId].goose`), и
 * держать вторую его копию в сторе значило бы завести две правды об одном.
 * ⚠️ Срока у предложения НЕТ (07.09): гусь ждёт поимки, см. `goose.offer` в `shared/ws.ts`.
 */
type GooseOffer = { serverId: string; offerId: string };
const gooseListeners = new Set<(o: GooseOffer) => void>();

export function onGooseOffer(fn: (o: GooseOffer) => void): () => void {
  gooseListeners.add(fn);
  return () => gooseListeners.delete(fn);
}

/**
 * Вызвать гуся руками — ДЛЯ СТЕНДА (#120), в приложении не используется.
 *
 * 🔴 Заменяет прежнюю отладочную заглушку с собственным расписанием. Разница принципиальная: та
 * висела в дереве и сама решала, когда показать гуся, — то есть повторяла логику сервера и могла
 * с ней разойтись. Эта не решает ничего, только толкает готовое предложение по тому же пути, что
 * и настоящее.
 * ⚠️ Идентификатор заведомо непригодный: попытка забрать такого гуся ДОЛЖНА получить честный отказ
 * от сервера. Стенд проверяет показ и анимацию, а не выдачу монет.
 */
export function emitBenchGooseOffer(serverId: string): void {
  const offer: GooseOffer = { serverId, offerId: 'bench' };
  for (const fn of gooseListeners) fn(offer);
}
import {
  newSubsState,
  onDisconnect as subsDisconnect,
  onReady as subsReady,
  onSubRejected,
  resetSubs,
  wantSub,
} from './gatewaySubs';
import { useStore } from './store';
import { fireEffect } from './effectsBus';
import { pulseChip } from './effectsDom';
import { shouldPlayTipCue } from './tipMode';
import { toast, toastError } from './toast';
import { noteTyping } from './typing';

let gateway: WebSocket | null = null;
let presence: WebSocket | null = null;
/**
 * Серверы, события которых мы слушаем. РАНЬШЕ здесь лежал ОДИН `subscribedServer` — тот, что открыт
 * в окне, — и всё остальное для клиента не существовало: пока ты сидишь на сервере A, сообщение на
 * сервере B не приходит вообще. Ни в ленту, ни в счётчик непрочитанных, ни в уведомление. А открыв B
 * позже, ты его не видел и там: историю канала клиент перезапрашивать не считал нужным (см.
 * `openChannel`), а `markChannelRead` при открытии гасил серверный счётчик. Сообщение пропадало молча.
 *
 * Гейтвей держит подписки МНОЖЕСТВОМ (`conn.servers`) с самого начала — ограничение было чисто
 * клиентским. Подписываемся на все свои серверы сразу после коннекта.
 */
const subs = newSubsState();

// Keepalive pings so the gateway and presence sockets aren't dropped while idle; the server replies
// with pong. Пороги и правило «протух» — в `socketHealth.ts` (чистые, проверяются тестом).
let gatewayPing: ReturnType<typeof setInterval> | null = null;
let presencePing: ReturnType<typeof setInterval> | null = null;

// Timestamp of the last frame RECEIVED on each socket (any message, incl. the server's pong).
let gatewayLastRecv = 0;
let presenceLastRecv = 0;
let gatewayHadConnected = false; // first connect loads history itself; only RE-connects need a backfill
let watchersInstalled = false;

function heartbeat(socket: WebSocket, lastRecv: () => number): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socketStale(lastRecv(), Date.now())) {
      socket.close(); // half-open after sleep → force onclose → reconnect
      return;
    }
    socket.send(JSON.stringify({ t: 'ping' }));
  }, PING_MS);
}

// On resume-from-sleep / regained focus / back-online, a socket can be silently half-open. Force a
// liveness check: close an OPEN-but-stale socket so its onclose reconnects. A null socket is already
// reconnecting; a CONNECTING one is left to finish. Faster than waiting for the next heartbeat tick.
function pokeSocket(socket: WebSocket | null, lastRecv: () => number): void {
  if (socket && socket.readyState === WebSocket.OPEN && socketStale(lastRecv(), Date.now())) {
    socket.close();
  }
}

function installResumeWatchers(): void {
  if (watchersInstalled || typeof window === 'undefined') return;
  watchersInstalled = true;
  const poke = () => {
    pokeSocket(gateway, () => gatewayLastRecv);
    pokeSocket(presence, () => presenceLastRecv);
  };
  window.addEventListener('online', poke);
  window.addEventListener('focus', poke);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poke();
  });
}

function reconnect(fn: () => void): void {
  setTimeout(fn, 2000);
}

/**
 * Сторож РУКОПОЖАТИЯ: зависший `CONNECTING` закрываем сами, чтобы сработал `onclose` и обычное
 * переподключение. Разбор — в шапке `CONNECT_TIMEOUT_MS`.
 *
 * ⚠️ Возвращает функцию снятия: её обязаны позвать и `onopen`, и `onclose`, иначе таймер закроет
 * уже РАБОЧИЙ сокет через пятнадцать секунд после успешного коннекта.
 */
function guardHandshake(socket: WebSocket): () => void {
  const t = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) socket.close();
  }, CONNECT_TIMEOUT_MS);
  return () => clearTimeout(t);
}

// Advance the persisted read mark for the channel/DM the user is LOOKING at, throttled so a
// burst of messages costs one request. (Opening a channel marks read in store.openChannel.)
// Когда по каналу последний раз показывали системное уведомление — против лавины всплывашек
// в живом канале (#77). Упоминания через троттл проходят всегда, см. `passesThrottle`.
const lastOsNotifyAt = new Map<string, number>();
let lastTipCueAt: number | null = null;
/** Когда последний раз всплывала системная всплывашка про ЧУЖИЕ монеты — для троттла (04.09). */
let lastCoinNotifyAt = 0;

/**
 * Системное уведомление про монеты: «кто кого типнул / ущипнул».
 *
 * Решение целиком в `coinNotifyRules` — здесь только сбор входа и доставка. Гейт СВОЙ, не общий с
 * сообщениями: это разные настройки, и выключивший болтовню не должен молча потерять монеты.
 */
function notifyCoin(mine: boolean, title: string, body: string): void {
  const now = Date.now();
  const ok = shouldNotifyCoin({
    level: coinNotifyLevel(),
    mine,
    dnd: useStore.getState().user?.status === 'dnd',
    focused: windowFocused(),
    lastOtherAt: lastCoinNotifyAt,
    now,
  });
  if (!ok) return;
  if (!mine) lastCoinNotifyAt = now;
  osNotifyRaw(title, body);
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleRead(key: string, fn: () => void): void {
  if (readTimers.has(key)) return;
  readTimers.set(
    key,
    setTimeout(() => {
      readTimers.delete(key);
      fn();
    }, 2000),
  );
}

export function connectGateway(): void {
  const token = getToken();
  if (!token) return;
  installResumeWatchers();
  gateway = new WebSocket(gatewayWsUrl());
  const gatewayHandshake = guardHandshake(gateway);

  gateway.onopen = () => {
    gatewayHandshake();
    gatewayLastRecv = Date.now();
    gateway?.send(JSON.stringify({ t: 'identify', token }));
    /**
     * 🔴 **Подписки уходят на `ready`, а НЕ здесь** (#126). Раньше `subscribe` летел вплотную за
     * `identify`, в том же кадре, — а сервер разбирает `identify` асинхронно и такой `subscribe`
     * заставал соединение ещё безымянным и отклонялся с «identify first». Клиент отказ не слушал,
     * у себя помечал сервер подписанным и не пересылал никогда: человек оставался без ВСЕХ
     * серверных событий (типы, щипки, саундборд, сообщения) до перезапуска приложения. Личные
     * события и голос при этом шли своими путями — оттого и выглядело как «сломался только звук».
     * ⚠️ На первом подключении гонки не было (список ещё пуст), ломалось ровно переподключение —
     * то есть каждая выкатка бэкенда.
     */
    // Подписка на ВСЕ свои серверы, а не только на открытый: иначе про чужой сервер не приходит
    // ничего. Список тянем на каждый (ре)коннект — за время обрыва нас могли куда-то позвать.
    void api
      .listServers()
      .then((servers) => subscribeToServers(servers.map((s) => s.id)))
      .catch(() => {
        /* список догонит при следующем коннекте — не роняем сокет из-за него */
      });
    if (gateway) gatewayPing = heartbeat(gateway, () => gatewayLastRecv);
    // Seed everyone's current game activity (#40) on (re)connect — live deltas arrive via user.activity.
    void api.getActivities().then((r) => useStore.getState().setActivities(r.activities)).catch(() => {});
    // On a RE-connect (not the first) we were likely half-open and missed message.create events while
    // asleep — refetch the open channel/DM + unread state so nothing stays silently missing.
    if (gatewayHadConnected) void useStore.getState().resyncAfterReconnect();
    // Гейтвей поднялся — значит сеть жива. Если нас выбило из голоса и с тех пор прошло немного,
    // возвращаемся в тот же канал. Это единственный доступный сигнал «связь вернулась»: сам
    // VoiceConnection к этому моменту уже размонтирован вместе с комнатой LiveKit.
    if (gatewayHadConnected) void useStore.getState().rejoinVoiceAfterOutage();
    gatewayHadConnected = true;
  };

  gateway.onmessage = (ev) => {
    gatewayLastRecv = Date.now();
    const msg = JSON.parse(ev.data) as GatewayServerMessage;
    const store = useStore.getState();
    switch (msg.t) {
      /**
       * Сервер узнал, кто мы, — только теперь подписки имеют смысл (#126). Шлём ВЕСЬ список: это же
       * и восстановление после обрыва, ради которого `want` переживает переподключение.
       */
      case 'ready': {
        for (const id of subsReady(subs)) sendSubscribe(id);
        return;
      }
      /**
       * Отказ гейтвея. Раньше клиент не слушал его вовсе — и отклонённая подписка выглядела как
       * успешная: человек молча лишался всех серверных событий.
       * ⚠️ Из ЖЕЛАЕМОГО сервер не выбывает: отказ бывает временным. Снимается только отметка
       * «отправлено», повтор произойдёт на следующем `ready` — так отказ не превращается в цикл.
       */
      case 'error': {
        if (msg.serverId) onSubRejected(subs, msg.serverId);
        return;
      }
      case 'message.create': {
        if (msg.message.author.id !== store.user?.id) {
          // Per-channel level: 'none' stays silent, 'mentions' reacts only to @-mentions, 'all' to any.
          const channelLevel = notifyLevel(msg.channelId);
          const mentioned = mentionsMe(msg.message.content, store.user?.username);
          const notify = channelLevel === 'all' || (channelLevel === 'mentions' && mentioned);
          const dnd = store.user?.status === 'dnd';
          if (notify && msg.channelId !== store.currentChannelId) store.markUnread(msg.channelId, mentioned, msg.serverId);
          // Watching the channel — keep the persisted read mark current so a reload stays read.
          if (msg.channelId === store.currentChannelId) {
            scheduleRead(`ch:${msg.channelId}`, () => void api.markChannelRead(msg.channelId).catch(() => {}));
          }
          // "Не беспокоить" (DND) additionally suppresses notification sounds (unread still tracked).
          if (notify && mentioned && !dnd) playSound('mention');
          // Системное уведомление (#77). РАНЬШЕ звалось только из ветки упоминания — про обычное
          // сообщение свёрнутое приложение молчало. Теперь решает `notifyRules`, а обычные
          // сообщения дополнительно троттлятся, чтобы живой канал не выплюнул двадцать всплывашек.
          if (
            shouldOsNotify({ level: osNotifyLevel(), channelLevel, mentioned, dnd, focused: windowFocused() }) &&
            passesThrottle(mentioned, lastOsNotifyAt.get(msg.channelId), Date.now())
          ) {
            lastOsNotifyAt.set(msg.channelId, Date.now());
            const where = `#${store.bootstrap?.channels.find((c) => c.id === msg.channelId)?.name ?? 'канале'}`;
            osNotify(
              mentioned ? `${authorName(msg.message)} упомянул вас в ${where}` : `${authorName(msg.message)} в ${where}`,
              messagePreview(msg.message),
              () => void useStore.getState().openChannel(msg.channelId),
            );
          }
        }
        return store.appendMessage(msg.channelId, msg.message);
      }
      case 'message.update':
        return store.updateMessage(msg.channelId, msg.message);
      case 'message.delete':
        return store.removeMessage(msg.channelId, msg.messageId);
      case 'message.reaction':
        return store.applyReaction(msg.channelId, msg.messageId, msg.emoji, msg.userId, msg.op);
      case 'channel.create':
      case 'channel.update':
        return store.upsertChannel(msg.channel);
      case 'channel.delete':
        return store.deleteChannel(msg.serverId, msg.channelId);
      case 'server.invalidate': {
        // Список серверов (рейл: имя + иконка) живёт ОТДЕЛЬНО от bootstrap, поэтому обновляем его
        // ВСЕГДА — даже когда событие про сервер, который сейчас не открыт. Иначе переименование
        // и смена иконки доезжали бы до остальных только после перезагрузки страницы.
        void store.loadServers();
        if (msg.serverId !== store.currentServerId) return;
        /**
         * 🔴 Снимок экономики перечитываем ТОЖЕ (требование 03.09: «права должны открываться
         * сиюсекундно, без перезахода»). Всё остальное — права, каналы, ростер — уже обновляет
         * `refreshBootstrap` ниже, а экономика жила отдельным кэшем и ходила только при открытии
         * сервера и по возврату фокуса. Из-за этого выданное право `MANAGE_ECONOMY` (ползунки,
         * минуты, журнал сервера) и правки витрины доезжали с задержкой до следующего фокуса.
         * ⚠️ `force`, иначе дедуп в `ensureEconomy` увидит готовый снимок и никуда не пойдёт.
         */
        ensureEconomy(msg.serverId, true);
        // Refresh perms; if our voice publish grants changed while connected, re-mint the token.
        const before = voicePublishBits(store.bootstrap?.permissions);
        void store
          .refreshBootstrap(msg.serverId)
          .then(() => {
            const s = useStore.getState();
            if (s.voice && voicePublishBits(s.bootstrap?.permissions) !== before) void s.refreshVoiceToken();
          })
          .catch((err: Error & { status?: number }) => {
            // 🔴 Нас больше нет на этом сервере: кик, бан или собственный выход (#92). До #91 кик
            // вообще ничего не публиковал, поэтому ветка не срабатывала — а без неё промис падал
            // необработанным, и человек оставался смотреть на сервер, из которого его выгнали.
            // ⚠️ Только 403/404: на сетевой сбой или 5xx (бэкенд в момент выкатки) уводить в ЛС
            // нельзя — сервер никуда не делся, надо просто дождаться следующего события.
            if (err.status !== 403 && err.status !== 404) return;
            const s = useStore.getState();
            if (s.currentServerId !== msg.serverId) return;
            if (s.voice) s.leaveVoice();
            useStore.setState({ currentServerId: null, bootstrap: null, currentChannelId: null });
            s.setView('dm');
          });
        return;
      }
      case 'online.snapshot':
        return store.setOnlineSnapshot(msg.users);
      case 'online.update':
        return store.setOnlineUpdate(msg.userId, msg.online);
      case 'user.status':
        return store.applyUserStatus(msg.userId, msg.status, msg.customStatus);
      case 'self.status':
        return store.applySelfStatus(msg.status, msg.statusAuto);
      case 'economy.tipsFull':
        // 🔴 Отбивка по ИЗОБИЛИЮ, а не по запрету: человека сегодня уже засыпали, и он должен об
        // этом узнать — иначе чужие жесты в его сторону просто пропадают, а отказ видит только
        // отправитель. Приходит один раз за сутки, в момент достижения предела (#121).
        toast(
          'success',
          'На сегодня хватит подарков',
          `Вам натипали ${msg.received} — на сегодня приём закрыт. Лишние типы не копятся: отправителю придёт отказ, а завтра приём откроется снова.`,
        );
        return;
      case 'economy.wallet': {
        // Только свой кошелёк и только по событию: опроса раз в минуту больше нет (#117).
        // Прошлое значение берём ДО записи — после неё сравнивать уже не с чем.
        const earnedBefore = store.economy[msg.serverId]?.wallet.earnedTotal;
        store.applyWallet(msg.serverId, {
          balance: msg.balance,
          earnedTotal: msg.earnedTotal,
          seasonEarned: msg.seasonEarned,
        });
        // 🔴 Выплата ТИХАЯ (решение 03.09, после первой живой выплаты): только анимация кошелька,
        // без звука. Начисление прилетает само, без действия человека, и несколько раз за вечер —
        // звук на него оповещал бы о том, чего никто не просил.
        if (shouldPulseWallet(earnedBefore, msg.earnedTotal)) pulseChip();
        return;
      }
      case 'user.activity':
        return store.applyUserActivity(msg.userId, msg.activity);
      case 'user.update':
        return store.applyUserProfile(msg.userId, msg.displayName, msg.avatarUrl, msg.animatedAvatarUrl);
      case 'member.update':
        return store.applyMemberNickname(msg.serverId, msg.userId, msg.nickname);
      case 'poll.update':
        // Всем в канал — только число проголосовавших: счётчики по вариантам здесь были бы утечкой.
        return store.applyPollVoters(msg.channelId, msg.messageId, msg.voters);
      case 'poll.counts':
        return store.applyPollCounts(msg.channelId, msg.messageId, msg.options);
      case 'voice.move': {
        // A moderator moved us — reconnect to the new channel's room (same path as joining it).
        const ch = store.bootstrap?.channels.find((c) => c.id === msg.channelId);
        void store
          .joinVoice(msg.channelId)
          .then(() => store.openChannel(msg.channelId))
          .catch((e) => toastError(e, 'Не удалось переместиться'));
        playSound('move', msg.channelId);
        toast('info', ch ? `Вас переместили в «${ch.name}»` : 'Вас переместили в другой канал');
        return;
      }
      case 'dm.channel':
        return store.upsertDm(msg.channel);
      case 'dm.create': {
        if (msg.message.author.id !== store.user?.id) {
          if (msg.channelId !== store.currentDmId) store.markDmUnread(msg.channelId);
          if (msg.channelId === store.currentDmId) {
            scheduleRead(`dm:${msg.channelId}`, () => void api.markDmRead(msg.channelId).catch(() => {}));
          }
          // "Не беспокоить" (DND) suppresses the DM ping (unread still tracked).
          if (store.user?.status !== 'dnd') {
            playSound('dm');
            osNotify(
              `${authorName(msg.message)} — личное сообщение`,
              messagePreview(msg.message),
              () => void useStore.getState().selectDm(msg.channelId),
            );
          }
        }
        return store.appendDmMessage(msg.channelId, msg.message);
      }
      case 'dm.update':
        return store.updateDmMessage(msg.channelId, msg.message);
      case 'dm.delete':
        return store.removeDmMessage(msg.channelId, msg.messageId);
      case 'dm.reaction':
        return store.applyDmReaction(msg.channelId, msg.messageId, msg.emoji, msg.userId, msg.op);
      case 'typing':
        if (msg.userId && msg.userId !== store.user?.id) noteTyping(msg.channelId ?? msg.dmId ?? '', msg.userId);
        return;
      case 'poke': {
        // Тык звучит и мигает окном ВСЕГДА, когда дошёл: «не беспокоить» отсекается на сервере, а
        // здесь глушить нечем — это адресный окрик лично тебе, а не фоновый шум канала.
        store.showPoke({ fromName: msg.fromName, message: msg.message, channelId: msg.channelId });
        playSound('poke', msg.channelId);
        flashWindow();
        return;
      }
      case 'mega-poke': {
        /**
         * МЕГА пок приходит ВСЕМУ каналу — и это часть жеста: публичный прикол сам себя сдерживает.
         * Но получают разное: адресат — перья, тряску и звук, остальные — короткую отметку «кто кого
         * и за сколько».
         *
         * ⚠️ Решение показывать эффект принимает `planEffect` внутри слоя, а не этот обработчик:
         * скрытая вкладка, полный экран, чужой сервер и выключенная анимация разбираются там, в
         * одном месте на все эффекты.
         */
        const me = useStore.getState().user?.id;
        {
          // Щипок уведомляем ТАК ЖЕ, как тип: свёрнутому окну достаётся только звук, а знать, кто
          // кого, хочется и не глядя в приложение (запрос 04.09).
          const from = resolveMemberName(msg.fromUserId, msg.fromName);
          const mine = msg.toUserId === me;
          notifyCoin(
            mine,
            mine ? `${from} ущипнул тебя` : `${from} ущипнул ${resolveMemberName(msg.toUserId, msg.toName)}`,
            mine && msg.message ? msg.message : `${msg.amount} ${currencyNow()}`,
          );
          // Та же строка — во всплывающую плашку поверх игры. Имена разрешаем ЗДЕСЬ: окно плашки
          // ростера не держит (см. `toastRules.ts`).
          useStore.getState().pushToastEvent({
            kind: 'poke',
            fromName: from,
            toName: resolveMemberName(msg.toUserId, msg.toName),
            amount: msg.amount,
          });
        }
        if (msg.toUserId === me) {
          fireEffect({
            kind: 'feathers',
            fromName: resolveMemberName(msg.fromUserId, msg.fromName),
            message: msg.message,
            serverId: useStore.getState().bootstrap?.server.id ?? null,
          });
          playSound('poke', msg.channelId);
        } else {
          // Отметка каналу — тихая: звук у зрителей превратил бы чужой подарок в собственную помеху.
          toast(
            'info',
            `${resolveMemberName(msg.fromUserId, msg.fromName)} ущипнул ${resolveMemberName(msg.toUserId, msg.toName)}`,
            `${msg.amount} ${currencyNow()}`,
          );
        }
        return;
      }

      case 'goose.offer': {
        // Всё решение — на сервере; здесь только раздача подписчикам, без единого условия.
        for (const fn of gooseListeners) fn(msg);
        return;
      }

      case 'soundboard': {
        /**
         * Выстрел саундборда приходит ТОЛЬКО сидящим в голосе — аудиторию задаёт сервер, — поэтому
         * здесь остаётся одна проверка: глушение.
         *
         * 🔴 Заглушённый не слышит выстрел, и это не мелочь. «Глухо» значит «я не хочу слышать этот
         * канал»; платный звук, пробивающий глушение, — ровно то купленное право мешать человеку,
         * которого в экономике быть не должно (тот же принцип, что «не беспокоить» у МЕГА пока).
         *
         * ⚠️ Отметка «кто что включил» показывается ВСЕМ, включая заглушённого: она объясняет, что
         * происходит, и держит выстрел публичным — публичный прикол сам себя сдерживает.
         */
        if (!useStore.getState().selfDeafened) playClip(msg.url);
        toast(
          'info',
          `${resolveMemberName(msg.fromUserId, msg.fromName)}: ${msg.name}`,
          `${msg.amount} ${currencyNow()}`,
        );
        return;
      }

      case 'tip': {
        // Тип — публичный жест. Событие приходит каждому в канале, но серия быстрых типов должна
        // дать один короткий звук, а не превратить разговор в игровой автомат.
        const now = Date.now();
        if (shouldPlayTipCue(lastTipCueAt, now)) {
          lastTipCueAt = now;
          playSound('tip', msg.channelId);
        }
        /**
         * 🔴 **Монета по типу НЕ летит** (решение 02.09: «монетки пусть вообще не летят,
         * просто анимашка в ЧИПе. А понять кто и кого можно будет из подсказок»). Полёт поверх
         * подсказки был бы вторым рассказом об одном событии, а подсказка рассказывает больше:
         * она называет отправителя, чего монета сделать не может.
         *
         * ⚠️ Чип дёргается только у ПОЛУЧАТЕЛЯ: у остальных в канале баланс не менялся, и отклик
         * там означал бы неправду. Чипа нет на экране — не делаем ничего, подсказка своё сказала.
         */
        if (useStore.getState().user?.id === msg.toUserId) pulseChip();
        /**
         * 🔴 **Подсказка «кто кого» — ЗДЕСЬ, а не только в стенде.** Механизм был написан целиком
         * (правила `tipHints.ts`, стопка в сторе, разметка и стили в строке сайдбара), но настоящее
         * событие его не звало ни разу: единственным вызывающим был стенд эффектов. В бою подсказки
         * не всплывали никогда — найдено на первом живом типе (03.09).
         * ⚠️ Тот самый запах, который уже разбирали дважды: обкатанное ТОЛЬКО на стенде стендом и
         * остаётся. Стенд доказывает, что оно РИСУЕТСЯ, и ничего не говорит о том, что оно ЗОВЁТСЯ.
         */
        {
          const me = useStore.getState().user?.id;
          const from = resolveMemberName(msg.fromUserId, msg.fromName);
          const mine = msg.toUserId === me;
          notifyCoin(
            mine,
            // ⚠️ Событие типа несёт имя ТОЛЬКО отправителя; получателя берём из ростера — там ник
            // на этом сервере, а он и нужен. Не нашли (человек не в списке) — «кого-то», а не пусто.
            // ⚠️ Запасное имя — из СОБЫТИЯ, а не слово «кого-то»: только что вошедшего в ростере
            // ещё нет, и подпись превращалась в «типнул кого-то» (05.09).
            mine ? `${from} типнул тебя` : `${from} типнул ${resolveMemberName(msg.toUserId, msg.toName)}`,
            `+${msg.amount} ${currencyNow()}`,
          );
          // И во всплывающую плашку поверх игры — соседней строкой с уведомлением НАМЕРЕННО: пока
          // оба списка наполняются из одного места, разойтись в трактовке события они не могут.
          useStore.getState().pushToastEvent({
            kind: 'tip',
            fromName: from,
            toName: resolveMemberName(msg.toUserId, msg.toName),
            amount: msg.amount,
          });
        }
        useStore.getState().pushTipHint({
          toUserId: msg.toUserId,
          // ⚠️ Имя разрешается при ОТРИСОВКЕ по ростеру: в подсказке должен стоять ник на ЭТОМ
          // сервере, а событие несёт обычное имя из `users` (правка 03.09).
          fromUserId: msg.fromUserId,
          fromName: msg.fromName,
          amount: msg.amount,
        });
        return;
      }
    }
  };

  gateway.onclose = () => {
    gatewayHandshake();
    // Отправленное на умершем соединении отправленным больше не считается (#126).
    subsDisconnect(subs);
    if (gatewayPing) clearInterval(gatewayPing);
    gatewayPing = null;
    gateway = null;
    if (getToken()) reconnect(connectGateway);
  };
}

/** Tell the gateway "I'm typing" in a channel (serverId+channelId) or a DM (dmId+recipientId). */
export function sendTyping(target: { serverId?: string; channelId?: string; dmId?: string; recipientId?: string }): void {
  if (gateway?.readyState !== WebSocket.OPEN) return;
  const msg: GatewayClientMessage = { t: 'typing', ...target };
  gateway.send(JSON.stringify(msg));
}

export function subscribeToServer(serverId: string): void {
  // Решение «слать или рано» — в `gatewaySubs.ts`, под тестами. Здесь только отправка.
  for (const id of wantSub(subs, serverId)) sendSubscribe(id);
}

/** Отправить подписку. Отдельной функцией: зовётся и по желанию, и пачкой на `ready`. */
function sendSubscribe(serverId: string): void {
  if (gateway?.readyState === WebSocket.OPEN) {
    gateway.send(JSON.stringify({ t: 'subscribe', serverId }));
  }
}

export function subscribeToServers(serverIds: string[]): void {
  for (const id of serverIds) subscribeToServer(id);
}

export function connectPresence(): void {
  const token = getToken();
  if (!token) return;
  presence = new WebSocket(config.presenceWs);
  const presenceHandshake = guardHandshake(presence);

  presence.onopen = () => {
    presenceHandshake();
    presenceLastRecv = Date.now();
    presence?.send(JSON.stringify({ t: 'identify', token }));
    if (presence) presencePing = heartbeat(presence, () => presenceLastRecv);
  };

  presence.onmessage = (ev) => {
    presenceLastRecv = Date.now();
    const msg = JSON.parse(ev.data) as PresenceServerMessage;
    const store = useStore.getState();
    if (msg.t === 'presence.snapshot') store.setPresenceSnapshot(msg.channels, msg.occupied);
    else if (msg.t === 'presence.channel') {
      store.mergePresence(msg.channelId, msg.participants);
      store.setOccupancy(msg.channelId, msg.occupiedMs);
    }
  };

  presence.onclose = () => {
    presenceHandshake();
    if (presencePing) clearInterval(presencePing);
    presencePing = null;
    presence = null;
    if (getToken()) reconnect(connectPresence);
  };
}

export function disconnectSockets(): void {
  resetSubs(subs); // выход из аккаунта: следующий вход подпишется на серверы СВОЕГО пользователя
  gatewayHadConnected = false; // next connect is a fresh login → initial load handles history, no backfill
  if (gatewayPing) clearInterval(gatewayPing);
  if (presencePing) clearInterval(presencePing);
  gatewayPing = null;
  presencePing = null;
  gateway?.close();
  presence?.close();
  gateway = null;
  presence = null;
}
