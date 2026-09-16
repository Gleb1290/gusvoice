import {
  FAIL_WINDOW_S,
  LEVEL_TTL_S,
  loginKey,
  lockoutSeconds,
  lockTriggered,
  MAX_FAILS,
  retryAfter,
} from './authRules.js';
import { realClientIp } from '@gusvoice/shared';
import type { FastifyRequest } from 'fastify';
import { adminAlertEmail } from './instanceSetup.js';
import { sendLoginBruteforceAlert } from './mailer.js';
import { redisPub as redis } from './realtime.js';

// Чистые пороги и ключи — в `authRules.ts`. Реэкспорт, чтобы роуты брали `retryMessage` отсюда.
export { retryMessage } from './authRules.js';

// Rate limiting for the PUBLIC auth endpoints (pre-auth → keyed by IP; login also by
// IP+username). Mirrors inviteGuard.ts: Redis counters, an escalating lockout on password
// brute-force (15 → 30 → 45 … min) and an operator email on each trip. The per-code attempt
// caps (verify/reset MAX_ATTEMPTS, 2FA fail window) stay in auth.ts — this layer only adds
// the missing per-IP ceilings + the password lockout.

/**
 * Real client IP behind the reverse proxy — the key of every per-IP limit. Read right-to-left, trusting only hops from
 * internal networks: the FIRST x-forwarded-for entry is written by the client itself (see `shared/clientIp.ts`).
 */
export function clientIp(req: FastifyRequest): string {
  return realClientIp(req.headers['x-forwarded-for'], req.ip);
}

/**
 * Count one hit against a fixed window. Returns 0 while under the limit, otherwise the
 * seconds until the window resets (use as retry-after).
 */
export async function rateHit(key: string, max: number, windowS: number): Promise<number> {
  const k = `rl:${key}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowS);
  if (count <= max) return 0;
  return retryAfter(count, max, await redis.ttl(k), windowS);
}

// --- Message send rate-limit + push debounce (#5, P1-3). Shared by channel messages AND DMs so the
// budget can't be doubled by alternating between them.
const SEND_MAX = 20; // messages per window per user
const SEND_WINDOW_S = 10;
const PUSH_THROTTLE_S = 20; // one push per (recipient, source) per window — kills push-bombing bursts

/** Rate-limit a user's outbound messages (channels + DMs share one budget). Returns retry-after
 *  seconds if over the limit (answer 429), else 0. */
export function messageSendBlock(userId: string): Promise<number> {
  return rateHit(`send:${userId}`, SEND_MAX, SEND_WINDOW_S);
}

/** Push debounce: true if a push to `recipient` from `source` (channel id / DM sender id) already
 *  fired within PUSH_THROTTLE_S — so a burst of messages yields ONE push, not one per message. */
export async function pushDebounced(recipient: string, source: string): Promise<boolean> {
  return (await rateHit(`push:${recipient}:${source}`, 1, PUSH_THROTTLE_S)) !== 0;
}

/** Rate-limit attachment uploads per user (storage-exhaustion DoS, P2-3): each upload writes to the
 *  shared MinIO bucket immediately, so an unbounded loop could fill the disk. Returns retry-after
 *  seconds if over the limit, else 0. (Operator should ALSO set a bucket quota — see playbook §3.10.) */
export function attachmentUploadBlock(userId: string): Promise<number> {
  return rateHit(`upload:${userId}`, 15, 60);
}

/** Cheap per-user rate-limit for EXPENSIVE authed reads (full member dumps, content search) — an authed
 *  user shouldn't be able to loop them to hammer Postgres (P2-2). Generous for humans, curbs loops.
 *  Returns retry-after seconds if over the limit, else 0. */
export function heavyReadBlock(userId: string): Promise<number> {
  return rateHit(`hget:${userId}`, 40, 10);
}

// --- Password brute-force lockout. Пороги, ключ ip+username и ступень — в `authRules.ts`.
const failKey = (k: string) => `lg:fail:${k}`;
const lvlKey = (k: string) => `lg:lvl:${k}`;
const lockKey = (k: string) => `lg:lock:${k}`;

/** Remaining lockout in SECONDS for this ip+username if blocked, else 0. */
export async function loginLockRemaining(ip: string, username: string): Promise<number> {
  const ttl = await redis.ttl(lockKey(loginKey(ip, username)));
  return ttl > 0 ? ttl : 0;
}

/** Wipe the failure counter + escalation level after a successful login. */
export async function clearLoginFailures(ip: string, username: string): Promise<void> {
  const k = loginKey(ip, username);
  await redis.del(failKey(k), lvlKey(k));
}

/**
 * Fully lift a login lockout — counter + escalation level + the active lock — for this ip+username.
 * Used after a PROVEN password reset (the emailed code proves ownership): the legitimate owner must
 * not stay locked out of their own account by wrong-password attempts that predate the reset, else
 * the stale lock rejects even the correct new password until it expires.
 */
export async function clearLoginLock(ip: string, username: string): Promise<void> {
  const k = loginKey(ip, username);
  await redis.del(failKey(k), lvlKey(k), lockKey(k));
}

/**
 * Record one failed login (wrong password OR unknown username — both feed enumeration).
 * Returns the lockout duration in SECONDS if this attempt just tripped a lockout, else 0.
 */
export async function recordLoginFailure(ip: string, username: string): Promise<number> {
  const k = loginKey(ip, username);
  const fails = await redis.incr(failKey(k));
  if (fails === 1) await redis.expire(failKey(k), FAIL_WINDOW_S);
  if (!lockTriggered(fails)) return 0;

  const level = await redis.incr(lvlKey(k));
  await redis.expire(lvlKey(k), LEVEL_TTL_S);
  const lockSeconds = lockoutSeconds(level);
  await redis.set(lockKey(k), '1', 'EX', lockSeconds);
  await redis.del(failKey(k));

  void notifyAdmin(username, ip, MAX_FAILS, level, lockSeconds / 60);
  return lockSeconds;
}

async function notifyAdmin(username: string, ip: string, attempts: number, level: number, minutes: number): Promise<void> {
  try {
    await sendLoginBruteforceAlert(await adminAlertEmail(), { username, ip: ip || 'unknown', attempts, level, minutes });
  } catch (err) {
    console.error('[authGuard] admin alert failed:', (err as Error).message);
  }
}
