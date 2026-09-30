import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

/**
 * Шифрование пуша по стандарту WebPush (RFC 8291, кодирование aes128gcm из RFC 8188) — #213, этап 0 ЛС.
 *
 * 🔴 Зачем. Пуш о личном сообщении нёс текст открытым JSON, а сервер пушей (ntfy) отдаёт тему на чтение
 * любому, кто знает её имя, и держит сообщения в кеше. Имя темы случайное, но оно лежит в нашей базе, в
 * логах ntfy и на устройстве — кто хоть раз его увидел, читал бы переписку. Теперь телефон при регистрации
 * присылает свой открытый ключ P-256 и секрет, а ntfy видит только шифр. Закрывать чтение самого ntfy не
 * пришлось: приложение ntfy на телефоне подписывается без логина, и учётка на каждом телефоне была бы
 * хуже для людей, чем шифр, который им ничего не стоит.
 *
 * Модуль чистый — ни env, ни базы, ни сети; проверяется вектором из приложения A RFC 8291.
 */

/** Ключи устройства из подписки, как их шлёт клиент: base64url. */
export interface WebPushKeys {
  /** Открытый ключ устройства, P-256 в несжатом виде (65 байт, начинается с 0x04). */
  p256dh: string;
  /** Секрет аутентификации (16 байт). */
  auth: string;
}

/** Размер записи в заголовке. Одна запись: наши пуши — сотни байт. */
const RECORD_SIZE = 4096;
/** Заголовок тела: соль 16 · размер записи 4 · длина ключа 1 · ключ отправителя 65. */
const HEADER_SIZE = 16 + 4 + 1 + 65;
/**
 * Самый длинный текст, который помещается в тело 4096 байт вместе с заголовком, разделителем и меткой GCM —
 * 3993 байта (RFC 8291 §4). 🔴 Было «запись ≤ 4096» без заголовка (найдено Codex 28.09): текст в 3994 байта давал
 * тело 4097, ntfy мог ответить 413 — а на 413 `push.ts` удаляет регистрацию устройства.
 */
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_SIZE - 1 - 16;

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function b64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Ключи годятся для шифрования: правильные длины, несжатая точка — и точка ЛЕЖИТ НА КРИВОЙ.
 *
 * 🔴 Последнее — не формальность (найдено Codex 28.09): `04` + 64 нулевых байта проходили проверку формы,
 * регистрировались, а при каждом пуше `computeSecret` бросал — и пуш уходил запасным телом. Проверяем тем же
 * вызовом, что и при шифровании, на одноразовом ключе: что он примет здесь, то примет и там.
 */
export function validWebPushKeys(k: WebPushKeys): boolean {
  const pub = b64u(k.p256dh);
  const auth = b64u(k.auth);
  if (pub.length !== 65 || pub[0] !== 0x04 || auth.length !== 16) return false;
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub);
    return true;
  } catch {
    return false;
  }
}

/**
 * Зашифровать тело пуша для устройства. Результат — готовое тело запроса (`Content-Encoding: aes128gcm`):
 * заголовок (соль 16 · размер записи 4 · длина ключа 1 · ключ отправителя 65) и одна запись шифра.
 *
 * `fixed` — только для проверки вектором RFC: в бою соль и ключ отправителя каждый раз новые, иначе
 * два пуша одному устройству дали бы одинаковый ключ и одноразовый номер.
 */
export function encryptWebPush(
  plaintext: Buffer,
  keys: WebPushKeys,
  fixed?: { salt: Buffer; senderPrivateKey: Buffer },
): Buffer {
  const uaPublic = b64u(keys.p256dh);
  const authSecret = b64u(keys.auth);
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large for one record');

  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4: сначала смешиваем общий секрет ECDH с секретом устройства…
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  // …потом RFC 8188: ключ содержимого и одноразовый номер из соли.
  const salt = fixed?.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 — разделитель последней (и единственной) записи.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([header, sealed]);
}
