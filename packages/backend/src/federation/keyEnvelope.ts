/**
 * Конверт для ключа инстанса: как печать инстанса лежит на диске (#139, F1, план §5.1.3).
 *
 * Решение по плану (§5.1.3): ключ живёт ОТДЕЛЬНЫМ файлом и в зашифрованном виде — не в базе, чтобы
 * дамп базы не уносил печать инстанса. Пароль — `FEDERATION_KEY_PASSPHRASE` из `.env`, то есть файл и `.env`
 * это пара: одно без другого бесполезно (и в бэкап должны попадать оба, см. SELF-HOSTING).
 *
 * Здесь ТОЛЬКО формат и криптография, без файловой системы — чтобы проверять на строках в памяти.
 * Всё берётся из `node:crypto`: Ed25519, scrypt и AES-GCM встроены, новых зависимостей не нужно.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Параметры scrypt. N=32768 — около 100 мс и 32 МБ памяти: ключ открывается раз за старт. */
const KDF = { n: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;

/** Версия формата конверта. Появится второй — читать обязаны оба, иначе старый ключ станет мусором. */
const ENVELOPE_VERSION = 1;

export interface SealedKey {
  v: number;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export class KeyPassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyPassphraseError';
  }
}

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(passphrase, salt, KDF.keyLen, { N: n, r, p, maxmem: KDF.maxmem });
}

/** Зашифровать закрытый ключ паролем. Соль и вектор — новые на каждый вызов. */
export function sealKey(privateKeyDer: Uint8Array, passphrase: string): SealedKey {
  if (passphrase.length === 0) throw new KeyPassphraseError('пустой пароль ключа инстанса');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, KDF.n, KDF.r, KDF.p);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    kdf: 'scrypt',
    n: KDF.n,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * Открыть конверт. Неверный пароль и подмена файла неразличимы снаружи — и то и другое `KeyPassphraseError`:
 * решение одно (проверить `FEDERATION_KEY_PASSPHRASE`), а разница подсказывала бы атакующему.
 *
 * ⚠️ Параметры KDF читаются ИЗ конверта, а не берутся текущие: иначе смена параметров в коде
 * превратила бы уже созданные ключи в нечитаемые.
 */
export function openKey(sealed: unknown, passphrase: string): Buffer {
  const s = sealed as Partial<SealedKey> | null;
  if (!s || typeof s !== 'object' || typeof s.data !== 'string') {
    throw new KeyPassphraseError('файл ключа инстанса не разобрался');
  }
  if (s.v !== ENVELOPE_VERSION || s.kdf !== 'scrypt') {
    throw new KeyPassphraseError(`неизвестный формат файла ключа (v=${String(s.v)})`);
  }
  if (typeof s.salt !== 'string' || typeof s.iv !== 'string' || typeof s.tag !== 'string') {
    throw new KeyPassphraseError('в файле ключа инстанса нет соли, вектора или метки');
  }
  const n = typeof s.n === 'number' ? s.n : KDF.n;
  const r = typeof s.r === 'number' ? s.r : KDF.r;
  const p = typeof s.p === 'number' ? s.p : KDF.p;
  const key = deriveKey(passphrase, Buffer.from(s.salt, 'base64'), n, r, p);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]);
  } catch {
    throw new KeyPassphraseError('пароль не подходит к файлу ключа инстанса');
  }
}

/**
 * Сверка пароля без раскрытия ключа — для проверки «тот ли пароль» до перезаписи файла.
 * Сравнение постоянного времени: разница во времени ответа выдавала бы префикс пароля.
 */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
