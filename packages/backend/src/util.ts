import { randomBytes, randomInt, randomUUID } from 'node:crypto';

/** Primary-key id for entities. */
export function id(): string {
  return randomUUID();
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
