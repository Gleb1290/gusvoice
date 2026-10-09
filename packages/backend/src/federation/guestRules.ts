/**
 * Правила гостей (#139, F3, план §5.5, §5.8) — кого пускать по ссылке, чем он становится на хосте и
 * чего ему нельзя.
 *
 * Чистый модуль: ни базы, ни сети, ни часов. Здесь решается, кто вообще попадёт внутрь чужого
 * инстанса, — а такие решения хочется проверять построчно, а не через живой стенд.
 */

import { FED_ERRORS, type FedErrorCode, type FedIdentityClaims } from '@gusvoice/shared';

/**
 * Служебный логин теневой строки.
 *
 * 🔴 Содержит `@`, а локальная регистрация его не принимает (`^[a-zA-Z0-9_.-]+$`) — поэтому теневой
 * логин НИКОГДА не столкнётся с настоящим и никто не сможет зарегистрироваться «как гость». Второй
 * слой защиты: пара «инстанс + человек» уникальна сама по себе, но уникальность `users.username`
 * проверяется базой на каждой вставке, и она обязана сходиться без удачи.
 *
 * ⚠️ Показывать это людям нельзя: в интерфейсе гость — его домашний ник плюс значок инстанса.
 * Домен в логин НЕ зашивается намеренно (§5.5): сосед переедет на другой адрес, и зашитый домен
 * закаменел бы в тысячах строк.
 */
export function shadowUsername(homeInstanceId: string, homeUserId: string): string {
  return `${homeUserId}@${homeInstanceId}`;
}

/** Он ли это — теневая строка, а не местный человек. */
export function isShadowUser(u: { homeInstanceId: string | null }): boolean {
  return u.homeInstanceId !== null;
}

/**
 * Годится ли ссылка для ЧУЖОГО человека (§4.2, требование 13).
 *
 * Три условия, и каждое — отдельная причина отказа, потому что лечатся они по-разному: срок ставит
 * создатель ссылки, галочку — админ инстанса, исключение по связке — он же, но точечно.
 */
export function inviteRefusalForGuest(input: {
  invite: { expiresAt: Date | null; maxUses: number | null; uses: number } | null;
  server: { federatedAccess: boolean } | null;
  excludedForLink: boolean;
  now: number;
}): FedErrorCode | null {
  if (!input.invite || !input.server) return FED_ERRORS.inviteInvalid;
  if (input.invite.expiresAt !== null && input.invite.expiresAt.getTime() <= input.now) {
    return FED_ERRORS.inviteExpired;
  }
  if (input.invite.maxUses !== null && input.invite.uses >= input.invite.maxUses) {
    return FED_ERRORS.inviteExpired;
  }
  // 🔴 Бессрочная ссылка гостю не годится ДАЖЕ при открытом сервере. Такая ссылка живёт в чужих
  // переписках вечно, а срок — единственное, что мешает ей пустить внутрь кого угодно спустя год.
  if (input.invite.expiresAt === null) return FED_ERRORS.inviteNoExpiry;
  // Сервер закрыт для соседей целиком — или закрыт именно для этой связки (§5.3).
  if (!input.server.federatedAccess || input.excludedForLink) return FED_ERRORS.serverClosed;
  return null;
}

/**
 * Почему предъявленный токен личности негоден, или `null`.
 *
 * 🔴 Все причины сводятся в ОДИН код `identity_invalid`, и это не лень: по разнице ответов
 * («просрочен» против «не для нас») подбирающий узнавал бы, какая половина подделки уже верна.
 * Подробности уходят в журнал, наружу — один код.
 *
 * ⚠️ Одноразовость проверяется НЕ здесь (для неё нужна память), но решение о ней принимается тем же
 * правилом: токен, который приняли однажды, второй раз не принимается никогда — иначе перехваченный
 * токен работал бы все две минуты своей жизни.
 */
export function identityRefusal(input: {
  claims: FedIdentityClaims;
  /** Наш собственный `instance_id` — токен обязан быть выписан именно нам. */
  selfInstanceId: string;
  /** `instance_id` связки, чьей подписью подписан токен. */
  signedBy: string;
  now: number;
  skewMs: number;
}): 'expired' | 'wrong-audience' | 'issuer-mismatch' | 'future' | null {
  const { claims, now, skewMs } = input;
  // 🔴 Подписал тот, кто ручается: иначе связанный сосед B выписывал бы токены от имени инстанса C,
  // и один доверенный сосед становился бы дверью для всех, кого он назовёт.
  if (claims.iss !== input.signedBy) return 'issuer-mismatch';
  if (claims.aud !== input.selfInstanceId) return 'wrong-audience';
  if (claims.exp <= now - skewMs) return 'expired';
  // Часы соседа могут спешить — но не на часы. Токен «из будущего» дальше допуска не принимаем:
  // иначе выписанный на сутки вперёд жил бы сутки.
  if (claims.iat > now + skewMs) return 'future';
  return null;
}

/**
 * Что гостю нельзя (§5.8) — по имени маршрута, а не по разбросанным проверкам.
 *
 * 🔴 Список закрытого, а не открытого: гость должен уметь всё, что умеет местный участник сервера
 * (в этом вся затея), а закрыто ровно то, что либо делается ДОМА, либо сломалось бы при разрыве
 * связки. Перечислять открытое значило бы тихо ломать каждую новую возможность для гостей.
 */
export const GUEST_FORBIDDEN_REASONS = {
  /** Пароль, почта, 2FA, удаление аккаунта — это дома. */
  account: 'account',
  /** Создание серверов на чужом инстансе: сервер остался бы без хозяина при разрыве связки. */
  createServer: 'create-server',
  /** Владение сервером (требование 25) — та же причина, отдельный код отказа. */
  ownServer: 'own-server',
  /** Личка между инстансами выключена до #141 (требование 22). */
  dm: 'dm',
} as const;
export type GuestForbiddenReason = (typeof GUEST_FORBIDDEN_REASONS)[keyof typeof GUEST_FORBIDDEN_REASONS];

/** Код отказа для каждой запретной двери — часть протокола, клиент по нему пишет текст. */
export function guestRefusalCode(reason: GuestForbiddenReason): FedErrorCode {
  if (reason === GUEST_FORBIDDEN_REASONS.ownServer) return FED_ERRORS.ownerMustBeLocal;
  if (reason === GUEST_FORBIDDEN_REASONS.dm) return FED_ERRORS.dmUnavailable;
  return FED_ERRORS.guestForbidden;
}

/**
 * Действует ли запрет на инстанс прямо сейчас (§5.11).
 *
 * `expiresAt: null` — навсегда. Срок истёк — человек снова может войти по ссылке, но прежние
 * членства ему НЕ возвращаются (как бан в Discord): вернуть их значило бы, что запрет был паузой.
 */
export function banActive(ban: { expiresAt: Date | null; removedAt?: Date | null } | null, now: number): boolean {
  if (!ban) return false;
  // Снятый запрет остаётся строкой журнала, но больше никого не держит.
  if (ban.removedAt) return false;
  return ban.expiresAt === null || ban.expiresAt.getTime() > now;
}

/** Предел причины жалобы — тот же, которым режет приём (`instanceBan.ts`, `registerReportHandlers`). */
export const REPORT_REASON_MAX = 2000;

/**
 * Причина склеенной жалобы (§5.11, #204).
 *
 * Повторная жалоба на того же человека за сутки приклеивается к первой — и её причина тоже. Раньше новая причина
 * ЗАТИРАЛА прежнюю: держатель соседа видел только последнюю, а первая — та, по которой и закрыли вход, — пропадала.
 *
 * Новой нет — остаётся прежняя; прежней нет — новая; одна уже содержит другую (та же причина повторно или отправитель
 * склеил их сам) — более полная; иначе — прежняя, перевод строки, новая. Не длиннее `max`: режется хвост, как режет
 * приём, — первая причина важнее.
 *
 * ⚠️ Склеивает ОТПРАВИТЕЛЬ: дополнение уходит соседу под тем же `report_id`, и приём заменяет причину целиком (а не
 * клеит ещё раз — иначе у каждой причины появился бы двойник). Сосед на старой версии шлёт только последнюю причину —
 * у его жалоб держатель по-прежнему видит последнюю.
 */
export function mergeReportReason(prev: string | null, next: string | null, max = REPORT_REASON_MAX): string | null {
  const a = prev?.trim() || null;
  const b = next?.trim() || null;
  if (!b) return a;
  if (!a) return b.slice(0, max);
  if (a.includes(b)) return a;
  if (b.includes(a)) return b.slice(0, max);
  return `${a}\n${b}`.slice(0, max);
}

/**
 * Что делать с поколением сессий из предъявленного токена (§5.6.1).
 *
 * - `ok` — то же поколение, что мы помним: обычный вход;
 * - `bumped` — дом ушёл вперёд (человек нажал «выйти везде», а событие до нас не доехало). Токен
 *   принимаем, но прежние гостевые сессии этого человека обязаны умереть В ТОТ ЖЕ МОМЕНТ: иначе
 *   угонщик, уже сидящий у нас, пережил бы нажатие;
 * - 🔴 `stale` — поколение НИЖЕ запомненного. Это либо отозванный токен, либо дом откатился из
 *   бэкапа. Обе причины ведут к отказу: пускать по «не меньше» значило бы, что откат дома оживляет
 *   угнанные сессии, а это ровно тот сценарий, ради которого «выйти везде» и делалось.
 */
export function guestGenVerdict(tokenGen: number, shadowGen: number): 'ok' | 'bumped' | 'stale' {
  if (tokenGen === shadowGen) return 'ok';
  return tokenGen > shadowGen ? 'bumped' : 'stale';
}

/**
 * Сколько гостевых сессий на связку — предел (§5.10, «лимиты на связку»).
 *
 * Считается по теневым строкам, а не по токенам: токен у человека может быть на каждом устройстве, и
 * ограничивать надо людей, а не их телефоны.
 */
export const GUEST_LIMITS = {
  /** Столько ЖИВЫХ теневых строк с одной связки. Упёрлись — новый человек не войдёт, старые работают. */
  shadowUsers: 2000,
  /**
   * Столько заведений теневых строк с одной связки за сутки — обезличенные тоже считаются (#196 п. 4):
   * «удалить» строку у нас может сам сосед, и без этого предел выше обходился заведением по кругу.
   */
  shadowUsersPerDay: 500,
  /** Предпросмотров ссылки в час на связку: подбор кода (§4.2.1) должен упираться в стену. */
  invitePreview: { max: 120, windowS: 3600 },
  /** Заведений гостевой сессии в час на связку. */
  session: { max: 240, windowS: 3600 },
} as const;

/**
 * Квота хранилища на связку (§5.10, требование 30).
 *
 * 🔴 На СВЯЗКУ, а не на инстанс: файлы гостей лежат у нас, и предел должен называть виновника —
 * «инстанс «Друзья» занял 2 ГБ», а не «гости заняли». Держателю иначе нечего решать.
 */
export const GUEST_STORAGE_DEFAULT_BYTES = 2 * 1024 * 1024 * 1024;

/** Уложится ли загрузка в квоту связки. */
export function storageQuotaRefusal(input: {
  usedBytes: number;
  addBytes: number;
  quotaBytes: number;
}): FedErrorCode | null {
  if (input.quotaBytes <= 0) return null; // 0 = без предела (решение держателя)
  return input.usedBytes + input.addBytes > input.quotaBytes ? FED_ERRORS.quotaExceeded : null;
}

/**
 * Имя системной роли «Гости» (§5.9).
 *
 * 🔴 Для гостя она ЗАМЕНЯЕТ `@everyone`, а не добавляется к нему: роли только прибавляют права, и
 * ограничить гостей, оставив им `@everyone`, было бы нечем. При создании — точная копия прав
 * `@everyone`, то есть по умолчанию гость равен своему, а сузить может владелец сервера.
 */
export const GUESTS_ROLE_NAME = 'Гости';

/**
 * Какие роли действуют для человека на сервере: у гостя вместо `@everyone` — «Гости».
 *
 * ⚠️ Если роли «Гости» на сервере ещё нет (сервер завели до F3, а миграция не дотянулась), гость
 * получает обычный `@everyone`: остаться СОВСЕМ без базовых прав он не должен — это выглядело бы
 * как сломанный сервер, а не как ограничение.
 */
export function baseRoleFor(input: {
  isGuest: boolean;
  everyoneRoleId: string | null;
  guestsRoleId: string | null;
}): string | null {
  if (input.isGuest && input.guestsRoleId) return input.guestsRoleId;
  return input.everyoneRoleId;
}
