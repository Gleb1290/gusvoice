/**
 * Сменные ключи подписи (#139, F1, план §5.1).
 *
 * Корневой ключ — печать инстанса, его трогают редко и хранят зашифрованным. Подписывать КАЖДЫЙ
 * запрос к соседу корневым нельзя: чем чаще ключ в работе, тем выше цена его утечки. Поэтому
 * корневой подписывает сменные ключи со сроком ~30 дней, а запросы подписываются уже сменными —
 * как промежуточные сертификаты у HTTPS, только без центра сертификации.
 *
 * 🔴 Перекрытие обязательно. Сосед мог скачать наш документ час назад и ещё держит его в кеше;
 * если выпустить новый ключ и тут же выбросить старый, все запросы этого часа получат отказ по
 * подписи. Поэтому новый выпускается ЗАРАНЕЕ, а старый доживает свой срок рядом с ним.
 *
 * Здесь чистые правила и криптография — ни файлов, ни сети, ни базы.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { FedSigningKey } from '@gusvoice/shared';

/** Сколько живёт сменный ключ. */
export const SIGNING_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** За сколько до конца выпускается следующий — окно, в котором действуют оба. */
export const SIGNING_KEY_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Сколько истёкший ключ ещё хранится. Нужен не для подписи, а чтобы отличать «подпись сделана
 * нашим просроченным ключом» (сосед с несвежим документом) от «подпись чужая» — разные сообщения
 * в аудите и разная реакция админа.
 */
export const SIGNING_KEY_KEEP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface SigningKeyPair {
  kid: string;
  /** Закрытый ключ, DER PKCS8. На диск уходит только в конверте (`keyEnvelope.ts`). */
  privateKeyDer: Buffer;
  publicKeyDer: Buffer;
  notBefore: number;
  notAfter: number;
  /** Подпись записи корневым ключом — её сосед проверяет, прежде чем доверять ключу. */
  sig: string;
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/**
 * Что именно подписывает корневой ключ.
 *
 * 🔴 Поля соединяются с разделителем, который в них не встречается, и ДЛИНА каждого пишется явно:
 * иначе `kid="a"|pub="bc"` и `kid="ab"|pub="c"` дали бы одну и ту же строку под подписью, а значит
 * подпись одного ключа подошла бы к другому.
 */
export function signingKeyPayload(key: Pick<FedSigningKey, 'kid' | 'publicKey' | 'notBefore' | 'notAfter'>): Buffer {
  const parts = [key.kid, key.publicKey, String(key.notBefore), String(key.notAfter)];
  return Buffer.from(parts.map((p) => `${p.length}:${p}`).join('|'), 'utf8');
}

/** Выпустить сменный ключ и подписать его корневым. */
export function issueSigningKey(rootPrivateKeyDer: Uint8Array, now: number, ttlMs = SIGNING_KEY_TTL_MS): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const notBefore = now;
  const notAfter = now + ttlMs;
  // 🪤 Идентификатор ключа берётся из ХЕША публичного ключа, а не из начала самого ключа: у всех
  // Ed25519-ключей DER SPKI начинается одинаковым префиксом алгоритма (`MCowBQYDK2VwAyEA…`), так что
  // «первые 16 символов ключа» давали бы ОДИН И ТОТ ЖЕ kid каждому выпуску — файлы затирали бы друг
  // друга, а в документе ключи стали бы неразличимы. Поймано смоуком при первом же выпуске двух ключей.
  const kid = createHash('sha256').update(publicKeyDer).digest('base64url').slice(0, 16);
  const root = createPrivateKey({ key: Buffer.from(rootPrivateKeyDer), format: 'der', type: 'pkcs8' });
  const payload = signingKeyPayload({ kid, publicKey: b64u(publicKeyDer), notBefore, notAfter });
  return {
    kid,
    privateKeyDer: privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKeyDer,
    notBefore,
    notAfter,
    sig: b64u(sign(null, payload, root)),
  };
}

/** Запись ключа для документа инстанса — то, что уедет соседу. */
export function toDocumentKey(pair: SigningKeyPair): FedSigningKey {
  return {
    kid: pair.kid,
    publicKey: b64u(pair.publicKeyDer),
    notBefore: pair.notBefore,
    notAfter: pair.notAfter,
    sig: pair.sig,
  };
}

/**
 * Выпустил ли этот сменный ключ владелец корневого.
 *
 * 🔴 Без этой проверки связка держалась бы на одном лишь адресе документа: кто угодно, подменив
 * ответ, подсунул бы свой сменный ключ и подписывал им запросы от нашего имени.
 */
export function verifySigningKey(rootPublicKeyDer: Uint8Array, key: FedSigningKey): boolean {
  try {
    const root = createPublicKey({ key: Buffer.from(rootPublicKeyDer), format: 'der', type: 'spki' });
    return verify(null, signingKeyPayload(key), root, Buffer.from(key.sig, 'base64url'));
  } catch {
    return false;
  }
}

/** Действует ли ключ прямо сейчас (границы включительно — на них решает допуск часов, а не это правило). */
export function keyIsCurrent(key: Pick<FedSigningKey, 'notBefore' | 'notAfter'>, now: number): boolean {
  return now >= key.notBefore && now <= key.notAfter;
}

/**
 * Каким ключом подписывать сейчас — самым свежим из действующих.
 *
 * Именно свежим, а не первым подходящим: в окне перекрытия действуют два, и подписывать надо новым,
 * чтобы у соседей успел прижиться тот, который переживёт ротацию.
 */
export function keyForSigning(keys: SigningKeyPair[], now: number): SigningKeyPair | null {
  const current = keys.filter((k) => keyIsCurrent(k, now));
  if (current.length === 0) return null;
  return current.reduce((best, k) => (k.notBefore > best.notBefore ? k : best));
}

/** Пора ли выпускать следующий: своего действующего нет вовсе, либо самый свежий входит в окно перекрытия. */
export function needsRotation(keys: SigningKeyPair[], now: number, overlapMs = SIGNING_KEY_OVERLAP_MS): boolean {
  const active = keyForSigning(keys, now);
  if (!active) return true;
  return active.notAfter - now <= overlapMs;
}

/** Выбросить те, что истекли давно: документ инстанса не должен пухнуть историей ключей. */
export function pruneKeys(keys: SigningKeyPair[], now: number, keepAfterMs = SIGNING_KEY_KEEP_AFTER_MS): SigningKeyPair[] {
  return keys.filter((k) => now - k.notAfter <= keepAfterMs);
}

/**
 * Ключи, которые уходят соседям: действующие И те, что недавно истекли.
 *
 * Недавно истёкшие нужны по той же причине, что перекрытие: сосед с документом из кеша может
 * прислать запрос, подписанный ключом, который у нас уже вышел из срока, — в аудите это должно
 * читаться как «несвежий документ», а не как «чужая подпись».
 */
export function publishedKeys(keys: SigningKeyPair[], now: number, keepAfterMs = SIGNING_KEY_KEEP_AFTER_MS): SigningKeyPair[] {
  return keys.filter((k) => keyIsCurrent(k, now) || (k.notAfter < now && now - k.notAfter <= keepAfterMs));
}
