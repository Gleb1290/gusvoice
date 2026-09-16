import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { minio } from '../storage.js';

/** Read the Tauri updater feed (latest.json) and pull out the current Windows installer + version. */
async function latestWindows(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch(env.updateFeedUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown; platforms?: Record<string, { url?: unknown }> };
    const url = data.platforms?.['windows-x86_64']?.url;
    if (typeof url !== 'string' || !url) return null;
    return { version: typeof data.version === 'string' ? data.version : '', url };
  } catch {
    return null;
  }
}

/**
 * Public (NO requireAuth) download endpoints — a prospective user needs the desktop installer
 * before they have an account, so these work unauthenticated. They read the updater feed so the
 * link always points at the newest signed release with zero per-release edits.
 */
export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/download/latest', async (_req, reply) => {
    const info = await latestWindows();
    if (!info) return reply.code(503).send({ error: 'сборка недоступна' });
    return { version: info.version, windows: info.url };
  });

  app.get('/download/windows', async (_req, reply) => {
    const info = await latestWindows();
    if (!info) return reply.code(503).send({ error: 'сборка недоступна' });
    return reply.redirect(info.url); // 302 to the current signed -setup.exe on MinIO
  });

  // Forced download for chat attachments. Streams the object from MinIO with
  // Content-Disposition: attachment so the browser SAVES it instead of navigating — the
  // <a download> attribute is ignored cross-origin (media.<domain> ≠ voice.<domain>),
  // which is why the chat "download" affordances never worked. Public like the bucket
  // itself (an <a href> can't carry the bearer token); the key regex pins reads to the
  // attachments/ prefix — no traversal, no other prefixes.
  const attachmentQuery = z.object({
    key: z.string().regex(/^attachments\/[A-Za-z0-9._-]{1,200}$/),
    name: z.string().min(1).max(300).optional(),
  });
  app.get('/download/attachment', async (req, reply) => {
    const q = attachmentQuery.parse(req.query);
    if (!minio) return reply.code(503).send({ error: 'storage not configured' });
    try {
      const stat = await minio.statObject(env.minio.bucket, q.key);
      const stream = await minio.getObject(env.minio.bucket, q.key);
      // RFC 5987 filename* carries UTF-8 names; strip header-breaking chars just in case.
      const name = (q.name ?? q.key.split('/').pop() ?? 'file').replace(/[\r\n"\\]/g, '_');
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', stat.size)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .header('Cache-Control', 'private, max-age=3600')
        .send(stream);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });
}
