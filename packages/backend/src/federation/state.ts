/**
 * Состояние федерации на этом инстансе (#139, F1).
 *
 * Собирает воедино: личность (корневой ключ), действующий сменный ключ и документ инстанса, который
 * отдаётся соседям. Всё внешнее — диск, база, часы, лог — приходит зависимостями, поэтому поведение
 * (включая «пароль не подошёл») проверяется без файлов и базы.
 *
 * 🔴 Отказ федерации НЕ роняет инстанс. Нет пароля, пароль не подходит, каталог недоступен — весь
 * остальной GusVoice работает как обычно, а вкладка «Федерация» объясняет, что чинить. Ровно так же
 * ведёт себя выключенная федерация: разница только в тексте.
 */

import { FED_FEATURES, FED_PROTOCOL, type FedInstanceDocument } from '@gusvoice/shared';
import { KeyPassphraseError } from './keyEnvelope.js';
import type { InstanceIdentity, Keystore } from './keystore.js';
import { issueAndStore } from './keystore.js';
import { keyForSigning, needsRotation, publishedKeys, pruneKeys, toDocumentKey, type SigningKeyPair } from './signingKeys.js';

/** `off` — выключена держателем; `key-error` — включена, но ключ не открылся; `ready` — работает. */
export type FederationStatus = 'off' | 'key-error' | 'ready';

export interface FederationDeps {
  enabled: boolean;
  keystore: Keystore;
  now(): number;
  /** Название и иконка задаются держателем (§5.1.2); пусто → интерфейс соседа покажет домен. */
  loadInstanceMeta(): Promise<{ name: string | null; iconHash: string | null }>;
  domain: string;
  clientOrigin: string;
  apiBase: string;
  /** Только для диагностики: решения по версии приложения не принимаются (`federation-compat.md`). */
  appVersion: string | null;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface Federation {
  status(): FederationStatus;
  /** Почему `key-error` — текст для вкладки «Федерация». Секретов тут нет и быть не должно. */
  problem(): string | null;
  identity(): InstanceIdentity | null;
  start(): Promise<void>;
  /** Выпустить следующий сменный ключ, если подошёл срок. Зовётся при старте и по расписанию. */
  ensureSigningKey(): Promise<void>;
  document(): Promise<FedInstanceDocument | null>;
  /** Каким ключом подписывать исходящие запросы прямо сейчас. */
  signingKey(): SigningKeyPair | null;
  /**
   * Когда истекает действующий ключ подписи и выпущен ли следующий — для оповещения «ключ истекает»
   * (§5.10). `null` — федерация не поднята, говорить не о чем.
   *
   * 🔴 Повод редкий, но дорогой: ключи меняются сами, и если смена молча падает (нет доступа к
   * хранилищу ключей, кончилось место), инстанс доживёт до истечения — и в один день соседи
   * перестанут принимать его события, а держатель узнает об этом от людей.
   */
  keyExpiry(): { notAfter: number; rotated: boolean } | null;
  /**
   * Сменить корневой ключ (кража, §5.1.3). Отдаёт СТАРУЮ личность вместе с новой: отзыв подписывается
   * старым ключом, иначе соседи не отличат наш отзыв от чужой выдумки.
   */
  rotateRootKey(): Promise<{ previous: InstanceIdentity; next: InstanceIdentity } | null>;
}

export function createFederation(deps: FederationDeps): Federation {
  let status: FederationStatus = deps.enabled ? 'key-error' : 'off';
  let problem: string | null = deps.enabled ? 'федерация ещё не запускалась' : null;
  let identity: InstanceIdentity | null = null;
  let keys: SigningKeyPair[] = [];

  async function ensureSigningKey(): Promise<void> {
    if (!identity) return;
    const now = deps.now();
    if (!needsRotation(keys, now)) return;
    const pair = await issueAndStore(deps.keystore, identity.rootPrivateKeyDer, now);
    // Старые не выбрасываются сразу: у соседа на руках документ, выданный до ротации (см. перекрытие).
    keys = pruneKeys([...keys, pair], now);
    deps.log('info', `федерация: выпущен сменный ключ подписи kid=${pair.kid}`);
  }

  return {
    status: () => status,
    problem: () => problem,
    identity: () => identity,
    signingKey: () => (identity ? keyForSigning(keys, deps.now()) : null),

    keyExpiry() {
      if (!identity) return null;
      const now = deps.now();
      const current = keyForSigning(keys, now);
      if (!current) return null;
      // «Следующий уже есть» = в наборе лежит ключ, действующий дольше текущего.
      const rotated = keys.some((k) => k.notAfter > current.notAfter);
      return { notAfter: current.notAfter, rotated };
    },

    async start() {
      if (!deps.enabled) {
        deps.log('info', 'федерация выключена (FEDERATION_ENABLED)');
        return;
      }
      try {
        const { identity: loaded, created } = await deps.keystore.loadOrCreateRoot();
        identity = loaded;
        keys = await deps.keystore.loadSigningKeys(loaded.rootPrivateKeyDer);
        await ensureSigningKey();
        status = 'ready';
        problem = null;
        // Отпечаток в логе — не секрет, он публичен; по нему держатель сверяет, та ли это личность
        // после переезда или восстановления из бэкапа.
        deps.log(
          'info',
          created
            ? `федерация: создана личность инстанса ${loaded.instanceId} (отпечаток ${loaded.fingerprint})`
            : `федерация: личность инстанса ${loaded.instanceId}`,
        );
      } catch (err) {
        status = 'key-error';
        identity = null;
        keys = [];
        problem =
          err instanceof KeyPassphraseError
            ? 'Ключ инстанса не расшифрован — проверьте FEDERATION_KEY_PASSPHRASE'
            : `Ключ инстанса недоступен: ${err instanceof Error ? err.message : String(err)}`;
        // 🔴 Именно warn, а не error: это не поломка инстанса, а выключенная подсистема.
        deps.log('warn', `федерация не поднялась — ${problem}`);
      }
    },

    ensureSigningKey,

    async rotateRootKey() {
      if (status !== 'ready') return null;
      const rotated = await deps.keystore.rotateRoot();
      identity = rotated.next;
      // Сменные ключи были подписаны прежним корнем и теперь ничего не значат — выпускаем заново.
      keys = [];
      await ensureSigningKey();
      deps.log(
        'warn',
        `федерация: КОРНЕВОЙ КЛЮЧ СМЕНЁН. Было ${rotated.previous.instanceId}, стало ${rotated.next.instanceId} ` +
          `(отпечаток ${rotated.next.fingerprint}). Все связки требуют перепривязки.`,
      );
      return rotated;
    },

    async document() {
      if (status !== 'ready' || !identity) return null;
      const now = deps.now();
      const meta = await deps.loadInstanceMeta();
      return {
        instanceId: identity.instanceId,
        name: meta.name,
        iconHash: meta.iconHash,
        domain: deps.domain,
        clientOrigin: deps.clientOrigin,
        apiBase: deps.apiBase,
        protocol: { min: FED_PROTOCOL.min, max: FED_PROTOCOL.max },
        /**
         * Что мы умеем. Сосед решает по этому СПИСКУ, а не по версии приложения.
         *
         * 🔴 Возможность объявляется, когда путь работает ЦЕЛИКОМ. `guests` — это не только приём
         * токена личности: это ещё и отзыв сессий (§5.6.1), и закрытие сервера (§5.3.1), и сверка
         * членств (§5.4). Объяви мы её раньше — сосед выписал бы своему человеку токен, тот вошёл
         * бы, а «выйти везде» у него молча не сработало.
         * ⚠️ `reports` отдельно от `guests` намеренно: инстанс может принимать гостей и не уметь
         * жалобы (§5.11), и у соседа галочка «Пожаловаться» тогда неактивна — с подсказкой, а не
         * с отправкой в пустоту.
         */
        features: [FED_FEATURES.link, FED_FEATURES.directory, FED_FEATURES.guests, FED_FEATURES.reports],
        appVersion: deps.appVersion,
        rootKey: Buffer.from(identity.rootPublicKeyDer).toString('base64url'),
        keys: publishedKeys(keys, now).map(toDocumentKey),
      };
    },
  };
}
