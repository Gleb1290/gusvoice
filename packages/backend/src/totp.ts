/**
 * Self-contained TOTP (RFC 6238 / HOTP RFC 4226) + base32 + backup-code helpers.
 * Hand-rolled on node:crypto so there's no third-party auth dependency to vet or keep ESM-happy.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PERIOD = 30; // seconds per code
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 alphabet

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit base32 TOTP secret (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', key).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin =
    ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * Verify a 6-digit code, tolerating ±1 step (±30s) drift, returning the MATCHED step counter (for
 * anti-replay, P3-1) or null. Constant-time compare. A valid code matches for ~90s across 3 steps —
 * callers that must be replay-safe (login) reject a counter that was already accepted for the user.
 */
export function verifyTotpCounter(token: string, secret: string, now: number = Date.now()): number | null {
  const t = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const counter = Math.floor(now / 1000 / PERIOD);
  for (let w = -1; w <= 1; w++) {
    const expected = hotp(secret, counter + w);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(t))) return counter + w;
  }
  return null;
}

/** Verify a 6-digit code, tolerating ±1 step (±30s) of clock drift. Constant-time compare. */
export function verifyTotp(token: string, secret: string, now: number = Date.now()): boolean {
  return verifyTotpCounter(token, secret, now) !== null;
}

/** otpauth:// URI an authenticator scans from the QR. */
export function otpauthUri(secret: string, account: string, issuer = 'GusVoice'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** N human-friendly single-use codes, e.g. "a1b2-c3d4". Shown to the user ONCE; stored hashed. */
export function generateBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = randomBytes(4).toString('hex');
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

/** Canonical form for hashing/comparison (case- and dash-insensitive). */
export function normalizeBackupCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}
