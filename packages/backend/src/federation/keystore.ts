/**
 * Ключи инстанса на диске (#139, F1, план §5.1.3).
 *
 * 🔴 Почему файлы, а не база: дамп базы уезжает в бэкапы, копии для отладки и к тому, кто чинит
 * Postgres. Печать инстанса не должна ехать вместе с ним. Файл и `FEDERATION_KEY_PASSPHRASE` из
 * `.env` — пара: одно без другого бесполезно, в бэкап должны попадать оба.
 *
 * 🔴 Потеря ключа = потеря доверия. Файл потерян и бэкапа нет → при следующем старте создастся
 * НОВЫЙ корневой ключ, а значит новый `instance_id`, и ни один сосед не примет его автоматически:
 * у них связка перейдёт в «доверие потеряно», лечится только перепривязкой (план §5.1.3). Поэтому
 * здесь ничего не перезаписывается молча: существующий файл читается, а не пересоздаётся.
 */

import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { instanceIdFrom, fingerprintFrom } from './instanceIdentity.js';
import { KeyPassphraseError, openKey, sealKey } from './keyEnvelope.js';
import { issueSigningKey, type SigningKeyPair } from './signingKeys.js';

const ROOT_FILE = 'fed-root.key';
const SIGNING_PREFIX = 'fed-signing-';
/** Только владелец: файл лежит в томе, который видит и хост. */
const KEY_MODE = 0o600;

export interface InstanceIdentity {
  instanceId: string;
  fingerprint: string;
  rootPublicKeyDer: Buffer;
  rootPrivateKeyDer: Buffer;
}

export interface Keystore {
  dir: string;
  loadOrCreateRoot(): Promise<{ identity: InstanceIdentity; created: boolean }>;
  loadSigningKeys(rootPrivateKeyDer: Uint8Array): Promise<SigningKeyPair[]>;
  saveSigningKey(pair: SigningKeyPair): Promise<void>;
  /** Сменить корневой ключ — при краже (§5.1.3). Отдаёт и старую личность, и новую. */
  rotateRoot(): Promise<{ previous: InstanceIdentity; next: InstanceIdentity }>;
}

interface StoredSigningKey {
  kid: string;
  notBefore: number;
  notAfter: number;
  sig: string;
  publicKey: string;
  sealed: unknown;
}

/**
 * Хранилище поверх каталога. Пароль передаётся сюда, а НЕ читается из `env` внутри: иначе модуль
 * нельзя было бы проверить, не подсовывая процессу переменные окружения.
 */
export function createKeystore(dir: string, passphrase: string): Keystore {
  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function writePrivate(file: string, body: string): Promise<void> {
    const path = join(dir, file);
    await writeFile(path, body, { encoding: 'utf8', mode: KEY_MODE });
    // Права выставляются отдельно: у уже существующего файла `mode` в writeFile игнорируется.
    await chmod(path, KEY_MODE);
  }

  return {
    dir,

    async loadOrCreateRoot() {
      await ensureDir();
      const path = join(dir, ROOT_FILE);
      let raw: string | null = null;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        raw = null; // файла нет — первый старт федерации на этом инстансе
      }

      if (raw !== null) {
        // ⚠️ Ошибка пароля поднимается наверх и гасит ТОЛЬКО федерацию: создать новый ключ вместо
        // нечитаемого — значит своими руками сменить личность инстанса из-за опечатки в `.env`.
        const rootPrivateKeyDer = openKey(JSON.parse(raw), passphrase);
        // Публичный выводится из закрытого, а не хранится рядом: два файла могли бы разъехаться,
        // и тогда `instance_id` перестал бы соответствовать ключу, которым мы подписываем.
        const rootKeyObject = createPrivateKey({ key: rootPrivateKeyDer, format: 'der', type: 'pkcs8' });
        const rootPublicKeyDer = createPublicKey(rootKeyObject).export({ type: 'spki', format: 'der' });
        return {
          identity: {
            instanceId: instanceIdFrom(rootPublicKeyDer),
            fingerprint: fingerprintFrom(rootPublicKeyDer),
            rootPublicKeyDer,
            rootPrivateKeyDer,
          },
          created: false,
        };
      }

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const rootPrivateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
      const rootPublicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
      await writePrivate(ROOT_FILE, JSON.stringify(sealKey(rootPrivateKeyDer, passphrase)));
      return {
        identity: {
          instanceId: instanceIdFrom(rootPublicKeyDer),
          fingerprint: fingerprintFrom(rootPublicKeyDer),
          rootPublicKeyDer,
          rootPrivateKeyDer,
        },
        created: true,
      };
    },

    async loadSigningKeys() {
      await ensureDir();
      const files = (await readdir(dir)).filter((f) => f.startsWith(SIGNING_PREFIX) && f.endsWith('.key'));
      const out: SigningKeyPair[] = [];
      for (const file of files) {
        let stored: StoredSigningKey;
        try {
          stored = JSON.parse(await readFile(join(dir, file), 'utf8')) as StoredSigningKey;
        } catch {
          continue; // недочитанный или испорченный файл сменного ключа — не повод ронять федерацию
        }
        try {
          out.push({
            kid: stored.kid,
            privateKeyDer: openKey(stored.sealed, passphrase),
            publicKeyDer: Buffer.from(stored.publicKey, 'base64url'),
            notBefore: stored.notBefore,
            notAfter: stored.notAfter,
            sig: stored.sig,
          });
        } catch (err) {
          // Пароль не подошёл к СМЕННОМУ ключу: корневой уже открылся, значит пароль верный, а этот
          // файл от прошлой печати инстанса. Пропускаем — вместо него выпустится новый.
          if (!(err instanceof KeyPassphraseError)) throw err;
        }
      }
      return out.sort((a, b) => a.notBefore - b.notBefore);
    },

    /**
     * Сменить корневой ключ инстанса.
     *
     * 🔴 Старый ключ возвращается ВМЕСТЕ с новым: отзыв подписывается именно им, иначе соседи не
     * смогут отличить наш отзыв от чужой выдумки. Поэтому порядок такой — сначала отдать оба,
     * подписать снаружи, и только затем старый перестаёт существовать.
     * 🔴 Сменные ключи стираются: они подписаны СТАРЫМ корнем, и после смены не значат ничего —
     * оставь их, и мы бы подписывали запросы ключом, который сосед уже не признаёт.
     */
    async rotateRoot() {
      await ensureDir();
      const { identity: previous } = await this.loadOrCreateRoot();

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const rootPrivateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
      const rootPublicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
      await writePrivate(ROOT_FILE, JSON.stringify(sealKey(rootPrivateKeyDer, passphrase)));

      for (const file of await readdir(dir)) {
        if (file.startsWith(SIGNING_PREFIX) && file.endsWith('.key')) await rm(join(dir, file));
      }

      return {
        previous,
        next: {
          instanceId: instanceIdFrom(rootPublicKeyDer),
          fingerprint: fingerprintFrom(rootPublicKeyDer),
          rootPublicKeyDer,
          rootPrivateKeyDer,
        },
      };
    },

    async saveSigningKey(pair) {
      await ensureDir();
      const stored: StoredSigningKey = {
        kid: pair.kid,
        notBefore: pair.notBefore,
        notAfter: pair.notAfter,
        sig: pair.sig,
        publicKey: Buffer.from(pair.publicKeyDer).toString('base64url'),
        sealed: sealKey(pair.privateKeyDer, passphrase),
      };
      await writePrivate(`${SIGNING_PREFIX}${pair.kid}.key`, JSON.stringify(stored));
    },
  };
}

/** Выпустить сменный ключ и сразу положить его на диск — чтобы перезапуск не терял только что выпущенный. */
export async function issueAndStore(store: Keystore, rootPrivateKeyDer: Uint8Array, now: number): Promise<SigningKeyPair> {
  const pair = issueSigningKey(rootPrivateKeyDer, now);
  await store.saveSigningKey(pair);
  return pair;
}
