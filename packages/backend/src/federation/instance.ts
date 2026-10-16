/**
 * Живой экземпляр федерации этого процесса (#139, F1) — здесь и только здесь подключаются
 * настоящие диск, база, часы и лог. Само поведение — в `state.ts`, оно проверяется без них.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { instanceSettings } from '../db/schema.js';
import { env } from '../env.js';
import { createKeystore } from './keystore.js';
import { createFederation } from './state.js';

/** Ключ в `instance_settings` с названием и иконкой инстанса (задаёт держатель, §5.1.2). */
export const FEDERATION_META_KEY = 'federation_meta';

/**
 * Домен для визитки — хост адреса клиента: именно его человек видит как «инстанс друзей».
 * Кривой адрес не должен ронять старт, поэтому при неудаче отдаём строку как есть.
 */
export function domainFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export const federation = createFederation({
  enabled: env.federation.enabled,
  keystore: createKeystore(env.federation.dataDir, env.federation.keyPassphrase),
  now: () => Date.now(),
  domain: domainFromOrigin(env.clientOrigin),
  clientOrigin: env.clientOrigin,
  apiBase: env.federation.apiBase,
  appVersion: process.env.GV_VERSION ?? null,
  dmEnabled: env.federation.dmEnabled,
  async loadInstanceMeta() {
    const [row] = await db
      .select({ value: instanceSettings.value })
      .from(instanceSettings)
      .where(eq(instanceSettings.key, FEDERATION_META_KEY))
      .limit(1);
    const meta = (row?.value ?? {}) as { name?: unknown; iconHash?: unknown };
    return {
      name: typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : null,
      iconHash: typeof meta.iconHash === 'string' && meta.iconHash.length > 0 ? meta.iconHash : null,
    };
  },
  // Тот же приём, что в `seed.ts`: уровень выбирается здесь, а не внутри правил.
  log: (level, message) =>
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[fed] ${message}`),
});

/** Сколько ждать между проверками срока сменного ключа. */
const ROTATION_CHECK_MS = 12 * 60 * 60 * 1000;

/**
 * Плановая ротация сменного ключа.
 *
 * ⚠️ Нужна именно по таймеру, а не только при старте: инстанс, который не перезапускали месяц,
 * иначе дожил бы до истечения ключа и молча перестал бы подписывать запросы к соседям.
 */
/**
 * Как часто проверять поводы для оповещений (§5.10).
 *
 * ⚠️ Свой темп, а не круг ротации ключей: тот ходит раз в полсуток, а «связка не отвечает полчаса»
 * при таком шаге доезжало бы до держателя к вечеру. Сама проверка дешёвая — чтение связок и журнала.
 */
const ALERTS_CHECK_MS = 5 * 60 * 1000;

/** Проверять поводы для оповещений держателю. Выключенная федерация — таймера нет вовсе. */
export function startFederationAlerts(): void {
  if (!env.federation.enabled) return;
  let running = false;
  const run = (): void => {
    // Круг стучится к подозреваемым связкам по сети — поверх незавершённого новый не стартует (F-09).
    if (running) return;
    running = true;
    void import('./alerts.js')
      .then(({ runFederationAlerts }) => runFederationAlerts())
      .catch((err: unknown) => {
        console.warn(`[fed] проверка оповещений не прошла: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, ALERTS_CHECK_MS);
  timer.unref();
  run();
}

export function startFederationKeyRotation(): void {
  if (!env.federation.enabled) return;
  const timer = setInterval(() => {
    void federation.ensureSigningKey().catch((err: unknown) => {
      console.warn(`[fed] не удалось выпустить сменный ключ: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Заодно убираем протухшие коды связки: они уже ничего не открывают, но лежат с хешами секретов.
    void import('./links.js')
      .then(({ purgeStaleCodes }) => purgeStaleCodes(new Date()))
      .then((n) => {
        if (n > 0) console.log(`[fed] убрано просроченных кодов связки: ${n}`);
      })
      .catch(() => {
        /* уборка не критична: попробуем на следующем круге */
      });
    // И старые записи журнала федерации (F-25): полгода — достаточно, чтобы разобрать любое «что было».
    void import('./auditLog.js')
      .then(({ pruneAudit }) => pruneAudit(Date.now()))
      .then((n) => {
        if (n > 0) console.log(`[fed] убрано старых записей журнала: ${n}`);
      })
      .catch(() => {
        /* то же: не критично */
      });
  }, ROTATION_CHECK_MS);
  timer.unref();
}
