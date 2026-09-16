import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { instanceSettings } from './db/schema.js';
import { env } from './env.js';

// Instance settings live in the `instance_settings` table (key -> JSON). Right now the only key is
// 'smtp'. The operator can set mail up from the admin panel; when they haven't, we fall back to the
// SMTP_* env vars — so prod (which configures SMTP via env) is unaffected and turnkey installs can
// configure it later from the UI. See mailer.ts (transporter) + routes/admin.ts (the CRUD).

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

// Cached resolved config. undefined = not loaded yet; null = none configured (neither DB nor env).
let smtpCache: SmtpConfig | null | undefined;

function envSmtp(): SmtpConfig | null {
  if (!env.smtp.host) return null;
  return {
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    user: env.smtp.user,
    pass: env.smtp.pass,
    from: env.smtp.from,
  };
}

async function dbSmtp(): Promise<SmtpConfig | null> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, 'smtp'))
    .limit(1);
  const v = row?.value as Partial<SmtpConfig> | undefined;
  if (!v || !v.host) return null;
  return {
    host: v.host,
    port: Number(v.port) || 587,
    secure: !!v.secure,
    user: v.user ?? '',
    pass: v.pass ?? '',
    from: v.from || env.smtp.from,
  };
}

/** The effective SMTP config: DB row if set, else the SMTP_* env vars, else null (log-only mode). */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  if (smtpCache === undefined) smtpCache = (await dbSmtp()) ?? envSmtp();
  return smtpCache;
}

/** True when e-mail can actually be sent (used to decide the register flow — code vs admin-approve). */
export async function isSmtpConfigured(): Promise<boolean> {
  return (await getSmtpConfig()) !== null;
}

/** Where the effective config comes from — shown in the admin UI so the operator knows. */
export async function smtpSource(): Promise<'db' | 'env' | 'none'> {
  if (await dbSmtp()) return 'db';
  return envSmtp() ? 'env' : 'none';
}

/** Save (or clear, with null) the DB SMTP config and invalidate the cache so mailer re-derives. */
export async function setSmtpConfig(cfg: SmtpConfig | null): Promise<void> {
  if (cfg === null) {
    await db.delete(instanceSettings).where(eq(instanceSettings.key, 'smtp'));
  } else {
    const value = cfg as unknown as Record<string, unknown>; // jsonb column type
    await db
      .insert(instanceSettings)
      .values({ key: 'smtp', value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
  }
  smtpCache = undefined; // next getSmtpConfig() reloads; mailer rebuilds its transporter on change
}
