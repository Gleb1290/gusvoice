import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fedId, realClientIp } from '@gusvoice/shared';
import { parseRange, servedContentType } from '../attachmentRules.js';
import { attachmentStore } from '../attachments.js';
import { fedAttachmentForPeer } from '../federation/convAtt.js';
import { fedRateBlock } from '../federation/guardsRuntime.js';
import { authenticateLinkedPeer } from '../federation/peerAuth.js';
import { createAdmitPeer } from './fedAdmission.js';

/**
 * ЛС между инстансами, Э3 часть 1 (#141, §3.5, признак `dm2`): файл вложения соседу — `GET /fed/v1/att/:id`.
 * Отдельным модулем, а не в `routes/federation.ts`: тот проверки собирают с явным перечнем зависимостей, а этому нужны
 * хранилище и правила вложений. Регистрирует `index.ts` только при `FEDERATION_ENABLED` и `FEDERATION_DM_ENABLED` (иначе 404).
 * Допуск соседа — тот же `createAdmitPeer` (предел по адресу до подписи, подпись связки, предел `attachment` по связке).
 */
const admitPeer = createAdmitPeer({
  rateBlock: (kind, who) => fedRateBlock(kind, who),
  authenticate: (req, instanceId, opts) => authenticateLinkedPeer(req, instanceId, opts),
  clientIp: (req: FastifyRequest) => realClientIp(req.headers['x-forwarded-for'], req.ip),
});

export async function fedAttRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Файл вложения ЛС соседу (Э3 часть 1, §3.5, признак `dm2`): подписанный GET связанного соседа — право. Отдаётся только
   * файл нашего человека из беседы, где есть участник спрашивающего инстанса, и не из надгробия (`fedAttachmentForPeer`);
   * иначе 404 без различия причин. Поток из закрытого бакета; `Range` → 206 (`Content-Range`), без него — 200.
   */
  app.get('/fed/v1/att/:id', { exposeHeadRoute: false }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const link = await admitPeer(req, reply, q.instance_id, 'attachment', { requireActive: true });
    if (!link) return;
    const notFound = () => reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not found' });
    const id = fedId((req.params as { id?: unknown }).id);
    if (!id || !attachmentStore.configured()) return notFound();
    const att = await fedAttachmentForPeer(link.instanceId, id);
    if (!att) return notFound();
    const st = await attachmentStore.stat(att.storageKey);
    if (!st) return notFound();
    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      return reply.code(416).headers({ 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' }).send();
    }
    reply.headers({
      'Content-Type': servedContentType(att.contentType),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    });
    if (range) {
      reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
        .header('Content-Length', String(range.end - range.start + 1));
    } else {
      reply.header('Content-Length', String(st.size));
    }
    return reply.send(await attachmentStore.get(att.storageKey, range ?? undefined));
  });
}
