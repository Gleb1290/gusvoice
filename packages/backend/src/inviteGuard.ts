import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { adminAlertEmail } from './instanceSetup.js';
import { sendInviteBruteforceAlert } from './mailer.js';
import { redisPub as redis } from './realtime.js';

// Brute-force protection for server invite codes. Keyed per user (joining requires auth):
// after MAX_FAILS wrong codes the user is locked out of joining for `level * STEP_MIN` minutes,
// escalating every subsequent lockout (15 → 30 → 45 …). The admin is emailed on each trip.
const MAX_FAILS = 5;
const FAIL_WINDOW_S = 15 * 60; // wrong attempts must fall inside this sliding window to add up
const LEVEL_TTL_S = 24 * 60 * 60; // escalation memory — a full quiet day resets you to 15 min
const STEP_MIN = 15;

const failKey = (id: string) => `iv:fail:${id}`;
const lvlKey = (id: string) => `iv:lvl:${id}`;
const lockKey = (id: string) => `iv:lock:${id}`;

/** Remaining lockout in SECONDS if the user is currently blocked from joining, else 0. */
export async function inviteLockRemaining(userId: string): Promise<number> {
  const ttl = await redis.ttl(lockKey(userId));
  return ttl > 0 ? ttl : 0;
}

/** Wipe the failure counter + escalation level after a legitimate join. */
export async function clearInviteFailures(userId: string): Promise<void> {
  await redis.del(failKey(userId), lvlKey(userId));
}

/**
 * Record one wrong invite-code attempt. Returns the lockout duration in SECONDS if this attempt
 * just tripped a lockout (so the caller answers 429), or 0 if the user is still under the limit.
 */
export async function recordInviteFailure(userId: string, ip: string): Promise<number> {
  const fails = await redis.incr(failKey(userId));
  if (fails === 1) await redis.expire(failKey(userId), FAIL_WINDOW_S);
  if (fails < MAX_FAILS) return 0;

  // Tripped: escalate the level, lock for level*15 min, reset the per-window counter.
  const level = await redis.incr(lvlKey(userId));
  await redis.expire(lvlKey(userId), LEVEL_TTL_S);
  const minutes = level * STEP_MIN;
  const lockSeconds = minutes * 60;
  await redis.set(lockKey(userId), '1', 'EX', lockSeconds);
  await redis.del(failKey(userId));

  void notifyAdmin(userId, ip, MAX_FAILS, level, minutes);
  return lockSeconds;
}

async function notifyAdmin(
  userId: string,
  ip: string,
  attempts: number,
  level: number,
  minutes: number,
): Promise<void> {
  try {
    const [u] = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    await sendInviteBruteforceAlert(await adminAlertEmail(), {
      username: u?.username ?? userId,
      email: u?.email ?? '—',
      userId,
      ip: ip || 'unknown',
      attempts,
      level,
      minutes,
    });
  } catch (err) {
    console.error('[inviteGuard] admin alert failed:', (err as Error).message);
  }
}
