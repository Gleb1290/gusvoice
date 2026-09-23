/**
 * Каталог соседа: люди и серверы (#139, F2, план §5.2 и §5.3).
 *
 * Это то, из чего у соседа строятся выпадающие списки во вкладках «Пользователи» и «Серверы»: он
 * забирает каталог раз в 15 минут дельтой, раз в сутки — полностью, и держит у себя КЕШ. Кеш, а не
 * зависимость: упал сосед — списки остаются, просто с пометкой «обновлено N назад» (требование 4).
 *
 * Три вещи, без которых такой обмен ломается на практике:
 *
 *  - 🔴 **надгробия.** Удалённого и скрытого мало «не отдать»: сосед, который не увидит записи,
 *    решит, что просто не дошло, и оставит человека в списке навсегда. Поэтому дельта несёт явное
 *    «этого больше нет» — и БЕЗ имени: скрытый скрыт в том числе от того, кто читает надгробие.
 *  - 🔴 **`since` по часам ОТДАЮЩЕГО.** Получатель не может отсчитывать «с прошлого раза» по своим
 *    часам: они у двух инстансов разные, и записи в промежутке разошлись бы навсегда. Поэтому в
 *    ответе едет `now` отдающего, и следующий запрос идёт от него же, с небольшим перекрытием.
 *  - **страницы с курсором.** Каталог на тысячу человек не влезает в один ответ, а «отдать всё
 *    целиком» — это ещё и способ нагрузить чужой инстанс одним запросом.
 *
 * ⚠️ Правки — только добавлением (`docs/federation-compat.md`): сосед постарше обязан молча
 * пропустить незнакомое поле, а не упасть.
 */

import { FED_FIELD_LIMITS, fedDisplayText, fedHash, fedId, fedOptionalText, fedUsername } from './fieldRules';

/** Почему записи больше нет в каталоге. Новые причины добавляются, старые не переименовываются. */
export const FED_DIRECTORY_REMOVED = {
  /** Аккаунт удалён (у нас — обезличен, §5.6.2). */
  deleted: 'deleted',
  /** Админ инстанса скрыл человека от соседей (§5.2.1). Человек жив, просто не показывается. */
  hidden: 'hidden',
} as const;
export type FedDirectoryRemoved = (typeof FED_DIRECTORY_REMOVED)[keyof typeof FED_DIRECTORY_REMOVED];

/** Запись каталога: либо профиль, либо надгробие (`removed`). */
export interface FedDirectoryEntry {
  userId: string;
  /** Когда запись изменилась ПО ЧАСАМ ОТДАЮЩЕГО (мс эпохи). Он же — версия состояния. */
  updatedAt: number;
  /** Заполнены только у живой записи; у надгробия их нет намеренно. */
  username?: string;
  displayName?: string;
  /** Отпечаток аватара: по его смене хост решает, качать ли картинку заново (§5.4). */
  avatarHash?: string | null;
  removed?: FedDirectoryRemoved;
}

export interface FedDirectoryPage {
  /** Чей это каталог — личность отдающего, чтобы ответ нельзя было подсунуть от имени другого. */
  instanceId: string;
  entries: FedDirectoryEntry[];
  /** Есть ещё страницы — передать это значение в `cursor` следующего запроса. */
  nextCursor: string | null;
  /** Полная выдача (сверка) или дельта: при полной отсутствие записи = «этого человека нет». */
  full: boolean;
  /** Часы ОТДАЮЩЕГО на момент ответа — с них получатель начнёт следующую дельту. */
  now: number;
}

/** Сервер соседа, открытый для федеративного доступа (§5.3). */
export interface FedServerEntry {
  serverId: string;
  updatedAt: number;
  name?: string;
  iconHash?: string | null;
  /** Сколько человек на сервере — соседу это видно и без вступления, как размер комнаты. */
  members?: number;
  /** Сервер закрыли или сняли галочку: у соседа он должен пропасть из списка. */
  removed?: boolean;
}

export interface FedServerPage {
  instanceId: string;
  servers: FedServerEntry[];
  nextCursor: string | null;
  full: boolean;
  now: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseRemoved(v: unknown): FedDirectoryRemoved | undefined {
  // Незнакомая причина — всё равно надгробие: «человека нет» важнее, чем «почему нет». Обратное
  // (пропустить запись целиком) оставило бы удалённого в списке у соседа постарше.
  if (v === FED_DIRECTORY_REMOVED.deleted || v === FED_DIRECTORY_REMOVED.hidden) return v;
  return typeof v === 'string' && v.length > 0 ? FED_DIRECTORY_REMOVED.deleted : undefined;
}

/**
 * Разобрать запись каталога.
 *
 * ⚠️ У живой записи ник обязателен: запись без ника нечего показывать в списке, и молча положить её
 * в кеш значило бы получить пустую строку в выпадающем списке у держателя.
 */
export function parseDirectoryEntry(raw: unknown): FedDirectoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // 🔴 Границы те же, что у токена личности (`fieldRules.ts`, аудит 19.09 F-06): запись каталога
  // ложится в нашу базу и в выпадающие списки админки, и сосед не должен писать туда что угодно.
  const userId = fedId(r.user_id);
  const updatedAt = num(r.updated_at);
  if (!userId || updatedAt === null) return null;
  const removed = r.removed === true ? (parseRemoved(r.reason) ?? FED_DIRECTORY_REMOVED.deleted) : undefined;
  if (removed) return { userId, updatedAt, removed };
  const username = fedUsername(r.username);
  if (!username) return null;
  return {
    userId,
    updatedAt,
    username,
    displayName: fedDisplayText(r.display_name, FED_FIELD_LIMITS.displayName, username),
    avatarHash: fedHash(r.avatar_hash),
  };
}

export function serializeDirectoryEntry(e: FedDirectoryEntry): Record<string, unknown> {
  if (e.removed) return { user_id: e.userId, updated_at: e.updatedAt, removed: true, reason: e.removed };
  return {
    user_id: e.userId,
    updated_at: e.updatedAt,
    username: e.username,
    display_name: e.displayName,
    avatar_hash: e.avatarHash ?? null,
  };
}

/**
 * Разобрать страницу каталога.
 *
 * ⚠️ Негодная ЗАПИСЬ выбрасывается по одной, а негодный конверт (нет личности, нет списка) — это
 * `null` целиком: без личности отдающего страницу не к чему привязать, а «страница без списка»
 * неотличима от «каталог пуст» и стёрла бы кеш при полной сверке.
 */
export function parseDirectoryPage(raw: unknown): FedDirectoryPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = str(r.instance_id);
  const now = num(r.now);
  if (!instanceId || now === null || !Array.isArray(r.entries)) return null;
  return {
    instanceId,
    entries: r.entries.map(parseDirectoryEntry).filter((e): e is FedDirectoryEntry => e !== null),
    nextCursor: str(r.next_cursor),
    full: r.full === true,
    now,
  };
}

export function serializeDirectoryPage(page: FedDirectoryPage): Record<string, unknown> {
  return {
    instance_id: page.instanceId,
    entries: page.entries.map(serializeDirectoryEntry),
    next_cursor: page.nextCursor,
    full: page.full,
    now: page.now,
  };
}

export function parseServerEntry(raw: unknown): FedServerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const serverId = fedId(r.server_id);
  const updatedAt = num(r.updated_at);
  if (!serverId || updatedAt === null) return null;
  if (r.removed === true) return { serverId, updatedAt, removed: true };
  // Название сервера — как у нашего: до 100 знаков и без скрытых символов (F-06), иначе записи нет.
  const name = fedOptionalText(r.name, FED_FIELD_LIMITS.serverName);
  if (!name) return null;
  const members = num(r.members);
  return {
    serverId,
    updatedAt,
    name,
    iconHash: fedHash(r.icon_hash),
    // Отрицательное или дробное число участников — признак битого ответа, а не «нам не сказали».
    members: members !== null && Number.isInteger(members) && members >= 0 ? members : 0,
  };
}

export function serializeServerEntry(e: FedServerEntry): Record<string, unknown> {
  if (e.removed) return { server_id: e.serverId, updated_at: e.updatedAt, removed: true };
  return {
    server_id: e.serverId,
    updated_at: e.updatedAt,
    name: e.name,
    icon_hash: e.iconHash ?? null,
    members: e.members ?? 0,
  };
}

export function parseServerPage(raw: unknown): FedServerPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = str(r.instance_id);
  const now = num(r.now);
  if (!instanceId || now === null || !Array.isArray(r.servers)) return null;
  return {
    instanceId,
    servers: r.servers.map(parseServerEntry).filter((s): s is FedServerEntry => s !== null),
    nextCursor: str(r.next_cursor),
    full: r.full === true,
    now,
  };
}

export function serializeServerPage(page: FedServerPage): Record<string, unknown> {
  return {
    instance_id: page.instanceId,
    servers: page.servers.map(serializeServerEntry),
    next_cursor: page.nextCursor,
    full: page.full,
    now: page.now,
  };
}
