import type {
  Channel,
  CustomStatus,
  DmChannel,
  DmReportReason,
  GameActivity,
  Message,
  Poll,
  PresenceMap,
  PresenceStatus,
  Server,
  ServerBootstrap,
  ServerMemberInfo,
  User,
  VoiceParticipant,
} from '@gusvoice/shared';
import { create } from 'zustand';
import { api, apiFor, getToken, setToken, type Api, type BlockedUser, type PushMuteScope } from './api';
import { activeInstanceId, config, instances, logoutFamily, rememberInstanceServers } from './config';
import { convCacheKey } from './convCacheRules';
import { applyUnread, historyLoadPlan, isFeedOnScreen, seedReads, seedServerCounts } from './channelRules';
import { pinOrderStamps } from './dmListRules';
import { createConvActions, type ConvActions, type ConvDeps } from './convStore';
import type { FeedPlace } from './feedWindowRules';
import {
  emptyConvState,
  patchConvPinned,
  patchConvPinOrder,
  patchConvReadAll,
  patchConvUnreadMark,
  patchConvArchived,
  patchConvStrangerHidden,
  patchReactionsRead,
  clearReactionUnread,
  patchPeer,
  patchPeerMute,
  serverKeepsDrafts,
  serverPush4,
  serverSendsPeerRead,
  summariesToDms,
  updateDrafts,
  type ConvState,
} from './convSyncRules';
import type { OutboxItem } from './outboxRules';
import { clearConvCacheWipe, deleteConvCache, markConvCacheWipe } from './convCache';
import { hasMoreOlder, mergeLatestPage, mergeOlderPage, olderCursor } from './historyPage';
import { markChannelSeen } from './channelPrefs';
import { lastPlace, rememberPlace } from './lastPlace';
import { onTabEvent, publishTabEvent } from './tabSync';
import type { EconomyView } from './economy';
import { isMobile } from './hotkeys';
import { stopPushRegistration } from './nativeUnifiedPush';
import { setChannelSounds, setCustomSounds } from './sounds';
import { addTipHint, pruneTipHints, TIP_HINT_MS, type TipHint } from './tipHints';
import { addToastEvent, pruneToastEvents, TOAST_MS, type ToastEvent, type ToastKind } from './toastRules';
import type { Occupancy } from './occupancy';
import type { AccessNotice } from './accessClosed';
import type { PendingWatch } from './pendingWatch';
import { applyUserProfilePatch } from './profilePatch';
import { scopedGetItem, scopedSetItem } from './instanceScope';
import { clampStreamVolume, loadStreamVolumes } from './streamAudioRules';
import { shouldAutoRejoin } from './voiceCueRules';
import { clearVoiceSession, rejoinableVoiceSession, restorableVoiceSession, saveVoiceSession, type VoiceSession } from './voiceSession';

/** Обновлённый снимок сервера `serverId` убирает голос, только если голос на этом сервере этого инстанса и канала больше не видно. */
function dropsVoice(v: VoiceConnection | null, serverId: string, visible: Set<string>): boolean {
  return !!v && voiceIsHere(v) && (v.serverId === null || v.serverId === serverId) && !visible.has(v.channelId);
}

/** Per-channel sound overrides from the bootstrap, keyed channelId → {event: url} (drops empties). */
function channelSoundMap(channels: { id: string; sounds?: Record<string, string> }[]): Record<string, Record<string, string>> {
  const m: Record<string, Record<string, string>> = {};
  for (const c of channels) if (c.sounds && Object.keys(c.sounds).length) m[c.id] = c.sounds;
  return m;
}

/**
 * Черновик пересылки в беседу (`fwdDrafts`): `from` — беседа-источник, `messages` — снимок выбранных по порядку её ленты
 * (полоса над полем рисует имена и превью без похода в чужую ленту), `hideSender` / `hideCaptions` — «скрыть имя /
 * подписи» (признак сервера `fwd2`; Telegram `Data::ForwardOptions`).
 */
export interface FwdDraft {
  from: string;
  messages: Message[];
  hideSender: boolean;
  hideCaptions: boolean;
}

/**
 * Голос, в котором сидим. 🔴 С 01.10 он переживает переход между инстансами (Discord-модель: смотришь свой дом, а
 * голос идёт у соседа), поэтому знает, ЧЕЙ он: запись реестра, сервер, подписи для плашки и профиль, с которым
 * зашли. Всё это заполняет `joinVoice` в момент входа — потом активный инстанс может быть уже другим.
 */
export interface VoiceConnection {
  channelId: string;
  url: string;
  token: string;
  /** Запись реестра, где идёт голос; `null` — реестра нет (веб без записей), переходов тогда не бывает. */
  instanceId: string | null;
  serverId: string | null;
  channelName: string;
  serverName: string;
  /** Имя инстанса голоса — для строки «Вы в голосе на «X»», когда на экране другой. */
  instanceName: string;
  /** Как нас видят в комнате: живой `user` после перехода — учётка ДРУГОГО инстанса. */
  self: { displayName: string; avatarUrl: string | null } | null;
  /** Наш id в комнате (личность LiveKit = id учётки на инстансе голоса) — трей и оверлей ищут «себя» по нему. */
  selfId: string | null;
}

/** Клиент API инстанса голоса: активный — обычный `api`, иначе привязанный к записи (`apiFor`). */
export function voiceApiOf(v: Pick<VoiceConnection, 'instanceId'> | null): Api {
  return v?.instanceId && v.instanceId !== activeInstanceId() ? apiFor(v.instanceId) : api;
}

/** Голос идёт на том инстансе, что сейчас на экране (или реестра нет). */
export function voiceIsHere(v: Pick<VoiceConnection, 'instanceId'> | null): boolean {
  return !v?.instanceId || v.instanceId === activeInstanceId();
}

/** Live LiveKit connection state for the joined voice session — drives the self-bar status colour. */
export type VoiceState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** Live per-participant voice state for the channel you are connected to (instant, from LiveKit). */
export interface LiveVoiceState {
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  screensharing: boolean;
}

/** Which workspace the middle of the app shows: a server's channels, or direct messages. */
export type AppView = 'server' | 'dm';

interface State extends ConvActions {
  user: User | null;
  servers: Server[];
  currentServerId: string | null;
  bootstrap: ServerBootstrap | null;
  currentChannelId: string | null;
  messagesByChannel: Record<string, Message[]>;
  /** Members of the open server (with user info, roles, join date) — cached for the user menu. */
  members: ServerMemberInfo[];
  presence: PresenceMap;
  onlineUsers: string[]; // userIds with an active gateway connection
  /**
   * `presence4`: «Невидимые» на серверах, но в сети для ЛС (`online.dm`, `online.snapshot.dmOnly`). Только ЛС — шапка, карточка
   * из ЛС, строки списков (`dmOnline.ts`); серверные списки смотрят лишь `onlineUsers`.
   */
  dmOnlineUsers: string[];
  /**
   * `presence5` (08.10, D4, решение 42): в сети на серверах, но «не в сети» для ЛС — приложение скрыто или простаивает, и
   * человек не в голосе и не в звонке (`online.away`, `online.snapshot.dmAway`). Только ЛС (`dmOnline.dmPresent`); серверные
   * списки смотрят лишь `onlineUsers`. Меняется только этими событиями: выход из сети совсем шлюз завершает `away: false`.
   */
  dmAwayUsers: string[];
  /** Э7 ч.3 (D): счётчик «перезапросить время захода» (`lastSeenRefresh.ts`); хук `useLastSeen` читает его как зависимость. */
  lastSeenEpoch: number;
  /** Э7 ч.3 (D): название СВОЕГО инстанса (`GET /instance`, `selfInstanceName.ts`) — подпись «через «…»» у получателя. */
  selfInstanceName: string;
  /** userId -> chosen presence state + custom status (from member rosters + user.status broadcasts). */
  userStatuses: Record<string, { status: PresenceStatus; customStatus: CustomStatus | null }>;
  /** userId -> game they're currently playing (#40; seeded from GET /users/activities + user.activity). */
  userActivities: Record<string, GameActivity>;
  /** channelId -> число непрочитанных сообщений (#78; сеется из bootstrap.reads, дальше живьём). */
  unreadCounts: Record<string, number>;
  /** channelId -> count of unresolved @-mentions (red badge). Seeded from bootstrap.reads. */
  mentionCounts: Record<string, number>;
  /**
   * serverId -> непрочитанные на ЧУЖОМ (не открытом сейчас) сервере. У открытого сервера значков нет:
   * там всё видно по каналам. Живёт от событий гейтвея — раньше их по чужим серверам просто не было,
   * поэтому и показывать было нечего.
   */
  unreadServers: Record<string, number>;
  /** serverId -> упоминания на чужом сервере: значок ярче, его нельзя пропустить. */
  mentionServers: Record<string, number>;
  voice: VoiceConnection | null;
  liveVoice: Record<string, LiveVoiceState>; // identity -> live state, for the joined channel only
  /**
   * Экономика по серверам: `serverId` → снимок.
   *
   * 🔴 ОДНА копия на приложение. Раньше чип в шапке и оверлей типа держали каждый свою и опрашивали
   * сервер порознь раз в минуту: после типа оверлей перечитывал себя, а чип — нет, и человек видел
   * два разных баланса в одном окне.
   * Обновляется пушем `economy.wallet` (см. `sockets.ts`), загружается через `ensureEconomy`.
   */
  economy: Record<string, EconomyView>;
  /** This user's own intended mic-mute / deafen — stable across channel switches & reconnects, so the
   *  UI never flashes a transient state. Mirrored from VoiceConnection; persisted; seeds the global bar. */
  selfMuted: boolean;
  selfDeafened: boolean;
  /** Live LiveKit connection state — green/red/grey status on the self-bar. Mirrored by VoiceConnection. */
  voiceState: VoiceState;
  /** Идёт НАТИВНАЯ трансляция экрана (companion-участник из Rust). ⚠️ Живёт здесь, а не в
   *  `VoiceControls`: тот сидит в сайдбаре, который при переходе в ЛС подменяется целиком, и
   *  локальное состояние трансляции умирало вместе с ним (#96). См. `nativeShareSession.ts`. */
  nativeSharing: boolean;
  /** Входящий «тык» — показывается модалкой поверх всего. `null` = никто не тыкал. */
  incomingPoke: { fromName: string; message: string; channelId: string } | null;
  /** Стримы, ОТКРЫТЫЕ на сцене (identity стримера), и их личное заглушение/громкость.
   *  Живёт в сторе, а не только в сцене: звучанием стрим-аудио заведует `VoiceConnection`, который
   *  смонтирован всегда, пока вы в голосе, — сцена размонтируется при уходе в текстовый канал (#71). */
  watchedStreams: string[];
  mutedStreams: string[];
  streamVolumes: Record<string, number>;
  /** Намерение «зайти в канал и открыть показ вот этого человека» — клик по кадру в карточке
   *  наведения. Почему намерение, а не сразу запись в `watchedStreams`, — в `pendingWatch.ts`. */
  pendingWatch: PendingWatch | null;
  /**
   * Серверы, закрытые для нас держателем (#139, F4, §5.3.1) — по id сервера.
   *
   * 🔴 Держим В СТОРЕ, а не показываем одно окно и забываем: членство остаётся (`closed_by_host`),
   * сервер остаётся в рейле, и человек будет жать на него снова. Без памяти он каждый раз получал
   * бы «не найдено» и решил бы, что приложение сломалось.
   */
  closedServers: Record<string, AccessNotice>;
  /** Какое окно «сервер закрыт» показать прямо сейчас. `null` — никакое. */
  accessNotice: AccessNotice | null;
  /**
   * Счётчик изменений в связках федерации (#139, F1). Растёт по событию `federation.links`.
   *
   * 🔴 Счётчик, а не сами связки: их читает только вкладка «Федерация» и только целиком, одной
   * ручкой. Держать их ещё и в сторе значило бы иметь две копии одной правды и выбирать между ними.
   * Вкладка просто смотрит на это число и перечитывает себя, когда оно сдвинулось.
   */
  federationRev: number;
  /**
   * Счётчик «связка дома с инстансом, где я гость, сменилась» (15.10, событие `federation.guest_links`): рейл перечитывает
   * «Где я гость» и убирает группы разорванных связок (`guestGone.ts`).
   */
  guestLinksRev: number;
  /**
   * Поколение активного инстанса (§5.7). Растёт на каждом переходе между инстансами.
   *
   * 🔴 На него подписан `App`: переход больше не перезапускает приложение, поэтому кто-то обязан
   * заново пройти «узнать себя → загрузить серверы → поднять сокеты». Это делает эффект на это
   * число — один вход в загрузку и для старта, и для перехода, чтобы они не разъехались.
   */
  instanceEpoch: number;
  /**
   * Идёт переход между инстансами (§5.7).
   *
   * 🔴 Ставится СИНХРОННО вместе со сбросом стора, и в этом весь смысл. `switchedInstance()`
   * обнуляет `user`, а «идёт загрузка» включал эффект `App` — то есть уже ПОСЛЕ отрисовки. В этот
   * один кадр `user === null` и загрузки ещё нет, и React честно рисовал ЭКРАН ВХОДА: при каждом
   * переходе приложение моргало формой входа. Снимается там же, где заканчивается загрузка.
   */
  switching: boolean;

  // direct messages
  view: AppView;
  /**
   * Признаки сервера из `/auth/me` (`features`, ЛС этап 1). Отдельно от `user`: `setAuth` получает `User` и из ручек
   * без `features` (вход, статус, профиль) — внутри `user` признаки терялись (разведка 30.09). `null` — не узнавали.
   */
  serverFeatures: string[] | null;
  /**
   * Э5 (#141, `fedm5`): «мой дом лежит — пишу через инстанс собеседника» (ведёт `fedVia.ts`). `down` — дом недоступен; `self` — название
   * нашего инстанса для плашки; `ready` — беседы с действующей долгой сессией у собеседника. Плашка и запрет вложений — `DmChatView`.
   */
  fedVia: { down: boolean; self: string; ready: string[] };
  /**
   * Режим бесед (ЛС этап 2, `docs/dm/STAGE2.md`): решается ОДИН раз в `bootstrap`, до подключения шлюза, — по нему
   * шлюзу уходит `caps: ['conv1']`, и старые события `dm.*` этому соединению больше не приходят. Посреди сессии не
   * меняется: переключатель устройства перезагружает страницу.
   */
  convActive: boolean;
  /**
   * Просьба ленте беседы `id` уйти «вниз» (G26): повторный выбор уже открытой беседы в списке — Telegram ПК 03·3.1.2.
   * `n` растёт с каждой просьбой — `MessagePane` ведёт себя как кнопка «Вниз».
   */
  feedDownAsk: { id: string; n: number } | null;
  /** Состояние бесед в режиме бесед (`convSyncRules.ts`); в старом режиме пустое. */
  conv: ConvState;
  /** Ключ записи кеша бесед на диске (`convCacheRules.convCacheKey`), решён в `bootstrap`; при выходе запись стирается. */
  convCacheKey: string | null;
  /** Исходящие бесед по беседе (шаг 2в): переживают смену беседы, голос и перезапуск; ведёт `convStore`. */
  outbox: Record<string, OutboxItem[]>;
  /** Черновики бесед на этом устройстве (шаг 2д): текст и ответ; пустой — удалён. Пишутся в кеш на диске. */
  drafts: Record<string, { text: string; replyToId: string | null }>;
  /** Где человек ушёл из беседы, если не снизу (шаг 2г, `convSetPlace`). Пишется в кеш на диске. */
  places: Record<string, FeedPlace>;
  /** Беседы с черновиком, не записанным на сервер (Р7, ведёт `convStore`). Пишется в кеш на диске. */
  draftDirty: string[];
  /** Счётчик черновиков, пришедших с других устройств (Р7): открытая лента по нему кладёт текст в поле. */
  draftRev: Record<string, number>;
  setDraft: (convId: string, text: string, replyToId: string | null) => void;
  /**
   * Черновики каналов серверов (06.10, сверка с Telegram): лента канала пересоздаётся при смене канала (`key` в
   * `MainLayout`), и набранное терялось. Только в памяти этого устройства: у каналов нет серверного хранилища черновиков
   * (оно — у бесед, `conv3`), поэтому ни записи на сервер, ни диска, ни других устройств. Уходят с выходом и сменой инстанса.
   */
  channelDrafts: Record<string, { text: string; replyToId: string | null }>;
  setChannelDraft: (channelId: string, text: string, replyToId: string | null) => void;
  setServerFeatures: (features: string[] | null) => void;
  setConvActive: (on: boolean) => void;
  setConvCacheKey: (key: string | null) => void;
  dms: DmChannel[];
  currentDmId: string | null;
  /** Bumped by requestMention; the active composer inserts `@name` once per new value. */
  mentionRequest: { name: string; n: number } | null;
  /** Mobile-only: which pane is on screen (list of channels/DMs, or the open chat/voice). */
  mobilePane: 'list' | 'content';
  /** Телефон, вкладка «Серверы»: показан СПИСОК серверов, а не каналы открытого (кнопка «Назад» в шапке каналов, #218). Сбрасывается при открытии сервера и канала. */
  serverListOpen: boolean;
  /** Mobile-only: whether the members list is open as a slide-over drawer. */
  mobileMembersOpen: boolean;
  /** Mobile-only: whether the Профиль tab screen is showing (design-step8 D3). */
  mobileProfileOpen: boolean;
  /** Whether the user-settings modal is open (lifted to the store so the mobile nav can open it). */
  settingsOpen: boolean;
  /** Приветствие экономики открыто ПО ПРОСЬБЕ (кошелёк, стенд); авто-показ первого раза решает MainLayout. */
  economyWelcomeOpen: boolean;
  /** Whether the admin panel is open (lifted to the store so BOTH the desktop rail button and the
   *  mobile Профиль tab can open it — the rail's admin icon is hidden on mobile). */
  adminOpen: boolean;
  /**
   * Чья админка открыта (01.10): запись реестра ДОМА, когда человек стоит гостем у соседа, — запросы идут туда
   * (`adminApi.ts`), без перехода и обрыва голоса; `null` — активный инстанс.
   */
  adminInstanceId: string | null;
  /** Whether the message-search modal is open (lifted so the Ctrl+F shortcut can open it). */
  searchOpen: boolean;
  dmMessages: Record<string, Message[]>;
  unreadDms: string[];
  /**
   * Ленты (канал или беседа), чья история не загрузилась, а показать нечего (#212, Б5). Без этого
   * сбой выглядел как вечные скелетоны: ни ошибки, ни повода нажать ещё раз.
   */
  historyFailed: string[];

  /** Account-wide push-mute sets (loaded on boot). Suppress phone pushes from a server's @mentions
   *  or a person's DMs — in-app delivery is unaffected. Edited via context menus. */
  pushMutedServers: string[];
  pushMutedDmUsers: string[];
  /**
   * Сроки заглушек собеседников (07.10, сервер `conv11`): id человека → до какого времени; нет записи у заглушённого —
   * навсегда. Нужен, когда сводка беседы поля `muted` не несёт (старый путь `/api/dm`); иначе источник — сводка.
   */
  pushMuteUntil: Record<string, string>;
  /**
   * Исключения «Уведомления включены» (08.10, решение владельца 38, сервер `push4`): цели (`dm_user` — id собеседника или
   * `group:<id беседы>`), которые уведомляют при выключенных «Личных» / группах. Грузится с заглушками, меняется `setPushAlways`.
   */
  pushAlwaysTargets: string[];
  /** Чёрный список ЛС (#212) — кого я заблокировал. Грузится на старте, меняется `setBlocked`. */
  blockedUsers: BlockedUser[];

  setAuth: (user: User) => void;
  /**
   * Выйти. Возвращает обещание: переписка на диске (кеш бесед) стирается асинхронно, и перезагрузка сразу после выхода
   * оборвала бы стирание — места вызова ждут его (не дольше секунды) перед `location.reload()`.
   */
  logout: () => Promise<void>;
  loadPushMutes: () => Promise<void>;
  loadBlocks: () => Promise<void>;
  /** Заблокировать / разблокировать (сразу в списке, откат при ошибке сервера). */
  setBlocked: (user: BlockedUser, blocked: boolean) => Promise<void>;
  /**
   * Optimistically toggle a push-mute (server or dm_user); reverts + rethrows on API failure. `seconds` (07.10, сервер
   * `conv11`) — на срок, без него навсегда; у `dm_user` правится и сводка беседы (значок, серый счётчик — сразу).
   */
  setPushMuted: (scope: PushMuteScope, targetId: string, muted: boolean, seconds?: number, soundOnly?: boolean) => Promise<void>;
  /** Исключение «Уведомления включены» беседы (решение владельца 38, `push4`); включение снимает полную заглушку на сервере. */
  setPushAlways: (targetId: string, on: boolean) => Promise<void>;
  /**
   * Закрепить / открепить беседу наверху своего списка (07.10, сервер `conv11`): сразу у себя, затем ручка; отказ
   * (лимит — `reason: 'conv_pin_limit'`, сеть) откатывает и пробрасывается — тост решает зовущий.
   */
  setConvPinned: (convId: string, pinned: boolean) => Promise<void>;
  /**
   * Переставить закреплённые беседы одного списка (08.10, сервер `pinorder1`): `ids` — новый порядок сверху вниз. Сразу у
   * себя (те же отметки, что поставит сервер), затем ручка; ответ сервера — его отметки. Отказ откатывает и пробрасывается.
   */
  reorderConvPins: (ids: string[]) => Promise<void>;
  /** «Пометить как непрочитанное / прочитанное» (G04, сервер `conv13`): точка у себя сразу, сервер подтвердит событием. */
  setConvUnreadMark: (convId: string, marked: boolean) => Promise<void>;
  /** «В архив» / «Вернуть из архива» (07.10, `archive1`, G41): у себя сразу, откат при сбое. */
  setConvArchived: (convId: string, archived: boolean) => Promise<void>;
  /** Крестик на плашке незнакомца (08.10, `stranger1`, С7): гаснет сразу, откат при сбое; на сервере — в моей строке участника. */
  hideStrangerBar: (convId: string) => Promise<void>;
  /** «Пожаловаться» из плашки незнакомца (08.10, `stranger1`, С7): плашка гаснет сразу (сервер скрывает её жалобой), откат при сбое. */
  reportStranger: (convId: string, reason: DmReportReason, comment?: string) => Promise<{ merged: boolean }>;
  /**
   * Реакции на мои сообщения увидены (G24, `reactunread1`): `ids` — показанные на экране, `null` — все («Прочитать все»). У себя
   * сразу (число в сводке и `reactionUnread` у сообщений), на сервере — `POST /conv/:id/reactions-read`; сбой — откат.
   */
  readConvReactions: (convId: string, ids: string[] | null) => Promise<void>;
  /** «Прочитать все» (G04, `conv13`): все беседы с непрочитанным или пометкой; число затронутых. */
  readAllConvs: () => Promise<number>;
  /** «Пометить как прочитанное» из меню строки (G04, `conv13`): беседа читается до последнего сообщения и теряет точку. */
  markConvRead: (convId: string) => Promise<void>;
  /**
   * «Очистить историю» беседы (07.10, сервер `conv12`, G01): у меня или у обоих. Лента и список меняются событиями
   * сервера (удаления), как у удаления пачкой; сбой пробрасывается — тост решает зовущий.
   */
  clearConvHistory: (convId: string, scope: 'me' | 'both') => Promise<void>;
  /**
   * «Удалить чат» (07.10, сервер `conv12`, G01): беседа уходит из списка (событие сервера `ConvLeft`) до нового
   * сообщения. Открытая — закрывается сразу: на ПК пустая главная область, на телефоне — список.
   */
  hideConv: (convId: string, scope: 'me' | 'both') => Promise<void>;
  loadServers: () => Promise<void>;
  /** `channelId` (08.10, G35 «Серверы»): открыть сразу этот канал, а не первый — иначе первый канал отметился бы прочитанным. */
  openServer: (serverId: string, channelId?: string) => Promise<void>;
  refreshBootstrap: (serverId: string) => Promise<void>;
  resyncAfterReconnect: () => Promise<void>;
  patchServerSound: (event: string, url: string | null) => void;
  patchChannelSound: (channelId: string, event: string, url: string | null) => void;
  loadMembers: (serverId: string) => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  /** Отметить прочитанным, НЕ открывая: на телефоне уход из ленты в список — тоже «дочитал». */
  readChannelNow: (channelId: string) => void;
  readDmNow: (dmId: string) => void;
  /** Прочитано на ДРУГОМ моём устройстве — погасить у себя (событие `read.channel`/`read.dm`). */
  applyRemoteRead: (e: { channelId?: string; dmId?: string; serverId?: string; at?: string }) => void;
  /** Подтянуть порцию более старых сообщений. Возвращает, есть ли смысл просить ещё. */
  loadOlderMessages: (channelId: string) => Promise<boolean>;
  /** Слушать соседние вкладки: прочитанное там гаснет и здесь. Возвращает отписку. */
  listenTabs: () => () => void;
  joinVoice: (channelId: string) => Promise<void>;
  refreshVoiceToken: () => Promise<void>;
  /** keepSession: don't clear the persisted voice session — used by the reconnect-grace visual leave so
   *  a restart within the grace window auto-rejoins (#11). A user-initiated leave clears it. */
  leaveVoice: (keepSession?: boolean) => void;
  /** Модератор переместил нас, пока голос идёт на ДРУГОМ инстансе (01.10): новый токен у инстанса голоса. */
  moveVoiceTo: (channelId: string) => Promise<void>;
  /** On boot: rejoin the last voice channel if it dropped within the grace window (crash / quick restart). */
  restoreVoiceSession: (session?: VoiceSession) => Promise<void>;
  /** Сеть вернулась в уже запущенном приложении — вернуться в канал, из которого выбило (#11). */
  rejoinVoiceAfterOutage: () => Promise<void>;
  setLiveVoice: (m: Record<string, LiveVoiceState>) => void;
  setEconomy: (serverId: string, view: EconomyView) => void;
  /** Пуш с сервера: меняем ТОЛЬКО кошелёк, настройки и иконку не трогаем. */
  applyWallet: (serverId: string, w: { balance: number; earnedTotal: number; seasonEarned: number }) => void;
  /** Живые подсказки «кто кого типнул» над строками списка голоса. Сами гаснут. */
  tipHints: TipHint[];
  pushTipHint: (h: { toUserId: string; fromUserId: string; fromName: string; amount: number }) => void;
  /**
   * События для всплывающей плашки поверх игры: типы И щипки. Отдельный список от `tipHints` —
   * почему именно, разобрано в шапке `toastRules.ts` (щипок не прибавляет получателю, и вытеснение
   * здесь по экрану, а не по человеку).
   */
  toastEvents: ToastEvent[];
  pushToastEvent: (e: { kind: ToastKind; fromName: string; toName: string; amount: number }) => void;
  setSelfVoice: (v: { muted: boolean; deafened: boolean }) => void;
  setVoiceState: (s: VoiceState) => void;
  setNativeSharing: (v: boolean) => void;
  showPoke: (p: { fromName: string; message: string; channelId: string }) => void;
  dismissPoke: () => void;

  // direct messages
  setView: (view: AppView) => void;
  loadDms: () => Promise<void>;
  openDmWith: (userId: string) => Promise<void>;
  /** Э1 (`fedm1`): «Написать» человеку связанного инстанса из поиска (`RemoteUserHit`) — как `openDmWith`. */
  openDmRemote: (who: { instanceId: string; homeUserId: string }) => Promise<void>;
  /** «Избранное» (08.10, `saved1`): открыть беседу с самим собой, заведя её при первом разе (Ctrl+0, «Переслать» → «Избранное»). */
  openSaved: () => Promise<void>;
  requestMention: (name: string) => void;
  setMobilePane: (pane: 'list' | 'content') => void;
  setServerListOpen: (open: boolean) => void;
  /** Нажатие на вкладку «Серверы» (телефон, #218): последний сервер открывается сам; повторное нажатие на открытую вкладку — к списку серверов. */
  openServersTab: (wasActive: boolean) => void;
  setMobileMembersOpen: (open: boolean) => void;
  setMobileProfileOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setEconomyWelcomeOpen: (open: boolean) => void;
  setAdminOpen: (open: boolean, instanceId?: string | null) => void;
  setSearchOpen: (open: boolean) => void;
  selectDm: (dmId: string) => Promise<void>;
  /**
   * Страж ухода из беседы (G13, #211): пока идёт запись голосового, смена беседы спрашивает, выбросить ли её — как
   * Telegram Desktop (`HistoryWidget` зовёт `VoiceRecordBar::showDiscardBox` перед показом другой беседы). Ставит лента,
   * где идёт запись (`MessagePane`); спрашивают `openServer`, `openChannel`, `selectDm`. Нет стража — уход без ожидания.
   * `target` — куда уходим; `true` — можно.
   */
  leaveGuard: ((target: string | undefined) => boolean | Promise<boolean>) | null;
  /** Поставить страж; вернёт снятие (снимает только свой). */
  setLeaveGuard: (fn: (target: string | undefined) => boolean | Promise<boolean>) => () => void;
  /**
   * «Ответить в другом чате» (08.10, G55, `quote1`): ответ, ждущий открытия беседы `convId` — её лента ставит его в поле
   * (полоса ответа с цитатой) и снимает отсюда. `message` — цитируемое ИЗ ДРУГОЙ беседы, `quote` — выбранный фрагмент.
   */
  crossReply: { convId: string; message: Message; quote: { text: string; offset: number } | null } | null;
  setCrossReply: (v: { convId: string; message: Message; quote: { text: string; offset: number } | null } | null) => void;
  /**
   * «Поделиться в GusVoice» (09.10, G79): файлы и текст из чужого приложения ждут ленту выбранной беседы
   * (`components/ShareIncoming.tsx` кладёт, `MessagePane` забирает и обнуляет: файлы — в окно отправки / на полосу у поля,
   * текст — в поле). Не отправляется само.
   */
  sharedIn: { convId: string; files: File[]; text: string } | null;
  setSharedIn: (v: { convId: string; files: File[]; text: string } | null) => void;
  /**
   * Черновик пересылки (08.10, решение владельца п.9; Telegram Desktop `History::setForwardDraft`, полоса над полем —
   * `HistoryView::Controls::ForwardPanel`): по беседе-получателю. Как у Telegram — только в памяти этого окна: между
   * устройствами не ездит и перезагрузку не переживает, переключение бесед — переживает. Ставит лента-источник
   * («Переслать» в одну беседу, бросок на строку списка), снимают × полосы, Esc и отправка (`MessagePane`).
   */
  fwdDrafts: Record<string, FwdDraft>;
  setFwdDraft: (convId: string, draft: FwdDraft | null) => void;
  /** Перечитать последнюю порцию беседы и слить с кешем (открытие, повтор, пробуждение). */
  refreshDmHistory: (dmId: string) => Promise<void>;
  /** Подтянуть порцию более старых сообщений беседы; `false` — дно. */
  loadOlderDmMessages: (dmId: string) => Promise<boolean>;

  // socket-driven mutations
  appendMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, message: Message) => void;
  applyReaction: (channelId: string, messageId: string, emoji: string, userId: string, op: 'add' | 'remove') => void;
  removeMessage: (channelId: string, messageId: string) => void;
  upsertChannel: (channel: Channel) => void;
  deleteChannel: (serverId: string, channelId: string) => void;
  patchChannels: (updates: { id: string; categoryId: string | null; position: number }[]) => void;
  setPresenceSnapshot: (channels: PresenceMap, occupied: Record<string, number>) => void;
  /** Сколько каждый видимый канал занят — сервер говорит один раз, клиент досчитывает сам. */
  occupancy: Record<string, Occupancy>;
  setOccupancy: (channelId: string, ms: number | null) => void;
  mergePresence: (channelId: string, participants: VoiceParticipant[]) => void;
  setOnlineSnapshot: (users: string[], dmOnly?: string[], dmAway?: string[]) => void;
  setDmOnline: (userId: string, online: boolean) => void;
  setDmAway: (userId: string, away: boolean) => void;
  setOnlineUpdate: (userId: string, online: boolean) => void;
  applyUserStatus: (userId: string, status: PresenceStatus, customStatus: CustomStatus | null) => void;
  applySelfStatus: (status: PresenceStatus, statusAuto: boolean) => void;
  applyUserActivity: (userId: string, activity: GameActivity | null) => void;
  setActivities: (activities: Record<string, GameActivity>) => void;
  applyUserProfile: (
    userId: string,
    displayName: string,
    avatarUrl: string | null,
    animatedAvatarUrl: string | null,
  ) => void;
  applyMemberNickname: (serverId: string, userId: string, nickname: string | null) => void;
  watchStream: (id: string) => void;
  unwatchStream: (id: string) => void;
  clearWatchedStreams: () => void;
  setPendingWatch: (p: PendingWatch) => void;
  /** Запомнить отказ и показать окно. Зовётся и по событию, и по отказу при открытии сервера. */
  noteAccessClosed: (n: AccessNotice) => void;
  clearAccessNotice: () => void;
  /** Связки изменились — разбудить вкладку «Федерация», если она открыта. */
  bumpFederationRev: () => void;
  /** Связка с инстансом, где я гость, сменилась — рейлу перечитать «Где я гость». */
  bumpGuestLinksRev: () => void;
  /**
   * Забыть всё, что принадлежало прежнему инстансу, и объявить новое поколение (§5.7).
   *
   * ⚠️ Токен НЕ трогаем, в отличие от `logout`: он принадлежит записи реестра, которую мы просто
   * покинули, и человек в неё вернётся одним кликом по её серверу.
   */
  switchedInstance: () => void;
  /** Доступ вернули — снимаем замок, чтобы сервер снова открывался без перезагрузки. */
  clearAccessClosed: (serverId: string) => void;
  clearPendingWatch: () => void;
  /** Единственный способ «оказаться в голосовом канале»: зайти (если ещё не там) и открыть его
   *  вид. Заведён, чтобы это знание не жило в двух местах — в сайдбаре и в карточке наведения. */
  enterVoiceChannel: (channelId: string) => Promise<void>;
  toggleStreamMute: (id: string) => void;
  setStreamVolume: (id: string, v: number) => void;
  applyPoll: (channelId: string, messageId: string, poll: Poll) => void;
  applyPollCounts: (channelId: string, messageId: string, options: { id: string; votes: number }[]) => void;
  applyPollVoters: (channelId: string, messageId: string, voters: number) => void;
  markUnread: (channelId: string, mentioned?: boolean, serverId?: string) => void;
}

/**
 * Личная громкость каждого стрима, переживает перезапуск. Ключ ПО ИНСТАНСУ (F0 #139): внутри id людей;
 * прежний общий ключ каждый инстанс получает копией — настройки не теряются (`instanceScopeRules.ts`).
 */
const STREAM_VOLUMES_KEY = 'gv_stream_volumes';
/** Тонкая обёртка: сам разбор и приведение — в  под тестами. */
const readStreamVolumes = (): Record<string, number> =>
  loadStreamVolumes((k) => scopedGetItem(k), STREAM_VOLUMES_KEY);


const SELF_VOICE_KEY = 'gv_self_voice';
function loadSelfVoice(): { muted: boolean; deafened: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(SELF_VOICE_KEY) || '{}');
    return { muted: !!v.muted, deafened: !!v.deafened };
  } catch {
    return { muted: false, deafened: false };
  }
}

/** Настоящее окружение действий бесед (`convStore.ConvDeps`): сеть, часы и таймеры окна, `online`. Тесты дают своё. */
function browserConvDeps(): ConvDeps {
  return {
    api,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onOnline: (fn) => {
      try {
        window.addEventListener('online', fn);
      } catch {
        /* без окна — только по `ready` и таймерам */
      }
    },
    isMobile,
    markChannelSeen,
    windowed: () => true,
    draftsOnServer: () => serverKeepsDrafts(useStore.getState().serverFeatures),
    // Метка устройства на эту загрузку страницы (Р7): своё эхо черновика не применяется. `crypto` в харнессе тестов нет.
    draftDevice: `d${Math.random().toString(36).slice(2, 12)}`,
    // ✓✓ (Р6): сервер с `conv4` — сводки из кеша без `peerReadKey` догонка перечитает списком.
    peerReadsOnServer: () => serverSendsPeerRead(useStore.getState().serverFeatures),
    // Нет сети у устройства — не ушедшее сразу «не отправлено» (уйдёт само по `online`), а не минута повторов (05.10).
    deviceOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
    // «Прочитано» по видимому (G09): лента сообщает увиденное (`MessagePane.onSeen` → `convSeen`), отметка — не дальше.
    readByView: () => true,
  };
}

export const useStore = create<State>((set, get) => ({
  user: null,
  servers: [],
  currentServerId: null,
  bootstrap: null,
  currentChannelId: null,
  messagesByChannel: {},
  members: [],
  presence: {},
  onlineUsers: [],
  dmOnlineUsers: [],
  dmAwayUsers: [],
  lastSeenEpoch: 0,
  selfInstanceName: '',
  userStatuses: {},
  userActivities: {},
  unreadCounts: {},
  mentionCounts: {},
  unreadServers: {},
  mentionServers: {},
  voice: null,
  liveVoice: {},
  economy: {},
  selfMuted: loadSelfVoice().muted,
  selfDeafened: loadSelfVoice().deafened,
  voiceState: 'disconnected',
  nativeSharing: false,
  incomingPoke: null,
  watchedStreams: [],
  mutedStreams: [],
  streamVolumes: readStreamVolumes(),
  pendingWatch: null,
  closedServers: {},
  accessNotice: null,
  federationRev: 0,
  guestLinksRev: 0,
  instanceEpoch: 0,
  switching: false,

  view: 'server',
  serverFeatures: null,
  fedVia: { down: false, self: '', ready: [] },
  convActive: false,
  feedDownAsk: null,
  conv: emptyConvState(),
  convCacheKey: null,
  outbox: {},
  drafts: {},
  places: {},
  draftDirty: [],
  draftRev: {},
  channelDrafts: {},
  setChannelDraft: (channelId, text, replyToId) =>
    set((s) => {
      // Правило то же, что у бесед: пустой — удалён, то же значение — тот же объект (стор не будим на каждую букву).
      const channelDrafts = updateDrafts(s.channelDrafts, channelId, text, replyToId);
      return channelDrafts === s.channelDrafts ? s : { channelDrafts };
    }),
  setDraft: (convId, text, replyToId) => {
    const before = get().drafts;
    set((s) => {
      const drafts = updateDrafts(s.drafts, convId, text, replyToId);
      return drafts === s.drafts ? s : { drafts };
    });
    // Р7: изменился на ЭТОМ устройстве — на сервер, к остальным моим устройствам (без `conv3` — ничего).
    if (get().drafts !== before) get().convDraftChanged(convId);
  },
  ...createConvActions(set, get, browserConvDeps()),
  setServerFeatures: (features) => set({ serverFeatures: features }),
  setConvActive: (on) => set({ convActive: on }),
  setConvCacheKey: (key) => set({ convCacheKey: key }),
  dms: [],
  currentDmId: null,
  mentionRequest: null,
  mobilePane: 'list',
  serverListOpen: false,
  mobileMembersOpen: false,
  mobileProfileOpen: false,
  settingsOpen: false,
  economyWelcomeOpen: false,
  adminOpen: false,
  adminInstanceId: null,
  searchOpen: false,
  dmMessages: {},
  historyFailed: [],
  unreadDms: [],
  pushMutedServers: [],
  pushMutedDmUsers: [],
  pushMuteUntil: {},
  pushAlwaysTargets: [],
  blockedUsers: [],

  setAuth: (user) =>
    set((state) => ({
      user,
      // Keep the roster's own entry in sync with the live user so a name/avatar/status edit shows up
      // instantly in the member list, chat author, and user-card — no rejoin / loadMembers refetch.
      // 🔴 `animatedAvatarUrl` в этом списке ЗАБЫЛИ, когда заводили анимацию (фикс 05.09). Все
      // поверхности берут её из РОСТЕРА (`useAnimatedAvatarUrl` читает `members`), а не из `user`,
      // поэтому своя только что залитая гифка появлялась у человека лишь после перезахода: сам он
      // видел её в профиле, а в списке канала, на сцене и в сообщениях у себя — нет.
      // ⚠️ Класс тот же, что у метки сезона и у флагов инстанса: поле добавили, а место, где
      // состояние переносится дальше, не обновили. Заводя поле в профиле — грепать этот список.
      members: state.members.map((m) =>
        m.user.id === user.id
          ? {
              ...m,
              user: {
                ...m.user,
                displayName: user.displayName,
                avatarUrl: user.avatarUrl,
                animatedAvatarUrl: user.animatedAvatarUrl,
                status: user.status,
                customStatus: user.customStatus,
              },
            }
          : m,
      ),
      userStatuses: { ...state.userStatuses, [user.id]: { status: user.status, customStatus: user.customStatus } },
    })),

  logout: () => {
    // Android: drop this device's push registration while we still hold the token (before setToken(null)).
    stopPushRegistration();
    // Идущие трансляции геопозиции гасим (`geolive1`): токен уйдёт, а служба Android держала бы его в памяти до срока.
    void import('./geoLiveSharing').then((m) => m.stopAllGeoLiveLocal(), () => {});
    // Clear the persisted auth token + voice session, else App.tsx's boot effect
    // re-authenticates from the stored gv_token on the reload that follows logout()
    // (the button "did nothing" — it reloaded straight back into the app).
    setToken(null);
    // Записи кеша бесед всей семьи (дом + его гостевые записи) — ДО `logoutFamily`: выход из гостей выходит и из дома,
    // а ключ сессии (`convCacheKey`) у гостя — гостевой, и домашняя переписка осталась бы на диске.
    const cacheKeys = new Set<string>();
    const ownKey = get().convCacheKey;
    if (ownKey) cacheKeys.add(ownKey);
    const registry = instances();
    const cur = registry.find((i) => i.id === activeInstanceId());
    const homeId = cur?.guestOf ?? cur?.id;
    for (const i of registry) {
      if (!i.userId || !homeId || (i.id !== homeId && i.guestOf !== homeId)) continue;
      cacheKeys.add(convCacheKey(i, i.apiUrl || config.apiUrl, i.userId));
    }
    // 🔴 И у ДОМА, и у всех его гостевых записей: гостевая сессия живёт поручительством дома, и
    // «выйти» означает выйти из своего аккаунта, а не только с чужого инстанса. Без этого выход из
    // гостей возвращал человека домой вошедшим — то есть «кнопка не сработала» (найдено 19.09).
    logoutFamily(activeInstanceId());
    clearVoiceSession(get().voice?.instanceId ?? activeInstanceId());
    setCustomSounds({});
    setChannelSounds({});
    get().convReset();
    // Переписка на диске уходит вместе с выходом: на общем компьютере следующий человек её не увидит. Метка — на случай,
    // если стирание оборвётся перезагрузкой: тогда его доделает следующий запуск (`App.decideConvMode`).
    for (const k of cacheKeys) markConvCacheWipe(k);
    // Метка снимается только после настоящего стирания: не открылась база — дочистит следующий запуск.
    const wiped = Promise.all(
      [...cacheKeys].map((k) =>
        deleteConvCache(k).then((ok) => {
          if (ok) clearConvCacheWipe(k);
        }),
      ),
    ).then(() => {});
    set({
      serverFeatures: null,
      convActive: false,
      convCacheKey: null,
      user: null,
      servers: [],
      currentServerId: null,
      bootstrap: null,
      currentChannelId: null,
      messagesByChannel: {},
      channelDrafts: {},
      members: [],
      presence: {},
      onlineUsers: [],
      dmOnlineUsers: [],
      dmAwayUsers: [],
      userActivities: {},
      unreadCounts: {},
      mentionCounts: {},
      voice: null,
      liveVoice: {},
      economy: {},
      view: 'server',
      dms: [],
      currentDmId: null,
      dmMessages: {},
      historyFailed: [],
      unreadDms: [],
      pushMutedServers: [],
      pushMutedDmUsers: [],
      pushMuteUntil: {},
      pushAlwaysTargets: [],
      blockedUsers: [],
    });
    return Promise.race([wiped, new Promise<void>((r) => setTimeout(r, 1000))]);
  },

  loadPushMutes: async () => {
    try {
      const mutes = await api.listPushMutes();
      set({
        pushMutedServers: mutes.filter((m) => m.scope === 'server').map((m) => m.targetId),
        pushMutedDmUsers: mutes.filter((m) => m.scope === 'dm_user').map((m) => m.targetId),
        pushMuteUntil: Object.fromEntries(
          mutes.filter((m) => m.scope === 'dm_user' && typeof m.until === 'string').map((m) => [m.targetId, m.until!]),
        ),
      });
    } catch {
      /* push mutes are a nicety — never block boot over them */
    }
    // Исключения «Уведомления включены» (`push4`): у старого сервера пути нет — без признака не спрашиваем.
    if (serverPush4(get().serverFeatures)) {
      try {
        set({ pushAlwaysTargets: (await api.listPushAlways()).map((a) => a.targetId) });
      } catch {
        /* как заглушки — не мешает запуску */
      }
    }
  },

  setPushAlways: async (targetId, on) => {
    const prev = get().pushAlwaysTargets;
    set({ pushAlwaysTargets: on ? [...new Set([...prev, targetId])] : prev.filter((x) => x !== targetId) });
    try {
      if (on) await api.setPushAlways(targetId);
      else await api.removePushAlways(targetId);
    } catch (e) {
      set({ pushAlwaysTargets: prev });
      throw e;
    }
    // Включение сняло полную заглушку беседы на сервере — перечитать заглушки (сводку беседы обновит событие сервера).
    if (on && get().pushMutedDmUsers.includes(targetId)) await get().loadPushMutes();
  },

  loadBlocks: async () => {
    try {
      set({ blockedUsers: await api.listBlocks() });
    } catch {
      /* старый сервер без чёрного списка или сбой — список просто пуст */
    }
  },

  setBlocked: async (user, blocked) => {
    const prev = get().blockedUsers;
    set({ blockedUsers: blocked ? [...prev.filter((u) => u.id !== user.id), user] : prev.filter((u) => u.id !== user.id) });
    try {
      if (blocked) await api.blockUser(user.id);
      else await api.unblockUser(user.id);
    } catch (e) {
      set({ blockedUsers: prev });
      throw e;
    }
  },

  setPushMuted: async (scope, targetId, muted, seconds, soundOnly) => {
    const key = scope === 'server' ? 'pushMutedServers' : 'pushMutedDmUsers';
    const prev = get()[key];
    const next = muted ? [...new Set([...prev, targetId])] : prev.filter((x) => x !== targetId);
    set({ [key]: next } as Pick<State, typeof key>);
    // 07.10 (`conv11`): у собеседника — срок в `pushMuteUntil` и сводка беседы с ним (до события сервера с точным сроком).
    const prevUntil = get().pushMuteUntil;
    const prevConv = get().conv;
    // Полная заглушка снимает исключение «Уведомления включены» (`push4`; сервер — так же, `push.setPushMute`).
    const prevAlways = get().pushAlwaysTargets;
    if (scope === 'dm_user' && muted && !soundOnly && prevAlways.includes(targetId)) {
      set({ pushAlwaysTargets: prevAlways.filter((x) => x !== targetId) });
    }
    if (scope === 'dm_user') {
      const until = muted && seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
      const { [targetId]: _old, ...rest } = prevUntil;
      const conv = patchPeerMute(prevConv, targetId, muted ? { until, ...(soundOnly ? { soundOnly: true as const } : {}) } : null);
      set({
        pushMuteUntil: until ? { ...rest, [targetId]: until } : rest,
        ...(conv !== prevConv ? { conv, dms: summariesToDms(conv.summaries) } : {}),
      });
    }
    try {
      if (muted) await api.setPushMute(scope, targetId, seconds, soundOnly);
      else await api.removePushMute(scope, targetId);
    } catch (e) {
      set({ [key]: prev, pushAlwaysTargets: prevAlways } as Pick<State, typeof key | 'pushAlwaysTargets'>); // revert on failure
      if (scope === 'dm_user') {
        const conv = patchPeerMute(get().conv, targetId, Object.values(prevConv.summaries).find((x) => x.otherUser?.id === targetId)?.muted ?? null);
        set({ pushMuteUntil: prevUntil, ...(conv !== get().conv ? { conv, dms: summariesToDms(conv.summaries) } : {}) });
      }
      throw e;
    }
  },

  reorderConvPins: async (ids) => {
    const s0 = get();
    const before: Record<string, string | null> = {};
    for (const id of ids) before[id] = s0.conv.summaries[id]?.pinnedAt ?? null;
    const put = (stamps: Record<string, string | null>) => {
      const s = get();
      const conv = patchConvPinOrder(s.conv, stamps);
      if (conv !== s.conv) set({ conv, dms: summariesToDms(conv.summaries) });
    };
    put(pinOrderStamps(ids, Date.now()));
    try {
      const res = await api.convPinOrder(ids);
      put(Object.fromEntries(res.pins.map((p) => [p.id, p.pinnedAt])));
    } catch (e) {
      put(before);
      throw e;
    }
  },

  setConvPinned: async (convId, pinned) => {
    const before = get().conv.summaries[convId]?.pinnedAt ?? null;
    const put = (at: string | null) => {
      const s = get();
      const conv = patchConvPinned(s.conv, convId, at);
      if (conv !== s.conv) set({ conv, dms: summariesToDms(conv.summaries) });
    };
    put(pinned ? new Date().toISOString() : null);
    try {
      const res = await api.convSetPinned(convId, pinned);
      put(res.pinnedAt);
    } catch (e) {
      put(before);
      throw e;
    }
  },

  readConvReactions: async (convId, ids) => {
    const s0 = get();
    const list0 = s0.dmMessages[convId] as (Message & { reactionUnread?: true })[] | undefined;
    const flagged = list0 ? list0.filter((m) => m.reactionUnread && (!ids || ids.includes(m.id))).length : 0;
    const conv = patchReactionsRead(s0.conv, convId, ids ? flagged : null);
    const list = list0 ? clearReactionUnread(list0, ids) : undefined;
    if (conv === s0.conv && (!list || list === list0)) return;
    set({
      conv,
      dms: conv === s0.conv ? s0.dms : summariesToDms(conv.summaries),
      ...(list && list !== list0 ? { dmMessages: { ...s0.dmMessages, [convId]: list as Message[] } } : {}),
    });
    try {
      await api.convReactionsRead(convId, ids ?? undefined);
    } catch (e) {
      const s = get();
      const back = s.conv.summaries[convId] && s0.conv.summaries[convId] ? { ...s.conv, summaries: { ...s.conv.summaries, [convId]: { ...s.conv.summaries[convId], unreadReactions: s0.conv.summaries[convId].unreadReactions } } } : s.conv;
      set({ conv: back, dms: summariesToDms(back.summaries), ...(list0 ? { dmMessages: { ...s.dmMessages, [convId]: list0 } } : {}) });
      throw e;
    }
  },

  hideStrangerBar: async (convId) => {
    const before = get().conv;
    const conv = patchConvStrangerHidden(before, convId);
    if (conv !== before) set({ conv, dms: summariesToDms(conv.summaries) });
    try {
      await api.convHideStranger(convId);
    } catch (e) {
      const s = get();
      const sum = before.summaries[convId];
      if (sum && !s.conv.summaries[convId]?.stranger) {
        const back = { ...s.conv, summaries: { ...s.conv.summaries, [convId]: sum } };
        set({ conv: back, dms: summariesToDms(back.summaries) });
      }
      throw e;
    }
  },

  reportStranger: async (convId, reason, comment) => {
    const res = await api.convReport(convId, { reason, ...(comment ? { comment } : {}) });
    const conv = patchConvStrangerHidden(get().conv, convId);
    if (conv !== get().conv) set({ conv, dms: summariesToDms(conv.summaries) });
    return { merged: res.merged };
  },

  setConvArchived: async (convId, archived) => {
    const before = get().conv.summaries[convId]?.archived === true;
    const put = (on: boolean) => {
      const s = get();
      const conv = patchConvArchived(s.conv, convId, on);
      if (conv !== s.conv) set({ conv, dms: summariesToDms(conv.summaries) });
    };
    put(archived);
    try {
      await api.convSetArchived(convId, archived);
    } catch (e) {
      put(before);
      throw e;
    }
  },

  setConvUnreadMark: async (convId, marked) => {
    const before = get().conv.summaries[convId]?.markedUnread === true;
    const put = (on: boolean) => {
      const s = get();
      const conv = patchConvUnreadMark(s.conv, convId, on);
      if (conv !== s.conv) set({ conv, dms: summariesToDms(conv.summaries) });
    };
    put(marked);
    // Telegram Desktop (03·3.1.4): пометка открытой беседы «непрочитанной» закрывает её. На телефоне открытая беседа —
    // отдельный экран, а меню строки открывают из списка: закрывать нечего.
    if (marked && get().currentDmId === convId && !isMobile()) set({ currentDmId: null });
    try {
      await api.convSetUnreadMark(convId, marked);
    } catch (e) {
      put(before);
      throw e;
    }
  },

  markConvRead: async (convId) => {
    const s0 = get();
    const sum = s0.conv.summaries[convId];
    if (!sum) return;
    const key = sum.lastMessage?.sortKey;
    const conv = patchConvReadAll(s0.conv, convId);
    if (conv !== s0.conv) set({ conv, dms: summariesToDms(conv.summaries), unreadDms: s0.unreadDms.filter((x) => x !== convId) });
    try {
      // Чтение до последнего сообщения снимает точку на сервере само; пустая беседа с точкой — только снять её.
      if (key !== undefined) await api.convRead(convId, key);
      else await api.convSetUnreadMark(convId, false);
    } catch (e) {
      const s = get();
      const back = { ...s.conv, summaries: { ...s.conv.summaries, [convId]: sum } };
      set({ conv: back, dms: summariesToDms(back.summaries), ...(sum.unread > 0 ? { unreadDms: [...s.unreadDms, convId] } : {}) });
      throw e;
    }
  },

  readAllConvs: async () => {
    const res = await api.convReadAll();
    // Сервер пришлёт каждой беседе событие со сводкой без непрочитанного; до него — гасим у себя, чтобы список не мигал.
    const s = get();
    const conv = patchConvReadAll(s.conv);
    if (conv !== s.conv) set({ conv, dms: summariesToDms(conv.summaries), unreadDms: [] });
    return res.count;
  },

  clearConvHistory: async (convId, scope) => {
    await api.convClear(convId, scope);
  },

  hideConv: async (convId, scope) => {
    await api.convHide(convId, scope);
    if (get().currentDmId === convId) set({ currentDmId: null, mobilePane: 'list' });
  },

  loadServers: async () => {
    const servers = await api.listServers();
    /**
     * Счётчики серверов из того же ответа (12.10, #218, `channelRules.seedServerCounts`): холодный старт сразу со
     * значками, а не после первого события шлюза. Старый бэкенд полей не шлёт — карты остаются как были.
     */
    set((s) => ({
      servers,
      ...seedServerCounts(servers, { unreadServers: s.unreadServers, mentionServers: s.mentionServers }, s.currentServerId),
    }));
    /**
     * Снимок в реестр (§5.7): рейл обязан показывать серверы ЭТОГО инстанса и тогда, когда живой
     * шлюз открыт у другого. Пишется здесь, а не в рейле, потому что здесь единственное место, где
     * список приходит с сервера, — рейл его только рисует.
     */
    const id = activeInstanceId();
    if (id) rememberInstanceServers(id, servers.map((x) => ({ id: x.id, name: x.name, iconUrl: x.iconUrl ?? null })));
  },

  openServer: async (serverId, channelId) => {
    // Идёт запись голосового — сначала спросить (G13, `leaveGuard`); без записи — без ожидания, как раньше.
    const guard = get().leaveGuard;
    if (guard && !(await guard(serverId))) return;
    const bootstrap = await api.getServer(serverId);
    const firstText = bootstrap.channels.find((c) => c.type === 'text') ?? null;
    set((s) => {
      // Сервер открыт — его значок в рейле больше не нужен: непрочитанное теперь видно по каналам,
      // и точные числа приходят из `bootstrap.reads` (сервер помнит их между сессиями).
      const { [serverId]: _u, ...unreadServers } = s.unreadServers;
      const { [serverId]: _m, ...mentionServers } = s.mentionServers;
      return {
        currentServerId: serverId,
        bootstrap,
        currentChannelId: null,
        members: [],
        view: 'server',
        /* Канал закрыт строкой выше — значит, на телефоне перед глазами должен быть СПИСОК каналов (#204). Раньше экран
           оставался тем, что был: открыли сервер, стоя в ленте (окно приглашения поверх переписки, правка канала или
           сервера, которая перечитывает его этим же вызовом), — и человек смотрел на пустое «Выбери канал», пока не
           нажмёт «назад». На ПК и в узком окне браузера ниже сразу откроется первый канал — `openChannel` вернёт `content`. */
        mobilePane: 'list',
        serverListOpen: false,
        unreadServers,
        mentionServers,
        ...seedReads(s, bootstrap, null),
      };
    });
    // Запоминаем сервер сразу (#218): на телефоне канал не открывается, и без этого «последний сервер» не переживал бы перезагрузку —
    // вкладка «Серверы» снова вела бы к списку. Канал дописывает `openChannel`.
    const inst0 = activeInstanceId();
    if (inst0) rememberPlace({ instanceId: inst0, serverId });
    setCustomSounds(bootstrap.sounds);
    setChannelSounds(channelSoundMap(bootstrap.channels));
    void get().loadMembers(serverId);
    // On mobile, land on the channel LIST — don't auto-open the first text channel (that sets
    // mobilePane:'content' and dumps the user into a wall of chat). Desktop opens it (two-pane layout).
    const target = channelId ? (bootstrap.channels.find((c) => c.id === channelId) ?? null) : null;
    if (target) await get().openChannel(target.id);
    else if (firstText && !isMobile()) await get().openChannel(firstText.id);
  },

  // Member roster (with roles + join dates) for the user menu / profile card. Best-effort,
  // non-blocking; ignored if you've since switched servers.
  loadMembers: async (serverId) => {
    try {
      const members = await api.listMembers(serverId);
      if (get().currentServerId === serverId) {
        // Seed the status map from the roster so dots/custom-status render before any live broadcast.
        const statuses = { ...get().userStatuses };
        for (const m of members) statuses[m.user.id] = { status: m.user.status, customStatus: m.user.customStatus };
        set({ members, userStatuses: statuses });
      }
    } catch {
      /* roster is a nicety — never fail the server open over it */
    }
  },

  // Re-fetch the bootstrap in place after a permission/visibility change, WITHOUT jumping
  // channels: keep the open channel if it's still visible, and drop a now-hidden voice
  // connection. Ignored if you've since switched servers.
  refreshBootstrap: async (serverId) => {
    if (get().currentServerId !== serverId) return;
    const bootstrap = await api.getServer(serverId);
    const visible = new Set(bootstrap.channels.map((c) => c.id));
    set((s) => ({
      bootstrap,
      currentChannelId: s.currentChannelId && visible.has(s.currentChannelId) ? s.currentChannelId : null,
      // Голос рвём, только если он НА ЭТОМ сервере этого инстанса: голос на другом сервере (или у соседа, пока
      // смотрим дом) пропал бы от того, что кто-то поправил роль там, где мы просто смотрим.
      voice: dropsVoice(s.voice, serverId, visible) ? null : s.voice,
      liveVoice: dropsVoice(s.voice, serverId, visible) ? {} : s.liveVoice,
      ...seedReads(s, bootstrap, s.currentChannelId),
    }));
    setCustomSounds(bootstrap.sounds);
    setChannelSounds(channelSoundMap(bootstrap.channels));
    void get().loadMembers(serverId);
    // On mobile, DON'T auto-open the first text channel — selecting a server should land on the channel
    // LIST (m-list pane), not dump the user straight into a wall of chat. They pick a channel themselves.
    // Desktop keeps auto-opening it (two-pane layout shows list + content side by side).
    if (!get().currentChannelId && !isMobile()) {
      const firstText = bootstrap.channels.find((c) => c.type === 'text');
      if (firstText) await get().openChannel(firstText.id);
    }
  },

  // Called after the gateway WebSocket RE-connects (e.g. resuming from sleep/hibernation, where the
  // socket went half-open and we missed every message.create). openChannel/selectDm cache messages, so
  // the open view stays stale until we force a re-fetch — do that here, plus refresh the server bootstrap
  // so unread badges for other channels catch up on the events we missed.
  resyncAfterReconnect: async () => {
    const { currentServerId, currentChannelId, currentDmId, bootstrap } = get();
    if (currentChannelId && bootstrap?.channels.find((c) => c.id === currentChannelId)?.type === 'text') {
      try {
        const page = await api.listMessages(currentChannelId);
        // Сливаем, а не заменяем: подгруженная прокруткой история переживает пробуждение (#212).
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [currentChannelId]: mergeLatestPage(s.messagesByChannel[currentChannelId], page),
          },
        }));
      } catch {
        /* keep the cached messages if the refetch fails */
      }
    }
    // ЛС догоняет режим бесед сам — по номеру журнала на `ready` шлюза (`convStore.convOnReady`), без перечитки.
    // Строки серверов (12.10, #218): счётчики и последнее сообщение пропущенного — из свежего `GET /servers`.
    void get().loadServers().catch(() => {});
    if (currentServerId) {
      try {
        await get().refreshBootstrap(currentServerId);
      } catch {
        /* unread badges will catch up on next open */
      }
    }
  },

  /**
   * Подтянуть порцию более старых сообщений канала.
   *
   * 🔴 До 19.09 клиент звал `listMessages` РОВНО ОДИН раз и без курсора: человек видел последние
   * 50 сообщений и упирался в потолок, хотя сервер всё это время умел отдавать историю порциями
   * (`before` + `limit`, `routes/messages.ts`). То есть переписка глубже одного экрана была
   * недостижима — не «медленно», а никак.
   *
   * Возвращает, есть ли смысл просить ещё: пустой ответ или неполная порция означают дно.
   */
  /**
   * Подписка на соседние вкладки (`tabSync.ts`): там прочитали — гасим и у себя.
   *
   * ⚠️ Только гасим. Обратное («у соседа появилось непрочитанное») сюда не идёт: счётчики растут от
   * событий шлюза, и дублировать их через вкладки значило бы считать одно и то же дважды.
   */
  listenTabs: () =>
    onTabEvent((e) => {
      set((s) => {
        if (e.kind === 'read-channel') {
          const { [e.channelId]: _m, ...mentionCounts } = s.mentionCounts;
          const { [e.channelId]: _u, ...unreadCounts } = s.unreadCounts;
          if (!e.serverId) return { mentionCounts, unreadCounts };
          // Значок сервера считается отдельно от каналов — гасим и его, иначе он останется гореть.
          const { [e.serverId]: _su, ...unreadServers } = s.unreadServers;
          const { [e.serverId]: _sm, ...mentionServers } = s.mentionServers;
          return { mentionCounts, unreadCounts, unreadServers, mentionServers };
        }
        return {
          unreadDms: s.unreadDms.filter((x) => x !== e.dmId),
          dms: s.dms.map((d) => (d.id === e.dmId ? { ...d, unread: 0 } : d)),
        };
      });
    }),

  loadOlderMessages: async (channelId) => {
    const cursor = olderCursor(get().messagesByChannel[channelId] ?? []);
    if (!cursor) return false;
    const older = await api.listMessages(channelId, cursor);
    if (older.length === 0) return false;
    set((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: mergeOlderPage(s.messagesByChannel[channelId] ?? [], older),
      },
    }));
    return hasMoreOlder(older);
  },

  /** Порция старше загруженного — режим бесед (`convStore.convLoadOlder`); `false` — дно. */
  loadOlderDmMessages: async (dmId) => (get().convActive ? get().convLoadOlder(dmId) : false),

  /** Открыть беседу: окно ленты, догонка, «прочитано» — режим бесед (`convStore.convOpen`). */
  refreshDmHistory: async (dmId) => {
    // Сервер без бесед (`conv1`+`conv2`) — ЛС нет, вместо списка заглушка «нужно обновить сервер» (09.10).
    if (get().convActive) return get().convOpen(dmId);
  },

  /**
   * 🔴 Уход из ленты = прочитано (20.09, поймано на телефоне).
   *
   * На компьютере лента всегда на экране, поэтому «открыл канал» и «читаю канал» — одно и то же, и
   * гашение счётчика при открытии закрывало вопрос. На телефоне это разные вещи: человек уходит в
   * список, лента остаётся выбранной, и пришедшие сообщения копятся в счётчике, который НЕ виден
   * (значок прячется у «текущего» канала). Вернувшись, он не узнает, что пропустил сотню строк.
   *
   * Поэтому: значок считается по каналу, который ВИДНО (`ChannelSidebar`), а на выходе из ленты
   * счётчик гасится здесь — вместе с отметкой на сервере и сигналом соседним вкладкам.
   */
  readChannelNow: (channelId) => {
    const s0 = get();
    if (!s0.unreadCounts[channelId] && !s0.mentionCounts[channelId]) return;
    const isText = s0.bootstrap?.channels.find((c) => c.id === channelId)?.type === 'text';
    set((s) => {
      const { [channelId]: _clearedM, ...mentionCounts } = s.mentionCounts;
      const { [channelId]: _clearedU, ...unreadCounts } = s.unreadCounts;
      return { unreadCounts, mentionCounts };
    });
    if (isText) void api.markChannelRead(channelId).catch(() => {});
    publishTabEvent({ kind: 'read-channel', channelId, serverId: get().currentServerId ?? undefined });
  },

  /**
   * 🔴 Прочитано на другом СВОЁМ устройстве (20.09). Между вкладками одного браузера это решал
   * `BroadcastChannel` (`tabSync.ts`), между устройствами — только сервер: ручка отметки теперь
   * рассылает `read.channel`/`read.dm` всем моим соединениям.
   *
   * ⚠️ Метку визита (черту «Новые сообщения») двигаем ТОЛЬКО если этой ленты нет на глазах: иначе
   * черта исчезла бы прямо под читающим — он смотрит историю здесь, а телефон в кармане отметил
   * канал прочитанным.
   * ⚠️ Только гасим. Рост счётчиков идёт от событий шлюза; дублировать его отметками значило бы
   * считать одно и то же дважды (тот же довод, что и у согласования вкладок).
   */
  applyRemoteRead: ({ channelId, serverId, at }) => {
    // ЛС: «прочитано» с другого устройства приходит сводкой в `conv.change` (режим бесед) — `read.dm` не нужен.
    if (!channelId) return;
    const s0 = get();
    const onScreen = isFeedOnScreen({
      id: channelId,
      currentId: s0.currentChannelId,
      mobile: isMobile(),
      mobilePane: s0.mobilePane,
      kind: 'channel',
      view: s0.view,
    });
    if (!onScreen) markChannelSeen(channelId, at ? Date.parse(at) : Date.now());
    set((s) => {
      const { [channelId]: _m, ...mentionCounts } = s.mentionCounts;
      const { [channelId]: _u, ...unreadCounts } = s.unreadCounts;
      if (!serverId) return { mentionCounts, unreadCounts };
      const { [serverId]: _sm, ...mentionServers } = s.mentionServers;
      const { [serverId]: _su, ...unreadServers } = s.unreadServers;
      return { mentionCounts, unreadCounts, mentionServers, unreadServers };
    });
  },

  readDmNow: (dmId) => {
    if (!get().convActive) return;
    if (!get().unreadDms.includes(dmId) && !get().conv.summaries[dmId]?.unread) return;
    get().convReadNow(dmId);
    publishTabEvent({ kind: 'read-dm', dmId });
  },

  openChannel: async (channelId) => {
    const guard = get().leaveGuard;
    if (guard && !(await guard(channelId))) return;
    const channel = get().bootstrap?.channels.find((c) => c.id === channelId);
    set((s) => {
      const { [channelId]: _clearedM, ...mentionCounts } = s.mentionCounts;
      const { [channelId]: _clearedU, ...unreadCounts } = s.unreadCounts;
      return {
        currentChannelId: channelId,
        unreadCounts,
        mentionCounts,
        mobilePane: 'content',
        serverListOpen: false,
      };
    });
    // Persist the read mark (migration 0018) — fire-and-forget, unread must never block opening.
    if (channel?.type === 'text') void api.markChannelRead(channelId).catch(() => {});
    // Соседние вкладки гасят у себя тот же счётчик: человек один, прочитано — значит прочитано.
    publishTabEvent({ kind: 'read-channel', channelId, serverId: get().currentServerId ?? undefined });
    // Запоминаем место, чтобы перезагрузка вернула сюда же, а не на «Выбери сервер» (lastPlace.ts).
    const inst = activeInstanceId();
    if (inst) rememberPlace({ instanceId: inst, serverId: get().currentServerId ?? undefined, channelId });
    // Решение «идти ли в сеть и ждать ли ответ» — в `channelRules.historyLoadPlan` (чистое, под
    // тестами); здесь только сам поход. Разбор, почему рефетчим ВСЕГДА, — там же.
    const plan = historyLoadPlan({ channelType: channel?.type, hasCache: !!get().messagesByChannel[channelId] });
    if (plan.refetch) {
      set((s) => (s.historyFailed.includes(channelId) ? { historyFailed: s.historyFailed.filter((x) => x !== channelId) } : s));
      const refetch = api
        .listMessages(channelId)
        // Сливаем с кешем, а не заменяем: подгруженная прокруткой история не пропадает (#212).
        .then((page) =>
          set((s) => ({
            messagesByChannel: { ...s.messagesByChannel, [channelId]: mergeLatestPage(s.messagesByChannel[channelId], page) },
          })),
        )
        .catch(() => {
          // Оффлайн при кеше — остаёмся на нём, следующее открытие догонит. Без кеша — показываем
          // сбой, а не вечные скелетоны (#212, Б5 — у каналов та же дыра, что у ЛС).
          if (!get().messagesByChannel[channelId]) set((s) => ({ historyFailed: [...s.historyFailed, channelId] }));
        });
      if (plan.blocking) await refetch;
    }
  },

  joinVoice: async (channelId) => {
    const prev = get().voice;
    const { url, token } = await api.voiceToken(channelId);
    const s = get();
    const instanceId = activeInstanceId();
    // Канал на открытом сервере — его сервер; нет (перемещение модератором, пока смотрим другой сервер) — прежний.
    const ch = s.bootstrap?.channels.find((c) => c.id === channelId);
    const serverId = ch ? s.currentServerId : (prev?.serverId ?? s.currentServerId);
    const inst = instanceId ? instances().find((i) => i.id === instanceId) : null;
    set({
      voice: {
        channelId,
        url,
        token,
        instanceId,
        serverId,
        channelName: ch?.name ?? (prev?.channelId === channelId ? prev.channelName : 'Голосовой канал'),
        serverName: s.servers.find((x) => x.id === serverId)?.name ?? '',
        instanceName: inst?.name?.trim() || inst?.domain || '',
        self: s.user ? { displayName: s.user.displayName, avatarUrl: s.user.avatarUrl ?? null } : null,
        selfId: s.user?.id ?? null,
      },
    });
    // Голос был на другом инстансе — он закончился (голос всегда один, решение 01.10): его сессию стираем, иначе
    // возврат туда в течение грейса затянул бы обратно в прежний канал.
    if (prev && prev.instanceId !== instanceId) clearVoiceSession(prev.instanceId);
    if (serverId) saveVoiceSession(instanceId, serverId, channelId);
  },

  // Re-mint the LiveKit token for the channel we're in (same channelId) so updated publish
  // grants (e.g. a freshly-granted screen-share permission) take effect — the new token
  // changes voice.token, which makes VoiceConnection reconnect with it.
  refreshVoiceToken: async () => {
    const v = get().voice;
    if (!v) return;
    try {
      // К инстансу ГОЛОСА, а не к тому, что на экране (`voiceApiOf`): после перехода активный — другой.
      const { url, token } = await voiceApiOf(v).voiceToken(v.channelId);
      const cur = get().voice;
      if (!cur || cur.channelId !== v.channelId || cur.instanceId !== v.instanceId) return;
      set({ voice: { ...cur, url, token } });
    } catch {
      /* keep the current connection if the re-mint fails */
    }
  },

  moveVoiceTo: async (channelId) => {
    const v = get().voice;
    if (!v) return;
    const { url, token } = await voiceApiOf(v).voiceToken(channelId);
    const cur = get().voice;
    if (!cur || cur.instanceId !== v.instanceId) return;
    // Снимка того сервера здесь нет — имени канала не знаем, подпись общая до возврата туда.
    set({ voice: { ...cur, channelId, url, token, channelName: 'Голосовой канал' } });
    if (cur.serverId) saveVoiceSession(cur.instanceId, cur.serverId, channelId);
  },

  leaveVoice: (keepSession = false) => {
    const v = get().voice;
    if (!keepSession) clearVoiceSession(v ? v.instanceId : activeInstanceId());
    set({ voice: null, liveVoice: {}, voiceState: 'disconnected' });
  },

  /**
   * Сеть вернулась, а мы вне канала — вернуться туда, откуда выбило.
   *
   * ⚠️ Само наличие сохранённой сессии = обрыв был НЕПРЕДНАМЕРЕННЫМ: свой выход, вход с другого
   * устройства и выключение сервера её стирают, переживает только уход по истёкшему грейсу.
   */
  rejoinVoiceAfterOutage: async () => {
    const sess = rejoinableVoiceSession();
    if (!shouldAutoRejoin({ session: sess, inVoice: !!get().voice, now: Date.now() })) return;
    await get().restoreVoiceSession(sess!);
  },

  restoreVoiceSession: async (session?: VoiceSession) => {
    // Уже в голосе (например, он пережил переход между инстансами) — не перехватывать навигацию и не
    // переподключать живую комнату новым токеном.
    if (get().voice) return;
    const sess = session ?? restorableVoiceSession();
    if (!sess) return;
    if (!get().servers.some((s) => s.id === sess.serverId)) {
      clearVoiceSession();
      return;
    }
    try {
      if (get().currentServerId !== sess.serverId) await get().openServer(sess.serverId);
      const ch = get().bootstrap?.channels.find((c) => c.id === sess.channelId && c.type === 'voice');
      if (!ch) {
        clearVoiceSession();
        return;
      }
      await get().openChannel(sess.channelId);
      await get().joinVoice(sess.channelId);
    } catch {
      clearVoiceSession();
    }
  },

  setLiveVoice: (m) => set({ liveVoice: m }),

  setEconomy: (serverId, view) => set((s) => ({ economy: { ...s.economy, [serverId]: view } })),

  tipHints: [],
  /**
   * ⚠️ Подсказка снимает СЕБЯ по своему `id`, а не «последнюю»: типы прилетают вперемешку, и
   * снятие по времени добавления убирало бы чужую, ещё живую.
   * ⚠️ `pruneTipHints` тут страховкой: если вкладка спала и таймер не отработал, накопленное
   * не всплывёт пачкой при следующем типе.
   */
  pushTipHint: ({ toUserId, fromUserId, fromName, amount }) => {
    const atMs = Date.now();
    const id = `${atMs}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      tipHints: addTipHint(pruneTipHints(s.tipHints, atMs), { id, toUserId, fromUserId, fromName, amount, atMs }),
    }));
    window.setTimeout(() => set((s) => ({ tipHints: s.tipHints.filter((h) => h.id !== id) })), TIP_HINT_MS);
  },

  toastEvents: [],
  /**
   * ⚠️ Имена приходят УЖЕ разрешёнными в ники этого сервера: окно плашки ростера не держит и
   * разрешить их у себя не может (в отличие от строки сайдбара, где резолвер есть под рукой).
   */
  pushToastEvent: ({ kind, fromName, toName, amount }) => {
    const atMs = Date.now();
    const id = `${atMs}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      toastEvents: addToastEvent(pruneToastEvents(s.toastEvents, atMs), { id, kind, fromName, toName, amount, atMs }),
    }));
    window.setTimeout(() => set((s) => ({ toastEvents: s.toastEvents.filter((e) => e.id !== id) })), TOAST_MS);
  },
  // ⚠️ Если снимка ещё нет, пуш игнорируем: он несёт только кошелёк, а без настроек и названия
  // валюты нарисовать всё равно нечего. Снимок придёт загрузкой и будет уже свежим.
  applyWallet: (serverId, w) =>
    set((s) => {
      const cur = s.economy[serverId];
      if (!cur) return {};
      return { economy: { ...s.economy, [serverId]: { ...cur, wallet: { ...cur.wallet, ...w } } } };
    }),

  setVoiceState: (voiceState) => set({ voiceState }),

  setNativeSharing: (nativeSharing) => set({ nativeSharing }),

  // Второй тык, пока висит первый, ЗАМЕЩАЕТ его, а не встаёт в очередь: окон копиться не должно —
  // это ровно тот способ мешать, ради которого на сервере стоит кулдаун.
  showPoke: (incomingPoke) => set({ incomingPoke }),
  dismissPoke: () => set({ incomingPoke: null }),

  setSelfVoice: ({ muted, deafened }) => {
    try {
      localStorage.setItem(SELF_VOICE_KEY, JSON.stringify({ muted, deafened }));
    } catch {
      /* storage unavailable — keep in-memory only */
    }
    set({ selfMuted: muted, selfDeafened: deafened });
  },

  // ----- direct messages -----

  setView: (view) => set({ view }),
  crossReply: null,
  setCrossReply: (crossReply) => set({ crossReply }),
  sharedIn: null,
  setSharedIn: (sharedIn) => set({ sharedIn }),
  fwdDrafts: {},
  setFwdDraft: (convId, draft) =>
    set((s) => {
      if (draft) return { fwdDrafts: { ...s.fwdDrafts, [convId]: draft } };
      if (!(convId in s.fwdDrafts)) return {};
      const next = { ...s.fwdDrafts };
      delete next[convId];
      return { fwdDrafts: next };
    }),
  leaveGuard: null,
  setLeaveGuard: (fn) => {
    set({ leaveGuard: fn });
    return () => {
      if (get().leaveGuard === fn) set({ leaveGuard: null });
    };
  },

  // Сервер без бесед (`conv1`+`conv2`, коробки ≤ 0.8.17): ЛС нет — список показывает заглушку (`DmSidebar`, 09.10).
  loadDms: async () => {
    if (get().convActive) return get().convEnsureList();
  },

  requestMention: (name) =>
    set((s) => ({ mentionRequest: { name, n: (s.mentionRequest?.n ?? 0) + 1 } })),

  setMobilePane: (pane) => set({ mobilePane: pane, mobileMembersOpen: false }),
  setServerListOpen: (open) => set({ serverListOpen: open }),
  openServersTab: (wasActive) => {
    const s0 = get();
    // Повторное нажатие на открытую вкладку, пока смотришь каналы сервера, — к списку серверов (как у Telegram: нажатие на
    // активную вкладку возвращает наверх). Любой другой приход — к каналам последнего сервера.
    const toList = wasActive && s0.mobilePane === 'list' && !!s0.currentServerId && !s0.serverListOpen;
    set({ view: 'server', mobileProfileOpen: false, mobilePane: 'list', mobileMembersOpen: false, serverListOpen: toList });
    if (!s0.currentServerId) {
      // Сервера ещё нет (старт со вкладки «Сообщения», выход из сервера) — берём последний из «где я был» (`lastPlace.ts`), если он ещё в списке.
      const id = lastPlace(activeInstanceId())?.serverId;
      if (id && s0.servers.some((x) => x.id === id)) void get().openServer(id).catch(() => {});
    }
  },
  setMobileMembersOpen: (open) => set({ mobileMembersOpen: open }),
  setMobileProfileOpen: (open) => set({ mobileProfileOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setEconomyWelcomeOpen: (open) => set({ economyWelcomeOpen: open }),
  // Закрытие НЕ сбрасывает `adminInstanceId`: ответ, долетевший после закрытия (сохранили и сразу закрыли), перечитывает
  // своё у дома, а не уходит к соседу гостевым токеном. Сбрасывает следующее открытие и переход.
  setAdminOpen: (open, instanceId = null) => set(open ? { adminOpen: true, adminInstanceId: instanceId } : { adminOpen: false }),
  setSearchOpen: (open) => set({ searchOpen: open }),

  openDmRemote: async (who) => {
    if (!get().convActive) return;
    let id: string;
    try {
      id = await get().convOpenWith(who);
    } catch (e) {
      if (e && typeof e === 'object') (e as { dmOpen?: boolean }).dmOpen = true;
      throw e;
    }
    return get().selectDm(id);
  },

  openDmWith: async (userId) => {
    if (get().convActive) {
      let id: string;
      try {
        id = await get().convOpenWith(userId);
      } catch (e) {
        // Э1 (`fedm1`): отказ дома собеседника другого инстанса — `toastError` скажет причину словами (`fedDmOpenText`).
        if (e && typeof e === 'object') (e as { dmOpen?: boolean }).dmOpen = true;
        throw e;
      }
      return get().selectDm(id);
    }
    // Сервер без бесед: ведём в раздел ЛС, там заглушка «нужно обновить сервер» (`DmSidebar`, 09.10).
    set({ view: 'dm', currentDmId: null, mobilePane: 'list' });
  },


  openSaved: async () => {
    if (!get().convActive) return;
    const id = await get().convOpenSaved();
    if (id) await get().selectDm(id);
  },

  selectDm: async (dmId) => {
    const guard = get().leaveGuard;
    if (guard && !(await guard(dmId))) return;
    /* 🔴 Беседа уже на экране (02.10, стенд 2г, вид телефона): повторный выбор — клик по ней в списке, тап по пушу
       открытой беседы — открывал её заново, а открытие без живого шлюза просит порцию и ЗАМЕНЯЕТ окно под человеком:
       лента теряла подгруженное ниже места и съезжала на десятки пикселей. Лента и так живая (события шлюза или
       догонка) — дочитать и догнать. Окно из кеша или ленты ещё нет — открываем, как раньше. */
    const s0 = get();
    const shown =
      s0.convActive &&
      !!s0.dmMessages[dmId] &&
      !s0.conv.windows[dmId]?.stale &&
      isFeedOnScreen({
        id: dmId,
        currentId: s0.currentDmId,
        mobile: isMobile(),
        mobilePane: s0.mobilePane,
        kind: 'dm',
        view: s0.view,
      });
    set((s) => ({
      view: 'dm',
      currentDmId: dmId,
      unreadDms: s.unreadDms.filter((x) => x !== dmId),
      dms: s.dms.map((d) => (d.id === dmId ? { ...d, unread: 0 } : d)),
      mobilePane: 'content',
    }));
    publishTabEvent({ kind: 'read-dm', dmId });
    const instDm = activeInstanceId();
    if (instDm) rememberPlace({ instanceId: instDm, dmId });
    if (shown) {
      // Повторный клик по открытой беседе — «в конец» (G26, Telegram ПК 03·3.1.2): ведёт сама лента, как кнопка «Вниз».
      set((s) => ({ feedDownAsk: { id: dmId, n: (s.feedDownAsk?.n ?? 0) + 1 } }));
      get().readDmNow(dmId);
      await get()
        .convEnsureList()
        .catch(() => {});
      return;
    }
    await get().refreshDmHistory(dmId);
  },

  appendMessage: (channelId, message) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return s; // channel not loaded yet
      if (list.some((m) => m.id === message.id)) return s;
      return { messagesByChannel: { ...s.messagesByChannel, [channelId]: [...list, message] } };
    }),

  updateMessage: (channelId, message) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return s;
      // message.update (e.g. an edit) carries no per-viewer reactions — keep what we have.
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: list.map((m) => (m.id === message.id ? { ...message, reactions: m.reactions ?? message.reactions } : m)),
        },
      };
    }),

  applyReaction: (channelId, messageId, emoji, userId, op) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return s;
      const mine = userId === s.user?.id;
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: list.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...(m.reactions ?? [])];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            /* Список поставивших (G75, `ReactionGroup.reactors`: сервер отдаёт его группам до трёх человек) ведём вместе с
               числом, пока он у группы есть: аватарки на чипе не отстают от живых событий. У группы без списка (людей больше
               трёх или старый сервер) его и не заводим — чип с числом, как было. Момент постановки — наш, часы сервера не нужны:
               порядок задаёт сам список (новый — в конец). */
            if (op === 'add') {
              const who = { userId, at: new Date().toISOString() };
              if (idx === -1) reactions.push({ emoji, count: 1, me: mine, reactors: [who] });
              else {
                const cur = reactions[idx];
                // Повтор того же человека (эхо своего же события, повтор WS) — не второй голос: число не растёт (Codex R39).
                const dup = cur.reactors?.some((x) => x.userId === userId) || (mine && cur.me);
                if (!dup) {
                  const reactors = cur.reactors ? [...cur.reactors, who] : cur.reactors;
                  reactions[idx] = { ...cur, count: cur.count + 1, me: cur.me || mine, ...(reactors ? { reactors } : {}) };
                }
              }
            } else if (idx !== -1) {
              const cur = reactions[idx];
              const count = cur.count - 1;
              if (count <= 0) reactions.splice(idx, 1);
              else {
                const reactors = cur.reactors?.filter((x) => x.userId !== userId);
                reactions[idx] = { ...cur, count, me: mine ? false : cur.me, ...(reactors ? { reactors } : {}) };
              }
            }
            return { ...m, reactions };
          }),
        },
      };
    }),

  removeMessage: (channelId, messageId) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return s;
      return { messagesByChannel: { ...s.messagesByChannel, [channelId]: list.filter((m) => m.id !== messageId) } };
    }),

  upsertChannel: (channel) =>
    set((s) => {
      if (!s.bootstrap || s.bootstrap.server.id !== channel.serverId) return s;
      const channels = s.bootstrap.channels.filter((c) => c.id !== channel.id);
      channels.push(channel);
      channels.sort((a, b) => a.position - b.position);
      return { bootstrap: { ...s.bootstrap, channels } };
    }),

  deleteChannel: (serverId, channelId) =>
    set((s) => {
      if (!s.bootstrap || s.bootstrap.server.id !== serverId) return s;
      return {
        bootstrap: { ...s.bootstrap, channels: s.bootstrap.channels.filter((c) => c.id !== channelId) },
        currentChannelId: s.currentChannelId === channelId ? null : s.currentChannelId,
      };
    }),

  // Optimistic drag-and-drop: patch category + position for the moved channels so the
  // tree re-renders instantly. The server.invalidate broadcast reconciles authoritatively.
  patchChannels: (updates) =>
    set((s) => {
      if (!s.bootstrap) return s;
      const map = new Map(updates.map((u) => [u.id, u]));
      const channels = s.bootstrap.channels.map((c) => {
        const u = map.get(c.id);
        return u ? { ...c, categoryId: u.categoryId, position: u.position } : c;
      });
      return { bootstrap: { ...s.bootstrap, channels } };
    }),

  // Optimistic custom-sound update: reflect an upload/clear immediately (the badge + the playback
  // resolver), instead of waiting on the server.invalidate round-trip. The broadcast still reconciles.
  patchServerSound: (event, url) =>
    set((s) => {
      if (!s.bootstrap) return s;
      const sounds = { ...(s.bootstrap.sounds ?? {}) };
      if (url) sounds[event] = url;
      else delete sounds[event];
      setCustomSounds(sounds);
      return { bootstrap: { ...s.bootstrap, sounds } };
    }),

  // Optimistic per-channel sound update (the general's panel) — same idea as patchServerSound.
  patchChannelSound: (channelId, event, url) =>
    set((s) => {
      if (!s.bootstrap) return s;
      const channels = s.bootstrap.channels.map((c) => {
        if (c.id !== channelId) return c;
        const sounds = { ...(c.sounds ?? {}) };
        if (url) sounds[event] = url;
        else delete sounds[event];
        return { ...c, sounds };
      });
      setChannelSounds(channelSoundMap(channels));
      return { bootstrap: { ...s.bootstrap, channels } };
    }),

  occupancy: {},
  setPresenceSnapshot: (channels, occupied) => {
    const anchor = performance.now();
    const next: Record<string, Occupancy> = {};
    for (const [id, ms] of Object.entries(occupied)) next[id] = { ms, anchor };
    set({ presence: channels, occupancy: next });
  },
  /**
   * ⚠️ `null` СНИМАЕТ отсчёт: канал опустел (или отметка истекла после grace). Оставь мы старое
   * значение — таймер продолжал бы расти над пустым каналом.
   */
  setOccupancy: (channelId, ms) =>
    set((st) => {
      const occupancy = { ...st.occupancy };
      if (ms === null) delete occupancy[channelId];
      else occupancy[channelId] = { ms, anchor: performance.now() };
      return { occupancy };
    }),

  mergePresence: (channelId, participants) =>
    set((s) => {
      const presence = { ...s.presence };
      if (participants.length === 0) delete presence[channelId];
      else presence[channelId] = participants;
      return { presence };
    }),

  setOnlineSnapshot: (users, dmOnly, dmAway) => set({ onlineUsers: users, dmOnlineUsers: dmOnly ?? [], dmAwayUsers: dmAway ?? [] }),

  setDmAway: (userId, away) =>
    set((s) => ({
      dmAwayUsers: away
        ? s.dmAwayUsers.includes(userId)
          ? s.dmAwayUsers
          : [...s.dmAwayUsers, userId]
        : s.dmAwayUsers.filter((u) => u !== userId),
    })),

  setDmOnline: (userId, online) =>
    set((s) => ({
      dmOnlineUsers: online
        ? s.dmOnlineUsers.includes(userId)
          ? s.dmOnlineUsers
          : [...s.dmOnlineUsers, userId]
        : s.dmOnlineUsers.filter((u) => u !== userId),
    })),

  setOnlineUpdate: (userId, online) =>
    set((s) => ({
      onlineUsers: online
        ? s.onlineUsers.includes(userId)
          ? s.onlineUsers
          : [...s.onlineUsers, userId]
        : s.onlineUsers.filter((u) => u !== userId),
    })),

  applyUserStatus: (userId, status, customStatus) =>
    set((s) => ({
      userStatuses: { ...s.userStatuses, [userId]: { status, customStatus } },
      // Mirror into the open roster so the members list updates without a refetch.
      members: s.members.map((m) => (m.user.id === userId ? { ...m, user: { ...m.user, status, customStatus } } : m)),
      // If it's our own status echoed back, keep the live user object in sync too.
      user: s.user && s.user.id === userId ? { ...s.user, status, customStatus } : s.user,
    })),

  // Свой статус + кто его поставил. Приходит ТОЛЬКО на собственные подключения: без этого второй
  // клиент видит «отошёл», но не знает, что его можно снять активностью, и держит жёлтый значок у
  // активного человека вечно (#118).
  applySelfStatus: (status, statusAuto) =>
    set((s) => (s.user ? { user: { ...s.user, status, statusAuto } } : {})),

  // Game activity (#40): a single user's activity changed (or cleared with null).
  applyUserActivity: (userId, activity) =>
    set((s) => {
      const next = { ...s.userActivities };
      if (activity) next[userId] = activity;
      else delete next[userId];
      return { userActivities: next };
    }),
  // Full snapshot from GET /users/activities (on gateway connect / reconnect).
  setActivities: (activities) => set({ userActivities: activities }),

  // A user changed their display name / avatar (gateway user.update). Patch every place that
  // snapshots their name/avatar — the member list (right column), chat + DM message authors, and
  // the DM conversation list — so it updates live for everyone, no re-login. (Voice tiles refresh
  // separately via LiveKit participant metadata.)
  /**
   * Ник участника изменился (#19). В отличие от `applyUserProfile` правка СЕРВЕРНАЯ: список
   * участников открыт только для одного сервера за раз, поэтому чужой сервер трогать нечем и
   * незачем — на нём человек остаётся под обычным именем.
   */
  /** Общее число проголосовавших — приходит всем, распределение не раскрывает. */
  applyPollVoters: (channelId, messageId, voters) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return {};
      let touched = false;
      const next = list.map((m) => {
        if (m.id !== messageId || !m.poll) return m;
        touched = true;
        return { ...m, poll: { ...m.poll, voters } };
      });
      return touched ? { messagesByChannel: { ...s.messagesByChannel, [channelId]: next } } : {};
    }),

  // Открытые стримы и их личные настройки звука. Сцена голосового канала только МЕНЯЕТ это
  // состояние; применяет его к трекам единственное место — `VoiceConnection` (#71).
  watchStream: (id) => set((s) => (s.watchedStreams.includes(id) ? {} : { watchedStreams: [...s.watchedStreams, id] })),

  unwatchStream: (id) => set((s) => ({ watchedStreams: s.watchedStreams.filter((x) => x !== id) })),

  /** Сцена ушла с экрана или голос отключён — открытых стримов больше нет, а значит и звука. */
  clearWatchedStreams: () => set((s) => (s.watchedStreams.length === 0 ? {} : { watchedStreams: [] })),

  setPendingWatch: (pendingWatch) => set({ pendingWatch }),
  noteAccessClosed: (n) =>
    set((s) => ({ closedServers: { ...s.closedServers, [n.serverId]: n }, accessNotice: n })),
  clearAccessNotice: () => set((s) => (s.accessNotice === null ? {} : { accessNotice: null })),
  bumpFederationRev: () => set((s) => ({ federationRev: s.federationRev + 1 })),
  bumpGuestLinksRev: () => set((s) => ({ guestLinksRev: s.guestLinksRev + 1 })),

  switchedInstance: () => {
    // Звуки сервера — ссылки на файлы ПРЕЖНЕГО инстанса: оставь их, и новый сервер зазвучит чужими.
    setCustomSounds({});
    setChannelSounds({});
    // Беседы прежнего инстанса: идущая догонка обрывается, признаки и режим решаются заново в `bootstrap`.
    get().convReset();
    set((s) => ({
      serverFeatures: null,
      convActive: false,
      convCacheKey: null,
      // У цели есть вход — человек остаётся на экране до `setAuth` нового инстанса (без экрана загрузки и формы
      // входа, 01.10); входа нет — `null`, впереди экран входа, как раньше.
      user: getToken() ? s.user : null,
      servers: [],
      currentServerId: null,
      bootstrap: null,
      currentChannelId: null,
      messagesByChannel: {},
      // Черновики каналов прежнего инстанса — чужие каналы: в новом им не место (и id там другие).
      channelDrafts: {},
      members: [],
      presence: {},
      onlineUsers: [],
      dmOnlineUsers: [],
      dmAwayUsers: [],
      userStatuses: {},
      userActivities: {},
      unreadCounts: {},
      mentionCounts: {},
      unreadServers: {},
      mentionServers: {},
      occupancy: {},
      // Голос НЕ трогаем (01.10): он принадлежит своему инстансу (`voice.instanceId`) и идёт, пока человек смотрит
      // другой — как в Discord. Рвёт его только выход, вход в другой канал или потеря записи.
      economy: {},
      incomingPoke: null,
      watchedStreams: [],
      mutedStreams: [],
      // Громкости стримов лежат ПО ИНСТАНСУ — перечитываем под уже переключённую запись.
      streamVolumes: readStreamVolumes(),
      pendingWatch: null,
      closedServers: {},
      accessNotice: null,
      tipHints: [],
      toastEvents: [],
      view: 'server',
      dms: [],
      currentDmId: null,
      dmMessages: {},
      historyFailed: [],
      unreadDms: [],
      pushMutedServers: [],
      pushMutedDmUsers: [],
      pushMuteUntil: {},
      pushAlwaysTargets: [],
      blockedUsers: [],
      mentionRequest: null,
      // Окна прежнего инстанса закрываем: настройки сервера, админка и поиск говорили о том, чего
      // здесь уже нет.
      settingsOpen: false,
      adminOpen: false,
      adminInstanceId: null,
      searchOpen: false,
      mobileMembersOpen: false,
      mobileProfileOpen: false,
      mobilePane: 'list',
      instanceEpoch: s.instanceEpoch + 1,
      switching: true,
    }));
  },
  clearAccessClosed: (serverId) =>
    set((s) => {
      if (!(serverId in s.closedServers)) return {};
      const { [serverId]: _gone, ...rest } = s.closedServers;
      return { closedServers: rest, accessNotice: s.accessNotice?.serverId === serverId ? null : s.accessNotice };
    }),
  clearPendingWatch: () => set((s) => (s.pendingWatch === null ? {} : { pendingWatch: null })),

  enterVoiceChannel: async (channelId) => {
    // Уже подключены сюда — только показать канал. Повторный `joinVoice` выпросил бы новый токен
    // и порвал живое соединение: человек вылетел бы из разговора ровно по клику «смотреть».
    if (get().voice?.channelId !== channelId) await get().joinVoice(channelId);
    await get().openChannel(channelId);
  },

  toggleStreamMute: (id) =>
    set((s) => ({
      mutedStreams: s.mutedStreams.includes(id) ? s.mutedStreams.filter((x) => x !== id) : [...s.mutedStreams, id],
    })),

  setStreamVolume: (id, raw) =>
    set((s) => {
      // Приводим ЗДЕСЬ, а не в ползунке: значение приезжает ещё и из localStorage с прошлых
      // запусков, а там может лежать что угодно, включая громкости, записанные другой версией.
      const v = clampStreamVolume(raw);
      const streamVolumes = { ...s.streamVolumes, [id]: v };
      try {
        scopedSetItem(STREAM_VOLUMES_KEY, JSON.stringify(streamVolumes));
      } catch {
        /* ignore */
      }
      // Двинули ползунок вверх — значит хотят слышать: снимаем заглушение, иначе ползунок «не работает».
      return { streamVolumes, mutedStreams: v > 0 ? s.mutedStreams.filter((x) => x !== id) : s.mutedStreams };
    }),

  /**
   * Заменить опрос целиком — ответом на СВОЁ голосование.
   *
   * 🔴 Без этого карточка после голоса не меняется вовсе (#70). Сервер отвечает свежим опросом с
   * `myVotes` и `revealed`, но ответ выбрасывался, а WS-события их намеренно не несут:
   * `poll.update` — только число проголосовавших, `poll.counts` — только счётчики. Оба правы,
   * и вместе они не дают того единственного, что переключает карточку в «я проголосовал».
   */
  applyPoll: (channelId, messageId, poll) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return {};
      let touched = false;
      const next = list.map((m) => {
        if (m.id !== messageId || !m.poll) return m;
        touched = true;
        return { ...m, poll };
      });
      return touched ? { messagesByChannel: { ...s.messagesByChannel, [channelId]: next } } : {};
    }),

  /**
   * Счётчики по вариантам — приходят АДРЕСНО тем, кто уже голосовал. `myVotes` и `revealed` не
   * трогаем: их источник — ответ на собственное голосование (`applyPoll`), а не чужое.
   */
  applyPollCounts: (channelId, messageId, options) =>
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return {};
      let touched = false;
      const next = list.map((m) => {
        if (m.id !== messageId || !m.poll) return m;
        touched = true;
        const byId = new Map(options.map((o) => [o.id, o.votes]));
        return {
          ...m,
          poll: { ...m.poll, options: m.poll.options.map((o) => ({ ...o, votes: byId.get(o.id) ?? o.votes })) },
        };
      });
      return touched ? { messagesByChannel: { ...s.messagesByChannel, [channelId]: next } } : {};
    }),

  applyMemberNickname: (serverId, userId, nickname) =>
    set((s) => {
      if (s.currentServerId !== serverId) return {}; // открыт другой сервер — списка этого нет в памяти
      return {
        members: s.members.map((m) => (m.user.id === userId ? { ...m, nickname } : m)),
      };
    }),

  /**
   * Профиль человека изменился где-то ещё — событие `user.update`.
   *
   * 🔴 `animatedAvatarUrl` тут появился 06.09 (#129), и он не мелочь: анимированный аватар ВСЕ
   * поверхности читают из ростера (`useAnimatedAvatarUrl` смотрит в `members`), в отличие от
   * статичного — тот на плитках голоса приезжает метаданными LiveKit и обновляется сам. Пока поля
   * не было, чужая покупка не появлялась ни у кого до полного перезахода на сервер.
   *
   * ⚠️ У автора сообщения анимации нет в типе вовсе, поэтому в переписке правим только имя и
   * статичный аватар — это не упущение, а форма данных.
   */
  applyUserProfile: (userId, displayName, avatarUrl, animatedAvatarUrl) =>
    // Сам разнос — в чистом `profilePatch.ts` под тестами: копий профиля пять, и #129 родился на
    // том, что одна осталась в стороне. Здесь остаётся только тонкая обёртка над стором.
    set((s) => {
      const patched = applyUserProfilePatch(
        {
          members: s.members,
          messagesByChannel: s.messagesByChannel,
          dmMessages: s.dmMessages,
          dms: s.dms,
          user: s.user,
        },
        { userId, displayName, avatarUrl, animatedAvatarUrl },
      );
      // Режим бесед: список ЛС собирается из сводок — собеседника правим и в них (`convSyncRules.patchPeer`).
      const conv = patchPeer(s.conv, userId, displayName, avatarUrl);
      return conv === s.conv ? patched : { ...patched, conv };
    }),

  // Само правило — в `channelRules.applyUnread` (чистое, под тестами): куда лечь счётчику, решает
  // оно, а стор только отдаёт ему состояние.
  markUnread: (channelId, mentioned = false, serverId) =>
    set((s) => applyUnread(s, { channelId, serverId, mentioned, currentServerId: s.currentServerId })),
}));
