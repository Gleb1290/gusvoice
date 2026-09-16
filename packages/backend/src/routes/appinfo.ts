import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { requireAuth } from '../auth.js';
import { env } from '../env.js';

/**
 * Authed app-info endpoints. The F-Droid repo add-link carries the repo's HTTP Basic-Auth
 * credentials, so it must NEVER be baked into the public client bundle (voice.<domain>/assets/*.js
 * is world-readable) — that would leak the password and defeat the gate. Instead we hand the link +
 * a QR data-URI to LOGGED-IN users only, at request time. The static guide text lives in the client.
 */
export async function appInfoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/app/fdroid', async (_req, reply) => {
    const { repoUrl, fingerprint, addUrl } = env.fdroid;
    if (!addUrl || !repoUrl || !fingerprint) return reply.code(503).send({ error: 'F-Droid репозиторий не настроен' });
    // addUrl already carries the URL-encoded basic-auth creds + ?fingerprint (built off-box, kept out
    // of the bundle). Scanning/opening it adds the repo with no typing.
    const qr = await QRCode.toDataURL(addUrl, { margin: 2, width: 320, errorCorrectionLevel: 'M' });
    return { repoUrl, fingerprint, addUrl, qr };
  });
}
