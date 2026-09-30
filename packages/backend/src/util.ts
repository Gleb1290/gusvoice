import { randomBytes, randomInt, randomUUID } from 'node:crypto';

/** Primary-key id for entities. */
export function id(): string {
  return randomUUID();
}

/**
 * UUIDv7 (RFC 9562): 48 бит миллисекунд + версия + случайное. Для новых сущностей ЛС (беседы, сообщения — этап 1):
 * id растут со временем, поэтому вставки ложатся в конец индекса, а не вразброс. ⚠️ Порядок сообщений — НЕ id, а
 * `sort_key` (`convRules.ts`): часы разных процессов и домов расходятся, id — только разрыв ничьей.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; // версия 7
  b[8] = (b[8] & 0x3f) | 0x80; // вариант RFC
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 6-digit numeric email verification code. */
export function verificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Short, URL-safe invite code. */
export function inviteCode(len = 8): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
