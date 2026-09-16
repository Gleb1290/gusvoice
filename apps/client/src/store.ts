import type {
  Channel,
  CustomStatus,
  DmChannel,
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
import { api, setToken, type PushMuteScope } from './api';
import { applyUnread, historyLoadPlan, seedReads } from './channelRules';
import type { EconomyView } from './economy';
import { isMobile } from './hotkeys';
import { stopPushRegistration } from './nativeUnifiedPush';
import { setChannelSounds, setCustomSounds } from './sounds';
import { addTipHint, pruneTipHints, TIP_HINT_MS, type TipHint } from './tipHints';
import { addToastEvent, pruneToastEvents, TOAST_MS, type ToastEvent, type ToastKind } from './toastRules';
import type { Occupancy } from './occupancy';
import type { PendingWatch } from './pendingWatch';
import { applyUserProfilePatch } from './profilePatch';
import { scopedGetItem, scopedSetItem } from './instanceScope';
import { clampStreamVolume, loadStreamVolumes } from './streamAudioRules';
import { shouldAutoRejoin } from './voiceCueRules';
import { clearVoiceSession, rejoinableVoiceSession, restorableVoiceSession, saveVoiceSession, type VoiceSession } from './voiceSession';

/** Per-channel sound overrides from the bootstrap, keyed channelId → {event: url} (drops empties). */
function channelSoundMap(channels: { id: string; sounds?: Record<string, string> }[]): Record<string, Record<string, string>> {
  const m: Record<string, Record<string, string>> = {};
  for (const c of channels) if (c.sounds && Object.keys(c.sounds).length) m[c.id] = c.sounds;
  return m;
}

/** Sort conversations by most-recent activity (lastMessageAt, else createdAt). */
const byRecent = (a: DmChannel, b: DmChannel) =>
  (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt);

interface VoiceConnection {
  channelId: string;
  url: string;
  token: string;
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

interface State {
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

  // direct messages
  view: AppView;
  dms: DmChannel[];
  currentDmId: string | null;
  /** Bumped by requestMention; the active composer inserts `@name` once per new value. */
  mentionRequest: { name: string; n: number } | null;
  /** Mobile-only: which pane is on screen (list of channels/DMs, or the open chat/voice). */
  mobilePane: 'list' | 'content';
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
  /** Whether the message-search modal is open (lifted so the Ctrl+F shortcut can open it). */
  searchOpen: boolean;
  dmMessages: Record<string, Message[]>;
  unreadDms: string[];

  /** Account-wide push-mute sets (loaded on boot). Suppress phone pushes from a server's @mentions
   *  or a person's DMs — in-app delivery is unaffected. Edited via context menus. */
  pushMutedServers: string[];
  pushMutedDmUsers: string[];

  setAuth: (user: User) => void;
  logout: () => void;
  loadPushMutes: () => Promise<void>;
  /** Optimistically toggle a push-mute (server or dm_user); reverts + rethrows on API failure. */
  setPushMuted: (scope: PushMuteScope, targetId: string, muted: boolean) => Promise<void>;
  loadServers: () => Promise<void>;
  openServer: (serverId: string) => Promise<void>;
  refreshBootstrap: (serverId: string) => Promise<void>;
  resyncAfterReconnect: () => Promise<void>;
  patchServerSound: (event: string, url: string | null) => void;
  patchChannelSound: (channelId: string, event: string, url: string | null) => void;
  loadMembers: (serverId: string) => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  joinVoice: (channelId: string) => Promise<void>;
  refreshVoiceToken: () => Promise<void>;
  /** keepSession: don't clear the persisted voice session — used by the reconnect-grace visual leave so
   *  a restart within the grace window auto-rejoins (#11). A user-initiated leave clears it. */
  leaveVoice: (keepSession?: boolean) => void;
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
  requestMention: (name: string) => void;
  setMobilePane: (pane: 'list' | 'content') => void;
  setMobileMembersOpen: (open: boolean) => void;
  setMobileProfileOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setEconomyWelcomeOpen: (open: boolean) => void;
  setAdminOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  selectDm: (dmId: string) => Promise<void>;
  upsertDm: (channel: DmChannel) => void;
  appendDmMessage: (dmId: string, message: Message) => void;
  updateDmMessage: (dmId: string, message: Message) => void;
  removeDmMessage: (dmId: string, messageId: string) => void;
  markDmUnread: (dmId: string) => void;

  // socket-driven mutations
  appendMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, message: Message) => void;
  applyReaction: (channelId: string, messageId: string, emoji: string, userId: string, op: 'add' | 'remove') => void;
  applyDmReaction: (dmId: string, messageId: string, emoji: string, userId: string, op: 'add' | 'remove') => void;
  removeMessage: (channelId: string, messageId: string) => void;
  upsertChannel: (channel: Channel) => void;
  deleteChannel: (serverId: string, channelId: string) => void;
  patchChannels: (updates: { id: string; categoryId: string | null; position: number }[]) => void;
  setPresenceSnapshot: (channels: PresenceMap, occupied: Record<string, number>) => void;
  /** Сколько каждый видимый канал занят — сервер говорит один раз, клиент досчитывает сам. */
  occupancy: Record<string, Occupancy>;
  setOccupancy: (channelId: string, ms: number | null) => void;
  mergePresence: (channelId: string, participants: VoiceParticipant[]) => void;
  setOnlineSnapshot: (users: string[]) => void;
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

  view: 'server',
  dms: [],
  currentDmId: null,
  mentionRequest: null,
  mobilePane: 'list',
  mobileMembersOpen: false,
  mobileProfileOpen: false,
  settingsOpen: false,
  economyWelcomeOpen: false,
  adminOpen: false,
  searchOpen: false,
  dmMessages: {},
  unreadDms: [],
  pushMutedServers: [],
  pushMutedDmUsers: [],

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
    // Clear the persisted auth token + voice session, else App.tsx's boot effect
    // re-authenticates from the stored gv_token on the reload that follows logout()
    // (the button "did nothing" — it reloaded straight back into the app).
    setToken(null);
    clearVoiceSession();
    setCustomSounds({});
    setChannelSounds({});
    set({
      user: null,
      servers: [],
      currentServerId: null,
      bootstrap: null,
      currentChannelId: null,
      messagesByChannel: {},
      members: [],
      presence: {},
      onlineUsers: [],
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
      unreadDms: [],
      pushMutedServers: [],
      pushMutedDmUsers: [],
    });
  },

  loadPushMutes: async () => {
    try {
      const mutes = await api.listPushMutes();
      set({
        pushMutedServers: mutes.filter((m) => m.scope === 'server').map((m) => m.targetId),
        pushMutedDmUsers: mutes.filter((m) => m.scope === 'dm_user').map((m) => m.targetId),
      });
    } catch {
      /* push mutes are a nicety — never block boot over them */
    }
  },

  setPushMuted: async (scope, targetId, muted) => {
    const key = scope === 'server' ? 'pushMutedServers' : 'pushMutedDmUsers';
    const prev = get()[key];
    const next = muted ? [...new Set([...prev, targetId])] : prev.filter((x) => x !== targetId);
    set({ [key]: next } as Pick<State, typeof key>);
    try {
      if (muted) await api.setPushMute(scope, targetId);
      else await api.removePushMute(scope, targetId);
    } catch (e) {
      set({ [key]: prev } as Pick<State, typeof key>); // revert on failure
      throw e;
    }
  },

  loadServers: async () => {
    const servers = await api.listServers();
    set({ servers });
  },

  openServer: async (serverId) => {
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
        unreadServers,
        mentionServers,
        ...seedReads(s, bootstrap, null),
      };
    });
    setCustomSounds(bootstrap.sounds);
    setChannelSounds(channelSoundMap(bootstrap.channels));
    void get().loadMembers(serverId);
    // On mobile, land on the channel LIST — don't auto-open the first text channel (that sets
    // mobilePane:'content' and dumps the user into a wall of chat). Desktop opens it (two-pane layout).
    if (firstText && !isMobile()) await get().openChannel(firstText.id);
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
      voice: s.voice && !visible.has(s.voice.channelId) ? null : s.voice,
      liveVoice: s.voice && !visible.has(s.voice.channelId) ? {} : s.liveVoice,
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
        const messages = await api.listMessages(currentChannelId);
        set((s) => ({ messagesByChannel: { ...s.messagesByChannel, [currentChannelId]: messages } }));
      } catch {
        /* keep the cached messages if the refetch fails */
      }
    }
    if (currentDmId) {
      try {
        const messages = await api.listDmMessages(currentDmId);
        set((s) => ({ dmMessages: { ...s.dmMessages, [currentDmId]: messages } }));
      } catch {
        /* keep cache */
      }
    }
    if (currentServerId) {
      try {
        await get().refreshBootstrap(currentServerId);
      } catch {
        /* unread badges will catch up on next open */
      }
    }
  },

  openChannel: async (channelId) => {
    const channel = get().bootstrap?.channels.find((c) => c.id === channelId);
    set((s) => {
      const { [channelId]: _clearedM, ...mentionCounts } = s.mentionCounts;
      const { [channelId]: _clearedU, ...unreadCounts } = s.unreadCounts;
      return {
        currentChannelId: channelId,
        unreadCounts,
        mentionCounts,
        mobilePane: 'content',
      };
    });
    // Persist the read mark (migration 0018) — fire-and-forget, unread must never block opening.
    if (channel?.type === 'text') void api.markChannelRead(channelId).catch(() => {});
    // Решение «идти ли в сеть и ждать ли ответ» — в `channelRules.historyLoadPlan` (чистое, под
    // тестами); здесь только сам поход. Разбор, почему рефетчим ВСЕГДА, — там же.
    const plan = historyLoadPlan({ channelType: channel?.type, hasCache: !!get().messagesByChannel[channelId] });
    if (plan.refetch) {
      const refetch = api
        .listMessages(channelId)
        .then((messages) => set((s) => ({ messagesByChannel: { ...s.messagesByChannel, [channelId]: messages } })))
        .catch(() => {
          /* оффлайн — остаёмся на кеше, следующее открытие догонит */
        });
      if (plan.blocking) await refetch;
    }
  },

  joinVoice: async (channelId) => {
    const { url, token } = await api.voiceToken(channelId);
    set({ voice: { channelId, url, token } });
    const serverId = get().currentServerId;
    if (serverId) saveVoiceSession(serverId, channelId);
  },

  // Re-mint the LiveKit token for the channel we're in (same channelId) so updated publish
  // grants (e.g. a freshly-granted screen-share permission) take effect — the new token
  // changes voice.token, which makes VoiceConnection reconnect with it.
  refreshVoiceToken: async () => {
    const v = get().voice;
    if (!v) return;
    try {
      const { url, token } = await api.voiceToken(v.channelId);
      set({ voice: { channelId: v.channelId, url, token } });
    } catch {
      /* keep the current connection if the re-mint fails */
    }
  },

  leaveVoice: (keepSession = false) => {
    if (!keepSession) clearVoiceSession();
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

  loadDms: async () => {
    const dms = await api.listDms();
    dms.sort(byRecent);
    // Seed persisted unread (server-side dm_reads) — the open conversation stays read.
    set((s) => ({ dms, unreadDms: dms.filter((d) => (d.unread ?? 0) > 0 && d.id !== s.currentDmId).map((d) => d.id) }));
  },

  requestMention: (name) =>
    set((s) => ({ mentionRequest: { name, n: (s.mentionRequest?.n ?? 0) + 1 } })),

  setMobilePane: (pane) => set({ mobilePane: pane, mobileMembersOpen: false }),
  setMobileMembersOpen: (open) => set({ mobileMembersOpen: open }),
  setMobileProfileOpen: (open) => set({ mobileProfileOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setEconomyWelcomeOpen: (open) => set({ economyWelcomeOpen: open }),
  setAdminOpen: (open) => set({ adminOpen: open }),
  setSearchOpen: (open) => set({ searchOpen: open }),

  openDmWith: async (userId) => {
    const dm = await api.openDm(userId);
    get().upsertDm(dm);
    set((s) => ({
      view: 'dm',
      currentDmId: dm.id,
      unreadDms: s.unreadDms.filter((x) => x !== dm.id),
      // Гасим и счётчик: он теперь виден числом, а не точкой, и без этого остался бы висеть.
      dms: s.dms.map((d) => (d.id === dm.id ? { ...d, unread: 0 } : d)),
      mobilePane: 'content',
    }));
    void api.markDmRead(dm.id).catch(() => {});
    if (!get().dmMessages[dm.id]) {
      const messages = await api.listDmMessages(dm.id);
      set((s) => ({ dmMessages: { ...s.dmMessages, [dm.id]: messages } }));
    }
  },

  selectDm: async (dmId) => {
    set((s) => ({
      view: 'dm',
      currentDmId: dmId,
      unreadDms: s.unreadDms.filter((x) => x !== dmId),
      dms: s.dms.map((d) => (d.id === dmId ? { ...d, unread: 0 } : d)),
      mobilePane: 'content',
    }));
    void api.markDmRead(dmId).catch(() => {});
    if (!get().dmMessages[dmId]) {
      const messages = await api.listDmMessages(dmId);
      set((s) => ({ dmMessages: { ...s.dmMessages, [dmId]: messages } }));
    }
  },

  upsertDm: (channel) =>
    set((s) => {
      const dms = [channel, ...s.dms.filter((d) => d.id !== channel.id)].sort(byRecent);
      return { dms };
    }),

  appendDmMessage: (dmId, message) =>
    set((s) => {
      const list = s.dmMessages[dmId];
      const dmMessages =
        list && !list.some((m) => m.id === message.id)
          ? { ...s.dmMessages, [dmId]: [...list, message] }
          : s.dmMessages;
      // Bump the conversation's recency so the list re-sorts.
      const dms = s.dms.map((d) => (d.id === dmId ? { ...d, lastMessageAt: message.createdAt } : d)).sort(byRecent);
      return { dmMessages, dms };
    }),

  updateDmMessage: (dmId, message) =>
    set((s) => {
      const list = s.dmMessages[dmId];
      if (!list) return s;
      return { dmMessages: { ...s.dmMessages, [dmId]: list.map((m) => (m.id === message.id ? message : m)) } };
    }),

  removeDmMessage: (dmId, messageId) =>
    set((s) => {
      const list = s.dmMessages[dmId];
      if (!list) return s;
      return { dmMessages: { ...s.dmMessages, [dmId]: list.filter((m) => m.id !== messageId) } };
    }),

  /**
   * Входящее сообщение в НЕ открытый диалог. Копим не только флаг, но и счётчик: список ЛС теперь
   * показывает число, а не точку, и без инкремента он застывал бы на том значении, что приехало с
   * сервера при загрузке списка («1» весь вечер, сколько бы ни написали).
   */
  markDmUnread: (dmId) =>
    set((s) => ({
      unreadDms: s.unreadDms.includes(dmId) ? s.unreadDms : [...s.unreadDms, dmId],
      dms: s.dms.map((d) => (d.id === dmId ? { ...d, unread: (d.unread ?? 0) + 1 } : d)),
    })),

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
            if (op === 'add') {
              if (idx === -1) reactions.push({ emoji, count: 1, me: mine });
              else reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, me: reactions[idx].me || mine };
            } else if (idx !== -1) {
              const count = reactions[idx].count - 1;
              if (count <= 0) reactions.splice(idx, 1);
              else reactions[idx] = { ...reactions[idx], count, me: mine ? false : reactions[idx].me };
            }
            return { ...m, reactions };
          }),
        },
      };
    }),

  applyDmReaction: (dmId, messageId, emoji, userId, op) =>
    set((s) => {
      const list = s.dmMessages[dmId];
      if (!list) return s;
      const mine = userId === s.user?.id;
      return {
        dmMessages: {
          ...s.dmMessages,
          [dmId]: list.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...(m.reactions ?? [])];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            if (op === 'add') {
              if (idx === -1) reactions.push({ emoji, count: 1, me: mine });
              else reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, me: reactions[idx].me || mine };
            } else if (idx !== -1) {
              const count = reactions[idx].count - 1;
              if (count <= 0) reactions.splice(idx, 1);
              else reactions[idx] = { ...reactions[idx], count, me: mine ? false : reactions[idx].me };
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

  setOnlineSnapshot: (users) => set({ onlineUsers: users }),

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
    set((s) =>
      applyUserProfilePatch(
        {
          members: s.members,
          messagesByChannel: s.messagesByChannel,
          dmMessages: s.dmMessages,
          dms: s.dms,
          user: s.user,
        },
        { userId, displayName, avatarUrl, animatedAvatarUrl },
      ),
    ),

  // Само правило — в `channelRules.applyUnread` (чистое, под тестами): куда лечь счётчику, решает
  // оно, а стор только отдаёт ему состояние.
  markUnread: (channelId, mentioned = false, serverId) =>
    set((s) => applyUnread(s, { channelId, serverId, mentioned, currentServerId: s.currentServerId })),
}));
