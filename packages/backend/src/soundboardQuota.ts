import { and, count, eq } from 'drizzle-orm';
import type { db } from './db/index.js';
import { instanceSettings, serverSoundboard, serverSoundboardQuotas, servers } from './db/schema.js';
import {
  DEFAULT_SOUNDBOARD_PER_USER_LIMIT,
  DEFAULT_SOUNDBOARD_SETTINGS,
  soundboardSettingsSchema,
  type SoundboardSettings,
  usesPersonalSoundboardQuota,
} from './soundboardQuotaRules.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SOUNDBOARD_SETTINGS_KEY = 'soundboard';

export async function readSoundboardSettings(tx: Tx, lock = false): Promise<SoundboardSettings> {
  const query = tx.select({ value: instanceSettings.value }).from(instanceSettings)
    .where(eq(instanceSettings.key, SOUNDBOARD_SETTINGS_KEY));
  // Строка создаётся миграцией. Параллельные загрузки берут SHARE, переключение модели ждёт их коммита.
  if (!lock) {
    const [row] = await query;
    return soundboardSettingsSchema.safeParse(row?.value).data ?? DEFAULT_SOUNDBOARD_SETTINGS;
  }

  const [row] = await query.for('share');
  if (row) return soundboardSettingsSchema.safeParse(row.value).data ?? DEFAULT_SOUNDBOARD_SETTINGS;

  // Восстанавливаем строку, если её нет. Повторное чтение под SHARE также видит
  // параллельный административный upsert, если он первым вставил свою настройку.
  await tx.insert(instanceSettings).values({ key: SOUNDBOARD_SETTINGS_KEY, value: DEFAULT_SOUNDBOARD_SETTINGS })
    .onConflictDoNothing({ target: instanceSettings.key });
  const [restored] = await query.for('share');
  return soundboardSettingsSchema.safeParse(restored.value).data ?? DEFAULT_SOUNDBOARD_SETTINGS;
}

export async function lockSoundboardServer(tx: Tx, serverId: string): Promise<boolean> {
  const [server] = await tx.select({ id: servers.id }).from(servers)
    .where(eq(servers.id, serverId)).for('no key update');
  return !!server;
}

export async function readSoundboardQuota(tx: Tx, serverId: string, settings: SoundboardSettings) {
  if (!usesPersonalSoundboardQuota(settings, serverId)) {
    return { mode: 'legacy' as const, limit: settings.legacyLimit };
  }
  const [row] = await tx.select({ limit: serverSoundboardQuotas.perUserLimit }).from(serverSoundboardQuotas)
    .where(eq(serverSoundboardQuotas.serverId, serverId));
  return { mode: 'per-user' as const, limit: row?.limit ?? DEFAULT_SOUNDBOARD_PER_USER_LIMIT };
}

export async function soundboardUsage(tx: Tx, serverId: string, authorId?: string): Promise<number> {
  const [row] = await tx.select({ used: count() }).from(serverSoundboard).where(and(
    eq(serverSoundboard.serverId, serverId),
    authorId === undefined ? undefined : eq(serverSoundboard.createdBy, authorId),
  ));
  return row.used;
}
