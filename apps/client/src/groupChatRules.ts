import { FEATURE_FEDM6, GROUP_MEMBER_LIMIT, type ConvGroupInfo, type ConvGroupService, type ConvLastMessage, type ConvSummary, type User } from '@gusvoice/shared';
import { peerReadKeyOf } from './convSyncRules';
import { plural } from './plural';

/**
 * Групповые ЛС на клиенте (07.10, #211, С4, признак сервера `groups1`) — ЧИСТЫЕ правила подписей: шапка, «печатает»,
 * превью строки списка, предел выбора людей. Источник — Telegram: «N участников» (`lng_chat_status_members`),
 * «Имя печатает» / «Имя и Имя печатают» / «N человек печатают» (tdesktop `history_view_send_action.cpp`,
 * `lng_user_typing`, `lng_users_typing`, `lng_many_typing`), «Имя: текст» в строке (`DialogCell`). Предел — Р-5.
 */

export { GROUP_MEMBER_LIMIT };

/** Подсказка, когда человек пытается позвать больше предела (Р-5): группа — до 5, дальше — сервер. */
export const GROUP_LIMIT_HINT = `В группе до ${GROUP_MEMBER_LIMIT} человек. Для компании больше — создайте сервер`;

/**
 * «Прочитано» для ✓✓ строки и ленты: у группы (есть `group`, `groups1`) — наибольшее «прочитано до» остальных участников
 * (✓✓, когда прочёл хоть один, как Telegram); у 1:1 — `convSyncRules.peerReadKeyOf` (там вид без `group` — не 1:1, `null`).
 */
export function chatReadKeyOf(s: ConvSummary | undefined): number | null {
  if (s?.group) return typeof s.peerReadKey === 'number' ? s.peerReadKey : null;
  return peerReadKeyOf(s);
}

/**
 * Служебная строка действия в группе (`ConvMessage.service` вида `group`, `groups1`) или `null`. Закреп (`kind: 'pin'`) —
 * `pinBarRules.pinServiceMark`; незнакомый вид — `null` (обычное сообщение с запасным текстом, правило 11).
 */
export function groupServiceMark(m: { service?: unknown }): ConvGroupService | null {
  const s = m.service as { kind?: unknown; type?: unknown } | null | undefined;
  return s && s.kind === 'group' && typeof s.type === 'string' ? (s as ConvGroupService) : null;
}

/**
 * Текст служебной строки группы глазами читателя (G6, приёмка 13.10): «добавил(а)» / «удалил(а)» МЕНЯ — «Имя удалил(а) вас»
 * (Telegram `ActionKickUserYou` «un1 removed you», `ActionAddUserYou` «un1 added you»), остальные из списка — следом через запятую.
 * Сервер собирает фразу один раз на всех (`groupRules.serviceText`: «Имя удалил(а) Имя2»), поэтому меняется только хвост с именами;
 * хвост не совпал (старый сервер, другая форма) или меня в списке нет — текст сервера как есть.
 */
export function groupServiceLabel(svc: ConvGroupService, content: string, meId: string | undefined): string {
  if (!meId || (svc.type !== 'remove' && svc.type !== 'add')) return content;
  const users = svc.users ?? [];
  if (!users.some((u) => u.id === meId)) return content;
  const names = users.map((u) => u.displayName).join(', ');
  if (!names || !content.endsWith(names)) return content;
  const rest = users.filter((u) => u.id !== meId).map((u) => u.displayName);
  return content.slice(0, content.length - names.length) + ['вас', ...rest].join(', ');
}

/** «3 участника» — подпись шапки группы. */
export function groupMembersLabel(n: number): string {
  return `${n} ${plural(n, 'участник', 'участника', 'участников')}`;
}

/**
 * «Печатает» в группе по именам печатающих (порядок — как пришли): один — «Имя печатает», двое — «Имя и Имя печатают»,
 * больше — «N человека печатают». Никого — пусто.
 */
export function groupTypingLabel(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} печатает`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают`;
  return `${names.length} ${plural(names.length, 'человек', 'человека', 'человек')} печатают`;
}

/**
 * Имена печатающих участников группы; не участник (вышел) — мимо. `nameOf` — подпись из моих контактов (`peerName.ts`,
 * решение владельца 08.10 п.27); без него — имя участника.
 */
export function typingNames(
  group: Pick<ConvGroupInfo, 'members'>,
  userIds: readonly string[],
  nameOf: (userId: string, fallback: string) => string = (_id, n) => n,
): string[] {
  const byId = new Map(group.members.map((m) => [m.id, m.displayName]));
  return userIds.flatMap((id) => {
    const n = byId.get(id);
    return n ? [nameOf(id, n)] : [];
  });
}

/**
 * Кто перед текстом в строке списка группы: своё — «Вы», чужое — имя автора; служебная запись и строка без имени —
 * `null` (текст уже фраза).
 */
export function groupPreviewAuthor(
  last: Pick<ConvLastMessage, 'authorId' | 'authorName' | 'service'> | null,
  meId: string | undefined,
  nameOf: (userId: string, fallback: string) => string = (_id, n) => n,
): string | null {
  if (!last || last.service) return null;
  if (meId && last.authorId === meId) return 'Вы';
  return last.authorName ? nameOf(last.authorId, last.authorName) : null;
}

/**
 * Выбор людей для группы: сколько будет всего вместе со мной (и уже состоящими — при добавлении) и можно ли выбрать
 * ещё одного. `taken` — уже в группе (при создании — только я, 1).
 */
export function groupPickState(selected: number, taken = 1, limit = GROUP_MEMBER_LIMIT): { total: number; full: boolean; label: string } {
  const total = selected + taken;
  return { total, full: total >= limit, label: `${total}/${limit}` };
}

/** Сколько цветов имён у Telegram (`ui/chat/chat_style.h` `kSimpleColorIndexCount`). */
export const PEER_COLOR_COUNT = 7;

/**
 * Цвет имени автора в группе (`groups2`, 07.10): индекс 0…6 по id, как tdesktop `Ui::DecideColorIndex(id) = id % 7`
 * (`ui/chat/chat_style.cpp`). Наш id — строка, поэтому сначала стабильный 32-битный хеш (FNV-1a); один и тот же
 * человек везде одного цвета. Цвета — токены `--peer-1…7` (`styles.css`, порядок Telegram: красный, оранжевый,
 * фиолетовый, зелёный, бирюзовый, синий, розовый).
 */
export function peerColorIndex(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PEER_COLOR_COUNT;
}

// ─── ЛС между инстансами, Э7 часть 2 (#141, `fedm6`): группы со смешанным составом на клиенте ─────────────────────────────

type GroupHome = NonNullable<User['homeInstance']>;

/** Сервер умеет группы со смешанным составом (Э7, `fedm6`): в выбор участников можно звать людей соседних инстансов. */
export function serverFedGroups(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(FEATURE_FEDM6);
}

/** Человек годится в выбор участников группы: свой — всегда, человек соседа (`homeInstance`) — только при `fedm6`. */
export function groupPickable(u: { homeInstance?: GroupHome | null }, fedGroups: boolean): boolean {
  return !u.homeInstance || fedGroups;
}

/** Как назвать инстанс: название от держателя, иначе домен (как `GuestMark.guestHomeLabel`); не знаем ничего — `null`. */
export function groupHomeLabel(home: Pick<GroupHome, 'name' | 'domain'> | null | undefined): string | null {
  return home?.name?.trim() || home?.domain || null;
}

/**
 * Дом группы чужого инстанса (`ConvSummary.fedGroupHost.instanceId`) → его название: сводка несёт только id, имя берём у участника
 * с того инстанса (создатель живёт там), иначе у собеседника 1:1 оттуда. Не нашли — `null` (фразы строятся без имени).
 */
export function groupHostHome(
  hostId: string | null | undefined,
  members: readonly { homeInstance?: GroupHome | null }[],
  dms: readonly { otherUser: { homeInstance?: GroupHome | null } }[] = [],
): GroupHome | null {
  if (!hostId) return null;
  for (const m of members) if (m.homeInstance?.instanceId === hostId) return m.homeInstance;
  for (const d of dms) if (d.otherUser.homeInstance?.instanceId === hostId) return d.otherUser.homeInstance;
  return null;
}

/** Ответ ручки группы чужого дома: запрос ушёл хосту, сводка доедет событием `conv.change` (`{ ok: true, pending: true }`). */
export function groupOpPending(r: unknown): boolean {
  return !!r && typeof r === 'object' && (r as { pending?: unknown }).pending === true;
}

/** Тост после `pending`: «Запрос отправлен инстансу «X»». */
export function fedGroupPendingText(host: string | null): string {
  return host ? `Запрос отправлен инстансу «${host}»` : 'Запрос отправлен инстансу, где живёт группа';
}

/** Подсказка у фото группы чужого дома (`federation.dm_group_host_only`). */
export function fedGroupPhotoHint(host: string | null): string {
  return host ? `Фото меняется на инстансе «${host}»` : 'Фото меняется на инстансе, где живёт группа';
}

/** Плашка над полем и подсказка у кнопок состава, когда дом группы недоступен (`fedGroupHost.down`). */
export function fedGroupDownText(host: string | null): string {
  return host
    ? `Инстанс «${host}», где живёт группа, недоступен — сообщения доедут, когда он вернётся; состав сейчас не меняется`
    : 'Инстанс, где живёт группа, недоступен — сообщения доедут, когда он вернётся; состав сейчас не меняется';
}

/**
 * Отказ 403 `group_not_invitable { userIds }`: инстанс человека не умеет группы (нет `dmgroup1`) или связка не работает. Имена
 * инстансов — у отказанных из выбранных; не знаем — без имени.
 */
export function groupNotInvitableText(
  refused: readonly string[] | null | undefined,
  picked: readonly { id: string; homeInstance?: GroupHome | null }[],
): string {
  const ids = refused && refused.length > 0 ? new Set(refused) : null;
  const names = [
    ...new Set(picked.filter((p) => p.homeInstance && (!ids || ids.has(p.id))).map((p) => groupHomeLabel(p.homeInstance)).filter((n): n is string => !!n)),
  ];
  if (names.length === 1) return `Нельзя позвать: инстанс «${names[0]}» не поддерживает группы`;
  if (names.length > 1) return `Нельзя позвать: инстансы ${names.map((n) => `«${n}»`).join(', ')} не поддерживают группы`;
  return 'Нельзя позвать: инстанс этого человека не поддерживает группы';
}
