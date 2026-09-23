/**
 * Привязка защит федерации к живым Redis и счётчику частоты (#148).
 *
 * Отдельным файлом, потому что сами правила (`guards.ts`) обязаны оставаться проверяемыми без Redis:
 * стоит модулю с правилами импортировать соединение — и он тянет за собой env и всю обвязку.
 */

import { rateHit } from '../authGuard.js';
import { redisPub } from '../realtime.js';
import { fedRateKey, seenIdentityJtiWith, seenSignatureWith, type FED_LIMITS, type NonceStore } from './guards.js';

/** Сколько ждать до следующей попытки, 0 — предел не превышен. */
export function fedRateBlock(kind: keyof typeof FED_LIMITS, who: string): Promise<number> {
  const { key, max, windowS } = fedRateKey(kind, who);
  return rateHit(key, max, windowS);
}

/** Видели ли мы эту подпись раньше. */
export function seenSignature(signatureHeader: string): Promise<boolean> {
  return seenSignatureWith(redisPub as unknown as NonceStore, signatureHeader);
}

/** Предъявляли ли нам этот токен личности раньше (F3, §5.5). */
export function seenIdentityJti(jti: string): Promise<boolean> {
  return seenIdentityJtiWith(redisPub as unknown as NonceStore, jti);
}
