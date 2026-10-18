import {
  CAP_CONV1,
  FEATURE_GROUPS1,
  FEATURE_PRESENCE4,
  FEATURE_PRESENCE5,
  FEATURE_BIGREACT1,
  type GatewayClientMessage,
  type GatewayServerMessage,
  mentionsMe,
  normalizeNotifyView,
  parseTypingAction,
  type PresenceServerMessage,
  type TypingAction,
  typingActionField,
  typingActionToServer,
  FEATURE_FEDCALL1,
  FEATURE_TYPING2,
  voicePublishBits,
} from '@gusvoice/shared';
import { useCall } from './callStore';
import { serverCalls } from './callView';
import { useDmStickers } from './dmStickers';
import { useDmFolders } from './dmFolders';
import { peerNameNow } from './peerName';
import { useContacts } from './contacts';
import { applyRemoteGifs } from './savedGifs';
import { api, getToken } from './api';
import { isFeedOnScreen } from './channelRules';
import { applyServerMessageCreate, applyServerMessageUpdate, isServerLastMessage, serverLastFromMessage } from './serverRowRules';
import { dmIncomingDecision, dmMuteOf, dmMutedDecision, dmSilentDecision, muteActive, muteSoundOff } from './dmListRules';
import { feedCovered } from './readByView';
import { notifyLevel } from './channelPrefs';
import { isMobile } from './hotkeys';
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
import { resetGatewayLive, setGatewayLive } from './connState';
import { flashWindow } from './flashWindow';
import { shouldNotifyCoin } from './coinNotifyRules';
import {
  authorName,
  channelNoticeGroup,
  clearOsNotifications,
  coinNotifyLevel,
  messagePreview,
  osNotify,
  osNotifyLevel,
  osNotifyRaw,
  popupPreview,
  setNotifyPrefs,
  windowFocused,
} from './notifications';
import { serverPush2 } from './convSyncRules';
import { presentNow, watchPresence } from './presenceVisibility';
import { setBgPresent } from './bgGateways';
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


/**
 * Голос на ЭТОМ сервере этого инстанса (01.10): голос переживает переход между инстансами и может идти на другом
 * сервере, пока человек смотрит этот, — событие про этот сервер не должно рвать чужой голос.
 */
function voiceOnServer(v: VoiceConnection | null, serverId: string): boolean {
  return !!v && voiceIsHere(v) && (v.serverId === null || v.serverId === serverId);
}

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
import { useStore, voiceIsHere, type VoiceConnection } from './store';
import { fireEffect } from './effectsBus';
import { pulseChip } from './effectsDom';
import { shouldPlayTipCue } from './tipMode';
import { toast, toastError } from './toast';
import { clearDmActivity, noteDmActivity } from './dmOnline';
import { dropTyping, noteTyping } from './typing';

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
const readLatest = new Map<string, () => void>();
/**
 * Отметка «прочитано» с задержкой: пачка сообщений за 2 с даёт один запрос.
 * ⚠️ Выполняется ПОСЛЕДНИЙ присланный вызов, а не первый (#212): отметка ЛС теперь «до этого
 * сообщения», и первый вызов пачки поставил бы её на первое сообщение — остальные после перезапуска
 * числились бы непрочитанными.
 */
function scheduleRead(key: string, fn: () => void): void {
  readLatest.set(key, fn);
  if (readTimers.has(key)) return;
  readTimers.set(
    key,
    setTimeout(() => {
      readTimers.delete(key);
      const latest = readLatest.get(key);
      readLatest.delete(key);
      latest?.();
    }, 2000),
  );
}

export function connectGateway(): void {
  const token = getToken();
  if (!token) return;
  installResumeWatchers();
  watchNotifyPrefs();
  watchPresence(sendGatewayVisible);
  watchPresence(setBgPresent);
  setBgPresent(presentNow());
  /**
   * 🔴 **Обработчики говорят со СВОИМ сокетом, а не с модульной переменной** (18.09, §5.7).
   *
   * Раньше `onopen`/`onclose` трогали `gateway` — то есть тот сокет, который активен СЕЙЧАС, а не
   * тот, чьё событие пришло. Пока смена инстанса была перезапуском приложения, второго сокета в
   * одном процессе почти не случалось. С мягким переходом это происходит на каждом клике: старый
   * закрывается, новый заводится в том же кадре, и запоздалый `onopen` старого слал `identify` в
   * новый — `Still in CONNECTING state`, — а запоздалый `onclose` обнулял ссылку на живой новый и
   * заводил лишнее переподключение. Сверка `gateway !== socket` = «это событие уже неактуально».
   */
  const socket = new WebSocket(gatewayWsUrl());
  gateway = socket;
  const gatewayHandshake = guardHandshake(socket);
  // ⚠️ Сердцебиение СВОЁ у каждого сокета: модульная переменная одна, и сокет, которого уже сменили,
  // не должен ни гасить чужой таймер, ни оставлять свой тикать вечно.
  let ping: ReturnType<typeof setInterval> | null = null;

  socket.onopen = () => {
    gatewayHandshake();
    // Нас успели сменить, пока шло рукопожатие: этот сокет — сирота, закрываем и молчим.
    if (gateway !== socket) {
      socket.close();
      return;
    }
    gatewayLastRecv = Date.now();
    /* ЛС этап 2: клиент объявляет шлюзу `conv1` всегда — получает `conv.change` вместо старых `dm.*` (их обработчиков у
       клиента больше нет, 09.10). Сервер без бесед (`conv2`) `conv.change` шлёт, но стор его не применяет: ЛС там нет. */
    // Тип с `undefined` — ради прежней формы `caps?.push` / `caps ? … : {}` (её читают проверки исходника).
    const caps: string[] | undefined = [CAP_CONV1];
    // `presence5` (D4, 08.10): получать `online.away` — «не в сети для ЛС» при открытом сокете.
    caps?.push(FEATURE_PRESENCE5);
    // `typing2` (09.10): получать вид действия `round` («записывает видеосообщение»); без него шлюз отдаёт прежнее `voice`.
    caps?.push(FEATURE_TYPING2);
    // `fedcall1` (Э6, 12.10): получать `call.state` входящего звонка с другого инстанса (`DmCall.host`); без него шлюз такого не шлёт.
    caps?.push(FEATURE_FEDCALL1);
    // `groups1` (07.10): события групп ЛС — только соединению с беседами, которое их понимает.
    // `presence4` (08.10): получать `online.dm` — «Невидимый» в сети для ЛС. `bigreact1` (08.10, G43): эффект `reaction.big`.
    socket.send(
      // `hidden` (D4, 08.10): сокет открылся, когда приложение уже в фоне (переподключение свёрнутого Android) — «в сети» не считать.
      JSON.stringify({ t: 'identify', token, ...(caps ? { caps: [...caps, FEATURE_GROUPS1, FEATURE_PRESENCE4, FEATURE_BIGREACT1] } : {}), ...(presentNow() ? {} : { hidden: true }) }),
    );
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
    ping = heartbeat(socket, () => gatewayLastRecv);
    gatewayPing = ping;
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

  socket.onmessage = (ev) => {
    if (gateway !== socket) return;
    gatewayLastRecv = Date.now();
    const msg = JSON.parse(ev.data) as GatewayServerMessage;
    const store = useStore.getState();
    switch (msg.t) {
      /**
       * Сервер узнал, кто мы, — только теперь подписки имеют смысл (#126). Шлём ВЕСЬ список: это же
       * и восстановление после обрыва, ради которого `want` переживает переподключение.
       */
      case 'ready': {
        // Связь есть — в шапке беседы снова статус собеседника, а не «Подключение…» (`connState.ts`).
        setGatewayLive(true);
        // Новое соединение — «за устройством сидят» заново (G38): прежняя отметка осталась у закрытого сокета.
        activeOn = false;
        if (windowFocused()) noteGatewayActive(true);
        for (const id of subsReady(subs)) sendSubscribe(id);
        // Беседы: догнать всё, что было без нас, по номеру журнала (и на первом подключении — загрузить список).
        if (store.convActive) void store.convOnReady();
        // Звонки (С5, `calls1`): устройство подключилось посреди звонка — узнать, не звонят ли мне сейчас.
        if (serverCalls(store.serverFeatures)) void useCall.getState().resync();
        // Экономика: пока сокета не было, мог выйти гусь — его пуш единственный, и без перечитки снимка
        // гусь висел на сервере невидимым до перезапуска приложения (17.10). Вместе с ним догоняется баланс.
        {
          const sid = store.bootstrap?.server.id;
          if (sid) ensureEconomy(sid, true);
        }
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
        // Автор дописал и отправил — его «печатает…» гаснет сразу, а не через 5 с срока (06.10, как у Telegram).
        dropTyping(msg.channelId, msg.message.author.id);
        if (msg.message.author.id !== store.user?.id) {
          // Per-channel level: 'none' stays silent, 'mentions' reacts only to @-mentions, 'all' to any.
          const channelLevel = notifyLevel(msg.channelId);
          /**
           * 🔴 Гостя зовут `@ник@домен` и ТОЛЬКО так (§5.5): на сервере бывает свой тёзка, и звенеть
           * ему на чужое обращение нельзя. Поэтому у гостя обычное имя не передаём вовсе.
           */
          const home = store.user?.homeInstance ?? null;
          const mentioned = mentionsMe(
            msg.message.content,
            home ? null : store.user?.username,
            home && store.user ? { username: store.user.username, domain: home.domain } : null,
          );
          const notify = channelLevel === 'all' || (channelLevel === 'mentions' && mentioned);
          const dnd = store.user?.status === 'dnd';
          // «Смотрит ли человек эту ленту» — правило в `channelRules.isFeedOnScreen`: на телефоне
          // «текущий канал» и «канал на экране» — РАЗНЫЕ вещи (список и лента там два экрана).
          const chanOnScreen = isFeedOnScreen({
            id: msg.channelId,
            currentId: store.currentChannelId,
            mobile: isMobile(),
            mobilePane: store.mobilePane,
            // Человек в личках — канал не на экране, даже если остался «текущим» (#212, зеркало Б2).
            kind: 'channel',
            view: store.view,
          });
          if (notify && !chanOnScreen) store.markUnread(msg.channelId, mentioned, msg.serverId);
          // Watching the channel — keep the persisted read mark current so a reload stays read.
          if (chanOnScreen) {
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
              false,
              // Тег беседы (как tweb): новое сообщение канала заменяет прежнее; открытие канала их закрывает (`store.openChannel`).
              {
                group: channelNoticeGroup(msg.channelId),
                // Своё окно ПК (G38, ND-07): заголовок — канал, строка — «Автор: текст», аватар автора.
                popup: { title: where, author: authorName(msg.message), avatar: msg.message.author.avatarUrl, preview: popupPreview(msg.message) },
              },
            );
          }
        }
        /**
         * Строка сервера в списке на телефоне (12.10, #218): последнее сообщение сервера — живьём, и своё тоже. Правило —
         * `serverRowRules.applyServerMessageCreate`; сервер без поля (старый бэкенд) остаётся на счётчиках. Название канала
         * клиент знает только у открытого сервера. Серверы чужих инстансов (`bgGateways`) сюда не попадают — у них счётчики.
         */
        {
          const chName = store.bootstrap?.channels.find((c) => c.id === msg.channelId)?.name;
          const servers = applyServerMessageCreate(store.servers, msg.serverId, serverLastFromMessage(msg.message, msg.channelId, chName));
          if (servers !== store.servers) useStore.setState({ servers });
        }
        return store.appendMessage(msg.channelId, msg.message);
      }
      case 'message.update': {
        // Поправили последнее сообщение сервера — поправить и строку списка (`serverRowRules.applyServerMessageUpdate`).
        const servers = applyServerMessageUpdate(store.servers, serverLastFromMessage(msg.message, msg.channelId));
        if (servers !== store.servers) useStore.setState({ servers });
        return store.updateMessage(msg.channelId, msg.message);
      }
      case 'message.delete':
        // Удалили последнее сообщение сервера — предыдущее знает только бэкенд: свежий список (`GET /servers`).
        if (isServerLastMessage(store.servers, msg.messageId)) void store.loadServers();
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
            if (voiceOnServer(s.voice, msg.serverId) && voicePublishBits(s.bootstrap?.permissions) !== before) void s.refreshVoiceToken();
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
            if (voiceOnServer(s.voice, msg.serverId)) s.leaveVoice();
            useStore.setState({ currentServerId: null, bootstrap: null, currentChannelId: null });
            s.setView('dm');
          });
        return;
      }
      case 'federation.links': {
        /**
         * Что-то изменилось в связках. Событие без нагрузки: вкладка «Федерация» сама перечитает
         * состояние целиком. Если она закрыта — просто растёт счётчик, и при открытии данные свежие.
         */
        store.bumpFederationRev();
        return;
      }
      case 'federation.guest_links': {
        // 15.10: связка дома с инстансом, где я гость, сменилась — рейл перечитает «Где я гость» (`RailGroups`, `guestGone.ts`).
        store.bumpGuestLinksRev();
        return;
      }
      case 'server.access_closed': {
        /**
         * Нас закрыли прямо сейчас (§5.3.1). Порядок: сначала ВЫВЕСТИ из сервера, потом показать
         * окно. Наоборот человек прочитал бы объяснение, стоя в канале, куда уже не вхож, и первое,
         * что он сделал бы после «Понятно», — написал бы сообщение и получил отказ.
         */
        const name = store.servers.find((x) => x.id === msg.serverId)?.name ?? 'сервер';
        const s = useStore.getState();
        if (voiceOnServer(s.voice, msg.serverId)) s.leaveVoice();
        if (s.currentServerId === msg.serverId) {
          useStore.setState({ currentServerId: null, bootstrap: null, currentChannelId: null });
          s.setView('dm');
        }
        store.noteAccessClosed({ serverId: msg.serverId, serverName: name, reason: msg.reason, contacts: msg.contacts });
        // Рейл перечитываем: сервер остаётся в списке (членство не снято), но с этого момента он
        // под замком, и список должен приехать в том виде, в каком его теперь отдаёт хост.
        void store.loadServers();
        return;
      }
      case 'server.access_restored': {
        /**
         * Держатель вернул федеративный доступ (§5.3.1). Снимаем замок и перечитываем список —
         * членство на хосте уже восстановлено, и сервер снова открывается обычным кликом.
         *
         * ⚠️ Окно «сервер закрыт» гасится тем же вызовом (`clearAccessClosed` чистит и `accessNotice`):
         * оно могло висеть на экране ровно в этот миг, и читать «закрыт» у открытого сервера хуже,
         * чем не увидеть объяснения вовсе.
         */
        store.clearAccessClosed(msg.serverId);
        void store.loadServers();
        return;
      }
      case 'online.snapshot':
        return store.setOnlineSnapshot(msg.users, msg.dmOnly, msg.dmAway);
      case 'online.dm':
        // `presence4`: «Невидимый» в сети для ЛС (на серверах его точки нет). Вышел — локальное «в сети» тоже снимается.
        if (!msg.online && !store.onlineUsers.includes(msg.userId)) clearDmActivity(msg.userId);
        return store.setDmOnline(msg.userId, msg.online);
      case 'online.away':
        // `presence5` (D4, решение 42): сокет открыт, но для ЛС «не в сети» — приложение скрыто или простаивает. Сервера не трогаем.
        if (msg.away) clearDmActivity(msg.userId);
        return store.setDmAway(msg.userId, msg.away);
      case 'online.update':
        if (!msg.online) clearDmActivity(msg.userId);
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
        // Голос идёт на ДРУГОМ инстансе (01.10) — перемещение касается другого устройства этой учётки здесь, а не нас:
        // иначе звонок там молча закончился бы, а LiveKit выкинул бы телефон по дублю личности.
        if (store.voice && !voiceIsHere(store.voice)) return;
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
      /**
       * ЛС этап 2: изменение в беседе с номером журнала. Звук, тост и счётчик — только для НОВОГО чужого (`created`),
       * решает `dmIncomingDecision`; «без звука» (`m.silent`, С3) — `dmSilentDecision` (гасит только звук; уведомление —
       * без звука системы). Применение (с буфером
       * догонки) — в сторе.
       */
      case 'conv.change': {
        if (!store.convActive) return;
        const m = msg.message && !('gone' in msg.message) ? msg.message : null;
        const convId = msg.conversation.id;
        // Прислал новое сообщение — его «печатает…» гаснет сразу (06.10), а не доживает срок, как в `message.create`.
        if (msg.created && m) dropTyping(convId, m.author.id);
        if (msg.created && m && m.author.id !== store.user?.id) noteDmActivity(m.author.id);
        // Заглушена (07.10, G03): сводка события несёт `muted` (сервер `conv11`), иначе — список заглушек собеседников.
        const sum = 'left' in msg.conversation ? null : msg.conversation;
        const muteOf = m
          ? dmMuteOf(
              { muted: sum?.muted, otherUser: { id: sum?.otherUser?.id ?? m.author.id } },
              store.pushMutedDmUsers,
              store.pushMuteUntil,
            )
          : null;
        const muted = !!m && muteActive(muteOf, Date.now());
        // «Выключить звук» (07.10, `conv13`): тост есть, звука нет.
        const soundOff = !!m && muteSoundOff(muteOf, Date.now());
        const d =
          msg.created && m
            ? dmMutedDecision(
                dmSilentDecision(
                  dmIncomingDecision({
                    mine: m.author.id === store.user?.id,
                    onScreen: isFeedOnScreen({
                      id: convId,
                      currentId: store.currentDmId,
                      mobile: isMobile(),
                      mobilePane: store.mobilePane,
                      kind: 'dm',
                      view: store.view,
                    }),
                    focused: windowFocused(),
                    dnd: store.user?.status === 'dnd',
                    covered: feedCovered(),
                  }),
                  m,
                ),
                muted,
                soundOff,
              )
            : null;
        store.convOnChange(msg, !!d?.countUnread);
        if (!d || !m) return;
        // «Прочитано до» считается в момент отправки по ленте на экране (`convReadNow`).
        if (d.markRead) scheduleRead(`dm:${convId}`, () => useStore.getState().convReadNow(convId));
        if (d.sound) playSound('dm');
        if (d.osNotify) {
          // Подпись контакта вместо имени, как Telegram (решение владельца 08.10 п.27, `peerName.ts`).
          osNotify(`${peerNameNow(m.author.id, authorName(m))} — личное сообщение`, messagePreview(m), () => void useStore.getState().selectDm(convId), false, {
            silent: m.silent === true || soundOff,
            groupChat: sum?.kind === 'group',
            dmChat: sum?.kind !== 'group',
            group: convId,
            conv: convId,
            // Своё окно ПК (G38, ND-07): как у Telegram — имя чата и аватар, в группе — название группы и «Автор: текст».
            popup:
              sum?.kind === 'group'
                ? { title: sum.group?.title ?? authorName(m), author: peerNameNow(m.author.id, authorName(m)), avatar: sum.group?.avatarUrl ?? null, preview: popupPreview(m) }
                : { title: peerNameNow(m.author.id, authorName(m)), avatar: m.author.avatarUrl, preview: popupPreview(m) },
          });
          flashWindow();
        }
        return;
      }
      // «Большая» реакция собеседника (`bigreact1`, G43): только эффект — сама реакция приходит своим путём. Играть ли (беседа
      // открыта, сообщение на экране, движение не выключено), решает `BigReactionLayer`.
      case 'reaction.big':
        if (msg.userId === store.user?.id) return;
        return fireEffect({ kind: 'bigReaction', conversationId: msg.conversationId, messageId: msg.messageId, emoji: msg.emoji });
      // Прочитал на другом своём устройстве — гасим здесь (событие адресное, приходит только своим).
      case 'read.channel':
        return store.applyRemoteRead({ channelId: msg.channelId, serverId: msg.serverId, at: msg.at });
      case 'typing':
        if (msg.userId && msg.userId !== store.user?.id) noteTyping(msg.channelId ?? msg.dmId ?? '', msg.userId, parseTypingAction(msg.action));
        // G07: «печатает» в ЛС — собеседник «в сети» ещё 30 с (если время захода мне видно, `dmOnline.dotShown`).
        if (msg.userId && msg.userId !== store.user?.id && msg.dmId) noteDmActivity(msg.userId);
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

      case 'stickers.update': {
        // Избранные / недавние / «мои наборы» стикеров изменились на другом устройстве (07.10, С2 порция 2, `stickers3`).
        useDmStickers.getState().applyRemote(msg);
        return;
      }

      case 'call.state': {
        // Звонок 1:1 сменил фазу (08.10, С5, `calls1`): входящий, ответили (здесь или на другом устройстве), конец.
        if (msg.call && typeof msg.call.id === 'string') useCall.getState().apply(msg.call);
        return;
      }

      case 'gifs.update': {
        // «Мои GIF» изменились на другом устройстве или этим же (08.10, `groups3`): список целиком.
        if (Array.isArray(msg.gifs)) applyRemoteGifs(msg.gifs);
        return;
      }

      case 'contacts.update': {
        // Контакты изменились на другом устройстве или этим же (08.10, `contacts1`): список целиком.
        if (Array.isArray(msg.contacts)) useContacts.getState().apply(msg.contacts);
        return;
      }
      case 'dmFolders.update': {
        // Папки бесед изменились на другом устройстве или этим же (07.10, G40, `folders1`): список целиком.
        useDmFolders.getState().apply(msg.folders);
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

  socket.onclose = () => {
    gatewayHandshake();
    // Свой таймер гасим ВСЕГДА, даже если сокет уже не активен: иначе он тикал бы до конца сессии.
    if (ping) clearInterval(ping);
    if (gatewayPing === ping) gatewayPing = null;
    ping = null;
    // Закрылся не наш сокет (сменили инстанс, переподключились) — ни обнулять ссылку, ни заводить
    // переподключение нельзя: и то и другое ударило бы по ЖИВОМУ соединению.
    if (gateway !== socket) return;
    // Отправленное на умершем соединении отправленным больше не считается (#126).
    subsDisconnect(subs);
    gateway = null;
    // Связь потеряна — в шапке беседы «Подключение…» до следующего `ready` (`connState.ts`).
    setGatewayLive(false);
    // Беседы: событий больше нет — список и ленты догоняют сами, пока шлюз не вернётся (`convStore.convOnGatewayLost`).
    if (useStore.getState().convActive) useStore.getState().convOnGatewayLost();
    if (getToken()) reconnect(connectGateway);
  };
}

/**
 * «За устройством сидят» (08.10, #211, G38, `push2`): кадр шлюза `{ t: 'active', on }`. Пока он свежий (30 с на сервере),
 * пуш ЛС на телефон ждёт 30 с и не уходит, если сообщение прочитали здесь — как у Telegram, где телефон молчит, пока жив
 * десктоп. `on: true` — окно в фокусе и был ввод (`afk.noteActivity`), не чаще раза в `ACTIVE_SEND_MS`; `on: false` —
 * окно потеряло фокус. Сервер без `push2` кадр не получает.
 */
const ACTIVE_SEND_MS = 10_000;
let activeOn = false;
let activeSentAt = 0;
export function noteGatewayActive(on: boolean): void {
  if (gateway?.readyState !== WebSocket.OPEN || !serverPush2(useStore.getState().serverFeatures)) return;
  const now = Date.now();
  if (on) {
    if (activeOn && now - activeSentAt < ACTIVE_SEND_MS) return;
    activeSentAt = now;
  } else if (!activeOn) {
    return;
  }
  activeOn = on;
  const msg: GatewayClientMessage = { t: 'active', on };
  gateway.send(JSON.stringify(msg));
}

/**
 * «Видно / скрыто» (08.10, #211, D4/D10): кадр шлюза `{ t: 'visible', on }` на каждой смене `presenceVisibility.presentNow`.
 * Шлюз считает «в сети» только видимые соединения и не держит пуш на телефон из-за скрытого. Шлём без признака сервера:
 * старый шлюз неизвестный кадр молча пропускает (`switch` без ветки). Сокет закрыт — состояние уедет в `identify.hidden`.
 */
function sendGatewayVisible(on: boolean): void {
  if (gateway?.readyState !== WebSocket.OPEN) return;
  if (!on) activeOn = false;
  const msg: GatewayClientMessage = { t: 'visible', on };
  gateway.send(JSON.stringify(msg));
}

/** Настройки уведомлений из профиля (G38) — в модуль уведомлений, при входе и на каждую смену профиля. Один раз. */
let notifyPrefsWatched = false;
function watchNotifyPrefs(): void {
  if (notifyPrefsWatched) return;
  notifyPrefsWatched = true;
  const apply = (u: { notifyView?: unknown; notifyGroups?: boolean; notifyDm?: boolean } | null) =>
    setNotifyPrefs({ view: normalizeNotifyView(u?.notifyView), groups: u?.notifyGroups !== false, dm: u?.notifyDm !== false });
  apply(useStore.getState().user);
  useStore.subscribe((st, prev) => {
    if (st.user !== prev.user) apply(st.user);
    // Открыли канал — его всплывашки браузера не нужны (как у tweb; ЛС чистит `DmChatView`). Сам `store.ts` модуль уведомлений не импортирует.
    if (st.currentChannelId && st.currentChannelId !== prev.currentChannelId) clearOsNotifications(channelNoticeGroup(st.currentChannelId));
  });
}

/** Tell the gateway "I'm typing" in a channel (serverId+channelId) or a DM (dmId+recipientId). */
export function sendTyping(
  target: { serverId?: string; channelId?: string; dmId?: string; recipientId?: string },
  wanted: TypingAction = 'typing',
): void {
  if (gateway?.readyState !== WebSocket.OPEN) return;
  // «Печатает» в кадр не пишем (G21): старый сервер и так не знает поля, а кадр остаётся как был.
  // Сервер без `typing2` не знает `round` и показал бы собеседнику «печатает» — ему шлём прежнее `voice`.
  const action = typingActionToServer(wanted, useStore.getState().serverFeatures);
  const msg: GatewayClientMessage = { t: 'typing', ...target, ...typingActionField(action) };
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
  // Та же сверка «это мой сокет», что и у гейтвея выше — причина там же.
  const socket = new WebSocket(config.presenceWs);
  presence = socket;
  const presenceHandshake = guardHandshake(socket);
  let ping: ReturnType<typeof setInterval> | null = null;

  socket.onopen = () => {
    presenceHandshake();
    if (presence !== socket) {
      socket.close();
      return;
    }
    presenceLastRecv = Date.now();
    socket.send(JSON.stringify({ t: 'identify', token }));
    ping = heartbeat(socket, () => presenceLastRecv);
    presencePing = ping;
  };

  socket.onmessage = (ev) => {
    if (presence !== socket) return;
    presenceLastRecv = Date.now();
    const msg = JSON.parse(ev.data) as PresenceServerMessage;
    const store = useStore.getState();
    if (msg.t === 'presence.snapshot') store.setPresenceSnapshot(msg.channels, msg.occupied);
    else if (msg.t === 'presence.channel') {
      store.mergePresence(msg.channelId, msg.participants);
      store.setOccupancy(msg.channelId, msg.occupiedMs);
    }
  };

  socket.onclose = () => {
    presenceHandshake();
    if (ping) clearInterval(ping);
    if (presencePing === ping) presencePing = null;
    ping = null;
    if (presence !== socket) return;
    presence = null;
    if (getToken()) reconnect(connectPresence);
  };
}

export function disconnectSockets(): void {
  resetSubs(subs); // выход из аккаунта: следующий вход подпишется на серверы СВОЕГО пользователя
  gatewayHadConnected = false; // next connect is a fresh login → initial load handles history, no backfill
  resetGatewayLive(); // соединения нового входа ещё не было — «Подключение…» в шапке не к чему
  if (gatewayPing) clearInterval(gatewayPing);
  if (presencePing) clearInterval(presencePing);
  gatewayPing = null;
  presencePing = null;
  gateway?.close();
  presence?.close();
  gateway = null;
  presence = null;
}
