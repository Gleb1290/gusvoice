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

/** Ключ обычного названия инстанса в `instance_settings` (то же значение, что `INSTANCE_KEY` в `setupRules.ts`). */
const LOCAL_INSTANCE_KEY = 'instance';

/** Предел названия в визитке (`INSTANCE_NAME_MAX` в `instanceMeta.ts`). */
const NEIGHBOR_NAME_MAX = 40;

/**
 * Название, под которым соседи видят НАШ инстанс (#204 п.4, решение владельца 19.10): «Федерация › Этот инстанс › Название»,
 * а если оно пустое — обычное название инстанса («Админка › Инстанс»), обрезанное до предела визитки. Нет ни того, ни
 * другого — `null` (сосед покажет домен). Форма протокола та же (поле `name` визитки), меняется только значение по умолчанию.
 */
export function neighborVisibleName(fedName: string | null | undefined, instanceName: string | null | undefined): string | null {
  if (fedName && fedName.trim().length > 0) return fedName;
  const own = instanceName?.trim() ?? '';
  return own.length > 0 ? own.slice(0, NEIGHBOR_NAME_MAX) : null;
}

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

/**
 * Хранилище ключей с текущим паролем (#224). При старте — пароль из `.env`; включение из админки без пароля в `.env`
 * подставляет пароль из базы (`switch.ts`). Файлы те же, меняется только пароль, которым их открывать.
 */
let keystore = createKeystore(env.federation.dataDir, env.federation.keyPassphrase);
let passphraseSource: 'env' | 'base' = 'env';

/** Пароль к ключу для следующего `federation.start()` (#224). 🔴 Сам пароль не логируется и наружу не уходит. */
export function useFederationPassphrase(passphrase: string, source: 'env' | 'base'): void {
  keystore = createKeystore(env.federation.dataDir, passphrase);
  passphraseSource = source;
}

export const federation = createFederation({
  // Геттеры, а не значения (#224): тумблер в админке меняет флаги без перезапуска.
  get enabled() {
    return env.federation.enabled;
  },
  get keystore() {
    return keystore;
  },
  passphraseSource: () => passphraseSource,
  now: () => Date.now(),
  domain: domainFromOrigin(env.clientOrigin),
  clientOrigin: env.clientOrigin,
  apiBase: env.federation.apiBase,
  appVersion: process.env.GV_VERSION ?? null,
  get dmEnabled() {
    return env.federation.dmEnabled;
  },
  async loadInstanceMeta() {
    const [row] = await db
      .select({ value: instanceSettings.value })
      .from(instanceSettings)
      .where(eq(instanceSettings.key, FEDERATION_META_KEY))
      .limit(1);
    const meta = (row?.value ?? {}) as { name?: unknown; iconHash?: unknown };
    const fedName = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name : null;
    // Название «для соседей» пусто (#204 п.4) — соседям уходит обычное название инстанса, а не голый домен.
    let localName: string | null = null;
    if (!fedName) {
      const [local] = await db
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, LOCAL_INSTANCE_KEY))
        .limit(1);
      const v = (local?.value ?? {}) as { name?: unknown };
      localName = typeof v.name === 'string' ? v.name : null;
    }
    return {
      name: neighborVisibleName(fedName, localName),
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

let alertsStarted = false;
let rotationStarted = false;

/**
 * Проверять поводы для оповещений держателю. Выключенная федерация — таймера нет вовсе; включили из админки (#224) —
 * зовётся снова и заводит таймер один раз; выключили — такт ничего не делает.
 */
export function startFederationAlerts(): void {
  if (!env.federation.enabled || alertsStarted) return;
  alertsStarted = true;
  let running = false;
  const run = (): void => {
    // Круг стучится к подозреваемым связкам по сети — поверх незавершённого новый не стартует (F-09).
    if (running || !env.federation.enabled) return;
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
  if (!env.federation.enabled || rotationStarted) return;
  rotationStarted = true;
  const timer = setInterval(() => {
    // Выключили из админки (#224) — такт пустой: ни ключей, ни уборки, пока не включат снова.
    if (!env.federation.enabled) return;
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
