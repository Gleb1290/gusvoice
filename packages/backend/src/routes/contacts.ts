import { CONTACT_NAME_MAX, CONTACTS_MAX, type ContactList } from '@gusvoice/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { rateHit, retryMessage } from '../authGuard.js';
import { addContact, contactTarget, listContacts, removeContact, renameContact } from '../contacts.js';
import { deliver, journalMuteChange } from '../conversations.js';
import { requireLocalUser } from '../guestGuard.js';
import { publishToUser } from '../realtime.js';

/**
 * Контакты (08.10, #211, признак `contacts1`, решение владельца 08.10 п.7). Запись и чтение — `contacts.ts`. Каждая запись
 * отвечает списком целиком (`ContactList`), шлёт его моим устройствам событием `contacts.update` и — если с человеком есть
 * беседа 1:1 — свежую сводку этой беседы (плашка незнакомца у контакта гаснет, `strangerSql`). Гостю соседнего инстанса — 403:
 * у него здесь нет лички, а значит, и контактов.
 */
const userParams = z.object({ userId: z.string().min(1).max(64) });
// Подпись приходит до чистки (`cleanContactName` режет до предела), поэтому лимит тела — с запасом на пробелы и суррогаты.
const nameBody = z.string().max(CONTACT_NAME_MAX * 4).nullable();

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  async function limited(me: string, reply: FastifyReply): Promise<boolean> {
    const wait = await rateHit(`contacts:${me}`, 60, 300);
    if (!wait) return false;
    reply.code(429).send({ error: retryMessage(wait) });
    return true;
  }

  async function answer(me: string, peerId: string, conversationChanged: boolean): Promise<ContactList> {
    const contacts = await listContacts(me);
    await publishToUser(me, { t: 'contacts.update', contacts }).catch(() => {});
    if (conversationChanged) await deliver(await journalMuteChange(me, peerId)).catch(() => {});
    return { contacts };
  }

  app.get('/contacts', { preHandler: requireLocalUser }, async (req): Promise<ContactList> => {
    return { contacts: await listContacts(req.user!.sub) };
  });

  app.post('/contacts', { preHandler: requireLocalUser }, async (req, reply) => {
    const me = req.user!.sub;
    const body = z.object({ userId: z.string().min(1).max(64), name: nameBody.optional() }).parse(req.body);
    if (await limited(me, reply)) return;
    const bad = await contactTarget(me, body.userId);
    if (bad === 'self') return reply.code(400).send({ error: 'Себя в контакты не добавить', reason: 'contacts.self' });
    if (bad === 'not-found') return reply.code(404).send({ error: 'user not found' });
    if (bad === 'guest') return reply.code(400).send({ error: 'Гостя соседнего инстанса в контакты не добавить', reason: 'contacts.guest' });
    const res = await addContact(me, body.userId, body.name, CONTACTS_MAX);
    if (res.kind === 'limit') {
      return reply.code(400).send({ error: `У вас уже ${CONTACTS_MAX} контактов`, reason: 'contacts.limit', max: CONTACTS_MAX });
    }
    return answer(me, body.userId, res.added);
  });

  app.patch('/contacts/:userId', { preHandler: requireLocalUser }, async (req, reply) => {
    const me = req.user!.sub;
    const { userId } = userParams.parse(req.params);
    const { name } = z.object({ name: nameBody }).parse(req.body);
    if (await limited(me, reply)) return;
    if (!(await renameContact(me, userId, name))) return reply.code(404).send({ error: 'not a contact' });
    return answer(me, userId, false);
  });

  app.delete('/contacts/:userId', { preHandler: requireLocalUser }, async (req, reply) => {
    const me = req.user!.sub;
    const { userId } = userParams.parse(req.params);
    if (await limited(me, reply)) return;
    const removed = await removeContact(me, userId);
    return answer(me, userId, removed);
  });
}
