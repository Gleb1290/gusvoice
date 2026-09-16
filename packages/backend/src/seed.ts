import { eq, or, sql } from 'drizzle-orm';
import { hashPassword, setSuperAdminId } from './auth.js';
import { db } from './db/index.js';
import { instanceSettings, users } from './db/schema.js';
import { env } from './env.js';
import { decideSuperAdminBinding, SUPERADMIN_ID_KEY } from './superAdminRules.js';
import { id } from './util.js';

/**
 * First-boot bootstrap: if SUPERADMIN_USERNAME + _EMAIL + _PASSWORD are all set (install.sh collects
 * them), create a PRE-VERIFIED super-admin account so a fresh instance is usable immediately — no web
 * registration, no e-mail verification code. Idempotent: does nothing if a user with that username OR
 * email already exists (never clobbers). Empty env (an existing deployment) => no-op.
 *
 * Права супер-админа аккаунт получает НЕ отсюда, а из `bindSuperAdmin()` ниже: тот привязывает id
 * (#140). Вызывать строго в порядке seed → bind.
 */
export async function seedSuperAdmin(): Promise<void> {
  const { username, email, password } = env.superAdmin;
  if (!username || !email || !password) return;

  const uname = username.trim().toLowerCase();
  const mail = email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(or(sql`lower(${users.username}) = ${uname}`, sql`lower(${users.email}) = ${mail}`))
    .limit(1);
  if (existing) return; // already present — leave it alone

  // Fail-closed (P3-6): the min-length rule otherwise lives ONLY in install.sh and is bypassed by a
  // hand-written .env → a PRE-VERIFIED super-admin with a trivial password is instant instance takeover.
  // Refuse to seed (and thus to start) on a too-short password. Checked ONLY when actually seeding, so an
  // existing instance that left a weak SUPERADMIN_PASSWORD in its .env is unaffected (it returned above).
  if (password.length < 6) {
    throw new Error('SUPERADMIN_PASSWORD слишком короткий (минимум 6 символов) — сид супер-админа отклонён.');
  }

  await db.insert(users).values({
    id: id(),
    username: username.trim(),
    email: email.trim(),
    displayName: username.trim(),
    passwordHash: await hashPassword(password),
    verified: true,
  });
  console.log(
    `[seed] super-admin "${username.trim()}" created (pre-verified). Log in with it, then you can remove SUPERADMIN_PASSWORD from .env.`,
  );
}

/**
 * Привязать супер-админа к id (#140) и выставить его в памяти процесса. Вызывается при старте ДО
 * `listen`, сразу после `seedSuperAdmin()`. Решение (и почему привязанный id сильнее env) — в
 * `superAdminRules.ts`; здесь только чтение и запись.
 *
 * ⚠️ Точное совпадение логина, регистр важен — как было всегда (`SuperGoose` ≠ `Supergoose`). Сид
 * ищет без учёта регистра, но он только СОЗДАЁТ аккаунт и прав не выдаёт.
 */
export async function bindSuperAdmin(): Promise<void> {
  const [stored] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SUPERADMIN_ID_KEY))
    .limit(1);
  const rawId = (stored?.value as { userId?: unknown } | undefined)?.userId;
  const storedId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId : null;
  // Строка есть, а id в ней не читается — это НЕ «записи нет» (fail-closed, см. superAdminRules.ts).
  const storedMalformed = !!stored && storedId === null;

  const [storedRow] = storedId
    ? await db.select({ id: users.id }).from(users).where(eq(users.id, storedId)).limit(1)
    : [];
  const envUsername = env.superAdminUsername.trim();
  const [match] = !stored && envUsername
    ? await db.select({ id: users.id }).from(users).where(eq(users.username, envUsername)).limit(1)
    : [];

  const decision = decideSuperAdminBinding({
    storedId,
    storedMalformed,
    storedExists: !!storedRow,
    envUsername,
    usernameMatchId: match?.id ?? null,
  });

  if (decision.persist && decision.superAdminId) {
    const value = { userId: decision.superAdminId };
    await db
      .insert(instanceSettings)
      .values({ key: SUPERADMIN_ID_KEY, value, updatedAt: new Date() })
      .onConflictDoNothing({ target: instanceSettings.key });
  }
  if (decision.log) (decision.log.level === 'warn' ? console.warn : console.log)(decision.log.message);
  setSuperAdminId(decision.superAdminId);
}
