import type { ContactRow } from '@gusvoice/shared';
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { cleanContactName } from './contactRules.js';
import { db } from './db/index.js';
import { userContacts, users } from './db/schema.js';

/**
 * Контакты (08.10, #211, признак `contacts1`, решение владельца 08.10 п.7; Telegram: `contacts.addContact` /
 * `contacts.deleteContacts`, `EditContactBox`). Список личный: человек не узнаёт, что он у меня в контактах. Правила имени
 * и пределы — `contactRules.ts`; ручки и событие `contacts.update` — `routes/contacts.ts`.
 */

/** Мои контакты с профилями: по моей подписи, иначе по их имени (как список контактов Telegram по алфавиту). */
export async function listContacts(me: string): Promise<ContactRow[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      name: userContacts.name,
      addedAt: userContacts.createdAt,
    })
    .from(userContacts)
    .innerJoin(users, eq(users.id, userContacts.contactId))
    .where(and(eq(userContacts.ownerId, me), isNull(users.deletedAt)))
    .orderBy(asc(userContacts.createdAt));
  return rows
    .map((r) => ({ ...r, addedAt: r.addedAt.toISOString() }))
    .sort((a, b) => (a.name ?? a.displayName).localeCompare(b.name ?? b.displayName, 'ru'));
}

export type ContactTargetError = 'self' | 'not-found' | 'guest';

/** Кого можно добавить: живой свой человек инстанса, не я. Гость соседнего инстанса — нет (личка с ним закрыта, §5.8). */
export async function contactTarget(me: string, userId: string): Promise<ContactTargetError | null> {
  if (userId === me) return 'self';
  const [row] = await db
    .select({ deletedAt: users.deletedAt, home: users.homeInstanceId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || row.deletedAt) return 'not-found';
  if (row.home !== null) return 'guest';
  return null;
}

export type AddContactResult = { kind: 'ok'; added: boolean } | { kind: 'limit' };

/**
 * Добавить (повтор — не ошибка). `name === undefined` — подпись не трогается (новый контакт — без подписи); строка — новая
 * подпись (пустая после чистки — снова его имя).
 */
export async function addContact(me: string, userId: string, name: string | null | undefined, max: number): Promise<AddContactResult> {
  const clean = name === undefined ? undefined : cleanContactName(name);
  return db.transaction(async (tx): Promise<AddContactResult> => {
    const [had] = await tx
      .select({ id: userContacts.contactId })
      .from(userContacts)
      .where(and(eq(userContacts.ownerId, me), eq(userContacts.contactId, userId)))
      .limit(1);
    if (had) {
      if (clean !== undefined) {
        await tx
          .update(userContacts)
          .set({ name: clean })
          .where(and(eq(userContacts.ownerId, me), eq(userContacts.contactId, userId)));
      }
      return { kind: 'ok', added: false };
    }
    const [{ n }] = await tx.select({ n: count() }).from(userContacts).where(eq(userContacts.ownerId, me));
    if (Number(n) >= max) return { kind: 'limit' };
    await tx
      .insert(userContacts)
      .values({ ownerId: me, contactId: userId, name: clean ?? null })
      .onConflictDoNothing();
    return { kind: 'ok', added: true };
  });
}

/** Переименовать. Не в контактах — `false`. */
export async function renameContact(me: string, userId: string, name: string | null): Promise<boolean> {
  const rows = await db
    .update(userContacts)
    .set({ name: cleanContactName(name) })
    .where(and(eq(userContacts.ownerId, me), eq(userContacts.contactId, userId)))
    .returning({ id: userContacts.contactId });
  return rows.length > 0;
}

/** Убрать. Не было — `false` (ручка всё равно отвечает списком: повтор с другого устройства не ошибка). */
export async function removeContact(me: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(userContacts)
    .where(and(eq(userContacts.ownerId, me), eq(userContacts.contactId, userId)))
    .returning({ id: userContacts.contactId });
  return rows.length > 0;
}

/** `owner` держит `contact` в контактах? Для будущих правил приватности «Мои контакты». */
export async function isContactOf(ownerId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userContacts.contactId })
    .from(userContacts)
    .where(and(eq(userContacts.ownerId, ownerId), eq(userContacts.contactId, contactId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Подписи человека `contactId` в контактах получателей пуша (решение владельца 08.10 п.27: подпись контакта заменяет имя везде в
 * ЛС, и в уведомлении тоже — как Telegram). Один запрос на сообщение по индексу `user_contacts_contact_idx` (`contact_id`,
 * `owner_id`), не на получателя; строки без подписи (`name` пусто) — мимо: у них в пуше собственное имя автора.
 */
export async function contactNamesFor(contactId: string, ownerIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ownerIds.length === 0) return out;
  const rows = await db
    .select({ ownerId: userContacts.ownerId, name: userContacts.name })
    .from(userContacts)
    .where(and(eq(userContacts.contactId, contactId), inArray(userContacts.ownerId, [...new Set(ownerIds)])));
  for (const r of rows) if (r.name && r.name.trim()) out.set(r.ownerId, r.name);
  return out;
}
