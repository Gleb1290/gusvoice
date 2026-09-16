import { mentionedNames } from '@gusvoice/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { pushDevices, pushMutes, serverMembers, users } from './db/schema.js';
import { env } from './env.js';
import { endpointAllowed } from './pushRules.js';
import { id } from './util.js';

// Чистые правила — в `pushRules.ts`. Реэкспорт, чтобы роуты продолжали брать `contentPreview`
// из `push.js` (там же рядом `sendPushToUsers`, который они и зовут).
export { contentPreview } from './pushRules.js';

/**
 * A background-wake push payload. Delivered as the raw POST body to a device's UnifiedPush endpoint;
 * the Android receiver parses this JSON and builds the local notification (so it works even when the
 * app process is dead). Web/desktop already notify in-app via the Notification path — this is Android.
 */
export interface PushPayload {
  type: 'dm' | 'mention';
  title: string;
  body: string;
  dmId?: string;
  channelId?: string;
  serverId?: string;
}

export type PushMuteScope = 'server' | 'dm_user';

/**
 * Where a push originates, so recipients who muted that source get filtered out before we wake their
 * phone. `server` => the @mention's server; `dm_user` => the DM author. See sendPushToUsers.
 */
export interface PushSource {
  scope: PushMuteScope;
  targetId: string;
}

const NTFY_BASE = env.ntfy.baseUrl; // e.g. https://ntfy.example.com
const NTFY_TOKEN = env.ntfy.token;

/** `endpointAllowed` с нашей базой ntfy — единственный заслон от SSRF (endpoint приходит с устройства). */
export function pushEndpointAllowed(endpoint: string): boolean {
  return endpointAllowed(endpoint, NTFY_BASE);
}

/** Upsert a device's UnifiedPush endpoint for a user (one row per user+device). */
export async function registerPushDevice(
  userId: string,
  deviceId: string,
  endpoint: string,
  platform: string | null,
): Promise<void> {
  await db
    .insert(pushDevices)
    .values({ id: id(), userId, deviceId, endpoint, platform, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [pushDevices.userId, pushDevices.deviceId],
      set: { endpoint, platform, updatedAt: new Date() },
    });
}

export async function unregisterPushDevice(userId: string, deviceId: string): Promise<void> {
  await db.delete(pushDevices).where(and(eq(pushDevices.userId, userId), eq(pushDevices.deviceId, deviceId)));
}

/**
 * Best-effort: POST a wake payload to every registered device of each recipient, REGARDLESS of whether
 * they're online elsewhere — so a DM/@mention still buzzes your phone while you sit at the desktop.
 * Fire-and-forget — never blocks or throws into the message path. (Per-device foreground suppression —
 * so the phone doesn't double-notify while you're actively in the app on it — is a device-side follow-up.)
 *
 * `source` (optional) lets recipients opt out per-source: any recipient with a matching push_mute row
 * (e.g. muted this server, or muted DMs from this person) is dropped before their phone is woken.
 */
export async function sendPushToUsers(
  recipientIds: string[],
  payload: PushPayload,
  source?: PushSource,
): Promise<void> {
  if (!NTFY_BASE || !NTFY_TOKEN) return; // push not configured
  let ids = [...new Set(recipientIds)];
  if (ids.length === 0) return;
  if (source) {
    const muted = await db
      .select({ userId: pushMutes.userId })
      .from(pushMutes)
      .where(
        and(
          inArray(pushMutes.userId, ids),
          eq(pushMutes.scope, source.scope),
          eq(pushMutes.targetId, source.targetId),
        ),
      );
    if (muted.length > 0) {
      const drop = new Set(muted.map((m) => m.userId));
      ids = ids.filter((uid) => !drop.has(uid));
      if (ids.length === 0) return;
    }
  }
  const devices = await db.select().from(pushDevices).where(inArray(pushDevices.userId, ids));
  if (devices.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    devices.map(async (d) => {
      if (!pushEndpointAllowed(d.endpoint)) return;
      try {
        const res = await fetch(d.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NTFY_TOKEN}` },
          body,
          redirect: 'manual', // SSRF (P2-5): NEVER follow a 3xx into the internal network
        });
        // A redirect (3xx) from a push endpoint is anomalous/malicious — don't follow it, drop the
        // device. Topic gone / payload too large (404/413) => stale registration, also drop.
        const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
        if (redirected || res.status === 404 || res.status === 413) {
          await db.delete(pushDevices).where(eq(pushDevices.id, d.id)).catch(() => {});
        }
      } catch {
        /* best-effort; the message itself already delivered over the gateway */
      }
    }),
  );
}

/**
 * Resolve @username mentions in `content` to member userIds of `serverId` (excluding the author).
 *
 * ⚠️ Имена достаёт ОБЩЕЕ правило (`shared/mentions.ts`), то же самое, по которому клиент решает
 * звенеть ли звуком. Своя регулярка тут была и расходилась с клиентской: `@super.` в конце
 * предложения превращалось в имя «super.», такого пользователя в базе нет, и пуш не уходил —
 * при том что на десктопе упоминание отрабатывало.
 */
export async function resolveMentionedMembers(
  content: string,
  serverId: string,
  authorId: string,
): Promise<string[]> {
  const names = mentionedNames(content);
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(serverMembers, and(eq(serverMembers.userId, users.id), eq(serverMembers.serverId, serverId)))
    .where(inArray(sql`lower(${users.username})`, names));
  return rows.map((r) => r.id).filter((uid) => uid !== authorId);
}

/** List a user's active push-mute rules (for bootstrap / settings UI). */
export async function listPushMutes(userId: string): Promise<{ scope: PushMuteScope; targetId: string }[]> {
  const rows = await db
    .select({ scope: pushMutes.scope, targetId: pushMutes.targetId })
    .from(pushMutes)
    .where(eq(pushMutes.userId, userId));
  return rows.map((r) => ({ scope: r.scope as PushMuteScope, targetId: r.targetId }));
}

/** Mute pushes from a source (server or DM-person) for this user. Idempotent. */
export async function setPushMute(userId: string, scope: PushMuteScope, targetId: string): Promise<void> {
  await db.insert(pushMutes).values({ userId, scope, targetId }).onConflictDoNothing();
}

/** Un-mute a previously muted source. */
export async function removePushMute(userId: string, scope: PushMuteScope, targetId: string): Promise<void> {
  await db
    .delete(pushMutes)
    .where(and(eq(pushMutes.userId, userId), eq(pushMutes.scope, scope), eq(pushMutes.targetId, targetId)));
}
