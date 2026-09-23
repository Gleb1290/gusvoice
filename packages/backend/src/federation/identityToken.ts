/**
 * Токен личности (#139, F3, план §5.5) — то, чем дом ручается за своего человека перед хостом.
 *
 * Формат намеренно простой: `base64url(claims).base64url(подпись)`, подпись — Ed25519 тем же сменным
 * ключом, что и подписи запросов (§5.1). Не JWT: заголовок JWT несёт ВЫБОР алгоритма, а выбор
 * алгоритма в руках предъявителя — это тот самый рычаг, которым подпись потом и отключают («alg:
 * none»). Здесь алгоритм один и он не обсуждается; `kid` едет отдельным полем в теле.
 *
 * 🔴 Подписывается ровно та строка, которую проверяющий видит своими глазами, — байты
 * `base64url(claims)`, а не «разобрал и сериализовал обратно». Пересборка через `JSON.stringify`
 * меняет порядок ключей и запись чисел, и честная подпись перестала бы сходиться (те же грабли, из-за
 * которых у протокольных POST сохраняется сырое тело).
 */

import { sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  FED_IDENTITY_SKEW_MS,
  FED_IDENTITY_TTL_MS,
  parseIdentityClaims,
  serializeIdentityClaims,
  type FedIdentityClaims,
} from '@gusvoice/shared';

/** Тело токена вместе со служебным `kid`: по нему хост находит ключ в визитке дома. */
interface TokenBody extends Record<string, unknown> {
  kid: string;
}

const b64u = (b: Buffer): string => b.toString('base64url');

/**
 * Выпустить токен личности.
 *
 * `jti` — случайная метка: хост помнит её и второй раз тот же токен не принимает. Без неё
 * перехваченный токен работал бы все две минуты своей жизни (а перехватить его может, например,
 * прокси на стороне человека).
 */
export function issueIdentityToken(input: {
  claims: Omit<FedIdentityClaims, 'iat' | 'exp' | 'jti'>;
  kid: string;
  privateKeyDer: Uint8Array;
  now: number;
  ttlMs?: number;
}): { token: string; claims: FedIdentityClaims } {
  const claims: FedIdentityClaims = {
    ...input.claims,
    iat: input.now,
    exp: input.now + (input.ttlMs ?? FED_IDENTITY_TTL_MS),
    jti: crypto.randomUUID(),
  };
  const body: TokenBody = { ...serializeIdentityClaims(claims), kid: input.kid };
  const payload = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  const key = createPrivateKey({ key: Buffer.from(input.privateKeyDer), format: 'der', type: 'pkcs8' });
  const sig = edSign(null, Buffer.from(payload, 'utf8'), key);
  return { token: `${payload}.${b64u(sig)}`, claims };
}

/** Что можно понять о токене, не проверяя подпись: кто его выпустил и каким ключом. */
export function peekIdentityToken(token: string): { iss: string; kid: string; payload: string; sig: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Лишняя точка = это не наш формат (и, возможно, чей-то JWT): разбирать дальше нечего.
  if (sig.includes('.')) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const iss = typeof body.iss === 'string' ? body.iss : null;
  const kid = typeof body.kid === 'string' ? body.kid : null;
  if (!iss || !kid) return null;
  return { iss, kid, payload, sig };
}

export type IdentityVerdict =
  | { ok: true; claims: FedIdentityClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'unknown-key' | 'expired' | 'future' };

/**
 * Проверить токен: подпись, срок, форма. Кому он выписан и кто за него ручается — решает
 * `identityRefusal` в правилах: там это видно без ключей и сети.
 *
 * `findKey` возвращает `null`, когда `kid` незнаком, — тогда вызывающий вправе перечитать визитку
 * дома мимо кеша (дом мог выпустить ключ минуту назад), ровно как это делает проверка подписей.
 */
export function verifyIdentityToken(input: {
  token: string;
  findKey: (kid: string) => Buffer | null;
  now: number;
  skewMs?: number;
}): IdentityVerdict {
  const peeked = peekIdentityToken(input.token);
  if (!peeked) return { ok: false, reason: 'malformed' };

  const publicKeyDer = input.findKey(peeked.kid);
  if (!publicKeyDer) return { ok: false, reason: 'unknown-key' };

  let good = false;
  try {
    const key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    good = edVerify(null, Buffer.from(peeked.payload, 'utf8'), key, Buffer.from(peeked.sig, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad-signature' };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(peeked.payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const claims = parseIdentityClaims(raw);
  if (!claims) return { ok: false, reason: 'malformed' };

  const skew = input.skewMs ?? FED_IDENTITY_SKEW_MS;
  // Срок проверяется и здесь, и в правилах — намеренно: правила отвечают на вопрос «пускать ли»,
  // а этот модуль не должен возвращать «подпись верна» про заведомо мёртвый токен.
  if (claims.exp <= input.now - skew) return { ok: false, reason: 'expired' };
  if (claims.iat > input.now + skew) return { ok: false, reason: 'future' };

  return { ok: true, claims };
}
