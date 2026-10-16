/**
 * ЛС между инстансами, этап Э7 часть 1 (#141, `docs/dm/FEDERATION.md` §3.6, §4 п. 1, Ф2 (б)) — провод групп со смешанным
 * составом. ЧИСТЫЙ модуль (без node:crypto): подписывает и проверяет бэкенд (`backend/src/federation/convGroupSig.ts`).
 *
 * Модель — звезда: власть над составом, названием и фото — у дома создателя группы (хост, `FedConvWire.originInstanceId`);
 * сообщение участника идёт «дом автора → хост → остальные дома». Хост пересылает чужое, поэтому дом автора подписывает
 * каноническое сообщение своим сменным ключом, а к подписи прикладывает сам ключ (с подписью корневого) и корневой ключ:
 * получатель проверяет цепочку «корневой ключ → `instance_id` автора» без связки с домом автора — хост подделать не может.
 *
 * Всё — добавлением к прежнему проводу: группа едет строкой `conv` журнала (`FedConvWire` + поля ниже), сообщение — строкой
 * `msg` (`FedConvMessageWire` + `sig`). Старый сосед лишние ключи не читает.
 */
import { FED_FIELD_LIMITS, fedDomain, fedHash, fedHttpUrl, fedId, fedOptionalText, fedUsername } from './fieldRules';
import type { FedConvMessageWire, FedPersonRef } from './convWire';
import { parsePersonRef, serializePersonRef } from './convWire';
import type { FedSigningKey } from './protocol';

/** Запрос участника с другого инстанса хосту группы: выйти, удалить, позвать, переименовать (подписанный POST связки). */
export const FED_GROUP_OP_PATH = '/fed/v1/conv/group/op';
export const FED_GROUP_OPS = ['leave', 'remove', 'add', 'title'] as const;
export type FedGroupOp = (typeof FED_GROUP_OPS)[number];

// ─── Подпись дома автора ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FedMessageSig {
  /** Корневой ключ дома автора, DER SPKI в base64url: из него получатель выводит `instance_id` и сверяет с автором. */
  root: string;
  /** Сменный ключ, которым подписано (с подписью корневого) — как в документе инстанса. */
  key: FedSigningKey;
  /** Подпись `convMessageSigPayload`, base64url. */
  value: string;
}

/**
 * Что подписывает дом автора: поля, которые видит читатель (текст, вложения, ответ, правка, надгробие), — с длиной каждого
 * поля (как `signingKeyPayload`: иначе `a|bc` и `ab|c` дали бы одну строку). Служебные записи групп (`service`) не
 * подписываются — их пишет хост, он и власть над составом.
 */
export function convMessageSigPayload(m: FedConvMessageWire): string {
  const parts = [
    'gvmsg1',
    m.id,
    m.conversationId,
    m.author.instanceId,
    m.author.userId,
    String(m.createdAt),
    m.content,
    m.replyToId ?? '',
    String(m.editVersion),
    m.deleted ? '1' : '0',
    m.sticker?.id ?? '',
    m.attachments.map((a) => `${a.id}/${a.contentType}/${a.size}`).join(','),
  ];
  return parts.map((p) => `${p.length}:${p}`).join('|');
}

export function serializeMessageSig(s: FedMessageSig): Record<string, unknown> {
  return {
    root: s.root,
    key: { kid: s.key.kid, public_key: s.key.publicKey, not_before: s.key.notBefore, not_after: s.key.notAfter, sig: s.key.sig },
    value: s.value,
  };
}

const B64U = /^[A-Za-z0-9_-]{16,512}$/;

export function parseMessageSig(raw: unknown): FedMessageSig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const k = r.key as Record<string, unknown> | null;
  if (!k || typeof k !== 'object') return null;
  const ok = (v: unknown): v is string => typeof v === 'string' && B64U.test(v);
  const kid = typeof k.kid === 'string' && k.kid.length > 0 && k.kid.length <= 64 ? k.kid : null;
  const nb = typeof k.not_before === 'number' && Number.isFinite(k.not_before) ? k.not_before : null;
  const na = typeof k.not_after === 'number' && Number.isFinite(k.not_after) ? k.not_after : null;
  if (!ok(r.root) || !ok(r.value) || !kid || !ok(k.public_key) || !ok(k.sig) || nb === null || na === null) return null;
  return { root: r.root, key: { kid, publicKey: k.public_key, notBefore: nb, notAfter: na, sig: k.sig }, value: r.value };
}

// ─── Группа: поля к строке `conv` ────────────────────────────────────────────────────────────────────────────────────

/** Профиль участника для теневой строки на доме, у которого нет связки с его инстансом (имя едет от хоста). */
export interface FedGroupProfile {
  ref: FedPersonRef;
  username: string;
  displayName: string;
  avatarHash: string | null;
  /**
   * Э7 ч.3 (D, добавление): дом участника — название и домен инстанса, как их знает хост (у него с ним связка). Дом группы
   * у ТРЕТЬЕГО инстанса связки не имеет, и без этого человек подписан «с другого инстанса». Слова хоста; `name` может быть `null`.
   */
  home?: { name: string | null; domain: string };
}

export interface FedConvGroupExtras {
  /** Версия состава у хоста: +1 на каждое изменение состава, названия, фото; меньшая или равная — без изменений. */
  version: number;
  avatarUrl: string | null;
  owner: FedPersonRef | null;
  profiles: FedGroupProfile[];
}

export function serializeConvGroupExtras(x: FedConvGroupExtras): Record<string, unknown> {
  return {
    group_version: x.version,
    avatar_url: x.avatarUrl,
    owner: x.owner ? serializePersonRef(x.owner) : null,
    profiles: x.profiles.map((p) => ({
      ...serializePersonRef(p.ref),
      username: p.username,
      display_name: p.displayName,
      avatar_hash: p.avatarHash,
      ...(p.home ? { home_name: p.home.name, home_domain: p.home.domain } : {}),
    })),
  };
}

export function parseConvGroupExtras(raw: unknown): FedConvGroupExtras | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const v = r.group_version;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const profiles: FedGroupProfile[] = [];
  if (Array.isArray(r.profiles)) {
    for (const p of r.profiles.slice(0, 200)) {
      const ref = parsePersonRef(p);
      const o = p as Record<string, unknown>;
      const username = fedUsername(o?.username);
      if (!ref || !username) continue;
      const dn = typeof o.display_name === 'string' && o.display_name.trim() ? o.display_name.slice(0, 64) : username;
      const homeDomain = fedDomain(o.home_domain);
      const home = homeDomain ? { name: fedOptionalText(o.home_name, FED_FIELD_LIMITS.instanceName), domain: homeDomain } : null;
      profiles.push({ ref, username, displayName: dn, avatarHash: fedHash(o.avatar_hash), ...(home ? { home } : {}) });
    }
  }
  return {
    version: Math.floor(v),
    avatarUrl: fedHttpUrl(r.avatar_url),
    owner: parsePersonRef(r.owner),
    profiles,
  };
}

// ─── Запрос хосту ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FedGroupOpRequest {
  /** Инстанс-отправитель (дом действующего). */
  instanceId: string;
  conversationId: string;
  /** Действующий — человек отправителя (id на его доме). */
  actorUserId: string;
  op: FedGroupOp;
  /** `remove` — кого удалить. */
  target: FedPersonRef | null;
  /** `add` — кого позвать (люди отправителя или хоста; профиль — для теневой строки у хоста). */
  users: FedGroupProfile[];
  /** `title` — новое название. */
  title: string | null;
}

export function serializeGroupOp(o: FedGroupOpRequest): Record<string, unknown> {
  return {
    instance_id: o.instanceId,
    conversation_id: o.conversationId,
    actor_user_id: o.actorUserId,
    op: o.op,
    target: o.target ? serializePersonRef(o.target) : null,
    users: o.users.map((p) => ({ ...serializePersonRef(p.ref), username: p.username, display_name: p.displayName, avatar_hash: p.avatarHash })),
    title: o.title,
  };
}

export function parseGroupOp(raw: unknown): FedGroupOpRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = fedId(r.instance_id);
  const conversationId = fedId(r.conversation_id);
  const actorUserId = fedId(r.actor_user_id);
  const op = (FED_GROUP_OPS as readonly unknown[]).includes(r.op) ? (r.op as FedGroupOp) : null;
  if (!instanceId || !conversationId || !actorUserId || !op) return null;
  const extras = parseConvGroupExtras({ group_version: 0, profiles: Array.isArray(r.users) ? r.users.slice(0, 10) : [] });
  const title = typeof r.title === 'string' ? r.title.slice(0, 512) : null;
  return { instanceId, conversationId, actorUserId, op, target: parsePersonRef(r.target), users: extras?.profiles ?? [], title };
}

// ─── Полный проход для групп (Э7 часть 3) ────────────────────────────────────────────────────────────────────────────

/**
 * Э7 часть 3: список групп хоста, где у спрашивающего дома есть люди — действующие или бывшие (подписанный GET связки,
 * `?instance_id=`). Нужен полному проходу (`reset`, Ф12): строка `conv` группы, заведённой, пока сосед не забирал журнал,
 * могла уйти уборкой — без списка дом участника о группе не узнает. Сами группы — тем же `GET /fed/v1/conv/:id/export`.
 * Старый хост ответит 404 — список пуст, всё как до части 3.
 */
export const FED_CONV_GROUPS_PATH = '/fed/v1/conv/groups';
/** Предел списка: больше групп с одним домом не ждём; сверх предела группа догонится только своим журналом (честный предел). */
export const FED_CONV_GROUPS_MAX = 1000;

export interface FedConvGroupsList {
  instanceId: string;
  groups: string[];
}

export function serializeConvGroupsList(l: FedConvGroupsList): Record<string, unknown> {
  return { instance_id: l.instanceId, groups: l.groups.slice(0, FED_CONV_GROUPS_MAX) };
}

export function parseConvGroupsList(raw: unknown): FedConvGroupsList | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instanceId = fedId(r.instance_id);
  if (!instanceId || !Array.isArray(r.groups)) return null;
  const groups: string[] = [];
  for (const g of r.groups.slice(0, FED_CONV_GROUPS_MAX)) {
    const id = fedId(g);
    if (id && !groups.includes(id)) groups.push(id);
  }
  return { instanceId, groups };
}
