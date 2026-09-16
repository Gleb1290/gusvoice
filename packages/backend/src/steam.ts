// Steam game-activity source (#40 Phase 1B). Two responsibilities:
//  1) Account linking via Steam OpenID 2.0 (no API key needed for the auth handshake itself).
//  2) A background poller that reads linked+online users' current game via GetPlayerSummaries and
//     feeds it into the activity store as the authoritative 'steam' source.
// The whole feature self-disables when STEAM_API_KEY / STEAM_API_PUBLIC_URL aren't set.
import { and, eq, isNotNull } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import type { GameActivity } from '@gusvoice/shared';
import { setActivity } from './activity.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { env } from './env.js';
import { isUserOnline } from './gateway.js';

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';

export function steamEnabled(): boolean {
  return !!env.steam.apiKey && !!env.steam.apiPublicUrl;
}

function callbackUrl(): string {
  return `${env.steam.apiPublicUrl}/api/users/me/steam/callback`;
}

/** Sign a short-lived state token binding this link attempt to a userId (survives the OpenID redirect). */
export function signLinkState(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'steam-link' }, env.jwtSecret, { expiresIn: '10m' });
}
export function verifyLinkState(token: string): string | null {
  try {
    const c = jwt.verify(token, env.jwtSecret) as { sub?: string; typ?: string };
    return c.typ === 'steam-link' && c.sub ? c.sub : null;
  } catch {
    return null;
  }
}

/** Build the Steam OpenID redirect URL. `state` rides in return_to and comes back on the callback. */
export function buildAuthUrl(state: string): string {
  const returnTo = `${callbackUrl()}?state=${encodeURIComponent(state)}`;
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': env.steam.apiPublicUrl,
    'openid.identity': `${OPENID_NS}/identifier_select`,
    'openid.claimed_id': `${OPENID_NS}/identifier_select`,
  });
  return `${STEAM_OPENID}?${params.toString()}`;
}

/**
 * Verify a Steam OpenID callback: echo the openid.* params back to Steam with mode=check_authentication,
 * require `is_valid:true`, then extract the SteamID64 from claimed_id. Returns null on any failure.
 */
export async function verifyCallback(query: Record<string, string | undefined>): Promise<string | null> {
  const claimed = query['openid.claimed_id'];
  if (!claimed) return null;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (k.startsWith('openid.') && v != null) body.set(k, v);
  body.set('openid.mode', 'check_authentication');
  let text: string;
  try {
    const res = await fetch(STEAM_OPENID, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    text = await res.text();
  } catch {
    return null;
  }
  if (!/is_valid\s*:\s*true/i.test(text)) return null;
  const m = claimed.match(/\/openid\/id\/(\d{17})$/);
  return m ? m[1] : null;
}

type Summary = { steamid: string; personaname?: string; gameid?: string; gameextrainfo?: string };

async function getPlayerSummaries(steamIds: string[]): Promise<Summary[]> {
  if (!steamIds.length || !env.steam.apiKey) return [];
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.steam.apiKey}&steamids=${steamIds.join(',')}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { response?: { players?: Summary[] } };
    return data.response?.players ?? [];
  } catch {
    return [];
  }
}

/** Fetch one Steam persona name (shown in the settings UI right after linking). */
export async function fetchPersona(steamId: string): Promise<string | null> {
  const [p] = await getPlayerSummaries([steamId]);
  return p?.personaname ?? null;
}

// Poll linked+online users' Steam presence → push each into the activity store (authoritative source).
async function pollOnce(): Promise<void> {
  const linked = await db
    .select({ id: users.id, steamId: users.steamId })
    .from(users)
    .where(and(isNotNull(users.steamId), eq(users.showGameActivity, true)));
  const bySteam = new Map<string, string>(); // steamId -> userId, online only
  for (const u of linked) if (u.steamId && isUserOnline(u.id)) bySteam.set(u.steamId, u.id);
  const ids = [...bySteam.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const players = await getPlayerSummaries(batch);
    const seen = new Set<string>();
    for (const p of players) {
      const userId = bySteam.get(p.steamid);
      if (!userId) continue;
      seen.add(p.steamid);
      const game: GameActivity | null = p.gameextrainfo
        ? { name: p.gameextrainfo, appId: p.gameid ? Number(p.gameid) : undefined }
        : null;
      setActivity(userId, game, 'steam');
    }
    // Asked about but not returned (private profile / offline in Steam) → clear their steam source.
    for (const sid of batch) if (!seen.has(sid)) setActivity(bySteam.get(sid) as string, null, 'steam');
  }
}

export function startSteamPoller(): void {
  if (!steamEnabled()) return;
  setInterval(() => void pollOnce().catch(() => {}), 30_000).unref?.();
}
