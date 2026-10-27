import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { humanUsernameLooksBot } from '@gusvoice/shared';
import { hashPassword, setSuperAdminId } from './auth.js';
import { db } from './db/index.js';
import { instanceSettings, users } from './db/schema.js';
import { env } from './env.js';
import { bindSuperAdminWith, SUPERADMIN_ID_KEY } from './superAdminRules.js';
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
  // Ник на «bot» — только у ботов (решение владельца 26.10, D): тот же отказ, что у регистрации и мастера установки.
  if (humanUsernameLooksBot(username)) {
    throw new Error(`SUPERADMIN_USERNAME «${username.trim()}» оканчивается на «bot» — такие ники только у ботов; сид супер-админа отклонён.`);
  }
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
    // Без этого аккаунт ждал бы одобрения (колонка пустая по умолчанию, `loginGate`) — у супер-админа некому одобрять.
    approvedAt: new Date(),
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
  const decision = await bindSuperAdminWith({
    envUsername: env.superAdminUsername,
    readStored: async () => {
      const [row] = await db
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, SUPERADMIN_ID_KEY))
        .limit(1);
      return row;
    },
    userExists: async (userId) => {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      return !!row;
    },
    findIdByUsername: async (username) => {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
      return row?.id ?? null;
    },
    ensureApproved: async (userId) => {
      // Только пустое `approved_at` (на проде оно давно стоит — строка не меняется вовсе). Время правки каталога
      // сдвигается: впервые «одобренный» аккаунт попадает в дельту соседей (F2).
      await db
        .update(users)
        .set({ approvedAt: new Date(), directoryUpdatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.approvedAt)));
    },
    persist: async (userId) => {
      await db
        .insert(instanceSettings)
        .values({ key: SUPERADMIN_ID_KEY, value: { userId }, updatedAt: new Date() })
        .onConflictDoNothing({ target: instanceSettings.key });
    },
    log: (level, message) => (level === 'warn' ? console.warn : console.log)(message),
  });
  setSuperAdminId(decision.superAdminId);
}
