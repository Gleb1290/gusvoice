/**
 * Провод гостей (#139, F3, план §5.5): токен личности, карточка приглашения, гостевая сессия.
 *
 * Здесь три разговора, и участники у них РАЗНЫЕ — это и определило формат:
 *  - **токен личности** выпускает дом человека, а читает хост. Дом ручается: «это наш человек, вот
 *    его профиль, токен годен две минуты и только для тебя»;
 *  - **карточка приглашения** идёт от хоста к дому (подписанным GET), а дом пересказывает её своему
 *    клиенту — чтобы адрес человека не ушёл к чужому инстансу до его согласия (§4.2.1);
 *  - **гостевая сессия** — ответ хоста: обычный токен хоста, которым гость дальше живёт сам по себе.
 *
 * 🔴 Профиль человека едет ВНУТРИ токена личности, а не берётся из каталога. Скрытого от соседей в
 * каталоге нет вовсе (§5.2.1), но войти по ссылке он вправе — и хосту тогда неоткуда узнать его ник
 * и аватар. Класть их в токен значит: за профиль ручается дом своей подписью, а хост не ходит
 * никуда лишний раз в момент входа.
 *
 * ⚠️ Правки — только добавлением (`docs/federation-compat.md`): неизвестное поле сосед постарше
 * обязан молча пропустить.
 */

import { FED_FIELD_LIMITS, fedDisplayText, fedHash, fedId, fedJti, fedUsername } from './fieldRules';

/**
 * Сколько живёт токен личности.
 *
 * 🔴 Две минуты, а не час: этим токеном можно ОДИН раз назваться на хосте, и всё время его жизни он
 * пригоден для повторного использования тем, кто его перехватил. Ровно столько же живёт подпись
 * запроса (§5.1) — разнобой в сроках здесь означал бы, что где-то одна из двух защит слабее.
 */
export const FED_IDENTITY_TTL_MS = 120_000;

/** Допуск часов для токена личности — тот же, что у подписей запросов. */
export const FED_IDENTITY_SKEW_MS = 60_000;

/**
 * Что дом рассказывает хосту о своём человеке.
 *
 * `gen` — поколение сессий дома (§5.6.1). Хост запоминает его на теневой строке: нажали «выйти
 * везде» — все гостевые сессии со старым поколением мертвы, а новая заводится только токеном со
 * свежим. Без этого поля «выйти везде» кончалось бы на границе своего инстанса.
 */
export interface FedIdentityClaims {
  /** Кто ручается — `instance_id` дома. */
  iss: string;
  /** За кого ручается — `user_id` в пространстве ДОМА. */
  sub: string;
  /** Кому предъявляется — `instance_id` хоста. Токен для другого хоста не годится. */
  aud: string;
  /** Когда выпущен и до каких пор годен (мс эпохи, часы дома). */
  iat: number;
  exp: number;
  /** Одноразовая метка: хост помнит её и второй раз тот же токен не принимает. */
  jti: string;
  /** Поколение сессий на доме (§5.6.1). */
  gen: number;
  /** Профиль — чтобы хост завёл теневую строку, не спрашивая каталог (см. шапку). */
  username: string;
  displayName: string;
  avatarHash: string | null;
}

export function serializeIdentityClaims(c: FedIdentityClaims): Record<string, unknown> {
  return {
    iss: c.iss,
    sub: c.sub,
    aud: c.aud,
    iat: c.iat,
    exp: c.exp,
    jti: c.jti,
    gen: c.gen,
    username: c.username,
    display_name: c.displayName,
    avatar_hash: c.avatarHash,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Разобрать содержимое токена личности. Подпись проверяется отдельно — здесь только форма.
 *
 * 🔴 Форма — с границами (аудит 19.09, F-06): `sub` уходит в ключ объекта хранилища и в служебный
 * логин теневой строки, ник и имя едут каждому участнику в ростере и в каждом сообщении гостя.
 * Идентификаторы и ник негодного вида — отказ; имя негодного вида заменяется ником, а отпечаток
 * аватара — «нет аватара»: честный человек с редким символом в имени обязан войти.
 */
export function parseIdentityClaims(raw: unknown): FedIdentityClaims | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const iss = fedId(r.iss);
  const sub = fedId(r.sub);
  const aud = fedId(r.aud);
  const jti = fedJti(r.jti);
  const username = fedUsername(r.username);
  const iat = num(r.iat);
  const exp = num(r.exp);
  const gen = num(r.gen);
  if (!iss || !sub || !aud || !jti || !username || iat === null || exp === null || gen === null) return null;
  return {
    iss,
    sub,
    aud,
    iat,
    exp,
    jti,
    gen: Math.trunc(gen),
    username,
    // Отображаемое имя может быть пустым (человек его не задал) или негодным — тогда показываем ник.
    displayName: fedDisplayText(r.display_name, FED_FIELD_LIMITS.displayName, username),
    avatarHash: fedHash(r.avatar_hash),
  };
}

/**
 * Карточка приглашения: что хост рассказывает о сервере ДО входа (§4.2.1).
 *
 * 🔴 Ровно столько, сколько нужно человеку для решения «идти или нет», и ни поля больше: здесь нет
 * ни списка участников, ни каналов, ни того, кто создал ссылку. Предпросмотр доступен всякому, кто
 * знает код, — а код можно и подобрать.
 */
export interface FedInvitePreview {
  code: string;
  serverId: string;
  serverName: string;
  iconHash: string | null;
  members: number;
  /** Когда ссылка перестаёт работать (мс эпохи). `null` — бессрочная (и тогда гостю она не годится). */
  expiresAt: number | null;
}

export function serializeInvitePreview(p: FedInvitePreview): Record<string, unknown> {
  return {
    code: p.code,
    server_id: p.serverId,
    server_name: p.serverName,
    icon_hash: p.iconHash,
    members: p.members,
    expires_at: p.expiresAt,
  };
}

export function parseInvitePreview(raw: unknown): FedInvitePreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = str(r.code);
  const serverId = str(r.server_id);
  const serverName = str(r.server_name);
  if (!code || !serverId || !serverName) return null;
  const members = num(r.members);
  return {
    code,
    serverId,
    serverName,
    iconHash: str(r.icon_hash),
    members: members === null ? 0 : Math.max(0, Math.trunc(members)),
    expiresAt: num(r.expires_at),
  };
}

/**
 * Ответ хоста на предъявленный токен личности: гостевая сессия.
 *
 * `userId` — идентификатор ТЕНЕВОЙ строки на хосте, а не домашний: дальше гость живёт в пространстве
 * хоста, и все его сообщения, роли и монеты ссылаются на эту строку.
 */
export interface FedGuestSession {
  userId: string;
  token: string;
  /** До каких пор годен токен хоста (мс эпохи, часы ХОСТА). */
  expiresAt: number;
}

export function serializeGuestSession(s: FedGuestSession): Record<string, unknown> {
  return { user_id: s.userId, token: s.token, expires_at: s.expiresAt };
}

export function parseGuestSession(raw: unknown): FedGuestSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.user_id);
  const token = str(r.token);
  const expiresAt = num(r.expires_at);
  if (!userId || !token || expiresAt === null) return null;
  return { userId, token, expiresAt };
}

/**
 * Состояние членства гостя (§5.3.1).
 *
 * 🔴 `closed_by_host` — не удаление: сняли галочку федеративного доступа, гости выпали, но их
 * история, роли и монеты остались. Вернули галочку — все внутри, как были. Удалять членство здесь
 * значило бы наказывать людей за решение держателя.
 */
export const FED_MEMBERSHIP_STATES = {
  active: 'active',
  closedByHost: 'closed_by_host',
  removed: 'removed',
} as const;
export type FedMembershipState = (typeof FED_MEMBERSHIP_STATES)[keyof typeof FED_MEMBERSHIP_STATES];

/**
 * Почему доступ закрыт — стабильная строка ПРОТОКОЛА: её шлёт хост и в событии дому, и в шлюз
 * клиенту, а клиент по ней пишет текст окна.
 *
 * 🔴 Живёт в `shared`, потому что копий было три (бэкенд, клиент и разбор события), и любое
 * расхождение между ними означало бы окно без объяснения там, где объяснение и есть весь смысл.
 */
export const FED_CLOSE_REASONS = {
  /** Держатель снял галочку федеративного доступа (или выключил связку). */
  federationDisabled: 'federation_disabled',
  /** Человеку закрыт вход на весь инстанс (§5.11). */
  bannedByInstance: 'banned_by_instance',
  /** Связка разорвана или потеряла доверие: гостей этого инстанса у нас больше нет. */
  linkGone: 'link_gone',
} as const;
export type FedCloseReason = (typeof FED_CLOSE_REASONS)[keyof typeof FED_CLOSE_REASONS];

export function isMembershipState(v: unknown): v is FedMembershipState {
  return v === 'active' || v === 'closed_by_host' || v === 'removed';
}

/**
 * Нагрузка события `membership.changed` — хост рассказывает дому, где его человек состоит.
 *
 * Зачем дому это знать: из индекса членств строится рейл на новом устройстве, «Где я гость» (§5.7),
 * отметка «скрыт, но виден» у админа (§5.2.1) и список хостов, которым слать отзыв сессий (§5.6.1).
 * Без индекса «выйти везде» не знало бы, куда стучаться.
 */
export interface FedMembershipEvent {
  /** Чей человек — `user_id` в пространстве ДОМА. */
  userId: string;
  serverId: string;
  serverName: string;
  state: FedMembershipState;
  /** Как вошёл: по ссылке (и кто её создал) — для отметки §5.2.1. */
  method: string | null;
  invitedBy: string | null;
  /** Почему состояние сменилось: `federation_disabled`, `banned_by_instance`, `left`. */
  reason: string | null;
  at: number;
}

export function serializeMembershipEvent(m: FedMembershipEvent): Record<string, unknown> {
  return {
    user_id: m.userId,
    server_id: m.serverId,
    server_name: m.serverName,
    state: m.state,
    method: m.method,
    invited_by: m.invitedBy,
    reason: m.reason,
    at: m.at,
  };
}

export function parseMembershipEvent(raw: unknown): FedMembershipEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.user_id);
  const serverId = str(r.server_id);
  const at = num(r.at);
  if (!userId || !serverId || at === null) return null;
  // Незнакомое состояние = «нам такого не понять»: считаем членство снятым, а не оставляем висеть
  // непонятной строкой. Сосед новее нас — пусть его правда будет «человека там больше нет».
  const state = isMembershipState(r.state) ? r.state : FED_MEMBERSHIP_STATES.removed;
  return {
    userId,
    serverId,
    serverName: str(r.server_name) ?? '',
    state,
    method: str(r.method),
    invitedBy: str(r.invited_by),
    reason: str(r.reason),
    at,
  };
}

/**
 * Нагрузка `user.sessions_revoked` (§5.6.1) и `user.revoked` (§5.6).
 *
 * Разные события намеренно: «выйти везде» это новое поколение (гость может войти заново прямо
 * сейчас), а `user.revoked` — аккаунта больше нет или он заблокирован, и входить некому.
 */
export interface FedRevocationEvent {
  userId: string;
  /** Поколение сессий после отзыва. У `user.revoked` его нет — там отзывается всё навсегда. */
  gen: number | null;
  at: number;
}

export function serializeRevocationEvent(r: FedRevocationEvent): Record<string, unknown> {
  return { user_id: r.userId, gen: r.gen, at: r.at };
}

export function parseRevocationEvent(raw: unknown): FedRevocationEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.user_id);
  const at = num(r.at);
  if (!userId || at === null) return null;
  const gen = num(r.gen);
  return { userId, gen: gen === null ? null : Math.trunc(gen), at };
}
