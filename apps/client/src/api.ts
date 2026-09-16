import type {
  EconomyPreview,
  EconomySettingsDto,
  EconomySummary,
  EconomyView,
  Leaderboard,
  LedgerEntry,
  RetroPreview,
  ShopEntry,
  UserEconomyCard,
} from './economy';
import type {
  AdminServer,
  AdminUser,
  Attachment,
  AuditLogEntry,
  AuthResponse,
  BackupCodesResponse,
  BanInfo,
  AdminInstanceSettings,
  InstanceUpdateInfo,
  Channel,
  Category,
  DmChannel,
  GameActivity,
  InstanceInfo,
  Invite,
  Message,
  PermissionOverwrite,
  Poll,
  PollVoters,
  PresenceStatus,
  RegisterResponse,
  RegistrationPolicy,
  Role,
  Server,
  ServerBootstrap,
  ServerEmoji,
  ServerMemberInfo,
  SetupStatus,
  SmtpSettings,
  TotpRequiredResponse,
  TotpSetupResponse,
  User,
  VoiceTestToken,
  VoiceTokenResponse,
} from '@gusvoice/shared';
import { activeInstance, config, updateActiveInstance } from './config';

/** A push-mute source: 'server' suppresses a server's @mention pushes; 'dm_user' a person's DM pushes. */
export type PushMuteScope = 'server' | 'dm_user';
export interface PushMute {
  scope: PushMuteScope;
  targetId: string;
}

/**
 * Сэмпл саундборда (#21): кнопка в сетке.
 *
 * ⚠️ `url` публичный — в том же бакете, что и звуки событий. Приватного в сэмпле нет по
 * определению: его слышит весь голосовой канал.
 */
export interface SoundboardClip {
  id: string;
  name: string;
  url: string;
  /**
   * 🔴 Действующая цена В МОНЕТАХ, посчитанная сервером: своя у звука хранится в монетах, общая
   * приезжает из каталога в минутах, и перевод делает сервер. Клиент не должен ни знать ставку, ни
   * уметь переводить: две реализации одного перевода разошлись бы на округлении — человек увидел
   * бы одно, а списалось бы другое.
   */
  priceCoins: number;
  /** Справочно: во сколько минут сидения обходится эта цена сегодня. */
  priceMinutes: number;
  /** `null` — своей цены нет, действует общая. Нужно панели управления, а не пикеру. */
  ownPriceCoins: number | null;
}

// Token of the ACTIVE instance (#7). The registry is the source of truth; the legacy gv_token key is
// kept mirrored for safety. On an instance switch the app restarts, so this module re-reads the new
// active instance's token at load.
let token: string | null = activeInstance()?.token ?? localStorage.getItem('gv_token');

export function getToken(): string | null {
  return token;
}
export function setToken(t: string | null): void {
  token = t;
  // Write into the active instance's record; keep the legacy mirror so any stray reader still works.
  updateActiveInstance({ token: t });
  try {
    if (t) localStorage.setItem('gv_token', t);
    else localStorage.removeItem('gv_token');
  } catch {
    /* storage unavailable */
  }
}

/**
 * Продление сессии: бэкенд кладёт свежий токен в `x-refresh-token`, если старому больше суток.
 * Так «протух» означает «неделю не заходил», а не «неделя с момента входа» — раньше людей,
 * сидящих в приложении каждый день, всё равно выкидывало.
 *
 * Заголовок кросс-доменный, поэтому он читается только благодаря `exposedHeaders` на бэкенде.
 * Если продление вдруг перестанет работать — проверять надо там, а не здесь.
 */
function absorbRefresh(res: Response): void {
  const fresh = res.headers.get('x-refresh-token');
  if (fresh && fresh !== token) setToken(fresh);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiUrl}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorbRefresh(res);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Attach the HTTP status so callers can tell a genuine auth failure (401 → log out) from a
    // transient network/5xx blip (e.g. backend mid-deploy → keep the session, retry).
    const err = new Error((data as { error?: string }).error || `HTTP ${res.status}`) as Error & {
      status?: number;
      reason?: string;
    };
    err.status = res.status;
    // ⚠️ Машинная причина отказа, если сервер её прислал. Текст предназначен человеку и меняется;
    // ветвиться по нему в коде — значит однажды сломаться от правки формулировки.
    err.reason = (data as { reason?: string }).reason;
    throw err;
  }
  return data as T;
}

export const api = {
  register: (username: string, email: string, password: string, displayName?: string, inviteCode?: string) =>
    req<RegisterResponse>('POST', '/auth/register', { username, email, password, displayName, inviteCode }),
  verify: (identifier: string, code: string) => req<AuthResponse>('POST', '/auth/verify', { identifier, code }),
  resend: (identifier: string) => req<{ status: string }>('POST', '/auth/resend', { identifier }),
  login: (username: string, password: string) =>
    req<AuthResponse | TotpRequiredResponse>('POST', '/auth/login', { username, password }),
  // UnifiedPush device registration (Android push — see nativeUnifiedPush.ts). Backend upserts per (user,device).
  registerPush: (endpoint: string, deviceId: string) =>
    req<void>('POST', '/push/register', { endpoint, deviceId, platform: 'android' }),
  unregisterPush: (deviceId: string) => req<void>('POST', '/push/unregister', { deviceId }),
  // Push-mute rules (account-wide push suppression: a server's @mentions or a person's DMs).
  listPushMutes: () => req<PushMute[]>('GET', '/push/mutes'),
  setPushMute: (scope: PushMuteScope, targetId: string) => req<void>('POST', '/push/mute', { scope, targetId }),
  removePushMute: (scope: PushMuteScope, targetId: string) => req<void>('DELETE', '/push/mute', { scope, targetId }),
  loginTotp: (challenge: string, code: string) =>
    req<AuthResponse>('POST', '/auth/login/totp', { challenge, code }),
  me: () => req<User>('GET', '/auth/me'),
  updateProfile: (body: { displayName?: string; showGameActivity?: boolean; economyWelcomeSeen?: true }) =>
    req<User>('PATCH', '/users/me', body),
  // Steam link (#40 Phase 1B): get the OpenID redirect URL (client navigates to it), or unlink.
  steamLinkUrl: () => req<{ url: string }>('POST', '/users/me/steam/link-url'),
  steamUnlink: () => req<User>('DELETE', '/users/me/steam'),
  setStatus: (body: {
    status?: PresenceStatus;
    /**
     * Смену делает автоматика (авто-«отошёл»), а не человек. ⚠️ Запрос БЕЗ этого поля считается
     * ручным и снимает признак на сервере — так и надо: ручной статус автоматика больше не трогает
     * (#118).
     */
    auto?: boolean;
    customStatus?: { emoji: string | null; text: string | null; clearAfterMinutes: number | null } | null;
  }) => req<User>('PATCH', '/users/me/status', body),
  // Game activity (#40): report what I'm playing (`game: null` clears it); fetch everyone's snapshot.
  setActivity: (game: GameActivity | null) => req<{ ok: true }>('PATCH', '/users/me/activity', { game }),
  getActivities: () => req<{ activities: Record<string, GameActivity> }>('GET', '/users/activities'),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true; token: string }>('POST', '/auth/password', { currentPassword, newPassword }),
  // Revokes every other session (token-generation bump); returns a fresh token for THIS device.
  logoutAll: (password: string) => req<{ token: string }>('POST', '/auth/logout-all', { password }),
  forgotPassword: (email: string) => req<{ status: string }>('POST', '/auth/password/forgot', { email }),
  resetPassword: (identifier: string, code: string, newPassword: string) =>
    req<{ status: string }>('POST', '/auth/password/reset', { identifier, code, newPassword }),
  changeEmail: (newEmail: string, password: string) => req<User>('POST', '/auth/email', { newEmail, password }),
  deleteAccount: (password: string) => req<{ ok: true }>('POST', '/auth/delete', { password }),
  twoFactorSetup: () => req<TotpSetupResponse>('POST', '/auth/2fa/setup'),
  twoFactorEnable: (code: string) => req<BackupCodesResponse>('POST', '/auth/2fa/enable', { code }),
  twoFactorDisable: (password: string, code: string) =>
    req<{ user: User }>('POST', '/auth/2fa/disable', { password, code }),
  twoFactorRegenerateBackup: (code: string) =>
    req<BackupCodesResponse>('POST', '/auth/2fa/backup/regenerate', { code }),
  uploadAvatar: async (file: File): Promise<User> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/users/me/avatar`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as User;
  },

  /** Свой ник в пределах сервера (#19). Чужие ники не меняются — только свой. */
  setNickname: (serverId: string, nickname: string | null) =>
    req<{ nickname: string | null }>('PATCH', `/servers/${serverId}/nickname`, { nickname }),

  /** Создать опрос (#17) — это сообщение особого вида, возвращается как обычное. */
  createPoll: (
    channelId: string,
    body: { question: string; options: string[]; multi: boolean; anonymous: boolean; hours: number },
  ) => req<Message>('POST', `/channels/${channelId}/polls`, body),
  /** Проголосовать. Голос один и окончательный — переголосовать нельзя. */
  votePoll: (channelId: string, messageId: string, optionIds: string[]) =>
    req<Poll>('POST', `/channels/${channelId}/messages/${messageId}/poll/vote`, { optionIds }),
  /** Кто за что проголосовал — только публичный опрос и только после своего голоса. */
  pollVoters: (channelId: string, messageId: string) =>
    req<PollVoters[]>('GET', `/channels/${channelId}/messages/${messageId}/poll/voters`),

  listServers: () => req<Server[]>('GET', '/servers'),
  createServer: (name: string) => req<ServerBootstrap>('POST', '/servers', { name }),
  getServer: (id: string) => req<ServerBootstrap>('GET', `/servers/${id}`),
  updateServer: (serverId: string, body: { name?: string; iconUrl?: string | null }) =>
    req<Server>('PATCH', `/servers/${serverId}`, body),
  deleteServer: (serverId: string) => req<void>('DELETE', `/servers/${serverId}`),

  /** Иконка сервера (#74). Убрать — это `updateServer(id, { iconUrl: null })`, отдельного роута нет. */
  uploadServerIcon: async (serverId: string, file: File): Promise<Server> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/servers/${serverId}/icon`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Server;
  },

  uploadServerSound: async (serverId: string, event: string, file: File): Promise<{ event: string; url: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/servers/${serverId}/sounds/${event}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { event: string; url: string };
  },
  deleteServerSound: (serverId: string, event: string) =>
    req<void>('DELETE', `/servers/${serverId}/sounds/${event}`),

  /** Кастомные эмодзи сервера (#18). Имя — в query, чтобы не зависеть от порядка частей multipart. */
  uploadServerEmoji: async (serverId: string, name: string, file: File): Promise<ServerEmoji> => {
    const fd = new FormData();
    fd.append('file', file);
    const q = new URLSearchParams({ name });
    const res = await fetch(`${config.apiUrl}/api/servers/${serverId}/emojis?${q}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as ServerEmoji;
  },
  deleteServerEmoji: (serverId: string, emojiId: string) =>
    req<void>('DELETE', `/servers/${serverId}/emojis/${emojiId}`),

  /** Наборы стикеров из Telegram (#68). `name` — ссылка t.me/addstickers/… либо голое имя набора. */
  importStickerPack: (serverId: string, name: string) =>
    req<{ id: string; name: string; title: string; count: number; skipped: number }>(
      'POST',
      `/servers/${serverId}/sticker-packs`,
      { name },
    ),
  deleteStickerPack: (serverId: string, packId: string) =>
    req<void>('DELETE', `/servers/${serverId}/sticker-packs/${packId}`),

  // Channel "general" + per-channel sound overrides.
  setChannelGeneral: (channelId: string, userId: string | null) =>
    req<{ ok: true }>('PUT', `/channels/${channelId}/general`, { userId }),
  /** Купить награду «себе» (анимированный аватар). Адресные и канальные — своими маршрутами. */
  buySelfItem: (serverId: string, item: string) =>
    req<{ spent: number; balance: number }>('POST', `/servers/${serverId}/shop/${item}/buy`),
  /** Снять анимацию, оставив обычный аватар. Право покупки не отбирается. */
  clearAnimatedAvatar: () => req<User>('DELETE', '/users/me/avatar/animated'),
  uploadAnimatedAvatar: async (file: File): Promise<User> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/users/me/avatar/animated`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as User;
  },
  /**
   * Забрать пойманного гуся.
   * ⚠️ Отказ несёт `reason` — по нему клиент решает, гасить подсказку молча или показать сожаление.
   */
  claimGoose: (serverId: string, offerId: string) =>
    req<{ bonus: number; balance: number }>('POST', `/servers/${serverId}/economy/goose/${offerId}`),
  /** Баланс и уровень ЧУЖОГО человека для карточки профиля; `null`, если показывать нечего. */
  userEconomy: (serverId: string, userId: string) =>
    req<{ card: UserEconomyCard | null }>('GET', `/servers/${serverId}/economy/user/${userId}`),
  // ─── Саундборд (#21) ───────────────────────────────────────────────────────────────────────
  /**
   * Список сэмплов И действующие пределы.
   * ⚠️ Пределы приезжают с сервера, а не повторяются здесь константами: длительность проверяет
   * клиент, размер и число — сервер, и разъехавшиеся числа выглядели бы капризом, а не ошибкой.
   */
  listSoundboard: (serverId: string) =>
    req<{
      clips: SoundboardClip[];
      max: number;
      maxBytes: number;
      maxSeconds: number;
      defaultPriceCoins: number;
      maxPriceCoins: number;
    }>('GET', `/servers/${serverId}/soundboard`),
  deleteSoundboardClip: (serverId: string, clipId: string) =>
    req<void>('DELETE', `/servers/${serverId}/soundboard/${clipId}`),
  /**
   * Поменять цену звука. `null` — вернуть на общую цену каталога.
   * ⚠️ `null` и `0` — РАЗНОЕ: ноль это «даром», и владелец должен уметь поставить его осознанно.
   */
  setSoundboardPrice: (serverId: string, clipId: string, priceCoins: number | null) =>
    req<{ ok: true }>('PATCH', `/servers/${serverId}/soundboard/${clipId}`, { priceCoins }),
  /**
   * Выстрелить сэмплом в голосовой канал. Списывает монеты — отказ приходит текстом для человека.
   * ⚠️ Ничего не проигрывает сама: звук придёт СОБЫТИЕМ по сокету, тем же, что и всем остальным.
   * Иначе стреляющий слышал бы свой выстрел дважды или раньше других.
   */
  fireSoundboard: (channelId: string, clipId: string) =>
    req<{ spent: number; balance: number }>('POST', `/channels/${channelId}/soundboard/${clipId}`),
  uploadSoundboardClip: async (
    serverId: string,
    name: string,
    file: File,
    priceCoins?: number | null,
  ): Promise<SoundboardClip> => {
    const fd = new FormData();
    // ⚠️ Имя и цена ПЕРЕД файлом: fastify-multipart отдаёт поля, разобранные до файла, и поле после
    // него в `file.fields` уже не попадёт.
    fd.append('name', name);
    if (priceCoins !== null && priceCoins !== undefined) fd.append('price', String(priceCoins));
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/servers/${serverId}/soundboard`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as SoundboardClip;
  },
  uploadChannelSound: async (channelId: string, event: string, file: File): Promise<{ event: string; url: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/channels/${channelId}/sounds/${event}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { event: string; url: string };
  },
  deleteChannelSound: (channelId: string, event: string) =>
    req<void>('DELETE', `/channels/${channelId}/sounds/${event}`),

  createCategory: (serverId: string, name: string) =>
    req<Category>('POST', `/servers/${serverId}/categories`, { name }),
  updateCategory: (categoryId: string, name: string) =>
    req<Category>('PATCH', `/categories/${categoryId}`, { name }),
  reorderCategories: (serverId: string, items: { categoryId: string; position: number }[]) =>
    req<void>('PUT', `/servers/${serverId}/categories/reorder`, { items }),
  deleteCategory: (categoryId: string) => req<void>('DELETE', `/categories/${categoryId}`),
  createChannel: (serverId: string, name: string, type: 'text' | 'voice', categoryId?: string | null) =>
    req<Channel>('POST', `/servers/${serverId}/channels`, { name, type, categoryId }),
  updateChannel: (
    channelId: string,
    body: {
      name?: string;
      topic?: string | null;
      categoryId?: string | null;
      syncedToCategory?: boolean;
      icon?: string | null;
      /** Качество звука голосового канала в кбит/с (#101); null = умолчание. */
      voiceBitrate?: number | null;
    },
  ) => req<Channel>('PATCH', `/channels/${channelId}`, body),
  deleteChannel: (channelId: string) => req<void>('DELETE', `/channels/${channelId}`),
  reorderChannels: (
    serverId: string,
    items: { channelId: string; categoryId: string | null; position: number }[],
  ) => req<void>('PUT', `/servers/${serverId}/channels/reorder`, { items }),

  listChannelOverwrites: (channelId: string) =>
    req<PermissionOverwrite[]>('GET', `/channels/${channelId}/overwrites`),
  setChannelOverwrite: (channelId: string, o: PermissionOverwrite) =>
    req<void>('PUT', `/channels/${channelId}/overwrites/${o.targetType}/${o.targetId}`, { allow: o.allow, deny: o.deny }),
  deleteChannelOverwrite: (channelId: string, targetType: string, targetId: string) =>
    req<void>('DELETE', `/channels/${channelId}/overwrites/${targetType}/${targetId}`),

  listCategoryOverwrites: (categoryId: string) =>
    req<PermissionOverwrite[]>('GET', `/categories/${categoryId}/overwrites`),
  setCategoryOverwrite: (categoryId: string, o: PermissionOverwrite) =>
    req<void>('PUT', `/categories/${categoryId}/overwrites/${o.targetType}/${o.targetId}`, {
      allow: o.allow,
      deny: o.deny,
    }),
  deleteCategoryOverwrite: (categoryId: string, targetType: string, targetId: string) =>
    req<void>('DELETE', `/categories/${categoryId}/overwrites/${targetType}/${targetId}`),

  listMessages: (channelId: string, before?: string) =>
    req<Message[]>('GET', `/channels/${channelId}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  sendMessage: (
    channelId: string,
    content: string,
    attachments: Attachment[] = [],
    replyToId?: string | null,
    stickerId?: string | null,
  ) => req<Message>('POST', `/channels/${channelId}/messages`, { content, attachments, replyToId, stickerId }),
  editMessage: (channelId: string, messageId: string, content: string) =>
    req<Message>('PATCH', `/channels/${channelId}/messages/${messageId}`, { content }),
  deleteMessage: (channelId: string, messageId: string) =>
    req<void>('DELETE', `/channels/${channelId}/messages/${messageId}`),
  react: (channelId: string, messageId: string, emoji: string, op: 'add' | 'remove') =>
    req<void>('POST', `/channels/${channelId}/messages/${messageId}/reactions`, { emoji, op }),
  reactDm: (dmId: string, messageId: string, emoji: string, op: 'add' | 'remove') =>
    req<void>('POST', `/dm/${dmId}/messages/${messageId}/reactions`, { emoji, op }),
  pinMessage: (channelId: string, messageId: string) =>
    req<Message>('PUT', `/channels/${channelId}/messages/${messageId}/pin`),
  unpinMessage: (channelId: string, messageId: string) =>
    req<Message>('DELETE', `/channels/${channelId}/messages/${messageId}/pin`),
  listPins: (channelId: string) => req<Message[]>('GET', `/channels/${channelId}/pins`),
  uploadAttachment: async (channelId: string, file: File): Promise<Attachment> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Attachment;
  },
  uploadChannelIcon: async (channelId: string, file: File): Promise<Channel> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/channels/${channelId}/icon`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Channel;
  },

  listRoles: (serverId: string) => req<Role[]>('GET', `/servers/${serverId}/roles`),
  createRole: (serverId: string, body: { name: string; color?: number; permissions?: string; mentionable?: boolean }) =>
    req<Role>('POST', `/servers/${serverId}/roles`, body),
  updateRole: (
    roleId: string,
    body: {
      name?: string;
      color?: number;
      permissions?: string;
      hoist?: boolean;
      position?: number;
      mentionable?: boolean;
      membersCanAssign?: boolean;
    },
  ) => req<Role>('PATCH', `/roles/${roleId}`, body),
  deleteRole: (roleId: string) => req<void>('DELETE', `/roles/${roleId}`),
  reorderRoles: (serverId: string, order: string[]) => req<void>('PUT', `/servers/${serverId}/roles/reorder`, { order }),

  listAudit: (serverId: string, before?: string) =>
    req<AuditLogEntry[]>('GET', `/servers/${serverId}/audit${before ? `?before=${encodeURIComponent(before)}` : ''}`),

  searchMessages: (serverId: string, q: string, channelId?: string) =>
    req<Message[]>(
      'GET',
      `/servers/${serverId}/search?q=${encodeURIComponent(q)}${channelId ? `&channelId=${channelId}` : ''}`,
    ),

  listMembers: (serverId: string) => req<ServerMemberInfo[]>('GET', `/servers/${serverId}/members`),
  /** Покинуть сервер по своей воле (#92). Владельцу нельзя — сначала передать владение. */
  leaveServer: (serverId: string) => req<void>('POST', `/servers/${serverId}/leave`),
  /** Отчёт диагностики показа экрана (#100) — уходит на сервер по кнопке, читается там psql. */
  sendDiagReport: (body: unknown) => req<{ ok: boolean }>('POST', '/diag/report', body),
  kickMember: (serverId: string, userId: string) => req<void>('DELETE', `/servers/${serverId}/members/${userId}`),
  banMember: (serverId: string, userId: string, reason?: string) =>
    req<void>('POST', `/servers/${serverId}/members/${userId}/ban`, { reason }),
  listBans: (serverId: string) => req<BanInfo[]>('GET', `/servers/${serverId}/bans`),
  unbanMember: (serverId: string, userId: string) => req<void>('DELETE', `/servers/${serverId}/bans/${userId}`),
  transferOwnership: (serverId: string, newOwnerId: string) =>
    req<void>('POST', `/servers/${serverId}/transfer`, { newOwnerId }),
  assignRole: (serverId: string, userId: string, roleId: string) =>
    req<void>('PUT', `/servers/${serverId}/members/${userId}/roles/${roleId}`),
  unassignRole: (serverId: string, userId: string, roleId: string) =>
    req<void>('DELETE', `/servers/${serverId}/members/${userId}/roles/${roleId}`),

  voiceToken: (channelId: string) => req<VoiceTokenResponse>('POST', `/channels/${channelId}/voice/token`),
  // Companion token for a native (desktop) screen share — same { url, token, room } shape.
  voiceScreenToken: (channelId: string) =>
    req<VoiceTokenResponse>('POST', `/channels/${channelId}/voice/screen-token`),
  voiceMute: (channelId: string, userId: string, muted: boolean) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/mute`, { muted }),
  voiceDisconnect: (channelId: string, userId: string) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/disconnect`),
  voiceMove: (channelId: string, userId: string, toChannelId: string) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/move`, { toChannelId }),
  /** «Ткнуть» человека, сидящего в голосовом канале. Пустое сообщение допустимо. */
  voicePoke: (channelId: string, userId: string, message: string) =>
    req<void>('POST', `/channels/${channelId}/voice/${userId}/poke`, { message }),
  /** Удалить все свои отчёты диагностики (#113). Возвращает, сколько удалено. */
  deleteMyDiag: () => req<{ deleted: number }>('DELETE', '/diag/mine'),

  // ─── Экономика: ГусКоины (#117) ──────────────────────────────────────────────────────────────
  /** Настройки + мой кошелёк. `settings` приходит только тому, кто может их менять. */
  /**
   * Настройки экономики + мой кошелёк.
   *
   * ⚠️ Когда экономика на инстансе выключена (`ECONOMY_ENABLED=false`), маршрута на бэкенде НЕТ —
   * ходить туда незачем. Гейт стоит НЕ здесь, а в `economyClient.ensureEconomy`, и решает его
   * `economyVisible` по живому полю профиля: здешняя проверка опиралась на сохранённый флаг
   * инстанса, который не обновляется с момента добавления сервера, и в десктопе намертво отрезала
   * экономику, включённую позже (04.09). Панель настроек ходит сюда только из своей вкладки, а её
   * показ гейтится тем же правилом.
   */
  getEconomy: (serverId: string) => req<EconomyView>('GET', `/servers/${serverId}/economy`),
  /** Покрутить ползунки (MANAGE_ECONOMY). */
  saveEconomy: (serverId: string, patch: Partial<EconomySettingsDto>) =>
    req<EconomySettingsDto>('PATCH', `/servers/${serverId}/economy`, patch),
  /**
   * Сколько заработали бы люди за последнюю неделю ПРИ ЭТИХ настройках.
   *
   * Считается той же функцией, что и начисление, — иначе панель обещала бы одно, а начислялось бы
   * другое, и доверия к ней больше не будет.
   */
  previewEconomy: (serverId: string, patch: Partial<EconomySettingsDto>) =>
    req<EconomyPreview>('POST', `/servers/${serverId}/economy/preview`, patch),
  /** Ретроначисление за сухой прогон — один раз за всю жизнь сервера. */
  grantRetro: (serverId: string) =>
    req<{ granted: number; people: number; skipped: number }>('POST', `/servers/${serverId}/economy/retro`),

  /** Что ретро выдаст, если нажать сейчас. Ничего не меняет — обязательный шаг перед выдачей. */
  previewRetro: (serverId: string) => req<RetroPreview>('POST', `/servers/${serverId}/economy/retro/preview`),
  /** Не участвовать в экономике: не копить и не попадать в таблицу лидеров. */
  /**
   * Мои переключатели экономики на сервере. Два РАЗНЫХ (#122): «не участвовать» останавливает и
   * начисление, «не принимать типы» — только входящие, заработок при этом идёт.
   */
  setEconomyOptOut: (serverId: string, patch: { optedOut?: boolean; tipsOptOut?: boolean }) =>
    req<{ optedOut: boolean; tipsOptOut: boolean }>('PATCH', `/servers/${serverId}/economy/me`, patch),
  /** Мои настройки участника на сервере (только свои — чужие не раскрываем). */
  getMyMember: (serverId: string) => req<{ pokesOptOut: boolean }>('GET', `/servers/${serverId}/members/me`),
  /** Принимать ли тычки на этом сервере. Решение человека, не владельца. */
  setPokesOptOut: (serverId: string, pokesOptOut: boolean) =>
    req<{ pokesOptOut: boolean }>('PATCH', `/servers/${serverId}/members/me/pokes`, { pokesOptOut }),
  /** Мои последние операции — ответ на «было 500, стало 300». */
  /** Купить награду и применить её к человеку в этом канале (МЕГА пок). */
  buyForUser: (channelId: string, userId: string, item: string, message?: string) =>
    req<{ spent: number; balance: number }>('POST', `/channels/${channelId}/voice/${userId}/buy`, { item, message }),

  /** Цена и доступность позиции каталога (MANAGE_ECONOMY). */
  /** `priceMinutes: null` — снять свою цену сервера и вернуться к умолчанию (у аватара — к цене инстанса). */
  setShopItem: (serverId: string, item: string, patch: { priceMinutes?: number | null; enabled?: boolean }) =>
    req<{ shop: ShopEntry[] }>('PATCH', `/servers/${serverId}/shop/${item}`, patch),

  /** Сезонная таблица лидеров + корона. Доступна любому участнику: это витрина, а не настройки. */
  getLeaderboard: (serverId: string) => req<Leaderboard>('GET', `/servers/${serverId}/economy/leaderboard`),

  /**
   * Свой журнал. Без периода — последние 20 (это «что было только что», а не архив).
   * ⚠️ Границу периода считает СЕРВЕР: у сезона она зависит от разбивки сервера, и клиент,
   * посчитавший её сам, разошёлся бы с сервером ровно на стыке сезонов.
   */
  getEconomyLedger: (serverId: string, period?: 'week' | 'month' | 'season') =>
    req<LedgerEntry[]>('GET', `/servers/${serverId}/economy/ledger${period ? `?period=${period}` : ''}`),

  /** Сводка за сутки + сверка журнала с балансами (MANAGE_ECONOMY). */
  getEconomySummary: (serverId: string) => req<EconomySummary>('GET', `/servers/${serverId}/economy/summary`),
  /** Загрузить иконку валюты. Проверки (тип, размер, анимация) — на сервере, в `checkCoinIcon`. */
  uploadCoinIcon: async (serverId: string, file: File): Promise<{ iconUrl: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/servers/${serverId}/economy/icon`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { iconUrl: string };
  },
  /** Типнуть человека, сидящего с тобой в канале. Сумму назначает сервер, не клиент. */
  tip: (channelId: string, userId: string) =>
    req<{ debited: number; credited: number; burned: number }>('POST', `/channels/${channelId}/voice/${userId}/tip`),
  /** Отдать СВОЙ свежий кадр показа (#115). Картинка — data-URL, правила в `shared/streamPreview`. */
  putStreamPreview: (channelId: string, image: string) =>
    req<void>('PUT', `/channels/${channelId}/voice/preview`, { image }),
  /** Взять чужое превью показа. 404 — превью нет (человек не показывает или выключил отдачу). */
  getStreamPreview: (channelId: string, userId: string) =>
    req<{ image: string }>('GET', `/channels/${channelId}/voice/preview/${userId}`),

  // --- direct messages ---
  listDms: () => req<DmChannel[]>('GET', '/dm'),
  openDm: (userId: string) => req<DmChannel>('POST', '/dm', { userId }),
  listDmMessages: (dmId: string, before?: string) =>
    req<Message[]>('GET', `/dm/${dmId}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  sendDmMessage: (dmId: string, content: string, attachments: Attachment[] = [], replyToId?: string | null) =>
    req<Message>('POST', `/dm/${dmId}/messages`, { content, attachments, replyToId }),
  editDmMessage: (dmId: string, messageId: string, content: string) =>
    req<Message>('PATCH', `/dm/${dmId}/messages/${messageId}`, { content }),
  deleteDmMessage: (dmId: string, messageId: string) => req<void>('DELETE', `/dm/${dmId}/messages/${messageId}`),
  uploadDmAttachment: async (dmId: string, file: File): Promise<Attachment> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/dm/${dmId}/attachments`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as Attachment;
  },

  createInvite: (serverId: string, opts?: { expiresInMinutes?: number | null; maxUses?: number | null }) =>
    req<Invite>('POST', `/servers/${serverId}/invites`, opts ?? {}),
  listInvites: (serverId: string) => req<Invite[]>('GET', `/servers/${serverId}/invites`),
  deleteInvite: (code: string) => req<void>('DELETE', `/invites/${code}`),
  acceptInvite: (code: string) => req<ServerBootstrap>('POST', `/invites/${code}`),

  // --- desktop installer download (public; reads the updater feed server-side) ---
  latestDownload: () => req<{ version: string; windows: string }>('GET', '/download/latest'),
  downloadWindowsUrl: () => `${config.apiUrl}/api/download/windows`,

  // --- Android F-Droid install info (AUTHED — the add-URL carries the repo's basic-auth creds, so it
  //     must not live in the public bundle; the backend hands it out only to logged-in users). ---
  fdroidInfo: () =>
    req<{ repoUrl: string; fingerprint: string; addUrl: string; qr: string }>('GET', '/app/fdroid'),
  /** Карточка ссылки (#64). Бэкенд отвечает 204, когда карточки нет — тогда получаем null. */
  linkPreview: (url: string) =>
    req<{ url: string; title: string | null; description: string | null; siteName: string | null } | null>(
      'GET',
      `/link-preview?url=${encodeURIComponent(url)}`,
    ),

  // --- persisted read marks (migration 0018) ---
  markChannelRead: (channelId: string) => req<{ ok: true }>('POST', `/channels/${channelId}/read`),
  markDmRead: (dmId: string) => req<{ ok: true }>('POST', `/dm/${dmId}/read`),

  // Force-download URL for a chat attachment: the backend streams the MinIO object with
  // Content-Disposition: attachment (the <a download> attribute is a no-op cross-origin).
  attachmentDownloadUrl: (a: Attachment): string => {
    const m = a.url.match(/\/(attachments\/[A-Za-z0-9._-]+)$/);
    return m
      ? `${config.apiUrl}/api/download/attachment?key=${encodeURIComponent(m[1])}&name=${encodeURIComponent(a.name)}`
      : a.url;
  },

  // --- admin (super-admin only) ---
  /**
   * Инстанс-ручки экономики. Сейчас одна — цена анимированного аватара В МИНУТАХ сидения.
   * ⚠️ Именно инстанса, а не сервера: аватар единственная награда, расходующая хранилище и трафик
   * постоянно, и платит за них держатель железа.
   */
  adminEconomy: () =>
    req<{
      avatarPriceMinutes: number;
      maxMinutes: number;
      stats: {
        windowDays: number;
        people: number;
        userDays: number;
        hours: number;
        avgSitMinutes: number;
        avgEarnMinutes: number;
        avgGooseMinutes: number;
      };
    }>('GET', '/admin/economy'),
  adminSetEconomy: (avatarPriceMinutes: number) =>
    req<{ ok: true; avatarPriceMinutes: number }>('PUT', '/admin/economy', { avatarPriceMinutes }),
  adminUsers: () => req<AdminUser[]>('GET', '/admin/users'),
  adminServers: () => req<AdminServer[]>('GET', '/admin/servers'),
  adminSetCreateServers: (userId: string, canCreateServers: boolean) =>
    req<AdminUser>('PATCH', `/admin/users/${userId}`, { canCreateServers }),
  adminVerifyUser: (userId: string) => req<AdminUser>('POST', `/admin/users/${userId}/verify`),
  adminDeleteUser: (userId: string) => req<{ ok: boolean }>('DELETE', `/admin/users/${userId}`),
  adminGetSmtp: () => req<SmtpSettings>('GET', '/admin/smtp'),
  adminSetSmtp: (s: { host: string; port: number; secure: boolean; user: string; pass?: string; from: string }) =>
    req<{ ok: boolean; cleared?: boolean }>('PUT', '/admin/smtp', s),
  adminTestSmtp: (to: string) => req<{ ok: boolean }>('POST', '/admin/smtp/test', { to }),

  // ---- Инстанс и мастер первичной настройки (#142) ----------------------------------------------
  /** Публично, без входа: название, иконка, политика регистрации. */
  instance: () => req<InstanceInfo>('GET', '/instance'),
  setupStatus: () => req<SetupStatus>('GET', '/setup/status'),
  setupCheckToken: (token: string) => req<void>('POST', '/setup/check-token', { token }),
  setupAdmin: (b: { token: string; username: string; email: string; password: string; displayName?: string }) =>
    req<AuthResponse>('POST', '/setup/admin', b),
  setupComplete: () => req<{ ok: boolean }>('POST', '/setup/complete'),
  setupVoiceTest: () => req<VoiceTestToken>('POST', '/setup/voice-test'),
  adminInstance: () => req<AdminInstanceSettings>('GET', '/admin/instance'),
  adminSetInstance: (b: { name?: string | null; registration?: RegistrationPolicy }) =>
    req<{ ok: boolean }>('PUT', '/admin/instance', b),
  adminDeleteInstanceIcon: () => req<{ ok: boolean }>('DELETE', '/admin/instance/icon'),
  adminInstanceUpdate: (refresh = false) =>
    req<InstanceUpdateInfo>('GET', `/admin/instance/update${refresh ? '?refresh=1' : ''}`),
  adminStartInstanceUpdate: (version: string) => req<{ ok: boolean }>('POST', '/admin/instance/update', { version }),
  adminUploadInstanceIcon: async (file: File): Promise<{ iconUrl: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${config.apiUrl}/api/admin/instance/icon`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    absorbRefresh(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { iconUrl: string };
  },
};
