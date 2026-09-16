import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { setActivity } from '../activity.js';
import { requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { env } from '../env.js';
import { serializeUser } from '../serialize.js';
import { buildAuthUrl, fetchPersona, signLinkState, steamEnabled, verifyCallback, verifyLinkState } from '../steam.js';

// Steam account linking (#40 Phase 1B). The link-url + unlink endpoints are Bearer-authed; the OpenID
// callback is a top-level browser redirect from Steam (no Bearer header), so its auth is carried in a
// short-lived signed `state` token minted by link-url.
export async function steamRoutes(app: FastifyInstance): Promise<void> {
  // Mint the Steam OpenID redirect URL for the current user (client then navigates the browser to it).
  app.post('/users/me/steam/link-url', { preHandler: requireAuth }, async (req, reply) => {
    if (!steamEnabled()) return reply.code(503).send({ error: 'Steam не настроен на этом сервере' });
    return { url: buildAuthUrl(signLinkState(req.user!.sub)) };
  });

  // Steam redirects the browser here after the user approves. Verify, store the SteamID, bounce back
  // to the web client with a status flag (no Bearer here — the user is identified by the signed state).
  app.get('/users/me/steam/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const back = (ok: boolean) => `${env.clientOrigin}/?steam=${ok ? 'linked' : 'error'}`;
    const userId = q.state ? verifyLinkState(q.state) : null;
    if (!userId || !steamEnabled()) return reply.redirect(back(false));
    const steamId = await verifyCallback(q);
    if (!steamId) return reply.redirect(back(false));
    const persona = await fetchPersona(steamId).catch(() => null);
    await db.update(users).set({ steamId, steamPersona: persona }).where(eq(users.id, userId));
    return reply.redirect(back(true));
  });

  // Unlink: clear the SteamID + persona and drop any Steam-sourced activity right away (a live local
  // desktop-detect report, if any, keeps showing).
  app.delete('/users/me/steam', { preHandler: requireAuth }, async (req) => {
    const [row] = await db
      .update(users)
      .set({ steamId: null, steamPersona: null })
      .where(eq(users.id, req.user!.sub))
      .returning();
    setActivity(req.user!.sub, null, 'steam');
    return serializeUser(row);
  });
}
