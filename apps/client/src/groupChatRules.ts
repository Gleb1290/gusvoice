import { GROUP_MEMBER_LIMIT, type ConvGroupInfo, type ConvGroupService, type ConvLastMessage, type ConvSummary } from '@gusvoice/shared';
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
