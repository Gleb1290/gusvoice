import type { FastifyInstance } from 'fastify';
import { loadStorageCatalog } from '../adminStorageCatalog.js';
import { createStorageReportReader, measureStorage } from '../adminStorageReport.js';
import { requireSuperAdmin } from '../auth.js';
import { listStoredObjects, ownPublicStorageKey, storageConfigured } from '../storage.js';

export async function adminStorageRoutes(app: FastifyInstance): Promise<void> {
  const read = createStorageReportReader(async () => {
    if (!storageConfigured()) throw new Error('storage not configured');
    const catalog = await loadStorageCatalog();
    return measureStorage(catalog, listStoredObjects(), ownPublicStorageKey);
  });

  app.get('/admin/storage', { preHandler: requireSuperAdmin }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return await read();
    } catch (error) {
      req.log.warn({ err: error }, 'Storage measurement failed');
      return reply.code(503).send({ error: 'Замер хранилища недоступен', measuredAt: null });
    }
  });
}
