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
  /** ЛС между инстансами (Э1, `FEDERATION_DM_ENABLED`): объявлять `dm1`. Нет поля — не объявлять (как до Э1). */
  dmEnabled?: boolean;
  /**
   * Откуда пароль к ключу (#224): `base` — сгенерирован бэкендом при включении из админки и лежит в базе. Нужен только для
   * текста «не расшифрован»: держателю без `.env` бесполезно советовать переменную. Нет поля — как раньше (`.env`).
   */
  passphraseSource?(): 'env' | 'base';
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface Federation {
  status(): FederationStatus;
  /** Почему `key-error` — текст для вкладки «Федерация». Секретов тут нет и быть не должно. */
  problem(): string | null;
  identity(): InstanceIdentity | null;
  start(): Promise<void>;
  /**
   * Выключить без перезапуска (#224, тумблер в админке): забыть ключи из памяти и встать в `off`. Файлы ключей, связки и
   * пароль остаются — следующий `start()` прочитает тот же файл, личность та же.
   */
  stop(): void;
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
            ? deps.passphraseSource?.() === 'base'
              ? 'Ключ инстанса не расшифрован — пароль из базы не подходит к папке fed-keys (их переносили порознь?)'
              : 'Ключ инстанса не расшифрован — проверьте FEDERATION_KEY_PASSPHRASE'
            : `Ключ инстанса недоступен: ${err instanceof Error ? err.message : String(err)}`;
        // 🔴 Именно warn, а не error: это не поломка инстанса, а выключенная подсистема.
        deps.log('warn', `федерация не поднялась — ${problem}`);
      }
    },

    stop() {
      status = 'off';
      problem = null;
      identity = null;
      keys = [];
      deps.log('info', 'федерация выключена из админки');
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
        // `dm1` (Э1, #141) — только при `FEDERATION_DM_ENABLED`: маршрут `conv.open` без флага не регистрируется.
        features: [
          FED_FEATURES.link,
          FED_FEATURES.directory,
          FED_FEATURES.guests,
          FED_FEATURES.reports,
          ...(deps.dmEnabled ? [FED_FEATURES.dm1] : []),
          // `dm2` (Э3, #141): вложения между инстансами (`GET /fed/v1/att/:id`, копия при приёме) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dm2] : []),
          // `dm2once` (Э3 часть 3, #141): «один раз» у голосового/кружка между инстансами (пометка `once`, `listen`) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dm2once] : []),
          // `dm2ttl` (19.10, #226): одноразовые фото и видео (`once`/`once_ttl` у фото/видео, `listen` с `spent`) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dm2ttl] : []),
          // `dm3` (Э4, #141): мгновенное — `POST /fed/v1/ephemeral` («печатает», «в сети / был(а)») — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dm3] : []),
          // `dm4` (Э5 часть 1, #141): приём «через»-сообщений по долгой сессии и их сверка домом автора — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dm4] : []),
          // `dmcall1` (Э6, #141): звонки 1:1 с людьми соседа (`POST /fed/v1/call/invite`, событие `call.state`) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmcall1] : []),
          // `dmgroup1` (Э7 часть 1, #141): группы со смешанным составом (звезда через хост, подпись дома автора) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmgroup1] : []),
          // `dmgroup2` (Э7 часть 3, #141): «печатает» и «через» в группах со смешанным составом (пересылка хостом) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmgroup2] : []),
          // `dmgroupmarks1` (Э7 часть 3, #141): реакции/«прочитано»/закреп/«прослушано» в группах между инстансами — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmgroupmarks1] : []),
          // `dmalbum1` (G56): правка копии с меньшим списком вложений (убран один элемент альбома) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmalbum1] : []),
          // `dmmedia1` (G69): геопозиция и карточка контакта (`media` в строке `msg`) — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmmedia1] : []),
          // `dmpoll1` (14.10): опрос в ЛС с людьми соседа — определение в `media`, голоса строкой `pollvote` — тем же флагом.
          ...(deps.dmEnabled ? [FED_FEATURES.dmpoll1] : []),
        ],
        appVersion: deps.appVersion,
        rootKey: Buffer.from(identity.rootPublicKeyDer).toString('base64url'),
        keys: publishedKeys(keys, now).map(toDocumentKey),
      };
    },
  };
}
