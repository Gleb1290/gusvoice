/**
 * Настройки инстанса для мастера установки и админ-панели — чтение и запись (О2, #142).
 * Решения (что по умолчанию и почему) — в чистом `setupRules.ts`; здесь только база.
 *
 * ⚠️ Всё живёт в УЖЕ существующей `instance_settings` (ключ → JSON), рядом с `smtp` и `economy`.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { superAdminId } from './auth.js';
import { db } from './db/index.js';
import { instanceSettings, users } from './db/schema.js';
import { env } from './env.js';
import {
  INSTANCE_KEY,
  parseInstanceMeta,
  parseRegistrationPolicy,
  parseSetupState,
  REGISTRATION_KEY,
  SETUP_KEY,
  type RegistrationPolicy,
  type SetupState,
} from './setupRules.js';

export async function readSetting(key: string): Promise<unknown> {
  const [row] = await db.select({ value: instanceSettings.value }).from(instanceSettings).where(eq(instanceSettings.key, key)).limit(1);
  return row?.value;
}

export async function writeSetting(key: string, value: Record<string, unknown>): Promise<void> {
  const now = new Date();
  await db
    .insert(instanceSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: now } });
}

export async function registrationPolicy(): Promise<RegistrationPolicy> {
  return parseRegistrationPolicy(await readSetting(REGISTRATION_KEY));
}

export async function setRegistrationPolicy(policy: RegistrationPolicy): Promise<void> {
  await writeSetting(REGISTRATION_KEY, { policy });
}

export async function instanceMeta(): Promise<{ name: string | null; iconUrl: string | null }> {
  return parseInstanceMeta(await readSetting(INSTANCE_KEY));
}

export async function setInstanceMeta(patch: { name?: string | null; iconUrl?: string | null }): Promise<void> {
  const current = await instanceMeta();
  await writeSetting(INSTANCE_KEY, { ...current, ...patch });
}

export async function setupState(): Promise<SetupState> {
  return parseSetupState(await readSetting(SETUP_KEY));
}

export async function markSetup(patch: Partial<SetupState>): Promise<void> {
  const current = await setupState();
  await writeSetting(SETUP_KEY, { ...current, ...patch });
}

/**
 * Куда слать письма-тревоги (перебор паролей, кодов приглашения). `ADMIN_EMAIL` из `.env`, а если его нет —
 * почта супер-админа. Раньше `ADMIN_EMAIL` писал `install.sh` из вопросов про админа; с мастером
 * админа в консоли больше не спрашивают, и без этой подстановки тревоги у новых коробок молча терялись бы.
 */
export async function adminAlertEmail(): Promise<string> {
  if (env.adminEmail) return env.adminEmail;
  const id = superAdminId();
  if (!id) return '';
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return row?.email ?? '';
}
