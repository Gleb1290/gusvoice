/**
 * Личность инстанса: кто мы такие в глазах соседей (#139, F1, план §5.1 и §5.1.3).
 *
 * Здесь ТОЛЬКО правила — без файлов, БД и сети, чтобы их можно было проверить на выдуманных ключах.
 * Работа с зашифрованными файлами ключей — `keystore.ts`, выпуск и ротация — `signingKeys.ts`.
 *
 * Модель доверия ближе всего к ключу хоста в SSH, а не к HTTPS: центра сертификации нет, доверие
 * возникает один раз при связке (по коду) и дальше сверяется при каждом запросе. Отсюда два свойства,
 * которые нельзя ослаблять:
 *  - `instance_id` ВЫВОДИТСЯ из корневого ключа, а не назначается. Домен — лишь адрес: он может
 *    смениться, а личность останется. И наоборот: перехвативший домен не станет нами без ключа.
 *  - смена корневого ключа = смена личности, то есть тревога у соседей, а не тихое принятие.
 */

import { createHash } from 'node:crypto';

/** Алфавит RFC 4648 base32 строчными: в идентификаторе не должно быть похожих глазом символов. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Сколько бит хеша берём в `instance_id`. 160 — как отпечаток ключа в SSH: столкновение нереально. */
const INSTANCE_ID_BITS = 160;

/** base32 без выравнивания `=`: идентификатор живёт в URL, ссылках-приглашениях и логах. */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * `instance_id` из публичного корневого ключа (DER SPKI — то, что отдаёт `export({type:'spki'})`).
 *
 * ⚠️ Хешируется именно SPKI-кодирование, а не «сырые» 32 байта Ed25519: так идентификатор
 * однозначно привязан и к алгоритму тоже. Сменится алгоритм — сменится и личность, это правильно.
 */
export function instanceIdFrom(publicKeyDer: Uint8Array): string {
  const digest = createHash('sha256').update(publicKeyDer).digest();
  return base32Lower(digest.subarray(0, INSTANCE_ID_BITS / 8));
}

/**
 * Отпечаток для человека: SHA-256 ключа заглавными группами по 4 (`4F2A-91C0-…`).
 *
 * Его сверяют глазами только как подстраховку — основной путь связки это код связки (§5.1),
 * потому что на сверке отпечатка глазами люди ошибаются.
 */
export function fingerprintFrom(publicKeyDer: Uint8Array): string {
  const hex = createHash('sha256').update(publicKeyDer).digest('hex').toUpperCase();
  return (hex.match(/.{4}/g) ?? []).join('-');
}

/** Короткая форма отпечатка для тесных мест интерфейса: первые группы и многоточие. */
export function shortFingerprint(fingerprint: string, groups = 4): string {
  const parts = fingerprint.split('-');
  if (parts.length <= groups) return fingerprint;
  return `${parts.slice(0, groups).join('-')}-…`;
}

/** Короткая форма идентификатора («3f7k…q2») — для строк, где полный не помещается. */
export function shortInstanceId(instanceId: string, head = 4, tail = 2): string {
  if (instanceId.length <= head + tail + 1) return instanceId;
  return `${instanceId.slice(0, head)}…${instanceId.slice(-tail)}`;
}

/**
 * Похож ли на наш идентификатор инстанса.
 *
 * 🔴 Проверять ОБЯЗАТЕЛЬНО всё, что пришло снаружи: идентификатор уходит в имена файлов кеша, ключи
 * Redis и URL, поэтому чужая строка со слэшем или точками не должна пройти дальше этой проверки.
 */
export function isInstanceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === Math.ceil(INSTANCE_ID_BITS / 5) && /^[a-z2-7]+$/.test(value);
}
