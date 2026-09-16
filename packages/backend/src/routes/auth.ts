import type { AuthResponse, RegisterResponse } from '@gusvoice/shared';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { anonymizeAccount } from '../accountDelete.js';
import { accountDeleteBlock, isReservedUsername } from '../accountRules.js';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { bumpTokenGeneration, hashPassword, isSuperAdmin, requireAuth, signChallengeToken, signToken, superAdminId, verifyPassword, verifyToken } from '../auth.js';
import { clearLoginFailures, clearLoginLock, clientIp, loginLockRemaining, rateHit, recordLoginFailure, retryMessage } from '../authGuard.js';
import { db } from '../db/index.js';
import { emailVerifications, invites, passwordResets, servers, users } from '../db/schema.js';
import { env } from '../env.js';
import { sendPasswordResetCode, sendVerificationCode } from '../mailer.js';
import { registrationPolicy } from '../instanceSetup.js';
import { isInviteSpent } from '../inviteRules.js';
import { isSmtpConfigured } from '../settings.js';
import { decideRegistration, loginGate, PENDING_APPROVAL_ERROR, type InviteCheck } from '../setupRules.js';
import { redisPub } from '../realtime.js';
import { serializeUser } from '../serialize.js';
import { generateBackupCodes, generateTotpSecret, normalizeBackupCode, otpauthUri, verifyTotp, verifyTotpCounter } from '../totp.js';
import { id, verificationCode } from '../util.js';

const MAX_2FA_FAILS = 8;
const FAIL_WINDOW_S = 600;

/**
 * If `code` matches an unused backup-code hash, remove that hash (single-use) and return true.
 * Atomic (P3-4): the user row is locked FOR UPDATE inside a transaction so two concurrent logins
 * can't both spend the same one-time code (read-modify-write race → double use).
 */
async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const norm = normalizeBackupCode(code);
  if (!norm) return false;
  return db.transaction(async (tx) => {
    const [u] = await tx
      .select({ codes: users.totpBackupCodes })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    const hashes = u?.codes;
    if (!hashes?.length) return false;
    for (const h of hashes) {
      if (await verifyPassword(norm, h)) {
        await tx.update(users).set({ totpBackupCodes: hashes.filter((x) => x !== h) }).where(eq(users.id, userId));
        return true;
      }
    }
    return false;
  });
}

/**
 * TOTP verify with anti-replay (P3-1): rejects a code whose 30s step was already accepted for this
 * user — a valid code stays live ~90s across 3 steps, so without this a shoulder-surfed/phished code
 * could be replayed to log in. Last-accepted counter kept in Redis (auto-expires past the drift window).
 */
async function verifyTotpFresh(userId: string, code: string, secret: string): Promise<boolean> {
  const counter = verifyTotpCounter(code, secret);
  if (counter === null) return false;
  const key = `totp:used:${userId}`;
  const last = await redisPub.get(key);
  if (last !== null && counter <= Number(last)) return false; // replay of an already-accepted step
  await redisPub.set(key, String(counter), 'EX', 180); // > ±90s drift window
  return true;
}

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 6;

export const registerBody = z.object({
  username: z
    .string()
    .min(3, 'Имя пользователя: минимум 3 символа')
    .max(32, 'Имя пользователя: максимум 32 символа')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Имя пользователя: только латиница, цифры и . _ -'),
  email: z.string().email('Введите корректный email').max(254, 'Слишком длинный email'),
  password: z.string().min(6, 'Пароль: минимум 6 символов').max(128, 'Пароль: максимум 128 символов'),
  displayName: z.string().min(1).max(64, 'Отображаемое имя: максимум 64 символа').optional(),
});

const loginBody = z.object({ username: z.string(), password: z.string() });
const verifyBody = z.object({ identifier: z.string(), code: z.string().regex(/^\d{6}$/) });
const resendBody = z.object({ identifier: z.string() });
// A 2FA code is either a 6-digit TOTP or a backup code like "a1b2-c3d4".
const anyCode = z.string().min(4).max(20);
const totpLoginBody = z.object({ challenge: z.string(), code: anyCode });
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/) });
const disableBody = z.object({ password: z.string(), code: anyCode });
const passwordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(6, 'Пароль: минимум 6 символов').max(128, 'Пароль: максимум 128 символов'),
});

async function issueCode(userId: string, email: string, displayName: string): Promise<void> {
  const code = verificationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db
    .insert(emailVerifications)
    .values({ userId, code, expiresAt, attempts: 0, sentAt: new Date() })
    .onConflictDoUpdate({
      target: emailVerifications.userId,
      set: { code, expiresAt, attempts: 0, sentAt: new Date() },
    });
  // Deliver OUT OF BAND: the code is already persisted, so verification works regardless of when the
  // mail actually leaves. Awaiting the SMTP handshake here would hold the HTTP response open for
  // seconds and freeze the client UI. Fire-and-forget with error logging; the user has a "resend".
  void sendVerificationCode(email, code, displayName).catch((err) =>
    console.error(`[auth] verification email to ${email} failed:`, (err as Error).message),
  );
}

async function issueResetCode(userId: string, email: string, displayName: string): Promise<void> {
  const code = verificationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db
    .insert(passwordResets)
    .values({ userId, code, expiresAt, attempts: 0, sentAt: new Date() })
    .onConflictDoUpdate({
      target: passwordResets.userId,
      set: { code, expiresAt, attempts: 0, sentAt: new Date() },
    });
  // See issueCode: deliver out of band so the SMTP round-trip never blocks the response / freezes the UI.
  void sendPasswordResetCode(email, code, displayName).catch((err) =>
    console.error(`[auth] password-reset email to ${email} failed:`, (err as Error).message),
  );
}

const forgotBody = z.object({ email: z.string().email() });
const resetBody = z.object({
  identifier: z.string(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(6, 'Пароль: минимум 6 символов').max(128, 'Пароль: максимум 128 символов'),
});
const changeEmailBody = z.object({
  newEmail: z.string().email('Введите корректный email').max(254),
  password: z.string(),
});

/**
 * Look up a user by username OR email, CASE-INSENSITIVELY (+ trimmed). Login/verify/reset all go
 * through here, so a user can sign in with either identifier in any casing — the historical
 * username-only, case-sensitive match silently rejected valid credentials (e.g. the email, or a
 * differently-cased username), which read to the user as "wrong password". Registration enforces
 * case-insensitive uniqueness too (see /auth/register), so this stays unambiguous.
 */
function findByIdentifier(identifier: string) {
  const needle = identifier.trim().toLowerCase();
  // Удалённые (обезличенные) аккаунты не находятся ни для входа, ни для кода, ни для сброса (F0 #139).
  return db
    .select()
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        or(sql`lower(${users.username}) = ${needle}`, sql`lower(${users.email}) = ${needle}`),
      ),
    )
    .limit(1);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Register: creates an unverified user and emails a 6-digit code. No token yet.
  app.post('/auth/register', async (req, reply) => {
    const body = registerBody.extend({ inviteCode: z.string().trim().max(64).optional() }).parse(req.body);
    // Свежий инстанс, мастер установки ещё не пройден (#142): регистрироваться некуда — политику и админа
    // задаёт тот, у кого код установки. Только при заданном SETUP_TOKEN: у прода и старых коробок его нет.
    if (env.setupToken.trim() && !superAdminId()) {
      return reply.code(503).send({ error: 'Инстанс ещё не настроен — зайдите позже', reason: 'setup_required' });
    }
    // Логины удалённых аккаунтов зарезервированы: иначе можно выдавать себя за удалённого (F0 #139).
    if (isReservedUsername(body.username)) return reply.code(400).send({ error: 'Это имя пользователя занято' });
    // Per-IP ceiling: each register creates a row + sends an email.
    const limited = await rateHit(`register:${clientIp(req)}`, 10, 60 * 60);
    if (limited) return reply.code(429).send({ error: retryMessage(limited) });
    // Instance-wide ceiling on top of the per-IP one: an IP-rotating botnet gets a fresh register:<ip>
    // counter per address, but every signup still lands in this single global window. Checked after the
    // per-IP trip so one abusive IP (already blocked above) doesn't burn the global budget.
    const globalLimited = await rateHit('register:global', env.registerGlobalMax, 60 * 60);
    if (globalLimited) return reply.code(429).send({ error: retryMessage(globalLimited) });
    // Case-insensitive uniqueness so "Bob"/"bob" (or mixed-case emails) can't both register —
    // that would make the case-insensitive login lookup ambiguous.
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          sql`lower(${users.username}) = ${body.username.trim().toLowerCase()}`,
          sql`lower(${users.email}) = ${body.email.trim().toLowerCase()}`,
        ),
      )
      .limit(1);
    if (clash.length) return reply.code(409).send({ error: 'username or email already in use' });

    // Политика регистрации инстанса (#142). Код приглашения здесь только ПРОВЕРЯЕТСЯ: на сервер человек
    // вступает после первого входа обычной ручкой приглашения (там считаются использования и баны).
    let invite: InviteCheck = 'none';
    if (body.inviteCode) {
      const [inv] = await db.select().from(invites).where(eq(invites.code, body.inviteCode)).limit(1);
      invite = !inv ? 'invalid' : isInviteSpent(inv, Date.now()) ? 'spent' : 'valid';
    }
    const smtp = await isSmtpConfigured();
    const decision = decideRegistration({ policy: await registrationPolicy(), smtpConfigured: smtp, invite });
    if (!decision.ok) return reply.code(decision.status).send({ error: decision.error, reason: decision.reason });

    const [row] = await db
      .insert(users)
      .values({
        id: id(),
        username: body.username,
        email: body.email,
        displayName: body.displayName ?? body.username,
        passwordHash: await hashPassword(body.password),
        verified: false,
        approvedAt: decision.approved ? new Date() : null,
      })
      .returning();

    // With SMTP configured we e-mail a 6-digit code. Without it (turnkey installs that skipped mail)
    // there's no way to deliver one, so the account is left unverified and a super-admin approves it
    // from the admin panel (POST /admin/users/:id/verify). The client shows the right screen per status.
    if (decision.emailCode) {
      await issueCode(row.id, body.email, row.displayName);
      const res: RegisterResponse = { status: 'verification_required', email: body.email };
      return reply.code(202).send(res);
    }
    const res: RegisterResponse = { status: 'pending_admin', email: body.email };
    return reply.code(202).send(res);
  });

  // Verify the emailed code -> mark verified and return a token.
  app.post('/auth/verify', async (req, reply) => {
    const body = verifyBody.parse(req.body);
    // Per-IP ceiling on top of the per-code MAX_ATTEMPTS cap below.
    const limited = await rateHit(`verify:${clientIp(req)}`, 30, 15 * 60);
    if (limited) return reply.code(429).send({ error: retryMessage(limited) });
    const [user] = await findByIdentifier(body.identifier);
    if (!user) return reply.code(400).send({ error: 'invalid code' });
    // A verified account never legitimately hits /auth/verify: registration and e-mail change both
    // leave the account UNVERIFIED until the code passes (see /auth/email → verified:false). Returning
    // a session token here WITHOUT checking the code was a full unauthenticated account-takeover — any
    // known username (they're public) → a valid token, incl. the super-admin. Reject like /auth/resend.
    if (user.verified) return reply.code(400).send({ error: 'already verified' });

    const [v] = await db.select().from(emailVerifications).where(eq(emailVerifications.userId, user.id)).limit(1);
    if (!v) return reply.code(400).send({ error: 'no pending verification — request a new code' });
    if (v.expiresAt < new Date()) {
      await db.delete(emailVerifications).where(eq(emailVerifications.userId, user.id));
      return reply.code(400).send({ error: 'code expired — request a new one' });
    }
    if (v.attempts >= MAX_ATTEMPTS) {
      await db.delete(emailVerifications).where(eq(emailVerifications.userId, user.id));
      return reply.code(429).send({ error: 'too many attempts — request a new code' });
    }
    if (v.code !== body.code) {
      await db
        .update(emailVerifications)
        .set({ attempts: v.attempts + 1 })
        .where(eq(emailVerifications.userId, user.id));
      return reply.code(400).send({ error: 'invalid code' });
    }

    const [updated] = await db.update(users).set({ verified: true }).where(eq(users.id, user.id)).returning();
    await db.delete(emailVerifications).where(eq(emailVerifications.userId, user.id));
    // Почта подтверждена, но при политике `approval` аккаунт ещё ждёт админа (#142). Отказ, а не особый
    // ответ: старые клиенты ждут здесь токен или ошибку — и просто покажут текст.
    if (loginGate(updated) === 'pending_approval') {
      return reply.code(403).send({ error: PENDING_APPROVAL_ERROR, reason: 'pending_approval' });
    }
    const res: AuthResponse = {
      token: signToken({ sub: updated.id, username: updated.username, gen: updated.tokenGeneration }),
      user: serializeUser(updated),
    };
    return res;
  });

  // Resend a fresh code (rate-limited).
  app.post('/auth/resend', async (req, reply) => {
    const body = resendBody.parse(req.body);
    // Per-IP ceiling: the 60s cooldown below is per-ACCOUNT — without this one IP could
    // spray resends across many identifiers (mail spam).
    const limited = await rateHit(`resend:${clientIp(req)}`, 10, 60 * 60);
    if (limited) return reply.code(429).send({ error: retryMessage(limited) });
    const [user] = await findByIdentifier(body.identifier);
    if (!user || !user.email) return reply.code(202).send({ status: 'ok' }); // don't leak existence
    if (user.verified) return reply.code(400).send({ error: 'already verified' });

    const [v] = await db.select().from(emailVerifications).where(eq(emailVerifications.userId, user.id)).limit(1);
    if (v && Date.now() - v.sentAt.getTime() < RESEND_COOLDOWN_MS) {
      return reply.code(429).send({ error: 'please wait before requesting another code' });
    }
    await issueCode(user.id, user.email, user.displayName);
    return reply.code(202).send({ status: 'ok' });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const ip = clientIp(req);
    // Blanket per-IP ceiling (username spraying) + the escalating per-IP+username lockout.
    const ipLimited = await rateHit(`login:${ip}`, 30, 15 * 60);
    if (ipLimited) return reply.code(429).send({ error: retryMessage(ipLimited) });
    const locked = await loginLockRemaining(ip, body.username);
    if (locked) return reply.code(429).send({ error: retryMessage(locked) });
    // Accept username OR email, case-insensitively (findByIdentifier), not username-only exact match.
    const [row] = await findByIdentifier(body.username);
    if (!row || !(await verifyPassword(body.password, row.passwordHash))) {
      const lockSeconds = await recordLoginFailure(ip, body.username);
      if (lockSeconds) return reply.code(429).send({ error: retryMessage(lockSeconds) });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    await clearLoginFailures(ip, body.username);
    const gate = loginGate(row);
    if (gate === 'email_not_verified') {
      return reply.code(403).send({ error: 'email_not_verified', email: row.email });
    }
    if (gate === 'pending_approval') {
      return reply.code(403).send({ error: PENDING_APPROVAL_ERROR, reason: 'pending_approval' });
    }
    // 2FA on: hand back a short-lived challenge instead of a session token. The real token is only
    // issued by /auth/login/totp once a code passes.
    if (row.totpEnabled) {
      return reply.send({ status: 'totp_required', challenge: signChallengeToken({ sub: row.id, username: row.username }) });
    }
    const res: AuthResponse = {
      token: signToken({ sub: row.id, username: row.username, gen: row.tokenGeneration }),
      user: serializeUser(row),
    };
    return res;
  });

  // Second login step: exchange the challenge + a TOTP (or backup) code for a real session token.
  app.post('/auth/login/totp', async (req, reply) => {
    const body = totpLoginBody.parse(req.body);
    let claims;
    try {
      claims = verifyToken(body.challenge);
    } catch {
      return reply.code(401).send({ error: 'срок входа истёк — войдите заново' });
    }
    if (claims.typ !== '2fa') return reply.code(401).send({ error: 'invalid challenge' });

    const failKey = `2fa:fail:${claims.sub}`;
    if ((Number(await redisPub.get(failKey)) || 0) >= MAX_2FA_FAILS) {
      return reply.code(429).send({ error: 'слишком много попыток — попробуйте позже' });
    }
    const [row] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!row || !row.totpEnabled || !row.totpSecret) return reply.code(400).send({ error: 'двухфакторная не настроена' });

    // Anti-replay (P3-1) on the login TOTP; backup codes are single-use via atomic consume (P3-4).
    const ok = (await verifyTotpFresh(row.id, body.code, row.totpSecret)) || (await consumeBackupCode(row.id, body.code));
    if (!ok) {
      await redisPub.multi().incr(failKey).expire(failKey, FAIL_WINDOW_S).exec();
      return reply.code(401).send({ error: 'неверный код' });
    }
    await redisPub.del(failKey);
    const res: AuthResponse = {
      token: signToken({ sub: row.id, username: row.username, gen: row.tokenGeneration }),
      user: serializeUser(row),
    };
    return res;
  });

  // Change password (requires the current one). Revokes every other session (token generation
  // bump) and hands back a fresh token so THIS device stays logged in.
  app.post('/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!(await verifyPassword(body.currentPassword, row.passwordHash))) {
      return reply.code(401).send({ error: 'текущий пароль неверный' });
    }
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, row.id));
    const gen = await bumpTokenGeneration(row.id);
    return { ok: true, token: signToken({ sub: row.id, username: row.username, gen }) };
  });

  // Log out everywhere: revoke every outstanding token, hand back a fresh one for THIS device.
  app.post('/auth/logout-all', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    // Small ceiling — this endpoint verifies the password, don't let a stolen token brute it.
    const limited = await rateHit(`logoutall:${req.user!.sub}`, 5, 15 * 60);
    if (limited) return reply.code(429).send({ error: retryMessage(limited) });
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!(await verifyPassword(body.password, row.passwordHash))) {
      return reply.code(401).send({ error: 'неверный пароль' });
    }
    const gen = await bumpTokenGeneration(row.id);
    return { token: signToken({ sub: row.id, username: row.username, gen }) };
  });

  // Forgot password — email a reset code. Always 202 (never reveal whether the email is registered).
  app.post('/auth/password/forgot', async (req, reply) => {
    const body = forgotBody.parse(req.body);
    // Per-IP ceiling (same mail-spam reasoning as /auth/resend).
    const limited = await rateHit(`forgot:${clientIp(req)}`, 5, 60 * 60);
    if (limited) return reply.code(429).send({ error: retryMessage(limited) });
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (user?.email) {
      const [pr] = await db.select().from(passwordResets).where(eq(passwordResets.userId, user.id)).limit(1);
      if (!pr || Date.now() - pr.sentAt.getTime() >= RESEND_COOLDOWN_MS) {
        await issueResetCode(user.id, user.email, user.displayName);
      }
    }
    return reply.code(202).send({ status: 'ok' });
  });

  // Complete a password reset with the emailed code. Proves email ownership → sets the new password
  // and marks the account verified. Does NOT auto-login (keeps 2FA in force): the client returns to
  // the login screen afterwards.
  app.post('/auth/password/reset', async (req, reply) => {
    const body = resetBody.parse(req.body);
    // Per-IP ceiling on top of the per-code MAX_ATTEMPTS cap below.
    const limited = await rateHit(`reset:${clientIp(req)}`, 30, 15 * 60);
    if (limited) return reply.code(429).send({ error: retryMessage(limited) });
    const [user] = await findByIdentifier(body.identifier);
    if (!user) return reply.code(400).send({ error: 'invalid code' });
    const [pr] = await db.select().from(passwordResets).where(eq(passwordResets.userId, user.id)).limit(1);
    if (!pr) return reply.code(400).send({ error: 'no pending reset — request a new code' });
    if (pr.expiresAt < new Date()) {
      await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));
      return reply.code(400).send({ error: 'code expired — request a new one' });
    }
    if (pr.attempts >= MAX_ATTEMPTS) {
      await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));
      return reply.code(429).send({ error: 'too many attempts — request a new code' });
    }
    if (pr.code !== body.code) {
      await db.update(passwordResets).set({ attempts: pr.attempts + 1 }).where(eq(passwordResets.userId, user.id));
      return reply.code(400).send({ error: 'invalid code' });
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), verified: true })
      .where(eq(users.id, user.id));
    await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));
    // The classic stolen-session case: a reset must kill every outstanding token.
    await bumpTokenGeneration(user.id);
    // Lift any self-inflicted login lockout for this client so the owner can sign in with the new
    // password right away (a proven reset code = ownership). Clear BOTH keys — the user may have been
    // locked while typing their email OR their username (the lock is keyed by whichever they entered).
    await clearLoginLock(clientIp(req), user.username);
    if (user.email) await clearLoginLock(clientIp(req), user.email);
    return reply.code(200).send({ status: 'ok' });
  });

  // Change email (requires the current password) — sets the new address as UNVERIFIED and emails a
  // code there. The client then runs /auth/verify with the new email to re-verify.
  app.post('/auth/email', { preHandler: requireAuth }, async (req, reply) => {
    const body = changeEmailBody.parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!(await verifyPassword(body.password, row.passwordHash))) {
      return reply.code(401).send({ error: 'неверный пароль' });
    }
    if (body.newEmail === row.email) return reply.code(400).send({ error: 'это уже ваша почта' });
    const clash = await db.select({ id: users.id }).from(users).where(eq(users.email, body.newEmail)).limit(1);
    if (clash.length) return reply.code(409).send({ error: 'этот email уже используется' });
    const [updated] = await db
      .update(users)
      .set({ email: body.newEmail, verified: false })
      .where(eq(users.id, row.id))
      .returning();
    await issueCode(updated.id, body.newEmail, updated.displayName);
    return serializeUser(updated);
  });

  // Delete own account (requires the current password). Blocked while you still own servers — transfer
  // or delete those first. 🔴 Строка НЕ стирается, а обезличивается: сообщения и ЛС остаются у
  // собеседников (F0 #139, `accountDelete.ts` / `accountRules.ts`).
  app.post('/auth/delete', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row || row.deletedAt) return reply.code(404).send({ error: 'not found' });
    if (!(await verifyPassword(body.password, row.passwordHash))) {
      return reply.code(401).send({ error: 'неверный пароль' });
    }
    const owned = await db.select({ id: servers.id }).from(servers).where(eq(servers.ownerId, row.id));
    const block = accountDeleteBlock({
      ownedServers: owned.length,
      isSuperAdmin: isSuperAdmin(row.id),
      alreadyDeleted: !!row.deletedAt,
    });
    if (block) return reply.code(block.status).send({ error: block.error });
    await anonymizeAccount(row.id);
    return { ok: true };
  });

  // Begin 2FA setup: store a pending secret (not yet enabled) and return a QR to scan.
  app.post('/auth/2fa/setup', { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.totpEnabled) return reply.code(400).send({ error: 'двухфакторная уже включена' });
    const secret = generateTotpSecret();
    await db.update(users).set({ totpSecret: secret }).where(eq(users.id, row.id));
    const uri = otpauthUri(secret, row.username);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    return { secret, otpauthUri: uri, qrDataUrl };
  });

  // Confirm setup: verify a code against the pending secret, flip 2FA on, issue backup codes.
  app.post('/auth/2fa/enable', { preHandler: requireAuth }, async (req, reply) => {
    const body = codeBody.parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.totpEnabled) return reply.code(400).send({ error: 'двухфакторная уже включена' });
    if (!row.totpSecret) return reply.code(400).send({ error: 'сначала запустите настройку' });
    if (!verifyTotp(body.code, row.totpSecret)) return reply.code(400).send({ error: 'неверный код' });
    const backupCodes = generateBackupCodes(10);
    const hashes = await Promise.all(backupCodes.map((c) => hashPassword(normalizeBackupCode(c))));
    const [updated] = await db
      .update(users)
      .set({ totpEnabled: true, totpBackupCodes: hashes })
      .where(eq(users.id, row.id))
      .returning();
    return { backupCodes, user: serializeUser(updated) };
  });

  // Turn 2FA off — requires the current password and a valid code (TOTP or a backup code).
  app.post('/auth/2fa/disable', { preHandler: requireAuth }, async (req, reply) => {
    const body = disableBody.parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!(await verifyPassword(body.password, row.passwordHash))) return reply.code(401).send({ error: 'неверный пароль' });
    if (row.totpEnabled && row.totpSecret) {
      const ok = verifyTotp(body.code, row.totpSecret) || (await consumeBackupCode(row.id, body.code));
      if (!ok) return reply.code(400).send({ error: 'неверный код' });
    }
    const [updated] = await db
      .update(users)
      .set({ totpSecret: null, totpEnabled: false, totpBackupCodes: null })
      .where(eq(users.id, row.id))
      .returning();
    return { user: serializeUser(updated) };
  });

  // Re-issue backup codes (invalidates the old set). Requires a valid TOTP code.
  app.post('/auth/2fa/backup/regenerate', { preHandler: requireAuth }, async (req, reply) => {
    const body = codeBody.parse(req.body);
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row || !row.totpEnabled || !row.totpSecret) return reply.code(400).send({ error: 'двухфакторная не включена' });
    if (!verifyTotp(body.code, row.totpSecret)) return reply.code(400).send({ error: 'неверный код' });
    const backupCodes = generateBackupCodes(10);
    const hashes = await Promise.all(backupCodes.map((c) => hashPassword(normalizeBackupCode(c))));
    await db.update(users).set({ totpBackupCodes: hashes }).where(eq(users.id, row.id));
    return { backupCodes };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await db.select().from(users).where(eq(users.id, req.user!.sub)).limit(1);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return serializeUser(row);
  });
}
