import { and, eq, inArray } from 'drizzle-orm';
import { pushBurst } from './authGuard.js';
import { deliver, type Delivery } from './conversations.js';
import { db } from './db/index.js';
import { contactNamesFor } from './contacts.js';
import { pushNameFor } from './contactRules.js';
import { conversations, userBlocks, users } from './db/schema.js';
import { groupMuteTarget, groupPushTitle } from './groupRules.js';
import { publishLegacySend } from './dmLegacyEvents.js';
import { contentPreview, pushAlwaysUsers, pushThrottleSource, sendPushToUsers, stickerPushText, withSilent, type PushPayload } from './push.js';

/**
 * Что происходит ПОСЛЕ фиксации нового сообщения беседы — одно место для обычной отправки (`POST /conv/:id/messages`) и
 * отложенной (С4: планировщик и «Отправить сейчас», `scheduled.ts`), чтобы правила у них не разошлись:
 * 1. старые события `dm.channel`/`dm.create` — соединениям без `conv1` (десктоп/APK 0.8.x); их сбой ответ не портит;
 * 2. `conv.change` (`deliver`) — соединениям с `conv1`, обоим, `created`; у отложенного следом — список автору;
 * 3. пуш получателю, если план доставки его уведомляет (заблокировавшему автора — нет): один на получателя от
 *    отправителя за окно, заглушка «ЛС этого человека» чтится, «без звука» (С3) — `silent: true` и своё окно.
 * Старая рассылка — ДО `deliver` (как в `/api/dm*`): упади `deliver`, повтор запроса событий уже не шлёт, а старый клиент
 * журнала не догоняет. Пуш — в фоне: хранилище подписок не вправе задерживать ответ.
 */
export interface SentMessage {
  /** Автор. */
  me: string;
  peerId: string | null;
  /**
   * Группа (07.10, `groups1`): действующие участники. Старых событий `dm.*` у группы нет (старый клиент групп не знает),
   * пуш — каждому, кроме автора и заблокировавших его: «Имя в «Название»» и текст (`groupRules.groupPushTitle`).
   */
  groupMemberIds?: readonly string[];
  /** «Избранное» (08.10, `saved1`): беседа с самим собой — старых событий `dm.*` нет (старый клиент её не знает), пуша нет. */
  saved?: boolean;
  conversationId: string;
  row: { id: string; createdAt: Date; sortKey?: number };
  delivery: Delivery;
  /** `blockRules.dmDeliveryPlan(...).notifyRecipient`. */
  notifyRecipient: boolean;
  /**
   * Текст (для превью пуша) и вложения: сами вложения строки — пуш назовёт их словами («Фото», «Видео», «Файл: имя»,
   * 05.10), или только число (вид неизвестен — «📎 Вложение»).
   */
  content: string;
  attachments: number | readonly unknown[];
  silent: boolean;
  /** Стикер сообщения (`stickers2`): пуш «😀 Стикер». Нет поля — по тексту и вложениям, как было. */
  sticker?: { emoji: string } | null;
}

export async function fanOutSend(s: SentMessage): Promise<void> {
  if (s.groupMemberIds) return fanOutGroup(s, s.groupMemberIds);
  if (s.saved) return deliver(s.delivery);
  await publishLegacySend(s.me, s.peerId, s.conversationId, s.row, s.notifyRecipient).catch(() => {});
  await deliver(s.delivery);
  if (!s.notifyRecipient || !s.peerId) return;
  const peerId = s.peerId;
  const [author] = await db
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, s.me))
    .limit(1);
  void (async () => {
    // Пачка (решение владельца 39): звенит один пуш за окно, следующие сообщения окна — тихо (строка в шторке без звука).
    const mode = await pushBurst(peerId, pushThrottleSource(s.me, s.silent));
    if (mode === 'drop') return;
    // Подпись автора в контактах получателя вместо имени (решение владельца 08.10 п.27, как Telegram): один запрос по индексу.
    const name = pushNameFor(await contactNamesFor(s.me, [peerId]), peerId, author?.displayName ?? '');
    await sendPushToUsers(
      [peerId],
      withSilent(
        {
          type: 'dm',
          title: name,
          body: s.sticker ? stickerPushText(s.sticker.emoji) : contentPreview(s.content, s.attachments),
          dmId: s.conversationId,
          ...conversationNotice(s, author && { ...author, displayName: name }),
        },
        s.silent || mode === 'quiet',
      ),
      { scope: 'dm_user', targetId: s.me },
      { private: true, ...(mode === 'quiet' ? { burst: true } : {}) },
    );
  })().catch(() => {});
}

/** Группа: событие участникам и пуш каждому получателю, кроме заблокировавших автора (один на получателя за окно). */
async function fanOutGroup(s: SentMessage, memberIds: readonly string[]): Promise<void> {
  await deliver(s.delivery);
  const [author] = await db
    .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, s.me))
    .limit(1);
  const [conv] = await db.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, s.conversationId)).limit(1);
  const body = s.sticker ? stickerPushText(s.sticker.emoji) : contentPreview(s.content, s.attachments);
  pushGroup(
    s.me,
    s.conversationId,
    memberIds,
    { author: author?.displayName ?? '', group: conv?.title ?? '' },
    body,
    s.silent,
    conversationNotice(s, author, conv?.title ?? ''),
  );
}

/**
 * Пуш участникам группы (`groups2`, 07.10): кроме автора, заблокировавших его и выключивших «Уведомления из групп»
 * (`groupPushOff`, G38), один на получателя за окно; заглушка
 * группы (`push_mutes`: `dm_user` + `group:<id беседы>`, `groupRules.groupMuteTarget`) чтится, как заглушка человека в 1:1.
 * `notice` — поля уведомления-беседы (Р1, `conversationNotice`); у пачки пересылки их нет. Заголовок «Имя в «Название»»
 * собирается на получателя: имя автора — подпись из его контактов (решение владельца 08.10 п.27; один запрос на сообщение).
 */
function pushGroup(
  me: string,
  conversationId: string,
  memberIds: readonly string[],
  who: { author: string; group: string },
  body: string,
  silent: boolean,
  notice?: Partial<PushPayload>,
): void {
  void (async () => {
    const blockers = await blockedMe(me, memberIds);
    const groupsOff = await groupPushOff(memberIds, conversationId);
    const names = await contactNamesFor(me, memberIds.filter((id) => id !== me));
    for (const id of memberIds) {
      if (id === me || blockers.has(id) || groupsOff.has(id)) continue;
      const mode = await pushBurst(id, pushThrottleSource(conversationId, silent));
      if (mode === 'drop') continue;
      const name = pushNameFor(names, id, who.author);
      const title = groupPushTitle(name, who.group);
      const own = notice && notice.author !== undefined ? { ...notice, author: name } : notice;
      await sendPushToUsers(
        [id],
        withSilent({ type: 'dm', title, body, dmId: conversationId, ...own }, silent || mode === 'quiet'),
        { scope: 'dm_user', targetId: groupMuteTarget(conversationId) },
        mode === 'quiet' ? { burst: true } : {},
      );
    }
  })().catch(() => {});
}

/**
 * Поля уведомления беседы как у Telegram (Р1, G17, `PushPayload.author…ts`): автор — Person с аватаром, ключ и время
 * сообщения (история в одном уведомлении, «Пометить прочитанным»), у группы — её название заголовком. Аватар — только
 * http(s)-адрес (телефон сам скачает картинку). Старое приложение поля не знает.
 */
function conversationNotice(
  s: SentMessage,
  author: { displayName: string | null; avatarUrl: string | null } | undefined,
  groupTitle?: string,
): Pick<PushPayload, 'author' | 'authorId' | 'avatar' | 'group' | 'key' | 'mid' | 'ts'> {
  const avatar = author?.avatarUrl && /^https?:\/\//i.test(author.avatarUrl) ? author.avatarUrl : undefined;
  return {
    author: author?.displayName ?? '',
    authorId: s.me,
    ...(avatar ? { avatar } : {}),
    ...(groupTitle !== undefined ? { group: groupTitle } : {}),
    ...(typeof s.row.sortKey === 'number' ? { key: s.row.sortKey } : {}),
    mid: s.row.id,
    ts: s.row.createdAt.getTime(),
  };
}

/** Пересылка пачки в группу (`routes/conv.ts`): один пуш на пачку, как у 1:1; заголовок «Имя в «Название»». */
export function pushGroupPack(me: string, conversationId: string, memberIds: readonly string[], body: string, silent: boolean): void {
  void (async () => {
    const [author] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, me)).limit(1);
    const [conv] = await db.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    pushGroup(me, conversationId, memberIds, { author: author?.displayName ?? '', group: conv?.title ?? '' }, body, silent);
  })().catch(() => {});
}

/**
 * Кто из `ids` выключил «Уведомления из групп» (G38, `push2`, `users.notify_groups`) — им пуш группы не шлём. Как у
 * Telegram «Уведомления → Группы»: личные 1:1 приходят, как были, заглушка отдельной группы — `push_mutes`. Исключение
 * «Уведомления включены» этой группы (решение владельца 38, `push4`, `push_always`) пускает пуш и при выключенных группах.
 */
async function groupPushOff(ids: readonly string[], conversationId: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.notifyGroups, false)));
  if (rows.length === 0) return new Set();
  const always = await pushAlwaysUsers(
    rows.map((r) => r.id),
    groupMuteTarget(conversationId),
  );
  return new Set(rows.map((r) => r.id).filter((id) => !always.has(id)));
}

/** Кто из `ids` заблокировал `me` — им пуш из группы не шлём. */
async function blockedMe(me: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: userBlocks.blockerId })
    .from(userBlocks)
    .where(and(eq(userBlocks.blockedId, me), inArray(userBlocks.blockerId, [...ids])));
  return new Set(rows.map((r) => r.id));
}
