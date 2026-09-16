import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { effectiveTokenGeneration, shouldRefresh, TOKEN_TTL_S } from './authRules.js';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { env } from './env.js';
import { claimsAreSuperAdmin, isSuperAdminId } from './superAdminRules.js';

// Пороги и решение о продлении — в `authRules.ts`. Реэкспорт для существующих потребителей.
export { shouldRefresh, TOKEN_TIMING } from './authRules.js';

export interface AuthClaims {
  sub: string; // user id
  username: string;
  /** Token purpose: 'auth' = full session token; '2fa' = short-lived login challenge (NOT a session). */
  typ?: 'auth' | '2fa';
  /**
   * Session revocation (migration 0019): the users.token_generation this token was minted with.
   * requireAuth rejects tokens whose generation no longer matches — bumping the column
   * («Выйти на всех устройствах», password change/reset) instantly kills every other token.
   * Tokens issued before this feature carry no claim and read as generation 0.
   */
  gen?: number;
  /** Проставляется jsonwebtoken: когда токен выдан (сек). По нему решается, пора ли продлевать. */
  iat?: number;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Срок жизни токена и порог продления (и почему они именно такие) — в `authRules.ts`.

export function signToken(claims: { sub: string; username: string; gen: number }): string {
  return jwt.sign({ ...claims, typ: 'auth' }, env.jwtSecret, { expiresIn: TOKEN_TTL_S });
}

// --- Session revocation: verify the token's generation against users.token_generation.
// Micro-cached (10s) so the per-request DB hit amortizes away; revocation applies within
// seconds. bumpTokenGeneration is the ONE way to invalidate: it updates the row, drops the
// cache entry, and returns the new generation for minting the caller's replacement token.
const GEN_CACHE_MS = 10_000;
const genCache = new Map<string, { gen: number; at: number }>();

export async function tokenGenValid(sub: string, gen: number | undefined): Promise<boolean> {
  const want = gen ?? 0;
  const cached = genCache.get(sub);
  if (cached && Date.now() - cached.at < GEN_CACHE_MS) return want === cached.gen;
  const [u] = await db
    .select({ gen: users.tokenGeneration, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, sub))
    .limit(1);
  if (!u) return false;
  // Удалённый аккаунт не проходит НИКАКИМ токеном — правило и почему в `authRules.ts effectiveTokenGeneration`.
  const current = effectiveTokenGeneration(u);
  genCache.set(sub, { gen: current, at: Date.now() });
  return want === current;
}

/** Сбросить кэш поколения после того, как его подняли в чужой транзакции (удаление аккаунта). */
export function forgetTokenGeneration(userId: string): void {
  genCache.delete(userId);
}

/** Bump the user's token generation (revokes every outstanding token) and return the new value. */
export async function bumpTokenGeneration(userId: string): Promise<number> {
  const [row] = await db
    .update(users)
    .set({ tokenGeneration: sql`${users.tokenGeneration} + 1` })
    .where(eq(users.id, userId))
    .returning({ gen: users.tokenGeneration });
  genCache.delete(userId);
  return row.gen;
}

/**
 * Short-lived token issued after the password step when 2FA is on. It is NOT a session token:
 * requireAuth rejects `typ === '2fa'`, and only POST /auth/login/totp accepts it.
 */
export function signChallengeToken(claims: { sub: string; username: string }): string {
  return jwt.sign({ ...claims, typ: '2fa' }, env.jwtSecret, { expiresIn: '5m' });
}

export function verifyToken(token: string): AuthClaims {
  return jwt.verify(token, env.jwtSecret) as AuthClaims;
}

/**
 * id супер-админа инстанса. Выставляется ОДИН раз при старте `bindSuperAdmin()` (`seed.ts`) до того,
 * как бэкенд начнёт слушать порт; до этого супер-админа нет ни у кого.
 */
let superAdminUserId: string | null = null;

export function setSuperAdminId(id: string | null): void {
  superAdminUserId = id;
}

export function superAdminId(): string | null {
  return superAdminUserId;
}

/**
 * Супер-админ ли этот ПОЛЬЗОВАТЕЛЬ — строго по id (#140).
 *
 * 🔴 Принимает id, не логин. Раньше сюда передавали `username`, и совпадение строки давало права
 * инстанса. Правила и почему — в `superAdminRules.ts`.
 */
export function isSuperAdmin(userId: string | null | undefined): boolean {
  return isSuperAdminId(userId, superAdminUserId);
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthClaims;
  }
}

/** Fastify preHandler: require a valid Bearer token, populate request.user. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  let claims: AuthClaims;
  try {
    claims = verifyToken(header.slice(7));
  } catch {
    return reply.code(401).send({ error: 'invalid token' });
  }
  // A 2FA login-challenge token must never authorize a session.
  if (claims.typ === '2fa') return reply.code(401).send({ error: 'invalid token' });
  // Revoked generation (logout-everywhere / password change) = dead token.
  if (!(await tokenGenValid(claims.sub, claims.gen))) {
    return reply.code(401).send({ error: 'invalid token' });
  }
  req.user = claims;
  maybeRefresh(claims, reply);
}

/**
 * Продлить сессию активного пользователя: если токену больше суток — выдать свежий и положить
 * в заголовок ответа. Клиент подменяет сохранённый (см. `api.ts`).
 *
 * ⚠️ Заголовок кросс-доменный: клиент на `voice.*`, API на `api.*`. Браузер НЕ даст его прочитать,
 * если не перечислить в `exposedHeaders` у CORS (см. `index.ts`) — без этого продление тихо не
 * работает, и всё выглядит ровно как прежний баг.
 *
 * Абсолютного потолка сознательно НЕТ: он выкидывал бы человека, сидящего в приложении полгода
 * подряд, то есть ровно то поведение, которое здесь и чинится. Отзыв сессий делается через
 * `bumpTokenGeneration` («Выйти на всех устройствах», смена пароля) — он мгновенно убивает все
 * токены независимо от их срока.
 */
function maybeRefresh(claims: AuthClaims, reply: FastifyReply): void {
  if (!shouldRefresh(claims.iat, Math.floor(Date.now() / 1000))) return;
  const fresh = signToken({ sub: claims.sub, username: claims.username, gen: claims.gen ?? 0 });
  reply.header('x-refresh-token', fresh);
}

// `shouldRefresh` / `TOKEN_TIMING` живут в `authRules.ts` (этот модуль читает env → в Node не грузится).

/** Fastify preHandler: require the super-admin. */
export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (!req.user) return; // requireAuth already responded 401
  // По `sub`, а не по `username` из токена (#140).
  if (!claimsAreSuperAdmin(req.user, superAdminUserId)) return reply.code(403).send({ error: 'forbidden' });
}
